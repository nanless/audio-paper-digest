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
module.exports = { hasSavedProof, readSavedFeedback };
