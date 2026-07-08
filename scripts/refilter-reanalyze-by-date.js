#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

const path = require('path');
const { loadEnvFile, readJsonSafe, getBeijingISOString, writeFileAtomic } = require('./utils.js');
loadEnvFile();

const { filterPapersWithLLM } = require('./fetch-papers.js');
const { analyzeBatch } = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');
const Config = require('./config.js');

const TARGET_DATE = process.argv[2];
if (!TARGET_DATE) {
    console.error('用法: node scripts/refilter-reanalyze-by-date.js <YYYY-MM-DD>');
    process.exit(1);
}

async function main() {
    console.log(`=== 重新处理 ${TARGET_DATE} 的论文 ===\n`);

    // 1. 从 papers.json 提取目标日期的论文
    const papersPath = Config.FILES.papers;
    const papersData = readJsonSafe(papersPath, {});
    const allPapers = papersData.papers || papersData;
    const targetPapers = [];
    for (const [key, paper] of Object.entries(allPapers)) {
        if (!paper || typeof paper !== 'object') continue;
        const fetched = paper.fetchedAt || '';
        if (fetched.startsWith(TARGET_DATE)) {
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
        process.exit(0);
    }

    // 2. LLM 筛选（减小批次避免 API 过载）
    console.log('🔍 开始 LLM 筛选...');
    const filtered = await filterPapersWithLLM(targetPapers, {
        batchSize: 3,
        delayBetweenBatches: 3000
    });
    console.log(`✅ 筛选完成: ${targetPapers.length} → ${filtered.length} 篇\n`);
    if (filtered.length === 0) {
        console.log('没有通过筛选的论文，无需分析');
        process.exit(0);
    }

    // 3. 深度分析
    console.log('🔬 开始深度分析...');
    const batchResult = await analyzeBatch(filtered, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency
    });

    const allResults = batchResult.results || [];
    // analyzeBatch 内部 unwrap 了 { success, result, parsed } → 直接返回 paper 对象
    // 成功/失败统计从 stats 获取
    console.log(`✅ 分析完成: 成功 ${batchResult.stats?.success || allResults.length} | 失败 ${batchResult.stats?.failed || 0} (stats: ${JSON.stringify(batchResult.stats)})`);

    if (allResults.length === 0) {
        console.error('❌ 所有分析失败，不更新结果文件');
        process.exit(1);
    }

    // 4. 合并到 deep-analysis-result.json（替换目标日期的旧结果）
    const resultFile = Config.FILES.deepAnalysisResult;
    const existingData = readJsonSafe(resultFile, { papers: [], lastUpdated: '' });
    let existingPapers = Array.isArray(existingData) ? existingData : (existingData.papers || []);

    // 移除目标日期的旧结果
    const beforeCount = existingPapers.length;
    existingPapers = existingPapers.filter(p => {
        const fetched = p.fetchedAt || '';
        return !fetched.startsWith(TARGET_DATE);
    });
    console.log(`🗑️  移除 ${TARGET_DATE} 旧结果: ${beforeCount} → ${existingPapers.length}`);

    // 加入新结果（allResults 已经是 paper 对象，analyzeBatch 已 unwrap）
    for (const paper of allResults) {
        existingPapers.push(paper);
    }

    // 排序
    existingPapers.sort((a, b) => (a.fetchedAt || '').localeCompare(b.fetchedAt || ''));

    const payload = {
        papers: existingPapers,
        lastUpdated: getBeijingISOString(),
        stats: { total: existingPapers.length, date: TARGET_DATE, analyzed: allResults.length, failed: batchResult.stats?.failed || 0 }
    };
    writeFileAtomic(resultFile, JSON.stringify(payload, null, 2));
    console.log(`💾 结果已保存: ${resultFile} (共 ${existingPapers.length} 篇)`);

    const digestUpdate = updateAnalysisDigestStatuses(allResults, { batchDate: TARGET_DATE });
    console.log(`💾 papers.json digestStatus 已同步: ${digestUpdate.updated} 篇`);
}

main().catch(err => {
    console.error('脚本执行失败:', err);
    process.exit(1);
});
