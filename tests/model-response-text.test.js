const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callModelWithConfig } = require('../scripts/deep-analyzer.js');
const { requestLlmJson } = require('../scripts/utils.js');

const cases = [
    {
        name: 'Chat', endpoint: 'https://example.invalid/v1',
        bad: { choices: [{ finish_reason: 'stop', message: { reasoning_content: '秘密推理' } }] },
        good: { choices: [{ finish_reason: 'stop', message: {
            content: '正式正文', reasoning_content: '秘密推理'
        } }] }
    },
    {
        name: 'Anthropic', endpoint: 'https://example.invalid/anthropic/v1',
        bad: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '秘密推理' }] },
        good: { stop_reason: 'end_turn', content: [
            { type: 'thinking', thinking: '秘密推理' }, { type: 'text', text: '正式正文' }
        ] }
    },
    {
        name: 'Anthropic非正文text字段', endpoint: 'https://example.invalid/anthropic/v1',
        bad: { stop_reason: 'end_turn', content: [{ type: 'thinking', text: '秘密推理' }] },
        good: { stop_reason: 'end_turn', content: [
            { type: 'thinking', text: '秘密推理' }, { type: 'text', text: '正式正文' }
        ] }
    },
    {
        name: 'Responses', endpoint: 'https://example.invalid/v1/responses',
        bad: { status: 'completed', output: [
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: '秘密推理' }] }
        ] },
        good: { status: 'completed', output: [
            { type: 'message', content: [{ type: 'output_text', text: '正式正文' }] }
        ] }
    }
];

function config(item, body) {
    return {
        endpoint: item.endpoint, model: 'test-model', key: 'offline-key', recordUsage: false,
        requestFn: (url, endpoint, model, payload, headers, options) => requestLlmJson(
            url, endpoint, model, payload, headers, {
                ...options,
                recordUsage: false,
                transportRequestFn: async () => ({ statusCode: 200, body })
            }
        )
    };
}

for (const item of cases) {
    test(`${item.name}真实公共请求到主分析拒绝仅推理响应`, async () => {
        await assert.rejects(
            callModelWithConfig([], 100, 1, config(item, item.bad)),
            error => error.code === 'MODEL_INVALID_RESPONSE'
        );
    });
    test(`${item.name}真实公共请求到主分析保留正式正文`, async () => {
        assert.equal(await callModelWithConfig([], 100, 1, config(item, item.good)), '正式正文');
    });
}
