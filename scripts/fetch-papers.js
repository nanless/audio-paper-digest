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
    loadPrompt,
    normalizedId
} = require('./utils.js');
const Config = require('./config.js');

loadEnvFile();

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
        throw new Error(`[filter] 缺少环境变量: ${missing.join(', ')}。请在 ~/.hermes/.env 中配置`);
    }

    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const apiUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(apiUrl);
    console.log(`[filter] API 类型: ${apiType} | 端点: ${url.hostname}${url.pathname}`);

    const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, maxTokens, 0.3);
    const postData = JSON.stringify(bodyObj);

    // 代理检测（日志记录用途；LLM API 请求使用 agent: false 禁用连接复用以避免 MiMo 403）
    const proxyUrl = detectProxyUrl();
    if (proxyUrl) {
        console.log(`[filter] 检测到代理: ${proxyUrl}（LLM 请求将直连绕过）`);
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
            agent: false,
            signal: controller.signal
        };

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
 * 从 arXiv API 抓取指定类别的论文
 */
async function fetchCategoryPapers(categoryId, maxResults = ARXIV_CONFIG.maxResultsPerCategory, retryCount = ARXIV_CONFIG.fetchMaxRetries, existingIds = null) {
    const url = `https://export.arxiv.org/api/query?search_query=cat:${categoryId}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

    console.log(`[fetch] 正在抓取 ${categoryId} 类别的 ${maxResults} 篇论文...`);

    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(60000)
            });

            if (response.status === 429) {
                const baseWait = Math.min(Math.pow(2, attempt) * ARXIV_CONFIG.fetchRateLimitBaseDelayMs, ARXIV_CONFIG.fetchMaxWaitMs);
                const jitter = Math.floor(Math.random() * 5000);
                const waitTime = baseWait + jitter;
                console.log(`[fetch] ${categoryId} 被限流，等待 ${(waitTime/1000).toFixed(1)} 秒后重试 (${attempt}/${retryCount})...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const xml = await response.text();
            const papers = parseArxivXML(xml, categoryId, existingIds);
            console.log(`[fetch] ${categoryId} 成功获取 ${papers.length} 篇新论文${existingIds ? '（遇到重复已提前停止）' : ''}`);
            return papers;

        } catch (err) {
            if (attempt === retryCount) {
                console.error(`[fetch] 抓取 ${categoryId} 最终失败: ${err.message}`);
                return [];
            }

            const baseWait = Math.min(Math.pow(2, attempt) * ARXIV_CONFIG.fetchRetryBaseDelayMs, ARXIV_CONFIG.fetchMaxWaitMs);
            const jitter = Math.floor(Math.random() * 3000);
            const waitTime = baseWait + jitter;
            console.log(`[fetch] ${categoryId} 抓取出错 (${err.message})，${(waitTime/1000).toFixed(1)}秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    return [];
}

/**
 * 解析 arXiv API 返回的 XML
 */
function parseArxivXML(xml, categoryId, existingIds = null) {
    const papers = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    let consecutiveExisting = 0;

    while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];

        const idMatch = entry.match(/<id>(.*?)<\/id>/);
        if (!idMatch) continue;
        const arxivId = idMatch[1].split('/abs/').pop();

        if (existingIds && existingIds.has(normalizedId(arxivId))) {
            consecutiveExisting++;
            if (consecutiveExisting >= ARXIV_CONFIG.consecutiveExistingThreshold) {
                console.log(`[fetch] 遇到连续 ${consecutiveExisting} 篇已知论文，停止抓取 ${categoryId}`);
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

        // 优先匹配新格式「判断：是/否」
        if (answer.includes('判断：是') || answer.includes('判断:是')) {
            return true;
        }
        if (answer.includes('判断：否') || answer.includes('判断:否')) {
            return false;
        }

        // 兼容旧格式
        const isRelated = answer.includes('是') || answer.includes('yes') || answer === 'y';
        const isUnrelated = answer.includes('否') || answer.includes('no') || answer === 'n';

        if (isRelated) {
            return true;
        } else if (isUnrelated) {
            return false;
        } else {
            console.log(`[filter] 无法判断 ${paper.arxivId}: "${answer.substring(0, 30)}" → 默认过滤`);
            return false;
        }
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
