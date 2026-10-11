'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createArticle() {
    return { sections: [{ kind: 'result', heading: '结果', body: '实验表格保持 12.4% 与 9.8% 的比较。\n\n[[FIGURE_1]]\n\n图中展示了教师和学生共享 512 维空间，损失通过 λ 加权。\n\n方法输入和结果限制保持原样。' }],
        figurePlacements: [{ figureOrdinal: 1 }], tableBindings: [{ tableIndex: 1 }], formulaBindings: [] };
}
function createPatch(draft, replacements) {
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: replacements.map(([path, value, old]) => ({ path, value, oldSha256: repair.hashDraft(old) })) };
}
test('没有像素时只清除图绑定和独立标记，其余正文原字保留，保留表格数字与其他正文', () => {
    const draft = createArticle();
    const targets = repair.buildRepairTargets(draft, [{ message: '论文没有可用 Figure，figurePlacements 必须为空' }]);
    assert.deepEqual(targets.map(item => item.path), ['/figurePlacements', '/sections/0/body']);
    const patch = createPatch(draft, targets.map(item => [item.path, item.expectedCleanupValue, item.value]));
    const result = repair.applyReaderPatch(draft, patch, targets.map(item => item.path), { availableFigureOrdinals: [] });
    assert.deepEqual(result.figurePlacements, []);
    assert.equal(result.sections[0].body, '实验表格保持 12.4% 与 9.8% 的比较。\n\n\n图中展示了教师和学生共享 512 维空间，损失通过 λ 加权。\n\n方法输入和结果限制保持原样。');
    assert.deepEqual(result.tableBindings, draft.tableBindings);
});
test('有像素、没有明确像素清单或新增图绑定不能使用无图清除', () => {
    const draft = createArticle();
    const patch = createPatch(draft, [['/figurePlacements', [], draft.figurePlacements]]);
    for (const options of [{}, { availableFigureOrdinals: [1] }]) assert.throws(() => repair.applyReaderPatch(draft, patch, ['/figurePlacements'], options), /无图清除/);
    const added = createPatch(draft, [['/figurePlacements', [{ figureOrdinal: 2 }], draft.figurePlacements]]);
    assert.throws(() => repair.applyReaderPatch(draft, added, ['/figurePlacements'], { availableFigureOrdinals: [] }), /无图清除/);
});
test('清图过程中改变数字或其他节点仍拒绝', () => {
    const draft = createArticle();
    const targets = repair.buildRepairTargets(draft, [{ message: '论文没有可用 Figure，figurePlacements 必须为空' }]);
    const body = targets.find(item => item.path === '/sections/0/body');
    const patch = createPatch(draft, [['/figurePlacements', [], draft.figurePlacements], ['/sections/0/body', body.expectedCleanupValue.replace('12.4%', '99%'), draft.sections[0].body]]);
    assert.throws(() => repair.applyReaderPatch(draft, patch, targets.map(item => item.path), { availableFigureOrdinals: [] }), /必须保留/);
});

test('无图清除不能顺带修改标题', () => {
    const draft = { ...createArticle(), readerTitle: '原论文标题' };
    const patch = createPatch(draft, [['/figurePlacements', [], draft.figurePlacements], ['/readerTitle', '新标题', draft.readerTitle]]);
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/figurePlacements', '/readerTitle'], { availableFigureOrdinals: [] }), /必须保留/);
});


test('无像素时不能将视觉特征描述改成论文事实', () => {
    const draft = createArticle();
    draft.sections[0].body = '图中展示了蓝色曲线沿横轴上升。';
    const patch = createPatch(draft, [['/figurePlacements', [], draft.figurePlacements],
        ['/sections/0/body', '论文描述了蓝色曲线沿横轴上升。', draft.sections[0].body]]);
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/figurePlacements', '/sections/0/body'],
        { availableFigureOrdinals: [] }), /像素|视觉|看图|必须保留/);
});

test('超过八个修复节点时不能只清绑定并漏掉剩余正文', () => {
    const draft = createArticle();
    draft.sections = Array.from({ length: 8 }, () => ({ kind: 'result', heading: '结果', body: '原字事实。\n\n[[FIGURE_1]]\n\n保留结论。' }));
    assert.deepEqual(repair.buildRepairTargets(draft, [{ message: '论文没有可用 Figure，figurePlacements 必须为空' }]), []);
});

test('删除独立标记保留相邻正文的原空白', () => {
    const draft = createArticle();
    draft.sections[0].body = '  原字事实。\n\n\n[[FIGURE_1]]\n\n\n尾段  ';
    const targets = repair.buildRepairTargets(draft, [{ message: '论文没有可用 Figure，figurePlacements 必须为空' }]);
    const body = targets.find(item => item.path === '/sections/0/body');
    assert.equal(body.expectedCleanupValue.replaceAll('\n', ''), '  原字事实。尾段  ');
    assert.ok(body.expectedCleanupValue.startsWith('  原字事实。\n\n\n'));
    assert.ok(body.expectedCleanupValue.endsWith('\n\n\n尾段  '));
});

test('只清图绑定而遗漏正文标记不能通过原子合并', () => {
    const draft = createArticle();
    const patch = createPatch(draft, [['/figurePlacements', [], draft.figurePlacements]]);
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/figurePlacements'],
        { availableFigureOrdinals: [] }), /标记|原子|清除/);
});
