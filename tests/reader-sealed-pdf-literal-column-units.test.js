'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib'), crypto = require('node:crypto');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/reader-daily-real-unit-tables-20261020.json.gz'))));
const stacked = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/reader-geometry-caption-units-20261023-real.json.gz'))));
fixture.papers.push({ ...stacked, sectionIndex: 0, bindingIndex: 0,
    fullTablePdfQuotes: stacked.pdfSourceQuotes,
    draft: { sections: [{ body: stacked.tableMarkdown }], tableBindings: [{ pdfSourceQuotes: stacked.pdfSourceQuotes }] } });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('真实CASE/SynerGest/MOMO/Geometry完整PDF表经正常封存scope热解析、保存稿冷核同一单位guard且拒绝伪能力', async t => {
    require('../scripts/env-loader').requireExternalRuntime('real-sealed-pdf-literal-column-test');
    await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(async () => {
        const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
        const fresh = require('../scripts/lib/fresh-analysis-context'), quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
        const columns = require('../scripts/lib/reader-sealed-pdf-column-units'), deep = require('../scripts/deep-analyzer');
        const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'real-pdf-unit-table-test-'));
        const previous = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(temp, 'runs');
        t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(temp, { recursive: true, force: true }); });
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-20', batchId: 'real-complete-table-pages',
            papers: fixture.papers.map(p => ({ arxivId: p.arxivId, title: p.title })) });
        await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => {
            const item = fixture.papers.find(p => p.arxivId === args.arxivId.replace(/v\d+$/, ''));
            const bytes = Buffer.from(item.pdf.base64, 'base64');
            assert.equal(sha(bytes), item.pdf.sha256);
            return require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
                fetchText: async id => ({ text: item.sourceText, structuredArtifacts: item.structuredArtifacts, source: 'html', sourceId: id,
                    url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-20T00:00:00.000Z', imageInfos: [], warnings: [] }),
                fetchPdf: async id => ({ bytes, url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-20T00:00:01.000Z' }) });
        } });
        for (const item of fixture.papers) {
            const paper = { arxivId: item.arxivId, analysisManifest: { stages: {} } }, source = daily.readDailyFreshSource(plan, paper);
            const raw = item.fullTablePdfQuotes || item.draft.tableBindings[item.bindingIndex].pdfSourceQuotes;
            const table = require('../scripts/analysis-contract').extractMarkdownTables(item.draft.sections[item.sectionIndex].body)[0];
            if (item.arxivId === '2610.25342') table.rows[2][0] = 'SelfTalk [5]';
            const files = ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name =>
                path.join(plan.sourcesDir, item.arxivId, 'generation-000001', name));
            const before = files.map(file => fs.readFileSync(file));
            let evidence;
            await daily.withDailyFreshAnalysisContext(plan, () => {
                fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
                return fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(source.structuredArtifacts, item.arxivId, () => {
                    evidence = quotes.evidenceForQuotes(raw);
                    const proof = columns.deriveBundle(quotes.verifiedSourceContext().expectation, [table.header, ...table.rows], raw);
                    assert.equal(proof.contract, 'reader-sealed-pdf-literal-column-units-v1');
                    assert.equal(proof.sourceTableOrdinal, undefined);
                    assert.equal(proof.implementationFiles.find(v => v.file === 'reader_sealed_pdf_literal_column_units.py').sha256,
                        sha(fs.readFileSync(path.join(__dirname, '../scripts/reader_sealed_pdf_literal_column_units.py'))));
                    assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table, evidence), []);
                    if (item.arxivId === '2610.29778') {
                        assert.deepEqual(proof.units.map(v => [v.column, v.unit]), [[1, 'db'], [5, 'db']]);
                        const crossed = structuredClone(table);
                        crossed.header[1] = 'Circular SI-SDR (dB)';
                        assert(deep.readerTableHeaderUnitEvidenceFailures(crossed, evidence).length > 0);
                    }
                    for (const mutate of [v => v.rows.pop(), v => v.rows.reverse(), v => v.header.push('Extra (s)'),
                        v => { v.rows[1][v.header.length - (item.arxivId === '2610.25342' ? 2 : 1)] = '99'; },
                        v => { if (item.arxivId === '2610.24031') v.rows[1][0] = 'Seamless Interaction';
                            else if (item.arxivId === '2610.25342') v.rows[0][6] = '1.97M (1.09%)';
                            else v.rows[0][1] = '0.720 ± 0.001'; }]) {
                        const bad = structuredClone(table); mutate(bad);
                        assert(deep.readerTableHeaderUnitEvidenceFailures(bad, evidence).length > 0);
                    }
                    if (item.arxivId === '2610.24522') {
                        assert.deepEqual(proof.units.map(v => [v.column, v.unit]), [[7, '%']]);
                        for (const [column, value] of [[1, 'R-precision Top1 (%)'], [7, 'Skating Ratio (%) ↑'], [1, 'R-precision Top1 ↓']]) {
                            const bad = structuredClone(table); bad.header[column] = value;
                            assert(deep.readerTableHeaderUnitEvidenceFailures(bad, evidence).length > 0);
                        }
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
            assert(deep.readerTableHeaderUnitEvidenceFailures(table, evidence).length > 0);
            files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
        }
    });
});
