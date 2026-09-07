'use strict';

// This is an identity authority, not a paper-source authority. It binds a
// frozen historical arXiv hint to a retained filtered-papers record and never
// exposes full text, tables, formulas, figures, or Reader capabilities.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');

const CONTRACT = 'historical-archive-crawl-identity-authority-v1';
const VERSION = 1;
const EVIDENCE_KIND = 'archive-crawl-identity';
const AUTHORITY_PREFIX = 'archive-crawl-arxiv-';
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_FILTERED_BYTES = 64 * 1024 * 1024;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();

class HistoricalArchiveCrawlAuthorityError extends Error {
    constructor(message) {
        super(`Historical archive crawl identity authority rejected: ${message}`);
        this.name = 'HistoricalArchiveCrawlAuthorityError';
        this.code = 'HISTORICAL_ARCHIVE_CRAWL_AUTHORITY_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalArchiveCrawlAuthorityError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
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
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a SHA-256`); return value; }
function safeDirectory(directory, label, { create = false } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be an absolute directory`);
    const resolved = path.resolve(directory);
    if (!fs.existsSync(resolved)) {
        if (!create) fail(`${label} does not exist`);
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    const info = fs.lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`);
    return resolved;
}
function safeDataPath(dataRoot, relativePath) {
    if (!/^archive\/\d{4}-\d{2}-\d{2}\/filtered-papers\.json$/.test(String(relativePath || ''))) {
        fail('archive crawl pointer is not an approved retained filtered snapshot');
    }
    const root = safeDirectory(dataRoot, 'dataRoot'); const filename = path.resolve(root, relativePath);
    if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.resolve(root, path.dirname(relativePath))) {
        fail('archive crawl pointer escapes dataRoot');
    }
    const parent = path.dirname(filename);
    if (fs.realpathSync(parent) !== parent) fail('archive crawl pointer parent is unsafe');
    return filename;
}
function readRetainedFilteredFile(dataRoot, relativePath) {
    const filename = safeDataPath(dataRoot, relativePath); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_FILTERED_BYTES) {
            fail('retained filtered snapshot is unsafe or too large');
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail('retained filtered snapshot changed while read');
        }
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail('retained filtered snapshot is not strict UTF-8 JSON'); }
        if (!plain(value) || !Array.isArray(value.papers)) fail('retained filtered snapshot lacks a papers array');
        return { relativePath, bytes, fileSha256: sha256(bytes), papers: value.papers };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function normalizedArxivId(record) {
    if (!plain(record)) return null;
    const arxivId = String(record.arxivId || '').replace(/v\d+$/i, '');
    const paperId = String(record.paper_id || '').replace(/v\d+$/i, '');
    if (!identityApi.ARXIV_ID_RE.test(arxivId) || arxivId !== paperId) return null;
    if (Object.keys(record).some(key => /^(?:analysis(?:$|Checkpoint|Manifest|Stage|Recovery)|parsed$|apiReader|freshRewrite|freshSource)/.test(key))) return null;
    return arxivId;
}
function retainedFilteredPaths(dataRoot) {
    const root = safeDirectory(dataRoot, 'dataRoot'); const paths = [];
    const archive = path.join(root, 'archive'); const archiveInfo = fs.lstatSync(archive, { throwIfNoEntry: false });
    if (archiveInfo) {
        if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink() || fs.realpathSync(archive) !== archive) fail('archive directory is unsafe');
        for (const item of fs.readdirSync(archive).sort()) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(item)) continue;
            const directory = path.join(archive, item); const info = fs.lstatSync(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail(`archive date directory is unsafe: ${item}`);
            if (fs.existsSync(path.join(directory, 'filtered-papers.json'))) paths.push(`archive/${item}/filtered-papers.json`);
        }
    }
    return paths;
}
function scanRetainedFilteredPapers({ dataRoot } = {}) {
    const matches = new Map(); const files = [];
    for (const relativePath of retainedFilteredPaths(dataRoot)) {
        const loaded = readRetainedFilteredFile(dataRoot, relativePath); files.push({ relativePath, fileSha256: loaded.fileSha256 });
        loaded.papers.forEach((record, recordIndex) => {
            const arxivId = normalizedArxivId(record); if (!arxivId) return;
            const item = { arxivId, archiveRelativePath: relativePath, archiveFileSha256: loaded.fileSha256,
                recordIndex, record: clone(record), recordSha256: stableHash(record) };
            const values = matches.get(arxivId) || []; values.push(item); matches.set(arxivId, values);
        });
    }
    for (const values of matches.values()) values.sort((left, right) => left.archiveRelativePath.localeCompare(right.archiveRelativePath)
        || left.recordIndex - right.recordIndex || left.recordSha256.localeCompare(right.recordSha256));
    return { files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)), matches };
}
function authorityNameFor(arxivId, match) {
    if (!identityApi.ARXIV_ID_RE.test(String(arxivId || '')) || !match || match.arxivId !== arxivId
        || !SHA_RE.test(String(match.archiveFileSha256 || '')) || !SHA_RE.test(String(match.recordSha256 || ''))
        || typeof match.archiveRelativePath !== 'string' || !Number.isSafeInteger(match.recordIndex) || match.recordIndex < 0) {
        fail('arXiv ID and archive record pointer must be normalized');
    }
    const pointerSha256 = stableHash({ archiveRelativePath: match.archiveRelativePath, archiveFileSha256: match.archiveFileSha256,
        recordIndex: match.recordIndex, recordSha256: match.recordSha256 });
    return `${AUTHORITY_PREFIX}${arxivId}-${pointerSha256}.json`;
}
function normalizeRecord(record, expectedId) {
    if (!plain(record) || normalizedArxivId(record) !== expectedId) fail('archive crawl record does not bind the expected arXiv ID');
    return clone(record);
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'evidenceKind',
        'archiveRelativePath', 'archiveFileSha256', 'recordIndex', 'record', 'recordSha256', 'authoritySha256'],
    'archive crawl identity authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || value.evidenceKind !== EVIDENCE_KIND
        || !Number.isSafeInteger(value.recordIndex) || value.recordIndex < 0
        || !/^archive\/\d{4}-\d{2}-\d{2}\/filtered-papers\.json$/.test(String(value.archiveRelativePath || ''))) {
        fail('archive crawl identity authority contract is invalid');
    }
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(error.message); }
    if (identity.kind !== 'arxiv' || identity.citation !== null || value.paperId !== identity.canonicalId
        || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity)
        || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) fail('archive crawl identity binding is invalid');
    const record = normalizeRecord(value.record, identity.arxivId);
    if (sha(value.archiveFileSha256, 'archiveFileSha256') !== value.archiveFileSha256
        || sha(value.recordSha256, 'recordSha256') !== stableHash(record)) fail('archive crawl record SHA binding is invalid');
    const body = { ...clone(value), identity, record }; delete body.authoritySha256;
    if (sha(value.authoritySha256, 'authoritySha256') !== stableHash(body)) fail('archive crawl authority self-SHA drifted');
    return { ...body, authoritySha256: value.authoritySha256 };
}
function verifyMatchAgainstRetained({ dataRoot, match }) {
    if (!match || typeof match !== 'object' || !identityApi.ARXIV_ID_RE.test(String(match.arxivId || ''))
        || typeof match.archiveRelativePath !== 'string' || !Number.isSafeInteger(match.recordIndex) || match.recordIndex < 0
        || !SHA_RE.test(String(match.archiveFileSha256 || '')) || !SHA_RE.test(String(match.recordSha256 || ''))) fail('archive crawl match is malformed');
    const loaded = readRetainedFilteredFile(dataRoot, match.archiveRelativePath); const record = loaded.papers[match.recordIndex];
    if (loaded.fileSha256 !== match.archiveFileSha256 || normalizedArxivId(record) !== match.arxivId
        || stableHash(record) !== match.recordSha256) fail('retained filtered snapshot no longer matches the selected identity record');
    return { arxivId: match.arxivId, archiveRelativePath: match.archiveRelativePath, archiveFileSha256: loaded.fileSha256,
        recordIndex: match.recordIndex, record: clone(record), recordSha256: match.recordSha256 };
}
function identityFor(arxivId) {
    return identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'arxiv', canonicalId: `arxiv:${arxivId}`,
        arxivId, conference: null, externalId: null, source: { status: 'official', url: `https://arxiv.org/abs/${arxivId}` }, citation: null });
}
function authorityFor(match) {
    const identity = identityFor(match.arxivId);
    const body = { contract: CONTRACT, version: VERSION, paperId: identity.canonicalId, identity,
        identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity),
        evidenceKind: EVIDENCE_KIND, archiveRelativePath: match.archiveRelativePath, archiveFileSha256: match.archiveFileSha256,
        recordIndex: match.recordIndex, record: match.record, recordSha256: match.recordSha256 };
    return { ...body, authoritySha256: stableHash(body) };
}
function readAuthority(identityRoot, authorityName) {
    const root = safeDirectory(identityRoot, 'archiveIdentityRoot');
    if (!SAFE_JSON_NAME.test(String(authorityName || ''))) fail('authorityName is unsafe');
    const filename = path.resolve(root, authorityName); if (path.dirname(filename) !== root) fail('authorityName escapes archiveIdentityRoot');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) fail('archive identity authority is unsafe');
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) fail('archive identity authority changed while read');
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail('archive identity authority is not strict UTF-8 JSON'); }
        const normalized = normalizeAuthority(value);
        if (!bytes.equals(prettyBytes(normalized))) fail('archive identity authority bytes are not canonical');
        return { filename: fs.realpathSync(filename), bytes, sha256: sha256(bytes), authority: normalized, dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExact(identityRoot, authorityName, bytes) {
    const root = safeDirectory(identityRoot, 'archiveIdentityRoot', { create: true }); const filename = path.join(root, authorityName); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.readFileSync(filename).equals(bytes)) fail(`refuses to overwrite different immutable identity authority: ${authorityName}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function authorityHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated archive crawl identity handle required');
    return clone(HANDLE_DATA.get(handle).public);
}
function loadArchiveCrawlAuthorityHandle({ identityRoot, dataRoot, authorityName } = {}) {
    const loaded = readAuthority(identityRoot, authorityName);
    verifyMatchAgainstRetained({ dataRoot, match: { arxivId: loaded.authority.identity.arxivId,
        archiveRelativePath: loaded.authority.archiveRelativePath, archiveFileSha256: loaded.authority.archiveFileSha256,
        recordIndex: loaded.authority.recordIndex, recordSha256: loaded.authority.recordSha256 } });
    const handle = Object.freeze(Object.create(null)); HANDLES.add(handle);
    HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(loaded.authority), authorityName,
        authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true }),
    identityRoot: safeDirectory(identityRoot, 'archiveIdentityRoot'), dataRoot: safeDirectory(dataRoot, 'dataRoot'),
    authorityFileDev: loaded.dev, authorityFileIno: loaded.ino }));
    return handle;
}
function replayAuthorityHandle(handle, { requireProduction = false } = {}) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated archive crawl identity handle required');
    const original = HANDLE_DATA.get(handle);
    if (requireProduction && original.public.productionAuthorized !== true) fail('production-authorized archive crawl identity handle required');
    const loaded = readAuthority(original.identityRoot, original.public.authorityName);
    verifyMatchAgainstRetained({ dataRoot: original.dataRoot, match: { arxivId: loaded.authority.identity.arxivId,
        archiveRelativePath: loaded.authority.archiveRelativePath, archiveFileSha256: loaded.authority.archiveFileSha256,
        recordIndex: loaded.authority.recordIndex, recordSha256: loaded.authority.recordSha256 } });
    const current = { authority: loaded.authority, authorityName: original.public.authorityName, authorityFile: loaded.filename,
        authorityFileSha256: loaded.sha256, productionAuthorized: true };
    if (loaded.dev !== original.authorityFileDev || loaded.ino !== original.authorityFileIno || stableHash(current) !== stableHash(original.public)) fail('archive crawl identity authority or retained evidence changed after handle creation');
    return handle;
}
function prepareArchiveCrawlAuthority({ identityRoot, dataRoot, arxivId, match, apply = false } = {}) {
    if (!match || match.arxivId !== arxivId) fail('selected archive match must bind the requested arXiv ID');
    const authorityName = authorityNameFor(arxivId, match);
    if (!apply) return { status: 'dry-run', paperId: `arxiv:${arxivId}`, arxivId, authorityName };
    const retained = verifyMatchAgainstRetained({ dataRoot, match });
    if (retained.arxivId !== arxivId) fail('selected archive record belongs to another arXiv ID');
    const authority = authorityFor(retained); const bytes = prettyBytes(authority); const filename = path.join(path.resolve(identityRoot), authorityName);
    const existed = fs.existsSync(filename); writeExact(identityRoot, authorityName, bytes);
    const loaded = readAuthority(identityRoot, authorityName);
    verifyMatchAgainstRetained({ dataRoot, match: { arxivId, archiveRelativePath: loaded.authority.archiveRelativePath,
        archiveFileSha256: loaded.authority.archiveFileSha256, recordIndex: loaded.authority.recordIndex,
        recordSha256: loaded.authority.recordSha256 } });
    const handle = loadArchiveCrawlAuthorityHandle({ identityRoot, dataRoot, authorityName });
    return { status: existed ? 'recovered' : 'created', paperId: `arxiv:${arxivId}`, arxivId, authorityName, authorityHandle: handle, retained };
}

module.exports = { CONTRACT, VERSION, EVIDENCE_KIND, AUTHORITY_PREFIX, SAFE_JSON_NAME, HistoricalArchiveCrawlAuthorityError,
    stableHash, prettyBytes, safeDirectory, readRetainedFilteredFile, normalizedArxivId, retainedFilteredPaths,
    scanRetainedFilteredPapers, authorityNameFor, normalizeAuthority, verifyMatchAgainstRetained,
    prepareArchiveCrawlAuthority, loadArchiveCrawlAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
