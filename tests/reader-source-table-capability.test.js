'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tables = require('../scripts/lib/reader-tables');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');
const { buildReaderSourceDiagnostics } = require('../scripts/lib/reader-source-diagnostics');
const sha = 'a'.repeat(64);
function source(matrix, ordinal = 1) {
    return { ordinal, caption: 'Evaluation results', recoveryStatus: 'complete', sourceDomSha256: sha,
        matrix, headerRows: [0], bodyRows: matrix.slice(1).map((_, index) => index + 1),
        cells: matrix.flatMap((row, rowIndex) => row.map((text, column) => ({ row: rowIndex,
            column, text, header: rowIndex === 0, rowspan: 1, colspan: 1, sourceDomSha256: sha }))) };
}
function draft(binding = { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }) {
    return { sections: [{kind: 'result', heading: 'Results', body: 'Compare all systems.\n\n[[TABLE_1]]\n\nKeep the limitations.'}],
        tableBindings: [binding], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
}

test('空布局列头限制selection但安全完整表保留全部数据和精度，并在正常compiler展开坐标', () => {
    const table = source([['', 'PCC', 'RMSE'], ['Baseline', '0.934', '5.21'], ['Ours', '0.948', '4.63']]);
    const input = draft(); const before = JSON.stringify({table, input});
    const selection = tables.assessReaderTableSelectionEligibility(table);
    assert.equal(selection.eligible, false);
    assert.equal(selection.completeTableEligible, true);
    const compiled = tables.compileReaderTableSelections(input.sections, input.tableBindings, {tables: [table]});
    assert.equal(compiled.tableBindings[0].sourceType, 'artifact_table');
    assert.equal(compiled.tableBindings[0].cellBindings.length, 9);
    assert.match(compiled.sections[0].body, /\| Baseline \| 0\.934 \| 5\.21 \|/);
    assert.match(compiled.sections[0].body, /\| Ours \| 0\.948 \| 4\.63 \|/);
    assert.equal(JSON.stringify({table, input}), before);
});

test('裸数值双写拒绝完整声明并成对给出binding与承载section，不把源码坏格回填正文', () => {
    const table = source([['Method', 'SDR'], ['Mixture', '0.10.1']]);
    assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible, false);
    const input = draft(); const before = JSON.stringify(input);
    assert.throws(() => tables.compileReaderTableSelections(input.sections, input.tableBindings, {tables: [table]}), error => {
        assert.equal(error.code, 'READER_SOURCE_TABLE_UNRENDERABLE');
        assert.deepEqual(error.readerIssues.map(issue => issue.path), ['/tableBindings/0', '/sections/0/body']);
        assert.ok(error.readerIssues.every(issue => issue.code === tables.READER_SOURCE_TABLE_ISSUE_CODE));
        return true;
    });
    assert.equal(JSON.stringify(input), before);
    const eligibility = tables.assessReaderTableSelectionEligibility(table);
    assert.equal(eligibility.completeTableEligible, false);
    assert.match(eligibility.action, /不能使用 selection、completeTable/);
    assert.doesNotMatch(eligibility.action, /完整原表仍可/);
});

test('明确同值TeX显示副本沿公共规则处理，来源原字节保持不变', () => {
    const table = source([['Method', 'PESQ↑\\uparrow'], ['Ours', '3.45']]);
    const before = JSON.stringify(table);
    assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible, true);
    const compiled = tables.renderReaderCompleteTable(draft().tableBindings[0], {tables: [table]});
    assert.match(compiled.markdown, /PESQ↑/);
    assert.doesNotMatch(compiled.markdown, /\\uparrow/);
    assert.equal(JSON.stringify(table), before);
});

test('未知TeX、非矩形、丢原格、重复原格与Markdown注入不能声明完整表', () => {
    const variants = [source([['Method', 'Score'], ['Ours', '\\mathrm{score}']]),
        source([['Method', 'Score'], ['Ours', '3.2|extra']]),
        source([['Method', 'Score'], ['Ours', '3.2']]),
        source([['Method', 'Score'], ['Ours', '3.2']])];
    variants[2].cells.pop(); variants[3].cells.push({...variants[3].cells[0]});
    for (const table of variants) {
        assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible, false);
        assert.throws(() => tables.renderReaderCompleteTable(draft().tableBindings[0], {tables: [table]}), /source_table/);
    }
    const ragged = source([['Method', 'Score'], ['Ours']]);
    assert.equal(tables.assessReaderCompleteTableEligibility(ragged).eligible, false);
});

test('draft-order和正常tablecompiler共用完整表能力，旧artifact marker也不能复写坏来源', () => {
    const table = source([['Method', 'Score'], ['Ours', '0.10.1']]);
    const raw = draft({ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        cellBindings: table.matrix.flatMap((row, r) => row.map((_, c) => ({renderedRow:r,renderedColumn:c,sourceRow:r,sourceColumn:c}))), sourceQuotes: [] });
    assert.throws(() => normalizeReaderDraftOrder(raw, {structuredArtifacts:{tables:[table]}}), error => error.code === 'READER_SOURCE_TABLE_UNRENDERABLE');
    const clean = source([['', 'Score'], ['Ours', '3.2']]);
    const result = normalizeReaderDraftOrder(draft(), {structuredArtifacts:{tables:[clean]}});
    assert.equal(result.draft.tableBindings[0].sourceType, 'artifact_table');
    assert.doesNotMatch(result.draft.sections[0].body, /\[\[TABLE_/);
});

test('能力诊断只给完整合法替代证据和原文连续切片，保留不授予修复的标志', () => {
    const bad = source([['Method', 'SDR'], ['Mixture', '0.10.1']]);
    const clean = source([['Method', 'SDR'], ['Baseline', '0.1'], ['Ours', '3.2']], 2);
    const input = draft(); const text = 'Evaluation results\nMethod\nSDR\nMixture\n0.10.1\nTrailing original text';
    let error;
    try { tables.compileReaderTableSelections(input.sections, input.tableBindings, {tables:[bad,clean]}); } catch (caught) { error = caught; }
    const diagnostics = buildReaderSourceDiagnostics({draft:input,sourceText:text,structuredArtifacts:{tables:[bad,clean]},parserError:error});
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].diagnosticOnly, true);
    assert.equal(diagnostics[0].bindingPath, '/tableBindings/0');
    assert.equal(diagnostics[0].sectionPath, '/sections/0/body');
    assert.deepEqual(diagnostics[0].usableSourceTables[0].matrix, clean.matrix);
    assert.deepEqual(diagnostics[0].usableSourceTables[0].cells, clean.cells);
    assert.equal(diagnostics[0].sourceQuoteCoverageAttested, false);
    for (const quote of diagnostics[0].sourceQuotes) assert.ok(text.includes(quote.quote));
    assert.ok(diagnostics[0].sourceQuotes.some(quote => quote.quote.includes('Mixture\n0.10.1')));
});
