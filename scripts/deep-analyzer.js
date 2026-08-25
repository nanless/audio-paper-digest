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
    detectHttpConnectProxyUrl,
    createProxyAgent,
    createProxyDispatcher,
    getBeijingISOString
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
    validateExperimentTableContract,
    normalizeExperimentTableNumericFormatting,
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
const { ANALYSIS_CONFIG, ARXIV_CONFIG, SECONDARY_MODEL_CONFIG, CURRENT_DIR } = require('./config.js');

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
    repairMaxTokens: REPAIR_MAX_TOKENS = 16000,
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
        return recalculateScoringAudit(normalizedAudit);
    }
    return audit;
}

function revalidateScoringAudit(audit, allowedEvidenceIds) {
    return parseScoringAuditResult(JSON.stringify({
        documentType: audit.documentType,
        confidence: audit.confidence,
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
            const normalizedAudit = validateScoringAuditAgainstAnalysis(
                analysis,
                parseScoringAuditResult(raw, allowedEvidenceIds)
            );
            const audit = revalidateScoringAudit(normalizedAudit, allowedEvidenceIds);
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

const RECOVERY_PROMPT_FILES = Object.freeze({
    primaryAnalysis: 'prompts/deep-analysis.md',
    openSourceScan: 'prompts/opensource-scan.md',
    revision: 'prompts/gap-fill.md',
    tableRepair: 'prompts/table-fill.md',
    methodRepair: 'prompts/method-fill.md',
    structureRepair: 'prompts/structure-repair.md',
    scoringAudit: 'prompts/scoring-audit.md',
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
    const safeMessages = sanitizeModelMessages(messages);
    const budget = createActiveTimeBudget(API_OVERALL_TIMEOUT_MS);
    const apiType = detectApiType(cfg.endpoint, cfg.model);
    const modelUrl = buildApiUrl(apiType, cfg.endpoint);
    const url = new URL(modelUrl);
    const temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : API_TEMPERATURE;
    const input = summarizeModelInput(safeMessages);
    console.log(`    [api] → ${cfg.model} | ${apiType} | ${url.hostname}${url.pathname} | input_chars=${input.textChars} | estimated_text_tokens≈${input.estimatedTextTokens} | images=${input.images} | max_tokens=${maxTokens} | max_retries=${maxRetries} | temperature=${temperature}`);

    let lastError = null;
    let reportedSuspendedMs = 0;

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const attemptSuspendedMs = budget.suspendedMs();
            try {
                const timeoutMs = getActiveRemainingTimeoutMs(API_OVERALL_TIMEOUT_MS, budget.elapsedMs());
                return await _callModelOnce(safeMessages, maxTokens, cfg, budget, apiType, timeoutMs);
            } catch (err) {
                lastError = err;
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
    return await callModelWithConfig(messages, maxTokens, resolveApiMaxRetries(options.maxRetries), {
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
            || scoringStage.evidenceSha256 !== currentEvidenceSha256;
        if (fingerprintChanged) {
            if (typeof paper.analysisStageCheckpoints?.structureRepair === 'string') {
                paper.analysisCheckpoint = paper.analysisStageCheckpoints.structureRepair;
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
            console.log(`    [deep] ⚠️  评分审计指纹变化，已失效评分与插图恢复状态`);
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
                previousScore: Number.isFinite(scoreBeforeAudit) ? scoreBeforeAudit : null,
                previousRunScore: scoringDelta.previousRunScore,
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
    if (isDualModel && downloadedImages.length > 0 && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
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
    let updated = normalizeExperimentTableNumericFormatting(
        normalizeUnexpectedTopLevelHeadings(analysis)
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
    let analysis = normalizeExperimentTableNumericFormatting(inputAnalysis);
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
    validateScoringAuditAgainstAnalysis,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence,
    reasonUsesForbiddenDeduction,
    findForbiddenDeductionClauses,
    prepareScoringAuditAnalysis,
    updateOpensourceFromDemoLinks,
    auditTypeAwareScoring,
    auditTypeAwareScoringDetailed,
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
