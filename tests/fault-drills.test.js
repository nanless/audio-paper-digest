'use strict';
// 故障演练：把今天真实踩过的坑固化成离线用例，防止同一故障再次让流程停摆。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const errorCodes = require('../scripts/lib/error-codes');
const policy = require('../scripts/lib/source-acquisition-policy');
const tableCheck = require('../scripts/table-check');
const overrides = require('../scripts/lib/review-overrides');
const pool = require('../scripts/llm-account-pool');

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
    const entry = { path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '这是具体的冲突句', evidence: 'e', reviewer: 'r' };
    const failure = { files: [{ path: entry.path, sha256: entry.pageSha256, issues: [{ severity: 'error', description: '这是具体的冲突句' }] }] };
    const result = overrides.applyOverrides(failure, [entry]);
    assert.strictEqual(result.matched, 1);
    assert.strictEqual(failure.files[0].issues[0].severity, 'warn');
});

test('演练：今天真实出现过的发布失败都有可读分类', () => {
    for (const [text, expected] of [
        ['schema v1 推送失败', 'blog-push-guard'],
        ['Hugo preflight render failed', 'blog-push-guard'],
        ['v3 清单删除状态不一致', 'generation-snapshot-stale'],
        ['发布后视觉规划失败', 'blog-push-guard']
    ]) {
        assert.strictEqual(errorCodes.classify(text).id, expected, text);
    }
});

test('演练：table-check CLI 对粘连草稿返回非零', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-table-'));
    const draft = path.join(dir, 'draft.json');
    fs.writeFileSync(draft, JSON.stringify({ sections: [{ body: '| A | B |\n| --- | --- |\n| (x)(x) | 1 |' }] }));
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try { assert.strictEqual(tableCheck.main(['--draft', draft]), 1); } finally { console.log = original; }
    assert.match(logs.join('\n'), /粘连/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('演练：文档中的 <script> 占位不会被误判成真实命令', () => {
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'drill-docs-'));
    const file = require('node:path').join(dir, 'x.md');
    fs.writeFileSync(file, '运行 npm run <script> 或 npm run exists\n');
    const missing = require('../scripts/docs-consistency').checkDocs([file], { exists: 'x' });
    assert.deepStrictEqual(missing, []);
    fs.rmSync(dir, { recursive: true, force: true });
});
