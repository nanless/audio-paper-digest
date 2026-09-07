'use strict';

// Identity-only authority for retained local crawler inputs. It reads stable
// arXiv IDs and input hashes only; crawler text and generated fields are never
// copied into an authority or used for matching.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');
const legacyArchiveApi = require('./historical-archive-crawl-authority.js');

const CONTRACT = 'historical-local-crawl-identity-authority-v1';
const SNAPSHOT_CONTRACT = 'historical-local-crawl-current-identity-snapshot-v1';
const VERSION = 1;
const EVIDENCE_KIND = 'local-crawl-identity';
const AUTHORITY_PREFIX = 'local-crawl-arxiv-';
const SNAPSHOT_PREFIX = 'current-papers-identity-';
const LEGACY_CONTRACT = legacyArchiveApi.CONTRACT;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CURRENT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();

class HistoricalLocalCrawlAuthorityError extends Error {
    constructor(message) {
        super(`Historical local crawl identity authority rejected: ${message}`);
        this.name = 'HistoricalLocalCrawlAuthorityError';
        this.code = 'HISTORICAL_LOCAL_CRAWL_AUTHORITY_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalLocalCrawlAuthorityError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unknown or missing fields`);
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
    if (!fs.existsSync(resolved)) { if (!create) fail(`${label} does not exist`); fs.mkdirSync(resolved, { recursive: true, mode: 0o700 }); }
    const info = fs.lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`);
    return resolved;
}
function sourceSpec(relativePath) {
    if (/^archive\/\d{4}-\d{2}-\d{2}\/filtered-papers\.json$/.test(String(relativePath || ''))) return { sourceKind: 'archive', format: 'array', maximum: MAX_ARCHIVE_BYTES };
    if (relativePath === 'current/papers.json') return { sourceKind: 'current', format: 'map', maximum: MAX_CURRENT_BYTES };
    fail('local crawl pointer is not an approved crawler snapshot');
}
function safeDataPath(dataRoot, relativePath) {
    sourceSpec(relativePath);
    const root = safeDirectory(dataRoot, 'dataRoot'); const filename = path.resolve(root, relativePath);
    if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.resolve(root, path.dirname(relativePath))) fail('local crawl pointer escapes dataRoot');
    if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) fail('local crawl pointer parent is unsafe');
    return filename;
}
function readJsonFile(filename, maximum, label) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maximum) fail(`${label} is unsafe or too large`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} changed while read`);
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(`${label} is not strict UTF-8 JSON`); }
        if (!plain(value)) fail(`${label} must contain a JSON object`);
        return { bytes, fileSha256: sha256(bytes), value, dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function canonicalArxivId(value) { const id = String(value || '').replace(/v\d+$/i, ''); return identityApi.ARXIV_ID_RE.test(id) ? id : null; }
function identityForArchiveRecord(record) {
    if (!plain(record)) return null; const arxivId = canonicalArxivId(record.arxivId); const paperId = canonicalArxivId(record.paper_id);
    return arxivId && arxivId === paperId ? { arxivId, paperId: arxivId } : null;
}
function identityForCurrentRecord(mapKey, record) {
    if (!plain(record)) return null; const arxivId = canonicalArxivId(record.arxivId); const keyId = canonicalArxivId(mapKey);
    return arxivId && keyId && arxivId === keyId ? { arxivId, paperId: arxivId } : null;
}
function pointerForArray(index) { return { kind: 'array-index', value: index }; }
function pointerForMap(key) { return { kind: 'map-key', value: key }; }
function normalizePointer(value, sourceKind, label) {
    exact(value, ['kind', 'value'], label);
    if (sourceKind === 'archive') {
        if (value.kind !== 'array-index' || !Number.isSafeInteger(value.value) || value.value < 0) fail(`${label} is invalid for archive source`);
    } else if (sourceKind === 'current') {
        if (value.kind !== 'map-key' || canonicalArxivId(value.value) !== value.value) fail(`${label} is invalid for current source`);
    } else fail(`${label} source kind is unsupported`);
    return clone(value);
}
function recordsFor(value, spec) {
    if (spec.format === 'array') {
        if (!Array.isArray(value.papers)) fail('archive crawler snapshot lacks a papers array');
        return value.papers.map((record, index) => ({ pointer: pointerForArray(index), identity: identityForArchiveRecord(record) }));
    }
    if (!plain(value.papers)) fail('current crawler library lacks a papers object map');
    return Object.keys(value.papers).sort().map(key => ({ pointer: pointerForMap(key), identity: identityForCurrentRecord(key, value.papers[key]) }));
}
function readLocalCrawlFile(dataRoot, relativePath) {
    const spec = sourceSpec(relativePath); const loaded = readJsonFile(safeDataPath(dataRoot, relativePath), spec.maximum, 'local crawler snapshot');
    return { relativePath, sourceKind: spec.sourceKind, bytes: loaded.bytes, fileSha256: loaded.fileSha256, records: recordsFor(loaded.value, spec) };
}
function archivedFilteredPaths(dataRoot) {
    const root = safeDirectory(dataRoot, 'dataRoot'); const archive = path.join(root, 'archive'); const info = fs.lstatSync(archive, { throwIfNoEntry: false }); const paths = [];
    if (!info) return paths;
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(archive) !== archive) fail('archive directory is unsafe');
    for (const date of fs.readdirSync(archive).sort()) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const directory = path.join(archive, date); const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail(`archive date directory is unsafe: ${date}`);
        if (fs.existsSync(path.join(directory, 'filtered-papers.json'))) paths.push(`archive/${date}/filtered-papers.json`);
    }
    return paths;
}
function localCrawlPaths(dataRoot) {
    const root = safeDirectory(dataRoot, 'dataRoot'); const paths = archivedFilteredPaths(root);
    if (fs.existsSync(path.join(root, 'current', 'papers.json'))) paths.push('current/papers.json');
    return paths;
}
function scanLocalCrawlPapers({ dataRoot } = {}) {
    const matches = new Map(); const files = [];
    for (const relativePath of localCrawlPaths(dataRoot)) {
        const loaded = readLocalCrawlFile(dataRoot, relativePath); files.push({ relativePath, sourceKind: loaded.sourceKind, fileSha256: loaded.fileSha256 });
        for (const entry of loaded.records) {
            if (!entry.identity) continue;
            const match = { arxivId: entry.identity.arxivId, sourceKind: loaded.sourceKind, sourceRelativePath: relativePath, sourceFileSha256: loaded.fileSha256,
                recordPointer: entry.pointer, recordIdentity: entry.identity, recordIdentitySha256: stableHash(entry.identity) };
            const list = matches.get(match.arxivId) || []; list.push(match); matches.set(match.arxivId, list);
        }
    }
    for (const list of matches.values()) list.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath) || stableHash(a.recordPointer).localeCompare(stableHash(b.recordPointer)));
    return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), matches };
}
function authorityNameFor(arxivId, match) {
    if (!identityApi.ARXIV_ID_RE.test(String(arxivId || '')) || !match || match.arxivId !== arxivId || !['archive', 'current'].includes(match.sourceKind)
        || sourceSpec(match.sourceRelativePath).sourceKind !== match.sourceKind || !SHA_RE.test(String(match.sourceFileSha256 || '')) || !SHA_RE.test(String(match.recordIdentitySha256 || ''))) fail('arXiv ID and local crawler pointer must be normalized');
    const expected = { arxivId, paperId: arxivId };
    if (stableHash(match.recordIdentity) !== stableHash(expected) || match.recordIdentitySha256 !== stableHash(expected)) fail('local crawler match must retain only the exact stable ID pair');
    normalizePointer(match.recordPointer, match.sourceKind, 'local crawler match recordPointer');
    const pointerSha256 = stableHash({ sourceKind: match.sourceKind, sourceRelativePath: match.sourceRelativePath, sourceFileSha256: match.sourceFileSha256,
        recordPointer: match.recordPointer, recordIdentity: expected, recordIdentitySha256: match.recordIdentitySha256 });
    return `${AUTHORITY_PREFIX}${arxivId}-${pointerSha256}.json`;
}
function snapshotNameFor(fileSha256) { return `${SNAPSHOT_PREFIX}${sha(fileSha256, 'sourceFileSha256')}.json`; }
function snapshotBody(loaded) {
    if (loaded.sourceKind !== 'current' || loaded.relativePath !== 'current/papers.json') fail('identity snapshot requires current/papers.json');
    const entries = loaded.records.filter(entry => entry.identity).map(entry => ({ arxivId: entry.identity.arxivId, recordPointer: entry.pointer,
        recordIdentity: entry.identity, recordIdentitySha256: stableHash(entry.identity) }));
    const body = { contract: SNAPSHOT_CONTRACT, version: VERSION, sourceRelativePath: loaded.relativePath, sourceFileSha256: loaded.fileSha256,
        entries, entrySetSha256: stableHash(entries) };
    return { ...body, snapshotSha256: stableHash(body) };
}
function normalizeCurrentIdentitySnapshot(value) {
    exact(value, ['contract', 'version', 'sourceRelativePath', 'sourceFileSha256', 'entries', 'entrySetSha256', 'snapshotSha256'], 'current local crawler identity snapshot');
    if (value.contract !== SNAPSHOT_CONTRACT || value.version !== VERSION || value.sourceRelativePath !== 'current/papers.json') fail('current local crawler identity snapshot contract is invalid');
    sha(value.sourceFileSha256, 'current identity snapshot sourceFileSha256'); sha(value.entrySetSha256, 'current identity snapshot entrySetSha256');
    const entries = value.entries.map((entry, index) => {
        exact(entry, ['arxivId', 'recordPointer', 'recordIdentity', 'recordIdentitySha256'], `current identity snapshot entries[${index}]`);
        const expected = { arxivId: entry.arxivId, paperId: entry.arxivId };
        if (!identityApi.ARXIV_ID_RE.test(entry.arxivId) || stableHash(entry.recordIdentity) !== stableHash(expected) || entry.recordIdentitySha256 !== stableHash(expected)) fail('current identity snapshot entry stable IDs are invalid');
        normalizePointer(entry.recordPointer, 'current', 'current identity snapshot recordPointer');
        if (entry.recordPointer.value !== entry.arxivId) fail('current identity snapshot map key does not match arXiv ID'); return clone(entry);
    });
    if (stableHash(entries) !== value.entrySetSha256 || new Set(entries.map(entry => entry.arxivId)).size !== entries.length) fail('current identity snapshot entries drifted');
    const body = { ...clone(value), entries }; delete body.snapshotSha256;
    if (value.snapshotSha256 !== stableHash(body)) fail('current identity snapshot self-SHA drifted');
    return { ...body, snapshotSha256: value.snapshotSha256 };
}
function readSnapshot(snapshotRoot, snapshotName) {
    if (!SAFE_JSON_NAME.test(String(snapshotName || '')) || !snapshotName.startsWith(SNAPSHOT_PREFIX)) fail('current identity snapshotName is unsafe');
    const root = safeDirectory(snapshotRoot, 'localCrawlSnapshotRoot'); const filename = path.resolve(root, snapshotName);
    if (path.dirname(filename) !== root) fail('current identity snapshotName escapes root');
    const loaded = readJsonFile(filename, MAX_SNAPSHOT_BYTES, 'current local crawler identity snapshot'); const snapshot = normalizeCurrentIdentitySnapshot(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(snapshot))) fail('current local crawler identity snapshot bytes are not canonical');
    return { filename: fs.realpathSync(filename), fileSha256: loaded.fileSha256, snapshot };
}
function writeExact(root, name, bytes, label) {
    const directory = safeDirectory(root, label, { create: true }); const filename = path.join(directory, name); let fd;
    try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (!fs.readFileSync(filename).equals(bytes)) fail(`refuses to overwrite different immutable ${label}: ${name}`); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function prepareCurrentIdentitySnapshot({ snapshotRoot, loaded } = {}) {
    const body = snapshotBody(loaded); const name = snapshotNameFor(loaded.fileSha256); const bytes = prettyBytes(body);
    writeExact(snapshotRoot, name, bytes, 'localCrawlSnapshotRoot'); const read = readSnapshot(snapshotRoot, name);
    if (read.fileSha256 !== sha256(bytes) || read.snapshot.snapshotSha256 !== body.snapshotSha256) fail('current identity snapshot changed while prepared');
    return { snapshotName: name, snapshotFileSha256: read.fileSha256, snapshotSha256: read.snapshot.snapshotSha256 };
}
function normalizeSnapshotReference(value, sourceFileSha256) {
    if (value === null) return null; exact(value, ['snapshotName', 'snapshotFileSha256', 'snapshotSha256'], 'current identity snapshot reference');
    if (!SAFE_JSON_NAME.test(value.snapshotName) || !value.snapshotName.startsWith(SNAPSHOT_PREFIX)) fail('current identity snapshot reference name is invalid');
    sha(value.snapshotFileSha256, 'current identity snapshot reference file SHA'); sha(value.snapshotSha256, 'current identity snapshot reference SHA');
    if (value.snapshotName !== snapshotNameFor(sourceFileSha256)) fail('current identity snapshot reference does not bind source file SHA'); return clone(value);
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'evidenceKind', 'sourceKind', 'sourceRelativePath',
        'sourceFileSha256', 'recordPointer', 'recordIdentity', 'recordIdentitySha256', 'currentIdentitySnapshot', 'authoritySha256'], 'local crawl identity authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || value.evidenceKind !== EVIDENCE_KIND || !['archive', 'current'].includes(value.sourceKind)
        || sourceSpec(value.sourceRelativePath).sourceKind !== value.sourceKind) fail('local crawl identity authority contract is invalid');
    let identity; try { identity = identityApi.normalizeIdentity(value.identity); } catch (error) { fail(error.message); }
    if (identity.kind !== 'arxiv' || identity.citation !== null || value.paperId !== identity.canonicalId || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity)
        || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) fail('local crawl identity binding is invalid');
    normalizePointer(value.recordPointer, value.sourceKind, 'local crawl authority recordPointer'); const expected = { arxivId: identity.arxivId, paperId: identity.arxivId };
    if (stableHash(value.recordIdentity) !== stableHash(expected) || value.recordIdentitySha256 !== stableHash(expected) || sha(value.sourceFileSha256, 'sourceFileSha256') !== value.sourceFileSha256) fail('local crawl stable ID/SHA binding is invalid');
    const snapshot = normalizeSnapshotReference(value.currentIdentitySnapshot, value.sourceFileSha256);
    if ((value.sourceKind === 'current') !== (snapshot !== null)) fail('current crawler authority snapshot binding is invalid');
    const body = { ...clone(value), identity, currentIdentitySnapshot: snapshot }; delete body.authoritySha256;
    if (sha(value.authoritySha256, 'authoritySha256') !== stableHash(body)) fail('local crawl authority self-SHA drifted'); return { ...body, authoritySha256: value.authoritySha256 };
}
function recordAt(loaded, pointer) {
    const wanted = normalizePointer(pointer, loaded.sourceKind, 'local crawler recordPointer');
    const entry = loaded.records.find(item => stableHash(item.pointer) === stableHash(wanted));
    if (!entry || !entry.identity) fail('local crawler record pointer is absent or lacks exact stable IDs'); return entry;
}
function verifyLoadedMatch(loaded, match) {
    if (loaded.fileSha256 !== match.sourceFileSha256 || loaded.sourceKind !== match.sourceKind) fail('local crawler snapshot file SHA changed');
    const entry = recordAt(loaded, match.recordPointer); const expected = { arxivId: match.arxivId, paperId: match.arxivId };
    if (stableHash(entry.identity) !== stableHash(expected) || stableHash(match.recordIdentity) !== stableHash(expected) || match.recordIdentitySha256 !== stableHash(expected)) fail('local crawler snapshot stable identity record drifted');
    return { arxivId: match.arxivId, sourceKind: loaded.sourceKind, sourceRelativePath: loaded.relativePath, sourceFileSha256: loaded.fileSha256,
        recordPointer: clone(match.recordPointer), recordIdentity: expected, recordIdentitySha256: stableHash(expected) };
}
function verifySnapshotMatch({ snapshotRoot, match }) {
    const reference = normalizeSnapshotReference(match.currentIdentitySnapshot, match.sourceFileSha256); const loaded = readSnapshot(snapshotRoot, reference.snapshotName);
    if (loaded.fileSha256 !== reference.snapshotFileSha256 || loaded.snapshot.snapshotSha256 !== reference.snapshotSha256 || loaded.snapshot.sourceFileSha256 !== match.sourceFileSha256) fail('current identity snapshot SHA binding drifted');
    const entry = loaded.snapshot.entries.find(item => stableHash(item.recordPointer) === stableHash(match.recordPointer)); const expected = { arxivId: match.arxivId, paperId: match.arxivId };
    if (!entry || stableHash(entry.recordIdentity) !== stableHash(expected) || entry.recordIdentitySha256 !== stableHash(expected) || stableHash(match.recordIdentity) !== stableHash(expected)
        || match.recordIdentitySha256 !== stableHash(expected)) fail('current identity snapshot stable ID record drifted');
    return { arxivId: match.arxivId, sourceKind: match.sourceKind, sourceRelativePath: match.sourceRelativePath, sourceFileSha256: match.sourceFileSha256,
        recordPointer: clone(match.recordPointer), recordIdentity: expected, recordIdentitySha256: stableHash(expected), currentIdentitySnapshot: reference };
}
function verifyMatchAgainstLocalCrawl({ dataRoot, snapshotRoot = null, match } = {}) {
    if (!match || !identityApi.ARXIV_ID_RE.test(String(match.arxivId || '')) || !['archive', 'current'].includes(match.sourceKind) || sourceSpec(match.sourceRelativePath).sourceKind !== match.sourceKind
        || !SHA_RE.test(String(match.sourceFileSha256 || '')) || !SHA_RE.test(String(match.recordIdentitySha256 || ''))) fail('local crawler match is malformed');
    const direct = readLocalCrawlFile(dataRoot, match.sourceRelativePath);
    if (direct.fileSha256 === match.sourceFileSha256) return verifyLoadedMatch(direct, match);
    if (match.sourceKind !== 'current' || snapshotRoot === null) fail('local crawler snapshot file SHA changed'); return verifySnapshotMatch({ snapshotRoot, match });
}
function identityFor(arxivId) { return identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'arxiv', canonicalId: `arxiv:${arxivId}`, arxivId,
    conference: null, externalId: null, source: { status: 'official', url: `https://arxiv.org/abs/${arxivId}` }, citation: null }); }
function authorityFor(match, currentIdentitySnapshot) {
    const identity = identityFor(match.arxivId); const body = { contract: CONTRACT, version: VERSION, paperId: identity.canonicalId, identity,
        identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity), evidenceKind: EVIDENCE_KIND,
        sourceKind: match.sourceKind, sourceRelativePath: match.sourceRelativePath, sourceFileSha256: match.sourceFileSha256, recordPointer: match.recordPointer,
        recordIdentity: match.recordIdentity, recordIdentitySha256: match.recordIdentitySha256, currentIdentitySnapshot };
    return { ...body, authoritySha256: stableHash(body) };
}
function readAuthority(identityRoot, authorityName) {
    if (!SAFE_JSON_NAME.test(String(authorityName || '')) || !authorityName.startsWith(AUTHORITY_PREFIX)) fail('local crawl authorityName is unsafe');
    const root = safeDirectory(identityRoot, 'localCrawlIdentityRoot'); const filename = path.resolve(root, authorityName); if (path.dirname(filename) !== root) fail('authorityName escapes localCrawlIdentityRoot');
    const loaded = readJsonFile(filename, 1024 * 1024, 'local crawl identity authority'); const authority = normalizeAuthority(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(authority))) fail('local crawl identity authority bytes are not canonical');
    return { filename: fs.realpathSync(filename), bytes: loaded.bytes, sha256: loaded.fileSha256, authority, dev: loaded.dev, ino: loaded.ino };
}
function authorityHandleSnapshot(handle) {
    if (handle && typeof handle === 'object' && HANDLES.has(handle)) return clone(HANDLE_DATA.get(handle).public);
    try { return legacyArchiveApi.authorityHandleSnapshot(handle); } catch { fail('authenticated local crawl identity handle required'); }
}
function loadCurrentAuthorityHandle({ identityRoot, snapshotRoot, dataRoot, authorityName } = {}) {
    const loaded = readAuthority(identityRoot, authorityName); const authority = loaded.authority;
    verifyMatchAgainstLocalCrawl({ dataRoot, snapshotRoot, match: { arxivId: authority.identity.arxivId, sourceKind: authority.sourceKind, sourceRelativePath: authority.sourceRelativePath,
        sourceFileSha256: authority.sourceFileSha256, recordPointer: authority.recordPointer, recordIdentity: authority.recordIdentity, recordIdentitySha256: authority.recordIdentitySha256,
        currentIdentitySnapshot: authority.currentIdentitySnapshot } });
    const handle = Object.freeze(Object.create(null)); HANDLES.add(handle);
    HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(authority), authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256,
        productionAuthorized: true }), identityRoot: safeDirectory(identityRoot, 'localCrawlIdentityRoot'), snapshotRoot: snapshotRoot === null ? null : safeDirectory(snapshotRoot, 'localCrawlSnapshotRoot'),
    dataRoot: safeDirectory(dataRoot, 'dataRoot'), authorityFileDev: loaded.dev, authorityFileIno: loaded.ino })); return handle;
}
function loadLocalCrawlAuthorityHandle({ identityRoot, legacyIdentityRoot = null, snapshotRoot = null, dataRoot, authorityName } = {}) {
    if (String(authorityName || '').startsWith('archive-crawl-arxiv-')) return legacyArchiveApi.loadArchiveCrawlAuthorityHandle({ identityRoot: legacyIdentityRoot || identityRoot, dataRoot, authorityName });
    return loadCurrentAuthorityHandle({ identityRoot, snapshotRoot, dataRoot, authorityName });
}
function replayCurrentAuthorityHandle(handle, { requireProduction = false } = {}) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated local crawl identity handle required'); const original = HANDLE_DATA.get(handle);
    if (requireProduction && original.public.productionAuthorized !== true) fail('production-authorized local crawl identity handle required'); const loaded = readAuthority(original.identityRoot, original.public.authorityName); const authority = loaded.authority;
    verifyMatchAgainstLocalCrawl({ dataRoot: original.dataRoot, snapshotRoot: original.snapshotRoot, match: { arxivId: authority.identity.arxivId, sourceKind: authority.sourceKind,
        sourceRelativePath: authority.sourceRelativePath, sourceFileSha256: authority.sourceFileSha256, recordPointer: authority.recordPointer, recordIdentity: authority.recordIdentity,
        recordIdentitySha256: authority.recordIdentitySha256, currentIdentitySnapshot: authority.currentIdentitySnapshot } });
    const current = { authority, authorityName: original.public.authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true };
    if (loaded.dev !== original.authorityFileDev || loaded.ino !== original.authorityFileIno || stableHash(current) !== stableHash(original.public)) fail('local crawl identity authority or retained evidence changed after handle creation'); return handle;
}
function replayAuthorityHandle(handle, options = {}) {
    if (handle && typeof handle === 'object' && HANDLES.has(handle)) return replayCurrentAuthorityHandle(handle, options);
    try { return legacyArchiveApi.replayAuthorityHandle(handle, options); } catch { fail('authenticated local crawl identity handle required'); }
}
function prepareLocalCrawlAuthority({ identityRoot, snapshotRoot, dataRoot, arxivId, match, apply = false } = {}) {
    if (!match || match.arxivId !== arxivId) fail('selected local crawler match must bind the requested arXiv ID'); const authorityName = authorityNameFor(arxivId, match);
    if (!apply) return { status: 'dry-run', paperId: `arxiv:${arxivId}`, arxivId, authorityName };
    // Capture and verify one immutable read. A changed current source must be
    // rescanned; it must never produce an authority from two different reads.
    const loaded = readLocalCrawlFile(dataRoot, match.sourceRelativePath);
    if (loaded.fileSha256 !== match.sourceFileSha256) fail('local crawler snapshot file SHA changed before authority capture');
    const retained = verifyLoadedMatch(loaded, match);
    const currentIdentitySnapshot = retained.sourceKind === 'current' ? prepareCurrentIdentitySnapshot({ snapshotRoot, loaded }) : null;
    const authority = authorityFor(retained, currentIdentitySnapshot); const bytes = prettyBytes(authority); const root = safeDirectory(identityRoot, 'localCrawlIdentityRoot', { create: true }); const filename = path.join(root, authorityName);
    const existed = fs.existsSync(filename); writeExact(identityRoot, authorityName, bytes, 'localCrawlIdentityRoot'); const authorityHandle = loadCurrentAuthorityHandle({ identityRoot, snapshotRoot, dataRoot, authorityName });
    return { status: existed ? 'recovered' : 'created', paperId: `arxiv:${arxivId}`, arxivId, authorityName, authorityHandle, retained };
}
function isLocalCrawlAuthorityContract(value) { return value === CONTRACT || value === LEGACY_CONTRACT; }

module.exports = { CONTRACT, SNAPSHOT_CONTRACT, VERSION, EVIDENCE_KIND, AUTHORITY_PREFIX, SNAPSHOT_PREFIX, LEGACY_CONTRACT, SAFE_JSON_NAME,
    HistoricalLocalCrawlAuthorityError, stableHash, prettyBytes, safeDirectory, sourceSpec, readLocalCrawlFile, canonicalArxivId, identityForArchiveRecord,
    identityForCurrentRecord, archivedFilteredPaths, localCrawlPaths, scanLocalCrawlPapers, authorityNameFor, normalizeAuthority, normalizeCurrentIdentitySnapshot,
    prepareCurrentIdentitySnapshot, readSnapshot, verifyMatchAgainstLocalCrawl, prepareLocalCrawlAuthority, loadLocalCrawlAuthorityHandle, authorityHandleSnapshot,
    replayAuthorityHandle, isLocalCrawlAuthorityContract };
