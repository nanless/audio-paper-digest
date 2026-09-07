'use strict';

// The historical direct runner supplies a source object that was constructed
// from either the just-captured arXiv generation or a retained conference PDF.
// It deliberately has a separate AsyncLocalStorage scope from the legacy
// fresh-run cache: direct runs must not read data/current, an old analysis, or
// a previously materialized Reader asset.

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const path = require('node:path');

const scope = new AsyncLocalStorage();
const ARXIV = /^arxiv:\d{4}\.\d{4,5}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVENANCE_CONTRACT = 'fresh-source-analysis-v1';
// This contract makes the absence of a stored Figure asset intentional and
// reviewable.  A renderer must never infer it from a missing cachePath: older
// Reader records retain their cache-backed publication contract.
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
    const canonical = item => Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
    return sha256(JSON.stringify(canonical(value)));
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
    // Source-scope unit tests may supply a snapshot hash to exercise nested
    // Reader paths. Only a run ID activates a persistence-capable proof.
    const hasSealedProvenance = identity.runId !== undefined;
    if (hasSealedProvenance && (!UUID.test(String(identity.runId || '')) || !SHA.test(String(identity.sourceSha256 || ''))
        || !SHA.test(String(identity.structuredArtifactsSha256 || ''))
        || !SHA.test(String(identity.sourceSnapshotSha256 || '')))) {
        fail('sealed direct source provenance is incomplete');
    }
    if (hasSealedProvenance && (sha256(sourceDetails.text) !== identity.sourceSha256
        || sourceDetails.structuredArtifacts?.payloadSha256 !== identity.structuredArtifactsSha256)) {
        fail('direct source provenance does not bind its supplied text/artifacts');
    }
    if (hasSealedProvenance && identity.route === 'arxiv-fresh-fetch'
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
    const supplementaryImages = identity.supplementaryReaderImages === undefined ? [] : identity.supplementaryReaderImages;
    if (!Array.isArray(supplementaryImages) || supplementaryImages.some(image => !image || typeof image !== 'object'
        || !Buffer.isBuffer(image.rawBytes) || !/^image\/(?:png|jpeg|webp)$/.test(String(image.mediaType || ''))
        || !/^[a-f0-9]{64}$/.test(String(image.assetSha256 || '')))) {
        fail('supplementary Reader pixels are malformed');
    }
    const context = Object.freeze({ paperId: id, sourceDetails: Object.freeze(sourceDetails), readerAttemptsDir,
        materializeReaderFigures: identity.materializeReaderFigures || null,
        // Dual-model primary analysis must use this direct-only downloader.
        // It may return bytes/base64 but can never return data/current cache
        // paths, and remains scoped to this execution's AsyncLocal context.
        downloadPrimaryImage: identity.downloadPrimaryImage || null,
        // Raw bytes are held only by this AsyncLocalStorage scope. The runner
        // strips them before every JSON persistence boundary.
        supplementaryReaderImages: Object.freeze(supplementaryImages.map(image => Object.freeze({ ...image, rawBytes: Buffer.from(image.rawBytes) }))),
        sourceSnapshotSha256: String(identity.sourceSnapshotSha256 || ''),
        ...(hasSealedProvenance ? { runId: identity.runId, sourceSha256: identity.sourceSha256,
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
function directPrimaryImageDownloader() { return scope.getStore()?.downloadPrimaryImage || null; }
function directSupplementaryReaderImages() { return scope.getStore()?.supplementaryReaderImages || []; }

function directFreshAnalysisIdentity(paper = getDirectRewriteAnalysisContext()?.paperId) {
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

function attachDirectSourceProvenance(paper, manifest, source) {
    const context = scope.getStore();
    if (!context || !context.runId) return;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('direct analysis manifest is invalid');
    const proof = directFreshAnalysisIdentity(paper);
    if (sha256(String(source?.text || '')) !== proof.sourceSha256
        || source?.structuredArtifacts?.payloadSha256 !== proof.structuredArtifactsSha256) {
        fail('direct analysis tried to attach provenance from another source');
    }
    paper.freshRewriteProvenance = proof;
    manifest.freshRewriteProvenance = clone(proof);
}

function stripEphemeralFigureFields(figure) {
    if (!figure || typeof figure !== 'object' || Array.isArray(figure)) fail('Reader figure is malformed');
    const forbidden = new Set(['cachePath', 'tempPath', 'path', 'bytes', 'rawBytes', 'buffer', 'assetFilename',
        'assetBytes', 'assetWidth', 'assetHeight', 'assetMediaType']);
    return Object.fromEntries(Object.entries(figure).filter(([key]) => !forbidden.has(key)));
}

function assertNoPersistentFigureFields(value) {
    const encoded = JSON.stringify(value);
    if (/(?:"(?:cachePath|tempPath|rawBytes|assetFilename|assetBytes|assetWidth|assetHeight|assetMediaType)"|image-cache|api-reader-assets)/.test(encoded)) {
        fail('direct execution tried to persist an image path or image bytes');
    }
    return value;
}

module.exports = { PROVENANCE_CONTRACT, EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT,
    withDirectRewriteAnalysisSource, getDirectRewriteAnalysisContext, getDirectRewriteSource,
    directReaderAttemptsDirectory, directReaderMaterializer, directPrimaryImageDownloader, stripEphemeralFigureFields,
    directSupplementaryReaderImages, directFreshAnalysisIdentity, attachDirectSourceProvenance,
    assertNoPersistentFigureFields, paperId, stableHash };
