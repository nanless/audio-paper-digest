'use strict';
const test = require('node:test');
const assert = require('node:assert');
const recover = require('../scripts/recover');

test('plan 按命令聚合失败项并保留可重试性', () => {
    const groups = recover.plan([
        { source: 'analysis', paperId: '2610.1', code: 'reader-repair-no-progress', label: 'x', retryable: false, command: 'npm run deep -- --date 2026-10-21', doc: 'd', message: 'm' },
        { source: 'analysis', paperId: '2610.2', code: 'reader-repair-no-progress', label: 'x', retryable: false, command: 'npm run deep -- --date 2026-10-21', doc: 'd', message: 'm2' }
    ]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].items.length, 2);
    assert.match(groups[0].command, /npm run deep/);
});

test('buildExecutionArgs 保留建议命令的真实 flags 并替换日期', () => {
    const args = recover.buildExecutionArgs('npm run api:reader:refresh -- --all --date <DATE> --concurrency 5 --scoring-and-reader', '2026-10-21');
    assert.deepStrictEqual(args, ['run', 'api:reader:refresh', '--', '--all', '--date', '2026-10-21', '--concurrency', '5', '--scoring-and-reader']);
    assert.deepStrictEqual(recover.buildExecutionArgs('npm run config:check', '2026-10-21'), ['run', 'config:check', '--']);
    assert.strictEqual(recover.buildExecutionArgs('npm run table:check -- --draft <FILE>', '2026-10-21'), null);
    assert.strictEqual(recover.buildExecutionArgs('npm run recover -- --date <DATE>', '2026-10-21'), null);
});

test('无失败时 render 给出正常提示', () => {
    const text = recover.render('2026-10-21', [], []);
    assert.match(text, /未发现失败项/);
});
