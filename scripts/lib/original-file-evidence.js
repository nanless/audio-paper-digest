'use strict';
// Registered original files are data evidence. Never require/evaluate their
// bytes, restore them into the checkout, or infer any workflow capability.
const fs = require('node:fs');
const path = require('node:path');
const { readRegularBytes, readGitBlob } = require('./git-file-bytes');
const ROOT = path.resolve(__dirname, '../..');
const SHA = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const controlled = relative => typeof relative === 'string'
    && /^manual\/(?:docs|scripts)\/[A-Za-z0-9_-]+\.(?:md|js)$/.test(relative);
function catalog(root) {
    const value = require('./publication-file-primitives').strictJson(
        readRegularBytes(path.join(root, 'config/original-file-evidence.json')), 'Original file evidence catalog');
    if (!value || Object.keys(value).sort().join() !== 'blobs,files'
        || !value.files || !value.blobs || Array.isArray(value.files) || Array.isArray(value.blobs)) throw new Error('Invalid original file catalog');
    for (const [relative, row] of Object.entries(value.files)) {
        if (!controlled(relative) || !SHA.test(row?.defaultSha256 || '')
            || !value.blobs[row.defaultSha256]?.paths?.includes(relative)) throw new Error('Original file lacks registered Git bytes');
    }
    for (const [sha, row] of Object.entries(value.blobs)) {
        if (!SHA.test(sha) || !OID.test(row?.blobOid || '') || !Array.isArray(row.paths) || !row.paths.length
            || new Set(row.paths).size !== row.paths.length
            || row.paths.some(relative => !controlled(relative) || !Object.hasOwn(value.files, relative))) throw new Error('Invalid original file blob');
    }
    return value;
}
function isOriginalFilePath(relative, { root = ROOT } = {}) {
    return controlled(relative) && Object.hasOwn(catalog(fs.realpathSync(root)).files, relative);
}
function readOriginalFileBytes(relative, { expectedSha256 = null, root = ROOT } = {}) {
    const base = fs.realpathSync(root), registered = catalog(base);
    if (!controlled(relative) || !Object.hasOwn(registered.files, relative)) throw new Error('Unregistered original file path');
    const sha = expectedSha256 === null ? registered.files[relative].defaultSha256 : expectedSha256;
    if (typeof sha !== 'string' || !SHA.test(sha) || !registered.blobs[sha]?.paths.includes(relative)) throw new Error('Unregistered original file path/SHA256');
    return readGitBlob(base, registered.blobs[sha].blobOid, sha);
}
module.exports = { isOriginalFilePath, readOriginalFileBytes };
