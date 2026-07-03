#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 重试失败的分析
 * 重新分析 icml_2026_deep_analysis.json 中 error 不为空的论文
 *
 * 环境变量:
 *   ICML_RESULT_FILE      - 分析结果文件 (默认: data/current/icml_2026_deep_analysis.json)
 *   ICML_ANALYSIS_CONCURRENCY - 并发数 (默认: 3)
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

const RESULT_FILE = process.env.ICML_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_deep_analysis.json');
const CONCURRENCY = parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10);

const ANALYSIS_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    timeoutMs: parseInt(process.env.ICML_ANALYSIS_TIMEOUT || '600000', 10),
    maxRetries: parseInt(process.env.ICML_ANALYSIS_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.ICML_ANALYSIS_RETRY_DELAY || '5000', 10),
    maxTokens: parseInt(process.env.ICML_ANALYSIS_MAX_TOKENS || '64000', 10)
};

function checkEnv() {
    const missing = [];
    if (!ANALYSIS_CONFIG.endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!ANALYSIS_CONFIG.key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!ANALYSIS_CONFIG.model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-retry-failed] 缺少环境变量: ${missing.join(', ')}`);
        process.exit(1);
    }
}

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

async function analyzeWithRetry(paper) {
    let lastError = null;
    for (let attempt = 1; attempt <= ANALYSIS_CONFIG.maxRetries; attempt++) {
        try {
            const analysis = await analyzeSingle(paper);
            const parsed = parseAnalysis(analysis);

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

    console.log('=== ICML 2026 重试失败分析 ===');
    console.log(`结果文件: ${RESULT_FILE}`);
    console.log(`并发数: ${CONCURRENCY}`);
    console.log('');

    const resultData = readJsonSafe(RESULT_FILE);
    if (!resultData || !resultData.papers) {
        console.error(`[icml-retry-failed] 无效的结果文件: ${RESULT_FILE}`);
        process.exit(1);
    }

    const failedPapers = resultData.papers.filter(p => p.error);
    console.log(`总论文数: ${resultData.papers.length}`);
    console.log(`失败论文数: ${failedPapers.length}`);
    console.log('');

    if (failedPapers.length === 0) {
        console.log('没有失败的论文需要重试');
        return;
    }

    let success = 0;
    let stillFailed = 0;

    const queue = [...failedPapers];

    async function worker() {
        while (queue.length > 0) {
            const paper = queue.shift();
            console.log(`[retry] ${paper.id} - ${paper.title?.substring(0, 60)}`);

            const result = await analyzeWithRetry(paper);

            // 更新结果
            const idx = resultData.papers.findIndex(p => p.id === paper.id);
            if (idx >= 0) {
                if (result.error) {
                    stillFailed++;
                    console.log(`  ❌ ${paper.id}: ${result.error}`);
                    resultData.papers[idx].retry_error = result.error;
                } else {
                    success++;
                    const score = result.parsed?.score || 'N/A';
                    console.log(`  ✅ ${paper.id}: 评分 ${score}/10`);
                    resultData.papers[idx].analysis = result.analysis;
                    resultData.papers[idx].parsed = result.parsed;
                    resultData.papers[idx].error = null;
                }
            }

            const total = success + stillFailed;
            if (total % 5 === 0) {
                writeFileAtomic(RESULT_FILE, JSON.stringify(resultData, null, 2));
                console.log(`  [保存] 进度: ${total}/${failedPapers.length}`);
            }

            await new Promise(r => setTimeout(r, 1000));
        }
    }

    const workers = Array(Math.min(CONCURRENCY, failedPapers.length)).fill().map(() => worker());
    await Promise.all(workers);

    writeFileAtomic(RESULT_FILE, JSON.stringify(resultData, null, 2));

    console.log('');
    console.log('=== 重试完成 ===');
    console.log(`成功: ${success} 篇`);
    console.log(`仍失败: ${stillFailed} 篇`);
}

main().catch(e => {
    console.error('[icml-retry-failed] 错误:', e);
    process.exit(1);
});
