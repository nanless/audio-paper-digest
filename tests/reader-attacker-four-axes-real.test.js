'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-attacker-four-axes-real-20261027.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('真实四张攻击条件整表在四源热核与保存冷核保留完整均值误差箭头δ和参考作用域', async t => {
    require('../scripts/env-loader').requireExternalRuntime('attacker-four-axis-real-test');
    await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(async () => {
        const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
        const fresh = require('../scripts/lib/fresh-analysis-context');
        const quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
        const columns = require('../scripts/lib/reader-sealed-pdf-column-units');
        const deep = require('../scripts/deep-analyzer');
        const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'attacker-axis-real-'));
        const previous = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(temp, 'runs');
        t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(temp, { recursive: true, force: true }); });
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-27', batchId: 'attacker-four-axes-real-pdf',
            papers: [{ arxivId: fixture.paperId, title: fixture.title }] });
        const pdf = Buffer.from(fixture.pdf.base64, 'base64');
        assert.equal(sha(pdf), fixture.provenance.sourceFiles['source.pdf']);
        assert.equal(sha(fixture.sourceText), fixture.provenance.sourceFiles['source.txt']);
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
        const all = [];
        await daily.withDailyFreshAnalysisContext(plan, () => {
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
            return fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(source.structuredArtifacts, fixture.paperId, () => {
                for (const n of ['2', '4', '5', '7']) {
                    const view = fixture.views[n], pdfQuotes = [fixture.pdfSourceQuotes[n]];
                    const table = { header: view[0], rows: view.slice(1) };
                    const evidence = quotes.evidenceForQuotes(pdfQuotes);
                    const proof = columns.deriveBundle(quotes.verifiedSourceContext().expectation, view, pdfQuotes);
                    assert.match(proof.axisProfile, /^complete-literal-attacker-/);
                    assert.equal(proof.valueOrigin, 'sealed_pdf');
                    assert.deepEqual(proof.renderedView, view);
                    assert.equal(proof.deltaReference, n === '2' ? 'same-frontend-SpInv+TTS' : 'first-row-of-this-table');
                    assert.equal(proof.errorRateDeltaUnit, 'percentage points');
                    assert.equal(proof.deltaComputedBeforeRounding, true);
                    assert.equal(proof.deltaGlyphs.length, {2: 12, 4: 8, 5: 12, 7: 4}[n]);
                    assert.ok(proof.units.every(u => u.column > 0));
                    assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []);
                    const forged = structuredClone(evidence); forged[0].pdfSha256 = '0'.repeat(64);
                    assert.throws(() => deep.readerTableHeaderUnitEvidenceFailures(table, forged), /differs/);
                    all.push({ table, evidence });
                }
            }));
        });
        paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
        paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
            structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256 };
        paper.apiReaderPlan = { structuredSourcePayload: deep.readerStructuredSourcePayload(source.structuredArtifacts),
            tableBindings: all.map(({evidence}) => ({ sourceType: 'source_quotes', sourceQuotes: [], sealedPdfQuoteEvidence: evidence })) };
        quotes.withSavedPaper(paper, () => {
            for (const {table, evidence} of all)
                assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []);
        });
        sourceFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
        const original = fs.readFileSync(sourceFiles[1]);
        try {
            fs.appendFileSync(sourceFiles[1], 'wrong-source');
            assert.throws(() => quotes.withSavedPaper(paper, () => columns.coverage(all[0].table, all[0].evidence)), /SHA|sha|changed|hash|哈希|来源/);
        } finally { fs.writeFileSync(sourceFiles[1], original); }
        assert.ok(deep.readerTableHeaderUnitEvidenceFailures(all[0].table, all[0].evidence).length,
            'PDF unit evidence cannot escape its verified sealed-source scope');
    });
});
