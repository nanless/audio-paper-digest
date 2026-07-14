#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 仅运行深度分析（从已有筛选结果续跑）
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const { loadEnvFile, getBeijingISOString, getBeijingDateString, getRecordDate, normalizedId } = require('./utils.js');
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

loadEnvFile();

function validateCompleteFilteredForToday(filteredData, today) {
    if (!filteredData || filteredData.status !== 'complete' || !Array.isArray(filteredData.papers)) {
        throw new Error('筛选结果未完成或 papers 字段无效，拒绝启动深度分析');
    }
    const recordDate = getRecordDate(filteredData);
    if (recordDate !== today) {
        throw new Error(`筛选结果不是当日批次: 期望 ${today}，实际 ${recordDate || '未知'}`);
    }
    return filteredData;
}

function validateDeepAnalysisInput(existingData, filteredData, today) {
    if (getRecordDate(existingData) !== today) {
        throw new Error(`分析结果不是当日批次: 期望 ${today}，实际 ${getRecordDate(existingData) || '未知'}`);
    }
    const existingPapers = Array.isArray(existingData) ? existingData : (existingData?.papers || []);
    const expectedIds = new Set(filteredData.papers.map(normalizedId).filter(Boolean));
    const actualIds = new Set(existingPapers.map(normalizedId).filter(Boolean));
    const missing = [...expectedIds].filter(id => !actualIds.has(id));
    const unexpected = [...actualIds].filter(id => !expectedIds.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(`分析结果与当日筛选结果不一致: 缺少 ${missing.length} 篇，多出 ${unexpected.length} 篇`);
    }
    return existingData;
}

async function runDeepAnalysis() {
    console.log('=== 仅运行深度分析 ===\n');

    const currentPath = Config.FILES.deepAnalysisResult;
    const legacyPath = Config.FILES.deepAnalysisResultLegacy;
    const filteredPath = Config.FILES.filteredPapers;
    const today = getBeijingDateString();
    const filteredData = validateCompleteFilteredForToday(readJsonFileStrict(filteredPath), today);

    const resultPath = currentPath;

    if (!fs.existsSync(currentPath) && fs.existsSync(legacyPath)) {
        const legacyData = validateDeepAnalysisInput(readJsonFileStrict(legacyPath), filteredData, today);
        updateJsonFileLocked(currentPath, () => Array.isArray(legacyData)
            ? { timestamp: getBeijingISOString(), source: legacyPath, papers: legacyData }
            : legacyData);
        console.log(`📦 已将 legacy 分析结果迁移到权威路径: ${currentPath}`);
    }

    let existingData = null;
    if (fs.existsSync(resultPath)) {
        existingData = validateDeepAnalysisInput(readJsonFileStrict(resultPath), filteredData, today);
    } else {
        const filteredPapers = filteredData.papers;
        existingData = {
            timestamp: getBeijingISOString(),
            source: filteredPath,
            stats: filteredData.stats || {},
            papers: filteredPapers
        };
        existingData = updateJsonFileLocked(resultPath, () => existingData);
        console.log(`📄 未找到分析结果，已从筛选结果初始化: ${filteredPath}`);
    }

    const papers = Array.isArray(existingData) ? existingData : (existingData.papers || []);
    const analyzedCount = papers.filter(isSuccessfulAnalysisRecord).length;
    console.log(`📊 读取到 ${papers.length} 篇筛选后的论文 (已分析: ${analyzedCount})\n`);

    const notAnalyzed = papers.filter(p => !isSuccessfulAnalysisRecord(p));
    if (notAnalyzed.length === 0) {
        updateAnalysisDigestStatuses(papers, { batchDate: today });
        updateJsonFileLocked(resultPath, current => ({
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            deepAnalysisCompletedAt: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'complete', remainingFailed: 0 }
        }));
        console.log('✅ 所有论文已分析完成！');
        return { status: 'complete', exitCode: 0, stats: { success: 0, failed: 0, skipped: papers.length } };
    }

    updateJsonFileLocked(resultPath, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            deepAnalysisLastAttemptAt: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const { stats } = await analyzeBatch(notAnalyzed, {
        checkpointFilePath: resultPath,
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: Config.ANALYSIS_CONFIG.concurrency,
        preparePaperLocked: paper => {
            const current = readJsonFileStrict(resultPath);
            const currentPapers = Array.isArray(current) ? current : (current.papers || []);
            const latest = currentPapers.find(item => normalizedId(item) === normalizedId(paper));
            if (isSuccessfulAnalysisRecord(latest)) return { paper: latest, skip: true };
            return { paper: latest || paper, skip: false };
        },
        onPaperResultLocked: async (paper, result) => {
            const attempted = result.result || { ...paper, analysis: null, parsed: null, error: result.error || '分析失败' };
            updateJsonFileLocked(resultPath, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), [attempted], { preserveSuccessfulAnalysis: true }),
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
            const progressStatus = processed < notAnalyzed.length
                ? 'running'
                : getAnalysisRunStatus(saveStats);
            const output = updateJsonFileLocked(resultPath, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                papers: Array.isArray(current) ? current : (current?.papers || []),
                stats: { ...(!Array.isArray(current) ? current?.stats : {}), ...saveStats, analysisStatus: progressStatus }
            }));
            papers.splice(0, papers.length, ...(output.papers || []));
            console.log(`  💾 已更新批次统计 (${saveStats.success + saveStats.failed}/${notAnalyzed.length})`);
        }
    });

    const finalPayload = updateJsonFileLocked(resultPath, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const remaining = currentPapers.filter(p => !isSuccessfulAnalysisRecord(p)).length;
        const status = getAnalysisRunStatus(stats, remaining);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            deepAnalysisLastAttemptAt: getBeijingISOString(),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analyzedSuccess: stats.success,
                analyzedFailed: stats.failed,
                remainingFailed: remaining,
                analysisStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const remaining = finalPayload.papers.filter(p => !isSuccessfulAnalysisRecord(p)).length;
    const status = getAnalysisRunStatus(stats, remaining);

    console.log(`\n${status === 'complete' ? '✅' : '⚠️'} 深度分析状态: ${status}`);
    console.log(`📊 统计:`);
    console.log(`  - 总计: ${papers.length} 篇`);
    console.log(`  - 成功: ${stats.success} 篇`);
    console.log(`  - 失败: ${stats.failed} 篇`);
    console.log(`  - 跳过: ${stats.skipped} 篇`);
    const sourceSummary = Object.entries(stats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
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

module.exports = { runDeepAnalysis, validateCompleteFilteredForToday, validateDeepAnalysisInput };
