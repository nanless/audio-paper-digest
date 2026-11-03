'use strict';
// Metadata representation only. This scope cannot produce PDF/DOM ownership,
// authenticate source files, authorize a node, or change a scientific value.
const { AsyncLocalStorage } = require('node:async_hooks');
const codec = require('./protocol-codec');
const reader = require('./reader-record-format');
const scope = new AsyncLocalStorage();
const variants = Object.freeze({
    'reader-sealed-pdf-table-grid': 'exact-official-pdf-grid',
    'reader-compiled-pdf-table-selection': 'exact-source-grid-projection',
    'pdf-grid-display-normalization': 'fixed-explicit-glyphs',
    'reader-sealed-pdf-quotes': 'unique-contiguous-official-pdf-fragment',
    'reader-pdf-quote-projection': 'collapse-whitespace-only',
    'reader-sealed-pdf-scientific-quantities': 'font-and-position-authenticated-atoms',
    'reader-pdf-adamw-schedule': 'complete-three-stage-learning-rates'
});
function header(family) {
    if (!variants[family]) throw new Error('Reader proof format family is not supported');
    return scope.getStore()?.current === false ? codec.historicalHeader(family, variants[family])
        : codec.recordHeader(codec.contract(family), family);
}
function readHeader(value, family) {
    if (!variants[family] || !codec.hasValidHeader(value, family)
        || codec.format(value.contract, family, value.schemaFingerprint) !== variants[family])
        throw new Error('Reader proof format is unknown or mixed');
    return codec.recordHeader(value.contract, family, value.schemaFingerprint);
}
function hasHeader(value, family) { try { readHeader(value, family); return true; } catch { return false; } }
function withDraftRepresentation(format, options, action) {
    reader.assertRequiredProfile(format, options);
    return scope.run({ current: format.current || options.compileCurrent === true }, action);
}
function withSavedPlanRepresentation(plan, action) {
    const options = reader.compilationOptionsForSavedPlan(plan);
    return scope.run({ current: options.compileCurrent }, action);
}
module.exports = { header, readHeader, hasHeader, withDraftRepresentation, withSavedPlanRepresentation };
