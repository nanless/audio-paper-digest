'use strict';

const crypto = require('node:crypto');
const { detectHttpConnectProxyUrl } = require('../utils.js');
const { createHostTaskScheduler, getAdaptiveHostCooldownMs } = require('./fetch-scheduler.js');

const CONTRACT = 'official-arxiv-atom-metadata-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const SHARED_METADATA_SCHEDULER = createHostTaskScheduler({
    cooldownAfter: outcome => getAdaptiveHostCooldownMs(outcome, {
        healthyDelayMs: 3000, transientDelayMs: 15000, rateLimitedDelayMs: 60000,
        jitterMaxMs: 2000
    })
});

function fail(message) {
    const error = new Error(`Official arXiv metadata rejected: ${message}`);
    error.code = 'ARXIV_METADATA_INTEGRITY'; error.retryable = false; throw error;
}

function rawAtomEntryIdentity(arxivId, responseData) {
    const entries = [...responseData.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    if (entries.length !== 1) fail('Atom response must contain exactly one raw entry');
    const entry = entries[0][1];
    const idFields = [...entry.matchAll(/<id>([\s\S]*?)<\/id>/gi)];
    const updatedFields = [...entry.matchAll(/<updated>([\s\S]*?)<\/updated>/gi)];
    const publishedFields = [...entry.matchAll(/<published>([\s\S]*?)<\/published>/gi)];
    const id = idFields[0]?.[1].match(/^\s*(?:https?:\/\/)?arxiv\.org\/abs\/(\d{4}\.\d{4,5})v([1-9]\d*)\s*$/i);
    if (idFields.length !== 1 || updatedFields.length !== 1 || publishedFields.length !== 1
        || !id || id[1] !== arxivId) {
        fail('raw Atom entry identity/version/timestamps are incomplete or belong to another paper');
    }
    const entryVersion = Number(id[2]);
    const entryUpdatedAt = new Date(updatedFields[0][1].trim());
    const publishedAt = new Date(publishedFields[0][1].trim());
    if (!Number.isSafeInteger(entryVersion) || entryVersion < 1
        || !Number.isFinite(entryUpdatedAt.getTime()) || !Number.isFinite(publishedAt.getTime())) {
        fail('raw Atom entry version/timestamps are invalid');
    }
    return { entryVersion, entryUpdatedAt: entryUpdatedAt.toISOString(), publishedAt: publishedAt.toISOString() };
}

function querySourceId(arxivId, value = arxivId) {
    const query = String(value || '').trim();
    const match = query.match(/^(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/i);
    if (!match || match[1] !== arxivId) {
        fail('Atom query source ID must match the requested versionless paper ID');
    }
    return query;
}

function parseOfficialArxivMetadataResponse(arxivId, responseData, dependencies = {}) {
    if (!/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('versionless arXiv ID is required');
    if (typeof responseData !== 'string') fail('Atom response body must be text');
    const queryId = querySourceId(arxivId, dependencies.querySourceId);
    const sourceName = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}&max_results=1`;
    const fetchPapers = dependencies.fetchPapers || require('../fetch-papers.js');
    if (!(dependencies.hasSignature || fetchPapers.hasApiResponseSignature)(responseData)) {
        fail('Atom response signature is missing');
    }
    const parsed = (dependencies.parseXml || fetchPapers.parseArxivXML)(responseData, 'official-id-list', null,
        { stopAtConsecutiveExisting: false });
    if (parsed?._meta?.entryCount !== 1 || parsed._meta.legalEntryCount !== 1 || parsed.length !== 1) {
        fail('Atom response must contain exactly one legal entry');
    }
    const item = parsed[0];
    if (String(item.arxivId || '').replace(/v\d+$/i, '') !== arxivId
        || !String(item.title || '').trim() || !String(item.abstract || '').trim()
        || !Array.isArray(item.authors) || !Array.isArray(item.categories)) {
        fail('Atom metadata is incomplete or belongs to another paper');
    }
    const metadata = { arxivId, paper_id: arxivId, title: item.title.trim(), authors: item.authors.slice(),
        abstract: item.abstract.trim(), categories: item.categories.slice(), source: 'arxiv-api', sources: ['arxiv'],
        fetchedAt: String(item.published || '') };
    if (!metadata.fetchedAt || Number.isNaN(Date.parse(metadata.fetchedAt))) {
        fail('Atom metadata lacks a stable publication timestamp');
    }
    const rawBytes = Buffer.from(responseData, 'utf8');
    const entryIdentity = rawAtomEntryIdentity(arxivId, responseData);
    if (new Date(metadata.fetchedAt).toISOString() !== entryIdentity.publishedAt) {
        fail('parsed publication timestamp differs from the raw Atom entry');
    }
    const requestedVersion = queryId.match(/v([1-9]\d*)$/i);
    if (requestedVersion && Number(requestedVersion[1]) !== entryIdentity.entryVersion) {
        fail('raw Atom entry version differs from the exact requested version');
    }
    return { metadata, rawBytes, proof: { contract: CONTRACT, paperId: `arxiv:${arxivId}`, sourceName,
        querySourceId: queryId, fileSha256: sha256(rawBytes), recordSha256: require('./fresh-rewrite-run.js').stableHash(metadata),
        ...entryIdentity } };
}

async function fetchOfficialArxivMetadata(arxivId, dependencies = {}) {
    if (!/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('versionless arXiv ID is required');
    const proxyUrl = (dependencies.detectProxy || detectHttpConnectProxyUrl)();
    if (!proxyUrl) fail('HTTPS_PROXY/HTTP_PROXY HTTP CONNECT proxy is required');
    const queryId = querySourceId(arxivId, dependencies.querySourceId);
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}&max_results=1`;
    const fetchPapers = dependencies.fetchPapers || require('../fetch-papers.js');
    const requestFn = dependencies.requestFn || fetchPapers.httpsRequestWithProxy;
    // Injected test transports remain immediate. Production shares one host
    // scheduler across every historical run so the arXiv Atom API is not hit
    // in a tight per-paper loop.
    const scheduler = dependencies.requestScheduler || (dependencies.requestFn
        ? { run: (_host, task) => task() } : SHARED_METADATA_SCHEDULER);
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
        response = await scheduler.run('export.arxiv.org', () => requestFn(url, {
            'User-Agent': dependencies.userAgent || 'audio-paper-digest historical metadata/1.0',
            Accept: 'application/atom+xml,application/xml,text/xml;q=0.9'
        }, proxyUrl, dependencies.timeoutMs || 60000, MAX_BYTES));
        if (response?.status !== 429 || attempt === 3) break;
    }
    if (response?.status !== 200 || typeof response.data !== 'string') {
        fail(`Atom API returned HTTP ${response?.status ?? 'unknown'}`);
    }
    const observedValue = (dependencies.now || (() => new Date().toISOString()))();
    const observed = new Date(observedValue);
    if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== observedValue) {
        fail('Atom response observation time is invalid');
    }
    const parsed = parseOfficialArxivMetadataResponse(arxivId, response.data, dependencies);
    return { ...parsed, proof: { ...parsed.proof, observedAt: observedValue } };
}

module.exports = { CONTRACT, MAX_BYTES, rawAtomEntryIdentity,
    parseOfficialArxivMetadataResponse, fetchOfficialArxivMetadata };
