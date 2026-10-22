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

test('无失败时 render 给出正常提示', () => {
    const text = recover.render('2026-10-21', [], []);
    assert.match(text, /未发现失败项/);
});
