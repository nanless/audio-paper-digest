'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const sourceCapture = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const { validAnalysisPaper, validLegacyApiAnalysisPaper, validAnalysisText } = require('./valid-analysis-fixture.js');
const { isSuccessfulAnalysisRecord } = require('../scripts/analysis-engine.js');
const { buildDigestRunReport, llmApiPaperComplete } = require('../scripts/digest-run-report.js');
const { createAnalysisWaiver, validateAnalysisWaiver, stableSha256 } = require('../scripts/analysis-waiver.js');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const DATE = '2026-09-07';
const IDS = ['2609.10001', '2609.10002'];


async function sourceBoundPaper(plan, id) {
    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    const base = validAnalysisPaper(id);
    const reader = validLegacyApiAnalysisPaper(id);
    reader.fetchBatchDate = DATE;
    // 沿用已有 Reader 样例，恢复当前核心摘要和标签证明，再绑定真实封存来源。
    reader.analysisManifest.contracts = { ...reader.analysisManifest.contracts, ...base.analysisManifest.contracts };
    reader.analysisManifest.stages = { ...base.analysisManifest.stages, ...reader.analysisManifest.stages };
    reader.analysisManifest.stages.scoringAudit = {
        ...base.analysisManifest.stages.scoringAudit, ...reader.analysisManifest.stages.scoringAudit,
        auditSha256: sha('评分审查'), evidenceSha256: sha('评分证据'), finalScore: reader.parsed.score
    };
    const sourceSha = source.freshSourceDescriptor.sourceSha256;
    reader.sourceSha256 = sourceSha;
    reader.analysisManifest.sourceAcquisition.sourceSha256 = sourceSha;
    reader.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = source.freshSourceDescriptor.structuredArtifactsSha256;
    const authorIdentity = reader.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = sourceSha;
    for (const author of authorIdentity.authors) {
        for (const binding of author.affiliationBindings) binding.sourceTextSha256 = sourceSha;
    }
    reader.apiReaderAuthors.sourceDomSha256 = sourceSha;
    reader.apiReaderAuthors.identitySha256 = stableSha256(authorIdentity);
    reader.apiReaderResources.sourceTextSha256 = sourceSha;
    delete reader.apiReaderResources.identitySha256;
    reader.apiReaderResources.identitySha256 = stableSha256(reader.apiReaderResources);
    reader.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = reader.apiReaderResources.identitySha256;
    Object.assign(reader.analysisManifest.stages.apiReaderArticle, {
        sourceBindingsSourceTextSha256: sourceSha,
        structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256,
        readerAuthorIdentitySha256: reader.apiReaderAuthors.identitySha256,
        readerAuthorsSha256: stableSha256(reader.apiReaderAuthors),
        resourceIdentitySha256: reader.apiReaderResources.identitySha256
    });
    const proof = { ...require('../scripts/lib/daily-source-format').currentHeader('fresh-source-analysis'), runId: plan.runId, sourceGeneration: 1,
        sourceManifestSha256: source.freshSourceDescriptor.sourceManifestSha256,
        sourceSha256: sourceSha, sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
        structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false };
    reader.freshRewriteProvenance = proof;
    reader.analysisManifest.freshRewriteProvenance = structuredClone(proof);
    assert.equal(isSuccessfulAnalysisRecord(reader), true, '正常测试样例数据必须通过实际分析完成校验');
    assert.equal(llmApiPaperComplete(reader), true, '正常测试样例数据必须通过实际 API Reader、评分与来源核验');
    return reader;
}

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'digest-analysis-waiver-'));
    const previousDir = Config.CURRENT_DIR;
    const previousFiles = { ...Config.FILES };
    Config.CURRENT_DIR = path.join(root, 'current');
    fs.mkdirSync(Config.CURRENT_DIR);
    const names = { rawCandidates: 'raw-candidates.json', filterDecisions: 'filter-decisions.json',
        filteredPapers: 'filtered-papers.json', deepAnalysisResult: 'deep-analysis-result.json',
        papers: 'papers.json', analysisWaiverDir: 'analysis-waivers',
        visualSummaryManifestDir: 'visuals', digestCoverManifestDir: 'covers',
        postPublishVisualWaiverDir: 'visual-waivers', dailyFreshSourceRunsDir: 'daily-runs', llmUsageDir: 'usage' };
    for (const [key, name] of Object.entries(names)) Config.FILES[key] = path.join(Config.CURRENT_DIR, name);
    t.after(() => {
        Config.CURRENT_DIR = previousDir;
        Object.assign(Config.FILES, previousFiles);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const plan = daily.createDailyFreshSourcePlan({ batchDate: DATE, batchId: 'waiver-regression',
        papers: IDS.map(arxivId => ({ arxivId })) });
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => sourceCapture.captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = `${id}\n${validAnalysisText()}\n${validAnalysisText()}`;
                const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text),
                    tables: [], formulas: [], figures: [] };
                structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                return { text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                    fetchedAt: `${DATE}T00:00:00.000Z`, imageInfos: [], structuredArtifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: `${DATE}T00:00:01.000Z` })
        }) });
    const papers = await Promise.all(IDS.map(id => sourceBoundPaper(plan, id)));
    const deep = { batchDate: DATE, papers, dailyFreshSourceRun: daily.dailyFreshSourceReference(plan) };
    const filtered = { batchDate: DATE, status: 'complete', papers: IDS.map(arxivId => ({ arxivId, fetchBatchDate: DATE })),
        stats: { afterBlogSkip: 2, decisionCount: 2, afterFilter: 2, afterArchiveSkip: 2, skippedFromArchive: 0 } };
    const database = { papers: Object.fromEntries(IDS.map(id => [id, {
        arxivId: id, digestStatus: { status: 'analyzed', latestAttemptStatus: 'analyzed' }
    }])) };
    const save = () => {
        for (const [key, value] of [['deepAnalysisResult', deep], ['filteredPapers', filtered], ['papers', database]]) {
            fs.writeFileSync(Config.FILES[key], JSON.stringify(value));
        }
    };
    save();
    fs.writeFileSync(Config.FILES.rawCandidates, JSON.stringify({ batchDate: DATE, papers: filtered.papers,
        sourceHealth: { arxiv: { ok: true, categories: Config.ARXIV_CATEGORIES.map(({ id }) => ({ id, ok: true })) },
            huggingface: { ok: true } }, stats: { afterBlogSkip: 2 } }));
    fs.writeFileSync(Config.FILES.filterDecisions, JSON.stringify({ batchDate: DATE,
        decisions: Object.fromEntries(IDS.map(id => [id, { related: true }])),
        stats: { complete: true, totalCandidates: 2, decided: 2, related: 2, retryable: 0 } }));
    const fail = (index = 1) => {
        const paper = deep.papers[index];
        paper.latestAnalysisAttemptError = '读者文章生成失败';
        delete paper.apiReaderArticle;
        paper.analysisManifest.stages.apiReaderArticle.status = 'failed';
        database.papers[IDS[index]].digestStatus = { status: 'analysis_failed', latestAttemptStatus: 'analysis_failed' };
        save();
    };
    const waive = (ids = [IDS[1]]) => {
        const result = createAnalysisWaiver({ date: DATE, paperIds: ids, reason: '用户明确豁免本轮失败论文，保留其封存来源和失败记录。', files: Config.FILES });
        assert.equal(validateAnalysisWaiver(result.payload, DATE, Config.FILES).valid, true);
        return result;
    };
    const report = () => buildDigestRunReport(DATE, { today: DATE, archiveDir: path.join(root, 'archive') });
    return { root, plan, deep, filtered, database, save, fail, waive, report };
}

test('正常批次完整核验分析与全部封存来源', async t => {
    const f = await fixture(t); const report = f.report();
    assert.equal(report.fetch.complete, true);
    assert.equal(report.filter.complete, true);
    assert.equal(report.analysis.complete, true);
    assert.equal(report.analysis.successful, 2);
    assert.equal(report.analysis.waived, 0);
    assert.equal(report.analysis.dailyFreshSource.complete, true);
});

test('合法豁免只免失败论文的分析，仍核验全体来源', async t => {
    const f = await fixture(t); f.fail(); f.waive();
    const report = f.report();
    assert.equal(report.analysis.complete, true);
    assert.equal(report.analysis.publicationMode, 'llm_api_production_with_operator_waiver');
    assert.equal(report.analysis.successful, 1);
    assert.equal(report.analysis.waived, 1);
    assert.equal(report.analysis.failed, 0);
    assert.deepEqual(report.analysis.waivedIds, [IDS[1]]);
    assert.equal(report.analysis.dailyFreshSource.complete, true);
});

test('未豁免失败不会通过；全部失败豁免也不能变成空内容发布', async t => {
    const f = await fixture(t); f.fail();
    assert.equal(f.report().analysis.complete, false);
    assert.deepEqual(f.report().analysis.failedIds, [IDS[1]]);
    f.fail(0); f.waive();
    assert.equal(f.report().analysis.complete, false);
    assert.deepEqual(f.report().analysis.failedIds, [IDS[0]]);
    f.waive(IDS);
    assert.equal(f.report().analysis.complete, false);
});

test('成功论文即使列入有效豁免也只按成功计数', async t => {
    const f = await fixture(t); f.waive(IDS);
    const report = f.report();
    assert.equal(report.analysis.complete, true);
    assert.equal(report.analysis.successful, 2);
    assert.equal(report.analysis.waived, 0);
    assert.deepEqual(report.analysis.waivedIds, []);
    assert.equal(report.analysis.publicationMode, 'llm_api_production');
});

test('豁免所对应的三份文件任一改变，都会重新拒绝分析失败的论文', async t => {
    const f = await fixture(t); f.fail(); f.waive();
    for (const key of ['deepAnalysisResult', 'filteredPapers', 'papers']) {
        const filename = Config.FILES[key], original = fs.readFileSync(filename);
        fs.appendFileSync(filename, '\n');
        const report = f.report();
        assert.equal(report.analysis.complete, false, key);
        assert.equal(report.analysis.waived, 0, key);
        assert.deepEqual(report.analysis.failedIds, [IDS[1]], key);
        assert.ok(report.errors.some(error => error.includes('waiver 无效')), key);
        fs.writeFileSync(filename, original);
    }
    assert.equal(f.report().analysis.complete, true);
});

test('无效豁免即使没有分析失败也不能通过', async t => {
    const f = await fixture(t); const { output, payload } = f.waive();
    payload.requestedBy = 'agent';
    delete payload.waiverSha256; payload.waiverSha256 = stableSha256(payload);
    fs.writeFileSync(output, JSON.stringify(payload));
    const report = f.report();
    assert.equal(report.analysis.successful, 2);
    assert.equal(report.analysis.complete, false);
    assert.ok(report.errors.some(error => error.includes('waiver 无效')));
});

test('豁免论文的 TXT、PDF、元数据或清单损坏仍阻断完成', async t => {
    const f = await fixture(t); f.fail(); f.waive();
    for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
        const filename = path.join(f.plan.sourcesDir, IDS[1], 'generation-000001', name);
        const original = fs.readFileSync(filename);
        fs.appendFileSync(filename, '损坏');
        const report = f.report();
        assert.equal(report.analysis.waived, 1, name);
        assert.equal(report.analysis.complete, false, name);
        assert.equal(report.analysis.dailyFreshSource.complete, false, name);
        assert.ok(report.analysis.dailyFreshSource.issues.length > 0, name);
        fs.writeFileSync(filename, original);
    }
    assert.equal(f.report().analysis.complete, true);
});


test('评分未收敛只在明确豁免后才退出阻断集合', async t => {
    const f = await fixture(t);
    f.deep.papers[1].analysisManifest.stages.scoringAudit.stabilityWarning = true;
    f.save();
    assert.equal(f.report().analysis.complete, false);
    assert.deepEqual(f.report().analysis.scoringStabilityUnresolvedIds, [IDS[1]]);
    f.waive();
    const report = f.report();
    assert.equal(report.analysis.complete, true);
    assert.equal(report.analysis.waived, 1);
    assert.deepEqual(report.analysis.scoringStabilityUnresolvedIds, []);
});

test('validateCurrentDataFiles 在合法 analysisWaiver 下通过 partial_failed 批次（含无正文与阶段失败），并在缺失、无效或篡改时拒绝', async t => {
    const { validateCurrentDataFiles } = require('../scripts/validate-data-files.js');
    const { validatedDecisionInputSha256 } = require('../scripts/lib/filter-scope-evidence.js');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'validate-data-waiver-e2e-'));
    const previousDir = Config.CURRENT_DIR;
    const previousFiles = { ...Config.FILES };
    const currentDir = path.join(root, 'current');
    fs.mkdirSync(currentDir, { recursive: true });
    const files = {
        fetchCheckpoint: path.join(currentDir, 'fetch-checkpoint.json'),
        rawCandidates: path.join(currentDir, 'raw-candidates.json'),
        filterDecisions: path.join(currentDir, 'filter-decisions.json'),
        filteredPapers: path.join(currentDir, 'filtered-papers.json'),
        deepAnalysisResult: path.join(currentDir, 'deep-analysis-result.json'),
        papers: path.join(currentDir, 'papers.json'),
        analysisWaiverDir: path.join(currentDir, 'analysis-waivers'),
        dailyFreshSourceRunsDir: path.join(currentDir, 'daily-runs')
    };
    Config.CURRENT_DIR = currentDir;
    Object.assign(Config.FILES, files);
    t.after(() => {
        Config.CURRENT_DIR = previousDir;
        Object.assign(Config.FILES, previousFiles);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const batchDate = '2026-09-08';
    const timestamp = '2026-09-08T10:00:00.000+08:00';
    const batchId = 'f'.repeat(16);
    const fingerprints = {
        candidateFingerprint: 'a'.repeat(16),
        sourceConfigFingerprint: 'b'.repeat(16),
        blogDedupFingerprint: 'c'.repeat(16)
    };
    const filterConfigFingerprint = 'd'.repeat(16);
    const batchIds = ['2609.20001', '2609.20002', '2609.20003', '2609.20004', '2609.20005'];

    const plan = daily.createDailyFreshSourcePlan({
        batchDate,
        batchId,
        rootDir: files.dailyFreshSourceRunsDir,
        papers: batchIds.map(arxivId => ({ arxivId }))
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => sourceCapture.captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = `${id}\n${validAnalysisText()}\n${validAnalysisText()}`;
                const structuredArtifacts = {
                    version: 1, source: 'html', flattenedTextSha256: sha(text),
                    tables: [], formulas: [], figures: []
                };
                structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                return {
                    text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                    fetchedAt: `${batchDate}T00:00:00.000Z`, imageInfos: [], structuredArtifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: []
                };
            },
            fetchPdf: async id => ({
                bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`,
                fetchedAt: `${batchDate}T00:00:01.000Z`
            })
        })
    });

    const categoryOrder = Config.ARXIV_CATEGORIES.map(category => category.id);
    const rawPapers = batchIds.map(arxivId => ({ arxivId }));
    const checkpoint = {
        timestamp, batchDate, batchId, ...fingerprints,
        historicalDedupIds: [],
        categoryOrder,
        arxiv: Object.fromEntries(categoryOrder.map((id, idx) => {
            const list = idx === 0 ? rawPapers : [];
            return [id, { status: 'complete', papers: list, papersCount: list.length, papersSha256: stableSha256(list), health: { id, ok: true } }];
        })),
        huggingface: { status: 'complete', papers: [], papersCount: 0, papersSha256: stableSha256([]), health: { ok: true } }
    };
    checkpoint.fetchSourcesSha256 = stableSha256({
        arxiv: Object.fromEntries(Object.entries(checkpoint.arxiv).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, entry]) => [id, { status: entry.status, papersCount: entry.papersCount, papersSha256: entry.papersSha256 }])),
        huggingface: { status: 'complete', papersCount: 0, papersSha256: checkpoint.huggingface.papersSha256 }
    });
    fs.writeFileSync(files.fetchCheckpoint, JSON.stringify(checkpoint));
    const integrity = { batchDate, batchId, rawPapersSha256: stableSha256(rawPapers), fetchSourcesSha256: checkpoint.fetchSourcesSha256 };
    fs.writeFileSync(files.rawCandidates, JSON.stringify({
        timestamp, ...fingerprints, ...integrity,
        stats: { beforeBlogSkip: batchIds.length, afterBlogSkip: batchIds.length, skippedFromBlog: 0, arxivOnly: batchIds.length, hfOnly: 0, both: 0 },
        sourceHealth: {
            arxiv: { categories: categoryOrder.map(id => ({ id, ok: true })) },
            huggingface: { ok: true }
        },
        papers: rawPapers
    }));
    const emptyInputSha = validatedDecisionInputSha256({ arxivId: batchIds[0] });
    fs.writeFileSync(files.filterDecisions, JSON.stringify({
        timestamp, ...fingerprints, ...integrity,
        filterModel: 'model-a', filterPromptHash: 'hash-a', filterConfigFingerprint,
        stats: { totalCandidates: batchIds.length, decided: batchIds.length, related: batchIds.length, complete: true },
        decisions: Object.fromEntries(batchIds.map(id => [id, {
            related: true, filterModel: 'model-a', filterPromptHash: 'hash-a', inputSha256: emptyInputSha
        }]))
    }));
    fs.writeFileSync(files.filteredPapers, JSON.stringify({
        timestamp, ...fingerprints, ...integrity,
        filterModel: 'model-a', filterPromptHash: 'hash-a', filterConfigFingerprint,
        status: 'complete',
        stats: { afterBlogSkip: batchIds.length, afterFilter: batchIds.length, afterArchiveSkip: batchIds.length, decisionCount: batchIds.length },
        papers: batchIds.map(arxivId => ({ arxivId, fetchBatchDate: batchDate }))
    }));

    const boundPapers = await Promise.all(batchIds.map(id => sourceBoundPaper(plan, id)));
    // 0: 正常成功
    const okPaper = boundPapers[0];
    // 1: 无正文失败（primaryAnalysis transient_failure，无 analysis/parsed/checkpoint）
    const noBodyPaper = structuredClone(boundPapers[1]);
    noBodyPaper.analysis = null;
    noBodyPaper.parsed = null;
    delete noBodyPaper.scoringRubricVersion;
    delete noBodyPaper.apiReaderArticle;
    noBodyPaper.analysisManifest.stages = {
        primaryAnalysis: { status: 'transient_failure', error: 'HTTP 503 upstream timeout' }
    };
    noBodyPaper.latestAnalysisAttemptError = 'HTTP 503 upstream timeout';
    // 2: 有正文但 apiReaderArticle 失败，且 papers.json 保留旧成功（analyzed / analysis_failed）
    const readerFailedPaper = structuredClone(boundPapers[2]);
    delete readerFailedPaper.apiReaderArticle;
    readerFailedPaper.analysisManifest.stages.apiReaderArticle = { status: 'invalid_output', error: 'Reader 校验失败' };
    readerFailedPaper.latestAnalysisAttemptError = 'Reader 校验失败';
    // 3: 有正文但 tagSelection 失败
    const tagFailedPaper = structuredClone(boundPapers[3]);
    delete tagFailedPaper.analysisManifest.stages.taxonomySelection;
    tagFailedPaper.analysisManifest.stages.tagSelection = { status: 'invalid_output', error: '标签选择失败' };
    tagFailedPaper.latestAnalysisAttemptError = '标签选择失败';
    // 4: 有正文但 scoringAudit 存在未收敛 stabilityWarning: true
    const stabilityWarningPaper = structuredClone(boundPapers[4]);
    stabilityWarningPaper.analysisManifest.stages.scoringAudit.stabilityWarning = true;
    stabilityWarningPaper.latestAnalysisAttemptError = '评分稳定性告警未收敛';

    const deep = {
        batchDate,
        batchId,
        status: 'partial_failed',
        stats: { analysisStatus: 'partial_failed', remainingFailed: 4, totalAfterMerge: 5 },
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [okPaper, noBodyPaper, readerFailedPaper, tagFailedPaper, stabilityWarningPaper]
    };
    const database = {
        papers: {
            [batchIds[0]]: { arxivId: batchIds[0], fetchBatchDate: batchDate, digestStatus: { status: 'analyzed', latestAttemptStatus: 'analyzed', batchDate } },
            [batchIds[1]]: { arxivId: batchIds[1], fetchBatchDate: batchDate, digestStatus: { status: 'analysis_failed', latestAttemptStatus: 'analysis_failed', batchDate } },
            [batchIds[2]]: { arxivId: batchIds[2], fetchBatchDate: batchDate, digestStatus: { status: 'analyzed', latestAttemptStatus: 'analysis_failed', batchDate } },
            [batchIds[3]]: { arxivId: batchIds[3], fetchBatchDate: batchDate, digestStatus: { status: 'analysis_failed', latestAttemptStatus: 'analysis_failed', batchDate } },
            [batchIds[4]]: { arxivId: batchIds[4], fetchBatchDate: batchDate, digestStatus: { status: 'analysis_failed', latestAttemptStatus: 'analysis_failed', batchDate } }
        }
    };
    const saveState = () => {
        fs.writeFileSync(files.deepAnalysisResult, JSON.stringify(deep));
        fs.writeFileSync(files.papers, JSON.stringify(database));
    };
    saveState();

    // 负向 1：未登记 waiver 时，真实 validateCurrentDataFiles 必须报出各项失败阻断
    const unwaivedIssues = validateCurrentDataFiles(files);
    assert.ok(unwaivedIssues.length > 0);
    const unwaivedText = unwaivedIssues.join('\n');
    assert.match(unwaivedText, /缺少有效 parsed 评分缓存/);
    assert.match(unwaivedText, /apiReaderArticle 尚未完成|缺少 Reader v3 完整绑定/);
    assert.match(unwaivedText, /tagSelection|标签阶段/);
    assert.match(unwaivedText, /评分稳定性告警尚未形成有效二次审计 resolution/);

    // 正向：登记覆盖 4 篇失败论文的合法 waiver 后，不改写三份封存文件即可通过真实 validateCurrentDataFiles
    const waivedIds = batchIds.slice(1);
    const created = createAnalysisWaiver({
        date: batchDate,
        paperIds: waivedIds,
        reason: '用户明确豁免本批 4 篇不同阶段失败论文，保留封存来源与原失败记录。',
        files
    });
    assert.deepEqual(validateCurrentDataFiles(files), []);

    // 负向 2：waiver 被篡改无效时必须立即拒绝
    const tamperedWaiver = structuredClone(created.payload);
    tamperedWaiver.requestedBy = 'agent';
    delete tamperedWaiver.waiverSha256;
    tamperedWaiver.waiverSha256 = stableSha256(tamperedWaiver);
    fs.writeFileSync(created.output, JSON.stringify(tamperedWaiver));
    const invalidWaiverIssues = validateCurrentDataFiles(files).join('\n');
    assert.match(invalidWaiverIssues, /analysis waiver invalid/);
    assert.match(invalidWaiverIssues, /评分稳定性告警尚未形成有效二次审计 resolution/);

    // 负向 3：篡改 stats.remainingFailed 与真实未完成数不一致（即使重新签 waiver 也必须拒绝）
    deep.stats.remainingFailed = 0;
    saveState();
    createAnalysisWaiver({
        date: batchDate,
        paperIds: waivedIds,
        reason: '重新签署豁免以验证 tampered remainingFailed 仍被拒绝。',
        files
    });
    const tamperedStatsIssues = validateCurrentDataFiles(files).join('\n');
    assert.match(tamperedStatsIssues, /stats\.remainingFailed \(0\) 与逐篇检查得到的未完成数量 \(4\) 不一致/);
    deep.stats.remainingFailed = 4;

    // 负向 4：无正文豁免失败论文在 papers.json 中声称 analyzed/analyzed 或缺失合法状态必须拒绝
    database.papers[batchIds[1]].digestStatus = { status: 'analyzed', latestAttemptStatus: 'analyzed', batchDate };
    saveState();
    createAnalysisWaiver({
        date: batchDate,
        paperIds: waivedIds,
        reason: '重新签署豁免以验证损坏的 papers.json digestStatus 仍被拒绝。',
        files
    });
    const badDigestIssues = validateCurrentDataFiles(files).join('\n');
    assert.match(badDigestIssues, /深度分析已豁免，但 digestStatus/);
});
