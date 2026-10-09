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

test('已核验的重复页面收敛为一个确定性分析身份，并取最早的同批日期', () => {
    const groups = scheduler.groupsFromCrosswalk(state());
    assert.equal(groups.length, 2); assert.equal(groups[0].pageKeys.length, 2);
    assert.deepEqual(groups[0].cohortDates, ['2026-04-19', '2026-04-21']);
    assert.equal(groups[0].analysisDate, '2026-04-19');
    assert.equal(groups[0].runId, scheduler.deterministicRunId(CROSSWALK, groups[0].paperId));
    assert.match(groups[0].runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('只有当前契约的存储记录才算完成，其余排队做完整契约升级', () => {
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

test('即使 Reader 恢复看起来可用，也不会选中正在进行的分析操作', () => {
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

test('正在分析的对账不扫 Reader、不准备授权、也不做分析', async t => {
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

test('先试点再全量重跑：跳过已完成身份，续跑剩下的唯一身份', async t => {
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

test('分析并发为 1 时，每篇论文的授权准备完成后才取下一篇', async t => {
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

test('分析并发限制的是每篇论文完整生命周期的并发数', async t => {
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

test('准备失败后分析继续，但不分析那篇失败的论文', async t => {
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

test('持久调度器操作锁防止两个实例重复同一次 Reader 尝试', async t => {
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

test('调度器只把本地失效恢复能力接到外层操作锁', async t => {
    const root = fixture(t); const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    let received;
    const result = await scheduler.runHistoricalScheduler({ apply: true, crosswalkId: CROSSWALK,
        stage: 'prepare-only', queue: 'all', limit: 'pilot', concurrency: 1 }, { files,
        withSchedulerLock: async (_lockPath, callback, options) => {
            received = options; return callback();
        },
        readCrosswalk: () => state(), recoverRun: () => null,
        fetchMetadata: async () => ({ metadata: {}, proof: {}, rawBytes: Buffer.from('atom') }),
        prepareAuthority: async () => ({ authorityHandle: {} }),
        prepareRun: () => ({ status: 'recovered' }), now: () => '2026-09-07T00:00:00.000Z' });
    const engine = require('../scripts/analysis-engine.js');
    assert.equal(received.recoveryPolicy, engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY);
    assert.equal(result.prepared, 1);
});

test('准备阶段返回当前检查点条目，不复用过期的恢复许可', async t => {
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

test('持久完成之后分析抛错时，以已保存并核验的当前契约运行为准', async t => {
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

test('准备阶段抢跑完成的情况会重新读取，绝不进入分析', async t => {
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

test('工作进程恢复失败时会等同批同伴完成后再拒绝', async t => {
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

test('只做准备时遵守并发上限，绝不进入分析', async t => {
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

test('调度器命令行只在显式要求时默认预演，并发上限为三', () => {
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

test('未改动的待处理 v5 检查点迁移到稳定的、兼容 v4 的运行 ID', async t => {
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

test('缺少显式身份哈希的旧检查点，只有旧组 SHA 能证明身份时才迁移', async t => {
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

test('后出现的重复页面只扩展检查点，不改动已有分析的运行 ID 和日期', async t => {
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

test('续跑已准备的运行会在分析前重新抓取并核验实时授权', async t => {
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

test('恢复阶段看到已保存并核验的运行证明之前，分析不能标记完成', async t => {
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

test('已保存并核验的运行缺失时，检查点的完成状态会被降级', async t => {
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

test('new-full 先分类再限流，绝不为跳过的 Reader 半成品做实时准备', async t => {
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

test('预演只报告按队列过滤后的离线选择，不准备也不写检查点', async t => {
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

test('paperIds 范围先于恢复、限流和实时准备生效，未知 ID 在离线阶段直接失败', async t => {
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

test('reader-recovery 只重试上游已完成且符合条件的半成品，并幂等地保存耗尽状态', async t => {
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

test('扫描期间 Reader 传输冷却保持不变，只有真正重试后才重新计时', async t => {
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

test('Reader 实现指纹变化会清除旧的耗尽记录', () => {
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

test('实现恢复的待处理指纹只为它实际尝试过的那次运行开启诊断迁移', async t => {
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

test('精确的人工补丁审计解锁一次全门禁复核，随后即被消费', t => {
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


function stopFixture(t, ids = ['2604.10001', '2604.10002', '2604.10003']) {
    const root = fixture(t); const current = stateForIds(ids);
    const groups = scheduler.groupsFromCrosswalk(current);
    const runs = new Map(groups.map(group => [group.runId, { runId: group.runId, status: 'sources_ready' }]));
    const files = { pageSourceCrosswalkDir: path.join(root, 'crosswalk'),
        paperSourceAuthorityDir: path.join(root, 'authority'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalAnalysisSchedulerDir: path.join(root, 'scheduler') };
    return { groups, runs, files, options: { apply: true, crosswalkId: CROSSWALK,
        stage: 'analyze', queue: 'all', limit: ids.length, concurrency: 1 },
    deps: { files, readCrosswalk: () => current, recoverRun: ({ runId }) => runs.get(runId) || null,
        prepareAuthority: async () => ({ authorityHandle: {} }), verifyRunAuthority: () => true,
        now: () => '2026-09-07T00:00:00.000Z' },
    checkpoint: () => JSON.parse(fs.readFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`))) };
}

for (const code of ['LLM_ACCOUNT_POOL_EXHAUSTED', 'LLM_ACCOUNT_AUTH_ERROR', 'LLM_ACCOUNT_POOL_CONFIG_ERROR']) {
    test(`历史外层调度遇到 ${code} 时落盘并原样停止，不派下一篇`, async t => {
        const f = stopFixture(t); const analyzed = [];
        const failure = Object.assign(new Error('账号不可用，停止本次运行'), { code, scope: 'run', retryable: false });
        await assert.rejects(scheduler.runHistoricalScheduler(f.options, { ...f.deps,
            analyzeRun: async ({ runId }) => { analyzed.push(runId); throw failure; }
        }), error => error === failure);
        assert.deepEqual(analyzed, [f.groups[0].runId]);
        const items = f.checkpoint().items;
        assert.equal(items[f.groups[0].paperId].status, 'analysis_failed');
        assert.equal(items[f.groups[0].paperId].lastError, failure.message);
        assert.equal(items[f.groups[1].paperId].status, 'sources_ready');
    });
}

test('历史外层调度保留普通单篇失败并继续其余论文', async t => {
    const f = stopFixture(t); const analyzed = [];
    const result = await scheduler.runHistoricalScheduler(f.options, { ...f.deps,
        analyzeRun: async ({ runId }) => { analyzed.push(runId);
            if (runId === f.groups[0].runId) throw new Error('单篇正文未通过检查');
            const complete = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            f.runs.set(runId, complete); return complete;
        }
    });
    assert.equal(analyzed.length, 3); assert.equal(result.complete, 2); assert.equal(result.failed, 1);
});

test('历史并发分析遇到运行级失败后等同伴落盘，不派第三篇', async t => {
    const f = stopFixture(t); const analyzed = [];
    let release; const secondStarted = new Promise(resolve => { release = resolve; });
    const failure = Object.assign(new Error('账号池耗尽'), { code: 'LLM_ACCOUNT_POOL_EXHAUSTED', scope: 'run' });
    await assert.rejects(scheduler.runHistoricalScheduler({ ...f.options, concurrency: 2 }, { ...f.deps,
        analyzeRun: async ({ runId }) => {
            analyzed.push(runId);
            if (runId === f.groups[0].runId) { await secondStarted; throw failure; }
            release(); await new Promise(resolve => setTimeout(resolve, 20));
            const complete = { runId, status: 'complete', storageSealed: true, currentContractComplete: true };
            f.runs.set(runId, complete); return complete;
        }
    }), error => error === failure);
    assert.deepEqual(analyzed, f.groups.slice(0, 2).map(group => group.runId));
    const items = f.checkpoint().items;
    assert.equal(items[f.groups[0].paperId].status, 'analysis_failed');
    assert.equal(items[f.groups[1].paperId].status, 'complete');
    assert.equal(items[f.groups[2].paperId].status, 'sources_ready');
});

test('在途来源准备结束时若同伴已停止运行，只保存来源，不启动模型', async t => {
    const f = stopFixture(t); const analyzed = [];
    let failNow; const preparedSecond = new Promise(resolve => { failNow = resolve; });
    const failure = Object.assign(new Error('账号认证失败'), { code: 'LLM_ACCOUNT_AUTH_ERROR', scope: 'run' });
    await assert.rejects(scheduler.runHistoricalScheduler({ ...f.options, concurrency: 2 }, { ...f.deps,
        prepareAuthority: async ({ arxivId }) => {
            if (arxivId === f.groups[1].arxivId) { failNow(); await new Promise(resolve => setTimeout(resolve, 20)); }
            return { authorityHandle: {} };
        },
        analyzeRun: async ({ runId }) => { analyzed.push(runId); await preparedSecond; throw failure; }
    }), error => error === failure);
    assert.deepEqual(analyzed, [f.groups[0].runId]);
    assert.equal(f.checkpoint().items[f.groups[1].paperId].status, 'sources_ready');
});

test('来源准备中的运行级错误停止队列并传递原错误', async t => {
    const f = stopFixture(t); f.runs.clear(); const fetched = [];
    const failure = Object.assign(new Error('来源配置不可用'), { code: 'SOURCE_CONFIG_ERROR', scope: 'run' });
    await assert.rejects(scheduler.runHistoricalScheduler({ ...f.options, stage: 'prepare-only' }, { ...f.deps,
        fetchMetadata: async id => { fetched.push(id); throw failure; }
    }), error => error === failure);
    assert.deepEqual(fetched, [f.groups[0].arxivId]);
    assert.equal(f.checkpoint().items[f.groups[0].paperId].status, 'prepare_failed');
    assert.equal(f.checkpoint().items[f.groups[1].paperId].status, 'pending');
});
