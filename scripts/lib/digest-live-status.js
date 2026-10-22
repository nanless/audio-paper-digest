'use strict';

// 只读合成一屏的日更运行状态。
//
// 数据来源只有：
//   - data/current 下的抓取、筛选、分析、博客/视觉产物；
//   - data/runtime/llm-usage 的只读费用事件；
//   - data/runtime/llm-account-pool.json 的账号冷却状态；
//   - logs 目录最新一份日志。
// 不联网、不请求模型、不写任何文件。所有时间都通过注入的 clock/nowMs 计算，
// 便于测试固定“无进度秒数”。

const fs = require('node:fs');
const path = require('node:path');
const { buildDailyUsageSummary, createUsageSummaryCache, beijingDateFromMs } = require('./llm-usage-summary.js');

const VERSION = 'digest-live-status-v1';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_STALL_THRESHOLD_SECONDS = 300;
const DEFAULT_LOG_FRESH_SECONDS = 300;
const LOG_TAIL_BYTES = 16 * 1024;

const STAGES = ['fetch', 'filter', 'analysis', 'reader', 'pages', 'review', 'push', 'visual', 'complete'];
const STAGE_INDEX = Object.fromEntries(STAGES.map((stage, index) => [stage, index]));

const STAGE_LABELS = {
    fetch: '抓取',
    filter: '筛选',
    analysis: '深度分析',
    reader: 'API Reader',
    pages: '页面生成',
    review: '博客审查',
    push: '推送发布',
    visual: '视觉长图',
    complete: '已完成'
};

function formatBeijingIso(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return null;
    return new Date(value + BEIJING_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

function isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const ms = Date.parse(`${date}T00:00:00+08:00`);
    return Number.isFinite(ms) && beijingDateFromMs(ms) === date;
}

function resolveNowMs(options = {}) {
    if (Number.isFinite(options.nowMs)) return Number(options.nowMs);
    if (typeof options.clock === 'function') {
        const value = Number(options.clock());
        if (Number.isFinite(value)) return value;
    }
    return Date.now();
}

function resolveDate(date, nowMs) {
    const value = date || beijingDateFromMs(nowMs);
    if (!isValidDate(value)) throw new Error(`日期必须是有效的北京日期 YYYY-MM-DD：${String(value)}`);
    return value;
}

function defaultPaths() {
    const Config = require('../config.js');
    return {
        currentDir: Config.CURRENT_DIR,
        rawCandidates: Config.FILES.rawCandidates,
        fetchCheckpoint: Config.FILES.fetchCheckpoint,
        filterDecisions: Config.FILES.filterDecisions,
        filteredPapers: Config.FILES.filteredPapers,
        deepAnalysisResult: Config.FILES.deepAnalysisResult,
        generationManifestDir: Config.CURRENT_DIR,
        reviewReceiptDir: Config.CURRENT_DIR,
        visualManifestDir: Config.FILES.visualSummaryManifestDir,
        coverManifestDir: Config.FILES.digestCoverManifestDir,
        logsDir: Config.LOGS_DIR,
        accountPoolState: Config.FILES.llmAccountPoolState,
        llmUsageDir: Config.FILES.llmUsageDir
    };
}

function resolvePaths(overrides = {}) {
    return { ...defaultPaths(), ...(overrides || {}) };
}

function readJsonSafe(filePath, readErrors = null) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT' && readErrors) {
            readErrors.push({ path: filePath, kind: 'unreadable', code: error?.code || null });
        }
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        if (readErrors) readErrors.push({ path: filePath, kind: 'invalid-json' });
        return null;
    }
}

function mtimeMs(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink() ? stat.mtimeMs : null;
    } catch (_error) {
        return null;
    }
}

function papersOf(doc) {
    if (Array.isArray(doc)) return doc;
    return Array.isArray(doc?.papers) ? doc.papers : [];
}

function documentMatchesDate(doc, date, keys = ['batchDate', 'date']) {
    if (!doc || typeof doc !== 'object') return false;
    return keys.some(key => doc[key] === date);
}

function paperId(paper) {
    return paper?.arxivId || paper?.id || paper?.paperId || null;
}

function stageStatus(stage) {
    return typeof stage?.status === 'string' ? stage.status : null;
}

// running/pending 只是还没结束，不是失败；只有明确的 fail/error 终态才算失败。
function stageStatusKind(stage) {
    const status = String(stageStatus(stage) || '').toLowerCase();
    if (!status) return 'unknown';
    if (/fail|error/.test(status)) return 'failed';
    if (/running|pending|in_progress|in-progress|started|queued|processing|retrying/.test(status)) return 'running';
    if (status === 'complete') return 'complete';
    if (/skip|not_needed/.test(status)) return 'skipped';
    return 'incomplete';
}

function stageFailureMessage(stage) {
    if (stageStatusKind(stage) !== 'failed') return null;
    const message = stage?.error || stage?.message || stage?.errorCode || stageStatus(stage);
    return typeof message === 'string' ? message : stageStatus(stage);
}

function stageIsRunning(stage) {
    return stageStatusKind(stage) === 'running';
}

function paperAnalysisPassed(paper) {
    if (!paper || typeof paper !== 'object') return false;
    const stages = paper.analysisManifest?.stages;
    const primary = stages?.primaryAnalysis;
    if (primary && stageStatus(primary) !== 'complete') return false;
    if (typeof paper.analysis === 'string' && paper.analysis.trim().length > 0) return true;
    // 有些记录只保存阶段检查点；没有正文不算通过。
    return false;
}

// 返回失败原因字符串；null 表示“未通过但尚未终态失败”（running/pending）。
function paperAnalysisFailure(paper) {
    if (paperAnalysisPassed(paper)) return null;
    const stages = paper?.analysisManifest?.stages;
    const primary = stages?.primaryAnalysis;
    const scoring = stages?.scoringAudit;
    if (stageIsRunning(primary) || stageIsRunning(scoring)) return null;
    const stageError = stageFailureMessage(primary) || stageFailureMessage(scoring);
    if (stageError) return stageError;
    if (typeof paper?.error === 'string' && paper.error) return paper.error;
    return null;
}

function paperReaderStage(paper) {
    return paper?.analysisManifest?.stages?.apiReaderArticle || null;
}

function paperReaderPassed(paper) {
    const stage = paperReaderStage(paper);
    if (stage) return stageStatus(stage) === 'complete';
    return typeof paper?.apiReaderArticle === 'string' && paper.apiReaderArticle.trim().length > 0;
}

// 未通过 Reader 但仍在运行时返回 null，避免把 running 记成失败。
function paperReaderFailure(paper) {
    if (paperReaderPassed(paper)) return null;
    const stage = paperReaderStage(paper);
    const article = typeof paper?.apiReaderArticle === 'string' && paper.apiReaderArticle.trim();
    // 没有 Reader 阶段也没有正文时，Reader 对这篇不适用（旧分析记录），
    // 不能当成失败；只有确实开始过 Reader 的论文才会计入失败/待处理。
    if (!stage && !article) return null;
    if (stageIsRunning(stage)) return null;
    const stageError = stageFailureMessage(stage);
    if (stageError) return stageError;
    return stage ? 'Reader 未完成' : 'Reader 记录缺失';
}

function paperLatestUpdatedAtMs(paper) {
    const values = [];
    const stages = paper?.analysisManifest?.stages;
    for (const stage of Object.values(stages || {})) {
        if (!stage || typeof stage !== 'object') continue;
        const ms = Date.parse(stage.updatedAt);
        if (Number.isFinite(ms)) values.push(ms);
    }
    const manifestMs = Date.parse(paper?.analysisManifest?.updatedAt);
    if (Number.isFinite(manifestMs)) values.push(manifestMs);
    return values.length ? Math.max(...values) : null;
}

function inferAnalysisCounts(deep) {
    const papers = papersOf(deep);
    let analysisPassed = 0;
    let analysisFailed = 0;
    let readerApplicable = 0;
    let readerPassed = 0;
    let readerFailed = 0;
    for (const paper of papers) {
        const analyzed = paperAnalysisPassed(paper);
        if (analyzed) analysisPassed += 1;
        else if (paperAnalysisFailure(paper)) analysisFailed += 1;
        const readerStage = paperReaderStage(paper);
        const readerArticle = typeof paper?.apiReaderArticle === 'string' && paper.apiReaderArticle.trim();
        // 分析已通过就视为 Reader 适用：没有 Reader 阶段/正文是“未开始/中断”，
        // 计入 pending，而不是从统计里消失（否则会显示 Reader 0/0 看起来全过）。
        if (readerStage || readerArticle || analyzed) {
            readerApplicable += 1;
            if (analyzed && paperReaderPassed(paper)) readerPassed += 1;
            else if (analyzed) {
                const failure = paperReaderFailure(paper);
                if (failure) readerFailed += 1;
            }
        }
    }
    return {
        total: papers.length,
        analysisPassed,
        analysisFailed,
        analysisPending: Math.max(0, papers.length - analysisPassed - analysisFailed),
        readerTotal: readerApplicable,
        readerPassed,
        readerFailed,
        readerPending: Math.max(0, readerApplicable - readerPassed - readerFailed)
    };
}

function collectFailedPapers(deep) {
    const papers = papersOf(deep);
    const failures = [];
    papers.forEach((paper, index) => {
        const id = paperId(paper);
        const title = typeof paper?.title === 'string' ? paper.title : null;
        if (!paperAnalysisPassed(paper)) {
            const error = paperAnalysisFailure(paper);
            // running/pending 不是失败，不进失败列表。
            if (!error) return;
            failures.push({ id, title, index: index + 1, stage: 'analysis', error });
            return;
        }
        if (paperReaderPassed(paper)) return;
        const readerStage = paperReaderStage(paper);
        const readerArticle = typeof paper?.apiReaderArticle === 'string' && paper.apiReaderArticle.trim();
        // 没有任何 Reader 证据的记录属于“尚未进入 Reader”，不是终态失败。
        if (!readerStage && !readerArticle) return;
        const error = paperReaderFailure(paper);
        if (!error) return;
        failures.push({ id, title, index: index + 1, stage: 'reader', error });
    });
    return failures;
}

function inferCurrentPaper(deep, stage) {
    const papers = papersOf(deep);
    if (papers.length === 0) return null;
    let candidates = [];
    if (stage === 'analysis') {
        candidates = papers.map((paper, index) => ({ paper, index })).filter(({ paper }) => !paperAnalysisPassed(paper));
    } else if (stage === 'reader') {
        candidates = papers.map((paper, index) => ({ paper, index }))
            .filter(({ paper }) => paperAnalysisPassed(paper) && !paperReaderPassed(paper));
    }
    if (candidates.length === 0) return null;
    let selected = null;
    for (const candidate of candidates) {
        const updatedAtMs = paperLatestUpdatedAtMs(candidate.paper);
        if (!selected || (updatedAtMs !== null && (selected.updatedAtMs === null || updatedAtMs >= selected.updatedAtMs))) {
            selected = { ...candidate, updatedAtMs };
        }
    }
    return {
        id: paperId(selected.paper),
        title: typeof selected.paper?.title === 'string' ? selected.paper.title : null,
        index: selected.index + 1,
        total: papers.length,
        stage
    };
}

function fileAgeSeconds(mtimeMsValue, nowMs) {
    if (!Number.isFinite(mtimeMsValue)) return null;
    return Math.max(0, Math.floor((nowMs - mtimeMsValue) / 1000));
}

function dateInLogFileName(name) {
    const compact = String(name || '').match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/);
    if (compact) {
        const candidate = `${compact[1]}-${compact[2]}-${compact[3]}`;
        if (isValidDate(candidate)) return candidate;
    }
    const dashed = String(name || '').match(/(20\d{2}-\d{2}-\d{2})/);
    if (dashed && isValidDate(dashed[1])) return dashed[1];
    return null;
}

// “最近日志”必须属于目标日期：优先从文件名解析日期，文件名没日期时退回文件写入日期。
function logMatchesTargetDate(name, mtimeMs, date) {
    const fromName = dateInLogFileName(name);
    if (fromName) return fromName === date;
    return beijingDateFromMs(mtimeMs) === date;
}

function readLatestLog(logsDir, options = {}) {
    if (!logsDir) return null;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const date = options.date && isValidDate(options.date) ? options.date : null;
    let names;
    try {
        names = fs.readdirSync(logsDir).filter(name => name.endsWith('.log'));
    } catch (_error) {
        return null;
    }
    let newest = null;
    for (const name of names) {
        const filePath = path.join(logsDir, name);
        let stat;
        try {
            stat = fs.lstatSync(filePath);
        } catch (_error) {
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (date && !logMatchesTargetDate(name, stat.mtimeMs, date)) continue;
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name, filePath, mtimeMs: stat.mtimeMs };
    }
    if (!newest) return null;
    let line = '';
    try {
        const fd = fs.openSync(newest.filePath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const length = Math.min(size, LOG_TAIL_BYTES);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
            const lines = buffer.toString('utf8').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
            line = lines.length ? lines[lines.length - 1] : '';
        } finally {
            fs.closeSync(fd);
        }
    } catch (_error) {
        line = '';
    }
    const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+08:00)\]\s*(.*)$/);
    return {
        file: newest.name,
        path: newest.filePath,
        line,
        message: match ? match[2] : line,
        timestamp: match ? match[1] : null,
        ageSeconds: fileAgeSeconds(newest.mtimeMs, nowMs),
        dateMatched: date !== null
    };
}

function readAccountPoolStatus(stateFile, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const base = {
        available: null,
        cooling: null,
        total: null,
        services: null,
        earliestRetryAt: null,
        missing: false,
        error: null
    };
    if (!stateFile) return { ...base, missing: true };
    let text;
    try {
        text = fs.readFileSync(stateFile, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { ...base, missing: true };
        return { ...base, error: error?.message || String(error) };
    }
    let state;
    try {
        state = JSON.parse(text);
    } catch (error) {
        return { ...base, error: `账号池状态不是合法 JSON：${error.message}` };
    }
    if (!state || typeof state !== 'object' || !state.services || typeof state.services !== 'object') {
        return { ...base, error: '账号池状态缺少 services' };
    }
    let available = 0;
    let cooling = 0;
    let total = 0;
    let earliestRetryAtMs = null;
    let services = 0;
    for (const service of Object.values(state.services)) {
        if (!service || typeof service !== 'object') continue;
        services += 1;
        for (const record of Object.values(service.accounts || {})) {
            total += 1;
            const blockedUntilMs = Number(record?.blockedUntilMs);
            if (Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs) {
                cooling += 1;
                if (earliestRetryAtMs === null || blockedUntilMs < earliestRetryAtMs) {
                    earliestRetryAtMs = blockedUntilMs;
                }
            } else {
                available += 1;
            }
        }
    }
    return {
        available,
        cooling,
        total,
        services,
        earliestRetryAt: earliestRetryAtMs === null ? null : formatBeijingIso(earliestRetryAtMs),
        missing: false,
        error: null
    };
}

function logStageHint(latestLog, options = {}) {
    if (!latestLog) return null;
    const freshSeconds = Number.isFinite(options.logFreshSeconds)
        ? options.logFreshSeconds : DEFAULT_LOG_FRESH_SECONDS;
    if (latestLog.ageSeconds !== null && latestLog.ageSeconds > freshSeconds) return null;
    const fileName = String(latestLog.file || '').toLowerCase();
    const filePatterns = [
        [/full-fetch|fetch-papers/, 'fetch'],
        [/generate-blog/, 'pages'],
        [/review-blog|manual-review-blog/, 'review'],
        [/push-blog/, 'push'],
        [/plan-post-publish-visuals|visual/, 'visual'],
        [/api-reader|reader-refresh|reader-feedback/, 'reader'],
        [/deep-analyzer|deep-analysis|batch-analyze|reanalyze/, 'analysis']
    ];
    for (const [pattern, stage] of filePatterns) {
        if (pattern.test(fileName)) return stage;
    }
    const message = String(latestLog.message || latestLog.line || '');
    const linePatterns = [
        [/npm run digest:prepare|\bfull-fetch\b|开始抓取|抓取候选/, 'fetch'],
        [/npm run blog:generate|生成博客页面|blog:generate/, 'pages'],
        [/npm run blog:review|blog:review\b|开始博客审查/, 'review'],
        [/npm run blog:push|blog:push\b|推送到远端/, 'push'],
        [/npm run visual:prepare|visual:prepare|开始生成长图|生成封面/, 'visual'],
        [/api:reader:refresh|API Reader|apiReaderArticle/, 'reader'],
        [/deep-analyzer|深度分析|analysis-engine/, 'analysis'],
        [/开始筛选|执行筛选|filter-decisions(?:\.json)?/, 'filter']
    ];
    for (const [pattern, stage] of linePatterns) {
        if (pattern.test(message)) return stage;
    }
    return null;
}

function applyLogStageHint(stage, hint, latestLog = null) {
    if (!hint || !(hint in STAGE_INDEX) || !(stage in STAGE_INDEX)) return stage;
    // 日志只用来把文件证据往前推：新日志提到更靠后的阶段时采用它。
    if (STAGE_INDEX[hint] > STAGE_INDEX[stage]) return hint;
    // 已完成批次后又出现新的抓取日志，说明同一日期重跑已开始；日志必须属于目标日期。
    if (stage === 'complete' && hint === 'fetch' && latestLog?.dateMatched === true) return hint;
    return stage;
}

function visualGateComplete(date, generation, visualManifest, coverManifest, review) {
    // 生产 generation.visualSummaryRequired 恒为 false（视觉是发布后独立阶段），
    // 是否要求长图/封面以审查凭证的 postPublishVisuals 为准；没有凭证时才回退 generation。
    const visualRequired = review && typeof review.postPublishVisuals === 'string'
        ? review.postPublishVisuals === 'required'
        : generation?.visualSummaryRequired !== false;
    const coverRequired = generation?.digestCoverRequired !== false;
    const counts = visualManifest?.counts || {};
    const visualOk = !visualRequired || (
        documentMatchesDate(visualManifest, date, ['batchDate'])
        && visualManifest?.overallStatus === 'complete'
        && Number.isInteger(counts.totalCards) && counts.totalCards > 0
        && Number.isInteger(counts.completeCards) && counts.completeCards === counts.totalCards
        && Number(counts.pendingCards || 0) === 0
    );
    const coverOk = !coverRequired || (
        documentMatchesDate(coverManifest, date, ['batchDate'])
        && coverManifest?.overallStatus === 'complete'
    );
    return visualOk && coverOk;
}

function inferStage(evidence = {}) {
    const {
        date,
        raw,
        fetchCheckpoint,
        decisions,
        filtered,
        deep,
        generation,
        review,
        visualManifest,
        coverManifest,
        counts,
        latestLog,
        logFreshSeconds
    } = evidence;
    const hasRaw = documentMatchesDate(raw, date, ['batchDate']) && papersOf(raw).length > 0;
    const checkpointMatches = documentMatchesDate(fetchCheckpoint, date, ['batchDate']);
    const filteredComplete = documentMatchesDate(filtered, date, ['batchDate'])
        && filtered?.status === 'complete';
    const deepMatches = documentMatchesDate(deep, date, ['batchDate']);
    const generationMatches = documentMatchesDate(generation, date, ['date']);
    const reviewMatches = documentMatchesDate(review, date, ['date']);
    const pushComplete = Boolean(
        reviewMatches
        && typeof review.publicationCommit === 'string' && review.publicationCommit
        && review.remoteVerifiedOid === review.publicationCommit
    );

    let stage;
    if (!hasRaw && !checkpointMatches) stage = 'fetch';
    else if (!filteredComplete) {
        // 抓取写入候选后仍在筛选；决定已写全但 filtered 还没落盘也属于筛选收尾。
        stage = 'filter';
    } else if (!deepMatches || papersOf(deep).length === 0) stage = 'analysis';
    else {
        const analysisCounts = counts || inferAnalysisCounts(deep);
        if (analysisCounts.analysisPassed < analysisCounts.total || analysisCounts.analysisFailed > 0) stage = 'analysis';
        else if (analysisCounts.readerTotal > 0 && analysisCounts.readerPassed < analysisCounts.readerTotal) stage = 'reader';
        else if (!generationMatches) stage = 'pages';
        else if (!reviewMatches || review.strictReview !== true) stage = 'review';
        else if (!pushComplete) stage = 'push';
        else if (!visualGateComplete(date, generation, visualManifest, coverManifest, review)) stage = 'visual';
        else stage = 'complete';
    }
    const hint = logStageHint(latestLog, { logFreshSeconds });
    return { stage: applyLogStageHint(stage, hint), logStageHint: hint };
}

function reviewCounts(generation, review) {
    const generationFiles = Array.isArray(generation?.files) ? generation.files : [];
    const reviewFiles = Array.isArray(review?.files) ? review.files : [];
    const reviewedPaths = new Set(reviewFiles.map(file => file?.path).filter(Boolean));
    const total = generationFiles.length || (review ? reviewFiles.length : null);
    const reviewed = reviewFiles.length;
    const strictReview = review?.strictReview === true;
    const passed = strictReview ? reviewed : 0;
    let failed = null;
    if (generationFiles.length > 0) failed = generationFiles.filter(file => !reviewedPaths.has(file?.path)).length;
    else if (review) failed = strictReview ? 0 : 1;
    return { total, reviewed, passed, failed, strictReview };
}

function suggestCommands(stage, date, details = {}) {
    const statusCommand = `npm run digest:status -- --date ${date}`;
    const watchCommand = `npm run digest:status -- --date ${date} --watch --interval 10`;
    switch (stage) {
        case 'fetch':
            return [`npm run digest:prepare -- ${date}`, watchCommand];
        case 'filter':
            return [`npm run digest:prepare -- ${date}`, watchCommand];
        case 'analysis':
            return details.failedCount > 0
                ? [`npm run deep -- --date ${date}`, statusCommand, watchCommand]
                : [statusCommand, watchCommand];
        case 'reader':
            return [`npm run api:reader:refresh -- --all --date ${date} --concurrency 5 --scoring-and-reader`, watchCommand];
        case 'pages':
            return [`npm run blog:generate -- --date ${date}`, watchCommand];
        case 'review':
            return [`npm run blog:review -- --date ${date}`, watchCommand];
        case 'push':
            return [`npm run blog:push -- --date ${date}`, watchCommand];
        case 'visual':
            return [`npm run visual:prepare -- --date ${date}`, watchCommand];
        case 'complete':
        default:
            return [statusCommand];
    }
}

function computeProgress(keyFilePaths, nowMs) {
    let lastMtimeMs = null;
    for (const filePath of keyFilePaths) {
        const value = mtimeMs(filePath);
        if (value === null) continue;
        if (lastMtimeMs === null || value > lastMtimeMs) lastMtimeMs = value;
    }
    if (lastMtimeMs === null) {
        return { lastProgressAt: null, secondsSinceProgress: null, lastProgressAtMs: null };
    }
    return {
        lastProgressAt: formatBeijingIso(lastMtimeMs),
        secondsSinceProgress: fileAgeSeconds(lastMtimeMs, nowMs),
        lastProgressAtMs: lastMtimeMs
    };
}

function usageForDate(paths, date, options, nowMs) {
    if (options.usage !== undefined) return { usage: options.usage, usageError: null };
    try {
        const usage = buildDailyUsageSummary({
            directory: paths.llmUsageDir,
            date,
            nowMs,
            cache: options.usageCache || createUsageSummaryCache(),
            mtimeSlackMs: options.usageMtimeSlackMs
        });
        return { usage, usageError: null };
    } catch (error) {
        return { usage: null, usageError: error?.message || String(error) };
    }
}

function buildLiveStatus(options = {}) {
    const nowMs = resolveNowMs(options);
    const date = resolveDate(options.date, nowMs);
    const paths = resolvePaths(options.paths);
    const readErrors = [];
    const readJson = filePath => readJsonSafe(filePath, readErrors);

    const raw = readJson(paths.rawCandidates);
    const fetchCheckpoint = readJson(paths.fetchCheckpoint);
    const decisions = readJson(paths.filterDecisions);
    const filtered = readJson(paths.filteredPapers);
    const deep = readJson(paths.deepAnalysisResult);
    const generationPath = path.join(paths.generationManifestDir || paths.currentDir, `blog-generation-manifest-${date}.json`);
    const reviewPath = path.join(paths.reviewReceiptDir || paths.currentDir, `blog-review-receipt-${date}.json`);
    const visualPath = path.join(paths.visualManifestDir, `${date}.json`);
    const coverPath = path.join(paths.coverManifestDir, `${date}.json`);
    const generation = readJson(generationPath);
    const review = readJson(reviewPath);
    const visualManifest = readJson(visualPath);
    const coverManifest = readJson(coverPath);

    const counts = inferAnalysisCounts(deep);
    const latestLog = options.latestLog !== undefined
        ? options.latestLog : readLatestLog(paths.logsDir, { nowMs, date });
    const { stage, logStageHint: hint } = inferStage({
        date,
        raw,
        fetchCheckpoint,
        decisions,
        filtered,
        deep,
        generation,
        review,
        visualManifest,
        coverManifest,
        counts,
        latestLog,
        logFreshSeconds: options.logFreshSeconds
    });

    const reviewInfo = reviewCounts(generation, review);
    const rawCount = raw ? papersOf(raw).length : null;
    const selectedCount = filtered ? papersOf(filtered).length
        : (Number.isInteger(decisions?.stats?.related) ? decisions.stats.related : null);
    const currentPaper = inferCurrentPaper(deep, stage);
    const failedPapers = collectFailedPapers(deep);
    const accountPool = readAccountPoolStatus(paths.accountPoolState, { nowMs });
    const { usage, usageError } = usageForDate(paths, date, options, nowMs);
    // 只有属于目标日期的产物才参与“无进度”计算；新日期尚未开跑时不报 stalled。
    const progressFiles = [];
    if (documentMatchesDate(raw, date, ['batchDate'])) progressFiles.push(paths.rawCandidates);
    if (documentMatchesDate(fetchCheckpoint, date, ['batchDate'])) progressFiles.push(paths.fetchCheckpoint);
    if (documentMatchesDate(decisions, date, ['batchDate'])) progressFiles.push(paths.filterDecisions);
    if (documentMatchesDate(filtered, date, ['batchDate'])) progressFiles.push(paths.filteredPapers);
    if (documentMatchesDate(deep, date, ['batchDate'])) progressFiles.push(paths.deepAnalysisResult);
    if (documentMatchesDate(generation, date, ['date'])) progressFiles.push(generationPath);
    if (documentMatchesDate(review, date, ['date'])) progressFiles.push(reviewPath);
    if (documentMatchesDate(visualManifest, date, ['batchDate'])) progressFiles.push(visualPath);
    if (documentMatchesDate(coverManifest, date, ['batchDate'])) progressFiles.push(coverPath);
    const batchStarted = progressFiles.length > 0;
    const progress = computeProgress(progressFiles, nowMs);
    const stallThresholdSeconds = Number.isFinite(options.stallThresholdSeconds)
        ? options.stallThresholdSeconds : DEFAULT_STALL_THRESHOLD_SECONDS;
    const stalled = batchStarted
        && stage !== 'complete'
        && progress.secondsSinceProgress !== null
        && progress.secondsSinceProgress >= stallThresholdSeconds;

    return {
        version: VERSION,
        date,
        generatedAt: formatBeijingIso(nowMs),
        stage,
        stageLabel: STAGE_LABELS[stage] || stage,
        logStageHint: hint,
        batchStarted,
        counts: {
            candidates: rawCount,
            selected: selectedCount,
            total: counts.total,
            analysisTotal: counts.total,
            analysisPassed: counts.analysisPassed,
            analysisFailed: counts.analysisFailed,
            analysisPending: counts.analysisPending,
            readerTotal: counts.readerTotal,
            readerPassed: counts.readerPassed,
            readerFailed: counts.readerFailed,
            readerPending: counts.readerPending,
            reviewTotal: reviewInfo.total,
            reviewReviewed: reviewInfo.reviewed,
            reviewPassed: reviewInfo.passed,
            reviewFailed: reviewInfo.failed,
            strictReview: reviewInfo.strictReview
        },
        currentPaper,
        totalPapers: counts.total,
        failedPapers,
        failedCount: failedPapers.length,
        latestLog,
        accountPool,
        usage: usage ? {
            date: usage.date,
            total: usage.total,
            success: usage.success,
            failed: usage.failed,
            cost: usage.cost,
            costEvents: usage.costEvents,
            byStage: usage.byStage,
            byModel: usage.byModel,
            byAccount: usage.byAccount
        } : null,
        usageError,
        secondsSinceProgress: progress.secondsSinceProgress,
        lastProgressAt: progress.lastProgressAt,
        stalled,
        stallThresholdSeconds,
        suggestions: suggestCommands(stage, date, { failedCount: failedPapers.length }),
        readErrors
    };
}

function display(value, suffix = '') {
    return value === null || value === undefined ? '?' : `${value}${suffix}`;
}

function formatLiveStatus(status) {
    const lines = [
        `[digest-live] ${status.date} ${status.generatedAt} 阶段=${status.stageLabel || status.stage}`
    ];
    const counts = status.counts || {};
    lines.push(
        `  候选=${display(counts.candidates)} 入选=${display(counts.selected)}`
        + ` | 分析通过=${display(counts.analysisPassed)}/${display(counts.analysisTotal)}`
        + ` 失败=${display(counts.analysisFailed)} 进行中=${display(counts.analysisPending)}`
        + ` | Reader 通过=${display(counts.readerPassed)}/${display(counts.readerTotal)}`
        + ` 失败=${display(counts.readerFailed)} 进行中=${display(counts.readerPending)}`
    );
    if (status.currentPaper) {
        const paper = status.currentPaper;
        lines.push(`  当前论文=${paper.index}/${paper.total} ${paper.id || '?'} ${paper.title ? paper.title.slice(0, 60) : ''}`.trimEnd());
    } else {
        lines.push(`  当前论文=无 总数=${display(status.totalPapers)}`);
    }
    lines.push(
        `  审查 严格=${counts.strictReview === true ? '是' : counts.strictReview === false ? '否' : '?'}`
        + ` 已审=${display(counts.reviewReviewed)}/${display(counts.reviewTotal)}`
        + ` 未通过=${display(counts.reviewFailed)}`
    );
    const accountPool = status.accountPool || {};
    const usage = status.usage;
    let usageText;
    if (!usage) usageText = `未知${status.usageError ? `（${status.usageError}）` : ''}`;
    else if (Number(usage.costEvents || 0) > 0) {
        usageText = `调用=${usage.total} 成功=${usage.success} 失败=${usage.failed} 费用=$${Number(usage.cost || 0).toFixed(4)}`;
    } else {
        usageText = `调用=${usage.total} 成功=${usage.success} 失败=${usage.failed} 费用=无费用记录（仅有 token 用量）`;
    }
    lines.push(
        `  账号池 可用=${display(accountPool.available)} 冷却=${display(accountPool.cooling)}`
        + `${accountPool.earliestRetryAt ? ` 最早恢复=${accountPool.earliestRetryAt}` : ''}`
        + ` | 本次费用 ${usageText}`
    );
    if (status.stage === 'complete') {
        lines.push('  状态=已完成（无需等待）');
        lines.push('  注意: 本状态未核验部署与网页；报告完成不等于已上线，还须确认 GitHub Pages build/deploy 与逐页 HTTP 200 和标题。');
    } else if (!status.batchStarted) {
        lines.push('  连续无进度=未知（目标日期尚未开始，无产物可判断）');
    } else {
        lines.push(
            `  连续无进度=${status.secondsSinceProgress === null ? '未知' : `${status.secondsSinceProgress} 秒`}`
            + `${status.stalled ? `  ⚠ 超过 ${status.stallThresholdSeconds} 秒，可能卡在模型请求或网络等待` : ''}`
        );
    }
    if (status.latestLog) {
        const time = status.latestLog.timestamp ? `[${status.latestLog.timestamp}] ` : '';
        lines.push(`  最近日志 ${time}${status.latestLog.message || status.latestLog.line || ''}`.trimEnd());
    } else {
        lines.push('  最近日志 无');
    }
    for (const failure of (status.failedPapers || []).slice(0, 5)) {
        lines.push(`  失败 ${failure.index}/${status.totalPapers} ${failure.id || '?'} [${failure.stage}] ${failure.error || ''}`.trimEnd());
    }
    if ((status.failedPapers || []).length > 5) {
        lines.push(`  失败 …还有 ${status.failedPapers.length - 5} 篇`);
    }
    for (const command of status.suggestions || []) lines.push(`  建议: ${command}`);
    return lines.join('\n');
}

module.exports = {
    visualGateComplete,
    VERSION,
    STAGES,
    STAGE_LABELS,
    DEFAULT_STALL_THRESHOLD_SECONDS,
    DEFAULT_LOG_FRESH_SECONDS,
    inferAnalysisCounts,
    collectFailedPapers,
    inferCurrentPaper,
    logStageHint,
    applyLogStageHint,
    inferStage,
    readLatestLog,
    readAccountPoolStatus,
    buildLiveStatus,
    formatLiveStatus
};
