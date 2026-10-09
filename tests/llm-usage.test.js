'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLlmUsage, withLlmUsageContext, buildLlmUsageEvent,
    writeLlmUsageEvent, summarizeLlmUsage } = require('../scripts/lib/llm-usage.js');

test('会议与旧式 arXiv 用量保留论文身份，报告不会合并不同会议论文', t => {
    const ids = ['conference:icassp:2026:icassp-arnumber:10910001',
        'conference:icml:2026:openreview-forum-id:PaperAv2',
        'conference:icml:2026:openreview-forum-id:PaperAv3', 'hep-th/9901001v2'];
    const events = ids.map(paperId => buildLlmUsageEvent({ protocol: 'openai', request: {},
        statusCode: 200, context: { paperId, stage: 'analysis' } }));
    assert.deepEqual(events.map(event => event.paperId), ids);
    assert.equal(summarizeLlmUsage(events).groups.length, ids.length);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-paper-ids-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const event of events) writeLlmUsageEvent(event, { directory });
    const { main } = require('../scripts/llm-usage-report.js');
    const original = console.log; console.log = () => {};
    try {
        assert.deepEqual(main(['--dir', directory, '--paper', ids[1]]).groups.map(group => group.paperId), [ids[1]]);
        assert.deepEqual(main(['--dir', directory, '--paper', 'hep-th/9901001']).groups.map(group => group.paperId), [ids[3]]);
        for (const value of ['conference:icml:026:openreview-forum-id:PaperAv2', '../secret',
            'conference:icassp:2026:icassp-arnumber:1٢', 'conference:icassp:2026:icassp-arnumber:1２',
            'conference:icml:2026:unknown:PaperAv2', 'conference:icml:2026:openreview-forum-id:bad/path']) {
            assert.equal(buildLlmUsageEvent({ request: {}, context: { paperId: value } }).paperId, null);
            assert.throws(() => main(['--dir', directory, '--paper', value]), /论文 ID 不合法/);
        }
    } finally { console.log = original; }
    assert.equal(buildLlmUsageEvent({ request: {}, context: { paperId: 'arxiv:2609.03622' } }).paperId, '2609.03622');
});

test('供应商用量保留未知值，绝不把子项重复计入总数', () => {
    const response = normalizeLlmUsage('openai_responses', { usage: {
        input_tokens: 100, output_tokens: 20, total_tokens: 120,
        input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 }
    } });
    assert.equal(response.totalTokens, 120);
    assert.equal(response.cachedInputTokens, 60);
    assert.equal(response.reasoningTokens, 5);
    assert.equal(normalizeLlmUsage('openai', { usage: { prompt_tokens: 9, completion_tokens: 0 } }).outputTokens, 0);
    assert.equal(normalizeLlmUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 12 } }).cachedInputTokens, 12);
    for (const usage of [null, [], {}, { input_tokens: -1, output_tokens: '40', total_tokens: true }]) {
        assert.equal(normalizeLlmUsage('openai_responses', { usage }).status, 'unavailable');
    }
});

test('事件只含元数据和哈希，并发的论文作用域彼此隔离', async () => {
    const make = paperId => withLlmUsageContext({ paperId, stage: 'apiReaderRepair' }, async () => {
        await Promise.resolve();
        return buildLlmUsageEvent({ protocol: 'openai', model: 'test-model',
            request: { messages: [{ role: 'user', content: 'PRIVATE PROMPT' }], secret: 'API_SECRET' },
            response: { choices: {}, usage: { prompt_tokens: 7 } }, statusCode: 200,
            outputText: 'PRIVATE RESPONSE', context: { contentAttempt: 2, authorization: 'Bearer secret' } });
    });
    const events = await Promise.all([make('2609.03622'), make('2609.00001')]);
    assert.deepEqual(events.map(event => event.paperId), ['2609.03622', '2609.00001']);
    for (const event of events) {
        assert.equal(event.usage.inputTokens, 7);
        assert.equal(event.stage, 'apiReaderRepair');
        assert.doesNotMatch(JSON.stringify(event), /PRIVATE|API_SECRET|Bearer|authorization/);
        assert.match(event.inputSha256, /^[a-f0-9]{64}$/);
    }
});

test('账目把上报用量与估算、缺失数据和失败调用分开', () => {
    const event = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test',
        request: { input: 'abcdef' }, response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, statusCode: 200 });
    const failed = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test', request: {}, errorCode: 'ECONNRESET' });
    const report = summarizeLlmUsage([event, event, failed]).groups[0];
    assert.equal(report.requests, 2);
    assert.equal(report.unsuccessfulRequests, 1);
    assert.equal(report.usage.totalTokens.sum, 12);
    assert.equal(report.usage.totalTokens.reportedRequests, 1);
    assert.equal(report.usage.cachedInputTokens.sum, null);
    assert.equal(report.estimatedInputTextTokens, 2);
});

test('HTTP 成功不能盖过 Responses 的终态', () => {
    const cases = [
        ['completed', 'completed'], [undefined, 'completed'], ['incomplete', 'incomplete'],
        ['failed', 'provider_error'], ['cancelled', 'provider_error'],
        ['in_progress', 'provider_error'], ['queued', 'provider_error']
    ];
    for (const [status, outcome] of cases) {
        const event = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test', request: {},
            response: { status, output_text: '{"passed":true,"issues":[]}',
                usage: { input_tokens: 10, output_tokens: 5 } }, statusCode: 200 });
        assert.equal(event.outcome, outcome, `status=${status}`);
        assert.equal(event.usage.inputTokens, 10);
        assert.equal(event.usage.outputTokens, 5);
    }
});

test('传输错误和 HTTP 错误优先于响应的终态', () => {
    const cases = [[200, 'ECONNRESET', 'transport_error'], [500, undefined, 'http_error']];
    for (const [statusCode, errorCode, outcome] of cases) {
        const event = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test', request: {},
            response: { status: 'incomplete' }, statusCode, errorCode });
        assert.equal(event.outcome, outcome);
    }
    for (const [protocol, response] of [
        ['openai', { choices: [{ finish_reason: 'length' }] }],
        ['anthropic', { stop_reason: 'max_tokens' }]
    ]) {
        assert.equal(buildLlmUsageEvent({ protocol, request: {}, response, statusCode: 200 }).outcome,
            'incomplete');
    }
});

test('账目用私有的不可变文件，拒绝链接目录', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'ledger');
    writeLlmUsageEvent({ version: 'llm-usage-v1', kind: 'request' }, { directory });
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    fs.symlinkSync(directory, path.join(root, 'link'));
    assert.throws(() => writeLlmUsageEvent({}, { directory: path.join(root, 'link') }), /用量目录必须是真实目录/);
});

test('采用汇总绑定原始输出、论文、阶段和内容尝试次数，不靠猜', () => {
    const event = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test',
        request: {}, outputText: 'candidate', statusCode: 200,
        context: { paperId: '2609.03622', stage: 'apiReaderRepair', contentAttempt: 2 } });
    const disposition = { ...event, kind: 'disposition', disposition: 'accepted' };
    assert.equal(summarizeLlmUsage([event, disposition]).groups[0].dispositions.accepted, 1);
    assert.equal(summarizeLlmUsage([event, { ...disposition, contentAttempt: 1 }]).groups[0].dispositions.unknown, 1);
    assert.equal(summarizeLlmUsage([event, disposition, { ...disposition, disposition: 'rejected' }])
        .groups[0].dispositions.conflicting, 1);
});

test('用量报告在读记录之前就拒绝不存在的日历日期', () => {
    const { main } = require('../scripts/llm-usage-report.js');
    for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) {
        assert.throws(() => main(['--date', date]), /有效的 YYYY-MM-DD 日历日期/);
    }
});

test('全新运行的作用域会保留，不同重写的用量绝不合并', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const events = ids.map(runId => withLlmUsageContext({ runId }, () => buildLlmUsageEvent({
        request: {}, protocol: 'openai_responses', statusCode: 200,
        context: { paperId: '2609.03622', stage: 'apiReaderArticle' }
    })));
    assert.deepEqual(events.map(event => event.runId), ids);
    assert.equal(summarizeLlmUsage(events).groups.length, 2);
    const { main } = require('../scripts/llm-usage-report.js');
    assert.throws(() => main(['--run', '../other']), /规范 UUID v4/);
});

test('传输层记录格式错误的响应和网络错误，但不改变它们的结果', async () => {
    const { requestLlmJson } = require('../scripts/utils.js');
    const events = [];
    for (const body of [{ choices: [{}], usage: { prompt_tokens: 9 } }, { choices: 3, usage: null }]) {
        const result = await requestLlmJson('https://example.invalid/v1/chat/completions',
            'https://example.invalid/v1', 'test', { messages: [] }, { Authorization: 'Bearer TOP_SECRET' }, {
                transportRequestFn: async () => ({ statusCode: 200, body }), usageSink: event => events.push(event)
            });
        assert.equal(result.body, body);
    }
    await assert.rejects(requestLlmJson('https://example.invalid/v1/chat/completions',
        'https://example.invalid/v1', 'test', { messages: [] }, {}, {
            transportRequestFn: async () => { throw Object.assign(new Error('sensitive'), { code: 'ECONNRESET' }); },
            usageSink: event => events.push(event)
        }), /sensitive/);
    assert.equal(events.length, 3);
    assert.equal(events[0].usage.inputTokens, 9);
    assert.equal(events[1].usage.status, 'unavailable');
    assert.equal(events[2].outcome, 'transport_error');
    assert.doesNotMatch(JSON.stringify(events), /TOP_SECRET|sensitive/);
});


test('Chat 和 Anthropic 非成功终态保留用量但计入失败调用', () => {
    const events = [];
    for (const protocol of ['openai', 'openai_chat', 'anthropic']) {
        const cases = protocol === 'anthropic'
            ? [['end_turn','completed'],['stop_sequence','completed'],['max_tokens','incomplete'],
                ['tool_use','provider_error'],['pause_turn','provider_error'],['refusal','provider_error']]
            : [['stop','completed'],['length','incomplete'],['content_filter','provider_error'],
                ['tool_calls','provider_error'],['function_call','provider_error']];
        for (const [reason, expected] of cases) {
            const response = protocol === 'anthropic'
                ? { stop_reason: reason, usage: { input_tokens: 3, output_tokens: 2 } }
                : { choices: [{ finish_reason: reason }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
            const event = buildLlmUsageEvent({ protocol, model: 'test', request: {}, response, statusCode: 200 });
            assert.equal(event.outcome, expected, `${protocol}/${reason}`);
            assert.equal(event.usage.inputTokens, 3); events.push(event);
        }
    }
    const report = summarizeLlmUsage(events).groups[0];
    assert.equal(report.requests, 16);
    assert.equal(report.unsuccessfulRequests, 12);
    assert.equal(report.usage.inputTokens.sum, 48);
});
