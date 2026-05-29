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
        'Accept-Encoding': 'gzip, deflate, br',
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

// 从 config.js 读取配置（支持环境变量覆写）
const { ARXIV_CATEGORIES: CATEGORIES, ARXIV_CONFIG, FILTER_CONFIG: FILTER_CFG } = Config;

// ========== 筛选阶段专用：LLM 配置（统一使用 PAPER_ANALYZER_*） ===========
const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};

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

    const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, maxTokens, 0.3);
    const postData = JSON.stringify(bodyObj);

    const proxyUrl = detectProxyUrl();
    const isMimo = FILTER_CONFIG.endpoint.includes('xiaomimimo.com') || FILTER_CONFIG.model.includes('mimo');
    const shouldBypassProxy = isMimo && proxyUrl;
    if (proxyUrl) {
        console.log(`[filter] 检测到代理: ${proxyUrl}${shouldBypassProxy ? '（MiMo 模型，将绕过代理）' : ''}`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FILTER_CFG.timeoutMs);

        const requestHeaders = buildHeaders(apiType, FILTER_CONFIG.key, postData);

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: requestHeaders,
            timeout: FILTER_CFG.timeoutMs,
            signal: controller.signal
        };
        if (shouldBypassProxy) {
            options.agent = false;
        }

        try {
            const result = await new Promise((resolve, reject) => {
                const https = require('https');
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        clearTimeout(timeoutId);
                        try {
                            const response = JSON.parse(data);
                            const content = parseResponseText(apiType, response);
                            if (content !== null) {
                                resolve(content);
                            } else if (response.error) {
                                reject(new Error(response.error.message || JSON.stringify(response.error)));
                            } else {
                                reject(new Error('Invalid response: ' + data.substring(0, 200)));
                            }
                        } catch (e) {
                            reject(new Error('Parse error: ' + e.message));
                        }
                    });
                });
                req.on('error', (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
                req.on('timeout', () => {
                    clearTimeout(timeoutId);
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
                req.write(postData);
                req.end();
            });
            return result;
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
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    data: data
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
async function fetchCategoryFromSearchPage(categoryId, existingIds = null, maxResults = 100) {
    const pageSize = 50;
    const pagesToFetch = Math.ceil(maxResults / pageSize);
    const allPapers = [];
    const proxyUrl = detectProxyUrl();

    console.log(`[fetch-web] 尝试从搜索页面获取 ${categoryId}（最多 ${maxResults} 篇）...`);

    for (let page = 0; page < pagesToFetch; page++) {
        const start = page * pageSize;
        const searchUrl = `https://arxiv.org/search/?searchtype=all&query=${categoryId}&order=-announced_date_first&start=${start}`;

        try {
            const headers = getBrowserHeaders();
            headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

            const response = await httpsRequestWithProxy(searchUrl, headers, proxyUrl, 60000);

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = response.data;
            const papersBeforeFilter = allPapers.length;
            const papers = parseSearchPageHTML(html, categoryId, existingIds);

            if (papers.length === 0) {
                console.log(`[fetch-web] 第 ${page + 1} 页无新论文，停止翻页`);
                break;
            }

            allPapers.push(...papers);
            console.log(`[fetch-web] 第 ${page + 1} 页新增 ${papers.length} 篇，累计 ${allPapers.length} 篇`);

            // 如果已有足够论文，停止
            if (allPapers.length >= maxResults) {
                break;
            }

            // 页面间延迟，避免被限流
            if (page < pagesToFetch - 1) {
                const delay = Math.floor(Math.random() * 3000) + 2000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (err) {
            console.log(`[fetch-web] 第 ${page + 1} 页获取失败: ${err.message}`);
            break;
        }
    }

    console.log(`[fetch-web] ${categoryId} 共获取 ${allPapers.length} 篇论文`);
    return allPapers.slice(0, maxResults);
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

    return papers;
}

/**
 * 从 arXiv 抓取指定类别的论文
 * 策略：网页抓取为主，API 为辅
 */
async function fetchCategoryPapers(categoryId, maxResults = ARXIV_CONFIG.maxResultsPerCategory, retryCount = ARXIV_CONFIG.fetchMaxRetries, existingIds = null) {
    console.log(`[fetch] 正在抓取 ${categoryId} 类别的 ${maxResults} 篇论文...`);

    // 优先使用网页抓取
    const webPapers = await fetchCategoryFromSearchPage(categoryId, existingIds, maxResults);

    // 如果网页抓取获取到足够论文，直接返回
    if (webPapers.length >= maxResults * 0.8) {
        return webPapers;
    }

    // 网页抓取不足，尝试 API 补充
    console.log(`[fetch] ${categoryId} 网页抓取 ${webPapers.length} 篇，尝试 API 补充...`);

    const params = new URLSearchParams({
        'search_query': `cat:${categoryId}`,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending',
        'max_results': maxResults.toString()
    });
    const url = `https://export.arxiv.org/api/query?${params.toString()}`;

    const proxyUrl = detectProxyUrl();

    for (let attempt = 1; attempt <= Math.min(retryCount, 3); attempt++) {
        const headers = getBrowserHeaders();

        try {
            const response = await httpsRequestWithProxy(url, headers, proxyUrl, 60000);

            if (response.status === 200) {
                const xml = response.data;
                const apiPapers = parseArxivXML(xml, categoryId, existingIds);

                if (apiPapers.length > 0) {
                    // 合并去重
                    const merged = new Map();
                    for (const p of webPapers) merged.set(p.arxivId, p);
                    for (const p of apiPapers) {
                        if (!merged.has(p.arxivId)) merged.set(p.arxivId, p);
                    }
                    const result = Array.from(merged.values());
                    console.log(`[fetch] ${categoryId} 合并后共 ${result.length} 篇论文`);
                    return result;
                }
            }
            break;
        } catch (err) {
            if (attempt === Math.min(retryCount, 3)) break;
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    return webPapers;
}

/**
 * 解析 arXiv API 返回的 XML
 */
function parseArxivXML(xml, categoryId, existingIds = null) {
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
            if (consecutiveExisting >= ARXIV_CONFIG.consecutiveExistingThreshold) {
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
async function isSpeechAudioRelated(paper) {
    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title,
        abstract: paper.abstract || paper.summary || '',
        categories: paper.categories || paper.category || ''
    });

    try {
        const response = await callModelForFilter([{ role: 'user', content: prompt }], 1000);
        const answer = response ? response.trim().toLowerCase() : '';

        // 1. 优先匹配新格式「结论：相关/不相关」
        if (answer.includes('结论：相关') || answer.includes('结论:相关')) {
            return true;
        }
        if (answer.includes('结论：不相关') || answer.includes('结论:不相关')) {
            return false;
        }

        // 2. 兼容旧格式「判断：是/否」
        if (answer.includes('判断：是') || answer.includes('判断:是')) {
            return true;
        }
        if (answer.includes('判断：否') || answer.includes('判断:否')) {
            return false;
        }

        // 3. 检查最后一行
        const lines = answer.split('\n').map(l => l.trim()).filter(l => l);
        const lastLine = lines[lines.length - 1] || '';
        if (lastLine === '相关' || lastLine === '是' || lastLine === 'yes' || lastLine === 'y') {
            return true;
        }
        if (lastLine === '不相关' || lastLine === '否' || lastLine === 'no' || lastLine === 'n') {
            return false;
        }

        // 4. 文本中是否包含明确否定/肯定词
        if (answer.includes('不相关') || answer.includes('无关') || answer.includes('否')) {
            return false;
        }
        if (answer.includes('相关') || answer.includes('是')) {
            return true;
        }

        // 5. 仍无法判断，默认保留（宁可错留不可错杀）
        console.log(`[filter] 无法判断 ${paper.arxivId}: "${answer.substring(0, 50)}" → 默认保留`);
        return true;
    } catch (err) {
        console.error(`[filter] 判断论文 ${paper.arxivId} 失败: ${err.message}`);
        return false;
    }
}

/**
 * 筛选论文（用大模型判断是否语音/音频相关）
 */
async function filterPapersWithLLM(papers, options = {}) {
    const {
        batchSize = 5,
        delayBetweenBatches = 2000,
        useKeywordPreFilter = false
    } = options;

    console.log(`[filter] 开始筛选 ${papers.length} 篇论文（全部使用大模型）...`);

    let papersToCheck = papers;

    if (useKeywordPreFilter) {
        const keywordFiltered = filterPapersByKeywords(papers);
        console.log(`[filter] 关键词预筛选：${papers.length} → ${keywordFiltered.length} 篇`);
        papersToCheck = keywordFiltered;
    }

    const results = [];
    const batches = [];

    for (let i = 0; i < papersToCheck.length; i += batchSize) {
        batches.push(papersToCheck.slice(i, i + batchSize));
    }

    console.log(`[filter] 分成 ${batches.length} 批处理，每批 ${batchSize} 篇`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`[filter] 处理批次 ${batchIndex + 1}/${batches.length}...`);

        const batchResults = await Promise.all(batch.map(async (paper) => {
            const isRelated = await isSpeechAudioRelated(paper);

            if (isRelated) {
                console.log(`[filter] ✓ 相关: ${paper.arxivId} - ${paper.title.substring(0, 40)}...`);
                return paper;
            } else {
                console.log(`[filter] ✗ 过滤: ${paper.arxivId} - ${paper.title.substring(0, 40)}...`);
                return null;
            }
        }));

        for (const paper of batchResults) {
            if (paper) results.push(paper);
        }

        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }

    console.log(`[filter] 筛选完成：${papers.length} → ${results.length} 篇相关论文`);
    return results;
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

        const hasCoreCategory = paper.categories.some(cat => coreCategories.includes(cat));
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
    deduplicatePapers,
    filterPapers,
    filterPapersWithLLM,
    isSpeechAudioRelated,
    filterPapersByKeywords,
    loadPapers,
    savePapers,
    loadAnalyzed,
    saveAnalyzed
};
