'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../scripts/analysis-contract.js');
const cases = require('./fixtures/core-artifact-handoff-cases.json');
for (const [group, fn, expected] of [
    ['handoffPositive', c.hasExplicitArtifactHandoff, true],
    ['handoffNegative', c.hasExplicitArtifactHandoff, false],
    ['boundaryPositive', c.hasNaturalScopedBoundary, true],
    ['boundaryNegative', c.hasNaturalScopedBoundary, false]
]) test(group + ': explicit product ownership and bounded scope', () => {
    for (const text of cases[group]) assert.equal(fn(text), expected, text);
});
test('named metrics preserve model-name boundaries and reject the wrong SI-SDR translation', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const boundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。';
    for (const [group, expected] of [['metricPositive', true], ['metricNegative', false]]) {
        for (const metric of cases[group]) {
            const analysis = validAnalysisText().replace(original,
                `在公开测试集相同协议下，${metric}从12.4%降至9.8%，比较对象为基线与本文方法。` + boundary);
            const issue = c.validateCoreSummarySemanticContract(analysis, {
                sourceText: 'The public test set baseline WER is 12.4 versus 9.8.'
            });
            if (expected) assert.equal(issue, null, metric);
            else assert.match(String(issue), /定量结果|指标名称/, metric);
        }
    }
});
test('learning-rate and model-size numbers cannot supply measured metric values', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const boundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。';
    for (const sentence of cases.nonResultSentenceNegative) {
        const issue = c.validateCoreSummarySemanticContract(validAnalysisText().replace(original, sentence + boundary), {sourceText:'The public test set baseline WER is 12.4 versus 9.8.'});
        assert.match(String(issue), /定量结果|指标名称|数值/, sentence);
    }
});
