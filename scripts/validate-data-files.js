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
    OPEN_SOURCE_SCORE_ANCHORS,
    parseAnalysis
} = require('./utils.js');
const {
    getInvalidAnalysisReason,
    EXPERIMENT_TABLE_CONTRACT_VERSIONS,
    METHOD_DETAIL_CONTRACT_VERSION,
    analysisManifestRequiresExperimentTableContract,
    analysisManifestRequiresMethodDetailContract,
    REQUIRED_RECOVERY_STAGES,
    isRecoveryStageTerminal,
    MANUAL_COMPLETE_STATUS,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    MANUAL_DEPTH_CONTRACT_VERSIONS,
    validateManualTakeoverManifest
} = require('./analysis-contract.js');
const { getCanonicalAnalysisRunSummary } = require('./analysis-engine.js');

const ALLOWED_DIGEST_STATUSES = new Set(['seen', 'pending_analysis', 'analyzed', 'analysis_failed']);
const ALLOWED_ANALYSIS_ATTEMPT_STATUSES = new Set(['analyzed', 'analysis_failed']);
const ALLOWED_FILTERED_STATUSES = new Set(['filtering', 'filter_complete', 'complete', 'source_partial_failed']);
const ALLOWED_RECOVERY_STAGE_STATUSES = new Set([
    'pending', 'complete', 'not_needed', 'skipped', 'no_candidates',
    'no_high_value_images', 'no_downloadable_images', 'transient_failure', 'invalid_output', 'contract_rejected',
    MANUAL_COMPLETE_STATUS
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

function hasCompleteFetchSourceContract(entry, expectedCategoryId = null) {
    return isPlainObject(entry)
        && entry.status === 'complete'
        && Array.isArray(entry.papers)
        && Number.isInteger(entry.papersCount)
        && entry.papersCount >= 0
        && entry.papersCount === entry.papers.length
        && typeof entry.papersSha256 === 'string'
        && SHA256_RE.test(entry.papersSha256)
        && entry.papersSha256 === stableContentSha256(entry.papers)
        && isPlainObject(entry.health)
        && entry.health.ok === true
        && (expectedCategoryId === null || entry.health.id === expectedCategoryId);
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

    const seenIds = new Map();
    for (const [key, paper] of Object.entries(data.papers)) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `${key} 不是论文对象`);
            continue;
        }
        const paperId = normalizedId(paper);
        const keyId = normalizedId(key);
        if (paperId && keyId && paperId !== keyId) {
            addIssue(issues, filePath, `${key} 的对象 key 与论文 ID 冲突: ${paperId}`);
        }
        const id = paperId || keyId;
        if (!id) addIssue(issues, filePath, `${key} 缺少可识别 ID`);
        if (id && seenIds.has(id)) {
            addIssue(issues, filePath, `${key} 与 ${seenIds.get(id)} 归一化为重复 ID: ${id}`);
        } else if (id) {
            seenIds.set(id, key);
        }
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

function hasMatchingManualParsedOverride(paper, mismatchedFields) {
    const override = paper?.parsedOverride;
    if (!isPlainObject(override)
        || override.type !== 'manual'
        || typeof override.source !== 'string' || !override.source.trim()
        || typeof override.reason !== 'string' || !override.reason.trim()
        || !Array.isArray(override.fields)
        || override.fields.some(field => typeof field !== 'string')) {
        return false;
    }
    const declared = [...new Set(override.fields)].sort();
    const actual = [...new Set(mismatchedFields)].sort();
    return declared.length === actual.length
        && declared.every((field, index) => field === actual[index]);
}

function validateAnalysisManifest(filePath, manifest, paperIndex, issues, analysisCheckpoint, options = {}) {
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
    const sourceSha256 = manifest.sourceAcquisition?.sourceSha256 || '';
    const manualTakeoverIssue = validateManualTakeoverManifest(manifest, sourceSha256, {
        analysis: options.analysis,
        sourceText: options.sourceText,
        imageManifest: options.imageManifest
    });
    if (manualTakeoverIssue) addIssue(issues, filePath, `${prefix} ${manualTakeoverIssue}`);
    if (manifest.contracts !== undefined) {
        if (!isPlainObject(manifest.contracts)) {
            addIssue(issues, filePath, `${prefix}.contracts 必须是对象`);
        } else {
            if (manifest.contracts.experimentTables !== undefined
                    && !EXPERIMENT_TABLE_CONTRACT_VERSIONS.includes(manifest.contracts.experimentTables)) {
                addIssue(
                    issues,
                    filePath,
                    `${prefix}.contracts.experimentTables 非法: ${manifest.contracts.experimentTables}`
                );
            }
            if (manifest.contracts.methodDetail !== undefined
                    && manifest.contracts.methodDetail !== METHOD_DETAIL_CONTRACT_VERSION) {
                addIssue(
                    issues,
                    filePath,
                    `${prefix}.contracts.methodDetail 非法: ${manifest.contracts.methodDetail}`
                );
            }
        }
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
        if (state.status === MANUAL_COMPLETE_STATUS && !manifest.manualTakeover) {
            addIssue(issues, filePath, `${prefix}.stages.${stage} 使用 manual_complete 但缺少 manifest.manualTakeover`);
        }
    }
    if (options.requireComplete) {
        for (const stage of REQUIRED_RECOVERY_STAGES) {
            const state = manifest.stages[stage];
            if (!state) {
                addIssue(issues, filePath, `${prefix}.stages 缺少完成态阶段 ${stage}`);
            } else if (!isRecoveryStageTerminal(stage, state.status)) {
                addIssue(issues, filePath, `${prefix}.stages.${stage} 尚未完成: ${state.status}`);
            }
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

function loadBoundManualV4SourceText(filePath, batchDate, paper, paperIndex) {
    const manifest = paper?.analysisManifest;
    if (![MANUAL_DEPTH_CONTRACT_VERSION_V4, MANUAL_DEPTH_CONTRACT_VERSION_V5]
        .includes(manifest?.contracts?.manualDepth)) {
        return { required: false, sourceText: '' };
    }
    const prefix = `papers[${paperIndex}].analysisManifest.sourceAcquisition`;
    if (typeof batchDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(batchDate)) {
        return { required: true, error: `${prefix} 无法绑定全文：deep analysis 缺少合法 batchDate` };
    }
    const acquisition = manifest.sourceAcquisition;
    if (!isPlainObject(acquisition)) {
        return { required: true, error: `${prefix} 缺少受控全文来源` };
    }
    const paperId = normalizedId(paper);
    const sourceId = normalizedId(acquisition.sourceId);
    if (!paperId || !sourceId || sourceId !== paperId) {
        return {
            required: true,
            error: `${prefix}.sourceId 与 canonical 论文 ID 不一致`
        };
    }
    const sourceSha256 = String(acquisition.sourceSha256 || '');
    if (!SHA256_RE.test(sourceSha256)) {
        return { required: true, error: `${prefix}.sourceSha256 必须是 SHA-256` };
    }

    const dataRoot = path.dirname(filePath);
    const sourceRoot = path.join(dataRoot, 'manual-full-text', batchDate);
    let realDataRoot;
    let realRoot;
    try {
        realDataRoot = fs.realpathSync(dataRoot);
        realRoot = fs.realpathSync(sourceRoot);
    } catch (error) {
        return {
            required: true,
            error: `${prefix} 缺少同批次受控全文目录: ${error.message}`
        };
    }
    const expectedRootRelative = path.join('manual-full-text', batchDate);
    if (path.relative(realDataRoot, realRoot) !== expectedRootRelative) {
        return { required: true, error: `${prefix} 的全文目录越出 canonical 同批次受控路径` };
    }
    const sourceManifestPath = path.join(realRoot, 'manifest.json');
    if (!fs.existsSync(sourceManifestPath)) {
        return {
            required: true,
            error: `${prefix} 缺少同批次受控全文 manifest: ${sourceManifestPath}`
        };
    }
    const sourceManifest = readJsonSafe(sourceManifestPath, null);
    if (!isPlainObject(sourceManifest)
        || sourceManifest.date !== batchDate
        || sourceManifest.mode !== 'manual_full_text_fetch'
        || !isPlainObject(sourceManifest.papers)) {
        return { required: true, error: `${prefix} 的受控全文 manifest 非法或批次不一致` };
    }
    const entry = sourceManifest.papers[sourceId];
    if (!isPlainObject(entry) || entry.status !== 'complete' || typeof entry.path !== 'string') {
        return { required: true, error: `${prefix} 在受控全文 manifest 中缺少 complete 路径` };
    }
    if (entry.sourceSha256 !== sourceSha256) {
        return { required: true, error: `${prefix} 与受控全文 manifest 的 SHA 不一致` };
    }

    const strictAssemblerClosure = [4, 5].includes(acquisition.manualSpecVersion);
    if (strictAssemblerClosure) {
        const filteredPath = path.join(dataRoot, 'filtered-papers.json');
        const filtered = readJsonSafe(filteredPath, null);
        if (!isPlainObject(filtered) || filtered.batchDate !== batchDate
            || filtered.status !== 'complete' || !Array.isArray(filtered.papers)) {
            return { required: true, error: `${prefix} 缺少同批 complete filtered-papers.json` };
        }
        const {
            buildManifestContext,
            isReusableFullTextCheckpoint,
            stableSha256
        } = require('./manual-fetch-fulltext.js');
        let context;
        try {
            context = buildManifestContext(filtered, batchDate, realRoot);
        } catch (error) {
            return { required: true, error: `${prefix} 无法重建 filtered 输入身份: ${error.message}` };
        }
        const input = context.byId.get(paperId);
        let sourceManifestSha256 = '';
        try {
            sourceManifestSha256 = crypto.createHash('sha256')
                .update(fs.readFileSync(sourceManifestPath)).digest('hex');
        } catch (error) {
            return { required: true, error: `${prefix} 无法重算 full-text manifest SHA: ${error.message}` };
        }
        if (!input
            || sourceManifest.version !== 2
            || sourceManifest.status !== 'complete'
            || sourceManifest.failed !== 0
            || sourceManifest.count !== filtered.papers.length
            || sourceManifest.filteredBatchSha256 !== context.filteredBatchSha256
            || sourceManifest.filteredPapersSha256 !== context.filteredBatchSha256
            || stableSha256(sourceManifest.expectedPaperInputs) !== stableSha256(context.expectedPaperInputs)
            || !isReusableFullTextCheckpoint(entry, input.filePath, input)
            || acquisition.requestedArxivId !== input.requestedArxivId
            || path.resolve(String(acquisition.fullTextPath || '')) !== path.resolve(entry.path)
            || acquisition.sourceIdentitySha256 !== entry.sourceIdentitySha256
            || acquisition.paperMetadataSha256 !== input.paperMetadataSha256
            || acquisition.paperInputSha256 !== input.paperInputSha256
            || acquisition.filteredBatchSha256 !== context.filteredBatchSha256
            || acquisition.fullTextManifestSha256 !== sourceManifestSha256
            || !SHA256_RE.test(String(acquisition.recordsSourcesSha256 || ''))
            || acquisition.imageInfosSha256 !== stableContentSha256(entry.imageInfos || [])) {
            return {
                required: true,
                error: `${prefix} 未通过 filtered/full-text/metadata/input/source/image assembler 全文闭环`
            };
        }
    }

    let realSourcePath;
    try {
        const declaredPath = path.isAbsolute(entry.path)
            ? entry.path
            : path.resolve(realRoot, entry.path);
        realSourcePath = fs.realpathSync(declaredPath);
    } catch (error) {
        return { required: true, error: `${prefix} 的受控全文路径不可读: ${error.message}` };
    }
    const relativePath = path.relative(realRoot, realSourcePath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return { required: true, error: `${prefix} 的全文路径越出同批次受控目录` };
    }
    let sourceBuffer;
    try {
        sourceBuffer = fs.readFileSync(realSourcePath);
    } catch (error) {
        return { required: true, error: `${prefix} 的受控全文读取失败: ${error.message}` };
    }
    const actualSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
    if (actualSha256 !== sourceSha256) {
        return { required: true, error: `${prefix} 的受控全文内容 SHA 不一致` };
    }
    return { required: true, sourceText: sourceBuffer.toString('utf8'), sourcePath: realSourcePath };
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
    if (Array.isArray(data)) return;
    const allowedStatuses = new Set(['running', 'complete', 'partial_failed', 'failed', 'filter_failed']);
    if (data.status !== undefined && !allowedStatuses.has(data.status)) {
        addIssue(issues, filePath, `status 非法: ${data.status}`);
    }
    if (data.stats !== undefined && !isPlainObject(data.stats)) {
        addIssue(issues, filePath, 'stats 必须是对象');
        return;
    }

    const stats = data.stats || {};
    if (stats.analysisStatus !== undefined) {
        if (!allowedStatuses.has(stats.analysisStatus)) {
            addIssue(issues, filePath, `stats.analysisStatus 非法: ${stats.analysisStatus}`);
        } else if (data.status !== undefined && stats.analysisStatus !== data.status) {
            addIssue(issues, filePath, `status (${data.status}) 与 stats.analysisStatus (${stats.analysisStatus}) 不一致`);
        }
    }
    if (data.deepAnalysisCompletedAt !== undefined && data.status !== 'complete') {
        addIssue(issues, filePath, '非 complete 状态不得保留 deepAnalysisCompletedAt');
    }
    if (data.deepAnalysisCompletedAt !== undefined && !BEIJING_ISO_RE.test(data.deepAnalysisCompletedAt)) {
        addIssue(issues, filePath, 'deepAnalysisCompletedAt 必须是北京时间 ISO 时间戳');
    }
    if (['complete', 'partial_failed', 'failed'].includes(data.status)) {
        const canonicalSummary = getCanonicalAnalysisRunSummary(papers);
        if (canonicalSummary.status !== data.status) {
            addIssue(
                issues,
                filePath,
                `status (${data.status}) 与 canonical 论文状态 (${canonicalSummary.status}) 不一致`
            );
        }
        if (stats.remainingFailed !== undefined
            && stats.remainingFailed !== canonicalSummary.remaining) {
            addIssue(
                issues,
                filePath,
                `stats.remainingFailed (${stats.remainingFailed}) 与 canonical 未完成数 (${canonicalSummary.remaining}) 不一致`
            );
        }
    }
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

    const seenPaperIds = new Map();
    papers.forEach((paper, index) => {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `papers[${index}] 不是论文对象`);
            return;
        }
        const paperId = ensurePaperId(paper, filePath, index, issues);
        if (paperId && seenPaperIds.has(paperId)) {
            addIssue(
                issues,
                filePath,
                `papers[${index}] 与 papers[${seenPaperIds.get(paperId)}] 归一化为重复 ID: ${paperId}`
            );
        } else if (paperId) {
            seenPaperIds.set(paperId, index);
        }
        if (options.deepAnalysis) {
            const hasAnalysisBody = typeof paper.analysis === 'string' && paper.analysis.trim().length > 0;
            const manualSource = loadBoundManualV4SourceText(
                filePath,
                Array.isArray(data) ? undefined : data.batchDate,
                paper,
                index
            );
            if (manualSource.error) addIssue(issues, filePath, manualSource.error);
            const sourceText = manualSource.sourceText || '';
            let reparsed = null;
            if (hasAnalysisBody) {
                reparsed = parseAnalysis(paper.analysis);
                const manualDepthContractVersion = paper.analysisManifest?.contracts?.manualDepth;
                const invalidReason = getInvalidAnalysisReason(paper.analysis, reparsed, {
                    enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                        paper.analysisManifest
                    ),
                    experimentTableContractVersion: paper.analysisManifest?.contracts?.experimentTables,
                    enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                        paper.analysisManifest
                    ),
                    enforceManualDepthContract: MANUAL_DEPTH_CONTRACT_VERSIONS.includes(
                        manualDepthContractVersion
                    ),
                    manualDepthContractVersion,
                    sourceText,
                    researchBrief: paper.analysisManifest?.manualTakeover?.researchBrief,
                    openSourceEvidence: paper.analysisManifest?.manualTakeover?.openSourceEvidence
                });
                if (invalidReason) {
                    addIssue(issues, filePath, `papers[${index}] analysis 正文契约非法: ${invalidReason}`);
                }
            }
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
                if (reparsed) {
                    const cacheFields = [
                        'score', 'documentType', 'scoringRubricVersion', 'rankBucket',
                        'confidence', 'primaryTaskTag', 'primaryMethodTag', 'sotaClaim',
                        'hasCode', 'hasModel', 'hasDataset', 'tags',
                        ...Object.keys(SCORE_DIMENSIONS)
                    ];
                    const comparable = value => (
                        value && typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value ?? '')
                    );
                    const mismatched = cacheFields.filter(field => (
                        comparable(parsed[field]) !== comparable(reparsed[field])
                    ));
                    if (mismatched.length > 0 && !hasMatchingManualParsedOverride(paper, mismatched)) {
                        addIssue(
                            issues,
                            filePath,
                            `papers[${index}] parsed 缓存与 analysis 重解析不一致: ${mismatched.join(', ')}`
                        );
                    }
                }
            }
            if (paper.scoringRubricVersion && paper.scoringRubricVersion !== SCORING_RUBRIC_VERSION) {
                addIssue(issues, filePath, `papers[${index}] scoringRubricVersion 非法: ${paper.scoringRubricVersion}`);
            }
            if (reparsed && paper.scoringRubricVersion !== reparsed.scoringRubricVersion) {
                addIssue(
                    issues,
                    filePath,
                    `papers[${index}] 顶层 scoringRubricVersion 与 analysis 重解析结果不一致`
                );
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
                validateAnalysisManifest(
                    filePath,
                    paper.analysisManifest,
                    index,
                    issues,
                    paper.analysisCheckpoint,
                    {
                        requireComplete: hasAnalysisBody,
                        analysis: paper.analysis,
                        sourceText,
                        imageManifest: paper.imageManifest
                    }
                );
            } else if (hasAnalysisBody) {
                addIssue(issues, filePath, `papers[${index}] 有 analysis 正文但缺少 analysisManifest`);
            }
            if (paper.latestAnalysisAttemptError
                || paper.digestStatus?.latestAttemptStatus === 'analysis_failed') {
                addIssue(issues, filePath, `papers[${index}] 最新分析尝试仍为失败，不能视为有效完成结果`);
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
    const seenDecisionIds = new Map();
    let relatedCount = 0;
    let keywordRejectedCount = 0;
    for (const [key, decision] of entries) {
        if (!isPlainObject(decision)) {
            addIssue(issues, filePath, `decisions.${key} 不是对象`);
            continue;
        }

        const decisionId = normalizedId(decision);
        const keyId = normalizedId(key);
        if (decisionId && keyId && decisionId !== keyId) {
            addIssue(issues, filePath, `decisions.${key} 的对象 key 与决定 ID 冲突: ${decisionId}`);
        }
        const id = decisionId || keyId;
        if (!id) {
            addIssue(issues, filePath, `decisions.${key} 缺少可识别 ID`);
        } else if (seenDecisionIds.has(id)) {
            addIssue(
                issues,
                filePath,
                `decisions.${key} 与 decisions.${seenDecisionIds.get(id)} 归一化为重复 ID: ${id}`
            );
        } else {
            seenDecisionIds.set(id, key);
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
                    if (!rawById.has(id)
                            || decisionData.decisions[id]?.related !== true
                            || !rawById.get(id)?.sources?.includes('huggingface')) {
                        addIssue(issues, filteredPath, `excludedRelatedIds.${id} 必须对应 raw 中 related=true 且来自 HuggingFace 的论文`);
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
        if (!hasCompleteFetchSourceContract(entry, id)) {
            addIssue(issues, fetchPath, `raw-candidates.json 来源完整时 arxiv.${id} 必须满足 complete/health/count/SHA checkpoint 契约`);
        }
    }
    if (!hasCompleteFetchSourceContract(checkpoint.huggingface)) {
        addIssue(issues, fetchPath, 'raw-candidates.json 来源完整时 huggingface 必须满足 complete/health/count/SHA checkpoint 契约');
    }
    return issues;
}

function hasCompleteSourceHealthForValidation(sourceHealth) {
    const categories = sourceHealth?.arxiv?.categories;
    if (!Array.isArray(categories)) return false;
    const expectedIds = Config.ARXIV_CATEGORIES.map(category => category.id);
    const byId = new Map(categories.map(category => [category?.id, category]));
    return categories.length === expectedIds.length
        && byId.size === expectedIds.length
        && expectedIds.every(id => byId.get(id)?.ok === true)
        && sourceHealth?.huggingface?.ok === true;
}

function validateCompleteFilterCompanionContract(files, decisionsPath, fetchPath) {
    const issues = [];
    const filteredPath = files.filteredPapers;
    if (!filteredPath || !fs.existsSync(filteredPath)) return issues;
    const filtered = readJsonSafe(filteredPath, null);
    if (!isPlainObject(filtered) || filtered.status !== 'complete') return issues;

    const required = [
        [fetchPath, 'fetch-checkpoint.json'],
        [files.rawCandidates, 'raw-candidates.json'],
        [decisionsPath, 'filter-decisions.json']
    ];
    let missing = false;
    for (const [filePath, label] of required) {
        if (!filePath || !fs.existsSync(filePath)) {
            addIssue(issues, filePath || path.join(path.dirname(filteredPath), label), `complete filtered-papers.json 必须有同批次 ${label}`);
            missing = true;
        }
    }
    if (missing) return issues;

    const checkpoint = readJsonSafe(fetchPath, null);
    const raw = readJsonSafe(files.rawCandidates, null);
    const decisions = readJsonSafe(decisionsPath, null);
    if (!isPlainObject(checkpoint) || !isPlainObject(raw) || !isPlainObject(decisions)) {
        addIssue(issues, filteredPath, 'complete 筛选四件套必须全部是可解析的对象');
        return issues;
    }
    if (!Array.isArray(raw.papers)) {
        addIssue(issues, files.rawCandidates, 'complete 筛选四件套要求 raw-candidates.json papers 为数组');
    }
    if (!hasCompleteSourceHealthForValidation(raw.sourceHealth)) {
        addIssue(issues, files.rawCandidates, 'complete filtered-papers.json 要求七个 arXiv 类别和 HuggingFace sourceHealth 全部 ok=true');
    }
    if (decisions.stats?.complete !== true) {
        addIssue(issues, decisionsPath, 'complete filtered-papers.json 要求 filter-decisions.json stats.complete=true');
    }

    const expectedIds = Config.ARXIV_CATEGORIES.map(category => category.id);
    for (const id of expectedIds) {
        const entry = checkpoint.arxiv?.[id];
        if (!hasCompleteFetchSourceContract(entry, id)) {
            addIssue(issues, fetchPath, `complete filtered-papers.json 要求 arxiv.${id} 满足 complete/health/count/SHA checkpoint 契约`);
        }
    }
    const hf = checkpoint.huggingface;
    if (!hasCompleteFetchSourceContract(hf)) {
        addIssue(issues, fetchPath, 'complete filtered-papers.json 要求 huggingface 满足 complete/health/count/SHA checkpoint 契约');
    }
    return issues;
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

function artifactBatchDate(data) {
    if (!isPlainObject(data)) return null;
    return typeof data.batchDate === 'string' && data.batchDate
        ? data.batchDate
        : getBeijingBatchDate(data.timestamp);
}

function paperBatchDate(paper) {
    const value = paper?.digestStatus?.batchDate || paper?.batchDate || paper?.fetchBatchDate
        || paper?.fetchedAt || paper?.timestamp || '';
    return typeof value === 'string' ? value.slice(0, 10) : '';
}

function normalizedPaperMap(rawPapers) {
    const result = new Map();
    if (!rawPapers || typeof rawPapers !== 'object') return result;
    for (const [key, paper] of Object.entries(rawPapers)) {
        if (!isPlainObject(paper)) continue;
        const id = normalizedId(paper) || normalizedId(key);
        if (id && !result.has(id)) result.set(id, paper);
    }
    return result;
}

function validateFilteredDeepPapersConsistency(files = Config.FILES) {
    const issues = [];
    const filteredPath = files.filteredPapers;
    const deepPath = files.deepAnalysisResult;
    if (!filteredPath || !deepPath || !fs.existsSync(filteredPath) || !fs.existsSync(deepPath)) {
        return issues;
    }

    const filtered = readJsonSafe(filteredPath, null);
    const deep = readJsonSafe(deepPath, null);
    if (!isPlainObject(filtered) || !isPlainObject(deep)
        || !Array.isArray(filtered.papers) || !Array.isArray(deep.papers)) {
        return issues;
    }

    const filteredBatchDate = artifactBatchDate(filtered);
    const deepBatchDate = artifactBatchDate(deep);
    if (filteredBatchDate && deepBatchDate && filteredBatchDate !== deepBatchDate) {
        addIssue(
            issues,
            deepPath,
            `batchDate (${deepBatchDate}) 必须与 filtered-papers.json (${filteredBatchDate}) 一致`
        );
    }

    if (filtered.status === 'complete') {
        const filteredIds = filtered.papers.map(normalizedId).filter(Boolean);
        const deepIds = deep.papers.map(normalizedId).filter(Boolean);
        const filteredIdSet = new Set(filteredIds);
        const deepIdSet = new Set(deepIds);
        const missing = [...filteredIdSet].filter(id => !deepIdSet.has(id));
        const unexpected = [...deepIdSet].filter(id => !filteredIdSet.has(id));
        if (missing.length > 0 || unexpected.length > 0) {
            addIssue(
                issues,
                deepPath,
                `papers ID 集合必须精确匹配 complete filtered-papers.json: 缺少 ${missing.join(', ') || '无'}；多出 ${unexpected.join(', ') || '无'}`
            );
        }

        if (files.papers && fs.existsSync(files.papers)) {
            const papersData = readJsonSafe(files.papers, null);
            const papersById = normalizedPaperMap(papersData?.papers);
            const deepById = new Map(deep.papers
                .map(paper => [normalizedId(paper), paper])
                .filter(([id]) => Boolean(id)));
            for (const id of filteredIdSet) {
                const databasePaper = papersById.get(id);
                if (!databasePaper) {
                    addIssue(issues, files.papers, `缺少 filtered-papers.json 论文 ID: ${id}`);
                    continue;
                }
                const databaseBatchDate = paperBatchDate(databasePaper);
                if (filteredBatchDate && !databaseBatchDate) {
                    addIssue(issues, files.papers, `${id} 缺少与 filtered-papers.json 对齐的批次日期`);
                } else if (filteredBatchDate && databaseBatchDate !== filteredBatchDate) {
                    addIssue(
                        issues,
                        files.papers,
                        `${id} 的批次日期 (${databaseBatchDate}) 必须与 filtered-papers.json (${filteredBatchDate}) 一致`
                    );
                }

                const deepPaper = deepById.get(id);
                if (!deepPaper) continue;
                const deepSucceeded = getCanonicalAnalysisRunSummary([deepPaper]).success === 1;
                const digestStatus = databasePaper.digestStatus?.status;
                const latestAttemptStatus = databasePaper.digestStatus?.latestAttemptStatus;
                if (deepSucceeded) {
                    if (digestStatus !== 'analyzed') {
                        addIssue(issues, files.papers, `${id} 深度分析成功，但 digestStatus.status 不是 analyzed`);
                    }
                    if (latestAttemptStatus !== undefined && latestAttemptStatus !== 'analyzed') {
                        addIssue(issues, files.papers, `${id} 深度分析成功，但 digestStatus.latestAttemptStatus 不是 analyzed`);
                    }
                } else {
                    const preservesOlderSuccess = digestStatus === 'analyzed'
                        && latestAttemptStatus === 'analysis_failed';
                    if (digestStatus !== 'analysis_failed' && !preservesOlderSuccess) {
                        addIssue(
                            issues,
                            files.papers,
                            `${id} 深度分析未完成，但 digestStatus 未标记 analysis_failed 最新尝试`
                        );
                    }
                    if (latestAttemptStatus !== undefined && latestAttemptStatus !== 'analysis_failed') {
                        addIssue(issues, files.papers, `${id} 深度分析未完成，但 digestStatus.latestAttemptStatus 不是 analysis_failed`);
                    }
                }
            }
        }
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
        ...validateCompleteFilterCompanionContract(files, filterDecisions, fetchCheckpoint),
        ...validateRequiredCompanionFiles(files, filterDecisions),
        ...validateFilteredDeepPapersConsistency(files)
    ];
}

function hasAnyCurrentDataFiles(files = Config.FILES) {
    return [
        files.papers,
        files.fetchCheckpoint,
        files.rawCandidates,
        files.filterDecisions,
        files.filteredPapers,
        files.deepAnalysisResult
    ].some(filePath => filePath && fs.existsSync(filePath));
}

function main(argv = process.argv.slice(2)) {
    const allowEmpty = argv.includes('--allow-empty');
    const unknown = argv.filter(arg => arg !== '--allow-empty');
    if (unknown.length > 0) {
        console.error(`未知参数: ${unknown.join(', ')}`);
        process.exit(2);
    }
    if (!allowEmpty && !hasAnyCurrentDataFiles()) {
        console.error('当前 data/current 没有可校验的运行数据；若这是没有运行数据的干净 checkout，请显式传 --allow-empty');
        process.exit(1);
    }
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
    validateFilteredDeepPapersConsistency,
    validateSourceHealth,
    loadBoundManualV4SourceText,
    validateManualV4CanonicalSourceClosure: loadBoundManualV4SourceText,
    hasAnyCurrentDataFiles
};
