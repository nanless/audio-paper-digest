#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 单独分析一篇论文并合并到结果中
 * 使用 analysis-engine.js 统一封装的分析逻辑
 * 用法: node scripts/analyze-single-paper.js <arxiv_id> [--force]
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, getBeijingISOString, writeFileAtomic, normalizedId } = require('./utils.js');
const { analyzePaperWithRetry } = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');
const Config = require('./config.js');

const args = process.argv.slice(2);
const FORCE_REANALYZE = args.includes('--force');
const TARGET_ARXIV_ID = args.find(arg => !arg.startsWith('--'));
const TARGET_NORMALIZED_ID = normalizedId(TARGET_ARXIV_ID);

if (!TARGET_ARXIV_ID) {
    console.error('❌ 用法: node scripts/analyze-single-paper.js <arxiv_id> [--force]');
    console.error('   示例: node scripts/analyze-single-paper.js 2604.16044 --force');
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
    const existingIndex = papersList.findIndex(p => normalizedId(p) === TARGET_NORMALIZED_ID);
    if (existingIndex >= 0 && !FORCE_REANALYZE) {
        console.log('⚠️ 该论文已在分析结果中，跳过（使用 --force 可强制重分析）');
        process.exit(0);
    }
    if (existingIndex >= 0 && FORCE_REANALYZE) {
        console.log('♻️ 该论文已存在，将强制重分析并替换旧结果');
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
            const nextPapers = [...existingData];
            if (existingIndex >= 0) nextPapers[existingIndex] = { ...nextPapers[existingIndex], ...r.result };
            else nextPapers.push(r.result);
            payload = { papers: nextPapers, lastUpdated: getBeijingISOString() };
        } else {
            payload = existingData;
            payload.papers = payload.papers || [];
            if (existingIndex >= 0) payload.papers[existingIndex] = { ...payload.papers[existingIndex], ...r.result };
            else payload.papers.push(r.result);
            payload.lastUpdated = getBeijingISOString();
        }
        writeFileAtomic(resultPath, JSON.stringify(payload, null, 2));
        const digestStatus = updateAnalysisDigestStatuses([r.result], {
            batchDate: getBeijingISOString().slice(0, 10)
        });
        console.log(`    ✅ 成功！已合并到分析结果中`);
        if (digestStatus.updated > 0) console.log(`    papers.json 状态已同步: ${digestStatus.updated} 篇`);
        console.log(`    📊 当前总数: ${payload.papers.length} 篇`);
    } else {
        const digestStatus = updateAnalysisDigestStatuses([r.result], {
            batchDate: getBeijingISOString().slice(0, 10)
        });
        console.log(`    ❌ 最终失败: ${r.error}`);
        if (digestStatus.updated > 0) console.log(`    papers.json 状态已同步: ${digestStatus.updated} 篇`);
        process.exit(1);
    }
}

analyzeSinglePaper().catch(err => {
    console.error('脚本执行失败:', err);
    process.exit(1);
});
