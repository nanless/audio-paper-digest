'use strict';
// 零候选空日只由抓取阶段 `--allow-empty-daily` 显式放行，并由生成清单里的
// `emptyDailyBatch` 证据标记。这里集中核对该标记及它所绑定的原始候选/分析
// 快照，供发布凭证与 digest:status 共用；普通批次不会进入这些分支。

const crypto = require('node:crypto');

const EMPTY_DAILY_BATCH_MODE = 'empty_daily_batch';
const EMPTY_DAILY_BATCH_EVIDENCE_CONTRACT = 'daily-empty-batch-confirmation-v1';
const MARKER_KEYS = [
    'analysisStatus', 'batchDate', 'batchId', 'contract', 'rawCandidatesSha256',
    'sourceHealthSha256', 'zeroCandidates'
];

function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
    }
    return value;
}

function stableSha256(value) {
    return crypto.createHash('sha256')
        .update(Buffer.from(JSON.stringify(stableJson(value)), 'utf8')).digest('hex');
}

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function markerIsValid(marker, targetDate) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
    if (Object.keys(marker).sort().join(',') !== [...MARKER_KEYS].sort().join(',')) return false;
    return marker.contract === EMPTY_DAILY_BATCH_EVIDENCE_CONTRACT
        && marker.batchDate === targetDate
        && marker.zeroCandidates === true
        && marker.analysisStatus === 'complete'
        && typeof marker.batchId === 'string' && marker.batchId.trim().length > 0
        && /^[a-f0-9]{64}$/.test(String(marker.rawCandidatesSha256 || ''))
        && /^[a-f0-9]{64}$/.test(String(marker.sourceHealthSha256 || ''));
}

// 只读判断一份生成清单是否带合法空日标记；不核对原始候选文件。
function emptyDailyBatchMarker(generation, targetDate) {
    if (!generation || typeof generation !== 'object' || Array.isArray(generation)) return null;
    if (generation.publicationMode !== EMPTY_DAILY_BATCH_MODE) return null;
    if (!Array.isArray(generation.publishedPapers) || generation.publishedPapers.length !== 0) return null;
    if (generation.date !== targetDate) return null;
    const marker = generation.emptyDailyBatch;
    return markerIsValid(marker, targetDate) ? marker : null;
}

// 与 Python 的空批次来源状态检查一致：缺记录、arXiv 任一类别失败、
// 或实际抓过 HuggingFace 但失败，都不是可放行的空日。
function emptyBatchSourceHealthIssue(sourceHealth) {
    if (!sourceHealth || typeof sourceHealth !== 'object' || Array.isArray(sourceHealth)) {
        return '缺少来源状态';
    }
    const arxiv = sourceHealth.arxiv;
    const categories = arxiv && Array.isArray(arxiv.categories) ? arxiv.categories : null;
    const arxivAttempted = categories !== null && categories.length > 0;
    const huggingface = sourceHealth.huggingface;
    const huggingfaceAttempted = Boolean(huggingface)
        && typeof huggingface === 'object' && !Array.isArray(huggingface);
    if (!arxivAttempted && !huggingfaceAttempted) return '缺少来源抓取记录';
    if (arxivAttempted) {
        if (!arxiv || arxiv.ok !== true) return 'arXiv 来源不完整';
        if (categories.some(category => (
            !category || typeof category !== 'object' || category.ok !== true
        ))) return 'arXiv 存在失败的类别';
    }
    if (huggingfaceAttempted && huggingface.ok !== true) return 'HuggingFace 来源失败';
    return null;
}

// 重放空日证据：生成清单标记、原始候选字节与来源状态、分析结果必须互相
// 绑定且都是空的已完成批次。返回标记表示确认；否则返回 null。
function emptyDailyBatchConfirmation({
    generation, targetDate, rawBytes, raw, deep
} = {}) {
    const marker = emptyDailyBatchMarker(generation, targetDate);
    if (!marker) return null;
    if (!Buffer.isBuffer(rawBytes) || sha256Bytes(rawBytes) !== marker.rawCandidatesSha256) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.batchDate !== targetDate || raw.batchId !== marker.batchId) return null;
    if (!Array.isArray(raw.papers) || raw.papers.length !== 0) return null;
    const rawStats = raw.stats;
    if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) return null;
    if (rawStats.zeroCandidates !== true || rawStats.afterBlogSkip !== 0) return null;
    if (raw.sourceHealth === undefined || raw.sourceHealth === null) return null;
    if (stableSha256(raw.sourceHealth) !== marker.sourceHealthSha256) return null;
    if (emptyBatchSourceHealthIssue(raw.sourceHealth) !== null) return null;
    if (!deep || typeof deep !== 'object' || Array.isArray(deep)) return null;
    if (deep.batchDate !== targetDate || deep.batchId !== marker.batchId) return null;
    if (!Array.isArray(deep.papers) || deep.papers.length !== 0) return null;
    if (deep.status !== undefined && deep.status !== null && deep.status !== 'complete') return null;
    const stats = deep.stats;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
    if (stats.analysisStatus !== 'complete' || stats.remainingFailed !== 0
        || stats.expected !== 0 || stats.totalAfterMerge !== 0) return null;
    if (stats.pipelineStatus !== undefined && stats.pipelineStatus !== null
        && stats.pipelineStatus !== 'analysis_complete') return null;
    if (stats.sourceHealth !== undefined && stats.sourceHealth !== null
        && emptyBatchSourceHealthIssue(stats.sourceHealth) !== null) return null;
    return marker;
}

module.exports = {
    EMPTY_DAILY_BATCH_MODE,
    EMPTY_DAILY_BATCH_EVIDENCE_CONTRACT,
    MARKER_KEYS,
    stableSha256,
    sha256Bytes,
    markerIsValid,
    emptyDailyBatchMarker,
    emptyBatchSourceHealthIssue,
    emptyDailyBatchConfirmation
};
