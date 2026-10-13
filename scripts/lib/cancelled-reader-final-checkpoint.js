'use strict';
function reusableFinalCheckpoint(paper) {
    const failure = String(paper?.latestAnalysisAttemptError || '');
    const match = failure.match(/^深度分析阶段未完成: apiReaderTableAudit:(contract_rejected|invalid_output|transient_failure|complete)$/);
    if (!match || typeof paper.analysisCheckpoint !== 'string' || !paper.analysisCheckpoint.trim()) return null;
    if (paper.error && paper.error !== failure) return null;
    const stage = paper.analysisManifest?.stages?.apiReaderTableAudit;
    if (stage?.contract !== 'reader-table-semantic-audit-v1' || stage.status !== match[1]) return null;
    const contract = require('../analysis-contract');
    if (paper.fullStageReanalysis) require('./selected-full-stage-reanalysis').fingerprintFields(paper);
    if (Object.entries(paper.analysisManifest.stages).some(([name, value]) => name !== 'apiReaderTableAudit'
        && !contract.isRecoveryStageTerminal(name, value?.status))) return null;
    const candidate = { ...paper, analysis: paper.analysisCheckpoint, parsed: require('../utils').parseAnalysis(paper.analysisCheckpoint) };
    delete candidate.error;
    const engine = require('../analysis-engine');
    if (engine.getIncompleteAnalysisContentReason(candidate) !== null) return null;
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!context) return null;
    fresh.assertFreshPaper(candidate);
    const source = fresh.readFreshSource(context.runDir, candidate, context);
    if (!require('./completed-reader-upstream').completedReaderUpstream(candidate, source)) return null;
    const facts = require('./daily-fact-review'), daily = require('./daily-fresh-source-plan');
    const saved = candidate.analysisManifest.stages.apiReaderArticle;
    const expected = facts.fingerprintFields('apiReaderArticle', saved);
    for (const key of ['factReview', 'scoringFactReview', 'restoredReaderConstraints'])
        if (daily.stableHash(saved[key] || null) !== daily.stableHash(expected[key] || null)) return null;
    facts.validateRepairedClaims('apiReaderArticle', candidate.apiReaderArticle, require('../utils').normalizedId(candidate));
    return candidate;
}
module.exports = { reusableFinalCheckpoint };
