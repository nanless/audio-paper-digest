'use strict';

// 跨协议共用的严格 JSON 读取：拒绝损坏编码与重复字段。
function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} 必须使用有效的 UTF-8 编码。`); }
    // 模型有时把 JSON 包在 Markdown 代码围栏里；只要整段就是一个围栏，
    // 去掉围栏后仍按同一严格规则校验，不改变重复字段与编码检查。
    const fenced = /^\s*```[A-Za-z]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(source);
    if (fenced) source = fenced[1];
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`${label} 的 JSON 中出现重复字段：${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    try { return JSON.parse(source); } catch { throw new Error(`${label} 的内容不是有效的 JSON。`); }
}

module.exports = { strictJson };
