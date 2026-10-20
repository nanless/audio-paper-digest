'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchCategoryPrefix, fetchDailyArxivCategory, hasVerifiedCategoryPrefix, hasEligibleOaiTrigger } = require('../scripts/lib/daily-arxiv-prefix-source');
const boundary = { since: '2026-10-15T12:00:00.000Z', until: '2026-10-19T02:00:00.000Z',
    identitySha256: 'a'.repeat(64), continuity: { required: true, witnesses: { arxiv: [
        { categoryId: 'eess.AS', status: 'expected', arxivId: '2610.00003', published: '2026-10-15T12:00:00Z' }
    ] } } };
function entry(id, published, category = 'eess.AS') {
    return `<entry><id>http://arxiv.org/abs/${id}v1</id><title>Audio ${id}</title><summary>Audio evidence.</summary><author><name>A</name></author><published>${published}</published><category term="${category}"/></entry>`;
}
const records = [entry('2610.00001', '2026-10-19T03:00:00Z'),
    entry('2610.00002', '2026-10-16T12:00:00Z'), entry('2610.00003', '2026-10-15T12:00:00Z'),
    entry('2610.00004', '2026-10-15T12:00:00Z'), entry('2610.00005', '2026-10-15T11:59:59Z')];
function feed(entries, start, total, size = 2) {
    return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${size}</opensearch:itemsPerPage>${entries.join('')}</feed>`;
}
function options(transform, values = records) {
    const calls = [];
    return { calls, pageSize: 2, requestScheduler: { run: async (host, task, opts) => {
        assert.equal(host, 'export.arxiv.org'); assert.equal(opts.minimumCooldownMs, 3000); return task();
    } }, requestFn: async url => {
        calls.push(url); const query = new URL(url).searchParams;
        assert.equal(query.get('search_query'), 'cat:eess.AS');
        assert.equal(query.get('sortBy'), 'submittedDate'); assert.equal(query.get('sortOrder'), 'descending');
        const start = Number(query.get('start'));
        const response = { status: 200, data: feed(values.slice(start, start + 2), start, values.length) };
        return transform ? transform(response, start, calls.length) : response;
    } };
}
test('whole official pages cover exact bounds and timestamp ties; known IDs do not truncate', async () => {
    const opts = options();
    const result = await fetchCategoryPrefix('eess.AS', boundary, new Set(['2610.00002']), opts);
    assert.deepEqual(result.map(p => p.arxivId), ['2610.00003v1', '2610.00004v1']);
    assert.deepEqual(opts.calls.map(u => Number(new URL(u).searchParams.get('start'))), [0, 2, 4, 0]);
    assert.equal(result._sourceHealth.coverageComplete, true);
    assert.equal(result._sourceHealth.provider.continuity.encounterVerified, true);
    assert.equal(result._sourceHealth.provider.categoryPrefix.firstPageReplayed, true);
});
test('crossing lower bound reads the full page but does not fetch the irrelevant remainder', async () => {
    const opts = options(null, [...records, entry('2610.00006', '2026-10-15T11:00:00Z'),
        entry('2610.00007', '2026-10-14T11:00:00Z')]);
    const result = await fetchCategoryPrefix('eess.AS', boundary, null, opts);
    assert.equal(result._sourceHealth.provider.categoryPrefix.completionReason, 'strict-lower-bound-crossed');
    assert.equal(result._sourceHealth.provider.categoryPrefix.observedEntries, 6);
    assert.equal(opts.calls.length, 4);
});
for (const [name, transform] of [
    ['short middle page', (r, start) => start === 2 ? { status: 200, data: feed([records[2]], start, 5) } : r],
    ['changed total', (r, start) => start === 2 ? { status: 200, data: feed(records.slice(2, 4), start, 6) } : r],
    ['wrong offset', (r, start) => start === 2 ? { status: 200, data: feed(records.slice(2, 4), 1, 5) } : r],
    ['duplicate identity', (r, start) => start === 2 ? { status: 200, data: feed([records[1], records[3]], start, 5) } : r],
    ['foreign category', (r, start) => start === 2 ? { status: 200, data: feed([entry('2610.00003', '2026-10-15T12:00:00Z', 'cs.LG'), records[3]], start, 5) } : r],
    ['changed first page on replay', (r, start, call) => call === 4 ? { status: 200, data: feed([entry('2610.00009', '2026-10-19T03:00:00Z'), records[1]], 0, 5) } : r],
    ['later network failure', (r, start) => { if (start === 2) throw new Error('network failed'); return r; }]
]) test(`reject ${name} without granting coverage`, async () => {
    await assert.rejects(fetchCategoryPrefix('eess.AS', boundary, null, options(transform)), e =>
        e.code === 'SOURCE_FETCH_FAILED' && !e.sourceHealth.coverageComplete
            && !e.sourceHealth.provider.window.covered);
});
test('missing or changed real continuity witness cannot certify complete source', async () => {
    const changed = structuredClone(boundary); changed.continuity.witnesses.arxiv[0].published = '2026-10-15T12:00:01Z';
    await assert.rejects(fetchCategoryPrefix('eess.AS', changed, null, options()), /witness publication time changed/);
    changed.continuity.witnesses.arxiv[0].arxivId = '2610.99999';
    await assert.rejects(fetchCategoryPrefix('eess.AS', changed, null, options()), /did not encounter witness/);
});
test('only an actual HTTP429 source failure enables fallback and it preserves original evidence', async () => {
    const original = { failures: [{ error: 'HTTP 429' }], attempts: 5, provider: { boundaryIdentity: boundary.identitySha256 } };
    const state = {};
    const opts = { ...options(), strategyState: state, windowFetch: async () => {
        throw Object.assign(new Error('date query HTTP 429'), { sourceHealth: original });
    } };
    const result = await fetchDailyArxivCategory('eess.AS', boundary, null, opts);
    assert.deepEqual(result._sourceHealth.provider.categoryPrefix.dateQueryFailure.health, original);
    assert.equal(state.categoryPrefix, true);
    opts.windowFetch = async () => { throw new Error('must not repeat failed date query'); };
    await fetchDailyArxivCategory('eess.AS', boundary, null, opts);
    const refused = Object.assign(new Error('source corrupted'), { sourceHealth: { failures: [{ error: 'HTTP 500' }] } });
    await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, null,
        { ...options(), windowFetch: async () => { throw refused; } }), e => e === refused);
});

test('cold prefix proof rejects incomplete pages, changed coverage, replay and missing contract', async () => {
    const result = await fetchCategoryPrefix('eess.AS', boundary, null, options());
    const health = result._sourceHealth;
    health.provider.categoryPrefix.dateQueryFailure = { health: { failures: [{ error: 'HTTP 429' }], provider: { boundaryIdentity: boundary.identitySha256 } } };
    assert.equal(hasVerifiedCategoryPrefix(health, boundary), true);
    assert.equal(hasVerifiedCategoryPrefix({ provider: { window: {} } }, boundary), true);
    for (const change of [
        h => { delete h.provider.categoryPrefix; },
        h => { delete h.provider.categoryPrefix.dateQueryFailure; },
        h => { h.provider.categoryPrefix.pages[1].start = 1; },
        h => { h.provider.categoryPrefix.pages[1].count = 1; },
        h => { h.provider.categoryPrefix.pages[2].last.published = boundary.since; h.provider.categoryPrefix.completionReason = 'strict-lower-bound-crossed'; },
        h => { h.provider.categoryPrefix.pages[1].responseSha256 = ''; },
        h => { h.provider.categoryPrefix.replay.entriesSha256 = 'f'.repeat(64); },
        h => { h.provider.categoryPrefix.observedEntries++; },
        h => { h.provider.categoryPrefix.dateQueryFailure = { health: { failures: [{ error: 'HTTP 500' }] } }; }
    ]) {
        const changed = structuredClone(health); change(changed);
        assert.equal(hasVerifiedCategoryPrefix(changed, boundary), false);
    }
});
test('truly empty category with no old witness retains verifiable exhausted proof', async () => {
    const emptyBoundary = structuredClone(boundary);
    emptyBoundary.continuity.witnesses.arxiv[0] = { categoryId: 'eess.AS', status: 'not-applicable', reason: 'no-previous-records' };
    const result = await fetchCategoryPrefix('eess.AS', emptyBoundary, null, options(null, []));
    assert.equal(result.length, 0);
    assert.equal(hasVerifiedCategoryPrefix(result._sourceHealth, emptyBoundary, 'eess.AS', false), true);
});

test('formal health projection and checkpoint reload retain and enforce prefix evidence', async t => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const pipeline = require('../scripts/full-fetch');
    const validator = require('../scripts/validate-data-files');
    const config = require('../scripts/config');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-prefix-checkpoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bound = { contract: 'daily-fetch-boundary-v1', lastDigestDate: '2026-10-15', since: boundary.since, until: boundary.until };
    bound.identitySha256 = pipeline.stableContentSha256(bound);
    const originalFailure = { failures: [{ error: 'HTTP 429' }], provider: { boundaryIdentity: bound.identitySha256 } };
    const papers = await fetchDailyArxivCategory('eess.AS', bound, null, { ...options(),
        windowFetch: async () => { throw Object.assign(new Error('date query limited'), { sourceHealth: originalFailure }); } });
    const health = pipeline.buildArxivCategoryHealth(config.ARXIV_CATEGORIES.find(c => c.id === 'eess.AS'),
        { papers, fetchHealth: papers._sourceHealth });
    assert.deepEqual(health.provider.categoryPrefix.dateQueryFailure.health, originalFailure);
    assert.equal(hasVerifiedCategoryPrefix(health, bound), true);
    const provider = { boundaryIdentity: bound.identitySha256, window: { since: bound.since, until: bound.until, covered: true } };
    const checkpoint = { ...pipeline.buildCandidateFingerprints(new Set(), new Set(), bound),
        batchId: 'b'.repeat(16), batchDate: '2026-10-19', batchStartedAt: '2026-10-19T10:00:00+08:00',
        historicalDedupIds: [], categoryOrder: config.ARXIV_CATEGORIES.map(c => c.id),
        arxiv: Object.fromEntries(config.ARXIV_CATEGORIES.map(c => [c.id, { status: 'complete',
            papers: c.id === 'eess.AS' ? papers : [],
            health: c.id === 'eess.AS' ? health : { id: c.id, ok: true, provider: structuredClone(provider) } }])),
        huggingface: { status: 'complete', papers: [], health: { ok: true, provider: { ...provider,
            cutoffDate: bound.lastDigestDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } } } };
    const filename = path.join(root, 'fetch-checkpoint.json');
    pipeline.saveFetchCheckpoint(checkpoint, filename);
    const stored = pipeline.loadFetchCheckpoint('2026-10-19', checkpoint.candidateFingerprint, filename);
    assert.ok(stored);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(stored), true);
    assert.deepEqual(validator.validateFetchCheckpointFile(filename), []);
    assert.deepEqual(stored.arxiv['eess.AS'].health.provider.categoryPrefix, health.provider.categoryPrefix);
    assert.equal(pipeline.isReusableArxivCheckpoint(stored.arxiv['eess.AS'], bound, 'eess.AS'), true);
    assert.equal(pipeline.isReusableArxivCheckpoint(stored.arxiv['eess.AS'], bound, 'cs.SD'), false);
    const wrongSlot = structuredClone(stored);
    wrongSlot.arxiv['cs.SD'] = structuredClone(wrongSlot.arxiv['eess.AS']);
    pipeline.saveFetchCheckpoint(wrongSlot, filename);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(wrongSlot), false);
    assert.ok(validator.validateFetchCheckpointFile(filename).some(issue => JSON.stringify(issue).includes('arxiv.cs.SD 未证明完整补更范围')));
    pipeline.saveFetchCheckpoint(stored, filename);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(stored), true);
    assert.deepEqual(validator.validateFetchCheckpointFile(filename), []);
    const originalSha = stored.fetchSourcesSha256;
    stored.arxiv['eess.AS'].health.provider.categoryPrefix.replay.entriesSha256 = 'f'.repeat(64);
    pipeline.saveFetchCheckpoint(stored, filename);
    assert.notEqual(stored.fetchSourcesSha256, originalSha);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(stored), false);
    assert.ok(validator.validateFetchCheckpointFile(filename).some(issue => JSON.stringify(issue).includes('未证明完整补更范围')));
});

test('wrapper rejects mismatched original HTTP429 trigger before promoting strategy state', async () => {
    const state = {};
    await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, null, { ...options(), strategyState: state,
        windowFetch: async () => { throw Object.assign(new Error('date limited'), { sourceHealth: {
            failures: [{ error: 'HTTP 429' }], provider: { boundaryIdentity: 'f'.repeat(64) } } }); }
    }), error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.ok === false);
    assert.equal(state.categoryPrefix, undefined);
});

function oaiTrigger() {
    const provider = { boundaryIdentity: boundary.identitySha256,
        window: { since: boundary.since, until: boundary.until, covered: false } };
    return { id: 'eess.AS', categoryId: 'eess.AS', ok: false, failures: [{ error: 'HTTP 429' }],
        provider: { ...structuredClone(provider),
            window: { ...provider.window, coverageContract: 'daily-arxiv-atom-prefix-coverage-v1' },
            categoryPrefix: { contract: 'daily-arxiv-atom-prefix-coverage-v1', categoryId: 'eess.AS',
                boundaryIdentity: boundary.identitySha256, dateQueryFailure: { health: {
                    categoryId: 'eess.AS', failures: [{ error: 'HTTP 429' }], provider: structuredClone(provider) } } } } };
}

test('official OAI trigger requires both real category-specific HTTP429 failures and the exact old window', () => {
    const trigger = oaiTrigger();
    assert.equal(hasEligibleOaiTrigger(trigger, boundary, 'eess.AS'), true);
    for (const mutate of [
        h => { h.ok = true; },
        h => { h.categoryId = 'cs.SD'; },
        h => { h.provider.window.until = '2026-10-20T00:00:00.000Z'; },
        h => { h.provider.window.coverageContract = 'unknown'; },
        h => { h.failures.push({ error: 'HTTP 500' }); },
        h => { h.failures = [{ error: 'network failed' }]; },
        h => { h.provider.categoryPrefix.dateQueryFailure.health.categoryId = 'cs.SD'; },
        h => { h.provider.categoryPrefix.dateQueryFailure.health.provider.boundaryIdentity = 'f'.repeat(64); },
        h => { h.provider.categoryPrefix.dateQueryFailure.health.failures = [{ error: 'invalid XML' }]; }
    ]) {
        const invalid = structuredClone(trigger); mutate(invalid);
        assert.equal(hasEligibleOaiTrigger(invalid, boundary, 'eess.AS'), false);
    }
});

test('explicit OAI recovery reuses the saved exact failed source instead of repeating failed Atom routes', async t => {
    const source = require('../scripts/lib/daily-arxiv-oai-source');
    const original = source.fetchDailyOaiCategory, trigger = oaiTrigger();
    t.after(() => { source.fetchDailyOaiCategory = original; });
    let calls = 0, directories = 0;
    const expected = [];
    source.fetchDailyOaiCategory = async (category, bound, existing, opts) => {
        calls++;
        assert.equal(category, 'eess.AS'); assert.equal(bound, boundary);
        assert.equal(opts.triggerFailure, trigger); assert.equal(opts.evidenceDir, '/new/private/attempt/eess.AS');
        assert.deepEqual([...existing], ['2610.00003']); return expected;
    };
    const opts = { officialOaiRecovery: true, triggerFailure: trigger,
        createOaiEvidenceDir: () => { directories++; return '/new/private/attempt/eess.AS'; },
        windowFetch: async () => { throw new Error('saved failures must not be re-requested'); } };
    assert.equal(await fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), opts), expected);
    assert.equal(calls, 1); assert.equal(directories, 1);
    await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, new Set(), { ...opts, officialOaiRecovery: false }),
        /saved failures must not be re-requested/);
    assert.equal(calls, 1); assert.equal(directories, 1);
    const unrelated = structuredClone(trigger); unrelated.provider.window.until = '2026-10-20T00:00:00.000Z';
    await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, new Set(), { ...opts, triggerFailure: unrelated }),
        /saved failures must not be re-requested/);
    assert.equal(calls, 1); assert.equal(directories, 1);
});

test('cold route dispatcher rejects missing OAI evidence and unknown coverage contracts', () => {
    for (const provider of [
        { oai: {}, window: {} },
        { window: { coverageContract: 'daily-arxiv-oai-coverage-v1' } },
        { window: { coverageContract: 'unknown-route' } },
        { oai: {}, window: { coverageContract: 'daily-arxiv-atom-prefix-coverage-v1' } }
    ]) assert.equal(hasVerifiedCategoryPrefix({ categoryId: 'eess.AS', provider }, boundary), false);
});

function failedOaiFixture(t) {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-oai-continuation-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const oldDirectory = path.join(root, 'old', 'eess.AS'); fs.mkdirSync(oldDirectory, { recursive: true, mode: 0o700 });
    const previous = { id: 'eess.AS', categoryId: 'eess.AS', ok: false, attempts: 4, successfulRequests: 3,
        failures: [{ error: 'Client network socket disconnected before secure TLS connection was established' }],
        provider: { boundaryIdentity: boundary.identitySha256,
            window: { since: boundary.since, until: boundary.until, covered: false, coverageContract: 'daily-arxiv-oai-coverage-v1' },
            oai: { contract: 'daily-arxiv-oai-coverage-v1', categoryId: 'eess.AS',
                boundaryIdentity: boundary.identitySha256, boundary: structuredClone(boundary),
                existingIds: ['2610.00003'], evidenceDir: oldDirectory, triggerFailure: oaiTrigger(),
                streams: { arXivRaw: [{ file: 'old.xml' }], arXiv: [{ file: 'other.xml' }] },
                replays: { arXivRaw: { file: 'old-replay.xml' } } } } };
    return { fs, path, root, previous };
}

test('explicit continuation archives the complete failed OAI source and starts a new complete harvest without repeating Atom', async t => {
    const { fs, path, root, previous } = failedOaiFixture(t);
    const originalBytes = Buffer.from(JSON.stringify(previous, null, 2) + '\n');
    const source = require('../scripts/lib/daily-arxiv-oai-source'), original = source.fetchDailyOaiCategory;
    t.after(() => { source.fetchDailyOaiCategory = original; });
    const expected = [], newDirectory = path.join(root, 'new', 'eess.AS');
    let calls = 0, atomCalls = 0;
    source.fetchDailyOaiCategory = async (category, bound, existing, opts) => {
        calls++;
        assert.equal(category, 'eess.AS'); assert.equal(bound, boundary);
        assert.deepEqual(opts.triggerFailure, previous.provider.oai.triggerFailure);
        assert.equal(opts.evidenceDir, newDirectory); assert.equal(fs.existsSync(newDirectory), false);
        assert.equal(opts.previousPages, undefined); assert.equal(opts.previousEvidenceDir, undefined);
        assert.deepEqual([...existing], ['2610.00003']);
        fs.mkdirSync(newDirectory, { recursive: true, mode: 0o700 });
        const health = { provider: { oai: { existingIds: ['2610.00003'], evidenceDir: newDirectory } } };
        Object.defineProperty(expected, '_sourceHealth', { value: health }); return expected;
    };
    const result = await fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), {
        officialOaiRecovery: true, triggerFailure: previous, createOaiEvidenceDir: () => newDirectory,
        windowFetch: async () => { atomCalls++; throw new Error('must not repeat Atom'); }
    });
    assert.equal(result, expected); assert.equal(calls, 1); assert.equal(atomCalls, 0);
    const archived = result._sourceHealth.provider.oai.previousFailure;
    assert.deepEqual(fs.readFileSync(archived.filePath), originalBytes);
    assert.equal(archived.bytes, originalBytes.length);
    assert.equal(archived.sha256, require('node:crypto').createHash('sha256').update(originalBytes).digest('hex'));
    assert.equal(fs.statSync(archived.filePath).mode & 0o777, 0o600);
    assert.deepEqual(previous, JSON.parse(originalBytes));
    const anchorPath = path.join(newDirectory, 'previous-oai-failure.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(anchorPath)).previousFailure, archived);
    assert.equal(fs.existsSync(path.join(previous.provider.oai.evidenceDir, 'previous-oai-failure.json')), false);
    const originalVerifier = source.hasVerifiedOaiCoverage;
    t.after(() => { source.hasVerifiedOaiCoverage = originalVerifier; });
    source.hasVerifiedOaiCoverage = () => true; // Isolate the wrapper's physical history guard from the XML verifier.
    assert.equal(hasVerifiedCategoryPrefix(result._sourceHealth, boundary, 'eess.AS'), true);
    delete result._sourceHealth.provider.oai.previousFailure;
    assert.equal(hasVerifiedCategoryPrefix(result._sourceHealth, boundary, 'eess.AS'), false);
    result._sourceHealth.provider.oai.previousFailure = archived;
    fs.appendFileSync(anchorPath, ' ');
    assert.equal(hasVerifiedCategoryPrefix(result._sourceHealth, boundary, 'eess.AS'), false);
});

test('failed OAI continuation refuses identity drift before dispatch and never falls back to Atom', async t => {
    const { fs, root, previous } = failedOaiFixture(t);
    const source = require('../scripts/lib/daily-arxiv-oai-source'), original = source.fetchDailyOaiCategory;
    t.after(() => { source.fetchDailyOaiCategory = original; });
    let calls = 0, atomCalls = 0, directories = 0;
    source.fetchDailyOaiCategory = async () => { calls++; throw new Error('must not dispatch'); };
    for (const mutate of [
        h => { h.ok = true; },
        h => { h.categoryId = 'cs.SD'; },
        h => { h.id = 'cs.SD'; },
        h => { h.provider.window.covered = true; },
        h => { h.provider.window.until = '2026-10-20T00:00:00.000Z'; },
        h => { h.provider.oai.boundary.since = '2026-10-14T00:00:00.000Z'; },
        h => { h.provider.oai.categoryId = 'cs.SD'; },
        h => { h.provider.oai.existingIds.push('2610.99999'); },
        h => { h.provider.oai.triggerFailure.failures[0].error = 'HTTP 500'; },
        h => { h.provider.oai.triggerFailure.provider.categoryPrefix.dateQueryFailure.health.categoryId = 'cs.SD'; },
        h => { h.provider.oai.contract = 'unknown'; }
    ]) {
        const invalid = structuredClone(previous); mutate(invalid);
        await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), {
            officialOaiRecovery: true, triggerFailure: invalid,
            createOaiEvidenceDir: () => { directories++; return root + '/new'; },
            windowFetch: async () => { atomCalls++; throw new Error('must not fall back'); }
        }), /失败延续被拒绝/);
    }
    assert.equal(calls, 0); assert.equal(atomCalls, 0); assert.equal(directories, 0);
    assert.deepEqual(fs.readdirSync(previous.provider.oai.evidenceDir), []);
});

test('new OAI failure retains immutable previous failure and changed archives block later requests', async t => {
    const { fs, path, root, previous } = failedOaiFixture(t);
    const source = require('../scripts/lib/daily-arxiv-oai-source'), original = source.fetchDailyOaiCategory;
    t.after(() => { source.fetchDailyOaiCategory = original; });
    let calls = 0;
    source.fetchDailyOaiCategory = async (_category, _boundary, _ids, opts) => {
        calls++;
        fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
        const failed = structuredClone(previous);
        failed.provider.oai.evidenceDir = opts.evidenceDir;
        failed.provider.oai.streams = { arXivRaw: [], arXiv: [] }; failed.provider.oai.replays = {};
        throw Object.assign(new Error('new transport failure'), { sourceHealth: failed });
    };
    let failure;
    try { await fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), {
        officialOaiRecovery: true, triggerFailure: previous, createOaiEvidenceDir: () => path.join(root, 'new', 'eess.AS')
    }); } catch (error) { failure = error; }
    assert.match(failure.message, /new transport failure/);
    const descriptor = failure.sourceHealth.provider.oai.previousFailure;
    assert.ok(descriptor); assert.deepEqual(JSON.parse(fs.readFileSync(descriptor.filePath)), previous);
    fs.appendFileSync(descriptor.filePath, ' ');
    await assert.rejects(fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), {
        officialOaiRecovery: true, triggerFailure: failure.sourceHealth,
        createOaiEvidenceDir: () => { throw new Error('archive corruption must stop before a new directory'); },
        windowFetch: async () => { throw new Error('archive corruption must not fall back to Atom'); }
    }), /失败延续被拒绝/);
    assert.equal(calls, 1);
    assert.equal(hasVerifiedCategoryPrefix(failure.sourceHealth, boundary), false);
});

test('pre-health and directory-factory errors preserve the actual old failure and snapshot without fabricating a harvest', async t => {
    const { fs, path, root, previous } = failedOaiFixture(t);
    const source = require('../scripts/lib/daily-arxiv-oai-source'), original = source.fetchDailyOaiCategory;
    t.after(() => { source.fetchDailyOaiCategory = original; });
    let calls = 0;
    source.fetchDailyOaiCategory = async () => { calls++; throw Object.assign(new Error('pre-health proxy/config failure'), { code: 'CONFIG_FAILURE' }); };
    let current = previous;
    for (const beforeSource of [true, false]) {
        let failure;
        try { await fetchDailyArxivCategory('eess.AS', boundary, new Set(['2610.00003']), {
            officialOaiRecovery: true, triggerFailure: current,
            createOaiEvidenceDir: () => {
                if (beforeSource) throw Object.assign(new Error('directory factory failed'), { code: 'DIRECTORY_FAILURE' });
                return path.join(root, 'new-pre-health', 'eess.AS');
            }, windowFetch: async () => { throw new Error('must not repeat Atom'); }
        }); } catch (error) { failure = error; }
        assert.match(failure.message, beforeSource ? /directory factory failed/ : /pre-health proxy\/config failure/);
        assert.equal(failure.sourceHealth.ok, false);
        assert.equal(failure.sourceHealth.attempts, previous.attempts);
        assert.equal(failure.sourceHealth.successfulRequests, previous.successfulRequests);
        assert.equal(failure.sourceHealth.provider.oai.evidenceDir, previous.provider.oai.evidenceDir);
        assert.equal(failure.sourceHealth.provider.window.covered, false);
        const archived = failure.sourceHealth.provider.oai.continuationDispatchFailure.failedSourceSnapshot;
        assert.deepEqual(JSON.parse(fs.readFileSync(archived.filePath)), current);
        assert.equal(fs.existsSync(path.join(previous.provider.oai.evidenceDir, 'previous-oai-failure.json')), false);
        assert.equal(failure.sourceHealth.provider.oai.continuationDispatchFailure.error, failure.message);
        current = failure.sourceHealth;
    }
    assert.equal(calls, 1);
});

test('a normally anchored OAI failure survives a later pre-health failure and then resumes without rewriting the old anchor', async t => {
    const { fs, path, root, previous } = failedOaiFixture(t);
    const source = require('../scripts/lib/daily-arxiv-oai-source'), original = source.fetchDailyOaiCategory;
    t.after(() => { source.fetchDailyOaiCategory = original; });
    let round = 0;
    source.fetchDailyOaiCategory = async (_category, _boundary, _ids, opts) => {
        fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
        if (round === 0) {
            const failed = structuredClone(previous); failed.provider.oai.evidenceDir = opts.evidenceDir;
            throw Object.assign(new Error('actual continued OAI transport failure'), { sourceHealth: failed });
        }
        const papers = [];
        Object.defineProperty(papers, '_sourceHealth', { value: { provider: { oai: {
            evidenceDir: opts.evidenceDir, existingIds: ['2610.00003'] } } } });
        return papers;
    };
    const base = { officialOaiRecovery: true, windowFetch: async () => { throw new Error('must not repeat Atom'); } };
    let anchored;
    try { await fetchDailyArxivCategory('eess.AS', boundary, ['2610.00003'], {
        ...base, triggerFailure: previous, createOaiEvidenceDir: () => path.join(root, 'anchored', 'eess.AS')
    }); } catch (error) { anchored = error.sourceHealth; }
    assert.ok(anchored.provider.oai.previousFailure);
    const oldAnchor = path.join(anchored.provider.oai.evidenceDir, 'previous-oai-failure.json');
    const anchorBytes = fs.readFileSync(oldAnchor);
    let retained;
    try { await fetchDailyArxivCategory('eess.AS', boundary, ['2610.00003'], {
        ...base, triggerFailure: anchored, createOaiEvidenceDir: () => { throw new Error('later factory failure'); }
    }); } catch (error) { retained = error.sourceHealth; }
    assert.deepEqual(retained.provider.oai.previousFailure, anchored.provider.oai.previousFailure);
    assert.deepEqual(fs.readFileSync(oldAnchor), anchorBytes);
    const intermediate = retained.provider.oai.continuationDispatchFailure.failedSourceSnapshot;
    assert.deepEqual(JSON.parse(fs.readFileSync(intermediate.filePath)), anchored);
    round = 1;
    const result = await fetchDailyArxivCategory('eess.AS', boundary, ['2610.00003'], {
        ...base, triggerFailure: retained, createOaiEvidenceDir: () => path.join(root, 'final', 'eess.AS')
    });
    assert.deepEqual(fs.readFileSync(oldAnchor), anchorBytes);
    const newest = result._sourceHealth.provider.oai.previousFailure;
    assert.deepEqual(JSON.parse(fs.readFileSync(newest.filePath)), retained);
    assert.notEqual(newest.filePath, intermediate.filePath);
});
