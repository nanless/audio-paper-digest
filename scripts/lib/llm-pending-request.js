'use strict';
// 发送前仅保存经过现有隐私白名单过滤的元数据，不证明请求已被服务商接收。
const crypto = require('node:crypto');
const usage = require('./llm-usage');
function beginPendingLlmRequest(input, options = {}) {
    const eventId = crypto.randomUUID();
    const at = new Date().toISOString();
    const terminalShape = usage.buildLlmUsageEvent({ ...input, eventId, at, transportStarted: true });
    const event = {
        version: usage.VERSION, kind: 'request_started', eventId, at, runtime: 'node',
        runId: terminalShape.runId, paperId: terminalShape.paperId,
        stage: terminalShape.stage, unitId: terminalShape.unitId,
        contentAttempt: terminalShape.contentAttempt, transportAttempt: terminalShape.transportAttempt,
        protocol: terminalShape.protocol, model: terminalShape.model,
        inputSha256: terminalShape.inputSha256, estimates: terminalShape.estimates,
        phase: 'authorized_before_transport', outcome: 'result_unknown', chargeState: 'unknown'
    };
    try {
        const persisted = usage.writeLlmUsageEvent(event, options);
        return { eventId, at, persisted, event };
    } catch (cause) {
        const error = new Error('模型请求发送前的持久记录无法保存，尚未调用传输层', { cause });
        error.code = 'LLM_REQUEST_START_NOT_PERSISTED';
        error.pendingRequestEventId = eventId;
        error.category = 'config'; error.scope = 'run';
        error.retryable = false; error.modelRequestClassified = true;
        throw error;
    }
}
function orphanedPendingLlmRequests(events = [], pairingEvents = events) {
    const finished = new Map();
    for (const event of pairingEvents) if (event?.version === usage.VERSION && event.kind === 'request') {
        const list=finished.get(event.eventId)||[]; list.push(event); finished.set(event.eventId,list);
    }
    const seen = new Set();
    const labels = ['runId', 'paperId', 'stage', 'unitId', 'contentAttempt', 'transportAttempt',
        'protocol', 'model', 'inputSha256'];
    return events.filter(event => {
        if (event?.version !== usage.VERSION || event.kind !== 'request_started'
            || !/^[a-f0-9-]{36}$/.test(String(event.eventId || '')) || seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return !(finished.get(event.eventId)||[]).some(end => labels.every(key => (end[key] ?? null) === (event[key] ?? null)));
    }).map(event => {
        const clean = usage.buildLlmUsageEvent({ context: event, protocol: event.protocol,
            model: event.model, request: {}, eventId: event.eventId });
        return { version: usage.VERSION, kind: 'request_started', eventId: event.eventId,
            at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(event.at || '')) ? event.at : null,
            runtime: event.runtime === 'python' ? 'python' : 'node', ...Object.fromEntries(labels.filter(key => key !== 'inputSha256')
                .map(key => [key, clean[key] ?? null])),
            inputSha256: /^[a-f0-9]{64}$/.test(String(event.inputSha256 || '')) ? event.inputSha256 : null,
            phase: 'authorized_before_transport', outcome: 'result_unknown', chargeState: 'unknown' };
    });
}
module.exports = { beginPendingLlmRequest, orphanedPendingLlmRequests };
