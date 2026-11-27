'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const utils = require('../scripts/utils');
const fetchPapers = require('../scripts/fetch-papers');
const pool = require('../scripts/llm-account-pool');
const arxivMeta = require('../scripts/lib/arxiv-metadata-source');
const oaiSource = require('../scripts/lib/daily-arxiv-oai-source');
const originGate = require('../scripts/lib/arxiv-origin-gate');
const fresh = require('../scripts/lib/fresh-analysis-context');
const Config = require('../scripts/config');
const envSchema = require('../scripts/lib/env-schema');
const codec = require('../scripts/lib/protocol-codec');
const { evidenceHeaderForBoundary, coverageHeaderForBoundary } = require('../scripts/lib/daily-fetch-format');

const ROOT = path.resolve(__dirname, '..');
const ENDPOINT = 'https://opencode.ai/zen/go/v1';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function withHttpServer(t, handler, run) {
    const server = http.createServer(handler);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
            t.skip(`当前环境不允许监听本地端口: ${err.code}`);
            return;
        }
        throw err;
    }
    try {
        const { port } = server.address();
        await run(`http://127.0.0.1:${port}`);
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

describe('Bug 1 & Bug 5: SSE 解析与瞬时传输/网关错误分类', () => {
    it('parseSseResponse 捕获仅推理事件后提前 EOF，并安全跳过 data: null / 非对象 JSON', () => {
        // 仅 response.created + reasoning delta，缺少终态 -> SSE_TERMINAL_EVENT_MISSING
        assert.throws(() => utils.parseSseResponse([
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_reason_only","status":"in_progress"}}',
            '',
            'event: response.reasoning_summary_text.delta',
            'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking step 1"}',
            ''
        ].join('\n')), error => error.code === 'SSE_TERMINAL_EVENT_MISSING');

        // 仅有 event: response.* 头而 data 对象不含 type 字段时也应识别为缺终态
        assert.throws(() => utils.parseSseResponse([
            'event: response.in_progress',
            'data: {"id":"resp_evt_header"}',
            ''
        ].join('\n')), error => error.code === 'SSE_TERMINAL_EVENT_MISSING');

        // data: null / 数组 / 原始值不得触发 TypeError，纯非事件块返回 null
        assert.strictEqual(utils.parseSseResponse('data: null\n\n'), null);
        assert.strictEqual(utils.parseSseResponse('data: []\n\ndata: 42\n\ndata: "str"\n\n'), null);
        assert.strictEqual(utils.parseSseResponse('data: {"type":"keepalive"}\n\n'), null);

        // 前置 data: null 后紧跟合法 response.completed 时应正常完成
        const parsed = utils.parseSseResponse([
            'data: null',
            '',
            'data: [1, 2, 3]',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"status":"completed","output_text":"ok"}}',
            ''
        ].join('\n'));
        assert.strictEqual(parsed.status, 'completed');
        assert.strictEqual(parsed.output_text, 'ok');
    });

    it('requestJson 为 LLM_RESPONSE_PARSE_ERROR 与非 2xx SSE 失败附加 status/statusCode，并由 classifyFilterRequestError 正确分类', async (t) => {
        await withHttpServer(t, (req, res) => {
            if (req.url === '/html-502') {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'text/html');
                res.end('<html><body>502 Bad Gateway</body></html>');
                return;
            }
            if (req.url === '/html-200') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html');
                res.end('<html>not json</html>');
                return;
            }
            if (req.url === '/sse-503') {
                res.statusCode = 503;
                res.setHeader('Content-Type', 'text/event-stream');
                res.end('data: {"type":"response.created","response":{"id":"r1"}}\n\n');
                return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.end('data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n');
        }, async (baseUrl) => {
            // 1) HTTP 502 HTML 网关错误页 -> LLM_RESPONSE_PARSE_ERROR + status=502 -> 筛选判为可重试 HTTP 瞬时故障
            let err502;
            await assert.rejects(
                utils.requestJson(`${baseUrl}/html-502`, {}, {}, { timeoutMs: 2000, agent: false }),
                error => { err502 = error; return true; }
            );
            assert.strictEqual(err502.code, 'LLM_RESPONSE_PARSE_ERROR');
            assert.strictEqual(err502.status, 502);
            assert.strictEqual(err502.statusCode, 502);
            assert.strictEqual(err502.llmResponse.statusCode, 502);
            const cls502 = fetchPapers.classifyFilterRequestError(err502);
            assert.strictEqual(cls502.code, 'FILTER_HTTP_TRANSIENT');
            assert.strictEqual(cls502.retryable, true);
            assert.strictEqual(cls502.status, 502);

            // 2) HTTP 200 非 JSON 乱码 -> 仍保持不可重试（负向回归）
            let err200;
            await assert.rejects(
                utils.requestJson(`${baseUrl}/html-200`, {}, {}, { timeoutMs: 2000, agent: false }),
                error => { err200 = error; return true; }
            );
            assert.strictEqual(err200.code, 'LLM_RESPONSE_PARSE_ERROR');
            assert.strictEqual(err200.status, 200);
            assert.strictEqual(err200.statusCode, 200);
            const cls200 = fetchPapers.classifyFilterRequestError(err200);
            assert.strictEqual(cls200.code, 'LLM_RESPONSE_PARSE_ERROR');
            assert.strictEqual(cls200.retryable, false);

            // 3) HTTP 503 非完整 SSE -> 附加 503 并判为 HTTP 瞬时可重试
            let errSse503;
            await assert.rejects(
                utils.requestJson(`${baseUrl}/sse-503`, {}, {}, { timeoutMs: 2000, agent: false }),
                error => { errSse503 = error; return true; }
            );
            assert.strictEqual(errSse503.code, 'SSE_TERMINAL_EVENT_MISSING');
            assert.strictEqual(errSse503.status, 503);
            assert.strictEqual(errSse503.statusCode, 503);
            const clsSse503 = fetchPapers.classifyFilterRequestError(errSse503);
            assert.strictEqual(clsSse503.code, 'FILTER_HTTP_TRANSIENT');
            assert.strictEqual(clsSse503.retryable, true);

            // 4) HTTP 200 仅推理提前 EOF -> 保持无非 2xx status，且按 SSE_TERMINAL_EVENT_MISSING 可重试
            let errSse200;
            await assert.rejects(
                utils.requestJson(`${baseUrl}/sse-200`, {}, {}, { timeoutMs: 2000, agent: false }),
                error => { errSse200 = error; return true; }
            );
            assert.strictEqual(errSse200.code, 'SSE_TERMINAL_EVENT_MISSING');
            assert.strictEqual(errSse200.status, undefined);
            assert.strictEqual(errSse200.statusCode, undefined);
            const clsSse200 = fetchPapers.classifyFilterRequestError(errSse200);
            assert.strictEqual(clsSse200.code, 'SSE_TERMINAL_EVENT_MISSING');
            assert.strictEqual(clsSse200.category, 'content');
            assert.strictEqual(clsSse200.retryable, true);
            assert.strictEqual(clsSse200.systemFailure, false);
        });
    });

    it('classifyFilterRequestError 识别 statusCode/llmResponse.statusCode、流空闲超时、代理关闭/超时与 SSE 缺终态', () => {
        // 仅有 statusCode 或 llmResponse.statusCode 也能识别 5xx / 403
        const fromStatusCode = fetchPapers.classifyFilterRequestError(
            Object.assign(new Error('网关异常'), { code: 'LLM_RESPONSE_PARSE_ERROR', statusCode: 502 })
        );
        assert.strictEqual(fromStatusCode.code, 'FILTER_HTTP_TRANSIENT');
        assert.strictEqual(fromStatusCode.retryable, true);

        const fromLlmResp = fetchPapers.classifyFilterRequestError(
            Object.assign(new Error('网关异常'), { code: 'LLM_RESPONSE_PARSE_ERROR', llmResponse: { statusCode: 504 } })
        );
        assert.strictEqual(fromLlmResp.code, 'FILTER_HTTP_TRANSIENT');
        assert.strictEqual(fromLlmResp.retryable, true);

        const authFromLlmResp = fetchPapers.classifyFilterRequestError(
            Object.assign(new Error('禁止访问'), { code: 'LLM_RESPONSE_PARSE_ERROR', llmResponse: { statusCode: 403 } })
        );
        assert.strictEqual(authFromLlmResp.code, 'FILTER_AUTH_ERROR');
        assert.strictEqual(authFromLlmResp.retryable, false);
        assert.strictEqual(authFromLlmResp.stopBatch, true);

        // 纯中文消息下也能靠 error.code 识别瞬时传输故障
        const idle = fetchPapers.classifyFilterRequestError(
            Object.assign(new Error('流长时间无分片'), { code: 'REQUEST_STREAM_IDLE_TIMEOUT' })
        );
        assert.strictEqual(idle.code, 'REQUEST_STREAM_IDLE_TIMEOUT');
        assert.strictEqual(idle.retryable, true);
        assert.strictEqual(idle.systemFailure, true);

        for (const proxyCode of ['PROXY_CONNECT_CLOSED', 'PROXY_CONNECT_TIMEOUT']) {
            const cls = fetchPapers.classifyFilterRequestError(
                Object.assign(new Error('代理握手失败'), { code: proxyCode })
            );
            assert.strictEqual(cls.code, proxyCode);
            assert.strictEqual(cls.category, 'proxy');
            assert.strictEqual(cls.retryable, true);
            assert.strictEqual(cls.systemFailure, true);
        }

        const sseMissing = fetchPapers.classifyFilterRequestError(
            Object.assign(new Error('缺少终态'), { code: 'SSE_TERMINAL_EVENT_MISSING' })
        );
        assert.strictEqual(sseMissing.code, 'SSE_TERMINAL_EVENT_MISSING');
        assert.strictEqual(sseMissing.category, 'content');
        assert.strictEqual(sseMissing.retryable, true);
        assert.strictEqual(sseMissing.systemFailure, false);
    });
});

describe('Bug 2: Live Usage Sync 并发在途 429 冷却保护（JS）', () => {
    function makeTempPoolFile(t) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pool-sync-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        return path.join(dir, 'pool.json');
    }

    it('并发同步期间账号 1 命中更新的 HTTP 429 时，旧 usage 快照不得抹掉冷却', async (t) => {
        const stateFile = makeTempPoolFile(t);
        const keys = ['r5-sync-k1', 'r5-sync-k2'];
        const identity = pool.getPoolIdentity(keys, ENDPOINT);
        const id1 = pool.getAccountId(keys[0]);
        const id2 = pool.getAccountId(keys[1]);
        const futureBase = Date.now() + 2 * 3600_000;
        let k1Done = false;

        const fetcher = async ({ apiKey }) => {
            if (apiKey === keys[0]) {
                k1Done = true;
                return {
                    statusCode: 200,
                    body: {
                        usage: {
                            rolling: { status: 'ok', percent: 40, resetsAt: new Date(futureBase + 3600_000).toISOString() },
                            weekly: { status: 'ok', percent: 15, resetsAt: new Date(futureBase + 3 * 86400_000).toISOString() },
                            monthly: { status: 'ok', percent: 25, resetsAt: new Date(futureBase + 5 * 86400_000).toISOString() }
                        }
                    }
                };
            }
            // 账号 2 慢返回；在其返回前模拟另一工作协程在账号 1 上命中 429
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.strictEqual(k1Done, true);
            const exhaustedNow = Date.now();
            pool.markQuotaExhausted(
                { serviceId: identity.serviceId, service: identity.service, accountId: id1 },
                { limitClass: 'rolling_5h', blockedUntilMs: exhaustedNow + 3600_000 },
                stateFile,
                { nowMs: exhaustedNow }
            );
            return {
                statusCode: 200,
                body: {
                    usage: {
                        rolling: { status: 'ok', percent: 5, resetsAt: new Date(futureBase + 3600_000).toISOString() },
                        weekly: { status: 'ok', percent: 10, resetsAt: new Date(futureBase + 3 * 86400_000).toISOString() },
                        monthly: { status: 'ok', percent: 20, resetsAt: new Date(futureBase + 10 * 86400_000).toISOString() }
                    }
                }
            };
        };

        const syncRes = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, stateFile, { fetcher });
        assert.strictEqual(syncRes.synced, 2);
        assert.strictEqual(syncRes.failed, 0);

        const state = pool.readStateStrict(stateFile);
        const rec1 = state.services[identity.serviceId].accounts[id1];
        assert.strictEqual(rec1.status, 'quota_blocked');
        assert.strictEqual(rec1.limitName, 'rolling_5h');
        assert.ok(rec1.windows && rec1.windows.rolling_5h, 'rolling_5h 冷却记录必须保留');
        assert.strictEqual(rec1.quota.rolling5hRemainingPct, 0);
        // 账号 1 虽然月到期更早（+5d vs +10d），但 5h 窗口被更新的 429 冷却保护，必须选中账号 2
        const picked = pool.selectApiKey(keys, ENDPOINT, stateFile);
        assert.strictEqual(picked.accountId, id2);
    });

    it('applyLiveUsageSnapshots 按 fetchedAtMs 精确区分新 429 保留与旧/已过期 429 清理', (t) => {
        const stateFile = makeTempPoolFile(t);
        const keys = ['r5-direct-k1', 'r5-direct-k2'];
        const identity = pool.getPoolIdentity(keys, ENDPOINT);
        const id1 = pool.getAccountId(keys[0]);
        const id2 = pool.getAccountId(keys[1]);
        const sel1 = { serviceId: identity.serviceId, service: identity.service, accountId: id1 };
        const sel2 = { serviceId: identity.serviceId, service: identity.service, accountId: id2 };
        const T0 = Date.parse('2026-11-26T04:00:00.000Z');

        // 账号 1：在 T0+500ms 命中 weekly 429（晚于快照开始时间 T0）-> 保留
        pool.markQuotaExhausted(sel1, { limitClass: 'weekly', blockedUntilMs: T0 + 2 * 86400_000 }, stateFile, { nowMs: T0 + 500 });
        // 账号 1：同时有一个早于 T0 的旧 monthly 429（T0-5000ms）-> 应被 limited=false 清除
        pool.markQuotaExhausted(sel1, { limitClass: 'monthly', blockedUntilMs: T0 + 10 * 86400_000 }, stateFile, { nowMs: T0 - 5000 });
        // 账号 2：在 T0 同一毫秒命中 rolling_5h 429，且冷却已于 T0+1000 之前过期 -> 不应保留
        pool.markQuotaExhausted(sel2, { limitClass: 'rolling_5h', blockedUntilMs: T0 + 1500 }, stateFile, { nowMs: T0 });

        const snapOk = {
            fetchedAtMs: T0,
            monthly: { status: 'ok', usedPercent: 30, remainingPct: 70, limited: false, resetsAtMs: T0 + 15 * 86400_000 },
            weekly: { status: 'ok', usedPercent: 20, remainingPct: 80, limited: false, resetsAtMs: T0 + 5 * 86400_000 },
            rolling: { status: 'ok', usedPercent: 10, remainingPct: 90, limited: false, resetsAtMs: T0 + 5 * 3600_000 }
        };
        pool.applyLiveUsageSnapshots(keys, ENDPOINT, { [id1]: snapOk, [id2]: snapOk }, stateFile, { nowMs: T0 + 2000 });

        const accounts = pool.readStateStrict(stateFile).services[identity.serviceId].accounts;
        // 账号 1：weekly 保留，monthly 清除
        assert.strictEqual(accounts[id1].status, 'quota_blocked');
        assert.ok(accounts[id1].windows.weekly);
        assert.strictEqual(accounts[id1].windows.monthly, undefined);
        assert.strictEqual(accounts[id1].quota.weeklyRemainingPct, 0);
        assert.strictEqual(accounts[id1].quota.monthlyRemainingPct, 70);

        // 账号 2：已过期冷却（blockedUntilMs = T0+1500 <= nowMs = T0+2000）被清理，恢复 eligible
        assert.strictEqual(accounts[id2].status, 'eligible');
        assert.strictEqual(accounts[id2].windows, undefined);
        assert.strictEqual(accounts[id2].quota.rolling5hRemainingPct, 90);
    });
});

describe('Bug 3: JS 账号池锁探针规范化环境与 ±60s bootTime 漂移容忍', () => {
    it('sysctl 与 ps 子进程携带 LC_ALL=C、TZ=UTC 且保留 PATH，±60s 内不误抢活锁，>60s 正常回收', (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pool-lock-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const stateFile = path.join(dir, 'pool.json');
        const script = String.raw`
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const os = require('node:os');
            const path = require('node:path');
            const cp = require('node:child_process');
            const stateFile = process.argv[1];
            const lockDir = stateFile + '.lock';
            const ownerFile = path.join(lockDir, 'owner.json');
            const seenEnvs = {};
            const origExec = cp.execFileSync;
            cp.execFileSync = function(cmd, args, opts) {
                if (cmd === 'sysctl' || cmd === 'ps') {
                    seenEnvs[cmd] = opts && opts.env ? { ...opts.env } : null;
                }
                if (cmd === 'sysctl') return '{ sec = 1700000000, usec = 0 }';
                if (cmd === 'ps') return 'Mon Nov 26 10:00:00 2026\n';
                return origExec.call(this, cmd, args, opts);
            };
            const pool = require(${JSON.stringify(path.join(ROOT, 'scripts/llm-account-pool.js'))});
            // 1) 正常加锁解锁，验证探针 env 携带 LC_ALL=C 和 TZ=UTC
            const unlock = pool.acquireStateLock(stateFile, { timeoutMs: 200, staleMs: 60000 });
            unlock();
            if (process.platform === 'darwin') {
                assert.equal(seenEnvs.sysctl.LC_ALL, 'C');
                assert.equal(seenEnvs.sysctl.TZ, 'UTC');
                assert.ok(seenEnvs.sysctl.PATH);
            }
            if (process.platform !== 'linux') {
                assert.equal(seenEnvs.ps.LC_ALL, 'C');
                assert.equal(seenEnvs.ps.TZ, 'UTC');
                assert.ok(seenEnvs.ps.PATH);
            }
            // 2) 在 macOS/Linux 上验证 bootTime ±60s 容忍与 >60s 回收
            const probeUnlock = pool.acquireStateLock(stateFile, { timeoutMs: 200, staleMs: 60000 });
            const liveOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
            probeUnlock();
            if (Number.isInteger(liveOwner.bootTime)) {
                const writeOwner = (bootTime) => {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                    fs.mkdirSync(lockDir, { mode: 0o700 });
                    fs.writeFileSync(ownerFile, JSON.stringify({
                        ...liveOwner,
                        pid: process.pid,
                        hostname: os.hostname(),
                        bootTime
                    }), { mode: 0o600 });
                    const oldDate = new Date(Date.now() - 120000);
                    fs.utimesSync(ownerFile, oldDate, oldDate);
                    fs.utimesSync(lockDir, oldDate, oldDate);
                };
                // 漂移 -2s 与 +60s：仍判定存活，拒绝抢锁
                for (const delta of [-2, 60]) {
                    writeOwner(liveOwner.bootTime + delta);
                    assert.throws(
                        () => pool.acquireStateLock(stateFile, { timeoutMs: 60, staleMs: 1 }),
                        err => err.code === 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT'
                    );
                }
                // 漂移 -61s（真正重启）：立即识别为死锁并成功回收
                writeOwner(liveOwner.bootTime - 61);
                const reclaimedUnlock = pool.acquireStateLock(stateFile, { timeoutMs: 500, staleMs: 1 });
                reclaimedUnlock();
            }
        `;
        const res = spawnSync(process.execPath, ['-e', script, stateFile], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, TZ: 'Asia/Shanghai', LC_ALL: 'zh_CN.UTF-8' },
            timeout: 10000
        });
        assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    });
});

describe('Bug 4: arXiv 元数据抓取与 OAI 恢复对关闭/代理超时错误重试', () => {
    it('arxiv-metadata-source 识别 ARXIV_RESPONSE_CLOSED、PROXY_CONNECT_CLOSED、PROXY_CONNECT_TIMEOUT 并在第 3 次成功', async () => {
        for (const code of ['ARXIV_RESPONSE_CLOSED', 'PROXY_CONNECT_CLOSED', 'PROXY_CONNECT_TIMEOUT']) {
            assert.strictEqual(
                arxivMeta.isTransientAtomFetchError(Object.assign(new Error('纯中文瞬时故障'), { code })),
                true,
                code
            );
        }
        assert.strictEqual(
            arxivMeta.isTransientAtomFetchError(Object.assign(new Error('格式损坏'), { code: 'ARXIV_METADATA_INTEGRITY' })),
            false
        );

        const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2610.12345v1</id>
    <updated>2026-10-20T01:00:00Z</updated>
    <published>2026-10-20T01:00:00Z</published>
    <title>Audio Transport Retry Test</title>
    <summary>Speech synthesis with reliable transport retries.</summary>
    <author><name>Alice Example</name></author>
    <category term="eess.AS" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;
        let attempts = 0;
        const result = await arxivMeta.fetchOfficialArxivMetadata('2610.12345', {
            detectProxy: () => 'http://127.0.0.1:7897',
            now: () => '2026-10-20T02:00:00.000Z',
            requestFn: async () => {
                attempts += 1;
                if (attempts === 1) throw Object.assign(new Error('上游提前关闭'), { code: 'ARXIV_RESPONSE_CLOSED' });
                if (attempts === 2) throw Object.assign(new Error('代理隧道关闭'), { code: 'PROXY_CONNECT_CLOSED' });
                return { status: 200, data: atomXml };
            }
        });
        assert.strictEqual(attempts, 3);
        assert.strictEqual(result.metadata.arxivId, '2610.12345');
        assert.strictEqual(result.metadata.title, 'Audio Transport Retry Test');
    });

    it('daily-arxiv-oai-source 对 ARXIV_RESPONSE_CLOSED 与 PROXY_CONNECT_TIMEOUT 执行页级重试并完成核验', async (t) => {
        t.mock.method(Date, 'now', () => Date.parse('2026-10-20T05:00:00.000Z'));
        const oldProxy = process.env.HTTPS_PROXY;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
        t.after(() => {
            if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
            else process.env.HTTPS_PROXY = oldProxy;
        });

        const sort = x => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
            ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
        const b = {
            ...codec.recordHeader('daily-fetch-boundary', 'daily-fetch-boundary'),
            lastDigestDate: '2026-10-19',
            since: '2026-10-16T14:35:00.000Z',
            until: '2026-10-19T03:00:00.000Z'
        };
        b.identitySha256 = sha256(JSON.stringify(sort(b)));

        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r5-oai-retry-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const evidenceDir = path.join(root, 'oai-evidence');
        const id = '2610.23539';
        const rss = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>eess.AS updates on arXiv.org</title><link>http://rss.arxiv.org/rss/eess.AS</link><description>eess.AS updates on the arXiv.org e-print archive.</description><atom:link href="http://rss.arxiv.org/rss/eess.AS" rel="self" type="application/rss+xml"/><pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate><lastBuildDate>Mon, 19 Oct 2026 04:00:23 +0000</lastBuildDate><item><title>A</title><link>https://arxiv.org/abs/${id}</link><description>arXiv:${id}v1 Announce Type: cross \nAbstract: A.</description><guid isPermaLink="false">oai:arXiv.org:${id}v1</guid><category>eess.AS</category><pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate><arxiv:announce_type>cross</arxiv:announce_type></item></channel></rss>`;
        const rssHash = sha256(rss);
        const rssPath = path.join(root, `rss-eess.AS-${rssHash}.xml`);
        fs.writeFileSync(rssPath, rss, { mode: 0o600, flag: 'wx' });

        const makePageXml = prefix => {
            const header = `<header><identifier>oai:arXiv.org:${id}</identifier><datestamp>2026-10-19</datestamp><setSpec>eess:eess:AS</setSpec></header>`;
            const common = `<id>${id}</id><title>Speech OAI Retry Paper</title><categories>eess.AS</categories><abstract>Speech recognition benchmark.</abstract>`;
            const body = prefix === 'arXivRaw'
                ? '<authors>Alice Example</authors><version version="v1"><date>Fri, 16 Oct 2026 14:35:04 GMT</date></version>'
                : '<created>2026-10-16</created><authors><author><keyname>Example</keyname><forenames>Alice</forenames></author></authors>';
            const rec = `<record>${header}<metadata><${prefix} xmlns="http://arxiv.org/OAI/${prefix}/">${common}${body}</${prefix}></metadata></record>`;
            return `<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><responseDate>2026-10-20T03:00:00Z</responseDate><request verb="ListRecords" metadataPrefix="${prefix}" set="eess:eess:AS" from="2026-10-16">http://oaipmh.arxiv.org/oai</request><ListRecords>${rec}<resumptionToken></resumptionToken></ListRecords></OAI-PMH>`;
        };

        let firstPageCalls = 0;
        let arXivCalls = 0;
        const papers = await oaiSource.fetchDailyOaiCategory('eess.AS', b, [], {
            evidenceDir,
            announcementEvidence: {
                ...evidenceHeaderForBoundary(b, 'daily-arxiv-announcement-evidence'),
                categoryId: 'eess.AS',
                boundaryIdentity: b.identitySha256,
                url: 'https://rss.arxiv.org/rss/eess.AS',
                retrievedAt: '2026-10-20T03:00:00.000Z',
                filePath: rssPath,
                bytes: Buffer.byteLength(rss),
                sha256: rssHash
            },
            triggerFailure: {
                categoryId: 'eess.AS',
                ok: false,
                failures: [{ error: 'HTTP 429' }],
                provider: {
                    boundaryIdentity: b.identitySha256,
                    window: { since: b.since, until: b.until, covered: false, ...coverageHeaderForBoundary(b, 'daily-arxiv-atom-prefix-coverage') },
                    categoryPrefix: {
                        ...evidenceHeaderForBoundary(b, 'daily-arxiv-atom-prefix-coverage'),
                        categoryId: 'eess.AS',
                        boundaryIdentity: b.identitySha256,
                        dateQueryFailure: {
                            health: {
                                categoryId: 'eess.AS',
                                failures: [{ error: 'HTTP 429' }],
                                provider: { boundaryIdentity: b.identitySha256, window: { since: b.since, until: b.until, covered: false } }
                            }
                        }
                    }
                }
            },
            requestScheduler: { run: async (_host, task) => task(), defer: () => {} },
            requestFn: async (url) => {
                const prefix = new URL(url).searchParams.get('metadataPrefix');
                if (prefix === 'arXivRaw') {
                    firstPageCalls += 1;
                    if (firstPageCalls === 1) throw Object.assign(new Error('响应提前关闭'), { code: 'ARXIV_RESPONSE_CLOSED' });
                    if (firstPageCalls === 2) throw Object.assign(new Error('代理握手超时'), { code: 'PROXY_CONNECT_TIMEOUT' });
                } else if (prefix === 'arXiv') {
                    arXivCalls += 1;
                    if (arXivCalls === 1) throw Object.assign(new Error('代理握手关闭'), { code: 'PROXY_CONNECT_CLOSED' });
                }
                return { status: 200, data: makePageXml(prefix) };
            }
        });
        assert.strictEqual(papers.length, 1);
        assert.strictEqual(papers[0].arxivId, `${id}v1`);
        assert.ok(firstPageCalls >= 3);
        assert.ok(arXivCalls >= 2);
    });
});

describe('Bug 6: sharedArxivOriginGate 动态响应导入后的 PD_ARXIV_MAX_CONCURRENCY', () => {
    it('默认构造不冻结并发上限，导入后修改环境变量即动态生效，显式参数优先', async (t) => {
        const saved = process.env.PD_ARXIV_MAX_CONCURRENCY;
        t.after(() => {
            if (saved === undefined) delete process.env.PD_ARXIV_MAX_CONCURRENCY;
            else process.env.PD_ARXIV_MAX_CONCURRENCY = saved;
            originGate.sharedArxivOriginGate.resetForTests();
        });

        assert.strictEqual(originGate.sharedArxivOriginGate.maxConcurrency, null);

        const measurePeak = async (gate, total) => {
            let active = 0;
            let peak = 0;
            await Promise.all(Array.from({ length: total }, () => gate.run(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise(resolve => setTimeout(resolve, 15));
                active -= 1;
            })));
            return peak;
        };

        process.env.PD_ARXIV_MAX_CONCURRENCY = '1';
        assert.strictEqual(await measurePeak(originGate.sharedArxivOriginGate, 4), 1);

        process.env.PD_ARXIV_MAX_CONCURRENCY = '5';
        assert.strictEqual(await measurePeak(originGate.sharedArxivOriginGate, 6), 5);

        // 显式构造覆写不受环境变量变更影响
        const fixedGate = new originGate.ArxivOriginGate({ maxConcurrency: 2 });
        assert.strictEqual(fixedGate.maxConcurrency, 2);
        assert.strictEqual(await measurePeak(fixedGate, 6), 2);
    });
});

describe('Bug 7: fresh-analysis-context.js 硬链接发布窗口并发容错与 fail-closed', () => {
    function makeFreshFixture(t) {
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r5-fresh-nlink-'));
        const previousRoot = Config.FILES.freshRewriteRunsDir;
        Config.FILES.freshRewriteRunsDir = directory;
        t.after(() => {
            Config.FILES.freshRewriteRunsDir = previousRoot;
            fs.rmSync(directory, { recursive: true, force: true });
        });
        const id = '2611.88881';
        const text = 'Verified audio paper evidence for hardlink publication window test.\n'.repeat(80);
        const artifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha256(text) };
        artifacts.payloadSha256 = sha256(JSON.stringify(artifacts));
        const details = {
            text, source: 'html', sourceId: `${id}v1`, imageInfos: [], structuredArtifacts: artifacts,
            readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: []
        };
        const sourceExpectations = { [id]: { sourceSha256: sha256(text), structuredArtifactsSha256: artifacts.payloadSha256 } };
        const runId = crypto.randomUUID();
        const runDir = path.join(directory, runId);
        fs.mkdirSync(runDir, { mode: 0o700 });
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
            version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [id], sourceExpectations
        }), { mode: 0o600 });
        return { id, text, details, context: { runId, runDir, sourceExpectations }, sourceDir: path.join(runDir, 'sources', id) };
    }

    it('短暂 nlink === 2 窗口（并发 linkSync->unlinkSync）有界等待后成功，持久 nlink >= 2 与 nlink === 3 仍 fail-closed', async (t) => {
        const f = makeFreshFixture(t);
        await fresh.withFreshAnalysisContext(f.context, () =>
            fresh.fetchFreshSource(f.id, async () => structuredClone(f.details))
        );
        const sourceTxt = path.join(f.sourceDir, 'source.txt');
        const tempLink = path.join(f.sourceDir, '.source.txt.concurrent.tmp');
        fs.linkSync(sourceTxt, tempLink);
        assert.strictEqual(fs.statSync(sourceTxt).nlink, 2);

        // 后台线程 12ms 后清理临时硬链接，模拟并发写者完成 unlinkSync
        const worker = new Worker(
            'const fs = require("node:fs"); const { workerData } = require("node:worker_threads"); setTimeout(() => { try { fs.unlinkSync(workerData.file); } catch {} }, 12);',
            { eval: true, workerData: { file: tempLink } }
        );
        try {
            const loaded = fresh.readFreshSource(f.context.runDir, f.id, f.context);
            assert.strictEqual(loaded.text, f.text);
        } finally {
            await worker.terminate();
            if (fs.existsSync(tempLink)) fs.unlinkSync(tempLink);
        }

        // 负向 1：持续不解除的 nlink === 2 仍必须 fail-closed 抛 FRESH_ANALYSIS_INTEGRITY
        const persistentLink = path.join(f.sourceDir, '.persistent-hardlink');
        fs.linkSync(sourceTxt, persistentLink);
        try {
            assert.throws(
                () => fresh.readFreshSource(f.context.runDir, f.id, f.context),
                err => err.code === 'FRESH_ANALYSIS_INTEGRITY'
            );
        } finally {
            fs.unlinkSync(persistentLink);
        }

        // 负向 2：nlink === 3 必须立即 fail-closed 抛 FRESH_ANALYSIS_INTEGRITY
        const extra1 = path.join(f.sourceDir, '.extra-hardlink-1');
        const extra2 = path.join(f.sourceDir, '.extra-hardlink-2');
        fs.linkSync(sourceTxt, extra1);
        fs.linkSync(sourceTxt, extra2);
        try {
            const started = Date.now();
            assert.throws(
                () => fresh.readFreshSource(f.context.runDir, f.id, f.context),
                err => err.code === 'FRESH_ANALYSIS_INTEGRITY'
            );
            assert.ok(Date.now() - started < 50, 'nlink > 2 应立即拒绝而非等待');
        } finally {
            fs.unlinkSync(extra1);
            fs.unlinkSync(extra2);
        }
    });
});

describe('Bug 8: env-schema.js URL 校验拒绝非 HTTP(S) 协议与协议拼写错误', () => {
    test('合法 https/本地 http 返回 ok，非本地 http 返回 warn，非法协议/拼写/空主机名返回 fail 且不泄密', () => {
        const endpointItem = envSchema.SCHEMA_BY_NAME.get('PAPER_ANALYZER_ENDPOINT');

        assert.strictEqual(envSchema.validateValue(endpointItem, 'https://opencode.ai/zen/go/v1').ok, 'ok');
        assert.strictEqual(envSchema.validateValue(endpointItem, 'http://127.0.0.1:8080/v1').ok, 'ok');
        assert.strictEqual(envSchema.validateValue(endpointItem, 'http://localhost:8080/v1').ok, 'ok');
        assert.strictEqual(envSchema.validateValue(endpointItem, 'http://[::1]:8080/v1').ok, 'ok');
        assert.strictEqual(envSchema.validateValue(endpointItem, 'http://api.example.com/v1').ok, 'warn');

        const badUrls = [
            'htps://opencode.ai/zen/go/v1',
            'htt://example.com/v1',
            'ftp://example.com/v1',
            'file:///etc/passwd',
            'javascript:alert(1)',
            'mailto:ops@example.com',
            'socks5://127.0.0.1:1080',
            'http:///missing-host',
            'http:example.com/v1',
            'https://'
        ];
        for (const bad of badUrls) {
            const res = envSchema.validateValue(endpointItem, bad);
            assert.strictEqual(res.ok, 'fail', `应拒绝非法 URL: ${bad}`);
        }

        const credRes = envSchema.validateValue(endpointItem, 'ftp://user:TOPSECRET999@example.com/v1');
        assert.strictEqual(credRes.ok, 'fail');
        assert.ok(!JSON.stringify(credRes).includes('TOPSECRET999'), '错误信息不得回显 URL 凭据');
    });
});
