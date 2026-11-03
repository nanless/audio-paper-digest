'use strict';

const codec = require('./protocol-codec');
const TERMINOLOGY = 'daily-reader-signed-terminology-correction';
const FACT = 'daily-reader-signed-fact-correction';

function header(value) {
    for (const family of [TERMINOLOGY, FACT]) {
        if (codec.hasValidHeader(value, family)) {
            return codec.recordHeader(value.contract, family, value.schemaFingerprint);
        }
    }
    return null;
}

const isTerminology = value => codec.hasValidHeader(value, TERMINOLOGY);
const isFact = value => codec.hasValidHeader(value, FACT);
function sameFormat(left, right) {
    const a = header(left), b = header(right);
    return Boolean(a && b && a.contract === b.contract && a.schemaFingerprint === b.schemaFingerprint);
}

module.exports = { TERMINOLOGY, FACT, header, isTerminology, isFact, sameFormat };
