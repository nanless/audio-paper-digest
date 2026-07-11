#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const {
    loadEnvFile,
    parseAnalysis,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    requestJson,
    loadPrompt,
    normalizeDocumentType,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS,
    getBeijingISOString
} = require('./utils.js');
const {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    validateTopLevelSectionContract,
    validateMachineSummaryContract,
    validateTagSectionContract,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { PDFParse } = require('pdf-parse');
const { ANALYSIS_CONFIG, ARXIV_CONFIG, SECONDARY_MODEL_CONFIG, CURRENT_DIR } = require('./config.js');

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
    apiTemperature: API_TEMPERATURE,
    scoringAuditTemperature: SCORING_AUDIT_TEMPERATURE = 0.1,
    imagePlanTemperature: IMAGE_PLAN_TEMPERATURE = 0.2,
    arxivFetchTimeoutMs: ARXIV_FETCH_TIMEOUT_MS,
    arxivPdfFetchTimeoutMs: ARXIV_PDF_FETCH_TIMEOUT_MS = 180000,
    arxivPdfMaxBytes: ARXIV_PDF_MAX_BYTES = 50 * 1024 * 1024,
    imageDownloadTimeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    imageMaxBytes: IMAGE_MAX_BYTES,
    imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
    imageMaxCount: IMAGE_MAX_COUNT,
    imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS = IMAGE_MAX_BASE64_CHARS * IMAGE_MAX_COUNT,
    imageCandidateMax: IMAGE_CANDIDATE_MAX = IMAGE_MAX_COUNT,
    imageInsertionMax: IMAGE_INSERTION_MAX = 4,
    fullTextMaxChars: FULL_TEXT_MAX_CHARS,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;
const IMAGE_CACHE_DIR = path.join(CURRENT_DIR, 'image-cache');

/**
 * 清理 gap-fill（审校重写）输出中的前缀废话
 * 确保输出直接从 ## 评分 开始
 * 如果找不到 ## 评分，返回 null 表示格式不正确
 */
function cleanGapFillPrefix(text) {
    if (!text) return null;
    // 找到独立的 "## 评分" 标题；不能误命中 "## 评分理由"
    const scoreMatch = text.match(/(^|\n)##\s*评分\s*(?:\n|$)/);
    if (scoreMatch) {
        return text.substring(scoreMatch.index + scoreMatch[1].length).trim();
    }
    // 如果没有 ## 评分，返回 null（格式不正确，调用方应回退到原始分析）
    return null;
}

const SCORING_DIMENSIONS = Object.freeze([
    { key: 'innovation', machineKey: 'innovation', label: '创新性', max: 2 },
    { key: 'technicalRigor', machineKey: 'technical_rigor', label: '技术严谨性', max: 1.5 },
    { key: 'experimentalSufficiency', machineKey: 'experimental_sufficiency', label: '实验充分性', max: 1.5 },
    { key: 'clarity', machineKey: 'clarity', label: '清晰度', max: 1 },
    { key: 'impact', machineKey: 'impact', label: '影响力', max: 1.5 },
    { key: 'openSource', machineKey: 'open_source', label: '开源', max: 1.5 },
    { key: 'reproducibility', machineKey: 'reproducibility', label: '可复现性', max: 0.5 },
    { key: 'engineering', machineKey: 'engineering_score', label: '工程/实践价值', max: 1.5 }
]);

const TYPE_AWARE_EVIDENCE_GUIDES = Object.freeze({
    '方法研究': '代表性基线、消融、跨数据集泛化、统计检验、误差分析，以及组件级声明对应的因果证据。',
    '系统技术报告': '端到端质量、延迟、吞吐、成本、规模、压力测试、公平竞品对比、失败案例与部署约束。',
    '模型报告': '端到端能力、训练与推理规模、质量/延迟/成本权衡、公平竞品对比、安全或失败案例。',
    '数据集与基准': '覆盖范围、标注质量、泄漏控制、协议设计、代表性基线与数据治理证据。',
    '综述': '检索方法、覆盖范围、分类体系、比较框架、综合洞察与遗漏分析。',
    '理论研究': '证明、假设、边界条件、反例，以及理论声明与实验验证之间的对应关系。',
    '应用研究': '真实场景、外部验证、用户研究、部署约束、失败案例与实际效益。'
});

function getTypeAwareEvidenceGuide(documentType) {
    return TYPE_AWARE_EVIDENCE_GUIDES[documentType]
        || '先依据主要贡献形态确定文档类型，再使用对应证据标准；不得机械套用方法论文的消融要求。';
}

function buildTypeAwareSourceContext(analysis, sourceText, maxChars = 120000) {
    const documentType = parseAnalysis(analysis)?.documentType || '待最终确认';
    const source = String(sourceText || '');
    const analysisSections = [
        ['A_SUMMARY', '核心摘要'],
        ['A_METHOD', '方法概述和架构'],
        ['A_RESULTS', '实验结果'],
        ['A_LIMITS', '局限与问题'],
        ['A_OPEN', '开源详情']
    ].map(([id, title]) => {
        const content = extractSectionByTitle(analysis, title);
        return content ? `[${id}] ${title}\n${content.slice(0, 12000)}` : '';
    }).filter(Boolean);
    const sourceBudget = Math.max(12000, maxChars - analysisSections.join('\n\n').length);
    const chunkSize = Math.floor(sourceBudget / 3);
    const middleStart = Math.max(0, Math.floor((source.length - chunkSize) / 2));
    const sourceChunks = [
        `[S_HEAD] 原文开头\n${source.slice(0, chunkSize)}`,
        `[S_MIDDLE] 原文中段\n${source.slice(middleStart, middleStart + chunkSize)}`,
        `[S_TAIL] 原文末尾/附录\n${source.slice(Math.max(0, source.length - chunkSize))}`
    ];
    return [
        `当前文档类型：${documentType}`,
        `适用证据标准：${getTypeAwareEvidenceGuide(documentType)}`,
        '以下是确定性评分证据账本。评分理由只能使用这些带 ID 的内容；不得补充账本外事实。',
        ...analysisSections,
        ...sourceChunks
    ].join('\n\n');
}

const AUDIT_TOP_LEVEL_KEYS = Object.freeze(['documentType', 'confidence', 'dimensions']);
const AUDIT_ITEM_KEYS = Object.freeze(['score', 'reason']);
const OPEN_SOURCE_DEFICIT = /(?:不开源|闭源|未开源|没有开源|代码未提供|权重未提供|数据集未提供|缺少(?:代码|权重|数据集|核心产物)|(?:代码|权重|数据集|核心产物)(?:未|没有|尚未)公开)/;
const REPRODUCIBILITY_DEFICIT = /(?:无法复现|不可复现|缺少|未提供|未披露|没有|不足|不完整|不清楚)[^.。；;]{0,18}(?:超参数|训练配置|硬件配置|复现步骤|实现细节)|(?:超参数|训练配置|硬件配置|复现步骤|实现细节)[^.。；;]{0,18}(?:缺失|不足|不完整|未提供|未披露|不清楚)/;

const FORBIDDEN_SCORING_REASON_PATTERNS = Object.freeze({
    innovation: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    technicalRigor: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    experimentalSufficiency: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    clarity: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    impact: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    openSource: [REPRODUCIBILITY_DEFICIT],
    reproducibility: [OPEN_SOURCE_DEFICIT],
    engineering: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT]
});

const EXPLICIT_NON_DEDUCTION = /(?:不应|不会|不该|不能|未被用来|并未用来)(?:据此)?(?:影响|降低|扣分|失分)|(?:不影响|不损害|无损于)|(?:不能|不应|不可)作为[^。；;]{0,20}扣分/;

function reasonUsesForbiddenDeduction(reason, patterns) {
    return String(reason || '').split(/[。！？；;\n]/).some(clause => {
        if (EXPLICIT_NON_DEDUCTION.test(clause)) return false;
        return patterns.some(pattern => {
            pattern.lastIndex = 0;
            return pattern.test(clause);
        });
    });
}

function assertExactObjectKeys(value, expectedKeys, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} 必须是对象`);
    }
    const actual = Object.keys(value);
    const missing = expectedKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    const extra = actual.filter(key => !expectedKeys.includes(key));
    if (missing.length > 0) throw new Error(`${context} 缺少字段: ${missing.join(', ')}`);
    if (extra.length > 0) throw new Error(`${context} 包含额外字段: ${extra.join(', ')}`);
}

function parseScoringAuditResult(raw) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`评分审计 JSON 无法解析: ${error.message}`);
    }

    assertExactObjectKeys(parsed, AUDIT_TOP_LEVEL_KEYS, '评分审计顶层');
    if (typeof parsed.documentType !== 'string' || !parsed.documentType.trim()) {
        throw new Error('评分审计 documentType 必须是非空字符串');
    }
    const documentType = normalizeDocumentType(parsed.documentType);
    if (!documentType) throw new Error('评分审计缺少有效 documentType');

    if (typeof parsed.confidence !== 'string' || !parsed.confidence.trim()) {
        throw new Error('评分审计 confidence 必须是非空字符串');
    }
    const confidence = parsed.confidence.trim();
    if (!['高', '中', '低'].includes(confidence)) throw new Error('评分审计 confidence 非法');
    assertExactObjectKeys(parsed.dimensions, SCORING_DIMENSIONS.map(spec => spec.key), '评分审计 dimensions');

    const dimensions = {};
    for (const spec of SCORING_DIMENSIONS) {
        const item = parsed.dimensions[spec.key];
        assertExactObjectKeys(item, AUDIT_ITEM_KEYS, `评分审计维度 ${spec.key}`);
        if (typeof item.score !== 'number' || !Number.isFinite(item.score)) {
            throw new Error(`评分审计维度 ${spec.key} score 必须是有限数字`);
        }
        if (!Number.isInteger(item.score * 10)) {
            throw new Error(`评分审计维度 ${spec.key} score 最多一位小数`);
        }
        const score = normalizeScoreToOneDecimal(item.score);
        if (score < 0 || score > spec.max) {
            throw new Error(`评分审计维度 ${spec.key} 分数越界`);
        }
        if (spec.key === 'openSource' && !isOpenSourceScoreAnchor(score)) {
            throw new Error(`评分审计维度 openSource 必须使用固定锚点 ${OPEN_SOURCE_SCORE_ANCHORS.join('/')}`);
        }
        if (typeof item.reason !== 'string' || !item.reason.trim()) {
            throw new Error(`评分审计维度 ${spec.key} reason 必须是非空字符串`);
        }
        const reason = item.reason.trim();
        if (reason.length < 20) throw new Error(`评分审计维度 ${spec.key} 理由过短`);
        const forbiddenPatterns = FORBIDDEN_SCORING_REASON_PATTERNS[spec.key] || [];
        if (reasonUsesForbiddenDeduction(reason, forbiddenPatterns)) {
            throw new Error(`评分审计维度 ${spec.key} 使用了属于其他维度的扣分事实`);
        }
        dimensions[spec.key] = { score, reason };
    }

    return recalculateScoringAudit({ documentType, confidence, dimensions });
}

function recalculateScoringAudit(audit) {
    const subtotal = SCORING_DIMENSIONS.reduce(
        (sum, spec) => sum + normalizeScoreToOneDecimal(audit.dimensions[spec.key].score),
        0
    );
    const total = normalizeScoreToOneDecimal(Math.min(10, subtotal));
    const rankBucket = total >= 9 ? '前10%' : total >= 7.5 ? '前25%' : total >= 5.5 ? '前50%' : '后50%';
    return { ...audit, total, rankBucket };
}

function setMachineSummaryField(analysis, key, value) {
    const bounds = findSectionBounds(analysis, '机器摘要');
    if (!bounds) return analysis;
    const section = analysis.slice(bounds.contentStart, bounds.end);
    const fieldPattern = new RegExp(`^${escapeRegExp(key)}\\s*[：:].*$`, 'm');
    const updatedSection = fieldPattern.test(section)
        ? section.replace(fieldPattern, `${key}: ${value}`)
        : `${key}: ${value}\n${section.replace(/^\s+/, '')}`;
    return analysis.slice(0, bounds.contentStart) + updatedSection + analysis.slice(bounds.end);
}

function applyScoringAuditResult(analysis, audit) {
    let updated = mergeSectionByTitle(analysis, '评分', `${Number(audit.total).toFixed(1)}/10`);
    updated = setMachineSummaryField(updated, 'document_type', audit.documentType);
    updated = setMachineSummaryField(updated, 'rank_bucket', audit.rankBucket);
    updated = setMachineSummaryField(updated, 'confidence', audit.confidence);
    for (const spec of SCORING_DIMENSIONS) {
        updated = setMachineSummaryField(updated, spec.machineKey, audit.dimensions[spec.key].score.toFixed(1));
    }

    const scoringReason = SCORING_DIMENSIONS.map(spec => {
        const item = audit.dimensions[spec.key];
        return `*   ${spec.label} (${item.score.toFixed(1)}/${spec.max})：${item.reason}`;
    }).join('\n\n');
    return mergeSectionByTitle(updated, '评分理由', scoringReason);
}

function validateScoringAuditAgainstAnalysis(analysis, audit) {
    const current = parseAnalysis(analysis) || {};
    // 理论论文的核心公开产物可以就是论文中完整披露的证明、推导与附录，
    // 不能仅凭没有代码/模型/数据链接就覆盖主模型已经按文类作出的判断。
    if (audit.documentType === '理论研究') return audit;
    const hasReleasedArtifact = [current.hasCode, current.hasModel, current.hasDataset]
        .some(value => value === '是' || value === 'yes');
    if (!hasReleasedArtifact) {
        const sourceText = String(current.opensource || '');
        const promisesRelease = hasAffirmativeReleasePromise(sourceText);
        const hasDemo = hasAffirmativeDemoEvidence(sourceText);
        const normalizedScore = promisesRelease ? 0.5 : hasDemo ? 0.2 : 0;
        const normalizedReason = promisesRelease
            ? '论文明确承诺未来开放核心产物，但当前尚未发布可用代码、模型权重或数据资源。'
            : hasDemo
                ? '论文目前只提供可访问的在线演示页面，未发布核心代码、模型权重或训练数据。'
                : '论文未发布核心代码、模型权重或数据资源，也未给出明确的后续开源承诺。';
        if (audit.dimensions.openSource.score !== normalizedScore) {
            console.log(`    [deep] ℹ️  开源分按资源状态归一化: ${audit.dimensions.openSource.score} → ${normalizedScore}`);
        }
        const normalizedAudit = {
            ...audit,
            dimensions: {
                ...audit.dimensions,
                openSource: { score: normalizedScore, reason: normalizedReason }
            }
        };
        return recalculateScoringAudit(normalizedAudit);
    }
    return audit;
}

function hasAffirmativeReleasePromise(sourceText) {
    const segments = String(sourceText || '').split(/[\n。；;]/).map(part => part.trim()).filter(Boolean);
    return segments.some(segment => {
        const positive = /承诺(?:未来|后续)?(?:将|会)?(?:公开|开放|开源)|计划(?:未来|后续)?(?:公开|开放|开源)|将(?:会)?(?:公开|开放|开源)|will\s+(?:be\s+)?(?:released|open[- ]sourced)|plan(?:s|ned)?\s+to\s+(?:release|open[- ]source)/i.test(segment);
        if (!positive) return false;
        return !/(?:未(?!来)|没有|无|尚未|并未|不)(?:明确)?(?:承诺|计划|表示|说明|提及)?[^\n。；;]{0,12}(?:公开|开放|开源)|(?:no|not|never|without)\b[^.]{0,20}\b(?:plan|promise|release|open[- ]source)/i.test(segment);
    });
}

function hasAffirmativeDemoEvidence(sourceText) {
    const segments = String(sourceText || '').split(/[\n。；;]/).map(part => part.trim()).filter(Boolean);
    return segments.some(segment => {
        if (!/(?:\bdemo\b|demo_available|在线演示|线上演示|体验页面|演示页面)/i.test(segment)) return false;
        if (/(?:未|没有|无|尚未|并未|不)(?:提供|公开|开放|包含|提及|可用|可访问)?[^\n。；;]{0,12}(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)|(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)\s*[：:]?\s*(?:否|无|未|没有|不可用|未提及|none|false|no\b|not\s+available|unavailable)|(?:no|not|without)\b[^.]{0,12}\bdemo\b|\bdemo\b[^.]{0,12}\bnot\s+available/i.test(segment)) {
            return false;
        }
        const hasUrl = /https?:\/\/[^\s<>()\[\]{}"']+/i.test(segment);
        const affirmativeStructuredValue = /(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)\s*(?:可用|可访问|已提供|已上线|available)|(?:\bdemo\b|demo_available|在线演示|线上演示|体验页面|演示页面)\s*[：:=]\s*(?:是|有|true|yes|available|可用|可访问|已提供|已上线)/i.test(segment);
        return hasUrl || affirmativeStructuredValue;
    });
}

async function auditTypeAwareScoringDetailed(analysis, sourceEvidence = '') {
    let lastError = null;
    let validationFeedback = '这是第一次输出，没有上一次校验错误。';
    const evidenceContext = sourceEvidence
        ? buildTypeAwareSourceContext(analysis, sourceEvidence)
        : '未提供额外原文证据，只能根据已有分析审计。';
    const promptTemplateSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'scoring-audit.md')))
        .digest('hex');
    for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = loadPrompt('prompts/scoring-audit.md', {
            existingAnalysis: analysis,
            sourceEvidence: evidenceContext,
            validationFeedback
        });
        const raw = await callModel(
            [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            16000,
            { temperature: SCORING_AUDIT_TEMPERATURE }
        );
        try {
            const audit = validateScoringAuditAgainstAnalysis(analysis, parseScoringAuditResult(raw));
            return {
                analysis: applyScoringAuditResult(analysis, audit),
                audit,
                attempts: attempt,
                model: DEEP_CONFIG.model,
                temperature: SCORING_AUDIT_TEMPERATURE,
                promptTemplateSha256,
                evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex')
            };
        } catch (error) {
            lastError = error;
            validationFeedback = `上一次 JSON 被代码拒绝，精确错误为：${error.message}。请只纠正该错误，同时重新检查全部八个维度。`;
            console.log(`    [deep] ⚠️  评分审计结构校验失败 (${attempt}/3): ${error.message}`);
        }
    }
    throw lastError || new Error('评分审计失败');
}

async function auditTypeAwareScoring(analysis, sourceEvidence = '') {
    return (await auditTypeAwareScoringDetailed(analysis, sourceEvidence)).analysis;
}

function getPaperArxivId(paper) {
    return paper?.arxivId || paper?.paper_id || paper?.id || '';
}

const RECOVERY_MANIFEST_VERSION = 1;
const RECOVERY_STAGE_STATUSES = new Set([
    'pending', 'complete', 'not_needed', 'skipped', 'no_candidates',
    'no_high_value_images', 'no_downloadable_images', 'transient_failure', 'invalid_output', 'contract_rejected'
]);
const RECOVERY_STAGE_ORDER = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
    'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
]);

function createAnalysisRecoveryManifest(paper) {
    const existing = paper?.analysisManifest;
    const stages = existing && existing.version === RECOVERY_MANIFEST_VERSION && existing.stages && typeof existing.stages === 'object'
        ? { ...existing.stages }
        : {};
    const firstFailedIndex = RECOVERY_STAGE_ORDER.findIndex(stage =>
        stages[stage] && !isRecoveryStageComplete({ stages }, stage)
    );
    if (firstFailedIndex >= 0) {
        for (const stage of RECOVERY_STAGE_ORDER.slice(firstFailedIndex + 1)) delete stages[stage];
    }
    // 成功结果不会长期保存正文 checkpoint。强制重分析这类记录时，必须同时
    // 清除主分析及全部下游阶段，否则新正文会错误复用旧轮次的审校/评分状态。
    if (isRecoveryStageComplete({ stages }, 'primaryAnalysis') && !paper?.analysisCheckpoint) {
        for (const stage of RECOVERY_STAGE_ORDER) delete stages[stage];
    }
    return {
        version: RECOVERY_MANIFEST_VERSION,
        stages,
        ...(existing?.sourceAcquisition ? { sourceAcquisition: { ...existing.sourceAcquisition } } : {}),
        updatedAt: getBeijingISOString()
    };
}

function markRecoveryStage(manifest, stage, status, details = {}) {
    if (!RECOVERY_STAGE_STATUSES.has(status)) throw new Error(`非法恢复阶段状态: ${status}`);
    const updatedAt = getBeijingISOString();
    manifest.stages[stage] = { status, ...details, updatedAt };
    manifest.updatedAt = updatedAt;
    return manifest.stages[stage];
}

function isRecoveryStageComplete(manifest, stage) {
    return ['complete', 'not_needed', 'skipped', 'no_candidates', 'no_high_value_images', 'no_downloadable_images']
        .includes(manifest?.stages?.[stage]?.status);
}

function hasIncompleteRecoveryStage(manifest) {
    return Object.values(manifest?.stages || {}).some(stage =>
        stage && !['complete', 'not_needed', 'skipped', 'no_candidates', 'no_high_value_images', 'no_downloadable_images'].includes(stage.status)
    );
}

function saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest = null) {
    paper.analysisCheckpoint = String(analysis || '');
    paper.analysisManifest = analysisManifest;
    if (imageManifest) paper.imageManifest = imageManifest;
}

function getPreProvidedImageUrls(paper) {
    let restored = normalizeImageInfos((paper?.analysisRecoveryImageManifest || paper?.imageManifest)?.candidates);
    for (const value of [paper?.allImageUrls, paper?.imageUrls]) {
        restored = mergeImageInfoMetadata(restored, value);
    }
    return restored;
}

// API 配置 - 深度分析阶段（统一使用 PAPER_ANALYZER_*）
const DEEP_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};

// 副模型配置（多模态图像分析，双模型模式）
// 未设置时 endpoint/key 分别回退到主模型对应的值
const SECONDARY_CONFIG = {
    endpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
    key: SECONDARY_MODEL_CONFIG.key || DEEP_CONFIG.key,
    model: SECONDARY_MODEL_CONFIG.model || ''
};

const isDualModel = Boolean(SECONDARY_CONFIG.model && SECONDARY_CONFIG.endpoint && SECONDARY_CONFIG.key);

const missingDeepEnv = [];
if (!DEEP_CONFIG.endpoint) missingDeepEnv.push('PAPER_ANALYZER_ENDPOINT');
if (!DEEP_CONFIG.key) missingDeepEnv.push('PAPER_ANALYZER_API_KEY');
if (!DEEP_CONFIG.model) missingDeepEnv.push('PAPER_ANALYZER_MODEL');
if (missingDeepEnv.length > 0) {
    console.error(`[deep-analyzer] 缺少环境变量: ${missingDeepEnv.join(', ')}。请在项目根目录的 .env 文件中配置`);
    process.exit(1);
}

/**
 * 调用大模型（支持多模态消息）— 带重试机制
 */
async function callModelWithConfig(messages, maxTokens, maxRetries = 3, config = null) {
    const cfg = config || DEEP_CONFIG;
    const budget = createActiveTimeBudget(API_OVERALL_TIMEOUT_MS);
    const apiType = detectApiType(cfg.endpoint, cfg.model);
    const modelUrl = buildApiUrl(apiType, cfg.endpoint);
    const url = new URL(modelUrl);
    const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : API_TEMPERATURE;
    console.log(`    [api] → ${cfg.model} | ${apiType} | ${url.hostname}${url.pathname} | max_tokens=${maxTokens} | max_retries=${maxRetries} | temperature=${temperature}`);

    let lastError = null;
    let reportedSuspendedMs = 0;

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const timeoutMs = getActiveRemainingTimeoutMs(API_OVERALL_TIMEOUT_MS, budget.elapsedMs());
                return await _callModelOnce(messages, maxTokens, cfg, budget, apiType, timeoutMs);
            } catch (err) {
                lastError = err;
                const duration = (budget.elapsedMs() / 1000).toFixed(1);
                const suspendedMs = budget.suspendedMs();
                if (suspendedMs - reportedSuspendedMs >= 1000) {
                    console.log(`    [api] 💤 检测到系统睡眠/长时间挂起，已从超时预算排除 ${((suspendedMs - reportedSuspendedMs) / 1000).toFixed(1)}s`);
                    reportedSuspendedMs = suspendedMs;
                }
                console.log(`    [api] ⚠️  模型调用失败 (尝试 ${attempt}/${maxRetries}) | active=${duration}s | ${err.message}`);

                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * API_RETRY_BASE_DELAY_MS;
                    if (getActiveRemainingTimeoutMs(API_OVERALL_TIMEOUT_MS, budget.elapsedMs()) <= delay) {
                        throw createOverallTimeoutError(budget.elapsedMs(), lastError);
                    }
                    console.log(`    [api] ⏳  ${delay/1000}s 后第 ${attempt + 1} 次重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        if (budget.elapsedMs() >= API_OVERALL_TIMEOUT_MS || lastError?.code === 'MODEL_OVERALL_TIMEOUT') {
            throw createOverallTimeoutError(budget.elapsedMs(), lastError);
        }
        throw new Error(`模型调用失败，已重试 ${maxRetries} 次: ${lastError.message}`);
    } finally {
        budget.stop();
    }
}

function createOverallTimeoutError(elapsedMs, cause = null) {
    const error = new Error(`模型调用整体超时: 预算 ${API_OVERALL_TIMEOUT_MS}ms，已用 ${elapsedMs}ms`);
    error.code = 'MODEL_OVERALL_TIMEOUT';
    if (cause) error.cause = cause;
    return error;
}

function createActiveTimeBudget(totalMs, options = {}) {
    const now = options.now || Date.now;
    const tickMs = options.tickMs || 1000;
    const suspendThresholdMs = options.suspendThresholdMs || 30000;
    let lastSample = now();
    let activeElapsedMs = 0;
    let excludedSuspendMs = 0;
    let stopped = false;

    const sample = () => {
        if (stopped) return;
        const current = now();
        const delta = Math.max(0, current - lastSample);
        lastSample = current;
        if (delta > suspendThresholdMs) {
            const resumeCost = Math.min(delta, tickMs * 2);
            activeElapsedMs += resumeCost;
            excludedSuspendMs += delta - resumeCost;
        } else {
            activeElapsedMs += delta;
        }
    };
    const timer = options.autoStart === false ? null : setInterval(sample, tickMs);
    timer?.unref?.();

    return {
        elapsedMs() { sample(); return Math.min(totalMs, Math.floor(activeElapsedMs)); },
        suspendedMs() { sample(); return Math.floor(excludedSuspendMs); },
        stop() {
            sample();
            stopped = true;
            if (timer) clearInterval(timer);
        }
    };
}

function getActiveRemainingTimeoutMs(totalMs, elapsedMs) {
    const remaining = Math.floor(totalMs - elapsedMs);
    if (remaining <= 0) {
        const error = new Error('模型调用整体超时');
        error.code = 'MODEL_OVERALL_TIMEOUT';
        throw error;
    }
    return remaining;
}

function getRemainingTimeoutMs(deadline, now = Date.now()) {
    const remaining = Math.floor(deadline - now);
    if (remaining <= 0) {
        const error = new Error('模型调用整体超时');
        error.code = 'MODEL_OVERALL_TIMEOUT';
        throw error;
    }
    return remaining;
}

/**
 * 单次 API 调用（内部方法）
 */
async function _callModelOnce(messages, maxTokens, config, budget, apiType, timeoutMs) {
    const apiUrl = buildApiUrl(apiType, config.endpoint);
    const temperature = Number.isFinite(config.temperature) ? config.temperature : API_TEMPERATURE;
    const bodyObj = buildRequestBody(apiType, config.model, messages, maxTokens, temperature);
    const postData = JSON.stringify(bodyObj);
    const headers = {
        ...buildHeaders(apiType, config.key, postData),
        ...config.headers
    };

    try {
        const response = await requestJson(apiUrl, bodyObj, headers, {
            timeoutMs,
            agent: false
        });
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = response.body?.error;
            const message = apiError?.message || apiError || response.raw.substring(0, 200);
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${typeof message === 'string' ? message : JSON.stringify(message).substring(0, 200)}`);
            throw new Error(`HTTP ${response.statusCode}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
        }
        const content = parseResponseText(apiType, response.body);
        if (content !== null) {
            console.log(`    [api] ✓ ${config.model} | HTTP ${response.statusCode} | ${content.length} chars | ${duration}s`);
            return content;
        }
        if (response.body.error) {
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${response.body.error.message || JSON.stringify(response.body.error).substring(0, 100)}`);
            throw new Error(response.body.error.message || JSON.stringify(response.body.error));
        }
        console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | invalid response`);
        throw new Error('Invalid response: ' + response.raw.substring(0, 200));
    } catch (err) {
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        console.log(`    [api] ✗ ${config.model} | request error | ${duration}s | ${err.message}`);
        throw err;
    }
}

async function callModel(messages, maxTokens = 8000, options = {}) {
    const modelName = DEEP_CONFIG.model;
    console.log(`    [analyzer] ╔═══════════════════════════════════════════════════╗`);
    console.log(`    [analyzer] ║  正在使用模型: ${modelName}`);
    console.log(`    [analyzer] ╚═══════════════════════════════════════════════════╜`);
    return await callModelWithConfig(messages, maxTokens, options.maxRetries || 3, {
        ...DEEP_CONFIG,
        ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {})
    });
}

const cheerio = require('cheerio');

function safeImageLabel(url) {
    const value = String(url || '');
    if (!value) return '<empty>';
    if (value.startsWith('data:')) {
        const mime = value.match(/^data:([^;,]+)/)?.[1] || 'data-uri';
        return `${mime};base64,<omitted>`;
    }
    try {
        const parsed = new URL(value);
        const name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return name.length > 120 ? `${name.slice(0, 117)}...` : name;
    } catch {
        return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
}

function isSupportedImageUrl(url) {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) return false;
    let path = '';
    try {
        path = new URL(value).pathname.toLowerCase();
    } catch {
        path = value.split('?')[0].toLowerCase();
    }
    if (path.endsWith('.svg')) return false;
    if (/\.(png|jpe?g|webp)$/i.test(path)) return true;
    const leaf = path.split('/').pop() || '';
    return !/\.[a-z0-9]{2,5}$/i.test(leaf);
}

function parseContentLength(value) {
    if (!value) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeImageMime(contentType) {
    if (!contentType) return '';
    return String(contentType).split(';')[0].trim().toLowerCase();
}

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return '';
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return '';
}

function isAllowedImageMime(mime) {
    return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

async function readResponseBufferWithLimit(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (maxBytes > 0 && buffer.byteLength > maxBytes) {
            throw new Error(`response body ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (maxBytes > 0 && total > maxBytes) {
                try {
                    await reader.cancel();
                } catch (e) {
                    // ignore cancel errors
                }
                throw new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
            }
            chunks.push(chunk);
        }
    } finally {
        if (reader.releaseLock) {
            reader.releaseLock();
        }
    }
    return Buffer.concat(chunks, total);
}

function getArxivHtmlIds(arxivId) {
    const id = String(arxivId || '').trim();
    if (!id) return [];
    if (/v\d+$/i.test(id)) {
        return [id];
    }
    return [id, `${id}v2`, `${id}v1`];
}

function isStableArxivHtmlMiss(status) {
    return status === 400 || status === 403 || status === 404;
}

/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivTextDetailed(arxivId) {
    const maxRetries = 6;
    const warnings = [];
    let htmlAvailability = 'transient_failure';
    let htmlAttempts = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        htmlAttempts = attempt;
        let shouldRetryHtml = false;
        const attemptStatuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)
                });

                if (response.status === 429) {
                    shouldRetryHtml = true;
                    attemptStatuses.push(`${htmlId}:429`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = baseWait + jitter;
                    console.log(`    [deep] fetchArxivText ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (response.ok) {
                    const html = await response.text();
                    const imageInfos = parseArxivImageInfosFromHtml(html, htmlId, arxivId);
                    const $ = cheerio.load(html);

                    // 移除噪音元素
                    $('script, style, nav, header, footer, aside, noscript, iframe').remove();
                    // 移除交互式元素和参考文献列表（保留正文的引用标记，移除完整列表以节省空间）
                    $('.ltx_bibliography, .bibtex, [role="navigation"], .ltx_TOC').remove();

                    // 尝试从内容区域提取文本（按优先级）
                    let content = '';
                    const selectors = [
                        '.ltx_page_content',      // LaTeXML 新版 arXiv
                        '.ltx_page_main',         // LaTeXML 备选
                        'article',                // 通用文章标签
                        '#content',               // 旧版容器
                        '.content',               // 通用内容区
                        'body'                    // 最终备选
                    ];

                    for (const sel of selectors) {
                        const el = $(sel);
                        if (el.length > 0) {
                            content = el.text();
                            break;
                        }
                    }

                    // 清理空白
                    content = content
                        .replace(/\n\s*\n/g, '\n')     // 合并多余空行
                        .replace(/[ \t]+/g, ' ')       // 合并多余空格
                        .trim();

                    if (content.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
                        warnings.push(`HTML ${htmlId}: 提取正文过短 (${content.length} chars)`);
                        console.log(`    [deep] fetchArxivText ${htmlId} 提取正文过短 (${content.length} chars)，继续 fallback`);
                        continue;
                    }
                    return {
                        text: content,
                        source: 'html',
                        sourceId: htmlId,
                        imageInfos,
                        htmlAvailability: 'available',
                        htmlAttempts,
                        warnings
                    };
                }
                console.log(`    [deep] fetchArxivText ${htmlId} HTTP ${response.status}`);
                attemptStatuses.push(`${htmlId}:${response.status}`);
                if (!isStableArxivHtmlMiss(response.status)) {
                    shouldRetryHtml = true;
                }
            } catch (e) {
                shouldRetryHtml = true;
                attemptStatuses.push(`${htmlId}:${e.name || 'error'}`);
                console.log(`    [deep] fetchArxivText ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (attemptStatuses.length > 0) warnings.push(`HTML attempt ${attempt}: ${attemptStatuses.join(', ')}`);
        if (!shouldRetryHtml) {
            htmlAvailability = 'permanent_miss';
            console.log(`    [deep] fetchArxivText ${arxivId} HTML 永久不可用 | attempts=${htmlAttempts} | ${attemptStatuses.join(', ')}`);
            break;
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivText ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} 转入 PDF fallback | html_status=${htmlAvailability} | attempts=${htmlAttempts}`);

    // PDF fallback: download PDF and extract text
    for (const pdfId of getArxivHtmlIds(arxivId)) {
        const pdfUrl = `https://arxiv.org/pdf/${pdfId}.pdf`;
        try {
            const pdfResponse = await fetch(pdfUrl, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS)
            });
            if (!pdfResponse.ok) {
                console.log(`    [deep] PDF ${pdfUrl} HTTP ${pdfResponse.status}`);
                warnings.push(`PDF ${pdfId}: HTTP ${pdfResponse.status}`);
                continue;
            }
            const contentType = String(pdfResponse.headers.get('content-type') || '').toLowerCase();
            if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
                warnings.push(`PDF ${pdfId}: Content-Type ${contentType}`);
                continue;
            }
            const buffer = await readResponseBufferWithLimit(pdfResponse, ARXIV_PDF_MAX_BYTES);
            if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
                warnings.push(`PDF ${pdfId}: 文件头无效`);
                continue;
            }
            const parser = new PDFParse({ data: buffer });
            let result;
            try {
                result = await parser.getText();
            } finally {
                await parser.destroy().catch(() => {});
            }
            if (result?.text) {
                const text = result.text
                    .replace(/\n\s*\n/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
                if (text.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
                    warnings.push(`PDF ${pdfId}: 提取正文过短 (${text.length} chars)`);
                    continue;
                }
                console.log(`    [deep] PDF fallback success for ${arxivId}, extracted ${text.length} chars`);
                return {
                    text,
                    source: 'pdf',
                    sourceId: pdfId,
                    imageInfos: [],
                    htmlAvailability,
                    htmlAttempts,
                    warnings
                };
            }
        } catch (e) {
            console.log(`    [deep] PDF fallback ${pdfUrl} error: ${e.message}`);
            warnings.push(`PDF ${pdfId}: ${e.message}`);
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} PDF fallback also failed`);
    return {
        text: '',
        source: 'unavailable',
        sourceId: '',
        imageInfos: [],
        htmlAvailability,
        htmlAttempts,
        warnings
    };
}

async function fetchArxivText(arxivId) {
    return (await fetchArxivTextDetailed(arxivId)).text;
}

/**
 * 从 arxiv HTML 获取图片信息列表（含 URL 和 caption）
 * 使用 cheerio 解析 <figure> 元素，提取图片 URL 和 figcaption 文本
 * 带重试机制，避免因并发限流偶发失败
 */
function resolveArxivImageUrl(src, htmlId, arxivId) {
    const value = String(src || '').trim();
    if (!value || value.startsWith('data:')) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://arxiv.org${value}`;
    const baseId = String(arxivId || '').replace(/v\d+$/i, '');
    if (value.startsWith(`${htmlId}`) || (baseId && value.startsWith(baseId))) {
        return `https://arxiv.org/html/${value}`;
    }
    return `https://arxiv.org/html/${htmlId}/${value}`;
}

function parseArxivImageInfosFromHtml(html, htmlId, arxivId = htmlId) {
    const $ = cheerio.load(String(html || ''));
    const byUrl = new Map();
    let sourceOrder = 0;

    const addImage = (src, caption = '') => {
        const normalizedSrc = String(src || '').trim();
        if (!normalizedSrc || /arxiv-logo|favicon|(?:^|[/_.-])logo(?:[/_.-]|$)/i.test(normalizedSrc)) return;
        const fullUrl = resolveArxivImageUrl(normalizedSrc, htmlId, arxivId);
        if (!fullUrl || !isSupportedImageUrl(fullUrl)) return;
        const cleanCaption = String(caption || '').replace(/\s+/g, ' ').trim();
        const existing = byUrl.get(fullUrl);
        if (existing) {
            if (cleanCaption.length > existing.caption.length) existing.caption = cleanCaption;
            return;
        }
        byUrl.set(fullUrl, { url: fullUrl, caption: cleanCaption, sourceOrder: sourceOrder++ });
    };

    $('figure img').each((_, elem) => {
        const $img = $(elem);
        const $figure = $img.closest('figure');
        let caption = $figure.children('figcaption').first().text().replace(/\s+/g, ' ').trim();
        if (!caption) caption = $figure.find('figcaption').first().text().replace(/\s+/g, ' ').trim();
        if (!caption) {
            const alt = String($img.attr('alt') || '').trim();
            if (alt && alt !== 'Refer to caption') caption = alt;
        }
        addImage($img.attr('src'), caption);
    });

    if (byUrl.size === 0) {
        $('img').each((_, elem) => {
            const $img = $(elem);
            const alt = String($img.attr('alt') || '').trim();
            addImage($img.attr('src'), alt === 'Refer to caption' ? '' : alt);
        });
    }

    return [...byUrl.values()];
}

async function fetchArxivImageUrls(arxivId, options = {}) {
    if (options.htmlAvailability === 'permanent_miss') {
        console.log(`    [deep] fetchArxivImageUrls ${arxivId} 跳过 | reason=html_permanent_miss`);
        return [];
    }
    const maxRetries = 6;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let shouldRetry = false;
        const statuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)
                });

                if (response.status === 429) {
                    shouldRetry = true;
                    statuses.push(`${htmlId}:429`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = baseWait + jitter;
                    console.log(`    [deep] fetchArxivImageUrls ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (!response.ok) {
                    statuses.push(`${htmlId}:${response.status}`);
                    if (!isStableArxivHtmlMiss(response.status)) shouldRetry = true;
                    continue;
                }

                const html = await response.text();
                return parseArxivImageInfosFromHtml(html, htmlId, arxivId);
            } catch (e) {
                shouldRetry = true;
                statuses.push(`${htmlId}:${e.name || 'error'}`);
                console.log(`    [deep] fetchArxivImageUrls ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (!shouldRetry) {
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} 永久不可用 | attempts=${attempt} | ${statuses.join(', ')}`);
            return [];
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivImageUrls ${arxivId} failed after ${maxRetries} retries`);
    return [];
}

/**
 * 下载图片并转为 base64
 */
async function fetchPublicImageResponse(imageUrl, maxRedirects = 5) {
    let currentUrl = String(imageUrl || '');
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        await validatePublicHttpUrl(currentUrl);
        const response = await fetch(currentUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
            signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
            redirect: 'manual'
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (response.body && typeof response.body.cancel === 'function') {
            try {
                await response.body.cancel();
            } catch (e) {
                // Redirect body cleanup failure does not change the validation result.
            }
        }
        if (!location) throw new Error(`图片重定向 ${response.status} 缺少 Location`);
        if (redirectCount >= maxRedirects) throw new Error(`图片重定向超过 ${maxRedirects} 次`);
        currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error('图片重定向校验失败');
}

function imageCachePaths(imageUrl) {
    const key = crypto.createHash('sha256').update(String(imageUrl)).digest('hex');
    return {
        data: path.join(IMAGE_CACHE_DIR, `${key}.bin`),
        meta: path.join(IMAGE_CACHE_DIR, `${key}.json`)
    };
}

async function readCachedImage(imageUrl, maxBytes) {
    const cache = imageCachePaths(imageUrl);
    try {
        const [buffer, rawMeta] = await Promise.all([
            fs.promises.readFile(cache.data),
            fs.promises.readFile(cache.meta, 'utf8')
        ]);
        const meta = JSON.parse(rawMeta);
        if (meta.url !== imageUrl || (maxBytes > 0 && buffer.length > maxBytes)) return null;
        const mime = sniffImageMime(buffer);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        if (!isAllowedImageMime(mime) || mime !== meta.mime || meta.bytes !== buffer.length || meta.sha256 !== sha256) return null;
        return { base64: buffer.toString('base64'), mime, sha256, cacheHit: true };
    } catch (e) {
        return null;
    }
}

async function writeCachedImage(imageUrl, buffer, mime) {
    const cache = imageCachePaths(imageUrl);
    const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const dataTemp = `${cache.data}.${suffix}.tmp`;
    const metaTemp = `${cache.meta}.${suffix}.tmp`;
    try {
        await fs.promises.mkdir(IMAGE_CACHE_DIR, { recursive: true });
        await Promise.all([
            fs.promises.writeFile(dataTemp, buffer),
            fs.promises.writeFile(metaTemp, JSON.stringify({
                url: imageUrl,
                mime,
                bytes: buffer.length,
                sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                savedAt: getBeijingISOString()
            }))
        ]);
        await fs.promises.rename(dataTemp, cache.data);
        await fs.promises.rename(metaTemp, cache.meta);
    } catch (e) {
        await Promise.allSettled([fs.promises.unlink(dataTemp), fs.promises.unlink(metaTemp)]);
    }
}

function isRetryableImageStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

const imageDownloadPromises = new Map();

async function downloadImageBase64Uncached(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES) {
    if (!isSupportedImageUrl(imageUrl)) {
        console.log(`    [deep] 跳过不支持的图片: ${safeImageLabel(imageUrl)}`);
        return { failureType: 'permanent_reject', reason: 'unsupported_url' };
    }

    const fileName = safeImageLabel(imageUrl);
    const cached = await readCachedImage(imageUrl, maxBytes);
    if (cached) {
        console.log(`    [deep] 图片缓存命中 ${fileName}`);
        return cached;
    }
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchPublicImageResponse(imageUrl);
            if (!response.ok) {
                if (!isRetryableImageStatus(response.status)) {
                    console.log(`    [deep] 下载图片 ${fileName} 永久失败: HTTP ${response.status}，不重试`);
                    return { failureType: 'permanent_reject', reason: `http_${response.status}` };
                }
                if (attempt < maxRetries) {
                    console.log(`    [deep] 下载图片 ${fileName} HTTP ${response.status}，${(attempt + 1) * 2}s 后重试...`);
                    await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
                    continue;
                }
                console.log(`    [deep] 下载图片 ${fileName} 失败: HTTP ${response.status}`);
                return { failureType: 'transient_failure', reason: `http_${response.status}` };
            }

            const headerMime = normalizeImageMime(response.headers.get('content-type'));
            if (headerMime && !isAllowedImageMime(headerMime) && headerMime !== 'application/octet-stream') {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Type=${headerMime}`);
                return { failureType: 'permanent_reject', reason: `content_type_${headerMime}` };
            }

            const contentLength = parseContentLength(response.headers.get('content-length'));
            if (contentLength !== null && maxBytes > 0 && contentLength > maxBytes) {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Length ${(contentLength / 1024 / 1024).toFixed(1)}MB 超过限制`);
                return { failureType: 'permanent_reject', reason: 'content_length_exceeded' };
            }

            const buffer = await readResponseBufferWithLimit(response, maxBytes);

            const sniffedMime = sniffImageMime(buffer);
            if (!isAllowedImageMime(sniffedMime)) {
                console.log(`    [deep] 跳过图片 ${fileName}: 文件头不是支持的 PNG/JPEG/WebP`);
                return { failureType: 'permanent_reject', reason: 'unsupported_magic' };
            }

            await writeCachedImage(imageUrl, buffer, sniffedMime);
            return {
                base64: buffer.toString('base64'),
                mime: sniffedMime,
                sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                cacheHit: false
            };
        } catch (e) {
            lastError = e.message;
            if (/exceeds limit/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return { failureType: 'permanent_reject', reason: 'body_size_exceeded' };
            }
            if (/非公网|localhost|不支持的公网 URL 协议|用户名或密码|重定向超过|重定向.*缺少 Location/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return { failureType: 'permanent_reject', reason: e.message };
            }
            if (attempt < maxRetries) {
                console.log(`    [deep] 下载图片 ${fileName} 失败 (${e.message})，${(attempt + 1) * 2}s 后重试...`);
                await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            }
        }
    }
    console.log(`    [deep] 下载图片 ${fileName} 最终失败: ${lastError}`);
    return { failureType: 'transient_failure', reason: lastError || 'unknown_error' };
}

async function downloadImageBase64Detailed(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES) {
    const key = `${imageUrl}\n${maxBytes}`;
    if (!imageDownloadPromises.has(key)) {
        const promise = downloadImageBase64Uncached(imageUrl, maxRetries, maxBytes)
            .finally(() => imageDownloadPromises.delete(key));
        imageDownloadPromises.set(key, promise);
    }
    return imageDownloadPromises.get(key);
}

async function downloadImageBase64(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES) {
    const result = await downloadImageBase64Detailed(imageUrl, maxRetries, maxBytes);
    return result?.base64 ? result : null;
}

/**
 * 串行下载图片（避免并发导致 arxiv 限流）
 * @param {string[]} imageUrls - 图片 URL 列表
 * @param {number} maxCount - 最大下载数量
 * @param {number} maxBase64Chars - 单张 base64 字符数上限
 * @param {number} maxTotalBase64Chars - 所有图片 base64 字符数上限
 * @returns {Promise<Array<{url: string, base64: string, mime: string}>>}
 */
async function downloadImagesSerial(imageUrls, maxCount, maxBase64Chars, maxTotalBase64Chars = IMAGE_TOTAL_BASE64_CHARS) {
    const results = [];
    const outcomes = [];
    let totalBase64Chars = 0;
    // 去重避免同一 URL 下载多次
    const uniqueUrls = [...new Set(imageUrls)];

    for (const url of uniqueUrls) {
        if (results.length >= maxCount) break;
        if (maxTotalBase64Chars > 0 && totalBase64Chars >= maxTotalBase64Chars) {
            console.log(`    [deep] 图片总 payload 已达上限 ${(maxTotalBase64Chars / 1024).toFixed(1)}KB，停止下载更多图片`);
            outcomes.push(...uniqueUrls.slice(uniqueUrls.indexOf(url)).map(skippedUrl => ({
                url: skippedUrl,
                status: 'budget_skipped',
                reason: 'total_payload_limit'
            })));
            break;
        }
        try {
            const image = await downloadImageBase64Detailed(url, 5, IMAGE_MAX_BYTES);
            if (image?.base64 && image.base64.length < maxBase64Chars) {
                if (maxTotalBase64Chars > 0 && totalBase64Chars + image.base64.length > maxTotalBase64Chars) {
                    console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: 加入后总 base64 ${((totalBase64Chars + image.base64.length) / 1024).toFixed(1)}KB 超过上限`);
                    outcomes.push({ url, status: 'budget_skipped', reason: 'total_payload_limit' });
                    continue;
                }
                totalBase64Chars += image.base64.length;
                console.log(`    [deep] 下载图片 ${safeImageLabel(url)}: ${(image.base64.length / 1024).toFixed(1)}KB, ${image.mime}${image.cacheHit ? ', cache=hit' : ''}`);
                results.push({ url, base64: image.base64, mime: image.mime, sha256: image.sha256, cacheHit: Boolean(image.cacheHit) });
                outcomes.push({ url, status: 'downloaded', cacheHit: Boolean(image.cacheHit) });
            } else if (image?.base64) {
                console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: base64 ${(image.base64.length / 1024).toFixed(1)}KB 超过限制`);
                outcomes.push({ url, status: 'permanent_reject', reason: 'base64_limit' });
            } else {
                outcomes.push({ url, status: image?.failureType || 'transient_failure', reason: image?.reason || 'unknown_error' });
            }
        } catch (e) {
            outcomes.push({ url, status: 'transient_failure', reason: e.message });
        }
    }

    Object.defineProperty(results, 'outcomes', { value: outcomes, enumerable: false });
    return results;
}

function scoreImageCandidate(info, index) {
    const text = `${info.url || ''} ${info.caption || ''}`.toLowerCase();
    let score = 0;
    const strong = [
        'architecture', 'framework', 'overview', 'pipeline', 'method', 'model',
        'spectrogram', 'waveform', 'mel', 'audio', 'speech', 'music',
        'result', 'results', 'comparison', 'ablation', 'analysis', 'evaluation',
        'table', 'benchmark', 'performance', 'visualization',
        '架构', '框架', '流程', '模型', '模块', '方法', '系统',
        '语谱', '频谱', '波形', '音频', '语音', '音乐',
        '结果', '对比', '消融', '实验', '评估', '性能', '可视化'
    ];
    const weak = ['fig', 'figure', '图'];
    const negative = ['logo', 'favicon', 'icon', 'author', 'portrait', 'license', 'qr', '二维码'];

    for (const kw of strong) {
        if (text.includes(kw)) score += 3;
    }
    for (const kw of weak) {
        if (text.includes(kw)) score += 1;
    }
    for (const kw of negative) {
        if (text.includes(kw)) score -= 8;
    }
    if (info.caption && info.caption.length > 20) score += 2;
    // 论文前几张图通常是 overview/architecture，给一点顺序先验。
    score += Math.max(0, 6 - index);
    return score;
}

function selectImageCandidates(imageInfos, maxCount) {
    if (!Array.isArray(imageInfos) || imageInfos.length === 0) return [];
    const seen = new Set();
    const unique = [];
    for (const [index, info] of imageInfos.entries()) {
        if (!info || !info.url || seen.has(info.url)) continue;
        if (!isSupportedImageUrl(info.url)) continue;
        seen.add(info.url);
        const sourceOrder = Number.isInteger(info.sourceOrder) ? info.sourceOrder : index;
        unique.push({
            ...info,
            sourceOrder,
            candidateScore: scoreImageCandidate(info, sourceOrder)
        });
    }
    return unique
        .sort((a, b) => b.candidateScore - a.candidateScore || a.sourceOrder - b.sourceOrder)
        .slice(0, Math.max(0, maxCount));
}

function normalizeImageInfos(input) {
    if (!Array.isArray(input)) return [];
    return input.map(item => {
        if (!item) return null;
        if (typeof item === 'string') return { url: item, caption: '' };
        if (typeof item === 'object' && item.url) {
            const normalized = {
                url: item.url,
                caption: item.caption || item.alt || item.description || ''
            };
            for (const key of ['figureNumber', 'sourceSection', 'sourceType']) {
                if (item[key]) normalized[key] = String(item[key]);
            }
            if (Number.isInteger(item.sourceOrder)) normalized.sourceOrder = item.sourceOrder;
            if (Number.isFinite(item.candidateScore)) normalized.candidateScore = item.candidateScore;
            else if (Number.isFinite(item.score)) normalized.candidateScore = item.score;
            return normalized;
        }
        return null;
    }).filter(info => info && info.url && isSupportedImageUrl(info.url));
}

function imageUrlBasename(value) {
    try {
        return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
    } catch (e) {
        return '';
    }
}

function mergeImageInfoMetadata(primary, supplemental) {
    const normalizedPrimary = normalizeImageInfos(primary);
    const normalizedSupplemental = normalizeImageInfos(supplemental);
    const byUrl = new Map(normalizedSupplemental.map(info => [info.url, info]));
    const basenameCounts = new Map();
    const byBasename = new Map();
    for (const info of normalizedSupplemental) {
        const basename = imageUrlBasename(info.url);
        if (!basename) continue;
        basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
        byBasename.set(basename, info);
    }
    const merged = normalizedPrimary.map(info => {
        const basename = imageUrlBasename(info.url);
        const match = byUrl.get(info.url)
            || (basename && basenameCounts.get(basename) === 1 ? byBasename.get(basename) : null);
        if (!match) return info;
        return {
            ...match,
            ...info,
            caption: info.caption || match.caption || '',
            sourceOrder: Number.isInteger(info.sourceOrder) ? info.sourceOrder : match.sourceOrder
        };
    });
    const seen = new Set(merged.map(info => info.url));
    for (const info of normalizedSupplemental) {
        if (!seen.has(info.url)) merged.push(info);
    }
    return merged;
}

/**
 * 构造图片消息块
 */
function buildImageContent(imageUrl, base64, detectedMime = '') {
    if (base64) {
        const lower = imageUrl.toLowerCase().split('?')[0];
        let mime = isAllowedImageMime(detectedMime) ? detectedMime : 'image/png';
        if (imageUrl.startsWith('data:image/svg+xml')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) {
            mime = 'image/jpeg';
        } else if (lower.endsWith('.svg')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && lower.endsWith('.webp')) {
            mime = 'image/webp';
        }
        return {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}` }
        };
    }
    return {
        type: 'image_url',
        image_url: { url: imageUrl }
    };
}

function removeUnapprovedMarkdownImages(text, allowedUrls) {
    if (!text) return text;
    const allowed = new Set(allowedUrls || []);
    return text.replace(/!\[(?:\\.|[^\]\\])*\]\(([^)]+)\)/g, (match, url) => {
        return allowed.has(url) ? match : '';
    });
}

const ALLOWED_IMAGE_INSERTION_SECTIONS = new Set([
    '核心摘要',
    '方法概述和架构',
    '核心创新点',
    '实验结果',
    '细节详述'
]);

function sanitizeImagePlanText(text, maxChars = 260) {
    return String(text || '')
        .replace(/!\[(?:\\.|[^\]\\])*\]\([^)]+\)/g, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars)
        .trim();
}

function extractJsonObjectText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1).trim();
    }
    return text;
}

function parseImageInsertionPlanDetailed(raw, imageInfos = []) {
    const diagnostics = {
        status: 'invalid_json',
        totalItems: 0,
        acceptedItems: 0,
        rejectedItems: 0,
        replacementIgnored: 0,
        rejectionReasons: []
    };
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (e) {
        diagnostics.error = e.message;
        return { plans: [], diagnostics };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.insertions)) {
        diagnostics.status = 'invalid_schema';
        diagnostics.error = '顶层必须是仅含 insertions 数组的 JSON 对象';
        return { plans: [], diagnostics };
    }

    const items = parsed.insertions;
    diagnostics.totalItems = items.length;
    if (items.length === 0) {
        diagnostics.status = 'empty_plan';
        return { plans: [], diagnostics };
    }
    const used = new Set();
    const plans = [];

    const reject = reason => {
        diagnostics.rejectedItems++;
        diagnostics.rejectionReasons.push(reason);
    };

    for (const [itemIndex, item] of items.entries()) {
        if (!item || typeof item !== 'object') {
            reject(`item_${itemIndex + 1}:not_object`);
            continue;
        }
        const imageNumber = Number(item.image ?? item.imageIndex);
        if (!Number.isInteger(imageNumber) || imageNumber < 1 || imageNumber > imageInfos.length) {
            reject(`item_${itemIndex + 1}:invalid_image`);
            continue;
        }
        if (used.has(imageNumber)) {
            reject(`item_${itemIndex + 1}:duplicate_image`);
            continue;
        }

        const section = sanitizeImagePlanText(item.section, 60);
        if (!ALLOWED_IMAGE_INSERTION_SECTIONS.has(section)) {
            reject(`item_${itemIndex + 1}:forbidden_section`);
            continue;
        }

        const paragraphId = sanitizeImagePlanText(item.paragraph_id || item.paragraphId, 40);
        const anchor = sanitizeImagePlanText(item.anchor, 180);
        if (item.replacement || item.replaceAnchorWith || item.rewrite) diagnostics.replacementIgnored++;
        const lead = sanitizeImagePlanText(item.lead || item.before || item.intro, 220);
        const explanation = sanitizeImagePlanText(item.explanation || item.after || item.note, 320);
        if (!lead && !explanation) {
            reject(`item_${itemIndex + 1}:missing_context_text`);
            continue;
        }

        used.add(imageNumber);
        plans.push({
            imageNumber,
            section,
            paragraphId,
            anchor,
            lead,
            explanation
        });
    }

    diagnostics.acceptedItems = plans.length;
    diagnostics.status = plans.length > 0 ? 'ok' : 'all_items_rejected';
    return { plans, diagnostics };
}

function parseImageInsertionPlan(raw, imageInfos = []) {
    const { plans, diagnostics } = parseImageInsertionPlanDetailed(raw, imageInfos);
    Object.defineProperty(plans, 'diagnostics', {
        value: diagnostics,
        enumerable: false,
        configurable: false,
        writable: false
    });
    return plans;
}

function findSectionBounds(analysis, title) {
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return null;
    const start = match.index + match[1].length;
    const contentStart = start + match[2].length;
    const rest = analysis.slice(contentStart);
    const next = /\n#{2,3}\s/.exec(rest);
    const end = next ? contentStart + next.index : analysis.length;
    return { start, contentStart, end };
}

function buildImageAnchorCatalog(analysis) {
    const entries = [];
    [...ALLOWED_IMAGE_INSERTION_SECTIONS].forEach((section, sectionIndex) => {
        const bounds = findSectionBounds(analysis, section);
        if (!bounds) return;
        const sectionText = analysis.slice(bounds.contentStart, bounds.end);
        const paragraphs = sectionText.split(/\n\s*\n/).map(text => text.trim()).filter(text =>
            text && !/^!\[/.test(text) && !/^#{1,6}\s/.test(text)
        );
        paragraphs.forEach((text, paragraphIndex) => entries.push({
            id: `s${sectionIndex + 1}p${paragraphIndex + 1}`,
            section,
            text,
            preview: sanitizeImagePlanText(text, 160)
        }));
    });
    return entries;
}

function formatImageAnchorCatalog(analysis) {
    const entries = buildImageAnchorCatalog(analysis);
    if (entries.length === 0) return '无可用段落定位点';
    return entries.map(entry => `${entry.id} | ${entry.section} | ${entry.preview}`).join('\n');
}

function sanitizeMarkdownImageAlt(caption, fallback) {
    const singleLine = String(caption || fallback || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
    return singleLine
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function sanitizeLogField(value, maxChars = 180) {
    const clean = String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
}

function buildImageInsertionBlock(plan, imageInfo) {
    const parts = [];
    if (plan.lead) parts.push(plan.lead);
    const alt = sanitizeMarkdownImageAlt(imageInfo.caption, `图${plan.imageNumber}`);
    parts.push(`![${alt}](${imageInfo.url})`);
    if (plan.explanation) parts.push(plan.explanation);
    return parts.join('\n\n');
}

function paragraphEndAfter(text, offset) {
    const paragraphEnd = text.indexOf('\n\n', offset);
    return paragraphEnd >= 0 ? paragraphEnd : text.length;
}

function insertImageBlockIntoSection(analysis, plan, imageInfo) {
    const bounds = findSectionBounds(analysis, plan.section);
    const diagnostics = {
        imageNumber: plan.imageNumber,
        section: plan.section,
        paragraphId: plan.paragraphId || '',
        anchorProvided: Boolean(plan.anchor),
        anchorMatched: false,
        fallbackToSectionEnd: false,
        inserted: false
    };
    if (!bounds) return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'section_not_found' } };

    const block = buildImageInsertionBlock(plan, imageInfo);
    let sectionText = analysis.slice(bounds.contentStart, bounds.end);
    if (!plan.anchor) {
        return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'anchor_required' } };
    }
    const anchorIndex = sectionText.indexOf(plan.anchor);
    if (anchorIndex < 0) {
        return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'anchor_not_found' } };
    }
    diagnostics.anchorMatched = true;
    const insertOffset = paragraphEndAfter(sectionText, anchorIndex + plan.anchor.length);

    const beforeSection = analysis.slice(0, bounds.contentStart);
    const afterSection = analysis.slice(bounds.end);
    const beforeInsert = sectionText.slice(0, insertOffset).replace(/\s+$/, '');
    const afterInsert = sectionText.slice(insertOffset).replace(/^\s+/, '\n\n');

    return {
        analysis: `${beforeSection}${beforeInsert}\n\n${block}\n\n${afterInsert}${afterSection}`.replace(/\n{4,}/g, '\n\n\n'),
        inserted: true,
        diagnostics: { ...diagnostics, inserted: true }
    };
}

function normalizeGenericImageOrder(analysis, selectedImageUrls) {
    let updated = analysis;
    let genericAltIndex = 0;
    updated = updated.replace(/!\[图\d+\]\(([^)]+)\)/g, (match, url) => {
        if (!selectedImageUrls.includes(url)) return match;
        genericAltIndex++;
        return `![图${genericAltIndex}](${url})`;
    });

    const selectedSet = new Set(selectedImageUrls);
    const orderedSelectedImageUrls = [];
    for (const match of updated.matchAll(/!\[(?:\\.|[^\]\\])*\]\(([^)]+)\)/g)) {
        const url = match[1];
        if (selectedSet.has(url) && !orderedSelectedImageUrls.includes(url)) {
            orderedSelectedImageUrls.push(url);
        }
    }
    return { analysis: updated, selectedImageUrls: orderedSelectedImageUrls };
}

function applyImageInsertionPlan(analysis, plans, imageInfos, maxInsertions = IMAGE_INSERTION_MAX) {
    let updated = analysis;
    const anchorCatalog = new Map(buildImageAnchorCatalog(analysis).map(entry => [entry.id, entry]));
    const resolvedPlans = plans.map(plan => {
        if (!plan.paragraphId) return plan;
        const entry = anchorCatalog.get(plan.paragraphId);
        if (!entry || entry.section !== plan.section) {
            return { ...plan, anchorResolutionError: 'paragraph_id_not_found' };
        }
        return { ...plan, anchor: entry.text };
    });
    const selectedImageUrls = [];
    const insertionDiagnostics = [];
    for (const plan of resolvedPlans) {
        if (selectedImageUrls.length >= maxInsertions) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: Boolean(plan.anchor),
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: 'insertion_limit'
            });
            continue;
        }
        const imageInfo = imageInfos[plan.imageNumber - 1];
        if (!imageInfo) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: Boolean(plan.anchor),
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: 'image_not_found'
            });
            continue;
        }
        if (plan.anchorResolutionError) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: false,
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: plan.anchorResolutionError
            });
            continue;
        }
        const result = insertImageBlockIntoSection(updated, plan, imageInfo);
        insertionDiagnostics.push(result.diagnostics);
        if (!result.inserted) continue;
        updated = result.analysis;
        selectedImageUrls.push(imageInfo.url);
    }

    updated = removeUnapprovedMarkdownImages(updated, selectedImageUrls);
    return { ...normalizeGenericImageOrder(updated, selectedImageUrls), insertionDiagnostics };
}

async function applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages) {
    if (!isDualModel || downloadedImages.length === 0) {
        return { analysis, selectedImageUrls: [] };
    }

    const imageInfoByUrl = new Map(imageInfos.map(info => [info.url, info]));
    const usableImageInfos = downloadedImages.map(img => imageInfoByUrl.get(img.url) || { url: img.url, caption: '' });

    const secondaryApiType = detectApiType(SECONDARY_CONFIG.endpoint, SECONDARY_CONFIG.model);
    const secondaryUrl = new URL(buildApiUrl(secondaryApiType, SECONDARY_CONFIG.endpoint));
    const secondaryEndpointSource = SECONDARY_MODEL_CONFIG.endpoint ? '副模型 endpoint' : '复用主模型 endpoint';
    const secondaryKeySource = SECONDARY_MODEL_CONFIG.key ? '副模型 key' : '复用主模型 key';
    const downloadedBase64Chars = downloadedImages.reduce((sum, img) => sum + (img.base64?.length || 0), 0);
    console.log(`    [secondary] ▶ 图片筛选开始 | paper=${arxivId} | model=${SECONDARY_CONFIG.model} | protocol=${secondaryApiType}`);
    console.log(`    [secondary]    endpoint=${secondaryUrl.hostname}${secondaryUrl.pathname} | endpoint_source=${secondaryEndpointSource} | key_source=${secondaryKeySource}`);
    console.log(`    [secondary]    candidates=${imageInfos.length} | downloaded=${downloadedImages.length} | prompt_images=${usableImageInfos.length} | base64_chars=${downloadedBase64Chars} | max_tokens=${API_MAX_TOKENS}`);
    usableImageInfos.forEach((info, index) => {
        const downloaded = downloadedImages[index];
        console.log(`    [secondary]    input[${index + 1}] ${safeImageLabel(info.url)} | mime=${downloaded?.mime || 'unknown'} | base64_chars=${downloaded?.base64?.length || 0} | caption=${sanitizeLogField(info.caption || '无描述')}`);
    });

    const imageListStr = usableImageInfos.map((info, i) =>
        `候选${i + 1}: ${safeImageLabel(info.url)}\n  URL: ${info.url}\n  caption: ${sanitizeImagePlanText(info.caption || '无描述', 500)}`
    ).join('\n\n');
    const supplementPrompt = loadPrompt('prompts/image-supplement.md', {
        title: paper.title,
        arxivId,
        imageList: imageListStr,
        anchorCatalog: formatImageAnchorCatalog(analysis),
        primaryAnalysis: analysis
    });
    const promptSha256 = crypto.createHash('sha256').update(supplementPrompt).digest('hex');

    const supplementContent = [{ type: 'text', text: supplementPrompt }];
    for (const img of downloadedImages) {
        supplementContent.push(buildImageContent(img.url, img.base64, img.mime));
    }

    console.log(`    [secondary]    request_content_blocks=${supplementContent.length} | text_chars=${supplementPrompt.length}`);
    const secondaryBudget = createActiveTimeBudget(Number.MAX_SAFE_INTEGER);
    let planText;
    try {
        planText = await callModelWithConfig(
            [{ role: 'user', content: supplementContent }],
            API_MAX_TOKENS, 3, { ...SECONDARY_CONFIG, temperature: IMAGE_PLAN_TEMPERATURE }
        );
    } finally {
        secondaryBudget.stop();
    }

    const plans = parseImageInsertionPlan(planText, usableImageInfos);
    const responseSha256 = crypto.createHash('sha256').update(planText).digest('hex');
    const parseDiagnostics = plans.diagnostics || { status: 'unknown', rejectedItems: 0, replacementIgnored: 0, rejectionReasons: [] };
    console.log(`    [secondary] ◀ 图片筛选返回 | active_duration_s=${(secondaryBudget.elapsedMs() / 1000).toFixed(1)} | response_chars=${planText.length} | parse_status=${parseDiagnostics.status} | valid_insertions=${plans.length} | rejected=${parseDiagnostics.rejectedItems} | replacement_ignored=${parseDiagnostics.replacementIgnored}`);
    if (parseDiagnostics.rejectionReasons?.length > 0) {
        console.log(`    [secondary]    rejected_reasons=${sanitizeLogField(parseDiagnostics.rejectionReasons.join(','), 300)}`);
    }
    if (parseDiagnostics.error) {
        console.log(`    [secondary]    parse_error=${sanitizeLogField(parseDiagnostics.error, 240)}`);
    }
    if (plans.length > 0) {
        plans.forEach((plan, index) => {
            const imageInfo = usableImageInfos[plan.imageNumber - 1];
            console.log(`    [secondary]    plan[${index + 1}] candidate=${plan.imageNumber}(${safeImageLabel(imageInfo?.url)}) | section=${plan.section} | paragraph_id=${plan.paragraphId || 'legacy_anchor'} | anchor_provided=${Boolean(plan.anchor)} | lead_chars=${plan.lead.length} | explanation_chars=${plan.explanation.length}`);
        });
    }
    if (plans.length === 0) {
        console.log(`    [secondary] ℹ️  未生成有效插图计划，保留主模型纯文本分析 | reason=${parseDiagnostics.status}`);
        return {
            analysis,
            selectedImageUrls: [],
            parseDiagnostics,
            supplementDiagnostics: {
                model: SECONDARY_CONFIG.model,
                temperature: IMAGE_PLAN_TEMPERATURE,
                promptSha256,
                responseSha256,
                insertionDiagnostics: []
            }
        };
    }

    const { analysis: replaced, selectedImageUrls, insertionDiagnostics } = applyImageInsertionPlan(analysis, plans, usableImageInfos);
    insertionDiagnostics.forEach((item, index) => {
        console.log(`    [secondary]    merge[${index + 1}] candidate=${item.imageNumber} | section=${item.section} | paragraph_id=${item.paragraphId || 'legacy_anchor'} | anchor_provided=${item.anchorProvided} | anchor_matched=${item.anchorMatched} | fallback_section_end=${item.fallbackToSectionEnd} | inserted=${item.inserted}${item.rejectionReason ? ` | rejection=${item.rejectionReason}` : ''}`);
    });
    const insertedCount = insertionDiagnostics.filter(item => item.inserted).length;
    console.log(`    [secondary] ✅ 图片计划合并完成 | inserted=${insertedCount}/${plans.length} | selected=${selectedImageUrls.map(safeImageLabel).join(', ') || 'none'}`);

    return {
        analysis: replaced,
        selectedImageUrls,
        insertionDiagnostics,
        parseDiagnostics,
        supplementDiagnostics: {
            model: SECONDARY_CONFIG.model,
            temperature: IMAGE_PLAN_TEMPERATURE,
            promptSha256,
            responseSha256,
            insertionDiagnostics
        }
    };
}

/**
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper) {
    const arxivId = getPaperArxivId(paper);
    const previousScore = Number.parseFloat(paper?.parsed?.score);
    const analysisManifest = createAnalysisRecoveryManifest(paper);
    console.log(`    [deep] 获取全文: ${arxivId}`);

    // 优先使用预提供的全文（ICML/会议场景），否则从 arXiv 抓取
    let fullText = paper.fullText || paper.pdfText || '';
    let sourceDetails = {
        source: fullText ? (paper.fullText ? 'provided_full_text' : 'provided_pdf_text') : 'unavailable',
        sourceId: '',
        imageInfos: [],
        htmlAvailability: 'unknown',
        htmlAttempts: 0,
        warnings: []
    };
    if (!fullText && /^\d+\.\d+/.test(arxivId)) {
        try {
            sourceDetails = await fetchArxivTextDetailed(arxivId);
            fullText = sourceDetails.text;
            console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
        } catch (e) {
            sourceDetails.warnings.push(`全文抓取异常: ${e.message}`);
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }
    } else if (fullText) {
        console.log(`    [deep] 使用预提供全文: ${fullText.length} 字符`);
    }

    const hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;
    const abstractText = paper.abstract || paper.summary || '';
    const rawTextForAnalysis = hasFullText ? fullText : (abstractText || fullText);
    const textForAnalysis = rawTextForAnalysis.length > FULL_TEXT_MAX_CHARS
        ? rawTextForAnalysis.slice(0, FULL_TEXT_MAX_CHARS)
        : rawTextForAnalysis;
    if (rawTextForAnalysis.length > textForAnalysis.length) {
        sourceDetails.warnings.push(`输入文本由 ${rawTextForAnalysis.length} 字符截断为 ${textForAnalysis.length} 字符`);
        console.log(`    [deep] 全文过长，截断到 ${textForAnalysis.length}/${rawTextForAnalysis.length} 字符`);
    }
    const analysisSource = hasFullText ? sourceDetails.source : 'abstract';
    const sourceWarnings = [...sourceDetails.warnings];
    if (!hasFullText && sourceDetails.source === 'unavailable') {
        sourceWarnings.push('全文不可用，本次分析仅使用摘要');
    }
    const sourceProvenance = {
        analysisSource,
        sourceId: sourceDetails.sourceId || '',
        sourceTextChars: rawTextForAnalysis.length,
        usedTextChars: textForAnalysis.length,
        fullTextChars: fullText.length,
        fullTextAvailable: hasFullText,
        truncated: rawTextForAnalysis.length > textForAnalysis.length,
        sourceSha256: crypto.createHash('sha256').update(rawTextForAnalysis).digest('hex'),
        analysisConfidence: hasFullText ? 'full_text' : 'degraded_abstract',
        htmlAvailability: sourceDetails.htmlAvailability,
        htmlAttempts: sourceDetails.htmlAttempts,
        warnings: sourceWarnings
    };
    const previousSource = analysisManifest.sourceAcquisition;
    if (paper.analysisCheckpoint && (!previousSource?.sourceSha256 || previousSource.sourceSha256 !== sourceProvenance.sourceSha256)) {
        for (const stage of RECOVERY_STAGE_ORDER) delete analysisManifest.stages[stage];
        delete paper.analysisCheckpoint;
        console.log(`    [deep] ⚠️  checkpoint 文本来源指纹变化，已清除主分析及下游恢复状态`);
    }
    analysisManifest.sourceAcquisition = sourceProvenance;
    console.log(`    [deep] 文本来源: ${analysisSource} | chars=${rawTextForAnalysis.length} | confidence=${sourceProvenance.analysisConfidence} | warnings=${sourceWarnings.length}`);

    if (!textForAnalysis || textForAnalysis.trim().length < 10) {
        console.log(`    [deep] ⚠️  论文无有效文本内容（全文和摘要均为空），无法分析`);
        return { ...paper, ...sourceProvenance, sourceWarnings, analysis: null, analysisManifest, error: '论文无有效文本内容' };
    }

    // 优先使用预提供的图片 URL（ICML/会议场景），否则从 arXiv 抓取
    let imageInfos = [];
    const preProvidedUrls = getPreProvidedImageUrls(paper);
    if (preProvidedUrls.length > 0) {
        imageInfos = mergeImageInfoMetadata(preProvidedUrls, sourceDetails.imageInfos);
        console.log(`    [deep] 使用预提供图片: ${imageInfos.length} 张`);
    } else if (sourceDetails.imageInfos.length > 0) {
        imageInfos = normalizeImageInfos(sourceDetails.imageInfos);
        console.log(`    [deep] 复用全文 HTML 中的图片元数据: ${imageInfos.length} 张`);
    } else if (/^\d+\.\d+/.test(arxivId)) {
        try {
            imageInfos = await fetchArxivImageUrls(arxivId, {
                htmlAvailability: sourceDetails.htmlAvailability
            });
            console.log(`    [deep] 找到 ${imageInfos.length} 张图片`);
        } catch (e) {
            console.log(`    [deep] 获取图片失败: ${e.message}`);
        }
    }

    // 提取纯 URL 列表用于下载和保存
    const imageUrls = imageInfos.map(info => info.url);
    const candidateImageInfos = selectImageCandidates(imageInfos, IMAGE_CANDIDATE_MAX);
    const candidateImageUrls = candidateImageInfos.map(info => info.url);
    const candidateUrlSet = new Set(candidateImageUrls);
    const candidateRankByUrl = new Map(candidateImageInfos.map((info, index) => [info.url, index + 1]));
    const imageManifest = {
        totalFound: imageInfos.length,
        candidateLimit: IMAGE_CANDIDATE_MAX,
        downloadLimit: IMAGE_MAX_COUNT,
        maxImageBytes: IMAGE_MAX_BYTES,
        maxImageBase64Chars: IMAGE_MAX_BASE64_CHARS,
        maxTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        candidates: imageInfos.map((info, index) => ({
            url: info.url,
            caption: info.caption || '',
            sourceOrder: Number.isInteger(info.sourceOrder) ? info.sourceOrder : index,
            score: Number.isFinite(info.candidateScore)
                ? info.candidateScore
                : scoreImageCandidate(info, Number.isInteger(info.sourceOrder) ? info.sourceOrder : index),
            downloadPriority: candidateRankByUrl.get(info.url) || null,
            selectedForDownload: candidateUrlSet.has(info.url)
        })),
        downloaded: [],
        selected: Array.isArray((paper?.analysisRecoveryImageManifest || paper?.imageManifest)?.selected)
            ? [...(paper.analysisRecoveryImageManifest || paper.imageManifest).selected]
            : []
    };
    markRecoveryStage(
        analysisManifest,
        'imageDiscovery',
        imageInfos.length > 0 ? 'complete' : 'no_candidates',
        { totalFound: imageInfos.length, candidateCount: candidateImageInfos.length }
    );
    if (imageInfos.length > candidateImageInfos.length) {
        console.log(`    [deep] 图片候选预筛: ${imageInfos.length} → ${candidateImageInfos.length} 张`);
    }

    const hasFullTextIntro = hasFullText
        ? (sourceProvenance.truncated ? '以下是论文全文节选，请只依据已提供内容分析。' : '以下是论文全文，请仔细阅读所有技术细节。')
        : '以下是论文摘要；由于全文不可用，请降低事实判断和评分置信度，不得声称已经核对全文细节。';

    const downloadedImages = isDualModel
        ? await downloadImagesSerial(candidateImageUrls, IMAGE_MAX_COUNT, IMAGE_MAX_BASE64_CHARS, IMAGE_TOTAL_BASE64_CHARS)
        : [];
    const downloadOutcomes = downloadedImages.outcomes || [];
    imageManifest.downloaded = downloadedImages.map(img => ({
        url: img.url,
        mime: img.mime,
        base64Chars: img.base64.length,
        sha256: img.sha256,
        cacheHit: Boolean(img.cacheHit)
    }));
    imageManifest.downloadOutcomes = downloadOutcomes;
    if (isDualModel) {
        console.log(`    [deep] 成功下载 ${downloadedImages.length}/${candidateImageUrls.length} 张候选图片（总图片 ${imageUrls.length} 张）`);
    } else if (candidateImageUrls.length > 0) {
        console.log(`    [deep] 单模型模式：跳过 ${candidateImageUrls.length} 张候选图片下载，仅保存候选元数据`);
    }
    const downloadStatus = !isDualModel
        ? 'skipped'
        : candidateImageUrls.length === 0
            ? 'no_candidates'
            : downloadedImages.length > 0
                ? 'complete'
                : downloadOutcomes.some(item => item.status === 'transient_failure')
                    ? 'transient_failure'
                    : 'no_downloadable_images';
    markRecoveryStage(analysisManifest, 'imageDownload', downloadStatus, {
        attempted: candidateImageUrls.length,
        downloaded: downloadedImages.length,
        outcomes: downloadOutcomes
    });

    const prompt = loadPrompt('prompts/deep-analysis.md', {
        hasFullText: hasFullTextIntro,
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        arxivId: arxivId,
        textForAnalysis: textForAnalysis
    });

    let analysis = isRecoveryStageComplete(analysisManifest, 'primaryAnalysis')
        ? String(paper.analysisCheckpoint || '')
        : '';
    if (!analysis && analysisManifest.stages.primaryAnalysis) {
        markRecoveryStage(analysisManifest, 'primaryAnalysis', 'pending', { reason: 'checkpoint_missing' });
    }
    // Round 1: Main analysis
    if (analysis) {
        console.log(`    [deep] ↩ 从主分析 checkpoint 恢复 (${analysis.length} chars)`);
    } else if (isDualModel && downloadedImages.length > 0) {
        // ========== 双模型模式 ==========
        console.log(`    [deep] 🧠 双模型模式：主模型(${DEEP_CONFIG.model})先做文本分析，后续由副模型(${SECONDARY_CONFIG.model})最终筛图补充`);

        // Round 1a: Primary model (text-only)
        try {
            analysis = await callModelWithConfig(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS, 3, DEEP_CONFIG
            );
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 主模型文本分析完成 (${analysis.length} chars)`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 主模型文本分析失败: ${err.message}`);
            return { ...paper, ...sourceProvenance, sourceWarnings, analysis: null, analysisManifest, imageManifest, error: err.message };
        }
    } else {
        // ========== 单模型模式：仅文本分析，不分析图片 ==========
        if (downloadedImages.length > 0) {
            console.log(`    [deep] 未配置副模型，跳过图片分析 (${downloadedImages.length} 张图片仅用于元数据)`);
        } else {
            console.log(`    [deep] 无可用图片，仅文本分析`);
        }

        try {
            analysis = await callModel(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS
            );
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 文本分析完成`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 文本分析失败: ${err.message}`);
            return { ...paper, ...sourceProvenance, sourceWarnings, analysis: null, analysisManifest, imageManifest, error: err.message };
        }
    }

    let selectedImageUrls = [...imageManifest.selected];

    // 第2轮：开源扫描
    if (!isRecoveryStageComplete(analysisManifest, 'openSourceScan')) {
        try {
            const ossText = await scanOpensource(paper, textForAnalysis);
            if (ossText) {
                analysis = mergeSectionByTitle(analysis, '开源详情', ossText);
                analysis = syncResourceFieldsFromOpenSource(analysis, ossText);
                console.log(`    [deep] ✅ 开源扫描完成`);
            }
            markRecoveryStage(analysisManifest, 'openSourceScan', ossText ? 'complete' : 'invalid_output');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            if (!ossText) {
                const error = new Error('开源扫描输出为空');
                error.code = 'INVALID_STAGE_OUTPUT';
                throw error;
            }
        } catch (e) {
            markRecoveryStage(analysisManifest, 'openSourceScan', e.code === 'INVALID_STAGE_OUTPUT' ? 'invalid_output' : 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ⚠️  开源扫描失败: ${e.message}`);
            throw e;
        }
    }

    // 第2.5轮：检查 demo 页面中的开源链接
    let demoFoundLinks = [];
    if (!isRecoveryStageComplete(analysisManifest, 'demoLinkScan')) {
        let demoScanError = null;
        try {
            if (!hasOpenSourceLinks(analysis)) {
                const demoUrls = extractDemoUrls(analysis);
                if (demoUrls.length > 0) {
                    console.log(`    [deep] 🔍 发现 ${demoUrls.length} 个 demo 页面，检查开源链接...`);
                    const allOpenSourceLinks = [];
                    for (const url of demoUrls.slice(0, 3)) { // 最多检查3个
                        const links = await checkDemoPageForOpensource(url);
                        allOpenSourceLinks.push(...links);
                    }
                    if (allOpenSourceLinks.length > 0) {
                        demoFoundLinks = [...new Set(allOpenSourceLinks)];
                        console.log(`    [deep] ✅ 从 demo 页面发现 ${demoFoundLinks.length} 个开源链接`);
                    } else {
                        console.log(`    [deep] ℹ️  demo 页面未发现开源链接`);
                    }
                }
            }
        } catch (e) {
            demoScanError = e;
            console.log(`    [deep] ⚠️  检查 demo 页面失败: ${e.message}`);
            markRecoveryStage(analysisManifest, 'demoLinkScan', 'transient_failure', { error: e.message });
        }

        // 第2.6轮：根据 demo 扫描结果更新开源评分和描述
        if (demoFoundLinks.length > 0) {
            const beforeUpdate = analysis;
            analysis = updateOpensourceFromDemoLinks(analysis, demoFoundLinks);
            if (analysis !== beforeUpdate) {
                console.log(`    [deep] ✅ 已根据 demo 扫描结果更新开源评分/描述`);
            }
        }
        if (!demoScanError) {
            markRecoveryStage(analysisManifest, 'demoLinkScan', 'complete', { linksFound: demoFoundLinks.length });
        }
        saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        if (demoScanError) throw demoScanError;
    }

    // 第3轮：审校重写（对照原文修正、补充、删减，完全重写前两轮输出）
    if (!isRecoveryStageComplete(analysisManifest, 'revision')) {
        try {
            const revisedText = await reviseAnalysis(paper, analysis, textForAnalysis);
            const cleaned = revisedText && revisedText.length > 100
                ? cleanGapFillPrefix(revisedText.trim())
                : null;
            if (!cleaned) {
                const error = new Error('审校重写输出无效或缺少 ## 评分');
                error.code = 'INVALID_STAGE_OUTPUT';
                throw error;
            }
            analysis = cleaned;
            analysis = syncResourceFieldsFromOpenSource(
                analysis,
                extractSectionByTitle(analysis, '开源详情')
            );
            markRecoveryStage(analysisManifest, 'revision', 'complete');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 审校重写完成`);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'revision', e.code === 'INVALID_STAGE_OUTPUT' ? 'invalid_output' : 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.5轮：检查并修复实验结果中缺失的表格
    if (!isRecoveryStageComplete(analysisManifest, 'tableRepair')) {
        try {
            const fixed = await checkAndFixTables(paper, analysis, textForAnalysis);
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 表格补充完成`);
            }
            markRecoveryStage(analysisManifest, 'tableRepair', changed ? 'complete' : 'not_needed');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'tableRepair', 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.6轮：检查并修复方法概述部分不够详细的问题
    if (!isRecoveryStageComplete(analysisManifest, 'methodRepair')) {
        try {
            const fixed = await checkAndFixMethodSection(paper, analysis, textForAnalysis);
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 方法概述补充完成`);
            }
            markRecoveryStage(analysisManifest, 'methodRepair', changed ? 'complete' : 'not_needed');
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'methodRepair', 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.65轮：修复缺失/重复章节、机器摘要和标签契约。
    if (!isRecoveryStageComplete(analysisManifest, 'structureRepair')) {
        const preNormalizationIssues = getRepairableAnalysisStructureIssues(analysis);
        const normalizedStructure = normalizeAnalysisStructure(analysis);
        const normalizedChanged = normalizedStructure !== analysis;
        if (normalizedChanged) {
            analysis = normalizedStructure;
            console.log(`    [deep] ✅ 已确定性规范化结构 | categories=${sanitizeLogField(preNormalizationIssues.join('、') || '空白/数值表示', 500)}`);
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        }
        const structureIssues = getRepairableAnalysisStructureIssues(analysis);
        try {
            if (structureIssues.length > 0) {
                console.log(`    [deep] 🔧 检测到结构契约问题，执行最终结构修复: ${structureIssues.join('、')}`);
                analysis = await repairMissingAnalysisSections(paper, analysis, textForAnalysis);
                console.log(`    [deep] ✅ 最终结构修复完成`);
            }
            markRecoveryStage(analysisManifest, 'structureRepair', structureIssues.length > 0 ? 'complete' : 'not_needed', {
                deterministicNormalization: normalizedChanged,
                normalizationIssues: preNormalizationIssues
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(analysisManifest, 'structureRepair', 'transient_failure', { error: error.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 第3.7轮：主模型只审计文档类型和八维评分，避免长文审校时发生重复扣分。
    const scoringStage = analysisManifest.stages.scoringAudit;
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const currentPromptTemplateSha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'scoring-audit.md')))
            .digest('hex');
        const currentEvidenceSha256 = crypto.createHash('sha256')
            .update(buildTypeAwareSourceContext(analysis, textForAnalysis))
            .digest('hex');
        const fingerprintChanged = scoringStage.model !== DEEP_CONFIG.model
            || scoringStage.temperature !== SCORING_AUDIT_TEMPERATURE
            || scoringStage.promptTemplateSha256 !== currentPromptTemplateSha256
            || scoringStage.evidenceSha256 !== currentEvidenceSha256;
        if (fingerprintChanged) {
            delete analysisManifest.stages.scoringAudit;
            delete analysisManifest.stages.imageSupplement;
            console.log(`    [deep] ⚠️  评分审计指纹变化，已失效评分与插图恢复状态`);
        }
    }
    if (!isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        try {
            const scoringResult = await auditTypeAwareScoringDetailed(analysis, textForAnalysis);
            analysis = scoringResult.analysis;
            const auditedParsed = parseAnalysis(analysis);
            const auditedInvalidReason = getInvalidAnalysisReason(analysis, auditedParsed);
            if (auditedInvalidReason) {
                const error = new Error(`评分审计后的分析未通过最终契约: ${auditedInvalidReason}`);
                error.code = 'CONTRACT_REJECTED';
                throw error;
            }
            const finalScore = Number.parseFloat(auditedParsed?.score);
            const scoreDelta = Number.isFinite(previousScore) && Number.isFinite(finalScore)
                ? Number((finalScore - previousScore).toFixed(1))
                : null;
            const stabilityWarning = scoreDelta !== null && Math.abs(scoreDelta) > 0.5;
            if (stabilityWarning) {
                console.log(`    [deep] ⚠️  评分稳定性告警: previous=${previousScore.toFixed(1)} | final=${finalScore.toFixed(1)} | delta=${scoreDelta > 0 ? '+' : ''}${scoreDelta.toFixed(1)}`);
            }
            markRecoveryStage(analysisManifest, 'scoringAudit', 'complete', {
                attempts: scoringResult.attempts,
                model: scoringResult.model,
                temperature: scoringResult.temperature,
                promptTemplateSha256: scoringResult.promptTemplateSha256,
                evidenceSha256: scoringResult.evidenceSha256,
                previousScore: Number.isFinite(previousScore) ? previousScore : null,
                finalScore: Number.isFinite(finalScore) ? finalScore : null,
                scoreDelta,
                stabilityWarning,
                audit: scoringResult.audit
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 类型感知评分审计完成`);
        } catch (error) {
            markRecoveryStage(analysisManifest, 'scoringAudit', error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure', { error: error.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 最后一轮：副模型基于最终文本筛选高价值图片，代码按 JSON 计划做受限局部插图合并。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
    if (isDualModel && downloadedImages.length > 0 && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        try {
            const imageResult = await applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages);
            const imageInvalidReason = getInvalidAnalysisReason(imageResult.analysis, parseAnalysis(imageResult.analysis));
            if (imageInvalidReason) {
                markRecoveryStage(analysisManifest, 'imageSupplement', 'contract_rejected', { error: imageInvalidReason });
                console.log(`    [deep] ⚠️  插图结果破坏最终契约，丢弃本篇插图计划: ${imageInvalidReason}`);
            } else {
                analysis = imageResult.analysis;
                selectedImageUrls = imageResult.selectedImageUrls;
                imageManifest.selected = selectedImageUrls;
                imageManifest.supplement = {
                    ...imageResult.supplementDiagnostics,
                    parseDiagnostics: imageResult.parseDiagnostics
                };
                const hasPlansButNoInsertion = imageResult.parseDiagnostics?.status === 'ok'
                    && selectedImageUrls.length === 0;
                const imageStatus = imageResult.parseDiagnostics?.status === 'empty_plan'
                    ? 'no_high_value_images'
                    : imageResult.parseDiagnostics?.status === 'ok' && !hasPlansButNoInsertion
                        ? 'complete'
                        : 'invalid_output';
                markRecoveryStage(analysisManifest, 'imageSupplement', imageStatus, {
                    parseStatus: imageResult.parseDiagnostics?.status || 'unknown',
                    selectedCount: selectedImageUrls.length,
                    rejectedInsertions: (imageResult.insertionDiagnostics || []).filter(item => !item.inserted)
                });
            }
        } catch (err) {
            markRecoveryStage(analysisManifest, 'imageSupplement', 'transient_failure', { error: err.message });
            console.log(`    [deep] ⚠️  副模型图片筛选失败: ${err.message}，保留纯文本分析结果`);
        }
    } else if (!analysisManifest.stages.imageSupplement) {
        const status = !isDualModel
            ? 'skipped'
            : candidateImageUrls.length === 0
                ? 'no_candidates'
                : downloadedImages.length === 0
                    ? (downloadStatus === 'no_downloadable_images' ? 'no_downloadable_images' : 'transient_failure')
                    : 'pending';
        markRecoveryStage(analysisManifest, 'imageSupplement', status, {
            reason: status === 'transient_failure' ? 'candidate_downloads_failed'
                : status === 'no_downloadable_images' ? 'all_candidates_permanently_rejected'
                    : undefined
        });
    }

    saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
    if (hasIncompleteRecoveryStage(analysisManifest)) {
        const incompleteStages = Object.entries(analysisManifest.stages)
            .filter(([, stage]) => !isRecoveryStageComplete({ stages: { current: stage } }, 'current'))
            .map(([stage, details]) => `${stage}:${details.status}`);
        return {
            ...paper,
            ...sourceProvenance,
            sourceWarnings,
            analysis: null,
            parsed: null,
            imageUrls: selectedImageUrls,
            selectedImageUrls,
            allImageUrls: imageUrls,
            imageManifest,
            analysisManifest,
            analysisCheckpoint: paper.analysisCheckpoint,
            error: `深度分析阶段未完成: ${incompleteStages.join(', ')}`
        };
    }
    delete paper.analysisCheckpoint;
    delete paper.analysisRecoveryImageManifest;

    return {
        ...paper,
        ...sourceProvenance,
        sourceWarnings,
        analysis: analysis,
        imageUrls: selectedImageUrls,
        selectedImageUrls,
        allImageUrls: imageUrls,
        imageManifest,
        analysisManifest,
        ...(paper.analysisCheckpoint ? { analysisCheckpoint: paper.analysisCheckpoint } : {})
    };
}

async function scanOpensource(paper, textForAnalysis) {
    const prompt = loadPrompt('prompts/opensource-scan.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], 8000);
}

/**
 * 从分析文本中提取 demo/项目页面 URL
 */
function extractDemoUrls(analysis) {
    const urls = [];
    // 匹配各种可能的 demo/项目页面链接
    const patterns = [
        /Demo[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /项目主页[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /在线演示[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /Homepage[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /Project[：:]\s*(https?:\/\/[^\s\)]+)/gi,
        /页面[：:]\s*(https?:\/\/[^\s\)]+)/gi,
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
            const url = match[1].trim();
            // 排除 arxiv、github、huggingface 等已知链接
            if (!url.includes('arxiv.org') && 
                !url.includes('github.com') && 
                !url.includes('huggingface.co') &&
                !url.includes('modelscope.cn')) {
                urls.push(url);
            }
        }
    }
    
    return [...new Set(urls)]; // 去重
}

/**
 * 访问 demo 页面，检查是否包含开源链接
 */
async function checkDemoPageForOpensource(demoUrl) {
    const openSourcePatterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/[\w\-]+\/[\w\-]+/gi,
        /gitlab\.com\/[\w\-]+\/[\w\-]+/gi,
    ];
    
    try {
        console.log(`    [deep] 🔍 检查 demo 页面: ${demoUrl}`);
        let currentUrl = demoUrl;
        let response;
        for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
            const parsedUrl = await validatePublicHttpUrl(currentUrl);
        const requestHostname = parsedUrl.validatedAddress || parsedUrl.hostname;
        
        // 使用 http/https 请求获取页面内容；不自动跟随重定向，避免被跳到内网地址。
            response = await new Promise((resolve, reject) => {
            const transport = parsedUrl.protocol === 'http:' ? http : https;
            const options = {
                hostname: requestHostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                servername: parsedUrl.hostname,
                headers: {
                    'Host': parsedUrl.host,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000,
            };
            
            const req = transport.request(options, (res) => {
                const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                if (contentType && !['text/html', 'application/xhtml+xml', 'application/xml', 'text/plain'].includes(contentType)) {
                    res.resume();
                    resolve({ status: res.statusCode, data: '', location: res.headers.location, skipped: `Content-Type=${contentType}` });
                    return;
                }
                const chunks = [];
                let total = 0;
                const maxBytes = 1024 * 1024;
                res.on('data', chunk => {
                    total += chunk.length;
                    if (total > maxBytes) {
                        req.destroy(new Error(`Demo page exceeds ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf8'), location: res.headers.location }));
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
            req.end();
            });

            if (response.status >= 300 && response.status < 400 && response.location) {
                if (redirectCount >= 3) {
                    console.log('    [deep] ⚠️  Demo 页面重定向超过 3 次');
                    return [];
                }
                const nextUrl = new URL(response.location, parsedUrl).href;
                console.log(`    [deep] ↪ Demo 页面重定向: ${currentUrl} → ${nextUrl}`);
                currentUrl = nextUrl;
                continue;
            }
            break;
        }
        
        if (response.skipped) {
            console.log(`    [deep] ⚠️  Demo 页面跳过: ${response.skipped}`);
            return [];
        }
        if (response.status !== 200) {
            console.log(`    [deep] ⚠️  Demo 页面返回 ${response.status}`);
            return [];
        }
        
        const html = response.data;
        const foundLinks = [];
        
        for (const pattern of openSourcePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                foundLinks.push(match[0]);
            }
        }
        
        return [...new Set(foundLinks)];
    } catch (err) {
        console.log(`    [deep] ⚠️  访问 demo 页面失败: ${err.message}`);
        return [];
    }
}

function isPrivateIpAddress(address) {
    const ipType = net.isIP(address);
    if (ipType === 4) {
        const parts = address.split('.').map(n => Number.parseInt(n, 10));
        const [a, b] = parts;
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51) ||
            (a === 203 && b === 0) ||
            (a >= 224)
        );
    }
    if (ipType === 6) {
        const lower = address.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIpAddress(mapped[1]);
        const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = Number.parseInt(mappedHex[1], 16);
            const lo = Number.parseInt(mappedHex[2], 16);
            return isPrivateIpAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
        return (
            lower === '::1' ||
            lower === '::' ||
            lower.startsWith('fc') ||
            lower.startsWith('fd') ||
            lower.startsWith('fe80')
        );
    }
    return true;
}

async function validatePublicHttpUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`不支持的公网 URL 协议: ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new Error('公网 URL 不允许包含用户名或密码');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('公网 URL 指向 localhost');
    }
    if (net.isIP(hostname)) {
        if (isPrivateIpAddress(hostname)) throw new Error(`URL 指向非公网 IP: ${hostname}`);
        url.validatedAddress = hostname;
        return url;
    }
    const records = await dns.lookup(hostname, { all: true, verbatim: false });
    if (!records || records.length === 0) {
        throw new Error(`公网 URL DNS 解析为空: ${hostname}`);
    }
    for (const record of records) {
        if (isPrivateIpAddress(record.address)) {
            throw new Error(`公网 URL DNS 解析到非公网 IP: ${record.address}`);
        }
    }
    url.validatedAddress = records[0].address;
    return url;
}

/**
 * 检查分析中是否已有开源链接
 */
function hasOpenSourceLinks(analysis) {
    const patterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/[\w\-]+\/[\w\-]+/gi,
    ];
    
    for (const pattern of patterns) {
        if (pattern.test(analysis)) return true;
    }
    return false;
}

async function reviseAnalysis(paper, existingAnalysis, textForAnalysis) {
    const prompt = loadPrompt('prompts/gap-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        existingAnalysis: existingAnalysis,
        textForAnalysis: textForAnalysis
    });
    return await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
}

function replaceOrInsertRequiredSection(analysis, title, content) {
    if (findSectionBounds(analysis, title)) return mergeSectionByTitle(analysis, title, content);
    const index = REQUIRED_ANALYSIS_SECTIONS.indexOf(title);
    const following = REQUIRED_ANALYSIS_SECTIONS.slice(index + 1);
    for (const nextTitle of following) {
        const next = new RegExp(`(^|\\n)##\\s*${escapeRegExp(nextTitle)}[：:\\s]*\\n`, 'm').exec(analysis);
        if (next) {
            const insertAt = next.index + next[1].length;
            return `${analysis.slice(0, insertAt)}## ${title}\n${content.trim()}\n\n${analysis.slice(insertAt)}`;
        }
    }
    return `${analysis.trim()}\n\n## ${title}\n${content.trim()}`;
}

function normalizeUnexpectedTopLevelHeadings(analysis) {
    return String(analysis || '').replace(/^##\s*([^\n]+?)\s*$/gm, (line, rawTitle) => {
        const cleanTitle = rawTitle.replace(/^#+\s*/, '').replace(/[：:]\s*$/, '').trim();
        return REQUIRED_ANALYSIS_SECTIONS.includes(cleanTitle)
            ? `## ${cleanTitle}`
            : `### ${cleanTitle}`;
    });
}

function normalizeMachineEnum(value, allowed, fallback) {
    const text = String(value || '').trim();
    if (allowed.includes(text)) return text;
    if (/^(?:是|有|已|提供|声称)/.test(text)) return allowed.includes('是') ? '是' : fallback;
    if (/^(?:否|无|未提供|不提供|没有|未开源)/.test(text)) return allowed.includes('否') ? '否' : fallback;
    if (/未说明|未知|不明确|未提及|待确认/.test(text)) return allowed.includes('未说明') ? '未说明' : fallback;
    return fallback;
}

function normalizeMachineScore(value, maximum, anchors) {
    const numeric = Number(value);
    const bounded = Number.isFinite(numeric) ? Math.min(maximum, Math.max(0, numeric)) : 0;
    const normalized = Math.round((bounded + Number.EPSILON) * 10) / 10;
    if (!anchors) return normalized.toFixed(1);
    const nearest = anchors.reduce((best, anchor) =>
        Math.abs(anchor - normalized) < Math.abs(best - normalized) ? anchor : best, anchors[0]);
    return nearest.toFixed(1);
}

function normalizeAnalysisStructure(analysis) {
    let updated = normalizeUnexpectedTopLevelHeadings(analysis);
    const originalMachine = extractSectionByTitle(updated, '机器摘要');
    if (!originalMachine) return updated;

    const aliases = {
        '文档类型': 'document_type', '分档': 'rank_bucket', '置信度': 'confidence',
        '主任务标签': 'primary_task_tag', '主方法标签': 'primary_method_tag',
        '是否SOTA': 'sota_claim', '是否开源代码': 'has_code',
        '是否开源模型': 'has_model', '是否开源数据': 'has_dataset'
    };
    const values = {};
    const discoveredTags = [];
    for (const rawLine of originalMachine.split('\n')) {
        discoveredTags.push(...(rawLine.match(/#[^\s#，,;；、]+/g) || []));
        const match = rawLine.trim().match(/^([^:：]+)\s*[:：]\s*(.*?)$/);
        if (!match) continue;
        const key = aliases[match[1].trim()] || match[1].trim();
        if (REQUIRED_MACHINE_SUMMARY_KEYS.includes(key) && values[key] === undefined) {
            values[key] = match[2].trim();
        }
    }

    const parsedBefore = parseAnalysis(updated) || {};
    const scoreFallbacks = {
        innovation: parsedBefore.innovationScore,
        technical_rigor: parsedBefore.technicalRigorScore,
        experimental_sufficiency: parsedBefore.experimentalSufficiencyScore,
        clarity: parsedBefore.clarityScore,
        impact: parsedBefore.impactScore,
        open_source: parsedBefore.openSourceScore,
        reproducibility: parsedBefore.reproducibilityScore,
        engineering_score: parsedBefore.engineeringScore
    };
    for (const [key, fallback] of Object.entries(scoreFallbacks)) {
        if (parsedBefore.scoreValidation?.valid && fallback !== undefined && fallback !== '') {
            // 评分理由是八维分项的唯一事实来源。覆盖机器摘要中的漂移值，
            // 同时保证 open_source 落在固定锚点上，避免无意义的 LLM 结构修复循环。
            values[key] = fallback;
        } else if (!values[key] && fallback !== undefined && fallback !== '') {
            values[key] = fallback;
        }
    }
    const documentTypes = ['方法研究', '系统技术报告', '模型报告', '数据集与基准', '综述', '理论研究', '应用研究'];
    const documentAliases = {
        '技术报告': '系统技术报告', 'Tech Report': '系统技术报告', 'tech report': '系统技术报告',
        '白皮书': '系统技术报告', '模型卡': '模型报告', '数据集': '数据集与基准'
    };
    const documentCandidate = documentAliases[values.document_type] || values.document_type;
    values.document_type = documentTypes.includes(documentCandidate)
        ? documentCandidate
        : (documentTypes.includes(parsedBefore.documentType) ? parsedBefore.documentType : '方法研究');
    values.rank_bucket = normalizeMachineEnum(
        parsedBefore.rankBucket || values.rank_bucket,
        ['前10%', '前25%', '前50%', '后50%'],
        '后50%'
    );
    values.confidence = normalizeMachineEnum(
        values.confidence || parsedBefore.confidence,
        ['高', '中', '低'],
        '低'
    );
    const scoreMaxima = {
        innovation: 2, technical_rigor: 1.5, experimental_sufficiency: 1.5, clarity: 1,
        impact: 1.5, open_source: 1.5, reproducibility: 0.5, engineering_score: 1.5
    };
    for (const [key, maximum] of Object.entries(scoreMaxima)) {
        values[key] = normalizeMachineScore(
            values[key],
            maximum,
            key === 'open_source' ? [0, 0.2, 0.5, 1, 1.2, 1.5] : null
        );
    }
    values.sota_claim = normalizeMachineEnum(values.sota_claim || parsedBefore.sotaClaim, ['是', '否', '未说明'], '未说明');
    values.has_code = normalizeMachineEnum(values.has_code || parsedBefore.hasCode, ['是', '否', '未说明'], '未说明');
    values.has_model = normalizeMachineEnum(values.has_model || parsedBefore.hasModel, ['是', '否', '未说明'], '未说明');
    values.has_dataset = normalizeMachineEnum(values.has_dataset || parsedBefore.hasDataset, ['是', '否', '未说明'], '未说明');

    const oldTagSection = extractSectionByTitle(updated, '标签');
    discoveredTags.push(...(oldTagSection.match(/#[^\s#，,;；、]+/g) || []));
    discoveredTags.push(values.primary_task_tag, values.primary_method_tag);
    const candidateTags = [...new Set(discoveredTags.filter(Boolean))];
    for (const fallback of ['#音频理解', '#Transformer', '#模型评估']) {
        if (!candidateTags.includes(fallback)) candidateTags.push(fallback);
    }
    const provisional = replaceOrInsertRequiredSection(
        updated,
        '标签',
        `${candidateTags.slice(0, 5).join(' ')}\n主任务标签: ${values.primary_task_tag || candidateTags[0]}\n主方法标签: ${values.primary_method_tag || '#Transformer'}\n补充标签: ${candidateTags[2] || '#模型评估'}`
    );
    const parsedTags = parseAnalysis(provisional) || {};
    const tags = [...new Set([...(parsedTags.tags || []), '#音频理解', '#Transformer', '#模型评估'])].slice(0, 5);
    const taskTag = parsedTags.primaryTaskTag && tags.includes(parsedTags.primaryTaskTag)
        ? parsedTags.primaryTaskTag
        : (tags.find(tag => /^#(?:语音|音频|音乐|说话人|声源|歌唱|音视频)/.test(tag)) || '#音频理解');
    const methodTag = parsedTags.primaryMethodTag && tags.includes(parsedTags.primaryMethodTag) && parsedTags.primaryMethodTag !== taskTag
        ? parsedTags.primaryMethodTag
        : (tags.find(tag => tag !== taskTag && tag === '#Transformer') || '#Transformer');
    for (const requiredTag of [taskTag, methodTag]) {
        if (!tags.includes(requiredTag)) tags.unshift(requiredTag);
    }
    const finalTags = [...new Set(tags)].slice(0, 5);
    while (finalTags.length < 3) {
        const fallback = ['#音频理解', '#Transformer', '#模型评估'].find(tag => !finalTags.includes(tag));
        if (!fallback) break;
        finalTags.push(fallback);
    }
    const supplemental = finalTags.filter(tag => tag !== taskTag && tag !== methodTag);
    updated = replaceOrInsertRequiredSection(updated, '标签', [
        finalTags.join(' '),
        `主任务标签: ${taskTag}`,
        `主方法标签: ${methodTag}`,
        `补充标签: ${supplemental.join(' ')}`
    ].join('\n'));
    values.primary_task_tag = taskTag;
    values.primary_method_tag = methodTag;
    updated = mergeSectionByTitle(updated, '机器摘要', REQUIRED_MACHINE_SUMMARY_KEYS
        .map(key => `${key}: ${values[key]}`)
        .join('\n'));
    return updated;
}

async function repairMissingAnalysisSections(paper, existingAnalysis, textForAnalysis) {
    let currentAnalysis = normalizeAnalysisStructure(existingAnalysis);
    let structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis);
    let validationFeedback = '这是第一次结构修复，没有上一次校验错误。';

    for (let attempt = 1; attempt <= 2 && structureIssues.length > 0; attempt++) {
        const prompt = loadPrompt('prompts/structure-repair.md', {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            missingSections: structureIssues.join('、'),
            validationFeedback,
            existingAnalysis: currentAnalysis,
            textForAnalysis: buildTypeAwareSourceContext(currentAnalysis, textForAnalysis)
        });
        const repairedText = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
        const cleaned = cleanGapFillPrefix(repairedText.trim());
        if (cleaned) currentAnalysis = normalizeAnalysisStructure(removeUnapprovedMarkdownImages(cleaned, []));

        structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis);
        if (structureIssues.length === 0) return currentAnalysis;

        validationFeedback = `上一次输出仍有结构契约问题：${structureIssues.join('、')}。必须输出完整分析并逐项修正。`;
        console.log(`    [deep] ⚠️  最终结构修复未通过 (${attempt}/2): ${structureIssues.join('、')}`);
    }

    throw new Error(`最终结构修复失败: ${structureIssues.join('、')}`);
}

function getRepairableAnalysisStructureIssues(analysis) {
    const issues = [];
    const missing = getMissingRequiredSections(analysis);
    if (missing.length > 0) issues.push(`缺少必要章节: ${missing.join('/')}`);
    const duplicate = getDuplicateRequiredSections(analysis);
    if (duplicate.length > 0) issues.push(`必要章节重复: ${duplicate.join('/')}`);
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) issues.push(`一级章节: ${topLevelIssue}`);
    const parsed = parseAnalysis(analysis);
    const machineIssue = validateMachineSummaryContract(analysis, parsed, { checkScoringConsistency: false });
    if (machineIssue) issues.push(`机器摘要: ${machineIssue}`);
    const tagIssue = validateTagSectionContract(analysis, parsed);
    if (tagIssue) issues.push(`标签: ${tagIssue}`);
    return issues;
}

/**
 * 从分析文本中提取方法概述和架构部分
 */
function extractMethodSection(analysis) {
    return extractSectionByTitle(analysis, '方法概述和架构', ['核心创新点', '实验结果', '细节详述', '评分理由']);
}

/**
 * 计算文本中的中文字符数量（含中文标点）
 */
function countChineseChars(text) {
    if (!text) return 0;
    const matches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    return matches ? matches.length : 0;
}

/**
 * 检查方法概述部分是否足够详细
 */
function isMethodSectionDetailed(text) {
    if (!text) return false;

    // 1. 中文字符数检查（与 prompt 中的 600 中文字符要求对齐）
    const chineseCount = countChineseChars(text);
    if (chineseCount < 600) {
        console.log(`    [deep] 🔍 方法概述中文字符数不足: ${chineseCount} < 600`);
        return false;
    }

    // 2. 检查是否有"空泛表述"（只列名称不解释）
    const vaguePatterns = [
        /详见原文/,
        /论文描述了详细架构/,
        /详细方法见/,
        /具体实现请参考/,
    ];
    if (vaguePatterns.some(p => p.test(text))) {
        console.log(`    [deep] 🔍 方法概述检测到空泛表述`);
        return false;
    }

    // 3. 检查是否提及关键要素（至少包含一些结构词）
    const structuralKeywords = ['输入', '输出', '流程', '组件', '模块', '阶段', '结构', '网络', '模型'];
    const hasStructure = structuralKeywords.some(kw => text.includes(kw));
    if (!hasStructure) {
        console.log(`    [deep] 🔍 方法概述缺少结构性描述`);
        return false;
    }

    // 4. 检查段落数（至少 3 个段落，说明有分层组织）
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
    if (paragraphs.length < 3) {
        console.log(`    [deep] 🔍 方法概述段落数不足: ${paragraphs.length} < 3`);
        return false;
    }

    return true;
}

/**
 * 检查实验结果部分是否包含 Markdown 表格
 */
function hasMarkdownTable(text) {
    if (!text) return false;
    // 标准 Markdown 表格：至少有一行表头 |...| 和一行分隔符 |---|---|
    return /\n\|[^\n]+\|\n\|[\-\s:|]+\|/.test('\n' + text);
}

/**
 * 检查并修复方法概述部分不够详细的问题。
 * 如果检测到方法概述字数不足、过于空泛或缺少关键要素，触发补充调用。
 */
async function checkAndFixMethodSection(paper, analysis, textForAnalysis) {
    const methodSection = extractMethodSection(analysis);
    if (!methodSection) return analysis;

    if (isMethodSectionDetailed(methodSection)) {
        console.log(`    [deep] ✓ 方法概述部分已足够详细（中文字符: ${countChineseChars(methodSection)}）`);
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到方法概述不够详细，触发补充...`);

    const prompt = loadPrompt('prompts/method-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        methodSection,
        textForAnalysis: buildTypeAwareSourceContext(analysis, textForAnalysis, 80000)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的方法概述合并回原分析
    return mergeSectionByTitle(analysis, '方法概述和架构', fixedSection);
}

/**
 * 检查文本中是否包含表格省略标记
 */
function hasOmissionMarkers(text) {
    if (!text) return false;
    const markers = [
        '此处省略',
        '表格数据与论文一致',
        '详见原文',
        '详见论文',
        '表格详见',
        '数据详见',
        '省略',
        '详见表',
        '（见表',
        '(见表',
    ];
    return markers.some(m => text.includes(m));
}

/**
 * 从分析文本中提取实验结果部分
 */
function extractResultsSection(analysis) {
    return extractSectionByTitle(analysis, '实验结果', ['细节详述', '评分理由', '局限与问题', '开源详情']);
}

function sourceTextLikelyHasTables(text) {
    if (!text) return false;
    return /(?:^|\n)\s*(?:Table|表)\s*[\dIVX一二三四五六七八九十]+/i.test(text)
        || /\\begin\{tabular\}|<table[\s>]/i.test(text)
        || /\n\s*\|[^\n]+\|\s*\n\s*\|[\-\s:|]+\|/.test(text);
}

/**
 * 检查并修复实验结果中缺失的表格。
 * 如果检测到省略标记或缺少 Markdown 表格，触发补充调用。
 */
async function checkAndFixTables(paper, analysis, textForAnalysis) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return analysis;

    const hasTable = hasMarkdownTable(resultsSection);
    const hasOmission = hasOmissionMarkers(resultsSection);
    const hasTableReference = /[（(]表\d+[)）]|表[一二三四五六七八九十\d]+/.test(resultsSection);
    const sourceHasTables = sourceTextLikelyHasTables(textForAnalysis);

    // 如果有省略标记，或引用了表格但没有实际 Markdown 表格
    if (!hasOmission && hasTable) {
        return analysis;
    }
    if (!hasOmission && !hasTableReference && !sourceHasTables) {
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到实验结果可能缺少表格，触发补充...`);

    const prompt = loadPrompt('prompts/table-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        resultsSection,
        textForAnalysis: buildTypeAwareSourceContext(analysis, textForAnalysis, 80000)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], API_MAX_TOKENS);
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的实验结果合并回原分析
    return mergeSectionByTitle(analysis, '实验结果', fixedSection);
}

/**
 * 根据 demo 页面扫描发现的开源链接，更新 analysis 中的机器摘要和开源详情
 * @param {string} analysis - 分析文本
 * @param {string[]} foundLinks - 发现的开源链接列表
 * @returns {string} 更新后的分析文本
 */
function updateOpensourceFromDemoLinks(analysis, foundLinks) {
    if (!foundLinks || foundLinks.length === 0) return analysis;

    let updated = analysis;

    // 1. 推断开源类型
    let hasCode = false, hasModel = false, hasDataset = false;
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com')) hasCode = true;
        if (lower.includes('huggingface.co')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('gitlab.com')) hasCode = true;
    }

    // 2. 更新机器摘要中的 has_code / has_model / has_dataset
    // 匹配格式：has_code: 否 / has_code: 未说明 等，替换为"是"
    if (hasCode) {
        updated = updated.replace(/(has_code\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasModel) {
        updated = updated.replace(/(has_model\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasDataset) {
        updated = updated.replace(/(has_dataset\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }

    // 3. 在开源详情中追加验证发现的结构化信息
    const linkDescriptions = [];
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com') || lower.includes('gitlab.com')) {
            linkDescriptions.push(`- **代码仓库**：${link}`);
        } else if (lower.includes('huggingface.co') || lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) {
                linkDescriptions.push(`- **数据集**：${link}`);
            } else {
                linkDescriptions.push(`- **模型权重**：${link}`);
            }
        } else {
            linkDescriptions.push(`- **相关链接**：${link}`);
        }
    }

    if (linkDescriptions.length > 0) {
        const newContent = `\n\n**从 demo/项目页面验证发现（已更新开源评分）：**\n${linkDescriptions.join('\n')}`;
        updated = appendSectionByTitle(updated, '开源详情', newContent);
    }

    return updated;
}

function getStructuredOpenSourceValue(openSourceText, label) {
    const pattern = new RegExp(`^(?:[-*+]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, 'mi');
    return pattern.exec(String(openSourceText || ''))?.[1]?.trim() || '';
}

function inferResourceState(value) {
    const text = String(value || '').replace(/\*\*/g, '').trim();
    if (!text || /^(?:论文中)?未提及|未说明|未提供|无|none\b|not\s+(?:mentioned|provided)/i.test(text)) {
        return '未说明';
    }
    if (/https?:\/\/\S+|(?:github|gitlab)\.com\/\S+|(?:huggingface|modelscope)\.(?:co|cn)\/\S+/i.test(text)) {
        return '是';
    }
    if (/(?:已公开|已开源|可下载|可访问|获取方式|申请获取)/.test(text)) return '是';
    return '未说明';
}

function syncResourceFieldsFromOpenSource(analysis, openSourceText) {
    const resources = [
        ['has_code', '代码'],
        ['has_model', '模型权重'],
        ['has_dataset', '数据集']
    ];
    return resources.reduce((updated, [machineKey, label]) => {
        const resourceValue = getStructuredOpenSourceValue(openSourceText, label);
        if (!resourceValue) return updated;
        const state = inferResourceState(resourceValue);
        return setMachineSummaryField(updated, machineKey, state);
    }, analysis);
}

function mergeSection(analysis, sectionHeader, newContent) {
    // 去掉 newContent 开头重复的 sectionHeader，避免合并后出现双标题
    const headerPattern = new RegExp('^' + sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[：:\\s]*\\n*');
    const cleanContent = newContent.replace(headerPattern, '').trim();

    const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[：:\\s]*\n)([\\s\\S]*?)(?=\n#{2,3}\\s|$)`, '');
    if (regex.test(analysis)) {
        return analysis.replace(regex, `$1${cleanContent}\n`);
    }
    return analysis.trim() + '\n\n' + sectionHeader + '\n' + cleanContent;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionByTitle(analysis, title, followingTitles = []) {
    if (!analysis) return '';
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return '';

    const contentStart = match.index + match[1].length + match[2].length;
    const rest = analysis.slice(contentStart);
    let end = rest.length;
    const titleAlternation = followingTitles.map(escapeRegExp).join('|');
    const nextSpecific = titleAlternation
        ? new RegExp(`\\n#{2,3}\\s*(?:\\d+[.\\s]+)?(?:${titleAlternation})[：:\\s]*\\n`)
        : null;
    const nextAny = /\n#{2,3}\s/g;
    const specificMatch = nextSpecific ? nextSpecific.exec(rest) : null;
    const anyMatch = nextAny.exec(rest);
    if (specificMatch) {
        end = specificMatch.index;
    } else if (anyMatch) {
        end = anyMatch.index;
    }
    return rest.slice(0, end).trim();
}

function normalizeSectionContent(title, newContent) {
    const heading = new RegExp(
        `^#{1,6}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n*`,
        'i'
    );
    return (newContent || '').replace(heading, '').trim();
}

function mergeSectionByTitle(analysis, title, newContent) {
    const cleanContent = normalizeSectionContent(title, newContent);
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`
    );
    if (heading.test(analysis)) {
        return analysis.replace(heading, (match, prefix, header) => `${prefix}${header}${cleanContent}\n`);
    }
    return `${analysis.trim()}\n\n## ${title}\n${cleanContent}`;
}

function appendSectionByTitle(analysis, title, newContent) {
    const existing = extractSectionByTitle(analysis, title);
    const addition = normalizeSectionContent(title, newContent);
    if (!addition || existing.includes(addition)) return analysis;
    return mergeSectionByTitle(analysis, title, [existing, addition].filter(Boolean).join('\n\n'));
}

module.exports = {
    analyzePaperDeep,
    parseAnalysis,
    callModel,
    createActiveTimeBudget,
    getActiveRemainingTimeoutMs,
    getRemainingTimeoutMs,
    fetchArxivText,
    fetchArxivTextDetailed,
    fetchArxivImageUrls,
    parseArxivImageInfosFromHtml,
    removeUnapprovedMarkdownImages,
    selectImageCandidates,
    scoreImageCandidate,
    normalizeImageInfos,
    mergeImageInfoMetadata,
    sourceTextLikelyHasTables,
    getPaperArxivId,
    getPreProvidedImageUrls,
    getArxivHtmlIds,
    isSupportedImageUrl,
    safeImageLabel,
    downloadImageBase64,
    fetchPublicImageResponse,
    sanitizeMarkdownImageAlt,
    sanitizeLogField,
    cleanGapFillPrefix,
    checkDemoPageForOpensource,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    extractSectionByTitle,
    mergeSectionByTitle,
    appendSectionByTitle,
    syncResourceFieldsFromOpenSource,
    inferResourceState,
    parseImageInsertionPlan,
    parseImageInsertionPlanDetailed,
    applyImageInsertionPlan,
    buildImageAnchorCatalog,
    formatImageAnchorCatalog,
    normalizeGenericImageOrder,
    parseScoringAuditResult,
    applyScoringAuditResult,
    validateScoringAuditAgainstAnalysis,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence,
    reasonUsesForbiddenDeduction,
    updateOpensourceFromDemoLinks,
    auditTypeAwareScoring,
    auditTypeAwareScoringDetailed,
    repairMissingAnalysisSections,
    getRepairableAnalysisStructureIssues,
    normalizeAnalysisStructure,
    getRemainingTimeoutMs,
    getTypeAwareEvidenceGuide,
    buildTypeAwareSourceContext,
    createAnalysisRecoveryManifest,
    markRecoveryStage,
    isRecoveryStageComplete
};

// 直接运行测试
if (require.main === module) {
    const testPaper = {
        arxivId: process.argv[2] || '2604.00688',
        title: process.argv[3] || 'Test Paper',
        authors: ['Test Author'],
        categories: ['cs.SD'],
        abstract: 'This is a test abstract.'
    };

    analyzePaperDeep(testPaper).then(result => {
        console.log('\n=== 分析结果 ===');
        console.log(result.analysis);
        console.log('\n=== 解析结果 ===');
        console.log(JSON.stringify(parseAnalysis(result.analysis), null, 2));
    }).catch(console.error);
}
