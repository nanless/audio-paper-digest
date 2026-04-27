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
 *   ICASSP_PAPERS_DIR   - PDF 论文目录 (默认: /Users/francis7999/Documents/icassp-2026-papers/papers_2026)
 *   ICASSP_JSON_FILE    - 论文 JSON 文件 (默认: /Users/francis7999/Documents/icassp-2026-papers/papers_2026.json)
 *   ICASSP_RESULT_FILE  - 结果保存路径 (默认: data/current/icassp-2026-analysis.json)
 *   ICASSP_SKIP_FILTER  - 跳过筛选阶段，直接分析所有论文 (默认: false)
 *   ICASSP_OFFSET       - 从第 N 篇开始分析（用于断点续传）
 *   ICASSP_LIMIT        - 最多分析 N 篇（用于分批）
 *   ICASSP_FILTER_ONLY  - 只执行筛选，不深度分析
 */

const fs = require('fs');
const path = require('path');
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

const PAPERS_DIR = process.env.ICASSP_PAPERS_DIR || '/Users/francis7999/Documents/icassp-2026-papers/papers_2026';
const JSON_FILE = process.env.ICASSP_JSON_FILE || '/Users/francis7999/Documents/icassp-2026-papers/papers_2026.json';
const RESULT_FILE = process.env.ICASSP_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icassp-2026-analysis.json');
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
// 筛选：基于 PDF 内容判断是否与音频/语音相关
// ═══════════════════════════════════════════════════════

/**
 * 从 PDF 提取前 N 个字符的文本（用于快速筛选）
 */
async function extractPdfSnippet(pdfPath, maxChars = 5000) {
    try {
        const result = await extractPdfContent(pdfPath);
        return result.text ? result.text.substring(0, maxChars) : '';
    } catch (e) {
        return '';
    }
}

/**
 * 快速关键词预筛选（无需 LLM）
 * 基于标题和 PDF 前 3000 字符进行关键词匹配
 *
 * 策略：
 * 1. 强包含：明确的音频/语音/音乐关键词 → 直接包含
 * 2. 强排除：明确的 CV/NLP/其他领域关键词（仅在标题中）→ 直接排除
 * 3. 弱包含：信号处理相关关键词 → 如果同时有音频上下文则包含
 * 4. 其余 → 不确定（可选 LLM 筛选）
 */
function keywordPreFilter(papers) {
    // 强包含：明确的音频/语音/音乐关键词
    const strongInclude = [
        'audio', 'speech', 'voice', 'sound', 'acoustic', 'listening',
        'speaker', 'spoken', 'verbal', 'vocal', 'utterance', 'pronunciation',
        'music', 'musical', 'song', 'singing', 'melody', 'timbre', 'harmonic',
        'asr', 'tts', 'text-to-speech', 'speech-to-text',
        'speech enhancement', 'speech separation', 'speech recognition',
        'speech synthesis', 'voice conversion', 'voice cloning',
        'speaker recognition', 'speaker verification', 'speaker diarization',
        'audio generation', 'audio synthesis', 'audio classification',
        'audio event detection', 'sound event detection',
        'music generation', 'music information retrieval',
        'reverberation', 'dereverberation', 'denoising',
        '声', '音', '语', '歌', '唱', '话', '说',
    ];

    // 强排除：明确的非音频领域（仅在标题中出现时排除）
    const strongExclude = [
        'image', 'video', 'visual', 'object detection', 'instance segmentation',
        'semantic segmentation', 'face recognition', 'face detection',
        'pose estimation', 'camera', 'photograph', 'rendering', 'graphics',
        'text generation', 'machine translation', 'question answering',
        'recommendation system', 'federated learning',
        'mri', 'ct scan', 'medical imaging', 'x-ray',
        'radar', 'lidar', 'sar',
    ];

    // 弱信号：信号处理相关（结合上下文判断）
    const weakSignal = [
        'signal', 'filter', 'spectrum', 'spectral', 'frequency', 'waveform',
        'time-domain', 'frequency-domain', 'fft', 'stft',
    ];

    const results = [];
    for (const paper of papers) {
        const title = (paper.title || '').toLowerCase();
        const text = (paper._snippet || '').toLowerCase();
        const combined = title + ' ' + text;

        // 1. 强包含检查
        const hasStrongInclude = strongInclude.some(kw => combined.includes(kw.toLowerCase()));
        if (hasStrongInclude) {
            results.push({ ...paper, _preFilter: 'include' });
            continue;
        }

        // 2. 强排除检查（仅在标题中）
        const hasStrongExclude = strongExclude.some(kw => title.includes(kw.toLowerCase()));
        if (hasStrongExclude) {
            results.push({ ...paper, _preFilter: 'exclude' });
            continue;
        }

        // 3. 弱信号检查：如果有信号处理关键词且文本中有音频相关词
        const hasWeakSignal = weakSignal.some(kw => combined.includes(kw.toLowerCase()));
        const textHasAudio = strongInclude.some(kw => text.includes(kw.toLowerCase()));
        if (hasWeakSignal && textHasAudio) {
            results.push({ ...paper, _preFilter: 'include' });
            continue;
        }

        // 4. 不确定
        results.push({ ...paper, _preFilter: 'uncertain' });
    }

    return results;
}

/**
 * LLM 筛选：对不确定的论文进行精确判断
 */
async function llmFilterPapers(papers, batchSize = 5) {
    loadEnvFile();

    const FILTER_CONFIG = {
        endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
        key: process.env.PAPER_ANALYZER_API_KEY || '',
        model: process.env.PAPER_ANALYZER_MODEL || ''
    };

    if (!FILTER_CONFIG.endpoint || !FILTER_CONFIG.key || !FILTER_CONFIG.model) {
        console.log('[filter] 缺少 API 配置，跳过 LLM 筛选');
        return papers.filter(p => p._preFilter === 'include');
    }

    const uncertainPapers = papers.filter(p => p._preFilter === 'uncertain');
    const includedPapers = papers.filter(p => p._preFilter === 'include');

    console.log(`[filter] 关键词预筛选: 包含 ${includedPapers.length} 篇, 排除 ${papers.filter(p => p._preFilter === 'exclude').length} 篇, 不确定 ${uncertainPapers.length} 篇`);

    if (uncertainPapers.length === 0) {
        return includedPapers;
    }

    // 使用轻量级 prompt 进行批量筛选
    const promptTemplate = loadPrompt('prompts/filter.md');

    const filtered = [...includedPapers];

    for (let i = 0; i < uncertainPapers.length; i += batchSize) {
        const batch = uncertainPapers.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(uncertainPapers.length / batchSize);

        console.log(`[filter] 批次 ${batchNum}/${totalBatches}: ${batch.length} 篇`);

        // 构建批量筛选 prompt
        let batchPrompt = '请判断以下论文是否与语音、音频、声音处理相关。对每篇论文只回答"是"或"否"。\n\n';
        for (let j = 0; j < batch.length; j++) {
            const p = batch[j];
            batchPrompt += `--- 论文 ${j + 1} ---\n标题: ${p.title}\n摘要: ${p._snippet?.substring(0, 1000) || '(无摘要)'}\n\n`;
        }
        batchPrompt += '请按以下格式输出（每行一篇）：\n1. 是/否\n2. 是/否\n...';

        try {
            const result = await callFilterModel(batchPrompt, FILTER_CONFIG);
            const lines = result.split('\n').map(l => l.trim()).filter(l => l);

            for (let j = 0; j < batch.length; j++) {
                const line = lines[j] || '';
                const isRelevant = /是|yes|y/i.test(line) && !/否|no|n/i.test(line);
                if (isRelevant) {
                    filtered.push(batch[j]);
                }
            }
        } catch (e) {
            console.log(`[filter] 批次 ${batchNum} 筛选失败: ${e.message}，默认全部包含`);
            filtered.push(...batch);
        }

        if (i + batchSize < uncertainPapers.length) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    console.log(`[filter] LLM 筛选完成: ${filtered.length}/${papers.length} 篇相关`);
    return filtered;
}

async function callFilterModel(prompt, config) {
    const apiType = detectApiType(config.endpoint, config.model);
    const modelUrl = buildApiUrl(apiType, config.endpoint);
    const url = new URL(modelUrl);

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
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);
                    if (content !== null) {
                        resolve(content);
                    } else {
                        reject(new Error('Invalid response'));
                    }
                } catch (e) {
                    reject(new Error('Parse error'));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
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
    const { mapped, unmatched } = buildPdfPathMapping(papersData, PAPERS_DIR);
    console.log(`PDF 映射成功: ${mapped.length}/${papersData.length}`);
    if (unmatched.length > 0) {
        console.log(`  未匹配: ${unmatched.length} 篇`);
        for (const t of unmatched.slice(0, 5)) {
            console.log(`    - ${t}`);
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
        console.log('\n=== 筛选阶段 ===');
        console.log('提取 PDF 文本片段用于筛选...');

        // 提取文本片段
        for (let i = 0; i < notAnalyzed.length; i++) {
            const p = notAnalyzed[i];
            if (i % 50 === 0) {
                process.stdout.write(`\r  提取中... ${i + 1}/${notAnalyzed.length}`);
            }
            try {
                const snippet = await extractPdfSnippet(p.pdfPath, 3000);
                p._snippet = snippet;
            } catch (e) {
                p._snippet = '';
            }
        }
        console.log(`\r  提取完成: ${notAnalyzed.length}/${notAnalyzed.length}`);

        // 关键词预筛选
        const preFiltered = keywordPreFilter(notAnalyzed);

        // LLM 筛选（仅对不确定的）
        papersToAnalyze = await llmFilterPapers(preFiltered);

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
