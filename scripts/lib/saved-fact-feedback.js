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
    if (hashes.length !== 1 || !/^[a-f0-9]{64}$/.test(hashes[0])) return null;
    const filename = path.join(daily.factFeedbackDirectory(plan), hashes[0] + '.json');
    if (!fs.existsSync(filename)) return null;
    for (const proof of proofs) facts.validateProof(proof);
    const feedback = facts.readFeedback(filename);
    const proof = facts.proofFor(feedback);
    if (proofs.some(saved => daily.stableHash(saved) !== daily.stableHash(proof))) {
        throw new Error('之前的纠错说明与保存的证明不一致');
    }
    facts.validateFeedback(feedback, plan, paper);
    return feedback;
}
module.exports = { hasSavedProof, readSavedFeedback };
