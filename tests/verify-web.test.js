'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const verifyWeb = require('../scripts/verify-web');

const DATE = '2099-01-02';
const OID = 'a'.repeat(40);

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-web-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeManifest(dir, date, slugs) {
    fs.writeFileSync(path.join(dir, `blog-generation-manifest-${date}.json`), JSON.stringify({
        date,
        files: slugs.map(slug => ({ path: `content/posts/${slug}.md` }))
    }));
}

function pageFetch(responses) {
    return async url => {
        const key = Object.keys(responses).find(name => url.endsWith(`/${name}/`));
        const response = key ? responses[key] : { status: 404 };
        if (response instanceof Error) throw response;
        return {
            status: response.status ?? 200,
            text: async () => response.title ? `<html><title>${response.title}</title></html>` : ''
        };
    };
}

function parseLines(lines) {
    return lines.map(line => JSON.parse(line));
}

function assertArtifact(dir, date) {
    const artifactPath = path.join(dir, `web-verification-${date}.json`);
    assert.ok(fs.existsSync(artifactPath), `缺少 artifact: ${artifactPath}`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.strictEqual(artifact.schemaVersion, verifyWeb.ARTIFACT_VERSION);
    assert.ok(Number.isFinite(Date.parse(artifact.createdAt)), 'createdAt 必须是 ISO 时间');
    assert.strictEqual(artifact.date, date);
    assert.strictEqual(typeof artifact.partial, 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(artifact, 'deploy'));
    assert.ok(Array.isArray(artifact.results));
    if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(artifactPath).mode & 0o777, 0o600, 'artifact 必须是 0600');
    }
    const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], '原子写不得遗留临时文件');
    return artifact;
}

test('pageUrls 把生成清单路径转成站点 URL', () => {
    const env = { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' };
    const manifest = {
        files: [
            { path: 'content/posts/2026-10-21.md' },
            { path: 'content/posts/2026-10-21-a.md' },
            { path: 'content/posts/sub/b.md' },
            { path: 'content/posts/deleted.md', deleted: true },
            { path: 'static/x.png' }
        ]
    };
    const pages = verifyWeb.pageUrls('2026-10-21', env, manifest);
    assert.deepStrictEqual(pages.map(page => page.url), [
        'https://example.com/posts/2026-10-21/',
        'https://example.com/posts/2026-10-21-a/',
        'https://example.com/posts/sub/b/'
    ]);
});

test('titleOf 解码实体，fetchPage 记录状态与标题', async () => {
    assert.strictEqual(
        verifyWeb.titleOf('<html><title> 语音/音乐/音频论文速递 &amp; X </title></html>'),
        '语音/音乐/音频论文速递 & X');
    const fetched = await verifyWeb.fetchPage('https://example.com/', {
        fetchImpl: async () => ({ status: 200, text: async () => '<title>ok</title>' })
    });
    assert.deepStrictEqual(fetched, { status: 200, title: 'ok', finalUrl: null });
    assert.strictEqual(verifyWeb.titleMatches('ok | 语音/音乐/音频论文速递'), true);
    assert.strictEqual(verifyWeb.titleMatches('别的标题'), false);
});

test('runVerifyWebCli: 200/404/标题不符，写原子 artifact 并返回 1', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`, `${DATE}-a`, `${DATE}-b`]);
    const lines = [];
    const errors = [];
    const code = await verifyWeb.runVerifyWebCli([
        '--date', DATE, '--timeout-ms', '500'
    ], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: pageFetch({
            [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递 2099-01-02 汇总' },
            [`${DATE}-a`]: { status: 404 },
            [`${DATE}-b`]: { status: 200, title: '完全不同的标题' }
        }),
        print: line => lines.push(line),
        printError: line => errors.push(line)
    });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(errors, []);
    const artifact = assertArtifact(dir, DATE);
    assert.strictEqual(artifact.expected, 3);
    assert.strictEqual(artifact.checked, 3);
    assert.strictEqual(artifact.ok, 1);
    assert.strictEqual(artifact.failed, 2);
    assert.strictEqual(artifact.partial, true);
    assert.strictEqual(artifact.deploy, null);
    assert.match(lines.join('\n'), /合计：1\/3 通过/);
});

test('runVerifyWebCli --json 每行可解析且没有多余日志', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`, `${DATE}-a`]);
    const lines = [];
    const code = await verifyWeb.runVerifyWebCli(['--date', DATE, '--json', '--allow-partial'], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: pageFetch({
            [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递 2099-01-02 汇总' },
            [`${DATE}-a`]: { status: 200, title: '语音/音乐/音频论文速递 某篇论文标题' }
        }),
        print: line => lines.push(line),
        printError: line => { throw new Error(`不应有错误输出: ${line}`); }
    });
    assert.strictEqual(code, 0);
    assert.ok(lines.length >= 1);
    const parsed = parseLines(lines);
    assert.strictEqual(parsed[0].type, 'summary');
    assert.strictEqual(parsed[0].ok, 2);
    assert.strictEqual(parsed[0].partial, true);
});

test('--deploy --wait: in_progress→completed success，--json 每行可解析', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`]);
    let calls = 0;
    const spawnSync = () => {
        calls += 1;
        const completed = calls >= 3;
        return {
            status: 0,
            stdout: JSON.stringify([{
                headSha: OID,
                status: completed ? 'completed' : 'in_progress',
                conclusion: completed ? 'success' : '',
                url: 'https://github.com/nanless/blog/actions/runs/1'
            }])
        };
    };
    const lines = [];
    const slept = [];
    const code = await verifyWeb.runVerifyWebCli([
        '--date', DATE, '--deploy', OID, '--wait', '--wait-seconds', '5',
        '--poll-interval-ms', '1', '--json'
    ], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: pageFetch({ [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递 2099-01-02 汇总' } }),
        spawnSync,
        sleep: async ms => { slept.push(ms); },
        print: line => lines.push(line),
        printError: line => { throw new Error(`不应有错误输出: ${line}`); }
    });
    assert.strictEqual(code, 0);
    assert.ok(slept.length >= 1);
    const parsed = parseLines(lines);
    const deployLines = parsed.filter(item => item.type === 'deploy');
    assert.ok(deployLines.some(item => item.status === 'in_progress'));
    const final = parsed.find(item => item.type === 'deploy-final');
    assert.strictEqual(final.deploy.status, 'completed');
    assert.strictEqual(final.deploy.conclusion, 'success');
    const summary = parsed.find(item => item.type === 'summary');
    assert.strictEqual(summary.deploy.conclusion, 'success');
    assert.strictEqual(summary.partial, false);
    assertArtifact(dir, DATE);
});

test('部署 completed+failure 返回非零；无 gh 默认非零，--allow-degraded 放行', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`]);
    const fetchImpl = pageFetch({ [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递 2099-01-02 汇总' } });
    const base = {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl,
        print: () => {},
        printError: () => {}
    };
    const failedSpawn = () => ({
        status: 0,
        stdout: JSON.stringify([{ headSha: OID, status: 'completed', conclusion: 'failure' }])
    });
    assert.strictEqual(await verifyWeb.runVerifyWebCli(
        ['--date', DATE, '--deploy', OID], { ...base, spawnSync: failedSpawn }), 1);

    const noGh = () => ({ status: 1, stdout: '', stderr: 'gh: not found' });
    assert.strictEqual(await verifyWeb.runVerifyWebCli(
        ['--date', DATE, '--deploy', OID], { ...base, spawnSync: noGh }), 1);
    assert.strictEqual(await verifyWeb.runVerifyWebCli(
        ['--date', DATE, '--deploy', OID, '--allow-degraded'], { ...base, spawnSync: noGh }), 0);
    const degraded = assertArtifact(dir, DATE);
    assert.strictEqual(degraded.deploy.available, false);
    assert.strictEqual(degraded.partial, true);
});

test('artifact 目标为 symlink 时拒绝写入并返回 2', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`]);
    const target = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(target, '{"original":true}');
    const artifact = path.join(dir, `web-verification-${DATE}.json`);
    fs.symlinkSync(target, artifact);
    const errors = [];
    const code = await verifyWeb.runVerifyWebCli(['--date', DATE], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: pageFetch({ [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递' } }),
        print: () => {},
        printError: line => errors.push(line)
    });
    assert.strictEqual(code, 2);
    assert.match(errors.join('\n'), /符号链接/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"original":true}');
    assert.strictEqual(fs.lstatSync(artifact).isSymbolicLink(), true);
});

test('deployStatus/parseDeployRuns 兼容 gh 与公开 API 形状，无 gh 明确降级', () => {
    const ghSpawn = () => ({
        status: 0,
        stdout: JSON.stringify([{ headSha: OID, status: 'queued', conclusion: '', url: 'u', workflowName: 'pages' }])
    });
    const queued = verifyWeb.deployStatus(OID, { spawnSync: ghSpawn });
    assert.strictEqual(queued.available, true);
    assert.strictEqual(queued.status, 'queued');

    const api = verifyWeb.parseDeployRuns([{
        head_sha: OID,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/nanless/blog/actions/runs/2',
        name: 'pages build and deployment'
    }], OID);
    assert.strictEqual(api.available, true);
    assert.strictEqual(api.url, 'https://github.com/nanless/blog/actions/runs/2');
    assert.strictEqual(api.terminal, true);

    const missing = verifyWeb.parseDeployRuns([], OID);
    assert.ok(missing.message);
    const noGh = verifyWeb.deployStatus(OID, { spawnSync: () => ({ status: 1, stdout: '' }) });
    assert.strictEqual(noGh.available, false);
    assert.strictEqual(noGh.degraded, true);
});

test('waitForDeploy 轮询直到 completed，超时返回最后状态', async () => {
    const oid = 'c'.repeat(40);
    let calls = 0;
    const spawnSync = () => {
        calls += 1;
        const completed = calls >= 2;
        return {
            status: 0,
            stdout: JSON.stringify([{
                headSha: oid,
                status: completed ? 'completed' : 'in_progress',
                conclusion: completed ? 'success' : ''
            }])
        };
    };
    const slept = [];
    const waited = await verifyWeb.waitForDeploy(oid, {
        spawnSync, sleep: async ms => slept.push(ms), pollIntervalMs: 10, waitSeconds: 5
    });
    assert.strictEqual(waited.deploy.conclusion, 'success');
    assert.ok(slept.length >= 1);
    assert.strictEqual(waited.snapshots.length, 2);

    const timeoutSpawn = () => ({
        status: 0,
        stdout: JSON.stringify([{ headSha: oid, status: 'in_progress', conclusion: '' }])
    });
    const timedOut = await verifyWeb.waitForDeploy(oid, {
        spawnSync: timeoutSpawn, sleep: async () => {}, pollIntervalMs: 10, waitSeconds: 0.001
    });
    assert.strictEqual(timedOut.deploy.status, 'in_progress');
});

test('verify 缺生成清单时报错而不是静默通过', async t => {
    const dir = tempDir(t);
    await assert.rejects(
        verifyWeb.verify('2099-01-01', { env: {}, currentDir: dir, noWrite: true }),
        /找不到生成清单/
    );
});

test('mock HTTP 服务器：200/404/标题不符/超时（离线 localhost）', async t => {
    const dir = tempDir(t);
    const date = '2099-01-04';
    writeManifest(dir, date, [`${date}`, `${date}-a`, `${date}-b`, `${date}-slow`]);
    const server = http.createServer((request, response) => {
        if (request.url.includes('-a/')) {
            response.writeHead(404, { 'content-type': 'text/html' });
            response.end('<title>not found</title>');
            return;
        }
        if (request.url.includes('-b/')) {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<html><title>完全不同的标题</title></html>');
            return;
        }
        if (request.url.includes('-slow/')) {
            setTimeout(() => {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end('<html><title>语音/音乐/音频论文速递</title></html>');
            }, 400);
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><title>语音/音乐/音频论文速递 2099-01-04</title></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/posts`;
    const code = await verifyWeb.runVerifyWebCli([
        '--date', date, '--timeout-ms', '100', '--json'
    ], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: base },
        print: () => {},
        printError: () => {}
    });
    assert.strictEqual(code, 1);
    const artifact = assertArtifact(dir, date);
    const byPath = Object.fromEntries(artifact.results.map(item => [item.file, item]));
    assert.strictEqual(byPath[`content/posts/${date}.md`].ok, true);
    assert.strictEqual(byPath[`content/posts/${date}-a.md`].status, 404);
    assert.strictEqual(byPath[`content/posts/${date}-b.md`].titleOk, false);
    const slow = byPath[`content/posts/${date}-slow.md`];
    assert.strictEqual(slow.status, null);
    assert.ok(slow.error);
});

test('重定向到其它页/站点标题单页/抽样/无部署均不能假通过', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`, `${DATE}-a`]);
    const redirectFetch = async url => ({
        status: 200,
        url: 'https://example.com/posts/',
        text: async () => '<title>语音/音乐/音频论文速递 2099-01-02 汇总</title>'
    });
    const lines = [];
    const code = await verifyWeb.runVerifyWebCli(['--date', DATE, '--json', '--allow-partial'], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: redirectFetch,
        print: line => lines.push(line),
        printError: () => {}
    });
    assert.strictEqual(code, 1, '重定向页面不得通过');
    const summary = parseLines(lines).find(item => item.type === 'summary');
    assert.strictEqual(summary.results.every(item => item.redirectOk === false), true);

    const genericFetch = async () => ({ status: 200, text: async () => '<title>语音/音乐/音频论文速递</title>' });
    const limited = await verifyWeb.runVerifyWebCli(['--date', DATE, '--limit', '1', '--json'], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: genericFetch,
        print: () => {},
        printError: () => {}
    });
    assert.strictEqual(limited, 1, '抽样/无部署不能返回 0');
    const artifact = assertArtifact(dir, DATE);
    assert.strictEqual(artifact.partial, true);
    assert.strictEqual(artifact.results[0].titleOk, false, '只有站点名的单页标题不算通过');
});
