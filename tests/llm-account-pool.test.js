const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
    LlmAccountPoolExhaustedError,
    LlmAccountPoolLockTimeoutError,
    LlmAccountPoolStateError,
    ACCOUNT_POOL_CONTRACT,
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

const { historicalContract, recordHeader } = require('../scripts/lib/protocol-codec');
const LEGACY_POOL_POLICY = historicalContract(ACCOUNT_POOL_CONTRACT, 'equal-rotation');

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
        policyVersion: LEGACY_POOL_POLICY,
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
        policyVersion: LEGACY_POOL_POLICY,
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
        assert.strictEqual(readStateStrict(file).contract, ACCOUNT_POOL_CONTRACT);
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
        assert.strictEqual(legacyState.policyVersion, LEGACY_POOL_POLICY);
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
            policyVersion: LEGACY_POOL_POLICY,
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
        assert.strictEqual(readStateStrict(file).contract, ACCOUNT_POOL_CONTRACT);
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
                policyVersion: LEGACY_POOL_POLICY,
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
            policyVersion: LEGACY_POOL_POLICY,
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
            policyVersion: LEGACY_POOL_POLICY,
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
        assert.strictEqual(readStateStrict(file).contract, ACCOUNT_POOL_CONTRACT);
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

test('旧账号池只读不改字节，正常选择后保留冷却、组身份和代数再写稳定格式', () => {
    const keys = ['migration-a', 'migration-b'];
    const { file } = tempState();
    const expected = expectedKeyOrder(keys);
    const identity = writeLegacyState(file, keys, getAccountId(expected[0]));
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    old.services[identity.serviceId].accounts[getAccountId(expected[0])] = {
        status: 'quota_blocked', blockedUntilMs: 9000, evidence: 'preserve-this-history'
    };
    fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
    const before = fs.readFileSync(file);
    assert.equal(readStateStrict(file).generation, 3);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(selectApiKey(keys, ENDPOINT, file, { nowMs: 2000 }).apiKey, expected[1]);
    const saved = readStateStrict(file);
    assert.equal(saved.contract, ACCOUNT_POOL_CONTRACT);
    assert.equal(saved.schemaFingerprint, recordHeader(ACCOUNT_POOL_CONTRACT, ACCOUNT_POOL_CONTRACT).schemaFingerprint);
    assert.equal('policyVersion' in saved, false);
    assert.equal('schemaVersion' in saved, false);
    assert.equal(saved.generation, 4);
    assert.deepEqual(saved.services[identity.serviceId].accounts, old.services[identity.serviceId].accounts);
    assert.ok(saved.services[identity.serviceId].groups[identity.groupId]);
});

test('当前账号池拒绝假结构指纹、未知格式和新旧头混用，保留原状态文件', () => {
    const header = recordHeader(ACCOUNT_POOL_CONTRACT, ACCOUNT_POOL_CONTRACT);
    for (const mutation of [{ schemaFingerprint: '0'.repeat(64) }, { contract: `${ACCOUNT_POOL_CONTRACT}-unknown` },
        { schemaVersion: 1 }, { policyVersion: LEGACY_POOL_POLICY }]) {
        const { file } = tempState();
        const raw = JSON.stringify({ ...header, generation: 8, services: {}, ...mutation });
        fs.writeFileSync(file, raw, { mode: 0o600 });
        assert.throws(() => selectApiKey(['a', 'b'], ENDPOINT, file), error => error.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
        assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
});

test('URL 规范化拒绝控制字符、制表符点段、三斜杠与 Unicode 主机，副池合并第三凭据，Retry-After 双端对拍与 CAS 锁边界', () => {
    const pool = require('../scripts/llm-account-pool.js');
    for (const bad of [
        'https://opencode.ai/zen/go/.\t./v1',
        'https://@opencode.ai/zen/go/v1',
        'https:///opencode.ai/zen/go/v1',
        'https:///@opencode.ai/zen/go/v1',
        'https://///@opencode.ai/zen/go/v1',
        'https://opencode.ａｉ/zen/go/v1',
        'https://opencode。ai/zen/go/v1',
        'https://opencode%2eai/zen/go/v1',
        'https://%6fpencode.ai/zen/go/v1',
        'https://opencode.ai/zen/go/%ZZ',
        'https://opencode.ai/zen/go/\nv1'
    ]) {
        assert.strictEqual(pool.normalizeOpenCodeGoService(bad), null, bad);
    }

    assert.deepStrictEqual(
        pool.resolveSecondaryApiKeys({
            primaryEndpoint: ENDPOINT,
            primaryKey: 'p-1',
            primaryApiKeys: ['p-1'],
            secondaryEndpoint: ENDPOINT,
            secondaryModel: 'muse-spark-1.3-contributor',
            secondaryKey: 's-1',
            secondaryFallbackApiKeys: 's-2',
            secondaryTertiaryFallbackApiKey: 's-3'
        }),
        ['s-1', 's-2', 's-3']
    );

    const { file } = tempState();
    const sel = selectApiKey(['a', 'b'], ENDPOINT, file, { nowMs: 1000 });
    assert.strictEqual(markQuotaExhausted(sel, { blockedUntilMs: 90000 }, file, { nowMs: 1000 }), 90000);
    assert.strictEqual(markQuotaExhausted(sel, { blockedUntilMs: 5000 }, file, { nowMs: 2000 }), 90000);

    const nowMs = Date.UTC(2026, 9, 21, 7, 27, 0);
    const retryCases = [
        ['Wed, 21 Oct 2026 07:28:00', 60000],
        ['2026-10-21T07:28:00Z', 60000],
        ['2026-10-21T07:28:00', 60000],
        ['2026-10-21T09:28:00+02:00', 60000],
        ['2026-10-21T07:28:00.500', 60500],
        ['Wednesday, 21-Oct-26 07:28:00', 60000],
        ['Oct 21, 2026 07:28:00 AM', 60000],
        ['Oct 21, 2026 07:28:00 PM GMT', 12 * 3600 * 1000 + 60000],
        ['Wed, 21 Oct 2026 07:28:00 -0000', 60000],
        ['Wed, 21 Oct 2026 09:28:00 +02:00', 60000],
        ['Wed, 21 Oct 2026 08:28:00 CET', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 08:28:00 MUT', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 08:28:00 FOOGMT', 30 * 60 * 1000],
        ['Oct 21, 2026 07:28:00 AM +99:99', 30 * 60 * 1000],
        ['Oct 21, 2026 07:28:00 AM -24:00', 30 * 60 * 1000],
        ['Oct 21, 2026 07:28:00 AM +00:65', 30 * 60 * 1000],
        ['2026-10-21T07:28:00+00:99', 30 * 60 * 1000],
        ['2027-02-29T07:28:00Z', 30 * 60 * 1000],
        ['Tue, 31 Feb 2027 07:28:00 GMT', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 GMT+0200', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 GMT+99:99', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 UTC+2', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 +02:999', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 +02:9', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 -5', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 +1', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 +00000', 30 * 60 * 1000],
        ['Wed, 21 Oct 2026 07:28:00 +02:00:00', 30 * 60 * 1000],
        ['2027-02-29 07:28:00 GMT', 30 * 60 * 1000],
        ['Feb 29 2027 07:28:00 GMT', 30 * 60 * 1000],
        ['Feb 29 2027 07:28:00 AM', 30 * 60 * 1000],
        ['2027/02/29 07:28:00 GMT', 30 * 60 * 1000],
        ['02/29/2027 07:28:00 GMT', 30 * 60 * 1000],
        ['Wednesday, 21-Oct-50 07:28:00 GMT', 30 * 60 * 1000]
    ];
    for (const [header, expectedDelta] of retryCases) {
        const res = classifyOpenCodeGoQuotaResponse({
            statusCode: 429,
            headers: { 'retry-after': header },
            body: { type: 'GoUsageLimitError' }
        }, { nowMs });
        assert.strictEqual(res.blockedUntilMs, nowMs + expectedDelta, header);
    }

    if (HAS_PYTHON) {
        const probeUrls = [
            'https://opencode.ai/zen/go/v1',
            'https:///opencode.ai/zen/go/v1',
            'https:///@opencode.ai/zen/go/v1',
            'https://opencode.ａｉ/zen/go/v1',
            'https://opencode。ai/zen/go/v1',
            'https://opencode%2eai/zen/go/v1',
            'https://%6fpencode.ai/zen/go/v1'
        ];
        const pyScript = [
            'import json, sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import normalize_opencode_go_service, classify_opencode_go_quota_response',
            'urls = json.loads(sys.argv[1])',
            'dates = json.loads(sys.argv[2])',
            'now_ms = int(sys.argv[3])',
            'out = {"urls": [normalize_opencode_go_service(u) for u in urls], "dates": [classify_opencode_go_quota_response(429, {"Retry-After": d}, {"type": "GoUsageLimitError"}, now_ms=now_ms)["blocked_until_ms"] - now_ms for d in dates]}',
            'print(json.dumps(out))'
        ].join('; ');
        const pyRes = spawnSync(PYTHON_BIN, ['-c', pyScript, JSON.stringify(probeUrls), JSON.stringify(retryCases.map(c => c[0])), String(nowMs)], { encoding: 'utf8' });
        assert.strictEqual(pyRes.status, 0, pyRes.stderr);
        const parsed = JSON.parse(pyRes.stdout);
        assert.deepStrictEqual(parsed.urls, probeUrls.map(u => pool.normalizeOpenCodeGoService(u)));
        assert.deepStrictEqual(parsed.dates, retryCases.map(c => c[1]));
    }

    const maxBlockMs = 370 * 24 * 60 * 60 * 1000;
    const hugeFinite = '9'.repeat(306);
    const hugeHeader = classifyOpenCodeGoQuotaResponse({
        statusCode: 429,
        headers: { 'retry-after': hugeFinite },
        body: { type: 'GoUsageLimitError' }
    }, { nowMs: 1000 });
    assert.strictEqual(hugeHeader.blockedUntilMs, 1000 + maxBlockMs);

    const hugeReset = classifyOpenCodeGoQuotaResponse({
        statusCode: 429,
        headers: {},
        body: { type: 'GoUsageLimitError', message: `resets in ${hugeFinite} days` }
    }, { nowMs: 1000 });
    assert.strictEqual(hugeReset.blockedUntilMs, 1000 + maxBlockMs);

    // Node 侧 CAS 锁回收边界：异物文件 / 非空 .reclaim / 非目录 .reclaim / 硬链接 owner.json / .tmp symlink 全部 fail-closed 不死循环，合法 .tmp 可回收
    {
        const s1 = tempState();
        const lockDir = `${s1.file}.lock`;
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, '.DS_Store'), 'junk');
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(lockDir, old, old);
        assert.throws(() => pool.acquireStateLock(s1.file, { timeoutMs: 200, staleMs: 1 }),
            err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
    }
    {
        const s2 = tempState();
        const reclaimDir = `${s2.file}.lock.reclaim`;
        fs.mkdirSync(reclaimDir);
        fs.writeFileSync(path.join(reclaimDir, 'foreign'), 'x');
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(reclaimDir, old, old);
        assert.throws(() => pool.acquireStateLock(s2.file, { timeoutMs: 200, staleMs: 1 }),
            err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
    }
    {
        const s3 = tempState();
        fs.writeFileSync(`${s3.file}.lock.reclaim`, 'not-a-dir');
        assert.throws(() => pool.acquireStateLock(s3.file, { timeoutMs: 200, staleMs: 1 }),
            err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
    }
    {
        const s4 = tempState();
        const lockDir = `${s4.file}.lock`;
        fs.mkdirSync(lockDir);
        const target = path.join(s4.dir, 'linked.json');
        fs.writeFileSync(target, '{}');
        fs.linkSync(target, path.join(lockDir, 'owner.json'));
        assert.throws(() => pool.acquireStateLock(s4.file, { timeoutMs: 200, staleMs: 1 }),
            err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
    }
    {
        const s5 = tempState();
        const lockDir = `${s5.file}.lock`;
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, '.owner.json.1.abc.tmp'), '{}');
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(lockDir, old, old);
        const release = pool.acquireStateLock(s5.file, { timeoutMs: 500, staleMs: 1 });
        assert.strictEqual(release(), true);
    }
    {
        const s6 = tempState();
        const lockDir = `${s6.file}.lock`;
        fs.mkdirSync(lockDir);
        const decoy = path.join(s6.dir, 'decoy');
        fs.writeFileSync(decoy, 'x');
        fs.symlinkSync(decoy, path.join(lockDir, '.owner.json.1.sym.tmp'));
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(lockDir, old, old);
        assert.throws(() => pool.acquireStateLock(s6.file, { timeoutMs: 200, staleMs: 1 }),
            err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR');
    }
});

test('resolvePrimaryApiKeyPool 拒绝重复密钥且 selectApiKey 清理过期分组不触发 STALE_GROUP_TTL_MS', () => {
    const pool = require('../scripts/llm-account-pool.js');
    assert.throws(
        () => pool.resolvePrimaryApiKeyPool('dup-key-1', 'dup-key-1,other-key-2'),
        err => err instanceof pool.LlmAccountPoolConfigError
    );
    const { file } = tempState();
    const keys = ['k-alpha-1', 'k-beta-2'];
    pool.selectApiKey(keys, ENDPOINT, file, { nowMs: 1000, affinityKey: '2611.00001v1' });
    const laterKeys = ['k-alpha-1', 'k-gamma-3'];
    const picked = pool.selectApiKey(laterKeys, ENDPOINT, file, {
        nowMs: 1000 + pool.STALE_GROUP_MS + 10,
        affinityKey: 'arXiv:2611.00001v2'
    });
    assert.ok(laterKeys.includes(picked.apiKey));
});

describe('OpenCode Go 月到期优先、同天剩余最多与三窗口额度调度', () => {
    const pool = require('../scripts/llm-account-pool.js');
    const BASE_NOW = Date.parse('2026-11-26T04:00:00Z'); // 北京时间 2026-11-26 12:00

    it('月额度最先到期的账号优先于到期更晚但剩余更多的账号', () => {
        const { file } = tempState();
        const keys = ['acct-late-rich', 'acct-early-low', 'acct-mid-full'];
        pool.setAccountQuota(keys[0], ENDPOINT, {
            monthlyExpiry: '2026-12-20', monthlyRemainingPct: 100, weeklyRemainingPct: 100, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-03', monthlyRemainingPct: 25, weeklyRemainingPct: 40, rolling5hRemainingPct: 50
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[2], ENDPOINT, {
            monthlyExpiry: '2026-12-10', monthlyRemainingPct: 90, weeklyRemainingPct: 100, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });

        const picked = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1000, affinityKey: '2611.00001' });
        assert.strictEqual(picked.apiKey, 'acct-early-low');
        assert.strictEqual(picked.selectionMode, 'expiry_priority');

        // key 顺序打乱且传入不同 affinityKey 仍稳定选最早到期的账号
        const shuffled = pool.selectApiKey([...keys].reverse(), ENDPOINT, file, { nowMs: BASE_NOW + 2000, affinityKey: '2611.99999' });
        assert.strictEqual(shuffled.apiKey, 'acct-early-low');
    });

    it('按北京时间判断同一天到期（含跨 UTC 零点），优先选有效剩余月额度最多；月并列再比周/5小时', () => {
        const { file } = tempState();
        // 2026-12-02T16:30:00Z = 北京 2026-12-03 00:30；2026-12-03T10:00:00Z = 北京 2026-12-03 18:00
        // 两者按北京时间属于同一天（2026-12-03）！
        const keys = ['acct-bj-early-less', 'acct-bj-later-more', 'acct-bj-tie-week-less'];
        pool.setAccountQuota(keys[0], ENDPOINT, {
            monthlyExpiry: '2026-12-02T16:30:00Z', monthlyRemainingPct: 40, weeklyRemainingPct: 100, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-03T10:00:00Z', monthlyRemainingPct: 80, weeklyRemainingPct: 90, rolling5hRemainingPct: 70
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[2], ENDPOINT, {
            monthlyExpiry: '2026-12-03T08:00:00Z', monthlyRemainingPct: 80, weeklyRemainingPct: 50, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });

        // 同一天到期：80% > 40%，月剩余并列 80% 时周剩余 90% > 50%
        const picked = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1000 });
        assert.strictEqual(picked.apiKey, 'acct-bj-later-more');

        // 若周剩余也调成 90%，再比 5 小时剩余（100% > 70%）
        pool.setAccountQuota(keys[2], ENDPOINT, {
            weeklyRemainingPct: 90, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW + 2000 });
        const picked2 = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 3000 });
        assert.strictEqual(picked2.apiKey, 'acct-bj-tie-week-less');
    });

    it('月/周/5小时任一窗口冷却或手动置 0% 时立即跳过，窗口恢复后自动回到优先位', () => {
        const { file } = tempState();
        const keys = ['acct-earliest', 'acct-second', 'acct-third'];
        pool.setAccountQuota(keys[0], ENDPOINT, {
            monthlyExpiry: '2026-12-01', monthlyRemainingPct: 90, weeklyRemainingPct: 90, rolling5hRemainingPct: 90
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-05', monthlyRemainingPct: 70, weeklyRemainingPct: 0, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[2], ENDPOINT, {
            monthlyExpiry: '2026-12-15', monthlyRemainingPct: 60, weeklyRemainingPct: 60, rolling5hRemainingPct: 60
        }, file, { nowMs: BASE_NOW });

        // acct-earliest 触发 5 小时限额冷却 2 小时，acct-second 周额度手动为 0% -> 应直接跳到 acct-third
        const sel0 = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 100 });
        assert.strictEqual(sel0.apiKey, 'acct-earliest');
        pool.markQuotaExhausted(sel0, {
            limitClass: 'rolling_5h',
            blockedUntilMs: BASE_NOW + 2 * 3600_000
        }, file, { nowMs: BASE_NOW + 200 });

        const duringCooldown = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 3600_000 });
        assert.strictEqual(duringCooldown.apiKey, 'acct-third');

        // 2 小时后 5h 窗口恢复，acct-earliest 仍有月/周额度 -> 重新回到第一优先
        const after5hReset = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 2 * 3600_000 + 1000 });
        assert.strictEqual(after5hReset.apiKey, 'acct-earliest');

        // 5h 429 不覆盖月额度剩余百分比与到期日
        const stateAfter = pool.readStateStrict(file);
        const identity = pool.getPoolIdentity(keys, ENDPOINT);
        const rec0 = stateAfter.services[identity.serviceId].accounts[pool.getAccountId(keys[0])];
        assert.strictEqual(rec0.quota.monthlyRemainingPct, 90);
        assert.strictEqual(rec0.quota.rolling5hRemainingPct, 0);
    });

    it('月 429 自动学习到期日且跨月周期滚动；新周期的 5h 429 不复活旧月 0% 快照', () => {
        const { file } = tempState();
        const keys = ['acct-auto-learn', 'acct-later'];
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-20', monthlyRemainingPct: 80
        }, file, { nowMs: BASE_NOW });

        // acct-auto-learn 最初未配置到期日，触发一次 monthly 429（冷却至 2026-12-03T10:00:00Z）
        const resetDec3 = Date.parse('2026-12-03T10:00:00Z');
        pool.markQuotaExhausted(selectionFor(keys, keys[0]), {
            limitClass: 'monthly',
            blockedUntilMs: resetDec3
        }, file, { nowMs: BASE_NOW });

        // 冷却期内只选 acct-later
        assert.strictEqual(pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1000 }).apiKey, 'acct-later');

        // 2026-12-04（下月周期开启后）触发一次 5h 429（至 12-04 12:00Z），不应复活上月的 monthlyRemainingPct=0
        const dec4Morning = Date.parse('2026-12-04T06:00:00Z');
        pool.markQuotaExhausted(selectionFor(keys, keys[0]), {
            limitClass: 'rolling_5h',
            blockedUntilMs: dec4Morning + 3600_000
        }, file, { nowMs: dec4Morning });

        // 12-04 08:00Z（5h 恢复后）：acct-auto-learn 应已恢复月额度且下一次月到期自动滚到 2027-01-03，
        // 晚于 acct-later（2026-12-20），因此先选 acct-later；到 2026-12-21 后 acct-later 滚到 2027-01-20，
        // 此时 acct-auto-learn（2027-01-03）自动成为最先到期第一优先！
        const dec4After5h = Date.parse('2026-12-04T08:00:00Z');
        const evalDec4 = pool.evaluateAccountQuota(
            pool.readStateStrict(file).services[pool.getPoolIdentity(keys, ENDPOINT).serviceId].accounts[pool.getAccountId(keys[0])],
            dec4After5h
        );
        assert.strictEqual(evalDec4.eligible, true);
        assert.strictEqual(evalDec4.hasMonthlyQuota, true);
        assert.strictEqual(evalDec4.monthlyCycle.expiryBeijingDate, '2027-01-03');
        assert.strictEqual(pool.selectApiKey(keys, ENDPOINT, file, { nowMs: dec4After5h }).apiKey, 'acct-later');

        const dec21 = Date.parse('2026-12-21T00:00:00Z');
        assert.strictEqual(pool.selectApiKey(keys, ENDPOINT, file, { nowMs: dec21 }).apiKey, 'acct-auto-learn');
    });

    it('recordAccountUsage 动态扣减本地估算剩余并触发同天到期平滑切换，且绝不因估算误锁死账号', () => {
        const { file } = tempState();
        const keys = ['acct-a', 'acct-b'];
        pool.setAccountQuota(keys[0], ENDPOINT, {
            monthlyExpiry: '2026-12-06', monthlyBudgetUsd: 10, monthlyRemainingPct: 60
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-06', monthlyBudgetUsd: 10, monthlyRemainingPct: 55
        }, file, { nowMs: BASE_NOW });

        // 初始 acct-a (60%) > acct-b (55%)
        const first = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 100 });
        assert.strictEqual(first.apiKey, 'acct-a');

        // 记入 acct-a 本次消耗 $1.00（占 $10 预算的 10% -> 估算剩余降至 50% < 55%）
        pool.recordAccountUsage(first, { estimatedCostUsd: 1.0, totalTokens: 500_000 }, file, { nowMs: BASE_NOW + 200 });
        const second = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 300 });
        assert.strictEqual(second.apiKey, 'acct-b');

        // 即使估算消耗远超预算（如 $100），估算剩余保底 0.01%，不会在没收到真实 429 前锁死账号
        pool.recordAccountUsage(first, { estimatedCostUsd: 100.0 }, file, { nowMs: BASE_NOW + 400 });
        pool.recordAccountUsage(second, { estimatedCostUsd: 100.0 }, file, { nowMs: BASE_NOW + 500 });
        const stillUsable = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 600 });
        assert.ok(keys.includes(stillUsable.apiKey));
    });

    it('未知到期日账号（Tier 2）始终排在已知到期日账号（Tier 1）之后，且 equal_rotation 开关可回退旧策略', () => {
        const { file } = tempState();
        const keys = ['acct-unknown-1', 'acct-unknown-2', 'acct-known'];
        pool.setAccountQuota(keys[2], ENDPOINT, {
            monthlyExpiry: '2026-12-28', monthlyRemainingPct: 10
        }, file, { nowMs: BASE_NOW });

        // 默认 expiry_priority：Tier 1 始终优先于 Tier 2
        assert.strictEqual(
            pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 100, affinityKey: '2611.00001' }).apiKey,
            'acct-known'
        );

        // Tier 1 冷却后，自动退回 Tier 2 的 affinityKey 亲和路由
        pool.markQuotaExhausted(selectionFor(keys, keys[2]), {
            limitClass: 'rolling_5h',
            blockedUntilMs: BASE_NOW + 3600_000
        }, file, { nowMs: BASE_NOW + 200 });
        const t2a = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 300, affinityKey: '2611.12345' });
        const t2b = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 400, affinityKey: '2611.12345' });
        assert.strictEqual(t2a.apiKey, t2b.apiKey);
        assert.ok(['acct-unknown-1', 'acct-unknown-2'].includes(t2a.apiKey));

        // 显式 strategy='equal_rotation' 时忽略到期日，恢复等权轮转
        const eq1 = pool.selectApiKey(keys, ENDPOINT, file, {
            nowMs: BASE_NOW + 3600_000 + 100, strategy: 'equal_rotation'
        });
        const eq2 = pool.selectApiKey(keys, ENDPOINT, file, {
            nowMs: BASE_NOW + 3600_000 + 200, strategy: 'equal_rotation'
        });
        assert.notStrictEqual(eq1.apiKey, eq2.apiKey);
    });

    it('Node 与 Python 在同一共享状态文件上对到期优先、同天平局与消耗扣减完全一致', { skip: !HAS_PYTHON }, () => {
        const { file } = tempState();
        const keys = ['parity-k1', 'parity-k2', 'parity-k3'];
        // parity-k1 与 parity-k2 在北京时间同日（2026-12-06）到期，parity-k3 晚到 2026-12-18
        pool.setAccountQuota(keys[0], ENDPOINT, {
            monthlyExpiry: '2026-12-05T18:00:00Z', monthlyBudgetUsd: 20, monthlyRemainingPct: 70, weeklyRemainingPct: 80, rolling5hRemainingPct: 90
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[1], ENDPOINT, {
            monthlyExpiry: '2026-12-06T10:08:00Z', monthlyBudgetUsd: 20, monthlyRemainingPct: 65, weeklyRemainingPct: 90, rolling5hRemainingPct: 90
        }, file, { nowMs: BASE_NOW });
        pool.setAccountQuota(keys[2], ENDPOINT, {
            monthlyExpiry: '2026-12-18', monthlyBudgetUsd: 20, monthlyRemainingPct: 100, weeklyRemainingPct: 100, rolling5hRemainingPct: 100
        }, file, { nowMs: BASE_NOW });

        const nodePick1 = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1000 });
        assert.strictEqual(nodePick1.apiKey, 'parity-k1');

        const pyScript = [
            'import json, sys',
            `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})`,
            'from llm_account_pool import select_api_key, record_account_usage, mark_quota_exhausted',
            `keys = ${JSON.stringify(keys)}`,
            `endpoint = ${JSON.stringify(ENDPOINT)}`,
            `state_file = ${JSON.stringify(file)}`,
            `now_ms = ${BASE_NOW + 1500}`,
            'pick1 = select_api_key(keys, endpoint, state_file, now_ms=now_ms)',
            'record_account_usage(pick1, {"estimated_cost_usd": 2.0, "total_tokens": 200000}, state_file, now_ms=now_ms + 100)',
            'pick2 = select_api_key(keys, endpoint, state_file, now_ms=now_ms + 200)',
            'mark_quota_exhausted(pick2, {"limit_class": "rolling_5h", "blocked_until_ms": now_ms + 3600000}, state_file, now_ms=now_ms + 300)',
            'pick3 = select_api_key(keys, endpoint, state_file, now_ms=now_ms + 400)',
            'print(json.dumps([pick1["api_key"], pick2["api_key"], pick3["api_key"]]))'
        ].join('\n');
        const pyRes = spawnSync(PYTHON_BIN, ['-c', pyScript], { encoding: 'utf8' });
        assert.strictEqual(pyRes.status, 0, pyRes.stderr);
        const pyPicks = JSON.parse(pyRes.stdout);
        // pick1=parity-k1 (70%>65%), 扣 $2 ($2/$20=10% -> 60%<65%) 后 pick2=parity-k2,
        // parity-k2 5h 冷却后 pick3 回到仍有三窗口额度的 parity-k1（依然早于 12-18 的 parity-k3！）
        assert.deepStrictEqual(pyPicks, ['parity-k1', 'parity-k2', 'parity-k1']);

        // Node 读取 Python 写回的状态，选出的结果与 Python 一致
        const nodeAfterPy = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 2500 });
        assert.strictEqual(nodeAfterPy.apiKey, 'parity-k1');
        // 若再排除 parity-k1，则 parity-k2 在 5h 冷却中，只能落到 parity-k3
        const nodeFallback = pool.selectApiKey(keys, ENDPOINT, file, {
            nowMs: BASE_NOW + 2500,
            excludeAccountIds: [pool.getAccountId('parity-k1')]
        });
        assert.strictEqual(nodeFallback.apiKey, 'parity-k3');
    });

    it('syncOpenCodeGoPoolUsage 实时同步 /zen/go/v1/usage：转换已用百分比、同日排序、TTL 缓存与窗口冷却同步', async () => {
        const { file } = tempState();
        const keys = ['live-k1', 'live-k2', 'live-k3'];
        assert.strictEqual(pool.getOpenCodeGoUsageUrl(ENDPOINT), 'https://opencode.ai/zen/go/v1/usage');
        assert.strictEqual(pool.getOpenCodeGoUsageUrl('https://other.example/v1'), null);

        // 先给 live-k2 放一个过时的本地 5h 冷却，验证服务端返回 status=ok 时立即解除
        pool.markQuotaExhausted(selectionFor(keys, keys[1]), {
            limitClass: 'rolling_5h',
            blockedUntilMs: BASE_NOW + 2 * 3600_000
        }, file, { nowMs: BASE_NOW });

        let fetchCalls = 0;
        const fetcher = async ({ url, apiKey }) => {
            fetchCalls += 1;
            assert.strictEqual(url, 'https://opencode.ai/zen/go/v1/usage');
            if (apiKey === 'live-k1') {
                // 最早到期 11-30，但 5h 窗口已 rate_limited -> 必须被跳过
                return {
                    statusCode: 200,
                    body: {
                        usage: {
                            rolling: { status: 'rate_limited', percent: 100, resetsAt: '2026-11-26T06:00:00.000Z' },
                            weekly: { status: 'ok', percent: 10, resetsAt: '2026-11-30T00:00:00.000Z' },
                            monthly: { status: 'ok', percent: 20, resetsAt: '2026-11-29T17:43:55.000Z' }
                        }
                    }
                };
            }
            if (apiKey === 'live-k2') {
                // 北京 2026-12-03 00:01 到期，已用 36% -> 剩余 64%
                return {
                    statusCode: 200,
                    body: {
                        usage: {
                            rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-26T09:00:00.000Z' },
                            weekly: { status: 'ok', percent: 3, resetsAt: '2026-11-30T00:00:00.000Z' },
                            monthly: { status: 'ok', percent: 36, resetsAt: '2026-12-02T16:01:25.000Z' }
                        }
                    }
                };
            }
            // live-k3：北京 2026-12-03 18:01 到期，已用 70% -> 剩余 30%（同日到期但剩余少于 live-k2）
            return {
                statusCode: 200,
                body: {
                    usage: {
                        rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-26T09:00:00.000Z' },
                        weekly: { status: 'ok', percent: 3, resetsAt: '2026-11-30T00:00:00.000Z' },
                        monthly: { status: 'ok', percent: 70, resetsAt: '2026-12-03T10:01:43.000Z' }
                    }
                }
            };
        };

        const sync1 = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW, fetcher });
        assert.strictEqual(sync1.synced, 3);
        assert.strictEqual(sync1.failed, 0);
        assert.strictEqual(fetchCalls, 3);

        // live-k1 因 5h 窗口 rate_limited 跳过；live-k2 解除旧冷却并在 12-03 同日以 64% > 30% 胜出
        const picked = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1000 });
        assert.strictEqual(picked.apiKey, 'live-k2');

        // TTL 内重复同步直接命中缓存，不发任何网络请求
        const syncCached = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW + 60_000, fetcher, ttlMs: 300_000 });
        assert.strictEqual(syncCached.fromCache, true);
        assert.strictEqual(syncCached.skipped, 3);
        assert.strictEqual(fetchCalls, 3);

        // 超过 5h 重置时间点（06:00Z）后，live-k1 自动恢复并成为 #1（2026-11-30 最早到期）
        const afterReset = Date.parse('2026-11-26T06:05:00Z');
        const pickedAfter = pool.selectApiKey(keys, ENDPOINT, file, { nowMs: afterReset });
        assert.strictEqual(pickedAfter.apiKey, 'live-k1');
    });

    it('P0-1/P1-6: requestLlmJson 生产状态自动触发实时同步、限制超时预算并脱敏警告，且落账异常回退保留 accountId', async () => {
        const { file } = tempState();
        const keys = ['sk-live-sync-alpha-1111', 'sk-live-sync-beta-2222'];
        const seenSyncTimeouts = [];
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            const resp = await requestLlmJson(
                `${ENDPOINT}/chat/completions`, ENDPOINT, 'test-model', {}, {},
                {
                    apiKeys: keys,
                    accountPoolStateFile: file,
                    timeoutMs: 4000,
                    recordUsage: false,
                    usageFetcher: async ({ timeoutMs, apiKey }) => {
                        seenSyncTimeouts.push(timeoutMs);
                        if (apiKey === keys[0]) {
                            throw new Error(`proxy https://user:topsecret@proxy.test:8080 rejected Bearer ${apiKey} ${'a'.repeat(64)}`);
                        }
                        return {
                            statusCode: 200,
                            body: {
                                usage: {
                                    rolling: { status: 'ok', percent: 5, resetsAt: '2026-11-26T09:00:00.000Z' },
                                    weekly: { status: 'ok', percent: 10, resetsAt: '2026-11-30T00:00:00.000Z' },
                                    monthly: { status: 'ok', percent: 20, resetsAt: '2026-12-02T00:00:00.000Z' }
                                }
                            }
                        };
                    },
                    transportRequestFn: async () => ({ statusCode: 200, body: { output_text: 'ok' }, raw: '{}' })
                }
            );
            assert.strictEqual(resp.statusCode, 200);
            assert.ok(seenSyncTimeouts.length >= 1);
            assert.ok(seenSyncTimeouts.every(ms => ms === 2000), `expected capped timeout 2000, got ${seenSyncTimeouts}`);

            // Verify redactUsageSyncError strips apiKey, Bearer/Basic, sk-*, 64-hex, URL userinfo
            const redacted = pool.redactUsageSyncError(
                new Error(`https://u:p@host:8080 Bearer tok123 Basic b64== sk-secret9999 ${'f'.repeat(64)} customKey42`),
                'customKey42'
            );
            for (const leaked of ['u:p', 'tok123', 'b64==', 'sk-secret9999', 'f'.repeat(64), 'customKey42']) {
                assert.ok(!redacted.includes(leaked), `should redact ${leaked}: ${redacted}`);
            }

            // Verify persistence-error fallback buildLlmUsageEvent includes accountId
            let capturedErr = null;
            try {
                await requestLlmJson(
                    `${ENDPOINT}/chat/completions`, ENDPOINT, 'test-model', {}, {},
                    {
                        apiKeys: keys,
                        accountPoolStateFile: file,
                        timeoutMs: 4000,
                        usageSink: () => { throw new Error('disk full'); },
                        transportRequestFn: async () => ({ statusCode: 200, body: { output_text: 'ok' }, raw: '{}' })
                    }
                );
            } catch (err) {
                capturedErr = err;
            }
            assert.ok(capturedErr, 'expected persistence error');
            assert.ok(
                capturedErr.usageEvent?.accountId || capturedErr.event?.accountId,
                'fallback usage event must include accountId'
            );

            // P0-1: child process without NODE_TEST_CONTEXT passing Config.FILES.llmAccountPoolState triggers live sync
            const probeScript = `
                const path = require('node:path');
                const Config = require('./scripts/config.js');
                const pool = require('./scripts/llm-account-pool.js');
                let syncCalled = 0;
                let syncArgs = null;
                pool.syncOpenCodeGoPoolUsage = async (_keys, _ep, sf, opts) => {
                    syncCalled += 1;
                    syncArgs = { sf, opts };
                    return { synced: 0, failed: 0, skipped: 2, authErrors: [], fromCache: true, results: [] };
                };
                pool.selectApiKey = () => { throw new Error('STOP_AFTER_SYNC'); };
                process.env.https_proxy = 'http://127.0.0.1:7897';
                const { requestLlmJson } = require('./scripts/utils.js');
                requestLlmJson(
                    'https://opencode.ai/zen/go/v1/chat/completions',
                    'https://opencode.ai/zen/go/v1',
                    'test-model',
                    {},
                    {},
                    { apiKeys: ['k-prod-1', 'k-prod-2'], accountPoolStateFile: Config.FILES.llmAccountPoolState, timeoutMs: 5000 }
                ).catch(err => {
                    console.log(JSON.stringify({
                        syncCalled,
                        proxyUrl: syncArgs?.opts?.proxyUrl,
                        timeoutMs: syncArgs?.opts?.timeoutMs,
                        errMsg: err.message
                    }));
                });
            `;
            const childEnv = { ...process.env };
            delete childEnv.NODE_TEST_CONTEXT;
            const probeRes = spawnSync(process.execPath, ['-e', probeScript], {
                cwd: path.join(__dirname, '..'),
                env: childEnv,
                encoding: 'utf8'
            });
            assert.strictEqual(probeRes.status, 0, probeRes.stderr);
            const probeOut = JSON.parse(probeRes.stdout.trim().split('\n').pop());
            assert.strictEqual(probeOut.syncCalled, 1);
            assert.strictEqual(probeOut.proxyUrl, 'http://127.0.0.1:7897');
            assert.strictEqual(probeOut.timeoutMs, 2500);
            assert.strictEqual(probeOut.errMsg, 'STOP_AFTER_SYNC');
        } finally {
            console.warn = origWarn;
        }
    });

    it('P0-2/P1-6: parseMonthlyExpiryInput 拒绝越界时区和非正时间戳，且 setAccountQuota 备注错误不回显密钥', () => {
        const { file } = tempState();
        for (const bad of ['2026-12-01T00:00:00+20:00', '2026-12-01T00:00:00-15:00', '1969-12-31', '1970-01-01T00:00:00Z']) {
            assert.throws(
                () => pool.parseMonthlyExpiryInput(bad),
                err => err.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR',
                `should reject ${bad}`
            );
            assert.throws(
                () => pool.setAccountQuota('acct-tz-test', ENDPOINT, { monthlyExpiry: bad }, file, { nowMs: BASE_NOW }),
                err => err.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            );
        }
        // State file must remain readable (not bricked)
        assert.doesNotThrow(() => pool.readStateStrict(file));

        const secretLabel = 'sk-secret-do-not-echo-12345';
        assert.throws(
            () => pool.setAccountQuota('acct-tz-test', ENDPOINT, { label: secretLabel }, file, { nowMs: BASE_NOW }),
            err => err.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR' && !err.message.includes(secretLabel)
        );
    });

    it('P1-2/P2-3: null monthlyCycleStartMs 不吞掉同步后消费，5h 旧分桶老化和非周一重置周周期扣减准确', () => {
        const { file } = tempState();
        const keys = ['acct-spend-a', 'acct-spend-b'];
        const selA = selectionFor(keys, keys[0]);
        // 取 04:05:00Z（桶内第 5 分钟），保证 snapNow - 60s 与 snapNow + 60s 同属 04:00 桶
        const snapNow = BASE_NOW + 5 * 60_000;

        // 1. 先在没有 monthlyCycle 时记入旧 5h 桶 $5.00（monthlyCycleStartMs === null）
        pool.recordAccountUsage(selA, { estimatedCostUsd: 5.0, totalTokens: 1000 }, file, { nowMs: snapNow - 4 * 3600_000 - 45 * 60_000 });
        // 再在快照所在的 04:00 桶内、快照前记入 $0.50
        pool.recordAccountUsage(selA, { estimatedCostUsd: 0.5, totalTokens: 500 }, file, { nowMs: snapNow - 60_000 });

        // 2. Live sync 写入周重置为周三（2026-12-02T10:00:00Z，非周一）、月预算 $10
        pool.setAccountQuota(keys[0], ENDPOINT, { monthlyBudgetUsd: 10 }, file, { nowMs: snapNow });
        pool.applyLiveUsageSnapshots(keys, ENDPOINT, {
            [selA.accountId]: {
                monthly: { status: 'ok', usedPercent: 20, remainingPct: 80, limited: false, resetsAtMs: Date.parse('2026-12-10T00:00:00Z') },
                weekly: { status: 'ok', usedPercent: 10, remainingPct: 90, limited: false, resetsAtMs: Date.parse('2026-12-02T10:00:00Z') },
                rolling: { status: 'ok', usedPercent: 25, remainingPct: 75, limited: false, resetsAtMs: snapNow + 3 * 3600_000 }
            }
        }, file, { nowMs: snapNow });

        const identity = pool.getPoolIdentity(keys, ENDPOINT);
        const recAfterSync = pool.readStateStrict(file).services[identity.serviceId].accounts[selA.accountId];
        // P1-2: monthlySpentAtSnapshotUsd 必须为 0（而非 5.5）
        assert.strictEqual(recAfterSync.quota.monthlySpentAtSnapshotUsd, 0);
        // P2-3: rolling5hSpentAtSnapshotUsd 仅记快照当前桶 $0.50（而非整 5h $5.50）
        assert.strictEqual(recAfterSync.quota.rolling5hSpentAtSnapshotUsd, 0.5);

        // 3. 快照同桶再消费 $0.25，以及 30 分钟后（旧 $5.00 分桶已老化出 5h 窗口）新桶再消费 $0.75，共 $1.00
        pool.recordAccountUsage(selA, { estimatedCostUsd: 0.25, totalTokens: 250 }, file, { nowMs: snapNow + 60_000 });
        const laterMs = snapNow + 30 * 60_000;
        pool.recordAccountUsage(selA, { estimatedCostUsd: 0.75, totalTokens: 750 }, file, { nowMs: laterMs });
        const recLater = pool.readStateStrict(file).services[identity.serviceId].accounts[selA.accountId];
        const evLater = pool.evaluateAccountQuota(recLater, laterMs);
        // 月预算 $10 -> $1.00 扣 10% -> 70%
        assert.strictEqual(evLater.effectiveMonthlyRemainingPct, 70);
        // 周预算 $5 -> $1.00 扣 20% -> 70%
        assert.strictEqual(evLater.effectiveWeeklyRemainingPct, 70);
        // 5h 预算 $2 -> $1.00 扣 50% -> 25%（旧 $5.00 分桶老化绝不能吞掉新消费！）
        assert.strictEqual(evLater.effectiveRolling5hRemainingPct, 25);

        // 4. 跨过周一 UTC 00:00（2026-11-30T01:00:00Z），仍早于周三重置（2026-12-02T10:00:00Z）
        const mondayAfter = Date.parse('2026-11-30T01:00:00Z');
        pool.recordAccountUsage(selA, { estimatedCostUsd: 0.5, totalTokens: 500 }, file, { nowMs: mondayAfter });
        const recMon = pool.readStateStrict(file).services[identity.serviceId].accounts[selA.accountId];
        const evMon = pool.evaluateAccountQuota(recMon, mondayAfter);
        // 累计周消费 $1.50 / $5 = 30% -> 90% - 30% = 60%（不因周一误清零！）
        assert.strictEqual(evMon.effectiveWeeklyRemainingPct, 60);
    });

    it('P1-3/P1-4/P2-1/P2-2/P2-4/P3-3: 严格校验 percent、快路径安全守卫、单账号退避与 live_api 保护、代理优先级与游标排序', async () => {
        // P1-3: percent 拒绝 null / "" / false / 字符串
        for (const badPct of [null, '', false, [], '20', -1, 101]) {
            assert.throws(() => pool.parseOpenCodeGoUsagePayload({
                usage: {
                    rolling: { status: 'ok', percent: badPct, resetsAt: '2026-11-26T09:00:00.000Z' },
                    weekly: { status: 'ok', percent: 0, resetsAt: '2026-11-30T00:00:00.000Z' },
                    monthly: { status: 'ok', percent: 0, resetsAt: '2026-12-10T00:00:00.000Z' }
                }
            }), /percent 非法/);
        }

        // P1-4: 只读快路径必须拦截父目录 symlink 与 service.endpoint 篡改
        {
            const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fastpath-guard-'));
            const realDir = path.join(tmpRoot, 'real');
            const linkedDir = path.join(tmpRoot, 'linked');
            fs.mkdirSync(realDir);
            fs.symlinkSync(realDir, linkedDir, 'dir');
            const realFile = path.join(realDir, 'pool.json');
            const keys = ['fp-a', 'fp-b'];
            pool.selectApiKey(keys, ENDPOINT, realFile, { nowMs: BASE_NOW, affinityKey: '2611.00001' });
            assert.throws(
                () => pool.selectApiKey(keys, ENDPOINT, path.join(linkedDir, 'pool.json'), { nowMs: BASE_NOW + 1000, affinityKey: '2611.00001' }),
                err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
            // Tamper service.endpoint while group is hot -> fast path must throw LlmAccountPoolStateError
            const state = JSON.parse(fs.readFileSync(realFile, 'utf8'));
            const id = pool.getPoolIdentity(keys, ENDPOINT);
            state.services[id.serviceId].endpoint = 'https://evil.invalid/zen/go';
            fs.writeFileSync(realFile, JSON.stringify(state), { mode: 0o600 });
            assert.throws(
                () => pool.selectApiKey(keys, ENDPOINT, realFile, { nowMs: BASE_NOW + 1000, affinityKey: '2611.00001' }),
                err => err.code === 'LLM_ACCOUNT_POOL_STATE_ERROR'
            );
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }

        // P2-1: stale resetsAt <= lastSync 不无限循环，单账号失败退避（部分成功也生效），时钟回拨不命中缓存
        {
            const { file } = tempState();
            const keys = ['sync-p21-ok', 'sync-p21-fail'];
            let callsByKey = { 'sync-p21-ok': 0, 'sync-p21-fail': 0 };
            const fetcher = async ({ apiKey }) => {
                callsByKey[apiKey] += 1;
                if (apiKey === 'sync-p21-fail') {
                    return { statusCode: 500, body: { error: 'boom' } };
                }
                return {
                    statusCode: 200,
                    body: {
                        usage: {
                            // resetsAt 已经早于 BASE_NOW（模拟服务端返回过期时间戳）
                            rolling: { status: 'ok', percent: 0, resetsAt: new Date(BASE_NOW - 10_000).toISOString() },
                            weekly: { status: 'ok', percent: 5, resetsAt: new Date(BASE_NOW + 3 * 86400_000).toISOString() },
                            monthly: { status: 'ok', percent: 10, resetsAt: new Date(BASE_NOW + 10 * 86400_000).toISOString() }
                        }
                    }
                };
            };
            const r1 = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW, fetcher });
            assert.strictEqual(r1.synced, 1);
            assert.strictEqual(r1.failed, 1);
            // 10s 后再次同步：ok 账号命中 TTL（stale resetsAt <= lastSync 不触发重拉），fail 账号命中单账号退避
            const r2 = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW + 10_000, fetcher });
            assert.strictEqual(r2.fromCache, true);
            assert.strictEqual(r2.backoff, true);
            assert.deepStrictEqual(callsByKey, { 'sync-p21-ok': 1, 'sync-p21-fail': 1 });
            // 70s 后 fail 账号退避结束，仅重拉 fail 账号；ok 账号仍在 5min TTL 内
            const r3 = await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW + 70_000, fetcher });
            assert.strictEqual(r3.fromCache, false);
            assert.deepStrictEqual(callsByKey, { 'sync-p21-ok': 1, 'sync-p21-fail': 2 });
            // 时钟回拨（nowMs < lastSync）：不命中缓存，重新同步
            await pool.syncOpenCodeGoPoolUsage(keys, ENDPOINT, file, { nowMs: BASE_NOW - 5000, fetcher });
            assert.strictEqual(callsByKey['sync-p21-ok'], 2);
        }

        // P2-2: markQuotaExhausted 与 initQuotasFromHistory 均保留 live_api 锚点
        {
            const { file } = tempState();
            const keys = ['live-keep-1', 'live-keep-2'];
            const liveResetMs = Date.parse('2026-12-08T00:00:00Z');
            pool.applyLiveUsageSnapshots(keys, ENDPOINT, {
                [pool.getAccountId(keys[0])]: {
                    monthly: { status: 'ok', usedPercent: 50, remainingPct: 50, limited: false, resetsAtMs: liveResetMs },
                    weekly: { status: 'ok', usedPercent: 10, remainingPct: 90, limited: false, resetsAtMs: BASE_NOW + 2 * 86400_000 },
                    rolling: { status: 'ok', usedPercent: 0, remainingPct: 100, limited: false, resetsAtMs: BASE_NOW + 3600_000 }
                }
            }, file, { nowMs: BASE_NOW });
            pool.markQuotaExhausted(selectionFor(keys, keys[0]), {
                limitClass: 'monthly',
                blockedUntilMs: Date.parse('2026-12-15T00:00:00Z')
            }, file, { nowMs: BASE_NOW + 1000 });
            const identity = pool.getPoolIdentity(keys, ENDPOINT);
            const rec = pool.readStateStrict(file).services[identity.serviceId].accounts[pool.getAccountId(keys[0])];
            assert.strictEqual(rec.quota.monthlyResetSource, 'live_api');
            assert.strictEqual(rec.quota.monthlyResetAtMs, liveResetMs);
            const initRes = pool.initQuotasFromHistory(keys, ENDPOINT, file, { nowMs: BASE_NOW + 2000 });
            assert.ok(initRes.skipped.some(s => s.slot === 1 && s.reason === 'already_live_api'));
        }

        // P2-4: 代理规范顺序 https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY，非法不穿透
        assert.strictEqual(pool.resolveUsageProxyUrl(undefined, {
            https_proxy: 'socks5://127.0.0.1:7897',
            HTTP_PROXY: 'http://127.0.0.1:7897'
        }), null);
        assert.strictEqual(pool.resolveUsageProxyUrl(undefined, {
            https_proxy: 'http://127.0.0.1:8080',
            HTTPS_PROXY: 'http://127.0.0.1:9090'
        }), 'http://127.0.0.1:8080');

        // P3-2/P3-3: legacy limitName='balance' 与 describePoolPriorities 游标对齐
        const balEval = pool.evaluateAccountQuota({ limitName: 'balance', blockedUntilMs: BASE_NOW + 60_000 }, BASE_NOW);
        assert.strictEqual(balEval.eligible, false);
        assert.strictEqual(balEval.hasBalanceQuota, false);
        assert.strictEqual(balEval.balanceBlockedUntil, BASE_NOW + 60_000);

        {
            const { file } = tempState();
            const keys = ['rot-1', 'rot-2', 'rot-3'];
            pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW, strategy: 'equal_rotation' });
            pool.selectApiKey(keys, ENDPOINT, file, { nowMs: BASE_NOW + 1, strategy: 'equal_rotation' });
            const state = pool.readStateStrict(file);
            const desc = pool.describePoolPriorities(keys, ENDPOINT, state, { nowMs: BASE_NOW + 2, strategy: 'equal_rotation' });
            const rank1Row = desc.rows.find(r => r.priorityRank === 1);
            assert.strictEqual(rank1Row.slot, desc.nextSlot, 'equal_rotation #1 必须与 nextSlot 一致');
            const descTier2 = pool.describePoolPriorities(keys, ENDPOINT, state, { nowMs: BASE_NOW + 2, strategy: 'expiry_priority' });
            const tier2Rank1 = descTier2.rows.find(r => r.priorityRank === 1);
            assert.strictEqual(tier2Rank1.slot, descTier2.nextSlot, 'Tier-2 #1 必须与 nextSlot 一致');
        }

        // P3-2: fetchOpenCodeGoAccountUsage forwards nowMs to classifyOpenCodeGoQuotaResponse
        const balResp = await pool.fetchOpenCodeGoAccountUsage('sk-bal-key', ENDPOINT, {
            nowMs: BASE_NOW,
            fetcher: async () => ({ statusCode: 401, body: { error: { message: 'Insufficient balance' } } })
        });
        assert.strictEqual(balResp.insufficientBalance, true);
        assert.strictEqual(balResp.quota.blockedUntilMs, BASE_NOW + 30 * 60 * 1000);
    });

    it('fetchOpenCodeGoAccountUsage 与 syncOpenCodeGoPoolUsage 向 undici ProxyAgent 传递 proxyTls/requestTls 超时且不覆写 SNI', async () => {
        const undiciPath = require.resolve('undici');
        const originalUndiciEntry = require.cache[undiciPath];
        const capturedOptions = [];
        const okPayload = JSON.stringify({
            usage: {
                rolling: { status: 'ok', percent: 10, resetsAt: '2026-12-01T05:00:00.000Z' },
                weekly: { status: 'ok', percent: 20, resetsAt: '2026-12-07T00:00:00.000Z' },
                monthly: { status: 'ok', percent: 30, resetsAt: '2026-12-20T00:00:00.000Z' }
            }
        });
        class FakeProxyAgent {
            constructor(opts) {
                capturedOptions.push(opts);
                this.opts = opts;
                this.closed = false;
            }
            async close() {
                this.closed = true;
            }
        }
        const fakeFetch = async (_url, init) => ({
            status: 200,
            headers: new Map(),
            body: (async function* () {
                assert.ok(init.dispatcher instanceof FakeProxyAgent);
                yield Buffer.from(okPayload, 'utf8');
            })()
        });
        require.cache[undiciPath] = {
            id: undiciPath,
            filename: undiciPath,
            loaded: true,
            exports: { ProxyAgent: FakeProxyAgent, fetch: fakeFetch }
        };
        try {
            const single = await pool.fetchOpenCodeGoAccountUsage('sk-tls-1', ENDPOINT, {
                proxyUrl: 'http://127.0.0.1:7897',
                timeoutMs: 25000
            });
            assert.strictEqual(single.ok, true);
            assert.strictEqual(capturedOptions.length, 1);
            assert.deepStrictEqual(capturedOptions[0], {
                uri: 'http://127.0.0.1:7897',
                connectTimeout: 25000,
                proxyTls: { timeout: 25000 },
                requestTls: { timeout: 25000 }
            });
            assert.strictEqual(Object.hasOwn(capturedOptions[0].proxyTls, 'servername'), false);
            assert.strictEqual(Object.hasOwn(capturedOptions[0].requestTls, 'servername'), false);

            const { file } = tempState();
            const synced = await pool.syncOpenCodeGoPoolUsage(['sk-tls-1', 'sk-tls-2'], ENDPOINT, file, {
                proxyUrl: 'http://127.0.0.1:7897',
                timeoutMs: 18000,
                nowMs: BASE_NOW,
                force: true
            });
            assert.strictEqual(synced.synced, 2);
            assert.strictEqual(capturedOptions.length, 2);
            assert.deepStrictEqual(capturedOptions[1], {
                uri: 'http://127.0.0.1:7897',
                connectTimeout: 18000,
                proxyTls: { timeout: 18000 },
                requestTls: { timeout: 18000 }
            });
            assert.strictEqual(Object.hasOwn(capturedOptions[1].proxyTls, 'servername'), false);
            assert.strictEqual(Object.hasOwn(capturedOptions[1].requestTls, 'servername'), false);
        } finally {
            if (originalUndiciEntry) require.cache[undiciPath] = originalUndiciEntry;
            else delete require.cache[undiciPath];
        }
    });
});
