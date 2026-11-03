'use strict';
const formats = require('./protocol-codec');
function current(name) {
    return formats.recordHeader(name, name);
}
function profile(name, value) {
    const header = typeof value === 'string' ? { contract: value } : value;
    if (!header || typeof header !== 'object' || Array.isArray(header)
        || !['contract', 'contract,schemaFingerprint'].includes(Object.keys(header).sort().join(','))
        || !formats.hasValidHeader(header, name)) return null;
    return formats.format(header.contract, name, header.schemaFingerprint);
}
const MANIFEST = 'analysis-stage-manifest';
function manifestHeader(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const field = Object.hasOwn(value, 'version') ? 'version' : 'contract';
    if (!formats.hasValidHeader(value, MANIFEST, field)) return null;
    return formats.recordHeader(value[field], MANIFEST, value.schemaFingerprint);
}
function hasOriginalManifestHeader(value) {
    return Object.hasOwn(manifestHeader(value) || {}, 'version');
}
const original = formats.historicalContract;
module.exports = { current, profile, original, MANIFEST, manifestHeader, hasOriginalManifestHeader };
