'use strict';
// Pure encoding selection. No marker or header grants a request, source scope,
// patch target, fee allowance or normal completion.
const codec = require('./protocol-codec');
const { isDeepStrictEqual: equal } = require('node:util');
const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const original = require('./reader-legacy-records.json').ordinal;
const WIRE = original.wireFamily, RECORD = original.recordFamily, COMPILATION = original.compilationFamily;
const wireHeader = () => codec.recordHeader(codec.contract(WIRE), WIRE);
const oldWireHeader = () => codec.historicalHeader(WIRE, 'bounded-existing-nodes');
function isWire(value) { return codec.hasValidHeader(value, WIRE); }
function readWireHeader(value) {
    if (!isWire(value)) throw new Error('Ordinal request format is unknown or mixed');
    return codec.recordHeader(value.contract, WIRE, value.schemaFingerprint);
}
const isCurrentWire = value => codec.isCurrentHeader(value, WIRE);
function selectedHeader(family, request) {
    readWireHeader(request);
    return isCurrentWire(request) ? codec.recordHeader(codec.contract(family), family)
        : codec.historicalHeader(family, family === RECORD ? 'bound-request-evidence' : 'source-bound-compilation');
}
function isRecord(value, request) {
    return codec.hasValidHeader(value, RECORD)
        && equal(codec.recordHeader(value.contract, RECORD, value.schemaFingerprint), selectedHeader(RECORD, request));
}
function isCompilation(value, request = null) {
    return codec.hasValidHeader(value, COMPILATION) && (!request
        || equal(codec.recordHeader(value.contract, COMPILATION, value.schemaFingerprint), selectedHeader(COMPILATION, request)));
}
function compilationHeader(request = null) {
    return request ? selectedHeader(COMPILATION, request)
        : codec.recordHeader(codec.contract(COMPILATION), COMPILATION);
}
function standardPatchHeader(request) {
    readWireHeader(request);
    return isCurrentWire(request) ? codec.recordHeader(codec.contract(original.patchFamily), original.patchFamily)
        : codec.historicalHeader(original.patchFamily, 'bounded-existing-nodes');
}
function template(request = wireHeader()) {
    readWireHeader(request);
    if (sha(original.template) !== original.templateSha256) throw new Error('Original ordinal template bytes differ');
    if (!isCurrentWire(request)) return original.template;
    return original.template.replace(original.templateHeaderPrefix, JSON.stringify(wireHeader()).slice(0, -1) + ',');
}
function tokenDomain(request) {
    const header = readWireHeader(request);
    return isCurrentWire(request) ? header : header.contract;
}
function completionWireHeader(completion) {
    if (!isCompilation(completion)) throw new Error('Ordinal completion format differs');
    if (!codec.isCurrentHeader(completion, COMPILATION)) return oldWireHeader();
    if (!isCurrentWire(completion.ordinalProtocol)
        || !equal(completion.ordinalProtocol, wireHeader())) throw new Error('Current completion lacks its exact request format');
    return completion.ordinalProtocol;
}
function matchesStage(stage, manifest, completion) {
    const header = completionWireHeader(completion);
    const actual = { contract: stage?.ordinalPatchContract,
        ...(Object.hasOwn(stage || {}, 'ordinalPatchSchemaFingerprint') ? { schemaFingerprint: stage.ordinalPatchSchemaFingerprint } : {}),
        ...(!Object.hasOwn(header, 'schemaFingerprint') ? { version: header.version } : {}) };
    return equal(actual, header) && manifest?.contracts?.readerTargetOrdinalPatch === header.contract;
}
module.exports = { WIRE, RECORD, COMPILATION, wireHeader, oldWireHeader, readWireHeader, isWire, isCurrentWire,
    recordHeader: request => selectedHeader(RECORD, request), isRecord, isCompilation, compilationHeader,
    standardPatchHeader, template, templateSha: request => sha(template(request)), tokenDomain,
    completionWireHeader, matchesStage };
