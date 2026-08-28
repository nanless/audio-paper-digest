const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    classifyHostOutcome,
    getAdaptiveHostCooldownMs,
    createHostTaskScheduler
} = require('../scripts/lib/fetch-scheduler.js');

describe('host-level adaptive fetch scheduler', () => {
    it('同 host 串行并应用健康冷却，不阻塞其他 host', async () => {
        let now = 1000;
        const sleeps = [];
        const events = [];
        const scheduler = createHostTaskScheduler({
            nowFn: () => now,
            sleepFn: async ms => {
                sleeps.push(ms);
                now += ms;
            }
        });

        const firstArxiv = scheduler.run('arxiv.org', async () => {
            events.push('arxiv-1');
            return { _sourceHealth: { ok: true, failures: [] } };
        }, { cooldownMs: 10000 });
        const secondArxiv = scheduler.run('arxiv.org', async () => {
            events.push('arxiv-2');
        });
        const huggingface = scheduler.run('huggingface.co', async () => {
            events.push('hf');
        });

        await Promise.all([firstArxiv, secondArxiv, huggingface]);
        assert.ok(events.indexOf('arxiv-2') > events.indexOf('arxiv-1'));
        assert.ok(events.indexOf('hf') < events.indexOf('arxiv-2'));
        assert.deepStrictEqual(sleeps, [10000]);
    });

    it('健康、瞬时失败和限流信号产生递增冷却', () => {
        const options = {
            healthyDelayMs: 10000,
            transientDelayMs: 30000,
            rateLimitedDelayMs: 60000,
            jitterMaxMs: 5000,
            randomFn: () => 0
        };
        assert.strictEqual(getAdaptiveHostCooldownMs({
            value: { _sourceHealth: { ok: true, failures: [] } }
        }, options), 10000);
        assert.strictEqual(getAdaptiveHostCooldownMs({
            value: { _sourceHealth: { ok: true, failures: [{ error: 'temporary reset' }] } }
        }, options), 30000);
        assert.strictEqual(getAdaptiveHostCooldownMs({
            value: { _sourceHealth: { ok: true, rateLimitWaitMs: 1 } }
        }, options), 60000);
    });

    it('递归识别子阶段 429，并把任务异常视为失败', () => {
        assert.strictEqual(classifyHostOutcome({
            value: { _sourceHealth: { methods: { recent: { failures: [{ error: 'HTTP 429' }] } } } }
        }).rateLimited, true);
        assert.strictEqual(classifyHostOutcome({ value: { status: 429 } }).rateLimited, true);
        assert.strictEqual(classifyHostOutcome({ error: new Error('network down') }).failed, true);
    });

    it('默认策略把真实 HTTP 结果转成健康/失败/限流冷却并记录实际等待', async () => {
        let now = 0;
        const sleeps = [];
        const cooldownOptions = {
            healthyDelayMs: 1000,
            transientDelayMs: 5000,
            rateLimitedDelayMs: 60000,
            jitterMaxMs: 0
        };
        const scheduler = createHostTaskScheduler({
            nowFn: () => now,
            sleepFn: async ms => { sleeps.push(ms); now += ms; },
            cooldownAfter: outcome => getAdaptiveHostCooldownMs(outcome, cooldownOptions)
        });
        await scheduler.run('arxiv.org', async () => ({ status: 200 }));
        await scheduler.run('arxiv.org', async () => ({ status: 503 }));
        await scheduler.run('arxiv.org', async () => ({ status: 429 }));
        await scheduler.run('arxiv.org', async () => ({ status: 200 }));

        assert.deepStrictEqual(sleeps, [1000, 5000, 60000]);
        assert.deepStrictEqual(scheduler.getMetricsSnapshot()['arxiv.org'], {
            tasks: 4,
            waitCount: 3,
            waitedMs: 66000,
            cooldownScheduledMs: 67000,
            outcomes: { healthy: 2, transient: 0, rateLimited: 1, failed: 1 }
        });
    });
});
