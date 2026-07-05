#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 重新分析指定论文
 * 用法: node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, getBeijingISOString, writeFileAtomic } = require('./utils.js');
const { analyzeBatch } = require('./analysis-engine.js');
const Config = require('./config.js');

const RESULT_FILE = Config.FILES.deepAnalysisResult;

async function reanalyzeSelected(ids) {
    console.log(`=== 重新分析 ${ids.length} 篇论文 ===\n`);

    const data = readJsonSafe(RESULT_FILE, null);
    if (!data) {
        console.error('❌ 读取结果文件失败');
        process.exit(1);
    }

    const papers = data.papers || [];

    // 找到目标论文，清除旧的 analysis
    const toReanalyze = [];
    const idSet = new Set(ids);

    for (const p of papers) {
        const aid = p.arxivId || p.paper_id || '';
        if (idSet.has(aid)) {
            // 清除旧分析结果但保留论文基本信息
            const cleanPaper = {
                ...p,
                analysis: undefined,
                parsed: undefined,
                error: undefined
            };
            delete cleanPaper.analysis;
            delete cleanPaper.parsed;
            delete cleanPaper.error;
            toReanalyze.push(cleanPaper);
        }
    }

    if (toReanalyze.length === 0) {
        console.log('⚠️ 没有找到需要重跑的论文');
        return;
    }

    console.log(`找到 ${toReanalyze.length} 篇需要重跑的论文:`);
    for (const p of toReanalyze) {
        console.log(`  - ${p.arxivId}: ${p.title?.substring(0, 60)}...`);
    }
    console.log();

    // 重新分析
    const analyzedResults = [];
    const { stats } = await analyzeBatch(toReanalyze, {
        concurrency: 3,
        maxRetries: 2,
        retryDelayMs: 3000,
        saveInterval: 1,
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${total}] ▶ 开始: ${paper.title?.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '[N/A]';
                console.log(`  [${idx + 1}/${total}] ✅ 完成 ${score} | ${durSec}s`);
                analyzedResults.push(result.result);
            } else {
                console.log(`  [${idx + 1}/${total}] ❌ 失败 | ${durSec}s | ${result.error}`);
            }
        },
        onSave: async (results) => {
            // 增量保存分析进度
            const mergedMap = new Map();
            for (const p of papers) {
                const key = p.arxivId || p.paper_id;
                if (key) mergedMap.set(key, p);
            }
            for (const r of results) {
                if (!r) continue;
                const key = r.arxivId || r.paper_id;
                if (key) mergedMap.set(key, r);
            }
            data.papers = Array.from(mergedMap.values());
            data.lastUpdated = getBeijingISOString();
            writeFileAtomic(RESULT_FILE, JSON.stringify(data, null, 2));
        }
    });

    // 合并结果：用新结果替换旧结果
    const mergedMap = new Map();
    for (const p of papers) {
        const key = p.arxivId || p.paper_id;
        if (key) mergedMap.set(key, p);
    }

    for (const p of analyzedResults) {
        const key = p.arxivId || p.paper_id;
        if (key) mergedMap.set(key, p);
    }

    data.papers = Array.from(mergedMap.values());
    data.timestamp = getBeijingISOString();

    writeFileAtomic(RESULT_FILE, JSON.stringify(data, null, 2));

    console.log(`\n✅ 重分析完成: 成功 ${stats.success} | 失败 ${stats.failed}`);
    console.log(`💾 结果已保存到: ${RESULT_FILE}`);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
    console.error('❌ 用法: node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...');
    process.exit(1);
}

reanalyzeSelected(ids).catch(err => {
    console.error('❌ 错误:', err);
    process.exit(1);
});
