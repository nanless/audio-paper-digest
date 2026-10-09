const STATUS_LABELS = Object.freeze({
    complete: '完成', partial_failed: '部分失败', failed: '失败', incomplete: '未完成'
});
const SOURCE_LABELS = Object.freeze({
    html: '论文网页全文', pdf: '论文 PDF 文本', abstract: '论文摘要',
    provided_full_text: '传入的全文', provided_pdf_text: '传入的 PDF 文本',
    conference_pdf_text: '会议论文 PDF 文本', unavailable: '来源不可得', unknown: '来源未知'
});

function formatAnalysisStatus(status) {
    return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : `未知状态（原值：${String(status)}）`;
}

function formatAnalysisCount(count) {
    return Number.isSafeInteger(count) && count >= 0 ? String(count) : `未知（原值：${String(count)}）`;
}

function formatAnalysisSources(sourceCounts) {
    return Object.entries(sourceCounts || {}).map(([source, count]) => {
        const label = Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : `未知来源（原值：${source}）`;
        return `${label}：${formatAnalysisCount(count)} 篇`;
    }).join(' | ');
}

module.exports = { formatAnalysisStatus, formatAnalysisCount, formatAnalysisSources };
