'use strict';

// Source-identity crosswalk. Verified assignments require a replayed,
// authenticated paper-source authority; titles are never identity evidence.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const authorityApi = require('./paper-source-authority.js');
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
    'paper_digest_primary_task', 'paper_digest_rank_bucket', 'paper_digest_reader_article_sha256',
    'paper_digest_reader_quality', 'paper_digest_score', 'paper_digest_sidecars',
    'paper_digest_tutorial_artifact_plan_sha256', 'paper_digest_tutorial_contract',
    'paper_digest_tutorial_payload_contract', 'paper_digest_tutorial_payload_sha256',
    'paper_digest_tutorial_quality_sha256', 'paper_digest_workbench_contract'
]);
const PRESERVED_PUBLICATION_STRING_FIELDS = new Set([
    'paper_digest_arxiv_id', 'paper_digest_arxiv_versioned_id', 'paper_digest_page_type'
]);
const SCAN_POLICY = Object.freeze({ contract: 'historical-page-scan-policy-v3', bodyRetention: 'sha256-only',
    identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
    linkOffsetUnit: 'utf8-byte-body-relative',
    taxonomyRoutes: 'unverified-candidates-v2', publicationEvidence: 'schema-checked-hash-default-whitelist-v3',
    targetRecordBinding: 'target-page-snapshot-sha256-v1' });
const FINAL_REVIEW_STATUSES = new Set(['needs-review', 'blocked', 'conflict']);
const ALL_STATUSES = new Set(['pending', ...FINAL_REVIEW_STATUSES, 'verified']);
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_DECISION_BYTES = 1024 * 1024;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const INVENTORY_HANDLES = new WeakSet();
const INVENTORY_HANDLE_DATA = new WeakMap();
const DECISION_HANDLES = new WeakSet();
const DECISION_HANDLE_DATA = new WeakMap();
const LOCK_HANDLES = new WeakSet();
const LOCK_HANDLE_DATA = new WeakMap();

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
function pythonJson(value, indent = 0) {
    function render(item, depth, forceFloat = false) {
        if (item === null || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) fail('JSON evidence contains a non-finite number');
            return forceFloat && Number.isInteger(item) ? `${item}.0` : JSON.stringify(item);
        }
        if (typeof item === 'string') return JSON.stringify(item);
        const newline = indent ? '\n' : ''; const separator = indent ? ',\n' : ',';
        if (Array.isArray(item)) {
            if (!item.length) return '[]';
            const padding = indent ? ' '.repeat((depth + 1) * indent) : '';
            const closing = indent ? ' '.repeat(depth * indent) : '';
            return `[${newline}${item.map(value => `${padding}${render(value, depth + 1)}`).join(separator)}${newline}${closing}]`;
        }
        if (!plain(item)) fail('JSON evidence contains a non-plain object');
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
    // Python json.dumps(sort_keys=True, indent=2, ensure_ascii=False) uses the
    // same two-space object/array indentation for the JSON values admitted here.
    return Buffer.from(`${pythonJson(canonical(value), 2)}\n`, 'utf8');
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}
function text(value, label, maximum = 4096) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
        || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must be bounded trimmed text without controls`);
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
        || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label} must be canonical UTC time`);
    return value;
}
function nowIso(now) {
    const parsed = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    if (Number.isNaN(parsed.getTime())) fail('now is invalid');
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
            try { key = JSON.parse(token); } catch { fail(`${label} contains invalid JSON syntax`); }
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
        if (!plain(value)) fail(`${label} must contain a JSON object`);
        return value;
    } catch (error) {
        if (error instanceof PageSourceCrosswalkError) throw error;
        fail(`${label} must contain strict UTF-8 JSON`);
    }
}

function safeDirectory(root, { create = false, allowMissing = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('configured root must be an absolute directory');
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
    if (fs.realpathSync(absolute) !== absolute) fail('configured root must use its canonical non-symlink path');
    return absolute;
}
function safeDirectJson(root, name, { mustExist = true, createRoot = false } = {}) {
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) fail('filename must be a safe direct JSON name');
    const directory = safeDirectory(root, { create: createRoot, allowMissing: !mustExist });
    const filename = path.resolve(directory, name);
    if (path.dirname(filename) !== directory) fail('JSON filename escapes its configured root');
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
            fail(`${label} must be a bounded regular single-link file`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.size > maximum) fail(`${label} changed or became unsafe while opening`);
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} changed while reading`);
        return { bytes, sha256: sha256(bytes), value: strictJson(bytes, label),
            dev: opened.dev, ino: opened.ino };
    } catch (error) {
        if (error instanceof PageSourceCrosswalkError) throw error;
        fail(`${label} cannot be read safely: ${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateHistoricalPage(page, index) {
    exact(page, ['pageId', 'path', 'gitBlobOid', 'contentBytes', 'contentSha256', 'frontmatterBytes',
        'frontmatterSha256', 'bodyBytes', 'bodySha256', 'primaryUrl', 'aliases', 'kind', 'scope', 'publishedDate', 'cohortDate',
        'legacyTaskKey', 'draft', 'published', 'legacy', 'identityHints', 'outboundPostLinks',
        'publicationEvidenceRefs', 'legacyTaxonomyCandidates', 'snapshotSha256', 'recordSha256'],
    `historical pages[${index}]`);
    text(page.path, `historical pages[${index}].path`);
    if (path.isAbsolute(page.path) || page.path.includes('\\') || page.path.split('/').some(part => ['', '.', '..'].includes(part))
        || !page.path.startsWith('content/posts/') || !page.path.endsWith('.md')) fail('historical page path is unsafe');
    if (!PAGE_KEY_RE.test(page.pageId)
        || page.pageId !== `page:${stableHash({ contract: 'historical-page-id-v1', path: page.path, primaryUrl: page.primaryUrl })}`) {
        fail('historical pageId does not bind path and primary URL');
    }
    if (!GIT_OID_RE.test(String(page.gitBlobOid || ''))) fail('historical page Git blob OID is invalid');
    if (!Number.isSafeInteger(page.contentBytes) || page.contentBytes < 1) fail('historical page contentBytes is invalid');
    if (!Number.isSafeInteger(page.frontmatterBytes) || page.frontmatterBytes < 1
        || !Number.isSafeInteger(page.bodyBytes) || page.bodyBytes < 0
        || page.frontmatterBytes + page.bodyBytes !== page.contentBytes) {
        fail('historical page frontmatter/body byte partition is invalid');
    }
    for (const field of ['contentSha256', 'frontmatterSha256', 'bodySha256']) assertSha(page[field], `historical page ${field}`);
    text(page.primaryUrl, 'historical page primaryUrl');
    if (!['paper', 'daily-summary', 'conference-summary', 'conference-task', 'unknown'].includes(page.kind)) {
        fail('historical page kind is unsupported');
    }
    if (!Array.isArray(page.aliases) || page.aliases.some(item => typeof item !== 'string')
        || stableHash(page.aliases) !== stableHash([...new Set(page.aliases)].sort())) {
        fail('historical page aliases must be a unique sorted string array');
    }
    exact(page.scope, ['type', 'key'], 'historical page scope');
    if (!['daily', 'conference', 'unknown', 'conflict'].includes(page.scope.type)
        || (page.scope.key !== null && typeof page.scope.key !== 'string')) fail('historical page scope is malformed');
    for (const field of ['publishedDate', 'cohortDate']) {
        if (typeof page[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(page[field])
            || Number.isNaN(new Date(`${page[field]}T00:00:00.000Z`).getTime())) fail(`historical page ${field} is invalid`);
    }
    if (page.legacyTaskKey !== null && (typeof page.legacyTaskKey !== 'string'
        || !/^task-[a-z0-9._-]+$/.test(page.legacyTaskKey))) fail('historical legacyTaskKey is invalid');
    if (typeof page.draft !== 'boolean' || typeof page.published !== 'boolean') {
        fail('historical page draft/published state is malformed');
    }
    exact(page.legacy, ['tags', 'categories', 'marker'], 'historical page legacy');
    for (const field of ['tags', 'categories']) {
        if (!Array.isArray(page.legacy[field]) || page.legacy[field].some(item => typeof item !== 'string' || !item)) {
            fail(`historical page legacy.${field} must be a string array`);
        }
    }
    exact(page.legacy.marker, ['pipelineOwned', 'declaredPageType', 'fieldNames', 'fieldsSha256'], 'historical page legacy marker');
    if ((page.legacy.marker.pipelineOwned !== null && typeof page.legacy.marker.pipelineOwned !== 'boolean')
        || (page.legacy.marker.declaredPageType !== null && typeof page.legacy.marker.declaredPageType !== 'string')
        || !Array.isArray(page.legacy.marker.fieldNames)
        || page.legacy.marker.fieldNames.some(item => typeof item !== 'string' || !item.startsWith('paper_digest_'))
        || stableHash(page.legacy.marker.fieldNames) !== stableHash([...new Set(page.legacy.marker.fieldNames)].sort())) {
        fail('historical page legacy marker is malformed');
    }
    assertSha(page.legacy.marker.fieldsSha256, 'historical page legacy marker fields SHA');
    normalizeIdentityHints(page.identityHints, 'historical page identityHints');
    if (!Array.isArray(page.outboundPostLinks)) fail('historical outboundPostLinks must be an array');
    page.outboundPostLinks.forEach((link, linkIndex) => {
        exact(link, ['ordinal', 'linkType', 'sourceByteStart', 'sourceByteEnd', 'targetRawSha256', 'targetUrl',
            'status', 'targetPath', 'targetPageId', 'targetRecordSha256'], 'historical outbound link');
        if (link.ordinal !== linkIndex + 1 || !LINK_TYPES.has(link.linkType)
            || !Number.isSafeInteger(link.sourceByteStart) || !Number.isSafeInteger(link.sourceByteEnd)
            || link.sourceByteStart < 0 || link.sourceByteEnd <= link.sourceByteStart
            || link.sourceByteEnd > page.bodyBytes) {
            fail('historical outbound link occurrence is invalid');
        }
        assertSha(link.targetRawSha256, 'historical outbound raw target SHA'); text(link.targetUrl, 'historical outbound target URL');
        if (!LINK_STATUSES.has(link.status)) fail('historical outbound link status is unsupported');
        for (const field of ['targetPath', 'targetPageId', 'targetRecordSha256']) {
            if (link[field] !== null && typeof link[field] !== 'string') fail('historical outbound target binding is malformed');
        }
    });
    if (!Array.isArray(page.publicationEvidenceRefs)) fail('historical publicationEvidenceRefs must be an array');
    const evidenceFields = [];
    for (const evidence of page.publicationEvidenceRefs) {
        exact(evidence, ['field', 'valueType', 'value', 'valueSha256'], 'historical publication evidence');
        if (!PUBLICATION_EVIDENCE_FIELDS.has(evidence.field)
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
            fail('structured publication evidence, including sidecars, must remain hash-only');
        } else if (evidence.valueType === 'null' && evidence.value !== null) {
            fail('null publication evidence must preserve null');
        } else if (evidence.valueType === 'boolean' && typeof evidence.value !== 'boolean') {
            fail('boolean publication evidence has the wrong value type');
        } else if (evidence.valueType === 'integer' && !Number.isSafeInteger(evidence.value)) {
            fail('integer publication evidence has the wrong value type');
        } else if (evidence.valueType === 'number'
            && (typeof evidence.value !== 'number' || !Number.isFinite(evidence.value) || Number.isInteger(evidence.value))) {
            fail('number publication evidence has the wrong value type');
        }
        if (evidence.value !== null || evidence.valueType === 'null') {
            if (stableHash(evidence.value) !== evidence.valueSha256) {
                fail(`historical publication evidence preserved value SHA drifted: ${evidence.field}`);
            }
        }
        evidenceFields.push(evidence.field);
    }
    if (stableHash(evidenceFields) !== stableHash([...new Set(evidenceFields)].sort())) {
        fail('historical publication evidence fields must be unique and sorted');
    }
    if (!Array.isArray(page.legacyTaxonomyCandidates)) fail('historical legacyTaxonomyCandidates must be an array');
    for (const candidate of page.legacyTaxonomyCandidates) {
        exact(candidate, ['taxonomy', 'term', 'status', 'candidateUrl', 'method'], 'historical taxonomy candidate');
        if (!['tags', 'categories'].includes(candidate.taxonomy) || candidate.status !== 'unverified'
            || candidate.method !== 'legacy-term-normalization-v1') fail('historical taxonomy candidate is unsupported');
        text(candidate.term, 'historical taxonomy term'); text(candidate.candidateUrl, 'historical taxonomy candidate URL');
    }
    const snapshotBody = clone(page); delete snapshotBody.outboundPostLinks;
    delete snapshotBody.snapshotSha256; delete snapshotBody.recordSha256;
    if (assertSha(page.snapshotSha256, 'historical page snapshotSha256') !== stableHash(snapshotBody)) {
        fail('historical page snapshot SHA drifted');
    }
    const body = clone(page); delete body.recordSha256;
    if (assertSha(page.recordSha256, 'historical page recordSha256') !== stableHash(body)) fail('historical page record SHA drifted');
    return clone(page);
}

function validateHistoricalLedger(value) {
    exact(value, ['contract', 'version', 'source', 'policy', 'pages', 'urlCollisions', 'outboundPostLinks',
        'outboundPostLinksSha256', 'counts', 'pageSetSha256', 'ledgerSha256'], 'historical page ledger');
    if (value.contract !== LEDGER_CONTRACT || value.version !== VERSION) fail('historical ledger contract/version is unsupported');
    exact(value.source, ['branch', 'head', 'clean', 'statusSha256', 'remoteName', 'remoteIdentitySha256',
        'remoteMain', 'baseUrl', 'hugoConfig', 'contentRoot', 'gitObjectFormat', 'contentTreeOid',
        'trackedPages', 'hugoRuntime'], 'historical ledger source');
    if (value.source.branch !== 'main' || value.source.clean !== true || value.source.contentRoot !== 'content/posts') {
        fail('crosswalk requires an inventory captured from clean blog branch main');
    }
    if (typeof value.source.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.source.head)) fail('historical source HEAD is invalid');
    for (const field of ['statusSha256', 'remoteIdentitySha256']) assertSha(value.source[field], `historical source ${field}`);
    text(value.source.remoteName, 'historical source remoteName'); text(value.source.baseUrl, 'historical source baseUrl');
    exact(value.source.remoteMain, ['availability', 'oid', 'ref'], 'historical source remoteMain');
    if (!['available', 'unavailable'].includes(value.source.remoteMain.availability)
        || value.source.remoteMain.ref !== `refs/remotes/${value.source.remoteName}/main`
        || (value.source.remoteMain.availability === 'available' && !GIT_OID_RE.test(String(value.source.remoteMain.oid || '')))
        || (value.source.remoteMain.availability === 'unavailable' && value.source.remoteMain.oid !== null)) {
        fail('historical source remoteMain is malformed');
    }
    if (!['sha1', 'sha256'].includes(value.source.gitObjectFormat)
        || !GIT_OID_RE.test(String(value.source.contentTreeOid || ''))
        || value.source.contentTreeOid.length !== (value.source.gitObjectFormat === 'sha1' ? 40 : 64)) {
        fail('historical source Git object/tree identity is malformed');
    }
    exact(value.source.trackedPages, ['count', 'setSha256'], 'historical source trackedPages');
    if (!Number.isSafeInteger(value.source.trackedPages.count) || value.source.trackedPages.count < 1) {
        fail('historical source tracked page count is invalid');
    }
    assertSha(value.source.trackedPages.setSha256, 'historical source tracked page set SHA');
    exact(value.source.hugoConfig, ['path', 'sha256'], 'historical Hugo config');
    if (value.source.hugoConfig.path !== 'hugo.yaml') fail('historical Hugo config path is unsupported');
    assertSha(value.source.hugoConfig.sha256, 'historical Hugo config SHA');
    exact(value.source.hugoRuntime, ['version', 'pageSetSha256', 'publishedPageSetSha256', 'pageCount',
        'publishedPageCount'], 'historical Hugo runtime');
    text(value.source.hugoRuntime.version, 'historical Hugo version', 500);
    assertSha(value.source.hugoRuntime.pageSetSha256, 'historical Hugo page-set SHA');
    assertSha(value.source.hugoRuntime.publishedPageSetSha256, 'historical Hugo published-page-set SHA');
    for (const field of ['pageCount', 'publishedPageCount']) {
        if (!Number.isSafeInteger(value.source.hugoRuntime[field]) || value.source.hugoRuntime[field] < 0) {
            fail(`historical Hugo ${field} is invalid`);
        }
    }
    exact(value.policy, Object.keys(SCAN_POLICY), 'historical scan policy');
    if (stableHash(value.policy) !== stableHash(SCAN_POLICY)) fail('historical scan policy is unsupported');
    if (!Array.isArray(value.pages) || !value.pages.length
        || !Array.isArray(value.urlCollisions) || !Array.isArray(value.outboundPostLinks) || !plain(value.counts)) {
        fail('historical ledger collections are malformed');
    }
    const pages = value.pages.map(validateHistoricalPage);
    const paths = pages.map(page => page.path);
    if (paths.some((item, index) => index && paths[index - 1] >= item)) fail('historical pages must be unique and path-sorted');
    if (assertSha(value.pageSetSha256, 'historical pageSetSha256') !== stableHash(pages)) fail('historical page set SHA drifted');
    const hugoPages = pages.map(page => ({ path: page.path, permalink: page.primaryUrl }));
    const hugoPublishedPages = hugoPages.filter((_item, index) => pages[index].published);
    if (value.source.hugoRuntime.pageCount !== pages.length
        || value.source.hugoRuntime.publishedPageCount !== hugoPublishedPages.length
        || value.source.hugoRuntime.pageSetSha256 !== stableHash(hugoPages)
        || value.source.hugoRuntime.publishedPageSetSha256 !== stableHash(hugoPublishedPages)) {
        fail('historical Hugo page proof differs from ledger pages');
    }
    const trackedPages = pages.map(page => ({ path: page.path, blobOid: page.gitBlobOid }));
    if (value.source.trackedPages.count !== trackedPages.length
        || value.source.trackedPages.setSha256 !== stableHash(trackedPages)
        || pages.some(page => page.gitBlobOid.length !== (value.source.gitObjectFormat === 'sha1' ? 40 : 64))) {
        fail('historical tracked page proof differs from ledger pages');
    }
    if (assertSha(value.outboundPostLinksSha256, 'historical outboundPostLinksSha256')
        !== stableHash(value.outboundPostLinks)) fail('historical outbound link SHA drifted');
    const claimsByUrl = new Map();
    for (const page of pages) for (const url of [page.primaryUrl, ...page.aliases]) {
        if (!claimsByUrl.has(url)) claimsByUrl.set(url, new Map());
        claimsByUrl.get(url).set(page.pageId, page);
    }
    for (const page of pages) for (const link of page.outboundPostLinks) {
        const targets = claimsByUrl.get(link.targetUrl) || new Map();
        const expectedStatus = targets.size === 1 ? 'resolved' : targets.size ? 'ambiguous' : 'unresolved';
        if (link.status !== expectedStatus) fail('historical outbound link resolution status drifted');
        if (expectedStatus === 'resolved') {
            const target = [...targets.values()][0];
            if (link.targetPath !== target.path || link.targetPageId !== target.pageId
                || link.targetRecordSha256 !== target.snapshotSha256) fail('historical outbound target binding drifted');
        } else if ([link.targetPath, link.targetPageId, link.targetRecordSha256].some(item => item !== null)) {
            fail('historical unresolved/ambiguous link claims a target page');
        }
    }
    const expectedOutbound = pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    if (stableHash(value.outboundPostLinks) !== stableHash(expectedOutbound)) fail('historical aggregate outbound links drifted');
    const claims = new Map();
    for (const page of pages) for (const url of [page.primaryUrl, ...page.aliases]) {
        if (!claims.has(url)) claims.set(url, new Set()); claims.get(url).add(page.path);
    }
    const expectedCollisions = [...claims.entries()].filter(([, items]) => items.size > 1)
        .map(([url, items]) => ({ url, paths: [...items].sort() })).sort((left, right) => left.url.localeCompare(right.url));
    if (stableHash(value.urlCollisions) !== stableHash(expectedCollisions)) fail('historical URL collision index drifted');
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
    if (stableHash(value.counts) !== stableHash(expectedCounts)) fail('historical ledger counts drifted');
    const ledgerBody = clone(value); delete ledgerBody.ledgerSha256;
    if (assertSha(value.ledgerSha256, 'historical ledgerSha256') !== stableHash(ledgerBody)) fail('historical ledger self-SHA drifted');
    return { ...clone(value), pages };
}

function validateHistoricalReceipt(value, ledger, ledgerBytes, ledgerName) {
    exact(value, ['contract', 'version', 'ledger', 'repositorySnapshotSha256', 'receiptSha256'], 'historical receipt');
    if (value.contract !== LEDGER_RECEIPT_CONTRACT || value.version !== VERSION) fail('historical receipt contract/version is unsupported');
    exact(value.ledger, ['name', 'fileSha256', 'ledgerSha256', 'pageSetSha256', 'pageCount'], 'historical receipt ledger');
    if (value.ledger.name !== ledgerName || value.ledger.fileSha256 !== sha256(ledgerBytes)
        || value.ledger.ledgerSha256 !== ledger.ledgerSha256 || value.ledger.pageSetSha256 !== ledger.pageSetSha256
        || value.ledger.pageCount !== ledger.pages.length) fail('historical receipt does not bind the exact ledger');
    for (const field of ['fileSha256', 'ledgerSha256', 'pageSetSha256']) assertSha(value.ledger[field], `receipt ledger ${field}`);
    if (assertSha(value.repositorySnapshotSha256, 'receipt repositorySnapshotSha256') !== stableHash(ledger.source)) {
        fail('historical receipt repository snapshot drifted');
    }
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'historical receiptSha256') !== stableHash(body)) fail('historical receipt self-SHA drifted');
    return clone(value);
}

function loadHistoricalInventoryHandle({ inventoryRoot, ledgerName, receiptName } = {}) {
    const ledgerFile = safeDirectJson(inventoryRoot, ledgerName);
    const receiptFile = safeDirectJson(inventoryRoot, receiptName);
    if (ledgerFile === receiptFile) fail('historical ledger and receipt files must differ');
    const ledgerLoaded = readRegular(ledgerFile, MAX_LEDGER_BYTES, 'historical page ledger');
    const ledger = validateHistoricalLedger(ledgerLoaded.value);
    if (!ledgerLoaded.bytes.equals(prettyBytes(ledger))) fail('historical page ledger bytes are not canonical');
    const receiptLoaded = readRegular(receiptFile, MAX_RECEIPT_BYTES, 'historical page receipt');
    const receipt = validateHistoricalReceipt(receiptLoaded.value, ledger, ledgerLoaded.bytes, ledgerName);
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) fail('historical page receipt bytes are not canonical');
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
        fail(`${label} is malformed`);
    }
    const candidates = value.candidates.map((candidate, index) => {
        exact(candidate, ['scheme', 'value', 'sources'], `${label}.candidates[${index}]`);
        if (!['arxiv', 'openreview-forum-id', 'icassp-arnumber'].includes(candidate.scheme)) {
            fail(`${label} candidate scheme is unsupported`);
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
        fail(`${label} candidates must be unique and sorted`);
    }
    const byScheme = new Map();
    for (const candidate of candidates) {
        const values = byScheme.get(candidate.scheme) || new Set();
        values.add(candidate.value); byScheme.set(candidate.scheme, values);
    }
    const expectedStatus = !candidates.length ? 'none'
        : [...byScheme.values()].some(values => values.size > 1) ? 'conflict'
            : candidates.length === 1 ? 'single' : 'multiple';
    if (value.status !== expectedStatus) fail(`${label}.status drifted from its candidates`);
    return { status: value.status, candidates };
}

function assignmentKey(page) { return page.pageId; }
function sourceBinding(inventory) {
    const papers = inventory.ledger.pages.filter(page => page.kind === 'paper')
        .map(page => ({ pageKey: assignmentKey(page), pagePath: page.path, pageContentSha256: page.contentSha256,
            pageRecordSha256: page.recordSha256, primaryUrl: page.primaryUrl,
            scope: clone(page.scope), cohortDate: page.cohortDate,
            identityHints: normalizeIdentityHints(page.identityHints, `identity hints for ${page.pageId}`) }));
    if (!papers.length) fail('historical inventory contains no paper pages');
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
function authorityReference(snapshot) {
    const authority = snapshot.authority;
    return { paperId: authority.paperId, identity: clone(authority.identity), identitySha256: authority.identitySha256,
        identityRecordSha256: authority.identityRecordSha256,
        authorityContract: authority.contract, authorityName: snapshot.authorityName,
        authorityFileSha256: snapshot.authorityFileSha256, authoritySha256: authority.authoritySha256,
        evidenceKind: authority.evidenceKind, fulltextSha256: snapshot.fulltextSha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256 };
}
function validateAuthorityReference(value, label = 'sourceAuthority') {
    if (value === null) return null;
    exact(value, ['paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'authorityContract', 'authorityName', 'authorityFileSha256',
        'authoritySha256', 'evidenceKind', 'fulltextSha256', 'sourceSnapshotSha256'], label);
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(`${label}.identity is invalid: ${error.message}`); }
    if (identity.citation !== null) {
        fail(`${label}.identity.citation must remain null until an authenticated official-metadata adapter exists`);
    }
    if (value.paperId !== identity.canonicalId
        || value.identitySha256 !== identityApi.identitySha256(identity)
        || value.identityRecordSha256 !== identityApi.recordSha256(identity)) {
        fail(`${label} paperId/identity/SHA binding is invalid`);
    }
    if (value.authorityContract !== authorityApi.CONTRACT || !authorityApi.isEvidenceKind(value.evidenceKind)
        || !SAFE_JSON_NAME.test(value.authorityName)) fail(`${label} contract/name/evidenceKind is invalid`);
    for (const field of ['identitySha256', 'identityRecordSha256', 'authorityFileSha256', 'authoritySha256', 'fulltextSha256',
        'sourceSnapshotSha256']) assertSha(value[field], `${label}.${field}`);
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
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    const seenPapers = new Set(); const seenPages = new Set(); let previousPaper = null;
    return value.map((group, index) => {
        exact(group, ['paperId', 'identitySha256', 'identityRecordSha256', 'pageKeys', 'groupSha256'], `${label}[${index}]`);
        text(group.paperId, `${label}[${index}].paperId`, 512);
        for (const field of ['identitySha256', 'identityRecordSha256', 'groupSha256']) {
            assertSha(group[field], `${label}[${index}].${field}`);
        }
        if (seenPapers.has(group.paperId) || (previousPaper !== null && previousPaper >= group.paperId)) {
            fail(`${label} paperId values must be unique and code-unit sorted`);
        }
        if (!Array.isArray(group.pageKeys) || !group.pageKeys.length) fail(`${label}[${index}].pageKeys must be non-empty`);
        const pageKeys = group.pageKeys.map((pageKey, pageIndex) => {
            if (!PAGE_KEY_RE.test(pageKey)) fail(`${label}[${index}].pageKeys[${pageIndex}] is malformed`);
            if (seenPages.has(pageKey)) fail(`${label} cannot contain a page more than once`);
            seenPages.add(pageKey); return pageKey;
        });
        if (pageKeys.some((pageKey, pageIndex) => pageIndex > 0 && pageKeys[pageIndex - 1] >= pageKey)) {
            fail(`${label}[${index}].pageKeys must be unique and code-unit sorted`);
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
    if (!PAGE_KEY_RE.test(pageKey)) fail('assignment page key is malformed');
    text(value.pagePath, 'assignment pagePath'); assertSha(value.pageContentSha256, 'assignment page content SHA');
    if (!ALL_STATUSES.has(value.status)) fail('assignment status is unsupported');
    if (value.status === 'pending') {
        if (value.reason !== null || value.decisionArtifactSha256 !== null || value.sourceAuthority !== null) {
            fail('pending assignment cannot carry a decision or authority');
        }
    } else {
        text(value.reason, 'assignment reason', 2000); assertSha(value.decisionArtifactSha256, 'assignment decision SHA');
        if (value.status === 'verified') validateAuthorityReference(value.sourceAuthority, `assignment ${pageKey} sourceAuthority`);
        else if (value.sourceAuthority !== null) fail('review-only assignment cannot carry source authority');
    }
    return clone(value);
}
function validateCompletion(value, assignments) {
    exact(value, ['total', 'pending', 'needsReview', 'blocked', 'conflict', 'verified', 'status', 'assignmentSetSha256'], 'completion');
    const expected = completionFor(assignments);
    if (stableHash(value) !== stableHash(expected)) fail('completion counts/status drifted');
    return clone(value);
}
function validateAttempt(value, index, assignments, priorStateSha256) {
    exact(value, ['operationId', 'decisionName', 'decisionFileSha256', 'decisionArtifactSha256', 'pageKey',
        'fromStatus', 'toStatus', 'reason', 'actorId', 'sourceAuthority', 'recordedAt',
        'priorStateSha256', 'nextStateSha256'], `attempt[${index}]`);
    if (!UUID_RE.test(value.operationId)) fail('attempt operationId must be UUID v4');
    if (!SAFE_JSON_NAME.test(value.decisionName)) fail('attempt decisionName is unsafe');
    for (const field of ['decisionFileSha256', 'decisionArtifactSha256', 'priorStateSha256', 'nextStateSha256']) {
        assertSha(value[field], `attempt ${field}`);
    }
    if (!PAGE_KEY_RE.test(value.pageKey) || !Object.hasOwn(assignments, value.pageKey)) fail('attempt pageKey is unknown');
    if (value.fromStatus !== 'pending' || ![...FINAL_REVIEW_STATUSES, 'verified'].includes(value.toStatus)) fail('attempt transition is unsupported');
    if (value.toStatus === 'verified') validateAuthorityReference(value.sourceAuthority, `attempt[${index}].sourceAuthority`);
    else if (value.sourceAuthority !== null) fail('review-only attempt cannot carry source authority');
    text(value.reason, 'attempt reason', 2000); text(value.actorId, 'attempt actorId', 120); timestamp(value.recordedAt, 'attempt recordedAt');
    if (value.priorStateSha256 !== priorStateSha256) fail('attempt SHA history is discontinuous');
    return clone(value);
}
function assertCrosswalkState(value) {
    exact(value, ['contract', 'version', 'crosswalkId', 'createdAt', 'source', 'assignments', 'attempts',
        'completion', 'identityGroups', 'identityGroupsSha256', 'stateSha256'], 'crosswalk state');
    if (value.contract !== CONTRACT || value.version !== VERSION || !UUID_RE.test(value.crosswalkId)) fail('crosswalk contract/version/UUID mismatch');
    timestamp(value.createdAt, 'createdAt');
    exact(value.source, ['ledgerName', 'ledgerFileSha256', 'ledgerSha256', 'receiptName', 'receiptFileSha256',
        'receiptSha256', 'repositorySnapshotSha256', 'pageSetSha256', 'paperPageSetSha256', 'papers'], 'crosswalk source');
    for (const field of ['ledgerFileSha256', 'ledgerSha256', 'receiptFileSha256', 'receiptSha256',
        'repositorySnapshotSha256', 'pageSetSha256', 'paperPageSetSha256']) assertSha(value.source[field], `source ${field}`);
    for (const field of ['ledgerName', 'receiptName']) if (!SAFE_JSON_NAME.test(value.source[field])) fail(`source ${field} is unsafe`);
    if (!Array.isArray(value.source.papers) || !value.source.papers.length) fail('source papers must be non-empty');
    const papers = value.source.papers.map(item => {
        exact(item, ['pageKey', 'pagePath', 'pageContentSha256', 'pageRecordSha256', 'primaryUrl', 'scope',
            'cohortDate', 'identityHints'], 'source paper');
        if (!PAGE_KEY_RE.test(item.pageKey)) fail('source paper pageId is malformed');
        text(item.pagePath, 'source paper path'); text(item.primaryUrl, 'source paper primary URL');
        assertSha(item.pageContentSha256, 'source paper content SHA');
        assertSha(item.pageRecordSha256, 'source paper record SHA');
        exact(item.scope, ['type', 'key'], 'source paper scope');
        normalizeIdentityHints(item.identityHints, `source paper ${item.pageKey} identityHints`);
        if (typeof item.cohortDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.cohortDate)) {
            fail('source paper cohortDate is invalid');
        }
        return clone(item);
    });
    if (stableHash(papers) !== value.source.paperPageSetSha256) fail('source paper set SHA drifted');
    if (!plain(value.assignments) || Object.keys(value.assignments).length !== papers.length) fail('assignments must exactly cover source papers');
    const assignments = Object.fromEntries(Object.keys(value.assignments).sort().map(key => [key, validateAssignment(value.assignments[key], key)]));
    for (const paper of papers) {
        const assignment = assignments[paper.pageKey];
        if (!assignment || assignment.pagePath !== paper.pagePath || assignment.pageContentSha256 !== paper.pageContentSha256) {
            fail('assignment differs from source paper snapshot');
        }
    }
    if (!Array.isArray(value.identityGroups)) fail('identityGroups must be an array');
    if (!Array.isArray(value.attempts)) fail('attempts must be an array');
    const replayed = Object.fromEntries(papers.map(paper => [paper.pageKey, initialAssignment(paper)]));
    const operations = new Set(); let previousTime = value.createdAt; let expectedPrior = stateDigest({ contract: CONTRACT, version: VERSION,
        crosswalkId: value.crosswalkId, createdAt: value.createdAt, source: clone(value.source), assignments: clone(replayed),
        attempts: [], completion: completionFor(replayed), identityGroups: [], identityGroupsSha256: stableHash([]) });
    const attempts = [];
    for (const [index, raw] of value.attempts.entries()) {
        const attempt = validateAttempt(raw, index, replayed, expectedPrior);
        if (operations.has(attempt.operationId)) fail('attempt operationId is duplicated');
        if (attempt.recordedAt < previousTime) fail('attempt time moves backwards');
        if (replayed[attempt.pageKey].status !== 'pending') fail('attempt repeats a terminal page assignment');
        replayed[attempt.pageKey] = { ...replayed[attempt.pageKey], status: attempt.toStatus, reason: attempt.reason,
            decisionArtifactSha256: attempt.decisionArtifactSha256, sourceAuthority: clone(attempt.sourceAuthority) };
        const prefix = { contract: CONTRACT, version: VERSION, crosswalkId: value.crosswalkId, createdAt: value.createdAt,
            source: clone(value.source), assignments: clone(replayed), attempts: [...attempts, attempt],
            completion: completionFor(replayed), identityGroups: identityGroupsFor(replayed),
            identityGroupsSha256: stableHash(identityGroupsFor(replayed)) };
        const digest = stateDigest(prefix);
        if (attempt.nextStateSha256 !== digest) fail('attempt nextStateSha256 does not bind replayed state');
        expectedPrior = digest; previousTime = attempt.recordedAt; operations.add(attempt.operationId); attempts.push(attempt);
    }
    if (stableHash(replayed) !== stableHash(assignments)) fail('assignments do not match append-only attempt history');
    const completion = validateCompletion(value.completion, assignments);
    const identityGroups = identityGroupsFor(assignments);
    normalizeIdentityGroups(identityGroups);
    if (stableHash(value.identityGroups) !== stableHash(identityGroups)
        || assertSha(value.identityGroupsSha256, 'identityGroupsSha256') !== stableHash(identityGroups)) {
        fail('identityGroups drifted from verified assignments');
    }
    const rebuilt = { contract: CONTRACT, version: VERSION, crosswalkId: value.crosswalkId, createdAt: value.createdAt,
        source: clone(value.source), assignments, attempts, completion, identityGroups,
        identityGroupsSha256: stableHash(identityGroups) };
    const digest = stateDigest(rebuilt);
    if (assertSha(value.stateSha256, 'stateSha256') !== digest) fail('crosswalk state SHA drifted');
    if (attempts.length && attempts.at(-1).nextStateSha256 !== digest) fail('last attempt does not bind current state');
    return { ...rebuilt, stateSha256: digest };
}

function buildInitialState(inventoryHandle, { crosswalkId = crypto.randomUUID(), now } = {}) {
    const inventory = inventoryHandleSnapshot(inventoryHandle);
    if (!UUID_RE.test(crosswalkId)) fail('crosswalkId must be canonical UUID v4');
    const source = sourceBinding(inventory);
    const assignments = Object.fromEntries(source.papers.map(paper => [paper.pageKey, initialAssignment(paper)]));
    const body = { contract: CONTRACT, version: VERSION, crosswalkId, createdAt: nowIso(now), source,
        assignments, attempts: [], completion: completionFor(assignments), identityGroups: [], identityGroupsSha256: stableHash([]) };
    return assertCrosswalkState({ ...body, stateSha256: stateDigest(body) });
}

function crosswalkDirectory(root, crosswalkId, { create = false } = {}) {
    const safeRoot = safeDirectory(root, { create });
    if (!UUID_RE.test(crosswalkId)) fail('crosswalkId must be canonical UUID v4');
    const directory = path.resolve(safeRoot, crosswalkId);
    if (path.dirname(directory) !== safeRoot) fail('crosswalk directory escapes root');
    if (create) {
        try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!fs.existsSync(directory)) fail('crosswalk directory does not exist');
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
        fail('prepare test hooks are malformed');
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
    if (hasFinalReceipt && (!hasState || !hasDecisions)) fail('finalized crosswalk lacks its state or decision evidence directory');
    if (hasDecisions) {
        const decisions = safeDirectory(path.join(directory, 'decisions'));
        if (!hasState && fs.readdirSync(decisions).length) {
            fail('crosswalk prepare decisions directory is nonempty without a state');
        }
    }
    if (!hasState) return { hasDecisions, state: null, complete: false };
    const loaded = readRegular(path.join(directory, 'state.json'), MAX_STATE_BYTES, 'crosswalk prepare state');
    const existing = assertCrosswalkState(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(existing))) fail('crosswalk prepare state bytes are not canonical');
    if (existing.crosswalkId !== expectedState.crosswalkId
        || stableHash(existing.source) !== stableHash(expectedState.source)) {
        fail('existing crosswalkId belongs to another inventory');
    }
    if (!hasDecisions && existing.attempts.length) {
        fail('crosswalk prepare state has attempts but no decision evidence directory');
    }
    if (hasFinalReceipt) {
        if (existing.completion.status !== 'complete') fail('final receipt cannot accompany an incomplete crosswalk');
        const loadedReceipt = readRegular(path.join(directory, 'final-receipt.json'), MAX_RECEIPT_BYTES,
            'crosswalk prepare final receipt');
        const receipt = normalizeFinalReceipt(loadedReceipt.value);
        if (!loadedReceipt.bytes.equals(prettyBytes(receipt))
            || stableHash(receipt) !== stableHash(finalReceiptFor(existing))) {
            fail('crosswalk prepare final receipt does not bind the existing state');
        }
    }
    return { hasDecisions, state: existing, complete: hasDecisions };
}
function rollbackPreparedPath(filename, expectedBytes) {
    try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const loaded = readRegular(filename, MAX_STATE_BYTES, 'crosswalk rollback state');
    if (!loaded.bytes.equals(expectedBytes)) fail('crosswalk rollback refused to remove changed state evidence');
    fs.unlinkSync(filename);
}
function removeEmptyPrepareDirectory(directory, label) {
    let info;
    try { info = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || fs.readdirSync(directory).length) fail(`${label} changed while rolling back`);
    fs.rmdirSync(directory);
}
function prepareCrosswalk({ crosswalkRoot, inventoryHandle, crosswalkId, now, apply = false, testHooks } = {}) {
    if (typeof apply !== 'boolean') fail('apply must be boolean');
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
        if (!current.complete) fail('crosswalk prepare did not produce a complete recoverable directory');
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
    if (!loaded.bytes.equals(prettyBytes(state))) fail('crosswalk state bytes are not canonical');
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
        || !UUID_RE.test(value.operationId)) fail('decision contract/version/UUID is invalid');
    assertSha(value.expectedStateSha256, 'decision expectedStateSha256');
    if (!PAGE_KEY_RE.test(value.pageKey)) fail('decision page key is malformed');
    text(value.pagePath, 'decision pagePath'); assertSha(value.pageContentSha256, 'decision page content SHA');
    text(value.actorId, 'decision actorId', 120); timestamp(value.createdAt, 'decision createdAt');
    exact(value.result, ['status', 'reason'], 'decision result');
    if (![...FINAL_REVIEW_STATUSES, 'verified'].includes(value.result.status)) fail('decision status is unsupported');
    if (value.result.status === 'verified') validateAuthorityReference(value.sourceAuthority, 'decision sourceAuthority');
    else if (value.sourceAuthority !== null) fail('review-only decision cannot carry source authority');
    text(value.result.reason, 'decision reason', 2000);
    if (assertSha(value.artifactSha256, 'decision artifactSha256') !== decisionDigest(value)) fail('decision artifact self-SHA drifted');
    return clone(value);
}
function buildDecisionArtifact({ state, pageKey, operationId = crypto.randomUUID(), actorId, status, reason, now } = {}) {
    if (status === 'verified') fail('verified decision requires an authenticated paper source authority handle');
    const checked = assertCrosswalkState(state);
    if (!Object.hasOwn(checked.assignments, pageKey)) fail('decision pageKey is absent from crosswalk');
    const assignment = checked.assignments[pageKey];
    const body = { contract: DECISION_CONTRACT, version: VERSION, crosswalkId: checked.crosswalkId,
        operationId, expectedStateSha256: checked.stateSha256, pageKey, pagePath: assignment.pagePath,
        pageContentSha256: assignment.pageContentSha256, actorId, result: { status, reason },
        sourceAuthority: null, createdAt: nowIso(now) };
    return normalizeDecisionArtifact({ ...body, artifactSha256: stableHash(body) });
}
function buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle, operationId = crypto.randomUUID(),
    actorId, reason = 'Authenticated paper source authority exactly matches an explicit page identity hint.', now } = {}) {
    const checked = assertCrosswalkState(state);
    if (!Object.hasOwn(checked.assignments, pageKey)) fail('verified decision pageKey is absent from crosswalk');
    let snapshot;
    try { snapshot = authorityApi.authorityHandleSnapshot(authorityHandle); }
    catch (error) { fail(`verified decision requires authenticated source authority: ${error.message}`); }
    if (snapshot.productionAuthorized !== true) {
        fail('verified decision requires a production-authorized paper source authority');
    }
    const identity = snapshot.authority.identity;
    const expectedHint = identity.kind === 'arxiv'
        ? { scheme: 'arxiv', value: identity.arxivId }
        : { scheme: identity.externalId.scheme, value: identity.externalId.value };
    const paper = checked.source.papers.find(item => item.pageKey === pageKey);
    if (paper.identityHints.status !== 'single') {
        fail('verified authority requires a single unambiguous page identity hint; conflict/multiple requires separate resolution authority');
    }
    const matches = paper.identityHints.candidates.filter(candidate => candidate.scheme === expectedHint.scheme
        && candidate.value === expectedHint.value
        && candidate.sources.every(source => !/(?:^|:)title(?:$|:)/i.test(source)));
    if (matches.length !== 1) fail('verified authority must match one explicit non-title page identity hint');
    const assignment = checked.assignments[pageKey]; const sourceAuthority = authorityReference(snapshot);
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
    if (normalized.crosswalkId !== crosswalkId) fail('decision belongs to another crosswalk');
    try { writeExclusive(filename, prettyBytes(normalized)); }
    catch (error) { if (error instanceof PageSourceCrosswalkError) throw error; fail(`could not preserve decision: ${error.message}`); }
    return filename;
}
function loadDecisionHandle(filename, { authorityHandle = null } = {}) {
    const loaded = readRegular(filename, MAX_DECISION_BYTES, 'crosswalk decision');
    const artifact = normalizeDecisionArtifact(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(artifact))) fail('decision artifact bytes are not canonical');
    let authorityAuthenticated = false;
    if (artifact.result.status === 'verified') {
        let snapshot;
        try { snapshot = authorityApi.authorityHandleSnapshot(authorityHandle); }
        catch (error) { fail(`verified decision requires authenticated source authority: ${error.message}`); }
        if (stableHash(artifact.sourceAuthority) !== stableHash(authorityReference(snapshot))) {
            fail('verified decision authority differs from authenticated authority handle');
        }
        if (snapshot.productionAuthorized !== true) {
            fail('verified decision authority is not production-authorized');
        }
        authorityAuthenticated = true;
    } else if (authorityHandle !== null) fail('review-only decision must not receive source authority');
    const handle = Object.freeze(Object.create(null)); DECISION_HANDLES.add(handle);
    DECISION_HANDLE_DATA.set(handle, Object.freeze({ artifact, filename: fs.realpathSync(filename),
        fileSha256: loaded.sha256, fileDev: loaded.dev, fileIno: loaded.ino,
        authorityAuthenticated, authorityHandle }));
    return handle;
}
function decisionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !DECISION_HANDLES.has(handle)) fail('authenticated decision handle required');
    const { authorityHandle: _authorityHandle, ...snapshot } = DECISION_HANDLE_DATA.get(handle);
    return clone(snapshot);
}
function lockOwnerRecord(owner, now, token = crypto.randomUUID()) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) fail('owner is malformed');
    if (!UUID_RE.test(token)) fail('lock owner token must be a canonical UUID v4');
    const startedAt = nowIso(now);
    const body = { contract: LOCK_OWNER_CONTRACT, version: VERSION, owner, pid: process.pid,
        hostname: os.hostname(), token, startedAt, heartbeatAt: startedAt, leaseMs: LOCK_STALE_MS };
    return { ...body, ownerSha256: stableHash(body) };
}
function validateLockOwner(value) {
    exact(value, ['contract', 'version', 'owner', 'pid', 'hostname', 'token', 'startedAt', 'heartbeatAt',
        'leaseMs', 'ownerSha256'], 'crosswalk lock owner');
    if (value.contract !== LOCK_OWNER_CONTRACT || value.version !== VERSION) fail('crosswalk lock owner contract/version mismatch');
    if (!OWNER_RE.test(value.owner)) fail('crosswalk lock owner is malformed');
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) fail('crosswalk lock owner PID is malformed');
    text(value.hostname, 'crosswalk lock hostname', 255);
    if (!UUID_RE.test(value.token)) fail('crosswalk lock token is malformed');
    timestamp(value.startedAt, 'crosswalk lock startedAt'); timestamp(value.heartbeatAt, 'crosswalk lock heartbeatAt');
    if (value.heartbeatAt < value.startedAt) fail('crosswalk lock heartbeat precedes start');
    if (value.leaseMs !== LOCK_STALE_MS) fail('crosswalk lock lease differs from the supported policy');
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
    if (!loaded.bytes.equals(prettyBytes(record))) fail(`${label} owner bytes are not canonical`);
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
function reclaimableLock(snapshot, currentTime = Date.now()) {
    if (processLiveness(snapshot.record) !== 'dead') return false;
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
    if (!sameLockSnapshot(snapshot, current)) fail(`${label} changed before removal`);
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
function clearOrRejectReclaimMarker(reclaimPath) {
    let snapshot;
    try { snapshot = readLockDirectory(reclaimPath, 'crosswalk lock reclaim marker'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const liveness = processLiveness(snapshot.record);
    if (liveness === 'alive') fail('crosswalk lock reclaim is owned by a live process');
    if (liveness === 'remote') fail('crosswalk lock reclaim belongs to another host');
    if (!reclaimableLock(snapshot)) fail('crosswalk lock reclaim marker is not stale');
    removeVerifiedLockDirectory(snapshot, 'crosswalk lock reclaim marker');
}
function acquireLock(directory, owner, now) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) fail('owner is malformed');
    const lockPath = path.join(directory, 'operation.lock');
    const reclaimPath = path.join(directory, 'operation.lock.reclaim');
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try { fs.lstatSync(reclaimPath); clearOrRejectReclaimMarker(reclaimPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
            const snapshot = createLockDirectory(lockPath, owner, now);
            const handle = Object.freeze(Object.create(null)); LOCK_HANDLES.add(handle);
            LOCK_HANDLE_DATA.set(handle, Object.freeze({ lockPath, token: snapshot.record.token,
                ownerSha256: snapshot.record.ownerSha256 }));
            return handle;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const stale = readLockDirectory(lockPath);
        const liveness = processLiveness(stale.record);
        if (liveness === 'alive') fail('crosswalk is locked by a live process');
        if (liveness === 'remote') fail('crosswalk lock belongs to another host and cannot be reclaimed');
        if (!reclaimableLock(stale)) fail('crosswalk lock belongs to a dead process but is not stale');
        let reclaim;
        try { reclaim = createLockDirectory(reclaimPath, owner, now); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try {
            let current;
            try { current = readLockDirectory(lockPath); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!sameLockSnapshot(stale, current)) fail('crosswalk operation lock changed during stale reclaim');
            if (!reclaimableLock(current)) fail('crosswalk operation lock ceased to be safely reclaimable');
            removeVerifiedLockDirectory(current, 'crosswalk operation lock');
        } finally {
            removeVerifiedLockDirectory(reclaim, 'crosswalk lock reclaim marker');
        }
    }
    fail('crosswalk lock acquisition exceeded the bounded reclaim attempts');
}
function releaseLock(handle) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) fail('authenticated crosswalk lock handle required');
    const expected = LOCK_HANDLE_DATA.get(handle); const snapshot = readLockDirectory(expected.lockPath);
    if (snapshot.record.token !== expected.token || snapshot.record.ownerSha256 !== expected.ownerSha256) {
        fail('crosswalk operation lock changed while held');
    }
    removeVerifiedLockDirectory(snapshot, 'crosswalk operation lock');
    LOCK_HANDLES.delete(handle); LOCK_HANDLE_DATA.delete(handle);
}
function applyDecision({ crosswalkRoot, crosswalkId, decisionHandle, owner, now } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    if (!decisionHandle || typeof decisionHandle !== 'object' || !DECISION_HANDLES.has(decisionHandle)) {
        fail('authenticated decision handle required');
    }
    const originalDecision = DECISION_HANDLE_DATA.get(decisionHandle);
    const decision = decisionHandleSnapshot(decisionHandle);
    const expectedDirectory = fs.realpathSync(path.join(directory, 'decisions'));
    if (path.dirname(decision.filename) !== expectedDirectory) fail('decision handle is outside this crosswalk decision directory');
    const lock = acquireLock(directory, owner, now);
    try {
        let replayedAuthorityHandle = null;
        if (originalDecision.authorityAuthenticated) {
            try {
                replayedAuthorityHandle = authorityApi.replayAuthorityHandle(originalDecision.authorityHandle,
                    { requireProduction: true });
            } catch (error) {
                fail(`verified decision authority replay failed while locked: ${error.message}`);
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
            fail('verified decision handle lacks authenticated source authority');
        }
        if (artifact.crosswalkId !== crosswalkId) fail('decision belongs to another crosswalk');
        const prior = state.attempts.find(item => item.operationId === artifact.operationId);
        if (prior) {
            if (prior.decisionFileSha256 !== decision.fileSha256 || prior.decisionArtifactSha256 !== artifact.artifactSha256) {
                fail('operationId was already used by different decision evidence');
            }
            return state;
        }
        if (artifact.expectedStateSha256 !== state.stateSha256) fail('decision compare-and-swap state SHA mismatch');
        const current = state.assignments[artifact.pageKey];
        if (!current || current.pagePath !== artifact.pagePath || current.pageContentSha256 !== artifact.pageContentSha256) {
            fail('decision page snapshot differs from crosswalk assignment');
        }
        if (current.status !== 'pending') fail('only pending assignments may receive current review decisions');
        const recordedAt = nowIso(now);
        if (artifact.createdAt > recordedAt) fail('decision artifact cannot be recorded before it was created');
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
        fail('crosswalk final receipt contract/version/UUID is invalid');
    }
    for (const field of ['stateSha256', 'stateFileSha256', 'ledgerSha256', 'ledgerFileSha256',
        'historicalReceiptSha256', 'verifiedAssignmentSetSha256', 'identityGroupsSha256']) {
        assertSha(value[field], `crosswalk final receipt ${field}`);
    }
    if (!Number.isSafeInteger(value.verified) || !Number.isSafeInteger(value.total)
        || value.verified < 1 || value.verified !== value.total) fail('crosswalk final receipt counts are invalid');
    const identityGroups = normalizeIdentityGroups(value.identityGroups, 'crosswalk final receipt identityGroups');
    if (stableHash(identityGroups) !== value.identityGroupsSha256
        || identityGroups.reduce((count, group) => count + group.pageKeys.length, 0) !== value.total) {
        fail('crosswalk final receipt identity groups drifted');
    }
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'crosswalk final receipt receiptSha256') !== stableHash(body)) {
        fail('crosswalk final receipt self-SHA drifted');
    }
    return { ...clone(value), identityGroups };
}
function replaySourceAuthorities(state, authorityRoot, authorityResolver) {
    for (const assignment of Object.values(state.assignments)) {
        const reference = validateAuthorityReference(assignment.sourceAuthority);
        let handle;
        try {
            handle = authorityResolver
                ? authorityResolver(clone(reference))
                : authorityApi.loadAuthorityHandle({ authorityRoot, authorityName: reference.authorityName });
            const replayed = authorityApi.replayAuthorityHandle(handle, { requireProduction: true });
            const snapshot = authorityApi.authorityHandleSnapshot(replayed);
            if (stableHash(reference) !== stableHash(authorityReference(snapshot))) {
                fail('finalize source authority differs from verified assignment');
            }
        } catch (error) {
            if (error instanceof PageSourceCrosswalkError) throw error;
            fail(`finalize could not replay source authority: ${error.message}`);
        }
    }
}
function readFinalReceipt({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver = null } = {}) {
    const state = readCrosswalk({ crosswalkRoot, crosswalkId });
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const receiptFile = safeDirectJson(directory, 'final-receipt.json');
    const loaded = readRegular(receiptFile, MAX_RECEIPT_BYTES, 'crosswalk final receipt');
    const receipt = normalizeFinalReceipt(loaded.value); const expected = finalReceiptFor(state);
    if (!loaded.bytes.equals(prettyBytes(receipt)) || stableHash(receipt) !== stableHash(expected)) {
        fail('crosswalk final receipt does not bind the current complete state');
    }
    replaySourceAuthorities(state, authorityRoot, authorityResolver);
    return { state, receipt, receiptFile, receiptFileSha256: loaded.sha256 };
}
function finalizeCrosswalk({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver = null, now } = {}) {
    const directory = crosswalkDirectory(crosswalkRoot, crosswalkId);
    const lock = acquireLock(directory, 'crosswalk.finalize', now);
    try {
        const state = readCrosswalk({ crosswalkRoot, crosswalkId });
        if (state.completion.status !== 'complete' || state.completion.verified !== state.completion.total) {
            fail('finalize requires every paper to have authenticated verified source authority');
        }
        replaySourceAuthorities(state, authorityRoot, authorityResolver);
        const receipt = finalReceiptFor(state);
        const receiptFile = safeDirectJson(directory, 'final-receipt.json', { mustExist: false });
        try { writeExclusive(receiptFile, prettyBytes(receipt)); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const current = readCrosswalk({ crosswalkRoot, crosswalkId });
        if (current.stateSha256 !== state.stateSha256) fail('crosswalk state changed while finalizing');
        replaySourceAuthorities(current, authorityRoot, authorityResolver);
        return readFinalReceipt({ crosswalkRoot, crosswalkId, authorityRoot, authorityResolver });
    } finally {
        releaseLock(lock);
    }
}

module.exports = {
    LEDGER_CONTRACT, LEDGER_RECEIPT_CONTRACT, CONTRACT, DECISION_CONTRACT, LOCK_OWNER_CONTRACT,
    FINAL_RECEIPT_CONTRACT,
    VERSION, UUID_RE, SAFE_JSON_NAME, LOCK_STALE_MS,
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
