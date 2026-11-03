'use strict';

// 只读重放旧会议爬虫身份凭据，不再扫描或签发。已保存的标题绑定仍须核对原网页，
// 但不会把网页正文、保留的分析或全文交给写作阶段，也不联网。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');

const codec = require('./protocol-codec');
const { recordHeaderFor } = require('./workflow-record-format');
const CONTRACT = codec.contract('historical-conference-crawl-identity-authority');
function authorityHeader(value) {
    if (!codec.hasValidHeader(value, 'historical-conference-crawl-identity-authority')
        || Object.hasOwn(value, 'schemaFingerprint')) fail('会议爬虫身份凭据只接受已登记的原历史格式');
    return recordHeaderFor(value, 'historical-conference-crawl-identity-authority');
}
const EVIDENCE_KIND = 'retained-conference-crawler-metadata-pdf-identity';
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_HISTORICAL_PAGE_BYTES = 64 * 1024 * 1024;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();
const DATA_SOURCE = 'workspace-data';
const ICLR_ACCEPTED_SOURCE = 'iclr-accepted-local';
const ICLR_ACCEPTED_RELATIVE_PATH = 'data/iclr2026_accepted.json';

const SNAPSHOTS = Object.freeze({
    'current/icassp_2026_deep_analyzers.json': {
        conference: { slug: 'icassp', year: 2026 }, scheme: 'icassp-arnumber', idFields: ['arnumber', 'paper_id'], pdf: 'record'
    },
    'current/iclr_2026_deep_analyzers.json': {
        conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['forum_id', 'paper_id', 'arnumber'], pdf: 'record'
    },
    'current/icml_2026_deep_analysis.json': {
        conference: { slug: 'icml', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['id'], pdf: 'id-file'
    }
});
const ICLR_ACCEPTED_SPEC = Object.freeze({ conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id',
    idFields: ['forum_id'], pdf: 'iclr-accepted-id-file' });

class HistoricalConferenceCrawlAuthorityError extends Error {
    constructor(message) { super(`Historical conference crawl identity authority rejected: ${message}`); this.name = 'HistoricalConferenceCrawlAuthorityError'; this.code = 'HISTORICAL_CONFERENCE_CRAWL_AUTHORITY_INTEGRITY'; }
}
const fail = message => { throw new HistoricalConferenceCrawlAuthorityError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
function exact(value, fields, label) { if (!plain(value)) fail(`${label} 必须是普通对象`); const actual = Object.keys(value).sort(); const expected = [...fields].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} 含有未知字段或缺少必需字段`); }
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} 必须是 SHA-256`); return value; }
function safeDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对目录`);
    const resolved = path.resolve(directory); if (!fs.existsSync(resolved)) fail(`${label} 不存在`);
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); const info = fs.lstatSync(cursor); if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is unsafe`); }
    if (fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`); return resolved;
}
function safeRegularFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} 必须是绝对文件`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`); let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) fail(`${label} is unsafe or too large`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} 在读取过程中发生变化`);
        return { absolute, bytes, sha256: sha256(bytes), dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function titleFingerprint(title, label = 'title') {
    if (typeof title !== 'string' || !title.length || title.length > 16384) fail(`${label} 必须是有长度上限的字符串`);
    const normalized = title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
    if (!normalized) fail(`${label} 规范化后为空`);
    return sha256(Buffer.from(normalized, 'utf8'));
}
function scalarFrontmatterTitle(bytes, label) {
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label} 不是严格的 UTF-8`); }
    const block = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!block) fail(`${label} 缺少严格的 YAML frontmatter`);
    const values = [...block[1].matchAll(/^title:[ \t]*(.*?)\r?$/gmu)];
    if (values.length !== 1) fail(`${label} 必须恰好包含一个标量 title`);
    let value = values[0][1].trim();
    if (!value || /^(?:[|>]|[&*!]|\[|\{|null$|~$)/iu.test(value)) fail(`${label} 的 title 不是受支持的标量`);
    if (value.startsWith("'")) {
        if (!value.endsWith("'") || value.length < 2) fail(`${label} 的 title 引号格式不正确`);
        value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.startsWith('"')) {
        if (!value.endsWith('"') || value.length < 2) fail(`${label} 的 title 引号格式不正确`);
        try { value = JSON.parse(value); } catch { fail(`${label} 的 title 含有不受支持的 YAML 转义`); }
    } else if (/\s+#/u.test(value)) fail(`${label} 的 title 不支持注释`);
    return titleFingerprint(value, `${label} title`);
}
function pageTitleBinding({ blogRoot, pageKey, pagePath, pageContentSha256 } = {}) {
    if (!PAGE_KEY_RE.test(String(pageKey || '')) || typeof pagePath !== 'string' || !pagePath
        || !SHA_RE.test(String(pageContentSha256 || ''))) fail('历史页面 title 绑定的格式不正确');
    const root = safeDirectory(blogRoot, 'blogRoot'); const filename = path.resolve(root, pagePath);
    if (!filename.startsWith(`${root}${path.sep}`)) fail('历史页面 title 绑定超出 blogRoot 范围');
    const loaded = safeRegularFile(filename, 'historical page', MAX_HISTORICAL_PAGE_BYTES);
    if (loaded.sha256 !== pageContentSha256) fail('historical page bytes no longer match the frozen crosswalk page');
    return { pageKey, pagePath, pageContentSha256, titleFingerprintSha256: scalarFrontmatterTitle(loaded.bytes, 'historical page') };
}
function normalizeTitleBindings(value) {
    if (!Array.isArray(value)) fail('title bindings 必须是数组');
    const bindings = value.map((binding, index) => {
        exact(binding, ['pageKey', 'pagePath', 'pageContentSha256', 'titleFingerprintSha256'], `title binding[${index}]`);
        if (!PAGE_KEY_RE.test(binding.pageKey) || typeof binding.pagePath !== 'string' || !binding.pagePath
            || !SHA_RE.test(binding.pageContentSha256) || !SHA_RE.test(binding.titleFingerprintSha256)) fail('title binding 格式不正确');
        return clone(binding);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    if (new Set(bindings.map(binding => binding.pageKey)).size !== bindings.length) fail('title bindings 中有重复页面');
    return bindings;
}
function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) { const token = match[0]; const top = stack.at(-1); if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true }); else if (token === '[') stack.push({ object: false }); else if (token === '}' || token === ']') stack.pop(); else if (token === ',' && top?.object) top.expectKey = true; else if (token.startsWith('"') && top?.object && top.expectKey) { const key = JSON.parse(token); if (top.keys.has(key)) fail('元数据快照含有重复的 JSON 键'); top.keys.add(key); top.expectKey = false; } }
}
function snapshotSpec(relativePath) { const spec = SNAPSHOTS[relativePath]; if (!spec) fail('元数据快照不是已批准的保留会议爬虫文件'); return spec; }
function sourceSpec(sourceKind, relativePath) {
    if (sourceKind === DATA_SOURCE) return snapshotSpec(relativePath);
    if (sourceKind === ICLR_ACCEPTED_SOURCE && relativePath === ICLR_ACCEPTED_RELATIVE_PATH) return ICLR_ACCEPTED_SPEC;
    fail('元数据来源不是已批准的保留会议爬虫文件');
}
function snapshotFile(dataRoot, relativePath) { const root = safeDirectory(dataRoot, 'dataRoot'); snapshotSpec(relativePath); const filename = path.resolve(root, relativePath); if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.resolve(root, path.dirname(relativePath))) fail('元数据快照超出 dataRoot 范围'); return filename; }
function readSnapshot(dataRoot, relativePath) {
    const loaded = safeRegularFile(snapshotFile(dataRoot, relativePath), 'metadata snapshot', MAX_METADATA_BYTES); let value;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); value = JSON.parse(text); } catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('元数据快照不是严格的 UTF-8 JSON'); }
    if (!plain(value) || !Array.isArray(value.papers)) fail('元数据快照缺少 papers 数组');
    return { relativePath, records: value.papers, fileSha256: loaded.sha256 };
}
function acceptedSnapshotFile(iclrAcceptedRoot) {
    const root = safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot'); const filename = path.resolve(root, ICLR_ACCEPTED_RELATIVE_PATH);
    if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.join(root, 'data')) fail('ICLR 接收元数据超出根目录范围');
    return filename;
}
function readIclrAcceptedSnapshot(iclrAcceptedRoot) {
    const loaded = safeRegularFile(acceptedSnapshotFile(iclrAcceptedRoot), 'ICLR accepted metadata snapshot', MAX_METADATA_BYTES); let records;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); records = JSON.parse(text); }
    catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('ICLR 接收元数据快照不是严格的 UTF-8 JSON'); }
    if (!Array.isArray(records)) fail('ICLR 接收元数据快照缺少数组');
    return { relativePath: ICLR_ACCEPTED_RELATIVE_PATH, records, fileSha256: loaded.sha256 };
}
function validValue(scheme, value) { return scheme === 'icassp-arnumber' ? /^[1-9]\d*$/.test(String(value || '')) : /^[A-Za-z0-9_-]{6,128}$/.test(String(value || '')); }
function recordIdentity(spec, record) {
    if (!plain(record)) return null; const values = spec.idFields.filter(field => record[field] !== undefined && record[field] !== null).map(field => String(record[field]));
    if (!values.length || !values.every(value => validValue(spec.scheme, value)) || new Set(values).size !== 1) return null;
    return { scheme: spec.scheme, value: values[0] };
}
function pdfPathFor(dataRoot, relativePath, spec, record, externalId, { sourceKind = DATA_SOURCE, iclrAcceptedRoot = null } = {}) {
    if (sourceKind === ICLR_ACCEPTED_SOURCE) {
        if (!iclrAcceptedRoot) return null;
        return path.resolve(safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot'), 'data', 'pdfs', `${externalId.value}.pdf`);
    }
    if (spec.pdf === 'record') { if (typeof record.pdfPath !== 'string' || !path.isAbsolute(record.pdfPath)) return null; return path.resolve(record.pdfPath); }
    return path.resolve(safeDirectory(dataRoot, 'dataRoot'), 'pdfs', 'icml2026', `${externalId.value}.pdf`);
}
function recordIdentityDigest(externalId, pdfAbsolutePath) { return stableHash({ externalId, pdfAbsolutePath }); }
function identityFor(match, savedIdentity) {
    const header = identityApi.readHeader(savedIdentity);
    if (Object.hasOwn(header, 'schemaFingerprint')) fail('退役会议爬虫凭据不能换用当前论文身份格式');
    const externalId = identityApi.validateExternalId(match.externalId); return identityApi.normalizeIdentity({ ...header, kind: 'conference', canonicalId: identityApi.canonicalConferenceId(match.conference, externalId), arxivId: null, conference: match.conference, externalId, source: { status: 'unavailable', url: null }, citation: null });
}
function normalizeMatch(match) {
    exact(match, ['conference', 'externalId', 'metadataSourceKind', 'metadataRelativePath', 'metadataSnapshotSha256', 'recordIndex', 'recordIdentitySha256', 'pdfAbsolutePath', 'pdfSha256', 'metadataTitleFingerprintSha256'], 'conference crawler match'); const spec = sourceSpec(match.metadataSourceKind, match.metadataRelativePath); const externalId = identityApi.validateExternalId(match.externalId); if (externalId.scheme !== spec.scheme || stableHash(match.conference) !== stableHash(spec.conference) || !Number.isSafeInteger(match.recordIndex) || match.recordIndex < 0 || !path.isAbsolute(match.pdfAbsolutePath)) fail('会议爬虫匹配记录的 identity 指针无效');
    for (const field of ['metadataSnapshotSha256', 'recordIdentitySha256', 'pdfSha256', 'metadataTitleFingerprintSha256']) sha(match[field], field); return { conference: clone(spec.conference), externalId, metadataSourceKind: match.metadataSourceKind, metadataRelativePath: match.metadataRelativePath, metadataSnapshotSha256: match.metadataSnapshotSha256, recordIndex: match.recordIndex, recordIdentitySha256: match.recordIdentitySha256, pdfAbsolutePath: path.resolve(match.pdfAbsolutePath), pdfSha256: match.pdfSha256, metadataTitleFingerprintSha256: match.metadataTitleFingerprintSha256 };
}
function verifyMatchAgainstRetained({ dataRoot, iclrAcceptedRoot = null, match } = {}) {
    const normalized = normalizeMatch(match); const spec = sourceSpec(normalized.metadataSourceKind, normalized.metadataRelativePath); const snapshot = normalized.metadataSourceKind === DATA_SOURCE ? readSnapshot(dataRoot, normalized.metadataRelativePath) : readIclrAcceptedSnapshot(iclrAcceptedRoot); const record = snapshot.records[normalized.recordIndex]; const externalId = recordIdentity(spec, record); if (!externalId || typeof record.title !== 'string' || stableHash(externalId) !== stableHash(normalized.externalId) || snapshot.fileSha256 !== normalized.metadataSnapshotSha256 || titleFingerprint(record.title, 'retained metadata title') !== normalized.metadataTitleFingerprintSha256) fail('保留的会议元数据与所选稳定 ID 不再匹配'); const pdfPath = pdfPathFor(dataRoot, normalized.metadataRelativePath, spec, record, externalId, { sourceKind: normalized.metadataSourceKind, iclrAcceptedRoot }); if (!pdfPath || path.resolve(pdfPath) !== normalized.pdfAbsolutePath || recordIdentityDigest(externalId, normalized.pdfAbsolutePath) !== normalized.recordIdentitySha256) fail('保留的会议元数据 PDF 指针与稳定 ID 不再匹配'); const pdf = safeRegularFile(normalized.pdfAbsolutePath, 'retained conference PDF', MAX_PDF_BYTES); if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.sha256 !== normalized.pdfSha256) fail('retained conference PDF bytes no longer match the selected stable ID'); return normalized;
}
function normalizeAuthority(value) {
    const header = authorityHeader(value);
    exact(value, [...Object.keys(header), 'paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'evidenceKind', 'conference', 'externalId', 'metadataSourceKind', 'metadataRelativePath', 'metadataSnapshotSha256', 'recordIndex', 'recordIdentitySha256', 'pdfAbsolutePath', 'pdfSha256', 'metadataTitleFingerprintSha256', 'titleBindings', 'titleBindingsSha256', 'authoritySha256'], 'conference crawler identity authority');
    if (value.evidenceKind !== EVIDENCE_KIND) fail('会议爬虫授权凭据的 contract 无效'); const match = normalizeMatch({ conference: value.conference, externalId: value.externalId, metadataSourceKind: value.metadataSourceKind, metadataRelativePath: value.metadataRelativePath, metadataSnapshotSha256: value.metadataSnapshotSha256, recordIndex: value.recordIndex, recordIdentitySha256: value.recordIdentitySha256, pdfAbsolutePath: value.pdfAbsolutePath, pdfSha256: value.pdfSha256, metadataTitleFingerprintSha256: value.metadataTitleFingerprintSha256 }); const titleBindings = normalizeTitleBindings(value.titleBindings); if (sha(value.titleBindingsSha256, 'titleBindingsSha256') !== stableHash(titleBindings)) fail('conference crawler authority title bindings drifted'); if (titleBindings.some(binding => binding.titleFingerprintSha256 !== match.metadataTitleFingerprintSha256)) fail('会议爬虫的 title 绑定与保留元数据的 title 不完全一致'); const identity = identityFor(match, value.identity); if (stableHash(identity) !== stableHash(value.identity) || value.paperId !== identity.canonicalId || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity) || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) fail('会议爬虫的 identity 绑定无效'); const body = clone(value); delete body.authoritySha256; body.identity = identity; body.conference = match.conference; body.externalId = match.externalId; body.titleBindings = titleBindings; if (sha(value.authoritySha256, 'authoritySha256') !== stableHash(body)) fail('conference crawler authority self-SHA drifted'); return { ...body, authoritySha256: value.authoritySha256 };
}
function readAuthority(identityRoot, authorityName) { const root = safeDirectory(identityRoot, 'conferenceIdentityRoot'); if (!SAFE_JSON_NAME.test(String(authorityName || ''))) fail('authorityName is unsafe'); const filename = path.resolve(root, authorityName); if (path.dirname(filename) !== root) fail('authorityName 超出 conferenceIdentityRoot 范围'); const loaded = safeRegularFile(filename, 'conference identity authority', MAX_METADATA_BYTES); let value; try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); value = JSON.parse(text); } catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('会议身份授权凭据不是严格的 UTF-8 JSON'); } const authority = normalizeAuthority(value); if (!loaded.bytes.equals(prettyBytes(authority))) fail('会议身份授权凭据的字节不是规范形式'); return { filename: loaded.absolute, sha256: loaded.sha256, authority, dev: loaded.dev, ino: loaded.ino }; }
function authorityHandleSnapshot(handle) { if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('需要已认证的会议爬虫身份句柄'); return clone(HANDLE_DATA.get(handle).public); }
function matchFromAuthority(authority) { return normalizeMatch({ conference: authority.conference, externalId: authority.externalId, metadataSourceKind: authority.metadataSourceKind, metadataRelativePath: authority.metadataRelativePath, metadataSnapshotSha256: authority.metadataSnapshotSha256, recordIndex: authority.recordIndex, recordIdentitySha256: authority.recordIdentitySha256, pdfAbsolutePath: authority.pdfAbsolutePath, pdfSha256: authority.pdfSha256, metadataTitleFingerprintSha256: authority.metadataTitleFingerprintSha256 }); }
function verifyTitleBindings({ blogRoot, titleBindings }) { const normalized = normalizeTitleBindings(titleBindings); if (!normalized.length) return normalized; if (typeof blogRoot !== 'string' || !path.isAbsolute(blogRoot)) fail('重放绑定 title 的会议授权凭据需要 blogRoot'); return normalized.map(binding => { const current = pageTitleBinding({ blogRoot, ...binding }); if (stableHash(current) !== stableHash(binding)) fail('历史页面 title 绑定发生变化'); return current; }); }
function loadConferenceCrawlAuthorityHandle({ identityRoot, dataRoot, blogRoot = null, iclrAcceptedRoot = null, authorityName } = {}) { const loaded = readAuthority(identityRoot, authorityName); const match = matchFromAuthority(loaded.authority); verifyMatchAgainstRetained({ dataRoot, iclrAcceptedRoot, match }); verifyTitleBindings({ blogRoot, titleBindings: loaded.authority.titleBindings }); const handle = Object.freeze(Object.create(null)); HANDLES.add(handle); HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(loaded.authority), authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true }), identityRoot: safeDirectory(identityRoot, 'conferenceIdentityRoot'), dataRoot: safeDirectory(dataRoot, 'dataRoot'), blogRoot: loaded.authority.titleBindings.length ? safeDirectory(blogRoot, 'blogRoot') : null, iclrAcceptedRoot: loaded.authority.metadataSourceKind === ICLR_ACCEPTED_SOURCE ? safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot') : null, authorityFileDev: loaded.dev, authorityFileIno: loaded.ino })); return handle; }
function replayAuthorityHandle(handle, { requireProduction = false } = {}) { if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('需要已认证的会议爬虫身份句柄'); const original = HANDLE_DATA.get(handle); if (requireProduction && original.public.productionAuthorized !== true) fail('需要已获生产授权的会议爬虫身份句柄'); const loaded = readAuthority(original.identityRoot, original.public.authorityName); verifyMatchAgainstRetained({ dataRoot: original.dataRoot, iclrAcceptedRoot: original.iclrAcceptedRoot, match: matchFromAuthority(loaded.authority) }); verifyTitleBindings({ blogRoot: original.blogRoot, titleBindings: loaded.authority.titleBindings }); const current = { authority: loaded.authority, authorityName: original.public.authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true }; if (loaded.dev !== original.authorityFileDev || loaded.ino !== original.authorityFileIno || stableHash(current) !== stableHash(original.public)) fail('句柄创建后，会议爬虫授权凭据或保留证据发生变化'); return handle; }
module.exports = { CONTRACT, EVIDENCE_KIND, SAFE_JSON_NAME, DATA_SOURCE, ICLR_ACCEPTED_SOURCE, ICLR_ACCEPTED_RELATIVE_PATH, HistoricalConferenceCrawlAuthorityError, stableHash, prettyBytes, safeDirectory, titleFingerprint, pageTitleBinding, normalizeTitleBindings, readSnapshot, readIclrAcceptedSnapshot, recordIdentity, normalizeMatch, normalizeAuthority, verifyMatchAgainstRetained, loadConferenceCrawlAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
