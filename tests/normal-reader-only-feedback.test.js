process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const facts = require('../scripts/lib/daily-fact-review');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validAnalysisPaper } = require('./valid-analysis-fixture');

const failure = '局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';

async function createReviewedReaderSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reviewed-reader-seed-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol.\n' + 'Additional method evidence describes experimental conditions and evaluation protocols. '.repeat(100) });
    const sourceText = signed.sourceDetails.text;
    const sourceArtifacts = deep.bindStructuredArtifactsToText(signed.sourceDetails.structuredArtifacts, sourceText);
    const id = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'reader-seed',
        papers: [{ arxivId: signed.paper.arxivId, title: '正文已纠正的修订参考', authors: signed.paper.authors }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
        sourceApi.captureFreshArxivRewriteSource(options, {
            fetchText: async sourceId => ({ ...signed.sourceDetails, text: sourceText, structuredArtifacts: sourceArtifacts, source: 'html',
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [], sourceId,
                url: `https://arxiv.org/html/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' }),
            fetchPdf: async sourceId => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' })
        }) });
    const paper = { ...validAnalysisPaper(signed.paper.arxivId), ...signed.paper };
    const validManifest = validAnalysisPaper(signed.paper.arxivId).analysisManifest;
    paper.analysisManifest.version = validManifest.version;
    paper.analysisManifest.contracts = { ...validManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...validManifest.stages, ...paper.analysisManifest.stages };
    paper.analysisManifest.stages.scoringAudit.scoringContract = 'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.stabilityWarning = false;
    paper.analysisManifest.stages.scoringAudit.auditSha256 = deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(paper.analysis);
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT;
    paper.analysisManifest.sourceAcquisition.promptRenderingContract = require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT;
    const source = daily.readDailyFreshSource(plan, paper);
    paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition.sourceSha256 = paper.sourceSha256;
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = source.freshSourceDescriptor.structuredArtifactsSha256;
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    const folder = path.join(plan.sourcesDir, id, 'generation-000001');
    const feedback = { contract: facts.CONTRACT, paperId: id, runId: plan.runId, batchDate: plan.batchDate,
        sourceFiles: Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, facts.sha(fs.readFileSync(path.join(folder, name)))])),
        coreAnalysisSha256: facts.sha(paper.analysis), coreSummarySha256: facts.sha(deep.extractSectionByTitle(paper.analysis, '核心摘要')),
        primaryFeedback: '保留已经纠正的主文，只按原证据解释。', coreFeedback: '', readerFeedback: '只修本次明确的读者文章问题。',
        rejectedPrimaryClaims: ['原来的错误已消失'], rejectedCoreClaims: [], rejectedReaderClaims: ['已纠正的旧Reader错误'],
        sourceQuotes: [source.text.slice(0, 100)] };
    const bound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(feedback.readerFeedback.trim());
    feedback.primaryFeedback = '';
    const finalBound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview = finalBound.proof;
    return { paper, plan, source, feedback, bound, id };
}

const saved = require('../scripts/lib/saved-fact-feedback');
for (const mode of ['deep', 'batch']) {
    test(`正常${mode}仅Reader反馈使用真实Reader请求并保原主文摘要评分与旧费`, async t => {
        const sample = await createReviewedReaderSample(t);
        const parent = facts.validateFeedback(sample.feedback, sample.plan, sample.paper);
        facts.withFactReview(parent, () => undefined);
        const feedback = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: sample.feedback.readerFeedback + ' 当前重建文章解释，保留正确事实。' };
        const child = facts.validateFeedback(feedback, sample.plan, sample.paper);
        const priorStages = structuredClone(sample.paper.analysisManifest.stages);
        sample.paper.latestAnalysisAttemptError = '保留上轮Reader失败';
        sample.paper.paidResponseHistory = [{ model: 'old-model', totalTokens: 42, responseId: 'original-paid-response' }];
        // 旧Reader字节保留，最新Reader失败仍须正常定向恢复。
        const originalAnalysis = sample.paper.analysis;
        const previous = Object.fromEntries(['deepAnalysisResult', 'filteredPapers', 'papers'].map(key => [key, Config.FILES[key]]));
        t.after(() => Object.assign(Config.FILES, previous));
        for (const key of Object.keys(previous)) Config.FILES[key] = path.join(sample.plan.runDir, mode + '-' + key + '.json');
        const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
        const payload = { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
            dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [sample.paper] };
        write(Config.FILES.deepAnalysisResult, payload);
        write(Config.FILES.filteredPapers, { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId, status: 'complete', papers: [sample.paper] });
        write(Config.FILES.papers, { generation: 1, papers: {} });
        const file = path.join(sample.plan.runDir, 'new-reader-feedback.json');
        write(file, feedback);
        const stages = [];
        const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
        t.mock.method(require('../scripts/utils'), 'requestLlmJson', async (_url, _endpoint, model, _body, _headers, requestOptions) => {
            assert.equal(model, 'muse-spark-1.3-contributor');
            stages.push(requestOptions.usageContext.stage);
            assert.equal(requestOptions.usageContext.stage, 'apiReaderArticle');
            return { statusCode: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(signed.draft) }] }] } };
        });
        const moduleFile = require.resolve('../scripts/deep-analyzer');
        const originalModule = require.cache[moduleFile];
        delete require.cache[moduleFile];
        const analyzer = require(moduleFile);
        t.after(() => { require.cache[moduleFile] = originalModule; });
        const run = options => {
            const entryFile = require.resolve(mode === 'deep' ? '../scripts/deep-analysis-only' : '../scripts/batch-analyze');
            delete require.cache[entryFile];
            return mode === 'deep' ? require(entryFile).runDeepAnalysis(options) : require(entryFile).main(options);
        };
        let resultPaper;
        const result = await run({ date: sample.plan.batchDate, id: sample.id, coreFeedbackFile: mode === 'deep' ? file : undefined,
            factFeedbackFiles: mode === 'batch' ? [file] : undefined,
            analyzeFn: () => assert.fail('Reader范围不得调用整篇分析'),
            analyzeBatch: async (papers, options) => engine.withPaperAnalysisLock(papers[0], async () => {
                const locked = options.preparePaperLocked(papers[0]);
                assert.equal(locked.skip, false);
                const outcome = await engine.analyzePaperWithRetry(locked.paper, { maxRetries: 0,
                    analyzeFn: options.analyzeFn });
                assert.equal(outcome.success, true, outcome.error);
                resultPaper = outcome.result;
                return { stats: { success: 1, failed: 0, skipped: 0, sourceCounts: {} } };
            }) });
        assert.deepEqual(stages, ['apiReaderArticle']);
        assert.equal(resultPaper.analysis, originalAnalysis);
        for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit']) assert.deepEqual(resultPaper.analysisManifest.stages[stage], priorStages[stage]);
        assert.deepEqual(resultPaper.paidResponseHistory, sample.paper.paidResponseHistory);
        assert.ok(resultPaper.analysisStaleSnapshots.some(snapshot => snapshot.payload.stages.apiReaderArticle));
        assert.deepEqual(resultPaper.analysisManifest.stages.apiReaderArticle.factReview, child.proof);
        assert.equal(resultPaper.latestAnalysisAttemptError, undefined, '真实引擎成功收尾清除旧失败');
        assert.equal(resultPaper.apiReaderArticle.length > 5000, true);
        assert.ok(result);
    });
}

test('Reader-only缺前置、原父包或过期绑定均在模型请求前拒绝', async t => {
    const sample = await createReviewedReaderSample(t);
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    let requests = 0;
    t.mock.method(require('../scripts/utils'), 'requestLlmJson', () => { requests++; assert.fail('不得请求模型'); });
    const invoke = (paper, packet) => daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(paper, () => saved.analyzeWithRecoveredFeedback(paper, sample.plan,
            () => assert.fail('Reader范围不得退回主分析'), packet)));
    const missing = structuredClone(sample.paper);
    missing.analysisManifest.stages.scoringAudit.status = 'failed';
    await assert.rejects(invoke(missing, feedback), { code: 'READER_UPSTREAM_INCOMPLETE' });
    await assert.rejects(invoke(sample.paper, feedback), { code: 'READER_PARENT_FEEDBACK_MISSING' });
    facts.withFactReview(facts.validateFeedback(sample.feedback, sample.plan, sample.paper), () => undefined);
    await assert.rejects(invoke(sample.paper, { ...feedback, coreAnalysisSha256: 'a'.repeat(64) }),
        { code: 'DAILY_FACT_REVIEW_INTEGRITY' });
    assert.equal(requests, 0);
});
