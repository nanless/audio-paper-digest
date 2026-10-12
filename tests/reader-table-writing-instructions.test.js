'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findReaderLanguageIssues } = require('../scripts/editorial-quality');

test('正文不能用列数达标或来源检查的话术介绍表格', () => {
    for (const text of [
        '下表整理步数分布，列数满足阅读需要，百分比指样本占比。',
        '下面是七子集对照，列数满足宽表要求，指标越高越好。',
        '下表把两处修复并列，列数满足五列，数字来自原句。',
        '下表整理分场景均值，列数满足比较所需的场景、试次数、两种指标与基准，数字与单位均来自原文连续句而非换算。'
    ]) {
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1, text);
        assert.equal(issues[0].code, 'reader_workflow_leakage');
        assert.equal(text.slice(issues[0].index, issues[0].index + issues[0].match.length), issues[0].match);
    }
});

test('矩阵条件、正常比较说明和原文引用不算写作检查话术', () => {
    for (const text of [
        '矩阵列数满足秩条件时，线性方程有唯一解。',
        '下表比较七个子集，分数越高越好，数据划分保持一致。',
        '> 原文：列数满足阅读需要。',
        '`列数满足五列` 是程序输出。',
        '$列数满足宽表要求$'
    ]) assert.deepEqual(findReaderLanguageIssues(text), [], text);
});
