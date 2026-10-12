'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReaderTableSelection } = require('../scripts/lib/reader-tables');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');

test('误标表头的测量行保持拒选，完整表路线逐格保留跨行单位与数据', () => {
    const matrix = [
        ['Set', 'n', 'p50', 'F1', 'False read', 'Spec calls', 'Wasted'],
        ['', '', '(s)', '(%)', '(%)', '', 'calls'],
        ['Hard negatives', '22', '6.24', 'N/A', '9.1', '2', '2'],
        ['Adversarial', '24', '8.40', '90.2', '12.3', '21', '21']
    ];
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64),
        headerRows: [0, 2], bodyRows: [1, 3], matrix,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
            rowspan: 1, colspan: 1, header: r === 0 || r === 2, text, sourceDomSha256: 'b'.repeat(64) }))) };
    const artifacts = { tables: [table] };
    const before = JSON.stringify(artifacts);
    assert.throws(() => renderReaderTableSelection({ tableIndex: 1, selection: {
        sourceTableOrdinal: 1, sourceRows: [0, 2, 3], sourceColumns: [0, 1, 2, 3, 4, 5, 6]
    } }, artifacts), error => /第一行必须是原表头/.test(error.message)
        && /completeTable/.test(error.message) && /本 binding 已获整项修复授权/.test(error.message));
    const compiled = normalizeReaderDraftOrder({ sections: [{ kind: 'result', body: '比较问题。\n\n[[TABLE_1]]\n\n结果限制。' }],
        tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }] }, { structuredArtifacts: artifacts }).draft;
    assert.equal(compiled.tableBindings[0].cellBindings.length, 28);
    assert.match(compiled.sections[0].body, /\|  \|  \| \(s\) \| \(%\) \| \(%\) \|  \| calls \|/);
    assert.match(compiled.sections[0].body, /Hard negatives \| 22 \| 6.24 \| N\/A \| 9.1 \| 2 \| 2/);
    assert.equal(JSON.stringify(artifacts), before);
    const broken = structuredClone(artifacts);
    broken.tables[0].cells.pop();
    assert.throws(() => normalizeReaderDraftOrder({ sections: [{ kind: 'result', body: '[[TABLE_1]]' }],
        tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }] }, { structuredArtifacts: broken }), /坐标/);
});
