'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
test.mock.method(require('../scripts/env-loader'), 'loadProjectEnv', () => {
    const environment = { PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://invalid.example/v1', PAPER_ANALYZER_API_KEY: 'unused-test-no-network',
        PAPER_ANALYZER_FALLBACK_API_KEYS: '', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
    Object.assign(process.env, environment); return environment;
});
const deep = require('../scripts/deep-analyzer');
const limit = require('../scripts/config').ANALYSIS_CONFIG.imageMaxBytes;
const url = 'https://arxiv.org/html/2610.22064v1/Fig_Overall.png';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

function response(header, chunks, { cancelThrows = false, slowBody = false } = {}) {
    let reads = 0, cancels = 0, releases = 0, readers = 0;
    return { ok: true, headers: { get: name => name === 'content-length' ? header : 'image/png' },
        body: {
            async cancel() { cancels++; if (cancelThrows) throw Error('cancel failed'); },
            getReader() {
                readers++;
                if (slowBody) assert.fail('Oversized header must reject before reading a slow body');
                return { async read() { reads++; const value = chunks.shift(); return { done: value === undefined, value }; },
                    async cancel() { cancels++; }, releaseLock() { releases++; } };
            }
        }, counters: () => ({ reads, cancels, releases, readers }) };
}
function install(t, reply) {
    let calls = 0;
    t.mock.method(global, 'fetch', async (requested, options) => {
        calls++; assert.equal(requested, url); assert.ok(options.dispatcher);
        assert.ok(options.signal); assert.equal(options.method, undefined); return reply;
    });
    return () => calls;
}

for (const cancelThrows of [false, true]) test(`正常GET合法超限长度头在slow body前永久拒绝并取消，cancel失败=${cancelThrows}`, async t => {
    const reply = response('7198322', [], { slowBody: true, cancelThrows }), calls = install(t, reply);
    await assert.rejects(deep.fetchArxivFigureBytesUncached(url), e =>
        e.code === 'RESPONSE_TOO_LARGE' && /response body .* exceeds limit/.test(e.message));
    assert.equal(calls(), 1);
    assert.deepEqual(reply.counters(), { reads: 0, readers: 0, cancels: 1, releases: 0 });
});

for (const header of [null, '', 'invalid', '-7198322', '7198322junk', '7198322.5', '7e6', '7198322,7198322', '0', String(png.length)])
    test(`缺失/非法/未超限header仍读取构造PNG字节：${String(header)}`, async t => {
        const reply = response(header, [png]); install(t, reply);
        const result = await deep.fetchArxivFigureBytesUncached(url);
        assert.equal(result.mediaType, 'image/png'); assert.deepEqual(result.bytes, png);
        assert.deepEqual(reply.counters(), { reads: 2, readers: 1, cancels: 0, releases: 1 });
    });

test('Content-Length和实际body恰等于原上限时正常读取，不降低cap', async t => {
    const bytes = Buffer.alloc(limit); png.copy(bytes);
    const reply = response(String(limit), [bytes]); install(t, reply);
    assert.deepEqual((await deep.fetchArxivFigureBytesUncached(url)).bytes, bytes);
    assert.equal(reply.counters().reads, 2); assert.equal(reply.counters().cancels, 0);
});

for (const header of [null, 'invalid', '7198322junk', '1', String(limit)])
    test(`缺失/非法/谎报小长度仍由原累计body上限拒绝：${String(header)}`, async t => {
        const reply = response(header, [Buffer.alloc(limit), Buffer.from([0])]); install(t, reply);
        await assert.rejects(deep.fetchArxivFigureBytesUncached(url), e => e.code === 'RESPONSE_TOO_LARGE');
        assert.deepEqual(reply.counters(), { reads: 2, readers: 1, cancels: 1, releases: 1 });
    });
