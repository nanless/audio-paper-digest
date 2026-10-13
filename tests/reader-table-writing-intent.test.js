'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findReaderLanguageIssues } = require('../scripts/editorial-quality');

function leaks(text) {
    return findReaderLanguageIssues(text).filter(issue => issue.code === 'reader_workflow_leakage');
}

test('明确表后未来写作安排及解释要求不进入正文', () => {
    const sentences = [
        '指标方向是召回率越高越好，表后解释将说明分工与代价。',
        '同一效果内参数检索，表后解释将指出音频端的短板。',
        '表后解释需要回到机制。T5 在保留 2 位小数时表现更好。',
        '表后解释要强调这不是编码器的胜负表。',
        '表后解释要分清两个事实。第一，只测混响。',
        '表后解释要避免夸大。R@1 波动为 4.9 个百分点。'
    ];
    for (const sentence of sentences) {
        assert.equal(leaks(sentence).length, 1, sentence);
    }
});

test('作者已完成的解释和真实结果限制仍保留', () => {
    for (const sentence of [
        '作者在表后解释了音频前端的短板。',
        '表后解释指出音频前端的短板。',
        '研究者要避免夸大：该结果只覆盖混响。',
        '该表的解释强调这不是编码器的胜负表。'
    ]) {
        assert.equal(leaks(sentence).length, 0, sentence);
    }
});

test('来源引文、代码、表格单元和公式不被正文诊断改写', () => {
    for (const text of [
        '> 表后解释要避免夸大。',
        '原文写道：“表后解释将说明分工。”',
        '```text\n表后解释要强调结果。\n```',
        '| 原句 | 数值 |\n| --- | --- |\n| 表后解释要分清两个事实 | 4.9 |',
        '$表后解释要强调$'
    ]) {
        assert.equal(leaks(text).length, 0, text);
    }
});
