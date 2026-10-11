'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair.js');
const issue = { code: 'reader_table_binding_order_ambiguous', path: '/tableBindings/1', message: '表格与来源顺序存在缺口' };
const table = '\n\n| 方法 | 得分甲 | 得分乙 |\n|---|---|---|\n| 基线 | 10 | 20 |\n| 新方法 | 30 | 40 |\n\n';
function createArticle() {
    return { version: 3, readerTitle: '声音方法的证据比较', sections: [
        { kind: 'experiment_setup', heading: '实验协议', body: '固定协议。\n\n[[TABLE_1]]\n\n已有设置解释。' },
        { kind: 'result', heading: '主要结果', body: '同协议比较结果。\n\n[[TABLE_3]]\n\n原有选择表解释。' }
    ], tableBindings: [
        { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1] } },
        { tableIndex: 2, sourceType: 'source_quotes', sourceQuotes: ['基线得分10和20，新方法得分30和40。'] },
        { tableIndex: 3, selection: { sourceTableOrdinal: 3, sourceRows: [0, 1], sourceColumns: [0, 1] } }
    ], figurePlacements: [], formulaBindings: [], conceptBridges: [] };
}
function applyAddition(draft, context, body) {
    const operation = context.atomicOperation;
    const replacements = [[operation.destinationSectionPath, body], [operation.bindingPath, draft.tableBindings[1]]]
        .map(([path, value]) => {
            let original = draft;
            for (const key of path.slice(1).split('/')) original = original[key];
            return { path, value, oldSha256: repair.hashDraft(original) };
        });
    return repair.applyReaderPatch(draft, { version: 1, draftSha256: repair.hashDraft(draft), replacements },
        context.targets.map(target => target.path), { atomicOperation: operation });
}
test('唯一内部引文缺表在下一选择标记之前补入，保留所有旧表标记和来源', () => {
    const draft = createArticle();
    const context = repair.buildRepairContext(draft, [issue], '完整来源');
    assert.equal(context.atomicOperation.insertionBeforeMarker, '[[TABLE_3]]');
    assert.equal(context.atomicOperation.bindingIndex, 1);
    const next = applyAddition(draft, context, draft.sections[1].body.replace('[[TABLE_3]]', table + '[[TABLE_3]]'));
    assert.equal(next.sections[0].body, draft.sections[0].body);
    assert.deepEqual(next.tableBindings, draft.tableBindings);
    assert.ok(next.sections[1].body.endsWith('[[TABLE_3]]\n\n原有选择表解释。'));
});
test('多处缺表或重复选择标记不推断唯一插入位置', () => {
    for (const mode of ['two_gaps', 'duplicate']) {
        const draft = createArticle();
        if (mode === 'two_gaps') draft.sections[0].body = '固定协议但缺少第一张表。';
        else draft.sections[0].body += '\n\n[[TABLE_3]]';
        const context = repair.buildRepairContext(draft, [issue], '完整来源');
        assert.equal(context.atomicOperation?.insertionBeforeMarker, undefined);
    }
});
test('内部补表不得移除下一选择标记', () => {
    const draft = createArticle();
    const context = repair.buildRepairContext(draft, [issue], '完整来源');
    const body = draft.sections[1].body.replace('[[TABLE_3]]', table);
    assert.throws(() => applyAddition(draft, context, body), /atomic table-add postconditions/);
});
