'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const units = require('../scripts/lib/reader-source-table-column-units');
const real = require('./fixtures/daily-table4-column-unit-real-20261027.json');
const clone = () => structuredClone(real);
const prove = item => units.coverageFromTables(item.rendered, item.quotes, [item.sourceTable]);
function setSource(item, row, column, value) {
    item.sourceTable.matrix[row][column] = value;
    item.sourceTable.cells.find(cell => cell.row === row && cell.column === column).text = value;
}
const has = (proof, row, column) => proof.some(value => value.row === row && value.column === column);

test('real paid Table 4 retains its body, source identity and explicit percent columns', () => {
    assert.equal(crypto.createHash('sha256').update(real.body).digest('hex'), real.provenance.bodyUtf8Sha256);
    assert.equal(real.sourceTable.sourceDomSha256, real.provenance.sourceTableDomSha256);
    const proof = prove(real);
    // The real source says "no kk-NN". There is no explicit annotation for
    // that bare duplicated k, so the paid "no k-NN" row still cannot borrow it.
    assert.equal(proof.length, 36);
    assert.deepEqual([...new Set(proof.map(value => value.row))], [1, 2, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(has(proof, 3, 1), false);
    for (const value of proof) {
        assert.equal(value.unit, '%');
        assert.equal(value.sourceTableOrdinal, 4);
        assert.equal(value.sourceTableDomSha256, real.sourceTable.sourceDomSha256);
        assert.equal(value.sourceRow, value.row);
        assert.equal(value.sourceColumn, value.column);
        const source = real.sourceTable.cells.find(cell => cell.row === value.row && cell.column === value.column);
        assert.equal(value.sourceCellDomSha256, source.sourceDomSha256);
    }
    assert.deepEqual(proof.filter(value => value.row === 1 && value.column === 1).map(value => value.value), ['76.78', '0.17']);
    assert.equal(proof.some(value => value.column === 3), false, 'dimensionless rank cannot inherit percent');
});

test('an explicitly corrected source row name covers the full table without changing numbers (synthetic correction)', () => {
    const item = clone();
    item.rendered.rows[2][0] = item.sourceTable.matrix[3][0];
    assert.equal(prove(item).length, 40);
});

test('pure DOM matching cannot mint a verified source capability', () => {
    assert.deepEqual(units.coverage(real.rendered, real.quotes), []);
});

test('original missing percent headers never infer units from result magnitudes', () => {
    const item = clone();
    setSource(item, 0, 1, 'Final acc');
    setSource(item, 0, 2, 'AULC');
    assert.deepEqual(prove(item), []);
});

test('a different table with the same values cannot donate its percent header', () => {
    const item = clone(), donor = structuredClone(item.sourceTable);
    setSource(item, 0, 1, 'Final acc');
    setSource(item, 0, 2, 'AULC');
    donor.ordinal = 99;
    donor.caption = 'Table 99: Results of a different validation condition.';
    assert.deepEqual(units.coverageFromTables(item.rendered, item.quotes, [item.sourceTable, donor]), []);
});

test('duplicate original row names remain ambiguous even when result values distinguish them', () => {
    const item = clone();
    setSource(item, 2, 0, item.sourceTable.matrix[1][0]);
    const proof = prove(item);
    assert.equal(has(proof, 1, 1), false);
    assert.equal(has(proof, 1, 2), false);
    assert.equal(has(proof, 2, 1), false);
});

test('duplicate source tables remain ambiguous', () => {
    assert.deepEqual(units.coverageFromTables(real.rendered, real.quotes,
        [real.sourceTable, structuredClone(real.sourceTable)]), []);
});

test('missing or unrelated caption quote cannot bind a table', () => {
    const item = clone();
    item.quotes = ['Table 4: Measurements from a different experimental matrix.'];
    assert.deepEqual(prove(item), []);
});

test('caption operator or count changes do not collapse as a display duplicate', () => {
    for (const [from, to] of [['×\\times', '÷\\times'], ['48 settings', '49 settings']]) {
        const item = clone();
        item.quotes[0] = item.quotes[0].replace(from, to);
        assert.deepEqual(prove(item), []);
    }
});

test('explicit superscript source identity must have the same visible name', () => {
    const item = clone();
    setSource(item, 5, 0, 'ancma^{\\mathrm{knn}} only');
    assert.equal(has(prove(item), 5, 1), false);
});

test('an explicit parameter annotation with a different value remains rejected', () => {
    const item = clone();
    setSource(item, 9, 0, 'k=10k{=}11 (default)');
    assert.equal(has(prove(item), 9, 1), false);
});

test('bare duplicated parameter text receives no projection', () => {
    const item = clone();
    setSource(item, 9, 0, 'k=10k=10 (default)');
    assert.equal(has(prove(item), 9, 1), false);
});

test('a scalar annotation cannot donate an unobserved subscript', () => {
    const item = clone();
    setSource(item, 7, 0, 'ℓ\\ell_2 only');
    item.rendered.rows[6][0] = 'l_2 only';
    assert.equal(has(prove(item), 7, 1), false);
});

test('bare pasted numeric duplicates remain rejected', () => {
    const item = clone();
    setSource(item, 1, 1, '76.7876.78');
    assert.equal(has(prove(item), 1, 1), false);
});

test('a changed uncertainty rejects the complete source cell', () => {
    const item = clone();
    item.rendered.rows[0][1] = '76.78±0.18';
    assert.equal(has(prove(item), 1, 1), false);
});

test('swapped numeric columns cannot borrow the other metric evidence', () => {
    const item = clone();
    [item.rendered.rows[0][1], item.rendered.rows[0][2]] = [item.rendered.rows[0][2], item.rendered.rows[0][1]];
    assert.equal(has(prove(item), 1, 1), false);
    assert.equal(has(prove(item), 1, 2), false);
});
