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
const Config = require('./config.js');
const {
    fetchCategoryPapers,
    buildFilterInputSha256
} = require('./fetch-papers.js');
const { fetchHuggingFacePapers, mergeAndDeduplicate } = require('./fetch-huggingface-papers.js');
const {
    writeFileAtomic,
    getBeijingISOString,
    normalizedId,
    loadPublishedIdsFromBlog,
    readJsonSafe
} = require('./utils.js');
const {
    autoArchiveCurrentData,
    stableHash,
    stableContentSha256,
    pinPapersToBatch,
    applyFetchSourceIntegrity,
    getFetchSourcesSha256,
    getSourceConfigFingerprint,
    buildHistoricalDedupBaseline,
    buildCandidateFingerprints,
    buildArxivCategoryHealth,
    buildSourceHealth,
    saveFetchCheckpoint,
    hasCompleteSourceHealth,
    validateFilterDecisionCoverage
} = require('./full-fetch.js');
const { loadPapersDatabase } = require('./digest-status.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const FILTER_CONTRACT_VERSION = 'manual-offline-v1';
const FILTER_PROMPT_HASH = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', 'filter.md')))
    .digest('hex');

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

function sourceStats(papers) {
    return {
        beforeBlogSkip: papers.length,
        afterBlogSkip: papers.length,
        skippedFromBlog: 0,
        arxivOnly: papers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length,
        hfOnly: papers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length,
        both: papers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length
    };
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
    const timestamp = getBeijingISOString();
    autoArchiveCurrentData(date);
    const papersData = loadPapersDatabase();
    const publishedIds = loadPublishedIdsFromBlog(Config.PUBLISH_CONFIG.blogRepo);
    const historicalDedupIds = buildHistoricalDedupBaseline(papersData, date, publishedIds);
    const historicalExistingIds = new Set(historicalDedupIds);
    const candidateFingerprints = buildCandidateFingerprints(historicalExistingIds, publishedIds);
    const meta = makeBatchMeta(date, timestamp, candidateFingerprints.candidateFingerprint);
    const checkpoint = {
        ...meta,
        categoryOrder: Config.ARXIV_CATEGORIES.map(category => category.id),
        historicalDedupIds,
        ...candidateFingerprints,
        arxiv: {},
        huggingface: null
    };
    const arxivPapers = [];
    const arxivById = new Map();
    const sourceHealth = { arxiv: { categories: [] }, huggingface: {} };

    for (const category of Config.ARXIV_CATEGORIES) {
        const started = Date.now();
        let papers = [];
        let fetchError = null;
        let fetchHealth = null;
        try {
            papers = await fetchCategoryPapers(
                category.id,
                Config.ARXIV_CONFIG.maxResultsPerCategory,
                Config.ARXIV_CONFIG.fetchMaxRetries,
                historicalExistingIds
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
            durationMs: Date.now() - started,
            error: fetchError,
            newInCategory: arxivPapers.length - uniqueBefore,
            duplicateInCategory: Math.max(0, papers.length - (arxivPapers.length - uniqueBefore))
        });
        sourceHealth.arxiv.categories.push(health);
        checkpoint.arxiv[category.id] = {
            status: fetchError ? 'failed' : 'complete',
            papers: fetchError ? [] : papers,
            health
        };
        if (fetchError) {
            throw new Error(`来源不完整，不能进入 manual filter: ${category.id}`);
        }
    }

    let hfPapers;
    try {
        hfPapers = await fetchHuggingFacePapers(historicalExistingIds, {
            fetchedAt: timestamp
        });
    } catch (error) {
        sourceHealth.huggingface = error.sourceHealth || { ok: false, error: error.message };
        checkpoint.huggingface = { status: 'failed', papers: [], health: sourceHealth.huggingface };
        throw new Error(`来源不完整，不能进入 manual filter: HuggingFace: ${error.message}`);
    }
    const hfHealth = hfPapers._sourceHealth || { ok: true, fetched: hfPapers.length };
    sourceHealth.huggingface = { ...hfHealth, ok: true, totalFetched: hfPapers.length };
    checkpoint.huggingface = { status: 'complete', papers: hfPapers, health: sourceHealth.huggingface };
    checkpoint.timestamp = timestamp;
    checkpoint.fetchSourcesSha256 = getFetchSourcesSha256(checkpoint);
    saveFetchCheckpoint(checkpoint, Config.FILES.fetchCheckpoint);

    const merged = mergeAndDeduplicate(arxivPapers, hfPapers).map(paper => ({ ...paper, fetchedAt: timestamp }));
    const publishedFiltered = merged.filter(paper => !publishedIds.has(normalizedId(paper)));
    const stats = sourceStats(publishedFiltered);
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
    return raw;
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
            beforeBlogSkip: raw.papers.length,
            afterBlogSkip: raw.papers.length,
            afterFilter: related.length,
            afterArchiveSkip: related.length,
            skippedFromArchive: 0,
            decisionCount: raw.papers.length,
            keywordPrefilterEnabled: false,
            keywordRejected: 0,
            llmCandidates: 0,
            llmDecided: 0
        },
        excludedRelatedIds: [],
        papers: related
    };
    writeFileAtomic(Config.FILES.filteredPapers, JSON.stringify(filtered, null, 2));
    console.log(`✅ manual filter complete：${related.length}/${raw.papers.length} 篇 related`);
    return filtered;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'raw') await fetchRaw(options.date);
    else writeSelection(options.date, options.spec);
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
    fetchRaw,
    writeSelection,
    parseArgs
};
