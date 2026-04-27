#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const { loadEnvFile, parseAnalysis, detectApiType, buildApiUrl, buildRequestBody, buildHeaders, parseResponseText, loadPrompt, writeFileAtomic, getBeijingISOString } = require('./utils.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ANALYSIS_CONFIG } = require('./config.js');
const Config = require('./config.js');

const DEEP_ANALYZER_IO_DIR = path.join(Config.CURRENT_DIR, 'deep_analyzer_input_output');
if (!fs.existsSync(DEEP_ANALYZER_IO_DIR)) {
    fs.mkdirSync(DEEP_ANALYZER_IO_DIR, { recursive: true });
}

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
 */
async function fetchArxivText(arxivId) {
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
            continue;
        }
    }
    return '';
}

/**
 * 从 arxiv HTML 获取图片 URL 列表
 */
async function fetchArxivImageUrls(arxivId) {
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
            continue;
        }
    }
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

// ═══════════════════════════════════════════════════════
// 本地 PDF 提取（ICASSP 论文）
// ═══════════════════════════════════════════════════════

/**
 * 调用 Python 脚本从本地 PDF 提取文本和图片
 * @param {string} pdfPath - PDF 文件绝对路径
 * @returns {Promise<{text: string, textLength: number, pageCount: number, images: Array, imageCount: number}>}
 */
async function extractPdfContent(pdfPath) {
    const scriptPath = path.join(__dirname, 'pdf-extractor.py');

    return new Promise((resolve, reject) => {
        const args = [
            scriptPath,
            pdfPath,
            '--max-text-chars', String(FULL_TEXT_MAX_CHARS),
            '--max-images', String(IMAGE_MAX_COUNT),
            '--max-base64-chars', String(IMAGE_MAX_BASE64_CHARS)
        ];

        const proc = spawn('python3', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`PDF 提取脚本退出码 ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                if (!result.success) {
                    reject(new Error(result.error || 'PDF 提取失败'));
                    return;
                }
                resolve(result);
            } catch (e) {
                reject(new Error(`解析 PDF 提取结果失败: ${e.message}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`启动 PDF 提取脚本失败: ${err.message}`));
        });
    });
}

/**
 * 深度分析单篇论文（全文 + 图片）
 * 支持两种模式：
 * 1. arXiv 模式：paper.arxivId 存在，从 arxiv.org 获取全文和图片
 * 2. 本地 PDF 模式：paper.pdfPath 存在，从本地 PDF 提取文本和图片
 */
async function analyzePaperDeep(paper) {
    const isLocalPdf = !!paper.pdfPath;
    const paperId = paper.arxivId || paper.arnumber || paper.id || paper.paper_id || 'unknown';
    const safePaperId = String(paperId).replace(/[^a-zA-Z0-9_-]/g, '_');

    let fullText = '';
    let imageDataList = [];  // {url or index, base64}
    let imageUrls = [];      // 用于保存到结果中
    let hasFullText = false;

    if (isLocalPdf) {
        console.log(`    [deep] 从本地 PDF 提取: ${paperId} | ${path.basename(paper.pdfPath)}`);
        try {
            const pdfResult = await extractPdfContent(paper.pdfPath);
            fullText = pdfResult.text || '';
            hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;
            console.log(`    [deep] PDF 提取完成: ${pdfResult.pageCount} 页, 文本 ${pdfResult.textLength} 字符, 图片 ${pdfResult.imageCount} 张`);

            // 将提取的图片转为消息格式
            for (const img of pdfResult.images) {
                const mime = img.format === 'jpeg' || img.format === 'jpg' ? 'image/jpeg' : 'image/png';
                imageDataList.push({
                    url: `data:${mime};base64,${img.base64}`,
                    base64: img.base64,
                    mime: mime,
                    page: img.page,
                    index: img.index
                });
                imageUrls.push(`pdf-image-page${img.page}-idx${img.index}`);
            }
        } catch (e) {
            console.log(`    [deep] PDF 提取失败: ${e.message}，使用标题`);
        }
    } else {
        // arXiv 模式
        const arxivId = paper.arxivId;
        console.log(`    [deep] 获取全文: ${arxivId}`);

        try {
            fullText = await fetchArxivText(arxivId);
            console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
        } catch (e) {
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }

        try {
            const arxivImageUrls = await fetchArxivImageUrls(arxivId);
            console.log(`    [deep] 找到 ${arxivImageUrls.length} 张图片`);

            const downloadedImages = await downloadImagesParallel(arxivImageUrls, arxivImageUrls.length, IMAGE_MAX_BASE64_CHARS, 3);
            console.log(`    [deep] 成功下载 ${downloadedImages.length}/${arxivImageUrls.length} 张图片`);

            for (const img of downloadedImages) {
                imageDataList.push({ url: img.url, base64: img.base64 });
                imageUrls.push(img.url);
            }
        } catch (e) {
            console.log(`    [deep] 获取图片失败: ${e.message}`);
        }
    }

    const textForAnalysis = fullText ? fullText.substring(0, FULL_TEXT_MAX_CHARS) : (paper.abstract || paper.summary || '');
    hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;

    const hasFullTextIntro = hasFullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。';

    // 构建图片映射信息
    let imagePrefix = '';
    if (imageUrls.length > 0) {
        const imageUrlMapping = imageUrls.map((url, idx) => `图${idx + 1}: ${url}`).join('\n');
        imagePrefix = `\n\n论文中的图片及其标识如下（请在下文引用图片时使用这些标识）：\n${imageUrlMapping}\n`;
    }

    const prompt = loadPrompt('prompts/deep-analysis.md', {
        hasFullText: hasFullTextIntro,
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        arxivId: paperId,
        textForAnalysis: textForAnalysis + imagePrefix
    });

    const content = [{ type: 'text', text: prompt }];

    for (const img of imageDataList) {
        if (img.base64) {
            const mime = img.mime || (img.url && img.url.endsWith('.jpg') || img.url.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
            content.push({
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${img.base64}` }
            });
        } else if (img.url) {
            content.push(buildImageContent(img.url, null));
        }
    }

    if (imageDataList.length === 0) {
        console.log(`    [deep] 无可用图片，仅文本分析`);
    } else {
        console.log(`    [deep] 共分析 ${imageDataList.length} 张图片`);
    }

    try {
        const messages = [{ role: 'user', content: content }];

        // 保存深度分析输入
        const inputFile = path.join(DEEP_ANALYZER_IO_DIR, `${safePaperId}_input.json`);
        writeFileAtomic(inputFile, JSON.stringify({
            paperId,
            timestamp: getBeijingISOString(),
            model: DEEP_CONFIG.model,
            maxTokens: API_MAX_TOKENS,
            messages: messages
        }, null, 2));

        const analysis = await callModel(messages, API_MAX_TOKENS);

        // 保存深度分析输出
        const outputFile = path.join(DEEP_ANALYZER_IO_DIR, `${safePaperId}_output.json`);
        writeFileAtomic(outputFile, JSON.stringify({
            paperId,
            timestamp: getBeijingISOString(),
            model: DEEP_CONFIG.model,
            analysis: analysis
        }, null, 2));

        return {
            ...paper,
            analysis: analysis,
            imageUrls: imageUrls,
            allImageUrls: imageUrls
        };
    } catch (err) {
        // 如果带图片超时/失败，尝试不带图片重试
        const isTimeoutOrNetwork = err.message.includes('timeout') || err.message.includes('socket hang up') || err.message.includes('504') || err.message.includes('abort');
        if (imageDataList.length > 0 && isTimeoutOrNetwork) {
            console.log(`    [deep] ⚠️  带图片请求超时，尝试不带图片重试...`);
            try {
                const textOnlyContent = [{ type: 'text', text: prompt }];
                const messagesRetry = [{ role: 'user', content: textOnlyContent }];
                const analysis = await callModel(messagesRetry, API_MAX_TOKENS);
                console.log(`    [deep] ✅ 不带图片重试成功`);

                // 保存重试输出
                const outputFile = path.join(DEEP_ANALYZER_IO_DIR, `${safePaperId}_output_retry.json`);
                writeFileAtomic(outputFile, JSON.stringify({
                    paperId,
                    timestamp: getBeijingISOString(),
                    model: DEEP_CONFIG.model,
                    retry: true,
                    analysis: analysis
                }, null, 2));

                return {
                    ...paper,
                    analysis: analysis,
                    imageUrls: imageUrls,
                    allImageUrls: imageUrls
                };
            } catch (retryErr) {
                console.error(`    [deep] 不带图片重试也失败: ${retryErr.message}`);
            }
        }
        console.error(`    [deep] 分析失败: ${err.message}`);
        return {
            ...paper,
            analysis: null,
            error: err.message
        };
    }
}

module.exports = { analyzePaperDeep, parseAnalysis, callModel, fetchArxivText, fetchArxivImageUrls, extractPdfContent };

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
