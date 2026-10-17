'use strict';
// Diagnostic preparation from the actual normal-loop state, never a success,
// candidate-selection proof or additional request allowance.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const localOnly = new AsyncLocalStorage();
function withReaderLocalRequestsOnly(callback) {
    if (typeof callback !== 'function') throw new TypeError('Reader local-only scope requires a callback');
    return localOnly.run(true, callback);
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
// Keep routing logs bounded, including when issue payloads contain source excerpts.
// Prefer blocking issues and report the exact full-list count/hash and omissions.
function issueProjection(issues) {
    const all = Array.isArray(issues) ? issues : [];
    const sha = value => createHash('sha256').update(value).digest('hex');
    const ranked = all.map((issue, index) => ({ issue, index }))
        .sort((a, b) => Number(a.issue?.diagnosticOnly === true) - Number(b.issue?.diagnosticOnly === true));
    const selected = ranked.slice(0, 128);
    return {
        issueCount: all.length,
        blockingIssueCount: all.filter(issue => issue?.diagnosticOnly !== true).length,
        issuesSha256: sha(JSON.stringify(all)),
        issueProjectionOmitted: all.length - selected.length,
        issues: selected.map(({ issue, index }) => {
            const message = String(issue?.message || '');
            return { index, path: issue?.path == null ? null : String(issue.path).slice(0, 256),
                code: String(issue?.code || '').slice(0, 96), diagnosticOnly: issue?.diagnosticOnly === true,
                message: message.slice(0, 512), messageChars: message.length, messageSha256: sha(message) };
        })
    };
}
function buildReaderNextRequestPlan(state) {
    const { attempts, fullAttempts, transportFailures, noProgress, validationFailureStreak,
        attemptLimit, maxFullResponses, changedValidationWithinOriginalBudget, repairContext } = state;
    for (const [key, value] of Object.entries({ attempts, fullAttempts, transportFailures, noProgress,
        validationFailureStreak, attemptLimit, maxFullResponses })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid Reader planning counter: ${key}`);
    }
    const budgetStop = state.budgetOnly === true;
    const nextKind = budgetStop ? 'none' : repairContext ? 'patch' : 'full';
    const remainingResponses = Math.max(0, attemptLimit - attempts);
    const remainingFullResponses = Math.max(0, maxFullResponses - fullAttempts);
    let blocker = null;
    // Only the pre-loop budget gate applies loaded no-progress state. The normal
    // loop retains its original post-response no-progress guards and priorities.
    if (budgetStop && (!remainingResponses || !changedValidationWithinOriginalBudget
        && (noProgress >= 2 || validationFailureStreak >= 2))) {
        blocker = { code: 'READER_REPAIR_ATTEMPTS_EXHAUSTED',
            reason: !remainingResponses ? 'content_response_limit' : 'unchanged_validation_failure',
            message: '长文草稿的修复次数已用完或连续未改善，已保留恢复记录；继续前须处理失败原因。' };
    } else if (nextKind === 'full' && !remainingFullResponses) {
        blocker = { code: 'READER_FULL_ATTEMPTS_EXHAUSTED', reason: 'full_response_limit',
            message: '长文全文生成次数已用完，现有草稿尚不能按当前允许范围修复；已保留失败记录。' };
    } else if (nextKind === 'full' && localOnly.getStore() === true) {
        blocker = { code: 'READER_FULL_REQUEST_FORBIDDEN', reason: 'local_only_scope',
            message: '当前恢复范围只允许原余额内的局部修复；实际准备将请求全文，已在提示词、用量记录和传输前停止。' };
    }
    return freeze({ contract: 'reader-next-request-plan-v1', notFinalPreflight: true,
        notRequestAuthorization: true, paperId: state.paperId,
        identitySha256: state.identitySha256, candidateSha256: state.candidateSha256 || null,
        phase: budgetStop ? 'budget_stop' : state.phase || 'prepared_route',
        action: blocker ? 'blocked' : budgetStop ? 'inspect' : 'request', nextKind,
        nextContentAttempt: budgetStop ? null : state.nextContentAttempt,
        attempts, fullAttempts, transportFailures, noProgress, validationFailureStreak,
        recoveredAttempts: state.recoveredAttempts ?? attempts,
        attemptLimit, maxFullResponses, remainingResponses, remainingFullResponses,
        permittedFullResponses: localOnly.getStore() === true ? 0 : remainingFullResponses,
        localOnly: localOnly.getStore() === true,
        sourceBindingNeedsFullRetry: state.sourceBindingNeedsFullRetry === true,
        // Diagnostics must leave malformed targets to the existing safety gate,
        // preserving its original error code and zero-request behavior.
        repairTargets: (repairContext?.targets || []).map(target => ({ path: target?.path, oldSha256: target?.oldSha256 })),
        atomicOperation: repairContext?.atomicOperation?.kind || null,
        ...issueProjection(state.issues), blocker });
}
module.exports = { buildReaderNextRequestPlan, withReaderLocalRequestsOnly };
