'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');

function createTableSample() {
    const matrix = [['Method', 'Score'], ['Ours', '0.91']];
    const source = { tables: [{ ordinal: 1, recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64), matrix,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, rowspan: 1, colspan: 1, text,
            sourceDomSha256: 'b'.repeat(64)
        }))) }] };
    const artifact = { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [], cellBindings: matrix.flatMap((row, r) => row.map((_, c) => ({
            renderedRow: r, renderedColumn: c, sourceRow: r, sourceColumn: c
        }))) };
    const quote = { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: ['sample-rate 16 kHz'] };
    const draft = { sections: [
        { kind: 'experiment_setup', heading: '设置', body: '| Setting | Value |\n| --- | --- |\n| sample-rate | 16 kHz |' },
        { kind: 'result', heading: '结果', body: '| Method | Score |\n| --- | --- |\n| Ours | 0.91 |' }
    ], tableBindings: [artifact, quote], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    return { source, draft };
}

test('小节已正确排序时也按唯一原格和引文重排来源声明，不改变正文或坐标', () => {
    const { source, draft } = createTableSample();
    const original = structuredClone(draft);
    const result = normalizeReaderDraftOrder(draft, { structuredArtifacts: source });
    assert.deepEqual(draft, original);
    assert.deepEqual(result.draft.sections, original.sections);
    assert.deepEqual(result.draft.tableBindings, [
        { ...original.tableBindings[1], tableIndex: 1 },
        { ...original.tableBindings[0], tableIndex: 2 }
    ]);
    assert.deepEqual(normalizeReaderDraftOrder(result.draft, { structuredArtifacts: source }).draft,
        result.draft);
});

for (const [name, change] of [
    ['错一格', sample => { sample.draft.sections[1].body = sample.draft.sections[1].body.replace('0.91', '0.92'); }],
    ['坐标越界', sample => { sample.draft.tableBindings[0].cellBindings[0].sourceRow = 10; }],
    ['原表没有完整来源', sample => { sample.source.tables[0].recoveryStatus = 'partial'; }],
    ['重复候选表导致歧义', sample => {
        sample.draft.sections[0].body = sample.draft.sections[1].body;
        sample.draft.tableBindings[1].sourceQuotes = ['Ours 0.91'];
    }]
]) {
    test(`不根据${name}猜测表格来源`, () => {
        const sample = createTableSample();
        change(sample);
        const original = structuredClone(sample.draft.tableBindings);
        const result = normalizeReaderDraftOrder(sample.draft, { structuredArtifacts: sample.source });
        assert.deepEqual(result.draft.tableBindings, original);
    });
}
