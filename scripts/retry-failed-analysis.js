#!/usr/bin/env node
/**
 * 重新分析评分失败的论文
 */
const fs = require('fs');
const path = require('path');
const { analyzePaperDeep, parseAnalysis } = require('./deep-analyzer.js');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'icassp_2026_deep_analyzers.json');

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const papers = data.papers;

    // 找出没有评分的论文
    const failedPapers = [];
    for (const p of papers) {
        const pa = p.parsed || parseAnalysis(p.analysis || '');
        if (!pa || !pa.score) {
            failedPapers.push(p);
        }
    }

    console.log(`[retry] 发现 ${failedPapers.length} 篇论文需要重新分析`);

    for (const paper of failedPapers) {
        const paperId = paper.arnumber || paper.paper_id;
        console.log(`[retry] 重新分析: ${paperId} - ${paper.title.substring(0, 60)}`);

        try {
            const result = await analyzePaperDeep(paper);
            const analysisText = result.analysis || '';

            // API 返回安全拒绝信息
            if (typeof analysisText === 'string' && analysisText.includes('rejected')) {
                console.log(`[retry] ⚠️ ${paperId}: API 拒绝 - ${analysisText}`);
            } else {
                const parsed = parseAnalysis(analysisText);
                if (parsed && parsed.score) {
                    paper.analysis = analysisText;
                    paper.parsed = parsed;
                    console.log(`[retry] ✅ ${paperId}: 评分 ${parsed.score}/10`);
                } else {
                    console.log(`[retry] ⚠️ ${paperId}: 解析后仍然没有评分`);
                }
            }
        } catch (e) {
            console.log(`[retry] ❌ ${paperId}: ${e.message}`);
        }

        // 保存进度
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`[retry] 已保存进度`);
    }

    console.log('[retry] 完成');
}

main().catch(e => {
    console.error('[retry] 错误:', e);
    process.exit(1);
});
