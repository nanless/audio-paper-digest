#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 批量深度分析
 * 对筛选后的论文进行基于摘要的深度分析（支持双模型模式）
 *
 * 环境变量:
 *   ICML_FILTERED_FILE      - 筛选结果输入 (默认: data/current/icml_2026_filtered.json)
 *   ICML_RESULT_FILE        - 分析结果输出 (默认: data/current/icml_2026_deep_analysis.json)
 *   ICML_ANALYSIS_CONCURRENCY - 分析并发数 (默认: 3)
 *   ICML_OFFSET             - 从第 N 篇开始分析（断点续传）
 *   ICML_LIMIT              - 最多分析 N 篇（分批）
 *   ICML_ENABLE_GAPFILL     - 是否启用 gap-fill 审校 (默认: true)
 */

const fs = require('fs');
const path = require('path');
const {
    writeFileAtomic,
    readJsonSafe,
    getBeijingISOString,
    loadPrompt,
    parseAnalysis
} = require('./utils.js');
const Config = require('./config.js');
const { callModel } = require('./deep-analyzer.js');

const PROJECT_ROOT = path.join(__dirname, '..');

const FILTERED_FILE = process.env.ICML_FILTERED_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_filtered.json');
const RESULT_FILE = process.env.ICML_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_deep_analysis.json');
const CONCURRENCY = parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10);
const OFFSET = parseInt(process.env.ICML_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICML_LIMIT || '0', 10) || Infinity;
const ENABLE_GAPFILL = process.env.ICML_ENABLE_GAPFILL !== 'false';

function checkEnv() {
    const missing = [];
    if (!process.env.PAPER_ANALYZER_ENDPOINT) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!process.env.PAPER_ANALYZER_API_KEY) missing.push('PAPER_ANALYZER_API_KEY');
    if (!process.env.PAPER_ANALYZER_MODEL) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-batch-analyze] 缺少环境变量: ${missing.join(', ')}。请在 .env 中配置`);
        process.exit(1);
    }
}

/**
 * 深度分析单篇论文（使用 callModel，自动支持双模型模式）
 */
async function analyzeSingle(paper) {
    const abstract = (paper.abstract || '').substring(0, 8000);
    const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知');

    // 第一步：文本深度分析
    const prompt = loadPrompt('prompts/icml-deep-analysis.md', {
        title: paper.title || '(无标题)',
        authors: authors,
        paperId: paper.id || 'unknown',
        abstract: abstract || '(无摘要)',
        pdfText: '(全文未提供，仅基于摘要分析)'
    });

    const messages = [{ role: 'user', content: prompt }];
    const analysis = await callModel(messages, Config.ANALYSIS_CONFIG.apiMaxTokens);

    // 第二步：开源链接扫描
    let openSourceLinks = '';
    try {
        const ossPrompt = loadPrompt('prompts/opensource-scan.md', {
            title: paper.title || '',
            arxivId: paper.id || 'unknown',
            abstract: abstract.slice(0, 2000),
            analysis: analysis.slice(0, 6000)
        });
        openSourceLinks = await callModel(
            [{ role: 'user', content: ossPrompt }],
            8000
        );
    } catch (e) {
        console.log(`    [icml] ⚠️  开源扫描失败: ${e.message}`);
    }

    // 第三步：gap-fill 审校重写（可选，提高质量）
    let finalAnalysis = analysis;
    if (ENABLE_GAPFILL && openSourceLinks) {
        try {
            const gapFillPrompt = loadPrompt('prompts/gap-fill.md', {
                title: paper.title || '',
                authors: authors,
                arxivId: paper.id || 'unknown',
                abstract: abstract.slice(0, 3000),
                draftAnalysis: analysis,
                openSourceInfo: openSourceLinks
            });
            finalAnalysis = await callModel(
                [{ role: 'user', content: gapFillPrompt }],
                Config.ANALYSIS_CONFIG.apiMaxTokens
            );
        } catch (e) {
            console.log(`    [icml] ⚠️  gap-fill 审校失败: ${e.message}`);
        }
    }

    return finalAnalysis;
}

/**
 * 带重试的分析
 */
async function analyzeWithRetry(paper) {
    let lastError = null;
    const maxRetries = Config.ANALYSIS_CONFIG.maxRetries || 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const analysis = await analyzeSingle(paper);
            const parsed = parseAnalysis(analysis);

            if (analysis.toLowerCase().includes('rejected') || analysis.toLowerCase().includes('REJECTED')) {
                throw new Error('API rejected the request');
            }

            return { analysis, parsed, error: null };
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 3000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    return { analysis: null, parsed: null, error: lastError.message };
}

async function main() {
    checkEnv();

    console.log('=== ICML 2026 批量深度分析 ===');
    console.log(`模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    if (process.env.PAPER_ANALYZER_SECONDARY_MODEL) {
        console.log(`副模型: ${process.env.PAPER_ANALYZER_SECONDARY_MODEL} (双模型模式)`);
    }
    console.log(`gap-fill 审校: ${ENABLE_GAPFILL ? '已启用' : '已禁用'}`);
    console.log(`筛选文件: ${FILTERED_FILE}`);
    console.log(`结果文件: ${RESULT_FILE}`);
    console.log(`并发数: ${CONCURRENCY}`);
    console.log(`偏移: ${OFFSET}, 限制: ${LIMIT === Infinity ? '无' : LIMIT}`);
    console.log('');

    const filteredData = readJsonSafe(FILTERED_FILE);
    if (!filteredData || !filteredData.papers || !Array.isArray(filteredData.papers)) {
        console.error(`[icml-batch-analyze] 无效的筛选文件: ${FILTERED_FILE}`);
        process.exit(1);
    }

    const allPapers = filteredData.papers;
    const targetPapers = allPapers.slice(OFFSET, OFFSET + LIMIT);
    console.log(`筛选通过论文数: ${allPapers.length}, 本次分析: ${targetPapers.length} 篇`);

    const resultData = readJsonSafe(RESULT_FILE, {
        conference: 'ICML 2026',
        count: 0,
        papers: [],
        analyzed_at: null
    });

    const analyzedIds = new Set(resultData.papers.map(p => p.id));
    const papersToAnalyze = targetPapers.filter(p => !analyzedIds.has(p.id));

    console.log(`已分析: ${analyzedIds.size} 篇, 待分析: ${papersToAnalyze.length} 篇`);
    console.log('');

    if (papersToAnalyze.length === 0) {
        console.log('所有论文已分析完毕');
        return;
    }

    let success = 0;
    let failed = 0;

    const queue = [...papersToAnalyze];

    async function worker() {
        while (queue.length > 0) {
            const paper = queue.shift();
            console.log(`[analyze] ${paper.id} - ${paper.title?.substring(0, 60)}`);

            const result = await analyzeWithRetry(paper);

            if (result.error) {
                failed++;
                console.log(`  ❌ ${paper.id}: ${result.error}`);
                resultData.papers.push({
                    ...paper,
                    analysis: null,
                    parsed: null,
                    error: result.error
                });
            } else {
                success++;
                const score = result.parsed?.score || 'N/A';
                console.log(`  ✅ ${paper.id}: 评分 ${score}/10`);
                resultData.papers.push({
                    ...paper,
                    analysis: result.analysis,
                    parsed: result.parsed,
                    error: null
                });
            }

            const total = success + failed;
            if (total % 10 === 0) {
                resultData.count = resultData.papers.length;
                resultData.analyzed_at = getBeijingISOString();
                writeFileAtomic(RESULT_FILE, JSON.stringify(resultData, null, 2));
                console.log(`  [保存] 进度: ${total}/${papersToAnalyze.length} | 成功: ${success} | 失败: ${failed}`);
            }

            await new Promise(r => setTimeout(r, 1000));
        }
    }

    const workers = Array(Math.min(CONCURRENCY, papersToAnalyze.length)).fill().map(() => worker());
    await Promise.all(workers);

    resultData.count = resultData.papers.length;
    resultData.analyzed_at = getBeijingISOString();
    writeFileAtomic(RESULT_FILE, JSON.stringify(resultData, null, 2));

    console.log('');
    console.log('=== 分析完成 ===');
    console.log(`成功: ${success} 篇`);
    console.log(`失败: ${failed} 篇`);
    console.log(`总计处理: ${success + failed} 篇`);
    console.log(`结果保存: ${RESULT_FILE} (${resultData.papers.length} 篇)`);
}

main().catch(e => {
    console.error('[icml-batch-analyze] 错误:', e);
    process.exit(1);
});
