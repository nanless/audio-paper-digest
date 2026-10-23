'use strict';
const test = require('node:test');
const assert = require('node:assert');
const policy = require('../scripts/lib/source-acquisition-policy');

function beijingMs(date, hour) {
    return Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`);
}

test('超时/论文编号不会误判为 arXiv 5xx/429', () => {
    const policy = require('../scripts/lib/source-acquisition-policy');
    assert.ok(!String(policy.fetchFailureAdvice(new Error('请求超过 15000ms 的总等待时间')) || '').includes('5xx'));
    assert.ok(!String(policy.fetchFailureAdvice(new Error('论文 2410.14290 分析失败')) || '').includes('限流'));
    assert.ok(String(policy.fetchFailureAdvice(new Error('HTTP 429 Too Many Requests')) || '').includes('限流'));
});

test('抓取预检：当天早于 8 点提醒公告未生成', () => {
    const warnings = policy.preflightWarnings({ date: '2026-10-21', nowMs: beijingMs('2026-10-21', 7) });
    assert.strictEqual(warnings[0].level, 'warn');
    assert.match(warnings[0].message, /08:00/);
});

test('抓取预检：历史日期/未来日期分别提示', () => {
    const history = policy.preflightWarnings({ date: '2026-10-01', nowMs: beijingMs('2026-10-21', 9) });
    assert.strictEqual(history[0].level, 'info');
    const future = policy.preflightWarnings({ date: '2026-11-01', nowMs: beijingMs('2026-10-21', 9) });
    assert.strictEqual(future[0].level, 'warn');
});

test('抓取失败建议覆盖 429/5xx/RSS', () => {
    assert.match(policy.fetchFailureAdvice(new Error('HTTP 429 Too Many Requests'))[0], /限流/);
    assert.match(policy.fetchFailureAdvice(new Error('503 Service Unavailable'))[0], /5xx/);
    assert.match(policy.fetchFailureAdvice(new Error('RSS 公告未生成'))[0], /公告/);
    assert.deepStrictEqual(policy.fetchFailureAdvice(new Error('其他错误')), []);
});

test('5xx和过期RSS建议不能把官方OAI恢复说成可任意切换', () => {
    for (const message of ['HTTP 503 Service Unavailable', 'RSS stale pubDate']) {
        const advice = policy.fetchFailureAdvice(new Error(message)).join('\n');
        assert.doesNotMatch(advice, /可改用|必要时用 --official-oai-recovery/);
        assert.match(advice, /Atom.*日期.*分类前缀.*429/);
    }
});
