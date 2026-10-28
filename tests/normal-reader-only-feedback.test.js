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

async function createReviewedReaderSample(t, options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reviewed-reader-seed-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: options.sourceText
        || 'The source reports a controlled measurement of 1.0 under the same protocol.\n' + 'Additional method evidence describes experimental conditions and evaluation protocols. '.repeat(100) });
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
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () =>
        require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper, source)));
    return { paper, plan, source, feedback, bound, id };
}

const saved = require('../scripts/lib/saved-fact-feedback');

test('无主文父包的核心纠错正常保存后跨作用域重放、完成判定与普通续跑闭环', async t => {
    // This fixture has no figures. Its normal discovery fallback must be an
    // explicit offline miss, rather than depend on arXiv/proxy availability.
    t.mock.method(global, 'fetch', async url => {
        assert.match(String(url), /^https:\/\/arxiv\.org\/html\/2609\.12345(?:v[12])?$/);
        return { ok: false, status: 404, text: async () => '' };
    });
    const sample = await createReviewedReaderSample(t, { sourceText:
        'Table 1 reports word error rate (WER) of 9.8% for our method versus 12.4% for the baseline and 10.8% without the context module under the same public test protocol.\n'
        // The synthetic signed Reader fixture contains a separate 1.0 scalar
        // protocol table; give it an actual quote rather than borrowing a digit.
        + 'A controlled protocol configuration reports the scalar reference value 1.0.\n'
        + 'The source reports server inference measurements; edge latency is not evaluated.\n'
        + 'Additional method evidence describes experimental conditions and evaluation protocols. '.repeat(100) });
    const paper = sample.paper;
    paper.title = '单节恢复测试论文';
    const method = [
        '输入波形先按统一采样条件转换为时频特征，编码器沿时间轴提取局部声学表示并保持每个帧位置与原始音频相对应，避免后续模块把不同时间的观测错误拼接。',
        '上下文模块以这些编码表示为输入，融合相邻帧与较远片段之间的关联，并将局部信息和全局条件送给同一解码器，输出按顺序排列的文字预测，训练损失负责约束每个输出位置。',
        '训练阶段先固定数据划分和噪声条件，再联合优化编码器与上下文参数，评测阶段保持输入接口和解码顺序一致，通过完整系统与移除组件的对照区分模块贡献和额外计算代价。'
    ].map(paragraph => paragraph.repeat(4)).join('\n\n');
    paper.analysis = deep.mergeSectionByTitle(paper.analysis, '方法概述和架构', method);
    paper.analysis = deep.mergeSectionByTitle(paper.analysis, '实验结果',
        '下表比较同一公开语音测试协议下完整方法、基线与移除上下文组件的设置，词错误率越低越好，用来检验模块是否带来净收益。\n\n'
        + '| 方法 | WER ↓ |\n| --- | ---: |\n| 基线 | 12.4% |\n| 完整方法 | 9.8% |\n| 移除上下文 | 10.8% |\n\n'
        + '完整方法相较基线降低词错误率，而移除上下文组件后收益变小，这只说明当前公开数据与噪声条件下的组件贡献，尚不能推断跨语言或端侧部署效果。');
    paper.parsed = requestApi.parseAnalysis(paper.analysis);
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(paper.analysis);
    const currentFixture = validAnalysisPaper(paper.arxivId, {}, paper.analysis);
    for (const name of ['structureRepair', 'taxonomySeal', 'coreSummaryRepair'])
        paper.analysisManifest.stages[name] = currentFixture.analysisManifest.stages[name];
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256'])
        paper.analysisManifest.stages.scoringAudit[field] = currentFixture.analysisManifest.stages.scoringAudit[field];
    delete paper.analysisManifest.stages.apiReaderArticle.factReview;
    paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = null;
    Object.assign(paper.analysisManifest.sourceAcquisition, {
        analysisSource: 'html', sourceId: sample.source.sourceId,
        usedTextSha256: facts.sha(deep.buildTaskEvidenceContext(sample.source.text,
            Config.ANALYSIS_CONFIG.fullTextMaxChars, undefined, 'PRIMARY'))
    });
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(paper, () =>
        require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper, sample.source)));
    // 正常成功稿已清理主文和中间检查点，只留下最终标签重放所需的两份正文。
    delete paper.analysisCheckpoint;
    paper.analysisStageCheckpoints = Object.fromEntries(Object.entries(paper.analysisStageCheckpoints)
        .filter(([name]) => ['structureRepair', 'tagSelection', 'taxonomySeal'].includes(name)));
    paper.paidResponseHistory = [{ responseId: 'original-paid-core-parent', totalTokens: 42 }];
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(paper, () => {
        const contract = require('../scripts/analysis-contract');
        assert.equal(contract.validateTagStageProof(paper, { parsed: requestApi.parseAnalysis(paper.analysis) }), null);
        assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
        assert.equal(engine.scoringAuditBindsFinalAnalysis(paper), true);
        assert.equal(engine.scoringStabilityIsResolved(paper.analysisManifest.stages.scoringAudit), true);
        assert.equal(require('../scripts/lib/completed-reader-upstream').completedReaderUpstream(paper, sample.source), true);
    }));
    const original = structuredClone(paper);
    const oldSummary = deep.extractSectionByTitle(paper.analysis, '核心摘要');
    const rejected = '论文也未报告端侧推理延迟';
    assert.ok(oldSummary.includes(rejected));
    const fixedSummary = oldSummary.replace(rejected, '论文报告了服务端推理延迟，但端侧条件尚待验证');
    const feedback = { ...sample.feedback, coreAnalysisSha256: facts.sha(paper.analysis),
        coreSummarySha256: facts.sha(oldSummary), primaryFeedback: '', rejectedPrimaryClaims: [],
        readerFeedback: '', rejectedReaderClaims: [], coreFeedback: '只纠正摘要中的端侧成本缺失概括，保留摘要外十二节；随后正常复核评分。',
        rejectedCoreClaims: [rejected] };
    const file = path.join(sample.plan.runDir, 'standalone-core.json');
    fs.writeFileSync(file, JSON.stringify(feedback));
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(paper, () => {
        const core = facts.validateFeedback(feedback, sample.plan, paper);
        return facts.withCoreSummaryFactReview(core, paper, () => facts.withOriginalCoreContext(paper, () => {
            assert.equal(facts.current(), null);
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit', 'apiReaderArticle'])
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed(stage), /只读核心/);
        }));
    }));
    const keys = ['deepAnalysisResult', 'filteredPapers', 'papers', 'papersLegacy', 'llmUsageDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    t.after(() => Object.assign(Config.FILES, previous));
    for (const key of keys) Config.FILES[key] = path.join(sample.plan.runDir, 'standalone-' + key + '.json');
    const originalFile = path.join(sample.plan.runDir, 'completed-core-before.json');
    fs.writeFileSync(originalFile, JSON.stringify(original), { mode: 0o600 });
    const damaged = structuredClone(paper);
    const scopeError = '事实反馈绑定检查未通过：独立核心纠错范围不能调用主分析或其他主文重写模型';
    damaged.analysisManifest.stages = { primaryAnalysis: { status: 'transient_failure', error: scopeError } };
    damaged.analysisManifest.contracts = {};
    damaged.analysisStageCheckpoints = {};
    damaged.analysisCheckpoint = '';
    damaged.latestAnalysisAttemptErrorCode = 'DAILY_FACT_REVIEW_INTEGRITY';
    damaged.latestAnalysisAttemptError = scopeError;
    damaged.analysisFactReviewObligation = facts.proofFor(feedback);
    const partialPayload = { analysisCheckpoint: original.analysis, analysisStageCheckpoints: {}, stages: {}, contracts: {} };
    damaged.analysisStaleSnapshots = [{ contract: 'stale-analysis-snapshot-v1', invalidatedStage: 'coreSummaryRepair',
        replacementFingerprint: facts.proofFor(feedback).feedbackSha256,
        payload: partialPayload, payloadSha256: deep.stableFingerprint(partialPayload) }];
    const recovery = { originalFile, originalFileSha256: facts.sha(fs.readFileSync(originalFile)),
        paperSha256: deep.stableFingerprint(damaged) };
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(damaged, () => {
        assert.throws(() => deep.restoreCompletedCoreInput(damaged, sample.plan, feedback,
            { ...recovery, paperSha256: '0'.repeat(64) }), /核心原输入恢复/);
        assert.throws(() => deep.restoreCompletedCoreInput(damaged, sample.plan, feedback,
            { ...recovery, originalFileSha256: '0'.repeat(64) }), /核心原输入恢复/);
        const changed = structuredClone(damaged); changed.analysis += '\n未经授权改写主文';
        assert.throws(() => deep.restoreCompletedCoreInput(changed, sample.plan, feedback,
            { ...recovery, paperSha256: deep.stableFingerprint(changed) }), /核心原输入恢复/);
        const restored = deep.restoreCompletedCoreInput(damaged, sample.plan, feedback, recovery);
        assert.deepEqual(restored.analysisManifest, original.analysisManifest);
        assert.deepEqual(restored.analysisFactReviewObligation, damaged.analysisFactReviewObligation);
        assert.equal(restored.latestAnalysisAttemptError, scopeError);
        assert.deepEqual(restored.coreInputRecoveryHistory[0].failedManifest, damaged.analysisManifest);
    }));
    const payload = { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [damaged] };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload));
    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify({ ...payload, status: 'complete',
        papers: [{ arxivId: paper.arxivId, authors: paper.authors, title: '单节恢复测试论文' }] }));
    for (const key of ['papers', 'papersLegacy']) fs.writeFileSync(Config.FILES[key], JSON.stringify({ papers: {} }));
    const audit = {
        documentType: '方法研究', confidence: '高', evidenceProfile: {
            version: 1, multiComponentClaimed: false, ablationStatus: 'not_applicable',
            targetEvaluation: 'public', sampleScaleReported: true, deploymentMeasured: false,
            publicGeneralizationEvaluated: false, engineeringEvidence: 'claim_only',
            evidenceBoundary: '[A_RESULTS] 同协议受控比较存在，但未报告实际端侧部署测量。',
            evidenceIds: ['A_METHOD', 'A_RESULTS']
        }, dimensions: Object.fromEntries([
            ['innovation', 1.5], ['technicalRigor', 1.2], ['experimentalSufficiency', 1.1], ['clarity', .8],
            ['impact', 1], ['openSource', 0], ['reproducibility', .3], ['engineering', 1]
        ].map(([key, score]) => [key, { score, reason: '[A_METHOD] 组件与实验流程有公开说明，本维仅评价这些可核对的研究证据。' }]))
    };
    const requests = [];
    const exterior = require('../scripts/analysis-contract').hashAnalysisWithMaskedCoreSummary;
    const generatedReaderDraft = require('./reader-signed-draft-fixture').fixture({
        noFigures: true, sourceText: sample.source.text
    }).draft;
    let interruptCore = true;
    let interruptReader = true;
    publicReaderRequestObserver = async (_url, _endpoint, _model, _body, _headers, options) => {
        const stage = options.usageContext.stage; requests.push(stage);
        assert.ok(['coreSummaryRepair', 'scoringAudit', 'apiReaderArticle'].includes(stage), stage);
        if (stage === 'coreSummaryRepair') {
            const pending = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
            assert.deepEqual(pending.analysisFactReviewObligation, facts.proofFor(feedback));
            assert.equal(engine.isSuccessfulAnalysisRecord(pending), false,
                '新核心反馈在模型请求前已阻断旧成功');
            if (interruptCore) {
                return { statusCode: 401, body: { error: { message: '合成测试的核心请求认证中断' } } };
            }
        }
        if (stage === 'scoringAudit') {
            const savedCore = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0].analysisCheckpoint;
            assert.equal(exterior(savedCore), exterior(original.analysis), '正常摘要阶段保存前逐字保护另外十二节');
            assert.equal(deep.extractSectionByTitle(savedCore, '核心摘要'), fixedSummary);
        }
        if (stage === 'apiReaderArticle' && interruptReader)
            return { statusCode: 401, body: { error: { message: '合成测试的Reader认证中断' } } };
        const output = stage === 'coreSummaryRepair' ? '## 核心摘要\n' + fixedSummary
            : stage === 'scoringAudit' ? JSON.stringify(audit)
                : JSON.stringify(generatedReaderDraft);
        return { statusCode: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: output }] }] } };
    };
    t.after(() => { publicReaderRequestObserver = null; });
    const selected = require('../scripts/reanalyze-selected');
    const beforeInvalid = fs.readFileSync(Config.FILES.deepAnalysisResult);
    const mixed = { ...feedback, readerFeedback: '不应夹带的Reader改写授权', rejectedReaderClaims: ['无权改写Reader'] };
    fs.writeFileSync(file, JSON.stringify(mixed));
    await assert.rejects(selected.reanalyzeSelected([sample.id], { coreFeedbackFiles: [file] }), /不能授权/);
    assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), beforeInvalid);
    assert.equal(fs.existsSync(path.join(daily.factFeedbackDirectory(sample.plan), facts.proofFor(mixed).feedbackSha256 + '.json')), false);
    assert.equal(requests.length, 0);
    fs.writeFileSync(file, JSON.stringify(feedback));
    await assert.rejects(selected.reanalyzeSelected([sample.id], { coreFeedbackFiles: [file],
        coreInputRecovery: { [sample.id]: recovery } }),
        { code: 'MODEL_HTTP_NON_RETRYABLE' });
    const failedPayload = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    const failed = failedPayload.papers[0];
    assert.deepEqual(failed.analysisFactReviewObligation, facts.proofFor(feedback));
    assert.equal(engine.isSuccessfulAnalysisRecord(failed), false);
    assert.equal(require('../scripts/lib/completed-bound-fact-feedback')
        .hasCompletedBoundFactFeedback(failed, feedback, sample.plan), false);
    assert.equal(engine.isSuccessfulAnalysisRecord(engine.mergeStoredAnalysisState(original, failed)), false,
        '普通合并不能用旧成功洗掉本次失败和未完成义务');
    const prepared = daily.prepareDailyFreshSourceRecoveryPayload(failedPayload,
        JSON.parse(fs.readFileSync(Config.FILES.filteredPapers)));
    assert.deepEqual(prepared.papers[0].analysisFactReviewObligation, failed.analysisFactReviewObligation);
    assert.equal(engine.isSuccessfulAnalysisRecord(prepared.papers[0]), false);
    require('../scripts/digest-status').updateAnalysisDigestStatuses([failed], { batchDate: sample.plan.batchDate });
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0], failed,
        '状态同步不能改写正式失败或清除其新事实义务');
    interruptCore = false;
    await assert.rejects(selected.reanalyzeSelected([sample.id], { coreFeedbackFiles: [file] }),
        { code: 'MODEL_HTTP_NON_RETRYABLE' });
    const scored = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.equal(facts.sha(scored.analysisCheckpoint), scored.analysisManifest.stages.scoringAudit.outputAnalysisSha256);
    assert.deepEqual(scored.analysisManifest.stages.coreSummaryRepair.factReview, facts.proofFor(feedback));
    assert.ok(scored.analysisStaleSnapshots.some(snapshot => !snapshot.payload.stages.primaryAnalysis),
        '真实旧不完整快照仍保留，不能伪补主阶段');
    const coreRequestsBeforeReaderResume = requests.filter(stage => stage === 'coreSummaryRepair').length;
    const scoringRequestsBeforeReaderResume = requests.filter(stage => stage === 'scoringAudit').length;
    interruptReader = false;
    const outcome = await selected.reanalyzeSelected([sample.id], { coreFeedbackFiles: [file] });
    assert.equal(requests.filter(stage => stage === 'coreSummaryRepair').length, coreRequestsBeforeReaderResume,
        '真实新核心和评分已完成后，仅续Reader不重复核心费用');
    assert.equal(requests.filter(stage => stage === 'scoringAudit').length, scoringRequestsBeforeReaderResume);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.success, 1);
    assert.ok(requests.includes('coreSummaryRepair'));
    assert.ok(requests.includes('scoringAudit'));
    assert.equal(requests.includes('primaryAnalysis'), false);
    assert.equal(facts.current(), null);
    const final = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.equal(Object.hasOwn(final, 'analysisFactReviewObligation'), false,
        '真实完整正常成功后才清除本次核心纠错义务');
    assert.notEqual(final.analysis, original.analysis);
    assert.notEqual(deep.extractSectionByTitle(final.analysis, '核心摘要'), oldSummary);
    assert.deepEqual(final.analysisManifest.stages.primaryAnalysis, original.analysisManifest.stages.primaryAnalysis);
    assert.equal(final.analysisManifest.stages.primaryAnalysis.factReview, undefined);
    assert.deepEqual(final.paidResponseHistory, original.paidResponseHistory);
    const recovered = saved.readSavedFeedback(final, sample.plan);
    assert.deepEqual(recovered.feedback, feedback);
    const completed = require('../scripts/lib/completed-bound-fact-feedback');
    assert.equal(engine.isSuccessfulAnalysisRecord(final), true);
    assert.equal(completed.hasCompletedBoundFactFeedback(final, feedback, sample.plan), true);
    const requestCount = requests.length;
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(final, () =>
        daily.withDailyFreshPaperSource(sample.plan, final, () => saved.analyzeWithRecoveredFeedback(final, sample.plan, () => {
            assert.equal(facts.current().coreOnly, true);
            assert.equal(facts.current().proof, null);
            assert.throws(() => facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'), /不能调用主分析/);
            return final;
        }))));
    const continued = await require('../scripts/deep-analysis-only').runDeepAnalysis({ date: sample.plan.batchDate,
        analyzeFn: () => assert.fail('普通恢复应复用真实已完成单节纠错，不重新请求模型') });
    assert.equal(continued.status, 'complete');
    assert.equal(continued.stats.skipped, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0], final);
    assert.equal(requests.length, requestCount);
    const archive = path.join(daily.factFeedbackDirectory(sample.plan), facts.proofFor(feedback).feedbackSha256 + '.json');
    const packetBytes = fs.readFileSync(archive);
    fs.unlinkSync(archive);
    assert.equal(saved.readSavedFeedback(final, sample.plan), null);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(final, () =>
        saved.analyzeWithRecoveredFeedback(final, sample.plan, () => assert.fail('缺包不能续跑')))), /缺少之前/);
    fs.writeFileSync(archive, packetBytes);
    fs.writeFileSync(archive, JSON.stringify({ ...feedback, coreFeedback: '被篡改的核心约束' }));
    assert.throws(() => saved.readSavedFeedback(final, sample.plan), /之前的纠错说明与保存的证明不一致/);
    fs.writeFileSync(archive, packetBytes);
    fs.appendFileSync(path.join(sample.plan.sourcesDir, sample.id, 'generation-000001', 'source.pdf'), ' altered');
    assert.throws(() => saved.readSavedFeedback(final, sample.plan), /来源|哈希|SHA/);
    assert.equal(requests.length, requestCount);
});

for (const mode of ['deep', 'batch']) {
    test(`正常${mode}仅Reader反馈使用真实Reader请求并保原主文摘要评分与旧费`, async t => {
        const sample = await createReviewedReaderSample(t);
        assert.equal(sample.paper.analysisManifest.contracts.readerResourceClaims, undefined,
            '旧已付费Reader没有新宣称合同，不能给测试原稿补签当前协议');
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
        assert.equal(resultPaper.analysisManifest.contracts.readerResourceClaims,
            analyzer.API_READER_RESOURCE_CLAIMS_CONTRACT);
        assert.equal(resultPaper.analysisManifest.stages.apiReaderArticle.readerResourceClaimsContractVersion,
            analyzer.API_READER_RESOURCE_CLAIMS_CONTRACT);
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
    const original = JSON.stringify(sample.paper);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(sample.paper, () =>
            saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan,
                options => analyzer.analyzePaperDeep(sample.paper, options)))),
        { code: 'READER_UPSTREAM_PROTECTION_REJECTED' });
    assert.equal(requests, 0);
    assert.equal(JSON.stringify(sample.paper), original);
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
        if (stage === 'apiReaderArticle') value.factReview = childBound.proof;
        else delete value.factReview;
    }
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(sample.paper, () =>
        facts.withFactReview(parentBound, () => {
            for (const [name, value] of Object.entries(sample.paper.analysisManifest.stages))
                if (!/^apiReader/.test(name)) Object.assign(value, facts.fingerprintFields(name, value));
            require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(sample.paper, sample.source);
        })));
    const originalPaper = structuredClone(sample.paper);
    const record = { contract: policy.CONTRACT, model: policy.MODEL, runId: 'local-reviewed-run',
        sourceRunId: sample.plan.runId, promptBindings: {}, originalPaperSha256: facts.sha(JSON.stringify(originalPaper)),
        inheritedFeedbacks: [{ feedback: parent, proof: parentBound.proof }], currentFeedbackProof: parentBound.proof };
    sample.paper.fullStageReanalysis = record;
    sample.paper.fullStageReanalysisHistory = [{ ...structuredClone(record), originalPaper }];
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(sample.paper, () =>
        facts.withFactReview(parentBound, () => {
            for (const [name, value] of Object.entries(sample.paper.analysisManifest.stages))
                if (!/^apiReader/.test(name)) Object.assign(value, facts.fingerprintFields(name, value));
            require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(sample.paper, sample.source);
        })));
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
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(longPaper, () =>
        facts.withFactReview(longParentBound, () => require('./helpers/normal-reader-parent-fingerprints')
            .installCurrentParentFingerprints(longPaper, sample.source))));
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
        await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(sample.paper, () =>
            facts.withFactReview(parentBound, () => {
                for (const [name, stage] of Object.entries(sample.paper.analysisManifest.stages)) {
                    if (!/^apiReader/.test(name)) Object.assign(stage, facts.fingerprintFields(name, stage));
                }
                require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(sample.paper, sample.source);
            })));
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

async function createDualReaderCorrectionSample(t, parentStage = 'primaryAnalysis') {
    const sample = await createReviewedReaderSample(t);
    const parent = { ...sample.feedback, primaryFeedback: '', coreFeedback: '', readerFeedback: '',
        rejectedPrimaryClaims: [], rejectedCoreClaims: [], rejectedReaderClaims: [] };
    if (parentStage === 'primaryAnalysis') {
        parent.primaryFeedback = '保留原已完成主文及真实比较条件。';
        parent.rejectedPrimaryClaims = ['原主文错误已改正'];
        parent.readerFeedback = '原父Reader约束必须继续保留。';
        parent.rejectedReaderClaims = ['原父错误仍禁止'];
    } else {
        parent.coreFeedback = '原摘要事实条件必须继续保留。';
        parent.rejectedCoreClaims = ['原摘要错误已改正'];
    }
    const child = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        readerFeedback: [parent.readerFeedback, '旧Reader子包额外事实条件。'].filter(Boolean).join('\n'),
        rejectedReaderClaims: [...parent.rejectedReaderClaims, '旧子错误仍禁止'],
        sourceQuotes: [sample.source.text.slice(0, 100), sample.source.text.slice(100, 190)] };
    for (const stage of Object.values(sample.paper.analysisManifest.stages)) {
        delete stage.factReview;
        delete stage.scoringFactReview;
    }
    const parentBound = facts.validateFeedback(parent, sample.plan, sample.paper);
    const childBound = facts.validateFeedback(child, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages[parentStage].factReview = parentBound.proof;
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = childBound.proof;
    facts.withFactReview(parentBound, () => undefined);
    facts.withFactReview(childBound, () => undefined);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.withFreshPaperContext(sample.paper, () =>
        facts.withFactReview(parentBound, () => {
            for (const [name, stage] of Object.entries(sample.paper.analysisManifest.stages)) {
                if (!/^apiReader/.test(name)) Object.assign(stage, facts.fingerprintFields(name, stage));
            }
            require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(sample.paper, sample.source);
        })));
    // Existing paid ledger/counters are observations, never new permission.
    sample.paper.llmUsage = [{ requestId: 'original-reader-paid', stage: 'apiReaderRepair', totalTokens: 74 }];
    Object.assign(sample.paper.analysisManifest.stages.apiReaderArticle,
        { contentAttempts: 5, fullAttempts: 2, noProgressCount: 1 });
    const next = { ...child, readerFeedback: child.readerFeedback + '\n本轮只修新增已证实的发布问题。' };
    return { ...sample, parent, child, parentBound, childBound, next };
}

for (const parentStage of ['primaryAnalysis', 'coreSummaryRepair']) {
    test(`新Reader子包严格继承真实${parentStage}父与旧Reader子包且保留原费用次数`, async t => {
        const sample = await createDualReaderCorrectionSample(t, parentStage);
        const before = structuredClone(sample.paper);
        const originalPacketFile = path.join(daily.factFeedbackDirectory(sample.plan), sample.childBound.proof.feedbackSha256 + '.json');
        const originalPacketBytes = fs.readFileSync(originalPacketFile);
        const assertPreserved = paper => {
            const actual = structuredClone(paper), original = structuredClone(before);
            // The normal refresh archives the actual stage input before work.
            // That new immutable archive is the only permitted added field.
            delete actual.analysisStaleSnapshots;
            delete original.analysisStaleSnapshots;
            assert.deepEqual(actual.analysisFactReviewObligation, facts.proofFor(sample.next));
            delete actual.analysisFactReviewObligation;
            assert.deepEqual(actual, original);
            for (const snapshot of paper.analysisStaleSnapshots || []) {
                const archived = deep.validateStaleAnalysisSnapshot(snapshot);
                assert.ok(archived);
                assert.ok([before.analysis, before.analysisCheckpoint].includes(archived.analysisCheckpoint));
                assert.deepEqual(archived.stages.apiReaderArticle.factReview,
                    before.analysisManifest.stages.apiReaderArticle.factReview);
            }
        };
        let requests = 0;
        t.mock.method(deep, 'refreshApiReaderArticleFromSource', async (paper, source, options) => {
            requests++;
            const current = facts.current(sample.id);
            assert.equal(current.readerOnly, true);
            assert.deepEqual(current.proof, sample.parentBound.proof);
            assert.deepEqual(current.readerBound.proof, facts.proofFor(sample.next));
            assert.ok(options.reviewFeedback.includes(sample.child.readerFeedback));
            assert.ok(options.reviewFeedback.includes(parentStage === 'primaryAnalysis'
                ? sample.parent.primaryFeedback : sample.parent.coreFeedback));
            for (const claim of sample.child.rejectedReaderClaims) assert.ok(facts.readerRejectedClaims(sample.id).includes(claim));
            assert.equal(facts.validateReaderReviewFeedbackLength(options.reviewFeedback, sample.id), 4000);
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'scoringAudit'])
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed(stage));
            assertPreserved(paper);
            return paper;
        });
        await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
            saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan, () => assert.fail('不请求主文或模型'), sample.next)));
        assert.equal(requests, 1);
        assertPreserved(sample.paper);
        assert.deepEqual(fs.readFileSync(originalPacketFile), originalPacketBytes);
    });
}

test('替换双反馈子包拒绝缺旧约束或原包、变更来源父身份与越权，不发额度', async t => {
    const sample = await createDualReaderCorrectionSample(t);
    const before = structuredClone(sample.paper);
    const oldFile = path.join(daily.factFeedbackDirectory(sample.plan), sample.childBound.proof.feedbackSha256 + '.json');
    const oldBytes = fs.readFileSync(oldFile);
    const run = (feedback, parent = sample.parentBound) => daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(parent, () =>
            facts.withReaderFactReview(facts.validateFeedback(feedback, sample.plan, sample.paper), sample.paper,
                () => assert.fail('拒绝项不能进入Reader请求')))));
    for (const changed of [
        { ...sample.next, readerFeedback: sample.parent.readerFeedback + '\n遗漏旧子约束。' },
        { ...sample.next, rejectedReaderClaims: sample.parent.rejectedReaderClaims },
        { ...sample.next, sourceQuotes: sample.parent.sourceQuotes },
    ]) await assert.rejects(run(changed), /遗漏旧Reader事实约束/);
    await assert.rejects(run({ ...sample.next, sourceFiles: { ...sample.next.sourceFiles, 'source.pdf': '0'.repeat(64) } }), /来源SHA/);
    await assert.rejects(run({ ...sample.next, primaryFeedback: '不允许扩大主文修改。',
        rejectedPrimaryClaims: ['原主文错误已改正'] }), /不能授权主文/);
    const wrongParent = facts.validateFeedback({ ...sample.parent, primaryFeedback: '另一份父说明。' }, sample.plan, sample.paper);
    await assert.rejects(run(sample.next, wrongParent), /缺少原主分析反馈身份/);
    fs.unlinkSync(oldFile);
    try { await assert.rejects(run(sample.next), /缺少原Reader事实反馈包/); }
    finally { fs.writeFileSync(oldFile, oldBytes, { mode: 0o600 }); }
    const damaged = JSON.parse(oldBytes);
    damaged.readerFeedback += '伪造旧原包。';
    fs.writeFileSync(oldFile, JSON.stringify(damaged), { mode: 0o600 });
    try { await assert.rejects(run(sample.next), /缺少原Reader事实反馈包|证明不同|不一致/); }
    finally { fs.writeFileSync(oldFile, oldBytes, { mode: 0o600 }); }
    const bound = facts.validateFeedback(sample.next, sample.plan, sample.paper);
    assert.throws(() => facts.withReaderFactReview(bound, sample.paper, () => assert.fail('必须持锁')), /持有当前论文锁/);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        facts.withFactReview(sample.parentBound, () => facts.withReaderFactReview({ ...bound }, sample.paper,
            () => assert.fail('复制bound不能授权'))))), /尚未在锁内核验/);
    assert.deepEqual(sample.paper, before);
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
});

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
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{
  requests++;
  p.analysisManifest.contracts.readerResourceClaims=deep.API_READER_RESOURCE_CLAIMS_CONTRACT;
  p.analysisManifest.stages.apiReaderArticle.readerResourceClaimsContractVersion=deep.API_READER_RESOURCE_CLAIMS_CONTRACT;
  p.paidResponseHistory=[{forged:true}];
  return p;
 });
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

test('原父子Reader恢复不能借父范围改变已有摘要阶段，失败保原上游',async t=>{
 const sample=await createReviewedReaderSample(t),paper=sample.paper;
 const parentFeedback={...sample.feedback,primaryFeedback:'沿用已纠正的父范围主文。',readerFeedback:'',rejectedReaderClaims:[]};
 const parent=facts.validateFeedback(parentFeedback,sample.plan,paper);facts.withFactReview(parent,()=>undefined);
 paper.analysisManifest.stages.primaryAnalysis.factReview=parent.proof;paper.analysisManifest.stages.scoringAudit.factReview=parent.proof;
 const childFeedback={...sample.feedback,rejectedPrimaryClaims:[]};
 const child=facts.validateFeedback(childFeedback,sample.plan,paper);facts.withFactReview(child,()=>undefined);paper.analysisManifest.stages.apiReaderArticle.factReview=child.proof;
 await daily.withDailyFreshAnalysisContext(sample.plan,()=>fresh.withFreshPaperContext(paper,()=>facts.withFactReview(parent,()=>require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper,sample.source))));
 const actualComplete=structuredClone(paper);
 paper.analysisManifest.stages.coreSummaryRepair.summarySha256='0'.repeat(64);
 paper.analysisManifest.stages.imageDownload.status='pending';
 paper.apiReaderArticleSha256='0'.repeat(64);
 paper.latestAnalysisAttemptError='独立Reader纠错缺少已完成的主文、摘要或评分';
 const originalManifest=JSON.stringify(paper.analysisManifest),originalCheckpoints=JSON.stringify(paper.analysisStageCheckpoints);
 let parentCalls=0,readerCalls=0,normalFinal=0;
 t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{
  readerCalls++;assert.equal(facts.current().readerOnly,true);assert.equal(facts.current().readerBound.proof.feedbackSha256,child.proof.feedbackSha256);
  p.apiReaderArticleSha256=actualComplete.apiReaderArticleSha256;return p;
 });
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,async()=>{
  const result=await saved.analyzeWithRecoveredFeedback(paper,sample.plan,async options=>{
   assert.equal(options.requireCompletedPrimaryCheckpoint,true);
   if(options.resumeSavedReaderUpstreamOnly){parentCalls++;assert.equal(facts.current().readerOnly,undefined);assert.equal(facts.current().proof.feedbackSha256,parent.proof.feedbackSha256);
    return {...paper,analysisManifest:{...paper.analysisManifest,stages:{...paper.analysisManifest.stages,coreSummaryRepair:structuredClone(actualComplete.analysisManifest.stages.coreSummaryRepair)}}};}
   normalFinal++;assert.equal(facts.current().readerOnly,true);assert.throws(()=>facts.assertScoringOnlyModelStageAllowed('scoringAudit'));return paper;
  });
  assert.equal(result.analysis,actualComplete.analysis);
 })),{code:'READER_UPSTREAM_PROTECTION_REJECTED'});
 assert.equal(parentCalls,1);assert.equal(readerCalls,0);assert.equal(normalFinal,0);
 assert.equal(JSON.stringify(paper.analysisManifest),originalManifest);assert.equal(JSON.stringify(paper.analysisStageCheckpoints),originalCheckpoints);
});

test('祖先包不倒灌无旧proof上游，Reader恢复不能改评分或带坏评分进入Reader',async t=>{
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
  await daily.withDailyFreshAnalysisContext(sample.plan,()=>fresh.withFreshPaperContext(paper,()=>require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper,sample.source)));
  const oldScore=structuredClone(paper.analysisManifest.stages.scoringAudit);
  paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256='0'.repeat(64);paper.apiReaderArticleSha256='0'.repeat(64);
  const originalManifest=JSON.stringify(paper.analysisManifest);
  let readers=0,upstream=0,finals=0;
  const refresh=t.mock.method(deep,'refreshApiReaderArticleFromSource',async p=>{readers++;assert.equal(facts.current().readerOnly,true);assert.equal(facts.fingerprintFields('primaryAnalysis',p.analysisManifest.stages.primaryAnalysis).factReview,undefined);assert.deepEqual(facts.current().restoredReaderConstraints.parentProof,parent.proof);p.apiReaderArticleSha256=originalPaper.apiReaderArticleSha256;return p;});
  const run=()=>daily.withDailyFreshAnalysisContext(sample.plan,()=>engine.withPaperAnalysisLock(paper,()=>saved.analyzeWithRecoveredFeedback(paper,sample.plan,async options=>{
   if(options.resumeSavedReaderUpstreamOnly){upstream++;assert.equal(facts.current(),null);if(fixScore)paper.analysisManifest.stages.scoringAudit=oldScore;return paper;}
   finals++;assert.equal(facts.current().readerOnly,true);assert.throws(()=>facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'));return paper;
  })));
  await assert.rejects(run(),e=>e.code===(fixScore?'READER_UPSTREAM_PROTECTION_REJECTED':'READER_UPSTREAM_INCOMPLETE'));assert.equal(readers,0);assert.equal(finals,0);
  assert.equal(JSON.stringify(paper.analysisManifest),originalManifest);
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

test('真实已付Reader归档整阶段恢复，不补签正文并拒错误来源、反馈及缺失记录', {
    skip: !process.env.READER_ARCHIVE_REAL_RECORDS || !process.env.READER_ARCHIVE_SOURCE_ROOT
        ? '需提供真实原记录与封存来源；不使用模拟付费证明' : false
}, async t => {
    const file = process.env.READER_ARCHIVE_REAL_RECORDS;
    const bytes = fs.readFileSync(file), data = JSON.parse(bytes);
    const previousRoot = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = process.env.READER_ARCHIVE_SOURCE_ROOT;
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previousRoot; });
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
    const original = data.papers.find(p => requestApi.normalizedId(p) === '2610.11544');
    assert.ok(original);
    publicReaderRequestObserver = () => assert.fail('归档恢复不能产生模型请求');
    t.after(() => { publicReaderRequestObserver = null; });
    const recover = (paper, sourcePlan = plan) => daily.withDailyFreshAnalysisContext(plan,
        () => engine.withPaperAnalysisLock(paper, () => saved.recoverArchivedCompletedReader(paper, sourcePlan)));
    const result = await recover(structuredClone(original));
    assert.ok(result);
    assert.equal(engine.isSuccessfulAnalysisRecord(result), true);
    for (const key of ['analysis', 'apiReaderArticle', 'apiReaderPlan', 'paidResponseHistory', 'llmUsage', 'apiReaderFailedBundleHistory'])
        assert.deepEqual(result[key], original[key]);
    for (const key of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit'])
        assert.deepEqual(result.analysisManifest.stages[key], original.analysisManifest.stages[key]);
    assert.ok(result.analysisStaleSnapshots.length >= original.analysisStaleSnapshots.length);
    const selected = original.analysisStaleSnapshots.findIndex(snapshot =>
        snapshot.payload?.stages?.apiReaderArticle?.articleSha256 === original.apiReaderArticleSha256);
    assert.ok(selected >= 0);
    for (const change of [
        paper => { paper.analysisStaleSnapshots[selected].payloadSha256 = '0'.repeat(64); },
        paper => { paper.apiReaderArticle += ' changed'; },
        paper => { paper.freshRewriteProvenance.sourceManifestSha256 = '0'.repeat(64); },
        paper => { const snapshot = paper.analysisStaleSnapshots[selected];
            snapshot.payload.stages.apiReaderArticle.factReview.feedbackSha256 = '0'.repeat(64);
            snapshot.payloadSha256 = daily.stableHash(snapshot.payload); },
        paper => { delete paper.analysisManifest.stages.apiReaderArticle; }
    ]) {
        const changed = structuredClone(original); change(changed);
        let refused = false;
        try { refused = !await recover(changed); } catch (_) { refused = true; }
        assert.equal(refused, true);
    }
    assert.equal(await recover(structuredClone(original), { ...plan, readerAttemptsDir: path.join(os.tmpdir(), 'absent-reader-record-directory') }), null);
    const readDirectory = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...args) => directory === plan.readerAttemptsDir
        ? [] : readDirectory.call(fs, directory, ...args));
    assert.equal(await recover(structuredClone(original)), null);
    t.mock.restoreAll();
    const feedback = structuredClone(saved.readSavedFeedback(original, plan).feedback);
    feedback.readerFeedback += ' 新的尚未执行约束';
    const bound = facts.validateFeedback(feedback, plan, original);
    assert.equal(await facts.withFactReview(bound, () => recover(structuredClone(original))), null);
    assert.deepEqual(fs.readFileSync(file), bytes);
});

test('batch显式Reader轮覆盖直接Reader刷新分支，真实安装额度并保留旧候选', async t => {
    const sample = await createReviewedReaderSample(t), paper = sample.paper;
    const retry = require('../scripts/lib/explicit-reader-retry-round');
    const repair = require('../scripts/lib/reader-repair');
    facts.withFactReview(facts.validateFeedback(sample.feedback, sample.plan, paper), () => undefined);
    paper.latestAnalysisAttemptError = '深度分析仍在进行，已保存阶段记录。';
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: sample.feedback.readerFeedback + ' 只继续原Reader。' };
    const previous = Object.fromEntries(['deepAnalysisResult', 'filteredPapers', 'papers'].map(key => [key, Config.FILES[key]]));
    t.after(() => Object.assign(Config.FILES, previous));
    for (const key of Object.keys(previous)) Config.FILES[key] = path.join(sample.plan.runDir, 'explicit-' + key + '.json');
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    const data = { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [paper] };
    write(Config.FILES.deepAnalysisResult, data);
    write(Config.FILES.filteredPapers, { ...data, status: 'complete' });
    write(Config.FILES.papers, { generation: 1, papers: {} });
    const feedbackFile = path.join(sample.plan.runDir, 'explicit-feedback.json'); write(feedbackFile, feedback);
    const identity = { paperId: paper.arxivId, maxAttempts: 6, sourceSha256: paper.sourceSha256,
        freshAnalysis: daily.withDailyFreshAnalysisContext(sample.plan, () => fresh.freshAnalysisIdentity(paper.arxivId)) };
    const old = { status: 'failed', draft: null, rawDraft: '', issues: [], attempts: 6, fullAttempts: 2,
        noProgress: 0, failureSignature: '', transportFailures: 0 };
    repair.saveFailedCandidate(sample.plan.readerAttemptsDir, identity, old);
    const candidateFile = path.join(sample.plan.readerAttemptsDir, repair.hashDraft(identity) + '.json');
    const oldBytes = fs.readFileSync(candidateFile);
    const grant = { contract: retry.CONTRACT, batchDate: sample.plan.batchDate, runId: sample.plan.runId,
        sourceFiles: feedback.sourceFiles, originalIdentitySha256: repair.hashDraft(identity), paperId: sample.id,
        roundId: require('node:crypto').randomUUID(), identitySha256: repair.hashDraft(identity), envelopeSha256: facts.sha(oldBytes),
        payloadSha256: repair.hashDraft(old), wholeSha256: facts.sha(paper.analysisCheckpoint || paper.analysis),
        maxResponses: 3, maxFullResponses: 1, maxPhysicalRequests: 6, maxReservedOutputTokens: 80000 };
    const manifestFile = path.join(sample.plan.runDir, 'explicit-manifest.json');
    write(manifestFile, { batchDate: sample.plan.batchDate, runId: sample.plan.runId, rounds: [grant] });
    let calls = 0;
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async target => {
        calls++;
        const next = retry.beginExplicitRound(sample.plan.readerAttemptsDir, identity, old, target);
        assert.ok(next, '直接Reader刷新仍须处在显式新轮范围内');
        assert.equal(next.explicitReaderRetryRound.roundId, grant.roundId);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.oldAttempts, 6); assert.equal(receipt.oldFullAttempts, 2);
        assert.deepEqual(fs.readFileSync(receipt.archivedFile), oldBytes);
        assert.equal(receipt.physicalRequests, 0, '隔离回归不能产生模型调用');
        throw new Error('已核验直接Reader刷新中新轮额度安装；停止隔离回归');
    });
    const moduleFile = require.resolve('../scripts/batch-analyze'); delete require.cache[moduleFile];
    await require(moduleFile).main({ factFeedbackFiles: [feedbackFile], readerRetryManifestPath: manifestFile,
        analyzeFn: () => assert.fail('Reader刷新分支不能退回整篇分析回调'),
        analyzeBatch: async (papers, options) => engine.withPaperAnalysisLock(papers[0], async () => {
            const locked = options.preparePaperLocked(papers[0]); assert.equal(locked.skip, false);
            await assert.rejects(options.analyzeFn(locked.paper), /已核验直接Reader刷新中新轮额度安装/);
            return { stats: { success: 0, failed: 1, skipped: 0 } };
        }) });
    assert.equal(calls, 1);
    const final = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.equal(final.analysis, paper.analysis);
    assert.deepEqual(final.paidResponseHistory, paper.paidResponseHistory);
    for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit'])
        assert.deepEqual(final.analysisManifest.stages[stage], paper.analysisManifest.stages[stage]);
});

test('真实成功返回同步解析缓存，Reader来源拒绝后正常重试不重新评分或改原费用', async t => {
    const sample = await createReviewedReaderSample(t);
    const paper = sample.paper;
    for (const stage of Object.values(paper.analysisManifest.stages)) {
        delete stage.factReview; delete stage.scoringFactReview;
    }
    const originalReaderStage = structuredClone(paper.analysisManifest.stages.apiReaderArticle);
    delete originalReaderStage.reviewFeedbackSha256;
    const base = paper.analysis;
    const oldAnalysis = base.replace('6.9/10', '6.4/10').replace('engineering_score: 1.0', 'engineering_score: 0.5')
        .replace('工程/实践价值：1.0/1.5', '工程/实践价值：0.5/1.5');
    const scoredAnalysis = base.replace('6.9/10', '7.1/10').replace('engineering_score: 1.0', 'engineering_score: 1.2')
        .replace('工程/实践价值：1.0/1.5', '工程/实践价值：1.2/1.5');
    assert.equal(requestApi.parseAnalysis(oldAnalysis).score, '6.4');
    assert.equal(requestApi.parseAnalysis(scoredAnalysis).score, '7.1');
    paper.analysis = oldAnalysis; paper.parsed = requestApi.parseAnalysis(oldAnalysis);
    paper.analysisCheckpoint = scoredAnalysis;
    paper.analysisStageCheckpoints = { ...(paper.analysisStageCheckpoints || {}), scoringAudit: scoredAnalysis };
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(scoredAnalysis);
    paper.analysisManifest.stages.imageSupplement = { status: 'skipped', reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: paper.apiReaderFigures.length, officialFiguresSha256: deep.stableFingerprint(paper.apiReaderFigures) };
    paper.paidResponseHistory = [{ responseId: 'real-prior-audit-budget-fixture', totalTokens: 37 }];
    const scoring = structuredClone(paper.analysisManifest.stages.scoringAudit), fees = structuredClone(paper.paidResponseHistory);
    // 执行实际生产成功收尾代码，前序来源/评分已由样本给出；不复制待测返回表达式。
    const filename = path.join(__dirname, '../scripts/deep-analyzer.js');
    const production = fs.readFileSync(filename, 'utf8');
    const functionStart = production.indexOf('async function analyzePaperDeep');
    const end = production.indexOf('\n}\n\nasync function scanOpensource', functionStart);
    const begin = production.lastIndexOf('    delete paper.analysisCheckpoint;', end);
    assert.ok(begin > functionStart && end > begin);
    const loaded = new (require('node:module'))(filename, module);
    loaded.filename = filename; loaded.paths = module.paths;
    loaded._compile(production + `\nmodule.exports.testActualSuccessfulReturn = function(paper, analysis) {
        const sourceAcquisitionRecord={},sourceWarnings=[],selectedImageUrls=[],imageUrls=[],imageManifest=null;
        const analysisManifest=paper.analysisManifest;
        ${production.slice(begin, end)}
    };`, filename);
    let attempts = 0, refreshes = 0;
    publicReaderRequestObserver = () => assert.fail('缓存衔接恢复不能产生主分析、评分或Reader付费请求');
    t.after(() => { publicReaderRequestObserver = null; });
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async target => {
        refreshes++;
        assert.equal(target.analysis, scoredAnalysis);
        assert.deepEqual(target.parsed, requestApi.parseAnalysis(scoredAnalysis));
        target.analysisManifest.stages.apiReaderArticle = structuredClone(originalReaderStage);
        return target;
    });
    const outcome = await daily.withDailyFreshAnalysisContext(sample.plan, () =>
        daily.withDailyFreshPaperSource(sample.plan, paper, () => engine.withPaperAnalysisLock(paper, () =>
            engine.analyzePaperWithRetry(paper, { maxRetries: 1, retryDelayMs: 0, analyzeFn: async current => {
                if (++attempts === 1) {
                    const returned = loaded.exports.testActualSuccessfulReturn(current, scoredAnalysis);
                    returned.analysisManifest.stages.apiReaderArticle.sourceBindingsSha256 = '0'.repeat(64);
                    return returned;
                }
                return saved.analyzeWithRecoveredFeedback(current, sample.plan,
                    () => assert.fail('评分已签完成后只需正常Reader恢复'));
            } }))));
    assert.equal(outcome.success, true, outcome.error);
    assert.equal(attempts, 2); assert.equal(refreshes, 1);
    assert.equal(outcome.result.analysis, scoredAnalysis);
    assert.deepEqual(outcome.result.parsed, requestApi.parseAnalysis(scoredAnalysis));
    assert.deepEqual(outcome.result.analysisManifest.stages.scoringAudit, scoring);
    assert.deepEqual(outcome.result.paidResponseHistory, fees);
});

test('原Reader-only来源失败稿仅恢复真实同身份候选，预算6/2不重置且signed/local资格仍拒绝', async t => {
    const sample = await createReviewedReaderSample(t), paper = sample.paper;
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(feedback, sample.plan, paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    paper.analysisManifest.stages.apiReaderArticle.status = 'invalid_output';
    paper.latestAnalysisAttemptError = '原source-only失败稿等待按同反馈恢复';
    facts.withFactReview(bound, () => undefined);
    const before = structuredClone(paper);
    const repair = require('../scripts/lib/reader-repair');
    let requests = 0;
    publicReaderRequestObserver = () => { requests++; assert.fail('来源旧稿恢复不能获得新的全文或局部付费机会'); };
    t.after(() => { publicReaderRequestObserver = null; });
    await daily.withDailyFreshAnalysisContext(sample.plan, () => daily.withDailyFreshPaperSource(sample.plan, paper, () =>
        engine.withPaperAnalysisLock(paper, async () => {
            const revision = require('../scripts/lib/reader-recovery-revision');
            const load = revision.loadReaderRecoveryRevision;
            let identity;
            t.mock.method(revision, 'loadReaderRecoveryRevision', (...args) => {
                identity = structuredClone(args[1]);
                return load(...args);
            });
            const invoke = () => saved.analyzeWithRecoveredFeedback(paper, sample.plan,
                () => assert.fail('不扩大到整篇主分析'));
            await assert.rejects(invoke(), { code: 'READER_SOURCE_RECOVERY_CANDIDATE_MISSING' });
            assert.equal(identity.contentMode, 'reader-source-only-v1');
            const draft = structuredClone(require('./reader-signed-draft-fixture').fixture({ noFigures: true }).draft);
            draft.sections[0].body = '不完整的原失败稿';
            const failed = { status: 'failed', draft, rawDraft: JSON.stringify(draft), issues: [],
                attempts: 6, fullAttempts: 2, noProgress: 2, failureSignature: '', transportFailures: 0,
                ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
            repair.saveFailedCandidate(sample.plan.readerAttemptsDir, identity, failed);
            const filename = path.join(sample.plan.readerAttemptsDir, repair.hashDraft(identity) + '.json');
            const oldBytes = fs.readFileSync(filename);
            await assert.rejects(invoke(), { code: 'READER_REPAIR_ATTEMPTS_EXHAUSTED' });
            assert.deepEqual(fs.readFileSync(filename), oldBytes);
            assert.equal(repair.loadFailedCandidate(sample.plan.readerAttemptsDir, identity).attempts, 6);
            assert.equal(repair.loadFailedCandidate(sample.plan.readerAttemptsDir, identity).fullAttempts, 2);
            for (const options of [{}, { resumeSavedSourceReader: true, readerFactLocalRevision: true },
                { resumeSavedSourceReader: true, resourceLocalRevision: true },
                { resumeSavedSourceReader: true, signedRevisionMinimalDisplay: true }]) {
                await assert.rejects(facts.withReaderFactReview(bound, paper, () =>
                    deep.refreshApiReaderArticleFromSource(paper, sample.source, { ...options,
                        reviewFeedback: feedback.readerFeedback })), /定向修订需要完整/);
            }
            await assert.rejects(facts.withReaderFactReview(bound, paper, () =>
                deep.refreshApiReaderArticleFromSource(paper, sample.source, {
                    resumeSavedSourceReader: true, reviewFeedback: '未授权的新Reader反馈' })), /定向修订需要完整/);
        })));
    assert.equal(requests, 0);
    assert.equal(paper.analysis, before.analysis);
    assert.deepEqual(paper.parsed, before.parsed);
    assert.deepEqual(paper.paidResponseHistory, before.paidResponseHistory);
    for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit'])
        assert.deepEqual(paper.analysisManifest.stages[stage], before.analysisManifest.stages[stage]);
});

test('恢复回放共用生产草稿规范化，输入和生成器状态在正常及异常回放后保持独立', async t => {
    const source = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64),
        headerRows: [0], bodyRows: [1], matrix: [['Method', 'SDR'], ['Baseline', '0.10.1']] };
    table.cells = table.matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
        rowspan: 1, colspan: 1, text, header: r === 0, sourceDomSha256: 'b'.repeat(64) })));
    const { payloadSha256, ...sourceBody } = source.sourceDetails.structuredArtifacts;
    const artifactBody = { ...sourceBody, tables: [table] };
    source.sourceDetails.structuredArtifacts = { ...artifactBody, payloadSha256: deep.stableFingerprint(artifactBody) };
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-replay-normalization-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const revision = require('../scripts/lib/reader-recovery-revision');
    const originalLoad = revision.loadReaderRecoveryRevision;
    let checked = 0, requests = 0;
    t.mock.method(revision, 'loadReaderRecoveryRevision', (...args) => {
        const options = args[2];
        assert.equal(typeof options.normalizeReplayDraft, 'function');
        const originalDraft = structuredClone(source.draft), originalIssues = [];
        const normalized = options.normalizeReplayDraft(originalDraft, originalIssues);
        assert.deepEqual(originalDraft, source.draft, '回放不得修改调用方的原始付费稿');
        assert.deepEqual(originalIssues, []);
        assert.throws(() => options.normalizeReplayDraft({ ...originalDraft, sections: 'invalid' }, []));
        const blockedDraft = structuredClone(normalized);
        const resultBody = blockedDraft.sections.find(section => section.kind === 'result');
        resultBody.body = resultBody.body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/, '[[TABLE_2]]');
        blockedDraft.tableBindings[1] = { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } };
        const failed = options.normalizeReplayDraft(blockedDraft, []);
        assert.equal(failed.contract, 'reader-source-blocked-normalization-v1');
        assert.equal(failed.blockingIssues[0].path, '/tableBindings/1');
        assert.equal(failed.blockingIssues[1].path, '/sections/7/body');
        const changedBeforeOrder = structuredClone(blockedDraft);
        changedBeforeOrder.sections[7].body = changedBeforeOrder.sections[7].body.replace('\n\n[[TABLE_2]]', '[[TABLE_2]]');
        assert.throws(() => options.normalizeReplayDraft(changedBeforeOrder, []),
            error => error.code === 'READER_SOURCE_TABLE_UNRENDERABLE',
            '付费回放的前置规范化改变 raw 时保守拒绝，不猜未归档中间稿');

        assert.deepEqual(options.normalizeReplayDraft(originalDraft, originalIssues), normalized,
            '异常回放后仍还原生产闭包状态');
        checked++;
        return originalLoad(...args);
    });
    const result = await deep.generateApiReaderArticleDetailed(source.paper, '', source.sourceDetails.text, {
        sourceText: source.sourceDetails.text, structuredArtifacts: source.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => { requests++; return JSON.stringify(source.draft); }
    });
    assert.equal(checked, 1); assert.equal(requests, 1);
    assert.equal(result.attempts, 1);
    assert.ok(result.article.length > 5000, '回放观察不得污染实际生成候选');
});

test('正常保护刷新只在source-only消费真实失败资源handle，失败不混签公开束或增加模型机会', async t => {
    const quote = 'The benchmark uses https://example.com/baseline as a third-party baseline.';
    const sample = await createReviewedReaderSample(t, {sourceText:'The source reports a controlled measurement of 1.0 under the same protocol.\n'
        + quote + '\n' + 'Additional method evidence describes experimental conditions and evaluation protocols. '.repeat(100)});
    const paper = sample.paper, feedback = {...sample.feedback,rejectedPrimaryClaims:[]};
    const bound = facts.validateFeedback(feedback,sample.plan,paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview=bound.proof;
    paper.analysisManifest.stages.apiReaderArticle.status='invalid_output';
    paper.latestAnalysisAttemptError='保留真实source-only失败稿';
    facts.withFactReview(bound,()=>undefined);
    const originalResources=structuredClone(paper.apiReaderResources);
    const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:paper.sourceSha256,resources:[{
        type:'third_party',origin:'paper_source',sourceQuote:quote,sourceQuoteSha256:facts.sha(quote),
        originalUrl:'https://example.com/baseline',finalUrl:'https://example.com/baseline',redirects:[],
        status:200,availability:'available',retryable:false}]};
    const resources={...body,identitySha256:daily.stableHash(body)};
    paper.apiReaderFailedBundleHistory=[{sourceSha256:paper.sourceSha256,fields:{apiReaderResources:resources},
        stages:{apiReaderArticle:{status:'invalid_output'}},contracts:{}}];
    paper.analysisManifest.stages.openSourceScan.fingerprint='source-bound-resource-scan';
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=resources.identitySha256;
    const before=structuredClone(paper), resourceReplay=require('../scripts/lib/reader-failed-bundle-resource-replay');
    const read=resourceReplay.readRecoveryReaderResources;let consumed=0, handle;
    t.mock.method(resourceReplay,'readRecoveryReaderResources',(...args)=>{
        const actual=read(...args);consumed++;handle=args[0];assert.deepEqual(actual,resources);return actual;
    });
    publicReaderRequestObserver=()=>assert.fail('无原失败候选不能产生模型请求');
    t.after(()=>{publicReaderRequestObserver=null;});
    await daily.withDailyFreshAnalysisContext(sample.plan,()=>daily.withDailyFreshPaperSource(sample.plan,paper,()=>
        engine.withPaperAnalysisLock(paper,async()=>{
            await assert.rejects(saved.analyzeWithRecoveredFeedback(paper,sample.plan,()=>assert.fail('不能进入整篇模型')),
                {code:'READER_SOURCE_RECOVERY_CANDIDATE_MISSING'});
            assert.equal(consumed,1);assert.ok(handle);
            await assert.rejects(facts.withReaderFactReview(bound,paper,()=>deep.refreshApiReaderArticleFromSource(paper,sample.source,{
                resumeSavedSourceReader:true,recoveryReaderResources:structuredClone(handle),reviewFeedback:feedback.readerFeedback})),/须保有未改变/);
            for(const options of [{}, {readerFactLocalRevision:true},{resourceLocalRevision:true},{signedRevisionMinimalDisplay:true}])
                await assert.rejects(deep.refreshApiReaderArticleFromSource(paper,sample.source,{
                    resumeSavedSourceReader:true,...options,...(!Object.keys(options).length?{resumeSavedSourceReader:false}:{}),
                    recoveryReaderResources:handle,reviewFeedback:feedback.readerFeedback}),/只允许普通source-only/);
        })));
    assert.deepEqual(paper.apiReaderResources,originalResources);
    assert.equal(paper.apiReaderArticle,before.apiReaderArticle);
    assert.deepEqual(paper.analysisManifest,before.analysisManifest);
    assert.deepEqual(paper.apiReaderFailedBundleHistory,before.apiReaderFailedBundleHistory);
    assert.deepEqual(paper.paidResponseHistory,before.paidResponseHistory);
});

test('只读身份回放预备返回真正生产normalizer，不取图或请求模型，并核旧像素的封存来源', async t => {
    const sample = require('./reader-signed-draft-fixture').fixture();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-replay-preparation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let requests = 0, materializations = 0;
    const prepared = await deep.prepareApiReaderRetryIdentity(sample.paper, '', sample.sourceDetails.text, {
        readerReplayPreparationOnly: true, sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts, readerAttemptsDir: directory,
        readerCallModel: async () => { requests++; assert.fail('只读准备不得调用模型'); },
        readerMaterializeFigures: async () => { materializations++; assert.fail('只读准备不得取图'); }
    });
    assert.equal(prepared.identity.contentMode, 'reader-source-only-v1');
    assert.equal(typeof prepared.normalizeReplayDraft, 'function');
    const evidence = [{ kind: 'figure', ordinal: 1, status: 'ready', sha256: 'c'.repeat(64),
        url: sample.sourceDetails.structuredArtifacts.figures[0].images[0].url }];
    const raw = structuredClone(sample.draft);
    const normalized = prepared.normalizeReplayDraft(raw, [], evidence);
    assert.deepEqual(raw, sample.draft);
    assert.equal(normalized.figurePlacements.length, 1);
    for (const mutate of [value => { value.ordinal = 99; }, value => { value.url = 'https://example.com/unseen.png'; },
        value => { value.sha256 = 'invalid'; }, value => { value.kind = 'supplementary'; }]) {
        const changed = structuredClone(evidence); mutate(changed[0]);
        assert.throws(() => prepared.normalizeReplayDraft(raw, [], changed), /唯一封存原图/);
    }
    assert.deepEqual(prepared.normalizeReplayDraft(raw, [], evidence), normalized);
    assert.equal(requests, 0); assert.equal(materializations, 0);
    assert.deepEqual(fs.readdirSync(directory), [], '只读准备不能保存候选、迁移或新增额度');
});

test('失败Reader事实反馈在真实锁内持久绑定，旧成功正文与无反馈重跑均不能洗掉义务', async t => {
    const sample = await createReviewedReaderSample(t);
    const pending = require('../scripts/lib/pending-fact-feedback');
    const original = structuredClone(sample.paper);
    const parent = facts.validateFeedback(sample.feedback, sample.plan, sample.paper);
    facts.withFactReview(parent, () => undefined);
    const next = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: sample.feedback.readerFeedback + '本次新的Reader纠错，保持所有正确事实。' };
    let requests = 0, checkpoints = 0;
    assert.throws(() => pending.register(sample.paper, sample.plan, next), /论文锁/);
    assert.equal(Object.hasOwn(sample.paper, pending.FIELD), false);
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async paper => {
        requests++;
        assert.equal(facts.current(sample.id).readerOnly, true);
        assert.equal((facts.current(sample.id).readerBound?.proof || facts.current(sample.id).proof).feedbackSha256, facts.proofFor(next).feedbackSha256);
        throw Object.assign(new Error('离线无进展，保留原paid稿'), { retryable: false, code: 'READER_REPAIR_NO_PROGRESS' });
    });
    const invoke = paper => daily.withDailyFreshAnalysisContext(sample.plan, () =>
        engine.withPaperAnalysisLock(paper, () => engine.analyzePaperWithRetry(paper, { maxRetries: 0,
            onCheckpoint: checkpoint => {
                checkpoints++;
                assert.deepEqual(checkpoint[pending.FIELD], facts.proofFor(next));
                assert.equal(requests, 0, '首个请求之前先保存严格义务');
            },
            analyzeFn: current => saved.analyzeWithRecoveredFeedback(current, sample.plan,
                () => assert.fail('不能重新请求主文'), Object.hasOwn(current, pending.FIELD) ? null : next)
        })));
    const failure = await invoke(sample.paper);
    assert.equal(failure.success, false);
    assert.match(failure.error, /离线无进展/);
    assert.ok(checkpoints > 0);
    assert.equal(requests, 1, failure.error);
    const merged = engine.mergePapersById([original], [failure.result], { preserveSuccessfulAnalysis: true })[0];
    assert.equal(merged.analysis, original.analysis);
    assert.equal(merged.apiReaderArticle, original.apiReaderArticle);
    assert.deepEqual(merged.analysisManifest, original.analysisManifest);
    assert.deepEqual(merged[pending.FIELD], facts.proofFor(next));
    assert.equal(engine.isSuccessfulAnalysisRecord(merged), false);
    assert.equal(pending.completed(merged, sample.plan), false);
    const parsedOld = await engine.analyzePaperWithRetry(structuredClone(merged), {
        maxRetries: 0, analyzeFn: async paper => ({ ...paper }) });
    assert.equal(parsedOld.success, false, '无反馈旧正文即使本来完整，不能当本次纠错完成');
    const dropped = await engine.analyzePaperWithRetry(structuredClone(merged), {
        maxRetries: 0, analyzeFn: async paper => {
            const output = { ...paper }; delete output[pending.FIELD]; return output;
        } });
    assert.equal(dropped.success, false, '正常返回省略恢复字段也不能丢失义务');
    assert.deepEqual(dropped.result[pending.FIELD], merged[pending.FIELD]);
    let resumedContext;
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async () => {
        resumedContext = facts.current(sample.id);
        throw Object.assign(new Error('离线恢复边界停止'), { retryable: false });
    });
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(merged,
        () => assert.rejects(saved.analyzeWithRecoveredFeedback(merged, sample.plan,
            () => assert.fail('不能绕过原反馈')), /离线恢复边界停止/)));
    assert.equal((resumedContext.readerBound?.proof || resumedContext.proof).feedbackSha256, facts.proofFor(next).feedbackSha256);
    const forged = structuredClone(merged);
    forged[pending.FIELD].sourceFiles['source.pdf'] = 'a'.repeat(64);
    assert.equal(pending.completed(forged, sample.plan), false);
    assert.equal(engine.isSuccessfulAnalysisRecord(forged), false);
});

test('仅真实同反馈stage完整收尾可清义务，原父约束和错Reader反馈SHA仍阻断', async t => {
    const sample = await createReviewedReaderSample(t);
    const pending = require('../scripts/lib/pending-fact-feedback');
    const next = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: '新的已核验Reader修订要求。' };
    await engine.withPaperAnalysisLock(sample.paper, () => pending.register(sample.paper, sample.plan, next));
    const proof = facts.proofFor(next);
    const corrected = structuredClone(sample.paper);
    Object.assign(corrected.analysisManifest.stages.apiReaderArticle, {
        factReview: proof, reviewFeedbackSha256: facts.sha(next.readerFeedback.trim())
    });
    assert.equal(pending.completed(corrected, sample.plan), true);
    const currentFile = Config.FILES.deepAnalysisResult;
    Config.FILES.deepAnalysisResult = path.join(sample.plan.runDir, 'zero-reconcile.json');
    t.after(() => { Config.FILES.deepAnalysisResult = currentFile; });
    const awaitingNormalization = { ...corrected, latestAnalysisAttemptError: '同反馈完成后仍保留上轮标记' };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: sample.plan.batchDate,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [awaitingNormalization] }));
    const verifiedPlan = daily.requireDailyFreshSourceRecoveryPlan(
        JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)));
    await require('../scripts/batch-analyze').reconcileCompletedFailureMarkers(
        Config.FILES.deepAnalysisResult, verifiedPlan, new Map([[sample.id, next]]));
    const reconciled = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.equal(Object.hasOwn(reconciled, pending.FIELD), false);
    assert.equal(reconciled.latestAnalysisAttemptError, undefined);
    const normalized = engine.mergePapersById([], [corrected])[0];
    assert.equal(Object.hasOwn(normalized, pending.FIELD), false, '同反馈已完成后正常merge规范化清义务');
    const databaseMerged = require('../scripts/digest-status').mergeAnalysisDigestPaper(sample.paper, normalized);
    assert.equal(Object.hasOwn(databaseMerged, pending.FIELD), false, 'papers.json同步不能继承已完成的旧义务');
    const wrong = structuredClone(corrected);
    wrong.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = 'a'.repeat(64);
    assert.equal(pending.completed(wrong, sample.plan), false);
    const returned = await engine.analyzePaperWithRetry({ ...sample.paper, latestAnalysisAttemptError: '上轮失败' }, {
        maxRetries: 0, analyzeFn: async () => corrected });
    assert.equal(returned.success, true, returned.error);
    assert.equal(Object.hasOwn(returned.result, pending.FIELD), false);
    assert.equal(returned.result.latestAnalysisAttemptError, undefined);
    assert.equal(engine.isSuccessfulAnalysisRecord(returned.result), true);
    const stored = path.join(daily.factFeedbackDirectory(sample.plan), proof.feedbackSha256 + '.json');
    fs.unlinkSync(stored);
    assert.equal(pending.completed(corrected, sample.plan), false, '丢失原包不能自声明完成');
});

test('新增事实反馈保存失败保留原Error并以运行级停止，不到模型或下一论文', async t => {
    const sample = await createReviewedReaderSample(t);
    const pending = require('../scripts/lib/pending-fact-feedback');
    const next = { ...sample.feedback, rejectedPrimaryClaims: [], readerFeedback: sample.feedback.readerFeedback + '本次纠错。' };
    const error = Object.assign(new Error('packet disk quota sentinel'), { code: 'EDQUOT' });
    const packetPath = path.join(daily.factFeedbackDirectory(sample.plan), facts.proofFor(next).feedbackSha256 + '.json');
    const originalWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (filename, ...args) => {
        if (filename === packetPath) throw error;
        return originalWrite(filename, ...args);
    });
    await assert.rejects(engine.withPaperAnalysisLock(sample.paper, () => pending.register(sample.paper, sample.plan, next)),
        actual => actual === error && actual.scope === 'run' && actual.retryable === false);
    assert.equal(Object.hasOwn(sample.paper, pending.FIELD), false);
    const calls = [];
    await assert.rejects(engine.analyzeBatch([sample.paper, { arxivId: '2610.90098' }], {
        concurrency: 1, maxRounds: 3, retryDelayMs: 0,
        analyzeFn: paper => { calls.push(paper.arxivId); return pending.register(paper, sample.plan, next); }
    }), actual => actual.scope === 'run' && actual.code === 'EDQUOT');
    assert.deepEqual(calls, [sample.paper.arxivId], '保存异常后不派发下一论文或下一轮');
});

test('旧反馈虽已满足也不能消除更晚失败，必须经正常引擎真实成功返回', async t => {
    const sample = await createReviewedReaderSample(t);
    const bound = facts.validateFeedback(sample.feedback, sample.plan, sample.paper);
    facts.withFactReview(bound, () => undefined);
    assert.equal(engine.isSuccessfulAnalysisRecord(sample.paper), true);
    const failed = { ...sample.paper, latestAnalysisAttemptError: '后一次新反馈没有完成',
        latestAnalysisAttemptErrorCode: 'READER_REPAIR_NO_PROGRESS' };
    assert.equal(engine.isSuccessfulAnalysisRecord(failed), false);
    const normalized = engine.mergePapersById([], [failed])[0];
    assert.equal(normalized.latestAnalysisAttemptError, failed.latestAnalysisAttemptError);
    const result = await engine.analyzePaperWithRetry(failed, {
        maxRetries: 0, analyzeFn: async paper => ({ ...paper }) });
    assert.equal(result.success, true, result.error);
    assert.equal(engine.isSuccessfulAnalysisRecord(result.result), true);
    assert.equal(result.result.latestAnalysisAttemptError, undefined);
});

test('只读Reader完成核验精确重放原父引文组合，不写反馈或借状态授模型请求', async t => {
    const sample = await createReviewedReaderSample(t), paper = sample.paper;
    const parentFeedback = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        coreFeedback: '保留原已纠正摘要的证据边界。', rejectedCoreClaims: ['原摘要错误已消失'],
        readerFeedback: '', rejectedReaderClaims: [], sourceQuotes: [sample.source.text.slice(110, 180)] };
    const parent = facts.validateFeedback(parentFeedback, sample.plan, paper);
    paper.analysisManifest.stages.coreSummaryRepair.factReview = parent.proof;
    facts.withFactReview(parent, () => undefined);
    const childFeedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const child = facts.validateFeedback(childFeedback, sample.plan, paper);
    facts.withFactReview(child, () => undefined);
    delete paper.analysisManifest.stages.apiReaderArticle.factReview;
    await engine.withPaperAnalysisLock(paper, () => facts.withFactReview(parent, () =>
        facts.withReaderFactReview(child, paper, () => {
            Object.assign(paper.analysisManifest.stages.apiReaderArticle, facts.fingerprintFields('apiReaderArticle'));
            paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(facts.reviewFeedback('apiReaderArticle', sample.id));
        })));
    const completed = require('../scripts/lib/completed-bound-fact-feedback');
    const original = JSON.stringify(paper), directory = daily.factFeedbackDirectory(sample.plan);
    const files = fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]);
    t.mock.method(fs, 'writeFileSync', () => assert.fail('只读完成检查不能保存或补建反馈'));
    t.mock.method(fs, 'mkdirSync', () => assert.fail('只读完成检查不能创建目录'));
    assert.equal(completed.hasCompletedBoundFactFeedbackStages(paper, childFeedback, sample.plan), true);
    facts.withReadOnlyReaderCompletion(facts.validateFeedback(childFeedback, sample.plan, paper), paper, () => {
        assert.equal(facts.sha(facts.reviewFeedback('apiReaderArticle', sample.id)), paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256);
        assert.throws(() => facts.assertScoringOnlyModelStageAllowed('apiReaderArticle'), /只读Reader完成核验不允许模型请求/);
    });
    for (const mutate of [
        p => { p.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = '0'.repeat(64); },
        p => { p.apiReaderArticle += childFeedback.rejectedReaderClaims[0]; },
        p => { p.analysisManifest.stages.primaryAnalysis.status = 'pending'; },
        p => { p.analysisManifest.stages.coreSummaryRepair.factReview.feedbackSha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.apiReaderArticle.factReview.sourceFiles['source.txt'] = '0'.repeat(64); }
    ]) {
        const broken = structuredClone(paper); mutate(broken);
        assert.equal(completed.hasCompletedBoundFactFeedbackStages(broken, childFeedback, sample.plan), false);
    }
    const wrongSource = { ...childFeedback, sourceFiles: { ...childFeedback.sourceFiles, 'source.pdf': '0'.repeat(64) } };
    assert.throws(() => completed.hasCompletedBoundFactFeedbackStages(paper, wrongSource, sample.plan), /来源SHA已过期/);
    assert.equal(JSON.stringify(paper), original);
    for (const [name, bytes] of files) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
});

async function createCompletedCoreReaderRenderingSample(t) {
    const sample = await createReviewedReaderSample(t);
    const parent = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        coreFeedback: '保留原已纠正摘要的证据边界。', rejectedCoreClaims: ['原摘要错误已消失'],
        readerFeedback: '', rejectedReaderClaims: [], sourceQuotes: [sample.source.text.slice(110, 180)] };
    const parentBound = facts.validateFeedback(parent, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.coreSummaryRepair.factReview = parentBound.proof;
    facts.withFactReview(parentBound, () => undefined);
    const child = { ...sample.feedback, rejectedPrimaryClaims: [],
        readerFeedback: '原Reader子包的约束。' + sample.feedback.readerFeedback };
    const childBound = facts.validateFeedback(child, sample.plan, sample.paper);
    facts.withFactReview(childBound, () => undefined);
    sample.paper.analysisManifest.stages.apiReaderArticle.factReview = childBound.proof;
    const next = { ...child, readerFeedback: child.readerFeedback + '\n本轮只纠正新增的图示范围。' };
    return { ...sample, parent, parentBound, child, childBound, next };
}

test('核心父包的单调Reader孙包在cold完成核验重放同一指导且不升8000', async t => {
    const sample = await createCompletedCoreReaderRenderingSample(t);
    const child = facts.validateFeedback(sample.next, sample.plan, sample.paper);
    facts.withFactReview(child, () => undefined);
    let live;
    const location = require('../scripts/lib/reader-fact-table-claim-location');
    const originalVerified = location.withVerified;
    const inherited = [];
    t.mock.method(location, 'withVerified', (...args) => {
        if (args[3]?.inheritedObligations) inherited.push(structuredClone(args[3].inheritedObligations));
        return originalVerified(...args);
    });
    await engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.parentBound, () =>
        facts.withReaderFactReview(child, sample.paper, () => {
            live = facts.reviewFeedback('apiReaderArticle', sample.id);
            Object.assign(sample.paper.analysisManifest.stages.apiReaderArticle, facts.fingerprintFields('apiReaderArticle'));
            sample.paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(live);
        })));
    assert.ok(live.includes(sample.parent.coreFeedback));
    const before = JSON.stringify(sample.paper);
    const complete = require('../scripts/lib/completed-bound-fact-feedback');
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(sample.paper, sample.next, sample.plan), true);
    facts.withReadOnlyReaderCompletion(facts.validateFeedback(sample.next, sample.plan, sample.paper), sample.paper, () => {
        assert.equal(facts.reviewFeedback('apiReaderArticle', sample.id), live);
        assert.equal(facts.current().restoredReaderConstraints, undefined);
        assert.throws(() => facts.validateReaderReviewFeedbackLength('字'.repeat(4001), sample.id), /4000/);
        assert.throws(() => facts.assertScoringOnlyModelStageAllowed('apiReaderArticle'), /只读Reader/);
    });
    assert.ok(inherited.length >= 3);
    for (const observation of inherited) {
        assert.deepEqual(observation[0].proof, sample.parentBound.proof);
        for (const claim of sample.parent.rejectedCoreClaims) assert.ok(observation[0].claims.includes(claim));
    }
    assert.equal(JSON.stringify(sample.paper), before);
    for (const mutate of [
        p => { p.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(live + '字'); },
        p => { p.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(sample.parent.coreFeedback); },
        p => { p.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.coreSummaryRepair.factReview.sourceFiles['source.txt'] = '0'.repeat(64); },
        p => { p.analysisManifest.stages.scoringAudit.status = 'pending'; },
        p => { p.analysisManifest.stages.apiReaderArticle.restoredReaderConstraints = { maximumRenderedChars: 8000 }; }
    ]) {
        const bad = structuredClone(sample.paper); mutate(bad);
        assert.equal(complete.hasCompletedBoundFactFeedbackStages(bad, sample.next, sample.plan), false);
    }
    const parentFile = path.join(daily.factFeedbackDirectory(sample.plan), sample.parentBound.proof.feedbackSha256 + '.json');
    const bytes = fs.readFileSync(parentFile);
    fs.unlinkSync(parentFile);
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(sample.paper, sample.next, sample.plan), false);
    fs.writeFileSync(parentFile, bytes, { mode: 0o600 });
    const alteredParent = { ...sample.parent, coreFeedback: sample.parent.coreFeedback + '字' };
    fs.writeFileSync(parentFile, JSON.stringify(alteredParent), { mode: 0o600 });
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(sample.paper, sample.next, sample.plan), false);
    fs.writeFileSync(parentFile, bytes, { mode: 0o600 });
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(sample.paper, sample.next, sample.plan), true);
    const badSource = { ...sample.next, sourceFiles: { ...sample.next.sourceFiles, 'source.pdf': '0'.repeat(64) } };
    assert.throws(() => complete.hasCompletedBoundFactFeedbackStages(sample.paper, badSource, sample.plan), /来源SHA已过期/);
    for (const changed of [
        { ...sample.next, readerFeedback: sample.next.readerFeedback + '字' },
        { ...sample.next, sourceQuotes: [sample.source.text.slice(200, 260)] },
        { ...sample.next, coreFeedback: '还要修改核心摘要。', rejectedCoreClaims: ['不属于Reader的核心义务'] }
    ]) {
        const changedBound = facts.validateFeedback(changed, sample.plan, sample.paper);
        facts.withFactReview(changedBound, () => undefined);
        const bad = structuredClone(sample.paper);
        bad.analysisManifest.stages.apiReaderArticle.factReview = changedBound.proof;
        assert.equal(complete.hasCompletedBoundFactFeedbackStages(bad, changed, sample.plan), false);
    }
    // The packet itself is within its existing 4k shape limit, while adding
    // the genuine core-parent directive/quote makes the complete rendering too
    // long. A copied 8k field cannot upgrade this new, non-restoring path.
    const oversized = { ...sample.next, readerFeedback: sample.next.readerFeedback
        + '字'.repeat(3800 - sample.next.readerFeedback.length) };
    const oversizedBound = facts.validateFeedback(oversized, sample.plan, sample.paper);
    facts.withFactReview(oversizedBound, () => undefined);
    const oversizedRendering = live.replace(sample.next.readerFeedback, oversized.readerFeedback);
    assert.ok(oversizedRendering.length > 4000);
    const oversizedPaper = structuredClone(sample.paper);
    oversizedPaper.analysisManifest.stages.apiReaderArticle.factReview = oversizedBound.proof;
    oversizedPaper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(oversizedRendering);
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(oversizedPaper, oversized, sample.plan), false);
    oversizedPaper.analysisManifest.stages.apiReaderArticle.restoredReaderConstraints = { maximumRenderedChars: 8000 };
    assert.equal(complete.hasCompletedBoundFactFeedbackStages(oversizedPaper, oversized, sample.plan), false);
});

test('核心父包的首次Reader子包继续接受无core指导及原raw反馈SHA', async t => {
    const sample = await createCompletedCoreReaderRenderingSample(t);
    let original;
    await engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(sample.parentBound, () =>
        facts.withReaderFactReview(sample.childBound, sample.paper, () => {
            original = facts.reviewFeedback('apiReaderArticle', sample.id);
            Object.assign(sample.paper.analysisManifest.stages.apiReaderArticle, facts.fingerprintFields('apiReaderArticle'));
        })));
    assert.ok(!original.includes(sample.parent.coreFeedback));
    const complete = require('../scripts/lib/completed-bound-fact-feedback');
    for (const originalHash of [facts.sha(original), facts.sha(sample.child.readerFeedback.trim())]) {
        sample.paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = originalHash;
        assert.equal(complete.hasCompletedBoundFactFeedbackStages(sample.paper, sample.child, sample.plan), true);
        facts.withReadOnlyReaderCompletion(facts.validateFeedback(sample.child, sample.plan, sample.paper), sample.paper, () => {
            assert.equal(facts.reviewFeedback('apiReaderArticle', sample.id), original);
            assert.equal(facts.current().restoredReaderConstraints, undefined);
        });
    }
});

test('旧Reader上游fallback拒绝非Reader检查点保存并在错误路径完整恢复内存', async t => {
    const sample = await createReviewedReaderSample(t), paper = sample.paper;
    const feedback = { ...sample.feedback, rejectedPrimaryClaims: [] };
    const bound = facts.validateFeedback(feedback, sample.plan, paper);
    facts.withFactReview(bound, () => undefined);
    paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    paper.analysisManifest.stages.scoringAudit.status = 'failed';
    let persists = 0;
    const checkpoint = Symbol.for('audio-paper-digest.analysisCheckpointCallback');
    Object.defineProperty(paper, checkpoint, { configurable: true, value: () => { persists++; } });
    const before = JSON.stringify(paper), callback = paper[checkpoint];
    for (const passOriginalCheckpoint of [false, true]) {
        await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(paper, () =>
            saved.analyzeWithRecoveredFeedback(paper, sample.plan, () => {
                const originalCheckpoint = structuredClone(paper);
                delete paper.analysisManifest.stages.primaryAnalysis;
                delete paper.analysisManifest.stages.coreSummaryRepair;
                paper.analysisCheckpoint = '';
                paper[checkpoint](passOriginalCheckpoint ? originalCheckpoint : paper);
            }, feedback))), { code: 'READER_UPSTREAM_PROTECTION_REJECTED' });
        assert.equal(persists, 0);
        assert.equal(JSON.stringify(paper), before);
        assert.equal(paper[checkpoint], callback);
    }
    delete paper.analysisCheckpoint;
    delete paper.analysisStageCheckpoints.primaryAnalysis;
    const noCheckpoint = JSON.stringify(paper);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(paper, () =>
        saved.analyzeWithRecoveredFeedback(paper, sample.plan, () => assert.fail('空主检查点不得进入会失效或保存的分析入口'), feedback))),
    { code: 'READER_UPSTREAM_PRIMARY_NOT_REUSABLE' });
    assert.equal(JSON.stringify(paper), noCheckpoint);
    assert.equal(persists, 0);
});

test('typed核心父与Reader子只从已核子包派生单句local种子，保留父证明与费用', async t => {
    const sample = await createDualReaderCorrectionSample(t, 'coreSummaryRepair');
    const claim = '当前结果已经证明所有未知领域都能取得相同的测量数值。';
    sample.paper.apiReaderArticle = sample.paper.apiReaderArticle.replace(/(### [^\n]+\n\n)/, '$1' + claim + '\n\n');
    require('./reader-signed-draft-fixture').sign(sample.paper);
    const next = { ...sample.next, rejectedReaderClaims: [...sample.next.rejectedReaderClaims, claim] };
    const child = facts.validateFeedback(next, sample.plan, sample.paper);
    const before = structuredClone(sample.paper);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        facts.withFactReview(sample.parentBound, () => facts.withReaderFactReview(child, sample.paper, async () => {
            const active = facts.current(sample.id), feedback = facts.reviewFeedback('apiReaderArticle', sample.id);
            assert.equal(active.feedback.coreFeedback, sample.parent.coreFeedback);
            assert.equal(active.feedback.readerFeedback, '');
            assert.deepEqual(active.readerBound.proof, child.proof);
            assert.equal(deep.hasReviewedReaderFactLocalSeed(sample.paper, sample.source.text, feedback), true);
            const seed = deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text, feedback, { readerFactLocalRevision: true });
            const start = deep.buildApiReaderGenerationStart(sample.paper, { reviewFeedback: feedback,
                sourceText: sample.source.text, initialDraft: seed.initialDraft, revisionSeed: seed, readerFactLocalRevision: true });
            assert.equal(start.readerFactLocalPaths.length, 1);
            const repair = require('../scripts/lib/reader-repair');
            assert.equal(repair.assertReaderFactLocalCoverage(start.signedRecoveryDraft, next.rejectedReaderClaims)
                .filter(issue => issue.claim === claim).length, 1);
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit'])
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed(stage));
            assert.throws(() => deep.buildApiReaderGenerationStart(sample.paper, { reviewFeedback: '另一份未核子包',
                sourceText: sample.source.text, initialDraft: seed.initialDraft, revisionSeed: seed, readerFactLocalRevision: true }), /事实局部修订/);
            const issues = repair.verifiedReaderFactIssues(start.signedRecoveryDraft, next.rejectedReaderClaims);
            const targets = repair.buildRepairTargets(start.signedRecoveryDraft, issues, { readerFactLocalPaths: start.readerFactLocalPaths });
            let requests = 0;
            const generated = await deep.generateApiReaderArticleDetailed(sample.paper, sample.paper.analysis, '合成测试的封存证据', {
                sourceText: sample.source.text, structuredArtifacts: sample.source.structuredArtifacts,
                reviewFeedback: feedback, revisionSeed: seed, initialDraft: seed.initialDraft, readerFactLocalRevision: true,
                readerRecordDisposition: async () => {},
                readerCallModel: async (_messages, tokens, request) => {
                    requests++;
                    assert.equal(request.usageContext.stage, 'apiReaderRepair');
                    assert.equal(request.usageContext.contentAttempt, 1, '新真实反馈input如实从局部1开始，旧scope计数未重写');
                    assert.ok(tokens <= 16000);
                    return JSON.stringify({ version: 1, draftSha256: repair.hashDraft(start.signedRecoveryDraft),
                        sentenceReplacements: repair.factLocalSentenceTargets({ draftSha256: repair.hashDraft(start.signedRecoveryDraft), targets })
                            .map(({ originalSentence, ...identity }) => ({ ...identity,
                                value: '原文只报告当前受控协议下的测量结果，未知领域是否成立仍需要另行验证。' })) });
                }
            });
            assert.equal(requests, 1);
            assert.equal(generated.attempts, 1); assert.equal(generated.fullAttempts, 0);
            assert.ok(!generated.article.includes(claim));
        }))));
    assert.deepEqual(sample.paper, before);
    const broken = structuredClone(sample.paper); broken.analysisManifest.stages.coreSummaryRepair.factReview.sourceFiles['source.pdf'] = '0'.repeat(64);
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(broken, () =>
        saved.analyzeWithRecoveredFeedback(broken, sample.plan, () => assert.fail('不得修改上游'), next,
            { readerFactLocalRevision: true }))), /纠错说明|证明|来源/);
});

test('公共saved Reader单句local透传不取source-only资源束且表内拒绝句仍不能授权', async t => {
    const sample = await createDualReaderCorrectionSample(t, 'coreSummaryRepair');
    const claim = '当前实验数值已经证明所有未知领域都具有同样的统计表现。';
    sample.paper.apiReaderArticle = sample.paper.apiReaderArticle.replace(/(### [^\n]+\n\n)/, '$1' + claim + '\n\n');
    require('./reader-signed-draft-fixture').sign(sample.paper);
    const next = { ...sample.next, rejectedReaderClaims: [...sample.next.rejectedReaderClaims, claim] };
    const original = structuredClone(sample.paper);
    let refreshes = 0;
    t.mock.method(require('../scripts/lib/reader-failed-bundle-resource-replay'), 'prepareRecoveryReaderResources',
        () => assert.fail('已签local不得借source-only资源恢复进入新全文'));
    t.mock.method(deep, 'refreshApiReaderArticleFromSource', async (paper, source, options) => {
        refreshes++;
        assert.equal(options.readerFactLocalRevision, true);
        assert.equal(Object.hasOwn(options, 'resumeSavedSourceReader'), false);
        assert.equal(Object.hasOwn(options, 'recoveryReaderResources'), false);
        const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, options.reviewFeedback, options);
        const start = deep.buildApiReaderGenerationStart(paper, { ...options, sourceText: source.text,
            initialDraft: seed.initialDraft, revisionSeed: seed });
        assert.equal(start.readerFactLocalPaths.length, 1);
        const tableClaim = '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |';
        assert.throws(() => require('../scripts/lib/reader-repair').assertReaderFactLocalCoverage(
            start.signedRecoveryDraft, [tableClaim]), /未获准位置/);
        return paper;
    });
    await daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () =>
        saved.analyzeWithRecoveredFeedback(sample.paper, sample.plan, () => assert.fail('不得进入主文'), next,
            { readerFactLocalRevision: true })));
    assert.equal(refreshes, 1);
    assert.deepEqual(sample.paper.analysisManifest.stages.coreSummaryRepair, original.analysisManifest.stages.coreSummaryRepair);
    assert.deepEqual(sample.paper.analysisManifest.stages.scoringAudit, original.analysisManifest.stages.scoringAudit);
    assert.deepEqual(sample.paper.llmUsage, original.llmUsage);
    assert.equal(sample.paper.analysisManifest.stages.apiReaderArticle.contentAttempts, 5);
    assert.equal(sample.paper.analysisManifest.stages.apiReaderArticle.fullAttempts, 2);
    assert.deepEqual(sample.paper.analysisFactReviewObligation, facts.proofFor(next));
    const unsigned = structuredClone(original); unsigned.apiReaderArticle += '未签名的额外正文';
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(unsigned, () =>
        saved.analyzeWithRecoveredFeedback(unsigned, sample.plan, () => assert.fail('不得source-only兜底'), next,
            { readerFactLocalRevision: true }))), /当前已核完整签名稿/);
    assert.equal(refreshes, 1, '无真实签名seed在资源恢复和刷新前拒绝');
});

test('日更source封装显式透传单句local布尔值，不改变主文与核心评分', async t => {
    const sample = await createDualReaderCorrectionSample(t, 'coreSummaryRepair');
    const before = structuredClone(sample.paper); let calls = 0;
    assert.throws(() => daily.createDailyAnalyzeFn(sample.plan, { readerFactLocalRevision: 'yes' }), /布尔值/);
    for (const enabled of [false, true]) await daily.withDailyFreshAnalysisContext(sample.plan, () =>
        daily.createDailyAnalyzeFn(sample.plan, { readerFactLocalRevision: enabled, analyze: async (paper, options) => {
            calls++; assert.equal(options.readerFactLocalRevision, enabled); return paper;
        } })(sample.paper));
    assert.equal(calls, 2);
    assert.equal(sample.paper.analysis, before.analysis);
    assert.deepEqual(sample.paper.analysisManifest.stages.coreSummaryRepair, before.analysisManifest.stages.coreSummaryRepair);
    assert.deepEqual(sample.paper.analysisManifest.stages.scoringAudit, before.analysisManifest.stages.scoringAudit);
});
