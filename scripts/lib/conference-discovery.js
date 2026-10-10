'use strict';

// 针对不可变的会议元数据快照和本地 PDF 目录做离线发现。发现阶段只提出来源候选：
// 文件名完全一致也不等于身份与 PDF 已经绑定，不能进入执行。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const paperIdentity = require('./paper-identity.js');
const officialAcquisition = require('./official-conference-acquisition.js');

const CONTRACT = 'conference-discovery-v2';
const REPORT_CONTRACT = 'conference-discovery-report-v2';
const VERSION = 2;
const ADAPTERS = new Set(['icassp', 'iclr', 'icml', 'official-proceedings']);
const MATCH_KINDS = ['exact', 'normalized', 'ambiguous', 'unmatched'];
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
// 通过校验的 discovery pair 是筛选阶段的权限边界。允许的字节和文档保存在模块私有
// 状态里，调用方没法给一个对象挂上看似合理的摘要来伪造 catalog/report 组合。
const DISCOVERY_HANDLES = new WeakSet();
const DISCOVERY_HANDLE_DATA = new WeakMap();

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(message) {
    const error = new Error(`Conference discovery rejected: ${message}`);
    error.code = 'CONFERENCE_DISCOVERY_INTEGRITY';
    return error;
}

function exact(value, fields, name) {
    if (!plain(value)) throw fail(`${name} 必须是普通对象`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw fail(`${name} 含未允许的字段或缺少必填字段`);
    }
}

function assertSha(value, name) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) throw fail(`${name} 必须是小写 SHA-256`);
    return value;
}

function safeAbsoluteDirectory(directory, name) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail(`${name} 必须是绝对目录`);
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`${name} contains an unsafe directory: ${cursor}`);
    }
    if (fs.realpathSync(absolute) !== absolute) throw fail(`${name} 不得经由符号链接解析`);
    return absolute;
}

function safeAbsoluteFile(filename, name, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail(`${name} must be an absolute filename`);
    const absolute = path.resolve(filename);
    safeAbsoluteDirectory(path.dirname(absolute), `${name} parent`);
    let descriptor;
    let fd;
    try {
        const before = fs.lstatSync(absolute);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
            throw fail(`${name} must be a regular single-link file within its size limit`);
        }
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            throw fail(`${name} changed or became unsafe while opening`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) throw fail(`${name} changed while being read`);
        descriptor = { absolute, bytes };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return descriptor;
}

function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function readMetadataSnapshot(filename) {
    const loaded = safeAbsoluteFile(filename, 'metadata snapshot', MAX_METADATA_BYTES);
    let source;
    let value;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(source, 'metadata snapshot');
        value = JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_DISCOVERY_INTEGRITY') throw error;
        throw fail('metadata 快照必须含有效的严格 UTF-8 JSON');
    }
    return {
        value,
        descriptor: { file: loaded.absolute, sha256: sha256(loaded.bytes), size: loaded.bytes.length }
    };
}

function safeRelativePath(root, filename) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    try { return ledgerApi.assertRelativePath(relative, 'PDF catalog path'); }
    catch (error) { throw fail(error.message); }
}

function readPdf(filename, relative) {
    const loaded = safeAbsoluteFile(filename, `PDF ${relative}`, MAX_PDF_BYTES);
    if (loaded.bytes.length < 5 || loaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw fail(`PDF ${relative} does not have a standard PDF header`);
    }
    return { path: relative, sha256: sha256(loaded.bytes), size: loaded.bytes.length };
}

function catalogPdfs(pdfRoot) {
    const root = safeAbsoluteDirectory(pdfRoot, 'pdfRoot');
    const catalog = [];
    function visit(directory) {
        const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
        for (const entry of entries) {
            const filename = path.join(directory, entry.name);
            const stat = fs.lstatSync(filename);
            if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw fail(`pdfRoot contains symbolic link: ${filename}`);
            if (entry.isDirectory()) {
                if (fs.realpathSync(filename) !== filename) throw fail(`pdfRoot contains unsafe directory: ${filename}`);
                visit(filename);
                continue;
            }
            if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1) {
                throw fail(`pdfRoot contains non-regular or hard-linked entry: ${filename}`);
            }
            const relative = safeRelativePath(root, filename);
            if (path.posix.extname(relative).toLowerCase() === '.pdf') catalog.push(readPdf(filename, relative));
        }
    }
    visit(root);
    catalog.sort((a, b) => compare(a.path, b.path));
    return { root, catalog, catalogSha256: ledgerApi.stableHash(catalog) };
}

function text(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail(`${name} 必须是无控制字符的非空去空格字符串`);
    }
    return value;
}

function optionalText(value, name, { allowEmpty = false, max = 16384 } = {}) {
    if (value === null) return null;
    if (typeof value !== 'string' || value !== value.trim() || value.length > max
        || (!allowEmpty && !value) || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail(`${name} 必须是${allowEmpty ? '去空格的' : '非空去空格的'}、无控制字符的字符串或 null`);
    }
    return value;
}

function publicHttpsUrl(value, name, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    text(value, name);
    let parsed;
    try { parsed = new URL(value); } catch { throw fail(`${name} 必须是 URL`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash
        || !parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')
        || parsed.hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
        || parsed.toString() !== value) {
        throw fail(`${name} 必须是不含凭证、端口和片段的规范公开 HTTPS URL`);
    }
    return value;
}

function officialConference(value, name = 'official metadata conference') {
    exact(value, ['id', 'year'], name);
    let coordinates;
    try { coordinates = paperIdentity.conferenceCoordinates(value); }
    catch (error) { throw fail(`${name} 无效：${error.message}`); }
    return { id: `${coordinates.slug}-${coordinates.year}`, year: coordinates.year };
}

function officialPdfFile(value, name) {
    if (value === null) return null;
    let relative;
    try { relative = ledgerApi.assertRelativePath(value, name); }
    catch (error) { throw fail(error.message); }
    if (relative.length > 1024 || path.posix.extname(relative).toLowerCase() !== '.pdf') {
        throw fail(`${name} 必须是规范化的相对 PDF 路径或 null`);
    }
    return relative;
}

function normalizeOfficialRecord(record, index) {
    exact(record, ['id', 'title', 'authors', 'abstract', 'pdfFile', 'recordUrl', 'pdfUrl', 'doi', 'track'], `metadata[${index}]`);
    let identity;
    try {
        const external = paperIdentity.validateExternalId({ scheme: 'conference-paper-id', value: record.id });
        identity = { type: external.scheme, value: external.value };
    } catch (error) { throw fail(`metadata[${index}].id 无效：${error.message}`); }
    const title = text(record.title, `metadata[${index}].title`);
    if (!Array.isArray(record.authors) || !record.authors.length || record.authors.length > 1000) {
        throw fail(`metadata[${index}].authors must be a nonempty array of at most 1000 names`);
    }
    const authors = record.authors.map((author, authorIndex) => text(author, `metadata[${index}].authors[${authorIndex}]`));
    if (new Set(authors).size !== authors.length) throw fail(`metadata[${index}].authors 含重复项`);
    const abstract = optionalText(record.abstract, `metadata[${index}].abstract`, { allowEmpty: true, max: 500000 });
    if (abstract === null) throw fail(`metadata[${index}].abstract 必须是字符串`);
    const pdfFile = officialPdfFile(record.pdfFile, `metadata[${index}].pdfFile`);
    publicHttpsUrl(record.recordUrl, `metadata[${index}].recordUrl`);
    publicHttpsUrl(record.pdfUrl, `metadata[${index}].pdfUrl`, { nullable: true });
    const doi = optionalText(record.doi, `metadata[${index}].doi`, { max: 1024 });
    if (doi !== null && !/^10\.\d{4,9}\/\S+$/i.test(doi)) throw fail(`metadata[${index}].doi 必须是 DOI 或 null`);
    optionalText(record.track, `metadata[${index}].track`, { max: 1024 });
    return { identity, metadataIndex: index, title, numericAlias: null, pdfFile };
}

function positiveIntegerString(value, name) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 1) throw fail(`${name} 必须是正的安全整数`);
        value = String(value);
    }
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw fail(`${name} must be a canonical positive integer string`);
    return value;
}

function forumId(value, name) {
    text(value, name);
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) throw fail(`${name} 必须是规范的 OpenReview forum ID`);
    return value;
}

function extractRecords(adapter, snapshot, expectedConference = null) {
    if (adapter === 'icassp' || adapter === 'iclr') {
        if (!Array.isArray(snapshot)) throw fail(`${adapter} 的 metadata 快照必须是数组`);
        return snapshot;
    }
    if (adapter === 'official-proceedings') {
        exact(snapshot, ['conference', 'papers'], 'official-proceedings metadata snapshot');
        const conference = officialConference(snapshot.conference);
        if (expectedConference && (conference.id !== expectedConference.id || conference.year !== expectedConference.year)) {
            throw fail('official-proceedings 的 metadata 会议与请求的会议身份不一致');
        }
        if (!Array.isArray(snapshot.papers)) throw fail('official-proceedings 的 metadata 快照 papers 必须是数组');
        return snapshot.papers;
    }
    if (!plain(snapshot) || !Array.isArray(snapshot.papers)) throw fail('icml 的 metadata 快照必须是含 papers 数组的对象');
    return snapshot.papers;
}

function optionalNumericAlias(record, index, includeId = false) {
    const fields = ['numeric_alias', 'numericAlias', 'paper_number', 'paperNumber', 'paper_id', 'number'];
    if (includeId) fields.push('id');
    const values = fields.filter(field => record[field] !== undefined && record[field] !== null)
        .map(field => positiveIntegerString(record[field], `metadata[${index}].${field}`));
    if (!values.length) return null;
    if (new Set(values).size !== 1) throw fail(`metadata[${index}] has conflicting numeric aliases`);
    return values[0];
}

function normalizeMetadataMember(adapter, record, index) {
    if (!plain(record)) throw fail(`metadata[${index}] 必须是普通对象`);
    if (adapter === 'official-proceedings') return normalizeOfficialRecord(record, index);
    const title = text(record.title, `metadata[${index}].title`);
    if (adapter === 'icassp') {
        return { identity: { type: 'icassp-arnumber', value: positiveIntegerString(record.arnumber, `metadata[${index}].arnumber`) },
            metadataIndex: index, title, numericAlias: null };
    }
    const explicitForumFields = adapter === 'iclr' ? ['forum_id'] : ['forum_id', 'forumId'];
    let fields = explicitForumFields.filter(field => record[field] !== undefined && record[field] !== null);
    const explicitForum = fields.length > 0;
    if (adapter === 'icml' && !explicitForum) fields = ['id'];
    const candidates = fields
        .map(field => forumId(record[field], `metadata[${index}].${field}`));
    if (!candidates.length) throw fail(`metadata[${index}] 缺少其 OpenReview forum ID`);
    if (new Set(candidates).size !== 1) throw fail(`metadata[${index}] has conflicting OpenReview forum IDs`);
    if (adapter === 'icml' && explicitForum && record.id !== undefined && record.id !== null
        && !(typeof record.id === 'number' || /^\d+$/.test(String(record.id)))) {
        const redundantId = forumId(record.id, `metadata[${index}].id`);
        if (redundantId !== candidates[0]) throw fail(`metadata[${index}] has conflicting OpenReview forum IDs`);
    }
    return { identity: { type: 'openreview-forum-id', value: candidates[0] }, metadataIndex: index, title,
        numericAlias: adapter === 'icml' ? optionalNumericAlias(record, index, explicitForum
            && (typeof record.id === 'number' || /^\d+$/.test(String(record.id)))) : null };
}

function normalizedTitle(value) {
    return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\p{Z}\s_]+/gu, '');
}

function descriptorMap(catalog) {
    return new Map(catalog.map(item => [item.path, item]));
}

function icasspMatch(member, catalog) {
    const exact = catalog.filter(item => path.posix.basename(item.path, path.posix.extname(item.path)) === member.title);
    if (exact.length === 1) return { kind: 'exact', candidates: exact };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
    const target = normalizedTitle(member.title);
    const normalized = catalog.filter(item => normalizedTitle(path.posix.basename(item.path, path.posix.extname(item.path))) === target);
    if (normalized.length === 1) return { kind: 'normalized', candidates: normalized };
    if (normalized.length > 1) return { kind: 'ambiguous', candidates: normalized };
    return { kind: 'unmatched', candidates: [] };
}

function openReviewMatch(member, catalogByPath) {
    const expected = `${member.identity.value}.pdf`;
    const candidate = catalogByPath.get(expected);
    return candidate ? { kind: 'exact', candidates: [candidate] } : { kind: 'unmatched', candidates: [] };
}

function officialProceedingsMatch(member, catalogByPath) {
    if (member.pdfFile === null) return { kind: 'unmatched', candidates: [] };
    const candidate = catalogByPath.get(member.pdfFile);
    return candidate ? { kind: 'exact', candidates: [candidate] } : { kind: 'unmatched', candidates: [] };
}

function markSharedIcasspCandidatesAmbiguous(members) {
    const owners = new Map();
    for (const member of members) {
        if (!['exact', 'normalized'].includes(member.match.kind)) continue;
        for (const candidate of member.match.candidates) {
            const set = owners.get(candidate.path) || new Set();
            set.add(`${member.identity.type}:${member.identity.value}`);
            owners.set(candidate.path, set);
        }
    }
    for (const member of members) {
        if (member.match.candidates.some(candidate => owners.get(candidate.path)?.size > 1)) member.match.kind = 'ambiguous';
    }
}

function buildReport(manifest) {
    const counts = Object.fromEntries(MATCH_KINDS.map(kind => [kind, manifest.members.filter(member => member.match.kind === kind).length]));
    const matchedPaths = new Set(manifest.members.flatMap(member => member.match.candidates.map(candidate => candidate.path)));
    const report = {
        contract: REPORT_CONTRACT,
        version: VERSION,
        adapter: manifest.adapter,
        conference: manifest.conference,
        candidateManifestSha256: sha256(canonicalBytes(manifest)),
        metadataSnapshotSha256: manifest.metadataSnapshot.sha256,
        pdfCatalogSha256: manifest.pdfCatalogSha256,
        counts: { metadataRecords: manifest.members.length, pdfFiles: manifest.pdfCatalog.length, ...counts,
            orphanPdfFiles: manifest.pdfCatalog.filter(item => !matchedPaths.has(item.path)).length }
    };
    return report;
}

function validateDescriptor(value, name) {
    exact(value, ['path', 'sha256', 'size'], name);
    let relative;
    try { relative = ledgerApi.assertRelativePath(value.path, `${name}.path`); }
    catch (error) { throw fail(error.message); }
    assertSha(value.sha256, `${name}.sha256`);
    if (!Number.isSafeInteger(value.size) || value.size < 5 || value.size > MAX_PDF_BYTES) {
        throw fail(`${name}.size 无效`);
    }
    return { path: relative, sha256: value.sha256, size: value.size };
}

function sameDescriptor(left, right) {
    return left.path === right.path && left.sha256 === right.sha256 && left.size === right.size;
}

function validateConferenceForAdapter(adapter, conference) {
    if (adapter === 'official-proceedings') return officialConference(conference, 'candidate manifest conference');
    exact(conference, ['id', 'year'], 'candidate manifest conference');
    if (!Number.isInteger(conference.year) || conference.year < 1900 || conference.year > 2100
        || conference.id !== `${adapter}-${conference.year}`) {
        throw fail('候选 manifest 的会议身份不一致');
    }
    return { id: conference.id, year: conference.year };
}

function memberFields(adapter) {
    return adapter === 'official-proceedings'
        ? ['identity', 'metadataIndex', 'title', 'numericAlias', 'pdfFile', 'match']
        : ['identity', 'metadataIndex', 'title', 'numericAlias', 'match'];
}

function matchMember(adapter, member, pdfCatalog, byPath) {
    if (adapter === 'icassp') return icasspMatch(member, pdfCatalog);
    if (adapter === 'official-proceedings') return officialProceedingsMatch(member, byPath);
    return openReviewMatch(member, byPath);
}

function validateDiscoveryBundle(candidateManifest, report, { catalogRawBytes, reportRawBytes } = {}) {
    const expectedManifestFields = ['contract', 'version', 'adapter', 'conference', 'metadataSnapshot', 'pdfRoot',
        'pdfCatalogSha256', 'pdfCatalog', 'members', 'memberSetSha256'];
    if (Object.hasOwn(candidateManifest, 'acquisitionReceipt')) expectedManifestFields.push('acquisitionReceipt');
    exact(candidateManifest, expectedManifestFields, 'candidate manifest');
    if (candidateManifest.contract !== CONTRACT || candidateManifest.version !== VERSION || !ADAPTERS.has(candidateManifest.adapter)) {
        throw fail('候选 manifest 的协议名称、版本或适配器不受支持');
    }
    validateConferenceForAdapter(candidateManifest.adapter, candidateManifest.conference);
    exact(candidateManifest.metadataSnapshot, ['file', 'sha256', 'size'], 'candidate manifest metadataSnapshot');
    if (typeof candidateManifest.metadataSnapshot.file !== 'string' || !path.isAbsolute(candidateManifest.metadataSnapshot.file)
        || !Number.isSafeInteger(candidateManifest.metadataSnapshot.size) || candidateManifest.metadataSnapshot.size < 1
        || candidateManifest.metadataSnapshot.size > MAX_METADATA_BYTES) {
        throw fail('候选 manifest 的 metadataSnapshot 格式不正确');
    }
    assertSha(candidateManifest.metadataSnapshot.sha256, 'candidate manifest metadataSnapshot.sha256');
    if (typeof candidateManifest.pdfRoot !== 'string' || !path.isAbsolute(candidateManifest.pdfRoot)) {
        throw fail('候选 manifest 的 pdfRoot 必须是绝对路径');
    }
    if (candidateManifest.acquisitionReceipt !== undefined) {
        validateAcquisitionReceiptBinding(candidateManifest.acquisitionReceipt,
            candidateManifest.conference, candidateManifest.metadataSnapshot, candidateManifest.pdfRoot);
    }
    if (!Array.isArray(candidateManifest.pdfCatalog)) throw fail('候选 manifest 的 pdfCatalog 必须是数组');
    const pdfCatalog = candidateManifest.pdfCatalog.map((item, index) => validateDescriptor(item, `pdfCatalog[${index}]`));
    const pdfPaths = pdfCatalog.map(item => item.path);
    if (new Set(pdfPaths).size !== pdfPaths.length) throw fail('候选 manifest 的 pdfCatalog 含重复路径');
    const sortedPdfPaths = [...pdfPaths].sort(compare);
    if (pdfPaths.some((value, index) => value !== sortedPdfPaths[index])) throw fail('候选 manifest 的 pdfCatalog 必须按路径排序');
    if (assertSha(candidateManifest.pdfCatalogSha256, 'candidate manifest pdfCatalogSha256')
        !== ledgerApi.stableHash(pdfCatalog)) throw fail('候选 manifest 的 pdfCatalog SHA 与重新计算的结果不同');
    const byPath = new Map(pdfCatalog.map(item => [item.path, item]));

    if (!Array.isArray(candidateManifest.members) || !candidateManifest.members.length) {
        throw fail('候选 manifest 的 members 不能为空');
    }
    const identities = [];
    const metadataIndexes = new Set();
    const singleCandidateOwners = new Map();
    for (const [index, member] of candidateManifest.members.entries()) {
        exact(member, memberFields(candidateManifest.adapter), `member[${index}]`);
        let identity;
        try { identity = ledgerApi.identityKey(member.identity); }
        catch (error) { throw fail(`member[${index}] 的身份无效：${error.message}`); }
        const expectedIdentityType = candidateManifest.adapter === 'icassp' ? 'icassp-arnumber'
            : candidateManifest.adapter === 'official-proceedings' ? 'conference-paper-id' : 'openreview-forum-id';
        if (member.identity.type !== expectedIdentityType) {
            throw fail(`member[${index}] 的身份类型不符合适配器 ${candidateManifest.adapter} 的要求`);
        }
        identities.push(identity);
        if (!Number.isSafeInteger(member.metadataIndex) || member.metadataIndex < 0 || metadataIndexes.has(member.metadataIndex)) {
            throw fail(`member[${index}] 的 metadataIndex 无效或有重复`);
        }
        metadataIndexes.add(member.metadataIndex);
        text(member.title, `member[${index}].title`);
        if (member.numericAlias !== null && (typeof member.numericAlias !== 'string' || !/^[1-9]\d*$/.test(member.numericAlias))) {
            throw fail(`member[${index}].numericAlias 格式不正确`);
        }
        if (candidateManifest.adapter !== 'icml' && member.numericAlias !== null) {
            throw fail(`只有 icml 适配器允许 member[${index}].numericAlias 非空`);
        }
        if (candidateManifest.adapter === 'official-proceedings') {
            officialPdfFile(member.pdfFile, `member[${index}].pdfFile`);
        }
        exact(member.match, ['kind', 'candidates'], `member[${index}].match`);
        if (!MATCH_KINDS.includes(member.match.kind) || !Array.isArray(member.match.candidates)) {
            throw fail(`member[${index}].match 格式不正确`);
        }
        const required = member.match.kind === 'unmatched' ? 0 : member.match.kind === 'ambiguous' ? null : 1;
        if ((required !== null && member.match.candidates.length !== required)
            || (member.match.kind === 'ambiguous' && member.match.candidates.length < 1)) {
            throw fail(`member[${index}] 的候选数量不符合匹配类型 ${member.match.kind} 的要求`);
        }
        const seenCandidates = new Set();
        const candidatePaths = [];
        for (const [candidateIndex, value] of member.match.candidates.entries()) {
            const candidate = validateDescriptor(value, `member[${index}].match.candidates[${candidateIndex}]`);
            const catalogCandidate = byPath.get(candidate.path);
            if (!catalogCandidate || !sameDescriptor(candidate, catalogCandidate)) {
                throw fail(`member[${index}] 的候选路径、SHA 或字节数与 PDF 目录中的记录不同`);
            }
            if (seenCandidates.has(candidate.path)) throw fail(`member[${index}] 含重复候选`);
            seenCandidates.add(candidate.path);
            candidatePaths.push(candidate.path);
            if (['exact', 'normalized'].includes(member.match.kind)) {
                const owners = singleCandidateOwners.get(candidate.path) || [];
                owners.push(identity); singleCandidateOwners.set(candidate.path, owners);
            }
        }
        const sortedCandidatePaths = [...candidatePaths].sort(compare);
        if (candidatePaths.some((value, candidateIndex) => value !== sortedCandidatePaths[candidateIndex])) {
            throw fail(`member[${index}] 的候选必须按路径排序`);
        }
    }
    if (new Set(identities).size !== identities.length) throw fail('候选 manifest 含重复的主身份');
    const sortedIdentities = [...identities].sort(compare);
    if (identities.some((value, index) => value !== sortedIdentities[index])) {
        throw fail('候选 manifest 的 members 必须按规范身份排序');
    }
    if ([...singleCandidateOwners.values()].some(owners => owners.length > 1)) {
        throw fail('被多个 member 共用的单个 PDF 候选必须标记为有歧义');
    }
    if (candidateManifest.members.some((_member, index) => !metadataIndexes.has(index))) {
        throw fail('候选 manifest 的 metadataIndex 必须从 0 开始连续覆盖全部成员，且每个索引只出现一次');
    }
    const replayMembers = candidateManifest.members.map(member => ({ identity: member.identity, title: member.title,
        ...(candidateManifest.adapter === 'official-proceedings' ? { pdfFile: member.pdfFile } : {}),
        match: matchMember(candidateManifest.adapter, member, pdfCatalog, byPath) }));
    if (['icassp', 'official-proceedings'].includes(candidateManifest.adapter)) markSharedIcasspCandidatesAmbiguous(replayMembers);
    for (const [index, member] of candidateManifest.members.entries()) {
        const replay = replayMembers[index].match;
        if (member.match.kind !== replay.kind || member.match.candidates.length !== replay.candidates.length
            || member.match.candidates.some((candidate, candidateIndex) => !sameDescriptor(candidate, replay.candidates[candidateIndex]))) {
            throw fail(`按适配器和 PDF 目录重新计算的 member[${index}] 匹配结果与记录不同`);
        }
    }
    if (assertSha(candidateManifest.memberSetSha256, 'candidate manifest memberSetSha256')
        !== ledgerApi.memberSetSha256(candidateManifest.members)) throw fail('候选 manifest 的成员集合 SHA 与重新计算的结果不同');

    exact(report, ['contract', 'version', 'adapter', 'conference', 'candidateManifestSha256',
        'metadataSnapshotSha256', 'pdfCatalogSha256', 'counts'], 'discovery report');
    if (report.contract !== REPORT_CONTRACT || report.version !== VERSION || report.adapter !== candidateManifest.adapter) {
        throw fail('discovery 报告的协议名称、版本或适配器与候选 manifest 不匹配');
    }
    exact(report.conference, ['id', 'year'], 'discovery report conference');
    if (report.conference.id !== candidateManifest.conference.id || report.conference.year !== candidateManifest.conference.year) {
        throw fail('discovery 报告的会议与候选 manifest 不匹配');
    }
    const canonicalCatalogBytes = canonicalBytes(candidateManifest);
    const canonicalCatalogSha256 = sha256(canonicalCatalogBytes);
    if (assertSha(report.candidateManifestSha256, 'report candidateManifestSha256') !== canonicalCatalogSha256) {
        throw fail('报告中的 candidateManifestSha256 与按固定 JSON 格式生成的候选 manifest SHA 不同');
    }
    if (catalogRawBytes !== undefined) {
        const raw = Buffer.isBuffer(catalogRawBytes) ? catalogRawBytes : Buffer.from(catalogRawBytes);
        if (!raw.equals(canonicalCatalogBytes) || sha256(raw) !== report.candidateManifestSha256) {
            throw fail('候选 manifest 文件的字节或 SHA 与报告对应的固定 JSON 格式内容不同');
        }
    }
    if (report.metadataSnapshotSha256 !== candidateManifest.metadataSnapshot.sha256
        || report.pdfCatalogSha256 !== candidateManifest.pdfCatalogSha256) {
        throw fail('discovery 报告中的元数据快照 SHA 或 PDF 目录 SHA 与候选 manifest 不同');
    }
    assertSha(report.metadataSnapshotSha256, 'report metadataSnapshotSha256');
    assertSha(report.pdfCatalogSha256, 'report pdfCatalogSha256');
    exact(report.counts, ['metadataRecords', 'pdfFiles', ...MATCH_KINDS, 'orphanPdfFiles'], 'discovery report counts');
    const expectedReport = buildReport(candidateManifest);
    if (Object.keys(expectedReport.counts).some(field => report.counts[field] !== expectedReport.counts[field])) {
        throw fail('discovery 报告中的数量与根据候选 manifest 重新计算的数量不同');
    }
    const canonicalReportBytes = canonicalBytes(report);
    if (reportRawBytes !== undefined) {
        const raw = Buffer.isBuffer(reportRawBytes) ? reportRawBytes : Buffer.from(reportRawBytes);
        if (!raw.equals(canonicalReportBytes)) throw fail('discovery 报告文件不是规范的 JSON 字节');
    }
    return { candidateManifest, report, catalogSha256: canonicalCatalogSha256, reportSha256: sha256(canonicalReportBytes) };
}

function parseStrictJsonBytes(bytes, label) {
    let source;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        return JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_DISCOVERY_INTEGRITY') throw error;
        throw fail(`${label} 必须含有效的严格 UTF-8 JSON`);
    }
}

function directJsonFile(directory, name, label) {
    const root = safeAbsoluteDirectory(directory, `${label} directory`);
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) throw fail(`${label} 必须是安全的直接 JSON 文件名`);
    const filename = path.resolve(root, name);
    if (path.dirname(filename) !== root) throw fail(`${label} 必须直接位于其配置目录内`);
    return filename;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function loadDiscoveryHandle(input, reportFilename) {
    let catalogFilename;
    if (typeof input === 'string') {
        catalogFilename = input;
        if (typeof reportFilename !== 'string') throw fail('报告文件名是必需的');
    } else {
        exact(input, ['catalogDir', 'catalogName', 'reportDir', 'reportName'], 'discovery handle input');
        catalogFilename = directJsonFile(input.catalogDir, input.catalogName, 'catalog');
        reportFilename = directJsonFile(input.reportDir, input.reportName, 'report');
    }
    const catalogLoaded = safeAbsoluteFile(catalogFilename, 'candidate manifest file', MAX_BUNDLE_BYTES);
    const reportLoaded = safeAbsoluteFile(reportFilename, 'discovery report file', MAX_BUNDLE_BYTES);
    const catalog = parseStrictJsonBytes(catalogLoaded.bytes, 'candidate manifest file');
    const report = parseStrictJsonBytes(reportLoaded.bytes, 'discovery report file');
    const validated = validateDiscoveryBundle(catalog, report,
        { catalogRawBytes: catalogLoaded.bytes, reportRawBytes: reportLoaded.bytes });
    const metadata = readMetadataSnapshot(validated.candidateManifest.metadataSnapshot.file);
    if (metadata.descriptor.sha256 !== validated.candidateManifest.metadataSnapshot.sha256
        || metadata.descriptor.size !== validated.candidateManifest.metadataSnapshot.size) {
        throw fail('discovery 之后 metadata 快照字节已变化');
    }
    const records = extractRecords(validated.candidateManifest.adapter, metadata.value, validated.candidateManifest.conference);
    if (records.length !== validated.candidateManifest.members.length) throw fail('metadata 快照的记录集合已不再匹配 discovery');
    for (const member of validated.candidateManifest.members) {
        const normalized = normalizeMetadataMember(validated.candidateManifest.adapter, records[member.metadataIndex], member.metadataIndex);
        if (ledgerApi.identityKey(normalized.identity) !== ledgerApi.identityKey(member.identity)
            || normalized.title !== member.title || normalized.numericAlias !== member.numericAlias
            || (validated.candidateManifest.adapter === 'official-proceedings' && normalized.pdfFile !== member.pdfFile)) {
            throw fail('metadata 快照已不再绑定发现到的 member catalog');
        }
    }
    const handle = Object.freeze(Object.create(null));
    DISCOVERY_HANDLES.add(handle);
    DISCOVERY_HANDLE_DATA.set(handle, Object.freeze({
        catalogFilename: fs.realpathSync(catalogLoaded.absolute),
        reportFilename: fs.realpathSync(reportLoaded.absolute),
        candidateManifest: deepFreeze(validated.candidateManifest),
        report: deepFreeze(validated.report),
        catalogSha256: validated.catalogSha256,
        reportSha256: validated.reportSha256
    }));
    return handle;
}

function discoveryHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !DISCOVERY_HANDLES.has(handle)) {
        throw fail('必须提供由 loadDiscoveryHandle 校验并加载的 discovery 对象');
    }
    const data = DISCOVERY_HANDLE_DATA.get(handle);
    return { catalogFilename: data.catalogFilename, reportFilename: data.reportFilename,
        candidateManifest: JSON.parse(JSON.stringify(data.candidateManifest)),
        report: JSON.parse(JSON.stringify(data.report)), catalogSha256: data.catalogSha256, reportSha256: data.reportSha256 };
}

// 只重新校验一次不可变的元数据快照，然后从同一份字节复算全部成员。批量调用方不能
// 对每篇论文都调一次单成员复算：那会把整份元数据快照重读重解析 N 遍。
function replayDiscoveryMembers(handle) {
    if (!handle || typeof handle !== 'object' || !DISCOVERY_HANDLES.has(handle)) {
        throw fail('必须提供由 loadDiscoveryHandle 校验并加载的 discovery 对象');
    }
    const data = DISCOVERY_HANDLE_DATA.get(handle);
    const manifest = data.candidateManifest;
    const loaded = readMetadataSnapshot(manifest.metadataSnapshot.file);
    if (loaded.descriptor.file !== manifest.metadataSnapshot.file
        || loaded.descriptor.sha256 !== manifest.metadataSnapshot.sha256
        || loaded.descriptor.size !== manifest.metadataSnapshot.size) {
        throw fail('discovery 之后 metadata 快照字节已变化');
    }
    const records = extractRecords(manifest.adapter, loaded.value, manifest.conference);
    if (records.length !== manifest.members.length) {
        throw fail('metadata 快照的记录集合已不再匹配 discovery');
    }
    return manifest.members.map(member => {
        if (member.metadataIndex >= records.length) throw fail('metadata member 索引超出了来源记录集合');
        const record = records[member.metadataIndex];
        const normalized = normalizeMetadataMember(manifest.adapter, record, member.metadataIndex);
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        if (ledgerApi.identityKey(normalized.identity) !== sourceIdentity || normalized.title !== member.title
            || normalized.numericAlias !== member.numericAlias
            || (manifest.adapter === 'official-proceedings' && normalized.pdfFile !== member.pdfFile)) {
            throw fail('metadata 记录已不再绑定发现到的 member 身份');
        }
        return {
            conference: JSON.parse(JSON.stringify(manifest.conference)), adapter: manifest.adapter,
            sourceIdentity, identity: JSON.parse(JSON.stringify(member.identity)), metadataIndex: member.metadataIndex,
            metadataSnapshotSha256: manifest.metadataSnapshot.sha256,
            metadataRecordSha256: ledgerApi.stableHash(record),
            metadataRecord: JSON.parse(JSON.stringify(record)),
            match: JSON.parse(JSON.stringify(member.match)), catalogSha256: data.catalogSha256
        };
    });
}

function replayDiscoveryMember(handle, sourceIdentity) {
    if (!handle || typeof handle !== 'object' || !DISCOVERY_HANDLES.has(handle)) {
        throw fail('必须提供由 loadDiscoveryHandle 校验并加载的 discovery 对象');
    }
    if (typeof sourceIdentity !== 'string' || !sourceIdentity) throw fail('sourceIdentity 是必需的');
    const data = DISCOVERY_HANDLE_DATA.get(handle);
    const manifest = data.candidateManifest;
    const member = manifest.members.find(item => ledgerApi.identityKey(item.identity) === sourceIdentity);
    if (!member) throw fail(`来源身份不在 discovery 中：${sourceIdentity}`);
    const loaded = readMetadataSnapshot(manifest.metadataSnapshot.file);
    if (loaded.descriptor.file !== manifest.metadataSnapshot.file
        || loaded.descriptor.sha256 !== manifest.metadataSnapshot.sha256
        || loaded.descriptor.size !== manifest.metadataSnapshot.size) {
        throw fail('discovery 之后 metadata 快照字节已变化');
    }
    const records = extractRecords(manifest.adapter, loaded.value, manifest.conference);
    if (records.length !== manifest.members.length || member.metadataIndex >= records.length) {
        throw fail('metadata 快照的记录集合已不再匹配 discovery');
    }
    const record = records[member.metadataIndex];
    const normalized = normalizeMetadataMember(manifest.adapter, record, member.metadataIndex);
    if (ledgerApi.identityKey(normalized.identity) !== sourceIdentity || normalized.title !== member.title
        || normalized.numericAlias !== member.numericAlias
        || (manifest.adapter === 'official-proceedings' && normalized.pdfFile !== member.pdfFile)) {
        throw fail('metadata 记录已不再绑定发现到的 member 身份');
    }
    return {
        conference: JSON.parse(JSON.stringify(manifest.conference)), adapter: manifest.adapter,
        sourceIdentity, identity: JSON.parse(JSON.stringify(member.identity)), metadataIndex: member.metadataIndex,
        metadataSnapshotSha256: manifest.metadataSnapshot.sha256,
        metadataRecordSha256: ledgerApi.stableHash(record),
        metadataRecord: JSON.parse(JSON.stringify(record)),
        match: JSON.parse(JSON.stringify(member.match)), catalogSha256: data.catalogSha256
    };
}

function validateAcquisitionReceiptBinding(binding, conference, metadataSnapshot, pdfRoot) {
    exact(binding, ['catalogReceiptFile', 'catalogReceiptFileSha256', 'catalogReceiptSha256',
        'metadataFile', 'metadataSha256', 'paperSetSha256', 'pdfReceiptSetSha256', 'providerId', 'root'],
    'candidate manifest acquisitionReceipt');
    if (binding.providerId !== conference.id || binding.root !== pdfRoot
        || binding.metadataFile !== metadataSnapshot.file
        || binding.catalogReceiptFile !== path.join(pdfRoot, 'catalog.receipt.json')
        || binding.metadataSha256 !== metadataSnapshot.sha256) {
        throw fail('候选 manifest 的获取 receipt 路径或 provider 与 discovery 输入不匹配');
    }
    assertSha(binding.catalogReceiptFileSha256, 'acquisitionReceipt.catalogReceiptFileSha256');
    assertSha(binding.catalogReceiptSha256, 'acquisitionReceipt.catalogReceiptSha256');
    assertSha(binding.metadataSha256, 'acquisitionReceipt.metadataSha256');
    assertSha(binding.paperSetSha256, 'acquisitionReceipt.paperSetSha256');
    assertSha(binding.pdfReceiptSetSha256, 'acquisitionReceipt.pdfReceiptSetSha256');
    const replayed = officialAcquisition.replayCatalog(binding.providerId, binding.root);
    const verified = officialAcquisition.verifyAcquisition({ providerId: binding.providerId, outputRoot: binding.root });
    if (!verified.complete || replayed.metadataSha256 !== binding.metadataSha256
        || replayed.receipt.receiptSha256 !== binding.catalogReceiptSha256
        || officialAcquisition.sha256(fs.readFileSync(binding.catalogReceiptFile)) !== binding.catalogReceiptFileSha256
        || officialAcquisition.stableHash(replayed.metadata.papers) !== binding.paperSetSha256) {
        throw fail('候选 manifest 的获取 receipt 无法重放官方 bundle');
    }
    const pdfReceiptSet = replayed.metadata.papers.filter(paper => paper.pdfUrl !== null).map(paper => {
        const receipt = officialAcquisition.replayPdfReceipt(replayed, paper);
        return { paperId: paper.id, receiptSha256: receipt.receiptSha256,
            receiptFileSha256: officialAcquisition.sha256(fs.readFileSync(path.join(replayed.paths.receipts, `${paper.id}.json`))) };
    });
    if (officialAcquisition.stableHash(pdfReceiptSet) !== binding.pdfReceiptSetSha256) {
        throw fail('候选 manifest 的 PDF receipt 集合已变化');
    }
    return binding;
}

function officialAcquisitionBindingFromRoot(conference, metadataSnapshot, root) {
    const replayed = officialAcquisition.replayCatalog(conference.id, root);
    const verified = officialAcquisition.verifyAcquisition({ providerId: conference.id, outputRoot: root });
    if (!verified.complete) throw fail(`官方获取不完整：${verified.missing.join(', ')}`);
    const receiptFile = path.join(root, 'catalog.receipt.json');
    const pdfReceiptSet = replayed.metadata.papers.filter(paper => paper.pdfUrl !== null).map(paper => {
        const receipt = officialAcquisition.replayPdfReceipt(replayed, paper);
        return { paperId: paper.id, receiptSha256: receipt.receiptSha256,
            receiptFileSha256: officialAcquisition.sha256(fs.readFileSync(path.join(replayed.paths.receipts, `${paper.id}.json`))) };
    });
    const binding = { providerId: conference.id, root, metadataFile: metadataSnapshot.file,
        metadataSha256: metadataSnapshot.sha256, catalogReceiptFile: receiptFile,
        catalogReceiptSha256: replayed.receipt.receiptSha256,
        catalogReceiptFileSha256: officialAcquisition.sha256(fs.readFileSync(receiptFile)),
        paperSetSha256: officialAcquisition.stableHash(replayed.metadata.papers),
        pdfReceiptSetSha256: officialAcquisition.stableHash(pdfReceiptSet) };
    validateAcquisitionReceiptBinding(binding, conference, metadataSnapshot, root);
    return binding;
}

function officialAcquisitionBinding(conference, metadata, pdfs, acquisitionRoot) {
    if (path.resolve(acquisitionRoot) !== pdfs.root) throw fail('acquisitionRoot 必须等于 pdfRoot');
    return officialAcquisitionBindingFromRoot(conference, metadata.descriptor, pdfs.root);
}

function discoverConference({ adapter, year, conferenceId = null, metadataFile, pdfRoot, acquisitionRoot = null } = {}) {
    if (!ADAPTERS.has(adapter)) throw fail('adapter 必须是以下之一：icassp、iclr、icml、official-proceedings');
    if (!Number.isInteger(year) || year < 1900 || year > 2100) throw fail('year 必须是受支持的四位整数');
    const metadata = readMetadataSnapshot(metadataFile);
    const pdfs = catalogPdfs(pdfRoot);
    let conference;
    if (adapter === 'official-proceedings') {
        if (typeof conferenceId !== 'string' || !conferenceId) throw fail('official-proceedings requires conferenceId');
        conference = officialConference(metadata.value?.conference);
        if (conference.id !== conferenceId || conference.year !== year) {
            throw fail('official-proceedings metadata conference must match conferenceId and year');
        }
    } else {
        conference = { id: `${adapter}-${year}`, year };
        if (conferenceId !== null && conferenceId !== conference.id) throw fail('conferenceId 与 adapter 和 year 不一致');
    }
    const records = extractRecords(adapter, metadata.value, conference);
    if (!records.length) throw fail('metadata 快照必须至少含一篇论文');
    const members = records.map((record, index) => normalizeMetadataMember(adapter, record, index));
    const identityKeys = members.map(member => ledgerApi.identityKey(member.identity));
    if (new Set(identityKeys).size !== identityKeys.length) throw fail('metadata snapshot contains duplicate primary identities');
    const byPath = descriptorMap(pdfs.catalog);
    for (const member of members) member.match = matchMember(adapter, member, pdfs.catalog, byPath);
    if (['icassp', 'official-proceedings'].includes(adapter)) markSharedIcasspCandidatesAmbiguous(members);
    members.sort((left, right) => compare(ledgerApi.identityKey(left.identity), ledgerApi.identityKey(right.identity)));
    const manifest = {
        contract: CONTRACT,
        version: VERSION,
        adapter,
        conference,
        metadataSnapshot: metadata.descriptor,
        pdfRoot: pdfs.root,
        pdfCatalogSha256: pdfs.catalogSha256,
        pdfCatalog: pdfs.catalog,
        members,
        memberSetSha256: ledgerApi.memberSetSha256(members)
    };
    if (acquisitionRoot !== null) {
        if (adapter !== 'official-proceedings') throw fail('acquisitionRoot 仅对 official-proceedings 有效');
        manifest.acquisitionReceipt = officialAcquisitionBinding(conference, metadata, pdfs, acquisitionRoot);
    }
    return { manifest, report: buildReport(manifest) };
}

module.exports = {
    CONTRACT, REPORT_CONTRACT, VERSION, ADAPTERS, MATCH_KINDS, MAX_METADATA_BYTES, MAX_PDF_BYTES,
    canonicalBytes, readMetadataSnapshot, catalogPdfs, normalizedTitle, discoverConference, buildReport,
    validateDiscoveryBundle, loadDiscoveryHandle, discoveryHandleSnapshot, replayDiscoveryMember,
    replayDiscoveryMembers, SAFE_JSON_NAME,
    safeAbsoluteDirectory, safeAbsoluteFile, validateAcquisitionReceiptBinding,
    officialAcquisitionBindingFromRoot
};
