'use strict';
// Encoding equivalence only. The normal recovery reader still authenticates
// source scope, actual archived bytes, paid requests, counters and CAS.
const { isDeepStrictEqual: equal } = require('node:util');
const codec = require('./protocol-codec');
const legacy = require('./reader-legacy-records.json');
const content = require('./reader-content-mode');
const ENCODING = Object.freeze([...Object.keys(legacy.originalIdentityFields), 'readerIdentity']);
const FIELDS = Object.freeze([...ENCODING, ...content.keys, 'draftOrderSchemaFingerprint']);
function header() { return codec.recordHeader(codec.contract('reader-candidate'), 'reader-candidate'); }
function isEnvelope(value) {
    return codec.hasValidHeader(value, 'reader-candidate',
        value && Object.hasOwn(value, 'contract') ? 'contract' : 'version');
}
function identityFields() {
    return { readerIdentity: codec.record('reader-candidate-identity', {
        article: codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher'),
        sourceBindings: codec.recordHeader(codec.contract('api-reader-source-bindings'), 'api-reader-source-bindings'),
        repair: header()
    }) };
}
function semanticIdentity(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || Object.hasOwn(identity, 'readerIdentityProfile') || Object.hasOwn(identity, 'readerContentModeProfile'))
        throw new Error('Reader identity shape differs');
    const mode = content.modeOf(identity);
    if (content.keys.some(key => Object.hasOwn(identity, key)) && !mode) throw new Error('Reader content mode declaration differs');
    if (identity.draftOrderContract === 'reader-draft-order' || Object.hasOwn(identity, 'draftOrderSchemaFingerprint')) {
        if (!codec.hasValidHeader({ contract: identity.draftOrderContract,
            schemaFingerprint: identity.draftOrderSchemaFingerprint }, 'reader-draft-order')) {
            throw new Error('Reader draft-order declaration differs');
        }
    }
    const result = Object.fromEntries(Object.entries(identity).filter(([key]) => !FIELDS.includes(key)));
    if (mode) result.readerContentModeProfile = mode;
    if (!ENCODING.some(key => Object.hasOwn(identity, key))) return result;
    const old = Object.keys(legacy.originalIdentityFields).every(key =>
        Object.hasOwn(identity, key) && identity[key] === legacy.originalIdentityFields[key])
        && !Object.hasOwn(identity, 'readerIdentity');
    const current = !Object.keys(legacy.originalIdentityFields).some(key => Object.hasOwn(identity, key))
        && equal(identity.readerIdentity, identityFields().readerIdentity);
    if (!old && !current) throw new Error('Reader identity format is not an exact supported encoding');
    result.readerIdentityProfile = 'integrated-source-bound-failed-candidate';
    return result;
}
module.exports = { header, isEnvelope, identityFields, semanticIdentity, identityFormatFields: FIELDS };
