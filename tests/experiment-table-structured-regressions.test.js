'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../scripts/analysis-contract.js');
const fixtures = require('./fixtures/experiment-structured-cases.json');
function analysis(table, after, before = fixtures.defaultBefore) {
    return `## 实验结果\n${before}\n\n${table}\n\n${after}`;
}
for (const group of ['regressionCases', 'zeroCorrectionCases', 'comparisonBoundaryCases']) {
    test(group + ': actual measured evidence with explicit scope, and strict negative counterparts', () => {
        for (const item of fixtures[group]) {
            const issue = c.validateExperimentTableEvidenceDepth(analysis(item.table, item.after, item.before), {sourceText:item.source});
            if (item.pass) assert.equal(issue, null, item.name);
            else assert.match(String(issue), new RegExp(item.issue), item.name);
        }
    });
}
test('only complete generator/group identity headers receive the alias', () => {
    for (const header of ['生成器','组合']) {
        assert.equal(c.extractMarkdownTables(`| ${header} | SSQA ↑ |\n|---|---|\n|A|3.84|\n|B|3.88|\n|C|3.80|`)[0].identifierColumns,1);
    }
    for (const header of ['生成器分数','组合质量','组合 SSQA ↑','生成器 SSQA ↑']) {
        assert.equal(c.extractMarkdownTables(`| ${header} | SSQA ↑ |\n|---|---|\n|A|3.84|\n|B|3.88|\n|C|3.80|`)[0].identifierColumns,0,header);
    }
});
test('table fixes do not authorize a scoring subsection inside machine summary', () => {
    const {validAnalysisText} = require('./valid-analysis-fixture');
    const text = validAnalysisText().replace('## 标签', '### 评分依据\n同期研究已有相关结果，当前结论仅覆盖现有材料，应在独立评价节讨论这些分数。\n\n## 标签');
    assert.match(String(c.validateMachineSummaryContract(text)), /非法|未知|评分依据|机器摘要/);
});
