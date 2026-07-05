#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 仅运行深度分析（从已有筛选结果续跑）
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const path = require('path');
const { loadEnvFile, writeFileAtomic, readJsonSafe, getBeijingISOString } = require('./utils.js');
const { analyzeBatch } = require('./analysis-engine.js');
const Config = require('./config.js');

loadEnvFile();

async function runDeepAnalysis() {
    console.log('=== 仅运行深度分析 ===\n');

    const currentPath = path.join(__dirname, '../data/current/deep-analysis-result.json');
    const legacyPath = path.join(__dirname, '../data/deep-analysis-result.json');
    const filteredPath = path.join(__dirname, '../data/current/filtered-papers.json');
    const resultPath = fs.existsSync(currentPath) || !fs.existsSync(legacyPath) ? currentPath : legacyPath;

    let existingData = null;
    if (fs.existsSync(resultPath)) {
        existingData = readJsonSafe(resultPath, null);
        if (!existingData) {
            console.error('❌ 读取分析结果文件失败，文件可能损坏');
            process.exit(1);
        }
    } else if (fs.existsSync(filteredPath)) {
        const filteredData = readJsonSafe(filteredPath, null);
        const filteredPapers = filteredData && Array.isArray(filteredData.papers) ? filteredData.papers : [];
        existingData = {
            timestamp: getBeijingISOString(),
            source: filteredPath,
            stats: filteredData?.stats || {},
            papers: filteredPapers
        };
        writeFileAtomic(resultPath, JSON.stringify(existingData, null, 2));
        console.log(`📄 未找到分析结果，已从筛选结果初始化: ${filteredPath}`);
    } else {
        console.error('❌ 找不到分析结果文件或筛选结果文件，请先运行 full-fetch.js 完成筛选');
        process.exit(1);
    }

    const papers = Array.isArray(existingData) ? existingData : (existingData.papers || []);
    const analyzedCount = papers.filter(p => p.analysis).length;
    console.log(`📊 读取到 ${papers.length} 篇筛选后的论文 (已分析: ${analyzedCount})\n`);

    const notAnalyzed = papers.filter(p => !p.analysis);
    if (notAnalyzed.length === 0) {
        console.log('✅ 所有论文已分析完成！');
        return;
    }

    const { stats } = await analyzeBatch(notAnalyzed, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: Config.ANALYSIS_CONFIG.concurrency,
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
        onSave: async (results, saveStats) => {
            // results 里已经是 paper 对象（analysis-engine.js 解包过 r.result）
            const resultMap = new Map();
            for (const r of results) {
                if (!r) continue;
                const key = r.arxivId || r.paper_id;
                if (key) resultMap.set(key, r);
            }
            for (let i = 0; i < papers.length; i++) {
                const key = papers[i].arxivId || papers[i].paper_id;
                if (resultMap.has(key)) {
                    papers[i] = { ...papers[i], ...resultMap.get(key) };
                }
            }
            // 直接写入文件，不走 createFileSaver 的合并逻辑
            const output = {
                ...existingData,
                lastUpdated: getBeijingISOString(),
                papers: papers,
                stats: { ...existingData?.stats, ...saveStats }
            };
            writeFileAtomic(resultPath, JSON.stringify(output, null, 2));
            console.log(`  💾 已保存 (${saveStats.success + saveStats.failed}/${notAnalyzed.length})`);
        }
    });

    // 最终保存
    const isLegacyArray = Array.isArray(existingData);
    const finalPayload = isLegacyArray
        ? {
            papers,
            deepAnalysisCompletedAt: getBeijingISOString(),
            stats: {
                analyzedSuccess: stats.success,
                analyzedFailed: stats.failed
            }
        }
        : {
            ...existingData,
            papers,
            deepAnalysisCompletedAt: getBeijingISOString(),
            stats: {
                ...existingData.stats,
                analyzedSuccess: stats.success,
                analyzedFailed: stats.failed
            }
        };
    writeFileAtomic(resultPath, JSON.stringify(finalPayload, null, 2));

    console.log('\n✅ 深度分析完成！');
    console.log(`📊 统计:`);
    console.log(`  - 总计: ${papers.length} 篇`);
    console.log(`  - 成功: ${stats.success} 篇`);
    console.log(`  - 失败: ${stats.failed} 篇`);
    console.log(`  - 跳过: ${stats.skipped} 篇`);
    console.log(`💾 结果已保存到: ${resultPath}`);
}

runDeepAnalysis().catch(err => {
    console.error(`❌ 失败: ${err.message}`);
    process.exit(1);
});
