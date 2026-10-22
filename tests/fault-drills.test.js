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

// 以下演练走真实 CLI 入口（main 函数），仍全部离线、只用临时目录。
function captureConsole(fn) {
    const lines = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => lines.push(args.map(arg => String(arg)).join(' '));
    console.error = (...args) => lines.push(args.map(arg => String(arg)).join(' '));
    try {
        return { result: fn(), output: lines.join('\n') };
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

test('演练：config-check CLI 对临时非法 .env 返回 1 且不泄漏 key 值', () => {
    const configCheck = require('../scripts/config-check');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-config-'));
    const envFile = path.join(dir, '.env');
    const secret = 'sk-drill-secret-value-123';
    try {
        fs.writeFileSync(envFile, [
            `PAPER_ANALYZER_API_KEY=${secret}`,
            'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor',
            'PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1',
            'PD_API_READER_CONCURRENCY=999',
            ''
        ].join('\n'), { mode: 0o600 });

        const human = captureConsole(() => configCheck.main(['--env', envFile]));
        assert.strictEqual(human.result, 1, human.output);
        assert.match(human.output, /PD_API_READER_CONCURRENCY/);
        assert.ok(!human.output.includes(secret), '人话输出不得泄漏 key 值');

        const json = captureConsole(() => configCheck.main(['--env', envFile, '--json']));
        assert.strictEqual(json.result, 1, json.output);
        const parsed = JSON.parse(json.output);
        assert.ok(parsed.counts.fail > 0);
        assert.ok(!json.output.includes(secret), 'JSON 输出不得泄漏 key 值');

        // 缺必填项同样判 fail。
        fs.writeFileSync(envFile, [
            'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor',
            'PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1',
            ''
        ].join('\n'), { mode: 0o600 });
        const missing = captureConsole(() => configCheck.main(['--env', envFile, '--json']));
        assert.strictEqual(missing.result, 1, missing.output);
        assert.match(missing.output, /PAPER_ANALYZER_API_KEY/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('演练：review-overrides-cli 区分 pending、error 全覆盖与批次 override', () => {
    const cli = require('../scripts/review-overrides-cli');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-overrides-'));
    const date = '2026-10-22';
    const claim = '这是具体的冲突句';
    const payload = extra => ({
        contract: 'blog-review-overrides-v1',
        batchDate: date,
        publicationCommit: 'a'.repeat(40),
        overrides: [],
        ...extra
    });
    const writeJson = (name, value) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
        return file;
    };
    const run = (overrideFile, failureFile) => captureConsole(
        () => cli.main(['--date', date, '--file', overrideFile, '--failure-file', failureFile])
    );
    try {
        // 1) pending/未通过页没有 error 可解释：override 不能放行。
        const pendingFailure = writeJson('pending-failure.json', {
            files: [{ path: 'content/posts/pending.md', sha256: 'b'.repeat(64), passed: false, issues: [] }]
        });
        const pendingOverrides = writeJson('pending-overrides.json', payload({
            overrides: [{
                path: 'content/posts/other.md',
                pageSha256: 'c'.repeat(64),
                claim,
                evidence: '原文引用',
                reviewer: 'tester'
            }]
        }));
        assert.strictEqual(run(pendingOverrides, pendingFailure).result, 1);

        // 2) 全部 error 都被严格记录覆盖：门禁返回 0。
        const errorFailure = writeJson('error-failure.json', {
            files: [{
                path: 'content/posts/a.md',
                sha256: 'd'.repeat(64),
                passed: false,
                issues: [{ severity: 'error', description: claim }]
            }]
        });
        const errorOverrides = writeJson('error-overrides.json', payload({
            overrides: [{
                path: 'content/posts/a.md',
                pageSha256: 'd'.repeat(64),
                claim,
                evidence: '原文引用',
                reviewer: 'tester'
            }]
        }));
        assert.strictEqual(run(errorOverrides, errorFailure).result, 0);

        // 3) 批次级 override 解释顶层 error：同样返回 0。
        const batchFailure = writeJson('batch-failure.json', {
            files: [],
            issues: [{ severity: 'error', description: claim }]
        });
        const batchOverrides = writeJson('batch-overrides.json', payload({
            overrides: [{
                path: 'batch',
                pageSha256: null,
                claim,
                evidence: '原文引用',
                reviewer: 'tester'
            }]
        }));
        assert.strictEqual(run(batchOverrides, batchFailure).result, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('演练：verify-web 用注入的 gh 输出判定部署失败', async () => {
    const verifyWeb = require('../scripts/verify-web');
    const oid = 'e'.repeat(40);

    const unavailable = verifyWeb.deployStatus(oid, {
        spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh: command not found', error: null })
    });
    assert.strictEqual(unavailable.available, false);
    assert.match(unavailable.message, /gh CLI 不可用/);

    const failedRun = {
        headSha: oid,
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/example/repo/actions/runs/1'
    };
    const failed = verifyWeb.deployStatus(oid, {
        spawnSync: () => ({ status: 0, stdout: JSON.stringify([failedRun]), stderr: '', error: null })
    });
    assert.strictEqual(failed.available, true);
    assert.strictEqual(failed.status, 'completed');
    assert.strictEqual(failed.conclusion, 'failure');
    assert.strictEqual(failed.url, failedRun.url);
    // 只核对部署身份仍然落在该提交上；实现可能用 oid 或 headSha 承载。
    assert.ok([failed.oid, failed.headSha].includes(oid), '部署记录应绑定目标提交');

    const unknown = verifyWeb.deployStatus(oid, {
        spawnSync: () => ({ status: 0, stdout: '[]', stderr: '', error: null })
    });
    assert.strictEqual(unknown.available, true);
    assert.match(unknown.message, /未找到/);

    // 轮询：进行中 → completed/failure，最终快照是部署失败的判定依据。
    const snapshots = [
        { headSha: oid, status: 'in_progress', conclusion: null, url: 'u1' },
        { headSha: oid, status: 'completed', conclusion: 'failure', url: 'u1' }
    ];
    let call = 0;
    const waited = await verifyWeb.waitForDeploy(oid, {
        spawnSync: () => ({
            status: 0,
            stdout: JSON.stringify([snapshots[Math.min(call++, snapshots.length - 1)]]),
            stderr: '',
            error: null
        }),
        sleep: () => Promise.resolve(),
        pollIntervalMs: 1,
        waitSeconds: 5
    });
    assert.strictEqual(waited.deploy.conclusion, 'failure');
    assert.ok(waited.snapshots.length >= 2);
});

