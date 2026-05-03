#!/usr/bin/env node
/**
 * 批量重新分析所有 ICLR 论文（使用新版 prompt 和图片）
 */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');

// 设置图片目录为 ICLR 目录（必须在 require deep-analyzer.js 之前）
process.env.PAPER_IMAGE_DIR = process.env.PAPER_IMAGE_DIR || path.join(Config.CURRENT_DIR, 'iclr-images');

const { analyzePaperDeep } = require('./deep-analyzer.js');

// 支持从环境变量指定要重新分析的论文 ID（逗号分隔），否则分析全部
const TARGET_IDS = process.env.REANALYZE_IDS
    ? process.env.REANALYZE_IDS.split(',').map(s => s.trim())
    : null;

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let papers = data.papers;

    if (TARGET_IDS) {
        papers = papers.filter(p => TARGET_IDS.includes(p.paper_id) || TARGET_IDS.includes(p.forum_id));
        console.log(`[reanalyze-all] 指定了 ${TARGET_IDS.length} 篇论文，匹配到 ${papers.length} 篇`);
    } else {
        console.log(`[reanalyze-all] 开始重新分析全部 ${papers.length} 篇论文`);
    }

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        const fid = paper.paper_id || paper.forum_id;

        console.log(`[${i + 1}/${papers.length}] 重新分析: ${fid} - ${paper.title?.substring(0, 60)}`);

        try {
            const result = await analyzePaperDeep(paper);
            const analysisText = result.analysis || '';

            if (analysisText.includes('rejected') || analysisText.includes('REJECTED')) {
                console.log(`[${i + 1}] ⚠️ ${fid}: API 拒绝 - ${analysisText.substring(0, 100)}`);
                failed++;
                continue;
            }

            const { parseAnalysis } = require('./utils.js');
            const parsed = parseAnalysis(analysisText);

            if (!parsed || !parsed.score) {
                console.log(`[${i + 1}] ⚠️ ${fid}: 解析后无评分`);
                failed++;
                continue;
            }

            // 更新论文数据
            paper.analysis = analysisText;
            paper.parsed = parsed;
            paper.imageUrls = result.imageUrls || paper.imageUrls || [];
            paper.allImageUrls = result.allImageUrls || paper.allImageUrls || [];

            console.log(`[${i + 1}] ✅ ${fid}: 评分 ${parsed.score}/10, ${paper.imageUrls.length} 张图片`);
            success++;

            // 每5篇保存一次
            if ((i + 1) % 5 === 0) {
                fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
                console.log(`[reanalyze-all] 已保存进度 (${i + 1}/${papers.length})`);
            }

            // 添加短暂延迟避免 API 限流
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.log(`[${i + 1}] ❌ ${fid}: ${e.message}`);
            failed++;
        }
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`[reanalyze-all] 完成: ${success} 成功, ${failed} 失败, ${skipped} 跳过`);
}

main().catch(e => {
    console.error('[reanalyze-all] 错误:', e);
    process.exit(1);
});
