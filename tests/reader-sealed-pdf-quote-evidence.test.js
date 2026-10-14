'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
const actualRoot = process.env.PD_GENERIC_PDF_REAL_SOURCE_ROOT;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('独立PDF引文不接受作用域外证明和伪造来源根', () => {
    assert.equal(quotes.document(), null);
    assert.throws(() => quotes.quoteEvidence('A sentence with 12.30 dB'), /actual verified source scope/);
    assert.throws(() => quotes.deriveBundle({ rootDir: '/tmp/untrusted/sources' }), /current daily/);
});

test('真实三封存来源支持原PDF完整连续引文，冷态重放及篡改拒绝，旧来源不变', { skip: !actualRoot }, async t => {
    const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context'), deep = require('../scripts/deep-analyzer');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-pdf-quotes-test-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const originalRun = path.dirname(path.resolve(actualRoot)), runId = path.basename(originalRun);
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(originalRun, 'run.json'), path.join(runDir, 'run.json'));
    const checks = [['2610.09334', 'Table 2: Results on 4-channel'],
        ['2610.09701', 'Table 2 shows that all algorithms'], ['2610.06569', 'On the common USAC1']];
    const originalBytes = new Map();
    for (const [id] of checks) {
        const copy = path.join(runDir, 'sources', id, 'generation-000001');
        fs.mkdirSync(copy, { recursive: true, mode: 0o700 });
        for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
            const source = path.join(actualRoot, id, 'generation-000001', name);
            originalBytes.set(source, sha(fs.readFileSync(source)));
            fs.copyFileSync(source, path.join(copy, name));
        }
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
    for (const [id, anchor] of checks) {
        const paper = { arxivId: id + 'v1', analysisManifest: { stages: {} } };
        const source = daily.readDailyFreshSource(plan, paper), artifacts = source.structuredArtifacts;
        let proof;
        await daily.withDailyFreshAnalysisContext(plan, () => {
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
            paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
            paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
                structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256 };
            return fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(artifacts, id, () => {
                const document = quotes.document(), start = document.normalizedFullText.indexOf(anchor);
                assert(start >= 0);
                const window = document.normalizedFullText.slice(start, start + 1200);
                const quote = window.slice(0, window.lastIndexOf(' '));
                proof = quotes.quoteEvidence(quote);
                assert.equal(proof.valueOrigin, 'sealed_pdf');
                assert.equal(quotes.assertQuoteEvidence(proof), true);
                const fake = structuredClone(proof); fake.rawFragment += ' invented';
                assert.throws(() => quotes.assertQuoteEvidence(fake), /differs/);
                const changed = structuredClone(artifacts); changed.tables[0].caption += ' false';
                assert.throws(() => quotes.withArtifacts(changed, id, () => {}), /differ from sealed source/);
            }));
        });
        paper.apiReaderPlan = { structuredSourcePayload: deep.readerStructuredSourcePayload(artifacts),
            tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
                cellBindings: [], sourceQuotes: [], sealedPdfQuoteEvidence: [proof] }] };
        quotes.withSavedPaper(paper, () => assert.equal(quotes.assertQuoteEvidence(proof), true));
        for (const mutation of [p => p.pdfSha256 = 'a'.repeat(64), p => p.quote += ' invented',
            p => p.normalizedStartCodePoint++, p => p.rawFragmentSha256 = 'a'.repeat(64)]) {
            const bad = structuredClone(paper); mutation(bad.apiReaderPlan.tableBindings[0].sealedPdfQuoteEvidence[0]);
            assert.throws(() => quotes.withSavedPaper(bad, () => {}), /cannot be replayed/);
        }
        const fakeHtml = structuredClone(paper);
        const invented = 'Invented HTML evidence supplies 99.99 percent under unknown conditions.';
        fakeHtml.apiReaderPlan.tableBindings[0].sourceQuotes = [{ quote: invented, sourceQuoteSha256: sha(invented) }];
        assert.throws(() => quotes.withSavedPaper(fakeHtml, () => {}), /absent from the sealed source/);
        assert.equal(quotes.document(), null);
    }
    for (const [file, digest] of originalBytes) assert.equal(sha(fs.readFileSync(file)), digest);
});
