'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderProseFormatting } = require('../scripts/deep-analyzer');

function normalizeReportedCount(text, surface = '三种') {
    return normalizeReaderProseFormatting(text, [{ code: 'quantitative_chinese_numeral',
        match: surface, index: text.indexOf(surface), line: 1, reason: 'measured_simple_integer' }]);
}

test('真实材料比例后的独立计数转换，比例与其余正文不变', () => {
    const text = '材料对在 3:7、5:5、7:3 三种比例下的混合。';
    assert.equal(normalizeReportedCount(text), '材料对在 3:7、5:5、7:3 3 种比例下的混合。');
    assert.equal(normalizeReportedCount('已有 24 三种条件。'), '已有 24 3 种条件。');
    assert.equal(normalizeReportedCount(text), normalizeReportedCount(normalizeReportedCount(text)));
});

test('真正相邻的中文后缀仍不转换，不把较长数字拆开', () => {
    for (const text of ['7:3三种比例。', '13三种比例。', '十三种比例。', '二十三种比例。']) {
        assert.equal(normalizeReportedCount(text), text);
    }
    assert.equal(normalizeReportedCount('十三种比例，另有 7:3 三种比例。'),
        '十三种比例，另有 7:3 3 种比例。');
});

test('引语、代码、公式及无诊断正文不跨保护范围转换', () => {
    const text = '原句“7:3 三种比例”，代码 `7:3 三种`，公式 $7:3 三种$。';
    assert.equal(normalizeReportedCount(text), normalizeReaderProseFormatting(text));
    assert.equal(normalizeReaderProseFormatting('材料对在 7:3 三种比例下混合。'),
        '材料对在 7:3 三种比例下混合。');
    assert.equal(normalizeReportedCount('7:3 三种比例。\n> 原文：7:3 三种比例。'),
        '7:3 3 种比例。\n> 原文：7:3 三种比例。');
});
