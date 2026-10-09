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

function sourceBoundPaper(plan, id) {
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
        readerAuthorIdentitySha256: reader.apiReaderAuthors.identitySha256,
        readerAuthorsSha256: stableSha256(reader.apiReaderAuthors),
        resourceIdentitySha256: reader.apiReaderResources.identitySha256
    });
    const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId, sourceGeneration: 1,
        sourceManifestSha256: source.freshSourceDescriptor.sourceManifestSha256,
        sourceSha256: sourceSha, sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
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
        postPublishVisualWaiverDir: 'visual-waivers', dailyFreshSourceRunsDir: 'daily-runs' };
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
    const papers = IDS.map(id => sourceBoundPaper(plan, id));
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
