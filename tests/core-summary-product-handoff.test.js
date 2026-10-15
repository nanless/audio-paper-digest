'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const cases = require('./fixtures/core-product-handoff-cases.json');
for (const [kind, expected] of [['chainsPositive', true], ['chainsNegative', false]]) {
    test(kind + ': explicit producer/consumer product identity', () => {
        for (const text of cases[kind]) assert.equal(c.hasConcreteProductHandoff(text), expected, text);
    });
}
for (const [kind, expected] of [['directionsPositive', true], ['directionsNegative', false]]) {
    test(kind + ': same metric, named objects and numerical agreement', () => {
        for (const text of cases[kind]) assert.equal(c.hasBoundFormerLatterComparison(text), expected, text);
    });
}
const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const options = {sourceText:'On the public test set, baseline WER is 12.4% versus our WER of 9.8%.'};
const resultBoundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。';
test('metric aliases classify complete results, never grant factual/publication eligibility', () => {
    for (const text of cases.metricResultsPositive) {
        const issue = c.validateCoreSummarySemanticContract(validAnalysisText().replace(original, text + resultBoundary), options);
        assert.equal(issue, null, text);
    }
    for (const text of cases.metricResultsNegative) {
        const issue = c.validateCoreSummarySemanticContract(validAnalysisText().replace(original, text + resultBoundary), options);
        assert.match(String(issue), /定量结果|指标名称|数值|比较方向/, text);
    }
});
test('source NFE setting columns are identities; measured metric columns stay metrics', () => {
    for (const header of cases.tableIdentifiersPositive) {
        const [table] = c.extractMarkdownTables(`| ${header} | STOI ↑ |\n|---|---:|\n|10|0.88|\n|5|0.88|\n|1|0.89|`);
        assert.equal(table.identifierColumns, 1, header);
    }
    for (const header of cases.tableIdentifiersNegative) {
        const [table] = c.extractMarkdownTables(`| ${header} | STOI ↑ |\n|---|---:|\n|10|0.88|\n|5|0.88|\n|1|0.89|`);
        assert.equal(table.identifierColumns, 0, header);
    }
});
// Keep the existing complete contract suites for 13 headings, 320–600 chars,
// 6–9 sentences, quantitative source evidence, claim review and publication proofs.
test('真实付费稿原句保留前后缀和不确定性，无需插入序号绕检', () => {
    for (const name of ['method_tokens', 'method_frames', 'method_texts', 'method_mask']) {
        assert.equal(c.hasConcreteProductHandoff(cases.verbatimRealCases[name].text), true, name);
    }
    assert.equal(c.hasBoundFormerLatterComparison(cases.verbatimRealCases.direction_former.text), true);
});
function stageAblationAnalysis(label = '无第二阶段训练') {
    return `## 实验结果
下表比较完整模型与不同训练过程的配置对照，检验训练流程是否影响相同测试集上的词错误率。

| 模型 | WER ↓ |
|---|---:|
| 完整模型 | 9.7 |
| ${label} | 10.8 |
| 其他基线 | 12.4 |

完整模型相对两条对照的词错误率较低，说明训练流程影响该设置下的表现，但结果仅覆盖相同评测材料，尚不能外推到其他语言、噪声水平或训练规模。`;
}
test('训练阶段中文消融行必须由来源中实际删除阶段的记录支持', () => {
    const analysis = stageAblationAnalysis();
    assert.equal(c.validateExperimentTableEvidenceDepth(analysis, {
        sourceText: 'Table 1. Ablation comparison: full model versus w/o Two-stage training.'
    }), null);
    for (const sourceText of ['Table 1. Ablation comparison: full model versus w/o attention module.',
        'Table 1. Ablation comparison: full model without second-stage labels.',
        'Table 1. Ablation. We did not compare w/o Two-stage training.',
        'Table 1. Ablation. Future experiments include w/o Two-stage training.']) {
        assert.match(c.validateExperimentTableEvidenceDepth(analysis, { sourceText }), /消融/, sourceText);
    }
    assert.match(c.validateExperimentTableEvidenceDepth(stageAblationAnalysis('普通基线'), {
        sourceText: 'Table 1. Ablation comparison: full model versus w/o Two-stage training.'
    }), /消融/);
});
