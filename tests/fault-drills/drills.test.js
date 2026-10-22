'use strict';
// 故障演练：把今天真实踩过的坑固化成离线用例，防止同一故障再次让流程停摆。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const errorCodes = require('../../scripts/lib/error-codes');
const policy = require('../../scripts/lib/source-acquisition-policy');
const tableCheck = require('../../scripts/table-check');
const overrides = require('../../scripts/lib/review-overrides');
const pool = require('../../scripts/llm-account-pool');

test('演练：arXiv 429 与 RSS 未生成给出不同建议', () => {
    assert.strictEqual(errorCodes.classify('HTTP 429 arxiv rate limit').id, 'arxiv-rate-limit');
    assert.strictEqual(errorCodes.classify('RSS 公告未生成').id, 'official-oai-rss-stale');
    assert.match(policy.fetchFailureAdvice(new Error('429 Too Many Requests'))[0], /限流/);
});

test('演练：账号池全冷却报最早恢复而不是静默切换', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-pool-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'state.json');
    const keys = ['a', 'b'];
    const now = 1_700_000_000_000;
    let selection = pool.selectApiKey(keys, 'https://opencode.ai/zen/go', stateFile, { nowMs: now });
    pool.markQuotaExhausted(selection, { blockedUntilMs: now + 60_000 }, stateFile, { nowMs: now });
    selection = pool.selectApiKey(keys, 'https://opencode.ai/zen/go', stateFile, { nowMs: now + 1 });
    pool.markQuotaExhausted(selection, { blockedUntilMs: now + 60_000 }, stateFile, { nowMs: now + 1 });
    assert.throws(() => pool.selectApiKey(keys, 'https://opencode.ai/zen/go', stateFile, { nowMs: now + 2 }), /最早恢复时间/);
});

test('演练：表格粘连与审查误报都有离线检查', () => {
    const issues = tableCheck.checkText('| A | B |\n| --- | --- |\n| (x)(x) | 1 |');
    assert.ok(issues.some(issue => issue.code === 'table-glued-duplicate'));
    const entry = { path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: 'x', evidence: 'e', reviewer: 'r' };
    const failure = { files: [{ path: entry.path, sha256: entry.pageSha256, issues: [{ severity: 'error', description: 'x 冲突' }] }] };
    const result = overrides.applyOverrides(failure, [entry]);
    assert.strictEqual(result.matched, 1);
    assert.strictEqual(failure.files[0].issues[0].severity, 'warn');
});
