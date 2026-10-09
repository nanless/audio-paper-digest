'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const contract = require('../scripts/analysis-contract');
const engine = require('../scripts/analysis-engine');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture');
const deep = require('../scripts/deep-analyzer');
const headers = ['方法', 'WER ↓', '数据集'];
const rows = [['甲', '10.0', '测试集'], ['乙', '8.0', '测试集'], ['丙', '7.0', '测试集']];
const before = '下面比较相同训练条件下各方法在测试集上的错误率，从而回答模型是否带来一致收益。';
const after = '与基线相比，方法乙的错误率较低，方法丙仍有进一步下降；但这些数字只覆盖当前测试条件，尚不能据此推断其他语言、噪声环境或训练规模下的表现。';
function table(order, values = rows) {
    return [
        '| ' + order.map(i => headers[i]).join(' | ') + ' |',
        '| ' + order.map(() => '---').join(' | ') + ' |',
        ...values.map(row => '| ' + order.map(i => row[i]).join(' | ') + ' |')
    ].join('\n');
}
function analysis(order, values = rows) {
    return validAnalysisText().replace(/## 实验结果\n[\s\S]*?(?=\n## 细节详述)/,
        '## 实验结果\n' + before + '\n\n' + table(order, values) + '\n\n' + after + '\n');
}
const options = { contractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '方法研究' };

test('方法、指标和数据集列的六种位置都按真实指标单元格验收', () => {
    for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
        assert.equal(contract.validateExperimentTableContract(analysis(order), options), null, String(order));
    }
});

test('数据集年份不能顶替缺失指标，缓存成功记录经真实门禁重新拒绝', () => {
    const text = analysis([0,1,2], rows.map(row => [row[0], '未报告', '2024']));
    assert.match(contract.validateExperimentTableContract(text, options), /只有 0 个可核对数字/);
    const paper = validAnalysisPaper('2601.12345', {}, text);
    paper.analysisManifest.contracts.experimentTables = contract.EXPERIMENT_TABLE_CONTRACT_VERSION;
    assert.equal(engine.hasValidAnalysisBody(paper), false);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), false);
    const good = validAnalysisPaper('2601.12345', {}, analysis([0,1,2]));
    good.analysisManifest.contracts.experimentTables = contract.EXPERIMENT_TABLE_CONTRACT_VERSION;
    assert.equal(engine.hasValidAnalysisBody(good), true);
    assert.equal(engine.isSuccessfulAnalysisRecord(good), true);
});

test('交错指标列仍核查数字格式，识别列文字不套指标格式规则', () => {
    assert.match(contract.validateExperimentTableContract(analysis([0,1,2],
        rows.map(row => [row[0], '8 ％', '2024'])), options), /数字格式未规范化/);
    assert.equal(contract.validateExperimentTableContract(analysis([0,1,2],
        rows.map(row => [row[0], row[1], '20 ％子集'])), options), null);
});

test('Reader 原表绑定逐行逐列核验交错指标，错绑数据集坐标和篡改数值都拒绝', () => {
    const html = '<html><body><figure class="ltx_table" id="S1.T1"><figcaption>Table 1: Results</figcaption><table class="ltx_tabular">'
        + [headers, ...rows].map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('')
        + '</table></figure></body></html>';
    const sourceText = cheerio.load(html)('body').text();
    const artifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html,
        '2601.12345v1', '2601.12345v1'), sourceText);
    assert.equal(artifacts.tables.length, 1);
    const binding = { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        cellBindings: [headers, ...rows].flatMap((row, renderedRow) => row.map((_cell, renderedColumn) => ({
            renderedRow, renderedColumn, sourceRow: renderedRow, sourceColumn: renderedColumn
        }))), sourceQuotes: [] };
    const bind = (article, value) => deep.bindApiReaderSourceEvidence(article, [value], [], {
        structuredArtifacts: artifacts, sourceText, sections: []
    });
    const result = bind(table([0,1,2]), binding);
    assert.equal(result.tableBindings[0].cellBindings.find(cell => cell.renderedRow === 1
        && cell.renderedColumn === 1).sourceText, '10.0');
    const wrong = structuredClone(binding);
    wrong.cellBindings.find(cell => cell.renderedRow === 1 && cell.renderedColumn === 1).sourceColumn = 2;
    assert.throws(() => bind(table([0,1,2]), wrong), /渲染单元格与原始 cell 不一致/);
    assert.throws(() => bind(table([0,1,2]).replace('10.0', '99.0'), binding), /渲染单元格与原始 cell 不一致/);
});
