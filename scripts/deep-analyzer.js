#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const { loadEnvFile, parseAnalysis, detectApiType, buildApiUrl, buildRequestBody, buildHeaders, parseResponseText, requestJson, loadPrompt } = require('./utils.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const http = require('http');
const https = require('https');
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
    imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
    imageMaxCount: IMAGE_MAX_COUNT,
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
    // 找到第一个 ## 评分 的位置
    const scoreIdx = text.indexOf('## 评分');
    if (scoreIdx >= 0) {
        return text.substring(scoreIdx).trim();
    }
    // 如果没有 ## 评分，返回 null（格式不正确，调用方应回退到原始分析）
    return null;
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

/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivText(arxivId) {
    const maxRetries = 6;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const suffix of ['v1', 'v2', '']) {
            const url = `https://arxiv.org/html/${arxivId}${suffix}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)
                });

                if (response.status === 429) {
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
            } catch (e) {
                console.log(`    [deep] fetchArxivText ${arxivId}${suffix} error: ${e.message}`);
                continue;
            }
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
    for (const pdfSuffix of ['', 'v1', 'v2']) {
        const pdfUrl = `https://arxiv.org/pdf/${arxivId}${pdfSuffix}.pdf`;
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
        for (const suffix of ['v1', 'v2', '']) {
            const url = `https://arxiv.org/html/${arxivId}${suffix}`;
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
                        } else if (src.startsWith(`${arxivId}`)) {
                            // 新版 HTML：src 已包含 arxivId 前缀
                            fullUrl = `https://arxiv.org/html/${src}`;
                        } else {
                            // 旧版 HTML：src 为纯文件名
                            fullUrl = `https://arxiv.org/html/${arxivId}${suffix}/${src}`;
                        }
                    }

                    // 如果 figure 中没有 <img>，尝试提取内联 <svg>
                    if (!fullUrl) {
                        const $svg = $fig.find('svg').first();
                        if ($svg.length) {
                            const svgHtml = $svg.prop('outerHTML');
                            if (svgHtml) {
                                // 压缩 SVG（去掉多余空白）后转为 base64 data URI
                                const compressed = svgHtml.replace(/>\s+</g, '><').trim();
                                const b64 = Buffer.from(compressed).toString('base64');
                                fullUrl = `data:image/svg+xml;base64,${b64}`;
                            }
                        }
                    }

                    if (!fullUrl) return;

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
                        } else if (src.startsWith(`${arxivId}`)) {
                            fullUrl = `https://arxiv.org/html/${src}`;
                        } else {
                            fullUrl = `https://arxiv.org/html/${arxivId}${suffix}/${src}`;
                        }
                        images.push({ url: fullUrl, caption: '' });
                    }
                }

                return images;
            } catch (e) {
                console.log(`    [deep] fetchArxivImageUrls ${arxivId}${suffix} error: ${e.message}`);
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
 * 下载图片并转为 base64（支持 http URL 和 data URI）
 */
async function downloadImageBase64(imageUrl, maxRetries = 5) {
    // 处理 data URI（如 SVG base64）
    if (imageUrl.startsWith('data:')) {
        const match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (match) {
            return match[1];
        }
        console.log(`    [deep] data URI 格式不支持: ${imageUrl.substring(0, 50)}...`);
        return null;
    }

    const fileName = imageUrl.split('/').pop();
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
            const buffer = await response.arrayBuffer();
            const b64 = Buffer.from(buffer).toString('base64');
            return b64;
        } catch (e) {
            lastError = e.message;
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
 * @returns {Promise<Array<{url: string, base64: string}>>}
 */
async function downloadImagesSerial(imageUrls, maxCount, maxBase64Chars) {
    const results = [];
    // 去重避免同一 URL 下载多次
    const uniqueUrls = [...new Set(imageUrls)];

    for (const url of uniqueUrls) {
        if (results.length >= maxCount) break;
        try {
            const b64 = await downloadImageBase64(url);
            if (b64 && b64.length < maxBase64Chars) {
                console.log(`    [deep] 下载图片 ${url.split('/').pop()}: ${(b64.length / 1024).toFixed(1)}KB`);
                results.push({ url, base64: b64 });
            } else if (b64) {
                console.log(`    [deep] 跳过图片 ${url.split('/').pop()}: base64 ${(b64.length / 1024).toFixed(1)}KB 超过限制`);
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

/**
 * 构造图片消息块
 */
function buildImageContent(imageUrl, base64) {
    if (base64) {
        const lower = imageUrl.toLowerCase().split('?')[0];
        let mime = 'image/png';
        if (imageUrl.startsWith('data:image/svg+xml')) {
            mime = 'image/svg+xml';
        } else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
            mime = 'image/jpeg';
        } else if (lower.endsWith('.svg')) {
            mime = 'image/svg+xml';
        } else if (lower.endsWith('.webp')) {
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

/**
 * 替换分析文本中的 [图N] 标记为 Markdown 图片引用
 * @param {string} text - 分析文本
 * @param {Array} imageInfos - [{ url, caption }] 图片信息列表
 * @returns {string} 替换后的文本
 */
function replaceImageMarkers(text, imageInfos) {
    if (!text || !imageInfos || imageInfos.length === 0) return text;
    let result = text;
    const inserted = new Set();

    // 1. 标准 [图N] 标记（独占一行）
    result = result.replace(/\[图(\d+)\]/g, (match, num) => {
        if (inserted.has(num)) return match;
        const idx = parseInt(num, 10) - 1;
        if (idx >= 0 && idx < imageInfos.length) {
            inserted.add(num);
            const info = imageInfos[idx];
            const alt = info.caption || `图${num}`;
            return `\n\n![${alt}](${info.url})\n\n`;
        }
        return match;
    });

    // 2. 自然语言"（图N）"或"(图N)" — 在首次出现前插入图片
    result = result.replace(/(?:（|\()\s*(图(\d+))\s*(?:）|\))/g, (match, label, num) => {
        if (inserted.has(num)) return match;
        const idx = parseInt(num, 10) - 1;
        if (idx >= 0 && idx < imageInfos.length) {
            inserted.add(num);
            const info = imageInfos[idx];
            const alt = info.caption || label;
            return `\n\n![${alt}](${info.url})\n\n${match}`;
        }
        return match;
    });

    return result;
}

function extractMarkdownImageUrls(text) {
    if (!text) return [];
    const urls = [];
    const re = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        urls.push(m[1]);
    }
    return [...new Set(urls)];
}

function removeUnapprovedMarkdownImages(text, allowedUrls) {
    if (!text) return text;
    const allowed = new Set(allowedUrls || []);
    return text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, url) => {
        return allowed.has(url) ? match : '';
    });
}

function hasRequiredAnalysisSections(text) {
    const required = [
        '评分', '机器摘要', '标签', '作者与机构', '毒舌点评', '核心摘要',
        '方法概述和架构', '核心创新点', '实验结果', '细节详述',
        '评分理由', '局限与问题', '开源详情'
    ];
    return required.every(title => new RegExp(`(^|\\n)#{2,3}\\s*${escapeRegExp(title)}[：:\\s]*\\n`, 'm').test(text));
}

async function applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages) {
    if (!isDualModel || downloadedImages.length === 0) {
        return { analysis, selectedImageUrls: [] };
    }

    const imageInfoByUrl = new Map(imageInfos.map(info => [info.url, info]));
    const usableImageInfos = downloadedImages.map(img => imageInfoByUrl.get(img.url) || { url: img.url, caption: '' });

    console.log(`    [deep] 🖼️  副模型(${SECONDARY_CONFIG.model})筛选并插入高价值图片`);

    const imageListStr = usableImageInfos.map((info, i) =>
        `图${i + 1}: ${info.url}\n  caption: ${info.caption || '无描述'}`
    ).join('\n\n');
    const supplementPrompt = loadPrompt('prompts/image-supplement.md', {
        title: paper.title,
        arxivId,
        imageList: imageListStr,
        primaryAnalysis: analysis
    });

    const supplementContent = [{ type: 'text', text: supplementPrompt }];
    for (const img of downloadedImages) {
        supplementContent.push(buildImageContent(img.url, img.base64));
    }

    const enhancedAnalysis = await callModelWithConfig(
        [{ role: 'user', content: supplementContent }],
        API_MAX_TOKENS, 3, SECONDARY_CONFIG
    );

    const cleaned = cleanGapFillPrefix(enhancedAnalysis.trim());
    if (!cleaned || cleaned.length <= 100) {
        console.log(`    [deep] ⚠️  副模型输出格式不正确，保留纯文本分析结果`);
        return { analysis, selectedImageUrls: [] };
    }
    if (!hasRequiredAnalysisSections(cleaned)) {
        console.log(`    [deep] ⚠️  副模型输出缺少必要章节，保留纯文本分析结果`);
        return { analysis, selectedImageUrls: [] };
    }

    const replaced = removeUnapprovedMarkdownImages(
        replaceImageMarkers(cleaned, usableImageInfos),
        usableImageInfos.map(info => info.url)
    );
    const selectedImageUrls = extractMarkdownImageUrls(replaced)
        .filter(url => usableImageInfos.some(info => info.url === url));
    console.log(`    [deep] ✅ 副模型图片筛选完成：插入 ${selectedImageUrls.length}/${usableImageInfos.length} 张`);

    return { analysis: replaced, selectedImageUrls };
}

/**
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper) {
    const arxivId = paper.arxivId || paper.id;
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
    const preProvidedUrls = paper.allImageUrls || paper.imageUrls || [];
    if (preProvidedUrls.length > 0) {
        imageInfos = preProvidedUrls.map(url => ({ url }));
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
    if (imageInfos.length > candidateImageInfos.length) {
        console.log(`    [deep] 图片候选预筛: ${imageInfos.length} → ${candidateImageInfos.length} 张`);
    }

    const hasFullTextIntro = hasFullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。';

    const downloadedImages = await downloadImagesSerial(candidateImageUrls, IMAGE_MAX_COUNT, IMAGE_MAX_BASE64_CHARS);
    console.log(`    [deep] 成功下载 ${downloadedImages.length}/${candidateImageUrls.length} 张候选图片（总图片 ${imageUrls.length} 张）`);

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

    // 最后一轮：副模型基于最终文本筛选高价值图片并改写对应段落。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
    if (isDualModel && downloadedImages.length > 0) {
        try {
            const imageResult = await applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages);
            analysis = imageResult.analysis;
            selectedImageUrls = imageResult.selectedImageUrls;
        } catch (err) {
            console.log(`    [deep] ⚠️  副模型图片筛选失败: ${err.message}，保留纯文本分析结果`);
        }
    }

    return {
        ...paper,
        analysis: analysis,
        imageUrls: selectedImageUrls,
        selectedImageUrls,
        allImageUrls: imageUrls
    };
}

async function scanOpensource(paper, textForAnalysis) {
    const prompt = loadPrompt('prompts/opensource-scan.md', {
        title: paper.title,
        arxivId: paper.arxivId,
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
        
        // 使用 https 请求获取页面内容
            const response = await new Promise((resolve, reject) => {
                const url = new URL(demoUrl);
                const transport = url.protocol === 'http:' ? http : https;
                const options = {
                    hostname: url.hostname,
                    port: url.port || (url.protocol === 'http:' ? 80 : 443),
                    path: url.pathname + url.search,
                    method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000,
            };
            
                const req = transport.request(options, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf8') }));
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
            req.end();
        });
        
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
        arxivId: paper.arxivId,
        existingAnalysis: existingAnalysis,
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
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

    // 1. 中文字符数检查（最低阈值 300，理想 600+）
    const chineseCount = countChineseChars(text);
    if (chineseCount < 300) {
        console.log(`    [deep] 🔍 方法概述中文字符数不足: ${chineseCount} < 300`);
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

    const prompt = `你是一位严谨的学术论文分析专家。请根据下面的论文原文，为"方法概述和架构"部分补充更详细、更充分的内容。

论文标题: ${paper.title}
arXiv ID: ${paper.arxivId}

## 要求
1. 只输出"## 方法概述和架构"这一个 section 的完整内容。
2. 必须详细覆盖以下要素（缺一不可）：
   - 整体流程概述（输入→处理→输出的完整链路）
   - 每个核心组件的名称、功能、内部结构/实现、输入输出
   - 组件间的数据流与交互方式
   - 关键设计选择及其动机
   - 若有多阶段/多模块，逐层展开，不能一笔带过
   - 若原文有架构图，描述图中各模块的关系（但不要编造图片URL）
   - 对专业术语做必要解释
3. 字数要求：中文字符不少于 600 个。内容必须充实，不能空泛。
4. 严禁使用"详见原文"、"论文描述了详细架构"等空泛表述替代具体描述。
5. 严禁只罗列组件名称而不解释功能和内部结构。

## 已有分析（供参考，但可能不够详细）

${methodSection}

## 论文原文（权威依据）

${textForAnalysis.slice(0, 80000)}

请直接输出"## 方法概述和架构"及之后的完整内容：`;

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

    // 如果有省略标记，或引用了表格但没有实际 Markdown 表格
    if (!hasOmission && (!hasTableReference || hasTable)) {
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到实验结果可能缺少表格，触发补充...`);

    const prompt = `你是一位严谨的学术论文分析专家。请根据下面的论文原文，为"实验结果"部分补充完整的 Markdown 表格数据。

论文标题: ${paper.title}
arXiv ID: ${paper.arxivId}

## 要求
1. 只输出"## 实验结果"这一个 section 的完整内容。
2. 必须包含论文中所有实验结果表格的标准 Markdown 格式（表头、模型名称、数据集、指标、数值），不要省略任何行或列。
3. 严禁使用"此处省略"、"详见原文"等字样。所有数据必须直接列出。
4. 严禁编造或插入任何 Markdown 图片、HTML 图片或图片 URL；本轮只补表格和文字。
5. 在表格下方用文字说明关键结论。

## 已有分析（供参考，但可能缺少表格）

${resultsSection}

## 论文原文（权威依据）

${textForAnalysis.slice(0, 80000)}

请直接输出"## 实验结果"及之后的完整内容：
`;

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
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`,
        'm'
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
    replaceImageMarkers,
    extractMarkdownImageUrls,
    removeUnapprovedMarkdownImages,
    selectImageCandidates,
    hasRequiredAnalysisSections,
    extractSectionByTitle,
    mergeSectionByTitle
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
