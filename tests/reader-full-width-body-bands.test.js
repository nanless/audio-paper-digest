'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const units = require('../scripts/lib/reader-source-table-column-units');
const { extractMarkdownTables } = require('../scripts/analysis-contract');
const stop = require('../scripts/lib/analysis-stop-control');
const fixture = require('./fixtures/reader-real-sentry-full-width-bands.json');
const real = JSON.parse(zlib.gunzipSync(Buffer.from(fixture.payloadGzipBase64, 'base64')));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const original = real.runtime.structuredArtifacts.tables.find(value => value.ordinal === 2);
const rendered = extractMarkdownTables(real.readerSection.body)[0];
const captionStart = real.sourceText.indexOf('TABLE II: Detection Accuracy');
const caption = real.sourceText.slice(captionStart, real.sourceText.indexOf('\nAI Model', captionStart)).trim();

test('真实完整SENTRY原DOM全跨列信道带保留来源，只给唯一原数据格EER百分比', () => {
    assert.equal(sha(Buffer.from(real.pdfBase64, 'base64')), fixture.provenance.files['source.pdf'].sha256);
    assert.equal(sha(real.sourceText), fixture.provenance.files['source.txt'].sha256);
    assert.equal(original.cells.filter(cell => cell.colspan === 5).length, 2);
    assert(real.sourceText.includes(caption));
    const covered = units.coverageFromTables(rendered, [caption], [original]);
    assert.equal(covered.length, 12);
    assert(covered.every(cell => cell.column === 4 && cell.unit === '%' && cell.bodyBandDomSha256s.length === 2));
    assert.deepEqual(covered.map(cell => cell.value), ['0','0','0.13','0.64','1.57','1.93','1.6','1.89','2.69','4.41','4.58','6.95']);
    // This capability does not normalize the source's 22.0522.05/88 display,
    // prove group prose, or allow a plain caller to obtain source authority.
    assert(original.matrix.some(row => /22\.0522\.05/u.test(row[0])));
    assert.deepEqual(units.coverage(rendered, [caption]), []);
});

test('全跨列适配仍拒部分span、rowspan、错格/表头/单位、重复行身份与跨表借证', () => {
    const mutate = callback => { const source = structuredClone(original); callback(source); return source; };
    const table = callback => { const value = structuredClone(rendered); callback(value); return value; };
    const bands = original.cells.filter(cell => cell.colspan === 5);
    for (const source of [
        mutate(value => value.cells.find(cell => cell.colspan === 5).colspan = 4),
        mutate(value => value.cells.find(cell => cell.colspan === 5).rowspan = 2),
        mutate(value => value.cells.find(cell => cell.row === 0 && cell.column === 4).rowspan = 2),
        mutate(value => value.cells.push(structuredClone(value.cells.find(cell => cell.colspan === 5)))),
        mutate(value => value.matrix[bands[0].row][4] = 'unowned band text'),
        mutate(value => { const c = value.cells.find(cell => cell.colspan === 5); c.text = ''; value.matrix[c.row].fill(''); }),
        mutate(value => value.cells.find(cell => cell.row === 2 && cell.column === 4).text = '9.99'),
        mutate(value => value.cells.find(cell => cell.colspan === 5).sourceDomSha256 = 'forged')
    ]) assert.deepEqual(units.coverageFromTables(rendered, [caption], [source]), []);
    assert.deepEqual(units.coverageFromTables(rendered, ['Some other table reports accuracy and EER (%).'], [original]), []);
    assert.deepEqual(units.coverageFromTables(rendered, [caption], [original, structuredClone(original)]), []);
    assert.deepEqual(units.coverageFromTables(table(t => t.header[4] = 'EER (ms)'), [caption], [original]), []);
    assert.deepEqual(units.coverageFromTables(table(t => t.header[4] = 'Other (%)'), [caption], [original]), []);
    const changed = table(t => t.rows.find(row => row[0] === 'A06')[4] = '9.95');
    assert(!units.coverageFromTables(changed, [caption], [original]).some(value => value.rowName === 'A06'));
    const repeated = mutate(value => {
        const old = value.cells.find(cell => cell.text === 'A06');
        old.text = 'HiFi-GAN'; value.matrix[old.row][0] = 'HiFi-GAN';
    });
    assert(!units.coverageFromTables(rendered, [caption], [repeated]).some(value => value.rowName === 'HiFi-GAN'));
});

test('真实四源完整表热核/冷读均依原HTML caption和原数据格；脱离能力及源漂移拒绝', async t => stop.withModelRequestsForbidden(async () => {
    const config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context'), quotes = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
    const deep = require('../scripts/deep-analyzer');
    const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sentry-real-bands-'));
    const beforeRoot = config.FILES.dailyFreshSourceRunsDir;
    config.FILES.dailyFreshSourceRunsDir = path.join(temp, 'runs');
    t.after(() => { config.FILES.dailyFreshSourceRunsDir = beforeRoot; fs.rmSync(temp, { recursive: true, force: true }); });
    const paper = { arxivId: '2610.24468v1', analysisManifest: { stages: {} } };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-20', batchId: 'real-sentry-bands', papers: [{ arxivId: paper.arxivId, title: fixture.provenance.title }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text: real.sourceText, structuredArtifacts: real.runtime.structuredArtifacts,
            source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-20T05:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(real.pdfBase64, 'base64'), url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-20T05:00:01.000Z' })
    }) });
    const source = daily.readDailyFreshSource(plan, paper);
    const check = () => fresh.withFreshPaperContext(paper, () => quotes.withArtifacts(source.structuredArtifacts, paper.arxivId, () => {
        const proofs = quotes.evidenceForQuotes([real.pdfQuote]);
        const bound = [{ quote: caption, sourceQuoteSha256: sha(caption) }, ...proofs];
        assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(rendered, bound), []);
        const bad = structuredClone(rendered); bad.rows.find(row => row[0] === 'A06')[4] = '9.95';
        assert(deep.readerTableHeaderUnitEvidenceFailures(bad, bound).some(value => value.token === '9.95'));
        const forged = structuredClone(source.structuredArtifacts); forged.tables[1].cells[0].text += ' other source';
        assert.throws(() => quotes.withArtifacts(forged, paper.arxivId, () => true), /differ from sealed source/u);
        return units.coverage(rendered, [caption]);
    }));
    let first;
    await daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        first = check();
        const cold = daily.readDailyFreshSource(plan, paper);
        assert.deepEqual(cold.structuredArtifacts, source.structuredArtifacts);
        assert.deepEqual(check(), first);
    });
    assert.equal(first.length, 12);
    assert.deepEqual(units.coverage(rendered, [caption]), []);
    const descriptor = source.freshSourceDescriptor;
    paper.sourceSha256 = descriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition = { sourceSha256: descriptor.sourceSha256,
        structuredArtifactsSha256: descriptor.structuredArtifactsSha256 };
    paper.analysisManifest.stages.apiReaderArticle = { structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
        sourceBindingsSourceTextSha256: descriptor.sourceSha256 };
    paper.apiReaderArticle = real.readerSection.body;
    paper.apiReaderPlan = { structuredSourcePayload: deep.readerStructuredSourcePayload(source.structuredArtifacts),
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes',
            sourceQuotes: [{ quote: caption, sourceQuoteSha256: sha(caption) }] }] };
    assert.deepEqual(units.withSavedPaper(paper, () => units.coverage(rendered,
        paper.apiReaderPlan.tableBindings[0].sourceQuotes)), first);
    const forged = structuredClone(paper); forged.apiReaderPlan.structuredSourcePayload += ' forged source';
    assert.throws(() => units.withSavedPaper(forged, () => true), /source or payload differs/u);
    const runtimeFile = path.join(plan.sourcesDir, '2610.24468', 'generation-000001', 'source-runtime.json');
    const originalBytes = fs.readFileSync(runtimeFile);
    try {
        fs.appendFileSync(runtimeFile, '\nchanged original evidence');
        assert.throws(() => units.withSavedPaper(paper, () => true), /source|来源|sha|SHA|不一致/u);
    } finally { fs.writeFileSync(runtimeFile, originalBytes); }
}));
