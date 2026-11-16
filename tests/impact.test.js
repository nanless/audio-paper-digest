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

function entryCovered(entries, name) {
    return entries.some(entry => entry === name
        || entry.endsWith(':*') && name.startsWith(entry.slice(0, -1)));
}

test('package.json 里每个 Reader 相关入口都有映射', () => {
    // 这些脚本直接驱动会读取/重验 Reader 的流程；新增同类入口时先登记到这里。
    const driverPattern = /(?:deep-analysis-only|batch-analyze|reanalyze|reanalyze-selected|refresh-api-reader|conference-process|migrate-conference-process|historical-direct-rewrite-run|historical-direct-publication)\.js/;
    const readerEntries = Object.entries(require('../package.json').scripts)
        .filter(([, command]) => driverPattern.test(command))
        .map(([name]) => name);
    assert.ok(readerEntries.length > 0);
    const result = impact.impactOf('scripts/lib/reader-contract.js');
    assert.strictEqual(result.matched, true);
    for (const name of readerEntries) {
        assert.ok(entryCovered(result.entries, name),
            `${name} 未出现在 Reader 库影响映射：${result.entries.join(', ')}`);
    }
});
