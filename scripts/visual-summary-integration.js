'use strict';

/**
 * 博客远端发布成功后，按发布凭证中的论文记录安排图片任务：
 * 为最终评分 TOP 10 安排论文长图，同一批次另安排一张汇总封面。
 * 本模块建立任务或使旧任务失效，不调用图像 API；实际生图由 Codex 内置 image_gen 完成。
 */

const {
    planVisualSummaries,
    pendingVisualSummaryCards,
    compactPendingVisualTask,
    visualSummaryManifestPath,
    assertPublishedBlogReceipt
} = require('./visual-summary-state.js');
const {
    planDigestCover,
    compactDigestCoverTask,
    digestCoverManifestPath
} = require('./digest-cover-state.js');

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
    // schema v3 生成清单记录实际发布的论文。`--all` 和会议运行可能发布更早
    // 抓到的论文，因此将这些已发布论文的批次日期统一为本次博客日期后再安排图片。
    const normalizedPapers = papers.map(paper => ({
        ...paper,
        fetchBatchDate: targetDate,
        batchDate: targetDate
    }));
    manifestPath = manifestPath || visualSummaryManifestPath(targetDate);
    coverManifestPath = coverManifestPath || digestCoverManifestPath(targetDate);
    const manifest = planVisualSummaries({
        targetDate,
        papers: normalizedPapers,
        manifestPath,
        ...(promptPath ? { promptPath } : {}),
        publication
    });
    const pendingCards = pendingVisualSummaryCards(manifest);
    const coverManifest = planDigestCover({
        targetDate,
        papers: normalizedPapers,
        category,
        publication,
        manifestPath: coverManifestPath,
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
        manifestPath,
        pendingCards,
        coverManifest,
        coverManifestPath,
        pendingCover,
        pipelineStatus: manifest.overallStatus === 'complete' && coverManifest.overallStatus === 'complete'
            ? 'post_publish_visuals_complete'
            : 'awaiting_post_publish_visuals'
    };
}

function parseArgs(argv) {
    const options = {};
    const allowed = new Set(['date', 'category', 'receipt']);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--') || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
            throw new Error(`无效参数: ${arg}`);
        }
        const key = arg.slice(2);
        if (!allowed.has(key)) throw new Error(`未知参数: ${arg}`);
        if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`参数只能指定一次: ${arg}`);
        options[key] = argv[++i];
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
    for (const item of result.pendingCards) {
        console.log(JSON.stringify(compactPendingVisualTask(item, result.manifest, result.manifestPath)));
    }
    for (const _item of result.pendingCover) {
        console.log(JSON.stringify(compactDigestCoverTask(result.coverManifest, result.coverManifestPath)));
    }
    return result;
}

if (require.main === module) main();

module.exports = { assertPublishedBlogReceipt, reconcileVisualSummaryTasks, parseArgs, main };
