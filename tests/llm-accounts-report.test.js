'use strict';
const test = require('node:test');
const assert = require('node:assert');
const report = require('../scripts/llm-accounts-report');

test('describe 显示账号、冷却、活动组且不泄露原始 id', () => {
    const now = 1_700_000_000_000;
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const state = {
        services: {
            service1: {
                accounts: {
                    [idA]: { status: 'eligible', lastSelectedAtMs: now - 1000 },
                    [idB]: { status: 'quota_blocked', blockedUntilMs: now + 60_000 }
                },
                groups: { group1: { activeAccountId: idA, rotationCursor: 1 } }
            }
        }
    };
    const result = report.describe(state, now);
    assert.strictEqual(result.accountCount, 2);
    assert.strictEqual(result.cooling, 1);
    assert.ok(result.earliest);
    const rowA = result.rows.find(row => row.account === '账号 1');
    assert.ok(rowA, '账号只显示序号，不显示指纹');
    assert.deepStrictEqual(rowA.groups, ['组 1']);
    assert.ok(!JSON.stringify(result).includes(idA), '不得输出完整账号 id');
});

test('readState 处理缺失与损坏', () => {
    const missing = report.readState('/tmp/definitely-missing-pool-state.json');
    assert.strictEqual(missing.state, null);
    assert.strictEqual(missing.error, null);
    assert.strictEqual(missing.error, null);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pool = require('../scripts/llm-account-pool');
const NOW = 1_700_000_000_000;
const endpoint = 'https://opencode.ai/zen/go/v1';
const fakeKeys = Array.from({ length: 8 }, (_, index) => `fake-account-${index + 1}`);
function configuredEnv(extra = {}) {
    return { PAPER_ANALYZER_ENDPOINT: endpoint, PAPER_ANALYZER_API_KEY: fakeKeys[0],
        PAPER_ANALYZER_FALLBACK_API_KEYS: fakeKeys.slice(1, 7).join(','),
        PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY: fakeKeys[7], PAPER_ANALYZER_MODEL: 'fake-main',
        PAPER_ANALYZER_SECONDARY_MODEL: 'fake-secondary', ...extra };
}
function historicalState() {
    const identity = pool.getPoolIdentity([...fakeKeys, 'retired-fake-account'], endpoint);
    return { schemaVersion: 1, policyVersion: pool.POLICY_VERSION, generation: 4, services: {
        [identity.serviceId]: { endpoint: identity.service, accounts: Object.fromEntries(identity.accountIds.map((id, i) =>
            [id, { status: i === 0 || i === 8 ? 'quota_blocked' : 'eligible', blockedUntilMs: i === 0 || i === 8 ? NOW + 60_000 : 0 }])), groups: {} }
    } };
}

test('当前配置8与历史9独立分账，保留历史冷却且不显示凭据身份', () => {
    const state = historicalState(), before = JSON.stringify(state);
    const result = report.describeConfigured(configuredEnv(), state, NOW);
    assert.strictEqual(result.version, 2);
    assert.strictEqual(result.configured.accountCount, 8);
    assert.deepStrictEqual(result.configured.routes.map(route => route.accountCount), [8, 8]);
    assert.strictEqual(result.configured.cooling, 1);
    assert.strictEqual(result.configured.observedCount, 8);
    assert.strictEqual(result.observedHistory.accountCount, 9);
    assert.strictEqual(result.observedHistory.cooling, 2);
    assert.strictEqual(JSON.stringify(state), before);
    for (const secret of [...fakeKeys, 'retired-fake-account', endpoint,
        ...pool.getPoolIdentity([...fakeKeys, 'retired-fake-account'], endpoint).accountIds]) {
        assert.ok(!JSON.stringify(result).includes(secret));
    }
    assert.strictEqual(result.quotaObservation, 'stored_cooldown_only');
});

test('缺状态仍准确显示配置，副模型显式key和fallback遵循公共resolver', () => {
    const inherited = report.describeConfigured(configuredEnv(), null, NOW);
    assert.strictEqual(inherited.configured.accountCount, 8);
    assert.strictEqual(inherited.configured.unobservedCount, 8);
    assert.strictEqual(inherited.observedHistory.state, 'missing');
    const explicit = report.describeConfigured(configuredEnv({ PAPER_ANALYZER_SECONDARY_API_KEY: 'fake-separate' }), null, NOW);
    assert.strictEqual(explicit.configured.accountCount, 9);
    assert.deepStrictEqual(explicit.configured.routes.map(route => route.accountCount), [8, 1]);
    const fallback = report.describeConfigured(configuredEnv({ PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'fake-extra' }), null, NOW);
    assert.deepStrictEqual(fallback.configured.routes.map(route => route.accountCount), [8, 2]);
    assert.strictEqual(fallback.configured.accountCount, 9);
    const disabled = report.describeConfigured(configuredEnv({ PAPER_ANALYZER_SECONDARY_MODEL: '', PAPER_ANALYZER_SECONDARY_API_KEY: 'unused-fake' }), null, NOW);
    assert.strictEqual(disabled.configured.accountCount, 8);
    assert.strictEqual(disabled.configured.routes[1].enabled, false);
});

test('公共副模型解析包括tertiary继承与跨服务显式身份检查', () => {
    const primary = pool.resolvePrimaryApiKeyPool(fakeKeys[0], fakeKeys.slice(1, 7), fakeKeys[7]);
    const options = { primaryEndpoint: endpoint, primaryKey: fakeKeys[0], primaryApiKeys: primary, secondaryModel: 'fake' };
    assert.deepStrictEqual(pool.resolveSecondaryApiKeys(options), fakeKeys);
    assert.throws(() => pool.resolveSecondaryApiKeys({ ...options, secondaryEndpoint: 'https://other.test/v1' }),
        error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR');
    assert.deepStrictEqual(pool.resolveSecondaryApiKeys({ ...options, secondaryEndpoint: 'https://other.test/v1', secondaryKey: 'other-fake' }), ['other-fake']);
});

function cliFixture(t, env, state) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-report-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const filename of ['scripts/llm-accounts-report.js', 'scripts/llm-account-pool.js', 'scripts/env-loader.js',
        'scripts/utils.js', 'scripts/config.js', 'scripts/lib/active-time-budget.js',
        'scripts/lib/analysis-section-titles.js', 'scripts/lib/filter-decision.js',
        'scripts/lib/tag-rules.js', 'scripts/lib/tag-catalog.js', 'config/tag-catalog.json']) {
        fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
        fs.copyFileSync(path.join(__dirname, '..', filename), path.join(root, filename));
    }
    fs.writeFileSync(path.join(root, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
    const stateFile = path.join(root, 'state.json');
    if (state !== undefined) fs.writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state));
    const childEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir() };
    return { root, stateFile, run(extra = {}, outputArgs = ['--json']) {
        return spawnSync(process.execPath, [path.join(root, 'scripts/llm-accounts-report.js'), ...outputArgs, '--state', stateFile],
            { encoding: 'utf8', env: { ...childEnv, ...extra }, timeout: 5000 });
    } };
}

test('真实CLI缺状态JSON展示配置且零建状态，原guard先拒绝', t => {
    const fixture = cliFixture(t, configuredEnv(), undefined);
    const result = fixture.run();
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).configured.accountCount, 8);
    assert.strictEqual(fs.existsSync(fixture.stateFile), false);
    assert.strictEqual(fs.existsSync(path.join(fixture.root, 'data')), false);
    const denied = fixture.run({ CODEX_SANDBOX: 'test-sandbox' });
    assert.notStrictEqual(denied.status, 0);
    assert.strictEqual(denied.stdout, '');
});

test('真实CLI配置和历史分账不改状态，坏状态仍可报告配置且不回显原错误', t => {
    const fixture = cliFixture(t, configuredEnv(), historicalState());
    const before = fs.readFileSync(fixture.stateFile);
    const result = fixture.run();
    assert.strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.configured.accountCount, 8);
    assert.strictEqual(parsed.observedHistory.accountCount, 9);
    assert.deepStrictEqual(fs.readFileSync(fixture.stateFile), before);
    fs.writeFileSync(fixture.stateFile, 'not-json private-fake-account');
    const corrupt = fixture.run();
    assert.strictEqual(corrupt.status, 1);
    assert.strictEqual(JSON.parse(corrupt.stdout).configured.accountCount, 8);
    assert.strictEqual(JSON.parse(corrupt.stdout).observedHistory.state, 'unreadable');
    assert.ok(!(corrupt.stdout + corrupt.stderr).includes('private-fake-account'));
    fs.writeFileSync(fixture.stateFile, 'null');
    const nullState = fixture.run();
    assert.strictEqual(nullState.status, 1);
    assert.strictEqual(JSON.parse(nullState.stdout).observedHistory.state, 'invalid');
    assert.strictEqual(JSON.parse(nullState.stdout).observedHistory.accountCount, null);
});

test('实际CLI文本也区分配置和历史，不把历史冷却当当前池', t => {
    const fixture = cliFixture(t, configuredEnv(), historicalState());
    const result = fixture.run({}, []);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /当前配置：8 个不同凭据/);
    assert.match(result.stdout, /历史观察：9 条/);
    for (const key of fakeKeys) assert.ok(!result.stdout.includes(key));
    assert.ok(!result.stdout.includes('https://'));
});

test('非法配置和未知历史字段不能输出凭据或宣称实时可用', () => {
    const bad = report.describeConfigured(configuredEnv({ PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://unshared.test/v1' }), null, NOW);
    assert.strictEqual(bad.configured.status, 'invalid');
    assert.strictEqual(bad.configured.accountCount, null);
    const duplicate = report.describeConfigured(configuredEnv({ PAPER_ANALYZER_FALLBACK_API_KEYS: fakeKeys[0] }), null, NOW);
    assert.strictEqual(duplicate.configured.status, 'invalid');
    const state = historicalState();
    const service = Object.values(state.services)[0];
    for (const record of Object.values(service.accounts)) record.status = 'private-fake-account https://secret.test';
    const result = report.describeConfigured(configuredEnv(), state, NOW + 120_000);
    assert.strictEqual(result.configured.cooling, 0);
    assert.strictEqual(result.quotaObservation, 'stored_cooldown_only');
    assert.ok(!JSON.stringify(result).includes('private-fake-account'));
    assert.ok(!JSON.stringify(result).includes('https://secret.test'));
    assert.strictEqual(report.describeConfigured(configuredEnv(), { services: {} }, NOW).observedHistory.state, 'invalid');
});

test('账号报告和真实公共endpoint门一致拒公网HTTP而保留本机测试HTTP', () => {
    const one = configuredEnv({ PAPER_ANALYZER_FALLBACK_API_KEYS: '', PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY: '',
        PAPER_ANALYZER_SECONDARY_MODEL: '' });
    const publicHttp = report.describeConfigured({ ...one, PAPER_ANALYZER_ENDPOINT: 'http://example.test/v1' }, null, NOW);
    assert.strictEqual(publicHttp.configured.status, 'invalid');
    const localHttp = report.describeConfigured({ ...one, PAPER_ANALYZER_ENDPOINT: 'http://127.0.0.1:9000/v1' }, null, NOW);
    assert.strictEqual(localHttp.configured.status, 'configured');
});
