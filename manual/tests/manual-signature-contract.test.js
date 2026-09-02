'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    MANUAL_SIGNATURE_CONTRACT,
    canonicalJson,
    stableSignatureSha256,
    normalizeNfkcText
} = require('../scripts/manual-signature-contract.js');

const vectors = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'manual-stable-json-vectors.json'), 'utf8'
));

describe('Manual cross-runtime signature contract', () => {
    it('共享向量固定 stable JSON、Unicode 字节、NFKC 文本与 SHA', () => {
        assert.equal(vectors.contract, MANUAL_SIGNATURE_CONTRACT);
        for (const vector of vectors.accepted) {
            assert.equal(canonicalJson(vector.value), vector.canonicalJson, vector.name);
            assert.equal(stableSignatureSha256(vector.value), vector.sha256, vector.name);
            assert.equal(normalizeNfkcText(vector.nfkcInput), vector.nfkcText, vector.name);
        }
    });

    it('非 ASCII key 与非法数字签名对象 fail closed', () => {
        for (const vector of vectors.rejected) {
            assert.throws(() => canonicalJson(vector.value), new RegExp(vector.error), vector.name);
        }
        assert.throws(() => canonicalJson({ value: -0 }), /负零/);
        assert.throws(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }), /非安全整数/);
        assert.throws(() => canonicalJson({ value: Number.NaN }), /NaN/);
        assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /Infinity/);
    });
});
