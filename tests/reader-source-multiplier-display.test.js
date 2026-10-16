'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const normalize = require('../scripts/lib/reader-source-display').normalizeReaderSourceDisplayArtifacts;
const fs = require('node:fs'), path = require('node:path');
test('真实Detection完整原DOM四个Lift格仅去明确乘号TeX副本，数字精度原字节保留', () => {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-signed-pruned-table-real-paid.json')));
    const cells = f.source.structuredArtifacts.tables.find(t => t.ordinal === 1).matrix.slice(1).map(r => r[2]);
    assert.deepEqual(cells, ['1.06×\\times', '1.30×\\times', '1.36×\\times', '1.56×\\times']);
    assert.deepEqual(cells.map(normalize), ['1.06×', '1.30×', '1.36×', '1.56×']);
    for (const scalar of ['1.00', '01.060', '+1.30', '-.50', '−0.50'])
        assert.equal(normalize(scalar + '×\\times'), scalar + '×');
    assert.equal(normalize('| Lift | 1.30×\\times |\n| Gain | 1.56×\\times |'), '| Lift | 1.30× |\n| Gain | 1.56× |');
});
test('乘积、数字副本、未知命令、额外运算/脚注、非完整格和裸重复不能合并', () => {
    for (const value of ['1.06×\\times2', '1.06×\\times 2', '1.06×\\times+1', '1.06×\\times +1',
        '1.06×\\times^2', '1.06×\\times_{a}', '1.06×\\times \\foo', '1.06×\\times(a)',
        '1.06×\\times*', '1.06×\\times %', '1.06×\\times text', 'Lift 1.06×\\times',
        '1.06××', '1.06×\\cdot', '1.06×\\times1.06', '1.06×1.06\\times',
        '1.06×\\times\n+1', '1.06e2×\\times'])
        assert.equal(normalize(value), value, value);
});
