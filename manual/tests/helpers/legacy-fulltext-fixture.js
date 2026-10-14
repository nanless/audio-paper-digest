'use strict';

// 只供测试构造旧记录字节。不是生产抓取、运行或补建来源入口。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { sourceIdentitySha256 } = require('../../../scripts/lib/legacy-manual-source.js');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizedId = value => String(value || '').replace(/v\d+$/, '').trim().toLowerCase();
const getBeijingISOString = () => new Date().toISOString();
function buildCompleteEntry(input, result, sourceBuffer) {
    const sourceId = String(result.sourceId || '').trim().toLowerCase();
    if (!['html', 'pdf'].includes(result.source) || !sourceId
        || normalizedId(sourceId) !== input.id
        || (/v\d+$/i.test(input.requestedArxivId) && sourceId !== input.requestedArxivId.toLowerCase())) {
        throw new Error(`${input.id} 全文来源身份与指定版本不一致: requested=${input.requestedArxivId} source=${result.source || '-'}:${sourceId || '-'}`);
    }
    const entry = {
        status: 'complete',
        path: input.filePath,
        requestedArxivId: input.requestedArxivId,
        paperMetadataSha256: input.paperMetadataSha256,
        paperInputSha256: input.paperInputSha256,
        filteredBatchSha256: input.filteredBatchSha256,
        source: result.source,
        sourceId,
        chars: result.text.length,
        bytes: sourceBuffer.length,
        sourceSha256: sha256(sourceBuffer),
        warnings: result.warnings || [],
        imageInfos: Array.isArray(result.imageInfos) ? result.imageInfos.map(info => ({
            url: info.url,
            caption: info.caption || '',
            alt: info.alt || '',
            source: info.source || 'arxiv_html'
        })) : [],
        fetchedAt: getBeijingISOString()
    };
    entry.sourceIdentitySha256 = sourceIdentitySha256(entry);
    return entry;
}

function writeLegacyFulltextManifestFixture(manifestPath, context) {
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, mode: 'manual_full_text_fetch',
        date: context.date, filteredBatchSha256: context.filteredBatchSha256,
        filteredPapersSha256: context.filteredBatchSha256, expectedPaperInputs: context.expectedPaperInputs,
        status: 'running', papers: {} }), { mode: 0o600 });
}

module.exports = { buildCompleteEntry, writeLegacyFulltextManifestFixture };
