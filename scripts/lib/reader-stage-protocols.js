'use strict';
// Format metadata only. These helpers never replace article, source, paid-input,
// completion-index, PDF/DOM or CAS verification performed by their callers.
const { isDeepStrictEqual: equal } = require('node:util');
const codec = require('./protocol-codec');
const formats = require('./reader-record-format');
const legacy = require('./reader-legacy-records.json');
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
freeze(legacy);
const roles = Object.freeze({ ...legacy.pipelineRoles });
const flats = Object.freeze({ ...legacy.flatStageFields });
const flatFieldFor = role => Object.keys(flats).find(field => flats[field] === role);
function header(role, current = true) {
    if (!roles[role]) throw new Error('Reader 协议角色未登记');
    return current ? codec.recordHeader(codec.contract(roles[role]), roles[role])
        : structuredClone(legacy.originalHeaders[role]);
}
function isHeader(value, role) {
    if (role === 'article') { try { return formats.isIntegratedPlan(value); } catch { return false; } }
    return codec.hasValidHeader(value, roles[role])
        && codec.format(value.contract, roles[role], value.schemaFingerprint) === 'integrated-source-bound';
}
function sourceHeader(plan) {
    const value = { contract: plan?.sourceBindingsContract,
        ...(Object.hasOwn(plan || {}, 'sourceBindingsSchemaFingerprint')
            ? { schemaFingerprint: plan.sourceBindingsSchemaFingerprint } : {}) };
    if (!isHeader(value, 'sourceBindings')) throw new Error('Reader 来源绑定格式未登记');
    return codec.recordHeader(value.contract, roles.sourceBindings, value.schemaFingerprint);
}
function currentPipeline(plan = null, metrics = null) {
    const values = Object.fromEntries(Object.keys(roles).map(role => [role, header(role)]));
    if (plan) { values.article = formats.storedPlanHeader(plan); values.sourceBindings = sourceHeader(plan); }
    if (metrics) {
        if (!isHeader(metrics, 'qualityMetrics')) throw new Error('Reader 质量记录格式未登记');
        values.qualityMetrics = codec.recordHeader(metrics.contract, roles.qualityMetrics, metrics.schemaFingerprint);
    }
    return codec.record('reader-pipeline', values);
}
function pipeline(stage) {
    if (!Object.hasOwn(stage || {}, 'readerProtocols')) return null;
    const value = stage.readerProtocols;
    if (!codec.hasValidHeader(value, 'reader-pipeline')
        || codec.format(value.contract, 'reader-pipeline', value.schemaFingerprint) !== 'integrated-source-bound'
        || Object.keys(value).sort().join() !== [...Object.keys(codec.recordHeader(value.contract,
            'reader-pipeline', value.schemaFingerprint)), ...Object.keys(roles)].sort().join()
        || Object.keys(flats).some(field => Object.hasOwn(stage, field))) throw new Error('Reader 当前和原格式声明混用或缺项');
    for (const role of Object.keys(roles)) {
        const declared = value[role];
        if (!isHeader(declared, role)) throw new Error(`Reader ${role} 格式声明无效`);
        const expected = role === 'article' ? formats.storedPlanHeader(declared)
            : codec.recordHeader(declared.contract, roles[role], declared.schemaFingerprint);
        if (!equal(declared, expected)) throw new Error(`Reader ${role} 声明包含额外字段`);
    }
    return value;
}
function stageMatches(stage, role) {
    try {
        const current = pipeline(stage);
        if (role === 'qualityMetrics') {
            if (!isHeader(stage?.qualityMetrics, role)) return false;
            const actual = codec.recordHeader(stage.qualityMetrics.contract, roles[role], stage.qualityMetrics.schemaFingerprint);
            if (current) return equal(current[role], actual);
            return stage?.[flatFieldFor(role)] === legacy.originalHeaders[role].contract
                && equal(actual, legacy.originalHeaders[role]);
        }
        if (current) return isHeader(current[role], role);
        const field = flatFieldFor(role);
        return Boolean(field && stage?.[field] === legacy.originalHeaders[role].contract);
    } catch { return false; }
}
function validateBindings(contracts, stage, plan) {
    if (!formats.isIntegratedPlan(plan)) return false;
    try {
        const current = pipeline(stage), planHeader = formats.storedPlanHeader(plan), bound = sourceHeader(plan);
        if (contracts?.apiReaderArticle !== planHeader.contract
            || contracts?.apiReaderSourceBindings !== bound.contract) return false;
        return current ? equal(current.article, planHeader) && equal(current.sourceBindings, bound)
            : equal(planHeader, legacy.originalHeaders.article)
                && equal(bound, legacy.originalHeaders.sourceBindings)
                && stageMatches(stage, 'sourceBindings');
    } catch { return false; }
}
function stageFields(plan, metrics) { return { readerProtocols: currentPipeline(plan, metrics) }; }
function fingerprintFields(declaredStage = null) {
    const mode = require('./reader-content-mode').fields('source-only');
    if (declaredStage && Object.hasOwn(declaredStage, 'readerProtocols'))
        return { readerProtocols: structuredClone(pipeline(declaredStage)), ...mode };
    return declaredStage?.status === 'complete' ? structuredClone(legacy.originalFingerprintFields)
        : { readerProtocols: currentPipeline(), ...mode };
}
module.exports = { header, sourceHeader, isHeader, currentPipeline, pipeline, stageMatches,
    validateBindings, stageFields, fingerprintFields, flatFields: Object.freeze(Object.keys(flats)),
    originalFingerprintFields: () => structuredClone(legacy.originalFingerprintFields),
    originalIdentityFields: Object.freeze({ ...legacy.originalIdentityFields }) };
