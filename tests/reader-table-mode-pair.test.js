'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createTableSample() {
    const draft = { version: 3, readerTitle: '论文解读', oneSentenceThesis: '只按封存原文解读。',
        sections: Array.from({ length: 12 }, (_, index) => ({ kind: index === 10 ? 'result' : 'component',
            heading: `小节${index}`, body: index === 10 ? '表前比较问题。\n\n[[TABLE_1]]\n\n表后结果解释。' : '已有正确正文不改。' })),
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['The baseline scored 12% and the proposed method scored 10%.'] }],
        conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const unrelated = Array.from({ length: 8 }, (_, index) => ({ path: `/sections/${index}/body`, message: '这个片段另有待修问题' }));
    const conflict = { path: '/tableBindings/0', message: 'tableBindings[0] 使用 source_quotes 时正文必须直接写 Markdown 表，不能使用 [[TABLE_1]]；同步修改 sections[10].body 与本绑定项' };
    return { draft, issues: [...unrelated, conflict], conflict };
}
test('八目标边界不截断表格模式修复的绑定与正文，其他诊断留后轮', () => {
    const sample = createTableSample(), frozen = JSON.stringify(sample.draft);
    const context = repair.buildRepairContext(sample.draft, sample.issues, '完整封存证据', '完整封存证据');
    assert.deepEqual(context.targets.map(item => item.path), ['/tableBindings/0', '/sections/10/body']);
    assert.equal(context.evidence, '完整封存证据');
    assert.equal(context.draftSha256, repair.hashDraft(sample.draft));
    for (const target of context.targets) assert.equal(target.oldSha256, repair.hashDraft(target.value));
    assert.equal(JSON.stringify(sample.draft), frozen);
    const valid = { version: 1, draftSha256: context.draftSha256, replacements: context.targets.map(target => ({
        path: target.path, oldSha256: target.oldSha256, value: target.path.includes('/sections/')
            ? '表前比较问题。\n\n| Method | WER |\n| --- | --- |\n| Base | 12% |\n| Ours | 10% |\n\n表后结果解释。' : target.value
    })) };
    const repaired = repair.applyReaderPatch(sample.draft, valid, context.targets.map(item => item.path));
    assert.equal(repaired.tableBindings[0].sourceType, 'source_quotes');
    assert.ok(!repaired.sections[10].body.includes('[[TABLE_1]]'));
    const extra = structuredClone(valid);
    extra.replacements.push({ path: '/sections/0/body', oldSha256: repair.hashDraft(sample.draft.sections[0].body), value: '越权正文' });
    assert.throws(() => repair.applyReaderPatch(sample.draft, extra, context.targets.map(item => item.path)), /allowed|授权|范围/);
    const stale = structuredClone(valid); stale.replacements[0].oldSha256 = 'a'.repeat(64);
    assert.throws(() => repair.applyReaderPatch(sample.draft, stale, context.targets.map(item => item.path)), /stale/);
});
for (const [name, alter] of Object.entries({
    '重复标记': sample => { sample.draft.sections[11].body = '[[TABLE_1]]'; },
    '不独占段落': sample => { sample.draft.sections[10].body = '文字[[TABLE_1]]文字'; },
    '代码中的标记': sample => { sample.draft.sections[10].body = '```\n[[TABLE_1]]\n```'; },
    '引用中的标记': sample => { sample.draft.sections[10].body = '> [[TABLE_1]]'; },
    '错误表序': sample => { sample.draft.tableBindings[0].tableIndex = 2; },
    '错误类型': sample => { sample.draft.tableBindings[0].sourceType = 'artifact_table'; },
    '伪造索引': sample => { sample.issues.at(-1).path = '/tableBindings/4'; }
})) test(`成对目标不对${name}授予两项精确修复`, () => {
    const sample = createTableSample(); alter(sample);
    const targets = repair.buildRepairTargets(sample.draft, sample.issues);
    assert.notDeepEqual(targets.map(item => item.path), ['/tableBindings/0', '/sections/10/body']);
});
