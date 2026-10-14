'use strict';

// 已封存 Manual 全文的只读兼容身份适配器；没有新抓取、新运行或状态写入入口。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeUsagePaperId } = require('./llm-usage.js');
const { readRegular } = require('./publication-file-primitives.js');
const MANIFEST_VERSION = 2;
function normalizedId(value) { return String(value || '').replace(/v\d+$/, '').trim().toLowerCase(); }
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return sha256(Buffer.from(JSON.stringify(stableValue(value))));
}

function getRequestedArxivId(paper) {
    const rawValues = [paper?.arxivId, paper?.paper_id, paper?.id]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const parsed = rawValues.map(raw => {
        const candidate = raw.replace(/^arxiv:\s*/i, '')
            .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
            .replace(/\.pdf$/i, '')
            .replace(/V([0-9]+)$/, 'v$1')
            .replace(/^([a-z-]+)(?:\.([a-z]{2}))?\//i, (_match, archive, subject) =>
                `${archive.toLowerCase()}${subject ? `.${subject.toUpperCase()}` : ''}/`);
        const id = normalizeUsagePaperId(candidate);
        return id && !id.startsWith('conference:') ? id : '';
    }).filter(Boolean);
    if (parsed.length === 0) {
        throw new Error(`filtered paper 缺少可抓取的 arXiv ID: ${rawValues.join(' / ') || '(missing)'}`);
    }
    const normalizedIds = new Set(parsed.map(normalizedId));
    if (normalizedIds.size !== 1) throw new Error(`filtered paper 包含冲突 arXiv ID: ${parsed.join(' / ')}`);
    const versioned = parsed.filter(value => /v\d+$/i.test(value));
    if (new Set(versioned).size > 1) throw new Error(`filtered paper 包含冲突 arXiv 版本: ${versioned.join(' / ')}`);
    return versioned[0] || parsed[0];
}

function buildFilteredBatchFingerprint(filtered) {
    return stableSha256(filtered);
}

function buildPaperInputIdentity(paper, filteredBatchSha256, outDir) {
    const requestedArxivId = getRequestedArxivId(paper);
    const id = normalizedId(requestedArxivId);
    const paperMetadataSha256 = stableSha256(paper);
    const paperInputSha256 = stableSha256({
        filteredBatchSha256,
        paperMetadataSha256,
        requestedArxivId
    });
    return {
        id,
        filteredBatchSha256,
        requestedArxivId,
        paperMetadataSha256,
        paperInputSha256,
        filePath: path.join(outDir, `${id}-${paperInputSha256.slice(0, 16)}.txt`)
    };
}

function buildManifestContext(filtered, date, outDir) {
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const inputs = filtered.papers.map(paper => buildPaperInputIdentity(paper, filteredBatchSha256, outDir));
    const byId = new Map();
    for (const input of inputs) {
        if (byId.has(input.id)) throw new Error(`filtered papers 含重复规范化 ID: ${input.id}`);
        byId.set(input.id, input);
    }
    return {
        date,
        filteredBatchSha256,
        expectedPaperInputs: Object.fromEntries(inputs.map(input => [input.id, {
            requestedArxivId: input.requestedArxivId,
            paperMetadataSha256: input.paperMetadataSha256,
            paperInputSha256: input.paperInputSha256
        }])),
        inputs,
        byId
    };
}

function sourceIdentitySha256(entry) {
    return stableSha256({
        source: entry.source,
        sourceId: entry.sourceId,
        sourceSha256: entry.sourceSha256
    });
}

function isReusableFullTextCheckpoint(entry, filePath, expected = {}) {
    if (entry?.status !== 'complete' || !fs.existsSync(filePath)) return false;
    if (expected.filteredBatchSha256 && entry.filteredBatchSha256 !== expected.filteredBatchSha256) return false;
    if (expected.paperMetadataSha256 && entry.paperMetadataSha256 !== expected.paperMetadataSha256) return false;
    if (expected.paperInputSha256 && entry.paperInputSha256 !== expected.paperInputSha256) return false;
    if (expected.requestedArxivId && entry.requestedArxivId !== expected.requestedArxivId) return false;
    if (entry.path !== filePath || !['html', 'pdf'].includes(entry.source) || !entry.sourceId) return false;
    if (normalizedId(entry.sourceId) !== normalizedId(entry.requestedArxivId)) return false;
    if (/v\d+$/i.test(entry.requestedArxivId) && entry.sourceId.toLowerCase() !== entry.requestedArxivId.toLowerCase()) {
        return false;
    }
    if (entry.sourceIdentitySha256 !== sourceIdentitySha256(entry)) return false;
    let buffer;
    try {
        buffer = readRegular(filePath, 256 * 1024 * 1024).bytes;
    } catch (_error) {
        return false;
    }
    return buffer.length >= 1000
        && entry.bytes === buffer.length
        && entry.sourceSha256 === sha256(buffer);
}


module.exports = { MANIFEST_VERSION, stableSha256, getRequestedArxivId, buildFilteredBatchFingerprint, buildPaperInputIdentity, buildManifestContext, sourceIdentitySha256, isReusableFullTextCheckpoint };
