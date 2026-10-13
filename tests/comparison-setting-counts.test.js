'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

test('候选库大小、链长和流数不冒充同句的百分比结果', () => {
    for (const text of [
        '测量对象是同一 1024 候选库下链长从 1 到 8 的双向召回率，比较方法是固定模型只改变渲染链长，条件一致，指标方向是召回率越高越好。',
        '论文报告 4 流在未见类达到较高的准确率与两种 F1，并在事件级 F1 上领先微调基线较多，同时见类与全部划分也同向提升。'
    ]) assert.deepEqual(findMissingComparisonUnits(text), [], text);
});

test('设置附近的实际指标裸值与缺失单位仍须拒绝', () => {
    for (const text of [
        '在 1024 候选库下，准确率从 80 提高到 90。',
        '链长从 1 到 8，准确率从 80 提高到 90。',
        '4 流模型的准确率从 80 提高到 90。',
        '准确率从 4 提高到 8。',
        '链长从 1 到 8，错误率是 5.23 对 5.97%。'
    ]) assert.ok(findMissingComparisonUnits(text).length, text);
});
