'use strict';
const test = require('node:test');
const assert = require('node:assert');
const report = require('../scripts/storage-report');

test('保留建议覆盖必须保留/可压缩/可删', () => {
    const text = report.adviceLines().join('\n');
    assert.match(text, /必须保留/);
    assert.match(text, /可压缩/);
    assert.match(text, /可删/);
    assert.ok(!/unlink|rmSync|--apply/.test(text), '建议文本不能鼓励直接删除');
});

test('--advice-only 不触发完整 status 扫描（只返回 0）', () => {
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try { assert.strictEqual(report.main(['--advice-only']), 0); } finally { console.log = original; }
    assert.match(logs.join('\n'), /清理必须先预览/);
});
