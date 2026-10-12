'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findQuantitativeChineseNumerals } = require('../scripts/editorial-quality');
const { normalizeReaderProseFormatting } = require('../scripts/deep-analyzer');

function normalize(text) {
    const issues = findQuantitativeChineseNumerals(text)
        .map(issue => ({ ...issue, code: 'quantitative_chinese_numeral' }));
    return normalizeReaderProseFormatting(text, issues);
}

test('较短百分数先出现时不截断后面的完整百分数', () => {
    assert.equal(normalize('第一组占百分之十，第二组占百分之十八。'),
        '第一组占 10%，第二组占 18%。');
    assert.equal(normalize('第一组占百分之一，第二组占百分之一点八，第三组占百分之一百。'),
        '第一组占 1%，第二组占 1.8%，第三组占 100%。');
});

test('百分数先后顺序与重复出现不改变数值', () => {
    assert.equal(normalize('百分之十八、百分之十、百分之十八。'), '18%、10%、18%。');
    const once = normalize('占百分之十；另占百分之十八。');
    assert.equal(normalize(once), once);
});

test('只有短数字诊断时保留较长数和原文保护区域', () => {
    const text = '百分之十、百分之十八、百分之十点五。\n> 原文：百分之十、百分之十八。';
    const issues = [{ code: 'quantitative_chinese_numeral', match: '百分之十', index: 0, line: 1 }];
    assert.equal(normalizeReaderProseFormatting(text, issues),
        '10%、百分之十八、百分之十点五。\n> 原文：百分之十、百分之十八。');
    assert.equal(normalize('正文占百分之十，代码 `百分之十八`，公式 $百分之十八$，引文“百分之十八”。'),
        '正文占 10%，代码 `百分之十八`，公式 $百分之十八$，引文“百分之十八”。');
});

test('真实稿件的一成八不被另一处一成诊断改成百分之十', () => {
    const text = '测试集约占一成，留出集约占一成八。';
    assert.equal(normalize(text), '测试集约占 10%，留出集约占一成八。');
    for (const suffix of ['八', '五', '8', '半', '点五']) {
        const sample = `原比例二成，另有二成${suffix}。`;
        assert.equal(normalizeReaderProseFormatting(sample, [{ code: 'quantitative_chinese_numeral', match: '二成' }]),
            suffix === '8' ? '原比例 20%，另有二成 8。' : `原比例 20%，另有二成${suffix}。`);
    }
    assert.equal(normalize('约一成；引文“一成八”；代码 `一成八`；公式 $一成八$。'),
        '约 10%；引文“一成八”；代码 `一成八`；公式 $一成八$。');
});
