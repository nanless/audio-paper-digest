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
    validateEditorialQuality,
    findDuplicateLongSentences
} = require('./editorial-quality.js');

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiReaderOverallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
    apiReaderConcurrency: API_READER_CONCURRENCY = 5,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
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
        // Reader prompt already carries the complete canonical analysis once;
        // do not duplicate its sections inside the source-evidence ledger.
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
    const promptTemplateSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'scoring-audit.md')))
        .digest('hex');
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
            { temperature: SCORING_AUDIT_TEMPERATURE }
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
const API_READER_FIGURE_MAX_BYTES = 16 * 1024 * 1024;
const API_READER_FIGURE_LIMIT = 8;
const API_READER_FIGURE_LEAD_MIN_CHARS = 30;
const API_READER_FIGURE_EXPLANATION_MIN_CHARS = 45;
const API_READER_KINDS = Object.freeze([
    'background', 'related_work', 'problem', 'method_overview', 'component', 'training',
    'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'
]);
const API_READER_REQUIRED_KINDS = Object.freeze([
    'background', 'related_work', 'method_overview', 'training',
    'experiment_setup', 'result', 'limitation', 'reproduction', 'synthesis'
]);

function isAllowedReaderNarrativeNumeralIssue(issue) {
    if (issue?.code !== 'quantitative_chinese_numeral') return false;
    const match = String(issue.match || '').trim();
    return /^(?:一|两)(?:个|条|段|类|层|种|套|路|方面|部分|组|步|轮|半|张|幅)$/.test(match)
        || /^一(?:个)?(?:模型|系统|框架|方法|问题|概念|目标|接口|视角|例子|直觉)$/.test(match);
}

function isAllowedReaderDefensiveNegationIssue(issue, article) {
    if (issue?.code !== 'defensive_negation_saturation') return false;
    const count = Number(issue.count);
    if (!Number.isFinite(count)) return false;
    const chineseChars = (String(article || '').match(/[\u3400-\u9fff]/g) || []).length;
    const readerLimit = Math.max(12, Math.ceil(chineseChars / 300));
    return count <= readerLimit;
}

function canonicalReaderBridgeTerm(term) {
    const numeralMap = {
        一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5',
        六: '6', 七: '7', 八: '8', 九: '9', 十: '10'
    };
    return String(term || '').normalize('NFKC')
        .replace(/[一二两三四五六七八九十](?=阶|路|次|维|步|层|个|段|类|组|轮|种)/g,
            value => numeralMap[value])
        .replace(/\s+/g, '')
        .toLowerCase();
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
    if (!GENERIC_READER_HEADING_RE.test(String(heading || '').trim())) return heading;
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
    const protectedText = String(text || '').replace(
        /!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)|https:\/\/[^\s<>()\[\]{}"'，。；：！？、\u3400-\u9fff]+/g,
        value => {
            const token = `__PD_READER_PROTECTED_${protectedMarkdown.length}__`;
            protectedMarkdown.push(value);
            return token;
        }
    );
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
    const chineseInteger = raw => {
        let section = 0;
        let digit = 0;
        let total = 0;
        for (const char of raw) {
            if (Object.prototype.hasOwnProperty.call(numeralMap, char)) {
                digit = numeralMap[char];
                continue;
            }
            const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 })[char];
            if (!unit) return raw;
            if (unit < 10000) {
                section += (digit || 1) * unit;
            } else {
                total += (section + digit || 1) * unit;
                section = 0;
            }
            digit = 0;
        }
        return String(total + section + digit);
    };
    for (const issue of quantitativeIssues) {
        if (issue?.code !== 'quantitative_chinese_numeral'
            || isAllowedReaderNarrativeNumeralIssue(issue)) continue;
        const match = String(issue.match || '').trim();
        if (!match) continue;
        const replacement = /^[几数]\s*10$/.test(match)
            ? '数十'
            : /^[几数]\s*(\d+(?:\.\d+)?)$/.test(match)
                ? match.replace(/^[几数]\s*/, '约 ')
                : match
                    .replace(/(\d+(?:\.\d+)?)\s*万/g, (_, value) => (
                        Number(value) * 10000
                    ).toLocaleString('en-US', { maximumFractionDigits: 10 }))
                    .replace(/[零〇一二两三四五六七八九十百千万亿]+/g, chineseInteger)
                    .replace(/(\d)([\u3400-\u9fff])/g, '$1 $2');
        normalized = normalized.split(match).join(replacement);
    }
    normalized = normalized
        .replace(/跨窗口\s*1\s*致性/g, '跨窗口一致性')
        .replace(/\b1\s*到\s*5\s+5\s*级量表/g, '1 到 5 级量表')
        .replace(/y\s*到\s*5\s+2\s*段/g, 'y 到 5 这 2 段')
        .replace(
            /((?:macro\s*)?F1|准确率|召回率|精确率|错误率|拒绝率|命中率)(\s*(?:为|达|是|=|从|由|升至|降至)\s*)(\d+(?:\.\d+)?)(?![\d.%])/gi,
            (full, metric, separator, rawValue) => (
                Number.parseFloat(rawValue) > 1
                    ? `${metric}${separator}${rawValue}%`
                    : full
            )
        )
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
        .replace(
            /((?:CER|WER|PER|MER|SER)\b\s*(?:从|由)\s*)(\d+(?:\.\d+)?)(\s*(?:升至|降至|到|至)\s*)(\d+(?:\.\d+)?)(?!\s*%)/gi,
            (full, prefix, left, separator, right) => (
                Number.parseFloat(left) > 1 || Number.parseFloat(right) > 1
                    ? `${prefix}${left}%${separator}${right}%`
                    : full
            )
        )
        .replace(
            /((?:CER|WER|PER|MER|SER)\b\s*)(\d+(?:\.\d+)?)(\s*(?:差于|优于|高于|低于|好于|坏于)\s*)(\d+(?:\.\d+)?)(?!\s*%)/gi,
            (full, prefix, left, separator, right) => (
                Number.parseFloat(left) > 1 || Number.parseFloat(right) > 1
                    ? `${prefix}${left}%${separator}${right}%`
                    : full
            )
        )
        .replace(
            /((?:CER|WER|PER|MER|SER)\b[^\n。！？]{0,36}?)(\d+(?:\.\d+)?)(\s*(?:对|vs\.?|与)\s*)(\d+(?:\.\d+)?)(?!\s*%)/gi,
            (full, prefix, left, separator, right) => (
                Number.parseFloat(left) > 1 || Number.parseFloat(right) > 1
                    ? `${prefix}${left}%${separator}${right}%`
                    : full
            )
        )
        .replace(
            /(\d+(?:\.\d+)?)\s*(对|vs\.?|相比)\s*(\d+(?:\.\d+)?)\s*(%|个百分点|毫秒|分钟|小时|毫焦|kHz|MHz|Hz|dB|mJ|GB|MB|KB|倍|点|分|秒)(?![A-Za-z\u3400-\u9fff])/gi,
            (full, left, separator, right, unit) => (
                /^vs/i.test(separator)
                    ? `${left} ${unit} ${separator} ${right} ${unit}`
                    : `${left} ${unit}${separator}${right} ${unit}`
            )
        )
        .replace(/([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?=(?:mW|mJ|ms|dB|Hz|kHz|MHz|KiB|KB|MB|GB|MACs?|tokens?|FPS|bit)\b)/gi, '$1 ')
        .replace(/([\u3400-\u9fff])(\d)/g, '$1 $2')
        .replace(/(\d)([\u3400-\u9fff])/g, '$1 $2')
        // A currency amount is prose, not a TeX delimiter. Escaping the
        // leading dollar keeps Hugo/MathJax from treating the remainder of
        // the paragraph as an unterminated formula.
        .replace(/(?<!\\)\$(?=\d)/g, '\\$');
    return protectedMarkdown.reduce(
        (value, original, index) => value.replace(
            `__PD_READER_PROTECTED_${index}__`, original
        ),
        normalized
    );
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
        const remainingTables = Math.max(1, tables.length - index);
        const matrixBudget = Math.max(
            256,
            Math.floor((maxChars - usedChars) / remainingTables)
        );
        appendLine(JSON.stringify(matrix).slice(0, matrixBudget), 32);
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

function buildApiReaderEvidenceContext(analysis, sourceText, structuredArtifacts, arxivId = '') {
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
        analysis,
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
        if (beforeChinese < 15) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）前缺少独立说明段`
                + `（当前 ${beforeChinese} 个汉字，至少 15 个）`
            );
        }
        if (afterChinese < 25) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）后缺少独立解释段`
                + `（当前 ${afterChinese} 个汉字，至少 25 个）`
            );
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

function parseApiReaderArticleResult(raw, options = {}) {
    let value;
    try {
        value = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`读者文章 JSON 无法解析: ${error.message}`);
    }
    assertExactObjectKeys(
        value,
        [
            'version', 'readerTitle', 'oneSentenceThesis',
            'conceptBridges', 'figurePlacements', 'sections'
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
    const minimumSectionCount = value.version === 3 ? 12 : 10;
    const maximumSectionCount = value.version === 3 ? 18 : 14;
    if (!Array.isArray(value.sections)
        || value.sections.length < minimumSectionCount
        || value.sections.length > maximumSectionCount) {
        throw new Error(
            `读者文章 sections 必须包含 ${minimumSectionCount}-${maximumSectionCount} 个小节`
        );
    }
    const seenHeadings = new Set();
    let previousRank = -1;
    for (const [index, section] of value.sections.entries()) {
        assertExactObjectKeys(section, ['kind', 'heading', 'body'], `读者文章 sections[${index}]`);
        const rank = API_READER_KINDS.indexOf(section.kind);
        if (rank < 0) throw new Error(`读者文章 sections[${index}].kind 非法`);
        if (rank < previousRank) throw new Error('读者文章小节未按学习依赖顺序递进');
        previousRank = rank;
        const heading = makeReaderHeadingSpecific(
            section.kind, String(section.heading || '').trim(), value.readerTitle
        );
        section.heading = heading;
        if (heading.length < 8 || heading.length > 80
            || GENERIC_READER_HEADING_RE.test(heading)) {
            throw new Error(`读者文章 sections[${index}].heading 必须是论文特有问题或判断`);
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
    const minimumConceptBridges = value.version === 3 ? 4 : 3;
    const maximumConceptBridges = value.version === 3 ? 10 : 8;
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
        const candidate = value.sections.find(section => section.kind === bridge.sectionKind
            && String(section.body || '').split(/\n\s*\n/).map(block => block.trim()).includes(marker));
        if (marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || explanation.length < 45 || explanation.length > 320 || !candidate) {
            throw new Error(
                `读者文章 conceptBridges[${index}] 未形成有效术语桥`
                + `（terms=${bridge.terms.join(' × ')}`
                + `, sectionKind=${bridge.sectionKind}`
                + `, marker=${marker || '空'}`
                + `, explanationChars=${explanation.length}`
                + `, markerBound=${Boolean(candidate)}）`
            );
        }
        return {
            terms: bridge.terms.map(term => normalizeReaderEditorialSurface(term.trim())),
            sectionKind: bridge.sectionKind,
            marker,
            explanation: normalizeReaderEditorialSurface(
                `**${bridge.terms[0].trim()} × ${bridge.terms[1].trim()}：** ${explanation}`
            )
        };
    });
    if (!Array.isArray(value.figurePlacements) || value.figurePlacements.length > 8) {
        throw new Error('读者文章 figurePlacements 必须是至多 8 项的数组');
    }
    const availableFigureOrdinals = new Set(
        (options.availableFigureOrdinals || []).map(Number).filter(Number.isInteger)
    );
    if (availableFigureOrdinals.size === 0 && value.figurePlacements.length !== 0) {
        throw new Error('论文没有可用 Figure，figurePlacements 必须为空');
    }
    const minimumFigurePlacements = value.version === 3
        ? (availableFigureOrdinals.size >= 6
            ? 6
            : Math.min(2, availableFigureOrdinals.size))
        : Math.min(2, availableFigureOrdinals.size);
    if (availableFigureOrdinals.size > 0
        && value.figurePlacements.length < minimumFigurePlacements) {
        throw new Error(
            `论文存在可用 Figure，但高价值图文绑定少于 ${minimumFigurePlacements} 张`
        );
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
            || (value.version === 3 && (focusPoints.length < 2 || focusPoints.length > 4))
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
    article = normalizeApiReaderTableBlockSpacing(normalizeReaderEditorialSurface(article));
    const chineseChars = (article.match(/[\u3400-\u9fff]/g) || []).length;
    const minimumChineseChars = value.version === 3 ? 5000 : 2800;
    const maximumChineseChars = value.version === 3 ? 18000 : 14000;
    if (chineseChars < minimumChineseChars || chineseChars > maximumChineseChars) {
        throw new Error(
            `读者文章中文字数必须为 ${minimumChineseChars}-${maximumChineseChars}，当前 ${chineseChars}`
        );
    }
    if (/(?:evidence\s*id|manual_complete|证据块|代码校验反馈|(?:本|上述|当前|这个)\s*prompt|(?:根据|遵循)\s*(?:本|上述|当前)?\s*prompt|prompt\s*(?:要求|指令|中要求))/i.test(article)) {
        throw new Error('读者文章泄漏了流程或证据元话语');
    }
    let quality = validateEditorialQuality({
        summary: '', method: article, innovations: '', results: '', details: '', limits: ''
    });
    const repairableSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue))
    ));
    if (repairableSurfaceIssues.length > 0) {
        article = normalizeReaderEditorialSurface(article, repairableSurfaceIssues);
        quality = validateEditorialQuality({
            summary: '', method: article, innovations: '', results: '', details: '', limits: ''
        });
    }
    article = restoreReaderSectionHeadings(article, normalizedSections);
    article = removeDuplicateReaderLongSentences(article);
    article = normalizeApiReaderTableBlockSpacing(article);
    quality = validateEditorialQuality({
        summary: '', method: article, innovations: '', results: '', details: '', limits: ''
    });
    const finalSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue))
    ));
    if (finalSurfaceIssues.length > 0) {
        article = normalizeReaderEditorialSurface(article, finalSurfaceIssues);
        quality = validateEditorialQuality({
            summary: '', method: article, innovations: '', results: '', details: '', limits: ''
        });
    }
    const blockingQualityIssues = quality.issues.filter(
        issue => !isAllowedReaderNarrativeNumeralIssue(issue)
            && !isAllowedReaderDefensiveNegationIssue(issue, article)
            && !isReaderHeadingIssue(issue, article)
    );
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
    if (options.requireIntegratedTables === true) {
        const minimumTables = Number.isInteger(options.minimumIntegratedTables)
            ? options.minimumIntegratedTables
            : 2;
        validateApiReaderTableNarratives(article, minimumTables);
        const tables = extractMarkdownTables(article);
        const minimumWideTables = Math.min(2, minimumTables);
        if (tables.filter(table => table.header.length >= 5).length < minimumWideTables) {
            throw new Error(`读者文章至少需要 ${minimumWideTables} 张 5 列以上的宽表`);
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
            sections: normalizedSections.map(section => ({
                kind: section.kind,
                heading: section.heading.trim()
            }))
        },
        article,
        qualityMetrics: quality.metrics
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

function repairApiReaderPlanSurfaceBinding(paper, analysisManifest) {
    const plan = paper?.apiReaderPlan;
    const originalArticle = paper?.apiReaderArticle;
    const article = typeof originalArticle === 'string'
        ? originalArticle.replace(/(?<!\\)\$(?=\d)/g, '\\$')
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
        sections: plan.sections.map((section, index) => ({
            ...section,
            heading: articleHeadings[index]
        })),
        ...(Array.isArray(plan.figurePlacements) ? {
            figurePlacements: plan.figurePlacements.map(placement => ({
                ...placement,
                leadQuote: typeof placement?.leadQuote === 'string'
                    ? placement.leadQuote.replace(/(?<!\\)\$(?=\d)/g, '\\$')
                    : placement?.leadQuote,
                explanationQuote: typeof placement?.explanationQuote === 'string'
                    ? placement.explanationQuote.replace(/(?<!\\)\$(?=\d)/g, '\\$')
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
                    ? figure.leadQuote.replace(/(?<!\\)\$(?=\d)/g, '\\$')
                    : figure?.leadQuote,
                explanationQuote: typeof figure?.explanationQuote === 'string'
                    ? figure.explanationQuote.replace(/(?<!\\)\$(?=\d)/g, '\\$')
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
    paper.apiReaderPlan = repairedPlan;
    paper.apiReaderPlanSha256 = newSha;
    paper.apiReaderArticle = article;
    paper.apiReaderArticleSha256 = articleSha;
    stage.planSha256 = newSha;
    stage.articleSha256 = articleSha;
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
    if (/中文字数必须/.test(message)) {
        fixes.push('只扩写或压缩现有小节正文，使中文字符数进入报错给出的区间，不改变事实、数字和章节顺序');
    }
    return `上一次输出被代码拒绝：${message}。`
        + (fixes.length > 0 ? `必须执行以下修复：${fixes.join('；')}。` : '')
        + '请以上一版 JSON 为底稿精确修复，并重新输出完整 JSON；逐句去重，'
        + '任何包含过多句子的单段都拆成 2–4 句的自然段。'
        + '提交前逐行复算每张 Markdown 表的 pipe 单元格数量，'
        + '并逐条确认 conceptBridges 与 figurePlacements 的 marker 和相邻正文真实存在。';
}

async function generateApiReaderArticleDetailedUnlocked(paper, analysis, sourceEvidence, options = {}) {
    const externalReviewFeedback = String(options.reviewFeedback || '').trim();
    let validationFeedback = externalReviewFeedback
        ? '上一轮只读发布审查发现以下事实或图文绑定问题；必须逐项纠正，'
            + `不能原样复述错误：${externalReviewFeedback}`
        : '这是第一次生成，没有上一次校验错误。';
    let previousDraft = '无';
    let lastError = null;
    const maxAttempts = 5;
    const availableFigureOrdinals = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger);
    const availableTableCount = [...String(sourceEvidence || '')
        .matchAll(/^TABLE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger).length;
    const minimumIntegratedTables = Math.min(4, Math.max(2, availableTableCount));
    const figureEvidenceEntries = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):\s*([^\n]*)\nFIGURE_\1_URL:\s*(https:\/\/[^\s]+)$/gm)]
        .map(match => ({
            ordinal: Number.parseInt(match[1], 10),
            caption: match[2].trim(),
            url: match[3].trim()
        }))
        .filter(item => Number.isInteger(item.ordinal));
    const materializedReaderImages = figureEvidenceEntries.length > 0
        ? await materializeApiReaderFigures(
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
    const readerImageVisibilityNotice = imageEvidence.length > 0
        ? `模型本次真正收到像素的图为：${imageEvidence.map(
            item => `FIGURE_${item.ordinal}`
        ).join(', ')}。只有这些图可以解读坐标轴、曲线、面板、颜色和箭头等像素细节。`
        : '模型本次没有收到任何 Figure 像素；只能依据图注和正文，禁止声称看到坐标轴、曲线、颜色或模块位置。';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const prompt = loadPrompt('prompts/api-reader-article.md', {
            title: paper.title || '',
            arxivId: getPaperArxivId(paper),
            existingAnalysis: analysis,
            sourceEvidence,
            validationFeedback,
            previousDraft
        });
        if (prompt.length > API_READER_CONTEXT_MAX_CHARS) {
            throw new Error(
                `读者文章完整请求上下文超限: ${prompt.length}/${API_READER_CONTEXT_MAX_CHARS} 字符`
            );
        }
        const raw = await callModel(
            [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'text', text: readerImageVisibilityNotice },
                    ...readerImageBlocks
                ]
            }],
            API_READER_MAX_TOKENS,
            { temperature: 0.6, overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS }
        );
        try {
            return {
                ...parseApiReaderArticleResult(raw, {
                    availableFigureOrdinals,
                    requireIntegratedTables: true,
                    minimumIntegratedTables,
                    requiredVersion: API_READER_PLAN_VERSION
                }),
                attempts: attempt,
                imageEvidence
            };
        } catch (error) {
            lastError = error;
            previousDraft = raw;
            validationFeedback = buildApiReaderValidationFeedback(error);
            console.log(`    [deep] ⚠️  读者文章校验失败 (${attempt}/${maxAttempts}): ${error.message}`);
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
    const fingerprint = stableFingerprint({
        configurationFingerprint,
        analysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        reviewFeedbackSha256
    });
    const generated = await generateApiReaderArticleDetailed(
        paper, analysis, evidenceContext, { reviewFeedback }
    );
    const injectedReaderResult = injectApiReaderFigures(
        generated, sourceDetails.structuredArtifacts, arxivId
    );
    const materializedFigures = await materializeApiReaderFigures(
        injectedReaderResult.figures, arxivId
    );
    const readerResult = {
        ...injectedReaderResult,
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
    const readerAuthors = resolveApiReaderAuthors(paper, sourceDetails);
    paper.apiReaderArticle = readerResult.article;
    paper.apiReaderPlan = readerResult.plan;
    paper.apiReaderFigures = readerResult.figures;
    paper.apiReaderAuthors = readerAuthors;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderPlanSha256 = planSha256;
    manifest.contracts = {
        ...(manifest.contracts || {}),
        apiReaderArticle: API_READER_ARTICLE_CONTRACT
    };
    manifest.sourceAcquisition = {
        ...(manifest.sourceAcquisition || {}),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || ''
    };
    manifest.stages.apiReaderArticle = {
        status: 'complete',
        fingerprint,
        attempts: readerResult.attempts,
        model: DEEP_CONFIG.model,
        protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
        temperature: 0.6,
        maxTokens: API_READER_MAX_TOKENS,
        overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
        promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.apiReaderArticle),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
        contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
        evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
        articleSha256,
        planSha256,
        figureCount: readerResult.figures.length,
        figuresSha256,
        readerAuthorsSha256: stableFingerprint(readerAuthors),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        qualityMetrics: readerResult.qualityMetrics,
        parserVersion: API_READER_PARSER_VERSION,
        assemblerVersion: API_READER_ASSEMBLER_VERSION,
        tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
        figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
        imageEvidenceCount: readerResult.imageEvidence?.length || 0,
        imageEvidenceSha256: stableFingerprint(readerResult.imageEvidence || []),
        reviewFeedbackSha256,
        refreshedAt: getBeijingISOString()
    };
    return paper;
}

async function refreshApiScoringAndReaderFromSource(paper, sourceDetails) {
    if (!paper || typeof paper !== 'object') throw new Error('评分复验需要 canonical paper');
    const manifest = paper.analysisManifest;
    const analysis = String(paper.analysis || '');
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (!analysis || sourceText.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
        throw new Error('评分复验需要已完成 analysis 与可验证全文');
    }
    if (sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest?.sourceAcquisition?.sourceSha256) {
        throw new Error('评分复验的全文 SHA 与 canonical 来源不一致');
    }
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit', analysis, sourceText
    );
    const scoringResult = await auditTypeAwareScoringDetailed(
        analysis,
        sourceText,
        { evidenceContext: scoringEvidenceContext }
    );
    const auditedAnalysis = scoringResult.analysis;
    const auditedParsed = parseAnalysis(auditedAnalysis);
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
    const finalScore = Number.parseFloat(auditedParsed?.score);
    const scoreDelta = Number.isFinite(previousScore) && Number.isFinite(finalScore)
        ? Number((finalScore - previousScore).toFixed(1))
        : null;
    manifest.stages.scoringAudit = {
        status: 'complete',
        attempts: scoringResult.attempts,
        model: scoringResult.model,
        protocol: scoringResult.protocol,
        endpointSha256: scoringResult.endpointSha256,
        maxTokens: scoringResult.maxTokens,
        temperature: scoringResult.temperature,
        promptTemplateSha256: scoringResult.promptTemplateSha256,
        scoringInputSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS,
        evidenceSha256: scoringResult.evidenceSha256,
        scoringContract: SCORING_AUDIT_CONTRACT,
        capRulesVersion: SCORING_CAP_RULES_VERSION,
        previousScore: Number.isFinite(previousScore) ? previousScore : null,
        previousRunScore: Number.isFinite(previousScore) ? previousScore : null,
        finalScore: Number.isFinite(finalScore) ? finalScore : null,
        scoreDelta,
        stabilityWarning: scoreDelta !== null && Math.abs(scoreDelta) > 0.5,
        audit: scoringResult.audit,
        auditSha256: stableFingerprint(scoringResult.audit),
        outputAnalysisSha256: crypto.createHash('sha256').update(auditedAnalysis).digest('hex'),
        refreshedAt: getBeijingISOString()
    };
    paper.analysis = auditedAnalysis;
    paper.parsed = auditedParsed;
    await refreshApiReaderArticleFromSource(paper, sourceDetails);
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
    stage.readerAuthorsSha256 = stableFingerprint(readerAuthors);
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
    paper.apiReaderArticle = rewrittenArticle;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderFigures = materialized;
    paper.apiReaderAuthors = readerAuthors;
    stage.articleSha256 = articleSha256;
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
    'methodRepair', 'structureRepair', 'scoringAudit', 'apiReaderArticle', 'imageSupplement'
]);

const RECOVERY_PROMPT_FILES = Object.freeze({
    primaryAnalysis: 'prompts/deep-analysis.md',
    openSourceScan: 'prompts/opensource-scan.md',
    revision: 'prompts/gap-fill.md',
    tableRepair: 'prompts/table-fill.md',
    methodRepair: 'prompts/method-fill.md',
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

function promptTemplateSha256(relativePath) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', relativePath)))
        .digest('hex');
}

function modelFingerprint(config, temperature = API_TEMPERATURE, maxTokens = API_MAX_TOKENS) {
    return {
        model: config.model || '',
        endpoint: config.endpoint || '',
        protocol: detectApiType(config.endpoint || '', config.model || ''),
        temperature,
        maxTokens
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
    return stableFingerprint({
        ...modelFingerprint(DEEP_CONFIG, API_TEMPERATURE, config.maxTokens),
        promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES[stage]),
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
    const previousStage = index > 0 ? RECOVERY_STAGE_ORDER[index - 1] : null;
    const previousCheckpoint = previousStage
        ? paper.analysisStageCheckpoints?.[previousStage]
        : null;
    return typeof previousCheckpoint === 'string'
        ? previousCheckpoint
        : String(currentAnalysis || '');
}

function prepareTextRecoveryStage(paper, manifest, stage, currentAnalysis, sourceText) {
    const inputAnalysis = getTextStageInputAnalysis(paper, stage, currentAnalysis);
    const evidenceContext = buildStageEvidenceContext(stage, inputAnalysis, sourceText);
    const fingerprint = buildTextStageFingerprint(stage, inputAnalysis, evidenceContext);
    const evidenceSha256 = crypto.createHash('sha256').update(evidenceContext).digest('hex');
    const inputAnalysisSha256 = crypto.createHash('sha256').update(inputAnalysis).digest('hex');
    const invalidated = invalidateRecoveryStageIfChanged(paper, manifest, stage, fingerprint);
    return {
        analysis: invalidated && typeof paper.analysisCheckpoint === 'string'
            ? paper.analysisCheckpoint
            : currentAnalysis,
        inputAnalysis,
        evidenceContext,
        evidenceChars: evidenceContext.length,
        evidenceSha256,
        inputAnalysisSha256,
        fingerprint,
        invalidated
    };
}

function buildRecoveryFingerprints(paper, textForAnalysis, arxivId) {
    const usedTextSha256 = crypto.createHash('sha256').update(textForAnalysis).digest('hex');
    const primaryContext = {
        ...modelFingerprint(DEEP_CONFIG),
        promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.primaryAnalysis),
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
        demoLinkScan: stableFingerprint({ implementation: 'demo-link-scan-v1' }),
        apiReaderArticle: stableFingerprint({
            ...modelFingerprint(DEEP_CONFIG, 0.6, API_READER_MAX_TOKENS),
            contract: API_READER_ARTICLE_CONTRACT,
            planVersion: API_READER_PLAN_VERSION,
            parserVersion: API_READER_PARSER_VERSION,
            assemblerVersion: API_READER_ASSEMBLER_VERSION,
            tableContractVersion: API_READER_TABLE_CONTRACT_VERSION,
            figureContractVersion: API_READER_FIGURE_CONTRACT_VERSION,
            imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
            imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
            promptTemplateSha256: promptTemplateSha256(RECOVERY_PROMPT_FILES.apiReaderArticle),
            evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
            evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
            contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
            overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS
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

function invalidateRecoveryStageIfChanged(paper, manifest, stage, fingerprint) {
    const current = manifest.stages?.[stage];
    if (!current || !isRecoveryStageComplete(manifest, stage) || current.fingerprint === fingerprint) return false;
    const index = RECOVERY_STAGE_ORDER.indexOf(stage);
    const stagesToDelete = index >= 0 ? RECOVERY_STAGE_ORDER.slice(index) : [stage];
    const checkpoints = paper.analysisStageCheckpoints || {};
    const previousStage = index > 0 ? RECOVERY_STAGE_ORDER[index - 1] : null;
    if (previousStage && typeof checkpoints[previousStage] === 'string') {
        paper.analysisCheckpoint = checkpoints[previousStage];
    } else {
        delete paper.analysisCheckpoint;
        for (const recoveryStage of RECOVERY_STAGE_ORDER) delete manifest.stages[recoveryStage];
    }
    for (const recoveryStage of stagesToDelete) {
        delete manifest.stages[recoveryStage];
        delete checkpoints[recoveryStage];
    }
    if (stagesToDelete.includes('structureRepair') && manifest.contracts) {
        delete manifest.contracts.experimentTables;
        delete manifest.contracts.methodDetail;
        delete manifest.contracts.editorialLeakage;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (stagesToDelete.includes('apiReaderArticle')) {
        delete paper.apiReaderArticle;
        delete paper.apiReaderPlan;
        delete paper.apiReaderFigures;
        delete paper.apiReaderAuthors;
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
    const firstFailedIndex = RECOVERY_STAGE_ORDER.findIndex(stage =>
        stages[stage] && !isRecoveryStageComplete({ stages }, stage)
    );
    if (firstFailedIndex >= 0) {
        for (const stage of RECOVERY_STAGE_ORDER.slice(firstFailedIndex + 1)) {
            delete stages[stage];
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[stage];
        }
    }
    // 成功结果不会长期保存正文 checkpoint。强制重分析这类记录时，必须同时
    // 清除主分析及全部下游阶段，否则新正文会错误复用旧轮次的审校/评分状态。
    if (isRecoveryStageComplete({ stages }, 'primaryAnalysis') && !paper?.analysisCheckpoint) {
        for (const stage of RECOVERY_STAGE_ORDER) delete stages[stage];
        delete paper.analysisStageCheckpoints;
    }
    const keepTableContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.experimentTables === EXPERIMENT_TABLE_CONTRACT_VERSION;
    const keepMethodContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.methodDetail === METHOD_DETAIL_CONTRACT_VERSION;
    const keepEditorialLeakageContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && existing?.contracts?.editorialLeakage === ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION;
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

async function callModelWithConfig(messages, maxTokens, maxRetries = API_MAX_RETRIES, config = null) {
    maxRetries = resolveApiMaxRetries(maxRetries);
    const cfg = config || DEEP_CONFIG;
    const overallTimeoutMs = Number.isInteger(cfg.overallTimeoutMs) && cfg.overallTimeoutMs > 0
        ? cfg.overallTimeoutMs
        : API_OVERALL_TIMEOUT_MS;
    const safeMessages = sanitizeModelMessages(messages);
    const budget = createActiveTimeBudget(overallTimeoutMs);
    const apiType = detectApiType(cfg.endpoint, cfg.model);
    const modelUrl = buildApiUrl(apiType, cfg.endpoint);
    const url = new URL(modelUrl);
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
                return await _callModelOnce(safeMessages, maxTokens, cfg, budget, apiType, timeoutMs);
            } catch (err) {
                lastError = err;
                if (err?.code === 'MODEL_OUTPUT_TRUNCATED') throw err;
                const duration = (budget.elapsedMs() / 1000).toFixed(1);
                const suspendedBeforeAttempt = attemptSuspendedMs;
                const suspendedMs = budget.suspendedMs();
                if (suspendedMs - reportedSuspendedMs >= 1000) {
                    console.log(`    [api] 💤 检测到系统睡眠/长时间挂起，已从超时预算排除 ${((suspendedMs - reportedSuspendedMs) / 1000).toFixed(1)}s`);
                    reportedSuspendedMs = suspendedMs;
                }
                console.log(`    [api] ⚠️  模型调用失败 (尝试 ${attempt}/${maxRetries}) | active=${duration}s | ${err.message}`);

                if (suspendedMs - suspendedBeforeAttempt >= 1000
                        && ['REQUEST_DEADLINE_EXCEEDED', 'REQUEST_SOCKET_TIMEOUT'].includes(err.code)) {
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
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        if (budget.elapsedMs() >= overallTimeoutMs || lastError?.code === 'MODEL_OVERALL_TIMEOUT') {
            throw createOverallTimeoutError(budget.elapsedMs(), lastError, overallTimeoutMs);
        }
        throw new Error(`模型调用失败，已重试 ${maxRetries} 次: ${lastError.message}`);
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

    try {
        const response = await requestLlmJson(
            apiUrl,
            config.endpoint,
            config.model,
            bodyObj,
            headers,
            { timeoutMs }
        );
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = response.body?.error;
            const message = apiError?.message || apiError || response.raw.substring(0, 200);
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${typeof message === 'string' ? message : JSON.stringify(message).substring(0, 200)}`);
            throw new Error(`HTTP ${response.statusCode}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
        }
        const truncationError = apiType === 'openai_responses'
            ? getResponsesOutputTruncationError(response.body, maxTokens)
            : null;
        if (truncationError) throw truncationError;
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
    return await callModelWithConfig(messages, maxTokens, resolveApiMaxRetries(options.maxRetries), {
        ...DEEP_CONFIG,
        ...(Number.isInteger(options.overallTimeoutMs) && options.overallTimeoutMs > 0
            ? { overallTimeoutMs: options.overallTimeoutMs }
            : {}),
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

function sanitizeReaderAffiliationValue(value, authorNames = []) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    if (text.length < 3
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
        const affiliations = creator.find('.ltx_contact.ltx_role_affiliation').toArray()
            .map(node => cleanReaderAffiliationNode($, node, knownAuthorNames))
            .filter(Boolean);
        const thanks = thanksAffiliations.mappings.get(readerIdentityKey(name));
        const fallbackAffiliations = metaAuthors.length > 0
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
    const names = rawAuthors.map(author => (
        typeof author === 'string' ? author : author?.name
    )).map(normalizeName).filter(Boolean);
    if (parsed && Array.isArray(parsed.authors) && parsed.authors.length > 0
        && recoverySha256(parsed.sourceDomSha256)) {
        if (names.length === 0) return parsed;
        const knownAuthorNames = [...names, ...parsed.authors.map(author => author?.name)];
        const normalizedParsed = parsed.authors.map(author => ({
            name: normalizeName(author?.name),
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
                    : (allAffiliations.length === 1
                        ? allAffiliations
                        : ['机构信息未在 arXiv HTML 中可靠披露'])
            };
        });
        return { authors, sourceDomSha256: parsed.sourceDomSha256 };
    }
    const sourceSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    return {
        authors: names.map(name => ({
            name,
            affiliations: [sourceDetails?.analysisSource === 'pdf'
                ? '机构信息未能从 arXiv PDF 文本可靠映射'
                : '机构信息未在 arXiv HTML 中可靠披露']
        })),
        sourceDomSha256: sourceSha256
    };
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
    stripManualAnalysisProvenance(paper);
    sanitizePaperImageRecovery(paper);
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
            sourceFetchError = e;
            sourceDetails.warnings.push(`全文抓取异常: ${e.message}`);
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }
    } else if (fullText) {
        console.log(`    [deep] 使用预提供全文: ${fullText.length} 字符`);
    }

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
    for (const stage of ['primaryAnalysis', 'demoLinkScan']) {
        invalidateRecoveryStageIfChanged(paper, analysisManifest, stage, recoveryFingerprints[stage]);
    }
    // 已完成的后处理阶段必须用当时上游 checkpoint 和完整正文重新构造
    // 实际有界证据后再校验指纹。这里在恢复主分析正文之前完成失效传播，
    // 避免缺少前序快照的异常 manifest 在本轮中继续使用陈旧下游正文。
    for (const stage of Object.keys(TEXT_RECOVERY_STAGE_CONFIG)) {
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
                API_MAX_TOKENS, API_MAX_RETRIES, DEEP_CONFIG
            );
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', { fingerprint: recoveryFingerprints.primaryAnalysis });
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
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', { fingerprint: recoveryFingerprints.primaryAnalysis });
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

    // 第3.7轮：主模型只审计文档类型和八维评分，避免长文审校时发生重复扣分。
    const scoringStage = analysisManifest.stages.scoringAudit;
    const scoringInputAnalysis = typeof paper.analysisStageCheckpoints?.structureRepair === 'string'
        ? paper.analysisStageCheckpoints.structureRepair
        : analysis;
    const scoringInputSha256 = crypto.createHash('sha256').update(scoringInputAnalysis).digest('hex');
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit',
        scoringInputAnalysis,
        rawTextForAnalysis
    );
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const currentPromptTemplateSha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'scoring-audit.md')))
            .digest('hex');
        const currentEvidenceSha256 = crypto.createHash('sha256')
            .update(scoringEvidenceContext)
            .digest('hex');
        const fingerprintChanged = scoringStage.model !== DEEP_CONFIG.model
            || scoringStage.protocol !== detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model)
            || scoringStage.endpointSha256 !== crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex')
            || scoringStage.maxTokens !== 16000
            || scoringStage.temperature !== SCORING_AUDIT_TEMPERATURE
            || scoringStage.promptTemplateSha256 !== currentPromptTemplateSha256
            || scoringStage.scoringInputSha256 !== scoringInputSha256
            || scoringStage.evidenceSelectionVersion !== EVIDENCE_SELECTION_VERSION
            || scoringStage.evidenceMaxChars !== SCORING_EVIDENCE_MAX_CHARS
            || scoringStage.evidenceSha256 !== currentEvidenceSha256
            || scoringStage.scoringContract !== SCORING_AUDIT_CONTRACT
            || scoringStage.capRulesVersion !== SCORING_CAP_RULES_VERSION
            || !scoringStage.audit?.evidenceProfile
            || scoringStage.auditSha256 !== stableFingerprint(scoringStage.audit)
            || scoringStage.outputAnalysisSha256 !== crypto.createHash('sha256').update(
                String(paper.analysisStageCheckpoints?.scoringAudit || '')
            ).digest('hex');
        if (fingerprintChanged) {
            if (typeof paper.analysisStageCheckpoints?.structureRepair === 'string') {
                paper.analysisCheckpoint = paper.analysisStageCheckpoints.structureRepair;
                analysis = paper.analysisCheckpoint;
            } else {
                analysis = scoringInputAnalysis;
            }
            delete analysisManifest.stages.scoringAudit;
            delete analysisManifest.stages.apiReaderArticle;
            delete analysisManifest.stages.imageSupplement;
            delete paper.apiReaderArticle;
            delete paper.apiReaderPlan;
            delete paper.apiReaderFigures;
            delete paper.apiReaderAuthors;
            delete paper.apiReaderArticleSha256;
            delete paper.apiReaderPlanSha256;
            if (paper.analysisStageCheckpoints) {
                delete paper.analysisStageCheckpoints.scoringAudit;
                delete paper.analysisStageCheckpoints.apiReaderArticle;
                delete paper.analysisStageCheckpoints.imageSupplement;
            }
            console.log(`    [deep] ⚠️  评分审计指纹变化，已失效评分、读者文章与插图恢复状态`);
        }
    }
    if (!isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        try {
            const scoringResult = await auditTypeAwareScoringDetailed(
                scoringInputAnalysis,
                rawTextForAnalysis,
                { evidenceContext: scoringEvidenceContext }
            );
            analysis = scoringResult.analysis;
            const auditedParsed = parseAnalysis(analysis);
            const auditedInvalidReason = getInvalidAnalysisReason(analysis, auditedParsed, {
                enforceExperimentTableContract: true,
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                enforceMethodDetailContract: true,
                sourceText: rawTextForAnalysis
            });
            if (auditedInvalidReason) {
                const error = new Error(`评分审计后的分析未通过最终契约: ${auditedInvalidReason}`);
                error.code = 'CONTRACT_REJECTED';
                throw error;
            }
            const scoringDelta = calculateScoringDelta(previousScore, scoringInputAnalysis, auditedParsed?.score);
            const finalScore = scoringDelta.finalScore;
            const scoreBeforeAudit = scoringDelta.previousScore;
            const scoreDelta = scoringDelta.scoreDelta;
            const stabilityWarning = scoreDelta !== null && Math.abs(scoreDelta) > 0.5;
            if (stabilityWarning) {
                console.log(`    [deep] ⚠️  评分稳定性告警: previous=${scoreBeforeAudit.toFixed(1)} | final=${finalScore.toFixed(1)} | delta=${scoreDelta > 0 ? '+' : ''}${scoreDelta.toFixed(1)}`);
            }
            markRecoveryStage(analysisManifest, 'scoringAudit', 'complete', {
                attempts: scoringResult.attempts,
                model: scoringResult.model,
                protocol: scoringResult.protocol,
                endpointSha256: scoringResult.endpointSha256,
                maxTokens: scoringResult.maxTokens,
                temperature: scoringResult.temperature,
                promptTemplateSha256: scoringResult.promptTemplateSha256,
                scoringInputSha256,
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
                audit: scoringResult.audit,
                auditSha256: stableFingerprint(scoringResult.audit),
                outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex')
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 类型感知评分审计完成`);
        } catch (error) {
            markRecoveryStage(analysisManifest, 'scoringAudit', error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure', { error: error.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 读者文章：保留旧 13 节 analysis 作为机器兼容层，另外生成
    // 面向初学研究者的连续文章。它只依赖已完成的事实修复和评分，
    // 指纹变化只失效本阶段和后续插图。
    const apiReaderEvidenceContext = buildApiReaderEvidenceContext(
        analysis,
        rawTextForAnalysis,
        sourceDetails.structuredArtifacts,
        arxivId
    );
    const apiReaderFingerprint = stableFingerprint({
        configurationFingerprint: recoveryFingerprints.apiReaderArticle,
        analysisSha256: crypto.createHash('sha256').update(String(analysis || '')).digest('hex'),
        evidenceSha256: crypto.createHash('sha256').update(apiReaderEvidenceContext).digest('hex'),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || ''
    });
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
            const generatedReaderResult = await generateApiReaderArticleDetailed(
                paper, analysis, apiReaderEvidenceContext
            );
            const injectedReaderResult = injectApiReaderFigures(
                generatedReaderResult,
                sourceDetails.structuredArtifacts,
                arxivId
            );
            const materializedFigures = await materializeApiReaderFigures(
                injectedReaderResult.figures, arxivId
            );
            const readerResult = {
                ...injectedReaderResult,
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
            paper.apiReaderArticleSha256 = crypto.createHash('sha256')
                .update(readerResult.article).digest('hex');
            paper.apiReaderPlanSha256 = stableFingerprint(readerResult.plan);
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                apiReaderArticle: API_READER_ARTICLE_CONTRACT
            };
            markRecoveryStage(analysisManifest, 'apiReaderArticle', 'complete', {
                fingerprint: apiReaderFingerprint,
                attempts: readerResult.attempts,
                model: DEEP_CONFIG.model,
                protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                temperature: 0.6,
                maxTokens: API_READER_MAX_TOKENS,
                overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
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
                structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
                qualityMetrics: readerResult.qualityMetrics,
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
            throw error;
        }
    }

    // 最后一轮：副模型基于最终文本筛选高价值图片，代码按 JSON 计划做受限局部插图合并。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
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
    return await callModel([{ role: 'user', content: prompt }], 8000);
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
                foundLinks.push(match[0]);
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
    return await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS);
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
    if (!parsed?.summary || parsed.summary.trim().length < 80) {
        issues.push(`核心摘要内容不足: ${parsed?.summary?.trim().length || 0}/80 字符`);
    }
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

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS);
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

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS);
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
    normalizeApiReaderTableBlockSpacing,
    rebindApiReaderFigurePlacementQuotes,
    removeDuplicateReaderLongSentences,
    generateApiReaderArticleDetailed,
    buildApiReaderValidationFeedback,
    refreshApiReaderArticleFromSource,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource,
    hasCompleteApiReaderFigureBinding,
    API_READER_ARTICLE_CONTRACT,
    isAllowedReaderNarrativeNumeralIssue,
    isAllowedReaderDefensiveNegationIssue,
    splitReaderLongParagraphs,
    normalizeReaderEditorialSurface,
    repairApiReaderPlanSurfaceBinding,
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
    prepareTextRecoveryStage,
    sanitizeOpenSourceEvidence,
    sanitizeModelMessages,
    summarizeModelInput,
    createAnalysisRecoveryManifest,
    stripManualAnalysisProvenance,
    markRecoveryStage,
    isRecoveryStageComplete,
    saveAnalysisCheckpoint,
    shouldRetainFullTextCheckpoint,
    calculateScoringDelta,
    stableFingerprint,
    buildRecoveryFingerprints,
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
