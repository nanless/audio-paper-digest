'use strict';

const crypto = require('node:crypto');
const { detectHttpConnectProxyUrl } = require('../utils.js');
const { createHostTaskScheduler, getAdaptiveHostCooldownMs } = require('./fetch-scheduler.js');

const CONTRACT = 'official-arxiv-atom-metadata-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_ATTEMPTS = 3;
const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
    'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT'
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const SHARED_METADATA_SCHEDULER = createHostTaskScheduler({
    cooldownAfter: outcome => getAdaptiveHostCooldownMs(outcome, {
        healthyDelayMs: 3000, transientDelayMs: 15000, rateLimitedDelayMs: 60000,
        jitterMaxMs: 2000
    })
});

function fail(message) {
    const error = new Error(`官方 arXiv 元数据被拒绝： ${message}`);
    error.code = 'ARXIV_METADATA_INTEGRITY'; error.retryable = false; throw error;
}

function isTransientAtomFetchError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || error || '');
    return error?.retryable === true || TRANSIENT_NETWORK_CODES.has(code)
        || /(?:socket hang up|socket|network|timed?\s*out|timeout|dns|econnreset|econnrefused|eai_again|enotfound)/i.test(message);
}

function exhaustedTransientError(error, attempts) {
    const wrapped = new Error(`官方 arXiv 元数据请求遇到临时传输故障，尝试 ${attempts} 次后仍失败`,
        { cause: error });
    wrapped.code = 'ARXIV_METADATA_NETWORK_TRANSIENT';
    wrapped.retryable = true;
    wrapped.attempts = attempts;
    return wrapped;
}

function transientHttpError(status, attempts) {
    const error = new Error(`官方 arXiv 元数据请求尝试 ${attempts} 次后仍返回临时错误 HTTP ${status}`);
    error.code = 'ARXIV_METADATA_HTTP_TRANSIENT';
    error.retryable = true;
    error.httpStatus = status;
    error.attempts = attempts;
    return error;
}

function rawAtomEntryIdentity(arxivId, responseData) {
    const entries = [...responseData.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    if (entries.length !== 1) fail('Atom 响应必须只包含一个原始 entry 条目');
    const entry = entries[0][1];
    const idFields = [...entry.matchAll(/<id>([\s\S]*?)<\/id>/gi)];
    const updatedFields = [...entry.matchAll(/<updated>([\s\S]*?)<\/updated>/gi)];
    const publishedFields = [...entry.matchAll(/<published>([\s\S]*?)<\/published>/gi)];
    const id = idFields[0]?.[1].match(/^\s*(?:https?:\/\/)?arxiv\.org\/abs\/(\d{4}\.\d{4,5})v([1-9]\d*)\s*$/i);
    if (idFields.length !== 1 || updatedFields.length !== 1 || publishedFields.length !== 1
        || !id || id[1] !== arxivId) {
        fail('原始 Atom 条目的论文 ID、版本或时间字段缺失、重复，或论文 ID 格式无效、属于另一篇论文');
    }
    const entryVersion = Number(id[2]);
    const entryUpdatedAt = new Date(updatedFields[0][1].trim());
    const publishedAt = new Date(publishedFields[0][1].trim());
    if (!Number.isSafeInteger(entryVersion) || entryVersion < 1
        || !Number.isFinite(entryUpdatedAt.getTime()) || !Number.isFinite(publishedAt.getTime())) {
        fail('原始 Atom 条目的版本不是有效的正整数，或时间字段无效');
    }
    return { entryVersion, entryUpdatedAt: entryUpdatedAt.toISOString(), publishedAt: publishedAt.toISOString() };
}

function querySourceId(arxivId, value = arxivId) {
    const query = String(value || '').trim();
    const match = query.match(/^(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/i);
    if (!match || match[1] !== arxivId) {
        fail('Atom 查询的来源 ID 必须与请求的不带版本号的论文 ID 对应');
    }
    return query;
}

function parseOfficialArxivMetadataResponse(arxivId, responseData, dependencies = {}) {
    if (!/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('必须提供不带版本号的 arXiv ID（点号后为四位或五位数字）');
    if (typeof responseData !== 'string') fail('Atom 响应正文必须是字符串');
    const queryId = querySourceId(arxivId, dependencies.querySourceId);
    const sourceName = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}&max_results=1`;
    const fetchPapers = dependencies.fetchPapers || require('../fetch-papers.js');
    if (!(dependencies.hasSignature || fetchPapers.hasApiResponseSignature)(responseData)) {
        fail('Atom 响应缺少用于识别 API 响应的格式标记');
    }
    const parsed = (dependencies.parseXml || fetchPapers.parseArxivXML)(responseData, 'official-id-list', null,
        { stopAtConsecutiveExisting: false, metadataProjection: CONTRACT });
    if (parsed?._meta?.entryCount !== 1 || parsed._meta.legalEntryCount !== 1 || parsed.length !== 1) {
        fail('Atom 响应必须解析出且仅包含一个有效条目');
    }
    const item = parsed[0];
    if (String(item.arxivId || '').replace(/v\d+$/i, '') !== arxivId
        || !String(item.title || '').trim() || !String(item.abstract || '').trim()
        || !Array.isArray(item.authors) || !Array.isArray(item.categories)) {
        fail('Atom 元数据缺少标题、摘要、作者或分类字段，或属于另一篇论文');
    }
    const metadata = { arxivId, paper_id: arxivId, title: item.title.trim(), authors: item.authors.slice(),
        abstract: item.abstract.trim(), categories: item.categories.slice(), source: 'arxiv-api', sources: ['arxiv'],
        fetchedAt: String(item.published || '') };
    if (!metadata.fetchedAt || Number.isNaN(Date.parse(metadata.fetchedAt))) {
        fail('Atom 元数据缺少有效的发表时间');
    }
    const rawBytes = Buffer.from(responseData, 'utf8');
    const entryIdentity = rawAtomEntryIdentity(arxivId, responseData);
    if (new Date(metadata.fetchedAt).toISOString() !== entryIdentity.publishedAt) {
        fail('解析出的发表时间与原始 Atom 条目中的发表时间不同');
    }
    const requestedVersion = queryId.match(/v([1-9]\d*)$/i);
    if (requestedVersion && Number(requestedVersion[1]) !== entryIdentity.entryVersion) {
        fail('原始 Atom 条目的版本与请求指定的版本不同');
    }
    return { metadata, rawBytes, proof: { contract: CONTRACT, paperId: `arxiv:${arxivId}`, sourceName,
        querySourceId: queryId, fileSha256: sha256(rawBytes), recordSha256: require('./fresh-rewrite-run.js').stableHash(metadata),
        ...entryIdentity } };
}

async function fetchOfficialArxivMetadata(arxivId, dependencies = {}) {
    if (!/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('必须提供不带版本号的 arXiv ID（点号后为四位或五位数字）');
    const proxyUrl = (dependencies.detectProxy || detectHttpConnectProxyUrl)();
    if (!proxyUrl) fail('必须通过 HTTPS_PROXY 或 HTTP_PROXY 配置 HTTP CONNECT 代理');
    const queryId = querySourceId(arxivId, dependencies.querySourceId);
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}&max_results=1`;
    const fetchPapers = dependencies.fetchPapers || require('../fetch-papers.js');
    const requestFn = dependencies.requestFn || fetchPapers.httpsRequestWithProxy;
    // 注入测试请求函数时直接执行该函数。正式历史抓取共用一个主机请求队列，
    // 按主机安排请求间隔，避免逐篇循环连续请求 arXiv Atom 接口。
    const scheduler = dependencies.requestScheduler || (dependencies.requestFn
        ? { run: (_host, task) => task() } : SHARED_METADATA_SCHEDULER);
    let response;
    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
        try {
            response = await scheduler.run('export.arxiv.org', () => requestFn(url, {
                'User-Agent': dependencies.userAgent || 'audio-paper-digest historical metadata/1.0',
                Accept: 'application/atom+xml,application/xml,text/xml;q=0.9'
            }, proxyUrl, dependencies.timeoutMs || 60000, MAX_BYTES));
        } catch (error) {
            if (!isTransientAtomFetchError(error)) throw error;
            if (attempt === MAX_FETCH_ATTEMPTS) throw exhaustedTransientError(error, attempt);
            continue;
        }
        const status = Number(response?.status);
        const transientStatus = [408, 425, 429].includes(status) || status >= 500;
        if (!transientStatus) break;
        if (attempt === MAX_FETCH_ATTEMPTS) throw transientHttpError(status, attempt);
    }
    if (response?.status !== 200 || typeof response.data !== 'string') {
        fail(`Atom API 返回 HTTP ${response?.status ?? '未知'}，或响应正文不是字符串`);
    }
    const observedValue = (dependencies.now || (() => new Date().toISOString()))();
    const observed = new Date(observedValue);
    if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== observedValue) {
        fail('Atom 响应的获取时间必须是有效的标准 ISO 时间字符串');
    }
    const parsed = parseOfficialArxivMetadataResponse(arxivId, response.data, dependencies);
    return { ...parsed, proof: { ...parsed.proof, observedAt: observedValue } };
}

module.exports = { CONTRACT, MAX_BYTES, MAX_FETCH_ATTEMPTS, isTransientAtomFetchError, rawAtomEntryIdentity,
    parseOfficialArxivMetadataResponse, fetchOfficialArxivMetadata };
