'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { AsyncResource } = require('node:async_hooks');
const stop = require('../scripts/lib/analysis-stop-control');

// A shared worker can retain the AsyncResource it created before an analysis run.
// Exercise the public request guard through that resource, without real transport.
const childSource = String.raw`
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const { AsyncResource } = require('node:async_hooks');
const stop = require('./scripts/lib/analysis-stop-control');
const utils = require('./scripts/utils');
const retry = require('./scripts/lib/explicit-reader-retry-round');
const detached = new AsyncResource('reader-worker-created-before-run');
let transports = 0, reservations = 0, saves = 0, release;
const events = [];
const consume = retry.consumePhysicalRequest;
retry.consumePhysicalRequest = (...args) => { reservations++; return consume(...args); };
const endpoint = 'http://127.0.0.1:9/v1', model = 'ci-test-model';
const request = () => utils.requestLlmJson(
    utils.buildApiUrl(utils.detectApiType(endpoint, model), endpoint), endpoint, model,
    { model, max_tokens: 16, messages: [{ role: 'user', content: 'offline detached stop test' }] }, {},
    { recordUsage: false, usageSink: event => events.push(event), timeoutMs: 2000,
      transportRequestFn: async () => {
        transports++;
        if (transports === 1) {
          process.send({ type: 'started' });
          await new Promise(resolve => { release = resolve; });
        }
        return { statusCode: 200, body: { choices: [{ message: { content: 'returned before saving' } }] } };
      } });
const attempt = async callback => { try { await callback(); return null; } catch (error) {
  return { code: error.code, scope: error.scope, retryable: error.retryable, stopReason: error.stopReason };
} };
(async () => {
  const signal = process.argv[1];
  const signalSeen = new Promise(resolve => process.once(signal, resolve));
  let detachedError, forbiddenError, detachedStopped, returnedContent;
  await stop.withAnalysisStopControl(async () => {
    const inFlight = detached.runInAsyncScope(request);
    await signalSeen;
    detachedError = await detached.runInAsyncScope(() => attempt(request));
    detachedStopped = detached.runInAsyncScope(stop.isAnalysisStopRequested);
    forbiddenError = await detached.runInAsyncScope(() => stop.withModelRequestsForbidden(() => attempt(request)));
    release();
    returnedContent = (await inFlight).body.choices[0].message.content;
    saves++;
  });
  // Signal stop remains effective after the last run removes its listeners.
  const outsideError = await detached.runInAsyncScope(() => attempt(request));
  const laterRunError = await stop.withAnalysisStopControl(() => attempt(request));
  process.send({ type: 'result', detachedError, forbiddenError, detachedStopped, outsideError,
    laterRunError, transports, reservations, saves, events: events.map(event => event.outcome), returnedContent,
    listenersRemoved: process.listenerCount('SIGINT') === 0 && process.listenerCount('SIGTERM') === 0 });
  detached.emitDestroy();
  process.disconnect();
})().catch(error => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect(); });
`;

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} blocks detached queued requests before budget or transport and preserves in-flight saving`, { timeout: 10000 }, async () => {
        const child = spawn(process.execPath, ['-e', childSource, signal], {
            cwd: require('node:path').join(__dirname, '..'),
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        });
        let report, stderr = '';
        child.stderr.on('data', bytes => { stderr += bytes; });
        const outcome = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.on('message', message => {
                if (message.type === 'started') child.kill(signal);
                if (message.type === 'result') report = message;
            });
            child.once('exit', (code, caughtSignal) => resolve({ code, caughtSignal }));
        });
        assert.deepEqual(outcome, { code: 0, caughtSignal: null }, stderr);
        const expected = { code: stop.CODE, scope: 'run', retryable: false, stopReason: signal };
        assert.deepEqual(report.detachedError, expected);
        assert.equal(report.detachedStopped, true);
        assert.deepEqual(report.outsideError, expected);
        assert.deepEqual(report.laterRunError, expected);
        assert.equal(report.forbiddenError.code, stop.MODEL_REQUESTS_FORBIDDEN);
        assert.equal(report.forbiddenError.scope, 'paper');
        assert.equal(report.transports, 1);
        assert.equal(report.reservations, 1);
        assert.deepEqual(report.events, ['completed']);
        assert.equal(report.returnedContent, 'returned before saving');
        assert.equal(report.saves, 1);
        assert.equal(report.listenersRemoved, true);
    });
}

test('ordinary run stop, even with a signal-like reason, leaves detached and independent runs available', async () => {
    const detached = new AsyncResource('independent-worker');
    try {
        for (const reason of ['provider failure', 'SIGINT', 'SIGTERM']) {
            await stop.withAnalysisStopControl(async () => {
                stop.requestAnalysisStop(reason);
                assert.equal(stop.isAnalysisStopRequested(), true);
                assert.throws(stop.assertMayStartRequest, { code: stop.CODE, stopReason: reason });
                detached.runInAsyncScope(() => {
                    assert.equal(stop.isAnalysisStopRequested(), false);
                    assert.doesNotThrow(stop.assertMayStartRequest);
                });
                await detached.runInAsyncScope(() => stop.withAnalysisStopControl(async () => {
                    assert.equal(stop.isAnalysisStopRequested(), false);
                    assert.doesNotThrow(stop.assertMayStartRequest);
                }));
            });
        }
        stop.requestAnalysisStop('SIGTERM');
        assert.equal(stop.isAnalysisStopRequested(), false);
        assert.doesNotThrow(stop.assertMayStartRequest);
    } finally { detached.emitDestroy(); }
});
