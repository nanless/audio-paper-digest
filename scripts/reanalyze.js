#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 重新分析已有论文
 * 使用 analysis-engine.js 统一封装的批量分析与保存逻辑
 */

const fs = require('fs');
const path = require('path');
const { loadEnvFile, getBeijingISOString, getBeijingLocaleString, writeFileAtomic, readJsonSafe, normalizedId } = require('./utils.js');
const { analyzeBatch } = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');

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

const DEFAULT_CURRENT_FILE = path.join(__dirname, '..', 'data', 'current', 'deep-analysis-result.json');
const DEFAULT_LEGACY_FILE = path.join(__dirname, '..', 'data', 'deep-analysis-result.json');
const DATA_FILE = dataFileArg || (fs.existsSync(DEFAULT_CURRENT_FILE) || !fs.existsSync(DEFAULT_LEGACY_FILE) ? DEFAULT_CURRENT_FILE : DEFAULT_LEGACY_FILE);

// 并发度：命令行 > 环境变量 > 配置默认值
const Config = require('./config.js');
const CONCURRENCY = concurrencyArg || parseInt(process.env.PD_REANALYZE_CONCURRENCY, 10) || Config.ANALYSIS_CONFIG.concurrency;

async function reanalyzeAll() {
    console.log(`[reanalyze] 读取数据文件: ${DATA_FILE}`);

    if (!fs.existsSync(DATA_FILE)) {
        console.error(`[reanalyze] ❌ 文件不存在: ${DATA_FILE}`);
        process.exit(1);
    }

    const data = readJsonSafe(DATA_FILE, null);
    if (!data) {
        console.error('[reanalyze] ❌ 读取数据文件失败，文件可能损坏');
        process.exit(1);
    }

    const papers = Array.isArray(data) ? data : (data.papers || []);
    console.log(`[reanalyze] 共 ${papers.length} 篇论文需要重新分析`);
    console.log(`[reanalyze] 模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    console.log(`[reanalyze] 并发度: ${CONCURRENCY}`);
    console.log(`[reanalyze] 开始时间: ${getBeijingLocaleString()}`);
    console.log('');

    // 保存中间结果的辅助函数
    const isLegacyArray = Array.isArray(data);
    const batchDate = (data.timestamp || data.lastUpdated || getBeijingISOString()).slice(0, 10);
    const doSave = () => {
        const payload = isLegacyArray
            ? { papers, timestamp: getBeijingISOString() }
            : data;
        if (!isLegacyArray) {
            payload.timestamp = getBeijingISOString();
        }
        writeFileAtomic(DATA_FILE, JSON.stringify(payload, null, 2));
        return updateAnalysisDigestStatuses(papers, { batchDate });
    };

    // 预先建立 ID -> 索引映射，避免并发时 findIndex 可能找到错误位置
    const paperIndexMap = new Map(papers.map((p, i) => [normalizedId(p), i]).filter(([key]) => key));

    const { stats } = await analyzeBatch(papers, {
        concurrency: CONCURRENCY,
        maxRetries: 2,
        retryDelayMs: 2000,
        saveInterval: 5 * CONCURRENCY,         // 按并发度调整保存间隔
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
        },
        onSave: (results, saveStats) => {
            const processed = saveStats.success + saveStats.failed;
            const digestStatus = doSave();
            const statusNote = digestStatus.updated > 0 ? `，papers.json 状态 ${digestStatus.updated} 篇` : '';
            console.log(`[reanalyze] 💾 中间结果已保存 (${processed}/${papers.length})${statusNote}`);
        }
    });

    // 最终保存
    const finalPayload = isLegacyArray
        ? { papers, timestamp: getBeijingISOString() }
        : data;
    if (!isLegacyArray) {
        finalPayload.timestamp = getBeijingISOString();
        finalPayload.stats = {
            ...data.stats,
            reanalyzed: stats.success,
            reanalyzeFailed: stats.failed,
            reanalyzeAt: getBeijingISOString()
        };
    }
    writeFileAtomic(DATA_FILE, JSON.stringify(finalPayload, null, 2));
    const digestStatus = updateAnalysisDigestStatuses(papers, { batchDate });

    console.log('');
    console.log(`[reanalyze] ════════════════════════════════════════════`);
    console.log(`[reanalyze] 重新分析完成`);
    console.log(`[reanalyze] 成功: ${stats.success} | 失败: ${stats.failed} | 总计: ${papers.length}`);
    if (digestStatus.updated > 0) console.log(`[reanalyze] papers.json 状态已同步: ${digestStatus.updated} 篇`);
    console.log(`[reanalyze] 结束时间: ${getBeijingLocaleString()}`);
    console.log(`[reanalyze] 数据已保存至: ${DATA_FILE}`);

    return { success: stats.success, failed: stats.failed, total: papers.length };
}

reanalyzeAll().then(result => {
    console.log('\n[reanalyze] 重新分析完成，请运行 publish-to-blog.py 更新博客');
    // 部分失败是正常情况，不返回错误码
    process.exit(0);
}).catch(err => {
    console.error('[reanalyze] 错误:', err);
    process.exit(1);
});
