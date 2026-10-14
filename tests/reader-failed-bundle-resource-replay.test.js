'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
const deep = require('../scripts/deep-analyzer'), repair = require('../scripts/lib/reader-repair');
const recovery = require('../scripts/lib/reader-failed-bundle-resource-replay');
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'failed-reader-resources-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir; Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const paper = require('./valid-analysis-fixture').validAnalysisPaper('2610.90144v1');
    const quote = 'The benchmark uses https://example.com/baseline as a third-party baseline.';
    const text = quote + '\n' + 'Official methodology and same-protocol evaluation evidence. '.repeat(180);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'generic-failed-resources', papers: [paper] });
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => sourceApi.captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
            fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`,
            fetchedAt: '2026-10-11T00:00:01.000Z' })
    }) });
    const source = daily.readDailyFreshSource(plan, paper); paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition = {};
    paper.analysisManifest.sourceAcquisition.sourceSha256 = paper.sourceSha256;
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = source.freshSourceDescriptor.structuredArtifactsSha256;
    paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT;
    paper.analysisManifest.sourceAcquisition.promptRenderingContract = require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT;
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    if (source.sourceVersion) paper.sourceVersion = structuredClone(source.sourceVersion);
    const resource = { type: 'third_party', origin: 'paper_source', sourceQuote: quote, sourceQuoteSha256: repair.shaText(quote),
        originalUrl: 'https://example.com/baseline', finalUrl: 'https://example.com/baseline', redirects: [],
        status: 200, availability: 'available', retryable: false };
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: paper.sourceSha256, resources: [resource] };
    const resources = { ...body, identitySha256: daily.stableHash(body) };
    const old = { ...body, resources: [] }; paper.apiReaderResources = { ...old, identitySha256: daily.stableHash(old) };
    paper.apiReaderArticle = '保留的旧公开正文';
    paper.apiReaderFailedBundleHistory = [{ sourceSha256: paper.sourceSha256, fields: { apiReaderResources: resources },
        stages: { apiReaderArticle: { status: 'invalid_output', fingerprint: 'failed-current-reader' } }, contracts: {} }];
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.stages.openSourceScan.fingerprint = 'source-bound-resource-scan';
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceContract = body.contract;
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = resources.identitySha256;
    const scoring = paper.analysisManifest.stages.scoringAudit;
    scoring.scoringContract = 'api-scoring-audit-v2'; scoring.audit = {}; scoring.auditSha256 = deep.stableFingerprint({});
    scoring.stabilityWarning = false; scoring.outputAnalysisSha256 = repair.shaText(paper.analysis);
    delete paper.analysisManifest.stages.apiReaderArticle;
    const run = callback => daily.withDailyFreshAnalysisContext(plan, () =>
        engine.withPaperAnalysisLock(paper, () => fresh.withFreshPaperContext(paper, callback)));
    return { paper, source, resources, plan, root, run };
}
test('失败资源束沿当前实际上游与封存引文只在内存恢复，公开束字节不变', async t => {
    const f = await fixture(t), before = JSON.stringify(f.paper);
    await f.run(() => {
        assert.equal(require('../scripts/lib/completed-reader-upstream').completedReaderUpstream(f.paper, f.source), true);
        const handle = recovery.prepareRecoveryReaderResources(f.paper, f.source);
        assert.ok(handle);
        assert.deepEqual(recovery.readRecoveryReaderResources(handle, f.paper, f.source), f.resources);
        assert.equal(JSON.stringify(f.paper), before);
        assert.equal(handle.proof.resourceEvidenceSha256, f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256);
    });
});
test('源、上游、资源束或handle变化一律拒绝，不混签旧公开稿', async t => {
    const f = await fixture(t);
    await f.run(() => {
        const handle = recovery.prepareRecoveryReaderResources(f.paper, f.source);
        assert.ok(handle);
        assert.throws(() => recovery.readRecoveryReaderResources(structuredClone(handle), f.paper, f.source), /须保有未改变/);
        const originalFingerprint = f.paper.analysisManifest.stages.openSourceScan.fingerprint;
        f.paper.analysisManifest.stages.openSourceScan.fingerprint = 'changed upstream';
        assert.throws(() => recovery.readRecoveryReaderResources(handle, f.paper, f.source), /须保有未改变/);
        f.paper.analysisManifest.stages.openSourceScan.fingerprint = originalFingerprint;
        handle.resources.resources[0].status = 404;
        assert.throws(() => recovery.readRecoveryReaderResources(handle, f.paper, f.source), /须保有未改变/);
    });
});
test('仅资源SHA相符不足，伪造非连续来源引文不能恢复', async t => {
    const f = await fixture(t);
    const bad = structuredClone(f.resources);
    bad.resources[0].sourceQuote += ' This sentence never appeared in the sealed source.';
    bad.resources[0].sourceQuoteSha256 = repair.shaText(bad.resources[0].sourceQuote);
    const { identitySha256, ...body } = bad; bad.identitySha256 = daily.stableHash(body);
    f.paper.apiReaderFailedBundleHistory[0].fields.apiReaderResources = bad;
    f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = bad.identitySha256;
    await f.run(() => assert.throws(() => recovery.prepareRecoveryReaderResources(f.paper, f.source),
        error => error.code === 'READER_RESOURCE_IDENTITY_INVALID'));
});
test('不同封存源、未完成上游或没有当前资源证明时不回收旧资源', async t => {
    const f = await fixture(t);
    await f.run(() => {
        f.paper.apiReaderFailedBundleHistory[0].sourceSha256 = 'f'.repeat(64);
        assert.equal(recovery.prepareRecoveryReaderResources(f.paper, f.source), null);
        f.paper.apiReaderFailedBundleHistory[0].sourceSha256 = f.paper.sourceSha256;
        f.paper.analysisManifest.stages.scoringAudit.status = 'failed';
        assert.equal(recovery.prepareRecoveryReaderResources(f.paper, f.source), null);
    });
});
