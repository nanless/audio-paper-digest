'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildDailyUsageSummary,
    createUsageSummaryCache,
    formatText,
    formatJson,
    extractCost,
    accountKey,
    eventDate,
    beijingDateFromMs
} = require('../scripts/lib/llm-usage-summary.js');

const DATE_A = '2026-01-05';
const DATE_B = '2026-01-06';

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-summary-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

// 与真实 data/runtime/llm-usage 事件一致：只有 token 用量，没有 accountId/cost。
function usageEvent(overrides = {}) {
    return {
        version: 'llm-usage-v1',
        kind: 'request',
        eventId: crypto.randomUUID(),
        at: `${DATE_A}T10:00:00+08:00`,
        runtime: 'node',
        runId: null,
        paperId: '2601.00001',
        stage: 'primaryAnalysis',
        unitId: null,
        contentAttempt: null,
        transportAttempt: 1,
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        outcome: 'completed',
        statusCode: 200,
        errorCode: null,
        durationMs: 1200,
        inputSha256: 'a'.repeat(64),
        outputTextSha256: 'b'.repeat(64),
        estimates: { textCharacters: 100, estimatedInputTextTokens: 34, images: 0 },
        usage: { status: 'reported', inputSemantics: 'provider_reported', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        transportStarted: true,
        ...overrides
    };
}

function writeEvent(directory, event, mtime) {
    const filePath = path.join(directory, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(event));
    if (mtime !== undefined) {
        const value = new Date(mtime);
        fs.utimesSync(filePath, value, value);
    }
    return filePath;
}

function at(iso) {
    return new Date(iso);
}

describe('llm-usage-summary 日期过滤与聚合（真实事件 schema）', () => {
    it('按北京日期聚合成功与失败，不伪造账号/费用分组', t => {
        const directory = temporaryDirectory(t);
        writeEvent(directory, usageEvent({
            eventId: 'evt-1',
            stage: 'primaryAnalysis',
            model: 'muse-spark-1.3-contributor'
        }), at('2026-01-05T09:00:00+08:00'));
        writeEvent(directory, usageEvent({
            eventId: 'evt-2',
            stage: 'revision',
            model: 'mimo-v2.6-flash',
            outcome: 'http_error',
            errorCode: 'HTTP_429'
        }), at('2026-01-05T11:00:00+08:00'));
        writeEvent(directory, usageEvent({
            eventId: 'evt-3',
            stage: 'revision',
            model: 'mimo-v2.6-flash',
            outcome: 'incomplete'
        }), at('2026-01-05T23:59:00+08:00'));
        // 非 request 终态不计入调用数。
        writeEvent(directory, {
            version: 'llm-usage-v1',
            kind: 'request_started',
            eventId: 'evt-4',
            at: `${DATE_A}T12:00:00+08:00`,
            stage: 'primaryAnalysis',
            model: 'muse-spark-1.3-contributor'
        }, at('2026-01-05T12:00:00+08:00'));

        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        assert.strictEqual(summary.date, DATE_A);
        assert.strictEqual(summary.total, 3);
        assert.strictEqual(summary.success, 1);
        assert.strictEqual(summary.failed, 2);
        assert.strictEqual(summary.cost, 0);
        assert.strictEqual(summary.costEvents, 0);
        // 事件没有账号字段：不生成任何账号分组，也不伪造 unknown。
        assert.deepStrictEqual(summary.byAccount, {});
        assert.deepStrictEqual(summary.byStage.primaryAnalysis, {
            total: 1, success: 1, failed: 0, cost: 0, costEvents: 0
        });
        assert.deepStrictEqual(summary.byStage.revision, {
            total: 2, success: 0, failed: 2, cost: 0, costEvents: 0
        });
        assert.strictEqual(summary.byModel['muse-spark-1.3-contributor'].total, 1);
        assert.strictEqual(summary.byModel['mimo-v2.6-flash'].failed, 2);
        const text = formatText(summary);
        assert.match(text, /费用=无费用记录（仅有 token 用量）/);
        assert.match(text, /按账号: 不可得（事件未记录账号字段）/);
        assert.ok(!text.includes('unknown'));
    });

    it('用事件 at 决定日期，mtime 只控制读取范围', t => {
        const directory = temporaryDirectory(t);
        writeEvent(directory, usageEvent({
            eventId: 'date-a', at: `${DATE_A}T23:59:59+08:00`
        }), at('2026-01-05T23:59:59+08:00'));
        // 文件 mtime 落在 A 的读取窗口，但事件 at 属于 B：不应计入 A。
        writeEvent(directory, usageEvent({
            eventId: 'date-b', at: `${DATE_B}T00:00:01+08:00`
        }), at('2026-01-05T23:59:59+08:00'));
        // mtime 远在窗口外：即使事件 at 是 A 也不读。
        writeEvent(directory, usageEvent({
            eventId: 'far-away', at: `${DATE_A}T08:00:00+08:00`
        }), at('2026-03-01T08:00:00+08:00'));

        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        assert.strictEqual(summary.total, 1);
        assert.strictEqual(summary.scan.filesRead, 2);
        assert.ok(summary.scan.skippedByMtime >= 1);
        assert.strictEqual(summary.byStage.primaryAnalysis.total, 1);
        assert.strictEqual(eventDate(`${DATE_B}T00:00:01+08:00`), DATE_B);
    });

    it('同一 eventId 的重复事件只计一次', t => {
        const directory = temporaryDirectory(t);
        const event = usageEvent({ eventId: 'same-event' });
        writeEvent(directory, event, at('2026-01-05T10:00:00+08:00'));
        writeEvent(directory, event, at('2026-01-05T10:00:01+08:00'));
        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        assert.strictEqual(summary.total, 1);
    });
});

describe('llm-usage-summary 费用与账号字段兼容', () => {
    it('兼容 estimatedCost / cost / usage.cost 并统一金额精度', t => {
        const directory = temporaryDirectory(t);
        const accountA = 'a'.repeat(64);
        const accountB = 'b'.repeat(64);
        writeEvent(directory, usageEvent({ eventId: 'cost-1', accountId: accountA, estimatedCost: 0.25 }),
            at('2026-01-05T09:00:00+08:00'));
        writeEvent(directory, usageEvent({ eventId: 'cost-2', accountId: accountB, cost: { usd: 1.5 } }),
            at('2026-01-05T10:00:00+08:00'));
        writeEvent(directory, usageEvent({
            eventId: 'cost-3', accountId: 'acct-c', usage: { status: 'reported', cost: 0.05 }
        }), at('2026-01-05T11:00:00+08:00'));

        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        assert.strictEqual(summary.cost, 1.8);
        assert.strictEqual(summary.costEvents, 3);
        assert.strictEqual(summary.byAccount[accountA].total, 1);
        assert.strictEqual(summary.byAccount[accountB].total, 1);
        const fingerprinted = Object.keys(summary.byAccount).filter(key => key.startsWith('sha256:'));
        assert.strictEqual(fingerprinted.length, 1);
        assert.match(fingerprinted[0], /^sha256:[a-f0-9]{16}$/);
        assert.ok(!Object.prototype.hasOwnProperty.call(summary.byAccount, 'unknown'));
        const text = formatText(summary);
        assert.match(text, /按账号:/);
        assert.match(text, /费用=\$1\.80/);
    });

    it('bucket cost 统一到 8 位小数，避免浮点尾差', t => {
        const directory = temporaryDirectory(t);
        writeEvent(directory, usageEvent({ eventId: 'precision-1', estimatedCost: 0.1 }),
            at('2026-01-05T09:00:00+08:00'));
        writeEvent(directory, usageEvent({ eventId: 'precision-2', estimatedCost: 0.2 }),
            at('2026-01-05T10:00:00+08:00'));
        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        assert.strictEqual(summary.cost, 0.3);
        assert.strictEqual(summary.byStage.primaryAnalysis.cost, 0.3);
    });

    it('账号键只接受 64 位 hex；缺失返回 null，其余转不可逆短指纹', () => {
        const hex = 'A'.repeat(64);
        assert.strictEqual(accountKey({ accountId: hex }), hex.toLowerCase());
        assert.strictEqual(accountKey({ accountId: 'acct-a' }).startsWith('sha256:'), true);
        assert.match(accountKey({ accountId: 'acct-a' }), /^sha256:[a-f0-9]{16}$/);
        assert.strictEqual(accountKey({}), null);
        assert.strictEqual(accountKey({ accountId: '' }), null);
        assert.strictEqual(accountKey({ accountId: { value: 'x' } }), null);
        assert.strictEqual(extractCost({ estimatedCost: 0.25 }), 0.25);
        assert.strictEqual(extractCost({ cost: { usd: 1.5 } }), 1.5);
        assert.strictEqual(extractCost({ usage: { cost: 0.05 } }), 0.05);
        assert.strictEqual(extractCost({ usage: { status: 'reported', inputTokens: 99 } }), null);
        assert.strictEqual(extractCost({ estimatedCost: '0.125' }), 0.125);
        assert.strictEqual(extractCost({}), null);
    });
});

describe('llm-usage-summary 大目录缓存与增量读取', () => {
    it('目录未变时命中缓存，新增文件只做增量解析', t => {
        const directory = temporaryDirectory(t);
        const cache = createUsageSummaryCache();
        writeEvent(directory, usageEvent({ eventId: 'first' }), at('2026-01-05T10:00:00+08:00'));
        writeEvent(directory, usageEvent({ eventId: 'second' }), at('2026-01-05T10:05:00+08:00'));
        // 固定目录 mtime，让“目录未变”的判定与文件写入时序无关。
        const fixed = new Date('2026-01-05T10:06:00+08:00');
        fs.utimesSync(directory, fixed, fixed);

        const first = buildDailyUsageSummary({ directory, date: DATE_A, cache });
        assert.strictEqual(first.total, 2);
        assert.strictEqual(first.scan.cacheHit, false);
        assert.strictEqual(first.scan.filesRead, 2);

        const second = buildDailyUsageSummary({ directory, date: DATE_A, cache });
        assert.strictEqual(second.total, 2);
        assert.strictEqual(second.scan.cacheHit, true);
        assert.strictEqual(second.scan.filesRead, 0);

        writeEvent(directory, usageEvent({ eventId: 'third' }), at('2026-01-05T10:07:00+08:00'));
        const bumped = new Date('2026-01-05T10:08:00+08:00');
        fs.utimesSync(directory, bumped, bumped);

        const third = buildDailyUsageSummary({ directory, date: DATE_A, cache });
        assert.strictEqual(third.total, 3);
        assert.strictEqual(third.scan.cacheHit, false);
        assert.strictEqual(third.scan.filesStatted, 1);
        assert.strictEqual(third.scan.filesRead, 1);
    });

    it('缺目录时返回空汇总而不是抛出', () => {
        const summary = buildDailyUsageSummary({
            directory: path.join(os.tmpdir(), `missing-usage-${crypto.randomUUID()}`),
            date: DATE_A,
            cache: createUsageSummaryCache()
        });
        assert.strictEqual(summary.total, 0);
        assert.strictEqual(summary.cost, 0);
        assert.deepStrictEqual(summary.byAccount, {});
        assert.strictEqual(summary.scan.directoryMissing, true);
    });
});

describe('llm-usage-summary 文本输出', () => {
    it('formatText/formatJson 输出日期、总量与分组', t => {
        const directory = temporaryDirectory(t);
        writeEvent(directory, usageEvent({}), at('2026-01-05T09:00:00+08:00'));
        const summary = buildDailyUsageSummary({ directory, date: DATE_A });
        const text = formatText(summary);
        assert.match(text, /\[llm-usage\] 2026-01-05/);
        assert.match(text, /调用=1 成功=1 失败=0/);
        assert.match(text, /费用=无费用记录/);
        assert.match(text, /按阶段/);
        assert.match(text, /按模型/);
        assert.match(text, /按账号: 不可得/);
        const parsed = JSON.parse(formatJson(summary));
        assert.strictEqual(parsed.date, DATE_A);
        assert.strictEqual(parsed.total, 1);
        assert.strictEqual(parsed.byStage.primaryAnalysis.total, 1);
        assert.deepStrictEqual(parsed.byAccount, {});
        assert.ok(formatJson(summary).includes('\n') === false);
    });

    it('默认日期取注入时钟的北京日期', t => {
        const directory = temporaryDirectory(t);
        writeEvent(directory, usageEvent({}), at('2026-01-05T10:00:00+08:00'));
        const summary = buildDailyUsageSummary({
            directory,
            nowMs: Date.parse('2026-01-05T23:00:00+08:00'),
            cache: createUsageSummaryCache()
        });
        assert.strictEqual(summary.date, DATE_A);
        assert.strictEqual(summary.total, 1);
        assert.strictEqual(beijingDateFromMs(Date.parse('2026-01-05T23:00:00+08:00')), DATE_A);
    });
});
