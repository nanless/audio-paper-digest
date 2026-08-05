const REQUIRED_ANALYSIS_SECTIONS = Object.freeze([
    '评分',
    '机器摘要',
    '标签',
    '作者与机构',
    '毒舌点评',
    '核心摘要',
    '方法概述和架构',
    '核心创新点',
    '实验结果',
    '细节详述',
    '评分理由',
    '局限与问题',
    '开源详情'
]);

const REQUIRED_MACHINE_SUMMARY_KEYS = Object.freeze([
    'document_type',
    'rank_bucket',
    'innovation',
    'technical_rigor',
    'experimental_sufficiency',
    'clarity',
    'impact',
    'open_source',
    'reproducibility',
    'engineering_score',
    'confidence',
    'primary_task_tag',
    'primary_method_tag',
    'sota_claim',
    'has_code',
    'has_model',
    'has_dataset'
]);

const MACHINE_SCORE_MAXIMA = Object.freeze({
    innovation: 2,
    technical_rigor: 1.5,
    experimental_sufficiency: 1.5,
    clarity: 1,
    impact: 1.5,
    open_source: 1.5,
    reproducibility: 0.5,
    engineering_score: 1.5
});
const OPEN_SOURCE_SCORE_ANCHORS = Object.freeze([0, 0.2, 0.5, 1, 1.2, 1.5]);
const DOCUMENT_TYPES = new Set(['方法研究', '系统技术报告', '模型报告', '数据集与基准', '综述', '理论研究', '应用研究']);
const NON_EMPIRICAL_DOCUMENT_TYPES = new Set(['综述', '理论研究']);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMissingRequiredSections(text) {
    const analysis = String(text || '');
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => {
        const heading = new RegExp(`(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*\\n`, 'm');
        return !heading.test(analysis);
    });
}

function countSectionHeadings(text, title) {
    const heading = new RegExp(`(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*(?=\\n|$)`, 'gm');
    return [...String(text || '').matchAll(heading)].length;
}

function getDuplicateRequiredSections(text) {
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => countSectionHeadings(text, title) > 1);
}

function extractSection(text, title) {
    const heading = new RegExp(
        `(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*\\n([\\s\\S]*?)(?=\\n##(?!#)\\s|$)`,
        ''
    );
    return heading.exec(String(text || ''))?.[2]?.trim() || '';
}

function validateTopLevelSectionContract(analysis) {
    const headings = [...String(analysis || '').matchAll(/^##(?!#)\s*([^\n]+?)\s*$/gm)]
        .map(match => match[1].replace(/[：:]\s*$/, '').trim());
    const extra = headings.filter(title => !REQUIRED_ANALYSIS_SECTIONS.includes(title));
    if (extra.length > 0) return `包含额外一级章节: ${[...new Set(extra)].join('、')}`;
    if (headings.length !== REQUIRED_ANALYSIS_SECTIONS.length) return '一级章节数量与固定契约不一致';
    const outOfOrder = headings.findIndex((title, index) => title !== REQUIRED_ANALYSIS_SECTIONS[index]);
    if (outOfOrder >= 0) {
        return `一级章节顺序非法: 第 ${outOfOrder + 1} 节应为 ${REQUIRED_ANALYSIS_SECTIONS[outOfOrder]}`;
    }
    return null;
}

function validateMachineSummaryContract(analysis, parsed, options = {}) {
    const block = extractSection(analysis, '机器摘要');
    if (!block) return '机器摘要为空';

    const occurrences = new Map(REQUIRED_MACHINE_SUMMARY_KEYS.map(key => [key, []]));
    const unknown = [];
    for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^([a-z_]+)\s*[:：]\s*(.*?)$/);
        if (!match) return `机器摘要行格式非法: ${line.slice(0, 60)}`;
        if (!occurrences.has(match[1])) {
            unknown.push(match[1]);
            continue;
        }
        occurrences.get(match[1]).push(match[2].trim());
    }

    if (unknown.length > 0) return `机器摘要包含额外键: ${[...new Set(unknown)].join('、')}`;
    const missing = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length === 0);
    if (missing.length > 0) return `机器摘要缺少键: ${missing.join('、')}`;
    const duplicate = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length > 1);
    if (duplicate.length > 0) return `机器摘要键重复: ${duplicate.join('、')}`;
    const empty = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => !occurrences.get(key)[0]);
    if (empty.length > 0) return `机器摘要键为空: ${empty.join('、')}`;

    for (const [key, maximum] of Object.entries(MACHINE_SCORE_MAXIMA)) {
        const rawValue = occurrences.get(key)[0];
        if (!/^\d+(?:\.\d)?$/.test(rawValue)) {
            return `机器摘要 ${key} 必须是最多一位小数的非负数`;
        }
        const value = Number(rawValue);
        if (value > maximum) return `机器摘要 ${key} 超出 0-${maximum}`;
        if (key === 'open_source' && !OPEN_SOURCE_SCORE_ANCHORS.includes(value)) {
            return '机器摘要 open_source 必须使用固定开源锚点';
        }
    }
    if (!DOCUMENT_TYPES.has(occurrences.get('document_type')[0])) return '机器摘要 document_type 非法';
    if (!['前10%', '前25%', '前50%', '后50%'].includes(occurrences.get('rank_bucket')[0])) return '机器摘要 rank_bucket 非法';
    if (!['高', '中', '低'].includes(occurrences.get('confidence')[0])) return '机器摘要 confidence 非法';
    for (const key of ['primary_task_tag', 'primary_method_tag']) {
        if (!/^#[^\s#]+$/.test(occurrences.get(key)[0])) return `机器摘要 ${key} 必须是单个 #标签`;
    }
    for (const key of ['sota_claim', 'has_code', 'has_model', 'has_dataset']) {
        if (!['是', '否', '未说明'].includes(occurrences.get(key)[0])) {
            return `机器摘要 ${key} 只允许 是/否/未说明`;
        }
    }
    const parsedFields = {
        innovation: 'innovationScore',
        technical_rigor: 'technicalRigorScore',
        experimental_sufficiency: 'experimentalSufficiencyScore',
        clarity: 'clarityScore',
        impact: 'impactScore',
        open_source: 'openSourceScore',
        reproducibility: 'reproducibilityScore',
        engineering_score: 'engineeringScore'
    };
    if (options.checkScoringConsistency !== false && parsed?.scoreValidation?.valid) {
        const displayedScore = String(analysis || '').match(/(^|\n)##(?!#)\s*评分[：:\s]*\n\s*(\d+(?:\.\d)?)\s*\/\s*10(?=\s|$)/)?.[2];
        if (displayedScore === undefined || Number(displayedScore) !== Number(parsed.score)) {
            return '评分章节总分与八维评分理由不一致';
        }
        if (occurrences.get('rank_bucket')[0] !== parsed.rankBucket) {
            return '机器摘要 rank_bucket 与最终总分不一致';
        }
        for (const [machineKey, parsedKey] of Object.entries(parsedFields)) {
            if (Number(occurrences.get(machineKey)[0]) !== Number(parsed[parsedKey])) {
                return `机器摘要 ${machineKey} 与评分理由不一致`;
            }
        }
    }
    return null;
}

function validateTagSectionContract(analysis, parsed) {
    const block = extractSection(analysis, '标签');
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length !== 4) return '标签章节必须恰好四行';
    if (!/^(?:#[^\s,，;；、]+)(?:\s+#[^\s,，;；、]+){2,4}$/.test(lines[0])) {
        return '标签首行必须包含 3-5 个以空格分隔的 #标签';
    }
    if (!/^主任务标签\s*[:：]\s*#\S+$/.test(lines[1])) return '标签章节缺少合法主任务标签行';
    if (!/^主方法标签\s*[:：]\s*#\S+$/.test(lines[2])) return '标签章节缺少合法主方法标签行';
    if (!/^补充标签\s*[:：]\s*#\S+(?:\s+#\S+)*$/.test(lines[3])) return '标签章节缺少合法补充标签行';
    if (!Array.isArray(parsed?.tags) || parsed.tags.length < 3 || parsed.tags.length > 5) return '标签首行包含非白名单标签';
    if (!parsed.primaryTaskTag) return '标签章节缺少可解析的主任务标签';
    if (!parsed.primaryMethodTag) return '标签章节缺少可解析的主方法标签';
    const allTags = lines[0].match(/#[^\s]+/g) || [];
    const taskTag = lines[1].match(/#[^\s]+/)?.[0];
    const methodTag = lines[2].match(/#[^\s]+/)?.[0];
    const supplemental = lines[3].match(/#[^\s]+/g) || [];
    if (!allTags.includes(taskTag) || !allTags.includes(methodTag)) return '主任务/主方法标签必须出现在标签首行';
    const expectedSupplemental = allTags.filter(tag => tag !== taskTag && tag !== methodTag);
    if (new Set(supplemental).size !== supplemental.length ||
        supplemental.length !== expectedSupplemental.length ||
        supplemental.some(tag => !expectedSupplemental.includes(tag))) {
        return '补充标签必须恰好列出首行中除主任务/主方法外的标签';
    }
    return null;
}

function hasRequiredSections(text) {
    return getMissingRequiredSections(text).length === 0;
}

function getInvalidAnalysisReason(analysis, parsed) {
    const missingSections = getMissingRequiredSections(analysis);
    if (missingSections.length > 0) {
        return `分析结果缺少必要章节: ${missingSections.join('、')}`;
    }
    const duplicateSections = getDuplicateRequiredSections(analysis);
    if (duplicateSections.length > 0) {
        return `分析结果必要章节重复: ${duplicateSections.join('、')}`;
    }
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) return `分析结果章节契约无效: ${topLevelIssue}`;
    if (!parsed) return '分析结果无法解析';
    const machineSummaryIssue = validateMachineSummaryContract(analysis, parsed);
    if (machineSummaryIssue) return `分析结果机器摘要契约无效: ${machineSummaryIssue}`;
    const tagIssue = validateTagSectionContract(analysis, parsed);
    if (tagIssue) return `分析结果标签契约无效: ${tagIssue}`;
    if (!parsed.documentType) return '分析结果缺少有效文档类型';
    if (!parsed.scoreValidation?.valid) {
        const details = Array.isArray(parsed.scoreValidation?.errors)
            ? parsed.scoreValidation.errors.slice(0, 3).join('；')
            : '八维评分不完整或格式非法';
        return `分析结果评分契约无效: ${details}`;
    }
    if (parsed.score === undefined || parsed.score === null || Number.isNaN(Number(parsed.score))) {
        return '分析结果缺少有效评分';
    }
    if (!parsed.scoringReason || parsed.scoringReason.trim().length < 80) return '分析结果缺少有效评分理由';
    if (!parsed.summary || parsed.summary.trim().length < 80) return '分析结果缺少有效核心摘要';
    if (!parsed.architecture || parsed.architecture.trim().length < 80) return '分析结果缺少有效方法概述';
    const resultMinimumChars = NON_EMPIRICAL_DOCUMENT_TYPES.has(parsed.documentType) ? 20 : 50;
    if (!parsed.results || parsed.results.trim().length < resultMinimumChars) {
        return NON_EMPIRICAL_DOCUMENT_TYPES.has(parsed.documentType)
            ? '分析结果缺少适用验证证据'
            : '分析结果缺少有效实验结果';
    }
    return null;
}

module.exports = {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    hasRequiredSections,
    validateMachineSummaryContract,
    validateTagSectionContract,
    validateTopLevelSectionContract,
    getInvalidAnalysisReason
};

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
