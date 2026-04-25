#!/usr/bin/env node
/**
 * Paper Digest 统一分析引擎
 * 封装：单篇分析(重试+解析)、批量分析、增量保存
 * 消除 full-fetch.js / deep-analysis-only.js / batch-analyze.js / reanalyze.js / analyze-single-paper.js 的重复逻辑
 */

const { analyzePaperDeep } = require('./deep-analyzer.js');
const { parseAnalysis, writeFileAtomic, readJsonSafe, getBeijingISOString, normalizedId } = require('./utils.js');
const { ANALYSIS_CONFIG } = require('./config.js');

// ═══════════════════════════════════════════════════════
// 默认配置常量（从 config.js 读取）
// ═══════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = ANALYSIS_CONFIG.maxRetries;
const DEFAULT_RETRY_DELAY_MS = ANALYSIS_CONFIG.retryDelayMs;
const DEFAULT_CONCURRENCY = ANALYSIS_CONFIG.concurrency;

// ═══════════════════════════════════════════════════════
// 单篇分析（带重试 + 解析）
// ═══════════════════════════════════════════════════════

/**
 * 分析单篇论文，带重试和自动解析
 * @param {Object} paper - 论文对象，需包含 arxivId 和 title
 * @param {Object} options - 选项
 * @param {number} options.maxRetries - 最大重试次数，默认 2
 * @param {number} options.retryDelayMs - 重试间隔(ms)，默认 3000
 * @param {Function} options.onAttempt - 每次尝试的回调 (attempt, maxRetries, paper) => void
 * @param {Function} options.onRetry - 重试时的回调 (attempt, error, paper) => void
 * @returns {Promise<Object>} { success: boolean, result?: Object, error?: string, parsed?: Object }
 */
async function analyzePaperWithRetry(paper, options = {}) {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        onAttempt = null,
        onRetry = null
    } = options;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (onAttempt) {
            onAttempt(attempt, maxRetries, paper);
        }

        try {
            const analyzed = await analyzePaperDeep(paper);

            if (analyzed && analyzed.analysis) {
                const parsed = parseAnalysis(analyzed.analysis);
                return {
                    success: true,
                    result: {
                        ...paper,
                        analysis: analyzed.analysis,
                        parsed: parsed,
                        imageUrls: analyzed.imageUrls || paper.imageUrls || [],
                        allImageUrls: analyzed.allImageUrls || paper.allImageUrls || [],
                        error: null
                    },
                    parsed: parsed
                };
            } else if (analyzed && analyzed.error) {
                lastError = analyzed.error;
                if (attempt < maxRetries) {
                    if (onRetry) onRetry(attempt + 1, new Error(analyzed.error), paper);
                    await sleep(retryDelayMs);
                }
            } else {
                lastError = '无分析结果';
                if (attempt < maxRetries) {
                    if (onRetry) onRetry(attempt + 1, new Error('无分析结果'), paper);
                    await sleep(retryDelayMs);
                }
            }
        } catch (error) {
            lastError = error.message;
            if (attempt < maxRetries) {
                if (onRetry) onRetry(attempt + 1, error, paper);
                await sleep(retryDelayMs);
            }
        }
    }

    return {
        success: false,
        error: lastError || '分析失败',
        result: {
            ...paper,
            analysis: null,
            parsed: null,
            error: lastError || '分析失败'
        }
    };
}

// ═══════════════════════════════════════════════════════
// 批量分析（支持并发 + 增量保存回调）
// ═══════════════════════════════════════════════════════

/**
 * 批量分析论文
 * @param {Object[]} papers - 论文列表
 * @param {Object} options - 选项
 * @param {number} options.concurrency - 并发数，默认 3
 * @param {number} options.maxRetries - 单篇最大重试次数，默认 2
 * @param {number} options.retryDelayMs - 重试间隔(ms)，默认 3000
 * @param {number} options.saveInterval - 每 N 篇保存一次（0=不自动保存），默认 0
 * @param {Function} options.onPaperStart - 单篇开始回调 (index, total, paper) => void
 * @param {Function} options.onPaperDone - 单篇完成回调 (index, total, paper, result, durationMs) => void
 * @param {Function} options.onBatchDone - 每批完成回调 (batchIndex, batchResults) => void
 * @param {Function} options.onSave - 保存回调 (results, stats) => Promise<void> | void
 * @param {Function} options.shouldSkip - 是否跳过某篇 (paper) => boolean
 * @returns {Promise<Object>} { results: Object[], stats: Object }
 */
async function analyzeBatch(papers, options = {}) {
    const {
        concurrency = DEFAULT_CONCURRENCY,
        maxRetries = DEFAULT_MAX_RETRIES,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        saveInterval = 0,
        onPaperStart = null,
        onPaperDone = null,
        onBatchDone = null,
        onSave = null,
        shouldSkip = null,
        onAttempt = null
    } = options;

    const results = [];
    const stats = {
        total: papers.length,
        success: 0,
        failed: 0,
        skipped: 0,
        durationTotal: 0
    };

    let processedCount = 0;

    for (let i = 0; i < papers.length; i += concurrency) {
        const batch = papers.slice(i, i + concurrency);
        const batchNum = Math.floor(i / concurrency) + 1;
        const totalBatches = Math.ceil(papers.length / concurrency);

        const batchPromises = batch.map(async (paper, j) => {
            const idx = i + j;

            try {
                if (shouldSkip) {
                    const skip = shouldSkip(paper);
                    if (skip) {
                        stats.skipped++;
                        if (onPaperDone) {
                            try { onPaperDone(idx, papers.length, paper, { skipped: true }, 0); } catch (e) { /* ignore callback error */ }
                        }
                        return { skipped: true, paper };
                    }
                }
            } catch (e) {
                console.error(`[analyzeBatch] shouldSkip 回调异常: ${e.message}`);
            }

            if (onPaperStart) {
                try { onPaperStart(idx, papers.length, paper); } catch (e) { /* ignore callback error */ }
            }

            const startTime = Date.now();
            const r = await analyzePaperWithRetry(paper, {
                maxRetries,
                retryDelayMs,
                onAttempt: (att, max) => {
                    if (onAttempt) {
                        try { onAttempt(att, max, paper); } catch (e) { /* ignore */ }
                    }
                }
            });
            const duration = Date.now() - startTime;
            stats.durationTotal += duration;

            if (r.success) {
                stats.success++;
            } else {
                stats.failed++;
            }

            if (onPaperDone) {
                try { onPaperDone(idx, papers.length, paper, r, duration); } catch (e) { /* ignore callback error */ }
            }

            return r;
        });

        let batchResults;
        try {
            batchResults = await Promise.all(batchPromises);
        } catch (e) {
            console.error(`[analyzeBatch] 批次 ${batchNum} 执行失败: ${e.message}`);
            batchResults = [];
        }

        for (const r of batchResults) {
            if (!r || !r.skipped) {
                results.push(r?.result || r);
            }
        }

        if (onBatchDone) {
            try { onBatchDone(batchNum, batchResults); } catch (e) { /* ignore callback error */ }
        }

        processedCount += batch.filter(p => {
            if (!shouldSkip) return true;
            try { return !shouldSkip(p); } catch (e) { return true; }
        }).length;

        // 增量保存
        if (saveInterval > 0 && onSave && processedCount > 0 && processedCount % saveInterval === 0) {
            await onSave(results, { ...stats, savedAt: getBeijingISOString() });
        }
    }

    // 最终保存
    if (onSave) {
        await onSave(results, { ...stats, savedAt: getBeijingISOString() });
    }

    return { results, stats };
}

// ═══════════════════════════════════════════════════════
// 增量保存辅助
// ═══════════════════════════════════════════════════════

/**
 * 将分析结果合并到数据文件（按 arxivId 去重）
 * @param {Object[]} newResults - 新的分析结果列表
 * @param {string} filePath - 目标文件路径
 * @param {Object} extraData - 额外写入的顶层字段（如 stats, timestamp 等）
 */
async function mergeAndSaveResults(newResults, filePath, extraData = {}) {
    const existingData = readJsonSafe(filePath, null);
    const existingPapers = existingData ? (existingData.papers || []) : [];

    const mergedMap = new Map();

    for (const paper of existingPapers) {
        const key = normalizedId(paper);
        if (key) {
            mergedMap.set(key, paper);
        } else {
            console.warn(`[mergeAndSaveResults] 跳过无法识别 ID 的论文: ${paper.title || '(无标题)'}`);
        }
    }

    for (const paper of newResults) {
        const key = normalizedId(paper);
        if (key) {
            const existing = mergedMap.get(key);
            if (existing && existing.analysis && !paper.analysis) {
                continue;
            }
            mergedMap.set(key, paper);
        } else {
            console.warn(`[mergeAndSaveResults] 跳过无法识别 ID 的论文: ${paper.title || '(无标题)'}`);
        }
    }

    const mergedPapers = Array.from(mergedMap.values());

    const output = {
        timestamp: getBeijingISOString(),
        ...extraData,
        papers: mergedPapers
    };

    writeFileAtomic(filePath, JSON.stringify(output, null, 2));
    return { totalMerged: mergedPapers.length, existingCount: existingPapers.length, newCount: newResults.length };
}

/**
 * 创建简单的文件保存回调（适用于逐篇保存场景）
 * @param {string} filePath - 文件路径
 * @param {Object} baseData - 基础数据结构（会被浅合并）
 */
function createFileSaver(filePath, baseData = {}) {
    return async (results, stats) => {
        const existing = readJsonSafe(filePath, null);
        const isLegacyArray = Array.isArray(existing);
        const existingPapers = isLegacyArray ? existing : (existing && existing.papers);
        const existingStats = !isLegacyArray && existing && existing.stats ? existing.stats : null;
        const output = {
            ...(!isLegacyArray && existing ? existing : {}),
            ...baseData,
            lastUpdated: getBeijingISOString(),
            papers: existingPapers ? mergePapersById(existingPapers, results) : results,
            stats: existingStats ? { ...existingStats, ...stats } : stats
        };
        writeFileAtomic(filePath, JSON.stringify(output, null, 2));
    };
}

// 辅助：合并论文列表（按 ID 去重，新的覆盖旧的）
function mergePapersById(existingPapers, newPapers) {
    const map = new Map();
    for (const p of existingPapers) {
        const key = normalizedId(p);
        if (key) {
            map.set(key, p);
        } else {
            console.warn(`[mergePapersById] 跳过无法识别 ID 的论文: ${p.title || '(无标题)'}`);
        }
    }
    for (const p of newPapers) {
        const key = normalizedId(p);
        if (key) {
            map.set(key, p);
        } else {
            console.warn(`[mergePapersById] 跳过无法识别 ID 的论文: ${p.title || '(无标题)'}`);
        }
    }
    return Array.from(map.values());
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    analyzePaperWithRetry,
    analyzeBatch,
    mergeAndSaveResults,
    createFileSaver,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_DELAY_MS,
    DEFAULT_CONCURRENCY
};
