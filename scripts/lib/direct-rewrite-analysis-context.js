'use strict';

// 历史直改的运行器传入的来源对象，要么来自刚抓取的 arXiv generation，要么来自
// 保留的会议 PDF。它单独占用一个 AsyncLocalStorage 作用域，与旧的 fresh-run
// 缓存分开：直改运行不得读取 data/current、旧分析结果，也不得读取之前生成过的
// Reader 素材。

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const path = require('node:path');

const scope = new AsyncLocalStorage();
const ARXIV = /^arxiv:\d{4}\.\d{4,5}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVENANCE_CONTRACT = 'fresh-source-analysis-v1';
// 这份契约把「没有保存 Figure 素材」写成有意为之、可供审查的状态。渲染器不能
// 因为 cachePath 缺失就断定素材不存在：较早的 Reader 记录仍沿用带缓存的发布契约。
const EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT = 'ephemeral-no-persisted-figure-assets-v1';
const CONFERENCE = /^conference:[a-z0-9]+(?:-[a-z0-9]+)*:\d{4}:[a-z0-9-]+:[^:]+$/;

function fail(message) {
    const error = new Error(`Direct rewrite source context rejected: ${message}`);
    error.code = 'HISTORICAL_DIRECT_REWRITE_SOURCE_INTEGRITY';
    error.retryable = false;
    throw error;
}

function clone(value) { return structuredClone(value); }
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function stableHash(value) {
    const sortJsonKeys = item => Array.isArray(item) ? item.map(sortJsonKeys)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sortJsonKeys(item[key])])) : item;
    return sha256(JSON.stringify(sortJsonKeys(value)));
}

function paperId(paper) {
    const value = typeof paper === 'string' ? paper
        : paper?.directPaperId || paper?.id || paper?.paperId
            || (paper?.arxivId ? `arxiv:${String(paper.arxivId).replace(/v\d+$/i, '')}` : '');
    if (!ARXIV.test(value) && !CONFERENCE.test(value)) fail('paper identity is invalid');
    return value;
}

function safeReaderAttemptsDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('Reader attempts directory must be absolute');
    const absolute = path.resolve(value);
    if (absolute.includes(`${path.sep}image-cache${path.sep}`)
        || absolute.includes(`${path.sep}api-reader-assets${path.sep}`)) {
        fail('Reader attempts cannot use an image cache directory');
    }
    return absolute;
}

function validateSource(source, id) {
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || typeof source.text !== 'string' || !source.text.trim()
        || typeof source.source !== 'string' || !source.source
        || typeof source.sourceId !== 'string' || !source.sourceId
        || !source.structuredArtifacts || typeof source.structuredArtifacts !== 'object'
        || Array.isArray(source.structuredArtifacts)) {
        fail('source details are incomplete');
    }
    if (source.paperId !== undefined && source.paperId !== id) fail('source details belong to another paper');
    const prohibited = Object.keys(source).filter(key => /(?:^|_)(?:analysis|parsed|apiReader|readerArticle|readerPlan)(?:$|_)/i.test(key));
    if (prohibited.length) fail(`source details carry generated fields: ${prohibited.join(', ')}`);
    return clone(source);
}

function withDirectRewriteAnalysisSource(identity, callback) {
    if (!identity || typeof identity !== 'object' || typeof callback !== 'function') {
        fail('identity and callback are required');
    }
    const id = paperId(identity.paperId);
    if (!['arxiv-fresh-fetch', 'conference-local-pdf'].includes(identity.route)) fail('source route is invalid');
    const sourceDetails = validateSource(identity.sourceDetails, id);
    // 来源作用域的单元测试可以传快照哈希，用来跑通嵌套的 Reader 路径。
    // 只有带 run ID 时，证明才具备持久化能力。
    const hasRunId = identity.runId !== undefined;
    if (hasRunId && (!UUID.test(String(identity.runId || '')) || !SHA.test(String(identity.sourceSha256 || ''))
        || !SHA.test(String(identity.structuredArtifactsSha256 || ''))
        || !SHA.test(String(identity.sourceSnapshotSha256 || '')))) {
        fail('sealed direct source provenance is incomplete');
    }
    if (hasRunId && (sha256(sourceDetails.text) !== identity.sourceSha256
        || sourceDetails.structuredArtifacts?.payloadSha256 !== identity.structuredArtifactsSha256)) {
        fail('direct source provenance does not bind its supplied text/artifacts');
    }
    if (hasRunId && identity.route === 'arxiv-fresh-fetch'
        && (!Number.isSafeInteger(identity.sourceGeneration) || identity.sourceGeneration < 1
            || !SHA.test(String(identity.sourceManifestSha256 || '')))) {
        fail('arXiv direct source provenance lacks its sealed generation/manifest');
    }
    if (identity.sourceVersionIdentitySha256 !== undefined
        && (identity.route !== 'arxiv-fresh-fetch' || !SHA.test(String(identity.sourceVersionIdentitySha256 || '')))) {
        fail('direct source version provenance is invalid');
    }
    const readerAttemptsDir = safeReaderAttemptsDirectory(identity.readerAttemptsDir);
    if (identity.materializeReaderFigures !== undefined && typeof identity.materializeReaderFigures !== 'function') {
        fail('Reader figure materializer must be a function');
    }
    if (identity.downloadPrimaryImage !== undefined && typeof identity.downloadPrimaryImage !== 'function') {
        fail('primary image downloader must be a function');
    }
    if (identity.deferReaderCandidateCommit !== undefined
        && typeof identity.deferReaderCandidateCommit !== 'boolean') {
        fail('Reader candidate commit policy must be boolean');
    }
    if (identity.readerRetryEpoch !== undefined
        && (!Number.isSafeInteger(identity.readerRetryEpoch) || identity.readerRetryEpoch < 1)) {
        fail('Reader retry epoch must be a positive safe integer');
    }
    const supplementaryImages = identity.supplementaryReaderImages === undefined ? [] : identity.supplementaryReaderImages;
    if (!Array.isArray(supplementaryImages) || supplementaryImages.some(image => !image || typeof image !== 'object'
        || !Buffer.isBuffer(image.rawBytes) || !/^image\/(?:png|jpeg|webp)$/.test(String(image.mediaType || ''))
        || !/^[a-f0-9]{64}$/.test(String(image.assetSha256 || '')))) {
        fail('supplementary Reader pixels are malformed');
    }
    const context = Object.freeze({ paperId: id, sourceDetails: Object.freeze(sourceDetails), readerAttemptsDir,
        materializeReaderFigures: identity.materializeReaderFigures || null,
        // 历史直改会先把完成的 Reader 阶段落盘，再注销可恢复的已接受草稿。
        // 日更和旧调用方仍按原来的方式立即注销，除非它们显式加入同一事务。
        deferReaderCandidateCommit: identity.deferReaderCandidateCommit === true,
        // 分析不完整后，外层历史重试会拿到一个新的 Reader 恢复身份。上一次失败的
        // 候选记录有意保留，供审查和重新核对；但它不能在新一轮 Reader 尝试发出
        // 请求之前，就把这次有界尝试的额度耗光。
        ...(identity.readerRetryEpoch !== undefined
            ? { readerRetryEpoch: identity.readerRetryEpoch } : {}),
        // 双模型主分析必须走这个直改专用下载器。它可以返回字节或 base64，但绝不会
        // 返回 data/current 下的缓存路径，并且始终限定在当前执行的 AsyncLocal 作用域内。
        downloadPrimaryImage: identity.downloadPrimaryImage || null,
        // 原始字节只留在这个 AsyncLocalStorage 作用域里。运行器在每次写 JSON 之前
        // 都会把它们去掉。
        supplementaryReaderImages: Object.freeze(supplementaryImages.map(image => Object.freeze({ ...image, rawBytes: Buffer.from(image.rawBytes) }))),
        sourceSnapshotSha256: String(identity.sourceSnapshotSha256 || ''),
        ...(hasRunId ? { runId: identity.runId, sourceSha256: identity.sourceSha256,
            structuredArtifactsSha256: identity.structuredArtifactsSha256,
            ...(identity.route === 'arxiv-fresh-fetch' ? { sourceGeneration: identity.sourceGeneration,
                sourceManifestSha256: identity.sourceManifestSha256,
                ...(identity.sourceVersionIdentitySha256 ? {
                    sourceVersionIdentitySha256: identity.sourceVersionIdentitySha256
                } : {}) } : {}) } : {}),
        route: identity.route === 'arxiv-fresh-fetch' || identity.route === 'conference-local-pdf'
            ? identity.route : fail('source route is invalid') });
    return scope.run(context, callback);
}

function getDirectRewriteAnalysisContext() { return scope.getStore() || null; }

function getDirectRewriteSource(paper) {
    const context = scope.getStore();
    if (!context || !context.runId) return null;
    if (paperId(paper) !== context.paperId) fail('analysis asked for a different paper');
    return clone(context.sourceDetails);
}

function directReaderAttemptsDirectory(requested = null) {
    const context = scope.getStore();
    if (!context) return requested;
    if (requested && path.resolve(requested) !== context.readerAttemptsDir) {
        fail('Reader candidate directory differs from direct execution directory');
    }
    return context.readerAttemptsDir;
}

function directReaderMaterializer() { return scope.getStore()?.materializeReaderFigures || null; }
function directReaderCandidateCommitDeferred() {
    return scope.getStore()?.deferReaderCandidateCommit === true;
}
function directPrimaryImageDownloader() { return scope.getStore()?.downloadPrimaryImage || null; }
function directSupplementaryReaderImages() { return scope.getStore()?.supplementaryReaderImages || []; }

function getDirectSourceRecord(paper = getDirectRewriteAnalysisContext()?.paperId) {
    const context = scope.getStore();
    if (!context || !context.runId) return null;
    if (paperId(paper) !== context.paperId) fail('direct provenance was requested for another paper');
    return { contract: PROVENANCE_CONTRACT, runId: context.runId,
        sourceSha256: context.sourceSha256,
        structuredArtifactsSha256: context.structuredArtifactsSha256,
        sourceSnapshotSha256: context.sourceSnapshotSha256,
        ...(context.route === 'arxiv-fresh-fetch' ? { sourceGeneration: context.sourceGeneration,
            sourceManifestSha256: context.sourceManifestSha256,
            ...(context.sourceVersionIdentitySha256 ? {
                sourceVersionIdentitySha256: context.sourceVersionIdentitySha256
            } : {}) } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
}

function attachDirectSourceRecord(paper, manifest, source) {
    const context = scope.getStore();
    if (!context || !context.runId) return;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('direct analysis manifest is invalid');
    const sourceRecord = getDirectSourceRecord(paper);
    if (sha256(String(source?.text || '')) !== sourceRecord.sourceSha256
        || source?.structuredArtifacts?.payloadSha256 !== sourceRecord.structuredArtifactsSha256) {
        fail('direct analysis tried to attach provenance from another source');
    }
    paper.freshRewriteProvenance = sourceRecord;
    manifest.freshRewriteProvenance = clone(sourceRecord);
}

function stripEphemeralFigureFields(figure) {
    if (!figure || typeof figure !== 'object' || Array.isArray(figure)) fail('Reader figure is malformed');
    // assetSha256 记录的是本次调用中看到的像素的完整性，不是可持久化的素材定位符。
    // 删掉所有路径和字节后要保留它，但不能把未校验的值写进这个字段。
    if (figure.assetSha256 !== undefined && !SHA.test(String(figure.assetSha256 || ''))) {
        fail('Reader figure evidence asset SHA is invalid');
    }
    const forbidden = new Set(['cachePath', 'tempPath', 'path', 'bytes', 'rawBytes', 'buffer', 'assetFilename',
        'assetBytes', 'assetWidth', 'assetHeight', 'assetMediaType']);
    return Object.fromEntries(Object.entries(figure).filter(([key]) => !forbidden.has(key)));
}

function assertNoPersistentFigureFields(value) {
    const encoded = JSON.stringify(value);
    if (/(?:"(?:cachePath|tempPath|rawBytes|assetFilename|assetBytes|assetWidth|assetHeight|assetMediaType)"|image-cache|api-reader-assets)/.test(encoded)) {
        fail('direct execution tried to persist an image path or image bytes');
    }
    const validateEvidenceSha = item => {
        if (!item || typeof item !== 'object') return;
        if (!Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, 'assetSha256')
            && !SHA.test(String(item.assetSha256 || ''))) {
            fail('persisted Reader figure evidence asset SHA is invalid');
        }
        Object.values(item).forEach(validateEvidenceSha);
    };
    validateEvidenceSha(value);
    return value;
}

module.exports = { PROVENANCE_CONTRACT, EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT,
    withDirectRewriteAnalysisSource, getDirectRewriteAnalysisContext, getDirectRewriteSource,
    directReaderAttemptsDirectory, directReaderMaterializer, directPrimaryImageDownloader, stripEphemeralFigureFields,
    directReaderCandidateCommitDeferred,
    directSupplementaryReaderImages, getDirectSourceRecord, attachDirectSourceRecord,
    assertNoPersistentFigureFields, paperId, stableHash };
