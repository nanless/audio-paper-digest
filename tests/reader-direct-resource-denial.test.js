'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const source = 'The article cites third-party resources but establishes no current author model release.';
const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: crypto.createHash('sha256').update(source).digest('hex'), resources: [] };
const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
const issues = text => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] }, identity, source);
// Exact paid VoxLock phrase from candidate a7caa9bf…; this grammar fixture is
// not a source/publication capability. The explicit real-evidence test checks
// the complete original envelope and original resource identity separately.
const actual = '因此不能表述为作者模型已开源或作者资源当前可用。';
test('无宾语的闭合直接否定覆盖其资源主张，明确归属与并列范围逐项保持', () => {
    for (const text of [actual, '不能表述为作者模型已开源。', '不应直接写成本文代码已公开或作者模型当前可下载。']) assert.deepEqual(issues(text), [], text);
});
test('肯定、邻句肯定、双重否定、否定撤回与引述均保留拒绝', () => {
    for (const text of [
        '作者模型已开源或作者资源当前可用。',
        actual + '作者模型已开源。',
        '不能表述为作者模型已开源；但作者模型已开源。',
        '并非不能表述为作者模型已开源。',
        '不能否认作者模型已开源。',
        '不能表述为作者模型已开源的说法不成立。',
        '不能表述为作者模型已开源，上述否定已经被撤销。',
        '不能表述为作者模型已开源；上述限定已经被撤销。',
        '有人引用“不能表述为作者模型已开源”。',
        '不能表述为作者模型已开源的事实不存在。'
    ]) assert.ok(issues(text).length, text);
});
test('真实后续三件事列表只免除闭合待验证概念，归属/计数/独立肯定/撤回仍拒绝', () => {
    const list = '模型权重可获取、代码可运行、系统可实时运行是三件独立的事，需要分别验证。';
    assert.deepEqual(issues(list), []);
    for (const text of ['本文提供的' + list, list.replace('三件', '两件'), list.replace('代码可运行', '模型权重可获取'),
        list.replace('需要分别验证', '已经全部验证'), list + '作者模型已开源。',
        '“' + list + '”这一说法不成立。', list + '上述限定已经被撤销。']) assert.ok(issues(text).length, text);
});
