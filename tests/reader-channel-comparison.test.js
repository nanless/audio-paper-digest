'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

test('真实双通道与六通道定性比较不被当成缺少百分号', () => {
    assert.deepEqual(findMissingComparisonUnits('UltraM2M 在每种后端与通道数下都进一步降低真实测试集词错误率，在 2 通道与 6 通道输入下还提高 DNSMOS。'), []);
    assert.deepEqual(findMissingComparisonUnits('2通道输入降低 WER，6通道输入继续降低 WER。'), []);
});

test('通道设置不能掩盖同句真正缺单位的结果', () => {
    for (const text of [
        '2 通道输入将 WER 从 24.5 降到 18.2。',
        '2 通道与 6 通道的 CER 从 4.18 降低到 3.75。',
        '在 6通道输入下错误率从 24.5 降至 18.2。'
    ]) assert.ok(findMissingComparisonUnits(text).some(issue => issue.reason === 'percentage_metric_delta_without_unit'), text);
    assert.deepEqual(findMissingComparisonUnits('2 通道输入将 WER 从 24.5% 降到 18.2%。'), []);
});

test('不把负数小数或不明标识里的片段当成完整整数通道数', () => {
    for (const text of ['-2通道输入降低 WER。', '2.5通道输入降低 WER。',
        '负2通道输入降低 WER。', '− 2通道输入降低 WER。', '采用 - 2通道输入降低 WER。',
        '二2通道输入降低 WER。']) {
        assert.ok(findMissingComparisonUnits(text).some(issue => issue.reason === 'percentage_metric_delta_without_unit'), text);
    }
    assert.deepEqual(findMissingComparisonUnits('- 2通道输入降低 WER。'), []);
});
