'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestLlmJson, buildApiUrl } = require('../scripts/utils.js');
const { getModelOutputTerminationError } = require('../scripts/deep-analyzer.js');
const { summarizeLlmUsage } = require('../scripts/lib/llm-usage.js');

const cases = [
    { protocol: 'openai_chat', model: 'test-model', endpoint: 'https://example.invalid/v1',
        field: 'finish_reason', success: 'stop', truncated: 'length' },
    { protocol: 'anthropic', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1',
        field: 'stop_reason', success: 'end_turn', truncated: 'max_tokens' },
    { protocol: 'openai_responses', model: 'muse-spark-1.2-contributor', endpoint: 'https://example.invalid/v1',
        field: 'status', success: 'completed', truncated: 'incomplete' }
];

for (const item of cases) {
    test(`${item.protocol} 用量记录拒绝 null 终态，保留缺字段兼容和全部服务商用量`, async () => {
        const events = [];
        for (const terminal of [null, undefined, item.success, item.truncated]) {
            const usage = item.protocol === 'openai_chat'
                ? { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
                : { input_tokens: 13, output_tokens: 7, total_tokens: 20 };
            const body = item.protocol === 'openai_chat'
                ? { choices: [{ message: { content: '响应正文' } }], usage }
                : item.protocol === 'anthropic' ? { content: [{ type: 'text', text: '响应正文' }], usage }
                    : { output_text: '响应正文', usage };
            if (terminal !== undefined) {
                const owner = item.protocol === 'openai_chat' ? body.choices[0] : body;
                owner[item.field] = terminal;
            }
            const response = await requestLlmJson(buildApiUrl(item.protocol, item.endpoint), item.endpoint, item.model,
                { messages: [] }, {}, {
                    transportRequestFn: async () => ({ statusCode: 200, body }),
                    usageSink: event => events.push(event)
                });
            assert.equal(response.body, body);
            const error = getModelOutputTerminationError(item.protocol, body, 100);
            assert.equal(Boolean(error), terminal === null || terminal === item.truncated);
        }
        assert.deepEqual(events.map(event => event.outcome), ['provider_error', 'completed', 'completed', 'incomplete']);
        for (const event of events) {
            assert.equal(event.usage.inputTokens, 13);
            assert.equal(event.usage.outputTokens, 7);
            assert.equal(event.usage.totalTokens, 20);
        }
        const summary = summarizeLlmUsage(events).groups[0];
        assert.equal(summary.requests, 4);
        assert.equal(summary.unsuccessfulRequests, 2);
        assert.equal(summary.usage.totalTokens.sum, 80);
    });
}
