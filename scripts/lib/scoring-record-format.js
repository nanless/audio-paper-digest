'use strict';
const formats = require('./protocol-codec');
const definitions = Object.freeze({
    audit: ['api-scoring-audit', 'scoringContract', 'scoringSchemaFingerprint'],
    resource: ['scoring-source-release-declarations', 'resourceNormalizationContract', 'resourceNormalizationSchemaFingerprint'],
    request: ['scoring-request-format', 'requestFormatContract', 'requestFormatSchemaFingerprint'],
    caps: ['evidence-caps', 'capRulesContract', 'capRulesSchemaFingerprint']
});
function readHeader(stage, kind = 'audit') {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return null;
    if (['contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion'].some(field => Object.hasOwn(stage, field))) return null;
    const [family, field, fingerprint] = definitions[kind] || [];
    if (!family) throw new Error('评分格式用途未知');
    let tag = field;
    if (kind === 'caps' && Object.hasOwn(stage, 'capRulesVersion')) {
        if (Object.hasOwn(stage, field) || Object.hasOwn(stage, fingerprint)) return null;
        tag = 'capRulesVersion';
    }
    if (!Object.hasOwn(stage, tag)) return null;
    const value = { contract: stage[tag],
        ...(Object.hasOwn(stage, fingerprint) ? { schemaFingerprint: stage[fingerprint] } : {}) };
    return formats.hasValidHeader(value, family) ? value : null;
}
function currentStageFields() {
    return Object.fromEntries(Object.values(definitions).flatMap(([family, field, fingerprint]) => {
        const header = formats.recordHeader(family, family);
        return [[field, header.contract], [fingerprint, header.schemaFingerprint]];
    }));
}
function hasScoringAuditFormat(stage) { return readHeader(stage, 'audit') !== null; }
function hasScoringStageFormats(stage) {
    const headers = Object.keys(definitions).map(kind => readHeader(stage, kind));
    return headers.every(Boolean) && new Set(headers.map(header => Object.hasOwn(header, 'schemaFingerprint'))).size === 1;
}
const EVIDENCE_PROFILE = 'scoring-evidence-profile';
function evidenceProfileHeader(value) {
    const field = Object.hasOwn(value || {}, 'version') ? 'version' : 'contract';
    if (!formats.hasValidHeader(value, EVIDENCE_PROFILE, field)) return null;
    return formats.recordHeader(value[field], EVIDENCE_PROFILE, value.schemaFingerprint);
}
function currentEvidenceProfileHeader() {
    return formats.recordHeader(EVIDENCE_PROFILE, EVIDENCE_PROFILE);
}
module.exports = { evidenceProfileHeader, currentEvidenceProfileHeader, readHeader, currentStageFields, hasScoringAuditFormat, hasScoringStageFormats };
