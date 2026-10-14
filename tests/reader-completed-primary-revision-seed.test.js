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

async function createReviewedReaderSample(t, options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reviewed-reader-seed-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const signed = require('./reader-signed-draft-fixture').fixture({ ...options, noFigures: true });
    const id = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'reader-seed',
        papers: [{ arxivId: signed.paper.arxivId, title: '正文已纠正的修订参考', authors: signed.paper.authors }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
        sourceApi.captureFreshArxivRewriteSource(options, {
            fetchText: async sourceId => ({ ...signed.sourceDetails, source: 'html',
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [], sourceId,
                url: `https://arxiv.org/html/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' }),
            fetchPdf: async sourceId => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' })
        }) });
    const paper = { ...validAnalysisPaper(signed.paper.arxivId), ...signed.paper };
    const validManifest = validAnalysisPaper(signed.paper.arxivId).analysisManifest;
    paper.analysisManifest.contracts = { ...validManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...validManifest.stages, ...paper.analysisManifest.stages };
    // signed Reader样本只保存资源绑定；正常上游须另外已有资源扫描终态。
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.stages.scoringAudit.scoringContract = 'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.auditSha256 = deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(paper.analysis);
    paper.latestAnalysisAttemptError = failure;
    paper.digestStatus = { latestAttemptStatus: 'analysis_failed' };
    const source = daily.readDailyFreshSource(plan, paper);
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
    await daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
        () => facts.withFactReview(bound, () => {
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit'])
                deep.markRecoveryStage(paper.analysisManifest, stage, 'complete', {
                    ...paper.analysisManifest.stages[stage], ...facts.fingerprintFields(stage, paper.analysisManifest.stages[stage])
                });
        })));
    return { paper, plan, source, feedback, bound, id };
}

test('同一已核验反馈的正确主文可引用当前真实 Reader，不造快照或清失败记录', async t => {
    const sample = await createReviewedReaderSample(t);
    const before = JSON.stringify(sample.paper);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => daily.withDailyFreshPaperSource(sample.plan, sample.paper,
        () => facts.withFactReview(sample.bound, () => {
            assert.equal(engine.hasValidApiReaderV3Records(sample.paper), true);
            const seed = deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text, sample.feedback.readerFeedback);
            assert.equal(seed.metadata.revisionSeedStageRecovery, 'reviewed-completed-primary-reader-stage-v1');
            assert.equal(seed.metadata.revisionSeedArticleSha256, sample.paper.apiReaderArticleSha256);
            assert.equal(seed.metadata.revisionSeedPlanSha256, sample.paper.apiReaderPlanSha256);
            assert.equal(sample.paper.analysisStaleSnapshots, undefined);
            assert.equal(sample.paper.latestAnalysisAttemptError, failure);
            assert.equal(engine.isSuccessfulAnalysisRecord(sample.paper), false);
        })));
    assert.equal(JSON.stringify(sample.paper), before);
});

test('不同反馈、来源、评分或普通失败一律不借此恢复 Reader 修订参考', async t => {
    const sample = await createReviewedReaderSample(t);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => daily.withDailyFreshPaperSource(sample.plan, sample.paper,
        () => facts.withFactReview(sample.bound, () => {
            for (const alter of [
                paper => { paper.latestAnalysisAttemptError = '普通网络失败'; },
                paper => { paper.analysisManifest.stages.primaryAnalysis.factReview = { ...sample.bound.proof, feedbackSha256: 'a'.repeat(64) }; },
                paper => { paper.analysisManifest.stages.primaryAnalysis.status = 'pending'; },
                paper => { delete paper.analysisManifest.stages.openSourceScan.status; },
                paper => { paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = 'b'.repeat(64); },
                paper => { paper.analysisManifest.stages.scoringAudit.auditSha256 = 'c'.repeat(64); },
                paper => { paper.sourceSha256 = 'd'.repeat(64); },
                paper => { paper.apiReaderArticle += '未记录的修改'; }
            ]) {
                const changed = structuredClone(sample.paper);
                alter(changed);
                const before = JSON.stringify(changed);
                assert.throws(() => deep.prepareApiReaderRevisionSeed(changed, sample.source.text, sample.feedback.readerFeedback), /定向修订需要完整/);
                assert.equal(JSON.stringify(changed), before);
            }
            assert.throws(() => deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text, '另一个未授权反馈'), /定向修订需要完整/);
            assert.throws(() => deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text + '改变', sample.feedback.readerFeedback), /定向修订需要完整|来源 SHA/);
        })));
    assert.throws(() => deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text, sample.feedback.readerFeedback), /定向修订需要完整/);
});


test('主文反馈fallback必须绑定现有Reader同证明与准确反馈SHA', async t => {
    const sample = await createReviewedReaderSample(t);
    sample.feedback.readerFeedback = '';
    sample.feedback.rejectedReaderClaims = [];
    sample.bound = facts.validateFeedback(sample.feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.primaryAnalysis.factReview = sample.bound.proof;
    await daily.withDailyFreshAnalysisContext(sample.plan, () => daily.withDailyFreshPaperSource(sample.plan, sample.paper,
        () => facts.withFactReview(sample.bound, () => {
            const feedback = facts.reviewFeedback('apiReaderArticle', sample.id);
            deep.markRecoveryStage(sample.paper.analysisManifest, 'scoringAudit', 'complete', {
                ...sample.paper.analysisManifest.stages.scoringAudit,
                ...facts.fingerprintFields('scoringAudit', sample.paper.analysisManifest.stages.scoringAudit)
            });
            const stage = sample.paper.analysisManifest.stages.apiReaderArticle;
            stage.factReview = sample.bound.proof;
            stage.reviewFeedbackSha256 = facts.sha(feedback.trim());
            const before = JSON.stringify(sample.paper);
            const seed = deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text, feedback);
            assert.equal(seed.metadata.revisionSeedStageRecovery, 'reviewed-completed-primary-reader-stage-v1');
            assert.equal(JSON.stringify(sample.paper), before);
            for (const alter of [
                paper => { paper.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256 = 'a'.repeat(64); },
                paper => { paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = 'b'.repeat(64); },
                paper => { delete paper.analysisManifest.stages.apiReaderArticle.factReview; }
            ]) {
                const changed = structuredClone(sample.paper);
                alter(changed);
                assert.throws(() => deep.prepareApiReaderRevisionSeed(changed, sample.source.text, feedback), /定向修订需要完整/);
            }
        })));
});


test('独立评分上下文不能借主文fallback申请Reader修订', async t => {
    const sample = await createReviewedReaderSample(t);
    const scoringFeedback = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        readerFeedback: '', rejectedReaderClaims: [], scoringFeedback: '只核验现有评分。',
        rejectedScoringClaims: ['已拒绝的旧评分结论'] };
    const scoringBound = facts.validateFeedback(scoringFeedback, sample.plan, sample.paper);
    await daily.withDailyFreshAnalysisContext(sample.plan, () => daily.withDailyFreshPaperSource(sample.plan, sample.paper,
        () => facts.withScoringFactReviews(scoringBound, sample.bound, sample.paper, () => {
            assert.throws(() => deep.prepareApiReaderRevisionSeed(sample.paper, sample.source.text,
                sample.feedback.readerFeedback), /定向修订需要完整/);
        })));
});

test('已完成主文的 Reader 单独修订通过公共入口两次资格核验，预检不调用模型或保存', async t => {
    const sample = await createReviewedReaderSample(t);
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-public-entry-'));
    const previous = Config.FILES.deepAnalysisResult;
    Config.FILES.deepAnalysisResult = path.join(directory, 'analysis.json');
    t.after(() => {
        Config.FILES.deepAnalysisResult = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const payload = { batchDate: sample.plan.batchDate,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [sample.paper] };
    const bytes = JSON.stringify(payload);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, bytes);
    const refresh = require('../scripts/refresh-api-reader');
    let calls = 0;
    await assert.rejects(facts.withFactReview(sample.bound, () => refresh.refreshApiReader(sample.id, {
        reviewFeedback: sample.feedback.readerFeedback,
        operations: { article: async (paper, source) => {
            calls += 1;
            const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, sample.feedback.readerFeedback);
            assert.equal(seed.metadata.revisionSeedStageRecovery, 'reviewed-completed-primary-reader-stage-v1');
            assert.deepEqual(paper.analysisManifest.stages, sample.paper.analysisManifest.stages);
            throw new Error('只读公共入口预检完成');
        } },
    })), /只读公共入口预检完成/);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(Config.FILES.deepAnalysisResult, 'utf8'), bytes);
});

test('公共单独修订资格拒绝普通失败、坏证明、其他模式、错反馈和无事实作用域', async t => {
    const sample = await createReviewedReaderSample(t);
    const refresh = require('../scripts/refresh-api-reader');
    const options = { reviewFeedback: sample.feedback.readerFeedback };
    await facts.withFactReview(sample.bound, () => {
        assert.equal(refresh.canRepairCompletedPrimaryReader(sample.paper, sample.plan, options), true);
        for (const alter of [
            paper => { paper.latestAnalysisAttemptError = '普通网络失败'; },
            paper => { paper.analysisManifest.stages.primaryAnalysis.factReview.feedbackSha256 = 'a'.repeat(64); },
            paper => { paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = 'b'.repeat(64); },
            paper => { paper.apiReaderArticle += '未记录的变更'; },
        ]) {
            const changed = structuredClone(sample.paper);
            alter(changed);
            assert.equal(refresh.canRepairCompletedPrimaryReader(changed, sample.plan, options), false);
        }
        for (const mode of ['authorsOnly', 'figuresOnly', 'surfaceBindingsOnly', 'scoringAndReader']) {
            assert.equal(refresh.canRepairCompletedPrimaryReader(sample.paper, sample.plan, { ...options, [mode]: true }), false);
        }
        assert.equal(refresh.canRepairCompletedPrimaryReader(sample.paper, sample.plan, { reviewFeedback: '其他未授权反馈' }), false);
        assert.equal(refresh.canRepairCompletedPrimaryReader(sample.paper, sample.plan, {}), false);
    });
    assert.equal(refresh.canRepairCompletedPrimaryReader(sample.paper, sample.plan, options), false);
});
