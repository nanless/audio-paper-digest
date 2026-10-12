'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const tables = require('../scripts/lib/reader-tables');
const deep = require('../scripts/deep-analyzer');

function createNoDomTableSample() {
    const quote = 'On the public test set, the baseline WER is 12.4% and the proposed WER is 9.8%.';
    const draft = { version: 3, readerTitle: '明确来源的语音识别实验比较', oneSentenceThesis: '论文使用公开测试集比较基线与新方法的词错误率，同时明确比较条件与限制。',
        sections: Array.from({ length: 12 }, (_, index) => ({ kind: index === 7 ? 'result' : 'component',
            heading: `实验机制与比较条件说明${index}`, body: index === 7
                ? '本表比较公开测试集上的词错误率。\n\n[[TABLE_1]]\n\n结果只对应公开测试集与同一实验条件。' : '其他正确正文保留。' })),
        conceptBridges: Array.from({ length: 4 }, () => ({ terms: ['方法', '实验'], explanation: '方法与实验的条件解释。', sectionKind: 'component', marker: '[[CONCEPT_BRIDGE_1]]' })),
        figurePlacements: [], formulaBindings: [], tableBindings: [{ tableIndex: 1, selection: {
            sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1] } }] };
    const artifacts = deep.bindStructuredArtifactsToText({ version: 1, source: 'html',
        tables: [], figures: [], formulas: [] }, quote);
    const issues = repair.collectDraftIssues(draft, new Error('tableBindings[0] selection 原表身份或恢复状态非法'),
        { structuredArtifacts: artifacts, sourceText: quote }).filter(issue => issue.path === '/tableBindings/0');
    return { draft, quote, artifacts, issues };
}

test('没有 DOM 时只指导已授权来源记录和对应正文，证据与权限不变', () => {
    const sample = createNoDomTableSample();
    assert.ok(sample.issues.some(issue => /本次没有 DOM 原表/.test(issue.message)));
    const evidence = 'TABLE_ORDINALS_AVAILABLE: []\n' + sample.quote;
    const paths = repair.buildRepairTargets(sample.draft, sample.issues).map(target => target.path);
    const context = repair.buildRepairContext(sample.draft, sample.issues, evidence, sample.quote,
        { structuredArtifacts: sample.artifacts });
    assert.deepEqual(context.targets.map(target => target.path), paths);
    assert.deepEqual(paths, ['/tableBindings/0', '/sections/7/body']);
    assert.equal(context.evidence, evidence);
    assert.match(context.targetGuidance, /在已授权 \/tableBindings\/0 与 \/sections\/7\/body 内/);
    assert.match(context.targetGuidance, /sourceTableOrdinal:null、cellBindings:\[\]/);
    assert.match(context.targetGuidance, /不得回传旧 selection、改用 completeTable/);
    assert.equal(context.draftSha256, repair.hashDraft(sample.draft));
    assert.throws(() => tables.renderReaderTableSelection(sample.draft.tableBindings[0], sample.artifacts), /原表身份/);
});

test('正文未授权或缺少唯一标记时不指派转换，未知来源仍拒绝', () => {
    const sample = createNoDomTableSample();
    sample.draft.sections[7].body = '保留正确正文，没有可定位的原表标记。';
    const context = repair.buildRepairContext(sample.draft, [{ path: '/tableBindings/0', message: '来源记录需要核对' }],
        '原始证据', sample.quote, { structuredArtifacts: sample.artifacts });
    assert.doesNotMatch(context.targetGuidance, /在已授权 .*source_quotes/);
    assert.throws(() => tables.renderReaderTableSelection(sample.draft.tableBindings[0], sample.artifacts), /原表身份/);
});

test('模型显式补丁可以走逐字引文路线，伪数字仍被来源校验拒绝', () => {
    const sample = createNoDomTableSample();
    const context = repair.buildRepairContext(sample.draft, sample.issues, sample.quote, sample.quote,
        { structuredArtifacts: sample.artifacts });
    const body = '本表比较公开测试集上的词错误率。\n\n| System | WER (%) |\n| --- | --- |\n| baseline | 12.4% |\n| proposed | 9.8% |\n\n结果只对应公开测试集与同一实验条件。';
    const binding = { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [sample.quote] };
    const applied = repair.applyReaderPatch(sample.draft, { version: 1, draftSha256: repair.hashDraft(sample.draft),
        replacements: [{ path: '/tableBindings/0', oldSha256: repair.hashDraft(sample.draft.tableBindings[0]), value: binding },
            { path: '/sections/7/body', oldSha256: repair.hashDraft(sample.draft.sections[7].body), value: body }] },
        context.targets.map(target => target.path), { structuredArtifacts: sample.artifacts });
    deep.bindApiReaderSourceEvidence(applied.sections[7].body, applied.tableBindings, [],
        { sourceText: sample.quote, structuredArtifacts: sample.artifacts });
    assert.throws(() => deep.bindApiReaderSourceEvidence(body.replace('12.4%', '99.9%'), [binding], [],
        { sourceText: sample.quote, structuredArtifacts: sample.artifacts }), /99.9|原句|来源|覆盖|数字/);
    assert.equal(sample.draft.sections[7].body.includes('[[TABLE_1]]'), true);
    assert.deepEqual(applied.sections.filter((_, index) => index !== 7), sample.draft.sections.filter((_, index) => index !== 7));
});
