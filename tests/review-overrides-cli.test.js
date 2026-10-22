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
