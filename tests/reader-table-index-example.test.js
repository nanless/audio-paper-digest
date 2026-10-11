'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer');
const { renderReaderTableSelection } = require('../scripts/lib/reader-tables');
function sourceTables() {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/arxiv-reader-source-bindings.html'), 'utf8');
    const text = cheerio.load(html)('body').text();
    return deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html, '2609.00001v1', '2609.00001v1'), text);
}
test('合法原表示例保留全部已展示数据行和列，并由公共渲染器预核验', () => {
    const artifacts = sourceTables();
    const sourceEvidence = deep.buildApiReaderArtifactEvidence(artifacts);
    const evidence = deep.readerVerifiedTableIndexExamples(artifacts, sourceEvidence, [{message:'tableBindings[0] selection invalid'}], {tableBindings:[{selection:{sourceTableOrdinal:1}}]});
    const line = evidence.match(/^TABLE_1_VERIFIED_INDEX_EXAMPLE: (.+?)；/m);
    assert.ok(line);
    const example = JSON.parse(line[1]);
    assert.deepEqual(example.selection.sourceRows, [0, 2, 3]);
    assert.deepEqual(example.selection.sourceColumns, [0, 1, 2]);
    assert.ok(renderReaderTableSelection(example, artifacts));
    const shifted = structuredClone(artifacts);
    const table = shifted.tables[0];
    table.matrix = [...Array.from({ length: 8 }, () => ['Context', '', '']), ...table.matrix];
    table.headerRows = table.headerRows.map(row => row + 8);
    table.bodyRows = table.bodyRows.map(row => row + 8);
    for (const cell of table.cells) cell.row += 8;
    const shiftedEvidence = deep.buildApiReaderArtifactEvidence(shifted);
    const shiftedLine = deep.readerVerifiedTableIndexExamples(shifted, shiftedEvidence, [{message:'sourceTableOrdinal=1'}], {})
        .match(/^TABLE_1_VERIFIED_INDEX_EXAMPLE: (.+?)；/m);
    assert.ok(shiftedLine);
    const shiftedExample = JSON.parse(shiftedLine[1]);
    assert.deepEqual(shiftedExample.selection.sourceRows, [8, 10, 11]);
    assert.ok(renderReaderTableSelection(shiftedExample, shifted));
    assert.match(evidence, /不能替代比较问题、基线与内容覆盖判断/);
});
test('预算截断、未完整展示或不合格原表不提供可复制示例', () => {
    const artifacts = sourceTables();
    assert.equal(deep.readerVerifiedTableIndexExamples(artifacts, deep.buildApiReaderArtifactEvidence(artifacts, '', 450), [{message:'sourceTableOrdinal=1'}], {}), '');
    assert.equal(deep.readerVerifiedTableIndexExamples(artifacts, deep.buildApiReaderArtifactEvidence(artifacts), [], {}), '');
    const completeEvidence = deep.buildApiReaderArtifactEvidence(artifacts);
    assert.match(deep.readerVerifiedTableIndexExamples(artifacts, completeEvidence,
        [{ message: '其他可选择原表序号=[2,2]' }], {}), /TABLE_2_VERIFIED_INDEX_EXAMPLE/);
    for (const values of ['[2,"x"]', '[0,2]', '[2.5]', '[oops]', '[' + Array(13).fill(2).join(',') + ']']) {
        assert.equal(deep.readerVerifiedTableIndexExamples(artifacts, completeEvidence,
            [{ message: '其他可选择原表序号=' + values }], {}), '');
    }
    const longTable = structuredClone(artifacts.tables[1]);
    const originalRows = longTable.matrix.length;
    for (let row = originalRows; row < 41; row += 1) {
        longTable.matrix.push([...longTable.matrix[1]]);
        longTable.bodyRows.push(row);
        for (const cell of longTable.cells.filter(cell => cell.row === 1)) {
            longTable.cells.push({ ...cell, row });
        }
    }
    const longEvidence = deep.buildApiReaderArtifactEvidence({ tables: [longTable] });
    assert.match(longEvidence, /"eligible":true/);
    assert.equal(deep.readerVerifiedTableIndexExamples({tables:[longTable]}, longEvidence, [{message:'sourceTableOrdinal=2'}], {}), '');
    for (const table of artifacts.tables) table.recoveryStatus = 'incomplete';
    assert.equal(deep.readerVerifiedTableIndexExamples(artifacts, deep.buildApiReaderArtifactEvidence(artifacts), [{message:'sourceTableOrdinal=1'}], {}), '');
});
