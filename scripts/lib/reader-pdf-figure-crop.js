'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const PDF_FIGURE_CROP_CONTRACT = 'reader-pdf-figure-crop-v1';
const PDF_TABLE_EXTRACT_CONTRACT = 'reader-pdf-table-extract-v1';
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(message, cause) {
    const error = new Error(`PDF 论文图处理失败：${message}`, cause ? { cause } : undefined);
    error.code = 'READER_PDF_FIGURE_CROP_INTEGRITY';
    error.retryable = false;
    throw error;
}

function normalizedArxivId(value) {
    return String(value || '').trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '').toLowerCase();
}

function canonicalCropSha256(resource) {
    // Fixed 2-decimal string formatting matches Python _canonical_crop_sha256 bit-for-bit
    // regardless of whole-number float serialization (e.g., 18.0 vs 18, -0.0 vs 0).
    const payload = {
        bbox: resource.bbox.map(v => {
            const rounded = Math.round(Number(v) * 100) / 100;
            return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
        }),
        cropContract: resource.cropContract,
        dpi: resource.dpi,
        page: resource.page,
        pdfSha256: resource.pdfSha256
    };
    return sha256(JSON.stringify(payload));
}

function pdfCropSourceDescriptor(resource, arxivId = '') {
    const id = normalizedArxivId(arxivId);
    if (resource?.kind !== 'pdf_crop'
        || resource.cropContract !== PDF_FIGURE_CROP_CONTRACT
        || resource.mediaType !== 'image/png'
        || !SHA256_RE.test(String(resource.pdfSha256 || ''))
        || !SHA256_RE.test(String(resource.cropSha256 || ''))
        || !Number.isSafeInteger(resource.page) || resource.page < 1
        || !Number.isSafeInteger(resource.dpi) || resource.dpi < 72 || resource.dpi > 432
        || !Array.isArray(resource.bbox) || resource.bbox.length !== 4
        || resource.bbox.some(v => typeof v !== 'number' || !Number.isFinite(v))
        || resource.bbox[0] >= resource.bbox[2] || resource.bbox[1] >= resource.bbox[3]) {
        return null;
    }
    if (canonicalCropSha256(resource) !== resource.cropSha256) return null;
    const url = String(resource.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    const pathMatch = parsed.pathname.match(/^\/pdf\/(\d{4}\.\d{4,5}|[a-f0-9]{12})\.pdf$/i);
    if (parsed.protocol !== 'https:'
        || !['arxiv.org', 'www.arxiv.org'].includes(parsed.hostname.toLowerCase())
        || parsed.port || parsed.username || parsed.password || parsed.search
        || !pathMatch
        || (id && /^\d{4}\.\d{4,5}$/.test(id) && pathMatch[1].toLowerCase() !== id)
        || !/^#pd-pdf-figure-\d+-[a-f0-9]{16}$/.test(parsed.hash)
        || !parsed.hash.endsWith(`-${resource.cropSha256.slice(0, 16)}`)) {
        return null;
    }
    return {
        url,
        sourceLocationUrl: url,
        pdfCropSourceSha256: resource.cropSha256,
        pdfCropContract: PDF_FIGURE_CROP_CONTRACT,
        mediaType: 'image/png'
    };
}

function isPdfCropFigure(figure) {
    return Boolean(
        figure?.pdfCropContract
        || figure?.pdfCropSourceSha256
        || /^#pd-pdf-figure-\d+-[a-f0-9]{16}$/.test((() => {
            try { return new URL(String(figure?.url || '')).hash; } catch (_) { return ''; }
        })())
    );
}

function extractPdfStructuredArtifactsSync(pdfBytes, arxivId = '') {
    const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || '');
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        return { pdfSha256: '', figures: [], tables: [] };
    }
    const projectRoot = path.resolve(__dirname, '../..');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pdf-art-'));
    const tmpPdf = path.join(tmpDir, 'source.pdf');
    try {
        fs.writeFileSync(tmpPdf, bytes, { mode: 0o600 });
        const args = [
            path.join(projectRoot, 'scripts/python-runtime.sh'),
            path.join(projectRoot, 'scripts/pdf_figure_table_extract.py'),
            '--pdf', tmpPdf,
            '--json'
        ];
        const cleanId = normalizedArxivId(arxivId);
        if (cleanId) args.push('--arxiv-id', cleanId);
        const stdout = execFileSync('bash', args, {
            cwd: projectRoot,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 45_000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const parsed = JSON.parse(String(stdout || '{}'));
        return {
            pdfSha256: String(parsed.pdfSha256 || sha256(bytes)),
            figures: Array.isArray(parsed.figures) ? parsed.figures : [],
            tables: Array.isArray(parsed.tables) ? parsed.tables : []
        };
    } catch (_error) {
        return { pdfSha256: sha256(bytes), figures: [], tables: [] };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function renderOfficialPdfFigureCrop(pdfBytes, resource, arxivId = '', _deps = {}) {
    const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || '');
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('封存 PDF 字节无效或超限');
    }
    const descriptor = pdfCropSourceDescriptor(resource, arxivId);
    if (!descriptor) fail('PDF 论文图裁切描述无效或签名不符');
    if (sha256(bytes) !== resource.pdfSha256) {
        fail('封存 PDF 字节 SHA 与裁切描述绑定的 pdfSha256 不一致');
    }
    const deps = (_deps && typeof _deps === 'object') ? _deps : {};
    const spawnFn = deps.spawn || spawn;
    const killFn = deps.kill || process.kill;
    const timeoutMs = deps.timeoutMs || 45_000;
    const projectRoot = path.resolve(__dirname, '../..');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pdf-crop-'));
    const tmpPdf = path.join(tmpDir, 'source.pdf');
    try {
        fs.writeFileSync(tmpPdf, bytes, { mode: 0o600 });
        const cropSpec = `${resource.page}:${resource.bbox.join(',')}`;
        const png = await new Promise((resolve, reject) => {
            const useProcessGroup = process.platform !== 'win32';
            const child = spawnFn('bash', [
                path.join(projectRoot, 'scripts/python-runtime.sh'),
                path.join(projectRoot, 'scripts/pdf_figure_table_extract.py'),
                '--pdf', tmpPdf,
                '--render-crop', cropSpec,
                '--dpi', String(resource.dpi || 288)
            ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: useProcessGroup });
            const chunks = [];
            let size = 0;
            let stderr = '';
            let failure = null;
            let terminated = false;
            let exited = false;
            let timer = null;
            child.once('exit', () => { exited = true; });
            const terminateChild = () => {
                if (terminated) return;
                terminated = true;
                if (timer) { clearTimeout(timer); timer = null; }
                try { child.stdout.destroy(); } catch (_) {}
                try { child.stderr.destroy(); } catch (_) {}
                if (exited || child.exitCode != null || child.signalCode != null) return;
                if (useProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0) {
                    try { killFn(-child.pid, 'SIGKILL'); return; } catch (_) {}
                }
                try { child.kill('SIGKILL'); } catch (_) {}
            };
            timer = setTimeout(() => {
                failure ||= new Error('PDF 论文图裁切渲染超时');
                terminateChild();
            }, timeoutMs);
            child.stdout.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_OUTPUT_BYTES) {
                    failure ||= new Error('PDF 论文图裁切像素超过受控上限');
                    terminateChild();
                } else {
                    chunks.push(chunk);
                }
            });
            child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 2000); });
            child.once('error', err => { clearTimeout(timer); terminateChild(); reject(err); });
            child.once('close', code => {
                clearTimeout(timer);
                if (failure || code !== 0) reject(failure || new Error(`渲染器退出 ${code}: ${stderr}`));
                else resolve(Buffer.concat(chunks));
            });
        }).catch(cause => fail('未能从封存 PDF 渲染论文图裁切像素', cause));
        if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
            fail('PDF 裁切渲染器没有返回有效 PNG');
        }
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) {
            fail('PDF 裁切渲染像素尺寸无效');
        }
        return {
            rawBytes: png,
            mediaType: 'image/png',
            assetSha256: sha256(png),
            pdfCropSourceSha256: resource.cropSha256,
            pdfCropContract: PDF_FIGURE_CROP_CONTRACT,
            width,
            height
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

module.exports = {
    PDF_FIGURE_CROP_CONTRACT,
    PDF_TABLE_EXTRACT_CONTRACT,
    pdfCropSourceDescriptor,
    isPdfCropFigure,
    extractPdfStructuredArtifactsSync,
    renderOfficialPdfFigureCrop
};
