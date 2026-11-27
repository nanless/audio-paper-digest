'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const scoring = require('../scripts/lib/scoring-audit-contract.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const editorial = require('../scripts/editorial-quality.js');
const readerRecordFormat = require('../scripts/lib/reader-record-format.js');
const repair = require('../scripts/lib/reader-repair.js');
const retry = require('../scripts/lib/explicit-reader-retry-round.js');
const parentRecovery = require('../scripts/lib/reader-parent-recovery.js');
const readerRetryNew = require('../scripts/reader-retry-new.js');
const factFeedbackNew = require('../scripts/fact-feedback-new.js');
const batch = require('../scripts/batch-analyze.js');
const deep = require('../scripts/deep-analyzer.js');
const engine = require('../scripts/analysis-engine.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const factReview = require('../scripts/lib/daily-fact-review.js');
const protocolCodec = require('../scripts/lib/protocol-codec.js');
const podcastPublisher = require('../scripts/publish-daily-podcast.js');
const podcastRelease = require('../scripts/lib/podcast-github-release.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function mkTempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function makeScoringPayload(overrides = {}) {
    const header = scoringFormat.currentEvidenceProfileHeader();
    return {
        documentType: overrides.documentType || '方法研究',
        confidence: '高',
        evidenceProfile: {
            ...header,
            multiComponentClaimed: false,
            ablationStatus: 'not_applicable',
            targetEvaluation: 'public',
            sampleScaleReported: true,
            deploymentMeasured: false,
            publicGeneralizationEvaluated: true,
            engineeringEvidence: 'reusable_pipeline',
            evidenceBoundary: '[A_RESULTS] 论文覆盖公开基准，但跨语种与噪声鲁棒性仍待验证。',
            evidenceIds: ['A_METHOD', 'A_RESULTS', 'A_OPEN'],
            primaryStrengths: ['[A_METHOD] 提出了清晰的音频多目标融合机制。'],
            primaryDefects: ['[A_RESULTS] 在跨风格与英文子集上仍存在明显差距。']
        },
        dimensions: {
            innovation: { reason: overrides.innovationReason || '[A_METHOD] 提出面向语音合成的新型在策略蒸馏框架。', score: 7.5 },
            technicalRigor: { reason: overrides.rigorReason || '[A_METHOD] 梯度冲突投影推导自洽，实验控制清晰。', score: 7.5 },
            experimentalSufficiency: { reason: overrides.expReason || '[A_RESULTS] 公开基准对比完整，覆盖单目标专家与消融对照。', score: 7.5 },
            clarity: { reason: '[A_SUMMARY] 章节组织清晰紧凑，图表符号一致。', score: 7.2 },
            impact: { reason: overrides.impactReason || '[A_SUMMARY] 对多目标指令跟随语音合成具备实践参考价值。', score: 7.4 },
            openSource: { reason: '[A_OPEN] 未提供可验证开源链接，按未开源计分。', score: 0.0 },
            reproducibility: { reason: '[A_METHOD] 披露核心训练配置、路由比例与评测协议。', score: 7.0 },
            engineering: { reason: '[A_METHOD] 给出可复用软件训练流程，但缺少端到端推理延迟实测。', score: 6.5 }
        }
    };
}

async function createSealedSignedSample(t, opts = {}) {
    const root = mkTempDir(t, 'r35-sealed-');
    const prevFiles = Object.fromEntries(
        ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers'].map(k => [k, Config.FILES[k]])
    );
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'current', 'deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root, 'current', 'filtered-papers.json');
    Config.FILES.papers = path.join(root, 'current', 'papers.json');
    t.after(() => Object.assign(Config.FILES, prevFiles));

    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const paperId = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-27',
        batchId: 'r35-sample',
        papers: [{ arxivId: signed.paper.arxivId, title: 'R35 Test Paper', authors: signed.paper.authors }]
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: captureOpts => sourceApi.captureFreshArxivRewriteSource(captureOpts, {
            fetchText: async sourceId => ({
                ...signed.sourceDetails,
                source: 'html',
                htmlAvailability: 'available',
                htmlAttempts: 1,
                warnings: [],
                sourceId,
                url: `https://arxiv.org/html/${sourceId}`,
                fetchedAt: '2026-11-27T00:00:00.000Z'
            }),
            fetchPdf: async sourceId => ({
                bytes: Buffer.from(`%PDF-1.7\n${sourceId}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${sourceId}.pdf`,
                fetchedAt: '2026-11-27T00:00:01.000Z'
            })
        })
    });
    const paper = {
        ...validAnalysisPaper(signed.paper.arxivId, {}, signed.paper.analysis),
        ...signed.paper
    };
    const validManifest = validAnalysisPaper(signed.paper.arxivId, {}, signed.paper.analysis).analysisManifest;
    paper.analysisManifest.version = 1;
    paper.analysisManifest.contracts = { ...validManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...validManifest.stages, ...paper.analysisManifest.stages };
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.stages.taxonomySeal = validManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = validManifest.stages.coreSummaryRepair;
    paper.analysisManifest.stages.structureRepair = validManifest.stages.structureRepair;
    delete paper.analysisManifest.stages.tagSelection;
    for (const key of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[key] = validManifest.stages.scoringAudit[key];
    }
    paper.analysisManifest.contracts.taxonomy = validManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = validManifest.contracts.coreSummary;
    paper.analysisManifest.stages.scoringAudit.scoringContract = 'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.auditSha256 = deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = factReview.sha(paper.analysis);

    const claim = opts.claim || '此时端到端 Gemini 3.5 是开销可核算的起点。';
    paper.apiReaderArticle = paper.apiReaderArticle.replace(/(### [^\n]+\n\n)/, `$1${claim}\n\n`);
    require('./reader-signed-draft-fixture.js').sign(paper);

    const source = daily.readDailyFreshSource(plan, paper);
    await daily.withDailyFreshAnalysisContext(plan, () =>
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source)
    );
    const sourceDir = path.join(plan.sourcesDir, paperId, 'generation-000001');
    const sourceFiles = Object.fromEntries(
        ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, factReview.sha(fs.readFileSync(path.join(sourceDir, name)))])
    );
    const feedback = {
        contract: factReview.CONTRACT,
        paperId,
        runId: plan.runId,
        batchDate: plan.batchDate,
        sourceFiles,
        coreAnalysisSha256: factReview.sha(paper.analysis),
        coreSummarySha256: factReview.sha(deep.extractSectionByTitle(paper.analysis, '核心摘要')),
        coreFeedback: '',
        readerFeedback: '只纠正错误完整原句；原文没有报告闭源模型计算成本。',
        rejectedCoreClaims: [],
        rejectedReaderClaims: [claim],
        sourceQuotes: [source.text.slice(0, 100)]
    };
    return { root, plan, paper, source, sourceFiles, feedback, paperId, claim };
}

// =========================================================================
// [P0-1] scoring-audit-contract.js: comparison subject vs ownership guard
// =========================================================================
describe('R35 P0-1: scoring-audit-contract comparison subject vs self-closed-source ownership guard', () => {
    const ALLOWED = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);

    it('allows all 6 benign subject-leads-comparison sentences against closed-source baselines, 将/把/以 baseline methodology, and 对比专有发布', () => {
        const benignReasons = [
            '[A_RESULTS] 本文优于闭源模型，在 LibriSpeech 上取得 SOTA。',
            '[A_RESULTS] 本文与闭源模型相比存在差距。',
            '[A_RESULTS] 本文与闭源 GPT-4o 相比存在明显差距。',
            '[A_RESULTS] 本文落后于闭源水平。',
            '[A_RESULTS] 本研究超过闭源 API。',
            '[A_RESULTS] 本工作对标闭源商业系统。',
            '[A_RESULTS] 本文把闭源模型作为基准进行对比评测。',
            '[A_RESULTS] 作者将闭源商业系统作为基准进行盲测比较。',
            '[A_RESULTS] 本文把闭源系统作为基线进行评测。',
            '[A_RESULTS] 作者将闭源 API 作为对比对象进行盲测。',
            '[A_RESULTS] 本文以闭源商业系统作为参考进行对比评测。',
            '[A_RESULTS] 本文对比专有发布的商业 API，指标领先。'
        ];
        for (const reason of benignReasons) {
            assert.doesNotThrow(
                () => scoring.parseScoringAuditResult(
                    JSON.stringify(makeScoringPayload({ expReason: reason, impactReason: reason })),
                    ALLOWED
                ),
                `Benign comparison must pass: ${reason}`
            );
        }
    });

    it('still blocks genuine proprietary-release / self-closed-source violations (including 以/用/将/把 symmetry)', () => {
        const forbiddenReasons = [
            '[A_RESULTS] 本文低于闭源商业系统并维持专有发布，行业影响力受限。',
            '[A_RESULTS] 本文低于闭源商业系统并维持专有发布',
            '[A_RESULTS] 本文低于专有发布的商业 API 并维持专有发布。',
            '[A_RESULTS] 本文保持专有发布模式，难以形成广泛开源生态。',
            '[A_RESULTS] 本文限制公开访问，行业影响力受限。',
            '[A_RESULTS] 本文的闭源模型相比基线存在差距，难以独立复现。',
            '[A_RESULTS] 作者将闭源模型作为核心发布，社区采纳受限。',
            '[A_RESULTS] 作者将闭源模型与开源基线相比存在差距，社区传播受限。',
            '[A_RESULTS] 本文以闭源模型与开源系统相比存在差距，社区采纳受限。',
            '[A_RESULTS] 本论文用闭源模型与开源基线对比，影响受限。',
            '[A_RESULTS] 作者将闭源模型与开源系统相比存在差距，社区采纳受限。',
            '[A_RESULTS] 本文把闭源系统作为基准并限制公开访问，行业影响力受限。'
        ];
        for (const reason of forbiddenReasons) {
            assert.throws(
                () => scoring.parseScoringAuditResult(
                    JSON.stringify(makeScoringPayload({ impactReason: reason })),
                    ALLOWED
                ),
                /其他维度的扣分事实/,
                `Genuine violation must be rejected: ${reason}`
            );
        }
    });
});

// =========================================================================
// [P0-2] editorial-quality.js: same-sentence inline metric-unit exemptions
// =========================================================================
describe('R35 P0-2: editorial-quality same-sentence inline metric-unit declaration vs %-suffixed table', () => {
    const STRUCTURED = readerRecordFormat.STRUCTURED_EDITORIAL;
    const pctTable = [
        '### 主实验结果',
        '',
        '| 方法 | WER |',
        '| --- | --- |',
        '| Baseline | 5.2% |',
        '| Ours | 3.1% |'
    ].join('\n');

    it('exempts same-sentence explicit inline unit declarations even next to a %-suffixed table', () => {
        const inlineForms = [
            `${pctTable}\n\n在 LibriSpeech 上，WER（%）从 5.2 降至 3.1。`,
            `${pctTable}\n\n在 LibriSpeech 上，WER(%) 从 5.2 降至 3.1。`,
            `${pctTable}\n\n在 LibriSpeech 上，WER（单位为%）从 5.2 降至 3.1。`,
            `${pctTable}\n\n在 LibriSpeech 上，WER 单位为 %，结果从 5.2 降至 3.1。`,
            `${pctTable}\n\n在 100% 干净语音条件下，WER（%）从 5.2 降至 3.1。`
        ];
        for (const doc of inlineForms) {
            assert.deepEqual(editorial.findMissingComparisonUnits(doc), [], `Default profile should pass: ${doc}`);
            assert.deepEqual(
                editorial.findMissingComparisonUnits(doc, { editorialProfile: STRUCTURED }),
                [],
                `Structured profile should pass: ${doc}`
            );
        }
    });

    it('still catches bare values without inline unit, earlier-sentence declarations, bare-scale prose, and undeclared sibling metrics next to %-suffixed tables', () => {
        const bareWithoutInline = `${pctTable}\n\n在 LibriSpeech 上，WER 从 5.2 降至 3.1。`;
        assert.equal(editorial.findMissingComparisonUnits(bareWithoutInline, { editorialProfile: STRUCTURED }).length, 1);

        const earlierSentenceDecl = `${pctTable}\n\n本节使用 WER（%）衡量识别误差。\n\n在 LibriSpeech 上，WER 从 5.2 降至 3.1。`;
        assert.equal(editorial.findMissingComparisonUnits(earlierSentenceDecl, { editorialProfile: STRUCTURED }).length, 1);

        const bareScaleSentence = '在 LibriSpeech 上，WER 以百分制裸数报告：WER 从 5.2 降至 3.1。';
        assert.deepEqual(
            editorial.findMissingComparisonUnits(bareScaleSentence, { editorialProfile: STRUCTURED }),
            [],
            'Without a %-suffixed table, bare-scale prose declaration should exempt WER'
        );
        const bareScaleProse = `${pctTable}\n\n${bareScaleSentence}`;
        assert.equal(
            editorial.findMissingComparisonUnits(bareScaleProse, { editorialProfile: STRUCTURED }).length,
            1,
            'With a %-suffixed table in the same section, bare-scale prose MUST NOT override %'
        );

        const mixedDualMetric = [
            '### 主实验结果',
            '',
            '| 方法 | WER | CER |',
            '| --- | --- | --- |',
            '| Baseline | 5.2% | 4.2% |',
            '| Ours | 3.1% | 2.1% |',
            '',
            '在 LibriSpeech 上，WER（%）从 5.2 降至 3.1，而 CER 从 4.2 降至 2.1。'
        ].join('\n');
        assert.equal(editorial.findMissingComparisonUnits(mixedDualMetric, { editorialProfile: STRUCTURED }).length, 1);
    });

    it('R35-Rev P0-1: inline unit declaration on later metric never exempts earlier sibling metric across commas/digits (with or without table)', () => {
        const dualPctTable = [
            '### 主实验结果',
            '',
            '| 方法 | WER | CER |',
            '| --- | --- | --- |',
            '| Baseline | 5.2% | 4.0% |',
            '| Ours | 3.1% | 2.0% |'
        ].join('\n');
        const repros = [
            `${dualPctTable}\n\nCER 从 4.0 降至 2.0，WER（单位为%）从 5.2 降至 3.1。`,
            `${dualPctTable}\n\nCER 从 4.0 降至 2.0，而 WER 单位为 % 从 5.2 降至 3.1。`,
            'CER 从 4.0 降至 2.0，WER（单位为%）从 5.2 降至 3.1。',
            'CER 从 4.0 降至 2.0，而 WER 单位为 % 从 5.2 降至 3.1。'
        ];
        for (const doc of repros) {
            assert.equal(editorial.findMissingComparisonUnits(doc).length, 1, `Default profile must flag CER: ${doc}`);
            assert.equal(
                editorial.findMissingComparisonUnits(doc, { editorialProfile: STRUCTURED }).length,
                1,
                `Structured profile must flag CER: ${doc}`
            );
        }

        const directPositiveControls = [
            `${dualPctTable}\n\nWER（单位为%）从 5.2 降至 3.1。`,
            `${dualPctTable}\n\nWER 单位为 %，从 5.2 降至 3.1。`,
            'WER（单位为%）从 5.2 降至 3.1。',
            'WER 单位为 %，从 5.2 降至 3.1。'
        ];
        for (const doc of directPositiveControls) {
            assert.deepEqual(editorial.findMissingComparisonUnits(doc), [], `Direct inline unit must pass: ${doc}`);
            assert.deepEqual(
                editorial.findMissingComparisonUnits(doc, { editorialProfile: STRUCTURED }),
                [],
                `Structured direct inline unit must pass: ${doc}`
            );
        }
    });

    it('R35-Rev L2257 companion: allows mixed sentence combining inline-declared %-table metric and bare-table metric', () => {
        const mixedScaleTable = [
            '### 主实验结果',
            '',
            '| 方法 | WER | CER |',
            '| --- | --- | --- |',
            '| Baseline | 5.2% | 4.0 |',
            '| Ours | 3.1% | 2.0 |'
        ].join('\n');
        const validMixed = `${mixedScaleTable}\n\nWER（%）从 5.2 降至 3.1，CER 从 4.0 降至 2.0。`;
        assert.deepEqual(editorial.findMissingComparisonUnits(validMixed), []);
        assert.deepEqual(
            editorial.findMissingComparisonUnits(validMixed, { editorialProfile: STRUCTURED }),
            []
        );

        const ungroundedCer = `${mixedScaleTable}\n\nWER（%）从 5.2 降至 3.1，CER 从 5.0 降至 2.5。`;
        assert.equal(
            editorial.findMissingComparisonUnits(ungroundedCer, { editorialProfile: STRUCTURED }).length,
            1,
            'Ungrounded CER numbers not in the bare table must still be flagged'
        );
    });
});

// =========================================================================
// [P0-3 + P2-2] reader-retry-new.js: active-candidate proof & explicit --budget guard
// =========================================================================
describe('R35 P0-3 & P2-2: reader-retry-new active-candidate proof after migration and parent-recovery --budget rejection', () => {
    it('P0-3: binds base retry grant directly to active migrated candidate so beginExplicitRound succeeds after post-migration attempts', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, source, paperId } = sample;

        paper.analysisCheckpoint = paper.analysis;
        delete paper.analysis;
        paper.analysisManifest.stages.apiReaderArticle.status = 'failed';
        paper.latestAnalysisAttemptError = 'Reader exhausted';
        paper.latestAnalysisAttemptErrorCode = 'READER_REPAIR_ATTEMPTS_EXHAUSTED';
        paper.latestAnalysisAttemptErrorCategory = 'reader_recovery';
        paper.latestAnalysisAttemptErrorScope = 'paper';
        paper.latestAnalysisAttemptRetryable = false;

        fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
            batchDate: plan.batchDate,
            batchId: plan.batchId,
            status: 'failed',
            dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
            papers: [paper]
        }), { mode: 0o600 });

        const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));
        const oldIdentity = {
            paperId: paper.arxivId,
            maxAttempts: 6,
            freshAnalysis: sourceIdentity,
            sourceSha256: paper.sourceSha256,
            inputFingerprint: sha(source.text),
            parserImplementationSha256: '1'.repeat(64)
        };
        const currentIdentity = {
            ...oldIdentity,
            parserImplementationSha256: '2'.repeat(64)
        };

        // Write archived pre-migration envelope with attempts=1, fullAttempts=1
        fs.mkdirSync(plan.readerAttemptsDir, { recursive: true });
        const oldPayload = {
            status: 'failed', draft: null, rawDraft: '',
            issues: [{ path: null, message: 'pre-migration failure' }],
            attempts: 1, fullAttempts: 1, noProgress: 0,
            failureSignature: '', validationFailureSignature: '',
            validationFailureStreak: 0, transportFailures: 0,
            implementationRepairAllowanceProof: null
        };
        repair.saveFailedCandidate(plan.readerAttemptsDir, oldIdentity, oldPayload);
        const oldActivePath = path.join(plan.readerAttemptsDir, `${repair.hashDraft(oldIdentity)}.json`);
        const archivedName = `${repair.hashDraft(oldIdentity)}.migrated-${crypto.randomUUID()}.json`;
        const archivedPath = path.join(plan.readerAttemptsDir, archivedName);
        fs.renameSync(oldActivePath, archivedPath);
        const oldEnvelopeBytes = fs.readFileSync(archivedPath);

        // Now save active migrated candidate with post-migration attempts=6, fullAttempts=2!
        const currentPayload = {
            status: 'failed', draft: null, rawDraft: '',
            issues: [{ path: null, message: 'post-migration exhausted' }],
            attempts: 6, fullAttempts: 2, noProgress: 1,
            failureSignature: '', validationFailureSignature: '',
            validationFailureStreak: 1, transportFailures: 0,
            implementationRepairAllowanceProof: null,
            readerRecoveryRevisions: [{
                archivedName,
                fromIdentitySha256: repair.hashDraft(oldIdentity),
                toIdentitySha256: repair.hashDraft(currentIdentity),
                oldEnvelopeSha256: sha(oldEnvelopeBytes),
                oldPayloadSha256: repair.hashDraft(oldPayload)
            }]
        };
        repair.saveFailedCandidate(plan.readerAttemptsDir, currentIdentity, currentPayload);
        const currentEnvelopePath = path.join(plan.readerAttemptsDir, `${repair.hashDraft(currentIdentity)}.json`);
        const currentEnvelopeSha = sha(fs.readFileSync(currentEnvelopePath));

        const { manifest } = readerRetryNew.buildRetryManifest({
            papers: [paperId],
            mode: 'auto',
            budget: 320000
        });
        assert.equal(manifest.rounds.length, 1);
        const grant = manifest.rounds[0];
        const expectedIdentitySha = repair.hashDraft(currentIdentity);
        assert.equal(grant.identitySha256, expectedIdentitySha);
        assert.equal(grant.originalIdentitySha256, expectedIdentitySha, 'Must bind to active candidate, NOT stale audits[0]');
        assert.equal(grant.envelopeSha256, currentEnvelopeSha);
        assert.equal(grant.payloadSha256, repair.hashDraft(currentPayload));

        // End-to-end verification: beginExplicitRound MUST succeed with this grant!
        const started = await daily.withDailyFreshAnalysisContext(plan, () =>
            daily.withDailyFreshPaperSource(plan, paper, () =>
                engine.withPaperAnalysisLock(paper, () =>
                    retry.withExplicitRound(paper, grant, () =>
                        retry.beginExplicitRound(plan.readerAttemptsDir, currentIdentity, currentPayload, paper)
                    )
                )
            )
        );
        assert.equal(started.explicitReaderRetryRound.roundId, grant.roundId);
    });

    it('P2-2: rejects explicit --budget when generating a parent-recovery child grant, while allowing omitted --budget', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, source, sourceFiles, paperId } = sample;

        paper.analysisCheckpoint = paper.analysis;
        delete paper.analysis;
        paper.analysisManifest.stages.apiReaderArticle.status = 'failed';
        fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
            batchDate: plan.batchDate,
            batchId: plan.batchId,
            status: 'failed',
            dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
            papers: [paper]
        }), { mode: 0o600 });

        const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));
        const identity = {
            paperId: paper.arxivId, maxAttempts: 6, freshAnalysis: sourceIdentity,
            sourceSha256: paper.sourceSha256, inputFingerprint: sha(source.text)
        };
        const completeDraft = {
            ...protocolCodec.recordHeader(protocolCodec.contract('reader-draft'), 'reader-draft'),
            readerTitle: '完整父失败稿用于验证子轮预算守卫',
            oneSentenceThesis: '一句话概述完整父失败稿的验证目标。',
            conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [],
            sections: [
                { kind: 'problem', heading: '问题背景', body: '背景内容。' },
                { kind: 'method_overview', heading: '方法框架', body: '方法内容。' },
                { kind: 'component', heading: '关键组件', body: '组件内容。' },
                { kind: 'result', heading: '实验结果', body: '结果内容。' },
                { kind: 'limitation', heading: '局限性', body: '局限内容。' }
            ]
        };
        const initialExhausted = {
            status: 'failed',
            draft: completeDraft,
            rawDraft: JSON.stringify(completeDraft),
            issues: [{ path: '/sections/0/body', message: 'initial exhausted issue' }],
            attempts: 6, fullAttempts: 2, noProgress: 0,
            failureSignature: repair.hashRecoveryIssues([{ path: '/sections/0/body', message: 'initial exhausted issue' }]),
            validationFailureSignature: repair.validationFailureSignature([{ path: '/sections/0/body', message: 'initial exhausted issue' }]),
            validationFailureStreak: 1, transportFailures: 0,
            implementationRepairAllowanceProof: null
        };
        fs.mkdirSync(plan.readerAttemptsDir, { recursive: true, mode: 0o700 });
        repair.saveFailedCandidate(plan.readerAttemptsDir, identity, initialExhausted);
        const initialEnvelopePath = path.join(plan.readerAttemptsDir, `${repair.hashDraft(identity)}.json`);
        const parentRoundId = crypto.randomUUID();
        const baseGrant = {
            ...protocolCodec.recordHeader(retry.CONTRACT, retry.CONTRACT),
            batchDate: plan.batchDate, runId: plan.runId, paperId, roundId: parentRoundId,
            originalIdentitySha256: repair.hashDraft(identity),
            identitySha256: repair.hashDraft(identity),
            envelopeSha256: sha(fs.readFileSync(initialEnvelopePath)),
            payloadSha256: repair.hashDraft(initialExhausted),
            wholeSha256: sha(paper.analysisCheckpoint),
            sourceFiles,
            maxResponses: 3, maxFullResponses: 1, maxPhysicalRequests: 6, maxReservedOutputTokens: 320000
        };
        const installed = await daily.withDailyFreshAnalysisContext(plan, () =>
            daily.withDailyFreshPaperSource(plan, paper, () =>
                engine.withPaperAnalysisLock(paper, () =>
                    retry.withExplicitRound(paper, baseGrant, () =>
                        retry.beginExplicitRound(plan.readerAttemptsDir, identity, initialExhausted, paper)
                    )
                )
            )
        );
        const parentReceiptFile = installed.explicitReaderRetryRound.receiptFile;
        const parentReceipt = JSON.parse(fs.readFileSync(parentReceiptFile, 'utf8'));
        parentReceipt.physicalRequests = 3;
        parentReceipt.reservedOutputTokens = 288000;
        parentReceipt.requests = [
            { stage: 'apiReaderRepair', at: '2026-11-27T01:00:00.000Z', tokens: 96000 },
            { stage: 'apiReaderRepair', at: '2026-11-27T01:01:00.000Z', tokens: 96000 },
            { stage: 'apiReaderRepair', at: '2026-11-27T01:02:00.000Z', tokens: 96000 }
        ];
        fs.writeFileSync(parentReceiptFile, `${JSON.stringify(parentReceipt, null, 2)}\n`, { mode: 0o600 });

        const activePayload = {
            ...installed,
            attempts: 3,
            fullAttempts: 0,
            issues: [{ path: '/sections/0/body', message: 'still needs local fix' }],
            failureSignature: repair.hashRecoveryIssues([{ path: '/sections/0/body', message: 'still needs local fix' }]),
            validationFailureSignature: repair.validationFailureSignature([{ path: '/sections/0/body', message: 'still needs local fix' }]),
            validationFailureStreak: 1
        };
        repair.saveFailedCandidate(plan.readerAttemptsDir, identity, activePayload);

        // Explicit --budget via CLI parseArgs MUST throw
        const parsedWithBudget = readerRetryNew.parseArgs(['--paper', paperId, '--mode', 'local', '--budget', '80000']);
        assert.equal(parsedWithBudget.budgetExplicit, true);
        assert.throws(
            () => readerRetryNew.buildRetryManifest(parsedWithBudget),
            /固定预算 96000 tokens，不能同时指定 --budget/
        );

        // Explicit budget via programmatic options MUST also throw
        assert.throws(
            () => readerRetryNew.buildRetryManifest({ papers: [paperId], mode: 'local', budget: 320000 }),
            /固定预算 96000 tokens，不能同时指定 --budget/
        );

        // Omitting --budget via CLI parseArgs MUST succeed with fixed parent-recovery budget (96000)
        const parsedWithoutBudget = readerRetryNew.parseArgs(['--paper', paperId, '--mode', 'local']);
        assert.equal(parsedWithoutBudget.budgetExplicit, false);
        const { manifest } = readerRetryNew.buildRetryManifest(parsedWithoutBudget);
        assert.equal(manifest.rounds.length, 1);
        assert.equal(manifest.rounds[0].contract, parentRecovery.CONTRACT);
        assert.equal(manifest.rounds[0].maxReservedOutputTokens, 96000);
    });
});

// =========================================================================
// [P1-4 + P2-4 + R3-W3 Podcast feedUrl] publish-daily-podcast & podcast-github-release
// =========================================================================
describe('R35 P1-4, P2-4 & R3-W3: Podcast portal-repo guards, unpublished filtering, chapters staging/skip, and feeds/podcast.xml alignment', () => {
    function setupPodcastFixture(t) {
        const tmp = mkTempDir(t, 'r35-podcast-');
        const inputPath = path.join(tmp, 'deep-analysis-result.json');
        fs.writeFileSync(inputPath, JSON.stringify({
            batchDate: '2026-11-27',
            papers: [{
                arxivId: '2611.12345',
                title: 'Neural Audio Codec 2.0',
                parsed: { score: 8.8, tags: ['音频编解码'], primaryTask: '音频编解码' },
                apiReaderPlan: { readerTitle: '神经音频编解码 2.0', oneSentenceThesis: '大幅降低码率并保持音质' }
            }]
        }));
        const mp3Bytes = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00mock-mp3-data');
        const synthMock = (_bin, args) => {
            const outIdx = args.indexOf('--output');
            const manIdx = args.indexOf('--manifest-out');
            fs.writeFileSync(args[outIdx + 1], mp3Bytes);
            fs.writeFileSync(args[manIdx + 1], JSON.stringify({
                audioPath: args[outIdx + 1],
                audioBytes: mp3Bytes.length,
                audioSha256: sha(mp3Bytes),
                durationSeconds: 95,
                format: 'mp3',
                mimeType: 'audio/mpeg',
                ttsEngine: 'silent-mock',
                chapters: [{ title: '开场导览', startSeconds: 0, endSeconds: 95 }]
            }));
            return '';
        };
        return { tmp, inputPath, synthMock };
    }

    it('P1-4a: --dry-run and --local-only NEVER write or overwrite --portal-repo', t => {
        const { tmp, inputPath, synthMock } = setupPodcastFixture(t);
        const portalRepo = path.join(tmp, 'portal-repo');
        const sentinelRss = path.join(portalRepo, 'static', 'feeds', 'podcast.xml');
        fs.mkdirSync(path.dirname(sentinelRss), { recursive: true });
        fs.writeFileSync(sentinelRss, '<rss>PRODUCTION_SENTINEL</rss>\n');

        for (const flag of [{ dryRun: true }, { localOnly: true }]) {
            const outDir = path.join(tmp, flag.dryRun ? 'dry-out' : 'local-out');
            const res = podcastPublisher.runDailyPodcastPipeline({
                date: '2026-11-27',
                input: inputPath,
                outDir,
                episodesDir: path.join(tmp, 'empty-eps'),
                portalRepo,
                backend: 'silent-mock',
                ...flag
            }, {
                execFileSyncFn: synthMock,
                ghExecFileSyncFn: () => { throw new Error('gh must not be called'); }
            });
            assert.equal(res.portalSync, undefined);
            assert.equal(fs.readFileSync(sentinelRss, 'utf8'), '<rss>PRODUCTION_SENTINEL</rss>\n');
            assert.equal(fs.existsSync(path.join(portalRepo, 'data', 'podcast-episodes.json')), false);
            assert.equal(fs.existsSync(path.join(portalRepo, 'static', 'client', 'podcast', 'feed.json')), false);
        }
    });

    it('P1-4b: loadExistingEpisodes skips dry-run, local-only, and other non-published records while keeping published and legacy records', t => {
        const tmp = mkTempDir(t, 'r35-podcast-eps-');
        const mkEp = (date, status, title) => ({
            contract: 'daily-podcast-episode',
            date,
            title,
            description: 'desc',
            audioUrl: `https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-${date}.mp3`,
            audioBytes: 1000,
            audioSha256: 'a'.repeat(64),
            durationSeconds: 60,
            mimeType: 'audio/mpeg',
            ttsEngine: 'mock',
            chapters: [],
            episodePageUrl: `https://nanless.github.io/audio-research-portal/posts/${date}/`,
            publishedAt: `${date}T08:00:00+08:00`,
            ...(status !== undefined ? { publishStatus: status } : {})
        });

        fs.mkdirSync(path.join(tmp, '2026-11-24'), { recursive: true });
        fs.mkdirSync(path.join(tmp, '2026-11-25'), { recursive: true });
        fs.mkdirSync(path.join(tmp, '2026-11-26'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '2026-11-24', 'podcast-2026-11-24.episode.json'), JSON.stringify(mkEp('2026-11-24', undefined, 'Legacy Published')));
        fs.writeFileSync(path.join(tmp, '2026-11-25', 'podcast-2026-11-25.episode.json'), JSON.stringify(mkEp('2026-11-25', 'dry-run', 'Dead 404 Dry-Run')));
        fs.writeFileSync(path.join(tmp, '2026-11-26', '01-published.episode.json'), JSON.stringify(mkEp('2026-11-26', 'published', 'Real Published 26')));
        fs.writeFileSync(path.join(tmp, '2026-11-26', '02-local-only.episode.json'), JSON.stringify(mkEp('2026-11-26', 'local-only', 'Must Not Overwrite 26')));

        const loaded = podcastPublisher.loadExistingEpisodes(tmp, '2026-11-27');
        assert.deepEqual(loaded.map(ep => ep.date), ['2026-11-26', '2026-11-24']);
        assert.equal(loaded[0].title, 'Real Published 26');
        assert.equal(loaded[1].title, 'Legacy Published');
    });

    it('P2-4: stages custom --chapters-out under canonical chaptersFileName for Release upload, and skips upload for custom non-GitHub --chapters-base-url', t => {
        const { tmp, inputPath, synthMock } = setupPodcastFixture(t);

        // (a) Custom --chapters-out basename differing from chaptersFileName -> staged with canonical basename and cleaned up
        const customChaptersOut = path.join(tmp, 'custom-dir', 'my-arbitrary-chapters.json');
        let observedUploadPath = null;
        let observedUploadBasename = null;
        let existedDuringUpload = false;
        const resCustomOut = podcastPublisher.runDailyPodcastPipeline({
            date: '2026-11-27',
            input: inputPath,
            outDir: path.join(tmp, 'out-custom-chapters'),
            chaptersOut: customChaptersOut,
            episodesDir: path.join(tmp, 'empty-eps'),
            repo: 'nanless/audio-research-portal',
            backend: 'silent-mock'
        }, {
            execFileSyncFn: synthMock,
            ghExecFileSyncFn: (_bin, args) => {
                if (args[1] === 'upload' && args.some(a => String(a).endsWith('.chapters.json'))) {
                    observedUploadPath = args[args.length - 1];
                    observedUploadBasename = path.basename(observedUploadPath);
                    existedDuringUpload = fs.existsSync(observedUploadPath);
                }
                return '';
            }
        });
        assert.equal(resCustomOut.chaptersUploaded, true);
        assert.equal(resCustomOut.chaptersPath, customChaptersOut);
        assert.equal(fs.existsSync(customChaptersOut), true);
        assert.equal(existedDuringUpload, true);
        assert.equal(observedUploadBasename, 'podcast-2026-11-27.chapters.json');
        assert.equal(
            resCustomOut.episodeMetadata.chaptersUrl,
            'https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-2026-11-27.chapters.json'
        );
        // Temporary staging directory must be cleaned up after upload
        assert.equal(fs.existsSync(path.dirname(observedUploadPath)), false);

        // (b) Custom non-GitHub --chapters-base-url -> skips GitHub Release upload for chapters
        const ghCallsCustomHost = [];
        const resCustomHost = podcastPublisher.runDailyPodcastPipeline({
            date: '2026-11-27',
            input: inputPath,
            outDir: path.join(tmp, 'out-custom-host'),
            episodesDir: path.join(tmp, 'empty-eps'),
            repo: 'nanless/audio-research-portal',
            chaptersBaseUrl: 'https://cdn.example.com/podcast-chapters',
            backend: 'silent-mock'
        }, {
            execFileSyncFn: synthMock,
            ghExecFileSyncFn: (_bin, args) => {
                ghCallsCustomHost.push(args);
                return '';
            }
        });
        assert.equal(resCustomHost.chaptersUploaded, false);
        assert.equal(
            resCustomHost.episodeMetadata.chaptersUrl,
            'https://cdn.example.com/podcast-chapters/podcast-2026-11-27.chapters.json'
        );
        assert.equal(
            ghCallsCustomHost.some(args => args.some(a => String(a).endsWith('.chapters.json'))),
            false,
            'Must NOT upload chapters to GitHub Release when --chapters-base-url points to a custom non-GitHub host'
        );

        // (c) R35-Rev P2-2: Non-default port, query string, hash, or userinfo on github.com MUST NOT match same Release base
        const repo = 'nanless/audio-research-portal';
        const tag = 'podcast-2026-11';
        assert.equal(
            podcastPublisher.isSameGitHubReleaseChaptersBase(`https://github.com/${repo}/releases/download/${tag}`, repo, tag),
            true
        );
        for (const badUrl of [
            `https://github.com:8443/${repo}/releases/download/${tag}`,
            `https://github.com/${repo}/releases/download/${tag}?x=1`,
            `https://github.com/${repo}/releases/download/${tag}#frag`,
            `https://user:pass@github.com/${repo}/releases/download/${tag}`
        ]) {
            assert.equal(
                podcastPublisher.isSameGitHubReleaseChaptersBase(badUrl, repo, tag),
                false,
                `Must reject non-canonical GitHub URL: ${badUrl}`
            );
        }
        for (const badUrl of [
            `https://github.com:8443/${repo}/releases/download/${tag}`,
            `https://github.com/${repo}/releases/download/${tag}?x=1`
        ]) {
            const ghCalls = [];
            const resBad = podcastPublisher.runDailyPodcastPipeline({
                date: '2026-11-27',
                input: inputPath,
                outDir: path.join(tmp, `out-bad-${badUrl.includes('8443') ? 'port' : 'query'}`),
                episodesDir: path.join(tmp, 'empty-eps'),
                repo,
                chaptersBaseUrl: badUrl,
                backend: 'silent-mock'
            }, {
                execFileSyncFn: synthMock,
                ghExecFileSyncFn: (_bin, args) => {
                    ghCalls.push(args);
                    return '';
                }
            });
            assert.equal(resBad.chaptersUploaded, false, `Should skip chapters upload for ${badUrl}`);
            assert.equal(
                ghCalls.some(args => args.some(a => String(a).endsWith('.chapters.json'))),
                false,
                `Must not upload chapters asset for ${badUrl}`
            );
        }
    });

    it('R3-W3: aligns default RSS atom:link self feedUrl to feeds/podcast.xml in both podcast-github-release and publish-daily-podcast', t => {
        const ep = podcastRelease.buildPodcastEpisodeMetadata({
            date: '2026-11-27',
            title: '音频研究日报播客 2026-11-27',
            description: '每日精选论文音频导览。',
            audioUrl: 'https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-2026-11-27.mp3',
            audioBytes: 2048,
            audioSha256: 'c'.repeat(64),
            durationSeconds: 120,
            mimeType: 'audio/mpeg'
        });
        const defaultXml = podcastRelease.buildPodcastRssXml([ep]);
        assert.match(
            defaultXml,
            /<atom:link href="https:\/\/nanless\.github\.io\/audio-research-portal\/feeds\/podcast\.xml" rel="self" type="application\/rss\+xml" \/>/
        );

        const { tmp, inputPath, synthMock } = setupPodcastFixture(t);
        const portalRepo = path.join(tmp, 'portal-repo');
        fs.mkdirSync(portalRepo, { recursive: true });
        const res = podcastPublisher.runDailyPodcastPipeline({
            date: '2026-11-27',
            input: inputPath,
            outDir: path.join(tmp, 'out-feedurl'),
            episodesDir: path.join(tmp, 'empty-eps'),
            portalRepo,
            repo: 'nanless/audio-research-portal',
            backend: 'silent-mock'
        }, {
            execFileSyncFn: synthMock,
            ghExecFileSyncFn: () => ''
        });
        const localRss = fs.readFileSync(res.rssPath, 'utf8');
        const portalRss = fs.readFileSync(path.join(portalRepo, 'static', 'feeds', 'podcast.xml'), 'utf8');
        assert.match(localRss, /href="https:\/\/nanless\.github\.io\/audio-research-portal\/feeds\/podcast\.xml"/);
        assert.match(portalRss, /href="https:\/\/nanless\.github\.io\/audio-research-portal\/feeds\/podcast\.xml"/);
    });
});

// =========================================================================
// [P1-5] explicit-reader-retry-round.js: leading whitespace position slicing & fallthrough
// =========================================================================
describe('R35 P1-5: explicit-reader-retry-round trimmed slicing & trailing-comma fallthrough', () => {
    const parseErr = text => {
        try { JSON.parse(text); return ''; } catch (e) { return `读者文章 JSON 无法解析: ${e.message}`; }
    };
    const makePair = (rawDraft, errorSourceText = rawDraft.trim()) => {
        const msg = parseErr(errorSourceText);
        const issues = [{ path: null, message: msg }];
        return {
            payload: {
                status: 'failed',
                draft: null,
                rawDraft,
                attempts: 2,
                fullAttempts: 2,
                noProgress: 0,
                transportFailures: 0,
                validationFailureStreak: 1,
                failureSignature: repair.hashRecoveryIssues(issues),
                validationFailureSignature: repair.validationFailureSignature(issues),
                issues
            },
            paper: {
                analysisManifest: { stages: { apiReaderArticle: { status: 'failed' } } },
                latestAnalysisAttemptError: msg,
                latestAnalysisAttemptErrorCode: 'READER_FULL_ATTEMPTS_EXHAUSTED',
                latestAnalysisAttemptErrorCategory: 'reader_recovery',
                latestAnalysisAttemptErrorScope: 'paper',
                latestAnalysisAttemptRetryable: false
            }
        };
    };

    it('admits trailing-comma and missing-comma complete objects with leading whitespace under both trimmed and untrimmed V8 error offsets', () => {
        for (const raw of ['\n{"a": 1,}', '  \n\t{"a": 1,}', '\n{"a": [1, 2,]}', '  \n\t{"a": 1 "b": 2}']) {
            // Production path: JSON.parse ran on trimmed/extracted text
            const trimmedErrPair = makePair(raw, raw.trim());
            assert.equal(
                retry.exhaustedInitialFullWithoutLocalDraft(trimmedErrPair.payload, trimmedErrPair.paper),
                true,
                `Should admit (trimmed pos): ${JSON.stringify(raw)}`
            );
            // Direct raw parse path: JSON.parse ran on rawDraft directly (shifted offset -> falls through cleanly)
            const rawErrPair = makePair(raw, raw);
            assert.equal(
                retry.exhaustedInitialFullWithoutLocalDraft(rawErrPair.payload, rawErrPair.paper),
                true,
                `Should admit (untrimmed pos): ${JSON.stringify(raw)}`
            );
        }
    });

    it('still rejects truncated, double-comma, and array-root inputs even with leading whitespace', () => {
        for (const bad of ['\n{"a": 1,,}', '  \n\t{"a": 1,', '\n["a",]']) {
            const pair = makePair(bad, bad.trim());
            assert.equal(
                retry.exhaustedInitialFullWithoutLocalDraft(pair.payload, pair.paper),
                false,
                `Must reject: ${JSON.stringify(bad)}`
            );
        }
    });
});

// =========================================================================
// [P2-1] fact-feedback-new.js: uses details.freshSourceDescriptor.sourceGeneration
// =========================================================================
describe('R35 P2-1: fact-feedback-new uses sourceGeneration from freshSourceDescriptor instead of hardcoded constant', () => {
    it('reads generation-000002 cleanly when freshSourceDescriptor.sourceGeneration === 2', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, source, paperId, claim } = sample;

        // Capture a real generation-000002 sealed source alongside generation-000001
        await sourceApi.captureFreshArxivRewriteSource({
            rootDir: plan.sourcesDir,
            arxivId: paperId,
            generation: 2
        }, {
            fetchText: async sourceId => ({
                text: source.text,
                source: 'html',
                htmlAvailability: 'available',
                htmlAttempts: 1,
                warnings: [],
                sourceId,
                url: `https://arxiv.org/html/${sourceId}`,
                fetchedAt: '2026-11-27T01:00:00.000Z'
            }),
            fetchPdf: async sourceId => ({
                bytes: Buffer.from(`%PDF-1.7\n${sourceId}-gen2\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${sourceId}.pdf`,
                fetchedAt: '2026-11-27T01:00:01.000Z'
            })
        });
        const gen2Stored = sourceApi.readFreshArxivRewriteSource({
            rootDir: plan.sourcesDir,
            arxivId: paperId,
            generation: 2
        });
        const gen2PdfSha = gen2Stored.manifest.pdf.responseSha256;

        fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
            batchDate: plan.batchDate,
            batchId: plan.batchId,
            status: 'complete',
            dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
            papers: [paper]
        }), { mode: 0o600 });

        // Stub readDailyFreshSource to report sourceGeneration=2 while running REAL unmocked factReview.validateFeedback end-to-end!
        const origReadDaily = daily.readDailyFreshSource;
        const observedGenerations = [];
        const origReadFresh = sourceApi.readFreshArxivRewriteSource;
        t.mock.method(sourceApi, 'readFreshArxivRewriteSource', args => {
            observedGenerations.push(args.generation);
            return origReadFresh(args);
        });
        t.mock.method(daily, 'readDailyFreshSource', (p, target) => {
            const base = origReadDaily(p, target);
            return {
                ...base,
                freshSourceDescriptor: {
                    ...base.freshSourceDescriptor,
                    sourceGeneration: 2
                }
            };
        });

        const built = factFeedbackNew.buildFactFeedback({
            paper: paperId,
            readerFeedback: '纠正错误句',
            rejectedReaderClaims: [claim],
            sourceQuotes: [source.text.slice(0, 80)]
        });
        // Both fact-feedback-new.js AND unmocked factReview.validateFeedback() must read generation 2!
        assert.ok(
            observedGenerations.filter(g => g === 2).length >= 2,
            `Expected BOTH fact-feedback-new and unmocked validateFeedback to read generation 2, got: ${JSON.stringify(observedGenerations)}`
        );
        assert.equal(built.feedback.sourceFiles['source.pdf'], gen2PdfSha);
        assert.equal(built.bound.proof.sourceFiles['source.pdf'], gen2PdfSha);
        assert.equal(built.bound.proof.feedbackSha256, factReview.proofFor(built.feedback).feedbackSha256);
    });
});

// =========================================================================
// [P2-3] batch-analyze.js: evaluateReaderFactLocalAuto is strictly read-only (zero disk writes)
// =========================================================================
describe('R35 P2-3: evaluateReaderFactLocalAuto performs zero disk writes to fact-feedback/', () => {
    it('never creates fact-feedback/ or writes fact-feedback/<sha>.json during unlocked or locked preflight', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, feedback } = sample;
        paper.latestAnalysisAttemptError = null;
        delete paper.error;

        const feedbackDir = daily.factFeedbackDirectory(plan);
        assert.equal(fs.existsSync(feedbackDir), false, 'precondition: fact-feedback dir does not exist');

        // 1. Unlocked eligible preflight -> ZERO disk writes
        const unlockedOk = batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {});
        assert.equal(unlockedOk.eligible, true, `Expected eligible=true, got: ${unlockedOk.reason}`);
        assert.equal(fs.existsSync(feedbackDir), false, 'Unlocked eligible preflight MUST NOT create fact-feedback/');

        // 2. Unlocked ineligible preflight -> ZERO disk writes
        const unlockedFail = batch.evaluateReaderFactLocalAuto(
            paper,
            { ...feedback, rejectedReaderClaims: ['文中不存在的声明。'] },
            plan,
            {}
        );
        assert.equal(unlockedFail.eligible, false);
        assert.equal(fs.existsSync(feedbackDir), false, 'Unlocked ineligible preflight MUST NOT create fact-feedback/');

        // 3. Locked preflight (without parent) -> ZERO disk writes
        const lockedOk = await engine.withPaperAnalysisLock(paper, () =>
            batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {})
        );
        assert.equal(lockedOk.eligible, true, `Expected locked eligible=true, got: ${lockedOk.reason}`);
        assert.equal(fs.existsSync(feedbackDir), false, 'Locked preflight MUST NOT create fact-feedback/');
    });

    it('uses read-only saved parent scope without writing the new child packet when locked with an existing saved parent', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, feedback } = sample;
        paper.latestAnalysisAttemptError = null;
        delete paper.error;

        // Simulate an already-saved parent feedback from an earlier completed primaryAnalysis pass
        const parentFeedback = {
            ...feedback,
            primaryFeedback: '主文已完成的早期事实修正。',
            rejectedPrimaryClaims: ['一个主文中早已消除的旧句。'],
            readerFeedback: '',
            rejectedReaderClaims: []
        };
        const parentProof = factReview.proofFor(parentFeedback);
        const feedbackDir = daily.factFeedbackDirectory(plan);
        fs.mkdirSync(feedbackDir, { recursive: true, mode: 0o700 });
        const parentFile = path.join(feedbackDir, `${parentProof.feedbackSha256}.json`);
        fs.writeFileSync(parentFile, `${JSON.stringify(parentFeedback, null, 2)}\n`, { mode: 0o600 });
        paper.analysisManifest.stages.primaryAnalysis.factReview = parentProof;

        const childProof = factReview.proofFor(feedback);
        const childFile = path.join(feedbackDir, `${childProof.feedbackSha256}.json`);
        assert.equal(fs.existsSync(childFile), false);

        // Spy on withFactReview to prove it is NEVER called!
        let withFactReviewCalls = 0;
        t.mock.method(factReview, 'withFactReview', () => {
            withFactReviewCalls += 1;
            throw new Error('withFactReview must NEVER be called by read-only evaluateReaderFactLocalAuto');
        });

        const res = await engine.withPaperAnalysisLock(paper, () =>
            batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {})
        );
        assert.equal(res.eligible, true, `Expected eligible=true with saved parent, got: ${res.reason}`);
        assert.equal(withFactReviewCalls, 0);
        assert.equal(fs.existsSync(childFile), false, 'Must NOT persist child feedback file during preflight');
    });

    it('R35-Rev P1-4 Gap A: unlocked read-only preflight rejects missing parent primaryAnalysis.factReview file with zero disk writes', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, feedback } = sample;
        paper.latestAnalysisAttemptError = null;
        delete paper.error;

        const missingParentFeedback = {
            ...feedback,
            primaryFeedback: '主文已完成但磁盘反馈文件已缺失。',
            rejectedPrimaryClaims: ['一个不存在于正文的已消除主文原句。'],
            readerFeedback: '',
            rejectedReaderClaims: []
        };
        paper.analysisManifest.stages.primaryAnalysis.factReview = factReview.proofFor(missingParentFeedback);

        const feedbackDir = daily.factFeedbackDirectory(plan);
        assert.equal(fs.existsSync(feedbackDir), false);

        const unlocked = batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {});
        assert.equal(unlocked.eligible, false);
        assert.equal(unlocked.reason, 'Reader纠错缺少原主分析反馈身份');
        assert.equal(fs.existsSync(feedbackDir), false, 'Gap A rejection MUST perform zero disk writes');
    });

    it('R35-Rev P1-4 Gap B: unlocked read-only preflight validates savedReader prior child packet, constraints, and coreSummaryRepair feedback budget', async t => {
        const sample = await createSealedSignedSample(t);
        const { plan, paper, feedback, claim } = sample;
        paper.latestAnalysisAttemptError = null;
        delete paper.error;

        const feedbackDir = daily.factFeedbackDirectory(plan);

        // B1: savedReader present on apiReaderArticle, but prior child file is missing on disk -> must reject!
        const missingPriorChild = {
            ...feedback,
            readerFeedback: '早期 Reader 纠错约束：不要编造闭源成本。'
        };
        paper.analysisManifest.stages.apiReaderArticle.factReview = factReview.proofFor(missingPriorChild);
        const missingRes = batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {});
        assert.equal(missingRes.eligible, false);
        assert.equal(missingRes.reason, 'Reader纠错缺少原Reader事实反馈包');
        assert.equal(fs.existsSync(feedbackDir), false, 'Missing prior child rejection MUST perform zero disk writes');

        // B2: coreSummaryRepair parent + saved prior Reader child on disk
        const coreParent = {
            ...feedback,
            coreFeedback: `核心摘要纠错约束：${'严守原文核心摘要口径。'.repeat(110)}`,
            rejectedCoreClaims: ['一个核心摘要中已消除的旧句。'],
            readerFeedback: '',
            rejectedReaderClaims: []
        };
        const coreParentProof = factReview.proofFor(coreParent);
        const priorChild = {
            ...feedback,
            readerFeedback: '早期 Reader 纠错约束：原文未报告闭源模型计算成本。',
            rejectedReaderClaims: [claim]
        };
        const priorChildProof = factReview.proofFor(priorChild);

        fs.mkdirSync(feedbackDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(feedbackDir, `${coreParentProof.feedbackSha256}.json`), `${JSON.stringify(coreParent, null, 2)}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(feedbackDir, `${priorChildProof.feedbackSha256}.json`), `${JSON.stringify(priorChild, null, 2)}\n`, { mode: 0o600 });
        paper.analysisManifest.stages.coreSummaryRepair.factReview = coreParentProof;
        paper.analysisManifest.stages.apiReaderArticle.factReview = priorChildProof;

        // Child omitting prior child's readerFeedback text -> must reject
        const omitsPriorConstraint = {
            ...feedback,
            readerFeedback: '新的独立说法，遗漏了旧 Reader 纠错约束。',
            rejectedReaderClaims: [claim]
        };
        const omitRes = batch.evaluateReaderFactLocalAuto(paper, omitsPriorConstraint, plan, {});
        assert.equal(omitRes.eligible, false);
        assert.equal(omitRes.reason, '新Reader反馈遗漏旧Reader事实约束');

        // Child retaining prior child's constraints, where readerFeedback + quotes <= 4000,
        // BUT readerFeedback + coreParent.coreFeedback + quotes > 4000 -> MUST reject with rendered_feedback_exceeds_limit!
        const overBudgetChild = {
            ...feedback,
            readerFeedback: `${priorChild.readerFeedback}${'补充核验说明。'.repeat(420)}`,
            rejectedReaderClaims: [claim]
        };
        assert.ok(overBudgetChild.readerFeedback.length + overBudgetChild.sourceQuotes.join('\n').length + 80 <= 4000);
        const overBudgetRes = batch.evaluateReaderFactLocalAuto(paper, overBudgetChild, plan, {});
        assert.equal(overBudgetRes.eligible, false);
        assert.equal(overBudgetRes.reason, 'rendered_feedback_exceeds_limit');
        assert.equal(
            fs.existsSync(path.join(feedbackDir, `${factReview.proofFor(overBudgetChild).feedbackSha256}.json`)),
            false,
            'New over-budget child MUST NOT be written to disk'
        );

        // Child retaining prior child's constraints AND within 4000 chars including coreFeedback -> eligible: true with zero new writes!
        const validNewChild = {
            ...feedback,
            readerFeedback: `${priorChild.readerFeedback} 同步补充核验。`,
            rejectedReaderClaims: [claim]
        };
        const validChildRes = batch.evaluateReaderFactLocalAuto(paper, validNewChild, plan, {});
        assert.equal(validChildRes.eligible, true, `Expected eligible=true, got: ${validChildRes.reason}`);
        assert.equal(
            fs.existsSync(path.join(feedbackDir, `${factReview.proofFor(validNewChild).feedbackSha256}.json`)),
            false,
            'New valid child MUST NOT be written to disk during preflight'
        );
    });

    it('R35-Rev P1-4 Gap C: unlocked read-only preflight matches COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR, isVerifiedReaderFactPreRequestSeed, and hasReviewedCompletedPrimaryReaderSeed', async t => {
        const preRequestRecovery = require('../scripts/lib/reader-fact-pre-request-recovery.js');
        const RESUME_ERR = '局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';

        // C1: COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR + CONTRACT_REJECTED -> eligible: true with zero disk writes
        const s1 = await createSealedSignedSample(t);
        s1.paper.latestAnalysisAttemptError = RESUME_ERR;
        s1.paper.latestAnalysisAttemptErrorCode = 'CONTRACT_REJECTED';
        s1.paper.error = RESUME_ERR;
        const c1 = batch.evaluateReaderFactLocalAuto(s1.paper, s1.feedback, s1.plan, {});
        assert.equal(c1.eligible, true, `Expected C1 eligible=true, got: ${c1.reason}`);
        assert.equal(fs.existsSync(daily.factFeedbackDirectory(s1.plan)), false);

        // C2: isVerifiedReaderFactPreRequestSeed parity
        const s2 = await createSealedSignedSample(t);
        s2.paper.latestAnalysisAttemptError = preRequestRecovery.SEED_ERROR;
        s2.paper.latestAnalysisAttemptErrorCode = null;
        delete s2.paper.error;
        const c2Denied = batch.evaluateReaderFactLocalAuto(s2.paper, s2.feedback, s2.plan, {});
        assert.equal(c2Denied.eligible, false);
        assert.equal(c2Denied.reason, 'missing_reviewed_fact_local_seed');

        t.mock.method(preRequestRecovery, 'isVerifiedReaderFactPreRequestSeed', () => true);
        const c2Allowed = batch.evaluateReaderFactLocalAuto(s2.paper, s2.feedback, s2.plan, {});
        assert.equal(c2Allowed.eligible, true, `Expected C2 eligible=true when pre-request seed verified, got: ${c2Allowed.reason}`);
        assert.equal(fs.existsSync(daily.factFeedbackDirectory(s2.plan)), false);

        // C3: hasReviewedCompletedPrimaryReaderSeed parity (COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR without CONTRACT_REJECTED)
        const s3 = await createSealedSignedSample(t);
        s3.paper.latestAnalysisAttemptError = RESUME_ERR;
        s3.paper.latestAnalysisAttemptErrorCode = 'OTHER_CODE';
        delete s3.paper.error;
        t.mock.method(preRequestRecovery, 'isVerifiedReaderFactPreRequestSeed', () => false);
        const c3Denied = batch.evaluateReaderFactLocalAuto(s3.paper, s3.feedback, s3.plan, {});
        assert.equal(c3Denied.eligible, false);
        assert.equal(c3Denied.reason, 'missing_reviewed_fact_local_seed');

        t.mock.method(deep, 'hasReviewedCompletedPrimaryReaderSeed', () => true);
        const c3Allowed = batch.evaluateReaderFactLocalAuto(s3.paper, s3.feedback, s3.plan, {});
        assert.equal(c3Allowed.eligible, true, `Expected C3 eligible=true when completed-primary seed verified, got: ${c3Allowed.reason}`);
        assert.equal(fs.existsSync(daily.factFeedbackDirectory(s3.plan)), false);
    });
});

// =========================================================================
// [P2-5] deep-analyzer.js: LLM_USAGE_NOT_PERSISTED rawDraft symmetry with L5578
// =========================================================================
describe('R35 P2-5: deep-analyzer LLM_USAGE_NOT_PERSISTED normalizes rawDraft symmetrically on 1-char schemaFingerprint typo', () => {
    it('saves canonical schemaFingerprint in BOTH draft and rawDraft on 1-char copy typo while keeping verbatim malformed rawDraft untouched', async t => {
        const dir = mkTempDir(t, 'r35-deep-rawdraft-');
        const currentFp = protocolCodec.schemaFingerprint('reader-draft');
        const typoFp = currentFp.slice(0, -1); // 1-char deletion typo

        const typoDraft = {
            ...protocolCodec.recordHeader(protocolCodec.contract('reader-draft'), 'reader-draft'),
            schemaFingerprint: typoFp,
            readerTitle: '存储故障单字符指纹偏差对称归一化测试',
            oneSentenceThesis: '验证存储故障路径保存的 rawDraft 与 draft 均携带归一化后的正式指纹。',
            conceptBridges: [],
            figurePlacements: [],
            tableBindings: [],
            formulaBindings: [],
            sections: [
                { kind: 'problem', heading: '问题定义', body: '背景分析。' },
                { kind: 'method_overview', heading: '方法概览', body: '方法框架。' },
                { kind: 'component', heading: '关键模块', body: '模块设计。' },
                { kind: 'result', heading: '实验结果', body: '结果讨论。' },
                { kind: 'limitation', heading: '局限与边界', body: '局限分析。' }
            ]
        };
        const storageError = Object.assign(new Error('ledger EIO after typo paid draft'), {
            code: 'LLM_USAGE_NOT_PERSISTED',
            scope: 'run',
            category: 'storage',
            retryable: false,
            usageEvent: { protocol: 'openai' },
            llmResponse: {
                statusCode: 200,
                body: { choices: [{ message: { content: JSON.stringify(typoDraft) } }] }
            }
        });

        await assert.rejects(
            deep.generateApiReaderArticleDetailed(
                { arxivId: '2611.99551', title: 'P2-5 Symmetry Test' },
                'canonical',
                '',
                {
                    sourceText: 'source',
                    readerAttemptsDir: dir,
                    readerMaterializeFigures: async () => [],
                    readerRecordDisposition() {},
                    readerCallModel: async () => { throw storageError; }
                }
            ),
            err => err === storageError
        );

        const candidateFiles = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
        assert.equal(candidateFiles.length, 1);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, candidateFiles[0]), 'utf8')).payload;
        assert.ok(saved.draft, 'paidCandidate should be parsed after typo normalization');
        assert.equal(saved.draft.schemaFingerprint, currentFp);
        const parsedRaw = JSON.parse(saved.rawDraft);
        assert.equal(parsedRaw.schemaFingerprint, currentFp, 'saved rawDraft must be normalized symmetrically with draft');
        assert.ok(repair.parseRecoveryDraft(saved.rawDraft), 'saved rawDraft must pass strict cold-replay parseRecoveryDraft');
    });
});
