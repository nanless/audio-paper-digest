'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pool = require('../scripts/llm-account-pool');
const cli = require('../scripts/llm-accounts-quota');

const ENDPOINT = 'https://opencode.ai/zen/go/v1';
const BASE_NOW = Date.parse('2026-11-26T04:00:00Z');
const FAKE_KEYS = ['sk-fake-quota-key-alpha-1111', 'sk-fake-quota-key-beta-2222', 'sk-fake-quota-key-gamma-3333'];

function makeEnv(extra = {}) {
    return {
        PAPER_ANALYZER_ENDPOINT: ENDPOINT,
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_API_KEY: FAKE_KEYS[0],
        PAPER_ANALYZER_FALLBACK_API_KEYS: `${FAKE_KEYS[1]},${FAKE_KEYS[2]}`,
        ...extra
    };
}

function makeFixture(t, env = makeEnv(), initialState = undefined) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-quota-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateFile = path.join(root, 'llm-account-pool.json');
    if (initialState !== undefined) {
        fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2), { mode: 0o600 });
    }
    return { root, stateFile, env };
}

test('llm-accounts-quota status 只读且不建状态文件，不泄露密钥与账号指纹', t => {
    const { stateFile, env } = makeFixture(t);
    const opts = cli.parseArgs(['status', '--json', '--state', stateFile]);
    const res = cli.runCommand(opts, env, { nowMs: BASE_NOW });
    assert.strictEqual(res.action, 'status');
    assert.strictEqual(res.strategy, 'expiry_priority');
    assert.strictEqual(res.rows.length, 3);
    assert.strictEqual(res.tier1Count, 0);
    assert.strictEqual(fs.existsSync(stateFile), false);

    const serialized = JSON.stringify(res) + '\n' + cli.formatStatusText(res);
    for (const secret of [...FAKE_KEYS, ENDPOINT, ...FAKE_KEYS.map(k => pool.getAccountId(k))]) {
        assert.ok(!serialized.includes(secret), `不得泄露敏感信息: ${secret.slice(0, 8)}`);
    }
});

test('llm-accounts-quota set / clear / import 支持到期优先排序且 import 遇错 fail-closed', t => {
    const { root, stateFile, env } = makeFixture(t);

    // 账号 1 与 账号 2 同一天到期（2026-12-06），账号 2 剩余 85% > 账号 1 剩余 40%；账号 3 到期更早（2026-12-02）
    cli.runCommand(cli.parseArgs([
        'set', '--account', '1', '--monthly-expiry', '2026-12-06', '--monthly-remaining', '40', '--label', '号一', '--state', stateFile
    ]), env, { nowMs: BASE_NOW });
    cli.runCommand(cli.parseArgs([
        'set', '--account', '2', '--monthly-expiry', '2026-12-06', '--monthly-remaining', '85', '--label', '号二', '--state', stateFile
    ]), env, { nowMs: BASE_NOW });
    const afterSet3 = cli.runCommand(cli.parseArgs([
        'set', '--account', '3', '--monthly-expiry', '2026-12-02', '--monthly-remaining', '20', '--weekly-remaining', '50', '--5h-remaining', '60', '--state', stateFile
    ]), env, { nowMs: BASE_NOW });

    assert.strictEqual(afterSet3.nextSlot, 3);
    assert.strictEqual(afterSet3.rows.find(r => r.slot === 3).priorityRank, 1);
    assert.strictEqual(afterSet3.rows.find(r => r.slot === 2).priorityRank, 2);
    assert.strictEqual(afterSet3.rows.find(r => r.slot === 1).priorityRank, 3);

    // 清空账号 3 的到期配置后，账号 2（12-06 85%）升为第一，账号 3 退回 Tier 2（第 3）
    const afterClear = cli.runCommand(cli.parseArgs(['clear', '--account', '3', '--state', stateFile]), env, { nowMs: BASE_NOW });
    assert.strictEqual(afterClear.cleared, true);
    assert.strictEqual(afterClear.nextSlot, 2);
    assert.strictEqual(afterClear.rows.find(r => r.slot === 2).priorityRank, 1);
    assert.strictEqual(afterClear.rows.find(r => r.slot === 1).priorityRank, 2);
    assert.strictEqual(afterClear.rows.find(r => r.slot === 3).priorityRank, 3);

    // 含非法第二项的 import 必须整体 fail-closed，不污染账号 1 原配置
    const badImport = path.join(root, 'bad-import.json');
    fs.writeFileSync(badImport, JSON.stringify([
        { account: 1, monthlyExpiry: '2026-12-01', monthlyRemainingPct: 99 },
        { account: 2, monthlyExpiry: '2026-02-31', monthlyRemainingPct: 50 }
    ]));
    const beforeBad = fs.readFileSync(stateFile, 'utf8');
    assert.throws(
        () => cli.runCommand(cli.parseArgs(['import', '--file', badImport, '--state', stateFile]), env, { nowMs: BASE_NOW }),
        err => err.exitCode === 2
    );
    assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), beforeBad);

    // 合法批量 import 更新成功
    const goodImport = path.join(root, 'good-import.json');
    fs.writeFileSync(goodImport, JSON.stringify({
        accounts: [
            { account: 1, monthlyExpiry: '2026-12-04', monthlyRemainingUsd: 18, monthlyBudgetUsd: 30, label: 'batch_1' },
            { account: 3, monthlyDay: 1, monthlyRemainingPct: 75, weeklyRemainingPct: 80, rolling5hRemainingPct: 90 }
        ]
    }));
    const afterImport = cli.runCommand(cli.parseArgs(['import', '--file', goodImport, '--state', stateFile]), env, { nowMs: BASE_NOW });
    assert.deepStrictEqual(afterImport.updatedAccounts, [1, 3]);
    assert.strictEqual(afterImport.nextSlot, 3); // 每月 1 号 -> 2026-12-01，早于 12-04 与 12-06
    assert.strictEqual(afterImport.rows.find(r => r.slot === 1).monthlyRemainingPct, 60);
});

test('llm-accounts-quota init-from-history 从历史 monthly 429 学习到期日且不覆盖手动配置', t => {
    const identity = pool.getPoolIdentity(FAKE_KEYS, ENDPOINT);
    const initialState = {
        ...require('../scripts/lib/protocol-codec').recordHeader(pool.ACCOUNT_POOL_CONTRACT, pool.ACCOUNT_POOL_CONTRACT),
        generation: 3,
        services: {
            [identity.serviceId]: {
                endpoint: identity.service,
                accounts: {
                    [pool.getAccountId(FAKE_KEYS[0])]: {
                        status: 'quota_blocked',
                        limitName: 'monthly',
                        blockedUntilMs: Date.parse('2026-11-06T10:08:00Z') // 已过期，下月自动滚到 2026-12-06
                    },
                    [pool.getAccountId(FAKE_KEYS[1])]: {
                        status: 'eligible',
                        limitName: 'weekly',
                        blockedUntilMs: Date.parse('2026-11-23T00:00:00Z')
                    },
                    [pool.getAccountId(FAKE_KEYS[2])]: {
                        status: 'eligible',
                        quota: {
                            monthlyResetDay: 2,
                            monthlyResetTzOffsetMin: 480,
                            monthlyResetSource: 'manual'
                        },
                        limitName: 'monthly',
                        blockedUntilMs: Date.parse('2026-11-18T10:00:00Z')
                    }
                },
                groups: {}
            }
        }
    };
    const { stateFile, env } = makeFixture(t, makeEnv(), initialState);
    const res = cli.runCommand(cli.parseArgs(['init-from-history', '--state', stateFile]), env, { nowMs: BASE_NOW });
    assert.strictEqual(res.initialized.length, 1);
    assert.strictEqual(res.initialized[0].slot, 1);
    assert.strictEqual(res.initialized[0].nextMonthlyExpiryBeijing, '2026-12-06');
    assert.deepStrictEqual(res.skipped, [
        { slot: 2, reason: 'no_monthly_429_history' },
        { slot: 3, reason: 'already_manual' }
    ]);
    // 手动设置的账号 3（12-02）排在自动学习的账号 1（12-06）前面，账号 2 仍是 Tier 2
    assert.strictEqual(res.nextSlot, 3);
    assert.strictEqual(res.rows.find(r => r.slot === 1).monthlyResetSource, 'auto_429');
    assert.strictEqual(res.rows.find(r => r.slot === 3).monthlyResetSource, 'manual');
});

test('llm-accounts-quota CLI 支持 --help、非法参数返回退出码 2、沙箱守卫拒绝执行', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'llm-accounts-quota.js');
    const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir() };

    const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8', env: cleanEnv });
    assert.strictEqual(help.status, 0, help.stderr);
    assert.match(help.stdout, /llm:accounts:quota/);

    const badArg = spawnSync(process.execPath, [scriptPath, 'set', '--account', '1'], { encoding: 'utf8', env: cleanEnv });
    assert.strictEqual(badArg.status, 2);

    const sandboxed = spawnSync(process.execPath, [scriptPath, '--help'], {
        encoding: 'utf8',
        env: { ...cleanEnv, CODEX_SANDBOX: 'test-sandbox' }
    });
    assert.notStrictEqual(sandboxed.status, 0);
    assert.strictEqual(sandboxed.stdout, '');
});
