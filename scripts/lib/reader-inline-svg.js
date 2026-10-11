'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONTRACT = 'reader-official-inline-svg-pixels-v1';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(message, cause) {
    const error = new Error(`内联论文图处理失败：${message}`, { cause });
    error.code = 'READER_INLINE_SVG_INTEGRITY';
    error.retryable = false;
    throw error;
}

function inlineSvgSourceDescriptor(resource, arxivId) {
    const id = String(arxivId || '').replace(/^arxiv:/, '').replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(id) || resource?.kind !== 'inline_svg'
        || resource.mediaType !== 'image/svg+xml' || typeof resource.inlineSvg !== 'string') return null;
    const bytes = Buffer.from(resource.inlineSvg, 'utf8');
    if (bytes.length !== resource.inlineSvgBytes || bytes.length > MAX_SOURCE_BYTES
        || sha256(bytes) !== resource.inlineSvgSha256
        || /<!DOCTYPE|<!ENTITY|<\?/i.test(resource.inlineSvg)) return null;
    let elementId;
    try {
        const $ = require('cheerio').load(resource.inlineSvg, { xmlMode: true });
        const roots = $.root().children();
        if (roots.length !== 1 || roots[0].name !== 'svg') return null;
        elementId = roots.attr('id');
    } catch (_) { return null; }
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(elementId || ''))) return null;
    return { url: `https://arxiv.org/html/${id}#${elementId}`,
        sourceLocationUrl: `https://arxiv.org/html/${id}#${elementId}`,
        inlineSvgSourceSha256: resource.inlineSvgSha256,
        inlineSvgRenderContract: CONTRACT, mediaType: 'image/png' };
}

async function renderOfficialInlineSvg(resource) {
    if (resource?.kind !== 'inline_svg' || resource.mediaType !== 'image/svg+xml'
        || typeof resource.inlineSvg !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(resource.inlineSvgSha256 || ''))) {
        fail('来源不是完整的内联 SVG');
    }
    const source = Buffer.from(resource.inlineSvg, 'utf8');
    if (!source.length || source.length > MAX_SOURCE_BYTES
        || source.length !== resource.inlineSvgBytes || sha256(source) !== resource.inlineSvgSha256) {
        fail('原图字节与封存的长度或 SHA 不一致');
    }
    const projectRoot = path.resolve(__dirname, '../..');
    const bytes = await new Promise((resolve, reject) => {
        const child = spawn('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'),
            path.join(projectRoot, 'scripts/reader_inline_svg.py')],
        { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = []; let size = 0; let stderr = ''; let failure = null;
        const timeout = setTimeout(() => {
            failure = new Error('内联 SVG 渲染超过 60 秒'); child.kill('SIGKILL');
        }, 60_000);
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_OUTPUT_BYTES) {
                failure = new Error('内联 SVG 像素超过受控上限'); child.kill('SIGKILL');
            } else chunks.push(chunk);
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 4000); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.stdin.on('error', error => { failure ||= error; });
        child.once('close', code => {
            clearTimeout(timeout);
            if (failure || code !== 0) reject(failure || new Error(`渲染器退出 ${code}：${stderr}`));
            else resolve(Buffer.concat(chunks));
        });
        child.stdin.end(source);
    }).catch(cause => fail('未能取得完整的真实像素', cause));
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        fail('渲染器没有返回 PNG');
    }
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) {
        fail('渲染后的像素尺寸无效');
    }
    return { rawBytes: bytes, mediaType: 'image/png', assetSha256: sha256(bytes),
        inlineSvgSourceSha256: resource.inlineSvgSha256,
        inlineSvgRenderContract: CONTRACT, width, height };
}

module.exports = { CONTRACT, inlineSvgSourceDescriptor, renderOfficialInlineSvg };
