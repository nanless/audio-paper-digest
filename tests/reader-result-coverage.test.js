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

test('结果表中的约数仍是测量值，配置和不足四格的数字不能充数', () => {
    const artifacts = sourceTables();
    const body = '| 比较 | 指标 | 增量 |\n|---|---|---|\n'
        + '| 滤波器 | SI-SNR | 约 1.2 dB 提升 |\n'
        + '| 滤波器 | SDR | 约 0.9 dB 提升 |\n'
        + '| 后处理 | SI-SNR | 约 11.5 dB 提升 |\n'
        + '| 后处理 | SDR | 约 10 dB 提升 |';
    assert.equal(validateReaderResultTableCoverage([{ kind: 'result', body }], artifacts).numericResultTables, 1);
    for (const invalid of [
        body.split('\n').slice(0, -1).join('\n'),
        body.replaceAll('约 ', '模型约 '),
        '| 配置 | A | B |\n|---|---|---|\n| 学习率 | 约 0.001 | 约 0.002 |\n| 批量大小 | 约 64 | 约 128 |'
    ]) assert.throws(() => validateReaderResultTableCoverage([{ kind: 'result', body: invalid }], artifacts), /主结果表覆盖不足/);
    assert.throws(() => validateReaderResultTableCoverage([{ kind: 'experiment_setup', body }], artifacts), /主结果表覆盖不足/);
});

test('只有明确的量化来源结果表题才触发额外的结果表要求', () => {
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

test('数据集表和配置表不能顶替 result 或 ablation 小节里的数字表', () => {
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

test('先编译合法的原表选择，再检查结果覆盖', () => {
    const artifacts = sourceTables();
    const compiled = compileReaderTableSelections([{ kind: 'result', body: '[[TABLE_1]]' }], [
        { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
    ], artifacts);
    assert.equal(validateReaderResultTableCoverage(compiled.sections, artifacts).numericResultTables, 1);
});

test('缺失的结果会一起诊断，修复既接受空的结果小节也接受表格绑定', () => {
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

test('提示词约定在任何模型调用之前说明来源结果表要求', () => {
    const { buildReaderContractNotice } = require('../scripts/lib/reader-contract.js');
    assert.match(buildReaderContractNotice(readerResultTableRequirement(sourceTables())), /result 或 ablation 小节须呈现至少 1 张带数字的结果表/);
    assert.doesNotMatch(buildReaderContractNotice(readerResultTableRequirement({ tables: [] })), /result 或 ablation.*带数字的结果表/);
});
