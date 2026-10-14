'use strict';

const crypto = require('node:crypto');
const CONTRACT = 'analysis-failure-rounds-v1';
const HANDOFF_CONTRACT = 'analysis-batch-manual-handoff-v1';
const stableHash = value => {
    const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
    return crypto.createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
};

// Fees, attempt counts and timestamps do not prove that content has improved.
function semanticAnalysisProgress(item, outcome = null) {
    const paper = outcome?.result ? { ...item, ...outcome.result,
        ...(outcome.success === false && outcome.result.analysis === null
            ? { analysis: item?.analysis || '' } : {}) } : item;
    const stages = paper?.analysisManifest?.stages || {};
    const completed = Object.entries(stages).filter(([, stage]) =>
        ['complete', 'not_needed', 'skipped'].includes(stage?.status)).map(([name, stage]) => ({
        name, status: stage.status,
        outputs: Object.fromEntries(Object.entries(stage).filter(([key, value]) =>
            /^(?:outputAnalysis|article|plan|sourceBindings|summary|outputCoreSummary|afterDraft)Sha256$/.test(key)
            && typeof value === 'string'))
    }));
    const drafts = [];
    for (const record of [paper, stages.apiReaderArticle, paper?.readerFailureDiagnostics,
        paper?.apiReaderFailedBundleHistory?.at(-1)]) {
        if (!record || typeof record !== 'object') continue;
        for (const key of ['draft', 'rawDraft', 'failedDraft', 'draftSha256', 'failedDraftSha256', 'afterDraftSha256']) {
            if (record[key] !== undefined) drafts.push([key, record[key]]);
        }
    }
    return stableHash({ completed, checkpoints: paper?.analysisStageCheckpoints || {},
        analysisCheckpoint: paper?.analysisCheckpoint || '', analysis: paper?.analysis || '',
        article: paper?.apiReaderArticle || '', drafts });
}

function failureDetails(outcome) {
    const record = outcome?.result || outcome || {};
    return {
        code: outcome?.code || record.latestAnalysisAttemptErrorCode || record.errorCode || null,
        scope: outcome?.scope || record.latestAnalysisAttemptErrorScope || record.errorScope || 'paper',
        retryable: outcome?.retryable !== false && record.latestAnalysisAttemptRetryable !== false
            && record.errorRetryable !== false,
        category: outcome?.category || record.latestAnalysisAttemptErrorCategory || record.errorCategory || null,
        status: outcome?.status || record.latestAnalysisAttemptErrorStatus || record.errorStatus || null,
        message: outcome?.error || record.latestAnalysisAttemptError || record.error || '分析失败'
    };
}

function failureError(outcome) {
    const details = failureDetails(outcome);
    return Object.assign(new Error(String(details.message)), details);
}

function integer(value, name, low, high) {
    if (!Number.isSafeInteger(value) || value < low || value > high) {
        throw new RangeError(`${name} must be an integer in ${low}..${high}`);
    }
    return value;
}

async function runFailureRounds(items, options = {}) {
    if (!Array.isArray(items)) throw new TypeError('Failure rounds require an item array');
    const { runItem, concurrency = 3, maxRounds = 3, getItemId = (item, index) =>
        String(item?.paperId || item?.arxivId || item?.id || index).replace(/^(\d{4}\.\d{4,5})v\d+$/, '$1'),
        getProgressKey = semanticAnalysisProgress, shouldStop = null, onRunStop = null,
        onRoundStart = null, onRoundDone = null, roundDelayMs = 0,
        manualHandoffMaxItems = 5, manualHandoffMinRounds = 3, manualHandoffNoProgressRounds = 3 } = options;
    if (typeof runItem !== 'function' || typeof getItemId !== 'function' || typeof getProgressKey !== 'function') {
        throw new TypeError('Failure rounds require runItem and valid identity/progress functions');
    }
    integer(concurrency, 'concurrency', 1, 1000);
    integer(maxRounds, 'maxRounds', 1, 10);
    integer(manualHandoffMaxItems, 'manualHandoffMaxItems', 0, 5);
    integer(manualHandoffMinRounds, 'manualHandoffMinRounds', 3, 10);
    integer(manualHandoffNoProgressRounds, 'manualHandoffNoProgressRounds', 3, 10);
    integer(roundDelayMs, 'roundDelayMs', 0, 60000);
    const ids = items.map(getItemId);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
        throw new Error('Failure-round item identities must be nonempty and unique');
    }
    const outcomes = new Array(items.length);
    const attempts = items.map(() => 0);
    const progress = items.map(item => ({ key: getProgressKey(item, null), noProgressRounds: 0 }));
    const rounds = [];
    const errors = [];
    let pending = items.map((_, index) => index), halted = null, notification = null;
    function halt(error) {
        if (!errors.includes(error)) errors.push(error);
        if (halted) return;
        halted = error;
        if (onRunStop) notification = Promise.resolve().then(() => onRunStop(error)).catch(halt);
    }
    async function checkStop() {
        if (halted || !shouldStop) return Boolean(halted);
        let stopped;
        try { stopped = await shouldStop(); }
        catch (error) { halt(error); return true; }
        if (halted) return true;
        if (stopped) halt(stopped instanceof Error ? stopped : Object.assign(
            new Error('已停止批次；不再派发新论文或新轮。'),
            { code: 'ANALYSIS_BATCH_STOP_REQUESTED', scope: 'run', retryable: false }));
        return Boolean(halted);
    }
    function handoff() {
        const failed = outcomes.map((outcome, index) => ({ outcome, index }))
            .filter(({ outcome }) => outcome?.success === false);
        const small = failed.length > 0 && failed.length <= manualHandoffMaxItems;
        const records = failed.map(({ outcome, index }) => {
            const details = failureDetails(outcome);
            const budgetExhausted = outcome.budgetExhausted === true
                || /(?:BUDGET|ATTEMPTS?|RETRY).*EXHAUST|READER.*NO_PROGRESS/.test(String(details.code || ''));
            return { id: ids[index], attempts: attempts[index], noProgressRounds: progress[index].noProgressRounds,
                code: details.code, scope: details.scope, retryable: details.retryable, budgetExhausted,
                eligible: small && details.scope !== 'run' && details.retryable && !budgetExhausted
                    && attempts[index] >= manualHandoffMinRounds,
                reason: details.scope === 'run' ? 'service_failure' : budgetExhausted
                    ? 'budget_exhausted_requires_controlled_correction'
                    : details.retryable === false ? 'nonretryable_failure' : 'content_retry' };
        });
        const eligible = !halted && small && records.every(record => record.eligible);
        return { contract: HANDOFF_CONTRACT, eligible, status: eligible ? 'ready' : 'not_ready',
            reason: eligible ? (records.every(record => record.noProgressRounds >= manualHandoffNoProgressRounds)
                ? 'small_stalled_failed_set' : 'small_persistently_failed_set') : halted ? 'run_stopped'
                : !small ? 'failed_set_not_small' : 'insufficient_semantic_stagnation_or_blocked_failure',
            maxItems: manualHandoffMaxItems, minRounds: manualHandoffMinRounds,
            noProgressRounds: manualHandoffNoProgressRounds, items: records,
            eligibleIds: records.filter(record => record.eligible).map(record => record.id),
            blockedIds: records.filter(record => !record.eligible).map(record => record.id),
            budgetExhaustedIds: records.filter(record => record.budgetExhausted).map(record => record.id),
            requiresControlledCorrection: true, newApiRequestsAuthorized: false };
    }
    for (let round = 1; round <= maxRounds && pending.length; round++) {
        if (await checkStop()) break;
        const input = pending.slice(), attempted = [], startedAt = Date.now();
        try {
            if (onRoundStart) await onRoundStart({ round, maxRounds, indices: input.slice(), inputIds: input.map(index => ids[index]) });
        } catch (error) { halt(error); break; }
        let cursor = 0;
        const worker = async () => {
            while (!(await checkStop())) {
                // Another worker can halt after checkStop resolves but before
                // this awaiting worker resumes. Recheck before claiming work.
                if (halted) return;
                const index = input[cursor++];
                if (index === undefined) return;
                attempted.push(index);
                const attempt = ++attempts[index];
                try {
                    const outcome = await runItem(items[index], { index, round, maxRounds, attempt });
                    if (!outcome || (typeof outcome.success !== 'boolean' && outcome.skipped !== true)) {
                        throw new Error('runItem must return an explicit success, failure or skipped outcome');
                    }
                    outcomes[index] = outcome;
                    if (outcome.success === false) {
                        const key = getProgressKey(items[index], outcome);
                        progress[index] = { key, noProgressRounds: key === progress[index].key
                            ? progress[index].noProgressRounds + 1 : 0 };
                        if (failureDetails(outcome).scope === 'run') halt(failureError(outcome));
                    }
                } catch (error) {
                    halt(error);
                    return;
                }
            }
        };
        const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, input.length) }, () => worker()));
        for (const result of settled) if (result.status === 'rejected') halt(result.reason);
        if (notification) { try { await notification; } catch (error) { halt(error); } }
        await checkStop();
        pending = input.filter(index => outcomes[index]?.success === false
            && failureDetails(outcomes[index]).retryable && failureDetails(outcomes[index]).scope !== 'run');
        const record = { round, inputIds: input.map(index => ids[index]), attemptedIds: attempted.map(index => ids[index]),
            successIds: input.filter(index => outcomes[index]?.success === true).map(index => ids[index]),
            skippedIds: input.filter(index => outcomes[index]?.skipped === true).map(index => ids[index]),
            failedIds: input.filter(index => outcomes[index]?.success === false).map(index => ids[index]),
            retryableFailedIds: pending.map(index => ids[index]),
            unstartedIds: input.filter(index => !attempted.includes(index)).map(index => ids[index]),
            noProgressById: Object.fromEntries(input.map(index => [ids[index], progress[index].noProgressRounds])),
            durationMs: Date.now() - startedAt, stopped: Boolean(halted) };
        rounds.push(record);
        const manualHandoff = handoff();
        try {
            if (onRoundDone) await onRoundDone({ ...record, maxRounds, outcomes: outcomes.slice(), manualHandoff });
        } catch (error) { halt(error); }
        if (await checkStop() || (manualHandoff.eligible
            && manualHandoff.items.every(item => item.noProgressRounds >= manualHandoffNoProgressRounds))) break;
        if (pending.length && round < maxRounds && roundDelayMs) {
            await new Promise(resolve => setTimeout(resolve, roundDelayMs));
        }
    }
    const result = { contract: CONTRACT, outcomes, rounds, stopped: Boolean(halted), manualHandoff: handoff(),
        failedIds: ids.filter((_, index) => outcomes[index]?.success === false),
        unstartedIds: ids.filter((_, index) => attempts[index] === 0),
        unfinishedIds: ids.filter((_, index) => attempts[index] > 0 && !outcomes[index]) };
    if (halted) {
        if (notification) { try { await notification; } catch (error) { halt(error); } }
        if (errors.length > 1) {
            const primary = errors.find(error => error.scope !== 'run') || errors[0];
            const actualFailures = errors.filter(error => !['ANALYSIS_STOP_REQUESTED',
                'ANALYSIS_BATCH_STOP_REQUESTED'].includes(error.code));
            if (actualFailures.length === 1) {
                // A cooperative stop is context, not a second storage/service failure.
                halted = actualFailures[0];
                halted.errors = errors.slice();
            } else halted = Object.assign(new AggregateError(errors, primary.message, { cause: primary }), {
                code: primary.code, scope: 'run', category: primary.category,
                status: primary.status, retryable: false
            });
        }
        Object.assign(halted, { outcomes, rounds, stopped: true, manualHandoff: result.manualHandoff,
            failedIds: result.failedIds, unstartedIds: result.unstartedIds });
        halted.unfinishedIds = result.unfinishedIds;
        throw halted;
    }
    return result;
}

module.exports = { CONTRACT, HANDOFF_CONTRACT, runFailureRounds, semanticAnalysisProgress, failureDetails };
