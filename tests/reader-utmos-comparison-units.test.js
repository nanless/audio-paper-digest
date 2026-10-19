'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

// 原付费失败稿的逐字句子；这是单位检测回归，不是来源或整稿资格证明。
const actual = '未胜出项是去掉属性嵌入后 UTMOS 反而微升到 3.983，但词错误率与韵律变差，说明属性嵌入提升保真但引入轻微冗余，不能单看自然度就断言无用。';
test('明确属于UTMOS的分值不冒充邻近定性错误率的百分数', () => {
    for (const sentence of [actual,
        'UTMOS 提升到 3.983，但词错误率变差。',
        'UTMOS 为 3.983，但词错误率下降。',
        'UTMOS 降至 3.983，但词错误率上升。',
        'UTMOS 提升到 1.0，但词错误率变差。',
        'UTMOS 为 5.000，但 WER 下降。',
        'UTMOS 提升到 3.983，但 WER 下降到 6.0%。',
        'UTMOS 提升到 3.983，但 CER 降低了 2 个百分点。'
    ]) assert.deepEqual(findMissingComparisonUnits(sentence), [], sentence);
});
test('否定归属、其他模型名和真正的裸错误率结果仍须核验单位', () => {
    for (const sentence of [
        'UTMOS 提升到 3.983，但 WER 下降到 6.0。',
        'UTMOS 没有提升，但 WER 提升到 3.983。',
        '若 UTMOS 提升，WER 将下降到 3.983。',
        '不能把 WER 提升到 3.983 说成 UTMOS 改善。',
        '第三方 UTMOS 模型使 WER 提升到 3.983。',
        'UTMOS（即 WER）提升到 3.983。',
        '不是 UTMOS 提升到 3.983，而是 WER 提升。',
        '并非 UTMOS 提升到 3.983，而是 CER 提升。',
        '不能把 UTMOS 提升到 3.983，而是 WER 的结果。',
        '非UTMOS 提升到 3.983，但 WER 变差。',
        '若 UTMOS 提升到 3.983，WER 将下降到 6.0。',
        '假设 UTMOS 为 3.983，CER 将降低到 2.0。',
        'UTMOS 并没有提升到 3.983，但 WER 下降。',
        'UTMOS 提升到 3.983，但 WER 不是 6.0 而是 7.0。',
        'UTMOS 提升到 3.983，但 CER 下降到 6.0，WER 上升到 7.0。',
        'UTMOS 提升到 3.983，不能认为 WER 为 6.0。',
        'NotUTMOS 提升到 3.983，但词错误率变差。',
        'UTMOS-2 提升到 3.983，但词错误率变差。',
        'UTMOSx 提升到 3.983，但词错误率变差。',
        'UTMOS_foo 提升到 3.983，但词错误率变差。',
        'UTMOS.2 提升到 3.983，但词错误率变差。',
        'UTMOS 提升到 5.01，但词错误率变差。',
        'UTMOS 提升到 30.983，但词错误率变差。'
    ]) assert.ok(findMissingComparisonUnits(sentence).length > 0, sentence);
});
test('错误率原有0到1比例规则保持原样', () => {
    for (const sentence of [
        'WER 下降到 0.060。',
        'CER 下降到 0.060。',
        'UTMOS 提升到 3.983，但 WER 下降到 0.060。'
    ]) assert.deepEqual(findMissingComparisonUnits(sentence), [], sentence);
});
