#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 批量分析论文 - 读取 deep-analysis-result.json 中未分析的论文
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const path = require('path');
const { loadEnvFile, getBeijingISOString, normalizedId } = require('./utils.js');
const {
    analyzeBatch,
    readJsonFileStrict,
    updateJsonFileLocked,
    mergePapersById,
    isSuccessfulAnalysisRecord,
    getCanonicalAnalysisRunSummary,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses, inferAnalysisBatchDate } = require('./digest-status.js');
const Config = require('./config.js');
const dailyFreshSources = require('./lib/daily-fresh-source-plan.js');
const readerRepair = require('./lib/reader-repair.js');

loadEnvFile();

const RESULT_FILE = Config.FILES.deepAnalysisResult;
const RETRY_FAILED_READERS = process.argv.slice(2).includes('--retry-failed-readers');

function retireIncompleteReaderCandidates(directory, paperIds, options = {}) {
    const readDir = options.readDir || fs.readdirSync;
    const readFile = options.readFile || fs.readFileSync;
    const retire = options.retire || readerRepair.retireFailedCandidate;
    let retired = 0;
    try {
        const names = readDir(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
        for (const name of names) {
            const envelope = JSON.parse(readFile(path.join(directory, name), 'utf8'));
            const paperId = normalizedId({ arxivId: envelope?.identity?.paperId });
            if (!paperId || !paperIds.has(paperId)) continue;
            if (retire(directory, envelope.identity)) retired += 1;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return retired;
}

function finalizeBatchZeroWorkState(resultPath, fallbackBatchDate) {
    return updateJsonFileLocked(resultPath, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success, status } = getCanonicalAnalysisRunSummary(currentPapers);
        const now = getBeijingISOString();
        const batchDate = inferAnalysisBatchDate(
            currentPapers,
            Array.isArray(current) ? {} : current,
            fallbackBatchDate || now
        );
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            batchDate,
            status,
            lastUpdated: now,
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

async function main(options = {}) {
    // This is a daily recovery entrypoint.  A legacy result file has no
    // sealed PDF/TXT run reference, so it must never be promoted and then
    // allowed to fall back through deep-analyzer's historical fetch path.
    if (!fs.existsSync(RESULT_FILE)) {
        throw new Error('batch recovery requires current canonical with a sealed daily PDF/TXT source run; rerun npm run digest:prepare');
    }
    console.log('=== 批量论文分析 ===');
    console.log(`数据文件: ${RESULT_FILE}`);

    const data = readJsonFileStrict(RESULT_FILE);

    const papers = Array.isArray(data) ? data : (data.papers || []);
    const dailySourcePlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(data, {
        papers, label: 'batch recovery'
    });
    const batchDate = inferAnalysisBatchDate(
        papers,
        Array.isArray(data) ? {} : data,
        getBeijingISOString()
    );
    console.log(`总论文数: ${papers.length}`);

    const notAnalyzed = papers.filter(p => !isSuccessfulAnalysisRecord(p)
        || !dailyFreshSources.isPaperBoundToPlan(p, dailySourcePlan));
    console.log(`未分析论文: ${notAnalyzed.length}`);

    if (RETRY_FAILED_READERS) {
        const retired = retireIncompleteReaderCandidates(
            dailySourcePlan.readerAttemptsDir,
            new Set(notAnalyzed.map(normalizedId).filter(Boolean))
        );
        if (retired > 0) console.log(`已保留并退休 ${retired} 个未完成论文的旧 Reader 失败候选`);
    }

    if (notAnalyzed.length === 0) {
        const finalPayload = finalizeBatchZeroWorkState(RESULT_FILE, batchDate);
        updateAnalysisDigestStatuses(finalPayload.papers, {
            batchDate: finalPayload.batchDate
        });
        const summary = getCanonicalAnalysisRunSummary(finalPayload.papers);
        console.log(summary.status === 'complete' ? '所有论文已分析完成！' : `检测到并发更新，仍有 ${summary.remaining} 篇未完成`);
        return {
            status: summary.status,
            exitCode: getAnalysisExitCode(summary.status),
            stats: { success: 0, failed: summary.remaining, skipped: finalPayload.papers.length - summary.remaining },
            remaining: summary.remaining
        };
    }

    updateJsonFileLocked(RESULT_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            status: 'running',
            lastUpdated: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const runSealedDailyAnalysis = () => (options.analyzeBatch || analyzeBatch)(notAnalyzed, {
        checkpointFilePath: RESULT_FILE,
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 1,
        analyzeFn: dailyFreshSources.createDailyAnalyzeFn(dailySourcePlan, {
            ...options,
            ...(options.analyzeFn ? { analyze: options.analyzeFn } : {})
        }),
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(RESULT_FILE);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            if (isSuccessfulAnalysisRecord(latest)
                && dailyFreshSources.isPaperBoundToPlan(latest, dailySourcePlan)) {
                return { paper: latest, skip: true };
            }
            return { paper: dailyFreshSources.prepareDailyPaper(latest || paper, dailySourcePlan), skip: false };
        },
        onPaperResultLocked: async (paper, result) => {
            const attempted = result.result || { ...paper, analysis: null, parsed: null, error: result.error || '分析失败' };
            updateJsonFileLocked(RESULT_FILE, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), [attempted], { preserveSuccessfulAnalysis: true }),
                status: 'running',
                stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
            }));
            updateAnalysisDigestStatuses([attempted], {
                batchDate
            });
        },
        onPaperStart: (idx, total, paper) => {
            console.log(`\n--- [${idx + 1}/${total}] 分析: ${paper.arxivId} ---`);
            const titleStr = paper.title || '(无标题)';
            console.log(`标题: ${titleStr.substring(0, 80)}${titleStr.length > 80 ? '...' : ''}`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                console.log(`✅ 分析成功 (${durSec}s)`);
                if (result.parsed) {
                    console.log(`   评分: ${result.parsed.score || 'N/A'}`);
                    console.log(`   标签: ${result.parsed.tags ? result.parsed.tags.slice(0, 5).join(' ') : 'N/A'}`);
                    console.log(`   分档: ${result.parsed.rankBucket || 'N/A'} | 主任务: ${result.parsed.primaryTaskTag || 'N/A'} | 主方法: ${result.parsed.primaryMethodTag || 'N/A'}`);
                }
            } else {
                console.log(`❌ 分析异常 (${durSec}s): ${result.error}`);
            }
        },
        onSave: async (_results, saveStats) => {
            const processed = saveStats.success + saveStats.failed;
            const output = updateJsonFileLocked(RESULT_FILE, current => {
                const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
                const {
                    remaining,
                    success: canonicalSuccess,
                    status: canonicalStatus
                } = getCanonicalAnalysisRunSummary(currentPapers);
                const progressStatus = processed < notAnalyzed.length
                    ? 'running'
                    : canonicalStatus;
                const payload = {
                    ...(!Array.isArray(current) && current ? current : {}),
                    lastUpdated: getBeijingISOString(),
                    papers: currentPapers,
                    status: progressStatus,
                    stats: {
                        ...(!Array.isArray(current) ? current?.stats : {}),
                        ...saveStats,
                        analyzedSuccess: canonicalSuccess,
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
            console.log(`   已更新批次统计到 ${RESULT_FILE}`);
        }
    });
    const { stats } = await dailyFreshSources.withDailyFreshAnalysisContext(dailySourcePlan, runSealedDailyAnalysis);

    console.log('\n=== 批量分析完成 ===');
    console.log(`成功: ${stats.success} | 失败: ${stats.failed} | 总计处理: ${notAnalyzed.length}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
    if (sourceSummary) console.log(`文本来源: ${sourceSummary}`);
    const finalPayload = updateJsonFileLocked(RESULT_FILE, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success: canonicalSuccess, status } = getCanonicalAnalysisRunSummary(currentPapers);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            status,
            lastUpdated: getBeijingISOString(),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analyzedSuccess: canonicalSuccess,
                analyzedFailed: remaining,
                remainingFailed: remaining,
                analysisStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const { remaining, status } = getCanonicalAnalysisRunSummary(finalPayload.papers);
    console.log(`剩余未分析: ${remaining}`);
    console.log(`运行状态: ${status}`);
    return { status, exitCode: getAnalysisExitCode(status), stats, remaining };
}

if (require.main === module) {
    main().then(result => {
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error('批量分析异常:', err);
        process.exitCode = 1;
    });
}

module.exports = { main, finalizeBatchZeroWorkState, retireIncompleteReaderCandidates };
