'use strict';
// 网络已被测试替换；返回值仍按当前请求协议构造，避免本机模型配置改变测试含义。
const { detectApiType } = require('../../scripts/utils');
function localLlmResponse(endpoint, model, content) {
    const protocol = detectApiType(endpoint, model);
    const body = protocol === 'openai_responses'
        ? { status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: content }] }] }
        : protocol === 'anthropic'
            ? { stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
            : { choices: [{ message: { content }, finish_reason: 'stop' }] };
    return { statusCode: 200, body, raw: JSON.stringify(body), headers: {} };
}
function requestText(body) {
    const message = (body.messages || body.input)[0];
    return typeof message.content === 'string' ? message.content
        : message.content.map(part => part.text || '').join('');
}
module.exports = { localLlmResponse, requestText };
