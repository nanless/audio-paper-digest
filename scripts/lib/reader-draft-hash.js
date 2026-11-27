'use strict';

// Strict leaf module for Reader draft/payload/text SHA-256 hashing.
// Zero local project imports so Reader recovery modules never need circular
// requires into reader-repair.js just to hash canonical values.

const crypto = require('node:crypto');

const hashDraft = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaText = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const shaBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sameDraftHash = (left, right) => hashDraft(left) === hashDraft(right);

module.exports = {
    hashDraft,
    shaText,
    shaBytes,
    sameDraftHash
};
