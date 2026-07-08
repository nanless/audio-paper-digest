const Config = require('./config.js');
const { getBeijingISOString, readJsonSafe, writeFileAtomic, normalizedId } = require('./utils.js');

function loadPapersDatabase(filePath = Config.FILES.papers, legacyPath = Config.FILES.papersLegacy) {
    const data = readJsonSafe(filePath, null)
        || readJsonSafe(legacyPath, null)
        || { papers: {}, lastUpdated: null };
    if (Array.isArray(data)) {
        const papers = {};
        for (const paper of data) {
            const key = normalizedId(paper);
            if (key) papers[key] = paper;
        }
        return { papers, lastUpdated: null };
    }
    if (!data.papers || typeof data.papers !== 'object') {
        data.papers = {};
    }
    return data;
}

function savePapersDatabase(data, filePath = Config.FILES.papers) {
    data.lastUpdated = getBeijingISOString();
    writeFileAtomic(filePath, JSON.stringify(data, null, 2));
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

function applyAnalysisDigestStatuses(papersData, analyzedPapers, options = {}) {
    const now = options.updatedAt || getBeijingISOString();
    const batchDate = options.batchDate || now.slice(0, 10);
    let updated = 0;

    for (const paper of analyzedPapers || []) {
        const key = normalizedId(paper);
        if (!key) continue;
        const existing = papersData.papers[key] || {};
        const status = paper.analysis ? 'analyzed' : 'analysis_failed';
        papersData.papers[key] = markPaperDigestStatus(
            { ...existing, ...paper },
            status,
            {
                batchDate,
                updatedAt: now,
                error: paper.error || null
            }
        );
        updated++;
    }

    return updated;
}

function updateAnalysisDigestStatuses(analyzedPapers, options = {}) {
    const papersData = loadPapersDatabase(options.filePath, options.legacyPath);
    const updated = applyAnalysisDigestStatuses(papersData, analyzedPapers, options);
    if (updated > 0) {
        savePapersDatabase(papersData, options.filePath);
    }
    return { updated, papersData };
}

module.exports = {
    loadPapersDatabase,
    savePapersDatabase,
    markPaperDigestStatus,
    applyAnalysisDigestStatuses,
    updateAnalysisDigestStatuses
};
