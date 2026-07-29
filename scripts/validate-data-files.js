#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { buildFilterInputSha256 } = require('./lib/filter-input-contract.js');
const { KEYWORD_PREFILTER_VERSION } = require('./lib/keyword-prefilter.js');
const {
    readJsonSafe,
    normalizedId,
    DOCUMENT_TYPES,
    SCORING_RUBRIC_VERSION,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS
} = require('./utils.js');

const ALLOWED_DIGEST_STATUSES = new Set(['seen', 'pending_analysis', 'analyzed', 'analysis_failed']);
const ALLOWED_ANALYSIS_ATTEMPT_STATUSES = new Set(['analyzed', 'analysis_failed']);
const ALLOWED_FILTERED_STATUSES = new Set(['filtering', 'filter_complete', 'complete', 'source_partial_failed']);
const ALLOWED_RECOVERY_STAGE_STATUSES = new Set([
    'pending', 'complete', 'not_needed', 'skipped', 'no_candidates',
    'no_high_value_images', 'no_downloadable_images', 'transient_failure', 'invalid_output', 'contract_rejected'
]);
const DEFAULT_FILTER_DECISIONS_FILE = Config.FILES.filterDecisions;
const DEFAULT_FETCH_CHECKPOINT_FILE = Config.FILES.fetchCheckpoint;
const ALLOWED_DOCUMENT_TYPES = new Set(DOCUMENT_TYPES);
const SCORE_DIMENSIONS = Object.freeze({
    innovationScore: 2,
    technicalRigorScore: 1.5,
    experimentalSufficiencyScore: 1.5,
    clarityScore: 1,
    impactScore: 1.5,
    openSourceScore: 1.5,
    reproducibilityScore: 0.5,
    engineeringScore: 1.5
});
const FINGERPRINT_RE = /^[a-f0-9]{16}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BEIJING_ISO_RE = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;

function addIssue(issues, file, message) {
    issues.push(`${path.basename(file)}: ${message}`);
}

function numericScore(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && Number.isInteger(value * 10) ? value : Number.NaN;
    }
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d)?$/.test(value.trim())) return Number.NaN;
    return Number(value);
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

function getBeijingBatchDate(timestamp) {
    if (typeof timestamp !== 'string') return null;
    const match = timestamp.match(BEIJING_ISO_RE);
    if (!match || Number.isNaN(Date.parse(timestamp))) return null;
    const [year, month, day] = match[1].split('-').map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year
            || calendarDate.getUTCMonth() !== month - 1
            || calendarDate.getUTCDate() !== day) return null;
    return match[1];
}

function validateBeijingTimestamp(filePath, timestamp, issues) {
    if (!getBeijingBatchDate(timestamp)) {
        addIssue(issues, filePath, 'timestamp 必须是合法的北京时间 ISO 时间（+08:00）');
    }
}

function validateFingerprint(filePath, field, value, issues) {
    if (typeof value !== 'string' || !FINGERPRINT_RE.test(value)) {
        addIssue(issues, filePath, `${field} 必须是 16 位小写十六进制指纹`);
    }
}

function validateCurrentArtifactMetadata(filePath, data, issues, { filterArtifact = false } = {}) {
    validateBeijingTimestamp(filePath, data.timestamp, issues);
    for (const field of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint']) {
        validateFingerprint(filePath, field, data[field], issues);
    }
    if (filterArtifact) validateFingerprint(filePath, 'filterConfigFingerprint', data.filterConfigFingerprint, issues);
    if (typeof data.batchDate !== 'string' || data.batchDate !== getBeijingBatchDate(data.timestamp)) {
        addIssue(issues, filePath, 'batchDate 必须等于不可变 timestamp 的北京时间日期');
    }
    validateFingerprint(filePath, 'batchId', data.batchId, issues);
    for (const field of ['rawPapersSha256', 'fetchSourcesSha256']) {
        if (typeof data[field] !== 'string' || !SHA256_RE.test(data[field])) addIssue(issues, filePath, `${field} 必须是 SHA-256`);
    }
}

function getFetchSourcesSha256(checkpoint) {
    return stableContentSha256({
        arxiv: Object.fromEntries(Object.entries(checkpoint?.arxiv || {}).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, entry]) => [id, { status: entry?.status, papersCount: entry?.papersCount, papersSha256: entry?.papersSha256 }])),
        huggingface: checkpoint?.huggingface ? { status: checkpoint.huggingface.status, papersCount: checkpoint.huggingface.papersCount, papersSha256: checkpoint.huggingface.papersSha256 } : null
    });
}

function validateFetchSourceIntegrity(filePath, prefix, entry, issues) {
    if (!Array.isArray(entry.papers)) return;
    if (!Number.isInteger(entry.papersCount) || entry.papersCount < 0) {
        addIssue(issues, filePath, `${prefix}.papersCount 必须是非负整数`);
    } else if (entry.papersCount !== entry.papers.length) {
        addIssue(issues, filePath, `${prefix}.papersCount 必须等于 papers 数量`);
    }
    if (typeof entry.papersSha256 !== 'string' || !SHA256_RE.test(entry.papersSha256)) {
        addIssue(issues, filePath, `${prefix}.papersSha256 必须是 SHA-256`);
    } else if (entry.papersSha256 !== stableContentSha256(entry.papers)) {
        addIssue(issues, filePath, `${prefix}.papersSha256 与 papers 内容不一致`);
    }
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
        const latestAttemptStatus = paper.digestStatus?.latestAttemptStatus;
        if (latestAttemptStatus && !ALLOWED_ANALYSIS_ATTEMPT_STATUSES.has(latestAttemptStatus)) {
            addIssue(issues, filePath, `${key} digestStatus.latestAttemptStatus 非法: ${latestAttemptStatus}`);
        }
        const error = paper.digestStatus?.error;
        if (error !== undefined && error !== null && typeof error !== 'string') {
            addIssue(issues, filePath, `${key} digestStatus.error 必须是字符串或 null`);
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

function validateFetchCheckpointFile(filePath = DEFAULT_FETCH_CHECKPOINT_FILE) {
    const issues = [];
    if (!filePath || !fs.existsSync(filePath)) return issues;
    const data = readJsonSafe(filePath, null);
    if (!isPlainObject(data)) {
        addIssue(issues, filePath, '根对象必须是抓取 checkpoint 对象');
        return issues;
    }
    validateBeijingTimestamp(filePath, data.timestamp, issues);
    for (const field of ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint']) {
        validateFingerprint(filePath, field, data[field], issues);
    }
    if (typeof data.batchDate !== 'string' || data.batchDate !== getBeijingBatchDate(data.timestamp)) {
        addIssue(issues, filePath, 'batchDate 必须等于不可变 timestamp 的北京时间日期');
    }
    validateFingerprint(filePath, 'batchId', data.batchId, issues);
    const expectedIds = Config.ARXIV_CATEGORIES.map(category => category.id);
    if (!Array.isArray(data.historicalDedupIds)
            || data.historicalDedupIds.some(id => typeof id !== 'string' || !id)) {
        addIssue(issues, filePath, 'historicalDedupIds 必须是非空字符串数组');
    } else if (new Set(data.historicalDedupIds).size !== data.historicalDedupIds.length) {
        addIssue(issues, filePath, 'historicalDedupIds 不得包含重复 ID');
    }
    if (!Array.isArray(data.categoryOrder)
            || data.categoryOrder.length !== expectedIds.length
            || new Set(data.categoryOrder).size !== expectedIds.length
            || data.categoryOrder.some(id => !expectedIds.includes(id))) {
        addIssue(issues, filePath, 'categoryOrder 必须完整且唯一覆盖当前 arXiv 类别');
    }
    if (!isPlainObject(data.arxiv)) {
        addIssue(issues, filePath, 'arxiv 必须是按类别 ID 索引的对象');
    } else {
        const expectedIdSet = new Set(expectedIds);
        for (const [categoryId, entry] of Object.entries(data.arxiv)) {
            if (!expectedIdSet.has(categoryId)) {
                addIssue(issues, filePath, `arxiv 包含当前配置之外的类别: ${categoryId}`);
            }
            if (!isPlainObject(entry) || !['complete', 'failed'].includes(entry.status)) {
                addIssue(issues, filePath, `arxiv.${categoryId}.status 必须为 complete/failed`);
                continue;
            }
            if (!Array.isArray(entry.papers)) addIssue(issues, filePath, `arxiv.${categoryId}.papers 必须是数组`);
            validateFetchSourceIntegrity(filePath, `arxiv.${categoryId}`, entry, issues);
            if (!isPlainObject(entry.health) || entry.health.id !== categoryId || typeof entry.health.ok !== 'boolean') {
                addIssue(issues, filePath, `arxiv.${categoryId}.health 必须包含匹配 id 和布尔 ok`);
            }
            if (entry.status === 'complete' && entry.health?.ok !== true) {
                addIssue(issues, filePath, `arxiv.${categoryId} complete 时 health.ok 必须为 true`);
            }
            if (entry.status === 'failed' && entry.health?.ok !== false) {
                addIssue(issues, filePath, `arxiv.${categoryId} failed 时 health.ok 必须为 false`);
            }
        }
    }
    if (data.huggingface !== null && data.huggingface !== undefined) {
        const entry = data.huggingface;
        if (!isPlainObject(entry) || !['complete', 'failed'].includes(entry.status)) {
            addIssue(issues, filePath, 'huggingface.status 必须为 complete/failed');
        } else {
            if (!Array.isArray(entry.papers)) addIssue(issues, filePath, 'huggingface.papers 必须是数组');
            validateFetchSourceIntegrity(filePath, 'huggingface', entry, issues);
            if (!isPlainObject(entry.health) || typeof entry.health.ok !== 'boolean') {
                addIssue(issues, filePath, 'huggingface.health 必须包含布尔 ok');
            }
            if (entry.status === 'complete' && entry.health?.ok !== true) {
                addIssue(issues, filePath, 'huggingface complete 时 health.ok 必须为 true');
            }
            if (entry.status === 'failed' && entry.health?.ok !== false) {
                addIssue(issues, filePath, 'huggingface failed 时 health.ok 必须为 false');
            }
        }
    }
    if (data.fetchSourcesSha256 !== getFetchSourcesSha256(data)) {
        addIssue(issues, filePath, 'fetchSourcesSha256 与来源 checkpoint 内容不一致');
    }
    return issues;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNonNegativeInteger(filePath, fieldName, value, issues) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        addIssue(issues, filePath, `${fieldName} 必须是非负整数`);
    }
}

function validateAnalysisManifest(filePath, manifest, paperIndex, issues, analysisCheckpoint) {
    const prefix = `papers[${paperIndex}].analysisManifest`;
    if (!isPlainObject(manifest)) {
        addIssue(issues, filePath, `${prefix} 必须是对象`);
        return;
    }
    if (manifest.version !== 1) addIssue(issues, filePath, `${prefix}.version 必须为 1`);
    if (!isPlainObject(manifest.stages)) {
        addIssue(issues, filePath, `${prefix}.stages 必须是对象`);
        return;
    }
    if (manifest.sourceAcquisition !== undefined) {
        validateAnalysisSourceProvenance(filePath, manifest.sourceAcquisition, `${prefix}.sourceAcquisition`, issues);
    }
    let hasRecoverableFailure = false;
    for (const [stage, state] of Object.entries(manifest.stages)) {
        if (!isPlainObject(state)) {
            addIssue(issues, filePath, `${prefix}.stages.${stage} 必须是对象`);
            continue;
        }
        if (!ALLOWED_RECOVERY_STAGE_STATUSES.has(state.status)) {
            addIssue(issues, filePath, `${prefix}.stages.${stage}.status 非法: ${state.status}`);
        }
        if (['pending', 'transient_failure', 'invalid_output', 'contract_rejected'].includes(state.status)) {
            hasRecoverableFailure = true;
        }
        if (state.updatedAt !== undefined && typeof state.updatedAt !== 'string') {
            addIssue(issues, filePath, `${prefix}.stages.${stage}.updatedAt 必须是字符串`);
        }
        if (state.error !== undefined && typeof state.error !== 'string') {
            addIssue(issues, filePath, `${prefix}.stages.${stage}.error 必须是字符串`);
        }
    }
    if (hasRecoverableFailure && typeof analysisCheckpoint !== 'string') {
        addIssue(issues, filePath, `${prefix} 存在可恢复失败阶段但缺少 analysisCheckpoint`);
    }
}

function validateAnalysisSourceProvenance(filePath, source, prefix, issues) {
    if (!isPlainObject(source)) {
        addIssue(issues, filePath, `${prefix} 必须是对象`);
        return;
    }
    const allowedSources = new Set(['html', 'pdf', 'provided_full_text', 'provided_pdf_text', 'abstract']);
    if (!allowedSources.has(source.analysisSource)) {
        addIssue(issues, filePath, `${prefix}.analysisSource 非法: ${source.analysisSource}`);
    }
    for (const key of ['sourceTextChars', 'usedTextChars', 'fullTextChars', 'htmlAttempts']) {
        validateNonNegativeInteger(filePath, `${prefix}.${key}`, source[key], issues);
    }
    for (const key of ['fullTextAvailable', 'truncated']) {
        if (source[key] !== undefined && typeof source[key] !== 'boolean') {
            addIssue(issues, filePath, `${prefix}.${key} 必须是布尔值`);
        }
    }
    if (source.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(source.sourceSha256))) {
        addIssue(issues, filePath, `${prefix}.sourceSha256 必须是 SHA-256`);
    }
    if (source.warnings !== undefined && !Array.isArray(source.warnings)) {
        addIssue(issues, filePath, `${prefix}.warnings 必须是数组`);
    }
}

function validateFilteredMetadata(filePath, data, papers, issues) {
    if (Array.isArray(data)) return;

    validateCurrentArtifactMetadata(filePath, data, issues, { filterArtifact: true });

    if (data.status === undefined) {
        addIssue(issues, filePath, 'status 必须存在，且为 filtering/filter_complete/complete/source_partial_failed');
    } else if (!ALLOWED_FILTERED_STATUSES.has(data.status)) {
        addIssue(issues, filePath, `status 非法: ${data.status}`);
    }

    for (const field of ['filterModel', 'filterPromptHash', 'filterConfigFingerprint']) {
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

    validateCurrentArtifactMetadata(filePath, data, issues);
    if (data.rawPapersSha256 !== stableContentSha256(papers)) addIssue(issues, filePath, 'rawPapersSha256 与 papers 内容不一致');

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
            const parsed = paper.parsed;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                addIssue(issues, filePath, `papers[${index}] 缺少有效 parsed 评分缓存`);
            } else {
                const score = numericScore(parsed.score);
                if (parsed.score === undefined || parsed.score === '' || !Number.isFinite(score) || score < 0 || score > 10) {
                    addIssue(issues, filePath, `papers[${index}] parsed.score 非法: ${parsed.score}`);
                }
                if (parsed.documentType && !ALLOWED_DOCUMENT_TYPES.has(parsed.documentType)) {
                    addIssue(issues, filePath, `papers[${index}] parsed.documentType 非法: ${parsed.documentType}`);
                }
                if (parsed.scoringRubricVersion && parsed.scoringRubricVersion !== SCORING_RUBRIC_VERSION) {
                    addIssue(issues, filePath, `papers[${index}] parsed.scoringRubricVersion 非法: ${parsed.scoringRubricVersion}`);
                }
                if (parsed.scoringRubricVersion && !parsed.documentType) {
                    addIssue(issues, filePath, `papers[${index}] 有评分版本但缺少 parsed.documentType`);
                }

                const dimensionValues = [];
                for (const [field, maxScore] of Object.entries(SCORE_DIMENSIONS)) {
                    if (parsed[field] === undefined || parsed[field] === '') {
                        addIssue(issues, filePath, `papers[${index}] 缺少 parsed.${field}`);
                        continue;
                    }
                    const value = numericScore(parsed[field]);
                    if (!Number.isFinite(value) || value < 0 || value > maxScore) {
                        addIssue(issues, filePath, `papers[${index}] parsed.${field} 非法: ${parsed[field]}`);
                    } else if (field === 'openSourceScore' && !isOpenSourceScoreAnchor(value)) {
                        addIssue(issues, filePath, `papers[${index}] parsed.${field} 非法，必须使用固定锚点 ${OPEN_SOURCE_SCORE_ANCHORS.join('/')}`);
                    } else {
                        dimensionValues.push(normalizeScoreToOneDecimal(value));
                    }
                }
                if (dimensionValues.length === Object.keys(SCORE_DIMENSIONS).length && Number.isFinite(score)) {
                    const expected = normalizeScoreToOneDecimal(Math.min(10, dimensionValues.reduce((sum, value) => sum + value, 0)));
                    const actual = normalizeScoreToOneDecimal(score);
                    if (actual !== expected) {
                        addIssue(issues, filePath, `papers[${index}] parsed.score (${actual}) 与八项合计封顶结果 (${expected}) 不一致`);
                    }
                }

                const openSourceScore = numericScore(parsed.openSourceScore);
                const hasResource = [parsed.hasCode, parsed.hasModel, parsed.hasDataset]
                    .some(value => value === '是' || value === 'yes');
                if (parsed.documentType !== '理论研究'
                    && Number.isFinite(openSourceScore) && openSourceScore >= 1 && !hasResource) {
                    addIssue(issues, filePath, `papers[${index}] parsed.openSourceScore=${openSourceScore} 但无代码、模型或数据资源`);
                }
            }
            if (paper.scoringRubricVersion && paper.scoringRubricVersion !== SCORING_RUBRIC_VERSION) {
                addIssue(issues, filePath, `papers[${index}] scoringRubricVersion 非法: ${paper.scoringRubricVersion}`);
            }
            for (const key of ['selectedImageUrls', 'imageUrls', 'allImageUrls']) {
                if (paper[key] !== undefined && !Array.isArray(paper[key])) {
                    addIssue(issues, filePath, `papers[${index}].${key} 必须是数组`);
                }
            }
            if (paper.imageManifest !== undefined && paper.imageManifest !== null && typeof paper.imageManifest !== 'object') {
                addIssue(issues, filePath, `papers[${index}].imageManifest 必须是对象或 null`);
            }
            if (paper.analysisManifest !== undefined) {
                validateAnalysisManifest(filePath, paper.analysisManifest, index, issues, paper.analysisCheckpoint);
            }
            if (paper.analysisSource !== undefined) {
                validateAnalysisSourceProvenance(filePath, {
                    analysisSource: paper.analysisSource,
                    sourceTextChars: paper.sourceTextChars,
                    usedTextChars: paper.usedTextChars,
                    fullTextChars: paper.fullTextChars,
                    fullTextAvailable: paper.fullTextAvailable,
                    truncated: paper.truncated,
                    sourceSha256: paper.sourceSha256,
                    htmlAttempts: paper.htmlAttempts,
                    warnings: paper.sourceWarnings
                }, `papers[${index}].sourceProvenance`, issues);
            }
            if (paper.analysisCheckpoint !== undefined && typeof paper.analysisCheckpoint !== 'string') {
                addIssue(issues, filePath, `papers[${index}].analysisCheckpoint 必须是字符串`);
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

    validateCurrentArtifactMetadata(filePath, data, issues, { filterArtifact: true });

    if (data.stats !== undefined && !isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'stats 必须是对象');
    }

    for (const field of ['filterModel', 'filterPromptHash', 'filterConfigFingerprint']) {
        if (typeof data[field] !== 'string' || data[field] === '') {
            addIssue(issues, filePath, `${field} 必须是非空字符串`);
        }
    }

    if (!isPlainObject(data.decisions)) {
        addIssue(issues, filePath, 'decisions 必须是对象映射');
        return issues;
    }

    const entries = Object.entries(data.decisions);
    let relatedCount = 0;
    let keywordRejectedCount = 0;
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
        if (typeof decision.inputSha256 !== 'string' || !SHA256_RE.test(decision.inputSha256)) {
            addIssue(issues, filePath, `decisions.${key}.inputSha256 必须是 SHA-256`);
        }
        if (decision.retryable || decision.fallback) {
            addIssue(issues, filePath, `decisions.${key} 不能保存 retryable/fallback 决定`);
        }
        if (decision.parseSource === 'keyword_prefilter') {
            keywordRejectedCount += 1;
            if (decision.related !== false) {
                addIssue(issues, filePath, `decisions.${key} 的 keyword_prefilter 决定只能是 related=false`);
            }
            if (decision.keywordPrefilterVersion !== KEYWORD_PREFILTER_VERSION) {
                addIssue(issues, filePath, `decisions.${key}.keywordPrefilterVersion 必须为当前版本 ${KEYWORD_PREFILTER_VERSION}`);
            }
            for (const field of ['keywordMatchedGroups', 'keywordMatchedKeywords']) {
                if (!Array.isArray(decision[field]) || decision[field].some(item => typeof item !== 'string')) {
                    addIssue(issues, filePath, `decisions.${key}.${field} 必须是字符串数组`);
                }
            }
        }
    }

    const stats = isPlainObject(data.stats) ? data.stats : {};
    validateNonNegativeInteger(filePath, 'stats.totalCandidates', stats.totalCandidates, issues);
    validateNonNegativeInteger(filePath, 'stats.decided', stats.decided, issues);
    validateNonNegativeInteger(filePath, 'stats.related', stats.related, issues);
    for (const field of ['keywordRejected', 'llmCandidates', 'llmDecided']) {
        if (stats[field] !== undefined) validateNonNegativeInteger(filePath, `stats.${field}`, stats[field], issues);
    }
    if (stats.complete !== undefined && typeof stats.complete !== 'boolean') {
        addIssue(issues, filePath, 'stats.complete 必须是布尔值');
    }
    if (stats.decided !== undefined && stats.decided !== entries.length) {
        addIssue(issues, filePath, `stats.decided (${stats.decided}) 必须等于 decisions 数量 (${entries.length})`);
    }
    if (stats.related !== undefined && stats.related !== relatedCount) {
        addIssue(issues, filePath, `stats.related (${stats.related}) 必须等于 related=true 数量 (${relatedCount})`);
    }
    if (stats.keywordRejected !== undefined && stats.keywordRejected !== keywordRejectedCount) {
        addIssue(issues, filePath, `stats.keywordRejected (${stats.keywordRejected}) 必须等于 keyword_prefilter 决定数量 (${keywordRejectedCount})`);
    }
    if (stats.llmCandidates !== undefined && stats.totalCandidates !== undefined
        && stats.llmCandidates !== stats.totalCandidates - keywordRejectedCount) {
        addIssue(issues, filePath, 'stats.llmCandidates 必须等于 totalCandidates - keywordRejected');
    }
    if (stats.llmDecided !== undefined && stats.decided !== undefined
        && stats.llmDecided !== stats.decided - keywordRejectedCount) {
        addIssue(issues, filePath, 'stats.llmDecided 必须等于 decided - keywordRejected');
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
    const decisionStats = isPlainObject(decisionData.stats) ? decisionData.stats : {};
    const decisions = Object.values(decisionData.decisions).filter(isPlainObject);
    const decisionCount = Object.keys(decisionData.decisions).length;
    const relatedCount = decisions.filter(decision => decision.related === true).length;

    for (const field of ['filterModel', 'filterPromptHash', 'filterConfigFingerprint']) {
        if (filtered[field] !== undefined && decisionData[field] !== undefined && filtered[field] !== decisionData[field]) {
            addIssue(issues, filteredPath, `${field} (${filtered[field]}) 必须等于 filter-decisions.json ${field} (${decisionData[field]})`);
        }
    }
    if (
        Number.isInteger(stats.afterBlogSkip)
        && Number.isInteger(decisionStats.totalCandidates)
        && stats.afterBlogSkip !== decisionStats.totalCandidates
    ) {
        addIssue(issues, filteredPath, `stats.afterBlogSkip (${stats.afterBlogSkip}) 必须等于 filter-decisions.json stats.totalCandidates (${decisionStats.totalCandidates})`);
    }
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

function validateRawCandidateFilterConsistency(rawPath, decisionsPath, filteredPath = null) {
    const issues = [];
    if (!rawPath || !decisionsPath) return issues;
    if (!fs.existsSync(rawPath) || !fs.existsSync(decisionsPath)) return issues;

    const raw = readJsonSafe(rawPath, null);
    const decisionData = readJsonSafe(decisionsPath, null);
    if (!isPlainObject(raw) || !isPlainObject(decisionData) || !isPlainObject(decisionData.decisions)) {
        return issues;
    }

    const rawPapers = Array.isArray(raw.papers) ? raw.papers : [];
    const rawStats = isPlainObject(raw.stats) ? raw.stats : {};
    const decisionStats = isPlainObject(decisionData.stats) ? decisionData.stats : {};
    const decisionCount = Object.keys(decisionData.decisions).length;
    if (decisionData.rawPapersSha256 !== raw.rawPapersSha256) {
        addIssue(issues, decisionsPath, 'rawPapersSha256 必须与 raw-candidates.json 一致');
    }
    const rawById = new Map(rawPapers.map(paper => [normalizedId(paper), paper]));
    for (const [key, decision] of Object.entries(decisionData.decisions)) {
        const paper = rawById.get(normalizedId(key));
        if (!paper || decision.inputSha256 !== buildFilterInputSha256(paper)) {
            addIssue(issues, decisionsPath, `decisions.${key}.inputSha256 与当前筛选输入不一致`);
        }
    }
    if (decisionStats.complete === true && Object.keys(decisionData.retryableDecisions || {}).length > 0) {
        addIssue(issues, decisionsPath, 'complete=true 时 retryableDecisions 必须为空');
    }

    if (
        Number.isInteger(rawStats.afterBlogSkip)
        && Number.isInteger(decisionStats.totalCandidates)
        && rawStats.afterBlogSkip !== decisionStats.totalCandidates
    ) {
        addIssue(issues, rawPath, `stats.afterBlogSkip (${rawStats.afterBlogSkip}) 必须等于 filter-decisions.json stats.totalCandidates (${decisionStats.totalCandidates})`);
    }

    if (decisionStats.complete === true) {
        if (decisionCount !== rawPapers.length) {
            addIssue(issues, decisionsPath, `complete=true 时 decisions 数量 (${decisionCount}) 必须等于 raw-candidates.json papers 数量 (${rawPapers.length})`);
        }
        const decisionIds = new Set(Object.keys(decisionData.decisions).map(normalizedId).filter(Boolean));
        for (const [index, paper] of rawPapers.entries()) {
            const id = normalizedId(paper);
            if (id && !decisionIds.has(id)) {
                addIssue(issues, decisionsPath, `complete=true 但缺少 raw-candidates.json papers[${index}] (${id}) 的筛选决策`);
            }
        }
        if (filteredPath && fs.existsSync(filteredPath)) {
            const filtered = readJsonSafe(filteredPath, null);
            if (isPlainObject(filtered) && filtered.status === 'complete' && Array.isArray(filtered.papers)) {
                const excluded = new Set((filtered.excludedRelatedIds || []).map(normalizedId).filter(Boolean));
                for (const id of excluded) {
                    if (!rawById.has(id) || decisionData.decisions[id]?.related !== true) {
                        addIssue(issues, filteredPath, `excludedRelatedIds.${id} 必须对应 raw 中 related=true 的论文`);
                    }
                }
                if (Number.isInteger(filtered.stats?.skippedFromArchive) && filtered.stats.skippedFromArchive !== excluded.size) {
                    addIssue(issues, filteredPath, 'stats.skippedFromArchive 必须等于 excludedRelatedIds 数量');
                }
                const expected = new Set(Object.entries(decisionData.decisions)
                    .filter(([, decision]) => decision.related === true)
                    .map(([id]) => normalizedId(id))
                    .filter(id => id && !excluded.has(id)));
                const actual = filtered.papers.map(normalizedId).filter(Boolean);
                if (actual.length !== new Set(actual).size || actual.length !== expected.size || actual.some(id => !expected.has(id))) {
                    addIssue(issues, filteredPath, '最终 papers ID 集合必须精确等于 related=true 决定扣除 excludedRelatedIds');
                }
            }
        }
    }

    return issues;
}

function validateFetchArtifactConsistency(fetchPath, rawPath, decisionsPath, filteredPath) {
    const issues = [];
    const artifacts = [rawPath, decisionsPath, filteredPath]
        .filter(Boolean)
        .filter(filePath => fs.existsSync(filePath))
        .map(filePath => [filePath, readJsonSafe(filePath, null)])
        .filter(([, data]) => isPlainObject(data));
    if (artifacts.length === 0) return issues;

    const fingerprintFields = ['candidateFingerprint', 'sourceConfigFingerprint', 'blogDedupFingerprint'];
    for (const field of fingerprintFields) {
        const values = artifacts
            .filter(([, data]) => data[field] !== undefined)
            .map(([filePath, data]) => [filePath, data[field]]);
        if (values.length > 1) {
            const expected = values[0][1];
            for (const [filePath, value] of values.slice(1)) {
                if (value !== expected) addIssue(issues, filePath, `${field} 必须与同批次抓取/筛选产物一致`);
            }
        }
    }
    const filterArtifacts = artifacts.filter(([filePath]) => filePath === decisionsPath || filePath === filteredPath);
    if (filterArtifacts.length === 2
            && filterArtifacts[0][1].filterConfigFingerprint !== filterArtifacts[1][1].filterConfigFingerprint) {
        addIssue(issues, filteredPath, 'filterConfigFingerprint 必须与 filter-decisions.json 一致');
    }

    if (!fetchPath || !fs.existsSync(fetchPath)) {
        addIssue(issues, fetchPath || DEFAULT_FETCH_CHECKPOINT_FILE, '当前抓取/筛选产物缺少同批次 fetch-checkpoint.json');
        return issues;
    }
    const checkpoint = readJsonSafe(fetchPath, null);
    if (!isPlainObject(checkpoint)) return issues;
    for (const [artifactPath, artifact] of artifacts) {
        for (const field of fingerprintFields) {
            if (checkpoint[field] !== artifact[field]) {
                addIssue(issues, artifactPath, `${field} 必须与 fetch-checkpoint.json 一致`);
            }
        }
        for (const field of ['batchDate', 'batchId', 'fetchSourcesSha256']) {
            if (checkpoint[field] !== artifact[field]) addIssue(issues, artifactPath, `${field} 必须与 fetch-checkpoint.json 一致`);
        }
    }
    if (checkpoint.fetchSourcesSha256 !== getFetchSourcesSha256(checkpoint)) {
        addIssue(issues, fetchPath, 'fetchSourcesSha256 与来源 checkpoint 内容不一致');
    }

    const datedArtifacts = [[fetchPath, checkpoint], ...artifacts]
        .map(([artifactPath, artifact]) => [artifactPath, getBeijingBatchDate(artifact.timestamp)])
        .filter(([, date]) => date);
    if (datedArtifacts.length > 1) {
        const expectedDate = datedArtifacts[0][1];
        for (const [artifactPath, date] of datedArtifacts.slice(1)) {
            if (date !== expectedDate) addIssue(issues, artifactPath, `timestamp 日期必须与同批次 fetch-checkpoint.json 一致 (${expectedDate})`);
        }
    }

    const raw = artifacts.find(([filePath]) => filePath === rawPath)?.[1];
    if (!raw || !hasCompleteSourceHealthForValidation(raw.sourceHealth)) return issues;
    const expectedIds = Config.ARXIV_CATEGORIES.map(category => category.id);
    for (const id of expectedIds) {
        const entry = checkpoint.arxiv?.[id];
        if (entry?.status !== 'complete' || entry.health?.ok !== true || !Array.isArray(entry.papers)) {
            addIssue(issues, fetchPath, `raw-candidates.json 来源完整时 arxiv.${id} 必须有可复用的 complete checkpoint`);
        }
    }
    if (checkpoint.huggingface?.status !== 'complete' || checkpoint.huggingface?.health?.ok !== true || !Array.isArray(checkpoint.huggingface?.papers)) {
        addIssue(issues, fetchPath, 'raw-candidates.json 来源完整时 huggingface 必须有可复用的 complete checkpoint');
    }
    return issues;
}

function hasCompleteSourceHealthForValidation(sourceHealth) {
    const categories = sourceHealth?.arxiv?.categories;
    if (!Array.isArray(categories)) return false;
    const expectedIds = Config.ARXIV_CATEGORIES.map(category => category.id);
    const byId = new Map(categories.map(category => [category?.id, category]));
    return byId.size === expectedIds.length
        && expectedIds.every(id => byId.get(id)?.ok === true)
        && sourceHealth?.huggingface?.ok === true;
}

function validateRequiredCompanionFiles(files, filterDecisions) {
    const issues = [];
    if (!files.filteredPapers || !fs.existsSync(files.filteredPapers)) return issues;

    const filtered = readJsonSafe(files.filteredPapers, null);
    if (!isPlainObject(filtered)) return issues;
    const stats = isPlainObject(filtered.stats) ? filtered.stats : {};
    const papers = Array.isArray(filtered.papers) ? filtered.papers : [];
    if (stats.decisionCount !== undefined && !fs.existsSync(filterDecisions)) {
        addIssue(issues, filterDecisions, '有 filtered-papers.json stats.decisionCount，但 filter-decisions.json 缺失，无法校验逐篇筛选决策');
    }
    if (
        Number.isInteger(stats.afterBlogSkip)
        && stats.afterBlogSkip > papers.length
        && (!files.rawCandidates || !fs.existsSync(files.rawCandidates))
    ) {
        const rawCandidates = files.rawCandidates || path.join(path.dirname(files.filteredPapers), 'raw-candidates.json');
        addIssue(issues, rawCandidates, 'filtered-papers.json 显示存在被筛掉的候选论文，但 raw-candidates.json 缺失，无法校验筛选输入全集');
    }
    return issues;
}

function validateCurrentDataFiles(files = Config.FILES) {
    const filterDecisions = resolveFilterDecisionsPath(files);
    const fetchCheckpoint = files.fetchCheckpoint || (
        files.rawCandidates ? path.join(path.dirname(files.rawCandidates), 'fetch-checkpoint.json') : DEFAULT_FETCH_CHECKPOINT_FILE
    );
    return [
        ...validatePapersDatabase(files.papers),
        ...validateFetchCheckpointFile(fetchCheckpoint),
        ...validatePaperListFile(files.rawCandidates, { rawCandidates: true }),
        ...validateFilterDecisionsFile(filterDecisions),
        ...validatePaperListFile(files.filteredPapers, { filtered: true }),
        ...validatePaperListFile(files.deepAnalysisResult, { deepAnalysis: true }),
        ...validateFilterArtifactsConsistency(files.filteredPapers, filterDecisions),
        ...validateRawCandidateFilterConsistency(files.rawCandidates, filterDecisions, files.filteredPapers),
        ...validateFetchArtifactConsistency(fetchCheckpoint, files.rawCandidates, filterDecisions, files.filteredPapers),
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
    validateFetchCheckpointFile,
    validatePaperListFile,
    validateFilterDecisionsFile,
    validateCurrentDataFiles,
    validateSourceHealth
};
