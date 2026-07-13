#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * Paper Digest - 论文抓取与筛选模块
 * 功能：
 * 1. 从 7 个 arXiv 类别抓取最新论文
 * 2. 保存论文信息，避免重复分析
 * 3. LLM 筛选语音/音频相关论文（统一使用 PAPER_ANALYZER_* 环境变量）
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const {
    writeFileAtomic,
    getBeijingISOString,
    normalizeToBeijingISOString,
    loadEnvFile,
    readJsonSafe,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    requestJson,
    detectProxyUrl,
    createProxyAgent,
    loadPrompt,
    normalizedId
} = require('./utils.js');
const Config = require('./config.js');

loadEnvFile();

// User-Agent 轮换池
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders() {
    const ua = getRandomUserAgent();
    const isFirefox = ua.includes('Firefox');
    const isSafari = ua.includes('Safari') && !ua.includes('Chrome');

    const headers = {
        'User-Agent': ua,
        'Accept': 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    };

    if (!isFirefox && !isSafari) {
        headers['Sec-Ch-Ua'] = '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"';
        headers['Sec-Ch-Ua-Mobile'] = '?0';
        headers['Sec-Ch-Ua-Platform'] = '"macOS"';
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
        headers['Sec-Fetch-User'] = '?1';
        headers['Upgrade-Insecure-Requests'] = '1';
    }

    return headers;
}

// 从 config.js 读取配置（支持项目 .env 覆写）
const { ARXIV_CATEGORIES: CATEGORIES, ARXIV_CONFIG, FILTER_CONFIG: FILTER_CFG } = Config;

// ========== 筛选阶段专用：LLM 配置（统一使用 PAPER_ANALYZER_*） ===========
const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};
const FILTER_SYSTEM_FAILURE_THRESHOLD = 5;
let consecutiveFilterApiFailures = 0;

function redactProxyUrl(proxyUrl) {
    if (!proxyUrl) return '';
    try {
        const parsed = new URL(proxyUrl);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return String(proxyUrl).replace(/\/\/[^/@\s]+@/, '//***@');
    }
}

function attachHealth(items, health, property = '_sourceHealth') {
    Object.defineProperty(items, property, {
        value: health,
        enumerable: false,
        configurable: true
    });
    return items;
}

function getHealth(items, property = '_sourceHealth') {
    return Array.isArray(items) && items[property] && typeof items[property] === 'object'
        ? items[property]
        : null;
}

function makeSourceFetchError(message, sourceHealth) {
    const error = new Error(message);
    error.code = 'SOURCE_FETCH_FAILED';
    error.sourceHealth = sourceHealth;
    return error;
}

/**
 * 筛选阶段专用：调用 LLM（带重试机制）
 */
async function callModelForFilter(messages, maxTokens = 1000, maxRetries = FILTER_CFG.maxRetries) {
    const missing = [];
    if (!FILTER_CONFIG.endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!FILTER_CONFIG.key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!FILTER_CONFIG.model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        throw new Error(`[filter] 缺少环境变量: ${missing.join(', ')}。请在项目根目录的 .env 文件中配置`);
    }

    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const apiUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(apiUrl);
    console.log(`[filter] API 类型: ${apiType} | 端点: ${url.hostname}${url.pathname}`);

    const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, maxTokens, FILTER_CFG.temperature);

    const proxyUrl = detectProxyUrl();
    if (proxyUrl) {
        console.log(`[filter] 检测到代理: ${redactProxyUrl(proxyUrl)}，将绕过代理直连`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const requestHeaders = buildHeaders(apiType, FILTER_CONFIG.key, JSON.stringify(bodyObj));

        try {
            const response = await requestJson(apiUrl, bodyObj, requestHeaders, {
                timeoutMs: FILTER_CFG.timeoutMs,
                agent: false
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                const apiError = response.body?.error;
                const message = apiError?.message || apiError || response.raw.substring(0, 200);
                throw new Error(`HTTP ${response.statusCode}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
            }
            const content = parseResponseText(apiType, response.body);
            if (content !== null) return content;
            if (response.body.error) {
                throw new Error(response.body.error.message || JSON.stringify(response.body.error));
            }
            throw new Error(`Invalid response (HTTP ${response.statusCode}): ${response.raw.substring(0, 200)}`);
        } catch (err) {
            lastError = err;
            console.log(`[filter] ⚠️  LLM 调用失败 (尝试 ${attempt}/${maxRetries}): ${err.message}`);
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`[filter] ⏳  ${delay}ms 后重试...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`[filter] LLM 调用失败，已重试 ${maxRetries} 次: ${lastError.message}`);
}

// 数据文件路径（从 config.js 读取）
const { FILES } = Config;
const PAPERS_FILE = FILES.papers;
const LEGACY_PAPERS_FILE = FILES.papersLegacy;
const ANALYZED_FILE = FILES.analyzed;
const LEGACY_ANALYZED_FILE = FILES.analyzedLegacy;

/**
 * 加载已保存的论文数据（自动兼容旧格式数组）
 */
function loadPapers() {
    const data = readJsonSafe(PAPERS_FILE, null)
        || readJsonSafe(LEGACY_PAPERS_FILE, null)
        || { papers: {}, lastUpdated: null };
    if (Array.isArray(data)) {
        // 旧格式：纯数组，转换为新格式
        const map = {};
        for (const paper of data) {
            const id = paper.arxivId || paper.paper_id;
            if (id) map[id] = paper;
        }
        return { papers: map, lastUpdated: null };
    }
    return data;
}

/**
 * 保存论文数据（确保新格式）
 */
function savePapers(data) {
    const payload = Array.isArray(data) ? { papers: {}, lastUpdated: getBeijingISOString() } : data;
    payload.lastUpdated = getBeijingISOString();
    writeFileAtomic(PAPERS_FILE, JSON.stringify(payload, null, 2));
}

/**
 * 加载已分析的论文
 */
function loadAnalyzed() {
    return readJsonSafe(ANALYZED_FILE, null)
        || readJsonSafe(LEGACY_ANALYZED_FILE, null)
        || { analyzed: {}, lastUpdated: null };
}

/**
 * 保存已分析的论文
 */
function saveAnalyzed(data) {
    data.lastUpdated = getBeijingISOString();
    writeFileAtomic(ANALYZED_FILE, JSON.stringify(data, null, 2));
}

/**
 * 通过代理发起 HTTPS 请求（使用 https 模块支持 agent）
 */
function httpsRequestWithProxy(url, headers, proxyUrl, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const urlObj = new URL(url);

        if (!proxyUrl) {
            reject(new Error(`arXiv 抓取必须配置当前项目代理（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY），拒绝直连: ${urlObj.hostname}`));
            return;
        }

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: headers,
            timeout: timeoutMs,
        };

        // 如果有代理，使用代理 agent
        if (proxyUrl) {
            options.agent = createProxyAgent(proxyUrl, urlObj.hostname, 443);
        }

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    data: Buffer.concat(chunks).toString('utf8')
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

/**
 * 从 arXiv 搜索页面抓取论文（当 API 被限流时的备用方案）
 * 支持分页获取，默认获取 2 页（100 篇）
 */
async function fetchCategoryFromSearchPage(categoryId, existingIds = null, maxResults = 100, options = {}) {
    const pageSize = 50;
    const pagesToFetch = Math.ceil(maxResults / pageSize);
    const allPapers = [];
    const proxyUrl = detectProxyUrl();
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries || 5;
    const health = { source: 'arxiv-search', attempts: 0, successfulRequests: 0, failures: [] };

    console.log(`[fetch-web] 尝试从搜索页面获取 ${categoryId}（最多 ${maxResults} 篇）...`);

    for (let page = 0; page < pagesToFetch; page++) {
        const start = page * pageSize;
        const searchUrl = `https://arxiv.org/search/?searchtype=all&query=${categoryId}&order=-announced_date_first&start=${start}`;
        let pageSuccess = false;
        let shouldStopPaging = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const headers = getBrowserHeaders();
                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                headers['Referer'] = 'https://arxiv.org/';
                headers['Accept-Language'] = 'en-US,en;q=0.9,zh-CN;q=0.8';

                health.attempts++;
                const response = await requestFn(searchUrl, headers, proxyUrl, 60000);

                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = response.data;
                const papers = parseSearchPageHTML(html, categoryId, existingIds);
                const meta = papers._meta || {};
                health.successfulRequests++;

                if (papers.length === 0) {
                    if (meta.totalFound > 0 && meta.skippedExisting > 0) {
                        console.log(`[fetch-web] 第 ${page + 1} 页均为已知论文，继续翻页寻找更旧新论文`);
                        pageSuccess = true;
                        break;
                    }
                    console.log(`[fetch-web] 第 ${page + 1} 页无论文结果，停止翻页`);
                    pageSuccess = true;
                    shouldStopPaging = true;
                    break;
                }

                allPapers.push(...papers);
                console.log(`[fetch-web] 第 ${page + 1} 页新增 ${papers.length} 篇，累计 ${allPapers.length} 篇`);
                pageSuccess = true;

                // 如果已有足够论文，停止
                if (allPapers.length >= maxResults) {
                    shouldStopPaging = true;
                    break;
                }
                break; // 成功，跳出重试循环
            } catch (err) {
                const is429 = err.message.includes('429');
                if (attempt < maxRetries) {
                    // 429 指数退避：60s, 120s, 240s, 480s
                    const baseDelay = is429 ? 60000 * Math.pow(2, attempt - 1) : 5000 * attempt;
                    const jitter = Math.floor(Math.random() * 15000);
                    const delay = baseDelay + jitter;
                    console.log(`[fetch-web] 第 ${page + 1} 页第 ${attempt} 次失败: ${err.message}，${(delay/1000).toFixed(1)}s 后重试...`);
                    await sleepFn(delay);
                } else {
                    console.log(`[fetch-web] 第 ${page + 1} 页失败 (${maxRetries} 次重试): ${err.message}`);
                    health.failures.push({ page: page + 1, error: err.message });
                }
            }
        }

        if (!pageSuccess && page === 0) {
            // 第一页就全部失败，没有意义继续
            break;
        }

        if (shouldStopPaging) {
            break;
        }

        // 页面间延迟加大：10-25秒
        if (page < pagesToFetch - 1) {
            const delay = Math.floor(Math.random() * 15000) + 10000;
            console.log(`[fetch-web] 页面间等待 ${(delay/1000).toFixed(1)}s...`);
            await sleepFn(delay);
        }
    }

    console.log(`[fetch-web] ${categoryId} 共获取 ${allPapers.length} 篇论文`);
    health.ok = health.successfulRequests > 0;
    health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
    return attachHealth(allPapers.slice(0, maxResults), health);
}

/**
 * 从 arXiv recent 页面抓取论文（支持翻页，最多100篇）
 * recent 页面展示最近几天的论文，限流策略通常比搜索页宽松
 * 翻页：/list/{category}/recent?skip=50&show=50
 */
async function fetchCategoryFromRecentPage(categoryId, existingIds = null, maxResults = 100, options = {}) {
    const proxyUrl = detectProxyUrl();
    const pageSize = 50;
    const pagesToFetch = Math.min(Math.ceil(maxResults / pageSize), 2); // 最多2页100篇
    const allPapers = [];
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries || 5;
    const health = { source: 'arxiv-recent', attempts: 0, successfulRequests: 0, failures: [] };

    for (let page = 0; page < pagesToFetch; page++) {
        const skip = page * pageSize;
        const url = skip === 0
            ? `https://arxiv.org/list/${categoryId}/recent`
            : `https://arxiv.org/list/${categoryId}/recent?skip=${skip}&show=${pageSize}`;
        let pageSuccess = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const headers = getBrowserHeaders();
                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                headers['Referer'] = 'https://arxiv.org/';

                health.attempts++;
                const response = await requestFn(url, headers, proxyUrl, 60000);

                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = response.data;
                const papers = parseRecentPageHTML(html, categoryId, existingIds);
                health.successfulRequests++;

                allPapers.push(...papers);
                console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页获取 ${papers.length} 篇`);
                pageSuccess = true;
                break;
            } catch (err) {
                const is429 = err.message.includes('429');
                if (attempt < maxRetries) {
                    const baseDelay = is429 ? 60000 * Math.pow(2, attempt - 1) : 5000 * attempt;
                    const jitter = Math.floor(Math.random() * 10000);
                    const delay = baseDelay + jitter;
                    console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页第 ${attempt} 次失败: ${err.message}，${(delay/1000).toFixed(1)}s 后重试...`);
                    await sleepFn(delay);
                } else {
                    console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页失败 (${maxRetries} 次重试): ${err.message}`);
                    health.failures.push({ page: page + 1, error: err.message });
                }
            }
        }

        if (!pageSuccess) break;

        // 页间延迟
        if (page < pagesToFetch - 1) {
            await sleepFn(5000);
        }
    }

    // 去重
    const seen = new Set();
    const unique = allPapers.filter(p => {
        if (seen.has(p.arxivId)) return false;
        seen.add(p.arxivId);
        return true;
    });

    console.log(`[fetch-recent] ${categoryId} 共获取 ${unique.length} 篇论文`);
    health.ok = health.successfulRequests > 0;
    health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
    return attachHealth(unique.slice(0, maxResults), health);
}

/**
 * 解析 arXiv recent/new 页面 HTML
 */
function parseRecentPageHTML(html, categoryId, existingIds = null) {
    const papers = [];
    const $ = cheerio.load(html);

    // 组装论文数据
    let newCount = 0, dupCount = 0;
    $('dl > dt').each((_, dt) => {
        const $dt = $(dt);
        const $dd = $dt.next('dd');
        const href = $dt.find('a[href^="/abs/"]').first().attr('href') || '';
        const idMatch = href.match(/\/abs\/([^/?#]+)/);
        if (!idMatch || !$dd.length) return;

        const arxivId = idMatch[1].replace(/v\d+$/, '');
        if (existingIds && existingIds.has(normalizedId(arxivId))) {
            dupCount++;
            return;
        }
        newCount++;

        const title = $dd.find('.list-title').first().clone()
            .find('.descriptor').remove().end()
            .text().replace(/\s+/g, ' ').trim();
        const authors = $dd.find('.list-authors a').map((__, a) =>
            $(a).text().replace(/\s+/g, ' ').trim()
        ).get().filter(Boolean);

        if (title) {
            papers.push({
                paper_id: arxivId,
                arxivId: arxivId,
                title: title,
                authors: authors,
                abstract: '',
                categories: [categoryId],
                source: 'arxiv-recent',
                fetchedAt: getBeijingISOString()
            });
            console.log(`[fetch-recent]   ✓ ${arxivId} - ${title.substring(0, 70)}`);
        }
    });

    console.log(`[fetch-recent] ${categoryId} 去重: ${newCount} 篇新论文, ${dupCount} 篇已存在`);

    return papers;
}

/**
 * 批量补充论文摘要（从 arXiv abs 页面抓取）
 * @param {Array} papers - 论文列表（需要有 arxivId 字段）
 * @param {number} concurrency - 并发数（默认1，避免限流）
 * @returns {Array} 补充了摘要的论文列表
 */
async function fetchAbstracts(papers, concurrency = 1, options = {}) {
    const proxyUrl = detectProxyUrl();
    const needFetch = papers.filter(p => !p.abstract && p.arxivId);
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries || 3;
    const health = { attempted: needFetch.length, fetched: 0, failedIds: [], failures: [] };
    if (needFetch.length === 0) return attachHealth(papers, health, '_abstractHealth');

    console.log(`[fetch-abstract] 需要补充 ${needFetch.length} 篇论文摘要...`);
    let fetched = 0;

    for (let i = 0; i < needFetch.length; i += concurrency) {
        const batch = needFetch.slice(i, i + concurrency);
        await Promise.all(batch.map(async (paper) => {
            let lastError = null;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const url = `https://arxiv.org/abs/${paper.arxivId}`;
                    const headers = getBrowserHeaders();
                    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                    headers['Referer'] = 'https://arxiv.org/';

                    const response = await requestFn(url, headers, proxyUrl, 30000);
                    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

                    // 解析摘要：<blockquote class="abstract mathjax">...<span class="descriptor">Abstract:</span> ...</blockquote>
                    const abstractMatch = response.data.match(/<blockquote\s+class\s*=\s*['"]abstract\s+mathjax['"][^>]*>\s*<span\s+class\s*=\s*['"]descriptor['"]>Abstract:<\/span>\s*([\s\S]*?)\s*<\/blockquote>/i);
                    const abstract = abstractMatch
                        ? abstractMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
                        : '';
                    if (!abstract) throw new Error('响应中缺少非空摘要');
                    paper.abstract = abstract;
                    fetched++;
                    health.fetched++;
                    break;
                } catch (err) {
                    lastError = err;
                    const is429 = err.message.includes('429');
                    if (attempt < maxRetries) {
                        const delay = is429 ? 60000 * attempt : 3000 * attempt;
                        await sleepFn(delay);
                    }
                }
            }
            if (!paper.abstract) {
                const paperId = normalizedId(paper) || paper.arxivId;
                health.failedIds.push(paperId);
                health.failures.push({ id: paperId, error: lastError?.message || 'unknown error' });
            }
        }));

        // 批间延迟
        if (i + concurrency < needFetch.length) {
            await sleepFn(5000);
        }

        // 进度
        if (fetched % 20 === 0 || i + concurrency >= needFetch.length) {
            console.log(`[fetch-abstract] 已补充 ${fetched}/${needFetch.length} 篇`);
        }
    }

    console.log(`[fetch-abstract] 摘要补充完成: ${fetched}/${needFetch.length} 篇`);
    if (health.failedIds.length > 0) {
        console.log(`[fetch-abstract] 最终失败 ID: ${health.failedIds.join(', ')}`);
    }
    return attachHealth(papers, health, '_abstractHealth');
}

/**
 * 解析 arXiv 搜索页面 HTML
 */
function parseSearchPageHTML(html, categoryId, existingIds = null) {
    const papers = [];
    let totalFound = 0;
    let skippedExisting = 0;

    // 匹配搜索结果中的论文条目
    const itemRegex = /<li class="arxiv-result">([\s\S]*?)<\/li>/g;
    let match;

    while ((match = itemRegex.exec(html)) !== null) {
        const item = match[1];

        // 提取 arXiv ID
        const idMatch = item.match(/arXiv:(\d+\.\d+)/);
        if (!idMatch) continue;
        const arxivId = idMatch[1];
        totalFound++;

        if (existingIds && existingIds.has(normalizedId(arxivId))) {
            skippedExisting++;
            continue;
        }

        // 提取标题
        const titleMatch = item.match(/<p class="title is-5 mathjax">([\s\S]*?)<\/p>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : 'Unknown';

        // 打印每篇论文信息
        console.log(`[fetch-web]   ✓ ${arxivId} - ${title.substring(0, 60)}...`);

        // 提取摘要 - 使用 abstract-full 以获取完整摘要
        const abstractMatch = item.match(/<span class="abstract-full has-text-grey-dark mathjax"[^>]*>([\s\S]*?)<\/span>/);
        let abstract = abstractMatch ? abstractMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
        // 移除 "△ Less" 后缀
        abstract = abstract.replace(/\s*△ Less$/, '').trim();

        // 如果没有完整摘要，尝试获取简短摘要
        if (!abstract) {
            const shortAbstractMatch = item.match(/<span class="abstract-short has-text-grey-dark mathjax"[^>]*>([\s\S]*?)<\/span>/);
            abstract = shortAbstractMatch ? shortAbstractMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
            abstract = abstract.replace(/\s*\.\.\.$/, '').trim();
        }

        // 提取作者
        const authors = [];
        const authorRegex = /<a href="\/search\/\?searchtype=author[^"]*">([^<]+)<\/a>/g;
        let authorMatch;
        while ((authorMatch = authorRegex.exec(item)) !== null) {
            authors.push(authorMatch[1].trim());
        }

        // 提取日期
        const dateMatch = item.match(/Submitted<\/span>\s*(\d+)\s+(\w+),?\s*(\d{4})/);
        let published = '';
        if (dateMatch) {
            const months = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
            const day = dateMatch[1].padStart(2, '0');
            const month = months[dateMatch[2]] || '01';
            const year = dateMatch[3];
            published = `${year}-${month}-${day}T00:00:00+08:00`;
        }

        // 提取分类
        const categories = [];
        const catRegex = /<span class="tag is-small is-link[^"]*"[^>]*>([^<]+)<\/span>/g;
        let catMatch;
        while ((catMatch = catRegex.exec(item)) !== null) {
            categories.push(catMatch[1].trim());
        }
        if (categories.length === 0) {
            categories.push(categoryId);
        }

        papers.push({
            arxivId,
            title,
            abstract,
            authors,
            published,
            categories,
            fetchedFrom: categoryId,
            fetchedAt: getBeijingISOString(),
            source: 'web-scrape'
        });
    }

    if (totalFound > 0) {
        console.log(`[fetch-web] 搜索到 ${totalFound} 篇，去重后 ${papers.length} 篇（跳过 ${skippedExisting} 篇已有论文）`);
    }

    papers._meta = { totalFound, skippedExisting };
    return papers;
}

/**
 * 从 arXiv 抓取指定类别的论文
 * 策略：recent → 搜索页 → API，每步获取足够就跳过后续
 */
async function fetchCategoryPapers(categoryId, maxResults = ARXIV_CONFIG.maxResultsPerCategory, retryCount = ARXIV_CONFIG.fetchMaxRetries, existingIds = null, options = {}) {
    console.log(`[fetch] 正在抓取 ${categoryId} 类别的 ${maxResults} 篇论文...`);
    if (!options.requestFn && !detectProxyUrl()) {
        throw new Error('arXiv 抓取必须通过当前项目 .env 中的 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，拒绝在无代理配置时直连');
    }
    const merged = new Map();
    const seenIds = new Set(existingIds ? Array.from(existingIds) : []);
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const perSourceOptions = { requestFn, sleepFn, maxRetries: options.maxRetries };
    const health = {
        categoryId,
        attempts: 0,
        successfulRequests: 0,
        failures: [],
        methods: {}
    };

    const absorbHealth = (method, methodHealth) => {
        if (!methodHealth) return;
        health.methods[method] = methodHealth;
        health.attempts += methodHealth.attempts || 0;
        health.successfulRequests += methodHealth.successfulRequests || 0;
        for (const failure of methodHealth.failures || []) {
            health.failures.push({ method, ...failure });
        }
    };

    const finish = () => {
        const result = Array.from(merged.values()).slice(0, maxResults);
        health.ok = health.successfulRequests > 0;
        health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
        health.fetched = result.length;
        if (health.allFailed) {
            const failureSummary = health.failures.map(item => `${item.method || 'unknown'}:${item.error}`).join('; ');
            throw makeSourceFetchError(`arXiv ${categoryId} 所有抓取请求均失败${failureSummary ? `: ${failureSummary}` : ''}`, health);
        }
        return attachHealth(result, health);
    };

    // 1. 优先用 recent 页面
    let recentPapers = await fetchCategoryFromRecentPage(categoryId, seenIds, maxResults, perSourceOptions);
    absorbHealth('recent', getHealth(recentPapers));

    // 补充摘要（recent 页面不包含摘要）
    if (recentPapers.length > 0) {
        recentPapers = await fetchAbstracts(recentPapers, 5, { requestFn, sleepFn, maxRetries: options.abstractMaxRetries });
        health.abstracts = getHealth(recentPapers, '_abstractHealth');
        for (const p of recentPapers) {
            const key = normalizedId(p);
            if (key) {
                merged.set(key, p);
                seenIds.add(key);
            }
        }
        if (merged.size >= maxResults) {
            return finish();
        }
        console.log(`[fetch] ${categoryId} recent 仅 ${merged.size}/${maxResults} 篇，继续用搜索页补足...`);
    } else {
        console.log(`[fetch] ${categoryId} recent 无结果，尝试搜索页...`);
    }

    // 2. recent 无结果，用搜索页
    const webPapers = await fetchCategoryFromSearchPage(categoryId, seenIds, maxResults, perSourceOptions);
    absorbHealth('search', getHealth(webPapers));
    for (const p of webPapers) {
        const key = normalizedId(p);
        if (key && !merged.has(key)) {
            merged.set(key, p);
            seenIds.add(key);
        }
    }

    if (merged.size >= maxResults || webPapers.length > 0) {
        const result = Array.from(merged.values());
        console.log(`[fetch] ${categoryId} recent+搜索页合并 ${result.length} 篇`);
        if (result.length >= maxResults) return finish();
    }

    // 3. 搜索页也无结果，用 API
    console.log(`[fetch] ${categoryId} recent+搜索页仅 ${merged.size} 篇，尝试 API...`);

    const params = new URLSearchParams({
        'search_query': `cat:${categoryId}`,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending',
        'max_results': maxResults.toString()
    });
    const url = `https://export.arxiv.org/api/query?${params.toString()}`;
    const proxyUrl = detectProxyUrl();
    const apiHealth = { source: 'arxiv-api', attempts: 0, successfulRequests: 0, failures: [] };
    let apiLastError = null;

    for (let attempt = 1; attempt <= Math.min(retryCount, 5); attempt++) {
        const headers = getBrowserHeaders();
        headers['Referer'] = 'https://arxiv.org/';

        try {
            apiHealth.attempts++;
            const response = await requestFn(url, headers, proxyUrl, 60000);

            if (response.status === 200) {
                apiHealth.successfulRequests++;
                const xml = response.data;
                const apiPapers = parseArxivXML(xml, categoryId, seenIds, { stopAtConsecutiveExisting: false });

                if (apiPapers.length > 0) {
                    for (const p of apiPapers) {
                        const key = normalizedId(p);
                        if (key && !merged.has(key)) {
                            merged.set(key, p);
                            seenIds.add(key);
                        }
                    }
                }
                break;
            }
            throw new Error(`HTTP ${response.status}`);
        } catch (err) {
            apiLastError = err;
            if (attempt === Math.min(retryCount, 5)) break;
            const is429 = err.message.includes('429');
            const baseDelay = is429 ? 60000 * Math.pow(2, attempt - 1) : 5000 * attempt;
            const jitter = Math.floor(Math.random() * 10000);
            const delay = baseDelay + jitter;
            console.log(`[fetch] ${categoryId} API 第 ${attempt} 次失败: ${err.message}，${(delay/1000).toFixed(0)}s 后重试...`);
            await sleepFn(delay);
        }
    }
    if (apiHealth.successfulRequests === 0 && apiLastError) {
        apiHealth.failures.push({ error: apiLastError.message });
    }
    apiHealth.ok = apiHealth.successfulRequests > 0;
    apiHealth.allFailed = apiHealth.attempts > 0 && apiHealth.successfulRequests === 0;
    absorbHealth('api', apiHealth);

    const result = Array.from(merged.values());
    console.log(`[fetch] ${categoryId} 最终 ${result.length} 篇`);
    return finish();
}

/**
 * 解析 arXiv API 返回的 XML
 */
function parseArxivXML(xml, categoryId, existingIds = null, options = {}) {
    const { stopAtConsecutiveExisting = true } = options;
    const papers = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    let consecutiveExisting = 0;
    let entryCount = 0;
    let stoppedAtConsecutive = false;

    while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        entryCount++;

        const idMatch = entry.match(/<id>(.*?)<\/id>/);
        if (!idMatch) continue;
        const arxivId = idMatch[1].split('/abs/').pop();

        if (existingIds && existingIds.has(normalizedId(arxivId))) {
            consecutiveExisting++;
            if (stopAtConsecutiveExisting && consecutiveExisting >= ARXIV_CONFIG.consecutiveExistingThreshold) {
                console.log(`[fetch] 遇到连续 ${consecutiveExisting} 篇已知论文，停止抓取 ${categoryId}`);
                stoppedAtConsecutive = true;
                break;
            }
            continue;
        }

        consecutiveExisting = 0;

        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(/\n/g, ' ').trim() : 'Unknown';

        const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
        const abstract = summaryMatch ? summaryMatch[1].replace(/\n/g, ' ').trim() : '';

        const authors = [];
        const authorRegex = /<author>\s*<name>(.*?)<\/name>/g;
        let authorMatch;
        while ((authorMatch = authorRegex.exec(entry)) !== null) {
            authors.push(authorMatch[1]);
        }

        const publishedMatch = entry.match(/<published>(.*?)<\/published>/);
        const published = publishedMatch ? normalizeToBeijingISOString(publishedMatch[1]) : '';

        const categories = [];
        const categoryRegex = /<category term="(.*?)"/g;
        let catMatch;
        while ((catMatch = categoryRegex.exec(entry)) !== null) {
            categories.push(catMatch[1]);
        }

        papers.push({
            arxivId,
            title,
            abstract,
            authors,
            published,
            categories,
            fetchedFrom: categoryId,
            fetchedAt: getBeijingISOString()
        });
    }

    papers._meta = { entryCount, stoppedAtConsecutive };
    return papers;
}

/**
 * 去重：按 arxivId 去重，保留最相关类别
 */
function deduplicatePapers(papers) {
    const seen = new Map();

    for (const paper of papers) {
        const existing = seen.get(paper.arxivId);

        if (!existing) {
            seen.set(paper.arxivId, paper);
        } else {
            const existingPriority = CATEGORIES.find(c => c.id === existing.fetchedFrom)?.priority || 'supplement';
            const newPriority = CATEGORIES.find(c => c.id === paper.fetchedFrom)?.priority || 'supplement';

            if (newPriority === 'core' && existingPriority !== 'core') {
                seen.set(paper.arxivId, paper);
            }
        }
    }

    return Array.from(seen.values());
}

/**
 * 用大模型判断论文是否语音/音频相关
 */
function parseFilterDecision(responseText, paperId = '') {
    return parseFilterDecisionDetails(responseText, paperId).related;
}

function extractFilterReason(responseText) {
    const text = String(responseText || '').trim();
    if (!text) return '';
    try {
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
            if (parsed.reason || parsed.rationale || parsed.explanation) {
                return String(parsed.reason || parsed.rationale || parsed.explanation).trim();
            }
        }
    } catch {
        // fall through
    }
    const reasonMatch = text.match(/(?:理由|原因|reason|rationale)\s*[：:]\s*([^\n]+)/i);
    if (reasonMatch) return reasonMatch[1].trim();
    return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ');
}

function parseFilterDecisionDetails(responseText, paperId = '') {
    const rawText = String(responseText || '').trim();
    const answer = rawText.toLowerCase();
    const reason = extractFilterReason(responseText);
    const makeDecision = (related, source) => ({
        related,
        reason,
        rawResponse: rawText,
        parseSource: source
    });
    const makeRetryable = (source, suggestedRelated = null) => ({
        ...makeDecision(null, source),
        suggestedRelated,
        retryable: true,
        fallback: true
    });

    // 1. 优先解析 JSON 格式，便于未来让 prompt 输出机器可读结构
    try {
        const jsonStart = answer.indexOf('{');
        const jsonEnd = answer.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
            const decisionValue = getCaseInsensitiveField(parsed, ['decision', 'related', 'conclusion']);
            if (typeof decisionValue === 'boolean') return makeDecision(decisionValue, 'json');
            const decision = String(decisionValue ?? '').trim().toLowerCase();
            if (['related', 'yes', 'y', 'true', '相关', '是'].includes(decision)) return makeDecision(true, 'json');
            if (['not_related', 'not related', 'no', 'n', 'false', '不相关', '无关', '否'].includes(decision)) return makeDecision(false, 'json');
        }
    } catch {
        // fall through to text parsing
    }

    // 2. 优先匹配结构化结论行，先判否定，避免 fallback 中“是否相关”的“否”误伤
    const conclusionMatch = answer.match(/(?:结论|判断|是否相关|conclusion|judgment|related)\s*[：:]\s*(not\s+related|not_related|unrelated|不相关|无关|否|no|n|related|相关|是|yes|y)(?=\s|$|[。；;，,])/i);
    if (conclusionMatch) {
        const v = conclusionMatch[1].toLowerCase();
        return makeDecision(
            !(v === 'not related' || v === 'not_related' || v === 'unrelated' || v === '不相关' || v === '无关' || v === '否' || v === 'no' || v === 'n'),
            'conclusion_line'
        );
    }

    // 3. 检查最后一行
    const lines = answer.split('\n').map(l => l.trim()).filter(l => l);
    const lastLine = lines[lines.length - 1] || '';
    if (lastLine === '相关' || lastLine === '是' || lastLine === 'yes' || lastLine === 'y' || lastLine === 'related') {
        return makeDecision(true, 'last_line');
    }
    if (lastLine === '不相关' || lastLine === '无关' || lastLine === '否' || lastLine === 'no' || lastLine === 'n' || lastLine === 'not related' || lastLine === 'not_related' || lastLine === 'unrelated') {
        return makeDecision(false, 'last_line');
    }

    // 非结构化关键词只能作为诊断提示，不能写入正式完成缓存。
    if (answer.includes('不相关') || answer.includes('无关') || /\b(not related|not_related|unrelated)\b/i.test(answer)) {
        return makeRetryable('keyword_negative_retryable', false);
    }
    if (answer.includes('相关') || /\brelated\b/i.test(answer)) {
        return makeRetryable('keyword_positive_retryable', true);
    }

    // 无法可靠解析时保留为可重试状态，不得作为正式相关结论进入缓存。
    console.log(`[filter] 无法判断 ${paperId}: "${answer.substring(0, 50)}" → 标记为待重试`);
    return makeRetryable('fallback_retryable');
}

/**
 * 某些模型会给出完整推理，却遗漏最后的机器可读结论行。不能把推理中的
 * 关键词直接当正式决定（会误判），但也不应该因此让整个日批次永久卡住。
 * 对这种有明确倾向的响应，额外发起一次极短的格式修复请求；只有修复响应
 * 自身可被严格解析时才升级为正式决定。
 */
async function repairMalformedFilterDecision(initialDecision, paperId, requestFn = callModelForFilter) {
    if (!initialDecision?.retryable
        || typeof initialDecision.suggestedRelated !== 'boolean'
        || !initialDecision.rawResponse) {
        return initialDecision;
    }

    const repairPrompt = [
        '上一条筛选回答缺少可解析的最终结论。',
        '只根据上一条回答已经表达的最终判断，严格只输出一行：',
        '结论：相关',
        '或',
        '结论：不相关',
        '不要解释，不要复述标准，不要输出其他文字。',
        `上一条回答：\n${initialDecision.rawResponse.slice(0, 12000)}`
    ].join('\n');

    try {
        const repairedText = await requestFn([{ role: 'user', content: repairPrompt }], 32);
        const repaired = parseFilterDecisionDetails(repairedText, paperId);
        if (typeof repaired.related === 'boolean' && !repaired.retryable && !repaired.fallback) {
            return {
                ...repaired,
                reason: initialDecision.reason || repaired.reason,
                rawResponse: `${initialDecision.rawResponse}\n\n[format-repair]\n${repairedText}`,
                parseSource: `format_repair:${repaired.parseSource}`,
                repairedFrom: initialDecision.parseSource
            };
        }
        return initialDecision;
    } catch (err) {
        console.warn(`[filter] 格式修复失败 ${paperId}: ${err.message}`);
        return initialDecision;
    }
}

function getCaseInsensitiveField(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    const wanted = new Set(names.map(name => name.toLowerCase()));
    for (const [key, value] of Object.entries(obj)) {
        if (wanted.has(String(key).toLowerCase())) return value;
    }
    return undefined;
}

async function getSpeechAudioDecision(paper) {
    const paperId = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title,
        abstract: paper.abstract || paper.summary || '',
        categories: paper.categories || paper.category || ''
    });

    try {
        const response = await callModelForFilter([{ role: 'user', content: prompt }], 1000);
        consecutiveFilterApiFailures = 0;
        const initialDecision = parseFilterDecisionDetails(response, paperId);
        return repairMalformedFilterDecision(initialDecision, paperId);
    } catch (err) {
        consecutiveFilterApiFailures++;
        if (consecutiveFilterApiFailures >= FILTER_SYSTEM_FAILURE_THRESHOLD) {
            throw new Error(`筛选模型连续 ${consecutiveFilterApiFailures} 次调用失败，疑似 API 配置或服务故障: ${err.message}`);
        }
        console.error(`[filter] 判断论文 ${paperId} 失败: ${err.message}，标记为待重试`);
        return {
            related: null,
            reason: `筛选 API 调用失败，等待重试: ${err.message}`,
            rawResponse: '',
            parseSource: 'api_error_retryable',
            error: err.message,
            fallback: true,
            retryable: true
        };
    }
}

async function isSpeechAudioRelated(paper) {
    return (await getSpeechAudioDecision(paper)).related;
}

/**
 * 筛选论文（用大模型判断是否语音/音频相关）
 */
async function filterPapersWithLLM(papers, options = {}) {
    const {
        batchSize = 5,
        delayBetweenBatches = 2000,
        useKeywordPreFilter = false,
        initialDecisions = null,
        onBatchComplete = null,
        decisionFn = getSpeechAudioDecision,
        decisionMetadata = {}
    } = options;

    console.log(`[filter] 开始筛选 ${papers.length} 篇论文（全部使用大模型）...`);

    let papersToCheck = papers;

    if (useKeywordPreFilter) {
        const keywordFiltered = filterPapersByKeywords(papers);
        console.log(`[filter] 关键词预筛选：${papers.length} → ${keywordFiltered.length} 篇`);
        papersToCheck = keywordFiltered;
    }

    const decisions = new Map();
    const retryableDecisions = new Map();
    const currentPaperIds = new Set(papersToCheck
        .map(paper => normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '')
        .filter(Boolean));
    const loadDecision = (id, decision) => {
        const key = normalizedId(id);
        if (!key || !decision || typeof decision.related !== 'boolean' || decision.retryable || decision.fallback) return;
        if (!currentPaperIds.has(key)) return;
        decisions.set(key, decision);
    };
    if (initialDecisions instanceof Map) {
        for (const [id, decision] of initialDecisions.entries()) {
            loadDecision(id, decision);
        }
    } else if (initialDecisions && typeof initialDecisions === 'object') {
        for (const [id, decision] of Object.entries(initialDecisions)) {
            loadDecision(id, decision);
        }
    }

    const getFilteredFromDecisions = () => papersToCheck.filter(paper => {
        const id = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
        return decisions.get(id)?.related === true;
    });

    const papersNeedingDecision = [];
    let reusedDecisions = 0;
    for (const paper of papersToCheck) {
        const id = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
        if (decisions.has(id)) {
            reusedDecisions++;
        } else {
            papersNeedingDecision.push(paper);
        }
    }
    if (reusedDecisions > 0) {
        console.log(`[filter] 复用已有筛选决策 ${reusedDecisions} 篇，待调用模型 ${papersNeedingDecision.length} 篇`);
    }

    const batches = [];

    for (let i = 0; i < papersNeedingDecision.length; i += batchSize) {
        batches.push(papersNeedingDecision.slice(i, i + batchSize));
    }

    console.log(`[filter] 分成 ${batches.length} 批处理，每批 ${batchSize} 篇`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`[filter] 处理批次 ${batchIndex + 1}/${batches.length}...`);

        const batchResults = await Promise.all(batch.map(async (paper) => {
            const modelDecision = await decisionFn(paper);
            const isDefinitive = typeof modelDecision.related === 'boolean'
                && !modelDecision.retryable
                && !modelDecision.fallback;
            const isRelated = isDefinitive ? modelDecision.related : null;
            const paperId = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
            const decision = {
                id: paperId,
                paper_id: paper.paper_id || paper.arxivId || paper.id || paperId,
                title: paper.title || '',
                related: isRelated,
                reason: modelDecision.reason || '',
                rawResponse: modelDecision.rawResponse || '',
                parseSource: modelDecision.parseSource || '',
                error: modelDecision.error || null,
                fallback: Boolean(modelDecision.fallback),
                retryable: !isDefinitive,
                decidedAt: getBeijingISOString(),
                ...decisionMetadata
            };
            if (isDefinitive) {
                decisions.set(paperId, decision);
                retryableDecisions.delete(paperId);
            } else {
                retryableDecisions.set(paperId, decision);
            }

            if (!isDefinitive) {
                console.log(`[filter] ↻ 待重试: ${paperId} - ${paper.title.substring(0, 40)}...`);
            } else if (isRelated) {
                console.log(`[filter] ✓ 相关: ${paperId} - ${paper.title.substring(0, 40)}...`);
            } else {
                console.log(`[filter] ✗ 过滤: ${paperId} - ${paper.title.substring(0, 40)}...`);
            }
            return decision;
        }));

        if (typeof onBatchComplete === 'function') {
            await onBatchComplete({
                batchIndex,
                totalBatches: batches.length,
                batchResults,
                results: getFilteredFromDecisions(),
                decisions: Object.fromEntries(decisions),
                retryableDecisions: Object.fromEntries(retryableDecisions),
                stats: {
                    totalCandidates: papersToCheck.length,
                    decided: decisions.size,
                    retryable: retryableDecisions.size,
                    complete: decisions.size === papersToCheck.length && retryableDecisions.size === 0
                }
            });
        }

        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }

    const results = getFilteredFromDecisions();
    const filterStats = {
        totalCandidates: papersToCheck.length,
        decided: decisions.size,
        retryable: retryableDecisions.size,
        retryableIds: Array.from(retryableDecisions.keys()),
        complete: decisions.size === papersToCheck.length && retryableDecisions.size === 0
    };
    console.log(`[filter] 筛选阶段结束：${papers.length} 篇候选，明确决定 ${decisions.size} 篇，待重试 ${retryableDecisions.size} 篇，相关 ${results.length} 篇`);
    return attachHealth(results, filterStats, '_filterStats');
}

/**
 * 基于关键词的预筛选（快速过滤明显不相关的论文）
 */
function filterPapersByKeywords(papers) {
    const speechAudioKeywords = [
        'speech', 'audio', 'voice', 'acoustic', 'sound', 'speaker', 'tts', 'asr',
        'vocoder', 'mel-spectrogram', 'waveform', 'spectrogram',
        'text-to-speech', 'speech-to-text', 'speech synthesis', 'speech recognition',
        'voice cloning', 'voice conversion', 'voice synthesis', 'voice generation',
        'speech enhancement', 'speech separation', 'speech translation',
        'speaker verification', 'speaker identification', 'speaker diarization',
        'audio generation', 'audio synthesis', 'audio processing', 'audio understanding',
        'music generation', 'music synthesis', 'audio deepfake', 'voice deepfake',
        'keyword spotting', 'wake word', 'hotword',
        'audio captioning', 'audio tagging', 'sound event detection',
        'audio-visual speech', 'lip reading', 'lip sync',
        'wav2vec', 'wav2vec2', 'hubert', 'whisper', 'vall-e', 'vall-e 2',
        'tacotron', 'fastspeech', 'parallel wavegan', 'hifigan', 'bigvgan',
        'diffusion model', 'flow matching', 'score-based',
        'speech quality', 'mos prediction', 'pesq', 'stoi',
        'noise suppression', 'echo cancellation', 'beamforming',
        'microphone array', 'room acoustics', 'reverberation',
        'end-to-end speech', 'self-supervised speech', 'speech representation',
        '语音', '音频', '声音', '声学', '说话人', '语音合成', '语音识别',
        '语音克隆', '语音转换', '语音增强', '语音分离', '语音翻译',
        '音频生成', '音频理解', '音乐生成', '语音情感', '语音质量',
        '端到端语音', '自监督语音', '语音表示', '语音模型'
    ];

    const coreCategories = ['eess.AS', 'cs.SD', 'eess.SP'];

    return papers.filter(paper => {
        const abstractText = paper.abstract || paper.summary || '';
        if (abstractText.toLowerCase().includes('withdrawn') ||
            abstractText.toLowerCase().includes('retracted')) {
            return false;
        }

        const categories = Array.isArray(paper.categories) ? paper.categories : [];
        const hasCoreCategory = categories.some(cat => coreCategories.includes(cat));
        if (hasCoreCategory) {
            return true;
        }

        const textToCheck = `${paper.title} ${abstractText}`.toLowerCase();
        const hasKeyword = speechAudioKeywords.some(keyword =>
            textToCheck.includes(keyword.toLowerCase())
        );

        return hasKeyword;
    });
}

const filterPapers = filterPapersWithLLM;

module.exports = {
    CATEGORIES,
    fetchCategoryPapers,
    fetchCategoryFromSearchPage,
    fetchCategoryFromRecentPage,
    fetchAbstracts,
    parseRecentPageHTML,
    parseSearchPageHTML,
    parseArxivXML,
    deduplicatePapers,
    filterPapers,
    filterPapersWithLLM,
    parseFilterDecision,
    parseFilterDecisionDetails,
    repairMalformedFilterDecision,
    redactProxyUrl,
    isSpeechAudioRelated,
    getSpeechAudioDecision,
    filterPapersByKeywords,
    loadPapers,
    savePapers,
    loadAnalyzed,
    saveAnalyzed
};
