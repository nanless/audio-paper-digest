'use strict';
// 全幅分组标题行被当作唯一表头、而所选列里没有任何列名文字时，渲染表头全空，
// 读者看不到列名，发布端逐格核对也无法对应；选择编译必须拒绝并提示选真正的表头行。
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReaderTableSelection } = require('../scripts/lib/reader-tables.js');

const sha = 'b'.repeat(64);
function table() {
    const matrix = [
        ['t', 'System', '2-way', '3-way'],
        ['Baselines', 'Baselines', 'Baselines', 'Baselines'],
        ['t', 'Majority class', '52.0', '48.0'],
        ['t', 'Word majority', '80.7', '62.0'],
    ];
    const cells = [
        { row: 0, column: 0, text: 't', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 1, text: 'System', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 2, text: '2-way', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 3, text: '3-way', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 1, column: 0, text: 'Baselines', header: true, rowspan: 1, colspan: 4, sourceDomSha256: sha },
    ];
    for (const row of [2, 3]) for (let column = 0; column < 4; column += 1) {
        cells.push({ row, column, text: matrix[row][column], header: false, rowspan: 1, colspan: 1, sourceDomSha256: sha });
    }
    return { ordinal: 3, caption: 'Results', recoveryStatus: 'complete', sourceDomSha256: sha,
        matrix, headerRows: [0, 1], bodyRows: [2, 3], cells };
}

test('以全幅分组标题行作唯一表头且所选列无文字时拒绝，真正表头行则通过', () => {
    const artifacts = { tables: [table()] };
    const bad = { tableIndex: 1, selection: { sourceTableOrdinal: 3, sourceRows: [1, 2, 3], sourceColumns: [1, 2, 3] } };
    assert.throws(() => renderReaderTableSelection(bad, artifacts), /渲染表头全为空/);
    const good = { tableIndex: 1, selection: { sourceTableOrdinal: 3, sourceRows: [0, 2, 3], sourceColumns: [1, 2, 3] } };
    const rendered = renderReaderTableSelection(good, artifacts);
    assert.match(rendered.markdown, /^\| System \| 2-way \| 3-way \|/);
});
