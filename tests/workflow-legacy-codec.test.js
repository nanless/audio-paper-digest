'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const codec = require('../scripts/lib/workflow-legacy-codec');
const file = path.resolve(__dirname, '../config/workflow-historical-records.json');

test('旧筛选策略保留真实原声明、原SHA和原源码登记的未知正文SHA', () => {
    const records = codec.validateHistoricalRecords(fs.readFileSync(file));
    const hashes = codec.filterPolicyHashes();
    assert.equal(hashes.length, 5); assert.equal(new Set(hashes).size, 5);
    for (const record of records.statements) {
        assert.deepEqual(codec.filterPolicyDeclaration(record.sha256), record.declaration);
    }
    assert.equal(codec.previousKeywordPolicyHashes().length, 2);
    for (const hash of records.recordedHashOnly) {
        assert.ok(hashes.includes(hash));
        assert.throws(() => codec.filterPolicyDeclaration(hash), /missing, unknown or inconsistent/);
    }
    assert.throws(() => codec.filterPolicyDeclaration('0'.repeat(64)), /missing, unknown or inconsistent/);
    hashes.push('0'.repeat(64));
    assert.equal(codec.filterPolicyHashes().includes('0'.repeat(64)), false);
});

test('历史声明的错字节、错SHA、重复字段和损坏UTF8均拒绝', () => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.filterPolicies.statements[0].statement += ' ';
    assert.throws(() => codec.validateHistoricalRecords(Buffer.from(JSON.stringify(value))), /inconsistent/);
    const wrong = JSON.parse(fs.readFileSync(file, 'utf8'));
    wrong.filterPolicies.statements[0].sha256 = '0'.repeat(64);
    assert.throws(() => codec.validateHistoricalRecords(Buffer.from(JSON.stringify(wrong))), /inconsistent/);
    assert.throws(() => codec.validateHistoricalRecords(Buffer.from('{"filterPolicies":{},"filterPolicies":{}}')), /重复字段/);
    assert.throws(() => codec.validateHistoricalRecords(Buffer.from([0xc3, 0x28])), /UTF-8/);
});
