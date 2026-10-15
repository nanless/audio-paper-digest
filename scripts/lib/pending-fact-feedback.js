'use strict';
// A pending correction is an obligation, never publishability or request credit.
const fs = require('node:fs');
const path = require('node:path');
const daily = require('./daily-fresh-source-plan');
const facts = require('./daily-fact-review');
const FIELD = 'analysisFactReviewObligation';
function planFor(paper) {
    const runId = paper?.freshRewriteProvenance?.runId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId || '')) {
        throw new Error('未完成事实反馈缺少真实日更来源身份');
    }
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, runId);
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    return daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
}
function read(paper, plan) {
    if (!Object.hasOwn(paper || {}, FIELD)) return null;
    plan ||= planFor(paper);
    const proof = facts.validateProof(paper[FIELD]);
    const feedback = facts.readFeedback(path.join(daily.factFeedbackDirectory(plan), proof.feedbackSha256 + '.json'));
    const bound = facts.validateFeedback(feedback, plan, paper);
    if (daily.stableHash(bound.proof) !== daily.stableHash(proof)) throw new Error('未完成事实反馈与原始严格反馈证明不一致');
    return { feedback, proof: bound.proof, plan };
}
function completed(paper, plan) {
    if (!Object.hasOwn(paper || {}, FIELD)) return true;
    try {
        const pending = read(paper, plan);
        return require('./completed-bound-fact-feedback').hasCompletedBoundFactFeedbackStages(
            paper, pending.feedback, pending.plan);
    } catch (_) { return false; }
}
function register(paper, plan, feedback) {
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('持久化事实反馈义务须持有论文锁');
    const bound = facts.validateFeedback(feedback, plan, paper);
    if (Object.hasOwn(paper, FIELD) && daily.stableHash(paper[FIELD]) !== daily.stableHash(bound.proof)
        && !completed(paper, plan)) throw new Error('不能用新反馈覆盖尚未完成的原事实反馈义务');
    // Stores the actual packet through its existing verified mechanism first.
    try { facts.withFactReview(bound, () => undefined); }
    catch (error) {
        // New persistence boundary: retain the original error and stop dispatch.
        error.scope = 'run'; error.retryable = false;
        error.code ||= 'FACT_FEEDBACK_SAVE_FAILED';
        throw error;
    }
    paper[FIELD] = structuredClone(bound.proof);
    const checkpoint = paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')];
    if (typeof checkpoint === 'function') checkpoint(paper);
    return bound;
}
module.exports = { FIELD, read, completed, register };
