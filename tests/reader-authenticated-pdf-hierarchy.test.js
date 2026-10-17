'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const crypto = require('node:crypto');
const api = require('../scripts/lib/reader-authenticated-pdf-table-evidence');
const sourceApi = require('../scripts/lib/conference-source-context');
const { extractMarkdownTables } = require('../scripts/analysis-contract');

const markdown = '|Method|Client1 EER (%)|Client1 minDCF|Client2 EER (%)|Client2 minDCF|\n'
    + '|---|---|---|---|---|\n|Alpha|1.20|0.81|2.30|0.72|\n|Beta|1.40|0.79|2.50|0.70|';
const table = value => extractMarkdownTables(value)[0];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, flat = false) {
    // This uses the normal extraction/selection/import/plan chain. The generated
    // temporary PDF is synthetic; no real paper is declared complete by a test.
    const python = [
        'import sys,fitz;sys.path.insert(0,"tests/python")',
        'from test_reader_authenticated_pdf_hierarchical_table import fixture',
        flat ? 'd=fitz.open();p=d.new_page();p.insert_text((30,30),"Table 1: Results [%]\\nMethod\\nAccuracy\\nAlpha\\n90.0\\nBeta\\n91.0",fontsize=9)'
            : 'd=fitz.open(stream=fixture()[0],filetype="pdf")',
        flat ? 'pass' : 'p=d[0];s="The code is publicly available.";p.insert_text((30,240),s,fontsize=7);p.insert_text((31+fitz.get_text_length(s,fontsize=7),237),"1",fontsize=5);p.insert_text((30,357),"1",fontsize=5);p.insert_text((34,360),"https://github.com/example/research",fontsize=7)',
        'p=d.new_page();p.insert_text((30,30),"Paper 100\\n"+"\\n".join("Full controlled source fixture evidence. "+"x"*50 for _ in range(60)),fontsize=7)',
        'sys.stdout.buffer.write(d.tobytes());d.close()'
    ].join(';');
    const raw = child.execFileSync('bash', ['scripts/python-runtime.sh', '-c', python], {
        cwd: path.resolve(__dirname, '..'), maxBuffer: 8 * 1024 * 1024
    });
    const extraction = require('./helpers/conference-extraction-fixture');
    const original = extraction.buildPdf;
    extraction.buildPdf = () => raw;
    let f;
    try {
        f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t);
    } finally {
        extraction.buildPdf = original;
    }
    const handle = sourceApi.buildConferenceSourceContext({
        planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot
    });
    const source = sourceApi.readerPdfSourceForContext(handle);
    const quotes = flat ? [source.sourceText.slice(source.sourceText.indexOf('Table 1:'), source.sourceText.indexOf('Paper 100')).trim()]
        : source.sourceText.split(/\r?\n/u).filter(line => /^(?:Alpha|Beta)\s+\d/u.test(line.trim()));
    assert.equal(quotes.length, flat ? 1 : 2);
    return { ...f, handle, source, quotes };
}

test('完整真实计划能力下层级表热签发和冷重放相同；无品牌、错组、部分引文和原源漂移拒绝', t => {
    const f = fixture(t);
    const rendered = table(markdown);
    const footnote = require('../scripts/lib/reader-authenticated-pdf-footnote-evidence');
    let resource;
    assert.equal(api.derive(rendered, f.quotes), null);
    assert.throws(() => api.withVerifiedSource({ ...f.handle }, () => true), /authenticated source authority/u);
    let proof;
    api.withVerifiedSource(f.handle, () => {
        proof = api.derive(rendered, f.quotes);
        assert.ok(proof);
        assert.equal(proof.contract, api.CONTRACT);
        assert.equal(proof.pdfSha256, f.source.pdfSha256);
        assert.equal(proof.hierarchicalPdfTableEvidence.contract, 'reader-authenticated-pdf-hierarchical-table-v1');
        assert.equal(proof.hierarchicalPdfTableEvidence.grid.sourceColumns.length, 4);
        assert.deepEqual(proof.hierarchicalPdfTableEvidence.grid.sourceColumns.map(c => c.unit), ['%', null, '%', null]);
        assert.equal(api.coverage(rendered, f.quotes).length, 4);
        assert.equal(api.assertEvidence(rendered, f.quotes, proof), true);
        const candidates = footnote.deriveCandidates(f.source.sourceText);
        assert.equal(candidates.length, 1);
        const candidate = candidates[0];
        resource = { type: candidate.type, origin: 'paper_source', originalUrl: candidate.url,
            sourceQuote: candidate.authenticatedPdfFootnoteEvidence.sourceQuote,
            sourceQuoteSha256: candidate.authenticatedPdfFootnoteEvidence.sourceQuoteSha256,
            authenticatedPdfFootnoteEvidence: candidate.authenticatedPdfFootnoteEvidence };
        assert.equal(footnote.assertEvidence(resource, f.source.sourceText), true);
        assert.deepEqual(api.withoutVerifiedSource(() => footnote.deriveCandidates(f.source.sourceText)), []);
        assert.throws(() => footnote.deriveCandidates(f.source.sourceText + 'wrong source'), /全文|来源/u);
        assert.equal(api.derive(table(markdown.replace('Client1 EER', 'Client9 EER')), f.quotes), null);
        assert.equal(api.derive(rendered, ['Alpha 1.20 0.81', 'Beta 1.40 0.79']), null);
        assert.equal(api.derive(table(markdown.replace('1.20', '1.21')), f.quotes), null);
        const changed = structuredClone(proof);
        changed.hierarchicalPdfTableEvidence.grid.sourceColumns[0].groups = ['Client2'];
        assert.throws(() => api.assertEvidence(rendered, f.quotes, changed), /differs/u);
    });
    const cold = sourceApi.buildConferenceSourceContext({
        planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot
    });
    api.withVerifiedSource(cold, () => {
        assert.deepEqual(api.derive(rendered, f.quotes), proof);
        const paper = {
            id: f.paperId, sourceSha256: sha(f.source.sourceText), apiReaderArticle: markdown,
            apiReaderPlan: { tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceQuotes: f.quotes,
                authenticatedPdfTableEvidence: proof }] }
        };
        assert.equal(api.withSavedPaper(paper, () => footnote.assertEvidence(resource, f.source.sourceText)), true);
        const filename = path.join(f.sourceRoot, f.member.pdfFile);
        const original = fs.readFileSync(filename);
        try {
            fs.appendFileSync(filename, '\nchanged PDF after cached proof');
            assert.throws(() => api.assertEvidence(rendered, f.quotes, proof), /source|SHA|sha|drift|变化|不一致/u);
        } finally {
            fs.writeFileSync(filename, original);
        }
    });
    assert.deepEqual(footnote.deriveCandidates(f.source.sourceText), []);
    assert.throws(() => footnote.assertEvidence(resource, f.source.sourceText), /作用域|来源/u);
});

test('原无分组成功记录保持原字段和原证明算法，不启动层级提取器', t => {
    // Reuse the already tested literal source path without introducing a second
    // source authority. A poisoned hierarchy worker cannot affect a flat match.
    const executor = require('../scripts/lib/reader-pdf-extraction-scope');
    t.mock.method(executor, 'runAuthenticatedPdfHierarchicalTableExtractor', () => {
        throw new Error('hierarchy must not run for a successful original flat table');
    });
    const f = fixture(t, true);
    const literal = table('|Method|Accuracy (%)|\n|---|---|\n|Alpha|90.0|\n|Beta|91.0|');
    let first;
    api.withVerifiedSource(f.handle, () => {
        first = api.derive(literal, f.quotes);
        assert.ok(first);
        assert.equal(Object.hasOwn(first, 'hierarchicalPdfTableEvidence'), false);
        assert.deepEqual(first.columns, [{ column: 1, metric: 'Accuracy', unit: '%', sourceColumn: 0 }]);
    });
    const cold = sourceApi.buildConferenceSourceContext({
        planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot
    });
    api.withVerifiedSource(cold, () => assert.deepEqual(api.derive(literal, f.quotes), first));
});
