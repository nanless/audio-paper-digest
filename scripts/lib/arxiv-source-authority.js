'use strict';

// Durable adapter from the existing official arXiv fetcher to the historical
// paper-source-authority contract.  Generated prose is never accepted here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identityApi = require('./paper-identity.js');
const authorityApi = require('./paper-source-authority.js');

const REQUEST_CONTRACT = 'arxiv-paper-source-request-v1';
const SNAPSHOT_CONTRACT = 'arxiv-paper-source-production-snapshot-v1';
const RECEIPT_CONTRACT = 'arxiv-paper-source-production-receipt-v1';
const OBSERVATION_CONTRACT = 'arxiv-paper-source-observation-v1';
const FETCHER_CONTRACT = 'deep-analyzer-official-arxiv-fulltext-v1';
const VERSION = 1;
const LOCK_STALE_MS = 15 * 60 * 1000;
const SAFE_AUTHORITY_NAME = /^arxiv-[0-9]{4}\.[0-9]{4,5}(?:-[a-z0-9][a-z0-9._-]{0,80})?\.json$/;
const PRODUCTION_HANDLES = new WeakSet();
const PRODUCTION_HANDLE_DATA = new WeakMap();

class ArxivSourceAuthorityError extends Error {
    constructor(message) {
        super(`arXiv source authority rejected: ${message}`);
        this.name = 'ArxivSourceAuthorityError';
        this.code = 'ARXIV_SOURCE_AUTHORITY_INTEGRITY';
        this.retryable = false;
    }
}
const fail = message => { throw new ArxivSourceAuthorityError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = authorityApi.stableHash;
const prettyBytes = authorityApi.prettyBytes;
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const nowIso = value => {
    const date = value === undefined ? new Date() : new Date(value);
    if (!Number.isFinite(date.getTime())) fail('timestamp is invalid');
    return date.toISOString();
};

function identityFor(arxivId) {
    if (!identityApi.ARXIV_ID_RE.test(String(arxivId || ''))) fail('arxivId must be a normalized versionless ID');
    return identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'arxiv',
        canonicalId: `arxiv:${arxivId}`, arxivId, conference: null, externalId: null,
        source: { status: 'official', url: `https://arxiv.org/abs/${arxivId}` }, citation: null });
}
function namesFor(authorityName, arxivId) {
    if (!SAFE_AUTHORITY_NAME.test(String(authorityName || ''))
        || !authorityName.startsWith(`arxiv-${arxivId}`)) fail('authorityName must be a safe direct name bound to arxivId');
    const stem = authorityName.slice(0, -5);
    return { authorityName, requestName: `${stem}-request.json`, observationName: `${stem}-observation.json`,
        fulltextName: `${stem}-fulltext.txt`, snapshotName: `${stem}-snapshot.json`, receiptName: `${stem}-receipt.json` };
}
function safeRoot(root, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('authorityRoot must be an absolute configured path');
    const absolute = path.resolve(root);
    if (!fs.existsSync(absolute)) {
        if (!create) return absolute;
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail('authorityRoot is unsafe');
    return absolute;
}
function readBytes(filename, max = 64 * 1024 * 1024) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!stat.isFile() || stat.nlink !== 1 || named.isSymbolicLink() || named.dev !== stat.dev
            || named.ino !== stat.ino || stat.size > max) fail(`unsafe or oversized artifact: ${path.basename(filename)}`);
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size) fail(`artifact changed while read: ${path.basename(filename)}`);
        return bytes;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExact(filename, bytes) {
    const payload = Buffer.from(bytes); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readBytes(filename).equals(payload)) fail(`refuses to overwrite different artifact: ${path.basename(filename)}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    try { fs.chmodSync(filename, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
    return sha256(payload);
}
function seal(body, field) { return { ...body, [field]: stableHash(body) }; }
function readCanonicalJson(filename) {
    const bytes = readBytes(filename); let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { fail(`${path.basename(filename)} is not strict JSON/UTF-8: ${error.message}`); }
    if (!bytes.equals(prettyBytes(value))) fail(`${path.basename(filename)} is not canonical pretty JSON`);
    return { value, bytes, sha256: sha256(bytes) };
}
function requestFor({ arxivId, authorityName, operationId, now }) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(operationId || ''))) {
        fail('operationId must be a UUID v4');
    }
    const identity = identityFor(arxivId); const names = namesFor(authorityName, arxivId);
    const body = { contract: REQUEST_CONTRACT, version: VERSION, operationId, paperId: identity.canonicalId,
        arxivId, identitySha256: identityApi.identitySha256(identity), authorityName: names.authorityName,
        officialAbsUrl: identity.source.url, officialHtmlUrl: `https://arxiv.org/html/${arxivId}`,
        officialPdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`, fetcherContract: FETCHER_CONTRACT,
        requestedAt: nowIso(now) };
    return seal(body, 'requestSha256');
}
function validateRequest(value, expected = {}) {
    const rebuilt = requestFor({ arxivId: value?.arxivId, authorityName: value?.authorityName,
        operationId: value?.operationId, now: value?.requestedAt });
    if (stableHash(value) !== stableHash(rebuilt) || value.requestSha256 !== rebuilt.requestSha256) fail('request contract or self-SHA drifted');
    if (expected.arxivId && value.arxivId !== expected.arxivId) fail('request belongs to another arXiv ID');
    if (expected.authorityName && value.authorityName !== expected.authorityName) fail('request belongs to another authority name');
    return rebuilt;
}
function normalizeFetchedSource(details, arxivId, fetchedAt) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) fail('official fetch returned no source object');
    if (Object.keys(details).some(key => /^(?:analysis|parsed$|apiReader|freshRewrite|freshSource)/.test(key))) {
        fail('official source adapter rejects generated analysis or Reader fields');
    }
    if (!['html', 'pdf'].includes(details.source) || typeof details.text !== 'string') fail('official fetch did not return HTML/PDF full text');
    const sourceId = String(details.sourceId || '');
    if (sourceId.replace(/v\d+$/i, '') !== arxivId) fail('official fetch sourceId belongs to another paper');
    let nonWhitespace = 0; for (const character of details.text) if (!/\s/u.test(character)) nonWhitespace += 1;
    if (nonWhitespace < authorityApi.MIN_FULLTEXT_CHARACTERS) fail('official fetch result is shorter than the authority full-text gate');
    const structuredArtifacts = details.structuredArtifacts;
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object' || Array.isArray(structuredArtifacts)
        || !Array.isArray(structuredArtifacts.tables) || !Array.isArray(structuredArtifacts.formulas)) {
        fail('official fetch lacks the public structured source contract');
    }
    const { payloadSha256, ...artifactBody } = structuredArtifacts;
    if (!/^[a-f0-9]{64}$/.test(String(payloadSha256 || ''))
        || payloadSha256 !== sha256(JSON.stringify(artifactBody))
        || structuredArtifacts.flattenedTextSha256 !== sha256(details.text)) {
        fail('official fetch structured source hashes do not bind the full text');
    }
    // Canonical JSON sorts object keys; re-seal the exact same public source
    // payload after canonicalization so later byte replay can verify it.
    const durableArtifactBody = canonical(artifactBody);
    const durableStructuredArtifacts = { ...durableArtifactBody,
        payloadSha256: sha256(JSON.stringify(durableArtifactBody)) };
    const sourceUrl = details.source === 'html'
        ? `https://arxiv.org/html/${sourceId}` : `https://arxiv.org/pdf/${sourceId}.pdf`;
    const observationBody = { contract: OBSERVATION_CONTRACT, version: VERSION, paperId: `arxiv:${arxivId}`,
        arxivId, sourceKind: details.source, sourceId, sourceUrl,
        htmlAvailability: String(details.htmlAvailability || 'unknown'),
        htmlAttempts: Number.isSafeInteger(details.htmlAttempts) && details.htmlAttempts >= 0 ? details.htmlAttempts : 0,
        warnings: Array.isArray(details.warnings) ? details.warnings.map(item => String(item).slice(0, 4096)) : [],
        structuredArtifacts: durableStructuredArtifacts, fetchedAt: nowIso(fetchedAt) };
    const observation = seal(observationBody, 'observationSha256');
    return { text: details.text, observation };
}
function acquireLock(root, arxivId) {
    const lock = path.join(root, `.arxiv-${arxivId}.lock`);
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(lock);
        if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < LOCK_STALE_MS) fail(`source operation is locked: ${arxivId}`);
        let owner = null;
        try { owner = JSON.parse(readBytes(path.join(lock, 'owner.json'), 4096).toString('utf8')); } catch { fail('stale lock has invalid owner evidence'); }
        if (owner.hostname !== os.hostname() || (Number.isSafeInteger(owner.pid) && owner.pid > 0 && (() => { try { process.kill(owner.pid, 0); return true; } catch (caught) { return caught.code !== 'ESRCH'; } })())) {
            fail('stale lock ownership cannot be safely reclaimed');
        }
        fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 });
    }
    writeExact(path.join(lock, 'owner.json'), prettyBytes({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
    return lock;
}
function releaseLock(lock) { fs.rmSync(lock, { recursive: true }); }

function liveProductionHandle(genericHandle) {
    const base = authorityApi.authorityHandleSnapshot(genericHandle);
    const publicSnapshot = Object.freeze({ ...clone(base), productionAuthorized: true });
    const handle = Object.freeze(Object.create(null));
    PRODUCTION_HANDLES.add(handle); PRODUCTION_HANDLE_DATA.set(handle, Object.freeze({ genericHandle, publicSnapshot }));
    return handle;
}
function productionAuthorityHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !PRODUCTION_HANDLES.has(handle)) return null;
    return clone(PRODUCTION_HANDLE_DATA.get(handle).publicSnapshot);
}
function replayProductionAuthorityHandle(handle) {
    if (!handle || typeof handle !== 'object' || !PRODUCTION_HANDLES.has(handle)) return null;
    const stored = PRODUCTION_HANDLE_DATA.get(handle);
    const replayed = authorityApi.replayAuthorityHandle(stored.genericHandle);
    const current = authorityApi.authorityHandleSnapshot(replayed);
    const expected = { ...clone(stored.publicSnapshot), productionAuthorized: false };
    if (stableHash(current) !== stableHash(expected)) fail('live official authority evidence changed after fetch');
    return handle;
}

async function prepareArxivSourceAuthority({ authorityRoot, arxivId, authorityName,
    apply = false, now, operationId, requireLiveAuthorization = false } = {}) {
    const root = safeRoot(authorityRoot, apply); const names = namesFor(authorityName, arxivId);
    const planned = { status: 'dry-run', arxivId, paperId: `arxiv:${arxivId}`, authorityName,
        officialUrl: `https://arxiv.org/abs/${arxivId}`, artifacts: clone(names) };
    if (!apply) return planned;
    const lock = acquireLock(root, arxivId);
    try {
        const authorityFile = path.join(root, authorityName);
        if (fs.existsSync(authorityFile)) {
            const generic = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName });
            const snapshot = authorityApi.authorityHandleSnapshot(generic);
            if (snapshot.authority.paperId !== planned.paperId) fail('existing authority belongs to another arXiv source');
            if (!requireLiveAuthorization) return { ...planned, status: 'recovered', authorityHandle: generic, authority: snapshot };
            const fetched = normalizeFetchedSource(
                await require('../deep-analyzer.js').fetchArxivTextDetailed(arxivId), arxivId, now);
            const persistedText = readBytes(path.join(root, names.fulltextName));
            const persistedObservation = readCanonicalJson(path.join(root, names.observationName)).value;
            const comparable = value => { const copy = clone(value); delete copy.fetchedAt; delete copy.observationSha256; return copy; };
            if (!persistedText.equals(Buffer.from(fetched.text, 'utf8'))
                || stableHash(comparable(persistedObservation)) !== stableHash(comparable(fetched.observation))) {
                fail('live official refetch differs from the durable source bundle; create a separately named authority after review');
            }
            const handle = liveProductionHandle(generic);
            return { ...planned, status: 'live-verified', authorityHandle: handle,
                authority: authorityApi.authorityHandleSnapshot(handle) };
        }
        const requestFile = path.join(root, names.requestName); let request;
        if (fs.existsSync(requestFile)) request = validateRequest(readCanonicalJson(requestFile).value, { arxivId, authorityName });
        else {
            request = requestFor({ arxivId, authorityName, operationId: operationId || crypto.randomUUID(), now });
            writeExact(requestFile, prettyBytes(request));
        }
        const observationFile = path.join(root, names.observationName); const fulltextFile = path.join(root, names.fulltextName);
        let observation; let text;
        if (fs.existsSync(observationFile) || fs.existsSync(fulltextFile)) {
            if (!fs.existsSync(observationFile) || !fs.existsSync(fulltextFile)) fail('partial source evidence requires operator review');
            observation = readCanonicalJson(observationFile).value; text = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(fulltextFile));
            if (observation.paperId !== planned.paperId || observation.observationSha256 !== stableHash((({ observationSha256: _, ...body }) => body)(observation))) fail('cached source observation drifted');
        } else {
            const fetched = normalizeFetchedSource(
                await require('../deep-analyzer.js').fetchArxivTextDetailed(arxivId), arxivId, now);
            observation = fetched.observation; text = fetched.text;
            writeExact(observationFile, prettyBytes(observation)); writeExact(fulltextFile, Buffer.from(text, 'utf8'));
        }
        const requestRead = readCanonicalJson(requestFile); const observationRead = readCanonicalJson(observationFile);
        const fulltextBytes = readBytes(fulltextFile); const fulltextSha256 = sha256(fulltextBytes);
        if (fulltextBytes.toString('utf8') !== text) fail('full text is not stable UTF-8');
        const snapshotBody = { contract: SNAPSHOT_CONTRACT, version: VERSION, paperId: planned.paperId, arxivId,
            officialUrl: planned.officialUrl, requestName: names.requestName, requestFileSha256: requestRead.sha256,
            requestSha256: request.requestSha256, observationName: names.observationName,
            observationFileSha256: observationRead.sha256, observationSha256: observation.observationSha256,
            fulltextName: names.fulltextName, fulltextSha256 };
        const sourceSnapshot = seal(snapshotBody, 'snapshotSha256');
        const snapshotFileSha256 = writeExact(path.join(root, names.snapshotName), prettyBytes(sourceSnapshot));
        const receiptBody = { contract: RECEIPT_CONTRACT, version: VERSION, operationId: request.operationId,
            requestName: names.requestName, requestFileSha256: requestRead.sha256, requestSha256: request.requestSha256,
            snapshotName: names.snapshotName, snapshotFileSha256, snapshotSha256: sourceSnapshot.snapshotSha256,
            observationName: names.observationName, observationFileSha256: observationRead.sha256,
            observationSha256: observation.observationSha256, fulltextName: names.fulltextName, fulltextSha256,
            fetcherContract: FETCHER_CONTRACT };
        const receipt = seal(receiptBody, 'receiptSha256');
        const receiptFileSha256 = writeExact(path.join(root, names.receiptName), prettyBytes(receipt));
        const identity = identityFor(arxivId);
        const authorityBody = { contract: authorityApi.CONTRACT, version: authorityApi.VERSION,
            paperId: identity.canonicalId, identity, identitySha256: identityApi.identitySha256(identity),
            identityRecordSha256: identityApi.recordSha256(identity), evidenceKind: 'arxiv-official-fulltext',
            proof: { requestName: names.requestName, requestFileSha256: requestRead.sha256,
                requestSha256: request.requestSha256, observationName: names.observationName,
                observationFileSha256: observationRead.sha256, observationSha256: observation.observationSha256,
                snapshotName: names.snapshotName, snapshotFileSha256, snapshotSha256: sourceSnapshot.snapshotSha256,
                receiptName: names.receiptName, receiptFileSha256, receiptSha256: receipt.receiptSha256,
                fulltextName: names.fulltextName, fulltextSha256 } };
        const authority = seal(authorityBody, 'authoritySha256'); writeExact(authorityFile, prettyBytes(authority));
        const generic = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName });
        const handle = liveProductionHandle(generic);
        return { ...planned, status: 'created', authorityHandle: handle,
            authority: authorityApi.authorityHandleSnapshot(handle) };
    } finally { releaseLock(lock); }
}

module.exports = { REQUEST_CONTRACT, SNAPSHOT_CONTRACT, RECEIPT_CONTRACT, OBSERVATION_CONTRACT,
    FETCHER_CONTRACT, VERSION, SAFE_AUTHORITY_NAME, ArxivSourceAuthorityError, identityFor, namesFor,
    requestFor, validateRequest, normalizeFetchedSource, prepareArxivSourceAuthority,
    productionAuthorityHandleSnapshot, replayProductionAuthorityHandle };
