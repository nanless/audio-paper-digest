#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 测试 PAPER_ANALYZER_API_KEY 可用性
 */

const https = require('https');
const { loadEnvFile, detectApiType, buildApiUrl, buildRequestBody, buildHeaders, parseResponseText } = require('./utils.js');

// 清除缓存，强制从文件重新加载
for (const k of ['PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_MODEL']) {
    delete process.env[k];
}
loadEnvFile();

const endpoint = process.env.PAPER_ANALYZER_ENDPOINT;
const key = process.env.PAPER_ANALYZER_API_KEY;
const model = process.env.PAPER_ANALYZER_MODEL;

console.log('═══ API Key 可用性测试 ═══');
console.log(`Endpoint: ${endpoint || '(未设置)'}`);
console.log(`Model: ${model || '(未设置)'}`);
console.log(`Key: ${key ? key.slice(0, 8) + '...' + key.slice(-4) : '(未设置)'}`);
console.log();

const missing = [];
if (!endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
if (!key) missing.push('PAPER_ANALYZER_API_KEY');
if (!model) missing.push('PAPER_ANALYZER_MODEL');
if (missing.length > 0) {
    console.error(`❌ 缺少环境变量: ${missing.join(', ')}`);
    process.exit(1);
}

const apiType = detectApiType(endpoint, model);
const apiUrl = buildApiUrl(apiType, endpoint);
console.log(`API 类型: ${apiType}`);
console.log(`请求 URL: ${apiUrl}`);
console.log();

const messages = [
    { role: 'user', content: 'Hello, reply with "OK" only.' }
];
const body = buildRequestBody(apiType, model, messages, 10);
const bodyStr = JSON.stringify(body);
const headers = buildHeaders(apiType, key, bodyStr);

console.log('请求头:');
for (const [k, v] of Object.entries(headers)) {
    const display = k.toLowerCase().includes('key') ? v.slice(0, 8) + '...' : v;
    console.log(`  ${k}: ${display}`);
}
console.log();
console.log('请求体:', bodyStr);
console.log();

const url = new URL(apiUrl);
const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers,
    timeout: 30000
};

const req = https.request(options, (res) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        console.log(`HTTP 状态码: ${res.statusCode}`);
        console.log();

        if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
                const json = JSON.parse(data);
                const text = parseResponseText(apiType, json);
                console.log('✅ API Key 可用！');
                console.log(`响应内容: "${text.trim()}"`);
                console.log();
                console.log('完整响应:');
                console.log(JSON.stringify(json, null, 2));
            } catch (e) {
                console.error('❌ 响应解析失败:', e.message);
                console.log('原始响应:', data.slice(0, 500));
            }
        } else {
            console.error('❌ 请求失败');
            try {
                const json = JSON.parse(data);
                console.error('错误详情:', JSON.stringify(json, null, 2));
            } catch {
                console.error('原始响应:', data.slice(0, 1000));
            }
            process.exit(1);
        }
    });
});

req.on('error', (err) => {
    console.error('❌ 网络错误:', err.message);
    process.exit(1);
});

req.on('timeout', () => {
    console.error('❌ 请求超时');
    req.destroy();
    process.exit(1);
});

req.write(bodyStr);
req.end();
