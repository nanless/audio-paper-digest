'use strict';
const sourceProject = process.env.PD_READER_TABLE_LABEL_SOURCE_PROJECT;
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderTableNarrativeLabels: normalize } = require('../scripts/lib/reader-table-narrative-labels');
const table = '| 方法 | 值 |\n| --- | --- |\n| A | 1.0 |';
function sample(body) { return { sections: [{ body }], tableBindings: [{ tableIndex: 1 }] }; }
test('仅移除紧邻原表的明确标签，后文及单元格原字节不变', () => {
    const body = `已有自然说明。表前说明：比较相同设置。\n\n${table}\n\n表后解释主要收益与限制：结果为1.0，条件不变。`;
    const draft = sample(body);
    const mapping = normalize(draft);
    assert.equal(draft.sections[0].body, body.replace('表前说明：', '').replace('表后解释主要收益与限制：', ''));
    assert.equal(mapping.removals.length, 2);
    assert.equal(normalize(draft), null);
});
test('非相邻、未声明、重复声明、标题和保护文字均不处理', () => {
    for (const body of [
        `表前说明：比较。\n\n隔着另一段。\n\n${table}`,
        `# 表前说明：标题\n\n${table}`,
        `“表前说明：比较。”\n\n${table}`,
        '`表前说明：比较。`\n\n' + table,
        `$表前说明：比较。$\n\n${table}`,
        `> 表前说明：比较。\n\n${table}`,
        `普通正文提到表前说明：但并非标签。\n\n${table}`,
    ]) {
        const draft = sample(body);
        assert.equal(normalize(draft), null, body);
        assert.equal(draft.sections[0].body, body);
    }
    for (const bindings of [[], [{ tableIndex: 1 }, { tableIndex: 1 }]]) {
        const draft = sample(`表前说明：比较。\n\n${table}`); draft.tableBindings = bindings;
        assert.equal(normalize(draft), null);
    }
});
test('删除标签不会删除真实检查指令，完整语言检查继续拒绝', () => {
    const draft = sample(`表前说明：要说明比较条件。\n\n${table}\n\n表后解释：本次未发现绑定且完成校验。`);
    normalize(draft);
    assert.equal(draft.sections[0].body, `要说明比较条件。\n\n${table}\n\n本次未发现绑定且完成校验。`);
    assert.match(draft.sections[0].body, /本次未发现绑定且完成校验/);
    assert.ok(require('../scripts/editorial-quality').findReaderLanguageIssues(draft.sections[0].body).length > 0);
});

test('正常生成器在语言检查前移除表格标签，一次响应即可完整解析', async t => {
    process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const deep = require('../scripts/deep-analyzer');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-table-label-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceText = 'The source reports a controlled measurement of 1.0 under the same protocol.';
    const fixture = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText });
    const draft = structuredClone(fixture.draft);
    for (const section of draft.sections) {
        section.body = section.body.replace('下表要回答当前比较是否在统一条件下成立', '表前说明：下表要回答当前比较是否在统一条件下成立');
    }
    const original = JSON.stringify(draft);
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed({ arxivId: '2609.12345', title: '表格标签显示' },
        '', '只使用给定来源', {
            sourceText, structuredArtifacts: fixture.sourceDetails.structuredArtifacts,
            readerAttemptsDir: directory, readerRecordDisposition: async () => {},
            readerCallModel: async (_messages, _tokens, request) => {
                calls++;
                assert.equal(request.usageContext.stage, 'apiReaderArticle');
                assert.equal(calls, 1);
                return original;
            },
        });
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.fullAttempts, 1);
    assert.ok(result.draftOrderMappings.some(mapping => mapping.contract === 'reader-table-narrative-labels-v1'));
    assert.equal(JSON.stringify(draft), original);
    assert.ok(!result.article.includes('表前说明：'));
});

test('四份真实付费稿完整解析仍保留其他来源和覆盖错误',
    { skip: !sourceProject }, () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');
        const sha = value => crypto.createHash('sha256').update(value).digest('hex');
        const root = sourceProject;
        const Config = require('../scripts/config');
        const oldRuns = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'data/runtime/daily-fresh-source-runs');
        try {
            const daily = require('../scripts/lib/daily-fresh-source-plan');
            const deep = require('../scripts/deep-analyzer');
            const repair = require('../scripts/lib/reader-repair');
            const data = JSON.parse(fs.readFileSync(path.join(root, 'data/current/deep-analysis-result.json')));
            const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
            for (const [id, hash, count, passes] of [
                ['2610.08846', '2b00b0b4f9448da29957ce05f3b92752a79d1fea9ef6a2810e098bd134cca6b7', 5, false],
                ['2610.04180', 'f53000ab16de6340a74427c4c819aceac0065ce0034aef008581bcc45bf97771', 4, false],
                ['2610.11846', '60e14af9e886aa4d52be63807de6d4364939c5350b5b91323861c90262eee1d2', 4, true],
                ['2610.11310', 'd41a0555377d04207d6c7001705cc45f65f8bbc4885e18ac718eb9a111bf4c37', 1, false],
            ]) {
                const paper = data.papers.find(p => String(p.arxivId || p.id).replace(/v\d+$/, '') === id);
                const source = daily.readDailyFreshSource(plan, paper);
                const sourceDirectory = path.join(plan.sourcesDir, id, 'generation-000001');
                const sourceFiles = ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'];
                const sourceHashes = sourceFiles.map(name => sha(fs.readFileSync(path.join(sourceDirectory, name))));
                const filename = path.join(plan.readerAttemptsDir, hash + '.json');
                const bytes = fs.readFileSync(filename), saved = JSON.parse(bytes);
                assert.equal(saved.identity.sourceSha256, sha(source.text));
                assert.equal(saved.identity.freshAnalysis.structuredArtifactsSha256, source.structuredArtifacts.payloadSha256);
                const draft = require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(
                    saved.payload.draft || JSON.parse(saved.payload.rawDraft), { structuredArtifacts: source.structuredArtifacts }).draft;
                const original = structuredClone(draft);
                const mapping = normalize(draft);
                assert.equal(mapping.removals.length, count);
                assert.deepEqual(draft.tableBindings, original.tableBindings);
                assert.deepEqual(draft.conceptBridges, original.conceptBridges);
                let error;
                try {
                    deep.parseApiReaderArticleResult(JSON.stringify(draft), {
                        arxivId: id, requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
                        requireSourceBindings: true, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                        availableFigureOrdinals: (saved.payload.imageEvidence || []).map(image => image.ordinal),
                        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
                    });
                } catch (caught) { error = caught; }
                assert.equal(!error, passes, id);
                if (error) assert.ok(repair.collectDraftIssues(draft, error, {
                    sourceText: source.text, structuredArtifacts: source.structuredArtifacts }).length > 0);
                assert.equal(sha(fs.readFileSync(filename)), sha(bytes));
                assert.deepEqual(sourceFiles.map(name => sha(fs.readFileSync(path.join(sourceDirectory, name)))), sourceHashes);
            }
        } finally { Config.FILES.dailyFreshSourceRunsDir = oldRuns; }
    });
