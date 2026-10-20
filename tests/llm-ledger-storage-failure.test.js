'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const utils = require('../scripts/utils'), usage = require('../scripts/lib/llm-usage');
const deep = require('../scripts/deep-analyzer');
const endpoint = 'https://example.invalid/v1';
const response = { statusCode: 200, headers: { 'x-private': 'DO_NOT_ARCHIVE_HEADERS' },
    body: { choices: [{ message: { content: 'ACTUAL_PAID_RESPONSE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } };
const context = { paperId: '2610.90001', stage: 'scoringAudit', contentAttempt: 1, transportAttempt: 1 };
const temporary = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-failure-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const rows = dir => fs.readdirSync(dir).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name))));
function request(dir, transport, extra = {}) {
    return utils.requestLlmJson(endpoint + '/chat/completions', endpoint, 'test',
        { messages: [{ role: 'user', content: 'PRIVATE_REQUEST_PROMPT' }] }, { Authorization: 'Bearer PRIVATE_API_KEY' },
        { usageDirectory: dir, usageContext: context, transportRequestFn: transport, ...extra });
}

test('terminal EIO preserves actual HTTP200 response and same pending ID, and stops without retry', async t => {
    const dir = temporary(t), rename = fs.renameSync; let calls = 0;
    fs.renameSync = function (from, to) {
        if (path.dirname(from) === dir && JSON.parse(fs.readFileSync(from)).kind === 'request') {
            throw Object.assign(new Error('injected ledger EIO'), { code: 'EIO' });
        }
        return rename.apply(this, arguments);
    };
    t.after(() => { fs.renameSync = rename; });
    await assert.rejects(request(dir, async () => { calls++; return response; }), error => {
        assert.equal(error.code, 'LLM_USAGE_NOT_PERSISTED'); assert.equal(error.scope, 'run');
        assert.equal(error.retryable, false); assert.equal(error.category, 'storage');
        assert.equal(error.llmResponse.body, response.body);
        assert.doesNotMatch(JSON.stringify(error), /ACTUAL_PAID_RESPONSE|PRIVATE_REQUEST_PROMPT|PRIVATE_API_KEY/);
        const saved = JSON.parse(fs.readFileSync(error.responseRecovery.filename));
        assert.equal(saved.response.statusCode, 200); assert.deepEqual(saved.response.body, response.body);
        assert.equal(saved.event.eventId, rows(dir)[0].eventId);
        assert.equal(saved.event.outcome, 'completed'); assert.equal(saved.event.usage.totalTokens, 5);
        assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_REQUEST_PROMPT|PRIVATE_API_KEY|DO_NOT_ARCHIVE_HEADERS/);
        assert.equal(fs.statSync(error.responseRecovery.filename).mode & 0o777, 0o600);
        return true;
    });
    assert.equal(calls, 1); assert.deepEqual(rows(dir).map(event => event.kind), ['request_started']);
    assert.equal(usage.summarizeLlmUsage(rows(dir)).pendingUnknownRequestCount, 1);
});

test('failed custom sink follows the same fail-closed response preservation', async t => {
    const dir = temporary(t); let calls = 0;
    await assert.rejects(request(dir, async () => { calls++; return response; }, {
        usageSink() { throw Object.assign(new Error('injected sink ENOSPC'), { code: 'ENOSPC' }); }
    }), error => error.code === 'LLM_USAGE_NOT_PERSISTED' && error.scope === 'run'
        && error.retryable === false && fs.existsSync(error.responseRecovery.filename));
    assert.equal(calls, 1);
});

test('HTTP200 malformed JSON retains actual raw response if its terminal ledger also fails', async t => {
    const dir = temporary(t), https = require('node:https'), originalRequest = https.request;
    const rename = fs.renameSync; const { EventEmitter } = require('node:events');
    const raw = 'ACTUAL_PAID_MALFORMED_JSON'; let transports = 0;
    https.request = (_options, callback) => {
        transports++;
        const request = new EventEmitter(); request.write = () => {};
        request.destroy = error => { if (error) request.emit('error', error); };
        request.end = () => queueMicrotask(() => {
            const response = new EventEmitter(); response.statusCode = 200; response.headers = {};
            callback(response); response.emit('data', Buffer.from(raw)); response.emit('end');
        });
        return request;
    };
    fs.renameSync = function (from) {
        if (path.dirname(from) === dir && JSON.parse(fs.readFileSync(from)).kind === 'request') {
            throw Object.assign(new Error('terminal EIO'), { code: 'EIO' });
        }
        return rename.apply(this, arguments);
    };
    t.after(() => { https.request = originalRequest; fs.renameSync = rename; });
    await assert.rejects(request(dir), error => {
        const saved = JSON.parse(fs.readFileSync(error.responseRecovery.filename));
        assert.equal(saved.response.statusCode, 200); assert.equal(saved.response.body, null);
        assert.equal(saved.response.raw, raw); assert.equal(saved.event.statusCode, 200);
        assert.equal(saved.event.errorCode, 'LLM_RESPONSE_PARSE_ERROR');
        assert.equal(error.scope, 'run'); assert.equal(error.retryable, false);
        return true;
    });
    assert.equal(transports, 1);
});

test('both production conference filter sinks propagate failed durable writes and retain actual usage evidence', async t => {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/conference-filter.js'), 'utf8');
    const marker = 'usageSink: event => {'; let cursor = 0, tested = 0;
    while ((cursor = source.indexOf(marker, cursor)) !== -1) {
        const start = cursor + marker.length; let end = start, depth = 1;
        while (depth) { if (source[end] === '{') depth++; else if (source[end] === '}') depth--; end++; }
        const usageEvents = [], failure = Object.assign(new Error('actual filter fee EIO'), { code: 'EIO' });
        const sink = new Function('require', 'usageEvents', 'return event => {' + source.slice(start, end - 1) + '};')(
            name => { assert.equal(name, './llm-usage.js'); return { writeLlmUsageEvent() { throw failure; } }; }, usageEvents);
        const dir = temporary(t); let calls = 0;
        await assert.rejects(request(dir, async () => { calls++; return response; }, { usageSink: sink }), error => {
            assert.equal(error.code, 'LLM_USAGE_NOT_PERSISTED'); assert.equal(error.scope, 'run');
            assert.equal(error.retryable, false);
            const saved = JSON.parse(fs.readFileSync(error.responseRecovery.filename));
            assert.equal(saved.response.statusCode, 200); assert.equal(saved.event.usage.totalTokens, 5);
            return true;
        });
        assert.equal(calls, 1); assert.equal(usageEvents.length, 1); assert.equal(usageEvents[0].persisted, false);
        assert.equal(usageEvents[0].event.outcome, 'completed'); tested++; cursor = end;
    }
    assert.equal(tested, 2);
    const begin = source.indexOf('function transportRunFailure('), end = source.indexOf('\nfunction usageFromEvents(', begin);
    const cold = new Function(source.slice(begin, end) + ';return transportRunFailure;')();
    for (const code of ['LLM_USAGE_NOT_PERSISTED', 'LLM_REQUEST_START_NOT_PERSISTED']) {
        const error = cold({ outcome: 'unavailable', errorCode: code });
        assert.equal(error.scope, 'run'); assert.equal(error.category, 'storage'); assert.equal(error.retryable, false);
    }
});

test('Python pending events retain runtime identity and pair with the exact original terminal', () => {
    const pending = require('../scripts/lib/llm-pending-request');
    const start = { ...pending.beginPendingLlmRequest({ protocol: 'openai', model: 'test',
        request: {}, context }, { enabled: false }).event, runtime: 'python' };
    assert.equal(pending.orphanedPendingLlmRequests([start])[0].runtime, 'python');
    const end = { ...usage.buildLlmUsageEvent({ protocol: 'openai', model: 'test', request: {},
        context, eventId: start.eventId, statusCode: 200 }), runtime: 'python' };
    assert.equal(usage.summarizeLlmUsage([start, end]).pendingUnknownRequestCount, 0);
});

test('fully unavailable disk reports recovery failure and retains non-enumerable actual response', async t => {
    const dir = temporary(t), rename = fs.renameSync, open = fs.openSync;
    fs.renameSync = function (from) {
        if (path.dirname(from) === dir && JSON.parse(fs.readFileSync(from)).kind === 'request') {
            fs.openSync = () => { throw Object.assign(new Error('no disk space'), { code: 'ENOSPC' }); };
            throw Object.assign(new Error('ledger EIO'), { code: 'EIO' });
        }
        return rename.apply(this, arguments);
    };
    t.after(() => { fs.renameSync = rename; fs.openSync = open; });
    try {
        await assert.rejects(request(dir, async () => response), error => {
            assert.equal(error.responseRecoveryFailed, true); assert.equal(error.responseRecovery, undefined);
            assert.deepEqual(error.llmResponse.body, response.body);
            assert.equal(Object.getOwnPropertyDescriptor(error, 'llmResponse').enumerable, false);
            return error.code === 'LLM_USAGE_NOT_PERSISTED' && error.retryable === false;
        });
    } finally { fs.renameSync = rename; fs.openSync = open; }
});

test('adoption ledger failure cannot fabricate rejection or discard the actual response', t => {
    const dir = temporary(t), rename = fs.renameSync;
    fs.renameSync = function (from) {
        if (path.dirname(from) === dir) throw Object.assign(new Error('disposition EIO'), { code: 'EIO' });
        return rename.apply(this, arguments);
    };
    t.after(() => { fs.renameSync = rename; });
    assert.throws(() => usage.recordLlmDisposition({ ...context, disposition: 'accepted',
        outputTextSha256: 'a'.repeat(64), responseText: 'ACTUAL_PAID_RESPONSE' }, { directory: dir }), error => {
        const saved = JSON.parse(fs.readFileSync(error.responseRecovery.filename));
        assert.equal(saved.event.kind, 'disposition'); assert.equal(saved.event.disposition, 'accepted');
        assert.equal(saved.response.body.outputText, 'ACTUAL_PAID_RESPONSE');
        return error.scope === 'run' && error.retryable === false;
    });
});

test('successful requests keep paired original events without response-archive IO', async t => {
    const dir = temporary(t); const actual = await request(dir, async () => response);
    assert.equal(actual, response); assert.equal(rows(dir).length, 2);
    assert.equal(usage.summarizeLlmUsage(rows(dir)).pendingUnknownRequestCount, 0);
    assert.equal(fs.existsSync(path.join(dir, 'response-recovery')), false);
});

test('first-use concurrent ledger-directory creation tolerates EEXIST but still rejects a raced symlink', t => {
    const root = temporary(t), mkdir = fs.mkdirSync;
    const directory = path.join(root, 'ledger'); let raced = false;
    fs.mkdirSync = function (filename, options) {
        if (filename === directory && !raced) {
            raced = true; mkdir.call(this, filename, options);
        }
        return mkdir.apply(this, arguments);
    };
    try {
        usage.writeLlmUsageEvent({ version: usage.VERSION, kind: 'request' }, { directory });
        assert.equal(raced, true); assert.equal(rows(directory).length, 1);
    } finally { fs.mkdirSync = mkdir; }
    const other = path.join(root, 'other'), symlink = path.join(root, 'raced-link');
    fs.mkdirSync(other);
    fs.mkdirSync = function (filename) {
        if (filename === symlink) {
            fs.symlinkSync(other, symlink);
            throw Object.assign(new Error('raced EEXIST'), { code: 'EEXIST' });
        }
        return mkdir.apply(this, arguments);
    };
    try {
        assert.throws(() => usage.writeLlmUsageEvent({}, { directory: symlink }), /不能是符号链接/);
        assert.equal(rows(other).length, 0);
    } finally { fs.mkdirSync = mkdir; }
});

test('Reader preserves the consumed response and attempts when terminal accounting fails after paid content', async t => {
    const dir = temporary(t); let calls = 0;
    const storage = Object.assign(new Error('actual returned response, ledger failed'), {
        code: 'LLM_USAGE_NOT_PERSISTED', scope: 'run', category: 'storage', retryable: false,
        usageEvent: { protocol: 'openai' }, llmResponse: { statusCode: 200,
            body: { choices: [{ message: { content: '{"version":3,"readerTitle":"保留真实付费原稿"}' } }] } }
    });
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99991', title: '离线保存故障' },
        'canonical', '', { sourceText: 'source', readerAttemptsDir: dir,
            readerMaterializeFigures: async () => [], readerRecordDisposition() {},
            readerCallModel: async () => { calls++; throw storage; }
        }), error => error === storage);
    const candidate = rows(dir).find(record => record.payload)?.payload;
    assert.equal(calls, 1); assert.equal(candidate.attempts, 1); assert.equal(candidate.fullAttempts, 1);
    assert.equal(candidate.transportFailures, 0);
    assert.equal(candidate.rawDraft, '{"version":3,"readerTitle":"保留真实付费原稿"}');
});

test('Reader rejection-accounting failure keeps the original raw response and stops before a second attempt', async t => {
    const dir = temporary(t); let calls = 0, dispositionCalls = 0;
    const storage = Object.assign(new Error('disposition disk full'), {
        code: 'LLM_USAGE_NOT_PERSISTED', scope: 'run', category: 'storage', retryable: false
    });
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99992', title: '离线采用故障' },
        'canonical', '', { sourceText: 'source', readerAttemptsDir: dir,
            readerMaterializeFigures: async () => [],
            readerRecordDisposition() { dispositionCalls++; throw storage; },
            readerCallModel: async () => { calls++; return 'actual invalid paid JSON'; }
        }), error => error === storage);
    const candidate = rows(dir).find(record => record.payload)?.payload;
    assert.equal(calls, 1); assert.equal(dispositionCalls, 1);
    assert.equal(candidate.attempts, 1); assert.equal(candidate.fullAttempts, 1);
    assert.equal(candidate.rawDraft, 'actual invalid paid JSON');
});

test('malformed paid Reader text cannot replace a genuine ledger run failure with a parse error', async t => {
    const dir = temporary(t); let calls = 0;
    const storage = Object.assign(new Error('actual ledger EIO'), {
        code: 'LLM_USAGE_NOT_PERSISTED', scope: 'run', category: 'storage', retryable: false,
        usageEvent: { protocol: 'openai' }, llmResponse: { statusCode: 200,
            body: { choices: [{ message: { content: 'actual paid incomplete { not JSON' } }] } }
    });
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99993', title: '离线坏JSON费用故障' },
        'canonical', '', { sourceText: 'source', readerAttemptsDir: dir,
            readerMaterializeFigures: async () => [], readerRecordDisposition() {},
            readerCallModel: async () => { calls++; throw storage; }
        }), error => error === storage && error.scope === 'run' && error.retryable === false);
    const candidate = rows(dir).find(record => record.payload)?.payload;
    assert.equal(calls, 1); assert.equal(candidate.attempts, 1); assert.equal(candidate.fullAttempts, 1);
    assert.equal(candidate.rawDraft, 'actual paid incomplete { not JSON');
});

test('internal transient retry succeeds normally, but exhausted transport stops the failure-set dispatcher', async () => {
    const config = { model: 'test', key: 'fixture', endpoint, sleepFn: async () => {}, overallTimeoutMs: 60000 };
    let recovered = 0;
    assert.equal(await deep.callModelWithConfig([], 10, 2, { ...config, requestFn: async () => {
        if (++recovered === 1) throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' });
        return response;
    } }), 'ACTUAL_PAID_RESPONSE');
    let calls = 0; const { runFailureRounds } = require('../scripts/lib/analysis-failure-rounds');
    await assert.rejects(runFailureRounds([{ id: 'a' }, { id: 'b' }], { concurrency: 1, maxRounds: 3,
        runItem: async () => ({ success: true, result: await deep.callModelWithConfig([], 10, 2, {
            ...config, requestFn: async () => { calls++; throw Object.assign(new Error('synthetic timeout'),
                { code: 'REQUEST_SOCKET_TIMEOUT' }); }
        }) }) }), error => error.scope === 'run' && error.retryable === false
            && error.code === 'REQUEST_SOCKET_TIMEOUT' && error.unstartedIds.includes('b'));
    assert.equal(calls, 2);
});

test('long synchronous stalls do not refund physical requests or assert actual system sleep', async () => {
    const realNow = Date.now; let now = realNow(), calls = 0; Date.now = () => now;
    try {
        await assert.rejects(deep.callModelWithConfig([], 10, 1, { model: 'test', key: 'fixture', endpoint,
            overallTimeoutMs: 600000, requestFn: async () => { calls++; now += 65000;
                throw Object.assign(new Error('synthetic stall timeout'), { code: 'REQUEST_DEADLINE_EXCEEDED' }); }
        }), error => error.code === 'REQUEST_DEADLINE_EXCEEDED' && error.scope === 'run' && error.retryable === false);
        assert.equal(calls, 1);
    } finally { Date.now = realNow; }
});

test('daily filter preserves typed fee/auth run failures without escalating ordinary content rejection', async () => {
    const filter = require('../scripts/fetch-papers');
    const paper = { arxivId: '2610.90011', title: 'Speech enhancement with audio signals',
        abstract: 'We evaluate speech enhancement using acoustic and audio signals.', categories: ['eess.AS'] };
    assert.notEqual(filter.evaluateKeywordPrefilter(paper).requiresScopeEvidence, true);
    for (const code of ['LLM_USAGE_NOT_PERSISTED', 'LLM_REQUEST_START_NOT_PERSISTED', 'LLM_ACCOUNT_AUTH_ERROR']) {
        const source = Object.assign(new Error('typed failure'), { code, scope: 'run', retryable: false,
            category: code === 'LLM_ACCOUNT_AUTH_ERROR' ? 'authentication' : 'storage' });
        const classified = filter.classifyFilterRequestError(source);
        assert.equal(classified.scope, 'run'); assert.equal(classified.stopBatch, true);
        assert.equal(classified.systemFailure, true); assert.equal(classified.retryable, false);
        let calls = 0;
        await assert.rejects(filter.getSpeechAudioDecision(paper, {
            filterConfig: { endpoint, key: 'fixture', model: 'test' },
            requestFn: async () => { calls++; throw source; }, maxRetries: 3,
            sleepFn: async () => { throw Error('must not retry a storage or auth failure'); }
        }), error => error.code === code && error.scope === 'run' && error.stopBatch === true);
        assert.equal(calls, 1);
    }
    const content = filter.classifyFilterRequestError(Object.assign(new Error('ordinary content rejected'),
        { code: 'CONTENT_REJECTED', retryable: false }));
    assert.equal(content.systemFailure, false); assert.notEqual(content.stopBatch, true);
    assert.notEqual(content.scope, 'run');
});

test('daily filter batch saves started peers then propagates run failure before the next batch', async () => {
    const filter = require('../scripts/fetch-papers'); let calls = 0; const snapshots = [];
    const papers = [1, 2, 3, 4].map(index => ({ arxivId: `2610.9002${index}`,
        title: `Speech enhancement with audio signals ${index}`,
        abstract: 'Speech enhancement evaluates audio and acoustic signals.', categories: ['eess.AS'] }));
    const source = Object.assign(new Error('ledger EIO'), { code: 'LLM_USAGE_NOT_PERSISTED',
        scope: 'run', category: 'storage', retryable: false });
    const body = { choices: [{ message: { content: '{"decision":"related","reason":"Speech is primary."}' }, finish_reason: 'stop' }] };
    await assert.rejects(filter.filterPapersWithLLM(papers, { batchSize: 2, delayBetweenBatches: 0,
        decisionOptions: { filterConfig: { endpoint, key: 'fixture', model: 'test' }, maxRetries: 1,
            requestFn: async () => { if (++calls === 2) throw source;
                return { statusCode: 200, body, raw: JSON.stringify(body) }; } },
        onBatchComplete: snapshot => snapshots.push(snapshot)
    }), error => error.code === source.code && error.scope === 'run' && error.stopBatch === true);
    assert.equal(calls, 3); assert.equal(snapshots.length, 2);
    const latest = snapshots.at(-1);
    assert.equal(Object.keys(latest.decisions).length, 2);
    assert.equal(latest.batchResults.length, 2);
    assert.equal(Object.values(latest.retryableDecisions)[0].errorCode, source.code);
    assert.equal(Object.hasOwn(latest.decisions, papers[3].arxivId), false);
});
