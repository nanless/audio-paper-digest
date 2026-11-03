'use strict';

const codec = require('./protocol-codec');
const BOUNDARY = 'daily-fetch-boundary';
const CONTINUITY = 'daily-fetch-continuity';
const RECOVERY_CONTINUITY = 'daily-fetch-continuity-recovery';
const SOURCE = 'daily-fetch-source';

function readHeader(value, family) {
    if (!codec.hasValidHeader(value, family)) throw new Error(`日更抓取记录格式不受支持：${family}`);
    return codec.recordHeader(value.contract, family, value.schemaFingerprint);
}

function isRecoveryContinuity(value) {
    return codec.hasValidHeader(value, RECOVERY_CONTINUITY);
}

function sourceHeaderForBoundary(boundary) {
    if (boundary && readHeader(boundary, BOUNDARY).schemaFingerprint !== undefined) {
        return { fetchSourceFormat: codec.recordHeader(SOURCE, SOURCE) };
    }
    return codec.historicalHeader(SOURCE, 'original-published-window-source', null);
}
function sourceFieldsForBoundary(boundary) {
    const header = sourceHeaderForBoundary(boundary);
    return { ...header, coverageStrategy: header.fetchSourceFormat
        ? codec.declaredSchema(SOURCE, SOURCE).coverageStrategy : 'previous-digest-window-v1' };
}

function declaresBoundedFetchSource(value) {
    return Boolean(value && (Object.hasOwn(value, 'fetchSourceFormat') || value.sourceContractVersion === 7
        || value.fetchBoundary !== undefined));
}

function hasBoundedFetchSource(value) {
    if (!value || !declaresBoundedFetchSource(value) || !value.fetchBoundary) return false;
    try {
        const expected = sourceFieldsForBoundary(value.fetchBoundary);
        if (expected.fetchSourceFormat) {
            const header = value.fetchSourceFormat;
            return !Object.hasOwn(value, 'sourceContractVersion') && codec.isCurrentHeader(header, SOURCE)
                && Object.keys(header).length === 2 && header.schemaFingerprint === expected.fetchSourceFormat.schemaFingerprint;
        }
        return !Object.hasOwn(value, 'fetchSourceFormat') && value.sourceContractVersion === expected.sourceContractVersion;
    } catch { return false; }
}

function hasFetchCoverageStrategy(value) {
    return hasBoundedFetchSource(value) && value.coverageStrategy === sourceFieldsForBoundary(value.fetchBoundary).coverageStrategy;
}

function sourceArtifactFields(value) {
    if (!hasBoundedFetchSource(value)) return {};
    return { ...sourceFieldsForBoundary(value.fetchBoundary), pageSize: value.pageSize, fetchBoundary: value.fetchBoundary };
}

function evidenceHeaderForBoundary(boundary, family) {
    return readHeader(boundary, BOUNDARY).schemaFingerprint
        ? codec.recordHeader(family, family) : codec.historicalHeader(family, 'original-source-bound', null);
}
function hasEvidenceHeader(value, boundary, family) {
    try {
        const expected = evidenceHeaderForBoundary(boundary, family);
        return codec.hasValidHeader(value, family) && value.contract === expected.contract
            && value.schemaFingerprint === expected.schemaFingerprint;
    } catch { return false; }
}
function coverageHeaderForBoundary(boundary, family) {
    const { contract, schemaFingerprint } = evidenceHeaderForBoundary(boundary, family);
    return { coverageContract: contract, ...(schemaFingerprint ? { coverageSchemaFingerprint: schemaFingerprint } : {}) };
}
function hasCoverageHeader(value, boundary, family) {
    const header = { contract: value?.coverageContract };
    if (Object.hasOwn(value || {}, 'coverageSchemaFingerprint')) header.schemaFingerprint = value.coverageSchemaFingerprint;
    return hasEvidenceHeader(header, boundary, family);
}

module.exports = { BOUNDARY, CONTINUITY, RECOVERY_CONTINUITY, readHeader, isRecoveryContinuity,
    sourceFieldsForBoundary, sourceHeaderForBoundary, declaresBoundedFetchSource, hasBoundedFetchSource, hasFetchCoverageStrategy, sourceArtifactFields,
    evidenceHeaderForBoundary, hasEvidenceHeader, coverageHeaderForBoundary, hasCoverageHeader };
