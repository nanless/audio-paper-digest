'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const normalize = require('../scripts/lib/reader-source-display').normalizeReaderSourceDisplayArtifacts;
const fs = require('node:fs'), path = require('node:path');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-source-multiplier-display-cases.json'))).cases;
test('真实Detection完整原DOM四个Lift格仅去明确乘号TeX副本，数字精度原字节保留', () => {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-signed-pruned-table-real-paid.json')));
    const cells = f.source.structuredArtifacts.tables.find(t => t.ordinal === 1).matrix.slice(1).map(r => r[2]);
    assert.deepEqual(cells, ['1.06×\\times', '1.30×\\times', '1.36×\\times', '1.56×\\times']);
    assert.deepEqual(cells.map(normalize), ['1.06×', '1.30×', '1.36×', '1.56×']);
    assert.deepEqual(cases.filter(c => c.kind === 'real-dom').map(c => c.input), cells);
    for (const item of cases.filter(c => c.kind !== 'negative'))
        assert.equal(normalize(item.input), item.displayText, item.input);
    assert.equal(normalize('| Lift | 1.30×\\times |\n| Gain | 1.56×\\times |'), '| Lift | 1.30× |\n| Gain | 1.56× |');
});
test('乘积、数字副本、未知命令、额外运算/脚注、非完整格和裸重复不能合并', () => {
    for (const item of cases.filter(c => c.kind === 'negative'))
        assert.equal(normalize(item.input), item.displayText, item.input);
});
