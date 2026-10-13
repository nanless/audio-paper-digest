'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sourceProject = process.env.PD_COLSPAN_SOURCE_PROJECT;
const paidCandidate = process.env.PD_COLSPAN_PAID_CANDIDATE;
const deep = require('../scripts/deep-analyzer');
const display = require('../scripts/lib/reader-pdf-cell-evidence');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function sampleTable() {
    const html = '<article><figure class="ltx_table"><figcaption>Table 1: Controlled comparison.</figcaption><table><tr><th>Method</th><th>WER</th><th>CER</th></tr><tr><th colspan="3">Control data</th></tr><tr><td>Baseline</td><td>12.4%</td><td>3.1%</td></tr><tr><td colspan="3">Footnote: the same recording conditions.</td></tr></table></figure></article>';
    return deep.parseArxivStructuredArtifactsFromHtml(html, '2610.90010v1', '2610.90010').tables[0];
}
test('DOM全幅文字行显示一次，旧重复展示可只读核验，不改源矩阵或数字', () => {
    const table = sampleTable();
    const before = JSON.stringify(table);
    assert.deepEqual(display.displayMatrix(table)[1], ['Control data', '', '']);
    assert.deepEqual(display.displayMatrix(table)[3], ['Footnote: the same recording conditions.', '', '']);
    assert.deepEqual(display.displayMatrix(table)[2], ['Baseline', '12.4%', '3.1%']);
    assert.equal(display.displayCellMatches(table, 1, 2, 'Control data'), true);
    assert.equal(display.displayCellMatches(table, 1, 2, ''), true);
    assert.equal(display.displayCellMatches(table, 1, 2, 'Different data'), false);
    assert.equal(JSON.stringify(table), before);
});
test('缺DOM、部分跨度、跨行、数值或重叠原格均不折叠', () => {
    for (const mutate of [
        table => { table.cells = []; },
        table => { table.cells.find(cell => cell.row === 1).colspan = 2; },
        table => { table.cells.find(cell => cell.row === 1).rowspan = 2; },
        table => { const cell = table.cells.find(cell => cell.row === 1); cell.text = '0.5'; table.matrix[1].fill('0.5'); },
        table => { table.cells.push({ ...table.cells.find(cell => cell.row === 1), column: 2, colspan: 1 }); },
        table => { table.matrix[1][2] = 'Different condition'; }
    ]) {
        const table = sampleTable();
        mutate(table);
        assert.equal(display.fullWidthLabelRow(table, 1), false);
    }
});
test('保存后的空显示格必须由完整payload SHA和原DOM身份支持，旧重复源值保持兼容', () => {
    const table = sampleTable();
    const artifacts = { tables: [table], flattenedTextSha256: sha('sealed source text') };
    const payload = JSON.stringify(artifacts);
    const paper = { sourceSha256: artifacts.flattenedTextSha256,
        analysisManifest: { sourceAcquisition: { sourceSha256: artifacts.flattenedTextSha256, structuredArtifactsSha256: sha(payload) } },
        apiReaderPlan: { structuredSourcePayload: payload } };
    const binding = { sourceTableOrdinal: table.ordinal, sourceTableDomSha256: table.sourceDomSha256 };
    const source = table.cells.find(cell => cell.row === 1);
    const cell = { sourceRow: 1, sourceColumn: 2, renderedText: '', sourceText: source.text, sourceDomSha256: source.sourceDomSha256 };
    assert.equal(display.savedMergedCellMatches(paper, binding, cell, ''), true);
    for (const altered of [ { ...cell, sourceText: 'Wrong' }, { ...cell, sourceDomSha256: '0'.repeat(64) },
        { ...cell, sourceColumn: 3 }, { ...cell, sourceColumn: '2' }, { ...cell, sourceRow: 2 } ]) {
        assert.equal(display.savedMergedCellMatches(paper, binding, altered, ''), false);
    }
    paper.apiReaderPlan.structuredSourcePayload += ' ';
    assert.equal(display.savedMergedCellMatches(paper, binding, cell, ''), false);
});

test('真实03017付费完整表只折叠DOM全幅文字，原付费稿与来源不写', {
    skip: !sourceProject || !paidCandidate
}, () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const folder = path.join(sourceProject, 'data/runtime/daily-fresh-source-runs',
        '132fc843-0afe-434c-b0b7-4d98e2235b3e/sources/2610.03017/generation-000001');
    const candidateBytes = fs.readFileSync(paidCandidate);
    const sourceBytes = fs.readFileSync(path.join(folder, 'source.txt'));
    const runtimeBytes = fs.readFileSync(path.join(folder, 'source-runtime.json'));
    const draft = JSON.parse(candidateBytes).payload.draft;
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true, requireSourceBindings: true,
        minTables: 2, structuredArtifacts: JSON.parse(runtimeBytes).structuredArtifacts,
        sourceText: sourceBytes.toString(),
        availableFigureOrdinals: (draft.figurePlacements || []).map(item => item.figureOrdinal)
    });
    const sourceLabel = 'Non-impaired Control Data';
    const table = parsed.plan.tableBindings.find(binding => binding.sourceTableOrdinal === 3);
    assert.ok(table);
    const cells = table.cellBindings.filter(cell => cell.sourceText === sourceLabel);
    assert.equal(cells.length, 4);
    assert.equal(cells.filter(cell => cell.renderedText === sourceLabel).length, 1);
    assert.equal(cells.filter(cell => cell.renderedText === '').length, 3);
    assert.deepEqual(fs.readFileSync(paidCandidate), candidateBytes);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'source.txt')), sourceBytes);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'source-runtime.json')), runtimeBytes);
});
