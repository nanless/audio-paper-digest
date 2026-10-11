'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const repair = require('../scripts/lib/reader-repair.js');
const tables = require('../scripts/lib/reader-tables.js');
function createReaderTestArticle() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.map((kind, index) => ({ kind, heading: `声音处理中步骤 ${index + 1} 的输入输出如何衔接？`,
            body: `这一部分解释声音处理的${kind}环节，先限定输入信号，再描述信息如何沿组件传递。`.repeat(6) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '声学表示保存输入信号的发音结构，语义条件限定合理的内容范围，两者分工使预测既遵循声音证据也满足当前任务约束。'
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}

function createTableSourceData() {
    const { parseArxivStructuredArtifactsFromHtml, bindStructuredArtifactsToText } = require('../scripts/deep-analyzer.js');
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/arxiv-reader-source-bindings.html'), 'utf8');
    const sourceText = cheerio.load(html)('body').text();
    return { sourceText, artifacts: bindStructuredArtifactsToText(parseArxivStructuredArtifactsFromHtml(html,
        '2609.00001v1', '2609.00001v1'), sourceText) };
}

test('缺失选择表标记在无关小节错误并存时授权结果正文，原来源校验仍有效', () => {
    const draft = createReaderTestArticle();
    for (let index = 0; index < 7; index++) draft.sections[index].body = '过短正文';
    draft.tableBindings = [{ tableIndex: 1, selection: {
        sourceTableOrdinal: 2, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2]
    } }];
    const { artifacts } = createTableSourceData();
    const issues = repair.collectDraftIssues(draft, null, { structuredArtifacts: artifacts });
    const targets = repair.buildRepairTargets(draft, issues);
    assert.deepEqual(targets.map(target => target.path), [
        '/tableBindings/0', '/sections/7/body', '/sections/8/body'
    ]);
    assert.ok(targets.length <= 8);
    const body = draft.sections[7].body + '\n\n[[TABLE_1]]';
    const patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{
        path: '/sections/7/body', oldSha256: repair.hashDraft(draft.sections[7].body), value: body
    }] };
    const repaired = repair.applyReaderPatch(draft, patch, targets.map(target => target.path));
    const rendered = tables.compileReaderTableSelections(repaired.sections, repaired.tableBindings, artifacts);
    assert.deepEqual(rendered.selectionTableIndexes, [1]);
    assert.ok(rendered.tableBindings[0].cellBindings.length > 0);
    assert.equal(draft.sections[7].body.includes('[[TABLE_1]]'), false);
    const duplicated = structuredClone(repaired);
    duplicated.sections[8].body += '\n\n[[TABLE_1]]';
    assert.throws(() => tables.compileReaderTableSelections(duplicated.sections, duplicated.tableBindings, artifacts), /唯一独占一段/);
    const missingData = structuredClone(repaired);
    missingData.tableBindings[0].selection.sourceRows = [0, 0];
    assert.throws(() => tables.compileReaderTableSelections(missingData.sections, missingData.tableBindings, artifacts), /重复|数据行/);
    const headersOnly = { tableIndex: 1, selection: {
        sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1, 2]
    } };
    let headerError;
    try { tables.renderReaderTableSelection(headersOnly, artifacts); }
    catch (error) { headerError = error; }
    assert.match(headerError.message, /其余行必须是数据行/);
    assert.match(headerError.message, /若另有正文标记或位置错误/);
    assert.doesNotMatch(headerError.message, /不能改写正文/);
});

test('公式位置反馈列出实际出现次数与 kind，不自动修改声明或正文', () => {
    const draft = createReaderTestArticle();
    draft.formulaBindings = [{ marker: '[[FORMULA_1]]', targetKind: 'component' }];
    draft.sections[7].body += '\n\n[[FORMULA_1]]';
    const before = JSON.stringify(draft);
    const issue = repair.collectDraftIssues(draft).find(item => item.path === '/formulaBindings/0');
    assert.match(issue.message, /声明 kind="component"/);
    assert.match(issue.message, /实际独占行出现 1 次/);
    assert.match(issue.message, /"index":7,"kind":"result"/);
    assert.equal(JSON.stringify(draft), before);
    draft.sections[8].body += '\n\n[[FORMULA_1]]';
    const repeated = repair.collectDraftIssues(draft).find(item => item.path === '/formulaBindings/0');
    assert.match(repeated.message, /实际独占行出现 2 次/);
});


test('缺表标记分组不覆盖术语组合解释的修复顺序或八节点上限', () => {
    const draft = createReaderTestArticle();
    draft.tableBindings = [{ tableIndex: 1, selection: {
        sourceTableOrdinal: 2, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2]
    } }];
    draft.conceptBridges[0].sectionKind = 'problem';
    const issues = repair.collectDraftIssues(draft);
    assert.deepEqual(repair.buildRepairTargets(draft, issues).map(target => target.path), [
        '/sections/3/body', '/sections/2/body'
    ]);
    const tooMany = createReaderTestArticle();
    tooMany.tableBindings = structuredClone(draft.tableBindings);
    for (const section of tooMany.sections.slice(0, 8)) section.kind = 'result';
    const targets = repair.buildRepairTargets(tooMany, repair.collectDraftIssues(tooMany));
    assert.ok(targets.length <= 8);
    assert.ok(!targets.some(target => target.path === '/sections/7/body'),
        '不能把八个结果正文加一绑定作为新的九节点授权组');
});
