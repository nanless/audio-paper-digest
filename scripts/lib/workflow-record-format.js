'use strict';

// Format recognition only. Callers still validate the original record fields,
// hashes, files and private source handles before using any workflow state.
const codec = require('./protocol-codec');

function recordHeaderFor(value, name, tagField = 'contract') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${name} record must be an object`);
    }
    const header = codec.recordHeader(value[tagField], name, value.schemaFingerprint);
    for (const [key, expected] of Object.entries(header)) {
        if (value[key] !== expected) throw new Error(`${name} format header differs: ${key}`);
    }
    return header;
}

module.exports = { recordHeaderFor };
