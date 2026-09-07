'use strict';

// A deliberately small, source-only store for historical arXiv rewrites.
// It is independent from data/current and the legacy fresh-source cache:
// every *new* generation obtains a new official text response and raw PDF.
// Only the exact replayable source.txt, source.pdf, source-runtime.json, and
// source-manifest.json are durable. Figure bytes are scoped to one callback
// under the OS temporary directory and are removed on both success and failure.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTRACT = 'fresh-arxiv-rewrite-source-v1';
const VERSION = 2;
const EXTRACTOR_CONTRACT = 'deep-analyzer-official-arxiv-fulltext-v1';
const DEFAULT_EXTRACTOR_VERSION = 'arxiv-html-or-pdf-text-v1';
const MANIFEST_NAME = 'source-manifest.json';
const TEXT_NAME = 'source.txt';
const PDF_NAME = 'source.pdf';
const RUNTIME_METADATA_NAME = 'source-runtime.json';
const RUNTIME_METADATA_CONTRACT = 'fresh-arxiv-rewrite-runtime-metadata-v1';
const SOURCE_FILES = Object.freeze([MANIFEST_NAME, PDF_NAME, RUNTIME_METADATA_NAME, TEXT_NAME]);
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const ARXIV_SOURCE_ID_RE = /^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/;
const HISTORICAL_VERSION_CONTRACT = 'arxiv-historical-version-source-v1';
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;

class FreshArxivRewriteSourceError extends Error {
    constructor(message) {
        super(`Fresh arXiv rewrite source rejected: ${message}`);
        this.name = 'FreshArxivRewriteSourceError';
        this.code = 'FRESH_ARXIV_REWRITE_SOURCE_INTEGRITY';
        this.retryable = false;
    }
}

const fail = message => { throw new FreshArxivRewriteSourceError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
function canonicalJson(value) { return `${JSON.stringify(canonical(value), null, 2)}\n`; }

function normalizedArxivId(value) {
    const id = String(value || '').trim().replace(/v\d+$/i, '');
    if (!ARXIV_ID_RE.test(id)) fail('arxivId must be a normalized modern versionless ID');
    return id;
}

function normalizedSourceId(value, arxivId, label = 'arXiv source ID') {
    const sourceId = String(value || '').trim(); const canonicalId = normalizedArxivId(arxivId);
    if (!ARXIV_SOURCE_ID_RE.test(sourceId) || sourceId.replace(/v\d+$/i, '') !== canonicalId) {
        fail(`${label} belongs to another paper or is malformed`);
    }
    return sourceId;
}

function normalizedGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) {
        fail('generation must be a positive safe integer');
    }
    return value;
}

function generationName(generation) {
    return `generation-${String(normalizedGeneration(generation)).padStart(6, '0')}`;
}

function asIso(value, label) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(`${label} must be an ISO timestamp`);
    return value;
}

function nowIso(now) {
    const value = typeof now === 'function' ? now() : now === undefined ? new Date().toISOString() : now;
    return asIso(value, 'capture time');
}

function safeDirectory(directory, create = false, label = 'directory') {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be an absolute path`);
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe ${label}: ${cursor}`);
    }
    return absolute;
}

function sourceDirectory(rootDir, arxivId, generation) {
    const root = path.resolve(rootDir);
    const id = normalizedArxivId(arxivId);
    return path.join(root, id, generationName(generation));
}

function readPrivateFile(filename, maxBytes, label) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > maxBytes) {
            fail(`unsafe ${label}`);
        }
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writePrivateFile(directory, filename, bytes) {
    const target = path.join(directory, filename);
    const payload = Buffer.from(bytes);
    let fd;
    try {
        fd = fs.openSync(target,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
    let fd;
    try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
    catch (error) {
        // Directory fsync is unavailable on a few platforms. The individual
        // file fsync plus same-directory rename still supplies the atomicity
        // invariant; do not mask meaningful filesystem errors elsewhere.
        if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function officialUrl(url, kind, arxivId, sourceId = null) {
    const id = normalizedArxivId(arxivId);
    const boundSourceId = sourceId ? normalizedSourceId(sourceId, id) : id;
    const requested = String(url || '').trim();
    const fallback = kind === 'pdf'
        ? `https://arxiv.org/pdf/${boundSourceId}.pdf`
        : `https://arxiv.org/html/${boundSourceId}`;
    const parsed = new URL(requested || fallback);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org' || parsed.port || parsed.username || parsed.password) {
        fail(`${kind} URL is not a direct official arXiv HTTPS URL`);
    }
    const pathname = decodeURIComponent(parsed.pathname);
    if (kind === 'pdf') {
        const match = pathname.match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\.pdf$/);
        if (!match || match[1].replace(/v\d+$/i, '') !== id || match[1] !== boundSourceId) {
            fail('PDF URL does not bind the requested canonical/version arXiv ID');
        }
    } else {
        const match = pathname.match(/^\/html\/(\d{4}\.\d{4,5})(?:v\d+)?\/?$/);
        if (!match || match[1] !== id) fail('text URL does not bind the canonical arXiv ID');
    }
    if (parsed.search || parsed.hash) fail(`${kind} URL must not include a query or fragment`);
    return parsed.toString();
}

function validateTextResponse(value, arxivId, capturedAt, extractorVersion) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('official text fetch returned no object');
    const source = value.source;
    if (!['html', 'pdf'].includes(source)) fail('official text fetch did not return HTML/PDF text');
    const text = String(value.text || '');
    const bytes = Buffer.from(text, 'utf8');
    if (!text || bytes.length > MAX_TEXT_BYTES) fail('official text response is empty or oversized');
    const sourceId = String(value.sourceId || arxivId);
    if (normalizedArxivId(sourceId) !== arxivId) fail('official text sourceId belongs to another paper');
    const url = officialUrl(value.url || (source === 'html'
        ? `https://arxiv.org/html/${sourceId}` : `https://arxiv.org/pdf/${arxivId}.pdf`), source === 'html' ? 'text' : 'pdf', arxivId, sourceId);
    const fetchedAt = value.fetchedAt === undefined ? capturedAt : asIso(value.fetchedAt, 'text fetchedAt');
    const responseSha256 = sha256(bytes);
    return { bytes, source, sourceId, url, fetchedAt, responseSha256,
        extractor: { contract: EXTRACTOR_CONTRACT, version: extractorVersion } };
}

function validatePdfResponse(value, arxivId, capturedAt) {
    const candidate = Buffer.isBuffer(value) || value instanceof Uint8Array ? { bytes: value } : value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('official PDF fetch returned no object');
    const bytes = Buffer.from(candidate.bytes || candidate.pdf || []);
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('official PDF response is missing a valid PDF header or exceeds the size limit');
    }
    let sourceId = String(candidate.sourceId || '').trim();
    if (!sourceId && candidate.url) {
        try { sourceId = decodeURIComponent(new URL(String(candidate.url)).pathname)
            .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\.pdf$/)?.[1] || ''; }
        catch { /* officialUrl below emits the canonical rejection */ }
    }
    sourceId = normalizedSourceId(sourceId || arxivId, arxivId, 'official PDF source ID');
    const url = officialUrl(candidate.url, 'pdf', arxivId, sourceId);
    const versioned = sourceId !== arxivId;
    if (versioned && (candidate.currentPdfUnavailable !== true || candidate.currentPdfStatus !== 404)) {
        fail('versioned PDF requires a sealed current unversioned PDF HTTP 404 observation');
    }
    if (!versioned && (candidate.currentPdfUnavailable === true || candidate.currentPdfStatus !== undefined
        && candidate.currentPdfStatus !== null)) fail('current PDF cannot claim historical-version fallback');
    const fetchedAt = candidate.fetchedAt === undefined ? capturedAt : asIso(candidate.fetchedAt, 'PDF fetchedAt');
    return { bytes, url, sourceId, fetchedAt, responseSha256: sha256(bytes),
        currentPdfUnavailable: versioned, currentPdfStatus: versioned ? 404 : null };
}

function historicalVersionWarning(identity) {
    return `arXiv 当前无版本 PDF ${identity.attemptedCurrentPdfUrl} 返回 HTTP 404，当前稿不可用；本次只封存并分析官方历史版本 ${identity.selectedSourceId}（${identity.selectedPdfUrl}），不得暗示当前稿仍有效。`;
}
function historicalVersionIdentity({ arxivId, textSourceId, pdf, warnings = [] } = {}) {
    const id = normalizedArxivId(arxivId); const selectedSourceId = normalizedSourceId(pdf?.sourceId || id, id);
    if (selectedSourceId === id) return null;
    if (pdf.currentPdfUnavailable !== true || pdf.currentPdfStatus !== 404
        || normalizedSourceId(textSourceId, id, 'versioned text source ID') !== selectedSourceId) {
        fail('historical-version text/PDF/current-unavailable identity is incomplete or mixed');
    }
    const body = { contract: HISTORICAL_VERSION_CONTRACT, version: 1, canonicalArxivId: id,
        selectedSourceId, textSourceId: selectedSourceId, selectedPdfUrl: officialUrl(pdf.url, 'pdf', id, selectedSourceId),
        currentPdfAvailable: false, attemptedCurrentPdfStatus: 404,
        attemptedCurrentPdfUrl: officialUrl('', 'pdf', id, id) };
    const warning = historicalVersionWarning(body);
    if (warnings.length && !warnings.includes(warning)) fail('historical-version current-unavailable warning is missing');
    const sealed = { ...body, warning };
    return { ...sealed, identitySha256: sha256(JSON.stringify(canonical(sealed))) };
}
function normalizeHistoricalVersionIdentity(value, arxivId) {
    const fields = ['contract', 'version', 'canonicalArxivId', 'selectedSourceId', 'textSourceId', 'selectedPdfUrl',
        'currentPdfAvailable', 'attemptedCurrentPdfStatus', 'attemptedCurrentPdfUrl', 'warning', 'identitySha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')) fail('historical-version identity schema is invalid');
    const id = normalizedArxivId(arxivId); const selected = normalizedSourceId(value.selectedSourceId, id);
    const body = { contract: HISTORICAL_VERSION_CONTRACT, version: 1, canonicalArxivId: id,
        selectedSourceId: selected, textSourceId: normalizedSourceId(value.textSourceId, id),
        selectedPdfUrl: officialUrl(value.selectedPdfUrl, 'pdf', id, selected), currentPdfAvailable: false,
        attemptedCurrentPdfStatus: 404, attemptedCurrentPdfUrl: officialUrl(value.attemptedCurrentPdfUrl, 'pdf', id, id) };
    const warning = historicalVersionWarning(body); const sealed = { ...body, warning };
    if (selected === id || value.contract !== HISTORICAL_VERSION_CONTRACT || value.version !== 1
        || value.canonicalArxivId !== id || value.textSourceId !== selected || value.currentPdfAvailable !== false
        || value.attemptedCurrentPdfStatus !== 404 || value.warning !== warning
        || value.identitySha256 !== sha256(JSON.stringify(canonical(sealed)))) {
        fail('historical-version identity evidence/SHA drifted');
    }
    return { ...sealed, identitySha256: value.identitySha256 };
}

// Structured source evidence is durable only as JSON metadata. It may carry
// table/formula DOM bindings and figure URLs, but never image pixels, cache
// paths, base64, or temporary filenames. Pixels are always fetched again into
// an OS-temporary callback for each direct analysis/Reader attempt.
function fallbackArtifacts(text) {
    const body = { version: 1, source: 'fresh_arxiv_text_without_layout',
        tables: [], formulas: [], figures: [], flattenedTextSha256: text.responseSha256 };
    return { ...body, payloadSha256: sha256(JSON.stringify(body)) };
}
function sourceTitle(value, fallbackText = '') {
    const candidate = String(value || '').replace(/\r\n?/g, '\n').split('\n')
        .map(item => item.replace(/\s+/g, ' ').trim()).find(Boolean)
        || String(fallbackText || '').replace(/\r\n?/g, '\n').split('\n')
            .map(item => item.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    // This is source metadata, never a model/old-page title.  Cap it before
    // persistence so a malformed HTML first line cannot bloat every runtime
    // source bundle. A missing title remains explicit rather than guessed.
    return candidate.slice(0, 2000);
}
function assertNoPersistentImageBytes(value, label = 'runtime metadata') {
    const forbidden = new Set(['cachePath', 'tempPath', 'rawBytes', 'assetBytes', 'base64', 'buffer',
        'assetFilename', 'assetMediaType', 'assetWidth', 'assetHeight', 'dataUri']);
    const inspect = (entry, pathLabel) => {
        if (Array.isArray(entry)) return entry.forEach((item, index) => inspect(item, `${pathLabel}[${index}]`));
        if (!entry || typeof entry !== 'object') return;
        for (const [key, item] of Object.entries(entry)) {
            if (forbidden.has(key)) fail(`${label} contains persistent image field ${pathLabel}.${key}`);
            inspect(item, `${pathLabel}.${key}`);
        }
    };
    inspect(value, label);
    return value;
}
function runtimeDetailsFromFreshCapture(rawText, text, arxivId) {
    return {
        paperId: `arxiv:${arxivId}`,
        title: sourceTitle(rawText?.title, text.bytes.toString('utf8')),
        source: text.source,
        sourceId: text.sourceId,
        text: text.bytes.toString('utf8'),
        imageInfos: Array.isArray(rawText?.imageInfos) ? structuredClone(rawText.imageInfos) : [],
        structuredArtifacts: rawText?.structuredArtifacts && typeof rawText.structuredArtifacts === 'object'
            ? structuredClone(rawText.structuredArtifacts) : fallbackArtifacts(text),
        readerAuthors: rawText?.readerAuthors && typeof rawText.readerAuthors === 'object'
            ? structuredClone(rawText.readerAuthors) : null,
        htmlAvailability: rawText?.htmlAvailability || (text.source === 'html' ? 'available' : 'not_applicable'),
        htmlAttempts: Number.isSafeInteger(rawText?.htmlAttempts) ? rawText.htmlAttempts : 0,
        warnings: Array.isArray(rawText?.warnings) ? rawText.warnings.map(String) : [],
        ...(rawText?.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(rawText.sourceVersion, arxivId) } : {})
    };
}
function runtimeMetadataFromDetails(details, text, arxivId) {
    const metadata = { contract: RUNTIME_METADATA_CONTRACT, version: 1, paperId: `arxiv:${arxivId}`,
        title: sourceTitle(details.title), textSha256: text.responseSha256, structuredArtifacts: clone(details.structuredArtifacts),
        imageInfos: clone(details.imageInfos), readerAuthors: details.readerAuthors === null ? null : clone(details.readerAuthors),
        htmlAvailability: String(details.htmlAvailability || ''), htmlAttempts: details.htmlAttempts,
        warnings: Array.isArray(details.warnings) ? details.warnings.map(String) : [],
        ...(details.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(details.sourceVersion, arxivId) } : {}) };
    return assertNoPersistentImageBytes(metadata);
}
function validateRuntimeMetadata(metadata, text, arxivId) {
    const keys = ['contract', 'htmlAttempts', 'htmlAvailability', 'imageInfos', 'paperId', 'readerAuthors',
        'structuredArtifacts', 'textSha256', 'title', 'version', 'warnings',
        ...(Object.hasOwn(metadata || {}, 'sourceVersion') ? ['sourceVersion'] : [])];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).sort().join('\0') !== keys.sort().join('\0')
        || metadata.contract !== RUNTIME_METADATA_CONTRACT || metadata.version !== 1
        || metadata.paperId !== `arxiv:${arxivId}` || metadata.textSha256 !== text.responseSha256
        || typeof metadata.title !== 'string' || metadata.title !== sourceTitle(metadata.title)
        || !metadata.structuredArtifacts || typeof metadata.structuredArtifacts !== 'object' || Array.isArray(metadata.structuredArtifacts)
        || !Array.isArray(metadata.imageInfos) || !Array.isArray(metadata.warnings)
        || !Number.isSafeInteger(metadata.htmlAttempts) || metadata.htmlAttempts < 0
        || typeof metadata.htmlAvailability !== 'string'
        || (metadata.readerAuthors !== null && (!metadata.readerAuthors || typeof metadata.readerAuthors !== 'object' || Array.isArray(metadata.readerAuthors)))) {
        fail('runtime metadata is invalid');
    }
    assertNoPersistentImageBytes(metadata);
    if (metadata.sourceVersion) {
        const identity = normalizeHistoricalVersionIdentity(metadata.sourceVersion, arxivId);
        if (!metadata.warnings.includes(identity.warning)) fail('runtime historical-version warning is not bound to its evidence');
    }
    return metadata;
}
function runtimeDetailsFromMetadata(metadata, text, arxivId) {
    const verified = validateRuntimeMetadata(metadata, text, arxivId);
    return { paperId: `arxiv:${arxivId}`, title: verified.title, source: text.source, sourceId: text.sourceId,
        text: text.bytes.toString('utf8'), imageInfos: clone(verified.imageInfos),
        structuredArtifacts: clone(verified.structuredArtifacts), readerAuthors: verified.readerAuthors === null ? null : clone(verified.readerAuthors),
        htmlAvailability: verified.htmlAvailability, htmlAttempts: verified.htmlAttempts, warnings: verified.warnings.map(String),
        ...(verified.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(verified.sourceVersion, arxivId) } : {}) };
}

function manifestFor({ arxivId, generation, capturedAt, text, pdf, runtimeMetadataBytes }) {
    return {
        contract: CONTRACT,
        version: VERSION,
        arxivId,
        paperId: `arxiv:${arxivId}`,
        generation,
        capturedAt,
        text: {
            filename: TEXT_NAME,
            source: text.source,
            sourceId: text.sourceId,
            url: text.url,
            fetchedAt: text.fetchedAt,
            extractor: text.extractor,
            responseSha256: text.responseSha256,
            responseBytes: text.bytes.length
        },
        runtimeMetadata: { filename: RUNTIME_METADATA_NAME, responseSha256: sha256(runtimeMetadataBytes),
            responseBytes: runtimeMetadataBytes.length },
        pdf: {
            filename: PDF_NAME,
            url: pdf.url,
            fetchedAt: pdf.fetchedAt,
            responseSha256: pdf.responseSha256,
            responseBytes: pdf.bytes.length
        }
    };
}

function validateManifest(manifest, arxivId, generation) {
    const keys = ['arxivId', 'capturedAt', 'contract', 'generation', 'paperId', 'pdf', 'runtimeMetadata', 'text', 'version'];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || Object.keys(manifest).sort().join('\0') !== keys.join('\0')
        || manifest.contract !== CONTRACT || manifest.version !== VERSION
        || manifest.arxivId !== arxivId || manifest.paperId !== `arxiv:${arxivId}`
        || manifest.generation !== generation) fail('source manifest identity is invalid');
    asIso(manifest.capturedAt, 'manifest capture time');
    const text = manifest.text; const pdf = manifest.pdf; const runtimeMetadata = manifest.runtimeMetadata;
    const textKeys = ['extractor', 'fetchedAt', 'filename', 'responseBytes', 'responseSha256', 'source', 'sourceId', 'url'];
    const pdfKeys = ['fetchedAt', 'filename', 'responseBytes', 'responseSha256', 'url'];
    if (!text || typeof text !== 'object' || Array.isArray(text)
        || Object.keys(text).sort().join('\0') !== textKeys.join('\0')
        || !['html', 'pdf'].includes(text.source) || text.filename !== TEXT_NAME
        || normalizedArxivId(text.sourceId) !== arxivId || !Number.isSafeInteger(text.responseBytes)
        || text.responseBytes < 1 || text.responseBytes > MAX_TEXT_BYTES || !SHA_RE.test(text.responseSha256)
        || !text.extractor || typeof text.extractor !== 'object' || Array.isArray(text.extractor)
        || Object.keys(text.extractor).sort().join('\0') !== ['contract', 'version'].join('\0')
        || text.extractor.contract !== EXTRACTOR_CONTRACT || typeof text.extractor.version !== 'string' || !text.extractor.version) {
        fail('text manifest is invalid');
    }
    officialUrl(text.url, text.source === 'html' ? 'text' : 'pdf', arxivId, text.sourceId);
    asIso(text.fetchedAt, 'text fetchedAt');
    if (!pdf || typeof pdf !== 'object' || Array.isArray(pdf)
        || Object.keys(pdf).sort().join('\0') !== pdfKeys.join('\0') || pdf.filename !== PDF_NAME
        || !Number.isSafeInteger(pdf.responseBytes) || pdf.responseBytes < 5 || pdf.responseBytes > MAX_PDF_BYTES
        || !SHA_RE.test(pdf.responseSha256)) fail('PDF manifest is invalid');
    let pdfSourceId;
    try { pdfSourceId = decodeURIComponent(new URL(pdf.url).pathname)
        .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\.pdf$/)?.[1]; }
    catch { /* officialUrl emits the canonical rejection */ }
    officialUrl(pdf.url, 'pdf', arxivId, pdfSourceId || arxivId); asIso(pdf.fetchedAt, 'PDF fetchedAt');
    if (!runtimeMetadata || typeof runtimeMetadata !== 'object' || Array.isArray(runtimeMetadata)
        || Object.keys(runtimeMetadata).sort().join('\0') !== ['filename', 'responseBytes', 'responseSha256'].join('\0')
        || runtimeMetadata.filename !== RUNTIME_METADATA_NAME || !Number.isSafeInteger(runtimeMetadata.responseBytes)
        || runtimeMetadata.responseBytes < 2 || runtimeMetadata.responseBytes > MAX_TEXT_BYTES
        || !SHA_RE.test(runtimeMetadata.responseSha256)) fail('runtime metadata manifest is invalid');
    return manifest;
}

function readFreshArxivRewriteSource({ rootDir, arxivId, generation } = {}) {
    const root = safeDirectory(rootDir, false, 'source root');
    const id = normalizedArxivId(arxivId); const normalized = normalizedGeneration(generation);
    const directory = sourceDirectory(root, id, normalized);
    safeDirectory(path.join(root, id), false, 'paper source directory');
    safeDirectory(directory, false, 'generation source directory');
    const entries = fs.readdirSync(directory).sort();
    if (entries.join('\0') !== SOURCE_FILES.slice().sort().join('\0')) fail('generation source directory contains unexpected files');
    const manifestBytes = readPrivateFile(path.join(directory, MANIFEST_NAME), 1024 * 1024, 'source manifest');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch (error) { fail(`source manifest is invalid JSON: ${error.message}`); }
    if (!manifestBytes.equals(Buffer.from(canonicalJson(manifest), 'utf8'))) fail('source manifest must be canonical JSON');
    validateManifest(manifest, id, normalized);
    const text = readPrivateFile(path.join(directory, TEXT_NAME), MAX_TEXT_BYTES, 'source text');
    const pdf = readPrivateFile(path.join(directory, PDF_NAME), MAX_PDF_BYTES, 'source PDF');
    const runtimeMetadataBytes = readPrivateFile(path.join(directory, RUNTIME_METADATA_NAME), MAX_TEXT_BYTES, 'runtime metadata');
    if (text.length !== manifest.text.responseBytes || sha256(text) !== manifest.text.responseSha256) fail('source text drifted from manifest');
    if (pdf.length !== manifest.pdf.responseBytes || sha256(pdf) !== manifest.pdf.responseSha256
        || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') fail('source PDF drifted from manifest');
    if (runtimeMetadataBytes.length !== manifest.runtimeMetadata.responseBytes
        || sha256(runtimeMetadataBytes) !== manifest.runtimeMetadata.responseSha256) fail('runtime metadata drifted from manifest');
    let runtimeMetadata;
    try { runtimeMetadata = JSON.parse(runtimeMetadataBytes.toString('utf8')); }
    catch (error) { fail(`runtime metadata is invalid JSON: ${error.message}`); }
    if (!runtimeMetadataBytes.equals(Buffer.from(canonicalJson(runtimeMetadata), 'utf8'))) fail('runtime metadata must be canonical JSON');
    const pdfSourceId = decodeURIComponent(new URL(manifest.pdf.url).pathname)
        .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\.pdf$/)?.[1] || '';
    if (pdfSourceId !== id) {
        const identity = normalizeHistoricalVersionIdentity(runtimeMetadata.sourceVersion, id);
        if (identity.selectedSourceId !== pdfSourceId || manifest.text.source !== 'pdf'
            || manifest.text.sourceId !== pdfSourceId) fail('versioned PDF source is mixed with another text version');
    } else if (runtimeMetadata.sourceVersion !== undefined) {
        fail('current PDF bundle cannot carry historical-version evidence');
    }
    const textInfo = { source: manifest.text.source, sourceId: manifest.text.sourceId, bytes: text,
        responseSha256: manifest.text.responseSha256 };
    const runtimeDetails = runtimeDetailsFromMetadata(runtimeMetadata, textInfo, id);
    return { rootDir: root, directory, arxivId: id, generation: normalized,
        sourceManifestSha256: sha256(manifestBytes), manifest: clone(manifest), runtimeDetails,
        text: text.toString('utf8'), textBytes: text, pdf: Buffer.from(pdf) };
}

function generationExists(rootDir, arxivId, generation) {
    return fs.existsSync(sourceDirectory(rootDir, arxivId, generation));
}

function defaultFetchText(arxivId) {
    // Never let the text adapter download a fallback PDF of its own.  Capture
    // owns one raw PDF request, seals those exact bytes, and hands those bytes
    // to the extractor if HTML is unavailable.
    return require('../deep-analyzer.js').fetchArxivHtmlTextDetailedUncached(arxivId);
}
function defaultFetchPdf(arxivId) {
    return require('../deep-analyzer.js').fetchArxivPdfUncached(arxivId);
}
function defaultFetchFigure(url) {
    return require('../deep-analyzer.js').fetchArxivFigureBytesUncached(url);
}
function defaultExtractPdfText(arxivId, bytes, options) {
    return require('../deep-analyzer.js').extractArxivPdfTextDetailedFromBytes(arxivId, bytes, options);
}

function temporaryGenerationDirectory(parent, name) {
    const temporary = path.join(parent, `.${name}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    return temporary;
}

function removeOwnedTemporaryDirectory(directory) {
    if (!directory || !path.basename(directory).startsWith('.generation-') || !path.basename(directory).endsWith('.tmp')) {
        fail('refuses to remove a non-owned temporary source directory');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
}

async function captureFreshArxivRewriteSource(options = {}, overrides = {}) {
    const root = safeDirectory(options.rootDir || require('../config.js').FILES.freshArxivFetchedSourcesDir, true, 'source root');
    const id = normalizedArxivId(options.arxivId); const generation = normalizedGeneration(options.generation);
    const target = sourceDirectory(root, id, generation);
    if (fs.existsSync(target)) {
        const stored = readFreshArxivRewriteSource({ rootDir: root, arxivId: id, generation });
        return { ...stored, status: 'recovered', fetched: false };
    }
    const paperDirectory = path.join(root, id); safeDirectory(paperDirectory, true, 'paper source directory');
    const capturedAt = nowIso(options.now);
    const fetchText = overrides.fetchText || defaultFetchText;
    const fetchPdf = overrides.fetchPdf || defaultFetchPdf;
    const extractPdfText = overrides.extractPdfText || defaultExtractPdfText;
    if (typeof fetchText !== 'function' || typeof fetchPdf !== 'function' || typeof extractPdfText !== 'function') {
        fail('official HTML text, PDF, and PDF-text extractors are required');
    }
    const extractorVersion = String(options.extractorVersion || DEFAULT_EXTRACTOR_VERSION).trim();
    if (!extractorVersion || extractorVersion.length > 200) fail('extractorVersion is invalid');
    let temporary = null;
    try {
        // Resolve HTML first so a selected official version can be preferred
        // by the PDF fallback. The current unversioned PDF is still probed
        // first so a version fallback carries a replayable HTTP 404 fact.
        const rawText = await fetchText(id);
        const preferredSourceId = rawText?.source === 'html' ? rawText.sourceId : null;
        const rawPdf = await fetchPdf(id, { preferredSourceId });
        const pdf = validatePdfResponse(rawPdf, id, capturedAt);
        const sourceVersion = historicalVersionIdentity({ arxivId: id,
            textSourceId: pdf.sourceId, pdf });
        let text; let runtimeSource = rawText;
        if (rawText?.source === 'html' && !sourceVersion) {
            text = validateTextResponse(rawText, id, capturedAt, extractorVersion);
        } else {
            // A PDF text result returned by fetchText would prove that the
            // adapter threw away or independently downloaded PDF bytes.  The
            // only permitted fallback is extraction from `pdf.bytes`, which
            // is the single response sealed below.
            if (rawText?.source === 'pdf') fail('HTML text adapter must not fetch an independent PDF fallback');
            const extracted = await extractPdfText(id, pdf.bytes, {
                htmlAvailability: rawText?.htmlAvailability || 'unavailable',
                htmlAttempts: rawText?.htmlAttempts || 0,
                warnings: Array.isArray(rawText?.warnings) ? rawText.warnings.slice() : [],
                url: pdf.url,
                fetchedAt: pdf.fetchedAt,
                sourceId: pdf.sourceId
            });
            const versionNotice = sourceVersion ? `【来源版本警告】${sourceVersion.warning}\n\n` : '';
            text = validateTextResponse({ ...extracted, text: `${versionNotice}${String(extracted?.text || '')}`,
                source: 'pdf', sourceId: pdf.sourceId,
                url: pdf.url, fetchedAt: pdf.fetchedAt }, id, capturedAt, extractorVersion);
            // Keep the paper title sourced from the matching historical HTML
            // when available, otherwise derive it from the unprefixed PDF
            // text.  The mandatory warning prefix must never become the title.
            const versionTitle = rawText?.sourceId === pdf.sourceId && rawText?.title
                ? rawText.title : (extracted?.title || sourceTitle('', extracted?.text));
            runtimeSource = { title: versionTitle, source: 'pdf', sourceId: pdf.sourceId,
                imageInfos: [], structuredArtifacts: null, readerAuthors: null,
                htmlAvailability: rawText?.htmlAvailability || 'unavailable',
                htmlAttempts: Number.isSafeInteger(rawText?.htmlAttempts) ? rawText.htmlAttempts : 0,
                warnings: [...(Array.isArray(rawText?.warnings) ? rawText.warnings.map(String) : []),
                    ...(sourceVersion ? [sourceVersion.warning] : [])],
                ...(sourceVersion ? { sourceVersion } : {}) };
        }
        const runtimeDetails = runtimeDetailsFromFreshCapture(runtimeSource, text, id);
        const runtimeMetadataBytes = Buffer.from(canonicalJson(runtimeMetadataFromDetails(runtimeDetails, text, id)), 'utf8');
        const manifest = manifestFor({ arxivId: id, generation, capturedAt, text, pdf, runtimeMetadataBytes });
        temporary = temporaryGenerationDirectory(paperDirectory, generationName(generation));
        writePrivateFile(temporary, TEXT_NAME, text.bytes);
        writePrivateFile(temporary, PDF_NAME, pdf.bytes);
        writePrivateFile(temporary, RUNTIME_METADATA_NAME, runtimeMetadataBytes);
        writePrivateFile(temporary, MANIFEST_NAME, Buffer.from(canonicalJson(manifest), 'utf8'));
        fsyncDirectory(temporary);
        if (typeof overrides.beforeCommit === 'function') await overrides.beforeCommit({ temporary, target, manifest: clone(manifest) });
        try { fs.renameSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        }
        if (fs.existsSync(temporary)) removeOwnedTemporaryDirectory(temporary);
        temporary = null;
        fsyncDirectory(paperDirectory);
        const stored = readFreshArxivRewriteSource({ rootDir: root, arxivId: id, generation });
        return { ...stored, status: 'captured', fetched: true };
    } catch (error) {
        if (temporary && fs.existsSync(temporary)) removeOwnedTemporaryDirectory(temporary);
        throw error;
    }
}

function pathInside(root, candidate) {
    const base = path.resolve(root); const target = path.resolve(candidate);
    return target === base || target.startsWith(`${base}${path.sep}`);
}

function canonicalExistingAncestor(candidate) {
    let cursor = path.resolve(candidate); const suffix = [];
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('path has no existing filesystem ancestor');
        suffix.unshift(path.basename(cursor)); cursor = parent;
    }
    return path.join(fs.realpathSync(cursor), ...suffix);
}

function officialFigureUrl(value, arxivId) {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org' || parsed.port || parsed.username || parsed.password
        || parsed.search || parsed.hash || !parsed.pathname.startsWith('/html/')) {
        fail('figure URL must be a direct official arXiv HTML HTTPS URL');
    }
    const match = decodeURIComponent(parsed.pathname).match(/^\/html\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\/|$)/);
    if (!match || match[1] !== normalizedArxivId(arxivId)) fail('figure URL belongs to another paper');
    return parsed.toString();
}

function normalizeFigureResponse(value) {
    const candidate = Buffer.isBuffer(value) || value instanceof Uint8Array ? { bytes: value } : value;
    const bytes = Buffer.from(candidate?.bytes || []);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) fail('ephemeral figure bytes are empty or oversized');
    const mediaType = String(candidate?.mediaType || 'application/octet-stream').toLowerCase();
    if (!/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(mediaType)) fail('ephemeral figure media type is unsupported');
    return { bytes, mediaType };
}

async function withEphemeralArxivFigures(options = {}, callback, overrides = {}) {
    if (typeof callback !== 'function') fail('ephemeral figure callback is required');
    const id = normalizedArxivId(options.arxivId);
    const figures = Array.isArray(options.figures) ? options.figures : fail('figures must be an array');
    const ordinalSet = new Set();
    const normalizedFigures = figures.map((figure, index) => {
        if (!figure || typeof figure !== 'object' || Array.isArray(figure)
            || !Number.isSafeInteger(figure.ordinal) || figure.ordinal < 1 || ordinalSet.has(figure.ordinal)) {
            fail(`figure ${index + 1} has an invalid or duplicate ordinal`);
        }
        ordinalSet.add(figure.ordinal);
        return { ordinal: figure.ordinal, url: officialFigureUrl(figure.url, id) };
    });
    const osTemporaryRoot = fs.realpathSync(os.tmpdir());
    const temporaryRoot = canonicalExistingAncestor(options.temporaryRoot || osTemporaryRoot);
    const configuredDataRoot = canonicalExistingAncestor(require('../config.js').DATA_DIR);
    if (!pathInside(osTemporaryRoot, temporaryRoot) || pathInside(configuredDataRoot, temporaryRoot)
        || pathInside(temporaryRoot, configuredDataRoot)) {
        fail('ephemeral figures must use an OS-temporary directory outside Config.DATA_DIR');
    }
    const persistentRoots = [options.sourceRoot, ...(options.persistentRoots || [])]
        .filter(Boolean).map(item => path.resolve(item));
    if (persistentRoots.some(root => pathInside(root, temporaryRoot))) {
        fail('ephemeral figures cannot use a persistent runtime directory');
    }
    const fetchFigure = overrides.fetchFigure || defaultFetchFigure;
    if (typeof fetchFigure !== 'function') fail('official figure fetcher is required');
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'fresh-arxiv-figures-'));
    fs.chmodSync(directory, 0o700);
    try {
        const materialized = [];
        for (const figure of normalizedFigures) {
            const response = normalizeFigureResponse(await fetchFigure(figure.url));
            const filename = `figure-${String(figure.ordinal).padStart(3, '0')}.bin`;
            writePrivateFile(directory, filename, response.bytes);
            materialized.push(Object.freeze({ ordinal: figure.ordinal, mediaType: response.mediaType,
                sha256: sha256(response.bytes), bytes: response.bytes.length, tempPath: path.join(directory, filename) }));
        }
        // URLs stay only in this stack frame for fetching. The callback gets
        // ordinal-bound bytes/paths and cannot accidentally serialize URLs via
        // the source-layer result.
        return await callback(Object.freeze({ arxivId: id, temporaryDirectory: directory,
            figures: Object.freeze(materialized) }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
    }
}

module.exports = {
    CONTRACT, VERSION, EXTRACTOR_CONTRACT, DEFAULT_EXTRACTOR_VERSION, HISTORICAL_VERSION_CONTRACT,
    MANIFEST_NAME, TEXT_NAME, PDF_NAME, RUNTIME_METADATA_NAME, SOURCE_FILES, FreshArxivRewriteSourceError,
    sha256, normalizedArxivId, normalizedGeneration, generationName, sourceDirectory,
    readFreshArxivRewriteSource, captureFreshArxivRewriteSource, officialUrl,
    withEphemeralArxivFigures, officialFigureUrl, generationExists, runtimeDetailsFromFreshCapture,
    runtimeMetadataFromDetails, runtimeDetailsFromMetadata, historicalVersionIdentity,
    normalizeHistoricalVersionIdentity, historicalVersionWarning, assertNoPersistentImageBytes
};
