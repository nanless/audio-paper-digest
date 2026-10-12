'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const { fixture: makeExample } = require('./reader-signed-draft-fixture');

function parse(draft, example) {
    return deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        availableFigureOrdinals: [], requireSourceBindings: true,
        structuredArtifacts: example.sourceDetails.structuredArtifacts,
        sourceText: example.sourceDetails.text
    });
}

function rejection(draft, example) {
    let failure;
    try { parse(draft, example); } catch (error) { failure = error; }
    assert.equal(failure?.code, repair.LANGUAGE_ERROR_CODE);
    return failure;
}

test('语言检查只看读者文字，不把来源原句、公式或记录当作待改正文', () => {
    const example = makeExample({ noFigures: true });
    assert.deepEqual(repair.collectReaderLanguageIssues(example.draft), []);
    example.draft.tableBindings[0].sourceQuotes = ['弗雷歇起始距离，列数满足核对要求。'];
    example.draft.formulaBindings[0].sourceText = '最优评论家提供梯度。';
    assert.deepEqual(repair.collectReaderLanguageIssues(example.draft), []);
});

test('检查话术在原稿中准确定位，不能被正文清理悄悄删掉后宣告合格', () => {
    const example = makeExample({ noFigures: true });
    example.draft.sections[7].body += '\n\n列数满足核对要求。';
    const before = JSON.stringify(example.draft);
    const error = rejection(example.draft, example);
    assert.equal(JSON.stringify(example.draft), before);
    assert.deepEqual(error.readerIssues.map(issue => [issue.code, issue.path]), [
        ['reader_workflow_leakage', '/sections/7/body']
    ]);
});

test('一句表后写作要求只授权所在正文，不扩大到表格来源和其他小节', () => {
    const example = makeExample({ noFigures: true });
    example.draft.sections[7].body += '\n\n表后解释必须区分条件和收益。';
    const issues = repair.collectDraftIssues(example.draft, rejection(example.draft, example), {
        sourceText: example.sourceDetails.text,
        structuredArtifacts: example.sourceDetails.structuredArtifacts
    });
    const targets = repair.buildRepairTargets(example.draft, issues);
    assert.deepEqual(targets.map(target => target.path), ['/sections/7/body']);
    assert.match(issues.find(issue => issue.code === 'reader_workflow_leakage').message,
        /保留原数字、单位、方法归属和来源/);
});

test('旧文风诊断已不对应当前原句时，不扩大为全部正文改写', () => {
    const example = makeExample({ noFigures: true });
    const issue = { code: 'reader_workflow_leakage', path: '/sections/7/body',
        match: '列数满足核对要求', message: '需要改写本表对应的正文' };
    assert.deepEqual(repair.buildRepairTargets(example.draft, [issue]), []);
    example.draft.sections[6].body += '\n\n列数满足核对要求。';
    assert.deepEqual(repair.buildRepairTargets(example.draft, [issue]), []);
});

test('术语解释、标题与看图提示不再借正文豁免漏过生硬译法', () => {
    const example = makeExample({ noFigures: true });
    example.draft.readerTitle = '用弗雷歇起始距离比较生成结果';
    example.draft.sections[4].heading = '弗雷歇起始距离如何比较结果';
    example.draft.conceptBridges[0].explanation += '最优评论家为生成器提供梯度。';
    example.draft.figurePlacements = [{ figureOrdinal: 1, targetKind: 'result',
        marker: '[[FIGURE_1]]', focusPoints: ['FID 和补丁距离分别比较全图与局部图像块'] }];
    const issues = repair.collectReaderLanguageIssues(example.draft);
    assert.deepEqual([...new Set(issues.map(issue => issue.path))], [
        '/readerTitle', '/sections/4', '/conceptBridges/0', '/figurePlacements/0'
    ]);
    // 单独看语言诊断时不授权关联小节或任何来源数组。
    const targets = repair.buildRepairTargets(example.draft, issues);
    assert.deepEqual(targets.map(target => target.path), [
        '/readerTitle', '/sections/4', '/conceptBridges/0', '/figurePlacements/0'
    ]);
});

test('正常局部补丁保留数字、原表和全部其他节点，仍须经过完整来源检查', () => {
    const example = makeExample({ noFigures: true });
    const original = structuredClone(example.draft);
    example.draft.sections[7].body += '\n\n列数满足核对要求。';
    const error = rejection(example.draft, example);
    const targets = repair.buildRepairTargets(example.draft, error.readerIssues);
    const patch = { version: 1, draftSha256: repair.hashDraft(example.draft), replacements: [{
        path: targets[0].path, oldSha256: targets[0].oldSha256, value: original.sections[7].body
    }] };
    const repaired = repair.applyReaderPatch(example.draft, patch, targets.map(target => target.path));
    assert.deepEqual(repaired, original);
    assert.equal(parse(repaired, example).plan.tableBindings.length, 2);
    const wrongSource = structuredClone(repaired);
    wrongSource.tableBindings[0].sourceQuotes = ['Unrelated source with no measured value.'];
    assert.throws(() => parse(wrongSource, example), /来源|sourceQuote|数字|quote/);
});

test('实际生成入口把话术失败交给一次精确局部修复，保留已使用次数', async t => {
    const example = makeExample({ noFigures: true });
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-language-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = structuredClone(example.draft);
    draft.sections[7].body += '\n\n表后解释必须区分条件和收益。';
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed(
        { arxivId: '2609.12345', title: '如何解释音频分析方法' }, '', example.sourceDetails.text, {
            sourceText: example.sourceDetails.text,
            structuredArtifacts: example.sourceDetails.structuredArtifacts,
            readerAttemptsDir: directory, readerMaxAttempts: 2,
            readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (messages, _budget, options) => {
                if (++calls === 1) return JSON.stringify(draft);
                assert.equal(options.usageContext.stage, 'apiReaderRepair');
                const prompt = messages[0].content[0].text;
                const line = prompt.split('\n').find(text => text.startsWith('{"draftSha256":'));
                assert.ok(line, '修复请求必须包含原稿和获准节点的SHA');
                const request = JSON.parse(line);
                assert.deepEqual(request.targets.map(target => target.path), ['/sections/7/body']);
                assert.match(prompt, /不(?:能|要|复述)|不是文章内容/);
                return JSON.stringify({ version: 1, draftSha256: request.draftSha256,
                    replacements: request.targets.map(target => ({ path: target.path,
                        oldSha256: target.oldSha256,
                        value: target.value.replace('\n\n表后解释必须区分条件和收益。', '') })) });
            }
        }
    );
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.fullAttempts, 1);
    assert.equal(result.transportFailures, 0);
    assert.doesNotMatch(result.article, /表后解释必须/);
    assert.equal(result.plan.tableBindings.length, 2);
});
