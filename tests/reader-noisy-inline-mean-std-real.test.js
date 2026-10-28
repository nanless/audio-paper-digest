'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-noisy-inline-mean-std-real-20261027.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('真实Noisy原PDF完整平表在日更四源scope热核与保存后冷核提供同一WER列单位', async t => {
    require('../scripts/env-loader').requireExternalRuntime('noisy-inline-uncertainty-real-test');
    await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(async () => {
        const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
        const fresh = require('../scripts/lib/fresh-analysis-context');
        const quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
        const columns = require('../scripts/lib/reader-sealed-pdf-column-units');
        const deep = require('../scripts/deep-analyzer');
        const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noisy-real-unit-'));
        const previous = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(temp, 'runs');
        t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(temp, { recursive: true, force: true }); });
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-27', batchId: 'noisy-real-pdf-unit-fixture',
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
        const files = ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name =>
            path.join(plan.sourcesDir, fixture.paperId, 'generation-000001', name));
        const before = files.map(file => fs.readFileSync(file));
        // The normal Reader parser inserts spaces around ±. Both literal
        // values remain in the same cell and must still match the whole PDF.
        const normalizedView = fixture.view.map(row => row.map(value => value.replace(/±/gu, ' ± ')));
        const table = { header: normalizedView[0], rows: normalizedView.slice(1) };
        let evidence;
        await daily.withDailyFreshAnalysisContext(plan, () => {
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
            return fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(source.structuredArtifacts, fixture.paperId, () => {
                evidence = quotes.evidenceForQuotes(fixture.pdfSourceQuotes);
                const proof = columns.deriveBundle(quotes.verifiedSourceContext().expectation,
                    normalizedView, fixture.pdfSourceQuotes);
                assert.equal(proof.contract, 'reader-sealed-pdf-literal-column-units-v1');
                assert.equal(proof.valueOrigin, 'sealed_pdf');
                assert.equal(proof.sourceTableOrdinal, undefined);
                assert.deepEqual(proof.units, [{ column: 1, unit: '%', values: ['6.7', '16.3', '9.3', '9.1'] }]);
                assert.equal(proof.rows[1][2], '8.74±0.26');
                assert.equal(proof.horizontalRules.length, 4);
                assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []);
                for (const change of [v => { v.rows[1][2] = '8.74±0.27'; },
                    v => { v.rows[1][1] = '16.276'; }, v => { v.header[1] = 'WER (dB)'; },
                    v => { v.rows[1][0] = 'Noisy'; }]) {
                    const bad = structuredClone(table); change(bad);
                    assert.ok(deep.readerTableHeaderUnitEvidenceFailures(bad, evidence).length > 0);
                }
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
        const originalPdf = fs.readFileSync(files[1]);
        try {
            fs.appendFileSync(files[1], 'changed');
            assert.throws(() => quotes.withSavedPaper(paper, () => columns.coverage(table, evidence)), /SHA|sha|changed|hash|哈希|来源/);
        } finally { fs.writeFileSync(files[1], originalPdf); }
        assert.ok(deep.readerTableHeaderUnitEvidenceFailures(table, evidence).length > 0,
            'proof cannot escape its verified source scope');
        files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    });
});
