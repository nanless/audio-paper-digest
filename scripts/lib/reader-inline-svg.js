'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RENDERER_ALLOWED_ENV_KEYS = Object.freeze([
    'PLAYWRIGHT_BROWSERS_PATH',
    'XDG_CACHE_HOME',
    'PD_PYTHON_RUNTIME_VERIFIED_BIN',
    'PD_PYTHON_RUNTIME_DISABLE_VENV'
]);

const LEGACY_CONTRACT = 'reader-official-inline-svg-pixels-v1';
const CONTRACT = 'reader-official-inline-svg-pixels-v2';
const ACCEPTED_CONTRACTS = Object.freeze(new Set([LEGACY_CONTRACT, CONTRACT]));
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const unsupportedDependencyFailures = new WeakSet();
const unsupportedDependencyCauses = new WeakMap();
function isUnsupportedDependencyFailure(error) { return unsupportedDependencyFailures.has(error); }
function unsupportedDependency(cause) {
    const reason = unsupportedDependencyCauses.get(cause);
    const messages = {
        external_latexml_layout_css: '内联论文图不可用：静态文字依赖未封存的 LaTeXML 布局 CSS，无法取得完整像素',
        raw_latex_leak_in_svg: '内联论文图不可用：SVG 渲染暴露原始 LaTeX 指令，自动回退 PDF 裁切',
        foreign_object_text_overlap: '内联论文图不可用：SVG 内嵌文字块存在严重重叠，自动回退 PDF 裁切'
    };
    const error = new Error(messages[reason] || '内联论文图不可用：封存来源含未封存的 CSS 图标依赖，无法取得完整像素', { cause });
    error.code = 'READER_INLINE_SVG_UNSUPPORTED_DEPENDENCY';
    error.unsupportedDependencyReason = reason;
    error.retryable = false;
    unsupportedDependencyFailures.add(error);
    throw error;
}
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
        || /<!|<\?/i.test(resource.inlineSvg)) return null;
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

async function renderOfficialInlineSvg(resource, _deps = {}) {
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
    const deps = (_deps && typeof _deps === 'object') ? _deps : {};
    const spawnFn = deps.spawn || spawn;
    const killFn = deps.kill || process.kill;
    const maxOutputBytes = deps.maxOutputBytes || MAX_OUTPUT_BYTES;
    const timeoutMs = deps.timeoutMs || 60_000;
    const projectRoot = path.resolve(__dirname, '../..');
    const bytes = await new Promise((resolve, reject) => {
        const useProcessGroup = process.platform !== 'win32';
        const args = [path.join(projectRoot, 'scripts/python-runtime.sh'),
            path.join(projectRoot, 'scripts/reader_inline_svg.py')];
        if (deps.hidpi !== false) args.push('--hidpi');
        if (deps.deterministicHidpi !== false && deps.deterministicV2 !== false) args.push('--deterministic-hidpi');
        const { buildChildProcessEnv } = require('../env-loader.js');
        const child = spawnFn('bash', args, {
            cwd: projectRoot,
            env: buildChildProcessEnv({}, RENDERER_ALLOWED_ENV_KEYS),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: useProcessGroup
        });
        const chunks = []; let size = 0; let stderr = ''; let failure = null; let terminated = false; let exited = false;
        let timeout = null;
        child.once('exit', () => { exited = true; });
        const terminateChild = () => {
            if (terminated) return;
            terminated = true;
            if (timeout) { clearTimeout(timeout); timeout = null; }
            try { child.stdin.destroy(); } catch (_) {}
            try { child.stdout.destroy(); } catch (_) {}
            try { child.stderr.destroy(); } catch (_) {}
            if (exited || child.exitCode != null || child.signalCode != null) return;
            if (useProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0) {
                try { killFn(-child.pid, 'SIGKILL'); return; } catch (_) {}
            }
            try { child.kill('SIGKILL'); } catch (_) {}
        };
        timeout = setTimeout(() => {
            failure ||= new Error('内联 SVG 渲染超过 60 秒');
            terminateChild();
        }, timeoutMs);
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > maxOutputBytes) {
                failure ||= new Error('内联 SVG 像素超过受控上限');
                terminateChild();
            } else chunks.push(chunk);
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.once('error', error => { clearTimeout(timeout); terminateChild(); reject(error); });
        child.stdin.on('error', error => { failure ||= error; });
        child.once('close', code => {
            clearTimeout(timeout);
            const lastStderrLine = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
            const reason = [
                'external_css_icon_glyph',
                'external_latexml_layout_css',
                'raw_latex_leak_in_svg',
                'foreign_object_text_overlap'
            ].find(reason =>
                lastStderrLine === JSON.stringify({ contract: 'reader-inline-svg-error-v1', code: 'unsupported_dependency', reason }));
            if (!failure && size === 0 && code === 65 && reason) {
                const rejected = new Error(`受控渲染器确认封存来源缺少依赖：${reason}`);
                unsupportedDependencyCauses.set(rejected, reason);
                reject(rejected);
            } else if (failure || code !== 0) reject(failure || new Error(`渲染器退出 ${code}：${stderr}`));
            else resolve(Buffer.concat(chunks));
        });
        child.stdin.end(source);
    }).catch(cause => unsupportedDependencyCauses.has(cause)
        ? unsupportedDependency(cause) : fail('未能取得完整的真实像素', cause));
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

module.exports = {
    CONTRACT,
    LEGACY_CONTRACT,
    ACCEPTED_CONTRACTS,
    inlineSvgSourceDescriptor,
    renderOfficialInlineSvg,
    isUnsupportedDependencyFailure
};
