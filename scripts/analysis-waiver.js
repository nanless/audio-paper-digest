#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');

const CONTRACT = 'daily-analysis-waiver-v1';
const VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function stableSha256(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function paperList(value) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.papers) ? value.papers : [];
}

function waiverPath(date, files = Config.FILES) {
    if (!DATE_RE.test(String(date || '')) || !path.isAbsolute(files.analysisWaiverDir)) {
        throw new Error('分析豁免的日期或目录不合法：日期要写成 YYYY-MM-DD，目录要是绝对路径');
    }
    return path.join(files.analysisWaiverDir, `${date}.json`);
}

function loadAnalysisWaiver(date, files = Config.FILES) {
    const filename = waiverPath(date, files);
    if (!fs.existsSync(filename)) return null;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function fileBinding(filePath, label, issues) {
    if (!filePath || !fs.existsSync(filePath)) {
        issues.push(`未指定 ${label} 文件，或该文件不存在`);
        return null;
    }
    try { return sha256File(filePath); }
    catch (error) { issues.push(`无法读取 ${label} 文件或计算其 SHA-256： ${error.message}`); return null; }
}

function validateAnalysisWaiver(waiver, date, files = Config.FILES, snapshots = {}) {
    const issues = [];
    if (waiver === null || waiver === undefined) return { valid: true, issues, paperIds: new Set() };
    if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
        return { valid: false, issues: ['分析豁免记录必须是对象，不能是数组'], paperIds: new Set() };
    }
    const expectedKeys = [
        'batchDate', 'contract', 'papers', 'reason', 'requestedBy', 'source',
        'status', 'version', 'waivedAt', 'waiverSha256'
    ].sort();
    if (JSON.stringify(Object.keys(waiver).sort()) !== JSON.stringify(expectedKeys)) {
        issues.push('分析豁免记录含有未知字段或缺少必需字段');
    }
    if (waiver.contract !== CONTRACT || waiver.version !== VERSION) issues.push('分析豁免记录的 contract 或 version 不符合要求');
    if (waiver.batchDate !== date || !DATE_RE.test(waiver.batchDate || '')) issues.push('分析豁免记录的 batchDate 格式无效或与目标日期不一致');
    if (waiver.status !== 'waived' || waiver.requestedBy !== 'user') issues.push('分析豁免记录的 status 必须为 waived，requestedBy 必须为 user');
    if (typeof waiver.reason !== 'string' || waiver.reason.trim().length < 10) issues.push('分析豁免记录的 reason 必须是去除首尾空白后至少含 10 个字符的字符串');
    if (typeof waiver.waivedAt !== 'string' || !Number.isFinite(Date.parse(waiver.waivedAt))) issues.push('分析豁免记录的 waivedAt 必须是可解析的日期时间字符串');
    if (!Array.isArray(waiver.papers) || waiver.papers.length === 0) issues.push('分析豁免记录的 papers 必须是至少包含一项的数组');

    const entries = Array.isArray(waiver.papers) ? waiver.papers : [];
    const entryKeys = ['deepPaperSha256', 'originalDigestStatus', 'originalLatestAttemptStatus', 'paperId', 'sourceSha256'].sort();
    const ids = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(entryKeys)) {
            issues.push('豁免的逐论文记录不是对象、是数组，或含有未知字段或缺少必需字段'); continue;
        }
        const id = normalizedId(entry.paperId);
        if (!id || id !== entry.paperId) issues.push('豁免记录的 paperId 不是标准论文 ID 格式');
        ids.push(id);
        if (!SHA256_RE.test(entry.deepPaperSha256 || '') || !SHA256_RE.test(entry.sourceSha256 || '')) {
            issues.push(`豁免记录的 deepPaperSha256 或 sourceSha256 不是 64 位小写十六进制 SHA-256： ${entry.paperId}`);
        }
        if (entry.originalDigestStatus !== null && typeof entry.originalDigestStatus !== 'string') {
            issues.push(`豁免记录的 originalDigestStatus 必须为字符串或 null： ${entry.paperId}`);
        }
        if (entry.originalLatestAttemptStatus !== null && typeof entry.originalLatestAttemptStatus !== 'string') {
            issues.push(`豁免记录的 originalLatestAttemptStatus 必须为字符串或 null： ${entry.paperId}`);
        }
    }
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length !== ids.length || JSON.stringify(uniqueIds) !== JSON.stringify(ids)) {
        issues.push('豁免记录的论文 ID 必须排序且不能重复');
    }

    const source = waiver.source;
    const sourceKeys = ['deepAnalysisResultSha256', 'filteredPapersSha256', 'papersDatabaseSha256'].sort();
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(sourceKeys)
        || sourceKeys.some(key => !SHA256_RE.test(source[key] || ''))) issues.push('豁免记录的 source 必须是只含 deepAnalysisResultSha256、filteredPapersSha256 和 papersDatabaseSha256 的对象，三项均须为 64 位小写十六进制 SHA-256');
    const body = { ...waiver }; delete body.waiverSha256;
    if (!SHA256_RE.test(waiver.waiverSha256 || '') || waiver.waiverSha256 !== stableSha256(body)) issues.push('豁免记录的 waiverSha256 格式无效，或与记录内容重新计算的 SHA-256 不一致');

    const actualDeepSha = fileBinding(files.deepAnalysisResult, 'deep-analysis-result.json', issues);
    const actualFilteredSha = fileBinding(files.filteredPapers, 'filtered-papers.json', issues);
    const actualPapersSha = fileBinding(files.papers, 'papers.json', issues);
    if (source?.deepAnalysisResultSha256 !== actualDeepSha) issues.push('无法确认 deep-analysis-result.json 与豁免记录中的 source.deepAnalysisResultSha256 相符');
    if (source?.filteredPapersSha256 !== actualFilteredSha) issues.push('无法确认 filtered-papers.json 与豁免记录中的 source.filteredPapersSha256 相符');
    if (source?.papersDatabaseSha256 !== actualPapersSha) issues.push('无法确认 papers.json 与豁免记录中的 source.papersDatabaseSha256 相符');

    let deep = snapshots.deep;
    let papers = snapshots.papers;
    if (!deep && files.deepAnalysisResult && fs.existsSync(files.deepAnalysisResult)) {
        try { deep = JSON.parse(fs.readFileSync(files.deepAnalysisResult, 'utf8')); } catch { issues.push('无法读取 deep-analysis-result.json 或将其解析为 JSON'); }
    }
    if (!papers && files.papers && fs.existsSync(files.papers)) {
        try { papers = JSON.parse(fs.readFileSync(files.papers, 'utf8')); } catch { issues.push('无法读取 papers.json 或将其解析为 JSON'); }
    }
    if (deep?.batchDate && deep.batchDate !== date) issues.push('分析结果的 batchDate 与目标日期不一致');
    const deepById = new Map(paperList(deep).map(paper => [normalizedId(paper), paper]).filter(([id]) => id));
    const database = papers?.papers && typeof papers.papers === 'object' ? papers.papers : {};
    for (const entry of entries) {
        const id = normalizedId(entry.paperId); const deepPaper = deepById.get(id);
        if (!deepPaper) { issues.push(`分析结果中找不到豁免记录指定的论文： ${id}`); continue; }
        if (stableSha256(deepPaper) !== entry.deepPaperSha256) issues.push(`分析结果中的论文记录与 deepPaperSha256 不一致： ${id}`);
        const actualSourceSha = deepPaper.sourceSha256 || deepPaper.analysisManifest?.sourceAcquisition?.sourceSha256;
        if (actualSourceSha !== entry.sourceSha256) issues.push(`分析结果中的论文来源 SHA 与 sourceSha256 不一致： ${id}`);
        const dbPaper = database[id];
        if (!dbPaper) issues.push(`论文库中找不到豁免记录指定的论文： ${id}`);
        if (dbPaper && entry.originalDigestStatus !== (dbPaper.digestStatus?.status ?? null)) issues.push(`论文库当前的 digestStatus.status 与 originalDigestStatus 不一致： ${id}`);
        if (dbPaper && entry.originalLatestAttemptStatus !== (dbPaper.digestStatus?.latestAttemptStatus ?? null)) issues.push(`论文库当前的 digestStatus.latestAttemptStatus 与 originalLatestAttemptStatus 不一致： ${id}`);
    }
    return { valid: issues.length === 0, issues, paperIds: new Set(uniqueIds) };
}

function createAnalysisWaiver({ date, paperIds, reason, files = Config.FILES, now = getBeijingISOString }) {
    if (!DATE_RE.test(String(date || ''))) throw new Error(`日期不合法：期望 YYYY-MM-DD，当前是 ${date}`);
    if (!Array.isArray(paperIds) || paperIds.length === 0) throw new Error('paperIds 不能为空，至少要给一篇论文');
    const ids = [...new Set(paperIds.map(normalizedId).filter(Boolean))].sort();
    if (ids.length !== paperIds.length) throw new Error('paperIds 必须是规范化且不重复的论文 ID');
    if (String(reason || '').trim().length < 10) throw new Error('reason 至少要 10 个字符，否则说明不了豁免理由');
    const deep = JSON.parse(fs.readFileSync(files.deepAnalysisResult, 'utf8'));
    const papers = JSON.parse(fs.readFileSync(files.papers, 'utf8'));
    const deepById = new Map(paperList(deep).map(paper => [normalizedId(paper), paper]).filter(([id]) => id));
    const db = papers.papers || {};
    const entries = ids.map(id => {
        const deepPaper = deepById.get(id); const dbPaper = db[id];
        if (!deepPaper || !dbPaper) throw new Error(`当前分析结果或论文库中找不到这篇论文：${id}`);
        const sourceSha256 = deepPaper.sourceSha256 || deepPaper.analysisManifest?.sourceAcquisition?.sourceSha256;
        if (!SHA256_RE.test(sourceSha256 || '')) throw new Error(`论文缺少可核验的来源 SHA（深度分析结果里没有 sourceSha256）: ${id}`);
        return { paperId: id, deepPaperSha256: stableSha256(deepPaper), sourceSha256,
            originalDigestStatus: dbPaper.digestStatus?.status ?? null,
            originalLatestAttemptStatus: dbPaper.digestStatus?.latestAttemptStatus ?? null };
    });
    const payload = { contract: CONTRACT, version: VERSION, batchDate: date, status: 'waived',
        requestedBy: 'user', reason: String(reason).trim(), waivedAt: now(), source: {
            deepAnalysisResultSha256: sha256File(files.deepAnalysisResult),
            filteredPapersSha256: sha256File(files.filteredPapers),
            papersDatabaseSha256: sha256File(files.papers)
        }, papers: entries };
    payload.waiverSha256 = stableSha256(payload);
    const output = waiverPath(date, files);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeFileAtomic(output, JSON.stringify(payload, null, 2));
    return { output, payload };
}

module.exports = { CONTRACT, VERSION, stableSha256, sha256File, paperList, waiverPath,
    loadAnalysisWaiver, validateAnalysisWaiver, createAnalysisWaiver };
