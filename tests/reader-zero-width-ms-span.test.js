'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const span = require('../scripts/lib/reader-dom-span-projection');
const fixture = require('./fixtures/reader-zero-width-ms-span-real.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const raw = '0.991\u200bm\u200bs0.991ms';
const view = span.isPublicationZeroWidthDuplicateMsCellView;

test('actual four paid/source cells admit only the exact existing publisher ms view', () => {
    assert.equal(sha(fixture.canonicalTable.markdown), fixture.binding.renderedTableSha256);
    const rows = [fixture.publicationTable.header, ...fixture.publicationTable.rows];
    const measured = fixture.binding.cellBindings.filter(cell => cell.sourceText.includes('\u200b'));
    assert.equal(measured.length, 4);
    for (const cell of measured) {
        assert.equal(cell.renderedText, cell.sourceText);
        assert.equal(view(cell.renderedText, rows[cell.renderedRow][cell.renderedColumn], cell.sourceText), true);
    }
    for (const number of ['0', '0.991', '001.290', '.991', '+1.216', '-9.760', '−9.760']) {
        const source = `${number}\u200bm\u200bs${number}ms`;
        assert.equal(view(source, `${number} ms`, source), true);
    }
});

test('whole-cell predicate rejects changed values, precision, units, invisible bytes and source identity', () => {
    for (const [canonical, displayed, source = canonical] of [
        [raw, '0.992 ms'], [raw, '0.9910 ms'], [raw, '0.991ms'], [raw, '0.991  ms'],
        [raw, '0.991 s'], [raw, '0.991 mS'], [raw, '0.991 ms suffix'],
        [raw, raw], [raw, '0.991 ms', raw.replace('0.991', '0.992')],
        [raw, '0.991 ms', '0.991 ms'], ['0.991 ms', '0.991 ms', raw],
        [raw.replace('s0.991', 's0.9910'), '0.991 ms'],
        [raw.replace('\u200b', ''), '0.991 ms'],
        [raw.replace('\u200b', '\u200b\u200b'), '0.991 ms'],
        [raw.replaceAll('\u200b', '\u200c'), '0.991 ms'],
        ['0.991ms0.991ms', '0.991 ms'], [raw.replaceAll('ms', 's'), '0.991 ms'],
        [raw.replaceAll('0.991', '9.91e-1'), '9.91e-1 ms'],
        [raw.replaceAll('0.991', '٠.٩٩١'), '٠.٩٩١ ms'],
        [null, '0.991 ms', raw], [raw, null], [raw, '0.991 ms', null],
        ['1'.repeat(513) + raw, '0.991 ms']
    ]) assert.equal(view(canonical, displayed, source), false, JSON.stringify([canonical, displayed, source]));
});

test('quotes, code, links, fences, indentation, prefixes and continuing expressions stay outside the view', () => {
    for (const source of ['“' + raw + '”', '`' + raw + '`', '[' + raw + '](https://example.org)',
        '```\n' + raw + '\n```', '    ' + raw, 'value: ' + raw, raw + '+1',
        '<span>' + raw + '</span>', raw + '\n', raw + '\r', 'https://example.org/' + raw]) {
        assert.equal(view(source, '0.991 ms', source), false, source);
    }
});

function accepted(table, binding, rendered) {
    const rows = [rendered.header, ...rendered.rows];
    return binding.cellBindings.filter(cell => span.fullWidthLabelBlankMatches(table, binding, cell,
        rows[cell.renderedRow]?.[cell.renderedColumn], rendered)).map(cell => [cell.renderedRow, cell.renderedColumn]);
}
test('real complete DOM/binding yields identical three footer blanks in canonical and actual publication views', () => {
    const before = JSON.stringify(fixture);
    assert.deepEqual(accepted(fixture.sourceTable, fixture.binding, fixture.canonicalTable), [[4, 1], [4, 2], [4, 3]]);
    assert.deepEqual(accepted(fixture.sourceTable, fixture.binding, fixture.publicationTable), [[4, 1], [4, 2], [4, 3]]);
    assert.equal(JSON.stringify(fixture), before);
    assert.equal(span.isPublicationTechnicalAsteriskCellView('T5* Time', 'T5\\* Time', 'T5* Time'), true);
});

test('a changed numeric cell or invalid DOM, coordinate, binding, footer or deleted value rejects the entire span proof', () => {
    const alterations = [
        (_t, _b, r) => { r.rows[1][2] = '0.992 ms'; },
        (_t, _b, r) => { r.rows[1][2] = '0.9910 ms'; },
        (_t, _b, r) => { r.rows[1][2] = ''; },
        (_t, _b, r) => { r.rows[1][2] = '0.991 s'; },
        (_t, b) => { b.cellBindings[10].renderedText = '0.991 ms'; },
        (_t, b) => { b.cellBindings[10].sourceText = '0.991 ms'; },
        (_t, b) => { b.cellBindings[10].sourceDomSha256 = 'f'.repeat(64); },
        (_t, b) => { b.sourceTableDomSha256 = 'f'.repeat(64); },
        (_t, b) => { b.cellBindings[10].sourceColumn = 3; },
        (_t, b) => { b.cellBindings[10].renderedColumn = 3; },
        (_t, b) => { b.cellBindings[10] = structuredClone(b.cellBindings[11]); },
        (_t, b) => { b.cellBindings.pop(); },
        (t) => { t.cells.find(cell => cell.row === 4).colspan = 3; },
        (t) => { t.cells.find(cell => cell.row === 4).sourceDomSha256 = 'f'.repeat(64); },
        (_t, _b, r) => { r.rows[3][0] = ''; },
        (_t, _b, r) => { r.rows[3][1] = 'aRefer Figure 3'; }
    ];
    for (const alter of alterations) {
        const table = structuredClone(fixture.sourceTable), binding = structuredClone(fixture.binding);
        const rendered = structuredClone(fixture.publicationTable);
        alter(table, binding, rendered);
        assert.deepEqual(accepted(table, binding, rendered), [], String(alter));
    }
});
