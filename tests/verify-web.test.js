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

function writeReceipt(dir, date, oid = OID) {
    const manifestFile = path.join(dir, `blog-generation-manifest-${date}.json`);
    const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
    fs.writeFileSync(path.join(dir, `blog-review-receipt-${date}.json`), JSON.stringify({
        generationManifestSha256: sha, publicationCommit: oid, remoteVerifiedOid: oid
    }));
}

function parseLines(lines) {
    return lines.map(line => JSON.parse(line));
}

function assertArtifact(dir, date) {
    const artifactPath = path.join(dir, `web-verification-${date}.json`);
    assert.ok(fs.existsSync(artifactPath), `缺少 artifact: ${artifactPath}`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.strictEqual(artifact.contract, verifyWeb.ARTIFACT_FORMAT);
    assert.strictEqual(verifyWeb.hasVerificationArtifactFormat(artifact), true);
    assert.strictEqual(verifyWeb.hasVerificationArtifactFormat({ ...artifact, schemaVersion: 1 }), false);
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
    assert.strictEqual(verifyWeb.titleMatches('ok | 音频研究门户'), true);
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
    writeReceipt(dir, DATE);
    let calls = 0;
    let verifiedJobs = 0;
    const spawnSync = (command, args = []) => {
        if (args.includes('view')) {
            verifiedJobs += 1;
            return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
        }
        calls += 1;
        const completed = calls >= 3;
        return {
            status: 0,
            stdout: JSON.stringify([{
                headSha: OID,
                status: completed ? 'completed' : 'in_progress',
                conclusion: completed ? 'success' : '',
                workflowName: 'pages build and deployment',
                event: 'push',
                databaseId: 1,
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
        fetchImpl: async url => {
            assert.ok(calls >= 3 && verifiedJobs > 0, '应先等待部署及 jobs 结果，再请求网页');
            return pageFetch({ [`${DATE}`]: { status: 200, title: '语音/音乐/音频论文速递 2099-01-02 汇总' } })(url);
        },
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
    assert.strictEqual(final.deploy.jobVerified, true);
    const summary = parsed.find(item => item.type === 'summary');
    assert.strictEqual(summary.deploy.conclusion, 'success');
    assert.strictEqual(summary.partial, false);
    assert.strictEqual(assertArtifact(dir, DATE).deploy.jobVerified, true);
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
        ['--date', DATE, '--deploy', OID, '--allow-degraded', '--allow-partial'], { ...base, spawnSync: noGh }), 0);
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

test('CLI 部署 jobs 缺失或不可核验时保留 partial，宽松退出不能写 full', async t => {
    const unavailable = [
        { name: 'view 非零', result: { status: 1, stdout: '' } },
        { name: 'view error 即使 status 为零', result: { status: 0, error: new Error('spawn failed'), stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) } },
        { name: 'view 超时', result: { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), stdout: '' } },
        { name: 'view 抛异常', throws: true },
        { name: 'view 无返回值', result: undefined },
        { name: 'view 坏 JSON', result: { status: 0, stdout: '{bad json' } },
        { name: 'run 缺少 runId', noRunId: true }
    ];
    const rejected = [
        { name: 'jobs 空数组', result: { status: 0, stdout: JSON.stringify({ jobs: [] }) } },
        { name: 'jobs 缺失', result: { status: 0, stdout: '{}' } },
        { name: 'jobs 非数组', result: { status: 0, stdout: JSON.stringify({ jobs: {} }) } },
        { name: '只有 build job', result: { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'build', conclusion: 'success' }] }) } },
        { name: 'deploy cancelled', result: { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'cancelled' }] }) } },
        { name: 'deploy skipped', result: { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'skipped' }] }) } }
    ];
    for (const sample of [...unavailable.map(item => ({ ...item, degraded: true })), ...rejected]) {
        for (const flags of [[], ['--allow-partial'], ['--allow-degraded'], ['--allow-degraded', '--allow-partial']]) {
            await t.test(`${sample.name}: ${flags.join(' ') || 'default'}`, async sub => {
                const dir = tempDir(sub);
                writeManifest(dir, DATE, [DATE]);
                writeReceipt(dir, DATE);
                const lines = [];
                let viewCalls = 0;
                const code = await verifyWeb.runVerifyWebCli(['--date', DATE, '--deploy', OID, '--json', ...flags], {
                    currentDir: dir,
                    env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
                    fetchImpl: pageFetch({ [DATE]: { title: `语音/音乐/音频论文速递 ${DATE} 汇总` } }),
                    spawnSync: (_command, args) => {
                        if (args.includes('view')) {
                            viewCalls += 1;
                            if (sample.throws) throw new Error('view threw');
                            return sample.result;
                        }
                        return { status: 0, stdout: JSON.stringify([{
                            headSha: OID, status: 'completed', conclusion: 'success',
                            workflowName: 'pages build and deployment', event: 'push',
                            ...(sample.noRunId ? {} : { databaseId: 1 })
                        }]) };
                    },
                    print: line => lines.push(line),
                    printError: line => assert.fail(`不应丢弃可保存的部分观察：${line}`)
                });
                const artifact = assertArtifact(dir, DATE);
                assert.strictEqual(artifact.partial, true, 'run success 不能替代 jobs 证据');
                assert.strictEqual(artifact.deploy.jobVerified, false);
                const summary = parseLines(lines).find(item => item.type === 'summary');
                assert.strictEqual(summary.partial, true);
                assert.strictEqual(summary.deploy.jobVerified, false);
                const diagnosticExit = sample.degraded && flags.includes('--allow-degraded') && flags.includes('--allow-partial');
                assert.strictEqual(code, diagnosticExit ? 0 : 1);
                assert.strictEqual(viewCalls, sample.noRunId ? 0 : 1);
            });
        }
    }
});

test('部署退出条件必须有明确 jobVerified true，未知只允许诊断降级', () => {
    const run = { available: true, status: 'completed', conclusion: 'success' };
    assert.strictEqual(verifyWeb.deployExitCode(run), 1);
    assert.strictEqual(verifyWeb.deployExitCode({ ...run, jobVerified: false }), 1);
    assert.strictEqual(verifyWeb.deployExitCode({ ...run, jobVerified: true }), 0);
    assert.strictEqual(verifyWeb.deployExitCode(run, { allowDegraded: true }), 0);
    assert.strictEqual(verifyWeb.deployExitCode({ ...run, conclusion: 'failure', jobVerified: false }, { allowDegraded: true }), 1);
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
        // Leave this request unanswered so timeout behavior is independent of host load.
        if (request.url.includes('-slow/')) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><title>语音/音乐/音频论文速递 2099-01-04</title></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/posts`;
    const code = await verifyWeb.runVerifyWebCli([
        '--date', date, '--timeout-ms', '1500', '--json'
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

test('无凭证/空凭证不能假通过，publicationOid 必须是字符串', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [`${DATE}`]);
    const fetchImpl = async () => ({ status: 200, url: `https://example.com/posts/${DATE}/`, text: async () => `<title>语音/音乐/音频论文速递 ${DATE} 汇总</title>` });
    const spawnSync = (command, args = []) => {
        if (args.includes('view')) return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
        return { status: 0, stdout: JSON.stringify([{ headSha: OID, status: 'completed', conclusion: 'success', workflowName: 'pages', event: 'push', databaseId: 1 }]) };
    };
    const base = { currentDir: dir, env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' }, fetchImpl, spawnSync, print: () => {}, printError: () => {} };
    const noReceipt = await verifyWeb.runVerifyWebCli(['--date', DATE, '--deploy', OID], base);
    assert.strictEqual(noReceipt, 1, '无审查凭证不能通过');
    const noReceiptArtifact = assertArtifact(dir, DATE);
    assert.strictEqual(noReceiptArtifact.partial, true);
    assert.strictEqual(noReceiptArtifact.publicationOid, OID);
    assert.strictEqual(typeof noReceiptArtifact.publicationOid, 'string');

    fs.writeFileSync(path.join(dir, `blog-review-receipt-${DATE}.json`), JSON.stringify({}));
    const emptyReceipt = await verifyWeb.runVerifyWebCli(['--date', DATE, '--deploy', OID], base);
    assert.strictEqual(emptyReceipt, 2, '空凭证必须 fail-closed');
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

test('SSRF/路径穿越拒绝与标题大括号/转义污染拦截', async () => {
    assert.throws(
        () => verifyWeb.assertSafeVerifyUrl('http://169.254.169.254/latest/meta-data/'),
        /仅允许 HTTPS|私网|保留/
    );
    assert.throws(
        () => verifyWeb.assertSafeVerifyUrl('https://127.0.0.1/posts/2099-01-01/'),
        /私网|保留|公网/
    );
    assert.throws(
        () => verifyWeb.pageUrls('2099-01-02', { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' }, {
            files: [{ path: 'content/posts/../../etc/passwd.md' }]
        }),
        /非法|越界|路径/
    );
    assert.strictEqual(verifyWeb.titleHasCorruptionArtifacts('Sol^{{{{3}}}}: Speech Model'), true);
    assert.strictEqual(verifyWeb.titleHasCorruptionArtifacts('Speech \\(x\\) Model'), true);
    assert.strictEqual(verifyWeb.titleHasCorruptionArtifacts('Speech \\"Quoted\\" Title'), true);
    assert.strictEqual(verifyWeb.titleHasCorruptionArtifacts('Sol³: Speech Model — 音频论文速递'), false);
    assert.strictEqual(
        verifyWeb.titleMatches('Sol^{{{{3}}}} | 语音/音乐/音频论文速递'),
        false
    );
});

test('缺清单时先于 --wait 快速失败；会议专题汇总标题放行；partialFailed 非 JSON 模式下输出诊断', async t => {
    const dir = tempDir(t);
    let spawnCalls = 0;
    const errors = [];
    const code = await verifyWeb.runVerifyWebCli(
        ['--date', DATE, '--deploy', OID, '--wait', '--wait-seconds', '5'],
        {
            currentDir: dir,
            env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
            spawnSync: () => { spawnCalls += 1; return { status: 0, stdout: '[]' }; },
            print: () => {},
            printError: line => errors.push(line)
        }
    );
    assert.strictEqual(code, 2);
    assert.strictEqual(spawnCalls, 0, '缺生成清单不应先等待部署轮询');
    assert.match(errors.join('\n'), /找不到生成清单/);

    writeManifest(dir, DATE, [`${DATE}`]);
    const topicRes = await verifyWeb.verify(DATE, {
        currentDir: dir,
        noWrite: true,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: async () => ({
            status: 200,
            url: `https://example.com/posts/${DATE}/`,
            text: async () => '<title>ICASSP 2026 语音专题论文深度解读 | 语音/音乐/音频论文速递</title>'
        })
    });
    assert.strictEqual(topicRes.ok, 1);
    assert.strictEqual(topicRes.results[0].titleOk, true);

    const out = [];
    const partialCode = await verifyWeb.runVerifyWebCli(['--date', DATE], {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: async () => ({ status: 200, url: `https://example.com/posts/${DATE}/`, text: async () => `<title>语音/音乐/音频论文速递 ${DATE}</title>` }),
        print: line => out.push(line),
        printError: () => {}
    });
    assert.strictEqual(partialCode, 1);
    assert.match(out.join('\n'), /不完整|partial|--deploy/);
});

test('F3 安全与稳定性：readEnv 只读防污染、gh 环境白名单与仓库校验、DNS IP 绑定防 SSRF、OID 小写、旧站点标题剥离与瞬时退避', async t => {
    const dir = tempDir(t);

    // 1) readEnv uses readEnvFileReadOnly: fails closed on symlink and does NOT pollute process.env
    const realEnv = path.join(dir, 'real.env');
    fs.writeFileSync(realEnv, 'PAPER_ANALYZER_API_KEY=sk-must-not-pollute-env\nPAPER_DIGEST_BLOG_URL=https://blog.example.com/posts\n');
    const symEnv = path.join(dir, 'sym.env');
    fs.symlinkSync(realEnv, symEnv);
    assert.throws(() => verifyWeb.readEnv(symEnv), /符号链接|普通文件/);
    const beforeKey = process.env.PAPER_ANALYZER_API_KEY;
    const parsedEnv = verifyWeb.readEnv(realEnv);
    assert.strictEqual(parsedEnv.PAPER_DIGEST_BLOG_URL, 'https://blog.example.com/posts');
    assert.strictEqual(process.env.PAPER_ANALYZER_API_KEY, beforeKey);

    // 2) gh child env strips PAPER_* / PD_* and preserves PATH / HOME / GH_TOKEN / HTTPS_PROXY; invalid repo rejected
    let capturedGhOpts = null;
    const prevPaperKey = process.env.PAPER_ANALYZER_API_KEY;
    const prevPdFlag = process.env.PD_SECRET_TEST;
    process.env.PAPER_ANALYZER_API_KEY = 'sk-secret-leak-check';
    process.env.PD_SECRET_TEST = 'pd-secret-leak-check';
    try {
        verifyWeb.deployStatus(OID, {
            repository: 'nanless/audio-research-portal',
            env: {
                GH_TOKEN: 'ghp_allowed_token',
                HTTPS_PROXY: 'http://127.0.0.1:7897',
                PAPER_ANALYZER_API_KEY: 'sk-also-blocked',
                PD_INTERNAL_SECRET: 'pd-also-blocked'
            },
            spawnSync: (_cmd, _args, opts) => {
                capturedGhOpts = opts;
                return { status: 0, stdout: '[]' };
            }
        });
    } finally {
        if (prevPaperKey === undefined) delete process.env.PAPER_ANALYZER_API_KEY;
        else process.env.PAPER_ANALYZER_API_KEY = prevPaperKey;
        if (prevPdFlag === undefined) delete process.env.PD_SECRET_TEST;
        else process.env.PD_SECRET_TEST = prevPdFlag;
    }
    assert.ok(capturedGhOpts && capturedGhOpts.env);
    assert.strictEqual(capturedGhOpts.env.GH_TOKEN, 'ghp_allowed_token');
    assert.strictEqual(capturedGhOpts.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
    assert.strictEqual(capturedGhOpts.env.PAPER_ANALYZER_API_KEY, undefined);
    assert.strictEqual(capturedGhOpts.env.PD_SECRET_TEST, undefined);
    assert.strictEqual(capturedGhOpts.env.PD_INTERNAL_SECRET, undefined);
    assert.throws(() => verifyWeb.deployStatus(OID, { repository: 'owner/repo/../../evil', spawnSync: () => { throw new Error('must not run'); } }), /非法 GitHub 仓库/);
    assert.throws(() => verifyWeb.verifyWorkflowSource(OID, { repository: '--flag/repo', spawnSync: () => { throw new Error('must not run'); } }), /非法 GitHub 仓库/);

    // 3) parseVerifyArgs normalizes --deploy OID to lowercase
    assert.strictEqual(verifyWeb.parseVerifyArgs(['--date', DATE, '--deploy', 'A'.repeat(40)]).deploy, 'a'.repeat(40));

    // 4) Legacy site title marker alone (with | or -) fails single-paper titleOk check
    writeManifest(dir, DATE, [`${DATE}-single`]);
    const legacyOnly = await verifyWeb.verify(DATE, {
        currentDir: dir,
        noWrite: true,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts' },
        fetchImpl: async () => ({ status: 200, text: async () => '<title> | 语音/音乐/音频论文速递 - </title>' })
    });
    assert.strictEqual(legacyOnly.results[0].titleOk, false);
    assert.strictEqual(legacyOnly.ok, 0);

    // 5) waitForDeploy retries transient !deploy.available errors, breaks immediately on permanent missing gh / auth error
    let transientAttempts = 0;
    const transientWait = await verifyWeb.waitForDeploy(OID, {
        spawnSync: (_cmd, args) => {
            if (args.includes('view')) {
                return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
            }
            transientAttempts += 1;
            if (transientAttempts === 1) {
                return { status: 1, stdout: '', stderr: 'error connecting to api.github.com: i/o timeout' };
            }
            return {
                status: 0,
                stdout: JSON.stringify([{ headSha: OID, status: 'completed', conclusion: 'success', workflowName: 'pages', event: 'push', databaseId: 9 }])
            };
        },
        sleep: async () => {},
        pollIntervalMs: 1,
        waitSeconds: 5
    });
    assert.strictEqual(transientAttempts, 2);
    assert.strictEqual(transientWait.deploy.conclusion, 'success');

    let permanentAttempts = 0;
    const permanentWait = await verifyWeb.waitForDeploy(OID, {
        spawnSync: () => {
            permanentAttempts += 1;
            return { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. Run gh auth login' };
        },
        sleep: async () => {},
        pollIntervalMs: 1,
        waitSeconds: 5
    });
    assert.strictEqual(permanentAttempts, 1);
    assert.strictEqual(permanentWait.deploy.available, false);

    // 6) fetchPage DNS validation + IP pinning on every hop blocks private IP & DNS-rebinding redirect
    const EventEmitter = require('node:events');
    let reqCalls = 0;
    await assert.rejects(
        verifyWeb.fetchPage('https://rebind.example.com/posts/', {
            env: {},
            lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
            httpsRequestImpl: () => { reqCalls += 1; throw new Error('must not dial private IP'); }
        }),
        /非公网 IP/
    );
    assert.strictEqual(reqCalls, 0);

    // Redirect hop 1 (public IP) -> hop 2 (resolves to 127.0.0.1) rejected before dialing hop 2
    let pinnedReqOpts = null;
    const fakeHttps = (reqOpts, cb) => {
        reqCalls += 1;
        pinnedReqOpts = reqOpts;
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = () => { req.destroyed = true; };
        req.end = () => {
            const res = new EventEmitter();
            res.statusCode = 302;
            res.headers = { location: 'https://internal.example.com/secret' };
            res.resume = () => {};
            res.destroy = () => {};
            cb(res);
        };
        return req;
    };
    await assert.rejects(
        verifyWeb.fetchPage('https://public.example.com/posts/', {
            env: {},
            lookupImpl: async host => (
                host === 'public.example.com'
                    ? [{ address: '93.184.216.34', family: 4 }]
                    : [{ address: '127.0.0.1', family: 4 }]
            ),
            httpsRequestImpl: fakeHttps
        }),
        /非公网 IP/
    );
    assert.strictEqual(reqCalls, 1);
    assert.strictEqual(pinnedReqOpts.servername, 'public.example.com');
    await new Promise((resolve, reject) => {
        pinnedReqOpts.lookup('public.example.com', { all: false }, (err, addr, fam) => {
            if (err) return reject(err);
            assert.strictEqual(addr, '93.184.216.34');
            assert.strictEqual(fam, 4);
            resolve();
        });
    });
});

test('verify() 读取 .env 后将 env 代理配置透传给 fetchPage()', async t => {
    const EventEmitter = require('node:events');
    const doctor = require('../scripts/doctor.js');
    const dir = tempDir(t);
    writeManifest(dir, DATE, [DATE]);
    const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
    const savedEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
    for (const key of proxyKeys) delete process.env[key];
    t.after(() => {
        for (const key of proxyKeys) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });
    t.mock.method(doctor, 'readEnvFileReadOnly', () => ({
        exists: true,
        entries: {
            PAPER_DIGEST_BLOG_URL: 'https://public.example.com/posts',
            HTTPS_PROXY: 'http://127.0.0.1:18080'
        }
    }));
    const proxyCalls = [];
    const summary = await verifyWeb.verify(DATE, {
        currentDir: dir,
        noWrite: true,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        createProxyAgentImpl: (proxyUrl, address, port, hostname) => {
            proxyCalls.push({ proxyUrl, address, port, hostname });
            return { destroy() {} };
        },
        httpsRequestImpl: (_reqOpts, cb) => {
            const req = new EventEmitter();
            req.destroyed = false;
            req.destroy = () => { req.destroyed = true; };
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                res.resume = () => {};
                res.destroy = () => {};
                cb(res);
                res.emit('data', Buffer.from(`<html><title>${DATE} | 音频研究门户</title></html>`));
                res.emit('end');
            };
            return req;
        }
    });
    assert.strictEqual(summary.ok, 1);
    assert.strictEqual(summary.failed, 0);
    assert.strictEqual(proxyCalls.length, 1);
    assert.deepStrictEqual(proxyCalls[0], {
        proxyUrl: 'http://127.0.0.1:18080',
        address: '93.184.216.34',
        port: 443,
        hostname: 'public.example.com'
    });
});
