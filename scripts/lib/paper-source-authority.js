'use strict';

// 把一张历史页面归到唯一论文身份上，只依据来源文件，且结果可长期复算。加载时
// 总是重新读取指定的来源文件；调用方拿到的只是进程内句柄，看不到内部结构。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const identityApi = require('./paper-identity.js');
const conferenceContextApi = require('./conference-source-context.js');

const CONTRACT = 'paper-source-authority-v1';
const VERSION = 1;
const ARXIV_SNAPSHOT_CONTRACT = 'arxiv-paper-source-snapshot-v1';
const ARXIV_RECEIPT_CONTRACT = 'arxiv-paper-source-receipt-v1';
const ARXIV_PRODUCTION_SNAPSHOT_CONTRACT = 'arxiv-paper-source-production-snapshot-v1';
const ARXIV_PRODUCTION_RECEIPT_CONTRACT = 'arxiv-paper-source-production-receipt-v1';
const ARXIV_REQUEST_CONTRACT = 'arxiv-paper-source-request-v1';
const ARXIV_OBSERVATION_CONTRACT = 'arxiv-paper-source-observation-v1';
const ARXIV_FETCHER_CONTRACT = 'deep-analyzer-official-arxiv-fulltext-v1';
const EVIDENCE_KINDS = Object.freeze(['arxiv-official-fulltext', 'conference-plan-source-context']);
const EVIDENCE_KIND_SET = new Set(EVIDENCE_KINDS);
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SAFE_TEXT_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.(?:txt|md)$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MIN_FULLTEXT_CHARACTERS = 1000;
const AUTHORITY_HANDLES = new WeakSet();
const AUTHORITY_HANDLE_DATA = new WeakMap();

class PaperSourceAuthorityError extends Error {
    constructor(message) {
        super(`Paper source authority rejected: ${message}`);
        this.name = 'PaperSourceAuthorityError';
        this.code = 'PAPER_SOURCE_AUTHORITY_INTEGRITY';
    }
}

function fail(message) { throw new PaperSourceAuthorityError(message); }
const clone = value => JSON.parse(JSON.stringify(value));
function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是纯对象`);
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
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
const isEvidenceKind = value => EVIDENCE_KIND_SET.has(value);
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`); return value; }
function safeName(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} 必须是安全的直接文件名`);
    return value;
}
function safeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('authorityRoot 必须是配置好的绝对目录');
    const absolute = path.resolve(root); const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail('authorityRoot is unsafe');
    return absolute;
}
function safeDirect(root, name, pattern, label) {
    safeName(name, pattern, label); const filename = path.resolve(root, name);
    if (path.dirname(filename) !== root) fail(`${label} 逃出了 authorityRoot`);
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${label} must be a regular single-link file`);
    return filename;
}
function readJson(root, name, label) {
    const filename = safeDirect(root, name, SAFE_JSON_NAME, label); const before = fs.lstatSync(filename);
    const loaded = ledgerApi.readRegularJson(filename);
    if (!loaded || !plain(loaded.value)) fail(`${label} 必须包含 JSON 对象`);
    const bytes = fs.readFileSync(filename); const after = fs.lstatSync(filename);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || bytes.length > MAX_JSON_BYTES || loaded.sha256 !== sha256(bytes)) {
        fail(`${label} 超出上限，或在读取期间发生变化`);
    }
    if (!bytes.equals(prettyBytes(loaded.value))) fail(`${label} bytes must be canonical pretty JSON`);
    return { filename: fs.realpathSync(filename), value: loaded.value, bytes, sha256: loaded.sha256,
        dev: after.dev, ino: after.ino };
}
function readText(root, name, label) {
    const filename = safeDirect(root, name, SAFE_TEXT_NAME, label); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_TEXT_BYTES) {
            fail(`${label} changed or is unsafe`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} 在读取期间发生变化`);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail(`${label} 必须是严格 UTF-8`); }
        let count = 0; for (const character of text) if (!/\s/u.test(character)) count += 1;
        if (count < MIN_FULLTEXT_CHARACTERS) fail(`${label} 短于全文门槛`);
        return { filename: fs.realpathSync(filename), bytes, text, sha256: sha256(bytes),
            dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function selfBound(value, field, label) {
    const body = clone(value); delete body[field];
    if (sha(value[field], `${label}.${field}`) !== stableHash(body)) fail(`${label} self-SHA drifted`);
    return clone(value);
}

function normalizeArxivSnapshot(value) {
    exact(value, ['contract', 'version', 'paperId', 'arxivId', 'officialUrl', 'fulltextSha256', 'snapshotSha256'], 'arXiv snapshot');
    if (value.contract !== ARXIV_SNAPSHOT_CONTRACT || value.version !== VERSION
        || value.paperId !== `arxiv:${value.arxivId}`
        || value.officialUrl !== `https://arxiv.org/abs/${value.arxivId}`) fail('arXiv 快照的身份或来源无效');
    sha(value.fulltextSha256, 'arXiv snapshot fulltextSha256');
    return selfBound(value, 'snapshotSha256', 'arXiv snapshot');
}
function normalizeArxivReceipt(value) {
    exact(value, ['contract', 'version', 'snapshotName', 'snapshotFileSha256', 'snapshotSha256',
        'fulltextName', 'fulltextSha256', 'receiptSha256'], 'arXiv receipt');
    if (value.contract !== ARXIV_RECEIPT_CONTRACT || value.version !== VERSION) fail('arXiv 回执的契约或版本无效');
    safeName(value.snapshotName, SAFE_JSON_NAME, 'arXiv receipt snapshotName');
    safeName(value.fulltextName, SAFE_TEXT_NAME, 'arXiv receipt fulltextName');
    for (const field of ['snapshotFileSha256', 'snapshotSha256', 'fulltextSha256']) sha(value[field], `arXiv receipt ${field}`);
    return selfBound(value, 'receiptSha256', 'arXiv receipt');
}
function normalizeProof(value, evidenceKind) {
    if (evidenceKind === 'arxiv-official-fulltext') {
        const legacy = Object.keys(value || {}).length === 8;
        exact(value, legacy
            ? ['snapshotName', 'snapshotFileSha256', 'snapshotSha256', 'receiptName', 'receiptFileSha256',
                'receiptSha256', 'fulltextName', 'fulltextSha256']
            : ['requestName', 'requestFileSha256', 'requestSha256', 'observationName', 'observationFileSha256',
                'observationSha256', 'snapshotName', 'snapshotFileSha256', 'snapshotSha256', 'receiptName',
                'receiptFileSha256', 'receiptSha256', 'fulltextName', 'fulltextSha256'], 'arXiv authority proof');
        safeName(value.snapshotName, SAFE_JSON_NAME, 'proof.snapshotName');
        safeName(value.receiptName, SAFE_JSON_NAME, 'proof.receiptName');
        safeName(value.fulltextName, SAFE_TEXT_NAME, 'proof.fulltextName');
        if (!legacy) {
            safeName(value.requestName, SAFE_JSON_NAME, 'proof.requestName');
            safeName(value.observationName, SAFE_JSON_NAME, 'proof.observationName');
        }
    } else {
        exact(value, ['sourceContextName', 'sourceContextFileSha256', 'sourceContextSha256', 'sourceSnapshotSha256',
            'observationBindingSha256', 'planAuthorityBindingSha256', 'fulltextSha256'], 'conference authority proof');
        safeName(value.sourceContextName, SAFE_JSON_NAME, 'proof.sourceContextName');
    }
    for (const [field, item] of Object.entries(value)) if (field.toLowerCase().includes('sha256')) sha(item, `proof.${field}`);
    return clone(value);
}
function normalizeProductionArxivRequest(value) {
    exact(value, ['contract', 'version', 'operationId', 'paperId', 'arxivId', 'identitySha256', 'authorityName',
        'officialAbsUrl', 'officialHtmlUrl', 'officialPdfUrl', 'fetcherContract', 'requestedAt', 'requestSha256'], 'arXiv production request');
    if (value.contract !== ARXIV_REQUEST_CONTRACT || value.version !== VERSION
        || value.paperId !== `arxiv:${value.arxivId}` || value.officialAbsUrl !== `https://arxiv.org/abs/${value.arxivId}`
        || value.officialHtmlUrl !== `https://arxiv.org/html/${value.arxivId}`
        || value.officialPdfUrl !== `https://arxiv.org/pdf/${value.arxivId}.pdf`
        || value.fetcherContract !== ARXIV_FETCHER_CONTRACT || !identityApi.ARXIV_ID_RE.test(value.arxivId)) {
        fail('arXiv 生产请求的身份、来源或抓取器无效');
    }
    safeName(value.authorityName, SAFE_JSON_NAME, 'arXiv production request authorityName');
    sha(value.identitySha256, 'arXiv production request identitySha256');
    return selfBound(value, 'requestSha256', 'arXiv production request');
}
function normalizeProductionArxivObservation(value) {
    exact(value, ['contract', 'version', 'paperId', 'arxivId', 'sourceKind', 'sourceId', 'sourceUrl',
        'htmlAvailability', 'htmlAttempts', 'warnings', 'structuredArtifacts', 'fetchedAt', 'observationSha256'], 'arXiv production observation');
    if (value.contract !== ARXIV_OBSERVATION_CONTRACT || value.version !== VERSION
        || value.paperId !== `arxiv:${value.arxivId}` || !identityApi.ARXIV_ID_RE.test(value.arxivId)
        || !['html', 'pdf'].includes(value.sourceKind) || String(value.sourceId || '').replace(/v\d+$/i, '') !== value.arxivId
        || value.sourceUrl !== (value.sourceKind === 'html' ? `https://arxiv.org/html/${value.sourceId}` : `https://arxiv.org/pdf/${value.sourceId}.pdf`)
        || !Number.isSafeInteger(value.htmlAttempts) || value.htmlAttempts < 0 || !Array.isArray(value.warnings)
        || !plain(value.structuredArtifacts) || !Array.isArray(value.structuredArtifacts.tables)
        || !Array.isArray(value.structuredArtifacts.formulas)) fail('arXiv 生产观测无效');
    return selfBound(value, 'observationSha256', 'arXiv production observation');
}
function normalizeProductionArxivSnapshot(value) {
    exact(value, ['contract', 'version', 'paperId', 'arxivId', 'officialUrl', 'requestName', 'requestFileSha256',
        'requestSha256', 'observationName', 'observationFileSha256', 'observationSha256', 'fulltextName',
        'fulltextSha256', 'snapshotSha256'], 'arXiv production snapshot');
    if (value.contract !== ARXIV_PRODUCTION_SNAPSHOT_CONTRACT || value.version !== VERSION
        || value.paperId !== `arxiv:${value.arxivId}` || value.officialUrl !== `https://arxiv.org/abs/${value.arxivId}`) {
        fail('arXiv 生产快照的身份或来源无效');
    }
    for (const field of ['requestName', 'observationName']) safeName(value[field], SAFE_JSON_NAME, `arXiv production snapshot ${field}`);
    safeName(value.fulltextName, SAFE_TEXT_NAME, 'arXiv production snapshot fulltextName');
    for (const field of ['requestFileSha256', 'requestSha256', 'observationFileSha256', 'observationSha256', 'fulltextSha256']) sha(value[field], `arXiv production snapshot ${field}`);
    return selfBound(value, 'snapshotSha256', 'arXiv production snapshot');
}
function normalizeProductionArxivReceipt(value) {
    exact(value, ['contract', 'version', 'operationId', 'requestName', 'requestFileSha256', 'requestSha256',
        'snapshotName', 'snapshotFileSha256', 'snapshotSha256', 'observationName', 'observationFileSha256',
        'observationSha256', 'fulltextName', 'fulltextSha256', 'fetcherContract', 'receiptSha256'], 'arXiv production receipt');
    if (value.contract !== ARXIV_PRODUCTION_RECEIPT_CONTRACT || value.version !== VERSION
        || value.fetcherContract !== ARXIV_FETCHER_CONTRACT) fail('arXiv 生产回执的契约、版本或抓取器无效');
    for (const field of ['requestName', 'snapshotName', 'observationName']) safeName(value[field], SAFE_JSON_NAME, `arXiv production receipt ${field}`);
    safeName(value.fulltextName, SAFE_TEXT_NAME, 'arXiv production receipt fulltextName');
    for (const [field, item] of Object.entries(value)) if (field.toLowerCase().includes('sha256')) sha(item, `arXiv production receipt ${field}`);
    return selfBound(value, 'receiptSha256', 'arXiv production receipt');
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'paperId', 'identity', 'identitySha256', 'identityRecordSha256',
        'evidenceKind', 'proof', 'authoritySha256'], 'authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || !isEvidenceKind(value.evidenceKind)) {
        fail('authority 的契约、版本或 evidenceKind 无效');
    }
    let identity;
    try { identity = identityApi.normalizeIdentity(value.identity); }
    catch (error) { fail(error.message); }
    if (identity.citation !== null) {
        fail('authority identity citation must be null until an authenticated official-metadata adapter binds it');
    }
    if (value.paperId !== identity.canonicalId
        || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity)
        || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) {
        fail('authority paperId/identity SHA/record SHA does not bind canonical paper identity');
    }
    if ((value.evidenceKind === 'arxiv-official-fulltext') !== (identity.kind === 'arxiv')) {
        fail('authority 的 evidenceKind 与论文身份类型不匹配');
    }
    const proof = normalizeProof(value.proof, value.evidenceKind);
    const normalized = { contract: CONTRACT, version: VERSION, paperId: value.paperId, identity,
        identitySha256: value.identitySha256, identityRecordSha256: value.identityRecordSha256,
        evidenceKind: value.evidenceKind, proof, authoritySha256: value.authoritySha256 };
    return selfBound(normalized, 'authoritySha256', 'authority');
}
function replayArxiv(root, authority, authorityName) {
    const proof = authority.proof;
    const snapshot = readJson(root, proof.snapshotName, 'arXiv source snapshot');
    const receipt = readJson(root, proof.receiptName, 'arXiv source receipt');
    const fulltext = readText(root, proof.fulltextName, 'arXiv full text');
    if (snapshot.value.contract === ARXIV_PRODUCTION_SNAPSHOT_CONTRACT) {
        const request = readJson(root, proof.requestName, 'arXiv source request');
        const observation = readJson(root, proof.observationName, 'arXiv source observation');
        const normalizedRequest = normalizeProductionArxivRequest(request.value);
        const normalizedObservation = normalizeProductionArxivObservation(observation.value);
        const normalizedSnapshot = normalizeProductionArxivSnapshot(snapshot.value);
        const normalizedReceipt = normalizeProductionArxivReceipt(receipt.value);
        const identity = authority.identity;
        const { payloadSha256, ...artifactBody } = normalizedObservation.structuredArtifacts;
        if (request.sha256 !== proof.requestFileSha256 || normalizedRequest.requestSha256 !== proof.requestSha256
            || observation.sha256 !== proof.observationFileSha256 || normalizedObservation.observationSha256 !== proof.observationSha256
            || snapshot.sha256 !== proof.snapshotFileSha256 || normalizedSnapshot.snapshotSha256 !== proof.snapshotSha256
            || receipt.sha256 !== proof.receiptFileSha256 || normalizedReceipt.receiptSha256 !== proof.receiptSha256
            || fulltext.sha256 !== proof.fulltextSha256 || normalizedRequest.paperId !== authority.paperId
            || normalizedRequest.identitySha256 !== authority.identitySha256 || normalizedRequest.authorityName !== authorityName
            || normalizedObservation.paperId !== authority.paperId || normalizedSnapshot.paperId !== authority.paperId
            || normalizedSnapshot.officialUrl !== identity.source.url || normalizedSnapshot.requestName !== proof.requestName
            || normalizedSnapshot.requestFileSha256 !== request.sha256 || normalizedSnapshot.requestSha256 !== normalizedRequest.requestSha256
            || normalizedSnapshot.observationName !== proof.observationName || normalizedSnapshot.observationFileSha256 !== observation.sha256
            || normalizedSnapshot.observationSha256 !== normalizedObservation.observationSha256
            || normalizedSnapshot.fulltextName !== proof.fulltextName || normalizedSnapshot.fulltextSha256 !== fulltext.sha256
            || normalizedObservation.structuredArtifacts.flattenedTextSha256 !== fulltext.sha256
            || payloadSha256 !== sha256(JSON.stringify(artifactBody))
            || normalizedReceipt.operationId !== normalizedRequest.operationId || normalizedReceipt.requestName !== proof.requestName
            || normalizedReceipt.requestFileSha256 !== request.sha256 || normalizedReceipt.requestSha256 !== normalizedRequest.requestSha256
            || normalizedReceipt.snapshotName !== proof.snapshotName || normalizedReceipt.snapshotFileSha256 !== snapshot.sha256
            || normalizedReceipt.snapshotSha256 !== normalizedSnapshot.snapshotSha256
            || normalizedReceipt.observationName !== proof.observationName || normalizedReceipt.observationFileSha256 !== observation.sha256
            || normalizedReceipt.observationSha256 !== normalizedObservation.observationSha256
            || normalizedReceipt.fulltextName !== proof.fulltextName || normalizedReceipt.fulltextSha256 !== fulltext.sha256) {
            fail('production arXiv request/observation/snapshot/receipt/fulltext chain drifted');
        }
        return { fulltextSha256: fulltext.sha256, sourceSnapshotSha256: normalizedSnapshot.snapshotSha256,
            productionAuthorized: false };
    }
    const normalizedSnapshot = normalizeArxivSnapshot(snapshot.value);
    const normalizedReceipt = normalizeArxivReceipt(receipt.value);
    if (snapshot.sha256 !== proof.snapshotFileSha256 || normalizedSnapshot.snapshotSha256 !== proof.snapshotSha256
        || receipt.sha256 !== proof.receiptFileSha256 || normalizedReceipt.receiptSha256 !== proof.receiptSha256
        || fulltext.sha256 !== proof.fulltextSha256) fail('arXiv authority proof file/SHA drifted');
    if (normalizedSnapshot.paperId !== authority.paperId || normalizedSnapshot.arxivId !== authority.identity.arxivId
        || normalizedSnapshot.officialUrl !== authority.identity.source.url
        || normalizedSnapshot.fulltextSha256 !== fulltext.sha256
        || normalizedReceipt.snapshotName !== proof.snapshotName
        || normalizedReceipt.snapshotFileSha256 !== snapshot.sha256
        || normalizedReceipt.snapshotSha256 !== normalizedSnapshot.snapshotSha256
        || normalizedReceipt.fulltextName !== proof.fulltextName
        || normalizedReceipt.fulltextSha256 !== fulltext.sha256) fail('arXiv snapshot/receipt/fulltext chain drifted');
    return { fulltextSha256: fulltext.sha256, sourceSnapshotSha256: normalizedSnapshot.snapshotSha256,
        productionAuthorized: false };
}
function replayConference(root, authority, options) {
    if (!options.conferencePlanHandle || typeof options.conferenceSourceRoot !== 'string') {
        fail('conference authority requires a live authenticated plan handle and configured source root');
    }
    const loaded = readJson(root, authority.proof.sourceContextName, 'conference source context');
    let context;
    try { context = conferenceContextApi.buildConferenceSourceContext({ planHandle: options.conferencePlanHandle,
        paperId: authority.paperId, sourceRoot: options.conferenceSourceRoot }); }
    catch (error) { fail(`会议来源上下文重放失败：${error.message}`); }
    if (!loaded.bytes.equals(prettyBytes(context)) || loaded.sha256 !== authority.proof.sourceContextFileSha256
        || stableHash(context) !== authority.proof.sourceContextSha256
        || context.sourceSnapshotSha256 !== authority.proof.sourceSnapshotSha256
        || context.observationBindingSha256 !== authority.proof.observationBindingSha256
        || context.productionAuthorization?.binding?.bindingSha256 !== authority.proof.planAuthorityBindingSha256
        || sha256(Buffer.from(context.text, 'utf8')) !== authority.proof.fulltextSha256
        || context.paperId !== authority.paperId || context.productionAuthorization?.authorized !== true) {
        fail('conference plan/import/ledger/source-context authority drifted');
    }
    return { fulltextSha256: authority.proof.fulltextSha256,
        sourceSnapshotSha256: authority.proof.sourceSnapshotSha256, productionAuthorized: true };
}

function loadAuthorityHandle({ authorityRoot, authorityName, conferencePlanHandle, conferenceSourceRoot } = {}) {
    const root = safeRoot(authorityRoot);
    const loaded = readJson(root, authorityName, 'paper source authority');
    const authority = normalizeAuthority(loaded.value);
    const replay = authority.evidenceKind === 'arxiv-official-fulltext'
        ? replayArxiv(root, authority, authorityName)
        : replayConference(root, authority, { conferencePlanHandle, conferenceSourceRoot });
    const handle = Object.freeze(Object.create(null)); AUTHORITY_HANDLES.add(handle);
    AUTHORITY_HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(authority), authorityName,
        authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, fulltextSha256: replay.fulltextSha256,
        sourceSnapshotSha256: replay.sourceSnapshotSha256, productionAuthorized: replay.productionAuthorized }),
    authorityRoot: root, authorityFileDev: loaded.dev, authorityFileIno: loaded.ino,
    conferencePlanHandle, conferenceSourceRoot }));
    return handle;
}
function authorityHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object') fail('authenticated paper source authority handle required');
    if (!AUTHORITY_HANDLES.has(handle)) {
        const delegated = require('./arxiv-source-authority.js').productionAuthorityHandleSnapshot(handle);
        if (delegated) return delegated;
        fail('authenticated paper source authority handle required');
    }
    return clone(AUTHORITY_HANDLE_DATA.get(handle).public);
}
function replayAuthorityHandle(handle, { requireProduction = false } = {}) {
    if (!handle || typeof handle !== 'object') fail('authenticated paper source authority handle required');
    if (!AUTHORITY_HANDLES.has(handle)) {
        const delegated = require('./arxiv-source-authority.js').replayProductionAuthorityHandle(handle);
        if (!delegated) fail('authenticated paper source authority handle required');
        return delegated;
    }
    const original = AUTHORITY_HANDLE_DATA.get(handle);
    if (requireProduction && original.public.productionAuthorized !== true) {
        fail('production-authorized paper source authority handle required');
    }
    const replayed = loadAuthorityHandle({ authorityRoot: original.authorityRoot,
        authorityName: original.public.authorityName, conferencePlanHandle: original.conferencePlanHandle,
        conferenceSourceRoot: original.conferenceSourceRoot });
    const current = AUTHORITY_HANDLE_DATA.get(replayed);
    if (current.authorityFileDev !== original.authorityFileDev || current.authorityFileIno !== original.authorityFileIno
        || stableHash(current.public) !== stableHash(original.public)) {
        fail('paper source authority file or replayed evidence changed after handle creation');
    }
    if (requireProduction && current.public.productionAuthorized !== true) {
        fail('重放的论文来源 authority 未经生产授权');
    }
    return replayed;
}

module.exports = { CONTRACT, VERSION, ARXIV_SNAPSHOT_CONTRACT, ARXIV_RECEIPT_CONTRACT, EVIDENCE_KINDS,
    ARXIV_PRODUCTION_SNAPSHOT_CONTRACT, ARXIV_PRODUCTION_RECEIPT_CONTRACT, ARXIV_REQUEST_CONTRACT,
    ARXIV_OBSERVATION_CONTRACT, ARXIV_FETCHER_CONTRACT,
    SAFE_JSON_NAME, SAFE_TEXT_NAME, MIN_FULLTEXT_CHARACTERS, PaperSourceAuthorityError,
    isEvidenceKind,
    stableHash, prettyBytes, normalizeArxivSnapshot, normalizeArxivReceipt, normalizeProductionArxivRequest,
    normalizeProductionArxivObservation, normalizeProductionArxivSnapshot, normalizeProductionArxivReceipt, normalizeAuthority,
    loadAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
