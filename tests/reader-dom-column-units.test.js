'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../scripts/lib/reader-source-table-column-units');
const cases = require('./fixtures/reader-dom-column-unit-cases.json');
for (const item of cases) test(item.name, () => {
    const actual = units.coverageFromTables(item.table, item.quotes, item.tables);
    assert.deepEqual(actual.map(value => [value.row, value.column, value.value, value.unit]), item.expected);
    for (const value of actual) for (const field of ['sourceTableDomSha256', 'headerCellDomSha256', 'sourceCellDomSha256'])
        assert.match(value[field], /^[a-f0-9]{64}$/);
});
test('unverified callers cannot obtain DOM column capability', () => {
    const item = cases[0];
    assert.deepEqual(units.coverage(item.table, item.quotes), []);
});
