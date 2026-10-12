'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');

function createNoPixelSample() {
    return {
        version: 3, readerTitle: '来源文字中的方法与结果', oneSentenceThesis: '按原文说明方法与实验。',
        sections: Array.from({ length: 20 }, (_, index) => ({ kind: 'result',
            heading: `来源说明 ${index}`, body: '原文报告结果为 0.99，窗口从 4 到 20。' })),
        figurePlacements: [{ figureOrdinal: 1, targetKind: 'result', marker: '[[FIGURE_1]]',
            focusPoints: ['没有像素时不能据此判断颜色。'] }],
        tableBindings: [], formulaBindings: [], conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['来源证据', '方法解释'], sectionKind: 'result', marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '来源证据限定能够说明的内容，方法解释交代各部分如何连接，两者共同保证说明只覆盖原文支持的范围。'
        }))
    };
}
function makePatch(draft, replacements) {
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: replacements.map(([path, value]) => {
        let old = draft;
        for (const key of path.slice(1).split('/')) old = old[key];
        return { path, oldSha256: repair.hashDraft(old), value };
    }) };
}

test('没有像素的图解先正常局部修复再重排小节', () => {
    const testData = createNoPixelSample();
    testData.sections[6] = { kind: 'result', heading: '图1的颜色怎样变化', body: '红色热图说明结果。',
        marker: '[[FIGURE_1]]', targetKind: 'result' };
    testData.sections[7].heading = '图1的解释边界';
    const context = repair.buildRepairContext(testData, [], '完整来源证据', '完整来源证据',
        { availableFigureOrdinals: [] });
    assert.equal(context.atomicOperation.kind, 'cleanup_unavailable_figures_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/figurePlacements', '/sections/6', '/sections/7']);
    const replacements = [
        ['/figurePlacements', []],
        ['/sections/6', { kind: 'result', heading: '原文报告的结果', body: '原文报告结果为 0.99，窗口从 4 到 20。' }],
        ['/sections/7', { ...testData.sections[7], heading: '结果的文字证据边界' }]
    ];
    const merged = repair.applyReaderPatch(testData, makePatch(testData, replacements),
        context.targets.map(target => target.path), { availableFigureOrdinals: [], atomicOperation: context.atomicOperation });
    assert.deepEqual(merged.figurePlacements, []);
    assert.deepEqual(merged.sections[0], testData.sections[0]);
    assert.deepEqual(merged.tableBindings, testData.tableBindings);
    const next = repair.buildRepairContext(merged, [], '', '', { availableFigureOrdinals: [] });
    assert.equal(next.atomicOperation.kind, 'reorganize_existing_sections_v1');
    assert.deepEqual(next.targets.map(target => target.path), ['/sections']);
});

test('真实像素未知或存在时不能取得无图清理权限', () => {
    const testData = createNoPixelSample();
    testData.sections[6].heading = '图1的解读';
    for (const options of [{}, { availableFigureOrdinals: [1] }]) {
        const context = repair.buildRepairContext(testData, [], '', '', options);
        assert.equal(context.atomicOperation.kind, 'reorganize_existing_sections_v1');
    }
});

test('无图清理必须完整授权且不得改其他节点或保留图标记', () => {
    const testData = createNoPixelSample();
    testData.sections[6].heading = '图1的解读';
    testData.sections[6].body = '[[TABLE_1]]';
    const context = repair.buildRepairContext(testData, [], '', '', { availableFigureOrdinals: [] });
    const options = { availableFigureOrdinals: [], atomicOperation: context.atomicOperation };
    const allowed = context.targets.map(target => target.path);
    assert.throws(() => repair.applyReaderPatch(testData, makePatch(testData, [['/figurePlacements', []]]), allowed, options), /完整且精确/);
    assert.throws(() => repair.applyReaderPatch(testData, makePatch(testData, [
        ['/figurePlacements', []], ['/sections/6', { ...testData.sections[6], body: '[[FIGURE_1]]' }]
    ]), allowed, options), /not included as pixels/);
    assert.throws(() => repair.applyReaderPatch(testData, makePatch(testData, [
        ['/figurePlacements', []], ['/sections/6', { ...testData.sections[6], body: '删除原表。' }]
    ]), allowed, options), /不能改变表格/);
    assert.throws(() => repair.applyReaderPatch(testData, makePatch(testData, [
        ['/figurePlacements', []], ['/sections/6', testData.sections[6]], ['/sections/0', testData.sections[0]]
    ]), allowed, options), /未授权目标/);
});

test('其他修复请求没传该图像素时新增图标记仍严格拒绝', () => {
    const testData = createNoPixelSample();
    const patch = makePatch(testData, [['/sections/0/body', '新增 [[FIGURE_3]] 进行看图解释。']]);
    assert.throws(() => repair.applyReaderPatch(testData, patch, ['/sections/0/body'],
        { availableFigureOrdinals: [] }), /not included as pixels/);
});
