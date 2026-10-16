'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const display = require('../scripts/lib/reader-source-display').normalizeReaderSourceDisplayArtifacts;
const units = require('../scripts/lib/reader-source-table-column-units');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = [
    [String.raw`∼\sim1.0 / 0.13`, '∼1.0 / 0.13'],
    [String.raw`∼\sim0.005 / ∼\sim0.005`, '∼0.005 / ∼0.005'],
    [String.raw`∼\sim10 KB`, '∼10 KB'],
    [String.raw`| ∼\sim10 KB | 𝒯0\mathcal{T}_{0} |`, '| ∼10 KB | 𝒯0 |'],
    [String.raw`𝒯0\mathcal{T}_{0}`, '𝒯0'],
    ['2\u200b𝒯02\\mathcal{T}_{0}', '2\u200b𝒯0'],
    [String.raw`𝒯2+𝒯1+2𝒯0\mathcal{T}_{2}+\mathcal{T}_{1}+2\mathcal{T}_{0}`, '𝒯2+𝒯1+2𝒯0'],
    [String.raw`𝒯1 + 𝒯0 \mathcal{T}_{1} + \mathcal{T}_{0}`, '𝒯1 + 𝒯0'],
    ...[String.raw`∼\sim+1`, String.raw`∼\sim1+2`, String.raw`∼\sim1.0\unknown`,
        String.raw`∼\approx1.0`, String.raw`1.01.0`, String.raw`22.022.0`,
        String.raw`𝒯0\mathcal{T}_{1}`, String.raw`𝒯0\mathcal{L}_{0}`, String.raw`2𝒯03\mathcal{T}_{0}`,
        String.raw`𝒯1+𝒯0\mathcal{T}_{0}+\mathcal{T}_{1}`, String.raw`𝒯1+𝒯0\mathcal{T}_{1}-\mathcal{T}_{0}`,
        String.raw`𝒯0\mathcal{T}_{0}^{2}`, String.raw`𝒯0\mathcal{T}_{0}\unknown`,
        String.raw`𝒯12\math cal{T}_{12}`, String.raw`𝒯12\mathcal{T}_{1 2}`,
        String.raw`𝒯0𝒯0`, String.raw`text 𝒯0\mathcal{T}_{0}`].map(raw => [raw, raw])
];
test('bounded explicit source-cell projection preserves values, order and unknown continuations', () => {
    for (const [raw, expected] of cases) {
        assert.equal(display(raw), expected, raw);
        assert.equal(display(display(raw)), expected, 'idempotence: ' + raw);
    }
});
test('publisher replays exactly the same bounded source projections', () => {
    const file = path.resolve(__dirname, '../scripts/publish-to-blog.py');
    const code = `import ast,json,re,unicodedata,sys\ns=ast.parse(open(sys.argv[1]).read())\nkeep={'_normalize_api_reader_explicit_symbol_projection','_normalize_api_reader_display_artifacts'}\nexec(compile(ast.Module(body=[n for n in s.body if isinstance(n,ast.FunctionDef) and n.name in keep],type_ignores=[]),sys.argv[1],'exec'))\nprint(json.dumps([_normalize_api_reader_display_artifacts(v) for v in json.load(sys.stdin)],ensure_ascii=False))`;
    const result = execFileSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', code, file],
        { input: JSON.stringify(cases.map(([raw]) => raw)), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), cases.map(([, expected]) => expected));
});

// Constructed structural fixture, separate from the optional original paid run.
function accuracyFixture() {
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('table'),
        caption: 'Table 1: Held-out optimizer measurements under a fixed protocol.', cells: [],
        matrix: Array.from({ length: 6 }, () => Array(5).fill(null)) };
    function cell(row, column, text, rowspan = 1, colspan = 1, header = row < 2) {
        const value = { row, column, text, rowspan, colspan, header, sourceDomSha256: sha(`cell:${row}:${column}`) };
        table.cells.push(value);
        for (let r = row; r < row + rowspan; r++) for (let c = column; c < column + colspan; c++) table.matrix[r][c] = text;
    }
    cell(0, 0, 'Model', 2); cell(0, 1, 'Optimizer', 2); cell(0, 2, 'Accuracy (%)', 1, 3);
    for (const [i, text] of ['Val (10)', 'Overall', 'Test (90)'].entries()) cell(1, i + 2, text);
    for (const [r, model] of [[2, 'Alpha Model'], [4, 'Beta Model']]) {
        cell(r, 0, model, 2); cell(r, 1, 'None'); cell(r + 1, 1, 'Search');
        for (let c = 2; c < 5; c++) { cell(r, c, String(r * 10 + c)); cell(r + 1, c, String((r + 1) * 10 + c)); }
    }
    const rendered = { header: ['Model', 'Optimizer', 'Val (10) Accuracy (%)', 'Overall Accuracy (%)', 'Test (90) Accuracy (%)'],
        rows: table.matrix.slice(2).map(row => row.slice()) };
    return { table, rendered, quotes: [table.caption], tables: [table] };
}
function updateCell(table, row, column, value) {
    const cell = table.cells.find(cell => cell.row === row && cell.column === column);
    cell.text = value;
    for (let r = row; r < row + cell.rowspan; r++) for (let c = column; c < column + cell.colspan; c++) table.matrix[r][c] = value;
}
function splitLeafCrossTableFixture() {
    const f = accuracyFixture(), other = structuredClone(f.table);
    other.ordinal = 2; other.sourceDomSha256 = sha('other table');
    other.caption = 'Table 2: Separate optimizer measurements under another protocol.';
    updateCell(f.table, 1, 3, 'Unused A'); updateCell(f.table, 1, 4, 'Unused B');
    updateCell(other, 1, 2, 'Unused C'); updateCell(other, 1, 3, 'Unused D');
    f.tables.push(other); f.quotes.push(other.caption);
    return f;
}
function literalRowFixture(wrong = false) {
    const f = accuracyFixture();
    updateCell(f.table, 2, 0, 'Alpha_Model');
    f.rendered.rows[0][0] = f.rendered.rows[1][0] = wrong ? 'AlphaModel' : '`Alpha_Model`';
    return f;
}
test('merged percent header requires its complete DOM and composite row identity', () => {
    const f = accuracyFixture(), before = JSON.stringify(f);
    const result = units.coverageFromTables(f.rendered, f.quotes, f.tables);
    assert.equal(result.length, 12);
    assert.ok(result.every(record => record.headerPathCellDomSha256.length === 2 && record.sourceRowIdentityCellDomSha256.length === 2));
    assert.equal(JSON.stringify(f), before);
    assert.deepEqual(units.coverage(f.rendered, f.quotes), [], 'unverified callers get no capability');
});
test('missing units, cross-table evidence, malformed spans and duplicate identities remain blocked', () => {
    for (const mutate of [
        f => updateCell(f.table, 0, 2, 'Accuracy'),
        f => { f.quotes = ['Table 8: A completely unrelated optimizer experiment.']; },
        f => f.tables.push(structuredClone(f.table)),
        f => f.table.cells.pop(),
        f => { f.table.cells[0].rowspan = 3; },
        f => { f.rendered.header[2] = 'Val (11) Accuracy (%)'; f.rendered.header[3] = 'Unknown Accuracy (%)'; f.rendered.header[4] = 'Other Accuracy (%)'; },
        f => { for (const row of f.rendered.rows) row[0] = 'Unknown Model'; }
    ]) {
        const f = accuracyFixture(); mutate(f);
        assert.equal(units.coverageFromTables(f.rendered, f.quotes, f.tables).length, 0);
    }
    const f = accuracyFixture(); f.rendered.rows[0][2] = f.rendered.rows[2][2];
    assert.ok(!units.coverageFromTables(f.rendered, f.quotes, f.tables).some(x => x.row === 1 && x.column === 2));
    updateCell(f.table, 3, 1, 'None');
    assert.ok(!units.coverageFromTables(f.rendered, f.quotes, f.tables).some(x => x.row === 1));
});
test('publisher agrees on constructed DOM unit positive and negative cases', () => {
    const samples = [accuracyFixture(), accuracyFixture(), accuracyFixture(), accuracyFixture(), splitLeafCrossTableFixture(), literalRowFixture(), literalRowFixture(true)];
    updateCell(samples[1].table, 0, 2, 'Accuracy'); samples[2].tables.push(structuredClone(samples[2].table));
    samples[3].rendered.rows[0][2] = '999';
    const code = `import json,sys,importlib.util\nsys.path.insert(0,sys.argv[1]+'/scripts')\ns=importlib.util.spec_from_file_location('p',sys.argv[1]+'/scripts/publish-to-blog.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)\nprint(json.dumps([sorted(p._reader_dom_table_unit_coverage(x['rendered'],x['quotes'],x['tables'])) for x in json.load(sys.stdin)]))`;
    const output = execFileSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', code, path.resolve(__dirname, '..')],
        { input: JSON.stringify(samples), encoding: 'utf8' });
    const expected = samples.map(f => units.coverageFromTables(f.rendered, f.quotes, f.tables)
        .map(x => [x.row, x.column, x.value, x.unit]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    assert.deepEqual(JSON.parse(output), expected);
});
test('split leaf columns from separate original tables cannot compose one percent table', () => {
    const f = splitLeafCrossTableFixture();
    assert.deepEqual(units.coverageFromTables(f.rendered, f.quotes, f.tables), []);
});
test('literal model identity keeps inner underscores while paired Markdown wrappers may render it', () => {
    for (const [wrong, count] of [[false, 12], [true, 0]]) {
        const f = literalRowFixture(wrong);
        assert.equal(units.coverageFromTables(f.rendered, f.quotes, f.tables).length, count);
    }
});

const realRun = process.env.PD_READER_REAL_SOURCE_RUN;
test('original paid source tables replay without mutation; known bad original grids stay blocked', { skip: !realRun }, () => {
    const tablesApi = require('../scripts/lib/reader-tables'), contract = require('../scripts/analysis-contract');
    const readSource = id => JSON.parse(fs.readFileSync(path.join(realRun, 'sources', id, 'generation-000001/source-runtime.json'))).structuredArtifacts;
    for (const [id, ordinal] of [['2610.20105', 2], ['2610.21440', 3]]) {
        const source = readSource(id), before = JSON.stringify(source);
        assert.equal(tablesApi.assessReaderCompleteTableEligibility(source.tables.find(t => t.ordinal === ordinal)).eligible, true);
        assert.equal(JSON.stringify(source), before);
    }
    const source = readSource('2610.20085'), candidate = JSON.parse(fs.readFileSync(path.join(realRun, 'reader-attempts/5011724c637e73266e3b00f954d1f8fd6260bd45aa7b376951b8d13320f9bc40.json')));
    const draft = candidate.payload.draft, before = JSON.stringify(candidate);
    const tables = draft.sections.flatMap(section => contract.extractMarkdownTables(section.body));
    assert.deepEqual([0, 1].map(i => units.coverageFromTables(tables[i], draft.tableBindings[i].sourceQuotes, source.tables).length), [18, 9]);
    assert.equal(JSON.stringify(candidate), before);
    for (const [id, ordinal] of [['2610.20863', 3], ['2610.22064', 2]]) {
        const table = readSource(id).tables.find(table => table.ordinal === ordinal);
        assert.equal(tablesApi.assessReaderCompleteTableEligibility(table).eligible, false, id + ':' + ordinal);
    }
    assert.equal(display('−5-5 to 55'), '−5-5 to 55', 'bare range corruption cannot be guessed');
    const bad = JSON.parse(fs.readFileSync(path.join(realRun, 'reader-attempts/23ee8b5a971bc2cb868bd50bba1467c801d8ae1c92b35efccff13afc6e41441e.json'))).payload.draft;
    const resultTable = bad.sections.flatMap(section => contract.extractMarkdownTables(section.body))[1];
    assert.ok(require('../scripts/deep-analyzer').readerTableHeaderUnitEvidenceFailures(resultTable, bad.tableBindings[1].sourceQuotes).length > 0);
});
