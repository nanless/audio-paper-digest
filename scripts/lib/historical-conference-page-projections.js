'use strict';

// 用清单元数据、本地元数据记录里的标题、以及页面 frontmatter 里的标题指纹，
// 在冻结的历史会议页面和保留的本地来源之间建立对应关系。日更 ICML 的对应关系
// 必须依赖目录里已核验的官方 poster 记录。历史页面正文和之前生成的分析结果
// 都不作为重写输入。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const conference = require('./historical-conference-crawl-authority.js');
const icmlPosterApi = require('./historical-icml-poster-authority.js');

const CONTRACT = 'historical-conference-page-projections-v3';
const VERSION = 3;
const CATALOG_CONTRACT = 'merged-good-historical-local-data-v5';
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;

class HistoricalConferencePageProjectionError extends Error {
    constructor(message) {
        super(`历史会议页面映射被拒绝：${message}`);
        this.name = 'HistoricalConferencePageProjectionError';
        this.code = 'HISTORICAL_CONFERENCE_PAGE_PROJECTION_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalConferencePageProjectionError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
function sortJsonKeys(value) {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonKeys(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(sortJsonKeys(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(sortJsonKeys(value), null, 2)}\n`, 'utf8');
const validSha = value => SHA_RE.test(String(value || ''));

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是普通对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} is missing required fields or contains unsupported fields.`);
    }
}

function safeDirectory(directory, label, create = false) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对目录路径`);
    const absolute = path.resolve(directory);
    if (!fs.existsSync(absolute)) {
        if (!create) fail(`${label} 不存在`);
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    let cursor = path.parse(absolute).root;
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 的路径不安全：每一层都必须是目录，且不能是符号链接`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} 的路径不安全：解析后的真实位置与请求的目录不一致`);
    return absolute;
}

function readStableFile(filename, label, maxBytes = MAX_JSON_BYTES) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} 必须是绝对文件路径`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `parent directory of ${label}`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            fail(`${label} 不能安全读取：它不是单链接普通文件，文件身份与路径不符，或超过大小上限`);
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail(`${label} 读取期间不一致：字节数、设备号、inode 或文件大小发生了变化`);
        return { filename: absolute, bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail('JSON 里不允许出现重复的对象键');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readStableJson(filename, label, maxBytes = MAX_JSON_BYTES) {
    const loaded = readStableFile(filename, label, maxBytes); let value;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text); value = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalConferencePageProjectionError) throw error;
        fail(`${label} must contain valid UTF-8 JSON.`);
    }
    if (!plain(value) && !Array.isArray(value)) fail(`${label} 的顶层必须是 JSON 对象或数组`);
    return { ...loaded, value };
}

function normalizeCurrentCatalog(value) {
    // 用目录生产者的校验器检查当前的 scoped v5 格式。较早的采集记录可能用了同样的
    // contract 和 version，却省略 scopeBinding、少带两份输入清单，或者仍然保留本地
    // arXiv 写作来源。这些记录不能当作当前目录接受。
    let normalized;
    try {
        normalized = require('./historical-direct-rewrite-input-catalog.js').normalizeCatalog(value);
    } catch (error) {
        fail(`The scoped v5 local source catalog failed validation: ${error.message}`);
    }
    return normalized;
}

function normalizeCatalog(value) {
    return normalizeCurrentCatalog(value).entries.filter(entry => entry.paperId.startsWith('conference:'))
        .map(clone).sort((left, right) => left.paperId.localeCompare(right.paperId));
}

function normalizeInventory(value) {
    if (!plain(value) || !plain(value.counts) || !Array.isArray(value.pages)
        || !validSha(value.pageSetSha256) || !validSha(value.ledgerSha256)) {
        fail('历史页面清单必须含有 counts 对象、pages 数组，以及合法的页面集合 SHA 和 ledger SHA');
    }
    const pageKeys = new Set();
    const pages = value.pages.filter(page => page?.kind === 'paper').map((page, index) => {
        if (!PAGE_KEY_RE.test(String(page.pageId || '')) || typeof page.path !== 'string' || !page.path
            || !validSha(page.contentSha256) || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || !plain(page.identityHints)
            || !Array.isArray(page.identityHints.candidates) || pageKeys.has(page.pageId)) {
            fail(`第 ${index} 个历史论文页面字段不合法，或 page ID 重复`);
        }
        pageKeys.add(page.pageId);
        return { pageKey: page.pageId, pagePath: page.path, primaryUrl: typeof page.primaryUrl === 'string' ? page.primaryUrl : null,
            pageContentSha256: page.contentSha256, scope: clone(page.scope), cohortDate: String(page.cohortDate || ''),
            identityHints: clone(page.identityHints) };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { pageSetSha256: value.pageSetSha256, ledgerSha256: value.ledgerSha256, pages };
}

// 有些历史 Hugo 标题会丢掉完整的内联 TeX 表达式，比如 `$\tau$-Voice` 变成 `-Voice`。
// 匹配时要么用原标题指纹，要么用按这条规则去掉之后算出的指纹。这不是模糊标题匹配；
// 调用方必须拒绝论文 ID 之间的冲突。
function getPageTitleFingerprints(title, label = 'conference metadata title') {
    const exactFingerprint = conference.titleFingerprint(title, label);
    const omittedInlineTex = title.replace(/\$(?:\\[\s\S]|[^$\\])*\$/gu, '');
    if (!omittedInlineTex.trim()) return [exactFingerprint];
    const displayFingerprint = conference.titleFingerprint(omittedInlineTex, `${label} without inline TeX`);
    return [...new Set([exactFingerprint, displayFingerprint])].sort();
}

function getSourceTitleFingerprints(source, paperId, cache) {
    if (!plain(source) || !plain(source.metadata) || !plain(source.pdf)
        || source.pdf.availability !== 'available' || !validSha(source.pdf.sha256)
        || typeof source.pdf.absolutePath !== 'string' || !path.isAbsolute(source.pdf.absolutePath)) return null;
    const metadata = source.metadata;
    if (typeof metadata.absolutePath !== 'string' || !path.isAbsolute(metadata.absolutePath)
        || !validSha(metadata.sha256) || !Number.isSafeInteger(metadata.recordIndex) || metadata.recordIndex < 0
        || !validSha(metadata.metadataIdentityBindingSha256)) return null;
    let snapshot = cache.get(metadata.absolutePath);
    if (!snapshot) {
        snapshot = readStableJson(metadata.absolutePath, 'conference metadata file', 64 * 1024 * 1024);
        cache.set(metadata.absolutePath, snapshot);
    }
    if (snapshot.fileSha256 !== metadata.sha256) fail(`${paperId}：会议元数据文件的 SHA 与来源记录不符`);
    const records = Array.isArray(snapshot.value) ? snapshot.value : snapshot.value?.papers || snapshot.value?.results;
    if (!Array.isArray(records) || !plain(records[metadata.recordIndex])
        || typeof (records[metadata.recordIndex].title || records[metadata.recordIndex].name) !== 'string') {
        fail(`${paperId}：元数据文件在记录的索引处没有字符串 title 的记录`);
    }
    const title = records[metadata.recordIndex].title || records[metadata.recordIndex].name;
    return { originalTitleFingerprint: conference.titleFingerprint(title, 'conference metadata title'),
        pageTitleFingerprints: getPageTitleFingerprints(title, 'conference metadata title') };
}

function selectConferenceSources(entry, cache) {
    const selected = [];
    for (const source of entry.sources) {
        const sourceTitleFingerprints = getSourceTitleFingerprints(source, entry.paperId, cache);
        if (!sourceTitleFingerprints) continue;
        selected.push({ sourceSet: String(source.sourceSet || ''), provenance: String(source.provenance || ''),
            metadata: clone(source.metadata), pdf: clone(source.pdf), metadataTitleFingerprintSha256: sourceTitleFingerprints.originalTitleFingerprint,
            titleProjectionFingerprintSha256s: sourceTitleFingerprints.pageTitleFingerprints,
            sourceBindingSha256: source.sourceBindingSha256 });
    }
    if (!selected.length) fail(`${entry.paperId}：没有保留下来的本地会议来源同时满足 PDF 和元数据要求`);
    return selected.sort((left, right) => stableHash(left).localeCompare(stableHash(right)));
}

function conferenceScopeFor(paperId) {
    const match = String(paperId).match(/^conference:([a-z0-9]+(?:-[a-z0-9]+)*):(\d{4}):/);
    if (!match) fail(`会议论文 ID 格式不合法：${paperId}`);
    return { type: 'conference', key: `${match[1]}-${match[2]}` };
}

function buildConferencePageMappings({ catalog, catalogFileSha256, inventory, blogRoot } = {}) {
    if (!validSha(catalogFileSha256)) fail('需要提供合法的目录文件 SHA');
    const currentCatalog = normalizeCurrentCatalog(catalog); const entries = currentCatalog.entries
        .filter(entry => entry.paperId.startsWith('conference:')).map(clone);
    const history = normalizeInventory(inventory);
    if (currentCatalog.scopeBinding.inventoryLedgerSha256 !== history.ledgerSha256
        || currentCatalog.scopeBinding.inventoryPageSetSha256 !== history.pageSetSha256) {
        fail('这份 scoped v5 目录引用的是另一份冻结页面清单');
    }
    const cache = new Map(); const candidatesByScopeAndTitle = new Map();
    const sourceByPaperId = new Map();
    for (const entry of entries) {
        const sources = selectConferenceSources(entry, cache); sourceByPaperId.set(entry.paperId, sources);
        const scope = conferenceScopeFor(entry.paperId);
        for (const source of sources) {
            for (const fingerprint of source.titleProjectionFingerprintSha256s) {
                const key = `${scope.key}\0${fingerprint}`;
                const matchingPaperIds = candidatesByScopeAndTitle.get(key) || new Set();
                matchingPaperIds.add(entry.paperId); candidatesByScopeAndTitle.set(key, matchingPaperIds);
            }
        }
    }
    const pagesByPaperId = new Map(); const unmatchedPages = [];
    for (const page of history.pages.filter(item => item.scope.type === 'conference')) {
        const pageTitleRecord = conference.pageTitleBinding({ blogRoot, pageKey: page.pageKey,
            pagePath: page.pagePath, pageContentSha256: page.pageContentSha256 });
        const matchingPaperIds = candidatesByScopeAndTitle.get(`${page.scope.key}\0${pageTitleRecord.titleFingerprintSha256}`)
            || new Set();
        if (matchingPaperIds.size === 0) { unmatchedPages.push({ pageKey: page.pageKey, pagePath: page.pagePath,
            scope: page.scope, reason: 'no-retained-local-title-match' }); continue; }
        if (matchingPaperIds.size !== 1) fail(`${page.pageKey}: the frontmatter title matches more than one retained conference paper.`);
        const paperId = [...matchingPaperIds][0]; const mappedPages = pagesByPaperId.get(paperId) || [];
        mappedPages.push({ ...page, titleFingerprintSha256: pageTitleRecord.titleFingerprintSha256,
            mapping: 'retained-local-title-fingerprint', dailyIcmlBinding: null }); pagesByPaperId.set(paperId, mappedPages);
    }
    const dailyPages = new Map(history.pages.filter(item => item.scope.type === 'daily').map(page => [page.pageKey, page]));
    const knownConferenceIds = new Set(entries.map(entry => entry.paperId));
    for (const rawBinding of currentCatalog.dailyIcmlPosterRoutableBindings) {
        const dailyPosterPageRecord = icmlPosterApi.normalizeDailyPageBinding(rawBinding); const page = dailyPages.get(dailyPosterPageRecord.page.pageKey);
        const paperId = `conference:icml:2026:openreview-forum-id:${dailyPosterPageRecord.poster.forumId}`;
        if (!page || page.identityHints?.status !== 'none' || page.pagePath !== dailyPosterPageRecord.page.pagePath
            || page.pageContentSha256 !== dailyPosterPageRecord.page.pageContentSha256 || stableHash(page.scope) !== stableHash(dailyPosterPageRecord.page.scope)) {
            fail('日更 ICML poster 记录与冻结页面清单不符');
        }
        // PDF 不可得的 poster 记录留在目录里，但不加入页面映射和计划。只有后续 v2 清单
        // 把下载到的 PDF 记为 available，它们才具备资格。
        if (!knownConferenceIds.has(paperId)) continue;
        const mappedPages = pagesByPaperId.get(paperId) || [];
        if (mappedPages.some(item => item.pageKey === page.pageKey)) fail(`${page.pageKey}：该页面已经分配给这篇论文`);
        mappedPages.push({ ...page, titleFingerprintSha256: null, mapping: dailyPosterPageRecord.mapping,
            dailyIcmlBinding: dailyPosterPageRecord }); pagesByPaperId.set(paperId, mappedPages);
    }
    const pageMappings = entries.map(entry => {
        const pages = (pagesByPaperId.get(entry.paperId) || []).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        if (!pages.length) fail(`${entry.paperId}：没有冻结的历史页面分配给它`);
        return { paperId: entry.paperId, sourceSetSha256: stableHash(sourceByPaperId.get(entry.paperId)),
            pageKeys: pages.map(page => page.pageKey), pages: pages.map(page => ({ pageKey: page.pageKey,
                pagePath: page.pagePath, primaryUrl: page.primaryUrl, pageContentSha256: page.pageContentSha256,
                cohortDate: page.cohortDate, scope: page.scope, titleFingerprintSha256: page.titleFingerprintSha256,
                mapping: page.mapping, dailyIcmlBinding: page.dailyIcmlBinding })) };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const mappingRecordFields = { contract: CONTRACT, version: VERSION, catalogFileSha256,
        inventory: { ledgerSha256: history.ledgerSha256, pageSetSha256: history.pageSetSha256 },
        projections: pageMappings, projectionSetSha256: stableHash(pageMappings),
        unmatchedPages: unmatchedPages.sort((left, right) => left.pageKey.localeCompare(right.pageKey)) };
    return { ...mappingRecordFields, artifactSha256: stableHash(mappingRecordFields) };
}

function normalizeConferencePageMappingRecord(value) {
    exact(value, ['contract', 'version', 'catalogFileSha256', 'inventory', 'projections',
        'projectionSetSha256', 'unmatchedPages', 'artifactSha256'], 'conference page mapping record');
    if (value.contract !== CONTRACT || value.version !== VERSION || !validSha(value.catalogFileSha256)
        || !plain(value.inventory) || !validSha(value.inventory.ledgerSha256)
        || !validSha(value.inventory.pageSetSha256) || !Array.isArray(value.projections)
        || !Array.isArray(value.unmatchedPages) || !validSha(value.projectionSetSha256)
        || !validSha(value.artifactSha256)) fail('会议页面映射记录的 contract、version、字段类型或 SHA 不合法');
    const seenPages = new Set(); const pageMappings = value.projections.map((item, index) => {
        exact(item, ['paperId', 'sourceSetSha256', 'pageKeys', 'pages'], `projections[${index}]`);
        if (typeof item.paperId !== 'string' || !item.paperId.startsWith('conference:')
            || !validSha(item.sourceSetSha256) || !Array.isArray(item.pageKeys) || !item.pageKeys.length
            || !Array.isArray(item.pages) || item.pageKeys.length !== item.pages.length) fail('某条会议论文映射的 paper ID 或来源 SHA 不合法，或页面列表为空、前后不一致');
        const pages = item.pages.map((page, pageIndex) => {
            exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'pageContentSha256', 'cohortDate', 'scope',
                'titleFingerprintSha256', 'mapping', 'dailyIcmlBinding'],
                `projections[${index}].pages[${pageIndex}]`);
            if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
                || !(page.primaryUrl === null || typeof page.primaryUrl === 'string') || !validSha(page.pageContentSha256) || typeof page.cohortDate !== 'string' || !plain(page.scope)
                || typeof page.scope.type !== 'string' || typeof page.scope.key !== 'string'
                || !(page.titleFingerprintSha256 === null || validSha(page.titleFingerprintSha256)) || seenPages.has(page.pageKey)
                || !['retained-local-title-fingerprint', icmlPosterApi.DIRECT_PAGE_MAPPING,
                    icmlPosterApi.SUMMARY_SECTION_MAPPING].includes(page.mapping)) {
                fail('某条已映射的会议页面字段不合法、映射类型不支持，或 page key 重复');
            }
            if ([icmlPosterApi.DIRECT_PAGE_MAPPING, icmlPosterApi.SUMMARY_SECTION_MAPPING].includes(page.mapping)) {
                const binding = icmlPosterApi.normalizeDailyPageBinding(page.dailyIcmlBinding);
                if (page.scope.type !== 'daily' || !String(item.paperId).startsWith('conference:icml:2026:')
                    || page.titleFingerprintSha256 !== null || binding.page.pageKey !== page.pageKey
                    || binding.page.pagePath !== page.pagePath || binding.page.pageContentSha256 !== page.pageContentSha256
                    || item.paperId !== `conference:icml:2026:openreview-forum-id:${binding.poster.forumId}`) {
                    fail('日更 ICML 页面映射与 poster 记录或 paper ID 不符');
                }
            } else if (page.scope.type !== 'conference' || page.dailyIcmlBinding !== null) {
                fail('按标题建立的会议映射必须用 conference scope，且不能带日更 ICML poster 记录');
            }
            seenPages.add(page.pageKey); return clone(page);
        }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        if (item.pageKeys.join('\0') !== pages.map(page => page.pageKey).join('\0')) fail('pageKeys 列表与按 page key 排序后的映射页面不一致');
        return { paperId: item.paperId, sourceSetSha256: item.sourceSetSha256,
            pageKeys: item.pageKeys.slice(), pages };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(pageMappings.map(item => item.paperId)).size !== pageMappings.length
        || pageMappings.some((item, index) => index && pageMappings[index - 1].paperId.localeCompare(item.paperId) >= 0)) {
        fail('会议论文 ID 有重复，或排序后不是递增顺序');
    }
    const unmatchedPages = value.unmatchedPages.map((page, index) => {
        exact(page, ['pageKey', 'pagePath', 'scope', 'reason'], `unmatchedPages[${index}]`);
        if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
            || !plain(page.scope) || page.reason !== 'no-retained-local-title-match' || seenPages.has(page.pageKey)) {
            fail('某条未匹配的会议页面字段不合法、原因不支持，或 page key 重复');
        }
        seenPages.add(page.pageKey); return clone(page);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const mappingRecordFields = { contract: CONTRACT, version: VERSION, catalogFileSha256: value.catalogFileSha256,
        inventory: clone(value.inventory), projections: pageMappings, projectionSetSha256: value.projectionSetSha256, unmatchedPages };
    if (stableHash(pageMappings) !== value.projectionSetSha256 || stableHash(mappingRecordFields) !== value.artifactSha256) {
        fail('会议页面映射的 SHA 与规范化后的映射或完整记录不符');
    }
    return { ...mappingRecordFields, artifactSha256: value.artifactSha256 };
}

function writeConferencePageMappingRecord({ root, outputName, artifact } = {}) {
    if (!SAFE_NAME_RE.test(String(outputName || ''))) fail('会议页面映射的输出名不安全：必须符合允许的 JSON 文件名格式');
    const directory = safeDirectory(root, 'conference page mapping output directory', true);
    const normalized = normalizeConferencePageMappingRecord(artifact); const filename = path.join(directory, outputName);
    const bytes = prettyBytes(normalized); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, artifact: normalized };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readStableFile(filename, 'existing conference page mapping file').bytes.equals(bytes)) {
            fail(`拒绝用不同字节覆盖已有的会议页面映射文件：${outputName}`);
        }
        return { status: 'recovered', filename, artifact: normalized };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildFromFiles({ catalogFile, inventoryFile, blogRoot } = {}) {
    const catalog = readStableJson(catalogFile, 'local source catalog');
    const inventory = readStableJson(inventoryFile, 'historical inventory');
    const currentCatalog = normalizeCurrentCatalog(catalog.value);
    if (currentCatalog.scopeBinding.inventoryPath !== inventory.filename
        || currentCatalog.scopeBinding.inventorySha256 !== inventory.fileSha256) {
        fail('清单文件路径或 SHA 与 scoped v5 目录不符');
    }
    return buildConferencePageMappings({ catalog: catalog.value, catalogFileSha256: catalog.fileSha256,
        inventory: inventory.value, blogRoot });
}

module.exports = { CONTRACT, VERSION, CATALOG_CONTRACT, SAFE_NAME_RE, HistoricalConferencePageProjectionError,
    stableHash, prettyBytes, safeDirectory, readStableFile, readStableJson, normalizeCatalog, normalizeInventory,
    getPageTitleFingerprints, selectConferenceSources,
    buildConferencePageMappings, normalizeConferencePageMappingRecord,
    writeConferencePageMappingRecord, buildFromFiles };
