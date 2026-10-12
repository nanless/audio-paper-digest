'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const source = require('../scripts/lib/fresh-arxiv-rewrite-source');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

test('图片计时只记录网址哈希，失败重试次数和原返回值保持', async t => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(String(line));
    t.after(() => { console.log = originalLog; });
    const url = 'https://arxiv.org/html/2610.90001/figure.png';
    const image = { bytes: Buffer.from('original-image'), mediaType: 'image/png' };
    let calls = 0;
    const waits = [];
    const result = await source.fetchEphemeralFigureWithRetry(async received => {
        assert.equal(received, url);
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        return image;
    }, url, { sleep: async delay => { waits.push(delay); } });
    assert.equal(result, image);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(lines.length, 4);
    assert.ok(lines.every(line => line.includes(sha(url)) && !line.includes(url)));
    assert.match(lines[1], /attempt=1 status=failed elapsed_ms=\d+\.\d/);
    assert.match(lines[3], /attempt=2 status=success elapsed_ms=\d+\.\d/);
});

test('缓存命中记录不触发图片抓取，原字节和SHA保持', async t => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(String(line));
    t.after(() => { console.log = originalLog; });
    const url = 'https://arxiv.org/html/2610.90001/figure.png';
    const bytes = Buffer.from('same-invocation-image');
    const images = await daily.ephemeralReaderFigures('2610.90001', [{ ordinal: 1, url }], {}, {
        figureCache: new Map([[url, { base64: bytes.toString('base64'), mime: 'image/png', sha256: sha(bytes) }]]),
        fetchFigure: async () => { throw new Error('缓存命中不应抓取'); }
    });
    assert.ok(images[0].rawBytes.equals(bytes));
    assert.equal(images[0].assetSha256, sha(bytes));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /缓存命中/);
    assert.ok(lines[0].includes(sha(url)) && !lines[0].includes(url));
});
