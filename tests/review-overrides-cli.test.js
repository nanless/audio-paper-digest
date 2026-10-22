'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
    assert.strictEqual(report.currentMatchVerdict.status, 'blocked');
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

test('--receipt 只比较提交字段：JSON 纯净、不匹配退出 2、缺字段继续且不认证凭证', () => {
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
        assert.strictEqual(matched.out.log.length, 1, '--json 只能输出一个 JSON 文档');
        const matchedReport = JSON.parse(matched.out.log.join('\n'));
        assert.deepStrictEqual(matchedReport.receiptCheck, {
            provided: true, status: 'field_matched', field: 'publicationCommit',
            commitFieldMatched: true, receiptContractVerified: false
        });
        assert.doesNotMatch(matched.out.log.join('\n'), /审查凭证绑定通过/);

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
        assert.deepStrictEqual(JSON.parse(unbound.out.log.join('\n')).receiptCheck, {
            provided: true, status: 'field_missing', field: null,
            commitFieldMatched: false, receiptContractVerified: false
        });

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

function temporaryCli(t, failure) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-overrides-current-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const date = '2099-01-05';
    const claim = '当前具体的原始错误文字';
    const failureFile = path.join(dir, 'failure.json');
    const overrideFile = path.join(dir, 'overrides.json');
    const entry = { path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim, evidence: '保存的解释依据', reviewer: 'r' };
    fs.writeFileSync(failureFile, typeof failure === 'string' ? failure : JSON.stringify(failure));
    fs.writeFileSync(overrideFile, JSON.stringify({
        contract: 'blog-review-overrides-v1', batchDate: date,
        publicationCommit: 'b'.repeat(40), overrides: [entry]
    }));
    const run = (args = []) => {
        const before = [failureFile, overrideFile].map(file => fs.readFileSync(file));
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/review-overrides-cli.js'),
            '--date', date, '--file', overrideFile, '--failure-file', failureFile, '--json', ...args], { encoding: 'utf8' });
        for (const [index, file] of [failureFile, overrideFile].entries()) {
            assert.deepStrictEqual(fs.readFileSync(file), before[index], 'CLI 不改输入文件');
        }
        assert.strictEqual(result.signal, null);
        return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
    };
    return { run, failureFile, overrideFile, dir, date, claim, entry };
}

test('真实 CLI：旧 overridden 的 legacy 成功不能替代本次匹配或严格退出', t => {
    const fixture = temporaryCli(t, { files: [{ path: 'content/posts/b.md', sha256: 'c'.repeat(64), passed: false,
        issues: [{ severity: 'warn', description: '只有输入旧标记', overridden: true }] }] });
    const { status, report } = fixture.run();
    assert.strictEqual(status, 1);
    assert.strictEqual(report.diagnosticReportVersion, 2);
    assert.strictEqual(report.scope, 'explanation-only');
    assert.strictEqual(report.matched, 0);
    assert.strictEqual(report.matchedIssues, 0);
    assert.deepStrictEqual(report.matches, []);
    assert.deepStrictEqual(report.inputDeclaredOverridden, { issueCount: 1, failedPageCount: 1 });
    assert.deepStrictEqual(report.currentMatchVerdict, {
        status: 'blocked', remainingErrors: 0, unexplainedFailedPages: 1, explainedFailedPages: 0
    });
    assert.strictEqual(report.wouldPass, true, '旧字段保持旧投影，不假称兼容');
    assert.deepStrictEqual(report.legacyProjection, {
        pendingBlockedFiles: 0, overriddenFailedPages: 1, wouldPass: true
    });
});

test('真实 CLI：一页本次解释不能洗掉另一页的旧标记', t => {
    const fixture = temporaryCli(t, { files: [
        { path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false,
            issues: [{ severity: 'error', description: '当前具体的原始错误文字' }] },
        { path: 'content/posts/b.md', sha256: 'c'.repeat(64), passed: false,
            issues: [{ severity: 'warn', description: '输入旧标记', overridden: true }] }
    ] });
    const { status, report } = fixture.run();
    assert.strictEqual(status, 1);
    assert.strictEqual(report.matched, 1);
    assert.strictEqual(report.matchedIssues, 1);
    assert.deepStrictEqual(report.currentMatchVerdict, {
        status: 'blocked', remainingErrors: 0, unexplainedFailedPages: 1, explainedFailedPages: 1
    });
    assert.strictEqual(report.wouldPass, true);
});

test('真实 CLI：同页新 error 的本次解释也不能洗掉未匹配的旧 warn 标记', t => {
    const fixture = temporaryCli(t, { files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false, issues: [
        { severity: 'warn', description: '没有本次解释的旧问题', overridden: true },
        { severity: 'error', description: '当前具体的原始错误文字' }
    ] }] });
    const { status, report } = fixture.run();
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(report.matches, [{ scope: 'page', fileIndex: 0, issueIndex: 1, overrideIndex: 0 }]);
    assert.deepStrictEqual(report.currentMatchVerdict, {
        status: 'blocked', remainingErrors: 0, unexplainedFailedPages: 1, explainedFailedPages: 0
    });
    assert.strictEqual(report.wouldPass, true);
});

test('真实 CLI：旧标记仍为 error 且本次重新精确匹配时可以解释', t => {
    const fixture = temporaryCli(t, { files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false,
        issues: [{ severity: 'error', description: '当前具体的原始错误文字', overridden: true }] }] });
    const { status, report } = fixture.run();
    assert.strictEqual(status, 0);
    assert.strictEqual(report.currentMatchVerdict.status, 'clear');
    assert.strictEqual(report.matchedIssues, 1);
    assert.strictEqual(report.inputDeclaredOverridden.issueCount, 1);
});

test('真实 CLI：failure 显式错日拒绝；同日仅字段比较，缺日保留旧输入兼容', t => {
    const fixture = temporaryCli(t, { date: '2099-01-06', files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false,
        issues: [{ severity: 'error', description: '当前具体的原始错误文字' }] }] });
    const mismatch = fixture.run();
    assert.strictEqual(mismatch.status, 2);
    assert.strictEqual(mismatch.stdout, '');
    assert.match(mismatch.stderr, /failure\.date.*不一致/);
    const same = JSON.parse(fs.readFileSync(fixture.failureFile, 'utf8'));
    same.date = fixture.date;
    fs.writeFileSync(fixture.failureFile, JSON.stringify(same));
    const matched = fixture.run();
    assert.strictEqual(matched.status, 0);
    assert.deepStrictEqual(matched.report.failureDateCheck, { status: 'field_matched', formalScopeVerified: false });
    delete same.date;
    fs.writeFileSync(fixture.failureFile, JSON.stringify(same));
    const legacy = fixture.run();
    assert.strictEqual(legacy.status, 0);
    assert.deepStrictEqual(legacy.report.failureDateCheck, { status: 'not_present', formalScopeVerified: false });
});

test('真实 CLI：v1 同 entry 多 issue 保持合法，原字节 SHA 不按 JSON 重排', t => {
    const raw = '{ "files": [{ "path": "content/posts/a.md", "sha256": "' + 'a'.repeat(64) + '", "passed": false, "issues": ['
        + '{"severity":"error","description":"当前具体的原始错误文字"},'
        + '{"severity":"error","description":"当前具体的原始错误文字"}]}]}\n';
    const fixture = temporaryCli(t, raw);
    const first = fixture.run();
    assert.strictEqual(first.status, 0);
    assert.strictEqual(first.report.matched, 1);
    assert.strictEqual(first.report.matchedIssues, 2);
    assert.deepStrictEqual(first.report.inputDeclaredOverridden, { issueCount: 0, failedPageCount: 0 });
    assert.deepStrictEqual(first.report.currentMatchVerdict, {
        status: 'clear', remainingErrors: 0, unexplainedFailedPages: 0, explainedFailedPages: 1
    });
    assert.strictEqual(first.report.sourceFailureSha256, crypto.createHash('sha256').update(raw).digest('hex'));
    assert.deepStrictEqual(first.report.receiptCheck, {
        provided: false, status: 'not_requested', field: null,
        commitFieldMatched: false, receiptContractVerified: false
    });
    fs.appendFileSync(fixture.failureFile, ' ');
    const second = fixture.run();
    assert.strictEqual(second.status, 0);
    assert.notStrictEqual(first.report.sourceFailureSha256, second.report.sourceFailureSha256);
});

test('真实 CLI：receipt 字段匹配或缺失都只输出单 JSON，冲突仍退出 2', t => {
    const fixture = temporaryCli(t, { files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), passed: false,
        issues: [{ severity: 'error', description: '当前具体的原始错误文字' }] }] });
    const receiptFile = path.join(fixture.dir, 'receipt.json');
    for (const [receipt, expectedStatus, expectedCode] of [
        [{ publicationCommit: 'b'.repeat(40) }, 'field_matched', 0],
        [{ date: fixture.date, baseHead: 'c'.repeat(40) }, 'field_missing', 0],
        [{ commit: 'd'.repeat(40) }, null, 2]
    ]) {
        const raw = JSON.stringify(receipt);
        fs.writeFileSync(receiptFile, raw);
        const result = fixture.run(['--receipt', receiptFile]);
        assert.strictEqual(result.status, expectedCode);
        assert.strictEqual(fs.readFileSync(receiptFile, 'utf8'), raw);
        if (expectedStatus) {
            assert.strictEqual(result.report.receiptCheck.status, expectedStatus);
            assert.strictEqual(result.report.receiptCheck.receiptContractVerified, false);
            assert.doesNotMatch(result.stdout, /审查凭证绑定通过/);
        } else {
            assert.strictEqual(result.stdout, '');
            assert.match(result.stderr, /不一致/);
        }
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
        assert.strictEqual(report.currentMatchVerdict.status, 'clear');
        assert.deepStrictEqual(report.matches, [{ scope: 'batch', fileIndex: null, issueIndex: 0, overrideIndex: 0 }]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
