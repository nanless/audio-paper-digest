'use strict';
const codec = require('./protocol-codec');
const equal = require('node:util').isDeepStrictEqual;
const FAMILY = 'reader-repair-request-diagnostics';
const hasDiagnosticFormat = value => codec.hasValidHeader(value, FAMILY);
function diagnosticHeader(value = null) {
    if (value === null) return codec.recordHeader(codec.contract(FAMILY), FAMILY);
    if (!hasDiagnosticFormat(value)) throw new Error('Reader diagnostic format is unknown or mixed');
    return codec.recordHeader(value.contract, FAMILY, value.schemaFingerprint);
}
function sameDiagnosticFormat(request, response) {
    try { return equal(diagnosticHeader(request), diagnosticHeader(response)); } catch { return false; }
}
module.exports = { hasDiagnosticFormat, diagnosticHeader, sameDiagnosticFormat };
