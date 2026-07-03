#!/usr/bin/env node
/**
 * 对最后一批持续失败的论文进行单独重试
 * 使用单并发 + 长延迟 + 5次重试
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const {
    writeFileAtomic,
    getBeijingISOString,
    loadPrompt,
    loadEnvFile,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText
} = require('./utils.js');
const Config = require('./config.js');

loadEnvFile();

const PAPERS_JSON = process.env.ICASSP_JSON_FILE || path.join(os.homedir(), 'Documents/icassp-2026-papers/papers_2026.json');
const SNIPPETS_FILE = path.join(Config.CURRENT_DIR, 'icassp-2026-snippets.json');
const FILTER_IO_DIR = path.join(Config.CURRENT_DIR, 'filter_input_output');

const FILTER_TIMEOUT_MS = parseInt(process.env.ICASSP_FILTER_TIMEOUT || '90000', 10);
const FILTER_MAX_RETRIES = 5;
const BATCH_DELAY_MS = 5000;

const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || ''
};

if (!FILTER_CONFIG.endpoint || !FILTER_CONFIG.key || !FILTER_CONFIG.model) {
    console.error('[last-retry] 缺少 API 配置');
    process.exit(1);
}

// 读取论文和snippets
const papers = JSON.parse(fs.readFileSync(PAPERS_JSON, 'utf8'));
const paperMap = new Map();
for (const p of papers) {
    paperMap.set(String(p.arnumber), p);
}

const snippetsData = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'));
const snippetMap = new Map();
for (const s of snippetsData.papers) {
    snippetMap.set(s.paper_id, s.snippet);
}

// 找出仍失败的论文
const failedIds = [];
const files = fs.readdirSync(FILTER_IO_DIR).filter(f => f.endsWith('.json'));
for (const f of files) {
    const paperId = f.replace('.json', '');
    const ioPath = path.join(FILTER_IO_DIR, f);
    try {
        const io = JSON.parse(fs.readFileSync(ioPath, 'utf8'));
        const status = io.output?.statusCode;
        if (status !== 200) {
            failedIds.push(paperId);
        }
    } catch (e) {
        failedIds.push(paperId);
    }
}

console.log(`[last-retry] 仍失败的论文: ${failedIds.length} 篇`);
console.log(`[last-retry] 并发: 1, 批次延迟: ${BATCH_DELAY_MS}ms, 最大重试: ${FILTER_MAX_RETRIES}`);
console.log('');

if (failedIds.length === 0) {
    console.log('[last-retry] 没有失败的论文');
    process.exit(0);
}

// 单篇筛选（带重试）
async function llmFilterSingle(paper) {
    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const modelUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(modelUrl);

    const abstract = (snippetMap.get(String(paper.arnumber)) || '').substring(0, 2000);
    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title || '(无标题)',
        abstract: abstract || '(无摘要)'
    });
    const paperId = String(paper.arnumber);

    let lastError = null;
    for (let attempt = 1; attempt <= FILTER_MAX_RETRIES; attempt++) {
        try {
            const result = await _llmFilterCall(url, apiType, prompt, paperId);
            return { paper, isRelevant: result.isRelevant, raw: result.raw };
        } catch (err) {
            lastError = err;
            console.log(`  [last-retry] ⚠️ ${paperId} 第${attempt}/${FILTER_MAX_RETRIES}次失败: ${err.message}`);
            if (attempt < FILTER_MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 2000;
                console.log(`  [last-retry] ⏳ ${delay/1000}s后重试...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`筛选失败（重试 ${FILTER_MAX_RETRIES} 次）: ${lastError.message}`);
}

function _llmFilterCall(url, apiType, prompt, paperId) {
    return new Promise((resolve, reject) => {
        const messages = [{ role: 'user', content: prompt }];
        const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, 2000, 0.3);
        const postData = JSON.stringify(bodyObj);

        const headers = { ...buildHeaders(apiType, FILTER_CONFIG.key, postData) };

        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers,
            timeout: FILTER_TIMEOUT_MS
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);

                    const ioFile = path.join(FILTER_IO_DIR, `${paperId}.json`);
                    writeFileAtomic(ioFile, JSON.stringify({
                        paperId,
                        timestamp: getBeijingISOString(),
                        input: { prompt, messages },
                        output: { statusCode: res.statusCode, rawResponse: response, parsedContent: content }
                    }, null, 2));

                    if (response.error || (content && /rejected|error|invalid/i.test(content))) {
                        reject(new Error('API error: ' + (response.error?.message || content || 'unknown')));
                        return;
                    }
                    if (content !== null) {
                        const trimmed = content.trim();
                        if (!/^(是|否|yes|no)$/i.test(trimmed)) {
                            reject(new Error(`Unexpected response format: "${trimmed.substring(0, 100)}"`));
                            return;
                        }
                        const isRelevant = /^(是|yes)$/i.test(trimmed);
                        resolve({ isRelevant, raw: trimmed });
                    } else {
                        reject(new Error('Invalid response'));
                    }
                } catch (e) {
                    reject(new Error('Parse error: ' + e.message));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });
}

async function main() {
    const failedPapers = failedIds.map(id => paperMap.get(id)).filter(Boolean);
    let successCount = 0;
    let stillFailedCount = 0;

    for (let i = 0; i < failedPapers.length; i++) {
        const paper = failedPapers[i];
        const paperId = String(paper.arnumber);
        console.log(`[last-retry] [${i + 1}/${failedPapers.length}] ${paperId} | ${paper.title.substring(0, 60)}`);

        try {
            const result = await llmFilterSingle(paper);
            successCount++;
            console.log(`  ✅ ${result.isRelevant ? '保留' : '排除'} | ${result.raw}`);
        } catch (err) {
            stillFailedCount++;
            console.log(`  ❌ 仍失败: ${err.message}`);
        }

        if (i < failedPapers.length - 1) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    console.log('');
    console.log(`[last-retry] 完成: 成功 ${successCount} 篇, 仍失败 ${stillFailedCount} 篇`);

    // 最终统计
    const allFiles = fs.readdirSync(FILTER_IO_DIR).filter(f => f.endsWith('.json'));
    let totalIncluded = 0;
    let totalExcluded = 0;
    let totalFailed = 0;
    for (const f of allFiles) {
        try {
            const io = JSON.parse(fs.readFileSync(path.join(FILTER_IO_DIR, f), 'utf8'));
            const status = io.output?.statusCode;
            const content = io.output?.parsedContent;
            if (status !== 200) {
                totalFailed++;
            } else if (content === '是') {
                totalIncluded++;
            } else {
                totalExcluded++;
            }
        } catch (e) {}
    }
    console.log(`[last-retry] 全部统计: 保留 ${totalIncluded} | 排除 ${totalExcluded} | 失败 ${totalFailed}`);
}

main().catch(err => {
    console.error('[last-retry] 异常:', err);
    process.exit(1);
});
