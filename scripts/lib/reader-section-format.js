'use strict';
const codec = require('./protocol-codec');
const equal = require('node:util').isDeepStrictEqual;
const family = ordered => ordered ? 'reader-section-body-index-groups' : 'reader-section-index-groups';
const currentHeader = ordered => codec.recordHeader(codec.contract(family(ordered)), family(ordered));
function contextHeader(context, ordered = false) {
    const name = family(ordered), raw = context?.sectionGroupPlanContract;
    const declared = { contract: raw, ...(Object.hasOwn(context || {}, 'sectionGroupPlanSchemaFingerprint')
        ? { schemaFingerprint: context.sectionGroupPlanSchemaFingerprint } : {}) };
    // Original context carried only the tag; its numeric wire member comes
    // exclusively from the registered original header.
    const expected = codec.recordHeader(raw, name, context?.sectionGroupPlanSchemaFingerprint);
    if (Object.hasOwn(expected, 'version')) declared.version = expected.version;
    if (!codec.hasValidHeader(declared, name)) throw new Error('Section plan context format differs');
    return expected;
}
function isContext(context, ordered = false) {
    try { contextHeader(context, ordered); return true; } catch { return false; }
}
function matches(plan, context, ordered = false) {
    try { return codec.hasValidHeader(plan, family(ordered))
        && equal(codec.recordHeader(plan.contract, family(ordered), plan.schemaFingerprint), contextHeader(context, ordered));
    } catch { return false; }
}
function contextFields(ordered = false) {
    const header = currentHeader(ordered);
    return { sectionGroupPlanContract: header.contract, sectionGroupPlanSchemaFingerprint: header.schemaFingerprint };
}
function simpleHeader(context) {
    const actual = contextHeader(context, true);
    return Object.hasOwn(actual, 'schemaFingerprint') ? currentHeader(false)
        : codec.historicalHeader(family(false), 'adjacent-section-indexes');
}
function proofHeader(context, ordered = false) {
    const actual = contextHeader(context, ordered);
    return Object.hasOwn(actual, 'schemaFingerprint') ? actual : { contract: actual.contract };
}
function patchHeader(context) {
    const actual = contextHeader(context, isContext(context, true));
    return Object.hasOwn(actual, 'schemaFingerprint') ? codec.recordHeader(codec.contract('reader-node-patch'), 'reader-node-patch')
        : codec.historicalHeader('reader-node-patch', 'bounded-existing-nodes');
}
module.exports = { currentHeader, contextHeader, isContext, matches, contextFields, simpleHeader, proofHeader, patchHeader };
