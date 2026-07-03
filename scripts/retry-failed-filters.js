#!/usr/bin/env node
/**
 * 重试筛选失败的论文
 * 降低并发（默认3），增加批次延迟（默认2000ms）
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
const RESULT_FILE = path.join(Config.CURRENT_DIR, 'icassp_2026_deep_analyzers.json');

const FILTER_CONCURRENCY = parseInt(process.env.ICASSP_FILTER_CONCURRENCY || '3', 10);
const FILTER_TIMEOUT_MS = parseInt(process.env.ICASSP_FILTER_TIMEOUT || '60000', 10);
const FILTER_MAX_RETRIES = parseInt(process.env.ICASSP_FILTER_RETRIES || '3', 10);
const BATCH_DELAY_MS = parseInt(process.env.ICASSP_BATCH_DELAY || '2000', 10);

const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || ''
};

if (!FILTER_CONFIG.endpoint || !FILTER_CONFIG.key || !FILTER_CONFIG.model) {
    console.error('[filter] 缺少 API 配置');
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

// 找出失败的论文
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

console.log(`[retry] 总论文: ${papers.length}`);
console.log(`[retry] 需要重试: ${failedIds.length} 篇`);
console.log(`[retry] 并发: ${FILTER_CONCURRENCY}, 批次延迟: ${BATCH_DELAY_MS}ms`);
console.log('');

if (failedIds.length === 0) {
    console.log('[retry] 没有失败的论文，无需重试');
    process.exit(0);
}

// 筛选逻辑
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
            if (attempt < FILTER_MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000;
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
    const included = [];
    const excluded = [];
    const stillFailed = [];
    let completed = 0;

    const totalBatches = Math.ceil(failedPapers.length / FILTER_CONCURRENCY);

    for (let i = 0; i < failedPapers.length; i += FILTER_CONCURRENCY) {
        const batch = failedPapers.slice(i, i + FILTER_CONCURRENCY);
        const batchNum = Math.floor(i / FILTER_CONCURRENCY) + 1;

        const promises = batch.map(p =>
            llmFilterSingle(p).catch(err => {
                return { paper: p, isRelevant: false, raw: 'error: ' + err.message, failed: true };
            })
        );

        const results = await Promise.all(promises);

        for (const r of results) {
            if (r.failed) {
                stillFailed.push(r.paper);
                excluded.push(r.paper);
            } else if (r.isRelevant) {
                included.push(r.paper);
            } else {
                excluded.push(r.paper);
            }
            completed++;
        }

        process.stdout.write(`\r[retry] 进度: ${completed}/${failedPapers.length} | 保留 ${included.length} | 排除 ${excluded.length} | 仍失败 ${stillFailed.length} | 批次 ${batchNum}/${totalBatches}`);

        if (i + FILTER_CONCURRENCY < failedPapers.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    console.log();
    console.log(`[retry] 重试完成: 保留 ${included.length} 篇, 排除 ${excluded.length} 篇, 仍失败 ${stillFailed.length} 篇`);

    // 重新统计全部结果
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
    console.log(`[retry] 全部统计: 保留 ${totalIncluded} | 排除 ${totalExcluded} | 失败 ${totalFailed}`);

    // 保存结果
    const allPapers = [];
    for (const f of allFiles) {
        try {
            const io = JSON.parse(fs.readFileSync(path.join(FILTER_IO_DIR, f), 'utf8'));
            const paperId = f.replace('.json', '');
            const paper = paperMap.get(paperId);
            if (paper && io.output?.parsedContent === '是') {
                allPapers.push({ arnumber: paper.arnumber, title: paper.title });
            }
        } catch (e) {}
    }

    const filterResultFile = RESULT_FILE.replace('.json', '-filtered.json');
    writeFileAtomic(filterResultFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        total: papers.length,
        selected: allPapers.length,
        papers: allPapers
    }, null, 2));
    console.log(`[retry] 筛选结果已保存: ${filterResultFile}`);
}

main().catch(err => {
    console.error('[retry] 异常:', err);
    process.exit(1);
});
