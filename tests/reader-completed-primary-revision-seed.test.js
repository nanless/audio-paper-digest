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
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
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
    paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
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
