'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');

function createTableSample(reference = 'Table 2') {
    const binding = (tableIndex, quote) => ({ tableIndex, sourceType: 'source_quotes',
        sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [quote] });
    return { sections: [
        { kind: 'experiment_setup', heading: '设置', body: '| Setting | Count |\n| --- | --- |\n| requests | 20 |' },
        { kind: 'result', heading: '结果', body: '| Method | Improvement |\n| --- | --- |\n| Ours | 12.9% |' }
    ], tableBindings: [binding(1, `${reference} reports an improvement of 12.9%.`),
        binding(2, 'There are 20 requests.')], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
}

test('显式来源表图编号不当成表内观测值，原完整引文逐字保留', () => {
    for (const reference of ['Table 2', 'Figure 4', '表2', '图4']) {
        const original = createTableSample(reference);
        const before = structuredClone(original);
        const { draft } = normalizeReaderDraftOrder(original);
        assert.deepEqual(original, before);
        assert.deepEqual(draft.sections, before.sections);
        assert.deepEqual(draft.tableBindings.map(binding => binding.sourceQuotes),
            [before.tableBindings[1].sourceQuotes, before.tableBindings[0].sourceQuotes]);
    }
});

for (const [name, change] of [
    ['真实12.9%漏出表格', draft => { draft.sections[1].body = draft.sections[1].body.replace('12.9%', '13.9%'); }],
    ['普通观测数字2仍需对应', draft => { draft.tableBindings[0].sourceQuotes[0] = 'Observed 2 samples improve by 12.9%.'; }],
    ['百分比不当作引用编号', draft => { draft.tableBindings[0].sourceQuotes[0] = 'Table 2% reports an improvement of 12.9%.'; }],
    ['全角百分比不当作引用编号', draft => { draft.tableBindings[0].sourceQuotes[0] = 'Figure 4％ reports an improvement of 12.9%.'; }],
    ['非整数引用不被截断', draft => { draft.tableBindings[0].sourceQuotes[0] = 'Table 2.5 reports an improvement of 12.9%.'; }],
    ['重复候选表有歧义', draft => {
        draft.sections[0].body = draft.sections[1].body;
        draft.tableBindings[1].sourceQuotes[0] = 'Figure 4 reports 12.9%.';
    }]
]) {
    test(`引用编号例外不放行${name}`, () => {
        const original = createTableSample();
        change(original);
        assert.deepEqual(normalizeReaderDraftOrder(original).draft.tableBindings, original.tableBindings);
    });
}
