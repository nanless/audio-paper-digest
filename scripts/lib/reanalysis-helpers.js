'use strict';

// 指定论文重分析时，清理 Reader 状态并更新恢复统计。
const { normalizedId, SCORING_RUBRIC_VERSION } = require('../utils.js');

// 数组格式是旧版分析结果；对象格式才是当前正式文件。两种格式都在更新回调里被
// 支持，所以读取阶段不能只取 data.papers，否则旧格式会被当成 0 篇而静默跳过。
function papersFromAnalysisData(data) {
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.papers) ? data.papers : [];
}

// --concurrency 与 PD_REANALYZE_CONCURRENCY 都只接受十进制正整数。以前
// parseInt 会把 2.5 截成 2、把无效环境变量静默换成配置默认值；这里提前拒绝，
// 不让一个写错的并发配置在运行中变成另一种行为。
function parseReanalyzeConcurrency({ cliValue, envValue, fallback }) {
    const hasCli = cliValue !== undefined && cliValue !== null;
    const hasEnv = envValue !== undefined && envValue !== null && String(envValue).trim() !== '';
    const raw = hasCli ? String(cliValue) : hasEnv ? String(envValue).trim() : null;
    if (raw === null) return fallback;
    const source = hasCli ? '--concurrency' : 'PD_REANALYZE_CONCURRENCY';
    if (!/^\d+$/.test(raw)) {
        throw new Error(`--concurrency / PD_REANALYZE_CONCURRENCY 必须是正整数（来源 ${source}，收到 ${JSON.stringify(raw)}）`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`--concurrency / PD_REANALYZE_CONCURRENCY 必须是正整数（来源 ${source}，收到 ${JSON.stringify(raw)}）`);
    }
    return value;
}

function resetReaderForSelectedReanalysis(paper) {
    const next = structuredClone(paper);
    // 先登记序号完成证明被本次重做接替，再删 Reader 阶段；否则下一次初始化会
    // 把“阶段被清掉”误判成手工删标记，无法重新生成全文。
    require('./reader-target-ordinal-patch').supersedeOrdinalCompletionBeforeReset(next);
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

// 强制全量重分析只替换 Reader 与图片补充状态，保留主文与评分让分析器重新生成。
// 与选定重分析一样，清阶段前必须先把序号完成证明登记为接替历史；否则下一次
// Reader 初始化会把“阶段被清掉”误判成手工删标记，整篇无法重新生成全文。
function resetReaderForForcedReanalysis(paper) {
    const next = structuredClone(paper);
    require('./reader-target-ordinal-patch').supersedeOrdinalCompletionBeforeReset(next);
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
    for (const key of ['apiReaderArticle', 'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors',
        'apiReaderResources', 'apiReaderArticleSha256', 'apiReaderPlanSha256']) delete next[key];
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

module.exports = {
    papersFromAnalysisData,
    parseReanalyzeConcurrency,
    resetReaderForSelectedReanalysis,
    resetReaderForForcedReanalysis,
    updateReanalysisStats
};
