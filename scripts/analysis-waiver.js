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
        throw new Error('analysis waiver date/directory is invalid');
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
        issues.push(`${label} missing`);
        return null;
    }
    try { return sha256File(filePath); }
    catch (error) { issues.push(`${label} unreadable: ${error.message}`); return null; }
}

function validateAnalysisWaiver(waiver, date, files = Config.FILES, snapshots = {}) {
    const issues = [];
    if (waiver === null || waiver === undefined) return { valid: true, issues, paperIds: new Set() };
    if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
        return { valid: false, issues: ['waiver must be an object'], paperIds: new Set() };
    }
    const expectedKeys = [
        'batchDate', 'contract', 'papers', 'reason', 'requestedBy', 'source',
        'status', 'version', 'waivedAt', 'waiverSha256'
    ].sort();
    if (JSON.stringify(Object.keys(waiver).sort()) !== JSON.stringify(expectedKeys)) {
        issues.push('waiver has unknown or missing fields');
    }
    if (waiver.contract !== CONTRACT || waiver.version !== VERSION) issues.push('waiver contract/version invalid');
    if (waiver.batchDate !== date || !DATE_RE.test(waiver.batchDate || '')) issues.push('waiver batchDate invalid');
    if (waiver.status !== 'waived' || waiver.requestedBy !== 'user') issues.push('waiver status/requester invalid');
    if (typeof waiver.reason !== 'string' || waiver.reason.trim().length < 10) issues.push('waiver reason is too short');
    if (typeof waiver.waivedAt !== 'string' || !Number.isFinite(Date.parse(waiver.waivedAt))) issues.push('waiver timestamp invalid');
    if (!Array.isArray(waiver.papers) || waiver.papers.length === 0) issues.push('waiver papers must be a non-empty array');

    const entries = Array.isArray(waiver.papers) ? waiver.papers : [];
    const entryKeys = ['deepPaperSha256', 'originalDigestStatus', 'originalLatestAttemptStatus', 'paperId', 'sourceSha256'].sort();
    const ids = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(entryKeys)) {
            issues.push('waiver paper entry has unknown or missing fields'); continue;
        }
        const id = normalizedId(entry.paperId);
        if (!id || id !== entry.paperId) issues.push('waiver paperId is not normalized');
        ids.push(id);
        if (!SHA256_RE.test(entry.deepPaperSha256 || '') || !SHA256_RE.test(entry.sourceSha256 || '')) {
            issues.push(`waiver paper hashes invalid: ${entry.paperId}`);
        }
        if (entry.originalDigestStatus !== null && typeof entry.originalDigestStatus !== 'string') {
            issues.push(`waiver original digest status invalid: ${entry.paperId}`);
        }
        if (entry.originalLatestAttemptStatus !== null && typeof entry.originalLatestAttemptStatus !== 'string') {
            issues.push(`waiver original latest attempt status invalid: ${entry.paperId}`);
        }
    }
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length !== ids.length || JSON.stringify(uniqueIds) !== JSON.stringify(ids.slice().sort())) {
        issues.push('waiver paper IDs must be unique and sorted');
    }

    const source = waiver.source;
    const sourceKeys = ['deepAnalysisResultSha256', 'filteredPapersSha256', 'papersDatabaseSha256'].sort();
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(sourceKeys)
        || sourceKeys.some(key => !SHA256_RE.test(source[key] || ''))) issues.push('waiver source binding is invalid');
    const body = { ...waiver }; delete body.waiverSha256;
    if (!SHA256_RE.test(waiver.waiverSha256 || '') || waiver.waiverSha256 !== stableSha256(body)) issues.push('waiver SHA mismatch');

    const actualDeepSha = fileBinding(files.deepAnalysisResult, 'deep-analysis-result.json', issues);
    const actualFilteredSha = fileBinding(files.filteredPapers, 'filtered-papers.json', issues);
    const actualPapersSha = fileBinding(files.papers, 'papers.json', issues);
    if (source?.deepAnalysisResultSha256 !== actualDeepSha) issues.push('deep analysis artifact drifted');
    if (source?.filteredPapersSha256 !== actualFilteredSha) issues.push('filtered artifact drifted');
    if (source?.papersDatabaseSha256 !== actualPapersSha) issues.push('papers database drifted');

    let deep = snapshots.deep;
    let papers = snapshots.papers;
    if (!deep && files.deepAnalysisResult && fs.existsSync(files.deepAnalysisResult)) {
        try { deep = JSON.parse(fs.readFileSync(files.deepAnalysisResult, 'utf8')); } catch { issues.push('deep analysis artifact is not JSON'); }
    }
    if (!papers && files.papers && fs.existsSync(files.papers)) {
        try { papers = JSON.parse(fs.readFileSync(files.papers, 'utf8')); } catch { issues.push('papers artifact is not JSON'); }
    }
    if (deep?.batchDate && deep.batchDate !== date) issues.push('deep analysis batchDate drifted');
    const deepById = new Map(paperList(deep).map(paper => [normalizedId(paper), paper]).filter(([id]) => id));
    const database = papers?.papers && typeof papers.papers === 'object' ? papers.papers : {};
    for (const entry of entries) {
        const id = normalizedId(entry.paperId); const deepPaper = deepById.get(id);
        if (!deepPaper) { issues.push(`waiver paper is absent from deep analysis: ${id}`); continue; }
        if (stableSha256(deepPaper) !== entry.deepPaperSha256) issues.push(`deep paper drifted: ${id}`);
        const actualSourceSha = deepPaper.sourceSha256 || deepPaper.analysisManifest?.sourceAcquisition?.sourceSha256;
        if (actualSourceSha !== entry.sourceSha256) issues.push(`source binding drifted: ${id}`);
        const dbPaper = database[id];
        if (!dbPaper) issues.push(`waiver paper is absent from papers database: ${id}`);
        if (dbPaper && entry.originalDigestStatus !== (dbPaper.digestStatus?.status ?? null)) issues.push(`original digest status drifted: ${id}`);
        if (dbPaper && entry.originalLatestAttemptStatus !== (dbPaper.digestStatus?.latestAttemptStatus ?? null)) issues.push(`original latest attempt status drifted: ${id}`);
    }
    return { valid: issues.length === 0, issues, paperIds: new Set(uniqueIds) };
}

function createAnalysisWaiver({ date, paperIds, reason, files = Config.FILES, now = getBeijingISOString }) {
    if (!DATE_RE.test(String(date || ''))) throw new Error('date is invalid');
    if (!Array.isArray(paperIds) || paperIds.length === 0) throw new Error('paperIds must be non-empty');
    const ids = [...new Set(paperIds.map(normalizedId).filter(Boolean))].sort();
    if (ids.length !== paperIds.length) throw new Error('paperIds must be normalized and unique');
    if (String(reason || '').trim().length < 10) throw new Error('reason must be at least 10 characters');
    const deep = JSON.parse(fs.readFileSync(files.deepAnalysisResult, 'utf8'));
    const papers = JSON.parse(fs.readFileSync(files.papers, 'utf8'));
    const deepById = new Map(paperList(deep).map(paper => [normalizedId(paper), paper]).filter(([id]) => id));
    const db = papers.papers || {};
    const entries = ids.map(id => {
        const deepPaper = deepById.get(id); const dbPaper = db[id];
        if (!deepPaper || !dbPaper) throw new Error(`paper not found in current artifacts: ${id}`);
        const sourceSha256 = deepPaper.sourceSha256 || deepPaper.analysisManifest?.sourceAcquisition?.sourceSha256;
        if (!SHA256_RE.test(sourceSha256 || '')) throw new Error(`paper has no sealed source hash: ${id}`);
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
