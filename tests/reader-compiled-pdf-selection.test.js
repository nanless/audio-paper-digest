'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const os = require('node:os'), { spawnSync } = require('node:child_process');
const compiler = require('../scripts/lib/reader-tables');
const pdf = require('../scripts/lib/reader-table-pdf-evidence');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const realEvidence = process.env.PD_READER_PDF_SELECTION_REAL_EVIDENCE;
const realEvidenceSha = process.env.PD_READER_PDF_SELECTION_REAL_EVIDENCE_SHA256;
function sample() {
    const matrix = [['Method', 'Score'], ['Base', '1.25'], ['Ours', '2.50']];
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64), matrix,
        headerRows: [0], bodyRows: [1, 2], cells: matrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, rowspan: 1, colspan: 1, text, sourceDomSha256: sha(`${r}:${c}:${text}`)
        }))) };
    return { tables: [table] };
}
const declaration = { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 2], sourceColumns: [0, 1] } };
test('publisher replay requires a private single-link bounded fd, exact input fields and denies every network entry', t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pdf-selection-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'input.json'), cli = path.resolve(__dirname, '../scripts/lib/reader-pdf-selection-replay-cli.js');
    const invoke = () => {
        const fd = fs.openSync(file, 'r');
        try { return spawnSync(process.execPath, [cli, '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' }); }
        finally { fs.closeSync(fd); }
    };
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    fs.chmodSync(file, 0o644); assert.match(invoke().stderr, /Unsafe selection replay input/);
    fs.chmodSync(file, 0o600); fs.linkSync(file, path.join(directory, 'hardlink'));
    assert.match(invoke().stderr, /Unsafe selection replay input/); fs.unlinkSync(path.join(directory, 'hardlink'));
    fs.writeFileSync(file, ' '); assert.match(invoke().stderr, /Unsafe selection replay input/);
    fs.writeFileSync(file, JSON.stringify({ artifacts: {}, binding: {}, proof: {}, extra: true }));
    assert.match(invoke().stderr, /Unexpected selection replay fields/);
    const result = spawnSync(process.execPath, ['-e', `
      const a = require(${JSON.stringify(cli)});
      try { a.main([]); } catch (e) { if (!/private read-only input descriptor/.test(e.message)) throw e; }
      const calls = [() => require('node:net').connect(1), () => require('node:tls').connect(1),
        () => require('node:http').request('http://example.invalid'), () => require('node:http').get('http://example.invalid'),
        () => require('node:https').request('https://example.invalid'), () => require('node:https').get('https://example.invalid'),
        () => require('node:http2').connect('https://example.invalid'), () => fetch('https://example.invalid')];
      for (const call of calls) { let rejected = false; try { call(); } catch (e) { rejected = /forbids network/.test(e.message); }
        if (!rejected) throw new Error('network method remained reachable'); }
      process.stdout.write('blocked ' + calls.length);
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'blocked 8');
});
test('normal compiler selection has an exact private source/mapping capability; copied or manual bindings do not', () => {
    const artifacts = sample(), original = JSON.stringify(artifacts);
    const rendered = compiler.renderReaderTableSelection(declaration, artifacts);
    assert.deepEqual(compiler.readCompiledReaderTableSelection(rendered.binding, artifacts), {
        sourceRows: [0, 2], sourceColumns: [0, 1] });
    assert.equal(compiler.readCompiledReaderTableSelection(structuredClone(rendered.binding), artifacts), null);
    assert.equal(compiler.readCompiledReaderTableSelection(rendered.binding, structuredClone(artifacts)), null);
    // A compiler capability alone cannot mint PDF evidence outside the authenticated PDF source scope.
    assert.equal(pdf.compiledSelectionEvidence(artifacts.tables[0], rendered.binding, artifacts), null);
    assert.deepEqual(pdf.bindingEvidence(artifacts.tables[0], rendered.binding, artifacts), {});
    rendered.binding.cellBindings[2].sourceRow = 1;
    assert.throws(() => compiler.readCompiledReaderTableSelection(rendered.binding, artifacts), /capability changed/);
    assert.equal(JSON.stringify(artifacts), original);
});
test('selection compiler still refuses duplicate/missing source cells, invalid header/coordinates and source replacement', () => {
    for (const mutate of [s => s.tables[0].cells.pop(), s => s.tables[0].cells.push(s.tables[0].cells[0]),
        s => s.tables[0].sourceDomSha256 = 'bad']) {
        const artifacts = sample(); mutate(artifacts);
        assert.throws(() => compiler.renderReaderTableSelection(declaration, artifacts));
    }
    const artifacts = sample(), rendered = compiler.renderReaderTableSelection(declaration, artifacts);
    artifacts.tables[0] = structuredClone(artifacts.tables[0]);
    assert.throws(() => compiler.readCompiledReaderTableSelection(rendered.binding, artifacts), /capability changed/);
    for (const rows of [[0, 0, 2], [0, 9]]) assert.throws(() => compiler.renderReaderTableSelection({
        tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: rows, sourceColumns: [0, 1] }
    }, sample()));
});
test('real 41292 saved paid selection parses and cold-replays without mutation; wrong values/coordinates/source/clones refuse',
    { skip: !realEvidence }, async () => {
    const evidenceBytes = fs.readFileSync(realEvidence);
    assert.match(realEvidenceSha || '', /^[a-f0-9]{64}$/);
    assert.equal(sha(evidenceBytes), realEvidenceSha);
    const snapshot = JSON.parse(evidenceBytes);
    assert.equal(snapshot.candidateSha256, '83004d869db5813d4c576f3224e27cf817da39c1101093c9cd750eec7aec8f02');
    const candidateBytes = fs.readFileSync(snapshot.candidateFile);
    assert.equal(sha(candidateBytes), snapshot.candidateSha256);
    const envelope = JSON.parse(candidateBytes), paper = structuredClone(snapshot.paperInput);
    const runDir = path.dirname(path.dirname(snapshot.candidateFile));
    const daily = require('../scripts/lib/daily-fresh-source-plan'), fresh = require('../scripts/lib/fresh-analysis-context');
    const deep = require('../scripts/deep-analyzer'), extract = require('../scripts/analysis-contract').extractMarkdownTables;
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
    const source = daily.readDailyFreshSource(plan, paper), artifacts = source.structuredArtifacts;
    const sourceDir = path.join(runDir, 'sources/2610.41292/generation-000001');
    const originalFiles = Object.fromEntries(fs.readdirSync(sourceDir).map(n => [n, sha(fs.readFileSync(path.join(sourceDir, n)))]));
    let result;
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => pdf.withArtifacts(artifacts, paper.arxivId, () => {
        result = deep.parseApiReaderArticleResult(JSON.stringify(envelope.payload.draft), {
            arxivId: '2610.41292', availableFigureOrdinals: [1, 2], requireIntegratedTables: true,
            minimumIntegratedTables: 2, requiredVersion: 3, requireSourceBindings: true,
            allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
            structuredArtifacts: artifacts, sourceText: source.text,
            verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true
        });
        assert.equal(result.plan.tableBindings.length, 4);
        assert.ok(result.plan.tableBindings.every(b => b.sealedPdfTableSelection));
        const current = deep.parseApiReaderArticleResult(JSON.stringify(envelope.payload.draft), {
            arxivId: '2610.41292', availableFigureOrdinals: [1, 2], requireIntegratedTables: true,
            minimumIntegratedTables: 2, requireSourceBindings: true, compileCurrent: true,
            allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
            structuredArtifacts: artifacts, sourceText: source.text,
            verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true
        });
        const codec = require('../scripts/lib/protocol-codec');
        assert.equal(current.article, result.article);
        assert.equal(codec.isCurrentHeader(current.plan, 'beginner-researcher'), true);
        for (const binding of current.plan.tableBindings) {
            assert.equal(codec.isCurrentHeader(binding.sealedPdfTableEvidence, 'reader-sealed-pdf-table-grid'), true);
            assert.equal(codec.isCurrentHeader(binding.sealedPdfTableSelection, 'reader-compiled-pdf-table-selection'), true);
            assert.equal(binding.sealedPdfTableSelection.version, undefined);
        }
        pdf.withSavedPaper({ ...paper, apiReaderArticle: current.article, apiReaderPlan: current.plan }, () => {
            const tables = extract(current.article);
            current.plan.tableBindings.forEach((binding, index) => binding.cellBindings.forEach(cell => {
                const value = [tables[index].header, ...tables[index].rows][cell.renderedRow][cell.renderedColumn];
                assert.equal(pdf.savedCellMatches(binding, cell, value), true);
                assert.equal(pdf.savedCellMatches(structuredClone(binding), cell, value), false);
            }));
        });
        for (const field of ['sealedPdfTableEvidence', 'sealedPdfTableSelection']) {
            const changed = { ...paper, apiReaderArticle: current.article, apiReaderPlan: structuredClone(current.plan) };
            changed.apiReaderPlan.tableBindings[0][field].schemaFingerprint = 'f'.repeat(64);
            assert.throws(() => pdf.withSavedPaper(changed, () => {}));
        }
        const table = artifacts.tables.find(t => t.ordinal === 2);
        const identityView = compiler.renderReaderTableSelection({ tableIndex: 1, selection: {
            sourceTableOrdinal: 2, sourceRows: table.matrix.map((_row, index) => index),
            sourceColumns: table.matrix[0].map((_cell, index) => index) } }, artifacts);
        assert.deepEqual(pdf.bindingEvidence(table, identityView.binding, artifacts), pdf.bindingEvidence(table));
        const rendered = compiler.renderReaderTableSelection(envelope.payload.draft.tableBindings[1], artifacts);
        const md = extract(rendered.markdown)[0], rows = [md.header, ...md.rows];
        assert.equal(pdf.compiledSelectionDisplayMatches(table, rendered.binding, rows, artifacts), true);
        const badRows = structuredClone(rows); badRows[1][1] = '9999';
        assert.equal(pdf.compiledSelectionDisplayMatches(table, rendered.binding, badRows, artifacts), false);
        assert.equal(pdf.compiledSelectionDisplayMatches(table, structuredClone(rendered.binding), rows, artifacts), false);
        assert.equal(pdf.compiledSelectionDisplayMatches(structuredClone(table), rendered.binding, rows, artifacts), false);
        assert.equal(pdf.compiledSelectionDisplayMatches(artifacts.tables[3], rendered.binding, rows, artifacts), false);
        rendered.binding.cellBindings[4].sourceRow = 1;
        assert.throws(() => pdf.compiledSelectionDisplayMatches(table, rendered.binding, rows, artifacts), /capability changed/);
    })));
    const saved = { ...paper, apiReaderArticle: result.article, apiReaderPlan: result.plan };
    pdf.withSavedPaper(saved, () => {
        const tables = extract(result.article);
        result.plan.tableBindings.forEach((binding, i) => binding.cellBindings.forEach(cell => {
            const value = [tables[i].header, ...tables[i].rows][cell.renderedRow][cell.renderedColumn];
            assert.equal(pdf.savedCellMatches(binding, cell, value), true);
            assert.equal(pdf.savedCellMatches(structuredClone(binding), cell, value), false);
            assert.equal(pdf.savedCellMatches(binding, cell, '9999'), false);
        }));
        const binding = result.plan.tableBindings[0], cell = binding.cellBindings[4], original = cell.sourceRow;
        cell.sourceRow = 6;
        assert.equal(pdf.savedCellMatches(binding, cell, '5.87'), false);
        cell.sourceRow = original;
    });
    for (const mutate of [b => b.cellBindings[4].sourceRow = 6,
        b => b.sourceTableOrdinal = 4, b => b.sealedPdfTableEvidence.pdfSha256 = 'a'.repeat(64),
        b => b.cellBindings.pop(), b => b.sealedPdfTableSelection.sourceRows = [0, 1],
        b => b.cellBindings[0].unexpected = true,
        b => delete b.sealedPdfTableSelection]) {
        const changed = structuredClone(saved); mutate(changed.apiReaderPlan.tableBindings[0]);
        assert.throws(() => pdf.withSavedPaper(changed, () => {}));
    }
    assert.equal(sha(fs.readFileSync(snapshot.candidateFile)), snapshot.candidateSha256);
    assert.deepEqual(originalFiles, Object.fromEntries(fs.readdirSync(sourceDir).map(n => [n, sha(fs.readFileSync(path.join(sourceDir, n)))])));
    assert.equal(envelope.payload.attempts, 2); assert.equal(envelope.payload.fullAttempts, 1);
});
