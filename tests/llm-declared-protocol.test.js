'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../scripts/utils');

test('显式协议仍绑定原端点，费用及传输均记录真实协议，默认生产路由保持', async () => {
    for (const [endpoint, model, declaredProtocol] of [
        ['https://example.invalid/coding/v1', 'mimo-test', 'openai'],
        ['https://example.invalid/v1', 'deepseek-test', 'openai_responses']
    ]) {
        const events = [], url = api.buildApiUrl(declaredProtocol, endpoint);
        let calls = 0;
        const options = { declaredProtocol, recordUsage: false, timeoutMs: 1000,
            usageSink: event => events.push(event), transportRequestFn: async actual => {
                calls++; assert.equal(actual, url);
                return { statusCode: 200, body: { choices: [{ message: { content: 'fixture' } }], output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture' }] }] } };
            } };
        await api.requestLlmJson(url, endpoint, model, {}, {}, options);
        assert.equal(calls, 1); assert.equal(events.length, 1); assert.equal(events[0].protocol, declaredProtocol);
        await assert.rejects(api.requestLlmJson(url, endpoint, model, {}, {}, { ...options, declaredProtocol: undefined }), { code: 'LLM_ACCOUNT_POOL_CONFIG_ERROR' });
        await assert.rejects(api.requestLlmJson(url.replace('example.invalid', 'other.invalid'), endpoint, model, {}, {}, options), { code: 'LLM_ACCOUNT_POOL_CONFIG_ERROR' });
        assert.equal(calls, 1); assert.equal(events.length, 1);
    }
});

test('未知显式协议与 Muse 非 Responses 在凭据派发及费用留账之前拒绝', async () => {
    let calls = 0, records = 0;
    const options = { recordUsage: false, transportRequestFn: async () => { calls++; return {}; }, usageSink: () => records++ };
    for (const [model, declaredProtocol] of [['test', 'arbitrary'], ['muse-spark-test', 'openai']]) {
        await assert.rejects(api.requestLlmJson('https://example.invalid/v1/chat/completions', 'https://example.invalid/v1', model, {}, {}, { ...options, declaredProtocol }), { code: 'LLM_ACCOUNT_POOL_CONFIG_ERROR' });
    }
    assert.equal(calls, 0); assert.equal(records, 0);
});
