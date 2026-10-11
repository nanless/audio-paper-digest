'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const sourceText = 'On the public test set, our speech model UAR is 0.119 higher than the animal baseline UAR. UAR means unweighted average recall.';
function issue(result) {
    const analysis = validAnalysisText();
    assert.equal(analysis.split(original).length - 1, 1);
    return contract.validateCoreSummarySemanticContract(analysis.replace(original, result), { sourceText });
}
test('UAR实测比字比较保留对象、数值与方向', () => {
    for (const result of [
        '在公开测试集的相同协议下，本文模型UAR比动物基线模型UAR高0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，语音模型比动物基线模型 UAR 高 +0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，本文模型的词错误率比动物基线模型低0.119，两个模型使用相同划分且比较对象由实验表核对。'
    ]) assert.equal(issue(result), null);
});
test('词内缩写、无数值方向与参数比例不冒充比较结果', () => {
    for (const result of [
        '在公开测试集的相同协议下，本文模型UAR比动物基线模型WER高0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，本文模型UAR指标比动物基线模型WER指标高0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，本文模型比动物基线模型参数量高128，UAR由本文模型和基线共同报告但没有比较方向。',
        '在公开测试集的相同协议下，本文模型UAR比动物基线模型参数量高128，两个模型使用相同划分。',
        '在公开测试集的相同协议下，本文模型比动物基线模型低0.119，UAR只在另一分句说明指标。',
        '在公开测试集的相同协议下，模型参数比例很高0.119，基线和本文模型仍使用相同的评测协议。',
        '在公开测试集的相同协议下，本文模型比特率高128，词错误率由模型和基线共同报告但没有比较方向。',
        '在公开测试集的相同协议下，本文模型比率高128，词错误率由模型和基线共同报告但没有比较方向。',
        '在公开测试集的相同协议下，本文模型比重高128，词错误率由模型和基线共同报告但没有比较方向。',
        '在公开测试集的相同协议下，语音模型比动物基线模型 userUAR 高0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，语音模型比动物基线模型 UARuser 高0.119，两个模型使用相同划分且比较对象由实验表核对。',
        '在公开测试集的相同协议下，语音模型比动物基线模型 UAR 很高，0.119是运行参数而不是实测结果。'
    ]) assert.match(issue(result), /指标名称|比较方向/);
});
