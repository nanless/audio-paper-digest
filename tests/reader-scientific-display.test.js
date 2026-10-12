'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const { findReaderTablePasteDuplication } = require('../scripts/lib/reader-tables');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const table = value => `| Method | Value |\n| --- | --- |\n| A | ${value} |`;

test('科学计数的明确 TeX 副本只在系数、符号和指数一致时合并', () => {
    for (const [source, expected] of [
        ['3.26×10−73.26{\\times}10^{-7}', '\\(3.26\\times10^{-7}\\)'],
        ['2×10+32{\\times}10^{+3}', '\\(2\\times10^{+3}\\)'],
        ['0.2×1050.2{\\times}10^{5}', '\\(0.2\\times10^{5}\\)']
    ]) {
        assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(source)), table(expected));
        assert.equal(findReaderTablePasteDuplication(expected), null);
    }
});

test('不同系数或指数、符号矛盾及没有 TeX 的重复值不能合并', () => {
    for (const source of [
        '3.26×10−73.27{\\times}10^{-7}',
        '3.26×10−73.26{\\times}10^{-8}',
        '3.26×10−73.26{\\times}10^{+7}',
        '3.26×10−73.26×10−7',
        '3.26×10−7', '130130', '1.2×10−41.2{\\times}10^{-04}'
    ]) assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(source)), table(source), source);
});

test('清理显示后仍逐格绑定原始文本与 DOM SHA，篡改系数或指数会失败', () => {
    const source = '3.26×10−73.26{\\times}10^{-7}';
    const sourceText = 'A measured value appears in the original result table.';
    const matrix = [['Method', 'Value'], ['A', source]];
    const cells = matrix.flatMap((row, r) => row.map((text, c) => ({
        row: r, column: c, rowspan: 1, colspan: 1, text,
        sourceDomSha256: sha(`original ${r}:${c}:${text}`)
    })));
    const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
        flattenedTextSha256: sha(sourceText), formulas: [], figures: [],
        tables: [{ ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('original table'), cells, matrix }] };
    const artifacts = { ...body, payloadSha256: deep.stableFingerprint(body) };
    const declared = [{ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [], cellBindings: cells.map(cell => ({ renderedRow: cell.row,
            renderedColumn: cell.column, sourceRow: cell.row, sourceColumn: cell.column })) }];
    const options = { sourceText, structuredArtifacts: artifacts };
    const before = JSON.stringify(artifacts);
    const bound = deep.bindApiReaderSourceEvidence(table(source), declared, [], options);
    assert.equal(bound.article, table('\\(3.26\\times10^{-7}\\)'));
    assert.equal(bound.tableBindings[0].cellBindings[3].sourceText, source);
    assert.equal(bound.tableBindings[0].cellBindings[3].sourceDomSha256, cells[3].sourceDomSha256);
    assert.equal(JSON.stringify(artifacts), before);
    for (const altered of ['\\(3.27\\times10^{-7}\\)', '\\(3.26\\times10^{-8}\\)']) {
        assert.throws(() => deep.bindApiReaderSourceEvidence(table(altered), declared, [], options), /原始 cell 不一致/);
    }
});
