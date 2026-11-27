'use strict';

/**
 * 主分析 13 章节 Markdown 解析、结构归一化、方法详述检查、
 * 表格省略与实验表修补判定以及精确章节替换辅助模块（非 Reader 解析路径）。
 *
 * 从 scripts/deep-analyzer.js 内聚拆出，保持所有导出引用与判定行为完全一致。
 */

const { parseAnalysis } = require('../utils.js');
const {
    PAPER_EVALUATION_TITLE,
    normalizeAnalysisSectionTitle,
    analysisSectionTitlePattern,
    getPaperEvaluationHeadingIssue,
    getCurrentPaperEvaluationHeadingIssue
} = require('./analysis-section-titles.js');
const {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    validateTopLevelSectionContract,
    validateAnalysisEditorialLeakageContract,
    validateMachineSummaryContract,
    validateExperimentTableContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    validateCoreSummarySemanticContract
} = require('../analysis-contract.js');
const {
    findSectionBounds,
    extractSectionByTitle,
    mergeSectionByTitle
} = require('./public-resource-probe.js');

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


function replaceOrInsertRequiredSection(analysis, title, content) {
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        const issue = getPaperEvaluationHeadingIssue(analysis);
        if (issue) throw contractRejectedError(issue);
    }
    if (findSectionBounds(analysis, title)) return mergeSectionByTitle(analysis, title, content);
    const index = REQUIRED_ANALYSIS_SECTIONS.indexOf(normalizeAnalysisSectionTitle(title));
    const following = REQUIRED_ANALYSIS_SECTIONS.slice(index + 1);
    for (const nextTitle of following) {
        const next = new RegExp(`(^|\\n)##\\s*(?:${analysisSectionTitlePattern(nextTitle)})[：:\\s]*\\n`, 'm').exec(analysis);
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
        // 旧评价标题只用于读取，不改写，也不能降级后隐藏重复章节。
        if (normalizeAnalysisSectionTitle(cleanTitle) === PAPER_EVALUATION_TITLE) return line;
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
    const scoringRubric = require('./scoring-rubric');
    const values = {};
    let declaredRubricVersion = '';
    for (const rawLine of originalMachine.split('\n')) {
        const match = rawLine.trim().replace(/^(?:[-*+]\s*)/, '').match(/^([^:：]+?)\s*[:：]\s*(.*?)$/);
        if (!match) continue;
        const rawKey = match[1].trim().replace(/^(?:\*\*|__|`)([\s\S]*?)(?:\*\*|__|`)$/, '$1').trim();
        const key = aliases[rawKey] || rawKey;
        if (key === 'rubric_version' && !declaredRubricVersion) {
            const candidate = match[2].trim();
            if (scoringRubric.SUPPORTED_SCORING_RUBRIC_VERSIONS.includes(candidate)) {
                declaredRubricVersion = candidate;
            }
            continue;
        }
        if (REQUIRED_MACHINE_SUMMARY_KEYS.includes(key) && values[key] === undefined) {
            values[key] = match[2].trim();
        }
    }

    const parsedBefore = parseAnalysis(updated) || {};
    const effectiveRubricVersion = declaredRubricVersion
        || (scoringRubric.isUnifiedRubric(parsedBefore.scoringRubricVersion || parsedBefore.machineSummary?.rubricVersion)
            ? scoringRubric.CURRENT_SCORING_RUBRIC
            : scoringRubric.LEGACY_SCORING_RUBRIC);
    const isUnifiedRubric = scoringRubric.isUnifiedRubric(effectiveRubricVersion);
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
            // 解析结果通过评分校验且该分项有值时，使用解析结果覆盖机器摘要中的分数。
            // 这样可以纠正两处不一致的记录，也避免结构修复反复处理同一分数问题；
            // open_source 仍按下方的固定取值检查。
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
    const scoreMaxima = isUnifiedRubric
        ? { innovation: 10, technical_rigor: 10, experimental_sufficiency: 10, clarity: 10,
            impact: 10, open_source: 10, reproducibility: 10, engineering_score: 10 }
        : { innovation: 2, technical_rigor: 1.5, experimental_sufficiency: 1.5, clarity: 1,
            impact: 1.5, open_source: 1.5, reproducibility: 0.5, engineering_score: 1.5 };
    const openAnchors = isUnifiedRubric ? scoringRubric.UNIFIED_OPEN_SOURCE_ANCHORS : [0, 0.2, 0.5, 1, 1.2, 1.5];
    for (const [key, maximum] of Object.entries(scoreMaxima)) {
        const rawValue = values[key];
        const numeric = Number(rawValue);
        const anchors = key === 'open_source' ? openAnchors : null;
        values[key] = rawValue !== '' && Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum
            && (!anchors || anchors.includes(numeric))
            ? numeric.toFixed(1)
            : '';
    }
    // 模型可能遗漏 open_source 行。上方已经尝试复用解析分项，并检查了机器摘要中的取值；
    // 这里仍为空时就填入 0.0，保证结构完整，而不凭缺少记录增加开源分。
    if (!values.open_source) {
        values.open_source = '0.0';
    }
    values.sota_claim = normalizeMachineEnum(values.sota_claim || parsedBefore.sotaClaim, ['是', '否', '未说明'], '未说明');
    values.has_code = normalizeMachineEnum(values.has_code || parsedBefore.hasCode, ['是', '否', '未说明'], '未说明');
    values.has_model = normalizeMachineEnum(values.has_model || parsedBefore.hasModel, ['是', '否', '未说明'], '未说明');
    values.has_dataset = normalizeMachineEnum(values.has_dataset || parsedBefore.hasDataset, ['是', '否', '未说明'], '未说明');

    // 机器摘要中已有的主标签先保留。解析结果通过标签校验时，用解析出的主任务和主方法
    // 覆盖这些值；否则保留机器摘要中的非空值，只给空缺补待处理标记。
    // 这里不从正文猜选标签，也不保证保留下来的标签已经合规。结构修复结束后，
    // 独立标签阶段依据当前词表核验，必要时按原文证据局部修复。
    if (parsedBefore.tagValidation?.valid) {
        values.primary_task_tag = parsedBefore.primaryTaskTag;
        values.primary_method_tag = parsedBefore.primaryMethodTag;
    }
    values.primary_task_tag = values.primary_task_tag || '#待选择主任务';
    values.primary_method_tag = values.primary_method_tag || '#待选择主方法';
    if (!findSectionBounds(updated, '标签')) {
        updated = replaceOrInsertRequiredSection(updated, '标签', [
            '#待选择主任务 #待选择主方法 #待选择补充标签',
            '主任务标签: #待选择主任务',
            '主方法标签: #待选择主方法',
            '补充标签: #待选择补充标签'
        ].join('\n'));
    }
    const emittedUnifiedRubric = scoringRubric.isUnifiedRubric(declaredRubricVersion)
        ? declaredRubricVersion
        : scoringRubric.CURRENT_SCORING_RUBRIC;
    const machineLines = [
        ...(isUnifiedRubric ? [`rubric_version: ${emittedUnifiedRubric}`] : []),
        ...REQUIRED_MACHINE_SUMMARY_KEYS.map(key => `${key}: ${values[key]}`)
    ];
    updated = mergeSectionByTitle(updated, '机器摘要', machineLines.join('\n'));
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

function replaceSectionBodyExact(analysis, title, content) {
    const bounds = findSectionBounds(analysis, title);
    if (!bounds) throw contractRejectedError(`修复标签时找不到 ## ${title} 章节。`);
    return `${analysis.slice(0, bounds.contentStart)}${String(content).trim()}${analysis.slice(bounds.end)}`;
}

function replaceMachinePrimaryTagFields(analysis, taskTag, methodTag) {
    const bounds = findSectionBounds(analysis, '机器摘要');
    if (!bounds) throw contractRejectedError('修复标签时找不到 ## 机器摘要章节。');
    let body = analysis.slice(bounds.contentStart, bounds.end);
    for (const [key, value] of [
        ['primary_task_tag', taskTag],
        ['primary_method_tag', methodTag]
    ]) {
        const pattern = new RegExp(`^${key}\\s*[:：]\\s*.*$`, 'gm');
        const matches = body.match(pattern) || [];
        if (matches.length !== 1) {
            throw contractRejectedError(`修复标签时，机器摘要中的 ${key} 字段必须恰好出现一次。`);
        }
        body = body.replace(pattern, () => `${key}: ${value}`);
    }
    return `${analysis.slice(0, bounds.contentStart)}${body}${analysis.slice(bounds.end)}`;
}


function contractRejectedError(message) {
    const error = new Error(message);
    error.code = 'CONTRACT_REJECTED';
    return error;
}

function recoveryFailureStatus(error) {
    return error?.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure';
}


function getRepairableAnalysisStructureIssues(analysis, options = {}) {
    const issues = [];
    if (options.requireCurrentEvaluationTitle === true) {
        const issue = getCurrentPaperEvaluationHeadingIssue(analysis);
        if (issue) issues.push(issue);
    }
    const missing = getMissingRequiredSections(analysis);
    if (missing.length > 0) issues.push(`缺少必要章节: ${missing.join('/')}`);
    const duplicate = getDuplicateRequiredSections(analysis);
    if (duplicate.length > 0) issues.push(`必要章节重复: ${duplicate.join('/')}`);
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) issues.push(`一级章节: ${topLevelIssue}`);
    const editorialLeakageIssue = validateAnalysisEditorialLeakageContract(analysis, {
        sourceText: options.sourceText,
        enforceCyrillicProseGarble: options.enforceCyrillicProseGarble === true
    });
    if (editorialLeakageIssue) issues.push(`模型编辑/自检批注: ${editorialLeakageIssue}`);
    const parsed = parseAnalysis(analysis);
    const machineIssue = validateMachineSummaryContract(analysis, parsed, { checkScoringConsistency: false });
    if (machineIssue) issues.push(`机器摘要: ${machineIssue}`);
    // 本函数仍通过机器摘要检查主任务和主方法的格式，包括键是否存在、只出现一次、
    // 值不为空，以及是否写成单个 #标签。它不把词表语义校验结果或标签选择问题
    // 列为整篇结构修复的问题；这些问题由结构修复后的独立标签阶段处理，
    // 必要时按原文证据局部修复，避免让模型只为修改分类选择而重写全文。
    const tableIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parsed?.documentType,
        sourceText: options.sourceText,
        enforceTableCommentaryAlignment: options.enforceTableCommentaryAlignment === true
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
 * 检查文本中是否包含表格省略标记（命中时返回具体标记，否则返回 null）
 */
function findTableOmissionMarker(text, { hasTable = hasMarkdownTable(text) } = {}) {
    if (!text) return null;
    const explicitMarkers = [
        '此处省略',
        '其余省略',
        '部分省略',
        '略去其余',
        '其余略',
        '表格略',
        '数据略',
        '表格数据与论文一致',
        '详见原文表',
        '见原文表',
        '详见原文',
        '详见论文',
        '表格详见',
        '数据详见',
        '详见原表'
    ];
    for (const marker of explicitMarkers) {
        if (text.includes(marker)) return marker;
    }
    const tableOmissionRe = /(?:表格|数据|其余|部分|中间|后续|完整(?:结果|表格|数据))(?:均|已|被|在此|暂)?(?<![不未无没非])省略|(?<![不未无没非])省略(?:其余|部分|了?(?:其余|部分|完整)?(?:表格|数据|行|列|结果|细节|多项))/;
    const regexMatch = text.match(tableOmissionRe);
    if (regexMatch) return regexMatch[0];
    if (!hasTable) {
        const missingTableCitationMarkers = ['详见表', '（见表', '(见表'];
        for (const marker of missingTableCitationMarkers) {
            if (text.includes(marker)) return marker;
        }
    }
    return null;
}

/**
 * 检查文本中是否包含表格省略标记
 */
function hasOmissionMarkers(text, options) {
    return Boolean(findTableOmissionMarker(text, options));
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

function getExperimentTableRepairIssue(analysis, textForAnalysis) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return null;
    const hasTable = hasMarkdownTable(resultsSection);
    const omissionMarker = findTableOmissionMarker(resultsSection, { hasTable });
    const hasTableReference = hasExplicitTableReference(resultsSection);
    const sourceHasTables = sourceTextLikelyHasTables(textForAnalysis);

    // 明确写出来「缺表」的说法一律修。只是在原文某处检测到表格还不够：主分析可能已经
    // 在正文里给出了相关数字证据，硬要再叫一次 LLM 去复现无关的原文表格，会白白烧掉
    // 大量输入输出 token。除此之外，只有分析自己引用了某张表、且原文也确实有这张表时，
    // 补表才算有理由。
    const depthIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parseAnalysis(analysis)?.documentType,
        sourceText: textForAnalysis,
        enforceTableCommentaryAlignment: true
    });
    const reasons = [];
    if (omissionMarker) {
        reasons.push(`实验结果包含表格省略或外引占位标记“${omissionMarker}”，请补齐完整 Markdown 实验表格并移除省略占位表述`);
    }
    if (depthIssue) {
        reasons.push(depthIssue);
    }
    if (!hasTable && hasTableReference && sourceHasTables) {
        reasons.push('实验结果正文引用了论文表格且原文包含实验表格，但当前未嵌入可读 Markdown 实验表格');
    }
    return reasons.length > 0 ? reasons.join('；') : null;
}

function analysisNeedsExperimentTableRepair(analysis, textForAnalysis) {
    return Boolean(getExperimentTableRepairIssue(analysis, textForAnalysis));
}


module.exports = {
    cleanGapFillPrefix,
    contractRejectedError,
    recoveryFailureStatus,
    replaceOrInsertRequiredSection,
    normalizeUnexpectedTopLevelHeadings,
    normalizeMachineEnum,
    inferDocumentTypeFromAnalysis,
    normalizeAnalysisStructure,
    getCoreSummaryDetailIssue,
    sectionExteriorBytes,
    replaceSectionBodyExact,
    replaceMachinePrimaryTagFields,
    getRepairableAnalysisStructureIssues,
    extractMethodSection,
    countChineseChars,
    isMethodSectionDetailed,
    hasMarkdownTable,
    findTableOmissionMarker,
    hasOmissionMarkers,
    extractResultsSection,
    sourceTextLikelyHasTables,
    hasExplicitTableReference,
    getExperimentTableRepairIssue,
    analysisNeedsExperimentTableRepair
};
