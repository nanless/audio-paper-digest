#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文抓取快速测试（仅抓+筛选，不分析）
 */

const { fetchCategoryPapers, deduplicatePapers, filterPapers, loadPapers } = require('./fetch-papers.js');
const { getBeijingISOString } = require('./utils.js');
const fs = require('fs');
const { writeFileAtomic } = require('./utils.js');
const Config = require('./config.js');

async function quickTest() {
    console.log('=== 论文抓取：每个类别 100 篇 ===');
    console.log('');

    const { ARXIV_CATEGORIES: categories, ARXIV_CONFIG } = Config;

    const allPapers = [];

    const papersData = loadPapers();
    const existingIds = new Set(Object.keys(papersData.papers));
    console.log(`已有 ${existingIds.size} 篇论文ID，遇到重复将提前停止`);

    for (const category of categories) {
        console.log(`抓取 ${category.name} (${category.id})...`);
        const papers = await fetchCategoryPapers(category.id, ARXIV_CONFIG.maxResultsPerCategory, ARXIV_CONFIG.fetchMaxRetries, existingIds);
        allPapers.push(...papers);
        console.log(`  获取 ${papers.length} 篇新论文`);

        await new Promise(resolve => setTimeout(resolve, ARXIV_CONFIG.categoryDelayMs));
    }

    console.log(`\n总计: ${allPapers.length} 篇`);

    const unique = deduplicatePapers(allPapers);
    console.log(`去重后: ${unique.length} 篇`);

    const filtered = await filterPapers(unique);
    console.log(`筛选后: ${filtered.length} 篇`);

    console.log('\n📊 按类别统计:');
    const byCategory = {};
    filtered.forEach(paper => {
        paper.categories.forEach(cat => {
            byCategory[cat] = (byCategory[cat] || 0) + 1;
        });
    });

    Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([cat, count]) => {
            console.log(`  ${cat}: ${count} 篇`);
        });

    console.log('\n📄 前 5 篇论文:');
    filtered.slice(0, 5).forEach((p, i) => {
        console.log(`${i+1}. [${p.arxivId}] ${p.title.substring(0, 60)}...`);
        console.log(`   作者: ${p.authors.slice(0, 2).join(', ')}${p.authors.length > 2 ? ' 等' : ''}`);
        console.log(`   类别: ${p.categories.slice(0, 3).join(', ')}`);
        console.log(`   发布: ${p.published.split('T')[0]}`);
        console.log('');
    });

    const outputFile = './data/quick-test-result.json';
    writeFileAtomic(outputFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        totalFetched: allPapers.length,
        afterDedup: unique.length,
        afterFilter: filtered.length,
        papers: filtered.slice(0, 10)
    }, null, 2));

    console.log(`✅ 测试完成！结果已保存到: ${outputFile}`);
    console.log(`\n💡 提示: 运行完整抓取请使用: node scripts/full-fetch.js`);
}

quickTest().catch(err => {
    console.error(`❌ 测试失败: ${err.message}`);
    process.exit(1);
});
