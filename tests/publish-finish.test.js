'use strict';
const test = require('node:test');
const assert = require('node:assert');
const finish = require('../scripts/publish-finish');

test('收尾清单提示 digest:status、verify:web 与视觉步骤', () => {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(String(line));
    try { assert.strictEqual(finish.main(['--date', '2099-01-01']), 0); } finally { console.log = original; }
    const text = lines.join('\n');
    assert.match(text, /digest:status/);
    assert.match(text, /verify:web/);
    assert.match(text, /visual:prepare/);
    assert.ok(!/image_gen|生图 API/.test(text));
});

test('缺日期返回 2', () => {
    assert.strictEqual(finish.main([]), 2);
});
