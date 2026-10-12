'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {findMissingComparisonUnits} = require('../scripts/editorial-quality');
test('真实印地语稿的束宽5是条件，定性CER方向没有裸指标值', () => {
    assert.deepEqual(findMissingComparisonUnits('束搜索反而加重幻觉，所有配置下束宽 5 的字错误率都高于贪心。'), []);
    assert.deepEqual(findMissingComparisonUnits('束宽取5时，字错误率高于贪心。'), []);
});
test('束宽条件只遮自己的整数，同句错误率裸值和错误束宽表达式仍拒绝', () => {
    for (const text of [
        '束宽 5 的字错误率从 22.1 升到 24.3。',
        '束宽 5 的字错误率高于贪心，达 24.3。',
        '束宽 5.2 的字错误率高于贪心。',
        '束宽 -5 的字错误率高于贪心。',
        '字错误率 5 高于贪心。'
    ]) assert.ok(findMissingComparisonUnits(text).length, text);
});
