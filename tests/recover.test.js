'use strict';
const test = require('node:test');
const assert = require('node:assert');
const recover = require('../scripts/recover');

test('collectFailures 遇审查凭证和共享博客锁错误仍收齐后续失败', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const date = '2026-10-22';
    const currentDir = path.resolve(__dirname, '../data/current');
    const analysisFile = path.join(currentDir, 'deep-analysis-result.json');
    const reviewFile = path.join(currentDir, `blog-review-failure-${date}.json`);
    const readFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === analysisFile) return JSON.stringify({ batchDate: date, papers: [
            { arxivId: '2610.12345', error: '缺少与当前页面字节匹配的审查凭证' },
            { arxivId: '2610.12346', error: '等待共享博客仓库锁超时' },
            { arxivId: '2610.12347', error: '来源 SHA 不一致' }
        ] });
        if (file === reviewFile) return JSON.stringify({ files: [] });
        return readFileSync(file, ...args);
    });
    const failures = recover.collectFailures(date);
    assert.deepStrictEqual(failures.map(item => item.code), [
        'blog-review-receipt-missing', 'blog-lock-busy', 'source-sha-mismatch'
    ]);
    const groups = recover.plan(failures);
    const output = recover.render(date, failures, groups);
    assert.match(output, /3 个失败项/);
    assert.match(output, /blog-review-receipt-missing/);
    assert.match(output, /blog-lock-busy/);
    assert.ok(groups.some(group => group.command === `npm run blog:review -- --date ${date}`));
    assert.ok(groups.some(group => group.command === 'npm run locks'));
});

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
