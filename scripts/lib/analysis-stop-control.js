'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const forbiddenRequests = new AsyncLocalStorage();
const active = new Set();
const CODE = 'ANALYSIS_STOP_REQUESTED';
const MODEL_REQUESTS_FORBIDDEN = 'MODEL_REQUESTS_FORBIDDEN_FOR_REPLAY';
let processStopReason = null;
function stopState(state, reason) {
    if (!state.stopped) { state.stopped = true; state.reason = reason; }
}
function handleSignal(signal) {
    processStopReason ||= signal;
    for (const state of active) stopState(state, signal);
}
const onTerm = () => handleSignal('SIGTERM');
const onInt = () => handleSignal('SIGINT');
function requestAnalysisStop(reason = 'operator') {
    const state = scope.getStore();
    if (state) stopState(state, reason);
}
function isAnalysisStopRequested() { return Boolean(processStopReason) || scope.getStore()?.stopped === true; }
function assertMayStartRequest() {
    if (forbiddenRequests.getStore() === true) {
        throw Object.assign(new Error('付费候选只读重放禁止发送新的模型请求。'), {
            code: MODEL_REQUESTS_FORBIDDEN, category: 'reader_recovery', scope: 'paper',
            retryable: false, modelRequestClassified: true
        });
    }
    const state = scope.getStore();
    // Shared workers may run outside the run's ALS context. A real process
    // signal still forbids their next request; ordinary run stops stay local.
    if (!processStopReason && !state?.stopped) return;
    const error = new Error('已请求停止分析；保留已返回内容，不再发送新的模型请求。');
    Object.assign(error, { code: CODE, category: 'run_stop', scope: 'run', retryable: false,
        modelRequestClassified: true, stopReason: processStopReason || state.reason });
    throw error;
}
function withModelRequestsForbidden(callback) { return forbiddenRequests.run(true, callback); }
async function withAnalysisStopControl(callback) {
    if (scope.getStore()) return callback();
    const state = { stopped: Boolean(processStopReason), reason: processStopReason };
    if (!active.size) {
        process.on('SIGTERM', onTerm);
        process.on('SIGINT', onInt);
    }
    active.add(state);
    try { return await scope.run(state, callback); }
    finally {
        active.delete(state);
        if (!active.size) {
            process.removeListener('SIGTERM', onTerm);
            process.removeListener('SIGINT', onInt);
        }
    }
}
module.exports = { CODE, MODEL_REQUESTS_FORBIDDEN, withModelRequestsForbidden,
    withAnalysisStopControl, requestAnalysisStop,
    isAnalysisStopRequested, assertMayStartRequest };
