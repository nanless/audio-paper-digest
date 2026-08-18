#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 完整论文抓取 + 深度分析（arxiv + HuggingFace Papers）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchCategoryPapers, filterPapersWithLLM, buildFilterInputSha256 } = require('./fetch-papers.js');
const { KEYWORD_PREFILTER_VERSION } = require('./lib/keyword-prefilter.js');
const { fetchHuggingFacePapers, mergeAndDeduplicate } = require('./fetch-huggingface-papers.js');
const { writeFileAtomic, getBeijingISOString, getBeijingCompactTimestamp, getBeijingDateString, normalizeToBeijingISOString, readJsonSafe, getRecordDate, normalizedId, backupPapersJson, loadPublishedIdsFromBlog, loadPrompt, detectApiType } = require('./utils.js');
const {
    analyzeBatch,
    mergeAndSaveResults,
    mergePapersById,
    readJsonFileStrict,
    updateJsonFileLocked,
    withFileLock,
    withFileLockSync,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getCanonicalAnalysisRunSummary,
    getAnalysisExitCode,
    mergeCanonicalAnalysisState
} = require('./analysis-engine.js');
const {
    markPaperDigestStatus,
    savePapersDatabase,
    loadPapersDatabase,
    updateAnalysisDigestStatuses
} = require('./digest-status.js');

const Config = require('./config.js');

// 从配置中解构常用参数
const ANALYSIS_CONCURRENCY = Config.ANALYSIS_CONFIG.concurrency;
const ANALYSIS_RETRY_MAX = Config.ANALYSIS_CONFIG.maxRetries;
const ANALYSIS_RETRY_DELAY_MS = Config.ANALYSIS_CONFIG.retryDelayMs;
const FETCH_DELAY_MS = Config.ARXIV_CONFIG.categoryDelayMs;

const ARCHIVE_DIR = Config.ARCHIVE_DIR;
const RESULT_FILE = Config.FILES.deepAnalysisResult;
const LEGACY_RESULT_FILE = Config.FILES.deepAnalysisResultLegacy;
const FILTERED_FILE = Config.FILES.filteredPapers;
const PAPERS_FILE = Config.FILES.papers;
const ANALYZED_FILE = Config.FILES.analyzed;
const RAW_CANDIDATES_FILE = Config.FILES.rawCandidates;
const FILTER_DECISIONS_FILE = Config.FILES.filterDecisions;
const FETCH_CHECKPOINT_FILE = Config.FILES.fetchCheckpoint;
const FULL_FETCH_RUN_LOCK = path.join(Config.CURRENT_DIR, '.full-fetch-run');

function shouldUsePaperForFetchDedup(paper) {
    const status = paper?.digestStatus?.status;
    return status !== 'pending_analysis' && status !== 'analysis_failed';
}

function getFilterPromptHash() {
    const prompt = loadPrompt('prompts/filter.md', {
        title: '__TITLE__', abstract: '__ABSTRACT__', categories: '__CATEGORIES__'
    });
    return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function getFilterConfigFingerprint(filterPromptHash = getFilterPromptHash()) {
    const endpoint = process.env.PAPER_ANALYZER_ENDPOINT || '';
    const model = process.env.PAPER_ANALYZER_MODEL || '';
    return stableHash({
        model,
        endpoint,
        protocol: detectApiType(endpoint, model),
        temperature: Config.FILTER_CONFIG.temperature,
        maxTokens: Config.FILTER_CONFIG.maxTokens,
        promptHash: filterPromptHash,
        decisionContractVersion: Config.FILTER_CONFIG.decisionContractVersion,
        keywordPrefilterEnabled: Config.FILTER_CONFIG.keywordPrefilterEnabled,
        keywordPrefilterVersion: KEYWORD_PREFILTER_VERSION
    });
}

function stableHash(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') {
            return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
        }
        return item;
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex').slice(0, 16);
}

function stableContentSha256(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') {
            return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
        }
        return item;
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function applyFetchSourceIntegrity(entry) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.papers)) return entry;
    entry.papersCount = entry.papers.length;
    entry.papersSha256 = stableContentSha256(entry.papers);
    return entry;
}

function getFetchSourcesSha256(checkpoint) {
    return stableContentSha256({
        arxiv: Object.fromEntries(Object.entries(checkpoint?.arxiv || {}).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, entry]) => [id, {
                status: entry?.status,
                papersCount: entry?.papersCount,
                papersSha256: entry?.papersSha256
            }])),
        huggingface: checkpoint?.huggingface ? {
            status: checkpoint.huggingface.status,
            papersCount: checkpoint.huggingface.papersCount,
            papersSha256: checkpoint.huggingface.papersSha256
        } : null
    });
}

function pinPapersToBatch(papers, batchStartedAt) {
    for (const paper of papers || []) paper.fetchedAt = batchStartedAt;
    return papers;
}

function mergePaperCategories(target, incoming) {
    const categories = new Set([
        ...(Array.isArray(target?.categories) ? target.categories : []),
        ...(Array.isArray(incoming?.categories) ? incoming.categories : [])
    ].filter(Boolean));
    target.categories = Array.from(categories).sort();
    return target;
}

function hasValidFetchSourceIntegrity(entry) {
    return Boolean(entry)
        && Array.isArray(entry.papers)
        && Number.isInteger(entry.papersCount)
        && entry.papersCount >= 0
        && entry.papersCount === entry.papers.length
        && typeof entry.papersSha256 === 'string'
        && /^[a-f0-9]{64}$/.test(entry.papersSha256)
        && entry.papersSha256 === stableContentSha256(entry.papers);
}

function getSourceConfigFingerprint() {
    return stableHash({
        // v3: recent 抓取即使短页也必须请求配置范围内的后续 offset；
        // 升级来源契约以淘汰旧版可能只检查第一页的当天 checkpoint。
        sourceContractVersion: 3,
        arxivCategories: Config.ARXIV_CATEGORIES.map(({ id, priority }) => ({ id, priority })),
        arxiv: {
            maxResultsPerCategory: Config.ARXIV_CONFIG.maxResultsPerCategory,
            consecutiveExistingThreshold: Config.ARXIV_CONFIG.consecutiveExistingThreshold,
            explicitPageSize: 50,
            mergeCrossCategoryMembership: true
        },
        huggingface: {
            days: Config.HUGGINGFACE_CONFIG.defaultDays,
            minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
            maxPages: Config.HUGGINGFACE_CONFIG.maxPages,
            pageLimit: Config.HUGGINGFACE_CONFIG.pageLimit,
            paginatePapersApi: true,
            dailyCutoffField: 'hfSelectedAt'
        }
    });
}

function buildCandidateFingerprints(historicalExistingIds, publishedIds) {
    const sourceConfigFingerprint = getSourceConfigFingerprint();
    const blogDedupFingerprint = stableHash(Array.from(publishedIds || []).sort());
    const historyFingerprint = stableHash(Array.from(historicalExistingIds || []).sort());
    return {
        sourceConfigFingerprint,
        blogDedupFingerprint,
        candidateFingerprint: stableHash({ sourceConfigFingerprint, blogDedupFingerprint, historyFingerprint })
    };
}

function buildHistoricalDedupBaseline(papersData, today, publishedIds) {
    const ids = new Set(Object.entries(papersData?.papers || {})
        .filter(([, paper]) => shouldUsePaperForFetchDedup(paper))
        // fetchedAt 表示论文首次进入抓取批次，重分析只会更新 digestStatus.batchDate。
        // 因此不能用可变的分析日期判断“是否为本轮自写”，否则今天重分析的历史论文
        // 会从去重基线消失。旧记录缺 fetchedAt 时才退回 digestStatus.batchDate。
        .filter(([, paper]) => String(paper.fetchedAt || paper.digestStatus?.batchDate || '').slice(0, 10) !== today)
        .map(([id]) => normalizedId(id))
        .filter(Boolean));
    for (const id of publishedIds || []) ids.add(normalizedId(id));
    return Array.from(ids).filter(Boolean).sort();
}

function loadFetchCheckpoint(today, candidateFingerprint, filePath = FETCH_CHECKPOINT_FILE) {
    const data = loadTodayJsonFile(filePath, today);
    if (!data || data.candidateFingerprint !== candidateFingerprint) return null;
    if (!data.arxiv || typeof data.arxiv !== 'object') data.arxiv = {};
    if (!Array.isArray(data.historicalDedupIds) || !Array.isArray(data.categoryOrder)) return null;
    for (const [categoryId, entry] of Object.entries(data.arxiv)) {
        if (!hasValidFetchSourceIntegrity(entry)) {
            console.log(`  [fetch] arXiv ${categoryId} checkpoint 内容完整性校验失败，仅重抓该来源`);
            delete data.arxiv[categoryId];
        }
    }
    if (data.huggingface && !hasValidFetchSourceIntegrity(data.huggingface)) {
        console.log('  [fetch] HuggingFace checkpoint 内容完整性校验失败，仅重抓该来源');
        data.huggingface = null;
    }
    return data;
}

function saveFetchCheckpoint(checkpoint, filePath = FETCH_CHECKPOINT_FILE) {
    for (const entry of Object.values(checkpoint.arxiv || {})) applyFetchSourceIntegrity(entry);
    if (checkpoint.huggingface) applyFetchSourceIntegrity(checkpoint.huggingface);
    checkpoint.fetchSourcesSha256 = getFetchSourcesSha256(checkpoint);
    checkpoint.timestamp = checkpoint.batchStartedAt || checkpoint.timestamp || getBeijingISOString();
    checkpoint.batchDate = checkpoint.batchDate || checkpoint.timestamp.slice(0, 10);
    checkpoint.batchId = checkpoint.batchId || stableHash({ batchStartedAt: checkpoint.timestamp, candidateFingerprint: checkpoint.candidateFingerprint });
    writeFileAtomic(filePath, JSON.stringify(checkpoint, null, 2));
}

function hasCompleteSourceHealth(sourceHealth, expectedCategoryIds = Config.ARXIV_CATEGORIES.map(c => c.id)) {
    const categories = sourceHealth?.arxiv?.categories;
    if (!Array.isArray(categories)) return false;
    const byId = new Map(categories.map(item => [item?.id, item]));
    if (byId.size !== expectedCategoryIds.length) return false;
    if (expectedCategoryIds.some(id => byId.get(id)?.ok !== true)) return false;
    return sourceHealth?.huggingface?.ok === true;
}

function hasCompleteFetchCheckpoint(checkpoint, expectedCategoryIds = Config.ARXIV_CATEGORIES.map(c => c.id)) {
    return Boolean(checkpoint)
        && expectedCategoryIds.every(id => checkpoint.arxiv?.[id]?.status === 'complete'
            && checkpoint.arxiv[id].health?.ok === true
            && hasValidFetchSourceIntegrity(checkpoint.arxiv[id]))
        && checkpoint.huggingface?.status === 'complete'
        && checkpoint.huggingface.health?.ok === true
        && hasValidFetchSourceIntegrity(checkpoint.huggingface)
        && checkpoint.fetchSourcesSha256 === getFetchSourcesSha256(checkpoint);
}

function hasCrossProcessReusableFetchCheckpoint(
    checkpoint,
    expectedCategoryIds = Config.ARXIV_CATEGORIES.map(c => c.id)
) {
    return hasCompleteFetchCheckpoint(checkpoint, expectedCategoryIds)
        && expectedCategoryIds.every(id => isReusableArxivCheckpoint(checkpoint.arxiv?.[id]));
}

function isDefinitiveFilterDecision(decision) {
    return Boolean(decision)
        && typeof decision.related === 'boolean'
        && !decision.retryable
        && !decision.fallback;
}

function validateFilterDecisionCoverage(papers, decisions) {
    const paperById = new Map((papers || []).map(paper => [normalizedId(paper), paper]).filter(([id]) => Boolean(id)));
    const candidateIds = new Set(paperById.keys());
    const decisionEntries = Object.entries(decisions || {})
        .map(([id, decision]) => [normalizedId(id), decision])
        .filter(([id]) => Boolean(id));
    const validDecisionIds = new Set(decisionEntries
        .filter(([id, decision]) => isDefinitiveFilterDecision(decision)
            && decision.inputSha256 === buildFilterInputSha256(paperById.get(id)))
        .map(([id]) => id));
    const retryableIds = decisionEntries
        .filter(([id, decision]) => !isDefinitiveFilterDecision(decision)
            || decision.inputSha256 !== buildFilterInputSha256(paperById.get(id)))
        .map(([id]) => id);
    const missingIds = Array.from(candidateIds).filter(id => !validDecisionIds.has(id));
    const unexpectedIds = Array.from(validDecisionIds).filter(id => !candidateIds.has(id));
    return {
        complete: missingIds.length === 0 && unexpectedIds.length === 0 && retryableIds.length === 0,
        totalCandidates: candidateIds.size,
        decided: Array.from(validDecisionIds).filter(id => candidateIds.has(id)).length,
        missingIds,
        unexpectedIds,
        retryableIds
    };
}

function loadReusableFilterDecisions(today, filterModel, filterPromptHash, expected = {}) {
    if (!fs.existsSync(FILTER_DECISIONS_FILE)) return {};
    const data = readJsonSafe(FILTER_DECISIONS_FILE);
    if (!data || getRecordDate(data) !== today) return {};
    if (data.filterModel !== filterModel || data.filterPromptHash !== filterPromptHash) {
        console.log('  [filter] 已有筛选决策与当前模型/prompt 不一致，忽略旧缓存');
        return {};
    }
    for (const key of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint', 'filterConfigFingerprint']) {
        if (expected[key] !== undefined && data[key] !== expected[key]) return {};
    }
    if (!data.decisions || typeof data.decisions !== 'object') return {};
    return Object.fromEntries(Object.entries(data.decisions).filter(([, decision]) => isDefinitiveFilterDecision(decision)));
}

function loadTodayJsonFile(filePath, today) {
    if (!fs.existsSync(filePath)) return null;
    const data = readJsonSafe(filePath);
    if (!data || getRecordDate(data) !== today) return null;
    return data;
}

// 筛选中断后，raw-candidates 已经记录了同一批候选与来源健康状态。只要
// 模型/prompt 未变化且来源健康，就应直接续跑缺失决定，不能再次全量请求
// arXiv；后者既浪费时间，也会把一次格式异常放大为 429 限流问题。
function loadResumableFilterForToday(today, expected = {}, files = {}) {
    const rawFile = files.rawCandidates || RAW_CANDIDATES_FILE;
    const decisionsFile = files.filterDecisions || FILTER_DECISIONS_FILE;
    const rawCandidates = loadTodayJsonFile(rawFile, today);
    let decisionsData = loadTodayJsonFile(decisionsFile, today);
    if (!rawCandidates || !Array.isArray(rawCandidates.papers)) return null;
    if (rawCandidates.rawPapersSha256 !== stableContentSha256(rawCandidates.papers)) return null;
    for (const key of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint']) {
        if (expected[key] !== undefined && rawCandidates[key] !== expected[key]) return null;
    }
    if (!hasCompleteSourceHealth(rawCandidates.sourceHealth)) return null;
    const fetchFile = files.fetchCheckpoint || FETCH_CHECKPOINT_FILE;
    const checkpoint = loadFetchCheckpoint(today, rawCandidates.candidateFingerprint, fetchFile);
    if (!hasCrossProcessReusableFetchCheckpoint(checkpoint)
        || rawCandidates.fetchSourcesSha256 !== checkpoint.fetchSourcesSha256) return null;
    const decisionsMatch = decisionsData
        && decisionsData.filterModel === expected.filterModel
        && decisionsData.filterPromptHash === expected.filterPromptHash
        && decisionsData.candidateFingerprint === rawCandidates.candidateFingerprint
        && decisionsData.sourceConfigFingerprint === rawCandidates.sourceConfigFingerprint
        && decisionsData.blogDedupFingerprint === rawCandidates.blogDedupFingerprint
        && decisionsData.filterConfigFingerprint === expected.filterConfigFingerprint
        && decisionsData.rawPapersSha256 === rawCandidates.rawPapersSha256
        && decisionsData.fetchSourcesSha256 === rawCandidates.fetchSourcesSha256
        && decisionsData.decisions && typeof decisionsData.decisions === 'object';
    if (!decisionsMatch) {
        decisionsData = { decisions: {}, filterModel: expected.filterModel, filterPromptHash: expected.filterPromptHash };
    }

    const coverage = validateFilterDecisionCoverage(rawCandidates.papers, decisionsData.decisions);
    return { rawCandidates, decisionsData, coverage };
}

function loadCompleteFilteredForToday(today, filePath = FILTERED_FILE, expected = {}) {
    const data = loadTodayJsonFile(filePath, today);
    if (!data || data.status !== 'complete' || !Array.isArray(data.papers)) return null;
    if (expected.filterModel !== undefined && data.filterModel !== expected.filterModel) return null;
    if (expected.filterPromptHash !== undefined && data.filterPromptHash !== expected.filterPromptHash) return null;
    for (const key of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint', 'filterConfigFingerprint']) {
        if (expected[key] !== undefined && data[key] !== expected[key]) return null;
    }
    if (expected.requireConsistentFilterArtifacts && !hasConsistentFilterArtifacts(today, data)) {
        console.log('  [filter] 今日筛选产物与逐篇决策缓存不一致，忽略 complete 缓存并重新筛选');
        return null;
    }
    return data;
}

function hasConsistentFilterArtifacts(today, filteredData) {
    const decisionsData = loadTodayJsonFile(FILTER_DECISIONS_FILE, today);
    const rawCandidates = loadTodayJsonFile(RAW_CANDIDATES_FILE, today);
    const checkpoint = loadFetchCheckpoint(today, rawCandidates?.candidateFingerprint, FETCH_CHECKPOINT_FILE);
    return validateFilterArtifacts(filteredData, decisionsData, rawCandidates, checkpoint);
}

function validateFilterArtifacts(filteredData, decisionsData, rawCandidates = null, checkpoint = null) {
    if (!filteredData || !decisionsData || !decisionsData.decisions || typeof decisionsData.decisions !== 'object') {
        return false;
    }
    if (!checkpoint || !hasCrossProcessReusableFetchCheckpoint(checkpoint)) return false;
    const batchDates = [
        checkpoint.batchDate,
        rawCandidates?.batchDate,
        decisionsData.batchDate,
        filteredData.batchDate
    ];
    if (batchDates.some(date => typeof date !== 'string' || date !== batchDates[0])) return false;
    if (decisionsData.stats?.complete !== true) return false;
    if (decisionsData.filterModel !== filteredData.filterModel) return false;
    if (decisionsData.filterPromptHash !== filteredData.filterPromptHash) return false;
    if (!decisionsData.filterConfigFingerprint || decisionsData.filterConfigFingerprint !== filteredData.filterConfigFingerprint) return false;

    const decisionIds = new Set(Object.keys(decisionsData.decisions).map(id => normalizedId(id)).filter(Boolean));
    const decisionCount = decisionIds.size;
    const filteredStats = filteredData.stats || {};
    if (Number.isInteger(filteredStats.decisionCount) && filteredStats.decisionCount !== decisionCount) {
        return false;
    }

    if (!rawCandidates || !Array.isArray(rawCandidates.papers) || !hasCompleteSourceHealth(rawCandidates.sourceHealth)) return false;
    if (rawCandidates.rawPapersSha256 !== stableContentSha256(rawCandidates.papers)) return false;
    if (decisionsData.rawPapersSha256 !== rawCandidates.rawPapersSha256 || filteredData.rawPapersSha256 !== rawCandidates.rawPapersSha256) return false;
    if (rawCandidates.fetchSourcesSha256 !== checkpoint.fetchSourcesSha256
        || decisionsData.fetchSourcesSha256 !== checkpoint.fetchSourcesSha256
        || filteredData.fetchSourcesSha256 !== checkpoint.fetchSourcesSha256) return false;
    for (const key of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint']) {
        if (!rawCandidates[key] || filteredData[key] !== rawCandidates[key] || decisionsData[key] !== rawCandidates[key]) return false;
    }
    const coverage = validateFilterDecisionCoverage(rawCandidates.papers, decisionsData.decisions);
    if (!coverage.complete || coverage.decided !== decisionCount) return false;
    if (decisionsData.stats.totalCandidates !== coverage.totalCandidates) return false;
    if (decisionsData.stats.decided !== coverage.decided) return false;

    const excluded = new Set((filteredData.excludedRelatedIds || []).map(normalizedId).filter(Boolean));
    if (excluded.size !== (filteredData.stats?.skippedFromArchive || 0)) return false;
    const rawById = new Map(rawCandidates.papers.map(paper => [normalizedId(paper), paper]));
    if (Array.from(excluded).some(id => decisionsData.decisions[id]?.related !== true || !rawById.get(id)?.sources?.includes('huggingface'))) return false;
    const expectedRelated = new Set(Object.entries(decisionsData.decisions)
        .filter(([, decision]) => decision.related === true)
        .map(([id]) => normalizedId(id))
        .filter(id => id && !excluded.has(id)));
    const filteredIds = (filteredData.papers || []).map(normalizedId).filter(Boolean);
    if (filteredIds.length !== new Set(filteredIds).size) return false;
    if (filteredIds.length !== expectedRelated.size || filteredIds.some(id => !expectedRelated.has(id))) return false;

    return true;
}

function loadCurrentSuccessfulAnalysisIds(filePath = RESULT_FILE, today = null) {
    const data = readJsonFileStrict(filePath, { allowMissing: true });
    if (!data) return new Set();
    const papers = Array.isArray(data) ? data : (data.papers || []);
    if (!Array.isArray(papers)) {
        throw new Error(`分析结果 papers 必须是数组，已阻止读取损坏文件: ${filePath}`);
    }
    const ids = new Set();
    for (const paper of papers) {
        if (!isSuccessfulAnalysisRecord(paper)) continue;
        if (today) {
            const paperDate = (paper.digestStatus?.batchDate || paper.batchDate
                || paper.fetchedAt || paper.timestamp || '').slice(0, 10);
            if (paperDate !== today) continue;
        }
        const id = normalizedId(paper);
        if (id) ids.add(id);
    }
    return ids;
}

function loadCanonicalAnalysisRecord(filePath, paper) {
    const data = readJsonFileStrict(filePath, { allowMissing: true });
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const id = normalizedId(paper);
    return papers.find(item => normalizedId(item) === id) || null;
}

function saveFinalAnalysisResults(filePath, newResults, expectedPapers, stats = {}) {
    return updateJsonFileLocked(filePath, current => {
        const existingPapers = Array.isArray(current) ? current : (current?.papers || []);
        const allMergedPapers = mergePapersById(existingPapers, newResults, {
            preserveSuccessfulAnalysis: true
        });
        const mergedById = new Map(allMergedPapers.map(paper => [normalizedId(paper), paper]));
        const expectedIds = new Set((expectedPapers || []).map(normalizedId).filter(Boolean));
        const mergedPapers = Array.from(expectedIds)
            .map(id => mergedById.get(id))
            .filter(Boolean);
        let successful = 0;
        for (const id of expectedIds) {
            if (isSuccessfulAnalysisRecord(mergedById.get(id))) successful++;
        }
        const remainingFailed = expectedIds.size - successful;
        const inferredStatus = getAnalysisRunStatus({ success: successful }, remainingFailed);
        const analysisStatus = inferredStatus;
        const now = getBeijingISOString();
        const expectedBatchDate = (expectedPapers || [])
            .map(paper => paper?.digestStatus?.batchDate || paper?.batchDate || String(paper?.fetchedAt || '').slice(0, 10))
            .find(Boolean);
        const batchDate = stats.batchDate || expectedBatchDate
            || (!Array.isArray(current) && current?.batchDate) || now.slice(0, 10);
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: now,
            batchDate,
            previousTimestamp: !Array.isArray(current) ? current?.timestamp || null : null,
            status: analysisStatus,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                ...stats,
                analysisStatus,
                remainingFailed,
                successfulExpected: successful,
                expected: expectedIds.size,
                removedUnexpected: allMergedPapers.length - mergedPapers.length,
                preservedExisting: mergedPapers.filter(paper => existingPapers.some(existing => normalizedId(existing) === normalizedId(paper))).length,
                totalAfterMerge: mergedPapers.length
            },
            papers: mergedPapers
        };
        if (analysisStatus === 'complete') payload.deepAnalysisCompletedAt = now;
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
}

function finalizeAnalysisResults(filePath, expectedPapers, stats = {}) {
    return saveFinalAnalysisResults(filePath, [], expectedPapers, stats);
}

function persistPipelineStats(filePath, stats) {
    return updateJsonFileLocked(filePath, current => {
        if (!current || Array.isArray(current) || !Array.isArray(current.papers)) {
            throw new Error(`分析结果结构非法，无法写入流水线状态: ${filePath}`);
        }
        return {
            ...current,
            stats: {
                ...(current.stats || {}),
                ...stats
            }
        };
    }, { allowMissing: false });
}

function loadTodayPapersFromDatabase(papersData, today) {
    const papers = [];
    for (const paper of Object.values(papersData?.papers || {})) {
        const recordDate = paper.digestStatus?.batchDate
            || (paper.fetchedAt || '').slice(0, 10)
            || getRecordDate(paper);
        if (recordDate === today) {
            papers.push(paper);
        }
    }
    return papers;
}

function buildSourceHealth(sourceHealth, arxivPapers, hfPapers) {
    const arxivCategories = sourceHealth.arxiv?.categories || [];
    const arxivFailed = arxivCategories.filter(c => c.ok === false).length;
    const arxivSucceeded = arxivCategories.filter(c => c.ok === true).length;
    return {
        ...sourceHealth,
        arxiv: {
            ...(sourceHealth.arxiv || {}),
            totalFetched: arxivPapers.length,
            ok: arxivCategories.length > 0 && arxivFailed === 0 && arxivSucceeded > 0,
            failedCategories: arxivFailed,
            succeededCategories: arxivSucceeded
        },
        huggingface: {
            ...(sourceHealth.huggingface || {}),
            totalFetched: hfPapers.length
        },
        generatedAt: getBeijingISOString()
    };
}

function buildArxivCategoryHealth(category, options = {}) {
    const papers = Array.isArray(options.papers) ? options.papers : [];
    const fetchHealth = options.fetchHealth && typeof options.fetchHealth === 'object'
        ? options.fetchHealth
        : {};
    const error = options.error || null;
    const failed = Boolean(error);
    const numericOrZero = value => Number.isFinite(value) && value >= 0 ? value : 0;
    const health = {
        id: category.id,
        name: category.name,
        priority: category.priority,
        fetched: failed ? 0 : papers.length,
        newInCategory: failed ? 0 : numericOrZero(options.newInCategory),
        duplicateInCategory: failed ? 0 : numericOrZero(options.duplicateInCategory),
        durationMs: numericOrZero(options.durationMs),
        ok: !failed,
        attempts: numericOrZero(fetchHealth.attempts),
        successfulRequests: numericOrZero(fetchHealth.successfulRequests),
        rateLimitWaitMs: numericOrZero(fetchHealth.rateLimitWaitMs),
        totalRetryWaitMs: numericOrZero(fetchHealth.totalRetryWaitMs),
        failures: Array.isArray(fetchHealth.failures) ? fetchHealth.failures : []
    };
    if (failed) {
        health.error = error?.message || String(error);
    } else {
        health.abstractFailures = Array.isArray(fetchHealth.abstracts?.failedIds)
            ? fetchHealth.abstracts.failedIds
            : [];
    }
    return health;
}

function getSourceFetchedCount(sourceHealth, sourceName, fallbackCount = 0) {
    const source = sourceHealth?.[sourceName] || {};
    const value = Number.isFinite(source.totalFetched) ? source.totalFetched : source.fetched;
    return Number.isFinite(value) ? value : fallbackCount;
}

function isReusableArxivCheckpoint(entry) {
    return entry?.status === 'complete'
        && entry.health?.ok === true
        && Array.isArray(entry.papers)
        // arXiv 新批次在各端点可能分阶段上线。空结果只能证明当次请求成功，
        // 不能跨进程永久证明当天没有新论文；续跑时必须重新确认。
        && entry.papers.length > 0;
}

function getSourceFailures(sourceHealth) {
    const failures = [];
    for (const category of sourceHealth?.arxiv?.categories || []) {
        if (category.ok === false) {
            failures.push(`arxiv:${category.id}:${category.error || 'unknown error'}`);
        }
    }
    if (sourceHealth?.huggingface?.ok === false) {
        failures.push(`huggingface:${sourceHealth.huggingface.error || 'unknown error'}`);
    }
    return failures;
}

function hasRequiredSourceFailure(sourceHealth) {
    return !hasCompleteSourceHealth(sourceHealth);
}

function getFatalEmptyCandidateSourceFailures(sourceHealth) {
    const arxivCategories = sourceHealth?.arxiv?.categories || [];
    const arxivAttempted = arxivCategories.length > 0;
    const arxivSucceeded = arxivCategories.some(category => category.ok === true);
    const arxivAllFailed = arxivAttempted && !arxivSucceeded;
    const huggingfaceAttempted = Boolean(sourceHealth?.huggingface);
    const huggingfaceFailed = sourceHealth?.huggingface?.ok === false;

    if (arxivAllFailed) {
        return getSourceFailures({
            arxiv: sourceHealth.arxiv,
            huggingface: huggingfaceAttempted && huggingfaceFailed && !arxivSucceeded ? sourceHealth.huggingface : undefined
        });
    }

    if (!arxivAttempted && huggingfaceAttempted && huggingfaceFailed) {
        return getSourceFailures({ huggingface: sourceHealth.huggingface });
    }

    return [];
}

function writeFilterArtifacts({
    allPapers,
    allPapersFiltered,
    filtered,
    filterDecisions,
    filterModel,
    filterPromptHash,
    stats,
    complete,
    sourceHealth = null,
    retryableDecisions = {}
}) {
    const timestamp = stats.batchStartedAt || getBeijingISOString();
    const coverage = validateFilterDecisionCoverage(allPapersFiltered, filterDecisions);
    const keywordRejected = Object.values(filterDecisions || {})
        .filter(decision => decision?.parseSource === 'keyword_prefilter').length;
    const keywordStats = {
        keywordPrefilterEnabled: Config.FILTER_CONFIG.keywordPrefilterEnabled,
        keywordPrefilterVersion: KEYWORD_PREFILTER_VERSION,
        keywordRejected,
        llmCandidates: Math.max(0, coverage.totalCandidates - keywordRejected),
        llmDecided: Math.max(0, coverage.decided - keywordRejected)
    };
    if (complete && !coverage.complete) {
        throw new Error(`筛选决策覆盖不完整，禁止标记 complete：明确决定 ${coverage.decided}/${coverage.totalCandidates}，待重试/缺失 ${coverage.missingIds.join(', ') || '无'}`);
    }
    const sourceFailure = sourceHealth && hasRequiredSourceFailure(sourceHealth);
    const artifactComplete = complete && coverage.complete && !sourceFailure;
    writeFileAtomic(FILTER_DECISIONS_FILE, JSON.stringify({
        timestamp,
        filterModel,
        filterPromptHash,
        filterConfigFingerprint: stats.filterConfigFingerprint,
        candidateFingerprint: stats.candidateFingerprint,
        sourceConfigFingerprint: stats.sourceConfigFingerprint,
        blogDedupFingerprint: stats.blogDedupFingerprint,
        batchDate: stats.batchDate,
        batchId: stats.batchId,
        rawPapersSha256: stats.rawPapersSha256,
        fetchSourcesSha256: stats.fetchSourcesSha256,
        stats: {
            totalCandidates: coverage.totalCandidates,
            decided: coverage.decided,
            related: filtered.length,
            retryable: Object.keys(retryableDecisions).length,
            complete: artifactComplete,
            ...keywordStats
        },
        decisions: filterDecisions,
        retryableDecisions
    }, null, 2));

    writeFileAtomic(FILTERED_FILE, JSON.stringify({
        timestamp,
        // 这是筛选过程中的 checkpoint，不是可供深度分析复用的最终批次。
        // 只有后续归档去重完成后，才会由主流程写入 status=complete。
        status: sourceFailure ? 'source_partial_failed' : 'filtering',
        filterModel,
        filterPromptHash,
        filterConfigFingerprint: stats.filterConfigFingerprint,
        candidateFingerprint: stats.candidateFingerprint,
        sourceConfigFingerprint: stats.sourceConfigFingerprint,
        blogDedupFingerprint: stats.blogDedupFingerprint,
        batchDate: stats.batchDate,
        batchId: stats.batchId,
        rawPapersSha256: stats.rawPapersSha256,
        fetchSourcesSha256: stats.fetchSourcesSha256,
        stats: {
            ...stats,
            ...keywordStats,
            afterFilter: filtered.length,
            decisionCount: Object.keys(filterDecisions).length
        },
        sourceHealth,
        papers: filtered
    }, null, 2));
}

async function resumeFilterStage({
    allPapers,
    allPapersFiltered,
    sourceHealth,
    baseFilterStats,
    initialDecisions,
    filterModel,
    filterPromptHash,
    today
}) {
    let filterDecisions = initialDecisions;
    let retryableFilterDecisions = {};
    const filtered = await filterPapersWithLLM(allPapersFiltered, {
        batchSize: Config.FILTER_CONFIG.batchSize,
        delayBetweenBatches: Config.FILTER_CONFIG.delayBetweenBatchesMs,
        useKeywordPreFilter: Config.FILTER_CONFIG.keywordPrefilterEnabled,
        initialDecisions: filterDecisions,
        decisionMetadata: { filterModel, filterPromptHash },
        onBatchComplete: async ({ results, decisions, retryableDecisions }) => {
            filterDecisions = decisions;
            retryableFilterDecisions = retryableDecisions;
            writeFilterArtifacts({
                allPapers,
                allPapersFiltered,
                filtered: results,
                filterDecisions,
                filterModel,
                filterPromptHash,
                stats: baseFilterStats,
                complete: false,
                sourceHealth,
                retryableDecisions
            });
            console.log(`  💾 筛选续跑进度已保存: ${Object.keys(filterDecisions).length}/${allPapersFiltered.length} 篇明确判断，${Object.keys(retryableDecisions).length} 篇待重试`);
        }
    });

    const filterRunStats = filtered._filterStats || validateFilterDecisionCoverage(allPapersFiltered, filterDecisions);
    if (!filterRunStats.complete) {
        writeFilterArtifacts({
            allPapers,
            allPapersFiltered,
            filtered,
            filterDecisions,
            filterModel,
            filterPromptHash,
            stats: baseFilterStats,
            complete: false,
            sourceHealth,
            retryableDecisions: retryableFilterDecisions
        });
        throw new Error(`筛选续跑未完成：明确决定 ${filterRunStats.decided}/${filterRunStats.totalCandidates}，待重试 ${filterRunStats.retryable || filterRunStats.retryableIds?.length || 0}`);
    }
    if (hasRequiredSourceFailure(sourceHealth)) {
        throw new Error(`缓存候选的抓取来源不完整，禁止进入分析: ${getSourceFailures(sourceHealth).join('; ')}`);
    }

    const archiveAnalyzedIds = loadAnalyzedIdsFromArchive();
    const filteredNew = filtered.filter(paper => {
        const nid = normalizedId(paper);
        return !(archiveAnalyzedIds.has(nid) && paper.sources?.includes('huggingface'));
    });
    const skippedCount = filtered.length - filteredNew.length;
    writeFilterArtifacts({
        allPapers,
        allPapersFiltered,
        filtered,
        filterDecisions,
        filterModel,
        filterPromptHash,
        filterConfigFingerprint: baseFilterStats.filterConfigFingerprint,
        stats: baseFilterStats,
        complete: true,
        sourceHealth,
        retryableDecisions: {}
    });
    writeFileAtomic(FILTERED_FILE, JSON.stringify({
        timestamp: baseFilterStats.batchStartedAt || getBeijingISOString(),
        batchDate: baseFilterStats.batchDate,
        batchId: baseFilterStats.batchId,
        rawPapersSha256: baseFilterStats.rawPapersSha256,
        fetchSourcesSha256: baseFilterStats.fetchSourcesSha256,
        status: 'complete',
        filterModel,
        filterPromptHash,
        filterConfigFingerprint: baseFilterStats.filterConfigFingerprint,
        candidateFingerprint: baseFilterStats.candidateFingerprint,
        sourceConfigFingerprint: baseFilterStats.sourceConfigFingerprint,
        blogDedupFingerprint: baseFilterStats.blogDedupFingerprint,
        stats: {
            ...baseFilterStats,
            keywordPrefilterEnabled: Config.FILTER_CONFIG.keywordPrefilterEnabled,
            keywordPrefilterVersion: KEYWORD_PREFILTER_VERSION,
            keywordRejected: Object.values(filterDecisions).filter(decision => decision?.parseSource === 'keyword_prefilter').length,
            llmCandidates: allPapersFiltered.length - Object.values(filterDecisions).filter(decision => decision?.parseSource === 'keyword_prefilter').length,
            llmDecided: Object.values(filterDecisions).filter(decision => decision?.parseSource !== 'keyword_prefilter').length,
            afterBlogSkip: allPapersFiltered.length,
            afterFilter: filtered.length,
            afterArchiveSkip: filteredNew.length,
            skippedFromArchive: skippedCount,
            decisionCount: Object.keys(filterDecisions).length
        },
        sourceHealth,
        excludedRelatedIds: filtered.filter(paper => !filteredNew.some(item => normalizedId(item) === normalizedId(paper))).map(normalizedId),
        papers: filteredNew
    }, null, 2));
    return { filtered, filteredNew, filterDecisions, skippedCount };
}

function nextArchiveConflictPath(archiveDayDir, basename) {
    const stem = path.basename(basename, '.json');
    const timestamp = getBeijingCompactTimestamp();
    let suffix = 0;
    while (true) {
        const candidate = path.join(
            archiveDayDir,
            `${stem}-conflict-${timestamp}${suffix > 0 ? `-${suffix}` : ''}.json`
        );
        if (!fs.existsSync(candidate)) return candidate;
        suffix++;
    }
}

function autoArchiveCurrentData(batchDate = getBeijingDateString(), options = {}) {
    const today = batchDate;
    const archiveDir = options.archiveDir || ARCHIVE_DIR;
    // Resolve the default set at call time. Besides keeping all fetch/filter
    // companion snapshots together, this lets callers that temporarily bind
    // Config.FILES to another current directory exercise the real default
    // archive path without falling back to module-load-time constants.
    const targets = options.targets || [
        Config.FILES.deepAnalysisResult,
        Config.FILES.filteredPapers,
        Config.FILES.analyzed,
        Config.FILES.rawCandidates,
        Config.FILES.filterDecisions
    ];
    let archived = 0;
    let removed = 0;

    for (const filePath of targets) {
        withFileLockSync(filePath, () => {
            if (!fs.existsSync(filePath)) return;
            const data = readJsonSafe(filePath);
            const recordDate = getRecordDate(data);

            if (!recordDate) {
                console.log(`  [归档] 跳过 ${path.basename(filePath)}（缺少可识别日期字段）`);
                return;
            }
            if (recordDate >= today) return;

            const archiveDayDir = path.join(archiveDir, recordDate);
            const archivePath = path.join(archiveDayDir, path.basename(filePath));
            if (fs.existsSync(archivePath)) {
                try {
                    const currentContent = fs.readFileSync(filePath, 'utf8');
                    const archivedContent = fs.readFileSync(archivePath, 'utf8');
                    if (currentContent === archivedContent) {
                        console.log(`  [归档] 已存在且内容一致，跳过 ${recordDate}/${path.basename(filePath)}`);
                    } else {
                        const backupPath = nextArchiveConflictPath(archiveDayDir, path.basename(filePath));
                        fs.copyFileSync(archivePath, backupPath);
                        writeFileAtomic(archivePath, currentContent);
                        if (fs.readFileSync(archivePath, 'utf8') !== currentContent) {
                            throw new Error('替换 canonical 归档后的内容校验失败');
                        }
                        archived++;
                        console.log(`  [归档] current 已成为 canonical，旧归档另存为 ${path.basename(backupPath)}`);
                    }
                } catch (e) {
                    console.log(`  [归档] 校验已有归档失败 ${path.basename(filePath)}: ${e.message}`);
                    return;
                }
            } else {
                try {
                    fs.mkdirSync(archiveDayDir, { recursive: true });
                    fs.copyFileSync(filePath, archivePath);
                    archived++;
                    console.log(`  [归档] ${path.basename(filePath)} -> ${recordDate}/${path.basename(filePath)}`);
                } catch (e) {
                    console.log(`  [归档] 复制失败 ${path.basename(filePath)}: ${e.message}`);
                    return;
                }
            }

            try {
                fs.unlinkSync(filePath);
                removed++;
                console.log(`  [移走] 已清空 ${path.basename(filePath)}`);
            } catch (e) {
                console.log(`  [移走] 删除失败 ${path.basename(filePath)}: ${e.message}`);
            }
        });
    }

    if (archived > 0 || removed > 0) {
        console.log(`📦 自动归档完成：${archived} 个文件备份，${removed} 个文件移走`);
    } else {
        console.log('📦 自动归档：无需归档');
    }
}

/**
 * 一次性把旧版 data/deep-analysis-result.json 迁移到 current 权威路径。
 * 仅在 current 不存在时迁移；写入成功且可重新读取后才删除 legacy。
 */
function inferLegacyAnalysisArrayBatchDate(papers) {
    if (!Array.isArray(papers) || papers.length === 0) {
        throw new Error('legacy 顶层数组为空，无法可靠推断批次日期');
    }
    const inferredDates = [];
    for (const paper of papers) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            throw new Error('legacy 顶层数组包含非法论文条目，无法可靠推断批次日期');
        }
        const explicitBatchDate = String(paper.digestStatus?.batchDate || paper.batchDate || '');
        const dateMatch = explicitBatchDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const explicitDate = dateMatch
            ? new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])))
            : null;
        let inferredDate = explicitDate
            && explicitDate.getUTCFullYear() === Number(dateMatch[1])
            && explicitDate.getUTCMonth() === Number(dateMatch[2]) - 1
            && explicitDate.getUTCDate() === Number(dateMatch[3])
            ? explicitBatchDate
            : '';
        if (!inferredDate) {
            const timestamp = paper.fetchedAt
                || paper.timestamp
                || paper.lastUpdated
                || paper.deepAnalysisCompletedAt;
            const normalizedTimestamp = normalizeToBeijingISOString(timestamp);
            inferredDate = String(normalizedTimestamp || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || '';
        }
        if (!inferredDate) {
            throw new Error(`legacy 论文 ${normalizedId(paper) || '(缺少 ID)'} 缺少可验证的批次日期`);
        }
        inferredDates.push(inferredDate);
    }
    const uniqueDates = [...new Set(inferredDates)];
    if (uniqueDates.length !== 1) {
        throw new Error(`legacy 顶层数组包含多个批次日期，拒绝迁移: ${uniqueDates.join(', ')}`);
    }
    return uniqueDates[0];
}

function withOrderedFileLocksSync(filePaths, callback) {
    const ordered = [...new Set(filePaths.map(filePath => path.resolve(filePath)))].sort();
    const acquire = index => {
        if (index >= ordered.length) return callback();
        return withFileLockSync(ordered[index], () => acquire(index + 1));
    };
    return acquire(0);
}

function migrateLegacyAnalysisResultToCurrent(
    currentFile = RESULT_FILE,
    legacyFile = LEGACY_RESULT_FILE
) {
    if (fs.existsSync(currentFile) || !fs.existsSync(legacyFile)) return false;
    return withOrderedFileLocksSync([currentFile, legacyFile], () => {
        if (fs.existsSync(currentFile) || !fs.existsSync(legacyFile)) return false;
        const legacy = readJsonFileStrict(legacyFile);
        let payload = legacy;
        if (Array.isArray(legacy)) {
            const batchDate = inferLegacyAnalysisArrayBatchDate(legacy);
            payload = {
                timestamp: `${batchDate}T00:00:00+08:00`,
                batchDate,
                source: legacyFile,
                papers: legacy
            };
        }
        if (!payload || !Array.isArray(payload.papers)) {
            throw new Error(`legacy 分析结果 schema 非法，拒绝迁移: ${legacyFile}`);
        }
        writeFileAtomic(currentFile, JSON.stringify(payload, null, 2));
        const verified = readJsonFileStrict(currentFile);
        if (!verified || !Array.isArray(verified.papers)) {
            throw new Error(`legacy 分析结果迁移后校验失败: ${currentFile}`);
        }
        fs.unlinkSync(legacyFile);
        console.log(`📦 已将 legacy 分析结果迁移到权威路径并移除旧文件: ${currentFile}`);
        return true;
    });
}

/**
 * 清理非今日数据（归档后残留的旧数据）
 * 归档函数只在文件日期早于今天时触发，但文件可能在当天被修改导致未归档
 */
function cleanOldData(filePath, name, today, options = {}) {
    return withFileLockSync(filePath, () => {
        if (!fs.existsSync(filePath)) return;
        const data = readJsonSafe(filePath);
        if (!data || !data.papers || !Array.isArray(data.papers)) return;

        const before = data.papers.length;
        data.papers = data.papers.filter(p => {
            const date = String(
                p.digestStatus?.batchDate || p.batchDate || p.fetchBatchDate
                || p.fetchedAt || p.timestamp || ''
            ).substring(0, 10);
            // 无日期字段的论文可能是从旧格式迁移的，保留它们
            return !date || date === today;
        });
        const removed = before - data.papers.length;

        if (removed > 0) {
            try {
                const cleanupDir = path.join(options.archiveDir || ARCHIVE_DIR, 'cleanup');
                fs.mkdirSync(cleanupDir, { recursive: true });
                const backupPath = path.join(cleanupDir, `${name}-${getBeijingCompactTimestamp()}.json`);
                fs.copyFileSync(filePath, backupPath);
                console.log(`  [清理] ${name}: 清理前已备份到 ${backupPath}`);
            } catch (e) {
                console.log(`  [清理] ${name}: 清理前备份失败，跳过清理（${e.message}）`);
                return;
            }
            const now = getBeijingISOString();
            data.timestamp = now;
            data.batchDate = today;
            data.stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
            if (name === 'deep-analysis-result') {
                const summary = getCanonicalAnalysisRunSummary(data.papers);
                data.status = summary.status;
                data.stats.analysisStatus = summary.status;
                data.stats.remainingFailed = summary.remaining;
                data.stats.successfulExpected = summary.success;
                data.stats.expected = data.papers.length;
                data.stats.totalAfterMerge = data.papers.length;
                if (summary.status === 'complete') data.deepAnalysisCompletedAt = now;
                else delete data.deepAnalysisCompletedAt;
            } else if (name === 'filtered-papers') {
                data.stats.afterArchiveSkip = data.papers.length;
            }
            writeFileAtomic(filePath, JSON.stringify(data, null, 2));
            console.log(`  [清理] ${name}: 移除 ${removed} 篇旧数据，保留 ${data.papers.length} 篇今日数据`);
        } else {
            console.log(`  [清理] ${name}: 无需清理（${data.papers.length} 篇均为今日数据）`);
        }
    });
}

/**
 * 从归档目录加载已分析论文的规范化ID集合
 * 用于跳过之前已经成功分析过的论文（避免HF论文在7天窗口内重复出现）
 */
function loadAnalyzedIdsFromArchive() {
    const analyzedIds = new Set();
    if (!fs.existsSync(ARCHIVE_DIR)) return analyzedIds;

    const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // 只读取日期格式的目录 (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

        const archiveFile = path.join(ARCHIVE_DIR, entry.name, 'deep-analysis-result.json');
        if (!fs.existsSync(archiveFile)) continue;

        try {
            const data = readJsonSafe(archiveFile);
            if (data.papers && Array.isArray(data.papers)) {
                for (const paper of data.papers) {
                    // 只跳过通过当前完整分析契约的论文
                    if (isSuccessfulAnalysisRecord(paper)) {
                        const nid = normalizedId(paper);
                        if (nid) analyzedIds.add(nid);
                    }
                }
            }
        } catch (e) {
            // 忽略损坏的归档文件
        }
    }
    return analyzedIds;
}

async function runFullFetch() {
    let batchStartedAt = getBeijingISOString();
    let batchDate = batchStartedAt.slice(0, 10);
    let batchId = stableHash({ batchStartedAt, pid: process.pid, nonce: crypto.randomBytes(8).toString('hex') });
    console.log('=== 论文抓取 + 深度分析（arxiv + HuggingFace Papers）===');
    console.log('');
    migrateLegacyAnalysisResultToCurrent();
    autoArchiveCurrentData(batchDate);
    console.log('');

    // 清理非今日数据（归档后残留的旧数据）
    const today = batchDate;
    cleanOldData(RESULT_FILE, 'deep-analysis-result', today);
    cleanOldData(FILTERED_FILE, 'filtered-papers', today);
    console.log('');

    // papers.json 自动备份（去重数据库，不归档但需备份防损坏）
    const backupResult = backupPapersJson(PAPERS_FILE, ARCHIVE_DIR);
    console.log(`📦 ${backupResult.message}`);
    console.log('');

    const categories = Config.ARXIV_CATEGORIES;

    const papersData = loadPapersDatabase();
    // 加载博客已发布论文 ID，加入不可变的当日历史去重基线。
    const blogRepo = Config.PUBLISH_CONFIG.blogRepo;
    const publishedIds = loadPublishedIdsFromBlog(blogRepo);
    const historicalDedupIds = buildHistoricalDedupBaseline(papersData, today, publishedIds);
    const existingIds = new Set(historicalDedupIds);
    const historicalExistingIds = new Set(historicalDedupIds);
    console.log(`历史去重基线 ${existingIds.size} 篇（排除今日批次状态，保证同日续跑候选不缩水）\n`);
    const candidateFingerprints = buildCandidateFingerprints(historicalExistingIds, publishedIds);

    let arxivPapers = [];
    const arxivById = new Map();
    let hfPapers = [];
    let allPapers = [];
    let allPapersFiltered = [];
    let filtered = [];
    let filteredNew = [];
    let arxivOnly = 0;
    let hfOnly = 0;
    let both = 0;
    let blogSkippedCount = 0;
    let skippedCount = 0;
    let sourceHealth = {
        arxiv: { categories: [] },
        huggingface: {}
    };
    let baseFilterStats = {};
    let filterDecisions = {};
    const filterModel = process.env.PAPER_ANALYZER_MODEL || '';
    const filterPromptHash = getFilterPromptHash();
    const filterConfigFingerprint = getFilterConfigFingerprint(filterPromptHash);

    const completedFiltered = loadCompleteFilteredForToday(today, FILTERED_FILE, {
        filterModel,
        filterPromptHash,
        filterConfigFingerprint,
        ...candidateFingerprints,
        requireConsistentFilterArtifacts: true
    });
    const resumableFilter = completedFiltered ? null : loadResumableFilterForToday(today, {
        filterModel,
        filterPromptHash,
        filterConfigFingerprint,
        ...candidateFingerprints
    });
    if (completedFiltered) {
        console.log('⏭️ 检测到今日完整 filtered-papers.json，跳过抓取与筛选，直接续跑深度分析');
        filteredNew = completedFiltered.papers;
        filtered = completedFiltered.papers;
        const rawCandidates = loadTodayJsonFile(RAW_CANDIDATES_FILE, today);
        batchStartedAt = rawCandidates?.timestamp || completedFiltered.timestamp || batchStartedAt;
        batchDate = rawCandidates?.batchDate || completedFiltered.batchDate || today;
        batchId = rawCandidates?.batchId || completedFiltered.batchId || batchId;
        const databaseTodayPapers = loadTodayPapersFromDatabase(papersData, today);
        allPapers = Array.isArray(rawCandidates?.papers)
            ? rawCandidates.papers
            : (databaseTodayPapers.length >= filteredNew.length ? databaseTodayPapers : filteredNew);
        allPapersFiltered = allPapers.filter(paper => !publishedIds.has(normalizedId(paper)));
        const existingDecisions = loadReusableFilterDecisions(today, filterModel, filterPromptHash, {
            ...candidateFingerprints, filterConfigFingerprint
        });
        filterDecisions = existingDecisions;
        const stats = completedFiltered.stats || rawCandidates?.stats || {};
        arxivOnly = stats.arxivOnly || allPapers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length;
        hfOnly = stats.hfOnly || allPapers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        both = stats.both || allPapers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        blogSkippedCount = stats.skippedFromBlog || 0;
        skippedCount = stats.skippedFromArchive || 0;
        baseFilterStats = {
            ...candidateFingerprints,
            filterConfigFingerprint,
            beforeFilter: stats.beforeFilter || allPapers.length,
            beforeBlogSkip: stats.beforeBlogSkip || allPapers.length,
            afterBlogSkip: stats.afterBlogSkip || allPapersFiltered.length,
            skippedFromBlog: blogSkippedCount,
            arxivOnly,
            hfOnly,
            both,
            batchStartedAt, batchDate, batchId,
            rawPapersSha256: rawCandidates?.rawPapersSha256,
            fetchSourcesSha256: rawCandidates?.fetchSourcesSha256
        };
        sourceHealth = rawCandidates?.sourceHealth || completedFiltered.sourceHealth || sourceHealth;
    } else if (resumableFilter) {
        console.log(`⏭️ 检测到今日来源健康的筛选 checkpoint，跳过抓取，仅续跑 ${resumableFilter.coverage.missingIds.length} 篇未决论文`);
        const rawCandidates = resumableFilter.rawCandidates;
        batchStartedAt = rawCandidates.timestamp || batchStartedAt;
        batchDate = rawCandidates.batchDate || today;
        batchId = rawCandidates.batchId || batchId;
        allPapers = rawCandidates.papers;
        allPapersFiltered = rawCandidates.papers;
        sourceHealth = rawCandidates.sourceHealth;
        const stats = rawCandidates.stats || {};
        arxivOnly = stats.arxivOnly || allPapers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length;
        hfOnly = stats.hfOnly || allPapers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        both = stats.both || allPapers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        blogSkippedCount = stats.skippedFromBlog || 0;
        baseFilterStats = {
            ...candidateFingerprints,
            filterConfigFingerprint,
            beforeFilter: stats.beforeFilter || allPapers.length,
            beforeBlogSkip: stats.beforeBlogSkip || allPapers.length,
            afterBlogSkip: allPapersFiltered.length,
            skippedFromBlog: blogSkippedCount,
            arxivOnly,
            hfOnly,
            both,
            batchStartedAt, batchDate, batchId,
            rawPapersSha256: rawCandidates.rawPapersSha256,
            fetchSourcesSha256: rawCandidates.fetchSourcesSha256
        };
        const resumed = await resumeFilterStage({
            allPapers,
            allPapersFiltered,
            sourceHealth,
            baseFilterStats,
            initialDecisions: resumableFilter.decisionsData.decisions,
            filterModel,
            filterPromptHash,
            today
        });
        filtered = resumed.filtered;
        filteredNew = resumed.filteredNew;
        filterDecisions = resumed.filterDecisions;
        skippedCount = resumed.skippedCount;
        console.log(`💾 筛选续跑完成，结果已保存到: ${FILTERED_FILE}`);
    } else {
        // 核心类别优先，补充类别只在首次创建 checkpoint 时随机一次；续跑严格复用该顺序。
        const coreCategories = categories.filter(c => c.priority === 'core');
        const supplementCategories = categories.filter(c => c.priority !== 'core');
        for (let i = supplementCategories.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [supplementCategories[i], supplementCategories[j]] = [supplementCategories[j], supplementCategories[i]];
        }
        const initialCategoryOrder = [...coreCategories, ...supplementCategories].map(category => category.id);
        let fetchCheckpoint = loadFetchCheckpoint(today, candidateFingerprints.candidateFingerprint) || {
            timestamp: batchStartedAt,
            batchStartedAt,
            batchDate,
            batchId,
            ...candidateFingerprints,
            historicalDedupIds,
            categoryOrder: initialCategoryOrder,
            arxiv: {},
            huggingface: null
        };
        batchStartedAt = fetchCheckpoint.batchStartedAt || fetchCheckpoint.timestamp || batchStartedAt;
        batchDate = fetchCheckpoint.batchDate || today;
        batchId = fetchCheckpoint.batchId || batchId;
        if (stableHash(fetchCheckpoint.historicalDedupIds) !== stableHash(historicalDedupIds)) {
            throw new Error('抓取 checkpoint 的历史去重基线与当前候选指纹不一致，拒绝混用');
        }
        saveFetchCheckpoint(fetchCheckpoint);
        // ========== 第一步：从 arxiv 抓取 ==========
        console.log('📥 第一步：从 arxiv 抓取论文');

        const categoryById = new Map(categories.map(category => [category.id, category]));
        const shuffledCategories = fetchCheckpoint.categoryOrder.map(id => categoryById.get(id));
        if (shuffledCategories.some(category => !category)
                || fetchCheckpoint.categoryOrder.length !== categories.length
                || new Set(fetchCheckpoint.categoryOrder).size !== categories.length) {
            throw new Error('抓取 checkpoint 的 categoryOrder 与当前来源配置不一致');
        }
        console.log(`  请求顺序: ${shuffledCategories.map(c => c.id).join(' → ')}\n`);

        let fetchAttemptIndex = 0;
        for (let i = 0; i < shuffledCategories.length; i++) {
            const category = shuffledCategories[i];
            const cachedCategory = fetchCheckpoint.arxiv[category.id];
            if (isReusableArxivCheckpoint(cachedCategory)) {
                console.log(`  [${i+1}/${shuffledCategories.length}] 复用抓取 checkpoint: ${category.name} (${category.id}) ${cachedCategory.papers.length} 篇`);
                sourceHealth.arxiv.categories.push(cachedCategory.health);
                for (const p of cachedCategory.papers) {
                    p.fetchedAt = batchStartedAt;
                    const id = normalizedId(p);
                    if (id && !existingIds.has(id)) {
                        existingIds.add(id);
                        arxivPapers.push(p);
                        arxivById.set(id, p);
                    } else if (id && arxivById.has(id)) {
                        mergePaperCategories(arxivById.get(id), p);
                    }
                }
                continue;
            }
            // 首次请求前加随机延迟
            if (fetchAttemptIndex === 0) {
                const baseDelay = Config.ARXIV_CONFIG.firstRequestDelayMs;
                const jitter = Math.floor(Math.random() * 10000);
                const firstDelay = baseDelay + jitter;
                console.log(`  首次请求前等待 ${(firstDelay/1000).toFixed(1)} 秒...`);
                await new Promise(resolve => setTimeout(resolve, firstDelay));
            }
            fetchAttemptIndex++;
            console.log(`  [${i+1}/${shuffledCategories.length}] 抓取 ${category.name} (${category.id})...`);
            const fetchStartTime = Date.now();
            let papers = [];
            let fetchError = null;
            let categoryFetchHealth = null;
            try {
                papers = await fetchCategoryPapers(
                    category.id,
                    Config.ARXIV_CONFIG.maxResultsPerCategory,
                    Config.ARXIV_CONFIG.fetchMaxRetries,
                    // 同批次跨类别重复项必须返回到本层合并 categories；这里只排除历史基线。
                    historicalExistingIds
                );
                pinPapersToBatch(papers, batchStartedAt);
                categoryFetchHealth = papers._sourceHealth || null;
            } catch (e) {
                fetchError = e;
                categoryFetchHealth = e.sourceHealth || null;
                console.log(`    ⚠️ ${category.id} 抓取失败: ${e.message}`);
            }
            const fetchDuration = Date.now() - fetchStartTime;
            if (fetchError) {
                const categoryHealth = buildArxivCategoryHealth(category, {
                    fetchHealth: categoryFetchHealth,
                    durationMs: fetchDuration,
                    error: fetchError
                });
                sourceHealth.arxiv.categories.push(categoryHealth);
                fetchCheckpoint.arxiv[category.id] = { status: 'failed', papers: [], health: categoryHealth };
                saveFetchCheckpoint(fetchCheckpoint);
            }

            // 去重：将新论文 ID 加入 existingIds，避免下一类别重复抓取
            let newInCategory = 0, dupInCategory = 0;
            for (const p of papers) {
                const id = normalizedId(p.paper_id || p.arxivId);
                if (existingIds.has(id)) {
                    dupInCategory++;
                    if (arxivById.has(id)) mergePaperCategories(arxivById.get(id), p);
                } else {
                    existingIds.add(id);
                    arxivPapers.push(p);
                    arxivById.set(id, p);
                    newInCategory++;
                }
            }
            if (!fetchError) {
                const categoryHealth = buildArxivCategoryHealth(category, {
                    papers,
                    fetchHealth: categoryFetchHealth,
                    durationMs: fetchDuration,
                    newInCategory,
                    duplicateInCategory: dupInCategory
                });
                sourceHealth.arxiv.categories.push(categoryHealth);
                fetchCheckpoint.arxiv[category.id] = { status: 'complete', papers, health: categoryHealth };
                saveFetchCheckpoint(fetchCheckpoint);
            }
            console.log(`    ${category.id}: 获取 ${papers.length} 篇, 新增 ${newInCategory} 篇, 跨类别去重 ${dupInCategory} 篇`);

            // 核心类别检查：无新论文时继续运行（可能是已知论文太多）
            if (!fetchError && category.priority === 'core' && papers.length === 0) {
                console.log(`\nℹ️ 核心类别 ${category.id}（${category.name}）无新论文（可能均已被收录）`);
                console.log(`   继续运行，尝试其他来源...`);
            }

            // 类别间延迟：基础延迟 + 随机抖动 + 限流检测补偿
            const baseJitter = Math.floor(Math.random() * 20000) + 10000; // 10-30秒随机
            const rateLimitPenalty = fetchDuration > 300000 ? 120000 : (fetchDuration > 120000 ? 60000 : (fetchDuration > 60000 ? 30000 : 0));
            const totalDelay = FETCH_DELAY_MS + baseJitter + rateLimitPenalty;
            if (rateLimitPenalty > 0) {
                console.log(`    检测到可能的限流，额外等待 ${(rateLimitPenalty/1000).toFixed(0)} 秒...`);
            }
            console.log(`    等待 ${(totalDelay/1000).toFixed(0)} 秒后继续下一类别...`);
            await new Promise(resolve => setTimeout(resolve, totalDelay));
        }

        console.log(`\narxiv 抓取完成: ${arxivPapers.length} 篇`);

        // ========== 第二步：从 HuggingFace Papers 抓取 ==========
        console.log('\n📥 第二步：从 HuggingFace Papers 抓取论文');

        const hfStartTime = Date.now();
        const cachedHf = fetchCheckpoint.huggingface;
        if (cachedHf?.status === 'complete' && cachedHf.health?.ok === true && Array.isArray(cachedHf.papers)) {
            hfPapers = cachedHf.papers;
            sourceHealth.huggingface = cachedHf.health;
            console.log(`  复用 HuggingFace 抓取 checkpoint: ${hfPapers.length} 篇`);
        } else try {
            hfPapers = await fetchHuggingFacePapers(historicalExistingIds, {
                days: Config.HUGGINGFACE_CONFIG.defaultDays,
                minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
                fetchedAt: batchStartedAt
            });
            pinPapersToBatch(hfPapers, batchStartedAt);
            sourceHealth.huggingface = {
                ...(hfPapers._sourceHealth || {}),
                ok: true,
                fetched: hfPapers.length,
                days: Config.HUGGINGFACE_CONFIG.defaultDays,
                minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
                durationMs: Date.now() - hfStartTime
            };
            fetchCheckpoint.huggingface = { status: 'complete', papers: hfPapers, health: sourceHealth.huggingface };
            saveFetchCheckpoint(fetchCheckpoint);
        } catch (e) {
            hfPapers = [];
            sourceHealth.huggingface = {
                ...(e.sourceHealth || {}),
                ok: false,
                fetched: 0,
                days: Config.HUGGINGFACE_CONFIG.defaultDays,
                minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
                durationMs: Date.now() - hfStartTime,
                error: e.message
            };
            fetchCheckpoint.huggingface = { status: 'failed', papers: [], health: sourceHealth.huggingface };
            saveFetchCheckpoint(fetchCheckpoint);
            console.log(`  ⚠️ HuggingFace Papers 抓取失败: ${e.message}`);
        }

        console.log(`\nHuggingFace Papers 抓取完成: ${hfPapers.length} 篇`);

        // ========== 第三步：合并去重 ==========
        console.log('\n🔄 第三步：合并去重（arxiv + HuggingFace）');
        allPapers = mergeAndDeduplicate(arxivPapers, hfPapers);
        pinPapersToBatch(allPapers, batchStartedAt);
        console.log(`合并后: ${allPapers.length} 篇`);
        sourceHealth = buildSourceHealth(sourceHealth, arxivPapers, hfPapers);
        const fatalSourceFailures = getFatalEmptyCandidateSourceFailures(sourceHealth);
        if (allPapers.length === 0 && fatalSourceFailures.length > 0) {
            throw new Error(`核心抓取来源无可用候选，且存在致命来源失败: ${fatalSourceFailures.join('; ')}`);
        }

        arxivOnly = allPapers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length;
        hfOnly = allPapers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        both = allPapers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        console.log(`  - 仅 arxiv: ${arxivOnly} 篇`);
        console.log(`  - 仅 HuggingFace: ${hfOnly} 篇`);
        console.log(`  - 两个来源都有: ${both} 篇`);

        // 过滤掉已发布到博客的论文
        const beforeBlogSkip = allPapers.length;
        allPapersFiltered = allPapers.filter(paper => !publishedIds.has(normalizedId(paper)));
        blogSkippedCount = beforeBlogSkip - allPapersFiltered.length;
        if (blogSkippedCount > 0) {
            console.log(`📝 过滤 ${blogSkippedCount} 篇已发布到博客的论文`);
        }

        const rawPapersSha256 = stableContentSha256(allPapersFiltered);
        writeFileAtomic(RAW_CANDIDATES_FILE, JSON.stringify({
            timestamp: batchStartedAt,
            batchDate,
            batchId,
            rawPapersSha256,
            fetchSourcesSha256: fetchCheckpoint.fetchSourcesSha256,
            ...candidateFingerprints,
            stats: {
                beforeBlogSkip: allPapers.length,
                afterBlogSkip: allPapersFiltered.length,
                skippedFromBlog: blogSkippedCount,
                arxivOnly,
                hfOnly,
                both
            },
            sourceHealth,
            papers: allPapersFiltered
        }, null, 2));
        console.log(`💾 原始候选论文已保存到: ${RAW_CANDIDATES_FILE}`);

        // ========== 第四步：大模型筛选 ==========
        console.log('\n🤖 第四步：大模型筛选（判断是否语音/音频相关）');
        filterDecisions = loadReusableFilterDecisions(today, filterModel, filterPromptHash, {
            ...candidateFingerprints, filterConfigFingerprint
        });
        baseFilterStats = {
            ...candidateFingerprints,
            filterConfigFingerprint,
            beforeFilter: allPapers.length,
            beforeBlogSkip: allPapers.length,
            afterBlogSkip: allPapersFiltered.length,
            skippedFromBlog: blogSkippedCount,
            arxivOnly,
            hfOnly,
            both,
            batchStartedAt, batchDate, batchId, rawPapersSha256,
            fetchSourcesSha256: fetchCheckpoint.fetchSourcesSha256
        };
        let retryableFilterDecisions = {};
        filtered = await filterPapersWithLLM(allPapersFiltered, {
            batchSize: Config.FILTER_CONFIG.batchSize,
            delayBetweenBatches: Config.FILTER_CONFIG.delayBetweenBatchesMs,
            useKeywordPreFilter: Config.FILTER_CONFIG.keywordPrefilterEnabled,
            initialDecisions: filterDecisions,
            decisionMetadata: {
                filterModel,
                filterPromptHash
            },
            onBatchComplete: async ({ results, decisions, retryableDecisions }) => {
                filterDecisions = decisions;
                retryableFilterDecisions = retryableDecisions;
                writeFilterArtifacts({
                    allPapers,
                    allPapersFiltered,
                    filtered: results,
                    filterDecisions,
                    filterModel,
                    filterPromptHash,
                    stats: baseFilterStats,
                    complete: false,
                    sourceHealth,
                    retryableDecisions
                });
                console.log(`  💾 筛选进度已保存: ${Object.keys(filterDecisions).length}/${allPapersFiltered.length} 篇明确判断，${Object.keys(retryableDecisions).length} 篇待重试`);
            }
        });
        const filterRunStats = filtered._filterStats || validateFilterDecisionCoverage(allPapersFiltered, filterDecisions);
        if (!filterRunStats.complete) {
            writeFilterArtifacts({
                allPapers,
                allPapersFiltered,
                filtered,
                filterDecisions,
                filterModel,
                filterPromptHash,
                stats: baseFilterStats,
                complete: false,
                sourceHealth,
                retryableDecisions: retryableFilterDecisions
            });
            throw new Error(`筛选未完成：明确决定 ${filterRunStats.decided}/${filterRunStats.totalCandidates}，待重试 ${filterRunStats.retryable || filterRunStats.retryableIds?.length || 0} 篇${filterRunStats.retryableIds?.length ? `（${filterRunStats.retryableIds.join(', ')}）` : ''}`);
        }
        console.log(`筛选后: ${filtered.length} 篇相关论文`);
        writeFilterArtifacts({
            allPapers,
            allPapersFiltered,
            filtered,
            filterDecisions,
            filterModel,
            filterPromptHash,
            stats: baseFilterStats,
            complete: true,
            sourceHealth,
            retryableDecisions: {}
        });

        if (hasRequiredSourceFailure(sourceHealth)) {
            throw new Error(`抓取来源不完整，已保存筛选进度但禁止进入分析或复用缓存: ${getSourceFailures(sourceHealth).join('; ')}`);
        }

        // ========== 第四步半：跳过已在归档中分析过的论文 ==========
        const archiveAnalyzedIds = loadAnalyzedIdsFromArchive();
        const beforeArchiveSkip = filtered.length;
        filteredNew = filtered.filter(paper => {
            const nid = normalizedId(paper);
            // 如果论文已在归档中成功分析过，且当前来源包含 huggingface，则跳过
            if (archiveAnalyzedIds.has(nid) && paper.sources?.includes('huggingface')) {
                return false;
            }
            return true;
        });
        skippedCount = beforeArchiveSkip - filteredNew.length;
        if (skippedCount > 0) {
            console.log(`📦 跳过 ${skippedCount} 篇已在归档中分析过的 HuggingFace 论文`);
        }

        writeFileAtomic(FILTERED_FILE, JSON.stringify({
            timestamp: batchStartedAt,
            batchDate,
            batchId,
            rawPapersSha256: baseFilterStats.rawPapersSha256,
            fetchSourcesSha256: baseFilterStats.fetchSourcesSha256,
            status: 'complete',
            filterModel,
            filterPromptHash,
            filterConfigFingerprint,
            ...candidateFingerprints,
            stats: {
                ...baseFilterStats,
                keywordPrefilterEnabled: Config.FILTER_CONFIG.keywordPrefilterEnabled,
                keywordPrefilterVersion: KEYWORD_PREFILTER_VERSION,
                keywordRejected: Object.values(filterDecisions).filter(decision => decision?.parseSource === 'keyword_prefilter').length,
                llmCandidates: allPapersFiltered.length - Object.values(filterDecisions).filter(decision => decision?.parseSource === 'keyword_prefilter').length,
                llmDecided: Object.values(filterDecisions).filter(decision => decision?.parseSource !== 'keyword_prefilter').length,
                afterBlogSkip: allPapersFiltered.length,
                afterFilter: filtered.length,
                afterArchiveSkip: filteredNew.length,
                skippedFromArchive: skippedCount,
                decisionCount: Object.keys(filterDecisions).length
            },
            sourceHealth,
            excludedRelatedIds: filtered.filter(paper => !filteredNew.some(item => normalizedId(item) === normalizedId(paper))).map(normalizedId),
            papers: filteredNew
        }, null, 2));
        console.log(`💾 筛选结果已保存到: ${FILTERED_FILE}`);
    }

    const outputFile = RESULT_FILE;
    const successfulAnalysisIds = loadCurrentSuccessfulAnalysisIds(outputFile, today);

    // ========== 第4.8步：保存所有爬到论文到 papers.json（提前保存，防止后续中断丢失）==========
    console.log('\n💾 保存所有爬取论文到 papers.json 去重数据库');
    let newPaperCount = 0;
    let pendingPaperCount = 0;
    const filteredNewIds = new Set(filteredNew.map(paper => normalizedId(paper)).filter(Boolean));
    for (const paper of allPapers) {
        const rawId = paper.paper_id || paper.arxivId;
        const normId = normalizedId(rawId);
        if (!normId) continue;
        const status = successfulAnalysisIds.has(normId) ? 'analyzed' : (filteredNewIds.has(normId) ? 'pending_analysis' : 'seen');
        const decision = filterDecisions[normId];
        const nextPaper = markPaperDigestStatus(
            { ...(papersData.papers[normId] || {}), ...paper },
            status,
            {
                batchDate: today,
                latestAttemptStatus: successfulAnalysisIds.has(normId) ? 'analyzed' : undefined,
                error: successfulAnalysisIds.has(normId) ? null : undefined,
                filterDecision: typeof decision?.related === 'boolean' ? decision.related : null,
                filterReason: decision?.reason || '',
                filterRawResponse: decision?.rawResponse || '',
                filterParseSource: decision?.parseSource || '',
                filterModel,
                filterPromptHash,
                filterDecidedAt: decision?.decidedAt || null
            }
        );
        if (!papersData.papers[normId]) {
            newPaperCount++;
        }
        if (status === 'pending_analysis') pendingPaperCount++;
        papersData.papers[normId] = nextPaper;
    }
    savePapersDatabase(papersData);
    console.log(`  新增 ${newPaperCount} 篇论文ID到数据库，待分析 ${pendingPaperCount} 篇，累计 ${Object.keys(papersData.papers).length} 篇`);

    // ========== 第五步：深度分析 ==========
    console.log('\n🔬 第五步：深度分析每篇论文');
    const papersToAnalyze = filteredNew
        .filter(paper => !successfulAnalysisIds.has(normalizedId(paper)))
        .map(paper => mergeCanonicalAnalysisState(paper, loadCanonicalAnalysisRecord(outputFile, paper)));
    const skippedAlreadyAnalyzed = filteredNew.length - papersToAnalyze.length;
    if (skippedAlreadyAnalyzed > 0) {
        console.log(`  ⏭️ 跳过 ${skippedAlreadyAnalyzed} 篇已有成功分析的论文，仅续跑剩余 ${papersToAnalyze.length} 篇`);
    }
    const analyzedPapers = [];

    updateJsonFileLocked(outputFile, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            status: 'running',
            lastUpdated: getBeijingISOString(),
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running'
            }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    const { stats: analysisStats } = await analyzeBatch(papersToAnalyze, {
        checkpointFilePath: outputFile,
        concurrency: ANALYSIS_CONCURRENCY,
        maxRetries: ANALYSIS_RETRY_MAX,
        retryDelayMs: ANALYSIS_RETRY_DELAY_MS,
        preparePaperLocked: paper => {
            const canonical = loadCanonicalAnalysisRecord(outputFile, paper);
            if (isSuccessfulAnalysisRecord(canonical)) {
                return { paper: canonical, skip: true, reason: '该论文已由其他进程完成' };
            }
            return { paper: mergeCanonicalAnalysisState(paper, canonical), skip: false };
        },
        onPaperResultLocked: async (paper, result) => {
            if (result.skipped) return;
            const attempted = result.result || { ...paper, analysis: null, parsed: null, error: result.error || '分析失败' };
            analyzedPapers.push(attempted);
            await mergeAndSaveResults([attempted], outputFile, {
                timestamp: getBeijingISOString(),
                status: 'running'
            });
            updateAnalysisDigestStatuses([attempted], { batchDate: today });
        },
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${total}] ▶ 开始: ${paper.title.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '[N/A]';
                const rank = result.parsed?.rankBucket || '未分档';
                const primaryTask = result.parsed?.primaryTaskTag || '';
                const extra = primaryTask ? ` ${primaryTask}` : '';
                console.log(`  [${idx + 1}/${total}] ✅ 完成 ${score} ${rank}${extra} | ${durSec}s | ${paper.title.substring(0, 50)}...`);
            } else {
                console.log(`  [${idx + 1}/${total}] ❌ 最终失败 | ${durSec}s | ${paper.title.substring(0, 50)}... | ${result.error}`);
            }
        },
        onBatchDone: async (batchNum, batchResults) => {
            const batchSuccess = batchResults.filter(r => r.success).length;
            const batchFailed = batchResults.length - batchSuccess;
            const batchScores = batchResults.filter(r => r.success && r.parsed?.score).map(r => r.parsed.score);
            const batchScoreInfo = batchScores.length > 0 ? ` 评分: ${batchScores.join(', ')}` : '';
            const totalBatches = Math.ceil(papersToAnalyze.length / ANALYSIS_CONCURRENCY);
            console.log(`  ── 批次 ${batchNum}/${totalBatches} 完成: 成功 ${batchSuccess}/${batchResults.length}${batchScoreInfo}${batchFailed > 0 ? ` | 失败 ${batchFailed}` : ''}\n`);

            const snapshot = readJsonFileStrict(outputFile, { allowMissing: true });
            const canonicalPapers = Array.isArray(snapshot) ? snapshot : (snapshot?.papers || []);
            console.log(`  💾 批次状态已更新: 本批成功 ${batchSuccess} 篇（canonical 共 ${canonicalPapers.length} 篇）`);
        }
    });

    // ========== 第六步：保存深度分析结果 ==========
    console.log('\n💾 第六步：保存深度分析结果');

    let existingPapers = [];
    let existingTimestamp = null;
    const existingData = readJsonFileStrict(outputFile, { allowMissing: true });
    if (existingData) {
        existingPapers = Array.isArray(existingData) ? existingData : (existingData.papers || []);
        if (!Array.isArray(existingPapers)) {
            throw new Error(`分析结果 papers 必须是数组，已阻止覆盖损坏文件: ${outputFile}`);
        }
        existingTimestamp = existingData.timestamp || null;
        console.log(`  读取到已有结果: ${existingPapers.length} 篇 (${existingTimestamp})`);
    } else {
        console.log('  读取已有结果失败或文件不存在，将创建新文件');
    }

    if (fs.existsSync(outputFile) && existingPapers.length > 0) {
        const backupName = `deep-analysis-result-${getBeijingCompactTimestamp()}.bak.json`;
        const backupPath = path.join(ARCHIVE_DIR, backupName);
        fs.copyFileSync(outputFile, backupPath);
        console.log(`  已备份: ${backupName}`);

        // 清理旧 backup，保留最近 10 个
        try {
            const backups = fs.readdirSync(ARCHIVE_DIR)
                .filter(f => f.startsWith('deep-analysis-result-') && f.endsWith('.bak.json'))
                .map(f => ({ name: f, path: path.join(ARCHIVE_DIR, f), mtime: fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (backups.length > 10) {
                for (const b of backups.slice(10)) {
                    fs.unlinkSync(b.path);
                }
                console.log(`  已清理 ${backups.length - 10} 个旧 backup`);
            }
        } catch (e) {
            // ignore cleanup errors
        }
    }

    const arxivFetchedCount = arxivPapers.length || getSourceFetchedCount(sourceHealth, 'arxiv', 0);
    const hfFetchedCount = hfPapers.length || getSourceFetchedCount(sourceHealth, 'huggingface', 0);
    const analysisStatus = getAnalysisRunStatus({
        success: (analysisStats?.success || 0) + skippedAlreadyAnalyzed,
        failed: analysisStats?.failed || 0
    }, analysisStats?.failed || 0);

    let result;
    try {
        result = finalizeAnalysisResults(outputFile, filteredNew, {
            batchDate: today,
            analysisStatus,
            arxivFetched: arxivFetchedCount,
            hfFetched: hfFetchedCount,
            totalMerged: allPapers.length,
            afterFilter: filtered.length,
            newlyAnalyzed: analyzedPapers.filter(isSuccessfulAnalysisRecord).length,
            preservedExisting: existingPapers.length,
            arxivOnly,
            hfOnly,
            both,
            sourceHealth
        });
    } catch (e) {
        console.error(`\n❌ 保存结果失败: ${e.message}`);
        throw e;
    }

    const finalStatus = result.stats.analysisStatus;
    result.stats.pipelineStatus = finalStatus === 'complete' ? 'analysis_complete' : 'analysis_incomplete';
    result = persistPipelineStats(outputFile, {
        pipelineStatus: result.stats.pipelineStatus
    });
    console.log(`\n${finalStatus === 'complete' ? '✅' : '❌'} 分析状态: ${finalStatus}`);
    console.log(`📊 统计:`);
    console.log(`  - arxiv 抓取: ${arxivFetchedCount} 篇`);
    console.log(`  - HuggingFace 抓取: ${hfFetchedCount} 篇`);
    console.log(`  - 合并去重: ${allPapers.length} 篇`);
    console.log(`  - LLM 筛选: ${filtered.length} 篇`);
    if (skippedCount > 0) console.log(`  - 归档去重: -${skippedCount} 篇`);
    if (blogSkippedCount > 0) console.log(`  - 博客去重: -${blogSkippedCount} 篇`);
    console.log(`  - 本次分析成功: ${analyzedPapers.filter(isSuccessfulAnalysisRecord).length} 篇`);
    console.log(`  - 保留已有: ${existingPapers.length} 篇`);
    console.log(`  - 合并后总计: ${result.papers.length} 篇`);
    if (result.stats.remainingFailed > 0) console.log(`  - 尚未完成: ${result.stats.remainingFailed} 篇`);
    if (analysisStats) {
        const avgSec = analysisStats.durationTotal > 0 ? (analysisStats.durationTotal / 1000 / (analysisStats.success + analysisStats.failed)).toFixed(1) : '0';
        console.log(`  - 分析引擎: 成功 ${analysisStats.success} | 失败 ${analysisStats.failed} | 跳过 ${analysisStats.skipped} | 平均 ${avgSec}s/篇`);
        const sourceSummary = Object.entries(analysisStats.sourceCounts || {}).map(([key, count]) => `${key}=${count}`).join(' | ');
        if (sourceSummary) console.log(`  - 文本来源: ${sourceSummary}`);
    }
    console.log(`\n💾 结果已保存到: ${outputFile}`);

    return {
        ...result,
        exitCode: getAnalysisExitCode(finalStatus)
    };
}

async function fullFetch(options = {}) {
    const lockTarget = options.lockTarget || FULL_FETCH_RUN_LOCK;
    return withFileLock(lockTarget, runFullFetch, options.lockOptions);
}

if (require.main === module) {
    fullFetch().then(result => {
        process.exitCode = result.exitCode;
    }).catch(err => {
        console.error(`❌ 失败: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    fullFetch,
    runFullFetch,
    autoArchiveCurrentData,
    inferLegacyAnalysisArrayBatchDate,
    migrateLegacyAnalysisResultToCurrent,
    cleanOldData,
    shouldUsePaperForFetchDedup,
    markPaperDigestStatus,
    getFilterPromptHash,
    getFilterConfigFingerprint,
    stableHash,
    stableContentSha256,
    getFetchSourcesSha256,
    pinPapersToBatch,
    mergePaperCategories,
    applyFetchSourceIntegrity,
    hasValidFetchSourceIntegrity,
    getSourceConfigFingerprint,
    buildCandidateFingerprints,
    buildHistoricalDedupBaseline,
    loadFetchCheckpoint,
    saveFetchCheckpoint,
    hasCompleteSourceHealth,
    hasCompleteFetchCheckpoint,
    hasCrossProcessReusableFetchCheckpoint,
    isDefinitiveFilterDecision,
    validateFilterDecisionCoverage,
    validateFilterArtifacts,
    loadReusableFilterDecisions,
    loadResumableFilterForToday,
    resumeFilterStage,
    buildSourceHealth,
    buildArxivCategoryHealth,
    getSourceFetchedCount,
    isReusableArxivCheckpoint,
    getSourceFailures,
    hasRequiredSourceFailure,
    getFatalEmptyCandidateSourceFailures,
    loadCompleteFilteredForToday,
    loadCurrentSuccessfulAnalysisIds,
    loadCanonicalAnalysisRecord,
    mergeCanonicalAnalysisState,
    loadAnalyzedIdsFromArchive,
    loadTodayPapersFromDatabase,
    saveFinalAnalysisResults,
    finalizeAnalysisResults,
    persistPipelineStats
};
