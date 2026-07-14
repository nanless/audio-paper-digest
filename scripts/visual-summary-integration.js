'use strict';

/**
 * 博客远端发布成功后，将权威深度分析文件与视觉资产对齐：
 * 只为最终评分 TOP 10 生成纵向长图，同一批次另生成一张发布后汇总图。
 * 这里只创建/失效任务，绝不调用图像 API；实际生图由 Codex 内置 image_gen 完成。
 */

const {
    planVisualSummaries,
    pendingVisualSummaryCards,
    assertPublishedBlogReceipt
} = require('./visual-summary-state.js');
const { planDigestCover } = require('./digest-cover-state.js');

function reconcileVisualSummaryTasks({
    targetDate = null,
    manifestPath = null,
    coverManifestPath = null,
    promptPath = null,
    coverPromptPath = null,
    category = '论文速递',
    publicationReceiptPath = null
} = {}) {
    if (!targetDate) {
        throw new Error('发布后视觉规划必须显式传入 --date YYYY-MM-DD');
    }
    const publication = assertPublishedBlogReceipt(targetDate, publicationReceiptPath);
    if (category !== '论文速递' && category !== publication.category) {
        throw new Error(`视觉任务 category 与已发布博客不一致: ${category} != ${publication.category}`);
    }
    category = publication.category;
    const papers = publication.publishedPapers;
    // generation schema v3 is the authority for what was actually published.
    // `--all` and conference runs may publish papers fetched on earlier dates, so
    // visual ranking must bind the entire published snapshot to the blog date.
    const normalizedPapers = papers.map(paper => ({
        ...paper,
        fetchBatchDate: targetDate,
        batchDate: targetDate
    }));
    const manifest = planVisualSummaries({
        targetDate,
        papers: normalizedPapers,
        ...(manifestPath ? { manifestPath } : {}),
        ...(promptPath ? { promptPath } : {}),
        publication
    });
    const pendingCards = pendingVisualSummaryCards(manifest);
    const coverManifest = planDigestCover({
        targetDate,
        papers: normalizedPapers,
        category,
        publication,
        ...(coverManifestPath ? { manifestPath: coverManifestPath } : {}),
        ...(coverPromptPath ? { promptPath: coverPromptPath } : {})
    });
    const pendingCover = coverManifest.overallStatus === 'complete' ? [] : [{
        kind: 'digest-cover',
        taskToken: coverManifest.cover.taskToken,
        generationContext: coverManifest.generationContext
    }];
    return {
        targetDate,
        publication,
        manifest,
        pendingCards,
        coverManifest,
        pendingCover,
        pipelineStatus: manifest.overallStatus === 'complete' && coverManifest.overallStatus === 'complete'
            ? 'post_publish_visuals_complete'
            : 'awaiting_post_publish_visuals'
    };
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--') || i + 1 >= argv.length) throw new Error(`无效参数: ${arg}`);
        options[arg.slice(2)] = argv[++i];
    }
    return options;
}

function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const result = reconcileVisualSummaryTasks({
        targetDate: options.date,
        category: options.category || '论文速递',
        publicationReceiptPath: options.receipt
    });
    console.log(`发布后视觉任务：TOP 10 长图待生成 ${result.pendingCards.length} 张，汇总封面待生成 ${result.pendingCover.length} 张`);
    for (const item of result.pendingCards) console.log(JSON.stringify(item));
    for (const item of result.pendingCover) console.log(JSON.stringify(item));
    return result;
}

if (require.main === module) main();

module.exports = { assertPublishedBlogReceipt, reconcileVisualSummaryTasks, main };
