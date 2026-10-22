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
