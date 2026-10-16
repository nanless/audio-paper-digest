'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process');
const api = require('../scripts/lib/reader-authenticated-pdf-table-evidence');
const sourceApi = require('../scripts/lib/conference-source-context');
const deep = require('../scripts/deep-analyzer');
const { extractMarkdownTables } = require('../scripts/analysis-contract');
const table = markdown => extractMarkdownTables(markdown)[0];
const markdown = '| Method | EDT (s) | C50 (dB) |\n|---|---|---|\n|Alpha|0.10|3.2|\n|Beta|0.20|4.3|';
const lines = ['Table 1: Measured errors under the same evaluation protocol.', 'Method', 'EDT (s)', 'C50 (dB)',
    'Alpha', '0.10', '3.2', 'Beta', '0.20', '4.3'];
function doc(raw = lines.join('\n')) {
    return { contract: 'reader-sealed-pdf-quotes-v1', available: true, rawFullText: raw,
        normalizedFullText: raw.replace(/\s+/g, ' ').trim() };
}

test('literal PDF表头与行逐项绑定，不借另一表、错列、同数值或重复表头', () => {
    const raw = lines.join('\n'), quotes = [raw];
    const match = api.matchLiteralTable(table(markdown), quotes, doc(raw), raw);
    assert.ok(match);
    assert.deepEqual(match.columns.map(value => [value.metric, value.unit]), [['EDT', 's'], ['C50', 'db']]);
    assert.deepEqual(match.rows.map(value => value.rowLabel), ['Alpha', 'Beta']);
    for (const source of [raw.replace('EDT (s)', 'EDT (ms)'), raw.replace('EDT (s)', 'EDT'),
        raw.replace('Beta', 'Other'), raw.replace('4.3', '4.4'), raw + '\n' + raw,
        raw.replace('C50 (dB)', 'EDT (s)')]) assert.equal(api.matchLiteralTable(table(markdown), [source], doc(source), source), null);
    assert.equal(api.matchLiteralTable(table(markdown.replace('EDT (s)', 'Time (s)')), quotes, doc(raw), raw), null);
    assert.equal(api.matchLiteralTable(table(markdown.replace('|Alpha|0.10|3.2|', '|Alpha|3.2|0.10|')), quotes, doc(raw), raw), null);
    assert.equal(api.matchLiteralTable(table(markdown), ['An unrelated experiment reports 0.10 3.2 and 0.20 4.3.'], doc(raw), raw), null);
    assert.equal(api.matchLiteralTable(table(markdown), [lines.slice(0, 6).join('\n')], doc(raw), raw), null);
    const other = raw.replace('Table 1:', 'Table 2:').replace('EDT (s)', 'EDT (ms)');
    const combined = raw + '\n' + other;
    assert.equal(api.matchLiteralTable(table(markdown.replace('EDT (s)', 'EDT (ms)')), [raw], doc(combined), combined), null);
    assert.equal(api.matchLiteralTable(table(markdown.replace('EDT (s)', 'EDT (ms)')),
        ['Alpha\n0.10\n3.2', 'Beta\n0.20\n4.3'], doc(combined), combined), null);
});

test('caption百分比仅赋予该原表精确英文指标，中文猜译和跨表比例不获能力', () => {
    const raw = ['Table 3: Results [%] of evaluated detectors.', 'Detector', 'Acc.', 'F1',
        'Alpha', '71.7', '40.7', 'Beta', '84.5', '41.6'].join('\n');
    const rendered = table('| Detector | Acc. (%) | F1 (%) |\n|---|---|---|\n|Alpha|71.7|40.7|\n|Beta|84.5|41.6|');
    assert.ok(api.matchLiteralTable(rendered, [raw], doc(raw), raw));
    for (const wrong of [raw.replace('Results [%]', 'Results'), raw.replace('Acc.', 'Recall'),
        raw.replace('Results [%]', 'Results [s]'), raw.replace('F1', 'Table 4: Results [%] F1')])
        assert.equal(api.matchLiteralTable(rendered, [wrong], doc(wrong), wrong), null);
    assert.equal(api.matchLiteralTable(table(rendered.markdown.replace('Acc. (%)', '准确率 (%)').replace('F1 (%)', '其他 (%)')),
        [raw], doc(raw), raw), null);
});

function fixture(t) {
    const extraction = require('./helpers/conference-extraction-fixture');
    const original = extraction.buildPdf;
    const text = ['Paper 100', ...lines,
        ...Array.from({ length: 55 }, () => 'Fixture text documents the full methods and controlled experiments with source evidence. ' + 'x'.repeat(40))].join('\n');
    const raw = child.execFileSync('bash', ['scripts/python-runtime.sh', '-c',
        'import fitz,sys;d=fitz.open();p=d.new_page();p.insert_text((25,25),sys.argv[1],fontsize=7);sys.stdout.buffer.write(d.tobytes());d.close()', text],
    { cwd: path.resolve(__dirname, '..'), maxBuffer: 8 * 1024 * 1024 });
    extraction.buildPdf = () => raw;
    let f;
    try { f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t); }
    finally { extraction.buildPdf = original; }
    const handle = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    const verified = sourceApi.readerPdfSourceForContext(handle);
    const start = verified.sourceText.indexOf('Table 1:');
    const end = verified.sourceText.indexOf('Fixture text', start);
    assert.ok(start >= 0 && end > start);
    return { ...f, handle, verified, quotes: [verified.sourceText.slice(start,end).trim()] };
}

test('真实计划四源签发、派生、保存和冷重放同一PDF证明，任意JSON与篡改均拒', t => {
    const f = fixture(t), rendered = table(markdown);
    assert.equal(api.derive(rendered, f.quotes), null);
    for (const fake of [null, {}, f.verified, Object.freeze({ paperId: f.paperId })])
        assert.throws(() => api.withVerifiedSource(fake, () => true), /authenticated source authority/);
    let proof;
    api.withVerifiedSource(f.handle, () => {
        proof = api.derive(rendered, f.quotes);
        assert.ok(proof); assert.equal(proof.contract, api.CONTRACT);
        const actualSource = require('../scripts/lib/conference-analysis-adapter').sourceDetails(f.handle);
        const bound = deep.bindApiReaderSourceEvidence(markdown,
            [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: f.quotes }], [],
            { sourceText: actualSource.text, structuredArtifacts: actualSource.structuredArtifacts });
        assert.ok(bound.tableBindings[0].authenticatedPdfTableEvidence);
        assert.equal(api.assertEvidence(table(bound.article), f.quotes, bound.tableBindings[0].authenticatedPdfTableEvidence), true);
        assert.equal(bound.sourceBindingsSha256, deep.stableFingerprint({ tableBindings: bound.tableBindings, formulaBindings: [] }));
        assert.equal(proof.pdfSha256, f.verified.pdfSha256);
        assert.equal(api.coverage(rendered, f.quotes).length, 4);
        assert.equal(deep.readerTableHeaderUnitEvidenceFailures(rendered, f.quotes).length, 0);
        assert.equal(api.assertEvidence(rendered, f.quotes, proof), true);
        assert.equal(api.withoutVerifiedSource(() => api.derive(rendered, f.quotes)), null);
        const originalSandbox = process.env.CODEX_SANDBOX;
        try {
            process.env.CODEX_SANDBOX = 'test-authenticated-pdf';
            assert.throws(() => api.derive(rendered, f.quotes), /必须在沙箱外运行/);
        } finally {
            if (originalSandbox === undefined) delete process.env.CODEX_SANDBOX;
            else process.env.CODEX_SANDBOX = originalSandbox;
        }
        assert.throws(() => api.assertEvidence(rendered, f.quotes, { ...proof, pdfSha256: '0'.repeat(64) }), /differs/);
        assert.throws(() => api.assertEvidence(table(markdown.replace('4.3', '4.4')), f.quotes, proof), /differs/);
    });
    assert.equal(deep.readerTableHeaderUnitEvidenceFailures(rendered, f.quotes).length, 4);
    const quotes = f.quotes.map(quote => ({ quote, sourceQuoteSha256: require('node:crypto').createHash('sha256').update(quote).digest('hex') }));
    const paper = { id: f.paperId, sourceSha256: require('node:crypto').createHash('sha256').update(f.verified.sourceText).digest('hex'),
        apiReaderArticle: markdown, apiReaderPlan: { tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceQuotes: quotes,
            authenticatedPdfTableEvidence: proof }] } };
    assert.throws(() => api.withSavedPaper(paper, () => true), /identity differs/);
    const cold = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    assert.equal(api.withVerifiedSource(cold, () => api.withSavedPaper(paper, () => true)), true);
    const pdf = path.join(f.sourceRoot, f.member.pdfFile), original = fs.readFileSync(pdf);
    api.withVerifiedSource(f.handle, () => {
        try {
            fs.appendFileSync(pdf, '\nchanged');
            assert.throws(() => api.derive(rendered, f.quotes), /source|SHA|sha|drift|变化|不一致/);
        } finally { fs.writeFileSync(pdf, original); }
    });
});

test('已认证scope中无单位表格不提取PDF，不受新能力影响', t => {
    const f = fixture(t);
    t.mock.method(child, 'execFileSync', () => assert.fail('no-unit table must not extract PDF'));
    api.withVerifiedSource(f.handle, () => {
        const plain = table(markdown.replace('EDT (s)', 'EDT').replace('C50 (dB)', 'C50'));
        assert.equal(api.derive(plain, f.quotes), null);
        assert.deepEqual(api.coverage(plain, f.quotes), []);
    });
});

test('正常Reader已收到付费响应后来源漂移保存原返回稿与次数，原样停止且不补发', async t => {
    const f = fixture(t), repair = require('../scripts/lib/reader-repair');
    const context = require('../scripts/lib/conference-analysis-context');
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const draft = sample.draft, firstTable = extractMarkdownTables(draft.sections.map(section => section.body).join('\n\n'))[0];
    for (const section of draft.sections) section.body = section.body.replaceAll(firstTable.markdown, markdown).replace('[[FORMULA_1]]', '');
    draft.formulaBindings = [];
    draft.tableBindings = [1,2].map(tableIndex => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: f.quotes }));
    const source = require('../scripts/lib/conference-analysis-adapter').sourceDetails(f.handle);
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: repair.shaText(source.text), resources: [] };
    const resources = { ...resourceBody, identitySha256: deep.stableFingerprint(resourceBody) };
    const paper = { id: f.paperId, title: 'Source failure paid Reader fixture', source: 'conference',
        sourceSha256: repair.shaText(source.text), apiReaderResources: resources };
    const executionId = '11111111-1111-4111-8111-111111111111';
    const executionDir = path.join(f.root, executionId); fs.mkdirSync(executionDir);
    const pdf = path.join(f.sourceRoot, f.member.pdfFile), original = fs.readFileSync(pdf);
    let calls = 0;
    try {
        await assert.rejects(context.withConferenceAnalysisSource({ executionId, executionDir, paperId: f.paperId,
            sourceDetails: source, readerPdfSourceHandle: f.handle }, () =>
            deep.generateApiReaderArticleDetailed(paper, 'paid main', source.text, {
                sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                readerMaterializeFigures: async () => [], readerRecordDisposition() {}, readerCallModel: async () => {
                    calls++; fs.appendFileSync(pdf, '\nsource drift during model response'); return JSON.stringify(draft);
                }
            })), error => error.code === 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY' && error.scope === 'run' && error.retryable === false);
    } finally { fs.writeFileSync(pdf, original); }
    assert.equal(calls, 1);
    const directory = path.join(executionDir, 'reader-attempts');
    const saved = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    assert.equal(saved.length, 1);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, saved[0])));
    assert.equal(envelope.payload.attempts, 1); assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.transportFailures, 0); assert.equal(envelope.payload.noProgress, 0);
    assert.equal(envelope.payload.rawDraft, JSON.stringify(draft));
    assert.ok(envelope.payload.draft);
});
