'use strict';

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

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-fresh-source-plan-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    return { root, sourceRoot: Config.FILES.dailyFreshSourceRunsDir };
}

function sourcePayload(id) {
    const text = `Fresh daily official HTML text for ${id}; methods, data, results, and limitations. `.repeat(120);
    const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(Buffer.from(text)),
        tables: [{ ordinal: 1, caption: 'Result table', rows: [] }], formulas: [],
        figures: [{ ordinal: 1, caption: 'Architecture', images: [{ kind: 'external_url', url: `https://arxiv.org/html/${id}/figure.png` }] }] };
    structuredArtifacts.payloadSha256 = sha(JSON.stringify({ ...structuredArtifacts }));
    return {
        text, source: 'html', sourceId: `${id}v2`, url: `https://arxiv.org/html/${id}v2`,
        fetchedAt: new Date().toISOString(), imageInfos: [{ url: `https://arxiv.org/html/${id}/figure.png`, caption: 'Architecture' }],
        structuredArtifacts, readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: []
    };
}

test('default daily source plan seals PDF/TXT/manifest before its analysis callback and never invokes a legacy text path', async t => {
    const f = fixture(t); const id = '2609.12345'; let captureCalls = 0; let legacyTextCalls = 0; let analysisCalls = 0;
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch',
        papers: [{ arxivId: id, title: 'Daily source test', abstract: 'metadata only' }] });

    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => {
            captureCalls++;
            return require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
                fetchText: async requested => sourcePayload(requested),
                fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.7\nDaily sealed ${requested}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
            });
        }
    });
    assert.equal(captureCalls, 1);
    const directory = path.join(plan.sourcesDir, id, 'generation-000001');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'source-manifest.json'), 'utf8'));
    assert.match(manifest.pdf.responseSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.text.responseSha256, /^[a-f0-9]{64}$/);
    assert.ok(fs.readFileSync(path.join(directory, 'source.pdf')).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal(fs.readFileSync(path.join(directory, 'source.txt'), 'utf8'), sourcePayload(id).text);

    const analyze = daily.createDailyAnalyzeFn(plan, {
        analyze: async paper => {
            analysisCalls++;
            assert.equal(paper.fullText, undefined, 'daily caller must not inject legacy/caller text');
            assert.equal(fresh.getFreshAnalysisContext().runId, plan.runId);
            assert.equal(fresh.isDailyFreshSourceScope(), true,
                'daily source bundles retain the ephemeral-pixel Reader gate');
            const source = direct.getDirectRewriteSource(paper);
            assert.equal(source.text, sourcePayload(id).text, 'analysis receives the sealed TXT, not a legacy fetch result');
            assert.equal(source.freshSourceDescriptor.sourceManifestSha256, manifest && sha(fs.readFileSync(path.join(directory, 'source-manifest.json'))));
            const active = direct.getDirectRewriteAnalysisContext();
            assert.equal(active.readerAttemptsDir, plan.readerAttemptsDir, 'daily Reader candidates stay in the fresh run root');
            const materialized = await active.materializeReaderFigures([
                { ordinal: 1, url: `https://arxiv.org/html/${id}/figure.png` }
            ], id);
            assert.equal(materialized[0].rawBytes.toString(), 'ephemeral-daily-pixels');
            assert.equal(legacyTextCalls, 0, 'sealed source is ready before analysis; legacy text acquisition is never called');
            return { arxivId: id, analysis: 'new analysis generated from sealed source only' };
        },
        fetchFigure: async () => ({ bytes: Buffer.from('ephemeral-daily-pixels'), mediaType: 'image/png' })
    });
    await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id, title: 'Daily source test' }));
    assert.equal(analysisCalls, 1);
    assert.equal(legacyTextCalls, 0);
    const allFiles = [];
    const visit = directoryPath => {
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            const filename = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) visit(filename); else allFiles.push(path.relative(plan.runDir, filename));
        }
    };
    visit(plan.runDir);
    assert.deepEqual(allFiles.sort(), [
        'run.json',
        `sources/${id}/generation-000001/source-manifest.json`,
        `sources/${id}/generation-000001/source-runtime.json`,
        `sources/${id}/generation-000001/source.pdf`,
        `sources/${id}/generation-000001/source.txt`
    ]);
    assert.doesNotMatch(JSON.stringify(manifest), /(?:rawBytes|assetBytes|base64|image-cache|api-reader-assets)/);
});

test('daily source plan clears a legacy successful analysis unless it proves the current sealed manifest', async t => {
    fixture(t); const id = '2609.12346';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch-2', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`), url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const prepared = daily.prepareDailyPaper({ arxivId: id, analysis: 'legacy body', parsed: { score: 9 },
        apiReaderArticle: 'legacy reader', sourceSha256: '0'.repeat(64), fullText: 'legacy full text',
        imageUrls: ['https://old.example/poison.png'], allImageUrls: ['https://old.example/poison.png'],
        selectedImageUrls: ['https://old.example/poison.png'],
        analysisRecoveryImageManifest: { candidates: [{ url: 'https://old.example/poison.png' }] } }, plan);
    assert.equal(prepared.analysis, undefined);
    assert.equal(prepared.parsed, undefined);
    assert.equal(prepared.apiReaderArticle, undefined);
    assert.equal(prepared.fullText, undefined);
    assert.equal(prepared.imageUrls, undefined);
    assert.equal(prepared.allImageUrls, undefined);
    assert.equal(prepared.selectedImageUrls, undefined);
    assert.equal(prepared.analysisRecoveryImageManifest, undefined);
    assert.equal(daily.isPaperBoundToPlan(prepared, plan), false);
});

test('daily source reference replays only the exact sealed run manifest', async t => {
    fixture(t); const id = '2609.12347';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch-3', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`), url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const reference = daily.dailyFreshSourceReference(plan);
    const replayed = daily.readDailyFreshSourcePlan(reference);
    assert.equal(replayed.runId, plan.runId);
    assert.equal(daily.readDailyFreshSource(replayed, { arxivId: id }).freshSourceDescriptor.sourceGeneration, 1);
    assert.throws(() => daily.readDailyFreshSourcePlan({ ...reference, runManifestSha256: '0'.repeat(64) }), /SHA drifted/);
});

test('direct daily scope rejects caller-held legacy image URLs even if a caller bypasses paper preparation', () => {
    const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
    const deep = require('../scripts/deep-analyzer.js');
    const source = { paperId: 'arxiv:2609.12349', source: 'html', sourceId: '2609.12349', text: 'fresh source text',
        imageInfos: [], structuredArtifacts: { payloadSha256: 'a'.repeat(64), tables: [], formulas: [], figures: [] } };
    const result = direct.withDirectRewriteAnalysisSource({ paperId: source.paperId, route: 'arxiv-fresh-fetch',
        sourceDetails: source, readerAttemptsDir: path.join(os.tmpdir(), 'daily-direct-reader-attempts') }, () => (
        deep.getPreProvidedImageUrls({ imageUrls: ['https://old.example/poison.png'],
            analysisRecoveryImageManifest: { candidates: [{ url: 'https://old.example/poison.png' }] } })
    ));
    assert.deepEqual(result, []);
});
