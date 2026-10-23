'use strict';
// Only a synchronous physical daily-source read may exempt an unselected DOM
// alias. Neither the ticket nor any declaration in a saved JSON is a source.
const { isDeepStrictEqual } = require('node:util');
const tickets = new WeakMap();
const SHA = /^[a-f0-9]{64}$/;
const TRANSFORM = 'decoded-white-background-fit-jpeg-v1';
const EVIDENCE_KEYS = ['inputId', 'kind', 'ordinal', 'url', 'sha256', 'sourceSha256', 'sourceBytes',
    'sourceWidth', 'sourceHeight', 'modelPayloadSha256', 'modelPayloadBytes', 'modelPayloadWidth',
    'modelPayloadHeight', 'modelPayloadTransform', 'status'].sort();
const PIXEL_FIELDS = ['url', 'sha256', 'sourceSha256', 'sourceBytes', 'sourceWidth', 'sourceHeight',
    'modelPayloadSha256', 'modelPayloadBytes', 'modelPayloadWidth', 'modelPayloadHeight', 'modelPayloadTransform', 'status'];
function fail(message) {
    const error = new Error(`Sealed Figure alias rejected: ${message}`);
    error.code = 'HISTORICAL_DIRECT_READER_FIGURE_EVIDENCE'; error.retryable = false; throw error;
}
const validUrl = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const positive = value => Number.isSafeInteger(value) && value > 0;
function plannedIdentity(planned) {
    if (!Array.isArray(planned) || planned.length > 8) fail('planned figures exceed the fixed alias profile');
    const ordinals = new Set(), urls = new Set();
    return planned.map(item => {
        if (!positive(item?.ordinal) || !validUrl(item.url) || ordinals.has(item.ordinal) || urls.has(item.url)) {
            fail('selected Figure identities are invalid or duplicated');
        }
        ordinals.add(item.ordinal); urls.add(item.url); return [item.ordinal, item.url];
    });
}
function evidenceIdentity(evidence) {
    if (!Array.isArray(evidence) || evidence.length > 8) fail('image evidence exceeds the fixed alias profile');
    const ordinals = new Set(); let bytes = 0, pixels = 0;
    return evidence.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).sort().join('\0') !== EVIDENCE_KEYS.join('\0')
            || item.kind !== 'figure' || item.status !== 'ready' || !positive(item.ordinal)
            || ordinals.has(item.ordinal) || !validUrl(item.url)
            || !SHA.test(item.sourceSha256) || item.sha256 !== item.sourceSha256
            || !SHA.test(item.modelPayloadSha256) || item.inputId !== `figure:${item.ordinal}:${item.sourceSha256}`
            || item.modelPayloadTransform !== TRANSFORM
            || !['sourceBytes', 'sourceWidth', 'sourceHeight', 'modelPayloadBytes', 'modelPayloadWidth', 'modelPayloadHeight']
                .every(key => positive(item[key]))
            || item.sourceBytes > 16 * 1024 * 1024 || item.modelPayloadBytes > 4 * 1024 * 1024
            || !Number.isSafeInteger(item.sourceWidth * item.sourceHeight)
            || item.sourceWidth * item.sourceHeight > 64 * 1024 * 1024
            || item.modelPayloadWidth > Math.min(2048, item.sourceWidth)
            || item.modelPayloadHeight > Math.min(2048, item.sourceHeight)
            || item.modelPayloadWidth * item.modelPayloadHeight > 4 * 1024 * 1024) {
            fail('all original evidence must retain complete unique ready pixel identities');
        }
        bytes += item.modelPayloadBytes; pixels += item.modelPayloadWidth * item.modelPayloadHeight;
        if (bytes > 12 * 1024 * 1024 || pixels > 16 * 1024 * 1024) fail('aggregate original model image limits exceeded');
        ordinals.add(item.ordinal);
        return EVIDENCE_KEYS.map(key => item[key]);
    });
}
function readSource() {
    const fresh = require('./fresh-analysis-context');
    const context = fresh.getFreshAnalysisContext();
    const direct = require('./direct-rewrite-analysis-context').getDirectRewriteAnalysisContext();
    if (!fresh.isDailyFreshSourceScope() || !context?.paperId || !direct
        || direct.paperId !== `arxiv:${context.paperId}` || direct.runId !== context.runId
        || direct.route !== 'arxiv-fresh-fetch') fail('actual same-paper daily fresh and direct scopes are required');
    const source = fresh.readFreshSource(context.runDir, context.paperId, context);
    const descriptor = source?.freshSourceDescriptor;
    if (descriptor?.contract !== 'fresh-source-bundle-v2'
        || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
            .some(key => descriptor[key] !== direct[key])
        || !isDeepStrictEqual(source, direct.sourceDetails)) fail('physical four-file source differs from the actual direct scope');
    return { context, direct, source };
}
function sourceFigures(source, evidence) {
    const figures = source.structuredArtifacts?.figures;
    if (!Array.isArray(figures) || figures.length > 1024) fail('source Figure inventory is outside the alias profile');
    const byOrdinal = new Map();
    for (const figure of figures) {
        if (!positive(figure?.ordinal) || byOrdinal.has(figure.ordinal)) fail('source Figure ordinals are not unique');
        byOrdinal.set(figure.ordinal, figure);
    }
    const bound = new Map();
    for (const item of evidence) {
        const figure = byOrdinal.get(item.ordinal);
        if (!figure || figure.recoveryStatus !== 'complete' || !SHA.test(figure.sourceDomSha256)
            || !Array.isArray(figure.images) || figure.images.length !== 1
            || figure.images[0]?.kind !== 'external_url' || figure.images[0].url !== item.url) {
            fail('each original image requires its unique complete single-image sealed DOM Figure');
        }
        bound.set(item.ordinal, figure);
    }
    return bound;
}
function withSourceAliases(planned, evidence, callback) {
    if (typeof callback !== 'function') fail('a synchronous owner callback is required');
    if (!Array.isArray(evidence)) return callback(null);
    const urls = new Set();
    const duplicate = evidence.some(item => item?.kind === 'figure'
        && (urls.has(item.url) || (urls.add(item.url), false)));
    if (!duplicate) return callback(null); // Preserve ordinary strict binder behavior and its accepted shapes.
    require('../env-loader').requireExternalRuntime('reader-sealed-figure-alias');
    const plannedSnapshot = plannedIdentity(planned), evidenceSnapshot = evidenceIdentity(evidence);
    const before = readSource(), figures = sourceFigures(before.source, evidence);
    const ticket = Object.freeze(Object.create(null));
    tickets.set(ticket, { ...before, planned, evidence, plannedSnapshot, evidenceSnapshot, figures });
    let result, primary, failed = false;
    try {
        result = callback(ticket);
        if (result && typeof result.then === 'function') fail('alias source authority cannot cross asynchronous work');
    } catch (error) { primary = error; failed = true; }
    finally { tickets.delete(ticket); }
    try {
        const after = readSource();
        if (after.context !== before.context || after.direct !== before.direct
            || !isDeepStrictEqual(after.source, before.source)
            || !isDeepStrictEqual(plannedIdentity(planned), plannedSnapshot)
            || !isDeepStrictEqual(evidenceIdentity(evidence), evidenceSnapshot)) fail('source or bound Figure inputs changed before return');
    } catch (error) { if (!failed) throw error; }
    if (failed) throw primary;
    return result;
}
function assertUnselectedDuplicate(ticket, planned, evidence, left, right) {
    const proof = ticket && tickets.get(ticket);
    if (!proof || planned !== proof.planned || evidence !== proof.evidence
        || !evidence.includes(left) || !evidence.includes(right) || left === right
        || !isDeepStrictEqual(plannedIdentity(planned), proof.plannedSnapshot)
        || !isDeepStrictEqual(evidenceIdentity(evidence), proof.evidenceSnapshot)) fail('no active exact-input source alias ticket');
    const now = readSource();
    if (now.context !== proof.context || now.direct !== proof.direct || !isDeepStrictEqual(now.source, proof.source)) {
        fail('source changed inside the synchronous alias scope');
    }
    const a = proof.figures.get(left.ordinal), b = proof.figures.get(right.ordinal);
    if (!a || !b || a.ordinal === b.ordinal || a.sourceDomSha256 === b.sourceDomSha256
        || PIXEL_FIELDS.some(key => left[key] !== right[key])
        || planned.some(item => item.ordinal === left.ordinal) && planned.some(item => item.ordinal === right.ordinal)) {
        fail('only an unselected same-asset distinct sealed DOM alias may repeat a URL');
    }
    return true;
}
module.exports = { withSourceAliases, assertUnselectedDuplicate };
