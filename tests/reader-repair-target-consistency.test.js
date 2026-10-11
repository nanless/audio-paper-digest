'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRepairContext, applyReaderPatch, hashDraft } = require('../scripts/lib/reader-repair');

function missingTableDraft() {
    const draft = { version: 3, readerTitle: '结果表与修改范围', oneSentenceThesis: '只补已有来源的结果表。',
        sections: Array.from({ length: 12 }, (_, index) => ({ kind: index === 7 ? 'result'
            : index === 11 ? 'ablation' : 'component', heading: `第 ${index + 1} 节`, body: '已有正文。' })),
        conceptBridges: [], figurePlacements: [], formulaBindings: [],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['方法甲在同一测试集得到 10、20、30、40。'] }] };
    return draft;
}

function tableIssues() {
    return [{ code: 'reader_table_binding_order_ambiguous', path: '/tableBindings/0',
        message: '重排正文前，表格与来源记录不能一一对应。' },
    { code: 'reader_result_table_missing', path: null, message: '读者文章主结果表覆盖不足：缺少数字结果表。' }];
}

function patchFor(draft, entries) {
    return { version: 1, draftSha256: hashDraft(draft), replacements: entries.map(([pointer, value]) => {
        const old = pointer.slice(1).split('/').reduce((node, part) => node[part], draft);
        return { path: pointer, oldSha256: hashDraft(old), value };
    }) };
}

test('缺少结果表且对应顺序不清时，指令与允许修改的小节一致', () => {
    const draft = missingTableDraft();
    const context = buildRepairContext(draft, tableIssues(), '完整论文证据');
    assert.equal(context.atomicOperation.kind, 'add_result_table_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/sections/7/body', '/tableBindings/0']);
    assert.deepEqual(context.atomicOperation.requiredReplacementPaths, context.targets.map(target => target.path));
    const table = '\n\n| 方法 | A | B | C | D |\n| --- | --- | --- | --- | --- |\n| 甲 | 10 | 20 | 30 | 40 |';
    const merged = applyReaderPatch(draft, patchFor(draft, [
        ['/sections/7/body', draft.sections[7].body + table],
        ['/tableBindings/0', structuredClone(draft.tableBindings[0])]
    ]), context.targets.map(target => target.path), { atomicOperation: context.atomicOperation });
    assert.equal(merged.sections[7].body, draft.sections[7].body + table);
    assert.equal(merged.sections[11].body, draft.sections[11].body);
    assert.deepEqual(merged.tableBindings, draft.tableBindings);
});

test('表格修改仍拒绝漏项、越界修改和过期正文', () => {
    const draft = missingTableDraft();
    const context = buildRepairContext(draft, tableIssues(), '完整论文证据');
    const allowed = context.targets.map(target => target.path);
    assert.throws(() => applyReaderPatch(draft, patchFor(draft, [
        ['/tableBindings/0', structuredClone(draft.tableBindings[0])]
    ]), allowed, { atomicOperation: context.atomicOperation }), /every required atomic target/);
    assert.throws(() => applyReaderPatch(draft, patchFor(draft, [
        ['/sections/11/body', '越界修改']
    ]), allowed, { atomicOperation: context.atomicOperation }), /unknown or unauthorized target/);
    const stale = patchFor(draft, [['/sections/7/body', '修改正文']]);
    stale.replacements[0].oldSha256 = '0'.repeat(64);
    assert.throws(() => applyReaderPatch(draft, stale, allowed), /stale node SHA/);
});

test('先修术语解释位置时，不附带未授权的补表指令', () => {
    const draft = missingTableDraft();
    draft.conceptBridges = [{ terms: ['声学表示', '语义条件'], sectionKind: 'component',
        marker: '[[CONCEPT_BRIDGE_1]]', explanation: '声学表示保留声音中的结构，语义条件限定内容范围。两者先后配合，让预测同时使用声音信息与当前任务的内容限制。' }];
    draft.sections[0].body += '[[CONCEPT_BRIDGE_1]]';
    const context = buildRepairContext(draft, [{ path: '/conceptBridges/0',
        message: 'conceptBridges[0] marker 必须唯一独占一段并位于声明 kind 小节' }, ...tableIssues()], '完整论文证据');
    assert.deepEqual(context.targets.map(target => target.path), ['/sections/0/body']);
    assert.equal(context.atomicOperation, null);
});

test('所有已发现问题不会扩大本轮允许范围，越界回执明确指出目标', () => {
    const draft = missingTableDraft();
    draft.conceptBridges = Array.from({ length: 6 }, (_, index) => ({
        terms: ['术语甲', '术语乙'], sectionKind: 'component',
        marker: `[[CONCEPT_BRIDGE_${index + 1}]]`, explanation: '已有解释。', marker_note: ''
    }));
    draft.conceptBridges.forEach((bridge, index) => {
        draft.sections[index].body += `\n\n${bridge.marker}\n\n`;
    });
    const issues = draft.conceptBridges.map((_, index) => ({
        path: `/conceptBridges/${index}`, message: '包含额外字段 marker_note'
    }));
    const context = buildRepairContext(draft, issues, '完整原文证据');
    const allowedPaths = context.targets.map(target => target.path);
    assert.ok(allowedPaths.filter(pointer => pointer.startsWith('/conceptBridges/')).length < 6);
    assert.match(context.targetGuidance, /列出问题不代表授权修改/);
    assert.match(context.targetGuidance, /真实 oldSha256/);
    assert.ok(context.targetGuidance.includes(JSON.stringify(allowedPaths)));
    const unauthorizedPath = issues.find(issue => !allowedPaths.includes(issue.path)).path;
    const patch = patchFor(draft, [[unauthorizedPath, structuredClone(draft.conceptBridges[2])]]);
    patch.replacements[0].oldSha256 = 'PLACEHOLDER_2';
    assert.throws(() => applyReaderPatch(draft, patch, allowedPaths), error => {
        assert.ok(error.message.includes(`本次未授权目标：${JSON.stringify(unauthorizedPath)}`));
        assert.ok(error.message.includes(`本次允许目标：${JSON.stringify(allowedPaths)}`));
        return true;
    });
    assert.equal(draft.conceptBridges.length, 6);
    assert.equal(draft.conceptBridges[2].marker_note, '');
});
