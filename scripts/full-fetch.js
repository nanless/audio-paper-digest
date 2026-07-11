#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 完整论文抓取 + 深度分析（arxiv + HuggingFace Papers）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchCategoryPapers, filterPapersWithLLM } = require('./fetch-papers.js');
const { fetchHuggingFacePapers, mergeAndDeduplicate } = require('./fetch-huggingface-papers.js');
const { writeFileAtomic, getBeijingISOString, getBeijingCompactTimestamp, getBeijingDateString, readJsonSafe, getRecordDate, normalizedId, backupPapersJson, loadPublishedIdsFromBlog } = require('./utils.js');
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
    getAnalysisExitCode
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
const FULL_FETCH_RUN_LOCK = path.join(Config.CURRENT_DIR, '.full-fetch-run');

function shouldUsePaperForFetchDedup(paper) {
    const status = paper?.digestStatus?.status;
    return status !== 'pending_analysis' && status !== 'analysis_failed';
}

function getFilterPromptHash() {
    const promptPath = path.join(Config.PROJECT_ROOT, 'prompts', 'filter.md');
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(promptPath)).digest('hex').slice(0, 16);
    } catch (e) {
        return 'unknown';
    }
}

function isDefinitiveFilterDecision(decision) {
    return Boolean(decision)
        && typeof decision.related === 'boolean'
        && !decision.retryable
        && !decision.fallback;
}

function validateFilterDecisionCoverage(papers, decisions) {
    const candidateIds = new Set((papers || []).map(paper => normalizedId(paper)).filter(Boolean));
    const decisionEntries = Object.entries(decisions || {})
        .map(([id, decision]) => [normalizedId(id), decision])
        .filter(([id]) => Boolean(id));
    const validDecisionIds = new Set(decisionEntries
        .filter(([, decision]) => isDefinitiveFilterDecision(decision))
        .map(([id]) => id));
    const retryableIds = decisionEntries
        .filter(([, decision]) => !isDefinitiveFilterDecision(decision))
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

function loadReusableFilterDecisions(today, filterModel, filterPromptHash) {
    if (!fs.existsSync(FILTER_DECISIONS_FILE)) return {};
    const data = readJsonSafe(FILTER_DECISIONS_FILE);
    if (!data || getRecordDate(data) !== today) return {};
    if (data.filterModel !== filterModel || data.filterPromptHash !== filterPromptHash) {
        console.log('  [filter] 已有筛选决策与当前模型/prompt 不一致，忽略旧缓存');
        return {};
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

function loadCompleteFilteredForToday(today, filePath = FILTERED_FILE, expected = {}) {
    const data = loadTodayJsonFile(filePath, today);
    if (!data || data.status !== 'complete' || !Array.isArray(data.papers)) return null;
    if (expected.filterModel !== undefined && data.filterModel !== expected.filterModel) return null;
    if (expected.filterPromptHash !== undefined && data.filterPromptHash !== expected.filterPromptHash) return null;
    if (expected.requireConsistentFilterArtifacts && !hasConsistentFilterArtifacts(today, data)) {
        console.log('  [filter] 今日筛选产物与逐篇决策缓存不一致，忽略 complete 缓存并重新筛选');
        return null;
    }
    return data;
}

function hasConsistentFilterArtifacts(today, filteredData) {
    const decisionsData = loadTodayJsonFile(FILTER_DECISIONS_FILE, today);
    const rawCandidates = loadTodayJsonFile(RAW_CANDIDATES_FILE, today);
    return validateFilterArtifacts(filteredData, decisionsData, rawCandidates);
}

function validateFilterArtifacts(filteredData, decisionsData, rawCandidates = null) {
    if (!filteredData || !decisionsData || !decisionsData.decisions || typeof decisionsData.decisions !== 'object') {
        return false;
    }
    if (decisionsData.stats?.complete !== true) return false;
    if (decisionsData.filterModel !== filteredData.filterModel) return false;
    if (decisionsData.filterPromptHash !== filteredData.filterPromptHash) return false;

    const decisionIds = new Set(Object.keys(decisionsData.decisions).map(id => normalizedId(id)).filter(Boolean));
    const decisionCount = decisionIds.size;
    const filteredStats = filteredData.stats || {};
    if (Number.isInteger(filteredStats.decisionCount) && filteredStats.decisionCount !== decisionCount) {
        return false;
    }

    const rawPapers = Array.isArray(rawCandidates?.papers) ? rawCandidates.papers : null;
    if (rawPapers) {
        const coverage = validateFilterDecisionCoverage(rawPapers, decisionsData.decisions);
        if (!coverage.complete || coverage.decided !== decisionCount) return false;
        if (decisionsData.stats.totalCandidates !== coverage.totalCandidates) return false;
        if (decisionsData.stats.decided !== coverage.decided) return false;
    }

    for (const paper of filteredData.papers || []) {
        const id = normalizedId(paper);
        if (!id || decisionsData.decisions[id]?.related !== true) return false;
    }

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

function saveFinalAnalysisResults(filePath, newResults, expectedPapers, stats = {}) {
    return updateJsonFileLocked(filePath, current => {
        const existingPapers = Array.isArray(current) ? current : (current?.papers || []);
        const mergedPapers = mergePapersById(existingPapers, newResults, {
            preserveSuccessfulAnalysis: true
        });
        const mergedById = new Map(mergedPapers.map(paper => [normalizedId(paper), paper]));
        const expectedIds = new Set((expectedPapers || []).map(normalizedId).filter(Boolean));
        let successful = 0;
        for (const id of expectedIds) {
            if (isSuccessfulAnalysisRecord(mergedById.get(id))) successful++;
        }
        const remainingFailed = expectedIds.size - successful;
        const inferredStatus = getAnalysisRunStatus({ success: successful }, remainingFailed);
        const analysisStatus = inferredStatus;
        const now = getBeijingISOString();
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            timestamp: now,
            previousTimestamp: !Array.isArray(current) ? current?.timestamp || null : null,
            status: analysisStatus,
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                ...stats,
                analysisStatus,
                remainingFailed,
                successfulExpected: successful,
                preservedExisting: existingPapers.length,
                totalAfterMerge: mergedPapers.length
            },
            papers: mergedPapers
        };
        if (analysisStatus === 'complete') payload.deepAnalysisCompletedAt = now;
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    });
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

function getSourceFetchedCount(sourceHealth, sourceName, fallbackCount = 0) {
    const source = sourceHealth?.[sourceName] || {};
    const value = Number.isFinite(source.totalFetched) ? source.totalFetched : source.fetched;
    return Number.isFinite(value) ? value : fallbackCount;
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
    return getSourceFailures(sourceHealth).length > 0;
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
    const timestamp = getBeijingISOString();
    const coverage = validateFilterDecisionCoverage(allPapersFiltered, filterDecisions);
    if (complete && !coverage.complete) {
        throw new Error(`筛选决策覆盖不完整，禁止标记 complete：明确决定 ${coverage.decided}/${coverage.totalCandidates}，待重试/缺失 ${coverage.missingIds.join(', ') || '无'}`);
    }
    const sourceFailure = sourceHealth && hasRequiredSourceFailure(sourceHealth);
    const artifactComplete = complete && coverage.complete && !sourceFailure;
    writeFileAtomic(FILTER_DECISIONS_FILE, JSON.stringify({
        timestamp,
        filterModel,
        filterPromptHash,
        stats: {
            totalCandidates: coverage.totalCandidates,
            decided: coverage.decided,
            related: filtered.length,
            retryable: Object.keys(retryableDecisions).length,
            complete: artifactComplete
        },
        decisions: filterDecisions,
        retryableDecisions
    }, null, 2));

    writeFileAtomic(FILTERED_FILE, JSON.stringify({
        timestamp,
        status: artifactComplete ? 'filter_complete' : (sourceFailure ? 'source_partial_failed' : 'filtering'),
        filterModel,
        filterPromptHash,
        stats: {
            ...stats,
            afterFilter: filtered.length,
            decisionCount: Object.keys(filterDecisions).length
        },
        sourceHealth,
        papers: filtered
    }, null, 2));
}

function autoArchiveCurrentData() {
    const today = getBeijingDateString();
    const targets = [RESULT_FILE, FILTERED_FILE, ANALYZED_FILE];
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

            const archiveDayDir = path.join(ARCHIVE_DIR, recordDate);
            const archivePath = path.join(archiveDayDir, path.basename(filePath));
            if (fs.existsSync(archivePath)) {
                try {
                    const currentContent = fs.readFileSync(filePath, 'utf8');
                    const archivedContent = fs.readFileSync(archivePath, 'utf8');
                    if (currentContent === archivedContent) {
                        console.log(`  [归档] 已存在且内容一致，跳过 ${recordDate}/${path.basename(filePath)}`);
                    } else {
                        const backupPath = path.join(
                            archiveDayDir,
                            `${path.basename(filePath, '.json')}-${getBeijingCompactTimestamp()}.json`
                        );
                        fs.copyFileSync(filePath, backupPath);
                        archived++;
                        console.log(`  [归档] 已存在但内容不同，另存为 ${path.basename(backupPath)}`);
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
 * 清理非今日数据（归档后残留的旧数据）
 * 归档函数只在文件日期早于今天时触发，但文件可能在当天被修改导致未归档
 */
function cleanOldData(filePath, name, today) {
    return withFileLockSync(filePath, () => {
        if (!fs.existsSync(filePath)) return;
        const data = readJsonSafe(filePath);
        if (!data || !data.papers || !Array.isArray(data.papers)) return;

        const before = data.papers.length;
        data.papers = data.papers.filter(p => {
            const date = (p.fetchedAt || p.timestamp || '').substring(0, 10);
            // 无日期字段的论文可能是从旧格式迁移的，保留它们
            return !date || date === today;
        });
        const removed = before - data.papers.length;

        if (removed > 0) {
            try {
                const cleanupDir = path.join(ARCHIVE_DIR, 'cleanup');
                fs.mkdirSync(cleanupDir, { recursive: true });
                const backupPath = path.join(cleanupDir, `${name}-${getBeijingCompactTimestamp()}.json`);
                fs.copyFileSync(filePath, backupPath);
                console.log(`  [清理] ${name}: 清理前已备份到 ${backupPath}`);
            } catch (e) {
                console.log(`  [清理] ${name}: 清理前备份失败，跳过清理（${e.message}）`);
                return;
            }
            data.timestamp = getBeijingISOString();
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
    console.log('=== 论文抓取 + 深度分析（arxiv + HuggingFace Papers）===');
    console.log('');
    autoArchiveCurrentData();
    console.log('');

    // 清理非今日数据（归档后残留的旧数据）
    const today = getBeijingDateString();
    cleanOldData(RESULT_FILE, 'deep-analysis-result', today);
    cleanOldData(FILTERED_FILE, 'filtered-papers', today);
    console.log('');

    // papers.json 自动备份（去重数据库，不归档但需备份防损坏）
    const backupResult = backupPapersJson(PAPERS_FILE, ARCHIVE_DIR);
    console.log(`📦 ${backupResult.message}`);
    console.log('');

    const categories = Config.ARXIV_CATEGORIES;

    const papersData = loadPapersDatabase();
    const existingIds = new Set(Object.entries(papersData.papers)
        .filter(([, paper]) => shouldUsePaperForFetchDedup(paper))
        .map(([id]) => normalizedId(id))
        .filter(Boolean));
    console.log(`已有 ${existingIds.size} 篇论文ID（已规范化），遇到重复将跳过\n`);

    // 加载博客已发布论文 ID，加入去重集合
    const blogRepo = Config.PUBLISH_CONFIG.blogRepo;
    const publishedIds = loadPublishedIdsFromBlog(blogRepo);
    for (const pid of publishedIds) {
        existingIds.add(pid);
    }
    const historicalExistingIds = new Set(existingIds);

    let arxivPapers = [];
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

    const completedFiltered = loadCompleteFilteredForToday(today, FILTERED_FILE, {
        filterModel,
        filterPromptHash,
        requireConsistentFilterArtifacts: true
    });
    if (completedFiltered) {
        console.log('⏭️ 检测到今日完整 filtered-papers.json，跳过抓取与筛选，直接续跑深度分析');
        filteredNew = completedFiltered.papers;
        filtered = completedFiltered.papers;
        const rawCandidates = loadTodayJsonFile(RAW_CANDIDATES_FILE, today);
        const databaseTodayPapers = loadTodayPapersFromDatabase(papersData, today);
        allPapers = Array.isArray(rawCandidates?.papers)
            ? rawCandidates.papers
            : (databaseTodayPapers.length >= filteredNew.length ? databaseTodayPapers : filteredNew);
        allPapersFiltered = allPapers.filter(paper => !publishedIds.has(normalizedId(paper)));
        const existingDecisions = loadReusableFilterDecisions(today, filterModel, filterPromptHash);
        filterDecisions = existingDecisions;
        const stats = completedFiltered.stats || rawCandidates?.stats || {};
        arxivOnly = stats.arxivOnly || allPapers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length;
        hfOnly = stats.hfOnly || allPapers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        both = stats.both || allPapers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
        blogSkippedCount = stats.skippedFromBlog || 0;
        skippedCount = stats.skippedFromArchive || 0;
        baseFilterStats = {
            beforeFilter: stats.beforeFilter || allPapers.length,
            beforeBlogSkip: stats.beforeBlogSkip || allPapers.length,
            afterBlogSkip: stats.afterBlogSkip || allPapersFiltered.length,
            skippedFromBlog: blogSkippedCount,
            arxivOnly,
            hfOnly,
            both
        };
        sourceHealth = rawCandidates?.sourceHealth || completedFiltered.sourceHealth || sourceHealth;
    } else {
        // ========== 第一步：从 arxiv 抓取 ==========
        console.log('📥 第一步：从 arxiv 抓取论文');

        // 核心类别优先，补充类别随机打乱
        const coreCategories = categories.filter(c => c.priority === 'core');
        const supplementCategories = categories.filter(c => c.priority !== 'core');
        for (let i = supplementCategories.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [supplementCategories[i], supplementCategories[j]] = [supplementCategories[j], supplementCategories[i]];
        }
        const shuffledCategories = [...coreCategories, ...supplementCategories];
        console.log(`  请求顺序: ${shuffledCategories.map(c => c.id).join(' → ')}\n`);

        for (let i = 0; i < shuffledCategories.length; i++) {
            const category = shuffledCategories[i];
            // 首次请求前加随机延迟
            if (i === 0) {
                const baseDelay = Config.ARXIV_CONFIG.firstRequestDelayMs;
                const jitter = Math.floor(Math.random() * 10000);
                const firstDelay = baseDelay + jitter;
                console.log(`  首次请求前等待 ${(firstDelay/1000).toFixed(1)} 秒...`);
                await new Promise(resolve => setTimeout(resolve, firstDelay));
            }
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
                    existingIds
                );
                categoryFetchHealth = papers._sourceHealth || null;
            } catch (e) {
                fetchError = e;
                categoryFetchHealth = e.sourceHealth || null;
                console.log(`    ⚠️ ${category.id} 抓取失败: ${e.message}`);
            }
            const fetchDuration = Date.now() - fetchStartTime;
            if (fetchError) {
                sourceHealth.arxiv.categories.push({
                    id: category.id,
                    name: category.name,
                    priority: category.priority,
                    fetched: 0,
                    newInCategory: 0,
                    duplicateInCategory: 0,
                    durationMs: fetchDuration,
                    ok: false,
                    error: fetchError.message,
                    attempts: categoryFetchHealth?.attempts || 0,
                    successfulRequests: categoryFetchHealth?.successfulRequests || 0,
                    failures: categoryFetchHealth?.failures || []
                });
            }

            // 去重：将新论文 ID 加入 existingIds，避免下一类别重复抓取
            let newInCategory = 0, dupInCategory = 0;
            for (const p of papers) {
                const id = normalizedId(p.paper_id || p.arxivId);
                if (existingIds.has(id)) {
                    dupInCategory++;
                } else {
                    existingIds.add(id);
                    arxivPapers.push(p);
                    newInCategory++;
                }
            }
            if (!fetchError) {
                sourceHealth.arxiv.categories.push({
                    id: category.id,
                    name: category.name,
                    priority: category.priority,
                    fetched: papers.length,
                    newInCategory,
                    duplicateInCategory: dupInCategory,
                    durationMs: fetchDuration,
                    ok: true,
                    attempts: categoryFetchHealth?.attempts || 0,
                    successfulRequests: categoryFetchHealth?.successfulRequests || 0,
                    failures: categoryFetchHealth?.failures || [],
                    abstractFailures: categoryFetchHealth?.abstracts?.failedIds || []
                });
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
        try {
            hfPapers = await fetchHuggingFacePapers(historicalExistingIds, {
                days: Config.HUGGINGFACE_CONFIG.defaultDays,
                minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes
            });
            sourceHealth.huggingface = {
                ...(hfPapers._sourceHealth || {}),
                ok: true,
                fetched: hfPapers.length,
                days: Config.HUGGINGFACE_CONFIG.defaultDays,
                minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
                durationMs: Date.now() - hfStartTime
            };
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
            console.log(`  ⚠️ HuggingFace Papers 抓取失败: ${e.message}`);
        }

        console.log(`\nHuggingFace Papers 抓取完成: ${hfPapers.length} 篇`);

        // ========== 第三步：合并去重 ==========
        console.log('\n🔄 第三步：合并去重（arxiv + HuggingFace）');
        allPapers = mergeAndDeduplicate(arxivPapers, hfPapers);
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

        writeFileAtomic(RAW_CANDIDATES_FILE, JSON.stringify({
            timestamp: getBeijingISOString(),
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
        filterDecisions = loadReusableFilterDecisions(today, filterModel, filterPromptHash);
        baseFilterStats = {
            beforeFilter: allPapers.length,
            beforeBlogSkip: allPapers.length,
            afterBlogSkip: allPapersFiltered.length,
            skippedFromBlog: blogSkippedCount,
            arxivOnly,
            hfOnly,
            both
        };
        let retryableFilterDecisions = {};
        filtered = await filterPapersWithLLM(allPapersFiltered, {
            batchSize: Config.FILTER_CONFIG.batchSize,
            delayBetweenBatches: Config.FILTER_CONFIG.delayBetweenBatchesMs,
            useKeywordPreFilter: false,
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
            timestamp: getBeijingISOString(),
            status: 'complete',
            filterModel,
            filterPromptHash,
            stats: {
                ...baseFilterStats,
                afterBlogSkip: allPapersFiltered.length,
                afterFilter: filtered.length,
                afterArchiveSkip: filteredNew.length,
                skippedFromArchive: skippedCount,
                decisionCount: Object.keys(filterDecisions).length
            },
            sourceHealth,
            papers: filteredNew
        }, null, 2));
        console.log(`💾 筛选结果已保存到: ${FILTERED_FILE}`);
    }

    const outputFile = fs.existsSync(RESULT_FILE) || !fs.existsSync(LEGACY_RESULT_FILE) ? RESULT_FILE : LEGACY_RESULT_FILE;
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
    const papersToAnalyze = filteredNew.filter(paper => !successfulAnalysisIds.has(normalizedId(paper)));
    const skippedAlreadyAnalyzed = filteredNew.length - papersToAnalyze.length;
    if (skippedAlreadyAnalyzed > 0) {
        console.log(`  ⏭️ 跳过 ${skippedAlreadyAnalyzed} 篇已有成功分析的论文，仅续跑剩余 ${papersToAnalyze.length} 篇`);
    }
    const analyzedPapers = [];

    const { stats: analysisStats } = await analyzeBatch(papersToAnalyze, {
        concurrency: ANALYSIS_CONCURRENCY,
        maxRetries: ANALYSIS_RETRY_MAX,
        retryDelayMs: ANALYSIS_RETRY_DELAY_MS,
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

            // 收集成功结果到 analyzedPapers
            for (const r of batchResults) {
                if (r.success && r.result) {
                    analyzedPapers.push(r.result);
                } else if (!r.skipped) {
                    analyzedPapers.push(r.result || r);
                }
            }

            const snapshot = analyzedPapers.slice();
            const { totalMerged } = await mergeAndSaveResults(snapshot, outputFile, {
                timestamp: getBeijingISOString(),
                status: 'running',
                stats: {
                    afterFilter: filteredNew.length,
                    newlyAnalyzed: snapshot.filter(isSuccessfulAnalysisRecord).length
                }
            });
            const { updated: statusUpdated } = updateAnalysisDigestStatuses(snapshot, { batchDate: today });
            const statusNote = statusUpdated > 0 ? `，papers.json 状态 ${statusUpdated} 篇` : '';
            console.log(`  💾 增量保存: ${snapshot.filter(isSuccessfulAnalysisRecord).length}/${snapshot.length} 篇已分析完成 (合并后 ${totalMerged} 篇${statusNote})`);
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
        result = saveFinalAnalysisResults(outputFile, analyzedPapers, filteredNew, {
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

    const { updated: statusUpdated } = updateAnalysisDigestStatuses(analyzedPapers, { batchDate: today });
    if (statusUpdated > 0) {
        console.log(`  已更新 papers.json 分析状态: ${statusUpdated} 篇`);
    }

    const finalStatus = result.stats.analysisStatus;
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

    return { ...result, exitCode: getAnalysisExitCode(finalStatus) };
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
    cleanOldData,
    shouldUsePaperForFetchDedup,
    markPaperDigestStatus,
    getFilterPromptHash,
    isDefinitiveFilterDecision,
    validateFilterDecisionCoverage,
    validateFilterArtifacts,
    loadReusableFilterDecisions,
    buildSourceHealth,
    getSourceFetchedCount,
    getSourceFailures,
    hasRequiredSourceFailure,
    getFatalEmptyCandidateSourceFailures,
    loadCompleteFilteredForToday,
    loadCurrentSuccessfulAnalysisIds,
    loadAnalyzedIdsFromArchive,
    loadTodayPapersFromDatabase,
    saveFinalAnalysisResults
};
