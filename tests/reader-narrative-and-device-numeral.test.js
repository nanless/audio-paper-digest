'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../scripts/editorial-quality');
const issue = match => [{ code: 'quantitative_chinese_numeral', match }];

test('另一个条件改动是指代，普通条件计数仍检查', () => {
    assert.deepEqual(quality.findQuantitativeChineseNumerals('另一个条件改动是提示词补写。'), []);
    for (const sentence of ['在一个条件下测量延迟。', '另一个条件包含四个样本。', '共有一个条件。']) {
        assert.ok(quality.findQuantitativeChineseNumerals(sentence).length, sentence);
    }
});

test('仅已绑定的型号后核数可机械显示为阿拉伯整数', () => {
    const original = '16GB树莓派5四核Cortex-A76纯中央处理器。';
    assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(original, issue('四核')),
        '16GB树莓派5 4 核Cortex-A76纯中央处理器。');
    assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(original, []), original);
    for (const sentence of ['54核Cortex-A76。', '5四核模型。', '树莓派5四核未知型号。',
        '十四核CPU。', '负四核CPU。', '5.4四核Cortex-A76。']) {
        assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(sentence, issue('四核')), sentence);
    }
});

test('源表引文代码仍逐字保留，连续数字和真实中文量值仍拒', () => {
    const original = '> 树莓派5四核Cortex-A76\n\n`树莓派5四核Cortex-A76`\n\n| 型号 | 核数 |\n| --- | --- |\n| 树莓派5 | 四核 |';
    assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(original, issue('四核')), original);
    for (const sentence of ['十五毫秒。', '百分之十八。', '四核CPU。']) {
        assert.ok(quality.findQuantitativeChineseNumerals(sentence).length, sentence);
    }
});
