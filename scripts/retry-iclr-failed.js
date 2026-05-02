#!/usr/bin/env node
/**
 * 重试 ICLR 深度分析失败的论文
 * 减少图片数量避免 API 安全拒绝
 */
const fs = require('fs');
const path = require('path');
const { analyzePaperDeep, parseAnalysis } = require('./deep-analyzer.js');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const papers = data.papers;

    // 找出分析异常的论文
    const failedPapers = [];
    for (const p of papers) {
        const analysis = p.analysis || '';
        const parsed = p.parsed || parseAnalysis(analysis);
        if (!parsed || !parsed.score || analysis.toLowerCase().includes('rejected')) {
            failedPapers.push(p);
        }
    }

    console.log(`[retry] 发现 ${failedPapers.length} 篇论文需要重新分析`);

    for (const paper of failedPapers) {
        const fid = paper.forum_id || paper.paper_id || '?';
        console.log(`[retry] 重新分析: ${fid} - ${paper.title?.substring(0, 60)}`);

        // 策略1: 先尝试纯文本分析（不发送图片）
        const textOnlyPaper = { ...paper, pdfPath: null, arxivId: null };
        try {
            const result = await analyzePaperDeep(textOnlyPaper);
            const analysisText = result.analysis || '';

            if (typeof analysisText === 'string' && analysisText.includes('rejected')) {
                console.log(`[retry] ⚠️ ${fid}: 纯文本也被拒绝 - ${analysisText}`);
            } else {
                const parsed = parseAnalysis(analysisText);
                if (parsed && parsed.score) {
                    paper.analysis = analysisText;
                    paper.parsed = parsed;
                    console.log(`[retry] ✅ ${fid}: 纯文本成功 评分 ${parsed.score}/10`);
                    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
                    continue;
                } else {
                    console.log(`[retry] ⚠️ ${fid}: 纯文本解析后仍然没有评分`);
                }
            }
        } catch (e) {
            console.log(`[retry] ❌ ${fid} 纯文本模式: ${e.message}`);
        }

        // 策略2: 如果纯文本也失败，尝试只发前3张图片
        const imgDir = path.join(Config.CURRENT_DIR, 'iclr-images', fid);
        if (fs.existsSync(imgDir)) {
            const images = fs.readdirSync(imgDir)
                .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
                .sort()
                .slice(0, 3);

            if (images.length > 0) {
                console.log(`[retry] ${fid}: 尝试只发送 ${images.length} 张图片`);
                const limitedPaper = { ...paper };
                // 手动构建 imageDataList
                const imageDataList = [];
                const imageUrls = [];
                for (let i = 0; i < images.length; i++) {
                    const imgPath = path.join(imgDir, images[i]);
                    const buf = fs.readFileSync(imgPath);
                    const ext = path.extname(images[i]).toLowerCase();
                    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
                    const b64 = buf.toString('base64');
                    imageDataList.push({
                        url: `data:${mime};base64,${b64}`,
                        base64: b64,
                        mime: mime,
                        index: i
                    });
                    imageUrls.push(`icassp-img://${fid}/${images[i]}`);
                }
                limitedPaper.__imageDataList = imageDataList;
                limitedPaper.__imageUrls = imageUrls;

                try {
                    const result = await analyzePaperDeep(limitedPaper);
                    const analysisText = result.analysis || '';
                    if (!analysisText.includes('rejected')) {
                        const parsed = parseAnalysis(analysisText);
                        if (parsed && parsed.score) {
                            paper.analysis = analysisText;
                            paper.parsed = parsed;
                            console.log(`[retry] ✅ ${fid}: 限制图片成功 评分 ${parsed.score}/10`);
                            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
                            continue;
                        }
                    }
                } catch (e) {
                    console.log(`[retry] ❌ ${fid} 限制图片模式: ${e.message}`);
                }
            }
        }

        console.log(`[retry] ❌ ${fid}: 所有重试策略均失败`);
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('[retry] 完成');
}

main().catch(e => {
    console.error('[retry] 错误:', e);
    process.exit(1);
});
