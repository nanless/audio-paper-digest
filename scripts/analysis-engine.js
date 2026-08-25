#!/usr/bin/env node
/**
 * Paper Digest 统一分析引擎
 * 封装：单篇分析(重试+解析)、批量分析、增量保存
 * 消除 full-fetch.js / deep-analysis-only.js / batch-analyze.js / reanalyze.js / analyze-single-paper.js 的重复逻辑
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseAnalysis, writeFileAtomic, getBeijingISOString, normalizedId } = require('./utils.js');
const { ANALYSIS_CONFIG } = require('./config.js');
const {
    getInvalidAnalysisReason,
    hasRequiredSections,
    analysisManifestRequiresExperimentTableContract,
    analysisManifestRequiresMethodDetailContract,
    REQUIRED_RECOVERY_STAGES,
    isRecoveryStageTerminal,
    validateManualTakeoverManifest
} = require('./analysis-contract.js');

// ═══════════════════════════════════════════════════════
// 默认配置常量（从 config.js 读取）
// ═══════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = ANALYSIS_CONFIG.maxRetries;
const DEFAULT_RETRY_DELAY_MS = ANALYSIS_CONFIG.retryDelayMs;
const DEFAULT_CONCURRENCY = ANALYSIS_CONFIG.concurrency;
const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const PAPER_ANALYSIS_LOCK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const PAPER_ANALYSIS_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const ANALYSIS_CHECKPOINT_CALLBACK = Symbol.for('audio-paper-digest.analysisCheckpointCallback');
const ANALYSIS_RECOVERY_FIELDS = Object.freeze([
    'analysis', 'parsed', 'analysisManifest', 'analysisCheckpoint', 'analysisStageCheckpoints',
    'analysisRecoveryImageManifest', 'imageManifest', 'selectedImageUrls', 'imageUrls', 'allImageUrls',
    'analysisSource', 'sourceId', 'sourceTextChars', 'usedTextChars', 'fullTextChars',
    'fullTextAvailable', 'truncated', 'sourceSha256', 'usedTextSha256', 'analysisConfidence',
    'htmlAvailability', 'htmlAttempts', 'sourceWarnings', 'latestAnalysisAttemptError',
    'latestAnalysisAttemptAt'
]);

function readJsonFileStrict(filePath, options = {}) {
    const { allowMissing = false } = options;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed === null || (typeof parsed !== 'object')) {
            throw new Error('顶层必须是对象或数组');
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT' && allowMissing) return null;
        if (error.code === 'ENOENT') {
            throw new Error(`JSON 文件不存在: ${filePath}`);
        }
        throw new Error(`JSON 文件损坏或不可读，已阻止覆盖 ${filePath}: ${error.message}`);
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function canReclaimFileLock(lockPath, staleMs) {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        if (owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
                process.kill(owner.pid, 0);
                return false;
            } catch (error) {
                if (error.code === 'ESRCH') return true;
                if (error.code === 'EPERM') return false;
                throw error;
            }
        }
        if (owner.hostname) return ageMs > staleMs;
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return ageMs > staleMs;
}

function createLockRelease(lockPath, ownerToken) {
    const heartbeat = setInterval(() => {
        try {
            const ownerPath = path.join(lockPath, 'owner.json');
            const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            if (owner.token !== ownerToken) {
                clearInterval(heartbeat);
                return;
            }
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
        } catch (error) {
            if (error.code === 'ENOENT') clearInterval(heartbeat);
        }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    return () => {
        clearInterval(heartbeat);
        try {
            const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
            if (owner.token !== ownerToken) return false;
            fs.rmSync(lockPath, { recursive: true, force: true });
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            console.warn(`[file-lock] 释放锁失败 ${lockPath}: ${error.message}`);
            return false;
        }
    };
}

function acquireFileLockSync(filePath, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const startedAt = Date.now();

    while (true) {
        try {
            fs.mkdirSync(lockPath);
            const ownerToken = crypto.randomUUID();
            try {
                fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                    pid: process.pid,
                    hostname: os.hostname(),
                    token: ownerToken,
                    acquiredAt: new Date().toISOString()
                }));
            } catch (ownerError) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw ownerError;
            }
            return createLockRelease(lockPath, ownerToken);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (canReclaimFileLock(lockPath, staleMs)) {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    continue;
                }
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`等待文件锁超时: ${lockPath}`);
            }
            sleepSync(50);
        }
    }
}

async function acquireFileLock(filePath, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
        try {
            fs.mkdirSync(lockPath);
            const ownerToken = crypto.randomUUID();
            try {
                fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                    pid: process.pid,
                    hostname: os.hostname(),
                    token: ownerToken,
                    acquiredAt: new Date().toISOString()
                }));
            } catch (ownerError) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw ownerError;
            }
            return createLockRelease(lockPath, ownerToken);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (canReclaimFileLock(lockPath, staleMs)) {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    continue;
                }
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待文件锁超时: ${lockPath}`);
            await sleep(50);
        }
    }
}

function withFileLockSync(filePath, callback, options = {}) {
    const release = acquireFileLockSync(filePath, options);
    try {
        return callback();
    } finally {
        release();
    }
}

async function withFileLock(filePath, callback, options = {}) {
    const release = await acquireFileLock(filePath, options);
    try {
        return await callback();
    } finally {
        release();
    }
}

function getPaperAnalysisLockPath(paper) {
    const id = normalizedId(paper);
    if (!id) throw new Error('无法为缺少规范化 ID 的论文创建分析锁');
    return path.join(__dirname, '..', 'data', 'current', '.analysis-runs', id);
}

async function withPaperAnalysisLock(paper, callback, options = {}) {
    return withFileLock(getPaperAnalysisLockPath(paper), callback, {
        timeoutMs: PAPER_ANALYSIS_LOCK_TIMEOUT_MS,
        staleMs: PAPER_ANALYSIS_LOCK_STALE_MS,
        ...options
    });
}

function updateJsonFileLocked(filePath, updater, options = {}) {
    return withFileLockSync(filePath, () => {
        const current = readJsonFileStrict(filePath, { allowMissing: options.allowMissing !== false });
        const next = updater(current);
        if (next && typeof next.then === 'function') {
            throw new Error('updateJsonFileLocked 的 updater 必须是同步函数');
        }
        if (next === undefined) return current;
        const currentGeneration = Number.isInteger(current?.generation) ? current.generation : 0;
        if (next && !Array.isArray(next) && typeof next === 'object') {
            next.generation = currentGeneration + 1;
        }
        writeFileAtomic(filePath, JSON.stringify(next, null, 2));
        return next;
    }, options);
}

function initializeJsonFileLocked(filePath, fallbackValue, options = {}) {
    return updateJsonFileLocked(filePath, current => (
        current === null ? fallbackValue : undefined
    ), options);
}

function isCompleteAnalysisContent(paper) {
    if (!hasValidAnalysisBody(paper)) return false;
    if (!paper.analysisManifest || paper.analysisManifest.version !== 1) return false;
    const stages = paper.analysisManifest.stages;
    if (!stages || typeof stages !== 'object' || REQUIRED_RECOVERY_STAGES.some(stage =>
        !isRecoveryStageTerminal(stage, stages[stage]?.status))) {
        return false;
    }
    if (validateManualTakeoverManifest(
        paper.analysisManifest,
        paper.analysisManifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
        { analysis: paper.analysis, imageManifest: paper.imageManifest }
    )) return false;
    return true;
}

function isSuccessfulAnalysisRecord(paper) {
    if (paper?.latestAnalysisAttemptError
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        return false;
    }
    return isCompleteAnalysisContent(paper);
}

function hasValidAnalysisBody(paper) {
    if (!paper || typeof paper.analysis !== 'string' || !paper.analysis.trim()) return false;
    // Recovery manifests describe the latest attempt, not whether an older body is usable.
    // Re-parse the body independently so repeated failed saves cannot erase valid content.
    try {
        const parsed = parseAnalysis(paper.analysis);
        return !getInvalidAnalysisReason(paper.analysis, parsed, {
            enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                paper.analysisManifest
            ),
            experimentTableContractVersion: paper.analysisManifest?.contracts?.experimentTables,
            enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                paper.analysisManifest
            )
        });
    } catch (error) {
        return false;
    }
}

function getAnalysisRunStatus(stats = {}, remainingFailures = stats.failed || 0) {
    const failed = Number(remainingFailures) || 0;
    const success = Number(stats.success) || 0;
    if (failed <= 0) return 'complete';
    return success > 0 ? 'partial_failed' : 'failed';
}

function getCanonicalAnalysisRunSummary(papers) {
    const records = Array.isArray(papers) ? papers : [];
    const remaining = records.filter(paper => !isSuccessfulAnalysisRecord(paper)).length;
    const success = records.length - remaining;
    return { success, remaining, status: getAnalysisRunStatus({ success }, remaining) };
}

function getAnalysisExitCode(status) {
    if (status === 'complete') return 0;
    if (status === 'partial_failed') return 2;
    return 1;
}

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
        onRetry = null,
        analyzeFn = null,
        onCheckpoint = null
    } = options;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (onAttempt) {
            onAttempt(attempt, maxRetries, paper);
        }

        try {
            const analyzePaperDeep = analyzeFn || require('./deep-analyzer.js').analyzePaperDeep;
            if (onCheckpoint) {
                Object.defineProperty(paper, ANALYSIS_CHECKPOINT_CALLBACK, {
                    value: onCheckpoint,
                    configurable: true,
                    enumerable: false
                });
            }
            let analyzed;
            try {
                analyzed = await analyzePaperDeep(paper);
            } finally {
                delete paper[ANALYSIS_CHECKPOINT_CALLBACK];
            }
            if (analyzed && typeof analyzed === 'object') {
                Object.assign(paper, analyzed);
            }

            if (analyzed && analyzed.analysis) {
                const parsed = parseAnalysis(analyzed.analysis);
                const invalidReason = getInvalidAnalysisReason(analyzed.analysis, parsed, {
                    enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                        analyzed.analysisManifest || paper.analysisManifest
                    ),
                    experimentTableContractVersion: (
                        analyzed.analysisManifest || paper.analysisManifest
                    )?.contracts?.experimentTables,
                    enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                        analyzed.analysisManifest || paper.analysisManifest
                    )
                });
                const recoveryReason = isCompleteAnalysisContent(analyzed)
                    ? null
                    : '分析恢复阶段未全部进入各自允许的终态';
                const rejectionReason = invalidReason || recoveryReason;
                if (rejectionReason) {
                    lastError = rejectionReason;
                    if (attempt < maxRetries) {
                        if (onRetry) onRetry(attempt + 1, new Error(rejectionReason), paper);
                        await sleep(retryDelayMs);
                    }
                    continue;
                }
                const successfulResult = {
                    success: true,
                    result: {
                        ...paper,
                        analysis: analyzed.analysis,
                        parsed: parsed,
                        scoringRubricVersion: parsed.scoringRubricVersion || '',
                        selectedImageUrls: analyzed.selectedImageUrls || [],
                        imageUrls: analyzed.imageUrls || paper.imageUrls || [],
                        allImageUrls: analyzed.allImageUrls || paper.allImageUrls || [],
                        imageManifest: analyzed.imageManifest || paper.imageManifest || null,
                        analysisRecoveryImageManifest: analyzed.analysisRecoveryImageManifest
                            || paper.analysisRecoveryImageManifest
                            || analyzed.imageManifest
                            || paper.imageManifest
                            || null,
                        analysisSource: analyzed.analysisSource || paper.analysisSource || 'unknown',
                        sourceId: analyzed.sourceId || paper.sourceId || '',
                        sourceTextChars: analyzed.sourceTextChars ?? paper.sourceTextChars ?? 0,
                        usedTextChars: analyzed.usedTextChars ?? paper.usedTextChars ?? 0,
                        fullTextChars: analyzed.fullTextChars ?? paper.fullTextChars ?? 0,
                        fullTextAvailable: analyzed.fullTextAvailable ?? paper.fullTextAvailable ?? false,
                        truncated: analyzed.truncated ?? paper.truncated ?? false,
                        sourceSha256: analyzed.sourceSha256 || paper.sourceSha256 || '',
                        usedTextSha256: analyzed.usedTextSha256 || paper.usedTextSha256 || '',
                        analysisConfidence: analyzed.analysisConfidence || paper.analysisConfidence || 'unknown',
                        htmlAvailability: analyzed.htmlAvailability || paper.htmlAvailability || 'unknown',
                        htmlAttempts: analyzed.htmlAttempts ?? paper.htmlAttempts ?? 0,
                        sourceWarnings: analyzed.sourceWarnings || paper.sourceWarnings || [],
                        analysisManifest: analyzed.analysisManifest || paper.analysisManifest || null,
                        error: null
                    },
                    parsed: parsed
                };
                delete successfulResult.result.latestAnalysisAttemptError;
                delete successfulResult.result.latestAnalysisAttemptAt;
                if (successfulResult.result.digestStatus?.latestAttemptStatus === 'analysis_failed') {
                    successfulResult.result.digestStatus = {
                        ...successfulResult.result.digestStatus,
                        latestAttemptStatus: 'analyzed',
                        error: null
                    };
                }
                return successfulResult;
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
            error: lastError || '分析失败',
            latestAnalysisAttemptError: lastError || '分析失败',
            latestAnalysisAttemptAt: getBeijingISOString()
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
 * @param {Function} options.analyzeFn - 可选自定义单篇分析函数，默认使用 deep-analyzer.js
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
        onAttempt = null,
        analyzeFn = null,
        preparePaperLocked = null,
        onPaperResultLocked = null,
        onPaperCheckpointLocked = null,
        checkpointFilePath = null
    } = options;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(`[analyzeBatch] concurrency 必须是正整数，收到: ${concurrency}`);
    }
    if (!Array.isArray(papers)) {
        throw new TypeError('[analyzeBatch] papers 必须是数组');
    }

    const results = [];
    const stats = {
        total: papers.length,
        success: 0,
        failed: 0,
        skipped: 0,
        durationTotal: 0,
        sourceCounts: {}
    };

    let processedCount = 0;
    const skipDecisions = new Map();

    const shouldSkipCached = (paper) => {
        if (!shouldSkip) return false;
        const key = normalizedId(paper) || paper;
        if (skipDecisions.has(key)) return skipDecisions.get(key);
        const value = Boolean(shouldSkip(paper));
        skipDecisions.set(key, value);
        return value;
    };

    for (let i = 0; i < papers.length; i += concurrency) {
        const batch = papers.slice(i, i + concurrency);
        const batchNum = Math.floor(i / concurrency) + 1;
        const totalBatches = Math.ceil(papers.length / concurrency);

        const batchPromises = batch.map(async (paper, j) => {
            const idx = i + j;

            try {
                if (shouldSkip) {
                    const skip = shouldSkipCached(paper);
                    if (skip) {
                        stats.skipped++;
                        if (onPaperDone) await onPaperDone(idx, papers.length, paper, { skipped: true }, 0);
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
            const r = await withPaperAnalysisLock(paper, async () => {
                const prepared = preparePaperLocked
                    ? await preparePaperLocked(paper)
                    : { paper, skip: false };
                if (prepared?.skip) {
                    return { skipped: true, paper: prepared.paper || paper, reason: prepared.reason || '已由其他进程完成' };
                }
                const paperForAnalysis = prepared?.paper || paper;
                const result = await analyzePaperWithRetry(paperForAnalysis, {
                    maxRetries,
                    retryDelayMs,
                    analyzeFn,
                    onCheckpoint: checkpoint => {
                        if (onPaperCheckpointLocked) {
                            const returned = onPaperCheckpointLocked(checkpoint);
                            if (returned && typeof returned.then === 'function') {
                                throw new Error('onPaperCheckpointLocked 必须同步完成，以保证崩溃前 checkpoint 已落盘');
                            }
                        } else if (checkpointFilePath) {
                            persistAnalysisCheckpoint(checkpointFilePath, checkpoint);
                        }
                    },
                    onAttempt: (att, max) => {
                        if (onAttempt) {
                            try { onAttempt(att, max, paper); } catch (e) { /* ignore */ }
                        }
                    }
                });
                if (onPaperResultLocked) {
                    await onPaperResultLocked(paperForAnalysis, result);
                }
                return result;
            });
            const duration = Date.now() - startTime;
            if (r.skipped) {
                stats.skipped++;
                if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);
                return r;
            }
            stats.durationTotal += duration;

            if (r.success) {
                stats.success++;
                const source = r.result?.analysisSource || 'unknown';
                stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + 1;
            } else {
                stats.failed++;
            }

            if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);

            return r;
        });

        let batchResults;
        try {
            batchResults = await Promise.all(batchPromises);
        } catch (error) {
            throw new Error(`[analyzeBatch] 批次 ${batchNum}/${totalBatches} 关键回调或执行失败: ${error.message}`, { cause: error });
        }

        for (const r of batchResults) {
            if (!r || !r.skipped) {
                results.push(r?.result || r);
            }
        }

        if (onBatchDone) await onBatchDone(batchNum, batchResults);

        processedCount += batch.filter(p => {
            if (!shouldSkip) return true;
            try { return !shouldSkipCached(p); } catch (e) { return true; }
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

function persistAnalysisCheckpoint(filePath, paper) {
    const checkpoint = {
        ...paper,
        analysis: null,
        parsed: null,
        error: paper.analysisManifest
            ? '深度分析阶段执行中，已保存 checkpoint'
            : (paper.error || '深度分析未完成')
    };
    return updateJsonFileLocked(filePath, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            lastUpdated: getBeijingISOString(),
            status: 'running',
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running'
            },
            papers: mergePapersById(
                Array.isArray(current) ? current : (current?.papers || []),
                [checkpoint],
                { preserveSuccessfulAnalysis: true }
            )
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });
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
    let counts;
    updateJsonFileLocked(filePath, existingData => {
        const existingPapers = Array.isArray(existingData) ? existingData : (existingData?.papers || []);
        const mergedPapers = mergePapersById(existingPapers, newResults, { preserveSuccessfulAnalysis: true });
        counts = { totalMerged: mergedPapers.length, existingCount: existingPapers.length, newCount: newResults.length };
        const payload = {
            ...(existingData && !Array.isArray(existingData) ? existingData : {}),
            timestamp: getBeijingISOString(),
            ...extraData,
            papers: mergedPapers
        };
        if (typeof extraData.status === 'string') {
            payload.stats = {
                ...(existingData && !Array.isArray(existingData) ? existingData.stats : {}),
                ...(extraData.stats || {}),
                analysisStatus: extraData.status
            };
            if (extraData.status !== 'complete') delete payload.deepAnalysisCompletedAt;
        }
        return payload;
    });
    return counts;
}

/**
 * 创建简单的文件保存回调（适用于逐篇保存场景）
 * @param {string} filePath - 文件路径
 * @param {Object} baseData - 基础数据结构（会被浅合并）
 */
function createFileSaver(filePath, baseData = {}) {
    return async (results, stats) => {
        updateJsonFileLocked(filePath, existing => {
            const isLegacyArray = Array.isArray(existing);
            const existingPapers = isLegacyArray ? existing : (existing && existing.papers);
            const existingStats = !isLegacyArray && existing && existing.stats ? existing.stats : null;
            return {
                ...(!isLegacyArray && existing ? existing : {}),
                ...baseData,
                lastUpdated: getBeijingISOString(),
                papers: existingPapers ? mergePapersById(existingPapers, results) : results,
                stats: existingStats ? { ...existingStats, ...stats } : stats
            };
        });
    };
}

// 辅助：合并论文列表（按 ID 去重，新的覆盖旧的）
function mergePapersById(existingPapers, newPapers, options = {}) {
    if (!Array.isArray(existingPapers) || !Array.isArray(newPapers)) {
        throw new Error('分析结果 papers 必须是数组，已阻止覆盖结构异常的 JSON');
    }
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
            const existing = map.get(key);
            if (options.preserveSuccessfulAnalysis
                && hasValidAnalysisBody(existing)
                && !isCompleteAnalysisContent(p)) {
                map.set(key, {
                    ...existing,
                    ...(p.analysisManifest ? { analysisManifest: p.analysisManifest } : {}),
                    ...(typeof p.analysisCheckpoint === 'string' ? { analysisCheckpoint: p.analysisCheckpoint } : {}),
                    ...(p.analysisStageCheckpoints ? { analysisStageCheckpoints: p.analysisStageCheckpoints } : {}),
                    ...(p.analysisRecoveryImageManifest || p.imageManifest
                        ? { analysisRecoveryImageManifest: p.analysisRecoveryImageManifest || p.imageManifest }
                        : {}),
                    ...(p.manualIngestionCheckpoint
                        ? { manualIngestionCheckpoint: p.manualIngestionCheckpoint }
                        : {}),
                    latestAnalysisAttemptError: p.error || '分析未完成',
                    latestAnalysisAttemptAt: getBeijingISOString()
                });
                continue;
            }
            const next = { ...p };
            if (isCompleteAnalysisContent(next)) {
                delete next.latestAnalysisAttemptError;
                delete next.latestAnalysisAttemptAt;
                if (next.digestStatus?.latestAttemptStatus === 'analysis_failed') {
                    next.digestStatus = {
                        ...next.digestStatus,
                        latestAttemptStatus: 'analyzed',
                        error: null
                    };
                }
            }
            map.set(key, next);
        } else {
            console.warn(`[mergePapersById] 跳过无法识别 ID 的论文: ${p.title || '(无标题)'}`);
        }
    }
    return Array.from(map.values());
}

function mergeCanonicalAnalysisState(paper, canonical) {
    if (!canonical) return { ...paper };
    const merged = { ...canonical, ...paper };
    for (const field of ANALYSIS_RECOVERY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(canonical, field)) merged[field] = canonical[field];
    }
    return merged;
}

function loadCanonicalAnalysisRecord(filePath, paper) {
    const data = readJsonFileStrict(filePath, { allowMissing: true });
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const id = normalizedId(paper);
    return papers.find(item => normalizedId(item) === id) || null;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    analyzePaperWithRetry,
    analyzeBatch,
    mergeAndSaveResults,
    hasValidAnalysisBody,
    createFileSaver,
    mergePapersById,
    mergeCanonicalAnalysisState,
    loadCanonicalAnalysisRecord,
    readJsonFileStrict,
    initializeJsonFileLocked,
    acquireFileLockSync,
    acquireFileLock,
    canReclaimFileLock,
    withFileLockSync,
    withFileLock,
    withPaperAnalysisLock,
    getPaperAnalysisLockPath,
    updateJsonFileLocked,
    persistAnalysisCheckpoint,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getCanonicalAnalysisRunSummary,
    getAnalysisExitCode,
    getInvalidAnalysisReason,
    hasRequiredSections,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_DELAY_MS,
    DEFAULT_CONCURRENCY
};
