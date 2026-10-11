'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');

function createTableSample() {
    const matrix = [['Method', 'Score'], ['Baseline', '12'], ['Proposed', '15']];
    const table = {
        ordinal: 1,
        recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64),
        matrix,
        cells: matrix.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
            row: rowIndex, column: columnIndex, text, rowspan: 1, colspan: 1,
            sourceDomSha256: 'b'.repeat(64)
        })))
    };
    const draft = {
        sections: [{ kind: 'result', body: '比较同一协议。\n\n[[TABLE_1]]\n\n结果说明。' }],
        tableBindings: [{
            tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
            sourceQuotes: [],
            cellBindings: matrix.flatMap((row, rowIndex) => row.map((_, columnIndex) => ({
                renderedRow: rowIndex, renderedColumn: columnIndex,
                sourceRow: rowIndex, sourceColumn: columnIndex
            })))
        }]
    };
    return { draft, structuredArtifacts: { tables: [table] } };
}

test('唯一完整原表标记恢复原矩阵并保留原始输入和绑定', () => {
    const { draft, structuredArtifacts } = createTableSample();
    const original = JSON.stringify({ draft, structuredArtifacts });
    const result = normalizeReaderDraftOrder(draft, { structuredArtifacts });
    assert.match(result.draft.sections[0].body, /\| Method \| Score \|\n\| --- \| --- \|\n\| Baseline \| 12 \|\n\| Proposed \| 15 \|/);
    assert.deepEqual(result.draft.tableBindings, draft.tableBindings);
    assert.equal(JSON.stringify({ draft, structuredArtifacts }), original);
});

const invalidCases = {
    '缺少原格': ({ draft }) => draft.tableBindings[0].cellBindings.pop(),
    '错位坐标': ({ draft }) => { draft.tableBindings[0].cellBindings[1].sourceColumn = 0; },
    '重复坐标': ({ draft }) => { draft.tableBindings[0].cellBindings[1] = draft.tableBindings[0].cellBindings[0]; },
    '重复标记': ({ draft }) => { draft.sections[0].body += '\n\n[[TABLE_1]]'; },
    '非独占标记': ({ draft }) => { draft.sections[0].body = '文字[[TABLE_1]]文字'; },
    '伪造数字与DOM不符': ({ structuredArtifacts }) => { structuredArtifacts.tables[0].matrix[1][1] = '999'; },
    'DOM缺SHA': ({ structuredArtifacts }) => { structuredArtifacts.tables[0].cells[1].sourceDomSha256 = ''; },
    '原表不完整': ({ structuredArtifacts }) => { structuredArtifacts.tables[0].recoveryStatus = 'partial'; },
    '额外推断字段': ({ draft }) => { draft.tableBindings[0].extra = true; },
    '非法子集': ({ draft }) => { draft.tableBindings[0].cellBindings = draft.tableBindings[0].cellBindings.slice(0, 4); }
};
for (const [name, change] of Object.entries(invalidCases)) {
    test(`完整原表恢复拒绝${name}`, () => {
        const input = createTableSample();
        change(input);
        assert.throws(() => normalizeReaderDraftOrder(input.draft, input), /不能自动恢复/);
    });
}

test('source_quotes及selection标记不进入完整原表恢复路径', () => {
    for (const sourceType of ['source_quotes', 'artifact_table']) {
        const input = createTableSample();
        input.draft.tableBindings[0].sourceType = sourceType;
        if (sourceType === 'artifact_table') input.draft.tableBindings[0].selection = {};
        const result = normalizeReaderDraftOrder(input.draft, input);
        assert.match(result.draft.sections[0].body, /\[\[TABLE_1\]\]/);
    }
});

test('缺少来源上下文时延期恢复，错误来源上下文仍拒绝', () => {
    const { draft } = createTableSample();
    const original = JSON.stringify(draft);
    const deferred = normalizeReaderDraftOrder(draft);
    assert.match(deferred.draft.sections[0].body, /\[\[TABLE_1\]\]/);
    assert.equal(JSON.stringify(draft), original);
    assert.throws(() => normalizeReaderDraftOrder(draft, { structuredArtifacts: { tables: [] } }), /不能自动恢复/);
});
