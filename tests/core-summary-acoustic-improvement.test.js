'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const originalResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const baseline = validAnalysisText();
assert.equal(baseline.split(originalResult).length - 1, 1);

for (const metric of ['CA-SDRi', 'SDRi', 'SNRi']) {
    test(`${metric} 声学改善指标保留实际设置与同指标基线比较`, () => {
        const source = `Experiment results on the DCASE test set report baseline ${metric} 4.79 dB and our method ${metric} 6.36 dB.`;
        const result = `在公开测试集的相同协议下，相对基线，${metric} 从 4.79 dB 提升至 6.36 dB，指标方向和比较对象都能由原文结果核对。`;
        const analysis = baseline.replace(originalResult, result);
        assert.equal(validateCoreSummarySemanticContract(analysis, { sourceText: source }), null);
    });
}

test('未知后缀不能通过声学指标枚举', () => {
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    const analysis = baseline.replace(originalResult,
        '在公开测试集的相同协议下，相对基线，SDRimaginary 从 4.79 dB 提升至 6.36 dB，比较对象与方向均由原文核对。');
    assert.match(validateCoreSummarySemanticContract(analysis, { sourceText: source }), /指标名称/);
});
