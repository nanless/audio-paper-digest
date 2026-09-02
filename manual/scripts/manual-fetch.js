#!/usr/bin/env node
/**
 * Offline selection companion for the manual_complete pipeline.
 *
 * `--raw` performs only arXiv/HuggingFace retrieval and writes a complete,
 * provenance-bound candidate set.  It never calls an LLM.  `--select` then
 * accepts an operator-reviewed decision map and writes the normal four filter
 * artifacts, with an explicit manual_offline contract and every candidate
 * decided exactly once.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('../../scripts/config.js');
const {
    fetchCategoryPapers,
    buildFilterInputSha256
} = require('../../scripts/fetch-papers.js');
const { fetchHuggingFacePapers, mergeAndDeduplicate } = require('../../scripts/fetch-huggingface-papers.js');
const {
    writeFileAtomic,
    getBeijingISOString,
    normalizedId,
    loadPublishedIdsFromBlog,
    readJsonSafe
} = require('../../scripts/utils.js');
const {
    autoArchiveCurrentData,
    stableHash,
    stableContentSha256,
    pinPapersToBatch,
    getFetchSourcesSha256,
    getSourceConfigFingerprint,
    buildHistoricalDedupBaseline,
    buildCandidateFingerprints,
    buildArxivCategoryHealth,
    buildSourceHealth,
    saveFetchCheckpoint,
    loadFetchCheckpoint,
    hasCompleteFetchCheckpoint,
    hasCompleteSourceHealth,
    isReusableArxivCheckpoint,
    loadAnalyzedIdsFromArchive,
    loadCurrentSuccessfulAnalysisIds,
    validateFilterDecisionCoverage
} = require('../../scripts/full-fetch.js');
const {
    createHostTaskScheduler,
    getAdaptiveHostCooldownMs
} = require('../../scripts/lib/fetch-scheduler.js');
const { persistRawFetchMetricSafely } = require('./manual-raw-fetch-metrics.js');
const {
    loadPapersDatabase,
    savePapersDatabase,
    markPaperDigestStatus
} = require('../../scripts/digest-status.js');
const { acquireFileLock } = require('../../scripts/analysis-engine.js');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const FILTER_CONTRACT_VERSION = 'manual-offline-v1';
const FILTER_PROMPT_HASH = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', 'filter.md')))
    .digest('hex');
const MANUAL_RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function getManualRunLockTarget(date, options = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('manual run lock date 必须是 YYYY-MM-DD');
    return options.lockTarget || path.join(Config.CURRENT_DIR, '.manual-fetch-runs', date);
}

function readManualRunLockOwner(lockTarget) {
    try {
        return JSON.parse(fs.readFileSync(path.join(`${lockTarget}.lock`, 'owner.json'), 'utf8'));
    } catch {
        return null;
    }
}

async function acquireManualRunLock(date, stage, options = {}) {
    if (!['raw', 'select', 'fulltext'].includes(stage)) throw new Error(`未知 manual 阶段: ${stage}`);
    const lockTarget = getManualRunLockTarget(date, options);
    let release;
    try {
        release = await acquireFileLock(lockTarget, {
            timeoutMs: options.timeoutMs ?? 0,
            staleMs: options.staleMs ?? MANUAL_RUN_LOCK_STALE_MS
        });
    } catch (error) {
        const owner = readManualRunLockOwner(lockTarget);
        const ownerText = owner
            ? `pid=${owner.pid || '?'} host=${owner.hostname || '?'} stage=${owner.stage || '?'} acquiredAt=${owner.acquiredAt || '?'}`
            : 'owner=unavailable';
        const locked = new Error(`manual ${date} 已有运行占用，当前阶段 ${stage} 快速失败；${ownerText}`);
        locked.code = 'MANUAL_RUN_LOCKED';
        locked.owner = owner;
        locked.cause = error;
        throw locked;
    }

    const ownerPath = path.join(`${lockTarget}.lock`, 'owner.json');
    const owner = readManualRunLockOwner(lockTarget) || {};
    try {
        writeFileAtomic(ownerPath, JSON.stringify({ ...owner, date, stage }));
    } catch (error) {
        release();
        throw error;
    }
    return release;
}

function readJson(filePath, label) {
    const value = readJsonSafe(filePath, null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 不可读或顶层不是对象: ${filePath}`);
    }
    return value;
}

function parseArgs(argv) {
    const options = { mode: 'raw' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--raw') {
            if (options.mode !== 'raw') throw new Error('--raw 与 --select 不能同时使用');
            options.mode = 'raw';
            continue;
        }
        if (arg === '--select') {
            if (options.mode !== 'raw' || options.spec) throw new Error('--select 参数重复或与其他模式冲突');
            options.mode = 'select';
            options.spec = argv[++i];
            if (!options.spec || options.spec.startsWith('--')) throw new Error('--select 缺少规格 JSON');
            continue;
        }
        if (arg === '--date') {
            options.date = argv[++i];
            if (!options.date || options.date.startsWith('--')) throw new Error('--date 缺少值');
            continue;
        }
        throw new Error(`未知参数: ${arg}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    if (options.mode === 'select' && !options.spec) throw new Error('--select 必须指定规格 JSON');
    return options;
}

function filterConfigFingerprint() {
    return stableHash({
        contract: FILTER_CONTRACT_VERSION,
        promptSha256: FILTER_PROMPT_HASH,
        sourceConfigFingerprint: getSourceConfigFingerprint(),
        operator: 'Codex-manual-review',
        relatedPolicy: 'explicit-per-candidate-review'
    });
}

function sourceStats(papers, afterBlogSkipPapers = papers) {
    return {
        beforeBlogSkip: papers.length,
        afterBlogSkip: afterBlogSkipPapers.length,
        skippedFromBlog: papers.length - afterBlogSkipPapers.length,
        arxivOnly: papers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length,
        hfOnly: papers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length,
        both: papers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length
    };
}

function applyManualArchiveExclusion(related, archiveAnalyzedIds) {
    const excludedRelatedIds = related
        .filter(paper => archiveAnalyzedIds.has(normalizedId(paper)) && paper.sources?.includes('huggingface'))
        .map(normalizedId);
    const excludedRelatedSet = new Set(excludedRelatedIds);
    return {
        excludedRelatedIds,
        excludedRelatedSet,
        filteredRelated: related.filter(paper => !excludedRelatedSet.has(normalizedId(paper)))
    };
}

function applyManualFilterStatuses(
    papersData,
    rawPapers,
    decisions,
    filteredIds,
    excludedRelatedSet,
    currentSuccessfulIds,
    date
) {
    for (const paper of rawPapers) {
        const id = normalizedId(paper);
        const alreadyAnalyzed = currentSuccessfulIds.has(id) || excludedRelatedSet.has(id);
        const status = alreadyAnalyzed ? 'analyzed' : (filteredIds.has(id) ? 'pending_analysis' : 'seen');
        const decision = decisions[id];
        papersData.papers[id] = markPaperDigestStatus(
            { ...(papersData.papers[id] || {}), ...paper },
            status,
            {
                batchDate: date,
                latestAttemptStatus: alreadyAnalyzed ? 'analyzed' : undefined,
                error: alreadyAnalyzed ? null : undefined,
                filterDecision: decision.related,
                filterReason: decision.reason,
                filterRawResponse: '',
                filterParseSource: decision.parseSource,
                filterModel: 'manual_offline',
                filterPromptHash: FILTER_PROMPT_HASH,
                filterDecidedAt: decision.decidedAt
            }
        );
    }
    return papersData;
}

function initialCategoryOrder() {
    const core = Config.ARXIV_CATEGORIES.filter(category => category.priority === 'core');
    const supplements = Config.ARXIV_CATEGORIES.filter(category => category.priority !== 'core');
    for (let i = supplements.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [supplements[i], supplements[j]] = [supplements[j], supplements[i]];
    }
    return [...core, ...supplements].map(category => category.id);
}

function validateManualRawCheckpoint(raw, checkpoint) {
    if (!hasCompleteSourceHealth(raw.sourceHealth)) {
        throw new Error('manual raw 来源健康不完整');
    }
    if (!hasCompleteFetchCheckpoint(checkpoint)) {
        throw new Error('manual raw 缺少完整且内容可验证的抓取 checkpoint');
    }
    for (const key of ['batchDate', 'batchId', 'candidateFingerprint']) {
        if (raw[key] !== checkpoint[key]) throw new Error(`manual raw 与抓取 checkpoint 的 ${key} 不一致`);
    }
    if (raw.fetchSourcesSha256 !== checkpoint.fetchSourcesSha256) {
        throw new Error('manual raw 与抓取 checkpoint 的来源内容 SHA 不一致');
    }
}

function makeBatchMeta(date, timestamp, candidateFingerprint) {
    return {
        timestamp,
        batchDate: date,
        batchStartedAt: timestamp,
        batchId: stableHash({ date, timestamp, candidateFingerprint, mode: FILTER_CONTRACT_VERSION })
    };
}

async function fetchRaw(date) {
    const rawStartedNs = process.hrtime.bigint();
    let timestamp = getBeijingISOString();
    autoArchiveCurrentData(date);
    const papersData = loadPapersDatabase();
    const publishedIds = loadPublishedIdsFromBlog(Config.PUBLISH_CONFIG.blogRepo);
    const historicalDedupIds = buildHistoricalDedupBaseline(papersData, date, publishedIds);
    const historicalExistingIds = new Set(historicalDedupIds);
    const candidateFingerprints = buildCandidateFingerprints(historicalExistingIds, publishedIds);
    let meta = makeBatchMeta(date, timestamp, candidateFingerprints.candidateFingerprint);
    const checkpoint = loadFetchCheckpoint(date, candidateFingerprints.candidateFingerprint) || {
        ...meta,
        categoryOrder: initialCategoryOrder(),
        historicalDedupIds,
        ...candidateFingerprints,
        arxiv: {},
        huggingface: null
    };
    if (stableHash(checkpoint.historicalDedupIds) !== stableHash(historicalDedupIds)) {
        throw new Error('manual 抓取 checkpoint 的历史去重基线与当前候选指纹不一致');
    }
    timestamp = checkpoint.batchStartedAt || checkpoint.timestamp || timestamp;
    meta = {
        ...meta,
        timestamp,
        batchStartedAt: timestamp,
        batchId: checkpoint.batchId || meta.batchId
    };
    const arxivPapers = [];
    const arxivById = new Map();
    const sourceHealth = { arxiv: { categories: [] }, huggingface: {} };
    const categoryById = new Map(Config.ARXIV_CATEGORIES.map(category => [category.id, category]));
    if (checkpoint.categoryOrder.length !== Config.ARXIV_CATEGORIES.length
        || new Set(checkpoint.categoryOrder).size !== Config.ARXIV_CATEGORIES.length
        || checkpoint.categoryOrder.some(id => !categoryById.has(id))) {
        throw new Error('manual 抓取 checkpoint 的 categoryOrder 与当前来源配置不一致');
    }
    saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);

    // Category orchestration is sequential, and the same scheduler also guards
    // abstract fan-out at the real socket edge. Healthy traffic uses a small
    // host cooldown; transient failures and 429 raise the next-host eligibility.
    // Retry sleeps happen concurrently with that eligibility window, so there
    // is no second fixed category penalty after a successful retry.
    const arxivRequestScheduler = createHostTaskScheduler({
        cooldownAfter: outcome => getAdaptiveHostCooldownMs(outcome, {
            healthyDelayMs: Config.ARXIV_CONFIG.hostHealthyCooldownMs,
            transientDelayMs: Config.ARXIV_CONFIG.hostTransientCooldownMs,
            rateLimitedDelayMs: Config.ARXIV_CONFIG.hostRateLimitedCooldownMs,
            jitterMaxMs: Config.ARXIV_CONFIG.hostCooldownJitterMs
        })
    });
    const abstractCache = new Map();
    const categoryObservations = [];
    const rememberAbstract = paper => {
        const id = normalizedId(paper);
        const abstract = String(paper?.abstract || paper?.summary || '').trim();
        if (id && abstract && !abstractCache.has(id)) abstractCache.set(id, Promise.resolve(abstract));
    };
    const huggingfaceCacheHit = checkpoint.huggingface?.status === 'complete'
        && checkpoint.huggingface.health?.ok === true
        && Array.isArray(checkpoint.huggingface.papers);
    const hfTask = (async () => {
        if (huggingfaceCacheHit
            && checkpoint.huggingface.health?.ok === true
            && Array.isArray(checkpoint.huggingface.papers)) {
            return {
                papers: checkpoint.huggingface.papers,
                health: checkpoint.huggingface.health,
                error: null
            };
        }
        try {
            const papers = await fetchHuggingFacePapers(historicalExistingIds, {
                fetchedAt: timestamp
            });
            const health = {
                ...(papers._sourceHealth || {}),
                ok: true,
                totalFetched: papers.length
            };
            checkpoint.huggingface = { status: 'complete', papers, health };
            saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);
            return { papers, health, error: null };
        } catch (error) {
            const health = error.sourceHealth || { ok: false, error: error.message };
            checkpoint.huggingface = { status: 'failed', papers: [], health };
            saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);
            return { papers: [], health, error };
        }
    })();

    for (let i = 0; i < checkpoint.categoryOrder.length; i++) {
        const category = categoryById.get(checkpoint.categoryOrder[i]);
        const cached = checkpoint.arxiv[category.id];
        if (isReusableArxivCheckpoint(cached)) {
            sourceHealth.arxiv.categories.push(cached.health);
            categoryObservations.push({
                id: category.id,
                cacheHit: true,
                durationMs: null,
                retryCount: 0,
                rateLimitRetryCount: 0,
                retryWaitMs: 0,
                rateLimitWaitMs: 0,
                abstractCacheHits: 0,
                abstractCacheMisses: 0
            });
            for (const paper of cached.papers) {
                rememberAbstract(paper);
                const id = normalizedId(paper);
                if (!id) continue;
                if (arxivById.has(id)) {
                    const existing = arxivById.get(id);
                    existing.categories = Array.from(new Set([...(existing.categories || []), ...(paper.categories || []), category.id])).sort();
                } else {
                    arxivById.set(id, paper);
                    arxivPapers.push(paper);
                }
            }
            continue;
        }
        let started = null;
        let papers = [];
        let fetchError = null;
        let fetchHealth = null;
        try {
            started = Date.now();
            papers = await fetchCategoryPapers(
                category.id,
                Config.ARXIV_CONFIG.maxResultsPerCategory,
                Config.ARXIV_CONFIG.fetchMaxRetries,
                historicalExistingIds,
                {
                    requestScheduler: arxivRequestScheduler,
                    schedulerHandlesPacing: true,
                    abstractCache
                }
            );
            pinPapersToBatch(papers, timestamp);
            fetchHealth = papers._sourceHealth || null;
        } catch (error) {
            fetchError = error;
            fetchHealth = error.sourceHealth || null;
            console.error(`  ⚠️ ${category.id} 抓取失败: ${error.message}`);
        }
        const uniqueBefore = arxivPapers.length;
        for (const paper of papers) {
            rememberAbstract(paper);
            const id = normalizedId(paper);
            if (!id) continue;
            if (arxivById.has(id)) {
                const existing = arxivById.get(id);
                existing.categories = Array.from(new Set([...(existing.categories || []), ...(paper.categories || []), category.id])).sort();
                continue;
            }
            arxivById.set(id, paper);
            arxivPapers.push(paper);
        }
        const health = buildArxivCategoryHealth(category, {
            papers,
            fetchHealth,
            durationMs: started === null ? 0 : Date.now() - started,
            error: fetchError,
            newInCategory: arxivPapers.length - uniqueBefore,
            duplicateInCategory: Math.max(0, papers.length - (arxivPapers.length - uniqueBefore))
        });
        sourceHealth.arxiv.categories.push(health);
        categoryObservations.push({
            id: category.id,
            cacheHit: false,
            durationMs: health.durationMs,
            retryCount: fetchHealth?.retryCount || 0,
            rateLimitRetryCount: fetchHealth?.rateLimitRetryCount || 0,
            retryWaitMs: fetchHealth?.totalRetryWaitMs || 0,
            rateLimitWaitMs: fetchHealth?.rateLimitWaitMs || 0,
            abstractCacheHits: fetchHealth?.abstracts?.cacheHits || 0,
            abstractCacheMisses: fetchHealth?.abstracts?.attempted || 0
        });
        checkpoint.arxiv[category.id] = {
            status: fetchError ? 'failed' : 'complete',
            papers: fetchError ? [] : papers,
            health
        };
        saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);
        if (fetchError) {
            await hfTask;
            throw new Error(`来源不完整，不能进入 manual filter: ${category.id}`);
        }
    }

    const hfOutcome = await hfTask;
    sourceHealth.huggingface = hfOutcome.health;
    if (hfOutcome.error) {
        throw new Error(`来源不完整，不能进入 manual filter: HuggingFace: ${hfOutcome.error.message}`);
    }
    const hfPapers = hfOutcome.papers;
    checkpoint.timestamp = timestamp;
    checkpoint.fetchSourcesSha256 = getFetchSourcesSha256(checkpoint);
    saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);

    const merged = mergeAndDeduplicate(arxivPapers, hfPapers).map(paper => ({ ...paper, fetchedAt: timestamp }));
    const publishedFiltered = merged.filter(paper => !publishedIds.has(normalizedId(paper)));
    const stats = sourceStats(merged, publishedFiltered);
    const raw = {
        ...meta,
        ...candidateFingerprints,
        filterContract: FILTER_CONTRACT_VERSION,
        sourceHealth: buildSourceHealth(sourceHealth, arxivPapers, hfPapers),
        fetchSourcesSha256: checkpoint.fetchSourcesSha256,
        stats,
        papers: publishedFiltered
    };
    raw.rawPapersSha256 = stableContentSha256(raw.papers);
    writeFileAtomic(Config.FILES.rawCandidates, JSON.stringify(raw, null, 2));
    persistRawFetchMetricSafely({
        date,
        status: 'complete',
        wallNs: process.hrtime.bigint() - rawStartedNs,
        categories: categoryObservations,
        scheduler: arxivRequestScheduler.getMetricsSnapshot(),
        huggingfaceCacheHit,
        paperCount: publishedFiltered.length,
        outputFiles: [
            { role: 'raw_candidates', path: Config.FILES.rawCandidates },
            { role: 'fetch_checkpoint', path: Config.FILES.fetchCheckpoint }
        ]
    });
    console.log(`✅ manual raw 已保存：${publishedFiltered.length} 篇候选`);
    console.log(`🧾 人工筛选规格需覆盖全部 ID：${Config.FILES.rawCandidates}`);
    for (const paper of publishedFiltered) {
        console.log(`${normalizedId(paper)}\t${String(paper.title || '').replace(/[\r\n]+/g, ' ')}\t${String(paper.abstract || paper.summary || '').replace(/[\r\n]+/g, ' ').slice(0, 260)}`);
    }
    return raw;
}

function loadRaw(date) {
    const raw = readJson(Config.FILES.rawCandidates, 'raw-candidates');
    if (raw.batchDate !== date || raw.filterContract !== FILTER_CONTRACT_VERSION || !Array.isArray(raw.papers)) {
        throw new Error(`raw-candidates.json 不是 ${date} 的 ${FILTER_CONTRACT_VERSION} 候选集`);
    }
    if (raw.rawPapersSha256 !== stableContentSha256(raw.papers)) throw new Error('raw-candidates papers SHA 不一致');
    const checkpoint = loadFetchCheckpoint(date, raw.candidateFingerprint, Config.FILES.fetchCheckpoint);
    validateManualRawCheckpoint(raw, checkpoint);
    return raw;
}

function assertUniqueNormalizedDecisionKeys(decisions) {
    const seen = new Map();
    for (const key of Object.keys(decisions || {})) {
        const id = normalizedId(key);
        if (!id) throw new Error(`manual filter decision key 无法规范化: ${key}`);
        if (seen.has(id)) {
            throw new Error(`manual filter decisions 含规范化重复 key: ${seen.get(id)} / ${key} -> ${id}`);
        }
        seen.set(id, key);
    }
    return seen;
}

function writeSelection(date, specPath) {
    const raw = loadRaw(date);
    const spec = readJson(path.resolve(specPath), 'manual filter spec');
    if (spec.version !== 1 || spec.mode !== 'manual_offline' || spec.date !== date) {
        throw new Error('manual filter spec 必须是 {version:1, mode:"manual_offline", date}');
    }
    if (!spec.reviewer || typeof spec.reviewer !== 'string' || spec.reviewer.trim().length < 2) {
        throw new Error('manual filter spec 缺少 reviewer');
    }
    const decisions = spec.decisions;
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('manual filter spec 缺少 decisions 对象');
    assertUniqueNormalizedDecisionKeys(decisions);
    const rawById = new Map(raw.papers.map(paper => [normalizedId(paper), paper]));
    const decisionIds = new Set(Object.keys(decisions).map(normalizedId).filter(Boolean));
    if (decisionIds.size !== rawById.size) throw new Error(`manual filter 必须逐篇决定：收到 ${decisionIds.size}，候选 ${rawById.size}`);
    for (const id of rawById.keys()) if (!decisionIds.has(id)) throw new Error(`manual filter 缺少 ${id}`);
    for (const id of decisionIds) if (!rawById.has(id)) throw new Error(`manual filter 包含未知 ID: ${id}`);

    const timestamp = getBeijingISOString();
    const configFingerprint = filterConfigFingerprint();
    const output = {};
    for (const [key, value] of Object.entries(decisions)) {
        const id = normalizedId(key);
        if (!value || typeof value !== 'object' || typeof value.related !== 'boolean') throw new Error(`${id} related 必须是布尔值`);
        if (typeof value.reason !== 'string' || value.reason.trim().length < 20) throw new Error(`${id} reason 至少 20 字，必须说明人工依据`);
        const reviewedFields = Array.isArray(value.reviewedFields) ? Array.from(new Set(value.reviewedFields)) : [];
        if (!['title', 'abstract', 'categories', 'sources'].every(field => reviewedFields.includes(field))) {
            throw new Error(`${id} reviewedFields 必须明确包含 title/abstract/categories/sources`);
        }
        output[id] = {
            id,
            arxivId: id,
            related: value.related,
            reason: value.reason.trim(),
            rawResponse: '',
            parseSource: FILTER_CONTRACT_VERSION,
            decidedAt: timestamp,
            filterModel: 'manual_offline',
            filterPromptHash: FILTER_PROMPT_HASH,
            inputSha256: buildFilterInputSha256(rawById.get(id)),
            reviewer: spec.reviewer,
            reviewBasis: 'title_abstract_categories_manual',
            reviewedFields
        };
    }
    const coverage = validateFilterDecisionCoverage(raw.papers, output);
    if (!coverage.complete) throw new Error(`manual filter 覆盖失败: ${JSON.stringify(coverage)}`);
    const related = raw.papers.filter(paper => output[normalizedId(paper)]?.related === true);
    const archiveAnalyzedIds = loadAnalyzedIdsFromArchive();
    const { excludedRelatedIds, excludedRelatedSet, filteredRelated } = applyManualArchiveExclusion(
        related,
        archiveAnalyzedIds
    );
    const stats = {
        ...raw.stats,
        totalCandidates: raw.papers.length,
        decided: raw.papers.length,
        related: related.length,
        retryable: 0,
        complete: true,
        manualReviewed: true,
        reviewer: spec.reviewer
    };
    const common = {
        timestamp,
        batchDate: date,
        batchId: raw.batchId,
        candidateFingerprint: raw.candidateFingerprint,
        sourceConfigFingerprint: raw.sourceConfigFingerprint,
        blogDedupFingerprint: raw.blogDedupFingerprint,
        filterModel: 'manual_offline',
        filterPromptHash: FILTER_PROMPT_HASH,
        filterConfigFingerprint: configFingerprint,
        rawPapersSha256: raw.rawPapersSha256,
        fetchSourcesSha256: raw.fetchSourcesSha256,
        filterContract: FILTER_CONTRACT_VERSION
    };
    writeFileAtomic(Config.FILES.filterDecisions, JSON.stringify({ ...common, stats, decisions: output, retryableDecisions: {} }, null, 2));
    const filtered = {
        ...common,
        status: 'complete',
        sourceHealth: raw.sourceHealth,
        stats: {
            ...stats,
            beforeFilter: raw.papers.length,
            beforeBlogSkip: raw.stats.beforeBlogSkip,
            afterBlogSkip: raw.papers.length,
            afterFilter: related.length,
            afterArchiveSkip: filteredRelated.length,
            skippedFromArchive: excludedRelatedIds.length,
            decisionCount: raw.papers.length,
            keywordPrefilterEnabled: false,
            keywordRejected: 0,
            llmCandidates: 0,
            llmDecided: 0
        },
        excludedRelatedIds,
        papers: filteredRelated
    };
    writeFileAtomic(Config.FILES.filteredPapers, JSON.stringify(filtered, null, 2));
    const papersData = loadPapersDatabase();
    const currentSuccessfulIds = loadCurrentSuccessfulAnalysisIds(Config.FILES.deepAnalysisResult, date);
    const filteredIds = new Set(filteredRelated.map(normalizedId));
    applyManualFilterStatuses(
        papersData,
        raw.papers,
        output,
        filteredIds,
        excludedRelatedSet,
        currentSuccessfulIds,
        date
    );
    savePapersDatabase(papersData);
    console.log(`✅ manual filter complete：${related.length}/${raw.papers.length} 篇 related，归档排除 ${excludedRelatedIds.length} 篇`);
    return filtered;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const release = await acquireManualRunLock(options.date, options.mode);
    try {
        if (options.mode === 'raw') await fetchRaw(options.date);
        else writeSelection(options.date, options.spec);
    } finally {
        release();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ manual-fetch 失败: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    FILTER_CONTRACT_VERSION,
    filterConfigFingerprint,
    sourceStats,
    initialCategoryOrder,
    validateManualRawCheckpoint,
    applyManualArchiveExclusion,
    applyManualFilterStatuses,
    assertUniqueNormalizedDecisionKeys,
    getManualRunLockTarget,
    readManualRunLockOwner,
    acquireManualRunLock,
    fetchRaw,
    writeSelection,
    parseArgs
};
