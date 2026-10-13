'use strict';
function completedReaderUpstream(paper, source) {
    const engine = require('../analysis-engine'), contract = require('../analysis-contract');
    const stages = paper?.analysisManifest?.stages;
    if (!stages || stages.primaryAnalysis?.status !== 'complete' || !engine.hasValidAnalysisBody(paper)
        || contract.REQUIRED_RECOVERY_STAGES.some(stage => !['apiReaderArticle', 'apiReaderTableAudit', 'imageSupplement', 'imageDownload'].includes(stage)
            && !contract.isRecoveryStageTerminal(stage, stages[stage]?.status))
        || contract.validateTagStageProof(paper, { parsed: require('../utils').parseAnalysis(paper.analysis) })
        || contract.validateCoreSummaryStageBinding(paper)
        || stages.scoringAudit?.scoringContract !== 'api-scoring-audit-v2'
        || !engine.scoringAuditBindsFinalAnalysis(paper) || !engine.scoringStabilityIsResolved(stages.scoringAudit)) return false;
    if (!source || !require('./model-text-sanitization').canReuseModelTextInputs(paper, source)) return false;
    const hash = require('node:crypto').createHash('sha256').update(source.text).digest('hex');
    if (hash !== paper.sourceSha256 || hash !== paper.analysisManifest.sourceAcquisition?.sourceSha256) return false;
    require('./fresh-analysis-context').assertFreshPaper(paper);
    const facts = require('./daily-fact-review');
    for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit']) {
        const saved = stages[stage], current = facts.fingerprintFields(stage, saved);
        for (const field of ['factReview', 'scoringFactReview'])
            if (!require('node:util').isDeepStrictEqual(saved?.[field], current[field])) return false;
    }
    facts.validateRepairedClaims('primaryAnalysis', paper.analysis, require('../utils').normalizedId(paper));
    facts.validateRepairedClaims('coreSummaryRepair', paper.analysis, require('../utils').normalizedId(paper));
    return true;
}
module.exports = { completedReaderUpstream };
