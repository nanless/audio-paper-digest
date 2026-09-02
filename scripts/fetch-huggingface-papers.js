#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 从 HuggingFace Papers 获取过去一周的论文
 * 
 * API 说明：
 * - /api/daily_papers?limit=100  返回精选每日论文（含 ai_summary, githubRepo, upvotes 等丰富数据）
 *   最大 limit=100，支持 offset 分页
 * - /api/papers?limit=100        返回最新论文（含 upvotes, authors, summary）
 *   覆盖最近 1-2 天，用于补充 daily_papers 未收录的新论文
 * 
 * 策略：分页获取 daily_papers 直到覆盖一周，再用 papers 补充最近 1-2 天
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildChildProcessEnv } = require('./env-loader.js');

const { getBeijingDateString, getBeijingISOString, normalizeToBeijingISOString, normalizedId, detectProxyUrl } = require('./utils.js');
const { HUGGINGFACE_CONFIG } = require('./config.js');

/**
 * 使用 curl 获取数据
 */
function parseProxyCredentials(proxyUrl) {
    let parsed;
    try {
        parsed = new URL(proxyUrl);
    } catch {
        throw new Error('invalid project proxy URL');
    }
    const hasCredentials = Boolean(parsed.username || parsed.password);
    const encodedUsername = parsed.username;
    const encodedPassword = parsed.password;
    const decode = value => {
        try {
            return decodeURIComponent(value);
        } catch {
            throw new Error('invalid percent-encoding in project proxy credentials');
        }
    };
    const username = decode(parsed.username);
    const password = decode(parsed.password);
    parsed.username = '';
    parsed.password = '';
    return {
        hasCredentials,
        username,
        password,
        encodedUsername,
        encodedPassword,
        sanitizedUrl: parsed.toString()
    };
}

function quoteCurlConfigValue(value) {
    const text = String(value);
    if (/\r|\n|\0/.test(text)) {
        throw new Error('project proxy credentials contain forbidden control characters');
    }
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildCurlArgs(proxyUrl, url, timeout, options = {}) {
    const proxy = parseProxyCredentials(proxyUrl);
    if (proxy.hasCredentials && !options.proxyConfigPath) {
        throw new Error('credentialed project proxy requires a private curl config');
    }
    const proxyArgs = options.proxyConfigPath
        ? ['--config', options.proxyConfigPath]
        : ['--proxy', proxyUrl];
    return [
        // curl only honors -q/--disable before every other option.  Keep it
        // first so a user-level ~/.curlrc cannot inject credentials, cookies,
        // proxies or output settings into this minimal subprocess.
        '-q', '-s', '-f', '-L',
        ...proxyArgs,
        '--noproxy', '',
        '--max-time', String(timeout),
        url
    ];
}

function prepareCurlInvocation(proxyUrl, url, timeout, options = {}) {
    const proxy = parseProxyCredentials(proxyUrl);
    if (!proxy.hasCredentials) {
        return {
            args: buildCurlArgs(proxyUrl, url, timeout),
            configPath: null,
            cleanup() {}
        };
    }

    const tempRoot = options.tempRoot || os.tmpdir();
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'paper-digest-hf-curl-'));
    const configPath = path.join(tempDir, 'proxy.conf');
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        fs.rmSync(tempDir, { recursive: true, force: true });
    };

    try {
        const config = [
            `proxy = ${quoteCurlConfigValue(proxy.sanitizedUrl)}`,
            `proxy-user = ${quoteCurlConfigValue(`${proxy.username}:${proxy.password}`)}`,
            ''
        ].join('\n');
        fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(configPath, 0o600);
        return {
            args: buildCurlArgs(proxyUrl, url, timeout, { proxyConfigPath: configPath }),
            configPath,
            cleanup
        };
    } catch (error) {
        cleanup();
        throw error;
    }
}

function redactProxySecrets(message, proxyUrl) {
    let redacted = String(message || '');
    let proxy;
    try {
        proxy = parseProxyCredentials(proxyUrl);
    } catch {
        return redacted.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
    }
    const candidates = [
        String(proxyUrl),
        `${proxy.username}:${proxy.password}`,
        `${proxy.encodedUsername}:${proxy.encodedPassword}`,
        proxy.username,
        proxy.password,
        proxy.encodedUsername,
        proxy.encodedPassword
    ].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of candidates) {
        redacted = redacted.split(secret).join('***');
    }
    return redacted.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

async function fetchWithCurl(url, timeout = 60, options = {}) {
    const execFileFn = options.execFileFn || execFile;
    const proxyUrl = options.proxyUrl || detectProxyUrl();
    if (!proxyUrl) {
        return { ok: false, data: null, error: 'missing project proxy' };
    }

    let invocation = null;
    try {
        invocation = prepareCurlInvocation(proxyUrl, url, timeout, options);
        const result = await new Promise((resolve, reject) => {
            try {
                execFileFn('curl', invocation.args, {
                    encoding: 'utf8',
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: Math.max(1000, Math.ceil(timeout * 1000) + 5000),
                    killSignal: 'SIGKILL',
                    env: buildChildProcessEnv({
                        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '',
                        http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: ''
                    })
                }, (error, stdout, stderr) => {
                    if (error) {
                        const detail = String(stderr || '').trim() || error.message || 'curl failed';
                        const safeError = new Error(redactProxySecrets(detail, proxyUrl));
                        safeError.code = error.code;
                        reject(safeError);
                    } else {
                        resolve(stdout);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });

        if (!result || result.trim() === '') {
            return { ok: false, data: null, error: 'empty response' };
        }

        return { ok: true, data: JSON.parse(result), error: null };
    } catch (e) {
        const safeMessage = redactProxySecrets(e?.message || String(e), proxyUrl);
        if (Number(e.code) === 22) {
            // curl --fail returns exit code 22 for HTTP errors (4xx, 5xx)
            console.error(`  HTTP 请求失败 (${url}): ${safeMessage.substring(0, 100)}`);
        } else if (safeMessage.includes('Unexpected token')) {
            console.error(`  JSON 解析失败 (${url}): 响应不是有效的 JSON`);
        } else {
            console.error(`  请求失败 (${url}): ${safeMessage.substring(0, 100)}`);
        }
        return { ok: false, data: null, error: safeMessage };
    } finally {
        invocation?.cleanup();
    }
}

function attachSourceHealth(items, health) {
    Object.defineProperty(items, '_sourceHealth', {
        value: health,
        enumerable: false,
        configurable: true
    });
    return items;
}

function makeSourceFetchError(message, sourceHealth) {
    const error = new Error(message);
    error.code = 'SOURCE_FETCH_FAILED';
    error.sourceHealth = sourceHealth;
    return error;
}

/**
 * 将 daily_papers 格式转为标准格式
 */
function convertDailyPaper(hfPaper, options = {}) {
    if (!hfPaper || typeof hfPaper !== 'object') return null;
    const paper = (hfPaper.paper !== undefined && hfPaper.paper !== null) ? hfPaper.paper : hfPaper;
    if (!paper || typeof paper !== 'object') return null;
    const arxivId = paper.id;
    if (!arxivId) return null;

    const authors = (paper.authors || []).map(a => a.name).filter(Boolean);

    const publishedAt = normalizeToBeijingISOString(paper.publishedAt || hfPaper.publishedAt || '');
    const selectedAt = normalizeToBeijingISOString(
        hfPaper.publishedAt || hfPaper.date || hfPaper.createdAt || paper.publishedAt || ''
    );
    if (!publishedAt) {
        console.warn(`  ⚠️  跳过 HuggingFace 论文 ${arxivId}: 缺少有效 publishedAt`);
        return null;
    }
    return {
        paper_id: arxivId,
        arxivId: arxivId,
        title: paper.title || hfPaper.title || '',
        authors: authors,
        summary: paper.summary || hfPaper.summary || '',
        abstract: paper.summary || hfPaper.summary || '',
        published: publishedAt,
        hfSelectedAt: selectedAt || publishedAt,
        updatedDate: publishedAt.split('T')[0] || '',
        categories: [],
        primaryCategory: '',
        pdfLink: `https://arxiv.org/pdf/${arxivId}`,
        absLink: `https://arxiv.org/abs/${arxivId}`,
        comment: '',
        journal_ref: '',
        doi: '',
        // HuggingFace 特有字段
        hf_upvotes: paper.upvotes || 0,
        hf_ai_summary: paper.ai_summary || '',
        hf_ai_keywords: paper.ai_keywords || [],
        hf_github_repo: paper.githubRepo || '',
        hf_project_page: paper.projectPage || '',
        hf_github_stars: paper.githubStars || 0,
        hf_discussion_id: paper.discussionId || '',
        fetchedFrom: 'huggingface',
        fetchedAt: options.fetchedAt || getBeijingISOString(),
        source: 'huggingface'
    };
}

/**
 * 将 papers API 格式转为标准格式
 */
function convertPaper(paper, options = {}) {
    const arxivId = paper.id;
    if (!arxivId) return null;

    const authors = (paper.authors || []).map(a => a.name).filter(Boolean);

    const publishedAt = normalizeToBeijingISOString(paper.publishedAt || '');
    if (!publishedAt) {
        console.warn(`  ⚠️  跳过 HuggingFace 论文 ${arxivId}: 缺少有效 publishedAt`);
        return null;
    }
    return {
        paper_id: arxivId,
        arxivId: arxivId,
        title: paper.title || '',
        authors: authors,
        summary: paper.summary || '',
        abstract: paper.summary || '',
        published: publishedAt,
        updatedDate: publishedAt.split('T')[0] || '',
        categories: [],
        primaryCategory: '',
        pdfLink: `https://arxiv.org/pdf/${arxivId}`,
        absLink: `https://arxiv.org/abs/${arxivId}`,
        comment: '',
        journal_ref: '',
        doi: '',
        // HuggingFace 特有字段
        hf_upvotes: paper.upvotes || 0,
        hf_ai_summary: paper.ai_summary || '',
        hf_ai_keywords: [],
        hf_github_repo: '',
        hf_project_page: '',
        hf_github_stars: 0,
        hf_discussion_id: '',
        fetchedFrom: 'huggingface',
        fetchedAt: options.fetchedAt || getBeijingISOString(),
        source: 'huggingface'
    };
}

/**
 * 从 HuggingFace 获取过去 N 天的论文
 */
async function fetchHuggingFacePapers(existingIds = new Set(), options = {}) {
    const {
        days = HUGGINGFACE_CONFIG.defaultDays,
        minUpvotes = HUGGINGFACE_CONFIG.defaultMinUpvotes,
        fetchFn = fetchWithCurl,
        sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
        fetchedAt = getBeijingISOString()
    } = options;

    if (fetchFn === fetchWithCurl && !detectProxyUrl()) {
        throw new Error('HuggingFace 抓取必须通过当前项目 .env 中的 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，拒绝直连');
    }

    const cutoffStr = getBeijingDateString(days);

    console.log(`📥 从 HuggingFace Papers 获取过去 ${days} 天的论文 (>= ${cutoffStr})...`);

    const merged = new Map(); // paper_id -> paper
    const health = {
        source: 'huggingface',
        attempts: 0,
        successfulRequests: 0,
        failures: [],
        requests: []
    };
    const fetchTracked = async (name, url) => {
        health.attempts++;
        let rawResult;
        try {
            rawResult = await fetchFn(url);
        } catch (error) {
            rawResult = { ok: false, data: null, error: error?.message || String(error) };
        }
        const result = rawResult && typeof rawResult.ok === 'boolean'
            ? rawResult
            : { ok: rawResult !== null && rawResult !== undefined, data: rawResult, error: rawResult == null ? 'empty response' : null };
        health.requests.push({ name, ok: result.ok });
        if (result.ok) {
            health.successfulRequests++;
        } else {
            health.failures.push({ name, error: result.error || 'unknown error' });
        }
        return result;
    };

    // ====== 1. 获取 daily_papers（分页，含丰富数据）======
    console.log(`\n  📰 获取 daily_papers（精选每日论文）...`);
    let page = 0;
    let reachedCutoff = false;
    let dailyComplete = false;

    while (!reachedCutoff && page < HUGGINGFACE_CONFIG.maxPages) {
        const offset = page * HUGGINGFACE_CONFIG.pageLimit;
        const url = `https://huggingface.co/api/daily_papers?limit=${HUGGINGFACE_CONFIG.pageLimit}&offset=${offset}`;
        const response = await fetchTracked(`daily_papers:${page + 1}`, url);
        const data = response.data;

        if (!response.ok) {
            console.log(`  页${page + 1}: 请求失败，停止 daily_papers 分页`);
            break;
        }
        if (!Array.isArray(data)) {
            health.failures.push({ name: `daily_papers:${page + 1}`, error: 'response is not an array' });
            health.successfulRequests--;
            health.requests[health.requests.length - 1].ok = false;
            console.log(`  页${page + 1}: 响应格式错误，停止`);
            break;
        }
        if (data.length === 0) {
            dailyComplete = true;
            console.log(`  页${page + 1}: 无数据，停止`);
            break;
        }

        let newCount = 0;
        let oldestDate = null;
        let legalItems = 0;

        for (const item of data) {
            if (typeof item !== 'object' || !item) continue;

            const paper = convertDailyPaper(item, { fetchedAt });
            if (!paper) continue;
            legalItems++;

            // 记录最老日期
            // daily_papers 的分页顺序按 HuggingFace 入选日期，而非 arXiv 原始发布日期。
            const pubDate = (paper.hfSelectedAt || paper.published).split('T')[0];
            if (pubDate && (!oldestDate || pubDate < oldestDate)) {
                oldestDate = pubDate;
            }

            // 只保留一周内的
            if (pubDate && pubDate < cutoffStr) continue;

            // 去重
            const key = normalizedId(paper);
            if (key && !merged.has(key)) {
                merged.set(key, paper);
                newCount++;
            }
        }

        if (legalItems !== data.length) {
            health.failures.push({ name: `daily_papers:${page + 1}`, error: `response contains invalid paper items (${legalItems}/${data.length})` });
            health.successfulRequests--;
            health.requests[health.requests.length - 1].ok = false;
            console.log(`  页${page + 1}: 响应包含非法论文条目，停止`);
            break;
        }

        console.log(`  页${page + 1}: ${data.length}篇, 新增${newCount}篇, 最早: ${oldestDate || '?'}`);

        // 如果最老日期已经超过截止线，停止分页
        if (oldestDate && oldestDate < cutoffStr) {
            reachedCutoff = true;
            dailyComplete = true;
        }

        // 如果返回的数据不足 100 篇，说明没有更多了
        if (data.length < HUGGINGFACE_CONFIG.pageLimit) {
            dailyComplete = true;
            break;
        }

        page++;
        // 延迟避免请求过快
        await sleepFn(HUGGINGFACE_CONFIG.pageDelayMs);
    }

    console.log(`  daily_papers 共获取: ${merged.size} 篇`);

    // ====== 2. 获取 papers API（补充最近1-2天的新论文）======
    console.log(`\n  📰 获取 papers API（最新论文补充）...`);
    let papersPage = 0;
    let papersComplete = false;
    const seenPapersPageSignatures = new Set();
    while (!papersComplete && papersPage < HUGGINGFACE_CONFIG.maxPages) {
        const offset = papersPage * HUGGINGFACE_CONFIG.pageLimit;
        const papersResponse = await fetchTracked(`papers:${papersPage + 1}`, `https://huggingface.co/api/papers?limit=${HUGGINGFACE_CONFIG.pageLimit}&offset=${offset}`);
        const papersData = papersResponse.data;
        if (!papersResponse.ok || !Array.isArray(papersData)) {
            if (papersResponse.ok) {
                health.failures.push({ name: `papers:${papersPage + 1}`, error: 'response is not an array' });
                health.successfulRequests--;
                health.requests[health.requests.length - 1].ok = false;
            }
            break;
        }
        if (papersData.length === 0) {
            papersComplete = true;
            break;
        }
        const pageSignature = papersData
            .map(item => String(item?.id || ''))
            .join('\n');
        if (seenPapersPageSignatures.has(pageSignature)) {
            // HuggingFace /api/papers currently may ignore offset and repeat page 1.
            // A byte-equivalent ordered ID page is an endpoint exhaustion signal;
            // daily_papers remains the authoritative seven-day coverage source.
            papersComplete = true;
            console.log(`  papers API 页${papersPage + 1}: 与前页完全重复，判定分页已穷尽`);
            break;
        }
        seenPapersPageSignatures.add(pageSignature);
        let newCount = 0;
        let legalItems = 0;
        let oldestDate = null;
        for (const item of papersData) {
            if (typeof item !== 'object' || !item) continue;

            const paper = convertPaper(item, { fetchedAt });
            if (!paper) continue;
            legalItems++;

            const pubDate = paper.published.split('T')[0];
            if (!oldestDate || pubDate < oldestDate) oldestDate = pubDate;
            if (pubDate && pubDate < cutoffStr) continue;

            const key = normalizedId(paper);
            if (key && !merged.has(key)) {
                merged.set(key, paper);
                newCount++;
            } else if (key) {
                // 如果已存在但 papers API 有 upvotes 信息，更新
                const existing = merged.get(key);
                if (paper.hf_upvotes > 0 && existing.hf_upvotes === 0) {
                    existing.hf_upvotes = paper.hf_upvotes;
                }
            }
        }
        if (legalItems !== papersData.length) {
            health.failures.push({ name: `papers:${papersPage + 1}`, error: `response contains invalid paper items (${legalItems}/${papersData.length})` });
            health.successfulRequests--;
            health.requests[health.requests.length - 1].ok = false;
            break;
        }
        console.log(`  papers API 页${papersPage + 1}: ${papersData.length}篇，新增 ${newCount} 篇`);
        if (papersData.length < HUGGINGFACE_CONFIG.pageLimit || (oldestDate && oldestDate < cutoffStr)) {
            papersComplete = true;
            break;
        }
        papersPage++;
        await sleepFn(HUGGINGFACE_CONFIG.pageDelayMs);
    }
    health.coverage = { dailyComplete, papersComplete, reachedCutoff };
    health.ok = dailyComplete && papersComplete && health.failures.length === 0;
    health.allFailed = health.attempts > 0 && health.successfulRequests === 0;
    if (health.allFailed) {
        const summary = health.failures.map(item => `${item.name}:${item.error}`).join('; ');
        throw makeSourceFetchError(`HuggingFace 所有抓取请求均失败${summary ? `: ${summary}` : ''}`, health);
    }
    if (!health.ok) {
        const summary = health.failures.map(item => `${item.name}:${item.error}`).join('; ');
        throw makeSourceFetchError(`HuggingFace 抓取覆盖不完整${summary ? `: ${summary}` : ''}`, health);
    }

    // ====== 3. 过滤和排序 ======
    let papers = Array.from(merged.values());

    // 过滤 upvotes
    if (minUpvotes > 0) {
        const before = papers.length;
        papers = papers.filter(p => p.hf_upvotes >= minUpvotes);
        console.log(`  upvotes >= ${minUpvotes} 过滤: ${before} → ${papers.length} 篇`);
    }

    // 排除已有论文（历史 papers.json + 博客已发布）。同批 arXiv 重叠保留给后续合并，避免丢失 HF 元数据。
    if (existingIds.size > 0) {
        const before = papers.length;
        const dupPapers = papers.filter(p => existingIds.has(normalizedId(p.paper_id)));
        const newPapers = papers.filter(p => !existingIds.has(normalizedId(p.paper_id)));

        // 详细打印被去重的论文
        if (dupPapers.length > 0) {
            console.log(`\n  去重详情（排除 ${dupPapers.length} 篇已存在论文）:`);
            for (const p of dupPapers) {
                console.log(`    ✗ ${p.paper_id} - ${(p.title || '').substring(0, 60)} (${p.published?.split('T')[0]})`);
            }
        }

        // 详细打印新论文
        if (newPapers.length > 0) {
            console.log(`\n  新增论文 (${newPapers.length} 篇):`);
            for (const p of newPapers) {
                console.log(`    ✓ ${p.paper_id} - ${(p.title || '').substring(0, 60)} (↑${p.hf_upvotes})`);
            }
        }

        papers = newPapers;
        console.log(`\n  排除已有论文: ${before} → ${papers.length} 篇`);
    }

    // 按 upvotes 降序排列
    papers.sort((a, b) => b.hf_upvotes - a.hf_upvotes);

    // 统计
    const dateCounts = {};
    for (const p of papers) {
        const d = p.published.split('T')[0];
        dateCounts[d] = (dateCounts[d] || 0) + 1;
    }

    console.log(`\n  ✅ 最终获取: ${papers.length} 篇 HuggingFace 论文`);
    console.log(`  📅 日期分布:`);
    for (const d of Object.keys(dateCounts).sort()) {
        console.log(`    ${d}: ${dateCounts[d]} 篇`);
    }

    health.fetched = papers.length;
    return attachSourceHealth(papers, health);
}

/**
 * 合并并去重 arxiv 和 HuggingFace 论文
 */
function mergeAndDeduplicate(arxivPapers, hfPapers) {
    const merged = new Map();
    let mergedCount = 0, hfOnlyCount = 0;

    // 先添加 arxiv 论文（优先级更高）
    for (const paper of arxivPapers) {
        const id = normalizedId(paper);
        if (id) {
            merged.set(id, { ...paper, sources: ['arxiv'] });
        }
    }

    // 再添加 HuggingFace 论文
    for (const paper of hfPapers) {
        const id = normalizedId(paper);
        if (!id) continue;

        if (merged.has(id)) {
            // 合并 HF 特有信息
            const existing = merged.get(id);
            const sourceSet = new Set([...(existing.sources || []), 'huggingface']);
            existing.sources = Array.from(sourceSet);
            existing.hf_upvotes = paper.hf_upvotes;
            existing.hf_ai_summary = paper.hf_ai_summary;
            existing.hf_ai_keywords = paper.hf_ai_keywords;
            existing.hf_github_repo = paper.hf_github_repo;
            existing.hf_project_page = paper.hf_project_page;
            existing.hf_github_stars = paper.hf_github_stars;
            existing.hf_discussion_id = paper.hf_discussion_id;

            if (!existing.summary && paper.summary) {
                existing.summary = paper.summary;
            }
            mergedCount++;
            console.log(`    ⟳ ${id} - arxiv+HuggingFace 合并 (↑${paper.hf_upvotes})`);
        } else {
            merged.set(id, { ...paper, sources: ['huggingface'] });
            hfOnlyCount++;
            console.log(`    ✓ ${id} - ${(paper.title || '').substring(0, 60)} (↑${paper.hf_upvotes}) [仅HF]`);
        }
    }

    console.log(`\n  合并统计: arxiv+HF ${mergedCount} 篇, 仅HF ${hfOnlyCount} 篇, 合并后总计 ${merged.size} 篇`);

    return Array.from(merged.values());
}

// 导出
module.exports = {
    fetchHuggingFacePapers,
    fetchWithCurl,
    buildCurlArgs,
    prepareCurlInvocation,
    redactProxySecrets,
    mergeAndDeduplicate,
    convertDailyPaper,
    convertPaper
};

// 直接运行时执行测试
if (require.main === module) {
    (async () => {
        console.log('=== HuggingFace Papers 抓取测试 ===\n');

        const papers = await fetchHuggingFacePapers(new Set(), { days: 7 });

        console.log('\n=== 前 10 篇热门论文 ===');
        for (const paper of papers.slice(0, 10)) {
            console.log(`\n📄 ${paper.title}`);
            console.log(`   ID: ${paper.paper_id}`);
            console.log(`   日期: ${paper.published.split('T')[0]}`);
            console.log(`   Upvotes: ${paper.hf_upvotes}`);
            console.log(`   作者: ${paper.authors.slice(0, 3).join(', ')}`);
            if (paper.hf_github_repo) console.log(`   GitHub: ${paper.hf_github_repo}`);
            if (paper.hf_ai_summary) console.log(`   AI摘要: ${paper.hf_ai_summary.substring(0, 80)}...`);
        }

        console.log(`\n总计: ${papers.length} 篇论文`);
    })();
}
