'use strict';

// 指定论文重分析时，清理 Reader 状态并更新恢复统计。
const { normalizedId, SCORING_RUBRIC_VERSION } = require('../utils.js');

function resetReaderForSelectedReanalysis(paper) {
    const next = structuredClone(paper);
    const manifest = next.analysisManifest;
    if (manifest?.stages) {
        delete manifest.stages.apiReaderArticle;
        delete manifest.stages.imageSupplement;
    }
    if (manifest?.contracts) {
        delete manifest.contracts.apiReaderArticle;
        delete manifest.contracts.imageNarrative;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (next.analysisStageCheckpoints) {
        delete next.analysisStageCheckpoints.apiReaderArticle;
        delete next.analysisStageCheckpoints.imageSupplement;
    }
    for (const key of ['analysis', 'parsed', 'error', 'apiReaderArticle', 'apiReaderPlan',
        'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources', 'apiReaderArticleSha256',
        'apiReaderPlanSha256']) delete next[key];
    return next;
}

function updateReanalysisStats(data, analyzedResults, previousCurrentRubricIds, runStats, updatedAt) {
    const recoveredCount = analyzedResults.filter(result => {
        const key = normalizedId(result);
        return key && !previousCurrentRubricIds.has(key)
            && result.parsed?.scoringRubricVersion === SCORING_RUBRIC_VERSION;
    }).length;

    data.stats = { ...(data.stats || {}) };
    if (Number.isFinite(Number(data.stats.reanalyzed))) {
        data.stats.reanalyzed = Math.min(
            Array.isArray(data.papers) ? data.papers.length : Number.MAX_SAFE_INTEGER,
            Number(data.stats.reanalyzed) + recoveredCount
        );
    }
    if (Number.isFinite(Number(data.stats.reanalyzeFailed))) {
        data.stats.reanalyzeFailed = Math.max(0, Number(data.stats.reanalyzeFailed) - recoveredCount);
    }
    data.stats.reanalyzeAt = updatedAt;
    data.stats.selectedReanalyzed = runStats.success;
    data.stats.selectedReanalyzeFailed = runStats.failed;
    data.stats.selectedReanalyzeAt = updatedAt;
    return recoveredCount;
}

module.exports = { resetReaderForSelectedReanalysis, updateReanalysisStats };
