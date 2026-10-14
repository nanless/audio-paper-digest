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
    return { paper, plan, source, feedback, bound, id };
}

const preflight = require('../scripts/lib/reader-parent-upstream-preflight');
const { installCurrentParentFingerprints } = require('./helpers/normal-reader-parent-fingerprints');
async function scoped(sample, callback) {
    return daily.withDailyFreshAnalysisContext(sample.plan, () => engine.withPaperAnalysisLock(sample.paper, () => fresh.withFreshPaperContext(sample.paper, callback)));
}
test('正常封存来源与真实current阶段指纹通过只读父预检，原论文和来源字节不变', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const before = JSON.stringify({ paper: f.paper, source: f.source });
        const result = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.equal(result.current, true, JSON.stringify(result));
        assert.deepEqual(result.invalidatedStages, []);
        assert.equal(JSON.stringify({ paper: f.paper, source: f.source }), before);
    });
});
test('上游status仍complete但openSource真实fingerprint变时要求normal父恢复，不改正式稿', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        f.paper.analysisManifest.stages.openSourceScan.fingerprint = '0'.repeat(64);
        const before = JSON.stringify(f.paper);
        const result = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.equal(result.current, false);
        assert.ok(result.invalidatedStages.includes('openSourceScan'));
        assert.equal(JSON.stringify(f.paper), before);
    });
});
test('primary或demo真实指纹失效同样拒绝protectedview，缺source/锁/错源硬拒', async t => {
    const f = await createReviewedReaderSample(t);
    assert.throws(() => preflight.inspectSavedReaderParentUpstream(f.paper, f.source), /当前日更论文锁/);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const baseline = structuredClone(f.paper);
        for (const stage of ['primaryAnalysis', 'demoLinkScan']) {
            f.paper.analysisManifest = structuredClone(baseline.analysisManifest);
            f.paper.analysisManifest.stages[stage].fingerprint = '0'.repeat(64);
            const result = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
            assert.equal(result.current, false);
            assert.ok(result.invalidatedStages.includes(stage));
        }
        assert.throws(() => preflight.inspectSavedReaderParentUpstream(f.paper, { ...f.source, text: f.source.text + 'forged' }), /封存来源/);
    });
});

test('七个正常文本阶段任一真实指纹变化均拒绝protectedview，原status仍terminal', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const baseline = structuredClone(f.paper);
        for (const stage of preflight.TEXT_STAGES) {
            Object.assign(f.paper, structuredClone(baseline));
            const physical = stage === 'tagSelection' ? require('../scripts/lib/tag-stage-record')
                .readTagStageRecord(f.paper.analysisManifest, f.paper.analysisStageCheckpoints).stageKey : stage;
            f.paper.analysisManifest.stages[physical].fingerprint = '0'.repeat(64);
            const before = JSON.stringify(f.paper);
            const result = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
            assert.equal(result.current, false, stage);
            assert.ok(result.invalidatedStages.includes(stage), stage);
            assert.equal(JSON.stringify(f.paper), before);
        }
    });
});

test('真实原上游无fact的ordinary scope可复用，不能误用祖先primary反馈判current', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const packet = { ...f.feedback, readerFeedback: '', rejectedReaderClaims: [],
            primaryFeedback: '保留封存原文明确的数字，不扩大到Reader。', rejectedPrimaryClaims: ['不存在的旧错误原句'] };
        const bound = facts.validateFeedback(packet, f.plan, f.paper);
        const ordinary = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.equal(ordinary.current, true);
        facts.withFactReview(bound, () => {
            const parent = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
            assert.equal(parent.current, false);
            assert.equal(parent.prerequisiteCurrent, false);
            assert.notEqual(parent.proof.upstreamFactReviewSha256, ordinary.proof.upstreamFactReviewSha256);
        });
    });
});

test('成功只读预检凭证不可伪造、篡改或跨上游checkpoint复用，失败报告不授权', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const result = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.deepEqual(preflight.assertSavedReaderParentUpstream(result, f.paper, f.source), result.proof);
        assert.deepEqual(preflight.assertSavedReaderParentUpstream(result, structuredClone(f.paper), f.source), result.proof);
        const changedFee = structuredClone(f.paper); changedFee.paidResponseHistory = [{ totalTokens: 0 }];
        assert.throws(() => preflight.assertSavedReaderParentUpstream(result, changedFee, f.source), /凭证/);
        const changedParsed = structuredClone(f.paper); changedParsed.parsed = { ...changedParsed.parsed, score: 0 };
        assert.throws(() => preflight.assertSavedReaderParentUpstream(result, changedParsed, f.source), /凭证/);
        assert.throws(() => preflight.assertSavedReaderParentUpstream(structuredClone(result), f.paper, f.source), /凭证/);
        const original = f.paper.analysisStageCheckpoints.openSourceScan;
        f.paper.analysisStageCheckpoints.openSourceScan += 'changed';
        assert.throws(() => preflight.assertSavedReaderParentUpstream(result, f.paper, f.source), /凭证/);
        f.paper.analysisStageCheckpoints.openSourceScan = original;
        result.proof.inspectedStages[0].fingerprint = '0'.repeat(64);
        assert.throws(() => preflight.assertSavedReaderParentUpstream(result, f.paper, f.source), /凭证/);
        f.paper.analysisManifest.stages.openSourceScan.fingerprint = '0'.repeat(64);
        const failed = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.equal(failed.current, false);
        assert.throws(() => preflight.assertSavedReaderParentUpstream(failed, f.paper, f.source), /凭证/);
    });
});

test('ordinary上游成功凭证进入已验证Reader子scope后保留null真实scope，不误比祖先proof', async t => {
    const f = await createReviewedReaderSample(t);
    await scoped(f, () => {
        installCurrentParentFingerprints(f.paper, f.source);
        const handle = preflight.inspectSavedReaderParentUpstream(f.paper, f.source);
        const ancestor = facts.validateFeedback({ ...f.feedback, readerFeedback: '', rejectedReaderClaims: [],
            primaryFeedback: '保留已纠正的主文证据。', rejectedPrimaryClaims: ['不存在的旧错误原句'] }, f.plan, f.paper);
        const child = facts.validateFeedback({ ...f.feedback, rejectedPrimaryClaims: [] }, f.plan, f.paper);
        f.paper.analysisManifest.stages.apiReaderArticle.factReview = child.proof;
        facts.withFactReview(ancestor, () => facts.withReaderFactReview(child, f.paper, () => {
            assert.equal(facts.current(f.id).readerOnly, true);
            assert.notEqual(require('../scripts/lib/reader-repair').hashDraft(facts.current(f.id).proof), handle.proof.upstreamFactReviewSha256);
            assert.deepEqual(preflight.assertSavedReaderParentUpstream(handle, f.paper, f.source), handle.proof);
        }));
    });
});
