'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-component-k-variant-axis-real-20261027.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('真实Variant完整十行在四源热核与保存冷核绑定两百分列和7+3条件带', async t => {
    require('../scripts/env-loader').requireExternalRuntime('component-k-variant-axis-real-test');
    await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(async () => {
        const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
        const fresh = require('../scripts/lib/fresh-analysis-context');
        const quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
        const columns = require('../scripts/lib/reader-sealed-pdf-column-units');
        const deep = require('../scripts/deep-analyzer');
        const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'variant-axis-real-'));
        const previous = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(temp, 'runs');
        t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(temp, { recursive: true, force: true }); });
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-27', batchId: 'component-k-real-pdf',
            papers: [{ arxivId: fixture.paperId, title: fixture.title }] });
        const pdf = Buffer.from(fixture.pdf.base64, 'base64');
        assert.equal(sha(pdf), fixture.sourceProvenance['source.pdf'].sha256);
        assert.equal(sha(fixture.sourceText), fixture.sourceProvenance['source.txt'].sha256);
        await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args =>
            require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
                fetchText: async id => ({ text: fixture.sourceText, structuredArtifacts: fixture.structuredArtifacts,
                    source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                    fetchedAt: '2026-10-27T00:00:00.000Z', imageInfos: [], warnings: [] }),
                fetchPdf: async id => ({ bytes: pdf, url: `https://arxiv.org/pdf/${id}`,
                    fetchedAt: '2026-10-27T00:00:01.000Z' }) }) });
        const paper = { arxivId: fixture.paperId, analysisManifest: { stages: {} } };
        const source = daily.readDailyFreshSource(plan, paper);
        const sourceFiles = ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => path.join(plan.sourcesDir, fixture.paperId, 'generation-000001', name));
        const before = sourceFiles.map(file => fs.readFileSync(file));
        const table = { header: fixture.view[0], rows: fixture.view.slice(1) };
        let evidence;
        await daily.withDailyFreshAnalysisContext(plan, () => {
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
            return fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(source.structuredArtifacts, fixture.paperId, () => {
                evidence = quotes.evidenceForQuotes(fixture.pdfSourceQuotes);
                const proof = columns.deriveBundle(quotes.verifiedSourceContext().expectation,
                    fixture.view, fixture.pdfSourceQuotes);
                assert.equal(proof.axisProfile, 'complete-literal-component-k-variant-axis-v1');
                assert.equal(proof.valueOrigin, 'sealed_pdf');
                assert.equal(proof.sourceTableOrdinal, undefined);
                assert.equal(proof.rows.length, 10);
                assert.deepEqual(proof.conditionBands.map(b => b.sourceRows), [[1, 2, 3, 4, 5, 6, 7], [8, 9, 10]]);
                assert.equal(proof.rows[2][0], 'no k-NN term aknn');
                assert.equal(proof.renderedView[7][0], 'ℓ only');
                assert.deepEqual(proof.units.map(u => ({ column: u.column, unit: u.unit, values: u.values })),
                    [1, 2].map(column => ({ column, unit: '%', values: table.rows.map(row => row[column]) })));
                assert.equal(proof.units[0].sourceValues[2], '76.64±0.25');
                assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []);
                const forged = structuredClone(evidence); forged[0].pdfSha256 = '0'.repeat(64);
                assert.throws(() => deep.readerTableHeaderUnitEvidenceFailures(table, forged), /differs/);
            }));
        });
        paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
        paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
            structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256 };
        paper.apiReaderPlan = { structuredSourcePayload: deep.readerStructuredSourcePayload(source.structuredArtifacts),
            tableBindings: [{ sourceType: 'source_quotes', sourceQuotes: [], sealedPdfQuoteEvidence: evidence }] };
        quotes.withSavedPaper(paper, () => assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []));
        sourceFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
        const original = fs.readFileSync(sourceFiles[1]);
        try {
            fs.appendFileSync(sourceFiles[1], 'wrong-source');
            assert.throws(() => quotes.withSavedPaper(paper, () => columns.coverage(table, evidence)), /SHA|sha|changed|hash|哈希|来源/);
        } finally { fs.writeFileSync(sourceFiles[1], original); }
        assert.ok(deep.readerTableHeaderUnitEvidenceFailures(table, evidence).length,
            'PDF unit evidence cannot escape its verified sealed-source scope');
    });
});
