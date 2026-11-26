#!/usr/bin/env node
const { requireExternalRuntime } = require('./env-loader.js');
if (require.main === module) {
    requireExternalRuntime('reanalyze.js', { enforceWorkspaceRole: true });
}
const { setupScriptLogging, writeStageSummary } = require('./log-setup');
const { printErrorGuidance, redactSensitive } = require('./lib/error-guidance.js');

let currentReanalyzeBatchDate = null;
let currentReanalyzeStageStartedAt = Date.now();

/**
 * 重新分析已有论文
 * 使用 analysis-engine.js 统一封装的批量分析与保存逻辑
 */

const fs = require('fs');
const path = require('path');
const { loadEnvFile, getBeijingISOString, getBeijingLocaleString, normalizedId } = require('./utils.js');
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
const readerRepair = require('./lib/reader-repair.js');
const {
    parseReanalyzeCliArgs,
    parseReanalyzeConcurrency,
    resetReaderForForcedReanalysis
} = require('./lib/reanalysis-helpers.js');

async function reanalyzeAll(options = {}) {
    const dataFile = options.dataFile || Config.FILES.deepAnalysisResult;
    const concurrency = parseReanalyzeConcurrency({
        cliValue: options.concurrency,
        envValue: options.concurrency !== undefined ? undefined : process.env.PD_REANALYZE_CONCURRENCY,
        fallback: Config.ANALYSIS_CONFIG.concurrency
    });
    console.log(`[reanalyze] 读取数据文件: ${dataFile}`);

    if (!fs.existsSync(dataFile)) {
        console.error(`[reanalyze] ❌ 文件不存在: ${dataFile}`);
        throw Object.assign(new Error(`分析结果文件不存在: ${dataFile}`), { code: 'ENOENT' });
    }

    let dailySourcePlan;
    const data = updateJsonFileLocked(dataFile, current => {
        const prepared = dailyFreshSources.prepareDailyFreshSourceRecoveryPayload(current,
            readJsonFileStrict(Config.FILES.filteredPapers), { label: 'reanalyze recovery' });
        dailySourcePlan = dailyFreshSources.requireDailyFreshSourceRecoveryPlan(prepared, {
            label: 'reanalyze recovery'
        });
        return dailyFreshSources.withDailyFreshAnalysisContext(dailySourcePlan, () => {
            for (const paper of prepared.papers)
                require('./lib/daily-scoring-refresh-checkpoint').assertNoPending(paper);
            return prepared;
        });
    });

    const papers = Array.isArray(data) ? data : (data.papers || []);
    let retiredReaderCandidates = 0;
    try {
        const names = fs.readdirSync(dailySourcePlan.readerAttemptsDir)
            .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
        for (const name of names) {
            const candidatePath = path.join(dailySourcePlan.readerAttemptsDir, name);
            let envelope;
            try {
                envelope = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            } catch (error) {
                throw new Error(`Reader 失败候选无法读取：${candidatePath}：${error.message}`, { cause: error });
            }
            if (readerRepair.retireFailedCandidate(dailySourcePlan.readerAttemptsDir, envelope.identity)) {
                retiredReaderCandidates += 1;
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (retiredReaderCandidates > 0) {
        console.log(`[reanalyze] 已保留并停用 ${retiredReaderCandidates} 份旧读者文章草稿`);
    }
    console.log(`[reanalyze] 共 ${papers.length} 篇论文需要重新分析`);
    console.log(`[reanalyze] 模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    console.log(`[reanalyze] 并发度: ${concurrency}`);
    console.log(`[reanalyze] 开始时间: ${getBeijingLocaleString()}`);
    console.log('');

    // 保存中间结果的辅助函数
    const batchDate = inferAnalysisBatchDate(
        papers,
        Array.isArray(data) ? {} : data,
        getBeijingISOString()
    );
    currentReanalyzeBatchDate = batchDate;
    currentReanalyzeStageStartedAt = Date.now();
    writeStageSummary({ stage: '分析', status: 'start', date: batchDate, message: `重新分析 ${papers.length} 篇` });
    const attemptResults = [];
    const preparedIds = new Set();
    let digestStatusUpdated = 0;
    const doSave = attempted => {
        updateJsonFileLocked(dataFile, current => ({
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: getBeijingISOString(),
            batchDate,
            papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), [attempted], { preserveSuccessfulAnalysis: true })
        }));
        const digestStatus = updateAnalysisDigestStatuses([attempted], { batchDate });
        digestStatusUpdated += Number(digestStatus.updated) || 0;
        return digestStatus;
    };

    // 预先建立 ID -> 索引映射，避免并发时 findIndex 可能找到错误位置
    const paperIndexMap = new Map(papers.map((p, i) => [normalizedId(p), i]).filter(([key]) => key));

    updateJsonFileLocked(dataFile, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            timestamp: getBeijingISOString(),
            batchDate,
            status: 'running',
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running',
                analysisBatchRetry: null,
                reanalyzeStatus: 'running'
            }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const runAnalysisFromDailySources = () => (options.analyzeBatch || analyzeBatch)(papers, {
        checkpointFilePath: dataFile,
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(dataFile);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            const lockedPlan = dailyFreshSources.requireLockedDailyFreshSourceRecoveryPlan(current, {
                entryPlan: dailySourcePlan, paper: latest || paper, label: '锁内强制重分析恢复'
            });
            const id = normalizedId(paper);
            const firstPreparation = !preparedIds.has(id);
            preparedIds.add(id);
            const currentPaper = latest ? { ...paper, ...latest } : paper;
            return {
                paper: dailyFreshSources.prepareDailyPaper(
                    firstPreparation ? resetReaderForForcedReanalysis(currentPaper) : currentPaper,
                    lockedPlan
                ),
                skip: false
            };
        },
        concurrency,
        maxRetries: 2,
        maxRounds: Config.ANALYSIS_CONFIG.batchMaxRounds,
        retryDelayMs: 2000,
        onRoundDone: require('./digest-run-report').createAnalysisBatchRetryReporter(dataFile, {
            workflow: 'daily-forced-reanalysis', batchDate,
            sourceReference: dailyFreshSources.dailyFreshSourceReference(dailySourcePlan), papers
        }),
        saveInterval: 0,
        analyzeFn: dailyFreshSources.createDailyAnalyzeFn(dailySourcePlan, {
            ...options,
            ...(options.analyzeFn ? { analyze: options.analyzeFn } : {})
        }),
        onPaperResultLocked: async (paper, result) => {
            const attempted = result.result || {
                ...paper,
                analysis: null,
                parsed: null,
                error: result.error || '分析失败'
            };
            attemptResults.push(attempted);
            doSave(attempted);
        },
        onPaperStart: (idx, total, paper) => {
            if (concurrency === 1) {
                console.log(`\n[reanalyze] ════════════════════════════════════════════`);
                console.log(`[reanalyze] [${idx + 1}/${total}] 分析: ${paper.arxivId} - ${paper.title.substring(0, 50)}...`);
            }
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            if (result.success && result.result) {
                const key = normalizedId(paper);
                const targetIdx = paperIndexMap.get(key);
                if (targetIdx !== undefined) {
                    papers[targetIdx] = result.result;
                }
            }
            if (concurrency > 1) {
                const status = result.success ? '✅' : '❌';
                console.log(`[reanalyze] ${status} [${idx + 1}/${total}] ${paper.arxivId} | ${result.parsed?.score || 'N/A'} | ${(duration/1000).toFixed(1)}s`);
            } else {
                if (result.success) {
                    console.log(`[reanalyze] ✅ 成功: ${paper.arxivId} | 评分: ${result.parsed?.score || 'N/A'}`);
                } else {
                    console.log(`[reanalyze] ❌ 失败: ${paper.arxivId} - ${result.error}`);
                }
            }
            if (!result.skipped) console.log(`[reanalyze] 💾 单篇结果已保存 (${attemptResults.length}/${papers.length})`);
        }
    });
    const { stats } = await dailyFreshSources.withDailyFreshAnalysisContext(dailySourcePlan, runAnalysisFromDailySources);
    const finalPayload = updateJsonFileLocked(dataFile, current => {
        dailyFreshSources.requireFinalDailyFreshSourceRecoveryPlan(current, {
            entryPlan: dailySourcePlan, label: '强制重分析结束来源核验'
        });
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const { remaining: remainingFailed, status } = getAnalysisRunSummary(currentPapers);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: getBeijingISOString(),
            status,
            papers: currentPapers,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: status,
                remainingFailed,
                reanalyzed: stats.success,
                reanalyzeFailed: remainingFailed,
                reanalyzeSourceCounts: stats.sourceCounts,
                reanalyzeAt: getBeijingISOString(),
                reanalyzeStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const status = finalPayload.stats.reanalyzeStatus;
    writeStageSummary({
        stage: '分析', status: status === 'complete' ? 'ok' : 'warn', date: batchDate,
        elapsedMs: Date.now() - currentReanalyzeStageStartedAt,
        message: `重新分析结束 ${status}：成功 ${stats.success ?? 0} 篇，失败 ${stats.failed ?? 0} 篇，总计 ${papers.length} 篇`
    });
    console.log('');
    console.log(`[reanalyze] ════════════════════════════════════════════`);
    console.log(`[reanalyze] 重新分析状态: ${status}`);
    console.log(`[reanalyze] 成功: ${stats.success} | 失败: ${stats.failed} | 总计: ${papers.length}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {})
        .map(([source, count]) => `${source}=${count}`)
        .join(' | ');
    if (sourceSummary) console.log(`[reanalyze] 文本来源: ${sourceSummary}`);
    if (digestStatusUpdated > 0) console.log(`[reanalyze] papers.json 状态已同步: ${digestStatusUpdated} 篇`);
    console.log(`[reanalyze] 结束时间: ${getBeijingLocaleString()}`);
    console.log(`[reanalyze] 数据已保存至: ${dataFile}`);
    return {
        success: stats.success,
        failed: finalPayload.stats.reanalyzeFailed,
        total: papers.length,
        status,
        digestStatusUpdated,
        exitCode: getAnalysisExitCode(status)
    };
}

if (require.main === module) {
    requireExternalRuntime('reanalyze.js', { enforceWorkspaceRole: true });
    setupScriptLogging(__filename);
    loadEnvFile();

    const requiredEnvVars = ['PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_MODEL', 'PAPER_ANALYZER_ENDPOINT'];
    const missingEnvVars = requiredEnvVars.filter(name => !process.env[name]);
    if (missingEnvVars.length > 0) {
        console.error('[reanalyze] 错误: 缺少必需环境变量');
        console.error(`[reanalyze] 缺少: ${missingEnvVars.join(', ')}`);
        console.error('[reanalyze] 请在项目根目录的 .env 文件中配置后重试');
        writeStageSummary({
            stage: '分析', status: 'error',
            message: `缺少必需环境变量: ${missingEnvVars.join(', ')}`
        });
        printErrorGuidance(Object.assign(new Error(`缺少必需环境变量: ${missingEnvVars.join(', ')}`), { code: 'ENV_MISSING' }),
            { stage: 'reanalyze' });
        process.exit(1);
    }

    // 解析命令行参数：严格白名单，未知 --flag（例如少了 s 的
    // --retry-failed-reader）直接报用法并退出非零，不能静默退化成普通重分析。
    let dataFileArg = null;
    let concurrencyArg = null;
    try {
        ({ dataFile: dataFileArg, concurrency: concurrencyArg } = parseReanalyzeCliArgs(process.argv.slice(2)));
    } catch (error) {
        console.error(`[reanalyze] 错误: ${error.message}`);
        process.exit(1);
    }

    // 并发度：命令行 > 环境变量 > 配置默认值。非法值直接停止，不能像旧实现那样
    // 用 parseInt 截断小数，或把无效的 PD_REANALYZE_CONCURRENCY 静默换成默认值。
    let cliConcurrency;
    try {
        cliConcurrency = parseReanalyzeConcurrency({
            cliValue: concurrencyArg,
            envValue: process.env.PD_REANALYZE_CONCURRENCY,
            fallback: Config.ANALYSIS_CONFIG.concurrency
        });
    } catch (error) {
        console.error(`[reanalyze] 错误: ${error.message}`);
        writeStageSummary({ stage: '分析', status: 'error', message: `并发参数非法: ${error.message}` });
        printErrorGuidance(Object.assign(new Error(error.message),
            { code: 'INVALID_CONCURRENCY' }), { stage: 'reanalyze' });
        process.exit(1);
    }

    reanalyzeAll({
        dataFile: dataFileArg || Config.FILES.deepAnalysisResult,
        concurrency: cliConcurrency
    }).then(result => {
        if (result.status === 'complete') {
            console.log('\n[reanalyze] 文本重新分析已完成，可以继续生成、审查和发布博客');
        } else {
            console.error(`\n[reanalyze] 还有 ${result.failed} 篇未完成分析，本批次尚未完成`);
        }
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error('[reanalyze] 错误:', err);
        writeStageSummary({
            stage: '分析', status: 'error', date: currentReanalyzeBatchDate,
            elapsedMs: Date.now() - currentReanalyzeStageStartedAt,
            message: `入口失败: ${redactSensitive(err.message)}`
        });
        printErrorGuidance(err, { stage: 'reanalyze' });
        process.exitCode = 1;
    });
}

module.exports = { reanalyzeAll };
