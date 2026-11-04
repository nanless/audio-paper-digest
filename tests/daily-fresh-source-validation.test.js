'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const { validateDailyFreshSourceRun } = require('../scripts/validate-data-files.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('日更当前校验会复核已保存的 TXT/PDF 配对和来源', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-source-validation-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const id = '2609.12348';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'validation-batch', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => {
                const text = `fresh official text ${requested} `.repeat(500);
                const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
                return { text, source: 'html', sourceId: requested, url: `https://arxiv.org/html/${requested}`,
                    fetchedAt: '2026-09-07T00:00:00.000Z', imageInfos: [], structuredArtifacts: artifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: '2026-09-07T00:00:01.000Z' })
        }) });
    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    const proof = { ...require('../scripts/lib/daily-source-format').currentHeader('fresh-source-analysis'), runId: plan.runId, sourceGeneration: 1,
        sourceManifestSha256: source.freshSourceDescriptor.sourceManifestSha256,
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false };
    const paper = { arxivId: id, freshRewriteProvenance: proof, sourceSha256: proof.sourceSha256,
        analysisManifest: { freshRewriteProvenance: structuredClone(proof), sourceAcquisition: { sourceSha256: proof.sourceSha256 } } };
    const data = { batchDate: '2026-09-07', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] };
    assert.deepEqual(daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun).paperIds, [id]);
    const issues = []; validateDailyFreshSourceRun(path.join(root, 'deep-analysis-result.json'), data, data.papers, issues);
    assert.deepEqual(issues, []);
    fs.appendFileSync(path.join(plan.sourcesDir, id, 'generation-000001', 'source.pdf'), 'drift');
    const drifted = []; validateDailyFreshSourceRun(path.join(root, 'deep-analysis-result.json'), data, data.papers, drifted);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0], /无法读取或核验封存的论文来源/);
});

test('官方 PDF 全部候选 404 的论文被跳过，分析集合与来源校验按剩余论文核对', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-source-skip-validation-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const ids = ['2609.12401', '2609.12402'];
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'skip-batch',
        papers: ids.map(arxivId => ({ arxivId })) });
    const outcome = await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => {
        if (options.arxivId === ids[1]) {
            const error = new Error(`arXiv PDF ${options.arxivId} download failed: HTTP 404`);
            error.code = 'ARXIV_PDF_NOT_FOUND'; error.status = 404; error.arxivId = options.arxivId;
            throw error;
        }
        return require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
            fetchText: async requested => {
                const text = `fresh official text ${requested} `.repeat(500);
                const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
                return { text, source: 'html', sourceId: requested, url: `https://arxiv.org/html/${requested}`,
                    fetchedAt: '2026-09-07T00:00:00.000Z', imageInfos: [], structuredArtifacts: artifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: '2026-09-07T00:00:01.000Z' })
        });
    } });
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.skipped.length, 1);
    const skip = require('../scripts/lib/daily-source-skip.js');
    skip.writeDailySourceSkips(plan, outcome.skipped);
    const source = daily.readDailyFreshSource(plan, { arxivId: ids[0] });
    const proof = { ...require('../scripts/lib/daily-source-format').currentHeader('fresh-source-analysis'),
        runId: plan.runId, sourceGeneration: 1,
        sourceManifestSha256: source.freshSourceDescriptor.sourceManifestSha256,
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false };
    const paper = { arxivId: ids[0], freshRewriteProvenance: proof, sourceSha256: proof.sourceSha256,
        analysisManifest: { freshRewriteProvenance: structuredClone(proof), sourceAcquisition: { sourceSha256: proof.sourceSha256 } } };
    const data = { batchDate: '2026-09-07', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] };
    const issues = [];
    validateDailyFreshSourceRun(path.join(root, 'deep-analysis-result.json'), data, data.papers, issues);
    assert.deepEqual(issues, []);
    // 把被跳过的论文也算进分析集合时，集合核对必须报错，不能把跳过当成完成。
    const wrong = [paper, { ...paper, arxivId: ids[1] }];
    const wrongIssues = [];
    validateDailyFreshSourceRun(path.join(root, 'deep-analysis-result.json'),
        { ...data, papers: wrong }, wrong, wrongIssues);
    assert.ok(wrongIssues.some(issue => /不完全一致/.test(issue)));
});
