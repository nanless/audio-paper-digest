#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);
const fs = require('fs');
const path = require('path');

/**
 * 重新分析指定论文
 * 用法: node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...
 * 恢复统计口径实现见 `./lib/reanalysis-helpers.js`（本文件仅保留 CLI 流程）。
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
    initializeJsonFileLocked,
    mergePapersById,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getAnalysisRunSummary,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses, inferAnalysisBatchDate } = require('./digest-status.js');
const { resetReaderForSelectedReanalysis, updateReanalysisStats } = require('./lib/reanalysis-helpers.js');
const Config = require('./config.js');
const dailyFreshSources = require('./lib/daily-fresh-source-plan.js');
const readerRepair = require('./lib/reader-repair.js');

const RESULT_FILE = Config.FILES.deepAnalysisResult;

async function reanalyzeSelected(ids, options = {}) {
    console.log(`=== 重新分析 ${ids.length} 篇论文 ===\n`);

    if (!fs.existsSync(RESULT_FILE) && fs.existsSync(Config.FILES.deepAnalysisResultLegacy)) {
        const legacyData = readJsonFileStrict(Config.FILES.deepAnalysisResultLegacy);
        initializeJsonFileLocked(RESULT_FILE, Array.isArray(legacyData)
            ? { timestamp: getBeijingISOString(), source: Config.FILES.deepAnalysisResultLegacy, papers: legacyData }
            : legacyData);
        console.log(`📦 已将 legacy 分析结果迁移到权威路径: ${RESULT_FILE}`);
    }

    const data = readJsonFileStrict(RESULT_FILE);

    const papers = data.papers || [];
    const idSet = new Set(ids.map(id => normalizedId(id)).filter(Boolean));
    if (options.refreshReaderDiagnostics !== undefined && typeof options.refreshReaderDiagnostics !== 'boolean')
        throw new Error('refreshReaderDiagnostics 必须为布尔值');
    if (options.coreSummaryDiagnosticIds !== undefined) {
        if (!options.coreSummaryDiagnosticIds || typeof options.coreSummaryDiagnosticIds !== 'object' || Array.isArray(options.coreSummaryDiagnosticIds)
            || Object.entries(options.coreSummaryDiagnosticIds).some(([id, value]) => !idSet.has(id) || normalizedId(id) !== id || !/^[a-f0-9-]{36}$/.test(String(value))))
            throw new Error('付费摘要复用必须明确指定本次选定论文及原请求 ID');
        if (options.fullStageReanalysis && Object.keys(options.coreSummaryDiagnosticIds).some(id => {
            const paper = papers.find(item => normalizedId(item) === id);
            return !paper?.fullStageReanalysis || paper.fullStageReanalysis.runId !== options.fullStageReanalysis.runId
                || paper.fullStageReanalysis.sourceRunId !== options.fullStageReanalysis.sourceRunId
                || paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete';
        })) throw new Error('付费摘要仅可继续同轮已完成主分析，不能强制全新生成');
    }
    const dailySourcePlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(data, {
        papers, label: 'selected reanalyze recovery'
    });
    const fullStages = require('./lib/selected-full-stage-reanalysis');
    let fullStageOptions = options.fullStageReanalysis;
    if (fullStageOptions && (fullStageOptions.sourceRunId !== dailySourcePlan.runId
        || JSON.stringify([...fullStageOptions.paperIds].sort()) !== JSON.stringify([...idSet].sort()))) {
        throw new Error('全阶段重跑选定 ID 或封存运行与本次入口不一致');
    }
    const factReview = require('./lib/daily-fact-review');
    const feedbacks = new Map();
    const boundFeedbacks = new Map();
    for (const file of options.feedbackFiles || []) {
        const feedback = factReview.readFeedback(file);
        if (feedbacks.has(feedback.paperId)) throw new Error('同篇反馈重复');
        feedbacks.set(feedback.paperId, feedback);
    }
    for (const [id, feedback] of feedbacks) {
        const paper = papers.find(item => normalizedId(item) === id);
        if (!paper || !idSet.has(id)) throw new Error('反馈不属于本次明确选定论文');
        const original = fullStageOptions && paper.fullStageReanalysis?.runId === fullStageOptions.runId
            ? paper.fullStageReanalysisHistory.find(item => item.runId === fullStageOptions.runId)?.originalPaper : paper;
        boundFeedbacks.set(id, factReview.validateFeedback(feedback, dailySourcePlan, original));
    }
    if (fullStageOptions) {
        const originalFeedbacks = {};
        for (const file of options.originalFeedbackFiles || []) {
            const feedback = factReview.readFeedback(file);
            if (!idSet.has(feedback.paperId)) throw new Error('原反馈不属于选定论文');
            (originalFeedbacks[feedback.paperId] ||= []).push({ path: file,
                fileSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
                feedback });
        }
        fullStageOptions = { ...fullStageOptions, originalFeedbacks };
    }
    let retiredReaderCandidates = 0;
    try {
        const names = fullStageOptions ? [] : fs.readdirSync(dailySourcePlan.readerAttemptsDir)
            .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
        for (const name of names) {
            const envelope = JSON.parse(fs.readFileSync(
                path.join(dailySourcePlan.readerAttemptsDir, name), 'utf8'
            ));
            if (idSet.has(normalizedId(envelope.identity?.paperId))
                && !options.coreSummaryDiagnosticIds?.[normalizedId(envelope.identity?.paperId)]
                && readerRepair.retireFailedCandidate(dailySourcePlan.readerAttemptsDir, envelope.identity)) {
                retiredReaderCandidates += 1;
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (retiredReaderCandidates > 0) {
        console.log(`已保留并退休 ${retiredReaderCandidates} 个所选论文的旧 Reader 失败候选`);
    }
    const batchDate = inferAnalysisBatchDate(
        papers,
        Array.isArray(data) ? {} : data,
        getBeijingISOString()
    );
    const previousCurrentRubricIds = new Set(papers
        .filter(p => p.parsed?.scoringRubricVersion === SCORING_RUBRIC_VERSION
            || p.scoringRubricVersion === SCORING_RUBRIC_VERSION)
        .map(normalizedId)
        .filter(Boolean));

    // 找到目标论文，清除旧的 analysis
    const toReanalyze = [];

    for (const p of papers) {
        const aid = normalizedId(p);
        if (idSet.has(aid)) {
            const cleanPaper = dailyFreshSources.prepareDailyPaper(
                fullStageOptions || options.coreSummaryDiagnosticIds?.[aid] ? p : resetReaderForSelectedReanalysis(p), dailySourcePlan
            );
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

    if (fullStageOptions) fullStages.withSelectedFullStageReanalysis(fullStageOptions, () => {});

    updateJsonFileLocked(RESULT_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            lastUpdated: getBeijingISOString(),
            batchDate,
            status: 'running',
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running',
                selectedReanalyzeStatus: 'running'
            }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    // 重新分析
    const analyzedResults = [];
    let digestStatusUpdated = 0;
    const runAnalysisFromDailySources = () => analyzeBatch(toReanalyze, {
        checkpointFilePath: RESULT_FILE,
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(RESULT_FILE);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            if (!latest) return { paper, skip: false };
            if (fullStageOptions) {
                const feedback = feedbacks.get(normalizedId(latest));
                const original = latest.fullStageReanalysis?.runId === fullStageOptions.runId
                    ? latest.fullStageReanalysisHistory.find(item => item.runId === fullStageOptions.runId)?.originalPaper : latest;
                if (feedback) boundFeedbacks.set(normalizedId(latest),
                    factReview.validateFeedback(feedback, dailySourcePlan, original));
                const bound = boundFeedbacks.get(normalizedId(latest));
                const prepare = () => {
                    if (latest.fullStageReanalysis?.runId === fullStageOptions.runId
                        && fullStages.completedThisRun(latest)) {
                        fullStages.assertPrepared(latest);
                        return { paper: latest, skip: true };
                    }
                    return { paper: dailyFreshSources.prepareDailyPaper(
                        fullStages.preparePaperLocked(latest), dailySourcePlan), skip: false };
                };
                return bound ? factReview.withFactReview(bound, prepare) : prepare();
            }
            return {
                paper: dailyFreshSources.prepareDailyPaper(
                    options.coreSummaryDiagnosticIds?.[normalizedId(paper)] ? { ...paper, ...latest } : resetReaderForSelectedReanalysis({ ...paper, ...latest }), dailySourcePlan
                ),
                skip: false
            };
        },
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 0,
        analyzeFn: async paper => {
            const analyze = () => dailyFreshSources.createDailyAnalyzeFn(dailySourcePlan, { coreSummaryDiagnosticIds: options.coreSummaryDiagnosticIds })(paper);
            const bound = boundFeedbacks.get(normalizedId(paper));
            return bound ? factReview.withFactReview(bound, analyze) : analyze();
        },
        onPaperResultLocked: async (paper, result) => {
            const attempted = result.result || {
                ...paper,
                analysis: null,
                parsed: null,
                error: result.error || '分析失败'
            };
            if (result.success) analyzedResults.push(attempted);
            updateJsonFileLocked(RESULT_FILE, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                batchDate,
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), [attempted], { preserveSuccessfulAnalysis: true })
            }));
            const digestStatus = updateAnalysisDigestStatuses([attempted], { batchDate });
            digestStatusUpdated += Number(digestStatus.updated) || 0;
        },
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${total}] ▶ 开始: ${paper.title?.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            if (result.skipped) {
                console.log(`  [${idx + 1}/${total}] ↩ 本轮已完成，保留现有结果`);
                return;
            }
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '[N/A]';
                console.log(`  [${idx + 1}/${total}] ✅ 完成 ${score} | ${durSec}s`);
            } else {
                console.log(`  [${idx + 1}/${total}] ❌ 失败 | ${durSec}s | ${result.error}`);
            }
        }
    });
    const { stats } = await dailyFreshSources.withDailyFreshAnalysisContext(
        dailySourcePlan, () => fullStageOptions
            ? fullStages.withSelectedFullStageReanalysis(fullStageOptions, runAnalysisFromDailySources)
            : runAnalysisFromDailySources(),
        { ...(options.refreshReaderDiagnostics !== undefined ? { refreshReaderDiagnostics: options.refreshReaderDiagnostics } : {}) }
    );

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
    data.papers = Array.from(mergedMap.values());
    const recoveredCount = updateReanalysisStats(
        data,
        analyzedResults,
        previousCurrentRubricIds,
        effectiveStats,
        updatedAt
    );

    const finalPayload = updateJsonFileLocked(RESULT_FILE, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const savedAnalysisById = new Map(currentPapers.map(paper => [normalizedId(paper), paper]));
        const remainingFailed = missingIds.length
            + [...foundIds].filter(id => !isSuccessfulAnalysisRecord(savedAnalysisById.get(id))).length;
        const status = getAnalysisRunStatus({ success: idSet.size - remainingFailed }, remainingFailed);
        const analysisRunSummary = getAnalysisRunSummary(currentPapers);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: updatedAt,
            batchDate,
            status: analysisRunSummary.status,
            papers: currentPapers,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                ...data.stats,
                analysisStatus: analysisRunSummary.status,
                remainingFailed: analysisRunSummary.remaining,
                selectedReanalyzeStatus: status,
                selectedReanalyzeRemainingFailed: remainingFailed
            }
        };
        if (analysisRunSummary.status === 'complete') {
            payload.deepAnalysisCompletedAt = getBeijingISOString();
        } else {
            delete payload.deepAnalysisCompletedAt;
        }
        return payload;
    });
    const status = finalPayload.stats.selectedReanalyzeStatus;
    console.log(`\n${status === 'complete' ? '✅' : '⚠️'} 重分析状态 ${status}: 成功 ${stats.success} | 失败 ${effectiveStats.failed}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
    if (sourceSummary) console.log(`文本来源: ${sourceSummary}`);
    if (recoveredCount > 0) console.log(`历史失败恢复: ${recoveredCount} 篇`);
    if (digestStatusUpdated > 0) console.log(`papers.json 状态已同步: ${digestStatusUpdated} 篇`);
    console.log(`💾 结果已保存到: ${RESULT_FILE}`);
    return {
        status,
        exitCode: getAnalysisExitCode(status),
        success: stats.success,
        failed: effectiveStats.failed,
        recoveredCount,
        digestStatusUpdated
    };
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

module.exports = { reanalyzeSelected, updateReanalysisStats, resetReaderForSelectedReanalysis };
