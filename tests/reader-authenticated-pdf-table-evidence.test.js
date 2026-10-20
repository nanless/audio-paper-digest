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

test('大小写及规范罗马表号只定位同一完整表；非法编号和下一表不能借单位', () => {
    // Controlled text isolates caption syntax. The complete real SENTRY PDF
    // and merged HTML table are exercised in reader-full-width-body-bands.
    const rendered = table(markdown);
    for (const caption of ['TABLE II:', 'Table IV:', 'table IX.', 'TABLE MMMCMXCIX:']) {
        const raw = lines.join('\n').replace('Table 1:', caption);
        assert.ok(api.matchLiteralTable(rendered, [raw], doc(raw), raw));
    }
    for (const caption of ['TABLE IIII:', 'TABLE IC:', 'TABLE VX:', 'TABLE MMMM:', 'TABLE IIV:', 'TABLE Model:']) {
        const raw = lines.join('\n').replace('Table 1:', caption);
        assert.equal(api.matchLiteralTable(rendered, [raw], doc(raw), raw), null);
    }
    const first = lines.slice(0, 6).join('\n').replace('Table 1:', 'TABLE II:');
    const next = lines.join('\n').replace('Table 1:', 'TABLE III:').replace('EDT (s)', 'EDT (ms)');
    const raw = first + '\n' + next;
    assert.equal(api.matchLiteralTable(rendered, [raw], doc(raw), raw), null);
});

test('混合原列保留位置，仅明确单位列获能力，完整原行引文不能省略中间数值', () => {
    const raw = ['Table 4: Measured comparisons.', 'Method', 'CER (%)', 'Similarity', 'BadRate (%)',
        'OriginalAlpha', '1.2', '0.81', '5.2', 'OriginalBeta', '1.1', '0.83', '4.2'].join('\n');
    const rendered = table('| Method | CER (%) | BadRate (%) |\n|---|---|---|\n|OriginalAlpha|1.2|5.2|\n|OriginalBeta|1.1|4.2|');
    const match = api.matchLiteralTable(rendered, [raw], doc(raw), raw);
    assert.ok(match);
    assert.deepEqual(match.columns.map(column => column.sourceColumn), [0, 2]);
    assert.deepEqual(match.rows[0].values.map(value => [value.sourceColumn, value.sourceValue, value.unit]),
        [[1, '1.2', '%'], [3, '5.2', '%']]);
    for (const changed of [
        raw.replace('CER (%)', 'CER'),
        raw.replace('CER (%)', 'CER (degree)'),
        raw.replace('Similarity', 'CER'),
        raw.replace('Similarity', 'CER (degree)'),
        raw.replace('BadRate (%)', 'CER (%)'),
        raw.replace('OriginalAlpha', 'OriginalAlpha (fixed condition)'),
        raw.replace('5.2', '5.3'), raw + '\n' + raw
    ]) assert.equal(api.matchLiteralTable(rendered, [changed], doc(changed), changed), null);
    const opaque = raw.replace('Similarity', 'Angle (degree)');
    assert.ok(api.matchLiteralTable(rendered, [opaque], doc(opaque), opaque), 'unknown non-target unit remains opaque');
    const withUnknown = api.matchLiteralTable(table(rendered.markdown.replace('BadRate (%)', 'Angle (degree)')),
        [opaque], doc(opaque), opaque);
    assert.deepEqual(withUnknown.columns.map(column => column.metric), ['CER'], 'unknown target unit gains no evidence');
    assert.equal(api.matchLiteralTable(table(rendered.markdown.replace('CER (%)', 'CER').replace('BadRate (%)', 'Angle (degree)')),
        [opaque], doc(opaque), opaque), null, 'a table with only unknown units gains no capability');
    assert.equal(api.matchLiteralTable(rendered, ['OriginalAlpha\n1.2', 'OriginalBeta\n1.1'], doc(raw), raw), null);
    assert.equal(api.matchLiteralTable(rendered, ['OriginalAlpha 1.2 5.2', 'OriginalBeta 1.1 4.2'], doc(raw), raw), null);
    const other = raw.replace('Table 4:', 'Table 5:').replace('0.81', '0.91').replace('0.83', '0.93');
    assert.equal(api.matchLiteralTable(rendered, ['OriginalAlpha\n1.2', 'OriginalBeta\n1.1'],
        doc(raw + '\n' + other), raw + '\n' + other), null, 'shared values do not identify a different table');
    const sameValues = ['Table 5: Measured comparisons.', 'Method', 'CER (%)', 'Similarity',
        'OriginalAlpha', '1.2', '0.81', 'OriginalAlphaExtended', '1.2', '0.81'].join('\n');
    const selected = table('|Method|CER (%)|\n|---|---|\n|OriginalAlpha|1.2|');
    assert.equal(api.matchLiteralTable(selected, ['OriginalAlphaExtended\n1.2\n0.81'], doc(sameValues), sameValues), null,
        'same numbers and a prefix row label cannot replace the cited original row');
    const prefix = sameValues.replace('OriginalAlphaExtended', 'PrefixOriginalAlpha');
    assert.equal(api.matchLiteralTable(selected, ['PrefixOriginalAlpha\n1.2\n0.81'], doc(prefix), prefix), null,
        'the complete row window must also be unique in the actual PDF');
    const multiword = sameValues.replace('OriginalAlphaExtended', 'Prefix OriginalAlpha');
    assert.equal(api.matchLiteralTable(selected, ['Prefix OriginalAlpha\n1.2\n0.81'], doc(multiword), multiword), null,
        'a whitespace-delimited suffix is not a uniquely cited row window');
    assert.ok(api.matchLiteralTable(selected, ['OriginalAlpha\n1.2\n0.81'], doc(sameValues), sameValues));
});

test('真实lei与niu原表片段仅补明确单位列，不把无量纲列或复杂分组签成单位', () => {
    // Verbatim PDF extraction/Reader quote fragments from the sealed lei26 and
    // niu26c diagnostic. These exercise pure mapping, not source authority or
    // whole-paper qualification. Every original numeric column is retained.
    const lei = ['Table 1: Comparison with baseline models on the VSSE-Bench.',
        'Model', 'Objective Metrics', 'User Study', 'LSD (dB)↓', 'OD (s)↓', 'FAD↓', 'A-MOS↑', 'MOS-S↑', 'MOS-T↑', 'MOS-E↑',
        'MMAudio [5]', '2.09', '0.120', '22.76', '2.14', '1.58', '2.33', '2.21',
        'Kling-Foley [6]', '1.99', '0.077', '25.52', '2.34', '1.79', '1.86', '2.35',
        'ARCHES (Ours)', '0.77', '0.048', '7.04', '2.68', '4.04', '4.54', '4.46'].join('\n');
    const leiTable = table('|模型|LSD (dB)↓|OD (s)↓|FAD↓|A-MOS↑|MOS-S↑|MOS-T↑|MOS-E↑|\n|---|---|---|---|---|---|---|---|\n'
        + '|MMAudio [5]|2.09|0.120|22.76|2.14|1.58|2.33|2.21|\n'
        + '|Kling-Foley [6]|1.99|0.077|25.52|2.34|1.79|1.86|2.35|\n'
        + '|ARCHES (Ours)|0.77|0.048|7.04|2.68|4.04|4.54|4.46|');
    const leiMatch = api.matchLiteralTable(leiTable, [lei], doc(lei), lei);
    assert.ok(leiMatch);
    assert.deepEqual(leiMatch.columns.map(column => [column.metric, column.unit, column.sourceColumn]),
        [['LSD', 'db', 0], ['OD', 's', 1]]);
    const ablation = ['Table 2: Ablation study of the ARCHES framework.', 'Model', 'LSD ↓', 'OD (s) ↓', 'A-MOS ↑', 'FAD ↓',
        'w/o AURA', '1.35', '0.051', '2.52', '15.81', 'w/o AXIS', '0.95', '0.122', '1.88', '9.04',
        'w/o CEB', '0.82', '0.053', '2.61', '7.18', 'Full', '0.77', '0.048', '2.68', '7.04'].join('\n');
    const ablationTable = table('|模型|LSD ↓|OD (s) ↓|A-MOS ↑|FAD ↓|\n|---|---|---|---|---|\n'
        + '|w/o AURA|1.35|0.051|2.52|15.81|\n|w/o AXIS|0.95|0.122|1.88|9.04|\n|w/o CEB|0.82|0.053|2.61|7.18|\n|Full|0.77|0.048|2.68|7.04|');
    assert.deepEqual(api.matchLiteralTable(ablationTable, [ablation], doc(ablation), ablation).columns
        .map(column => [column.metric, column.unit, column.sourceColumn]), [['OD', 's', 1]]);
    const niu = ['Table 1: Comparison of post-training methods on intelligibility, speaker consistency, and stability-oriented metrics.',
        'Model', 'CER (%) ↓', 'CER=0 ↑', 'FR@CER< 0.05 ↓', 'SIM ↑', 'FR@SIM> 0.75 ↓', 'BadRate (%) ↓',
        'SFT', '1.53', '0.54', '0.38', '0.81', '0.42', '12.66', 'DPO', '1.28', '0.59', '0.22', '0.81', '0.14', '3.35',
        'GRPO', '1.46', '0.44', '0.27', '0.80', '0.22', '10.83', 'Rank3DPO', '1.17', '0.62', '0.17', '0.82', '0.10', '2.44'].join('\n');
    const niuTable = table('|Model|CER (%) ↓|CER=0 ↑|FR@CER<0.05 ↓|SIM ↑|FR@SIM>0.75 ↓|BadRate (%) ↓|\n|---|---|---|---|---|---|---|\n'
        + '|SFT|1.53|0.54|0.38|0.81|0.42|12.66|\n|DPO|1.28|0.59|0.22|0.81|0.14|3.35|\n'
        + '|GRPO|1.46|0.44|0.27|0.80|0.22|10.83|\n|Rank3DPO|1.17|0.62|0.17|0.82|0.10|2.44|');
    const niuMatch = api.matchLiteralTable(niuTable, [niu], doc(niu), niu);
    assert.ok(niuMatch);
    assert.deepEqual(niuMatch.columns.map(column => [column.metric, column.unit, column.sourceColumn]),
        [['CER', '%', 0], ['BadRate', '%', 5]]);
    const grouped = ['Table 2: Grouped ablation.', 'Setting', 'CER (%)', 'BadRate (%)', 'MOS',
        'DPO', '1.21', '10.26', '4.11', '+ ChatScore', '1.28', '3.35', '4.28',
        'GRPO', '1.46', '11.70', '3.91', '+ ChatScore', '1.46', '10.47', '4.05'].join('\n');
    const ambiguous = table('|Setting|CER (%)|BadRate (%)|\n|---|---|---|\n|+ ChatScore|1.28|3.35|\n|+ ChatScore|1.46|10.47|');
    assert.equal(api.matchLiteralTable(ambiguous, [grouped], doc(grouped), grouped), null,
        'repeated group-dependent row names cannot be rescued by mixed units');
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

test('真实认证句柄经共享executor重放，scope释放且每次仍核来源', t => {
    const f = fixture(t), rendered = table(markdown);
    const pure = require('../scripts/lib/reader-pdf-extraction-scope');
    const execute = pure.runAuthenticatedPdfQuoteExtractor, spawn = child.execFileSync;
    let executorCalls = 0, workerCalls = 0;
    t.mock.method(pure, 'runAuthenticatedPdfQuoteExtractor', fd => { executorCalls++; return execute(fd); });
    t.mock.method(child, 'execFileSync', function(command, args, options) {
        if (args?.[1]?.endsWith('/reader_sealed_pdf_quote_evidence.py')) workerCalls++;
        return spawn.call(this, command, args, options);
    });
    const cold = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    api.withVerifiedSource(f.handle, () => {
        assert.ok(api.derive(rendered, f.quotes));
        api.withVerifiedSource(cold, () => assert.ok(api.derive(rendered, f.quotes)));
        assert.equal(executorCalls, 4, 'both authenticated contexts use one fixed shared worker executor');
        assert.ok(workerCalls === 2 || workerCalls === 4, 'known runtime reuses; unknown runtime keeps original extraction');
        const pdf = path.join(f.sourceRoot, f.member.pdfFile), original = fs.readFileSync(pdf);
        try {
            fs.appendFileSync(pdf, '\nsource mutation after cached extraction');
            assert.throws(() => api.derive(rendered, f.quotes), /source|SHA|sha|drift|变化|不一致/);
        } finally { fs.writeFileSync(pdf, original); }
    });
    const before = workerCalls;
    api.withVerifiedSource(cold, () => assert.ok(api.derive(rendered, f.quotes)));
    assert.equal(workerCalls, before + 2, 'new authenticated scope executes its real workers again');
    t.diagnostic(JSON.stringify({ authenticatedExecutorCalls: executorCalls, workerCalls, reusedWithinScope: before === 2 }));
    assert.throws(() => api.withVerifiedSource({ ...f.handle }, () => true), /authenticated source authority/);
});

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
