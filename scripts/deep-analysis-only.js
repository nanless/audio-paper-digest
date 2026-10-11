#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 仅运行深度分析（从已有筛选结果续跑）
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const { formatAnalysisStatus, formatAnalysisCount, formatAnalysisSources } = require('./lib/analysis-terminal-summary.js');
const { loadEnvFile, getBeijingISOString, getBeijingDateString, getRecordDate, normalizedId } = require('./utils.js');
const {
    analyzeBatch,
    readJsonFileStrict,
    updateJsonFileLocked,
    mergePapersById,
    mergeStoredAnalysisState,
    isSuccessfulAnalysisRecord,
    getAnalysisRunSummary,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');
const Config = require('./config.js');
const dailyFreshSources = require('./lib/daily-fresh-source-plan.js');

loadEnvFile();

function parseTargetDate(argv = process.argv.slice(2)) {
    if (!Array.isArray(argv)) throw new TypeError('命令行参数 argv 必须是数组。');
    if (argv.length === 0) return getBeijingDateString();
    if (argv.length !== 2 || argv[0] !== '--date') {
        throw new Error('用法: npm run deep -- --date YYYY-MM-DD');
    }
    const value = String(argv[1] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('--date 必须是 YYYY-MM-DD');
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error('--date 不是有效日期');
    }
    return value;
}

function validateCompleteFilteredForToday(filteredData, today) {
    if (!filteredData || filteredData.status !== 'complete' || !Array.isArray(filteredData.papers)) {
        throw new Error('筛选尚未完成，或论文列表 papers 不是数组，不能开始深度分析。');
    }
    const recordDate = filteredData.batchDate || getRecordDate(filteredData);
    if (recordDate !== today) {
        throw new Error(`筛选结果的日期与目标批次不一致：目标日期为 ${today}，记录日期为 ${recordDate || '未知'}。`);
    }
    return filteredData;
}

function validateDeepAnalysisInput(existingData, filteredData, today) {
    const recordDate = existingData?.batchDate || getRecordDate(existingData);
    if (recordDate !== today) {
        throw new Error(`分析结果的日期与目标批次不一致：目标日期为 ${today}，记录日期为 ${recordDate || '未知'}。`);
    }
    const existingPapers = Array.isArray(existingData) ? existingData : (existingData?.papers || []);
    const expectedIds = new Set(filteredData.papers.map(normalizedId).filter(Boolean));
    const actualIds = new Set(existingPapers.map(normalizedId).filter(Boolean));
    const missing = [...expectedIds].filter(id => !actualIds.has(id));
    const unexpected = [...actualIds].filter(id => !expectedIds.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(`分析结果与目标日期的筛选集合不一致：缺少 ${missing.length} 篇，多出 ${unexpected.length} 篇。`);
    }
    return existingData;
}

function finalizeDeepZeroWorkState(resultPath, filteredData, today) {
    return updateJsonFileLocked(resultPath, current => {
        validateDeepAnalysisInput(current, filteredData, today);
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success, status } = getAnalysisRunSummary(currentPapers);
        const now = getBeijingISOString();
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            batchDate: today,
            status,
            deepAnalysisLastAttemptAt: now,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analyzedSuccess: success,
                analyzedFailed: remaining,
                remainingFailed: remaining,
                totalAfterMerge: currentPapers.length,
                analysisStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = now;
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
}

async function runDeepAnalysis(options = {}) {
    console.log('=== 仅运行深度分析 ===\n');

    const currentPath = Config.FILES.deepAnalysisResult;
    const filteredPath = Config.FILES.filteredPapers;
    const today = options.date || parseTargetDate();
    const filteredData = validateCompleteFilteredForToday(readJsonFileStrict(filteredPath), today);

    const resultPath = currentPath;

    // 续跑不能从旧位置恢复结果文件，也不能只根据筛选元数据新建分析结果。
    // 这两种数据都没有日更封存来源记录，可能让分析器改用旧文本或缓存。
    // 日更来源计划只能由 full-fetch 在取得并封存来源文件后创建。
    if (!fs.existsSync(resultPath)) {
        throw new Error('继续分析需要已有日更分析记录及对应的 PDF 和文本来源文件。目标日期是北京时间当天时，请重新运行 npm run digest:prepare；历史日期应保留失败记录，并按历史维护流程处理。');
    }

    let existingData = updateJsonFileLocked(resultPath, current =>
        dailyFreshSources.prepareDailyFreshSourceRecoveryPayload(current,
            validateCompleteFilteredForToday(readJsonFileStrict(filteredPath), today),
            { label: 'deep-only recovery' }));
    const dailySourcePlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(existingData, {
        label: 'deep-only recovery'
    });
    existingData = validateDeepAnalysisInput(existingData, filteredData, today);

    const papers = Array.isArray(existingData) ? existingData : (existingData.papers || []);
    const analyzedCount = papers.filter(paper => (
        isSuccessfulAnalysisRecord(paper)
        && dailyFreshSources.isPaperReusableForAnalysis(paper, dailySourcePlan)
    )).length;
    console.log(`📊 读取到 ${papers.length} 篇筛选后的论文，其中 ${analyzedCount} 篇已有与当前封存来源对应的成功分析\n`);

    const freshById = new Map(filteredData.papers.map(paper => [normalizedId(paper), paper]));
    const notAnalyzed = papers
        .filter(p => !isSuccessfulAnalysisRecord(p)
            || !dailyFreshSources.isPaperReusableForAnalysis(p, dailySourcePlan))
        .map(storedAnalysisRecord => mergeStoredAnalysisState(
            freshById.get(normalizedId(storedAnalysisRecord)) || storedAnalysisRecord,
            storedAnalysisRecord
        ))
        .map(paper => dailyFreshSources.prepareDailyPaper(paper, dailySourcePlan));
    if (notAnalyzed.length === 0) {
        const finalPayload = finalizeDeepZeroWorkState(resultPath, filteredData, today);
        updateAnalysisDigestStatuses(finalPayload.papers, { batchDate: today });
        const summary = getAnalysisRunSummary(finalPayload.papers);
        console.log(summary.status === 'complete'
            ? '✅ 所有论文已分析完成！'
            : `⚠️ 检测到并发更新，仍有 ${summary.remaining} 篇未完成`);
        return {
            status: summary.status,
            exitCode: getAnalysisExitCode(summary.status),
            stats: { success: 0, failed: summary.remaining, skipped: finalPayload.papers.length - summary.remaining },
            remaining: summary.remaining
        };
    }

    updateJsonFileLocked(resultPath, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            status: 'running',
            deepAnalysisLastAttemptAt: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const runAnalysisFromDailySources = () => (options.analyzeBatch || analyzeBatch)(notAnalyzed, {
        checkpointFilePath: resultPath,
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: Config.ANALYSIS_CONFIG.concurrency,
        analyzeFn: dailyFreshSources.createDailyAnalyzeFn(dailySourcePlan, {
            ...options,
            ...(options.analyzeFn ? { analyze: options.analyzeFn } : {})
        }),
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(resultPath);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            if (isSuccessfulAnalysisRecord(latest)
                && dailyFreshSources.isPaperReusableForAnalysis(latest, dailySourcePlan)) {
                return { paper: latest, skip: true };
            }
            return {
                paper: dailyFreshSources.prepareDailyPaper(
                    latest ? mergeStoredAnalysisState(paper, latest) : paper,
                    dailySourcePlan
                ),
                skip: false
            };
        },
        onPaperResultLocked: async (paper, result) => {
            const attempted = result.result || { ...paper, analysis: null, parsed: null, error: result.error || '分析失败' };
            updateJsonFileLocked(resultPath, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), [attempted], { preserveSuccessfulAnalysis: true }),
                status: 'running',
                stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
            }));
            updateAnalysisDigestStatuses([attempted], { batchDate: today });
        },
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${papers.length}] ${paper.title.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '';
                console.log(`    ✅ 完成 ${score} | ${durSec}s`);
            } else {
                console.log(`    ❌ 失败 | ${durSec}s | ${result.error}`);
            }
        },
        onSave: async (_results, saveStats) => {
            const processed = saveStats.success + saveStats.failed;
            const output = updateJsonFileLocked(resultPath, current => {
                const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
                const {
                    remaining,
                    success: savedAnalysisSuccess,
                    status: savedAnalysisStatus
                } = getAnalysisRunSummary(currentPapers);
                const progressStatus = processed < notAnalyzed.length
                    ? 'running'
                    : savedAnalysisStatus;
                const payload = {
                    ...(!Array.isArray(current) && current ? current : {}),
                    lastUpdated: getBeijingISOString(),
                    papers: currentPapers,
                    status: progressStatus,
                    stats: {
                        ...(!Array.isArray(current) ? current?.stats : {}),
                        ...saveStats,
                        analyzedSuccess: savedAnalysisSuccess,
                        analyzedFailed: remaining,
                        remainingFailed: remaining,
                        analysisStatus: progressStatus
                    }
                };
                if (progressStatus === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
                else delete payload.deepAnalysisCompletedAt;
                return payload;
            });
            papers.splice(0, papers.length, ...(output.papers || []));
            console.log(`  💾 已更新批次统计 (${saveStats.success + saveStats.failed}/${notAnalyzed.length})`);
        }
    });
    const { stats } = await dailyFreshSources.withDailyFreshAnalysisContext(dailySourcePlan, runAnalysisFromDailySources);

    const finalPayload = updateJsonFileLocked(resultPath, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success: savedAnalysisSuccess, status } = getAnalysisRunSummary(currentPapers);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            status,
            deepAnalysisLastAttemptAt: getBeijingISOString(),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analyzedSuccess: savedAnalysisSuccess,
                analyzedFailed: remaining,
                remainingFailed: remaining,
                totalAfterMerge: currentPapers.length,
                analysisStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const { remaining, status } = getAnalysisRunSummary(finalPayload.papers);

    console.log(`\n${status === 'complete' ? '✅' : '⚠️'} 深度分析状态: ${formatAnalysisStatus(status)}`);
    console.log(`📊 统计:`);
    console.log(`  - 总计: ${papers.length} 篇`);
    console.log(`  - 本次分析成功: ${formatAnalysisCount(stats.success)} 篇`);
    console.log(`  - 本次分析失败: ${formatAnalysisCount(stats.failed)} 篇`);
    console.log(`  - 本次跳过: ${formatAnalysisCount(stats.skipped)} 篇`);
    const sourceSummary = formatAnalysisSources(stats.sourceCounts);
    if (sourceSummary) console.log(`  - 文本来源: ${sourceSummary}`);
    console.log(`💾 结果已保存到: ${resultPath}`);
    return { status, exitCode: getAnalysisExitCode(status), stats, remaining };
}

if (require.main === module) {
    runDeepAnalysis().then(result => {
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error(`❌ 失败: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    runDeepAnalysis,
    parseTargetDate,
    validateCompleteFilteredForToday,
    validateDeepAnalysisInput,
    finalizeDeepZeroWorkState
};
