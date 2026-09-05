'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLlmUsage, withLlmUsageContext, buildLlmUsageEvent,
    writeLlmUsageEvent, summarizeLlmUsage } = require('../scripts/lib/llm-usage.js');

test('provider usage preserves unknown values and never double counts subtotals', () => {
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

test('events contain metadata and hashes only, with concurrent paper scopes isolated', async () => {
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

test('ledger keeps reported usage separate from estimates, missing data and failed calls', () => {
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

test('ledger uses private immutable files and rejects linked directories', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'ledger');
    writeLlmUsageEvent({ version: 'llm-usage-v1', kind: 'request' }, { directory });
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    fs.symlinkSync(directory, path.join(root, 'link'));
    assert.throws(() => writeLlmUsageEvent({}, { directory: path.join(root, 'link') }), /Unsafe/);
});

test('adoption summaries bind raw output, paper, stage and content attempt without guessing', () => {
    const event = buildLlmUsageEvent({ protocol: 'openai_responses', model: 'test',
        request: {}, outputText: 'candidate', statusCode: 200,
        context: { paperId: '2609.03622', stage: 'apiReaderRepair', contentAttempt: 2 } });
    const disposition = { ...event, kind: 'disposition', disposition: 'accepted' };
    assert.equal(summarizeLlmUsage([event, disposition]).groups[0].dispositions.accepted, 1);
    assert.equal(summarizeLlmUsage([event, { ...disposition, contentAttempt: 1 }]).groups[0].dispositions.unknown, 1);
    assert.equal(summarizeLlmUsage([event, disposition, { ...disposition, disposition: 'rejected' }])
        .groups[0].dispositions.conflicting, 1);
});

test('usage report rejects impossible calendar dates before reading records', () => {
    const { main } = require('../scripts/llm-usage-report.js');
    for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) {
        assert.throws(() => main(['--date', date]), /Invalid date/);
    }
});

test('transport records malformed responses and network errors without changing their result', async () => {
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
