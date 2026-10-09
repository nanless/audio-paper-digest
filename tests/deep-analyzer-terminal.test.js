const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callModelWithConfig } = require('../scripts/deep-analyzer.js');

const protocols = [
    { name: 'Chat', model: 'test-model', endpoint: 'https://model.example/v1',
        body: terminal => ({ choices: [{ message: { content: '看起来完整的结论' }, ...(terminal === undefined ? {} : { finish_reason: terminal }) }] }),
        good: ['stop', undefined], bad: ['content_filter', 'tool_calls', 'function_call', null, 'unknown'], truncated: 'length' },
    { name: 'Anthropic', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1',
        body: terminal => ({ content: [{ type: 'text', text: '看起来完整的结论' }], ...(terminal === undefined ? {} : { stop_reason: terminal }) }),
        good: ['end_turn', 'stop_sequence', undefined], bad: ['pause_turn', 'refusal', 'tool_use', null, 'unknown'], truncated: 'max_tokens' },
    { name: 'Responses', model: 'muse-spark-1.2-contributor', endpoint: 'https://model.example/v1',
        body: terminal => ({ output_text: '看起来完整的结论', ...(terminal === undefined ? {} : { status: terminal }) }),
        good: ['completed', undefined], bad: ['queued', 'in_progress', null, 'unknown', 'incomplete'] }
];
function requestConfig(protocol, body, onCall, onSleep = () => { throw new Error('非重试响应不能等待'); }) {
    return { endpoint: protocol.endpoint, model: protocol.model, key: 'offline-test-key',
        overallTimeoutMs: 60000, sleepFn: async () => onSleep(),
        requestFn: async () => { onCall(); return { statusCode: 200, headers: {}, body, raw: '{}' }; } };
}
for (const protocol of protocols) {
    for (const terminal of protocol.bad) {
        test(`${protocol.name} 的 ${terminal} 即使附带正文也必须拒绝且不重试`, async () => {
            let calls = 0;
            await assert.rejects(callModelWithConfig([], 100, 3,
                requestConfig(protocol, protocol.body(terminal), () => { calls++; })),
            error => error.code === 'MODEL_OUTPUT_INCOMPLETE' && error.retryable === false);
            assert.equal(calls, 1);
        });
    }
    for (const terminal of protocol.good) {
        test(`${protocol.name} 接受正常终态 ${terminal ?? '缺字段旧网关'}`, async () => {
            let calls = 0;
            assert.equal(await callModelWithConfig([], 100, 3,
                requestConfig(protocol, protocol.body(terminal), () => { calls++; })), '看起来完整的结论');
            assert.equal(calls, 1);
        });
    }
    if (protocol.truncated) {
        test(`${protocol.name} 保留输出截断分类且不重试`, async () => {
            let calls = 0;
            await assert.rejects(callModelWithConfig([], 100, 3,
                requestConfig(protocol, protocol.body(protocol.truncated), () => { calls++; })),
            error => error.code === 'MODEL_OUTPUT_TRUNCATED' && error.retryable === false);
            assert.equal(calls, 1);
        });
    }
}
for (const terminal of ['failed', 'cancelled']) {
    test(`Responses ${terminal} 保留服务失败分类和有界重试`, async () => {
        let calls = 0; let sleeps = 0; const protocol = protocols[2];
        await assert.rejects(callModelWithConfig([], 100, 2,
            requestConfig(protocol, protocol.body(terminal), () => { calls++; }, () => { sleeps++; })),
        error => error.code === 'MODEL_RESPONSE_FAILED' && error.retryable === true);
        assert.equal(calls, 2); assert.equal(sleeps, 1);
    });
}
