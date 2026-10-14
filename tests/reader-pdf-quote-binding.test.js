'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actualRoot = process.env.PD_GENERIC_PDF_REAL_SOURCE_ROOT;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer'), pdf = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const quotedBinding = quote => ({ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
    cellBindings: [], sourceQuotes: [], pdfSourceQuotes: [quote] });

test('PDF引文不能以模型自填证明、作用域外引文或原表混合字段绕过来源', () => {
    const sourceText = 'The reference reports the score as 0.99 under the measured protocol.';
    const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
        tables: [], formulas: [], figures: [], flattenedTextSha256: sha(sourceText) };
    const options = { sourceText, structuredArtifacts: { ...body, payloadSha256: deep.stableFingerprint(body) }, sections: [] };
    const table = '| 方法 | 相似度 |\n|---|---|\n| 原文条件 | 0.99 |';
    assert.throws(() => deep.bindApiReaderSourceEvidence(table, [quotedBinding(sourceText)], [], options), /actual verified source scope/);
    const spoof = { ...quotedBinding(sourceText), pdfSourceQuotes: [], sourceQuotes: [sourceText], sealedPdfQuoteEvidence: [{}] };
    assert.throws(() => deep.bindApiReaderSourceEvidence(table, [spoof], [], options), /额外字段/);
    const mixed = { ...quotedBinding(sourceText), sourceType: 'artifact_table', sourceTableOrdinal: 1 };
    assert.throws(() => deep.bindApiReaderSourceEvidence(table, [mixed], [], options), /额外字段/);
});

test('PDF连续引文不能跨片段或HTML/PDF边界借单位，旧HTML兼容不变', () => {
    assert.equal(deep.readerSourceQuotesCoverNumericToken('1s', ['The measured scalar is 1'],
        [{ quote: 's is a unit in the following section.' }]), false);
    assert.equal(deep.readerSourceQuotesCoverNumericToken('1s', [],
        [{ quote: 'The measured scalar is 1' }, { quote: 's is a unit in the following section.' }]), false);
    assert.equal(deep.readerSourceQuotesCoverNumericToken('1s', [],
        [{ quote: 'The measured duration is 1 s in this protocol.' }]), true);
    assert.equal(deep.readerSourceQuotesCoverNumericToken('-38.1db', ['The total THD is -38.1 with intervening column text dB.'], [], true), true);
    assert.equal(deep.readerSourceQuotesCoverNumericToken('-38.1db', [],
        [{ quote: 'The total THD is -38.1 with intervening column text dB.' }], true), false);
});

test('真实PDF引文正常绑定、保留列并通过冷态来源guard，改值借单位和伪造证明拒绝', { skip: !actualRoot }, async t => {
    const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-pdf-quote-binding-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const originalRun = path.dirname(path.resolve(actualRoot)), runId = path.basename(originalRun);
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, runId), id = '2610.09701';
    const directory = path.join(runDir, 'sources', id, 'generation-000001');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(originalRun, 'run.json'), path.join(runDir, 'run.json'));
    const originals = new Map();
    for (const file of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
        const original = path.join(actualRoot, id, 'generation-000001', file);
        originals.set(original, sha(fs.readFileSync(original))); fs.copyFileSync(original, path.join(directory, file));
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
    // Other Reader records are format fixtures; source eligibility and PDF proofs
    // below come from actual public four-source validation, never a mocked scope.
    const paper = require('./valid-analysis-fixture').validLegacyApiAnalysisPaper(id);
    const source = daily.readDailyFreshSource(plan, paper), artifacts = source.structuredArtifacts;
    let bound;
    await daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        return fresh.withFreshPaperContext(paper, async () => {
            paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
            Object.assign(paper.analysisManifest.sourceAcquisition, { sourceSha256: paper.sourceSha256,
                structuredArtifactsSha256: artifacts.payloadSha256 });
            const before = deep.buildApiReaderEvidenceContext('', source.text, artifacts, id, null, null, false);
            pdf.withArtifacts(artifacts, id, () => {
                const full = pdf.document().normalizedFullText;
                const start = full.indexOf('Table 2 shows that all algorithms'), end = full.indexOf('5. CONCLUSION', start);
                assert(start >= 0 && end > start);
                const quote = full.slice(start, end).trim();
                const article = '说明同一论文的结果及其比较条件。\n\n| 条件 | 相似度 |\n|---|---|\n| 目标声场 | 0.99 |\n| 干扰声场 | 0.85 |\n\n这些测量只支持论文报告的声场条件和评价协议，不能推断其他输入环境，也没有提供部署成本的证据。';
                const options = { sourceText: source.text, structuredArtifacts: artifacts, sections: [],
                    allowDeterministicUnsupportedClaimPruning: true };
                const repairDraft = { sections: [{ kind: 'result', heading: '结果条件', body: article }],
                    conceptBridges: [], figurePlacements: [], tableBindings: [quotedBinding(quote)], formulaBindings: [] };
                const bindingIssues = require('../scripts/lib/reader-repair').collectDraftIssues(repairDraft, null, options)
                    .filter(issue => /普通绑定|source_quotes 结构|pdfSourceQuotes|独立 PDF/.test(issue.message || ''));
                assert.deepEqual(bindingIssues, []);
                const badDraft = structuredClone(repairDraft);
                badDraft.tableBindings[0].pdfSourceQuotes[0] += ' fabricated';
                assert(require('../scripts/lib/reader-repair').collectDraftIssues(badDraft, null, options)
                    .some(issue => /pdfSourceQuotes|PDF/.test(issue.message || '')));
                bound = deep.bindApiReaderSourceEvidence(article, [quotedBinding(quote)], [], options);
                assert.equal(bound.tableBindings[0].sourceQuotes.length, 0);
                assert.equal(bound.tableBindings[0].sealedPdfQuoteEvidence.length, 1);
                assert.equal(bound.tableBindings[0].pdfSourceQuotes, undefined);
                assert.equal(bound.tablePruningDiagnostics, undefined);
                assert.match(bound.article, /本表数值与单位依据论文 PDF。/);
                assert.throws(() => deep.bindApiReaderSourceEvidence(article.replace('0.85', '0.123456'), [quotedBinding(quote)], [],
                    { ...options, allowDeterministicUnsupportedClaimPruning: false }), /关键数字缺少/);
                assert.throws(() => deep.bindApiReaderSourceEvidence(article.replace('0.99 |', '0.99 dB |'), [quotedBinding(quote)], [],
                    { ...options, allowDeterministicUnsupportedClaimPruning: false }), /关键数字缺少/);
                assert.throws(() => deep.bindApiReaderSourceEvidence(article, [quotedBinding(quote.replace('0.99', '0.123456'))], [], options), /missing or ambiguous/);
            });
            // Identity preparation creates the real post-identity quote scope.
            const prepared = await deep.prepareApiReaderRetryIdentity(paper, '', before,
                { readerReplayPreparationOnly: true, sourceText: source.text, structuredArtifacts: artifacts });
            const quote = bound.tableBindings[0].sealedPdfQuoteEvidence[0].quote;
            const draft = { version: 3, readerTitle: '声场测量的比较条件', oneSentenceThesis: '解释相似度比较的条件。',
                sections: [{ kind: 'result', heading: '结果条件', body: bound.article }], conceptBridges: [], figurePlacements: [],
                tableBindings: [quotedBinding(quote)], formulaBindings: [] };
            const normalized = prepared.normalizeReplayDraft(draft, [], []);
            assert.deepEqual(normalized.tableBindings[0].pdfSourceQuotes, [quote]);
            assert.equal(deep.buildApiReaderEvidenceContext('', source.text, artifacts, id, null, null, false), before);
        });
    });
    paper.apiReaderArticle = bound.article;
    Object.assign(paper.apiReaderPlan, { tableBindings: bound.tableBindings, structuredSourcePayload: bound.structuredSourcePayload,
        sourceBindingsSha256: bound.sourceBindingsSha256 });
    const authors = paper.apiReaderAuthors;
    authors.identity.sourceTextSha256 = paper.sourceSha256;
    authors.identity.authors[0].affiliationBindings[0].sourceTextSha256 = paper.sourceSha256;
    authors.identitySha256 = deep.stableFingerprint(authors.identity);
    paper.apiReaderResources.sourceTextSha256 = paper.sourceSha256;
    const { identitySha256: _oldResourceSha, ...resourceIdentity } = paper.apiReaderResources;
    paper.apiReaderResources.identitySha256 = deep.stableFingerprint(resourceIdentity);
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
    const seal = () => {
        paper.apiReaderPlan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: paper.apiReaderPlan.tableBindings, formulaBindings: [] });
        paper.apiReaderPlanSha256 = deep.stableFingerprint(paper.apiReaderPlan);
        paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
        Object.assign(paper.analysisManifest.stages.apiReaderArticle, { planSha256: paper.apiReaderPlanSha256,
            articleSha256: paper.apiReaderArticleSha256, sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
            sourceBindingsSourceTextSha256: paper.sourceSha256, structuredArtifactsSha256: artifacts.payloadSha256,
            tableBindingCount: 1, readerAuthorsSha256: deep.stableFingerprint(authors),
            readerAuthorIdentitySha256: authors.identitySha256, resourceIdentitySha256: paper.apiReaderResources.identitySha256 });
    };
    seal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    for (const mutate of [p => p.apiReaderPlan.tableBindings[0].sealedPdfQuoteEvidence[0].rawStartCodePoint++,
        p => p.apiReaderPlan.tableBindings[0].sealedPdfQuoteEvidence[0].quote += ' invented',
        p => p.apiReaderPlan.structuredSourcePayload += ' ',
        p => p.apiReaderPlan.tableBindings[0].sourceQuotes.push({ quote: 'Fabricated result 0.123456', sourceQuoteSha256: sha('Fabricated result 0.123456') })]) {
        const bad = structuredClone(paper); mutate(bad); assert.equal(engine.hasValidApiReaderV3Records(bad), false);
    }
    // A genuine quotation proof with self-consistent content hashes still cannot
    // authorize an invented scalar or attach another metric's dB unit.
    for (const replacement of ['0.123456', '0.99 dB']) {
        const bad = structuredClone(paper);
        bad.apiReaderArticle = bad.apiReaderArticle.replace('0.99 |', replacement + ' |');
        const table = require('../scripts/analysis-contract').extractMarkdownTables(bad.apiReaderArticle)[0];
        bad.apiReaderPlan.tableBindings[0].renderedTableSha256 = sha(table.markdown);
        bad.apiReaderPlan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: bad.apiReaderPlan.tableBindings, formulaBindings: [] });
        bad.apiReaderPlanSha256 = deep.stableFingerprint(bad.apiReaderPlan);
        bad.apiReaderArticleSha256 = sha(bad.apiReaderArticle);
        Object.assign(bad.analysisManifest.stages.apiReaderArticle, { planSha256: bad.apiReaderPlanSha256,
            articleSha256: bad.apiReaderArticleSha256, sourceBindingsSha256: bad.apiReaderPlan.sourceBindingsSha256 });
        assert.equal(engine.hasValidApiReaderV3Records(bad), false);
    }
    for (const [file, digest] of originals) assert.equal(sha(fs.readFileSync(file)), digest);
});
