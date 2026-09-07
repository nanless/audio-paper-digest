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
const LOCK_HEARTBEAT_MS = 30 * 1000;
const LOCK_OWNER_CONTRACT = 'arxiv-source-authority-lock-owner-v1';
const SAFE_AUTHORITY_NAME = /^arxiv-[0-9]{4}\.[0-9]{4,5}(?:-[a-z0-9][a-z0-9._-]{0,80})?\.json$/;
const PRODUCTION_HANDLES = new WeakSet();
const PRODUCTION_HANDLE_DATA = new WeakMap();
const LOCK_HANDLES = new WeakSet();
const LOCK_HANDLE_DATA = new WeakMap();
const STOPPING_LOCK_HANDLES = new WeakSet();
const ACTIVE_LOCK_HANDLES = new Set();
const LOCK_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);
let lockSignalHandlersInstalled = false;
let handlingLockSignal = false;

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
function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
    let optional;
    try {
        optional = clone({
            imageInfos: details.imageInfos === undefined ? [] : details.imageInfos,
            ...(details.readerAuthors === undefined ? {} : { readerAuthors: details.readerAuthors })
        });
    } catch (error) {
        fail(`official fetch returned non-JSON source metadata: ${error.message}`);
    }
    if (!Array.isArray(optional.imageInfos)
        || (optional.readerAuthors !== undefined
            && (!optional.readerAuthors || typeof optional.readerAuthors !== 'object'
                || (Array.isArray(optional.readerAuthors) && optional.readerAuthors.length !== 0)))) {
        fail('official fetch returned malformed image/author source metadata');
    }
    if (Array.isArray(optional.readerAuthors)) delete optional.readerAuthors;
    const sourceDetails = {
        text: details.text,
        source: observation.sourceKind,
        sourceId: observation.sourceId,
        imageInfos: optional.imageInfos,
        ...(optional.readerAuthors === undefined ? {} : { readerAuthors: optional.readerAuthors }),
        htmlAvailability: observation.htmlAvailability,
        htmlAttempts: observation.htmlAttempts,
        warnings: clone(observation.warnings),
        structuredArtifacts: clone(observation.structuredArtifacts)
    };
    return { text: details.text, observation, sourceDetails };
}
function lockOwnerRecord(arxivId, token = crypto.randomUUID()) {
    if (!identityApi.ARXIV_ID_RE.test(String(arxivId || ''))) fail('lock arxivId must be normalized');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) {
        fail('lock token must be a UUID v4');
    }
    const startedAt = new Date().toISOString();
    const body = { contract: LOCK_OWNER_CONTRACT, version: VERSION, arxivId, pid: process.pid,
        hostname: os.hostname(), token, startedAt, leaseMs: LOCK_STALE_MS };
    return { ...body, ownerSha256: stableHash(body) };
}
function validateLockOwner(value, arxivId) {
    const keys = ['contract', 'version', 'arxivId', 'pid', 'hostname', 'token', 'startedAt', 'leaseMs', 'ownerSha256'];
    const body = value && { ...value }; if (body) delete body.ownerSha256;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
        || value.contract !== LOCK_OWNER_CONTRACT || value.version !== VERSION
        || value.arxivId !== arxivId || !Number.isSafeInteger(value.pid) || value.pid < 1
        || typeof value.hostname !== 'string' || !value.hostname || value.hostname.length > 255
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.token || '')
        || Number.isNaN(Date.parse(value.startedAt || ''))
        || new Date(value.startedAt).toISOString() !== value.startedAt
        || value.leaseMs !== LOCK_STALE_MS || value.ownerSha256 !== stableHash(body)) {
        fail('source lock owner evidence is invalid');
    }
    return value;
}
function inspectLockDirectory(lockPath, arxivId, label = 'source operation lock') {
    const directory = fs.lstatSync(lockPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync(lockPath) !== lockPath) {
        fail(`${label} is not a canonical directory`);
    }
    if (process.platform !== 'win32' && (directory.mode & 0o777) !== 0o700) {
        fail(`${label} permissions must be 0700`);
    }
    const entries = fs.readdirSync(lockPath).sort();
    if (entries.length > 1 || entries.length === 1 && entries[0] !== 'owner.json') {
        fail(`${label} contains unexpected entries`);
    }
    if (!entries.length) return { kind: 'empty', lockPath, arxivId, directoryDev: directory.dev,
        directoryIno: directory.ino, directoryMtimeMs: directory.mtimeMs, entries };
    const ownerPath = path.join(lockPath, 'owner.json'); const ownerInfo = fs.lstatSync(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1) {
        fail(`${label} owner is not a private regular file`);
    }
    if (process.platform !== 'win32' && (ownerInfo.mode & 0o777) !== 0o600) {
        fail(`${label} owner permissions must be 0600`);
    }
    let bytes; let record = null;
    try {
        bytes = readBytes(ownerPath, 64 * 1024);
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = JSON.parse(decoded);
        if (!bytes.equals(prettyBytes(parsed))) fail('source lock owner bytes are not canonical');
        record = validateLockOwner(parsed, arxivId);
    } catch (error) {
        if (error instanceof ArxivSourceAuthorityError) {
            try { bytes = bytes || readBytes(ownerPath, 64 * 1024); }
            catch { throw error; }
        } else {
            try { bytes = readBytes(ownerPath, 64 * 1024); }
            catch { throw error; }
        }
    }
    return { kind: record ? 'valid' : 'invalid-owner', lockPath, arxivId,
        directoryDev: directory.dev, directoryIno: directory.ino, directoryMtimeMs: directory.mtimeMs,
        entries, ownerDev: ownerInfo.dev, ownerIno: ownerInfo.ino, ownerMtimeMs: ownerInfo.mtimeMs,
        ownerFileSha256: sha256(bytes), record };
}
function sameLockSnapshot(left, right, { includeLeaseMtime = false } = {}) {
    return left.kind === right.kind && left.lockPath === right.lockPath
        && left.directoryDev === right.directoryDev && left.directoryIno === right.directoryIno
        && (!includeLeaseMtime || left.directoryMtimeMs === right.directoryMtimeMs)
        && JSON.stringify(left.entries) === JSON.stringify(right.entries)
        && left.ownerDev === right.ownerDev && left.ownerIno === right.ownerIno
        && (!includeLeaseMtime || left.ownerMtimeMs === right.ownerMtimeMs)
        && left.ownerFileSha256 === right.ownerFileSha256
        && (left.record?.ownerSha256 || null) === (right.record?.ownerSha256 || null);
}
function lockSnapshotIsStale(snapshot, now = Date.now()) {
    const heartbeat = Math.max(snapshot.directoryMtimeMs, snapshot.ownerMtimeMs || 0);
    return now - heartbeat >= LOCK_STALE_MS;
}
function lockSnapshotIsReclaimable(snapshot, dependencies = {}) {
    const now = dependencies.nowMs ? dependencies.nowMs() : Date.now();
    if (!lockSnapshotIsStale(snapshot, now)) return false;
    if (snapshot.kind !== 'valid') return true;
    if (snapshot.record.hostname !== os.hostname()) return true;
    const processKill = dependencies.processKill || process.kill.bind(process);
    try {
        processKill(snapshot.record.pid, 0);
        return false;
    } catch (error) {
        // EPERM proves that a process occupies the PID even though we cannot
        // signal it.  Only ESRCH is positive evidence that the local owner is
        // gone; every other platform error fails closed.
        return error?.code === 'ESRCH';
    }
}
function removeExactLockDirectory(snapshot, label, options = {}) {
    options.beforeInspect?.(snapshot, label);
    const current = inspectLockDirectory(snapshot.lockPath, snapshot.arxivId, label);
    if (!sameLockSnapshot(snapshot, current, { includeLeaseMtime: options.includeLeaseMtime === true })) {
        fail(`${label} changed before removal`);
    }
    if (options.requireReclaimable === true
        && !lockSnapshotIsReclaimable(current, options.dependencies || {})) {
        fail(`${label} renewed or has a live local owner before removal`);
    }
    if (current.entries.length === 1) fs.unlinkSync(path.join(current.lockPath, 'owner.json'));
    fs.rmdirSync(current.lockPath); syncDirectory(path.dirname(current.lockPath));
}
function writeLockOwner(ownerPath, bytes, dependencies = {}) {
    const io = dependencies.io || fs; const payload = Buffer.from(bytes); let fd; let created;
    try {
        fd = io.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = (io.fstatSync || fs.fstatSync)(fd, { bigint: true }); let offset = 0;
        while (offset < payload.length) {
            const written = io.writeSync(fd, payload, offset, payload.length - offset, offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) {
                fail('short source lock owner write');
            }
            offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    } catch (error) {
        if (fd !== undefined) { try { io.closeSync(fd); } finally { fd = undefined; } }
        if (created) {
            try {
                const named = fs.lstatSync(ownerPath, { bigint: true });
                if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1n
                    && named.dev === created.dev && named.ino === created.ino) fs.unlinkSync(ownerPath);
            } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
        throw error;
    } finally { if (fd !== undefined) io.closeSync(fd); }
    syncDirectory(path.dirname(ownerPath));
}
function createLockDirectory(lockPath, arxivId, dependencies = {}) {
    fs.mkdirSync(lockPath, { mode: 0o700 }); const owner = lockOwnerRecord(arxivId);
    try { writeLockOwner(path.join(lockPath, 'owner.json'), prettyBytes(owner), dependencies); }
    catch (error) {
        try { if (fs.readdirSync(lockPath).length === 0) fs.rmdirSync(lockPath); } catch {}
        throw error;
    }
    return inspectLockDirectory(lockPath, arxivId);
}
function clearOrRejectReclaimMarker(reclaimPath, arxivId, dependencies = {}) {
    let marker;
    try { marker = inspectLockDirectory(reclaimPath, arxivId, 'source lock reclaim marker'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!lockSnapshotIsReclaimable(marker, dependencies)) fail(`source lock reclaim is active: ${arxivId}`);
    removeExactLockDirectory(marker, 'source lock reclaim marker', {
        includeLeaseMtime: true, requireReclaimable: true, dependencies
    });
}
function uninstallLockSignalHandlers() {
    if (!lockSignalHandlersInstalled) return;
    for (const signal of LOCK_SIGNALS) process.removeListener(signal, handleLockSignal);
    lockSignalHandlersInstalled = false;
}
function handleLockSignal(signal) {
    if (handlingLockSignal) return;
    handlingLockSignal = true;
    const otherListeners = process.listeners(signal).filter(listener => listener !== handleLockSignal);
    for (const handle of [...ACTIVE_LOCK_HANDLES]) {
        STOPPING_LOCK_HANDLES.add(handle);
        const state = LOCK_HANDLE_DATA.get(handle);
        // With a caller-owned handler an asynchronous fetch may continue after
        // this callback.  Retain its lock until the operation observes the
        // stopping flag and unwinds; idle/raw handles are safe to release now.
        if (otherListeners.length && state?.operationActive) continue;
        try { releaseLock(handle); }
        catch (error) { try { process.stderr.write(`[arxiv-source-lock] ${signal} cleanup refused: ${error.message}\n`); } catch {} }
    }
    uninstallLockSignalHandlers(); handlingLockSignal = false;
    if (!otherListeners.length) setImmediate(() => process.kill(process.pid, signal));
}
function installLockSignalHandlers() {
    if (lockSignalHandlersInstalled) return;
    // Run before caller-installed once/on handlers so their presence remains
    // observable and cleanup never re-emits a signal they intended to handle.
    for (const signal of LOCK_SIGNALS) process.prependListener(signal, handleLockSignal);
    lockSignalHandlersInstalled = true;
}
function startLockHeartbeat(handle) {
    const timer = setInterval(() => {
        const expected = LOCK_HANDLE_DATA.get(handle); if (!expected) return clearInterval(timer);
        try {
            const current = inspectLockDirectory(expected.lockPath, expected.arxivId);
            if (!sameLockSnapshot(expected.snapshot, current)) return clearInterval(timer);
            const now = new Date(); fs.utimesSync(path.join(expected.lockPath, 'owner.json'), now, now);
        } catch { clearInterval(timer); }
    }, LOCK_HEARTBEAT_MS);
    timer.unref?.(); return timer;
}
function acquireLock(root, arxivId, dependencies = {}) {
    const lockPath = path.join(root, `.arxiv-${arxivId}.lock`);
    const reclaimPath = `${lockPath}.reclaim`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        clearOrRejectReclaimMarker(reclaimPath, arxivId, dependencies);
        try {
            const snapshot = createLockDirectory(lockPath, arxivId, dependencies);
            const handle = Object.freeze(Object.create(null)); LOCK_HANDLES.add(handle);
            LOCK_HANDLE_DATA.set(handle, { lockPath, arxivId, snapshot, heartbeat: null,
                operationActive: false });
            LOCK_HANDLE_DATA.get(handle).heartbeat = startLockHeartbeat(handle);
            ACTIVE_LOCK_HANDLES.add(handle); installLockSignalHandlers(); return handle;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stale = inspectLockDirectory(lockPath, arxivId);
        if (!lockSnapshotIsReclaimable(stale, dependencies)) fail(`source operation is locked: ${arxivId}`);
        let reclaim;
        try { reclaim = createLockDirectory(reclaimPath, arxivId, dependencies); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try {
            let current;
            try { current = inspectLockDirectory(lockPath, arxivId); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!sameLockSnapshot(stale, current, { includeLeaseMtime: true })
                || !lockSnapshotIsReclaimable(current, dependencies)) {
                fail('source operation lock changed during stale reclaim');
            }
            removeExactLockDirectory(current, 'source operation lock', {
                includeLeaseMtime: true,
                requireReclaimable: true,
                dependencies,
                beforeInspect: dependencies.beforeReclaimRemoval
            });
        } finally { removeExactLockDirectory(reclaim, 'source lock reclaim marker'); }
    }
    fail(`source lock acquisition exceeded bounded reclaim attempts: ${arxivId}`);
}
function beginLockOperation(handle) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) {
        fail('authenticated source lock handle required');
    }
    LOCK_HANDLE_DATA.get(handle).operationActive = true;
}
function assertLockWritable(handle) {
    if (STOPPING_LOCK_HANDLES.has(handle)) fail('source operation is stopping after process signal');
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) {
        fail('source operation lock is no longer held');
    }
}
function releaseLock(handle) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) fail('authenticated source lock handle required');
    const expected = LOCK_HANDLE_DATA.get(handle); const current = inspectLockDirectory(expected.lockPath, expected.arxivId);
    if (!sameLockSnapshot(expected.snapshot, current) || current.record?.token !== expected.snapshot.record?.token
        || current.record?.pid !== process.pid || current.record?.hostname !== os.hostname()) {
        fail('source operation lock changed while held');
    }
    clearInterval(expected.heartbeat); removeExactLockDirectory(current, 'source operation lock');
    ACTIVE_LOCK_HANDLES.delete(handle); LOCK_HANDLES.delete(handle); LOCK_HANDLE_DATA.delete(handle);
    if (ACTIVE_LOCK_HANDLES.size === 0 && !handlingLockSignal) setImmediate(() => {
        if (ACTIVE_LOCK_HANDLES.size === 0 && !handlingLockSignal) uninstallLockSignalHandlers();
    });
}

function liveProductionHandle(genericHandle, sourceDetails) {
    const base = authorityApi.authorityHandleSnapshot(genericHandle);
    const publicSnapshot = Object.freeze({ ...clone(base), productionAuthorized: true });
    const handle = Object.freeze(Object.create(null));
    const details = clone(sourceDetails);
    if (sha256(Buffer.from(details.text, 'utf8')) !== publicSnapshot.fulltextSha256
        || details.structuredArtifacts?.flattenedTextSha256 !== publicSnapshot.fulltextSha256
        || details.sourceId.replace(/v\d+$/i, '') !== publicSnapshot.authority.identity.arxivId) {
        fail('live official source details do not replay the authority evidence');
    }
    PRODUCTION_HANDLES.add(handle); PRODUCTION_HANDLE_DATA.set(handle,
        Object.freeze({ genericHandle, publicSnapshot, sourceDetails: Object.freeze(details) }));
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

function readLiveProductionSourceDetails(handle) {
    if (!replayProductionAuthorityHandle(handle)) fail('live production-authorized arXiv source handle required');
    const stored = PRODUCTION_HANDLE_DATA.get(handle);
    const details = clone(stored.sourceDetails);
    if (sha256(Buffer.from(details.text, 'utf8')) !== stored.publicSnapshot.fulltextSha256
        || details.structuredArtifacts?.flattenedTextSha256 !== stored.publicSnapshot.fulltextSha256) {
        fail('live source details changed after official fetch');
    }
    return details;
}

async function prepareArxivSourceAuthority({ authorityRoot, arxivId, authorityName,
    apply = false, now, operationId, requireLiveAuthorization = false } = {}) {
    const root = safeRoot(authorityRoot, apply); const names = namesFor(authorityName, arxivId);
    const planned = { status: 'dry-run', arxivId, paperId: `arxiv:${arxivId}`, authorityName,
        officialUrl: `https://arxiv.org/abs/${arxivId}`, artifacts: clone(names) };
    if (!apply) return planned;
    const lock = acquireLock(root, arxivId);
    beginLockOperation(lock);
    const writeArtifact = (filename, bytes) => {
        assertLockWritable(lock);
        return writeExact(filename, bytes);
    };
    try {
        assertLockWritable(lock);
        const authorityFile = path.join(root, authorityName);
        if (fs.existsSync(authorityFile)) {
            const generic = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName });
            const snapshot = authorityApi.authorityHandleSnapshot(generic);
            if (snapshot.authority.paperId !== planned.paperId) fail('existing authority belongs to another arXiv source');
            if (!requireLiveAuthorization) return { ...planned, status: 'recovered', authorityHandle: generic, authority: snapshot };
            const fetched = normalizeFetchedSource(
                await require('../deep-analyzer.js').fetchArxivTextDetailedUncached(arxivId), arxivId, now);
            assertLockWritable(lock);
            const persistedText = readBytes(path.join(root, names.fulltextName));
            const persistedObservation = readCanonicalJson(path.join(root, names.observationName)).value;
            const comparable = value => { const copy = clone(value); delete copy.fetchedAt; delete copy.observationSha256; return copy; };
            if (!persistedText.equals(Buffer.from(fetched.text, 'utf8'))
                || stableHash(comparable(persistedObservation)) !== stableHash(comparable(fetched.observation))) {
                fail('live official refetch differs from the durable source bundle; create a separately named authority after review');
            }
            const handle = liveProductionHandle(generic, fetched.sourceDetails);
            return { ...planned, status: 'live-verified', authorityHandle: handle,
                authority: authorityApi.authorityHandleSnapshot(handle) };
        }
        const requestFile = path.join(root, names.requestName); let request;
        if (fs.existsSync(requestFile)) request = validateRequest(readCanonicalJson(requestFile).value, { arxivId, authorityName });
        else {
            request = requestFor({ arxivId, authorityName, operationId: operationId || crypto.randomUUID(), now });
            writeArtifact(requestFile, prettyBytes(request));
        }
        const observationFile = path.join(root, names.observationName); const fulltextFile = path.join(root, names.fulltextName);
        let observation; let text; let liveSourceDetails = null;
        if (fs.existsSync(observationFile) || fs.existsSync(fulltextFile)) {
            if (!fs.existsSync(observationFile) || !fs.existsSync(fulltextFile)) fail('partial source evidence requires operator review');
            observation = readCanonicalJson(observationFile).value; text = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(fulltextFile));
            if (observation.paperId !== planned.paperId || observation.observationSha256 !== stableHash((({ observationSha256: _, ...body }) => body)(observation))) fail('cached source observation drifted');
        } else {
            const fetched = normalizeFetchedSource(
                await require('../deep-analyzer.js').fetchArxivTextDetailedUncached(arxivId), arxivId, now);
            assertLockWritable(lock);
            observation = fetched.observation; text = fetched.text; liveSourceDetails = fetched.sourceDetails;
            writeArtifact(observationFile, prettyBytes(observation));
            writeArtifact(fulltextFile, Buffer.from(text, 'utf8'));
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
        const snapshotFileSha256 = writeArtifact(path.join(root, names.snapshotName), prettyBytes(sourceSnapshot));
        const receiptBody = { contract: RECEIPT_CONTRACT, version: VERSION, operationId: request.operationId,
            requestName: names.requestName, requestFileSha256: requestRead.sha256, requestSha256: request.requestSha256,
            snapshotName: names.snapshotName, snapshotFileSha256, snapshotSha256: sourceSnapshot.snapshotSha256,
            observationName: names.observationName, observationFileSha256: observationRead.sha256,
            observationSha256: observation.observationSha256, fulltextName: names.fulltextName, fulltextSha256,
            fetcherContract: FETCHER_CONTRACT };
        const receipt = seal(receiptBody, 'receiptSha256');
        const receiptFileSha256 = writeArtifact(path.join(root, names.receiptName), prettyBytes(receipt));
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
        const authority = seal(authorityBody, 'authoritySha256'); writeArtifact(authorityFile, prettyBytes(authority));
        const generic = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName });
        if (!liveSourceDetails && requireLiveAuthorization) {
            const fetched = normalizeFetchedSource(
                await require('../deep-analyzer.js').fetchArxivTextDetailedUncached(arxivId), arxivId, now);
            assertLockWritable(lock);
            const comparable = value => { const copy = clone(value); delete copy.fetchedAt; delete copy.observationSha256; return copy; };
            if (!fulltextBytes.equals(Buffer.from(fetched.text, 'utf8'))
                || stableHash(comparable(observation)) !== stableHash(comparable(fetched.observation))) {
                fail('live official refetch differs from the recovered durable source bundle');
            }
            liveSourceDetails = fetched.sourceDetails;
        }
        const handle = liveSourceDetails ? liveProductionHandle(generic, liveSourceDetails) : generic;
        return { ...planned, status: 'created', authorityHandle: handle,
            authority: authorityApi.authorityHandleSnapshot(handle) };
    } finally { if (LOCK_HANDLES.has(lock)) releaseLock(lock); }
}

module.exports = { REQUEST_CONTRACT, SNAPSHOT_CONTRACT, RECEIPT_CONTRACT, OBSERVATION_CONTRACT,
    FETCHER_CONTRACT, LOCK_OWNER_CONTRACT, LOCK_STALE_MS, VERSION, SAFE_AUTHORITY_NAME,
    ArxivSourceAuthorityError, identityFor, namesFor,
    requestFor, validateRequest, normalizeFetchedSource, prepareArxivSourceAuthority,
    lockOwnerRecord, inspectLockDirectory, sameLockSnapshot, lockSnapshotIsStale,
    lockSnapshotIsReclaimable,
    acquireLock, releaseLock,
    productionAuthorityHandleSnapshot, replayProductionAuthorityHandle, readLiveProductionSourceDetails };
