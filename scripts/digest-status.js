const Config = require('./config.js');
const fs = require('fs');
const { getBeijingISOString, writeFileAtomic, normalizedId } = require('./utils.js');
const { readJsonFileStrict, withFileLockSync, isSuccessfulAnalysisRecord } = require('./analysis-engine.js');

const ANALYSIS_FIELDS = Object.freeze([
    'analysis',
    'parsed',
    'scoringRubricVersion',
    'selectedImageUrls',
    'imageUrls',
    'allImageUrls',
    'imageManifest',
    'analysisManifest',
    'analysisSource',
    'sourceId',
    'sourceTextChars',
    'usedTextChars',
    'fullTextChars',
    'fullTextAvailable',
    'truncated',
    'sourceSha256',
    'usedTextSha256',
    'analysisConfidence',
    'htmlAvailability',
    'htmlAttempts',
    'sourceWarnings'
]);

function paperVersion(record, rawKey = '') {
    const rawId = record?.arxivId || record?.paper_id || rawKey;
    const match = String(rawId || '').match(/v(\d+)$/i);
    return match ? Number(match[1]) : 0;
}

function mergeVersionedPaperRecords(existing, incoming, existingRawKey, incomingRawKey) {
    const incomingIsNewer = paperVersion(incoming, incomingRawKey) >= paperVersion(existing, existingRawKey);
    const older = incomingIsNewer ? existing : incoming;
    const newer = incomingIsNewer ? incoming : existing;
    const merged = mergeAnalysisDigestPaper(older, newer);
    if (older.digestStatus?.updatedAt > newer.digestStatus?.updatedAt) {
        merged.digestStatus = older.digestStatus;
    }
    if (Array.isArray(older.sources) || Array.isArray(newer.sources)) {
        merged.sources = [...new Set([...(older.sources || []), ...(newer.sources || [])])];
    }
    return merged;
}

function normalizePapersMap(rawPapers, options = {}) {
    const strict = options.strict === true;
    if (rawPapers != null && !Array.isArray(rawPapers) && (typeof rawPapers !== 'object')) {
        throw new Error('papers.json 的 papers 必须是对象或数组');
    }
    if (strict && (Array.isArray(rawPapers) || rawPapers === null || typeof rawPapers !== 'object')) {
        throw new Error('papers.json 的 papers 必须是对象');
    }
    const papers = {};
    const rawKeys = {};
    const entries = Array.isArray(rawPapers)
        ? rawPapers.map(paper => [normalizedId(paper), paper])
        : Object.entries(rawPapers || {});
    for (const [rawKey, paper] of entries) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            if (strict) throw new Error(`papers.json 论文条目必须是对象: ${rawKey || '(空 key)'}`);
            continue;
        }
        const paperKey = normalizedId(paper);
        const objectKey = normalizedId(rawKey);
        if (paperKey && objectKey && paperKey !== objectKey) {
            throw new Error(`papers.json key 与论文版本 ID 冲突: ${rawKey} -> ${paperKey}`);
        }
        const key = paperKey || objectKey;
        if (!key) {
            if (strict) throw new Error(`papers.json 论文条目缺少有效 ID: ${rawKey || '(空 key)'}`);
            continue;
        }
        if (papers[key]) {
            papers[key] = mergeVersionedPaperRecords(papers[key], paper, rawKeys[key], rawKey);
            rawKeys[key] = paperVersion(paper, rawKey) >= paperVersion(papers[key], rawKeys[key])
                ? rawKey
                : rawKeys[key];
            continue;
        }
        papers[key] = paper;
        rawKeys[key] = rawKey;
    }
    return papers;
}

function normalizePapersDatabase(data) {
    if (Array.isArray(data)) return { papers: normalizePapersMap(data), lastUpdated: null, generation: 0 };
    const normalized = data && typeof data === 'object' ? { ...data } : { papers: {}, lastUpdated: null };
    normalized.papers = normalizePapersMap(normalized.papers);
    normalized.generation = Number.isInteger(normalized.generation) ? normalized.generation : 0;
    return normalized;
}

function validatePapersDatabaseSchema(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('papers.json 顶层必须是对象');
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'papers')) {
        throw new Error('papers.json 顶层缺少 papers 字段');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'generation')
        && (!Number.isInteger(data.generation) || data.generation < 0)) {
        throw new Error('papers.json generation 必须是非负整数');
    }
    return {
        ...data,
        papers: normalizePapersMap(data.papers, { strict: true }),
        generation: data.generation || 0
    };
}

function loadPapersDatabase(filePath = Config.FILES.papers, legacyPath = Config.FILES.papersLegacy) {
    let data = readJsonFileStrict(filePath, { allowMissing: true });
    if (data === null && legacyPath && fs.existsSync(legacyPath)) {
        data = readJsonFileStrict(legacyPath);
    }
    return normalizePapersDatabase(data || { papers: {}, lastUpdated: null });
}

function preserveAnalysisFields(target, source) {
    for (const field of ANALYSIS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = source[field];
        else delete target[field];
    }
}

function mergePapersDatabases(currentData, incomingData) {
    const current = normalizePapersDatabase(currentData || { papers: {} });
    const incoming = normalizePapersDatabase(incomingData || { papers: {} });
    const merged = {
        ...current,
        ...incoming,
        generation: Math.max(current.generation, incoming.generation),
        papers: { ...current.papers }
    };

    for (const [key, incomingPaper] of Object.entries(incoming.papers)) {
        const currentPaper = current.papers[key];
        if (!currentPaper) {
            merged.papers[key] = incomingPaper;
            continue;
        }

        const nextPaper = mergeAnalysisDigestPaper(currentPaper, incomingPaper);
        const currentUpdatedAt = currentPaper.digestStatus?.updatedAt || '';
        const incomingUpdatedAt = incomingPaper.digestStatus?.updatedAt || '';
        const wouldDowngradeAnalyzed = currentPaper.digestStatus?.status === 'analyzed'
            && ['pending_analysis', 'seen'].includes(incomingPaper.digestStatus?.status);
        if (wouldDowngradeAnalyzed || currentUpdatedAt > incomingUpdatedAt) {
            nextPaper.digestStatus = currentPaper.digestStatus;
            if (isSuccessfulAnalysisRecord(currentPaper)) preserveAnalysisFields(nextPaper, currentPaper);
        }
        merged.papers[key] = nextPaper;
    }
    return merged;
}

function savePapersDatabase(data, filePath = Config.FILES.papers) {
    return withFileLockSync(filePath, () => {
        const currentRaw = readJsonFileStrict(filePath, { allowMissing: true });
        const current = currentRaw === null ? normalizePapersDatabase({ papers: {} }) : normalizePapersDatabase(currentRaw);
        const saved = mergePapersDatabases(current, data);
        saved.lastUpdated = getBeijingISOString();
        saved.generation = current.generation + 1;
        writeFileAtomic(filePath, JSON.stringify(saved, null, 2));
        Object.assign(data, saved);
        return saved;
    });
}

function markPaperDigestStatus(paper, status, extra = {}) {
    const updatedAt = extra.updatedAt || getBeijingISOString();
    return {
        ...paper,
        digestStatus: {
            ...(paper.digestStatus || {}),
            status,
            updatedAt,
            ...extra
        }
    };
}

function mergeAnalysisDigestPaper(existing, paper) {
    const merged = { ...existing, ...paper };
    if (isSuccessfulAnalysisRecord(existing) && !isSuccessfulAnalysisRecord(paper)) {
        if (paper.imageManifest) merged.analysisRecoveryImageManifest = paper.imageManifest;
        preserveAnalysisFields(merged, existing);
    } else if (isSuccessfulAnalysisRecord(paper)) {
        delete merged.analysisRecoveryImageManifest;
        delete merged.analysisCheckpoint;
        delete merged.analysisStageCheckpoints;
        delete merged.latestAnalysisAttemptError;
        delete merged.latestAnalysisAttemptAt;
    }
    return merged;
}

function applyAnalysisDigestStatuses(papersData, analyzedPapers, options = {}) {
    const now = options.updatedAt || getBeijingISOString();
    const batchDate = options.batchDate || now.slice(0, 10);
    let updated = 0;

    for (const paper of analyzedPapers || []) {
        const key = normalizedId(paper);
        if (!key) continue;
        const existing = papersData.papers[key] || {};
        const hadUsableAnalysis = isSuccessfulAnalysisRecord(existing);
        const mergedPaper = mergeAnalysisDigestPaper(existing, paper);
        const latestAttemptStatus = isSuccessfulAnalysisRecord(paper) ? 'analyzed' : 'analysis_failed';
        const status = (isSuccessfulAnalysisRecord(paper) || hadUsableAnalysis) ? 'analyzed' : 'analysis_failed';
        papersData.papers[key] = markPaperDigestStatus(
            mergedPaper,
            status,
            {
                batchDate,
                updatedAt: now,
                latestAttemptStatus,
                error: paper.error || null
            }
        );
        updated++;
    }

    return updated;
}

function updateAnalysisDigestStatuses(analyzedPapers, options = {}) {
    const filePath = options.filePath || Config.FILES.papers;
    return withFileLockSync(filePath, () => {
        let raw = readJsonFileStrict(filePath, { allowMissing: true });
        if (raw === null && options.legacyPath && fs.existsSync(options.legacyPath)) {
            raw = readJsonFileStrict(options.legacyPath);
        } else if (raw === null && !options.filePath && fs.existsSync(Config.FILES.papersLegacy)) {
            raw = readJsonFileStrict(Config.FILES.papersLegacy);
        }
        const papersData = normalizePapersDatabase(raw || { papers: {}, lastUpdated: null });
        const updated = applyAnalysisDigestStatuses(papersData, analyzedPapers, options);
        if (updated > 0) {
            papersData.lastUpdated = options.updatedAt || getBeijingISOString();
            papersData.generation = (papersData.generation || 0) + 1;
            writeFileAtomic(filePath, JSON.stringify(papersData, null, 2));
        }
        return { updated, papersData };
    });
}

module.exports = {
    loadPapersDatabase,
    normalizePapersMap,
    normalizePapersDatabase,
    validatePapersDatabaseSchema,
    mergePapersDatabases,
    savePapersDatabase,
    markPaperDigestStatus,
    mergeAnalysisDigestPaper,
    applyAnalysisDigestStatuses,
    updateAnalysisDigestStatuses
};
