#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const { loadEnvFile, parseAnalysis, detectApiType, buildApiUrl, buildRequestBody, buildHeaders, parseResponseText, loadPrompt, detectProxyUrl } = require('./utils.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const https = require('https');
const { PDFParse } = require('pdf-parse');
const { ANALYSIS_CONFIG, ARXIV_CONFIG } = require('./config.js');

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
    fullTextMaxChars: FULL_TEXT_MAX_CHARS,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;

/**
 * 清理 gap-fill（审校重写）输出中的前缀废话
 * 确保输出直接从 ## 评分 开始
 */
function cleanGapFillPrefix(text) {
    if (!text) return text;
    // 找到第一个 ## 评分 的位置
    const scoreIdx = text.indexOf('## 评分');
    if (scoreIdx > 0) {
        return text.substring(scoreIdx).trim();
    }
    // 如果没有 ## 评分，尝试其他一级标题
    const h2Idx = text.search(/\n## /);
    if (h2Idx > 0) {
        return text.substring(h2Idx + 1).trim();
    }
    return text.trim();
}

// API 配置 - 深度分析阶段（统一使用 PAPER_ANALYZER_*）
const DEEP_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};

const missingDeepEnv = [];
if (!DEEP_CONFIG.endpoint) missingDeepEnv.push('PAPER_ANALYZER_ENDPOINT');
if (!DEEP_CONFIG.key) missingDeepEnv.push('PAPER_ANALYZER_API_KEY');
if (!DEEP_CONFIG.model) missingDeepEnv.push('PAPER_ANALYZER_MODEL');
if (missingDeepEnv.length > 0) {
    console.error(`[deep-analyzer] 缺少环境变量: ${missingDeepEnv.join(', ')}。请在 ~/.hermes/.env 中配置`);
    process.exit(1);
}

/**
 * 调用大模型（支持多模态消息）— 带重试机制
 */
async function callModelWithConfig(messages, maxTokens, maxRetries = 3) {
    const config = DEEP_CONFIG;
    const startTime = Date.now();
    const apiType = detectApiType(config.endpoint, config.model);
    const modelUrl = buildApiUrl(apiType, config.endpoint);
    const url = new URL(modelUrl);
    console.log(`    [api] → ${config.model} | ${apiType} | ${url.hostname}${url.pathname} | max_tokens=${maxTokens} | max_retries=${maxRetries}`);

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await _callModelOnce(messages, maxTokens, config, startTime, apiType);
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
    const url = new URL(buildApiUrl(apiType, config.endpoint));

    return new Promise((resolve, reject) => {
        const bodyObj = buildRequestBody(apiType, config.model, messages, maxTokens, API_TEMPERATURE);
        const postData = JSON.stringify(bodyObj);

        const headers = {
            ...buildHeaders(apiType, config.key, postData),
            ...config.headers
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`    [api] ✗ ${config.model} | abort timeout | ${duration}s`);
            controller.abort();
        }, 1200000);

        const proxyUrl = detectProxyUrl();
        const isMimo = config.endpoint.includes('xiaomimimo.com') || config.model.includes('mimo');
        const shouldBypassProxy = isMimo && proxyUrl;

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: headers,
            signal: controller.signal
        };
        if (shouldBypassProxy) {
            options.agent = false;
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                clearTimeout(timeoutId);
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);
                    if (content !== null) {
                        console.log(`    [api] ✓ ${config.model} | HTTP ${res.statusCode} | ${content.length} chars | ${duration}s`);
                        resolve(content);
                    } else if (response.error) {
                        console.log(`    [api] ✗ ${config.model} | HTTP ${res.statusCode} | ${duration}s | error: ${response.error.message || JSON.stringify(response.error).substring(0, 100)}`);
                        reject(new Error(response.error.message || JSON.stringify(response.error)));
                    } else {
                        console.log(`    [api] ✗ ${config.model} | HTTP ${res.statusCode} | ${duration}s | invalid response`);
                        reject(new Error('Invalid response: ' + data.substring(0, 200)));
                    }
                } catch (e) {
                    console.log(`    [api] ✗ ${config.model} | HTTP ${res.statusCode} | ${duration}s | parse error: ${e.message}`);
                    console.log(`    [api] ✗ ${config.model} | response body (first 500 chars): ${data.substring(0, 500)}`);
                    reject(new Error('Parse error: ' + e.message));
                }
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`    [api] ✗ ${config.model} | network error | ${duration}s | ${err.message}`);
            reject(err);
        });
        req.on('timeout', () => {
            clearTimeout(timeoutId);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`    [api] ✗ ${config.model} | timeout | ${duration}s`);
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(postData);
        req.end();
    });
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
async function downloadImagesParallel(imageUrls, maxCount, maxBase64Chars) {
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

/**
 * 构造图片消息块
 */
function buildImageContent(imageUrl, base64) {
    if (base64) {
        const mime = imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg')
            ? 'image/jpeg' : 'image/png';
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
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper) {
    const arxivId = paper.arxivId;
    console.log(`    [deep] 获取全文: ${arxivId}`);

    let fullText = '';
    try {
        fullText = await fetchArxivText(arxivId);
        console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
    } catch (e) {
        console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
    }

    const textForAnalysis = fullText || (paper.abstract || paper.summary || '');
    const hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;

    let imageInfos = [];
    try {
        imageInfos = await fetchArxivImageUrls(arxivId);
        console.log(`    [deep] 找到 ${imageInfos.length} 张图片`);
    } catch (e) {
        console.log(`    [deep] 获取图片失败: ${e.message}`);
    }

    // 提取纯 URL 列表用于下载和保存
    const imageUrls = imageInfos.map(info => info.url);

    const hasFullTextIntro = hasFullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。';

    // 并行下载全部图片（限制并发数以避免过载）
    const downloadedImages = await downloadImagesParallel(imageUrls, imageUrls.length, IMAGE_MAX_BASE64_CHARS);
    console.log(`    [deep] 成功下载 ${downloadedImages.length}/${imageUrls.length} 张图片`);

    // 构建图片URL映射信息（含 caption），让LLM知道每张图的正确URL和内容
    const imageUrlMapping = imageInfos.map((info, idx) => {
        const lines = [`图${idx + 1}: ${info.url}`];
        if (info.caption) {
            lines.push(`  caption: ${info.caption}`);
        }
        return lines.join('\n');
    }).join('\n');
    const imagePrefix = imageInfos.length > 0
        ? `\n\n论文中的图片及其URL如下（请在下文引用图片时使用这些URL，caption 可帮助判断图片内容）：\n${imageUrlMapping}\n`
        : '';

    const prompt = loadPrompt('prompts/deep-analysis.md', {
        hasFullText: hasFullTextIntro,
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        arxivId: arxivId,
        textForAnalysis: textForAnalysis + imagePrefix
    });

    const content = [{ type: 'text', text: prompt }];

    for (const img of downloadedImages) {
        content.push(buildImageContent(img.url, img.base64));
    }

    if (downloadedImages.length === 0) {
        console.log(`    [deep] 无可用图片，仅文本分析`);
    } else {
        console.log(`    [deep] 共分析 ${downloadedImages.length} 张图片`);
    }

    let analysis = '';
    // imageUrls 只保存成功下载的图片，allImageUrls 保存所有找到的图片
    const imagesToSave = downloadedImages.map(img => img.url);

    try {
        analysis = await callModel([{ role: 'user', content: content }], API_MAX_TOKENS);
        console.log(`    [deep] ✅ 主分析完成`);
    } catch (err) {
        // 如果带图片超时/失败，尝试不带图片重试
        const isTimeoutOrNetwork = err.message.includes('timeout') || err.message.includes('socket hang up') || err.message.includes('504') || err.message.includes('abort');
        if (downloadedImages.length > 0 && isTimeoutOrNetwork) {
            console.log(`    [deep] ⚠️  带图片请求超时，尝试不带图片重试...`);
            try {
                const textOnlyContent = [{ type: 'text', text: prompt }];
                analysis = await callModel([{ role: 'user', content: textOnlyContent }], API_MAX_TOKENS);
                console.log(`    [deep] ✅ 不带图片重试成功`);
            } catch (retryErr) {
                console.error(`    [deep] 不带图片重试也失败: ${retryErr.message}`);
                return {
                    ...paper,
                    analysis: null,
                    error: retryErr.message
                };
            }
        } else {
            console.error(`    [deep] 分析失败: ${err.message}`);
            return {
                ...paper,
                analysis: null,
                error: err.message
            };
        }
    }

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

    // 第3轮：审校重写（对照原文修正、补充、删减，完全重写前两轮输出）
    try {
        const revisedText = await reviseAnalysis(paper, analysis, textForAnalysis);
        if (revisedText && revisedText.length > 100) {
            analysis = cleanGapFillPrefix(revisedText.trim());
            console.log(`    [deep] ✅ 审校重写完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  审校重写失败: ${e.message}`);
    }

    // 第3.5轮：检查并修复实验结果中缺失的表格
    try {
        const fixed = await checkAndFixTables(paper, analysis, textForAnalysis);
        if (fixed && fixed !== analysis) {
            analysis = fixed.trim();
            console.log(`    [deep] ✅ 表格补充完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  表格补充失败: ${e.message}`);
    }

    // 第3.6轮：检查并修复方法概述部分不够详细的问题
    try {
        const fixed = await checkAndFixMethodSection(paper, analysis, textForAnalysis);
        if (fixed && fixed !== analysis) {
            analysis = fixed.trim();
            console.log(`    [deep] ✅ 方法概述补充完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  方法概述补充失败: ${e.message}`);
    }

    return {
        ...paper,
        analysis: analysis,
        imageUrls: imagesToSave,
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
    const m = analysis.match(/###\s*01[.\s]+方法概述和架构[：:\s]*\n([\s\S]*?)(?=###\s*02[.\s]|\n##\s*|$)/);
    return m ? m[1].trim() : '';
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
1. 只输出"### 01.方法概述和架构"这一个 section 的完整内容。
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

请直接输出"### 01.方法概述和架构"及之后的完整内容：`;

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的方法概述合并回原分析
    return mergeSection(analysis, '### 01.方法概述和架构', fixedSection);
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
    const m = analysis.match(/###\s*03[.\s]+实验结果[：:\s]*\n([\s\S]*?)(?=###\s*04[.\s]|\n##\s*|$)/);
    return m ? m[1].trim() : '';
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
1. 只输出"### 03.实验结果"这一个 section 的完整内容。
2. 必须包含论文中所有实验结果表格的标准 Markdown 格式（表头、模型名称、数据集、指标、数值），不要省略任何行或列。
3. 严禁使用"此处省略"、"详见原文"等字样。所有数据必须直接列出。
4. 如果有图片，用 Markdown 图片语法 \`![描述](URL)\` 插入。
5. 在表格下方用文字说明关键结论。

## 已有分析（供参考，但可能缺少表格）

${resultsSection}

## 论文原文（权威依据）

${textForAnalysis.slice(0, 80000)}

请直接输出"### 03.实验结果"及之后的完整内容：
`;

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的实验结果合并回原分析
    return mergeSection(analysis, '### 03.实验结果', fixedSection);
}

function mergeSection(analysis, sectionHeader, newContent) {
    // 去掉 newContent 开头重复的 sectionHeader，避免合并后出现双标题
    const headerPattern = new RegExp('^' + sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[：:\s]*\n*');
    const cleanContent = newContent.replace(headerPattern, '').trim();

    const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[：:\s]*\n)([\\s\\S]*?)(?=\n## |$)`, '');
    if (regex.test(analysis)) {
        return analysis.replace(regex, `$1${cleanContent}\n`);
    }
    return analysis.trim() + '\n\n' + sectionHeader + '\n' + cleanContent;
}

module.exports = { analyzePaperDeep, parseAnalysis, callModel, fetchArxivText, fetchArxivImageUrls };

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
