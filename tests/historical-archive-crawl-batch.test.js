'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const batch = require('../scripts/lib/historical-archive-crawl-batch.js');
const cli = require('../scripts/historical-archive-crawl-batch.js');
const localCli = require('../scripts/historical-local-crawl-batch.js');

const options = { crosswalkRoot: '/tmp/crosswalk', identityRoot: '/tmp/identity', snapshotRoot: '/tmp/snapshots',
    dataRoot: '/tmp/data', batchRoot: '/tmp/batch', crosswalkId: '11111111-1111-4111-8111-111111111111', owner: 'worker' };

test('retained local crawler batch fails before opening data or crosswalk state', async () => {
    let read = 0;
    await assert.rejects(batch.runLocalCrawlBatch(options, { readCrosswalk: () => { read++; throw new Error('must not read'); } }), /retired/);
    assert.equal(read, 0);
});

test('legacy archive/local command wrappers are loud fail-closed compatibility endpoints', async () => {
    assert.throws(() => cli.parseArgs(['--dry-run']), /retired/);
    await assert.rejects(cli.main(['--dry-run']), /retired/);
    assert.throws(() => localCli.parseArgs(['--apply']), /retired/);
    await assert.rejects(localCli.main(['--apply']), /retired/);
});

test('read-only retained-source preference helper remains deterministic for audit tooling', () => {
    const matches = [{ sourceRelativePath: 'archive/2026-02-03/filtered-papers.json', sourceKind: 'archive' },
        { sourceRelativePath: 'current/papers.json', sourceKind: 'current' }];
    assert.equal(batch.selectMatch(matches, '2026-02-03').sourceRelativePath, 'archive/2026-02-03/filtered-papers.json');
});
