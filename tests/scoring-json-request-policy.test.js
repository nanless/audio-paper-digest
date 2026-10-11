'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequestBody } = require('../scripts/utils');

const messages = [{ role: 'user', content: '只输出评分 JSON。' }];

test('MiMo 评分声明 JSON 格式，正文阶段和其他协议保持原请求', () => {
    const scoring = buildRequestBody('openai', 'mimo-v2.6-flash', messages, 16000, .1, {
        usageContext: { stage: 'scoringAudit', contentAttempt: 3 }
    });
    assert.deepEqual(scoring.response_format, { type: 'json_object' });

    for (const stage of ['primaryAnalysis', 'revision', 'openSourceScan', 'tagSelection', 'apiReaderImageProbe']) {
        const body = buildRequestBody('openai', 'mimo-v2.6-flash', messages, 16000, .1, {
            usageContext: { stage }
        });
        assert.equal(Object.hasOwn(body, 'response_format'), false, stage);
    }
    for (const [protocol, model] of [
        ['openai', 'other-model'],
        ['openai_responses', 'mimo-v2.6-flash'],
        ['anthropic', 'mimo-v2.6-flash'],
        ['unknown', 'mimo-v2.6-flash']
    ]) {
        const body = buildRequestBody(protocol, model, messages, 16000, .1, {
            usageContext: { stage: 'scoringAudit' }
        });
        assert.equal(Object.hasOwn(body, 'response_format'), false, `${protocol}/${model}`);
    }
});
