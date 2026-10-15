'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../scripts/editorial-quality');
test('完整的一致性枚举名词不被截成小数，实测小数及其诊断偏移保持严格', () => {
    for (const text of ['公平性来自三点一致：音乐和音效分开实验。',
        '两点一致性：协议与数据划分相同。', '比较条件有四点一致，仍须报告局限。',
        '协议有三点一致性。']) {
        assert.deepEqual(quality.findQuantitativeChineseNumerals(text), [], text);
        assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(text, []), text);
    }
    for (const text of ['耗时三点一秒。', '提升三点一个百分点。', '一致性得分三点一。',
        '三点一一致性得分。', '一致性来自三点一秒的处理。']) {
        assert.ok(quality.findQuantitativeChineseNumerals(text).some(issue => issue.match.startsWith('三点一')), text);
    }
    const text = '条件有三点一致：协议相同，耗时三点一秒。';
    const matches = quality.findQuantitativeChineseNumerals(text).filter(issue => issue.match === '三点一');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].index, text.lastIndexOf('三点一'));
});
