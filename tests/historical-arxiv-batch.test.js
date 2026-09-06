'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const batch = require('../scripts/lib/historical-arxiv-batch.js');
const cli = require('../scripts/historical-arxiv-batch.js');

const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const key = character => `page:${character.repeat(64)}`;

function state() {
    const papers = [
        { pageKey: key('a'), identityHints: { status: 'single', candidates: [
            { scheme: 'arxiv', value: '2601.00001', sources: ['filename'] }] } },
        { pageKey: key('b'), identityHints: { status: 'single', candidates: [
            { scheme: 'arxiv', value: '2601.00001', sources: ['frontmatter:paper_digest_arxiv_id'] }] } },
        { pageKey: key('c'), identityHints: { status: 'single', candidates: [
            { scheme: 'arxiv', value: '2601.00002', sources: ['body:arxiv-link'] }] } },
        { pageKey: key('d'), identityHints: { status: 'conflict', candidates: [
            { scheme: 'arxiv', value: '2601.00003', sources: ['filename'] },
            { scheme: 'arxiv', value: '2601.00004', sources: ['frontmatter:paper_digest_arxiv_id'] }] } }
    ];
    return { source: { papers }, assignments: Object.fromEntries(papers.map(paper => [paper.pageKey,
        { status: 'pending', sourceAuthority: null }])), completion: { verified: 0, total: papers.length } };
}

function mockedDependencies(current, { failId = null } = {}) {
    const calls = { authority: [], decisions: [], records: [] }; let uuidIndex = 0;
    return { calls,
        deps: {
            readCrosswalk: () => structuredClone(current),
            prepareAuthority: async options => {
                calls.authority.push(options.arxivId);
                if (options.arxivId === failId) throw new Error('injected source failure');
                return { authorityHandle: { id: options.arxivId } };
            },
            buildDecision: options => ({ pageKey: options.pageKey, authorityHandle: options.authorityHandle }),
            writeDecision: options => { calls.decisions.push(options); return `/tmp/${options.decisionName}`; },
            loadDecision: (_filename, options) => ({ authorityHandle: options.authorityHandle,
                pageKey: calls.decisions.at(-1).artifact.pageKey }),
            applyDecision: options => {
                current.assignments[options.decisionHandle.pageKey].status = 'verified';
                current.assignments[options.decisionHandle.pageKey].sourceAuthority = {
                    paperId: `arxiv:${options.decisionHandle.authorityHandle.id}`,
                    authorityName: `arxiv-${options.decisionHandle.authorityHandle.id}-history.json`
                };
                current.completion.verified += 1; return structuredClone(current);
            },
            uuid: () => UUIDS[uuidIndex++], now: () => '2026-09-07T00:00:00.000Z',
            writeAttemptRecord: (_root, record) => { calls.records.push(structuredClone(record)); return record; }
        }
    };
}

test('pilot groups duplicate pages under one live authority and rerun continues remaining identities', async () => {
    const current = state(); const mock = mockedDependencies(current);
    const options = { crosswalkRoot: '/tmp/crosswalk', authorityRoot: '/tmp/authority', batchRoot: '/tmp/batch',
        crosswalkId: UUIDS[0], owner: 'batch.worker', apply: true, limit: 'pilot' };
    const pilot = await batch.runSingleHintBatch(options, mock.deps);
    assert.deepEqual(mock.calls.authority, ['2601.00001']);
    assert.equal(mock.calls.decisions.length, 2); assert.equal(pilot.processedPages, 2);
    assert.equal(mock.calls.records[0].status, 'complete');
    const resumed = await batch.runSingleHintBatch({ ...options, limit: null }, mock.deps);
    assert.deepEqual(mock.calls.authority, ['2601.00001', '2601.00002']);
    assert.equal(resumed.remainingEligibleIdentities, 0);
    assert.equal(current.assignments[key('d')].status, 'pending', 'conflict hints stay outside this runner');
});

test('one identity failure is preserved and does not stop later groups', async () => {
    const current = state(); const mock = mockedDependencies(current, { failId: '2601.00001' });
    const result = await batch.runSingleHintBatch({ crosswalkRoot: '/tmp/crosswalk', authorityRoot: '/tmp/authority',
        batchRoot: '/tmp/batch', crosswalkId: UUIDS[0], owner: 'batch.worker', apply: true }, mock.deps);
    assert.equal(result.status, 'partial'); assert.equal(result.failures.length, 1);
    assert.deepEqual(mock.calls.authority, ['2601.00001', '2601.00002']);
    assert.equal(mock.calls.records[0].status, 'failed');
    assert.equal(current.assignments[key('a')].status, 'pending');
    assert.equal(current.assignments[key('c')].status, 'verified');
});

test('dry-run is zero mutation and attempt records are append-only mode 0600', async t => {
    const current = state(); const mock = mockedDependencies(current);
    const result = await batch.runSingleHintBatch({ crosswalkRoot: '/tmp/crosswalk', authorityRoot: '/tmp/authority',
        batchRoot: '/tmp/batch', crosswalkId: UUIDS[0], owner: 'batch.worker', apply: false, limit: 'pilot' }, mock.deps);
    assert.equal(result.status, 'dry-run'); assert.equal(result.selectedIdentities, 1);
    assert.equal(mock.calls.authority.length, 0); assert.equal(mock.calls.records.length, 0);

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-arxiv-batch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = { crosswalkId: UUIDS[0], attemptId: UUIDS[1], arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001-history.json', status: 'complete',
        startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:01:00.000Z',
        requestedPageKeys: [key('a')], completedPageKeys: [key('a')], remainingPageKeys: [], error: null };
    const written = batch.writeAttemptRecord(root, record);
    assert.equal(fs.statSync(written.filename).mode & 0o777, 0o600);
    assert.throws(() => batch.writeAttemptRecord(root, record), /EEXIST/);
});

test('CLI accepts pilot or numeric limit and routes configured roots', async () => {
    assert.equal(cli.parseArgs(['--apply', '--crosswalk', UUIDS[0], '--owner', 'batch.worker', '--limit', 'pilot']).limit, 'pilot');
    assert.equal(cli.parseArgs(['--dry-run', '--crosswalk', UUIDS[0], '--owner', 'batch.worker', '--limit', '3']).limit, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', UUIDS[0], '--owner', 'batch.worker', '--limit', 'all']), /Use/);
    let received;
    const result = await cli.main(['--dry-run', '--crosswalk', UUIDS[0], '--owner', 'batch.worker'], {
        files: { pageSourceCrosswalkDir: '/tmp/crosswalk', paperSourceAuthorityDir: '/tmp/authority',
            historicalArxivBatchDir: '/tmp/batch' },
        runBatch: async options => { received = options; return { status: 'dry-run', exitCode: 0 }; }
    });
    assert.equal(result.status, 'dry-run'); assert.equal(received.limit, null);
});
