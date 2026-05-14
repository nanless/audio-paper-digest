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

const { execFileSync } = require('child_process');

const { getBeijingDateString, getBeijingISOString, normalizeToBeijingISOString, normalizedId } = require('./utils.js');
const { HUGGINGFACE_CONFIG } = require('./config.js');

/**
 * 使用 curl 获取数据
 */
function fetchWithCurl(url, timeout = 60) {
    try {
        const result = execFileSync('curl', ['-s', '-f', '-L', '--max-time', String(timeout), url], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });

        if (!result || result.trim() === '') {
            return null;
        }

        return JSON.parse(result);
    } catch (e) {
        if (e.status === 22) {
            // curl --fail returns exit code 22 for HTTP errors (4xx, 5xx)
            console.error(`  HTTP 请求失败 (${url}): ${e.message.substring(0, 100)}`);
        } else if (e.message && e.message.includes('Unexpected token')) {
            console.error(`  JSON 解析失败 (${url}): 响应不是有效的 JSON`);
        } else {
            console.error(`  请求失败 (${url}): ${e.message.substring(0, 100)}`);
        }
        return null;
    }
}

/**
 * 将 daily_papers 格式转为标准格式
 */
function convertDailyPaper(hfPaper) {
    if (!hfPaper || typeof hfPaper !== 'object') return null;
    const paper = (hfPaper.paper !== undefined && hfPaper.paper !== null) ? hfPaper.paper : hfPaper;
    if (!paper || typeof paper !== 'object') return null;
    const arxivId = paper.id;
    if (!arxivId) return null;

    const authors = (paper.authors || []).map(a => a.name).filter(Boolean);

    const publishedAt = normalizeToBeijingISOString(paper.publishedAt || hfPaper.publishedAt || '');
    return {
        paper_id: arxivId,
        arxivId: arxivId,
        title: paper.title || hfPaper.title || '',
        authors: authors,
        summary: paper.summary || hfPaper.summary || '',
        abstract: paper.summary || hfPaper.summary || '',
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
        hf_ai_keywords: paper.ai_keywords || [],
        hf_github_repo: paper.githubRepo || '',
        hf_project_page: paper.projectPage || '',
        hf_github_stars: paper.githubStars || 0,
        hf_discussion_id: paper.discussionId || '',
        fetchedFrom: 'huggingface',
        fetchedAt: getBeijingISOString(),
        source: 'huggingface'
    };
}

/**
 * 将 papers API 格式转为标准格式
 */
function convertPaper(paper) {
    const arxivId = paper.id;
    if (!arxivId) return null;

    const authors = (paper.authors || []).map(a => a.name).filter(Boolean);

    const publishedAt = normalizeToBeijingISOString(paper.publishedAt || '');
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
        fetchedAt: getBeijingISOString(),
        source: 'huggingface'
    };
}

/**
 * 从 HuggingFace 获取过去 N 天的论文
 */
async function fetchHuggingFacePapers(existingIds = new Set(), options = {}) {
    const {
        days = HUGGINGFACE_CONFIG.defaultDays,
        minUpvotes = HUGGINGFACE_CONFIG.defaultMinUpvotes
    } = options;

    const cutoffStr = getBeijingDateString(days);

    console.log(`📥 从 HuggingFace Papers 获取过去 ${days} 天的论文 (>= ${cutoffStr})...`);

    const merged = new Map(); // paper_id -> paper

    // ====== 1. 获取 daily_papers（分页，含丰富数据）======
    console.log(`\n  📰 获取 daily_papers（精选每日论文）...`);
    let page = 0;
    let reachedCutoff = false;

    while (!reachedCutoff && page < HUGGINGFACE_CONFIG.maxPages) {
        const offset = page * HUGGINGFACE_CONFIG.pageLimit;
        const url = `https://huggingface.co/api/daily_papers?limit=${HUGGINGFACE_CONFIG.pageLimit}&offset=${offset}`;
        const data = fetchWithCurl(url);

        if (!data || !Array.isArray(data) || data.length === 0) {
            console.log(`  页${page + 1}: 无数据，停止`);
            break;
        }

        let newCount = 0;
        let oldestDate = null;

        for (const item of data) {
            if (typeof item !== 'object' || !item) continue;

            const paper = convertDailyPaper(item);
            if (!paper) continue;

            // 记录最老日期
            const pubDate = paper.published.split('T')[0];
            if (pubDate && (!oldestDate || pubDate < oldestDate)) {
                oldestDate = pubDate;
            }

            // 只保留一周内的
            if (pubDate && pubDate < cutoffStr) continue;

            // 去重
            if (!merged.has(paper.paper_id)) {
                merged.set(paper.paper_id, paper);
                newCount++;
            }
        }

        console.log(`  页${page + 1}: ${data.length}篇, 新增${newCount}篇, 最早: ${oldestDate || '?'}`);

        // 如果最老日期已经超过截止线，停止分页
        if (oldestDate && oldestDate < cutoffStr) {
            reachedCutoff = true;
        }

        // 如果返回的数据不足 100 篇，说明没有更多了
        if (data.length < HUGGINGFACE_CONFIG.pageLimit) {
            break;
        }

        page++;
        // 延迟避免请求过快
        await new Promise(resolve => setTimeout(resolve, HUGGINGFACE_CONFIG.pageDelayMs));
    }

    console.log(`  daily_papers 共获取: ${merged.size} 篇`);

    // ====== 2. 获取 papers API（补充最近1-2天的新论文）======
    console.log(`\n  📰 获取 papers API（最新论文补充）...`);
    const papersData = fetchWithCurl(`https://huggingface.co/api/papers?limit=${HUGGINGFACE_CONFIG.pageLimit}`);

    if (papersData && Array.isArray(papersData)) {
        let newCount = 0;
        for (const item of papersData) {
            if (typeof item !== 'object' || !item) continue;

            const paper = convertPaper(item);
            if (!paper) continue;

            const pubDate = paper.published.split('T')[0];
            if (pubDate && pubDate < cutoffStr) continue;

            if (!merged.has(paper.paper_id)) {
                merged.set(paper.paper_id, paper);
                newCount++;
            } else {
                // 如果已存在但 papers API 有 upvotes 信息，更新
                const existing = merged.get(paper.paper_id);
                if (paper.hf_upvotes > 0 && existing.hf_upvotes === 0) {
                    existing.hf_upvotes = paper.hf_upvotes;
                }
            }
        }
        console.log(`  papers API 新增: ${newCount} 篇`);
    }

    // ====== 3. 过滤和排序 ======
    let papers = Array.from(merged.values());

    // 过滤 upvotes
    if (minUpvotes > 0) {
        const before = papers.length;
        papers = papers.filter(p => p.hf_upvotes >= minUpvotes);
        console.log(`  upvotes >= ${minUpvotes} 过滤: ${before} → ${papers.length} 篇`);
    }

    // 排除已有论文
    if (existingIds.size > 0) {
        const before = papers.length;
        papers = papers.filter(p => !existingIds.has(normalizedId(p.paper_id)));
        console.log(`  排除已有论文: ${before} → ${papers.length} 篇`);
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

    return papers;
}

/**
 * 合并并去重 arxiv 和 HuggingFace 论文
 */
function mergeAndDeduplicate(arxivPapers, hfPapers) {
    const merged = new Map();

    // 先添加 arxiv 论文（优先级更高）
    for (const paper of arxivPapers) {
        const id = paper.paper_id || paper.arxivId;
        if (id) {
            merged.set(id, { ...paper, sources: ['arxiv'] });
        }
    }

    // 再添加 HuggingFace 论文
    for (const paper of hfPapers) {
        const id = paper.paper_id || paper.arxivId;
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
        } else {
            merged.set(id, { ...paper, sources: ['huggingface'] });
        }
    }

    return Array.from(merged.values());
}

// 导出
module.exports = {
    fetchHuggingFacePapers,
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
