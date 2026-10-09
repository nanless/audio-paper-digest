'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callModelWithConfig, sanitizeOpenSourceEvidence } = require('../scripts/deep-analyzer.js');

const valid = '数学 𝑥 = 𝑦 + 1；作者 𠮷田；标记 😀。';
const damaged = '\uD835高\uDC00低\u0000\u0001\u000B\u000C\u007F';
const cleaned = '�高�低     ';

test('真实模型请求保留合法代理对，仅替换孤立代理与原有控制字符', async () => {
    const messages = [
        { role: 'system', content: valid + damaged + '\n\t\r' },
        { role: 'user', content: [
            { type: 'text', text: valid + damaged + String.raw` \alpha{x}` },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
        ] }
    ];
    const original = structuredClone(messages);
    let calls = 0;
    const result = await callModelWithConfig(messages, 100, 1, {
        key: 'offline-test-key', model: 'test-model', endpoint: 'https://model.example/v1',
        requestFn: async (_url, _endpoint, _model, body) => {
            calls++;
            assert.equal(body.messages[0].content, valid + cleaned + '\n\t\r');
            assert.equal(body.messages[1].content[0].text, valid + cleaned + String.raw` \alpha{x}`);
            assert.deepEqual(body.messages[1].content[1], original[1].content[1]);
            assert.deepEqual(JSON.parse(JSON.stringify(body)).messages, body.messages);
            return { statusCode: 200, headers: {}, body: {
                choices: [{ finish_reason: 'stop', message: { content: '完成' } }]
            } };
        }
    });
    assert.equal(result, '完成');
    assert.equal(calls, 1);
    assert.deepEqual(messages, original);
});

test('开源证据保留数学字符与作者姓名，仍按本任务规则显示反斜杠', () => {
    assert.equal(sanitizeOpenSourceEvidence(valid + damaged + String.raw` \alpha{x}`),
        valid + cleaned + ' ⧵alpha{x}');
});
