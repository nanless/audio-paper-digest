'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../scripts/review-overrides-cli');
const overrides = require('../scripts/lib/review-overrides');

test('review-overrides-cli 报告匹配与剩余 error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-overrides-'));
    const failure = path.join(dir, 'blog-review-failure-2099-01-01.json');
    fs.writeFileSync(failure, JSON.stringify({ files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: true, issues: [
        { severity: 'error', description: '某句 与像素冲突' },
        { severity: 'error', description: '另一个真实错误' }
    ] }] }));
    const overrideFile = path.join(dir, 'overrides.json');
    fs.writeFileSync(overrideFile, JSON.stringify({
        contract: 'blog-review-overrides-v1', batchDate: '2099-01-01', publicationCommit: 'b'.repeat(40),
        overrides: [{ path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '某句 与像素冲突', evidence: '来源页 3 行', reviewer: 'r' }]
    }));
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try { assert.strictEqual(cli.main(['--date', '2099-01-01', '--file', overrideFile, '--failure-file', failure, '--json']), 1); } finally { console.log = original; }
    const report = JSON.parse(logs.join('\n'));
    assert.strictEqual(report.matched, 1);
    assert.strictEqual(report.remainingErrors, 1);
    assert.strictEqual(report.wouldPass, false);
    // 全部 error 被覆盖时返回 0
    fs.writeFileSync(failure, JSON.stringify({ files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: true, issues: [
        { severity: 'error', description: '某句 与像素冲突' }
    ] }] }));
    logs.length = 0;
    console.log = line => logs.push(String(line));
    try { assert.strictEqual(cli.main(['--date', '2099-01-01', '--file', overrideFile, '--failure-file', failure, '--json']), 0); } finally { console.log = original; }
    // 页级 error 全部被解释但仍 passed:false：应报告为已被解释的失败页并放行（无未解释 pending）
    fs.writeFileSync(failure, JSON.stringify({ files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false, issues: [
        { severity: 'error', description: '某句 与像素冲突' }
    ] }] }));
    logs.length = 0;
    console.log = line => logs.push(String(line));
    let overriddenCode;
    try { overriddenCode = cli.main(['--date', '2099-01-01', '--file', overrideFile, '--failure-file', failure, '--json']); } finally { console.log = original; }
    assert.strictEqual(overriddenCode, 0);
    const overriddenReport = JSON.parse(logs.join('\n'));
    assert.strictEqual(overriddenReport.remainingErrors, 0);
    assert.strictEqual(overriddenReport.pendingBlockedFiles, 0);
    assert.strictEqual(overriddenReport.overriddenFailedPages, 1);

    // pending 页面（passed:false, issues 空）不能被 overrides 放行
    fs.writeFileSync(failure, JSON.stringify({ files: [{ path: 'content/posts/b.md', sha256: 'b'.repeat(64), passed: false, failureKind: 'pending', issues: [] }] }));
    logs.length = 0;
    console.log = line => logs.push(String(line));
    let pendingCode;
    try { pendingCode = cli.main(['--date', '2099-01-01', '--file', overrideFile, '--failure-file', failure, '--json']); } finally { console.log = original; }
    assert.strictEqual(pendingCode, 1);
    const pendingReport = JSON.parse(logs.join('\n'));
    assert.strictEqual(pendingReport.pendingBlockedFiles, 1);
    assert.strictEqual(pendingReport.wouldPass, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

function capture(fn) {
    const out = { log: [], warn: [], error: [] };
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = line => out.log.push(String(line));
    console.warn = line => out.warn.push(String(line));
    console.error = line => out.error.push(String(line));
    try { return { code: fn(), out }; } finally { Object.assign(console, original); }
}

test('--help 优先：help 后跟未知参数只显示 help 并退出 0', () => {
    const help = capture(() => cli.main(['--help', '--definitely-unknown', '--json']));
    assert.strictEqual(help.code, 0);
    assert.ok(help.out.error.length === 0);
    const usage = JSON.parse(help.out.log.join('\n')).usage;
    assert.match(usage, /--receipt/);
    const plain = capture(() => cli.main(['--unknown-flag', '--help']));
    assert.strictEqual(plain.code, 0);
    assert.match(plain.out.log.join('\n'), /用法:/);
    // 没有 help 时，未知参数仍然是错误，由入口包装成退出码 2。
    assert.throws(() => cli.main(['--definitely-unknown']), /未知参数/);
});

test('--receipt 绑定审查凭证 publicationCommit：匹配通过、不匹配退出 2、缺字段警告后仍校验 batchDate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-overrides-receipt-'));
    try {
        const failure = path.join(dir, 'blog-review-failure-2099-01-02.json');
        fs.writeFileSync(failure, JSON.stringify({ files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: true, issues: [
            { severity: 'error', description: '某句 与像素冲突' }
        ] }] }));
        const overrideFile = path.join(dir, 'overrides.json');
        const commit = 'b'.repeat(40);
        fs.writeFileSync(overrideFile, JSON.stringify({
            contract: 'blog-review-overrides-v1', batchDate: '2099-01-02', publicationCommit: commit,
            overrides: [{ path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '某句 与像素冲突', evidence: '来源页 3 行', reviewer: 'r' }]
        }));
        const args = ['--date', '2099-01-02', '--file', overrideFile, '--failure-file', failure, '--json'];

        const matchedReceipt = path.join(dir, 'receipt-match.json');
        fs.writeFileSync(matchedReceipt, JSON.stringify({ publicationCommit: commit }));
        const matched = capture(() => cli.main([...args, '--receipt', matchedReceipt]));
        assert.strictEqual(matched.code, 0);
        assert.match(matched.out.log.join('\n'), /审查凭证绑定通过/);

        const reviewedReceipt = path.join(dir, 'receipt-reviewed.json');
        fs.writeFileSync(reviewedReceipt, JSON.stringify({ reviewedCommit: commit }));
        assert.strictEqual(capture(() => cli.main([...args, '--receipt', reviewedReceipt])).code, 0);

        const mismatchReceipt = path.join(dir, 'receipt-mismatch.json');
        fs.writeFileSync(mismatchReceipt, JSON.stringify({ commit: 'c'.repeat(40) }));
        const mismatch = capture(() => cli.main([...args, '--receipt', mismatchReceipt]));
        assert.strictEqual(mismatch.code, 2);
        assert.match(mismatch.out.error.join('\n'), /不一致/);

        // 凭证没有明确提交字段：给出警告，但继续按 batchDate 校验并通过。
        const unboundReceipt = path.join(dir, 'receipt-unbound.json');
        fs.writeFileSync(unboundReceipt, JSON.stringify({ date: '2099-01-02', baseHead: 'd'.repeat(40) }));
        const unbound = capture(() => cli.main([...args, '--receipt', unboundReceipt]));
        assert.strictEqual(unbound.code, 0);
        assert.match(unbound.out.warn.join('\n'), /没有 publicationCommit\/reviewedCommit\/commit/);

        // 缺提交字段也不能绕过 batchDate：日期不符仍失败。
        fs.writeFileSync(overrideFile, JSON.stringify({
            contract: 'blog-review-overrides-v1', batchDate: '2099-01-03', publicationCommit: commit,
            overrides: [{ path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '某句 与像素冲突', evidence: '来源页 3 行', reviewer: 'r' }]
        }));
        assert.throws(() => cli.main([...args, '--receipt', unboundReceipt]), /batchDate/);
        fs.writeFileSync(overrideFile, JSON.stringify({
            contract: 'blog-review-overrides-v1', batchDate: '2099-01-02', publicationCommit: commit,
            overrides: [{ path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '某句 与像素冲突', evidence: '来源页 3 行', reviewer: 'r' }]
        }));

        const brokenReceipt = path.join(dir, 'receipt-broken.json');
        fs.writeFileSync(brokenReceipt, '{not json');
        const broken = capture(() => cli.main([...args, '--receipt', brokenReceipt]));
        assert.strictEqual(broken.code, 2);
        assert.match(broken.out.error.join('\n'), /无法读取审查凭证/);
        const missing = capture(() => cli.main([...args, '--receipt', path.join(dir, 'missing.json')]));
        assert.strictEqual(missing.code, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('批次级 override 在 CLI 中可达并只解释批次 error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-overrides-batch-'));
    try {
        const failure = path.join(dir, 'blog-review-failure-2099-01-04.json');
        fs.writeFileSync(failure, JSON.stringify({ files: [], issues: [
            { severity: 'error', type: 'preflight', description: '博客仓库有未提交改动' }
        ] }));
        const overrideFile = path.join(dir, 'overrides.json');
        fs.writeFileSync(overrideFile, JSON.stringify({
            contract: 'blog-review-overrides-v1', batchDate: '2099-01-04', publicationCommit: 'b'.repeat(40),
            overrides: [{ path: 'batch', pageSha256: null, claim: '博客仓库有未提交改动', evidence: 'git status 输出', reviewer: 'r' }]
        }));
        const result = capture(() => cli.main(['--date', '2099-01-04', '--file', overrideFile, '--failure-file', failure, '--json']));
        assert.strictEqual(result.code, 0);
        const report = JSON.parse(result.out.log.join('\n'));
        assert.strictEqual(report.matched, 1);
        assert.strictEqual(report.remainingErrors, 0);
        assert.strictEqual(report.wouldPass, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
