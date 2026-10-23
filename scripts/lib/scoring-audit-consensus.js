'use strict';

const { SCORING_STABILITY_RESOLUTION_CONTRACT,
    SCORING_STABILITY_CONSENSUS_TOLERANCE } = require('./scoring-stability');

const SCORING_STABILITY_THRESHOLD = 0.5;

// Both normal analysis and scoring maintenance use this scheduling rule. The
// caller supplies the original, guarded audit operation and validates every
// response against its own real source and feedback before returning a score.
async function runScoringAuditConsensus({ firstResult, firstScore, requiresConsensus,
    auditAgain, scoreOfResult, fingerprintAudit, onPass = () => {} }) {
    if (!Number.isFinite(firstScore) || typeof requiresConsensus !== 'boolean'
        || typeof auditAgain !== 'function' || typeof scoreOfResult !== 'function'
        || typeof fingerprintAudit !== 'function' || typeof onPass !== 'function') {
        throw new TypeError('评分共识需要已核验分数、原审计器及来源校验器');
    }
    let totalAttempts = firstResult.attempts;
    let resolution = { contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
        status: 'not_required', threshold: SCORING_STABILITY_THRESHOLD };
    if (!requiresConsensus) return { result: firstResult, totalAttempts, resolution };

    onPass(2, { firstScore });
    const secondResult = await auditAgain();
    totalAttempts += secondResult.attempts;
    const secondScore = scoreOfResult(secondResult);
    if (!Number.isFinite(secondScore)) throw new Error('评分共识的第二次审计分数无效');
    const difference = Math.abs(secondScore - firstScore);
    resolution = { contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
        status: difference <= SCORING_STABILITY_CONSENSUS_TOLERANCE ? 'resolved' : 'unresolved',
        method: 'second_pass_consensus', threshold: SCORING_STABILITY_THRESHOLD,
        consensusTolerance: SCORING_STABILITY_CONSENSUS_TOLERANCE,
        firstAuditScore: firstScore, secondAuditScore: secondScore, scoreDifference: difference,
        firstAuditSha256: fingerprintAudit(firstResult.audit),
        secondAuditSha256: fingerprintAudit(secondResult.audit), secondAttempts: secondResult.attempts };
    if (resolution.status === 'resolved') return { result: secondResult, totalAttempts, resolution };

    onPass(3, { firstScore, secondScore });
    const thirdResult = await auditAgain();
    totalAttempts += thirdResult.attempts;
    const thirdScore = scoreOfResult(thirdResult);
    if (!Number.isFinite(thirdScore)) throw new Error('评分共识的第三次审计分数无效');
    const pairs = [
        { leftScore: firstScore, rightScore: secondScore, left: firstResult, right: secondResult },
        { leftScore: firstScore, rightScore: thirdScore, left: firstResult, right: thirdResult },
        { leftScore: secondScore, rightScore: thirdScore, left: secondResult, right: thirdResult }
    ].map(pair => ({ ...pair, difference: Math.abs(pair.rightScore - pair.leftScore) }))
        .sort((left, right) => left.difference - right.difference);
    const consensus = pairs[0];
    resolution = { ...resolution, method: 'multi_pass_consensus',
        status: consensus.difference <= SCORING_STABILITY_CONSENSUS_TOLERANCE ? 'resolved' : 'unresolved',
        firstAuditScore: consensus.leftScore, secondAuditScore: consensus.rightScore,
        scoreDifference: consensus.difference,
        firstAuditSha256: fingerprintAudit(consensus.left.audit),
        secondAuditSha256: fingerprintAudit(consensus.right.audit),
        thirdAuditScore: thirdScore, thirdAuditSha256: fingerprintAudit(thirdResult.audit),
        thirdAttempts: thirdResult.attempts };
    if (resolution.status !== 'resolved') {
        const error = new Error(`三次评分中最接近的两次仍超过允许差异: first=${firstScore.toFixed(1)}, `
            + `second=${secondScore.toFixed(1)}, third=${thirdScore.toFixed(1)}, `
            + `bestDifference=${consensus.difference.toFixed(1)}`);
        error.code = 'CONTRACT_REJECTED';
        error.stabilityResolution = resolution;
        throw error;
    }
    return { result: consensus.right, totalAttempts, resolution };
}

module.exports = { runScoringAuditConsensus, SCORING_STABILITY_THRESHOLD };
