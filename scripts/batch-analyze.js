#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 批量分析论文 - 读取 deep-analysis-result.json 中未分析的论文
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const { loadEnvFile, getBeijingISOString } = require('./utils.js');
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

const LEGACY_RESULT_FILE = Config.FILES.deepAnalysisResultLegacy;
const RESULT_FILE = fs.existsSync(Config.FILES.deepAnalysisResult) || !fs.existsSync(LEGACY_RESULT_FILE)
    ? Config.FILES.deepAnalysisResult
    : LEGACY_RESULT_FILE;

async function main() {
    console.log('=== 批量论文分析 ===');
    console.log(`数据文件: ${RESULT_FILE}`);

    const data = readJsonFileStrict(RESULT_FILE);

    const papers = Array.isArray(data) ? data : (data.papers || []);
    console.log(`总论文数: ${papers.length}`);

    const notAnalyzed = papers.filter(p => !isSuccessfulAnalysisRecord(p));
    console.log(`未分析论文: ${notAnalyzed.length}`);

    if (notAnalyzed.length === 0) {
        updateJsonFileLocked(RESULT_FILE, current => ({
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            deepAnalysisCompletedAt: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'complete', remainingFailed: 0 }
        }));
        console.log('所有论文已分析完成！');
        return { status: 'complete', exitCode: 0, stats: { success: 0, failed: 0, skipped: papers.length } };
    }

    updateJsonFileLocked(RESULT_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            lastUpdated: getBeijingISOString(),
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), analysisStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const { stats } = await analyzeBatch(notAnalyzed, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 1,
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
        onSave: async (results, saveStats) => {
            const attemptedResults = results.filter(Boolean);
            const processed = saveStats.success + saveStats.failed;
            const progressStatus = processed < notAnalyzed.length
                ? 'running'
                : getAnalysisRunStatus(saveStats);
            const output = updateJsonFileLocked(RESULT_FILE, current => ({
                ...(!Array.isArray(current) && current ? current : {}),
                lastUpdated: getBeijingISOString(),
                papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), attemptedResults, { preserveSuccessfulAnalysis: true }),
                stats: {
                    ...(!Array.isArray(current) ? current?.stats : {}),
                    ...saveStats,
                    analysisStatus: progressStatus
                }
            }));
            papers.splice(0, papers.length, ...(output.papers || []));
            const digestStatus = updateAnalysisDigestStatuses(attemptedResults, {
                batchDate: (data.timestamp || data.lastUpdated || getBeijingISOString()).slice(0, 10)
            });
            const statusNote = digestStatus.updated > 0 ? `，papers.json 状态 ${digestStatus.updated} 篇` : '';
            console.log(`   已保存到 ${RESULT_FILE}${statusNote}`);
        }
    });

    console.log('\n=== 批量分析完成 ===');
    console.log(`成功: ${stats.success} | 失败: ${stats.failed} | 总计处理: ${notAnalyzed.length}`);
    const finalPayload = updateJsonFileLocked(RESULT_FILE, current => {
        const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
        const remaining = currentPapers.filter(p => !isSuccessfulAnalysisRecord(p)).length;
        const status = getAnalysisRunStatus(stats, remaining);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: currentPapers,
            lastUpdated: getBeijingISOString(),
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

module.exports = { main };
