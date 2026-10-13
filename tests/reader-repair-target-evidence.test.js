'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');

test('术语组合保留2–4项且拒绝重复、空值和越界', () => {
    for (const terms of [
        ['冗余', '协同'], ['冗余', '协同', '部分信息分解'],
        ['概念甲', '概念乙', '概念丙', '概念丁']
    ]) assert.equal(repair.conceptBridgeTermsDiagnostic(terms, 0), null);
    for (const terms of [
        ['冗余'], ['冗余', '协同', '甲乙', '丙丁', '戊己'],
        ['冗余', '冗余'], ['冗余', ''], ['冗余', 'K']
    ]) assert.ok(repair.conceptBridgeTermsDiagnostic(terms, 0));
});

test('正文修复不夹带无关表操作，来源修改保留完整协议', () => {
    assert.ok(!repair.repairOperationProtocol({ targets: [{ path: '/sections/0/body' }] })
        .includes('completeTable'));
    const protocol = repair.repairOperationProtocol({ targets: [{ path: '/tableBindings/0' }] });
    for (const text of ['eligible=false', '逐格', 'completeTable', 'source_quotes',
        'delete_top_level_program_metadata_v1']) assert.ok(protocol.includes(text), text);
});

function sampleDraft() {
    return {
        sections: [
            { kind: 'background', body: '背景'.repeat(180) },
            { kind: 'method_overview', body: '机制'.repeat(120) },
            { kind: 'result', body: '[[TABLE_1]]\n\n结果' }
        ],
        conceptBridges: [], tableBindings: [], formulaBindings: [], figurePlacements: []
    };
}

test('只缺18字时定位实际方法小节，保留完整来源、5000字要求和余量', () => {
    for (const issue of [
        { message: '读者文章中文字数必须为 5000-18000，当前 4982' },
        { code: 'reader_length_preflight', diagnosticOnly: true,
            message: '读者文章篇幅预估为 4982 个汉字（标题、正文和术语组合解释；不含来源对应记录），完整文章要求 5000–18000 个汉字；目前估计至少还需 18 字。' }
    ]) {
        const context = repair.buildRepairContext(sampleDraft(), [issue], '完整来源及资源状态');
        assert.deepEqual(context.targets.map(target => target.path), ['/sections/1/body']);
        assert.ok(context.targetGuidance.includes('100中文字'));
        assert.equal(context.evidence, '完整来源及资源状态');
    }
});

test('超长文章不误走扩写，方法段有手写表格时选择其他正文', () => {
    const overlong = repair.buildRepairContext(sampleDraft(), [
        { message: '读者文章中文字数必须为 5000-18000，当前 19000' }
    ], '完整来源');
    assert.deepEqual(overlong.targets.map(target => target.path), [
        '/sections/0/body', '/sections/1/body', '/sections/2/body'
    ]);
    assert.ok(!overlong.targetGuidance.includes('100中文字'));
    const draft = sampleDraft();
    draft.sections[1].body += '\n| 项目 | 值 |\n| --- | --- |\n| 原值 | 1 |';
    const shorter = repair.buildRepairContext(draft, [
        { message: '读者文章中文字数必须为 5000-18000，当前 4982' }
    ], '完整来源');
    assert.deepEqual(shorter.targets.map(target => target.path), ['/sections/0/body']);
});

test('正文长度与其他错误并存时，不让窄扩写吞掉其他段落的修改范围', () => {
    const context = repair.buildRepairContext(sampleDraft(), [
        { message: '读者文章中文字数必须为 5000-18000，当前 4982' },
        { path: '/sections/0/body', message: '背景说明中有需按原文核对的错误。' }
    ], '完整来源');
    assert.ok(context.targets.some(target => target.path === '/sections/0/body'));
    assert.ok(context.targets.some(target => target.path === '/sections/2/body'));
});
