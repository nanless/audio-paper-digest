'use strict';
require('./core-diagnostics-test-isolation')();
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const utils = require('../scripts/utils');
const originalLoadEnv = utils.loadEnvFile;
utils.loadEnvFile = () => {
    process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.test/v1';
    process.env.PAPER_ANALYZER_API_KEY = 'dummy-test-key';
    process.env.PAPER_ANALYZER_MODEL = 'test-model';
};
const deep = require('../scripts/deep-analyzer');
utils.loadEnvFile = originalLoadEnv;

function createBridgeSample() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const bridges = Array.from({ length: 4 }, (_, index) => ({
        terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
        marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
        explanation: '声学表示保存输入信号的发音结构，语义条件限定内容范围，两者分别保留声音证据和任务约束，搭配后预测同时遵循这两类信息。'
    }));
    const draft = { version: 3, readerTitle: '声音输入与语义约束如何共同作用',
        oneSentenceThesis: '方法依次处理声音输入与语义约束，实验保持对照设置一致，再说明结果支持的有限结论与实际代价。',
        conceptBridges: bridges, figurePlacements: [], tableBindings: [], formulaBindings: [],
        sections: kinds.map((kind, index) => ({ kind, heading: `计算步骤${index + 1}如何执行`,
            body: '这一部分解释声音处理环节，先限定输入信号，再描述信息如何沿组件传递，输出如何受到任务约束。'.repeat(6) })) };
    draft.sections[3].body += '\n\n' + bridges.map(bridge => bridge.marker).join('\n\n');
    return draft;
}

test('每项未知字段都给出精确结构说明，原始内容不被删除或搬移', () => {
    const draft = createBridgeSample();
    draft.conceptBridges[0].marker_note = '';
    draft.conceptBridges[1].sectionKind_note = '';
    draft.conceptBridges[2].explanation_note = '这一额外说明包含必须回到原文核对的机制解释。';
    const before = JSON.stringify(draft);
    const issues = repair.collectDraftIssues(draft, new Error('读者文章 conceptBridges[0] 包含额外字段: marker_note'));
    const extraIssues = issues.filter(issue => issue.message.includes('本项只能含'));
    assert.deepEqual(extraIssues.map(issue => issue.path), ['/conceptBridges/0', '/conceptBridges/1', '/conceptBridges/2']);
    for (const [index, field] of ['marker_note', 'sectionKind_note', 'explanation_note'].entries()) {
        assert.ok(extraIssues[index].message.includes(field));
        assert.match(extraIssues[index].message, /terms、sectionKind、marker、explanation/);
        assert.match(extraIssues[index].message, /先按论文证据核对/);
    }
    const targets = repair.buildRepairContext(draft, extraIssues, '封存论文证据').targets;
    assert.deepEqual(targets.map(target => target.path), [
        '/conceptBridges/0', '/sections/3/body', '/conceptBridges/1', '/conceptBridges/2'
    ]);
    assert.equal(targets[2].oldSha256, repair.hashDraft(draft.conceptBridges[1]));
    assert.equal(JSON.stringify(draft), before);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draft)), /conceptBridges\[0\] 包含额外字段: marker_note/);
});

test('无未知字段时不增加诊断，多个未知键仍只授权当前对象及原有正文', () => {
    const draft = createBridgeSample();
    const baseline = repair.collectDraftIssues(draft, null);
    draft.conceptBridges[1].marker_note = '非空解释';
    draft.conceptBridges[1].sectionKind_note = '';
    const issues = repair.collectDraftIssues(draft, null);
    const added = issues.filter(issue => issue.message.includes('本项只能含'));
    assert.equal(added.length, 1);
    assert.match(added[0].message, /marker_note, sectionKind_note/);
    assert.deepEqual(issues.filter(issue => !issue.message.includes('本项只能含')), baseline);
    assert.deepEqual(repair.buildRepairTargets(draft, added).map(target => target.path),
        ['/conceptBridges/1', '/sections/3/body']);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draft)), /conceptBridges\[1\] 包含额外字段/);
});


test('术语长度反馈指出实际字段和值，局部授权保持完整桥对象与相邻正文', () => {
    const draft = createBridgeSample();
    draft.conceptBridges[2].terms = ['Metadata Predictor', 'K'];
    const before = JSON.stringify(draft);
    let failure;
    try { deep.parseApiReaderArticleResult(JSON.stringify(draft)); } catch (error) { failure = error; }
    assert.match(failure.message, /conceptBridges\[2\]\.terms\[1\] 实际值="K"/);
    assert.match(failure.message, /1字符，要求2–48字符/);
    assert.match(failure.message, /按原文解释/);
    const issues = repair.collectDraftIssues(draft, failure);
    const issue = issues.find(item => item.path === '/conceptBridges/2' && item.message.includes('terms[1] 实际值'));
    assert.equal(issue.path, '/conceptBridges/2');
    const context = repair.buildRepairContext(draft, [issue], '本篇封存原文解释K为检索数量');
    assert.deepEqual(context.targets.map(target => target.path), ['/conceptBridges/2', '/sections/3/body']);
    assert.equal(context.targets[0].oldSha256, repair.hashDraft(draft.conceptBridges[2]));
    assert.equal(JSON.stringify(draft), before);
    draft.conceptBridges[2].terms[1] = '检索数量K';
    assert.equal(repair.conceptBridgeTermsDiagnostic(draft.conceptBridges[2].terms, 2), null);
});

test('既有2–48字符门不放宽，诊断所有坏项并保留原值', () => {
    for (const terms of [['K', 'Q'], ['  K  ', '声学表示'], [5, '声学表示'], ['声学表示', '字'.repeat(49)], [], null]) {
        const before = JSON.stringify(terms);
        assert.ok(repair.conceptBridgeTermsDiagnostic(terms, 0));
        assert.equal(JSON.stringify(terms), before);
    }
    for (const terms of [['声学', '声学表示'], ['字'.repeat(48), '检索数量K']]) {
        assert.equal(repair.conceptBridgeTermsDiagnostic(terms, 0), null);
    }
    const diagnostic = repair.conceptBridgeTermsDiagnostic(['K', 'Q'], 3);
    assert.match(diagnostic, /terms\[0\]/);
    assert.match(diagnostic, /terms\[1\]/);
});
