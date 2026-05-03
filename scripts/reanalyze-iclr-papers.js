#!/usr/bin/env node
/**
 * 重新分析指定的 ICLR 论文（图片引用超出范围或需要重新分析的）
 */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');

// 设置图片目录为 ICLR 目录（必须在 require deep-analyzer.js 之前）
process.env.PAPER_IMAGE_DIR = process.env.PAPER_IMAGE_DIR || path.join(Config.CURRENT_DIR, 'iclr-images');

const { analyzePaperDeep } = require('./deep-analyzer.js');

// 需要重新分析的论文 ID 列表
const PAPER_IDS_TO_REANALYZE = process.env.REANALYZE_IDS
    ? process.env.REANALYZE_IDS.split(',').map(s => s.trim())
    : [];

async function main() {
    if (PAPER_IDS_TO_REANALYZE.length === 0) {
        console.log('[reanalyze] 未指定论文 ID，请设置 REANALYZE_IDS 环境变量');
        console.log('[reanalyze] 示例: REANALYZE_IDS=id1,id2,id3 node scripts/reanalyze-iclr-papers.js');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const papers = data.papers;

    console.log(`[reanalyze] 开始重新分析 ${PAPER_IDS_TO_REANALYZE.length} 篇论文`);

    let success = 0;
    let failed = 0;

    for (let i = 0; i < PAPER_IDS_TO_REANALYZE.length; i++) {
        const fid = PAPER_IDS_TO_REANALYZE[i];
        const paper = papers.find(p => p.paper_id === fid || p.forum_id === fid);

        if (!paper) {
            console.log(`[${i + 1}/${PAPER_IDS_TO_REANALYZE.length}] ⚠️ ${fid}: 未在结果文件中找到`);
            failed++;
            continue;
        }

        console.log(`[${i + 1}/${PAPER_IDS_TO_REANALYZE.length}] 重新分析: ${fid} - ${paper.title?.substring(0, 60)}`);

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
                console.log(`[reanalyze] 已保存进度 (${i + 1}/${PAPER_IDS_TO_REANALYZE.length})`);
            }

            // 添加短暂延迟避免 API 限流
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.log(`[${i + 1}] ❌ ${fid}: ${e.message}`);
            failed++;
        }
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`[reanalyze] 完成: ${success} 成功, ${failed} 失败`);
}

main().catch(e => {
    console.error('[reanalyze] 错误:', e);
    process.exit(1);
});
