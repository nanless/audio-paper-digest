const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
    LlmAccountPoolExhaustedError,
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
const PYTHON_BIN = process.env.PD_PYTHON_BIN || 'python3';
// 交叉运行时用例需要真实的 Python 解释器；缺失时跳过而不是硬失败。
const HAS_PYTHON = spawnSync(PYTHON_BIN, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
const STALE_GROUP_MS = 7 * 24 * 60 * 60 * 1000;

function tempState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-llm-pool-'));
    return { dir, file: path.join(dir, 'llm-account-pool.json') };
}

// 等权轮转的权威顺序：账号 ID 的稳定排序，与配置里的 key 顺序无关。
function orderedAccountIds(keys) {
    return [...getPoolIdentity(keys, ENDPOINT).accountIds].sort();
}

function expectedKeyOrder(keys) {
    const byId = new Map(keys.map(key => [getAccountId(key), key]));
    return orderedAccountIds(keys).map(accountId => byId.get(accountId));
}

function selectionFor(keys, apiKey) {
    return { apiKey, accountId: getAccountId(apiKey), ...getPoolIdentity(keys, ENDPOINT) };
}

function quotaTypeShapeVectors() {
    const rows = [];
    const fields = ['type', 'code', 'error.type', 'error.code', 'error.error.type', 'error.error.code'];
    const values = ['GoUsageLimitError', ['GoUsageLimitError'], [['GoUsageLimitError']],
        { type: 'GoUsageLimitError' }, true, false, 429, null, [], 'gousagelimiterror'];
    for (const field of fields) for (const value of values) {
        const body = {}, parts = field.split('.'); let target = body;
        for (const part of parts.slice(0, -1)) target = target[part] = {};
        target[parts.at(-1)] = value;
        rows.push({ statusCode: 429, body, expected: value === 'GoUsageLimitError' ? 'GoUsageLimitError' : null });
    }
    for (const body of [{ error: [{ type: 'GoUsageLimitError' }] },
        { error: { error: [{ code: 'GoUsageLimitError' }] } },
        { type: 'rate_limit_error' }, { message: 'GoUsageLimitError' }]) {
        rows.push({ statusCode: 429, body, expected: null });
    }
    rows.push({ statusCode: 500, body: { type: 'GoUsageLimitError' }, expected: null });
    rows.push({ statusCode: 401, body: { message: 'Invalid API key' }, expected: null });
    rows.push({ statusCode: 401, body: { error: { message: 'Insufficient balance' } }, expected: 'InsufficientBalanceError' });
    return rows;
}

function quotaMetadataShapeVectors() {
    const rows = [], wrong = [[], ['weekly'], 'weekly', true, false, 7, 0, null];
    const row = (body, limitClass, blockedUntilMs, headers = {}) => rows.push({ statusCode: 429,
        body, headers, expected: { type: 'GoUsageLimitError', limitClass, blockedUntilMs } });
    for (const metadata of wrong) {
        row({ type: 'GoUsageLimitError', metadata, error: { metadata: { limitName: 'weekly' } } }, 'weekly', 604801000);
        row({ type: 'GoUsageLimitError', metadata, error: { metadata,
            error: { metadata: { limitName: 'monthly' } } } }, 'monthly', 2678401000);
        row({ type: 'GoUsageLimitError', metadata, error: { metadata } }, 'unknown', 1801000);
    }
    row({ type: 'GoUsageLimitError', metadata: {}, error: { metadata: { limitName: 'weekly' } } }, 'unknown', 1801000);
    row({ type: 'GoUsageLimitError', metadata: { limitName: '5-hour rolling' },
        error: { metadata: { limitName: 'weekly' } } }, 'rolling_5h', 18001000);
    row({ type: 'GoUsageLimitError', metadata: [], error: { metadata: { limitName: 'weekly' } },
        message: 'Resets in 2 minutes' }, 'weekly', 3601000, { 'retry-after': '3600' });
    row({ type: 'GoUsageLimitError', metadata: 'bad', error: { metadata: { limitName: 'weekly' } } },
        'weekly', 31968001000, { 'retry-after': '999999999999' });
    rows.push({ statusCode: 429, body: { type: ['GoUsageLimitError'], metadata: { limitName: 'weekly' } },
        headers: {}, expected: null });
    return rows;
}

function pythonQuotaClassifications(rows) {
    const script = [
        'import json,sys',
        `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
        'from llm_account_pool import classify_opencode_go_quota_response',
        'rows=json.load(sys.stdin)',
        `values=[classify_opencode_go_quota_response(r['statusCode'],r.get('headers',{}),r['body'],endpoint=${JSON.stringify(ENDPOINT)},now_ms=1000) for r in rows]`,
        "print(json.dumps([None if q is None else {'type':q['type'],'limitClass':q['limit_class'],'blockedUntilMs':q['blocked_until_ms']} for q in values]))"
    ].join('\n');
    const result = spawnSync(PYTHON_BIN, ['-c', script], { input: JSON.stringify(rows), encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

function quotaClassification(row) {
    const quota = classifyOpenCodeGoQuotaResponse(row, { endpoint: ENDPOINT, nowMs: 1000 });
    return quota && { type: quota.type, limitClass: quota.limitClass, blockedUntilMs: quota.blockedUntilMs };
}

function readGroup(file, keys) {
    const identity = getPoolIdentity(keys, ENDPOINT);
    return readStateStrict(file).services[identity.serviceId].groups[identity.groupId];
}

function writeLegacyState(file, keys, activeAccountId) {
    const identity = getPoolIdentity(keys, ENDPOINT);
    fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        policyVersion: POLICY_VERSION,
        generation: 3,
        services: {
            [identity.serviceId]: {
                endpoint: identity.service,
                accounts: {},
                groups: {
                    [identity.groupId]: {
                        activeAccountId,
                        switchedAt: new Date(1000).toISOString()
                    }
                }
            }
        }
    }, null, 2), { mode: 0o600 });
    return identity;
}

// 只写入一个“最后使用时间”已过期的旧分组，用于验证成员集合变化后的清理。
function writeStaleGroupState(file, keys) {
    const identity = getPoolIdentity(keys, ENDPOINT);
    fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        policyVersion: POLICY_VERSION,
        generation: 1,
        services: {
            [identity.serviceId]: {
                endpoint: identity.service,
                accounts: {},
                groups: {
                    [identity.groupId]: {
                        activeAccountId: null,
                        switchedAt: new Date(1000).toISOString()
                    }
                }
            }
        }
    }, null, 2), { mode: 0o600 });
    return identity;
}

describe('OpenCode Go 账号池的等权轮转状态', () => {
    it('三个账号按账号 ID 的稳定顺序依次轮转', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const picks = [];
        for (let index = 0; index < 7; index += 1) {
            picks.push(selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 + index }).apiKey);
        }
        assert.deepStrictEqual(picks, [
            expected[0], expected[1], expected[2],
            expected[0], expected[1], expected[2], expected[0]
        ]);
        const group = readGroup(file, keys);
        assert.strictEqual(group.activeAccountId, getAccountId(expected[0]));
        assert.strictEqual(group.rotationCursor, 1);
        assert.strictEqual(group.lastSelectedAtMs, 1006);
        assert.strictEqual(readStateStrict(file).policyVersion, POLICY_VERSION);
        // activeAccountId 只作可观测字段：下一次仍按游标继续，而不是一直用它。
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }).apiKey, expected[1]);
    });

    it('key 列表顺序打乱后选择序列等价，主账号不再优先', () => {
        const permutations = [
            ['key-a', 'key-b', 'key-c'],
            ['key-c', 'key-b', 'key-a'],
            ['key-b', 'key-a', 'key-c']
        ];
        const expected = orderedAccountIds(permutations[0]);
        const sequences = permutations.map(keys => {
            const { file } = tempState();
            return Array.from({ length: 6 }, (unused, index) => (
                selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 + index }).accountId
            ));
        });
        for (const sequence of sequences) {
            assert.deepStrictEqual(sequence, [
                expected[0], expected[1], expected[2],
                expected[0], expected[1], expected[2]
            ]);
        }
        // 主账号/备用账号配置顺序不同（甚至反序）也得到同一账号集合与序列。
        const primary = resolvePrimaryApiKeyPool('key-a', 'key-b', 'key-c');
        const reversed = resolveApiKeyPool('key-c', 'key-a,key-b');
        const first = tempState();
        const second = tempState();
        assert.strictEqual(
            selectApiKey(primary, ENDPOINT, first.file, { nowMs: 1000 }).accountId,
            selectApiKey(reversed, ENDPOINT, second.file, { nowMs: 1000 }).accountId
        );
        assert.deepStrictEqual(
            expectedKeyOrder(reversed),
            expectedKeyOrder(primary)
        );
    });

    it('冷却中的账号被跳过，冷却到期后重新回到轮转', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        assert.strictEqual(first.apiKey, expected[0]);
        markQuotaExhausted(first, { blockedUntilMs: 5000 }, file, { nowMs: 1000 });

        const duringCooldown = [];
        for (const nowMs of [1001, 1002, 1003, 1004]) {
            duringCooldown.push(selectApiKey(keys, ENDPOINT, file, { nowMs }).apiKey);
        }
        assert.deepStrictEqual(duringCooldown, [
            expected[1], expected[2], expected[1], expected[2]
        ]);

        const resumed = selectApiKey(keys, ENDPOINT, file, { nowMs: 5000 });
        assert.strictEqual(resumed.apiKey, expected[0]);
        const identity = getPoolIdentity(keys, ENDPOINT);
        const record = readStateStrict(file).services[identity.serviceId].accounts[getAccountId(expected[0])];
        assert.strictEqual(record.status, 'eligible_after_reset');
    });

    it('同一逻辑请求内 exclude 后每个账号最多尝试一次', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const attempted = [];
        const excludeAccountIds = [];
        for (let index = 0; index < keys.length; index += 1) {
            const selection = selectApiKey(keys, ENDPOINT, file, {
                nowMs: 1000 + index,
                excludeAccountIds
            });
            excludeAccountIds.push(selection.accountId);
            attempted.push(selection.apiKey);
            markQuotaExhausted(selection, { blockedUntilMs: 9000 }, file, { nowMs: 1000 + index });
        }
        assert.deepStrictEqual(attempted, expected);
        assert.throws(() => selectApiKey(keys, ENDPOINT, file, {
            nowMs: 1005,
            excludeAccountIds
        }), error => error instanceof LlmAccountPoolExhaustedError
            && error.code === 'LLM_ACCOUNT_POOL_EXHAUSTED');
    });

    it('账号都没冷却但全部被本请求排除时，立即报耗尽且不写阻塞记录', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const ordered = orderedAccountIds(keys);
        const { file } = tempState();
        assert.throws(() => selectApiKey(keys, ENDPOINT, file, {
            nowMs: 1000,
            excludeAccountIds: ordered
        }), error => {
            assert.ok(error instanceof LlmAccountPoolExhaustedError);
            assert.strictEqual(error.code, 'LLM_ACCOUNT_POOL_EXHAUSTED');
            assert.strictEqual(error.earliestRetryAtMs, null);
            assert.strictEqual(error.blockedAccountCount, 0);
            assert.match(error.message, /没有可用账号/);
            // 错误措辞必须写清“本次请求已排除 / 下次请求从游标继续”。
            assert.match(error.message, /下一逻辑请求会从轮转游标继续/);
            return true;
        });
        const identity = getPoolIdentity(keys, ENDPOINT);
        const service = readStateStrict(file).services[identity.serviceId];
        assert.deepStrictEqual(service?.accounts ?? {}, {});
    });

    it('全部账号冷却时报耗尽错误并保留最早恢复时间', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const blockedUntilValues = [6000, 4000, 8000];
        const { file } = tempState();
        for (let index = 0; index < keys.length; index += 1) {
            markQuotaExhausted(selectionFor(keys, expected[index]), {
                blockedUntilMs: blockedUntilValues[index]
            }, file, { nowMs: 1000 });
        }
        assert.throws(() => selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }), error => {
            assert.ok(error instanceof LlmAccountPoolExhaustedError);
            assert.strictEqual(error.code, 'LLM_ACCOUNT_POOL_EXHAUSTED');
            assert.strictEqual(error.scope, 'run');
            assert.strictEqual(error.category, 'quota_exhausted');
            assert.strictEqual(error.retryable, false);
            assert.strictEqual(error.earliestRetryAtMs, 4000);
            assert.strictEqual(error.blockedAccountCount, 3);
            assert.ok(error.message.includes(new Date(4000).toISOString()));
            return true;
        });
        // 最早恢复时间一过，该账号重新加入轮转。
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 4001 }).apiKey, expected[1]);
    });

    it('旧状态只有 activeAccountId 时按其排序位置推导游标', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const ordered = orderedAccountIds(keys);
        const { file } = tempState();
        writeLegacyState(file, keys, ordered[1]);

        const legacyState = readStateStrict(file);
        assert.strictEqual(legacyState.policyVersion, POLICY_VERSION);
        assert.strictEqual(legacyState.generation, 3);

        // 升级后的首次选择与旧 active 连续，随后自然进入等权轮转。
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }).apiKey, expected[1]);
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2001 }).apiKey, expected[2]);
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2002 }).apiKey, expected[0]);
        const group = readGroup(file, keys);
        assert.strictEqual(group.activeAccountId, getAccountId(expected[0]));
        assert.strictEqual(group.rotationCursor, 1);
    });

    it('旧状态的 active 账号仍在冷却时按轮转跳过它', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const ordered = orderedAccountIds(keys);
        const { file } = tempState();
        writeLegacyState(file, keys, ordered[0]);
        markQuotaExhausted(selectionFor(keys, expected[0]), { blockedUntilMs: 5000 }, file, { nowMs: 1000 });
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }).apiKey, expected[1]);
    });

    it('旧状态里的 activeAccountId 不在当前账号集合时从头开始轮转', () => {
        const keys = ['key-alpha', 'key-beta'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        writeLegacyState(file, keys, 'f'.repeat(64));
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 }).apiKey, expected[0]);
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 1001 }).apiKey, expected[1]);
    });

    it('追加账号后新分组从稳定顺序的第一个账号重新轮转', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const { file } = tempState();
        selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        selectApiKey(keys, ENDPOINT, file, { nowMs: 1001 });
        const appended = [...keys, 'key-delta'];
        const expectedAppended = expectedKeyOrder(appended);
        // 追加账号建立新分组，不再继承旧分组的 active/cursor；新分组 cursor=0。
        assert.strictEqual(
            selectApiKey(appended, ENDPOINT, file, { nowMs: 1002 }).apiKey,
            expectedAppended[0]
        );
        assert.strictEqual(
            selectApiKey(appended, ENDPOINT, file, { nowMs: 1003 }).apiKey,
            expectedAppended[1]
        );
        const identity = getPoolIdentity(keys, ENDPOINT);
        const appendedIdentity = getPoolIdentity(appended, ENDPOINT);
        const state = readStateStrict(file);
        assert.ok(state.services[identity.serviceId].groups[identity.groupId]);
        assert.ok(state.services[identity.serviceId].groups[appendedIdentity.groupId]);
    });

    it('同一账号集合的不同排列共享同一轮转游标', () => {
        const primary = resolvePrimaryApiKeyPool('a-secret', 'b-secret,c-secret,d-secret');
        const ordered = expectedKeyOrder(primary);
        const orderedIds = orderedAccountIds(primary);
        const { file } = tempState();
        const chosen = selectApiKey(primary, ENDPOINT, file, {
            nowMs: 1000,
            excludeAccountIds: orderedIds.slice(0, 3)
        });
        assert.strictEqual(chosen.accountId, getAccountId(ordered[3]));
        // 不排除时继续轮转回序号 0，而不是粘住刚选中的第四个账号。
        assert.strictEqual(selectApiKey(primary, ENDPOINT, file, { nowMs: 2000 }).apiKey, ordered[0]);
        // key 列表打乱后仍沿用同一个共享游标。
        const shuffled = [primary[2], primary[0], primary[3], primary[1]];
        assert.strictEqual(selectApiKey(shuffled, ENDPOINT, file, { nowMs: 3000 }).apiKey, ordered[1]);

        const identity = getPoolIdentity(primary, ENDPOINT);
        const state = readStateStrict(file);
        assert.deepStrictEqual(state.services[identity.serviceId].accounts, {});
        for (const key of primary) assert.ok(!fs.readFileSync(file, 'utf8').includes(key));
    });

    it('追加账号并超过保留期后清理旧分组，新分组从 cursor 0 开始', () => {
        const keys = ['key-alpha', 'key-beta'];
        const { file } = tempState();
        const identity = writeStaleGroupState(file, keys);
        const appended = [...keys, 'key-gamma'];
        const expectedAppended = expectedKeyOrder(appended);
        const nowMs = 1000 + STALE_GROUP_MS + 1;
        // 旧分组已超过 STALE_GROUP_MS 未被选择：先清理，再为新成员集合建 cursor=0 的组。
        assert.strictEqual(
            selectApiKey(appended, ENDPOINT, file, { nowMs }).apiKey,
            expectedAppended[0]
        );
        const state = readStateStrict(file);
        const groups = state.services[identity.serviceId].groups;
        assert.ok(!(identity.groupId in groups), '已停用的旧分组应被清理');
        const appendedIdentity = getPoolIdentity(appended, ENDPOINT);
        assert.strictEqual(groups[appendedIdentity.groupId].rotationCursor, 1);
        assert.strictEqual(groups[appendedIdentity.groupId].lastSelectedAtMs, nowMs);
    });

    it('移除账号并超过保留期后同样清理旧分组', () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const { file } = tempState();
        const identity = writeStaleGroupState(file, keys);
        const reduced = keys.slice(0, 2);
        const expectedReduced = expectedKeyOrder(reduced);
        assert.strictEqual(
            selectApiKey(reduced, ENDPOINT, file, { nowMs: 1000 + STALE_GROUP_MS + 1 }).apiKey,
            expectedReduced[0]
        );
        const groups = readStateStrict(file).services[identity.serviceId].groups;
        assert.ok(!(identity.groupId in groups), '已停用的旧分组应被清理');
        assert.ok(getPoolIdentity(reduced, ENDPOINT).groupId in groups);
    });

    it('仍在并行使用的其他 key 集合分组不会被清理', () => {
        const first = ['key-alpha', 'key-beta'];
        const second = ['key-alpha', 'key-gamma'];
        const { file } = tempState();
        selectApiKey(first, ENDPOINT, file, { nowMs: 1000 });
        selectApiKey(second, ENDPOINT, file, { nowMs: 2000 });
        const identity = getPoolIdentity(first, ENDPOINT);
        const groups = readStateStrict(file).services[identity.serviceId].groups;
        assert.ok(identity.groupId in groups);
        assert.ok(getPoolIdentity(second, ENDPOINT).groupId in groups);
    });

    it('多进程并发选择仍按等权轮转分摊到每个账号', async () => {
        const keys = ['key-alpha', 'key-beta', 'key-gamma'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const modulePath = path.join(__dirname, '..', 'scripts', 'llm-account-pool.js');
        const program = [
            'const p = require(process.argv[1]);',
            `const s = p.selectApiKey(${JSON.stringify(keys)}, process.argv[2], process.argv[3], { nowMs: 1000 });`,
            'process.stdout.write(s.apiKey);'
        ].join('\n');
        const runChild = () => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', program, modulePath, ENDPOINT, file], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) resolve(stdout);
                else reject(new Error(stderr || `子进程退出码 ${code}`));
            });
        });
        // 6 个子进程各选择一次：文件锁串行化后正好是两圈完整轮转。
        const picks = await Promise.all(Array.from({ length: 6 }, runChild));
        assert.strictEqual(new Set(picks).size, keys.length);
        assert.deepStrictEqual(
            [...picks].sort(),
            [...expected, ...expected].sort()
        );
        assert.strictEqual(readGroup(file, keys).rotationCursor, 0);
    });

    it('新增的可选轮转字段通过严格校验，非法值被拒绝', () => {
        const keys = ['a', 'b'];
        const identity = getPoolIdentity(keys, ENDPOINT);
        const buildState = group => JSON.stringify({
            schemaVersion: 1,
            policyVersion: POLICY_VERSION,
            generation: 1,
            services: {
                [identity.serviceId]: {
                    endpoint: identity.service,
                    accounts: {},
                    groups: { [identity.groupId]: group }
                }
            }
        });
        const { dir, file } = tempState();
        fs.writeFileSync(file, buildState({
            activeAccountId: null,
            rotationCursor: 1,
            lastSelectedAtMs: 1234
        }), { mode: 0o600 });
        assert.strictEqual(readStateStrict(file).generation, 1);

        const invalidGroups = [
            { rotationCursor: -1 },
            { rotationCursor: 1.5 },
            { rotationCursor: '1' },
            { lastSelectedAtMs: -1 },
            { lastSelectedAtMs: 'yesterday' }
        ];
        invalidGroups.forEach((group, index) => {
            const invalidFile = path.join(dir, `invalid-group-${index}.json`);
            fs.writeFileSync(invalidFile, buildState({ activeAccountId: null, ...group }), { mode: 0o600 });
            assert.throws(
                () => readStateStrict(invalidFile),
                error => error instanceof LlmAccountPoolStateError
                    && error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
        });
    });

    it('只有官方 Go 的精确 401 才算余额不足，普通失败一律不算', () => {
        const body = { error: { message: 'Insufficient balance' } };
        assert.strictEqual(classifyOpenCodeGoQuotaResponse({ statusCode: 401, body }, { endpoint: ENDPOINT }).type,
            'InsufficientBalanceError');
        assert.strictEqual(classifyOpenCodeGoQuotaResponse({ statusCode: 401, body: 'Insufficient balance' },
            { endpoint: ENDPOINT }).type, 'InsufficientBalanceError');
        const billingMessage = 'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_test_placeholder/billing';
        assert.strictEqual(classifyOpenCodeGoQuotaResponse({ statusCode: 401, body: { error: { message: billingMessage } } },
            { endpoint: ENDPOINT }).type, 'InsufficientBalanceError');
        for (const message of [billingMessage + '?redirect=1', billingMessage + ' extra',
            billingMessage.replace('opencode.ai/', 'opencode.ai.evil.example/'),
            billingMessage.replace('https:', 'http:'), 'prefix ' + billingMessage]) {
            assert.strictEqual(classifyOpenCodeGoQuotaResponse({ statusCode: 401, body: { message } },
                { endpoint: ENDPOINT }), null);
        }
        for (const response of [
            { statusCode: 401, body: { error: { message: 'Invalid API key' } } },
            { statusCode: 401, body: { message: 'not Insufficient balance' } },
            { statusCode: 429, body }, { statusCode: 500, body }
        ]) assert.strictEqual(classifyOpenCodeGoQuotaResponse(response, { endpoint: ENDPOINT }), null);
        assert.strictEqual(classifyOpenCodeGoQuotaResponse({ statusCode: 401, body },
            { endpoint: 'https://example.com/v1' }), null);
    });
    it('逻辑 LLM 截止时间拒绝永不落定的传输 Promise', async () => {
        const startedAt = Date.now();
        await assert.rejects(
            requestLlmJson(
                'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
                { Authorization: 'Bearer test-key' },
                {
                    timeoutMs: 30,
                    apiKeys: ['test-key'],
                    transportRequestFn: async () => new Promise(() => {})
                }
            ),
            error => error.code === 'REQUEST_DEADLINE_EXCEEDED'
        );
        assert.ok(Date.now() - startedAt < 1000, '传输请求一直不结束时，仍须按本次请求的截止时间停止等待');
    });

    it('拒绝重复的主账号与备用账号凭证', () => {
        assert.throws(
            () => resolveApiKeyPool('same-key', 'same-key'),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
    });

    it('普通备用账号之后仍保留显式配置的第三个账号', () => {
        assert.deepEqual(
            resolvePrimaryApiKeyPool('account-a', 'account-b', 'account-c'),
            ['account-a', 'account-b', 'account-c']
        );
        assert.throws(
            () => resolvePrimaryApiKeyPool('account-a', 'account-b', 'account-b'),
            error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
        );
    });

    it('拒绝带凭证或被改写查询串的 OpenCode 端点', () => {
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

    it('WHATWG 归一化之前就拒绝原始或解码后的点段，以及编码过的路由分隔符', () => {
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

    it('账号被额度阻塞后按轮转使用下一个账号，冷却到期再回到轮转', () => {
        const keys = resolveApiKeyPool('account-a-secret', 'account-b-secret');
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        assert.strictEqual(first.apiKey, expected[0]);

        markQuotaExhausted(first, {
            limitName: '5-hour rolling',
            blockedUntilMs: 2000
        }, file, { nowMs: 1000 });
        const second = selectApiKey(keys, ENDPOINT, file, { nowMs: 1100 });
        assert.strictEqual(second.apiKey, expected[1]);

        // A 冷却到期后重新加入轮转，而不是固定粘住 B。
        const recovered = selectApiKey(keys, ENDPOINT, file, { nowMs: 3000 });
        assert.strictEqual(recovered.apiKey, expected[0]);
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes('account-a-secret'));
        assert.ok(!raw.includes('account-b-secret'));
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        assert.strictEqual(readStateStrict(file).policyVersion, POLICY_VERSION);
    });

    it('账号冷却期间按稳定顺序在两个可用账号之间轮转', () => {
        const keys = resolvePrimaryApiKeyPool('account-a-secret', 'account-b-secret', 'account-c-secret');
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const first = selectApiKey(keys, ENDPOINT, file, { nowMs: 1000 });
        assert.strictEqual(first.apiKey, expected[0]);
        markQuotaExhausted(first, { limitName: 'quota', blockedUntilMs: 9000 }, file, { nowMs: 1000 });
        const picks = [];
        for (const nowMs of [1100, 1200, 1300, 1400]) {
            picks.push(selectApiKey(keys, ENDPOINT, file, { nowMs }).apiKey);
        }
        assert.deepStrictEqual(picks, [
            expected[1], expected[2], expected[1], expected[2]
        ]);
    });

    it('只有明确的 GoUsageLimitError 才算额度耗尽', () => {
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

    it('JSON 类型向量只接受六条已登记路径的精确字符串，不强转数组或对象', () => {
        for (const row of quotaTypeShapeVectors()) {
            const quota = classifyOpenCodeGoQuotaResponse(row, { endpoint: ENDPOINT, nowMs: 1000 });
            assert.strictEqual(quota?.type ?? null, row.expected, JSON.stringify(row));
        }
    });

    it('JSON 类型向量与实际 Python classifier 保持相同分类', { skip: !HAS_PYTHON }, () => {
        const rows = quotaTypeShapeVectors();
        const python = pythonQuotaClassifications(rows);
        rows.forEach((row, index) => {
            assert.deepStrictEqual(quotaClassification(row), python[index], JSON.stringify(row));
            assert.strictEqual(python[index]?.type ?? null, row.expected);
        });
    });

    it('JSON metadata非对象不遮蔽后续合法对象，保留首对象和冷却上限', () => {
        for (const row of quotaMetadataShapeVectors()) {
            assert.deepStrictEqual(quotaClassification(row), row.expected, JSON.stringify(row));
        }
    });

    it('JSON metadata回退及冷却向量与实际Python一致', { skip: !HAS_PYTHON }, () => {
        const rows = quotaMetadataShapeVectors(), python = pythonQuotaClassifications(rows);
        rows.forEach((row, index) => {
            assert.deepStrictEqual(python[index], row.expected, JSON.stringify(row));
            assert.deepStrictEqual(quotaClassification(row), python[index], JSON.stringify(row));
        });
    });

    it('用上每个有限的重置提示，取保守上限，并只截断一次', () => {
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

    it('返回或保存之前，先清洗供应商可控的额度标签', () => {
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

    it('拿不到状态锁时抛出带类型的可重试错误', () => {
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

    it('状态损坏时直接失败，不覆盖', () => {
        const { file } = tempState();
        fs.writeFileSync(file, '{broken', { mode: 0o600 });
        assert.throws(
            () => selectApiKey(['a', 'b'], ENDPOINT, file),
            /状态损坏或不可读/
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    });

    it('拒绝非法或溢出的 generation，不改写状态', () => {
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

    it('显式的 null blockedUntilMs 会被拒绝，不改写共享状态', () => {
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

    it('拒绝符号链接形式的状态文件', () => {
        const { dir, file } = tempState();
        const target = path.join(dir, 'target.json');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, file);
        assert.throws(
            () => selectApiKey(['a', 'b'], ENDPOINT, file),
            error => error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
        );
    });

    it('回收文件和属主是符号链接时，用带类型的状态错误直接失败', () => {
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

    it('检查期间其他进程删掉了锁回收目录时，重新尝试', () => {
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

    it('含同一凭证的账号组共享额度阻塞', () => {
        const { file } = tempState();
        const firstGroup = ['a', 'b'];
        const secondGroup = ['a', 'c'];
        markQuotaExhausted(selectionFor(firstGroup, 'a'), { blockedUntilMs: 100000 }, file, { nowMs: 1000 });
        assert.strictEqual(selectApiKey(secondGroup, ENDPOINT, file, { nowMs: 2000 }).apiKey, 'c');
        assert.ok(readStateStrict(file).generation >= 2);
        assert.ok(getAccountId('a') in Object.values(readStateStrict(file).services)[0].accounts);
    });

    it('Node 写入的账号阻塞状态可被 Python 发布端读取并遵守', { skip: !HAS_PYTHON }, () => {
        const { file } = tempState();
        markQuotaExhausted(selectionFor(['a', 'b'], 'a'), { blockedUntilMs: 100000 }, file, { nowMs: 1000 });
        const script = [
            'import sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import select_api_key',
            `print(select_api_key(['a','b'], ${JSON.stringify(ENDPOINT)}, sys.argv[1], now_ms=2000)['api_key'])`
        ].join('; ');
        const result = spawnSync(PYTHON_BIN, ['-c', script, file], {
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout.trim(), 'b');
        // Python 写回共享状态后，Node 仍能读取并遵守冷却记录。
        assert.strictEqual(selectApiKey(['a', 'b'], ENDPOINT, file, { nowMs: 3000 }).apiKey, 'b');
        assert.strictEqual(readStateStrict(file).policyVersion, POLICY_VERSION);
    });

    it('Node 可读取 Python 写入的等权轮转状态', { skip: !HAS_PYTHON }, () => {
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
        const { file } = tempState();
        const script = [
            'import sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import mark_quota_exhausted, select_api_key',
            `s = select_api_key(${JSON.stringify(keys)}, ${JSON.stringify(ENDPOINT)}, sys.argv[1], now_ms=1000)`,
            "mark_quota_exhausted(s, {'blocked_until_ms': 100000}, sys.argv[1], now_ms=1000)",
            "print(s['api_key'])"
        ].join('; ');
        const result = spawnSync(PYTHON_BIN, ['-c', script, file], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout.trim(), expected[0]);
        // Python 持久化的 rotationCursor 被 Node 继续使用，且跳过冷却中的账号。
        assert.strictEqual(readGroup(file, keys).rotationCursor, 1);
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }).apiKey, expected[1]);
    });

    it('Node 与 Python 共用追加后的账号集合与冷却状态', { skip: !HAS_PYTHON }, () => {
        const keys = ['a', 'b', 'c'];
        const { file } = tempState();
        markQuotaExhausted(selectionFor(keys, 'b'), { blockedUntilMs: 100000 }, file, { nowMs: 1000 });
        const nodePick = selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 });
        assert.notStrictEqual(nodePick.apiKey, 'b');
        const script = [
            'import sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import select_api_key',
            `print(select_api_key(['a','b','c','d'], ${JSON.stringify(ENDPOINT)}, sys.argv[1], now_ms=3000)['api_key'])`
        ].join('; ');
        const result = spawnSync(PYTHON_BIN, ['-c', script, file], {
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(['a', 'c', 'd'].includes(result.stdout.trim()));
        const appended = selectApiKey(['a', 'b', 'c', 'd'], ENDPOINT, file, { nowMs: 4000 });
        assert.notStrictEqual(appended.apiKey, 'b');
        assert.ok(['a', 'c', 'd'].includes(appended.apiKey));
    });
});

describe('requestLlmJson 的 OpenCode Go 故障切换', () => {
    it('畸形数组类型的普通429不切号或写冷却', async () => {
        const { file } = tempState();
        let calls = 0;
        const response = await requestLlmJson(`${ENDPOINT}/chat/completions`, ENDPOINT, 'test-model', {}, {}, {
            apiKeys: ['synthetic-a', 'synthetic-b'], accountPoolStateFile: file, recordUsage: false,
            transportRequestFn: async () => {
                calls += 1;
                return { statusCode: 429, body: { type: ['GoUsageLimitError'] } };
            }
        });
        assert.strictEqual(response.statusCode, 429);
        assert.strictEqual(calls, 1);
        const service = readStateStrict(file).services[getPoolIdentity(['synthetic-a', 'synthetic-b'], ENDPOINT).serviceId];
        assert.deepStrictEqual(service.accounts, {});
    });

    it('四次余额失败后以带类型的运行错误停止，不保存计费 URL', async () => {
        const { file } = tempState();
        const keys = ['a', 'b', 'c', 'd'];
        const expected = expectedKeyOrder(keys);
        const seen = [];
        await assert.rejects(requestLlmJson(`${ENDPOINT}/chat/completions`, ENDPOINT, 'test-model', {}, {}, {
            apiKeys: keys, accountPoolStateFile: file, timeoutMs: 5000, recordUsage: false,
            transportRequestFn: async (_url, _body, headers) => {
                seen.push(headers.Authorization);
                return { statusCode: 401, body: { error: { message:
                    'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_test_placeholder/billing' } } };
            }
        }), error => error.code === 'LLM_ACCOUNT_POOL_EXHAUSTED'
            && error.scope === 'run' && error.category === 'quota_exhausted' && error.retryable === false);
        assert.deepStrictEqual(seen, expected.map(key => `Bearer ${key}`));
        assert.ok(!fs.readFileSync(file, 'utf8').includes('wrk_test_placeholder'));
    });
    it('精确的余额 401 会从第三个复核到第四个；普通 401 直接停止，不轮换', async () => {
        for (const message of ['Insufficient balance',
            'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_test_placeholder/billing',
            'Invalid API key']) {
            const { file } = tempState();
            const keys = ['a', 'b', 'c', 'd'];
            const expected = expectedKeyOrder(keys);
            for (const nowMs of [1000, 1100]) {
                markQuotaExhausted(selectApiKey(keys, ENDPOINT, file, { nowMs }),
                    { blockedUntilMs: 2200 }, file, { nowMs });
            }
            const seen = [];
            const request = requestLlmJson(`${ENDPOINT}/chat/completions`, ENDPOINT, 'test-model', {}, {}, {
                apiKeys: keys, accountPoolStateFile: file, timeoutMs: 5000,
                transportRequestFn: async (_url, _body, headers) => {
                    seen.push(headers.Authorization);
                    return headers.Authorization === `Bearer ${expected[2]}`
                        ? { statusCode: 401, body: { error: { message } } }
                        : { statusCode: 200, body: {} };
                }
            });
            if (message !== 'Invalid API key') {
                assert.strictEqual((await request).statusCode, 200);
                assert.deepStrictEqual(seen, [`Bearer ${expected[2]}`, `Bearer ${expected[3]}`]);
            } else {
                await assert.rejects(request, error => error.code === 'LLM_ACCOUNT_AUTH_ERROR'
                    && error.category === 'authentication' && error.scope === 'run' && !error.retryable);
                assert.deepStrictEqual(seen, [`Bearer ${expected[2]}`]);
            }
        }
    });
    it('发请求之前就拒绝所有重复的配置凭证', async () => {
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

    it('额度失败切到可用账号后，下一次请求按等权轮转继续并避开冷却账号', async () => {
        const { file } = tempState();
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
        const seen = [];
        const transportRequestFn = async (url, _body, headers) => {
            seen.push({
                url,
                authorization: headers.Authorization,
                session: headers['x-opencode-session'],
                userAgent: headers['User-Agent']
            });
            if (headers.Authorization === `Bearer ${expected[0]}`) {
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
            apiKeys: keys,
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
            { Authorization: `Bearer ${expected[0]}`, 'Content-Type': 'application/json' }, options
        );
        assert.strictEqual(second.statusCode, 200);
        assert.deepStrictEqual(seen.map(item => item.authorization), [
            `Bearer ${expected[0]}`, `Bearer ${expected[1]}`, `Bearer ${expected[1]}`
        ]);
        assert.ok(seen.every(item => item.url === apiUrl));
        assert.ok(seen.every(item => item.session && item.session === seen[0].session));
        assert.ok(seen.every(item => item.userAgent === 'audio-paper-digest/1.0'));
    });

    it('普通 429 不轮换账号', async () => {
        const { file } = tempState();
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
        const seen = [];
        const response = await requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', { input: 'hi' },
            { Authorization: 'Bearer key-a' },
            {
                timeoutMs: 5000,
                apiKeys: keys,
                accountPoolStateFile: file,
                transportRequestFn: async (_url, _body, headers) => {
                    seen.push(headers.Authorization);
                    return { statusCode: 429, headers: {}, body: { error: { type: 'rate_limit_error' } }, raw: '{}' };
                }
            }
        );
        assert.strictEqual(response.statusCode, 429);
        assert.deepStrictEqual(seen, [`Bearer ${expected[0]}`]);
    });

    it('普通 429/5xx 不切换账号，但跨外层重试按等权轮转继续', async () => {
        const keys = ['key-a', 'key-b', 'key-c'];
        const expected = expectedKeyOrder(keys);
        for (const statusCode of [429, 500]) {
            const { file } = tempState();
            const seen = [];
            const options = {
                timeoutMs: 5000,
                apiKeys: keys,
                accountPoolStateFile: file,
                recordUsage: false,
                transportRequestFn: async (_url, _body, headers) => {
                    seen.push(headers.Authorization);
                    return {
                        statusCode,
                        headers: {},
                        body: statusCode === 429
                            ? { error: { type: 'rate_limit_error' } }
                            : { error: { message: 'boom' } },
                        raw: '{}'
                    };
                }
            };
            // 同一逻辑请求内只尝试一个账号；4 次外层重试跨请求继续轮转。
            for (let round = 0; round < 4; round += 1) {
                const response = await requestLlmJson(
                    'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model',
                    { input: `round-${round}` }, { Authorization: 'Bearer key-a' }, options
                );
                assert.strictEqual(response.statusCode, statusCode);
            }
            assert.deepStrictEqual(seen, [
                `Bearer ${expected[0]}`, `Bearer ${expected[1]}`,
                `Bearer ${expected[2]}`, `Bearer ${expected[0]}`
            ]);
            const identity = getPoolIdentity(keys, ENDPOINT);
            const service = readStateStrict(file).services[identity.serviceId];
            // 普通失败既不写冷却，也不被误判成配额耗尽。
            assert.deepStrictEqual(service.accounts, {});
            assert.strictEqual(service.groups[identity.groupId].rotationCursor, 1);
            assert.strictEqual(
                service.groups[identity.groupId].activeAccountId,
                getAccountId(expected[0])
            );
        }
    });

    it('单账号配置绕过账号池状态，不写冷却或轮转状态', async () => {
        const { file } = tempState();
        const seen = [];
        const response = await requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', { input: 'hi' },
            { Authorization: 'Bearer solo' },
            {
                apiKeys: ['solo-key'], accountPoolStateFile: file, timeoutMs: 5000, recordUsage: false,
                transportRequestFn: async (_url, _body, headers) => {
                    seen.push(headers.Authorization);
                    return { statusCode: 200, headers: {}, body: { output_text: 'ok' }, raw: '{}' };
                }
            }
        );
        assert.strictEqual(response.statusCode, 200);
        // 单账号路径直接使用调用方传入的凭据头，不经过账号池选择。
        assert.deepStrictEqual(seen, ['Bearer solo']);
        assert.ok(!fs.existsSync(file), '单账号成功请求不应创建账号池状态');

        // 明确额度失败：报“未配置后续账号”，仍然不写状态。
        await assert.rejects(requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
            { Authorization: 'Bearer solo' },
            {
                apiKeys: ['solo-key'], accountPoolStateFile: file, timeoutMs: 5000, recordUsage: false,
                transportRequestFn: async () => ({
                    statusCode: 401,
                    body: { error: { message: 'Insufficient balance' } }
                })
            }
        ), error => error.code === 'LLM_ACCOUNT_POOL_EXHAUSTED'
            && /未配置后续账号/.test(error.message));
        assert.ok(!fs.existsSync(file));

        // 普通认证 401 停止运行，同样不写状态。
        await assert.rejects(requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
            { Authorization: 'Bearer solo' },
            {
                apiKeys: ['solo-key'], accountPoolStateFile: file, timeoutMs: 5000, recordUsage: false,
                transportRequestFn: async () => ({
                    statusCode: 401,
                    body: { error: { message: 'Invalid API key' } }
                })
            }
        ), error => error.code === 'LLM_ACCOUNT_AUTH_ERROR');
        assert.ok(!fs.existsSync(file));
    });

    it('两个账号都额度耗尽时停止，不进入死循环', async () => {
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

    it('即使先前的额度阻塞在请求中途过期，每个账号也最多尝试一次', async () => {
        const { file } = tempState();
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
        const realNow = Date.now;
        let nowMs = 100000;
        Date.now = () => nowMs;
        const seen = [];
        try {
            await assert.rejects(
                requestLlmJson(
                    'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
                    { Authorization: `Bearer ${expected[0]}` },
                    {
                        timeoutMs: 10000,
                        apiKeys: keys,
                        accountPoolStateFile: file,
                        transportRequestFn: async (_url, _body, headers) => {
                            seen.push(headers.Authorization);
                            if (headers.Authorization === `Bearer ${expected[1]}`) nowMs += 1500;
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
        assert.deepStrictEqual(seen, [`Bearer ${expected[0]}`, `Bearer ${expected[1]}`]);
    });

    it('备用账号只拿到逻辑请求剩余的那段截止时间', async () => {
        const { file } = tempState();
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
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
                    apiKeys: keys,
                    accountPoolStateFile: file,
                    transportRequestFn: async (_url, _body, headers, options) => {
                        timeouts.push(options.timeoutMs);
                        if (headers.Authorization === `Bearer ${expected[0]}`) {
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

    it('请求地址与配置端点不一致时，在传输前拒绝', async () => {
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

    it('并发请求的额度失败只让每个逻辑请求各自切到下一个可用账号', async () => {
        const { file } = tempState();
        const keys = ['key-a', 'key-b'];
        const expected = expectedKeyOrder(keys);
        const seen = [];
        const transportRequestFn = async (_url, _body, headers) => {
            seen.push(headers.Authorization);
            if (headers.Authorization === `Bearer ${expected[0]}`) {
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
            apiKeys: keys,
            accountPoolStateFile: file,
            transportRequestFn
        };
        const results = await Promise.all(Array.from({ length: 5 }, () => requestLlmJson(
            'https://opencode.ai/zen/go/v1/chat/completions', ENDPOINT, 'test-model', {},
            { Authorization: 'Bearer key-a' }, options
        )));
        assert.ok(results.every(response => response.statusCode === 200));
        // 等权轮转下 5 个并发请求的首次选择是 a,b,a,b,a；3 个 a 失败后各切到 b。
        assert.strictEqual(seen.filter(value => value === `Bearer ${expected[0]}`).length, 3);
        assert.strictEqual(seen.filter(value => value === `Bearer ${expected[1]}`).length, 5);
        assert.strictEqual(selectApiKey(keys, ENDPOINT, file).apiKey, expected[1]);
    });
});
