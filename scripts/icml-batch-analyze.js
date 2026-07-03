#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 批量深度分析
 * 对筛选后的论文进行基于摘要的深度分析
 *
 * 环境变量:
 *   ICML_FILTERED_FILE    - 筛选结果输入 (默认: data/current/icml_2026_filtered.json)
 *   ICML_RESULT_FILE      - 分析结果输出 (默认: data/current/icml_2026_deep_analysis.json)
 *   ICML_ANALYSIS_CONCURRENCY - 分析并发数 (默认: 3)
 *   ICML_OFFSET           - 从第 N 篇开始分析（断点续传）
 *   ICML_LIMIT            - 最多分析 N 篇（分批）
 */

const fs = require('fs');
const path = require('path');
const {
    writeFileAtomic,
    readJsonSafe,
    getBeijingISOString,
    loadPrompt,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    parseAnalysis
} = require('./utils.js');
const Config = require('./config.js');

const PROJECT_ROOT = path.join(__dirname, '..');

const FILTERED_FILE = process.env.ICML_FILTERED_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_filtered.json');
const RESULT_FILE = process.env.ICML_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_deep_analysis.json');
const CONCURRENCY = parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10);
const OFFSET = parseInt(process.env.ICML_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICML_LIMIT || '0', 10) || Infinity;

const ANALYSIS_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    timeoutMs: parseInt(process.env.ICML_ANALYSIS_TIMEOUT || '600000', 10),
    maxRetries: parseInt(process.env.ICML_ANALYSIS_RETRIES || '2', 10),
    retryDelayMs: parseInt(process.env.ICML_ANALYSIS_RETRY_DELAY || '3000', 10),
    maxTokens: parseInt(process.env.ICML_ANALYSIS_MAX_TOKENS || '64000', 10)
};

function checkEnv() {
    const missing = [];
    if (!ANALYSIS_CONFIG.endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!ANALYSIS_CONFIG.key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!ANALYSIS_CONFIG.model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-batch-analyze] 缺少环境变量: ${missing.join(', ')}。请在 ~/.hermes/.env 中配置`);
        process.exit(1);
    }
}

/**
 * 调用 LLM 进行深度分析
 */
async function analyzeSingle(paper) {
    const apiType = detectApiType(ANALYSIS_CONFIG.endpoint, ANALYSIS_CONFIG.model);
    const apiUrl = buildApiUrl(apiType, ANALYSIS_CONFIG.endpoint);
    const url = new URL(apiUrl);

    const abstract = (paper.abstract || '').substring(0, 8000);
    const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知');

    const prompt = loadPrompt('prompts/icml-deep-analysis.md', {
        title: paper.title || '(无标题)',
        authors: authors,
        paperId: paper.id || 'unknown',
        abstract: abstract || '(无摘要)',
        pdfText: '(全文未提供，仅基于摘要分析)'
    });

    const messages = [{ role: 'user', content: prompt }];
    const bodyObj = buildRequestBody(apiType, ANALYSIS_CONFIG.model, messages, ANALYSIS_CONFIG.maxTokens, 0.7);
    const postData = JSON.stringify(bodyObj);

    const headers = buildHeaders(apiType, ANALYSIS_CONFIG.key, postData);

    return new Promise((resolve, reject) => {
        const https = require('https');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ANALYSIS_CONFIG.timeoutMs);

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: headers,
            signal: controller.signal
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timeoutId);
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const response = JSON.parse(data);
                    const text = parseResponseText(apiType, response);
                    if (text === null) {
                        reject(new Error('Invalid response'));
                        return;
                    }
                    resolve(text);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
        req.write(postData);
        req.end();
    });
}

/**
 * 带重试的分析
 */
async function analyzeWithRetry(paper) {
    let lastError = null;
    for (let attempt = 1; attempt <= ANALYSIS_CONFIG.maxRetries; attempt++) {
        try {
            const analysis = await analyzeSingle(paper);
            const parsed = parseAnalysis(analysis);

            // 检查是否被拒绝
            if (analysis.toLowerCase().includes('rejected') || analysis.toLowerCase().includes('REJECTED')) {
                throw new Error('API rejected the request');
            }

            return { analysis, parsed, error: null };
        } catch (err) {
            lastError = err;
            if (attempt < ANALYSIS_CONFIG.maxRetries) {
                const delay = Math.pow(2, attempt) * ANALYSIS_CONFIG.retryDelayMs;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    return { analysis: null, parsed: null, error: lastError.message };
}

async function main() {
    checkEnv();

    console.log('=== ICML 2026 批量深度分析 ===');
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

    // 加载已有结果（断点续传）
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

    // 并发分析
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

            // 避免API限流
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    const workers = Array(Math.min(CONCURRENCY, papersToAnalyze.length)).fill().map(() => worker());
    await Promise.all(workers);

    // 最终保存
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
