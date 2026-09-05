'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readerResultTableRequirement, validateReaderResultTableCoverage,
    compileReaderTableSelections } = require('../scripts/lib/reader-tables.js');

function sourceTables(caption = 'Table 1: Quantitative enhancement results across datasets') {
    const matrix = [['Model', 'OVRL', 'SIG'], ['Baseline', '3.09', '3.50'], ['Adapted', '3.14', '3.48']];
    return { tables: [{ ordinal: 1, caption, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64),
        matrix, headerRows: [0], bodyRows: [1, 2], cells: matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
            row: rowIndex, column, rowspan: 1, colspan: 1, header: rowIndex === 0,
            text, sourceDomSha256: 'b'.repeat(64)
        }))) }] };
}
const markdown = '| Model | OVRL | SIG |\n| --- | --- | --- |\n| Baseline | 3.09 | 3.50 |\n| Adapted | 3.14 | 3.48 |';

test('only explicit quantitative source-result captions trigger the additional result-table requirement', () => {
    assert.equal(readerResultTableRequirement(sourceTables()).minimumResultTables, 1);
    for (const caption of ['', 'Authors and affiliations', 'Training configuration results', 'Dataset statistics comparison']) {
        assert.equal(readerResultTableRequirement(sourceTables(caption)).minimumResultTables, 0);
    }
    const incomplete = sourceTables();
    incomplete.tables[0].recoveryStatus = 'partial';
    assert.equal(readerResultTableRequirement(incomplete).minimumResultTables, 0);
    assert.equal(readerResultTableRequirement({ tables: {} }).minimumResultTables, 0);
    const textOnly = sourceTables();
    textOnly.tables[0].matrix = [['Conclusion', 'Status'], ['Theorem', 'proved']];
    assert.equal(readerResultTableRequirement(textOnly).minimumResultTables, 0);
});

test('dataset/configuration tables cannot replace a numeric table in result or ablation sections', () => {
    const artifacts = sourceTables();
    const before = JSON.stringify(artifacts);
    assert.throws(() => validateReaderResultTableCoverage([
        { kind: 'training', body: markdown }, { kind: 'experiment_setup', body: markdown },
        { kind: 'result', body: 'Only a qualitative summary.' }
    ], artifacts), /主结果表覆盖不足/);
    assert.equal(validateReaderResultTableCoverage([{ kind: 'result', body: markdown }], artifacts).numericResultTables, 1);
    assert.equal(validateReaderResultTableCoverage([{ kind: 'ablation', body: markdown }], artifacts).numericResultTables, 1);
    assert.equal(JSON.stringify(artifacts), before);
});

test('valid original-table selection is compiled before result coverage is checked', () => {
    const artifacts = sourceTables();
    const compiled = compileReaderTableSelections([{ kind: 'result', body: '[[TABLE_1]]' }], [
        { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
    ], artifacts);
    assert.equal(validateReaderResultTableCoverage(compiled.sections, artifacts).numericResultTables, 1);
});

test('missing results are diagnosed together and repair allows the empty result section as well as table bindings', () => {
    const { collectDraftIssues, buildRepairTargets } = require('../scripts/lib/reader-repair.js');
    const draft = { sections: [
        { kind: 'training', heading: 'Training', body: markdown },
        { kind: 'experiment_setup', heading: 'Data', body: markdown },
        { kind: 'result', heading: 'Results', body: 'Only qualitative conclusions.' }
    ], conceptBridges: [], figurePlacements: [], formulaBindings: [], tableBindings: [1, 2].map(tableIndex => ({
        tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: ['Original source has the quoted result values.']
    })) };
    const issues = collectDraftIssues(draft, null, { structuredArtifacts: sourceTables() });
    assert.ok(issues.some(issue => issue.code === 'reader_result_table_missing'));
    const paths = buildRepairTargets(draft, issues).map(target => target.path);
    assert.ok(paths.some(value => value === '/sections/2/body' || value === '/sections/2'));
    assert.ok(paths.includes('/tableBindings/1'));
});

test('prompt contract discloses the source-derived result requirement before any model call', () => {
    const { buildReaderContractNotice } = require('../scripts/lib/reader-contract.js');
    assert.match(buildReaderContractNotice(readerResultTableRequirement(sourceTables())), /result\/ablation.*数字结果表/);
    assert.doesNotMatch(buildReaderContractNotice(readerResultTableRequirement({ tables: [] })), /result\/ablation.*数字结果表/);
});
