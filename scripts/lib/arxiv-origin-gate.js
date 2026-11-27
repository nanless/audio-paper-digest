'use strict';

/**
 * 进程内全局 arXiv 源站并发与共享 Retry-After 冷却门禁。
 *
 * 所有 arXiv HTML / PDF / 原图抓取共用这一门禁，防止多篇并发时彼此放大 429/403 限流风暴。
 */

const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;
const MAX_COOLDOWN_MS = 120_000;

function resolveMaxConcurrency() {
    const raw = Number.parseInt(String(process.env.PD_ARXIV_MAX_CONCURRENCY || ''), 10);
    if (Number.isInteger(raw) && raw >= 1 && raw <= MAX_CONCURRENCY) return raw;
    return DEFAULT_MAX_CONCURRENCY;
}

function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
    const raw = String(headerValue || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
        return Math.min(MAX_COOLDOWN_MS, Math.max(0, Number.parseInt(raw, 10) * 1000));
    }
    const parsedDate = Date.parse(raw);
    if (Number.isFinite(parsedDate)) {
        return Math.min(MAX_COOLDOWN_MS, Math.max(0, parsedDate - nowMs));
    }
    return null;
}

class ArxivOriginGate {
    constructor(options = {}) {
        this.maxConcurrency = Number.isInteger(options.maxConcurrency) && options.maxConcurrency >= 1
            ? options.maxConcurrency
            : null;
        this.active = 0;
        this.queue = [];
        this.cooldownUntilMs = 0;
    }

    recordCooldown(waitMs, nowMs = Date.now()) {
        if (!Number.isFinite(waitMs) || waitMs <= 0) return 0;
        const bounded = Math.min(MAX_COOLDOWN_MS, Math.ceil(waitMs));
        const target = nowMs + bounded;
        if (target > this.cooldownUntilMs) {
            this.cooldownUntilMs = target;
        }
        return this.cooldownUntilMs - nowMs;
    }

    recordRateLimitResponse(headers, fallbackMs = 8000, nowMs = Date.now()) {
        const retryAfter = headers && typeof headers.get === 'function'
            ? headers.get('retry-after')
            : (headers?.['retry-after'] || headers?.['Retry-After'] || null);
        const parsed = parseRetryAfterMs(retryAfter, nowMs);
        const waitMs = parsed !== null ? Math.max(parsed, 1000) : fallbackMs;
        return this.recordCooldown(waitMs, nowMs);
    }

    remainingCooldownMs(nowMs = Date.now()) {
        return Math.max(0, this.cooldownUntilMs - nowMs);
    }

    async acquire(sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms))) {
        let acquired = false;
        while (!acquired) {
            const limit = Number.isInteger(this.maxConcurrency) && this.maxConcurrency >= 1
                ? this.maxConcurrency
                : resolveMaxConcurrency();
            if (this.active < limit) {
                this.active += 1;
                acquired = true;
            } else {
                const handedOff = await new Promise(resolve => this.queue.push(resolve));
                if (handedOff === true) {
                    acquired = true;
                }
            }
        }
        try {
            while (true) {
                const remain = this.remainingCooldownMs();
                if (remain <= 0) break;
                await sleepFn(remain);
            }
        } catch (err) {
            this.release();
            throw err;
        }
    }

    release() {
        const limit = Number.isInteger(this.maxConcurrency) && this.maxConcurrency >= 1
            ? this.maxConcurrency
            : resolveMaxConcurrency();
        if (this.active > 0) this.active -= 1;
        while (this.queue.length > 0 && this.active < limit) {
            const next = this.queue.shift();
            if (typeof next === 'function') {
                this.active += 1;
                next(true);
            }
        }
    }

    async run(fn, sleepFn) {
        await this.acquire(sleepFn);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    resetForTests() {
        this.cooldownUntilMs = 0;
    }
}

const sharedArxivOriginGate = new ArxivOriginGate();

module.exports = {
    ArxivOriginGate,
    sharedArxivOriginGate,
    parseRetryAfterMs,
    resolveMaxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
    MAX_CONCURRENCY,
    MAX_COOLDOWN_MS
};
