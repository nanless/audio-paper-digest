'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    hasCoreSummaryQuantitativeEvidence,
    hasSourceMeasuredLossComparison,
    classifySourceQuantitativeEvidence,
    validateCoreSummarySemanticContract
} = require('../scripts/analysis-contract.js');

test('运行参数和单独的成本数字不被识别为核心摘要的定量结果证据', () => {
    const source = 'The evaluation setup uses 4 GPUs and 100k training steps; inference latency is 21 ms.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), false);
    assert.equal(classifySourceQuantitativeEvidence(source), false);
});

test('有基线指标数字仍被识别为实证结果', () => {
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('延迟等运行指标只有在明确比较时才被识别为定量结果证据', () => {
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

test('实测组间率比和交互几率比保留为定量结果', () => {
    const sources = [
        'Age- and sex-adjusted count models estimated a Mandarin-versus-English rate ratio of 11.98 (95% confidence interval 6.53–22.00).',
        'Results from the mixed-effects model show an interaction odds ratio 9.44, 95% CI 5.23–17.02, for Mandarin versus English groups.',
        '组别实测结果显示，经年龄调整后普通话组相对英语组的率比为11.98，95%置信区间6.53–22.00。',
        '组别比较的结果报告交互项几率比为9.44，95%置信区间5.23–17.02。'
    ];
    for (const source of sources) {
        assert.equal(hasCoreSummaryQuantitativeEvidence(source), true, source);
        assert.equal(classifySourceQuantitativeEvidence(source), true, source);
    }
});

test('统计公式、先验、超参数、孤立区间和文献数值不冒充本篇实测结果', () => {
    const sources = [
        'The formula defines an adjusted odds ratio 9.44 with 95% CI 5.23–17.02 for hypothetical groups.',
        'The prior assumes an estimated rate ratio 11.98 and 95% CI 6.53–22.00 for the group model.',
        'The hyperparameter uses a reported odds ratio 9.44 and 95% CI 5.23–17.02 in an illustrative experiment.',
        'Results show a 95% confidence interval 6.53–22.00 for the observed groups.',
        'The previous study reported an adjusted rate ratio 11.98 with 95% CI 6.53–22.00 in the groups.',
        'Results report an adjusted odds ratio, 95% CI 5.23–17.02, in the groups.',
        'Results list an odds ratio 9.44, 95% CI 5.23–17.02, for the groups.',
        'Results report an adjusted odds ratio 9.44 for the groups.'
    ];
    for (const source of sources) {
        assert.equal(classifySourceQuantitativeEvidence(source), false, source);
    }
});


test('统计摘要仍须同时写清设置、比较对象和方向', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const oldResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const source = 'Age- and sex-adjusted count models estimated a Mandarin-versus-English rate ratio of 11.98 (95% confidence interval 6.53–22.00).';
    const complete = '在相同朗读语料和250毫秒阈值设置下，经年龄调整后普通话组相比英语组的率比为11.98，95%置信区间6.53–22.00，说明普通话组无标点间隙计数更高。';
    const incomplete = '调整后率比为11.98，95%置信区间6.53–22.00。';
    const baseline = validAnalysisText();
    assert.equal(baseline.split(oldResult).length - 1, 1);
    const completeAnalysis = baseline.replace(oldResult, complete);
    const incompleteAnalysis = baseline.replace(oldResult, incomplete);
    assert.ok(completeAnalysis.includes(complete));
    assert.ok(incompleteAnalysis.includes(incomplete));
    assert.equal(validateCoreSummarySemanticContract(completeAnalysis, { sourceText: source }), null);
    const issue = validateCoreSummarySemanticContract(incompleteAnalysis, { sourceText: source });
    assert.match(issue, /评测设置/);
    assert.match(issue, /比较方向/);
});
