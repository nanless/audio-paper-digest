#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 批量深度分析
 * 薄封装——核心逻辑完全委托给 analysis-engine.js 和 deep-analyzer.js
 *
 * 环境变量:
 *   ICML_FILTERED_FILE       - 筛选结果输入
 *   ICML_RESULT_FILE         - 分析结果输出
 *   ICML_ANALYSIS_CONCURRENCY - 并发数 (默认: 3)
 *   ICML_OFFSET              - 从第 N 篇开始
 *   ICML_LIMIT               - 最多 N 篇
 */

const fs = require('fs');
const path = require('path');
const {
    writeFileAtomic,
    readJsonSafe,
    getBeijingISOString
} = require('./utils.js');
const Config = require('./config.js');
const { analyzeBatch } = require('./analysis-engine.js');

const PROJECT_ROOT = path.join(__dirname, '..');

const FILTERED_FILE = process.env.ICML_FILTERED_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_filtered.json');
const RESULT_FILE = process.env.ICML_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_deep_analysis.json');
const CONCURRENCY = parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10);
const OFFSET = parseInt(process.env.ICML_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICML_LIMIT || '0', 10) || Infinity;

function attachPdfText(paper) {
    const safeId = (paper.id || '').replace(/\//g, '_');
    const txtFile = path.join(PROJECT_ROOT, 'data', 'pdfs', 'icml2026', safeId + '.txt');
    try {
        if (fs.existsSync(txtFile)) {
            let text = fs.readFileSync(txtFile, 'utf-8');
            paper.fullText = text.length > 120000 ? text.substring(0, 120000) + '\n\n[... 已截断 ...]' : text;
            return text.length;
        }
    } catch (e) {
        console.log(`    [icml] ⚠️  读取 PDF 失败: ${paper.id} - ${e.message}`);
    }
    return 0;
}

async function main() {
    const missing = [];
    if (!process.env.PAPER_ANALYZER_ENDPOINT) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!process.env.PAPER_ANALYZER_API_KEY) missing.push('PAPER_ANALYZER_API_KEY');
    if (!process.env.PAPER_ANALYZER_MODEL) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-batch-analyze] 缺少环境变量: ${missing.join(', ')}`);
        process.exit(1);
    }

    console.log('=== ICML 2026 批量深度分析 ===');
    console.log(`模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    if (process.env.PAPER_ANALYZER_SECONDARY_MODEL) {
        console.log(`副模型: ${process.env.PAPER_ANALYZER_SECONDARY_MODEL} (双模型模式)`);
    }
    console.log(`并发数: ${CONCURRENCY}, 偏移: ${OFFSET}, 限制: ${LIMIT === Infinity ? '无' : LIMIT}`);
    console.log('');

    const filteredData = readJsonSafe(FILTERED_FILE);
    if (!filteredData || !Array.isArray(filteredData.papers)) {
        console.error(`[icml-batch-analyze] 无效筛选文件: ${FILTERED_FILE}`);
        process.exit(1);
    }

    const allPapers = filteredData.papers.slice(OFFSET, OFFSET + LIMIT);

    // 附加 PDF 文本 + 设置 categories
    let withText = 0;
    for (const p of allPapers) {
        if (attachPdfText(p) > 0) withText++;
        if (!p.categories) p.categories = p.venue || 'ICML 2026';
    }
    console.log(`📄 ${withText}/${allPapers.length} 篇有 PDF 全文\n`);

    // 断点续传
    const existingResult = readJsonSafe(RESULT_FILE, null);
    const existingIds = new Set((existingResult?.papers || []).map(p => p.id));
    const papersToAnalyze = allPapers.filter(p => !existingIds.has(p.id));
    console.log(`已分析: ${existingIds.size}, 待分析: ${papersToAnalyze.length}\n`);

    if (papersToAnalyze.length === 0) { console.log('已完成'); return; }

    let success = 0, failed = 0;

    await analyzeBatch(papersToAnalyze, {
        concurrency: CONCURRENCY,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 10,
        onPaperStart: (idx, total, paper) => {
            console.log(`[analyze] ${paper.id} - ${(paper.title || '').substring(0, 60)}`);
        },
        onPaperDone: (idx, total, paper, r, dur) => {
            if (r.success) {
                success++;
                console.log(`  ✅ 评分 ${r.parsed?.score || 'N/A'}/10`);
            } else {
                failed++;
                console.log(`  ❌ ${r.error}`);
            }
        },
        onSave: async (results) => {
            // Load R2 image mapping for ICML papers
            let r2Map = {};
            const r2File = path.join(Config.CURRENT_DIR, 'r2-image-mapping.json');
            try { if (fs.existsSync(r2File)) r2Map = JSON.parse(fs.readFileSync(r2File, 'utf-8')); } catch (e) {}

            const map = new Map();
            for (const p of (existingResult?.papers || [])) map.set(p.id, p);
            for (const r of results) {
                if (r?.id) {
                    // Find image URLs for this paper from R2 mapping
                    const imgUrls = [];
                    const prefix = `icml-2026/`;
                    const paperPrefix = `/${r.id}-`;
                    for (const [key, url] of Object.entries(r2Map)) {
                        if (key.includes(paperPrefix)) {
                            imgUrls.push(url);
                        }
                    }
                    map.set(r.id, { ...(map.get(r.id) || {}), ...r,
                        categories: r.categories || r.venue || 'ICML 2026',
                        imageUrls: imgUrls.length ? imgUrls : (r.imageUrls || []),
                        allImageUrls: imgUrls.length ? imgUrls : (r.allImageUrls || []),
                        fetchedAt: getBeijingISOString() });
                }
            }
            writeFileAtomic(RESULT_FILE, JSON.stringify({
                conference: 'ICML 2026', count: map.size,
                papers: Array.from(map.values()), analyzed_at: getBeijingISOString()
            }, null, 2));
            console.log(`  [保存] 成功:${success} 失败:${failed}`);
        }
    });

    console.log(`\n=== 完成 ===`);
    console.log(`成功: ${success}, 失败: ${failed}`);
    console.log(`结果: ${RESULT_FILE}`);
}

main().catch(e => {
    console.error('[icml-batch-analyze] 错误:', e);
    process.exit(1);
});
