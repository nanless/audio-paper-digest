'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scheduler = require('../scripts/lib/historical-arxiv-analysis-scheduler.js');
const cli = require('../scripts/historical-arxiv-analysis-scheduler.js');

const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const ref = (id, name) => ({ paperId: `arxiv:${id}`, authorityName: name, authorityFileSha256: id.replace('.', '').padEnd(64, 'a').slice(0, 64) });
function state() {
    const pages = [
        { pageKey: `page:${'1'.repeat(64)}`, cohortDate: '2026-04-21' },
        { pageKey: `page:${'2'.repeat(64)}`, cohortDate: '2026-04-19' },
        { pageKey: `page:${'3'.repeat(64)}`, cohortDate: '2026-09-04' }
    ];
    const assignments = {
        [pages[0].pageKey]: { sourceAuthority: ref('2604.12527', 'arxiv-2604.12527-history.json') },
        [pages[1].pageKey]: { sourceAuthority: ref('2604.12527', 'arxiv-2604.12527-history.json') },
        [pages[2].pageKey]: { sourceAuthority: ref('2609.03622', 'arxiv-2609.03622-history.json') }
    };
    return { crosswalkId: CROSSWALK, stateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        source: { papers: pages }, assignments, identityGroups: [
            { paperId: 'arxiv:2604.12527', groupSha256: 'c'.repeat(64), pageKeys: [pages[0].pageKey, pages[1].pageKey] },
            { paperId: 'arxiv:2609.03622', groupSha256: 'd'.repeat(64), pageKeys: [pages[2].pageKey] }
        ] };
}
function fixture(t) { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-scheduler-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('verified duplicate pages collapse to one deterministic analysis identity and earliest cohort date', () => {
    const groups = scheduler.groupsFromCrosswalk(state());
    assert.equal(groups.length, 2); assert.equal(groups[0].pageKeys.length, 2);
    assert.deepEqual(groups[0].cohortDates, ['2026-04-19', '2026-04-21']);
    assert.equal(groups[0].analysisDate, '2026-04-19');
    assert.equal(groups[0].runId, scheduler.deterministicRunId(CROSSWALK, groups[0].paperId));
    assert.match(groups[0].runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('pilot then full rerun skips complete identity and resumes the remaining unique identity', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const runs = new Map(); const calls = { metadata: 0, authority: 0, prepare: 0, analyze: 0 };
    const deps = { files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => runs.get(runId) || null,
        runStatus: ({ runId }) => ({ analysisRemainingIds: runs.get(runId)?.status === 'complete' ? [] : ['pending'] }),
        fetchMetadata: async id => { calls.metadata++; return { metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }; },
        prepareAuthority: async () => { calls.authority++; return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => { calls.prepare++; const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async ({ runId }) => { calls.analyze++; const value = { runId, status: 'complete' }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:00.000Z' };
    const first = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 2 }, deps);
    assert.equal(first.complete, 1); assert.deepEqual(calls, { metadata: 1, authority: 1, prepare: 1, analyze: 1 });
    const second = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 2, concurrency: 3 }, deps);
    assert.equal(second.complete, 2); assert.deepEqual(calls, { metadata: 2, authority: 2, prepare: 2, analyze: 2 });
});

test('scheduler CLI is dry-run by default only when explicitly requested and caps concurrency at three', () => {
    assert.deepEqual(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--stage', 'prepare-only', '--limit', 'pilot', '--concurrency', '3']),
        { apply: false, crosswalkId: CROSSWALK, stage: 'prepare-only', limit: 'pilot', concurrency: 3 });
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--stage', 'analyze', '--concurrency', '4']), /Use/);
});
