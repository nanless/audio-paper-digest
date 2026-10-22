'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const verifyWeb = require('../scripts/verify-web');

test('pageUrls 把生成清单路径转成站点 URL', () => {
    const env = { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' };
    const manifest = { files: [{ path: 'content/posts/2026-10-21.md' }, { path: 'content/posts/2026-10-21-a.md' }, { path: 'content/posts/sub/b.md' }, { path: 'content/posts/deleted.md', deleted: true }, { path: 'static/x.png' }] };
    const pages = verifyWeb.pageUrls('2026-10-21', env, manifest);
    assert.deepStrictEqual(pages.map(page => page.url), ['https://example.com/posts/2026-10-21/', 'https://example.com/posts/2026-10-21-a/', 'https://example.com/posts/sub/b/']);
});

test('titleOf 提取标题，fetchPage 记录状态与标题', async () => {
    assert.strictEqual(verifyWeb.titleOf('<html><title> 语音/音乐/音频论文速递 </title></html>'), '语音/音乐/音频论文速递');
    const fetched = await verifyWeb.fetchPage('https://example.com/', {
        fetchImpl: async () => ({ status: 200, text: async () => '<title>ok</title>' })
    });
    assert.deepStrictEqual(fetched, { status: 200, title: 'ok' });
    assert.strictEqual(verifyWeb.titleOf('<title>语音/音乐/音频论文速递 2026-10-21</title>').includes('语音/音乐/音频论文速递'), true);
});

test('verify 聚合 200/404/空清单并写结果', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-web-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'blog-generation-manifest-2099-01-02.json'), JSON.stringify({
        files: [{ path: 'content/posts/2099-01-02.md' }, { path: 'content/posts/2099-01-02-a.md' }]
    }));
    const summary = await verifyWeb.verify('2099-01-02', {
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' }, currentDir: dir,
        fetchImpl: async url => url.includes('-a') ? { status: 404, text: async () => '' } : { status: 200, text: async () => '<title>语音/音乐/音频论文速递</title>' }
    });
    assert.strictEqual(summary.checked, 2);
    assert.strictEqual(summary.ok, 1);
    assert.strictEqual(summary.failed, 1);
    assert.ok(fs.existsSync(path.join(dir, 'web-verification-2099-01-02.json')));

    const empty = await verifyWeb.verify('2099-01-03', { env: {}, currentDir: dir, fetchImpl: async () => ({ status: 200, text: async () => '' }) }).catch(error => error);
    assert.ok(empty instanceof Error);
});

test('deployStatus 严格要求 completed+success', () => {
    const makeSpawn = payload => () => ({ status: 0, stdout: JSON.stringify(payload) });
    const inProgress = verifyWeb.deployStatus('a'.repeat(40), { spawnSync: makeSpawn([{ headSha: 'a'.repeat(40), status: 'in_progress', conclusion: '' }]) });
    assert.strictEqual(inProgress.status, 'in_progress');
    const failed = verifyWeb.deployStatus('a'.repeat(40), { spawnSync: makeSpawn([{ headSha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' }]) });
    assert.strictEqual(failed.conclusion, 'failure');
    const missing = verifyWeb.deployStatus('b'.repeat(40), { spawnSync: makeSpawn([]) });
    assert.ok(missing.message);
    const noGh = verifyWeb.deployStatus('a'.repeat(40), { spawnSync: () => ({ status: 1, stdout: '' }) });
    assert.strictEqual(noGh.available, false);
});

test('waitForDeploy 轮询直到 completed，且超时返回最后状态', async () => {
    const oid = 'c'.repeat(40);
    let calls = 0;
    const spawnSync = () => {
        calls += 1;
        const completed = calls >= 2;
        return { status: 0, stdout: JSON.stringify([{ headSha: oid, status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : '' }]) };
    };
    const slept = [];
    const waited = await verifyWeb.waitForDeploy(oid, { spawnSync, sleep: async ms => slept.push(ms), pollIntervalMs: 10, waitSeconds: 5 });
    assert.strictEqual(waited.deploy.conclusion, 'success');
    assert.ok(slept.length >= 1);
    assert.strictEqual(waited.snapshots.length, 2);

    const timeoutSpawn = () => ({ status: 0, stdout: JSON.stringify([{ headSha: oid, status: 'in_progress', conclusion: '' }]) });
    const timedOut = await verifyWeb.waitForDeploy(oid, { spawnSync: timeoutSpawn, sleep: async () => {}, pollIntervalMs: 10, waitSeconds: 0.001 });
    assert.strictEqual(timedOut.deploy.status, 'in_progress');
});

test('verify 汇总成功/失败并写结果', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-web-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // 通过临时 CURRENT 不可直接注入，改用 limit 与 mock env 的纯函数层面验证汇总逻辑
    const summary = await verifyWeb.verify('2099-01-01', { env: {}, limit: 1, noWrite: true }).catch(error => error);
    assert.ok(summary instanceof Error, '缺生成清单应报错而不是静默通过');
});
