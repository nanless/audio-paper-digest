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
const { buildFilterInputSha256 } = require('./lib/filter-input-contract.js');
const {
    KEYWORD_PREFILTER_VERSION,
    evaluateKeywordPrefilter,
    filterPapersByKeywords
} = require('./lib/keyword-prefilter.js');
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
    detectHttpConnectProxyUrl,
    createProxyAgent,
    loadPrompt,
    normalizedId
} = require('./utils.js');
const Config = require('./config.js');
const { createHostTaskScheduler } = require('./lib/fetch-scheduler.js');

loadEnvFile();

function getRandomUserAgent(randomFn = Math.random) {
    const configuredPool = Array.isArray(Config.ARXIV_CONFIG.userAgents)
        ? Config.ARXIV_CONFIG.userAgents.filter(value => typeof value === 'string' && value.trim())
        : [];
    const pool = configuredPool.length > 0
        ? configuredPool
        : [Config.ARXIV_CONFIG.userAgent].filter(Boolean);
    if (pool.length === 0) throw new Error('ARXIV_CONFIG 必须配置至少一个 User-Agent');
    return pool[Math.floor(randomFn() * pool.length) % pool.length];
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

function createRateLimitBudget(options = {}) {
    if (options.rateLimitBudget && typeof options.rateLimitBudget.nextDelay === 'function') {
        return options.rateLimitBudget;
    }
    const configured = Number.isFinite(options.rateLimitMaxWaitMs)
        ? options.rateLimitMaxWaitMs
        : ARXIV_CONFIG.fetchRateLimitMaxWaitMs;
    const configuredTotal = Number.isFinite(options.maxWaitMs)
        ? options.maxWaitMs
        : ARXIV_CONFIG.fetchMaxWaitMs;
    const maxRateLimitWaitMs = Math.max(0, configured);
    const maxWaitMs = Math.max(0, configuredTotal);
    let waitedMs = 0;
    let totalWaitedMs = 0;
    let retryCount = 0;
    let rateLimitRetryCount = 0;
    return {
        nextDelay(baseDelay, jitter, is429) {
            const requested = Math.max(0, baseDelay + jitter);
            const remainingTotal = Math.max(0, maxWaitMs - totalWaitedMs);
            const remainingRateLimit = is429
                ? Math.max(0, maxRateLimitWaitMs - waitedMs)
                : Number.POSITIVE_INFINITY;
            const delay = Math.min(requested, remainingTotal, remainingRateLimit);
            if (requested > 0 && delay <= 0) return { allowed: false, delay: 0 };
            totalWaitedMs += delay;
            retryCount++;
            if (is429) {
                waitedMs += delay;
                rateLimitRetryCount++;
            }
            return { allowed: true, delay };
        },
        get waitedMs() {
            return waitedMs;
        },
        get totalWaitedMs() {
            return totalWaitedMs;
        },
        get retryCount() {
            return retryCount;
        },
        get rateLimitRetryCount() {
            return rateLimitRetryCount;
        }
    };
}

function getFetchRetryDelayMs(attempt, is429) {
    return is429
        ? ARXIV_CONFIG.fetchRateLimitBaseDelayMs * Math.pow(2, attempt - 1)
        : ARXIV_CONFIG.fetchRetryBaseDelayMs * attempt;
}

function makeSourceFetchError(message, sourceHealth) {
    const error = new Error(message);
    error.code = 'SOURCE_FETCH_FAILED';
    error.sourceHealth = sourceHealth;
    return error;
}

function hasRecentResponseSignature(html) {
    const text = String(html || '');
    const hasArxivListContainer = /id=["']dlpage["']/i.test(text)
        || /<dl\b[^>]*id=["']articles["']/i.test(text);
    const hasArxivEntryIdentity = hasArxivListContainer
        || /class=["'][^"']*list-title[^"']*["']/i.test(text);
    const hasPaperEntries = /<dt\b[^>]*>[\s\S]*?\/abs\/(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i.test(text)
        && /<dd\b/i.test(text);
    const hasExplicitEmptyState = /(?:no submissions|no articles|no results)\b/i.test(text);
    return (hasArxivEntryIdentity && hasPaperEntries)
        || (hasArxivListContainer && hasExplicitEmptyState);
}

function hasSearchResponseSignature(html) {
    const text = String(html || '');
    return /<ol[^>]*class=["'][^"']*breathe-horizontal/i.test(text)
        || /<li[^>]*class=["']arxiv-result["']/i.test(text)
        || /(?:no results|sorry, your query)/i.test(text);
}

function hasApiResponseSignature(xml) {
    return /<(?:[a-z]+:)?feed(?:\s|>)/i.test(String(xml || ''));
}

function isStructuralPageFailure(error) {
    const message = String(error?.message || error || '');
    if (/响应缺少 arXiv (?:recent\s*|搜索)页结构签名|(?:recent\s*|搜索)页条目解析不完整/i.test(message)) {
        return true;
    }
    const match = message.match(/HTTP\s+(\d{3})/i);
    if (!match) return false;
    const status = Number(match[1]);
    return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

async function runHostRequest(options, host, task) {
    const scheduler = options?.requestScheduler;
    return scheduler ? scheduler.run(host, task) : task();
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
function httpsRequestWithProxy(
    url,
    headers,
    proxyUrl,
    timeoutMs = ARXIV_CONFIG.fetchTimeoutMs,
    maxResponseBytes = ARXIV_CONFIG.fetchMaxResponseBytes,
    dependencies = {}
) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`arXiv timeoutMs 必须是正整数，收到: ${timeoutMs}`);
    }
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw new Error(`arXiv maxResponseBytes 必须是正整数，收到: ${maxResponseBytes}`);
    }
    return new Promise((resolve, reject) => {
        const https = dependencies.httpsModule || require('https');
        const proxyAgentFactory = dependencies.proxyAgentFactory || createProxyAgent;
        const urlObj = new URL(url);

        if (!proxyUrl) {
            reject(new Error(`arXiv 抓取必须配置 HTTPS_PROXY/HTTP_PROXY 的 HTTP(S) CONNECT 代理，拒绝直连或仅使用 SOCKS ALL_PROXY: ${urlObj.hostname}`));
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
            options.agent = proxyAgentFactory(proxyUrl, urlObj.hostname, 443);
        }

        let settled = false;
        let deadlineTimer = null;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            handler(value);
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            let responseBytes = 0;
            res.on('data', chunk => {
                if (settled) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                responseBytes += buffer.length;
                if (responseBytes > maxResponseBytes) {
                    const error = new Error(`arXiv response exceeds ${maxResponseBytes} byte limit`);
                    error.code = 'ARXIV_RESPONSE_TOO_LARGE';
                    res.destroy?.(error);
                    req.destroy(error);
                    finish(reject, error);
                    return;
                }
                chunks.push(buffer);
            });
            res.on('end', () => {
                finish(resolve, {
                    status: res.statusCode,
                    data: Buffer.concat(chunks).toString('utf8')
                });
            });
            res.on('error', error => finish(reject, error));
        });

        deadlineTimer = setTimeout(() => {
            const error = new Error(`arXiv request deadline exceeded after ${timeoutMs}ms`);
            error.code = 'ARXIV_REQUEST_DEADLINE_EXCEEDED';
            req.destroy(error);
            finish(reject, error);
        }, timeoutMs);

        req.on('error', error => finish(reject, error));
        req.on('timeout', () => {
            const error = new Error(`arXiv request socket timeout after ${timeoutMs}ms`);
            error.code = 'ARXIV_REQUEST_SOCKET_TIMEOUT';
            req.destroy(error);
            finish(reject, error);
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
    const proxyUrl = detectHttpConnectProxyUrl();
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries ?? ARXIV_CONFIG.fetchMaxRetries;
    const rateLimitBudget = createRateLimitBudget(options);
    const initialRateLimitWaitMs = rateLimitBudget.waitedMs;
    const initialTotalRetryWaitMs = rateLimitBudget.totalWaitedMs;
    const health = { source: 'arxiv-search', attempts: 0, successfulRequests: 0, failures: [], coverageComplete: false, rateLimitWaitMs: 0 };

    console.log(`[fetch-web] 尝试从搜索页面获取 ${categoryId}（最多 ${maxResults} 篇）...`);

    for (let page = 0; page < pagesToFetch; page++) {
        const start = page * pageSize;
        // 必须使用 arXiv 的严格分类查询。裸 query=cs.SD 属于全文搜索，会把
        // 无关论文混入前 100 条并可能将真正的分类新论文挤出抓取窗口。
        const categoryQuery = encodeURIComponent(`cat:${categoryId}`);
        const searchUrl = `https://arxiv.org/search/?searchtype=all&query=${categoryQuery}&order=-announced_date_first&start=${start}&size=${pageSize}`;
        let pageSuccess = false;
        let shouldStopPaging = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const headers = getBrowserHeaders();
                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                headers['Referer'] = 'https://arxiv.org/';
                headers['Accept-Language'] = 'en-US,en;q=0.9,zh-CN;q=0.8';

                health.attempts++;
                const response = await runHostRequest(options, 'arxiv.org', () => requestFn(
                    searchUrl,
                    headers,
                    proxyUrl,
                    ARXIV_CONFIG.fetchTimeoutMs,
                    ARXIV_CONFIG.fetchMaxResponseBytes
                ));

                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = response.data;
                if (!hasSearchResponseSignature(html)) throw new Error('响应缺少 arXiv 搜索页结构签名');
                const papers = parseSearchPageHTML(html, categoryId, existingIds);
                const meta = papers._meta || {};
                if (meta.rawItems !== meta.totalFound) throw new Error(`搜索页条目解析不完整 (${meta.totalFound}/${meta.rawItems})`);
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
                    health.coverageComplete = true;
                    break;
                }

                allPapers.push(...papers);
                console.log(`[fetch-web] 第 ${page + 1} 页新增 ${papers.length} 篇，累计 ${allPapers.length} 篇`);
                pageSuccess = true;

                // 如果已有足够论文，停止
                if (allPapers.length >= maxResults) {
                    shouldStopPaging = true;
                    health.coverageComplete = true;
                    break;
                }
                if (meta.rawItems < pageSize) {
                    shouldStopPaging = true;
                    health.coverageComplete = true;
                }
                break; // 成功，跳出重试循环
            } catch (err) {
                if (isStructuralPageFailure(err)) {
                    console.log(`[fetch-web] ${categoryId} 第 ${page + 1} 页结构不可用，立即转入 Atom API fallback: ${err.message}`);
                    health.failures.push({
                        page: page + 1,
                        error: err.message,
                        failureKind: 'structural',
                        fastFallback: true
                    });
                    break;
                }
                const is429 = err.message.includes('429');
                if (attempt < maxRetries) {
                    const baseDelay = getFetchRetryDelayMs(attempt, is429);
                    const jitter = Math.floor(Math.random() * 15000);
                    const retry = rateLimitBudget.nextDelay(baseDelay, jitter, is429);
                    if (!retry.allowed) {
                        console.log(`[fetch-web] ${categoryId} 重试等待预算已耗尽，停止本页重试`);
                        health.failures.push({ page: page + 1, error: `${err.message} (retry wait budget exhausted)` });
                        break;
                    }
                    const delay = retry.delay;
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
    health.rateLimitWaitMs = rateLimitBudget.waitedMs - initialRateLimitWaitMs;
    health.totalRetryWaitMs = rateLimitBudget.totalWaitedMs - initialTotalRetryWaitMs;
    if (health.successfulRequests === pagesToFetch) health.coverageComplete = true;
    health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
    return attachHealth(allPapers.slice(0, maxResults), health);
}

/**
 * 从 arXiv recent 页面抓取论文（支持翻页，最多100篇）
 * recent 页面展示最近几天的论文，限流策略通常比搜索页宽松
 * 翻页：/list/{category}/recent?skip=50&show=50
 */
async function fetchCategoryFromRecentPage(categoryId, existingIds = null, maxResults = 100, options = {}) {
    const proxyUrl = detectHttpConnectProxyUrl();
    const pageSize = 50;
    const pagesToFetch = Math.min(Math.ceil(maxResults / pageSize), 2); // 最多2页100篇
    const allPapers = [];
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries ?? ARXIV_CONFIG.fetchMaxRetries;
    const rateLimitBudget = createRateLimitBudget(options);
    const initialRateLimitWaitMs = rateLimitBudget.waitedMs;
    const initialTotalRetryWaitMs = rateLimitBudget.totalWaitedMs;
    const health = { source: 'arxiv-recent', attempts: 0, successfulRequests: 0, failures: [], coverageComplete: false, rateLimitWaitMs: 0 };

    for (let page = 0; page < pagesToFetch; page++) {
        const skip = page * pageSize;
        const url = `https://arxiv.org/list/${categoryId}/recent?skip=${skip}&show=${pageSize}`;
        let pageSuccess = false;
        let shouldStopPaging = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const headers = getBrowserHeaders();
                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                headers['Referer'] = 'https://arxiv.org/';

                health.attempts++;
                const response = await runHostRequest(options, 'arxiv.org', () => requestFn(
                    url,
                    headers,
                    proxyUrl,
                    ARXIV_CONFIG.fetchTimeoutMs,
                    ARXIV_CONFIG.fetchMaxResponseBytes
                ));

                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = response.data;
                if (!hasRecentResponseSignature(html)) throw new Error('响应缺少 arXiv recent 页结构签名');
                const papers = parseRecentPageHTML(html, categoryId, existingIds);
                const meta = papers._meta || {};
                if (meta.rawItems !== meta.validItems) throw new Error(`recent 页条目解析不完整 (${meta.validItems}/${meta.rawItems})`);
                health.successfulRequests++;

                allPapers.push(...papers);
                console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页获取 ${papers.length} 篇`);
                pageSuccess = true;
                // recent 页的条目数可能因 arXiv 的日期窗口、历史去重或页面
                // 生成方式而少于 pageSize。不能把短页误判为“没有下一页”：
                // 在达到本次配置的页数前，必须继续请求下一个 skip offset，
                // 否则 eess.AS 等类别会永远只检查第一页。
                break;
            } catch (err) {
                if (isStructuralPageFailure(err)) {
                    console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页结构不可用，立即转入严格搜索/API fallback: ${err.message}`);
                    health.failures.push({
                        page: page + 1,
                        error: err.message,
                        failureKind: 'structural',
                        fastFallback: true
                    });
                    break;
                }
                const is429 = err.message.includes('429');
                if (attempt < maxRetries) {
                    const baseDelay = getFetchRetryDelayMs(attempt, is429);
                    const jitter = Math.floor(Math.random() * 10000);
                    const retry = rateLimitBudget.nextDelay(baseDelay, jitter, is429);
                    if (!retry.allowed) {
                        console.log(`[fetch-recent] ${categoryId} 重试等待预算已耗尽，停止本页重试`);
                        health.failures.push({ page: page + 1, error: `${err.message} (retry wait budget exhausted)` });
                        break;
                    }
                    const delay = retry.delay;
                    console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页第 ${attempt} 次失败: ${err.message}，${(delay/1000).toFixed(1)}s 后重试...`);
                    await sleepFn(delay);
                } else {
                    console.log(`[fetch-recent] ${categoryId} 第 ${page + 1} 页失败 (${maxRetries} 次重试): ${err.message}`);
                    health.failures.push({ page: page + 1, error: err.message });
                }
            }
        }

        if (!pageSuccess || shouldStopPaging) break;

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
    health.rateLimitWaitMs = rateLimitBudget.waitedMs - initialRateLimitWaitMs;
    health.totalRetryWaitMs = rateLimitBudget.totalWaitedMs - initialTotalRetryWaitMs;
    health.coverageComplete = health.coverageComplete || health.successfulRequests === pagesToFetch;
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
    let newCount = 0, dupCount = 0, validItems = 0;
    const rawItems = $('dl > dt').length;
    $('dl > dt').each((_, dt) => {
        const $dt = $(dt);
        const $dd = $dt.next('dd');
        const href = $dt.find('a[href^="/abs/"]').first().attr('href') || '';
        const idMatch = href.match(/\/abs\/([^/?#]+)/);
        if (!idMatch || !$dd.length) return;
        validItems++;

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

    papers._meta = { rawItems, validItems, skippedExisting: dupCount };
    return papers;
}

/**
 * 批量补充论文摘要（从 arXiv abs 页面抓取）
 * @param {Array} papers - 论文列表（需要有 arxivId 字段）
 * @param {number} concurrency - 并发数（默认1，避免限流）
 * @returns {Array} 补充了摘要的论文列表
 */
async function fetchAbstracts(papers, concurrency = 1, options = {}) {
    const proxyUrl = detectHttpConnectProxyUrl();
    const needFetch = papers.filter(p => !p.abstract && p.arxivId);
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries ?? ARXIV_CONFIG.fetchMaxRetries;
    const abstractCache = options.abstractCache instanceof Map ? options.abstractCache : new Map();
    // A scheduler guards the real socket-opening operation. Keeping the public
    // concurrency parameter only controls CPU/bookkeeping fan-out; arxiv.org
    // itself never has more than one in-flight abstract request per batch.
    const requestScheduler = options.requestScheduler || createHostTaskScheduler();
    const rateLimitBudget = createRateLimitBudget(options);
    const initialRateLimitWaitMs = rateLimitBudget.waitedMs;
    const initialTotalRetryWaitMs = rateLimitBudget.totalWaitedMs;
    const health = { attempted: 0, fetched: 0, cacheHits: 0, failedIds: [], failures: [], rateLimitWaitMs: 0 };
    if (needFetch.length === 0) return attachHealth(papers, health, '_abstractHealth');

    console.log(`[fetch-abstract] 需要补充 ${needFetch.length} 篇论文摘要...`);
    let fetched = 0;

    for (let i = 0; i < needFetch.length; i += concurrency) {
        const batch = needFetch.slice(i, i + concurrency);
        await Promise.all(batch.map(async (paper) => {
            const paperId = normalizedId(paper) || paper.arxivId;
            const cached = abstractCache.get(paperId);
            if (cached) {
                try {
                    const cachedAbstract = await cached;
                    if (cachedAbstract) {
                        paper.abstract = cachedAbstract;
                        fetched++;
                        health.fetched++;
                        health.cacheHits++;
                        return;
                    }
                } catch {
                    // The owner removes a rejected promise; this caller retries below.
                }
            }

            let lastError = null;
            const ownedPromise = (async () => {
                health.attempted++;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        const url = `https://arxiv.org/abs/${paper.arxivId}`;
                        const headers = getBrowserHeaders();
                        headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                        headers['Referer'] = 'https://arxiv.org/';

                        const response = await requestScheduler.run('arxiv.org', () => requestFn(
                            url,
                            headers,
                            proxyUrl,
                            ARXIV_CONFIG.fetchTimeoutMs,
                            ARXIV_CONFIG.fetchMaxResponseBytes
                        ));
                        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

                        const abstractMatch = response.data.match(/<blockquote\s+class\s*=\s*['"]abstract\s+mathjax['"][^>]*>\s*<span\s+class\s*=\s*['"]descriptor['"]>Abstract:<\/span>\s*([\s\S]*?)\s*<\/blockquote>/i);
                        const abstract = abstractMatch
                            ? abstractMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
                            : '';
                        if (!abstract) throw new Error('响应中缺少非空摘要');
                        return abstract;
                    } catch (err) {
                        lastError = err;
                        const is429 = err.message.includes('429');
                        if (attempt < maxRetries) {
                            const retry = rateLimitBudget.nextDelay(getFetchRetryDelayMs(attempt, is429), 0, is429);
                            if (!retry.allowed) break;
                            await sleepFn(retry.delay);
                        }
                    }
                }
                throw lastError || new Error('unknown error');
            })();
            abstractCache.set(paperId, ownedPromise);
            try {
                paper.abstract = await ownedPromise;
                fetched++;
                health.fetched++;
            } catch (error) {
                lastError = error;
            } finally {
                if (!paper.abstract && abstractCache.get(paperId) === ownedPromise) abstractCache.delete(paperId);
            }
            if (!paper.abstract) {
                health.failedIds.push(paperId);
                health.failures.push({ id: paperId, error: lastError?.message || 'unknown error' });
            }
        }));

        // 批间延迟
        if (i + concurrency < needFetch.length && options.schedulerHandlesPacing !== true) {
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
    health.rateLimitWaitMs = rateLimitBudget.waitedMs - initialRateLimitWaitMs;
    health.totalRetryWaitMs = rateLimitBudget.totalWaitedMs - initialTotalRetryWaitMs;
    return attachHealth(papers, health, '_abstractHealth');
}

/**
 * 解析 arXiv 搜索页面 HTML
 */
function parseSearchPageHTML(html, categoryId, existingIds = null) {
    const papers = [];
    let totalFound = 0;
    let skippedExisting = 0;
    const rawItems = (String(html || '').match(/<li class="arxiv-result">/g) || []).length;

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

    papers._meta = { totalFound, skippedExisting, rawItems };
    return papers;
}

/**
 * 从 arXiv 抓取指定类别的论文
 * 策略：recent → 搜索页 → API，每步获取足够就跳过后续
 */
async function fetchCategoryPapers(categoryId, maxResults = ARXIV_CONFIG.maxResultsPerCategory, retryCount = ARXIV_CONFIG.fetchMaxRetries, existingIds = null, options = {}) {
    console.log(`[fetch] 正在抓取 ${categoryId} 类别的 ${maxResults} 篇论文...`);
    if (!options.requestFn && !detectHttpConnectProxyUrl()) {
        throw new Error('arXiv 抓取必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置的 HTTP(S) CONNECT 代理，拒绝直连或使用仅 SOCKS 的 ALL_PROXY');
    }
    const merged = new Map();
    const seenIds = new Set(existingIds ? Array.from(existingIds) : []);
    const requestFn = options.requestFn || httpsRequestWithProxy;
    const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const requestScheduler = options.requestScheduler || createHostTaskScheduler();
    const categoryRateLimitBudget = createRateLimitBudget(options);
    const perSourceOptions = {
        requestFn,
        sleepFn,
        requestScheduler,
        maxRetries: options.maxRetries ?? retryCount,
        rateLimitMaxWaitMs: options.rateLimitMaxWaitMs,
        maxWaitMs: options.maxWaitMs,
        rateLimitBudget: categoryRateLimitBudget
    };
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
        const abstractFailures = health.abstracts?.failedIds || [];
        const coverageComplete = Object.values(health.methods).some(method => method?.coverageComplete === true);
        health.coverageComplete = coverageComplete;
        health.warnings = coverageComplete ? [...health.failures] : [];
        health.ok = health.successfulRequests > 0
            && coverageComplete
            && abstractFailures.length === 0;
        health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
        health.fetched = result.length;
        health.rateLimitWaitMs = categoryRateLimitBudget.waitedMs;
        health.totalRetryWaitMs = categoryRateLimitBudget.totalWaitedMs;
        health.retryCount = categoryRateLimitBudget.retryCount;
        health.rateLimitRetryCount = categoryRateLimitBudget.rateLimitRetryCount;
        if (health.allFailed) {
            const failureSummary = health.failures.map(item => `${item.method || 'unknown'}:${item.error}`).join('; ');
            throw makeSourceFetchError(`arXiv ${categoryId} 所有抓取请求均失败${failureSummary ? `: ${failureSummary}` : ''}`, health);
        }
        if (!health.ok) {
            const failureSummary = [
                ...health.failures.map(item => `${item.method || 'unknown'}:${item.error}`),
                ...abstractFailures.map(id => `abstract:${id}`)
            ].join('; ');
            throw makeSourceFetchError(`arXiv ${categoryId} 抓取覆盖不完整${failureSummary ? `: ${failureSummary}` : ''}`, health);
        }
        return attachHealth(result, health);
    };

    // 1. 优先用 recent 页面
    let recentPapers = await fetchCategoryFromRecentPage(categoryId, seenIds, maxResults, perSourceOptions);
    absorbHealth('recent', getHealth(recentPapers));

    // 补充摘要（recent 页面不包含摘要）
    if (recentPapers.length > 0) {
        recentPapers = await fetchAbstracts(recentPapers, 5, {
            requestFn,
            sleepFn,
            maxRetries: options.abstractMaxRetries ?? retryCount,
            rateLimitBudget: categoryRateLimitBudget,
            requestScheduler,
            schedulerHandlesPacing: options.schedulerHandlesPacing,
            abstractCache: options.abstractCache
        });
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
    const proxyUrl = detectHttpConnectProxyUrl();
    const apiHealth = { source: 'arxiv-api', attempts: 0, successfulRequests: 0, failures: [], coverageComplete: false };
    let apiLastError = null;
    const rateLimitBudget = categoryRateLimitBudget;
    const initialApiRateLimitWaitMs = rateLimitBudget.waitedMs;
    const initialApiTotalRetryWaitMs = rateLimitBudget.totalWaitedMs;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
        const headers = getBrowserHeaders();
        headers['Referer'] = 'https://arxiv.org/';

        try {
            apiHealth.attempts++;
            const response = await requestScheduler.run('export.arxiv.org', () => requestFn(
                url,
                headers,
                proxyUrl,
                ARXIV_CONFIG.fetchTimeoutMs,
                ARXIV_CONFIG.fetchMaxResponseBytes
            ));

            if (response.status === 200) {
                const xml = response.data;
                if (!hasApiResponseSignature(xml)) throw new Error('响应缺少 arXiv Atom feed 结构签名');
                const apiPapers = parseArxivXML(xml, categoryId, seenIds, { stopAtConsecutiveExisting: false });
                const apiMeta = apiPapers._meta || {};
                if (apiMeta.entryCount !== apiMeta.legalEntryCount) {
                    throw new Error(`Atom feed 条目解析不完整 (${apiMeta.legalEntryCount}/${apiMeta.entryCount})`);
                }
                apiHealth.successfulRequests++;
                apiHealth.coverageComplete = true;

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
            if (attempt === retryCount) break;
            const is429 = err.message.includes('429');
            const baseDelay = getFetchRetryDelayMs(attempt, is429);
            const jitter = Math.floor(Math.random() * 10000);
            const retry = rateLimitBudget.nextDelay(baseDelay, jitter, is429);
            if (!retry.allowed) {
                console.log(`[fetch] ${categoryId} API 重试等待预算已耗尽，停止重试`);
                break;
            }
            const delay = retry.delay;
            console.log(`[fetch] ${categoryId} API 第 ${attempt} 次失败: ${err.message}，${(delay/1000).toFixed(0)}s 后重试...`);
            await sleepFn(delay);
        }
    }
    if (apiHealth.successfulRequests === 0 && apiLastError) {
        apiHealth.failures.push({ error: apiLastError.message });
    }
    apiHealth.ok = apiHealth.successfulRequests > 0;
    apiHealth.rateLimitWaitMs = rateLimitBudget.waitedMs - initialApiRateLimitWaitMs;
    apiHealth.totalRetryWaitMs = rateLimitBudget.totalWaitedMs - initialApiTotalRetryWaitMs;
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
    let legalEntryCount = 0;
    let stoppedAtConsecutive = false;

    while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        entryCount++;

        const idMatch = entry.match(/<id>(.*?)<\/id>/);
        if (!idMatch) continue;
        legalEntryCount++;
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

    papers._meta = { entryCount, legalEntryCount, stoppedAtConsecutive };
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
        // Reasoning models may spend most of a tiny budget on hidden deliberation
        // before emitting the requested one-line conclusion.  Keep the output
        // contract strict, but give the recovery call enough room to reach it.
        const repairedText = await requestFn([{ role: 'user', content: repairPrompt }], 2048);
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
        const response = await callModelForFilter([{ role: 'user', content: prompt }], FILTER_CFG.maxTokens);
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
        useKeywordPreFilter = FILTER_CFG.keywordPrefilterEnabled,
        initialDecisions = null,
        onBatchComplete = null,
        decisionFn = getSpeechAudioDecision,
        decisionMetadata = {}
    } = options;

    console.log(`[filter] 开始筛选 ${papers.length} 篇论文（关键词预筛 → 大模型复筛）...`);

    let papersToCheck = papers;
    const keywordDecisions = new Map();

    if (useKeywordPreFilter) {
        const evaluated = papers.map(paper => ({ paper, result: evaluateKeywordPrefilter(paper) }));
        papersToCheck = evaluated.filter(item => item.result.pass).map(item => item.paper);
        for (const { paper, result } of evaluated) {
            if (result.pass) continue;
            const paperId = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
            keywordDecisions.set(paperId, {
                id: paperId,
                paper_id: paper.paper_id || paper.arxivId || paper.id || paperId,
                title: paper.title || '',
                related: false,
                reason: result.reason,
                rawResponse: '',
                parseSource: 'keyword_prefilter',
                error: null,
                fallback: false,
                retryable: false,
                decidedAt: getBeijingISOString(),
                inputSha256: buildFilterInputSha256(paper),
                keywordPrefilterVersion: result.version,
                keywordMatchedGroups: result.matchedGroups,
                keywordMatchedKeywords: result.matchedKeywords,
                keywordCategoryFallback: result.categoryFallback,
                keywordFailOpen: result.failOpen,
                ...decisionMetadata
            });
        }
        console.log(`[filter] 关键词预筛 v${KEYWORD_PREFILTER_VERSION}：${papers.length} 篇 → ${papersToCheck.length} 篇交给 LLM，确定性排除 ${keywordDecisions.size} 篇`);
    } else {
        console.log('[filter] 关键词预筛已禁用：全部候选交给 LLM');
    }

    const decisions = new Map();
    const retryableDecisions = new Map();
    const currentPaperIds = new Set(papers
        .map(paper => normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '')
        .filter(Boolean));
    const paperById = new Map(papers.map(paper => [normalizedId(paper), paper]));
    const loadDecision = (id, decision) => {
        const key = normalizedId(id);
        if (!key || !decision || typeof decision.related !== 'boolean' || decision.retryable || decision.fallback) return;
        if (!currentPaperIds.has(key)) return;
        if (decision.inputSha256 !== buildFilterInputSha256(paperById.get(key))) return;
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
    // 关键词排除是当前词表下的正式决定；它覆盖旧的 LLM 决定。词表/开关变化
    // 由上层 filterConfigFingerprint 负责使整批缓存失效。
    for (const [id, decision] of keywordDecisions) decisions.set(id, decision);

    const getFilteredFromDecisions = () => papers.filter(paper => {
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

    if (batches.length === 0 && typeof onBatchComplete === 'function') {
        await onBatchComplete({
            batchIndex: -1,
            totalBatches: 0,
            batchResults: [],
            results: getFilteredFromDecisions(),
            decisions: Object.fromEntries(decisions),
            retryableDecisions: {},
            stats: {
                totalCandidates: papers.length,
                llmCandidates: papersToCheck.length,
                keywordRejected: keywordDecisions.size,
                decided: decisions.size,
                retryable: 0,
                complete: decisions.size === papers.length
            }
        });
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`[filter] 处理批次 ${batchIndex + 1}/${batches.length}...`);

        const settled = await Promise.allSettled(batch.map(async (paper) => {
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
                inputSha256: buildFilterInputSha256(paper),
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
        const batchResults = settled.map((result, index) => {
            if (result.status === 'fulfilled') return result.value;
            const paper = batch[index];
            const paperId = normalizedId(paper) || paper.arxivId || paper.paper_id || paper.id || '';
            const decision = {
                id: paperId,
                paper_id: paper.paper_id || paper.arxivId || paper.id || paperId,
                title: paper.title || '',
                related: null,
                reason: `筛选调用异常，等待重试: ${result.reason?.message || result.reason}`,
                rawResponse: '',
                parseSource: 'batch_exception_retryable',
                error: result.reason?.message || String(result.reason),
                fallback: true,
                retryable: true,
                decidedAt: getBeijingISOString(),
                inputSha256: buildFilterInputSha256(paper),
                ...decisionMetadata
            };
            retryableDecisions.set(paperId, decision);
            console.error(`[filter] ↻ ${paperId} 调用抛出异常，已保留同批其他决定并标记待重试: ${decision.error}`);
            return decision;
        });

        if (typeof onBatchComplete === 'function') {
            await onBatchComplete({
                batchIndex,
                totalBatches: batches.length,
                batchResults,
                results: getFilteredFromDecisions(),
                decisions: Object.fromEntries(decisions),
                retryableDecisions: Object.fromEntries(retryableDecisions),
                stats: {
                    totalCandidates: papers.length,
                    llmCandidates: papersToCheck.length,
                    keywordRejected: keywordDecisions.size,
                    decided: decisions.size,
                    retryable: retryableDecisions.size,
                    complete: decisions.size === papers.length && retryableDecisions.size === 0
                }
            });
        }

        const rejected = settled.find(result => result.status === 'rejected');
        if (rejected) {
            throw new Error(`筛选批次存在未处理异常；同批成功决定已保存，停止后续调用: ${rejected.reason?.message || rejected.reason}`);
        }

        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }

    const results = getFilteredFromDecisions();
    const filterStats = {
        totalCandidates: papers.length,
        llmCandidates: papersToCheck.length,
        keywordRejected: keywordDecisions.size,
        decided: decisions.size,
        retryable: retryableDecisions.size,
        retryableIds: Array.from(retryableDecisions.keys()),
        complete: decisions.size === papers.length && retryableDecisions.size === 0
    };
    console.log(`[filter] 筛选阶段结束：${papers.length} 篇候选，关键词排除 ${keywordDecisions.size} 篇，LLM 候选 ${papersToCheck.length} 篇，明确决定 ${decisions.size} 篇，待重试 ${retryableDecisions.size} 篇，相关 ${results.length} 篇`);
    return attachHealth(results, filterStats, '_filterStats');
}

const filterPapers = filterPapersWithLLM;

module.exports = {
    CATEGORIES,
    fetchCategoryPapers,
    httpsRequestWithProxy,
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
    hasRecentResponseSignature,
    hasSearchResponseSignature,
    hasApiResponseSignature,
    isStructuralPageFailure,
    getRandomUserAgent,
    getBrowserHeaders,
    getFetchRetryDelayMs,
    redactProxyUrl,
    isSpeechAudioRelated,
    getSpeechAudioDecision,
    evaluateKeywordPrefilter,
    filterPapersByKeywords,
    buildFilterInputSha256,
    loadPapers,
    savePapers,
    loadAnalyzed,
    saveAnalyzed
};
