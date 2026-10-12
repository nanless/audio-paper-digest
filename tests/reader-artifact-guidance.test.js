'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer');
const tables = require('../scripts/lib/reader-tables');
test('选择表被拒绝后提示由程序保留完整原表，来源和全部校验保持原样', () => {
 const html = '<html><body><figure class="ltx_table"><figcaption>Table 1: Results</figcaption><table><tr><th></th><th>EER (%)</th></tr><tr><td>Baseline</td><td>2.34</td></tr><tr><td>Ours</td><td>1.23</td></tr></table></figure></body></html>';
 const sourceText = cheerio.load(html)('body').text();
 const artifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html, '2609.00001v1', '2609.00001v1'), sourceText);
 const table = artifacts.tables[0];
 // 模拟完整且可逐格绑定、但因表头身份不可确定而禁止 selection 的来源。
 const before = JSON.stringify(artifacts);
 const eligibility = tables.assessReaderTableSelectionEligibility(table);
 assert.equal(eligibility.eligible, false);
 assert.match(eligibility.action, /旧说明中的.*限制针对 selection/);
 assert.match(eligibility.action, /完整原表仍可按已有协议尝试 artifact_table/);
 assert.match(eligibility.action, /完整原始 matrix/);
 assert.match(eligibility.action, /非法 selection 子集/);
 assert.match(deep.buildApiReaderArtifactEvidence(artifacts), /完整原表仍可按已有协议尝试 artifact_table/);
 assert.throws(() => tables.renderReaderTableSelection({ tableIndex: 1, selection: {sourceTableOrdinal: table.ordinal, sourceRows: [0,1], sourceColumns: [0,1]}}, artifacts), /使用已有 completeTable 声明/);
 const compiled = require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder({
  sections: [{ kind: 'result', body: '比较问题。\n\n[[TABLE_1]]\n\n结果范围。' }],
  tableBindings: [{tableIndex: 1, completeTable: {sourceTableOrdinal: table.ordinal}}]
 }, {structuredArtifacts: artifacts}).draft;
 assert.doesNotThrow(() => deep.bindApiReaderSourceEvidence(compiled.sections[0].body,
  compiled.tableBindings, [], {sourceText, structuredArtifacts: artifacts}));
 assert.equal(compiled.tableBindings[0].cellBindings.length, table.matrix.length * table.matrix[0].length);
 const matrix = table.matrix;
 const lines = matrix.map(row => '| ' + row.join(' | ') + ' |');
 lines.splice(1,0,'| '+matrix[0].map(()=>'---').join(' | ')+' |');
 const markdown = lines.join('\n');
 const binding = {tableIndex:1,sourceType:'artifact_table',sourceTableOrdinal:table.ordinal,cellBindings:matrix.flatMap((row,r)=>row.map((_,c)=>({renderedRow:r,renderedColumn:c,sourceRow:r,sourceColumn:c}))),sourceQuotes:[]};
 assert.doesNotThrow(()=>deep.bindApiReaderSourceEvidence(markdown,[binding],[],{sourceText,structuredArtifacts:artifacts}));
 const missing = structuredClone(binding); missing.cellBindings.pop();
 assert.throws(()=>deep.bindApiReaderSourceEvidence(markdown,[missing],[],{sourceText,structuredArtifacts:artifacts}), /逐格绑定/);
 assert.throws(()=>deep.bindApiReaderSourceEvidence(markdown.replace(matrix[1][1],'987654321'),[binding],[],{sourceText,structuredArtifacts:artifacts}), /不一致/);
 assert.equal(JSON.stringify(artifacts), before);
});
