#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 为已找到 PDF 的 ICML 论文重新进行基于全文的深度分析
 */

const fs = require('fs');
const path = require('path');
const {
    writeFileAtomic,
    readJsonSafe,
    loadPrompt,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText
} = require('./utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const PDF_DIR = path.join(PROJECT_ROOT, 'data', 'pdfs', 'icml2026');
const PDF_MAP_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_pdf_map.json');
const ANALYSIS_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_deep_analysis.json');

const ANALYZE_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    timeoutMs: parseInt(process.env.ICML_ANALYZE_TIMEOUT || '120000', 10),
    maxRetries: parseInt(process.env.ICML_ANALYZE_RETRIES || '3', 10)
};

function checkEnv() {
    const missing = [];
    if (!ANALYZE_CONFIG.endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!ANALYZE_CONFIG.key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!ANALYZE_CONFIG.model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-reanalyze-pdf] 缺少环境变量: ${missing.join(', ')}`);
        process.exit(1);
    }
}

async function analyzeWithPdf(paper, pdfText) {
    const apiType = detectApiType(ANALYZE_CONFIG.endpoint, ANALYZE_CONFIG.model);
    const apiUrl = buildApiUrl(apiType, ANALYZE_CONFIG.endpoint);
    const url = new URL(apiUrl);

    // 截断 PDF 文本，避免超出 token 限制
    // 策略：保留前15000字符（通常包含摘要、引言、方法概述）
    const MAX_CHARS = 15000;
    let truncatedText = pdfText;
    if (pdfText.length > MAX_CHARS) {
        truncatedText = pdfText.substring(0, MAX_CHARS) + '\n\n[... 中间内容已截断，仅保留前15000字符 ...]';
    }

    const prompt = loadPrompt('prompts/icml-deep-analysis.md', {
        paperId: paper.id,
        title: paper.title || '(无标题)',
        authors: (paper.authors || []).join(', '),
        abstract: (paper.abstract || '').substring(0, 2000),
        pdfText: truncatedText
    });

    const messages = [{ role: 'user', content: prompt }];
    const bodyObj = buildRequestBody(apiType, ANALYZE_CONFIG.model, messages, 8000, 0.3);
    const postData = JSON.stringify(bodyObj);
    const headers = buildHeaders(apiType, ANALYZE_CONFIG.key, postData);

    return new Promise((resolve, reject) => {
        const https = require('https');
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: headers,
            timeout: ANALYZE_CONFIG.timeoutMs
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    const text = parseResponseText(apiType, response);
                    if (text === null) {
                        reject(new Error('Invalid response'));
                        return;
                    }
                    resolve({ paper, analysis: text });
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(postData);
        req.end();
    });
}

async function analyzeWithRetry(paper, pdfText) {
    let lastError = null;
    for (let attempt = 1; attempt <= ANALYZE_CONFIG.maxRetries; attempt++) {
        try {
            return await analyzeWithPdf(paper, pdfText);
        } catch (err) {
            lastError = err;
            if (attempt < ANALYZE_CONFIG.maxRetries) {
                const delay = Math.pow(2, attempt) * 2000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.log(`  ❌ ${paper.id} 分析失败（重试 ${ANALYZE_CONFIG.maxRetries} 次）: ${lastError.message}`);
    return { paper, analysis: null, error: lastError.message };
}

async function main() {
    checkEnv();

    const pdfMap = readJsonSafe(PDF_MAP_FILE, {});
    const analysisData = readJsonSafe(ANALYSIS_FILE, { papers: [] });

    // 找到有 PDF 的论文
    const papersToReanalyze = [];
    for (const paper of analysisData.papers) {
        const info = pdfMap[paper.id];
        if (info && info.arxivId) {
            const txtPath = path.join(PDF_DIR, info.arxivId + '.txt');
            if (fs.existsSync(txtPath)) {
                const text = fs.readFileSync(txtPath, 'utf-8');
                if (text.length > 1000) {
                    papersToReanalyze.push({ paper, pdfText: text, arxivId: info.arxivId });
                }
            }
        }
    }

    console.log(`=== ICML PDF 重新分析 ===`);
    console.log(`找到 ${papersToReanalyze.length} 篇有 PDF 全文的论文\n`);

    if (papersToReanalyze.length === 0) {
        console.log('没有可重新分析的论文');
        return;
    }

    let completed = 0;
    let failed = 0;

    for (let i = 0; i < papersToReanalyze.length; i++) {
        const { paper, pdfText, arxivId } = papersToReanalyze[i];
        console.log(`[${i + 1}/${papersToReanalyze.length}] 重新分析: ${paper.title.substring(0, 60)}...`);
        console.log(`  PDF: ${arxivId}, 文本: ${pdfText.length} 字符`);

        const start = Date.now();
        const result = await analyzeWithRetry(paper, pdfText);
        const durSec = ((Date.now() - start) / 1000).toFixed(1);

        if (result.analysis) {
            completed++;
            // 更新分析结果
            const idx = analysisData.papers.findIndex(p => p.id === paper.id);
            if (idx >= 0) {
                analysisData.papers[idx].analysis = result.analysis;
                analysisData.papers[idx].pdfAnalyzed = true;
                analysisData.papers[idx].arxivId = arxivId;
            }
            writeFileAtomic(ANALYSIS_FILE, JSON.stringify(analysisData, null, 2));
            console.log(`  ✅ 完成 | ${durSec}s\n`);
        } else {
            failed++;
            console.log(`  ❌ 失败 | ${durSec}s | ${result.error}\n`);
        }

        // 避免 rate limit
        if (i < papersToReanalyze.length - 1) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    console.log(`=== 重新分析完成 ===`);
    console.log(`成功: ${completed}, 失败: ${failed}`);
    console.log(`结果已更新: ${ANALYSIS_FILE}`);
}

main().catch(e => {
    console.error('[icml-reanalyze-pdf] 错误:', e);
    process.exit(1);
});
