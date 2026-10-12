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

async function createReaderFactSample(t) {
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
    return { paper, plan, source, feedback, bound, id };
}

async function createLocalSample(t) {
    const sample = await createReaderFactSample(t);
    sample.paper.analysisManifest.version = 1;
    sample.paper.analysisManifest.stages.openSourceScan.status = 'complete';
    sample.paper.latestAnalysisAttemptAt = '2026-10-11T00:00:00.000Z';
    sample.paper.latestAnalysisAttemptErrorCode = 'CONTRACT_REJECTED';
    delete sample.feedback.primaryFeedback;
    delete sample.feedback.rejectedPrimaryClaims;
    sample.feedback.readerFeedback =
        '只纠正错误完整原句；原文没有报告闭源模型计算成本。';
    sample.feedback.rejectedReaderClaims = [
        '此时端到端 Gemini 3.5 是开销可核算的起点。',
    ];
    sample.paper.apiReaderArticle = sample.paper.apiReaderArticle.replace(
        /(### [^\n]+\n\n)/,
        '$1' + sample.feedback.rejectedReaderClaims[0] + '\n\n',
    );
    require('./reader-signed-draft-fixture').sign(sample.paper);
    sample.bound = facts.validateFeedback(
        sample.feedback,
        sample.plan,
        sample.paper,
    );
    return sample;
}

test('完整主文的旧失败允许真实Reader-only反馈派生局部seed而不改原proof', async (t) => {
    const sample = await createLocalSample(t);
    const before = JSON.stringify(sample.paper);
    facts.withFactReview(sample.bound, () => {
        const feedback = facts.reviewFeedback('apiReaderArticle', sample.id);
        assert.equal(
            engine.getIncompleteAnalysisContentReason(sample.paper),
            null,
        );
        assert.equal(
            deep.hasReviewedReaderFactLocalSeed(
                sample.paper,
                sample.source.text,
                feedback,
            ),
            true,
        );
        const seed = deep.prepareApiReaderRevisionSeed(
            sample.paper,
            sample.source.text,
            feedback,
            { readerFactLocalRevision: true },
        );
        const start = deep.buildApiReaderGenerationStart(sample.paper, {
            reviewFeedback: feedback,
            sourceText: sample.source.text,
            initialDraft: seed.initialDraft,
            revisionSeed: seed,
            readerFactLocalRevision: true,
        });
        assert.equal(start.readerFactLocalPaths.length, 1);
        assert.equal(JSON.stringify(sample.paper), before);
        assert.throws(
            () =>
                deep.buildApiReaderGenerationStart(sample.paper, {
                    reviewFeedback: '另一份未核验反馈',
                    sourceText: sample.source.text,
                    initialDraft: seed.initialDraft,
                    revisionSeed: seed,
                    readerFactLocalRevision: true,
                }),
            /事实局部修订|定向修订需要完整/,
        );
    });
});

test('完整主文局部资格拒真实主文、评分、来源损坏及未签Reader', async (t) => {
    const sample = await createLocalSample(t);
    facts.withFactReview(sample.bound, () => {
        const feedback = facts.reviewFeedback('apiReaderArticle', sample.id);
        for (const alter of [
            (paper) => {
                paper.analysis = '坏主文';
            },
            (paper) => {
                paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 =
                    'f'.repeat(64);
            },
            (paper) => {
                paper.sourceSha256 = 'f'.repeat(64);
            },
            (paper) => {
                paper.apiReaderArticle += '未签变化';
            },
            (paper) => {
                paper.latestAnalysisAttemptError = '主分析请求失败';
            },
            (paper) => {
                paper.latestAnalysisAttemptErrorCode = 'MODEL_REQUEST_TIMEOUT';
            },
            (paper) => {
                paper.latestAnalysisAttemptError = '官方来源文件无法读取';
            },
            (paper) => {
                paper.latestAnalysisAttemptError = '其他协议拒绝';
            },
        ]) {
            const changed = structuredClone(sample.paper);
            alter(changed);
            assert.equal(
                deep.hasReviewedReaderFactLocalSeed(
                    changed,
                    sample.source.text,
                    feedback,
                ),
                false,
            );
        }
    });
});

test('正常生成器只发一次有界正文补丁，不发全文并记真实局部次数', async (t) => {
    const sample = await createLocalSample(t);
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'reader-fact-generator-'),
    );
    const previousRuntime = Config.FILES.runtimeDir;
    Config.FILES.runtimeDir = root;
    t.after(() => {
        Config.FILES.runtimeDir = previousRuntime;
        fs.rmSync(root, { recursive: true, force: true });
    });
    await facts.withFactReview(sample.bound, async () => {
        const repair = require('../scripts/lib/reader-repair');
        const feedback = facts.reviewFeedback('apiReaderArticle', sample.id);
        const seed = deep.prepareApiReaderRevisionSeed(
            sample.paper,
            sample.source.text,
            feedback,
            { readerFactLocalRevision: true },
        );
        const options = {
            sourceText: sample.source.text,
            structuredArtifacts: sample.source.structuredArtifacts,
            reviewFeedback: feedback,
            revisionSeed: seed,
            initialDraft: seed.initialDraft,
            readerFactLocalRevision: true,
        };
        const start = deep.buildApiReaderGenerationStart(sample.paper, options);
        const draft = start.signedRecoveryDraft;
        const issues = repair.verifiedReaderFactIssues(
            draft,
            sample.feedback.rejectedReaderClaims,
        );
        const targets = repair.buildRepairTargets(draft, issues, {
            readerFactLocalPaths: start.readerFactLocalPaths,
        });
        let calls = 0;
        const result = await deep.generateApiReaderArticleDetailed(
            sample.paper,
            sample.paper.analysis,
            '封存证据',
            {
                ...options,
                readerCallModel: async (_messages, tokens, request) => {
                    calls++;
                    assert.ok(tokens <= 16000);
                    assert.equal(request.usageContext.stage, 'apiReaderRepair');
                    return JSON.stringify({
                        version: 1,
                        draftSha256: repair.hashDraft(draft),
                        replacements: targets.map((target) => ({
                            path: target.path,
                            oldSha256: target.oldSha256,
                            value: target.value.replace(
                                sample.feedback.rejectedReaderClaims[0],
                                '论文未报告该闭源模型的计算成本，因此不能据此核算开销。',
                            ),
                        })),
                    });
                },
                readerRecordDisposition: async () => {},
            },
        );
        assert.equal(calls, 1);
        assert.equal(result.fullAttempts, 0);
        assert.equal(result.attempts, 1);
        assert.ok(
            !result.article.includes(sample.feedback.rejectedReaderClaims[0]),
        );
    });
});

test('真实公共入口在新Reader纠正后才归档旧失败，主文及原proof不变', async (t) => {
    const sample = await createLocalSample(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-fact-public-'));
    const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir'];
    const previous = Object.fromEntries(
        keys.map((key) => [key, Config.FILES[key]]),
    );
    t.after(() => {
        Object.assign(Config.FILES, previous);
        fs.rmSync(root, { recursive: true, force: true });
    });
    Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
    Config.FILES.papers = path.join(root, 'papers.json');
    Config.FILES.papersLegacy = path.join(root, 'legacy.json');
    Config.FILES.runtimeDir = path.join(root, 'runtime');
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
    fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
    const writeInput = (paper) =>
        fs.writeFileSync(
            Config.FILES.deepAnalysisResult,
            JSON.stringify({
                batchDate: sample.plan.batchDate,
                dailyFreshSourceRun: daily.dailyFreshSourceReference(
                    sample.plan,
                ),
                papers: [paper],
            }),
        );
    const publicRefresh =
        require('../scripts/refresh-api-reader').refreshApiReader;
    for (const alter of [
        (paper) => {
            paper.analysis = '真实主文失败';
        },
        (paper) => {
            paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 =
                'f'.repeat(64);
        },
        (paper) => {
            paper.sourceSha256 = 'f'.repeat(64);
        },
        (paper) => {
            paper.apiReaderArticle += '未签稿';
        },
        (paper) => {
            paper.latestAnalysisAttemptError = '主分析请求失败';
        },
        (paper) => {
            paper.latestAnalysisAttemptErrorCode = 'MODEL_REQUEST_TIMEOUT';
        },
        (paper) => {
            paper.latestAnalysisAttemptError = '官方来源文件无法读取';
        },
        (paper) => {
            paper.latestAnalysisAttemptError = '其他协议拒绝';
        },
    ]) {
        const changed = structuredClone(sample.paper);
        alter(changed);
        writeInput(changed);
        let reached = false;
        await facts.withFactReview(sample.bound, () =>
            assert.rejects(
                publicRefresh(sample.id, {
                    readerFactLocalRevision: true,
                    reviewFeedback: facts.reviewFeedback(
                        'apiReaderArticle',
                        sample.id,
                    ),
                    operations: {
                        article: async () => {
                            reached = true;
                            throw new Error('不应调用');
                        },
                    },
                }),
            ),
        );
        assert.equal(reached, false);
    }
    writeInput(sample.paper);
    const mixed = facts.validateFeedback(
        {
            ...sample.feedback,
            coreFeedback: '同时改核心',
            rejectedCoreClaims: ['旧核心错误完整原句'],
        },
        sample.plan,
        sample.paper,
    );
    await facts.withFactReview(mixed, () =>
        assert.rejects(
            publicRefresh(sample.id, {
                readerFactLocalRevision: true,
                reviewFeedback: facts.reviewFeedback(
                    'apiReaderArticle',
                    sample.id,
                ),
                operations: {
                    article: async () => {
                        throw new Error('不应调用');
                    },
                },
            }),
            /不满足/,
        ),
    );
    let calls = 0;
    const originalMainProof = structuredClone(
        sample.paper.analysisManifest.stages.primaryAnalysis.factReview,
    );
    const correctedPaper = (paper, feedback) => {
        const updated = structuredClone(paper);
        updated.apiReaderArticle = updated.apiReaderArticle.replace(
            sample.feedback.rejectedReaderClaims[0],
            '论文未报告该闭源模型的计算成本，因此不能据此核算开销。',
        );
        require('./reader-signed-draft-fixture').sign(updated);
        const stage = updated.analysisManifest.stages.apiReaderArticle;
        stage.reviewFeedbackSha256 = facts.sha(feedback.trim());
        stage.factReview = sample.bound.proof;
        stage.refreshedAt = '2026-10-12T00:00:00.000Z';
        return updated;
    };
    for (const alter of [
        (paper) => {
            delete paper.analysisManifest.stages.apiReaderArticle.factReview;
        },
        (paper) => {
            paper.latestAnalysisAttemptAt = '2026-10-11T00:01:00.000Z';
        },
    ]) {
        writeInput(sample.paper);
        const before = fs.readFileSync(Config.FILES.deepAnalysisResult);
        await facts.withFactReview(sample.bound, () =>
            assert.rejects(
                publicRefresh(sample.id, {
                    readerFactLocalRevision: true,
                    reviewFeedback: facts.reviewFeedback(
                        'apiReaderArticle',
                        sample.id,
                    ),
                    operations: {
                        article: async (paper, _source, options) => {
                            const updated = correctedPaper(
                                paper,
                                options.reviewFeedback,
                            );
                            alter(updated);
                            return updated;
                        },
                    },
                }),
                /原失败身份|反馈身份/,
            ),
        );
        assert.deepEqual(
            fs.readFileSync(Config.FILES.deepAnalysisResult),
            before,
        );
    }
    writeInput(sample.paper);
    await facts.withFactReview(sample.bound, () =>
        publicRefresh(sample.id, {
            readerFactLocalRevision: true,
            reviewFeedback: facts.reviewFeedback('apiReaderArticle', sample.id),
            operations: {
                article: async (paper, source, options) => {
                    calls++;
                    assert.equal(options.readerFactLocalRevision, true);
                    assert.equal(source.text, sample.source.text);
                    return correctedPaper(paper, options.reviewFeedback);
                },
            },
        }),
    );
    assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult))
        .papers[0];
    assert.equal(engine.isSuccessfulAnalysisRecord(saved), true);
    assert.equal(saved.analysis, sample.paper.analysis);
    assert.deepEqual(
        saved.analysisManifest.stages.primaryAnalysis.factReview,
        originalMainProof,
    );
    assert.deepEqual(
        saved.analysisManifest.stages.apiReaderArticle.factReview,
        sample.bound.proof,
    );
    assert.equal(
        saved.readerCompletedPrimaryRecoveryHistory.at(-1).mode,
        'signed-reader-fact-local-repair-v1',
    );
    assert.equal(
        saved.readerCompletedPrimaryRecoveryHistory.at(-1).failure
            .latestAnalysisAttemptError,
        sample.paper.latestAnalysisAttemptError,
    );
});
