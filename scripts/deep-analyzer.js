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
    getResponsesOutputTruncationError,
    requestLlmJson,
    loadPrompt,
    normalizeDocumentType,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS,
    detectHttpConnectProxyUrl,
    createProxyAgent,
    createProxyDispatcher,
    getBeijingISOString,
    writeFileAtomic
} = require('./utils.js');
const {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    validateTopLevelSectionContract,
    validateAnalysisEditorialLeakageContract,
    validateMachineSummaryContract,
    validateTagSectionContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION,
    ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION,
    extractMarkdownTables,
    validateExperimentTableContract,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    validateMethodDetailContract,
    isRecoveryStageTerminal,
    CORE_SUMMARY_CONTRACT_VERSION,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    CORE_SUMMARY_MAX_CHINESE_CHARS,
    CORE_SUMMARY_MIN_SENTENCES,
    CORE_SUMMARY_MAX_SENTENCES,
    validateCoreSummarySemanticContract,
    coreSummaryProjectionSha256,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { PDFParse } = require('pdf-parse');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ANALYSIS_CONFIG, ARXIV_CONFIG, SECONDARY_MODEL_CONFIG, CURRENT_DIR } = require('./config.js');
const {
    resolveApiKeyPool,
    resolvePrimaryApiKeyPool,
    normalizeOpenCodeGoService,
    LlmAccountPoolConfigError
} = require('./llm-account-pool.js');
const {
    validateEditorialQuality,
    findDuplicateLongSentences,
    SCALED_ARABIC_MEASUREMENT_UNITS
} = require('./editorial-quality.js');
const {
    READER_MECHANICAL_CONTRACT, READER_SECTION_QUALITY_CONTRACT, READER_LIMITS,
    READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE,
    readerRequirements, findReaderSectionNearDuplicates
} = require('./lib/reader-contract.js');
const { READER_TABLE_SELECTION_CONTRACT, compileReaderTableSelections,
    assessReaderTableSelectionEligibility, findReaderTablePasteDuplication,
    readerResultTableRequirement, validateReaderResultTableCoverage } = require('./lib/reader-tables.js');

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiReaderOverallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
    apiReaderConcurrency: API_READER_CONCURRENCY = 5,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
    apiMaxResponseBytes: API_MAX_RESPONSE_BYTES = 16 * 1024 * 1024,
    repairMaxTokens: REPAIR_MAX_TOKENS = 16000,
    apiReaderMaxTokens: API_READER_MAX_TOKENS = 48000,
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
    openSourceEvidenceMaxChars: OPEN_SOURCE_EVIDENCE_MAX_CHARS = 16000,
    revisionEvidenceMaxChars: REVISION_EVIDENCE_MAX_CHARS = 60000,
    apiReaderEvidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS = 180000,
    apiReaderContextMaxChars: API_READER_CONTEXT_MAX_CHARS = 240000,
    scoringEvidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS = 40000,
    repairEvidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS = 30000,
    structureEvidenceMaxChars: STRUCTURE_EVIDENCE_MAX_CHARS = 40000,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;
const IMAGE_CACHE_DIR = path.join(CURRENT_DIR, 'image-cache');
// Reader carries the largest text+image payload. A transport failure produces
// no reusable draft, so repeat it only on a later explicit run; all upstream
// checkpoints remain reusable then.
const API_READER_TRANSPORT_MAX_RETRIES = 1;

function getArxivFetchDispatcher() {
    const proxyUrl = detectHttpConnectProxyUrl();
    if (!proxyUrl) {
        const error = new Error('arXiv 全文、PDF 与图片抓取必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 代理，拒绝直连或仅使用 SOCKS ALL_PROXY');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    try {
        return createProxyDispatcher(proxyUrl);
    } catch (error) {
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
}

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

const EVIDENCE_SELECTION_VERSION = 'task-focused-v1';
const BROAD_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:abstract|introduction|method|approach|architecture|experiment|evaluation|result|conclusion|limitation|appendix)\b/i,
    /摘要|引言|方法|架构|实验|评测|结果|结论|局限|附录/,
    /\b(?:WER|CER|EER|F1|accuracy|precision|recall|MOS|PESQ|STOI|SDR|SNR|latency|throughput)\b/i,
    /https?:\/\/|github|huggingface|code|dataset|checkpoint|release|open[- ]source/i
]);
const OPEN_SOURCE_EVIDENCE_PATTERNS = Object.freeze([
    /https?:\/\//i,
    /\b(?:github|gitlab|huggingface|modelscope|repository|repo|code|checkpoint|weights?|dataset|license|demo|artifact)\b/i,
    /\b(?:release|released|available|open[- ]source|publicly available|will be released)\b/i,
    /开源|代码|仓库|权重|模型|数据集|许可证|演示|项目主页|未来公开|后续开放/
]);
const METHOD_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:method|methodology|approach|architecture|framework|pipeline|algorithm|module|component|training|inference|objective|loss)\b/i,
    /方法|架构|框架|流程|算法|模块|组件|训练|推理|目标函数|损失函数/
]);
const RESULT_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:experiment|evaluation|result|benchmark|baseline|ablation|metric|table|figure|significance|error analysis)\b/i,
    /\b(?:WER|CER|EER|F1|accuracy|precision|recall|MOS|PESQ|STOI|SDR|SNR|latency|throughput)\b/i,
    /实验|评测|结果|基准|基线|消融|指标|表格|显著性|误差分析/
]);
const SCORING_EVIDENCE_PATTERNS = Object.freeze([
    ...BROAD_EVIDENCE_PATTERNS,
    /\b(?:novel|contribution|state of the art|SOTA|reproduc|hyperparameter|hardware|failure case|proof|theorem|assumption)\b/i,
    /创新|贡献|复现|超参数|硬件|失败案例|证明|定理|假设|边界条件/
]);

function buildTaskEvidenceContext(sourceText, maxChars, patterns = BROAD_EVIDENCE_PATTERNS, taskLabel = '通用') {
    const source = String(sourceText || '');
    const limit = Math.max(1000, Number.parseInt(maxChars, 10) || source.length);
    if (!source) return '';
    if (source.length <= limit) return `[${taskLabel}_SOURCE_1/1]\n${source}`;

    // 让五个强制位置块在最小允许预算下也能同时容纳，避免用户把预算调低后
    // 意外丢掉中段或结尾证据；较大预算仍以 4K 块控制遍历成本。
    const chunkSize = Math.min(4000, Math.max(100, Math.floor(limit / 16)));
    const chunks = [];
    for (let start = 0; start < source.length; start += chunkSize) {
        const text = source.slice(start, Math.min(source.length, start + chunkSize));
        let score = 0;
        for (const pattern of patterns) {
            if (pattern.test(text)) score += 5;
        }
        score += Math.min(5, (text.match(/https?:\/\//gi) || []).length * 2);
        score += Math.min(4, (text.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length / 8);
        chunks.push({ index: chunks.length, start, text, score });
    }

    const mandatoryIndexes = new Set([
        0,
        Math.floor((chunks.length - 1) * 0.25),
        Math.floor((chunks.length - 1) * 0.5),
        Math.floor((chunks.length - 1) * 0.75),
        chunks.length - 1
    ]);
    const selected = new Map();
    let used = 0;
    const add = chunk => {
        if (!chunk || selected.has(chunk.index)) return;
        const cost = chunk.text.length + 80;
        if (used + cost > limit) return;
        selected.set(chunk.index, chunk);
        used += cost;
    };
    for (const index of mandatoryIndexes) add(chunks[index]);
    for (const chunk of [...chunks].sort((left, right) => right.score - left.score || left.index - right.index)) {
        add(chunk);
    }
    const rendered = [...selected.values()]
        .sort((left, right) => left.index - right.index)
        .map(chunk => `[${taskLabel}_SOURCE_${chunk.index + 1}/${chunks.length}]\n${chunk.text}`)
        .join('\n\n');
    return rendered.slice(0, limit);
}

/**
 * 将论文原文中的 LaTeX 反斜杠替换为可读的 Unicode 符号。
 *
 * 部分 OpenAI 兼容网关会对 JSON 请求体中的文本做二次反序列化，
 * 使诸如 `\\underline` 这样的 LaTeX 命令被误当作 JSON 的非法转义，
 * 从而在请求到达模型前返回 400。开源扫描只需要判断代码/仓库证据，
 * 不依赖 LaTeX 语法，因此在该任务边界内做无损语义的显示层替换。
 */
function sanitizeOpenSourceEvidence(text) {
    return String(text || '')
        .replace(/\\/g, '⧵')
        // arXiv HTML 转文本偶尔会留下孤立 UTF-16 代理字符；JSON.stringify
        // 会把它们编码成 `\\uXXXX`，部分网关会将其误判为截断的 Unicode 转义。
        .replace(/[\uD800-\uDFFF]/g, '�')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

function sanitizeModelMessages(messages, options = {}) {
    const replaceBackslashes = options.replaceBackslashes === true;
    const sanitizeText = value => {
        let text = String(value || '')
            .replace(/[\uD800-\uDFFF]/g, '�')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
        // Only task-specific evidence sanitizers should opt into this lossy
        // conversion. Keeping prompt instructions and prior model output intact
        // preserves LaTeX semantics for the main analysis and repair stages.
        if (replaceBackslashes) text = text.replace(/\\/g, '⧵');
        return text;
    };
    return (messages || []).map(message => {
        if (!message || typeof message !== 'object') return message;
        if (typeof message.content === 'string') {
            return { ...message, content: sanitizeText(message.content) };
        }
        if (!Array.isArray(message.content)) return message;
        return {
            ...message,
            content: message.content.map(block => {
                if (!block || typeof block !== 'object' || block.type !== 'text') return block;
                return { ...block, text: sanitizeText(block.text) };
            })
        };
    });
}

function buildTypeAwareSourceContext(
    analysis,
    sourceText,
    maxChars = SCORING_EVIDENCE_MAX_CHARS,
    patterns = SCORING_EVIDENCE_PATTERNS,
    taskLabel = 'SCORING'
) {
    const parsedAnalysis = parseAnalysis(analysis) || {};
    const documentType = parsedAnalysis.documentType || '待最终确认';
    const source = String(sourceText || '');
    const analysisBudget = Math.min(30000, Math.floor(maxChars * 0.45));
    const sectionDefinitions = [
        ['A_SUMMARY', '核心摘要'],
        ['A_METHOD', '方法概述和架构'],
        ['A_RESULTS', '实验结果'],
        ['A_LIMITS', '局限与问题'],
        ['A_OPEN', '开源详情']
    ];
    const sectionTitlesByTask = {
        METHOD: new Set(['核心摘要', '方法概述和架构']),
        RESULT: new Set(['核心摘要', '方法概述和架构', '实验结果']),
        STRUCTURE: new Set(sectionDefinitions.map(([, title]) => title)),
        // Reader facts come only from source evidence, never generated
        // canonical sections. Canonical remains a separate scoring artifact.
        READER: new Set(),
        SCORING: new Set(sectionDefinitions.map(([, title]) => title))
    };
    const selectedTitles = sectionTitlesByTask[taskLabel] || sectionTitlesByTask.SCORING;
    const selectedDefinitions = sectionDefinitions.filter(([, title]) => selectedTitles.has(title));
    const perSectionBudget = Math.max(1200, Math.floor(analysisBudget / selectedDefinitions.length));
    const analysisSections = selectedDefinitions.map(([id, title]) => {
        const content = extractSectionByTitle(analysis, title);
        if (content) return `[${id}] ${title}\n${content.slice(0, perSectionBudget)}`;
        if (id === 'A_OPEN') {
            return [
                `[${id}] ${title}`,
                `该章节正文为空；机器摘要资源状态：has_code=${parsedAnalysis.hasCode || '未记录'}, ` +
                    `has_model=${parsedAnalysis.hasModel || '未记录'}, has_dataset=${parsedAnalysis.hasDataset || '未记录'}。`
            ].join('\n');
        }
        return '';
    }).filter(Boolean);
    const sourceBudget = Math.max(12000, maxChars - analysisSections.join('\n\n').length - 500);
    const sourceEvidence = buildTaskEvidenceContext(source, sourceBudget, patterns, taskLabel);
    const taskHeader = taskLabel === 'SCORING'
        ? [
            `当前文档类型：${documentType}`,
            `适用证据标准：${getTypeAwareEvidenceGuide(documentType)}`,
            '以下是确定性评分证据账本。评分理由只能使用这些带 ID 的内容；不得补充账本外事实。'
        ]
        : [
            `以下是 ${taskLabel} 阶段的确定性任务证据。只能使用这些带 ID 的内容；不得补充证据外事实。`
        ];
    return [
        ...taskHeader,
        ...analysisSections,
        sourceEvidence
    ].join('\n\n');
}

const AUDIT_TOP_LEVEL_KEYS = Object.freeze(['documentType', 'confidence', 'dimensions']);
const AUDIT_TOP_LEVEL_KEYS_V2 = Object.freeze([
    'documentType', 'confidence', 'evidenceProfile', 'dimensions'
]);
const AUDIT_ITEM_KEYS = Object.freeze(['score', 'reason']);
const SCORING_EVIDENCE_PROFILE_KEYS = Object.freeze([
    'version', 'multiComponentClaimed', 'ablationStatus', 'targetEvaluation',
    'sampleScaleReported', 'deploymentMeasured', 'publicGeneralizationEvaluated',
    'engineeringEvidence', 'evidenceBoundary', 'evidenceIds'
]);
const SCORING_AUDIT_CONTRACT = 'api-scoring-audit-v2';
const SCORING_CAP_RULES_VERSION = 'evidence-caps-v2';
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

function findForbiddenDeductionClauses(reason, patterns) {
    return String(reason || '').split(/[。！？；;\n]/).map(clause => clause.trim()).filter(clause => {
        if (!clause) return false;
        if (EXPLICIT_NON_DEDUCTION.test(clause)) return false;
        return patterns.some(pattern => {
            pattern.lastIndex = 0;
            return pattern.test(clause);
        });
    });
}

function reasonUsesForbiddenDeduction(reason, patterns) {
    return findForbiddenDeductionClauses(reason, patterns).length > 0;
}

function prepareScoringAuditAnalysis(analysis) {
    if (!findSectionBounds(analysis, '评分理由')) return analysis;
    return mergeSectionByTitle(
        analysis,
        '评分理由',
        '旧评分理由已由代码移除，禁止复用。请仅依据确定性评分证据账本重新建立八维理由。'
    );
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

function parseScoringAuditResult(raw, allowedEvidenceIds = null) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`评分审计 JSON 无法解析: ${error.message}`);
    }

    const hasEvidenceProfile = Object.prototype.hasOwnProperty.call(parsed, 'evidenceProfile');
    assertExactObjectKeys(
        parsed,
        hasEvidenceProfile ? AUDIT_TOP_LEVEL_KEYS_V2 : AUDIT_TOP_LEVEL_KEYS,
        '评分审计顶层'
    );
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
    let evidenceProfile = null;
    if (hasEvidenceProfile) {
        evidenceProfile = parsed.evidenceProfile;
        assertExactObjectKeys(
            evidenceProfile, SCORING_EVIDENCE_PROFILE_KEYS, '评分证据画像'
        );
        if (evidenceProfile.version !== 1) throw new Error('评分证据画像 version 必须为 1');
        for (const key of [
            'multiComponentClaimed', 'sampleScaleReported', 'deploymentMeasured',
            'publicGeneralizationEvaluated'
        ]) {
            if (typeof evidenceProfile[key] !== 'boolean') {
                throw new Error(`评分证据画像 ${key} 必须是布尔值`);
            }
        }
        if (evidenceProfile.ablationStatus === 'missing') {
            evidenceProfile.ablationStatus = 'none';
        }
        if (!['direct', 'partial', 'none', 'not_applicable'].includes(evidenceProfile.ablationStatus)) {
            throw new Error(
                `评分证据画像 ablationStatus 非法: ${JSON.stringify(evidenceProfile.ablationStatus)}`
            );
        }
        if (!['public', 'internal', 'mixed', 'not_applicable'].includes(evidenceProfile.targetEvaluation)) {
            throw new Error('评分证据画像 targetEvaluation 非法');
        }
        if (!['measured_deployment', 'reusable_pipeline', 'public_artifact_or_benchmark', 'claim_only', 'not_applicable']
            .includes(evidenceProfile.engineeringEvidence)) {
            throw new Error('评分证据画像 engineeringEvidence 非法');
        }
        if (evidenceProfile.deploymentMeasured
            !== (evidenceProfile.engineeringEvidence === 'measured_deployment')) {
            throw new Error('评分证据画像 deploymentMeasured 与 engineeringEvidence 不一致');
        }
        if (evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus === 'not_applicable') {
            throw new Error('存在多组件因果主张时 ablationStatus 不得为 not_applicable');
        }
        if (!evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus !== 'not_applicable') {
            throw new Error('不存在多组件因果主张时 ablationStatus 必须为 not_applicable');
        }
        if (evidenceProfile.targetEvaluation === 'not_applicable'
            && !['理论研究', '综述'].includes(documentType)) {
            throw new Error('经验型文档的 targetEvaluation 不得为 not_applicable');
        }
        if (typeof evidenceProfile.evidenceBoundary !== 'string'
            || evidenceProfile.evidenceBoundary.trim().length < 20) {
            throw new Error('评分证据画像 evidenceBoundary 至少 20 个字符');
        }
        if (!Array.isArray(evidenceProfile.evidenceIds)
            || evidenceProfile.evidenceIds.length < 1
            || evidenceProfile.evidenceIds.length > 12
            || new Set(evidenceProfile.evidenceIds).size !== evidenceProfile.evidenceIds.length) {
            throw new Error('评分证据画像 evidenceIds 必须是 1-12 个不重复 ID');
        }
        if (allowedEvidenceIds instanceof Set) {
            const unknown = evidenceProfile.evidenceIds.filter(id => !allowedEvidenceIds.has(id));
            if (unknown.length > 0) {
                throw new Error(`评分证据画像引用了账本外 ID: ${unknown.join(', ')}`);
            }
        }
        const boundaryIds = [...evidenceProfile.evidenceBoundary
            .matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/g)].map(match => match[1]);
        if (boundaryIds.length === 0
            || !boundaryIds.some(id => evidenceProfile.evidenceIds.includes(id))) {
            throw new Error('评分证据画像 evidenceBoundary 必须引用 evidenceIds 中的账本 ID');
        }
    }
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
        if (allowedEvidenceIds instanceof Set) {
            const citedIds = [...reason.matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/g)].map(match => match[1]);
            if (citedIds.length === 0) {
                throw new Error(`评分审计维度 ${spec.key} 理由缺少证据账本 ID`);
            }
            const unknownIds = citedIds.filter(id => !allowedEvidenceIds.has(id));
            if (unknownIds.length > 0) {
                throw new Error(`评分审计维度 ${spec.key} 引用了账本外 ID: ${[...new Set(unknownIds)].join(', ')}`);
            }
        }
        const forbiddenPatterns = FORBIDDEN_SCORING_REASON_PATTERNS[spec.key] || [];
        const forbiddenClauses = findForbiddenDeductionClauses(reason, forbiddenPatterns);
        if (forbiddenClauses.length > 0) {
            throw new Error(
                `评分审计维度 ${spec.key} 使用了属于其他维度的扣分事实；` +
                `违规分句：${forbiddenClauses.map(clause => `「${clause}」`).join('、')}；` +
                '请删除这些分句，并只使用该维度负责的证据重写理由'
            );
        }
        dimensions[spec.key] = { score, reason };
    }

    return recalculateScoringAudit({
        documentType, confidence, dimensions,
        ...(evidenceProfile ? { evidenceProfile } : {})
    });
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

function applyScoringEvidenceCaps(audit) {
    const profile = audit?.evidenceProfile;
    if (!profile) return audit;
    const updated = structuredClone(audit);
    const capsApplied = [];
    const cap = (dimension, maximum, rule) => {
        const item = updated.dimensions[dimension];
        if (!item || item.score <= maximum) return;
        capsApplied.push({ rule, dimension, before: item.score, after: maximum });
        item.score = maximum;
        item.reason = `${item.reason} 代码根据证据画像应用「${rule}」上限。`;
    };
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none') {
        cap('experimentalSufficiency', 1.2, 'multi_component_without_direct_ablation');
    }
    if (profile.multiComponentClaimed && profile.ablationStatus === 'partial') {
        cap('experimentalSufficiency', 1.3, 'multi_component_with_partial_ablation');
    }
    if (profile.targetEvaluation === 'internal' && !profile.sampleScaleReported) {
        cap('experimentalSufficiency', 1.2, 'internal_evaluation_without_sample_scale');
    }
    if (profile.engineeringEvidence === 'claim_only') {
        cap('engineering', 1.0, 'engineering_claim_without_measured_or_reusable_evidence');
    }
    const recalculated = recalculateScoringAudit(updated);
    if (recalculated.confidence !== '高' && recalculated.total > 9.0) {
        throw new Error('评分置信度不是“高”时总分不得超过 9.0');
    }
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none'
        && profile.targetEvaluation === 'internal' && recalculated.total > 8.5) {
        throw new Error('多组件主张缺少直接消融且主要依赖内部评测时，总分不得超过 8.5');
    }
    return { ...recalculated, capsApplied };
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
    if (audit.documentType === '理论研究') return applyScoringEvidenceCaps(audit);
    const hasReleasedArtifact = [current.hasCode, current.hasModel, current.hasDataset]
        .some(value => value === '是' || value === 'yes');
    if (!hasReleasedArtifact) {
        const sourceText = String(current.opensource || '');
        const promisesRelease = hasAffirmativeReleasePromise(sourceText);
        const hasDemo = hasAffirmativeDemoEvidence(sourceText);
        const normalizedScore = promisesRelease ? 0.5 : hasDemo ? 0.2 : 0;
        const normalizedReason = promisesRelease
            ? '[A_OPEN] 论文明确承诺未来开放核心产物，但当前尚未发布可用代码、模型权重或数据资源。'
            : hasDemo
                ? '[A_OPEN] 论文目前只提供可访问的在线演示页面，未发布核心代码、模型权重或训练数据。'
                : '[A_OPEN] 论文未发布核心代码、模型权重或数据资源，也未给出明确的后续开源承诺。';
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
        return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
    }
    return applyScoringEvidenceCaps(audit);
}

function revalidateScoringAudit(audit, allowedEvidenceIds) {
    return parseScoringAuditResult(JSON.stringify({
        documentType: audit.documentType,
        confidence: audit.confidence,
        ...(audit.evidenceProfile ? { evidenceProfile: audit.evidenceProfile } : {}),
        dimensions: audit.dimensions
    }), allowedEvidenceIds);
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

async function auditTypeAwareScoringDetailed(analysis, sourceEvidence = '', options = {}) {
    let lastError = null;
    let validationFeedback = '这是第一次输出，没有上一次校验错误。';
    // 即使没有额外原文，也要把已有分析的带 ID 章节构造成可引用账本；
    // 否则空 ID 集会让“每个理由必须引用合法 ID”的硬契约无解。
    const evidenceContext = typeof options.evidenceContext === 'string'
        ? options.evidenceContext
        : buildTypeAwareSourceContext(analysis, sourceEvidence);
    const promptTemplateSha256 = runtimePromptTemplateSha256('prompts/scoring-audit.md');
    const auditInputAnalysis = prepareScoringAuditAnalysis(analysis);
    const allowedEvidenceIds = new Set(
        [...evidenceContext.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1])
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = loadPrompt('prompts/scoring-audit.md', {
            existingAnalysis: auditInputAnalysis,
            sourceEvidence: evidenceContext,
            validationFeedback
        });
        const raw = await callModel(
            [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            16000,
            { temperature: SCORING_AUDIT_TEMPERATURE,
                usageContext: { stage: 'scoringAudit', contentAttempt: attempt } }
        );
        try {
            const parsedAudit = parseScoringAuditResult(raw, allowedEvidenceIds);
            if (!parsedAudit.evidenceProfile) {
                throw new Error('新评分审计必须提供 evidenceProfile，禁止回退旧评分 JSON');
            }
            const normalizedAudit = validateScoringAuditAgainstAnalysis(
                analysis,
                parsedAudit
            );
            const audit = {
                ...revalidateScoringAudit(normalizedAudit, allowedEvidenceIds),
                ...(Array.isArray(normalizedAudit.capsApplied)
                    ? { capsApplied: normalizedAudit.capsApplied }
                    : {})
            };
            return {
                analysis: applyScoringAuditResult(analysis, audit),
                audit,
                attempts: attempt,
                model: DEEP_CONFIG.model,
                protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                endpointSha256: crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex'),
                maxTokens: 16000,
                maxResponseBytes: API_MAX_RESPONSE_BYTES,
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

async function auditTypeAwareScoring(analysis, sourceEvidence = '', options = {}) {
    return (await auditTypeAwareScoringDetailed(analysis, sourceEvidence, options)).analysis;
}

const API_READER_ARTICLE_CONTRACT = 'beginner-researcher-v3';
const API_READER_PLAN_VERSION = 3;
const API_READER_PARSER_VERSION = 'api-reader-parser-v3';
const API_READER_ASSEMBLER_VERSION = 'api-reader-assembler-v3';
const API_READER_TABLE_CONTRACT_VERSION = 'api-reader-tables-v3';
const API_READER_FIGURE_CONTRACT_VERSION = 'api-reader-figures-v3';
const API_READER_QUALITY_METRICS_CONTRACT = 'api-reader-quality-metrics-v2';
const API_READER_SOURCE_BINDING_CONTRACT = 'api-reader-source-bindings-v4';
const API_READER_SOURCE_BINDING_REPAIR_VERSION = 'api-reader-source-repair-v4';
const API_READER_SURFACE_REPAIR_VERSION = 'api-reader-surface-repair-v2';
const API_READER_AUTHOR_IDENTITY_CONTRACT = 'api-reader-author-identity-v1';
const API_READER_RESOURCE_IDENTITY_CONTRACT = 'api-reader-resource-identity-v1';
const API_READER_INITIAL_TEMPERATURE = 0.6;
const API_READER_REPAIR_TEMPERATURE = 0.1;
const API_READER_FIGURE_MAX_BYTES = 16 * 1024 * 1024;
const API_READER_FIGURE_LIMIT = 8;
const API_READER_FIGURE_SELECTION_LIMIT = READER_LIMITS.maximumFigures;
const SCORING_STABILITY_RESOLUTION_CONTRACT = 'api-scoring-stability-resolution-v1';
const SCORING_STABILITY_THRESHOLD = 0.5;
const SCORING_STABILITY_CONSENSUS_TOLERANCE = 0.3;
const API_READER_FIGURE_LEAD_MIN_CHARS = READER_LIMITS.figureLeadChars;
const API_READER_FIGURE_EXPLANATION_MIN_CHARS = READER_LIMITS.figureExplanationChars;
const { READER_SECTION_KINDS: API_READER_KINDS, normalizeReaderDraftOrder,
    READER_DRAFT_ORDER_CONTRACT } = require('./lib/reader-draft-order.js');
const API_READER_REQUIRED_KINDS = Object.freeze([
    'background', 'related_work', 'method_overview', 'training',
    'experiment_setup', 'result', 'limitation', 'reproduction', 'synthesis'
]);

function scoringStabilityResolutionIsValid(stage) {
    if (stage?.stabilityWarning !== true) return true;
    const resolution = stage.stabilityResolution;
    return resolution?.contract === SCORING_STABILITY_RESOLUTION_CONTRACT
        && resolution?.status === 'resolved'
        && resolution?.method === 'second_pass_consensus'
        && Number.isFinite(resolution?.scoreDifference)
        && resolution.scoreDifference <= SCORING_STABILITY_CONSENSUS_TOLERANCE
        && /^[a-f0-9]{64}$/.test(String(resolution?.secondAuditSha256 || ''));
}

function isAllowedReaderNarrativeNumeralIssue(issue, article = '') {
    if (issue?.code !== 'quantitative_chinese_numeral') return false;
    const match = String(issue.match || '').trim();
    // A third-octave band is a scientific term, not a measured one-fold gain.
    // Match the exact occurrence, never waive other 一倍 merely because the
    // term appears elsewhere in the article.
    if (match === '一倍' && Number.isInteger(issue.index) && issue.index >= 3
        && String(article).slice(issue.index - 3, issue.index + 4) === '三分之一倍频程') return true;
    return /^(?:一|两)(?:个|条|段|类|层|种|套|路|方面|部分|组|步|轮|半|张|幅)$/.test(match)
        || /^一(?:个)?(?:模型|系统|框架|方法|组件|问题|概念|目标|接口|视角|例子|直觉)$/.test(match);
}

function isAllowedReaderDefensiveNegationIssue(issue, article) {
    if (issue?.code !== 'defensive_negation_saturation') return false;
    const count = Number(issue.count);
    if (!Number.isFinite(count)) return false;
    const chineseChars = (String(article || '').match(/[\u3400-\u9fff]/g) || []).length;
    const readerLimit = Math.max(12, Math.ceil(chineseChars / 300));
    return count <= readerLimit;
}

function buildApiReaderQualityMetrics(quality, article) {
    const rawIssues = Array.isArray(quality?.issues) ? quality.issues : [];
    const warnings = Array.isArray(quality?.warnings) ? quality.warnings : [];
    const waivedIssues = rawIssues.filter(issue => (
        isAllowedReaderNarrativeNumeralIssue(issue, article)
        || isAllowedReaderDefensiveNegationIssue(issue, article)
        || isReaderHeadingIssue(issue, article)
    ));
    const waivedSet = new Set(waivedIssues);
    const blockingIssues = rawIssues.filter(issue => !waivedSet.has(issue));
    const countCodes = items => Object.fromEntries(
        [...new Set(items.map(item => item.code).filter(Boolean))].sort()
            .map(code => [code, items.filter(item => item.code === code).length])
    );
    return {
        contract: API_READER_QUALITY_METRICS_CONTRACT,
        rawIssueCount: rawIssues.length,
        waivedIssueCount: waivedIssues.length,
        blockingIssueCount: blockingIssues.length,
        warningCount: warnings.length,
        rawIssueCodes: countCodes(rawIssues),
        waivedIssueCodes: countCodes(waivedIssues),
        blockingIssueCodes: countCodes(blockingIssues),
        warningCodes: countCodes(warnings),
        ...(warnings.some(item => item.code === 'reader_cross_section_near_duplicate') ? {
            sectionWarnings: warnings.filter(item => item.code === 'reader_cross_section_near_duplicate')
        } : {})
    };
}

function normalizeReaderSourceCell(value) {
    return String(value ?? '').normalize('NFKC')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/[*_`]/g, '')
        .replace(/[％]/g, '%')
        .replace(/\s+/g, ' ')
        .trim();
}

function findStructuredTableCell(table, row, column) {
    return (table?.cells || []).find(cell => (
        Number.isInteger(cell?.row) && Number.isInteger(cell?.column)
        && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
        && column >= cell.column && column < cell.column + Number(cell.colspan || 1)
    ));
}

function readerNumericTokenMatches(value) {
    // 直接在原文上匹配（不做 NFKC 拷贝），保证 match.index 可直接用于原文切片；
    // 之前先 NFKC 再匹配，遇到 ﬁ/ﬂ 等合字会让索引整体漂移，导致按索引切出的
    // quote 落在错误位置、token 永远对不上。全角数字/小数点/百分号与数学减号
    // 纳入字符类；比较归一化仍由 canonicalReaderNumericToken 负责。
    // 注意：en/em dash 不算减号，避免把页码范围误读成负数。
    const digit = '[\\d\\uFF10-\\uFF19]';
    const sign = '[-+\\uFF0D\\u2212]';
    const dot = '(?:[\\.\\uFF0E])';
    const percent = '(?:\\s*%|\\s*\\uFF05)';
    // A unit must be a complete token: the next table row's SE, BAK or Model
    // is not seconds, billions or millions. Preserve legitimate whitespace
    // between a value and a standalone unit, including line breaks.
    const unit = '(?:seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)'
        + '(?![A-Za-z0-9_\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])';
    const lookbehind = '(?<![A-Za-z0-9\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])';
    // LaTeXML 的 3.093.09 必须一次取到完整双写表面，才能证明半部 3.09。
    // 普通小数模式会先截成 3.093，再截 09；精确重复及右边界避免猜拆非重复串。
    const doubledDecimal = `(${digit}+${dot}${digit}+)\\1(?!${digit}|${dot}${digit})`;
    const pattern = new RegExp(
        `${lookbehind}(?:${doubledDecimal}|${sign}?${digit}+(?:${dot}${digit}+)?)(?:${percent}|\\s*(?:${unit}))?`,
        'gi'
    );
    // LaTeXML can flatten an explicit TeX color command into
    // \\textcolorblue58.62. Mask only standard named-color prefixes immediately
    // before a number; equal-length spaces preserve source indices and exact
    // quote bytes. Do not relax the identifier boundary or rewrite units.
    const originalSurface = String(value || '');
    const numericSurface = originalSurface.replace(
        /(\\textcolor(?:black|blue|brown|cyan|darkgray|gray|green|lightgray|lime|magenta|olive|orange|pink|purple|red|teal|violet|white|yellow))([-+\uFF0D\u2212]?[0-9\uFF10-\uFF19][0-9.\uFF10-\uFF19\uFF0E]*)/g,
        (surface, prefix, number, offset) => {
            // An external sign would become detached by the mask. Fail closed
            // on this ambiguous surface, including its decimal tail; never
            // manufacture a positive token or move a sign across source bytes.
            if (/[-+\uFF0D\u2212]\s*$/.test(originalSurface.slice(0, offset))) {
                return ' '.repeat(surface.length);
            }
            return ' '.repeat(prefix.length) + number;
        }
    );
    return [...numericSurface.matchAll(pattern)];
}

function canonicalReaderNumericToken(raw) {
    // 千分位逗号只在“恰好三位一组”时归一化（44,000 → 44000），避免把
    // 枚举“1,2”或小数逗号误合并；NFKC 与去空白后模型与原文走同一归一化。
    // 多组千分位（1,234,567）需循环到稳定。
    // NFKC 不映射数学减号 U+2212 与全角连字符 U+FF0D，必须显式归一为
    // ASCII 连字符，否则原文“−58 dB”与模型写的“-58 dB”永远对不上。
    const surface = String(raw || '').normalize('NFKC').replace(/[\u2212\uFF0D]/g, '-');
    let token = surface;
    let previous;
    do {
        previous = token;
        token = token.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    } while (token !== previous);
    token = token.replace(/\s+/g, '').toLowerCase();
    const match = token.match(/^([-+]?\d+(?:\.\d+)?)(.*)$/);
    if (!match) return token;
    const numStr = match[1];
    let suffix = match[2] || '';
    const num = Number(numStr);
    if (!Number.isFinite(num)) return token;
    // 四位年份的英文复数（如 2025s）不是“秒”单位，去掉裸 s 以便与原文年份对齐；
    // 真正的秒数（5s、30s）不受影响。
    if (/^\d{4}s$/i.test(surface.trim()) && /^\d{4}$/.test(numStr) && Number(numStr) >= 1000
        && Number(numStr) <= 2999 && suffix === 's') {
        suffix = '';
    }
    if (suffix === 'second' || suffix === 'seconds') suffix = 's';
    // 去除无意义的尾零：2.00 -> 2, 2.50% -> 2.5%
    return `${String(num)}${suffix}`;
}

function readerDoubledHalfToken(surface) {
    // LaTeX 转换会把同一数字的纯文本与 TeX 双写粘连（4096 + 4096、68 + 68）；
    // 表面（去空白后）恰为两段相同半部时返回半部，否则返回 null。末尾若带
    // 单位字母或百分号时，只对数值部分检查双写，并把单位保留在半部结果中。
    // 半部至少含 2 个数字；纯数字表面落在 [1000, 2999] 时不拆——那基本是年份
    // 或编号（如 2020、1212），拆成 20、12 会造成误绑定；6868 这类非年份值
    // 不受影响。
    const pickHalf = compact => {
        const doubled = String(compact || '').match(/^([0-9.]+)\1$/);
        if (!doubled) return null;
        const half = doubled[1];
        if (half.replace(/[.]/g, '').length < 2) return null;
        if (/^[0-9]+$/.test(compact)
            && Number(compact) >= 1000 && Number(compact) <= 2999) return null;
        return half;
    };
    const compact = String(surface || '').normalize('NFKC').replace(/\s+/g, '');
    const direct = pickHalf(compact);
    if (direct) return direct;
    const suffix = compact.match(/[%a-zA-Z]+$/)?.[0];
    if (suffix) {
        const half = pickHalf(compact.slice(0, -suffix.length));
        // The explicit separator also distinguishes seconds from a year plural.
        if (half) return `${half} ${suffix}`;
    }
    return null;
}

function readerNumericTokens(value) {
    const tokens = [];
    for (const match of readerNumericTokenMatches(value)) {
        const canonical = canonicalReaderNumericToken(match[0]);
        tokens.push(canonical);
        // 双写粘连的半部与整体同时索引，让“模型写干净值、原文是粘连串”可绑定。
        const half = readerDoubledHalfToken(match[0]);
        if (half) {
            const halfToken = canonicalReaderNumericToken(half);
            if (halfToken !== canonical) tokens.push(halfToken);
        }
    }
    return tokens;
}

function exactSourceExcerpt(sourceText, index, length, maxChars = 800) {
    const source = String(sourceText || '');
    const lower = Math.max(0, index - Math.floor(maxChars / 2));
    const upper = Math.min(source.length, index + length + Math.floor(maxChars / 2));
    const before = source.slice(lower, index);
    const after = source.slice(index + length, upper);
    const beforeBoundary = Math.max(
        before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('. ')
    );
    const afterBoundaries = [after.indexOf('\n'), after.indexOf('。'), after.indexOf('. ')]
        .filter(value => value >= 0);
    const start = lower + (beforeBoundary >= 0 ? beforeBoundary + 1 : 0);
    const end = index + length + (afterBoundaries.length > 0
        ? Math.min(...afterBoundaries) + 1 : after.length);
    const candidate = source.slice(start, end);
    const target = source.slice(index, index + length);
    const relativeTarget = index - start;
    const windowStart = candidate.length > maxChars
        ? Math.max(0, Math.min(
            relativeTarget - Math.floor((maxChars - length) / 2),
            candidate.length - maxChars
        ))
        : 0;
    const quote = candidate.slice(windowStart, windowStart + maxChars).trim();
    if (quote.length >= 12 && quote.includes(target)) return quote;
    // 表格/列表中的数字常独占一行，按句子切分只剩几个字符，会被下游当作无效
    // 证据丢掉；此时按行向两侧扩展，保证证据可用且仍包含目标 token。
    const lineStarts = [0];
    for (const match of source.matchAll(/\n/g)) lineStarts.push(match.index + 1);
    let lineIdx = lineStarts.findIndex((start, cursor) => (
        index >= start && (cursor + 1 === lineStarts.length || index < lineStarts[cursor + 1])
    ));
    if (lineIdx < 0) lineIdx = lineStarts.length - 1;
    const expandedLower = lineStarts[Math.max(0, lineIdx - 4)];
    const expandedUpper = lineStarts[Math.min(lineStarts.length, lineIdx + 5)] ?? source.length;
    const expandedStart = expandedUpper - expandedLower > maxChars
        ? Math.max(expandedLower, Math.min(
            index - Math.floor((maxChars - length) / 2), expandedUpper - maxChars
        ))
        : expandedLower;
    // Preserve indentation, blank lines and original line endings exactly.
    // trim/join creates a different string that cannot replay as an exact quote.
    const expanded = source.slice(expandedStart, Math.min(expandedUpper, expandedStart + maxChars));
    if (expanded.length >= 12 && expanded.includes(source.slice(index, index + length))) {
        return expanded;
    }
    return quote;
}

function sourceNumericTokenExpansions(raw) {
    // 与 readerNumericTokens 同一套展开（含双写粘连半部），供 derive 在来源侧
    // 使用；否则渲染侧的半部 token（如 4096）在来源侧永远找不到。
    const out = new Set([canonicalReaderNumericToken(raw)]);
    const half = readerDoubledHalfToken(raw);
    if (half) out.add(canonicalReaderNumericToken(half));
    return out;
}

function deriveExactTableSourceQuotes(renderedMarkdown, sourceText) {
    const sourceMatches = readerNumericTokenMatches(sourceText);
    const quotes = [];
    for (const token of [...new Set(readerNumericTokens(renderedMarkdown))]) {
        // 逐 token best-effort：单个数字在原文找不到时只跳过它，不再让整张表
        // 的自动修复归零；下游 missingNumbers 仍会对跳过的数字报错，门禁不放松。
        for (const match of sourceMatches) {
            if (!sourceNumericTokenExpansions(match[0]).has(token)
                || !Number.isInteger(match.index)) continue;
            const quote = exactSourceExcerpt(sourceText, match.index, match[0].length);
            if (quote.length < 12 || !sourceText.includes(quote)) continue;
            if (!quotes.includes(quote)) quotes.push(quote);
            break;
        }
    }
    return quotes;
}

function artifactTableBindingCanReplay(binding, renderedRows, structuredArtifacts) {
    const sourceTable = (structuredArtifacts.tables || []).find(item => (
        item?.ordinal === binding?.sourceTableOrdinal && item?.recoveryStatus === 'complete'
    ));
    const expectedCount = renderedRows.reduce((sum, row) => sum + row.length, 0);
    if (!sourceTable || !recoverySha256(sourceTable.sourceDomSha256)
        || !Array.isArray(binding?.cellBindings)
        || binding.cellBindings.length !== expectedCount) return false;
    const seen = new Set();
    return binding.cellBindings.every(cellBinding => {
        const renderedText = renderedRows?.[cellBinding?.renderedRow]?.[cellBinding?.renderedColumn];
        const key = `${cellBinding?.renderedRow}:${cellBinding?.renderedColumn}`;
        const sourceCell = findStructuredTableCell(
            sourceTable, cellBinding?.sourceRow, cellBinding?.sourceColumn
        );
        if (renderedText === undefined || seen.has(key) || !sourceCell
            || !recoverySha256(sourceCell.sourceDomSha256)
            || normalizeReaderSourceCell(renderedText)
                !== normalizeReaderSourceCell(sourceCell.text)) return false;
        seen.add(key);
        return true;
    }) && seen.size === expectedCount;
}

function bindApiReaderSourceEvidence(article, declaredTableBindings, declaredFormulaBindings, options = {}) {
    const structuredArtifacts = options.structuredArtifacts;
    const sourceText = String(options.sourceText || '');
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') {
        throw new Error('Reader source-binding v4 需要 structuredArtifacts');
    }
    if (!sourceText || !recoverySha256(structuredArtifacts.payloadSha256)) {
        throw new Error('Reader source-binding v4 需要已绑定全文和 structuredArtifacts payload SHA');
    }
    const { payloadSha256: declaredArtifactsSha256, ...artifactBody } = structuredArtifacts;
    const replayedArtifactsSha256 = crypto.createHash('sha256')
        .update(JSON.stringify(artifactBody)).digest('hex');
    const sourceTextSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (declaredArtifactsSha256 !== replayedArtifactsSha256
        || structuredArtifacts.flattenedTextSha256 !== sourceTextSha256) {
        throw new Error('Reader source-binding v4 的 structuredArtifacts/fulltext SHA 无法重放');
    }
    if (!Array.isArray(declaredFormulaBindings) || !Array.isArray(declaredTableBindings)) {
        throw new Error('Reader source-binding v4 要求 tableBindings/formulaBindings 数组');
    }

    if (String(article || '').includes('原文中没有可逐字绑定的数值证据')) {
        throw new Error('Reader source-binding v4 正文含内部绑定失败占位；必须修复证据与表格，不得把绑定失败写成原文缺失');
    }
    let boundArticle = normalizeApiReaderTablePasteArtifacts(String(article || ''));
    const formulaOrdinals = new Set();
    const formulaBindings = declaredFormulaBindings.map((binding, index) => {
        assertExactObjectKeys(
            binding, ['formulaOrdinal', 'targetKind', 'marker'],
            `读者文章 formulaBindings[${index}]`
        );
        const formula = (structuredArtifacts.formulas || []).find(item => (
            item?.ordinal === binding.formulaOrdinal && item?.recoveryStatus === 'complete'
        ));
        const marker = String(binding.marker || '').trim();
        if (!formula || !Number.isInteger(binding.formulaOrdinal)
            || formulaOrdinals.has(binding.formulaOrdinal)
            || marker !== `[[FORMULA_${binding.formulaOrdinal}]]`
            || !API_READER_KINDS.includes(binding.targetKind)) {
            throw new Error(`读者文章 formulaBindings[${index}] 来源或 marker 非法`);
        }
        const markerMatches = boundArticle.split(marker).length - 1;
        const markerBlock = boundArticle.split(/\n\s*\n/).some(block => block.trim() === marker);
        const targetSection = (options.sections || []).find(section => (
            section?.kind === binding.targetKind
            && String(section.body || '').split(/\n\s*\n/).some(block => block.trim() === marker)
        ));
        if (markerMatches !== 1 || !markerBlock || !targetSection) {
            throw new Error(`读者文章 formulaBindings[${index}] marker 必须在正文独占且仅出现一次`);
        }
        const latex = String(formula.latex || '').trim();
        if (!latex || !recoverySha256(formula.sourceDomSha256)) {
            throw new Error(`读者文章 formulaBindings[${index}] 原始公式缺少 TeX/DOM SHA`);
        }
        const renderedBlock = `\\[${latex}\\]`;
        boundArticle = boundArticle.replace(marker, renderedBlock);
        formulaOrdinals.add(binding.formulaOrdinal);
        return {
            formulaOrdinal: binding.formulaOrdinal,
            targetKind: binding.targetKind,
            marker,
            latex,
            sourceDomSha256: formula.sourceDomSha256,
            renderedBlockSha256: crypto.createHash('sha256').update(renderedBlock).digest('hex')
        };
    });

    // Never replace unsupported cells with reader-visible diagnostics. The
    // exact cell/quote gates below throw into the existing Reader repair loop.
    const renderedTables = extractMarkdownTables(boundArticle);
    const renderedFormulaBlocks = [...boundArticle.matchAll(/\\\[[\s\S]*?\\\]/g)]
        .map(match => match[0]);
    if (renderedFormulaBlocks.length !== formulaBindings.length
        || formulaBindings.some(binding => (
            renderedFormulaBlocks.filter(block => (
                crypto.createHash('sha256').update(block).digest('hex')
                    === binding.renderedBlockSha256
            )).length !== 1
        ))) {
        throw new Error('Reader source-binding v4 检测到未绑定、重复或被改写的展示公式');
    }
    const effectiveTableBindings = declaredTableBindings.slice(0, renderedTables.length);
    if (options.allowDeterministicQuoteRepair === true
        && effectiveTableBindings.length < renderedTables.length) {
        for (let index = effectiveTableBindings.length; index < renderedTables.length; index++) {
            const derived = deriveExactTableSourceQuotes(
                renderedTables[index].markdown, sourceText
            );
            if (derived.length === 0) break;
            effectiveTableBindings.push({
                tableIndex: index + 1,
                sourceType: 'source_quotes',
                sourceTableOrdinal: null,
                cellBindings: [],
                sourceQuotes: derived
            });
        }
    }
    if (effectiveTableBindings.length !== renderedTables.length) {
        throw new Error(
            `Reader source-binding v4 表格绑定数量 ${effectiveTableBindings.length}`
            + ` 与正文表格数量 ${renderedTables.length} 不一致`
        );
    }
    const tableIndexes = new Set();
    const tableBindings = effectiveTableBindings.map((declaredBinding, index) => {
        assertExactObjectKeys(
            declaredBinding,
            ['tableIndex', 'sourceType', 'sourceTableOrdinal', 'cellBindings', 'sourceQuotes'],
            `读者文章 tableBindings[${index}]`
        );
        const rendered = renderedTables[index];
        const renderedRows = [rendered.header, ...rendered.rows];
        let binding = declaredBinding;
        if (options.allowDeterministicQuoteRepair === true
            && binding.sourceType === 'artifact_table'
            && !(options.selectionTableIndexes || []).includes(binding.tableIndex)
            && !artifactTableBindingCanReplay(
                binding, renderedRows, structuredArtifacts
            )) {
            const derived = deriveExactTableSourceQuotes(rendered.markdown, sourceText);
            if (derived.length > 0) {
                binding = {
                    tableIndex: binding.tableIndex,
                    sourceType: 'source_quotes',
                    sourceTableOrdinal: null,
                    cellBindings: [],
                    sourceQuotes: derived
                };
            }
        }
        if (binding.tableIndex !== index + 1 || tableIndexes.has(binding.tableIndex)) {
            throw new Error(`读者文章 tableBindings[${index}].tableIndex 必须按正文顺序唯一递增`);
        }
        tableIndexes.add(binding.tableIndex);
        const renderedTableSha256 = crypto.createHash('sha256')
            .update(rendered.markdown).digest('hex');
        if (binding.sourceType === 'artifact_table') {
            const sourceTable = (structuredArtifacts.tables || []).find(item => (
                item?.ordinal === binding.sourceTableOrdinal && item?.recoveryStatus === 'complete'
            ));
            if (!sourceTable || !recoverySha256(sourceTable.sourceDomSha256)
                || !Array.isArray(binding.cellBindings) || binding.sourceQuotes?.length !== 0) {
                throw new Error(`读者文章 tableBindings[${index}] 原始表绑定不完整`);
            }
            const expectedCells = renderedRows.flatMap((row, renderedRow) => (
                row.map((_cell, renderedColumn) => ({ renderedRow, renderedColumn }))
            ));
            if (binding.cellBindings.length !== expectedCells.length) {
                throw new Error(`读者文章 tableBindings[${index}] 必须逐格绑定全部渲染单元格`);
            }
            const seenRenderedCells = new Set();
            const cellBindings = binding.cellBindings.map((cellBinding, cellIndex) => {
                assertExactObjectKeys(
                    cellBinding,
                    ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn'],
                    `读者文章 tableBindings[${index}].cellBindings[${cellIndex}]`
                );
                const renderedRow = cellBinding.renderedRow;
                const renderedColumn = cellBinding.renderedColumn;
                const renderedText = renderedRows?.[renderedRow]?.[renderedColumn];
                const key = `${renderedRow}:${renderedColumn}`;
                const sourceCell = findStructuredTableCell(
                    sourceTable, cellBinding.sourceRow, cellBinding.sourceColumn
                );
                if (renderedText === undefined || seenRenderedCells.has(key) || !sourceCell
                    || !recoverySha256(sourceCell.sourceDomSha256)) {
                    throw new Error(`读者文章 tableBindings[${index}] 单元格坐标或 DOM SHA 非法`);
                }
                if (normalizeReaderSourceCell(renderedText)
                    !== normalizeReaderSourceCell(sourceCell.text)) {
                    throw new Error(
                        `读者文章 tableBindings[${index}] 渲染单元格与原始 cell 不一致: ${key}`
                    );
                }
                seenRenderedCells.add(key);
                return {
                    ...cellBinding,
                    renderedText: String(renderedText),
                    sourceText: String(sourceCell.text),
                    sourceDomSha256: sourceCell.sourceDomSha256
                };
            });
            if (seenRenderedCells.size !== expectedCells.length) {
                throw new Error(`读者文章 tableBindings[${index}] 渲染单元格覆盖不完整`);
            }
            return {
                tableIndex: binding.tableIndex,
                sourceType: binding.sourceType,
                sourceTableOrdinal: binding.sourceTableOrdinal,
                sourceTableDomSha256: sourceTable.sourceDomSha256,
                renderedTableSha256,
                cellBindings,
                sourceQuotes: []
            };
        }
        if (binding.sourceType !== 'source_quotes' || binding.sourceTableOrdinal !== null
            || !Array.isArray(binding.cellBindings) || binding.cellBindings.length !== 0
            || !Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.length < 1) {
            throw new Error(`读者文章 tableBindings[${index}] 正文 quote 绑定结构非法`);
        }
        const validDeclaredQuotes = binding.sourceQuotes.filter(quote => (
            typeof quote === 'string' && quote.length >= 12 && quote.length <= 4000
            && sourceText.includes(quote)
        ));
        if (validDeclaredQuotes.length !== binding.sourceQuotes.length
            && options.allowDeterministicQuoteRepair !== true) {
            const quoteIndex = binding.sourceQuotes.findIndex(quote => (
                typeof quote !== 'string' || quote.length < 12 || quote.length > 4000
                || !sourceText.includes(quote)
            ));
            throw new Error(
                `读者文章 tableBindings[${index}].sourceQuotes[${quoteIndex}]` +
                ' 不是全文中的 exact sourceQuote'
            );
        }
        const repairedQuotes = options.allowDeterministicQuoteRepair === true
            ? deriveExactTableSourceQuotes(rendered.markdown, sourceText) : [];
        const exactQuotes = [...new Set([...validDeclaredQuotes, ...repairedQuotes])];
        if (exactQuotes.length === 0) {
            throw new Error(`读者文章 tableBindings[${index}] 无法确定性绑定 exact sourceQuote`);
        }
        const sourceQuotes = exactQuotes.map((quote, quoteIndex) => {
            if (quote.length < 12 || quote.length > 4000 || !sourceText.includes(quote)) {
                throw new Error(
                    `读者文章 tableBindings[${index}].sourceQuotes[${quoteIndex}]` +
                    ' 不是全文中的 exact sourceQuote'
                );
            }
            return {
                quote,
                sourceQuoteSha256: crypto.createHash('sha256').update(quote).digest('hex')
            };
        });
        const quoteCorpus = sourceQuotes.map(item => item.quote).join('\n');
        const missingNumbers = readerNumericTokens(rendered.markdown).filter(token => (
            !readerNumericTokens(quoteCorpus).includes(token)
        ));
        if (missingNumbers.length > 0) {
            const missingSet = new Set(missingNumbers);
            const affectedCells = renderedRows.flatMap((row, rowIndex) => (
                row.map((cell, columnIndex) => {
                    const missing = [...new Set(readerNumericTokens(cell))]
                        .filter(token => missingSet.has(token));
                    if (missing.length === 0) return null;
                    return `row=${rowIndex},column=${columnIndex}`
                        + ` text=${JSON.stringify(String(cell).slice(0, 120))}`
                        + ` missing=${missing.join(',')}`;
                }).filter(Boolean)
            )).slice(0, 6);
            throw new Error(
                `读者文章 tableBindings[${index}] 关键数字缺少 exact quote/cell 证据: `
                + [...new Set(missingNumbers)].join(', ')
                + `；未绑定单元格（行列从 0 开始，表头为第 0 行）：${affectedCells.join('；')}`
                + '。请核对这些单元格的数字及完整单位与对应来源句；时长应保留如“1 s”的单位写法，'
                + '不要只写“1”或改成“1 秒”，也不要用其他语境中的同一数字补证据。'
            );
        }
        return {
            tableIndex: binding.tableIndex,
            sourceType: binding.sourceType,
            sourceTableOrdinal: null,
            renderedTableSha256,
            cellBindings: [],
            sourceQuotes
        };
    });
    return {
        article: boundArticle,
        tableBindings,
        formulaBindings,
        sourceBindingsSha256: stableFingerprint({ tableBindings, formulaBindings })
    };
}

function canonicalReaderBridgeTerm(term) {
    const numeralMap = {
        一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5',
        六: '6', 七: '7', 八: '8', 九: '9', 十: '10'
    };
    return String(term || '').normalize('NFKC')
        .replace(/[一二两三四五六七八九十](?=阶|路|次|维|步|层|个|段|类|组|轮|种)/g,
            value => numeralMap[value])
        .replace(/[一二两三四五六七八九十](?=对)/g,
            value => numeralMap[value])
        .replace(/(对)([一二两三四五六七八九十])/g,
            (_, prefix, value) => `${prefix}${numeralMap[value]}`)
        .replace(/\s+/g, '')
        .toLowerCase();
}

function collapseRepeatedReaderBridgeHeadings(article) {
    let fence = null;
    return String(article || '').split(/(\r?\n[ \t]*\r?\n)/).map(block => {
        const wasFenced = Boolean(fence);
        for (const line of block.split('\n')) {
            const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (!marker) continue;
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
        }
        if (wasFenced || /^ {0,3}(?:`{3,}|~{3,})/.test(block)) return block;
        const match = block.match(/^([ \t]*)(\*\*[^*×\r\n]+×[^*×\r\n]+：\*\*)/);
        if (!match) return block;
        const heading = match[2];
        let remainder = block.slice(match[0].length);
        let changed = false;
        while (true) {
            const spacing = remainder.match(/^[ \t\r\n]*/)[0];
            if (!remainder.slice(spacing.length).startsWith(heading)) break;
            remainder = remainder.slice(spacing.length + heading.length);
            changed = true;
        }
        return changed ? match[0] + remainder : block;
    }).join('');
}

function findReaderBridgeParagraph(articleBlocks, terms) {
    if (!Array.isArray(terms) || terms.length !== 2) return null;
    const expected = terms.map(canonicalReaderBridgeTerm);
    const matches = articleBlocks.filter(block => {
        const heading = /^\*\*(.+?)：\*\*/.exec(block)?.[1];
        if (!heading) return false;
        const actualTerms = heading.split(/\s*×\s*/);
        return actualTerms.length === 2
            && actualTerms.map(canonicalReaderBridgeTerm)
                .every((value, index) => value === expected[index]);
    });
    return matches.length === 1 ? matches[0] : null;
}

function isReaderHeadingIssue(issue, article) {
    if (issue?.code !== 'quantitative_chinese_numeral' || !Number.isInteger(issue.line)) {
        return false;
    }
    const line = String(article || '').split('\n')[issue.line - 1] || '';
    return /^###\s+/.test(line) && line.includes(String(issue.match || '').trim());
}

function restoreReaderSectionHeadings(article, sections) {
    let index = 0;
    return String(article || '').replace(/^###\s+.+?\s*$/gm, () => {
        const heading = sections[index]?.heading;
        index += 1;
        return heading ? `### ${heading.trim()}` : '';
    });
}

const GENERIC_READER_HEADING_RE = /^(?:任务背景|背景与动机|问题定义|相关工作|方法(?:概述|全景|介绍)|核心创新(?:点)?|实验(?:设置|结果|分析)|结果分析|细节详述|局限(?:分析|与问题)?|复现(?:指南|说明)|总结(?:与展望)?|结论)$/;

function makeReaderHeadingSpecific(kind, heading, readerTitle) {
    const normalizedHeading = String(heading || '').trim();
    if (normalizedHeading.length >= 8 && normalizedHeading.length <= 80
        && !GENERIC_READER_HEADING_RE.test(normalizedHeading)) return normalizedHeading;
    const title = String(readerTitle || '').trim().replace(/[？?！!。]+$/, '').slice(0, 48);
    const templates = {
        background: `理解“${title}”前，先要看清什么问题？`,
        related_work: `围绕“${title}”，已有路线还缺了什么？`,
        problem: `“${title}”真正要回答哪些问题？`,
        method_overview: `“${title}”背后的完整数据流是什么？`,
        component: `“${title}”由哪些关键组件共同完成？`,
        training: `“${title}”怎样训练、求解或配置？`,
        experiment_setup: `怎样公平检验“${title}”是否成立？`,
        result: `哪些数字真正支持“${title}”？`,
        ablation: `拆掉哪些组件后，“${title}”不再成立？`,
        limitation: `“${title}”还不能说明什么？`,
        reproduction: `复现“${title}”前要核对哪些细节？`,
        synthesis: `读完“${title}”，初学者该带走什么？`
    };
    return (templates[kind] || `关于“${title}”，${heading}应回答什么？`).slice(0, 80);
}

function ensureApiReaderTableNarratives(article) {
    // Formatting only: a heading followed by existing prose must become two
    // Markdown blocks so the narrative gate can see the authored explanation.
    // Never synthesize claims about comparability, uncertainty or missing costs.
    // Truly absent prose is reported by validateApiReaderTableNarratives and
    // repaired by the Reader author with the actual paper evidence.
    const lines = String(article || '').split('\n');
    const output = [];
    let fence = null;
    for (const [index, line] of lines.entries()) {
        output.push(line);
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
            continue;
        }
        if (marker) {
            fence = marker[1];
            continue;
        }
        if (/^ {0,3}#{1,6}[ \t]+\S/.test(line) && lines[index + 1]?.trim()) output.push('');
    }
    return output.join('\n');
}

function relocateExplicitReaderTableExplanations(article) {
    const original = String(article || '');
    const blocks = original.split(/(\r?\n[ \t]*\r?\n)/).map(text => ({ text, separator: /^\r?\n[ \t]*\r?\n$/.test(text), fenced: false }));
    let fence = null;
    for (const block of blocks) {
        if (block.separator) continue;
        let protectedBlock = Boolean(fence);
        for (const line of block.text.split(/\r?\n/)) {
            const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (!marker) continue;
            protectedBlock = true;
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
        }
        block.fenced = protectedBlock;
    }
    const chineseChars = text => (String(text || '').match(/[\u3400-\u9fff]/g) || []).length;
    let changed = false;
    for (let index = 0; index < blocks.length; index += 1) {
        const table = blocks[index];
        if (table.separator || table.fenced || !/^\|.+\|$/m.test(table.text.trim())
            || !/^\|(?:\s*:?-{3,}:?\s*\|)+$/m.test(table.text.trim())) continue;
        const beforeIndex = index - 2, nextIndex = index + 2;
        const before = blocks[beforeIndex]; const next = blocks[nextIndex];
        if (!before || before.separator || before.fenced || (next && (next.separator || next.fenced))) continue;
        if (next && !/^(?:###|\|)/.test(next.text.trim())) continue;
        const matches = [...before.text.matchAll(/表后解释(?:是|为|：|:)/g)];
        if (!matches.length) continue;
        const markerIndex = matches.at(-1).index;
        const lead = before.text.slice(0, markerIndex).replace(/[ \t]+$/g, '');
        const explanation = before.text.slice(markerIndex);
        if (!/[。！？!?；;]$/.test(lead)
            || chineseChars(lead) < READER_LIMITS.tableLeadChineseChars
            || chineseChars(explanation) < READER_LIMITS.tableExplanationChineseChars) continue;
        before.text = lead;
        const separator = blocks[index + 1]?.separator ? blocks[index + 1].text : '\n\n';
        blocks.splice(index + 2, 0, { text: explanation, separator: false, fenced: false },
            { text: separator, separator: true, fenced: false });
        changed = true; index += 2;
    }
    return changed ? blocks.map(block => block.text).join('') : original;
}

function splitReaderLongParagraphs(text, targetChineseChars = 190, maxChineseChars = 240) {
    const chineseCount = value => (String(value || '').match(/[\u3400-\u9fff]/g) || []).length;
    const protectedBlock = value => /^(?:```|~~~|\||[-*+]\s|\d+\.\s|!\[|\$\$|\\\[)/.test(value.trim());
    return String(text || '').trim().split(/\n\s*\n/).flatMap(paragraph => {
        const trimmed = paragraph.trim();
        const sentenceEndCount = (trimmed.match(/[。！？!?；;]/g) || []).length;
        if (!trimmed || protectedBlock(trimmed)
            || (chineseCount(trimmed) <= maxChineseChars && sentenceEndCount <= 6)) {
            return [trimmed];
        }
        const sentences = trimmed.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [trimmed];
        const groups = [];
        let current = '';
        let currentSentences = 0;
        for (const sentence of sentences) {
            const next = `${current}${sentence}`;
            if (current && (chineseCount(next) > targetChineseChars || currentSentences >= 5)) {
                groups.push(current.trim());
                current = sentence;
                currentSentences = 1;
            } else {
                current = next;
                currentSentences += 1;
            }
        }
        if (current.trim()) groups.push(current.trim());
        return groups;
    }).filter(Boolean).join('\n\n');
}

function normalizeReaderEditorialSurface(text, quantitativeIssues = []) {
    const protectedMarkdown = [];
    const protect = value => {
        const token = `__PD_READER_PROTECTED_${protectedMarkdown.length}__`;
        protectedMarkdown.push(value);
        return token;
    };
    // Literal evidence is not editorial prose. Protect before every surface
    // rewrite (including currency/spacing), and restore nested spans in reverse.
    const protectedText = String(text || '')
        .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[`~]*[ \t]*(?=\n|$)/gm, protect)
        .replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[^\n$]*?(?<!\\)\$/g, protect)
        .replace(/(`+)[^\n]*?\1/g, protect)
        .replace(/!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)|https:\/\/[^\s<>()\[\]{}"'，。；：！？、\u3400-\u9fff]+/g, protect)
        .replace(/^ {0,3}>[^\n]*/gm, protect)
        .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g, protect)
        .replace(/^(?:原文|原句|口语(?:转录|转写|输出)|输入(?:转录)?|Spoken(?:-form)?(?: transcript)?|Transcript|Input)\s*[:：][^\n]*/gmi, protect)
        .replace(/^\s*\|\s*(?:输入|口语输出|原文|原句|Input|Spoken(?:-form)?)[^|\n]*\|[^\n]*/gmi, protect);
    let normalized = protectedText
        .replace(/([\u3400-\u9fff])([A-Za-z][A-Za-z0-9+.-]*)/g, '$1 $2')
        .replace(/([\u3400-\u9fff])([α-ωΑ-Ω])/g, '$1 $2')
        .replace(/([A-Za-z0-9.%+)\]α-ωΑ-Ω])([\u3400-\u9fff])/g, '$1 $2')
        // Paper prompts often spell placeholders as <S> or <True/False>.
        // Hugo treats those bytes as raw HTML unless the reader article binds
        // them as inline code before publication.
        .replace(
            /(?<!`)<([A-Za-z][A-Za-z0-9_./| -]{0,39})>(?!`)/g,
            '`<$1>`'
        );
    const numeralMap = {
        零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
        六: 6, 七: 7, 八: 8, 九: 9
    };
    const smallChineseInteger = raw => {
        if (!raw) return 0;
        if (Object.prototype.hasOwnProperty.call(numeralMap, raw)) return numeralMap[raw];
        let total = 0, digit = null, lastUnit = 10000, zero = false;
        for (const char of raw) {
            if (Object.prototype.hasOwnProperty.call(numeralMap, char)) {
                if (numeralMap[char] === 0) {
                    if (!total || digit !== null || zero) return null;
                    zero = true;
                    continue;
                }
                if (digit !== null) return null; // No guessing a digit sequence.
                digit = numeralMap[char];
                continue;
            }
            const unit = ({ 十: 10, 百: 100, 千: 1000 })[char];
            if (!unit || unit >= lastUnit || (digit === null && total)) return null;
            total += (digit ?? 1) * unit;
            lastUnit = unit; digit = null; zero = false;
        }
        // Colloquial 一百二 may mean 120 or 102; require an explicit place/zero.
        if ((digit !== null && total && lastUnit > 10 && !zero) || (zero && digit === null)) return null;
        return total + (digit ?? 0);
    };
    const chineseInteger = raw => {
        for (const [symbol, multiplier] of [['亿', 100000000], ['万', 10000]]) {
            if (!raw.includes(symbol)) continue;
            const parts = raw.split(symbol);
            if (parts.length !== 2 || /[万亿]/.test(parts[0])) return null;
            const high = parts[0] ? smallChineseInteger(parts[0]) : 1;
            const low = parts[1] ? chineseInteger(parts[1].replace(/^[零〇]/, '')) : 0;
            if (high === null || low === null || low >= multiplier
                || (parts[1] && !/^[零〇]|[十百千万]/.test(parts[1]))) return null;
            const result = high * multiplier + low;
            return Number.isSafeInteger(result) ? result : null;
        }
        return smallChineseInteger(raw);
    };
    const chineseNumber = raw => {
        const sign = /^[负正]/.test(raw) ? (raw[0] === '负' ? '-' : '+') : '';
        const unsigned = raw.replace(/^[负正]/, '');
        const parts = unsigned.split('点');
        if (parts.length > 2) return null;
        const integer = chineseInteger(parts[0]);
        if (integer === null) return null;
        if (parts.length === 1) return sign + integer;
        if (!/^[零〇一二两三四五六七八九]+$/.test(parts[1])) return null;
        return `${sign}${integer}.${[...parts[1]].map(char => numeralMap[char]).join('')}`;
    };
    // A diagnostic may name only “万词/万步”, after typography inserted a
    // space between the Arabic coefficient and its scale. Convert only the
    // complete, unambiguous coefficient+scale; never replace that suffix alone.
    if (quantitativeIssues.some(issue => issue?.code === 'quantitative_chinese_numeral'
        && /[万亿]/.test(String(issue.match || '')))) {
        const amount = '[+-]?\\d+(?:\\.\\d+)?';
        const units = `(?:${SCALED_ARABIC_MEASUREMENT_UNITS
            .slice().sort((a, b) => b.length - a.length)
            .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z])`;
        const range = `(?:[-–—至到][ \\t]*${amount}[ \\t]*[万亿][ \\t]*${units})`;
        const pattern = new RegExp(`(?<![A-Za-z0-9.,/])(${amount})[ \\t]*([万亿])(?=[ \\t]*(?:${units}|${range}|[，。；：,.;:]|$))`, 'g');
        normalized = normalized.replace(pattern, (surface, value, scale, offset, whole) => {
            const before = whole.slice(0, offset).trimEnd();
            if (/[A-Za-z0-9.,/^×*]$/.test(before)
                || (/[万亿]$/.test(before) && !/^[+-]/.test(value))) return surface;
            const sign = /^[+-]/.test(value) ? value[0] : '';
            const [integer, fraction = ''] = value.replace(/^[+-]/, '').split('.');
            const shift = scale === '万' ? 4 : 8;
            const digits = (integer + fraction).padEnd(integer.length + shift, '0');
            const wholePart = digits.slice(0, integer.length + shift).replace(/^0+(?=\d)/, '');
            const fractionalPart = digits.slice(integer.length + shift).replace(/0+$/, '');
            // Decimal-point shifting is exact; no Number multiplication or
            // locale rounding may silently alter a scientific decimal tail.
            return sign + wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
                + (fractionalPart ? `.${fractionalPart}` : '');
        });
    }
    for (const issue of quantitativeIssues) {
        if (issue?.code !== 'quantitative_chinese_numeral'
            || isAllowedReaderNarrativeNumeralIssue(issue, text)) continue;
        const match = String(issue.match || '').trim();
        if (!match) continue;
        // Explicit mixed scales were handled as a whole above. Unsupported
        // compound scales remain visible for the authoritative gate to reject.
        if (/\d[ \t]*[万亿]/.test(match)) continue;
        // Fractions and ambiguous scaled units are not local substitutions.
        if (/分之|一半|半宽|千分贝|毫分贝/.test(match)) continue;
        let valid = true;
        const replacement = /^[几数]\s*10$/.test(match)
            ? '数十'
            : /^[几数]\s*(\d+(?:\.\d+)?)$/.test(match)
                ? match.replace(/^[几数]\s*/, '约 ')
                : match
                    .replace(/(\d+(?:\.\d+)?)\s*万/g, (_, value) => (
                        Number(value) * 10000
                    ).toLocaleString('en-US', { maximumFractionDigits: 10 }))
                    .replace(/[负正]?[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?/g, raw => {
                        const parsed = chineseNumber(raw);
                        if (parsed === null) { valid = false; return raw; }
                        return parsed;
                    })
                    .replace(/(\d)([\u3400-\u9fff])/g, '$1 $2');
        if (!valid) continue;
        normalized = normalized.replaceAll(match, (surface, offset, whole) => {
            const before = whole.slice(0, offset), after = whole.slice(offset + surface.length);
            // An issue can name only a suffix of a longer number/fraction.
            if (/[零〇一二两三四五六七八九十百千万亿\d]$|分之$/.test(before.trimEnd())
                || /^[零〇一二两三四五六七八九十百千万亿\d]|^点[零〇一二两三四五六七八九\d]|^分之/.test(after)
                || (/[毫千]$/.test(surface) && /^分贝/.test(after))) return surface;
            return replacement;
        });
    }
    normalized = normalized
        .replace(/跨窗口\s*1\s*致性/g, '跨窗口一致性')
        .replace(/\b1\s*到\s*5\s+5\s*级量表/g, '1 到 5 级量表')
        .replace(/y\s*到\s*5\s+2\s*段/g, 'y 到 5 这 2 段')
        .replace(/[；;](?=\s*(?:\n\s*\n|$))/g, '。')
        .replace(/数十\s+(?=[\u3400-\u9fff])/g, '数十')
        .replace(/([下上这另哪])\s*1\s*(?=步|层|类|种|段|项|组|张|个)/g, '$1一')
        .replace(/([同唯统单])\s*1\s*(?=[\u3400-\u9fff])/g, '$1一')
        .replace(/归\s*1\s*(?=化|后|组合|处理|权重)/g, '归一')
        .replace(
            /(\d+)\s+(?=(?:数据集|模型|系统|方法|基线|语料库|语言|方言|条件|任务|阶段|模块|组件|分支|锚点|图|表)(?:[，。；：、\s]|$))/g,
            '$1 个'
        )
        .replace(/([\u3400-\u9fff])([-+]\d)/g, '$1 $2')
        .replace(/([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?=(?:mW|mJ|ms|dB|Hz|kHz|MHz|KiB|KB|MB|GB|kbps?|Mbps?|Gbps?|MACs?|tokens?|FPS|bit)\b)/gi, '$1 ')
        .replace(/([\u3400-\u9fff])(\d)/g, '$1 $2')
        .replace(/(\d)([\u3400-\u9fff])/g, '$1 $2');
    // Never infer missing %, or copy a later unit onto an earlier value.
    // Author/source validation, not typography, decides those semantics.
    const restored = protectedMarkdown.reduceRight(
        (value, original, index) => value.replace(
            `__PD_READER_PROTECTED_${index}__`, () => original
        ),
        normalizeReaderCurrencyAmounts(normalized)
    );
    return restored;
}

function normalizeReaderCurrencyAmounts(value) {
    const replacement = (full, amount, scale = '') => (
        `${amount}${String(scale || '').trim() ? ` ${String(scale).trim()}` : ''} 美元`
    );
    return String(value || '')
        .replace(/\\\$(\d+(?:\.\d+)?)(\s*(?:thousand|million|billion))?/gi, replacement)
        .replace(/(?<!\\)\$(\d+(?:\.\d+)?)(\s*(?:thousand|million|billion))?/gi, replacement);
}

function getApiReaderFigureInventory(structuredArtifacts, arxivId = '') {
    const expectedId = String(arxivId || '').trim().toLowerCase().replace(/v\d+$/i, '');
    const inventory = [];
    for (const figure of structuredArtifacts?.figures || []) {
        if (figure?.recoveryStatus !== 'complete'
            || !Number.isInteger(figure.ordinal)
            || !recoverySha256(figure.sourceDomSha256)) continue;
        const resources = Array.isArray(figure.images) ? figure.images : [];
        // arXiv frequently represents a compound figure as several sibling
        // resources while attaching the full multi-panel caption to the
        // wrapper.  Selecting only the first child makes the caption claim
        // panels that are not present in the downloaded bytes.  Keep only
        // one-resource figures until the pipeline can compose all panels.
        if (resources.length !== 1 || resources[0]?.kind !== 'external_url') continue;
        const resource = resources[0];
        let parsed;
        try {
            parsed = new URL(String(resource.url || ''));
        } catch (_) {
            continue;
        }
        const host = parsed.hostname.toLowerCase();
        const pathMatch = parsed.pathname.match(/^\/html\/(\d{4}\.\d{4,5})(?:v\d+)?\//i);
        if (parsed.protocol !== 'https:'
            || !['arxiv.org', 'www.arxiv.org'].includes(host)
            || !pathMatch
            || (expectedId && pathMatch[1].toLowerCase() !== expectedId)
            || (String(resource.mediaType || '').toLowerCase() !== 'image/svg+xml'
                && !isSupportedImageUrl(parsed.toString()))) continue;
        inventory.push({
            ordinal: figure.ordinal,
            label: String(figure.label || `Figure ${figure.ordinal}`).replace(/\s+/g, ' ').trim(),
            caption: String(figure.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
            url: parsed.toString(),
            mediaType: String(resource.mediaType || '').toLowerCase(),
            sourceDomSha256: figure.sourceDomSha256
        });
        if (inventory.length >= API_READER_FIGURE_LIMIT) break;
    }
    return inventory;
}

function recoverySha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function buildApiReaderArtifactEvidence(
    structuredArtifacts,
    arxivId = '',
    maxChars = Math.min(
        60000,
        Math.max(20000, Math.floor(API_READER_EVIDENCE_MAX_CHARS * 0.35))
    )
) {
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') return '';
    const lines = ['[READER_ARTIFACTS] 结构化原文图表与公式（正文细节必须优先引用这里）'];
    let usedChars = lines[0].length;
    const appendLine = (line, minimumChars = 0) => {
        const remaining = maxChars - usedChars - 1;
        if (remaining < minimumChars || remaining <= 0) return false;
        const raw = String(line || '');
        const value = raw.slice(0, remaining);
        lines.push(value);
        usedChars += value.length + 1;
        return value.length === raw.length;
    };
    // Figure identity participates in publication provenance, so reserve it
    // before verbose matrices rather than truncating its ordinal or URL.
    for (const figure of getApiReaderFigureInventory(structuredArtifacts, arxivId)) {
        appendLine(`FIGURE_${figure.ordinal}: ${figure.caption}`, 32);
        appendLine(`FIGURE_${figure.ordinal}_URL: ${figure.url}`, 48);
    }
    for (const formula of (structuredArtifacts.formulas || []).slice(0, 12)) {
        const latex = String(formula?.latex || '').trim();
        if (latex) appendLine(`FORMULA_${formula.ordinal}: ${latex}`, 24);
    }
    const tables = (structuredArtifacts.tables || []).slice(0, 12);
    for (let index = 0; index < tables.length; index++) {
        const table = tables[index];
        const matrix = Array.isArray(table?.matrix) ? table.matrix.slice(0, 40) : [];
        const header = `TABLE_${table.ordinal}: ${String(table?.caption || '').replace(/\s+/g, ' ').trim()}`;
        if (!appendLine(header, 24)) break;
        const tableMetadata = [
            `TABLE_${table.ordinal}_SELECTION: ${JSON.stringify(assessReaderTableSelectionEligibility(table))}`,
            `TABLE_${table.ordinal}_HEADER_ROWS: ${JSON.stringify(table.headerRows || [])}`,
            `TABLE_${table.ordinal}_SHAPE: ${JSON.stringify({
                rows: Array.isArray(table.matrix) ? table.matrix.length : 0,
                columns: Array.isArray(table.matrix?.[0]) ? table.matrix[0].length : 0,
                shownRows: matrix.length,
                role: 'unknown'
            })}`
        ].join('\n');
        // Header identity is a source property, never inferred from a caption
        // (an author/affiliation table is not automatically an experiment).
        if (!appendLine(tableMetadata, tableMetadata.length)) break;
        const remainingTables = Math.max(1, tables.length - index);
        const matrixBudget = Math.max(
            256,
            Math.floor((maxChars - usedChars) / remainingTables)
        );
        appendLine(JSON.stringify(matrix).slice(0, matrixBudget), 32);
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

function buildApiReaderEvidenceContext(_analysis, sourceText, structuredArtifacts, arxivId = '') {
    const artifactBudget = Math.min(
        60000,
        Math.max(20000, Math.floor(API_READER_EVIDENCE_MAX_CHARS * 0.35)),
        Math.max(0, API_READER_EVIDENCE_MAX_CHARS - 4000)
    );
    const artifactEvidence = buildApiReaderArtifactEvidence(
        structuredArtifacts, arxivId, artifactBudget
    );
    const sourceBudget = Math.max(
        0,
        API_READER_EVIDENCE_MAX_CHARS - artifactEvidence.length - 2
    );
    const sourceEvidence = buildTypeAwareSourceContext(
        '',
        sourceText,
        sourceBudget,
        BROAD_EVIDENCE_PATTERNS,
        'READER'
    );
    const combined = [sourceEvidence, artifactEvidence].filter(Boolean).join('\n\n');
    if (combined.length > API_READER_EVIDENCE_MAX_CHARS) {
        throw new Error(
            `读者文章证据超出硬上限: ${combined.length}/${API_READER_EVIDENCE_MAX_CHARS}`
        );
    }
    return combined;
}

function normalizeReaderFigureCaption(figure) {
    const rawCaption = String(figure?.caption || '').normalize('NFKC');
    let figureFilename = '';
    try {
        figureFilename = decodeURIComponent(new URL(String(figure?.url || '')).pathname)
            .split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    } catch (_) {
        figureFilename = '';
    }
    const panelCaption = figureFilename.includes('snri')
        ? rawCaption.match(/(?:^|\s)b\)\s*(.*?)(?=\s+In both\b|$)/i)?.[1]
        : null;
    let caption = String(panelCaption || rawCaption)
        .replace(/[\u200b-\u200d\u2061\ufeff]/g, '')
        .replace(/^Fig(?:ure)?\.?\s*\d+[a-z]?\s*[:.]?\s*/i, '')
        .replace(/R2R\^?(?:\{2\}|2)/g, 'R²')
        .replace(/([Δδ])\\(?:Delta|delta)/g, '$1')
        .replace(/([εϵ])\\(?:varepsilon|epsilon)/g, '$1')
        .replace(/±\\pm/g, '±')
        .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
        .replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, '$1')
        .replace(/\\(?:hat|bar|mathring)\{([^{}]+)\}/g, '$1')
        .replace(/\\(?:Delta|delta)/g, 'Δ')
        .replace(/\\pm/g, '±')
        .replace(/\\dagger/g, '†')
        .replace(/[{}]/g, '')
        .replace(/\s+/g, ' ').trim();
    caption = caption
        .replace(/(P\s*=\s*\d+)\s*P\s*=\s*(\d+\/\d+)/gi, 'P=$2')
        .replace(
            /\b([A-Za-z])([A-Za-z0-9,<]+?)\1_([A-Za-z0-9,<]+)/g,
            (full, symbol, visibleSubscript, texSubscript) => (
                visibleSubscript === texSubscript
                    ? `${symbol}_${texSubscript}`
                    : full
            )
        )
        .replace(/\b(style instruction)\s+SS\b/gi, '$1 S')
        .replace(/([A-Za-z]\s*=\s*-?\d+(?:\.\d+)?)\s*\1/gi, '$1')
        .replace(/(p\s*[<>=]\s*\d+(?:\.\d+)?)\s*\1/gi, '$1')
        .replace(/(\d+(?:\.\d+)?\s*(?:ms|s|dB|Hz|kHz|MHz))\s*\1/gi, '$1');
    if (!caption || /^\(?[a-z]\)?$/i.test(caption)) {
        try {
            const filename = decodeURIComponent(new URL(String(figure?.url || '')).pathname)
                .split('/').pop().replace(/\.[^.]+$/, '')
                .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (filename) caption = filename;
        } catch (_) {
            caption = '';
        }
    }
    return caption || '原论文图示';
}

function truncateReaderFigureCaption(value, limit = 108) {
    const text = String(value || '').trim();
    if (text.length <= limit) return text;
    const sentence = text.slice(0, limit + 1).match(/^(.{36,}?[.!?。！？])(?:\s|$)/);
    if (sentence) return sentence[1].trim();
    const prefix = text.slice(0, limit - 1);
    const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，'), prefix.lastIndexOf(','));
    return `${(boundary >= 48 ? prefix.slice(0, boundary) : prefix).trim()}…`;
}

function readerFigureNarrative(figure, target = null) {
    const label = String(figure?.label || `Figure ${figure?.ordinal || ''}`)
        .replace(/\s+/g, ' ').trim();
    const panelNotice = /^\([a-z]\)$/i.test(String(figure?.caption || '').trim())
        ? `当前资源对应子图 ${String(figure.caption).trim()}；同一编号的其他面板请回原论文核对。`
        : '';
    return `原论文 ${label}：“${truncateReaderFigureCaption(normalizeReaderFigureCaption(figure), 180)}”。`
        + panelNotice;
}

function readerFigureAlt(figure, target = null) {
    const label = String(figure?.label || `Figure ${figure?.ordinal || ''}`)
        .replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
    const caption = truncateReaderFigureCaption(normalizeReaderFigureCaption(figure));
    return truncateReaderFigureCaption(`原论文 ${label}：${caption}`, 112);
}

function insertMarkdownBeforeNextReaderHeading(article, heading, markdown) {
    const marker = `### ${heading}`;
    const start = article.indexOf(marker);
    if (start < 0) return { article, inserted: false };
    const contentStart = start + marker.length;
    const next = article.indexOf('\n### ', contentStart);
    const end = next >= 0 ? next : article.length;
    const before = article.slice(0, end).trimEnd();
    const after = article.slice(end);
    return { article: `${before}\n\n${markdown.trim()}\n${after}`, inserted: true };
}

function replaceReaderFigureMarker(article, heading, marker, markdown) {
    const headingMarker = `### ${heading}`;
    const sectionStart = article.indexOf(headingMarker);
    if (sectionStart < 0) return { article, inserted: false };
    const bodyStart = sectionStart + headingMarker.length;
    const next = article.indexOf('\n### ', bodyStart);
    const sectionEnd = next >= 0 ? next : article.length;
    const markerIndex = article.indexOf(marker, bodyStart);
    if (markerIndex < bodyStart || markerIndex >= sectionEnd
        || article.indexOf(marker, markerIndex + marker.length) >= 0) {
        return { article, inserted: false };
    }
    return {
        article: `${article.slice(0, markerIndex)}${markdown.trim()}${article.slice(markerIndex + marker.length)}`,
        inserted: true
    };
}

function readerSectionContainsMarker(article, heading, marker) {
    const headingMarker = `### ${heading}`;
    const sectionStart = article.indexOf(headingMarker);
    if (sectionStart < 0) return false;
    const bodyStart = sectionStart + headingMarker.length;
    const next = article.indexOf('\n### ', bodyStart);
    const sectionEnd = next >= 0 ? next : article.length;
    const markerIndex = article.indexOf(marker, bodyStart);
    return markerIndex >= bodyStart && markerIndex < sectionEnd;
}

function orderApiReaderFiguresByArticle(article, figures) {
    if (!Array.isArray(figures)) return null;
    const articleUrls = [...String(article || '')
        .matchAll(/!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^\s)]+)\)/g)]
        .map(match => match[1]);
    if (articleUrls.length !== figures.length
        || new Set(articleUrls).size !== articleUrls.length) return null;
    const byUrl = new Map();
    for (const figure of figures) {
        const url = typeof figure?.url === 'string' ? figure.url : '';
        if (!url || byUrl.has(url)) return null;
        byUrl.set(url, figure);
    }
    const ordered = articleUrls.map(url => byUrl.get(url));
    return ordered.every(Boolean) ? ordered : null;
}

function injectApiReaderFigures(readerResult, structuredArtifacts, arxivId = '') {
    const figures = getApiReaderFigureInventory(structuredArtifacts, arxivId);
    if (figures.length === 0) return { ...readerResult, figures: [] };
    let article = readerResult.article;
    const sections = readerResult.plan.sections || [];
    const placements = Array.isArray(readerResult.plan.figurePlacements)
        ? readerResult.plan.figurePlacements
        : [];
    const used = [];
    const plannedFigures = placements.length > 0
        ? placements.map(placement => ({
            figure: figures.find(item => item.ordinal === placement.figureOrdinal),
            placement
        })).filter(item => item.figure)
        : figures.map(figure => ({ figure, placement: null }));
    for (const { figure, placement } of plannedFigures) {
        if (article.includes(`](${figure.url})`)) continue;
        const preferredKinds = placement
            ? [placement.targetKind]
            : figure.ordinal === 1
                ? ['component', 'method_overview']
                : figure.ordinal >= 3
                    ? ['ablation', 'result', 'limitation']
                    : ['result', 'experiment_setup'];
        const target = preferredKinds.flatMap(
            kind => sections.filter(section => section.kind === kind)
        ).find(section => (
            !placement
            || readerSectionContainsMarker(article, section.heading, placement.marker)
        ));
        if (!target) continue;
        const alt = sanitizeMarkdownImageAlt(readerFigureAlt(figure, target));
        const focusBlock = placement?.focusPoints?.length
            ? `> **看图路径：** ${placement.focusPoints.map(
                (item, index) => `${index + 1}. ${item}`
            ).join('；')}`
            : null;
        const block = [
            focusBlock,
            `![${alt}](${figure.url})`,
            `*论文图 ${figure.ordinal}。${readerFigureNarrative(figure, target)}*`
        ].filter(Boolean).join('\n\n');
        const inserted = placement
            ? replaceReaderFigureMarker(
                article,
                target.heading,
                placement.marker,
                block
            )
            : insertMarkdownBeforeNextReaderHeading(article, target.heading, block);
        if (!inserted.inserted) continue;
        article = inserted.article;
        used.push({
            ...figure,
            targetKind: target.kind,
            targetHeading: target.heading,
            marker: placement?.marker || null,
            leadQuote: placement?.leadQuote || null,
            explanationQuote: placement?.explanationQuote || null,
            ...(Array.isArray(placement?.focusPoints)
                ? { focusPoints: placement.focusPoints }
                : {})
        });
    }
    if (placements.length > 0 && used.length !== placements.length) {
        throw new Error(`论文图计划只成功插入 ${used.length}/${placements.length} 张`);
    }
    const orderedFigures = orderApiReaderFiguresByArticle(article, used);
    if (!orderedFigures) {
        throw new Error('论文图正文顺序无法与结构化 figure 绑定闭环');
    }
    return { ...readerResult, article, figures: orderedFigures };
}

function rewriteApiReaderFigureNarratives(article, figures) {
    let rewritten = String(article || '');
    for (const figure of figures || []) {
        const url = String(figure?.url || '');
        if (!url) throw new Error('论文图叙事刷新缺少 URL');
        const target = {
            kind: figure.targetKind,
            heading: figure.targetHeading
        };
        const alt = sanitizeMarkdownImageAlt(readerFigureAlt(figure, target));
        const narrative = `*论文图 ${figure.ordinal}。${readerFigureNarrative(figure, target)}*`;
        if (/^\([a-z]\)$/i.test(String(figure.caption || '').trim())) {
            rewritten = rewritten.replace(
                new RegExp(`图\\s*${figure.ordinal}\\s*的左右对比`, 'g'),
                `原论文图 ${figure.ordinal} 的跨面板对比`
            );
        }
        const pattern = new RegExp(
            `!\\[[^\\n]*\\]\\(${escapeRegExp(url)}\\)\\n\\n`
            + `\\*论文图\\s+${figure.ordinal}。[^\\n]*\\*`
        );
        if (!pattern.test(rewritten)) {
            throw new Error(`论文图 ${figure.ordinal} 的旧叙事块无法精确定位`);
        }
        rewritten = rewritten.replace(
            pattern,
            `![${alt}](${url})\n\n${narrative}`
        );
    }
    return rewritten;
}

function sanitizeTrustedArxivSvg(buffer) {
    const source = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    if (!/^\s*<svg\b/i.test(source)
        || Buffer.byteLength(source) > API_READER_FIGURE_MAX_BYTES) {
        throw new Error('论文 SVG 文件头或字节上限非法');
    }
    const $ = cheerio.load(source, { xmlMode: true });
    const svg = $('svg').first();
    if (!svg.length) throw new Error('论文 SVG 缺少根节点');
    svg.find('script, foreignObject, iframe, object, embed, audio, video').remove();
    svg.find('*').addBack().each((_, element) => {
        for (const attribute of Object.keys(element.attribs || {})) {
            const lower = attribute.toLowerCase();
            const value = String(element.attribs[attribute] || '').trim();
            if (lower.startsWith('on')
                || ((lower === 'href' || lower === 'xlink:href')
                    && value && !value.startsWith('#'))) {
                $(element).removeAttr(attribute);
            }
        }
    });
    const sanitized = $.xml(svg);
    if (!sanitized || /<script\b|<foreignObject\b|\son\w+=/i.test(sanitized)) {
        throw new Error('论文 SVG 清理后仍包含主动内容');
    }
    return Buffer.from(sanitized, 'utf8');
}

function prepareTrustedArxivFigureBuffer(buffer, declaredMediaType = '') {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const declared = String(declaredMediaType || '').toLowerCase().split(';', 1)[0].trim();
    if (declared === 'image/svg+xml' || /^\s*<svg\b/i.test(raw.toString('utf8', 0, 256))) {
        return { buffer: sanitizeTrustedArxivSvg(raw), mediaType: 'image/svg+xml' };
    }
    const sniffed = sniffImageMime(raw);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(sniffed)) {
        throw new Error('论文图片文件头不是支持的 SVG/PNG/JPEG/WebP');
    }
    if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
        throw new Error(`论文图片声明类型与文件头不一致: ${declared} != ${sniffed}`);
    }
    return { buffer: raw, mediaType: sniffed };
}

function isPermanentApiReaderFigureFailure(error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') return true;
    const message = String(error?.message || '');
    const statusMatch = message.match(/论文图\s+\d+\s+下载失败:\s+HTTP\s+(\d{3})/);
    if (statusMatch) {
        const status = Number.parseInt(statusMatch[1], 10);
        return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    }
    return /(?:论文 SVG 文件头或字节上限非法|论文 SVG 缺少根节点|论文 SVG 清理后仍包含主动内容|论文图片文件头不是支持的|论文图片声明类型与文件头不一致|论文图\s+\d+\s+无法解码|论文图尺寸非法)/.test(message);
}

function pruneUnmaterializedApiReaderFigureBlocks(article, plannedFigures, materializedFigures) {
    const kept = new Set((materializedFigures || []).map(figure => (
        `${figure.ordinal}\u0000${figure.url}`
    )));
    let output = String(article || '');
    for (const figure of plannedFigures || []) {
        if (kept.has(`${figure.ordinal}\u0000${figure.url}`)) continue;
        const focusPrefix = Array.isArray(figure.focusPoints) && figure.focusPoints.length > 0
            ? `> \\*\\*看图路径：\\*\\*[^\\n]*\\n\\n`
            : '';
        const pattern = new RegExp(
            `^${focusPrefix}!\\[[^\\n]*\\]\\(${escapeRegExp(String(figure.url || ''))}\\)\\n\\n`
            + `\\*论文图\\s+${Number(figure.ordinal)}。[^\\n]*\\*\\n*`,
            'gm'
        );
        const before = output;
        output = output.replace(pattern, '');
        if (output === before) {
            throw new Error(`无法精确移除未物化论文图 ${figure.ordinal} 的正文块`);
        }
    }
    return output.replace(/\n{3,}/g, '\n\n').trim();
}

async function materializeApiReaderFigures(figures, arxivId = '') {
    if (!Array.isArray(figures) || figures.length === 0) return [];
    if (require('./lib/conference-analysis-context.js').getConferenceAnalysisContext()) {
        throw new Error('会议 weak PDF 不允许物化非空 Figure 列表');
    }
    const paperId = String(arxivId || '').trim().toLowerCase().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(paperId)) throw new Error('论文图缓存 paper ID 非法');
    const root = path.join(CURRENT_DIR, 'api-reader-assets', paperId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const materialized = [];
    for (const figure of figures || []) {
        try {
            const response = await fetch(figure.url, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                dispatcher: getArxivFetchDispatcher()
            });
            if (!response.ok) throw new Error(`论文图 ${figure.ordinal} 下载失败: HTTP ${response.status}`);
            const raw = await readResponseBufferWithLimit(response, API_READER_FIGURE_MAX_BYTES);
            const trusted = prepareTrustedArxivFigureBuffer(raw, figure.mediaType);
            const image = await loadImage(trusted.buffer);
            if (!image.width || !image.height) throw new Error(`论文图 ${figure.ordinal} 无法解码`);
            const dimensions = fitApiReaderFigureDimensions(image.width, image.height);
            const canvas = createCanvas(dimensions.canvasWidth, dimensions.canvasHeight);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, dimensions.canvasWidth, dimensions.canvasHeight);
            context.drawImage(
                image,
                dimensions.offsetX,
                dimensions.offsetY,
                dimensions.drawWidth,
                dimensions.drawHeight
            );
            const png = await canvas.encode('png');
            const assetSha256 = crypto.createHash('sha256').update(png).digest('hex');
            const filename = `figure-${figure.ordinal}-${assetSha256.slice(0, 16)}.png`;
            const cachePath = path.join(root, filename);
            writeFileAtomic(cachePath, png);
            materialized.push({
                ...figure,
                cachePath,
                assetFilename: filename,
                assetMediaType: 'image/png',
                assetSha256,
                assetBytes: png.length,
                assetWidth: dimensions.canvasWidth,
                assetHeight: dimensions.canvasHeight
            });
        } catch (error) {
            if (!isPermanentApiReaderFigureFailure(error)) throw error;
            console.log(`    [deep] ⚠️  跳过无法物化的论文图 ${figure.ordinal}: ${error.message}`);
        }
    }
    return materialized;
}

function fitApiReaderFigureDimensions(sourceWidth, sourceHeight) {
    const width = Number(sourceWidth);
    const height = Number(sourceHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('论文图尺寸非法');
    }
    let drawWidth = Math.max(1200, Math.min(1800, Math.round(width * 3)));
    let drawHeight = Math.max(1, Math.round(drawWidth * height / width));
    if (drawHeight > 4096) {
        const scale = 4096 / drawHeight;
        drawWidth = Math.max(1, Math.round(drawWidth * scale));
        drawHeight = 4096;
    }
    const canvasWidth = Math.max(600, Math.min(4096, drawWidth));
    const canvasHeight = Math.max(200, Math.min(4096, drawHeight));
    return {
        canvasWidth,
        canvasHeight,
        drawWidth: Math.min(drawWidth, canvasWidth),
        drawHeight: Math.min(drawHeight, canvasHeight),
        offsetX: Math.max(0, Math.floor((canvasWidth - drawWidth) / 2)),
        offsetY: Math.max(0, Math.floor((canvasHeight - drawHeight) / 2))
    };
}

function normalizeApiReaderTableBlockSpacing(article) {
    const lines = String(article || '').split('\n');
    const output = [];
    for (let index = 0; index < lines.length;) {
        const isTableStart = /^\s*\|.*\|\s*$/.test(lines[index] || '')
            && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] || '');
        if (!isTableStart) {
            output.push(lines[index]);
            index += 1;
            continue;
        }
        if (output.length > 0 && output[output.length - 1].trim()) output.push('');
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            output.push(lines[index]);
            index += 1;
        }
        if (index < lines.length && lines[index].trim()) output.push('');
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function validateApiReaderTableNarratives(article, minimumTables = 2) {
    const blocks = String(article || '').split(/\n\s*\n/).map(value => value.trim());
    const tableIndexes = blocks.map((block, index) => (
        /^\|.+\|$/m.test(block) ? index : -1
    )).filter(index => index >= 0);
    if (tableIndexes.length < minimumTables) {
        throw new Error(
            `读者文章至少需要 ${minimumTables} 张有叙事闭环的 Markdown 表，当前 ${tableIndexes.length}`
        );
    }
    for (const [tableOffset, index] of tableIndexes.entries()) {
        const beforeParts = [];
        for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor--) {
            if (!blocks[cursor] || /^(?:###|\|)/.test(blocks[cursor])) break;
            beforeParts.unshift(blocks[cursor]);
        }
        const before = beforeParts.join('\n\n');
        const afterParts = [];
        for (let cursor = index + 1; cursor < Math.min(blocks.length, index + 4); cursor++) {
            if (!blocks[cursor] || /^(?:###|\|)/.test(blocks[cursor])) break;
            afterParts.push(blocks[cursor]);
        }
        const after = afterParts.join('\n\n');
        const beforeChinese = (before.match(/[\u3400-\u9fff]/g) || []).length;
        const afterChinese = (after.match(/[\u3400-\u9fff]/g) || []).length;
        const tableLabel = String(blocks[index] || '').split('\n', 1)[0].slice(0, 120);
        if (beforeChinese < READER_LIMITS.tableLeadChineseChars) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）前缺少独立说明段`
                + `（当前 ${beforeChinese} 个汉字，至少 ${READER_LIMITS.tableLeadChineseChars} 个）`
            );
        }
        if (afterChinese < READER_LIMITS.tableExplanationChineseChars) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）后缺少独立解释段`
                + `（当前 ${afterChinese} 个汉字，至少 ${READER_LIMITS.tableExplanationChineseChars} 个）`
            );
        }
    }
}

function findApiReaderTablePasteDuplication(cell) {
    return findReaderTablePasteDuplication(cell);
}

function normalizeApiReaderTablePasteArtifacts(article) {
    const rebuild = rows => [
        `| ${rows[0].join(' | ')} |`,
        `| ${rows[0].map(() => '---').join(' | ')} |`,
        ...rows.slice(1).map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
    const canonicalLabel = value => String(value || '').normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    let output = String(article || '');
    for (const table of extractMarkdownTables(output)) {
        const rows = [table.header, ...table.rows].map(row => row.map(cell => {
            if (!findApiReaderTablePasteDuplication(cell)) return cell;
            let cleaned = String(cell)
                .replace(/±\s*\\pm\s*/g, ' ± ')
                .replace(/×\s*\\times\s*/g, ' × ')
                .replace(/%\s*\\%/g, '%')
                .replace(/\{=\}/g, '=')
                .replace(/\\bf\b\s*/g, '');
            cleaned = cleaned.replace(
                /\\(?:mathrm|text)\{([^}]*)\}(?:\^\{[^}]*\})?/g,
                (whole, inner, offset, input) => (
                    canonicalLabel(input.slice(0, offset)).includes(canonicalLabel(inner))
                        ? '' : inner
                )
            );
            cleaned = cleaned
                .replace(/\s+/g, ' ')
                .trim();
            const exactDoubled = cleaned.match(/^(.{3,})\1$/u);
            if (exactDoubled && /[\d\\=]/.test(exactDoubled[1])) cleaned = exactDoubled[1];
            cleaned = cleaned
                .replace(/^([∼~≈]\s*\d+(?:\.\d+)?)\1$/, '$1')
                .replace(/^((?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?))\1$/, '$1');
            if (!cleaned) {
                throw new Error('Reader source-binding v4 表格清理后出现空单元格；请从原始 cell 重建内容');
            }
            return cleaned;
        }));
        const rebuilt = rebuild(rows);
        if (rebuilt !== table.markdown) output = output.replace(table.markdown, rebuilt);
    }
    return output;
}

function validateApiReaderTablePasteDuplication(article) {
    const tables = extractMarkdownTables(article);
    for (const [tableIndex, table] of tables.entries()) {
        const rows = [table.header, ...table.rows];
        for (const [rowIndex, row] of rows.entries()) {
            for (const [columnIndex, cell] of row.entries()) {
                const reason = findReaderTablePasteDuplication(cell, {
                    header: table.header, row, rowIndex, columnIndex
                });
                if (reason) {
                    throw new Error(
                        `读者文章第 ${tableIndex + 1} 张表粘连复写`
                        + `（${rowIndex === 0 ? '表头' : `数据行 ${rowIndex}`}第 ${columnIndex + 1} 格`
                        + `“${String(cell).slice(0, 60)}”）：${reason}`
                    );
                }
            }
        }
    }
}

function rebindApiReaderFigurePlacementQuotes(article, placements) {
    const blocks = String(article || '').split(/\n\s*\n/).map(block => block.trim());
    return (placements || []).map((placement, index) => {
        const markerIndex = blocks.indexOf(placement.marker);
        if (markerIndex <= 0 || markerIndex >= blocks.length - 1) {
            throw new Error(`读者文章 figurePlacements[${index}] 无法从最终正文重绑定导读与解释`);
        }
        return {
            ...placement,
            leadQuote: blocks[markerIndex - 1],
            explanationQuote: blocks[markerIndex + 1]
        };
    });
}

function validateReaderEditorialQuality(article, sections) {
    const quality = validateEditorialQuality({
        summary: '', method: article, innovations: '', results: '', details: '', limits: ''
    });
    const sectionWarnings = findReaderSectionNearDuplicates(article, sections);
    return { ...quality, warnings: [...quality.warnings, ...sectionWarnings] };
}

function normalizeReaderStructuralLineBreaks(body, declaredMarker) {
    const original = String(body || '');
    if (!/^\[\[(?:CONCEPT_BRIDGE|FIGURE|FORMULA)_\d+\]\]$/.test(declaredMarker || '')
        || original.split(declaredMarker).length - 1 !== 1) return original;
    const escaped = declaredMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = original.split(/(\r?\n)/); let fence = null; let changed = false;
    for (let index = 0; index < parts.length; index += 2) {
        const line = parts[index]; const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
            continue;
        }
        if (fence || line.includes('`')) continue;
        const normalized = line.replace(new RegExp(`\\\\n[ \\t]*(${escaped})[ \\t]*\\\\n`, 'g'), '\n$1\n');
        if (normalized !== line) { parts[index] = normalized; changed = true; }
    }
    return changed ? parts.join('') : original;
}

function normalizeDeclaredReaderMarkerParagraphs(value) {
    if (!Array.isArray(value?.sections)) return;
    const declarations = [
        ...(Array.isArray(value.conceptBridges) ? value.conceptBridges.map((binding, index) => ({
            marker: binding?.marker,
            expectedMarker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            kind: binding?.sectionKind
        })) : []),
        ...(Array.isArray(value.figurePlacements) ? value.figurePlacements.map(binding => ({
            marker: binding?.marker,
            expectedMarker: Number.isInteger(binding?.figureOrdinal) ? `[[FIGURE_${binding.figureOrdinal}]]` : null,
            kind: binding?.targetKind
        })) : []),
        ...(Array.isArray(value.formulaBindings) ? value.formulaBindings.map(binding => ({
            marker: binding?.marker,
            expectedMarker: Number.isInteger(binding?.formulaOrdinal) ? `[[FORMULA_${binding.formulaOrdinal}]]` : null,
            kind: binding?.targetKind
        })) : [])
    ];
    for (const declaration of declarations) {
        const marker = typeof declaration.marker === 'string' ? declaration.marker.trim() : '';
        if (!marker || marker !== declaration.expectedMarker || !API_READER_KINDS.includes(declaration.kind)) continue;
        const declaredSection = value.sections.find(section => section?.kind === declaration.kind);
        if (declaredSection && typeof declaredSection.body === 'string') {
            declaredSection.body = normalizeReaderStructuralLineBreaks(declaredSection.body, marker);
        }
        const occurrences = value.sections.reduce((count, section) =>
            count + String(section?.body || '').split(marker).length - 1, 0);
        if (occurrences !== 1) continue;
        const target = value.sections.find(section => section?.kind === declaration.kind
            && String(section.body || '').split(/\r?\n/).some(line => line.trim() === marker));
        if (!target || String(target.body).split(/\n\s*\n/).some(block => block.trim() === marker)) continue;
        const lines = String(target.body).replace(/\r\n?/g, '\n').split('\n');
        const markerLine = lines.findIndex(line => line.trim() === marker);
        const before = lines.slice(0, markerLine).join('\n').trimEnd();
        const after = lines.slice(markerLine + 1).join('\n').trimStart();
        target.body = [before, marker, after].filter(Boolean).join('\n\n');
    }
}

function parseApiReaderArticleResult(raw, options = {}) {
    let value;
    try {
        value = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`读者文章 JSON 无法解析: ${error.message}`);
    }
    const hasSourceBindings = Object.prototype.hasOwnProperty.call(value, 'tableBindings')
        || Object.prototype.hasOwnProperty.call(value, 'formulaBindings');
    assertExactObjectKeys(
        value,
        [
            'version', 'readerTitle', 'oneSentenceThesis',
            'conceptBridges', 'figurePlacements', 'sections',
            ...(hasSourceBindings || options.requireSourceBindings === true
                ? ['tableBindings', 'formulaBindings'] : [])
        ],
        '读者文章顶层'
    );
    if (![2, 3].includes(value.version)) throw new Error('读者文章 version 必须为 2 或 3');
    if (Number.isInteger(options.requiredVersion) && value.version !== options.requiredVersion) {
        throw new Error(`读者文章 version 必须为 ${options.requiredVersion}，禁止降级生成`);
    }
    if (typeof value.readerTitle !== 'string' || value.readerTitle.trim().length < 8
        || value.readerTitle.trim().length > 80) {
        throw new Error('读者标题必须是 8-80 字符的论文特有标题');
    }
    if (typeof value.oneSentenceThesis !== 'string'
        || value.oneSentenceThesis.trim().length < 30
        || value.oneSentenceThesis.trim().length > 260) {
        throw new Error('读者文章 oneSentenceThesis 必须为 30-260 字符');
    }
    const requirements = readerRequirements({ version: value.version,
        minimumIntegratedTables: options.minimumIntegratedTables });
    const minimumSectionCount = requirements.minimumSections;
    const maximumSectionCount = requirements.maximumSections;
    if (!Array.isArray(value.sections)
        || value.sections.length < minimumSectionCount
        || value.sections.length > maximumSectionCount) {
        throw new Error(
            `读者文章 sections 必须包含 ${minimumSectionCount}-${maximumSectionCount} 个小节`
        );
    }
    const orderedDraft = normalizeReaderDraftOrder(value);
    value.sections = orderedDraft.draft.sections;
    value.tableBindings = orderedDraft.draft.tableBindings;
    value.conceptBridges = orderedDraft.draft.conceptBridges;
    normalizeDeclaredReaderMarkerParagraphs(value);
    const compiledTables = compileReaderTableSelections(
        value.sections, value.tableBindings, options.structuredArtifacts
    );
    value.sections = compiledTables.sections;
    value.tableBindings = compiledTables.tableBindings;
    const seenHeadings = new Set();
    let previousRank = -1;
    for (const [index, section] of value.sections.entries()) {
        assertExactObjectKeys(section, ['kind', 'heading', 'body'], `读者文章 sections[${index}]`);
        const rank = API_READER_KINDS.indexOf(section.kind);
        if (rank < 0) throw new Error(`读者文章 sections[${index}].kind 非法`);
        if (rank < previousRank) throw new Error('读者文章小节未按学习依赖顺序递进');
        previousRank = rank;
        let heading = makeReaderHeadingSpecific(
            section.kind, String(section.heading || '').trim(), value.readerTitle
        );
        section.heading = heading;
        if (heading.length < 8 || heading.length > 80
            || GENERIC_READER_HEADING_RE.test(heading)) {
            throw new Error(`读者文章 sections[${index}].heading 必须是论文特有问题或判断`);
        }
        if (seenHeadings.has(heading)) {
            const suffix = `（补充判断 ${index + 1}）`;
            heading = `${heading.slice(0, Math.max(8, 80 - suffix.length))}${suffix}`;
            section.heading = heading;
        }
        if (seenHeadings.has(heading)) throw new Error('读者文章小节标题重复');
        seenHeadings.add(heading);
        if (typeof section.body !== 'string' || section.body.trim().length < 120) {
            throw new Error(`读者文章 sections[${index}].body 至少 120 字符`);
        }
    }
    const normalizedSections = value.sections.map(section => ({
        ...section,
        heading: normalizeReaderEditorialSurface(section.heading.trim()),
        body: splitReaderLongParagraphs(section.body)
    }));
    const kinds = new Set(normalizedSections.map(section => section.kind));
    const missing = API_READER_REQUIRED_KINDS.filter(kind => !kinds.has(kind));
    if (missing.length > 0) throw new Error(`读者文章缺少教学阶段: ${missing.join(', ')}`);
    if (options.requireIntegratedTables === true && value.version === 3) {
        validateReaderResultTableCoverage(normalizedSections, options.structuredArtifacts);
    }
    const minimumConceptBridges = requirements.minimumConceptBridges;
    const maximumConceptBridges = requirements.maximumConceptBridges;
    if (!Array.isArray(value.conceptBridges)
        || value.conceptBridges.length < minimumConceptBridges
        || value.conceptBridges.length > maximumConceptBridges) {
        throw new Error(
            `读者文章 conceptBridges 必须包含 ${minimumConceptBridges}-${maximumConceptBridges} 个术语组合解释`
        );
    }
    const conceptBridges = value.conceptBridges.map((bridge, index) => {
        assertExactObjectKeys(
            bridge, ['terms', 'sectionKind', 'marker', 'explanation'],
            `读者文章 conceptBridges[${index}]`
        );
        if (!Array.isArray(bridge.terms) || bridge.terms.length !== 2
            || bridge.terms.some(term => typeof term !== 'string'
                || term.trim().length < 2 || term.trim().length > 48)) {
            throw new Error(`读者文章 conceptBridges[${index}].terms 必须包含 2 个真实术语`);
        }
        if (!API_READER_KINDS.includes(bridge.sectionKind)) {
            throw new Error(`读者文章 conceptBridges[${index}].sectionKind 非法`);
        }
        const marker = String(bridge.marker || '').trim();
        const explanation = String(bridge.explanation || '').trim();
        const markerOccurrences = marker ? value.sections.reduce((count, section) =>
            count + String(section.body || '').split(marker).length - 1, 0) : 0;
        let candidate = value.sections.find(section => section.kind === bridge.sectionKind
            && String(section.body || '').split(/\n\s*\n/).map(block => block.trim()).includes(marker));
        if (!candidate && markerOccurrences === 0 && marker === `[[CONCEPT_BRIDGE_${index + 1}]]`
            && explanation.length >= 45 && explanation.length <= 320) {
            const targetIndex = value.sections.findIndex(section => section.kind === bridge.sectionKind);
            if (targetIndex >= 0) {
                value.sections[targetIndex].body = `${value.sections[targetIndex].body.trim()}\n\n${marker}`;
                normalizedSections[targetIndex].body = `${normalizedSections[targetIndex].body.trim()}\n\n${marker}`;
                candidate = value.sections[targetIndex];
            }
        }
        if (marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || explanation.length < 45 || explanation.length > 320 || !candidate || markerOccurrences > 1) {
            throw new Error(
                `读者文章 conceptBridges[${index}] 未形成有效术语桥`
                + `（terms=${bridge.terms.join(' × ')}`
                + `, sectionKind=${bridge.sectionKind}`
                + `, marker=${marker || '空'}`
                + `, explanationChars=${explanation.length}`
                + `, markerBound=${Boolean(candidate)}, markerOccurrences=${markerOccurrences}；已有marker必须唯一独占一段且位于声明小节）`
            );
        }
        return {
            terms: bridge.terms.map(term => normalizeReaderEditorialSurface(term.trim())),
            sectionKind: bridge.sectionKind,
            marker,
            explanation: collapseRepeatedReaderBridgeHeadings(normalizeReaderEditorialSurface(
                `**${bridge.terms[0].trim()} × ${bridge.terms[1].trim()}：** ${explanation}`
            ))
        };
    });
    if (!Array.isArray(value.figurePlacements)
        || value.figurePlacements.length > API_READER_FIGURE_SELECTION_LIMIT) {
        throw new Error(
            `读者文章 figurePlacements 必须是至多 ${API_READER_FIGURE_SELECTION_LIMIT} 项的数组`
        );
    }
    const availableFigureOrdinals = new Set(
        (options.availableFigureOrdinals || []).map(Number).filter(Number.isInteger)
    );
    if (availableFigureOrdinals.size === 0 && value.figurePlacements.length !== 0) {
        throw new Error('论文没有可用 Figure，figurePlacements 必须为空');
    }
    const seenFigureOrdinals = new Set();
    const figurePlacements = value.figurePlacements.map((placement, index) => {
        const placementKeys = value.version === 3
            ? ['figureOrdinal', 'targetKind', 'marker', 'focusPoints']
            : ['figureOrdinal', 'targetKind', 'marker'];
        assertExactObjectKeys(
            placement, placementKeys, `读者文章 figurePlacements[${index}]`
        );
        if (!Number.isInteger(placement.figureOrdinal)
            || !availableFigureOrdinals.has(placement.figureOrdinal)
            || seenFigureOrdinals.has(placement.figureOrdinal)) {
            throw new Error(`读者文章 figurePlacements[${index}].figureOrdinal 非法或重复`);
        }
        seenFigureOrdinals.add(placement.figureOrdinal);
        if (!API_READER_KINDS.includes(placement.targetKind)) {
            throw new Error(`读者文章 figurePlacements[${index}].targetKind 非法`);
        }
        const marker = String(placement.marker || '').trim();
        if (marker !== `[[FIGURE_${placement.figureOrdinal}]]`) {
            throw new Error(`读者文章 figurePlacements[${index}].marker 与 Figure 编号不一致`);
        }
        const candidate = value.sections.find(section => section.kind === placement.targetKind
            && String(section.body || '').split(/\n\s*\n/).map(block => block.trim()).includes(marker));
        const blocks = String(candidate?.body || '').split(/\n\s*\n/).map(block => block.trim());
        const markerIndex = blocks.indexOf(marker);
        const leadQuote = blocks[markerIndex - 1] || '';
        const explanationQuote = blocks[markerIndex + 1] || '';
        const focusPoints = value.version === 3 ? placement.focusPoints : [];
        if (!candidate || markerIndex <= 0 || markerIndex >= blocks.length - 1
            || leadQuote.length < API_READER_FIGURE_LEAD_MIN_CHARS
            || explanationQuote.length < API_READER_FIGURE_EXPLANATION_MIN_CHARS
            || !Array.isArray(focusPoints)
            || (value.version === 3 && (focusPoints.length < READER_LIMITS.minimumFocusPoints
                || focusPoints.length > READER_LIMITS.maximumFocusPoints))
            || focusPoints.some(item => typeof item !== 'string'
                || item.trim().length < 12 || item.trim().length > 120)) {
            throw new Error(
                `读者文章 figurePlacements[${index}]（Figure ${placement.figureOrdinal}）`
                + '图前导读与图后解释未形成相邻闭环'
                + `（targetKind=${placement.targetKind}`
                + `, markerBound=${Boolean(candidate)}`
                + `, markerIndex=${markerIndex}`
                + `, leadChars=${leadQuote.length}/${API_READER_FIGURE_LEAD_MIN_CHARS}`
                + `, explanationChars=${explanationQuote.length}/${API_READER_FIGURE_EXPLANATION_MIN_CHARS}`
                + `, focusCount=${Array.isArray(focusPoints) ? focusPoints.length : 'invalid'}）`
            );
        }
        return {
            figureOrdinal: placement.figureOrdinal,
            targetKind: placement.targetKind,
            marker,
            leadQuote: normalizeReaderEditorialSurface(leadQuote),
            explanationQuote: normalizeReaderEditorialSurface(explanationQuote),
            ...(value.version === 3
                ? {
                    focusPoints: focusPoints.map(
                        item => normalizeReaderEditorialSurface(item.trim())
                    )
                }
                : {})
        };
    });
    let article = normalizedSections.map(section => (
        `### ${section.heading.trim()}\n\n${section.body.trim()}`
    )).join('\n\n');
    for (const bridge of conceptBridges) {
        if (!article.includes(bridge.marker)) {
            throw new Error(`读者文章术语桥 marker 丢失: ${bridge.marker}`);
        }
        article = article.replace(bridge.marker, bridge.explanation);
    }
    article = relocateExplicitReaderTableExplanations(ensureApiReaderTableNarratives(
        normalizeApiReaderTableBlockSpacing(normalizeReaderEditorialSurface(article))
    ));
    const chineseChars = (article.match(/[\u3400-\u9fff]/g) || []).length;
    const minimumChineseChars = requirements.minimumChineseChars;
    const maximumChineseChars = requirements.maximumChineseChars;
    if (chineseChars < minimumChineseChars || chineseChars > maximumChineseChars) {
        throw new Error(
            `读者文章中文字数必须为 ${minimumChineseChars}-${maximumChineseChars}，当前 ${chineseChars}`
        );
    }
    if (/(?:evidence\s*id|manual_complete|证据块|代码校验反馈|图后解释(?:需要|必须|紧扣)|不擅自断言|按反馈重写|(?:本|上述|当前|这个)\s*prompt|(?:根据|遵循)\s*(?:本|上述|当前)?\s*prompt|prompt\s*(?:要求|指令|中要求))/i.test(article)) {
        throw new Error('读者文章泄漏了流程或证据元话语');
    }
    let quality = validateReaderEditorialQuality(article, normalizedSections);
    const repairableSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue, article))
    ));
    if (repairableSurfaceIssues.length > 0) {
        article = normalizeReaderEditorialSurface(article, repairableSurfaceIssues);
        quality = validateReaderEditorialQuality(article, normalizedSections);
    }
    article = restoreReaderSectionHeadings(article, normalizedSections);
    article = removeDuplicateReaderLongSentences(article);
    article = normalizeApiReaderTableBlockSpacing(article);
    quality = validateReaderEditorialQuality(article, normalizedSections);
    const finalSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue, article))
    ));
    if (finalSurfaceIssues.length > 0) {
        article = normalizeReaderEditorialSurface(article, finalSurfaceIssues);
        quality = validateReaderEditorialQuality(article, normalizedSections);
    }
    article = ensureApiReaderTableNarratives(article);
    quality = validateReaderEditorialQuality(article, normalizedSections);
    // Issue offsets describe this pre-injection view. Original TeX insertion
    // changes later offsets, so replay context-sensitive exemptions against the
    // exact text that produced the diagnostics, not the rendered formula copy.
    const qualityArticle = article;
    const sourceBindingResult = (hasSourceBindings || options.requireSourceBindings === true)
        ? bindApiReaderSourceEvidence(
            article,
            value.tableBindings,
            value.formulaBindings,
            {
                structuredArtifacts: options.structuredArtifacts,
                sourceText: options.sourceText,
                sections: normalizedSections,
                selectionTableIndexes: compiledTables.selectionTableIndexes,
                allowDeterministicQuoteRepair:
                    options.allowDeterministicQuoteRepair === true
            }
        )
        : null;
    if (sourceBindingResult) article = sourceBindingResult.article;
    const qualityMetrics = buildApiReaderQualityMetrics(quality, qualityArticle);
    const blockingQualityIssues = quality.issues.filter(issue => !(
        isAllowedReaderNarrativeNumeralIssue(issue, qualityArticle)
        || isAllowedReaderDefensiveNegationIssue(issue, qualityArticle)
        || isReaderHeadingIssue(issue, qualityArticle)
    ));
    if (blockingQualityIssues.length > 0) {
        const details = blockingQualityIssues.slice(0, 8)
            .map(item => `${item.code}:${item.match || item.message}`).join('；');
        throw new Error(`读者文章文风校验失败: ${details}`);
    }
    const readerTables = extractMarkdownTables(article);
    const malformedTableIndex = readerTables.findIndex(table => (
        table.separatorColumns !== table.header.length
        || table.invalidColumnCounts.length > 0
    ));
    if (malformedTableIndex >= 0) {
        const malformedTable = readerTables[malformedTableIndex];
        const invalid = malformedTable.invalidColumnCounts[0];
        throw new Error(
            `读者文章第 ${malformedTableIndex + 1} 张 Markdown 表列数不一致`
            + `（表头：${malformedTable.header.join(' / ').slice(0, 160)}）`
            + `: header=${malformedTable.header.length}`
            + (invalid ? `, row=${invalid.row}, columns=${invalid.columns}` : '')
        );
    }
    validateApiReaderTablePasteDuplication(article);
    if (options.requireIntegratedTables === true) {
        const minimumTables = requirements.minimumTables;
        validateApiReaderTableNarratives(article, minimumTables);
        const tables = extractMarkdownTables(article);
        const minimumWideTables = requirements.minimumWideTables;
        if (tables.filter(table => table.header.length >= requirements.minimumWideColumns).length < minimumWideTables) {
            throw new Error(`读者文章至少需要 ${minimumWideTables} 张 ${requirements.minimumWideColumns} 列以上的宽表`);
        }
    }
    const reboundFigurePlacements = rebindApiReaderFigurePlacementQuotes(
        article, figurePlacements
    );
    const reboundConceptBridges = conceptBridges.map(bridge => {
        const paragraph = findReaderBridgeParagraph(
            article.split(/\n\s*\n/).map(block => block.trim()), bridge.terms
        );
        if (!paragraph) {
            throw new Error(
                `读者文章术语桥无法从最终正文重绑定: ${bridge.terms.join(' × ')}`
            );
        }
        return { ...bridge, explanation: paragraph };
    });
    return {
        plan: {
            version: value.version,
            contract: value.version === API_READER_PLAN_VERSION
                ? API_READER_ARTICLE_CONTRACT
                : 'beginner-researcher-v2',
            readerTitle: normalizeReaderEditorialSurface(value.readerTitle.trim()),
            oneSentenceThesis: normalizeReaderEditorialSurface(value.oneSentenceThesis.trim()),
            conceptBridges: reboundConceptBridges,
            figurePlacements: reboundFigurePlacements,
            ...(sourceBindingResult ? {
                tableBindings: sourceBindingResult.tableBindings,
                formulaBindings: sourceBindingResult.formulaBindings,
                sourceBindingsContract: API_READER_SOURCE_BINDING_CONTRACT,
                sourceBindingsSha256: sourceBindingResult.sourceBindingsSha256
            } : {}),
            sections: normalizedSections.map(section => ({
                kind: section.kind,
                heading: section.heading.trim()
            }))
        },
        article,
        qualityMetrics
    };
}

function removeDuplicateReaderLongSentences(article) {
    let output = String(article || '');
    const duplicates = findDuplicateLongSentences(output);
    for (const duplicate of duplicates) {
        const occurrences = Array.isArray(duplicate?.occurrences)
            ? duplicate.occurrences
            : [];
        if (occurrences.length < 2) continue;
        const firstText = String(occurrences[0]?.text || '');
        let searchFrom = firstText ? output.indexOf(firstText) + firstText.length : 0;
        for (const occurrence of occurrences.slice(1)) {
            const repeatedText = String(occurrence?.text || '');
            if (!repeatedText) continue;
            let index = output.indexOf(repeatedText, Math.max(0, searchFrom));
            if (index < 0 && repeatedText !== firstText) index = output.indexOf(repeatedText);
            if (index < 0) continue;
            output = `${output.slice(0, index)}${output.slice(index + repeatedText.length)}`;
            searchFrom = index;
        }
    }
    return output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function apiReaderPreInjectionQualityView(article, plan, figures = []) {
    let view = String(article || '');
    for (const figure of figures) {
        const placement = (plan.figurePlacements || []).find(item => item.figureOrdinal === figure.ordinal);
        if (!placement || typeof placement.marker !== 'string') {
            throw new Error('Reader 文风统计视图缺少 Figure marker 绑定');
        }
        const focusBlock = placement.focusPoints?.length
            ? `> **看图路径：** ${placement.focusPoints.map((item, index) => `${index + 1}. ${item}`).join('；')}`
            : null;
        const block = [focusBlock,
            `![${sanitizeMarkdownImageAlt(readerFigureAlt(figure))}](${figure.url})`,
            `*论文图 ${figure.ordinal}。${readerFigureNarrative(figure)}*`
        ].filter(Boolean).join('\n\n');
        if (view.split(block).length !== 2) {
            throw new Error(`Reader 文风统计视图无法精确重放 Figure ${figure.ordinal} 注入块`);
        }
        view = view.replace(block, placement.marker);
    }
    for (const binding of plan.formulaBindings || []) {
        const block = `\\[${String(binding.latex || '').trim()}\\]`;
        if (typeof binding.marker !== 'string'
            || crypto.createHash('sha256').update(block).digest('hex') !== binding.renderedBlockSha256
            || view.split(block).length !== 2) {
            throw new Error('Reader 文风统计视图无法精确重放公式注入块');
        }
        view = view.replace(block, binding.marker);
    }
    return view;
}

function repairApiReaderPlanSurfaceBinding(paper, analysisManifest) {
    const plan = paper?.apiReaderPlan;
    const originalArticle = paper?.apiReaderArticle;
    const article = typeof originalArticle === 'string'
        ? collapseRepeatedReaderBridgeHeadings(normalizeReaderCurrencyAmounts(originalArticle))
        : originalArticle;
    const stage = analysisManifest?.stages?.apiReaderArticle;
    if (!plan || !Array.isArray(plan.sections) || typeof article !== 'string'
        || stage?.status !== 'complete') return false;
    const articleHeadings = [...article.matchAll(/^###\s+(.+?)\s*$/gm)]
        .map(match => match[1].trim());
    if (articleHeadings.length !== plan.sections.length) return false;
    const repairedHeadings = plan.sections.map(section => (
        normalizeReaderEditorialSurface(String(section?.heading || '').trim())
    ));
    if (!repairedHeadings.every((heading, index) => heading === articleHeadings[index])) {
        return false;
    }
    let repairedTableBindings = plan.tableBindings;
    if (Array.isArray(plan.tableBindings)) {
        const articleTables = extractMarkdownTables(article);
        if (articleTables.length !== plan.tableBindings.length) return false;
        repairedTableBindings = plan.tableBindings.map((binding, index) => ({
            ...binding,
            renderedTableSha256: crypto.createHash('sha256')
                .update(articleTables[index].markdown).digest('hex')
        }));
    }
    const articleBlocks = article.split(/\n\s*\n/).map(block => block.trim());
    let repairedConceptBridges = plan.conceptBridges;
    if (Array.isArray(plan.conceptBridges)) {
        repairedConceptBridges = [];
        for (const bridge of plan.conceptBridges) {
            if (!bridge || !Array.isArray(bridge.terms) || bridge.terms.length !== 2) {
                return false;
            }
            const terms = bridge.terms.map(term => (
                normalizeReaderEditorialSurface(String(term || '').trim())
            ));
            const paragraph = findReaderBridgeParagraph(articleBlocks, terms);
            if (!paragraph) return false;
            repairedConceptBridges.push({
                ...bridge,
                terms,
                explanation: paragraph
            });
        }
    }
    const repairedPlan = {
        ...plan,
        readerTitle: normalizeReaderEditorialSurface(plan.readerTitle),
        oneSentenceThesis: normalizeReaderEditorialSurface(plan.oneSentenceThesis),
        ...(Array.isArray(repairedConceptBridges)
            ? { conceptBridges: repairedConceptBridges }
            : {}),
        ...(Array.isArray(repairedTableBindings) ? {
            tableBindings: repairedTableBindings,
            sourceBindingsSha256: stableFingerprint({
                tableBindings: repairedTableBindings,
                formulaBindings: Array.isArray(plan.formulaBindings)
                    ? plan.formulaBindings : []
            })
        } : {}),
        sections: plan.sections.map((section, index) => ({
            ...section,
            heading: articleHeadings[index]
        })),
        ...(Array.isArray(plan.figurePlacements) ? {
            figurePlacements: plan.figurePlacements.map(placement => ({
                ...placement,
                leadQuote: typeof placement?.leadQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(placement.leadQuote)
                    : placement?.leadQuote,
                explanationQuote: typeof placement?.explanationQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(placement.explanationQuote)
                    : placement?.explanationQuote
            }))
        } : {})
    };
    let repairedFigures = paper.apiReaderFigures;
    if (Array.isArray(paper.apiReaderFigures)) {
        repairedFigures = orderApiReaderFiguresByArticle(
            article,
            paper.apiReaderFigures.map(figure => ({
                ...figure,
                leadQuote: typeof figure?.leadQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(figure.leadQuote)
                    : figure?.leadQuote,
                explanationQuote: typeof figure?.explanationQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(figure.explanationQuote)
                    : figure?.explanationQuote
            }))
        );
        if (!repairedFigures) return false;
    }
    const articleSha = crypto.createHash('sha256').update(article).digest('hex');
    const oldSha = stableFingerprint(plan);
    const newSha = stableFingerprint(repairedPlan);
    const oldFiguresSha = Array.isArray(paper.apiReaderFigures)
        ? stableFingerprint(paper.apiReaderFigures)
        : null;
    const newFiguresSha = Array.isArray(repairedFigures)
        ? stableFingerprint(repairedFigures)
        : null;
    if (oldSha === newSha && paper.apiReaderPlanSha256 === newSha
        && stage.planSha256 === newSha
        && originalArticle === article
        && paper.apiReaderArticleSha256 === articleSha
        && stage.articleSha256 === articleSha
        && oldFiguresSha === newFiguresSha
        && (!Array.isArray(repairedFigures)
            || (stage.figureCount === repairedFigures.length
                && stage.figuresSha256 === newFiguresSha))) return false;
    const qualityView = apiReaderPreInjectionQualityView(article, repairedPlan, repairedFigures || []);
    const quality = validateReaderEditorialQuality(qualityView, repairedPlan.sections);
    const qualityMetrics = buildApiReaderQualityMetrics(quality, qualityView);
    if (qualityMetrics.blockingIssueCount > 0) {
        throw new Error('Reader 表面修复后仍有文风阻断问题，拒绝签发新的表面绑定');
    }
    paper.apiReaderPlan = repairedPlan;
    paper.apiReaderPlanSha256 = newSha;
    paper.apiReaderArticle = article;
    paper.apiReaderArticleSha256 = articleSha;
    stage.planSha256 = newSha;
    stage.articleSha256 = articleSha;
    stage.qualityMetrics = qualityMetrics;
    stage.qualityMetricsContractVersion = API_READER_QUALITY_METRICS_CONTRACT;
    stage.surfaceRepairVersion = API_READER_SURFACE_REPAIR_VERSION;
    stage.surfaceRepair = {
        executionKind: 'deterministic_surface_repair',
        inputArticleSha256: crypto.createHash('sha256').update(originalArticle).digest('hex'),
        outputArticleSha256: articleSha,
        inputPlanSha256: oldSha,
        outputPlanSha256: newSha,
        inputFiguresSha256: oldFiguresSha,
        outputFiguresSha256: newFiguresSha,
        qualityInputView: 'reader-before-figure-and-formula-injection',
        qualityInputSha256: crypto.createHash('sha256').update(qualityView).digest('hex'),
        repairedAt: getBeijingISOString()
    };
    if (repairedPlan.sourceBindingsSha256) {
        stage.sourceBindingsSha256 = repairedPlan.sourceBindingsSha256;
    }
    if (Array.isArray(repairedFigures)) {
        paper.apiReaderFigures = repairedFigures;
        stage.figureCount = repairedFigures.length;
        stage.figuresSha256 = newFiguresSha;
        const imageStage = analysisManifest?.stages?.imageSupplement;
        if (imageStage && imageStage.reason === 'api_reader_v3_official_figures_bound') {
            imageStage.officialFigureCount = repairedFigures.length;
            imageStage.officialFiguresSha256 = newFiguresSha;
        }
    }
    return true;
}

const apiReaderGenerationQueue = [];
let activeApiReaderGenerations = 0;

async function withApiReaderGenerationSlot(callback) {
    if (activeApiReaderGenerations >= API_READER_CONCURRENCY) {
        await new Promise(resolve => apiReaderGenerationQueue.push(resolve));
    }
    activeApiReaderGenerations += 1;
    console.log(
        `    [deep] API reader 生成槽位: active=${activeApiReaderGenerations}`
        + `/${API_READER_CONCURRENCY} | queued=${apiReaderGenerationQueue.length}`
    );
    try {
        return await callback();
    } finally {
        activeApiReaderGenerations -= 1;
        apiReaderGenerationQueue.shift()?.();
    }
}

async function generateApiReaderArticleDetailed(paper, analysis, sourceEvidence, options = {}) {
    return withApiReaderGenerationSlot(() => generateApiReaderArticleDetailedUnlocked(
        paper, analysis, sourceEvidence, options
    ));
}

function buildApiReaderValidationFeedback(error) {
    const message = String(error?.message || error || '未知校验错误');
    const fixes = [];
    if (/表格前缺少|张表.*前缺少/.test(message)) {
        fixes.push(
            '每张表之前必须另起一个由空行隔开的普通正文段，且它必须直接成为表格前一个 Markdown 块；'
            + '该段至少写 15 个汉字，明确比较问题、统一条件、基线和指标升降方向。'
            + '不要让小节标题、列表、另一张表或同一行文字紧贴在表格前面'
        );
    }
    if (/表格后缺少|张表.*后缺少/.test(message)) {
        fixes.push(
            '每张表之后必须另起一个由空行隔开的普通正文段，且它必须直接成为表格后一个 Markdown 块；'
            + '该段至少写 25 个汉字，解释净收益、一个失败项或反例，以及该表不能支持的结论。'
            + '不要让小节标题、列表、另一张表或同一行文字紧贴在表格后面'
        );
    }
    if (/Markdown 表(?:格)?列数不一致/.test(message)) {
        fixes.push(
            '逐行数清每张 Markdown 表的单元格，表头、分隔行和每个数据行必须完全同列；'
            + '单元格正文禁止出现未转义的竖线 |，集合、范围或并列关系改用“、”“/”或文字表达，'
            + '不要使用会额外产生 pipe 的 LaTeX 绝对值或条件概率写法'
        );
    }
    if (/至少需要 \d+ 张有叙事闭环/.test(message)) {
        fixes.push(
            '保留已有合格表并补足要求数量；新增表必须写在 section.body 内，使用标准表头、分隔行和数据行，'
            + '且每张表都要有相邻的独立表前段与表后段'
        );
    }
    if (/figurePlacements\[\d+\].*相邻闭环/.test(message)) {
        fixes.push(
            '对应 Figure marker 必须在 targetKind 指定的同一小节中独占一个 Markdown 段；'
            + `紧邻前一段至少 ${API_READER_FIGURE_LEAD_MIN_CHARS} 字，`
            + `紧邻后一段至少 ${API_READER_FIGURE_EXPLANATION_MIN_CHARS} 字，`
            + '中间不能夹标题、列表、表格或其他 marker；'
            + 'focusPoints 必须有 2–4 项且每项 12–120 字'
        );
    }
    if (/高价值图文绑定少于/.test(message)) {
        fixes.push(
            '从可用 Figure 清单补足不同 figureOrdinal；每张图都按“35 字以上独立导读段—独占 marker—'
            + '45 字以上独立解释段”放入匹配的 targetKind 小节，并给出 2–4 个具体观察点'
        );
    }
    if (/conceptBridges\[\d+\]/.test(message)) {
        fixes.push(
            '对应 concept bridge marker 必须独占一个段落；explanation 必须逐字同时包含 terms 中的两个术语，'
            + '依次说明各自分工、搭配原因和组合后新增的含义'
        );
    }
    if (/reader_template_phrase/.test(message)) {
        fixes.push(
            '删除校验列出的流水线短语，尤其不要写“证据边界在于”；改成以具体数据集、条件、指标或缺失对照为主语的自然句'
        );
    }
    if (/defensive_negation_saturation/.test(message)) {
        fixes.push(
            '在 limitation 之外大幅减少“不是、不能、并非、不等于、不意味着、没有”等防御性否定；'
            + '把句子改成正面陈述具体成立范围、观测条件和残余缺口'
        );
    }
    if (/comparison_unit_missing/.test(message)) {
        fixes.push(
            '每组比较数字都分别补齐同一指标名与单位；不要写无单位的“从 A 到 B”或“X 对 Y”'
        );
    }
    if (/numeric_typography|quantitative_chinese_numeral/.test(message)) {
        fixes.push('数量、比例、编号和带单位数值统一使用阿拉伯数字，并在数字与拉丁单位之间留空格');
    }
    if (/JSON 无法解析|包含额外字段/.test(message)) {
        fixes.push(
            '严格按字段白名单输出单个 JSON 对象；不要新增 tables、tableMarkdown 等字段；'
            + '字符串内的换行必须使用 JSON 转义，禁止原始控制字符'
        );
    }
    if (/source-binding v4|tableBindings|渲染单元格与原始 cell|exact sourceQuote/.test(message)) {
        fixes.push(
            '逐张按正文顺序重建 tableBindings：原表模式必须让每个渲染单元格逐字等于绑定坐标的原始 cell，'
            + '并覆盖表头和所有数据格；正文整理模式必须复制全文中的连续原句，且覆盖表内每个数字与单位。'
            + '不要翻译原表 cell、沿用调列前坐标或自行计算 SHA；'
            + '报错列出的每个数字都必须改成原文逐字写法（保留千分位逗号、百分号、小数位数和单位，'
            + '不得四舍五入），或删掉原文没有的数字；'
            + '若数字明明在原文表格 DOM 里以独立单元格存在、却因正文排版拼合找不到连续 quote，'
            + '改用 artifact_table 模式逐格绑定该原表，不要坚持 source_quotes'
        );
    }
    if (/formulaBindings|未绑定、重复或被改写的展示公式/.test(message)) {
        fixes.push(
            '删除所有自行书写的展示公式，只保留与 READER_ARTIFACTS ordinal 对应的独占 FORMULA marker，'
            + '并为每个 marker 建立唯一 formulaBindings 项；代码会注入原始 TeX'
        );
    }
    if (/缺少独立说明段|缺少独立解释段/.test(message)) {
        fixes.push(
            '报错指出的表之前必须有 1–2 段独立说明（比较问题、统一条件、基线与指标方向），'
            + '之后必须有 2–4 段独立解释（净收益、失败项、不能推出的结论）；'
            + '表绝不能作为小节的第一段，表前后也不能只放标题或其他表格'
        );
    }
    if (/宽表/.test(message)) {
        fixes.push(
            '至少把 2 张表做到 5 列以上，列中必须包含比较条件、关键控制变量、'
            + '两个数据集或指标、解释或成本列；不要只列方法与数值两列'
        );
    }
    if (/粘连复写/.test(message)) {
        fixes.push(
            '只重写报错指出的那一个单元格：删掉重复的另一份（纯文本与 TeX 只留纯文本那份），'
            + 'LaTeX 命令残留改成纯文本或 Unicode 符号，改后数字仍须与原文一致且可绑定；'
            + '不要整表重写，不要动其他已通过的单元格'
        );
    }
    if (/中文字数必须/.test(message)) {
        fixes.push(
            '只扩写或压缩现有小节正文，使中文字符数进入报错给出的区间，不改变事实、数字和章节顺序；'
            + '字数不足时把每节扩写到 4–5 段、每段 150–220 字，补充机制分工、对照条件与失败细节，'
            + '不要只加空话'
        );
    }
    return `上一次输出被代码拒绝：${message}。`
        + (fixes.length > 0 ? `必须执行以下修复：${fixes.join('；')}。` : '')
        + '请按本次请求指定的输出协议精确修复目标节点；逐句去重，'
        + '任何包含过多句子的单段都拆成 2–4 句的自然段。'
        + '提交前逐行复算每张 Markdown 表的 pipe 单元格数量，'
        + '并逐条确认 conceptBridges 与 figurePlacements 的 marker 和相邻正文真实存在。';
}

const API_READER_REVISION_MODE = 'api-reader-signed-revision-v1';

function prepareApiReaderRevisionSeed(paper, sourceText, reviewFeedback) {
    if (!String(reviewFeedback || '').trim()) return null;
    // Reuse the production byte/provenance validator rather than trusting a
    // complete flag or accepting a newly supplied draft as an existing Reader.
    const { apiReaderV3BindsCanonical } = require('./analysis-engine.js');
    if (paper?.latestAnalysisAttemptError || !apiReaderV3BindsCanonical(paper)) {
        throw new Error('定向 Reader 修订需要完整、正文/计划/阶段 SHA 一致的已签名 Reader');
    }
    const sourceSha256 = crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
    if (sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== paper.analysisManifest.sourceAcquisition.sourceSha256
        || sourceSha256 !== paper.analysisManifest.stages.apiReaderArticle.sourceBindingsSourceTextSha256) {
        throw new Error('定向 Reader 修订底稿与本次全文来源 SHA 不一致');
    }
    const initialDraft = JSON.stringify({ article: paper.apiReaderArticle, plan: paper.apiReaderPlan });
    return {
        initialDraft,
        metadata: {
            revisionMode: API_READER_REVISION_MODE,
            revisionSeedSha256: crypto.createHash('sha256').update(initialDraft).digest('hex'),
            revisionSeedArticleSha256: paper.apiReaderArticleSha256,
            revisionSeedPlanSha256: paper.apiReaderPlanSha256,
            revisionSeedSourceSha256: sourceSha256,
            revisionTemperature: API_READER_REPAIR_TEMPERATURE
        }
    };
}

function buildApiReaderGenerationStart(paper, options = {}) {
    const externalReviewFeedback = String(options.reviewFeedback || '').trim();
    let seed = null;
    if (options.initialDraft !== undefined) {
        seed = prepareApiReaderRevisionSeed(paper, options.sourceText, externalReviewFeedback);
        if (!seed || seed.initialDraft !== options.initialDraft) {
            throw new Error('Reader initialDraft 不是当前已签名正文与计划，拒绝使用未验证底稿');
        }
    }
    const reviewFeedbackPrefix = externalReviewFeedback
        ? '上一轮只读发布审查发现以下事实或图文绑定问题；必须逐项纠正，'
            + `不能原样复述错误：${externalReviewFeedback}`
            + (seed
                ? '\n本次是基于已签名 Reader 的定向修订。previousDraft 中的 {article,plan} '
                    + '是已有正文与计划的修订参考，不是可直接提交的输出结构。只修反馈指出的问题及必要连带内容，'
                    + '保留已经正确的章节、解释、图表和数字，不要无端重写。'
                    + '仍须输出当前协议要求的完整 JSON，包括全部小节、marker 与来源绑定；'
                    + '不得直接返回参考用的 {article,plan}，全部正文、图片、表格和公式仍须通过原门禁。'
                : '')
        : '';
    return {
        previousDraft: seed?.initialDraft || '无',
        reviewFeedbackPrefix,
        isRevision: Boolean(seed),
        temperature: seed ? API_READER_REPAIR_TEMPERATURE : API_READER_INITIAL_TEMPERATURE
    };
}

async function generateApiReaderArticleDetailedUnlocked(paper, analysis, sourceEvidence, options = {}) {
    const repair = require('./lib/reader-repair.js');
    const fresh = require('./lib/fresh-analysis-context.js');
    fresh.assertFreshPaper(paper);
    const freshIdentity = fresh.freshAnalysisIdentity(getPaperArxivId(paper));
    const { buildReaderContractNotice, readerRequirements } = require('./lib/reader-contract.js');
    const { FILES } = require('./config.js');
    const start = buildApiReaderGenerationStart(paper, options);
    const contentMode = start.isRevision ? READER_SIGNED_REVISION_CONTENT_MODE : READER_SOURCE_CONTENT_MODE;
    const requestModel = options.readerCallModel || callModel;
    const recordDisposition = options.readerRecordDisposition || require('./lib/llm-usage.js').recordLlmDisposition;
    const materializeFigures = options.readerMaterializeFigures || materializeApiReaderFigures;
    const conference = require('./lib/conference-analysis-context.js');
    const candidateDirectory = fresh.getFreshAnalysisContext()
        ? fresh.freshReaderAttemptsDirectory(options.readerAttemptsDir)
        : conference.getConferenceAnalysisContext()
            ? conference.conferenceReaderAttemptsDirectory(options.readerAttemptsDir)
            : options.readerAttemptsDir || FILES.apiReaderAttemptsDir;
    if (!candidateDirectory) throw new Error('Reader candidate directory is not configured');
    const repairMaxTokens = ANALYSIS_CONFIG.apiReaderRepairMaxTokens || 8000;
    const maxAttempts = Number.isInteger(options.readerMaxAttempts)
        ? Math.min(6, Math.max(1, options.readerMaxAttempts)) : 6;
    const identity = {
        paperId: getPaperArxivId(paper),
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        contentMode,
        inputFingerprint: stableFingerprint({ contentMode, sourceEvidence,
            reviewFeedback: options.reviewFeedback || '', initialDraft: start.previousDraft,
            structuredArtifacts: options.structuredArtifacts?.payloadSha256 || '' }),
        sourceSha256: repair.shaText(options.sourceText || ''),
        model: modelFingerprint(DEEP_CONFIG, start.temperature, API_READER_MAX_TOKENS),
        promptSha256: promptTemplateSha256('prompts/api-reader-article.md'),
        repairPromptSha256: promptTemplateSha256('prompts/api-reader-repair.md'),
        parserImplementationSha256: repair.shaText(fs.readFileSync(__filename, 'utf8')),
        editorialImplementationSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'editorial-quality.js'), 'utf8')),
        mechanicalContractSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'lib/reader-contract.js'), 'utf8')),
        tableCompilerSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'lib/reader-tables.js'), 'utf8')),
        repairImplementationSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'lib/reader-repair.js'), 'utf8')),
        draftOrderContract: READER_DRAFT_ORDER_CONTRACT,
        draftOrderImplementationSha256: promptTemplateSha256('scripts/lib/reader-draft-order.js'),
        sourceDiagnosticsImplementationSha256: promptTemplateSha256('scripts/lib/reader-source-diagnostics.js'),
        readerContract: API_READER_ARTICLE_CONTRACT,
        sourceBindingContract: API_READER_SOURCE_BINDING_CONTRACT,
        repairVersion: repair.REPAIR_VERSION,
        repairMaxTokens,
        maxAttempts,
        repairTemperature: API_READER_REPAIR_TEMPERATURE
    };
    let recovered = null;
    let readerRecoveryRevisions = [];
    let candidate = null;
    let draftOrderMappings = [];
    const normalizeCandidate = () => {
        if (!candidate) return;
        const normalized = normalizeReaderDraftOrder(candidate);
        candidate = normalized.draft;
        if (normalized.mapping.changed) draftOrderMappings.push(normalized.mapping);
    };
    let currentIssues = [];
    let completedAttempts = 0;
    let fullAttempts = 0;
    let transportFailures = 0;
    let noProgress = 0;
    let previousFailureSignature = '';
    let validationFailureStreak = 0;
    let previousValidationFailureSignature = '';
    let implementationRepairAllowanceProof = null;
    const reviewFeedbackPrefix = start.reviewFeedbackPrefix;
    // 振荡型失败下模型会在“修好 A 又弄坏 B”之间横跳：只给最近一次错误，
    // 它永远看不到约束全集。本轮内累积历次错误并每次全量呈现，同时让外部
    // review 反馈在每一轮都保留（之前第二轮起就被覆盖丢弃了）。
    const attemptErrorHistory = [];
    const numericSpellingGuidance = require('./lib/reader-source-diagnostics.js').readerNumericSpellingGuidance();
    const buildAttemptFeedback = () => {
        const parts = [numericSpellingGuidance];
        if (reviewFeedbackPrefix) parts.push(reviewFeedbackPrefix);
        if (attemptErrorHistory.length === 0) {
            parts.push(start.isRevision
                ? '这是基于已签名底稿的首次定向修订，尚无本轮校验错误。'
                : '这是第一次生成，没有上一次校验错误。');
        } else {
            parts.push(
                '以下是本轮之前所有尝试被代码拒绝的错误（必须同时全部纠正，'
                + '不要只修最后一条而把前面已通过的又改坏）：\n'
                + attemptErrorHistory.join('\n')
            );
        }
        return parts.join('\n');
    };
    let validationFeedback;
    let previousDraft = start.previousDraft;
    let lastError = null;
    const availableFigureOrdinals = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger);
    const availableTableCount = [...String(sourceEvidence || '')
        .matchAll(/^TABLE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger).length;
    const minimumIntegratedTables = readerRequirements({ version: 3, availableTableCount }).minimumTables;
    const mechanicalContract = buildReaderContractNotice({ version: 3, minimumIntegratedTables, availableTableCount,
        ...readerResultTableRequirement(options.structuredArtifacts) });
    const figureEvidenceEntries = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):\s*([^\n]*)\nFIGURE_\1_URL:\s*(https:\/\/[^\s]+)$/gm)]
        .map(match => ({
            ordinal: Number.parseInt(match[1], 10),
            caption: match[2].trim(),
            url: match[3].trim()
        }))
        .filter(item => Number.isInteger(item.ordinal));
    const materializedReaderImages = figureEvidenceEntries.length > 0
        ? await materializeFigures(
            figureEvidenceEntries.map(item => ({
                ...item,
                label: `Figure ${item.ordinal}`,
                mediaType: new URL(item.url).pathname.toLowerCase().endsWith('.svg')
                    ? 'image/svg+xml'
                    : ''
            })),
            getPaperArxivId(paper)
        )
        : [];
    const downloadedReaderImages = [];
    let readerImageBase64Chars = 0;
    for (const image of materializedReaderImages) {
        const raw = fs.readFileSync(image.cachePath);
        const actualPixelSha256 = crypto.createHash('sha256').update(raw).digest('hex');
        if (actualPixelSha256 !== image.assetSha256) {
            throw new Error(`Reader Figure ${image.ordinal} cache bytes differ from materialized pixel SHA`);
        }
        const base64 = raw.toString('base64');
        if (base64.length > IMAGE_MAX_BASE64_CHARS
            || readerImageBase64Chars + base64.length > IMAGE_TOTAL_BASE64_CHARS) {
            console.log(
                `    [deep] 跳过超出 Muse 图像输入预算的论文图 ${image.ordinal}`
            );
            continue;
        }
        readerImageBase64Chars += base64.length;
        downloadedReaderImages.push({
            url: image.url,
            base64,
            mime: 'image/png',
            sha256: image.assetSha256
        });
    }
    const readerImageBlocks = downloadedReaderImages.flatMap(image => {
        const figure = figureEvidenceEntries.find(item => item.url === image.url);
        if (!figure) return [];
        return [
            {
                type: 'text',
                text: `以下图像与证据清单 FIGURE_${figure.ordinal} 一一对应。图注：${figure.caption}`
            },
            buildImageContent(image.url, image.base64, image.mime)
        ];
    });
    const imageEvidence = downloadedReaderImages.map(image => {
        const figure = figureEvidenceEntries.find(item => item.url === image.url);
        return {
            ordinal: figure?.ordinal || null,
            url: image.url,
            sha256: image.sha256
        };
    });
    recovered = require('./lib/reader-recovery-revision.js').loadReaderRecoveryRevision(candidateDirectory, identity,
        { pixelEvidenceSha256: repair.hashDraft(imageEvidence) });
    readerRecoveryRevisions = recovered?.readerRecoveryRevisions || [];
    candidate = recovered?.draft || null;
    draftOrderMappings = recovered?.draftOrderMappings || [];
    currentIssues = recovered?.issues || [];
    completedAttempts = recovered?.attempts || 0;
    fullAttempts = recovered?.fullAttempts || 0;
    transportFailures = recovered?.transportFailures || 0;
    noProgress = recovered?.noProgress || 0;
    previousFailureSignature = recovered?.failureSignature || '';
    validationFailureStreak = recovered?.validationFailureStreak || 0;
    previousValidationFailureSignature = recovered?.validationFailureSignature || '';
    implementationRepairAllowanceProof = recovered?.implementationRepairAllowanceProof || null;
    attemptErrorHistory.push(...currentIssues.map(issue => issue.message));
    validationFeedback = buildAttemptFeedback();
    previousDraft = recovered?.rawDraft || start.previousDraft;
    const pixelFigureOrdinals = imageEvidence.map(item => item.ordinal).filter(Number.isInteger);
    const readerImageVisibilityNotice = imageEvidence.length > 0
        ? `模型本次真正收到像素的图为：${imageEvidence.map(
            item => `FIGURE_${item.ordinal}`
        ).join(', ')}。只有这些图可以解读坐标轴、曲线、面板、颜色和箭头等像素细节。`
        : '模型本次没有收到任何 Figure 像素；只能依据图注和正文，禁止声称看到坐标轴、曲线、颜色或模块位置。';
    const parseCandidate = raw => parseApiReaderArticleResult(raw, {
        availableFigureOrdinals: pixelFigureOrdinals,
        requireIntegratedTables: true,
        minimumIntegratedTables,
        requiredVersion: API_READER_PLAN_VERSION,
        requireSourceBindings: true,
        allowDeterministicQuoteRepair: true,
        structuredArtifacts: options.structuredArtifacts,
        sourceText: options.sourceText
    });
    // A recovery candidate is revalidated even if an earlier worker labelled
    // it failed. No persisted success flag can bypass today's full gates.
    if (candidate) {
        try {
            normalizeCandidate();
            const parsed = parseCandidate(JSON.stringify(candidate));
            const retiredCandidate = repair.retireFailedCandidate(candidateDirectory, identity);
            return { ...parsed, contentMode, attempts: completedAttempts, imageEvidence, resumedCandidate: true,
                retiredCandidate, draftOrderMappings };
        }
        catch (error) { currentIssues = repair.collectDraftIssues(candidate, error, {
            sourceText: options.sourceText, structuredArtifacts: options.structuredArtifacts
        }); }
    }
    const attemptLimit = repair.readerAttemptLimit(
        maxAttempts, completedAttempts, candidate, implementationRepairAllowanceProof ? 1 : 0);
    if (completedAttempts >= attemptLimit || noProgress >= 2 || validationFailureStreak >= 2) {
        throw new Error('Reader failed candidate exhausted its bounded attempts; inspect recovery evidence before changing inputs');
    }
    for (let attempt = completedAttempts + 1; attempt <= attemptLimit; attempt++) {
        const repairContext = candidate
            ? repair.buildRepairContext(candidate, currentIssues, sourceEvidence, options.sourceText) : null;
        if (!repairContext && fullAttempts >= 2) {
            throw lastError || new Error('Reader root JSON remained invalid after two full attempts');
        }
        const prompt = repairContext ? loadPrompt('prompts/api-reader-repair.md', {
            title: paper.title || '', arxivId: getPaperArxivId(paper),
            validationFeedback: [numericSpellingGuidance, reviewFeedbackPrefix,
                ...currentIssues.map(issue => issue.message)].filter(Boolean).join('\n'),
            repairTargets: JSON.stringify({ draftSha256: repairContext.draftSha256, targets: repairContext.targets }),
            sourceEvidence: repairContext.evidence,
            mechanicalContract
        }) : loadPrompt('prompts/api-reader-article.md', {
            title: paper.title || '',
            arxivId: getPaperArxivId(paper),
            sourceEvidence,
            validationFeedback,
            previousDraft,
            mechanicalContract
        });
        if (prompt.length > API_READER_CONTEXT_MAX_CHARS) {
            throw new Error(
                `读者文章完整请求上下文超限: ${prompt.length}/${API_READER_CONTEXT_MAX_CHARS} 字符`
            );
        }
        const selectedImageBlocks = repairContext ? downloadedReaderImages.flatMap(image => {
            const figure = figureEvidenceEntries.find(item => item.url === image.url);
            return figure && repairContext.figureOrdinals.includes(figure.ordinal)
                ? [{ type: 'text', text: `以下是真实 FIGURE_${figure.ordinal} 像素。图注：${figure.caption}` },
                    buildImageContent(image.url, image.base64, image.mime)] : [];
        }) : readerImageBlocks;
        const selectedOrdinals = repairContext
            ? pixelFigureOrdinals.filter(ordinal => repairContext.figureOrdinals.includes(ordinal)) : pixelFigureOrdinals;
        const visibilityNotice = repairContext
            ? `本次局部修复真正收到像素的图：${selectedOrdinals.map(ordinal => `FIGURE_${ordinal}`).join(', ') || '无'}。其他图保持已有绑定，不得改写其像素事实。`
            : readerImageVisibilityNotice;
        let raw;
        const priorCandidateSha = candidate ? repair.hashDraft(candidate) : '';
        try {
            raw = await requestModel(
            [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'text', text: visibilityNotice },
                    ...selectedImageBlocks
                ]
            }],
            repairContext ? repairMaxTokens : API_READER_MAX_TOKENS,
            {
                temperature: attempt === 1 && !repairContext
                    ? start.temperature : API_READER_REPAIR_TEMPERATURE,
                overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
                maxRetries: API_READER_TRANSPORT_MAX_RETRIES,
                usageContext: { paperId: getPaperArxivId(paper),
                    stage: repairContext ? 'apiReaderRepair' : 'apiReaderArticle', contentAttempt: attempt }
            }
            );
        } catch (error) {
            if (['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(error?.code)) {
                // The provider returned a terminated output, even though the
                // public call deliberately did not expose its partial text.
                // Charge the content budget and retain the last intact draft.
                if (!repairContext) fullAttempts += 1;
                implementationRepairAllowanceProof = null;
                const failureSignature = repair.hashDraft({ code: error.code,
                    kind: repairContext ? 'patch' : 'full', draftSha256: priorCandidateSha });
                noProgress = failureSignature === previousFailureSignature ? noProgress + 1 : 0;
                previousFailureSignature = failureSignature;
                repair.saveFailedCandidate(candidateDirectory, identity, {
                    status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions,
                    issues: currentIssues, attempts: attempt, fullAttempts, noProgress,
                    failureSignature, validationFailureSignature: previousValidationFailureSignature,
                    validationFailureStreak, implementationRepairAllowanceProof, imageEvidence, transportFailures,
                    lastContentError: { code: error.code, message: String(error.message || error),
                        outputTokens: Number.isFinite(error.outputTokens) ? error.outputTokens : null,
                        maxOutputTokens: Number.isFinite(error.maxOutputTokens) ? error.maxOutputTokens : null }
                });
                throw error;
            }
            // No content was received: preserve both the candidate and its
            // content budget. The public request layer already bounds network
            // retries; this invocation stops here and a later run may resume.
            transportFailures += 1;
            repair.saveFailedCandidate(candidateDirectory, identity, {
                status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions,
                issues: currentIssues, attempts: attempt - 1, fullAttempts,
                noProgress, failureSignature: previousFailureSignature,
                validationFailureSignature: previousValidationFailureSignature,
                validationFailureStreak, implementationRepairAllowanceProof, imageEvidence,
                transportFailures, lastTransportError: String(error?.message || error)
            });
            throw error;
        }
        implementationRepairAllowanceProof = null;
        if (!repairContext) fullAttempts += 1;
        const responseSha256 = repair.shaText(raw);
        const dispositionBase = { paperId: getPaperArxivId(paper),
            stage: repairContext ? 'apiReaderRepair' : 'apiReaderArticle',
            contentAttempt: attempt, outputTextSha256: responseSha256 };
        let patchApplied = false;
        try {
            if (repairContext) {
                const patch = JSON.parse(extractJsonObjectText(raw));
                candidate = repair.applyReaderPatch(candidate, patch, repairContext.targets.map(target => target.path), {
                    availableFigureOrdinals: selectedOrdinals
                });
                patchApplied = true;
                raw = JSON.stringify(candidate);
            } else {
                candidate = repair.parseRepairableDraft(extractJsonObjectText(raw));
            }
            normalizeCandidate();
            if (candidate) raw = JSON.stringify(candidate);
            const parsed = parseCandidate(raw);
            recordDisposition({ ...dispositionBase, disposition: 'accepted' });
            const retiredCandidate = repair.retireFailedCandidate(candidateDirectory, identity);
            return {
                ...parsed,
                contentMode,
                attempts: attempt,
                imageEvidence,
                repairVersion: repair.REPAIR_VERSION,
                draftOrderMappings,
                fullAttempts,
                transportFailures,
                retiredCandidate,
                resumedCandidate: Boolean(recovered)
            };
        } catch (error) {
            recordDisposition({ ...dispositionBase, disposition: 'rejected', errorCode: error.code || 'READER_VALIDATION_FAILED' });
            lastError = error;
            previousDraft = candidate ? JSON.stringify(candidate) : raw;
            currentIssues = repairContext && !patchApplied
                ? [...currentIssues.filter(issue => !issue.message.startsWith('Reader patch')),
                    { path: null, message: `Reader patch rejected: ${error.message}` }]
                : repair.collectDraftIssues(candidate, error, {
                    sourceText: options.sourceText, structuredArtifacts: options.structuredArtifacts
                });
            const failureSignature = repair.hashDraft(currentIssues);
            noProgress = failureSignature === previousFailureSignature
                || (candidate && repair.hashDraft(candidate) === priorCandidateSha) ? noProgress + 1 : 0;
            previousFailureSignature = failureSignature;
            const normalizedFailureSignature = repair.validationFailureSignature(currentIssues);
            validationFailureStreak = repair.validationFailureHasNoProgress(
                previousValidationFailureSignature, normalizedFailureSignature)
                ? validationFailureStreak + 1 : 1;
            previousValidationFailureSignature = normalizedFailureSignature;
            repair.saveFailedCandidate(candidateDirectory, identity, {
                status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions,
                issues: currentIssues, attempts: attempt, fullAttempts, noProgress, failureSignature, imageEvidence,
                transportFailures, validationFailureSignature: normalizedFailureSignature,
                validationFailureStreak, implementationRepairAllowanceProof
            });
            const feedback = buildApiReaderValidationFeedback(error);
            if (!attemptErrorHistory.includes(feedback)) {
                attemptErrorHistory.push(feedback);
            }
            while (attemptErrorHistory.join('\n').length > 3000) {
                attemptErrorHistory.shift();
            }
            validationFeedback = buildAttemptFeedback();
            console.log(`    [deep] ⚠️  读者文章校验失败 (${attempt}/${maxAttempts}): ${error.message}`);
            if (validationFailureStreak >= 2) {
                throw new Error(`Reader 同一规范化验证门禁连续 2 次无改善，已保留失败候选：${error.message}`, { cause: error });
            }
            if (noProgress >= 2) {
                throw new Error(`Reader 局部修复连续无进展，已保留失败候选：${error.message}`, { cause: error });
            }
        }
    }
    throw lastError || new Error('读者文章生成失败');
}

async function refreshApiReaderArticleFromSource(paper, sourceDetails, options = {}) {
    if (!paper || typeof paper !== 'object') throw new Error('刷新读者文章需要 canonical paper');
    const analysis = String(paper.analysis || '');
    const manifest = paper.analysisManifest;
    const scoringStage = manifest?.stages?.scoringAudit;
    if (!analysis || scoringStage?.status !== 'complete') {
        throw new Error('刷新读者文章只接受已完成 analysis 与评分审计的 canonical');
    }
    const arxivId = getPaperArxivId(paper);
    const sourceText = String(sourceDetails?.text || '');
    if (sourceText.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
        throw new Error('刷新读者文章需要可验证全文');
    }
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (sourceSha256 !== manifest?.sourceAcquisition?.sourceSha256
        || sourceSha256 !== paper.sourceSha256) {
        throw new Error('刷新读者文章的全文 SHA 与 canonical 来源不一致');
    }
    const textForAnalysis = buildTaskEvidenceContext(
        sourceText,
        FULL_TEXT_MAX_CHARS,
        BROAD_EVIDENCE_PATTERNS,
        'PRIMARY'
    );
    const evidenceContext = buildApiReaderEvidenceContext(
        analysis,
        sourceText,
        sourceDetails.structuredArtifacts,
        arxivId
    );
    const configurationFingerprint = buildRecoveryFingerprints(
        paper, textForAnalysis, arxivId
    ).apiReaderArticle;
    const reviewFeedback = String(options.reviewFeedback || '').trim();
    if (reviewFeedback.length > 4000) throw new Error('读者文章 review feedback 超过 4000 字符');
    const reviewFeedbackSha256 = reviewFeedback
        ? crypto.createHash('sha256').update(reviewFeedback).digest('hex')
        : null;
    const revisionSeed = prepareApiReaderRevisionSeed(paper, sourceText, reviewFeedback);
    const contentMode = revisionSeed ? READER_SIGNED_REVISION_CONTENT_MODE : READER_SOURCE_CONTENT_MODE;
    const fingerprint = stableFingerprint({
        configurationFingerprint,
        contentMode,
        analysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        reviewFeedbackSha256,
        ...(revisionSeed?.metadata || {})
    });
    const generated = await generateApiReaderArticleDetailed(
        paper, analysis, evidenceContext, {
            reviewFeedback,
            ...(revisionSeed ? { initialDraft: revisionSeed.initialDraft } : {}),
            structuredArtifacts: sourceDetails.structuredArtifacts,
            sourceText
        }
    );
    return finalizeApiReaderRefresh(paper, sourceDetails, generated, {
        ...options,
        execution: {
            contentMode, fingerprint, attempts: generated.attempts,
            model: DEEP_CONFIG.model, protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
            temperature: revisionSeed ? API_READER_REPAIR_TEMPERATURE : API_READER_INITIAL_TEMPERATURE,
            repairTemperature: API_READER_REPAIR_TEMPERATURE, maxTokens: API_READER_MAX_TOKENS,
            maxResponseBytes: API_MAX_RESPONSE_BYTES, overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
            promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.apiReaderArticle),
            evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION, evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
            contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
            evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
            reviewFeedbackSha256, ...(revisionSeed?.metadata || {})
        }
    });
}

async function finalizeOperatorApiReaderArticleFromSource(paper, sourceDetails, draft, provenance) {
    const previousStage = structuredClone(paper.analysisManifest?.stages?.apiReaderArticle);
    const parentAnalysis = paper.analysis;
    if (provenance?.contract !== 'reader-signed-operator-v1' || provenance.executionKind !== 'operator'
        || provenance.newApiRequests !== 0 || !require('./analysis-engine.js').apiReaderV3BindsCanonical(paper)
        || provenance.parentPaperSha256 !== stableFingerprint(paper)
        || provenance.parentArticleSha256 !== paper.apiReaderArticleSha256
        || provenance.parentPlanSha256 !== paper.apiReaderPlanSha256
        || provenance.runId !== paper.freshRewriteProvenance?.runId
        || provenance.sourceSha256 !== paper.sourceSha256
        || provenance.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor?.sourceSnapshotSha256) {
        throw new Error('Operator finalization requires a valid signed parent and explicit execution provenance');
    }
    if (typeof parentAnalysis === 'string'
        && applyApiReaderResourceAvailability(parentAnalysis, paper.apiReaderResources) !== parentAnalysis) {
        throw new Error('Reader operator patch requires explicit resource synchronization first; canonical analysis is outside its scope');
    }
    require('./lib/reader-signed-draft.js').recoverSignedReaderDraft({ paper, sourceDetails, runId: provenance.runId });
    if (crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex') !== provenance.afterDraftSha256) {
        throw new Error('Operator finalization draft SHA mismatch');
    }
    const evidence = buildApiReaderEvidenceContext('', sourceDetails.text, sourceDetails.structuredArtifacts, provenance.paperId);
    const parsed = parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: readerRequirements({ version: 3,
            availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: sourceDetails.text, structuredArtifacts: sourceDetails.structuredArtifacts,
        availableFigureOrdinals: paper.apiReaderFigures.map(figure => figure.ordinal)
    });
    const finalized = await finalizeApiReaderRefresh(paper, sourceDetails, {
        ...parsed, imageEvidence: paper.apiReaderFigures.map(figure => ({ ordinal: figure.ordinal,
            url: figure.url, sha256: figure.assetSha256 }))
    }, {
        reuseSignedFigures: structuredClone(paper.apiReaderFigures),
        readerAuthors: structuredClone(paper.apiReaderAuthors), readerResources: structuredClone(paper.apiReaderResources),
        execution: {
            executionKind: 'operator', contentMode: 'reader-source-operator-revision-v1',
            model: 'operator-local', protocol: 'local_operator',
            fingerprint: stableFingerprint(provenance),
            attempts: previousStage.attempts,
            originApiStage: previousStage.originApiStage || previousStage,
            operatorHistory: [...(previousStage.operatorHistory || []), provenance],
            operatorProvenance: provenance,
            ...(previousStage.fullAttempts !== undefined ? { fullAttempts: previousStage.fullAttempts } : {}),
            ...(previousStage.transportFailures !== undefined ? { transportFailures: previousStage.transportFailures } : {})
        }
    });
    if (finalized.analysis !== parentAnalysis) {
        throw new Error('Reader operator patch changed canonical analysis outside the authorized Reader nodes');
    }
    finalized.readerFactReview = { status: 'pending', executionKind: 'operator',
        articleSha256: finalized.apiReaderArticleSha256, planSha256: finalized.apiReaderPlanSha256,
        patchFileSha256: provenance.patchFileSha256, parentPaperSha256: provenance.parentPaperSha256 };
    return finalized;
}

async function finalizeApiReaderRefresh(paper, sourceDetails, generated, options) {
    const manifest = paper.analysisManifest, analysis = String(paper.analysis || '');
    const arxivId = getPaperArxivId(paper), sourceText = String(sourceDetails.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    const injectedReaderResult = injectApiReaderFigures(
        generated, sourceDetails.structuredArtifacts, arxivId
    );
    const materializedFigures = options.reuseSignedFigures
        ? reuseSignedApiReaderFigureAssets(injectedReaderResult.figures, options.reuseSignedFigures, arxivId)
        : await materializeApiReaderFigures(injectedReaderResult.figures, arxivId);
    const materializedFigureOrdinals = new Set(materializedFigures.map(item => item.ordinal));
    const readerResult = {
        ...injectedReaderResult,
        plan: {
            ...injectedReaderResult.plan,
            figurePlacements: (injectedReaderResult.plan.figurePlacements || [])
                .filter(item => materializedFigureOrdinals.has(item.figureOrdinal))
        },
        article: pruneUnmaterializedApiReaderFigureBlocks(
            injectedReaderResult.article,
            injectedReaderResult.figures,
            materializedFigures
        ),
        figures: materializedFigures
    };
    const articleSha256 = crypto.createHash('sha256').update(readerResult.article).digest('hex');
    const planSha256 = stableFingerprint(readerResult.plan);
    const figuresSha256 = stableFingerprint(readerResult.figures);
    const readerAuthors = options.readerAuthors || resolveApiReaderAuthors(paper, sourceDetails);
    const existingReaderResources = paper.apiReaderResources;
    const existingReaderResourceBody = existingReaderResources && {
        contract: existingReaderResources.contract,
        sourceTextSha256: existingReaderResources.sourceTextSha256,
        resources: existingReaderResources.resources
    };
    const reusableExistingReaderResources = existingReaderResources
        && existingReaderResources.contract === API_READER_RESOURCE_IDENTITY_CONTRACT
        && existingReaderResources.sourceTextSha256 === sourceSha256
        && Array.isArray(existingReaderResources.resources)
        && existingReaderResources.identitySha256 === stableFingerprint(existingReaderResourceBody)
        ? existingReaderResources : null;
    const readerResources = options.readerResources
        || reusableExistingReaderResources
        || await buildApiReaderResourceIdentity(
            analysis, sourceText, manifest.stages.demoLinkScan
        );
    manifest.stages.openSourceScan.resourceEvidenceContract = API_READER_RESOURCE_IDENTITY_CONTRACT;
    manifest.stages.openSourceScan.resourceEvidenceSha256 = readerResources.identitySha256;
    paper.apiReaderArticle = readerResult.article;
    paper.apiReaderPlan = readerResult.plan;
    paper.apiReaderFigures = readerResult.figures;
    paper.apiReaderAuthors = readerAuthors;
    paper.apiReaderResources = readerResources;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderPlanSha256 = planSha256;
    manifest.contracts = {
        ...(manifest.contracts || {}),
        apiReaderArticle: API_READER_ARTICLE_CONTRACT,
        apiReaderSourceBindings: API_READER_SOURCE_BINDING_CONTRACT,
        apiReaderAuthorIdentity: API_READER_AUTHOR_IDENTITY_CONTRACT,
        apiReaderResourceIdentity: API_READER_RESOURCE_IDENTITY_CONTRACT
    };
    manifest.sourceAcquisition = {
        ...(manifest.sourceAcquisition || {}),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || ''
    };
    manifest.stages.apiReaderArticle = {
        status: 'complete',
        ...options.execution,
        articleSha256,
        planSha256,
        figureCount: readerResult.figures.length,
        figuresSha256,
        readerAuthorsSha256: stableFingerprint(readerAuthors),
        readerAuthorIdentityContractVersion: API_READER_AUTHOR_IDENTITY_CONTRACT,
        readerAuthorIdentitySha256: readerAuthors.identitySha256,
        resourceIdentityContractVersion: API_READER_RESOURCE_IDENTITY_CONTRACT,
        resourceIdentitySha256: readerResources.identitySha256,
        resourceCount: readerResources.resources.length,
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        qualityMetrics: readerResult.qualityMetrics,
        qualityMetricsContractVersion: API_READER_QUALITY_METRICS_CONTRACT,
        sourceBindingsContractVersion: API_READER_SOURCE_BINDING_CONTRACT,
        sourceBindingRepairVersion: API_READER_SOURCE_BINDING_REPAIR_VERSION,
        sourceBindingsSha256: readerResult.plan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: sourceSha256,
        tableBindingCount: readerResult.plan.tableBindings.length,
        formulaBindingCount: readerResult.plan.formulaBindings.length,
        parserVersion: API_READER_PARSER_VERSION,
        assemblerVersion: API_READER_ASSEMBLER_VERSION,
        tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
        figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
        imageEvidenceCount: readerResult.imageEvidence?.length || 0,
        imageEvidenceSha256: stableFingerprint(readerResult.imageEvidence || []),
        refreshedAt: options.execution.executionKind === 'operator'
            ? options.execution.operatorProvenance.appliedAt : getBeijingISOString()
    };
    if (paper.analysis && manifest.stages.scoringAudit?.status === 'complete') {
        require('./lib/reader-resource-sync.js').synchronizeReaderResourceAvailability(paper, sourceDetails);
    }
    return paper;
}

function reuseSignedApiReaderFigureAssets(figures, previous, arxivId) {
    const root = path.join(CURRENT_DIR, 'api-reader-assets', arxivId);
    const assetKeys = ['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight'];
    if (figures.length !== previous.length) throw new Error('Operator cannot add or remove signed pixel evidence');
    if (figures.length) require('./lib/fresh-rewrite-run.js').assertSafeDirectory(root);
    return figures.map(figure => {
        const prior = previous.find(item => item.ordinal === figure.ordinal && item.url === figure.url
            && item.sourceDomSha256 === figure.sourceDomSha256);
        const expectedFilename = prior && `figure-${figure.ordinal}-${prior.assetSha256?.slice(0, 16)}.png`;
        if (!prior || !recoverySha256(prior.assetSha256) || prior.assetFilename !== expectedFilename
            || prior.cachePath !== path.join(root, expectedFilename) || prior.assetMediaType !== 'image/png') {
            throw new Error('Operator signed figure cache identity mismatch');
        }
        const fd = fs.openSync(prior.cachePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(fd), bytes = fs.readFileSync(fd);
            if (!stat.isFile() || bytes.length !== prior.assetBytes
                || crypto.createHash('sha256').update(bytes).digest('hex') !== prior.assetSha256) {
                throw new Error('Operator signed figure cache bytes changed');
            }
        } finally { fs.closeSync(fd); }
        return { ...figure, ...Object.fromEntries(assetKeys.map(key => [key, prior[key]])) };
    });
}

async function refreshApiScoringAndReaderFromSource(paper, sourceDetails) {
    const { withLlmUsageContext } = require('./lib/llm-usage.js');
    return withLlmUsageContext({ paperId: getPaperArxivId(paper) },
        () => refreshApiScoringAndReaderInternal(paper, sourceDetails));
}

async function refreshApiScoringAndReaderInternal(paper, sourceDetails) {
    if (!paper || typeof paper !== 'object') throw new Error('评分复验需要 canonical paper');
    const manifest = paper.analysisManifest;
    let analysis = String(paper.analysis || '');
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (!analysis || sourceText.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
        throw new Error('评分复验需要已完成 analysis 与可验证全文');
    }
    if (sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest?.sourceAcquisition?.sourceSha256) {
        throw new Error('评分复验的全文 SHA 与 canonical 来源不一致');
    }
    const readerResources = await buildApiReaderResourceIdentity(
        analysis, sourceText, manifest?.stages?.demoLinkScan
    );
    analysis = applyApiReaderResourceAvailability(analysis, readerResources);
    paper.apiReaderResources = readerResources;
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit', analysis, sourceText
    );
    let scoringResult = await auditTypeAwareScoringDetailed(
        analysis,
        sourceText,
        { evidenceContext: scoringEvidenceContext }
    );
    let auditedAnalysis = scoringResult.analysis;
    let auditedParsed = parseAnalysis(auditedAnalysis);
    const invalidReason = getInvalidAnalysisReason(auditedAnalysis, auditedParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        enforceMethodDetailContract: true,
        sourceText
    });
    if (invalidReason) {
        throw new Error(`评分复验后的分析未通过最终契约: ${invalidReason}`);
    }
    const previousScore = Number.parseFloat(paper?.parsed?.score);
    let finalScore = Number.parseFloat(auditedParsed?.score);
    let scoreDelta = Number.isFinite(previousScore) && Number.isFinite(finalScore)
        ? Number((finalScore - previousScore).toFixed(1))
        : null;
    let stabilityResolution = {
        contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
        status: 'not_required',
        threshold: SCORING_STABILITY_THRESHOLD
    };
    let totalAttempts = scoringResult.attempts;
    if (scoreDelta !== null && Math.abs(scoreDelta) > SCORING_STABILITY_THRESHOLD) {
        const firstAuditScore = finalScore;
        const secondResult = await auditTypeAwareScoringDetailed(
            analysis, sourceText, { evidenceContext: scoringEvidenceContext }
        );
        const secondParsed = parseAnalysis(secondResult.analysis);
        const secondInvalidReason = getInvalidAnalysisReason(secondResult.analysis, secondParsed, {
            enforceExperimentTableContract: true,
            experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            enforceMethodDetailContract: true,
            sourceText
        });
        if (secondInvalidReason) {
            throw new Error(`评分稳定性二次审计未通过最终契约: ${secondInvalidReason}`);
        }
        const secondAuditScore = Number.parseFloat(secondParsed?.score);
        const scoreDifference = Math.abs(secondAuditScore - firstAuditScore);
        stabilityResolution = {
            contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
            status: scoreDifference <= SCORING_STABILITY_CONSENSUS_TOLERANCE
                ? 'resolved' : 'unresolved',
            method: 'second_pass_consensus',
            threshold: SCORING_STABILITY_THRESHOLD,
            consensusTolerance: SCORING_STABILITY_CONSENSUS_TOLERANCE,
            firstAuditScore,
            secondAuditScore,
            scoreDifference,
            firstAuditSha256: stableFingerprint(scoringResult.audit),
            secondAuditSha256: stableFingerprint(secondResult.audit),
            secondAttempts: secondResult.attempts
        };
        if (stabilityResolution.status !== 'resolved') {
            throw new Error(
                `评分稳定性二次审计未收敛: first=${firstAuditScore.toFixed(1)}, `
                + `second=${secondAuditScore.toFixed(1)}`
            );
        }
        scoringResult = secondResult;
        auditedAnalysis = secondResult.analysis;
        auditedParsed = secondParsed;
        finalScore = secondAuditScore;
        scoreDelta = Number((finalScore - previousScore).toFixed(1));
        totalAttempts += secondResult.attempts;
    }
    auditedAnalysis = applyApiReaderResourceAvailability(auditedAnalysis, readerResources);
    auditedParsed = parseAnalysis(auditedAnalysis);
    const sealedInvalidReason = getInvalidAnalysisReason(auditedAnalysis, auditedParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        enforceMethodDetailContract: true,
        sourceText
    });
    if (sealedInvalidReason) {
        throw new Error(`资源状态封口后的分析未通过最终契约: ${sealedInvalidReason}`);
    }
    manifest.stages.scoringAudit = {
        status: 'complete',
        attempts: totalAttempts,
        model: scoringResult.model,
        protocol: scoringResult.protocol,
        endpointSha256: scoringResult.endpointSha256,
        maxTokens: scoringResult.maxTokens,
        maxResponseBytes: scoringResult.maxResponseBytes,
        temperature: scoringResult.temperature,
        promptTemplateSha256: scoringResult.promptTemplateSha256,
        scoringInputSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        coreSummaryInputAnalysisSha256: manifest.stages.coreSummaryRepair?.outputAnalysisSha256 || '',
        inputCoreSummarySha256: crypto.createHash('sha256')
            .update(extractSectionByTitle(analysis, '核心摘要')).digest('hex'),
        outputCoreSummarySha256: crypto.createHash('sha256')
            .update(extractSectionByTitle(auditedAnalysis, '核心摘要')).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS,
        evidenceSha256: scoringResult.evidenceSha256,
        scoringContract: SCORING_AUDIT_CONTRACT,
        capRulesVersion: SCORING_CAP_RULES_VERSION,
        previousScore: Number.isFinite(previousScore) ? previousScore : null,
        previousRunScore: Number.isFinite(previousScore) ? previousScore : null,
        finalScore: Number.isFinite(finalScore) ? finalScore : null,
        scoreDelta,
        stabilityWarning: scoreDelta !== null
            && Math.abs(scoreDelta) > SCORING_STABILITY_THRESHOLD,
        stabilityResolution,
        audit: scoringResult.audit,
        auditSha256: stableFingerprint(scoringResult.audit),
        outputAnalysisSha256: crypto.createHash('sha256').update(auditedAnalysis).digest('hex'),
        refreshedAt: getBeijingISOString()
    };
    paper.analysis = auditedAnalysis;
    paper.parsed = auditedParsed;
    await refreshApiReaderArticleFromSource(paper, sourceDetails, { readerResources });
    const figures = Array.isArray(paper.apiReaderFigures) ? paper.apiReaderFigures : [];
    manifest.stages.imageSupplement = {
        status: 'skipped',
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: figures.length,
        officialFiguresSha256: stableFingerprint(figures),
        refreshedAt: getBeijingISOString()
    };
    manifest.contracts = {
        ...(manifest.contracts || {}),
        imageNarrative: IMAGE_NARRATIVE_CONTRACT_VERSION
    };
    return paper;
}

function refreshApiReaderAuthorsFromSource(paper, sourceDetails) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.apiReaderArticle;
    if (manifest?.contracts?.apiReaderArticle !== API_READER_ARTICLE_CONTRACT
        || stage?.status !== 'complete') {
        throw new Error('作者机构刷新只接受已完成 v3 读者文章的 canonical');
    }
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (!sourceText || sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest.sourceAcquisition?.sourceSha256) {
        throw new Error('作者机构刷新的全文 SHA 与 canonical 来源不一致');
    }
    const readerAuthors = resolveApiReaderAuthors(paper, sourceDetails);
    if (!readerAuthors.authors.length || !recoverySha256(readerAuthors.sourceDomSha256)) {
        throw new Error('作者机构刷新未能建立来源绑定');
    }
    paper.apiReaderAuthors = readerAuthors;
    stage.readerAuthorIdentityContractVersion = API_READER_AUTHOR_IDENTITY_CONTRACT;
    stage.readerAuthorIdentitySha256 = readerAuthors.identitySha256;
    stage.readerAuthorsSha256 = stableFingerprint(readerAuthors);
    manifest.contracts = {
        ...(manifest.contracts || {}),
        apiReaderAuthorIdentity: API_READER_AUTHOR_IDENTITY_CONTRACT
    };
    stage.refreshedAt = getBeijingISOString();
    return paper;
}

async function refreshApiReaderFiguresFromSource(paper, sourceDetails) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.apiReaderArticle;
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (manifest?.contracts?.apiReaderArticle !== API_READER_ARTICLE_CONTRACT
        || stage?.status !== 'complete'
        || sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest.sourceAcquisition?.sourceSha256) {
        throw new Error('论文图刷新只接受来源闭环的 v3 canonical');
    }
    const figures = Array.isArray(paper.apiReaderFigures) ? paper.apiReaderFigures : [];
    const currentInventory = getApiReaderFigureInventory(
        sourceDetails.structuredArtifacts,
        getPaperArxivId(paper)
    );
    const allowedUrls = new Set(currentInventory.map(item => item.url));
    const retainedFigures = figures.filter(item => allowedUrls.has(item?.url));
    const materialized = await materializeApiReaderFigures(
        retainedFigures,
        getPaperArxivId(paper)
    );
    const prunedArticle = pruneUnmaterializedApiReaderFigureBlocks(
        paper.apiReaderArticle,
        figures,
        materialized
    );
    const rewrittenArticle = normalizeReaderEditorialSurface(
        rewriteApiReaderFigureNarratives(prunedArticle, materialized)
    );
    const articleSha256 = crypto.createHash('sha256').update(rewrittenArticle).digest('hex');
    const readerAuthors = resolveApiReaderAuthors(paper, sourceDetails);
    const materializedOrdinals = new Set(materialized.map(item => item.ordinal));
    const readerPlan = {
        ...paper.apiReaderPlan,
        figurePlacements: (paper.apiReaderPlan?.figurePlacements || [])
            .filter(item => materializedOrdinals.has(item?.figureOrdinal))
    };
    paper.apiReaderArticle = rewrittenArticle;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderPlan = readerPlan;
    paper.apiReaderPlanSha256 = stableFingerprint(readerPlan);
    paper.apiReaderFigures = materialized;
    paper.apiReaderAuthors = readerAuthors;
    stage.articleSha256 = articleSha256;
    stage.planSha256 = paper.apiReaderPlanSha256;
    stage.figureCount = materialized.length;
    stage.figuresSha256 = stableFingerprint(materialized);
    stage.readerAuthorsSha256 = stableFingerprint(readerAuthors);
    stage.structuredArtifactsSha256 = sourceDetails.structuredArtifacts?.payloadSha256 || '';
    stage.refreshedAt = getBeijingISOString();
    manifest.stages.imageSupplement = {
        status: 'skipped',
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: materialized.length,
        officialFiguresSha256: stableFingerprint(materialized),
        refreshedAt: getBeijingISOString()
    };
    return paper;
}

function getPaperArxivId(paper) {
    return paper?.arxivId || paper?.paper_id || paper?.id || '';
}

function hasCompleteApiReaderFigureBinding(paper, manifest = paper?.analysisManifest) {
    const figures = paper?.apiReaderFigures;
    const stage = manifest?.stages?.apiReaderArticle;
    return manifest?.contracts?.apiReaderArticle === API_READER_ARTICLE_CONTRACT
        && stage?.status === 'complete'
        && Array.isArray(figures)
        && figures.length > 0
        && stage.figureCount === figures.length
        && stage.figuresSha256 === stableFingerprint(figures);
}

const RECOVERY_MANIFEST_VERSION = 1;
const RECOVERY_STAGE_STATUSES = new Set([
    'pending', 'complete', 'not_needed', 'skipped', 'no_candidates',
    'no_high_value_images', 'no_downloadable_images', 'transient_failure', 'invalid_output', 'contract_rejected'
]);
const RECOVERY_STAGE_ORDER = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
    'methodRepair', 'structureRepair', 'coreSummaryRepair', 'scoringAudit', 'apiReaderArticle', 'imageSupplement'
]);
// Execution order is not a dependency graph.  In particular the v3 Reader is
// authored from original source/artifacts, not from canonical analysis or its
// score.  Keep invalidation edges explicit so a summary/score-only migration
// cannot accidentally spend another Reader request.
const RECOVERY_STAGE_DEPENDENCIES = Object.freeze({
    primaryAnalysis: Object.freeze([
        'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
        'structureRepair', 'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    openSourceScan: Object.freeze([
        'revision', 'tableRepair', 'methodRepair', 'structureRepair',
        'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    demoLinkScan: Object.freeze(['apiReaderArticle', 'imageSupplement']),
    revision: Object.freeze([
        'tableRepair', 'methodRepair', 'structureRepair',
        'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    tableRepair: Object.freeze([
        'methodRepair', 'structureRepair', 'coreSummaryRepair',
        'scoringAudit', 'imageSupplement'
    ]),
    methodRepair: Object.freeze([
        'structureRepair', 'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    structureRepair: Object.freeze(['coreSummaryRepair', 'scoringAudit', 'imageSupplement']),
    coreSummaryRepair: Object.freeze(['scoringAudit', 'imageSupplement']),
    scoringAudit: Object.freeze(['imageSupplement']),
    apiReaderArticle: Object.freeze(['imageSupplement']),
    imageSupplement: Object.freeze([])
});

function recoveryInvalidationClosure(stage) {
    const closure = new Set([stage]);
    const pending = [stage];
    while (pending.length) {
        const current = pending.shift();
        for (const dependent of RECOVERY_STAGE_DEPENDENCIES[current] || []) {
            if (closure.has(dependent)) continue;
            closure.add(dependent);
            pending.push(dependent);
        }
    }
    return RECOVERY_STAGE_ORDER.filter(item => closure.has(item));
}

const RECOVERY_PROMPT_FILES = Object.freeze({
    primaryAnalysis: 'prompts/deep-analysis.md',
    openSourceScan: 'prompts/opensource-scan.md',
    revision: 'prompts/gap-fill.md',
    tableRepair: 'prompts/table-fill.md',
    methodRepair: 'prompts/method-fill.md',
    coreSummaryRepair: 'prompts/core-summary-repair.md',
    structureRepair: 'prompts/structure-repair.md',
    scoringAudit: 'prompts/scoring-audit.md',
    apiReaderArticle: 'prompts/api-reader-article.md',
    imageSupplement: 'prompts/image-supplement.md'
});

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function runtimePromptTemplateSha256(relativePath, contractVersion = '') {
    const content = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    const blockMatch = content.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m);
    if (!blockMatch) throw new Error(`Prompt 文件 ${relativePath} 中未找到 fenced code block`);
    return crypto.createHash('sha256')
        .update(JSON.stringify({
            runtimePrompt: blockMatch[2],
            contractVersion: String(contractVersion || '')
        }))
        .digest('hex');
}

function promptTemplateSha256(relativePath, contractVersion = '') {
    if (/\.md$/i.test(relativePath)) {
        return runtimePromptTemplateSha256(relativePath, contractVersion);
    }
    return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', relativePath)))
        .digest('hex');
}

// One-time, exact allowlist for checkpoints produced immediately before the
// core-summary-detailed-v3 rollout.  Those prompts differ semantically only in
// the summary contract; all other old prompt bytes must replay exactly or the
// migration refuses them.  Never broaden this map to "any previous hash".
const CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256 = Object.freeze({
    primaryAnalysis: '9b9197cdbb7c76cc6e2147f778eb425ab549262532dde06a01984cc9d2a9b5f5',
    openSourceScan: '1c043d793104a9c4cb5895dc691a1ce8a14685754ec8524e544b8f400bc0cc09',
    revision: '0ba287c48f4121644fef5bd51e462dca944d558e43aa710fa3390a430b4ae58b',
    tableRepair: '812fd6eed30d334fcfa7c231d3ce837176212c93de116d229f57fedeeae63c92',
    methodRepair: 'cc2a767c82cbcae776660626d2f009bd2a8d99494e81e526f6cdfeb306aceaf6',
    coreSummaryRepair: '25c569ed7c3d256035f544a341c8ba66fe0b0687ef1fdc24ed21e19138bc99be',
    structureRepair: 'cf2348d480306533078ba4ca80d9b9df6c6106fbd484370609748b66ce8ffcef'
});
const CORE_SUMMARY_V3_EXPECTED_RUNTIME_PROMPT_SHA256 = Object.freeze({
    primaryAnalysis: 'b06aeb750592c48ac5ffcbcf422118d693f261449e3be561c2f097dbc84dd8bf',
    openSourceScan: 'b925fc8b00ca3758636b1a571c3f9024c0b0f80e25cd6014ed987b98254f672b',
    revision: '8689694ecfe88420eb4c75de47ac488aeab24f9c1868cba49f8a7cec70b39fe6',
    tableRepair: '9730b06e94a33a9bd6c4c171b09dddafaaf14a1c1dcf082cbf28acbe9c3b68f3',
    methodRepair: 'e366628bab5fe93b5442e2aa34a5bf602d8bcce36d5c955dee4a49d2ee3e8815',
    coreSummaryRepair: '56482dad912a3f2170fbbed2105107a4393a59040e9d099517a65e7c82200f1f',
    structureRepair: '47f6f5028e2e110c0dc6ce237304b89a118ae6385d7981d003cf67fee66ea733'
});
const LEGACY_CORE_SUMMARY_RECOVERY_ORDER = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
    'methodRepair', 'coreSummaryRepair', 'structureRepair', 'scoringAudit',
    'apiReaderArticle', 'imageSupplement'
]);
const STALE_ANALYSIS_SNAPSHOT_CONTRACT = 'stale-analysis-snapshot-v1';

function buildLegacyCoreSummaryV2PrimaryFingerprint(paper, textForAnalysis, arxivId) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG),
        promptTemplateSha256: CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256.primaryAnalysis,
        usedTextSha256: crypto.createHash('sha256').update(textForAnalysis).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        fullTextMaxChars: FULL_TEXT_MAX_CHARS,
        arxivId,
        title: paper.title || '',
        authors: paper.authors || [],
        categories: paper.categories || []
    });
}

function buildLegacyCoreSummaryV2TextFingerprint(stage, inputAnalysis, evidenceContext) {
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    const legacyPromptSha256 = CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256[stage];
    if (!config || !legacyPromptSha256) throw new Error(`没有 ${stage} 的 v2 摘要迁移 allowlist`);
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity();
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_TEMPERATURE, config.maxTokens),
        promptTemplateSha256: legacyPromptSha256,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: config.evidenceMaxChars,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        inputAnalysisSha256: crypto.createHash('sha256').update(String(inputAnalysis || '')).digest('hex'),
        ...(stage === 'structureRepair'
            ? {
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                editorialLeakageContractVersion: ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION
            }
            : {}),
        ...(stage === 'methodRepair'
            ? { methodDetailContractVersion: METHOD_DETAIL_CONTRACT_VERSION }
            : {})
    });
}


function modelFingerprint(config, temperature = API_TEMPERATURE, maxTokens = API_MAX_TOKENS) {
    return {
        model: config.model || '',
        endpoint: config.endpoint || '',
        protocol: detectApiType(config.endpoint || '', config.model || ''),
        temperature,
        maxTokens,
        maxResponseBytes: Number.isInteger(config.maxResponseBytes) && config.maxResponseBytes > 0
            ? config.maxResponseBytes
            : API_MAX_RESPONSE_BYTES
    };
}

const TEXT_RECOVERY_STAGE_CONFIG = Object.freeze({
    openSourceScan: {
        maxTokens: 8000,
        evidenceMaxChars: OPEN_SOURCE_EVIDENCE_MAX_CHARS,
        patterns: OPEN_SOURCE_EVIDENCE_PATTERNS,
        taskLabel: 'OPEN_SOURCE',
        typeAware: false,
        sanitize: true
    },
    revision: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: REVISION_EVIDENCE_MAX_CHARS,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: 'REVISION',
        typeAware: false
    },
    tableRepair: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS,
        patterns: RESULT_EVIDENCE_PATTERNS,
        taskLabel: 'RESULT',
        typeAware: true
    },
    methodRepair: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS,
        patterns: METHOD_EVIDENCE_PATTERNS,
        taskLabel: 'METHOD',
        typeAware: true
    },
    coreSummaryRepair: {
        maxTokens: 2500,
        evidenceMaxChars: 24000,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: 'CORE_SUMMARY',
        typeAware: false
    },
    structureRepair: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: STRUCTURE_EVIDENCE_MAX_CHARS,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: 'STRUCTURE',
        typeAware: true
    }
});

function buildStageEvidenceContext(stage, analysis, sourceText) {
    if (stage === 'scoringAudit') {
        return buildTypeAwareSourceContext(
            analysis,
            sourceText,
            SCORING_EVIDENCE_MAX_CHARS,
            SCORING_EVIDENCE_PATTERNS,
            'SCORING'
        );
    }
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    if (!config) throw new Error(`未知的文本恢复阶段: ${stage}`);
    const evidence = config.typeAware
        ? buildTypeAwareSourceContext(
            analysis,
            sourceText,
            config.evidenceMaxChars,
            config.patterns,
            config.taskLabel
        )
        : buildTaskEvidenceContext(
            sourceText,
            config.evidenceMaxChars,
            config.patterns,
            config.taskLabel
        );
    return config.sanitize ? sanitizeOpenSourceEvidence(evidence) : evidence;
}

function buildTextStageFingerprint(stage, inputAnalysis, evidenceContext) {
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    if (!config) throw new Error(`未知的文本恢复阶段: ${stage}`);
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity();
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_TEMPERATURE, config.maxTokens),
        promptTemplateSha256: promptTemplateSha256(
            RECOVERY_PROMPT_FILES[stage],
            stage === 'coreSummaryRepair' ? CORE_SUMMARY_CONTRACT_VERSION : ''
        ),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: config.evidenceMaxChars,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        inputAnalysisSha256: crypto.createHash('sha256').update(String(inputAnalysis || '')).digest('hex'),
        ...(stage === 'structureRepair'
            ? {
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                editorialLeakageContractVersion: ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION
            }
            : {}),
        ...(stage === 'methodRepair'
            ? { methodDetailContractVersion: METHOD_DETAIL_CONTRACT_VERSION }
            : {})
    });
}

function getTextStageInputAnalysis(paper, stage, currentAnalysis) {
    const index = RECOVERY_STAGE_ORDER.indexOf(stage);
    // Optional stages may be introduced without invalidating historical
    // manifests. Walk backward to the nearest actual checkpoint rather than
    // assuming the immediately preceding stage existed in that older run.
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = paper.analysisStageCheckpoints?.[RECOVERY_STAGE_ORDER[candidate]];
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return String(currentAnalysis || '');
}

function previousStageCheckpoint(paper, stage) {
    const index = RECOVERY_STAGE_ORDER.indexOf(stage);
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = paper.analysisStageCheckpoints?.[RECOVERY_STAGE_ORDER[candidate]];
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return null;
}

function prepareTextRecoveryStage(paper, manifest, stage, currentAnalysis, sourceText) {
    const inputAnalysis = getTextStageInputAnalysis(paper, stage, currentAnalysis);
    const evidenceContext = buildStageEvidenceContext(stage, inputAnalysis, sourceText);
    const fingerprint = buildTextStageFingerprint(stage, inputAnalysis, evidenceContext);
    const evidenceSha256 = crypto.createHash('sha256').update(evidenceContext).digest('hex');
    const inputAnalysisSha256 = crypto.createHash('sha256').update(inputAnalysis).digest('hex');
    const compatibilityReused = stage === 'structureRepair'
        && legacyStructureCompatibilityIsValid(paper, manifest, sourceText);
    const invalidated = compatibilityReused
        ? false : invalidateRecoveryStageIfChanged(paper, manifest, stage, fingerprint);
    return {
        analysis: invalidated && typeof paper.analysisCheckpoint === 'string'
            ? paper.analysisCheckpoint
            : currentAnalysis,
        inputAnalysis,
        evidenceContext,
        evidenceChars: evidenceContext.length,
        evidenceSha256,
        inputAnalysisSha256,
        fingerprint: compatibilityReused ? manifest.stages[stage].fingerprint : fingerprint,
        compatibilityReused,
        invalidated
    };
}

function buildRecoveryFingerprints(paper, textForAnalysis, arxivId) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    const usedTextSha256 = crypto.createHash('sha256').update(textForAnalysis).digest('hex');
    const primaryContext = {
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG),
        promptTemplateSha256: promptTemplateSha256(
            RECOVERY_PROMPT_FILES.primaryAnalysis,
            CORE_SUMMARY_CONTRACT_VERSION
        ),
        usedTextSha256,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        fullTextMaxChars: FULL_TEXT_MAX_CHARS,
        arxivId,
        title: paper.title || '',
        authors: paper.authors || [],
        categories: paper.categories || []
    };
    return {
        primaryAnalysis: stableFingerprint(primaryContext),
        demoLinkScan: stableFingerprint({ implementation: 'demo-link-scan-v2-resource-identity' }),
        apiReaderArticle: stableFingerprint({
            ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
            ...modelFingerprint(DEEP_CONFIG, API_READER_INITIAL_TEMPERATURE, API_READER_MAX_TOKENS),
            contract: API_READER_ARTICLE_CONTRACT,
            contentMode: READER_SOURCE_CONTENT_MODE,
            planVersion: API_READER_PLAN_VERSION,
            parserVersion: API_READER_PARSER_VERSION,
            assemblerVersion: API_READER_ASSEMBLER_VERSION,
            tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
            figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
            qualityMetricsContractVersion: API_READER_QUALITY_METRICS_CONTRACT,
            sourceBindingsContractVersion: API_READER_SOURCE_BINDING_CONTRACT,
            sourceBindingRepairVersion: API_READER_SOURCE_BINDING_REPAIR_VERSION,
            surfaceRepairVersion: API_READER_SURFACE_REPAIR_VERSION,
            mechanicalContractVersion: READER_MECHANICAL_CONTRACT,
            mechanicalContractImplementationSha256: promptTemplateSha256('scripts/lib/reader-contract.js'),
            tableSelectionContractVersion: READER_TABLE_SELECTION_CONTRACT,
            tableSelectionImplementationSha256: promptTemplateSha256('scripts/lib/reader-tables.js'),
            sectionQualityContractVersion: READER_SECTION_QUALITY_CONTRACT,
            authorIdentityContractVersion: API_READER_AUTHOR_IDENTITY_CONTRACT,
            resourceIdentityContractVersion: API_READER_RESOURCE_IDENTITY_CONTRACT,
            imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
            imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
            promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.apiReaderArticle),
            repairPromptSha256: promptTemplateSha256('prompts/api-reader-repair.md'),
            repairImplementationSha256: promptTemplateSha256('scripts/lib/reader-repair.js'),
            draftOrderContract: READER_DRAFT_ORDER_CONTRACT,
            draftOrderImplementationSha256: promptTemplateSha256('scripts/lib/reader-draft-order.js'),
            sourceDiagnosticsImplementationSha256: promptTemplateSha256('scripts/lib/reader-source-diagnostics.js'),
            repairMaxTokens: ANALYSIS_CONFIG.apiReaderRepairMaxTokens || 8000,
            repairTemperature: API_READER_REPAIR_TEMPERATURE,
            maximumContentAttempts: 6,
            evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
            evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
            contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
            overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
            transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES
        }),
        imageSupplement: stableFingerprint({
            ...modelFingerprint(SECONDARY_CONFIG, IMAGE_PLAN_TEMPERATURE, API_MAX_TOKENS),
            enabled: isDualModel,
            promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.imageSupplement),
            imageCandidateMax: IMAGE_CANDIDATE_MAX,
            imageMaxCount: IMAGE_MAX_COUNT,
            imageMaxBytes: IMAGE_MAX_BYTES,
            imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
            imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
            imageInsertionMax: IMAGE_INSERTION_MAX
        })
    };
}

function buildImageSupplementFingerprint(baseFingerprint, candidateImageInfos, downloadedImages, preImageAnalysis) {
    return stableFingerprint({
        configurationFingerprint: baseFingerprint,
        candidates: (candidateImageInfos || []).map(info => ({
            url: info.url || '',
            caption: info.caption || ''
        })),
        downloads: (downloadedImages || []).map(image => ({
            url: image.url || '',
            sha256: image.sha256 || ''
        })),
        preImageAnalysisSha256: crypto.createHash('sha256').update(String(preImageAnalysis || '')).digest('hex')
    });
}

function buildApiReaderExecutionFingerprint(baseFingerprint, evidenceContext, structuredArtifacts) {
    return stableFingerprint({
        configurationFingerprint: baseFingerprint,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        structuredArtifactsSha256: structuredArtifacts?.payloadSha256 || ''
    });
}

function buildLegacyAnalysisBoundApiReaderFingerprint(
    baseFingerprint, analysis, evidenceContext, structuredArtifacts
) {
    return buildLegacyAnalysisShaBoundApiReaderFingerprint(
        baseFingerprint,
        crypto.createHash('sha256').update(String(analysis || '')).digest('hex'),
        evidenceContext,
        structuredArtifacts
    );
}

function buildLegacyAnalysisShaBoundApiReaderFingerprint(
    baseFingerprint, analysisSha256, evidenceContext, structuredArtifacts
) {
    return stableFingerprint({
        configurationFingerprint: baseFingerprint,
        analysisSha256,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        structuredArtifactsSha256: structuredArtifacts?.payloadSha256 || ''
    });
}

const LEGACY_API_READER_V3_IDENTITY_SHA256 = Object.freeze({
    promptTemplateSha256: '4c686f8fd83f5a68b528c930b8393d7f8dc8ba27549ce4faf9ac885d84eec35d',
    repairPromptSha256: '26c091a711a706fa69dfdd3ad31bb72c766faea111fd6322d4c2202d96eeb8e8',
    mechanicalContractImplementationSha256: '246f7c730e902c7f4334fd92ea2c2b5d47fb8f3dec5a1d2cdd6df253b91ca7de',
    tableSelectionImplementationSha256: 'bddec71ce9a6e08780b483c74bafb877bbfab8738739c8c23b89c8350fa55b6e',
    repairImplementationSha256: 'a0b84c2be19351e3cdd2cebae28110f00e7e965cd290820f45b5f98bedf06b58',
    draftOrderImplementationSha256: '2d7bfffab4db31ba88bfea0c991082d4b509ee96016a00004935eb9c658873e9',
    sourceDiagnosticsImplementationSha256: 'f108d112d42495f5f562b796d1cc16d550b1050c66b1438bf2f15ebfa1621283'
});

function buildLegacyApiReaderV3ConfigurationFingerprint(arxivId) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_READER_INITIAL_TEMPERATURE, API_READER_MAX_TOKENS),
        contract: API_READER_ARTICLE_CONTRACT,
        contentMode: READER_SOURCE_CONTENT_MODE,
        planVersion: API_READER_PLAN_VERSION,
        parserVersion: API_READER_PARSER_VERSION,
        assemblerVersion: API_READER_ASSEMBLER_VERSION,
        tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
        figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
        qualityMetricsContractVersion: API_READER_QUALITY_METRICS_CONTRACT,
        sourceBindingsContractVersion: API_READER_SOURCE_BINDING_CONTRACT,
        sourceBindingRepairVersion: API_READER_SOURCE_BINDING_REPAIR_VERSION,
        surfaceRepairVersion: API_READER_SURFACE_REPAIR_VERSION,
        mechanicalContractVersion: READER_MECHANICAL_CONTRACT,
        mechanicalContractImplementationSha256:
            LEGACY_API_READER_V3_IDENTITY_SHA256.mechanicalContractImplementationSha256,
        tableSelectionContractVersion: READER_TABLE_SELECTION_CONTRACT,
        tableSelectionImplementationSha256:
            LEGACY_API_READER_V3_IDENTITY_SHA256.tableSelectionImplementationSha256,
        sectionQualityContractVersion: READER_SECTION_QUALITY_CONTRACT,
        authorIdentityContractVersion: API_READER_AUTHOR_IDENTITY_CONTRACT,
        resourceIdentityContractVersion: API_READER_RESOURCE_IDENTITY_CONTRACT,
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        promptTemplateSha256: LEGACY_API_READER_V3_IDENTITY_SHA256.promptTemplateSha256,
        repairPromptSha256: LEGACY_API_READER_V3_IDENTITY_SHA256.repairPromptSha256,
        repairImplementationSha256:
            LEGACY_API_READER_V3_IDENTITY_SHA256.repairImplementationSha256,
        draftOrderContract: READER_DRAFT_ORDER_CONTRACT,
        draftOrderImplementationSha256:
            LEGACY_API_READER_V3_IDENTITY_SHA256.draftOrderImplementationSha256,
        sourceDiagnosticsImplementationSha256:
            LEGACY_API_READER_V3_IDENTITY_SHA256.sourceDiagnosticsImplementationSha256,
        repairMaxTokens: ANALYSIS_CONFIG.apiReaderRepairMaxTokens || 8000,
        repairTemperature: API_READER_REPAIR_TEMPERATURE,
        maximumContentAttempts: 6,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
        contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
        overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
        transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES
    });
}

function migrateSourceOnlyApiReaderFingerprint(
    paper, manifest, currentFingerprint, legacyFingerprint
) {
    const stage = manifest?.stages?.apiReaderArticle;
    if (!isRecoveryStageComplete(manifest, 'apiReaderArticle')
        || stage.fingerprint !== legacyFingerprint) return false;
    // This replays every production SHA/source-binding/author/resource proof;
    // changing only a now-removed artificial analysis dependency is safe only
    // when the stored Reader itself is still fully publishable.
    if (!require('./analysis-engine.js').apiReaderV3BindsCanonical(paper)) return false;
    const migration = {
        contract: 'api-reader-source-only-fingerprint-migration-v1',
        previousFingerprint: legacyFingerprint,
        currentFingerprint,
        articleSha256: stage.articleSha256,
        planSha256: stage.planSha256,
        migratedAt: getBeijingISOString()
    };
    stage.fingerprint = currentFingerprint;
    stage.identityMigration = {
        ...migration,
        migrationSha256: stableFingerprint(migration)
    };
    return true;
}

function migrateSealedSourceOnlyReaderBeforeAnalysis(
    paper, manifest, baseFingerprint, sourceText, structuredArtifacts, arxivId
) {
    if (typeof paper?.analysis !== 'string' || !paper.analysis.trim()) return false;
    const evidence = buildApiReaderEvidenceContext(
        paper.analysis, sourceText, structuredArtifacts, arxivId
    );
    const legacyFingerprint = buildLegacyAnalysisBoundApiReaderFingerprint(
        buildLegacyApiReaderV3ConfigurationFingerprint(arxivId),
        paper.analysis,
        evidence,
        structuredArtifacts
    );
    const currentFingerprint = buildApiReaderExecutionFingerprint(
        baseFingerprint, evidence, structuredArtifacts
    );
    return migrateSourceOnlyApiReaderFingerprint(
        paper, manifest, currentFingerprint, legacyFingerprint
    );
}

function hasActualAnalysisInputChanged(previousSource, currentSource) {
    return ['sourceSha256', 'usedTextSha256', 'sourceId', 'analysisSource']
        .some(field => previousSource?.[field] !== currentSource?.[field]);
}

function shouldRetainFullTextCheckpoint(paper, previousSource, hasFullText, sourceFetchError) {
    return Boolean(paper?.analysisCheckpoint
        && previousSource?.fullTextAvailable
        && !hasFullText
        && sourceFetchError);
}

function invalidateSourceBoundImageRecovery(paper) {
    delete paper.analysisRecoveryImageManifest;
    delete paper.imageManifest;
    delete paper.selectedImageUrls;
    delete paper.imageUrls;
    delete paper.allImageUrls;
}

function classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure) {
    return htmlAvailability === 'transient_failure' || pdfHadTransientFailure
        ? 'transient'
        : 'permanent';
}

function isTransientDemoHttpStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function discardInvalidImageSupplement(preImageAnalysis, imageManifest, imageResult, reason) {
    imageManifest.selected = [];
    imageManifest.supplement = {
        ...imageResult.supplementDiagnostics,
        parseDiagnostics: imageResult.parseDiagnostics,
        discardedInvalidPlan: true,
        discardedReason: reason
    };
    return { analysis: preImageAnalysis, selectedImageUrls: [] };
}

function classifyImageDiscoveryStatus(imageInfos, error = null) {
    if (error) return 'transient_failure';
    return Array.isArray(imageInfos) && imageInfos.length > 0 ? 'complete' : 'no_candidates';
}

function persistImageDiscoveryFailure(
    paper,
    sourceProvenance,
    sourceWarnings,
    analysisManifest,
    imageManifest,
    discoveryError
) {
    saveAnalysisCheckpoint(paper, paper.analysisCheckpoint || '', analysisManifest, imageManifest);
    const error = `图片发现瞬时失败，等待正常重试: ${discoveryError.message}`;
    return {
        ...paper,
        ...sourceProvenance,
        sourceWarnings: [...sourceWarnings, error],
        analysis: null,
        parsed: null,
        imageManifest,
        analysisManifest,
        analysisCheckpoint: paper.analysisCheckpoint,
        error
    };
}

function calculateScoringDelta(previousParsedScore, scoringInputAnalysis, finalParsedScore) {
    const previousScore = Number.parseFloat(previousParsedScore);
    const scoringInputScore = Number.parseFloat(parseAnalysis(scoringInputAnalysis)?.score);
    const finalScore = Number.parseFloat(finalParsedScore);
    const scoreBeforeAudit = Number.isFinite(scoringInputScore) ? scoringInputScore : previousScore;
    return {
        previousRunScore: Number.isFinite(previousScore) ? previousScore : null,
        previousScore: Number.isFinite(scoreBeforeAudit) ? scoreBeforeAudit : null,
        finalScore: Number.isFinite(finalScore) ? finalScore : null,
        scoreDelta: Number.isFinite(scoreBeforeAudit) && Number.isFinite(finalScore)
            ? Number((finalScore - scoreBeforeAudit).toFixed(1))
            : null
    };
}

function staleAnalysisSnapshotPayload(paper, manifest) {
    const checkpoint = typeof paper?.analysisCheckpoint === 'string'
        ? paper.analysisCheckpoint : '';
    const stageCheckpoints = paper?.analysisStageCheckpoints
        && typeof paper.analysisStageCheckpoints === 'object'
        ? structuredClone(paper.analysisStageCheckpoints) : {};
    if (!checkpoint && Object.keys(stageCheckpoints).length === 0) return null;
    return {
        analysisCheckpoint: checkpoint,
        analysisStageCheckpoints: stageCheckpoints,
        stages: structuredClone(manifest?.stages || {}),
        contracts: structuredClone(manifest?.contracts || {})
    };
}

function captureStaleAnalysisSnapshot(paper, manifest, invalidatedStage, replacementFingerprint) {
    const payload = staleAnalysisSnapshotPayload(paper, manifest);
    if (!payload) return null;
    const payloadSha256 = stableFingerprint(payload);
    const existing = Array.isArray(paper.analysisStaleSnapshots)
        ? paper.analysisStaleSnapshots.filter(item => item
            && item.contract === STALE_ANALYSIS_SNAPSHOT_CONTRACT
            && /^[a-f0-9]{64}$/.test(String(item.payloadSha256 || ''))
            && validateStaleAnalysisSnapshot(item))
        : [];
    if (!existing.some(item => item.payloadSha256 === payloadSha256)) {
        existing.push({
            contract: STALE_ANALYSIS_SNAPSHOT_CONTRACT,
            invalidatedStage,
            replacementFingerprint,
            previousFingerprint: manifest?.stages?.[invalidatedStage]?.fingerprint || '',
            payload,
            payloadSha256,
            capturedAt: getBeijingISOString()
        });
    }
    paper.analysisStaleSnapshots = existing.slice(-2);
    return paper.analysisStaleSnapshots.at(-1) || null;
}

function validateStaleAnalysisSnapshot(snapshot) {
    if (!snapshot || snapshot.contract !== STALE_ANALYSIS_SNAPSHOT_CONTRACT
        || !snapshot.payload || typeof snapshot.payload !== 'object' || Array.isArray(snapshot.payload)
        || snapshot.payloadSha256 !== stableFingerprint(snapshot.payload)
        || typeof snapshot.payload.analysisCheckpoint !== 'string'
        || !snapshot.payload.analysisStageCheckpoints
        || typeof snapshot.payload.analysisStageCheckpoints !== 'object'
        || Array.isArray(snapshot.payload.analysisStageCheckpoints)
        || !snapshot.payload.stages || typeof snapshot.payload.stages !== 'object'
        || Array.isArray(snapshot.payload.stages)
        || !snapshot.payload.contracts || typeof snapshot.payload.contracts !== 'object'
        || Array.isArray(snapshot.payload.contracts)) {
        return null;
    }
    return structuredClone(snapshot.payload);
}

function coreSummaryV3MigrationPromptSetIsAllowed(observed) {
    return Object.keys(CORE_SUMMARY_V3_EXPECTED_RUNTIME_PROMPT_SHA256).every(stage => (
        observed?.[stage] === CORE_SUMMARY_V3_EXPECTED_RUNTIME_PROMPT_SHA256[stage]
    ));
}

function currentCoreSummaryV3MigrationPromptsAreExact() {
    const observed = Object.fromEntries([
        ['primaryAnalysis', RECOVERY_PROMPT_FILES.primaryAnalysis, CORE_SUMMARY_CONTRACT_VERSION],
        ['openSourceScan', RECOVERY_PROMPT_FILES.openSourceScan, ''],
        ['revision', RECOVERY_PROMPT_FILES.revision, ''],
        ['tableRepair', RECOVERY_PROMPT_FILES.tableRepair, ''],
        ['methodRepair', RECOVERY_PROMPT_FILES.methodRepair, ''],
        ['coreSummaryRepair', RECOVERY_PROMPT_FILES.coreSummaryRepair, CORE_SUMMARY_CONTRACT_VERSION],
        ['structureRepair', RECOVERY_PROMPT_FILES.structureRepair, '']
    ].map(([stage, file, contract]) => [
        stage, runtimePromptTemplateSha256(file, contract)
    ]));
    return coreSummaryV3MigrationPromptSetIsAllowed(observed);
}

function getLegacyStageInput(stage, checkpoints, fallback = '') {
    const index = LEGACY_CORE_SUMMARY_RECOVERY_ORDER.indexOf(stage);
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = checkpoints?.[LEGACY_CORE_SUMMARY_RECOVERY_ORDER[candidate]];
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return String(fallback || '');
}

function buildLegacyCoreSummaryV2EvidenceContext(stage, inputAnalysis, sourceText) {
    if (stage !== 'coreSummaryRepair') {
        return buildStageEvidenceContext(stage, inputAnalysis, sourceText);
    }
    const config = TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair;
    // v2 used the type-aware default branch, which included canonical analysis
    // excerpts. Reconstruct it only to authenticate the old checkpoint; new
    // summary authoring is source-only.
    return buildTypeAwareSourceContext(inputAnalysis, sourceText, config.evidenceMaxChars,
        config.patterns, config.taskLabel);
}

const LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT = 'core-summary-v3-legacy-structure-reuse-v1';

function makeLegacyStructureCompatibilityProof(
    stage, legacyInput, output, sourceText, migrationAudit, legacySnapshotPayloadSha256
) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(
        migrationAudit.paperId
    );
    const body = {
        contract: LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT,
        legacyStageFingerprint: stage.fingerprint,
        legacyInputAnalysisSha256: crypto.createHash('sha256').update(legacyInput).digest('hex'),
        outputAnalysisSha256: crypto.createHash('sha256').update(output).digest('hex'),
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        currentStructurePromptSha256: runtimePromptTemplateSha256(RECOVERY_PROMPT_FILES.structureRepair),
        freshIdentitySha256: stableFingerprint(freshIdentity),
        migrationAuditSha256: migrationAudit.auditSha256,
        legacySnapshotPayloadSha256
    };
    return { ...body, proofSha256: stableFingerprint(body) };
}

function legacyStructureCompatibilityIsValid(paper, manifest, sourceText) {
    const stage = manifest?.stages?.structureRepair;
    const proof = stage?.compatibilityProof;
    if (!proof || proof.contract !== LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT) return false;
    const { proofSha256, ...body } = proof;
    const output = paper?.analysisStageCheckpoints?.structureRepair;
    const migrationAudit = (manifest?.compatibilityMigrations || []).find(item => (
        item?.contract === 'core-summary-v3-primary-checkpoint-migration-v1'
        && item.auditSha256 === proof.migrationAuditSha256
    ));
    const auditBody = migrationAudit && { ...migrationAudit };
    if (auditBody) delete auditBody.auditSha256;
    const stalePayloads = (paper?.analysisStaleSnapshots || [])
        .map(validateStaleAnalysisSnapshot).filter(Boolean);
    const legacyInput = stalePayloads.filter(payload => (
        stableFingerprint(payload) === proof.legacySnapshotPayloadSha256
    )).map(payload => ({
        payload,
        input: getLegacyStageInput(
            'structureRepair', payload.analysisStageCheckpoints, payload.analysisCheckpoint
        )
    })).find(item => (
        item.payload.stages?.structureRepair?.fingerprint === proof.legacyStageFingerprint
        && crypto.createHash('sha256').update(item.input).digest('hex')
            === proof.legacyInputAnalysisSha256
    ));
    const freshIdentity = migrationAudit
        ? require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(migrationAudit.paperId)
        : null;
    return Boolean(proofSha256 === stableFingerprint(body)
        && migrationAudit && migrationAudit.auditSha256 === stableFingerprint(auditBody)
        && legacyInput
        && stage.fingerprint === proof.legacyStageFingerprint
        && crypto.createHash('sha256').update(String(output || '')).digest('hex')
            === proof.outputAnalysisSha256
        && crypto.createHash('sha256').update(String(sourceText || '')).digest('hex')
            === proof.sourceTextSha256
        && proof.currentStructurePromptSha256
            === runtimePromptTemplateSha256(RECOVERY_PROMPT_FILES.structureRepair)
        && proof.freshIdentitySha256 === stableFingerprint(freshIdentity)
        && manifest?.sourceAcquisition?.sourceSha256 === proof.sourceTextSha256
        && getRepairableAnalysisStructureIssues(output, { sourceText }).length === 0);
}

function tryMigrateCoreSummaryV3LegacyCheckpoints(
    paper, manifest, textForAnalysis, sourceText, arxivId, currentPrimaryFingerprint
) {
    if (!currentCoreSummaryV3MigrationPromptsAreExact()) return false;
    const requiredTextStages = [
        'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
        'coreSummaryRepair', 'structureRepair'
    ];
    const compatible = candidatePayload => {
        if (!candidatePayload) return false;
        const stages = candidatePayload.stages;
        const checkpoints = candidatePayload.analysisStageCheckpoints;
        if (!candidatePayload.analysisCheckpoint
            || !isRecoveryStageComplete({ stages }, 'primaryAnalysis')
            || stages.primaryAnalysis.fingerprint !== buildLegacyCoreSummaryV2PrimaryFingerprint(
                paper, textForAnalysis, arxivId
            )
            || typeof checkpoints.primaryAnalysis !== 'string'
            || checkpoints.primaryAnalysis.length < 100
            || !isRecoveryStageComplete({ stages }, 'demoLinkScan')
            || stages.demoLinkScan.fingerprint !== stableFingerprint({
                implementation: 'demo-link-scan-v2-resource-identity'
            })) return false;
        for (const stage of requiredTextStages) {
            if (!isRecoveryStageComplete({ stages }, stage)
                || typeof checkpoints[stage] !== 'string') return false;
            const input = getLegacyStageInput(stage, checkpoints, candidatePayload.analysisCheckpoint);
            const evidence = buildLegacyCoreSummaryV2EvidenceContext(stage, input, sourceText);
            if (stages[stage].fingerprint
                !== buildLegacyCoreSummaryV2TextFingerprint(stage, input, evidence)) return false;
        }
        const structureAnalysis = checkpoints.structureRepair;
        return getRepairableAnalysisStructureIssues(structureAnalysis, { sourceText }).length === 0;
    };
    const candidates = [{ payload: staleAnalysisSnapshotPayload(paper, manifest), restored: false },
        ...(Array.isArray(paper.analysisStaleSnapshots) ? paper.analysisStaleSnapshots.slice().reverse() : [])
            .map(validateStaleAnalysisSnapshot).filter(Boolean)
            .map(payload => ({ payload, restored: true }))];
    const selected = candidates.find(candidate => compatible(candidate.payload));
    if (!selected) return false;
    const candidatePayload = selected.payload;
    const restoredFromSnapshot = selected.restored;
    const stages = candidatePayload.stages;
    const checkpoints = candidatePayload.analysisStageCheckpoints;
    const structureAnalysis = checkpoints.structureRepair;

    if (restoredFromSnapshot) {
        paper.analysisCheckpoint = candidatePayload.analysisCheckpoint;
        paper.analysisStageCheckpoints = structuredClone(checkpoints);
        manifest.stages = structuredClone(stages);
        manifest.contracts = structuredClone(candidatePayload.contracts || {});
    }
    const legacyPrimaryFingerprint = manifest.stages.primaryAnalysis.fingerprint;
    manifest.stages.primaryAnalysis.fingerprint = currentPrimaryFingerprint;
    for (const stage of ['openSourceScan', 'revision', 'tableRepair', 'methodRepair']) {
        const input = getTextStageInputAnalysis(paper, stage, paper.analysisCheckpoint);
        const evidence = buildStageEvidenceContext(stage, input, sourceText);
        manifest.stages[stage].fingerprint = buildTextStageFingerprint(stage, input, evidence);
    }
    const legacyStructureInput = getLegacyStageInput(
        'structureRepair', checkpoints, candidatePayload.analysisCheckpoint);
    const migrationAuditBody = {
        contract: 'core-summary-v3-primary-checkpoint-migration-v1',
        paperId: arxivId,
        legacyPrimaryFingerprint,
        currentPrimaryFingerprint,
        restoredFromSnapshot,
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        structureCheckpointSha256: crypto.createHash('sha256')
            .update(structureAnalysis).digest('hex'),
        migratedAt: getBeijingISOString()
    };
    const migrationAudit = {
        ...migrationAuditBody,
        auditSha256: stableFingerprint(migrationAuditBody)
    };
    manifest.compatibilityMigrations = [
        ...(Array.isArray(manifest.compatibilityMigrations)
            ? manifest.compatibilityMigrations : []),
        migrationAudit
    ].slice(-4);
    manifest.stages.structureRepair.compatibilityProof = makeLegacyStructureCompatibilityProof(
        manifest.stages.structureRepair, legacyStructureInput, structureAnalysis, sourceText,
        migrationAudit, stableFingerprint(candidatePayload));
    manifest.stages.structureRepair.outputAnalysisSha256 = migrationAudit.structureCheckpointSha256;
    const coreInput = getTextStageInputAnalysis(paper, 'coreSummaryRepair', structureAnalysis);
    const coreEvidence = buildStageEvidenceContext('coreSummaryRepair', coreInput, sourceText);
    const currentCoreFingerprint = buildTextStageFingerprint(
        'coreSummaryRepair', coreInput, coreEvidence
    );
    invalidateRecoveryStageIfChanged(
        paper, manifest, 'coreSummaryRepair', currentCoreFingerprint
    );
    const migrationPayloadSha256 = stableFingerprint(candidatePayload);
    const migrationSnapshot = {
        contract: STALE_ANALYSIS_SNAPSHOT_CONTRACT,
        invalidatedStage: 'coreSummaryRepair',
        replacementFingerprint: currentCoreFingerprint,
        previousFingerprint: candidatePayload.stages.coreSummaryRepair.fingerprint,
        payload: structuredClone(candidatePayload),
        payloadSha256: migrationPayloadSha256,
        capturedAt: getBeijingISOString()
    };
    paper.analysisStaleSnapshots = [
        ...(paper.analysisStaleSnapshots || []).filter(item => (
            item?.payloadSha256 !== migrationPayloadSha256 && validateStaleAnalysisSnapshot(item)
        )).slice(-1),
        migrationSnapshot
    ];
    console.log('    [deep] ♻️  已严格复用 v2 主分析与结构 checkpoint，仅失效核心摘要及下游');
    return true;
}


function invalidateRecoveryStageIfChanged(paper, manifest, stage, fingerprint) {
    const current = manifest.stages?.[stage];
    if (!current || !isRecoveryStageComplete(manifest, stage) || current.fingerprint === fingerprint) return false;
    captureStaleAnalysisSnapshot(paper, manifest, stage, fingerprint);
    const stagesToDelete = RECOVERY_STAGE_DEPENDENCIES[stage]
        ? recoveryInvalidationClosure(stage) : [stage];
    const checkpoints = paper.analysisStageCheckpoints || {};
    const previousCheckpoint = previousStageCheckpoint(paper, stage);
    if (previousCheckpoint !== null) {
        paper.analysisCheckpoint = previousCheckpoint;
    } else {
        delete paper.analysisCheckpoint;
    }
    for (const recoveryStage of stagesToDelete) {
        delete manifest.stages[recoveryStage];
        delete checkpoints[recoveryStage];
    }
    if (stagesToDelete.includes('structureRepair') && manifest.contracts) {
        delete manifest.contracts.experimentTables;
        delete manifest.contracts.methodDetail;
        delete manifest.contracts.editorialLeakage;
        delete manifest.contracts.coreSummary;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (stagesToDelete.includes('coreSummaryRepair') && manifest.contracts) {
        delete manifest.contracts.coreSummary;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (stagesToDelete.includes('apiReaderArticle')) {
        delete paper.apiReaderArticle;
        delete paper.apiReaderPlan;
        delete paper.apiReaderFigures;
        delete paper.apiReaderAuthors;
        delete paper.apiReaderResources;
        delete paper.apiReaderArticleSha256;
        delete paper.apiReaderPlanSha256;
        if (manifest.contracts) {
            delete manifest.contracts.apiReaderArticle;
            if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
        }
    }
    if (stagesToDelete.includes('imageSupplement') && manifest.contracts) {
        delete manifest.contracts.imageNarrative;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    paper.analysisStageCheckpoints = checkpoints;
    console.log(`    [deep] ⚠️  ${stage} 指纹变化，已失效该阶段及下游恢复状态`);
    return true;
}

function createAnalysisRecoveryManifest(paper) {
    const existing = paper?.analysisManifest;
    const stages = existing && existing.version === RECOVERY_MANIFEST_VERSION && existing.stages && typeof existing.stages === 'object'
        ? { ...existing.stages }
        : {};
    const failedStages = RECOVERY_STAGE_ORDER.filter(stage => (
        stages[stage] && !isRecoveryStageComplete({ stages }, stage)
    ));
    for (const failedStage of failedStages) {
        for (const stage of recoveryInvalidationClosure(failedStage).filter(item => item !== failedStage)) {
            delete stages[stage];
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[stage];
        }
    }
    // 成功结果不会长期保存正文 checkpoint。强制重分析这类记录时，必须同时
    // 清除主分析及全部下游阶段，否则新正文会错误复用旧轮次的审校/评分状态。
    if (isRecoveryStageComplete({ stages }, 'primaryAnalysis') && !paper?.analysisCheckpoint) {
        for (const stage of recoveryInvalidationClosure('primaryAnalysis')) delete stages[stage];
        for (const stage of recoveryInvalidationClosure('primaryAnalysis')) {
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[stage];
        }
    }
    const keepTableContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.experimentTables === EXPERIMENT_TABLE_CONTRACT_VERSION;
    const keepMethodContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.methodDetail === METHOD_DETAIL_CONTRACT_VERSION;
    const keepEditorialLeakageContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.editorialLeakage === ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION;
    const keepCoreSummaryContract = isRecoveryStageComplete({ stages }, 'coreSummaryRepair')
        && existing?.contracts?.coreSummary === CORE_SUMMARY_CONTRACT_VERSION;
    const keepImageNarrativeContract = isRecoveryStageTerminal(
        'imageSupplement',
        stages.imageSupplement?.status
    ) && existing?.contracts?.imageNarrative === IMAGE_NARRATIVE_CONTRACT_VERSION;
    const keepApiReaderContract = isRecoveryStageComplete({ stages }, 'apiReaderArticle')
        && existing?.contracts?.apiReaderArticle === API_READER_ARTICLE_CONTRACT;
    if (isRecoveryStageComplete({ stages }, 'apiReaderArticle') && !keepApiReaderContract) {
        for (const stage of RECOVERY_STAGE_ORDER.slice(
            RECOVERY_STAGE_ORDER.indexOf('apiReaderArticle')
        )) {
            delete stages[stage];
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[stage];
        }
        delete paper.apiReaderArticle;
        delete paper.apiReaderPlan;
        delete paper.apiReaderFigures;
        delete paper.apiReaderAuthors;
        delete paper.apiReaderResources;
        delete paper.apiReaderArticleSha256;
        delete paper.apiReaderPlanSha256;
    }
    const contracts = existing?.contracts && typeof existing.contracts === 'object'
        ? { ...existing.contracts }
        : {};
    if (keepTableContract) contracts.experimentTables = EXPERIMENT_TABLE_CONTRACT_VERSION;
    else delete contracts.experimentTables;
    if (keepMethodContract) contracts.methodDetail = METHOD_DETAIL_CONTRACT_VERSION;
    else delete contracts.methodDetail;
    if (keepEditorialLeakageContract) {
        contracts.editorialLeakage = ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION;
    } else {
        delete contracts.editorialLeakage;
    }
    if (keepCoreSummaryContract) contracts.coreSummary = CORE_SUMMARY_CONTRACT_VERSION;
    else delete contracts.coreSummary;
    if (keepImageNarrativeContract) contracts.imageNarrative = IMAGE_NARRATIVE_CONTRACT_VERSION;
    else delete contracts.imageNarrative;
    if (keepApiReaderContract) contracts.apiReaderArticle = API_READER_ARTICLE_CONTRACT;
    else delete contracts.apiReaderArticle;
    return {
        version: RECOVERY_MANIFEST_VERSION,
        stages,
        ...(Object.keys(contracts).length > 0 ? { contracts } : {}),
        ...(existing?.sourceAcquisition ? { sourceAcquisition: { ...existing.sourceAcquisition } } : {}),
        ...(existing?.sourceAcquisitionLatestFailure
            ? { sourceAcquisitionLatestFailure: { ...existing.sourceAcquisitionLatestFailure } }
            : {}),
        ...(Array.isArray(existing?.compatibilityMigrations)
            ? { compatibilityMigrations: structuredClone(existing.compatibilityMigrations).slice(-4) }
            : {}),
        updatedAt: getBeijingISOString()
    };
}

const MANUAL_ONLY_ANALYSIS_CONTRACT_KEYS = new Set([
    'manualDepth',
    'editorialQuality',
    'researcherFocus',
    'perPaperSubagent',
    'readerLongform',
    'artifactIndex',
    'manualV6Runtime',
    'authorLineage'
]);

function stripManualAnalysisProvenance(paper) {
    if (!paper || typeof paper !== 'object') return paper;
    for (const key of Object.keys(paper)) {
        if (/^manual/i.test(key)) delete paper[key];
    }
    const contracts = paper.analysisManifest?.contracts;
    if (contracts && typeof contracts === 'object') {
        for (const key of MANUAL_ONLY_ANALYSIS_CONTRACT_KEYS) delete contracts[key];
        if (Object.keys(contracts).length === 0) delete paper.analysisManifest.contracts;
    }
    return paper;
}

function markRecoveryStage(manifest, stage, status, details = {}) {
    if (!RECOVERY_STAGE_STATUSES.has(status)) throw new Error(`非法恢复阶段状态: ${status}`);
    const updatedAt = getBeijingISOString();
    manifest.stages[stage] = { status, ...details, updatedAt };
    manifest.updatedAt = updatedAt;
    return manifest.stages[stage];
}

function isRecoveryStageComplete(manifest, stage) {
    return isRecoveryStageTerminal(stage, manifest?.stages?.[stage]?.status);
}

function suppressOuterRetryAfterReaderExhaustion(error) {
    const exhausted = error instanceof Error ? error : new Error(String(error || 'Reader stage failed'));
    // generateApiReaderArticleDetailed already owns its bounded full/repair
    // attempts.  Do not restart the complete analysis in analyzePaperWithRetry
    // during this invocation.  Its non-terminal stage remains checkpointed, so
    // a later explicit resume still retries Reader normally.
    exhausted.retryable = false;
    return exhausted;
}

function hasIncompleteRecoveryStage(manifest) {
    return Object.entries(manifest?.stages || {}).some(([stage, details]) =>
        details && !isRecoveryStageTerminal(stage, details.status)
    );
}

function saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest = null) {
    paper.analysisCheckpoint = String(analysis || '');
    paper.analysisManifest = analysisManifest;
    if (imageManifest) {
        const sanitizedImageManifest = sanitizeImageManifestInPlace(imageManifest);
        paper.imageManifest = sanitizedImageManifest;
        paper.analysisRecoveryImageManifest = sanitizedImageManifest;
    }
    paper.analysisStageCheckpoints = paper.analysisStageCheckpoints || {};
    for (const stage of RECOVERY_STAGE_ORDER) {
        if (isRecoveryStageComplete(analysisManifest, stage)
            && typeof paper.analysisStageCheckpoints[stage] !== 'string') {
            paper.analysisStageCheckpoints[stage] = paper.analysisCheckpoint;
        }
    }
    const persist = paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')];
    if (typeof persist === 'function') persist(paper);
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
    apiKeys: resolvePrimaryApiKeyPool(
        process.env.PAPER_ANALYZER_API_KEY || '',
        process.env.PAPER_ANALYZER_FALLBACK_API_KEYS || '',
        process.env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || ''
    ),
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};

function resolveSecondaryApiKeys(options = {}) {
    const primaryEndpoint = String(options.primaryEndpoint || '');
    const secondaryEndpoint = String(options.secondaryEndpoint || primaryEndpoint);
    const primaryKey = String(options.primaryKey || '').trim();
    const secondaryKey = String(options.secondaryKey || '').trim();
    const secondaryModel = String(options.secondaryModel || '').trim();
    const primaryApiKeys = Array.isArray(options.primaryApiKeys)
        ? options.primaryApiKeys.map(value => String(value || '').trim()).filter(Boolean)
        : [primaryKey].filter(Boolean);
    const secondaryFallbackApiKeys = options.secondaryFallbackApiKeys || '';
    if (!secondaryModel) return [secondaryKey || primaryKey].filter(Boolean);

    const primaryService = normalizeOpenCodeGoService(primaryEndpoint);
    const secondaryService = normalizeOpenCodeGoService(secondaryEndpoint);
    const sameOpenCodeGoService = Boolean(
        primaryService && secondaryService && primaryService === secondaryService
    );
    const canonicalRoute = endpoint => {
        const goService = normalizeOpenCodeGoService(endpoint);
        if (goService) return goService;
        try {
            const parsed = new URL(String(endpoint || ''));
            const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
            return `${parsed.protocol}//${parsed.host}${pathname}`;
        } catch (_) {
            return String(endpoint || '').trim().replace(/\/+$/, '');
        }
    };

    if (!secondaryKey && canonicalRoute(primaryEndpoint) !== canonicalRoute(secondaryEndpoint)) {
        throw new LlmAccountPoolConfigError(
            '副模型 endpoint 与主模型不属于同一 canonical 服务时，必须显式配置 PAPER_ANALYZER_SECONDARY_API_KEY'
        );
    }

    if (secondaryFallbackApiKeys) {
        if (!secondaryKey && !sameOpenCodeGoService) {
            throw new LlmAccountPoolConfigError(
                '副模型显式配置 fallback API keys 时，非同一 OpenCode Go 服务必须同时显式配置 PAPER_ANALYZER_SECONDARY_API_KEY'
            );
        }
        return resolveApiKeyPool(secondaryKey || primaryKey, secondaryFallbackApiKeys);
    }
    if (secondaryKey) return [secondaryKey];

    // A secondary model may inherit the primary account pool only when both
    // routes are the same canonical OpenCode Go service. Cross-service routes
    // were rejected above unless they supplied an explicit secondary key.
    if (sameOpenCodeGoService) {
        return primaryApiKeys;
    }
    return [primaryKey].filter(Boolean);
}

// 副模型配置（多模态图像分析，双模型模式）
// endpoint 未设置时回退主端点；key 只在同一 canonical 服务内复用
const SECONDARY_CONFIG = {
    endpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
    key: SECONDARY_MODEL_CONFIG.key || DEEP_CONFIG.key,
    apiKeys: resolveSecondaryApiKeys({
        primaryEndpoint: DEEP_CONFIG.endpoint,
        secondaryEndpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
        primaryKey: DEEP_CONFIG.key,
        secondaryKey: SECONDARY_MODEL_CONFIG.key,
        primaryApiKeys: DEEP_CONFIG.apiKeys,
        secondaryModel: SECONDARY_MODEL_CONFIG.model,
        secondaryFallbackApiKeys: process.env.PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS || ''
    }),
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
function summarizeModelInput(messages) {
    let textChars = 0;
    let images = 0;
    for (const message of messages || []) {
        const content = message?.content;
        if (typeof content === 'string') {
            textChars += content.length;
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block?.type === 'text') textChars += String(block.text || '').length;
            else if (block?.type === 'image' || block?.type === 'image_url') images += 1;
        }
    }
    return { textChars, estimatedTextTokens: Math.ceil(textChars / 3), images };
}

function resolveApiMaxRetries(maxRetries) {
    return Number.isInteger(maxRetries) && maxRetries > 0
        ? maxRetries
        : API_MAX_RETRIES;
}

function sanitizeModelRequestError(value, config = DEEP_CONFIG) {
    let text = String(value || 'unknown model request error');
    const secrets = [
        config?.key, ...(config?.apiKeys || []),
        DEEP_CONFIG.key, ...(DEEP_CONFIG.apiKeys || []),
        SECONDARY_CONFIG.key, ...(SECONDARY_CONFIG.apiKeys || [])
    ];
    for (const secret of secrets) {
        if (secret && text.includes(secret)) text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
    text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
    return text.slice(0, 1200);
}

function makeModelRequestError(message, properties = {}, config = DEEP_CONFIG) {
    const error = new Error(sanitizeModelRequestError(message, config));
    for (const [key, value] of Object.entries(properties)) {
        if (value !== undefined) error[key] = value;
    }
    error.modelRequestClassified = true;
    return error;
}

function classifyModelRequestError(sourceError, config = DEEP_CONFIG) {
    if (sourceError?.modelRequestClassified) return sourceError;
    const code = String(sourceError?.code || '');
    const message = sanitizeModelRequestError(sourceError?.message || sourceError, config);
    if (code === 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT') {
        sourceError.retryable = true;
        sourceError.category = 'state_contention';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if ([
        'LLM_ACCOUNT_POOL_EXHAUSTED',
        'LLM_ACCOUNT_POOL_CONFIG_ERROR',
        'LLM_ACCOUNT_POOL_STATE_ERROR'
    ].includes(code)) {
        sourceError.retryable = false;
        sourceError.category = code === 'LLM_ACCOUNT_POOL_EXHAUSTED'
            ? 'quota_exhausted'
            : (code === 'LLM_ACCOUNT_POOL_STATE_ERROR' ? 'state' : 'config');
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if (code === 'RESPONSE_TOO_LARGE') {
        const maxResponseBytes = Number.isInteger(config?.maxResponseBytes)
            ? config.maxResponseBytes
            : API_MAX_RESPONSE_BYTES;
        return makeModelRequestError(`Model response exceeded maxResponseBytes=${maxResponseBytes}`, {
            code: 'MODEL_RESPONSE_TOO_LARGE',
            transportCode: code,
            retryable: true,
            category: 'response_limit',
            maxResponseBytes
        }, config);
    }
    if (['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(code)) {
        sourceError.retryable = false;
        sourceError.category = 'output_incomplete';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if (code === 'SSE_TERMINAL_EVENT_MISSING') {
        sourceError.retryable = true;
        sourceError.category = 'stream_terminal';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    const transientCodes = new Set([
        'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
        'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        'REQUEST_DEADLINE_EXCEEDED', 'REQUEST_SOCKET_TIMEOUT'
    ]);
    if (transientCodes.has(code)) {
        sourceError.retryable = true;
        sourceError.category = 'network';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    return makeModelRequestError(message, {
        code: code || 'MODEL_REQUEST_FAILED',
        retryable: true,
        category: 'request',
        cause: sourceError
    }, config);
}

function getModelOutputTerminationError(apiType, response, maxTokens) {
    if (apiType === 'openai_responses') {
        const truncated = getResponsesOutputTruncationError(response, maxTokens);
        if (truncated) return truncated;
        if (response?.status === 'incomplete') {
            return makeModelRequestError(
                `OpenAI Responses 输出未完成: ${response?.incomplete_details?.reason || 'unknown'}`,
                { code: 'MODEL_OUTPUT_INCOMPLETE', retryable: false, category: 'output_incomplete' }
            );
        }
        if (response?.status === 'failed' || response?.status === 'cancelled') {
            return makeModelRequestError(
                `OpenAI Responses 终态为 ${response.status}`,
                { code: 'MODEL_RESPONSE_FAILED', retryable: true, category: 'response_terminal' }
            );
        }
        return null;
    }
    if (apiType === 'anthropic' && response?.stop_reason === 'max_tokens') {
        return makeModelRequestError(
            `Anthropic 输出被 max_tokens=${maxTokens} 截断`,
            { code: 'MODEL_OUTPUT_TRUNCATED', retryable: false, category: 'output_incomplete' }
        );
    }
    if (response?.choices?.[0]?.finish_reason === 'length') {
        return makeModelRequestError(
            `OpenAI Chat 输出被 max_tokens=${maxTokens} 截断`,
            { code: 'MODEL_OUTPUT_TRUNCATED', retryable: false, category: 'output_incomplete' }
        );
    }
    return null;
}

function makeModelHttpError(status, message, config = DEEP_CONFIG) {
    const retryable = [408, 425, 429].includes(status) || status >= 500;
    return makeModelRequestError(`HTTP ${status}: ${message}`, {
        code: retryable ? 'MODEL_HTTP_TRANSIENT' : 'MODEL_HTTP_NON_RETRYABLE',
        status,
        retryable,
        category: retryable ? 'http_transient' : 'http_non_retryable'
    }, config);
}

async function callModelWithConfig(messages, maxTokens, maxRetries = API_MAX_RETRIES, config = null) {
    maxRetries = resolveApiMaxRetries(maxRetries);
    const cfg = config || DEEP_CONFIG;
    const overallTimeoutMs = Number.isInteger(cfg.overallTimeoutMs) && cfg.overallTimeoutMs > 0
        ? cfg.overallTimeoutMs
        : API_OVERALL_TIMEOUT_MS;
    const safeMessages = sanitizeModelMessages(messages);
    const sleepFn = typeof cfg.sleepFn === 'function'
        ? cfg.sleepFn
        : (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const budget = createActiveTimeBudget(overallTimeoutMs);
    let apiType;
    let modelUrl;
    let url;
    try {
        apiType = detectApiType(cfg.endpoint, cfg.model);
        modelUrl = buildApiUrl(apiType, cfg.endpoint);
        url = new URL(modelUrl);
    } catch (error) {
        throw makeModelRequestError(`LLM endpoint 配置无效: ${error.message}`, {
            code: 'MODEL_ENDPOINT_CONFIG_ERROR',
            retryable: false,
            category: 'endpoint_config'
        }, cfg);
    }
    const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : API_TEMPERATURE;
    const input = summarizeModelInput(safeMessages);
    const outputTokenParameter = apiType === 'openai_responses'
        ? 'max_output_tokens'
        : 'max_tokens';
    console.log(`    [api] → ${cfg.model} | ${apiType} | ${url.hostname}${url.pathname} | input_chars=${input.textChars} | estimated_text_tokens≈${input.estimatedTextTokens} | images=${input.images} | output_token_param=${outputTokenParameter} | output_token_budget=${maxTokens} | max_retries=${maxRetries} | temperature=${temperature}`);

    let lastError = null;
    let reportedSuspendedMs = 0;

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const attemptSuspendedMs = budget.suspendedMs();
            try {
                const timeoutMs = getActiveRemainingTimeoutMs(overallTimeoutMs, budget.elapsedMs());
                return await _callModelOnce(safeMessages, maxTokens, {
                    ...cfg, usageContext: { ...cfg.usageContext, transportAttempt: attempt }
                }, budget, apiType, timeoutMs);
            } catch (err) {
                const classified = classifyModelRequestError(err, cfg);
                lastError = classified;
                if (classified.retryable === false) throw classified;
                const duration = (budget.elapsedMs() / 1000).toFixed(1);
                const suspendedBeforeAttempt = attemptSuspendedMs;
                const suspendedMs = budget.suspendedMs();
                if (suspendedMs - reportedSuspendedMs >= 1000) {
                    console.log(`    [api] 💤 检测到系统睡眠/长时间挂起，已从超时预算排除 ${((suspendedMs - reportedSuspendedMs) / 1000).toFixed(1)}s`);
                    reportedSuspendedMs = suspendedMs;
                }
                console.log(`    [api] ⚠️  模型调用失败 (尝试 ${attempt}/${maxRetries}) | active=${duration}s | ${classified.code} | ${classified.message}`);

                if (suspendedMs - suspendedBeforeAttempt >= 1000
                        && ['REQUEST_DEADLINE_EXCEEDED', 'REQUEST_SOCKET_TIMEOUT'].includes(classified.code)) {
                    console.log('    [api] ↻ 本次失败由系统睡眠触发，不消耗重试次数，立即恢复请求');
                    attempt -= 1;
                    continue;
                }

                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * API_RETRY_BASE_DELAY_MS;
                    if (getActiveRemainingTimeoutMs(overallTimeoutMs, budget.elapsedMs()) <= delay) {
                        throw createOverallTimeoutError(
                            budget.elapsedMs(), lastError, overallTimeoutMs
                        );
                    }
                    console.log(`    [api] ⏳  ${delay/1000}s 后第 ${attempt + 1} 次重试...`);
                    await sleepFn(delay);
                }
            }
        }
        if (budget.elapsedMs() >= overallTimeoutMs || lastError?.code === 'MODEL_OVERALL_TIMEOUT') {
            throw createOverallTimeoutError(budget.elapsedMs(), lastError, overallTimeoutMs);
        }
        lastError.attempts = maxRetries;
        throw lastError;
    } finally {
        budget.stop();
    }
}

function createOverallTimeoutError(
    elapsedMs,
    cause = null,
    totalMs = API_OVERALL_TIMEOUT_MS
) {
    const error = new Error(`模型调用整体超时: 预算 ${totalMs}ms，已用 ${elapsedMs}ms`);
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
    const maxResponseBytes = Number.isInteger(config.maxResponseBytes) && config.maxResponseBytes > 0
        ? config.maxResponseBytes
        : API_MAX_RESPONSE_BYTES;
    const requestFn = typeof config.requestFn === 'function' ? config.requestFn : requestLlmJson;

    try {
        const response = await requestFn(
            apiUrl,
            config.endpoint,
            config.model,
            bodyObj,
            headers,
            {
                timeoutMs,
                maxResponseBytes,
                apiKeys: Array.isArray(config.apiKeys) ? config.apiKeys : [config.key].filter(Boolean),
                accountPoolStateFile: require('./config.js').FILES.llmAccountPoolState,
                usageContext: config.usageContext,
                usageSink: config.usageSink,
                usageDirectory: config.usageDirectory,
                recordUsage: config.recordUsage
            }
        );
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = response.body?.error;
            const message = apiError?.message || apiError || 'HTTP response did not include a structured error';
            const safeMessage = sanitizeModelRequestError(
                typeof message === 'string' ? message : JSON.stringify(message),
                config
            );
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${safeMessage}`);
            throw makeModelHttpError(response.statusCode, safeMessage, config);
        }
        const terminationError = getModelOutputTerminationError(apiType, response.body, maxTokens);
        if (terminationError) throw terminationError;
        const content = parseResponseText(apiType, response.body);
        if (content !== null) {
            console.log(`    [api] ✓ ${config.model} | HTTP ${response.statusCode} | ${content.length} chars | ${duration}s`);
            return content;
        }
        if (response.body.error) {
            const safeMessage = sanitizeModelRequestError(
                response.body.error.message || JSON.stringify(response.body.error),
                config
            );
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${safeMessage}`);
            throw makeModelRequestError(safeMessage, {
                code: 'MODEL_API_ERROR', retryable: true, category: 'api_error'
            }, config);
        }
        console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | invalid response`);
        throw makeModelRequestError('Invalid model response', {
            code: 'MODEL_INVALID_RESPONSE', retryable: true, category: 'response_parse'
        }, config);
    } catch (err) {
        const classified = classifyModelRequestError(err, config);
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        console.log(`    [api] ✗ ${config.model} | request error | ${duration}s | ${classified.code} | ${classified.message}`);
        throw classified;
    }
}

async function callModel(messages, maxTokens = 8000, options = {}) {
    const modelName = DEEP_CONFIG.model;
    console.log(`    [analyzer] ╔═══════════════════════════════════════════════════╗`);
    console.log(`    [analyzer] ║  正在使用模型: ${modelName}`);
    console.log(`    [analyzer] ╚═══════════════════════════════════════════════════╜`);
    return await callModelWithConfig(messages, maxTokens, resolveApiMaxRetries(options.maxRetries), {
        ...DEEP_CONFIG,
        usageContext: options.usageContext,
        usageDirectory: options.usageDirectory,
        usageSink: options.usageSink,
        recordUsage: options.recordUsage,
        ...(Number.isInteger(options.overallTimeoutMs) && options.overallTimeoutMs > 0
            ? { overallTimeoutMs: options.overallTimeoutMs }
            : {}),
        ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
        ...(Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
            ? { maxResponseBytes: options.maxResponseBytes }
            : {})
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
    if (!/^https:\/\//i.test(value)) return false;
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
            const error = new Error(`response body ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
            error.code = 'RESPONSE_TOO_LARGE';
            throw error;
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
                const error = new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                error.code = 'RESPONSE_TOO_LARGE';
                throw error;
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

function assessArxivHtmlFullText($, content) {
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    const headingText = $('h1, h2, h3, .ltx_title')
        .map((_, element) => $(element).text().replace(/\s+/g, ' ').trim())
        .get()
        .join(' ');
    const structureText = `${headingText} ${normalized}`;
    const paragraphCount = $('.ltx_para, article p, .ltx_page_content p, .ltx_page_main p, body p')
        .filter((_, element) => $(element).text().replace(/\s+/g, ' ').trim().length >= 40)
        .length;
    const sectionCount = $('.ltx_section, article section, .ltx_page_content section, h1, h2, h3')
        .filter((_, element) => $(element).text().replace(/\s+/g, ' ').trim().length >= 3)
        .length;
    const markerCount = [
        /\babstract\b/i,
        /\bintroduction\b/i,
        /\b(?:method|methodology|approach)\b/i,
        /\b(?:experiment|evaluation|result)s?\b/i,
        /\b(?:conclusion|discussion)\b/i
    ].filter(pattern => pattern.test(structureText)).length;
    let reason = 'ok';
    if (normalized.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) reason = 'too_short';
    else if (paragraphCount < 4) reason = 'metadata_shell';
    else if (sectionCount < 2 && markerCount < 2) reason = 'missing_paper_structure';
    return {
        valid: reason === 'ok',
        reason,
        chars: normalized.length,
        paragraphCount,
        sectionCount,
        markerCount
    };
}

const ARXIV_STRUCTURED_ARTIFACT_VERSION = 1;
// v4 additionally recognizes LaTeXML's semantic span rendering for scaled
// tabulars (`span.ltx_tabular` / `span.ltx_tr` / `span.ltx_td`) and numbered
// DOM-native framed figures that intentionally have no image URL. Those nodes
// are parsed directly from DOM evidence; flattened text is never promoted to a
// matrix or image. v3's SVG evidence behavior remains unchanged.
const ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION = 'arxiv-html-dom-v4';
const STRUCTURED_ARTIFACT_LIMITS = Object.freeze({
    tables: 256,
    rowsPerTable: 512,
    columnsPerTable: 128,
    cellChars: 4096,
    formulas: 2048,
    formulaChars: 20000,
    figures: 512,
    inlineSvgBytes: 2 * 1024 * 1024,
    inlineHtmlFigureBytes: 2 * 1024 * 1024,
    references: 4096,
    referenceChars: 12000
});

function compactDomText(value, maxChars, state, label) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) return normalized;
    state.issues.push(`${label} 超过 ${maxChars} 字符，结构化快照被截断`);
    state.truncated = true;
    return normalized.slice(0, maxChars);
}

function positiveSpan(value) {
    const parsed = Number.parseInt(String(value || '1'), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function figureResourceMediaType(element, rawUrl = '') {
    const declared = String(element?.attribs?.type || '').trim().toLowerCase();
    if (declared) return declared;
    const pathname = String(rawUrl || '').split(/[?#]/, 1)[0].toLowerCase();
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    if (pathname.endsWith('.png')) return 'image/png';
    if (/\.jpe?g$/.test(pathname)) return 'image/jpeg';
    if (pathname.endsWith('.webp')) return 'image/webp';
    return '';
}

function isRecoverableFigureResourceUrl(url, mediaType = '') {
    const value = String(url || '').trim();
    if (!/^https:\/\//i.test(value)) return false;
    if (isSupportedImageUrl(value)) return true;
    // The trusted arXiv DOM explicitly declares these vector graphics.  Keep
    // them in the source inventory so the author can use or reject the actual
    // figure, while the raster-only image downloader continues to reject them.
    return String(mediaType || '').toLowerCase() === 'image/svg+xml';
}

function isIllustrationFigure($, element) {
    const wrapper = $(element);
    const classNames = String(wrapper.attr('class') || '');
    const label = String(wrapper.find('.ltx_tag_figure, .ltx_tag').first().text() || '')
        .replace(/\s+/g, ' ').trim();
    if (wrapper.hasClass('ltx_table') || wrapper.find('table').length > 0) return false;
    if (/\bltx_float_(?:algorithm|listing)\b/i.test(classNames)) return false;
    if (/^(?:table|algorithm|listing|procedure)\b/i.test(label)) return false;
    return true;
}

function extractArxivFigureResources($, wrapper, htmlId, arxivId, ordinal, state) {
    const resources = new Map();
    const add = (element, attribute) => {
        const rawUrl = String($(element).attr(attribute) || '').trim();
        const url = resolveArxivImageUrl(rawUrl, htmlId, arxivId);
        const mediaType = figureResourceMediaType(element, rawUrl);
        if (!isRecoverableFigureResourceUrl(url, mediaType)) return;
        const key = `url:${url}`;
        const existing = resources.get(key);
        const alt = compactDomText($(element).attr('alt'), 1024, state, `figure[${ordinal}].alt`);
        if (existing) {
            if (alt.length > existing.alt.length) existing.alt = alt;
            return;
        }
        resources.set(key, {
            kind: 'external_url',
            url,
            alt,
            mediaType,
            // Only these resources are eligible for the separate, byte- and
            // MIME-verified image pipeline.  SVG stays source evidence only.
            rasterDownloadEligible: isSupportedImageUrl(url)
        });
    };
    wrapper.find('img[src]').each((_, element) => add(element, 'src'));
    wrapper.find('object[data], embed[src]').each((_, element) => {
        add(element, element.tagName?.toLowerCase() === 'object' ? 'data' : 'src');
    });
    wrapper.find('svg').filter((_, element) => $(element).parents('svg').length === 0).each((_, element) => {
        const inlineSvg = $.html(element);
        const inlineSvgBytes = Buffer.byteLength(inlineSvg);
        if (inlineSvgBytes > STRUCTURED_ARTIFACT_LIMITS.inlineSvgBytes) {
            state.issues.push(
                `figure[${ordinal}] 内联 SVG ${inlineSvgBytes} bytes 超过受控上限 `
                + `${STRUCTURED_ARTIFACT_LIMITS.inlineSvgBytes}`
            );
            state.truncated = true;
            return;
        }
        const inlineSvgSha256 = crypto.createHash('sha256').update(inlineSvg).digest('hex');
        resources.set(`inline-svg:${inlineSvgSha256}`, {
            kind: 'inline_svg',
            url: '',
            alt: '',
            mediaType: 'image/svg+xml',
            rasterDownloadEligible: false,
            inlineSvg,
            inlineSvgBytes,
            inlineSvgSha256
        });
    });

    // LaTeXML can preserve a genuine numbered Figure as a DOM-native framed
    // text panel rather than emitting an <img> (for example, a verbatim prompt
    // suite). This remains non-raster source evidence. Admit only the narrow,
    // auditable variant: an explicit Figure label, an ltx_framed body with
    // visible non-caption text, and no table/listing/algorithm DOM. A plain
    // figure whose source asset is missing therefore remains unrecovered.
    if (resources.size === 0) {
        const label = String(wrapper.find('.ltx_tag_figure, .ltx_tag').first().text() || '')
            .replace(/\s+/g, ' ').trim();
        const framed = wrapper.find('.ltx_framed').first();
        const body = wrapper.clone();
        body.find('figcaption, .ltx_caption').remove();
        const bodyText = body.text().replace(/\s+/g, ' ').trim();
        const disallowedDom = wrapper.find(
            'table, .ltx_table, .ltx_tabular, .ltx_listing, .ltx_float_algorithm, '
            + 'img, object, embed, svg, picture, source, canvas, video'
        ).length > 0;
        if (/^(?:figure|fig\.?|图)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(label)
            && framed.length > 0 && bodyText && !disallowedDom) {
            const inlineHtml = $.html(wrapper);
            const inlineHtmlBytes = Buffer.byteLength(inlineHtml);
            if (inlineHtmlBytes > STRUCTURED_ARTIFACT_LIMITS.inlineHtmlFigureBytes) {
                state.issues.push(
                    `figure[${ordinal}] 内联 HTML ${inlineHtmlBytes} bytes 超过受控上限 `
                    + `${STRUCTURED_ARTIFACT_LIMITS.inlineHtmlFigureBytes}`
                );
                state.truncated = true;
            } else {
                const inlineHtmlSha256 = crypto.createHash('sha256').update(inlineHtml).digest('hex');
                resources.set(`inline-html:${inlineHtmlSha256}`, {
                    kind: 'inline_html',
                    url: '',
                    alt: '',
                    mediaType: 'text/html',
                    rasterDownloadEligible: false,
                    inlineHtml,
                    inlineHtmlBytes,
                    inlineHtmlSha256
                });
            }
        }
    }
    return [...resources.values()];
}

function isDescendantOf(node, ancestor) {
    for (let current = node?.parent; current; current = current.parent) {
        if (current === ancestor) return true;
    }
    return false;
}

function layoutContainerFor($, element) {
    return $(element).closest('.ltx_flex_figure, .ltx_logical-block').first().get(0) || null;
}

/**
 * LaTeXML can render a caption-only `figure.ltx_table` in one layout cell and
 * place its `table.ltx_tabular` in the next.  Associate only this exact
 * split-layout pattern: same flex/minipage container, the next table DOM, and
 * no visible prose or competing table caption in between.  Never infer a
 * matrix from flattened text or attach an arbitrary later table.
 */
function isArxivTabularDom($, element) {
    const node = $(element);
    return node.is('table') || node.hasClass('ltx_tabular');
}

function arxivCaptionText($, element) {
    const caption = $(element).clone();
    caption.find('math').each((_, mathElement) => {
        const math = $(mathElement);
        const annotation = math.find(
            'annotation[encoding="application/x-tex"], '
            + 'annotation[encoding="application/x-latex"]'
        ).first().text();
        const replacement = String(math.attr('alttext') || annotation || '')
            .trim().replace(/^\$|\$$/g, '');
        if (replacement) math.empty().text(replacement);
        else math.find('annotation').remove();
    });
    caption.find('annotation').remove();
    return caption.text();
}

function findArxivTabularRoot($, wrapper) {
    const node = $(wrapper);
    if (isArxivTabularDom($, wrapper)) return wrapper;
    return node.find('table, .ltx_tabular').toArray()
        .find(element => $(element).parentsUntil(wrapper, 'table, .ltx_tabular').length === 0) || null;
}

function findSplitTableDom($, wrapper, allElements) {
    if (!$(wrapper).hasClass('ltx_table') || findArxivTabularRoot($, wrapper)) return null;
    const caption = arxivCaptionText(
        $, $(wrapper).find('figcaption, .ltx_caption').first()
    ).replace(/\s+/g, ' ').trim();
    const label = $(wrapper).find('.ltx_tag_table, .ltx_tag').first().text().replace(/\s+/g, ' ').trim();
    if (!caption || !/^(?:table|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(label || caption)) return null;

    const wrapperIndex = allElements.indexOf(wrapper);
    const layout = layoutContainerFor($, wrapper);
    if (wrapperIndex < 0 || !layout) return null;
    const followingTable = allElements.slice(wrapperIndex + 1)
        .find(element => isArxivTabularDom($, element));
    if (!followingTable || layoutContainerFor($, followingTable) !== layout) return null;
    const tableIndex = allElements.indexOf(followingTable);
    for (const element of allElements.slice(wrapperIndex + 1, tableIndex)) {
        if (isDescendantOf(element, wrapper)) continue;
        const node = $(element);
        const tagName = element.tagName?.toLowerCase() || '';
        if (node.hasClass('ltx_table') || tagName === 'figcaption' || node.hasClass('ltx_caption')
            || /^h[1-6]$/.test(tagName)) return null;
        // A non-empty leaf here is actual intervening prose, not an empty
        // layout wrapper introduced by LaTeXML's flex/minipage rendering.
        if (node.children().length === 0 && node.text().replace(/\s+/g, '').length > 0) return null;
    }
    return followingTable;
}

function serializeArxivTable($, element, ordinal, state, options = {}) {
    const wrapper = $(element);
    const tableElement = options.tableElement || findArxivTabularRoot($, element);
    const table = tableElement ? $(tableElement) : $([]);
    // The aggregate proof covers the caption wrapper and the separate tabular
    // fragment; individual cells still retain their own exact DOM SHA.
    const domHtml = [$.html(wrapper), options.tableElement ? $.html(table) : ''].join('\n');
    const caption = compactDomText(
        arxivCaptionText($, wrapper.find('figcaption, .ltx_caption, caption').first()),
        STRUCTURED_ARTIFACT_LIMITS.cellChars,
        state,
        `table[${ordinal}].caption`
    );
    const label = compactDomText(
        wrapper.find('.ltx_tag_table, .ltx_tag').first().text()
            || caption.match(/^\s*(?:table|表)\s*[^.:：]*/i)?.[0]
            || '',
        256,
        state,
        `table[${ordinal}].label`
    );
    if (!table.length) {
        state.issues.push(`table[${ordinal}]${label ? ` ${label}` : ''} 有表格容器但没有可解析 table DOM`);
        return {
            ordinal,
            label,
            caption,
            sourceDomSha256: crypto.createHash('sha256').update(domHtml).digest('hex'),
            headerRows: [],
            bodyRows: [],
            cells: [],
            matrix: [],
            recoveryStatus: 'unrecovered'
        };
    }

    const matrix = [];
    const cells = [];
    const headerRows = new Set();
    const bodyRows = new Set();
    const rowElements = table.find('tr, .ltx_tr').filter((_, rowElement) => (
        $(rowElement).parentsUntil(tableElement, 'tr, .ltx_tr').length === 0
    )).toArray();
    if (rowElements.length > STRUCTURED_ARTIFACT_LIMITS.rowsPerTable) {
        state.issues.push(`table[${ordinal}] 行数 ${rowElements.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.rowsPerTable}`);
        state.truncated = true;
    }
    for (const [rowIndex, rowElement] of rowElements.slice(0, STRUCTURED_ARTIFACT_LIMITS.rowsPerTable).entries()) {
        matrix[rowIndex] ||= [];
        let columnIndex = 0;
        const row = $(rowElement);
        const isHeaderRow = row.closest('thead').length > 0 || row.children('th, .ltx_th').length > 0;
        (isHeaderRow ? headerRows : bodyRows).add(rowIndex);
        for (const cellElement of row.children('th, td, .ltx_th, .ltx_td').toArray()) {
            while (matrix[rowIndex][columnIndex] !== undefined) columnIndex++;
            const cell = $(cellElement);
            const rowspan = positiveSpan(cell.attr('rowspan'));
            const colspan = positiveSpan(cell.attr('colspan'));
            const text = compactDomText(
                cell.text(), STRUCTURED_ARTIFACT_LIMITS.cellChars, state,
                `table[${ordinal}].cell[${rowIndex},${columnIndex}]`
            );
            const cellRecord = {
                row: rowIndex,
                column: columnIndex,
                header: cellElement.tagName?.toLowerCase() === 'th' || cell.hasClass('ltx_th') || isHeaderRow,
                rowspan,
                colspan,
                text,
                sourceDomSha256: crypto.createHash('sha256').update($.html(cell)).digest('hex')
            };
            cells.push(cellRecord);
            for (let rowOffset = 0; rowOffset < rowspan; rowOffset++) {
                const targetRow = rowIndex + rowOffset;
                if (targetRow >= STRUCTURED_ARTIFACT_LIMITS.rowsPerTable) {
                    state.issues.push(`table[${ordinal}] rowspan 超出受控行上限`);
                    state.truncated = true;
                    break;
                }
                matrix[targetRow] ||= [];
                for (let colOffset = 0; colOffset < colspan; colOffset++) {
                    const targetColumn = columnIndex + colOffset;
                    if (targetColumn >= STRUCTURED_ARTIFACT_LIMITS.columnsPerTable) {
                        state.issues.push(`table[${ordinal}] colspan 超出受控列上限`);
                        state.truncated = true;
                        break;
                    }
                    matrix[targetRow][targetColumn] = text;
                }
            }
            columnIndex += colspan;
        }
    }
    const width = Math.min(
        STRUCTURED_ARTIFACT_LIMITS.columnsPerTable,
        matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0)
    );
    const normalizedMatrix = matrix.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
    if (cells.length === 0 || normalizedMatrix.length === 0 || width === 0) {
        state.issues.push(`table[${ordinal}]${label ? ` ${label}` : ''} 未恢复出任何单元格`);
    }
    return {
        ordinal,
        label,
        caption,
        sourceDomSha256: crypto.createHash('sha256').update(domHtml).digest('hex'),
        headerRows: [...headerRows],
        bodyRows: [...bodyRows],
        cells,
        matrix: normalizedMatrix,
        recoveryStatus: cells.length > 0 && width > 0 ? 'complete' : 'unrecovered'
    };
}

/** Preserve structures before the historical `.text()` projection removes them. */
function parseArxivStructuredArtifactsFromHtml(html, htmlId, arxivId = htmlId) {
    const sourceHtml = String(html || '');
    const $ = cheerio.load(sourceHtml);
    const state = { issues: [], truncated: false };
    const allElements = $('*').toArray();
    const rawTableCandidates = $('.ltx_table, table, .ltx_tabular').filter((_, element) => (
        $(element).parents('.ltx_table, table, .ltx_tabular').length === 0
        && ($(element).hasClass('ltx_table') || isArxivTabularDom($, element))
        && $(element).closest('.ltx_equation, .ltx_equationgroup').length === 0
    )).toArray();
    const consumedSplitTableDoms = new Set();
    const tableCandidates = rawTableCandidates.flatMap(element => {
        if (!$(element).hasClass('ltx_table') || findArxivTabularRoot($, element)) {
            return consumedSplitTableDoms.has(element) ? [] : [{ element }];
        }
        const splitTable = findSplitTableDom($, element, allElements);
        if (splitTable) consumedSplitTableDoms.add(splitTable);
        return [{ element, tableElement: splitTable }];
    }).filter(candidate => !consumedSplitTableDoms.has(candidate.element));
    if (tableCandidates.length > STRUCTURED_ARTIFACT_LIMITS.tables) {
        state.issues.push(`表格候选 ${tableCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.tables}`);
        state.truncated = true;
    }
    const tables = tableCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.tables)
        .map((candidate, index) => serializeArxivTable($, candidate.element, index + 1, state, candidate));

    const equationCandidates = $('.ltx_equation, .ltx_equationgroup, math[display="block"]')
        .filter((_, element) => $(element).parents('.ltx_equation, .ltx_equationgroup, math[display="block"]').length === 0)
        .toArray();
    if (equationCandidates.length > STRUCTURED_ARTIFACT_LIMITS.formulas) {
        state.issues.push(`公式候选 ${equationCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.formulas}`);
        state.truncated = true;
    }
    const formulas = equationCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.formulas).map((element, index) => {
        const wrapper = $(element);
        const math = wrapper.is('math') ? wrapper : wrapper.find('math').first();
        const annotation = math.find('annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"]').first();
        const latex = compactDomText(
            annotation.text() || math.attr('alttext') || wrapper.attr('alttext') || '',
            STRUCTURED_ARTIFACT_LIMITS.formulaChars, state, `formula[${index + 1}].latex`
        );
        const mathmlRaw = math.length ? $.html(math) : '';
        const mathml = mathmlRaw.length <= STRUCTURED_ARTIFACT_LIMITS.formulaChars
            ? mathmlRaw : mathmlRaw.slice(0, STRUCTURED_ARTIFACT_LIMITS.formulaChars);
        if (mathmlRaw.length > STRUCTURED_ARTIFACT_LIMITS.formulaChars) {
            state.issues.push(`formula[${index + 1}].mathml 超过受控上限并被截断`);
            state.truncated = true;
        }
        const text = compactDomText(wrapper.text(), STRUCTURED_ARTIFACT_LIMITS.formulaChars, state, `formula[${index + 1}].text`);
        const label = compactDomText(wrapper.find('.ltx_tag_equation, .ltx_tag').first().text(), 256, state, `formula[${index + 1}].label`);
        if (!latex && !mathml && !text) state.issues.push(`formula[${index + 1}] 未恢复出 TeX、MathML 或可见文本`);
        return {
            ordinal: index + 1,
            label,
            latex,
            mathml,
            text,
            sourceDomSha256: crypto.createHash('sha256').update($.html(wrapper)).digest('hex'),
            recoveryStatus: latex || mathml || text ? 'complete' : 'unrecovered'
        };
    });

    const figureCandidates = $('figure').filter((_, element) => (
        $(element).parents('figure').length === 0 && isIllustrationFigure($, element)
    )).toArray();
    if (figureCandidates.length > STRUCTURED_ARTIFACT_LIMITS.figures) {
        state.issues.push(`图片候选 ${figureCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.figures}`);
        state.truncated = true;
    }
    const figures = figureCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.figures).map((element, index) => {
        const wrapper = $(element);
        const images = extractArxivFigureResources($, wrapper, htmlId, arxivId, index + 1, state);
        if (images.length === 0) state.issues.push(`figure[${index + 1}] 没有恢复出可审计图像或 DOM 资源`);
        return {
            ordinal: index + 1,
            label: compactDomText(wrapper.find('.ltx_tag_figure, .ltx_tag').first().text(), 256, state, `figure[${index + 1}].label`),
            caption: compactDomText(
                arxivCaptionText($, wrapper.find('figcaption, .ltx_caption').first()),
                STRUCTURED_ARTIFACT_LIMITS.cellChars,
                state,
                `figure[${index + 1}].caption`
            ),
            images,
            sourceDomSha256: crypto.createHash('sha256').update($.html(wrapper)).digest('hex'),
            recoveryStatus: images.length > 0 ? 'complete' : 'unrecovered'
        };
    });

    const bibliographyRoots = $('.ltx_bibliography, .bibtex');
    const referenceElements = bibliographyRoots.find('.ltx_bibitem, li').toArray();
    if (referenceElements.length > STRUCTURED_ARTIFACT_LIMITS.references) {
        state.issues.push(`参考文献 ${referenceElements.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.references}`);
        state.truncated = true;
    }
    const references = referenceElements.slice(0, STRUCTURED_ARTIFACT_LIMITS.references).map((element, index) => {
        const item = $(element);
        const text = compactDomText(item.text(), STRUCTURED_ARTIFACT_LIMITS.referenceChars, state, `reference[${index + 1}].text`);
        if (!text) state.issues.push(`reference[${index + 1}] 没有恢复出可见文本`);
        return {
            ordinal: index + 1,
            label: compactDomText(item.find('.ltx_tag_bibitem, .ltx_tag').first().text() || item.attr('id') || '', 256, state, `reference[${index + 1}].label`),
            text,
            hrefs: [...new Set(item.find('a[href]').toArray().map(anchor => String($(anchor).attr('href') || '').trim()).filter(Boolean))],
            sourceDomSha256: crypto.createHash('sha256').update($.html(item)).digest('hex')
        };
    });
    if (bibliographyRoots.length > 0 && referenceElements.length === 0) {
        state.issues.push('检测到 bibliography 容器但没有恢复出参考文献条目');
    }

    const payload = {
        version: ARXIV_STRUCTURED_ARTIFACT_VERSION,
        parserVersion: ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
        sourceKind: 'arxiv_html',
        sourceId: String(htmlId || '').toLowerCase(),
        paperId: String(arxivId || '').replace(/v\d+$/i, '').toLowerCase(),
        sourceHtmlSha256: crypto.createHash('sha256').update(sourceHtml).digest('hex'),
        tables,
        formulas,
        figures,
        references,
        health: {
            status: state.issues.length === 0 && !state.truncated ? 'complete' : 'incomplete',
            detected: {
                tables: tableCandidates.length,
                formulas: equationCandidates.length,
                figures: figureCandidates.length,
                references: referenceElements.length,
                bibliographies: bibliographyRoots.length
            },
            recovered: {
                tables: tables.filter(item => item.recoveryStatus === 'complete').length,
                formulas: formulas.filter(item => item.recoveryStatus === 'complete').length,
                figures: figures.filter(item => item.recoveryStatus === 'complete').length,
                references: references.filter(item => item.text).length
            },
            truncated: state.truncated,
            issues: state.issues
        }
    };
    payload.payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return payload;
}

function buildUnstructuredTextArtifactSignals(text, sourceKind) {
    const raw = String(text || '');
    const tableCaptions = [...raw.matchAll(/^\s*(?:table|tbl\.?|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)\b[^\n]*/gim)]
        .map(match => match[0].replace(/\s+/g, ' ').trim());
    const formulaCueCount = (raw.match(/(?:\b(?:eq(?:uation)?|objective|loss function)\s*[.(]?\d*|[=∑∫]|\\(?:frac|sum|mathcal|mathbf)\b)/gi) || []).length;
    const payload = {
        version: ARXIV_STRUCTURED_ARTIFACT_VERSION,
        parserVersion: 'unstructured-text-signals-v1',
        sourceKind,
        tables: [], formulas: [], figures: [], references: [],
        signals: { tableCaptionCount: tableCaptions.length, tableCaptions, formulaCueCount },
        health: {
            status: 'incomplete',
            detected: { tables: tableCaptions.length, formulas: formulaCueCount, figures: 0, references: 0 },
            recovered: { tables: 0, formulas: 0, figures: 0, references: 0 },
            truncated: false,
            issues: [
                `${sourceKind} 不保留 DOM/布局，不能证明表格矩阵完整`,
                `${sourceKind} 不保留 MathML/TeX，不能证明公式 inventory 完整`,
                ...(tableCaptions.length > 0 ? [`检测到 ${tableCaptions.length} 个表格标题但没有恢复矩阵`] : [])
            ]
        }
    };
    payload.payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return payload;
}

function bindStructuredArtifactsToText(structuredArtifacts, text) {
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') {
        throw new Error('structuredArtifacts 绑定需要结构化对象');
    }
    const { payloadSha256: _oldPayloadSha256, ...body } = structuredArtifacts;
    const bound = {
        ...body,
        flattenedTextSha256: crypto.createHash('sha256').update(String(text || '')).digest('hex')
    };
    bound.payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(bound)).digest('hex');
    return bound;
}

function normalizeReaderIdentityText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function readerIdentityKey(value) {
    return normalizeReaderIdentityText(value).normalize('NFKC').toLocaleLowerCase();
}

function readerIdentityTokens(value) {
    return readerIdentityKey(value).split(/\s+/).filter(Boolean);
}

function isLikelyAuthorEnumeration(value) {
    const text = normalizeReaderIdentityText(value);
    if (!/(?:\band\b|&)/i.test(text)
        || /\b(?:university|institute|institution|school|college|department|laborator(?:y|ies)|centre|center|hospital|academy|research|corporation|company|inc\.?|ltd\.?|gmbh|ai)\b/i.test(text)) {
        return false;
    }
    const parts = text.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
        .map(part => part.replace(/^and\s+/i, '').trim()).filter(Boolean);
    const nameLike = parts.filter(part => {
        const tokens = part.split(/\s+/).filter(Boolean);
        return tokens.length >= 2 && tokens.length <= 5
            && tokens.every(token => /^[\p{L}][\p{L}'’.-]*$/u.test(token));
    });
    return nameLike.length >= 2 && nameLike.length === parts.length;
}

function countKnownAuthorNames(value, authorNames) {
    const haystack = ` ${readerIdentityKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    return [...new Set((authorNames || []).map(readerIdentityKey).filter(Boolean))]
        .filter(name => {
            const needle = ` ${name.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
            return needle.trim().split(/\s+/).length >= 2 && haystack.includes(needle);
        }).length;
}

function isReaderResourceAffiliationLabel(value) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    // A removed project URL can leave a plausible-looking nonempty label.
    // These explicit resource labels are not institutional evidence.
    return /^(?:project\s+(?:page|website|webpage)|(?:code|demo|dataset)(?:\s+(?:page|website|url|link))?)(?:\s*[:：]\s*.*|\s*)$/i.test(text);
}

function sanitizeReaderAffiliationValue(value, authorNames = []) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    if (text.length < 3
        || isReaderResourceAffiliationLabel(text)
        || /https?:\/\/|www\./i.test(text)
        || /@/.test(text)
        || /,\s*,/.test(text)
        || countKnownAuthorNames(text, authorNames) >= 2
        || isLikelyAuthorEnumeration(text)) {
        return '';
    }
    return text;
}

function cleanReaderAffiliationNode($, node, authorNames = []) {
    const affiliation = $(node).clone();
    affiliation.find([
        '.ltx_contact_name', '.ltx_contact_email', '.ltx_role_email',
        '.ltx_note_mark', '.ltx_note', '.ltx_tag', 'sup',
        'a.ltx_url', 'a[href^="http://"]', 'a[href^="https://"]'
    ].join(', ')).remove();
    return sanitizeReaderAffiliationValue(affiliation.text(), authorNames);
}

function cleanReaderAuthorNameNode($, node) {
    const name = $(node).clone();
    name.find('.ltx_note_mark, .ltx_note, .ltx_tag, sup').remove();
    return normalizeReaderIdentityText(name.text())
        .replace(/\d*\s*(?:\\?footnotemark|footnotemark)\s*:?[\s\d]*.*$/i, '')
        .trim();
}

function parseReaderThanksAffiliations($) {
    const mappings = new Map();
    const sourceNodes = [];
    $('.ltx_title_document .ltx_pubnote.ltx_role_thanks').toArray().forEach(node => {
        sourceNodes.push($.html(node));
        const note = $(node).clone();
        note.find('.ltx_note_name, .ltx_note_mark, .ltx_note, .ltx_tag, sup').remove();
        const text = normalizeReaderIdentityText(note.text())
            .replace(/\s*\((?:e-?mail|email)\s*:[\s\S]*$/i, '')
            .replace(/[.;]\s*$/, '')
            .trim();
        const match = text.match(/^(.+?)\s+(is also with|is with|are with)\s+(.+)$/i);
        if (!match) return;
        const names = match[1].split(/\s*,\s*|\s+and\s+/i)
            .map(name => name.replace(/^and\s+/i, '').trim()).filter(Boolean);
        const affiliation = sanitizeReaderAffiliationValue(match[3], names);
        if (!affiliation || names.length === 0
            || names.some(name => readerIdentityTokens(name).length < 2)) return;
        for (const name of names) {
            const key = readerIdentityKey(name);
            const current = mappings.get(key) || { name, affiliations: [] };
            if (!current.affiliations.includes(affiliation)) current.affiliations.push(affiliation);
            mappings.set(key, current);
        }
    });
    return { mappings, sourceNodes };
}

function parseReaderAuthorTable($) {
    // Some conference styles put the author block in a plain preamble table,
    // without ltx_authors or citation metadata. Only explicit superscript
    // associations are admissible; never infer associations from row order.
    const tables = [];
    let reachedSection = false;
    $('table, section, .ltx_section').each((_, node) => {
        if ($(node).is('section, .ltx_section')) reachedSection = true;
        else if (!reachedSection && !$(node).parents('table, .ltx_figure, .ltx_table').length) {
            tables.push(node);
        }
    });
    const candidates = [];
    for (const table of tables) {
        const rows = $(table).find('tr').toArray();
        if (rows.length < 2 || rows.length > 101
            || rows.some(row => $(row).children('td, th').length !== 1)) continue;
        const markedCellText = row => {
            const cell = $(row).children('td, th').first().clone();
            let valid = true;
            cell.find('sup').each((_, marker) => {
                const label = normalizeReaderIdentityText($(marker).text()).replace(/\s+/g, '');
                if (!/^[1-9]\d{0,2}(?:,[1-9]\d{0,2})*$/.test(label)) valid = false;
                $(marker).replaceWith(`[[AUTHOR_AFF:${label}]]`);
            });
            return valid ? normalizeReaderIdentityText(cell.text()) : '';
        };
        const nameText = markedCellText(rows[0]);
        const nameMatches = [...nameText.matchAll(/([^\[\]]+)\[\[AUTHOR_AFF:([\d,]+)\]\]/g)];
        if (!nameMatches.length || nameMatches.length > 100
            || nameMatches.map(match => match[0]).join('') !== nameText) continue;
        const entries = nameMatches.map(match => ({
            name: normalizeReaderIdentityText(match[1]).replace(/^(?:[,;]\s*|(?:and|&)\s+)/i, ''),
            labels: match[2].split(',')
        }));
        const names = entries.map(entry => entry.name);
        const isName = name => /^[\u3400-\u9fff]{2,8}$/.test(name)
            || /^(?:[\p{Lu}\p{Lt}][\p{L}’'.-]*\s+){1,7}[\p{Lu}\p{Lt}][\p{L}’'.-]*$/u.test(name);
        if (names.some(name => !isName(name))
            || new Set(names.map(readerIdentityKey)).size !== names.length) continue;
        const affiliations = new Map();
        let valid = true;
        for (const row of rows.slice(1)) {
            const match = markedCellText(row).match(/^\[\[AUTHOR_AFF:([1-9]\d{0,2})\]\]\s*([^\[\]]+)$/);
            const affiliation = match ? sanitizeReaderAffiliationValue(match[2], names) : '';
            if (!match || !affiliation || affiliations.has(match[1])) {
                valid = false;
                break;
            }
            affiliations.set(match[1], affiliation);
        }
        if (!valid || entries.some(entry => entry.labels.some(label => !affiliations.has(label)))) continue;
        candidates.push({
            authors: entries.map(entry => ({
                name: entry.name,
                affiliations: [...new Set(entry.labels.map(label => affiliations.get(label)))]
            })),
            sourceDomSha256: crypto.createHash('sha256').update($.html(table)).digest('hex')
        });
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function parseArxivReaderAuthors($) {
    const wrapper = $('.ltx_authors').first();
    const cleanName = value => normalizeReaderIdentityText(value)
        .replace(/\d*\s*(?:\\?footnotemark|footnotemark)\s*:?[\s\d]*.*$/i, '')
        .trim();
    const metaAuthors = $('meta[name="citation_author"]').toArray()
        .map(node => cleanName($(node).attr('content'))).filter(Boolean);
    const thanksAffiliations = parseReaderThanksAffiliations($);
    const domAuthorNames = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author .ltx_personname').toArray()
            .map(node => cleanReaderAuthorNameNode($, node)).filter(Boolean)
        : [];
    const knownAuthorNames = [...metaAuthors, ...domAuthorNames,
        ...[...thanksAffiliations.mappings.values()].map(item => item.name)];
    const metaAffiliations = $('meta[name="citation_author_institution"]').toArray()
        .map(node => sanitizeReaderAffiliationValue($(node).attr('content'), knownAuthorNames))
        .filter(Boolean);
    const globalAffiliations = (wrapper.length
        ? wrapper.find('.ltx_role_affiliation, .ltx_affiliation').toArray()
        : []).map(node => cleanReaderAffiliationNode($, node, knownAuthorNames))
        .filter(Boolean);
    const dedupedGlobalAffiliations = [...new Set([
        ...globalAffiliations, ...metaAffiliations
    ])];
    const authorElements = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author').toArray()
        : [];
    let authors = authorElements.map((element, index) => {
        const creator = $(element);
        const nameNode = creator.find('.ltx_personname').first();
        const name = cleanReaderAuthorNameNode($, nameNode)
            || metaAuthors[index] || '';
        const affiliationNodes = creator.find('.ltx_contact.ltx_role_affiliation').toArray();
        const rejectedResourceLabel = affiliationNodes.some(node => isReaderResourceAffiliationLabel($(node).text()));
        const affiliations = affiliationNodes
            .map(node => cleanReaderAffiliationNode($, node, knownAuthorNames))
            .filter(Boolean);
        const thanks = thanksAffiliations.mappings.get(readerIdentityKey(name));
        const fallbackAffiliations = rejectedResourceLabel ? [] : metaAuthors.length > 0
            && metaAffiliations.length === metaAuthors.length
            ? [metaAffiliations[index]].filter(Boolean)
            : (dedupedGlobalAffiliations.length === 1 ? dedupedGlobalAffiliations : []);
        return {
            name,
            affiliations: [...new Set(thanks?.affiliations?.length > 0
                ? thanks.affiliations
                : (affiliations.length > 0 ? affiliations : fallbackAffiliations))]
        };
    }).filter(item => item.name);
    if (authors.length === 0 && metaAuthors.length > 0) {
        authors = metaAuthors.map((name, index) => ({
            name,
            affiliations: metaAffiliations.length === metaAuthors.length
                ? [metaAffiliations[index]].filter(Boolean)
                : (dedupedGlobalAffiliations.length === 1 ? dedupedGlobalAffiliations : [])
        }));
    }
    const existingNames = new Set(authors.map(item => readerIdentityKey(item.name)));
    for (const [key, item] of thanksAffiliations.mappings) {
        if (!existingNames.has(key)) {
            authors.push({ name: item.name, affiliations: [...item.affiliations] });
            existingNames.add(key);
        }
    }
    if (authors.length === 0) {
        const tableAuthors = parseReaderAuthorTable($);
        if (tableAuthors) return tableAuthors;
    }
    authors = authors.map(item => ({
        name: item.name,
        affiliations: item.affiliations.length > 0
            ? item.affiliations
            : ['机构信息未在 arXiv HTML 中可靠披露']
    }));
    const sourceNodes = wrapper.length
        ? [$.html(wrapper), ...thanksAffiliations.sourceNodes].filter(Boolean).join('\n')
        : $('meta[name="citation_author"], meta[name="citation_author_institution"]')
            .toArray().map(node => $.html(node)).join('\n');
    return {
        authors,
        sourceDomSha256: sourceNodes
            ? crypto.createHash('sha256').update(sourceNodes).digest('hex')
            : ''
    };
}

function resolveApiReaderAuthors(paper, sourceDetails) {
    const parsed = sourceDetails?.readerAuthors;
    const normalizeName = value => String(value || '').replace(/\s+/g, ' ').trim();
    const rawAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    let names = rawAuthors.map(author => (
        typeof author === 'string' ? author : author?.name
    )).map(normalizeName).filter(Boolean);
    const unavailableAffiliation = sourceDetails?.source === 'conference_pdf_text'
        ? '机构信息未能从会议 PDF 纯文本可靠映射'
        : sourceDetails?.analysisSource === 'pdf'
            ? '机构信息未能从 arXiv PDF 文本可靠映射'
            : '机构信息未在 arXiv HTML 中可靠披露';
    if (parsed && Array.isArray(parsed.authors) && parsed.authors.length > 0
        && recoverySha256(parsed.sourceDomSha256)) {
        if (names.length === 0) names = parsed.authors.map(author => normalizeName(author?.name)).filter(Boolean);
        const knownAuthorNames = [...names, ...parsed.authors.map(author => author?.name)];
        const normalizedParsed = parsed.authors.map(author => ({
            name: normalizeName(author?.name),
            rejectedResourceLabel: Array.isArray(author?.affiliations)
                && author.affiliations.some(isReaderResourceAffiliationLabel),
            affiliations: Array.isArray(author?.affiliations)
                ? author.affiliations
                    .map(value => sanitizeReaderAffiliationValue(value, knownAuthorNames))
                    .filter(Boolean)
                : []
        })).filter(author => author.name);
        const allAffiliations = [...new Set(normalizedParsed
            .flatMap(author => author.affiliations))];
        const authors = names.map((name, index) => {
            const exact = normalizedParsed.find(author => (
                author.name.normalize('NFKC').toLocaleLowerCase()
                === name.normalize('NFKC').toLocaleLowerCase()
            ));
            const rawTokens = readerIdentityTokens(name);
            const suffix = exact ? null : normalizedParsed.find(author => {
                const parsedTokens = readerIdentityTokens(author.name);
                return parsedTokens.length >= 2
                    && rawTokens.length === parsedTokens.length + 1
                    && rawTokens.slice(-parsedTokens.length).join(' ')
                        === parsedTokens.join(' ');
            });
            const positional = normalizedParsed.length === names.length
                ? normalizedParsed[index]
                : null;
            const matched = exact || suffix || positional;
            return {
                name: suffix?.name || name,
                affiliations: matched?.affiliations?.length > 0
                    ? matched.affiliations
                    : (!matched?.rejectedResourceLabel && allAffiliations.length === 1
                        ? allAffiliations
                        : [unavailableAffiliation])
            };
        });
        return bindApiReaderAuthorIdentity(paper, sourceDetails, {
            authors, sourceDomSha256: parsed.sourceDomSha256
        });
    }
    const sourceSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    return bindApiReaderAuthorIdentity(paper, sourceDetails, {
        authors: names.map(name => ({
            name,
            affiliations: [unavailableAffiliation]
        })),
        sourceDomSha256: sourceSha256
    });
}

function bindApiReaderAuthorIdentity(paper, sourceDetails, resolved) {
    const sourceTextSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    const metadataAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    const metadataSha256 = stableFingerprint(metadataAuthors);
    const parsedAuthors = Array.isArray(sourceDetails?.readerAuthors?.authors)
        ? sourceDetails.readerAuthors.authors : [];
    const sourceDomSha256 = sourceDetails?.readerAuthors?.sourceDomSha256;
    const isUnavailable = value => /^机构信息未/.test(String(value || ''));
    const authors = (resolved?.authors || []).map(author => {
        const parsed = parsedAuthors.find(item => (
            readerIdentityKey(item?.name) === readerIdentityKey(author?.name)
        ));
        const nameBinding = parsed && recoverySha256(sourceDomSha256)
            ? { sourceKind: 'html_dom', sourceValue: parsed.name, sourceDomSha256 }
            : { sourceKind: 'paper_metadata', sourceValue: author.name, metadataSha256 };
        const affiliationBindings = (author.affiliations || []).map(affiliation => {
            if (isUnavailable(affiliation)) {
                return {
                    sourceKind: 'explicit_unavailable', sourceValue: affiliation,
                    sourceTextSha256
                };
            }
            const direct = parsed?.affiliations?.find(value => (
                readerIdentityKey(value) === readerIdentityKey(affiliation)
            ));
            const globallyUnique = [...new Set(parsedAuthors.flatMap(item => item.affiliations || []))]
                .find(value => readerIdentityKey(value) === readerIdentityKey(affiliation));
            if ((!direct && !globallyUnique) || !recoverySha256(sourceDomSha256)) {
                throw new Error(`作者 ${author.name} 的机构“${affiliation}”无法重放到 HTML source detail`);
            }
            return {
                sourceKind: 'html_dom',
                association: direct ? 'direct_author' : 'single_global_affiliation',
                sourceValue: direct || globallyUnique,
                sourceDomSha256
            };
        });
        return { name: author.name, affiliations: author.affiliations, nameBinding, affiliationBindings };
    });
    const identity = {
        contract: API_READER_AUTHOR_IDENTITY_CONTRACT,
        sourceDomSha256: recoverySha256(sourceDomSha256) ? sourceDomSha256 : '',
        sourceTextSha256,
        metadataSha256,
        authors
    };
    return {
        authors: authors.map(item => ({ name: item.name, affiliations: item.affiliations })),
        sourceDomSha256: resolved?.sourceDomSha256 || sourceTextSha256,
        identity,
        identitySha256: stableFingerprint(identity)
    };
}

function extractApiReaderResourceCandidates(analysis) {
    const section = extractSectionByTitle(analysis, '开源详情');
    const typeByLabel = {
        '代码': 'code', '模型权重': 'model', '数据集': 'dataset',
        'Demo': 'demo', '复现材料': 'reproduction', '论文中引用的开源项目': 'third_party'
    };
    const candidates = [];
    for (const line of String(section || '').split('\n')) {
        const label = Object.keys(typeByLabel).find(item => line.includes(`${item}：`) || line.includes(`${item}:`));
        if (!label) continue;
        for (const match of line.matchAll(
            /https:\/\/[^\s<>()\[\]{}"'，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+/giu
        )) {
            const url = match[0].replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
            candidates.push({ type: typeByLabel[label], url, line: line.trim() });
        }
    }
    return [...new Map(candidates.map(item => [`${item.type}:${item.url}`, item])).values()];
}

function exactResourceSourceQuote(sourceText, url, maxChars = 1200) {
    const source = String(sourceText || '');
    const index = source.indexOf(url);
    if (index < 0) return '';
    const lowerBound = Math.max(0, index - Math.floor(maxChars / 2));
    const upperBound = Math.min(source.length, index + url.length + Math.floor(maxChars / 2));
    const before = source.slice(lowerBound, index);
    const after = source.slice(index + url.length, upperBound);
    const boundaryBefore = Math.max(
        before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('. ')
    );
    const afterMatches = [after.indexOf('\n'), after.indexOf('。'), after.indexOf('. ')]
        .filter(value => value >= 0);
    const start = index - before.length + (boundaryBefore >= 0 ? boundaryBefore + 1 : 0);
    const end = index + url.length + (afterMatches.length > 0 ? Math.min(...afterMatches) + 1 : after.length);
    let quote = source.slice(start, end).trim();
    if (quote.length > maxChars) {
        const relative = quote.indexOf(url);
        const quoteStart = Math.max(0, Math.min(relative, quote.length - maxChars));
        quote = quote.slice(quoteStart, quoteStart + maxChars).trim();
    }
    if (!quote.includes(url)) throw new Error('开源资源 exact sourceQuote 截取丢失 URL');
    return quote;
}

async function verifyApiReaderResourceUrl(rawUrl, options = {}) {
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    let currentUrl = String(rawUrl || '');
    const redirects = [];
    for (let count = 0; count <= 3; count++) {
        let parsed;
        try {
            parsed = await validateUrlImpl(currentUrl);
        } catch (error) {
            if (/非公网|localhost|不支持的公网 URL 协议|用户名或密码|必须使用 HTTPS/i
                .test(String(error?.message || ''))) throw error;
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: String(error?.code || 'RESOURCE_DNS_TRANSIENT_FAILURE').slice(0, 100)
            };
        }
        if (parsed.protocol !== 'https:') throw new Error('开源资源 URL 必须使用 HTTPS');
        const remainingMs = Number.isFinite(options.deadlineAt)
            ? options.deadlineAt - Date.now() : 15000;
        if (remainingMs <= 0) {
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: 'RESOURCE_VERIFICATION_BUDGET_EXHAUSTED'
            };
        }
        let response;
        try {
            response = await requestImpl(currentUrl, {
                headers: { 'User-Agent': 'PaperDigest/1.0' },
                timeoutMs: Math.min(15000, remainingMs),
                maxBytes: 256 * 1024
            });
        } catch (error) {
            if (error?.code === 'PROXY_CONFIG_ERROR') throw error;
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: String(error?.code || 'RESOURCE_REQUEST_TRANSIENT_FAILURE').slice(0, 100)
            };
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || count >= 3) throw new Error('开源资源重定向链无效或过长');
            const nextUrl = new URL(location, currentUrl).toString();
            redirects.push({ from: currentUrl, to: nextUrl, status: response.status });
            currentUrl = nextUrl;
            continue;
        }
        const temporary = [408, 425, 429].includes(response.status) || response.status >= 500;
        return {
            originalUrl: rawUrl,
            finalUrl: currentUrl,
            redirects,
            status: response.status,
            availability: response.status >= 200 && response.status < 400
                ? 'available' : temporary ? 'temporarily_unreachable' : 'unavailable',
            retryable: temporary
        };
    }
    throw new Error('开源资源验证未产生终态');
}

async function buildApiReaderResourceIdentity(analysis, sourceText, demoStage = {}, options = {}) {
    const extractedCandidates = extractApiReaderResourceCandidates(analysis);
    const deadlineAt = Number.isFinite(options.deadlineAt)
        ? options.deadlineAt : Date.now() + 60000;
    const demoLinks = new Set(Array.isArray(demoStage?.discoveredLinks)
        ? demoStage.discoveredLinks : []);
    const boundCandidates = extractedCandidates.map(candidate => {
        const sourceLine = exactResourceSourceQuote(sourceText, candidate.url);
        const origin = sourceLine ? 'paper_source' : demoLinks.has(candidate.url)
            ? 'validated_demo' : null;
        return { ...candidate, sourceLine, origin };
    }).filter(candidate => candidate.origin);
    const candidates = boundCandidates.slice(0, 12);
    if (boundCandidates.length > candidates.length) {
        console.log(
            `    [deep] 开源资源候选已按来源顺序稳定截断: ${boundCandidates.length} → 12`
        );
    }
    const resources = [];
    for (const candidate of candidates) {
        const { sourceLine, origin } = candidate;
        // LLM prose may expand a named dataset/project into a plausible URL
        // that the paper never states.  Omit it from the sealed identity;
        // applyApiReaderResourceAvailability() deterministically removes the
        // unbound URL from canonical prose before scoring and publication.
        let verified;
        try {
            verified = await verifyApiReaderResourceUrl(candidate.url, {
                ...options,
                deadlineAt
            });
        } catch (error) {
            if (/非公网|localhost|不支持的公网 URL 协议|用户名或密码|必须使用 HTTPS/i
                .test(String(error?.message || ''))) {
                console.warn(`    [deep] 跳过不安全的开源资源 URL: ${candidate.url}`);
                continue;
            }
            throw error;
        }
        resources.push({
            type: candidate.type,
            origin,
            sourceQuote: sourceLine?.trim() || candidate.line,
            sourceQuoteSha256: crypto.createHash('sha256')
                .update(sourceLine?.trim() || candidate.line).digest('hex'),
            ...verified
        });
    }
    const identity = {
        contract: API_READER_RESOURCE_IDENTITY_CONTRACT,
        sourceTextSha256: crypto.createHash('sha256').update(String(sourceText || '')).digest('hex'),
        resources
    };
    return { ...identity, identitySha256: stableFingerprint(identity) };
}

function applyApiReaderResourceAvailability(analysis, identity) {
    if (identity?.contract !== API_READER_RESOURCE_IDENTITY_CONTRACT || !Array.isArray(identity.resources)
        || !recoverySha256(identity.identitySha256)) {
        throw new Error('资源状态同步需要已验证 identity，不能把缺失身份当作空资源列表');
    }
    let updated = String(analysis || '');
    const acceptedUrls = new Set((identity?.resources || [])
        .map(item => item.originalUrl).filter(Boolean));
    for (const candidate of extractApiReaderResourceCandidates(updated)) {
        if (!acceptedUrls.has(candidate.url)) {
            updated = updated.split(candidate.url).join(
                '未找到论文原文或已验证 Demo 中的精确链接'
            );
        }
    }
    const availableTypes = new Set((identity?.resources || [])
        .filter(item => item.availability === 'available').map(item => item.type));
    for (const [field, type] of [['has_code', 'code'], ['has_model', 'model'], ['has_dataset', 'dataset']]) {
        updated = setMachineSummaryField(updated, field, availableTypes.has(type) ? '是' : '否');
    }
    const summary = (identity?.resources || []).length === 0
        ? '未发现可验证的官方 HTTPS 资源 URL。'
        : identity.resources.map(item => (
            `${item.type}=${item.availability}${item.status === null ? '' : `(HTTP ${item.status})`}`
        )).join('；');
    const section = extractSectionByTitle(updated, '开源详情');
    const cleaned = String(section || '').replace(/^[-*]\s*资源可达性验证[：:].*$/m, '').trim();
    return mergeSectionByTitle(
        updated,
        '开源详情',
        `${cleaned}\n- 资源可达性验证：${summary}`.trim()
    );
}

/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivTextDetailed(arxivId) {
    return require('./lib/fresh-analysis-context.js').fetchFreshSource(arxivId, fetchArxivTextDetailedOriginal);
}

async function fetchArxivTextDetailedOriginal(arxivId) {
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
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher: getArxivFetchDispatcher()
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
                    const structuredArtifacts = parseArxivStructuredArtifactsFromHtml(html, htmlId, arxivId);
                    const $ = cheerio.load(html);
                    const readerAuthors = parseArxivReaderAuthors($);

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
                    const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, content);

                    const assessment = assessArxivHtmlFullText($, content);
                    if (!assessment.valid) {
                        warnings.push(
                            `HTML ${htmlId}: ${assessment.reason} `
                            + `(chars=${assessment.chars}, paragraphs=${assessment.paragraphCount}, `
                            + `sections=${assessment.sectionCount}, markers=${assessment.markerCount})`
                        );
                        console.log(
                            `    [deep] fetchArxivText ${htmlId} 正文健康检查失败 `
                            + `| reason=${assessment.reason} | chars=${assessment.chars} `
                            + `| paragraphs=${assessment.paragraphCount} | sections=${assessment.sectionCount} `
                            + `| markers=${assessment.markerCount}，继续 fallback`
                        );
                        continue;
                    }
                    return {
                        text: content,
                        source: 'html',
                        sourceId: htmlId,
                        imageInfos,
                        structuredArtifacts: boundStructuredArtifacts,
                        readerAuthors,
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
                if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
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
    let pdfHadTransientFailure = false;
    let lastTransientFailure = '';
    for (const pdfId of getArxivHtmlIds(arxivId)) {
        const pdfUrl = `https://arxiv.org/pdf/${pdfId}.pdf`;
        try {
            const pdfResponse = await fetch(pdfUrl, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS),
                dispatcher: getArxivFetchDispatcher()
            });
            if (!pdfResponse.ok) {
                console.log(`    [deep] PDF ${pdfUrl} HTTP ${pdfResponse.status}`);
                warnings.push(`PDF ${pdfId}: HTTP ${pdfResponse.status}`);
                if (isRetryableImageStatus(pdfResponse.status)) {
                    pdfHadTransientFailure = true;
                    lastTransientFailure = `PDF ${pdfId}: HTTP ${pdfResponse.status}`;
                }
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
                const rawPdfText = result.text;
                const structuredArtifacts = buildUnstructuredTextArtifactSignals(rawPdfText, 'pdf_text');
                const text = rawPdfText
                    .replace(/\n\s*\n/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
                const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, text);
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
                    structuredArtifacts: boundStructuredArtifacts,
                    htmlAvailability,
                    htmlAttempts,
                    warnings
                };
            }
        } catch (e) {
            if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
            pdfHadTransientFailure = true;
            lastTransientFailure = `PDF ${pdfId}: ${e.message}`;
            console.log(`    [deep] PDF fallback ${pdfUrl} error: ${e.message}`);
            warnings.push(`PDF ${pdfId}: ${e.message}`);
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} PDF fallback also failed`);
    const failureClass = classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure);
    return {
        text: '',
        source: 'unavailable',
        sourceId: '',
        imageInfos: [],
        structuredArtifacts: null,
        htmlAvailability,
        htmlAttempts,
        warnings,
        failureClass,
        failureError: failureClass === 'transient'
            ? (lastTransientFailure || `arXiv ${arxivId} 全文抓取瞬时失败`)
            : ''
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
        let caption = arxivCaptionText(
            $, $figure.children('figcaption').first()
        ).replace(/\s+/g, ' ').trim();
        if (!caption) {
            caption = arxivCaptionText(
                $, $figure.find('figcaption').first()
            ).replace(/\s+/g, ' ').trim();
        }
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
    const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
        ? options.maxRetries
        : 6;
    const fetchImpl = options.fetchImpl || fetch;
    const dispatcher = Object.prototype.hasOwnProperty.call(options, 'dispatcher')
        ? options.dispatcher
        : getArxivFetchDispatcher();
    let lastFailure = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let shouldRetry = false;
        const statuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await fetchImpl(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher
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
                if (e.code === 'PROXY_CONFIG_ERROR') throw e;
                shouldRetry = true;
                statuses.push(`${htmlId}:${e.name || 'error'}`);
                lastFailure = e.message;
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
    const error = new Error(`arXiv 图片发现在 ${maxRetries} 次尝试后仍失败${lastFailure ? `: ${lastFailure}` : ''}`);
    error.code = 'ARXIV_IMAGE_DISCOVERY_TRANSIENT_FAILURE';
    throw error;
}

/**
 * 下载图片并转为 base64
 */
function nodeHeadersView(headers) {
    return {
        get(name) {
            const value = headers[String(name).toLowerCase()];
            if (Array.isArray(value)) return value.join(', ');
            return value === undefined ? null : String(value);
        }
    };
}

async function requestPinnedPublicHttps(rawUrl, options = {}) {
    const {
        headers = {},
        timeoutMs = 15000,
        maxBytes = 1024 * 1024
    } = options;
    const parsedUrl = await validatePublicHttpUrl(rawUrl);
    if (parsedUrl.protocol !== 'https:') {
        throw new Error(`任意公网资源只允许 HTTPS，收到: ${parsedUrl.protocol}`);
    }
    const proxyUrl = detectHttpConnectProxyUrl();
    if (!proxyUrl) {
        const error = new Error('公网图片与 Demo 页面必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 代理');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    const port = Number.parseInt(parsedUrl.port, 10) || 443;
    const agent = createProxyAgent(
        proxyUrl,
        parsedUrl.validatedAddress,
        port,
        parsedUrl.validatedHostname
    );

    return new Promise((resolve, reject) => {
        let settled = false;
        let total = 0;
        let deadline = null;
        const chunks = [];
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            if (deadline) clearTimeout(deadline);
            agent.destroy();
            handler(value);
        };
        const request = https.request({
            hostname: parsedUrl.validatedHostname,
            port,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: 'GET',
            headers: {
                ...headers,
                Host: parsedUrl.host
            },
            agent
        }, response => {
            response.on('data', chunk => {
                total += chunk.length;
                if (maxBytes > 0 && total > maxBytes) {
                    const error = new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                    error.code = 'RESPONSE_TOO_LARGE';
                    response.destroy(error);
                    request.destroy(error);
                    finish(reject, error);
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                finish(resolve, {
                    status: response.statusCode || 0,
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    headers: nodeHeadersView(response.headers),
                    body: null,
                    arrayBuffer: async () => buffer
                });
            });
            response.on('error', error => finish(reject, error));
        });
        deadline = setTimeout(() => {
            const error = new Error(`公网资源请求超过绝对截止时间 ${timeoutMs}ms`);
            error.code = 'PUBLIC_RESOURCE_DEADLINE_EXCEEDED';
            request.destroy(error);
            finish(reject, error);
        }, timeoutMs);
        deadline.unref?.();
        request.setTimeout(timeoutMs, () => {
            const error = new Error(`公网资源连接空闲超时 ${timeoutMs}ms`);
            error.code = 'PUBLIC_RESOURCE_SOCKET_TIMEOUT';
            request.destroy(error);
            finish(reject, error);
        });
        request.on('error', error => finish(reject, error));
        request.end();
    });
}

async function fetchPublicImageResponse(imageUrl, maxRedirects = 5, requestImpl = requestPinnedPublicHttps) {
    let currentUrl = String(imageUrl || '');
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        await validatePublicHttpUrl(currentUrl);
        const response = await requestImpl(currentUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
            timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
            maxBytes: IMAGE_MAX_BYTES
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

async function downloadImageBase64Uncached(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
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
            const response = await fetchPublicImageResponse(imageUrl, 5, requestImpl);
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
            if (e.code === 'PROXY_CONFIG_ERROR') throw e;
            lastError = e.message;
            if (/exceeds limit/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return { failureType: 'permanent_reject', reason: 'body_size_exceeded' };
            }
            if (/非公网|localhost|不支持的公网 URL 协议|任意公网资源只允许 HTTPS|用户名或密码|重定向超过|重定向.*缺少 Location/i.test(e.message)) {
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

async function downloadImageBase64Detailed(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
    const key = `${imageUrl}\n${maxBytes}`;
    if (!imageDownloadPromises.has(key)) {
        const promise = downloadImageBase64Uncached(imageUrl, maxRetries, maxBytes, requestImpl)
            .finally(() => imageDownloadPromises.delete(key));
        imageDownloadPromises.set(key, promise);
    }
    return imageDownloadPromises.get(key);
}

async function cachePublicImageDetailed(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES) {
    const result = await downloadImageBase64Detailed(imageUrl, maxRetries, maxBytes);
    if (!result?.base64) return result || null;
    const cache = imageCachePaths(imageUrl);
    const decoded = Buffer.from(result.base64, 'base64');
    let cachedBuffer;
    try {
        cachedBuffer = await fs.promises.readFile(cache.data);
    } catch (_error) {
        return { failureType: 'transient_failure', reason: 'cache_write_failed' };
    }
    const cachedSha256 = crypto.createHash('sha256').update(cachedBuffer).digest('hex');
    if (cachedBuffer.length !== decoded.length
        || cachedSha256 !== result.sha256
        || sniffImageMime(cachedBuffer) !== result.mime) {
        return { failureType: 'transient_failure', reason: 'cache_integrity_failed' };
    }
    return {
        url: imageUrl,
        cachePath: cache.data,
        mime: result.mime,
        sha256: result.sha256,
        bytes: cachedBuffer.length,
        cacheHit: Boolean(result.cacheHit)
    };
}

async function downloadImageBase64(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
    const result = await downloadImageBase64Detailed(imageUrl, maxRetries, maxBytes, requestImpl);
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
            if (e.code === 'PROXY_CONFIG_ERROR') throw e;
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
        let parsedUrl;
        try {
            parsedUrl = new URL(info.url);
        } catch (_error) {
            continue;
        }
        const candidateText = `${info.caption || ''} ${info.alt || ''}`.toLowerCase();
        const isArxivChrome = /(^|\.)arxiv\.org$/i.test(parsedUrl.hostname)
            && (/^\/static\//i.test(parsedUrl.pathname) || /\/images\/funders\//i.test(parsedUrl.pathname));
        const isFundingAsset = /\b(funder|funding|sponsor|sponsorship)\b/i.test(candidateText)
            || /\bfoundation\s+(?:logo|mark)\b/i.test(candidateText)
            || /\b(?:simons|schmidt)\s+foundation\b/i.test(candidateText);
        if (isArxivChrome || isFundingAsset) continue;
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
        if (typeof item === 'string') return { url: item.trim(), caption: '' };
        if (typeof item === 'object' && item.url) {
            const normalized = {
                url: String(item.url).trim(),
                caption: item.caption || item.alt || item.description || ''
            };
            for (const key of ['figureNumber', 'sourceSection', 'sourceType']) {
                if (item[key]) normalized[key] = String(item[key]);
            }
            for (const key of ['cachePath', 'mime', 'sha256']) {
                if (item[key]) normalized[key] = String(item[key]);
            }
            if (typeof item.cacheHit === 'boolean') normalized.cacheHit = item.cacheHit;
            if (Number.isInteger(item.sourceOrder)) normalized.sourceOrder = item.sourceOrder;
            if (Number.isFinite(item.candidateScore)) normalized.candidateScore = item.candidateScore;
            else if (Number.isFinite(item.score)) normalized.candidateScore = item.score;
            return normalized;
        }
        return null;
    }).filter(info => info && info.url && isSupportedImageUrl(info.url));
}

function sanitizeImageManifestRecords(input) {
    if (!Array.isArray(input)) return [];
    const recordsByUrl = new Map();
    for (const item of input) {
        if (!item) continue;
        const rawUrl = typeof item === 'string' ? item : item.url;
        const url = String(rawUrl || '').trim();
        if (!isSupportedImageUrl(url)) continue;
        const record = typeof item === 'string' ? { url } : { ...item, url };
        const existing = recordsByUrl.get(url);
        if (!existing) {
            recordsByUrl.set(url, record);
            continue;
        }
        const merged = { ...existing, ...record, url };
        for (const key of ['caption', 'alt', 'description', 'cachePath', 'mime', 'sha256']) {
            if (!record[key] && existing[key]) merged[key] = existing[key];
        }
        recordsByUrl.set(url, merged);
    }
    return [...recordsByUrl.values()];
}

function sanitizeSelectedImageUrls(input) {
    if (!Array.isArray(input)) return [];
    return [...new Set(input
        .map(item => String(typeof item === 'string' ? item : item?.url || '').trim())
        .filter(isSupportedImageUrl))];
}

function sanitizeImageManifestHttpsOnly(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const selectedEntries = Array.isArray(manifest.selected) ? manifest.selected : [];
    const candidates = sanitizeImageManifestRecords([
        ...(Array.isArray(manifest.candidates) ? manifest.candidates : []),
        ...selectedEntries
    ]);
    return {
        ...manifest,
        candidates,
        downloaded: sanitizeImageManifestRecords(manifest.downloaded),
        downloadOutcomes: sanitizeImageManifestRecords(manifest.downloadOutcomes),
        selected: sanitizeSelectedImageUrls(selectedEntries)
    };
}

function sanitizeImageManifestInPlace(manifest) {
    const sanitized = sanitizeImageManifestHttpsOnly(manifest);
    if (!sanitized) return null;
    for (const key of Object.keys(manifest)) delete manifest[key];
    Object.assign(manifest, sanitized);
    return manifest;
}

function sanitizePaperImageRecovery(paper) {
    if (!paper || typeof paper !== 'object') return paper;
    for (const key of ['analysisRecoveryImageManifest', 'imageManifest']) {
        if (!paper[key]) continue;
        const sanitized = sanitizeImageManifestHttpsOnly(paper[key]);
        if (sanitized) paper[key] = sanitized;
        else delete paper[key];
    }
    for (const key of ['imageUrls', 'allImageUrls']) {
        if (!Array.isArray(paper[key])) continue;
        paper[key] = paper[key].flatMap(item => {
            const sanitized = sanitizeImageManifestRecords([item]);
            if (sanitized.length === 0) return [];
            return [typeof item === 'string' ? sanitized[0].url : sanitized[0]];
        });
    }
    if (Array.isArray(paper.selectedImageUrls)) {
        paper.selectedImageUrls = sanitizeSelectedImageUrls(paper.selectedImageUrls);
    }
    return paper;
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
        if (!detectedMime && imageUrl.startsWith('data:image/svg+xml')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) {
            mime = 'image/jpeg';
        } else if (!detectedMime && lower.endsWith('.svg')) {
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

/**
 * 部分兼容 Anthropic 协议的多模态端点会拒绝浏览器可正常解码的 PNG
 * （常见于带透明通道或非常规 PNG chunk）。只在端点明确报告图片损坏后，
 * 将请求载荷铺白底并转为标准 RGB JPEG；原始缓存、URL 和正文引用保持不变。
 */
async function normalizeModelImagePayload(image) {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const source = Buffer.from(String(image?.base64 || ''), 'base64');
    if (source.length === 0) throw new Error('图片 base64 为空');
    const decoded = await loadImage(source);
    if (!decoded.width || !decoded.height) throw new Error('图片尺寸无效');
    const canvas = createCanvas(decoded.width, decoded.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, decoded.width, decoded.height);
    context.drawImage(decoded, 0, 0, decoded.width, decoded.height);
    const encoded = canvas.toBuffer('image/jpeg', 90);
    return {
        ...image,
        base64: encoded.toString('base64'),
        mime: 'image/jpeg',
        modelPayloadNormalized: true
    };
}

function isCorruptedMultimodalError(error) {
    return /multimodal data is corrupted|image.*(?:corrupt|cannot be processed)/i.test(String(error?.message || error || ''));
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
const IMAGE_NARRATIVE_CONTRACT_VERSION = 'context-bound-v1';

const GENERIC_IMAGE_NARRATIVE_PATTERNS = Object.freeze([
    /论文的关键实验比较.*读图时需同时保留正文列出的数据集、指标方向和实验条件/,
    /这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论/,
    /论文的系统结构或处理流程.*组件职责和数据流逐项对照/,
    /图中的箭头和分支用于说明已披露的组件关系，不代表正文未声明的额外训练阶段/,
    /论文的实现细节或数据示例.*核对实现条件与适用边界/,
    /图示用于补足实现语境，不替代论文未报告的配置、消融或部署测量/
]);

const IMAGE_NARRATIVE_STOP_TERMS = new Set([
    '下图', '图中', '论文', '方法', '结果', '实验', '模型', '系统', '数据', '说明', '展示',
    '比较', '核对', '边界', '条件', '结论', '结构', '流程', '可见', '支持', '不能'
]);

function imageNarrativeTerms(text) {
    const value = String(text || '').normalize('NFKC').toLowerCase();
    const terms = new Set();
    for (const match of value.matchAll(/[a-z][a-z0-9_.+-]{2,}|\d+(?:\.\d+)?%?/g)) {
        if (!IMAGE_NARRATIVE_STOP_TERMS.has(match[0])) terms.add(match[0]);
    }
    for (const match of value.matchAll(/[\u4e00-\u9fff]{4,}/g)) {
        const run = match[0];
        for (let index = 0; index <= run.length - 4; index++) {
            const term = run.slice(index, index + 4);
            if (!IMAGE_NARRATIVE_STOP_TERMS.has(term)) terms.add(term);
        }
    }
    return terms;
}

function imageNarrativeHasOverlap(source, narrative) {
    const sourceTerms = imageNarrativeTerms(source);
    const narrativeTerms = imageNarrativeTerms(narrative);
    return [...sourceTerms].some(term => narrativeTerms.has(term));
}

function validateImageNarrativeContext(lead, explanation, context = {}) {
    const normalizedLead = sanitizeImagePlanText(lead, 220);
    const normalizedExplanation = sanitizeImagePlanText(explanation, 320);
    if (!normalizedLead) return 'missing_lead';
    if (!normalizedExplanation) return 'missing_explanation';
    if (!/[\u4e00-\u9fff]/.test(normalizedLead)
        || !/[\u4e00-\u9fff]/.test(normalizedExplanation)) return 'non_chinese_context';
    if (normalizedLead.length < 18 || normalizedExplanation.length < 30) return 'context_too_short';
    if (!/(?:下图|如下图)/.test(normalizedLead)
        || !/(?:核对|观察|比较|追踪|辨认|判断|查看|阅读重点|验证)/.test(normalizedLead)) {
        return 'lead_missing_reading_task';
    }
    if (GENERIC_IMAGE_NARRATIVE_PATTERNS.some(pattern => (
        pattern.test(normalizedLead) || pattern.test(normalizedExplanation)
    ))) return 'generic_boilerplate';
    if (!/(?:图中|曲线|热图|色块|箭头|分支|波形|语谱图|频谱|样例|柱状|散点|轨迹|矩阵|流程)/.test(normalizedExplanation)) {
        return 'explanation_missing_visible_evidence';
    }
    if (!/(?:仅|只|不能|不等于|不直接|未|边界|条件|范围|限于|仍需)/.test(normalizedExplanation)) {
        return 'explanation_missing_conclusion_boundary';
    }
    if (context.anchorText && !imageNarrativeHasOverlap(context.anchorText, normalizedLead)) {
        return 'lead_not_bound_to_anchor';
    }
    if (context.conclusionText
        && !imageNarrativeHasOverlap(context.conclusionText, normalizedExplanation)) {
        return 'explanation_not_bound_to_conclusion';
    }
    return null;
}

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
        const conclusionParagraphId = sanitizeImagePlanText(
            item.conclusion_paragraph_id || item.conclusionParagraphId,
            40
        );
        const anchor = sanitizeImagePlanText(item.anchor, 180);
        if (item.replacement || item.replaceAnchorWith || item.rewrite) diagnostics.replacementIgnored++;
        const lead = sanitizeImagePlanText(item.lead || item.before || item.intro, 220);
        const explanation = sanitizeImagePlanText(item.explanation || item.after || item.note, 320);
        const legacyNarrative = !paragraphId && Boolean(anchor);
        const narrativeIssue = legacyNarrative
            ? null
            : validateImageNarrativeContext(lead, explanation);
        if (narrativeIssue) {
            reject(`item_${itemIndex + 1}:${narrativeIssue}`);
            continue;
        }

        used.add(imageNumber);
        plans.push({
            imageNumber,
            section,
            paragraphId,
            conclusionParagraphId,
            anchor,
            legacyNarrative,
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
        `(^|\\n)((#{2,3})\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return null;
    const start = match.index + match[1].length;
    const contentStart = start + match[2].length;
    const rest = analysis.slice(contentStart);
    // A nested ### reader subsection belongs to its surrounding ## fixed
    // section.  Stop only at a heading of the same or a higher level; the old
    // #{2,3} boundary silently hid every paragraph after the first ### from
    // the image-anchor catalog.
    const level = match[3].length;
    const next = new RegExp(`\\n#{2,${level}}\\s`).exec(rest);
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
        .trim();
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
    const alt = sanitizeMarkdownImageAlt(
        imageInfo.displayCaption || imageInfo.caption,
        `图${plan.imageNumber}`
    );
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
    const anchorEntries = buildImageAnchorCatalog(analysis);
    const anchorCatalog = new Map(anchorEntries.map((entry, index) => [entry.id, { ...entry, order: index }]));
    const resolvedPlans = plans.map(plan => {
        if (!plan.paragraphId) return plan;
        const entry = anchorCatalog.get(plan.paragraphId);
        if (!entry || entry.section !== plan.section) {
            return { ...plan, anchorResolutionError: 'paragraph_id_not_found' };
        }
        if (plan.legacyNarrative === true) {
            return { ...plan, anchor: entry.text };
        }
        if (!plan.conclusionParagraphId) {
            return { ...plan, anchorResolutionError: 'conclusion_paragraph_id_required' };
        }
        const conclusionEntry = anchorCatalog.get(plan.conclusionParagraphId);
        if (!conclusionEntry || conclusionEntry.section !== plan.section
            || conclusionEntry.order < entry.order) {
            return { ...plan, anchorResolutionError: 'conclusion_paragraph_id_not_found' };
        }
        const narrativeIssue = validateImageNarrativeContext(plan.lead, plan.explanation, {
            anchorText: entry.text,
            conclusionText: conclusionEntry.text
        });
        if (narrativeIssue) return { ...plan, anchorResolutionError: narrativeIssue };
        return {
            ...plan,
            anchor: entry.text,
            conclusion: conclusionEntry.text
        };
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

    const buildSupplementContent = images => [
        { type: 'text', text: supplementPrompt },
        ...images.map(img => buildImageContent(img.url, img.base64, img.mime))
    ];
    let requestImages = downloadedImages;
    let supplementContent = buildSupplementContent(requestImages);

    console.log(`    [secondary]    request_content_blocks=${supplementContent.length} | text_chars=${supplementPrompt.length}`);
    const secondaryBudget = createActiveTimeBudget(Number.MAX_SAFE_INTEGER);
    let planText;
    let normalizedInputCount = 0;
    try {
        try {
            planText = await callModelWithConfig(
                [{ role: 'user', content: supplementContent }],
                API_MAX_TOKENS, API_MAX_RETRIES, { ...SECONDARY_CONFIG, temperature: IMAGE_PLAN_TEMPERATURE }
            );
        } catch (error) {
            if (!isCorruptedMultimodalError(error)) throw error;
            console.log(`    [secondary] ⚠️  端点拒绝原始图片载荷，标准化为 RGB JPEG 后重试`);
            requestImages = await Promise.all(downloadedImages.map(normalizeModelImagePayload));
            normalizedInputCount = requestImages.length;
            supplementContent = buildSupplementContent(requestImages);
            const normalizedBase64Chars = requestImages.reduce((sum, img) => sum + img.base64.length, 0);
            console.log(`    [secondary]    normalized_images=${normalizedInputCount} | mime=image/jpeg | base64_chars=${normalizedBase64Chars}`);
            planText = await callModelWithConfig(
                [{ role: 'user', content: supplementContent }],
                API_MAX_TOKENS, API_MAX_RETRIES, { ...SECONDARY_CONFIG, temperature: IMAGE_PLAN_TEMPERATURE }
            );
        }
    } finally {
        secondaryBudget.stop();
    }

    const parsedPlans = parseImageInsertionPlan(planText, usableImageInfos);
    const plans = parsedPlans.filter(plan => plan.legacyNarrative !== true);
    if (plans.length !== parsedPlans.length) {
        parsedPlans.diagnostics.rejectedItems += parsedPlans.length - plans.length;
        parsedPlans.diagnostics.acceptedItems = plans.length;
        parsedPlans.diagnostics.rejectionReasons.push('legacy_anchor_format_not_allowed');
        parsedPlans.diagnostics.status = plans.length > 0 ? 'ok' : 'all_items_rejected';
    }
    const responseSha256 = crypto.createHash('sha256').update(planText).digest('hex');
    const parseDiagnostics = parsedPlans.diagnostics
        || { status: 'unknown', rejectedItems: 0, replacementIgnored: 0, rejectionReasons: [] };
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
                normalizedInputCount,
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
            normalizedInputCount,
            promptSha256,
            responseSha256,
            plans: plans.map(plan => ({ ...plan })),
            insertionDiagnostics
        }
    };
}

/**
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper) {
    const { withLlmUsageContext } = require('./lib/llm-usage.js');
    const fresh = require('./lib/fresh-analysis-context.js');
    return fresh.withFreshPaperContext(paper, () => withLlmUsageContext(
        { paperId: getPaperArxivId(paper) }, () => analyzePaperDeepInternal(paper)
    ));
}

async function analyzePaperDeepInternal(paper) {
    stripManualAnalysisProvenance(paper);
    sanitizePaperImageRecovery(paper);
    const arxivId = getPaperArxivId(paper);
    const conferenceSource = require('./lib/conference-analysis-context.js').getConferenceAnalysisSource(paper);
    const previousScore = Number.parseFloat(paper?.parsed?.score);
    const analysisManifest = createAnalysisRecoveryManifest(paper);
    console.log(`    [deep] 获取全文: ${arxivId}`);

    // 优先使用预提供的全文（ICML/会议场景），否则从 arXiv 抓取
    let fullText = conferenceSource?.text || paper.fullText || paper.pdfText || '';
    let sourceDetails = conferenceSource || {
        source: fullText ? (paper.fullText ? 'provided_full_text' : 'provided_pdf_text') : 'unavailable',
        sourceId: '',
        imageInfos: [],
        htmlAvailability: 'unknown',
        htmlAttempts: 0,
        warnings: []
    };
    let sourceFetchError = null;
    if (!fullText && /^\d+\.\d+/.test(arxivId)) {
        try {
            sourceDetails = await fetchArxivTextDetailed(arxivId);
            fullText = sourceDetails.text;
            if (!fullText && sourceDetails.failureClass === 'transient') {
                sourceFetchError = new Error(sourceDetails.failureError || 'arXiv 全文抓取瞬时失败');
                sourceFetchError.code = 'ARXIV_SOURCE_TRANSIENT_FAILURE';
            }
            console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
        } catch (e) {
            if (require('./lib/fresh-analysis-context.js').getFreshAnalysisContext()) throw e;
            sourceFetchError = e;
            sourceDetails.warnings.push(`全文抓取异常: ${e.message}`);
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }
    } else if (fullText) {
        console.log(`    [deep] 使用预提供全文: ${fullText.length} 字符`);
    }

    require('./lib/fresh-analysis-context.js').attachFreshSourceProvenance(paper, analysisManifest, sourceDetails);

    const hasFullText = fullText.length > FULL_TEXT_MIN_CHARS_FOR_FULL;
    const abstractText = paper.abstract || paper.summary || '';
    const rawTextForAnalysis = hasFullText ? fullText : (abstractText || fullText);
    const textForAnalysis = buildTaskEvidenceContext(
        rawTextForAnalysis,
        FULL_TEXT_MAX_CHARS,
        BROAD_EVIDENCE_PATTERNS,
        'PRIMARY'
    );
    if (rawTextForAnalysis.length > textForAnalysis.length) {
        sourceDetails.warnings.push(`输入文本由 ${rawTextForAnalysis.length} 字符按跨全文任务证据取样为 ${textForAnalysis.length} 字符`);
        console.log(`    [deep] 全文过长，跨开头/中段/末尾和高价值证据取样到 ${textForAnalysis.length}/${rawTextForAnalysis.length} 字符`);
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
        usedTextSha256: crypto.createHash('sha256').update(textForAnalysis).digest('hex'),
        analysisConfidence: hasFullText ? 'full_text' : 'degraded_abstract',
        htmlAvailability: sourceDetails.htmlAvailability,
        htmlAttempts: sourceDetails.htmlAttempts,
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        warnings: sourceWarnings
    };
    const previousSource = analysisManifest.sourceAcquisition;
    if (shouldRetainFullTextCheckpoint(paper, previousSource, hasFullText, sourceFetchError)) {
        const error = `全文临时不可用，已保留全文 checkpoint: ${sourceFetchError.message}`;
        console.log(`    [deep] ⚠️  ${error}`);
        analysisManifest.sourceAcquisitionLatestFailure = {
            attemptedAt: getBeijingISOString(),
            error: sourceFetchError.message,
            retainedSource: previousSource
        };
        saveAnalysisCheckpoint(
            paper,
            paper.analysisCheckpoint,
            analysisManifest,
            paper.analysisRecoveryImageManifest || paper.imageManifest || null
        );
        return {
            ...paper,
            analysis: null,
            parsed: null,
            analysisManifest,
            analysisCheckpoint: paper.analysisCheckpoint,
            imageManifest: paper.analysisRecoveryImageManifest || null,
            sourceWarnings: [...(paper.sourceWarnings || []), error],
            error
        };
    }
    if (sourceFetchError) {
        const error = `全文瞬时不可用，等待正常重试: ${sourceFetchError.message}`;
        analysisManifest.sourceAcquisitionLatestFailure = {
            attemptedAt: getBeijingISOString(),
            error: sourceFetchError.message,
            retainedSource: previousSource || null
        };
        return {
            ...paper,
            analysis: null,
            parsed: null,
            analysisManifest,
            imageManifest: paper.analysisRecoveryImageManifest || null,
            sourceWarnings: [...(paper.sourceWarnings || []), error],
            error
        };
    }
    Object.assign(paper, sourceProvenance, { sourceWarnings });
    delete analysisManifest.sourceAcquisitionLatestFailure;
    const actualAnalysisInputChanged = hasActualAnalysisInputChanged(previousSource, sourceProvenance);
    if (actualAnalysisInputChanged) {
        invalidateSourceBoundImageRecovery(paper);
    }
    if (paper.analysisCheckpoint && actualAnalysisInputChanged) {
        for (const stage of RECOVERY_STAGE_ORDER) delete analysisManifest.stages[stage];
        delete paper.analysisCheckpoint;
        delete paper.analysisStageCheckpoints;
        console.log(`    [deep] ⚠️  checkpoint 实际分析输入指纹变化，已清除主分析及下游恢复状态`);
    }
    analysisManifest.sourceAcquisition = sourceProvenance;
    const recoveryFingerprints = buildRecoveryFingerprints(paper, textForAnalysis, arxivId);
    if (migrateSealedSourceOnlyReaderBeforeAnalysis(
        paper,
        analysisManifest,
        recoveryFingerprints.apiReaderArticle,
        rawTextForAnalysis,
        sourceDetails.structuredArtifacts,
        arxivId
    )) {
        console.log('    [deep] ♻️  已在主分析重跑前封口 source-only Reader，避免重复生成');
    }
    const migratedCoreSummaryV3 = tryMigrateCoreSummaryV3LegacyCheckpoints(
        paper,
        analysisManifest,
        textForAnalysis,
        rawTextForAnalysis,
        arxivId,
        recoveryFingerprints.primaryAnalysis
    );
    if (!migratedCoreSummaryV3) {
        invalidateRecoveryStageIfChanged(
            paper, analysisManifest, 'primaryAnalysis', recoveryFingerprints.primaryAnalysis
        );
    }
    invalidateRecoveryStageIfChanged(
        paper, analysisManifest, 'demoLinkScan', recoveryFingerprints.demoLinkScan
    );
    // 已完成的后处理阶段必须用当时上游 checkpoint 和完整正文重新构造
    // 实际有界证据后再校验指纹。这里在恢复主分析正文之前完成失效传播，
    // 避免缺少前序快照的异常 manifest 在本轮中继续使用陈旧下游正文。
    for (const stage of RECOVERY_STAGE_ORDER.filter(item => TEXT_RECOVERY_STAGE_CONFIG[item])) {
        if (!isRecoveryStageComplete(analysisManifest, stage)) continue;
        prepareTextRecoveryStage(
            paper,
            analysisManifest,
            stage,
            paper.analysisCheckpoint || '',
            rawTextForAnalysis
        );
    }
    console.log(`    [deep] 文本来源: ${analysisSource} | chars=${rawTextForAnalysis.length} | confidence=${sourceProvenance.analysisConfidence} | warnings=${sourceWarnings.length}`);

    if (!textForAnalysis || textForAnalysis.trim().length < 10) {
        console.log(`    [deep] ⚠️  论文无有效文本内容（全文和摘要均为空），无法分析`);
        return { ...paper, ...sourceProvenance, sourceWarnings, analysis: null, analysisManifest, error: '论文无有效文本内容' };
    }

    // 优先使用预提供的图片 URL（ICML/会议场景），否则从 arXiv 抓取
    let imageInfos = [];
    let imageDiscoveryError = null;
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
            imageDiscoveryError = e;
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
            ...(info.cachePath ? { cachePath: info.cachePath } : {}),
            ...(info.mime ? { mime: info.mime } : {}),
            ...(info.sha256 ? { sha256: info.sha256 } : {}),
            ...(typeof info.cacheHit === 'boolean' ? { cacheHit: info.cacheHit } : {}),
            sourceOrder: Number.isInteger(info.sourceOrder) ? info.sourceOrder : index,
            score: Number.isFinite(info.candidateScore)
                ? info.candidateScore
                : scoreImageCandidate(info, Number.isInteger(info.sourceOrder) ? info.sourceOrder : index),
            downloadPriority: candidateRankByUrl.get(info.url) || null,
            selectedForDownload: candidateUrlSet.has(info.url)
        })),
        downloaded: [],
        selected: sanitizeSelectedImageUrls(
            (paper?.analysisRecoveryImageManifest || paper?.imageManifest)?.selected
        )
    };
    markRecoveryStage(
        analysisManifest,
        'imageDiscovery',
        classifyImageDiscoveryStatus(imageInfos, imageDiscoveryError),
        {
            totalFound: imageInfos.length,
            candidateCount: candidateImageInfos.length,
            ...(imageDiscoveryError ? { error: imageDiscoveryError.message, errorCode: imageDiscoveryError.code || '' } : {})
        }
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
    const downloadStatus = imageDiscoveryError
        ? 'transient_failure'
        : !isDualModel
        ? 'skipped'
        : candidateImageUrls.length === 0
            ? 'no_candidates'
            : downloadOutcomes.some(item => item.status === 'transient_failure')
                ? 'transient_failure'
                : downloadedImages.length > 0
                    ? 'complete'
                    : 'no_downloadable_images';
    const imageDownloadFingerprint = stableFingerprint({
        enabled: isDualModel,
        secondary: modelFingerprint(SECONDARY_CONFIG, IMAGE_PLAN_TEMPERATURE),
        candidates: candidateImageInfos.map(info => ({ url: info.url, caption: info.caption || '' })),
        imageCandidateMax: IMAGE_CANDIDATE_MAX,
        imageMaxCount: IMAGE_MAX_COUNT,
        imageMaxBytes: IMAGE_MAX_BYTES,
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS
    });
    markRecoveryStage(analysisManifest, 'imageDownload', downloadStatus, {
        attempted: candidateImageUrls.length,
        downloaded: downloadedImages.length,
        outcomes: downloadOutcomes,
        fingerprint: imageDownloadFingerprint
    });
    if (imageDiscoveryError) {
        return persistImageDiscoveryFailure(
            paper,
            sourceProvenance,
            sourceWarnings,
            analysisManifest,
            imageManifest,
            imageDiscoveryError
        );
    }
    saveAnalysisCheckpoint(paper, paper.analysisCheckpoint || '', analysisManifest, imageManifest);

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
                API_MAX_TOKENS, API_MAX_RETRIES, { ...DEEP_CONFIG, usageContext: { stage: 'primaryAnalysis' } }
            );
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', { fingerprint: recoveryFingerprints.primaryAnalysis });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 主模型文本分析完成 (${analysis.length} chars)`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 主模型文本分析失败: ${err.message}`);
            return {
                ...paper, ...sourceProvenance, sourceWarnings,
                analysis: null, analysisManifest, imageManifest,
                error: err.message,
                errorCode: err.code || null,
                errorRetryable: err.retryable !== false
            };
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
                API_MAX_TOKENS, { usageContext: { stage: 'primaryAnalysis' } }
            );
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', { fingerprint: recoveryFingerprints.primaryAnalysis });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 文本分析完成`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 文本分析失败: ${err.message}`);
            return {
                ...paper, ...sourceProvenance, sourceWarnings,
                analysis: null, analysisManifest, imageManifest,
                error: err.message,
                errorCode: err.code || null,
                errorRetryable: err.retryable !== false
            };
        }
    }

    let selectedImageUrls = [...imageManifest.selected];

    // 第2轮：开源扫描
    const openSourceStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'openSourceScan',
        analysis,
        rawTextForAnalysis
    );
    analysis = openSourceStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'openSourceScan')) {
        try {
            const ossText = await scanOpensource(
                paper,
                rawTextForAnalysis,
                openSourceStage.evidenceContext
            );
            if (ossText) {
                analysis = mergeSectionByTitle(analysis, '开源详情', ossText);
                analysis = syncResourceFieldsFromOpenSource(analysis, ossText);
                console.log(`    [deep] ✅ 开源扫描完成`);
            }
            markRecoveryStage(analysisManifest, 'openSourceScan', ossText ? 'complete' : 'invalid_output', {
                evidenceChars: openSourceStage.evidenceChars,
                evidenceSha256: openSourceStage.evidenceSha256,
                inputAnalysisSha256: openSourceStage.inputAnalysisSha256,
                fingerprint: openSourceStage.fingerprint
            });
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
            markRecoveryStage(analysisManifest, 'demoLinkScan', 'complete', {
                linksFound: demoFoundLinks.length,
                discoveredLinks: demoFoundLinks,
                fingerprint: recoveryFingerprints.demoLinkScan
            });
        }
        saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        if (demoScanError) throw demoScanError;
    }

    // 第3轮：审校重写（对照原文修正、补充、删减，完全重写前两轮输出）
    const revisionStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'revision',
        analysis,
        rawTextForAnalysis
    );
    analysis = revisionStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'revision')) {
        try {
            const revisedText = await reviseAnalysis(
                paper,
                analysis,
                rawTextForAnalysis,
                revisionStage.evidenceContext
            );
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
            markRecoveryStage(analysisManifest, 'revision', 'complete', {
                evidenceChars: revisionStage.evidenceChars,
                evidenceSha256: revisionStage.evidenceSha256,
                inputAnalysisSha256: revisionStage.inputAnalysisSha256,
                fingerprint: revisionStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 审校重写完成`);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'revision', e.code === 'INVALID_STAGE_OUTPUT' ? 'invalid_output' : 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.5轮：检查并修复实验结果中缺失的表格
    const tableRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'tableRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = tableRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'tableRepair')) {
        try {
            const fixed = await checkAndFixTables(
                paper,
                analysis,
                rawTextForAnalysis,
                tableRepairStage.evidenceContext
            );
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 表格补充完成`);
            }
            markRecoveryStage(analysisManifest, 'tableRepair', changed ? 'complete' : 'not_needed', {
                evidenceChars: tableRepairStage.evidenceChars,
                evidenceSha256: tableRepairStage.evidenceSha256,
                inputAnalysisSha256: tableRepairStage.inputAnalysisSha256,
                fingerprint: tableRepairStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'tableRepair', 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.6轮：检查并修复方法概述部分不够详细的问题
    const methodRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'methodRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = methodRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'methodRepair')) {
        try {
            const fixed = await checkAndFixMethodSection(
                paper,
                analysis,
                rawTextForAnalysis,
                methodRepairStage.evidenceContext
            );
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 方法概述补充完成`);
            }
            markRecoveryStage(analysisManifest, 'methodRepair', changed ? 'complete' : 'not_needed', {
                evidenceChars: methodRepairStage.evidenceChars,
                evidenceSha256: methodRepairStage.evidenceSha256,
                inputAnalysisSha256: methodRepairStage.inputAnalysisSha256,
                fingerprint: methodRepairStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(
                analysisManifest,
                'methodRepair',
                e.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure',
                { error: e.message }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 第3.65轮：修复缺失/重复章节、机器摘要和标签契约。
    const structureRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'structureRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = structureRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'structureRepair')) {
        const preNormalizationIssues = getRepairableAnalysisStructureIssues(analysis, { sourceText: rawTextForAnalysis });
        const normalizedStructure = normalizeAnalysisStructure(analysis);
        const normalizedChanged = normalizedStructure !== analysis;
        if (normalizedChanged) {
            analysis = normalizedStructure;
            console.log(`    [deep] ✅ 已确定性规范化结构 | categories=${sanitizeLogField(preNormalizationIssues.join('、') || '空白/数值表示', 500)}`);
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        }
        const structureIssues = getRepairableAnalysisStructureIssues(analysis, { sourceText: rawTextForAnalysis });
        try {
            if (structureIssues.length > 0) {
                console.log(`    [deep] 🔧 检测到结构契约问题，执行最终结构修复: ${structureIssues.join('、')}`);
                analysis = await repairMissingAnalysisSections(
                    paper,
                    analysis,
                    rawTextForAnalysis,
                    structureRepairStage.evidenceContext
                );
                const postRepairIssues = getRepairableAnalysisStructureIssues(analysis, { sourceText: rawTextForAnalysis });
                if (postRepairIssues.length > 0) {
                    const error = new Error(`最终结构修复后的分析仍未通过结构契约: ${postRepairIssues.join('、')}`);
                    error.code = 'CONTRACT_REJECTED';
                    throw error;
                }
                console.log(`    [deep] ✅ 最终结构修复完成`);
            }
            // 结构修复模型会重写完整正文，偶尔把前一阶段已达标的方法章节
            // 压缩回短摘要。这里在最终拒绝前重新走一次方法补充，避免让
            // 一个下游修复阶段破坏已满足 detailed-v1 的上游契约。
            const finalization = await finalizeStructureRepairOutput(
                paper,
                analysis,
                rawTextForAnalysis
            );
            analysis = finalization.analysis;
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                experimentTables: EXPERIMENT_TABLE_CONTRACT_VERSION,
                methodDetail: METHOD_DETAIL_CONTRACT_VERSION,
                editorialLeakage: ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION
            };
            markRecoveryStage(
                analysisManifest,
                'structureRepair',
                structureIssues.length > 0 || finalization.methodRepaired ? 'complete' : 'not_needed',
                {
                    deterministicNormalization: normalizedChanged,
                    normalizationIssues: preNormalizationIssues,
                    evidenceChars: structureRepairStage.evidenceChars,
                    evidenceSha256: structureRepairStage.evidenceSha256,
                    inputAnalysisSha256: structureRepairStage.inputAnalysisSha256,
                    outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                    fingerprint: structureRepairStage.fingerprint
                }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'structureRepair',
                recoveryFailureStatus(error),
                { error: error.message }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 第3.66轮：结构修复之后执行核心摘要最终门禁。结构修复可能为补齐标题
    // 重写整篇 canonical，因此摘要合同不能在它之前封口。这里始终只替换
    // `核心摘要` 的 section body，并逐字校验其余 12 节没有变化。
    let coreSummaryRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'coreSummaryRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = coreSummaryRepairStage.analysis;
    if (isRecoveryStageComplete(analysisManifest, 'coreSummaryRepair')
        && getCoreSummaryDetailIssue(analysis, { sourceText: rawTextForAnalysis })) {
        invalidateRecoveryStageIfChanged(
            paper,
            analysisManifest,
            'coreSummaryRepair',
            `${coreSummaryRepairStage.fingerprint}:invalid-${CORE_SUMMARY_CONTRACT_VERSION}`
        );
        analysis = paper.analysisCheckpoint || coreSummaryRepairStage.inputAnalysis;
        coreSummaryRepairStage = prepareTextRecoveryStage(
            paper,
            analysisManifest,
            'coreSummaryRepair',
            analysis,
            rawTextForAnalysis
        );
        analysis = coreSummaryRepairStage.analysis;
    }
    if (!isRecoveryStageComplete(analysisManifest, 'coreSummaryRepair')) {
        const missingCoreSummary = getMissingRequiredSections(analysis).includes('核心摘要');
        const duplicateCoreSummary = getDuplicateRequiredSections(analysis).includes('核心摘要');
        const summaryIssue = getCoreSummaryDetailIssue(analysis, { sourceText: rawTextForAnalysis });
        try {
            if (missingCoreSummary || duplicateCoreSummary) {
                throw contractRejectedError(
                    '结构修复完成后核心摘要仍缺失或重复，拒绝用单节修复掩盖结构错误'
                );
            }
            let changed = false;
            if (summaryIssue) {
                console.log(`    [deep] 🔧 核心摘要执行结构后单节修复: ${summaryIssue}`);
                const fixed = await repairCoreSummarySection(
                    paper,
                    analysis,
                    rawTextForAnalysis,
                    coreSummaryRepairStage.evidenceContext
                );
                changed = fixed !== analysis;
                analysis = fixed;
                console.log('    [deep] ✅ 核心摘要最终门禁通过，其他 12 节字节保持不变');
            }
            const sealedSummaryIssue = getCoreSummaryDetailIssue(
                analysis,
                { sourceText: rawTextForAnalysis }
            );
            if (sealedSummaryIssue) {
                throw contractRejectedError(`核心摘要最终门禁失败: ${sealedSummaryIssue}`);
            }
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                coreSummary: CORE_SUMMARY_CONTRACT_VERSION
            };
            const summaryInput = extractSectionByTitle(
                coreSummaryRepairStage.inputAnalysis, '核心摘要'
            );
            const summaryOutput = extractSectionByTitle(analysis, '核心摘要');
            const summaryBinding = {
                contractVersion: CORE_SUMMARY_CONTRACT_VERSION,
                inputAnalysisSha256: coreSummaryRepairStage.inputAnalysisSha256,
                outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                inputSummarySha256: crypto.createHash('sha256').update(summaryInput).digest('hex'),
                summarySha256: crypto.createHash('sha256').update(summaryOutput).digest('hex'),
                inputStructureProjectionSha256: coreSummaryProjectionSha256(
                    coreSummaryRepairStage.inputAnalysis
                ),
                outputStructureProjectionSha256: coreSummaryProjectionSha256(analysis)
            };
            markRecoveryStage(analysisManifest, 'coreSummaryRepair', changed ? 'complete' : 'not_needed', {
                contractVersion: CORE_SUMMARY_CONTRACT_VERSION,
                targetMinimumChineseChars: CORE_SUMMARY_MIN_CHINESE_CHARS,
                targetMaximumChineseChars: CORE_SUMMARY_MAX_CHINESE_CHARS,
                targetMinimumSentences: CORE_SUMMARY_MIN_SENTENCES,
                targetMaximumSentences: CORE_SUMMARY_MAX_SENTENCES,
                evidenceChars: coreSummaryRepairStage.evidenceChars,
                evidenceSha256: coreSummaryRepairStage.evidenceSha256,
                inputAnalysisSha256: coreSummaryRepairStage.inputAnalysisSha256,
                ...summaryBinding,
                bindingSha256: stableFingerprint(summaryBinding),
                fingerprint: coreSummaryRepairStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'coreSummaryRepair',
                recoveryFailureStatus(error),
                { error: error.message, fingerprint: coreSummaryRepairStage.fingerprint }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 第3.7轮：在评分前先把开源状态收敛到真实网络验证结果。只有
    // SSRF/重定向验证成功的 2xx/3xx 资源才能支撑“可用”声明；超时/5xx
    // 保留为 retryable 暂不可达，不把整篇永久判死。
    const structuralAnalysis = typeof paper.analysisStageCheckpoints?.coreSummaryRepair === 'string'
        ? paper.analysisStageCheckpoints.coreSummaryRepair
        : analysis;
    const verifiedReaderResources = await buildApiReaderResourceIdentity(
        structuralAnalysis, rawTextForAnalysis, analysisManifest.stages.demoLinkScan
    );
    paper.apiReaderResources = verifiedReaderResources;
    const scoringInputAnalysis = applyApiReaderResourceAvailability(
        structuralAnalysis, paper.apiReaderResources
    );
    analysisManifest.stages.openSourceScan.resourceEvidenceContract =
        API_READER_RESOURCE_IDENTITY_CONTRACT;
    analysisManifest.stages.openSourceScan.resourceEvidenceSha256 =
        paper.apiReaderResources.identitySha256;

    // 主模型只审计文档类型和八维评分，避免长文审校时发生重复扣分。
    const scoringStage = analysisManifest.stages.scoringAudit;
    const scoringInputSha256 = crypto.createHash('sha256').update(scoringInputAnalysis).digest('hex');
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit',
        scoringInputAnalysis,
        rawTextForAnalysis
    );
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const currentPromptTemplateSha256 = runtimePromptTemplateSha256('prompts/scoring-audit.md');
        const currentEvidenceSha256 = crypto.createHash('sha256')
            .update(scoringEvidenceContext)
            .digest('hex');
        const fingerprintChanged = scoringStage.model !== DEEP_CONFIG.model
            || scoringStage.protocol !== detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model)
            || scoringStage.endpointSha256 !== crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex')
            || scoringStage.maxTokens !== 16000
            || scoringStage.maxResponseBytes !== API_MAX_RESPONSE_BYTES
            || scoringStage.temperature !== SCORING_AUDIT_TEMPERATURE
            || scoringStage.promptTemplateSha256 !== currentPromptTemplateSha256
            || scoringStage.scoringInputSha256 !== scoringInputSha256
            || scoringStage.coreSummaryInputAnalysisSha256
                !== analysisManifest.stages.coreSummaryRepair?.outputAnalysisSha256
            || scoringStage.inputCoreSummarySha256 !== crypto.createHash('sha256')
                .update(extractSectionByTitle(scoringInputAnalysis, '核心摘要')).digest('hex')
            || scoringStage.outputCoreSummarySha256 !== crypto.createHash('sha256')
                .update(extractSectionByTitle(
                    String(paper.analysisStageCheckpoints?.scoringAudit || ''), '核心摘要'
                )).digest('hex')
            || scoringStage.evidenceSelectionVersion !== EVIDENCE_SELECTION_VERSION
            || scoringStage.evidenceMaxChars !== SCORING_EVIDENCE_MAX_CHARS
            || scoringStage.evidenceSha256 !== currentEvidenceSha256
            || scoringStage.scoringContract !== SCORING_AUDIT_CONTRACT
            || scoringStage.capRulesVersion !== SCORING_CAP_RULES_VERSION
            || !scoringStage.audit?.evidenceProfile
            || !scoringStabilityResolutionIsValid(scoringStage)
            || scoringStage.auditSha256 !== stableFingerprint(scoringStage.audit)
            || scoringStage.outputAnalysisSha256 !== crypto.createHash('sha256').update(
                String(paper.analysisStageCheckpoints?.scoringAudit || '')
            ).digest('hex');
        if (fingerprintChanged) {
            if (typeof paper.analysisStageCheckpoints?.coreSummaryRepair === 'string') {
                paper.analysisCheckpoint = paper.analysisStageCheckpoints.coreSummaryRepair;
                analysis = paper.analysisCheckpoint;
            } else {
                analysis = scoringInputAnalysis;
            }
            delete analysisManifest.stages.scoringAudit;
            delete analysisManifest.stages.imageSupplement;
            if (paper.analysisStageCheckpoints) {
                delete paper.analysisStageCheckpoints.scoringAudit;
                delete paper.analysisStageCheckpoints.imageSupplement;
            }
            console.log(`    [deep] ⚠️  评分审计指纹变化，已失效评分与插图；source-only Reader 保持独立`);
        }
    }
    if (!isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        try {
            let scoringResult = await auditTypeAwareScoringDetailed(
                scoringInputAnalysis,
                rawTextForAnalysis,
                { evidenceContext: scoringEvidenceContext }
            );
            analysis = scoringResult.analysis;
            const validateScoringOutput = candidateAnalysis => {
                const parsed = parseAnalysis(candidateAnalysis);
                const invalidReason = getInvalidAnalysisReason(candidateAnalysis, parsed, {
                    enforceExperimentTableContract: true,
                    experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                    enforceMethodDetailContract: true,
                    sourceText: rawTextForAnalysis
                });
                if (invalidReason) {
                    const error = new Error(`评分审计后的分析未通过最终契约: ${invalidReason}`);
                    error.code = 'CONTRACT_REJECTED';
                    throw error;
                }
                return parsed;
            };
            let auditedParsed = validateScoringOutput(analysis);
            let scoringDelta = calculateScoringDelta(
                previousScore, scoringInputAnalysis, auditedParsed?.score
            );
            const firstAuditScore = scoringDelta.finalScore;
            let stabilityResolution = {
                contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
                status: 'not_required',
                threshold: SCORING_STABILITY_THRESHOLD
            };
            let totalScoringAttempts = scoringResult.attempts;
            if (scoringDelta.scoreDelta !== null
                && Math.abs(scoringDelta.scoreDelta) > SCORING_STABILITY_THRESHOLD) {
                console.log(
                    `    [deep] ⚠️  评分稳定性告警触发独立二次审计: previous=${scoringDelta.previousScore.toFixed(1)}`
                    + ` | first=${firstAuditScore.toFixed(1)} | delta=${scoringDelta.scoreDelta > 0 ? '+' : ''}${scoringDelta.scoreDelta.toFixed(1)}`
                );
                const secondResult = await auditTypeAwareScoringDetailed(
                    scoringInputAnalysis,
                    rawTextForAnalysis,
                    { evidenceContext: scoringEvidenceContext }
                );
                const secondParsed = validateScoringOutput(secondResult.analysis);
                const secondScore = Number(secondParsed?.score);
                const scoreDifference = Math.abs(secondScore - firstAuditScore);
                const resolution = {
                    contract: SCORING_STABILITY_RESOLUTION_CONTRACT,
                    status: scoreDifference <= SCORING_STABILITY_CONSENSUS_TOLERANCE
                        ? 'resolved' : 'unresolved',
                    method: 'second_pass_consensus',
                    threshold: SCORING_STABILITY_THRESHOLD,
                    consensusTolerance: SCORING_STABILITY_CONSENSUS_TOLERANCE,
                    firstAuditScore,
                    secondAuditScore: secondScore,
                    scoreDifference,
                    firstAuditSha256: stableFingerprint(scoringResult.audit),
                    secondAuditSha256: stableFingerprint(secondResult.audit),
                    secondAttempts: secondResult.attempts
                };
                if (resolution.status !== 'resolved') {
                    const error = new Error(
                        `评分稳定性二次审计未收敛: first=${firstAuditScore.toFixed(1)}, `
                        + `second=${secondScore.toFixed(1)}, difference=${scoreDifference.toFixed(1)}`
                    );
                    error.code = 'CONTRACT_REJECTED';
                    error.stabilityResolution = resolution;
                    throw error;
                }
                scoringResult = secondResult;
                analysis = secondResult.analysis;
                auditedParsed = secondParsed;
                scoringDelta = calculateScoringDelta(
                    previousScore, scoringInputAnalysis, auditedParsed?.score
                );
                totalScoringAttempts += secondResult.attempts;
                stabilityResolution = resolution;
            }
            analysis = applyApiReaderResourceAvailability(
                analysis, verifiedReaderResources
            );
            auditedParsed = validateScoringOutput(analysis);
            scoringDelta = calculateScoringDelta(
                previousScore, scoringInputAnalysis, auditedParsed?.score
            );
            const finalScore = scoringDelta.finalScore;
            const scoreBeforeAudit = scoringDelta.previousScore;
            const scoreDelta = scoringDelta.scoreDelta;
            const stabilityWarning = scoreDelta !== null
                && Math.abs(scoreDelta) > SCORING_STABILITY_THRESHOLD;
            markRecoveryStage(analysisManifest, 'scoringAudit', 'complete', {
                attempts: totalScoringAttempts,
                model: scoringResult.model,
                protocol: scoringResult.protocol,
                endpointSha256: scoringResult.endpointSha256,
                maxTokens: scoringResult.maxTokens,
                maxResponseBytes: scoringResult.maxResponseBytes,
                temperature: scoringResult.temperature,
                promptTemplateSha256: scoringResult.promptTemplateSha256,
                scoringInputSha256,
                coreSummaryInputAnalysisSha256:
                    analysisManifest.stages.coreSummaryRepair.outputAnalysisSha256,
                inputCoreSummarySha256: crypto.createHash('sha256')
                    .update(extractSectionByTitle(scoringInputAnalysis, '核心摘要')).digest('hex'),
                evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
                evidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS,
                evidenceSha256: scoringResult.evidenceSha256,
                scoringContract: SCORING_AUDIT_CONTRACT,
                capRulesVersion: SCORING_CAP_RULES_VERSION,
                previousScore: Number.isFinite(scoreBeforeAudit) ? scoreBeforeAudit : null,
                previousRunScore: scoringDelta.previousRunScore,
                finalScore: Number.isFinite(finalScore) ? finalScore : null,
                scoreDelta,
                stabilityWarning,
                stabilityResolution,
                audit: scoringResult.audit,
                auditSha256: stableFingerprint(scoringResult.audit),
                outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                outputCoreSummarySha256: crypto.createHash('sha256')
                    .update(extractSectionByTitle(analysis, '核心摘要')).digest('hex')
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 类型感知评分审计完成`);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'scoringAudit',
                error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure',
                {
                    error: error.message,
                    ...(error.stabilityResolution
                        ? { stabilityResolution: error.stabilityResolution }
                        : {})
                }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 保留 13 节 analysis 与评分作为机器兼容层。Reader 在评分后调度，
    // 但写作输入仅用原文证据与真实像素，不传入 canonical 生成正文。
    // 因此 Reader 身份只绑定真实输入；摘要或评分变化不得触发昂贵重写。
    // Scoring/Reader invalidation may discard stale paper fields, but must not
    // discard the resource identity freshly verified for this same execution.
    paper.apiReaderResources = verifiedReaderResources;
    const apiReaderEvidenceContext = buildApiReaderEvidenceContext(
        analysis,
        rawTextForAnalysis,
        sourceDetails.structuredArtifacts,
        arxivId
    );
    const apiReaderFingerprint = buildApiReaderExecutionFingerprint(
        recoveryFingerprints.apiReaderArticle,
        apiReaderEvidenceContext,
        sourceDetails.structuredArtifacts
    );
    const legacyApiReaderFingerprint = buildLegacyAnalysisBoundApiReaderFingerprint(
        buildLegacyApiReaderV3ConfigurationFingerprint(arxivId),
        analysis, apiReaderEvidenceContext,
        sourceDetails.structuredArtifacts);
    if (migrateSourceOnlyApiReaderFingerprint(
        paper,
        analysisManifest,
        apiReaderFingerprint,
        legacyApiReaderFingerprint
    )) {
        console.log('    [deep] ♻️  Reader 原文证据未漂移，已移除无效的 canonical analysis 指纹依赖');
    }
    if (isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')) {
        if (repairApiReaderPlanSurfaceBinding(paper, analysisManifest)) {
            console.log('    [deep] ✅ 已确定性对齐读者文章与计划标题排版');
        }
        const articleSha = crypto.createHash('sha256')
            .update(String(paper.apiReaderArticle || '')).digest('hex');
        const planSha = paper.apiReaderPlan
            ? stableFingerprint(paper.apiReaderPlan)
            : '';
        const readerStage = analysisManifest.stages.apiReaderArticle;
        if (!paper.apiReaderArticle || !paper.apiReaderPlan
            || analysisManifest.contracts?.apiReaderArticle !== API_READER_ARTICLE_CONTRACT
            || paper.apiReaderPlan?.version !== API_READER_PLAN_VERSION
            || articleSha !== readerStage.articleSha256
            || planSha !== readerStage.planSha256
            || paper.apiReaderArticleSha256 !== articleSha
            || paper.apiReaderPlanSha256 !== planSha) {
            delete analysisManifest.stages.apiReaderArticle;
            delete analysisManifest.stages.imageSupplement;
            delete paper.apiReaderArticle;
            delete paper.apiReaderPlan;
            delete paper.apiReaderFigures;
            delete paper.apiReaderAuthors;
            delete paper.apiReaderResources;
            delete paper.apiReaderArticleSha256;
            delete paper.apiReaderPlanSha256;
            delete paper.analysisStageCheckpoints?.apiReaderArticle;
            delete paper.analysisStageCheckpoints?.imageSupplement;
        }
    }
    invalidateRecoveryStageIfChanged(
        paper,
        analysisManifest,
        'apiReaderArticle',
        apiReaderFingerprint
    );
    if (!isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')) {
        try {
            paper.apiReaderResources = verifiedReaderResources;
            const generatedReaderResult = await generateApiReaderArticleDetailed(
                paper, analysis, apiReaderEvidenceContext, {
                    structuredArtifacts: sourceDetails.structuredArtifacts,
                    sourceText: rawTextForAnalysis
                }
            );
            const injectedReaderResult = injectApiReaderFigures(
                generatedReaderResult,
                sourceDetails.structuredArtifacts,
                arxivId
            );
            const materializedFigures = await materializeApiReaderFigures(
                injectedReaderResult.figures, arxivId
            );
            const materializedFigureOrdinals = new Set(
                materializedFigures.map(item => item.ordinal)
            );
            const readerResult = {
                ...injectedReaderResult,
                plan: {
                    ...injectedReaderResult.plan,
                    figurePlacements: (injectedReaderResult.plan.figurePlacements || [])
                        .filter(item => materializedFigureOrdinals.has(item.figureOrdinal))
                },
                article: pruneUnmaterializedApiReaderFigureBlocks(
                    injectedReaderResult.article,
                    injectedReaderResult.figures,
                    materializedFigures
                ),
                figures: materializedFigures
            };
            paper.apiReaderArticle = readerResult.article;
            paper.apiReaderPlan = readerResult.plan;
            paper.apiReaderFigures = readerResult.figures;
            paper.apiReaderAuthors = resolveApiReaderAuthors(paper, sourceDetails);
            if (!paper.apiReaderResources
                || paper.apiReaderResources.sourceTextSha256 !== paper.sourceSha256) {
                paper.apiReaderResources = verifiedReaderResources;
            }
            analysisManifest.stages.openSourceScan.resourceEvidenceContract =
                API_READER_RESOURCE_IDENTITY_CONTRACT;
            analysisManifest.stages.openSourceScan.resourceEvidenceSha256 =
                paper.apiReaderResources.identitySha256;
            paper.apiReaderArticleSha256 = crypto.createHash('sha256')
                .update(readerResult.article).digest('hex');
            paper.apiReaderPlanSha256 = stableFingerprint(readerResult.plan);
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                apiReaderArticle: API_READER_ARTICLE_CONTRACT,
                apiReaderSourceBindings: API_READER_SOURCE_BINDING_CONTRACT,
                apiReaderAuthorIdentity: API_READER_AUTHOR_IDENTITY_CONTRACT,
                apiReaderResourceIdentity: API_READER_RESOURCE_IDENTITY_CONTRACT
            };
            markRecoveryStage(analysisManifest, 'apiReaderArticle', 'complete', {
                fingerprint: apiReaderFingerprint,
                contentMode: READER_SOURCE_CONTENT_MODE,
                attempts: readerResult.attempts,
                model: DEEP_CONFIG.model,
                protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                temperature: API_READER_INITIAL_TEMPERATURE,
                repairTemperature: API_READER_REPAIR_TEMPERATURE,
                maxTokens: API_READER_MAX_TOKENS,
                maxResponseBytes: API_MAX_RESPONSE_BYTES,
                overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
                transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES,
                promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.apiReaderArticle),
                evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
                evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
                contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
                evidenceSha256: crypto.createHash('sha256').update(apiReaderEvidenceContext).digest('hex'),
                articleSha256: paper.apiReaderArticleSha256,
                planSha256: paper.apiReaderPlanSha256,
                figureCount: readerResult.figures.length,
                figuresSha256: stableFingerprint(readerResult.figures),
                readerAuthorsSha256: stableFingerprint(paper.apiReaderAuthors),
                readerAuthorIdentityContractVersion: API_READER_AUTHOR_IDENTITY_CONTRACT,
                readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                resourceIdentityContractVersion: API_READER_RESOURCE_IDENTITY_CONTRACT,
                resourceIdentitySha256: paper.apiReaderResources.identitySha256,
                resourceCount: paper.apiReaderResources.resources.length,
                structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
                qualityMetrics: readerResult.qualityMetrics,
                qualityMetricsContractVersion: API_READER_QUALITY_METRICS_CONTRACT,
                sourceBindingsContractVersion: API_READER_SOURCE_BINDING_CONTRACT,
                sourceBindingRepairVersion: API_READER_SOURCE_BINDING_REPAIR_VERSION,
                sourceBindingsSha256: readerResult.plan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: paper.sourceSha256,
                tableBindingCount: readerResult.plan.tableBindings.length,
                formulaBindingCount: readerResult.plan.formulaBindings.length,
                parserVersion: API_READER_PARSER_VERSION,
                assemblerVersion: API_READER_ASSEMBLER_VERSION,
                tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
                figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
                imageEvidenceCount: readerResult.imageEvidence?.length || 0,
                imageEvidenceSha256: stableFingerprint(readerResult.imageEvidence || [])
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 初学研究者读者文章已生成`);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'apiReaderArticle',
                error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'invalid_output',
                { error: error.message, fingerprint: apiReaderFingerprint }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw suppressOuterRetryAfterReaderExhaustion(error);
        }
    }

    // 最后一轮：副模型基于最终文本筛选高价值图片，代码按 JSON 计划做受限局部插图合并。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const synchronized = require('./lib/reader-resource-sync.js').synchronizeReaderResourceAvailability(
            { ...paper, analysis, parsed: parseAnalysis(analysis), analysisManifest }, sourceDetails
        );
        analysis = synchronized.analysis;
        Object.assign(analysisManifest, synchronized.analysisManifest);
        if (synchronized.analysisStageCheckpoints) paper.analysisStageCheckpoints = synchronized.analysisStageCheckpoints;
        if (typeof synchronized.analysisCheckpoint === 'string') paper.analysisCheckpoint = synchronized.analysisCheckpoint;
    }
    const preImageAnalysis = isRecoveryStageComplete(analysisManifest, 'scoringAudit')
        ? String(paper.analysisStageCheckpoints?.scoringAudit || paper.analysisCheckpoint || analysis)
        : analysis;
    const imageSupplementFingerprint = buildImageSupplementFingerprint(
        recoveryFingerprints.imageSupplement,
        candidateImageInfos,
        downloadedImages,
        preImageAnalysis
    );
    invalidateRecoveryStageIfChanged(
        paper,
        analysisManifest,
        'imageSupplement',
        imageSupplementFingerprint
    );
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        analysis = preImageAnalysis;
    }
    const hasBoundApiReaderFigures = hasCompleteApiReaderFigureBinding(paper, analysisManifest);
    if (hasBoundApiReaderFigures && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        analysis = preImageAnalysis;
        selectedImageUrls = [];
        markRecoveryStage(analysisManifest, 'imageSupplement', 'skipped', {
            reason: 'api_reader_v3_official_figures_bound',
            officialFigureCount: paper.apiReaderFigures.length,
            officialFiguresSha256: stableFingerprint(paper.apiReaderFigures),
            fingerprint: imageSupplementFingerprint
        });
        console.log(
            `    [deep] ℹ️  已绑定 ${paper.apiReaderFigures.length} 张 v3 官方正文图，跳过旧副模型插图阶段`
        );
    } else if (isDualModel && downloadedImages.length > 0 && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        try {
            const imageResult = await applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages);
            const imageInvalidReason = getInvalidAnalysisReason(
                imageResult.analysis,
                parseAnalysis(imageResult.analysis),
                {
                    enforceExperimentTableContract: true,
                    experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                    enforceMethodDetailContract: true,
                    sourceText: rawTextForAnalysis
                }
            );
            if (imageInvalidReason) {
                const fallback = discardInvalidImageSupplement(
                    preImageAnalysis,
                    imageManifest,
                    imageResult,
                    imageInvalidReason
                );
                analysis = fallback.analysis;
                selectedImageUrls = fallback.selectedImageUrls;
                markRecoveryStage(analysisManifest, 'imageSupplement', 'no_high_value_images', {
                    parseStatus: imageResult.parseDiagnostics?.status || 'unknown',
                    selectedCount: 0,
                    discardedInvalidPlan: true,
                    error: imageInvalidReason,
                    fingerprint: imageSupplementFingerprint
                });
                console.log(`    [deep] ⚠️  插图结果破坏最终契约，丢弃本篇插图计划: ${imageInvalidReason}`);
            } else {
                analysis = imageResult.analysis;
                selectedImageUrls = sanitizeSelectedImageUrls(imageResult.selectedImageUrls);
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
                    rejectedInsertions: (imageResult.insertionDiagnostics || []).filter(item => !item.inserted),
                    inputAnalysisSha256: crypto.createHash('sha256')
                        .update(preImageAnalysis).digest('hex'),
                    outputAnalysisSha256: crypto.createHash('sha256')
                        .update(analysis).digest('hex'),
                    fingerprint: imageSupplementFingerprint
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
                    : undefined,
            fingerprint: imageSupplementFingerprint
        });
    }

    if (isRecoveryStageTerminal('imageSupplement', analysisManifest.stages.imageSupplement?.status)) {
        analysisManifest.contracts = {
            ...(analysisManifest.contracts || {}),
            imageNarrative: IMAGE_NARRATIVE_CONTRACT_VERSION
        };
    }

    saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
    if (hasIncompleteRecoveryStage(analysisManifest)) {
        const incompleteStages = Object.entries(analysisManifest.stages)
            .filter(([stage, details]) => !isRecoveryStageTerminal(stage, details?.status))
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
    delete paper.analysisStageCheckpoints;
    delete paper.analysisStaleSnapshots;
    delete paper.latestAnalysisAttemptError;
    delete paper.latestAnalysisAttemptAt;

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

async function scanOpensource(paper, sourceText, preparedEvidence = null) {
    const evidence = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('openSourceScan', '', sourceText);
    const prompt = loadPrompt('prompts/opensource-scan.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        textForAnalysis: evidence
    });
    return await callModel([{ role: 'user', content: prompt }], 8000,
        { usageContext: { stage: 'openSourceScan' } });
}

/**
 * 从分析文本中提取 demo/项目页面 URL
 */
function extractDemoUrls(analysis) {
    const urls = [];
    // LLM 输出常把链接后面的中文说明直接接在 URL 后面，例如
    // `https://example.github.io（提供音频示例）`。如果只排除半角空格/右括号，
    // WHATWG URL 会把全角括号和说明文字当成主机名的一部分并转换为 punycode，
    // 随后在 DNS 安全校验阶段表现为一个完全误导性的 ENOTFOUND。这里在提取阶段
    // 就截断常见的中英文句末/闭合标点，同时保留 URL 路径中的合法字符。
    // 点号、冒号和逗号可能是 URL 的合法字符，不能在正则层排除；
    // 只把空白及说明文字常用的开闭括号作为 URL 边界，末尾标点再统一清理。
    const urlSuffix = '[^\\s\\u3000\\uff08\\uff09\\u3010\\u3011\\u300c\\u300d\\u300e\\u300f]+';
    // 匹配各种可能的 demo/项目页面链接
    const patterns = [
        new RegExp(`Demo[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`项目主页[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`在线演示[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`Homepage[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`Project[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`页面[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
            const url = match[1].trim().replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
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

            // CONNECT 固定到本次校验得到的公网 IP；Host 与 TLS SNI 仍使用原始域名。
            const pageResponse = await requestPinnedPublicHttps(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeoutMs: 15000,
                maxBytes: 1024 * 1024
            });
            const contentType = String(pageResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            const data = Buffer.from(await pageResponse.arrayBuffer()).toString('utf8');
            response = contentType && !['text/html', 'application/xhtml+xml', 'application/xml', 'text/plain'].includes(contentType)
                ? { status: pageResponse.status, data: '', location: pageResponse.headers.get('location'), skipped: `Content-Type=${contentType}` }
                : { status: pageResponse.status, data, location: pageResponse.headers.get('location') };

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
            if (isTransientDemoHttpStatus(response.status)) {
                const transientError = new Error(`Demo 页面瞬时 HTTP ${response.status}`);
                transientError.code = 'DEMO_TRANSIENT_FAILURE';
                throw transientError;
            }
            return [];
        }
        
        const html = response.data;
        const foundLinks = [];
        
        for (const pattern of openSourcePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                foundLinks.push(`https://${match[0]}`);
            }
        }
        
        return [...new Set(foundLinks)];
    } catch (err) {
        console.log(`    [deep] ⚠️  访问 demo 页面失败: ${err.message}`);
        if (err.code === 'DEMO_TRANSIENT_FAILURE') throw err;
        if (err.code === 'RESPONSE_TOO_LARGE') {
            console.log('    [deep] ℹ️  Demo 页面超过 1MB 安全上限，按确定性跳过处理');
            return [];
        }
        if (/非公网|localhost|不支持的公网 URL 协议|任意公网资源只允许 HTTPS|用户名或密码|重定向超过/.test(err.message)) {
            return [];
        }
        const transientError = new Error(`Demo 页面瞬时访问失败: ${err.message}`);
        transientError.code = 'DEMO_TRANSIENT_FAILURE';
        transientError.cause = err;
        throw transientError;
    }
}

const NON_GLOBAL_IPV4_CIDRS = Object.freeze([
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]);
const NON_GLOBAL_IPV6_CIDRS = Object.freeze([
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20]
]);

function ipv4ToBigInt(address) {
    return address.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(address) {
    let normalized = String(address || '').toLowerCase();
    const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (dottedTail) {
        const ipv4 = Number(ipv4ToBigInt(dottedTail));
        normalized = normalized.slice(0, -dottedTail.length) +
            `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
    }
    const halves = normalized.split('::');
    const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const tail = halves.length > 1 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
    const fillCount = 8 - head.length - tail.length;
    const parts = halves.length > 1
        ? [...head, ...Array(fillCount).fill('0'), ...tail]
        : head;
    return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

function addressInCidr(value, network, prefixLength, totalBits) {
    const shift = BigInt(totalBits - prefixLength);
    return (value >> shift) === (network >> shift);
}

function isGloballyRoutableIpAddress(address) {
    const ipType = net.isIP(address);
    if (ipType === 4) {
        const value = ipv4ToBigInt(address);
        return !NON_GLOBAL_IPV4_CIDRS.some(([network, prefix]) =>
            addressInCidr(value, ipv4ToBigInt(network), prefix, 32)
        );
    }
    if (ipType === 6) {
        const value = ipv6ToBigInt(address);
        if (!addressInCidr(value, ipv6ToBigInt('2000::'), 3, 128)) return false;
        return !NON_GLOBAL_IPV6_CIDRS.some(([network, prefix]) =>
            addressInCidr(value, ipv6ToBigInt(network), prefix, 128)
        );
    }
    return false;
}

function isPrivateIpAddress(address) {
    return !isGloballyRoutableIpAddress(address);
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
        url.validatedHostname = hostname;
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
    url.validatedHostname = hostname;
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

async function reviseAnalysis(paper, existingAnalysis, sourceText, preparedEvidence = null) {
    const evidence = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('revision', existingAnalysis, sourceText);
    const prompt = loadPrompt('prompts/gap-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        existingAnalysis: existingAnalysis,
        textForAnalysis: evidence
    });
    return await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS,
        { usageContext: { stage: 'revision' } });
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

function inferDocumentTypeFromAnalysis(analysis) {
    const text = String(analysis || '');
    if (/(?:综述|survey|systematic review|literature review)/i.test(text)) return '综述';
    if (/(?:技术报告|technical report|系统报告)/i.test(text)) return '系统技术报告';
    if (/(?:模型报告|model report|model card)/i.test(text)) return '模型报告';
    if (/(?:提出|发布|构建|介绍|创建|开源).{0,24}(?:数据集|基准)|\b(?:new|novel|release[sd]?|introduc(?:e[sd]?|ing)|construct(?:ed|ion)?)[ -]+(?:dataset|benchmark)\b|\b(?:dataset|benchmark)[ -]+(?:release|construction|introduction)\b/i.test(text)) {
        return '数据集与基准';
    }
    if (/(?:理论研究|定理|证明|theorem|proof)/i.test(text)) return '理论研究';
    return '方法研究';
}

function inferTaskTagFromAnalysis(analysis) {
    const text = String(analysis || '');
    const candidates = [
        [/(?:副语言|情感识别|情绪识别|paralinguistic|emotion recognition)/i, '#语音情感识别'],
        [/(?:音视频|流式视频|video stream|audio-visual|audiovisual)/i, '#音视频理解'],
        [/(?:音乐生成|text-to-midi|MIDI generation)/i, '#音乐生成'],
        [/(?:音乐|music)/i, '#音乐理解'],
        [/(?:语音识别|speech recognition|ASR)/i, '#语音识别'],
        [/(?:语音增强|speech enhancement)/i, '#语音增强'],
        [/(?:语音合成|text-to-speech|TTS)/i, '#语音合成'],
        [/(?:音频伪造|AI[- ]generated audio|deepfake audio)/i, '#音频伪造检测'],
        [/(?:音频语言模型|audio language model|\bALM\b)/i, '#音频理解'],
        [/(?:语音|speech)/i, '#语音属性识别'],
        [/(?:音频|audio)/i, '#音频理解']
    ];
    return candidates.find(([pattern]) => pattern.test(text))?.[1] || '#音频理解';
}

function inferMethodTagFromAnalysis(analysis, taskTag, documentType) {
    const text = String(analysis || '');
    const candidates = [
        [/(?:扩散模型|diffusion)/i, '#扩散模型'],
        [/(?:流匹配|flow matching)/i, '#流匹配'],
        [/(?:Transformer)/i, '#Transformer'],
        [/(?:\bCNN\b|卷积神经网络)/i, '#CNN'],
        [/(?:\bRNN\b|循环神经网络)/i, '#RNN'],
        [/(?:图神经网络|graph neural network|\bGNN\b)/i, '#图神经网络'],
        [/(?:变分自编码器|variational autoencoder|\bVAE\b)/i, '#变分自编码器'],
        [/(?:大语言模型|音频语言模型|language model|\bLLM\b|\bALM\b)/i, '#大语言模型'],
        [/(?:多模态模型|multimodal model|vision-language)/i, '#多模态模型'],
        [/(?:端到端|end-to-end)/i, '#端到端']
    ];
    const inferred = candidates.find(([pattern, tag]) => tag !== taskTag && pattern.test(text))?.[1];
    if (inferred) return inferred;
    if (documentType === '数据集与基准' && taskTag !== '#基准测试') return '#基准测试';
    if (documentType === '理论研究' && taskTag !== '#理论分析') return '#理论分析';
    return taskTag === '#模型评估' ? '#端到端' : '#模型评估';
}

function getSupplementalTagFallbacks(documentType) {
    if (documentType === '数据集与基准') return ['#基准测试', '#数据集', '#模型评估'];
    if (documentType === '理论研究') return ['#理论分析', '#模型评估', '#鲁棒性'];
    if (documentType === '综述') return ['#模型比较', '#模型评估', '#数据集'];
    return ['#模型评估', '#基准测试', '#鲁棒性'];
}

function normalizeAnalysisStructure(analysis) {
    let updated = capExperimentTableMetricColumns(
        normalizeExperimentTableNumericFormatting(
            normalizeUnexpectedTopLevelHeadings(analysis)
        )
    );
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
        : (documentTypes.includes(parsedBefore.documentType)
            ? parsedBefore.documentType
            : inferDocumentTypeFromAnalysis(updated));
    values.rank_bucket = normalizeMachineEnum(
        parsedBefore.rankBucket || values.rank_bucket,
        ['前10%', '前25%', '前50%', '后50%'],
        ''
    );
    values.confidence = normalizeMachineEnum(
        values.confidence || parsedBefore.confidence,
        ['高', '中', '低'],
        ''
    );
    const scoreMaxima = {
        innovation: 2, technical_rigor: 1.5, experimental_sufficiency: 1.5, clarity: 1,
        impact: 1.5, open_source: 1.5, reproducibility: 0.5, engineering_score: 1.5
    };
    for (const [key, maximum] of Object.entries(scoreMaxima)) {
        const rawValue = values[key];
        const numeric = Number(rawValue);
        const anchors = key === 'open_source' ? [0, 0.2, 0.5, 1, 1.2, 1.5] : null;
        values[key] = rawValue !== '' && Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum
            && (!anchors || anchors.includes(numeric))
            ? numeric.toFixed(1)
            : '';
    }
    // 结构修复模型偶尔会遗漏 open_source 行。评分理由或已解析的资源状态
    // 能提供更具体证据时优先复用；完全没有证据时使用最保守的 0.0 锚点，
    // 让确定性契约修复收敛，同时不凭空给论文增加开源分。
    if (!values.open_source) {
        values.open_source = '0.0';
    }
    values.sota_claim = normalizeMachineEnum(values.sota_claim || parsedBefore.sotaClaim, ['是', '否', '未说明'], '未说明');
    values.has_code = normalizeMachineEnum(values.has_code || parsedBefore.hasCode, ['是', '否', '未说明'], '未说明');
    values.has_model = normalizeMachineEnum(values.has_model || parsedBefore.hasModel, ['是', '否', '未说明'], '未说明');
    values.has_dataset = normalizeMachineEnum(values.has_dataset || parsedBefore.hasDataset, ['是', '否', '未说明'], '未说明');

    const oldTagSection = extractSectionByTitle(updated, '标签');
    discoveredTags.push(...(oldTagSection.match(/#[^\s#，,;；、]+/g) || []));
    discoveredTags.push(values.primary_task_tag, values.primary_method_tag);
    const candidateTags = [...new Set(discoveredTags.filter(Boolean))];
    const provisional = replaceOrInsertRequiredSection(
        updated,
        '标签',
        `${candidateTags.slice(0, 5).join(' ')}\n主任务标签: ${values.primary_task_tag || candidateTags[0] || ''}\n主方法标签: ${values.primary_method_tag || candidateTags[1] || ''}\n补充标签: ${candidateTags.slice(2, 5).join(' ')}`
    );
    const parsedTags = parseAnalysis(provisional) || {};
    const tags = [...new Set(parsedTags.tags || [])].slice(0, 5);
    let taskTag = parsedTags.primaryTaskTag && tags.includes(parsedTags.primaryTaskTag)
        ? parsedTags.primaryTaskTag
        : (tags.find(tag => /^#(?:语音|音频|音乐|说话人|声源|歌唱|音视频)/.test(tag)) || '');
    if (!taskTag) taskTag = inferTaskTagFromAnalysis(updated);
    let methodTag = parsedTags.primaryMethodTag && tags.includes(parsedTags.primaryMethodTag) && parsedTags.primaryMethodTag !== taskTag
        ? parsedTags.primaryMethodTag
        : (tags.find(tag => tag !== taskTag) || '');
    if (!methodTag) methodTag = inferMethodTagFromAnalysis(updated, taskTag, values.document_type);
    const finalTags = [...new Set([taskTag, methodTag, ...tags].filter(Boolean))];
    for (const fallbackTag of getSupplementalTagFallbacks(values.document_type)) {
        if (finalTags.length >= 3) break;
        if (!finalTags.includes(fallbackTag)) finalTags.push(fallbackTag);
    }
    finalTags.splice(5);
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

function getCoreSummaryDetailIssue(analysis, options = {}) {
    return validateCoreSummarySemanticContract(analysis, options);
}

function sectionExteriorBytes(analysis, title) {
    const bounds = findSectionBounds(analysis, title);
    if (!bounds) throw contractRejectedError(`局部修复找不到 ## ${title}`);
    return `${analysis.slice(0, bounds.contentStart)}\u0000${analysis.slice(bounds.end)}`;
}

async function repairCoreSummarySection(
    paper, existingAnalysis, sourceText, preparedEvidence = null, options = {}
) {
    const original = String(existingAnalysis || '');
    const originalExterior = sectionExteriorBytes(original, '核心摘要');
    const existingSummary = extractSectionByTitle(original, '核心摘要');
    const evidenceContext = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('coreSummaryRepair', original, sourceText);
    let issue = getCoreSummaryDetailIssue(original, { sourceText });
    if (!issue) return original;
    let feedback = issue;
    const repairCallModel = options.callModelFn || callModel;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = loadPrompt('prompts/core-summary-repair.md', {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            summaryIssue: feedback,
            existingSummary,
            textForAnalysis: evidenceContext
        });
        const raw = String(await repairCallModel([{ role: 'user', content: prompt }],
            TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair.maxTokens,
            { usageContext: { stage: 'coreSummaryRepair' } }) || '').trim();
        const match = raw.match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
        if (!match || /^#{1,6}\s/m.test(match[1])) {
            feedback = '输出必须且只能包含一节 ## 核心摘要，不得包含其他标题。';
            continue;
        }
        const updated = mergeSectionByTitle(original, '核心摘要', match[1]);
        if (sectionExteriorBytes(updated, '核心摘要') !== originalExterior) {
            throw contractRejectedError('核心摘要局部修复改变了其他一级章节字节');
        }
        issue = getCoreSummaryDetailIssue(updated, { sourceText });
        if (!issue) return updated;
        feedback = issue;
    }
    throw contractRejectedError(`核心摘要局部修复失败: ${feedback}`);
}

async function repairMissingAnalysisSections(
    paper, existingAnalysis, sourceText, preparedEvidence = null, options = {}
) {
    let currentAnalysis = normalizeAnalysisStructure(existingAnalysis);
    let structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis, { sourceText });
    let validationFeedback = '这是第一次结构修复，没有上一次校验错误。';
    const evidenceContext = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('structureRepair', existingAnalysis, sourceText);

    for (let attempt = 1; attempt <= 2 && structureIssues.length > 0; attempt++) {
        const prompt = loadPrompt('prompts/structure-repair.md', {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            missingSections: structureIssues.join('、'),
            validationFeedback,
            existingAnalysis: currentAnalysis,
            textForAnalysis: evidenceContext
        });
        const repairCallModel = options.callModelFn || callModel;
        const repairedText = await repairCallModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS);
        const cleaned = cleanGapFillPrefix(repairedText.trim());
        if (cleaned) currentAnalysis = normalizeAnalysisStructure(removeUnapprovedMarkdownImages(cleaned, []));

        structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis, { sourceText });
        if (structureIssues.length === 0) return currentAnalysis;

        validationFeedback = `上一次输出仍有结构契约问题：${structureIssues.join('、')}。必须输出完整分析并逐项修正。`;
        console.log(`    [deep] ⚠️  最终结构修复未通过 (${attempt}/2): ${structureIssues.join('、')}`);
    }

    throw contractRejectedError(`最终结构修复失败: ${structureIssues.join('、')}`);
}

function contractRejectedError(message) {
    const error = new Error(message);
    error.code = 'CONTRACT_REJECTED';
    return error;
}

function recoveryFailureStatus(error) {
    return error?.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure';
}

async function finalizeStructureRepairOutput(paper, inputAnalysis, sourceText, options = {}) {
    let analysis = capExperimentTableMetricColumns(
        normalizeExperimentTableNumericFormatting(inputAnalysis)
    );
    const tableContractIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parseAnalysis(analysis)?.documentType,
        sourceText
    });
    if (tableContractIssue) {
        throw contractRejectedError(
            `最终结构修复后的表格仍未通过 ${EXPERIMENT_TABLE_CONTRACT_VERSION} 契约: ${tableContractIssue}`
        );
    }

    let methodContractIssue = validateMethodDetailContract(analysis);
    let methodRepaired = false;
    if (methodContractIssue) {
        const finalMethodEvidence = buildStageEvidenceContext(
            'methodRepair',
            analysis,
            sourceText
        );
        const fixMethodSection = options.fixMethodSection || checkAndFixMethodSection;
        const fixed = await fixMethodSection(
            paper,
            analysis,
            sourceText,
            finalMethodEvidence
        );
        methodRepaired = Boolean(fixed && fixed !== analysis);
        if (fixed) analysis = fixed;
        methodContractIssue = validateMethodDetailContract(analysis);
    }
    if (methodContractIssue) {
        throw contractRejectedError(
            `最终结构修复后的方法仍未通过 detailed-v1 契约: ${methodContractIssue}`
        );
    }

    // 方法兜底本身也是模型输出，必须再次接受完整结构/叙事契约审计。
    // 否则它可在满足 600 字方法契约的同时新增编辑批注或破坏其他章节，
    // 并被错误地保存为 structureRepair=complete 供后续运行复用。
    const finalStructureIssues = getRepairableAnalysisStructureIssues(analysis, { sourceText });
    if (finalStructureIssues.length > 0) {
        throw contractRejectedError(
            `最终方法兜底后的分析仍未通过结构契约: ${finalStructureIssues.join('、')}`
        );
    }
    return { analysis, methodRepaired };
}

function getRepairableAnalysisStructureIssues(analysis, options = {}) {
    const issues = [];
    const missing = getMissingRequiredSections(analysis);
    if (missing.length > 0) issues.push(`缺少必要章节: ${missing.join('/')}`);
    const duplicate = getDuplicateRequiredSections(analysis);
    if (duplicate.length > 0) issues.push(`必要章节重复: ${duplicate.join('/')}`);
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) issues.push(`一级章节: ${topLevelIssue}`);
    const editorialLeakageIssue = validateAnalysisEditorialLeakageContract(analysis);
    if (editorialLeakageIssue) issues.push(`模型编辑/自检批注: ${editorialLeakageIssue}`);
    const parsed = parseAnalysis(analysis);
    const machineIssue = validateMachineSummaryContract(analysis, parsed, { checkScoringConsistency: false });
    if (machineIssue) issues.push(`机器摘要: ${machineIssue}`);
    const tagIssue = validateTagSectionContract(analysis, parsed);
    if (tagIssue) issues.push(`标签: ${tagIssue}`);
    const tableIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parsed?.documentType,
        sourceText: options.sourceText
    });
    if (tableIssue) issues.push(`实验表格: ${tableIssue}`);
    // 结构修复必须在评分审计之前兜住最终契约要求的叙事正文长度。
    // 否则标题齐全但正文仍是 `TD` / 编辑指令等占位内容时，评分审计只会
    // 反复改写评分，永远无法修复真正位于上游的核心摘要或方法/结果章节。
    if (!parsed?.architecture || parsed.architecture.trim().length < 80) {
        issues.push(`方法概述内容不足: ${parsed?.architecture?.trim().length || 0}/80 字符`);
    }
    const resultMinimumChars = ['综述', '理论研究'].includes(parsed?.documentType) ? 20 : 50;
    if (!parsed?.results || parsed.results.trim().length < resultMinimumChars) {
        issues.push(`实验或验证内容不足: ${parsed?.results?.trim().length || 0}/${resultMinimumChars} 字符`);
    }
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
async function checkAndFixMethodSection(paper, analysis, sourceText, preparedEvidence = null) {
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
        textForAnalysis: typeof preparedEvidence === 'string'
            ? preparedEvidence
            : buildStageEvidenceContext('methodRepair', analysis, sourceText)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS,
        { usageContext: { stage: 'methodRepair' } });
    if (!fixedSection || !isMethodSectionDetailed(fixedSection)) {
        const error = new Error('方法补充输出未达到 600 中文字符、三段结构化说明的 detailed-v1 契约');
        error.code = 'CONTRACT_REJECTED';
        throw error;
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
    return hasExplicitTableReference(text)
        || /\\begin\{tabular\}|<table[\s>]/i.test(text)
        || /\n\s*\|[^\n]+\|\s*\n\s*\|[\-\s:|]+\|/.test(text);
}

function hasExplicitTableReference(text) {
    if (!text) return false;
    return /\b(?:table|tbl)\.?\s*(?:[a-z]?\d+|[ivxlcdm]+)\b|表\s*[（(]?\s*(?:\d+|[一二三四五六七八九十百零]+)\s*[)）]?/i.test(text);
}

function analysisNeedsExperimentTableRepair(analysis, textForAnalysis) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return false;
    const hasTable = hasMarkdownTable(resultsSection);
    const hasOmission = hasOmissionMarkers(resultsSection);
    const hasTableReference = hasExplicitTableReference(resultsSection);
    const sourceHasTables = sourceTextLikelyHasTables(textForAnalysis);

    // Explicit omission language is always repaired. Merely detecting any
    // table somewhere in the source is not enough: the primary analysis may
    // already present the relevant numeric evidence in prose, and forcing a
    // second LLM call to reproduce unrelated source tables wastes substantial
    // input/output tokens. A missing-table repair is otherwise justified only
    // when the analysis itself cites a table and the source confirms one.
    const depthIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parseAnalysis(analysis)?.documentType,
        sourceText: textForAnalysis
    });
    return hasOmission || Boolean(depthIssue) || (!hasTable && hasTableReference && sourceHasTables);
}

/**
 * 检查并修复实验结果中缺失的表格。
 * 只在存在省略标记，或正文明确引用原文表格却缺少 Markdown 表格时调用。
 */
async function checkAndFixTables(paper, analysis, sourceText, preparedEvidence = null) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return analysis;
    if (!analysisNeedsExperimentTableRepair(analysis, sourceText)) return analysis;

    console.log(`    [deep] 🔍 检测到实验结果可能缺少表格，触发补充...`);

    const prompt = loadPrompt('prompts/table-fill.md', {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        resultsSection,
        textForAnalysis: typeof preparedEvidence === 'string'
            ? preparedEvidence
            : buildStageEvidenceContext('tableRepair', analysis, sourceText)
    });

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS,
        { usageContext: { stage: 'tableRepair' } });
    if (!fixedSection || fixedSection.length < 200) {
        return analysis;
    }

    // 将补充的实验结果合并回原分析
    return normalizeExperimentTableNumericFormatting(
        mergeSectionByTitle(analysis, '实验结果', fixedSection)
    );
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
    resolveApiMaxRetries,
    createActiveTimeBudget,
    getActiveRemainingTimeoutMs,
    getRemainingTimeoutMs,
    fetchArxivText,
    fetchArxivTextDetailed,
    fetchArxivImageUrls,
    parseArxivImageInfosFromHtml,
    parseArxivStructuredArtifactsFromHtml,
    ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
    buildUnstructuredTextArtifactSignals,
    bindStructuredArtifactsToText,
    parseArxivReaderAuthors,
    resolveApiReaderAuthors,
    assessArxivHtmlFullText,
    removeUnapprovedMarkdownImages,
    selectImageCandidates,
    scoreImageCandidate,
    normalizeImageInfos,
    mergeImageInfoMetadata,
    sanitizeImageManifestHttpsOnly,
    sanitizePaperImageRecovery,
    saveAnalysisCheckpoint,
    sourceTextLikelyHasTables,
    analysisNeedsExperimentTableRepair,
    getPaperArxivId,
    getPreProvidedImageUrls,
    getArxivHtmlIds,
    isSupportedImageUrl,
    safeImageLabel,
    normalizeModelImagePayload,
    buildImageContent,
    isCorruptedMultimodalError,
    downloadImageBase64,
    cachePublicImageDetailed,
    fetchPublicImageResponse,
    requestPinnedPublicHttps,
    sanitizeMarkdownImageAlt,
    sanitizeLogField,
    cleanGapFillPrefix,
    checkDemoPageForOpensource,
    invalidateSourceBoundImageRecovery,
    discardInvalidImageSupplement,
    classifyImageDiscoveryStatus,
    persistImageDiscoveryFailure,
    classifyArxivSourceFailure,
    isTransientDemoHttpStatus,
    isGloballyRoutableIpAddress,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    extractDemoUrls,
    extractSectionByTitle,
    mergeSectionByTitle,
    appendSectionByTitle,
    syncResourceFieldsFromOpenSource,
    inferResourceState,
    parseImageInsertionPlan,
    parseImageInsertionPlanDetailed,
    validateImageNarrativeContext,
    IMAGE_NARRATIVE_CONTRACT_VERSION,
    applyImageInsertionPlan,
    buildImageAnchorCatalog,
    formatImageAnchorCatalog,
    normalizeGenericImageOrder,
    parseScoringAuditResult,
    revalidateScoringAudit,
    applyScoringAuditResult,
    applyScoringEvidenceCaps,
    validateScoringAuditAgainstAnalysis,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence,
    reasonUsesForbiddenDeduction,
    findForbiddenDeductionClauses,
    prepareScoringAuditAnalysis,
    updateOpensourceFromDemoLinks,
    auditTypeAwareScoring,
    auditTypeAwareScoringDetailed,
    parseApiReaderArticleResult,
    validateApiReaderTableNarratives,
    validateReaderEditorialQuality,
    ensureApiReaderTableNarratives,
    relocateExplicitReaderTableExplanations,
    normalizeReaderStructuralLineBreaks,
    normalizeDeclaredReaderMarkerParagraphs,
    normalizeApiReaderTablePasteArtifacts,
    normalizeApiReaderTableBlockSpacing,
    rebindApiReaderFigurePlacementQuotes,
    removeDuplicateReaderLongSentences,
    generateApiReaderArticleDetailed,
    prepareApiReaderRevisionSeed,
    buildApiReaderGenerationStart,
    buildApiReaderValidationFeedback,
    refreshApiReaderArticleFromSource,
    finalizeOperatorApiReaderArticleFromSource,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource,
    hasCompleteApiReaderFigureBinding,
    API_READER_ARTICLE_CONTRACT,
    API_READER_QUALITY_METRICS_CONTRACT,
    API_READER_SOURCE_BINDING_CONTRACT,
    API_READER_AUTHOR_IDENTITY_CONTRACT,
    API_READER_RESOURCE_IDENTITY_CONTRACT,
    API_READER_FIGURE_SELECTION_LIMIT,
    SCORING_STABILITY_RESOLUTION_CONTRACT,
    scoringStabilityResolutionIsValid,
    buildApiReaderQualityMetrics,
    bindApiReaderSourceEvidence,
    deriveExactTableSourceQuotes,
    bindApiReaderAuthorIdentity,
    extractApiReaderResourceCandidates,
    verifyApiReaderResourceUrl,
    buildApiReaderResourceIdentity,
    applyApiReaderResourceAvailability,
    isAllowedReaderNarrativeNumeralIssue,
    isAllowedReaderDefensiveNegationIssue,
    splitReaderLongParagraphs,
    normalizeReaderEditorialSurface,
    repairApiReaderPlanSurfaceBinding,
    collapseRepeatedReaderBridgeHeadings,
    apiReaderPreInjectionQualityView,
    makeReaderHeadingSpecific,
    getApiReaderFigureInventory,
    buildApiReaderArtifactEvidence,
    buildApiReaderEvidenceContext,
    injectApiReaderFigures,
    rewriteApiReaderFigureNarratives,
    normalizeReaderFigureCaption,
    truncateReaderFigureCaption,
    sanitizeTrustedArxivSvg,
    prepareTrustedArxivFigureBuffer,
    isPermanentApiReaderFigureFailure,
    pruneUnmaterializedApiReaderFigureBlocks,
    materializeApiReaderFigures,
    fitApiReaderFigureDimensions,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    getCoreSummaryDetailIssue,
    repairCoreSummarySection,
    repairMissingAnalysisSections,
    finalizeStructureRepairOutput,
    recoveryFailureStatus,
    getRepairableAnalysisStructureIssues,
    normalizeAnalysisStructure,
    getRemainingTimeoutMs,
    getTypeAwareEvidenceGuide,
    buildTypeAwareSourceContext,
    buildTaskEvidenceContext,
    buildStageEvidenceContext,
    buildTextStageFingerprint,
    runtimePromptTemplateSha256,
    buildLegacyCoreSummaryV2PrimaryFingerprint,
    buildLegacyCoreSummaryV2TextFingerprint,
    buildLegacyCoreSummaryV2EvidenceContext,
    coreSummaryV3MigrationPromptSetIsAllowed,
    currentCoreSummaryV3MigrationPromptsAreExact,
    tryMigrateCoreSummaryV3LegacyCheckpoints,
    captureStaleAnalysisSnapshot,
    validateStaleAnalysisSnapshot,
    legacyStructureCompatibilityIsValid,
    prepareTextRecoveryStage,
    sanitizeOpenSourceEvidence,
    sanitizeModelMessages,
    summarizeModelInput,
    callModelWithConfig,
    resolveSecondaryApiKeys,
    classifyModelRequestError,
    getModelOutputTerminationError,
    sanitizeModelRequestError,
    makeModelHttpError,
    modelFingerprint,
    createAnalysisRecoveryManifest,
    stripManualAnalysisProvenance,
    markRecoveryStage,
    isRecoveryStageComplete,
    suppressOuterRetryAfterReaderExhaustion,
    saveAnalysisCheckpoint,
    shouldRetainFullTextCheckpoint,
    calculateScoringDelta,
    stableFingerprint,
    buildRecoveryFingerprints,
    RECOVERY_STAGE_ORDER,
    RECOVERY_STAGE_DEPENDENCIES,
    recoveryInvalidationClosure,
    buildApiReaderExecutionFingerprint,
    buildLegacyAnalysisBoundApiReaderFingerprint,
    buildLegacyApiReaderV3ConfigurationFingerprint,
    migrateSourceOnlyApiReaderFingerprint,
    migrateSealedSourceOnlyReaderBeforeAnalysis,
    buildImageSupplementFingerprint,
    hasActualAnalysisInputChanged,
    invalidateRecoveryStageIfChanged
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
