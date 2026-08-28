'use strict';

function collectFailureMessages(value, output = []) {
    if (!value) return output;
    if (typeof value === 'string') {
        output.push(value);
        return output;
    }
    if (value instanceof Error) {
        output.push(value.message || String(value));
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFailureMessages(item, output);
        return output;
    }
    if (typeof value === 'object') {
        if (typeof value.error === 'string') output.push(value.error);
        if (typeof value.message === 'string') output.push(value.message);
        if (value.failures) collectFailureMessages(value.failures, output);
        if (value.methods) collectFailureMessages(Object.values(value.methods), output);
    }
    return output;
}

function classifyHostOutcome({ value, error } = {}) {
    const health = value?._sourceHealth || value?.health || value || error?.sourceHealth || null;
    const messages = collectFailureMessages([health, error]);
    const status = Number(value?.status ?? health?.status);
    const rateLimited = Number(health?.rateLimitWaitMs || 0) > 0
        || status === 429
        || messages.some(message => /(?:HTTP\s*)?429|rate.?limit/i.test(message));
    const hasFailures = messages.length > 0
        || health?.ok === false
        || (Number.isInteger(status) && status >= 400)
        || Number(health?.totalRetryWaitMs || 0) > 0;
    return {
        health,
        status: Number.isInteger(status) ? status : null,
        rateLimited,
        hasFailures,
        failed: Boolean(error) || health?.ok === false
            || (Number.isInteger(status) && status >= 400)
    };
}

function getAdaptiveHostCooldownMs(outcome, options = {}) {
    const healthyDelayMs = Math.max(0, options.healthyDelayMs ?? 10000);
    const transientDelayMs = Math.max(healthyDelayMs, options.transientDelayMs ?? 30000);
    const rateLimitedDelayMs = Math.max(transientDelayMs, options.rateLimitedDelayMs ?? 60000);
    const jitterMaxMs = Math.max(0, options.jitterMaxMs ?? 5000);
    const randomFn = options.randomFn || Math.random;
    const signal = classifyHostOutcome(outcome);
    const base = signal.rateLimited
        ? rateLimitedDelayMs
        : (signal.failed || signal.hasFailures ? transientDelayMs : healthyDelayMs);
    return base + Math.floor(randomFn() * jitterMaxMs);
}

function createHostTaskScheduler(options = {}) {
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const nowFn = options.nowFn || Date.now;
    const defaultCooldownAfter = options.cooldownAfter;
    const states = new Map();

    function getState(host) {
        if (!states.has(host)) {
            states.set(host, {
                tail: Promise.resolve(),
                nextEligibleAt: 0,
                tasks: 0,
                waitCount: 0,
                waitedMs: 0,
                cooldownScheduledMs: 0,
                outcomes: { healthy: 0, transient: 0, rateLimited: 0, failed: 0 }
            });
        }
        return states.get(host);
    }

    async function run(host, task, runOptions = {}) {
        if (typeof host !== 'string' || !host.trim()) throw new Error('fetch scheduler host 不能为空');
        if (typeof task !== 'function') throw new Error('fetch scheduler task 必须是函数');
        const state = getState(host.trim().toLowerCase());
        const previous = state.tail;
        let release;
        state.tail = new Promise(resolve => { release = resolve; });

        await previous;
        const waitMs = Math.max(0, state.nextEligibleAt - nowFn());
        if (waitMs > 0) {
            state.waitCount++;
            state.waitedMs += waitMs;
            await sleepFn(waitMs);
        }

        let value;
        let error;
        try {
            state.tasks++;
            value = await task();
            return value;
        } catch (caught) {
            error = caught;
            throw caught;
        } finally {
            try {
                const signal = classifyHostOutcome({ value, error });
                const outcomeKind = signal.rateLimited
                    ? 'rateLimited' : (signal.failed ? 'failed' : (signal.hasFailures ? 'transient' : 'healthy'));
                state.outcomes[outcomeKind]++;
                const cooldownAfter = runOptions.cooldownAfter ?? defaultCooldownAfter;
                const cooldownMs = typeof cooldownAfter === 'function'
                    ? cooldownAfter({ value, error, host })
                    : Number(runOptions.cooldownMs || 0);
                const normalizedCooldown = Math.max(0, Number.isFinite(cooldownMs) ? cooldownMs : 0);
                state.cooldownScheduledMs += normalizedCooldown;
                state.nextEligibleAt = nowFn() + normalizedCooldown;
            } finally {
                release();
            }
        }
    }

    return {
        run,
        defer(host, cooldownMs) {
            const state = getState(String(host || '').trim().toLowerCase());
            const normalizedCooldown = Math.max(0, Number.isFinite(cooldownMs) ? cooldownMs : 0);
            state.nextEligibleAt = Math.max(state.nextEligibleAt, nowFn() + normalizedCooldown);
        },
        getNextEligibleAt(host) {
            return getState(String(host || '').trim().toLowerCase()).nextEligibleAt;
        },
        getMetricsSnapshot() {
            return Object.fromEntries(Array.from(states.entries()).sort(([left], [right]) => left.localeCompare(right))
                .map(([host, state]) => [host, {
                    tasks: state.tasks,
                    waitCount: state.waitCount,
                    waitedMs: state.waitedMs,
                    cooldownScheduledMs: state.cooldownScheduledMs,
                    outcomes: { ...state.outcomes }
                }]));
        }
    };
}

module.exports = {
    classifyHostOutcome,
    getAdaptiveHostCooldownMs,
    createHostTaskScheduler
};
