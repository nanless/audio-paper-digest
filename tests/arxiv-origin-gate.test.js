'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ArxivOriginGate, MAX_CONCURRENCY, resolveMaxConcurrency } = require('../scripts/lib/arxiv-origin-gate');

test('ArxivOriginGate direct handoff prevents concurrent oversubscription across microtasks', async () => {
    const gate = new ArxivOriginGate({ maxConcurrency: 2 });
    let inFlight = 0;
    let peak = 0;

    const tasks = Array.from({ length: 12 }, (_, idx) => gate.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield multiple microtasks and a timer to invite race conditions on release().
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, idx % 3));
        inFlight -= 1;
        return idx;
    }));

    const results = await Promise.all(tasks);
    assert.equal(results.length, 12);
    assert.equal(inFlight, 0);
    assert.equal(peak, 2);
});

test('ArxivOriginGate respects dynamic limit shrinking without oversubscribing', async () => {
    const gate = new ArxivOriginGate({ maxConcurrency: 3 });
    let inFlight = 0;
    let peakAfterShrink = 0;
    const resolvers = [];

    const startTask = (recordShrinkPeak = false) => gate.run(async () => {
        inFlight += 1;
        if (recordShrinkPeak) peakAfterShrink = Math.max(peakAfterShrink, inFlight);
        await new Promise(resolve => resolvers.push(resolve));
        inFlight -= 1;
    });

    const flush = () => new Promise(resolve => setImmediate(resolve));

    const p1 = startTask();
    const p2 = startTask();
    const p3 = startTask();
    await flush();
    assert.equal(inFlight, 3);

    // Shrink limit to 1 while 3 slots are active and enqueue 2 waiters.
    gate.maxConcurrency = 1;
    const p4 = startTask(true);
    const p5 = startTask(true);
    await flush();

    // Release 2 of the 3 active tasks -> active drops to 1; waiters must NOT start yet!
    resolvers.shift()();
    resolvers.shift()();
    await flush();
    assert.equal(inFlight, 1);
    assert.equal(peakAfterShrink, 0);

    // Release the 3rd active task -> now p4 starts with inFlight === 1.
    resolvers.shift()();
    await flush();
    assert.equal(inFlight, 1);
    assert.equal(peakAfterShrink, 1);

    resolvers.shift()();
    await flush();
    assert.equal(inFlight, 1);
    assert.equal(peakAfterShrink, 1);

    resolvers.shift()();
    await Promise.all([p1, p2, p3, p4, p5]);
    assert.equal(inFlight, 0);
});

test('resolveMaxConcurrency caps PD_ARXIV_MAX_CONCURRENCY at 6', t => {
    const saved = process.env.PD_ARXIV_MAX_CONCURRENCY;
    t.after(() => {
        if (saved === undefined) delete process.env.PD_ARXIV_MAX_CONCURRENCY;
        else process.env.PD_ARXIV_MAX_CONCURRENCY = saved;
    });
    assert.equal(MAX_CONCURRENCY, 6);
    process.env.PD_ARXIV_MAX_CONCURRENCY = '6';
    assert.equal(resolveMaxConcurrency(), 6);
    process.env.PD_ARXIV_MAX_CONCURRENCY = '7';
    assert.equal(resolveMaxConcurrency(), 3);
    process.env.PD_ARXIV_MAX_CONCURRENCY = '8';
    assert.equal(resolveMaxConcurrency(), 3);
});
