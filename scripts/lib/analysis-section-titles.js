'use strict';

// 新分析使用“论文评价”。旧标题只用于识别保存的正文，不改写原文。
const PAPER_EVALUATION_TITLE = '论文评价';
const LEGACY_PAPER_EVALUATION_TITLE = '毒舌点评';
const PAPER_EVALUATION_TITLES = Object.freeze([
    PAPER_EVALUATION_TITLE, LEGACY_PAPER_EVALUATION_TITLE
]);

function normalizeAnalysisSectionTitle(title) {
    return PAPER_EVALUATION_TITLES.includes(title) ? PAPER_EVALUATION_TITLE : title;
}

function analysisSectionTitlePattern(title) {
    const titles = normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE
        ? PAPER_EVALUATION_TITLES : [title];
    return titles.map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

function visibleAnalysisLines(text) {
    const lines = [];
    let offset = 0;
    let fence = null;
    for (const line of String(text || '').match(/[^\n]*\n|[^\n]+$/g) || []) {
        const body = line.replace(/[\r\n]+$/, '');
        const marker = /^[\t ]{0,3}(`{3,}|~{3,})(.*)$/.exec(body);
        if (fence) {
            if (marker && marker[1][0] === fence.character
                && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        } else if (marker) {
            fence = { character: marker[1][0], length: marker[1].length };
        } else {
            lines.push({ start: offset, end: offset + line.length, body });
        }
        offset += line.length;
    }
    return lines;
}

function analysisSectionHeadings(text) {
    return visibleAnalysisLines(text).flatMap(line => {
        const match = /^##(?!#)[\t ]*([^\r\n]+?)[\t ]*$/.exec(line.body);
        if (!match) return [];
        const title = match[1].trim().replace(/[：:]$/, '').trim();
        return [{ ...line, title, section: normalizeAnalysisSectionTitle(title) }];
    });
}

function paperEvaluationHeadings(text) {
    return analysisSectionHeadings(text)
        .filter(heading => heading.section === PAPER_EVALUATION_TITLE);
}

function extractAnalysisSection(text, title) {
    const source = String(text || '');
    const headings = analysisSectionHeadings(source);
    const matches = headings.filter(heading => heading.section === normalizeAnalysisSectionTitle(title));
    if (matches.length === 0 || (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE
        && matches.length !== 1)) return '';
    const heading = matches[0];
    const next = headings.find(item => item.start >= heading.end);
    return source.slice(heading.end, next ? next.start : source.length).trim();
}

function getPaperEvaluationHeadingIssue(text) {
    return paperEvaluationHeadings(text).length > 1
        ? '论文评价章节重复：新旧标题只能选用一种，且只能出现一次。'
        : null;
}

function getCurrentPaperEvaluationHeadingIssue(text) {
    const duplicate = getPaperEvaluationHeadingIssue(text);
    if (duplicate) return duplicate;
    const headings = paperEvaluationHeadings(text);
    return headings.length !== 1 || headings[0].title !== PAPER_EVALUATION_TITLE
        ? '新生成的分析必须包含且只包含一个“论文评价”章节。'
        : null;
}

module.exports = {
    PAPER_EVALUATION_TITLE,
    LEGACY_PAPER_EVALUATION_TITLE,
    PAPER_EVALUATION_TITLES,
    normalizeAnalysisSectionTitle,
    analysisSectionTitlePattern,
    visibleAnalysisLines,
    analysisSectionHeadings,
    extractAnalysisSection,
    getPaperEvaluationHeadingIssue,
    getCurrentPaperEvaluationHeadingIssue
};
