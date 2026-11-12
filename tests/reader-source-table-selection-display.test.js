'use strict';
// 选择（selection）与完整表（completeTable）必须共用同一套单元格显示投影：
// 源 DOM 里的同义 TeX 双写只保留可见副本；未知命令仍在资格检查阶段拒绝。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    projectReaderCellTexDisplay,
} = require('../scripts/lib/reader-source-display.js');
const {
    assessReaderTableSelectionEligibility,
    assessReaderCompleteTableEligibility,
    renderReaderTableSelection,
    renderReaderCompleteTable,
    findReaderTablePasteDuplication,
} = require('../scripts/lib/reader-tables.js');

const sha = 'a'.repeat(64);
const parity = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-cell-tex-display.json'), 'utf8'));

function sourceTable(matrix, headerRow = 0) {
    return {
        ordinal: 1, caption: 'Results', recoveryStatus: 'complete', sourceDomSha256: sha,
        matrix, headerRows: [headerRow], bodyRows: matrix.slice(1).map((_row, index) => index + 1),
        cells: matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
            row: rowIndex, column, text, header: rowIndex === headerRow,
            rowspan: 1, colspan: 1, sourceDomSha256: sha,
        }))),
    };
}

function selection(table) {
    return { tableIndex: 1, selection: { sourceTableOrdinal: 1,
        sourceRows: table.matrix.map((_row, index) => index),
        sourceColumns: table.matrix[0].map((_cell, index) => index) } };
}

test('显示投影与共享语料逐条一致，未知命令与不同值注解保持原样', () => {
    assert.equal(parity.contract, 'reader-cell-tex-display-parity-v1');
    for (const item of parity.cases) {
        assert.equal(projectReaderCellTexDisplay(item.input), item.expected, item.input);
    }
    for (const input of ['k=\\tilde{k}', 'FD\\mathrm{FD_{norm}}', '\\unknowncommand']) {
        assert.ok(projectReaderCellTexDisplay(input).includes('\\'), input);
    }
});

test('选择与完整表对同一原表输出同一显示字节，且行内没有裸 TeX', () => {
    const table = sourceTable([
        ['Method', 'FDPANNs\\mathrm{\\textbf{FD}_{\\textbf{PANNs}}}↓'],
        ['A', '1.0'],
        ['B', '2.0'],
    ]);
    assert.equal(assessReaderTableSelectionEligibility(table).eligible, true);
    assert.equal(assessReaderCompleteTableEligibility(table).eligible, true);
    const selected = renderReaderTableSelection(selection(table), { tables: [table] });
    const complete = renderReaderCompleteTable({
        tableIndex: 1, completeTable: { sourceTableOrdinal: 1 },
    }, { tables: [table] });
    assert.equal(selected.markdown, complete.markdown);
    assert.equal(selected.markdown, [
        '| Method | FDPANNs↓ |',
        '| --- | --- |',
        '| A | 1.0 |',
        '| B | 2.0 |',
    ].join('\n'));
    assert.doesNotMatch(selected.markdown, /\\[A-Za-z]+/);
    // 表格原字节不被改写；投影只发生在显示视图。
    assert.equal(table.matrix[0][1], 'FDPANNs\\mathrm{\\textbf{FD}_{\\textbf{PANNs}}}↓');
});

test('完整表资格按同一显示投影判定：可投影的双写通过，裸数字粘连仍拒绝', () => {
    const projectable = sourceTable([
        ['FmaxF_{\\mathrm{max}} (MHz)', 'Area×\\timesDelay'],
        ['A', '2.62×𝟏𝟎𝟔\\mathbf{2.62\\times 10^{6}}'],
        ['B', '1.0'],
    ]);
    assert.equal(assessReaderCompleteTableEligibility(projectable).eligible, true);
    const rendered = renderReaderCompleteTable({
        tableIndex: 1, completeTable: { sourceTableOrdinal: 1 },
    }, { tables: [projectable] });
    assert.match(rendered.markdown, /\| Fmax \(MHz\) \| Area×Delay \|/);
    assert.doesNotMatch(rendered.markdown, /\\[A-Za-z]+/);
    // 裸数字粘连没有同值 TeX 注解，不能借“重复形状”删减；守卫仍要求核对。
    const glued = sourceTable([
        ['Method', 'Value'],
        ['A', '5.15.1 %'],
        ['B', '1.0'],
    ]);
    const eligibility = assessReaderCompleteTableEligibility(glued);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.reasonCodes.includes('source_display_cleanup_required'));
    assert.ok(findReaderTablePasteDuplication('5.15.1 %'));
});

test('已逐格绑定原表的同义 TeX 双写格按投影通过粘连守卫，原字节与旧稿不被改写', () => {
    const deep = require('../scripts/deep-analyzer.js');
    const build = (headerCell) => {
        const article = [
            '### 结果如何比较？', '',
            `| Method | ${headerCell} |`,
            '| --- | --- |',
            '| A | 1.0 |',
            '| B | 2.0 |',
        ].join('\n');
        const binding = {
            tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
            cellBindings: [0, 1, 2].flatMap(row => [0, 1].map(column => ({
                renderedRow: row, renderedColumn: column,
                sourceRow: row, sourceColumn: column, sourceText: `cell ${row}:${column}`,
            }))),
        };
        return { article, binding };
    };
    const duel = build('N=50†N{=}50^{\\dagger}');
    assert.equal(duel.article.includes('N=50†N{=}50^{\\dagger}'), true);
    assert.doesNotThrow(() => deep.validateApiReaderTablePasteDuplication(
        duel.article, { tableBindings: [duel.binding] }));
    // 裸数字粘连仍拒绝，且不因投影把半值猜成 5.1。
    const glued = build('5.15.1 %');
    assert.throws(() => deep.validateApiReaderTablePasteDuplication(
        glued.article, { tableBindings: [glued.binding] }), /粘连复写/);
});

test('未知 TeX 命令在 selection 资格与渲染阶段都被拒绝，与完整表一致', () => {
    const table = sourceTable([['Method', 'Score'], ['A', '\\unknowncommand'], ['B', '2.0']]);
    const eligible = assessReaderTableSelectionEligibility(table);
    assert.equal(eligible.eligible, false);
    assert.ok(eligible.reasonCodes.includes('unresolved_source_tex'));
    assert.equal(assessReaderCompleteTableEligibility(table).eligible, false);
    assert.throws(() => renderReaderTableSelection(selection(table), { tables: [table] }),
        /unresolved_source_tex/);
    assert.throws(() => renderReaderCompleteTable({
        tableIndex: 1, completeTable: { sourceTableOrdinal: 1 },
    }, { tables: [table] }), /unresolved_source_tex/);
});
