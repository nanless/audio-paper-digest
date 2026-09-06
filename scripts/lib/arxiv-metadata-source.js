'use strict';

const crypto = require('node:crypto');
const { detectHttpConnectProxyUrl } = require('../utils.js');

const CONTRACT = 'official-arxiv-atom-metadata-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fail(message) {
    const error = new Error(`Official arXiv metadata rejected: ${message}`);
    error.code = 'ARXIV_METADATA_INTEGRITY'; error.retryable = false; throw error;
}

async function fetchOfficialArxivMetadata(arxivId, dependencies = {}) {
    if (!/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('versionless arXiv ID is required');
    const proxyUrl = (dependencies.detectProxy || detectHttpConnectProxyUrl)();
    if (!proxyUrl) fail('HTTPS_PROXY/HTTP_PROXY HTTP CONNECT proxy is required');
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
    const fetchPapers = dependencies.fetchPapers || require('../fetch-papers.js');
    const response = await (dependencies.requestFn || fetchPapers.httpsRequestWithProxy)(url, {
        'User-Agent': dependencies.userAgent || 'audio-paper-digest historical metadata/1.0',
        Accept: 'application/atom+xml,application/xml,text/xml;q=0.9'
    }, proxyUrl, dependencies.timeoutMs || 60000, MAX_BYTES);
    if (response?.status !== 200 || typeof response.data !== 'string') fail(`Atom API returned HTTP ${response?.status ?? 'unknown'}`);
    if (!(dependencies.hasSignature || fetchPapers.hasApiResponseSignature)(response.data)) fail('Atom response signature is missing');
    const parsed = (dependencies.parseXml || fetchPapers.parseArxivXML)(response.data, 'official-id-list', null,
        { stopAtConsecutiveExisting: false });
    if (parsed?._meta?.entryCount !== 1 || parsed._meta.legalEntryCount !== 1 || parsed.length !== 1) fail('Atom response must contain exactly one legal entry');
    const item = parsed[0];
    if (String(item.arxivId || '').replace(/v\d+$/i, '') !== arxivId
        || !String(item.title || '').trim() || !String(item.abstract || '').trim()
        || !Array.isArray(item.authors) || !Array.isArray(item.categories)) fail('Atom metadata is incomplete or belongs to another paper');
    const metadata = { arxivId, paper_id: arxivId, title: item.title.trim(), authors: item.authors.slice(),
        abstract: item.abstract.trim(), categories: item.categories.slice(), source: 'arxiv-api', sources: ['arxiv'],
        fetchedAt: String(item.published || '') };
    if (!metadata.fetchedAt || Number.isNaN(Date.parse(metadata.fetchedAt))) fail('Atom metadata lacks a stable publication timestamp');
    const rawBytes = Buffer.from(response.data, 'utf8');
    return { metadata, rawBytes, proof: { contract: CONTRACT, paperId: `arxiv:${arxivId}`, sourceName: url,
        fileSha256: sha256(rawBytes), recordSha256: require('./fresh-rewrite-run.js').stableHash(metadata) } };
}

module.exports = { CONTRACT, MAX_BYTES, fetchOfficialArxivMetadata };
