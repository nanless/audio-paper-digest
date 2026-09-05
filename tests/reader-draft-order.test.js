const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder, locateReaderDraftTables } = require('../scripts/lib/reader-draft-order.js');
const { buildRepairTargets, collectDraftIssues } = require('../scripts/lib/reader-repair.js');

const markdown = value => `| Method | Value |\n| --- | --- |\n| ${value} | 12 |`;
const binding = (tableIndex, quote) => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null,
    cellBindings: [], sourceQuotes: [quote] });
function fixture() {
    return { sections: [
        { kind: 'result', heading: 'results', body: markdown('result') },
        { kind: 'ablation', heading: 'ablations', body: markdown('ablation') },
        { kind: 'experiment_setup', heading: 'setup', body: markdown('setup') }
    ], tableBindings: [binding(1, 'result quote'), binding(2, 'ablation quote'), binding(3, 'setup quote')],
    conceptBridges: [], figurePlacements: [], formulaBindings: [] };
}

test('stable section ordering preserves table/binding pairs and records replayable raw mappings', () => {
    const original = fixture();
    const frozen = JSON.stringify(original);
    const { draft, mapping } = normalizeReaderDraftOrder(original);
    assert.equal(JSON.stringify(original), frozen);
    assert.deepEqual(draft.sections.map(item => item.kind), ['experiment_setup', 'result', 'ablation']);
    assert.deepEqual(draft.tableBindings.map(item => item.sourceQuotes[0]), ['setup quote', 'result quote', 'ablation quote']);
    assert.deepEqual(draft.tableBindings.map(item => item.tableIndex), [1, 2, 3]);
    assert.deepEqual(mapping.tables.map(item => item.rawIndex), [2, 0, 1]);
    assert.match(mapping.inputSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(mapping.inputSha256, mapping.outputSha256);
    const again = normalizeReaderDraftOrder(draft);
    assert.deepEqual(again.draft, draft);
    assert.equal(again.mapping.changed, false);
    assert.equal(again.mapping.inputSha256, mapping.outputSha256);
    const targets = buildRepairTargets(draft, [{ message: '读者文章 tableBindings[1] 关键数字缺少 exact quote/cell 证据' }]);
    assert.deepEqual(targets.map(item => item.path), ['/tableBindings/1', '/sections/1/body']);
    assert.match(targets[1].value, /result/);
    assert.doesNotMatch(targets[1].value, /ablation/);
});

test('mixed handwritten/selection tables retain order and simultaneous marker renames do not collide', () => {
    const input = fixture();
    input.sections[0].body = '[[TABLE_1]]\n\n' + markdown('result-second');
    input.sections[1].body = '[[TABLE_3]]';
    input.sections[2].body = '[[TABLE_4]]';
    const select = (tableIndex, sourceTableOrdinal) => ({ tableIndex,
        selection: { sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1] } });
    input.tableBindings = [select(1, 10), binding(2, 'result-second'), select(3, 30), select(4, 40)];
    const { draft } = normalizeReaderDraftOrder(input);
    assert.equal(draft.sections[0].body, '[[TABLE_1]]');
    assert.match(draft.sections[1].body, /^\[\[TABLE_2\]\]/);
    assert.equal(draft.sections[2].body, '[[TABLE_4]]');
    assert.deepEqual(draft.tableBindings.map(item => item.selection?.sourceTableOrdinal || item.sourceQuotes[0]), [40, 10, 'result-second', 30]);
    assert.deepEqual(locateReaderDraftTables(draft).map(item => item.path), [
        '/sections/0/body', '/sections/1/body', '/sections/1/body', '/sections/2/body'
    ]);
    assert.deepEqual(normalizeReaderDraftOrder(draft).draft, draft);
});

test('unsorted ambiguous bindings fail closed with paths on the unchanged input, never discard tables', () => {
    for (const alter of [draft => draft.tableBindings.pop(), draft => { draft.tableBindings[1].tableIndex = 1; },
        draft => { draft.sections[0].body = '[[TABLE_3]]'; }]) {
        const draft = fixture(); alter(draft); const before = JSON.stringify(draft);
        let error;
        try { normalizeReaderDraftOrder(draft); } catch (caught) { error = caught; }
        assert.equal(error?.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
        assert.equal(JSON.stringify(draft), before);
        assert.ok(error.readerIssues.some(issue => issue.path === '/sections/0/body'));
        assert.ok(error.readerIssues.some(issue => issue.path === '/tableBindings/0'));
    }
});

test('structured table diagnostic paths include the exact binding without parsing a message', () => {
    const draft = normalizeReaderDraftOrder(fixture()).draft;
    const targets = buildRepairTargets(draft, [{ path: '/sections/1/body', bindingPath: '/tableBindings/1', message: '表格单位格式不匹配；应检查source quote' }]);
    assert.deepEqual(targets.map(item => item.path), ['/sections/1/body', '/tableBindings/1']);
});

test('stable same-kind sections and non-bound legacy drafts keep all prose and table bytes', () => {
    const draft = fixture(); draft.sections[2].kind = 'result'; delete draft.tableBindings;
    const out = normalizeReaderDraftOrder(draft).draft;
    assert.deepEqual(out.sections.map(item => item.body), [draft.sections[0].body, draft.sections[2].body, draft.sections[1].body]);
    assert.equal(out.tableBindings, undefined);
});
