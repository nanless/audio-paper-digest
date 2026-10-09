'use strict';
if (require.main === module) require('../env-loader.js').requireExternalRuntime('llm-usage');

// 只记元数据。服务商返回的用量与按字符估算的值按设计分开；缓存和推理的小计都不
// 计入服务商总量。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const VERSION = 'llm-usage-v1';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const digest = value => /^[a-f0-9]{64}$/.test(String(value || '')) ? value : null;

function normalizeUsagePaperId(value) {
    if (typeof value !== 'string') return null;
    const arxiv = value.replace(/^arxiv:/, '');
    if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(arxiv)) return arxiv;
    const parts = value.split(':');
    if (parts.length !== 5 || parts[0] !== 'conference' || !/^[A-Za-z0-9:._-]+$/.test(value)) return null;
    try {
        const canonical = require('./paper-identity.js').canonicalConferencePaperId(
            { id: `${parts[1]}-${parts[2]}`, year: Number(parts[2]) },
            { type: parts[3], value: parts[4] });
        return canonical === value ? value : null;
    } catch { return null; }
}

function usagePaperKey(value) {
    const id = normalizeUsagePaperId(value);
    return id && !id.startsWith('conference:') ? id.replace(/v\d+$/, '') : id;
}

function normalizeLlmUsage(protocol, body) {
    const usage = body?.usage && typeof body.usage === 'object' && !Array.isArray(body.usage) ? body.usage : {};
    const input = protocol === 'openai' || protocol === 'openai_chat'
        ? usage.prompt_tokens : usage.input_tokens;
    const output = protocol === 'openai' || protocol === 'openai_chat'
        ? usage.completion_tokens : usage.output_tokens;
    const normalized = {
        inputTokens: count(input), outputTokens: count(output), totalTokens: count(usage.total_tokens),
        cachedInputTokens: count(usage.input_tokens_details?.cached_tokens
            ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens),
        cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
        reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens
            ?? usage.completion_tokens_details?.reasoning_tokens)
    };
    return { status: Object.values(normalized).every(value => value === null) ? 'unavailable' : 'reported',
        inputSemantics: 'provider_reported', ...normalized };
}

function withLlmUsageContext(context, callback) {
    return scope.run({ ...(scope.getStore() || {}), ...context }, callback);
}

function usageContext(context = {}) {
    const value = { ...(scope.getStore() || {}), ...context };
    return {
        runId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value.runId || '')) ? value.runId : null,
        paperId: normalizeUsagePaperId(value.paperId),
        stage: label(value.stage) || 'unknown', unitId: digest(value.unitId),
        contentAttempt: count(value.contentAttempt), transportAttempt: count(value.transportAttempt)
    };
}

function inputStatistics(body) {
    let textCharacters = typeof body?.input === 'string' ? body.input.length : 0;
    let images = 0;
    const messages = Array.isArray(body?.input) ? body.input : Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
        if (typeof message?.content === 'string') textCharacters += message.content.length;
        else for (const block of Array.isArray(message?.content) ? message.content : []) {
            if (['text', 'input_text'].includes(block?.type)) textCharacters += String(block.text || '').length;
            else if (['image', 'image_url', 'input_image'].includes(block?.type)) images += 1;
        }
    }
    return { textCharacters, estimatedInputTextTokens: Math.ceil(textCharacters / 3), images };
}

function buildLlmUsageEvent({ protocol, model, request, response, statusCode, durationMs, errorCode,
    context, outputText, eventId = crypto.randomUUID(), at = new Date().toISOString() }) {
    const terminal = response?.status === 'incomplete' || response?.stop_reason === 'max_tokens'
        || (Array.isArray(response?.choices) && response.choices.some(choice => choice?.finish_reason === 'length'));
    const responseStatus = protocol === 'openai_responses' ? response?.status : undefined;
    const chatTerminalFailed = ['openai', 'openai_chat'].includes(protocol)
        && Array.isArray(response?.choices) && response.choices.some(choice =>
            choice?.finish_reason !== undefined && !['stop', 'length'].includes(choice.finish_reason));
    const anthropicTerminalFailed = protocol === 'anthropic' && response?.stop_reason !== undefined
        && !['end_turn', 'stop_sequence', 'max_tokens'].includes(response.stop_reason);
    let outcome;
    if (errorCode) outcome = 'transport_error';
    else if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) outcome = 'http_error';
    else if (responseStatus !== undefined && !['completed', 'incomplete'].includes(responseStatus)) outcome = 'provider_error';
    else if (chatTerminalFailed || anthropicTerminalFailed) outcome = 'provider_error';
    else if (terminal) outcome = 'incomplete';
    else outcome = 'completed';
    return {
        version: VERSION, kind: 'request', eventId, at, runtime: 'node', ...usageContext(context),
        protocol: label(protocol), model: label(model),
        outcome,
        statusCode: count(statusCode), errorCode: label(errorCode),
        durationMs: count(Math.round(durationMs)),
        inputSha256: hash(JSON.stringify(request || {})),
        outputTextSha256: typeof outputText === 'string' ? hash(outputText) : null,
        estimates: inputStatistics(request), usage: normalizeLlmUsage(protocol, response)
    };
}

function writeLlmUsageEvent(event, options = {}) {
    if (options.enabled === false) return false;
    // Node 测试运行器会认出自己的 worker 进程。无关测试里的假传输不能污染真实的
    // 生产用量记录。
    if (process.env.NODE_TEST_CONTEXT && !options.directory) return false;
    const configured = options.directory || require('../config.js').FILES.llmUsageDir;
    const directory = path.resolve(configured);
    // 逐层拒绝已存在的符号链接；新记录文件仅当前用户可读写。以独占方式创建文件，
    // 保存后不再修改，也不向已有文件追加。
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('用量目录必须是真实目录，不能是符号链接');
    }
    fs.chmodSync(directory, 0o700);
    const id = crypto.randomUUID();
    const target = path.join(directory, `${id}.json`);
    const temp = path.join(directory, `.${id}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(event) + '\n');
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    return true;
}

let warned = false;
function recordLlmUsage(input, options = {}) {
    let event = null;
    try { event = buildLlmUsageEvent(input); writeLlmUsageEvent(event, options); }
    catch (_) {
        if (!warned) { console.warn('[llm-usage] 模型请求的用量记录未能保存；本次统计不完整'); warned = true; }
    }
    return event;
}

function recordLlmDisposition(input, options = {}) {
    if (!['accepted', 'rejected'].includes(input?.disposition) || !digest(input.outputTextSha256)) {
        throw new Error('模型结果的接受或拒绝记录不合法：disposition 必须为 accepted 或 rejected，outputTextSha256 必须为 64 位小写十六进制 SHA-256');
    }
    const event = { version: VERSION, kind: 'disposition', eventId: crypto.randomUUID(),
        at: new Date().toISOString(), runtime: 'node', ...usageContext(input),
        outputTextSha256: input.outputTextSha256, disposition: input.disposition,
        errorCode: label(input.errorCode) };
    try { writeLlmUsageEvent(event, options); } catch (_) {
        if (!warned) { console.warn('[llm-usage] 模型结果是否被接受的记录未能保存；统计不完整'); warned = true; }
    }
    return event;
}

function summarizeLlmUsage(events) {
    const groups = new Map();
    const seen = new Set();
    const dispositionKey = event => JSON.stringify([event.runId || null, event.paperId || null, event.stage || 'unknown',
        event.unitId || null, event.contentAttempt ?? null, event.outputTextSha256]);
    const dispositions = new Map();
    for (const event of events) {
        if (event?.version !== VERSION || event.kind !== 'disposition' || !digest(event.outputTextSha256)
            || !['accepted', 'rejected'].includes(event.disposition)) continue;
        const key = dispositionKey(event);
        const values = dispositions.get(key) || new Set();
        values.add(event.disposition);
        dispositions.set(key, values);
    }
    for (const event of events) {
        if (event?.version !== VERSION || event.kind !== 'request' || !event.eventId || seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        const key = JSON.stringify([event.runId || null, event.paperId || null, event.stage || 'unknown']);
        if (!groups.has(key)) groups.set(key, { runId: event.runId || null, paperId: event.paperId || null, stage: event.stage || 'unknown',
            requests: 0, unsuccessfulRequests: 0, requestsWithUsage: 0,
            dispositions: { accepted: 0, rejected: 0, conflicting: 0, unknown: 0 },
            usage: Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
                'cacheCreationInputTokens', 'reasoningTokens'].map(name => [name, { sum: 0, reportedRequests: 0 }])),
            estimatedInputTextTokens: 0, durationMs: 0 });
        const group = groups.get(key);
        group.requests += 1;
        group.unsuccessfulRequests += event.outcome !== 'completed' ? 1 : 0;
        group.requestsWithUsage += event.usage?.status === 'reported' ? 1 : 0;
        const matches = digest(event.outputTextSha256) ? dispositions.get(dispositionKey(event)) : null;
        const adoption = !matches ? 'unknown' : matches.size > 1 ? 'conflicting' : [...matches][0];
        group.dispositions[adoption] += 1;
        for (const [name, aggregate] of Object.entries(group.usage)) {
            const value = count(event.usage?.[name]);
            if (value !== null) { aggregate.sum += value; aggregate.reportedRequests += 1; }
        }
        group.estimatedInputTextTokens += count(event.estimates?.estimatedInputTextTokens) || 0;
        group.durationMs += count(event.durationMs) || 0;
    }
    return { version: VERSION, note: '用量总计只累加服务商已提供的数值；字符估算不等于计费 token。缓存和推理数量属于小计，不额外加到总量。',
        groups: [...groups.values()].map(group => ({ ...group, usage: Object.fromEntries(Object.entries(group.usage)
            .map(([name, value]) => [name, { ...value, sum: value.reportedRequests ? value.sum : null }])) })) };
}

module.exports = { VERSION, normalizeUsagePaperId, usagePaperKey, normalizeLlmUsage, withLlmUsageContext, usageContext, inputStatistics,
    buildLlmUsageEvent, writeLlmUsageEvent, recordLlmUsage, recordLlmDisposition, summarizeLlmUsage };
