#!/usr/bin/env node
const { setupScriptLogging, closeScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 测试 PAPER_ANALYZER_API_KEY 可用性
 */

const {
    loadEnvFile,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    requestJson
} = require('./utils.js');

async function main() {
    // 清除缓存，强制从当前项目根 .env 重新加载。
    for (const key of ['PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_MODEL']) {
        delete process.env[key];
    }
    loadEnvFile();

    const endpoint = process.env.PAPER_ANALYZER_ENDPOINT;
    const key = process.env.PAPER_ANALYZER_API_KEY;
    const model = process.env.PAPER_ANALYZER_MODEL;

    console.log('═══ API Key 可用性测试 ═══');
    console.log(`Endpoint: ${endpoint || '(未设置)'}`);
    console.log(`Model: ${model || '(未设置)'}`);
    console.log(`Key: ${key ? '[已配置，内容不输出]' : '(未设置)'}`);
    console.log();

    const missing = [];
    if (!endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`❌ 缺少环境变量: ${missing.join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const apiType = detectApiType(endpoint, model);
    const apiUrl = buildApiUrl(apiType, endpoint);
    console.log(`API 类型: ${apiType}`);
    console.log(`请求 URL: ${apiUrl}`);
    console.log();

    const messages = [{ role: 'user', content: 'Hello, reply with "OK" only.' }];
    const body = buildRequestBody(apiType, model, messages, 10);
    const bodyStr = JSON.stringify(body);
    const headers = buildHeaders(apiType, key, bodyStr);

    console.log(`请求头字段: ${Object.keys(headers).join(', ')}（认证值不输出）`);
    console.log('请求体:', bodyStr);
    console.log();

    try {
        const response = await requestJson(apiUrl, body, headers, {
            timeoutMs: 30000,
            agent: false
        });
        console.log(`HTTP 状态码: ${response.statusCode}`);
        console.log();

        if (response.statusCode >= 200 && response.statusCode < 300) {
            const text = parseResponseText(apiType, response.body);
            if (typeof text !== 'string') {
                throw new Error('响应中缺少可解析的文本内容');
            }
            console.log('✅ API Key 可用！');
            console.log(`响应内容: "${text.trim()}"`);
            console.log();
            console.log('完整响应:');
            console.log(JSON.stringify(response.body, null, 2));
            return;
        }

        console.error('❌ 请求失败');
        console.error('错误详情:', JSON.stringify(response.body, null, 2));
        process.exitCode = 1;
    } catch (err) {
        console.error(`❌ API 请求或响应解析失败: ${err.message}`);
        process.exitCode = 1;
    }
}

main()
    .catch(err => {
        console.error(`❌ 未处理错误: ${err.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeScriptLogging();
    });
