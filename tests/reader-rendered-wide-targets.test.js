'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const table = '| 方法 | 条件 | 指标甲 | 指标乙 | 指标丙 |\n| --- | --- | --- | --- | --- |\n| A | 同设置 | 1 | 2 | 3 |\n| B | 同设置 | 4 | 5 | 6 |';
function sample() {
    return { version: 3, readerTitle: '测试', oneSentenceThesis: '测试',
        conceptBridges: [], figurePlacements: [], formulaBindings: [],
        tableBindings: [0, 1].map(index => ({ tableIndex: index + 1,
            sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['测试用完整来源逐字引文。'] })),
        sections: [
            { kind: 'result', heading: '结果', body: '较长的完整结果说明。'.repeat(30) + '\n\n' + table + '\n\n结果保持原事实。' },
            { kind: 'ablation', heading: '消融', body: '比较条件。\n\n' + table + '\n\n条件限制。' }
        ] };
}
function issue(draft) {
    return { message: '读者文章至少需要2张5列以上的宽表，当前1张',
        renderedTableDiagnostics: { draftSha256: repair.hashDraft(draft), tables: [{
            reason: 'source_quote_unsupported_columns', bindingIndex: 0,
            originalColumnCount: 5, renderedColumnCount: 2,
            removedHeaders: ['指标甲', '指标乙', '指标丙']
        }] } };
}
function paths(draft, issues) {
    return repair.buildRepairTargets(draft, issues).map(target => target.path).sort();
}
test('实际削窄诊断优先选择正确绑定与正文，不选仍合法的短5列表', () => {
    const draft = sample();
    assert.deepEqual(paths(draft, [issue(draft)]), ['/sections/0/body', '/tableBindings/0']);
});
test('旧SHA、伪列宽和仍5列诊断不获得来源修剪优先权', () => {
    const draft = sample();
    for (const mutate of [
        value => { value.renderedTableDiagnostics.draftSha256 = '0'.repeat(64); },
        value => { value.renderedTableDiagnostics.tables[0].originalColumnCount = 6; },
        value => { value.renderedTableDiagnostics.tables[0].renderedColumnCount = 5; }
    ]) {
        const value = issue(draft);
        mutate(value);
        assert.deepEqual(paths(draft, [value]), ['/sections/1/body', '/tableBindings/1']);
    }
});
test('普通窄表仍走原选择流程，不扩大到另一张合法5列表', () => {
    const draft = sample();
    draft.sections[0].body = draft.sections[0].body.replace(table,
        '| 方法 | 值 | 条件 |\n| --- | --- | --- |\n| A | 1 | 同设置 |');
    assert.deepEqual(paths(draft, [{ message: '读者文章至少需要2张5列以上的宽表，当前1张' }]),
        ['/sections/0/body', '/tableBindings/0']);
});
