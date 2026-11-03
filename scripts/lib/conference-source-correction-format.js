'use strict';

const codec = require('./protocol-codec');
const { recordHeaderFor } = require('./workflow-record-format');

const FAMILIES = Object.freeze(['conference-source-resource-correction', 'conference-source-core-correction']);
function locatorFamily(value) {
    return FAMILIES.find(name => codec.hasValidHeader(value, name)) || null;
}
function isLocator(value, kind) {
    return locatorFamily(value) === `conference-source-${kind}-correction`;
}
function hasProvenance(value, kind) {
    return codec.hasValidHeader(value, `conference-source-${kind}-correction-provenance`);
}
function sourceFormatsForBatch(batch, family) {
    const batchFamily = family + '-batch';
    if (!FAMILIES.includes(family) || !codec.hasValidHeader(batch, batchFamily)) {
        throw new Error('会议来源纠正清单格式不符');
    }
    const saved = recordHeaderFor(batch, batchFamily);
    if (!saved.schemaFingerprint) return {
        recordsFormat: codec.historicalHeader(family, 'exact-original-source-member'),
        provenanceFormat: codec.historicalHeader(family + '-provenance', 'zero-request-source-correction'),
        receiptFormat: codec.historicalHeader(family + '-receipt', 'actual-adopted-source-correction'),
        ...(family === FAMILIES[1] ? { coreStageProvenanceFormat: codec.historicalHeader(
            'conference-source-core-correction-summary-proof', 'zero-request-core-source-proof'),
            coreSummaryFormat: { contract: require('./core-summary-format').originalTag } } : {})
    };
    const formats = codec.declaredSchema(saved.contract, batchFamily, saved.schemaFingerprint);
    for (const [key, name] of Object.entries({ recordsFormat: family,
        provenanceFormat: family + '-provenance', receiptFormat: family + '-receipt',
        ...(family === FAMILIES[1] ? { coreStageProvenanceFormat: 'conference-source-core-correction-summary-proof',
            coreSummaryFormat: 'core-summary' } : {}) })) {
        const header = formats[key];
        if (!codec.hasValidHeader(header, name) || Object.keys(header).length !== Object.keys(recordHeaderFor(header, name)).length) {
            throw new Error('会议来源纠正清单缺少完整的子记录格式声明');
        }
    }
    return formats;
}

module.exports = { FAMILIES, locatorFamily, isLocator, hasProvenance, sourceFormatsForBatch };
