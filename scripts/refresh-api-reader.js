#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const refreshRecoveryEntryScope = new (require('node:async_hooks').AsyncLocalStorage)();
const Config = require('./config.js');
const {
    refreshApiReaderArticleFromSource,
    hasReviewedCompletedPrimaryReaderSeed,
    hasReviewedReaderFactLocalSeed,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource,
    normalizeApiReaderFigureMarkdown,
    stableFingerprint,
    repairApiReaderArticleAndPlanBindings,
    restoreReaderSelectedTableBytes,
    rewriteApiReaderFigureNarratives,
    normalizeApiReaderTablePasteArtifacts,
    normalizeReaderProseFormatting,
    commitDeferredReaderCandidate
} = require('./deep-analyzer.js');
const {
    readJsonFileStrict,
    updateJsonFileLocked,
    isSuccessfulAnalysisRecord,
    withPaperAnalysisLock,
    hasValidApiReaderV3Records,
    getAnalysisRunSummary
} = require('./analysis-engine.js');
const dailyFreshSources = require('./lib/daily-fresh-source-plan.js');
const { effectiveReaderTableRows } = require('./lib/reader-tables.js');
const {
    updateAnalysisDigestStatuses,
    inferAnalysisBatchDate,
    normalizeCompatibleBatchDate
} = require('./digest-status.js');
const { normalizedId, getBeijingISOString } = require('./utils.js');
const { runFailureRounds } = require('./lib/analysis-failure-rounds.js');
const { writeAnalysisBatchReport } = require('./lib/analysis-batch-report.js');

const MAX_REFRESH_CONCURRENCY = 60;

function parseRefreshCliArgs(args) {
    const options = {
        authorsOnly: false,
        scoringAndReader: false,
        figuresOnly: false,
        surfaceBindingsOnly: false,
        reviewFeedback: '',
        all: false,
        date: null,
        concurrency: Config.ANALYSIS_CONFIG?.apiReaderConcurrency ?? 5,
        maxRounds: Config.ANALYSIS_CONFIG?.batchMaxRounds ?? 3,
        ids: []
    };
    const seenFlags = new Set();
    for (let index = 0; index < args.length; index++) {
        const value = args[index];
        if (value.startsWith('--')) {
            if (seenFlags.has(value)) throw new Error(`参数 ${value} 不能重复使用。`);
            seenFlags.add(value);
        }
        if (value === '--authors-only') options.authorsOnly = true;
        else if (value === '--scoring-and-reader') options.scoringAndReader = true;
        else if (value === '--figures-only') options.figuresOnly = true;
        else if (value === '--surface-bindings-only') options.surfaceBindingsOnly = true;
        else if (value === '--all') options.all = true;
        else if (value === '--date' || value === '--concurrency' || value === '--rounds' || value === '--feedback') {
            const next = args[index + 1];
            if (!next || next.startsWith('--')) throw new Error(`参数 ${value} 缺少对应的值。`);
            index += 1;
            if (value === '--date') options.date = next;
            else if (value === '--feedback') options.reviewFeedback = next.trim();
            else {
                if (!/^\d+$/.test(next)) throw new Error(`${value} 的值必须是整数。`);
                options[value === '--rounds' ? 'maxRounds' : 'concurrency'] = Number.parseInt(next, 10);
            }
        } else if (value.startsWith('--')) {
            throw new Error(`无法识别参数 ${value}。`);
        } else {
            options.ids.push(value);
        }
    }
    if ([options.authorsOnly, options.scoringAndReader, options.figuresOnly,
        options.surfaceBindingsOnly]
        .filter(Boolean).length > 1) {
        throw new Error('同一次刷新只能选择一种模式。');
    }
    if (!Number.isInteger(options.concurrency)
        || options.concurrency < 1 || options.concurrency > MAX_REFRESH_CONCURRENCY) {
        throw new Error(`--concurrency 的值必须是 1-${MAX_REFRESH_CONCURRENCY} 之间的整数。`);
    }
    if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 10) {
        throw new Error('--rounds 的值必须是 1-10 之间的整数。');
    }
    if (options.all) {
        if (options.ids.length > 0) throw new Error('--all 不能与指定的论文 ID 同时使用。');
        const dateMatch = String(options.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const validDate = dateMatch && (() => {
            const year = Number(dateMatch[1]);
            const month = Number(dateMatch[2]);
            const day = Number(dateMatch[3]);
            const parsed = new Date(Date.UTC(year, month - 1, day));
            return parsed.getUTCFullYear() === year
                && parsed.getUTCMonth() === month - 1
                && parsed.getUTCDate() === day;
        })();
        if (!validDate) {
            throw new Error('使用 --all 时，必须同时提供有效的日期：--date YYYY-MM-DD。');
        }
    } else if (options.date) {
        throw new Error('--date 只能用于 --all 全量刷新。');
    }
    if (!options.all && options.ids.length === 0) {
        throw new Error('请指定论文 ID，或使用 --all --date YYYY-MM-DD 刷新整个批次。');
    }
    if (options.reviewFeedback) {
        if (options.all || options.ids.length !== 1) {
            throw new Error('使用 --feedback 时，只能指定一个论文 ID。');
        }
        if (options.authorsOnly || options.figuresOnly || options.surfaceBindingsOnly) {
            throw new Error('--feedback 只能用于刷新完整读者文章，或同时重新审查评分并刷新文章。');
        }
        if (options.reviewFeedback.length > 4000) {
            throw new Error('--feedback 的内容不能超过 4000 个字符。');
        }
    }
    return options;
}

function paperRefreshInputIdentity(paper) {
    return stableFingerprint({
        paperId: normalizedId(paper),
        sourceSha256: paper?.sourceSha256 || '',
        analysisSha256: stableFingerprint(String(paper?.analysis || '')),
        scoringAuditSha256: paper?.analysisManifest?.stages?.scoringAudit?.auditSha256 || '',
        scoringOutputSha256: paper?.analysisManifest?.stages?.scoringAudit?.outputAnalysisSha256 || '',
        readerFingerprint: paper?.analysisManifest?.stages?.apiReaderArticle?.fingerprint || '',
        readerArticleSha256: paper?.apiReaderArticleSha256 || '',
        readerPlanSha256: paper?.apiReaderPlanSha256 || ''
    });
}

function hasCurrentReaderV3(paper) {
    return hasValidApiReaderV3Records(paper)
        && !paper?.latestAnalysisAttemptError;
}

function resolveSavedAnalysisBatchDate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    const explicit = normalizeCompatibleBatchDate(payload.batchDate);
    if (explicit) return explicit;
    // batchDate 变成必填之前写下的历史记录，仍带着当时不可变的运行起始时间戳。
    // 这里绝不能退回到系统时钟：持久化身份缺失时必须直接失败。
    for (const value of [
        payload.timestamp,
        payload.deepAnalysisCompletedAt,
        payload.deepAnalysisLastAttemptAt,
        payload.lastUpdated
    ]) {
        const normalized = normalizeCompatibleBatchDate(value);
        if (normalized) return normalized;
    }
    return '';
}

function resolveBatchRefreshIds(options) {
    if (!options.all) return options.ids;
    const payload = readJsonFileStrict(Config.FILES.deepAnalysisResult);
    if (Array.isArray(payload) || !Array.isArray(payload?.papers)) {
        throw new Error('按日期全量刷新时，分析结果必须是包含论文数组的对象。');
    }
    const papers = payload.papers;
    const savedBatchDate = resolveSavedAnalysisBatchDate(payload);
    if (savedBatchDate !== options.date) {
        throw new Error(`分析结果的批次日期为 ${savedBatchDate || '未知'}，不能按 ${options.date} 全量刷新。`);
    }
    const currentReaderCheck = options.isCurrentReaderFn || hasCurrentReaderV3;
    const pending = options.surfaceBindingsOnly
        ? papers
        : papers.filter(paper => !currentReaderCheck(paper));
    console.log(
        `📋 读者文章全量刷新，批次日期为 ${options.date}`
        + ` | papers=${papers.length} | pending=${pending.length}`
        + ` | current_v3=${papers.length - pending.length}`
        + ` | concurrency=${options.concurrency}`
    );
    return pending.map(paper => normalizedId(paper)).filter(Boolean);
}

async function refreshApiReaders(targetIds, options = {}) {
    return require('./lib/analysis-stop-control').withAnalysisStopControl(() => refreshApiReadersInternal(targetIds, options));
}

function readRefreshEntryPlan(resultPath) {
    const payload = readJsonFileStrict(resultPath);
    return dailyFreshSources.requireDailyFreshSourceRecoveryPlan(payload, {
        label: '读者文章批次入口'
    });
}

function validateRefreshFinalSources(resultPath, entryPlan) {
    const payload = readJsonFileStrict(resultPath);
    dailyFreshSources.requireFinalDailyFreshSourceRecoveryPlan(payload, {
        entryPlan, label: '读者文章结束来源核验'
    });
}

async function refreshApiReadersInternal(targetIds, options = {}) {
    const entryPlan = readRefreshEntryPlan(Config.FILES.deepAnalysisResult);
    return refreshRecoveryEntryScope.run(entryPlan, async () => {
        let result, failure;
        try { result = await refreshApiReadersWithEntryPlan(targetIds, options); }
        catch (error) { failure = error; }
        try { validateRefreshFinalSources(Config.FILES.deepAnalysisResult, entryPlan); }
        catch (error) {
            if (failure) throw new AggregateError([failure, error],
                `Reader 刷新失败，结束来源核验亦失败：${error.message}`, { cause: failure });
            throw error;
        }
        if (failure) throw failure;
        return result;
    });
}

async function refreshApiReadersWithEntryPlan(targetIds, options = {}) {
    const ids = [...new Set(targetIds.map(normalizedId).filter(Boolean))];
    const config = Config.ANALYSIS_CONFIG || {};
    const concurrency = options.concurrency ?? config.apiReaderConcurrency ?? 5;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_REFRESH_CONCURRENCY) {
        throw new RangeError(`concurrency must be an integer in 1..${MAX_REFRESH_CONCURRENCY}`);
    }
    const failures = new Map();
    const stop = require('./lib/analysis-stop-control');
    let runStopError = null, roundResult;
    const runId = crypto.randomUUID();
    const report = state => writeAnalysisBatchReport({ runId, flow: 'reader-refresh',
        sourceRun: dailyFreshSources.dailyFreshSourceReference(refreshRecoveryEntryScope.getStore()),
        targetIds: ids, ...state });
    try {
        roundResult = await runFailureRounds(ids, {
            concurrency,
            maxRounds: options.maxRounds ?? config.batchMaxRounds ?? 3,
            getItemId: id => id,
            manualHandoffMaxItems: config.manualHandoffMaxItems ?? 5,
            manualHandoffMinRounds: config.manualHandoffMinRounds ?? 3,
            manualHandoffNoProgressRounds: config.manualHandoffNoProgressRounds ?? 3,
            shouldStop: () => {
                if (runStopError) return runStopError;
                if (stop.isAnalysisStopRequested()) stop.assertMayStartRequest();
                return false;
            },
            runItem: async id => {
                try {
                    const result = await refreshApiReader(id, options);
                    failures.delete(id);
                    return { success: true, result };
                } catch (error) {
                    if (error?.code === stop.CODE && error.result) {
                        runStopError ||= error;
                        failures.delete(id);
                        return { success: true, result: error.result };
                    }
                    failures.set(id, { id, error: error.message, code: error.code || null });
                    console.error(`❌ ${id} 刷新失败: ${error.message}`);
                    // Only explicitly classified content failures may repeat. Source,
                    // storage and provider errors stop dispatch and retain their identity.
                    if (error.scope === 'run' || error.code === 'DAILY_FRESH_SOURCE_PLAN_INTEGRITY'
                        || ['EIO', 'ENOSPC', 'EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error;
                    return { success: false, error: error.message, code: error.code,
                        retryable: error.retryable === true, result: error.result };
                }
            },
            onRoundStart: context => {
                console.log(`📋 Reader 第 ${context.round}/${context.maxRounds} 轮 | pending=${context.inputIds.length}`);
            },
            onRoundDone: context => report({ roundsCompleted: context.round,
                latestRound: { ...context, outcomes: undefined }, manualHandoff: context.manualHandoff })
        });
    } catch (error) {
        error.failures = [...failures.values()];
        error.results = (error.outcomes || []).filter(item => item?.success === true).map(item => item.result);
        try { error.batchReportPath = report({ stopped: true, rounds: error.rounds || [],
            failedIds: [...failures.keys()], unstartedIds: error.unstartedIds || [],
            manualHandoff: error.manualHandoff || null }); }
        catch (reportError) { throw new AggregateError([error, reportError], 'Reader 刷新与诊断保存均失败', { cause: error }); }
        throw error;
    }
    const results = roundResult.outcomes.filter(item => item?.success === true).map(item => item.result);
    const batchReportPath = report({ rounds: roundResult.rounds, stopped: false,
        failedIds: roundResult.failedIds, unstartedIds: roundResult.unstartedIds,
        manualHandoff: roundResult.manualHandoff });
    if (failures.size) {
        const error = new Error(`API reader 批量刷新失败 ${failures.size}/${ids.length}: ${[...failures.keys()].join(', ')}`);
        Object.assign(error, { failures: [...failures.values()], results, rounds: roundResult.rounds,
            manualHandoff: roundResult.manualHandoff, batchReportPath });
        throw error;
    }
    return results;
}

function canRepairScoringBinding(paper) {
    const manifest = paper?.analysisManifest;
    const scoring = manifest?.stages?.scoringAudit;
    const reader = manifest?.stages?.apiReaderArticle;
    const article = String(paper?.apiReaderArticle || '');
    const articleSha256 = article
        ? crypto.createHash('sha256').update(article).digest('hex') : '';
    const reusableRevisionSeed = article.length > 0
        && paper?.apiReaderPlan && typeof paper.apiReaderPlan === 'object'
        && paper.apiReaderPlan.version === 3
        && paper.apiReaderArticleSha256 === articleSha256
        && paper.apiReaderPlanSha256 === stableFingerprint(paper.apiReaderPlan);
    return typeof paper?.analysis === 'string' && paper.analysis.trim().length > 0
        && manifest?.version === 1
        && scoring?.status === 'complete'
        && scoring?.scoringContract === 'api-scoring-audit-v2'
        && (reader?.status === 'complete'
            || (reader?.status === 'invalid_output' && reusableRevisionSeed))
        && ['beginner-researcher-v2', 'beginner-researcher-v3']
            .includes(manifest?.contracts?.apiReaderArticle);
}

function canRepairSurfaceBinding(paper) {
    return typeof paper?.apiReaderArticle === 'string'
        && paper.apiReaderArticle.trim().length > 0
        && paper?.apiReaderPlan && typeof paper.apiReaderPlan === 'object'
        && paper?.analysisManifest?.stages?.apiReaderArticle?.status === 'complete'
        && !paper?.latestAnalysisAttemptError;
}

function canRepairCompletedPrimaryReader(paper, plan, options = {}) {
    if (options.scoringAndReader || options.surfaceBindingsOnly
        || options.authorsOnly || options.figuresOnly || !String(options.reviewFeedback || '').trim()) return false;
    const facts = require('./lib/daily-fact-review');
    const active = facts.current(normalizedId(paper));
    if (!active || active.scoringOnly) return false;
    if (options.readerFactLocalRevision === true) {
        const bound = facts.validateFeedback(active.feedback, plan, paper);
        const source = dailyFreshSources.readDailyFreshSource(plan, paper);
        return dailyFreshSources.withDailyFreshAnalysisContext(plan, () => facts.withFactReview(bound, () =>
            hasReviewedReaderFactLocalSeed(paper, source.text, options.reviewFeedback)));
    }
    if (!active.feedback.primaryFeedback?.trim()) return false;
    const bound = facts.validateFeedback(active.feedback, plan, paper);
    const source = dailyFreshSources.readDailyFreshSource(plan, paper);
    return dailyFreshSources.withDailyFreshAnalysisContext(plan, () => facts.withFactReview(bound, () =>
        hasReviewedCompletedPrimaryReaderSeed(paper, source.text, options.reviewFeedback)));
}

async function refreshApiReader(targetId, options = {}) {
    if (options.naturalResourceProse !== undefined && typeof options.naturalResourceProse !== 'boolean') {
        throw new Error('naturalResourceProse 必须为布尔值');
    }
    if (options.readerFactLocalRevision === true && (options.scoringAndReader
        || options.authorsOnly || options.figuresOnly || options.surfaceBindingsOnly)) {
        throw new Error('事实局部修订只能刷新Reader正文');
    }
    return require('./lib/analysis-stop-control').withAnalysisStopControl(async () => {
        const result = await refreshApiReaderInternal(targetId, options);
        try { require('./lib/analysis-stop-control').assertMayStartRequest(); }
        catch (error) { error.result = result; throw error; }
        return result;
    });
}

function finishReviewedPrimaryReaderRefresh(previous, refreshed, plan, options = {}) {
    if (!canRepairCompletedPrimaryReader(previous, plan, options)) {
        throw new Error('已完成主文的 Reader 成功收尾缺少原授权');
    }
    const facts = require('./lib/daily-fact-review');
    const engine = require('./analysis-engine');
    const sameMainStages = value => Object.fromEntries(Object.entries(value.analysisManifest.stages)
        .filter(([key]) => key !== 'apiReaderArticle'));
    const protectedKeys = ['parsed', 'analysisCheckpoint', 'analysisStageCheckpoints',
        'freshRewriteProvenance', 'sourceSha256', 'usedTextSha256', 'scoringRubricVersion',
        'analysisSource', 'sourceId', 'sourceTextChars', 'digestStatus', 'error'];
    for (const key of protectedKeys) {
        if (Object.hasOwn(previous, key) !== Object.hasOwn(refreshed, key)
            || JSON.stringify(previous[key]) !== JSON.stringify(refreshed[key])) {
            throw new Error(`Reader 成功收尾改变了受保护字段 ${key}`);
        }
    }
    const failureKeys = ['latestAnalysisAttemptError', 'latestAnalysisAttemptAt',
        'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable'];
    for (const key of failureKeys) {
        if (Object.hasOwn(previous, key) !== Object.hasOwn(refreshed, key)
            || JSON.stringify(previous[key]) !== JSON.stringify(refreshed[key])) {
            throw new Error('Reader 成功收尾的原失败身份不同');
        }
    }
    if (normalizedId(previous) !== normalizedId(refreshed)
        || JSON.stringify(previous.analysisManifest.sourceAcquisition)
            !== JSON.stringify(refreshed.analysisManifest.sourceAcquisition)) {
        throw new Error('Reader 成功收尾改变了论文或来源身份');
    }
    if (refreshed.analysis !== previous.analysis
        || JSON.stringify(sameMainStages(refreshed)) !== JSON.stringify(sameMainStages(previous))
        || refreshed.latestAnalysisAttemptError !== previous.latestAnalysisAttemptError) {
        throw new Error('Reader 成功收尾改变了主文、其他阶段或原失败身份');
    }
    facts.validateRepairedClaims('apiReaderArticle', refreshed.apiReaderArticle, normalizedId(refreshed));
    const reason = engine.getIncompleteAnalysisContentReason(refreshed);
    if (reason) throw new Error(`Reader 成功收尾仍有未完成内容：${reason}`);
    const stage = refreshed.analysisManifest.stages.apiReaderArticle;
    const requestedFeedbackSha = require('node:crypto').createHash('sha256')
        .update(String(options.reviewFeedback || '').trim()).digest('hex');
    if (stage.reviewFeedbackSha256 !== requestedFeedbackSha
        || options.readerFactLocalRevision === true && !stage.factReview
        || stage.factReview && JSON.stringify(stage.factReview)
            !== JSON.stringify(facts.current(normalizedId(previous)).proof)) {
        throw new Error('新 Reader 的反馈身份与本次授权不同');
    }
    const completedAt = Date.parse(stage.refreshedAt);
    const hadFailure = Boolean(previous.latestAnalysisAttemptError || previous.error
        || previous.digestStatus?.latestAttemptStatus === 'analysis_failed');
    const previousReader = previous.analysisManifest?.stages?.apiReaderArticle;
    const oldCompletionKey = Object.hasOwn(previousReader || {}, 'refreshedAt')
        ? 'refreshedAt' : Object.hasOwn(previousReader || {}, 'updatedAt') ? 'updatedAt' : null;
    const previousCompletedAt = oldCompletionKey ? previousReader[oldCompletionKey] : undefined;
    // 正常成功稿没有失败时间；不能把不存在的失败转成 NaN 后拒绝已付费修订。
    // 有失败仍严格核原失败时间，存在旧 Reader 完成时间时也必须晚于它。
    if (!Number.isFinite(completedAt)
        || (hadFailure || options.readerFactLocalRevision !== true)
            && (!Number.isFinite(Date.parse(previous.latestAnalysisAttemptAt))
                || !(completedAt > Date.parse(previous.latestAnalysisAttemptAt)))
        || oldCompletionKey !== null
            && (!Number.isFinite(Date.parse(previousCompletedAt))
                || !(completedAt > Date.parse(previousCompletedAt)))) {
        throw new Error('Reader 成功收尾没有晚于原失败或旧 Reader 的有效完成记录');
    }
    const result = structuredClone(refreshed);
    const failure = Object.fromEntries(Object.entries(previous).filter(([key]) =>
        key.startsWith('latestAnalysisAttempt') || key === 'error' || key === 'digestStatus'));
    result.readerCompletedPrimaryRecoveryHistory = [...(previous.readerCompletedPrimaryRecoveryHistory || []), {
        contract: 'reviewed-completed-primary-reader-finish-v1', failure,
        ...(options.readerFactLocalRevision === true ? { mode: 'signed-reader-fact-local-repair-v1' } : {}),
        feedbackSha256: facts.current(normalizedId(previous)).proof.feedbackSha256,
        originalFactReview: structuredClone(facts.current(normalizedId(previous)).proof),
        readerExecution: { fingerprint: stage.fingerprint, attempts: stage.attempts,
            fullAttempts: stage.fullAttempts, transportFailures: stage.transportFailures },
        note: options.readerFactLocalRevision === true
            ? '正常Reader事实修复完成转换；保留原主文和评分证明，新Reader使用本次真实反馈与执行记录。'
            : '正常完成状态转换记录；沿用原事实审查与已付费Reader执行，不是新模型审查证明。',
        readerArticleSha256: stage.articleSha256, completedAt: stage.refreshedAt
    }];
    for (const key of failureKeys) delete result[key];
    if (result.error === previous.latestAnalysisAttemptError) result.error = null;
    if (result.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        result.digestStatus = { ...result.digestStatus, latestAttemptStatus: 'analyzed', error: null };
    }
    if (!engine.isSuccessfulAnalysisRecord(result)) throw new Error('Reader 收尾后仍不满足完整成功资格');
    require('./lib/reader-candidate-transactions').transferDeferredReaderCandidate(refreshed, result);
    return result;
}

// 在同步读取范围内核验整批，只让当前论文和来源计划进入异步刷新。
// 其他论文的正文不应随模型请求一起留在内存中。
function readRefreshTargetAndPlan(resultPath, requested, entryPlan = null) {
    const payload = readJsonFileStrict(resultPath);
    const papers = Array.isArray(payload) ? payload : payload.papers;
    const paper = papers.find(paper => normalizedId(paper) === requested);
    const plan = entryPlan
        ? dailyFreshSources.requireLockedDailyFreshSourceRecoveryPlan(payload, {
            entryPlan, paper, label: '读者文章当前论文'
        })
        : dailyFreshSources.requireDailyFreshSourceRecoveryPlan(payload, {
            papers, label: 'API Reader recovery'
        });
    return { paper, plan };
}

async function refreshApiReaderInternal(targetId, options = {}) {
    const requested = normalizedId(targetId);
    if (!requested) throw new Error('用法: node scripts/refresh-api-reader.js <arxiv-id>');
    const resultPath = Config.FILES.deepAnalysisResult;
    const { paper: existing, plan: initialDailySourcePlan } =
        readRefreshTargetAndPlan(resultPath, requested, refreshRecoveryEntryScope.getStore());
    if (!existing || (!isSuccessfulAnalysisRecord(existing)
        && !(options.scoringAndReader && canRepairScoringBinding(existing))
        && !(options.surfaceBindingsOnly && canRepairSurfaceBinding(existing))
        && !canRepairCompletedPrimaryReader(existing, initialDailySourcePlan, options))) {
        throw new Error(`${requested} 的已有分析记录不满足所选刷新模式的条件，不能开始刷新。`);
    }

    try {
        return await withPaperAnalysisLock(existing, async () => {
        const { paper: storedAnalysisRecord, plan: lockedDailySourcePlan } =
            readRefreshTargetAndPlan(resultPath, requested, refreshRecoveryEntryScope.getStore() || initialDailySourcePlan);
        if (!storedAnalysisRecord || (!isSuccessfulAnalysisRecord(storedAnalysisRecord)
            && !(options.scoringAndReader && canRepairScoringBinding(storedAnalysisRecord))
            && !(options.surfaceBindingsOnly && canRepairSurfaceBinding(storedAnalysisRecord))
            && !canRepairCompletedPrimaryReader(storedAnalysisRecord, lockedDailySourcePlan, options))) {
            throw new Error(`取得分析锁后，${requested} 的记录已不存在，或不再满足所选刷新模式的条件。`);
        }
        if (!dailyFreshSources.isPaperBoundToPlan(storedAnalysisRecord, lockedDailySourcePlan)) {
            throw new Error(`${requested} 的分析结果与当前封存的日更来源不一致；请使用 npm run reanalyze 根据已封存来源重新分析。`);
        }
        const inputIdentity = paperRefreshInputIdentity(storedAnalysisRecord);
        const completedPrimaryRecoveryInput = canRepairCompletedPrimaryReader(
            storedAnalysisRecord, lockedDailySourcePlan, options) ? structuredClone(storedAnalysisRecord) : null;
        const refreshLabel = options.authorsOnly
            ? '作者与机构信息'
            : options.figuresOnly
                ? '论文图片'
            : options.surfaceBindingsOnly
                ? '文章内容与计划记录的对应关系'
            : options.scoringAndReader
                ? '评分重新审查与读者文章'
                : '读者文章';
        console.log(`📄 只刷新${refreshLabel}: ${storedAnalysisRecord.title || requested}`);
        const refreshOperations = options.operations || {};
        const refreshFromDailySource = async sourceDetails => options.authorsOnly
            ? (refreshOperations.authors || refreshApiReaderAuthorsFromSource)(storedAnalysisRecord, sourceDetails)
            : options.figuresOnly
                ? await (refreshOperations.figures || refreshApiReaderFiguresFromSource)(storedAnalysisRecord, sourceDetails)
                : options.scoringAndReader
                    ? await (refreshOperations.scoringAndReader || refreshApiScoringAndReaderFromSource)(
                        storedAnalysisRecord, sourceDetails, { reviewFeedback: options.reviewFeedback }
                    )
                    : await (refreshOperations.article || refreshApiReaderArticleFromSource)(storedAnalysisRecord, sourceDetails, {
                        reviewFeedback: options.reviewFeedback,
                        readerFactLocalRevision: options.readerFactLocalRevision === true,
                        signedRevisionMinimalDisplay: options.signedRevisionMinimalDisplay,
                        naturalResourceProse: options.naturalResourceProse === true
                    });
        const repairSurfaceBindings = sourceDetails => {
                const repaired = JSON.parse(JSON.stringify(storedAnalysisRecord));
                repaired.apiReaderArticle = normalizeApiReaderFigureMarkdown(
                    repaired.apiReaderArticle,
                    repaired.apiReaderFigures
                );
                repaired.apiReaderArticle = rewriteApiReaderFigureNarratives(
                    repaired.apiReaderArticle, repaired.apiReaderFigures
                );
                repaired.apiReaderArticle = normalizeApiReaderTablePasteArtifacts(
                    repaired.apiReaderArticle
                );
                repaired.apiReaderArticle = repaired.apiReaderArticle.replace(
                    /采样率\s*1\s*般\s*16\s*千赫/g, match => normalizeReaderProseFormatting(match)
                );
                for (const binding of repaired.apiReaderPlan?.tableBindings || []) {
                    if (binding.sourceType !== 'artifact_table') continue;
                    const table = sourceDetails.structuredArtifacts?.tables?.find(item => (
                        item.ordinal === binding.sourceTableOrdinal
                        && item.sourceDomSha256 === binding.sourceTableDomSha256
                    ));
                    if (!table || effectiveReaderTableRows(table).inferenceContract
                        !== 'full-width-protocol-divider-header-v1') continue;
                    const headers = binding.cellBindings.filter(cell => cell.renderedRow === 0);
                    if (!headers.length || !headers.every(cell => (
                        table.headerRows.includes(cell.sourceRow)
                        && cell.sourceDomSha256 === headers[0].sourceDomSha256
                    ))) continue;
                    binding.cellBindings = binding.cellBindings.map(cell => {
                        if (cell.renderedRow !== 0) return cell;
                        const original = table.cells.find(candidate => candidate.row === 0
                            && candidate.column === cell.sourceColumn);
                        if (!original || table.matrix[0][cell.sourceColumn] !== original.text) {
                            throw new Error('读者文章的原表列标题缺少对应单元格，或与原表文本不一致。');
                        }
                        return { ...cell, sourceRow: 0, sourceText: original.text,
                            renderedText: original.text, sourceDomSha256: original.sourceDomSha256 };
                    });
                }
                repaired.apiReaderArticle = restoreReaderSelectedTableBytes(
                    repaired.apiReaderArticle,
                    repaired.apiReaderPlan?.tableBindings,
                    sourceDetails.structuredArtifacts
                );
                repaired.apiReaderArticleSha256 = crypto.createHash('sha256')
                    .update(repaired.apiReaderArticle).digest('hex');
                repairApiReaderArticleAndPlanBindings(repaired, repaired.analysisManifest);
                if (repaired.analysisManifest.stages.apiReaderArticle.articleSha256
                    !== repaired.apiReaderArticleSha256
                    || repaired.analysisManifest.stages.apiReaderArticle.sourceBindingsSha256
                        !== repaired.apiReaderPlan.sourceBindingsSha256) {
                    throw new Error(`${requested} 的文章内容调整后，正文或来源对应记录的 SHA 不一致。`);
                }
                const actualHeadings = [...repaired.apiReaderArticle.matchAll(/^###\s+(.+?)\s*$/gm)]
                    .map(match => match[1].trim());
                const plannedHeadings = repaired.apiReaderPlan?.sections?.map(section => section.heading.trim());
                if (!Array.isArray(plannedHeadings)
                    || actualHeadings.length !== plannedHeadings.length
                    || actualHeadings.some((heading, index) => heading !== plannedHeadings[index])) {
                    throw new Error(`${requested} 的文章小节标题与计划记录不一致。`);
                }
                const bridges = repaired.apiReaderPlan?.conceptBridges;
                if (!Array.isArray(bridges) || bridges.some(bridge => (
                    typeof bridge?.explanation !== 'string'
                    || !repaired.apiReaderArticle.includes(bridge.explanation)
                    || repaired.apiReaderArticle.includes(String(bridge?.marker || ''))
                ))) {
                    throw new Error(`${requested} 的文章计划中的术语组合说明格式无效、未出现在正文中，或正文仍含未替换的标记。`);
                }
                const articleFigureUrls = [...repaired.apiReaderArticle
                    .matchAll(/!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^\s)]+)\)/g)]
                    .map(match => match[1]);
                const boundFigureUrls = Array.isArray(repaired.apiReaderFigures)
                    ? repaired.apiReaderFigures.map(item => item?.url)
                    : [];
                if (articleFigureUrls.length !== boundFigureUrls.length
                    || articleFigureUrls.some((url, index) => url !== boundFigureUrls[index])) {
                    throw new Error(`${requested} 的正文图片数量或顺序与图片记录不一致。`);
                }
                return repaired;
            };
        // 即使只调整正文与计划记录的对应关系，也要使用已核验的日更来源和图片。
        // 修改已保存的结果前，必须核对对应的封存文件，不能改用旧图片或缓存。
        let refreshed = await dailyFreshSources.withDailyFreshAnalysisContext(lockedDailySourcePlan, () =>
            dailyFreshSources.withDailyFreshPaperSource(
                lockedDailySourcePlan,
                storedAnalysisRecord,
                options.surfaceBindingsOnly ? repairSurfaceBindings : refreshFromDailySource,
                options
            ), { refreshReaderDiagnostics: options.refreshReaderDiagnostics }
        );
        if (completedPrimaryRecoveryInput) {
            refreshed = finishReviewedPrimaryReaderRefresh(completedPrimaryRecoveryInput,
                refreshed, lockedDailySourcePlan, options);
        }
        const savedPayload = updateJsonFileLocked(resultPath, payload => {
            const rows = Array.isArray(payload) ? payload : payload.papers;
            if (!Array.isArray(rows)) throw new Error('分析结果中的论文列表 papers 不是数组。');
            const matches = rows.map((paper, index) => (
                normalizedId(paper) === requested ? index : -1
            )).filter(index => index >= 0);
            if (matches.length !== 1) {
                throw new Error(`保存 ${requested} 的刷新结果时，发现 ${matches.length} 条对应记录，无法确定应更新哪一条。`);
            }
            const targetIndex = matches[0];
            if (paperRefreshInputIdentity(rows[targetIndex]) !== inputIdentity) {
                throw new Error(`${requested} canonical_changed_during_refresh`);
            }
            if (normalizedId(refreshed) !== requested) {
                throw new Error(`${requested} 的刷新结果对应了另一个论文 ID，不能保存。`);
            }
            require('./lib/reader-paid-resolved-render').assertPaidResolvedRenderSnapshot();
            const updated = [...rows];
            updated[targetIndex] = refreshed;
            if (Array.isArray(payload)) return updated;
            const analysisRunSummary = getAnalysisRunSummary(updated);
            const now = getBeijingISOString();
            const next = {
                ...payload,
                papers: updated,
                status: analysisRunSummary.status,
                stats: {
                    ...(payload.stats || {}),
                    analysisStatus: analysisRunSummary.status,
                    remainingFailed: analysisRunSummary.remaining,
                    analyzedSuccess: analysisRunSummary.success,
                    analyzedFailed: analysisRunSummary.remaining
                },
                lastUpdated: now
            };
            if (analysisRunSummary.status === 'complete') next.deepAnalysisCompletedAt = now;
            else delete next.deepAnalysisCompletedAt;
            return next;
        });
        commitDeferredReaderCandidate(refreshed);
        const savedRows = Array.isArray(savedPayload) ? savedPayload : savedPayload.papers;
        const savedRecord = savedRows.find(paper => normalizedId(paper) === requested);
        const batchDate = inferAnalysisBatchDate(
            [savedRecord], Array.isArray(savedPayload) ? {} : savedPayload
        );
        const sync = updateAnalysisDigestStatuses([savedRecord], { batchDate });
        console.log(options.surfaceBindingsOnly
            ? `✅ 文章内容与计划记录已对应 | plan_sha=${savedRecord.apiReaderPlanSha256}`
                + ` | papers_sync=${sync.updated}`
            : options.authorsOnly
            ? `✅ 作者与机构信息已刷新 | authors=${refreshed.apiReaderAuthors.authors.length} | papers_sync=${sync.updated}`
            : options.figuresOnly
                ? `✅ 论文图片已刷新 | figures=${refreshed.apiReaderFigures.length} | papers_sync=${sync.updated}`
            : `✅ ${options.scoringAndReader ? '评分重新审查与读者文章' : '读者文章'}刷新完成`
                + ` | score=${refreshed.parsed?.score}`
                + ` | sections=${refreshed.apiReaderPlan.sections.length}`
                + ` | figures=${refreshed.apiReaderFigures.length}`
                + ` | article_sha=${refreshed.apiReaderArticleSha256}`
                + ` | papers_sync=${sync.updated}`);
        return savedRecord;
        });
    } finally {
        if (!refreshRecoveryEntryScope.getStore()) {
            validateRefreshFinalSources(resultPath, initialDailySourcePlan);
        }
    }
}

if (require.main === module) {
    try {
        const options = parseRefreshCliArgs(process.argv.slice(2));
        const ids = resolveBatchRefreshIds(options);
        refreshApiReaders(ids, options).then(results => {
            console.log(`✅ 读者文章批量刷新已完成: ${results.length} 篇`);
        }).catch(error => {
            console.error(`❌ API 读者文章刷新失败: ${error.message}`);
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    refreshApiReader,
    refreshApiReaders,
    parseRefreshCliArgs,
    resolveBatchRefreshIds,
    hasCurrentReaderV3,
    resolveSavedAnalysisBatchDate,
    paperRefreshInputIdentity,
    canRepairScoringBinding,
    canRepairCompletedPrimaryReader,
    finishReviewedPrimaryReaderRefresh,
    MAX_REFRESH_CONCURRENCY
};
