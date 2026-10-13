process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test.mock.method(require('../scripts/env-loader'), 'loadProjectEnv', () => {
    const environment = {
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor', PAPER_ANALYZER_ENDPOINT: 'https://invalid.example/v1',
        PAPER_ANALYZER_API_KEY: 'unused-test-no-network', PAPER_ANALYZER_FALLBACK_API_KEYS: '',
        PAPER_ANALYZER_SECONDARY_MODEL: 'muse-spark-1.3-contributor', PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://invalid.example/v1',
        PAPER_ANALYZER_SECONDARY_API_KEY: 'unused-test-no-network', PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: '',
        PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY: '', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9'
    };
    Object.assign(process.env, environment);
    return environment;
});
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const facts = require('../scripts/lib/daily-fact-review');
const requestApi = require('../scripts/utils');
const originalRequestLlmJson = requestApi.requestLlmJson;
let publicReaderRequestObserver = null;
// 深度模块会捕获请求函数，须在加载前安装测试边界。
requestApi.requestLlmJson = (...args) => publicReaderRequestObserver
    ? publicReaderRequestObserver(...args) : originalRequestLlmJson(...args);
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
            assert.equal(requestOptions.usageContext.stage, 'apiReaderArticle',
                '文章纠错不能请求主分析、摘要或评分');
            const prompt = _body.input[0].content.find(part => part.type === 'input_text').text;
            assert.equal(prompt.includes('structuredSourcePayload'), false);
            assert.ok(prompt.includes('"version":3'));
            const text = JSON.stringify(signed.draft);
            const response = { statusCode: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant',
                content: [{ type: 'output_text', text }] }] } };
            if (requestOptions.usageSink) {
                const event = require('../scripts/lib/llm-usage').buildLlmUsageEvent({
                    protocol: 'openai_responses', model, request: _body, response: response.body,
                    statusCode: 200, durationMs: 1, context: requestOptions.usageContext, outputText: text
                });
                requestOptions.usageSink(event);
            }
            return response;
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
        assert.equal(resultPaper.analysisManifest.stages.apiReaderArticle.signedRevisionDisplayContract,
            'signed-reader-minimal-draft-display-v1');
        assert.match(resultPaper.analysisManifest.stages.apiReaderArticle.signedRevisionDisplaySha256, /^[a-f0-9]{64}$/);
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

test('已保存的纯Reader旧包缺下游时进入原恢复并硬性要求复用主分析', async t => {
    const sample = await createReviewedReaderSample(t);
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    facts.withFactReview(bound, () => undefined);
    sample.paper.analysisManifest.stages.scoringAudit.status = 'failed';
    let entered = 0;
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan, recoveryOptions => {
            entered++;
            assert.deepEqual(recoveryOptions, { requireCompletedPrimaryCheckpoint: true });
            assert.equal(facts.current(sample.id).readerOnly, undefined);
            assert.deepEqual(facts.current(sample.id).proof, bound.proof);
        })));
    assert.equal(entered, 1);
});

test('正常深度分析的旧Reader恢复主检查点不可复用时不请求新primary', async t => {
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 404, text: async () => '' }));
    const sample = await createReviewedReaderSample(t);
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    facts.withFactReview(bound, () => undefined);
    sample.paper.analysisManifest.stages.scoringAudit.status = 'failed';
    let requests = 0;
    t.mock.method(require('../scripts/utils'), 'requestLlmJson', () => { requests++; assert.fail('不得重新付费主分析'); });
    const file = require.resolve('../scripts/deep-analyzer');
    const previous = require.cache[file]; delete require.cache[file];
    const analyzer = require(file);
    t.after(() => { require.cache[file] = previous; });
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(sample.paper, () =>
            saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan,
                options => analyzer.analyzePaperDeep(sample.paper, options)))),
        { code: 'READER_UPSTREAM_PRIMARY_NOT_REUSABLE' });
    assert.equal(requests, 0);
});

test('显式提供同旧proof原包仅公共保存并按默认缺阶段恢复，正文费用证明不变', async t => {
    const sample = await createReviewedReaderSample(t);
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    sample.paper.analysisManifest.stages.scoringAudit.status = 'failed';
    const before = structuredClone(sample.paper);
    let called = 0;
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan, options => {
            called++;
            assert.deepEqual(options, { requireCompletedPrimaryCheckpoint: true });
            assert.deepEqual(facts.current(sample.id).proof, bound.proof);
            assert.equal(facts.current(sample.id).readerOnly, undefined);
        }, feedback)));
    assert.equal(called, 1);
    assert.deepEqual(sample.paper, before);
    assert.deepEqual(saved.readSavedFeedback(sample.paper, sample.plan).feedback, feedback);
});

test('历史父与Reader子恢复只为真实新输入合并约束，新子仍须继承', async t => {
    const sample = await createReviewedReaderSample(t);
    const policy = require('../scripts/lib/selected-full-stage-reanalysis');
    const parent = { ...sample.feedback, primaryFeedback: '保留原主文事实条件。',
        readerFeedback: '保留原Reader边界条件。'.repeat(150), rejectedPrimaryClaims: ['原来的错误已消失'],
        rejectedReaderClaims: ['父包已证实错误的句子'] };
    const child = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        readerFeedback: '原子包纠正另一处Reader解释。'.repeat(150), rejectedReaderClaims: ['子包已证实错误的句子'] };
    const parentBound = facts.validateFeedback(parent, sample.plan, sample.paper);
    const childBound = facts.validateFeedback(child, sample.plan, sample.paper);
    for (const [stage, value] of Object.entries(sample.paper.analysisManifest.stages)) {
        value.factReview = stage === 'apiReaderArticle' ? childBound.proof : parentBound.proof;
    }
    const originalPaper = structuredClone(sample.paper);
    const record = { contract: policy.CONTRACT, model: policy.MODEL, runId: 'local-reviewed-run',
        sourceRunId: sample.plan.runId, promptBindings: {}, originalPaperSha256: facts.sha(JSON.stringify(originalPaper)),
        inheritedFeedbacks: [{ feedback: parent, proof: parentBound.proof }], currentFeedbackProof: parentBound.proof };
    sample.paper.fullStageReanalysis = record;
    sample.paper.fullStageReanalysisHistory = [{ ...structuredClone(record), originalPaper }];
    facts.withFactReview(childBound, () => undefined);
    const before = structuredClone(sample.paper);
    let readerCalls = 0;
    let requestBoundaries = 0;
    let renderedFixedChars = 0;
    const actualRefresh = deep.refreshApiReaderArticleFromSource;
    const stop = Object.assign(new Error('测试在真实Reader请求边界停止'), {
        code: 'LLM_ACCOUNT_AUTH_ERROR', retryable: false, scope: 'run'
    });
    t.after(() => { publicReaderRequestObserver = null; });
    t.mock.method(global, 'fetch', async () => assert.fail('新增public refresh测试禁止真实网络'));
    t.mock.method(require('node:http'), 'request', () => assert.fail('新增public refresh测试禁止HTTP/CONNECT'));
    t.mock.method(require('node:https'), 'request', () => assert.fail('新增public refresh测试禁止HTTPS'));
    publicReaderRequestObserver = async (_url, _endpoint, _model, body, _headers, options) => {
        requestBoundaries++;
        assert.equal(options.usageContext.stage, 'apiReaderArticle');
        const prompt = body.input[0].content.find(part => part.type === 'input_text').text;
        assert.ok(prompt.length < 240000);
        assert.ok(prompt.includes(parent.readerFeedback));
        assert.ok(prompt.includes(child.readerFeedback));
        throw stop;
    };
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async (paper, source, options) => {
        readerCalls++;
        renderedFixedChars = options.reviewFeedback.length - parent.primaryFeedback.length - parent.readerFeedback.length - child.readerFeedback.length;
        const scope = facts.current(sample.id);
        const fields = facts.fingerprintFields('apiReaderArticle');
        assert.deepEqual(fields.restoredReaderConstraints.parentProof, parentBound.proof);
        assert.deepEqual(fields.restoredReaderConstraints.childProof, childBound.proof);
        assert.equal(fields.restoredReaderConstraints.renderedSha256, facts.sha(options.reviewFeedback));
        for (const packet of [parent, child]) {
            assert.ok(options.reviewFeedback.includes(packet.readerFeedback));
            for (const quote of packet.sourceQuotes) assert.ok(options.reviewFeedback.includes(quote));
            for (const claim of packet.rejectedReaderClaims) assert.ok(facts.readerRejectedClaims(sample.id).includes(claim));
        }
        assert.equal(scope.readerOnly, true);
        assert.ok(options.reviewFeedback.length > 4000 && options.reviewFeedback.length <= 8000);
        assert.equal(facts.validateReaderReviewFeedbackLength(options.reviewFeedback, sample.id), 8000);
        assert.throws(() => facts.validateReaderReviewFeedbackLength(options.reviewFeedback + '额外字符', sample.id), /4000/);
        assert.throws(() => facts.validateReaderReviewFeedbackLength('字'.repeat(8001), sample.id), /4000/);
        assert.throws(() => facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'));
        deep.prepareApiReaderRevisionSeed(paper, source.text, options.reviewFeedback);
        await assert.rejects(actualRefresh(paper, source, options), error => error.code === stop.code);
        return paper;
    });
    const run = feedback => daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(sample.paper, () => saved.analyzeWithRecoveredFeedback(
            sample.paper, sample.plan, () => assert.fail('不应进入主分析'), feedback)));
    assert.throws(() => facts.validateReaderReviewFeedbackLength('字'.repeat(4001), sample.id), /4000/);
    await run(null);
    assert.equal(readerCalls, 1);
    assert.equal(requestBoundaries, 1);
    assert.deepEqual(sample.paper, before);
    await assert.rejects(run({ ...child, readerFeedback: '新反馈没有继承原Reader限制。' }), /遗漏旧Reader事实约束/);
    assert.equal(readerCalls, 1);
    assert.deepEqual(sample.paper, before);
    const longPaper = structuredClone(originalPaper);
    const longParent = { ...parent, readerFeedback: '父'.repeat(2500),
        primaryFeedback: '主'.repeat(8001 - renderedFixedChars - 5000) };
    const longChild = { ...child, readerFeedback: '子'.repeat(2500) };
    const longParentBound = facts.validateFeedback(longParent, sample.plan, longPaper);
    const longChildBound = facts.validateFeedback(longChild, sample.plan, longPaper);
    for (const [stage, value] of Object.entries(longPaper.analysisManifest.stages)) {
        value.factReview = stage === 'apiReaderArticle' ? longChildBound.proof : longParentBound.proof;
    }
    const longOriginal = structuredClone(longPaper);
    const longRecord = { ...structuredClone(record), originalPaperSha256: facts.sha(JSON.stringify(longOriginal)),
        inheritedFeedbacks: [{ feedback: longParent, proof: longParentBound.proof }], currentFeedbackProof: longParentBound.proof };
    longPaper.fullStageReanalysis = longRecord;
    longPaper.fullStageReanalysisHistory = [{ ...structuredClone(longRecord), originalPaper: longOriginal }];
    facts.withFactReview(longChildBound, () => undefined);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(longPaper, () => saved.analyzeWithRecoveredFeedback(
            longPaper, sample.plan, () => assert.fail('不应进入主分析')))), /超过8000字符（实际8001字符）/);
    assert.equal(requestBoundaries, 1);
});

for (const parentStage of ['primaryAnalysis', 'coreSummaryRepair']) {
    test(`无全阶段档案的旧Reader子从真实${parentStage}父恢复且明确记录父类型`, async t => {
        const sample = await createReviewedReaderSample(t);
        const parent = { ...sample.feedback, primaryFeedback: '', readerFeedback: '', coreFeedback: '',
            rejectedPrimaryClaims: [], rejectedReaderClaims: [], rejectedCoreClaims: [] };
        if (parentStage === 'primaryAnalysis') {
            parent.primaryFeedback = '保留旧主文事实条件。';
            parent.rejectedPrimaryClaims = ['旧主文错误已改正'];
            parent.readerFeedback = '保留旧Reader的适用条件。';
            parent.rejectedReaderClaims = ['旧Reader错误已改正'];
        } else {
            parent.coreFeedback = '保留旧核心摘要的适用条件。';
            parent.rejectedCoreClaims = ['旧核心摘要错误已改正'];
        }
        const child = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: '原Reader子包补充解释另一处细节。' };
        for (const value of Object.values(sample.paper.analysisManifest.stages)) {
            delete value.factReview;
            delete value.scoringFactReview;
        }
        const parentBound = facts.validateFeedback(parent, sample.plan, sample.paper);
        const childBound = facts.validateFeedback(child, sample.plan, sample.paper);
        sample.paper.analysisManifest.stages[parentStage].factReview = parentBound.proof;
        sample.paper.analysisManifest.stages.apiReaderArticle.factReview = childBound.proof;
        facts.withFactReview(parentBound, () => undefined);
        facts.withFactReview(childBound, () => undefined);
        const before = structuredClone(sample.paper);
        let boundaries = 0;
        t.mock.method(deep, 'refreshApiReaderArticleFromSource', async (paper, source, options) => {
            boundaries++;
            const fields = facts.fingerprintFields('apiReaderArticle');
            assert.equal(fields.restoredReaderConstraints.parentStage, parentStage);
            assert.deepEqual(fields.restoredReaderConstraints.parentProof, parentBound.proof);
            assert.deepEqual(fields.restoredReaderConstraints.childProof, childBound.proof);
            assert.ok(options.reviewFeedback.includes(parentStage === 'primaryAnalysis' ? parent.readerFeedback : parent.coreFeedback));
            deep.prepareApiReaderRevisionSeed(paper, source.text, options.reviewFeedback);
            return paper;
        });
        await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
            saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan, () => assert.fail('不得重写主文'))));
        assert.equal(boundaries, 1);
        assert.deepEqual(sample.paper, before);
        if (parentStage === 'coreSummaryRepair') {
            const wrongRole = structuredClone(sample.paper);
            wrongRole.analysisManifest.stages.primaryAnalysis.factReview = parentBound.proof;
            await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
                engine.withPaperAnalysisLock(wrongRole, () => saved.analyzeWithRecoveredFeedback(
                    wrongRole, sample.plan, () => assert.fail('不能把摘要包当主文父反馈')))), /缺少之前的纠错说明/);
            assert.equal(boundaries, 1);
        }
    });
}

test('正常旧完整上游缺primaryCP走受保护公共Reader刷新，保原父范围与费用', async t => {
 const sample=await createReviewedReaderSample(t);
 const feedback={...sample.feedback,primaryFeedback:'沿用已纠正的原主文事实，不扩大修改。',readerFeedback:'保留原Reader事实纠错。'};
 const bound=facts.validateFeedback(feedback,sample.plan,sample.paper);
 facts.withFactReview(bound,()=>undefined);
 sample.paper.analysisManifest.stages.primaryAnalysis.factReview=bound.proof;
 sample.paper.analysisManifest.stages.scoringAudit.factReview=bound.proof;
 sample.paper.analysisManifest.stages.apiReaderArticle.factReview=bound.proof;
 sample.paper.apiReaderArticleSha256='0'.repeat(64);
 sample.paper.latestAnalysisAttemptError='旧Reader真实失败';
 delete sample.paper.analysisStageCheckpoints.primaryAnalysis;
 sample.paper.paidResponseHistory=[{stage:'primaryAnalysis',totalTokens:41}];
 const original=structuredClone(sample.paper);let normal=0,refresh=0;
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{refresh++;assert.equal(facts.current().proof.feedbackSha256,bound.proof.feedbackSha256);return p;});
 assert.equal(saved.completedReaderUpstream(sample.paper,sample.plan),true);
 const result=await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(sample.paper,()=>saved.analyzeWithRecoveredFeedback(sample.paper,sample.plan,()=>{normal++;throw Error('不应付费主分析');})));
 assert.equal(normal,0);assert.equal(refresh,1);assert.equal(result.analysis,original.analysis);assert.deepEqual(result.paidResponseHistory,original.paidResponseHistory);
 for(const stage of ['primaryAnalysis','coreSummaryRepair','scoringAudit'])assert.deepEqual(result.analysisManifest.stages[stage],original.analysisManifest.stages[stage]);
});

test('共享上游门拒坏source/core/scoring，Reader返回不得改变主阶段或费用', async t => {
 const sample=await createReviewedReaderSample(t);
 delete sample.paper.analysisManifest.stages.apiReaderArticle.factReview;
 sample.paper.apiReaderArticleSha256='0'.repeat(64);
 delete sample.paper.analysisStageCheckpoints.primaryAnalysis;
 sample.paper.analysisManifest.stages.imageDownload.status='pending';
 let requests=0;
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{requests++;p.paidResponseHistory=[{forged:true}];return p;});
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(sample.paper,async()=>{
  const gate=require('../scripts/lib/completed-reader-upstream').completedReaderUpstream;
  const source=daily.readDailyFreshSource(sample.plan,sample.paper);
  assert.equal(gate(sample.paper,source),true);
  assert.equal(gate(sample.paper,{...source,text:source.text+'坏源'}),false);
  for(const alter of [p=>{p.analysisManifest.stages.coreSummaryRepair.summarySha256='0'.repeat(64);},p=>{p.analysisManifest.stages.scoringAudit.outputAnalysisSha256='0'.repeat(64);}]){const p=structuredClone(sample.paper);alter(p);assert.equal(gate(p,source),false);}
  await assert.rejects(saved.analyzeWithRecoveredFeedback(sample.paper,sample.plan,()=>{throw Error('不得进主阶段');}),e=>e.code==='READER_RETURN_PROTECTION_REJECTED');
 }));
 assert.equal(requests,1);
});

test('generic正常Reader公共实际请求边界仅Reader，无primary/core/scoring请求', async t => {
 const sample=await createReviewedReaderSample(t);
 delete sample.paper.analysisManifest.stages.apiReaderArticle.factReview;
 delete sample.paper.analysisStageCheckpoints.primaryAnalysis;
 sample.paper.apiReaderArticleSha256='0'.repeat(64);
 const calls=[];
 t.mock.method(require('../scripts/utils'),'requestLlmJson',async (_u,_e,_m,_b,_h,o)=>{
  calls.push(o.usageContext.stage);assert.equal(o.usageContext.stage,'apiReaderArticle');
  throw Object.assign(new Error('测试在真实Reader模型边界停止'),{code:'LLM_ACCOUNT_AUTH_ERROR',retryable:false,scope:'run'});
 });
 const file=require.resolve('../scripts/deep-analyzer'),prior=require.cache[file];delete require.cache[file];require(file);t.after(()=>{require.cache[file]=prior;});
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(sample.paper,()=>saved.analyzeWithRecoveredFeedback(sample.paper,sample.plan,()=>assert.fail('不得请求正常主阶段')))),/真实Reader模型边界停止/);
 assert.deepEqual(calls,['apiReaderArticle']);
});

test('已审主文Reader种子共享源核验异常保持布尔false，不扩大请求',async t=>{
 const sample=await createReviewedReaderSample(t);
 const feedback={...sample.feedback,primaryFeedback:'沿用已纠正的原主文。'};
 const bound=facts.validateFeedback(feedback,sample.plan,sample.paper);
 sample.paper.analysisManifest.stages.primaryAnalysis.factReview=bound.proof;
 sample.paper.latestAnalysisAttemptError='局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';
 let sourceChecks=0;
 t.mock.method(require('../scripts/lib/completed-reader-upstream'),'completedReaderUpstream',()=>{sourceChecks++;throw Error('测试封存源损坏');});
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(sample.paper,()=>facts.withFactReview(bound,()=>{
  assert.equal(require('../scripts/deep-analyzer').hasReviewedCompletedPrimaryReaderSeed(sample.paper,sample.source.text,feedback.readerFeedback),false);
 })));
 assert.equal(sourceChecks,1);
});

test('正常失败合并保新paidReader同代bundle，坏Reader保旧bundle并封存真实失败包',async t=>{
 const sample=await createReviewedReaderSample(t);
 const existing=structuredClone(sample.paper);delete existing.analysisManifest.stages.apiReaderArticle.factReview;
 existing.paidResponseHistory=[{id:'earlier-other-checkpoint-paid',tokens:31}];
 const incoming=structuredClone(existing);incoming.analysis=null;incoming.analysisCheckpoint=existing.analysis;
 incoming.analysisManifest.stages.scoringAudit.status='contract_rejected';
 incoming.error='深度分析阶段未完成: scoringAudit:contract_rejected';
 incoming.apiReaderArticle+='\n\n真实付费 Reader 的补充解释。';
 incoming.apiReaderArticleSha256=facts.sha(incoming.apiReaderArticle);
 incoming.analysisManifest.stages.apiReaderArticle.articleSha256=incoming.apiReaderArticleSha256;
 incoming.paidResponseHistory=[{id:'new-reader-paid',tokens:77}];
 // 此测试真实补充段落会被正文绑定契约核验；不伪签 table/formula/figures 证明。
 assert.equal(engine.hasValidApiReaderV3Records(incoming),true);
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(incoming,()=>{
  const [merged]=engine.mergePapersById([existing],[incoming],{preserveSuccessfulAnalysis:true});
  assert.equal(merged.analysis,existing.analysis);assert.equal(merged.analysisCheckpoint,incoming.analysisCheckpoint);
  assert.equal(merged.apiReaderArticle,incoming.apiReaderArticle);assert.equal(merged.analysisManifest.stages.apiReaderArticle.articleSha256,incoming.apiReaderArticleSha256);
  assert.deepEqual(merged.paidResponseHistory,[...existing.paidResponseHistory,...incoming.paidResponseHistory]);assert.equal(engine.isSuccessfulAnalysisRecord(merged),false);
  const bad=structuredClone(incoming);bad.apiReaderArticleSha256='0'.repeat(64);
  const [failed]=engine.mergePapersById([existing],[bad],{preserveSuccessfulAnalysis:true});
  assert.equal(failed.apiReaderArticle,existing.apiReaderArticle);assert.deepEqual(failed.analysisManifest.stages.apiReaderArticle,existing.analysisManifest.stages.apiReaderArticle);
  assert.equal(failed.apiReaderFailedBundleHistory.at(-1).fields.apiReaderArticle,incoming.apiReaderArticle);
  assert.equal(failed.apiReaderFailedBundleHistory.at(-1).stages.apiReaderArticle.articleSha256,incoming.apiReaderArticleSha256);
  assert.equal(engine.isSuccessfulAnalysisRecord(failed),false);
  const wrongSource=structuredClone(incoming);wrongSource.freshRewriteProvenance.sourceManifestSha256='0'.repeat(64);
  const [sourceRejected]=engine.mergePapersById([existing],[wrongSource],{preserveSuccessfulAnalysis:true});
  assert.equal(sourceRejected.apiReaderArticle,existing.apiReaderArticle);
  assert.deepEqual(sourceRejected.analysisManifest.stages.apiReaderArticle,existing.analysisManifest.stages.apiReaderArticle);
  assert.equal(sourceRejected.apiReaderFailedBundleHistory.length,1);
 }));
});

test('原父子Reader恢复先真实父范围补上游，再子范围Reader及正常收尾',async t=>{
 const sample=await createReviewedReaderSample(t),paper=sample.paper;
 const parentFeedback={...sample.feedback,primaryFeedback:'沿用已纠正的父范围主文。',readerFeedback:'',rejectedReaderClaims:[]};
 const parent=facts.validateFeedback(parentFeedback,sample.plan,paper);facts.withFactReview(parent,()=>undefined);
 paper.analysisManifest.stages.primaryAnalysis.factReview=parent.proof;paper.analysisManifest.stages.scoringAudit.factReview=parent.proof;
 const childFeedback={...sample.feedback,rejectedPrimaryClaims:[]};
 const child=facts.validateFeedback(childFeedback,sample.plan,paper);facts.withFactReview(child,()=>undefined);paper.analysisManifest.stages.apiReaderArticle.factReview=child.proof;
 const actualComplete=structuredClone(paper);
 paper.analysisManifest.stages.coreSummaryRepair.summarySha256='0'.repeat(64);
 paper.analysisManifest.stages.imageDownload.status='pending';
 paper.apiReaderArticleSha256='0'.repeat(64);
 paper.latestAnalysisAttemptError='独立Reader纠错缺少已完成的主文、摘要或评分';
 let parentCalls=0,readerCalls=0,normalFinal=0;
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{
  readerCalls++;assert.equal(facts.current().readerOnly,true);assert.equal(facts.current().readerBound.proof.feedbackSha256,child.proof.feedbackSha256);
  p.apiReaderArticleSha256=actualComplete.apiReaderArticleSha256;return p;
 });
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,async()=>{
  const result=await saved.analyzeWithRecoveredFeedback(paper,sample.plan,async options=>{
   assert.equal(options.requireCompletedPrimaryCheckpoint,true);
   if(options.resumeSavedReaderUpstreamOnly){parentCalls++;assert.equal(facts.current().readerOnly,undefined);assert.equal(facts.current().proof.feedbackSha256,parent.proof.feedbackSha256);
    return {...paper,analysisManifest:{...paper.analysisManifest,stages:{...paper.analysisManifest.stages,coreSummaryRepair:structuredClone(actualComplete.analysisManifest.stages.coreSummaryRepair)}}};}
   normalFinal++;assert.equal(facts.current().readerOnly,true);assert.throws(()=>facts.assertScoringOnlyModelStageAllowed('scoringAudit'));return paper;
  });
  assert.equal(result.analysis,actualComplete.analysis);
 }));
 assert.equal(parentCalls,1);assert.equal(readerCalls,1);assert.equal(normalFinal,1);
});

test('祖先包不倒灌无旧proof上游，旧Reader子保祖先约束；未补好评分不得进Reader',async t=>{
 for(const fixScore of [true,false]){
  const sample=await createReviewedReaderSample(t),paper=sample.paper;
  const parentFeedback={...sample.feedback,primaryFeedback:'原祖先反馈，已经纠正。',readerFeedback:'原祖先Reader解释约束。'};
  const parent=facts.validateFeedback(parentFeedback,sample.plan,paper);
  const childFeedback={...sample.feedback,rejectedPrimaryClaims:[]};
  const child=facts.validateFeedback(childFeedback,sample.plan,paper);facts.withFactReview(child,()=>undefined);
  paper.analysisManifest.stages.apiReaderArticle.factReview=child.proof;
  const originalPaper=structuredClone(paper),policy=require('../scripts/lib/selected-full-stage-reanalysis');
  const record={contract:policy.CONTRACT,model:policy.MODEL,runId:'old-paid-parent-run',sourceRunId:sample.plan.runId,promptBindings:{},originalPaperSha256:facts.sha(JSON.stringify(originalPaper)),inheritedFeedbacks:[{feedback:parentFeedback,proof:parent.proof}],currentFeedbackProof:parent.proof};
  paper.fullStageReanalysis=record;paper.fullStageReanalysisHistory=[{...structuredClone(record),originalPaper}];
  const oldScore=structuredClone(paper.analysisManifest.stages.scoringAudit);
  paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256='0'.repeat(64);paper.apiReaderArticleSha256='0'.repeat(64);
  let readers=0,upstream=0,finals=0;
  const refresh=t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{readers++;assert.equal(facts.current().readerOnly,true);assert.equal(facts.fingerprintFields('primaryAnalysis',p.analysisManifest.stages.primaryAnalysis).factReview,undefined);assert.deepEqual(facts.current().restoredReaderConstraints.parentProof,parent.proof);p.apiReaderArticleSha256=originalPaper.apiReaderArticleSha256;return p;});
  const run=()=>daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>saved.analyzeWithRecoveredFeedback(paper,sample.plan,async options=>{
   if(options.resumeSavedReaderUpstreamOnly){upstream++;assert.equal(facts.current(),null);if(fixScore)paper.analysisManifest.stages.scoringAudit=oldScore;return paper;}
   finals++;assert.equal(facts.current().readerOnly,true);assert.throws(()=>facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'));return paper;
  })));
  if(fixScore){await run();assert.equal(readers,1);assert.equal(finals,1);}else{await assert.rejects(run(),e=>e.code==='READER_UPSTREAM_INCOMPLETE');assert.equal(readers,0);assert.equal(finals,0);}
  assert.equal(upstream,1);refresh.mock.restore();
 }
});

test('已有完整PDF Reader锁内先公开原记录重放，坏身份原错误阻断；草稿不提前重放',async t=>{
 const sample=await createReviewedReaderSample(t),paper=sample.paper;
 facts.withFactReview(facts.validateFeedback(sample.feedback,sample.plan,paper),()=>undefined);
 paper.apiReaderPlan.tableBindings[0].pdfCellConfirmation={explicitTestMarker:true};
 const stop=Object.assign(Error('PDF原完整身份或来源不一致'),{code:'TEST_PDF_IDENTITY_REJECTED'});
 let replayCalls=0,normalCalls=0;
 t.mock.method(require('../scripts/lib/reader-pdf-cell-evidence'),'replaySavedProofMetadata',p=>{replayCalls++;assert.equal(engine.paperAnalysisLockHeld(p),true);throw stop;});
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>saved.analyzeWithRecoveredFeedback(paper,sample.plan,()=>{normalCalls++;return paper;}))),e=>e===stop);
 assert.equal(replayCalls,1);assert.equal(normalCalls,0);
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{normalCalls++;return p;});
 paper.analysisManifest.stages.apiReaderArticle.status='invalid_output';
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>saved.analyzeWithRecoveredFeedback(paper,sample.plan,()=>{normalCalls++;return paper;})));
 assert.equal(replayCalls,1);assert.equal(normalCalls,1);
});

test('正常batch锁内保存已成PDF元数据，真实评分未成仅存proof并保原失败费用',async t=>{
 for(const incomplete of [false,true]){
  const sample=await createReviewedReaderSample(t),p=sample.paper;
  p.apiReaderPlan.tableBindings[0].pdfCellConfirmation={explicitTestRecord:true,ruleSha256:'0'.repeat(64)};
  p.paidResponseHistory=[{id:'original-paid-reader',tokens:74}];
  if(incomplete){p.analysisManifest.stages.scoringAudit.status='contract_rejected';p.latestAnalysisAttemptError='真实评分尚未完成';}
  const file=path.join(sample.plan.runDir,'reconcile-'+incomplete+'.json');
  const payload={batchDate:sample.plan.batchDate,batchId:sample.plan.batchId,dailyFreshSourceRun:daily.dailyFreshSourceReference(sample.plan),papers:[p]};
  fs.writeFileSync(file,JSON.stringify(payload));let calls=0;
  const replay=t.mock.method(require('../scripts/lib/reader-pdf-cell-evidence'),'replaySavedProofMetadata',paper=>{
   calls++;assert.equal(engine.paperAnalysisLockHeld(paper),true);
   // 此处验证锁内保存流程，PDF 逐格重放另有真实来源验证。
   delete paper.apiReaderPlan.tableBindings[0].pdfCellConfirmation;
   paper.analysisManifest.stages.apiReaderArticle.pdfProofMetadataReplayTest='current';return true;
  });
  await require('../scripts/batch-analyze').reconcileCompletedFailureMarkers(file,daily.requireDailyFreshSourceRecoveryPlan(payload));
  const stored=JSON.parse(fs.readFileSync(file)).papers[0];
  assert.equal(calls,1);assert.equal(stored.analysisManifest.stages.apiReaderArticle.pdfProofMetadataReplayTest,'current');
  assert.equal(stored.analysis,p.analysis);assert.equal(stored.apiReaderArticle,p.apiReaderArticle);assert.deepEqual(stored.paidResponseHistory,p.paidResponseHistory);
  if(incomplete)assert.equal(stored.latestAnalysisAttemptError,p.latestAnalysisAttemptError);else assert.equal(stored.latestAnalysisAttemptError,undefined);
  replay.mock.restore();
 }
});

test('正常batch PDF source坏或public重放原错时锁内不写故障目标',async t=>{
 for(const mode of ['source','proof']){
  const sample=await createReviewedReaderSample(t),p=sample.paper;
  p.apiReaderPlan.tableBindings[0].pdfCellConfirmation={explicitTestRecord:true};
  if(mode==='source')p.freshRewriteProvenance.sourceManifestSha256='0'.repeat(64);
  const file=path.join(sample.plan.runDir,'reconcile-bad-'+mode+'.json');
  const payload={batchDate:sample.plan.batchDate,batchId:sample.plan.batchId,dailyFreshSourceRun:daily.dailyFreshSourceReference(sample.plan),papers:[p]};
  fs.writeFileSync(file,JSON.stringify(payload));const bytes=fs.readFileSync(file);const entryPlan=daily.requireDailyFreshSourceRecoveryPlan(payload);
  const stop=Error('PDF原字形或来源已变化，不能重签');let calls=0;
  const replay=t.mock.method(require('../scripts/lib/reader-pdf-cell-evidence'),'replaySavedProofMetadata',paper=>{calls++;assert.equal(engine.paperAnalysisLockHeld(paper),true);throw stop;});
  await assert.rejects(require('../scripts/batch-analyze').reconcileCompletedFailureMarkers(file,entryPlan),mode==='proof'?e=>e===stop:/来源/);
  assert.equal(fs.readFileSync(file).equals(bytes),true);assert.equal(calls,mode==='proof'?1:0);replay.mock.restore();
 }
});
