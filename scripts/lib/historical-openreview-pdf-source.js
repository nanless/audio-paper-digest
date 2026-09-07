'use strict';

// Seal one authenticated ICML OpenReview PDF into the forum-ID filename used
// by the local conference source manifest. This module never writes current/
// or a blog checkout.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { detectHttpConnectProxyUrl, createProxyDispatcher } = require('../utils.js');
const posterApi = require('./historical-icml-poster-authority.js');

const CONTRACT = 'historical-openreview-pdf-source-v1';
const VERSION = 1;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 180000;
const FORUM_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const RECEIPT_NAME_RE = /^openreview-[A-Za-z0-9_-]{6,128}\.json$/;

class HistoricalOpenreviewPdfSourceError extends Error {
    constructor(message) {
        super(`Historical OpenReview PDF source rejected: ${message}`);
        this.name = 'HistoricalOpenreviewPdfSourceError';
        this.code = 'HISTORICAL_OPENREVIEW_PDF_SOURCE_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalOpenreviewPdfSourceError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');

function safeDirectory(directory, label, create = false) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory);
    if (!fs.existsSync(absolute)) {
        if (!create) fail(`${label} does not exist`);
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}
function plannedDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory); const missing = []; let cursor = absolute;
    while (!fs.existsSync(cursor)) {
        missing.push(path.basename(cursor)); const parent = path.dirname(cursor);
        if (parent === cursor) fail(`${label} has no existing ancestor`); cursor = parent;
    }
    safeDirectory(cursor, `${label} existing ancestor`);
    if (missing.some(part => !part || part === '.' || part === '..')) fail(`${label} is unsafe`);
    return absolute;
}

function readStableFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be absolute`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`); let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) fail(`${label} is unsafe or too large`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail(`${label} changed while read`);
        return { filename: absolute, bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error instanceof HistoricalOpenreviewPdfSourceError) throw error;
        fail(`${label} cannot be read: ${error.code || error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token); if (top.keys.has(key)) fail('receipt JSON has duplicate keys');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function pdfUrlForForum(forumId) {
    if (!FORUM_ID_RE.test(String(forumId || ''))) fail('forum ID is invalid');
    return `https://openreview.net/pdf?id=${forumId}`;
}

function validateDownloadUrl(rawUrl, forumId) {
    let url;
    try { url = new URL(rawUrl); } catch { fail('OpenReview PDF URL is invalid'); }
    if (url.protocol !== 'https:' || url.hostname !== 'openreview.net' || url.port || url.username || url.password || url.hash) {
        fail('OpenReview PDF URL must remain on canonical HTTPS openreview.net');
    }
    const id = url.searchParams.get('id');
    if (!['/pdf', '/attachment'].includes(url.pathname) || id !== forumId
        || [...url.searchParams.keys()].some(key => !['id', 'name'].includes(key))
        || (url.pathname === '/attachment' && url.searchParams.get('name') !== 'pdf')
        || (url.pathname === '/pdf' && url.searchParams.has('name'))) {
        fail('OpenReview redirect changed the authenticated forum or PDF endpoint');
    }
    return url.toString();
}

function validPdfContentType(value) {
    return /^(?:application\/pdf|application\/octet-stream)(?:\s*;[^\r\n]*)?$/iu.test(String(value || '').trim());
}

async function readResponseBytes(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) fail('OpenReview PDF exceeds the byte limit');
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) fail('OpenReview PDF exceeds the byte limit');
        return bytes;
    }
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            const chunk = Buffer.from(value); total += chunk.length;
            if (total > maxBytes) { await reader.cancel(); fail('OpenReview PDF exceeds the byte limit'); }
            chunks.push(chunk);
        }
    } finally { reader.releaseLock?.(); }
    return Buffer.concat(chunks, total);
}

async function defaultFetchPdf({ url, forumId, maxBytes = MAX_PDF_BYTES, maxRedirects = MAX_REDIRECTS,
    timeoutMs = REQUEST_TIMEOUT_MS } = {}, dependencies = {}) {
    const detectProxy = dependencies.detectProxy || detectHttpConnectProxyUrl;
    const proxyUrl = detectProxy(); if (!proxyUrl) fail('project HTTP CONNECT proxy is required');
    const dispatcher = (dependencies.createDispatcher || createProxyDispatcher)(proxyUrl);
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    const redirects = []; let current = validateDownloadUrl(url, forumId);
    try {
        for (let count = 0; count <= maxRedirects; count += 1) {
            const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', dispatcher,
                signal: controller.signal, headers: { Accept: 'application/pdf',
                    'User-Agent': 'audio-paper-digest-history/1.0' } });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (count >= maxRedirects) fail('OpenReview PDF exceeded the redirect limit');
                const location = response.headers?.get?.('location'); if (!location) fail('OpenReview redirect has no Location');
                const next = validateDownloadUrl(new URL(location, current).toString(), forumId);
                redirects.push({ from: current, to: next, status: response.status }); current = next; continue;
            }
            if (response.status !== 200) fail(`OpenReview PDF returned HTTP ${response.status}`);
            const contentType = String(response.headers?.get?.('content-type') || '');
            if (!validPdfContentType(contentType)) fail('OpenReview PDF response has an invalid Content-Type');
            const bytes = await readResponseBytes(response, maxBytes);
            return { bytes, requestedUrl: url, finalUrl: current, redirects,
                contentType, responseStatus: response.status };
        }
        fail('OpenReview PDF exceeded the redirect limit');
    } catch (error) {
        if (error instanceof HistoricalOpenreviewPdfSourceError) throw error;
        if (error?.name === 'AbortError') fail('OpenReview PDF request timed out');
        const reason = String(error?.cause?.code || error?.code || error?.message || 'network error')
            .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 160);
        fail(`OpenReview PDF network request failed: ${reason}`);
    } finally { clearTimeout(timer); }
}

function pathsFor({ pdfRoot, receiptRoot, forumId, create = false } = {}) {
    const pdfDirectory = create ? safeDirectory(pdfRoot, 'OpenReview PDF root', true)
        : plannedDirectory(pdfRoot, 'OpenReview PDF root');
    const receiptDirectory = create ? safeDirectory(receiptRoot, 'OpenReview receipt root', true)
        : plannedDirectory(receiptRoot, 'OpenReview receipt root');
    if (!FORUM_ID_RE.test(String(forumId || ''))) fail('forum ID is invalid');
    return { pdfFile: path.join(pdfDirectory, `${forumId}.pdf`),
        receiptFile: path.join(receiptDirectory, `openreview-${forumId}.json`) };
}

function normalizeReceipt(value) {
    const fields = ['contract', 'version', 'forumId', 'posterId', 'forumUrl', 'requestedUrl', 'finalUrl', 'redirects',
        'responseStatus', 'contentType', 'fetchedAt', 'authoritySha256', 'recordBindingSha256', 'pdf', 'receiptSha256'];
    if (!plain(value) || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')
        || value.contract !== CONTRACT || value.version !== VERSION || !FORUM_ID_RE.test(String(value.forumId || ''))
        || !/^[1-9]\d*$/.test(String(value.posterId || '')) || value.forumUrl !== `https://openreview.net/forum?id=${value.forumId}`
        || !Array.isArray(value.redirects) || value.responseStatus !== 200 || !validPdfContentType(value.contentType)
        || !Number.isFinite(Date.parse(value.fetchedAt)) || new Date(value.fetchedAt).toISOString() !== value.fetchedAt
        || !SHA_RE.test(String(value.authoritySha256 || ''))
        || !SHA_RE.test(String(value.recordBindingSha256 || '')) || !plain(value.pdf)) fail('receipt envelope is invalid');
    validateDownloadUrl(value.requestedUrl, value.forumId); validateDownloadUrl(value.finalUrl, value.forumId);
    if (value.redirects.length > MAX_REDIRECTS || value.redirects.some(item => !plain(item)
        || ![301, 302, 303, 307, 308].includes(item.status)
        || validateDownloadUrl(item.from, value.forumId) !== item.from
        || validateDownloadUrl(item.to, value.forumId) !== item.to)) fail('receipt redirect chain is invalid');
    if ((!value.redirects.length && value.finalUrl !== value.requestedUrl)
        || (value.redirects.length && (value.redirects[0].from !== value.requestedUrl
            || value.redirects.at(-1).to !== value.finalUrl
            || value.redirects.some((item, index) => index > 0 && value.redirects[index - 1].to !== item.from)))) {
        fail('receipt redirect chain is not continuous');
    }
    if (Object.keys(value.pdf).sort().join('\0') !== ['absolutePath', 'bytes', 'sha256'].sort().join('\0')
        || !path.isAbsolute(value.pdf.absolutePath) || !Number.isSafeInteger(value.pdf.bytes) || value.pdf.bytes < 5
        || value.pdf.bytes > MAX_PDF_BYTES || !SHA_RE.test(String(value.pdf.sha256 || ''))) fail('receipt PDF binding is invalid');
    const body = clone(value); delete body.receiptSha256;
    if (!SHA_RE.test(String(value.receiptSha256 || '')) || value.receiptSha256 !== stableHash(body)) fail('receipt self-SHA is invalid');
    return clone(value);
}

function readReceipt(receiptFile) {
    const loaded = readStableFile(receiptFile, 'OpenReview PDF receipt', 1024 * 1024); let value;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text); value = JSON.parse(text); }
    catch (error) { if (error instanceof HistoricalOpenreviewPdfSourceError) throw error; fail('receipt is not strict UTF-8 JSON'); }
    const receipt = normalizeReceipt(value);
    if (!loaded.bytes.equals(prettyBytes(receipt))) fail('receipt bytes are not canonical');
    return receipt;
}

function replayReceipt({ receiptFile, pdfFile, record, authoritySha256 } = {}) {
    const receipt = readReceipt(receiptFile);
    if (receipt.forumId !== record.forumId || receipt.posterId !== record.posterId
        || receipt.authoritySha256 !== authoritySha256 || receipt.recordBindingSha256 !== record.recordBindingSha256
        || receipt.pdf.absolutePath !== pdfFile) fail('receipt differs from authenticated forum authority');
    const pdf = readStableFile(pdfFile, 'sealed OpenReview PDF', MAX_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.bytes.length !== receipt.pdf.bytes
        || pdf.sha256 !== receipt.pdf.sha256) fail('sealed OpenReview PDF differs from receipt');
    return receipt;
}

function writeExclusive(filename, bytes) {
    let fd;
    try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeOrCompare(filename, bytes, label, maxBytes) {
    try { writeExclusive(filename, bytes); return 'created'; }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readStableFile(filename, label, maxBytes);
        if (!existing.bytes.equals(bytes)) fail(`refuses to overwrite a different ${label}`);
        return 'recovered';
    }
}

async function sealOpenreviewPdf({ apply = false, snapshotFile, forumId, pdfRoot, receiptRoot,
    maxBytes = MAX_PDF_BYTES, maxRedirects = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS,
    observedAt = null } = {}, dependencies = {}) {
    if (typeof apply !== 'boolean' || !Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > MAX_PDF_BYTES
        || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('sealer options are invalid');
    const authorityHandle = posterApi.loadPosterAuthority({ snapshotFile });
    const authority = posterApi.authorityHandleSnapshot(authorityHandle);
    const record = posterApi.lookupByForum(authorityHandle, forumId);
    const paths = pathsFor({ pdfRoot, receiptRoot, forumId, create: apply });
    const requestedUrl = pdfUrlForForum(record.forumId);
    const plan = { forumId: record.forumId, posterId: record.posterId, forumUrl: record.openreviewUrl,
        requestedUrl, pdfFile: paths.pdfFile, receiptFile: paths.receiptFile,
        authoritySha256: authority.authoritySha256, recordBindingSha256: record.recordBindingSha256 };
    if (!apply) return { status: 'dry-run', ...plan };
    if (fs.existsSync(paths.receiptFile)) {
        return { status: 'recovered', ...plan, receipt: replayReceipt({ ...paths, record,
            authoritySha256: authority.authoritySha256 }) };
    }
    const fetchPdf = dependencies.fetchPdf || ((options) => defaultFetchPdf(options, dependencies));
    const downloaded = await fetchPdf({ url: requestedUrl, forumId: record.forumId, maxBytes, maxRedirects, timeoutMs });
    if (!plain(downloaded) || !Buffer.isBuffer(downloaded.bytes) || downloaded.bytes.length < 5
        || downloaded.bytes.length > maxBytes || downloaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('downloaded OpenReview response is not a bounded PDF');
    }
    if (downloaded.responseStatus !== 200 || !validPdfContentType(downloaded.contentType)) {
        fail('downloaded OpenReview response metadata is invalid');
    }
    validateDownloadUrl(downloaded.requestedUrl, record.forumId); validateDownloadUrl(downloaded.finalUrl, record.forumId);
    const fetchedAt = observedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(fetchedAt)) || new Date(fetchedAt).toISOString() !== fetchedAt) fail('observedAt is invalid');
    const pdfBody = { absolutePath: paths.pdfFile, bytes: downloaded.bytes.length, sha256: sha256(downloaded.bytes) };
    const body = { contract: CONTRACT, version: VERSION, forumId: record.forumId, posterId: record.posterId,
        forumUrl: record.openreviewUrl, requestedUrl: downloaded.requestedUrl, finalUrl: downloaded.finalUrl,
        redirects: clone(downloaded.redirects || []), responseStatus: downloaded.responseStatus,
        contentType: String(downloaded.contentType || ''), fetchedAt, authoritySha256: authority.authoritySha256,
        recordBindingSha256: record.recordBindingSha256, pdf: pdfBody };
    const receipt = normalizeReceipt({ ...body, receiptSha256: stableHash(body) });
    const pdfStatus = writeOrCompare(paths.pdfFile, downloaded.bytes, 'existing OpenReview PDF', MAX_PDF_BYTES);
    let receiptStatus = 'created';
    try { writeExclusive(paths.receiptFile, prettyBytes(receipt)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; receiptStatus = 'recovered'; }
    const replayed = replayReceipt({ ...paths, record, authoritySha256: authority.authoritySha256 });
    return { status: pdfStatus === 'recovered' && receiptStatus === 'recovered' ? 'recovered' : 'created',
        ...plan, receipt: replayed };
}

module.exports = { CONTRACT, VERSION, MAX_PDF_BYTES, MAX_REDIRECTS, REQUEST_TIMEOUT_MS, RECEIPT_NAME_RE,
    HistoricalOpenreviewPdfSourceError, stableHash, pdfUrlForForum, validateDownloadUrl, validPdfContentType, normalizeReceipt,
    readReceipt, replayReceipt, defaultFetchPdf, sealOpenreviewPdf };
