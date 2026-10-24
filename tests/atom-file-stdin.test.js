'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const child = require('node:child_process');
const { parseArxivXML } = require('../scripts/fetch-papers');
const { fetchCategoryPrefix, fetchDailyArxivCategory } = require('../scripts/lib/daily-arxiv-prefix-source');
const { isDailyXmlOperationalError, runDailyXmlPython } = require('../scripts/lib/daily-xml-file-stdin');
const entry = (index, summary) => `<entry><id>https://arxiv.org/abs/2610.${String(index).padStart(5, '0')}v1</id><title>Audio &amp; speech ${index}</title><summary>${summary}</summary><published>2026-10-23T00:00:00Z</published><author><name>Author</name></author><category term="cs.AI"/></entry>`;
const feed = entries => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="http://a9.com/-/spec/opensearch/1.1/"><o:totalResults>${entries.length}</o:totalResults><o:startIndex>0</o:startIndex><o:itemsPerPage>100</o:itemsPerPage>${entries.join('')}</feed>`;
const boundary = { since: '2026-10-23T00:00:00.000Z', until: '2026-10-24T01:40:55.209Z', identitySha256: 'a'.repeat(64) };

test('Atom large input/output uses private finite fd and preserves full parser output', t => {
    const original = child.spawnSync, descriptors = [];
    t.mock.method(child, 'spawnSync', (file, args, options) => {
        assert.equal('input' in options, false);
        assert.equal(options.timeout, 30000);
        assert.equal(options.maxBuffer, 16 * 1024 * 1024);
        assert.equal(fs.fstatSync(options.stdio[0]).isFile(), true);
        assert.equal(fs.fstatSync(options.stdio[0]).mode & 0o777, 0o600);
        descriptors.push(options.stdio[0]);
        return original(file, args, options);
    });
    const summary = '语音 &amp; audio '.repeat(1600);
    const entries = Array.from({ length: 100 }, (_, index) => entry(index + 1, summary));
    const xml = feed(entries);
    assert.ok(Buffer.byteLength(xml) > 2 * 1024 * 1024);
    const page = parseArxivXML(xml, 'cs.AI', null, { feedPage: true });
    assert.equal(page.totalResults, 100);
    assert.equal(page.entries.length, 100);
    assert.equal(page.entries[99].abstract, '语音 & audio '.repeat(1600).trim());
    assert.equal(parseArxivXML(xml, 'cs.AI').length, 100);
    for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('Atom source rejection stays distinct from runtime failure and input cap remains', () => {
    for (const xml of ['<feed>', '<!DOCTYPE feed><feed/>', feed([entry(1, 'audio')]).replace('https://arxiv.org/abs/2610.00001v1', 'https://example.invalid/2610.00001')]) {
        assert.throws(() => parseArxivXML(xml, 'cs.AI'), error => {
            assert.equal(isDailyXmlOperationalError(error), false);
            return /Atom XML 解析失败/.test(error.message);
        });
    }
    assert.throws(() => parseArxivXML('x'.repeat(16 * 1024 * 1024 + 1), 'cs.AI'), /字节上限/);
    assert.equal(parseArxivXML('<feed/>', 'cs.AI').length, 0);
});

test('Atom parser output has separate exact list and page schemas', () => {
    for (const [kind, value] of [['atom', {}], ['atom', [{}]], ['atom-feed', []], ['atom-feed', { entries: [], totalResults: -1, startIndex: 0, itemsPerPage: 100 }]]) {
        assert.throws(() => runDailyXmlPython(`print(${JSON.stringify(JSON.stringify(value))})`, Buffer.from('x'), { outputKind: kind }), isDailyXmlOperationalError);
    }
});

for (const [name, outcome] of [
    ['timeout', { error: Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '', stderr: '' }],
    ['invalid JSON', { status: 0, signal: null, stdout: 'broken', stderr: '' }],
    ['output cap', { error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM', stdout: '', stderr: '' }]
]) test(`Atom ${name} stops normal date/category routes without fallback or extra request`, async t => {
    t.mock.method(child, 'spawnSync', () => outcome);
    for (const fetch of [fetchDailyArxivCategory, fetchCategoryPrefix]) {
        let requests = 0;
        await assert.rejects(fetch('cs.AI', boundary, null, {
            officialOaiRecovery: true, maxRetries: 3,
            requestFn: async () => { requests++; return { status: 200, data: feed([entry(1, 'audio')]) }; },
            requestScheduler: { run: async (_host, task) => task() }, sleepFn: async () => {}
        }), error => {
            assert.equal(isDailyXmlOperationalError(error), true);
            assert.equal(error.sourceHealth.attempts, 1);
            // Date-window health counts HTTP responses; the existing category
            // route counts only pages that have also passed its parser.
            assert.equal(error.sourceHealth.successfulRequests, fetch === fetchCategoryPrefix ? 0 : 1);
            assert.equal(error.sourceHealth.provider.window.covered, false);
            assert.equal(error.sourceHealth.failures.length, 1);
            return true;
        });
        assert.equal(requests, 1);
    }
});
