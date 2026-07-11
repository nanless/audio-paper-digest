#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 重新分析已有论文
 * 使用 analysis-engine.js 统一封装的批量分析与保存逻辑
 */

const fs = require('fs');
const { loadEnvFile, getBeijingISOString, getBeijingLocaleString, normalizedId } = require('./utils.js');
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

const requiredEnvVars = ['PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_MODEL', 'PAPER_ANALYZER_ENDPOINT'];
const missingEnvVars = requiredEnvVars.filter(name => !process.env[name]);
if (missingEnvVars.length > 0) {
    console.error('[reanalyze] 错误: 缺少必需环境变量');
    console.error(`[reanalyze] 缺少: ${missingEnvVars.join(', ')}`);
    console.error('[reanalyze] 请在项目根目录的 .env 文件中配置后重试');
    process.exit(1);
}

// 解析命令行参数
const args = process.argv.slice(2);
let dataFileArg = null;
let concurrencyArg = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--concurrency' && i + 1 < args.length) {
        concurrencyArg = parseInt(args[i + 1], 10);
        i++;
    } else if (!args[i].startsWith('--')) {
        dataFileArg = args[i];
    }
}

const DEFAULT_CURRENT_FILE = Config.FILES.deepAnalysisResult;
const DEFAULT_LEGACY_FILE = Config.FILES.deepAnalysisResultLegacy;
const DATA_FILE = dataFileArg || (fs.existsSync(DEFAULT_CURRENT_FILE) || !fs.existsSync(DEFAULT_LEGACY_FILE) ? DEFAULT_CURRENT_FILE : DEFAULT_LEGACY_FILE);

// 并发度：命令行 > 环境变量 > 配置默认值
const CONCURRENCY = concurrencyArg ?? (parseInt(process.env.PD_REANALYZE_CONCURRENCY, 10) || Config.ANALYSIS_CONFIG.concurrency);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
    console.error(`[reanalyze] 错误: --concurrency / PD_REANALYZE_CONCURRENCY 必须是正整数，收到: ${CONCURRENCY}`);
    process.exit(1);
}

function inferBatchDate(data, papers) {
    return data.batchDate
        || papers.map(p => p.digestStatus?.batchDate || String(p.fetchedAt || '').slice(0, 10)).find(Boolean)
        || String(data.timestamp || data.lastUpdated || getBeijingISOString()).slice(0, 10);
}

async function reanalyzeAll() {
    console.log(`[reanalyze] 读取数据文件: ${DATA_FILE}`);

    if (!fs.existsSync(DATA_FILE)) {
        console.error(`[reanalyze] ❌ 文件不存在: ${DATA_FILE}`);
        process.exit(1);
    }

    const data = readJsonFileStrict(DATA_FILE);

    const papers = Array.isArray(data) ? data : (data.papers || []);
    console.log(`[reanalyze] 共 ${papers.length} 篇论文需要重新分析`);
    console.log(`[reanalyze] 模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    console.log(`[reanalyze] 并发度: ${CONCURRENCY}`);
    console.log(`[reanalyze] 开始时间: ${getBeijingLocaleString()}`);
    console.log('');

    // 保存中间结果的辅助函数
    const batchDate = inferBatchDate(data, papers);
    const attemptResults = [];
    const doSave = () => {
        updateJsonFileLocked(DATA_FILE, current => ({
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: getBeijingISOString(),
            batchDate,
            papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), attemptResults, { preserveSuccessfulAnalysis: true })
        }));
        return updateAnalysisDigestStatuses(attemptResults, { batchDate });
    };

    // 预先建立 ID -> 索引映射，避免并发时 findIndex 可能找到错误位置
    const paperIndexMap = new Map(papers.map((p, i) => [normalizedId(p), i]).filter(([key]) => key));

    updateJsonFileLocked(DATA_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            timestamp: getBeijingISOString(),
            batchDate,
            stats: { ...(!Array.isArray(current) ? current?.stats : {}), reanalyzeStatus: 'running' }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const { stats } = await analyzeBatch(papers, {
        concurrency: CONCURRENCY,
        maxRetries: 2,
        retryDelayMs: 2000,
        saveInterval: 0,
        onPaperStart: (idx, total, paper) => {
            if (CONCURRENCY === 1) {
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
                attemptResults.push(result.result);
            } else if (!result.skipped) {
                attemptResults.push(result.result || {
                    ...paper,
                    analysis: null,
                    parsed: null,
                    error: result.error || '分析失败'
                });
            }
            if (CONCURRENCY > 1) {
                const status = result.success ? '✅' : '❌';
                console.log(`[reanalyze] ${status} [${idx + 1}/${total}] ${paper.arxivId} | ${result.parsed?.score || 'N/A'} | ${(duration/1000).toFixed(1)}s`);
            } else {
                if (result.success) {
                    console.log(`[reanalyze] ✅ 成功: ${paper.arxivId} | 评分: ${result.parsed?.score || 'N/A'}`);
                } else {
                    console.log(`[reanalyze] ❌ 失败: ${paper.arxivId} - ${result.error}`);
                }
            }
            if (!result.skipped) {
                const processed = attemptResults.length;
                const digestStatus = doSave();
                const statusNote = digestStatus.updated > 0 ? `，papers.json 状态 ${digestStatus.updated} 篇` : '';
                console.log(`[reanalyze] 💾 单篇结果已保存 (${processed}/${papers.length})${statusNote}`);
            }
        }
    });

    const status = getAnalysisRunStatus(stats, stats.failed);
    updateJsonFileLocked(DATA_FILE, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: getBeijingISOString(),
            papers: mergePapersById(Array.isArray(current) ? current : (current?.papers || []), attemptResults, { preserveSuccessfulAnalysis: true }),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                reanalyzed: stats.success,
                reanalyzeFailed: stats.failed,
                reanalyzeSourceCounts: stats.sourceCounts,
                reanalyzeAt: getBeijingISOString(),
                reanalyzeStatus: status
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = getBeijingISOString();
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
    const digestStatus = updateAnalysisDigestStatuses(attemptResults, { batchDate });

    console.log('');
    console.log(`[reanalyze] ════════════════════════════════════════════`);
    console.log(`[reanalyze] 重新分析状态: ${status}`);
    console.log(`[reanalyze] 成功: ${stats.success} | 失败: ${stats.failed} | 总计: ${papers.length}`);
    const sourceSummary = Object.entries(stats.sourceCounts || {})
        .map(([source, count]) => `${source}=${count}`)
        .join(' | ');
    if (sourceSummary) console.log(`[reanalyze] 文本来源: ${sourceSummary}`);
    if (digestStatus.updated > 0) console.log(`[reanalyze] papers.json 状态已同步: ${digestStatus.updated} 篇`);
    console.log(`[reanalyze] 结束时间: ${getBeijingLocaleString()}`);
    console.log(`[reanalyze] 数据已保存至: ${DATA_FILE}`);

    return { success: stats.success, failed: stats.failed, total: papers.length, status, exitCode: getAnalysisExitCode(status) };
}

if (require.main === module) {
    reanalyzeAll().then(result => {
        if (result.status === 'complete') {
            console.log('\n[reanalyze] 重新分析完成，请运行 publish-to-blog.py 更新博客');
        } else {
            console.error(`\n[reanalyze] 尚有 ${result.failed} 篇未恢复，禁止视为完整批次`);
        }
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error('[reanalyze] 错误:', err);
        process.exitCode = 1;
    });
}

module.exports = { reanalyzeAll };
