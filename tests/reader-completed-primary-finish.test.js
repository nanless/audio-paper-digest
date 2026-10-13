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

const failure =
    '局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';

async function createReviewedReaderSample(t) {
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
        ],
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: (options) =>
            sourceApi.captureFreshArxivRewriteSource(options, {
                fetchText: async (sourceId) => ({
                    ...signed.sourceDetails,
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
    paper.latestAnalysisAttemptError = failure;
    paper.digestStatus = { latestAttemptStatus: 'analysis_failed' };
    const source = daily.readDailyFreshSource(plan, paper);
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
        rejectedPrimaryClaims: ['原来的错误已消失'],
        rejectedCoreClaims: [],
        rejectedReaderClaims: ['已纠正的旧Reader错误'],
        sourceQuotes: [source.text.slice(0, 100)],
    };
    const bound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
    paper.analysisManifest.stages.scoringAudit.factReview = bound.proof;
    return { paper, plan, source, feedback, bound, id };
}

function successfulRefreshSample(sample) {
    sample.paper.analysisManifest.version = 1;
    sample.paper.analysisManifest.stages.openSourceScan.status = 'complete';
    sample.paper.latestAnalysisAttemptAt = '2026-10-11T00:00:00.000Z';
    const updated = structuredClone(sample.paper);
    updated.analysisManifest.stages.apiReaderArticle.factReview = sample.bound.proof;
    updated.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 =
        facts.sha(sample.feedback.readerFeedback);
    updated.analysisManifest.stages.apiReaderArticle.refreshedAt =
        '2026-10-12T00:00:00.000Z';
    return updated;
}

test('同反馈主文已完成且全内容有效时，公共收尾归档原失败并保主文和付费阶段', async (t) => {
    const sample = await createReviewedReaderSample(t);
    const updated = successfulRefreshSample(sample);
    const before = JSON.stringify(updated);
    const refresh = require('../scripts/refresh-api-reader');
    const reason = engine.getIncompleteAnalysisContentReason(updated);
    assert.equal(reason, null);
    facts.withFactReview(sample.bound, () => {
        const result = refresh.finishReviewedPrimaryReaderRefresh(
            sample.paper,
            updated,
            sample.plan,
            { reviewFeedback: sample.feedback.readerFeedback },
        );
        assert.equal(engine.isSuccessfulAnalysisRecord(result), true);
        assert.equal(result.latestAnalysisAttemptError, undefined);
        assert.equal(
            result.readerCompletedPrimaryRecoveryHistory[0].failure
                .latestAnalysisAttemptError,
            failure,
        );
        assert.equal(result.analysis, sample.paper.analysis);
        assert.deepEqual(
            result.analysisManifest.stages,
            updated.analysisManifest.stages,
        );
        assert.equal(JSON.stringify(updated), before);
    });
});

test('公共收尾拒一般失败、未完成正文、坏Reader、变化的其他阶段和残留错误原句', async (t) => {
    const sample = await createReviewedReaderSample(t);
    const updated = successfulRefreshSample(sample);
    const refresh = require('../scripts/refresh-api-reader');
    facts.withFactReview(sample.bound, () => {
        for (const alter of [
            (paper) => {
                paper.analysis = '不完整正文';
            },
            (paper) => {
                paper.parsed = { score: '10.0' };
            },
            (paper) => {
                paper.analysisCheckpoint = '新进度';
            },
            (paper) => {
                paper.latestAnalysisAttemptAt = '2026-10-11T01:00:00.000Z';
            },
            (paper) => {
                paper.digestStatus.error = '不同失败';
            },
            (paper) => {
                paper.error = '不同错误';
            },
            (paper) => {
                paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 =
                    'c'.repeat(64);
            },
            (paper) => {
                paper.apiReaderArticle += '已纠正的旧Reader错误';
            },
            (paper) => {
                paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 =
                    'a'.repeat(64);
            },
            (paper) => {
                paper.analysisManifest.stages.apiReaderArticle.articleSha256 =
                    'b'.repeat(64);
            },
            (paper) => {
                paper.analysisManifest.stages.apiReaderArticle.refreshedAt =
                    '2026-10-10T00:00:00.000Z';
            },
        ]) {
            const changed = structuredClone(updated);
            alter(changed);
            const before = JSON.stringify(changed);
            assert.throws(() =>
                refresh.finishReviewedPrimaryReaderRefresh(
                    sample.paper,
                    changed,
                    sample.plan,
                    { reviewFeedback: sample.feedback.readerFeedback },
                ),
            );
            assert.equal(JSON.stringify(changed), before);
        }
        const ordinary = structuredClone(sample.paper);
        ordinary.latestAnalysisAttemptError = '普通网络失败';
        assert.throws(() =>
            refresh.finishReviewedPrimaryReaderRefresh(
                ordinary,
                updated,
                sample.plan,
                { reviewFeedback: sample.feedback.readerFeedback },
            ),
        );
    });
});
