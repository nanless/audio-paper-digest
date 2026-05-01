#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const { loadEnvFile, parseAnalysis, detectApiType, buildApiUrl, buildRequestBody, buildHeaders, parseResponseText, loadPrompt } = require('./utils.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const https = require('https');
const { ANALYSIS_CONFIG } = require('./config.js');

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

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: headers,
            agent: false,
            signal: controller.signal
        };

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
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const suffix of ['v1', 'v2', '']) {
            const url = `https://arxiv.org/html/${arxivId}${suffix}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)
                });
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
            const delay = attempt * 2000;
            console.log(`    [deep] fetchArxivText ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} failed after ${maxRetries} retries`);
    return '';
}

/**
 * 从 arxiv HTML 获取图片 URL 列表
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivImageUrls(arxivId) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const suffix of ['v1', 'v2', '']) {
            const url = `https://arxiv.org/html/${arxivId}${suffix}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
                    signal: AbortSignal.timeout(30000)
                });
                if (!response.ok) continue;

                const html = await response.text();
                const imgRegex = /src="([^"]*\.(png|jpg|jpeg)[^"]*)"/g;
                const images = [];
                let match;

                while ((match = imgRegex.exec(html)) !== null) {
                    const src = match[1];
                    if (src.includes('arxiv-logo') || src.includes('favicon') || src.includes('logo')) continue;
                    const fullUrl = src.startsWith('http') ? src : `https://arxiv.org/html/${src}`;
                    images.push(fullUrl);
                }
                return images;
            } catch (e) {
                console.log(`    [deep] fetchArxivImageUrls ${arxivId}${suffix} error: ${e.message}`);
                continue;
            }
        }
        if (attempt < maxRetries) {
            const delay = attempt * 2000;
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
async function downloadImageBase64(imageUrl) {
    try {
        const response = await fetch(imageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
            signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS)
        });
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer).toString('base64');
    } catch (e) {
        return null;
    }
}

/**
 * 并行下载图片（限制并发数）
 * @param {string[]} imageUrls - 图片 URL 列表
 * @param {number} maxCount - 最大下载数量
 * @param {number} maxBase64Chars - 单张 base64 字符数上限
 * @param {number} concurrency - 并发数，默认 3
 * @returns {Promise<Array<{url: string, base64: string}>>}
 */
async function downloadImagesParallel(imageUrls, maxCount, maxBase64Chars, concurrency = 3) {
    const results = [];

    for (let i = 0; i < imageUrls.length && results.length < maxCount; i += concurrency) {
        const batch = imageUrls.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (url) => {
                try {
                    const b64 = await downloadImageBase64(url);
                    if (b64 && b64.length < maxBase64Chars) {
                        console.log(`    [deep] 下载图片 ${url.split('/').pop()}: ${(b64.length / 1024).toFixed(1)}KB`);
                        return { url, base64: b64 };
                    }
                } catch (e) {
                    // 跳过无法下载的图片
                }
                return null;
            })
        );

        for (const r of batchResults) {
            if (r && results.length < maxCount) {
                results.push(r);
            }
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

    let imageUrls = [];
    try {
        imageUrls = await fetchArxivImageUrls(arxivId);
        console.log(`    [deep] 找到 ${imageUrls.length} 张图片`);
    } catch (e) {
        console.log(`    [deep] 获取图片失败: ${e.message}`);
    }

    const hasFullTextIntro = hasFullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。';

    // 并行下载全部图片（限制并发数以避免过载）
    const downloadedImages = await downloadImagesParallel(imageUrls, imageUrls.length, IMAGE_MAX_BASE64_CHARS, 3);
    console.log(`    [deep] 成功下载 ${downloadedImages.length}/${imageUrls.length} 张图片`);

    // 构建图片URL映射信息，让LLM知道每张图的正确URL
    const imageUrlMapping = imageUrls.map((url, idx) => `图${idx + 1}: ${url}`).join('\n');
    const imagePrefix = imageUrls.length > 0
        ? `\n\n论文中的图片及其URL如下（请在下文引用图片时使用这些URL）：\n${imageUrlMapping}\n`
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
    let imagesToSave = imageUrls;

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

    // 第3轮：查缺补漏
    try {
        const gapText = await gapFill(paper, analysis, textForAnalysis);
        if (gapText && !gapText.includes('无需补充')) {
            analysis = analysis.trim() + '\n\n' + gapText.trim();
            console.log(`    [deep] ✅ 查缺补漏完成`);
        }
    } catch (e) {
        console.log(`    [deep] ⚠️  查缺补漏失败: ${e.message}`);
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

async function gapFill(paper, existingAnalysis, textForAnalysis) {
    const prompt = loadPrompt('prompts/gap-fill.md', {
        title: paper.title,
        arxivId: paper.arxivId,
        existingAnalysis: existingAnalysis,
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], 8000);
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
