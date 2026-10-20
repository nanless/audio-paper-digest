'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchDailyOaiCategory, hasVerifiedOaiCoverage, parseOaiXml, SETS } = require('../scripts/lib/daily-arxiv-oai-source');
const sort = x => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
const sha = x => crypto.createHash('sha256').update(JSON.stringify(sort(x))).digest('hex');
function boundary(witness = false) {
    const b = { contract: 'daily-fetch-boundary-v1', lastDigestDate: '2026-10-19',
        since: '2026-10-16T14:35:00.000Z', until: '2026-10-19T03:00:00.000Z' };
    if (witness) {
        b.continuity = { contract: 'daily-fetch-continuity-v1', required: true,
            originalSince: '2026-10-19T02:47:23.335Z', archiveCheckpointSha256: 'a'.repeat(64),
            overlapCutoffDate: '2026-10-19', witnesses: { arxiv: Object.keys(SETS).map(categoryId => categoryId === 'eess.AS'
                ? { categoryId, status: 'expected', arxivId: '2610.23539', published: '2026-10-16T14:35:04.000Z' }
                : { categoryId, status: 'not-applicable', reason: 'no-previous-records' }),
            huggingface: { status: 'not-applicable', reason: 'no-previous-records' } } };
        b.provenance = { archiveProofs: ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json',
            'deep-analysis-result.json', 'blog-generation-manifest-2026-10-19.json'].map(file => ({ file, sha256: 'a'.repeat(64) })) };
    }
    b.identitySha256 = sha(b); return b;
}
// Identity/timestamp shape derived from the real official GetRecord response
// observed on 2026-10-20 (ConvexLLM 2610.23539). ListRecords wrappers, v2,
// pagination and dates below are explicit synthetic protocol variations.
const realTitle = 'ConvexLLM: Scaling Convex-Hull Speech Interfaces to General-Purpose Audio Intelligence';
const authors = ['Ming-Hao Hsu', 'Shujie Liu', 'Yuxuan Hu', 'Yuxiang Wang', 'Yingda Shen', 'Jinyu Li', 'Zhizheng Wu'];
function record(prefix, id = '2610.23539', options = {}) {
    const date = options.date || 'Fri, 16 Oct 2026 14:35:04 GMT';
    const header = `<header${options.deleted ? ' status="deleted"' : ''}><identifier>oai:arXiv.org:${id}</identifier><datestamp>2026-10-19</datestamp><setSpec>cs:cs:CL</setSpec><setSpec>cs:cs:SD</setSpec><setSpec>eess:eess:AS</setSpec></header>`;
    const common = `<id>${id}</id><title>${realTitle}</title><categories>cs.CL cs.SD eess.AS</categories><abstract>Speech and audio language models connect continuous acoustic representations.</abstract>`;
    const raw = `<authors>${authors.join(', ')}</authors><version version="v1"><date>${date}</date></version>${options.v2 ? '<version version="v2"><date>Mon, 19 Oct 2026 08:12:03 GMT</date></version>' : ''}`;
    const normal = `<created>2026-10-16</created>${options.v2 ? '<updated>2026-10-19</updated>' : ''}<authors>${authors.map(name => {
        const words = name.split(' '); return `<author><keyname>${words.pop()}</keyname><forenames>${words.join(' ')}</forenames></author>`;
    }).join('')}</authors>`;
    return `<record>${header}<metadata><${prefix} xmlns="http://arxiv.org/OAI/${prefix}/">${common}${prefix === 'arXivRaw' ? raw : normal}</${prefix}></metadata></record>`;
}
function envelope(prefix, records, token = '', requestToken = '', options = {}) {
    const attributes = requestToken ? `verb="ListRecords" resumptionToken="${requestToken}"`
        : `verb="ListRecords" metadataPrefix="${prefix}" set="eess:eess:AS" from="2026-10-16"`;
    return `<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><responseDate>${options.responseDate || '2026-10-20T03:00:00Z'}</responseDate><request ${attributes}>http://oaipmh.arxiv.org/oai</request><ListRecords>${records.join('')}<resumptionToken>${token}</resumptionToken></ListRecords></OAI-PMH>`;
}
function setup(t, b = boundary(), transform = x => x, rows = ['2610.23539']) {
    // No project credentials, network, or moving data/current fixtures are needed.
    t.mock.method(Date, 'now', () => Date.parse('2026-10-20T05:00:00.000Z'));
    require('../scripts/utils');
    const oldProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    t.after(() => { oldProxy === undefined ? delete process.env.HTTPS_PROXY : process.env.HTTPS_PROXY = oldProxy; });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-oai-')));
    const evidenceDir = path.join(root, 'oai-evidence');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rss = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>eess.AS updates on arXiv.org</title><link>http://rss.arxiv.org/rss/eess.AS</link><description>eess.AS updates on the arXiv.org e-print archive.</description><atom:link href="http://rss.arxiv.org/rss/eess.AS" rel="self" type="application/rss+xml"/><pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate><lastBuildDate>Mon, 19 Oct 2026 04:00:23 +0000</lastBuildDate>${rows.map(id => `<item><title>A</title><link>https://arxiv.org/abs/${id}</link><description>arXiv:${id}v1 Announce Type: cross \nAbstract: A.</description><guid isPermaLink="false">oai:arXiv.org:${id}v1</guid><category>eess.AS</category><pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate><arxiv:announce_type>cross</arxiv:announce_type></item>`).join('')}</channel></rss>`;
    const rssHash = crypto.createHash('sha256').update(rss).digest('hex');
    const rssPath = path.join(root, `rss-eess.AS-${rssHash}.xml`);
    fs.writeFileSync(rssPath, rss, { mode: 0o600, flag: 'wx' });
    const calls = [], deferrals = [];
    return { evidenceDir, calls, deferrals, announcementEvidence: {
        contract: 'daily-arxiv-announcement-evidence-v1', categoryId: 'eess.AS', boundaryIdentity: b.identitySha256,
        url: 'https://rss.arxiv.org/rss/eess.AS', retrievedAt: '2026-10-20T03:00:00.000Z', filePath: rssPath,
        bytes: Buffer.byteLength(rss), sha256: rssHash
    }, triggerFailure: { categoryId: 'eess.AS', ok: false, failures: [{ error: 'HTTP 429' }],
        provider: { boundaryIdentity: b.identitySha256, window: { since: b.since, until: b.until, covered: false, coverageContract: 'daily-arxiv-atom-prefix-coverage-v1' },
            categoryPrefix: { contract: 'daily-arxiv-atom-prefix-coverage-v1', categoryId: 'eess.AS', boundaryIdentity: b.identitySha256,
                dateQueryFailure: { health: {
            categoryId: 'eess.AS', failures: [{ error: 'HTTP 429' }], provider: { boundaryIdentity: b.identitySha256,
                window: { since: b.since, until: b.until, covered: false } } } } } } },
    requestScheduler: { run: async (host, task, options) => {
        assert.equal(host, 'oaipmh.arxiv.org'); assert.equal(options.minimumCooldownMs, 5000); return task();
    }, defer: (host, delay) => deferrals.push({ host, delay }) },
    requestFn: async (url, headers, proxy) => {
        assert.ok(proxy); calls.push(url);
        const params = new URL(url).searchParams;
        assert.equal(params.has('until'), false);
        const token = params.get('resumptionToken') || '';
        const prefix = params.get('metadataPrefix') || (token.startsWith('raw') ? 'arXivRaw' : 'arXiv');
        const index = token ? 1 : 0;
        return transform({ status: 200, data: envelope(prefix, [record(prefix, rows[index] || rows[0])],
            rows.length > 1 && index === 0 ? (prefix === 'arXivRaw' ? 'raw-next' : 'normal-next') : '', token) }, { prefix, index, url, call: calls.length });
    } };
}

test('complete official-format streams use exact v1 time rather than header datestamp and cold replay actual XML', async t => {
    const b = boundary(), opts = setup(t, b);
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(papers.length, 1); assert.equal(papers[0].published, '2026-10-16T14:35:04.000Z');
    assert.deepEqual(papers[0].authors, authors);
    assert.equal(papers._sourceHealth.coverageComplete, true);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
    assert.equal(opts.calls.length, 4);
    for (const file of fs.readdirSync(opts.evidenceDir)) assert.equal(fs.statSync(path.join(opts.evidenceDir, file)).mode & 0o777, 0o600);
});

test('whole token chains complete both formats; pre-dedup original witness still required', async t => {
    const b = boundary(true), opts = setup(t, b, x => x, ['2610.23539', '2610.23540']);
    const papers = await fetchDailyOaiCategory('eess.AS', b, new Set(['2610.23539']), opts);
    assert.deepEqual(papers.map(p => p.arxivId), ['2610.23540v1']);
    assert.equal(opts.calls.length, 6);
    assert.equal(papers._sourceHealth.provider.continuity.encounterVerified, true);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
    const changed = structuredClone(papers._sourceHealth); changed.provider.oai.streams.arXivRaw.pop();
    assert.equal(hasVerifiedOaiCoverage(changed, b), false);
});

test('v2 update preserves v1 publication and uses exact latest update', async t => {
    const b = boundary(), opts = setup(t, b, (r, ctx) => ({ ...r, data: envelope(ctx.prefix, [record(ctx.prefix, undefined, { v2: true })]) }));
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(papers[0].arxivId, '2610.23539v2');
    assert.equal(papers[0].published, '2026-10-16T14:35:04.000Z');
    assert.equal(papers[0].updated, '2026-10-19T08:12:03.000Z');
});

for (const [name, transform] of [
    ['stale responseDate', r => ({ ...r, data: r.data.replace('2026-10-20T03:00:00Z', '2026-10-19T02:59:59Z') })],
    ['future responseDate', r => ({ ...r, data: r.data.replace('2026-10-20T03:00:00Z', '2099-01-01T00:00:00Z') })],
    ['wrong set request', r => ({ ...r, data: r.data.replace('set="eess:eess:AS"', 'set="cs:cs:AI"') })],
    ['wrong metadata namespace', r => ({ ...r, data: r.data.replace('http://arxiv.org/OAI/arXivRaw/', 'https://example.org/') })],
    ['wrong record set', r => ({ ...r, data: r.data.replace('<setSpec>eess:eess:AS</setSpec>', '<setSpec>cs:cs:AI</setSpec>') })],
    ['wrong record category', r => ({ ...r, data: r.data.replace('cs.CL cs.SD eess.AS', 'cs.CL cs.SD cs.AI') })],
    ['deleted record', (r, ctx) => ({ ...r, data: envelope(ctx.prefix, [record(ctx.prefix, undefined, { deleted: true })]) })],
    ['missing metadata', r => ({ ...r, data: r.data.replace(/<metadata>[\s\S]*?<\/metadata>/, '') })],
    ['malformed XML', r => ({ ...r, data: r.data.slice(0, -6) })],
    ['OAI protocol error', r => ({ ...r, data: r.data.replace('<ListRecords>', '<error code="badArgument">bad</error><ListRecords>') })],
    ['missing authoritative structured title', (r, ctx) => ctx.prefix === 'arXiv' ? ({ ...r, data: r.data.replace(`<title>${realTitle}</title>`, '') }) : r],
    ['missing authoritative structured author keyname', (r, ctx) => ctx.prefix === 'arXiv' ? ({ ...r, data: r.data.replace('<keyname>Hsu</keyname>', '') }) : r],
    ['impossible structured chronology', (r, ctx) => ctx.prefix === 'arXiv' ? ({ ...r, data: r.data.replace('<created>2026-10-16</created>', '<created>2026-10-21</created>') }) : r],
    ['changed complete member set', (r, ctx) => ctx.prefix === 'arXiv' ? ({ ...r, data: r.data.replaceAll('2610.23539', '2610.23540') }) : r],
    ['metadata older than from', r => ({ ...r, data: r.data.replace('<datestamp>2026-10-19</datestamp>', '<datestamp>2026-10-15</datestamp>') })]
]) test(`OAI rejects ${name} with coverage false`, async t => {
    const b = boundary(), opts = setup(t, b, transform);
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), e => e.code === 'SOURCE_FETCH_FAILED' && !e.sourceHealth.coverageComplete && !e.sourceHealth.provider.window.covered);
});

test('missing, changed or post-dedup absent original witness cannot establish continuity', async t => {
    const b = boundary(true), opts = setup(t, b, (r, ctx) => ({ ...r,
        data: envelope(ctx.prefix, [record(ctx.prefix, '2610.23540')]) }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, ['2610.23539'], opts), /did not encounter original witness/);
    const changed = setup(t, b, (r, ctx) => ({ ...r, data: envelope(ctx.prefix,
        [record(ctx.prefix, undefined, { date: 'Fri, 16 Oct 2026 14:35:05 GMT' })]) }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, ['2610.23539'], changed), /witness publication changed/);
});

test('token loop, wrong token and duplicate page records fail before source qualification', async t => {
    for (const kind of ['loop', 'wrong', 'duplicate']) {
        const b = boundary(), opts = setup(t, b, (r, ctx) => {
            if (!ctx.index) return r;
            if (kind === 'loop') return { ...r, data: r.data.replace('<resumptionToken></resumptionToken>', '<resumptionToken>raw-next</resumptionToken>') };
            if (kind === 'wrong') return { ...r, data: r.data.replace('resumptionToken="raw-next"', 'resumptionToken="foreign"') };
            return { ...r, data: r.data.replaceAll('2610.23540', '2610.23539') };
        }, ['2610.23539', '2610.23540']);
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /token|duplicate|identity/i);
    }
});

test('cold validator rejects XML drift/deletion, changed candidates, boundary and bare self-reported covered', async t => {
    const b = boundary(), opts = setup(t, b), papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    const health = papers._sourceHealth;
    assert.equal(hasVerifiedOaiCoverage({ provider: { window: { covered: true } } }, b), false);
    const changed = structuredClone(health); changed.provider.oai.candidateSha256 = 'f'.repeat(64);
    assert.equal(hasVerifiedOaiCoverage(changed, b), false);
    const wrongBoundary = structuredClone(b); wrongBoundary.until = '2026-10-20T02:00:00.000Z';
    assert.equal(hasVerifiedOaiCoverage(health, wrongBoundary), false);
    const source = path.join(opts.evidenceDir, health.provider.oai.streams.arXivRaw[0].file);
    fs.appendFileSync(source, ' ');
    assert.equal(hasVerifiedOaiCoverage(health, b), false);
    fs.unlinkSync(source); assert.equal(hasVerifiedOaiCoverage(health, b), false);
});

test('fallback requires both actual original HTTP429 triggers, never a normal default route', async t => {
    const b = boundary(), opts = setup(t, b);
    opts.triggerFailure.failures[0].error = 'HTTP 500';
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /requires original/);
    assert.equal(opts.calls.length, 0);
});

test('proxy absence cannot be bypassed even by a supplied request implementation', async t => {
    const b = boundary(), opts = setup(t, b), keys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
    const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
        keys.forEach(k => { delete process.env[k]; });
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /HTTP CONNECT/);
        assert.equal(opts.calls.length, 0);
    } finally { for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]; }
});

test('official 503 Retry-After defers the shared host scheduler before retry and retains rejected body', async t => {
    const b = boundary(), opts = setup(t, b, (r, ctx) => ctx.call === 1
        ? { status: 503, data: 'temporarily unavailable', headers: { 'retry-after': '37' } } : r);
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.deepEqual(opts.deferrals, [{ host: 'oaipmh.arxiv.org', delay: 37000 }]);
    assert.equal(papers._sourceHealth.attempts, 5);
    assert.equal(papers._sourceHealth.failures[0].error, 'HTTP 503');
    assert.equal(fs.readdirSync(opts.evidenceDir).length, 5);
});

test('an empty official 503 body preserves its status and Retry-After; a 200 empty body fails', async t => {
    const b = boundary(), opts = setup(t, b, (r, ctx) => ctx.call === 1
        ? { status: 503, data: '', headers: { 'retry-after': '37' } } : r);
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.deepEqual(opts.deferrals, [{ host: 'oaipmh.arxiv.org', delay: 37000 }]);
    const failure = papers._sourceHealth.failures[0];
    assert.equal(failure.error, 'HTTP 503'); assert.equal(failure.bytes, 0);
    assert.equal(fs.statSync(path.join(opts.evidenceDir, failure.file)).size, 0);
    const emptySuccess = setup(t, b, () => ({ status: 200, data: '' }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], emptySuccess), /body size invalid/);
});

test('a real-shape TLS ECONNRESET retries the same proxied page and preserves original failure identity', async t => {
    const original = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
    const b = boundary(), opts = setup(t, b, (r, ctx) => { if (ctx.call === 1) throw original; return r; });
    const request = opts.requestFn, inputs = [];
    opts.requestFn = (...args) => { inputs.push(args); return request(...args); };
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(opts.calls.length, 5);
    assert.equal(opts.calls[0], opts.calls[1]);
    assert.deepEqual(inputs[0].slice(0, 5), inputs[1].slice(0, 5));
    const failed = papers._sourceHealth.failures[0];
    assert.equal(failed.code, 'ECONNRESET'); assert.equal(failed.error, original.message);
    assert.equal(failed.url, opts.calls[0]); assert.equal(failed.prefix, 'arXivRaw');
    assert.equal(failed.index, 0); assert.equal(failed.requestToken, '');
    assert.equal(failed.replayPage, false); assert.equal(failed.attempt, 1);
    assert.equal('file' in failed, false);
    assert.equal(fs.readdirSync(opts.evidenceDir).length, 4);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers, []), true);
});

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT']) {
    test(`transport ${code} consumes only the original three page attempts`, async t => {
        const errors = [], b = boundary(), opts = setup(t, b, () => {
            const error = Object.assign(new Error(`Original ${code} transport failure`), { code });
            errors.push(error); throw error;
        });
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), error => {
            assert.equal(error.code, 'SOURCE_FETCH_FAILED'); assert.equal(error.cause, errors[2]);
            assert.equal(error.cause.code, code); assert.equal(error.sourceHealth.coverageComplete, false);
            assert.deepEqual(error.sourceHealth.failures.filter(item => item.code === code).map(item => item.attempt), [1, 2, 3]);
            return true;
        });
        assert.equal(opts.calls.length, 3); assert.equal(new Set(opts.calls).size, 1);
        assert.deepEqual(fs.readdirSync(opts.evidenceDir), []);
    });
}

test('HTTP 503 and TLS failures share one three-attempt page limit', async t => {
    const original = Object.assign(new Error('TLS reset after Retry-After'), { code: 'ECONNRESET' });
    const b = boundary(), opts = setup(t, b, (r, ctx) => {
        if (ctx.call === 2) throw original;
        return { status: 503, data: '', headers: { 'retry-after': '37' } };
    });
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), error => {
        const failures = error.sourceHealth.failures.filter(item => item.attempt !== undefined);
        assert.deepEqual(failures.map(item => item.attempt), [1, 2, 3]);
        assert.deepEqual(failures.map(item => item.code || item.error), ['HTTP 503', 'ECONNRESET', 'HTTP 503']);
        assert.equal(failures[1].error, original.message); assert.equal('file' in failures[1], false);
        return true;
    });
    assert.equal(opts.calls.length, 3); assert.equal(new Set(opts.calls).size, 1);
    assert.deepEqual(opts.deferrals, [{ host: 'oaipmh.arxiv.org', delay: 37000 }]);
    assert.equal(fs.readdirSync(opts.evidenceDir).length, 2);
});

test('structured first-page replay retains its identity when its TLS request is retried', async t => {
    const b = boundary(), opts = setup(t, b, (r, ctx) => {
        if (ctx.call === 4) throw Object.assign(new Error('TLS replay reset'), { code: 'ECONNRESET' });
        return r;
    });
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    const failure = papers._sourceHealth.failures[0];
    assert.equal(failure.prefix, 'arXiv'); assert.equal(failure.replayPage, true); assert.equal(failure.attempt, 1);
    assert.equal(opts.calls[3], opts.calls[4]); assert.equal(opts.calls.length, 5);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers, []), true);
});

test('nontransport request errors, scheduler errors and XML failures do not gain retries', async t => {
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'EAUTH', undefined]) {
        const original = Object.assign(new Error('Original nonretryable request error'), code ? { code } : {});
        const b = boundary(), opts = setup(t, b, () => { throw original; });
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), error => error.cause === original);
        assert.equal(opts.calls.length, 1); assert.deepEqual(fs.readdirSync(opts.evidenceDir), []);
    }
    const b = boundary(), scheduler = setup(t, b);
    scheduler.requestScheduler.run = async () => { throw Object.assign(new Error('Scheduler failure'), { code: 'ECONNRESET' }); };
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], scheduler), /Scheduler failure/);
    assert.equal(scheduler.calls.length, 0);
    const malformed = setup(t, b, r => ({ ...r, data: '<broken>' }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], malformed), /XML parse failed/);
    assert.equal(malformed.calls.length, 1); assert.equal(fs.readdirSync(malformed.evidenceDir).length, 1);
    const identity = setup(t, b, r => ({ ...r, data: r.data.replace('set="eess:eess:AS"', 'set="cs:cs:AI"') }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], identity), /request identity mismatch/);
    assert.equal(identity.calls.length, 1);
});

test('a local save failure with a transport-looking code never retries the already returned response', async t => {
    const b = boundary(), opts = setup(t, b), actualWrite = fs.writeFileSync;
    const original = Object.assign(new Error('Local response preservation failed'), { code: 'ECONNRESET' });
    t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
        if (path.dirname(filename) === opts.evidenceDir) throw original;
        return actualWrite.call(fs, filename, ...args);
    });
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), error => error.cause === original);
    assert.equal(opts.calls.length, 1); assert.deepEqual(fs.readdirSync(opts.evidenceDir), []);
});

test('DTD/entities and nested foreign records are rejected by actual XML parser', () => {
    assert.throws(() => parseOaiXml('<!DOCTYPE x [<!ENTITY foo "bar">]><x/>'), /forbidden/);
    assert.throws(() => parseOaiXml(envelope('arXivRaw', [record('arXivRaw')]).replace('<ListRecords>', '<ListRecords><wrapper><record/></wrapper>')), /nested/);
});

test('legitimate single-page omission of resumptionToken is complete; changed homepage replay is rejected', async t => {
    const b = boundary(), opts = setup(t, b, r => ({ ...r, data: r.data.replace('<resumptionToken></resumptionToken>', '') }));
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
    const drift = setup(t, b, (r, ctx) => ctx.call === 2 ? { ...r, data: r.data.replace(realTitle, 'Changed title') } : r);
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], drift), /first page changed/);
});

test('current announcement is mandatory and all its IDs must be in the unfiltered OAI set', async t => {
    const b = boundary(), opts = setup(t, b, r => ({ ...r, data: r.data.replaceAll('2610.23539', '2610.23540') }));
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /omit current official announcement/);
    const good = setup(t, b), papers = await fetchDailyOaiCategory('eess.AS', b, [], good);
    const missing = structuredClone(papers._sourceHealth); delete missing.provider.oai.announcement;
    assert.equal(hasVerifiedOaiCoverage(missing, b), false);
    fs.appendFileSync(good.announcementEvidence.filePath, ' ');
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b), false);
});

test('strict trigger cold replay rejects contract/category/window/success and mixed-error tampering', async t => {
    const b = boundary(), opts = setup(t, b), papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    for (const mutate of [
        h => { h.ok = true; },
        h => { h.id = 'cs.SD'; },
        h => { h.provider.window.covered = true; },
        h => { h.provider.window.until = '2026-10-19T03:00:01.000Z'; },
        h => { h.provider.categoryPrefix.contract = 'unknown'; },
        h => { h.provider.categoryPrefix.categoryId = 'cs.SD'; },
        h => { h.provider.categoryPrefix.boundaryIdentity = 'f'.repeat(64); },
        h => { h.failures.push({ error: 'HTTP 500' }); },
        h => { h.provider.categoryPrefix.dateQueryFailure.health.provider.window.covered = true; },
        h => { h.provider.categoryPrefix.dateQueryFailure.health.categoryId = 'cs.SD'; }
    ]) {
        const changed = structuredClone(papers._sourceHealth); mutate(changed.provider.oai.triggerFailure);
        assert.equal(hasVerifiedOaiCoverage(changed, b), false);
    }
});

test('optional official pagination counters must describe the actual complete chain', async t => {
    const counters = (r, ctx) => ({ ...r, data: r.data.replace('<resumptionToken>', `<resumptionToken cursor="${ctx.index}" completeListSize="2">`) });
    const b = boundary(), good = setup(t, b, counters, ['2610.23539', '2610.23540']);
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], good);
    assert.equal(papers.length, 2); assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
    for (const kind of ['wrong-cursor', 'changed-total', 'hidden-tail', 'invalid-counter']) {
        const opts = setup(t, b, (r, ctx) => {
            r = counters(r, ctx);
            if (kind === 'wrong-cursor' && ctx.index) r.data = r.data.replace('cursor="1"', 'cursor="0"');
            if (kind === 'changed-total' && ctx.index) r.data = r.data.replace('completeListSize="2"', 'completeListSize="3"');
            if (kind === 'hidden-tail') r.data = r.data.replace(/(<resumptionToken[^>]*>)[^<]+/, '$1');
            if (kind === 'invalid-counter') r.data = r.data.replace('completeListSize="2"', 'completeListSize="2x"');
            return r;
        }, ['2610.23539', '2610.23540']);
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /cursor|completeListSize|declared total|counter/);
    }
});

test('a pinned fetchedAt must be the exact original instant and extra candidate fields cannot be ignored', async t => {
    const b = boundary(), opts = setup(t, b), papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    const pinned = structuredClone(papers).map(p => ({ ...p, fetchedAt: '2026-10-19T11:00:00.000+08:00' }));
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', pinned), true);
    pinned[0].fetchedAt = '2026-10-19T11:00:01.000+08:00';
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', pinned), false);
    const extra = structuredClone(papers); extra[0].fake = 'ignored';
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', extra), false);
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /EEXIST/);
});

for (const date of ['Thu, 16 Oct 2026 14:35:04 GMT', 'Tue, 31 Feb 2026 14:35:04 GMT']) {
    test(`Raw invalid calendar/weekday must fail: ${date}`, async t => {
        const b = boundary(), opts = setup(t, b, (r, ctx) => ({ ...r, data: envelope(ctx.prefix, [record(ctx.prefix, undefined, { date })]) }));
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /version chain\/date invalid/);
    });
}

test('OAI actual XML/RSS candidates survive normal checkpoint reload; recomputed hashes cannot hide edited science', async t => {
    const b = boundary(), opts = setup(t, b, r => ({ ...r,
        data: r.data.replaceAll('Speech and audio language models connect continuous acoustic representations.', 'Audio accuracy is 31.98%.') }));
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    const pipeline = require('../scripts/full-fetch'), validator = require('../scripts/validate-data-files');
    const config = require('../scripts/config');
    for (const p of papers) p.fetchedAt = require('../scripts/utils').normalizeToBeijingISOString(b.until);
    const health = pipeline.buildArxivCategoryHealth(config.ARXIV_CATEGORIES.find(c => c.id === 'eess.AS'), { papers, fetchHealth: papers._sourceHealth });
    const provider = { boundaryIdentity: b.identitySha256, window: { since: b.since, until: b.until, covered: true } };
    const checkpoint = { ...pipeline.buildCandidateFingerprints(new Set(), new Set(), b),
        batchId: 'b'.repeat(16), batchDate: '2026-10-19', batchStartedAt: '2026-10-19T11:00:00.000+08:00',
        historicalDedupIds: [], categoryOrder: config.ARXIV_CATEGORIES.map(c => c.id),
        arxiv: Object.fromEntries(config.ARXIV_CATEGORIES.map(c => [c.id, { status: 'complete', papers: c.id === 'eess.AS' ? papers : [],
            health: c.id === 'eess.AS' ? health : { id: c.id, ok: true, provider: structuredClone(provider) } }])),
        huggingface: { status: 'complete', papers: [], health: { ok: true, provider: { ...provider,
            cutoffDate: b.lastDigestDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } } } };
    const filename = path.join(path.dirname(opts.evidenceDir), 'fetch-checkpoint.json');
    pipeline.saveFetchCheckpoint(checkpoint, filename);
    const stored = pipeline.loadFetchCheckpoint('2026-10-19', checkpoint.candidateFingerprint, filename);
    assert.ok(stored); assert.equal(pipeline.hasCompleteFetchCheckpoint(stored), true);
    assert.deepEqual(validator.validateFetchCheckpointFile(filename), []);
    for (const mutate of [
        entry => { entry.papers[0].abstract = 'Unrelated fabricated scientific result'; },
        entry => { entry.papers[0].abstract = entry.papers[0].abstract.replace('31.98%', '99.98%'); },
        entry => { entry.papers[0].authors[0] = 'Other Author'; },
        entry => { entry.papers[0].authors.reverse(); },
        entry => { entry.papers[0].extra = 'arbitrary field'; }
    ]) {
        const altered = structuredClone(stored), entry = altered.arxiv['eess.AS'];
        mutate(entry);
        // Recompute even the self-reported candidate identity, in addition to
        // the normal checkpoint/source hashes. Raw structured XML still wins.
        entry.health.provider.oai.candidateSha256 = sha(entry.papers.map(({ fetchedAt, ...p }) => p));
        pipeline.saveFetchCheckpoint(altered, filename);
        assert.equal(pipeline.hasCompleteFetchCheckpoint(altered), false);
        assert.ok(validator.validateFetchCheckpointFile(filename).some(issue => JSON.stringify(issue).includes('未证明完整补更范围')));
    }
    const omitted = structuredClone(stored), omittedEntry = omitted.arxiv['eess.AS'];
    omittedEntry.health.provider.oai.existingIds = ['2610.23539'];
    omittedEntry.papers = []; omittedEntry.health.provider.oai.candidateSha256 = sha([]);
    assert.equal(hasVerifiedOaiCoverage(omittedEntry.health, b, 'eess.AS', [], []), false);
    pipeline.saveFetchCheckpoint(omitted, filename);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(omitted), false);
    assert.ok(validator.validateFetchCheckpointFile(filename).some(issue => JSON.stringify(issue).includes('未证明完整补更范围')));
});

test('scientific text comes unchanged from structured XML without converting Raw TeX commands', () => {
    const { reconstructOaiCandidates } = require('../scripts/lib/daily-arxiv-oai-source');
    const r = parseOaiXml(envelope('arXivRaw', [record('arXivRaw')])).records;
    const n = parseOaiXml(envelope('arXiv', [record('arXiv')])).records;
    r[0].abstract = String.raw`Accent \v{c}, \v c, \'i. Unknown \vertex \update \degree.`;
    n[0].abstract = String.raw`Accent č, č, í. Unknown \vertex \update \degree.`;
    assert.equal(reconstructOaiCandidates(r, n, 'eess.AS', boundary()).papers.length, 1);
    for (const [raw, authoritativeText] of [[String.raw`\vertex`, 'ěrtex'],
        [String.raw`\update`, 'p\u0306date'], [String.raw`\degree`, 'ẹgree']]) {
        r[0].abstract = raw; n[0].abstract = authoritativeText;
        assert.equal(reconstructOaiCandidates(r, n, 'eess.AS', boundary()).papers[0].abstract, authoritativeText);
    }
});

// Real seven-record subsets of the two official 82-record responses observed
// 2026-10-20; gzip keeps the portable fixture independent of mutable runtime.
const REAL_PAIR_GZIP = ["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"];
test('real official Raw/structured pairs preserve v1 and authoritative structured scientific text', () => {
    const { reconstructOaiCandidates } = require('../scripts/lib/daily-arxiv-oai-source');
    const [raw, normal] = REAL_PAIR_GZIP.map(value => parseOaiXml(require('node:zlib').gunzipSync(Buffer.from(value, 'base64'))));
    assert.equal(raw.records.length, 7); assert.equal(normal.records.length, 7);
    const historical = normal.records.find(r => r.id === '2412.17907');
    assert.equal(historical.created, '2026-10-15');
    assert.match(raw.records.find(r => r.id === historical.id).versions[0].date, /23 Dec 2024/);
    const broad = boundary(); broad.since = '2024-01-01T00:00:00.000Z'; delete broad.identitySha256; broad.identitySha256 = sha(broad);
    const result = reconstructOaiCandidates(raw.records, normal.records, 'eess.AS', broad);
    assert.equal(result.papers.find(p => p.arxivId.startsWith('2412.17907')).published, '2024-12-23T19:00:34.000Z');
    assert.equal(result.papers.length, 7);
    const changed = structuredClone(normal.records);
    changed.find(r => r.id === '2610.17131').abstract = changed.find(r => r.id === '2610.17131').abstract.replace('31.98%', '99.98%');
    assert.match(reconstructOaiCandidates(raw.records, changed, 'eess.AS', broad).papers.find(p => p.arxivId.startsWith('2610.17131')).abstract, /99\.98%/);
});

// Real differing official-format records captured during the read-only
// 2026-10-20 preflight: Raw TeX rho and Raw free-form affiliation annotations.
const REAL_FIELD_AUTHORITIES = [{"categoryId": "cs.SD", "id": "2610.22221", "arXivRaw": "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", "arXiv": "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"}, {"categoryId": "eess.SP", "id": "2610.21617", "arXivRaw": "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", "arXiv": "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"}];
for (const fixture of REAL_FIELD_AUTHORITIES) test('real field authorities remain source-exact: '+fixture.id, () => {
    const { reconstructOaiCandidates } = require('../scripts/lib/daily-arxiv-oai-source');
    const [raw, normal] = ['arXivRaw','arXiv'].map(prefix => parseOaiXml(require('node:zlib').gunzipSync(Buffer.from(fixture[prefix], 'base64'))).records);
    assert.equal(raw.length, 1); assert.equal(normal.length, 1);
    const b = boundary(); b.since = '2026-10-15T00:00:00.000Z'; delete b.identitySha256; b.identitySha256 = sha(b);
    const result = reconstructOaiCandidates(raw, normal, fixture.categoryId, b).papers;
    assert.equal(result.length, 1);
    assert.equal(result[0].title, normal[0].title.replace(/\s+/g, ' ').trim());
    assert.equal(result[0].abstract, normal[0].abstract.replace(/\s+/g, ' ').trim());
    if (fixture.id === '2610.22221') {
        assert.ok(raw[0].abstract.includes(String.raw`\rho`));
        assert.ok(result[0].abstract.includes('ρ=0.73'));
    } else {
        assert.ok(raw[0].rawAuthors.includes('Istanbul Medipol University'));
        assert.deepEqual(result[0].authors, ['Sadiq Iqbal', 'Abdelali Arous', 'Huseyin Arslan']);
    }
    const changed = structuredClone(normal); changed[0].datestamp = '2026-10-17';
    assert.throws(() => reconstructOaiCandidates(raw, changed, fixture.categoryId, b), /header drift/);
});

// Official server query_data[FROM] mutation, with explicit synthetic protocol
// variations below. These small cases do not stand in for the raw-page fixture.
function dateToken(prefix, from, skip, entries) {
    return encodeURIComponent(new URLSearchParams(entries || [
        ['verb', 'ListRecords'], ['metadataPrefix', prefix], ['from', from], ['set', 'eess:eess:AS'], ['skip', String(skip)]
    ]).toString());
}
function cursorSetup(t, config = {}) {
    const b = boundary(), rows = ['2610.23539', '2610.23540'];
    const opts = setup(t, b, undefined, rows);
    const pageDays = config.pageDays || ['2026-10-19', '2026-10-19'];
    opts.requestFn = async url => {
        opts.calls.push(url);
        const params = new URL(url).searchParams, incoming = params.get('resumptionToken') || '';
        const decoded = incoming ? new URLSearchParams(decodeURIComponent(incoming)) : params;
        const prefix = decoded.get('metadataPrefix'), index = incoming ? 1 : 0;
        const out = index || config.noToken ? '' : dateToken(prefix, config.from || '2026-10-19', config.skip ?? 1);
        const records = [record(prefix, rows[index]).replace('<datestamp>2026-10-19</datestamp>', `<datestamp>${pageDays[index]}</datestamp>`)];
        let data = envelope(prefix, records, out, incoming);
        if (!incoming) {
            assert.equal(params.get('from'), '2026-10-16');
            const echo = config.echoFrom || (out ? config.from || '2026-10-19' : '2026-10-16');
            data = data.replace('from="2026-10-16"', `from="${echo}"`);
        }
        const result = { status: 200, data };
        return config.transform ? config.transform(result, { prefix, index, incoming, out, call: opts.calls.length }) : result;
    };
    return { b, opts };
}

test('official canonical date token permits only its verified initial from echo and closes same-day skip', async t => {
    const { b, opts } = cursorSetup(t);
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(papers.length, 2);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers, []), true);
    for (const prefix of ['arXivRaw', 'arXiv']) {
        const proof = papers._sourceHealth.provider.oai.streams[prefix];
        assert.equal(new URL(proof[0].url).searchParams.get('from'), '2026-10-16');
        assert.equal(parseOaiXml(fs.readFileSync(path.join(opts.evidenceDir, proof[0].file))).request.from, '2026-10-19');
    }
});

test('official next-day skip zero closes on next first date and preserves the complete earlier page', async t => {
    const { b, opts } = cursorSetup(t, { pageDays: ['2026-10-16', '2026-10-19'], skip: 0 });
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.deepEqual(papers.map(p => p.arxivId), ['2610.23539v1', '2610.23540v1']);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
});

for (const [name, config] of [
    ['fabricated echo from', { echoFrom: '2026-10-20' }],
    ['from drift without output token', { noToken: true, echoFrom: '2026-10-19' }],
    ['wrong tail-day skip', { skip: 2 }],
    ['negative skip', { skip: -1 }],
    ['zero skip on displayed same day', { skip: 0 }],
    ['date cursor before original query', { from: '2026-10-15' }],
    ['date cursor behind displayed last day', { from: '2026-10-18' }],
    ['date cursor after response date', { from: '2026-10-21', skip: 0 }],
    ['unclosed jump to a later day', { from: '2026-10-20', skip: 0 }],
    ['next-page date regression', { pageDays: ['2026-10-19', '2026-10-16'] }],
    ['next-day zero skip not closed', { pageDays: ['2026-10-16', '2026-10-20'], skip: 0 }],
    ['invalid calendar day', { from: '2026-02-30', skip: 0 }]
]) test(`official cursor rejects ${name}`, async t => {
    const { b, opts } = cursorSetup(t, config);
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), e => e.code === 'SOURCE_FETCH_FAILED' && !e.sourceHealth.coverageComplete);
});

for (const [name, change] of [
    ['duplicate from field', entries => [...entries, ['from', '2026-10-19']]],
    ['extra field', entries => [...entries, ['until', '2026-10-20']]],
    ['wrong verb', entries => entries.map(([k,v]) => [k, k === 'verb' ? 'ListIdentifiers' : v])],
    ['wrong prefix', entries => entries.map(([k,v]) => [k, k === 'metadataPrefix' ? 'arXivOld' : v])],
    ['wrong set', entries => entries.map(([k,v]) => [k, k === 'set' ? 'cs:cs:LG' : v])],
    ['noncanonical skip', entries => entries.map(([k,v]) => [k, k === 'skip' ? '01' : v])],
    ['missing skip', entries => entries.filter(([k]) => k !== 'skip')]
]) test(`official cursor rejects ${name} without opaque-token fallback`, async t => {
    const { b, opts } = cursorSetup(t, { transform: (r, ctx) => {
        if (ctx.index) return r;
        const entries = [...new URLSearchParams(decodeURIComponent(ctx.out))];
        return { ...r, data: r.data.replace(ctx.out, dateToken(ctx.prefix, '', 0, change(entries))) };
    } });
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /cursor/);
});

test('official tokens reject damaged encoding, downgraded output and changed continuation request echo', async t => {
    for (const kind of ['damaged', 'single-encoded', 'downgrade', 'echo']) {
        const { b, opts } = cursorSetup(t, { transform: (r, ctx) => {
            if (!ctx.index && kind === 'damaged') return { ...r, data: r.data.replace(ctx.out, ctx.out.replace('%3D', '%3G')) };
            if (!ctx.index && kind === 'single-encoded') return { ...r, data: r.data.replace(ctx.out, decodeURIComponent(ctx.out).replaceAll('&', '&amp;')) };
            if (ctx.index && kind === 'downgrade') return { ...r, data: r.data.replace('<resumptionToken></resumptionToken>', '<resumptionToken>normal-next</resumptionToken>') };
            if (ctx.index && kind === 'echo') return { ...r, data: r.data.replace(`resumptionToken="${ctx.incoming}"`, 'resumptionToken="changed-token"') };
            return r;
        } });
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /cursor|identity/);
    }
});

test('official cursor still rejects cross-format complete-set changes and changed first-page replay', async t => {
    for (const kind of ['set', 'replay']) {
        const { b, opts } = cursorSetup(t, { transform: (r, ctx) => {
            if (kind === 'set' && ctx.prefix === 'arXiv' && ctx.index) return { ...r, data: r.data.replaceAll('2610.23540', '2610.23541') };
            if (kind === 'replay' && ctx.call === 3) return { ...r, data: r.data.replaceAll('2610.23539', '2610.23541') };
            return r;
        } });
        await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /member sets|first page/);
    }
});

test('official cursor response generation may go backward between cached pages but each page remains fresh', async t => {
    const { b, opts } = cursorSetup(t, { transform: (r, ctx) => ({ ...r, data: r.data.replace('2026-10-20T03:00:00Z',
        ctx.index ? '2026-10-20T03:17:41Z' : '2026-10-20T03:42:53Z') }) });
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
});

// Complete original official cs.LG XML pages captured in the 2026-10-20
// read-only preflight, plus the independently captured actual Tuesday RSS.
// No response body/date/request has been rewritten. SHA/size bind every byte.
const REAL_LG_CURSOR_FIXTURE_BYTES = require('node:zlib').gunzipSync(fs.readFileSync(
    path.join(__dirname, 'fixtures/daily-arxiv-lg-cursor-20261020.json.gz')));
assert.equal(crypto.createHash('sha256').update(REAL_LG_CURSOR_FIXTURE_BYTES).digest('hex'),
    '0e0695f446df926896cab5c5d7f6572e219ad451b11833122f6c5bec11817bd1');
const REAL_LG_CURSOR_FIXTURE = JSON.parse(REAL_LG_CURSOR_FIXTURE_BYTES);

function originalFixtureBytes(fixture) {
    const bytes = require('node:zlib').gunzipSync(Buffer.from(fixture.gzip, 'base64'));
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    return bytes;
}
test('complete original 1733-member LG pages and current 817-item RSS pass real byte-backed cold replay', async t => {
    const fixture = REAL_LG_CURSOR_FIXTURE, b = fixture.boundary;
    const opts = setup(t, b), directory = path.dirname(opts.evidenceDir);
    const rssBytes = originalFixtureBytes(fixture.rss);
    const rssPath = path.join(directory, `rss-cs.LG-${fixture.rss.sha256}.xml`);
    fs.writeFileSync(rssPath, rssBytes, { mode: 0o600, flag: 'wx' });
    opts.announcementEvidence = { ...fixture.announcement, filePath: rssPath };
    opts.triggerFailure = fixture.triggerFailure;
    const pages = Object.fromEntries(Object.entries(fixture.pages).map(([prefix, list]) => [prefix, list.map(originalFixtureBytes)]));
    opts.requestFn = async url => {
        opts.calls.push(url);
        const params = new URL(url).searchParams, token = params.get('resumptionToken') || '';
        const query = token ? new URLSearchParams(decodeURIComponent(token)) : params;
        const prefix = query.get('metadataPrefix');
        if (!token) {
            assert.equal(params.get('from'), '2026-10-16');
            assert.equal(params.get('set'), 'cs:cs:LG');
        } else {
            assert.equal(query.get('from'), '2026-10-20');
            assert.equal(query.get('skip'), '430');
        }
        return { status: 200, data: pages[prefix][token ? 1 : 0] };
    };
    opts.requestScheduler = { run: async (host, action, options) => {
        assert.equal(host, 'oaipmh.arxiv.org'); assert.equal(options.minimumCooldownMs, 5000); return action();
    } };
    const papers = await fetchDailyOaiCategory('cs.LG', b, [], opts);
    const health = papers._sourceHealth;
    assert.equal(opts.calls.length, 6);
    assert.equal(hasVerifiedOaiCoverage(health, b, 'cs.LG', papers, []), true);
    for (const prefix of ['arXivRaw', 'arXiv']) {
        const records = pages[prefix].flatMap(bytes => parseOaiXml(bytes).records);
        assert.equal(records.length, 1733);
        assert.equal(new Set(records.map(r => r.id)).size, 1733);
        assert.deepEqual(records.reduce((counts, r) => {
            counts[r.datestamp] = (counts[r.datestamp] || 0) + 1; return counts;
        }, {}), { '2026-10-16': 472, '2026-10-19': 398, '2026-10-20': 863 });
    }
    assert.equal(parseOaiXml(pages.arXiv[0]).responseDate, '2026-10-20T03:42:53Z');
    assert.equal(parseOaiXml(pages.arXiv[1]).responseDate, '2026-10-20T03:17:41Z');
    assert.equal(health.provider.oai.witnessEncounter.arxivId, '2610.23847');
    assert.ok(papers.some(p => p.arxivId.startsWith('2610.23847v')));
    assert.equal(require('../scripts/lib/daily-arxiv-announcement-source').replayDailyAnnouncement(
        opts.announcementEvidence, b, 'cs.LG').ids.length, 817);
    const moved = structuredClone(health);
    moved.provider.oai.streams.arXivRaw[0].url = moved.provider.oai.streams.arXivRaw[0].url.replace('from=2026-10-16', 'from=2026-10-20');
    assert.equal(hasVerifiedOaiCoverage(moved, b, 'cs.LG', papers, []), false);
    const changed = structuredClone(papers);
    changed[0].abstract += ' Unrelated fabricated result.';
    assert.equal(hasVerifiedOaiCoverage(health, b, 'cs.LG', changed, []), false);
});

test('official same-day branch retains an earlier original from and advances the real query skip', async t => {
    const { b, opts } = cursorSetup(t, { from: '2026-10-16', echoFrom: '2026-10-16', skip: 1 });
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
});

test('official same-day continuation skip is cumulative across all displayed records in the active range', async t => {
    const b = boundary(), rows = ['2610.23539', '2610.23540', '2610.23541'];
    const opts = setup(t, b, undefined, rows);
    opts.requestFn = async url => {
        opts.calls.push(url);
        const params = new URL(url).searchParams, incoming = params.get('resumptionToken') || '';
        const q = incoming ? new URLSearchParams(decodeURIComponent(incoming)) : params;
        const prefix = q.get('metadataPrefix'), index = incoming ? Number(q.get('skip')) : 0;
        const out = index < 2 ? dateToken(prefix, '2026-10-16', index + 1) : '';
        return { status: 200, data: envelope(prefix, [record(prefix, rows[index])], out, incoming) };
    };
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(papers.length, 3);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
});

test('opaque padded base64 tokens keep their original protocol path', async t => {
    const b = boundary(), rows = ['2610.23539', '2610.23540'], opts = setup(t, b, undefined, rows);
    opts.requestFn = async url => {
        opts.calls.push(url);
        const params = new URL(url).searchParams, incoming = params.get('resumptionToken') || '';
        const marker = incoming ? Buffer.from(incoming, 'base64').toString('utf8') : '';
        const prefix = params.get('metadataPrefix') || (marker === 'raw-next' ? 'arXivRaw' : 'arXiv');
        const output = incoming ? '' : Buffer.from(prefix === 'arXivRaw' ? 'raw-next' : 'normal-next').toString('base64');
        return { status: 200, data: envelope(prefix, [record(prefix, rows[incoming ? 1 : 0])], output, incoming) };
    };
    const papers = await fetchDailyOaiCategory('eess.AS', b, [], opts);
    assert.equal(hasVerifiedOaiCoverage(papers._sourceHealth, b, 'eess.AS', papers), true);
});

test('official record dates cannot regress inside a page', async t => {
    const { b, opts } = cursorSetup(t, { transform: (r, ctx) => !ctx.index ? {
        ...r, data: r.data.replace('</ListRecords>', record(ctx.prefix, '2610.23542').replace(
            '<datestamp>2026-10-19</datestamp>', '<datestamp>2026-10-16</datestamp>') + '</ListRecords>')
    } : r });
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /dates regress/);
});

test('percent-encoded official query keys cannot disguise a noncanonical cursor as opaque', async t => {
    const { b, opts } = cursorSetup(t, { echoFrom: '2026-10-16', transform: (r, ctx) => {
        if (ctx.index) return r;
        const encodedKeys = ctx.out.replace('verb', '%76erb').replace('metadataPrefix', '%6DetadataPrefix')
            .replace('from', '%66rom').replace('set', '%73et').replace('skip', '%73kip');
        return { ...r, data: r.data.replace(ctx.out, encodedKeys) };
    } });
    await assert.rejects(fetchDailyOaiCategory('eess.AS', b, [], opts), /fields\/encoding/);
});
