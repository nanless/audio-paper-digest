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
function stateForIds(ids) {
    const pages = ids.map((id, index) => ({ pageKey: `page:${String(index + 1).repeat(64)}`,
        cohortDate: `2026-04-${String(index + 10).padStart(2, '0')}` }));
    return { crosswalkId: CROSSWALK, stateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        source: { papers: pages },
        assignments: Object.fromEntries(pages.map((page, index) => [page.pageKey,
            { sourceAuthority: ref(ids[index], `arxiv-${ids[index]}-history.json`) }])),
        identityGroups: ids.map((id, index) => ({ paperId: `arxiv:${id}`,
            identitySha256: String(index + 4).repeat(64), identityRecordSha256: String(index + 5).repeat(64),
            groupSha256: String(index + 6).repeat(64), pageKeys: [pages[index].pageKey] })) };
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

test('only current-contract storage seals count complete and queue all resumes full upgrades', () => {
    const group = scheduler.groupsFromCrosswalk(state())[0];
    assert.equal(scheduler.recoveredSchedulerStatus({ status: 'complete',
        storageSealed: true, currentContractComplete: false }), 'analysis_partial');
    assert.equal(scheduler.recoveredSchedulerStatus({ status: 'complete',
        storageSealed: false, currentContractComplete: true }), 'analysis_partial');
    assert.equal(scheduler.recoveredSchedulerStatus({ status: 'complete',
        storageSealed: true, currentContractComplete: true }), 'complete');
    assert.deepEqual(scheduler.selectCandidates([group], {
        [group.paperId]: { status: 'analysis_partial', recoveryKind: 'full' }
    }, { stage: 'analyze', queue: 'all', maximum: 1,
        now: '2026-09-07T00:00:00.000Z' }), [group]);
});

test('an active analyzing operation is never selected even if Reader recovery looks eligible', () => {
    const group = scheduler.groupsFromCrosswalk(state())[0];
    const item = { status: 'analyzing', recoveryKind: 'reader', exhausted: false,
        nextEligibleAt: null };
    assert.deepEqual(scheduler.selectCandidates([group], { [group.paperId]: item }, {
        stage: 'analyze', queue: 'all', maximum: 1,
        now: '2026-09-07T00:00:00.000Z'
    }), []);
    assert.deepEqual(scheduler.selectCandidates([group], { [group.paperId]: item }, {
        stage: 'analyze', queue: 'reader-recovery', maximum: 1,
        now: '2026-09-07T00:00:00.000Z'
    }), []);
});

test('active analyzing reconciliation performs no Reader scan, authority prepare, or analysis', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state());
    let authority = 0; let analyzed = 0;
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 'pilot', concurrency: 1 }, {
        files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => runId === groups[0].runId
            ? { runId, status: 'analyzing', storedStatus: 'analyzing', storageSealed: false,
                currentContractComplete: false, operationBlocked: true }
            : { runId, status: 'complete', storageSealed: true, currentContractComplete: true },
        inspectRunRecovery: () => { throw new Error('active run must not be inspected'); },
        prepareAuthority: async () => { authority += 1; return { authorityHandle: {} }; },
        analyzeRun: async () => { analyzed += 1; return { status: 'complete' }; },
        now: () => '2026-09-07T00:00:00.000Z'
    });
    assert.deepEqual({ authority, analyzed }, { authority: 0, analyzed: 0 });
    assert.equal(result.complete, 1);
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
        analyzeRun: async ({ runId }) => { calls.analyze++; const value = { runId, status: 'complete', storageSealed: true, currentContractComplete: true }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:00.000Z' };
    const first = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 'pilot', concurrency: 2 }, deps);
    assert.equal(first.complete, 1); assert.deepEqual(calls, { metadata: 1, authority: 1, prepare: 1, analyze: 1 });
    const second = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', limit: 2, concurrency: 3 }, deps);
    assert.equal(second.complete, 2); assert.deepEqual(calls, { metadata: 2, authority: 2, prepare: 2, analyze: 2 });
});

test('analyze concurrency one completes each authority preparation before fetching the next paper', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = state(); const runs = new Map(); const events = [];
    const runToId = new Map(scheduler.groupsFromCrosswalk(current).map(group => [group.runId, group.arxivId]));
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 2, concurrency: 1 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async ({ arxivId }) => { events.push(`prepare ${arxivId}`); return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async ({ runId }) => { events.push(`analyze ${runToId.get(runId)}`);
            const value = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            runs.set(runId, value); return value; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.deepEqual(events, [
        'prepare 2604.12527', 'analyze 2604.12527',
        'prepare 2609.03622', 'analyze 2609.03622'
    ]);
});

test('analyze concurrency bounds the complete per-paper lifecycle', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = stateForIds(['2604.10001', '2604.10002', '2604.10003']);
    const groups = scheduler.groupsFromCrosswalk(current); const runs = new Map();
    const runToId = new Map(groups.map(group => [group.runId, group.arxivId]));
    const active = new Set(); let maximumActive = 0;
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 3, concurrency: 2 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => { active.add(id); maximumActive = Math.max(maximumActive, active.size);
            return { metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }; },
        prepareAuthority: async () => ({ authorityHandle: {} }),
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async ({ runId }) => { await new Promise(resolve => setTimeout(resolve, 5));
            active.delete(runToId.get(runId));
            const value = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            runs.set(runId, value); return value; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(maximumActive, 2);
    assert.equal(active.size, 0);
});

test('analyze continues after prepare failure without analyzing the failed paper', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = state(); const groups = scheduler.groupsFromCrosswalk(current); const runs = new Map();
    const runToId = new Map(groups.map(group => [group.runId, group.arxivId])); const prepared = []; const analyzed = [];
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 2, concurrency: 1 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async ({ arxivId }) => { prepared.push(arxivId);
            if (arxivId === groups[0].arxivId) throw new Error('source unavailable');
            return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async ({ runId }) => { analyzed.push(runToId.get(runId));
            const value = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            runs.set(runId, value); return value; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.deepEqual(prepared, groups.map(group => group.arxivId));
    assert.deepEqual(analyzed, [groups[1].arxivId]);
    assert.equal(result.complete, 1);
    assert.equal(result.failed, 1);
});

test('durable scheduler operation lock prevents two instances from repeating one Reader attempt', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = state(); const group = scheduler.groupsFromCrosswalk(current)[0];
    const runs = new Map([[group.runId,
        { runId: group.runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }]]);
    let attempts = 0; let authorities = 0;
    const deps = { files, readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId),
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: 'reader-same', failureSignature: 'same-failure', cooldownMs: 0,
            exhausted: attempts > 0 }),
        prepareAuthority: async () => { authorities++; return { authorityHandle: {} }; },
        verifyRunAuthority: () => true,
        analyzeRun: async () => { attempts++; await new Promise(resolve => setTimeout(resolve, 20));
            return { status: 'analysis_partial' }; }, now: () => '2026-09-07T00:00:00.000Z' };
    const options = { apply: true, crosswalkId: CROSSWALK, stage: 'analyze', queue: 'reader-recovery',
        paperIds: [group.paperId], limit: 'pilot', concurrency: 1 };
    await Promise.all([
        scheduler.runHistoricalScheduler(options, deps),
        scheduler.runHistoricalScheduler(options, deps)
    ]);
    assert.equal(attempts, 1);
    assert.equal(authorities, 1);
});

test('prepare returns the current checkpoint item instead of reusing stale recovery permission', async t => {
    const engine = require('../scripts/analysis-engine.js');
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = state(); const groups = scheduler.groupsFromCrosswalk(current); const group = groups[0];
    const checkpointPath = path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`);
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true });
    fs.writeFileSync(checkpointPath, JSON.stringify({ contract: scheduler.CONTRACT, version: scheduler.VERSION,
        crosswalkId: CROSSWALK, createdAt: '2026-09-07T00:00:00.000Z', generation: 1,
        items: Object.fromEntries(groups.map(item => [item.paperId, { ...item,
            status: item.paperId === group.paperId ? 'analysis_partial' : 'complete', lastError: null,
            ...(item.paperId === group.paperId ? { recoveryKind: 'reader', recoveryFingerprint: 'old',
                failureSignature: 'same', exhausted: true } : {}) }])) }));
    const runs = new Map([[group.runId,
        { runId: group.runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }],
    [groups[1].runId, { runId: groups[1].runId, status: 'complete', storageSealed: true, currentContractComplete: true }]]);
    const refresh = [];
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK, stage: 'analyze',
        queue: 'reader-recovery', paperIds: [group.paperId], limit: 'pilot', concurrency: 1 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId),
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: 'new', failureSignature: 'same', exhausted: true, cooldownMs: 0 }),
        prepareAuthority: async () => {
            engine.updateJsonFileLocked(checkpointPath, value => ({ ...value, items: { ...value.items,
                [group.paperId]: { ...value.items[group.paperId], implementationRecoveryPendingFingerprint: null } } }));
            return { authorityHandle: {} };
        }, verifyRunAuthority: () => true,
        analyzeRun: async options => { refresh.push(options.refreshReaderDiagnostics);
            const complete = { runId: group.runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            runs.set(group.runId, complete); return complete; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.deepEqual(refresh, [false]);
});

test('a sealed current-contract run wins when analyze throws after durable completion', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = stateForIds(['2604.10001']); const group = scheduler.groupsFromCrosswalk(current)[0];
    const partial = { runId: group.runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false };
    let recovered = partial;
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 'pilot', concurrency: 1 }, { files,
        readCrosswalk: () => current, recoverRun: () => recovered,
        inspectRunRecovery: () => ({ recoveryKind: 'full' }),
        prepareAuthority: async () => ({ authorityHandle: {} }), verifyRunAuthority: () => true,
        analyzeRun: async () => { recovered = { runId: group.runId, status: 'complete',
            storageSealed: true, currentContractComplete: true }; throw new Error('post-seal callback failed'); },
        now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(result.complete, 1);
    assert.equal(result.failed, 0);
});

test('prepare-time race to complete is re-read and never enters analyze', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = stateForIds(['2604.10001']); const group = scheduler.groupsFromCrosswalk(current)[0];
    let recoverCalls = 0; let analyzed = 0;
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 'pilot', concurrency: 1 }, { files,
        readCrosswalk: () => current, recoverRun: () => {
            recoverCalls++;
            return recoverCalls === 1 ? null : { runId: group.runId, status: 'complete',
                storageSealed: true, currentContractComplete: true };
        }, prepareAuthority: async () => ({ authorityHandle: {} }), verifyRunAuthority: () => true,
        analyzeRun: async () => { analyzed++; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(analyzed, 0);
    assert.equal(result.complete, 1);
});

test('worker recovery failure waits for sibling completion before rejecting', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = stateForIds(['2604.10001', '2604.10002']); const groups = scheduler.groupsFromCrosswalk(current);
    const runs = new Map(groups.map(group => [group.runId,
        { runId: group.runId, status: 'sources_ready', storageSealed: false, currentContractComplete: false }]));
    let recoveryBroken = false; let siblingFinished = false;
    await assert.rejects(scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: 2, concurrency: 2 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => {
            if (runId === groups[0].runId && recoveryBroken) throw new Error('recovery unreadable');
            return runs.get(runId);
        }, prepareAuthority: async () => ({ authorityHandle: {} }), verifyRunAuthority: () => true,
        analyzeRun: async ({ runId }) => {
            if (runId === groups[0].runId) { recoveryBroken = true; throw new Error('analysis failed'); }
            await new Promise(resolve => setTimeout(resolve, 30)); siblingFinished = true;
            const complete = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            runs.set(runId, complete); return complete;
        }, now: () => '2026-09-07T00:00:00.000Z' }), AggregateError);
    assert.equal(siblingFinished, true);
});

test('prepare-only honors concurrency and never enters analysis', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const current = stateForIds(['2604.10001', '2604.10002', '2604.10003']);
    const runs = new Map(); let active = 0; let maximum = 0; let analyzed = 0;
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', queue: 'all', limit: 3, concurrency: 2 }, { files,
        readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async () => { active++; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 10)); active--; return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready' }; runs.set(runId, value); return value; },
        analyzeRun: async () => { analyzed++; }, now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(maximum, 2);
    assert.equal(analyzed, 0);
});

test('scheduler CLI is dry-run by default only when explicitly requested and caps concurrency at three', () => {
    assert.deepEqual(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--stage', 'prepare-only', '--limit', 'pilot', '--concurrency', '3']),
        { apply: false, crosswalkId: CROSSWALK, stage: 'prepare-only', queue: 'all', limit: 'pilot', concurrency: 3 });
    assert.equal(cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--stage', 'analyze',
        '--queue', 'reader-recovery']).queue, 'reader-recovery');
    assert.deepEqual(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--stage', 'analyze',
        '--paper-ids', 'arxiv:2609.03622,arxiv:2604.12527', '--paper-ids', 'arxiv:2512.09066']).paperIds,
    ['arxiv:2609.03622', 'arxiv:2604.12527', 'arxiv:2512.09066']);
    assert.throws(() => cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--stage', 'analyze',
        '--paper-ids', 'arxiv:2609.03622,arxiv:2609.03622']), /Use/);
    assert.throws(() => cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--stage', 'analyze',
        '--paper-ids', '2609.03622']), /Use/);
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
        recoverRun: ({ runId }) => ({ runId, status: 'complete', storageSealed: true, currentContractComplete: true }),
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
    let current = state(); const runs = new Map(); const recoveredDates = new Map();
    const deps = { files, readCrosswalk: () => current, recoverRun: ({ runId, date }) => {
        recoveredDates.set(runId, date); return runs.get(runId) || null;
    },
        fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async () => ({ authorityHandle: {} }),
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready', storageSealed: false, currentContractComplete: false }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:00.000Z' };
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', limit: 'pilot', concurrency: 1 }, deps);
    const priorGroup = current.identityGroups[0]; const extra = { pageKey: `page:${'9'.repeat(64)}`, cohortDate: '2026-04-01' };
    current = structuredClone(current); current.source.papers.push(extra);
    current.assignments[extra.pageKey] = { sourceAuthority: ref('2604.12527', 'arxiv-2604.12527-history.json') };
    current.identityGroups[0] = { ...priorGroup, pageKeys: [...priorGroup.pageKeys, extra.pageKey].sort(), groupSha256: 'e'.repeat(64) };
    const preview = await scheduler.runHistoricalScheduler({ apply: false, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'new-full', limit: 'pilot', concurrency: 1 }, deps);
    assert.equal(preview.selected[0].paperId, priorGroup.paperId);
    assert.equal(recoveredDates.get(preview.selected[0].runId), '2026-04-19');
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
        { runId: group.runId, status: 'sources_ready', storageSealed: false, currentContractComplete: false }]]);
    let live = 0; let verified = 0; let analyzed = 0;
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => runs.get(runId) || null,
        fetchMetadata: async () => { throw new Error('prepared recovery must not fetch metadata'); },
        prepareAuthority: async options => { live++; assert.equal(options.requireLiveAuthorization, true); return { authorityHandle: {} }; },
        verifyRunAuthority: () => { verified++; return true; },
        analyzeRun: async ({ runId }) => { analyzed++; const sealed = { runId, status: 'complete', storageSealed: true, currentContractComplete: true }; runs.set(runId, sealed); return sealed; },
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
    const unsealed = { runId: group.runId, status: 'sources_ready', storageSealed: false, currentContractComplete: false };
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

test('new-full classifies before limit and never live-prepares a skipped Reader partial', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state());
    const runs = new Map([[groups[0].runId, { runId: groups[0].runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }]]);
    const liveIds = []; let metadata = 0; let analyzed = 0;
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK, stage: 'analyze',
        queue: 'new-full', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => runs.get(runId) || null,
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: 'reader-v1', failureSignature: 'content-v1', exhausted: false, cooldownMs: 0 }),
        fetchMetadata: async id => { metadata++; return { metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }; },
        prepareAuthority: async ({ arxivId }) => { liveIds.push(arxivId); return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => { const value = { runId, status: 'sources_ready', storageSealed: false, currentContractComplete: false }; runs.set(runId, value); return value; },
        verifyRunAuthority: () => true,
        analyzeRun: async ({ runId }) => { analyzed++; const value = { runId, status: 'complete', storageSealed: true, currentContractComplete: true }; runs.set(runId, value); return value; },
        now: () => '2026-09-07T00:00:00.000Z' });
    assert.deepEqual(liveIds, ['2609.03622']);
    assert.equal(metadata, 1); assert.equal(analyzed, 1);
});

test('dry-run reports the queue-filtered offline selection without prepare or checkpoint writes', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state()); let prepared = 0;
    const result = await scheduler.runHistoricalScheduler({ apply: false, crosswalkId: CROSSWALK, stage: 'analyze',
        queue: 'new-full', limit: 'pilot', concurrency: 1 }, { files, readCrosswalk: () => state(),
        recoverRun: ({ runId }) => runId === groups[0].runId
            ? { runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false } : null,
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: 'reader-v1', failureSignature: 'failed', exhausted: true, cooldownMs: 0 }),
        prepareAuthority: async () => { prepared++; throw new Error('dry-run prepared live authority'); },
        now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(prepared, 0); assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].paperId, 'arxiv:2609.03622');
    assert.equal(result.selected[0].currentStatus, 'pending');
    assert.equal(fs.existsSync(files.historicalAnalysisSchedulerDir), false);
});

test('paperIds scope is applied before recovery, limit and live prepare, and unknown IDs fail offline', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state()); const recovered = []; const live = [];
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => {
        recovered.push(runId); return null;
    }, fetchMetadata: async id => ({ metadata: { arxivId: id }, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async ({ arxivId }) => { live.push(arxivId); return { authorityHandle: {} }; },
        prepareRun: ({ runId }) => ({ runId, status: 'sources_ready' }),
        now: () => '2026-09-07T00:00:00.000Z' };
    const preview = await scheduler.runHistoricalScheduler({ apply: false, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'new-full', paperIds: ['arxiv:2609.03622'], limit: 'pilot', concurrency: 1 }, deps);
    assert.deepEqual(preview.selected.map(item => item.paperId), ['arxiv:2609.03622']);
    assert.deepEqual(recovered, [groups[1].runId]); assert.deepEqual(live, []);
    recovered.length = 0;
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', queue: 'new-full', paperIds: ['arxiv:2609.03622'], limit: 'pilot', concurrency: 1 }, deps);
    assert.deepEqual(recovered, [groups[1].runId, groups[1].runId]);
    assert.deepEqual(live, ['2609.03622']);
    await assert.rejects(scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', paperIds: ['arxiv:2609.99999'], limit: 'pilot', concurrency: 1 }, deps), /Unknown/);
    assert.deepEqual(live, ['2609.03622']);
    await assert.rejects(scheduler.runHistoricalScheduler({ apply: false, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', paperIds: ['arxiv:2609.03622', 'arxiv:2609.03622'],
        limit: 'pilot', concurrency: 1 }, deps), /duplicate-free/);
});

test('reader-recovery retries only an eligible upstream-complete partial and persists exhaustion idempotently', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state());
    const runs = new Map(groups.map(group => [group.runId,
        { runId: group.runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }]));
    let analyzed = 0; const liveIds = [];
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => runs.get(runId),
        inspectRunRecovery: ({ runId }) => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: `reader-${runId}`, failureSignature: 'same-content-failure', cooldownMs: 0,
            exhausted: runId === groups[1].runId || analyzed > 0 }),
        prepareAuthority: async ({ arxivId }) => { liveIds.push(arxivId); return { authorityHandle: {} }; },
        verifyRunAuthority: () => true,
        analyzeRun: async options => { analyzed++; assert.equal(options.refreshReaderDiagnostics, false);
            return { status: 'analysis_partial' }; },
        now: () => '2026-09-07T00:00:00.000Z' };
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK, stage: 'analyze',
        queue: 'reader-recovery', limit: 2, concurrency: 2 }, deps);
    assert.deepEqual(liveIds, ['2604.12527']); assert.equal(analyzed, 1);
    const checkpointPath = path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`);
    let checkpoint = JSON.parse(fs.readFileSync(checkpointPath));
    assert.equal(checkpoint.items[groups[0].paperId].exhausted, true);
    assert.equal(checkpoint.items[groups[1].paperId].exhausted, true);
    await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK, stage: 'analyze',
        queue: 'reader-recovery', limit: 2, concurrency: 2 }, deps);
    assert.deepEqual(liveIds, ['2604.12527']); assert.equal(analyzed, 1);
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath));
    assert.equal(checkpoint.items[groups[0].paperId].failureSignature, 'same-content-failure');
});

test('Reader transport cooldown is stable while scanned and restarts only after an actual retry', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state());
    const runs = new Map([[groups[0].runId, { runId: groups[0].runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }],
        [groups[1].runId, { runId: groups[1].runId, status: 'complete', storageSealed: true, currentContractComplete: true }]]);
    let current = '2026-09-07T00:00:00.000Z'; let live = 0; let analyzed = 0;
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => runs.get(runId),
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: 'reader-transport-v1', failureSignature: 'http-429', exhausted: false,
            transportOnly: true, cooldownMs: scheduler.READER_TRANSPORT_COOLDOWN_MS }),
        prepareAuthority: async () => { live++; return { authorityHandle: {} }; }, verifyRunAuthority: () => true,
        analyzeRun: async () => { analyzed++; return { status: 'analysis_partial' }; }, now: () => current };
    const run = () => scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'reader-recovery', limit: 'pilot', concurrency: 1 }, deps);
    await run();
    let checkpoint = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.equal(checkpoint.items[groups[0].paperId].nextEligibleAt, '2026-09-07T00:05:00.000Z');
    current = '2026-09-07T00:01:00.000Z'; await run();
    checkpoint = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.equal(checkpoint.items[groups[0].paperId].nextEligibleAt, '2026-09-07T00:05:00.000Z');
    assert.deepEqual({ live, analyzed }, { live: 0, analyzed: 0 });
    current = '2026-09-07T00:06:00.000Z'; await run();
    checkpoint = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.deepEqual({ live, analyzed }, { live: 1, analyzed: 1 });
    assert.equal(checkpoint.items[groups[0].paperId].nextEligibleAt, '2026-09-07T00:11:00.000Z');
    await run(); assert.deepEqual({ live, analyzed }, { live: 1, analyzed: 1 });
});

test('a Reader implementation fingerprint change clears old exhaustion', () => {
    assert.deepEqual(scheduler.mergeRecoveryState({ recoveryFingerprint: 'old', failureSignature: 'same', exhausted: true,
        nextEligibleAt: '2026-09-08T00:00:00.000Z' }, { recoveryKind: 'reader', recoveryFingerprint: 'new',
        failureSignature: 'same', exhausted: true, cooldownMs: scheduler.READER_TRANSPORT_COOLDOWN_MS },
    '2026-09-07T00:00:00.000Z'), { recoveryKind: 'reader', recoveryFingerprint: 'new',
        failureSignature: 'same', nextEligibleAt: null, exhausted: false,
        implementationRecoveryPendingFingerprint: 'new', operatorPatchSha256: null,
        operatorRecoveryConsumedSha256: null });
    const observed = { recoveryKind: 'reader', recoveryFingerprint: 'new', failureSignature: 'same',
        exhausted: true, cooldownMs: 0 };
    const pending = scheduler.mergeRecoveryState({ recoveryFingerprint: 'new', failureSignature: 'same',
        exhausted: false, implementationRecoveryPendingFingerprint: 'new' }, observed,
    '2026-09-07T00:00:01.000Z');
    assert.equal(pending.exhausted, false, 'offline scans cannot consume an implementation recovery');
    const attempted = scheduler.mergeRecoveryState(pending, observed, '2026-09-07T00:00:02.000Z', { attempted: true });
    assert.equal(attempted.exhausted, true);
    assert.equal(attempted.implementationRecoveryPendingFingerprint, null);
});

test('implementation recovery pending fingerprint enables diagnostic migration for exactly its attempted run', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    const groups = scheduler.groupsFromCrosswalk(state());
    const runs = new Map([[groups[0].runId,
        { runId: groups[0].runId, status: 'analysis_partial', storageSealed: false, currentContractComplete: false }],
    [groups[1].runId, { runId: groups[1].runId, status: 'complete', storageSealed: true, currentContractComplete: true }]]);
    let fingerprint = 'reader-implementation-v1'; const refreshValues = [];
    const deps = { files, readCrosswalk: () => state(), recoverRun: ({ runId }) => runs.get(runId),
        inspectRunRecovery: () => ({ recoveryKind: 'reader', upstreamReady: true,
            recoveryFingerprint: fingerprint, failureSignature: 'same', exhausted: true, cooldownMs: 0 }),
        prepareAuthority: async () => ({ authorityHandle: {} }), verifyRunAuthority: () => true,
        analyzeRun: async options => { refreshValues.push(options.refreshReaderDiagnostics);
            return { status: 'analysis_partial' }; }, now: () => '2026-09-07T00:00:00.000Z' };
    const run = () => scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'reader-recovery', limit: 'pilot', concurrency: 1 }, deps);
    await run();
    assert.deepEqual(refreshValues, [], 'an initially observed exhausted candidate has no implementation unlock');
    fingerprint = 'reader-implementation-v2';
    await run();
    assert.deepEqual(refreshValues, [true]);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`)));
    assert.equal(checkpoint.items[groups[0].paperId].implementationRecoveryPendingFingerprint, null);
    assert.equal(checkpoint.items[groups[0].paperId].exhausted, true);
    await run();
    assert.deepEqual(refreshValues, [true], 'consumed implementation recovery cannot migrate a second time');
});

test('an exact operator patch audit unlocks one full-gate replay and is then consumed', t => {
    const root = fixture(t); const runId = '22222222-2222-4222-8222-222222222222'; const paperId = '2601.18904';
    const runDir = path.join(root, runId); const repair = require('../scripts/lib/reader-repair.js');
    const fresh = require('../scripts/lib/fresh-rewrite-run.js');
    const patchBytes = Buffer.from('{"operator":"fix"}'); const patchSha = fresh.sha256(patchBytes);
    const beforeBytes = Buffer.from('{"failed":"candidate"}'); const beforeSha = fresh.sha256(beforeBytes);
    const draft = { sections: [{ body: 'fixed' }] };
    const audit = { contract: 'reader-operator-patch-v1', runId, paperId, patchFileSha256: patchSha,
        oldEnvelopeSha256: beforeSha, afterDraftSha256: repair.hashDraft(draft),
        archive: path.posix.join('patches', 'operator-archive', patchSha) };
    const payload = { status: 'failed', draft, operatorPatches: [audit] };
    const archive = path.join(runDir, audit.archive); fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(archive, 'before.json'), beforeBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(archive, 'patch.json'), patchBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(archive, 'intent.json'), JSON.stringify({ audit,
        afterPayloadSha256: repair.hashDraft(payload) }), { mode: 0o600 });
    const operatorPatchSha256 = scheduler.exactOperatorPatchRecovery(runDir, runId, paperId, payload);
    assert.equal(operatorPatchSha256, repair.hashDraft(draft));
    const observed = { recoveryKind: 'reader', recoveryFingerprint: 'same-reader', failureSignature: 'same-failure',
        exhausted: true, cooldownMs: 0, operatorPatchSha256 };
    const unlocked = scheduler.mergeRecoveryState({ recoveryFingerprint: 'same-reader',
        failureSignature: 'same-failure', exhausted: true }, observed, '2026-09-07T00:00:00.000Z');
    assert.equal(unlocked.exhausted, false); assert.equal(unlocked.operatorRecoveryConsumedSha256, null);
    const consumed = scheduler.mergeRecoveryState(unlocked, observed, '2026-09-07T00:00:01.000Z', { attempted: true });
    assert.equal(consumed.exhausted, true);
    assert.equal(consumed.operatorRecoveryConsumedSha256, operatorPatchSha256);
    const repeated = scheduler.mergeRecoveryState(consumed, observed, '2026-09-07T00:00:02.000Z');
    assert.equal(repeated.exhausted, true, 'the same operator audit cannot unlock a second attempt');
    fs.appendFileSync(path.join(archive, 'patch.json'), ' ');
    assert.equal(scheduler.exactOperatorPatchRecovery(runDir, runId, paperId, payload), null);
});
