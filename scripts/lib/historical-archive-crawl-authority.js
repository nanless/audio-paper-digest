'use strict';

// 只读重放已保存的归档爬虫身份凭据；不再扫描或签发新的凭据。
// 这里只核对论文身份，不提供 Reader 写作所需的全文、图表或公式。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');

const codec = require('./protocol-codec');
const { recordHeaderFor } = require('./workflow-record-format');
const CONTRACT = codec.contract('historical-archive-crawl-identity-authority');
function authorityHeader(value) {
    if (!codec.hasValidHeader(value, 'historical-archive-crawl-identity-authority')
        || Object.hasOwn(value, 'schemaFingerprint')) fail('归档爬虫身份凭据只接受已登记的原历史格式');
    return recordHeaderFor(value, 'historical-archive-crawl-identity-authority');
}
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
    if (!plain(value)) fail(`${label} 必须是普通对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} 含有未知字段或缺少必需字段`);
    }
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} 必须是 SHA-256`); return value; }
function safeDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对目录`);
    const resolved = path.resolve(directory);
    if (!fs.existsSync(resolved)) fail(`${label} 不存在`);
    const info = fs.lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`);
    return resolved;
}
function safeDataPath(dataRoot, relativePath) {
    if (!/^archive\/\d{4}-\d{2}-\d{2}\/filtered-papers\.json$/.test(String(relativePath || ''))) {
        fail('归档爬虫指针不是已批准的保留筛选快照');
    }
    const root = safeDirectory(dataRoot, 'dataRoot'); const filename = path.resolve(root, relativePath);
    if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.resolve(root, path.dirname(relativePath))) {
        fail('归档爬虫指针超出 dataRoot 范围');
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
            fail('保留的筛选快照在读取过程中发生变化');
        }
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail('保留的筛选快照不是严格的 UTF-8 JSON'); }
        if (!plain(value) || !Array.isArray(value.papers)) fail('保留的筛选快照缺少 papers 数组');
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
function normalizeRecord(record, expectedId) {
    if (!plain(record) || normalizedArxivId(record) !== expectedId) fail('归档爬虫记录未绑定预期的 arXiv ID');
    return clone(record);
}
function normalizeAuthority(value) {
    const header = authorityHeader(value);
    exact(value, [...Object.keys(header), 'paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'evidenceKind',
        'archiveRelativePath', 'archiveFileSha256', 'recordIndex', 'record', 'recordSha256', 'authoritySha256'],
    'archive crawl identity authority');
    if (value.evidenceKind !== EVIDENCE_KIND
        || !Number.isSafeInteger(value.recordIndex) || value.recordIndex < 0
        || !/^archive\/\d{4}-\d{2}-\d{2}\/filtered-papers\.json$/.test(String(value.archiveRelativePath || ''))) {
        fail('归档爬虫身份授权凭据的 contract 无效');
    }
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(error.message); }
    if (Object.hasOwn(identity, 'schemaFingerprint')) fail('退役归档凭据不能换用当前论文身份格式');
    if (identity.kind !== 'arxiv' || identity.citation !== null || value.paperId !== identity.canonicalId
        || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity)
        || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) fail('归档爬虫身份绑定无效');
    const record = normalizeRecord(value.record, identity.arxivId);
    if (sha(value.archiveFileSha256, 'archiveFileSha256') !== value.archiveFileSha256
        || sha(value.recordSha256, 'recordSha256') !== stableHash(record)) fail('归档爬虫记录的 SHA 绑定无效');
    const body = { ...clone(value), identity, record }; delete body.authoritySha256;
    if (sha(value.authoritySha256, 'authoritySha256') !== stableHash(body)) fail('archive crawl authority self-SHA drifted');
    return { ...body, authoritySha256: value.authoritySha256 };
}
function verifyMatchAgainstRetained({ dataRoot, match }) {
    if (!match || typeof match !== 'object' || !identityApi.ARXIV_ID_RE.test(String(match.arxivId || ''))
        || typeof match.archiveRelativePath !== 'string' || !Number.isSafeInteger(match.recordIndex) || match.recordIndex < 0
        || !SHA_RE.test(String(match.archiveFileSha256 || '')) || !SHA_RE.test(String(match.recordSha256 || ''))) fail('归档爬虫匹配记录格式不正确');
    const loaded = readRetainedFilteredFile(dataRoot, match.archiveRelativePath); const record = loaded.papers[match.recordIndex];
    if (loaded.fileSha256 !== match.archiveFileSha256 || normalizedArxivId(record) !== match.arxivId
        || stableHash(record) !== match.recordSha256) fail('retained filtered snapshot no longer matches the selected identity record');
    return { arxivId: match.arxivId, archiveRelativePath: match.archiveRelativePath, archiveFileSha256: loaded.fileSha256,
        recordIndex: match.recordIndex, record: clone(record), recordSha256: match.recordSha256 };
}
function readAuthority(identityRoot, authorityName) {
    const root = safeDirectory(identityRoot, 'archiveIdentityRoot');
    if (!SAFE_JSON_NAME.test(String(authorityName || ''))) fail('authorityName is unsafe');
    const filename = path.resolve(root, authorityName); if (path.dirname(filename) !== root) fail('authorityName 超出 archiveIdentityRoot 范围');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) fail('archive identity authority is unsafe');
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) fail('归档身份授权凭据在读取过程中发生变化');
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail('归档身份授权凭据不是严格的 UTF-8 JSON'); }
        const normalized = normalizeAuthority(value);
        if (!bytes.equals(prettyBytes(normalized))) fail('归档身份授权凭据的字节不是规范形式');
        return { filename: fs.realpathSync(filename), bytes, sha256: sha256(bytes), authority: normalized, dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function authorityHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('需要已认证的归档爬虫身份句柄');
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
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('需要已认证的归档爬虫身份句柄');
    const original = HANDLE_DATA.get(handle);
    if (requireProduction && original.public.productionAuthorized !== true) fail('需要已获生产授权的归档爬虫身份句柄');
    const loaded = readAuthority(original.identityRoot, original.public.authorityName);
    verifyMatchAgainstRetained({ dataRoot: original.dataRoot, match: { arxivId: loaded.authority.identity.arxivId,
        archiveRelativePath: loaded.authority.archiveRelativePath, archiveFileSha256: loaded.authority.archiveFileSha256,
        recordIndex: loaded.authority.recordIndex, recordSha256: loaded.authority.recordSha256 } });
    const current = { authority: loaded.authority, authorityName: original.public.authorityName, authorityFile: loaded.filename,
        authorityFileSha256: loaded.sha256, productionAuthorized: true };
    if (loaded.dev !== original.authorityFileDev || loaded.ino !== original.authorityFileIno || stableHash(current) !== stableHash(original.public)) fail('句柄创建后，归档爬虫身份授权凭据或保留证据发生变化');
    return handle;
}
module.exports = { CONTRACT, EVIDENCE_KIND, AUTHORITY_PREFIX, SAFE_JSON_NAME, HistoricalArchiveCrawlAuthorityError,
    stableHash, prettyBytes, safeDirectory, readRetainedFilteredFile, normalizedArxivId, normalizeAuthority, verifyMatchAgainstRetained,
    loadArchiveCrawlAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
