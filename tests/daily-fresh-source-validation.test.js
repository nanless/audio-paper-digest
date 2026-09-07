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

test('daily current validation replays the sealed TXT/PDF pair and provenance', async t => {
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
    const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId, sourceGeneration: 1,
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
    assert.match(drifted[0], /sealed source/);
});
