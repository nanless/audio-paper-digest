const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    LlmAccountPoolLockTimeoutError,
    LlmAccountPoolStateError,
    POLICY_VERSION,
    acquireStateLock,
    classifyOpenCodeGoQuotaResponse,
    getAccountId,
    getPoolIdentity,
    markQuotaExhausted,
    readStateStrict,
    resolveApiKeyPool,
    resolvePrimaryApiKeyPool,
    sanitizeLimitName,
    selectApiKey
} = require('../scripts/llm-account-pool.js');
const { requestLlmJson } = require('../scripts/utils.js');

const ENDPOINT = 'https://opencode.ai/zen/go/v1';

function tempState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-llm-pool-'));
    return { dir, file: path.join(dir, 'llm-account-pool.json') };
}

describe('OpenCode Go sticky account state', () => {
    it('rejects duplicate primary and fallback credentials', () => {
        assert.throws(
            () => resolveApiKeyPool('same-key', 'same-key'),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
    });

    it('keeps the explicitly configured third account after the normal fallback', () => {
        assert.deepEqual(
            resolvePrimaryApiKeyPool('account-a', 'account-b', 'account-c'),
            ['account-a', 'account-b', 'account-c']
        );
        assert.throws(
            () => resolvePrimaryApiKeyPool('account-a', 'account-b', 'account-b'),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
    });

    it('rejects credential-bearing or query-mutated OpenCode endpoints', () => {
        for (const endpoint of [
            'https://user:pass@opencode.ai/zen/go/v1',
            'https://opencode.ai:444/zen/go/v1',
            'https://opencode.ai/zen/go/v1?redirect=1'
        ]) {
            assert.throws(
                () => getPoolIdentity(['a', 'b'], endpoint),
                error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            );
        }
    });

    it('rejects raw/decoded dot segments and encoded route separators before WHATWG normalization', () => {
        for (const endpoint of [
            'https://opencode.ai/zen/go/./v1',
            'https://opencode.ai/zen/go/../v1',
            'https://opencode.ai/zen/go/%2e/v1',
            'https://opencode.ai/zen/go/.%2E/v1',
            'https://opencode.ai/zen/go/%2e%2e/v1',
            'https://opencode.ai/zen/go/%2e%2e%2fprivate',
            'https://opencode.ai/zen/go/v1%2fresponses',
            'https://opencode.ai/zen/go/v1%5cresponses'
        ]) {
            assert.throws(
                () => getPoolIdentity(['a', 'b'], endpoint),
                error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            );
        }
    });

    it('keeps one account active until that active account is quota blocked', () => {
        const { file } = tempState();
        const keys = resolveApiKeyPool('account-a-secret', 'account-b-secret');
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        assert.strictEqual(first.apiKey, 'account-a-secret');

        markQuotaExhausted(first, {
            limitName: '5-hour rolling',
            blockedUntilMs: 2000
        }, file, { nowMs: 1000 });
        const second = selectApiKey(keys, ENDPOINT, file, { nowMs: 1100 });
        assert.strictEqual(second.apiKey, 'account-b-secret');

        // A has recovered, but successful B remains sticky instead of failing back.
        const stillSecond = selectApiKey(keys, ENDPOINT, file, { nowMs: 3000 });
        assert.strictEqual(stillSecond.apiKey, 'account-b-secret');
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes('account-a-secret'));
        assert.ok(!raw.includes('account-b-secret'));
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        assert.strictEqual(readStateStrict(file).policyVersion, POLICY_VERSION);
    });

    it('uses the third account only after the first and normal fallback receive quota blocks', () => {
        const { file } = tempState();
        const keys = resolvePrimaryApiKeyPool('account-a-secret', 'account-b-secret', 'account-c-secret');
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        markQuotaExhausted(first, { limitName: 'quota', blockedUntilMs: 9000 }, file, { nowMs: 1000 });
        const second = selectApiKey(keys, ENDPOINT, file, { nowMs: 1100 });
        assert.strictEqual(second.apiKey, 'account-b-secret');
        markQuotaExhausted(second, { limitName: 'quota', blockedUntilMs: 9000 }, file, { nowMs: 1100 });
        const third = selectApiKey(keys, ENDPOINT, file, { nowMs: 1200 });
        assert.strictEqual(third.apiKey, 'account-c-secret');
    });

    it('only classifies explicit GoUsageLimitError as quota exhaustion', () => {
        assert.strictEqual(classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after': '60' },
            body: { error: { type: 'rate_limit_error', message: 'too many requests' } }
        }, { nowMs: 1000 }), null);

        const quota = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after': '60' },
            body: {
                type: 'GoUsageLimitError',
                message: '5-hour usage limit reached',
                metadata: { limitName: '5-hour rolling' }
            }
        }, { nowMs: 1000 });
        assert.strictEqual(quota.limitName, '5-hour rolling');
        assert.strictEqual(quota.blockedUntilMs, 61000);

        const conflicting = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after': '60' },
            body: {
                type: 'GoUsageLimitError',
                message: '5-hour usage limit reached. Resets in 30min.',
                metadata: { limitName: '5-hour rolling' }
            }
        }, { nowMs: 1000 });
        assert.strictEqual(conflicting.blockedUntilMs, 1801000);
        assert.strictEqual(conflicting.limitClass, 'rolling_5h');
    });

    it('uses every finite reset hint, takes the conservative maximum, and clamps once', () => {
        const nowMs = 1000;
        const quota = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: {
                'retry-after-ms': ['250', 'Infinity', '750'],
                'Retry-After': ['2', '120']
            },
            body: {
                type: 'GoUsageLimitError',
                message: 'Reset in 3 minutes; resets in 2 hours; reset in 10 seconds.'
            }
        }, { nowMs });
        assert.strictEqual(quota.blockedUntilMs, nowMs + 2 * 60 * 60 * 1000);

        const maxBlockMs = 370 * 24 * 60 * 60 * 1000;
        const clamped = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: {
                'retry-after-ms': ['Infinity', String(maxBlockMs + 5000)],
                'retry-after': 'NaN'
            },
            body: { type: 'GoUsageLimitError', message: 'resets in 999999 days' }
        }, { nowMs });
        assert.strictEqual(clamped.blockedUntilMs, nowMs + maxBlockMs);

        const nonFiniteIgnored = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after-ms': 'Infinity', 'retry-after': 'NaN' },
            body: {
                type: 'GoUsageLimitError',
                metadata: { limitName: '5-hour rolling' }
            }
        }, { nowMs });
        assert.strictEqual(nonFiniteIgnored.blockedUntilMs, nowMs + 5 * 60 * 60 * 1000);

        const coalesced = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: {
                'retry-after-ms': '250, 750',
                'retry-after': '2, 120'
            },
            body: { type: 'GoUsageLimitError' }
        }, { nowMs });
        assert.strictEqual(coalesced.blockedUntilMs, nowMs + 120000);

        const exponentRejected = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after-ms': '1e6', 'retry-after': '1e3' },
            body: {
                type: 'GoUsageLimitError',
                metadata: { limitName: '5-hour rolling' }
            }
        }, { nowMs });
        assert.strictEqual(exponentRejected.blockedUntilMs, nowMs + 5 * 60 * 60 * 1000);
    });

    it('sanitizes provider-controlled quota labels before returning or persisting them', () => {
        const unsafe = '\u001b[31mrolling\r\nforged-line\u0000\u001b[0m';
        assert.strictEqual(sanitizeLimitName(unsafe), 'rolling forged-line');
        const quota = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: {},
            body: {
                type: 'GoUsageLimitError',
                metadata: { limitName: unsafe }
            }
        }, { nowMs: 1000 });
        assert.strictEqual(quota.limitName, 'rolling forged-line');
        assert.strictEqual(quota.limitClass, 'rolling_5h');

        const { file } = tempState();
        const selection = selectApiKey(['a', 'b'], ENDPOINT, file, { nowMs: 1000 });
        markQuotaExhausted(selection, quota, file, { nowMs: 1000 });
        const state = readStateStrict(file);
        const record = state.services[selection.serviceId].accounts[selection.accountId];
        assert.strictEqual(record.limitName, 'rolling_5h');
        assert.ok(!JSON.stringify(state).includes('forged-line'));
    });

    it('throws a typed retryable error when the state lock cannot be acquired', () => {
        const { file } = tempState();
        const release = acquireStateLock(file);
        try {
            assert.throws(
                () => acquireStateLock(file, { timeoutMs: 10 }),
                error => error instanceof LlmAccountPoolLockTimeoutError
                    && error.code === 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT'
                    && error.retryable === true
                    && error.category === 'state_contention'
            );
        } finally {
            release();
        }
    });

    it('marks an expired quota record eligible when that account is selected again', () => {
        const { file } = tempState();
        const keys = ['account-a', 'account-b'];
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        markQuotaExhausted(first, { blockedUntilMs: 2000 }, file, { nowMs: 1000 });
        const second = selectApiKey(keys, ENDPOINT, file, { nowMs: 1100 });
        markQuotaExhausted(second, { blockedUntilMs: 4000 }, file, { nowMs: 3000 });

        const recovered = selectApiKey(keys, ENDPOINT, file, { nowMs: 3000 });
        assert.strictEqual(recovered.apiKey, 'account-a');
        const state = readStateStrict(file);
        const service = state.services[recovered.serviceId];
        assert.strictEqual(service.accounts[recovered.accountId].status, 'eligible_after_reset');
    });

    it('fails closed instead of overwriting corrupt state', () => {
        const { file } = tempState();
        fs.writeFileSync(file, '{broken', { mode: 0o600 });
        assert.throws(
            () => selectApiKey(['a', 'b'], ENDPOINT, file),
            /状态损坏或不可读/
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    });

    it('rejects invalid or overflowing generation without rewriting state', () => {
        for (const generation of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
            const { file } = tempState();
            const raw = JSON.stringify({
                schemaVersion: 1,
                policyVersion: POLICY_VERSION,
                generation,
                services: {}
            });
            fs.writeFileSync(file, raw, { mode: 0o600 });
            assert.throws(
                () => readStateStrict(file),
                error => error instanceof LlmAccountPoolStateError
                    && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
            assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
        }

        const { file } = tempState();
        const raw = JSON.stringify({
            schemaVersion: 1,
            policyVersion: POLICY_VERSION,
            generation: Number.MAX_SAFE_INTEGER,
            services: {}
        });
        fs.writeFileSync(file, raw, { mode: 0o600 });
        assert.throws(
            () => selectApiKey(['a', 'b'], ENDPOINT, file),
            error => error instanceof LlmAccountPoolStateError
                && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
    });

    it('rejects explicit null blockedUntilMs without rewriting shared state', () => {
        const { file } = tempState();
        const raw = JSON.stringify({
            schemaVersion: 1,
            policyVersion: POLICY_VERSION,
            generation: 1,
            services: {
                service: {
                    endpoint: 'https://opencode.ai/zen/go',
                    accounts: { account: { blockedUntilMs: null } },
                    groups: {}
                }
            }
        });
        fs.writeFileSync(file, raw, { mode: 0o600 });
        assert.throws(
            () => readStateStrict(file),
            error => error instanceof LlmAccountPoolStateError
                && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
    });

    it('rejects a symlink state file', () => {
        const { dir, file } = tempState();
        const target = path.join(dir, 'target.json');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, file);
        assert.throws(
            () => selectApiKey(['a', 'b'], ENDPOINT, file),
            error => error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
        );
    });

    it('fails closed on reclaim and owner symlinks with typed state errors', () => {
        {
            const { dir, file } = tempState();
            const target = path.join(dir, 'reclaim-target');
            fs.mkdirSync(target);
            fs.symlinkSync(target, `${file}.lock.reclaim`, 'dir');
            assert.throws(
                () => acquireStateLock(file),
                error => error instanceof LlmAccountPoolStateError
                    && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
        }

        {
            const { dir, file } = tempState();
            const lockPath = `${file}.lock`;
            fs.mkdirSync(lockPath);
            const target = path.join(dir, 'owner-target.json');
            fs.writeFileSync(target, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
            fs.symlinkSync(target, path.join(lockPath, 'owner.json'));
            assert.throws(
                () => acquireStateLock(file, { timeoutMs: 10, staleMs: 0 }),
                error => error instanceof LlmAccountPoolStateError
                    && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
        }
    });

    it('retries when a concurrent process removes the reclaim gate during inspection', () => {
        const { file } = tempState();
        const reclaimPath = `${file}.lock.reclaim`;
        fs.mkdirSync(reclaimPath);
        const originalLstatSync = fs.lstatSync;
        let simulatedRace = false;
        fs.lstatSync = function patchedLstatSync(target, ...args) {
            if (!simulatedRace && String(target) === reclaimPath) {
                simulatedRace = true;
                fs.rmSync(reclaimPath, { recursive: true, force: true });
                const error = new Error(`ENOENT: no such file or directory, lstat '${reclaimPath}'`);
                error.code = 'ENOENT';
                throw error;
            }
            return originalLstatSync.call(fs, target, ...args);
        };
        let release;
        try {
            release = acquireStateLock(file);
            assert.ok(simulatedRace);
        } finally {
            fs.lstatSync = originalLstatSync;
            release?.();
        }
    });

    it('shares quota blocks across groups containing the same credential', () => {
        const { file } = tempState();
        const firstGroup = ['a', 'b'];
        const secondGroup = ['a', 'c'];
        const selection = selectApiKey(firstGroup, ENDPOINT, file, { nowMs: 1000 });
        markQuotaExhausted(selection, { blockedUntilMs: 100000 }, file, { nowMs: 1000 });
        assert.strictEqual(selectApiKey(secondGroup, ENDPOINT, file, { nowMs: 2000 }).apiKey, 'c');
        assert.ok(readStateStrict(file).generation >= 3);
        assert.ok(getAccountId('a') in Object.values(readStateStrict(file).services)[0].accounts);
    });

    it('writes a state schema that the Python publisher reads with the same sticky result', () => {
        const { file } = tempState();
        const first = selectApiKey(['a', 'b'], ENDPOINT, file, { nowMs: 1000 });
        markQuotaExhausted(first, { blockedUntilMs: 100000 }, file, { nowMs: 1000 });
        const script = [
            'import sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import select_api_key',
            `print(select_api_key(['a','b'], ${JSON.stringify(ENDPOINT)}, sys.argv[1], now_ms=2000)['api_key'])`
        ].join('; ');
        const result = spawnSync(process.env.PD_PYTHON_BIN || 'python3', ['-c', script, file], {
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout.trim(), 'b');
        assert.strictEqual(selectApiKey(['a', 'b'], ENDPOINT, file, { nowMs: 3000 }).apiKey, 'b');
    });
});

describe('requestLlmJson OpenCode Go failover', () => {
    it('rejects every duplicate configured credential before transport', async () => {
        let calls = 0;
        for (const apiKeys of [['key-a', 'key-b', 'key-b'], ['key-a', ' key-a ']]) {
            await assert.rejects(
                requestLlmJson(
                    'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
                    { Authorization: 'Bearer key-a' },
                    {
                        apiKeys,
                        transportRequestFn: async () => { calls += 1; }
                    }
                ),
                error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
                    && error.retryable === false
            );
        }
        assert.strictEqual(calls, 0);
    });

    it('replays on the fallback and keeps it sticky across logical requests', async () => {
        const { file } = tempState();
        const seen = [];
        const transportRequestFn = async (url, _body, headers) => {
            seen.push({
                url,
                authorization: headers.Authorization,
                session: headers['x-opencode-session'],
                userAgent: headers['User-Agent']
            });
            if (headers.Authorization === 'Bearer key-a') {
                return {
                    statusCode: 429,
                    headers: { 'retry-after': '1800' },
                    body: {
                    type: 'GoUsageLimitError',
                    message: '5-hour usage limit reached. Resets in 30min.',
                    metadata: { limitName: '5-hour rolling' }
                    },
                    raw: '{}'
                };
            }
            return { statusCode: 200, headers: {}, body: { status: 'completed', output_text: 'ok' }, raw: '{}' };
        };
        const apiUrl = 'https://opencode.ai/zen/go/v1/chat/completions';
        const options = {
            timeoutMs: 5000,
            apiKeys: ['key-a', 'key-b'],
            accountPoolStateFile: file,
            transportRequestFn
        };
        const first = await requestLlmJson(
            apiUrl, ENDPOINT, 'test-model', { input: 'hi' },
            { Authorization: 'Bearer must-be-replaced', 'Content-Type': 'application/json' }, options
        );
        assert.strictEqual(first.statusCode, 200);
        const second = await requestLlmJson(
            apiUrl, ENDPOINT, 'test-model', { input: 'again' },
            { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' }, options
        );
        assert.strictEqual(second.statusCode, 200);
        assert.deepStrictEqual(seen.map(item => item.authorization), [
            'Bearer key-a', 'Bearer key-b', 'Bearer key-b'
        ]);
        assert.ok(seen.every(item => item.url === apiUrl));
        assert.ok(seen.every(item => item.session && item.session === seen[0].session));
        assert.ok(seen.every(item => item.userAgent === 'audio-paper-digest/1.0'));
    });

    it('does not rotate a generic 429', async () => {
        const { file } = tempState();
        const seen = [];
        const response = await requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', { input: 'hi' },
            { Authorization: 'Bearer key-a' },
            {
                timeoutMs: 5000,
                apiKeys: ['key-a', 'key-b'],
                accountPoolStateFile: file,
                transportRequestFn: async (_url, _body, headers) => {
                    seen.push(headers.Authorization);
                    return { statusCode: 429, headers: {}, body: { error: { type: 'rate_limit_error' } }, raw: '{}' };
                }
            }
        );
        assert.strictEqual(response.statusCode, 429);
        assert.deepStrictEqual(seen, ['Bearer key-a']);
    });

    it('stops without an infinite loop when both accounts are quota exhausted', async () => {
        const { file } = tempState();
        let calls = 0;
        await assert.rejects(
            requestLlmJson(
                'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', { input: 'hi' },
                { Authorization: 'Bearer key-a' },
                {
                    timeoutMs: 5000,
                    apiKeys: ['key-a', 'key-b'],
                    accountPoolStateFile: file,
                    transportRequestFn: async () => {
                        calls += 1;
                        return {
                            statusCode: 429,
                            headers: { 'retry-after': '3600' },
                            body: { type: 'GoUsageLimitError', metadata: { limitName: '5-hour rolling' } },
                            raw: '{}'
                        };
                    }
                }
            ),
            error => error.code === 'LLM_ACCOUNT_POOL_EXHAUSTED' && error.retryable === false
        );
        assert.strictEqual(calls, 2);
    });

    it('tries each account at most once even when an earlier quota block expires mid-request', async () => {
        const { file } = tempState();
        const realNow = Date.now;
        let nowMs = 100000;
        Date.now = () => nowMs;
        const seen = [];
        try {
            await assert.rejects(
                requestLlmJson(
                    'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
                    { Authorization: 'Bearer key-a' },
                    {
                        timeoutMs: 10000,
                        apiKeys: ['key-a', 'key-b'],
                        accountPoolStateFile: file,
                        transportRequestFn: async (_url, _body, headers) => {
                            seen.push(headers.Authorization);
                            if (headers.Authorization === 'Bearer key-b') nowMs += 1500;
                            return {
                                statusCode: 429,
                                headers: { 'retry-after-ms': '1' },
                                body: { type: 'GoUsageLimitError' },
                                raw: '{}'
                            };
                        }
                    }
                ),
                error => error.code === 'LLM_ACCOUNT_POOL_EXHAUSTED'
                    && error.retryable === false
            );
        } finally {
            Date.now = realNow;
        }
        assert.deepStrictEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    });

    it('gives the fallback only the remaining logical-request deadline', async () => {
        const { file } = tempState();
        const realNow = Date.now;
        let nowMs = 100000;
        Date.now = () => nowMs;
        const timeouts = [];
        try {
            const response = await requestLlmJson(
                'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
                { Authorization: 'Bearer key-a' },
                {
                    timeoutMs: 5000,
                    apiKeys: ['key-a', 'key-b'],
                    accountPoolStateFile: file,
                    transportRequestFn: async (_url, _body, headers, options) => {
                        timeouts.push(options.timeoutMs);
                        if (headers.Authorization === 'Bearer key-a') {
                            nowMs += 1200;
                            return {
                                statusCode: 429,
                                headers: { 'retry-after': '3600' },
                                body: { type: 'GoUsageLimitError' },
                                raw: '{}'
                            };
                        }
                        return { statusCode: 200, headers: {}, body: { output_text: 'ok' }, raw: '{}' };
                    }
                }
            );
            assert.strictEqual(response.statusCode, 200);
        } finally {
            Date.now = realNow;
        }
        assert.deepStrictEqual(timeouts, [5000, 3800]);
    });

    it('rejects endpoint/apiUrl identity drift before invoking transport', async () => {
        let calls = 0;
        await assert.rejects(
            requestLlmJson(
                'https://evil.example/v1/responses', ENDPOINT, 'test-model', {},
                { Authorization: 'Bearer key-a' },
                {
                    apiKeys: ['key-a', 'key-b'],
                    transportRequestFn: async () => { calls += 1; }
                }
            ),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
        assert.strictEqual(calls, 0);

        await assert.rejects(
            requestLlmJson(
                'https://evil.example/v1/responses', ENDPOINT, 'test-model', {},
                { Authorization: 'Bearer key-a' },
                {
                    apiKeys: ['key-a'],
                    transportRequestFn: async () => { calls += 1; }
                }
            ),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
        assert.strictEqual(calls, 0);
    });

    it('concurrent primary quota responses converge once on the same fallback', async () => {
        const { file } = tempState();
        const seen = [];
        const transportRequestFn = async (_url, _body, headers) => {
            seen.push(headers.Authorization);
            if (headers.Authorization === 'Bearer key-a') {
                await new Promise(resolve => setImmediate(resolve));
                return {
                    statusCode: 429,
                    headers: { 'retry-after': '3600' },
                    body: { type: 'GoUsageLimitError', metadata: { limitName: '5-hour rolling' } },
                    raw: '{}'
                };
            }
            return { statusCode: 200, headers: {}, body: { output_text: 'ok' }, raw: '{}' };
        };
        const options = {
            timeoutMs: 5000,
            apiKeys: ['key-a', 'key-b'],
            accountPoolStateFile: file,
            transportRequestFn
        };
        const results = await Promise.all(Array.from({ length: 5 }, () => requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
            { Authorization: 'Bearer key-a' }, options
        )));
        assert.ok(results.every(response => response.statusCode === 200));
        assert.strictEqual(seen.filter(value => value === 'Bearer key-a').length, 5);
        assert.strictEqual(seen.filter(value => value === 'Bearer key-b').length, 5);
        assert.strictEqual(selectApiKey(['key-a', 'key-b'], ENDPOINT, file).apiKey, 'key-b');
    });
});
