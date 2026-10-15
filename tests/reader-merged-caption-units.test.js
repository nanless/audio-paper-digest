'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const units = require('../scripts/lib/reader-source-table-column-units');
const fixture = require('./fixtures/reader-merged-caption-unit-cases.json');
function prepare(item) {
    const value = structuredClone(fixture.base);
    for (const op of item.operations) {
        const parts = op.path.split('/').slice(1); let target = value;
        for (const part of parts.slice(0,-1)) target = target[part];
        const last = parts.at(-1);
        if (op.remove) target.splice(Number(last),1); else target[last] = structuredClone(op.value);
    }
    return value;
}
for (const item of fixture.cases) test(item.name, () => {
    const value = prepare(item), actual = units.coverageFromTables(value.table,value.quotes,value.tables);
    assert.deepEqual(actual.map(v => [v.row,v.column,v.value,v.unit]), item.expected);
    for (const record of actual) {
        assert.match(record.sourceCellDomSha256,/^[a-f0-9]{64}$/);
        assert.equal(record.headerPathCellDomSha256.length,2);
    }
});
test('merged caption proof cannot be obtained outside verified source scope', () => {
    assert.deepEqual(units.coverage(fixture.base.table,fixture.base.quotes),[]);
});
