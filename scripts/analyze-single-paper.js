#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 单独分析一篇论文并合并到结果中
 * 使用 analysis-engine.js 统一封装的分析逻辑
 * 用法: node scripts/analyze-single-paper.js <arxiv_id>
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, getBeijingISOString, writeFileAtomic, normalizedId } = require('./utils.js');
const { analyzePaperWithRetry } = require('./analysis-engine.js');
const Config = require('./config.js');

const TARGET_ARXIV_ID = process.argv[2];
const TARGET_NORMALIZED_ID = normalizedId(TARGET_ARXIV_ID);

if (!TARGET_ARXIV_ID) {
    console.error('❌ 用法: node scripts/analyze-single-paper.js <arxiv_id>');
    console.error('   示例: node scripts/analyze-single-paper.js 2604.16044');
    process.exit(1);
}

async function analyzeSinglePaper() {
    console.log(`=== 单独分析论文 ${TARGET_ARXIV_ID} ===\n`);

    const papersPath = Config.FILES.papers;
    const papersData = readJsonSafe(papersPath, { papers: {} });
    const allPapers = papersData.papers || papersData;

    let targetPaper = null;
    for (const [key, paper] of Object.entries(allPapers)) {
        if (paper && (normalizedId(paper) === TARGET_NORMALIZED_ID || normalizedId(key) === TARGET_NORMALIZED_ID)) {
            targetPaper = paper;
            break;
        }
    }

    if (!targetPaper) {
        console.error(`❌ 在 papers.json 中找不到 ${TARGET_ARXIV_ID}`);
        process.exit(1);
    }

    console.log(`📄 找到论文: ${targetPaper.title || '(无标题)'}\n`);

    const resultPath = Config.FILES.deepAnalysisResult;
    const existingData = readJsonSafe(resultPath, { papers: [], stats: {} });

    const papersList = Array.isArray(existingData) ? existingData : (existingData.papers || []);
    const alreadyExists = papersList.some(p => normalizedId(p) === TARGET_NORMALIZED_ID);
    if (alreadyExists) {
        console.log('⚠️ 该论文已在分析结果中，跳过');
        process.exit(0);
    }

    console.log('🔬 开始深度分析...');
    const r = await analyzePaperWithRetry(targetPaper, {
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        onAttempt: (attempt, max) => {
            if (attempt > 0) console.log(`    🔄 第 ${attempt + 1} 次尝试...`);
        }
    });

    if (r.success) {
        let payload;
        if (Array.isArray(existingData)) {
            // 兼容旧格式：将纯数组转换为新对象格式
            payload = { papers: [...existingData, r.result], lastUpdated: getBeijingISOString() };
        } else {
            payload = existingData;
            payload.papers = payload.papers || [];
            payload.papers.push(r.result);
            payload.lastUpdated = getBeijingISOString();
        }
        writeFileAtomic(resultPath, JSON.stringify(payload, null, 2));
        console.log(`    ✅ 成功！已合并到分析结果中`);
        console.log(`    📊 当前总数: ${payload.papers.length} 篇`);
    } else {
        console.log(`    ❌ 最终失败: ${r.error}`);
        process.exit(1);
    }
}

analyzeSinglePaper().catch(err => {
    console.error('脚本执行失败:', err);
    process.exit(1);
});
