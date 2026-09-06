'use strict';

// Durable, source-only authority for assigning one historical page to one
// canonical paper identity.  Loading always replays the named source files;
// callers receive only an opaque in-process handle.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const identityApi = require('./paper-identity.js');
const conferenceContextApi = require('./conference-source-context.js');

const CONTRACT = 'paper-source-authority-v1';
const VERSION = 1;
const ARXIV_SNAPSHOT_CONTRACT = 'arxiv-paper-source-snapshot-v1';
const ARXIV_RECEIPT_CONTRACT = 'arxiv-paper-source-receipt-v1';
const EVIDENCE_KINDS = Object.freeze(['arxiv-official-fulltext', 'conference-plan-source-context']);
const EVIDENCE_KIND_SET = new Set(EVIDENCE_KINDS);
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SAFE_TEXT_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.(?:txt|md)$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MIN_FULLTEXT_CHARACTERS = 1000;
const AUTHORITY_HANDLES = new WeakSet();
const AUTHORITY_HANDLE_DATA = new WeakMap();

class PaperSourceAuthorityError extends Error {
    constructor(message) {
        super(`Paper source authority rejected: ${message}`);
        this.name = 'PaperSourceAuthorityError';
        this.code = 'PAPER_SOURCE_AUTHORITY_INTEGRITY';
    }
}

function fail(message) { throw new PaperSourceAuthorityError(message); }
const clone = value => JSON.parse(JSON.stringify(value));
function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
const isEvidenceKind = value => EVIDENCE_KIND_SET.has(value);
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`); return value; }
function safeName(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} must be a safe direct filename`);
    return value;
}
function safeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('authorityRoot must be an absolute configured directory');
    const absolute = path.resolve(root); const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail('authorityRoot is unsafe');
    return absolute;
}
function safeDirect(root, name, pattern, label) {
    safeName(name, pattern, label); const filename = path.resolve(root, name);
    if (path.dirname(filename) !== root) fail(`${label} escapes authorityRoot`);
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${label} must be a regular single-link file`);
    return filename;
}
function readJson(root, name, label) {
    const filename = safeDirect(root, name, SAFE_JSON_NAME, label); const before = fs.lstatSync(filename);
    const loaded = ledgerApi.readRegularJson(filename);
    if (!loaded || !plain(loaded.value)) fail(`${label} must contain a JSON object`);
    const bytes = fs.readFileSync(filename); const after = fs.lstatSync(filename);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || bytes.length > MAX_JSON_BYTES || loaded.sha256 !== sha256(bytes)) {
        fail(`${label} exceeds its limit or changed while read`);
    }
    if (!bytes.equals(prettyBytes(loaded.value))) fail(`${label} bytes must be canonical pretty JSON`);
    return { filename: fs.realpathSync(filename), value: loaded.value, bytes, sha256: loaded.sha256,
        dev: after.dev, ino: after.ino };
}
function readText(root, name, label) {
    const filename = safeDirect(root, name, SAFE_TEXT_NAME, label); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_TEXT_BYTES) {
            fail(`${label} changed or is unsafe`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} changed while read`);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail(`${label} must be strict UTF-8`); }
        let count = 0; for (const character of text) if (!/\s/u.test(character)) count += 1;
        if (count < MIN_FULLTEXT_CHARACTERS) fail(`${label} is shorter than the full-text gate`);
        return { filename: fs.realpathSync(filename), bytes, text, sha256: sha256(bytes),
            dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function selfBound(value, field, label) {
    const body = clone(value); delete body[field];
    if (sha(value[field], `${label}.${field}`) !== stableHash(body)) fail(`${label} self-SHA drifted`);
    return clone(value);
}

function normalizeArxivSnapshot(value) {
    exact(value, ['contract', 'version', 'paperId', 'arxivId', 'officialUrl', 'fulltextSha256', 'snapshotSha256'], 'arXiv snapshot');
    if (value.contract !== ARXIV_SNAPSHOT_CONTRACT || value.version !== VERSION
        || value.paperId !== `arxiv:${value.arxivId}`
        || value.officialUrl !== `https://arxiv.org/abs/${value.arxivId}`) fail('arXiv snapshot identity/source is invalid');
    sha(value.fulltextSha256, 'arXiv snapshot fulltextSha256');
    return selfBound(value, 'snapshotSha256', 'arXiv snapshot');
}
function normalizeArxivReceipt(value) {
    exact(value, ['contract', 'version', 'snapshotName', 'snapshotFileSha256', 'snapshotSha256',
        'fulltextName', 'fulltextSha256', 'receiptSha256'], 'arXiv receipt');
    if (value.contract !== ARXIV_RECEIPT_CONTRACT || value.version !== VERSION) fail('arXiv receipt contract/version is invalid');
    safeName(value.snapshotName, SAFE_JSON_NAME, 'arXiv receipt snapshotName');
    safeName(value.fulltextName, SAFE_TEXT_NAME, 'arXiv receipt fulltextName');
    for (const field of ['snapshotFileSha256', 'snapshotSha256', 'fulltextSha256']) sha(value[field], `arXiv receipt ${field}`);
    return selfBound(value, 'receiptSha256', 'arXiv receipt');
}
function normalizeProof(value, evidenceKind) {
    if (evidenceKind === 'arxiv-official-fulltext') {
        exact(value, ['snapshotName', 'snapshotFileSha256', 'snapshotSha256', 'receiptName', 'receiptFileSha256',
            'receiptSha256', 'fulltextName', 'fulltextSha256'], 'arXiv authority proof');
        safeName(value.snapshotName, SAFE_JSON_NAME, 'proof.snapshotName');
        safeName(value.receiptName, SAFE_JSON_NAME, 'proof.receiptName');
        safeName(value.fulltextName, SAFE_TEXT_NAME, 'proof.fulltextName');
    } else {
        exact(value, ['sourceContextName', 'sourceContextFileSha256', 'sourceContextSha256', 'sourceSnapshotSha256',
            'observationBindingSha256', 'planAuthorityBindingSha256', 'fulltextSha256'], 'conference authority proof');
        safeName(value.sourceContextName, SAFE_JSON_NAME, 'proof.sourceContextName');
    }
    for (const [field, item] of Object.entries(value)) if (field.toLowerCase().includes('sha256')) sha(item, `proof.${field}`);
    return clone(value);
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'paperId', 'identity', 'identitySha256', 'identityRecordSha256',
        'evidenceKind', 'proof', 'authoritySha256'], 'authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || !isEvidenceKind(value.evidenceKind)) {
        fail('authority contract/version/evidenceKind is invalid');
    }
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(error.message); }
    if (identity.citation !== null) {
        fail('authority identity citation must be null until an authenticated official-metadata adapter binds it');
    }
    if (value.paperId !== identity.canonicalId
        || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity)
        || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) {
        fail('authority paperId/identity SHA/record SHA does not bind canonical paper identity');
    }
    if ((value.evidenceKind === 'arxiv-official-fulltext') !== (identity.kind === 'arxiv')) {
        fail('authority evidenceKind does not match paper identity kind');
    }
    const proof = normalizeProof(value.proof, value.evidenceKind);
    const normalized = { contract: CONTRACT, version: VERSION, paperId: value.paperId, identity,
        identitySha256: value.identitySha256, identityRecordSha256: value.identityRecordSha256,
        evidenceKind: value.evidenceKind, proof, authoritySha256: value.authoritySha256 };
    return selfBound(normalized, 'authoritySha256', 'authority');
}
function replayArxiv(root, authority) {
    const proof = authority.proof;
    const snapshot = readJson(root, proof.snapshotName, 'arXiv source snapshot');
    const receipt = readJson(root, proof.receiptName, 'arXiv source receipt');
    const fulltext = readText(root, proof.fulltextName, 'arXiv full text');
    const normalizedSnapshot = normalizeArxivSnapshot(snapshot.value);
    const normalizedReceipt = normalizeArxivReceipt(receipt.value);
    if (snapshot.sha256 !== proof.snapshotFileSha256 || normalizedSnapshot.snapshotSha256 !== proof.snapshotSha256
        || receipt.sha256 !== proof.receiptFileSha256 || normalizedReceipt.receiptSha256 !== proof.receiptSha256
        || fulltext.sha256 !== proof.fulltextSha256) fail('arXiv authority proof file/SHA drifted');
    if (normalizedSnapshot.paperId !== authority.paperId || normalizedSnapshot.arxivId !== authority.identity.arxivId
        || normalizedSnapshot.officialUrl !== authority.identity.source.url
        || normalizedSnapshot.fulltextSha256 !== fulltext.sha256
        || normalizedReceipt.snapshotName !== proof.snapshotName
        || normalizedReceipt.snapshotFileSha256 !== snapshot.sha256
        || normalizedReceipt.snapshotSha256 !== normalizedSnapshot.snapshotSha256
        || normalizedReceipt.fulltextName !== proof.fulltextName
        || normalizedReceipt.fulltextSha256 !== fulltext.sha256) fail('arXiv snapshot/receipt/fulltext chain drifted');
    return { fulltextSha256: fulltext.sha256, sourceSnapshotSha256: normalizedSnapshot.snapshotSha256,
        productionAuthorized: false };
}
function replayConference(root, authority, options) {
    if (!options.conferencePlanHandle || typeof options.conferenceSourceRoot !== 'string') {
        fail('conference authority requires a live authenticated plan handle and configured source root');
    }
    const loaded = readJson(root, authority.proof.sourceContextName, 'conference source context');
    let context;
    try { context = conferenceContextApi.buildConferenceSourceContext({ planHandle: options.conferencePlanHandle,
        paperId: authority.paperId, sourceRoot: options.conferenceSourceRoot }); }
    catch (error) { fail(`conference source context replay failed: ${error.message}`); }
    if (!loaded.bytes.equals(prettyBytes(context)) || loaded.sha256 !== authority.proof.sourceContextFileSha256
        || stableHash(context) !== authority.proof.sourceContextSha256
        || context.sourceSnapshotSha256 !== authority.proof.sourceSnapshotSha256
        || context.observationBindingSha256 !== authority.proof.observationBindingSha256
        || context.productionAuthorization?.binding?.bindingSha256 !== authority.proof.planAuthorityBindingSha256
        || sha256(Buffer.from(context.text, 'utf8')) !== authority.proof.fulltextSha256
        || context.paperId !== authority.paperId || context.productionAuthorization?.authorized !== true) {
        fail('conference plan/import/ledger/source-context authority drifted');
    }
    return { fulltextSha256: authority.proof.fulltextSha256,
        sourceSnapshotSha256: authority.proof.sourceSnapshotSha256, productionAuthorized: true };
}

function loadAuthorityHandle({ authorityRoot, authorityName, conferencePlanHandle, conferenceSourceRoot } = {}) {
    const root = safeRoot(authorityRoot);
    const loaded = readJson(root, authorityName, 'paper source authority');
    const authority = normalizeAuthority(loaded.value);
    const replay = authority.evidenceKind === 'arxiv-official-fulltext'
        ? replayArxiv(root, authority)
        : replayConference(root, authority, { conferencePlanHandle, conferenceSourceRoot });
    const handle = Object.freeze(Object.create(null)); AUTHORITY_HANDLES.add(handle);
    AUTHORITY_HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(authority), authorityName,
        authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, fulltextSha256: replay.fulltextSha256,
        sourceSnapshotSha256: replay.sourceSnapshotSha256, productionAuthorized: replay.productionAuthorized }),
    authorityRoot: root, authorityFileDev: loaded.dev, authorityFileIno: loaded.ino,
    conferencePlanHandle, conferenceSourceRoot }));
    return handle;
}
function authorityHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !AUTHORITY_HANDLES.has(handle)) fail('authenticated paper source authority handle required');
    return clone(AUTHORITY_HANDLE_DATA.get(handle).public);
}
function replayAuthorityHandle(handle, { requireProduction = false } = {}) {
    if (!handle || typeof handle !== 'object' || !AUTHORITY_HANDLES.has(handle)) fail('authenticated paper source authority handle required');
    const original = AUTHORITY_HANDLE_DATA.get(handle);
    if (requireProduction && original.public.productionAuthorized !== true) {
        fail('production-authorized paper source authority handle required');
    }
    const replayed = loadAuthorityHandle({ authorityRoot: original.authorityRoot,
        authorityName: original.public.authorityName, conferencePlanHandle: original.conferencePlanHandle,
        conferenceSourceRoot: original.conferenceSourceRoot });
    const current = AUTHORITY_HANDLE_DATA.get(replayed);
    if (current.authorityFileDev !== original.authorityFileDev || current.authorityFileIno !== original.authorityFileIno
        || stableHash(current.public) !== stableHash(original.public)) {
        fail('paper source authority file or replayed evidence changed after handle creation');
    }
    if (requireProduction && current.public.productionAuthorized !== true) {
        fail('replayed paper source authority is not production-authorized');
    }
    return replayed;
}

module.exports = { CONTRACT, VERSION, ARXIV_SNAPSHOT_CONTRACT, ARXIV_RECEIPT_CONTRACT, EVIDENCE_KINDS,
    SAFE_JSON_NAME, SAFE_TEXT_NAME, MIN_FULLTEXT_CHARACTERS, PaperSourceAuthorityError,
    isEvidenceKind,
    stableHash, prettyBytes, normalizeArxivSnapshot, normalizeArxivReceipt, normalizeAuthority,
    loadAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
