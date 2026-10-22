'use strict';
const test = require('node:test');
const assert = require('node:assert');
const impact = require('../scripts/impact');

test('已知路径列出受影响入口与测试', () => {
    const result = impact.impactOf('scripts/publish_common.py');
    assert.strictEqual(result.matched, true);
    assert.ok(result.entries.includes('blog:review'));
    assert.ok(result.tests.some(test => test.includes('test_publish')));
});

test('分析引擎与目录参数能命中', () => {
    const engine = impact.impactOf('scripts/analysis-engine.js');
    assert.strictEqual(engine.matched, true);
    assert.ok(engine.entries.includes('deep'));
    const dir = impact.impactOf('scripts');
    assert.strictEqual(dir.matched, true);
});

test('未知路径给出通用建议', () => {
    const result = impact.impactOf('unknown/file.txt');
    assert.strictEqual(result.matched, false);
    assert.match(result.scope, /通用规则/);
});
