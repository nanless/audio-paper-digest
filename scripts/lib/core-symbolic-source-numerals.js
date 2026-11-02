'use strict';

// A formal construction may contain numbered definitions, equation labels and
// indexed sets. Remove only those typed numerals from the quantitative-result
// view; measured values in the same sentence must remain available to the
// normal metric, attribution and observation checks.
function stripDefinedGeometryNumerals(text) {
    const value = String(text || '')
        .replace(/([A-Za-z])_\{\d+\}/gu, '$1_{index}')
        .replace(/([A-Za-z])_(\d+)(?![A-Za-z0-9])/gu, '$1_{index}')
        .replace(/(^|[,\n])\s*(?:and\s+)?[1-9]\d*\.\s*(?=∀|∃|\\(?:forall|exists)\b)/gu, '$1 [item] ');
    if (!/\b(?:patterns?|occurrences?|transformation\s+class(?:es)?|ordered\s+(?:pairs?|triples?)|parameter\s+vectors?)\b/iu.test(value)
        || !/\b(?:defin(?:e|ed|ition)|suppose|given|encod(?:e|ing)|constraints?)\b/iu.test(value)
        || !/\\(?:mathcal|mathbf|subset|in\b|lambda|forall|langle)/u.test(value)
        || /\b(?:measured|observed|achieved|accuracy|latency|throughput|benchmark|evaluation|experiments?|test\s+(?:set|dataset))\b/iu.test(value)) return value;
    return value
        .replace(/\b(Definition)\s+[1-9]\d*\b/giu, '$1 [label]')
        .replace(/\b(Def\.)\s*[1-9]\d*\b/giu, '$1 [label]')
        // A label follows a TeX spacing command at the end of an extracted
        // formula. Parenthesised measurements such as (80) or (12) ms remain.
        .replace(/(\\,[.,]\s*)\([1-9]\d*\)(?=\s|$)/gu, '$1[equation]');
}

module.exports = { stripDefinedGeometryNumerals };
