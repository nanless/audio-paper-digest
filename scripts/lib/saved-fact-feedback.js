'use strict';
const fs = require('node:fs');
const path = require('node:path');
const facts = require('./daily-fact-review');
const daily = require('./daily-fresh-source-plan');
function savedProofs(paper) {
    return [...Object.values(paper?.analysisManifest?.stages || {}).flatMap(stage =>
        [stage?.factReview, stage?.scoringFactReview].filter(Boolean)),
        ...(paper?.fullStageReanalysis?.currentFeedbackProof ? [paper.fullStageReanalysis.currentFeedbackProof] : [])];
}
function hasSavedProof(paper) { return savedProofs(paper).length > 0; }
function readSavedFeedback(paper, plan) {
    const proofs = savedProofs(paper);
    if (!proofs.length) return null;
    const hashes = [...new Set(proofs.map(proof => proof.feedbackSha256))];
    // 不把多阶段不同的纠错说明合成一份，也不扩大任何旧阶段的授权。
    if (hashes.length !== 1) return readSavedCoreFeedback(paper, plan, proofs);
    if (!/^[a-f0-9]{64}$/.test(hashes[0])) return null;
    const filename = path.join(daily.factFeedbackDirectory(plan), hashes[0] + '.json');
    if (!fs.existsSync(filename)) return null;
    for (const proof of proofs) facts.validateProof(proof);
    const feedback = facts.readFeedback(filename);
    const proof = facts.proofFor(feedback);
    if (proofs.some(saved => daily.stableHash(saved) !== daily.stableHash(proof))) {
        throw new Error('之前的纠错说明与保存的证明不一致');
    }
    facts.validateFeedback(feedback, plan, paper);
    return { feedback, paper };
}
function readSavedCoreFeedback(paper, plan, proofs) {
    const record = paper.fullStageReanalysis;
    const parentProof = record?.currentFeedbackProof;
    const coreProof = paper.analysisManifest?.stages?.coreSummaryRepair?.factReview;
    if (!parentProof || !coreProof || parentProof.feedbackSha256 === coreProof.feedbackSha256
        || proofs.some(proof => ![parentProof.feedbackSha256, coreProof.feedbackSha256].includes(proof.feedbackSha256))) return null;
    for (const [stage, value] of Object.entries(paper.analysisManifest?.stages || {})) {
        for (const proof of [value?.factReview, value?.scoringFactReview].filter(Boolean)) {
            if (proof.feedbackSha256 === coreProof.feedbackSha256 && stage !== 'coreSummaryRepair') return null;
        }
    }
    // 原全阶段档案的身份和费用必须先经过已有完整核验。
    require('./selected-full-stage-reanalysis').fingerprintFields(paper);
    const original = paper.fullStageReanalysisHistory.find(item => item.runId === record.runId).originalPaper;
    const inherited = record.inheritedFeedbacks.find(item => item.proof.feedbackSha256 === parentProof.feedbackSha256);
    const filename = path.join(daily.factFeedbackDirectory(plan), coreProof.feedbackSha256 + '.json');
    if (!inherited || !fs.existsSync(filename)) return null;
    const coreFeedback = facts.readFeedback(filename);
    const parentBound = facts.validateFeedback(inherited.feedback, plan, original);
    const coreBound = facts.validateFeedback(coreFeedback, plan, paper);
    for (const proof of proofs) facts.validateProof(proof);
    if (proofs.some(proof => daily.stableHash(proof) !== daily.stableHash(
        proof.feedbackSha256 === coreProof.feedbackSha256 ? coreBound.proof : parentBound.proof))) throw new Error('原全阶段说明或摘要纠错说明与保存证明不同');
    if (!coreFeedback.coreFeedback.trim()
        || ['primaryFeedback', 'readerFeedback', 'tagFeedback', 'scoringFeedback'].some(key => String(coreFeedback[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedReaderClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].some(key => (coreFeedback[key] || []).length)) return null;
    return { feedback: inherited.feedback, paper: original, coreFeedback };
}
function withRecoveredFeedback(paper, plan, callback, explicitFeedback = null) {
    const original = explicitFeedback ? { feedback: explicitFeedback, paper } : readSavedFeedback(paper, plan);
    if (!original) {
        if (hasSavedProof(paper)) throw new Error('缺少之前的纠错说明，保留未完成记录');
        return callback();
    }
    const bound = facts.validateFeedback(original.feedback, plan, original.paper);
    return facts.withFactReview(bound, () => original.coreFeedback
        ? facts.withCoreSummaryFactReview(facts.validateFeedback(original.coreFeedback, plan, paper), paper, callback)
        : callback());
}
function readerOnlyFeedback(feedback) {
    return Boolean(feedback?.readerFeedback?.trim())
        && ['primaryFeedback', 'coreFeedback', 'tagFeedback', 'scoringFeedback'].every(key => !String(feedback[key] || '').trim())
        && ['rejectedPrimaryClaims', 'rejectedCoreClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].every(key => !(feedback[key] || []).length);
}
function completedReaderUpstream(paper, plan) {
    const engine = require('../analysis-engine'), contract = require('../analysis-contract');
    const stages = paper?.analysisManifest?.stages;
    if (!stages || stages.primaryAnalysis?.status !== 'complete'
        || !daily.isPaperBoundToPlan(paper, plan) || !engine.hasValidAnalysisBody(paper)
        || contract.REQUIRED_RECOVERY_STAGES.some(stage => !['apiReaderArticle', 'apiReaderTableAudit', 'imageSupplement'].includes(stage)
            && !contract.isRecoveryStageTerminal(stage, stages[stage]?.status))
        || contract.validateTagStageProof(paper, { parsed: require('../utils').parseAnalysis(paper.analysis) })
        || contract.validateCoreSummaryStageBinding(paper)) return false;
    return stages.scoringAudit?.scoringContract === 'api-scoring-audit-v2'
        && engine.scoringAuditBindsFinalAnalysis(paper) && engine.scoringStabilityIsResolved(stages.scoringAudit);
}
function protectedReaderUpstream(paper) {
    const copy = structuredClone(paper);
    for (const key of Object.keys(copy)) if (/^apiReader/.test(key)) delete copy[key];
    for (const key of Object.keys(copy.analysisManifest?.contracts || {}))
        if (/^apiReader/.test(key)) delete copy.analysisManifest.contracts[key];
    delete copy.analysisManifest?.stages?.apiReaderArticle;
    delete copy.analysisManifest?.stages?.apiReaderTableAudit;
    delete copy.analysisManifest?.stages?.imageSupplement;
    if (copy.analysisStageCheckpoints) delete copy.analysisStageCheckpoints.apiReaderArticle;
    return copy;
}
function analyzeWithRecoveredFeedback(paper, plan, analyze, explicitFeedback = null, options = {}) {
    return require('./fresh-analysis-context').withFreshPaperContext(paper, () =>
        analyzeWithRecoveredFeedbackInternal(paper, plan, analyze, explicitFeedback, options));
}
async function analyzeWithRecoveredFeedbackInternal(paper, plan, analyze, explicitFeedback, options) {
    const original = explicitFeedback ? null : readSavedFeedback(paper, plan);
    const feedback = explicitFeedback || original?.feedback;
    if (!readerOnlyFeedback(feedback))
        return withRecoveredFeedback(paper, plan, analyze, explicitFeedback);
    if (!completedReaderUpstream(paper, plan)) {
        const error = new Error('独立Reader纠错缺少已完成的主文、摘要或评分');
        error.code = 'READER_UPSTREAM_INCOMPLETE'; error.retryable = false; throw error;
    }
    const engine = require('../analysis-engine');
    if (!engine.paperAnalysisLockHeld(paper)) throw new Error('Reader纠错须持有当前论文锁');
    const parent = explicitFeedback ? readSavedFeedback(paper, plan) : original;
    if (!parent && hasSavedProof(paper)) {
        const error = new Error('缺少之前的纠错说明，保留未完成记录');
        error.code = 'READER_PARENT_FEEDBACK_MISSING'; error.retryable = false; throw error;
    }
    const bound = facts.validateFeedback(feedback, plan, paper);
    const refresh = () => facts.withReaderFactReview(bound, paper, async () => {
        facts.withFactReview(bound, () => undefined);
        const target = structuredClone(paper);
        require('../deep-analyzer').captureStaleAnalysisSnapshot(target, target.analysisManifest,
            'apiReaderArticle', bound.proof.feedbackSha256);
        const before = protectedReaderUpstream(target);
        const fresh = require('./fresh-analysis-context');
        const source = require('./model-text-sanitization').currentModelInputSource(paper);
        if (!source) throw new Error('Reader纠错缺少当前已核验封存来源');
        const result = await fresh.withFreshPaperContext(target, () =>
            require('./llm-usage').withLlmUsageContext({ paperId: feedback.paperId }, () =>
                require('../deep-analyzer').refreshApiReaderArticleFromSource(target, source, {
                    reviewFeedback: facts.reviewFeedback('apiReaderArticle', feedback.paperId),
                    naturalResourceProse: options.naturalResourceProse === true
                })));
        if (daily.stableHash(protectedReaderUpstream(result)) !== daily.stableHash(before)) {
            const error = new Error('独立Reader纠错改变了原主文、摘要、评分、阶段或费用历史');
            error.code = 'READER_RETURN_PROTECTION_REJECTED'; error.retryable = false; throw error;
        }
        return result;
    });
    if (!parent) return refresh();
    const parentBound = facts.validateFeedback(parent.feedback, plan, parent.paper);
    // 原摘要包已独立验证，本次只读取其已完成产物，不进入摘要修改作用域。
    return facts.withFactReview(parentBound, refresh);
}
module.exports = { hasSavedProof, readSavedFeedback, withRecoveredFeedback,
    readerOnlyFeedback, completedReaderUpstream, analyzeWithRecoveredFeedback };
