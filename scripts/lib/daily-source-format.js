'use strict';

const protocols = require('./protocol-codec');
const RUN = 'daily-fresh-source-run';
const REFERENCE = 'daily-fresh-source-reference';
const PROVENANCE = 'fresh-source-analysis';
const originalProvenanceHeader = Object.freeze(protocols.historicalHeader(PROVENANCE, 'original-source-identity'));
const originalRunHeader = Object.freeze(protocols.historicalHeader(RUN, 'sealed-official-source-set'));
const originalReferenceHeader = Object.freeze(protocols.historicalHeader(REFERENCE, 'exact-run-bytes'));
const runFields = ['runId', 'batchDate', 'batchId', 'paperIds', 'sourceSetSha256', 'sourceExpectations'];
const referenceFields = ['runId', 'batchDate', 'batchId', 'sourceGeneration', 'sourceSetSha256', 'runManifestSha256'];

function header(record, family) {
    if (!protocols.hasValidHeader(record, family)) return null;
    return protocols.recordHeader(record.contract, family, record.schemaFingerprint);
}

function exactFields(record, head, fields) {
    return !!head && Object.keys(record).sort().join('\0') === [...Object.keys(head), ...fields].sort().join('\0');
}

function isDailySourceRun(record) { return exactFields(record, header(record, RUN), runFields); }
function isDailySourceReference(record) { return exactFields(record, header(record, REFERENCE), referenceFields); }

function isFreshSourceProvenance(record) { return !!header(record, PROVENANCE); }
function provenanceHeaderForRun(run) {
    if (!isDailySourceRun(run)) throw new Error('来源身份声明需要真实的日更运行格式');
    return Object.hasOwn(run, 'version') ? originalProvenanceHeader : protocols.recordHeader(PROVENANCE, PROVENANCE);
}
function matchesRunProvenance(run, record) {
    const actual = header(record, PROVENANCE);
    const runHeader = header(run, RUN);
    if (!actual || !runHeader) return false;
    const expected = Object.hasOwn(runHeader, 'version') ? originalProvenanceHeader : protocols.recordHeader(PROVENANCE, PROVENANCE);
    return actual.contract === expected.contract && actual.schemaFingerprint === expected.schemaFingerprint;
}

const BUNDLE_EXPECTATION = 'sealed-arxiv-source-bundle';
const BUNDLE_DESCRIPTOR = 'fresh-source-descriptor';
const HISTORICAL_CACHE = 'historical-fresh-source-cache';
const originalBundleMode = protocols.historicalContract(BUNDLE_EXPECTATION, 'four-official-source-files');
const originalBundleDescriptorHeader = Object.freeze(protocols.historicalHeader(BUNDLE_DESCRIPTOR, 'sealed-bundle-description'));
const originalCacheHeader = Object.freeze(protocols.historicalHeader(HISTORICAL_CACHE, 'legacy-text-and-artifacts'));

function bundleExpectation(generation, original) {
    if (original) return { sourceMode: originalBundleMode, sourceGeneration: generation };
    const h = protocols.recordHeader(BUNDLE_EXPECTATION, BUNDLE_EXPECTATION);
    return { sourceMode: h.contract, sourceModeSchemaFingerprint: h.schemaFingerprint, sourceGeneration: generation };
}
function isBundleExpectation(value) {
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.sourceGeneration)
        || value.sourceGeneration < 1) return false;
    const format = { contract: value.sourceMode,
        ...(Object.hasOwn(value, 'sourceModeSchemaFingerprint') ? { schemaFingerprint: value.sourceModeSchemaFingerprint } : {}) };
    return protocols.hasValidHeader(format, BUNDLE_EXPECTATION);
}
function isBundleDescriptor(value) { return !!header(value, BUNDLE_DESCRIPTOR); }
function isOriginalCacheDescriptor(value) {
    const actual = header(value, HISTORICAL_CACHE);
    return !!actual && actual.contract === originalCacheHeader.contract && actual.version === originalCacheHeader.version;
}

module.exports = { RUN, REFERENCE, PROVENANCE, BUNDLE_DESCRIPTOR, originalBundleMode, originalBundleDescriptorHeader,
    originalCacheHeader, bundleExpectation, isBundleExpectation, isBundleDescriptor, isOriginalCacheDescriptor, originalProvenanceHeader, isFreshSourceProvenance, provenanceHeaderForRun, matchesRunProvenance, originalRunHeader, originalReferenceHeader, header, isDailySourceRun, isDailySourceReference,
    currentHeader: name => protocols.recordHeader(name, name) };
