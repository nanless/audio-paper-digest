'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const batch = require('../scripts/lib/historical-conference-crawl-batch.js');
const cli = require('../scripts/historical-conference-crawl-batch.js');

const options = { crosswalkRoot: '/tmp/crosswalk', identityRoot: '/tmp/identity', dataRoot: '/tmp/data', batchRoot: '/tmp/batch',
    blogRoot: '/tmp/blog', iclrAcceptedRoot: '/tmp/iclr', crosswalkId: '11111111-1111-4111-8111-111111111111', owner: 'worker' };

test('retained conference crawl batch fails before reading metadata, titles, or crosswalk state', async () => {
    let read = 0;
    await assert.rejects(batch.runConferenceCrawlBatch(options, { readCrosswalk: () => { read++; throw new Error('must not read'); } }), /retired/);
    assert.equal(read, 0);
});

test('legacy conference command wrapper is a loud fail-closed compatibility endpoint', async () => {
    assert.throws(() => cli.parseArgs(['--dry-run']), /retired/);
    await assert.rejects(cli.main(['--apply']), /retired/);
});

test('explicit non-title groups remain a pure helper and are not an execution route', () => {
    const pageKey = `page:${'a'.repeat(64)}`;
    const state = { source: { papers: [{ pageKey, identityHints: { status: 'single', candidates: [
        { scheme: 'openreview-forum-id', value: 'AbCdef_12', sources: ['body:openreview-link'] }] } }] },
    assignments: { [pageKey]: { status: 'pending' } } };
    const matches = new Map([['openreview-forum-id:AbCdef_12', [{ conference: { slug: 'icml', year: 2026 },
        externalId: { scheme: 'openreview-forum-id', value: 'AbCdef_12' } }]]]);
    assert.equal(batch.explicitHintGroups(state, matches).length, 1);
});
