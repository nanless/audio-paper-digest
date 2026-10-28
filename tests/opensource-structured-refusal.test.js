'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/responses-structured-refusal-20261027.json');
const refusal = () => deep.getModelOutputTerminationError('openai_responses', fixture.response, 8000);

test('observed structured refusal is a single non-retryable paper failure, including mixed text', async () => {
    for (const mixed of [false, true]) {
        const body = structuredClone(fixture.response);
        if (mixed) body.output[0].content.unshift({ type: 'output_text', text: 'partial answer' });
        let calls = 0;
        await assert.rejects(deep.callModelWithConfig([{ role: 'user', content: 'offline fixture' }], 8000, 3, {
            endpoint: 'https://model.example/v1', model: 'muse-spark-1.3-contributor', key: 'offline-test-key',
            overallTimeoutMs: 60000, sleepFn: async () => assert.fail('refusal must not retry'),
            requestFn: async () => { calls++; return { statusCode: 200, body, headers: {}, raw: '{}' }; }
        }), error => error.code === 'MODEL_REFUSAL' && error.retryable === false
            && error.scope === 'paper' && error.category === 'refusal');
        assert.equal(calls, 1);
    }
});

test('terminal failures and malformed or unknown output are never classified as a refusal', () => {
    for (const mutate of [
        body => { body.status = 'failed'; },
        body => { body.status = 'incomplete'; body.incomplete_details = { reason: 'max_output_tokens' }; },
        body => { delete body.status; },
        body => { body.error = { message: 'provider error' }; },
        body => { body.output = []; },
        body => { body.output[0].role = 'user'; },
        body => { body.output[0].status = 'in_progress'; },
        body => { body.output[0].content[0].refusal = ''; },
        body => { body.output[0].content[0].refusal = 1; },
        body => { body.output[0].content[0] = { type: 'output_text', text: 'refusal' }; }
    ]) {
        const body = structuredClone(fixture.response); mutate(body);
        assert.notEqual(deep.getModelOutputTerminationError('openai_responses', body, 8000)?.code, 'MODEL_REFUSAL');
    }
});

function scanFixture(error) {
    // Exercise the production scan's catch with a local call double. This does
    // not create a source capability or record a successful production stage.
    const code = fs.readFileSync(require.resolve('../scripts/deep-analyzer'), 'utf8');
    const start = code.indexOf('async function scanOpensource(');
    const end = code.indexOf('\nfunction buildDeterministicOpenSourceScan(', start);
    assert.ok(start >= 0 && end > start);
    let calls = 0;
    const scan = vm.runInNewContext(code.slice(start, end) + '\nscanOpensource', {
        appendPrimaryFactReviewPrompt: value => value, loadPrompt: () => 'offline fixture',
        currentTextStagePromptPath: () => 'offline fixture', getPaperArxivId: paper => paper.arxivId,
        callModel: async () => { calls++; throw error; },
        buildDeterministicOpenSourceScan: deep.buildDeterministicOpenSourceScan,
        console: { warn() {} }
    });
    return { scan, calls: () => calls };
}

test('only the resource scan uses literal source URLs after an explicit refusal', async () => {
    const source = 'The implementation is available at https://github.com/example/implementation. '
        + 'The third-party toolkit is https://github.com/example/tool.';
    const f = scanFixture(refusal());
    const output = await f.scan({ arxivId: '2601.90001', title: 'Synthetic source fixture' }, source, 'prepared evidence');
    assert.equal(output, deep.buildDeterministicOpenSourceScan(source));
    assert.match(output, /https:\/\/github\.com\/example\/implementation/);
    assert.match(output, /模型权重：论文中未提及/);
    assert.doesNotMatch(output, /可访问|已验证|partial answer/);
    assert.equal(f.calls(), 1);
});

test('resource fallback never swallows run failures, truncation or unclassified refusal errors', async () => {
    for (const properties of [
        { code: 'MODEL_INVALID_RESPONSE', scope: 'run' },
        { code: 'ECONNRESET', scope: 'run' },
        { code: 'LLM_ACCOUNT_AUTH_ERROR', scope: 'run' },
        { code: 'LLM_ACCOUNT_POOL_EXHAUSTED', scope: 'run' },
        { code: 'MODEL_OUTPUT_TRUNCATED', scope: 'paper' },
        { code: 'MODEL_REFUSAL', scope: 'paper', category: 'refusal' }
    ]) {
        const error = Object.assign(new Error('synthetic failure'), properties), f = scanFixture(error);
        await assert.rejects(f.scan({ arxivId: '2601.90001', title: 'Synthetic fixture' }, 'source', 'evidence'),
            actual => actual === error);
        assert.equal(f.calls(), 1);
    }
});
