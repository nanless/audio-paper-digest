'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchArxivPdfUncached } = require('../scripts/deep-analyzer');

const id = '2611.00614';
const url = `https://arxiv.org/pdf/${id}.pdf`;
const bytes = Buffer.from('%PDF-1.7\n%%EOF\n');
const response = (status, read = async () => bytes) => ({
    ok: status === 200, status, url,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: read
});
const transport = code => new TypeError('fetch failed', { cause: Object.assign(new Error('private cause'), { code }) });

test('one known PDF request transport failure retries same official URL and dispatcher', async () => {
    const dispatcher = {};
    const calls = [], delays = [];
    const result = await fetchArxivPdfUncached(id, { dispatcher, sleepFn: ms => delays.push(ms),
        fetchImpl: async (requested, options) => {
            calls.push(requested);
            assert.equal(options.dispatcher, dispatcher);
            if (calls.length === 1) throw transport('ECONNRESET');
            return response(200);
        } });
    assert.deepEqual(calls, [url, url]);
    assert.deepEqual(delays, [750]);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.currentPdfUnavailable, false);
});

test('known PDF body interruption retries once and terminal diagnostics redact nested cause text', async () => {
    const calls = [];
    const cause = transport('UND_ERR_SOCKET');
    await assert.rejects(fetchArxivPdfUncached(id, { dispatcher: {}, sleepFn: () => {},
        fetchImpl: async requested => { calls.push(requested); return response(200, async () => { throw cause; }); } }),
    error => error.code === 'UND_ERR_SOCKET' && error.cause === cause
        && /arXiv PDF 2611\.00614 body failed/.test(error.message) && !error.message.includes('private cause'));
    assert.deepEqual(calls, [url, url]);
});

test('PDF HTTP errors, bytes validation and unclassified transport failures do not retry', async () => {
    for (const [create, match] of [
        [async () => response(429), /HTTP 429/],
        [async () => response(200, async () => Buffer.from('wrong')), /invalid PDF header/],
        [async () => { throw new TypeError('fetch failed'); }, /request failed \[ARXIV_PDF_FETCH_FAILED\]/]
    ]) {
        let calls = 0;
        await assert.rejects(fetchArxivPdfUncached(id, { dispatcher: {},
            sleepFn: () => assert.fail('unclassified failure must not retry'),
            fetchImpl: async () => { calls++; return create(); } }), match);
        assert.equal(calls, 1);
    }
});

test('an explicit 404 alone selects the preferred same-paper version with one shared retry budget', async () => {
    const version = `https://arxiv.org/pdf/${id}v1.pdf`;
    const calls = [];
    const result = await fetchArxivPdfUncached(id, { preferredSourceId: `${id}v1`, dispatcher: {}, sleepFn: () => {},
        fetchImpl: async requested => {
            calls.push(requested);
            if (calls.length === 1) return response(404);
            if (calls.length === 2) throw transport('EAI_AGAIN');
            return { ...response(200), url: version };
        } });
    assert.deepEqual(calls, [url, version, version]);
    assert.equal(result.currentPdfStatus, 404);
    assert.equal(result.sourceId, `${id}v1`);
});
