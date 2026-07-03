#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 论文筛选脚本
 * 从 data/icml2026_papers.json 加载论文，用 LLM 筛选音频/语音/音乐相关论文
 *
 * 环境变量:
 *   ICML_DATA_FILE      - 输入文件 (默认: data/icml2026_papers.json)
 *   ICML_FILTERED_FILE  - 筛选结果输出 (默认: data/current/icml_2026_filtered.json)
 *   ICML_EXCLUDED_FILE  - 排除列表输出 (默认: data/current/icml_2026_excluded.json)
 *   ICML_FILTER_CONCURRENCY - 筛选并发数 (默认: 8)
 *   ICML_FILTER_OFFSET  - 从第 N 篇开始筛选（断点续传）
 *   ICML_FILTER_LIMIT   - 最多筛选 N 篇（分批）
 */

const fs = require('fs');
const path = require('path');
const {
    writeFileAtomic,
    readJsonSafe,
    getBeijingISOString,
    loadPrompt,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText
} = require('./utils.js');
const Config = require('./config.js');

const PROJECT_ROOT = path.join(__dirname, '..');

const DATA_FILE = process.env.ICML_DATA_FILE || path.join(PROJECT_ROOT, 'data', 'icml2026_papers.json');
const FILTERED_FILE = process.env.ICML_FILTERED_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_filtered.json');
const EXCLUDED_FILE = process.env.ICML_EXCLUDED_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_excluded.json');
const CONCURRENCY = parseInt(process.env.ICML_FILTER_CONCURRENCY || '8', 10);
const OFFSET = parseInt(process.env.ICML_FILTER_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICML_FILTER_LIMIT || '0', 10) || Infinity;

// 筛选阶段 LLM 配置
const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    timeoutMs: parseInt(process.env.ICML_FILTER_TIMEOUT || '60000', 10),
    maxRetries: parseInt(process.env.ICML_FILTER_RETRIES || '3', 10)
};

function checkEnv() {
    const missing = [];
    if (!FILTER_CONFIG.endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!FILTER_CONFIG.key) missing.push('PAPER_ANALYZER_API_KEY');
    if (!FILTER_CONFIG.model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        console.error(`[icml-filter] 缺少环境变量: ${missing.join(', ')}。请在 ~/.hermes/.env 中配置`);
        process.exit(1);
    }
}

/**
 * 关键词预筛选：快速排除明显不相关的论文
 * 返回 { candidates: [], excluded: [] }
 */
function keywordPreFilter(papers) {
    const audioKeywords = [
        'audio', 'speech', 'music', 'voice', 'sound', 'acoustic',
        'tts', 'asr', 'speaker', 'vocal', 'singing', 'listen',
        'waveform', 'spectrogram', 'neural codec', 'audio-lm', 'musiclm',
        'wav', '声纹', '语音识别', '语音合成', '音频'
    ];

    const candidates = [];
    const excluded = [];

    for (const paper of papers) {
        const text = ((paper.title || '') + ' ' + (paper.abstract || '')).toLowerCase();
        const hasAudioKw = audioKeywords.some(kw => text.includes(kw.toLowerCase()));

        if (hasAudioKw) {
            candidates.push(paper);
        } else {
            excluded.push({ ...paper, filterReason: '关键词预筛选：未匹配音频相关关键词' });
        }
    }

    return { candidates, excluded };
}

/**
 * 调用 LLM 进行单篇筛选
 */
async function filterSingle(paper) {
    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const apiUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(apiUrl);

    const abstract = (paper.abstract || '').substring(0, 5000);
    const prompt = loadPrompt('prompts/icml-filter.md', {
        title: paper.title || '(无标题)',
        abstract: abstract || '(无摘要)'
    });

    const messages = [{ role: 'user', content: prompt }];
    const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, 2000, 0.3);
    const postData = JSON.stringify(bodyObj);

    const headers = buildHeaders(apiType, FILTER_CONFIG.key, postData);

    return new Promise((resolve, reject) => {
        const https = require('https');
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: headers,
            timeout: FILTER_CONFIG.timeoutMs
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const response = JSON.parse(data);
                    const text = parseResponseText(apiType, response);
                    if (text === null) {
                        reject(new Error('Invalid response'));
                        return;
                    }
                    const isRelevant = parseFilterResult(text);
                    resolve({ paper, isRelevant, raw: text });
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(postData);
        req.end();
    });
}

/**
 * 解析筛选结果
 */
function parseFilterResult(text) {
    if (!text) return true; // 默认保留

    const t = text.toLowerCase();

    // 精确匹配
    if (t.includes('结论：相关') || t.includes('结论:相关') || t.includes('判断：是') || t.includes('判断:是')) return true;
    if (t.includes('结论：不相关') || t.includes('结论:不相关') || t.includes('判断：否') || t.includes('判断:否')) return false;

    // 最后一行
    const lines = text.trim().split(/\n/);
    const lastLine = lines[lines.length - 1].trim().toLowerCase();
    if (lastLine === '相关' || lastLine === '是') return true;
    if (lastLine === '不相关' || lastLine === '否') return false;

    // 包含判断
    if (t.includes('不相关') || t.includes('无关') || t.includes('否')) return false;
    if (t.includes('相关') || t.includes('是')) return true;

    return true; // 默认保留
}

/**
 * 带重试的筛选
 */
async function filterWithRetry(paper) {
    let lastError = null;
    for (let attempt = 1; attempt <= FILTER_CONFIG.maxRetries; attempt++) {
        try {
            return await filterSingle(paper);
        } catch (err) {
            lastError = err;
            if (attempt < FILTER_CONFIG.maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.log(`  [filter] ❌ ${paper.id} 筛选失败（重试 ${FILTER_CONFIG.maxRetries} 次）: ${lastError.message}`);
    return { paper, isRelevant: true, raw: '', error: lastError.message }; // 失败默认保留
}

async function main() {
    checkEnv();

    console.log('=== ICML 2026 论文筛选 ===');
    console.log(`数据文件: ${DATA_FILE}`);
    console.log(`并发数: ${CONCURRENCY}`);
    console.log(`偏移: ${OFFSET}, 限制: ${LIMIT === Infinity ? '无' : LIMIT}`);
    console.log('');

    const data = readJsonSafe(DATA_FILE);
    if (!data || !data.papers || !Array.isArray(data.papers)) {
        console.error(`[icml-filter] 无效的数据文件: ${DATA_FILE}`);
        process.exit(1);
    }

    const allPapers = data.papers;
    const targetPapers = allPapers.slice(OFFSET, OFFSET + LIMIT);
    console.log(`总论文数: ${allPapers.length}, 本次筛选: ${targetPapers.length} 篇`);

    // 加载已有结果（断点续传）
    const filteredResult = readJsonSafe(FILTERED_FILE, { papers: [], count: 0 });
    const excludedResult = readJsonSafe(EXCLUDED_FILE, { papers: [], count: 0 });

    const alreadyProcessedIds = new Set([
        ...filteredResult.papers.map(p => p.id),
        ...excludedResult.papers.map(p => p.id)
    ]);

    const papersToProcess = targetPapers.filter(p => !alreadyProcessedIds.has(p.id));
    console.log(`已处理: ${alreadyProcessedIds.size} 篇, 待处理: ${papersToProcess.length} 篇`);

    if (papersToProcess.length === 0) {
        console.log('所有论文已处理完毕');
        return;
    }

    // 关键词预筛选
    console.log('\n🔍 关键词预筛选...');
    const { candidates, excluded: keywordExcluded } = keywordPreFilter(papersToProcess);
    console.log(`关键词预筛选: ${candidates.length} 篇候选, ${keywordExcluded.length} 篇直接排除`);

    // 将关键词直接排除的论文加入排除结果
    for (const paper of keywordExcluded) {
        excludedResult.papers.push(paper);
    }

    if (candidates.length === 0) {
        console.log('关键词预筛选后无候选论文，无需 LLM 筛选');
        excludedResult.count = excludedResult.papers.length;
        writeFileAtomic(EXCLUDED_FILE, JSON.stringify(excludedResult, null, 2));
        return;
    }

    console.log('');

    let passed = 0;
    let rejected = 0;
    let failed = 0;

    // 并发筛选（仅对候选论文）
    const queue = [...candidates];

    async function worker() {
        while (queue.length > 0) {
            const paper = queue.shift();
            const result = await filterWithRetry(paper);

            if (result.error) {
                failed++;
                filteredResult.papers.push(paper); // 失败默认保留
            } else if (result.isRelevant) {
                passed++;
                filteredResult.papers.push(paper);
            } else {
                rejected++;
                excludedResult.papers.push({ ...paper, filterReason: result.raw });
            }

            const total = passed + rejected + failed;
            if (total % 10 === 0 || total === candidates.length) {
                console.log(`  LLM筛选进度: ${total}/${candidates.length} | 通过: ${passed} | 排除: ${rejected} | 失败: ${failed}`);
                // 每10篇保存一次
                filteredResult.count = filteredResult.papers.length;
                excludedResult.count = excludedResult.papers.length;
                writeFileAtomic(FILTERED_FILE, JSON.stringify(filteredResult, null, 2));
                writeFileAtomic(EXCLUDED_FILE, JSON.stringify(excludedResult, null, 2));
            }
        }
    }

    const workers = Array(Math.min(CONCURRENCY, candidates.length)).fill().map(() => worker());
    await Promise.all(workers);

    // 最终保存
    filteredResult.count = filteredResult.papers.length;
    excludedResult.count = excludedResult.papers.length;
    writeFileAtomic(FILTERED_FILE, JSON.stringify(filteredResult, null, 2));
    writeFileAtomic(EXCLUDED_FILE, JSON.stringify(excludedResult, null, 2));

    console.log('');
    console.log('=== 筛选完成 ===');
    console.log(`关键词预筛选排除: ${keywordExcluded.length} 篇`);
    console.log(`LLM 筛选通过: ${passed} 篇`);
    console.log(`LLM 筛选排除: ${rejected} 篇`);
    console.log(`LLM 筛选失败: ${failed} 篇`);
    console.log(`总计: ${keywordExcluded.length + passed + rejected + failed} 篇`);
    console.log(`结果保存: ${FILTERED_FILE} (${filteredResult.papers.length} 篇)`);
    console.log(`排除保存: ${EXCLUDED_FILE} (${excludedResult.papers.length} 篇)`);
}

main().catch(e => {
    console.error('[icml-filter] 错误:', e);
    process.exit(1);
});
