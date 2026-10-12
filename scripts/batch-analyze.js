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
    getAnalysisRunSummary,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses, inferAnalysisBatchDate } = require('./digest-status.js');
const Config = require('./config.js');
const dailyFreshSources = require('./lib/daily-fresh-source-plan.js');
const factReview = require('./lib/daily-fact-review.js');

loadEnvFile();

const RESULT_FILE = Config.FILES.deepAnalysisResult;
const RETRY_FAILED_READERS = process.argv.slice(2).includes('--retry-failed-readers');
const readerExplicitRound = require('./lib/explicit-reader-retry-round');
const REFRESH_READER_DIAGNOSTICS = process.argv.slice(2).includes('--refresh-reader-diagnostics');

function parseFactFeedbackFiles(argv = process.argv.slice(2)) {
    const files = [];
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] !== '--fact-feedback-file') continue;
        const filename = argv[++index];
        if (typeof filename !== 'string' || !filename.trim() || filename.startsWith('--')) {
            throw new Error('--fact-feedback-file 后须提供事实反馈 JSON 文件路径，可重复提供此参数。');
        }
        files.push(filename);
    }
    return files;
}

function finalizeBatchZeroWorkState(resultPath, fallbackBatchDate) {
    return updateJsonFileLocked(resultPath, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success, status } = getAnalysisRunSummary(currentPapers);
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
    if (options.refreshReaderDiagnostics !== undefined && typeof options.refreshReaderDiagnostics !== 'boolean') {
        throw new Error('长文恢复检查设置必须为 true 或 false。');
    }
    const refreshReaderDiagnostics = REFRESH_READER_DIAGNOSTICS || options.refreshReaderDiagnostics === true;
    let explicitManifest;
    const manifestIndex = process.argv.indexOf('--reader-retry-manifest');
    const manifestPath = options.readerRetryManifestPath !== undefined
        ? options.readerRetryManifestPath : manifestIndex < 0 ? undefined : process.argv[manifestIndex + 1];
    if (RETRY_FAILED_READERS || manifestPath !== undefined) {
        if (typeof manifestPath !== 'string' || !manifestPath.trim() || manifestPath.startsWith('--')) {
            throw new Error('明确新轮重试必须提供 readerRetryManifestPath 或 --reader-retry-manifest');
        }
        explicitManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(explicitManifest.rounds)) throw new Error('Reader 重试清单的格式不符合要求');
        for (const grant of explicitManifest.rounds) readerExplicitRound.assertGrant(grant);
    }
    const feedbackFiles = options.factFeedbackFiles === undefined ? parseFactFeedbackFiles() : options.factFeedbackFiles;
    if (!Array.isArray(feedbackFiles) || feedbackFiles.some(filename => (
        typeof filename !== 'string' || !filename.trim()
    ))) throw new Error('批量事实反馈路径须为非空字符串组成的数组。');
    const feedbacks = new Map();
    for (const filename of feedbackFiles) {
        const feedback = factReview.readFeedback(filename);
        if (feedbacks.has(feedback.paperId)) throw new Error(`同一论文不能提供两份事实反馈：${feedback.paperId}`);
        feedbacks.set(feedback.paperId, feedback);
    }
    // 这个入口只继续已有日更分析。旧结果文件没有对应的封存 PDF 和文本记录，
    // 不能把它迁为当前结果后，再让分析器通过旧抓取路径补取来源。
    if (!fs.existsSync(RESULT_FILE)) {
        throw new Error('继续批量分析需要已有日更分析记录及对应的 PDF 和文本来源文件。目标日期是北京时间当天时，请重新运行 npm run digest:prepare；历史日期应保留失败记录，并按历史维护流程处理。');
    }
    console.log('=== 批量论文分析 ===');
    console.log(`数据文件: ${RESULT_FILE}`);

    const prepare = current => dailyFreshSources.prepareDailyFreshSourceRecoveryPayload(current,
        readJsonFileStrict(Config.FILES.filteredPapers), { label: 'batch recovery' });
    // 先只读核验整组反馈，再改写运行状态；后一个文件不合法时，前一个也不能开始请求。
    const data = (feedbacks.size || explicitManifest) ? prepare(readJsonFileStrict(RESULT_FILE))
        : updateJsonFileLocked(RESULT_FILE, prepare);

    const papers = Array.isArray(data) ? data : (data.papers || []);
    const dailySourcePlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(data, {
        papers, label: 'batch recovery'
    });
    for (const [id, feedback] of feedbacks) {
        const paper = papers.find(item => normalizedId(item) === id);
        if (!paper) throw new Error(`事实反馈论文不在当前完整日更集合内：${id}`);
        factReview.validateFeedback(feedback, dailySourcePlan, paper);
    }
    const batchDate = inferAnalysisBatchDate(
        papers,
        Array.isArray(data) ? {} : data,
        getBeijingISOString()
    );
    console.log(`总论文数: ${papers.length}`);

    const notAnalyzed = papers.filter(p => feedbacks.has(normalizedId(p)) || !isSuccessfulAnalysisRecord(p)
        || !dailyFreshSources.isPaperReusableForAnalysis(p, dailySourcePlan));
    console.log(`本次处理论文: ${notAnalyzed.length}`);
    if (feedbacks.size) console.log(`其中 ${feedbacks.size} 篇带有已核验的事实反馈；程序检查已通过的论文也须纠正已发现错误。`);

    const explicitRounds = new Map();
    if (explicitManifest) {
        const manifest = explicitManifest;
        if (manifest.batchDate !== batchDate || manifest.runId !== dailySourcePlan.runId
            || !Array.isArray(manifest.rounds)) throw new Error('Reader 新轮清单批次不匹配');
        for (const grant of manifest.rounds) {
            readerExplicitRound.assertGrant(grant);
            if (explicitRounds.has(grant.paperId) || !notAnalyzed.some(p => normalizedId(p) === grant.paperId)) {
                throw new Error('Reader 新轮目标重复或不是未完成论文');
            }
            const target = papers.find(p => normalizedId(p) === grant.paperId);
            if (target && isSuccessfulAnalysisRecord(target)
                && dailyFreshSources.isPaperReusableForAnalysis(target, dailySourcePlan)) throw new Error('不能对已通过的论文开 Reader 新轮');
            if (require('./lib/daily-fact-review').sha(target.analysisCheckpoint || target.analysis || '') !== grant.wholeSha256
                || grant.batchDate !== batchDate || grant.runId !== dailySourcePlan.runId) throw new Error('Reader 新轮当前正文或批次不匹配');
            const details = dailyFreshSources.readDailyFreshSource(dailySourcePlan, target);
            const sourceDir = path.join(dailySourcePlan.sourcesDir, grant.paperId,
                `generation-${String(details.freshSourceDescriptor.sourceGeneration).padStart(6, '0')}`);
            for (const [name, expected] of Object.entries(grant.sourceFiles)) {
                if (require('./lib/daily-fact-review').sha(fs.readFileSync(path.join(sourceDir, name))) !== expected) throw new Error('Reader 新轮四来源不匹配');
            }
            explicitRounds.set(grant.paperId, grant);
        }
    }

    if (notAnalyzed.length === 0) {
        const finalPayload = finalizeBatchZeroWorkState(RESULT_FILE, batchDate);
        updateAnalysisDigestStatuses(finalPayload.papers, {
            batchDate: finalPayload.batchDate
        });
        const summary = getAnalysisRunSummary(finalPayload.papers);
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

    const runAnalysisFromDailySources = () => (options.analyzeBatch || analyzeBatch)(notAnalyzed, {
        checkpointFilePath: RESULT_FILE,
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 1,
        analyzeFn: dailyFreshSources.createDailyAnalyzeFn(dailySourcePlan, {
            ...options,
            ...((feedbacks.size || explicitRounds.size) ? { analyze: paper => {
                const feedback = feedbacks.get(normalizedId(paper));
                const normalAnalyze = () => (options.analyzeFn || require('./deep-analyzer').analyzePaperDeep)(paper);
                const grant = explicitRounds.get(normalizedId(paper));
                const analyze = () => grant ? readerExplicitRound.withExplicitRound(paper, grant, normalAnalyze) : normalAnalyze();
                if (!feedback) return analyze();
                const bound = factReview.validateFeedback(feedback, dailySourcePlan, paper);
                return factReview.withFactReview(bound, analyze);
            } } : options.analyzeFn ? { analyze: options.analyzeFn } : {})
        }),
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(RESULT_FILE);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            const feedback = feedbacks.get(normalizedId(paper));
            if (feedback) {
                const lockedPlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(current, { label: 'locked batch fact review' });
                factReview.validateFeedback(feedback, lockedPlan, latest);
            }
            if (!feedback && isSuccessfulAnalysisRecord(latest)
                && dailyFreshSources.isPaperReusableForAnalysis(latest, dailySourcePlan)) {
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
            console.log(`   已更新批次统计到 ${RESULT_FILE}`);
        }
    });
    const { stats } = await dailyFreshSources.withDailyFreshAnalysisContext(
        dailySourcePlan, runAnalysisFromDailySources, { refreshReaderDiagnostics }
    );

    console.log('\n=== 批量分析完成 ===');
    console.log(`成功: ${stats.success} | 失败: ${stats.failed} | 总计处理: ${notAnalyzed.length}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
    if (sourceSummary) console.log(`文本来源: ${sourceSummary}`);
    const finalPayload = updateJsonFileLocked(RESULT_FILE, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining, success: savedAnalysisSuccess, status } = getAnalysisRunSummary(currentPapers);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            status,
            lastUpdated: getBeijingISOString(),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analyzedSuccess: savedAnalysisSuccess,
                analyzedFailed: remaining,
                remainingFailed: remaining,
                analysisStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const { remaining, status } = getAnalysisRunSummary(finalPayload.papers);
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

module.exports = { main, parseFactFeedbackFiles, finalizeBatchZeroWorkState };
