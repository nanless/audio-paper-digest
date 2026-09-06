'use strict';

// Authenticates the deterministic Python PDF extraction bundle before it can
// enter conference staging.  Only weak, text-only artifacts are accepted;
// formulas, tables, and figures remain unavailable by construction.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paperIdentity = require('./paper-identity.js');

const REQUEST_CONTRACT = 'conference-pdf-extraction-request-v2';
const ARTIFACT_CONTRACT = 'conference-structured-artifacts-v2';
const RECEIPT_CONTRACT = 'conference-pdf-extraction-receipt-v2';
const VERIFICATION_CONTRACT = 'conference-pdf-extraction-verification-v2';
const VERSION = 2;
const PROFILE = 'weak-pdf-layout-v1';
const OFFSET_UNIT = 'utf8-byte';
const EXTRACTOR_NAME = 'audio-paper-digest-conference-text';
const EXTRACTOR_VERSION = '1.0.0';
const BACKEND_NAME = 'pypdf';
const BACKEND_VERSION = '6.17.0';
const OPTIONS = Object.freeze({ minimumTextCharacters: 5000,
    normalization: 'unicode-nfc-lf-rstrip-v1', pageSeparator: '\n\f\n' });
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SAFE_PDF_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.pdf$/;
const SAFE_TEXT_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.txt$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['official-metadata', 'official-pdf', 'conference-proceedings', 'openreview', 'local-confirmed-copy']);
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const EXTRACTION_HANDLES = new WeakSet();
const EXTRACTION_HANDLE_DATA = new WeakMap();

class ConferenceExtractionReceiptError extends Error {
    constructor(message) {
        super(message); this.name = 'ConferenceExtractionReceiptError';
        this.code = 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY';
    }
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function fail(message) {
    throw new ConferenceExtractionReceiptError(`Conference extraction receipt rejected: ${message}`);
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function safeName(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} must be a safe direct filename`);
    return value;
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}
function text(value, label, { maximum = 2000 } = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
        || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must be trimmed text without controls`);
    return value;
}
function timestamp(value, label) {
    text(value, label);
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(date.getTime()) || date.toISOString() !== value) fail(`${label} must be a canonical UTC timestamp`);
    return value;
}
function strictPointer(value, label) {
    text(value, label);
    if (!value.startsWith('/') || /~(?:[^01]|$)/u.test(value)) fail(`${label} must be a strict JSON Pointer`);
    return value;
}
function identityEvidence(value) {
    const fields = ['conferenceIdPointer', 'conferenceYearPointer', 'identityTypePointer', 'identityValuePointer'];
    exact(value, fields, 'metadata identityEvidence');
    return Object.fromEntries(fields.map(field => [field, strictPointer(value[field], `metadata identityEvidence.${field}`)]));
}
function discoveryBinding(value) {
    exact(value, ['catalogSha256', 'metadataSnapshotSha256', 'metadataIndex', 'metadataRecordSha256'],
        'metadata discoveryBinding');
    if (!Number.isSafeInteger(value.metadataIndex) || value.metadataIndex < 0) {
        fail('metadata discoveryBinding.metadataIndex must be a nonnegative safe integer');
    }
    return { catalogSha256: assertSha(value.catalogSha256, 'metadata discoveryBinding.catalogSha256'),
        metadataSnapshotSha256: assertSha(value.metadataSnapshotSha256, 'metadata discoveryBinding.metadataSnapshotSha256'),
        metadataIndex: value.metadataIndex,
        metadataRecordSha256: assertSha(value.metadataRecordSha256, 'metadata discoveryBinding.metadataRecordSha256') };
}
function provenance(value, label) {
    exact(value, ['kind', 'locator', 'retrievedAt'], `${label}.provenance`);
    if (!SOURCE_KINDS.has(value.kind)) fail(`${label}.provenance.kind is unsupported`);
    return { kind: value.kind, locator: text(value.locator, `${label}.provenance.locator`),
        retrievedAt: timestamp(value.retrievedAt, `${label}.provenance.retrievedAt`) };
}
function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key;
            try { key = JSON.parse(token); } catch { fail(`${label} contains invalid JSON string syntax`); }
            if (top.keys.has(key)) fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}
function strictJson(bytes, label) {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        return JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY') throw error;
        fail(`${label} must contain strict UTF-8 JSON`);
    }
}
function strictUtf8(bytes, label) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label} must contain strict UTF-8 text`); }
}
function safeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('sourceRoot must be an absolute configured directory');
    const absolute = path.resolve(root); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); const info = fs.lstatSync(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) fail('sourceRoot contains an unsafe directory');
    }
    if (fs.realpathSync(absolute) !== absolute) fail('sourceRoot must not resolve through a symbolic link');
    return absolute;
}
function readDirect(root, name, pattern, limit, label) {
    safeName(name, pattern, label); const filename = path.join(root, name); let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
            fail(`${label} must be a bounded regular single-link file`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size || opened.size > limit) {
            fail(`${label} changed or became unsafe while opening`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} changed while being read`);
        return { filename, bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error?.code === 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY') throw error;
        fail(`${label} cannot be read safely: ${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function normalizeSourceEntry(value, kind) {
    const fields = kind === 'metadata' ? ['file', 'sha256', 'identityEvidence', 'discoveryBinding', 'provenance']
        : ['file', 'sha256', 'provenance'];
    exact(value, fields, `source.${kind}`);
    const result = { file: safeName(value.file, kind === 'metadata' ? SAFE_JSON_NAME : SAFE_PDF_NAME, `source.${kind}.file`),
        sha256: assertSha(value.sha256, `source.${kind}.sha256`) };
    if (kind === 'metadata') {
        result.identityEvidence = identityEvidence(value.identityEvidence);
        result.discoveryBinding = discoveryBinding(value.discoveryBinding);
    }
    result.provenance = provenance(value.provenance, `source.${kind}`);
    return result;
}
function normalizeOptions(value) {
    exact(value, Object.keys(OPTIONS), 'extraction options');
    if (stableHash(value) !== stableHash(OPTIONS)) fail('extraction options differ from the supported weak profile');
    return clone(OPTIONS);
}
function normalizeRequest(value, requestName) {
    exact(value, ['contract', 'version', 'paperId', 'sourceIdentity', 'source', 'outputs', 'options'], 'extraction request');
    if (value.contract !== REQUEST_CONTRACT || value.version !== VERSION) fail('extraction request contract/version is unsupported');
    exact(value.source, ['metadata', 'pdf'], 'extraction request source');
    exact(value.outputs, ['textFile', 'artifactsFile', 'receiptFile'], 'extraction request outputs');
    const result = { contract: REQUEST_CONTRACT, version: VERSION,
        paperId: text(value.paperId, 'request.paperId'), sourceIdentity: text(value.sourceIdentity, 'request.sourceIdentity'),
        source: { metadata: normalizeSourceEntry(value.source.metadata, 'metadata'),
            pdf: normalizeSourceEntry(value.source.pdf, 'pdf') },
        outputs: { textFile: safeName(value.outputs.textFile, SAFE_TEXT_NAME, 'outputs.textFile'),
            artifactsFile: safeName(value.outputs.artifactsFile, SAFE_JSON_NAME, 'outputs.artifactsFile'),
            receiptFile: safeName(value.outputs.receiptFile, SAFE_JSON_NAME, 'outputs.receiptFile') },
        options: normalizeOptions(value.options) };
    const names = [requestName, result.source.metadata.file, result.source.pdf.file, ...Object.values(result.outputs)];
    if (new Set(names).size !== names.length) fail('request inputs and outputs must use distinct filenames');
    return result;
}
function resolvePointer(document, pointer, label) {
    let current = document;
    for (const encoded of pointer.slice(1).split('/')) {
        const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) fail(`${label} does not resolve in metadata`);
            current = current[Number(key)];
        } else if (plain(current) && Object.hasOwn(current, key)) current = current[key];
        else fail(`${label} does not resolve in metadata`);
    }
    return current;
}
function validateMetadataIdentity(metadata, request) {
    const evidence = request.source.metadata.identityEvidence;
    const conferenceId = resolvePointer(metadata, evidence.conferenceIdPointer, 'conferenceIdPointer');
    const conferenceYear = resolvePointer(metadata, evidence.conferenceYearPointer, 'conferenceYearPointer');
    const identityType = resolvePointer(metadata, evidence.identityTypePointer, 'identityTypePointer');
    const identityValue = resolvePointer(metadata, evidence.identityValuePointer, 'identityValuePointer');
    if (typeof conferenceId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(conferenceId)
        || !Number.isSafeInteger(conferenceYear) || conferenceYear < 1900 || conferenceYear > 2100
        || typeof identityType !== 'string' || typeof identityValue !== 'string'
        || request.sourceIdentity !== `${identityType}:${identityValue}`) {
        fail('metadata identity evidence does not bind request paperId/sourceIdentity');
    }
    const conference = { id: conferenceId, year: conferenceYear };
    const identity = { type: identityType, value: identityValue };
    try { paperIdentity.assertCanonicalConferencePaperId(request.paperId, conference, identity); }
    catch (error) { fail(`metadata identity evidence does not bind canonical paperId: ${error.message}`); }
    return { conference, identity };
}
function validateArtifact(value, textBytes) {
    exact(value, ['contract', 'version', 'profile', 'offsetUnit', 'flattenedTextSha256', 'pages',
        'tables', 'formulas', 'figures', 'payloadSha256'], 'structured artifact');
    if (value.contract !== ARTIFACT_CONTRACT || value.version !== VERSION || value.profile !== PROFILE
        || value.offsetUnit !== OFFSET_UNIT) fail('structured artifact contract/version/profile is unsupported');
    if (assertSha(value.flattenedTextSha256, 'flattenedTextSha256') !== sha256(textBytes)) {
        fail('structured artifact flattenedTextSha256 drifted');
    }
    const { payloadSha256, ...body } = value;
    if (assertSha(payloadSha256, 'payloadSha256') !== sha256(JSON.stringify(body))) fail('structured artifact payloadSha256 drifted');
    if (!Array.isArray(value.pages) || !value.pages.length
        || !Array.isArray(value.tables) || value.tables.length
        || !Array.isArray(value.formulas) || value.formulas.length
        || !Array.isArray(value.figures) || value.figures.length) {
        fail('weak structured artifact must contain only a non-empty page map');
    }
    let previousEnd = 0;
    value.pages.forEach((page, index) => {
        exact(page, ['page', 'textStart', 'textEnd'], `pages[${index}]`);
        if (page.page !== index + 1 || !Number.isSafeInteger(page.textStart) || !Number.isSafeInteger(page.textEnd)
            || page.textStart !== previousEnd || page.textEnd <= page.textStart || page.textEnd > textBytes.length) {
            fail('page map must consecutively and exactly partition UTF-8 text bytes');
        }
        try { new TextDecoder('utf-8', { fatal: true }).decode(textBytes.subarray(page.textStart, page.textEnd)); }
        catch { fail('page offsets must fall on UTF-8 code-point boundaries'); }
        previousEnd = page.textEnd;
    });
    if (previousEnd !== textBytes.length) fail('page map must cover all UTF-8 text bytes');
    return clone(value);
}
function normalizeReceipt(value) {
    exact(value, ['contract', 'version', 'status', 'textReplayable', 'structuredReplayable', 'paperId',
        'sourceIdentity', 'request', 'source', 'extractor', 'options', 'pageCount', 'text', 'artifacts',
        'blockedReason', 'receiptSha256'], 'extraction receipt');
    if (value.contract !== RECEIPT_CONTRACT || value.version !== VERSION || value.status !== 'ready'
        || value.textReplayable !== true || value.structuredReplayable !== false || value.blockedReason !== null) {
        fail('only ready text-replayable weak extraction receipts may enter staging');
    }
    exact(value.request, ['file', 'sha256'], 'receipt.request');
    exact(value.source, ['metadata', 'pdf'], 'receipt.source');
    exact(value.extractor, ['name', 'version', 'backend'], 'receipt.extractor');
    exact(value.extractor.backend, ['name', 'version'], 'receipt.extractor.backend');
    exact(value.text, ['file', 'sha256', 'utf8Bytes', 'nonWhitespaceCharacters'], 'receipt.text');
    exact(value.artifacts, ['file', 'sha256'], 'receipt.artifacts');
    if (value.extractor.name !== EXTRACTOR_NAME || value.extractor.version !== EXTRACTOR_VERSION
        || value.extractor.backend.name !== BACKEND_NAME || value.extractor.backend.version !== BACKEND_VERSION) {
        fail('extractor/backend name or version differs from the pinned implementation');
    }
    if (!Number.isSafeInteger(value.pageCount) || value.pageCount < 1
        || !Number.isSafeInteger(value.text.utf8Bytes) || value.text.utf8Bytes < 1
        || !Number.isSafeInteger(value.text.nonWhitespaceCharacters)
        || value.text.nonWhitespaceCharacters < OPTIONS.minimumTextCharacters) fail('receipt counts do not satisfy the extraction gate');
    const result = clone(value); result.request.file = safeName(value.request.file, SAFE_JSON_NAME, 'receipt.request.file');
    assertSha(value.request.sha256, 'receipt.request.sha256');
    result.source = { metadata: normalizeSourceEntry(value.source.metadata, 'metadata'),
        pdf: normalizeSourceEntry(value.source.pdf, 'pdf') };
    result.text.file = safeName(value.text.file, SAFE_TEXT_NAME, 'receipt.text.file');
    result.artifacts.file = safeName(value.artifacts.file, SAFE_JSON_NAME, 'receipt.artifacts.file');
    assertSha(value.text.sha256, 'receipt.text.sha256'); assertSha(value.artifacts.sha256, 'receipt.artifacts.sha256');
    result.options = normalizeOptions(value.options);
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'receipt.receiptSha256') !== stableHash(body)) fail('receipt self-SHA drifted');
    return result;
}

function normalizeVerification(value) {
    exact(value, ['contract', 'version', 'status', 'paperId', 'sourceIdentity', 'requestSha256',
        'metadataSha256', 'pdfSha256', 'textSha256', 'artifactsSha256', 'receiptFileSha256',
        'receiptSha256', 'verificationSha256'], 'Python extraction verification');
    if (value.contract !== VERIFICATION_CONTRACT || value.version !== VERSION || value.status !== 'verified') {
        fail('Python extraction verification contract/version/status is invalid');
    }
    text(value.paperId, 'Python verification paperId');
    text(value.sourceIdentity, 'Python verification sourceIdentity');
    for (const field of ['requestSha256', 'metadataSha256', 'pdfSha256', 'textSha256',
        'artifactsSha256', 'receiptFileSha256', 'receiptSha256']) assertSha(value[field], `Python verification ${field}`);
    const body = clone(value); delete body.verificationSha256;
    if (assertSha(value.verificationSha256, 'Python verification verificationSha256') !== stableHash(body)) {
        fail('Python extraction verification self-SHA drifted');
    }
    return clone(value);
}

function verifyWithPinnedPython(sourceRoot, requestName) {
    const runtime = path.resolve(__dirname, '..', 'python-runtime.sh');
    const script = path.resolve(__dirname, '..', 'conference-extract.py');
    let stdout;
    try {
        stdout = execFileSync('bash', [runtime, script, '--verify', '--manifest', requestName, '--source-root', sourceRoot], {
            cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
            timeout: 2 * 60 * 1000, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error) {
        const stderr = String(error?.stderr || '').trim().split(/\r?\n/).at(-1) || error.message;
        fail(`pinned Python replay failed: ${stderr}`);
    }
    let parsed;
    try { parsed = JSON.parse(String(stdout).trim()); }
    catch { fail('pinned Python replay did not return one JSON verification result'); }
    return normalizeVerification(parsed);
}

function loadExtractionHandle(sourceRoot, receiptName) {
    const root = safeRoot(sourceRoot); safeName(receiptName, SAFE_JSON_NAME, 'receiptName');
    const receiptLoaded = readDirect(root, receiptName, SAFE_JSON_NAME, MAX_JSON_BYTES, 'extraction receipt');
    const receipt = normalizeReceipt(strictJson(receiptLoaded.bytes, 'extraction receipt'));
    if (receipt.artifacts.file === receiptName || receipt.text.file === receiptName || receipt.request.file === receiptName) {
        fail('receipt filename aliases another bundle file');
    }
    const requestLoaded = readDirect(root, receipt.request.file, SAFE_JSON_NAME, MAX_JSON_BYTES, 'extraction request');
    if (requestLoaded.sha256 !== receipt.request.sha256) fail('extraction request SHA differs from receipt');
    const request = normalizeRequest(strictJson(requestLoaded.bytes, 'extraction request'), receipt.request.file);
    if (request.paperId !== receipt.paperId || request.sourceIdentity !== receipt.sourceIdentity
        || stableHash(request.source) !== stableHash(receipt.source)
        || stableHash(request.options) !== stableHash(receipt.options)
        || request.outputs.receiptFile !== receiptName
        || request.outputs.textFile !== receipt.text.file || request.outputs.artifactsFile !== receipt.artifacts.file) {
        fail('receipt does not exactly replay its extraction request');
    }
    const metadataLoaded = readDirect(root, request.source.metadata.file, SAFE_JSON_NAME, MAX_METADATA_BYTES, 'metadata');
    const pdfLoaded = readDirect(root, request.source.pdf.file, SAFE_PDF_NAME, MAX_PDF_BYTES, 'PDF');
    const textLoaded = readDirect(root, request.outputs.textFile, SAFE_TEXT_NAME, MAX_TEXT_BYTES, 'text');
    const artifactLoaded = readDirect(root, request.outputs.artifactsFile, SAFE_JSON_NAME, MAX_JSON_BYTES, 'structured artifact');
    if (metadataLoaded.sha256 !== request.source.metadata.sha256 || pdfLoaded.sha256 !== request.source.pdf.sha256
        || textLoaded.sha256 !== receipt.text.sha256 || artifactLoaded.sha256 !== receipt.artifacts.sha256) {
        fail('bundle source or derived artifact SHA differs from receipt/request');
    }
    if (pdfLoaded.bytes.length < 5 || pdfLoaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('PDF does not have a standard header');
    }
    const metadata = strictJson(metadataLoaded.bytes, 'metadata');
    if (!plain(metadata)) fail('metadata must contain a JSON object');
    const identity = validateMetadataIdentity(metadata, request);
    const sourceText = strictUtf8(textLoaded.bytes, 'text');
    let nonWhitespaceCharacters = 0; for (const character of sourceText) if (!/\s/u.test(character)) nonWhitespaceCharacters += 1;
    if (textLoaded.bytes.length !== receipt.text.utf8Bytes
        || nonWhitespaceCharacters !== receipt.text.nonWhitespaceCharacters) fail('receipt text counts drifted');
    const artifact = validateArtifact(strictJson(artifactLoaded.bytes, 'structured artifact'), textLoaded.bytes);
    if (artifact.pages.length !== receipt.pageCount) fail('receipt page count differs from structured artifact');
    const verification = verifyWithPinnedPython(root, receipt.request.file);
    if (verification.paperId !== request.paperId || verification.sourceIdentity !== request.sourceIdentity
        || verification.requestSha256 !== requestLoaded.sha256 || verification.metadataSha256 !== metadataLoaded.sha256
        || verification.pdfSha256 !== pdfLoaded.sha256 || verification.textSha256 !== textLoaded.sha256
        || verification.artifactsSha256 !== artifactLoaded.sha256 || verification.receiptFileSha256 !== receiptLoaded.sha256
        || verification.receiptSha256 !== receipt.receiptSha256) {
        fail('pinned Python verification does not bind the loaded extraction bundle');
    }
    const snapshot = {
        contract: RECEIPT_CONTRACT, version: VERSION, paperId: request.paperId,
        sourceIdentity: request.sourceIdentity, conference: identity.conference, identity: identity.identity,
        metadata: clone(request.source.metadata), pdf: clone(request.source.pdf),
        text: { file: request.outputs.textFile, sha256: textLoaded.sha256,
            provenance: { extractor: EXTRACTOR_NAME, version: `${EXTRACTOR_VERSION}+${BACKEND_NAME}-${BACKEND_VERSION}` } },
        artifacts: { file: request.outputs.artifactsFile, sha256: artifactLoaded.sha256,
            provenance: { extractor: EXTRACTOR_NAME, version: `${EXTRACTOR_VERSION}+${BACKEND_NAME}-${BACKEND_VERSION}` } },
        receipt: { file: receiptName, fileSha256: receiptLoaded.sha256, receiptSha256: receipt.receiptSha256 },
        verification,
        pageCount: receipt.pageCount, profile: PROFILE, structuredCapabilitiesAvailable: false
    };
    const handle = Object.freeze(Object.create(null)); EXTRACTION_HANDLES.add(handle);
    EXTRACTION_HANDLE_DATA.set(handle, Object.freeze(clone(snapshot))); return handle;
}
function extractionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !EXTRACTION_HANDLES.has(handle)) fail('requires an authenticated extraction handle');
    return clone(EXTRACTION_HANDLE_DATA.get(handle));
}

module.exports = { REQUEST_CONTRACT, ARTIFACT_CONTRACT, RECEIPT_CONTRACT, VERIFICATION_CONTRACT,
    VERSION, PROFILE, OFFSET_UNIT,
    EXTRACTOR_NAME, EXTRACTOR_VERSION, BACKEND_NAME, BACKEND_VERSION, OPTIONS, SAFE_JSON_NAME,
    ConferenceExtractionReceiptError, loadExtractionHandle, extractionHandleSnapshot, stableHash };
