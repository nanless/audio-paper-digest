#!/usr/bin/env node
/**
 * 批量重新分析所有 ICLR 论文（并发版）
 */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');

// 设置图片目录为 ICLR 目录（必须在 require deep-analyzer.js 之前）
process.env.PAPER_IMAGE_DIR = process.env.PAPER_IMAGE_DIR || path.join(Config.CURRENT_DIR, 'iclr-images');

const { analyzePaperDeep } = require('./deep-analyzer.js');

// 并发数
const CONCURRENCY = parseInt(process.env.REANALYZE_CONCURRENCY, 10) || 3;

// 支持从环境变量指定要重新分析的论文 ID（逗号分隔），否则分析全部
const TARGET_IDS = process.env.REANALYZE_IDS
    ? process.env.REANALYZE_IDS.split(',').map(s => s.trim())
    : null;

// 支持从环境变量指定要跳过的论文 ID（逗号分隔）
const skipIdsEnv = process.env.SKIP_IDS || '';
const SKIP_IDS = skipIdsEnv
    ? new Set(skipIdsEnv.split(',').map(s => s.trim()))
    : new Set();

async function analyzeOne(paper, data) {
    const fid = paper.paper_id || paper.forum_id;
    try {
        const result = await analyzePaperDeep(paper);
        const analysisText = result.analysis || '';

        if (analysisText.includes('rejected') || analysisText.includes('REJECTED')) {
            return { status: 'failed', fid, reason: 'API拒绝' };
        }

        const { parseAnalysis } = require('./utils.js');
        const parsed = parseAnalysis(analysisText);

        if (!parsed || !parsed.score) {
            return { status: 'failed', fid, reason: '无评分' };
        }

        // 更新论文数据（直接修改 data 中的对象）
        paper.analysis = analysisText;
        paper.parsed = parsed;
        paper.imageUrls = result.imageUrls || paper.imageUrls || [];
        paper.allImageUrls = result.allImageUrls || paper.allImageUrls || [];

        return { status: 'success', fid, score: parsed.score, imageCount: paper.imageUrls.length };
    } catch (e) {
        return { status: 'failed', fid, reason: e.message };
    }
}

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let papers = data.papers;

    if (TARGET_IDS) {
        papers = papers.filter(p => TARGET_IDS.includes(p.paper_id) || TARGET_IDS.includes(p.forum_id));
        console.log(`[reanalyze-all] 指定了 ${TARGET_IDS.length} 篇论文，匹配到 ${papers.length} 篇`);
    }

    // 过滤掉要跳过的
    const originalCount = papers.length;
    papers = papers.filter(p => !SKIP_IDS.has(p.paper_id) && !SKIP_IDS.has(p.forum_id));
    const skippedCount = originalCount - papers.length;

    console.log(`[reanalyze-all] 并发数: ${CONCURRENCY}, 总论文: ${originalCount}, 跳过: ${skippedCount}, 待分析: ${papers.length}`);

    let success = 0;
    let failed = 0;
    let processed = 0;

    for (let i = 0; i < papers.length; i += CONCURRENCY) {
        const batch = papers.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(papers.length / CONCURRENCY);

        console.log(`[batch ${batchNum}/${totalBatches}] 处理 ${batch.length} 篇: ${batch.map(p => p.paper_id || p.forum_id).join(', ')}`);

        const results = await Promise.all(batch.map(p => analyzeOne(p, data)));

        for (const r of results) {
            processed++;
            if (r.status === 'success') {
                console.log(`  ✅ ${r.fid}: 评分 ${r.score}/10, ${r.imageCount} 张图片`);
                success++;
            } else {
                console.log(`  ❌ ${r.fid}: ${r.reason}`);
                failed++;
            }
        }

        // 每批保存一次
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`[reanalyze-all] 已保存进度 (${processed}/${papers.length})`);
    }

    console.log(`[reanalyze-all] 完成: ${success} 成功, ${failed} 失败, ${skippedCount} 跳过`);
}

main().catch(e => {
    console.error('[reanalyze-all] 错误:', e);
    process.exit(1);
});
