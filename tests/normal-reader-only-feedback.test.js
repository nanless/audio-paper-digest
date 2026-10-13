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
            assert.ok(['apiReaderArticle', 'apiReaderTableAudit'].includes(requestOptions.usageContext.stage),
                '文章纠错和审校不能请求主分析、摘要或评分');
            const prompt = _body.input[0].content.find(part => part.type === 'input_text').text;
            let text;
            if (requestOptions.usageContext.stage === 'apiReaderArticle') {
                assert.equal(prompt.includes('structuredSourcePayload'), false);
                assert.ok(prompt.includes('\"version\":3'));
                text = JSON.stringify(signed.draft);
            } else {
                const marker = '待审输入：';
                assert.ok(prompt.includes(marker));
                const input = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim());
                assert.equal(input.inputSha256, requestOptions.usageContext.unitId);
                text = JSON.stringify({ version: 1, inputSha256: input.inputSha256,
                    tables: input.tables.map(table => ({ tableIndex: table.tableIndex, issues: [] })) });
            }
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
        assert.deepEqual(stages, ['apiReaderArticle', 'apiReaderTableAudit']);
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

test('正常Reader纠错收到无效审校响应仍保存原始记录，重启不重复请求', async t => {
    const sample = await createReviewedReaderSample(t);
    const parent = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(parent, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    facts.withFactReview(bound, () => undefined);
    const child = { ...parent, readerFeedback: parent.readerFeedback + ' 纠正当前文章的具体表述。' };
    const before = structuredClone(sample.paper.analysisManifest.stages);
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const checkpointFile = path.join(sample.plan.runDir, 'failed-audit-checkpoint.json');
    let auditRequests = 0;
    t.mock.method(require('../scripts/utils'), 'requestLlmJson', async (_url, _endpoint, model, body, _headers, options) => {
        assert.ok(['apiReaderArticle', 'apiReaderTableAudit'].includes(options.usageContext.stage));
        const text = options.usageContext.stage === 'apiReaderTableAudit'
            ? (auditRequests++, '{"version":') : JSON.stringify(signed.draft);
        const response = { statusCode: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text }] }] } };
        if (options.usageSink) options.usageSink(require('../scripts/lib/llm-usage').buildLlmUsageEvent({
            protocol: 'openai_responses', model, request: body, response: response.body,
            statusCode: 200, durationMs: 1, context: options.usageContext, outputText: text
        }));
        return response;
    });
    const file = require.resolve('../scripts/deep-analyzer');
    const prior = require.cache[file]; delete require.cache[file]; require(file);
    t.after(() => { require.cache[file] = prior; });
    const invoke = paper => daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(paper, () => engine.analyzePaperWithRetry(paper, {
            maxRetries: 0,
            analyzeFn: current => saved.analyzeWithRecoveredFeedback(current, sample.plan,
                () => assert.fail('不能重新调用主分析'), child),
            onCheckpoint: current => fs.writeFileSync(checkpointFile, JSON.stringify(current))
        })));
    const first = await invoke(sample.paper);
    assert.equal(first.success, false);
    assert.match(first.error, /表格审校响应不是完整JSON/);
    const stored = JSON.parse(fs.readFileSync(checkpointFile));
    const record = stored.analysisManifest.stages.apiReaderTableAudit.records[0];
    assert.equal(record.rawResponse, '{"version":');
    assert.equal(record.responseSha256, facts.sha(record.rawResponse));
    assert.equal(record.requestReceipts[0].outcome, 'completed');
    for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit']) {
        assert.deepEqual(stored.analysisManifest.stages[stage], before[stage]);
    }
    assert.equal(stored.analysisCheckpoint, undefined);
    assert.equal(auditRequests, 1);
    const second = await invoke(stored);
    assert.equal(second.success, false);
    assert.match(second.error, /表格审校响应不是完整JSON/);
    assert.equal(auditRequests, 1, '已保存的同一付费响应不能因失败重启再次请求');
});
