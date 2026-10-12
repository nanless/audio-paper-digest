'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const { fixture: makeExample } = require('./reader-signed-draft-fixture');

test('资源检查话术按资源状态修订，不能误导成表格解释或断言作者未开源', () => {
    const example = makeExample({ noFigures: true });
    example.draft.sections[7].body += '\n\n论文未绑定经校验可用的代码。';
    const before = structuredClone(example.draft);
    const issues = repair.collectReaderLanguageIssues(example.draft);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, '/sections/7/body');
    assert.match(issues[0].message, /资源是否公开、是否可取得/);
    assert.match(issues[0].message, /不能改成作者没有开源/);
    assert.doesNotMatch(issues[0].message, /本表比较什么/);
    assert.deepEqual(example.draft, before);
    example.draft.sections[7].body = before.sections[7].body.replace(
        '论文未绑定经校验可用的代码', '目前无法确认作者是否已公开代码');
    assert.deepEqual(repair.collectReaderLanguageIssues(example.draft), []);
});

test('真实生成和局部修复入口收到专门资源说明，保留来源和付费次数', async t => {
    const example = makeExample({ noFigures: true });
    const original = deep.parseApiReaderArticleResult(JSON.stringify(example.draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        availableFigureOrdinals: [], requireSourceBindings: true,
        structuredArtifacts: example.sourceDetails.structuredArtifacts,
        sourceText: example.sourceDetails.text
    });
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-resource-language-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = structuredClone(example.draft);
    draft.sections[7].body += '\n\n论文未绑定经校验可用的代码。';
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed(
        { arxivId: '2609.12345', title: '音频模型的实验与复现' }, '', example.sourceDetails.text, {
            sourceText: example.sourceDetails.text,
            structuredArtifacts: example.sourceDetails.structuredArtifacts,
            readerAttemptsDir: directory, readerMaxAttempts: 2,
            readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (messages, _budget, options) => {
                if (++calls === 1) return JSON.stringify(draft);
                assert.equal(options.usageContext.stage, 'apiReaderRepair');
                const prompt = messages[0].content[0].text;
                assert.match(prompt, /不能改成作者没有开源/);
                const line = prompt.split('\n').find(text => text.startsWith('{"draftSha256":'));
                const request = JSON.parse(line);
                assert.deepEqual(request.targets.map(target => target.path), ['/sections/7/body']);
                return JSON.stringify({ version: 1, draftSha256: request.draftSha256,
                    replacements: request.targets.map(target => ({ path: target.path,
                        oldSha256: target.oldSha256,
                        value: target.value.replace('论文未绑定经校验可用的代码',
                            '目前无法确认作者是否已公开代码') })) });
            }
        }
    );
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.fullAttempts, 1);
    assert.match(result.article, /目前无法确认作者是否已公开代码/);
    assert.doesNotMatch(result.article, /未绑定经校验/);
    assert.deepEqual(result.plan.tableBindings, original.plan.tableBindings);
});
