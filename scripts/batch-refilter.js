#!/usr/bin/env node
/**
 * 批量重新筛选全部论文（基于新提取的PDF文本）
 * 并发数: 8（默认，可通过环境变量覆盖）
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

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════

const PAPERS_JSON = process.env.ICASSP_JSON_FILE || path.join(os.homedir(), 'Documents/icassp-2026-papers/papers_2026.json');
const SNIPPETS_FILE = path.join(Config.CURRENT_DIR, 'icassp-2026-snippets.json');
const FILTER_IO_DIR = path.join(Config.CURRENT_DIR, 'filter_input_output');
const RESULT_FILE = path.join(Config.CURRENT_DIR, 'icassp_2026_deep_analyzers.json');

const FILTER_CONCURRENCY = parseInt(process.env.ICASSP_FILTER_CONCURRENCY || '8', 10);
const FILTER_TIMEOUT_MS = parseInt(process.env.ICASSP_FILTER_TIMEOUT || '60000', 10);
const FILTER_MAX_RETRIES = parseInt(process.env.ICASSP_FILTER_RETRIES || '3', 10);

// API 配置
const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || ''
};

if (!FILTER_CONFIG.endpoint || !FILTER_CONFIG.key || !FILTER_CONFIG.model) {
    console.error('[filter] 缺少 API 配置');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════
// 读取数据
// ═══════════════════════════════════════════════════════

const papers = JSON.parse(fs.readFileSync(PAPERS_JSON, 'utf8'));
const snippetsData = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'));

const snippetMap = new Map();
for (const s of snippetsData.papers) {
    snippetMap.set(s.paper_id, s.snippet);
}

console.log(`[filter] 论文总数: ${papers.length}`);
console.log(`[filter] Snippets: ${snippetMap.size}`);
console.log(`[filter] 并发数: ${FILTER_CONCURRENCY}`);
console.log('');

// 确保 filter IO 目录存在
if (!fs.existsSync(FILTER_IO_DIR)) {
    fs.mkdirSync(FILTER_IO_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════
// 单篇筛选（带重试）
// ═══════════════════════════════════════════════════════

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

        const headers = {
            ...buildHeaders(apiType, FILTER_CONFIG.key, postData)
        };

        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers,
            timeout: FILTER_TIMEOUT_MS
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);

                    // 保存输入输出
                    const ioFile = path.join(FILTER_IO_DIR, `${paperId}.json`);
                    writeFileAtomic(ioFile, JSON.stringify({
                        paperId,
                        timestamp: getBeijingISOString(),
                        input: { prompt, messages },
                        output: { statusCode: res.statusCode, rawResponse: response, parsedContent: content }
                    }, null, 2));

                    // 检测 API 错误
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
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(postData);
        req.end();
    });
}

// ═══════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════

async function main() {
    const included = [];
    const excluded = [];
    const failed = [];
    let completed = 0;

    const totalBatches = Math.ceil(papers.length / FILTER_CONCURRENCY);

    for (let i = 0; i < papers.length; i += FILTER_CONCURRENCY) {
        const batch = papers.slice(i, i + FILTER_CONCURRENCY);
        const batchNum = Math.floor(i / FILTER_CONCURRENCY) + 1;

        const promises = batch.map(p =>
            llmFilterSingle(p).catch(err => {
                return { paper: p, isRelevant: false, raw: 'error: ' + err.message, failed: true };
            })
        );

        const results = await Promise.all(promises);

        for (const r of results) {
            if (r.failed) {
                failed.push(r.paper);
                excluded.push(r.paper);
            } else if (r.isRelevant) {
                included.push(r.paper);
            } else {
                excluded.push(r.paper);
            }
            completed++;
        }

        process.stdout.write(`\r[filter] 进度: ${completed}/${papers.length} | 保留 ${included.length} | 排除 ${excluded.length} | 失败 ${failed.length} | 批次 ${batchNum}/${totalBatches}`);

        // 批次间延迟
        if (i + FILTER_CONCURRENCY < papers.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log(); // newline
    console.log(`[filter] 筛选完成: 保留 ${included.length} 篇, 排除 ${excluded.length} 篇, 失败 ${failed.length} 篇`);

    // 保存筛选结果
    const filterResultFile = RESULT_FILE.replace('.json', '-filtered.json');
    writeFileAtomic(filterResultFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        total: papers.length,
        selected: included.length,
        papers: included.map(p => ({
            arnumber: p.arnumber,
            title: p.title
        }))
    }, null, 2));
    console.log(`[filter] 保留列表已保存: ${filterResultFile}`);

    // 保存排除列表
    const excludeFile = RESULT_FILE.replace('.json', '-excluded.json');
    writeFileAtomic(excludeFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        count: excluded.length,
        papers: excluded.map(p => ({ arnumber: p.arnumber, title: p.title }))
    }, null, 2));
    console.log(`[filter] 排除列表已保存: ${excludeFile}`);

    // 保存失败列表
    if (failed.length > 0) {
        const failFile = path.join(Config.CURRENT_DIR, 'filter-failed.json');
        writeFileAtomic(failFile, JSON.stringify({
            timestamp: getBeijingISOString(),
            count: failed.length,
            papers: failed.map(p => ({ arnumber: p.arnumber, title: p.title }))
        }, null, 2));
        console.log(`[filter] 失败列表已保存: ${failFile}`);
    }
}

main().catch(err => {
    console.error('[filter] 批量筛选异常:', err);
    process.exit(1);
});
