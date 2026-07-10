#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const {
    loadEnvFile,
    parseAnalysis,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    requestJson,
    loadPrompt,
    normalizeDocumentType
} = require('./utils.js');
const {
    getMissingRequiredSections,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const { PDFParse } = require('pdf-parse');
const { ANALYSIS_CONFIG, ARXIV_CONFIG, SECONDARY_MODEL_CONFIG } = require('./config.js');

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
    apiTemperature: API_TEMPERATURE,
    arxivFetchTimeoutMs: ARXIV_FETCH_TIMEOUT_MS,
    imageDownloadTimeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    imageMaxBytes: IMAGE_MAX_BYTES,
    imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
    imageMaxCount: IMAGE_MAX_COUNT,
    imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS = IMAGE_MAX_BASE64_CHARS * IMAGE_MAX_COUNT,
    imageCandidateMax: IMAGE_CANDIDATE_MAX = IMAGE_MAX_COUNT,
    fullTextMaxChars: FULL_TEXT_MAX_CHARS,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;

/**
 * 清理 gap-fill（审校重写）输出中的前缀废话
 * 确保输出直接从 ## 评分 开始
 * 如果找不到 ## 评分，返回 null 表示格式不正确
 */
function cleanGapFillPrefix(text) {
    if (!text) return null;
    // 找到独立的 "## 评分" 标题；不能误命中 "## 评分理由"
    const scoreMatch = text.match(/(^|\n)##\s*评分\s*(?:\n|$)/);
    if (scoreMatch) {
        return text.substring(scoreMatch.index + scoreMatch[1].length).trim();
    }
    // 如果没有 ## 评分，返回 null（格式不正确，调用方应回退到原始分析）
    return null;
}

const SCORING_DIMENSIONS = Object.freeze([
    { key: 'innovation', machineKey: 'innovation', label: '创新性', max: 2 },
    { key: 'technicalRigor', machineKey: 'technical_rigor', label: '技术严谨性', max: 1.5 },
    { key: 'experimentalSufficiency', machineKey: 'experimental_sufficiency', label: '实验充分性', max: 1.5 },
    { key: 'clarity', machineKey: 'clarity', label: '清晰度', max: 1 },
    { key: 'impact', machineKey: 'impact', label: '影响力', max: 1.5 },
    { key: 'openSource', machineKey: 'open_source', label: '开源', max: 1.5 },
    { key: 'reproducibility', machineKey: 'reproducibility', label: '可复现性', max: 0.5 },
    { key: 'engineering', machineKey: 'engineering_score', label: '工程/实践价值', max: 1.5 }
]);

const FORBIDDEN_SCORING_REASON_PATTERNS = Object.freeze({
    technicalRigor: /不开源|闭源|无法复现|复现性|超参数|训练配置|硬件配置|模型参数|参数量|源码|代码未提供|权重未提供/,
    experimentalSufficiency: /不开源|闭源|无法复现|复现性|超参数|训练配置|硬件配置|源码|代码未提供|权重未提供/,
    clarity: /不开源|闭源|无法复现|复现性|超参数|训练配置|硬件配置|源码|代码未提供|权重未提供/,
    impact: /不开源|闭源|开源程度|开源状态/,
    openSource: /复现性|无法复现|复现步骤/,
    reproducibility: /不开源|闭源|开源程度|开源状态|在线演示/
});

function parseScoringAuditResult(raw) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`评分审计 JSON 无法解析: ${error.message}`);
    }

    const documentType = normalizeDocumentType(parsed.documentType || parsed.document_type);
    if (!documentType) throw new Error('评分审计缺少有效 documentType');

    const confidence = String(parsed.confidence || '').trim();
    if (!['高', '中', '低'].includes(confidence)) throw new Error('评分审计 confidence 非法');
    if (!parsed.dimensions || typeof parsed.dimensions !== 'object' || Array.isArray(parsed.dimensions)) {
        throw new Error('评分审计缺少 dimensions 对象');
    }

    const dimensions = {};
    for (const spec of SCORING_DIMENSIONS) {
        const item = parsed.dimensions[spec.key];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`评分审计缺少维度 ${spec.key}`);
        }
        const score = Number(item.score);
        const reason = String(item.reason || '').trim();
        if (!Number.isFinite(score) || score < 0 || score > spec.max) {
            throw new Error(`评分审计维度 ${spec.key} 分数越界`);
        }
        if (reason.length < 20) throw new Error(`评分审计维度 ${spec.key} 理由过短`);
        const forbiddenPattern = FORBIDDEN_SCORING_REASON_PATTERNS[spec.key];
        if (forbiddenPattern?.test(reason)) {
            throw new Error(`评分审计维度 ${spec.key} 使用了属于其他维度的扣分事实`);
        }
        dimensions[spec.key] = { score: Math.round(score * 10) / 10, reason };
    }

    return recalculateScoringAudit({ documentType, confidence, dimensions });
}

function recalculateScoringAudit(audit) {
    const subtotal = SCORING_DIMENSIONS.reduce((sum, spec) => sum + audit.dimensions[spec.key].score, 0);
    const total = Math.round(Math.min(10, subtotal) * 10) / 10;
    const rankBucket = total >= 9 ? '前10%' : total >= 7.5 ? '前25%' : total >= 5.5 ? '前50%' : '后50%';
    return { ...audit, total, rankBucket };
}

function setMachineSummaryField(analysis, key, value) {
    const bounds = findSectionBounds(analysis, '机器摘要');
    if (!bounds) return analysis;
    const section = analysis.slice(bounds.contentStart, bounds.end);
    const fieldPattern = new RegExp(`^${escapeRegExp(key)}\\s*[：:].*$`, 'm');
    const updatedSection = fieldPattern.test(section)
        ? section.replace(fieldPattern, `${key}: ${value}`)
        : `${key}: ${value}\n${section.replace(/^\s+/, '')}`;
    return analysis.slice(0, bounds.contentStart) + updatedSection + analysis.slice(bounds.end);
}

function applyScoringAuditResult(analysis, audit) {
    let updated = mergeSectionByTitle(analysis, '评分', `${audit.total}/10`);
    updated = setMachineSummaryField(updated, 'document_type', audit.documentType);
    updated = setMachineSummaryField(updated, 'rank_bucket', audit.rankBucket);
    updated = setMachineSummaryField(updated, 'confidence', audit.confidence);
    for (const spec of SCORING_DIMENSIONS) {
        updated = setMachineSummaryField(updated, spec.machineKey, audit.dimensions[spec.key].score);
    }

    const scoringReason = SCORING_DIMENSIONS.map(spec => {
        const item = audit.dimensions[spec.key];
        return `*   ${spec.label} (${item.score}/${spec.max})：${item.reason}`;
    }).join('\n\n');
    return mergeSectionByTitle(updated, '评分理由', scoringReason);
}

function validateScoringAuditAgainstAnalysis(analysis, audit) {
    const current = parseAnalysis(analysis) || {};
    const hasReleasedArtifact = [current.hasCode, current.hasModel, current.hasDataset]
        .some(value => value === '是' || value === 'yes');
    if (!hasReleasedArtifact) {
        const sourceText = String(current.opensource || '');
        const promisesRelease = /承诺开源|计划开源|将(?:会)?开源|will\s+(?:be\s+)?release|will\s+open[- ]source/i.test(sourceText);
        const hasDemo = /\bdemo\b|在线演示|线上演示|体验页面/i.test(sourceText);
        const normalizedScore = promisesRelease ? 0.5 : hasDemo ? 0.2 : 0;
        const normalizedReason = promisesRelease
            ? '论文明确承诺未来开放核心产物，但当前尚未发布可用代码、模型权重或数据资源。'
            : hasDemo
                ? '论文目前只提供可访问的在线演示页面，未发布核心代码、模型权重或训练数据。'
                : '论文未发布核心代码、模型权重或数据资源，也未给出明确的后续开源承诺。';
        if (audit.dimensions.openSource.score !== normalizedScore) {
            console.log(`    [deep] ℹ️  开源分按资源状态归一化: ${audit.dimensions.openSource.score} → ${normalizedScore}`);
        }
        const normalizedAudit = {
            ...audit,
            dimensions: {
                ...audit.dimensions,
                openSource: { score: normalizedScore, reason: normalizedReason }
            }
        };
        return recalculateScoringAudit(normalizedAudit);
    }
    return audit;
}

async function auditTypeAwareScoring(analysis) {
    let lastError = null;
    let validationFeedback = '这是第一次输出，没有上一次校验错误。';
    for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = loadPrompt('prompts/scoring-audit.md', {
            existingAnalysis: analysis,
            validationFeedback
        });
        const raw = await callModel([{ role: 'user', content: [{ type: 'text', text: prompt }] }], 16000);
        try {
            const audit = validateScoringAuditAgainstAnalysis(analysis, parseScoringAuditResult(raw));
            return applyScoringAuditResult(analysis, audit);
        } catch (error) {
            lastError = error;
            validationFeedback = `上一次 JSON 被代码拒绝，精确错误为：${error.message}。请只纠正该错误，同时重新检查全部八个维度。`;
            console.log(`    [deep] ⚠️  评分审计结构校验失败 (${attempt}/3): ${error.message}`);
        }
    }
    throw lastError || new Error('评分审计失败');
}

function getPaperArxivId(paper) {
    return paper?.arxivId || paper?.paper_id || paper?.id || '';
}

function getPreProvidedImageUrls(paper) {
    for (const value of [paper?.allImageUrls, paper?.imageUrls]) {
        if (Array.isArray(value) && value.length > 0) return value;
    }
    return [];
}

// API 配置 - 深度分析阶段（统一使用 PAPER_ANALYZER_*）
const DEEP_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};

// 副模型配置（多模态图像分析，双模型模式）
// 未设置时 endpoint/key 分别回退到主模型对应的值
const SECONDARY_CONFIG = {
    endpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
    key: SECONDARY_MODEL_CONFIG.key || DEEP_CONFIG.key,
    model: SECONDARY_MODEL_CONFIG.model || ''
};

const isDualModel = Boolean(SECONDARY_CONFIG.model && SECONDARY_CONFIG.endpoint && SECONDARY_CONFIG.key);

const missingDeepEnv = [];
if (!DEEP_CONFIG.endpoint) missingDeepEnv.push('PAPER_ANALYZER_ENDPOINT');
if (!DEEP_CONFIG.key) missingDeepEnv.push('PAPER_ANALYZER_API_KEY');
if (!DEEP_CONFIG.model) missingDeepEnv.push('PAPER_ANALYZER_MODEL');
if (missingDeepEnv.length > 0) {
    console.error(`[deep-analyzer] 缺少环境变量: ${missingDeepEnv.join(', ')}。请在项目根目录的 .env 文件中配置`);
    process.exit(1);
}

/**
 * 调用大模型（支持多模态消息）— 带重试机制
 */
async function callModelWithConfig(messages, maxTokens, maxRetries = 3, config = null) {
    const cfg = config || DEEP_CONFIG;
    const startTime = Date.now();
    const apiType = detectApiType(cfg.endpoint, cfg.model);
    const modelUrl = buildApiUrl(apiType, cfg.endpoint);
    const url = new URL(modelUrl);
    console.log(`    [api] → ${cfg.model} | ${apiType} | ${url.hostname}${url.pathname} | max_tokens=${maxTokens} | max_retries=${maxRetries}`);

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await _callModelOnce(messages, maxTokens, cfg, startTime, apiType);
            return result;
        } catch (err) {
            lastError = err;
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`    [api] ⚠️  模型调用失败 (尝试 ${attempt}/${maxRetries}) | ${duration}s | ${err.message}`);

            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * API_RETRY_BASE_DELAY_MS;
                console.log(`    [api] ⏳  ${delay/1000}s 后第 ${attempt + 1} 次重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`模型调用失败，已重试 ${maxRetries} 次: ${lastError.message}`);
}

/**
 * 单次 API 调用（内部方法）
 */
async function _callModelOnce(messages, maxTokens, config, startTime, apiType) {
    const apiUrl = buildApiUrl(apiType, config.endpoint);
    const bodyObj = buildRequestBody(apiType, config.model, messages, maxTokens, API_TEMPERATURE);
    const postData = JSON.stringify(bodyObj);
    const headers = {
        ...buildHeaders(apiType, config.key, postData),
        ...config.headers
    };

    try {
        const response = await requestJson(apiUrl, bodyObj, headers, {
            timeoutMs: API_OVERALL_TIMEOUT_MS,
            agent: false
        });
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = response.body?.error;
            const message = apiError?.message || apiError || response.raw.substring(0, 200);
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${typeof message === 'string' ? message : JSON.stringify(message).substring(0, 200)}`);
            throw new Error(`HTTP ${response.statusCode}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
        }
        const content = parseResponseText(apiType, response.body);
        if (content !== null) {
            console.log(`    [api] ✓ ${config.model} | HTTP ${response.statusCode} | ${content.length} chars | ${duration}s`);
            return content;
        }
        if (response.body.error) {
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${response.body.error.message || JSON.stringify(response.body.error).substring(0, 100)}`);
            throw new Error(response.body.error.message || JSON.stringify(response.body.error));
        }
        console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | invalid response`);
        throw new Error('Invalid response: ' + response.raw.substring(0, 200));
    } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`    [api] ✗ ${config.model} | request error | ${duration}s | ${err.message}`);
        throw err;
    }
}

async function callModel(messages, maxTokens = 8000) {
    const modelName = DEEP_CONFIG.model;
    console.log(`    [analyzer] ╔═══════════════════════════════════════════════════╗`);
    console.log(`    [analyzer] ║  正在使用模型: ${modelName}`);
    console.log(`    [analyzer] ╚═══════════════════════════════════════════════════╜`);
    return await callModelWithConfig(messages, maxTokens, 3);
}

const cheerio = require('cheerio');

function safeImageLabel(url) {
    const value = String(url || '');
    if (!value) return '<empty>';
    if (value.startsWith('data:')) {
        const mime = value.match(/^data:([^;,]+)/)?.[1] || 'data-uri';
        return `${mime};base64,<omitted>`;
    }
    try {
        const parsed = new URL(value);
        const name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return name.length > 120 ? `${name.slice(0, 117)}...` : name;
    } catch {
        return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
}

function isSupportedImageUrl(url) {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) return false;
    let path = '';
    try {
        path = new URL(value).pathname.toLowerCase();
    } catch {
        path = value.split('?')[0].toLowerCase();
    }
    if (path.endsWith('.svg')) return false;
    if (/\.(png|jpe?g|webp)$/i.test(path)) return true;
    const leaf = path.split('/').pop() || '';
    return !/\.[a-z0-9]{2,5}$/i.test(leaf);
}

function parseContentLength(value) {
    if (!value) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeImageMime(contentType) {
    if (!contentType) return '';
    return String(contentType).split(';')[0].trim().toLowerCase();
}

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return '';
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return '';
}

function isAllowedImageMime(mime) {
    return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

async function readResponseBufferWithLimit(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (maxBytes > 0 && buffer.byteLength > maxBytes) {
            throw new Error(`response body ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (maxBytes > 0 && total > maxBytes) {
                try {
                    await reader.cancel();
                } catch (e) {
                    // ignore cancel errors
                }
                throw new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
            }
            chunks.push(chunk);
        }
    } finally {
        if (reader.releaseLock) {
            reader.releaseLock();
        }
    }
    return Buffer.concat(chunks, total);
}

function getArxivHtmlIds(arxivId) {
    const id = String(arxivId || '').trim();
    if (!id) return [];
    if (/v\d+$/i.test(id)) {
        const base = id.replace(/v\d+$/i, '');
        return [id, base];
    }
    return [id, `${id}v2`, `${id}v1`];
}

function isStableArxivHtmlMiss(status) {
    return status === 400 || status === 403 || status === 404;
}

/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivText(arxivId) {
    const maxRetries = 6;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let shouldRetryHtml = false;
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)
                });

                if (response.status === 429) {
                    shouldRetryHtml = true;
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = baseWait + jitter;
                    console.log(`    [deep] fetchArxivText ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (response.ok) {
                    const html = await response.text();
                    const $ = cheerio.load(html);

                    // 移除噪音元素
                    $('script, style, nav, header, footer, aside, noscript, iframe').remove();
                    // 移除交互式元素和参考文献列表（保留正文的引用标记，移除完整列表以节省空间）
                    $('.ltx_bibliography, .bibtex, [role="navigation"], .ltx_TOC').remove();

                    // 尝试从内容区域提取文本（按优先级）
                    let content = '';
                    const selectors = [
                        '.ltx_page_content',      // LaTeXML 新版 arXiv
                        '.ltx_page_main',         // LaTeXML 备选
                        'article',                // 通用文章标签
                        '#content',               // 旧版容器
                        '.content',               // 通用内容区
                        'body'                    // 最终备选
                    ];

                    for (const sel of selectors) {
                        const el = $(sel);
                        if (el.length > 0) {
                            content = el.text();
                            break;
                        }
                    }

                    // 清理空白
                    content = content
                        .replace(/\n\s*\n/g, '\n')     // 合并多余空行
                        .replace(/[ \t]+/g, ' ')       // 合并多余空格
                        .trim();

                    return content;
                }
                console.log(`    [deep] fetchArxivText ${htmlId} HTTP ${response.status}`);
                if (!isStableArxivHtmlMiss(response.status)) {
                    shouldRetryHtml = true;
                }
            } catch (e) {
                shouldRetryHtml = true;
                console.log(`    [deep] fetchArxivText ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (!shouldRetryHtml) {
            console.log(`    [deep] fetchArxivText ${arxivId} HTML stable miss, trying PDF fallback...`);
            break;
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivText ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} HTML failed after ${maxRetries} retries, trying PDF fallback...`);

    // PDF fallback: download PDF and extract text
    for (const pdfId of getArxivHtmlIds(arxivId)) {
        const pdfUrl = `https://arxiv.org/pdf/${pdfId}.pdf`;
        try {
            const pdfResponse = await fetch(pdfUrl, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(60000)
            });
            if (!pdfResponse.ok) {
                console.log(`    [deep] PDF ${pdfUrl} HTTP ${pdfResponse.status}`);
                continue;
            }
            const buffer = await pdfResponse.arrayBuffer();
            const parser = new PDFParse({ data: Buffer.from(buffer) });
            const result = await parser.getText();
            await parser.destroy();
            if (result.text) {
                console.log(`    [deep] PDF fallback success for ${arxivId}, extracted ${result.text.length} chars`);
                return result.text
                    .replace(/\n\s*\n/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
            }
        } catch (e) {
            console.log(`    [deep] PDF fallback ${pdfUrl} error: ${e.message}`);
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} PDF fallback also failed`);
    return '';
}

/**
 * 从 arxiv HTML 获取图片信息列表（含 URL 和 caption）
 * 使用 cheerio 解析 <figure> 元素，提取图片 URL 和 figcaption 文本
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivImageUrls(arxivId) {
    const maxRetries = 6;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(30000)
                });

                if (response.status === 429) {
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = baseWait + jitter;
                    console.log(`    [deep] fetchArxivImageUrls ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (!response.ok) continue;

                const html = await response.text();
                const $ = cheerio.load(html);
                const images = [];

                // 遍历所有 <figure> 元素，提取图片和 caption
                $('figure').each((_, elem) => {
                    const $fig = $(elem);
                    const $img = $fig.find('img').first();

                    let fullUrl = '';
                    if ($img.length) {
                        const src = $img.attr('src') || '';
                        if (!src) return;
                        if (src.includes('arxiv-logo') || src.includes('favicon') || src.includes('logo')) return;
                        if (src.startsWith('data:')) return;

                        // 构建完整 URL
                        if (src.startsWith('http')) {
                            fullUrl = src;
                        } else if (src.startsWith('/')) {
                            fullUrl = `https://arxiv.org${src}`;
                        } else if (src.startsWith(`${htmlId}`) || src.startsWith(`${String(arxivId).replace(/v\d+$/i, '')}`)) {
                            // 新版 HTML：src 已包含 arxivId 前缀
                            fullUrl = `https://arxiv.org/html/${src}`;
                        } else {
                            // 旧版 HTML：src 为纯文件名
                            fullUrl = `https://arxiv.org/html/${htmlId}/${src}`;
                        }
                    }

                    if (!fullUrl) return;
                    if (!isSupportedImageUrl(fullUrl)) return;

                    // 提取 figcaption 文本
                    const $caption = $fig.find('figcaption');
                    let caption = '';
                    if ($caption.length) {
                        caption = $caption.text().replace(/\s+/g, ' ').trim();
                    }
                    // 备选：从 img 的 alt 属性获取
                    if (!caption && $img.length) {
                        const alt = $img.attr('alt') || '';
                        if (alt && alt !== 'Refer to caption') {
                            caption = alt.trim();
                        }
                    }

                    images.push({ url: fullUrl, caption });
                });

                // 如果 <figure> 解析不到图片，回退到正则提取（兼容旧版 HTML）
                if (images.length === 0) {
                    const imgRegex = /src="([^"]*\.(png|jpg|jpeg)[^"]*)"/g;
                    let match;
                    while ((match = imgRegex.exec(html)) !== null) {
                        const src = match[1];
                        if (src.includes('arxiv-logo') || src.includes('favicon') || src.includes('logo')) continue;
                        if (src.startsWith('data:')) continue;
                        let fullUrl;
                        if (src.startsWith('http')) {
                            fullUrl = src;
                        } else if (src.startsWith('/')) {
                            fullUrl = `https://arxiv.org${src}`;
                        } else if (src.startsWith(`${htmlId}`) || src.startsWith(`${String(arxivId).replace(/v\d+$/i, '')}`)) {
                            fullUrl = `https://arxiv.org/html/${src}`;
                        } else {
                            fullUrl = `https://arxiv.org/html/${htmlId}/${src}`;
                        }
                        if (isSupportedImageUrl(fullUrl)) {
                            images.push({ url: fullUrl, caption: '' });
                        }
                    }
                }

                return images;
            } catch (e) {
                console.log(`    [deep] fetchArxivImageUrls ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivImageUrls ${arxivId} failed after ${maxRetries} retries`);
    return [];
}

/**
 * 下载图片并转为 base64
 */
async function downloadImageBase64(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES) {
    if (!isSupportedImageUrl(imageUrl)) {
        console.log(`    [deep] 跳过不支持的图片: ${safeImageLabel(imageUrl)}`);
        return null;
    }

    const fileName = safeImageLabel(imageUrl);
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(imageUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
                signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS)
            });
            if (!response.ok) {
                if (attempt < maxRetries) {
                    console.log(`    [deep] 下载图片 ${fileName} HTTP ${response.status}，${(attempt + 1) * 2}s 后重试...`);
                    await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
                    continue;
                }
                console.log(`    [deep] 下载图片 ${fileName} 失败: HTTP ${response.status}`);
                return null;
            }

            const headerMime = normalizeImageMime(response.headers.get('content-type'));
            if (headerMime && !isAllowedImageMime(headerMime) && headerMime !== 'application/octet-stream') {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Type=${headerMime}`);
                return null;
            }

            const contentLength = parseContentLength(response.headers.get('content-length'));
            if (contentLength !== null && maxBytes > 0 && contentLength > maxBytes) {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Length ${(contentLength / 1024 / 1024).toFixed(1)}MB 超过限制`);
                return null;
            }

            const buffer = await readResponseBufferWithLimit(response, maxBytes);

            const sniffedMime = sniffImageMime(buffer);
            if (!isAllowedImageMime(sniffedMime)) {
                console.log(`    [deep] 跳过图片 ${fileName}: 文件头不是支持的 PNG/JPEG/WebP`);
                return null;
            }

            return {
                base64: buffer.toString('base64'),
                mime: sniffedMime
            };
        } catch (e) {
            lastError = e.message;
            if (/exceeds limit/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return null;
            }
            if (attempt < maxRetries) {
                console.log(`    [deep] 下载图片 ${fileName} 失败 (${e.message})，${(attempt + 1) * 2}s 后重试...`);
                await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            }
        }
    }
    console.log(`    [deep] 下载图片 ${fileName} 最终失败: ${lastError}`);
    return null;
}

/**
 * 串行下载图片（避免并发导致 arxiv 限流）
 * @param {string[]} imageUrls - 图片 URL 列表
 * @param {number} maxCount - 最大下载数量
 * @param {number} maxBase64Chars - 单张 base64 字符数上限
 * @param {number} maxTotalBase64Chars - 所有图片 base64 字符数上限
 * @returns {Promise<Array<{url: string, base64: string, mime: string}>>}
 */
async function downloadImagesSerial(imageUrls, maxCount, maxBase64Chars, maxTotalBase64Chars = IMAGE_TOTAL_BASE64_CHARS) {
    const results = [];
    let totalBase64Chars = 0;
    // 去重避免同一 URL 下载多次
    const uniqueUrls = [...new Set(imageUrls)];

    for (const url of uniqueUrls) {
        if (results.length >= maxCount) break;
        if (maxTotalBase64Chars > 0 && totalBase64Chars >= maxTotalBase64Chars) {
            console.log(`    [deep] 图片总 payload 已达上限 ${(maxTotalBase64Chars / 1024).toFixed(1)}KB，停止下载更多图片`);
            break;
        }
        try {
            const image = await downloadImageBase64(url, 5, IMAGE_MAX_BYTES);
            if (image?.base64 && image.base64.length < maxBase64Chars) {
                if (maxTotalBase64Chars > 0 && totalBase64Chars + image.base64.length > maxTotalBase64Chars) {
                    console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: 加入后总 base64 ${((totalBase64Chars + image.base64.length) / 1024).toFixed(1)}KB 超过上限`);
                    continue;
                }
                totalBase64Chars += image.base64.length;
                console.log(`    [deep] 下载图片 ${safeImageLabel(url)}: ${(image.base64.length / 1024).toFixed(1)}KB, ${image.mime}`);
                results.push({ url, base64: image.base64, mime: image.mime });
            } else if (image?.base64) {
                console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: base64 ${(image.base64.length / 1024).toFixed(1)}KB 超过限制`);
            }
        } catch (e) {
            // 已在 downloadImageBase64 中记录错误
        }
    }

    return results;
}

function scoreImageCandidate(info, index) {
    const text = `${info.url || ''} ${info.caption || ''}`.toLowerCase();
    let score = 0;
    const strong = [
        'architecture', 'framework', 'overview', 'pipeline', 'method', 'model',
        'spectrogram', 'waveform', 'mel', 'audio', 'speech', 'music',
        'result', 'results', 'comparison', 'ablation', 'analysis', 'evaluation',
        'table', 'benchmark', 'performance', 'visualization',
        '架构', '框架', '流程', '模型', '模块', '方法', '系统',
        '语谱', '频谱', '波形', '音频', '语音', '音乐',
        '结果', '对比', '消融', '实验', '评估', '性能', '可视化'
    ];
    const weak = ['fig', 'figure', '图'];
    const negative = ['logo', 'favicon', 'icon', 'author', 'portrait', 'license', 'qr', '二维码'];

    for (const kw of strong) {
        if (text.includes(kw)) score += 3;
    }
    for (const kw of weak) {
        if (text.includes(kw)) score += 1;
    }
    for (const kw of negative) {
        if (text.includes(kw)) score -= 8;
    }
    if (info.caption && info.caption.length > 20) score += 2;
    // 论文前几张图通常是 overview/architecture，给一点顺序先验。
    score += Math.max(0, 6 - index);
    return score;
}

function selectImageCandidates(imageInfos, maxCount) {
    if (!Array.isArray(imageInfos) || imageInfos.length === 0) return [];
    const seen = new Set();
    const unique = [];
    for (const info of imageInfos) {
        if (!info || !info.url || seen.has(info.url)) continue;
        if (!isSupportedImageUrl(info.url)) continue;
        seen.add(info.url);
        unique.push(info);
    }
    if (unique.length <= maxCount) return unique;
    return unique
        .map((info, index) => ({ info, index, score: scoreImageCandidate(info, index) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, maxCount)
        .sort((a, b) => a.index - b.index)
        .map(item => item.info);
}

function normalizeImageInfos(input) {
    if (!Array.isArray(input)) return [];
    return input.map(item => {
        if (!item) return null;
        if (typeof item === 'string') return { url: item, caption: '' };
        if (typeof item === 'object' && item.url) {
            return {
                url: item.url,
                caption: item.caption || item.alt || item.description || ''
            };
        }
        return null;
    }).filter(info => info && info.url && isSupportedImageUrl(info.url));
}

/**
 * 构造图片消息块
 */
function buildImageContent(imageUrl, base64, detectedMime = '') {
    if (base64) {
        const lower = imageUrl.toLowerCase().split('?')[0];
        let mime = isAllowedImageMime(detectedMime) ? detectedMime : 'image/png';
        if (imageUrl.startsWith('data:image/svg+xml')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) {
            mime = 'image/jpeg';
        } else if (lower.endsWith('.svg')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && lower.endsWith('.webp')) {
            mime = 'image/webp';
        }
        return {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}` }
        };
    }
    return {
        type: 'image_url',
        image_url: { url: imageUrl }
    };
}

function removeUnapprovedMarkdownImages(text, allowedUrls) {
    if (!text) return text;
    const allowed = new Set(allowedUrls || []);
    return text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, url) => {
        return allowed.has(url) ? match : '';
    });
}

const ALLOWED_IMAGE_INSERTION_SECTIONS = new Set([
    '核心摘要',
    '方法概述和架构',
    '核心创新点',
    '实验结果',
    '细节详述'
]);

function sanitizeImagePlanText(text, maxChars = 260) {
    return String(text || '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars)
        .trim();
}

function extractJsonObjectText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1).trim();
    }
    return text;
}

function parseImageInsertionPlan(raw, imageInfos = []) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (e) {
        return [];
    }

    const items = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.insertions) ? parsed.insertions : []);
    const used = new Set();
    const plans = [];

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const imageNumber = Number(item.image ?? item.imageIndex ?? item.figure ?? item.figureNumber);
        if (!Number.isInteger(imageNumber) || imageNumber < 1 || imageNumber > imageInfos.length) continue;
        if (used.has(imageNumber)) continue;

        const section = sanitizeImagePlanText(item.section, 60);
        if (!ALLOWED_IMAGE_INSERTION_SECTIONS.has(section)) continue;

        const anchor = sanitizeImagePlanText(item.anchor, 180);
        const replacement = anchor
            ? sanitizeImagePlanText(item.replacement || item.replaceAnchorWith || item.rewrite, 420)
            : '';
        const lead = sanitizeImagePlanText(item.lead || item.before || item.intro, 220);
        const explanation = sanitizeImagePlanText(item.explanation || item.after || item.note, 320);
        if (!lead && !explanation) continue;

        used.add(imageNumber);
        plans.push({
            imageNumber,
            section,
            anchor,
            replacement,
            lead,
            explanation
        });
    }

    return plans;
}

function findSectionBounds(analysis, title) {
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return null;
    const start = match.index + match[1].length;
    const contentStart = start + match[2].length;
    const rest = analysis.slice(contentStart);
    const next = /\n#{2,3}\s/.exec(rest);
    const end = next ? contentStart + next.index : analysis.length;
    return { start, contentStart, end };
}

function buildImageInsertionBlock(plan, imageInfo) {
    const parts = [];
    if (plan.lead) parts.push(plan.lead);
    parts.push(`![${imageInfo.caption || `图${plan.imageNumber}`}](${imageInfo.url})`);
    if (plan.explanation) parts.push(plan.explanation);
    return parts.join('\n\n');
}

function paragraphEndAfter(text, offset) {
    const paragraphEnd = text.indexOf('\n\n', offset);
    return paragraphEnd >= 0 ? paragraphEnd : offset;
}

function insertImageBlockIntoSection(analysis, plan, imageInfo) {
    const bounds = findSectionBounds(analysis, plan.section);
    if (!bounds) return { analysis, inserted: false };

    const block = buildImageInsertionBlock(plan, imageInfo);
    let sectionText = analysis.slice(bounds.contentStart, bounds.end);
    let insertOffset = sectionText.length;

    if (plan.anchor) {
        const anchorIndex = sectionText.indexOf(plan.anchor);
        if (anchorIndex >= 0) {
            const hasReplacement = plan.replacement && plan.replacement !== plan.anchor;
            const anchorEnd = anchorIndex + plan.anchor.length;
            if (hasReplacement) {
                sectionText = sectionText.slice(0, anchorIndex)
                    + plan.replacement
                    + sectionText.slice(anchorEnd);
            }

            const afterAnchorText = anchorIndex + (hasReplacement ? plan.replacement.length : plan.anchor.length);
            insertOffset = paragraphEndAfter(sectionText, afterAnchorText);
        }
    }

    const mentionPattern = new RegExp(`(?:图|Figure\\s*)${plan.imageNumber}(?!\\d)`, 'i');
    const mentionMatch = mentionPattern.exec(sectionText);
    if (mentionMatch && mentionMatch.index < insertOffset) {
        insertOffset = paragraphEndAfter(sectionText, mentionMatch.index + mentionMatch[0].length);
    }

    const beforeSection = analysis.slice(0, bounds.contentStart);
    const afterSection = analysis.slice(bounds.end);
    const beforeInsert = sectionText.slice(0, insertOffset).replace(/\s+$/, '');
    const afterInsert = sectionText.slice(insertOffset).replace(/^\s+/, '\n\n');

    return {
        analysis: `${beforeSection}${beforeInsert}\n\n${block}\n\n${afterInsert}${afterSection}`.replace(/\n{4,}/g, '\n\n\n'),
        inserted: true
    };
}

function normalizeGenericImageOrder(analysis, selectedImageUrls) {
    let updated = analysis;
    let genericAltIndex = 0;
    updated = updated.replace(/!\[图\d+\]\(([^)]+)\)/g, (match, url) => {
        if (!selectedImageUrls.includes(url)) return match;
        genericAltIndex++;
        return `![图${genericAltIndex}](${url})`;
    });

    const selectedSet = new Set(selectedImageUrls);
    const orderedSelectedImageUrls = [];
    for (const match of updated.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const url = match[1];
        if (selectedSet.has(url) && !orderedSelectedImageUrls.includes(url)) {
            orderedSelectedImageUrls.push(url);
        }
    }
    return { analysis: updated, selectedImageUrls: orderedSelectedImageUrls };
}

function applyImageInsertionPlan(analysis, plans, imageInfos) {
    let updated = analysis;
    const selectedImageUrls = [];
    for (const plan of plans) {
        const imageInfo = imageInfos[plan.imageNumber - 1];
        if (!imageInfo) continue;
        const result = insertImageBlockIntoSection(updated, plan, imageInfo);
        if (!result.inserted) continue;
        updated = result.analysis;
        selectedImageUrls.push(imageInfo.url);
    }

    updated = removeUnapprovedMarkdownImages(updated, selectedImageUrls);
    return normalizeGenericImageOrder(updated, selectedImageUrls);
}

async function applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages) {
    if (!isDualModel || downloadedImages.length === 0) {
        return { analysis, selectedImageUrls: [] };
    }

    const imageInfoByUrl = new Map(imageInfos.map(info => [info.url, info]));
    const usableImageInfos = downloadedImages.map(img => imageInfoByUrl.get(img.url) || { url: img.url, caption: '' });

    const secondaryApiType = detectApiType(SECONDARY_CONFIG.endpoint, SECONDARY_CONFIG.model);
    const secondaryUrl = new URL(buildApiUrl(secondaryApiType, SECONDARY_CONFIG.endpoint));
    const secondaryEndpointSource = SECONDARY_MODEL_CONFIG.endpoint ? '副模型 endpoint' : '复用主模型 endpoint';
    const secondaryKeySource = SECONDARY_MODEL_CONFIG.key ? '副模型 key' : '复用主模型 key';
    const downloadedBase64Chars = downloadedImages.reduce((sum, img) => sum + (img.base64?.length || 0), 0);
    console.log(`    [secondary] ▶ 图片筛选开始 | paper=${arxivId} | model=${SECONDARY_CONFIG.model} | protocol=${secondaryApiType}`);
    console.log(`    [secondary]    endpoint=${secondaryUrl.hostname}${secondaryUrl.pathname} | endpoint_source=${secondaryEndpointSource} | key_source=${secondaryKeySource}`);
    console.log(`    [secondary]    candidates=${imageInfos.length} | downloaded=${downloadedImages.length} | prompt_images=${usableImageInfos.length} | base64_chars=${downloadedBase64Chars} | max_tokens=${API_MAX_TOKENS}`);
    usableImageInfos.forEach((info, index) => {
        const downloaded = downloadedImages[index];
        console.log(`    [secondary]    input[${index + 1}] ${safeImageLabel(info.url)} | mime=${downloaded?.mime || 'unknown'} | base64_chars=${downloaded?.base64?.length || 0} | caption=${info.caption || '无描述'}`);
    });

    const imageListStr = usableImageInfos.map((info, i) =>
        `图${i + 1}: ${safeImageLabel(info.url)}\n  URL: ${info.url}\n  caption: ${info.caption || '无描述'}`
    ).join('\n\n');
    const supplementPrompt = loadPrompt('prompts/image-supplement.md', {
        title: paper.title,
        arxivId,
        imageList: imageListStr,
        primaryAnalysis: analysis
    });

    const supplementContent = [{ type: 'text', text: supplementPrompt }];
    for (const img of downloadedImages) {
        supplementContent.push(buildImageContent(img.url, img.base64, img.mime));
    }

    console.log(`    [secondary]    request_content_blocks=${supplementContent.length} | text_chars=${supplementPrompt.length}`);
    const secondaryStartedAt = Date.now();

    const planText = await callModelWithConfig(
        [{ role: 'user', content: supplementContent }],
        API_MAX_TOKENS, 3, SECONDARY_CONFIG
    );

    const plans = parseImageInsertionPlan(planText, usableImageInfos);
    console.log(`    [secondary] ◀ 图片筛选返回 | duration_s=${((Date.now() - secondaryStartedAt) / 1000).toFixed(1)} | response_chars=${planText.length} | valid_insertions=${plans.length}`);
    if (plans.length > 0) {
        plans.forEach((plan, index) => {
            const imageInfo = usableImageInfos[plan.imageNumber - 1];
            console.log(`    [secondary]    plan[${index + 1}] image=${plan.imageNumber}(${safeImageLabel(imageInfo?.url)}) | section=${plan.section} | anchor=${plan.anchor ? 'matched' : 'section-end'} | replacement=${plan.replacement ? 'yes' : 'no'} | lead_chars=${plan.lead.length} | explanation_chars=${plan.explanation.length}`);
        });
    }
    if (plans.length === 0) {
        console.log(`    [secondary] ℹ️  未生成有效插图计划，保留主模型纯文本分析`);
        return { analysis, selectedImageUrls: [] };
    }

    const { analysis: replaced, selectedImageUrls } = applyImageInsertionPlan(analysis, plans, usableImageInfos);
    console.log(`    [secondary] ✅ 图片计划合并完成 | inserted=${selectedImageUrls.length}/${usableImageInfos.length} | selected=${selectedImageUrls.map(safeImageLabel).join(', ') || 'none'}`);

    return { analysis: replaced, selectedImageUrls };
}

/**
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper) {
    const arxivId = getPaperArxivId(paper);
    console.log(`    [deep] 获取全文: ${arxivId}`);

    // 优先使用预提供的全文（ICML/会议场景），否则从 arXiv 抓取
    let fullText = paper.fullText || paper.pdfText || '';
    if (!fullText && /^\d+\.\d+/.test(arxivId)) {
        try {
            fullText = await fetchArxivText(arxivId);
            console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
        } catch (e) {
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }
    } else if (fullText) {
        console.log(`    [deep] 使用预提供全文: ${fullText.length} 字符`);
    }

    const rawTextForAnalysis = fullText || (paper.abstract || paper.summary || '');
    const textForAnalysis = rawTextForAnalysis.length > FULL_TEXT_MAX_CHARS
        ? rawTextForAnalysis.slice(0, FULL_TEXT_MAX_CHARS)
        : rawTextForAnalysis;
    if (rawTextForAnalysis.length > textForAnalysis.length) {
        console.log(`    [deep] 全文过长，截断到 ${textForAnalysis.length}/${rawTextForAnalysis.length} 字符`);
    }
    const hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;

    if (!textForAnalysis || textForAnalysis.trim().length < 10) {
        console.log(`    [deep] ⚠️  论文无有效文本内容（全文和摘要均为空），无法分析`);
        return { ...paper, analysis: null, error: '论文无有效文本内容' };
    }

    // 优先使用预提供的图片 URL（ICML/会议场景），否则从 arXiv 抓取
    let imageInfos = [];
    const preProvidedUrls = getPreProvidedImageUrls(paper);
    if (preProvidedUrls.length > 0) {
        imageInfos = normalizeImageInfos(preProvidedUrls);
        console.log(`    [deep] 使用预提供图片: ${imageInfos.length} 张`);
    } else if (/^\d+\.\d+/.test(arxivId)) {
        try {
            imageInfos = await fetchArxivImageUrls(arxivId);
            console.log(`    [deep] 找到 ${imageInfos.length} 张图片`);
        } catch (e) {
            console.log(`    [deep] 获取图片失败: ${e.message}`);
        }
    }

    // 提取纯 URL 列表用于下载和保存
    const imageUrls = imageInfos.map(info => info.url);
    const candidateImageInfos = selectImageCandidates(imageInfos, IMAGE_CANDIDATE_MAX);
    const candidateImageUrls = candidateImageInfos.map(info => info.url);
    const candidateUrlSet = new Set(candidateImageUrls);
    const imageManifest = {
        totalFound: imageInfos.length,
        candidateLimit: IMAGE_CANDIDATE_MAX,
        downloadLimit: IMAGE_MAX_COUNT,
        maxImageBytes: IMAGE_MAX_BYTES,
        maxImageBase64Chars: IMAGE_MAX_BASE64_CHARS,
        maxTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        candidates: imageInfos.map((info, index) => ({
            url: info.url,
            caption: info.caption || '',
            score: scoreImageCandidate(info, index),
            selectedForDownload: candidateUrlSet.has(info.url)
        })),
        downloaded: [],
        selected: []
    };
    if (imageInfos.length > candidateImageInfos.length) {
        console.log(`    [deep] 图片候选预筛: ${imageInfos.length} → ${candidateImageInfos.length} 张`);
    }

    const hasFullTextIntro = hasFullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。';

    const downloadedImages = isDualModel
        ? await downloadImagesSerial(candidateImageUrls, IMAGE_MAX_COUNT, IMAGE_MAX_BASE64_CHARS, IMAGE_TOTAL_BASE64_CHARS)
        : [];
    imageManifest.downloaded = downloadedImages.map(img => ({
        url: img.url,
        mime: img.mime,
        base64Chars: img.base64.length
    }));
    if (isDualModel) {
        console.log(`    [deep] 成功下载 ${downloadedImages.length}/${candidateImageUrls.length} 张候选图片（总图片 ${imageUrls.length} 张）`);
    } else if (candidateImageUrls.length > 0) {
        console.log(`    [deep] 单模型模式：跳过 ${candidateImageUrls.length} 张候选图片下载，仅保存候选元数据`);
    }

    const prompt = loadPrompt('prompts/deep-analysis.md', {
        hasFullText: hasFullTextIntro,
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        arxivId: arxivId,
        textForAnalysis: textForAnalysis
    });

    let analysis = '';
    // Round 1: Main analysis
    if (isDualModel && downloadedImages.length > 0) {
        // ========== 双模型模式 ==========
        console.log(`    [deep] 🧠 双模型模式：主模型(${DEEP_CONFIG.model})先做文本分析，后续由副模型(${SECONDARY_CONFIG.model})最终筛图补充`);

        // Round 1a: Primary model (text-only)
        try {
            analysis = await callModelWithConfig(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS, 3, DEEP_CONFIG
            );
            console.log(`    [deep] ✅ 主模型文本分析完成 (${analysis.length} chars)`);
        } catch (err) {
            console.error(`    [deep] 主模型文本分析失败: ${err.message}`);
            return { ...paper, analysis: null, error: err.message };
        }
    } else {
        // ========== 单模型模式：仅文本分析，不分析图片 ==========
        if (downloadedImages.length > 0) {
            console.log(`    [deep] 未配置副模型，跳过图片分析 (${downloadedImages.length} 张图片仅用于元数据)`);
        } else {
            console.log(`    [deep] 无可用图片，仅文本分析`);
        }

        try {
            analysis = await callModel(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS
            );
            console.log(`    [deep] ✅ 文本分析完成`);
        } catch (err) {
            console.error(`    [deep] 文本分析失败: ${err.message}`);
            return { ...paper, analysis: null, error: err.message };
        }
    }

    let selectedImageUrls = [];

    // 第2轮：开源扫描
    try {
        const ossText = await scanOpensource(paper, textForAnalysis);
        if (ossText) {
            analysis = mergeSection(analysis, '## 开源详情', ossText);
            console.log(`    [deep] ✅ 开源扫描完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  开源扫描失败: ${e.message}`);
    }

    // 第2.5轮：检查 demo 页面中的开源链接
    let demoFoundLinks = [];
    try {
        if (!hasOpenSourceLinks(analysis)) {
            const demoUrls = extractDemoUrls(analysis);
            if (demoUrls.length > 0) {
                console.log(`    [deep] 🔍 发现 ${demoUrls.length} 个 demo 页面，检查开源链接...`);
                const allOpenSourceLinks = [];
                for (const url of demoUrls.slice(0, 3)) { // 最多检查3个
                    const links = await checkDemoPageForOpensource(url);
                    allOpenSourceLinks.push(...links);
                }
                if (allOpenSourceLinks.length > 0) {
                    demoFoundLinks = [...new Set(allOpenSourceLinks)];
                    const newLinksText = demoFoundLinks.map(link => `- ${link}`).join('\n');
                    analysis = mergeSection(analysis, '## 开源详情',
                        `\n\n**从 demo 页面发现的开源链接：**\n${newLinksText}`);
                    console.log(`    [deep] ✅ 从 demo 页面发现 ${demoFoundLinks.length} 个开源链接`);
                } else {
                    console.log(`    [deep] ℹ️  demo 页面未发现开源链接`);
                }
            }
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  检查 demo 页面失败: ${e.message}`);
    }

    // 第2.6轮：根据 demo 扫描结果更新开源评分和描述
    if (demoFoundLinks.length > 0) {
        const beforeUpdate = analysis;
        analysis = updateOpensourceFromDemoLinks(analysis, demoFoundLinks);
        if (analysis !== beforeUpdate) {
            console.log(`    [deep] ✅ 已根据 demo 扫描结果更新开源评分/描述`);
        }
    }

    // 第3轮：审校重写（对照原文修正、补充、删减，完全重写前两轮输出）
    try {
        const revisedText = await reviseAnalysis(paper, analysis, textForAnalysis);
        if (revisedText && revisedText.length > 100) {
            const cleaned = cleanGapFillPrefix(revisedText.trim());
            if (cleaned) {
                analysis = cleaned;
                console.log(`    [deep] ✅ 审校重写完成`);
            } else {
                console.log(`    [deep] ⚠️  审校重写输出格式不正确（缺少 ## 评分），回退到原始分析`);
            }
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  审校重写失败: ${e.message}`);
    }

    // 第3.5轮：检查并修复实验结果中缺失的表格
    try {
        const fixed = await checkAndFixTables(paper, analysis, textForAnalysis);
        if (fixed && fixed !== analysis) {
            analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
            console.log(`    [deep] ✅ 表格补充完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  表格补充失败: ${e.message}`);
    }

    // 第3.6轮：检查并修复方法概述部分不够详细的问题
    try {
        const fixed = await checkAndFixMethodSection(paper, analysis, textForAnalysis);
        if (fixed && fixed !== analysis) {
            analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
            console.log(`    [deep] ✅ 方法概述补充完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  方法概述补充失败: ${e.message}`);
    }

    // 第3.65轮：只在分析缺少标题时修复完整结构，避免外层重新执行全部分析轮次。
    const missingSections = getMissingRequiredSections(analysis);
    if (missingSections.length > 0) {
        console.log(`    [deep] 🔧 检测到缺失章节，执行最终结构修复: ${missingSections.join('、')}`);
        analysis = await repairMissingAnalysisSections(paper, analysis, textForAnalysis);
        console.log(`    [deep] ✅ 最终结构修复完成`);
    }

    // 第3.7轮：主模型只审计文档类型和八维评分，避免长文审校时发生重复扣分。
    analysis = await auditTypeAwareScoring(analysis);
    console.log(`    [deep] ✅ 类型感知评分审计完成`);
    const auditedInvalidReason = getInvalidAnalysisReason(analysis, parseAnalysis(analysis));
    if (auditedInvalidReason) {
        throw new Error(`评分审计后的分析未通过最终契约: ${auditedInvalidReason}`);
    }

    // 最后一轮：副模型基于最终文本筛选高价值图片，代码按 JSON 计划做受限局部插图合并。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
    if (isDualModel && downloadedImages.length > 0) {
        try {
            const imageResult = await applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages);
            const imageInvalidReason = getInvalidAnalysisReason(imageResult.analysis, parseAnalysis(imageResult.analysis));
            if (imageInvalidReason) {
                console.log(`    [deep] ⚠️  插图结果破坏最终契约，丢弃本篇插图计划: ${imageInvalidReason}`);
            } else {
                analysis = imageResult.analysis;
                selectedImageUrls = imageResult.selectedImageUrls;
                imageManifest.selected = selectedImageUrls;
            }
        } catch (err) {
            console.log(`    [deep] ⚠️  副模型图片筛选失败: ${err.message}，保留纯文本分析结果`);
        }
    }

    return {
        ...paper,
        analysis: analysis,
        imageUrls: selectedImageUrls,
        selectedImageUrls,
        allImageUrls: imageUrls,
        imageManifest
    };
}

async function scanOpensource(paper, textForAnalysis) {
    const prompt = loadPrompt('prompts/opensource-scan.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], 8000);
}

/**
 * 从分析文本中提取 demo/项目页面 URL
 */
function extractDemoUrls(analysis) {
    const urls = [];
    // 匹配各种可能的 demo/项目页面链接
    const patterns = [
        /Demo[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /项目主页[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /在线演示[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /Homepage[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /Project[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /页面[：:]\s*(https?:\/\/[^\s\)]+)/gi,
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
            const url = match[1].trim();
            // 排除 arxiv、github、huggingface 等已知链接
            if (!url.includes('arxiv.org') && 
                !url.includes('github.com') && 
                !url.includes('huggingface.co') &&
                !url.includes('modelscope.cn')) {
                urls.push(url);
            }
        }
    }
    
    return [...new Set(urls)]; // 去重
}

/**
 * 访问 demo 页面，检查是否包含开源链接
 */
async function checkDemoPageForOpensource(demoUrl) {
    const openSourcePatterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/[\w\-]+\/[\w\-]+/gi,
        /gitlab\.com\/[\w\-]+\/[\w\-]+/gi,
    ];
    
    try {
        console.log(`    [deep] 🔍 检查 demo 页面: ${demoUrl}`);
        const parsedUrl = await validatePublicHttpUrl(demoUrl);
        const requestHostname = parsedUrl.validatedAddress || parsedUrl.hostname;
        
        // 使用 http/https 请求获取页面内容；不自动跟随重定向，避免被跳到内网地址。
        const response = await new Promise((resolve, reject) => {
            const transport = parsedUrl.protocol === 'http:' ? http : https;
            const options = {
                hostname: requestHostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                servername: parsedUrl.hostname,
                headers: {
                    'Host': parsedUrl.host,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000,
            };
            
            const req = transport.request(options, (res) => {
                const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                if (contentType && !['text/html', 'application/xhtml+xml', 'application/xml', 'text/plain'].includes(contentType)) {
                    res.resume();
                    resolve({ status: res.statusCode, data: '', skipped: `Content-Type=${contentType}` });
                    return;
                }
                const chunks = [];
                let total = 0;
                const maxBytes = 1024 * 1024;
                res.on('data', chunk => {
                    total += chunk.length;
                    if (total > maxBytes) {
                        req.destroy(new Error(`Demo page exceeds ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf8') }));
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
            req.end();
        });
        
        if (response.skipped) {
            console.log(`    [deep] ⚠️  Demo 页面跳过: ${response.skipped}`);
            return [];
        }
        if (response.status !== 200) {
            console.log(`    [deep] ⚠️  Demo 页面返回 ${response.status}`);
            return [];
        }
        
        const html = response.data;
        const foundLinks = [];
        
        for (const pattern of openSourcePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                foundLinks.push(match[0]);
            }
        }
        
        return [...new Set(foundLinks)];
    } catch (err) {
        console.log(`    [deep] ⚠️  访问 demo 页面失败: ${err.message}`);
        return [];
    }
}

function isPrivateIpAddress(address) {
    const ipType = net.isIP(address);
    if (ipType === 4) {
        const parts = address.split('.').map(n => Number.parseInt(n, 10));
        const [a, b] = parts;
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51) ||
            (a === 203 && b === 0) ||
            (a >= 224)
        );
    }
    if (ipType === 6) {
        const lower = address.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIpAddress(mapped[1]);
        const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = Number.parseInt(mappedHex[1], 16);
            const lo = Number.parseInt(mappedHex[2], 16);
            return isPrivateIpAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
        return (
            lower === '::1' ||
            lower === '::' ||
            lower.startsWith('fc') ||
            lower.startsWith('fd') ||
            lower.startsWith('fe80')
        );
    }
    return true;
}

async function validatePublicHttpUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`不支持的 demo URL 协议: ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new Error('demo URL 不允许包含用户名或密码');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('demo URL 指向 localhost');
    }
    if (net.isIP(hostname)) {
        if (isPrivateIpAddress(hostname)) throw new Error(`demo URL 指向非公网 IP: ${hostname}`);
        url.validatedAddress = hostname;
        return url;
    }
    const records = await dns.lookup(hostname, { all: true, verbatim: false });
    if (!records || records.length === 0) {
        throw new Error(`demo URL DNS 解析为空: ${hostname}`);
    }
    for (const record of records) {
        if (isPrivateIpAddress(record.address)) {
            throw new Error(`demo URL DNS 解析到非公网 IP: ${record.address}`);
        }
    }
    url.validatedAddress = records[0].address;
    return url;
}

/**
 * 检查分析中是否已有开源链接
 */
function hasOpenSourceLinks(analysis) {
    const patterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/[\w\-]+\/[\w\-]+/gi,
    ];
    
    for (const pattern of patterns) {
        if (pattern.test(analysis)) return true;
    }
    return false;
}

async function reviseAnalysis(paper, existingAnalysis, textForAnalysis) {
    const prompt = loadPrompt('prompts/gap-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        existingAnalysis: existingAnalysis,
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
}

async function repairMissingAnalysisSections(paper, existingAnalysis, textForAnalysis) {
    let currentAnalysis = existingAnalysis;
    let missingSections = getMissingRequiredSections(currentAnalysis);
    let validationFeedback = '这是第一次结构修复，没有上一次校验错误。';

    for (let attempt = 1; attempt <= 2 && missingSections.length > 0; attempt++) {
        const prompt = loadPrompt('prompts/structure-repair.md', {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            missingSections: missingSections.join('、'),
            validationFeedback,
            existingAnalysis: currentAnalysis,
            textForAnalysis
        });
        const repairedText = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
        const cleaned = cleanGapFillPrefix(repairedText.trim());
        if (cleaned) currentAnalysis = removeUnapprovedMarkdownImages(cleaned, []);

        missingSections = getMissingRequiredSections(currentAnalysis);
        if (missingSections.length === 0) return currentAnalysis;

        validationFeedback = `上一次输出仍缺少：${missingSections.join('、')}。必须输出完整分析并补齐这些标题。`;
        console.log(`    [deep] ⚠️  最终结构修复未通过 (${attempt}/2): 仍缺少 ${missingSections.join('、')}`);
    }

    throw new Error(`最终结构修复失败，仍缺少必要章节: ${missingSections.join('、')}`);
}

/**
 * 从分析文本中提取方法概述和架构部分
 */
function extractMethodSection(analysis) {
    return extractSectionByTitle(analysis, '方法概述和架构', ['核心创新点', '实验结果', '细节详述', '评分理由']);
}

/**
 * 计算文本中的中文字符数量（含中文标点）
 */
function countChineseChars(text) {
    if (!text) return 0;
    const matches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    return matches ? matches.length : 0;
}

/**
 * 检查方法概述部分是否足够详细
 */
function isMethodSectionDetailed(text) {
    if (!text) return false;

    // 1. 中文字符数检查（与 prompt 中的 600 中文字符要求对齐）
    const chineseCount = countChineseChars(text);
    if (chineseCount < 600) {
        console.log(`    [deep] 🔍 方法概述中文字符数不足: ${chineseCount} < 600`);
        return false;
    }

    // 2. 检查是否有"空泛表述"（只列名称不解释）
    const vaguePatterns = [
        /详见原文/,
        /论文描述了详细架构/,
        /详细方法见/,
        /具体实现请参考/,
    ];
    if (vaguePatterns.some(p => p.test(text))) {
        console.log(`    [deep] 🔍 方法概述检测到空泛表述`);
        return false;
    }

    // 3. 检查是否提及关键要素（至少包含一些结构词）
    const structuralKeywords = ['输入', '输出', '流程', '组件', '模块', '阶段', '结构', '网络', '模型'];
    const hasStructure = structuralKeywords.some(kw => text.includes(kw));
    if (!hasStructure) {
        console.log(`    [deep] 🔍 方法概述缺少结构性描述`);
        return false;
    }

    // 4. 检查段落数（至少 3 个段落，说明有分层组织）
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
    if (paragraphs.length < 3) {
        console.log(`    [deep] 🔍 方法概述段落数不足: ${paragraphs.length} < 3`);
        return false;
    }

    return true;
}

/**
 * 检查实验结果部分是否包含 Markdown 表格
 */
function hasMarkdownTable(text) {
    if (!text) return false;
    // 标准 Markdown 表格：至少有一行表头 |...| 和一行分隔符 |---|---|
    return /\n\|[^\n]+\|\n\|[\-\s:|]+\|/.test('\n' + text);
}

/**
 * 检查并修复方法概述部分不够详细的问题。
 * 如果检测到方法概述字数不足、过于空泛或缺少关键要素，触发补充调用。
 */
async function checkAndFixMethodSection(paper, analysis, textForAnalysis) {
    const methodSection = extractMethodSection(analysis);
    if (!methodSection) return analysis;

    if (isMethodSectionDetailed(methodSection)) {
        console.log(`    [deep] ✓ 方法概述部分已足够详细（中文字符: ${countChineseChars(methodSection)}）`);
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到方法概述不够详细，触发补充...`);

    const prompt = loadPrompt('prompts/method-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        methodSection,
        textForAnalysis: textForAnalysis.slice(0, 80000)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的方法概述合并回原分析
    return mergeSectionByTitle(analysis, '方法概述和架构', fixedSection);
}

/**
 * 检查文本中是否包含表格省略标记
 */
function hasOmissionMarkers(text) {
    if (!text) return false;
    const markers = [
        '此处省略',
        '表格数据与论文一致',
        '详见原文',
        '详见论文',
        '表格详见',
        '数据详见',
        '省略',
        '详见表',
        '（见表',
        '(见表',
    ];
    return markers.some(m => text.includes(m));
}

/**
 * 从分析文本中提取实验结果部分
 */
function extractResultsSection(analysis) {
    return extractSectionByTitle(analysis, '实验结果', ['细节详述', '评分理由', '局限与问题', '开源详情']);
}

function sourceTextLikelyHasTables(text) {
    if (!text) return false;
    return /(?:^|\n)\s*(?:Table|表)\s*[\dIVX一二三四五六七八九十]+/i.test(text)
        || /\\begin\{tabular\}|<table[\s>]/i.test(text)
        || /\n\s*\|[^\n]+\|\s*\n\s*\|[\-\s:|]+\|/.test(text);
}

/**
 * 检查并修复实验结果中缺失的表格。
 * 如果检测到省略标记或缺少 Markdown 表格，触发补充调用。
 */
async function checkAndFixTables(paper, analysis, textForAnalysis) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return analysis;

    const hasTable = hasMarkdownTable(resultsSection);
    const hasOmission = hasOmissionMarkers(resultsSection);
    const hasTableReference = /[（(]表\d+[)）]|表[一二三四五六七八九十\d]+/.test(resultsSection);
    const sourceHasTables = sourceTextLikelyHasTables(textForAnalysis);

    // 如果有省略标记，或引用了表格但没有实际 Markdown 表格
    if (!hasOmission && hasTable) {
        return analysis;
    }
    if (!hasOmission && !hasTableReference && !sourceHasTables) {
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到实验结果可能缺少表格，触发补充...`);

    const prompt = loadPrompt('prompts/table-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        resultsSection,
        textForAnalysis: textForAnalysis.slice(0, 80000)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的实验结果合并回原分析
    return mergeSectionByTitle(analysis, '实验结果', fixedSection);
}

/**
 * 根据 demo 页面扫描发现的开源链接，更新 analysis 中的机器摘要和开源详情
 * @param {string} analysis - 分析文本
 * @param {string[]} foundLinks - 发现的开源链接列表
 * @returns {string} 更新后的分析文本
 */
function updateOpensourceFromDemoLinks(analysis, foundLinks) {
    if (!foundLinks || foundLinks.length === 0) return analysis;

    let updated = analysis;

    // 1. 推断开源类型
    let hasCode = false, hasModel = false, hasDataset = false;
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com')) hasCode = true;
        if (lower.includes('huggingface.co')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('gitlab.com')) hasCode = true;
    }

    // 2. 更新机器摘要中的 has_code / has_model / has_dataset
    // 匹配格式：has_code: 否 / has_code: 未说明 等，替换为"是"
    if (hasCode) {
        updated = updated.replace(/(has_code\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasModel) {
        updated = updated.replace(/(has_model\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasDataset) {
        updated = updated.replace(/(has_dataset\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }

    // 3. 在开源详情中追加验证发现的结构化信息
    const linkDescriptions = [];
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com') || lower.includes('gitlab.com')) {
            linkDescriptions.push(`- **代码仓库**：${link}`);
        } else if (lower.includes('huggingface.co') || lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) {
                linkDescriptions.push(`- **数据集**：${link}`);
            } else {
                linkDescriptions.push(`- **模型权重**：${link}`);
            }
        } else {
            linkDescriptions.push(`- **相关链接**：${link}`);
        }
    }

    if (linkDescriptions.length > 0) {
        const newContent = `\n\n**从 demo/项目页面验证发现（已更新开源评分）：**\n${linkDescriptions.join('\n')}`;
        updated = mergeSection(updated, '## 开源详情', newContent);
    }

    return updated;
}

function mergeSection(analysis, sectionHeader, newContent) {
    // 去掉 newContent 开头重复的 sectionHeader，避免合并后出现双标题
    const headerPattern = new RegExp('^' + sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[：:\\s]*\\n*');
    const cleanContent = newContent.replace(headerPattern, '').trim();

    const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[：:\\s]*\n)([\\s\\S]*?)(?=\n#{2,3}\\s|$)`, '');
    if (regex.test(analysis)) {
        return analysis.replace(regex, `$1${cleanContent}\n`);
    }
    return analysis.trim() + '\n\n' + sectionHeader + '\n' + cleanContent;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionByTitle(analysis, title, followingTitles = []) {
    if (!analysis) return '';
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return '';

    const contentStart = match.index + match[1].length + match[2].length;
    const rest = analysis.slice(contentStart);
    let end = rest.length;
    const titleAlternation = followingTitles.map(escapeRegExp).join('|');
    const nextSpecific = titleAlternation
        ? new RegExp(`\\n#{2,3}\\s*(?:\\d+[.\\s]+)?(?:${titleAlternation})[：:\\s]*\\n`)
        : null;
    const nextAny = /\n#{2,3}\s/g;
    const specificMatch = nextSpecific ? nextSpecific.exec(rest) : null;
    const anyMatch = nextAny.exec(rest);
    if (specificMatch) {
        end = specificMatch.index;
    } else if (anyMatch) {
        end = anyMatch.index;
    }
    return rest.slice(0, end).trim();
}

function normalizeSectionContent(title, newContent) {
    const heading = new RegExp(
        `^#{1,6}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n*`,
        'i'
    );
    return (newContent || '').replace(heading, '').trim();
}

function mergeSectionByTitle(analysis, title, newContent) {
    const cleanContent = normalizeSectionContent(title, newContent);
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`
    );
    if (heading.test(analysis)) {
        return analysis.replace(heading, (match, prefix, header) => `${prefix}${header}${cleanContent}\n`);
    }
    return `${analysis.trim()}\n\n## ${title}\n${cleanContent}`;
}

module.exports = {
    analyzePaperDeep,
    parseAnalysis,
    callModel,
    fetchArxivText,
    fetchArxivImageUrls,
    removeUnapprovedMarkdownImages,
    selectImageCandidates,
    scoreImageCandidate,
    normalizeImageInfos,
    sourceTextLikelyHasTables,
    getPaperArxivId,
    getPreProvidedImageUrls,
    getArxivHtmlIds,
    isSupportedImageUrl,
    safeImageLabel,
    cleanGapFillPrefix,
    checkDemoPageForOpensource,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    extractSectionByTitle,
    mergeSectionByTitle,
    parseImageInsertionPlan,
    applyImageInsertionPlan,
    normalizeGenericImageOrder,
    parseScoringAuditResult,
    applyScoringAuditResult,
    validateScoringAuditAgainstAnalysis,
    auditTypeAwareScoring,
    repairMissingAnalysisSections
};

// 直接运行测试
if (require.main === module) {
    const testPaper = {
        arxivId: process.argv[2] || '2604.00688',
        title: process.argv[3] || 'Test Paper',
        authors: ['Test Author'],
        categories: ['cs.SD'],
        abstract: 'This is a test abstract.'
    };

    analyzePaperDeep(testPaper).then(result => {
        console.log('\n=== 分析结果 ===');
        console.log(result.analysis);
        console.log('\n=== 解析结果 ===');
        console.log(JSON.stringify(parseAnalysis(result.analysis), null, 2));
    }).catch(console.error);
}
