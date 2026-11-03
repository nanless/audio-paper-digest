'use strict';
const protocols = require('./protocol-codec');
const families = {
    modelText: ['model-text-sanitization', 'unicode-scalars', 'modelTextSanitizationContract', 'modelTextSanitizationSchemaFingerprint'],
    prompt: ['prompt-rendering', 'single-pass-substitution', 'promptRenderingContract', 'promptRenderingSchemaFingerprint'],
};
function original(kind) {
    const [family, variant] = families[kind];
    return protocols.historicalContract(family, variant);
}
function fields(kind, header) {
    const [, , key, fp] = families[kind];
    return { [key]: header.contract, ...(Object.hasOwn(header, 'schemaFingerprint') ? { [fp]: header.schemaFingerprint } : {}) };
}
function read(kind, acquisition) {
    const [family, , key, fp] = families[kind];
    if (!acquisition || typeof acquisition !== 'object' || !Object.hasOwn(acquisition, key)) return null;
    const header = { contract: acquisition[key], ...(Object.hasOwn(acquisition, fp) ? { schemaFingerprint: acquisition[fp] } : {}) };
    return protocols.hasValidHeader(header, family) ? header : null;
}
function saveFields(kind, previous) {
    const [family] = families[kind];
    // Existing records can still be bound by an original paid receipt. Keep
    // their exact declaration when it already identifies this same operation.
    return fields(kind, read(kind, previous) || protocols.recordHeader(family, family));
}
module.exports = { families, original, fields, read, saveFields };
