'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreReaderSelectedTableBytes } = require('../scripts/deep-analyzer');
const { extractMarkdownTables } = require('../scripts/analysis-contract');
function createTableSample() {
    const matrix = [['Model', 'Score (%)', 'Score (%)'], ['Model', 'Dev', 'Test'],
        ['Base', '92.45', '95.19'], ['Ours', '93.15', '96.18']];
    const cell = (row, column, text, extra = {}) => ({ row, column, text,
        sourceDomSha256: 'a'.repeat(64), rowspan: 1, colspan: 1, ...extra });
    const source = { ordinal: 1, recoveryStatus: 'complete', matrix, cells: [
        cell(0, 0, 'Model', { header: true, rowspan: 2 }),
        cell(0, 1, 'Score (%)', { colspan: 2 }),
        cell(1, 1, 'Dev'), cell(1, 2, 'Test'),
        ...matrix.slice(2).flatMap((row, index) => row.map((text, column) => cell(index + 2, column, text)))
    ] };
    const binding = { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        cellBindings: matrix.flatMap((row, r) => row.map((_text, c) => ({ renderedRow: r,
            renderedColumn: c, sourceRow: r, sourceColumn: c }))), sourceQuotes: [] };
    return { article: '| Model | Score Dev (%) | Score Test (%) |\n| --- | --- | --- |\n'
        + '| Base | 92.45 | 95.19 |\n| Ours | 93.15 | 96.18 |', binding, source };
}
const restore = sample => restoreReaderSelectedTableBytes(sample.article, [sample.binding], { tables: [sample.source] });
test('完整identity与唯一DOM证明下只恢复被合并的两层表头，保留所有数据值及顺序', () => {
    const sample = createTableSample(), frozen = JSON.stringify(sample);
    const out = restore(sample), table = extractMarkdownTables(out)[0];
    assert.deepEqual([table.header, ...table.rows], sample.source.matrix);
    assert.equal(JSON.stringify(sample), frozen);
    assert.deepEqual(table.rows.slice(1), extractMarkdownTables(sample.article)[0].rows);
    assert.equal(restore({ ...sample, article: out }), out);
});
for (const [name, alter] of Object.entries({
    '错数字': sample => { sample.article = sample.article.replace('92.45', '99.45'); },
    '错单位': sample => { sample.article = sample.article.replaceAll('(%)', '(ms)'); },
    '错列头': sample => { sample.article = sample.article.replace('Score Dev', 'Other Dev'); },
    '删数据行': sample => { sample.article = sample.article.split('\n').slice(0, -1).join('\n'); },
    '乱数据行': sample => { const lines = sample.article.split('\n'); [lines[2], lines[3]] = [lines[3], lines[2]]; sample.article = lines.join('\n'); },
    '删数据列': sample => { sample.article = sample.article.split('\n').map(line => line.split('|').slice(0, -2).join('|') + '|').join('\n'); },
    '缺绑定': sample => { sample.binding.cellBindings.pop(); },
    '重绑定': sample => { sample.binding.cellBindings[1] = { ...sample.binding.cellBindings[0] }; },
    '越界': sample => { sample.binding.cellBindings[0].sourceRow = 7; },
    '非identity': sample => { sample.binding.cellBindings[0].sourceRow = 1; },
    '缺DOM': sample => { sample.source.cells.pop(); },
    '重DOM': sample => { sample.source.cells.push({ ...sample.source.cells[0] }); },
    '坏SHA': sample => { sample.source.cells[0].sourceDomSha256 = ''; },
    '无跨行头': sample => { sample.source.cells[0].rowspan = 1; },
    '无表头锚': sample => { sample.source.cells[0].header = false; },
    '原格与矩阵不符': sample => { sample.source.cells.at(-1).text = '99'; }
})) test(`多层表头恢复拒绝${name}`, () => {
    const sample = createTableSample(); alter(sample); assert.throws(() => restore(sample));
});
