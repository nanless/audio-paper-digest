'use strict';

// One PDF implementation for every PDF-only route.  PyMuPDF is invoked via
// the project's pinned Python runtime so Node's old pdf-parse text path cannot
// silently discard tables, images, equations, or page layout.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SCRIPTS_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SCRIPTS_ROOT, '..');
const PYTHON_RUNTIME = 'bash';
const PYTHON_RUNTIME_SCRIPT = path.join(SCRIPTS_ROOT, 'python-runtime.sh');
const PYTHON_SCRIPT = path.join(SCRIPTS_ROOT, 'pdf-layout-extract.py');
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
function stableHash(value) { return sha256(JSON.stringify(canonical(value))); }
function fail(message) { throw new Error(`PDF layout extraction rejected: ${message}`); }

function assertNoPixels(value, label = 'visual audit') {
    const inspect = (entry, location) => {
        if (Array.isArray(entry)) return entry.forEach((item, index) => inspect(item, `${location}[${index}]`));
        if (!entry || typeof entry !== 'object') return;
        for (const [key, item] of Object.entries(entry)) {
            if (/base64|rawBytes|dataUri/i.test(key)) fail(`${label} contains persistent pixel field ${location}.${key}`);
            inspect(item, `${location}.${key}`);
        }
    };
    inspect(value, label);
    return value;
}

function validateVisualAudit(audit) {
    if (!audit || typeof audit !== 'object' || audit.contract !== 'conference-pdf-visual-audit-v1'
        || audit.version !== 1 || audit.backend?.name !== 'pymupdf'
        || !Number.isSafeInteger(audit.renderDpi) || audit.renderDpi < 1
        || !Array.isArray(audit.pages) || !Array.isArray(audit.embeddedImages)
        || !Array.isArray(audit.tableCandidates) || !Array.isArray(audit.formulaCandidates)
        || !Array.isArray(audit.figureCandidates) || !SHA256.test(String(audit.auditSha256 || ''))) {
        fail('visual audit contract is invalid');
    }
    assertNoPixels(audit);
    const body = { ...audit }; delete body.auditSha256;
    if (audit.auditSha256 !== stableHash(body)) fail('visual audit SHA-256 does not replay');
    for (const page of audit.pages) {
        if (!Number.isSafeInteger(page.page) || page.page < 1 || page.mediaType !== 'image/png'
            || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height)
            || !Number.isSafeInteger(page.bytes) || !SHA256.test(String(page.sha256 || ''))) {
            fail('visual audit page evidence is invalid');
        }
    }
    return audit;
}

function parseJson(stdout, label) {
    let value;
    try { value = JSON.parse(String(stdout || '')); }
    catch (error) { fail(`${label} did not return JSON: ${error.message}`); }
    if (!value || typeof value !== 'object' || value.contract !== 'pdf-layout-extraction-result-v1'
        || value.version !== 1) fail(`${label} returned an unexpected contract`);
    return value;
}

async function run(args, timeout = 180000) {
    try {
        const result = await execFileAsync(PYTHON_RUNTIME, [PYTHON_RUNTIME_SCRIPT, PYTHON_SCRIPT, ...args], {
            cwd: PROJECT_ROOT, timeout, maxBuffer: 64 * 1024 * 1024
        });
        return parseJson(result.stdout, 'PyMuPDF helper');
    } catch (error) {
        const detail = String(error?.stderr || error?.message || error).trim().slice(0, 1200);
        fail(detail || 'PyMuPDF helper failed');
    }
}

async function extractPdfLayoutFromPath(pdfPath, options = {}) {
    if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath)) fail('PDF path must be absolute');
    if (typeof options.extract !== 'function') {
        const result = await run(['extract', '--pdf', pdfPath], options.timeoutMs || 180000);
        if (result.backend?.name !== 'pymupdf' || !SHA256.test(String(result.pdfSha256 || ''))
            || !SHA256.test(String(result.textSha256 || '')) || typeof result.text !== 'string') {
            fail('extraction result is incomplete');
        }
        validateVisualAudit(result.visualAudit);
        return result;
    }
    return options.extract(pdfPath);
}

async function extractPdfLayoutFromBytes(bytes, options = {}) {
    const payload = Buffer.from(bytes || []);
    if (payload.length < 5 || payload.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('PDF bytes have an invalid header');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-layout-source-'));
    const filename = path.join(directory, 'source.pdf');
    try {
        const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        return await extractPdfLayoutFromPath(filename, options);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
    }
}

async function renderPdfPages(pdfPath, directory, pages, options = {}) {
    if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath)
        || typeof directory !== 'string' || !path.isAbsolute(directory)
        || !Array.isArray(pages) || pages.length === 0
        || pages.some(page => !Number.isSafeInteger(page) || page < 1)) {
        fail('render requires an absolute PDF, directory, and positive page list');
    }
    if (typeof options.render === 'function') return options.render({ pdfPath, directory, pages });
    const result = await run(['render', '--pdf', pdfPath, '--directory', directory,
        '--pages', pages.join(','), '--dpi', String(options.dpi || 144)], options.timeoutMs || 180000);
    if (!Array.isArray(result.files) || result.files.length !== pages.length) fail('render result is incomplete');
    return result.files;
}

module.exports = { extractPdfLayoutFromPath, extractPdfLayoutFromBytes, renderPdfPages,
    validateVisualAudit, stableHash };
