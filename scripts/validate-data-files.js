#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { readJsonSafe, normalizedId } = require('./utils.js');

const ALLOWED_DIGEST_STATUSES = new Set(['seen', 'pending_analysis', 'analyzed', 'analysis_failed']);
const ALLOWED_FILTERED_STATUSES = new Set(['filtering', 'filter_complete', 'complete']);
const DEFAULT_FILTER_DECISIONS_FILE = Config.FILES.filterDecisions;

function addIssue(issues, file, message) {
    issues.push(`${path.basename(file)}: ${message}`);
}

function ensurePaperId(paper, file, index, issues) {
    const id = normalizedId(paper);
    if (!id) {
        addIssue(issues, file, `papers[${index}] 缺少可识别的 arxivId/paper_id`);
    }
    return id;
}

function validatePapersDatabase(filePath = Config.FILES.papers) {
    const issues = [];
    if (!filePath || !fs.existsSync(filePath)) return issues;

    const data = readJsonSafe(filePath, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        addIssue(issues, filePath, '根对象必须是 { papers, lastUpdated }');
        return issues;
    }
    if (!data.papers || typeof data.papers !== 'object' || Array.isArray(data.papers)) {
        addIssue(issues, filePath, 'papers 必须是对象映射');
        return issues;
    }

    for (const [key, paper] of Object.entries(data.papers)) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `${key} 不是论文对象`);
            continue;
        }
        const id = normalizedId(paper) || normalizedId(key);
        if (!id) addIssue(issues, filePath, `${key} 缺少可识别 ID`);
        const status = paper.digestStatus?.status;
        if (status && !ALLOWED_DIGEST_STATUSES.has(status)) {
            addIssue(issues, filePath, `${key} digestStatus.status 非法: ${status}`);
        }
    }
    return issues;
}

function validateSourceHealth(filePath, sourceHealth, issues) {
    if (!sourceHealth || typeof sourceHealth !== 'object') return;
    const categories = sourceHealth.arxiv?.categories;
    if (categories !== undefined && !Array.isArray(categories)) {
        addIssue(issues, filePath, 'sourceHealth.arxiv.categories 必须是数组');
    }
    const hfOk = sourceHealth.huggingface?.ok;
    if (hfOk !== undefined && typeof hfOk !== 'boolean') {
        addIssue(issues, filePath, 'sourceHealth.huggingface.ok 必须是布尔值');
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNonNegativeInteger(filePath, fieldName, value, issues) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        addIssue(issues, filePath, `${fieldName} 必须是非负整数`);
    }
}

function validateFilteredMetadata(filePath, data, papers, issues) {
    if (Array.isArray(data)) return;

    if (data.status === undefined) {
        addIssue(issues, filePath, 'status 必须存在，且为 filtering/filter_complete/complete');
    } else if (!ALLOWED_FILTERED_STATUSES.has(data.status)) {
        addIssue(issues, filePath, `status 非法: ${data.status}`);
    }

    for (const field of ['filterModel', 'filterPromptHash']) {
        if (data[field] === undefined || data[field] === '') {
            addIssue(issues, filePath, `${field} 必须存在，用于判断筛选结果是否可安全复用`);
        } else if (typeof data[field] !== 'string') {
            addIssue(issues, filePath, `${field} 必须是字符串`);
        }
    }

    if (data.stats !== undefined && !isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'stats 必须是对象');
        return;
    }

    const stats = data.stats || {};
    validateNonNegativeInteger(filePath, 'stats.decisionCount', stats.decisionCount, issues);
    validateNonNegativeInteger(filePath, 'stats.afterFilter', stats.afterFilter, issues);
    validateNonNegativeInteger(filePath, 'stats.afterArchiveSkip', stats.afterArchiveSkip, issues);

    if (data.status === 'complete') {
        if (stats.decisionCount === undefined) {
            addIssue(issues, filePath, 'complete 状态必须包含 stats.decisionCount');
        } else if (stats.decisionCount < papers.length) {
            addIssue(issues, filePath, 'stats.decisionCount 不能小于最终 papers 数量');
        }

        if (stats.afterArchiveSkip === undefined) {
            addIssue(issues, filePath, 'complete 状态必须包含 stats.afterArchiveSkip');
        } else if (stats.afterArchiveSkip !== papers.length) {
            addIssue(issues, filePath, `stats.afterArchiveSkip (${stats.afterArchiveSkip}) 必须等于 papers 数量 (${papers.length})`);
        }
    }
}

function validateDeepAnalysisMetadata(filePath, data, papers, issues) {
    if (Array.isArray(data) || data.stats === undefined) return;
    if (!isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'stats 必须是对象');
        return;
    }

    const stats = data.stats;
    for (const field of ['arxivFetched', 'hfFetched', 'totalMerged', 'afterFilter', 'newlyAnalyzed', 'preservedExisting', 'totalAfterMerge']) {
        validateNonNegativeInteger(filePath, `stats.${field}`, stats[field], issues);
    }
    if (Number.isInteger(stats.totalAfterMerge) && stats.totalAfterMerge !== papers.length) {
        addIssue(issues, filePath, `stats.totalAfterMerge (${stats.totalAfterMerge}) 必须等于 papers 数量 (${papers.length})`);
    }
}

function validateRawCandidateMetadata(filePath, data, papers, issues) {
    if (Array.isArray(data)) return;

    if (!isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'raw-candidates stats 必须是对象');
        return;
    }

    const stats = data.stats;
    for (const field of ['beforeBlogSkip', 'afterBlogSkip', 'skippedFromBlog', 'arxivOnly', 'hfOnly', 'both']) {
        if (stats[field] === undefined) {
            addIssue(issues, filePath, `stats.${field} 必须存在且为非负整数`);
        } else {
            validateNonNegativeInteger(filePath, `stats.${field}`, stats[field], issues);
        }
    }

    const expectedAfterBlogSkip = stats.afterBlogSkip;
    if (Number.isInteger(expectedAfterBlogSkip) && expectedAfterBlogSkip !== papers.length) {
        addIssue(issues, filePath, `stats.afterBlogSkip (${expectedAfterBlogSkip}) 必须等于 papers 数量 (${papers.length})`);
    }

    if (Number.isInteger(stats.beforeBlogSkip) && Number.isInteger(stats.afterBlogSkip)) {
        if (stats.beforeBlogSkip < stats.afterBlogSkip) {
            addIssue(issues, filePath, 'stats.beforeBlogSkip 不能小于 stats.afterBlogSkip');
        }
        if (Number.isInteger(stats.skippedFromBlog) && stats.skippedFromBlog !== stats.beforeBlogSkip - stats.afterBlogSkip) {
            addIssue(issues, filePath, `stats.skippedFromBlog (${stats.skippedFromBlog}) 必须等于 beforeBlogSkip-afterBlogSkip (${stats.beforeBlogSkip - stats.afterBlogSkip})`);
        }
    }

    if ([stats.arxivOnly, stats.hfOnly, stats.both, stats.beforeBlogSkip].every(Number.isInteger)) {
        const sourceTotal = stats.arxivOnly + stats.hfOnly + stats.both;
        if (sourceTotal !== stats.beforeBlogSkip) {
            addIssue(issues, filePath, `stats.arxivOnly+hfOnly+both (${sourceTotal}) 必须等于 stats.beforeBlogSkip (${stats.beforeBlogSkip})`);
        }
    }
}

function validatePaperListFile(filePath, options = {}) {
    const issues = [];
    if (!filePath || !fs.existsSync(filePath)) return issues;

    const data = readJsonSafe(filePath, null);
    if (!data) {
        addIssue(issues, filePath, 'JSON 无法解析');
        return issues;
    }

    if (options.rawCandidates && Array.isArray(data)) {
        addIssue(issues, filePath, 'raw-candidates 根对象必须是 { stats, sourceHealth, papers }');
    }

    const papers = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(papers)) {
        addIssue(issues, filePath, 'papers 必须是数组');
        return issues;
    }

    if (!Array.isArray(data)) {
        validateSourceHealth(filePath, data.sourceHealth || data.stats?.sourceHealth, issues);
        if (options.rawCandidates) {
            validateRawCandidateMetadata(filePath, data, papers, issues);
        }
        if (options.filtered) {
            validateFilteredMetadata(filePath, data, papers, issues);
        }
        if (options.deepAnalysis) {
            validateDeepAnalysisMetadata(filePath, data, papers, issues);
        }
    }

    papers.forEach((paper, index) => {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `papers[${index}] 不是论文对象`);
            return;
        }
        ensurePaperId(paper, filePath, index, issues);
        if (options.deepAnalysis) {
            if (paper.parsed?.score !== undefined) {
                const score = Number(paper.parsed.score);
                if (!Number.isFinite(score) || score < 0 || score > 10) {
                    addIssue(issues, filePath, `papers[${index}] parsed.score 非法: ${paper.parsed.score}`);
                }
            }
            for (const key of ['selectedImageUrls', 'imageUrls', 'allImageUrls']) {
                if (paper[key] !== undefined && !Array.isArray(paper[key])) {
                    addIssue(issues, filePath, `papers[${index}].${key} 必须是数组`);
                }
            }
            if (paper.imageManifest !== undefined && paper.imageManifest !== null && typeof paper.imageManifest !== 'object') {
                addIssue(issues, filePath, `papers[${index}].imageManifest 必须是对象或 null`);
            }
        }
    });

    return issues;
}

function validateFilterDecisionsFile(filePath = DEFAULT_FILTER_DECISIONS_FILE) {
    const issues = [];
    if (!filePath || !fs.existsSync(filePath)) return issues;

    const data = readJsonSafe(filePath, null);
    if (!isPlainObject(data)) {
        addIssue(issues, filePath, '根对象必须是 { decisions, stats }');
        return issues;
    }

    if (data.stats !== undefined && !isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'stats 必须是对象');
    }

    if (!isPlainObject(data.decisions)) {
        addIssue(issues, filePath, 'decisions 必须是对象映射');
        return issues;
    }

    const entries = Object.entries(data.decisions);
    let relatedCount = 0;
    for (const [key, decision] of entries) {
        if (!isPlainObject(decision)) {
            addIssue(issues, filePath, `decisions.${key} 不是对象`);
            continue;
        }

        const id = normalizedId(decision) || normalizedId(key);
        if (!id) {
            addIssue(issues, filePath, `decisions.${key} 缺少可识别 ID`);
        }

        if (typeof decision.related !== 'boolean') {
            addIssue(issues, filePath, `decisions.${key}.related 必须是布尔值`);
        } else if (decision.related) {
            relatedCount += 1;
        }

        for (const field of ['reason', 'rawResponse', 'parseSource', 'decidedAt', 'filterModel', 'filterPromptHash']) {
            if (decision[field] !== undefined && typeof decision[field] !== 'string') {
                addIssue(issues, filePath, `decisions.${key}.${field} 必须是字符串`);
            }
        }
    }

    const stats = isPlainObject(data.stats) ? data.stats : {};
    validateNonNegativeInteger(filePath, 'stats.totalCandidates', stats.totalCandidates, issues);
    validateNonNegativeInteger(filePath, 'stats.decided', stats.decided, issues);
    validateNonNegativeInteger(filePath, 'stats.related', stats.related, issues);
    if (stats.complete !== undefined && typeof stats.complete !== 'boolean') {
        addIssue(issues, filePath, 'stats.complete 必须是布尔值');
    }
    if (stats.decided !== undefined && stats.decided !== entries.length) {
        addIssue(issues, filePath, `stats.decided (${stats.decided}) 必须等于 decisions 数量 (${entries.length})`);
    }
    if (stats.related !== undefined && stats.related !== relatedCount) {
        addIssue(issues, filePath, `stats.related (${stats.related}) 必须等于 related=true 数量 (${relatedCount})`);
    }

    return issues;
}

function resolveFilterDecisionsPath(files = Config.FILES) {
    if (files.filterDecisions) return files.filterDecisions;
    if (files.filteredPapers) return path.join(path.dirname(files.filteredPapers), 'filter-decisions.json');
    return DEFAULT_FILTER_DECISIONS_FILE;
}

function validateFilterArtifactsConsistency(filteredPath, decisionsPath) {
    const issues = [];
    if (!filteredPath || !decisionsPath) return issues;
    if (!fs.existsSync(filteredPath) || !fs.existsSync(decisionsPath)) return issues;

    const filtered = readJsonSafe(filteredPath, null);
    const decisionData = readJsonSafe(decisionsPath, null);
    if (!isPlainObject(filtered) || !isPlainObject(decisionData) || !isPlainObject(decisionData.decisions)) {
        return issues;
    }

    const papers = Array.isArray(filtered.papers) ? filtered.papers : null;
    const stats = isPlainObject(filtered.stats) ? filtered.stats : {};
    const decisions = Object.values(decisionData.decisions).filter(isPlainObject);
    const decisionCount = Object.keys(decisionData.decisions).length;
    const relatedCount = decisions.filter(decision => decision.related === true).length;

    if (stats.decisionCount !== undefined && Number.isInteger(stats.decisionCount) && stats.decisionCount !== decisionCount) {
        addIssue(issues, filteredPath, `stats.decisionCount (${stats.decisionCount}) 必须等于 filter-decisions.json decisions 数量 (${decisionCount})`);
    }
    if (stats.afterFilter !== undefined && Number.isInteger(stats.afterFilter) && stats.afterFilter !== relatedCount) {
        addIssue(issues, filteredPath, `stats.afterFilter (${stats.afterFilter}) 必须等于 filter-decisions.json related=true 数量 (${relatedCount})`);
    }
    if (filtered.status === 'complete' && papers && stats.afterArchiveSkip !== undefined && Number.isInteger(stats.afterArchiveSkip) && stats.afterArchiveSkip !== papers.length) {
        addIssue(issues, filteredPath, `stats.afterArchiveSkip (${stats.afterArchiveSkip}) 必须等于最终 papers 数量 (${papers.length})`);
    }

    return issues;
}

function validateRequiredCompanionFiles(files, filterDecisions) {
    const issues = [];
    if (!files.filteredPapers || !fs.existsSync(files.filteredPapers)) return issues;

    const filtered = readJsonSafe(files.filteredPapers, null);
    if (!isPlainObject(filtered)) return issues;
    const stats = isPlainObject(filtered.stats) ? filtered.stats : {};
    if (stats.decisionCount !== undefined && !fs.existsSync(filterDecisions)) {
        addIssue(issues, filterDecisions, '有 filtered-papers.json stats.decisionCount，但 filter-decisions.json 缺失，无法校验逐篇筛选决策');
    }
    return issues;
}

function validateCurrentDataFiles(files = Config.FILES) {
    const filterDecisions = resolveFilterDecisionsPath(files);
    return [
        ...validatePapersDatabase(files.papers),
        ...validatePaperListFile(files.rawCandidates, { rawCandidates: true }),
        ...validateFilterDecisionsFile(filterDecisions),
        ...validatePaperListFile(files.filteredPapers, { filtered: true }),
        ...validatePaperListFile(files.deepAnalysisResult, { deepAnalysis: true }),
        ...validateFilterArtifactsConsistency(files.filteredPapers, filterDecisions),
        ...validateRequiredCompanionFiles(files, filterDecisions)
    ];
}

function main() {
    const issues = validateCurrentDataFiles();
    if (issues.length > 0) {
        console.error('数据文件校验失败:');
        for (const issue of issues) {
            console.error(`  - ${issue}`);
        }
        process.exit(1);
    }
    console.log('数据文件校验通过');
}

if (require.main === module) {
    main();
}

module.exports = {
    validatePapersDatabase,
    validatePaperListFile,
    validateFilterDecisionsFile,
    validateCurrentDataFiles,
    validateSourceHealth
};
