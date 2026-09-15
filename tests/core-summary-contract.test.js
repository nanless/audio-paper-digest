'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    hasCoreSummaryQuantitativeEvidence,
    hasSourceMeasuredLossComparison,
    classifySourceQuantitativeEvidence
} = require('../scripts/analysis-contract.js');

test('操作参数和单独成本数字不触发核心摘要定量结果门禁', () => {
    const source = 'The evaluation setup uses 4 GPUs and 100k training steps; inference latency is 21 ms.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), false);
    assert.equal(classifySourceQuantitativeEvidence(source), false);
});

test('有基线指标数字仍被识别为实证结果', () => {
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('操作型指标只有在明确比较时才触发证据门禁', () => {
    const source = 'On the public test set, baseline inference latency is 120 ms versus our method at 90 ms.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('同句操作设置不吞掉独立实证指标', () => {
    const source = 'The model uses 4 layers and reports accuracy 0.91 on the public test set.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('仅训练损失对照不是可核对评测结果，测试集损失对照仍保留', () => {
    const trainingOnly = [
        'An ablation experiment compares the baseline and our training loss function values 0.35 and 0.22.'
    ];
    assert.equal(hasSourceMeasuredLossComparison(trainingOnly), false);
    assert.equal(classifySourceQuantitativeEvidence(trainingOnly.join(' ')), false);

    const evaluated = [
        'A comparative evaluation on the test set reports the baseline signal loss function value of 0.35, '
            + 'while our method demonstrates a signal loss function value of 0.22.'
    ];
    assert.equal(hasSourceMeasuredLossComparison(evaluated), true);
    assert.equal(classifySourceQuantitativeEvidence(evaluated.join(' ')), true);
});
