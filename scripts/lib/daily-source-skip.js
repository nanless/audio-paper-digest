'use strict';
// 日更入选后，若某篇论文的官方 PDF 在全部候选地址上都返回 404，这篇论文在当前批次
// 取不到来源。按用户 2026-11-04 的要求，少量这种论文可以跳过，不阻塞整批；跳过是
// 一个独立的、可核验的事实记录，不是把失败写成通过：
//   - 只接受全部官方 PDF 候选地址 404 的确定性缺失，超时、认证、5xx、解析失败都不算；
//   - 每批最多跳过 resolveSkipLimit() 篇（默认 2，可用 PD_DAILY_SOURCE_SKIP_MAX 调整，范围 0–5）；
//   - 跳过记录随封存来源运行目录一起保存，绑定批次日期、运行 ID 与每篇的错误证据；
//   - 被跳过的论文不进入分析、不生成页面，也不会被计为分析成功。
const fs = require('node:fs');
const path = require('node:path');
const protocols = require('./protocol-codec');

const FAMILY = 'daily-source-skip';
const FILENAME = 'daily-source-skips.json';
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 5;

class DailySourceSkipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DailySourceSkipError';
    }
}

function fail(message) {
    throw new DailySourceSkipError(message);
}

// 环境变量在模块加载后仍可能被测试覆写，因此每次调用重新解析。
function resolveSkipLimit(value = process.env.PD_DAILY_SOURCE_SKIP_MAX) {
    if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) fail('PD_DAILY_SOURCE_SKIP_MAX 必须是 0 到 5 之间的整数');
    const limit = Number(text);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
        fail('PD_DAILY_SOURCE_SKIP_MAX 必须是 0 到 5 之间的整数');
    }
    return limit;
}

// 只有“官方 PDF 全部候选地址都返回 404”这一种情况可以跳过。抓取器在试完所有
// 候选地址后才抛出这个带 code/status 的错误；其余错误保持原样停止。
function isSkippableSourceError(error) {
    return Boolean(error) && error.code === 'ARXIV_PDF_NOT_FOUND' && error.status === 404;
}

function header() {
    return protocols.recordHeader(FAMILY, FAMILY);
}

function isSkipRecord(value) {
    return Boolean(value) && protocols.hasValidHeader(value, FAMILY);
}

function recordFor(plan, skipped, { limit = resolveSkipLimit() } = {}) {
    if (!plan || typeof plan !== 'object' || typeof plan.runId !== 'string' || !plan.runId) {
        fail('跳过记录需要真实的日更来源运行');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plan.batchDate || ''))) fail('日更来源运行缺少合法的批次日期');
    if (!Array.isArray(plan.paperIds) || !plan.paperIds.length) fail('日更来源运行缺少论文集合');
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) fail('跳过上限必须是 0 到 5 之间的整数');
    if (!Array.isArray(skipped) || !skipped.length) fail('跳过记录至少需要一篇论文');
    if (skipped.length > limit) fail(`本批可跳过的论文不能超过 ${limit} 篇`);
    const seen = new Set();
    const papers = skipped.map(item => {
        const arxivId = String(item?.arxivId || '').trim().replace(/v\d+$/i, '');
        if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) fail('跳过记录的论文标识无效');
        if (seen.has(arxivId)) fail(`跳过记录中的论文重复：${arxivId}`);
        seen.add(arxivId);
        if (!plan.paperIds.includes(arxivId)) fail(`跳过的论文不在本次来源运行中：${arxivId}`);
        if (item.errorCode !== 'ARXIV_PDF_NOT_FOUND' || item.status !== 404) {
            fail('只有官方 PDF 全部候选地址返回 404 的论文才能跳过');
        }
        const message = String(item.message || '').trim();
        if (!message || message.length > 500) fail('跳过记录需要保留原始错误信息');
        return {
            arxivId,
            errorCode: 'ARXIV_PDF_NOT_FOUND',
            status: 404,
            reason: '官方 PDF 的全部候选地址返回 404，本批跳过，未进入分析',
            message,
        };
    });
    return protocols.record(FAMILY, {
        batchDate: plan.batchDate,
        runId: plan.runId,
        limit,
        count: papers.length,
        papers,
    });
}

function validate(record, plan, { limit = resolveSkipLimit() } = {}) {
    if (!isSkipRecord(record)) fail('跳过记录的格式声明无效');
    const fields = ['batchDate', 'runId', 'limit', 'count', 'papers'];
    if (Object.keys(record).sort().join(',') !== [...Object.keys(header()), ...fields].sort().join(',')) {
        fail('跳过记录含格式声明之外的字段');
    }
    if (record.batchDate !== plan.batchDate) fail('跳过记录的批次日期与来源运行不一致');
    if (record.runId !== plan.runId) fail('跳过记录的运行 ID 与来源运行不一致');
    if (!Number.isSafeInteger(record.limit) || record.limit < 0 || record.limit > MAX_LIMIT) fail('跳过记录的上限无效');
    if (record.limit > limit) fail('跳过记录的上限超过当前配置');
    if (!Array.isArray(record.papers) || !record.papers.length) fail('跳过记录至少需要一篇论文');
    if (record.count !== record.papers.length) fail('跳过记录的篇数与论文列表不一致');
    if (record.count > record.limit) fail('跳过记录的篇数超过本批上限');
    const seen = new Set();
    for (const paper of record.papers) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) fail('跳过记录的论文项必须是对象');
        const keys = Object.keys(paper).sort().join(',');
        if (keys !== 'arxivId,errorCode,message,reason,status') fail('跳过记录的论文项字段不正确');
        if (!plan.paperIds.includes(paper.arxivId)) fail(`跳过的论文不在本次来源运行中：${paper.arxivId}`);
        if (seen.has(paper.arxivId)) fail(`跳过记录中的论文重复：${paper.arxivId}`);
        seen.add(paper.arxivId);
        if (paper.errorCode !== 'ARXIV_PDF_NOT_FOUND' || paper.status !== 404) {
            fail('跳过记录只接受官方 PDF 404 证据');
        }
        if (typeof paper.message !== 'string' || !paper.message.trim()) fail('跳过记录缺少原始错误信息');
        if (typeof paper.reason !== 'string' || !paper.reason.trim()) fail('跳过记录缺少跳过理由');
    }
    return record;
}

function skipFile(plan) {
    if (!plan || typeof plan.runDir !== 'string' || !plan.runDir) fail('跳过记录需要来源运行目录');
    return path.join(plan.runDir, FILENAME);
}

function readDailySourceSkips(plan, options = {}) {
    const file = skipFile(plan);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    let record;
    try {
        record = JSON.parse(raw);
    } catch (error) {
        fail(`跳过记录无法按 JSON 读取：${error.message}`);
    }
    return validate(record, plan, options);
}

function writeDailySourceSkips(plan, skipped, options = {}) {
    const record = recordFor(plan, skipped, options);
    const file = skipFile(plan);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const existing = readDailySourceSkips(plan, options);
    if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) fail('已保存的跳过记录与本次结果不一致');
        return existing;
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    try {
        fs.renameSync(temporary, file);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_cleanup) { /* 保留原错误 */ }
        throw error;
    }
    return record;
}

function skippedPaperIds(record) {
    return new Set((record?.papers || []).map(paper => paper.arxivId));
}

module.exports = {
    FAMILY,
    FILENAME,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DailySourceSkipError,
    resolveSkipLimit,
    isSkippableSourceError,
    header,
    isSkipRecord,
    recordFor,
    validate,
    readDailySourceSkips,
    writeDailySourceSkips,
    skippedPaperIds,
};
