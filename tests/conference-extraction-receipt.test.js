'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const receipt = require('../scripts/lib/conference-extraction-receipt.js');

test('针对 UAI U+001E 提取固定数据，Node 复现 Python 的 isspace 行为', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'conference-extraction',
        'uai-2026-python-whitespace.json'), 'utf8'));
    assert.equal([...fixture.sample].filter(character => character.codePointAt(0) === 0x1e).length,
        fixture.observedOccurrences);
    assert.equal(receipt.pythonNonWhitespaceCharacters(fixture.sample),
        fixture.expectedPythonNonWhitespaceCharacters);
    assert.equal([...fixture.sample].filter(character => !/\s/u.test(character)).length,
        fixture.expectedPythonNonWhitespaceCharacters + fixture.observedOccurrences,
        'the former ECMAScript count demonstrates the original one-character drift');
});

test('与 Python 兼容的空白不含 BOM，但包含 Unicode White_Space', () => {
    assert.equal(receipt.pythonNonWhitespaceCharacters(`a\ufeffb`), 3);
    assert.equal(receipt.pythonNonWhitespaceCharacters('a\u0085b\u001cb\u001db\u001eb\u001fb'), 6);
    assert.equal(receipt.pythonNonWhitespaceCharacters('a\u2003b\u2028c'), 3);
});
