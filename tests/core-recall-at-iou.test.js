'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const originalResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';

test('规范 R1@IoU 和既有 R@1 保留为实际比较指标', () => {
    for (const metric of ['R1@0', 'R1@0.5', 'R1@0.7', 'R1@1', 'R1@1.0', 'R@1']) {
        const result = `在公开测试集相同协议下，本方法的 ${metric} 从基线的21.0提高至36.1，表明检索结果优于基线且两者使用同一评测数据划分。`;
        const analysis = validAnalysisText();
        assert.equal(analysis.split(originalResult).length - 1, 1);
        assert.equal(contract.validateCoreSummarySemanticContract(analysis.replace(originalResult, result), {
            sourceText: `On the public test set, baseline ${metric} 21.0 improves to our method ${metric} 36.1.`
        }), null, metric);
    }
});

test('非法阈值、用户名内嵌 token 与普通数字不冒充指标', () => {
    for (const metric of ['R1@2', 'R1@-0.2', 'R1@1.1', 'R1@0.7.2', 'userR1@0.7', 'R1@0.7user', '_R1@0.7', '21.0']) {
        const result = `在公开测试集相同协议下，本方法的 ${metric} 从基线的21.0提高至36.1，表明检索结果优于基线且两者使用同一评测数据划分。`;
        const issue = contract.validateCoreSummarySemanticContract(validAnalysisText().replace(originalResult, result), {
            sourceText: 'On the public test set, baseline R1@0.7 21.0 improves to our method R1@0.7 36.1.'
        });
        assert.match(issue, /指标名称/, metric);
    }
});
