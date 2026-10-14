'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fetchHuggingFacePapers } = require('../scripts/fetch-huggingface-papers');
const { validateDailyFetchBoundary, validateDailyFetchContinuityCheckpoint,
    hasVerifiedFetchContinuity } = require('../scripts/lib/daily-fetch-boundary');
const Config = require('../scripts/config');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const WITNESS_ID = '2610.09000', WITNESS_AT = '2026-10-09T20:00:00.000Z';
function boundaryFixture(reason = null) {
    const originalSince = '2026-10-11T14:00:00.000Z';
    const checkpoint = { sourceContractVersion: 7, batchDate: '2026-10-11', fetchBoundary: { until: originalSince },
        arxiv: Object.fromEntries(Config.ARXIV_CATEGORIES.map(({ id }) => [id, { papers: [] }])),
        huggingface: { papers: reason === 'no-previous-records' ? []
            : [{ arxivId: WITNESS_ID, ...(reason ? {} : { hfSelectedAt: WITNESS_AT }) }] } };
    const checkpointBytes = Buffer.from(JSON.stringify(checkpoint));
    const checkpointSha = hash(checkpointBytes);
    const hf = reason ? { status: 'not-applicable', reason }
        : { status: 'expected', arxivId: WITNESS_ID, selectedAt: WITNESS_AT, cutoffDate: '2026-10-10' };
    const cutoffDate = reason ? '2026-10-11' : hf.cutoffDate;
    const body = { contract: 'daily-fetch-boundary-v1', lastDigestDate: '2026-10-11',
        since: reason ? originalSince : '2026-10-09T16:00:00.000Z', until: '2026-10-15T06:00:00.000Z',
        provenance: { archiveProofs: ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json',
            'deep-analysis-result.json', 'blog-generation-manifest-2026-10-11.json'].map(file => ({ file,
            sha256: file === 'fetch-checkpoint.json' ? checkpointSha : hash(Buffer.from(file)) })) },
        continuity: { contract: 'daily-fetch-continuity-v1', required: true, originalSince,
            archiveCheckpointSha256: checkpointSha,
            witnesses: { arxiv: Config.ARXIV_CATEGORIES.map(({ id }) => ({ categoryId: id,
                status: 'not-applicable', reason: 'no-previous-records' })), huggingface: hf }, overlapCutoffDate: cutoffDate } };
    const boundary = { ...body, identitySha256: hash(JSON.stringify(stable(body))) };
    assert.equal(validateDailyFetchBoundary(boundary), true);
    assert.equal(validateDailyFetchContinuityCheckpoint(boundary, checkpointBytes), true);
    return boundary;
}
function dailyRow(id, selectedAt) {
    return { publishedAt: '2020-01-01T00:00:00Z', paper: { id, title: 'Speech research', summary: 'Real audio metadata.',
        publishedAt: '2020-01-01T00:00:00Z', submittedOnDailyAt: selectedAt, authors: [] } };
}
const options = (boundary, fetchFn) => ({ boundary, cutoffDate: boundary.continuity.overlapCutoffDate,
    requirePreviouslyFetched: true, minUpvotes: 0, sleepFn: async () => {}, fetchFn });

test('HF controlled overlap preserves last published date, exceeds twenty pages, and traverses whole witness page', async () => {
    const boundary = boundaryFixture(), before = JSON.stringify(boundary), urls = [];
    const afterWitness = '2610.09999';
    const result = await fetchHuggingFacePapers(new Set(['2610.10000']), options(boundary, url => {
        urls.push(url); const query = new URL(url);
        if (!url.includes('daily_papers')) return [];
        assert.equal(query.searchParams.get('sort'), 'publishedAt');
        const page = Number(query.searchParams.get('p'));
        if (page < 21) return Array.from({ length: 100 }, (_, index) =>
            dailyRow(`2610.${String(10000 + page * 100 + index)}`, '2026-10-15T00:00:00Z'));
        return [dailyRow(`${WITNESS_ID}v2`, '2026-10-10T04:00:00+08:00'),
            dailyRow(afterWitness, '2026-10-09T19:00:00Z'), dailyRow('2610.08000', '2026-10-08T00:00:00Z')];
    }));
    assert.equal(JSON.stringify(boundary), before);
    assert.equal(boundary.lastDigestDate, '2026-10-11');
    assert.equal(result._sourceHealth.provider.cutoffDate, '2026-10-10');
    assert.equal(urls.filter(url => url.includes('daily_papers')).length, 22);
    assert.ok(result.some(paper => paper.arxivId === `${WITNESS_ID}v2`), 'previously fetched unpublished witness remains a candidate');
    assert.ok(result.some(paper => paper.arxivId === afterWitness), 'same cutoff day after first known ID is retained');
    assert.ok(!result.some(paper => paper.arxivId === '2610.10000'), 'only published ID is excluded');
    const health = result._sourceHealth;
    assert.equal(health.ok, true); assert.equal(hasVerifiedFetchContinuity(health, boundary, true), true);
    assert.deepEqual(health.provider.continuity, { required: true, status: 'verified', expectedId: WITNESS_ID,
        witnessSelectedAt: WITNESS_AT, matchedIds: [WITNESS_ID], encounterVerified: true });
    assert.deepEqual(health.continuity.encounters, [{ arxivId: WITNESS_ID, selectedAt: '2026-10-10T04:00:00+08:00' }]);
});

test('no matching daily witness, including supplement-only match, cannot claim continuity', async () => {
    const boundary = boundaryFixture();
    for (const rows of [[], [dailyRow('2610.07000', '2026-10-08T00:00:00Z')]]) {
        await assert.rejects(fetchHuggingFacePapers(new Set(), options(boundary, url => url.includes('daily_papers') ? rows
            : [{ id: WITNESS_ID, title: 'Speech research', summary: 'Audio metadata.', authors: [], publishedAt: WITNESS_AT }])),
        error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.ok === false
            && error.sourceHealth.provider.window.covered === false
            && error.sourceHealth.provider.continuity.encounterVerified === false
            && error.sourceHealth.continuity.encounters.length === 0);
    }
});

test('witness selection timestamp drift and original-publication ordering fail closed', async () => {
    const boundary = boundaryFixture();
    for (const rows of [
        [dailyRow(WITNESS_ID, '2026-10-09T21:00:00Z')],
        [dailyRow(WITNESS_ID, '2026-10-10T20:00:00Z')],
        [dailyRow('2610.10001', '2026-10-14T00:00:00Z'), dailyRow('2610.10002', '2026-10-14T01:00:00Z')]
    ]) await assert.rejects(fetchHuggingFacePapers(new Set(), options(boundary, url => url.includes('daily_papers') ? rows : [])),
        error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.provider.window.covered === false
            && error.sourceHealth.provider.continuity.encounterVerified === false);
});

test('malformed remainder after matched witness still rejects the whole source', async () => {
    const boundary = boundaryFixture();
    await assert.rejects(fetchHuggingFacePapers(new Set(), options(boundary, url => url.includes('daily_papers')
        ? [dailyRow(WITNESS_ID, WITNESS_AT), dailyRow('invalid-id', '2026-10-09T19:00:00Z')] : [])),
        error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.ok === false
            && error.sourceHealth.provider.continuity.encounterVerified === true
            && error.sourceHealth.failures.some(failure => /非法论文条目/.test(failure.error)));
});

test('empty previous HF/daily selection is explicitly not applicable and never forged as a match', async () => {
    for (const reason of ['no-previous-records', 'no-previous-daily-selection']) {
        const boundary = boundaryFixture(reason);
        const result = await fetchHuggingFacePapers(new Set(), options(boundary, () => []));
        assert.equal(hasVerifiedFetchContinuity(result._sourceHealth, boundary, true), true);
        assert.deepEqual(result._sourceHealth.provider.continuity, { required: true, status: 'not-applicable',
            reason, matchedIds: [], encounterVerified: false });
        assert.deepEqual(result._sourceHealth.continuity.encounters, []);
    }
});

test('unbound required mode or wrong overlap cutoff stops before any request', async () => {
    const boundary = boundaryFixture(); let requests = 0;
    const fetchFn = () => { requests++; return []; };
    await assert.rejects(fetchHuggingFacePapers(new Set(), { requirePreviouslyFetched: true, fetchFn }), /见证/);
    await assert.rejects(fetchHuggingFacePapers(new Set(), { requirePreviouslyFetched: 'true', fetchFn }), /布尔/);
    await assert.rejects(fetchHuggingFacePapers(new Set(), { ...options(boundary, fetchFn), cutoffDate: boundary.lastDigestDate }), /完整抓取范围/);
    await assert.rejects(fetchHuggingFacePapers(new Set(), { ...options(boundary, fetchFn), overlapCutoffDate: '2026-10-08' }), /完整抓取范围/);
    assert.equal(requests, 0);
});
