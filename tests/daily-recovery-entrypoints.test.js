'use strict';

// These are orchestration tests, not network/LLM tests.  They seal a tiny
// official-looking PDF/TXT pair through the real source-store contract, then
// run every daily recovery entrypoint with its analyzer/Reader operation
// mocked.  The mocks assert that the only text they can see is the sealed
// bundle and that the active figure context is ephemeral/direct.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ID = '2609.12345';
const DATE = '2026-09-07';

function sourcePayload(id) {
    const text = `Official daily text for ${id}; method, data, result and limitation. `.repeat(160);
    const structuredArtifacts = {
        version: 1,
        source: 'html',
        flattenedTextSha256: sha(Buffer.from(text)),
        tables: [], formulas: [], figures: []
    };
    structuredArtifacts.payloadSha256 = sha(JSON.stringify({ ...structuredArtifacts }));
    return {
        text, source: 'html', sourceId: `${id}v1`, url: `https://arxiv.org/html/${id}v1`,
        fetchedAt: '2026-09-07T00:00:00.000Z', imageInfos: [], structuredArtifacts,
        readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: []
    };
}

function writeJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function mockBatch(label, seen) {
    return async (papers, options) => {
        assert.equal(papers.length, 1, `${label} receives the pending canonical paper`);
        const prepared = await options.preparePaperLocked(papers[0]);
        assert.equal(prepared.skip, false, `${label} does not preserve unbound legacy analysis`);
        assert.equal(prepared.paper.fullText, undefined, `${label} never injects legacy caller text`);
        await options.analyzeFn(prepared.paper);
        return { stats: { total: 1, success: 0, failed: 1, skipped: 0, durationTotal: 0, sourceCounts: {} } };
    };
}

test('daily recovery entrypoints replay only current sealed PDF/TXT sources and Reader refresh has a direct ephemeral context', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-recovery-entrypoints-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers']
        .map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-source-runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'current', 'deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root, 'current', 'filtered-papers.json');
    Config.FILES.papers = path.join(root, 'current', 'papers.json');
    t.after(() => {
        Object.assign(Config.FILES, previous);
        fs.rmSync(root, { recursive: true, force: true });
    });

    // Load after Config is redirected because batch/reanalyze intentionally
    // capture their configured daily canonical path at module initialisation.
    const deepOnly = require('../scripts/deep-analysis-only.js');
    const batch = require('../scripts/batch-analyze.js');
    const reanalyze = require('../scripts/reanalyze.js');
    const reader = require('../scripts/refresh-api-reader.js');
    const paper = { arxivId: ID, title: 'Sealed recovery fixture', abstract: 'metadata only' };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: DATE, batchId: 'recovery-fixture', papers: [paper] });
    let captureCalls = 0;
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => {
            captureCalls += 1;
            return require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
                fetchText: async requested => sourcePayload(requested),
                fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.7\n${requested}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: '2026-09-07T00:00:00.000Z' })
            });
        }
    });
    assert.equal(captureCalls, 1);
    // This is deliberately a structurally successful but unbound old
    // canonical. All three analysis entries must select it again instead of
    // treating success as a reason to bypass the current sealed generation.
    const unboundLegacy = validAnalysisPaper(ID, { title: paper.title });
    const envelope = {
        batchDate: DATE,
        status: 'failed',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [unboundLegacy]
    };
    writeJson(Config.FILES.filteredPapers, { batchDate: DATE, status: 'complete', papers: [paper] });
    writeJson(Config.FILES.deepAnalysisResult, envelope);
    writeJson(Config.FILES.papers, { generation: 0, papers: {} });

    const seen = [];
    const analyze = async recovered => {
        seen.push({
            id: recovered.arxivId,
            text: direct.getDirectRewriteSource(recovered).text,
            dailyScope: fresh.isDailyFreshSourceScope(),
            runId: direct.getDirectRewriteAnalysisContext().runId
        });
        return { analysis: '' };
    };
    await deepOnly.runDeepAnalysis({ date: DATE, analyzeFn: analyze, analyzeBatch: mockBatch('deep-only', seen) });
    await batch.main({ analyzeFn: analyze, analyzeBatch: mockBatch('batch', seen) });
    await reanalyze.reanalyzeAll({ analyzeFn: analyze, analyzeBatch: mockBatch('reanalyze', seen) });
    assert.equal(seen.length, 3);
    for (const item of seen) {
        assert.equal(item.id, ID);
        assert.equal(item.text, sourcePayload(ID).text);
        assert.equal(item.dailyScope, true);
        assert.equal(item.runId, plan.runId);
    }
    assert.equal(captureCalls, 1, 'recovery must replay the sealed pair and cannot recapture/fetch');

    // Make the same canonical complete solely to exercise the Reader branch;
    // the custom operation proves source and figure scope without a model call.
    const complete = validAnalysisPaper(ID, { title: paper.title });
    const descriptor = daily.readDailyFreshSource(plan, complete).freshSourceDescriptor;
    complete.freshRewriteProvenance = {
        contract: 'fresh-source-analysis-v1', runId: plan.runId,
        sourceGeneration: descriptor.sourceGeneration,
        sourceManifestSha256: descriptor.sourceManifestSha256,
        sourceSha256: descriptor.sourceSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false
    };
    writeJson(Config.FILES.deepAnalysisResult, {
        batchDate: DATE, status: 'complete', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [complete]
    });
    let readerSource = null;
    const refreshed = await reader.refreshApiReader(ID, {
        authorsOnly: true,
        operations: {
            authors: (canonical, source) => {
                readerSource = {
                    text: source.text,
                    dailyScope: fresh.isDailyFreshSourceScope(),
                    directSource: direct.getDirectRewriteSource(canonical).text,
                    hasEphemeralMaterializer: typeof direct.getDirectRewriteAnalysisContext().materializeReaderFigures === 'function'
                };
                return { ...canonical, apiReaderAuthors: { authors: [] } };
            }
        }
    });
    assert.equal(normalized(refreshed), ID);
    assert.deepEqual(readerSource, {
        text: sourcePayload(ID).text,
        dailyScope: true,
        directSource: sourcePayload(ID).text,
        hasEphemeralMaterializer: true
    });
    assert.equal(captureCalls, 1, 'Reader recovery also cannot recapture or use a legacy fetch path');
});

function normalized(paper) { return String(paper?.arxivId || '').replace(/v\d+$/, ''); }

test('daily recovery source plan fails closed when the canonical has no sealed bundle reference', () => {
    assert.throws(() => daily.requireDailyFreshSourceRecoveryPlan({ batchDate: DATE, papers: [{ arxivId: ID }] }, {
        label: 'test recovery'
    }), /requires current dailyFreshSourceRun/);
});
