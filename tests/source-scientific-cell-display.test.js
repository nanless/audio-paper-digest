'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const math = require('../scripts/lib/source-cell-math-display');
const pdf = require('../scripts/lib/reader-table-pdf-evidence');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const positive = [
    [String.raw`20.61×10220.61\times 10^{2}`, '20.61×10²'],
    [String.raw`0.41×1020.41\times 10^{2}`, '0.41×10²'],
    [String.raw`2.28×1022.28\times 10^{2}`, '2.28×10²'],
    [String.raw`1.17×1021.17\times 10^{2}`, '1.17×10²'],
    [String.raw`-1.20×10-02-1.20\times10^{-02}`, '-1.20×10⁻⁰²'],
    [String.raw`+0.010×10+03+0.010\times 10^{+03}`, '+0.010×10⁺⁰³']
];
const negative = [
    String.raw`20.61×10220.62\times 10^{2}`, String.raw`20.61×10220.61\times 10^{3}`,
    String.raw`-20.61×10220.61\times 10^{2}`, String.raw`20.610×10220.61\times 10^{2}`,
    String.raw`20.61×10+220.61\times 10^{2}`, String.raw`20.61×10220.61\times 10^{02}`,
    '20.61×10220.61', String.raw`20.61\times 10^{2}`, String.raw`20.61×10220.61\times 10^{2} ms`,
    String.raw`20.61×10220.61\times 10^{2} 7`, String.raw`x20.61×10220.61\times 10^{2}`,
    String.raw`20.61×10220.61\times 10^{2}x`, String.raw`20.61×10220.61\unknown 10^{2}`,
    String.raw`２０.６１×102２０.６１\times 10^{2}`,
    String.raw`20.61×10220.61\times 10^{2}` + '\n',
    String.raw`20.61×10220.61\times 10^{2}` + String.raw`\times10^{3}`
];
test('whole-cell scientific duplicates preserve both literal coefficients, exponent signs and precision', () => {
    for (const [raw, displayText] of positive) {
        assert.deepEqual(math.strictSourceCellMathDisplay(raw), {
            contract: 'source-cell-math-display-v1', kind: 'scientific-notation-duplicate',
            sourceText: raw, sourceTextSha256: sha(raw), displayText });
        assert.equal(math.strictSourceCellMathDisplay(displayText), null);
    }
    for (const raw of negative) assert.equal(math.strictSourceCellMathDisplay(raw), null, raw);
});
test('scientific display is bound to the unique original DOM cell and exact matrix coordinate', () => {
    const matrix = [['Method', 'TFLOPs'], ['Base', positive[0][0]], ['Ours', positive[1][0]]];
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('table'), matrix,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
            rowspan: 1, colspan: 1, text, sourceDomSha256: sha(`${r}:${c}:${text}`) }))) };
    assert.equal(pdf.displayCell(table, 1, 1), positive[0][1]);
    assert.equal(pdf.displayCellMatches(table, 1, 1, positive[0][1]), true);
    assert.equal(pdf.displayCellMatches(table, 2, 1, positive[0][1]), false);
    for (const mutate of [t => t.cells.push(structuredClone(t.cells[3])),
        t => t.cells[3].sourceDomSha256 = '', t => t.sourceDomSha256 = '',
        t => t.matrix[1][1] = positive[1][0], t => t.cells[3].column = 0]) {
        const bad = structuredClone(table); mutate(bad);
        assert.equal(pdf.displayCellMatches(bad, 1, 1, positive[0][1]), false);
    }
});
const evidenceFile = process.env.PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE;
test('actual 41390 paid draft cold parses against its four sealed sources with unchanged original bytes',
    { skip: !evidenceFile }, () => {
        const bytes = fs.readFileSync(evidenceFile);
        assert.equal(sha(bytes), process.env.PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE_SHA256);
        const evidence = JSON.parse(bytes);
        assert.equal(evidence.parsed, true);
        assert.equal(evidence.candidateSha256, '3fe37a456fc2f293d97b751491ff3c7629d030cb387ebd382d9a789e1d599f2a');
        const candidateBytes = fs.readFileSync(evidence.candidateFile), candidate = JSON.parse(candidateBytes);
        assert.equal(sha(candidateBytes), evidence.candidateSha256);
        const daily = require('../scripts/lib/daily-fresh-source-plan'), fresh = require('../scripts/lib/fresh-analysis-context');
        const runDir = path.dirname(path.dirname(evidence.candidateFile));
        const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
        const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
        const paper = structuredClone(evidence.paperInput), source = daily.readDailyFreshSource(plan, paper);
        const deep = require('../scripts/deep-analyzer');
        const options = { arxivId: '2610.41390', availableFigureOrdinals: candidate.payload.imageEvidence
            .filter(image => image.status === 'ready').map(image => image.ordinal),
        minimumIntegratedTables: 2, requireIntegratedTables: true, requiredVersion: 3,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        allowDeterministicUnsupportedClaimPruning: true, structuredArtifacts: source.structuredArtifacts,
        sourceText: source.text, verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true };
        daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => {
            const parsed = deep.parseApiReaderArticleResult(JSON.stringify(candidate.payload.draft), options);
            assert.deepEqual(parsed, evidence.result);
            const binding = parsed.plan.tableBindings[1];
            assert.equal(binding.sourceType, 'artifact_table');
            assert.equal(binding.cellBindings.length, 20);
            for (const cell of binding.cellBindings) {
                const original = source.structuredArtifacts.tables[2].cells.find(c => c.row === cell.sourceRow && c.column === cell.sourceColumn);
                assert.equal(cell.sourceText, original.text); assert.equal(cell.sourceDomSha256, original.sourceDomSha256);
            }
            const changedArtifacts = structuredClone(source.structuredArtifacts);
            changedArtifacts.tables[2].sourceDomSha256 = 'a'.repeat(64);
            assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(candidate.payload.draft), {
                ...options, structuredArtifacts: changedArtifacts }), /artifacts differ|source/i);
        }));
        const saved = { ...paper, apiReaderArticle: evidence.result.article, apiReaderPlan: evidence.result.plan };
        assert.doesNotThrow(() => pdf.withSavedPaper(saved, () => {}));
        const mutations = [p => p.apiReaderPlan.tableBindings[1].cellBindings[7].sourceRow = 2,
            p => p.apiReaderPlan.tableBindings[1].cellBindings[7].sourceColumn = 2,
            p => p.apiReaderPlan.tableBindings[1].cellBindings[7].sourceDomSha256 = 'a'.repeat(64),
            p => p.apiReaderPlan.tableBindings[1].sourceTableDomSha256 = 'a'.repeat(64),
            p => p.apiReaderPlan.tableBindings[1].sourceTableOrdinal = 1,
            p => delete p.apiReaderPlan.structuredSourcePayload];
        const downgrade = p => {
            const binding = p.apiReaderPlan.tableBindings[1];
            binding.sourceTableDomSha256 = 'a'.repeat(64);
            for (const cell of binding.cellBindings) if (math.strictSourceCellMathDisplay(cell.sourceText)?.kind === 'scientific-notation-duplicate') {
                cell.sourceText = cell.renderedText; cell.sourceDomSha256 = 'b'.repeat(64);
            }
        };
        mutations.push(downgrade, p => { downgrade(p); delete p.apiReaderPlan.structuredSourcePayload; },
            p => { downgrade(p); for (const cell of p.apiReaderPlan.tableBindings[1].cellBindings) cell.renderedText += ' '; });
        for (const mutate of mutations) {
            const changed = structuredClone(saved); mutate(changed);
            assert.throws(() => pdf.withSavedPaper(changed, () => {}), /Scientific DOM display/);
        }
        const fakePdf = structuredClone(saved); downgrade(fakePdf);
        fakePdf.apiReaderPlan.tableBindings[1].sealedPdfTableEvidence = { contract: 'copied-json-is-not-pdf-evidence' };
        assert.throws(() => pdf.withSavedPaper(fakePdf, () => {}));
        for (const [file, expected] of Object.entries(evidence.originals)) assert.equal(sha(fs.readFileSync(file)), expected);
    });
