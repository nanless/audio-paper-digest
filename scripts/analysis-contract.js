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

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMissingRequiredSections(text) {
    const analysis = String(text || '');
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => {
        const heading = new RegExp(`(^|\\n)#{2,3}\\s*${escapeRegExp(title)}[：:\\s]*\\n`, 'm');
        return !heading.test(analysis);
    });
}

function hasRequiredSections(text) {
    return getMissingRequiredSections(text).length === 0;
}

function getInvalidAnalysisReason(analysis, parsed) {
    const missingSections = getMissingRequiredSections(analysis);
    if (missingSections.length > 0) {
        return `分析结果缺少必要章节: ${missingSections.join('、')}`;
    }
    if (!parsed) return '分析结果无法解析';
    if (!parsed.documentType) return '分析结果缺少有效文档类型';
    if (parsed.score === undefined || parsed.score === null || Number.isNaN(Number(parsed.score))) {
        return '分析结果缺少有效评分';
    }
    if (!parsed.scoringReason || parsed.scoringReason.trim().length < 80) return '分析结果缺少有效评分理由';
    if (!parsed.summary || parsed.summary.trim().length < 80) return '分析结果缺少有效核心摘要';
    if (!parsed.architecture || parsed.architecture.trim().length < 80) return '分析结果缺少有效方法概述';
    if (!parsed.results || parsed.results.trim().length < 50) return '分析结果缺少有效实验结果';
    return null;
}

module.exports = {
    REQUIRED_ANALYSIS_SECTIONS,
    getMissingRequiredSections,
    hasRequiredSections,
    getInvalidAnalysisReason
};
