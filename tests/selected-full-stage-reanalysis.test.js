'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// 测试自行提供假账号与路由，不读取开发者 .env，也不依赖 CI 模型配置。
const testEnvironment = {
    PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
    PAPER_ANALYZER_ENDPOINT: 'https://invalid.example/v1',
    PAPER_ANALYZER_API_KEY: 'unused-test-no-network',
    PAPER_ANALYZER_FALLBACK_API_KEYS: '',
    PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY: '',
    PAPER_ANALYZER_SECONDARY_MODEL: 'muse-spark-1.3-contributor',
    PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://invalid.example/v1',
    PAPER_ANALYZER_SECONDARY_API_KEY: 'unused-test-no-network',
    PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: '',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    PD_ANALYSIS_API_MAX_RETRIES: '1',
};
test.mock.method(require('../scripts/env-loader'), 'loadProjectEnv', () => {
    Object.assign(process.env, testEnvironment);
    return { ...testEnvironment };
});
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const facts = require('../scripts/lib/daily-fact-review');
const utils = require('../scripts/utils');
const calls = [];
utils.requestLlmJson = async (_url, _endpoint, model, body, _headers, options) => {
    calls.push({ model, body, stage: options.usageContext?.stage });
    const error = new Error('测试在正常主分析模型传输入口停止');
    error.code = 'MODEL_AUTH_ERROR'; error.retryable = false;
    throw error;
};
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const policy = require('../scripts/lib/selected-full-stage-reanalysis');
const { validAnalysisPaper } = require('./valid-analysis-fixture');
async function createSample(t, { fullSource = true, quantitativeSource = false } = {}) {
    const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'reviewed-reader-seed-'),
    );
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const signed = require('./reader-signed-draft-fixture').fixture({
        noFigures: true,
    });
    const id = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-10-11',
        batchId: 'reader-seed',
        papers: [
            {
                arxivId: signed.paper.arxivId,
                title: '正文已纠正的修订参考',
                authors: signed.paper.authors,
            },
            { arxivId: '2609.99999', title: '未选择的论文', authors: signed.paper.authors },
        ],
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: (options) =>
            sourceApi.captureFreshArxivRewriteSource(options, {
                fetchText: async (sourceId) => ({
                    ...signed.sourceDetails,
                    text: fullSource ? signed.sourceDetails.text + '\n' + (quantitativeSource ? 'Table 1 reports word error rate (WER) of 9.4% for our model versus 12.3% for the baseline.\n' : '') + '本测试全文研究噪声语音识别方法及实验边界。'.repeat(800) : signed.sourceDetails.text,
                    imageInfos: [{ ordinal: 1, url: `https://arxiv.org/html/${sourceId}/x1.png`, caption: '测试结构图' }],
                    source: 'html',
                    htmlAvailability: 'available',
                    htmlAttempts: 1,
                    warnings: [],
                    sourceId,
                    url: `https://arxiv.org/html/${sourceId}`,
                    fetchedAt: '2026-10-11T00:00:00.000Z',
                }),
                fetchPdf: async (sourceId) => ({
                    bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                    url: `https://arxiv.org/pdf/${sourceId}`,
                    fetchedAt: '2026-10-11T00:00:00.000Z',
                }),
            }),
    });
    const paper = {
        ...validAnalysisPaper(signed.paper.arxivId, {}, signed.paper.analysis),
        ...signed.paper,
    };
    const validManifest = validAnalysisPaper(
        signed.paper.arxivId,
        {},
        signed.paper.analysis,
    ).analysisManifest;
    paper.analysisManifest.contracts = {
        ...validManifest.contracts,
        ...paper.analysisManifest.contracts,
    };
    paper.analysisManifest.stages = {
        ...validManifest.stages,
        ...paper.analysisManifest.stages,
    };
    paper.analysisManifest.stages.taxonomySeal =
        validManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair =
        validManifest.stages.coreSummaryRepair;
    paper.analysisManifest.stages.structureRepair =
        validManifest.stages.structureRepair;
    delete paper.analysisManifest.stages.tagSelection;
    for (const key of [
        'coreSummaryInputAnalysisSha256',
        'inputCoreSummarySha256',
        'outputCoreSummarySha256',
    ]) {
        paper.analysisManifest.stages.scoringAudit[key] =
            validManifest.stages.scoringAudit[key];
    }
    paper.analysisManifest.contracts.taxonomy =
        validManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary =
        validManifest.contracts.coreSummary;
    paper.analysisManifest.stages.scoringAudit.scoringContract =
        'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.auditSha256 =
        deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(
        paper.analysis,
    );
    paper.digestStatus = { latestAttemptStatus: 'analysis_success' };
    const source = daily.readDailyFreshSource(plan, paper);
    paper.sourceSha256 = facts.sha(source.text);
    paper.analysisManifest.sourceAcquisition.sourceSha256 = paper.sourceSha256;
    await daily.withDailyFreshAnalysisContext(plan, () =>
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source),
    );
    const folder = path.join(plan.sourcesDir, id, 'generation-000001');
    const feedback = {
        contract: facts.CONTRACT,
        paperId: id,
        runId: plan.runId,
        batchDate: plan.batchDate,
        sourceFiles: Object.fromEntries(
            [
                'source.txt',
                'source.pdf',
                'source-runtime.json',
                'source-manifest.json',
            ].map((name) => [
                name,
                facts.sha(fs.readFileSync(path.join(folder, name))),
            ]),
        ),
        coreAnalysisSha256: facts.sha(paper.analysis),
        coreSummarySha256: facts.sha(
            deep.extractSectionByTitle(paper.analysis, '核心摘要'),
        ),
        primaryFeedback: '保留已经纠正的主文，只按原证据解释。',
        coreFeedback: '',
        readerFeedback: '只修本次明确的读者文章问题。',
        rejectedPrimaryClaims: ['本文解决噪声语音输入到文字输出时声学线索受损的问题，难点是局部干扰与长程语义错误会彼此放大。'],
        rejectedCoreClaims: [],
        rejectedReaderClaims: ['已纠正的旧Reader错误'],
        sourceQuotes: [source.text.slice(0, 100)],
    };
    const bound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
    const other = { arxivId: '2609.99999', title: '未选择的论文', authors: signed.paper.authors,
        originalFees: { attempts: 2, fullAttempts: 1 }, analysisManifest: { sourceAcquisition: {} } };
    const otherSource = daily.readDailyFreshSource(plan, other);
    other.sourceSha256 = facts.sha(otherSource.text);
    other.analysisManifest.sourceAcquisition.sourceSha256 = other.sourceSha256;
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(other, other.analysisManifest, otherSource));
    return { paper, other, plan, source, feedback, bound, id };
}


function options(sample) { return { runId: 'muse-current-test', sourceRunId: sample.plan.runId, paperIds: [sample.id] }; }
function inScope(sample, callback) {
    return daily.withDailyFreshAnalysisContext(sample.plan, () =>
        policy.withSelectedFullStageReanalysis(options(sample), callback));
}
test('选定论文锁内归档完整原账、普通论文不变、同轮中断不重置已付费阶段', async t => {
    const sample = await createSample(t);
    const before = structuredClone(sample.paper);
    await inScope(sample, async () => {
        assert.throws(() => policy.preparePaperLocked(sample.paper), /真实分析锁/);
        await engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () => {
            const next = policy.preparePaperLocked(sample.paper);
            assert.deepEqual(sample.paper, before);
            assert.deepEqual(next.fullStageReanalysisHistory[0].originalPaper, before);
            assert.equal(next.analysisManifest.stages.primaryAnalysis, undefined);
            assert.equal(next.analysisManifest.stages.apiReaderArticle, undefined);
            assert.equal(next.analysisCheckpoint, undefined);
            const other = { ...sample.paper, arxivId: '2609.99999' };
            assert.deepEqual(policy.preparePaperLocked(other), other);
            next.analysisManifest.stages.primaryAnalysis = { status: 'transient_failure', attempts: 1, model: policy.MODEL };
            const resumed = policy.preparePaperLocked(next);
            assert.deepEqual(resumed, next);
            const changedReview = facts.validateFeedback({ ...sample.feedback,
                primaryFeedback: sample.feedback.primaryFeedback + '这是不同的新反馈。' }, sample.plan, sample.paper);
            facts.withFactReview(changedReview, () => assert.throws(() => policy.preparePaperLocked(next), /当前反馈身份变化/));

            next.fullStageReanalysisHistory[0].originalPaper.analysis = '篡改原账';
            assert.throws(() => policy.preparePaperLocked(next), /费用档/);
        }));
        assert.equal(engine.paperAnalysisLockHeld(sample.paper), false);
    });
});
test('错误模型、未知或重复 ID、错误封存来源、缺原事实反馈在模型前拒绝', async t => {
    const sample = await createSample(t);
    for (const alter of [v => v.paperIds = [], v => v.paperIds.push(sample.id), v => v.paperIds = ['非法'], v => v.sourceRunId = 'bad']) {
        const value = options(sample); alter(value);
        assert.throws(() => policy.withSelectedFullStageReanalysis(value, () => {}));
    }
    const oldModel = process.env.PAPER_ANALYZER_MODEL;
    process.env.PAPER_ANALYZER_MODEL = 'mimo-v2.6-flash';
    assert.throws(() => policy.withSelectedFullStageReanalysis(options(sample), () => {}), /Muse/);
    process.env.PAPER_ANALYZER_MODEL = oldModel;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => {
        assert.throws(() => policy.preparePaperLocked(sample.paper), /原受控反馈/);
    }));
    for (const altered of [
        { ...sample.feedback, primaryFeedback: '泛泛说明方法即可。' },
        { ...sample.feedback, rejectedPrimaryClaims: ['这是另一个完整但未保留原约束的测试原句。'] },
        { ...sample.feedback, sourceQuotes: [sample.source.text.slice(10, 100)] },
    ]) {
        const accepted = facts.validateFeedback(altered, sample.plan, sample.paper);
        await daily.withDailyFreshAnalysisContext(sample.plan, () => policy.withSelectedFullStageReanalysis({ ...options(sample),
            originalFeedbacks: { [sample.id]: [{ feedback: sample.feedback }] } }, () =>
            engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(accepted,
                () => assert.throws(() => policy.preparePaperLocked(sample.paper), /新生成约束漏掉/)))));
    }

    await daily.withDailyFreshAnalysisContext(sample.plan, () => policy.withSelectedFullStageReanalysis({ ...options(sample),
        sourceRunId: '132fc843-0afe-434c-b0b7-4d98e2235b3e' }, () => engine.withPaperAnalysisLock(sample.paper,
        () => facts.withFactReview(sample.bound, () => assert.throws(() => policy.preparePaperLocked(sample.paper), /封存来源身份/)))));
});
test('真实公共分析入口发完整当前主提示而非旧局部修复，原反馈仍在请求中', async t => {
    const sample = await createSample(t);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=', 'base64');
    const before = structuredClone(sample.paper);
    calls.length = 0;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, async () => {
        const prepared = policy.preparePaperLocked(sample.paper);
        const analyze = daily.createDailyAnalyzeFn(sample.plan, { fetchFigure: async () => ({ bytes: png,
            contentType: 'image/png', finalUrl: `https://arxiv.org/html/${sample.paper.arxivId}/x1.png` }) });
        const result = await analyze(prepared);
        assert.match(result.error, /主分析模型传输入口停止/);
        assert.deepEqual(prepared.fullStageReanalysisHistory[0].originalPaper, before);
        assert.equal(prepared.analysisManifest.stages.primaryAnalysis.status, 'transient_failure');
        assert.equal(prepared.analysisManifest.stages.primaryAnalysis.primaryLocalFactRepair, undefined);
    })));
    assert.ok(calls.length >= 1);
    assert.ok(calls.every(call => call.model === policy.MODEL && call.stage === 'primaryAnalysis'));
    const request = JSON.stringify(calls[0].body);
    assert.ok(request.includes(sample.feedback.primaryFeedback));
    assert.ok(request.includes('textForAnalysis') === false);
    assert.ok(request.includes('只替换') === false);
});

test('指定论文公共重分析入口保存首请求失败及原账，未选记录原字节字段不变', async t => {
    const sample = await createSample(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-stage-public-'));
    const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    const oldRetries = Config.ANALYSIS_CONFIG.maxRetries;
    t.after(() => { Object.assign(Config.FILES, previous); Config.ANALYSIS_CONFIG.maxRetries = oldRetries;
        fs.rmSync(root, { recursive: true, force: true }); });
    Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
    Config.FILES.papers = path.join(root, 'papers.json');
    Config.FILES.papersLegacy = path.join(root, 'legacy.json');
    Config.FILES.runtimeDir = path.join(root, 'runtime');
    Config.ANALYSIS_CONFIG.maxRetries = 1;
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
    const feedbackFile = path.join(root, 'feedback.json');
    fs.writeFileSync(feedbackFile, JSON.stringify(sample.feedback));
    const input = { batchDate: sample.plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [sample.paper, sample.other] };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(input));
    const original = structuredClone(sample.paper);
    calls.length = 0;
    const result = await require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id], {
        fullStageReanalysis: options(sample), feedbackFiles: [feedbackFile],
    });
    const savedPayload = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.deepEqual(savedPayload.papers[1], sample.other);
    const saved = savedPayload.papers[0];
    assert.equal(result.failed, 1);
    assert.deepEqual(saved.fullStageReanalysisHistory[0].originalPaper, original);
    assert.equal(saved.fullStageReanalysis.runId, options(sample).runId);
    assert.match(saved.latestAnalysisAttemptError || saved.error, /主分析模型传输入口停止/);
    assert.equal(saved.analysisManifest.stages.primaryAnalysis.primaryLocalFactRepair, undefined);
    assert.ok(calls.length >= 1 && calls.every(call => call.stage === 'primaryAnalysis'));
    const outside = policy.fingerprintFields(saved);
    const inside = await inScope(sample, () => policy.fingerprintFields(saved));
    assert.deepEqual(outside, inside);
    calls.length = 0;
    // 第二次正常调用同run应继续新失败阶段，而不是再次归档旧canonical/清掉新费用。
    const historyLength = saved.fullStageReanalysisHistory.length;
    await require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id], {
        fullStageReanalysis: options(sample), feedbackFiles: [feedbackFile],
    });
    const resumed = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[1], sample.other);
    assert.equal(resumed.fullStageReanalysisHistory.length, historyLength);
    assert.deepEqual(resumed.fullStageReanalysisHistory[0].originalPaper, original);
});

test('签名完整成功样本退出作用域仍合格，同run公共再次进入零模型请求且不改两篇记录', async t => {
    const sample = await createSample(t, { fullSource: false });
    sample.paper.analysisManifest.version = 1;
    sample.paper.analysisManifest.stages.openSourceScan.status = 'complete';
    assert.equal(engine.getIncompleteAnalysisContentReason(sample.paper), null);
    let completed;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () => {
        const prepared = policy.preparePaperLocked(sample.paper);
        completed = structuredClone(sample.paper);
        completed.fullStageReanalysis = prepared.fullStageReanalysis;
        completed.fullStageReanalysisHistory = prepared.fullStageReanalysisHistory;
        // 使用既有签名正文验证完成资格与入口跳过，不声称测试模型生成了这篇正文。
        fresh.withFreshPaperContext(completed, () => {
            for (const name of ['primaryAnalysis', 'scoringAudit', 'apiReaderArticle']) {
                deep.markRecoveryStage(completed.analysisManifest, name, 'complete', completed.analysisManifest.stages[name]);
            }
        });
    })));
    assert.equal(engine.isSuccessfulAnalysisRecord(completed), true);
    assert.equal(policy.completedThisRun(completed), true);
    const outside = policy.fingerprintFields(completed);
    assert.deepEqual(outside, await inScope(sample, () => policy.fingerprintFields(completed)));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-stage-complete-'));
    const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
    Config.FILES.papers = path.join(root, 'papers.json');
    Config.FILES.papersLegacy = path.join(root, 'legacy.json');
    Config.FILES.runtimeDir = path.join(root, 'runtime');
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: sample.plan.batchDate,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [completed, sample.other] }));
    const feedbackFile = path.join(root, 'feedback.json');
    fs.writeFileSync(feedbackFile, JSON.stringify(sample.feedback));
    calls.length = 0;
    delete require.cache[require.resolve('../scripts/reanalyze-selected')];
    await require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id], {
        fullStageReanalysis: options(sample), feedbackFiles: [feedbackFile],
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers, [completed, sample.other]);
});

test('正常指定论文付费摘要入口逐层传明确ID且保原稿，未选论文不变', async t => {
    const sample = await createSample(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-core-selected-'));
    const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    const retries = Config.ANALYSIS_CONFIG.maxRetries;
    t.after(() => { Object.assign(Config.FILES, previous); Config.ANALYSIS_CONFIG.maxRetries = retries; fs.rmSync(root, { recursive: true, force: true }); });
    for (const key of keys) Config.FILES[key] = path.join(root, key + '.json');
    Config.ANALYSIS_CONFIG.maxRetries = 1;
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
    const input = { batchDate: sample.plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [sample.paper, sample.other] };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(input));
    const id = 'd9077527-0d59-4d92-8d0c-0e3d7b10007f'; let seen = 0;
    const spy = t.mock.method(deep, 'analyzePaperDeep', async (paper, options) => {
        seen++; assert.equal(options.coreSummaryDiagnosticId, id);
        assert.equal(fresh.getFreshAnalysisContext().refreshReaderDiagnostics, true);
        assert.equal(paper.analysis, sample.paper.analysis);
        assert.deepEqual(paper.apiReaderPlan, sample.paper.apiReaderPlan);
        assert.deepEqual(paper.analysisManifest.stages.apiReaderArticle, sample.paper.analysisManifest.stages.apiReaderArticle);
        const error = new Error('测试只验证正常公开参数链，无模型请求'); error.retryable = false; throw error;
    });
    const modulePath = require.resolve('../scripts/reanalyze-selected');
    delete require.cache[modulePath];
    const selected = require(modulePath);
    await selected.reanalyzeSelected([sample.id], { refreshReaderDiagnostics: true, coreSummaryDiagnosticIds: { [sample.id]: id } });
    spy.mock.restore();
    assert.equal(seen, 1);
    await assert.rejects(selected.reanalyzeSelected([sample.id], { refreshReaderDiagnostics: 'true' }), /必须为布尔值/);
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[1], sample.other);
    await assert.rejects(selected.reanalyzeSelected([sample.id], { coreSummaryDiagnosticIds: { [sample.other.arxivId.replace(/v\d+$/, '')]: id } }), /本次选定论文/);
    let continued;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () => {
        continued = policy.preparePaperLocked(sample.paper);
        const record = continued.fullStageReanalysis, history = continued.fullStageReanalysisHistory;
        Object.assign(continued, structuredClone(sample.paper));
        continued.fullStageReanalysis = record; continued.fullStageReanalysisHistory = history;
        deep.markRecoveryStage(continued.analysisManifest, 'primaryAnalysis', 'complete', { fingerprint: '测试本轮已付费主阶段' });
    })));
    const history = structuredClone(continued.fullStageReanalysisHistory);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ ...input, papers: [continued, sample.other] }));
    const feedbackFile = path.join(root, 'feedback.json'); fs.writeFileSync(feedbackFile, JSON.stringify(sample.feedback));
    let sameRun = 0;
    const sameRunSpy = t.mock.method(deep, 'analyzePaperDeep', async (paper, callOptions) => {
        sameRun++; assert.equal(callOptions.coreSummaryDiagnosticId, id);
        assert.deepEqual(paper.fullStageReanalysisHistory, history);
        assert.equal(paper.analysisManifest.stages.primaryAnalysis.fingerprint, '测试本轮已付费主阶段');
        policy.assertPrepared(paper);
        fresh.withFreshPaperContext(paper, () => {
        const manifest = structuredClone(paper.analysisManifest);
        for (const stage of ['coreSummaryRepair', 'scoringAudit', 'apiReaderArticle']) {
            deep.markRecoveryStage(manifest, stage, 'complete');
            assert.equal(manifest.stages[stage].fullStageReanalysisRunId, options(sample).runId);
        }
        });
        const error = new Error('同轮真实作用域及正常stage stamp检查后停止'); error.retryable = false; throw error;
    });
    await selected.reanalyzeSelected([sample.id], { fullStageReanalysis: options(sample), feedbackFiles: [feedbackFile], coreSummaryDiagnosticIds: { [sample.id]: id } });
    sameRunSpy.mock.restore(); assert.equal(sameRun, 1);
    const retained = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.deepEqual(retained.papers[0].fullStageReanalysisHistory, history);
    assert.deepEqual(retained.papers[1], sample.other);

});

function createCoreFeedback(sample) {
    const core = structuredClone(sample.feedback);
    for (const key of ['primaryFeedback', 'rejectedPrimaryClaims', 'tagFeedback', 'rejectedTagClaims', 'scoringFeedback', 'rejectedScoringClaims']) delete core[key];
    core.readerFeedback = ''; core.rejectedReaderClaims = [];
    core.coreFeedback = '仅修核心摘要，原文有量化结果，保留原主文其他十二节与旧事实约束。';
    core.rejectedCoreClaims = ['原文未提供可核对的关键定量结果。'];
    return core;
}

test('独立核心反馈保原主文proof，当前核心新proof仅影响核心且禁止主文请求', async t => {
    const sample = await createSample(t);
    const core = createCoreFeedback(sample);
    const bound = facts.validateFeedback(core, sample.plan, sample.paper);
    const before = structuredClone(sample.paper);
    assert.throws(() => facts.withCoreSummaryFactReview(bound, sample.paper, () => {}), /当前论文锁/);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () =>
        facts.withCoreSummaryFactReview(bound, sample.paper, async () => {
            assert.deepEqual(facts.current().proof, sample.bound.proof);
            assert.deepEqual(facts.fingerprintFields('primaryAnalysis', sample.paper.analysisManifest.stages.primaryAnalysis), { factReview: sample.bound.proof });
            assert.deepEqual(facts.fingerprintFields('coreSummaryRepair'), { factReview: bound.proof });
            assert.ok(facts.reviewFeedback('coreSummaryRepair', sample.id).includes(core.coreFeedback));
            assert.ok(facts.reviewFeedback('coreSummaryRepair', sample.id).includes(sample.feedback.primaryFeedback));
            assert.throws(() => facts.validateRepairedClaims('coreSummaryRepair', core.rejectedCoreClaims[0]), /已证实错误/);
            assert.throws(() => facts.validateRepairedClaims('coreSummaryRepair', sample.feedback.rejectedPrimaryClaims[0]), /已证实错误/);
            for (const stage of ['primaryAnalysis', 'revision', 'structureRepair', 'methodRepair', 'tableRepair', 'openSourceScan', undefined])
                await assert.rejects(deep.callModelWithConfig([{role:'user',content:'不得请求'}], 16, 1, {usageContext:{stage}}), /不能调用主分析/);
            for (const stage of ['coreSummaryRepair','scoringAudit','apiReaderArticle','apiReaderRepair','apiReaderImageProbe'])
                assert.doesNotThrow(() => facts.assertScoringOnlyModelStageAllowed(stage));
        }))));
    assert.deepEqual(sample.paper, before);
    const unauthorized = { ...core, readerFeedback: '越权Reader', rejectedReaderClaims: ['错误Reader'] };
    const otherBound = facts.validateFeedback(unauthorized, sample.plan, sample.paper);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        assert.throws(() => facts.withCoreSummaryFactReview(otherBound, sample.paper, () => {}), /不能授权/)));
});


test('正常selected同轮核心双包实际核验且不换primary或原账，旧主文模型入口零调用', async t => {
    const sample = await createSample(t, { quantitativeSource: true });
    let continued;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () => {
        continued = policy.preparePaperLocked(sample.paper);
        const record = continued.fullStageReanalysis, history = continued.fullStageReanalysisHistory;
        Object.assign(continued, structuredClone(sample.paper));
        continued.fullStageReanalysis = record; continued.fullStageReanalysisHistory = history;
        deep.markRecoveryStage(continued.analysisManifest,'primaryAnalysis','complete', { factReview:sample.bound.proof, fingerprint:'本轮真实测试主阶段' });
    })));
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'core-dual-public-'));
    const keys=['deepAnalysisResult','papers','papersLegacy','runtimeDir','analysisRepairAttemptsDir'];
    const previous=Object.fromEntries(keys.map(key=>[key,Config.FILES[key]])); const retries=Config.ANALYSIS_CONFIG.maxRetries;
    t.after(()=>{Object.assign(Config.FILES,previous);Config.ANALYSIS_CONFIG.maxRetries=retries;fs.rmSync(root,{recursive:true,force:true});});
    for(const key of keys) Config.FILES[key]=path.join(root,key+'.json'); Config.ANALYSIS_CONFIG.maxRetries=0;
    fs.writeFileSync(Config.FILES.papers,JSON.stringify({papers:[]}));fs.writeFileSync(Config.FILES.papersLegacy,JSON.stringify({papers:[]}));
    const parentFile=path.join(root,'parent.json'),coreFile=path.join(root,'core.json');
    fs.writeFileSync(parentFile,JSON.stringify(sample.feedback));fs.writeFileSync(coreFile,JSON.stringify(createCoreFeedback(sample)));
    const input={batchDate:sample.plan.batchDate,dailyFreshSourceRun:daily.dailyFreshSourceReference(sample.plan),papers:[continued,sample.other]};
    fs.writeFileSync(Config.FILES.deepAnalysisResult,JSON.stringify(input));
    const expectedPrimary=structuredClone(continued.analysisManifest.stages.primaryAnalysis), history=structuredClone(continued.fullStageReanalysisHistory);
    let seen=0, verifiedCore=false;calls.length=0;
    const spy=t.mock.method(deep,'analyzePaperDeep',async paper=> {
        seen++; policy.assertPrepared(paper);
        assert.deepEqual(facts.current().proof,sample.bound.proof);
        assert.deepEqual(paper.analysisManifest.stages.primaryAnalysis,expectedPrimary);
        assert.deepEqual(paper.fullStageReanalysisHistory,history);
        let coreCalls=0;
        const good=deep.extractSectionByTitle(paper.analysis,'核心摘要').replace(sample.feedback.rejectedPrimaryClaims[0],
            '本文研究噪声条件下语音识别的稳健性，输入为声学序列，输出为文字序列，局部干扰与长程语义错误是主要难点。');
        const source=daily.readDailyFreshSource(sample.plan,paper);
        const repaired=await deep.repairCoreSummarySection(paper,paper.analysis,source.text,source.text,{
            reviewFeedback:facts.reviewFeedback('coreSummaryRepair',sample.id),
            callModelFn:async()=> {coreCalls++;return '## 核心摘要\n'+(coreCalls===1?good.replace('本文研究','原文未提供可核对的关键定量结果。本文研究'):good);}
        });
        assert.equal(coreCalls,2); verifiedCore=true;
        assert.ok(!repaired.includes('原文未提供可核对的关键定量结果。'));
        const exterior=text=>text.replace(/## 核心摘要\n[\s\S]*?(?=\n## )/,'## 核心摘要\n[仅此节]');
        assert.equal(exterior(repaired),exterior(paper.analysis));
        const newCore=facts.fingerprintFields('coreSummaryRepair').factReview;
        assert.notEqual(newCore.feedbackSha256,sample.bound.proof.feedbackSha256);
        fresh.withFreshPaperContext(paper,()=> {
            const manifest=structuredClone(paper.analysisManifest);
            deep.markRecoveryStage(manifest,'coreSummaryRepair','complete',{...facts.fingerprintFields('coreSummaryRepair')});
            assert.equal(manifest.stages.coreSummaryRepair.fullStageReanalysisRunId,options(sample).runId);
            assert.deepEqual(manifest.stages.primaryAnalysis,expectedPrimary);
        });
        const error=new Error('正常双包进入核心范围后测试停止，未发模型');error.retryable=false;throw error;
    });
    delete require.cache[require.resolve('../scripts/reanalyze-selected')];const selected=require('../scripts/reanalyze-selected');
    await selected.reanalyzeSelected([sample.id],{fullStageReanalysis:options(sample),feedbackFiles:[parentFile],coreFeedbackFiles:[coreFile]});
    spy.mock.restore();assert.equal(seen,1);assert.equal(verifiedCore,true);assert.equal(calls.length,0);
    const saved=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.deepEqual(saved.papers[0].fullStageReanalysisHistory,history);
    assert.deepEqual(saved.papers[0].analysisManifest.stages.primaryAnalysis,expectedPrimary);
    assert.deepEqual(saved.papers[1],sample.other);
    await assert.rejects(selected.reanalyzeSelected([sample.id],{coreFeedbackFiles:false}),/路径数组/);
    const coreBytes=fs.readFileSync(coreFile);
    const batchSpy=t.mock.method(engine,'analyzeBatch',async (papers,config)=>
        engine.withPaperAnalysisLock(papers[0],async()=>{
            const prepared=await config.preparePaperLocked(papers[0]);
            fs.appendFileSync(coreFile,' ');
            return config.analyzeFn(prepared.paper);
        }));
    delete require.cache[require.resolve('../scripts/reanalyze-selected')];
    await assert.rejects(require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id],{
        fullStageReanalysis:options(sample),feedbackFiles:[parentFile],coreFeedbackFiles:[coreFile]
    }),/核心反馈文件在运行中变化/);
    batchSpy.mock.restore();fs.writeFileSync(coreFile,coreBytes);
    assert.equal(calls.length,0);
    const invalid={...createCoreFeedback(sample),sourceQuotes:['不是封存原句']};
    fs.writeFileSync(coreFile,JSON.stringify(invalid));
    await assert.rejects(selected.reanalyzeSelected([sample.id],{coreFeedbackFiles:[coreFile]}),/不是封存来源逐字引文/);

});

test('核心真实变更并保存后，同一原输入包可在下游失败后复用新proof且不再请求核心', async t => {
    const sample=await createSample(t),core=createCoreFeedback(sample);
    core.coreFeedback='仅按来源修核心摘要，保留其他章节。';
    core.rejectedCoreClaims=[sample.feedback.rejectedPrimaryClaims[0]];
    const original=structuredClone(sample.paper),bound=facts.validateFeedback(core,sample.plan,original);
    const paper=structuredClone(original),source=daily.readDailyFreshSource(sample.plan,paper);
    let modelCalls=0;
    await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>fresh.withFreshPaperContext(paper,()=>facts.withFactReview(sample.bound,()=>facts.withCoreSummaryFactReview(bound,paper,async()=>{
        deep.saveAnalysisCheckpoint(paper,paper.analysis,paper.analysisManifest);
        const prepared=deep.prepareTextRecoveryStage(paper,paper.analysisManifest,'coreSummaryRepair',paper.analysis,source.text);
        const good=deep.extractSectionByTitle(paper.analysisCheckpoint,'核心摘要').replace(sample.feedback.rejectedPrimaryClaims[0],
            '本文研究噪声条件下语音识别的稳健性，输入为声学序列，输出为文字序列，局部干扰与长程语义错误是主要难点。');
        const repaired=await deep.repairCoreSummarySection(paper,prepared.inputAnalysis,source.text,prepared.evidenceContext,{
            reviewFeedback:facts.reviewFeedback('coreSummaryRepair',sample.id),callModelFn:async()=>{modelCalls++;return '## 核心摘要\n'+good+'原文未提供可核对的关键定量结果。';}});
        deep.markRecoveryStage(paper.analysisManifest,'coreSummaryRepair','complete',{
            fingerprint:prepared.fingerprint,promptTextContract:prepared.promptTextContract,...facts.fingerprintFields('coreSummaryRepair')});
        deep.saveAnalysisCheckpoint(paper,repaired,paper.analysisManifest);
        paper.analysis=repaired;
        deep.markRecoveryStage(paper.analysisManifest,'apiReaderArticle','transient_failure',{error:'下游网络失败，原核心保留'});
    })))));
    assert.equal(modelCalls,1);assert.notEqual(facts.sha(paper.analysis),core.coreAnalysisSha256);
    const saved=JSON.parse(JSON.stringify(paper));
    const rebound=facts.validateFeedback(core,sample.plan,saved);
    await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(saved,()=>fresh.withFreshPaperContext(saved,()=>facts.withFactReview(sample.bound,()=>facts.withCoreSummaryFactReview(rebound,saved,()=>{
        const next=deep.prepareTextRecoveryStage(saved,saved.analysisManifest,'coreSummaryRepair',saved.analysis,source.text);
        assert.equal(saved.analysisManifest.stages.coreSummaryRepair.status,'complete');
        assert.equal(next.fingerprint,saved.analysisManifest.stages.coreSummaryRepair.fingerprint);
        assert.deepEqual(facts.current().proof,sample.bound.proof);
    })))));
    assert.equal(modelCalls,1);
    const invalid=structuredClone(saved);invalid.analysisManifest.stages.coreSummaryRepair.factReview={...bound.proof,feedbackSha256:'a'.repeat(64)};
    await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(invalid,()=>assert.throws(()=>facts.withFactReview(sample.bound,()=>facts.withCoreSummaryFactReview(rebound,invalid,()=>{})),/缺少原核心|绑定已过期/)));
});

test('没有原主文反馈的核心包保留真实输入快照，不伪补primary proof', async t => {
    const sample=await createSample(t),paper=structuredClone(sample.paper);
    delete paper.analysisManifest.stages.primaryAnalysis.factReview;
    const bound=facts.validateFeedback(createCoreFeedback(sample),sample.plan,paper);
    await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>fresh.withFreshPaperContext(paper,()=>facts.withCoreSummaryFactReview(bound,paper,()=>{
        assert.equal(facts.current().proof,null);
        deep.saveAnalysisCheckpoint(paper,paper.analysis,paper.analysisManifest);
        const result=deep.captureStaleAnalysisSnapshot(paper,paper.analysisManifest,'coreSummaryRepair','a'.repeat(64));
        assert.ok(result);assert.ok(deep.validateStaleAnalysisSnapshot(result));
        assert.equal(facts.sha(result.payload.analysisCheckpoint),bound.proof.coreAnalysisSha256);
        assert.equal(paper.analysisManifest.stages.primaryAnalysis.factReview,undefined);
    }))));
});

test('实际analyze入口无原parent核心scope不解引用null，保输入快照且禁止主文新请求',async t=>{
 const sample=await createSample(t),paper=structuredClone(sample.paper);delete paper.analysisManifest.stages.primaryAnalysis.factReview;
 const core=createCoreFeedback(sample),bound=facts.validateFeedback(core,sample.plan,paper);let result;calls.length=0;
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>facts.withCoreSummaryFactReview(bound,paper,async()=>{result=await deep.analyzePaperDeep(paper);})),{refreshReaderDiagnostics:true});
 assert.ok(result);assert.doesNotMatch(String(result.error||''),/Cannot read properties of null|feedbackSha256/);
 assert.ok((paper.analysisStaleSnapshots||[]).some(s=>{const value=deep.validateStaleAnalysisSnapshot(s);return value&&facts.sha(value.analysisCheckpoint)===bound.proof.coreAnalysisSha256;}));
 assert.equal(paper.analysisManifest.stages.primaryAnalysis?.factReview,undefined);
 assert.equal(calls.filter(c=>c.stage==='primaryAnalysis').length,0);
});

function createReaderFeedback(sample) {
    const value = createCoreFeedback(sample);
    value.coreFeedback = '';
    value.rejectedCoreClaims = [];
    value.readerFeedback = sample.feedback.readerFeedback + '\n只纠正Reader中的真实错误表述；正确的来源、数字和其他阶段不改。';
    value.rejectedReaderClaims = [...sample.feedback.rejectedReaderClaims, 'Reader中已证实错误的完整句子。'];
    return value;
}

test('Reader双包保留原主文proof，仅Reader使用新约束并拒绝混合授权', async t => {
    const sample = await createSample(t);
    const before = structuredClone(sample.paper);
    const feedback = createReaderFeedback(sample);
    const bound = facts.validateFeedback(feedback, sample.plan, sample.paper);
    assert.throws(() => facts.withReaderFactReview(bound, sample.paper, () => {}), /当前论文锁/);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        facts.withFactReview(sample.bound, () => facts.withReaderFactReview(bound, sample.paper, () => {
            assert.deepEqual(facts.current().proof, sample.bound.proof);
            assert.deepEqual(facts.fingerprintFields('apiReaderArticle'), { factReview: bound.proof });
            assert.deepEqual(facts.fingerprintFields('primaryAnalysis', sample.paper.analysisManifest.stages.primaryAnalysis), { factReview: sample.bound.proof });
            assert.ok(facts.reviewFeedback('apiReaderArticle', sample.id).includes(feedback.readerFeedback));
            assert.ok(facts.reviewFeedback('apiReaderArticle', sample.id).includes(sample.feedback.primaryFeedback));
            assert.throws(() => facts.validateRepairedClaims('apiReaderArticle', feedback.rejectedReaderClaims[0]), /已证实错误/);
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit', 'revision', undefined])
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed(stage), /不能调用/);
        }))));
    assert.deepEqual(sample.paper, before);
    const mixed = facts.validateFeedback({ ...feedback, coreFeedback: '不得扩大', rejectedCoreClaims: ['不得扩大'] }, sample.plan, sample.paper);
    await engine.withPaperAnalysisLock(sample.paper, () => assert.throws(() => facts.withReaderFactReview(mixed, sample.paper, () => {}), /不能授权/));
    const bad = structuredClone(sample.paper);
    bad.analysisManifest.stages.primaryAnalysis.factReview = { ...sample.bound.proof, feedbackSha256: 'a'.repeat(64) };
    await engine.withPaperAnalysisLock(bad, () => assert.throws(() => facts.withFactReview(sample.bound, () => facts.withReaderFactReview(bound, bad, () => {})), /缺少原主分析/));
});

test('正常selected未完成Reader双包通过同fullrun身份并保存真实新Readerproof', async t => {
    const sample = await createSample(t, { quantitativeSource: true });
    let paper;
    await inScope(sample, () => engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.bound, () => {
        paper = policy.preparePaperLocked(sample.paper);
        const record = paper.fullStageReanalysis, history = paper.fullStageReanalysisHistory;
        Object.assign(paper, structuredClone(sample.paper));
        paper.fullStageReanalysis = record; paper.fullStageReanalysisHistory = history;
        deep.markRecoveryStage(paper.analysisManifest, 'primaryAnalysis', 'complete', { factReview: sample.bound.proof, fingerprint: '原本轮主阶段' });
    })));
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-dual-public-'));
    const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir', 'analysisRepairAttemptsDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    const retries = Config.ANALYSIS_CONFIG.maxRetries;
    t.after(() => { Object.assign(Config.FILES, previous); Config.ANALYSIS_CONFIG.maxRetries = retries; fs.rmSync(root, { recursive: true, force: true }); });
    for (const key of keys) Config.FILES[key] = path.join(root, key + '.json');
    Config.ANALYSIS_CONFIG.maxRetries = 0;
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
    const parentFile = path.join(root, 'parent.json'), readerFile = path.join(root, 'reader.json');
    const reader = createReaderFeedback(sample);
    fs.writeFileSync(parentFile, JSON.stringify(sample.feedback)); fs.writeFileSync(readerFile, JSON.stringify(reader));
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: sample.plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [paper, sample.other] }));
    const originalPrimary = structuredClone(paper.analysisManifest.stages.primaryAnalysis), originalHistory = structuredClone(paper.fullStageReanalysisHistory);
    let seen = 0; calls.length = 0;
    const spy = t.mock.method(deep, 'analyzePaperDeep', async current => {
        seen++; policy.assertPrepared(current);
        assert.deepEqual(facts.current().proof, sample.bound.proof);
        const proof = facts.fingerprintFields('apiReaderArticle').factReview;
        assert.equal(proof.feedbackSha256, daily.stableHash(reader));
        assert.notEqual(proof.feedbackSha256, sample.bound.proof.feedbackSha256);
        const source = daily.readDailyFreshSource(sample.plan, current);
        const identity = await deep.prepareApiReaderRetryIdentity(current, current.analysis, source.text, { sourceText: source.text, structuredArtifacts: source.structuredArtifacts, reviewFeedback: facts.reviewFeedback('apiReaderArticle', sample.id) });
        const plainIdentity = await deep.prepareApiReaderRetryIdentity(current, current.analysis, source.text, { sourceText: source.text, structuredArtifacts: source.structuredArtifacts, reviewFeedback: '' });
        assert.notEqual(identity.identity.inputFingerprint, plainIdentity.identity.inputFingerprint);
        deep.markRecoveryStage(current.analysisManifest, 'apiReaderArticle', 'invalid_output', { ...facts.fingerprintFields('apiReaderArticle'), error: '模拟正常Reader来源检查失败，保留新反馈' });
        throw Object.assign(new Error('Reader测试失败稿，未发API'), { retryable: false });
    });
    delete require.cache[require.resolve('../scripts/reanalyze-selected')];
    await require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id], { fullStageReanalysis: options(sample), feedbackFiles: [parentFile], readerFeedbackFiles: [readerFile] });
    spy.mock.restore(); assert.equal(seen, 1); assert.equal(calls.length, 0);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers;
    assert.deepEqual(saved[0].analysisManifest.stages.primaryAnalysis, originalPrimary);
    assert.deepEqual(saved[0].fullStageReanalysisHistory, originalHistory);
    assert.equal(saved[0].analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256, daily.stableHash(reader));
    assert.deepEqual(saved[1], sample.other);
    await assert.rejects(require('../scripts/reanalyze-selected').reanalyzeSelected([sample.id], { readerFeedbackFiles: false }), /路径数组/);
});


test('无原parent的Reader双包不伪造主文proof，已变Reader反馈proof必须有原包', async t => {
    const sample = await createSample(t), paper = structuredClone(sample.paper);
    delete paper.analysisManifest.stages.primaryAnalysis.factReview;
    delete paper.analysisManifest.stages.apiReaderArticle.factReview;
    const feedback = createReaderFeedback(sample), bound = facts.validateFeedback(feedback, sample.plan, paper);
    await engine.withPaperAnalysisLock(paper, () => facts.withReaderFactReview(bound, paper, () => {
        assert.equal(facts.current().proof, null);
        assert.deepEqual(facts.readerRejectedClaims(sample.id), feedback.rejectedReaderClaims);
        assert.deepEqual(facts.fingerprintFields('primaryAnalysis', paper.analysisManifest.stages.primaryAnalysis), {});
        assert.deepEqual(facts.fingerprintFields('apiReaderArticle').factReview, bound.proof);
    }));
    paper.analysisManifest.stages.apiReaderArticle.factReview = { ...bound.proof, feedbackSha256: 'b'.repeat(64) };
    await engine.withPaperAnalysisLock(paper, () => assert.throws(() => facts.withReaderFactReview(bound, paper, () => {}), /缺少原Reader/));
});


test('实际deep入口有无parent的Reader独立反馈都保存正确Reader快照且无新主文请求', async t => {
    const sample = await createSample(t);
    for (const parent of [false, true]) {
        const paper = structuredClone(sample.paper);
        if (!parent) { delete paper.analysisManifest.stages.primaryAnalysis.factReview; delete paper.analysisManifest.stages.apiReaderArticle.factReview; }
        const reader = createReaderFeedback(sample), bound = facts.validateFeedback(reader, sample.plan, paper);
        let result; calls.length = 0;
        const run = () => facts.withReaderFactReview(bound, paper, async () => { result = await deep.analyzePaperDeep(paper); });
        await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(paper, () => parent ? facts.withFactReview(sample.bound, run) : run()), { refreshReaderDiagnostics: true });
        assert.ok(result);
        assert.doesNotMatch(String(result.error || ''), /Cannot read properties of null|feedbackSha256/);
        assert.equal(calls.length, 0, '主文/核心/评分请求须在公共模型入口前拒绝');
        const snapshots = (paper.analysisStaleSnapshots || []).filter(item => item.invalidatedStage === 'apiReaderArticle' && item.replacementFingerprint === bound.proof.feedbackSha256);
        assert.ok(snapshots.length > 0, JSON.stringify({ parent, error: result.error, snapshots: (paper.analysisStaleSnapshots || []).map(x => ({ stage: x.invalidatedStage, fingerprint: x.replacementFingerprint })) }));
        assert.ok(snapshots.some(item => { const payload = deep.validateStaleAnalysisSnapshot(item); return payload && facts.sha(payload.analysisCheckpoint) === bound.proof.coreAnalysisSha256; }));
        if (!parent) assert.equal(paper.analysisManifest.stages.primaryAnalysis.factReview, undefined);
        else assert.deepEqual(paper.analysisManifest.stages.primaryAnalysis.factReview, sample.bound.proof);
    }
});
