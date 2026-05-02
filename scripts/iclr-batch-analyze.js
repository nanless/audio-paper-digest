#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICLR 2026 本地论文批量分析
 * 从 ICLR scraper 的 JSON + PDF 读取论文，进行筛选 + 深度分析
 *
 * 流程:
 * 1. 读取 iclr2026_accepted.json，将 forum_id 映射到本地 PDF 路径
 * 2. 筛选阶段（可选）：基于标题+摘要筛选音频/语音相关论文
 * 3. 深度分析：对筛选后的论文进行 LLM 深度分析
 * 4. 保存结果到 data/current/iclr_2026_deep_analyzers.json
 *
 * 用法:
 *   PAPER_IMAGE_DIR=data/current/iclr-images node scripts/iclr-batch-analyze.js [options]
 *
 * 选项（环境变量）:
 *   ICLR_PAPERS_JSON    - 论文 JSON 文件 (默认: ../iclr2026-paper-scraper/data/iclr2026_accepted.json)
 *   ICLR_PDF_DIR        - PDF 论文目录 (默认: ../iclr2026-paper-scraper/data/pdfs)
 *   ICLR_RESULT_FILE    - 结果保存路径 (默认: data/current/iclr_2026_deep_analyzers.json)
 *   ICLR_AUDIO_JSON     - 预过滤的音频论文 JSON (默认: ../iclr2026-paper-scraper/data/iclr2026_audio_papers.json)
 *   ICLR_SKIP_FILTER    - 跳过筛选阶段，直接分析 (默认: false)
 *   ICLR_OFFSET         - 从第 N 篇开始分析（断点续传）
 *   ICLR_LIMIT          - 最多分析 N 篇（分批）
 *   ICLR_FILTER_ONLY    - 只执行筛选，不深度分析
 *   PAPER_IMAGE_DIR     - 图片保存目录 (默认: data/current/iclr-images)
 */

const fs = require('fs');
const path = require('path');

const {
    writeFileAtomic,
    readJsonSafe,
    getBeijingISOString,
    normalizedId,
    loadPrompt,
    loadEnvFile,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText
} = require('./utils.js');
const { analyzeBatch, createFileSaver } = require('./analysis-engine.js');
const { extractPdfContent } = require('./deep-analyzer.js');
const Config = require('./config.js');

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRAPER_DIR = path.join(PROJECT_ROOT, '..', 'iclr2026-paper-scraper', 'data');

const PAPERS_JSON = process.env.ICLR_PAPERS_JSON || path.join(DEFAULT_SCRAPER_DIR, 'iclr2026_accepted.json');
const PDF_DIR = process.env.ICLR_PDF_DIR || path.join(DEFAULT_SCRAPER_DIR, 'pdfs');
const AUDIO_JSON = process.env.ICLR_AUDIO_JSON || path.join(DEFAULT_SCRAPER_DIR, 'iclr2026_audio_papers.json');
const RESULT_FILE = process.env.ICLR_RESULT_FILE || path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');
const SNIPPETS_FILE = path.join(Config.CURRENT_DIR, 'iclr-2026-snippets.json');
const FILTER_IO_DIR = path.join(Config.CURRENT_DIR, 'iclr_filter_input_output');

const SKIP_FILTER = process.env.ICLR_SKIP_FILTER === 'true';
const OFFSET = parseInt(process.env.ICLR_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICLR_LIMIT || '0', 10) || Infinity;
const FILTER_ONLY = process.env.ICLR_FILTER_ONLY === 'true';

// 图片目录（通过环境变量传给 deep-analyzer.js）
process.env.PAPER_IMAGE_DIR = process.env.PAPER_IMAGE_DIR || path.join(Config.CURRENT_DIR, 'iclr-images');

// ═══════════════════════════════════════════════════════
// forum_id -> PDF 路径映射
// ═══════════════════════════════════════════════════════

function buildPdfPathMapping(papers, pdfDir) {
    const mapped = [];
    const unmatched = [];

    for (const paper of papers) {
        const forumId = paper.forum_id || paper.id;
        const pdfPath = path.join(pdfDir, `${forumId}.pdf`);

        if (fs.existsSync(pdfPath)) {
            mapped.push({
                ...paper,
                pdfPath,
                paper_id: forumId,
                arnumber: forumId  // 兼容 publish-to-blog.py
            });
        } else {
            unmatched.push(`${forumId}: ${paper.title}`);
        }
    }

    return { mapped, unmatched };
}

// ═══════════════════════════════════════════════════════
// 筛选：纯 LLM 筛选（标题 + 摘要）
// ═══════════════════════════════════════════════════════

const FILTER_CONCURRENCY = parseInt(process.env.ICLR_FILTER_CONCURRENCY || '8', 10);
const FILTER_TIMEOUT_MS = parseInt(process.env.ICLR_FILTER_TIMEOUT || '60000', 10);
const FILTER_MAX_RETRIES = parseInt(process.env.ICLR_FILTER_RETRIES || '3', 10);

/**
 * 单篇 LLM 筛选（带重试）
 */
async function llmFilterSingle(paper, config) {
    const apiType = detectApiType(config.endpoint, config.model);
    const modelUrl = buildApiUrl(apiType, config.endpoint);
    const url = new URL(modelUrl);

    // ICLR 已有 abstract，不需要提取 PDF
    const abstract = (paper.abstract || '').substring(0, 2000);

    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title || '(无标题)',
        abstract: abstract || '(无摘要)'
    });

    const paperId = paper.forum_id || paper.paper_id || normalizedId(paper);

    let lastError = null;
    for (let attempt = 1; attempt <= FILTER_MAX_RETRIES; attempt++) {
        try {
            const result = await _llmFilterCall(url, apiType, config, prompt, paperId);
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

function _llmFilterCall(url, apiType, config, prompt, paperId) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const messages = [{ role: 'user', content: prompt }];
        const bodyObj = buildRequestBody(apiType, config.model, messages, 2000, 0.3);
        const postData = JSON.stringify(bodyObj);

        const headers = {
            ...buildHeaders(apiType, config.key, postData)
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
                    if (paperId) {
                        const ioFile = path.join(FILTER_IO_DIR, `${paperId}.json`);
                        writeFileAtomic(ioFile, JSON.stringify({
                            paperId,
                            timestamp: getBeijingISOString(),
                            input: { prompt, messages },
                            output: { statusCode: res.statusCode, rawResponse: response, parsedContent: content }
                        }, null, 2));
                    }
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

/**
 * 并发 LLM 筛选全部论文
 */
async function llmFilterPapers(papers) {
    loadEnvFile();

    const FILTER_CONFIG = {
        endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
        key: process.env.PAPER_ANALYZER_API_KEY || '',
        model: process.env.PAPER_ANALYZER_MODEL || ''
    };

    if (!FILTER_CONFIG.endpoint || !FILTER_CONFIG.key || !FILTER_CONFIG.model) {
        console.log('[filter] 缺少 API 配置，跳过 LLM 筛选，全部保留');
        return papers;
    }

    console.log(`[filter] LLM 筛选: ${papers.length} 篇，并发 ${FILTER_CONCURRENCY}`);

    const included = [];
    const excluded = [];
    const failed = [];
    let completed = 0;

    for (let i = 0; i < papers.length; i += FILTER_CONCURRENCY) {
        const batch = papers.slice(i, i + FILTER_CONCURRENCY);
        const batchNum = Math.floor(i / FILTER_CONCURRENCY) + 1;
        const totalBatches = Math.ceil(papers.length / FILTER_CONCURRENCY);

        const promises = batch.map(p =>
            llmFilterSingle(p, FILTER_CONFIG).catch(err => {
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

        if (i + FILTER_CONCURRENCY < papers.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console();
    console.log(`[filter] 筛选完成: 保留 ${included.length} 篇, 排除 ${excluded.length} 篇, 失败 ${failed.length} 篇`);

    const excludeFile = RESULT_FILE.replace('.json', '-excluded.json');
    writeFileAtomic(excludeFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        count: excluded.length,
        papers: excluded.map(p => ({ forum_id: p.forum_id, title: p.title }))
    }, null, 2));
    console.log(`[filter] 排除列表已保存: ${excludeFile}`);

    return included;
}

// ═══════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════

async function main() {
    console.log('=== ICLR 2026 论文批量分析 ===');
    console.log(`论文 JSON: ${PAPERS_JSON}`);
    console.log(`PDF 目录: ${PDF_DIR}`);
    console.log(`结果文件: ${RESULT_FILE}`);
    console.log(`图片目录: ${process.env.PAPER_IMAGE_DIR}`);
    console.log(`跳过筛选: ${SKIP_FILTER}`);
    console.log(`起始偏移: ${OFFSET}`);
    console.log(`分析上限: ${LIMIT === Infinity ? '无限制' : LIMIT}`);
    console.log(`仅筛选: ${FILTER_ONLY}`);
    console.log('');

    // 1. 读取论文列表
    const papersData = readJsonSafe(PAPERS_JSON, []);
    if (!Array.isArray(papersData) || papersData.length === 0) {
        console.error('论文列表为空或格式错误');
        process.exit(1);
    }
    console.log(`论文总数: ${papersData.length}`);

    // 2. 映射 PDF 路径
    let papersToProcess;

    if (SKIP_FILTER && fs.existsSync(AUDIO_JSON)) {
        // 使用预过滤的音频论文
        const audioData = readJsonSafe(AUDIO_JSON, []);
        console.log(`使用预过滤音频论文: ${audioData.length} 篇`);
        const { mapped, unmatched } = buildPdfPathMapping(audioData, PDF_DIR);
        papersToProcess = mapped;
        console.log(`PDF 映射成功: ${mapped.length}/${audioData.length}`);
        if (unmatched.length > 0) {
            console.log(`  未匹配: ${unmatched.length} 篇`);
        }
    } else {
        const { mapped, unmatched } = buildPdfPathMapping(papersData, PDF_DIR);
        papersToProcess = mapped;
        console.log(`PDF 映射成功: ${mapped.length}/${papersData.length}`);
        if (unmatched.length > 0) {
            console.log(`  未匹配: ${unmatched.length} 篇`);
            for (const t of unmatched.slice(0, 5)) {
                console.log(`    - ${t}`);
            }
        }
    }

    // 3. 应用偏移和限制
    if (OFFSET > 0) {
        papersToProcess = papersToProcess.slice(OFFSET);
        console.log(`应用偏移: 从第 ${OFFSET + 1} 篇开始，剩余 ${papersToProcess.length} 篇`);
    }
    if (LIMIT !== Infinity) {
        papersToProcess = papersToProcess.slice(0, LIMIT);
        console.log(`应用限制: 最多分析 ${LIMIT} 篇`);
    }

    // 4. 读取已有结果（断点续传）
    const existingResult = readJsonSafe(RESULT_FILE, null);
    const existingPapers = existingResult ? (existingResult.papers || []) : [];
    const existingIds = new Set(existingPapers.filter(p => p.analysis).map(p => p.forum_id || p.paper_id || normalizedId(p)));
    console.log(`已有分析结果: ${existingIds.size} 篇`);

    const notAnalyzed = papersToProcess.filter(p => !existingIds.has(p.forum_id || p.paper_id || normalizedId(p)));
    console.log(`未分析论文: ${notAnalyzed.length} 篇`);

    if (notAnalyzed.length === 0) {
        console.log('所有论文已分析完成！');
        return;
    }

    // 5. 筛选阶段
    let papersToAnalyze = notAnalyzed;

    if (!SKIP_FILTER) {
        console.log('\n=== 筛选阶段（LLM 标题+摘要筛选）===');

        if (!fs.existsSync(FILTER_IO_DIR)) {
            fs.mkdirSync(FILTER_IO_DIR, { recursive: true });
        }

        papersToAnalyze = await llmFilterPapers(notAnalyzed);

        const filterResultFile = RESULT_FILE.replace('.json', '-filtered.json');
        writeFileAtomic(filterResultFile, JSON.stringify({
            timestamp: getBeijingISOString(),
            total: notAnalyzed.length,
            selected: papersToAnalyze.length,
            papers: papersToAnalyze.map(p => ({
                forum_id: p.forum_id,
                title: p.title,
                pdfPath: p.pdfPath
            }))
        }, null, 2));
        console.log(`筛选结果已保存: ${filterResultFile}`);

        if (FILTER_ONLY) {
            console.log('\n仅执行筛选，跳过深度分析');
            return;
        }
    }

    // 6. 深度分析
    console.log(`\n=== 深度分析阶段 (${papersToAnalyze.length} 篇) ===`);

    const saver = createFileSaver(RESULT_FILE);

    const { stats } = await analyzeBatch(papersToAnalyze, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 1,
        onPaperStart: (idx, total, paper) => {
            console.log(`\n--- [${idx + 1}/${total}] 分析: ${paper.forum_id} ---`);
            const titleStr = paper.title || '(无标题)';
            console.log(`标题: ${titleStr.substring(0, 80)}${titleStr.length > 80 ? '...' : ''}`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                console.log(`✅ 分析成功 (${durSec}s)`);
                if (result.parsed) {
                    console.log(`   评分: ${result.parsed.score || 'N/A'}`);
                    console.log(`   标签: ${result.parsed.tags ? result.parsed.tags.slice(0, 5).join(' ') : 'N/A'}`);
                    console.log(`   分档: ${result.parsed.rankBucket || 'N/A'} | 主任务: ${result.parsed.primaryTaskTag || 'N/A'} | 主方法: ${result.parsed.primaryMethodTag || 'N/A'}`);
                }
            } else {
                console.log(`❌ 分析异常 (${durSec}s): ${result.error}`);
            }
        },
        onSave: async (results, saveStats) => {
            await saver(results, saveStats);
        }
    });

    console.log('\n=== 分析完成 ===');
    console.log(`总计: ${stats.total} 篇 | 成功: ${stats.success} 篇 | 失败: ${stats.failed} 篇`);
    console.log(`结果保存: ${RESULT_FILE}`);
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
