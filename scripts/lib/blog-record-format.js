'use strict';

const protocols = require('./protocol-codec');
const GENERATION = 'blog-generation';
const RECEIPT = 'blog-review-receipt';
const SNAPSHOT = 'published-papers-fingerprint';
const ORIGINAL_SNAPSHOT = protocols.historicalContract(SNAPSHOT, 'typed-float-and-utf16-json');

function recordProfile(value, family) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const field = Object.hasOwn(value, 'schemaVersion') ? 'schemaVersion' : 'contract';
    if (!protocols.hasValidHeader(value, family, field)) return null;
    return protocols.format(value[field], family, value.schemaFingerprint);
}

function sourceBoundGeneration(value) {
    return recordProfile(value, GENERATION) === 'source-bound-snapshot';
}

function strictReceipt(value) {
    return recordProfile(value, RECEIPT) === 'strict-page-and-asset-review';
}

function snapshotHeader(generation) {
    if (!sourceBoundGeneration(generation)) return null;
    const original = Object.hasOwn(generation, 'schemaVersion');
    const expected = original ? { contract: ORIGINAL_SNAPSHOT } : protocols.recordHeader(SNAPSHOT, SNAPSHOT);
    return generation.publishedPapersFingerprintContract === expected.contract
        && Object.hasOwn(generation, 'publishedPapersFingerprintContractSchemaFingerprint') === !original
        && generation.publishedPapersFingerprintContractSchemaFingerprint === expected.schemaFingerprint
        ? expected : null;
}

function matchesSnapshotReceipt(generation, receipt) {
    const header = snapshotHeader(generation);
    return !!header && (!Object.hasOwn(receipt, 'schemaVersion') || Object.hasOwn(generation, 'schemaVersion'))
        && receipt.generationInputIntegrity === header.contract
        && Object.hasOwn(receipt, 'generationInputIntegritySchemaFingerprint') === Object.hasOwn(header, 'schemaFingerprint')
        && receipt.generationInputIntegritySchemaFingerprint === header.schemaFingerprint;
}

module.exports = { sourceBoundGeneration, strictReceipt, snapshotHeader, matchesSnapshotReceipt };
