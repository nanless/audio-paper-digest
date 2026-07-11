#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 重新分析指定论文
 * 用法: node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...
 */

const {
    getBeijingISOString,
    normalizedId,
    SCORING_RUBRIC_VERSION
} = require('./utils.js');
const {
    analyzeBatch,
    readJsonFileStrict,
    updateJsonFileLocked,
    mergePapersById,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');
const Config = require('./config.js');

const RESULT_FILE = Config.FILES.deepAnalysisResult;

function inferBatchDate(data, papers) {
    return data.batchDate
        || papers.map(p => p.digestStatus?.batchDate || String(p.fetchedAt || '').slice(0, 10)).find(Boolean)
        || String(data.timestamp || data.lastUpdated || getBeijingISOString()).slice(0, 10);
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

async function reanalyzeSelected(ids) {
    console.log(`=== 重新分析 ${ids.length} 篇论文 ===\n`);

    const data = readJsonFileStrict(RESULT_FILE);

    const papers = data.papers || [];
    const batchDate = inferBatchDate(data, papers);
    const previousCurrentRubricIds = new Set(papers
        .filter(p => p.parsed?.scoringRubricVersion === SCORING_RUBRIC_VERSION
            || p.scoringRubricVersion === SCORING_RUBRIC_VERSION)
        .map(normalizedId)
        .filter(Boolean));

    // 找到目标论文，清除旧的 analysis
    const toReanalyze = [];
    const idSet = new Set(ids.map(id => normalizedId(id)));

    for (const p of papers) {
        const aid = normalizedId(p);
        if (idSet.has(aid)) {
            // 清除旧分析结果但保留论文基本信息
            const cleanPaper = {
                ...p,
                analysis: undefined,
                parsed: undefined,
                error: undefined
            };
            delete cleanPaper.analysis;
            delete cleanPaper.parsed;
            delete cleanPaper.error;
            toReanalyze.push(cleanPaper);
        }
    }
    const foundIds = new Set(toReanalyze.map(normalizedId).filter(Boolean));
    const missingIds = [...idSet].filter(id => !foundIds.has(id));
    if (missingIds.length > 0) {
        console.error(`⚠️ 结果文件中缺少 ${missingIds.length} 个请求 ID: ${missingIds.join(', ')}`);
    }

    if (toReanalyze.length === 0) {
        console.log('⚠️ 没有找到需要重跑的论文');
        return { status: 'failed', exitCode: 1, success: 0, failed: ids.length };
    }

    console.log(`找到 ${toReanalyze.length} 篇需要重跑的论文:`);
    for (const p of toReanalyze) {
        console.log(`  - ${p.arxivId}: ${p.title?.substring(0, 60)}...`);
    }
    console.log();

    updateJsonFileLocked(RESULT_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            lastUpdated: getBeijingISOString(),
            batchDate,
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), selectedReanalyzeStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    // 重新分析
    const analyzedResults = [];
    const attemptResults = [];
    const { stats } = await analyzeBatch(toReanalyze, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 0,
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${total}] ▶ 开始: ${paper.title?.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '[N/A]';
                console.log(`  [${idx + 1}/${total}] ✅ 完成 ${score} | ${durSec}s`);
                analyzedResults.push(result.result);
                attemptResults.push(result.result);
            } else {
                console.log(`  [${idx + 1}/${total}] ❌ 失败 | ${durSec}s | ${result.error}`);
                attemptResults.push(result.result || {
                    ...paper,
                    analysis: null,
                    parsed: null,
                    error: result.error || '分析失败'
                });
            }
            const latestAttempt = attemptResults[attemptResults.length - 1];
            updateJsonFileLocked(RESULT_FILE, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                batchDate,
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), latestAttempt ? [latestAttempt] : [], { preserveSuccessfulAnalysis: true })
            }));
            if (latestAttempt) updateAnalysisDigestStatuses([latestAttempt], { batchDate });
        }
    });

    // 合并结果：用新结果替换旧结果
    const mergedMap = new Map();
    for (const p of papers) {
        const key = normalizedId(p);
        if (key) mergedMap.set(key, p);
    }

    for (const p of analyzedResults) {
        const key = normalizedId(p);
        if (key) mergedMap.set(key, p);
    }

    const updatedAt = getBeijingISOString();
    const effectiveStats = { ...stats, failed: stats.failed + missingIds.length };
    const status = getAnalysisRunStatus(effectiveStats, effectiveStats.failed);
    data.papers = Array.from(mergedMap.values());
    const recoveredCount = updateReanalysisStats(
        data,
        analyzedResults,
        previousCurrentRubricIds,
        effectiveStats,
        updatedAt
    );

    updateJsonFileLocked(RESULT_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: updatedAt,
            batchDate,
            papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), attemptResults, { preserveSuccessfulAnalysis: true }),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), ...data.stats, selectedReanalyzeStatus: status }
        };
        if (status === 'complete' && payload.papers.every(isSuccessfulAnalysisRecord)) {
            payload.deepAnalysisCompletedAt = getBeijingISOString();
        } else {
            delete payload.deepAnalysisCompletedAt;
        }
        return payload;
    });
    const digestStatus = updateAnalysisDigestStatuses(attemptResults, { batchDate });

    console.log(`\n${status === 'complete' ? '✅' : '⚠️'} 重分析状态 ${status}: 成功 ${stats.success} | 失败 ${effectiveStats.failed}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
    if (sourceSummary) console.log(`文本来源: ${sourceSummary}`);
    if (recoveredCount > 0) console.log(`历史失败恢复: ${recoveredCount} 篇`);
    if (digestStatus.updated > 0) console.log(`papers.json 状态已同步: ${digestStatus.updated} 篇`);
    console.log(`💾 结果已保存到: ${RESULT_FILE}`);
    return { status, exitCode: getAnalysisExitCode(status), success: stats.success, failed: effectiveStats.failed, recoveredCount };
}

if (require.main === module) {
    const ids = process.argv.slice(2);
    if (ids.length === 0) {
        console.error('❌ 用法: node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...');
        process.exit(1);
    }

    reanalyzeSelected(ids).then(result => {
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error('❌ 错误:', err);
        process.exitCode = 1;
    });
}

module.exports = { reanalyzeSelected, updateReanalysisStats };
