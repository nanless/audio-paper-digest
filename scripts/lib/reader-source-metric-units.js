'use strict';

// Preserve a source's literal distance-based event metric. This does not turn
// unknown rates into percentages or waive factual/model-to-row validation.
function isSourceSupportedEventDistanceComparison(issue, article, evidence) {
    if (issue?.code !== 'comparison_unit_missing') return false;
    const sentence = String(issue.match || '');
    if (!sentence || !String(article || '').includes(sentence)) return false;
    const source = String(evidence?.sourceText || '');
    const definition = source.match(/Event\s+error\s+rate\s*\(evER\)[^.\n]{0,400}Levenshtein\s+distance[^.\n]{0,240}/i)?.[0];
    if (!definition || /%|percent(?:age)?|单位|unit/i.test(definition)) return false;
    if (/准确率|正确率|召回率|覆盖率|命中率|\b(?:WER|CER|PER)\b|%|百分/iu.test(sentence)) return false;
    const scalar = '\\d+(?:\\.\\d+)?';
    const direction = '(?:降到|降至|降低到|降低至|升到|升至|提高到|提高至|增加到|减少到|变为)';
    const comparisons = [...sentence.matchAll(new RegExp(
        `(?:事件错误率|\\bevER\\b)\\s*(?:从|由)\\s*(${scalar})\\s*${direction}\\s*(${scalar})`, 'giu'))];
    const allComparisons = [...sentence.matchAll(new RegExp(
        `(?:从|由)\\s*(${scalar})\\s*${direction}\\s*(${scalar})`, 'gu'))];
    if (!comparisons.length || comparisons.length !== allComparisons.length) return false;
    return comparisons.every(match => (evidence?.structuredArtifacts?.tables || []).some(table => {
        if (table.recoveryStatus !== 'complete' || !Array.isArray(table.matrix)
            || /%|percent(?:age)?/i.test(String(table.caption || ''))) return false;
        const rows = table.matrix;
        return rows.some((row, headerRow) => Array.isArray(row) && row.some((header, column) => {
            if (!/^evER(?:[↑↓]|\\(?:uparrow|downarrow))*$/i.test(String(header).replace(/\s/g, ''))) return false;
            const values = rows.slice(headerRow + 1).map(values => String(values?.[column] ?? '').trim());
            return values.includes(match[1]) && values.includes(match[2]);
        }));
    }));
}

module.exports = { isSourceSupportedEventDistanceComparison };
