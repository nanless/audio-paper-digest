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
            { paperId: 'arxiv:2604.12527', identitySha256: '1'.repeat(64), identityRecordSha256: '2'.repeat(64),
                groupSha256: 'c'.repeat(64), pageKeys: [pages[0].pageKey, pages[1].pageKey] },
            { paperId: 'arxiv:2609.03622', identitySha256: '3'.repeat(64), identityRecordSha256: '4'.repeat(64),
                groupSha256: 'd'.repeat(64), pageKeys: [pages[2].pageKey] }
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
        prepareAuthority: async () => { calls.authority++; return { authorityHandle: {} }; }, verifyRunAuthority: () => true,
        prepareRun: ({ runId }) => { calls.prepare++; const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async ({ runId }) => { calls.analyze++; const value = { runId, status: 'complete', sealedComplete: true }; runs.set(runId, value); return value; },
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

test('untouched pending v5 checkpoint migrates to the stable v4-compatible run ID', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true });
    const groups = scheduler.groupsFromCrosswalk(state());
    const old = { contract: scheduler.CONTRACT, version: scheduler.VERSION, crosswalkId: CROSSWALK,
        createdAt: '2026-09-07T00:00:00.000Z', items: Object.fromEntries(groups.map(group => [group.paperId,
            { ...group, runId: group.runId.replace(/-4([a-f0-9]{3})-/, '-5$1-'), status: 'pending', lastError: null }])),
        generation: 1 };
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify(old));
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: () => null, fetchMetadata: async () => { throw new Error('stop after migration'); },
        updateLocked: require('../scripts/analysis-engine.js').updateJsonFileLocked,
        now: () => '2026-09-07T00:00:01.000Z' });
    assert.equal(result.failed, 1);
    const migrated = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.match(migrated.items[groups[0].paperId].runId, /^[a-f0-9-]{14}4/);
});

test('legacy checkpoint without explicit identity hashes migrates only when its old group SHA proves them', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true });
    const groups = scheduler.groupsFromCrosswalk(state()); const group = groups[0];
    const legacyItems = Object.fromEntries(groups.map(item => {
        const legacy = { ...item, groupSha256: require('../scripts/lib/fresh-rewrite-run.js').stableHash({
            paperId: item.paperId, identitySha256: item.identitySha256,
            identityRecordSha256: item.identityRecordSha256, pageKeys: item.pageKeys }),
        status: 'complete', lastError: null };
        delete legacy.identitySha256; delete legacy.identityRecordSha256; return [item.paperId, legacy];
    }));
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify({
        contract: scheduler.CONTRACT, version: scheduler.VERSION, crosswalkId: CROSSWALK,
        createdAt: '2026-09-07T00:00:00.000Z', items: legacyItems, generation: 1 }));
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => ({ runId, status: 'complete', sealedComplete: true }),
        now: () => '2026-09-07T00:00:01.000Z' });
    const migrated = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.equal(migrated.items[group.paperId].identitySha256, group.identitySha256);
    const attacked = structuredClone(migrated); delete attacked.items[group.paperId].identitySha256;
    delete attacked.items[group.paperId].identityRecordSha256; attacked.items[group.paperId].groupSha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify(attacked));
    await assert.rejects(scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(), recoverRun: () => null }), /binding drifted/);
});

test('a later duplicate page extends the checkpoint without changing the existing analysis run/date', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    let current = state(); const runs = new Map();
    const deps = { files, readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async () => ({ authorityHandle: {} }),
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready', sealedComplete: false }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:00.000Z' };
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', limit: 'pilot', concurrency: 1 }, deps);
    const priorGroup = current.identityGroups[0]; const extra = { pageKey: `page:${'9'.repeat(64)}`, cohortDate: '2026-04-01' };
    current = structuredClone(current); current.source.papers.push(extra);
    current.assignments[extra.pageKey] = { sourceAuthority: ref('2604.12527', 'arxiv-2604.12527-history.json') };
    current.identityGroups[0] = { ...priorGroup, pageKeys: [...priorGroup.pageKeys, extra.pageKey].sort(), groupSha256: 'e'.repeat(64) };
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', limit: 'pilot', concurrency: 1 }, deps);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.equal(checkpoint.items[priorGroup.paperId].analysisDate, '2026-04-19');
    assert.equal(checkpoint.items[priorGroup.paperId].pageKeys.length, 3);
});

test('resuming a prepared run refetches and verifies live authority before analysis', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const group = scheduler.groupsFromCrosswalk(state())[0]; const runs = new Map([[group.runId,
        { runId: group.runId, status: 'sources_ready', sealedComplete: false }]]);
    let live = 0; let verified = 0; let analyzed = 0;
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async () => { throw new Error('prepared recovery must not fetch metadata'); },
        prepareAuthority: async options => { live++; assert.equal(options.requireLiveAuthorization, true); return { authorityHandle: {} }; },
        verifyRunAuthority: () => { verified++; return true; },
        analyzeRun: async ({ runId }) => { analyzed++; const sealed = { runId, status: 'complete', sealedComplete: true }; runs.set(runId, sealed); return sealed; },
        now: () => '2026-09-07T00:00:00.000Z' };
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 1 }, deps);
    assert.deepEqual({ live, verified, analyzed }, { live: 1, verified: 1, analyzed: 1 });
});

test('analyze cannot mark complete until recover observes a sealed run proof', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const group = scheduler.groupsFromCrosswalk(state())[0];
    const unsealed = { runId: group.runId, status: 'sources_ready', sealedComplete: false };
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: () => unsealed, prepareAuthority: async () => ({ authorityHandle: {} }),
        verifyRunAuthority: () => true, analyzeRun: async () => ({ status: 'complete' }),
        now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(result.complete, 0); assert.equal(result.failed, 1);
});

test('checkpoint complete is downgraded when its sealed run is missing', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true }); const groups = scheduler.groupsFromCrosswalk(state());
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify({
        contract: scheduler.CONTRACT, version: scheduler.VERSION, crosswalkId: CROSSWALK,
        createdAt: '2026-09-07T00:00:00.000Z', generation: 1,
        items: Object.fromEntries(groups.map(group => [group.paperId, { ...group, status: 'complete', lastError: null }])) }));
    let prepared = 0; const runs = new Map();
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async () => ({ authorityHandle: {} }),
        prepareRun: ({ runId }) => { prepared++; const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:01.000Z' });
    assert.equal(prepared, 1);
});
