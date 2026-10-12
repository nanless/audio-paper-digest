'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createSample() {
    return { version: 3, readerTitle: '论文解读', oneSentenceThesis: '论文方法与结果。',
        sections: [{ kind: 'method_overview', heading: '方法',
            body: '图前导读。'.repeat(10) + '\n\n[[FIGURE_1]]\n\n' + '图后解释。'.repeat(12) }],
        figurePlacements: [{ figureOrdinal: 1, targetKind: 'method_overview', marker: '[[FIGURE_1]]',
            focusPoints: ['图'.repeat(121), '从原图左侧输入开始理解信号处理过程。'] }],
        tableBindings: [], formulaBindings: [], conceptBridges: [] };
}
const issues = [{ message: '读者文章 figurePlacements[0]（Figure 1）图片的插入位置、相邻导读与解释段，或观察点不符合要求（focusPoints[0]=121字，须为12–120字）' }];
test('只修观察提示时不授权整节正文，并继续提供对应像素', () => {
    const draft = createSample(), before = JSON.stringify(draft);
    const context = repair.buildRepairContext(draft, issues, '封存全文', '', { availableFigureOrdinals: [1] });
    assert.deepEqual(context.targets.map(item => item.path), ['/figurePlacements/0']);
    assert.deepEqual(context.figureOrdinals, [1]);
    assert.match(context.targets[0].repairInstruction, /索引为 0/);
    assert.equal(context.targets[0].oldSha256, repair.hashDraft(draft.figurePlacements[0]));
    assert.equal(JSON.stringify(draft), before);
});
test('旁注诊断不触发观察提示专用范围，混合阻塞问题则先修局部再完整检查', () => {
    const draft = createSample();
    const diagnostic = repair.buildRepairTargets(draft, [{ ...issues[0], diagnosticOnly: true }],
        { availableFigureOrdinals: [1] });
    assert.ok(!diagnostic.some(item => item.repairInstruction?.includes('只改 focusPoints')));
    const mixed = repair.buildRepairTargets(draft, [...issues,
        { message: '读者文章 sections[0].body 仍有需要核验的问题' }], { availableFigureOrdinals: [1] });
    assert.deepEqual(mixed.map(item => item.path), ['/figurePlacements/0']);
});
for (const [name, change, options] of [
    ['没有该图像素', () => {}, { availableFigureOrdinals: [] }],
    ['导读不足', d => { d.sections[0].body = '短\n\n[[FIGURE_1]]\n\n' + '解释。'.repeat(30); }],
    ['标记重复', d => { d.sections[0].body += '\n\n[[FIGURE_1]]'; }],
    ['观察提示已合格', d => { d.figurePlacements[0].focusPoints[0] = '沿原图的数据流顺序阅读各模块连接。'; }],
    ['错误所在小节', d => { d.figurePlacements[0].targetKind = 'result'; }]
]) test(`${name}不套用观察提示专用范围`, () => {
    const draft = createSample(); change(draft);
    const targets = repair.buildRepairTargets(draft, issues, options || { availableFigureOrdinals: [1] });
    assert.ok(!targets.some(item => item.repairInstruction?.includes('只改 focusPoints')));
});
