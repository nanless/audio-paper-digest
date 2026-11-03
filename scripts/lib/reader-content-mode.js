'use strict';
// A mode declaration does not establish source scope, signed parent, permission,
// request budget or paid-input continuity; those are independently rechecked.
const codec = require('./protocol-codec');
const families = Object.freeze({
    'source-only': 'reader-source-only',
    'signed-revision': 'reader-source-signed-revision',
    'operator-revision': 'reader-source-operator-revision',
    'conference-core-correction': 'conference-reader-source-core-correction',
    'conference-resource-correction': 'conference-reader-source-resource-correction'
});
const keys = Object.freeze(['contentMode', 'contentModeSchemaFingerprint']);
function family(mode) {
    if (!Object.hasOwn(families, mode)) throw new Error('Reader content mode is unknown');
    return families[mode];
}
function fields(mode) {
    const name = family(mode);
    return { contentMode: codec.contract(name), contentModeSchemaFingerprint: codec.schemaFingerprint(name) };
}
function originalInputDomain(mode) { return codec.historicalContract(family(mode), mode); }
function modeOf(record) {
    const header = { contract: record?.contentMode,
        ...(Object.hasOwn(record || {}, keys[1]) ? { schemaFingerprint: record[keys[1]] } : {}) };
    for (const [mode, name] of Object.entries(families)) {
        if (codec.hasValidHeader(header, name) && codec.format(header.contract, name, header.schemaFingerprint) === mode) return mode;
    }
    return null;
}
const is = (record, mode) => modeOf(record) === mode;
const sameMode = (left, right) => Boolean(modeOf(left) && modeOf(left) === modeOf(right));
function sameDeclaration(left, right) {
    return Boolean(modeOf(left) && modeOf(right)) && keys.every(key =>
        Object.hasOwn(left, key) === Object.hasOwn(right, key) && left[key] === right[key]);
}
function validForSavedPlan(stage, plan) {
    if (keys.some(key => Object.hasOwn(stage || {}, key))) return modeOf(stage) !== null;
    return !codec.isCurrentHeader(plan, 'beginner-researcher');
}
module.exports = { fields, originalInputDomain, modeOf, is, sameMode, sameDeclaration, validForSavedPlan, keys };
