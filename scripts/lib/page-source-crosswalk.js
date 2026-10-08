'use strict';

// 来源身份对应表。verified 分配必须引用重新核对过的、已认证的来源或身份授权；
// 标题从不作为身份证据。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const authorityApi = require('./paper-source-authority.js');
const archiveIdentityApi = require('./historical-archive-crawl-authority.js');
const localCrawlIdentityApi = require('./historical-local-crawl-authority.js');
const conferenceIdentityApi = require('./historical-conference-crawl-authority.js');
const identityApi = require('./paper-identity.js');

const LEDGER_CONTRACT = 'historical-page-ledger-v1';
const LEDGER_RECEIPT_CONTRACT = 'historical-page-ledger-receipt-v1';
const CONTRACT = 'page-source-crosswalk-v1';
const DECISION_CONTRACT = 'page-source-crosswalk-decision-v1';
const LOCK_OWNER_CONTRACT = 'page-source-crosswalk-lock-owner-v1';
const FINAL_RECEIPT_CONTRACT = 'page-source-crosswalk-final-receipt-v1';
const VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const GIT_OID_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const LINK_TYPES = new Set(['markdown-inline', 'html-anchor']);
const LINK_STATUSES = new Set(['resolved', 'unresolved', 'ambiguous']);
const PUBLICATION_EVIDENCE_FIELDS = new Set([
    'paper_digest_abstract_sha256', 'paper_digest_api_reader_article_sha256',
    'paper_digest_api_reader_author_count', 'paper_digest_api_reader_author_identity_contract',
    'paper_digest_api_reader_author_identity_sha256', 'paper_digest_api_reader_contract',
    'paper_digest_api_reader_decision_projection', 'paper_digest_api_reader_plan_sha256',
    'paper_digest_api_reader_resource_count', 'paper_digest_api_reader_resource_identity_contract',
    'paper_digest_api_reader_resource_identity_sha256', 'paper_digest_api_reader_source_binding_contract',
    'paper_digest_api_reader_source_bindings_sha256', 'paper_digest_api_reader_source_formula_count',
    'paper_digest_api_reader_source_table_count', 'paper_digest_api_reader_structured_artifacts_sha256',
    'paper_digest_arxiv_id', 'paper_digest_arxiv_version', 'paper_digest_arxiv_versioned_id',
    'paper_digest_document_type', 'paper_digest_fresh_authoring_contract', 'paper_digest_fresh_authoring_sha256',
    'paper_digest_manual_depth', 'paper_digest_page_type', 'paper_digest_pipeline_owned',
    'paper_digest_primary_task', 'paper_digest_primary_method', 'paper_digest_rank_bucket',
    'paper_digest_taxonomy_concepts', 'paper_digest_taxonomy_contract',
    'paper_digest_taxonomy_registry_sha256', 'paper_digest_taxonomy_registry_version',
    'paper_digest_taxonomy_scope', 'paper_digest_taxonomy_selection_contract',
    'paper_digest_reader_article_sha256',
    'paper_digest_reader_quality', 'paper_digest_score', 'paper_digest_sidecars',
    'paper_digest_tutorial_artifact_plan_sha256', 'paper_digest_tutorial_contract',
    'paper_digest_tutorial_payload_contract', 'paper_digest_tutorial_payload_sha256',
    'paper_digest_tutorial_quality_sha256', 'paper_digest_workbench_contract'
]);
const { PAGE_TAG_FIELDS, LEGACY_PAGE_TAG_FIELDS } = require('./page-tag-metadata.js');
const CURRENT_PUBLICATION_EVIDENCE_FIELDS = new Set([...PUBLICATION_EVIDENCE_FIELDS, ...PAGE_TAG_FIELDS]);
const PRESERVED_PUBLICATION_STRING_FIELDS = new Set([
    'paper_digest_arxiv_id', 'paper_digest_arxiv_versioned_id', 'paper_digest_page_type'
]);
const LEGACY_SCAN_POLICY = Object.freeze({ contract: 'historical-page-scan-policy-v3', bodyRetention: 'sha256-only',
    identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
    linkOffsetUnit: 'utf8-byte-body-relative',
    taxonomyRoutes: 'unverified-candidates-v2', publicationEvidence: 'schema-checked-hash-default-whitelist-v3',
    targetRecordBinding: 'target-page-snapshot-sha256-v1' });
const PREVIOUS_SCAN_POLICY = Object.freeze({ contract: 'historical-page-scan-policy-v4', bodyRetention: 'sha256-only',
    identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
    linkOffsetUnit: 'utf8-byte-body-relative',
    tagRoutes: 'unverified-candidates-v2', publicationEvidence: 'schema-checked-hash-default-whitelist-v4',
    targetRecordBinding: 'target-page-snapshot-sha256-v1' });
const SCAN_POLICY = Object.freeze({ ...PREVIOUS_SCAN_POLICY,
    contract: 'historical-page-scan-policy-v5', tagRoutes: 'unverified-candidates-v3' });

function scanFormatFor(policy) {
    // 策略只选择对应字段；页面和来源仍按原完整对象核验，不转换旧记录。
    const formats = [
        { policy: LEGACY_SCAN_POLICY, evidenceFields: PUBLICATION_EVIDENCE_FIELDS,
            candidateField: 'legacyTaxonomyCandidates', groupField: 'taxonomy' },
        { policy: PREVIOUS_SCAN_POLICY, evidenceFields: CURRENT_PUBLICATION_EVIDENCE_FIELDS,
            candidateField: 'legacyTaxonomyCandidates', groupField: 'taxonomy' },
        { policy: SCAN_POLICY, evidenceFields: CURRENT_PUBLICATION_EVIDENCE_FIELDS,
            candidateField: 'legacyTagRouteCandidates', groupField: 'routeGroup' }
    ];
    const format = formats.find(item => stableHash(policy) === stableHash(item.policy));
    if (!format) throw new PageSourceCrosswalkError('历史页面扫描策略不受支持。');
    exact(policy, Object.keys(format.policy), '历史页面扫描策略');
    return format;
}
const FINAL_REVIEW_STATUSES = new Set(['needs-review', 'blocked', 'conflict']);
const ALL_STATUSES = new Set(['pending', ...FINAL_REVIEW_STATUSES, 'verified']);
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_DECISION_BYTES = 1024 * 1024;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
// 不透明、带身份检查的恢复策略。只有两个保留本地爬虫的 CLI 会拿到这些值；
// 任意字符串或新建的 Symbol 都不能让一次普通 crosswalk 改动获得立即回收的资格。
// 它们只用于在正常两小时租约到期前，清掉本机中断的本地批次。
const HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY = Symbol(
    'historical-local-crawl-batch-local-dead-owner-recovery-v1'
);
const HISTORICAL_CONFERENCE_CRAWL_BATCH_LOCK_RECOVERY = Symbol(
    'historical-conference-crawl-batch-local-dead-owner-recovery-v1'
);
const INVENTORY_HANDLES = new WeakSet();
const INVENTORY_HANDLE_DATA = new WeakMap();
const DECISION_HANDLES = new WeakSet();
const DECISION_HANDLE_DATA = new WeakMap();
const LOCK_HANDLES = new WeakSet();
const LOCK_HANDLE_DATA = new WeakMap();
const ACTIVE_LOCK_HANDLES = new Set();
const LOCK_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);
let lockSignalHandlersInstalled = false;
let handlingLockSignal = false;

class PageSourceCrosswalkError extends Error {
    constructor(message) {
        super(`Page-source crosswalk rejected: ${message}`);
        this.name = 'PageSourceCrosswalkError';
        this.code = 'PAGE_SOURCE_CROSSWALK_INTEGRITY';
    }
}

function fail(message) { throw new PageSourceCrosswalkError(message); }
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
// Python 侧（historical_page_scan.py 的 _json_value）先把整数取值的浮点转成 int 再
// 交给 json.dumps，所以整数取值这里也写整数文本。非整型 float 用 repr 的最短往返
// 表示：十进制指数小于 -4 或不小于 16 时写成科学计数法，指数至少两位并带符号
// （2e-05、1e+16）。JSON.stringify 用 ECMAScript 规则（0.00002、1e-7、1e+21），
// 两条规则在指数区间和指数位数上都不同。
function pythonNumberText(value) {
    if (Number.isInteger(value)) return BigInt(value).toString();
    const [mantissa, exponentText] = value.toExponential().split('e');
    const exponent = Number(exponentText);
    if (exponent < -4 || exponent >= 16) {
        return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    }
    const negative = mantissa.startsWith('-');
    const digits = mantissa.replace('-', '').replace('.', '');
    const point = exponent + 1;
    const body = point <= 0
        ? `0.${'0'.repeat(-point)}${digits}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return negative ? `-${body}` : body;
}
function pythonJson(value, indent = 0) {
    function render(item, depth, forceFloat = false) {
        if (item === null || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) fail('JSON 证据含非有限数值');
            if (forceFloat && Number.isInteger(item)) return `${item}.0`;
            return pythonNumberText(item);
        }
        if (typeof item === 'string') return JSON.stringify(item);
        const newline = indent ? '\n' : ''; const separator = indent ? ',\n' : ',';
        if (Array.isArray(item)) {
            if (!item.length) return '[]';
            const padding = indent ? ' '.repeat((depth + 1) * indent) : '';
            const closing = indent ? ' '.repeat(depth * indent) : '';
            return `[${newline}${item.map(value => `${padding}${render(value, depth + 1)}`).join(separator)}${newline}${closing}]`;
        }
        if (!plain(item)) fail('JSON 证据含非普通对象');
        const keys = Object.keys(item).sort();
        if (!keys.length) return '{}';
        const padding = indent ? ' '.repeat((depth + 1) * indent) : '';
        const closing = indent ? ' '.repeat(depth * indent) : '';
        const colon = indent ? ': ' : ':';
        return `{${newline}${keys.map(key => {
            const typedFloat = key === 'value' && item.valueType === 'number' && typeof item.value === 'number';
            return `${padding}${JSON.stringify(key)}${colon}${render(item[key], depth + 1, typedFloat)}`;
        }).join(separator)}${newline}${closing}}`;
    }
    return render(value, 0);
}
const stableHash = value => sha256(pythonJson(canonical(value)));
function prettyBytes(value) {
    // Python 的 json.dumps(sort_keys=True, indent=2, ensure_ascii=False) 对这里接受的
    // JSON 值也用同样的两空格对象/数组缩进。
    return Buffer.from(`${pythonJson(canonical(value), 2)}\n`, 'utf8');
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是普通对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} 必须是小写 SHA-256`);
    return value;
}
function text(value, label, maximum = 4096) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
        || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} 必须是无控制字符的有界去空格文本`);
    return value;
}
function preservedPublicationString(field, value) {
    if (!PRESERVED_PUBLICATION_STRING_FIELDS.has(field) || typeof value !== 'string') return false;
    if (field === 'paper_digest_arxiv_id') return /^\d{4}\.\d{4,5}$/.test(value);
    if (field === 'paper_digest_arxiv_versioned_id') return /^\d{4}\.\d{4,5}v[1-9]\d*$/.test(value);
    if (field === 'paper_digest_page_type') return ['paper', 'index', 'summary', 'digest'].includes(value);
    return false;
}
function timestamp(value, label) {
    text(value, label);
    const parsed = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label} 必须是规范的 UTC 时间`);
    return value;
}
function nowIso(now) {
    const parsed = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    if (Number.isNaN(parsed.getTime())) fail('now 无效');
    return parsed.toISOString();
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
            try { key = JSON.parse(token); } catch { fail(`${label} 含无效的 JSON 语法`); }
            if (top.keys.has(key)) fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}
function strictJson(bytes, label) {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        const value = JSON.parse(source);
        if (!plain(value)) fail(`${label} 必须含 JSON 对象`);
        return value;
    } catch (error) {
        if (error instanceof PageSourceCrosswalkError) throw error;
        fail(`${label} 必须含严格的 UTF-8 JSON`);
    }
}

function safeDirectory(root, { create = false, allowMissing = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('配置的 root 必须是绝对目录');
    const absolute = path.resolve(root); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let info;
        try { info = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT' && cursor === absolute && (allowMissing || create)) {
                if (!create) return absolute;
                fs.mkdirSync(absolute, { mode: 0o700 }); info = fs.lstatSync(absolute);
            } else throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) fail(`configured root contains an unsafe directory: ${cursor}`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail('配置的 root 必须使用其规范的非符号链接路径');
    return absolute;
}
function safeDirectJson(root, name, { mustExist = true, createRoot = false } = {}) {
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) fail('文件名必须是安全的直接 JSON 名');
    const directory = safeDirectory(root, { create: createRoot, allowMissing: !mustExist });
    const filename = path.resolve(directory, name);
    if (path.dirname(filename) !== directory) fail('JSON 文件名超出配置的 root');
    if (mustExist) {
        const info = fs.lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('JSON input must be a regular single-link file');
    }
    return filename;
}
function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
            fail(`${label} 必须是有界的常规单链接文件`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.size > maximum) fail(`${label} changed or became unsafe while opening`);
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`读取时 ${label} 已变化`);
        return { bytes, sha256: sha256(bytes), value: strictJson(bytes, label),
            dev: opened.dev, ino: opened.ino };
    } catch (error) {
        if (error instanceof PageSourceCrosswalkError) throw error;
        fail(`无法安全读取 ${label}：${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateHistoricalPage(page, index, scanFormat) {
    const { candidateField, groupField, evidenceFields: allowedEvidenceFields } = scanFormat;
    if (plain(page) && Object.hasOwn(page, 'legacyTagRouteCandidates') && Object.hasOwn(page, 'legacyTaxonomyCandidates')) {
        throw new PageSourceCrosswalkError('页面不能混用新旧标签链接候选字段。');
    }
    const otherCandidateField = candidateField === 'legacyTagRouteCandidates' ? 'legacyTaxonomyCandidates' : 'legacyTagRouteCandidates';
    if (plain(page) && Object.hasOwn(page, otherCandidateField)) {
        throw new PageSourceCrosswalkError('页面的标签链接候选字段与扫描策略不一致。');
    }
    exact(page, ['pageId', 'path', 'gitBlobOid', 'contentBytes', 'contentSha256', 'frontmatterBytes',
        'frontmatterSha256', 'bodyBytes', 'bodySha256', 'primaryUrl', 'aliases', 'kind', 'scope', 'publishedDate', 'cohortDate',
        'legacyTaskKey', 'draft', 'published', 'legacy', 'identityHints', 'outboundPostLinks',
        'publicationEvidenceRefs', candidateField, 'snapshotSha256', 'recordSha256'],
    `historical pages[${index}]`);
    text(page.path, `historical pages[${index}].path`);
    if (path.isAbsolute(page.path) || page.path.includes('\\') || page.path.split('/').some(part => ['', '.', '..'].includes(part))
        || !page.path.startsWith('content/posts/') || !page.path.endsWith('.md')) fail('historical page path is unsafe');
    if (!PAGE_KEY_RE.test(page.pageId)
        || page.pageId !== `page:${stableHash({ contract: 'historical-page-id-v1', path: page.path, primaryUrl: page.primaryUrl })}`) {
        fail('历史页面的 pageId 与路径和主 URL 不匹配');
    }
    if (!GIT_OID_RE.test(String(page.gitBlobOid || ''))) fail('历史页面的 Git blob OID 无效');
    if (!Number.isSafeInteger(page.contentBytes) || page.contentBytes < 1) fail('历史页面的 contentBytes 无效');
    if (!Number.isSafeInteger(page.frontmatterBytes) || page.frontmatterBytes < 1
        || !Number.isSafeInteger(page.bodyBytes) || page.bodyBytes < 0
        || page.frontmatterBytes + page.bodyBytes !== page.contentBytes) {
        fail('历史页面的 frontmatter 与正文分界无效');
    }
    for (const field of ['contentSha256', 'frontmatterSha256', 'bodySha256']) assertSha(page[field], `historical page ${field}`);
    text(page.primaryUrl, 'historical page primaryUrl');
    if (!['paper', 'daily-summary', 'conference-summary', 'conference-task', 'unknown'].includes(page.kind)) {
        fail('历史页面的 kind 不受支持');
    }
    if (!Array.isArray(page.aliases) || page.aliases.some(item => typeof item !== 'string')
        || stableHash(page.aliases) !== stableHash([...new Set(page.aliases)].sort())) {
        fail('历史页面的 aliases 必须是唯一且已排序的字符串数组');
    }
    exact(page.scope, ['type', 'key'], 'historical page scope');
    if (!['daily', 'conference', 'unknown', 'conflict'].includes(page.scope.type)
        || (page.scope.key !== null && typeof page.scope.key !== 'string')) fail('历史页面的 scope 格式不正确');
    for (const field of ['publishedDate', 'cohortDate']) {
        if (typeof page[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(page[field])
            || Number.isNaN(new Date(`${page[field]}T00:00:00.000Z`).getTime())) fail(`历史页面的 ${field} 无效`);
    }
    if (page.legacyTaskKey !== null && (typeof page.legacyTaskKey !== 'string'
        || !/^task-[a-z0-9._-]+$/.test(page.legacyTaskKey))) fail('历史页面的 legacyTaskKey 无效');
    if (typeof page.draft !== 'boolean' || typeof page.published !== 'boolean') {
        fail('历史页面的草稿或已发布状态格式不正确');
    }
    exact(page.legacy, ['tags', 'categories', 'marker'], 'historical page legacy');
    for (const field of ['tags', 'categories']) {
        if (!Array.isArray(page.legacy[field]) || page.legacy[field].some(item => typeof item !== 'string' || !item)) {
            fail(`历史页面的 legacy.${field} 必须是字符串数组`);
        }
    }
    exact(page.legacy.marker, ['pipelineOwned', 'declaredPageType', 'fieldNames', 'fieldsSha256'], 'historical page legacy marker');
    if ((page.legacy.marker.pipelineOwned !== null && typeof page.legacy.marker.pipelineOwned !== 'boolean')
        || (page.legacy.marker.declaredPageType !== null && typeof page.legacy.marker.declaredPageType !== 'string')
        || !Array.isArray(page.legacy.marker.fieldNames)
        || page.legacy.marker.fieldNames.some(item => typeof item !== 'string' || !item.startsWith('paper_digest_'))
        || stableHash(page.legacy.marker.fieldNames) !== stableHash([...new Set(page.legacy.marker.fieldNames)].sort())) {
        fail('历史页面的 legacy 标记格式不正确');
    }
    assertSha(page.legacy.marker.fieldsSha256, 'historical page legacy marker fields SHA');
    normalizeIdentityHints(page.identityHints, 'historical page identityHints');
    if (!Array.isArray(page.outboundPostLinks)) fail('历史页面的 outboundPostLinks 必须是数组');
    page.outboundPostLinks.forEach((link, linkIndex) => {
        exact(link, ['ordinal', 'linkType', 'sourceByteStart', 'sourceByteEnd', 'targetRawSha256', 'targetUrl',
            'status', 'targetPath', 'targetPageId', 'targetRecordSha256'], 'historical outbound link');
        if (link.ordinal !== linkIndex + 1 || !LINK_TYPES.has(link.linkType)
            || !Number.isSafeInteger(link.sourceByteStart) || !Number.isSafeInteger(link.sourceByteEnd)
            || link.sourceByteStart < 0 || link.sourceByteEnd <= link.sourceByteStart
            || link.sourceByteEnd > page.bodyBytes) {
            fail('历史页面的外链出现记录无效');
        }
        assertSha(link.targetRawSha256, 'historical outbound raw target SHA'); text(link.targetUrl, 'historical outbound target URL');
        if (!LINK_STATUSES.has(link.status)) fail('历史页面的外链状态不受支持');
        for (const field of ['targetPath', 'targetPageId', 'targetRecordSha256']) {
            if (link[field] !== null && typeof link[field] !== 'string') fail('历史页面的外链目标绑定格式不正确');
        }
    });
    if (!Array.isArray(page.publicationEvidenceRefs)) fail('历史页面的 publicationEvidenceRefs 必须是数组');
    const fieldNames = page.publicationEvidenceRefs.map(evidence => evidence?.field);
    if (PAGE_TAG_FIELDS.some(field => fieldNames.includes(field))
        && LEGACY_PAGE_TAG_FIELDS.some(field => fieldNames.includes(field))) {
        fail('页面不能同时包含新旧标签字段。');
    }
    const evidenceFields = [];
    for (const evidence of page.publicationEvidenceRefs) {
        exact(evidence, ['field', 'valueType', 'value', 'valueSha256'], 'historical publication evidence');
        if (!allowedEvidenceFields.has(evidence.field)
            || !['null', 'boolean', 'integer', 'number', 'string', 'array', 'object'].includes(evidence.valueType)) {
            fail('historical publication evidence field/type is unsupported');
        }
        assertSha(evidence.valueSha256, 'historical publication evidence value SHA');
        if (evidence.valueType === 'string') {
            if (PRESERVED_PUBLICATION_STRING_FIELDS.has(evidence.field)) {
                if (!preservedPublicationString(evidence.field, evidence.value)) {
                    fail(`historical preserved publication string is invalid: ${evidence.field}`);
                }
            } else if (evidence.value !== null) {
                fail('historical publication strings outside the preserved enum/ID set must be hash-only');
            }
        } else if (['array', 'object'].includes(evidence.valueType) && evidence.value !== null) {
            fail('结构化的发布证据（含 sidecar）必须只存哈希');
        } else if (evidence.valueType === 'null' && evidence.value !== null) {
            fail('为 null 的发布证据必须保留 null');
        } else if (evidence.valueType === 'boolean' && typeof evidence.value !== 'boolean') {
            fail('布尔型发布证据的取值类型不对');
        } else if (evidence.valueType === 'integer' && !Number.isSafeInteger(evidence.value)) {
            fail('整数型发布证据的取值类型不对');
        } else if (evidence.valueType === 'number'
            && (typeof evidence.value !== 'number' || !Number.isFinite(evidence.value) || Number.isInteger(evidence.value))) {
            fail('number publication evidence has the wrong value type');
        }
        if (evidence.value !== null || evidence.valueType === 'null') {
            if (stableHash(evidence.value) !== evidence.valueSha256) {
                fail(`历史页面保留的发布证据取值 SHA 已变化：${evidence.field}`);
            }
        }
        evidenceFields.push(evidence.field);
    }
    if (stableHash(evidenceFields) !== stableHash([...new Set(evidenceFields)].sort())) {
        fail('历史页面的发布证据字段必须唯一且已排序');
    }
    if (!Array.isArray(page[candidateField])) fail('历史页面的标签链接候选必须为数组。');
    for (const candidate of page[candidateField]) {
        if (plain(candidate) && Object.hasOwn(candidate, 'routeGroup') && Object.hasOwn(candidate, 'taxonomy')) {
            throw new PageSourceCrosswalkError('候选不能混用新旧路由分组字段。');
        }
        const otherGroupField = groupField === 'routeGroup' ? 'taxonomy' : 'routeGroup';
        if (plain(candidate) && Object.hasOwn(candidate, otherGroupField)) {
            throw new PageSourceCrosswalkError('候选的路由分组字段与扫描策略不一致。');
        }
        exact(candidate, [groupField, 'term', 'status', 'candidateUrl', 'method'], '历史标签链接候选');
        if (!['tags', 'categories'].includes(candidate[groupField]) || candidate.status !== 'unverified'
            || candidate.method !== 'legacy-term-normalization-v1') fail('历史标签链接候选的类型或状态不受支持。');
        text(candidate.term, '历史标签名称'); text(candidate.candidateUrl, '历史标签候选链接');
    }
    const snapshotBody = clone(page); delete snapshotBody.outboundPostLinks;
    delete snapshotBody.snapshotSha256; delete snapshotBody.recordSha256;
    if (assertSha(page.snapshotSha256, 'historical page snapshotSha256') !== stableHash(snapshotBody)) {
        fail('历史页面的 snapshot SHA 已变化');
    }
    const body = clone(page); delete body.recordSha256;
    if (assertSha(page.recordSha256, 'historical page recordSha256') !== stableHash(body)) fail('历史页面的 record SHA 已变化');
    return clone(page);
}

function validateHistoricalLedger(value) {
    exact(value, ['contract', 'version', 'source', 'policy', 'pages', 'urlCollisions', 'outboundPostLinks',
        'outboundPostLinksSha256', 'counts', 'pageSetSha256', 'ledgerSha256'], 'historical page ledger');
    if (value.contract !== LEDGER_CONTRACT || value.version !== VERSION) fail('历史 ledger 的契约或版本不受支持');
    const ledgerBody = clone(value); delete ledgerBody.ledgerSha256;
    if (assertSha(value.ledgerSha256, 'historical ledgerSha256') !== stableHash(ledgerBody)) fail('historical ledger self-SHA drifted');
    exact(value.source, ['branch', 'head', 'clean', 'statusSha256', 'remoteName', 'remoteIdentitySha256',
        'remoteMain', 'baseUrl', 'hugoConfig', 'contentRoot', 'gitObjectFormat', 'contentTreeOid',
        'trackedPages', 'hugoRuntime'], 'historical ledger source');
    if (value.source.branch !== 'main' || value.source.clean !== true || value.source.contentRoot !== 'content/posts') {
        fail('crosswalk 需要一份取自干净博客分支 main 的清单');
    }
    if (typeof value.source.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.source.head)) fail('历史来源的 HEAD 无效');
    for (const field of ['statusSha256', 'remoteIdentitySha256']) assertSha(value.source[field], `historical source ${field}`);
    text(value.source.remoteName, 'historical source remoteName'); text(value.source.baseUrl, 'historical source baseUrl');
    exact(value.source.remoteMain, ['availability', 'oid', 'ref'], 'historical source remoteMain');
    if (!['available', 'unavailable'].includes(value.source.remoteMain.availability)
        || value.source.remoteMain.ref !== `refs/remotes/${value.source.remoteName}/main`
        || (value.source.remoteMain.availability === 'available' && !GIT_OID_RE.test(String(value.source.remoteMain.oid || '')))
        || (value.source.remoteMain.availability === 'unavailable' && value.source.remoteMain.oid !== null)) {
        fail('历史来源的 remoteMain 格式不正确');
    }
    if (!['sha1', 'sha256'].includes(value.source.gitObjectFormat)
        || !GIT_OID_RE.test(String(value.source.contentTreeOid || ''))
        || value.source.contentTreeOid.length !== (value.source.gitObjectFormat === 'sha1' ? 40 : 64)) {
        fail('历史来源的 Git 对象或树身份格式不正确');
    }
    exact(value.source.trackedPages, ['count', 'setSha256'], 'historical source trackedPages');
    if (!Number.isSafeInteger(value.source.trackedPages.count) || value.source.trackedPages.count < 1) {
        fail('历史来源的已跟踪页面数无效');
    }
    assertSha(value.source.trackedPages.setSha256, 'historical source tracked page set SHA');
    exact(value.source.hugoConfig, ['path', 'sha256'], 'historical Hugo config');
    if (value.source.hugoConfig.path !== 'hugo.yaml') fail('历史 Hugo 配置路径不受支持');
    assertSha(value.source.hugoConfig.sha256, 'historical Hugo config SHA');
    exact(value.source.hugoRuntime, ['version', 'pageSetSha256', 'publishedPageSetSha256', 'pageCount',
        'publishedPageCount'], 'historical Hugo runtime');
    text(value.source.hugoRuntime.version, 'historical Hugo version', 500);
    assertSha(value.source.hugoRuntime.pageSetSha256, 'historical Hugo page-set SHA');
    assertSha(value.source.hugoRuntime.publishedPageSetSha256, 'historical Hugo published-page-set SHA');
    for (const field of ['pageCount', 'publishedPageCount']) {
        if (!Number.isSafeInteger(value.source.hugoRuntime[field]) || value.source.hugoRuntime[field] < 0) {
            fail(`历史 Hugo 的 ${field} 无效`);
        }
    }
    const scanFormat = scanFormatFor(value.policy);
    if (!Array.isArray(value.pages) || !value.pages.length
        || !Array.isArray(value.urlCollisions) || !Array.isArray(value.outboundPostLinks) || !plain(value.counts)) {
        fail('历史 ledger 的集合格式不正确');
    }
    const pages = value.pages.map((page, index) => validateHistoricalPage(page, index, scanFormat));
    const paths = pages.map(page => page.path);
    if (paths.some((item, index) => index && paths[index - 1] >= item)) fail('历史页面必须唯一且按路径排序');
    if (assertSha(value.pageSetSha256, 'historical pageSetSha256') !== stableHash(pages)) fail('历史页面集合 SHA 已变化');
    const hugoPages = pages.map(page => ({ path: page.path, permalink: page.primaryUrl }));
    const hugoPublishedPages = hugoPages.filter((_item, index) => pages[index].published);
    if (value.source.hugoRuntime.pageCount !== pages.length
        || value.source.hugoRuntime.publishedPageCount !== hugoPublishedPages.length
        || value.source.hugoRuntime.pageSetSha256 !== stableHash(hugoPages)
        || value.source.hugoRuntime.publishedPageSetSha256 !== stableHash(hugoPublishedPages)) {
        fail('历史 Hugo 页面证明与 ledger 页面不一致');
    }
    const trackedPages = pages.map(page => ({ path: page.path, blobOid: page.gitBlobOid }));
    if (value.source.trackedPages.count !== trackedPages.length
        || value.source.trackedPages.setSha256 !== stableHash(trackedPages)
        || pages.some(page => page.gitBlobOid.length !== (value.source.gitObjectFormat === 'sha1' ? 40 : 64))) {
        fail('历史已跟踪页面证明与 ledger 页面不一致');
    }
    if (assertSha(value.outboundPostLinksSha256, 'historical outboundPostLinksSha256')
        !== stableHash(value.outboundPostLinks)) fail('历史外链 SHA 已变化');
    const claimsByUrl = new Map();
    for (const page of pages) for (const url of [page.primaryUrl, ...page.aliases]) {
        if (!claimsByUrl.has(url)) claimsByUrl.set(url, new Map());
        claimsByUrl.get(url).set(page.pageId, page);
    }
    for (const page of pages) for (const link of page.outboundPostLinks) {
        const targets = claimsByUrl.get(link.targetUrl) || new Map();
        const expectedStatus = targets.size === 1 ? 'resolved' : targets.size ? 'ambiguous' : 'unresolved';
        if (link.status !== expectedStatus) fail('历史外链解析状态已变化');
        if (expectedStatus === 'resolved') {
            const target = [...targets.values()][0];
            if (link.targetPath !== target.path || link.targetPageId !== target.pageId
                || link.targetRecordSha256 !== target.snapshotSha256) fail('historical outbound target binding drifted');
        } else if ([link.targetPath, link.targetPageId, link.targetRecordSha256].some(item => item !== null)) {
            fail('未解析或有歧义的历史外链却声明了目标页面');
        }
    }
    const expectedOutbound = pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    if (stableHash(value.outboundPostLinks) !== stableHash(expectedOutbound)) fail('历史汇总的外链已变化');
    const claims = new Map();
    for (const page of pages) for (const url of [page.primaryUrl, ...page.aliases]) {
        if (!claims.has(url)) claims.set(url, new Set()); claims.get(url).add(page.path);
    }
    const expectedCollisions = [...claims.entries()].filter(([, items]) => items.size > 1)
        .map(([url, items]) => ({ url, paths: [...items].sort() })).sort((left, right) => left.url.localeCompare(right.url));
    if (stableHash(value.urlCollisions) !== stableHash(expectedCollisions)) fail('历史 URL 冲突索引已变化');
    exact(value.counts, ['pages', 'papers', 'dailySummaries', 'conferenceSummaries', 'conferenceTasks', 'unknown',
        'urlCollisions', 'outboundPostLinks', 'resolvedOutboundPostLinks', 'unresolvedOutboundPostLinks',
        'ambiguousOutboundPostLinks'], 'historical ledger counts');
    const expectedCounts = { pages: pages.length, papers: pages.filter(page => page.kind === 'paper').length,
        dailySummaries: pages.filter(page => page.kind === 'daily-summary').length,
        conferenceSummaries: pages.filter(page => page.kind === 'conference-summary').length,
        conferenceTasks: pages.filter(page => page.kind === 'conference-task').length,
        unknown: pages.filter(page => page.kind === 'unknown').length, urlCollisions: expectedCollisions.length,
        outboundPostLinks: expectedOutbound.length,
        resolvedOutboundPostLinks: expectedOutbound.filter(link => link.status === 'resolved').length,
        unresolvedOutboundPostLinks: expectedOutbound.filter(link => link.status === 'unresolved').length,
        ambiguousOutboundPostLinks: expectedOutbound.filter(link => link.status === 'ambiguous').length };
    if (stableHash(value.counts) !== stableHash(expectedCounts)) fail('历史 ledger 的计数已变化');
    return { ...clone(value), pages };
}

function validateHistoricalReceipt(value, ledger, ledgerBytes, ledgerName) {
    exact(value, ['contract', 'version', 'ledger', 'repositorySnapshotSha256', 'receiptSha256'], 'historical receipt');
    if (value.contract !== LEDGER_RECEIPT_CONTRACT || value.version !== VERSION) fail('历史 receipt 的契约或版本不受支持');
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'historical receiptSha256') !== stableHash(body)) fail('historical receipt self-SHA drifted');
    exact(value.ledger, ['name', 'fileSha256', 'ledgerSha256', 'pageSetSha256', 'pageCount'], 'historical receipt ledger');
    if (value.ledger.name !== ledgerName || value.ledger.fileSha256 !== sha256(ledgerBytes)
        || value.ledger.ledgerSha256 !== ledger.ledgerSha256 || value.ledger.pageSetSha256 !== ledger.pageSetSha256
        || value.ledger.pageCount !== ledger.pages.length) fail('historical receipt does not bind the exact ledger');
    for (const field of ['fileSha256', 'ledgerSha256', 'pageSetSha256']) assertSha(value.ledger[field], `receipt ledger ${field}`);
    if (assertSha(value.repositorySnapshotSha256, 'receipt repositorySnapshotSha256') !== stableHash(ledger.source)) {
        fail('历史 receipt 的仓库快照已变化');
    }
    return clone(value);
}

function loadHistoricalInventoryHandle({ inventoryRoot, ledgerName, receiptName } = {}) {
    const ledgerFile = safeDirectJson(inventoryRoot, ledgerName);
    const receiptFile = safeDirectJson(inventoryRoot, receiptName);
    if (ledgerFile === receiptFile) fail('历史 ledger 与 receipt 文件必须不同');
    const ledgerLoaded = readRegular(ledgerFile, MAX_LEDGER_BYTES, 'historical page ledger');
    const receiptLoaded = readRegular(receiptFile, MAX_RECEIPT_BYTES, 'historical page receipt');
    const receiptBody = clone(receiptLoaded.value); delete receiptBody.receiptSha256;
    if (assertSha(receiptLoaded.value.receiptSha256, 'historical receiptSha256') !== stableHash(receiptBody)) fail('historical receipt self-SHA drifted');
    if (receiptLoaded.value.ledger?.fileSha256 !== sha256(ledgerLoaded.bytes)) fail('historical receipt does not bind the exact ledger');
    const ledger = validateHistoricalLedger(ledgerLoaded.value);
    if (!ledgerLoaded.bytes.equals(prettyBytes(ledger))) fail('历史页面 ledger 的字节不规范');
    const receipt = validateHistoricalReceipt(receiptLoaded.value, ledger, ledgerLoaded.bytes, ledgerName);
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) fail('历史页面 receipt 的字节不规范');
    const snapshot = { ledger, receipt, ledgerFile: fs.realpathSync(ledgerFile), receiptFile: fs.realpathSync(receiptFile),
        ledgerFileSha256: ledgerLoaded.sha256, receiptFileSha256: receiptLoaded.sha256 };
    const handle = Object.freeze(Object.create(null)); INVENTORY_HANDLES.add(handle);
    INVENTORY_HANDLE_DATA.set(handle, Object.freeze(snapshot)); return handle;
}
function inventoryHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !INVENTORY_HANDLES.has(handle)) fail('authenticated historical inventory handle required');
    return clone(INVENTORY_HANDLE_DATA.get(handle));
}

function normalizeIdentityHints(value, label = 'identityHints') {
    exact(value, ['status', 'candidates'], label);
    if (!['none', 'single', 'multiple', 'conflict'].includes(value.status) || !Array.isArray(value.candidates)) {
        fail(`${label} 格式不正确`);
    }
    const candidates = value.candidates.map((candidate, index) => {
        exact(candidate, ['scheme', 'value', 'sources'], `${label}.candidates[${index}]`);
        if (!['arxiv', 'openreview-forum-id', 'icassp-arnumber'].includes(candidate.scheme)) {
            fail(`${label} 候选的 scheme 不受支持`);
        }
        text(candidate.value, `${label} candidate value`, 128);
        const valid = candidate.scheme === 'arxiv' ? /^\d{4}\.\d{4,5}$/.test(candidate.value)
            : candidate.scheme === 'openreview-forum-id' ? /^[A-Za-z0-9_-]{6,128}$/.test(candidate.value)
                : /^[1-9]\d*$/.test(candidate.value);
        if (!valid || !Array.isArray(candidate.sources) || !candidate.sources.length
            || candidate.sources.some(source => typeof source !== 'string'
                || !/^(?:filename|frontmatter:[A-Za-z0-9_]+|body:(?:arxiv|openreview|ieee)-link)$/.test(source))
            || [...candidate.sources].sort().some((source, sourceIndex) => source !== candidate.sources[sourceIndex])
            || new Set(candidate.sources).size !== candidate.sources.length) {
            fail(`${label} candidate value/sources are invalid; title-only evidence is never accepted`);
        }
        return clone(candidate);
    });
    const keys = candidates.map(candidate => `${candidate.scheme}:${candidate.value}`);
    if ([...keys].sort().some((key, index) => key !== keys[index]) || new Set(keys).size !== keys.length) {
        fail(`${label} 候选必须唯一且已排序`);
    }
    const byScheme = new Map();
    for (const candidate of candidates) {
        const values = byScheme.get(candidate.scheme) || new Set();
        values.add(candidate.value); byScheme.set(candidate.scheme, values);
    }
    const expectedStatus = !candidates.length ? 'none'
        : [...byScheme.values()].some(values => values.size > 1) ? 'conflict'
            : candidates.length === 1 ? 'single' : 'multiple';
    if (value.status !== expectedStatus) fail(`${label}.status 与其候选不一致`);
    return { status: value.status, candidates };
}

function assignmentKey(page) { return page.pageId; }
function sourceBinding(inventory) {
    const papers = inventory.ledger.pages.filter(page => page.kind === 'paper')
        .map(page => ({ pageKey: assignmentKey(page), pagePath: page.path, pageContentSha256: page.contentSha256,
            pageRecordSha256: page.recordSha256, primaryUrl: page.primaryUrl,
            scope: clone(page.scope), cohortDate: page.cohortDate,
            identityHints: normalizeIdentityHints(page.identityHints, `identity hints for ${page.pageId}`) }));
    if (!papers.length) fail('历史清单不含论文页面');
    return { ledgerName: path.basename(inventory.ledgerFile), ledgerFileSha256: inventory.ledgerFileSha256,
        ledgerSha256: inventory.ledger.ledgerSha256, receiptName: path.basename(inventory.receiptFile),
        receiptFileSha256: inventory.receiptFileSha256, receiptSha256: inventory.receipt.receiptSha256,
        repositorySnapshotSha256: inventory.receipt.repositorySnapshotSha256,
        pageSetSha256: inventory.ledger.pageSetSha256, paperPageSetSha256: stableHash(papers), papers };
}
function initialAssignment(page) {
    return { pagePath: page.pagePath, pageContentSha256: page.pageContentSha256,
        status: 'pending', reason: null, decisionArtifactSha256: null, sourceAuthority: null };
}
function completionFor(assignments) {
    const counts = { pending: 0, needsReview: 0, blocked: 0, conflict: 0, verified: 0 };
    for (const assignment of Object.values(assignments)) {
        const key = assignment.status === 'needs-review' ? 'needsReview' : assignment.status;
        counts[key] += 1;
    }
    const body = { total: Object.keys(assignments).length, ...counts,
        status: counts.verified === Object.keys(assignments).length ? 'complete' : 'incomplete',
        assignmentSetSha256: stableHash(assignments) };
    return body;
}
function stateDigest(value) {
    const body = clone(value); delete body.stateSha256;
    body.attempts = body.attempts.map(({ nextStateSha256: _next, ...attempt }) => attempt);
    return stableHash(body);
}
function sourceAuthoritySnapshot(handle) {
    try { return { kind: 'paper-source', snapshot: authorityApi.authorityHandleSnapshot(handle) }; }
    catch (paperError) {
        try { return { kind: 'archive-crawl-identity', snapshot: archiveIdentityApi.authorityHandleSnapshot(handle) }; }
        catch {
            try { return { kind: 'local-crawl-identity', snapshot: localCrawlIdentityApi.authorityHandleSnapshot(handle) }; }
            catch {
                try { return { kind: 'conference-crawl-identity', snapshot: conferenceIdentityApi.authorityHandleSnapshot(handle) }; }
                catch { fail(`verified decision requires authenticated source authority: ${paperError.message}`); }
            }
        }
    }
}
function replaySourceAuthorityHandle(handle, { requireProduction = false } = {}) {
    try { return authorityApi.replayAuthorityHandle(handle, { requireProduction }); }
    catch (paperError) {
        try { return archiveIdentityApi.replayAuthorityHandle(handle, { requireProduction }); }
        catch {
            try { return localCrawlIdentityApi.replayAuthorityHandle(handle, { requireProduction }); }
            catch {
                try { return conferenceIdentityApi.replayAuthorityHandle(handle, { requireProduction }); }
                catch { fail(`来源权威重放失败：${paperError.message}`); }
            }
        }
    }
}
function authorityReference(source) {
    const { kind, snapshot } = source;
    const authority = snapshot.authority;
    if (kind === 'archive-crawl-identity') {
        return { paperId: authority.paperId, identity: clone(authority.identity), identitySha256: authority.identitySha256,
            identityRecordSha256: authority.identityRecordSha256, authorityContract: authority.contract,
            authorityName: snapshot.authorityName, authorityFileSha256: snapshot.authorityFileSha256,
            authoritySha256: authority.authoritySha256, evidenceKind: authority.evidenceKind,
            archiveFileSha256: authority.archiveFileSha256, recordSha256: authority.recordSha256 };
    }
    if (kind === 'local-crawl-identity') {
        return { paperId: authority.paperId, identity: clone(authority.identity), identitySha256: authority.identitySha256,
            identityRecordSha256: authority.identityRecordSha256, authorityContract: authority.contract,
            authorityName: snapshot.authorityName, authorityFileSha256: snapshot.authorityFileSha256,
            authoritySha256: authority.authoritySha256, evidenceKind: authority.evidenceKind, sourceKind: authority.sourceKind,
            sourceRelativePath: authority.sourceRelativePath, sourceFileSha256: authority.sourceFileSha256,
            recordPointer: clone(authority.recordPointer), recordIdentity: clone(authority.recordIdentity),
            recordIdentitySha256: authority.recordIdentitySha256, currentIdentitySnapshot: clone(authority.currentIdentitySnapshot) };
    }
    if (kind === 'conference-crawl-identity') {
        return { paperId: authority.paperId, identity: clone(authority.identity), identitySha256: authority.identitySha256,
            identityRecordSha256: authority.identityRecordSha256, authorityContract: authority.contract,
            authorityName: snapshot.authorityName, authorityFileSha256: snapshot.authorityFileSha256,
            authoritySha256: authority.authoritySha256, evidenceKind: authority.evidenceKind,
            metadataSnapshotSha256: authority.metadataSnapshotSha256,
            recordIdentitySha256: authority.recordIdentitySha256, pdfSha256: authority.pdfSha256,
            titleBindingsSha256: authority.titleBindingsSha256 };
    }
    return { paperId: authority.paperId, identity: clone(authority.identity), identitySha256: authority.identitySha256,
        identityRecordSha256: authority.identityRecordSha256,
        authorityContract: authority.contract, authorityName: snapshot.authorityName,
        authorityFileSha256: snapshot.authorityFileSha256, authoritySha256: authority.authoritySha256,
        evidenceKind: authority.evidenceKind, fulltextSha256: snapshot.fulltextSha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256 };
}
function validateAuthorityReference(value, label = 'sourceAuthority') {
    if (value === null) return null;
    const archiveIdentity = value?.authorityContract === archiveIdentityApi.CONTRACT;
    const localCrawlIdentity = value?.authorityContract === localCrawlIdentityApi.CONTRACT;
    const conferenceIdentity = value?.authorityContract === conferenceIdentityApi.CONTRACT;
    exact(value, archiveIdentity
        ? ['paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'authorityContract', 'authorityName', 'authorityFileSha256',
            'authoritySha256', 'evidenceKind', 'archiveFileSha256', 'recordSha256']
        : conferenceIdentity
            ? ['paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'authorityContract', 'authorityName', 'authorityFileSha256',
                'authoritySha256', 'evidenceKind', 'metadataSnapshotSha256', 'recordIdentitySha256', 'pdfSha256', 'titleBindingsSha256']
            : localCrawlIdentity
                ? ['paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'authorityContract', 'authorityName', 'authorityFileSha256',
                    'authoritySha256', 'evidenceKind', 'sourceKind', 'sourceRelativePath', 'sourceFileSha256', 'recordPointer',
                    'recordIdentity', 'recordIdentitySha256', 'currentIdentitySnapshot']
        : ['paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'authorityContract', 'authorityName', 'authorityFileSha256',
            'authoritySha256', 'evidenceKind', 'fulltextSha256', 'sourceSnapshotSha256'], label);
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(`${label}.identity 无效：${error.message}`); }
    if (identity.citation !== null) {
        fail(`${label}.identity.citation 必须保持 null，直到存在已认证的官方元数据适配器`);
    }
    if (value.paperId !== identity.canonicalId
        || value.identitySha256 !== identityApi.identitySha256(identity)
        || value.identityRecordSha256 !== identityApi.recordSha256(identity)) {
        fail(`${label} 的 paperId、identity 或 SHA 绑定无效`);
    }
    if ((!archiveIdentity && !localCrawlIdentity && !conferenceIdentity && (value.authorityContract !== authorityApi.CONTRACT || !authorityApi.isEvidenceKind(value.evidenceKind)))
        || (archiveIdentity && (identity.kind !== 'arxiv' || value.evidenceKind !== archiveIdentityApi.EVIDENCE_KIND))
        || (localCrawlIdentity && (identity.kind !== 'arxiv' || value.evidenceKind !== localCrawlIdentityApi.EVIDENCE_KIND
            || !['archive', 'current'].includes(value.sourceKind)
            || localCrawlIdentityApi.sourceSpec(value.sourceRelativePath).sourceKind !== value.sourceKind))
        || (conferenceIdentity && (identity.kind !== 'conference' || value.evidenceKind !== conferenceIdentityApi.EVIDENCE_KIND))
        || !SAFE_JSON_NAME.test(value.authorityName)) fail(`${label} 的 contract、name 或 evidenceKind 无效`);
    if (localCrawlIdentity) {
        exact(value.recordIdentity, ['arxivId', 'paperId'], `${label}.recordIdentity`);
        if (value.recordIdentity.arxivId !== identity.arxivId || value.recordIdentity.paperId !== identity.arxivId) {
            fail(`${label}.recordIdentity 与其规范 arXiv ID 不匹配`);
        }
        exact(value.recordPointer, ['kind', 'value'], `${label}.recordPointer`);
        if ((value.sourceKind === 'archive' && (value.recordPointer.kind !== 'array-index'
            || !Number.isSafeInteger(value.recordPointer.value) || value.recordPointer.value < 0 || value.currentIdentitySnapshot !== null))
            || (value.sourceKind === 'current' && (value.recordPointer.kind !== 'map-key' || value.recordPointer.value !== identity.arxivId
                || !plain(value.currentIdentitySnapshot)))) fail(`${label} 的本地爬虫指针或快照无效`);
        if (value.sourceKind === 'current') {
            exact(value.currentIdentitySnapshot, ['snapshotName', 'snapshotFileSha256', 'snapshotSha256'], `${label}.currentIdentitySnapshot`);
            if (!SAFE_JSON_NAME.test(value.currentIdentitySnapshot.snapshotName)
                || !value.currentIdentitySnapshot.snapshotName.startsWith(localCrawlIdentityApi.SNAPSHOT_PREFIX)) {
                fail(`${label}.currentIdentitySnapshot 的名称无效`);
            }
            for (const field of ['snapshotFileSha256', 'snapshotSha256']) assertSha(value.currentIdentitySnapshot[field], `${label}.currentIdentitySnapshot.${field}`);
        }
    }
    if (conferenceIdentity) {
        for (const field of ['metadataSnapshotSha256', 'recordIdentitySha256', 'pdfSha256', 'titleBindingsSha256']) {
            assertSha(value[field], `${label}.${field}`);
        }
    }
    const shaFields = archiveIdentity
        ? ['identitySha256', 'identityRecordSha256', 'authorityFileSha256', 'authoritySha256', 'archiveFileSha256', 'recordSha256']
        : conferenceIdentity
            ? ['identitySha256', 'identityRecordSha256', 'authorityFileSha256', 'authoritySha256', 'metadataSnapshotSha256', 'recordIdentitySha256', 'pdfSha256']
            : localCrawlIdentity
                ? ['identitySha256', 'identityRecordSha256', 'authorityFileSha256', 'authoritySha256', 'sourceFileSha256', 'recordIdentitySha256']
        : ['identitySha256', 'identityRecordSha256', 'authorityFileSha256', 'authoritySha256', 'fulltextSha256', 'sourceSnapshotSha256'];
    for (const field of shaFields) assertSha(value[field], `${label}.${field}`);
    return { ...clone(value), identity };
}
function identityGroupsFor(assignments) {
    const groups = new Map();
    for (const [pageKey, assignment] of Object.entries(assignments)) {
        if (assignment.status !== 'verified') continue;
        const authority = validateAuthorityReference(assignment.sourceAuthority, `assignment ${pageKey} sourceAuthority`);
        const existing = groups.get(authority.paperId) || { paperId: authority.paperId,
            identitySha256: authority.identitySha256, identityRecordSha256: authority.identityRecordSha256, pageKeys: [] };
        if (existing.identitySha256 !== authority.identitySha256
            || existing.identityRecordSha256 !== authority.identityRecordSha256) {
            fail('one canonical paperId has conflicting identity record/SHA values');
        }
        existing.pageKeys.push(pageKey); groups.set(authority.paperId, existing);
    }
    return [...groups.values()].map(group => {
        group.pageKeys.sort();
        const body = clone(group); return { ...body, groupSha256: stableHash(body) };
    }).sort((left, right) => left.paperId < right.paperId ? -1 : left.paperId > right.paperId ? 1 : 0);
}
function normalizeIdentityGroups(value, label = 'identityGroups') {
    if (!Array.isArray(value)) fail(`${label} 必须是数组`);
    const seenPapers = new Set(); const seenPages = new Set(); let previousPaper = null;
    return value.map((group, index) => {
        exact(group, ['paperId', 'identitySha256', 'identityRecordSha256', 'pageKeys', 'groupSha256'], `${label}[${index}]`);
        text(group.paperId, `${label}[${index}].paperId`, 512);
        for (const field of ['identitySha256', 'identityRecordSha256', 'groupSha256']) {
            assertSha(group[field], `${label}[${index}].${field}`);
        }
        if (seenPapers.has(group.paperId) || (previousPaper !== null && previousPaper >= group.paperId)) {
            fail(`${label} 的 paperId 必须唯一且按码元排序`);
        }
        if (!Array.isArray(group.pageKeys) || !group.pageKeys.length) fail(`${label}[${index}].pageKeys 不能为空`);
        const pageKeys = group.pageKeys.map((pageKey, pageIndex) => {
            if (!PAGE_KEY_RE.test(pageKey)) fail(`${label}[${index}].pageKeys[${pageIndex}] 格式不正确`);
            if (seenPages.has(pageKey)) fail(`${label} 不能重复含同一页面`);
            seenPages.add(pageKey); return pageKey;
        });
        if (pageKeys.some((pageKey, pageIndex) => pageIndex > 0 && pageKeys[pageIndex - 1] >= pageKey)) {
            fail(`${label}[${index}].pageKeys 必须唯一且按码元排序`);
        }
        const body = { paperId: group.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, pageKeys };
        if (group.groupSha256 !== stableHash(body)) fail(`${label}[${index}].groupSha256 drifted`);
        seenPapers.add(group.paperId); previousPaper = group.paperId;
        return { ...body, groupSha256: group.groupSha256 };
    });
}
function validateAssignment(value, pageKey) {
    exact(value, ['pagePath', 'pageContentSha256', 'status', 'reason', 'decisionArtifactSha256', 'sourceAuthority'], `assignment ${pageKey}`);
    if (!PAGE_KEY_RE.test(pageKey)) fail('assignment 的 page key 格式不正确');
    text(value.pagePath, 'assignment pagePath'); assertSha(value.pageContentSha256, 'assignment page content SHA');
    if (!ALL_STATUSES.has(value.status)) fail('assignment 的 status 不受支持');
    if (value.status === 'pending') {
        if (value.reason !== null || value.decisionArtifactSha256 !== null || value.sourceAuthority !== null) {
            fail('pending assignment 不能带 decision 或 authority');
        }
    } else {
        text(value.reason, 'assignment reason', 2000); assertSha(value.decisionArtifactSha256, 'assignment decision SHA');
        if (value.status === 'verified') validateAuthorityReference(value.sourceAuthority, `assignment ${pageKey} sourceAuthority`);
        else if (value.sourceAuthority !== null) fail('review-only assignment 不能带来源权威');
    }
    return clone(value);
}
function validateCompletion(value, assignments) {
    exact(value, ['total', 'pending', 'needsReview', 'blocked', 'conflict', 'verified', 'status', 'assignmentSetSha256'], 'completion');
    const expected = completionFor(assignments);
    if (stableHash(value) !== stableHash(expected)) fail('completion 的计数或状态已变化');
    return clone(value);
}
function validateAttempt(value, index, assignments, priorStateSha256) {
    exact(value, ['operationId', 'decisionName', 'decisionFileSha256', 'decisionArtifactSha256', 'pageKey',
        'fromStatus', 'toStatus', 'reason', 'actorId', 'sourceAuthority', 'recordedAt',
        'priorStateSha256', 'nextStateSha256'], `attempt[${index}]`);
    if (!UUID_RE.test(value.operationId)) fail('attempt 的 operationId 必须是 UUID v4');
    if (!SAFE_JSON_NAME.test(value.decisionName)) fail('attempt decisionName is unsafe');
    for (const field of ['decisionFileSha256', 'decisionArtifactSha256', 'priorStateSha256', 'nextStateSha256']) {
        assertSha(value[field], `attempt ${field}`);
    }
    if (!PAGE_KEY_RE.test(value.pageKey) || !Object.hasOwn(assignments, value.pageKey)) fail('attempt 的 pageKey 未知');
    if (value.fromStatus !== 'pending' || ![...FINAL_REVIEW_STATUSES, 'verified'].includes(value.toStatus)) fail('attempt 的 transition 不受支持');
    if (value.toStatus === 'verified') validateAuthorityReference(value.sourceAuthority, `attempt[${index}].sourceAuthority`);
    else if (value.sourceAuthority !== null) fail('review-only attempt 不能带来源权威');
    text(value.reason, 'attempt reason', 2000); text(value.actorId, 'attempt actorId', 120); timestamp(value.recordedAt, 'attempt recordedAt');
    if (value.priorStateSha256 !== priorStateSha256) fail('attempt 的 SHA 历史不连续');
    return clone(value);
}
function assertCrosswalkState(value) {
    exact(value, ['contract', 'version', 'crosswalkId', 'createdAt', 'source', 'assignments', 'attempts',
        'completion', 'identityGroups', 'identityGroupsSha256', 'stateSha256'], 'crosswalk state');
    if (value.contract !== CONTRACT || value.version !== VERSION || !UUID_RE.test(value.crosswalkId)) fail('crosswalk 的契约、版本或 UUID 不一致');
    timestamp(value.createdAt, 'createdAt');
    exact(value.source, ['ledgerName', 'ledgerFileSha256', 'ledgerSha256', 'receiptName', 'receiptFileSha256',
        'receiptSha256', 'repositorySnapshotSha256', 'pageSetSha256', 'paperPageSetSha256', 'papers'], 'crosswalk source');
    for (const field of ['ledgerFileSha256', 'ledgerSha256', 'receiptFileSha256', 'receiptSha256',
        'repositorySnapshotSha256', 'pageSetSha256', 'paperPageSetSha256']) assertSha(value.source[field], `source ${field}`);
    for (const field of ['ledgerName', 'receiptName']) if (!SAFE_JSON_NAME.test(value.source[field])) fail(`source ${field} is unsafe`);
    if (!Array.isArray(value.source.papers) || !value.source.papers.length) fail('来源 papers 不能为空');
    const papers = value.source.papers.map(item => {
        exact(item, ['pageKey', 'pagePath', 'pageContentSha256', 'pageRecordSha256', 'primaryUrl', 'scope',
            'cohortDate', 'identityHints'], 'source paper');
        if (!PAGE_KEY_RE.test(item.pageKey)) fail('来源论文的 pageId 格式不正确');
        text(item.pagePath, 'source paper path'); text(item.primaryUrl, 'source paper primary URL');
        assertSha(item.pageContentSha256, 'source paper content SHA');
        assertSha(item.pageRecordSha256, 'source paper record SHA');
        exact(item.scope, ['type', 'key'], 'source paper scope');
        normalizeIdentityHints(item.identityHints, `source paper ${item.pageKey} identityHints`);
        if (typeof item.cohortDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.cohortDate)) {
            fail('来源论文的 cohortDate 无效');
        }
        return clone(item);
    });
    if (stableHash(papers) !== value.source.paperPageSetSha256) fail('来源论文集合 SHA 已变化');
    if (!plain(value.assignments) || Object.keys(value.assignments).length !== papers.length) fail('assignments 必须恰好覆盖来源论文');
    const assignments = Object.fromEntries(Object.keys(value.assignments).sort().map(key => [key, validateAssignment(value.assignments[key], key)]));
    for (const paper of papers) {
        const assignment = assignments[paper.pageKey];
        if (!assignment || assignment.pagePath !== paper.pagePath || assignment.pageContentSha256 !== paper.pageContentSha256) {
            fail('assignment 与来源论文快照不一致');
        }
    }
    if (!Array.isArray(value.identityGroups)) fail('identityGroups 必须是数组');
    if (!Array.isArray(value.attempts)) fail('attempts 必须是数组');
    const replayed = Object.fromEntries(papers.map(paper => [paper.pageKey, initialAssignment(paper)]));
    const operations = new Set(); let previousTime = value.createdAt; let expectedPrior = stateDigest({ contract: CONTRACT, version: VERSION,
        crosswalkId: value.crosswalkId, createdAt: value.createdAt, source: clone(value.source), assignments: clone(replayed),
        attempts: [], completion: completionFor(replayed), identityGroups: [], identityGroupsSha256: stableHash([]) });
    const attempts = [];
    for (const [index, raw] of value.attempts.entries()) {
        const attempt = validateAttempt(raw, index, replayed, expectedPrior);
        if (operations.has(attempt.operationId)) fail('attempt 的 operationId 重复');
        if (attempt.recordedAt < previousTime) fail('attempt 的时间倒退');
        if (replayed[attempt.pageKey].status !== 'pending') fail('attempt 重复了已终态的页面 assignment');
        replayed[attempt.pageKey] = { ...replayed[attempt.pageKey], status: attempt.toStatus, reason: attempt.reason,
            decisionArtifactSha256: attempt.decisionArtifactSha256, sourceAuthority: clone(attempt.sourceAuthority) };
        const prefix = { contract: CONTRACT, version: VERSION, crosswalkId: value.crosswalkId, createdAt: value.createdAt,
            source: clone(value.source), assignments: clone(replayed), attempts: [...attempts, attempt],
            completion: completionFor(replayed), identityGroups: identityGroupsFor(replayed),
            identityGroupsSha256: stableHash(identityGroupsFor(replayed)) };
        const digest = stateDigest(prefix);
        if (attempt.nextStateSha256 !== digest) fail('attempt 的 nextStateSha256 与重放的 state 不匹配');
        expectedPrior = digest; previousTime = attempt.recordedAt; operations.add(attempt.operationId); attempts.push(attempt);
    }
    if (stableHash(replayed) !== stableHash(assignments)) fail('assignments 与只追加的 attempt 历史不一致');
    const completion = validateCompletion(value.completion, assignments);
    const identityGroups = identityGroupsFor(assignments);
    normalizeIdentityGroups(identityGroups);
    if (stableHash(value.identityGroups) !== stableHash(identityGroups)
        || assertSha(value.identityGroupsSha256, 'identityGroupsSha256') !== stableHash(identityGroups)) {
        fail('identityGroups 与 verified assignments 不一致');
    }
    const rebuilt = { contract: CONTRACT, version: VERSION, crosswalkId: value.crosswalkId, createdAt: value.createdAt,
        source: clone(value.source), assignments, attempts, completion, identityGroups,
        identityGroupsSha256: stableHash(identityGroups) };
    const digest = stateDigest(rebuilt);
    if (assertSha(value.stateSha256, 'stateSha256') !== digest) fail('crosswalk state SHA 已变化');
    if (attempts.length && attempts.at(-1).nextStateSha256 !== digest) fail('最后一个 attempt 与当前 state 不匹配');
    return { ...rebuilt, stateSha256: digest };
}

function buildInitialState(inventoryHandle, { crosswalkId = crypto.randomUUID(), now } = {}) {
    const inventory = inventoryHandleSnapshot(inventoryHandle);
    if (!UUID_RE.test(crosswalkId)) fail('crosswalkId 必须是规范的 UUID v4');
    const source = sourceBinding(inventory);
    const assignments = Object.fromEntries(source.papers.map(paper => [paper.pageKey, initialAssignment(paper)]));
    const body = { contract: CONTRACT, version: VERSION, crosswalkId, createdAt: nowIso(now), source,
        assignments, attempts: [], completion: completionFor(assignments), identityGroups: [], identityGroupsSha256: stableHash([]) };
    return assertCrosswalkState({ ...body, stateSha256: stateDigest(body) });
}

function crosswalkDirectory(root, crosswalkId, { create = false } = {}) {
    const safeRoot = safeDirectory(root, { create });
    if (!UUID_RE.test(crosswalkId)) fail('crosswalkId 必须是规范的 UUID v4');
    const directory = path.resolve(safeRoot, crosswalkId);
    if (path.dirname(directory) !== safeRoot) fail('crosswalk 目录超出 root');
    if (create) {
        try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!fs.existsSync(directory)) fail('crosswalk 目录不存在');
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('crosswalk directory is unsafe');
    return directory;
}
function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeExclusive(filename, bytes) {
    let fd; let created = false;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = true;
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
        if (created) try { fs.unlinkSync(filename); } catch {}
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    syncDirectory(path.dirname(filename));
}
function replaceState(filename, bytes) {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('state file is unsafe');
    const temporary = path.join(path.dirname(filename), `.state.${crypto.randomUUID()}.tmp`); let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    syncDirectory(path.dirname(filename));
}
function prepareHook(testHooks, stage) {
    if (testHooks === undefined) return;
    if (!plain(testHooks) || Object.keys(testHooks).some(key => ![
        'afterDirectoryCreate', 'afterDecisionsCreate', 'afterStateWrite'
    ].includes(key)) || Object.values(testHooks).some(hook => typeof hook !== 'function')) {
        fail('prepare 的测试钩子格式不正确');
    }
    testHooks[stage]?.();
}
function prepareDirectoryState(directory, expectedState) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        fail('existing crosswalk prepare directory is unsafe');
    }
    const entries = fs.readdirSync(directory).sort();
    if (entries.some(name => !['decisions', 'state.json', 'final-receipt.json'].includes(name))) {
        fail('existing crosswalk prepare directory contains unknown content');
    }
    const hasDecisions = entries.includes('decisions'); const hasState = entries.includes('state.json');
    const hasFinalReceipt = entries.includes('final-receipt.json');
    if (hasFinalReceipt && (!hasState || !hasDecisions)) fail('已定稿的 crosswalk 缺少 state 或 decision 证据目录');
    if (hasDecisions) {
        const decisions = safeDirectory(path.join(directory, 'decisions'));
        if (!hasState && fs.readdirSync(decisions).length) {
            fail('没有 state 时 crosswalk prepare 的 decisions 目录不能非空');
        }
    }
    if (!hasState) return { hasDecisions, state: null, complete: false };
    const loaded = readRegular(path.join(directory, 'state.json'), MAX_STATE_BYTES, 'crosswalk prepare state');
    const existing = assertCrosswalkState(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(existing))) fail('crosswalk prepare 的 state 字节不规范');
    if (existing.crosswalkId !== expectedState.crosswalkId
        || stableHash(existing.source) !== stableHash(expectedState.source)) {
        fail('已有的 crosswalkId 属于另一份清单');
    }
    if (!hasDecisions && existing.attempts.length) {
        fail('crosswalk prepare 的 state 有 attempt，却没有 decision 证据目录');
    }
    if (hasFinalReceipt) {
        if (existing.completion.status !== 'complete') fail('crosswalk 未完成时不能附最终 receipt');
        const loadedReceipt = readRegular(path.join(directory, 'final-receipt.json'), MAX_RECEIPT_BYTES,
            'crosswalk prepare final receipt');
        const receipt = normalizeFinalReceipt(loadedReceipt.value);
        if (!loadedReceipt.bytes.equals(prettyBytes(receipt))
            || stableHash(receipt) !== stableHash(finalReceiptFor(existing))) {
            fail('crosswalk prepare 的最终 receipt 与现有 state 不匹配');
        }
    }
    return { hasDecisions, state: existing, complete: hasDecisions };
}
function rollbackPreparedPath(filename, expectedBytes) {
    try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const loaded = readRegular(filename, MAX_STATE_BYTES, 'crosswalk rollback state');
    if (!loaded.bytes.equals(expectedBytes)) fail('crosswalk 回滚拒绝删除已变化的 state 证据');
    fs.unlinkSync(filename);
}
function removeEmptyPrepareDirectory(directory, label) {
    let info;
    try { info = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || fs.readdirSync(directory).length) fail(`回滚时 ${label} 已变化`);
    fs.rmdirSync(directory);
}
function prepareCrosswalk({ crosswalkRoot, inventoryHandle, crosswalkId, now, apply = false, testHooks } = {}) {
    if (typeof apply !== 'boolean') fail('apply 必须是布尔值');
    const state = buildInitialState(inventoryHandle, { crosswalkId, now });
    if (!apply) return state;
    const root = safeDirectory(crosswalkRoot, { create: true });
    const directory = path.resolve(root, state.crosswalkId);
    let createdDirectory = false; let createdDecisions = false; let createdState = false;
    const stateFile = path.join(directory, 'state.json'); const stateBytes = prettyBytes(state);
    try { fs.mkdirSync(directory, { mode: 0o700 }); createdDirectory = true; }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    if (createdDirectory) {
        try { prepareHook(testHooks, 'afterDirectoryCreate'); }
        catch (error) { removeEmptyPrepareDirectory(directory, 'crosswalk prepare directory'); throw error; }
    }
    try {
        let current = prepareDirectoryState(directory, state);
        if (current.complete) return current.state;
        if (!current.hasDecisions) {
            try {
                fs.mkdirSync(path.join(directory, 'decisions'), { mode: 0o700 }); createdDecisions = true;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                current = prepareDirectoryState(directory, state);
                if (current.complete) return current.state;
                if (!current.hasDecisions) fail('crosswalk decisions directory creation raced unsafely');
            }
            if (createdDecisions) prepareHook(testHooks, 'afterDecisionsCreate');
        }
        if (current.state) return readCrosswalk({ crosswalkRoot: root, crosswalkId: state.crosswalkId });
        try { writeExclusive(stateFile, stateBytes); createdState = true; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        prepareHook(testHooks, 'afterStateWrite');
        current = prepareDirectoryState(directory, state);
        if (!current.complete) fail('crosswalk prepare 未产出完整可恢复的目录');
        return current.state;
    } catch (error) {
        let rollbackError = null;
        try { if (createdState) rollbackPreparedPath(stateFile, stateBytes); } catch (failure) { rollbackError = failure; }
        try { if (createdDecisions) removeEmptyPrepareDirectory(path.join(directory, 'decisions'), 'crosswalk decisions directory'); }
        catch (failure) { rollbackError ||= failure; }
        try { if (createdDirectory) removeEmptyPrepareDirectory(directory, 'crosswalk prepare directory'); }
        catch (failure) { rollbackError ||= failure; }
        if (rollbackError) throw rollbackError;
        throw error;
    }
}
function readCrosswalk({ crosswalkRoot, crosswalkId } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const filename = safeDirectJson(directory, 'state.json');
    const loaded = readRegular(filename, MAX_STATE_BYTES, 'crosswalk state');
    const state = assertCrosswalkState(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(state))) fail('crosswalk state 字节不规范');
    const decisionDirectory = safeDirectory(path.join(directory, 'decisions'));
    for (const [index, attempt] of state.attempts.entries()) {
        const decisionFile = safeDirectJson(decisionDirectory, attempt.decisionName);
        const decision = readRegular(decisionFile, MAX_DECISION_BYTES, `decision for attempt[${index}]`);
        const artifact = normalizeDecisionArtifact(decision.value);
        if (!decision.bytes.equals(prettyBytes(artifact)) || decision.sha256 !== attempt.decisionFileSha256
            || artifact.artifactSha256 !== attempt.decisionArtifactSha256
            || artifact.crosswalkId !== state.crosswalkId || artifact.operationId !== attempt.operationId
            || artifact.expectedStateSha256 !== attempt.priorStateSha256 || artifact.pageKey !== attempt.pageKey
            || artifact.pagePath !== state.assignments[attempt.pageKey].pagePath
            || artifact.pageContentSha256 !== state.assignments[attempt.pageKey].pageContentSha256
            || artifact.actorId !== attempt.actorId || artifact.result.status !== attempt.toStatus
            || artifact.result.reason !== attempt.reason
            || stableHash(artifact.sourceAuthority) !== stableHash(attempt.sourceAuthority)) {
            fail(`decision artifact replay drifted for attempt[${index}]`);
        }
    }
    return state;
}

function decisionDigest(value) { const body = clone(value); delete body.artifactSha256; return stableHash(body); }
function normalizeDecisionArtifact(value) {
    exact(value, ['contract', 'version', 'crosswalkId', 'operationId', 'expectedStateSha256', 'pageKey',
        'pagePath', 'pageContentSha256', 'actorId', 'result', 'sourceAuthority', 'createdAt', 'artifactSha256'], 'decision artifact');
    if (value.contract !== DECISION_CONTRACT || value.version !== VERSION || !UUID_RE.test(value.crosswalkId)
        || !UUID_RE.test(value.operationId)) fail('decision 的契约、版本或 UUID 无效');
    assertSha(value.expectedStateSha256, 'decision expectedStateSha256');
    if (!PAGE_KEY_RE.test(value.pageKey)) fail('decision 的 page key 格式不正确');
    text(value.pagePath, 'decision pagePath'); assertSha(value.pageContentSha256, 'decision page content SHA');
    text(value.actorId, 'decision actorId', 120); timestamp(value.createdAt, 'decision createdAt');
    exact(value.result, ['status', 'reason'], 'decision result');
    if (![...FINAL_REVIEW_STATUSES, 'verified'].includes(value.result.status)) fail('decision 的 status 不受支持');
    if (value.result.status === 'verified') validateAuthorityReference(value.sourceAuthority, 'decision sourceAuthority');
    else if (value.sourceAuthority !== null) fail('review-only decision 不能带来源权威');
    text(value.result.reason, 'decision reason', 2000);
    if (assertSha(value.artifactSha256, 'decision artifactSha256') !== decisionDigest(value)) fail('decision artifact 的自校验 SHA 已变化');
    return clone(value);
}
function buildDecisionArtifact({ state, pageKey, operationId = crypto.randomUUID(), actorId, status, reason, now } = {}) {
    if (status === 'verified') fail('verified decision requires an authenticated paper source authority handle');
    const checked = assertCrosswalkState(state);
    if (!Object.hasOwn(checked.assignments, pageKey)) fail('verified decision 的 pageKey 不在 crosswalk 中');
    const assignment = checked.assignments[pageKey];
    const body = { contract: DECISION_CONTRACT, version: VERSION, crosswalkId: checked.crosswalkId,
        operationId, expectedStateSha256: checked.stateSha256, pageKey, pagePath: assignment.pagePath,
        pageContentSha256: assignment.pageContentSha256, actorId, result: { status, reason },
        sourceAuthority: null, createdAt: nowIso(now) };
    return normalizeDecisionArtifact({ ...body, artifactSha256: stableHash(body) });
}
function buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle, operationId = crypto.randomUUID(),
    actorId, reason = 'Authenticated source authority exactly matches an explicit page identity hint.', now } = {}) {
    const checked = assertCrosswalkState(state);
    if (!Object.hasOwn(checked.assignments, pageKey)) fail('verified decision 的 pageKey 不在 crosswalk 中');
    const source = sourceAuthoritySnapshot(authorityHandle); const snapshot = source.snapshot;
    if (snapshot.productionAuthorized !== true) {
        fail('verified decision requires a production-authorized source authority');
    }
    const identity = snapshot.authority.identity;
    const expectedHint = identity.kind === 'arxiv'
        ? { scheme: 'arxiv', value: identity.arxivId }
        : { scheme: identity.externalId.scheme, value: identity.externalId.value };
    const assignment = checked.assignments[pageKey]; const sourceAuthority = authorityReference(source);
    const paper = checked.source.papers.find(item => item.pageKey === pageKey);
    const hintMatches = paper.identityHints.status === 'single'
        ? paper.identityHints.candidates.filter(candidate => candidate.scheme === expectedHint.scheme
            && candidate.value === expectedHint.value
            && candidate.sources.every(source => !/(?:^|:)title(?:$|:)/i.test(source)))
        : [];
    const titleBindings = snapshot.authority.titleBindings;
    const titleBindingMatches = Array.isArray(titleBindings) && ['none', 'conflict'].includes(paper.identityHints.status)
        ? titleBindings.filter(binding => binding?.pageKey === pageKey && binding.pagePath === assignment.pagePath
            && binding.pageContentSha256 === assignment.pageContentSha256)
        : [];
    if (hintMatches.length !== 1 && titleBindingMatches.length !== 1) {
        if (paper.identityHints.status !== 'single' && !Array.isArray(titleBindings)) {
            fail('verified authority requires a single unambiguous page identity hint; conflict/multiple requires separate resolution authority');
        }
        if (paper.identityHints.status !== 'single' && !titleBindingMatches.length) {
            fail('verified authority 需要单一且无歧义的页面身份提示，或一条重放的标题指纹绑定');
        }
        fail('verified authority 必须匹配一条显式的非标题页面身份提示');
    }
    const body = { contract: DECISION_CONTRACT, version: VERSION, crosswalkId: checked.crosswalkId,
        operationId, expectedStateSha256: checked.stateSha256, pageKey, pagePath: assignment.pagePath,
        pageContentSha256: assignment.pageContentSha256, actorId, result: { status: 'verified', reason },
        sourceAuthority, createdAt: nowIso(now) };
    return normalizeDecisionArtifact({ ...body, artifactSha256: stableHash(body) });
}
function writeDecisionArtifact({ crosswalkRoot, crosswalkId, decisionName, artifact } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const decisions = safeDirectory(path.join(directory, 'decisions'));
    const filename = safeDirectJson(decisions, decisionName, { mustExist: false });
    const normalized = normalizeDecisionArtifact(artifact);
    if (normalized.crosswalkId !== crosswalkId) fail('decision 属于另一个 crosswalk');
    try { writeExclusive(filename, prettyBytes(normalized)); }
    catch (error) { if (error instanceof PageSourceCrosswalkError) throw error; fail(`无法保留 decision：${error.message}`); }
    return filename;
}
function loadDecisionHandle(filename, { authorityHandle = null } = {}) {
    const loaded = readRegular(filename, MAX_DECISION_BYTES, 'crosswalk decision');
    const artifact = normalizeDecisionArtifact(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(artifact))) fail('decision artifact 的字节不规范');
    let authorityAuthenticated = false;
    if (artifact.result.status === 'verified') {
        const source = sourceAuthoritySnapshot(authorityHandle); const snapshot = source.snapshot;
        if (stableHash(artifact.sourceAuthority) !== stableHash(authorityReference(source))) {
            fail('verified decision 的 authority 与已认证的 authority 句柄不一致');
        }
        if (snapshot.productionAuthorized !== true) {
            fail('verified decision 的 authority 未获生产授权');
        }
        authorityAuthenticated = true;
    } else if (authorityHandle !== null) fail('review-only decision 不得接收来源权威');
    const handle = Object.freeze(Object.create(null)); DECISION_HANDLES.add(handle);
    DECISION_HANDLE_DATA.set(handle, Object.freeze({ artifact, filename: fs.realpathSync(filename),
        fileSha256: loaded.sha256, fileDev: loaded.dev, fileIno: loaded.ino,
        authorityAuthenticated, authorityHandle }));
    return handle;
}
function decisionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !DECISION_HANDLES.has(handle)) fail('需要已认证的 decision 句柄');
    const { authorityHandle: _authorityHandle, ...snapshot } = DECISION_HANDLE_DATA.get(handle);
    return clone(snapshot);
}
function lockOwnerRecord(owner, now, token = crypto.randomUUID()) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) fail('owner 格式不正确');
    if (!UUID_RE.test(token)) fail('lock owner token 必须是规范的 UUID v4');
    const startedAt = nowIso(now);
    const body = { contract: LOCK_OWNER_CONTRACT, version: VERSION, owner, pid: process.pid,
        hostname: os.hostname(), token, startedAt, heartbeatAt: startedAt, leaseMs: LOCK_STALE_MS };
    return { ...body, ownerSha256: stableHash(body) };
}
function validateLockOwner(value) {
    exact(value, ['contract', 'version', 'owner', 'pid', 'hostname', 'token', 'startedAt', 'heartbeatAt',
        'leaseMs', 'ownerSha256'], 'crosswalk lock owner');
    if (value.contract !== LOCK_OWNER_CONTRACT || value.version !== VERSION) fail('crosswalk lock owner 的契约或版本不一致');
    if (!OWNER_RE.test(value.owner)) fail('crosswalk lock owner 格式不正确');
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) fail('crosswalk lock owner 的 PID 格式不正确');
    text(value.hostname, 'crosswalk lock hostname', 255);
    if (!UUID_RE.test(value.token)) fail('crosswalk lock token 格式不正确');
    timestamp(value.startedAt, 'crosswalk lock startedAt'); timestamp(value.heartbeatAt, 'crosswalk lock heartbeatAt');
    if (value.heartbeatAt < value.startedAt) fail('crosswalk lock 的心跳早于启动时间');
    if (value.leaseMs !== LOCK_STALE_MS) fail('crosswalk lock 的 lease 与受支持策略不一致');
    const body = clone(value); delete body.ownerSha256;
    if (assertSha(value.ownerSha256, 'crosswalk lock ownerSha256') !== stableHash(body)) {
        fail('crosswalk lock owner self-SHA drifted');
    }
    return clone(value);
}
function readLockDirectory(lockPath, label = 'crosswalk operation lock') {
    const info = fs.lstatSync(lockPath);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(lockPath) !== lockPath) {
        fail(`${label} is not a canonical directory`);
    }
    const entries = fs.readdirSync(lockPath).sort();
    if (entries.length !== 1 || entries[0] !== 'owner.json') fail(`${label} contains unknown or missing evidence`);
    const ownerPath = path.join(lockPath, 'owner.json');
    const loaded = readRegular(ownerPath, MAX_LOCK_OWNER_BYTES, `${label} owner`);
    const record = validateLockOwner(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(record))) fail(`${label} 的 owner 字节不规范`);
    const ownerInfo = fs.lstatSync(ownerPath);
    return { lockPath, directoryDev: info.dev, directoryIno: info.ino, directoryMtimeMs: info.mtimeMs,
        ownerDev: ownerInfo.dev, ownerIno: ownerInfo.ino, ownerMtimeMs: ownerInfo.mtimeMs,
        ownerFileSha256: loaded.sha256, record };
}
function processLiveness(record) {
    if (record.hostname !== os.hostname()) return 'remote';
    try { process.kill(record.pid, 0); return 'alive'; }
    catch (error) {
        if (error.code === 'ESRCH') return 'dead';
        if (error.code === 'EPERM') return 'alive';
        throw error;
    }
}
function localCrawlBatchMayImmediatelyReclaim(snapshot, options = {}) {
    if (![HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY,
        HISTORICAL_CONFERENCE_CRAWL_BATCH_LOCK_RECOVERY].includes(options.recoveryPolicy)) return false;
    // readLockDirectory 会先校验准确的 owner 契约、规范字节、自哈希和锁目录，
    // 这个能力对象才可能生效。远端、仍存活、权限不明、格式错误或空的锁，有意
    // 都不允许立即恢复。
    return snapshot?.record?.hostname === os.hostname()
        && processLiveness(snapshot.record) === 'dead';
}
function reclaimableLock(snapshot, currentTime = Date.now(), options = {}) {
    if (localCrawlBatchMayImmediatelyReclaim(snapshot, options)) return true;
    const liveness = processLiveness(snapshot.record);
    if (liveness === 'alive') return false;
    const heartbeat = new Date(snapshot.record.heartbeatAt).getTime();
    const filesystemAge = currentTime - Math.max(snapshot.directoryMtimeMs, snapshot.ownerMtimeMs);
    return currentTime - heartbeat >= LOCK_STALE_MS && filesystemAge >= LOCK_STALE_MS;
}
function sameLockSnapshot(left, right) {
    return left.directoryDev === right.directoryDev && left.directoryIno === right.directoryIno
        && left.ownerDev === right.ownerDev && left.ownerIno === right.ownerIno
        && left.ownerFileSha256 === right.ownerFileSha256
        && left.record.ownerSha256 === right.record.ownerSha256;
}
function removeVerifiedLockDirectory(snapshot, label) {
    const current = readLockDirectory(snapshot.lockPath, label);
    if (!sameLockSnapshot(snapshot, current)) fail(`${label} 在移除前已变化`);
    fs.unlinkSync(path.join(snapshot.lockPath, 'owner.json'));
    fs.rmdirSync(snapshot.lockPath);
    syncDirectory(path.dirname(snapshot.lockPath));
}
function createLockDirectory(lockPath, owner, now) {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const record = lockOwnerRecord(owner, now); const ownerPath = path.join(lockPath, 'owner.json');
    const ownerBytes = prettyBytes(record);
    try { writeExclusive(ownerPath, ownerBytes); }
    catch (error) {
        try { rollbackPreparedPath(ownerPath, ownerBytes); } catch {}
        try { removeEmptyPrepareDirectory(lockPath, 'crosswalk lock directory'); } catch {}
        throw error;
    }
    return readLockDirectory(lockPath);
}
function clearOrRejectReclaimMarker(reclaimPath, options = {}) {
    let snapshot;
    try { snapshot = readLockDirectory(reclaimPath, 'crosswalk lock reclaim marker'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const liveness = processLiveness(snapshot.record);
    if (liveness === 'alive') fail('crosswalk lock 的回收标记属于存活进程');
    if (!reclaimableLock(snapshot, Date.now(), options)) fail('crosswalk lock 的回收标记尚未过期');
    removeVerifiedLockDirectory(snapshot, 'crosswalk lock reclaim marker');
}
function uninstallLockSignalHandlers() {
    if (!lockSignalHandlersInstalled) return;
    for (const signal of LOCK_SIGNALS) process.removeListener(signal, handleLockSignal);
    lockSignalHandlersInstalled = false;
}
function handleLockSignal(signal) {
    if (handlingLockSignal) return;
    handlingLockSignal = true;
    for (const handle of [...ACTIVE_LOCK_HANDLES]) {
        try { releaseLock(handle); }
        catch (error) {
            try { process.stderr.write(`[crosswalk-lock] ${signal} cleanup refused: ${error.message}\n`); } catch {}
        }
    }
    uninstallLockSignalHandlers();
    process.exit(signal === 'SIGINT' ? 130 : 143);
}
function installLockSignalHandlers() {
    if (lockSignalHandlersInstalled) return;
    for (const signal of LOCK_SIGNALS) process.on(signal, handleLockSignal);
    lockSignalHandlersInstalled = true;
}
function acquireLock(directory, owner, now, options = {}) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) fail('owner 格式不正确');
    const lockPath = path.join(directory, 'operation.lock');
    const reclaimPath = path.join(directory, 'operation.lock.reclaim');
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try { fs.lstatSync(reclaimPath); clearOrRejectReclaimMarker(reclaimPath, options); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
            const snapshot = createLockDirectory(lockPath, owner, now);
            const handle = Object.freeze(Object.create(null)); LOCK_HANDLES.add(handle);
            LOCK_HANDLE_DATA.set(handle, Object.freeze({ lockPath, snapshot }));
            ACTIVE_LOCK_HANDLES.add(handle); installLockSignalHandlers();
            return handle;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const stale = readLockDirectory(lockPath);
        const liveness = processLiveness(stale.record);
        if (liveness === 'alive') fail('crosswalk is locked by a live process');
        if (!reclaimableLock(stale, Date.now(), options)) fail('crosswalk lock belongs to a dead process but is not stale');
        let reclaim;
        try { reclaim = createLockDirectory(reclaimPath, owner, now); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try {
            let current;
            try { current = readLockDirectory(lockPath); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!sameLockSnapshot(stale, current)) fail('crosswalk operation lock 在过期回收期间已变化');
            if (!reclaimableLock(current, Date.now(), options)) fail('crosswalk operation lock 已不再可安全回收');
            removeVerifiedLockDirectory(current, 'crosswalk operation lock');
        } finally {
            removeVerifiedLockDirectory(reclaim, 'crosswalk lock reclaim marker');
        }
    }
    fail('获取 crosswalk lock 超过有界回收次数');
}
function releaseLock(handle) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) fail('需要已认证的 crosswalk lock 句柄');
    const expected = LOCK_HANDLE_DATA.get(handle); const snapshot = readLockDirectory(expected.lockPath);
    if (!sameLockSnapshot(expected.snapshot, snapshot)
        || snapshot.record.token !== expected.snapshot.record.token
        || snapshot.record.pid !== process.pid || snapshot.record.pid !== expected.snapshot.record.pid
        || snapshot.record.hostname !== os.hostname()
        || snapshot.record.hostname !== expected.snapshot.record.hostname) {
        fail('crosswalk operation lock 在持有期间已变化');
    }
    removeVerifiedLockDirectory(snapshot, 'crosswalk operation lock');
    ACTIVE_LOCK_HANDLES.delete(handle); LOCK_HANDLES.delete(handle); LOCK_HANDLE_DATA.delete(handle);
    if (ACTIVE_LOCK_HANDLES.size === 0 && !handlingLockSignal) {
        // 在同步 fsync/rename 期间送达的信号，要等当前 JS 栈退完才会派发。处理函数
        // 多留一轮，这样已完成的原子写入和它的 finally 释放之后，能按预期以 128+signal
        // 退出，而不是丢掉 SIGINT。
        setImmediate(() => {
            if (ACTIVE_LOCK_HANDLES.size === 0 && !handlingLockSignal) uninstallLockSignalHandlers();
        });
    }
}
function applyDecision({ crosswalkRoot, crosswalkId, decisionHandle, owner, now, recoveryPolicy = null } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    if (!decisionHandle || typeof decisionHandle !== 'object' || !DECISION_HANDLES.has(decisionHandle)) {
        fail('需要已认证的 decision 句柄');
    }
    const originalDecision = DECISION_HANDLE_DATA.get(decisionHandle);
    const decision = decisionHandleSnapshot(decisionHandle);
    const expectedDirectory = fs.realpathSync(path.join(directory, 'decisions'));
    if (path.dirname(decision.filename) !== expectedDirectory) fail('decision 句柄不在本 crosswalk 的 decision 目录内');
    const lock = acquireLock(directory, owner, now, { recoveryPolicy });
    try {
        let replayedAuthorityHandle = null;
        if (originalDecision.authorityAuthenticated) {
            try {
                replayedAuthorityHandle = replaySourceAuthorityHandle(originalDecision.authorityHandle,
                    { requireProduction: true });
            } catch (error) {
                fail(`锁定期间 verified decision 的 authority 重放失败：${error.message}`);
            }
        }
        const currentDecisionHandle = loadDecisionHandle(originalDecision.filename,
            { authorityHandle: replayedAuthorityHandle });
        const currentDecision = DECISION_HANDLE_DATA.get(currentDecisionHandle);
        if (currentDecision.fileDev !== originalDecision.fileDev || currentDecision.fileIno !== originalDecision.fileIno
            || currentDecision.fileSha256 !== originalDecision.fileSha256
            || stableHash(currentDecision.artifact) !== stableHash(originalDecision.artifact)) {
            fail('decision file changed after its handle was loaded');
        }
        const state = readCrosswalk({ crosswalkRoot, crosswalkId }); const artifact = decision.artifact;
        if (artifact.result.status === 'verified' && decision.authorityAuthenticated !== true) {
            fail('verified decision 句柄缺少已认证的来源权威');
        }
        if (artifact.crosswalkId !== crosswalkId) fail('decision 属于另一个 crosswalk');
        const prior = state.attempts.find(item => item.operationId === artifact.operationId);
        if (prior) {
            if (prior.decisionFileSha256 !== decision.fileSha256 || prior.decisionArtifactSha256 !== artifact.artifactSha256) {
                fail('operationId was already used by different decision evidence');
            }
            return state;
        }
        if (artifact.expectedStateSha256 !== state.stateSha256) fail('decision 的 compare-and-swap state SHA 不一致');
        const current = state.assignments[artifact.pageKey];
        if (!current || current.pagePath !== artifact.pagePath || current.pageContentSha256 !== artifact.pageContentSha256) {
            fail('decision 的页面快照与 crosswalk assignment 不一致');
        }
        if (current.status !== 'pending') fail('只有 pending assignment 可以接收当前 review decision');
        const recordedAt = nowIso(now);
        if (artifact.createdAt > recordedAt) fail('decision artifact 不能早于其创建时间被记录');
        const next = clone(state);
        next.assignments[artifact.pageKey] = { ...current, status: artifact.result.status,
            reason: artifact.result.reason, decisionArtifactSha256: artifact.artifactSha256,
            sourceAuthority: clone(artifact.sourceAuthority) };
        const attempt = { operationId: artifact.operationId, decisionName: path.basename(decision.filename),
            decisionFileSha256: decision.fileSha256, decisionArtifactSha256: artifact.artifactSha256,
            pageKey: artifact.pageKey, fromStatus: 'pending', toStatus: artifact.result.status,
            reason: artifact.result.reason, actorId: artifact.actorId,
            sourceAuthority: clone(artifact.sourceAuthority), recordedAt,
            priorStateSha256: state.stateSha256, nextStateSha256: '' };
        next.attempts.push(attempt); next.completion = completionFor(next.assignments);
        next.identityGroups = identityGroupsFor(next.assignments);
        next.identityGroupsSha256 = stableHash(next.identityGroups);
        next.stateSha256 = stateDigest(next); attempt.nextStateSha256 = next.stateSha256;
        const checked = assertCrosswalkState(next);
        replaceState(path.join(directory, 'state.json'), prettyBytes(checked));
        return checked;
    } finally { releaseLock(lock); }
}
function applyDecisionFile({ crosswalkRoot, crosswalkId, decisionName, owner, now } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const filename = safeDirectJson(path.join(directory, 'decisions'), decisionName);
    return applyDecision({ crosswalkRoot, crosswalkId, decisionHandle: loadDecisionHandle(filename), owner, now });
}
function finalReceiptFor(state) {
    const body = { contract: FINAL_RECEIPT_CONTRACT, version: VERSION, crosswalkId: state.crosswalkId,
        stateSha256: state.stateSha256, stateFileSha256: sha256(prettyBytes(state)),
        ledgerSha256: state.source.ledgerSha256, ledgerFileSha256: state.source.ledgerFileSha256,
        historicalReceiptSha256: state.source.receiptSha256,
        verifiedAssignmentSetSha256: state.completion.assignmentSetSha256,
        identityGroups: clone(state.identityGroups), identityGroupsSha256: state.identityGroupsSha256,
        verified: state.completion.verified, total: state.completion.total };
    return { ...body, receiptSha256: stableHash(body) };
}
function normalizeFinalReceipt(value) {
    exact(value, ['contract', 'version', 'crosswalkId', 'stateSha256', 'stateFileSha256', 'ledgerSha256',
        'ledgerFileSha256', 'historicalReceiptSha256', 'verifiedAssignmentSetSha256', 'identityGroups',
        'identityGroupsSha256', 'verified', 'total', 'receiptSha256'], 'crosswalk final receipt');
    if (value.contract !== FINAL_RECEIPT_CONTRACT || value.version !== VERSION || !UUID_RE.test(value.crosswalkId)) {
        fail('crosswalk 最终 receipt 的契约、版本或 UUID 无效');
    }
    for (const field of ['stateSha256', 'stateFileSha256', 'ledgerSha256', 'ledgerFileSha256',
        'historicalReceiptSha256', 'verifiedAssignmentSetSha256', 'identityGroupsSha256']) {
        assertSha(value[field], `crosswalk final receipt ${field}`);
    }
    if (!Number.isSafeInteger(value.verified) || !Number.isSafeInteger(value.total)
        || value.verified < 1 || value.verified !== value.total) fail('crosswalk 最终 receipt 的计数无效');
    const identityGroups = normalizeIdentityGroups(value.identityGroups, 'crosswalk final receipt identityGroups');
    if (stableHash(identityGroups) !== value.identityGroupsSha256
        || identityGroups.reduce((count, group) => count + group.pageKeys.length, 0) !== value.total) {
        fail('crosswalk 最终 receipt 的 identity group 已变化');
    }
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'crosswalk final receipt receiptSha256') !== stableHash(body)) {
        fail('crosswalk 最终 receipt 的自校验 SHA 已变化');
    }
    return { ...clone(value), identityGroups };
}
function replaySourceAuthorities(state, authorityRoot, authorityResolver, archiveIdentityRoot = null, archiveDataRoot = null,
    localCrawlIdentityRoot = null, localCrawlSnapshotRoot = null, localCrawlDataRoot = null,
    conferenceIdentityRoot = null, conferenceDataRoot = null, conferenceBlogRoot = null, conferenceIclrAcceptedRoot = null) {
    for (const assignment of Object.values(state.assignments)) {
        const reference = validateAuthorityReference(assignment.sourceAuthority);
        let handle;
        try {
            handle = authorityResolver
                ? authorityResolver(clone(reference))
                : reference.authorityContract === archiveIdentityApi.CONTRACT
                    ? archiveIdentityApi.loadArchiveCrawlAuthorityHandle({ identityRoot: archiveIdentityRoot,
                        dataRoot: archiveDataRoot, authorityName: reference.authorityName })
                    : reference.authorityContract === localCrawlIdentityApi.CONTRACT
                        ? localCrawlIdentityApi.loadLocalCrawlAuthorityHandle({ identityRoot: localCrawlIdentityRoot,
                            snapshotRoot: localCrawlSnapshotRoot, dataRoot: localCrawlDataRoot, authorityName: reference.authorityName })
                    : reference.authorityContract === conferenceIdentityApi.CONTRACT
                        ? conferenceIdentityApi.loadConferenceCrawlAuthorityHandle({ identityRoot: conferenceIdentityRoot,
                            dataRoot: conferenceDataRoot, blogRoot: conferenceBlogRoot, iclrAcceptedRoot: conferenceIclrAcceptedRoot,
                            authorityName: reference.authorityName })
                    : authorityApi.loadAuthorityHandle({ authorityRoot, authorityName: reference.authorityName });
            const replayed = replaySourceAuthorityHandle(handle, { requireProduction: true });
            const source = sourceAuthoritySnapshot(replayed);
            if (stableHash(reference) !== stableHash(authorityReference(source))) {
                fail('finalize 的来源权威与 verified assignment 不一致');
            }
        } catch (error) {
            if (error instanceof PageSourceCrosswalkError) throw error;
            fail(`finalize 无法重放来源权威：${error.message}`);
        }
    }
}
function readFinalReceipt({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver = null,
    archiveIdentityRoot = null, archiveDataRoot = null, localCrawlIdentityRoot = null, localCrawlSnapshotRoot = null,
    localCrawlDataRoot = null, conferenceIdentityRoot = null, conferenceDataRoot = null, conferenceBlogRoot = null,
    conferenceIclrAcceptedRoot = null } = {}) {
    const state = readCrosswalk({ crosswalkRoot, crosswalkId });
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const receiptFile = safeDirectJson(directory, 'final-receipt.json');
    const loaded = readRegular(receiptFile, MAX_RECEIPT_BYTES, 'crosswalk final receipt');
    const receipt = normalizeFinalReceipt(loaded.value); const expected = finalReceiptFor(state);
    if (!loaded.bytes.equals(prettyBytes(receipt)) || stableHash(receipt) !== stableHash(expected)) {
        fail('crosswalk 最终 receipt 与当前完整 state 不匹配');
    }
    replaySourceAuthorities(state, authorityRoot, authorityResolver, archiveIdentityRoot, archiveDataRoot,
        localCrawlIdentityRoot, localCrawlSnapshotRoot, localCrawlDataRoot, conferenceIdentityRoot, conferenceDataRoot, conferenceBlogRoot, conferenceIclrAcceptedRoot);
    return { state, receipt, receiptFile, receiptFileSha256: loaded.sha256 };
}
function finalizeCrosswalk({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver = null,
    archiveIdentityRoot = null, archiveDataRoot = null, localCrawlIdentityRoot = null, localCrawlSnapshotRoot = null,
    localCrawlDataRoot = null, conferenceIdentityRoot = null, conferenceDataRoot = null, conferenceBlogRoot = null,
    conferenceIclrAcceptedRoot = null, now } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const lock = acquireLock(directory, 'crosswalk.finalize', now);
    try {
        const state = readCrosswalk({ crosswalkRoot, crosswalkId });
        if (state.completion.status !== 'complete' || state.completion.verified !== state.completion.total) {
            fail('finalize 要求每篇论文都有已认证的 verified 来源权威');
        }
        replaySourceAuthorities(state, authorityRoot, authorityResolver, archiveIdentityRoot, archiveDataRoot,
            localCrawlIdentityRoot, localCrawlSnapshotRoot, localCrawlDataRoot, conferenceIdentityRoot, conferenceDataRoot, conferenceBlogRoot, conferenceIclrAcceptedRoot);
        const receipt = finalReceiptFor(state);
        const receiptFile = safeDirectJson(directory, 'final-receipt.json', { mustExist: false });
        try { writeExclusive(receiptFile, prettyBytes(receipt)); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const current = readCrosswalk({ crosswalkRoot, crosswalkId });
        if (current.stateSha256 !== state.stateSha256) fail('定稿时 crosswalk state 已变化');
        replaySourceAuthorities(current, authorityRoot, authorityResolver, archiveIdentityRoot, archiveDataRoot,
            localCrawlIdentityRoot, localCrawlSnapshotRoot, localCrawlDataRoot, conferenceIdentityRoot, conferenceDataRoot, conferenceBlogRoot, conferenceIclrAcceptedRoot);
        return readFinalReceipt({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver,
            archiveIdentityRoot, archiveDataRoot, localCrawlIdentityRoot, localCrawlSnapshotRoot,
            localCrawlDataRoot, conferenceIdentityRoot, conferenceDataRoot, conferenceBlogRoot, conferenceIclrAcceptedRoot });
    } finally {
        releaseLock(lock);
    }
}

module.exports = {
    LEDGER_CONTRACT, LEDGER_RECEIPT_CONTRACT, CONTRACT, DECISION_CONTRACT, LOCK_OWNER_CONTRACT,
    FINAL_RECEIPT_CONTRACT,
    VERSION, UUID_RE, SAFE_JSON_NAME, LOCK_STALE_MS,
    HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY, HISTORICAL_CONFERENCE_CRAWL_BATCH_LOCK_RECOVERY,
    PageSourceCrosswalkError, stableHash, prettyBytes, safeDirectory, safeDirectJson,
    validateHistoricalLedger, validateHistoricalReceipt, loadHistoricalInventoryHandle, inventoryHandleSnapshot,
    assignmentKey, sourceBinding, completionFor, identityGroupsFor, normalizeIdentityGroups,
    assertCrosswalkState, buildInitialState,
    crosswalkDirectory, prepareCrosswalk,
    readCrosswalk, normalizeDecisionArtifact, buildDecisionArtifact, buildVerifiedDecisionArtifact,
    writeDecisionArtifact, loadDecisionHandle,
    decisionHandleSnapshot, acquireLock, releaseLock, applyDecision, applyDecisionFile,
    normalizeFinalReceipt, readFinalReceipt, finalizeCrosswalk
};
