#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

const path = require('path');
const { loadEnvFile, getBeijingISOString, getBeijingDateString, normalizedId } = require('./utils.js');
loadEnvFile();

const { filterPapersWithLLM } = require('./fetch-papers.js');
const {
    analyzeBatch,
    readJsonFileStrict,
    updateJsonFileLocked,
    mergePapersById,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getAnalysisExitCode
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses, validatePapersDatabaseSchema } = require('./digest-status.js');
const Config = require('./config.js');

function validateTargetDate(targetDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '')) {
        throw new Error(`无效目标日期: ${targetDate || '(空)'}`);
    }
    const [year, month, day] = targetDate.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error(`无效目标日期: ${targetDate}`);
    }
    return targetDate;
}

function isPathInside(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveResultFileForTargetDate(targetDate, options = {}) {
    validateTargetDate(targetDate);
    const today = options.today || getBeijingDateString();
    const currentFile = path.resolve(options.currentFile || Config.FILES.deepAnalysisResult);
    const archiveDir = path.resolve(options.archiveDir || Config.ARCHIVE_DIR);
    const defaultFile = targetDate === today
        ? currentFile
        : path.join(archiveDir, targetDate, 'deep-analysis-result.json');
    const resultFile = path.resolve(options.resultFile || defaultFile);
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const legacyCurrentFile = path.resolve(options.legacyCurrentFile || Config.FILES.deepAnalysisResultLegacy);
    if (targetDate === today) {
        if (!isPathInside(currentDir, resultFile) || resultFile === legacyCurrentFile) {
            throw new Error(`今日批次 ${targetDate} 的输出必须位于 current 目录: ${resultFile}`);
        }
    } else {
        const targetArchiveDir = path.join(archiveDir, targetDate);
        if (!isPathInside(targetArchiveDir, resultFile)) {
            throw new Error(`历史批次 ${targetDate} 的输出必须位于对应 archive 日期目录: ${resultFile}`);
        }
    }
    return resultFile;
}

function parseCliArgs(argv) {
    const args = [...argv];
    const targetDate = args.shift();
    let resultFile;
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--output' && args.length > 0) {
            resultFile = args.shift();
            continue;
        }
        throw new Error(`未知参数或缺少参数值: ${arg}`);
    }
    return { targetDate, resultFile };
}

function saveSuccessfulResultsById(resultFile, attemptResults, metadata = {}) {
    return updateJsonFileLocked(resultFile, current => {
        const existingPapers = Array.isArray(current) ? current : (current?.papers || []);
        const validatedResults = (attemptResults || []).filter(Boolean);
        const batchDate = metadata.batchDate || metadata.date;
        const batchTimestamp = batchDate
            ? (current?.timestamp?.startsWith(batchDate) ? current.timestamp : `${batchDate}T00:00:00+08:00`)
            : current?.timestamp;
        const shouldFinalize = metadata.finalize === true || metadata.refilterStatus === 'complete';
        const expectedItems = metadata.expectedIds
            || (metadata.refilterStatus === 'complete' ? validatedResults : []);
        const expectedIds = new Set(expectedItems
            .map(item => normalizedId(item))
            .filter(Boolean));
        const mergedPapers = mergePapersById(existingPapers, validatedResults, { preserveSuccessfulAnalysis: true });
        const mergedById = new Map(mergedPapers.map(paper => [normalizedId(paper), paper]));
        let successfulExpected = 0;
        for (const id of expectedIds) {
            if (isSuccessfulAnalysisRecord(mergedById.get(id))) successfulExpected++;
        }
        const remainingFailed = expectedIds.size - successfulExpected;
        const finalStatus = shouldFinalize
            ? getAnalysisRunStatus({ success: successfulExpected }, remainingFailed)
            : metadata.refilterStatus;
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            ...(batchTimestamp ? { timestamp: batchTimestamp } : {}),
            ...(batchDate ? { batchDate } : {}),
            ...(finalStatus ? { status: finalStatus } : {}),
            lastUpdated: getBeijingISOString(),
            papers: mergedPapers,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                ...metadata,
                ...(shouldFinalize ? {
                    refilterStatus: finalStatus,
                    expected: expectedIds.size,
                    successfulExpected,
                    remainingFailed
                } : {})
            }
        };
        if (shouldFinalize && finalStatus === 'complete') {
            payload.deepAnalysisCompletedAt = getBeijingISOString();
        } else if (finalStatus) {
            delete payload.deepAnalysisCompletedAt;
        }
        return payload;
    });
}

async function main(targetDate, options = {}) {
    validateTargetDate(targetDate);
    console.log(`=== 重新处理 ${targetDate} 的论文 ===\n`);
    const resultFile = resolveResultFileForTargetDate(targetDate, options);
    const filterFn = options.filterFn || filterPapersWithLLM;
    const analyzeBatchFn = options.analyzeBatchFn || analyzeBatch;
    const digestStatusUpdater = options.digestStatusUpdater || updateAnalysisDigestStatuses;

    // 1. 从 papers.json 提取目标日期的论文
    const papersPath = options.papersPath || Config.FILES.papers;
    const papersData = validatePapersDatabaseSchema(readJsonFileStrict(papersPath));
    const allPapers = papersData.papers;
    const targetPapers = [];
    for (const [key, paper] of Object.entries(allPapers)) {
        if (!paper || typeof paper !== 'object') continue;
        const fetched = paper.fetchedAt || '';
        const paperBatchDate = paper.digestStatus?.batchDate || fetched.slice(0, 10);
        if (paperBatchDate === targetDate) {
            targetPapers.push({
                ...paper,
                paper_id: paper.paper_id || paper.arxivId || key,
                arxivId: paper.arxivId || paper.paper_id || key,
                title: paper.title || '',
                abstract: paper.abstract || paper.summary || '',
                categories: paper.categories || [],
                authors: paper.authors || [],
                fetchedAt: fetched,
                published: paper.published || '',
                sources: paper.sources || ['arxiv']
            });
        }
    }
    console.log(`📄 找到 ${targetPapers.length} 篇论文\n`);

    if (targetPapers.length === 0) {
        console.log('没有需要处理的论文');
        saveSuccessfulResultsById(resultFile, [], {
            date: targetDate,
            expectedIds: [],
            finalize: true,
            refilterAt: getBeijingISOString()
        });
        return { status: 'complete', exitCode: 0, success: 0, failed: 0 };
    }

    // 2. LLM 筛选（减小批次避免 API 过载）
    console.log('🔍 开始 LLM 筛选...');
    const filtered = await filterFn(targetPapers, {
        batchSize: 3,
        delayBetweenBatches: 3000
    });
    const filterStats = filtered?._filterStats;
    if (filterStats?.complete !== true) {
        const failed = Math.max(1, Number(filterStats?.retryable)
            || Math.max(0, targetPapers.length - (Number(filterStats?.decided) || 0)));
        saveSuccessfulResultsById(resultFile, [], {
            date: targetDate,
            refilterStatus: 'filter_failed',
            refilterAt: getBeijingISOString(),
            filterStats: filterStats || null
        });
        console.error(`❌ 筛选未完成：明确决定 ${filterStats?.decided || 0}/${filterStats?.totalCandidates || targetPapers.length}，待重试 ${failed} 篇`);
        return { status: 'filter_failed', exitCode: 1, success: 0, failed };
    }
    console.log(`✅ 筛选完成: ${targetPapers.length} → ${filtered.length} 篇\n`);
    if (filtered.length === 0) {
        console.log('没有通过筛选的论文，无需分析');
        saveSuccessfulResultsById(resultFile, [], {
            date: targetDate,
            expectedIds: [],
            finalize: true,
            refilterAt: getBeijingISOString(),
            filterStats
        });
        return { status: 'complete', exitCode: 0, success: 0, failed: 0 };
    }

    // 3. 深度分析
    console.log('🔬 开始深度分析...');
    const expectedIds = filtered.map(paper => normalizedId(paper)).filter(Boolean);
    const attempts = [];
    saveSuccessfulResultsById(resultFile, [], {
        date: targetDate,
        expectedIds,
        refilterStatus: 'running',
        refilterAt: getBeijingISOString()
    });
    const batchResult = await analyzeBatchFn(filtered, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        onBatchDone: (batchIndex, batchResults) => {
            const batchAttempts = batchResults
                .filter(result => result && !result.skipped)
                .map(result => result.result || result);
            attempts.push(...batchAttempts);
            const successful = batchAttempts.filter(isSuccessfulAnalysisRecord);
            saveSuccessfulResultsById(resultFile, batchAttempts, {
                date: targetDate,
                expectedIds,
                refilterStatus: 'running',
                refilterSavedBatches: batchIndex,
                refilterSucceeded: attempts.filter(isSuccessfulAnalysisRecord).length,
                refilterFailed: attempts.filter(result => !isSuccessfulAnalysisRecord(result)).length
            });
            digestStatusUpdater(batchAttempts, { batchDate: targetDate });
            console.log(`💾 第 ${batchIndex} 批已增量保存: 成功 ${successful.length} 篇`);
        }
    });

    const allResults = batchResult.results || [];
    // analyzeBatch 内部 unwrap 了 { success, result, parsed } → 直接返回 paper 对象
    // 成功/失败统计从 stats 获取
    const attemptStatus = getAnalysisRunStatus(batchResult.stats, batchResult.stats?.failed || 0);
    console.log(`${attemptStatus === 'complete' ? '✅' : '⚠️'} 分析状态: ${attemptStatus} | 成功 ${batchResult.stats?.success ?? allResults.length} | 失败 ${batchResult.stats?.failed || 0}`);

    const payload = saveSuccessfulResultsById(resultFile, allResults, {
        date: targetDate,
        expectedIds,
        finalize: true,
        analyzed: batchResult.stats?.success || 0,
        failed: batchResult.stats?.failed || 0,
        refilterAt: getBeijingISOString()
    });
    const status = payload.status;
    console.log(`💾 结果已保存: ${resultFile} (共 ${payload.papers.length} 篇，旧成功结果未被失败尝试覆盖)`);

    const digestUpdate = digestStatusUpdater(attempts, { batchDate: targetDate });
    console.log(`💾 papers.json digestStatus 已同步: ${digestUpdate.updated} 篇`);
    if (status !== 'complete') console.error(`❌ 重筛分析尚有 ${batchResult.stats?.failed || 0} 篇未恢复`);
    return {
        status,
        exitCode: getAnalysisExitCode(status),
        success: payload.stats.successfulExpected,
        failed: payload.stats.remainingFailed
    };
}

if (require.main === module) {
    let cli;
    try {
        cli = parseCliArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
    if (cli && !cli.targetDate) {
        console.error('用法: node scripts/refilter-reanalyze-by-date.js <YYYY-MM-DD> [--output <安全路径>]');
        process.exitCode = 1;
    } else if (cli) {
        main(cli.targetDate, { resultFile: cli.resultFile }).then(result => {
            process.exitCode = result.exitCode;
        }).catch(err => {
            console.error('脚本执行失败:', err);
            process.exitCode = 1;
        });
    }
}

module.exports = {
    main,
    saveSuccessfulResultsById,
    validateTargetDate,
    resolveResultFileForTargetDate,
    parseCliArgs
};
