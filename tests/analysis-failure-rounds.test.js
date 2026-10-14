'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { runFailureRounds, semanticAnalysisProgress } = require('../scripts/lib/analysis-failure-rounds');
const { analyzeBatch } = require('../scripts/analysis-engine');
const { validAnalysisPaper, validAnalysisText } = require('./valid-analysis-fixture');
const items = count => Array.from({ length: count }, (_, index) => ({ arxivId: `2610.${String(90000 + index)}` }));
const failure = item => ({ success: false, result: { ...item, error: 'content invalid', errorRetryable: true } });
const analyzed = () => ({ analysis: validAnalysisText(), analysisManifest: validAnalysisPaper('fixture').analysisManifest,
    analysisStageCheckpoints: validAnalysisPaper('fixture').analysisStageCheckpoints });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let index = 0; index < 200; index++) { if (predicate()) return; await tick(); }
    assert.fail('round scheduling did not reach expected state');
}

it('whole-batch barrier waits for last item and durable save; only failed items repeat in order', async () => {
    const input = items(5), calls = [], rounds = [];
    let releaseLast, releaseSave;
    const last = new Promise(resolve => { releaseLast = resolve; });
    const save = new Promise(resolve => { releaseSave = resolve; });
    const pending = runFailureRounds(input, { concurrency: 2, maxRounds: 3,
        runItem: async (item, context) => {
            calls.push([context.round, context.index]);
            if (context.round === 1 && context.index === 4) await last;
            return context.index === 0 && context.round < 3 ? failure(item)
                : { success: true, result: item };
        }, onRoundDone: async round => { rounds.push(round); if (round.round === 1) await save; } });
    await until(() => calls.length === 5);
    assert.ok(calls.every(([round]) => round === 1));
    releaseLast(); await until(() => rounds.length === 1);
    await tick(); assert.equal(calls.length, 5);
    releaseSave(); const result = await pending;
    assert.deepEqual(calls, [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [2, 0], [3, 0]]);
    assert.deepEqual(rounds.map(round => round.failedIds), [[input[0].arxivId], [input[0].arxivId], []]);
    assert.deepEqual(result.outcomes.map(outcome => outcome.result.arxivId), input.map(item => item.arxivId));
    assert.deepEqual(result.failedIds, []);
});

it('async stop gate observes service halt before dispatch and preserves partial outcomes/unstarted IDs', async () => {
    const input = items(5), started = [], sourceError = Object.assign(new Error('account exhausted'),
        { scope: 'run', code: 'LLM_ACCOUNT_POOL_EXHAUSTED', retryable: false });
    await assert.rejects(runFailureRounds(input, { concurrency: 1,
        shouldStop: async () => { await tick(); return false; },
        runItem: async item => { started.push(item.arxivId); throw sourceError; } }), error => {
        assert.equal(error, sourceError);
        assert.equal(error.stopped, true);
        assert.deepEqual(error.unstartedIds, input.slice(1).map(item => item.arxivId));
        assert.deepEqual(error.unfinishedIds, [input[0].arxivId]);
        return true;
    });
    assert.deepEqual(started, [input[0].arxivId]);
});

it('parallel storage/service and stop-notification failures retain all causes and stop later rounds', async () => {
    const storage = new Error('checkpoint disk full'), notify = new Error('stop state save failed');
    const input = items(4), calls = [];
    await assert.rejects(runFailureRounds(input, { concurrency: 2,
        runItem: async (item, context) => {
            calls.push(context.index); await tick();
            if (context.index === 1) throw storage;
            return { success: false, scope: 'run', code: 'POOL_EXHAUSTED', error: 'quota', result: item };
        }, onRunStop: () => { throw notify; } }), error => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(storage)); assert.ok(error.errors.includes(notify));
        assert.ok(error.errors.some(cause => cause.code === 'POOL_EXHAUSTED'));
        assert.equal(error.retryable, false); assert.deepEqual(error.unstartedIds, input.slice(2).map(item => item.arxivId));
        return true;
    });
    assert.deepEqual(calls, [0, 1]);
});

it('small persistently failing set is only an unsigned manual handoff report after three rounds', async () => {
    const result = await runFailureRounds(items(2), { runItem: async (item, context) => ({
        ...failure(item), result: { ...item, failedDraft: `new failed draft ${context.round}` } }) });
    assert.equal(result.rounds.length, 3); assert.equal(result.manualHandoff.eligible, true);
    assert.equal(result.manualHandoff.reason, 'small_persistently_failed_set');
    assert.equal(result.manualHandoff.newApiRequestsAuthorized, false);
    assert.ok(result.outcomes.every(outcome => outcome.success === false));
    const large = await runFailureRounds(items(6), { runItem: async item => failure(item) });
    assert.equal(large.manualHandoff.eligible, false);
    const blocked = await runFailureRounds(items(1), { runItem: async item => ({ ...failure(item),
        retryable: false, code: 'API_READER_BUDGET_EXHAUSTED' }) });
    assert.equal(blocked.rounds.length, 1); assert.equal(blocked.manualHandoff.eligible, false);
    assert.deepEqual(blocked.manualHandoff.budgetExhaustedIds, [items(1)[0].arxivId]);
});

it('semantic progress ignores timestamps/fees but notices accepted stages, outputs and failed drafts', () => {
    const initial = { analysis: 'paid body', analysisManifest: { stages: {
        primaryAnalysis: { status: 'complete', outputAnalysisSha256: 'a', cost: 1, completedAt: 'old' }
    } }, failedDraftSha256: 'b', llmUsage: { cost: 1 }, latestAnalysisAttemptAt: 'old' };
    const changingFees = structuredClone(initial);
    changingFees.llmUsage.cost = 10; changingFees.latestAnalysisAttemptAt = 'now';
    changingFees.analysisManifest.stages.primaryAnalysis.cost = 10;
    assert.equal(semanticAnalysisProgress(initial), semanticAnalysisProgress(changingFees));
    changingFees.failedDraftSha256 = 'c';
    assert.notEqual(semanticAnalysisProgress(initial), semanticAnalysisProgress(changingFees));
});

it('engine retries failed set after first full pass, preserves paid state, rereads under lock and counts unique success', async () => {
    const input = items(3), calls = [], reads = [], saves = [], batches = [];
    const canonical = new Map();
    const { results, stats, rounds } = await analyzeBatch(input, { concurrency: 1, maxRetries: 2, retryDelayMs: 0,
        preparePaperLocked: paper => { reads.push(paper.arxivId); return { paper: canonical.get(paper.arxivId) || paper }; },
        analyzeFn: async paper => {
            calls.push(paper.arxivId);
            if (paper.arxivId === input[0].arxivId && !paper.readerPaidCandidate) {
                return { analysis: null, error: 'Reader rejected', analysisCheckpoint: 'paid checkpoint',
                    readerPaidCandidate: { attempts: 2, cost: 0.7, epoch: 0 }, analysisManifest: { stages: {} } };
            }
            if (paper.arxivId === input[0].arxivId) {
                assert.equal(paper.analysisCheckpoint, 'paid checkpoint');
                assert.deepEqual(paper.readerPaidCandidate, { attempts: 2, cost: 0.7, epoch: 0 });
            }
            return analyzed();
        }, onPaperResultLocked: (_paper, outcome) => canonical.set(_paper.arxivId, outcome.result),
        onSave: (records, state) => saves.push([state.retryRound, records.map(record => record.arxivId)]),
        onBatchDone: (batch, outcomes, context) => batches.push([context.round, batch, outcomes.length]) });
    assert.deepEqual(calls, input.map(item => item.arxivId).concat(input[0].arxivId));
    assert.deepEqual(reads, calls); assert.equal(stats.success, 3); assert.equal(stats.failed, 0);
    assert.equal(rounds.length, 2); assert.deepEqual(results.map(paper => paper.arxivId), input.map(item => item.arxivId));
    assert.deepEqual(saves.map(save => save[0]), [1, 2]);
    assert.deepEqual(batches, [[1, 1, 1], [1, 2, 1], [1, 3, 1], [2, 1, 1]]);
});

it('engine default/legacy rounds do not repeat terminal failures or silently expand explicit limits', async () => {
    let calls = 0;
    const result = await analyzeBatch(items(1), { maxRetries: 2, retryDelayMs: 0,
        analyzeFn: async () => { calls++; return { analysis: null, error: 'budget', errorRetryable: false,
            errorCode: 'API_READER_BUDGET_EXHAUSTED' }; } });
    assert.equal(calls, 1); assert.equal(result.stats.failed, 1);
    assert.equal(result.manualHandoff.eligible, false);
    for (const maxRounds of [0, 11, 1.5]) await assert.rejects(analyzeBatch(items(1), { maxRounds }), /maxRounds/);
    assert.equal(calls, 1);
});

it('round-save stop prevents the next retry; returned failed checkpoints remain in the error', async () => {
    const stop = require('../scripts/lib/analysis-stop-control');
    let calls = 0, saves = 0;
    await assert.rejects(analyzeBatch(items(2), { maxRetries: 2, retryDelayMs: 0,
        analyzeFn: async () => { calls++; return { analysis: null, error: 'needs repair', analysisCheckpoint: 'paid checkpoint' }; },
        onSave: () => { saves++; stop.requestAnalysisStop('operator_between_rounds'); } }), error => {
        assert.equal(error.code, stop.CODE); assert.equal(error.results.length, 2);
        assert.ok(error.results.every(paper => paper.analysisCheckpoint === 'paid checkpoint'));
        assert.equal(error.rounds.length, 1); return true;
    });
    assert.equal(calls, 2); assert.equal(saves, 1);
});

it('engine retains service failure when the same failing paper cannot save its result', async () => {
    const storage = Object.assign(new Error('canonical save failed'), { code: 'ENOSPC' });
    await assert.rejects(analyzeBatch(items(3), { concurrency: 1, maxRetries: 2,
        analyzeFn: async () => ({ analysis: null, error: 'quota', errorScope: 'run',
            errorRetryable: false, errorCode: 'LLM_ACCOUNT_POOL_EXHAUSTED' }),
        onPaperResultLocked: () => { throw storage; } }), error => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.some(cause => cause.code === 'LLM_ACCOUNT_POOL_EXHAUSTED'));
        assert.ok(error.errors.some(cause => cause.cause === storage));
        assert.equal(error.code, 'ENOSPC'); assert.equal(error.retryable, false); return true;
    });
});

it('higher round caps can stop on semantic stagnation, while changed drafts continue to the cap', async () => {
    const stable = await runFailureRounds(items(1), { maxRounds: 7, runItem: async item => failure(item) });
    assert.equal(stable.rounds.length, 3);
    const improving = await runFailureRounds(items(1), { maxRounds: 5,
        runItem: async (item, context) => ({ ...failure(item), result: { ...item, failedDraftSha256: String(context.round) } }) });
    assert.equal(improving.rounds.length, 5);
    assert.equal(improving.manualHandoff.eligible, true);
});

it('fatal callback on a skipped paper is propagated without analyzing it', async () => {
    let calls = 0;
    await assert.rejects(analyzeBatch(items(1), { maxRetries: 2, shouldSkip: () => true,
        analyzeFn: async () => { calls++; return analyzed(); },
        onPaperDone: () => { throw new Error('skipped result save failed'); } }), /skipped result save failed/);
    assert.equal(calls, 0);
});
