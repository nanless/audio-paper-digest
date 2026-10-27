'use strict';

// A proof check only: this does not grant requests, alter attempts or repair a
// saved stage. The caller still checks its source, input and stage bindings.
const SCORING_STABILITY_RESOLUTION_CONTRACT = 'api-scoring-stability-resolution-v1';
const SCORING_STABILITY_CONSENSUS_TOLERANCE = 0.3;
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Only the threshold comparison absorbs binary subtraction error. Keep the
// original scores/difference in the proof; an over-threshold exception must be
// the exact subtraction of valid 0..10 scores, within one operand-scale epsilon.
function scoringDifferenceWithinTolerance(difference, firstScore, secondScore) {
    if (!Number.isFinite(difference) || difference < 0) return false;
    if (difference <= SCORING_STABILITY_CONSENSUS_TOLERANCE) return true;
    return [firstScore, secondScore].every(score => Number.isFinite(score) && score >= 0 && score <= 10)
        && difference === Math.abs(secondScore - firstScore)
        && difference - SCORING_STABILITY_CONSENSUS_TOLERANCE
            <= Number.EPSILON * Math.max(1, Math.abs(firstScore), Math.abs(secondScore));
}

function scoringStabilityIsResolved(stage) {
    if (stage?.stabilityWarning !== true) return true;
    const resolution = stage.stabilityResolution;
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return false;
    const multiPass = resolution.method === 'multi_pass_consensus';
    if (resolution.contract !== SCORING_STABILITY_RESOLUTION_CONTRACT
        || resolution.status !== 'resolved'
        || !(resolution.method === 'second_pass_consensus' || multiPass)
        || !['firstAuditScore', 'secondAuditScore', 'scoreDifference']
            .every(field => Number.isFinite(resolution[field]))
        || !scoringDifferenceWithinTolerance(resolution.scoreDifference,
            resolution.firstAuditScore, resolution.secondAuditScore)
        || !validSha(resolution.secondAuditSha256)) return false;
    // Old second-pass proofs did not carry the third-pass selection fields.
    if (!multiPass) return true;
    return Number.isFinite(resolution.thirdAuditScore)
        && Number.isSafeInteger(resolution.thirdAttempts) && resolution.thirdAttempts >= 1
        && validSha(resolution.firstAuditSha256) && validSha(resolution.thirdAuditSha256)
        // A resolved third pass necessarily selects a pair ending in that pass.
        && resolution.secondAuditScore === resolution.thirdAuditScore
        && resolution.secondAuditSha256 === resolution.thirdAuditSha256
        && stage.auditSha256 === resolution.secondAuditSha256
        && Number.isFinite(stage.finalScore)
        && Math.abs(stage.finalScore - resolution.secondAuditScore) < 1e-9
        && Math.abs(Math.abs(resolution.secondAuditScore - resolution.firstAuditScore)
            - resolution.scoreDifference) < 1e-9;
}

module.exports = { scoringStabilityIsResolved, scoringDifferenceWithinTolerance,
    SCORING_STABILITY_RESOLUTION_CONTRACT,
    SCORING_STABILITY_CONSENSUS_TOLERANCE };
