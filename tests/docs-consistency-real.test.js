'use strict';
const test = require('node:test');
const assert = require('node:assert');
const docs = require('../scripts/docs-consistency');

test('仓库真实文档中的 npm run 命令都存在', () => {
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try { assert.strictEqual(docs.main([]), 0); } finally { console.log = original; }
    assert.match(logs.join('\n'), /通过/);
});
