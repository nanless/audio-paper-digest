#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICASSP 2026 本地论文批量分析
 * 从本地 PDF 读取论文，进行筛选 + 深度分析
 *
 * 流程:
 * 1. 读取 papers_2026.json，将 title 映射到本地 PDF 路径
 * 2. 筛选阶段（可选）：基于 PDF 内容筛选音频/语音相关论文
 * 3. 深度分析：对筛选后的论文进行 LLM 深度分析
 * 4. 保存结果到 data/current/icassp-2026-analysis.json
 *
 * 用法:
 *   node scripts/icassp-batch-analyze.js [options]
 *
 * 选项（环境变量）:
 *   ICASSP_PAPERS_DIR   - PDF 论文目录 (默认: ~/Documents/icassp-2026-papers/papers_2026)
 *   ICASSP_JSON_FILE    - 论文 JSON 文件 (默认: ~/Documents/icassp-2026-papers/papers_2026.json)
 *   ICASSP_RESULT_FILE  - 结果保存路径 (默认: data/current/icassp-2026-analysis.json)
 *   ICASSP_SKIP_FILTER  - 跳过筛选阶段，直接分析所有论文 (默认: false)
 *   ICASSP_OFFSET       - 从第 N 篇开始分析（用于断点续传）
 *   ICASSP_LIMIT        - 最多分析 N 篇（用于分批）
 *   ICASSP_FILTER_ONLY  - 只执行筛选，不深度分析
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

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

const PAPERS_DIR = process.env.ICASSP_PAPERS_DIR || path.join(os.homedir(), 'Documents/icassp-2026-papers/papers_2026');
const JSON_FILE = process.env.ICASSP_JSON_FILE || path.join(os.homedir(), 'Documents/icassp-2026-papers/papers_2026.json');
const RESULT_FILE = process.env.ICASSP_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icassp_2026_deep_analyzers.json');
const SNIPPETS_FILE = path.join(Config.CURRENT_DIR, 'icassp-2026-snippets.json');
const FILTER_IO_DIR = path.join(Config.CURRENT_DIR, 'filter_input_output');
const SKIP_FILTER = process.env.ICASSP_SKIP_FILTER === 'true';
const OFFSET = parseInt(process.env.ICASSP_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.ICASSP_LIMIT || '0', 10) || Infinity;
const FILTER_ONLY = process.env.ICASSP_FILTER_ONLY === 'true';

// ═══════════════════════════════════════════════════════
// Title -> PDF 文件名映射
// ═══════════════════════════════════════════════════════

function normalizeForFilename(title) {
    // 与 PDF 文件名生成规则保持一致
    return title
        .replace(/[^\w\s]/g, '')  // 移除所有特殊字符
        .trim();
}

function buildPdfPathMapping(papers, pdfDir) {
    // 读取目录中所有 PDF 文件
    const pdfs = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));

    // 构建归一化索引
    const pdfIndex = new Map();
    for (const f of pdfs) {
        const norm = normalizeForFilename(f.replace(/\.pdf$/, '')).toLowerCase();
        pdfIndex.set(norm, path.join(pdfDir, f));
    }

    const mapped = [];
    const unmatched = [];

    for (const paper of papers) {
        const title = paper.title || '';
        const norm = normalizeForFilename(title).toLowerCase();
        const pdfPath = pdfIndex.get(norm);

        if (pdfPath) {
            mapped.push({
                ...paper,
                pdfPath,
                paper_id: paper.arnumber || paper.id || normalizedId(paper)
            });
        } else {
            unmatched.push(title);
        }
    }

    return { mapped, unmatched };
}

// ═══════════════════════════════════════════════════════
// 筛选：纯 LLM 筛选（标题 + PDF 摘要）
// ═══════════════════════════════════════════════════════

const FILTER_CONCURRENCY = parseInt(process.env.ICASSP_FILTER_CONCURRENCY || '8', 10);
const FILTER_TIMEOUT_MS = parseInt(process.env.ICASSP_FILTER_TIMEOUT || '60000', 10);
const FILTER_MAX_RETRIES = parseInt(process.env.ICASSP_FILTER_RETRIES || '3', 10);

/**
 * 从 PDF 提取前 N 个字符的文本作为摘要
 */
async function extractPdfSnippet(pdfPath, maxChars = 5000) {
    try {
        const result = await extractPdfContent(pdfPath);
        if (result.warning) {
            console.log(`    [pdf] ⚠️  ${path.basename(pdfPath)} | ${result.warning}`);
        }
        return result.text ? result.text.substring(0, maxChars) : '';
    } catch (e) {
        console.log(`    [pdf] ✗ ${path.basename(pdfPath)} | 提取失败: ${e.message}`);
        return '';
    }
}

/**
 * 单篇 LLM 筛选（带重试）
 * 使用 prompts/filter.md 的 prompt，基于标题+摘要判断
 */
async function llmFilterSingle(paper, config) {
    const apiType = detectApiType(config.endpoint, config.model);
    const modelUrl = buildApiUrl(apiType, config.endpoint);
    const url = new URL(modelUrl);

    // 取摘要前 2000 字符，避免 prompt 过长
    const abstract = (paper._snippet || '').substring(0, 2000);

    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title || '(无标题)',
        abstract: abstract || '(无摘要)'
    });

    const paperId = paper.arnumber || paper.paper_id || normalizedId(paper);

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
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
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
                    // 检测 API 错误
                    if (response.error || (content && /rejected|error|invalid/i.test(content))) {
                        reject(new Error('API error: ' + (response.error?.message || content || 'unknown')));
                        return;
                    }
                    if (content !== null) {
                        const trimmed = content.trim();
                        // 严格验证输出格式：必须是"是/否"或"yes/no"
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

    console.log(`[filter] 纯 LLM 筛选: ${papers.length} 篇，并发 ${FILTER_CONCURRENCY}`);

    const included = [];
    const excluded = [];
    const failed = [];
    let completed = 0;

    // 按批次并发处理
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
                excluded.push(r.paper); // 失败的不保留
            } else if (r.isRelevant) {
                included.push(r.paper);
            } else {
                excluded.push(r.paper);
            }
            completed++;
        }

        process.stdout.write(`\r[filter] 进度: ${completed}/${papers.length} | 保留 ${included.length} | 排除 ${excluded.length} | 失败 ${failed.length} | 批次 ${batchNum}/${totalBatches}`);

        // 批次间延迟，避免 API 过载
        if (i + FILTER_CONCURRENCY < papers.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log(); // newline
    console.log(`[filter] 筛选完成: 保留 ${included.length} 篇, 排除 ${excluded.length} 篇, 失败 ${failed.length} 篇`);

    // 保存排除列表供参考
    const excludeFile = RESULT_FILE.replace('.json', '-excluded.json');
    writeFileAtomic(excludeFile, JSON.stringify({
        timestamp: getBeijingISOString(),
        count: excluded.length,
        papers: excluded.map(p => ({ arnumber: p.arnumber, title: p.title }))
    }, null, 2));
    console.log(`[filter] 排除列表已保存: ${excludeFile}`);

    return included;
}

// ═══════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════

async function main() {
    console.log('=== ICASSP 2026 论文批量分析 ===');
    console.log(`PDF 目录: ${PAPERS_DIR}`);
    console.log(`JSON 文件: ${JSON_FILE}`);
    console.log(`结果文件: ${RESULT_FILE}`);
    console.log(`跳过筛选: ${SKIP_FILTER}`);
    console.log(`起始偏移: ${OFFSET}`);
    console.log(`分析上限: ${LIMIT === Infinity ? '无限制' : LIMIT}`);
    console.log(`仅筛选: ${FILTER_ONLY}`);
    console.log('');

    // 1. 读取论文列表
    const papersData = readJsonSafe(JSON_FILE, []);
    if (!Array.isArray(papersData) || papersData.length === 0) {
        console.error('论文列表为空或格式错误');
        process.exit(1);
    }
    console.log(`论文总数: ${papersData.length}`);

    // 2. 映射 PDF 路径
    let mapped, unmatched;

    if (SKIP_FILTER) {
        // 读取已有筛选结果，用 arnumber 过滤后重新做 PDF 映射
        const filteredFile = RESULT_FILE.replace('.json', '-filtered.json');
        const filteredData = readJsonSafe(filteredFile, null);
        if (filteredData && Array.isArray(filteredData.papers)) {
            const filteredIds = new Set(filteredData.papers.map(p => String(p.arnumber)));
            const filteredPapersData = papersData.filter(p => filteredIds.has(String(p.arnumber)));
            const r = buildPdfPathMapping(filteredPapersData, PAPERS_DIR);
            mapped = r.mapped;
            unmatched = r.unmatched;
            console.log(`PDF 映射成功: ${mapped.length}/${filteredPapersData.length} (从筛选结果)`);
        } else {
            console.log('未找到筛选结果文件，回退到全部论文');
            const r = buildPdfPathMapping(papersData, PAPERS_DIR);
            mapped = r.mapped;
            unmatched = r.unmatched;
            console.log(`PDF 映射成功: ${mapped.length}/${papersData.length}`);
        }
    } else {
        const r = buildPdfPathMapping(papersData, PAPERS_DIR);
        mapped = r.mapped;
        unmatched = r.unmatched;
        console.log(`PDF 映射成功: ${mapped.length}/${papersData.length}`);
        if (unmatched.length > 0) {
            console.log(`  未匹配: ${unmatched.length} 篇`);
            for (const t of unmatched.slice(0, 5)) {
                console.log(`    - ${t}`);
            }
        }
    }

    // 3. 应用偏移和限制
    let papersToProcess = mapped;
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
    const existingIds = new Set(existingPapers.filter(p => p.analysis).map(p => normalizedId(p)));
    console.log(`已有分析结果: ${existingIds.size} 篇`);

    // 过滤掉已分析的
    const notAnalyzed = papersToProcess.filter(p => !existingIds.has(normalizedId(p)));
    console.log(`未分析论文: ${notAnalyzed.length} 篇`);

    if (notAnalyzed.length === 0) {
        console.log('所有论文已分析完成！');
        return;
    }

    // 5. 筛选阶段
    let papersToAnalyze = notAnalyzed;

    if (!SKIP_FILTER) {
        console.log('\n=== 筛选阶段（纯 LLM，标题 + PDF 摘要）===');

        // 确保 filter IO 目录存在
        if (!fs.existsSync(FILTER_IO_DIR)) {
            fs.mkdirSync(FILTER_IO_DIR, { recursive: true });
        }

        // 尝试读取已有的 snippets 中间结果
        const existingSnippets = readJsonSafe(SNIPPETS_FILE, null);
        const snippetMap = new Map();
        if (existingSnippets && Array.isArray(existingSnippets.papers)) {
            console.log(`读取已有 snippets: ${existingSnippets.papers.length} 篇`);
            for (const s of existingSnippets.papers) {
                if (s.paper_id && s.snippet !== undefined) {
                    snippetMap.set(s.paper_id, s.snippet);
                }
            }
        }

        // 提取文本片段（未缓存的才提取）
        let extractedCount = 0;
        for (let i = 0; i < notAnalyzed.length; i++) {
            const p = notAnalyzed[i];
            const pid = p.arnumber || p.paper_id || normalizedId(p);
            const cached = snippetMap.get(pid);
            if (cached !== undefined) {
                p._snippet = cached;
                continue;
            }
            if (extractedCount % 50 === 0) {
                process.stdout.write(`\r  提取中... ${i + 1}/${notAnalyzed.length} (新提取 ${extractedCount})`);
            }
            try {
                const snippet = await extractPdfSnippet(p.pdfPath, 3000);
                p._snippet = snippet;
                snippetMap.set(pid, snippet);
                extractedCount++;
            } catch (e) {
                p._snippet = '';
                snippetMap.set(pid, '');
                extractedCount++;
            }
        }
        console.log(`\r  提取完成: ${notAnalyzed.length}/${notAnalyzed.length} (新提取 ${extractedCount})`);

        // 保存 snippets 中间结果
        if (extractedCount > 0) {
            const snippetsData = {
                timestamp: getBeijingISOString(),
                papers: Array.from(snippetMap.entries()).map(([paper_id, snippet]) => ({ paper_id, snippet }))
            };
            writeFileAtomic(SNIPPETS_FILE, JSON.stringify(snippetsData, null, 2));
            console.log(`snippets 已保存: ${SNIPPETS_FILE} (${snippetMap.size} 篇)`);
        }

        // 纯 LLM 筛选（全部走单篇判断）
        papersToAnalyze = await llmFilterPapers(notAnalyzed);

        // 保存筛选结果
        const filterResultFile = RESULT_FILE.replace('.json', '-filtered.json');
        writeFileAtomic(filterResultFile, JSON.stringify({
            timestamp: getBeijingISOString(),
            total: notAnalyzed.length,
            selected: papersToAnalyze.length,
            papers: papersToAnalyze.map(p => ({
                arnumber: p.arnumber,
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
            console.log(`\n--- [${idx + 1}/${total}] 分析: ${paper.arnumber} ---`);
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
            // results 中已经是论文对象（不是 {success, result}）
            const resultMap = new Map();
            for (const paper of results) {
                const key = normalizedId(paper);
                if (key) resultMap.set(key, paper);
            }

            // 合并到已有结果
            const mergedMap = new Map();
            for (const p of existingPapers) {
                const key = normalizedId(p);
                if (key) mergedMap.set(key, p);
            }
            for (const [key, paper] of resultMap) {
                mergedMap.set(key, paper);
            }

            const allPapers = Array.from(mergedMap.values());
            await saver(allPapers, saveStats);
            console.log(`   已保存到 ${RESULT_FILE} (总计 ${allPapers.length} 篇)`);
        }
    });

    console.log('\n=== 批量分析完成 ===');
    console.log(`成功: ${stats.success} | 失败: ${stats.failed} | 总计处理: ${papersToAnalyze.length}`);

    // 最终统计
    const finalResult = readJsonSafe(RESULT_FILE, null);
    if (finalResult && finalResult.papers) {
        const analyzed = finalResult.papers.filter(p => p.analysis);
        console.log(`累计分析完成: ${analyzed.length}/${finalResult.papers.length} 篇`);
    }
}

main().catch(err => {
    console.error('批量分析异常:', err);
    process.exit(1);
});
