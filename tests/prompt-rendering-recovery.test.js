'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const contract = require('../scripts/lib/prompt-rendering-contract.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const { buildFilterInputSha256 } = require('../scripts/lib/filter-input-contract.js');
const { validateDailyFreshSourceRun } = require('../scripts/validate-data-files.js');
const deep = require('../scripts/deep-analyzer.js');
const hash = input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

function oldFilterHash(input) { return hash({ title: input.title, abstract: input.abstract, categories: input.categories }); }

test('筛选只使确有顺序替换风险的旧输入 SHA 失效，普通和反向字面量仍兼容', () => {
    for (const input of [
        { title: '语音识别论文', abstract: '比较 {N} 个模型', categories: ['cs.SD'] },
        { title: '语音识别论文', abstract: '保留 {title} 和 {abstract}', categories: ['cs.SD'] }
    ]) assert.equal(buildFilterInputSha256(input), oldFilterHash(input));
    for (const input of [
        { title: '模板 {abstract}', abstract: '语音识别', categories: ['cs.SD'] },
        { title: '语音识别', abstract: '模板 {categories}', categories: ['cs.SD'] }
    ]) {
        assert.notEqual(buildFilterInputSha256(input), oldFilterHash(input));
        assert.equal(buildFilterInputSha256(input), hash({ ...input, promptRenderingContract: contract.PROMPT_RENDERING_CONTRACT }));
    }
});

test('旧阶段仅在输入含已知模板字面量时停用，修复后记录可再次恢复', () => {
    const ordinary = { title: '普通论文', analysisCheckpoint: '模型使用 {N} 个块',
        analysisManifest: { stages: { primaryAnalysis: { status: 'complete', fingerprint: 'a' } },
            sourceAcquisition: { sourceSha256: 'a'.repeat(64) } } };
    const before = structuredClone(ordinary);
    assert.equal(deep.resetLegacyPromptRenderingRecovery(ordinary, ordinary.analysisManifest, { text: '原文' }), false);
    assert.deepEqual(ordinary, before);
    const affected = structuredClone(before);
    affected.apiReaderArticle = '已保存文章'; affected.apiReaderPlan = { title: '原计划' };
    affected.analysisStageCheckpoints = { primaryAnalysis: '旧检查点' };
    affected.analysisManifest.stages.apiReaderArticle = { status: 'complete', fingerprint: 'b' };
    assert.equal(deep.resetLegacyPromptRenderingRecovery(affected, affected.analysisManifest,
        { text: '原文代码含 {validationFeedback}' }), true);
    assert.deepEqual(affected.analysisManifest.stages, {});
    assert.equal(affected.analysisCheckpoint, undefined);
    assert.equal(affected.analysisStageCheckpoints, undefined);
    assert.equal(affected.apiReaderArticle, undefined);
    assert.equal(affected.apiReaderPlan, undefined);
    affected.analysisManifest.sourceAcquisition.promptRenderingContract = contract.PROMPT_RENDERING_CONTRACT;
    affected.analysisManifest.stages.primaryAnalysis = { status: 'complete', fingerprint: 'new' };
    assert.equal(deep.resetLegacyPromptRenderingRecovery(affected, affected.analysisManifest,
        { text: '原文代码含 {validationFeedback}' }), false);
    assert.equal(affected.analysisManifest.stages.primaryAnalysis.fingerprint, 'new');
});

test('真实封存来源里有旧模板碰撞时，绑定与验收拒绝旧结果，仅本篇需要重做', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prompt-rendering-source-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const ids = ['2610.00001', '2610.00002'];
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-09', batchId: 'prompt-rendering-test',
        papers: ids.map(arxivId => ({ arxivId })) });
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text: 'Official source methods results '.repeat(100)
                + (id === ids[0] ? 'template {validationFeedback}' : 'math {N}'),
            source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: new Date().toISOString() }),
            fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.4\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`, fetchedAt: new Date().toISOString() })
        }) });
    const papers = ids.map(arxivId => {
        const descriptor = daily.readDailyFreshSource(plan, { arxivId }).freshSourceDescriptor;
        const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
            sourceGeneration: descriptor.sourceGeneration, sourceManifestSha256: descriptor.sourceManifestSha256,
            sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
            sourceOnly: true, oldGeneratedTextIncluded: false };
        return { arxivId, analysis: '原先成功正文', sourceSha256: proof.sourceSha256,
            freshRewriteProvenance: proof, analysisManifest: { freshRewriteProvenance: proof,
                sourceAcquisition: { sourceSha256: proof.sourceSha256 } } };
    });
    assert.equal(daily.isPaperBoundToPlan(papers[0], plan), false);
    assert.equal(daily.isPaperBoundToPlan(papers[1], plan), true);
    assert.equal(daily.prepareDailyPaper(papers[0], plan).analysis, undefined);
    assert.equal(daily.prepareDailyPaper(papers[1], plan).analysis, papers[1].analysis);
    const payload = { batchDate: plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers };
    const issues = [];
    validateDailyFreshSourceRun('fixture.json', payload, papers, issues);
    assert.equal(issues.length, 1);
    assert.match(JSON.stringify(issues), /旧提示词渲染/);
    papers[0].analysisManifest.sourceAcquisition.promptRenderingContract = contract.PROMPT_RENDERING_CONTRACT;
    assert.equal(daily.isPaperBoundToPlan(papers[0], plan), true);
    const repairedIssues = [];
    validateDailyFreshSourceRun('fixture.json', payload, papers, repairedIssues);
    assert.deepEqual(repairedIssues, []);
});

test('真实筛选续跑只重做受影响旧决定，修复后决定可复用且覆盖集合不变', async () => {
    const { filterPapersWithLLM } = require('../scripts/fetch-papers.js');
    const papers = [
        { arxivId: '2610.00001', title: '语音模板 {abstract}', abstract: '语音识别', categories: ['cs.SD'] },
        { arxivId: '2610.00002', title: '普通语音论文', abstract: '语音识别', categories: ['cs.SD'] }
    ];
    const oldDecisions = Object.fromEntries(papers.map(paper => [paper.arxivId,
        { related: false, inputSha256: oldFilterHash(paper) }]));
    let calls = 0; let checkpoint;
    const selected = await filterPapersWithLLM(papers, {
        useKeywordPreFilter: false, delayBetweenBatches: 0, initialDecisions: oldDecisions,
        decisionFn: async paper => { calls++; assert.equal(paper.arxivId, papers[0].arxivId);
            return { related: true, reason: '音频相关', parseSource: 'offline-test' }; },
        onBatchComplete: state => { checkpoint = state; }
    });
    assert.equal(calls, 1);
    assert.deepEqual(selected.map(paper => paper.arxivId), [papers[0].arxivId]);
    assert.equal(checkpoint.stats.complete, true);
    assert.equal(Object.keys(checkpoint.decisions).length, 2);
    await filterPapersWithLLM(papers, { useKeywordPreFilter: false, initialDecisions: checkpoint.decisions,
        decisionFn: async () => assert.fail('修复后不得重复请求') });
});

test('Reader 执行指纹对普通旧输入保持原形，对危险字面量绑定单次渲染版本', () => {
    const shaText = text => crypto.createHash('sha256').update(text).digest('hex');
    for (const evidence of ['普通原文 {N}', '原文模板 {validationFeedback}']) {
        const oldShape = { configurationFingerprint: 'base', evidenceSha256: shaText(evidence), structuredArtifactsSha256: '' };
        const actual = deep.buildApiReaderExecutionFingerprint('base', evidence, null);
        if (evidence.includes('validationFeedback')) {
            assert.notEqual(actual, hash(oldShape));
            assert.equal(actual, hash(Object.fromEntries(Object.entries({ ...oldShape,
                promptRenderingContract: contract.PROMPT_RENDERING_CONTRACT }).sort())));
        } else assert.equal(actual, hash(oldShape));
    }
});

test('所有生产模型请求用到的模板键都纳入旧渲染风险检查', () => {
    // 分别来自筛选、主分析、Reader正文/修复、评分、插图和各局部修复的调用参数。
    const callKeys = [
        ['title', 'abstract', 'categories'],
        ['hasFullText', 'title', 'authors', 'categories', 'arxivId', 'textForAnalysis', 'tagPromptText'],
        ['title', 'arxivId', 'sourceEvidence', 'validationFeedback', 'previousDraft', 'mechanicalContract'],
        ['title', 'arxivId', 'validationFeedback', 'repairTargets', 'sourceEvidence', 'mechanicalContract'],
        ['existingAnalysis', 'sourceEvidence', 'validationFeedback'],
        ['title', 'arxivId', 'imageList', 'anchorCatalog', 'primaryAnalysis'],
        ['title', 'arxivId', 'existingAnalysis', 'textForAnalysis', 'tagPromptText'],
        ['title', 'arxivId', 'summaryIssue', 'existingSummary', 'textForAnalysis'],
        ['title', 'arxivId', 'missingSections', 'validationFeedback', 'existingAnalysis', 'textForAnalysis'],
        ['title', 'arxivId', 'methodSection', 'textForAnalysis'],
        ['title', 'arxivId', 'resultsSection', 'textForAnalysis']
    ];
    for (const key of new Set(callKeys.flat())) {
        assert.ok(contract.PROMPT_INPUT_KEYS.includes(key), key);
        assert.equal(contract.containsPromptInputPlaceholder(`literal {${key}}`), true, key);
    }
    assert.equal(contract.containsPromptInputPlaceholder('math {N} and {x} and \\frac{a}{b}'), false);
});
