'use strict';

/**
 * 官方会议录获取扩展模块。
 *
 * 设计约束：
 * - scripts/lib/official-conference-acquisition.js 受 config/workflow-historical-records.json
 *   与 tests/acquisition-parser-compatibility.test.js 的 SHA-256 逐字节锁死，绝不修改该原文件。
 * - 本伴生模块与冻结获取模块保持同等安全、流式限流、目录边界、去重键 JSON 校验与不可变凭证契约，
 *   新增对下列音频/语音/多模态核心会议的支持：
 *   - EMNLP 2026（ACL Anthology HTML：Main / Short / Findings）
 *   - ISMIR 2026（Zenodo REST API v1 分页 JSON + PDF）
 *   - DCASE 2026（Zenodo REST API v1 分页 JSON + PDF）
 *   - NeurIPS 2026（proceedings.neurips.cc 官方无查询串 HTML + PDF，完整兼容 paper-identity / postprocess）
 *   - WASPAA 2025 / ASRU 2025（IEEE 官方本地 proceedings.json 离线清单 + 本地 PDF 逐篇 SHA 封存）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cheerio = require('cheerio');
const { writeImmutableFile, recoverImmutableFileLink } = require('./immutable-file.js');

const EXTENDED_CATALOG_RECEIPT_CONTRACT = 'official-conference-catalog-receipt-extended';
const EXTENDED_PDF_RECEIPT_CONTRACT = 'official-conference-pdf-receipt-extended';
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 180000;
const MAX_JSON_PAGES = 40;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]{2,160}$/;
const PAPER_FIELDS = Object.freeze(['abstract', 'authors', 'doi', 'id', 'pdfFile', 'pdfUrl', 'recordUrl', 'title', 'track']);
const TEMP_FILE_RE = /^\..+\.[a-f0-9]{16}\.[1-9]\d*\.[a-f0-9-]{36}\.tmp$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class OfficialConferenceAcquisitionExtendedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OfficialConferenceAcquisitionExtendedError';
        this.code = 'OFFICIAL_CONFERENCE_ACQUISITION_EXTENDED_ERROR';
    }
}

function fail(message) {
    throw new OfficialConferenceAcquisitionExtendedError(message);
}

function compareCodePoints(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort(compareCodePoints).map(k => [k, canonicalize(value[k])])
        );
    }
    return value;
}

function stableHash(value) {
    return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

function prettyBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function exact(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} 必须是 JSON 对象`);
    }
    const actual = Object.keys(value).sort(compareCodePoints);
    const expected = [...expectedKeys].sort(compareCodePoints);
    if (actual.length !== expected.length || actual.some((k, idx) => k !== expected[idx])) {
        fail(`${label} 字段集合不符合契约`);
    }
    return value;
}

function cleanText(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripHtmlTags(value) {
    const raw = String(value || '');
    if (!raw.trim()) return '';
    // 仅当包含 HTML 标签样式或实体时交由 cheerio 解析，避免把数学不等式 "a < b and c > d" 当成标签吞掉。
    if (/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(raw)) {
        const $ = cheerio.load(`<div>${raw}</div>`);
        return cleanText($('div').first().text());
    }
    return cleanText(raw);
}

function isPublicDnsHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.includes(':') || net.isIP(host) !== 0
        || !host.includes('.') || host.length > 253) {
        return false;
    }
    return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function assertCanonicalPublicHttpsUrl(value, label, { allowQuery = false } = {}) {
    const text = cleanText(value);
    if (!text) fail(`${label} 不能为空`);
    let parsed;
    try {
        parsed = new URL(text);
    } catch (_) {
        fail(`${label} 不是有效的 URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.hash || !isPublicDnsHostname(parsed.hostname)) {
        fail(`${label} 必须是不含凭证、端口和片段的公开 HTTPS URL`);
    }
    if (!allowQuery && parsed.search) {
        fail(`${label} 不得包含查询参数`);
    }
    const rawPathAndQuery = text.slice(`https://${parsed.host}`.length);
    const expectedPathAndQuery = `${parsed.pathname}${parsed.search}`;
    if (parsed.pathname === '/' || rawPathAndQuery !== expectedPathAndQuery
        || parsed.pathname.includes('//') || parsed.pathname.includes('/..') || parsed.pathname.includes('/./')) {
        fail(`${label} 必须使用规范且无目录穿越的路径`);
    }
    if (parsed.toString() !== text) fail(`${label} 必须使用规范 URL 拼写`);
    return text;
}

function normalizeDoi(rawDoi) {
    if (rawDoi === null || rawDoi === undefined) return null;
    let s = cleanText(rawDoi);
    if (!s) return null;
    s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    if (!DOI_RE.test(s)) fail(`DOI 格式无效：${s}`);
    return s;
}

function normalizePaperRecord(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        fail(`第 ${index + 1} 条论文记录必须是对象`);
    }
    const id = cleanText(raw.id);
    if (!ID_RE.test(id)) fail(`论文 ID 非法：${id}`);
    const title = cleanText(raw.title);
    if (!title) fail(`论文 ${id} 缺少标题`);
    const rawAuthors = (Array.isArray(raw.authors) ? raw.authors : []).map(cleanText).filter(Boolean);
    const authors = [...new Set(rawAuthors)];
    if (authors.length < 1 || authors.length > 1000) {
        fail(`论文 ${id} 必须包含 1 至 1000 位去重后的有效作者`);
    }
    const abstract = cleanText(raw.abstract || '');
    const doi = normalizeDoi(raw.doi);
    const track = cleanText(raw.track || 'main');
    if (!track) fail(`论文 ${id} 缺少 track`);
    // conference-discovery & paper-identity 均要求 recordUrl 非空且不含查询串
    const recordUrl = assertCanonicalPublicHttpsUrl(raw.recordUrl, `论文 ${id} 的 recordUrl`, { allowQuery: false });
    const pdfUrl = raw.pdfUrl ? assertCanonicalPublicHttpsUrl(raw.pdfUrl, `论文 ${id} 的 pdfUrl`, { allowQuery: true }) : null;
    if (pdfUrl && pdfUrl === recordUrl) fail(`论文 ${id} 的 recordUrl 与 pdfUrl 不得相同`);
    const pdfFile = (pdfUrl || raw.pdfFile) ? cleanText(raw.pdfFile || `pdfs/${id}.pdf`) : null;
    if (pdfFile && (!/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(pdfFile) || pdfFile.includes('..'))) {
        fail(`论文 ${id} 的 pdfFile 路径非法：${pdfFile}`);
    }
    const record = { abstract, authors, doi, id, pdfFile, pdfUrl, recordUrl, title, track };
    exact(record, PAPER_FIELDS, `论文 ${id}`);
    return record;
}

const EXTENDED_PROVIDERS = Object.freeze({
    'emnlp-2026': Object.freeze({
        conference: Object.freeze({ id: 'emnlp-2026', year: 2026 }),
        parser: 'acl-anthology-html',
        indexUrl: 'https://aclanthology.org/events/emnlp-2026/',
        allowedHosts: Object.freeze(['aclanthology.org']),
        recordPath: /^\/2026\.(?:emnlp-(?:main|short)|findings-emnlp)\.\d+\/?$/,
        pdfPath: /^\/2026\.(?:emnlp-(?:main|short)|findings-emnlp)\.\d+\.pdf$/,
        volumePrefixes: Object.freeze([
            { prefix: '2026.emnlp-main.', track: 'EMNLP 2026 Main' },
            { prefix: '2026.emnlp-short.', track: 'EMNLP 2026 Short' },
            { prefix: '2026.findings-emnlp.', track: 'Findings of EMNLP 2026' }
        ])
    }),
    'ismir-2026': Object.freeze({
        conference: Object.freeze({ id: 'ismir-2026', year: 2026 }),
        parser: 'zenodo-json',
        community: 'ismir',
        indexUrl: 'https://zenodo.org/api/records?communities=ismir&size=100&sort=mostrecent',
        allowedHosts: Object.freeze(['zenodo.org']),
        apiPath: /^\/api\/records$/,
        pdfPath: /^\/(?:(?:api\/)?records\/\d+\/files\/[^/?#]+\.pdf(?:\/content)?|api\/files\/[A-Za-z0-9-]+\/[^/?#]+\.pdf)$/i
    }),
    'dcase-2026': Object.freeze({
        conference: Object.freeze({ id: 'dcase-2026', year: 2026 }),
        parser: 'zenodo-json',
        community: 'dcase',
        indexUrl: 'https://zenodo.org/api/records?communities=dcase&size=100&sort=mostrecent',
        allowedHosts: Object.freeze(['zenodo.org']),
        apiPath: /^\/api\/records$/,
        pdfPath: /^\/(?:(?:api\/)?records\/\d+\/files\/[^/?#]+\.pdf(?:\/content)?|api\/files\/[A-Za-z0-9-]+\/[^/?#]+\.pdf)$/i
    }),
    'neurips-2026': Object.freeze({
        conference: Object.freeze({ id: 'neurips-2026', year: 2026 }),
        parser: 'neurips-proceedings-html',
        indexUrl: 'https://proceedings.neurips.cc/paper_files/paper/2026',
        allowedHosts: Object.freeze(['proceedings.neurips.cc']),
        recordPath: /^\/paper_files\/paper\/2026\/hash\/[A-Za-z0-9]+-Abstract-[A-Za-z0-9_]+\.html$/,
        pdfPath: /^\/paper_files\/paper\/2026\/file\/[A-Za-z0-9]+-Paper-[A-Za-z0-9_]+\.pdf$/
    }),
    'waspaa-2025': Object.freeze({
        conference: Object.freeze({ id: 'waspaa-2025', year: 2025 }),
        parser: 'ieee-local-manifest',
        indexUrl: 'https://ieeexplore.ieee.org/xpl/conhome/1000837/all-proceedings',
        allowedHosts: Object.freeze(['ieeexplore.ieee.org']),
        recordPath: /^\/document\/[1-9]\d*\/?$/,
        pdfPath: /^\/stamp\/stamp\.jsp$/,
        defaultTrack: 'WASPAA 2025'
    }),
    'asru-2025': Object.freeze({
        conference: Object.freeze({ id: 'asru-2025', year: 2025 }),
        parser: 'ieee-local-manifest',
        indexUrl: 'https://ieeexplore.ieee.org/xpl/conhome/1000043/all-proceedings',
        allowedHosts: Object.freeze(['ieeexplore.ieee.org']),
        recordPath: /^\/document\/[1-9]\d*\/?$/,
        pdfPath: /^\/stamp\/stamp\.jsp$/,
        defaultTrack: 'ASRU 2025'
    })
});

function hasProvider(providerId) {
    return Object.prototype.hasOwnProperty.call(EXTENDED_PROVIDERS, providerId);
}

function providerFor(providerId) {
    if (!hasProvider(providerId)) {
        fail(`不受支持的扩展官方会议提供方：${providerId}`);
    }
    return EXTENDED_PROVIDERS[providerId];
}

function listProviderIds() {
    return Object.keys(EXTENDED_PROVIDERS);
}

function implementationSha256() {
    return readStableFile(__filename, 'official-conference-acquisition-extended.js', MAX_INDEX_BYTES, { requireMode0600: false }).sha256;
}

function validateUrlForProvider(provider, rawUrl, kind) {
    const cleaned = assertCanonicalPublicHttpsUrl(rawUrl, `official ${kind} URL`, {
        allowQuery: kind === 'api' || (kind === 'pdf' && provider.parser === 'ieee-local-manifest')
    });
    const parsed = new URL(cleaned);
    const host = parsed.hostname.toLowerCase();
    if (!provider.allowedHosts.includes(host)) {
        fail(`官方请求主机不在白名单中：${host}（允许：${provider.allowedHosts.join(', ')}）`);
    }
    if (kind === 'index') {
        const allowTrailingSlash = !provider.indexUrl.endsWith('/') && !provider.indexUrl.includes('?')
            ? `${provider.indexUrl}/`
            : null;
        if (cleaned !== provider.indexUrl && cleaned !== allowTrailingSlash) {
            fail(`官方 index URL 必须严格等于固定入口：${provider.indexUrl}`);
        }
    } else if (kind === 'record') {
        if (provider.recordPath && !provider.recordPath.test(parsed.pathname)) {
            fail(`官方 record 路径不符合白名单：${parsed.pathname}`);
        }
    } else if (kind === 'api') {
        if (!provider.apiPath || !provider.apiPath.test(parsed.pathname)) {
            fail(`官方 API 路径不符合契约：${parsed.pathname}`);
        }
        if (provider.parser === 'zenodo-json') {
            if (parsed.searchParams.get('communities') !== provider.community) {
                fail(`Zenodo 分页 URL 必须保留固定社区参数 communities=${provider.community}`);
            }
        }
    } else if (kind === 'pdf') {
        if (provider.pdfPath && !provider.pdfPath.test(parsed.pathname)) {
            fail(`官方 PDF 路径不符合白名单：${parsed.pathname}`);
        }
        if (provider.parser === 'ieee-local-manifest') {
            const arnumber = parsed.searchParams.get('arnumber') || '';
            if (!/^[1-9]\d*$/.test(arnumber) || parsed.search !== `?arnumber=${arnumber}`) {
                fail(`IEEE 官方 PDF URL 必须包含规范的 ?arnumber=<digits>：${cleaned}`);
            }
        }
    } else {
        fail(`未知的官方请求类型：${kind}`);
    }
    return cleaned;
}

function validateRedirectChain(provider, requestedUrl, finalUrl, redirects, kind, label) {
    let current = validateUrlForProvider(provider, requestedUrl, kind);
    for (const hop of redirects) {
        exact(hop, ['from', 'status', 'to'], `${label}.redirects`);
        if (![301, 302, 303, 307, 308].includes(hop.status)) {
            fail(`${label} 重定向状态码无效`);
        }
        if (hop.from !== current) {
            fail(`${label} 重定向链中断：期望 from=${current}，实际 ${hop.from}`);
        }
        current = validateUrlForProvider(provider, hop.to, kind);
    }
    if (finalUrl !== current) {
        fail(`${label} finalUrl 与重定向链终点不一致：期望 ${current}，实际 ${finalUrl}`);
    }
    return current;
}

async function readResponseBytes(response, maxBytes, label) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        fail(`${label} 超过字节上限 ${maxBytes}`);
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > maxBytes) {
            fail(`${label} 为空或超过字节上限 ${maxBytes}`);
        }
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxBytes) {
                await reader.cancel();
                fail(`${label} 超过字节上限 ${maxBytes}`);
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock?.();
    }
    if (!total) fail(`${label} 为空`);
    return Buffer.concat(chunks, total);
}

async function fetchOfficialExtended({ provider, url, kind, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS }, dependencies = {}) {
    const requestedUrl = validateUrlForProvider(provider, url, kind);
    const fetchImpl = dependencies.fetch || dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('当前运行时缺少 fetch 实现');

    let dispatcher;
    const useProxyDispatcher = (!dependencies.fetch && !dependencies.fetchImpl)
        || Boolean(dependencies.detectProxy || dependencies.createDispatcher);
    if (useProxyDispatcher) {
        const utils = require('../utils.js');
        const proxyUrl = (dependencies.detectProxy || utils.detectHttpConnectProxyUrl)();
        if (!proxyUrl) fail('官方会议获取必须配置项目 .env 中的 HTTP CONNECT 代理（HTTPS_PROXY/HTTP_PROXY）');
        // utils.createProxyDispatcher 返回进程级缓存单例，绝不能在单次请求结束后 close()
        dispatcher = (dependencies.createDispatcher || utils.createProxyDispatcher)(proxyUrl);
    }

    let current = requestedUrl;
    const redirects = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const accept = kind === 'pdf'
                ? 'application/pdf'
                : kind === 'api'
                    ? 'application/json'
                    : 'text/html,application/xhtml+xml';
            const response = await fetchImpl(current, {
                method: 'GET',
                redirect: 'manual',
                ...(dispatcher ? { dispatcher } : {}),
                signal: controller.signal,
                headers: {
                    Accept: accept,
                    'User-Agent': 'audio-research-workbench-official-conference/2.0'
                }
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel?.();
                if (hop >= MAX_REDIRECTS) fail('官方响应超过重定向上限');
                const location = response.headers?.get?.('location');
                if (!location) fail('官方重定向缺少 Location 头');
                let resolved;
                try {
                    resolved = new URL(location, current).toString();
                } catch (_) {
                    fail(`官方重定向目标不是合法 URL：${location}`);
                }
                const nextUrl = validateUrlForProvider(provider, resolved, kind);
                redirects.push({ status: response.status, from: current, to: nextUrl });
                current = nextUrl;
                continue;
            }
            if (response.status !== 200) {
                await response.body?.cancel?.();
                fail(`official ${kind} returned HTTP ${response.status}`);
            }
            const contentType = String(response.headers?.get?.('content-type') || '').trim();
            const okContentType = kind === 'pdf'
                ? /^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(contentType)
                : kind === 'api'
                    ? /^(?:application\/json|application\/vnd\.zenodo\.v1\+json)(?:\s*;|$)/iu.test(contentType)
                    : /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType);
            if (!okContentType) {
                await response.body?.cancel?.();
                fail(`官方 ${kind} 响应 Content-Type 无效：${contentType || '(empty)'}`);
            }
            const buf = await readResponseBytes(response, maxBytes, `官方 ${kind} 响应`);
            if (kind === 'pdf' && buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
                fail('官方 PDF 响应缺少 %PDF- 文件头');
            }
            const observedAt = (dependencies.now || (() => new Date().toISOString()))();
            return {
                bytes: buf,
                requestedUrl,
                finalUrl: current,
                redirects,
                responseStatus: response.status,
                contentType,
                observedAt
            };
        }
        fail('官方响应超过重定向上限');
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
        if (error?.name === 'AbortError') fail(`official ${kind} request timed out`);
        const reason = String(error?.cause?.code || error?.code || error?.message || 'network error')
            .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 160);
        fail(`official ${kind} request failed: ${reason}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 解析 ACL Anthology 会议页面 HTML（EMNLP 2026：Main / Short / Findings）。
 */
function parseEmnlpCatalogHtml(htmlText, provider = EXTENDED_PROVIDERS['emnlp-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    $('p.d-sm-flex').each((_, el) => {
        const $p = $(el);
        const $titleLink = $p.find('strong a.align-middle[href]').first();
        const href = cleanText($titleLink.attr('href'));
        if (!href) return;
        let pathname;
        try {
            pathname = new URL(href, 'https://aclanthology.org').pathname;
        } catch (_) {
            return;
        }
        if (!provider.recordPath.test(pathname)) return;
        const paperId = pathname.replace(/^\/|\/$/g, '');
        if (/\.0$/.test(paperId)) return;
        const matchedVol = provider.volumePrefixes.find(v => paperId.startsWith(v.prefix));
        if (!matchedVol) return;
        const title = cleanText($titleLink.text());
        if (!title) return;
        const authors = [];
        $p.find('span.d-block a[href^="/people/"]').each((__, a) => {
            const name = cleanText($(a).text());
            if (name) authors.push(name);
        });
        const recordUrl = `https://aclanthology.org/${paperId}/`;
        const pdfUrl = `https://aclanthology.org/${paperId}.pdf`;
        const doi = `10.18653/v1/${paperId}`;
        const abstractId = `abstract-${paperId.replace(/\./g, '--')}`;
        const abstract = cleanText($(`#${abstractId} .card-body`).text() || $p.next('div.abstract-collapse').text());
        if (!byId.has(paperId)) {
            byId.set(paperId, normalizePaperRecord({
                id: paperId,
                title,
                authors,
                abstract,
                doi,
                track: matchedVol.track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${paperId}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 Zenodo REST API 分页 JSON（ISMIR / DCASE 官方会议录）。
 */
function parseZenodoRecordsPages(pages, provider) {
    if (!Array.isArray(pages) || pages.length === 0) {
        fail(`${provider.conference.id} 缺少 Zenodo 分页响应`);
    }
    const byId = new Map();
    for (const page of pages) {
        const hits = Array.isArray(page?.hits?.hits) ? page.hits.hits : [];
        for (const hit of hits) {
            const recordId = String(hit?.id ?? '').trim();
            if (!/^\d+$/.test(recordId)) continue;
            const meta = hit?.metadata || {};
            const pubDate = String(meta.publication_date || '');
            if (provider.conference?.year && pubDate && !pubDate.startsWith(String(provider.conference.year))) {
                continue;
            }
            const title = cleanText(meta.title);
            if (!title) continue;
            const authors = (Array.isArray(meta.creators) ? meta.creators : [])
                .map(c => cleanText(c?.name))
                .filter(Boolean);
            const abstract = stripHtmlTags(meta.description || '');
            const rawDoi = cleanText(hit.doi || meta.doi || '');
            const doi = rawDoi && DOI_RE.test(rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')) ? rawDoi : null;
            const files = Array.isArray(hit.files) ? hit.files : [];
            const pdfEntry = files.find(f => /\.pdf$/i.test(String(f?.key || f?.filename || '')));
            const rawPdfUrl = pdfEntry?.links?.self || pdfEntry?.links?.download || '';
            let pdfUrl = null;
            if (rawPdfUrl) {
                try {
                    const parsed = new URL(rawPdfUrl);
                    if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'zenodo.org'
                        && !parsed.search && !parsed.hash && !parsed.port && !parsed.username && !parsed.password
                        && provider.pdfPath.test(parsed.pathname)) {
                        pdfUrl = parsed.toString();
                    }
                } catch (_) {}
            }
            const id = `zenodo-${recordId}`;
            const recordUrl = `https://zenodo.org/records/${recordId}`;
            const track = cleanText(meta.conference?.title || meta.conference?.acronym || `${provider.community.toUpperCase()} ${provider.conference.year}`);
            if (!byId.has(id)) {
                byId.set(id, normalizePaperRecord({
                    id,
                    title,
                    authors,
                    abstract,
                    doi,
                    track,
                    recordUrl,
                    pdfUrl,
                    pdfFile: pdfUrl ? `pdfs/${id}.pdf` : null
                }, byId.size));
            }
        }
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} Zenodo 响应未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 NeurIPS 官方论文集页面 HTML（proceedings.neurips.cc，严格无查询串 canonical URL）。
 */
function parseNeuripsProceedingsHtml(htmlText, provider = EXTENDED_PROVIDERS['neurips-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    const year = provider.conference.year;
    $('li').each((_, el) => {
        const $li = $(el);
        const $link = $li.find(`a[href*="/paper_files/paper/${year}/hash/"]`).first();
        const href = cleanText($link.attr('href'));
        if (!href) return;
        let pathname;
        try {
            pathname = new URL(href, 'https://proceedings.neurips.cc').pathname;
        } catch (_) {
            return;
        }
        const m = /^\/paper_files\/paper\/(\d{4})\/hash\/([A-Za-z0-9]+)-Abstract-([A-Za-z0-9_]+)\.html$/.exec(pathname);
        if (!m || Number(m[1]) !== year) return;
        const hashId = m[2];
        const trackSlug = m[3];
        const title = cleanText($link.text());
        if (!title) return;
        const rawAuthorText = cleanText($li.find('i').first().text());
        const authors = rawAuthorText
            ? rawAuthorText.split(/\s*,\s*/).map(cleanText).filter(Boolean)
            : [];
        const recordUrl = `https://proceedings.neurips.cc${pathname}`;
        const pdfUrl = `https://proceedings.neurips.cc/paper_files/paper/${year}/file/${hashId}-Paper-${trackSlug}.pdf`;
        const track = trackSlug.includes('Datasets')
            ? `NeurIPS ${year} Datasets and Benchmarks`
            : `NeurIPS ${year} Conference`;
        if (!byId.has(hashId)) {
            byId.set(hashId, normalizePaperRecord({
                id: hashId,
                title,
                authors,
                abstract: '',
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${hashId}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} 官方论文集 HTML 未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析并校验 IEEE / 官方本地 proceedings.json 离线清单（WASPAA / ASRU 等防爬虫会议）。
 */
function parseIeeeLocalManifest(manifestJson, provider) {
    const parsed = typeof manifestJson === 'string' ? JSON.parse(manifestJson) : manifestJson;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.papers)) {
        fail(`${provider.conference.id} 本地 proceedings.json 缺少 papers 数组`);
    }
    const byId = new Map();
    const seenPdfFiles = new Set();
    for (let idx = 0; idx < parsed.papers.length; idx += 1) {
        const item = parsed.papers[idx];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            fail(`${provider.conference.id} 清单第 ${idx + 1} 条不是合法对象`);
        }
        const rawArnumber = item.arnumber !== undefined && item.arnumber !== null ? String(item.arnumber).trim() : '';
        if (rawArnumber && !/^[1-9]\d*$/.test(rawArnumber)) {
            fail(`${provider.conference.id} 清单第 ${idx + 1} 条 arnumber 非法：${rawArnumber}`);
        }
        const rawId = cleanText(item.id || rawArnumber);
        const rawRecordUrl = item.recordUrl
            ? cleanText(item.recordUrl)
            : (rawArnumber ? `https://ieeexplore.ieee.org/document/${rawArnumber}` : '');
        if (!rawRecordUrl) {
            fail(`${provider.conference.id} 清单论文 ${rawId || idx + 1} 必须提供 arnumber 或规范的官方 recordUrl`);
        }
        const recordUrl = validateUrlForProvider(provider, rawRecordUrl, 'record');
        const rawPdfUrl = item.pdfUrl
            ? cleanText(item.pdfUrl)
            : (rawArnumber ? `https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=${rawArnumber}` : null);
        if (!rawPdfUrl) {
            fail(`${provider.conference.id} 清单论文 ${rawId || idx + 1} 必须提供 arnumber 或规范的官方 pdfUrl`);
        }
        const pdfUrl = validateUrlForProvider(provider, rawPdfUrl, 'pdf');
        const rawPdfFile = cleanText(item.pdfFile || (rawId ? `pdfs/${rawId}.pdf` : ''));
        const normalizedPdfFile = rawPdfFile
            ? (rawPdfFile.startsWith('pdfs/') ? rawPdfFile : `pdfs/${rawPdfFile}`)
            : null;
        if (!normalizedPdfFile || !/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(normalizedPdfFile) || normalizedPdfFile.includes('..')) {
            fail(`${provider.conference.id} 清单中的 pdfFile 不合法：${rawPdfFile}`);
        }
        if (seenPdfFiles.has(normalizedPdfFile)) {
            fail(`${provider.conference.id} 清单存在重复的 pdfFile 绑定：${normalizedPdfFile}`);
        }
        seenPdfFiles.add(normalizedPdfFile);
        const normalized = normalizePaperRecord({
            id: rawId,
            title: item.title,
            authors: item.authors,
            abstract: item.abstract || '',
            doi: item.doi || null,
            track: item.track || provider.defaultTrack,
            recordUrl,
            pdfUrl,
            pdfFile: normalizedPdfFile
        }, idx);
        if (byId.has(normalized.id)) fail(`${provider.conference.id} 清单存在重复论文 ID：${normalized.id}`);
        byId.set(normalized.id, normalized);
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} 本地 proceedings.json 不能为空`);
    return { conference: { ...provider.conference }, papers };
}

function safeDirectory(directory, label, create) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        fail(`${label} 必须是规范化的绝对路径`);
    }
    if (!fs.existsSync(directory)) {
        if (!create) fail(`${label} 不存在`);
        const parent = path.dirname(directory);
        safeDirectory(parent, `${label} parent`, false);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        fail(`${label} 目录不安全或为符号链接`);
    }
    return directory;
}

function plannedRoot(outputRoot) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)
        || path.resolve(outputRoot) !== outputRoot || outputRoot === path.parse(outputRoot).root) {
        fail('outputRoot 必须是规范化的绝对非根路径');
    }
    let cursor = outputRoot;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('outputRoot 没有可安全使用的已有祖先目录');
        cursor = parent;
    }
    safeDirectory(cursor, 'outputRoot existing ancestor', false);
    return outputRoot;
}

function acquisitionPaths(outputRoot, create = false) {
    const root = plannedRoot(outputRoot);
    if (create && !fs.existsSync(root)) {
        const missing = [];
        let cursor = root;
        while (!fs.existsSync(cursor)) {
            missing.push(cursor);
            cursor = path.dirname(cursor);
        }
        for (const dir of missing.reverse()) {
            fs.mkdirSync(dir, { mode: 0o700 });
            safeDirectory(dir, 'outputRoot', false);
        }
    }
    safeDirectory(root, 'outputRoot', false);
    const paths = {
        root,
        responses: path.join(root, 'responses'),
        pdfs: path.join(root, 'pdfs'),
        receipts: path.join(root, 'receipts'),
        metadataFile: path.join(root, 'metadata.json'),
        catalogReceiptFile: path.join(root, 'catalog.receipt.json')
    };
    for (const [dir, label] of [[paths.responses, 'responses'], [paths.pdfs, 'pdfs'], [paths.receipts, 'receipts']]) {
        if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        if (create || fs.existsSync(dir)) safeDirectory(dir, label, false);
    }
    return paths;
}

function readStableFile(filename, label, maxBytes, { requireMode0600 = true } = {}) {
    const parent = safeDirectory(path.dirname(filename), `${label} parent`, false);
    const absolute = path.resolve(filename);
    if (path.dirname(absolute) !== parent) fail(`${label} 路径超出其父目录`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino
            || opened.size < 1 || opened.size > maxBytes) {
            fail(`${label} 文件不安全或超出字节范围`);
        }
        if (process.platform !== 'win32') {
            const mode = opened.mode & 0o777;
            if (requireMode0600 && mode !== 0o600) fail(`${label} 权限必须为 0600`);
            if (!requireMode0600 && (mode & 0o022) !== 0) fail(`${label} 不得对同组或其他用户可写`);
        }
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) {
            fail(`读取时 ${label} 发生变化`);
        }
        return { bytes, sha256: sha256(bytes), size: bytes.length };
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
        fail(`无法读取 ${label}：${error.code || error.message}`);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function rejectDuplicateJsonKeys(text, label) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail(`${label} 含重复键：${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function readCanonicalJson(filename, label, maxBytes, options = {}) {
    const loaded = readStableFile(filename, label, maxBytes, options);
    let text;
    let value;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text, label);
        value = JSON.parse(text);
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
        fail(`${label} 必须为合法的严格 UTF-8 JSON`);
    }
    return { ...loaded, value };
}

function resolveSafePdfPath(paths, paper) {
    const rel = String(paper?.pdfFile || '');
    if (!/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(rel) || rel.includes('..')) {
        fail(`论文 ${paper?.id || '(unknown)'} 的 pdfFile 路径不合法：${rel}`);
    }
    const full = path.resolve(paths.root, rel);
    if (path.dirname(full) !== paths.pdfs) {
        fail(`论文 ${paper?.id || '(unknown)'} 的 PDF 路径越界：${rel}`);
    }
    return full;
}

function resolveSafeResponsePath(paths, relFile) {
    if (typeof relFile !== 'string' || !/^responses\/(?:index\.html|page-\d{3}\.json|proceedings\.json)$/.test(relFile)) {
        fail(`响应文件相对路径不合法：${relFile}`);
    }
    const full = path.resolve(paths.root, relFile);
    if (path.dirname(full) !== paths.responses) {
        fail(`响应文件路径越界：${relFile}`);
    }
    return full;
}

function rejectInterruptedTemporaryFiles(directories) {
    for (const dir of directories) {
        if (!fs.existsSync(dir)) continue;
        safeDirectory(dir, '抓取目录', false);
        for (const entry of fs.readdirSync(dir)) {
            if (TEMP_FILE_RE.test(entry)) {
                fail(`发现未完成写入的临时文件：${path.join(dir, entry)}`);
            }
        }
    }
}

function writeExclusiveOrCompare(filename, bytes, label, maxBytes) {
    const status = writeImmutableFile(filename, bytes, message => fail(`${label}：${message}`));
    const stored = readStableFile(filename, label, maxBytes, { requireMode0600: true });
    if (!stored.bytes.equals(Buffer.from(bytes))) {
        fail(`拒绝覆盖内容不同的 ${label}`);
    }
    return status;
}

function validateObservedAt(value, label) {
    if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) {
        fail(`${label} 必须是标准 UTC ISO 时间戳`);
    }
    return value;
}

function buildCatalogReceipt(provider, responseEntries, metadataBytes, papers) {
    const core = {
        contract: EXTENDED_CATALOG_RECEIPT_CONTRACT,
        providerId: provider.conference.id,
        conference: { ...provider.conference },
        parser: provider.parser,
        implementationSha256: implementationSha256(),
        responses: responseEntries,
        metadataFile: 'metadata.json',
        metadataSha256: sha256(metadataBytes),
        paperSetSha256: stableHash(papers)
    };
    return { ...core, receiptSha256: stableHash(core) };
}

function buildPdfReceipt(provider, paper, metadataSha256, {
    acquisitionMode,
    pdfBytes,
    requestedUrl,
    finalUrl,
    redirects = [],
    responseStatus = 200,
    observedAt
}) {
    const core = {
        contract: EXTENDED_PDF_RECEIPT_CONTRACT,
        acquisitionMode,
        providerId: provider.conference.id,
        metadataSha256,
        paperId: paper.id,
        pdfFile: paper.pdfFile,
        pdfBytes: pdfBytes.length,
        pdfSha256: sha256(pdfBytes),
        requestedUrl,
        finalUrl,
        redirects,
        responseStatus,
        observedAt
    };
    return { ...core, receiptSha256: stableHash(core) };
}

async function acquireCatalog({ providerId, outputRoot, apply = false } = {}, dependencies = {}) {
    const provider = providerFor(providerId);
    plannedRoot(outputRoot);
    if (!apply) {
        return {
            command: 'catalog',
            mode: 'dry-run',
            providerId: provider.conference.id,
            parser: provider.parser,
            indexUrl: provider.indexUrl,
            outputRoot
        };
    }
    const paths = acquisitionPaths(outputRoot, true);
    recoverImmutableFileLink(paths.metadataFile, fail, MAX_INDEX_BYTES);
    recoverImmutableFileLink(paths.catalogReceiptFile, fail, MAX_RECEIPT_BYTES);
    rejectInterruptedTemporaryFiles([paths.root, paths.responses]);

    const responseEntries = [];
    let metadata;

    if (provider.parser === 'acl-anthology-html' || provider.parser === 'neurips-proceedings-html') {
        const fetched = await fetchOfficialExtended({
            provider, url: provider.indexUrl, kind: 'index', maxBytes: MAX_INDEX_BYTES
        }, dependencies);
        const rel = 'responses/index.html';
        writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} index HTML`, MAX_INDEX_BYTES);
        responseEntries.push({
            file: rel,
            sha256: sha256(fetched.bytes),
            bytes: fetched.bytes.length,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            redirects: fetched.redirects,
            responseStatus: fetched.responseStatus,
            observedAt: fetched.observedAt
        });
        const htmlText = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes);
        metadata = provider.parser === 'acl-anthology-html'
            ? parseEmnlpCatalogHtml(htmlText, provider)
            : parseNeuripsProceedingsHtml(htmlText, provider);
    } else if (provider.parser === 'zenodo-json') {
        const pages = [];
        const seenUrls = new Set();
        let nextUrl = provider.indexUrl;
        for (let pageNo = 1; pageNo <= MAX_JSON_PAGES && nextUrl; pageNo += 1) {
            const validatedUrl = validateUrlForProvider(provider, nextUrl, 'api');
            if (seenUrls.has(validatedUrl)) fail(`${providerId} Zenodo 分页出现循环 URL：${validatedUrl}`);
            seenUrls.add(validatedUrl);
            const fetched = await fetchOfficialExtended({
                provider, url: validatedUrl, kind: 'api', maxBytes: MAX_INDEX_BYTES
            }, dependencies);
            const rel = `responses/page-${String(pageNo).padStart(3, '0')}.json`;
            const pageText = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes);
            rejectDuplicateJsonKeys(pageText, `${providerId} Zenodo page ${pageNo}`);
            const parsedPage = JSON.parse(pageText);
            writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} Zenodo page ${pageNo}`, MAX_INDEX_BYTES);
            pages.push(parsedPage);
            responseEntries.push({
                file: rel,
                sha256: sha256(fetched.bytes),
                bytes: fetched.bytes.length,
                requestedUrl: fetched.requestedUrl,
                finalUrl: fetched.finalUrl,
                redirects: fetched.redirects,
                responseStatus: fetched.responseStatus,
                observedAt: fetched.observedAt
            });
            const rawNext = parsedPage?.links?.next;
            nextUrl = typeof rawNext === 'string' && rawNext.trim() ? rawNext.trim() : null;
        }
        if (nextUrl) {
            fail(`${providerId} Zenodo 分页超过上限 ${MAX_JSON_PAGES} 页，拒绝封存不完整目录`);
        }
        metadata = parseZenodoRecordsPages(pages, provider);
    } else if (provider.parser === 'ieee-local-manifest') {
        const localFile = path.join(paths.responses, 'proceedings.json');
        if (!fs.existsSync(localFile)) {
            fail(`${providerId} 需要先放置官方 proceedings.json 至 ${localFile}`);
        }
        const loaded = readCanonicalJson(localFile, `${providerId} proceedings.json`, MAX_INDEX_BYTES, { requireMode0600: false });
        responseEntries.push({
            file: 'responses/proceedings.json',
            sha256: loaded.sha256,
            bytes: loaded.size,
            requestedUrl: provider.indexUrl,
            finalUrl: provider.indexUrl,
            redirects: [],
            responseStatus: 200,
            observedAt: (dependencies.now || (() => new Date().toISOString()))()
        });
        metadata = parseIeeeLocalManifest(loaded.value, provider);
    } else {
        fail(`不支持的扩展解析器类型：${provider.parser}`);
    }

    const metadataBytes = prettyBytes(metadata);
    writeExclusiveOrCompare(paths.metadataFile, metadataBytes, `${providerId} metadata.json`, MAX_INDEX_BYTES);
    const receipt = buildCatalogReceipt(provider, responseEntries, metadataBytes, metadata.papers);
    writeExclusiveOrCompare(paths.catalogReceiptFile, prettyBytes(receipt), `${providerId} catalog.receipt.json`, MAX_RECEIPT_BYTES);
    replayCatalog(provider.conference.id, outputRoot);
    return {
        command: 'catalog',
        mode: 'apply',
        providerId: provider.conference.id,
        outputRoot,
        papers: metadata.papers.length,
        metadataSha256: sha256(metadataBytes),
        catalogReceiptSha256: receipt.receiptSha256
    };
}

function validateResponseEntry(provider, entry, index, paths) {
    exact(entry, ['bytes', 'file', 'finalUrl', 'observedAt', 'redirects', 'requestedUrl', 'responseStatus', 'sha256'], `responses[${index}]`);
    const full = resolveSafeResponsePath(paths, entry.file);
    if (!SHA_RE.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
        fail(`responses[${index}] 字节数或 SHA 格式无效`);
    }
    if (entry.responseStatus !== 200) fail(`responses[${index}] responseStatus 必须为 200`);
    validateObservedAt(entry.observedAt, `responses[${index}].observedAt`);
    if (!Array.isArray(entry.redirects) || entry.redirects.length > MAX_REDIRECTS) {
        fail(`responses[${index}].redirects 非法`);
    }
    const kind = provider.parser === 'zenodo-json' ? 'api' : 'index';
    validateRedirectChain(provider, entry.requestedUrl, entry.finalUrl, entry.redirects, kind, `responses[${index}]`);
    const requireMode0600 = provider.parser !== 'ieee-local-manifest';
    const loaded = readStableFile(full, entry.file, MAX_INDEX_BYTES, { requireMode0600 });
    if (loaded.sha256 !== entry.sha256 || loaded.size !== entry.bytes) {
        fail(`${provider.conference.id} 原始响应文件 SHA 或长度不一致：${entry.file}`);
    }
    return { entry, bytes: loaded.bytes };
}

function replayCatalog(providerId, outputRoot) {
    const provider = providerFor(providerId);
    const paths = acquisitionPaths(outputRoot, false);
    if (!fs.existsSync(paths.catalogReceiptFile) || !fs.existsSync(paths.metadataFile)) {
        fail(`${providerId} 缺少 catalog.receipt.json 或 metadata.json`);
    }
    const receiptLoaded = readCanonicalJson(paths.catalogReceiptFile, `${providerId} catalog.receipt.json`, MAX_RECEIPT_BYTES);
    const receipt = receiptLoaded.value;
    exact(receipt, [
        'conference', 'contract', 'implementationSha256', 'metadataFile',
        'metadataSha256', 'paperSetSha256', 'parser', 'providerId', 'receiptSha256', 'responses'
    ], `${providerId} catalog.receipt.json`);
    if (receipt.contract !== EXTENDED_CATALOG_RECEIPT_CONTRACT
        || receipt.providerId !== provider.conference.id
        || receipt.parser !== provider.parser
        || receipt.metadataFile !== 'metadata.json'
        || receipt.conference?.id !== provider.conference.id
        || receipt.conference?.year !== provider.conference.year
        || !SHA_RE.test(receipt.implementationSha256 || '')
        || !SHA_RE.test(receipt.metadataSha256 || '')
        || !SHA_RE.test(receipt.paperSetSha256 || '')) {
        fail(`${providerId} catalog.receipt.json 契约或会议身份不匹配`);
    }
    const { receiptSha256, ...core } = receipt;
    if (!SHA_RE.test(receiptSha256 || '') || stableHash(core) !== receiptSha256) {
        fail(`${providerId} catalog.receipt.json 摘要校验失败`);
    }
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) {
        fail(`${providerId} catalog.receipt.json 不是规范 JSON 字节`);
    }
    if (!Array.isArray(receipt.responses) || receipt.responses.length === 0) {
        fail(`${providerId} catalog.receipt.json 必须至少包含一条原始响应记录`);
    }
    const rawResponses = receipt.responses.map((entry, idx) => validateResponseEntry(provider, entry, idx, paths));
    const expectedFiles = new Set(receipt.responses.map(e => path.basename(e.file)));
    if (expectedFiles.size !== receipt.responses.length) {
        fail(`${providerId} catalog.receipt.json 包含重复响应文件路径`);
    }

    let replayedMetadata;
    if (provider.parser === 'acl-anthology-html' || provider.parser === 'neurips-proceedings-html') {
        if (rawResponses.length !== 1 || rawResponses[0].entry.file !== 'responses/index.html') {
            fail(`${providerId} HTML 目录必须绑定唯一的 responses/index.html`);
        }
        const htmlText = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[0].bytes);
        replayedMetadata = provider.parser === 'acl-anthology-html'
            ? parseEmnlpCatalogHtml(htmlText, provider)
            : parseNeuripsProceedingsHtml(htmlText, provider);
    } else if (provider.parser === 'zenodo-json') {
        if (rawResponses.length > MAX_JSON_PAGES) {
            fail(`${providerId} Zenodo 分页数量超过上限 ${MAX_JSON_PAGES}`);
        }
        if (rawResponses[0].entry.requestedUrl !== provider.indexUrl) {
            fail(`${providerId} Zenodo 第 1 页必须始于固定入口 URL`);
        }
        const parsedPages = [];
        const seenReplayUrls = new Set();
        for (let idx = 0; idx < rawResponses.length; idx += 1) {
            const expectedName = `responses/page-${String(idx + 1).padStart(3, '0')}.json`;
            if (rawResponses[idx].entry.file !== expectedName) {
                fail(`${providerId} Zenodo 分页文件命名不连续：期望 ${expectedName}`);
            }
            if (seenReplayUrls.has(rawResponses[idx].entry.requestedUrl)) {
                fail(`${providerId} Zenodo 分页重放检测到循环 URL：${rawResponses[idx].entry.requestedUrl}`);
            }
            seenReplayUrls.add(rawResponses[idx].entry.requestedUrl);
            const pageText = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[idx].bytes);
            rejectDuplicateJsonKeys(pageText, `${providerId} ${expectedName}`);
            const page = JSON.parse(pageText);
            parsedPages.push(page);
            const nextLink = typeof page?.links?.next === 'string' && page.links.next.trim()
                ? page.links.next.trim()
                : null;
            if (idx < rawResponses.length - 1) {
                if (!nextLink || rawResponses[idx + 1].entry.requestedUrl !== nextLink) {
                    fail(`${providerId} Zenodo 第 ${idx + 1} 页与第 ${idx + 2} 页分页链不匹配`);
                }
            } else if (nextLink) {
                fail(`${providerId} Zenodo 末页仍包含未抓取的 links.next，目录不完整`);
            }
        }
        replayedMetadata = parseZenodoRecordsPages(parsedPages, provider);
    } else if (provider.parser === 'ieee-local-manifest') {
        if (rawResponses.length !== 1 || rawResponses[0].entry.file !== 'responses/proceedings.json') {
            fail(`${providerId} 本地清单必须绑定唯一的 responses/proceedings.json`);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[0].bytes);
        rejectDuplicateJsonKeys(text, `${providerId} proceedings.json`);
        replayedMetadata = parseIeeeLocalManifest(JSON.parse(text), provider);
    } else {
        fail(`不支持的扩展解析器：${provider.parser}`);
    }

    const storedMetadataLoaded = readCanonicalJson(paths.metadataFile, `${providerId} metadata.json`, MAX_INDEX_BYTES);
    if (storedMetadataLoaded.sha256 !== receipt.metadataSha256) {
        fail(`${providerId} metadata.json SHA 与 catalog.receipt.json 不一致`);
    }
    const expectedMetadataBytes = prettyBytes(replayedMetadata);
    if (!storedMetadataLoaded.bytes.equals(expectedMetadataBytes)) {
        fail(`${providerId} 重放解析结果与已保存 metadata.json 字节不一致`);
    }
    if (stableHash(replayedMetadata.papers) !== receipt.paperSetSha256) {
        fail(`${providerId} paperSetSha256 与重放论文集合不一致`);
    }
    return {
        provider,
        paths,
        receipt,
        metadata: storedMetadataLoaded.value,
        metadataSha256: receipt.metadataSha256
    };
}

function replayPdfReceipt(replayed, paper) {
    const pdfPath = resolveSafePdfPath(replayed.paths, paper);
    const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
    if (!fs.existsSync(pdfPath) || !fs.existsSync(receiptPath)) {
        fail(`论文 ${paper.id} 缺少 PDF 文件或 PDF receipt`);
    }
    const requireMode0600 = replayed.provider.parser !== 'ieee-local-manifest';
    const pdfLoaded = readStableFile(pdfPath, `${paper.id} PDF`, MAX_PDF_BYTES, { requireMode0600 });
    if (pdfLoaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail(`论文 ${paper.id} 的 PDF 缺少 %PDF- 文件头`);
    }
    const receiptLoaded = readCanonicalJson(receiptPath, `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
    const receipt = receiptLoaded.value;
    exact(receipt, [
        'acquisitionMode', 'contract', 'finalUrl', 'metadataSha256', 'observedAt',
        'paperId', 'pdfBytes', 'pdfFile', 'pdfSha256', 'providerId',
        'receiptSha256', 'redirects', 'requestedUrl', 'responseStatus'
    ], `${paper.id} PDF receipt`);
    const expectedMode = replayed.provider.parser === 'ieee-local-manifest' ? 'local-sealed-pdf' : 'official-http-pdf';
    if (receipt.contract !== EXTENDED_PDF_RECEIPT_CONTRACT
        || receipt.acquisitionMode !== expectedMode
        || receipt.providerId !== replayed.provider.conference.id
        || receipt.metadataSha256 !== replayed.metadataSha256
        || receipt.paperId !== paper.id
        || receipt.pdfFile !== paper.pdfFile
        || receipt.pdfBytes !== pdfLoaded.size
        || receipt.pdfSha256 !== pdfLoaded.sha256
        || receipt.requestedUrl !== paper.pdfUrl
        || receipt.responseStatus !== 200
        || !Array.isArray(receipt.redirects)
        || receipt.redirects.length > MAX_REDIRECTS) {
        fail(`论文 ${paper.id} PDF receipt 身份、会议、元数据或 PDF 绑定不匹配`);
    }
    validateObservedAt(receipt.observedAt, `${paper.id} PDF receipt observedAt`);
    if (expectedMode === 'official-http-pdf') {
        validateRedirectChain(replayed.provider, receipt.requestedUrl, receipt.finalUrl, receipt.redirects, 'pdf', `${paper.id} PDF receipt`);
    } else {
        validateUrlForProvider(replayed.provider, receipt.requestedUrl, 'pdf');
        if (receipt.finalUrl !== paper.pdfUrl || receipt.redirects.length !== 0) {
            fail(`论文 ${paper.id} 本地 PDF receipt 的 URL 或 redirects 异常`);
        }
    }
    const { receiptSha256, ...core } = receipt;
    if (!SHA_RE.test(receiptSha256 || '') || stableHash(core) !== receiptSha256) {
        fail(`论文 ${paper.id} PDF receipt 摘要校验失败`);
    }
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) {
        fail(`论文 ${paper.id} PDF receipt 不是规范 JSON 字节`);
    }
    return receipt;
}

async function downloadPapers(
    { providerId, outputRoot, apply = false, limit = null, concurrency = 1, retries = 0 } = {},
    dependencies = {}
) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail('limit 必须是正整数');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency 必须是 1 到 5 的整数');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) fail('retries 必须是 0 到 5 的整数');
    const replayed = replayCatalog(providerId, outputRoot);
    const downloadable = replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null);
    if (apply) {
        for (const paper of downloadable) {
            recoverImmutableFileLink(resolveSafePdfPath(replayed.paths, paper), fail, MAX_PDF_BYTES);
            recoverImmutableFileLink(path.join(replayed.paths.receipts, `${paper.id}.json`), fail, MAX_RECEIPT_BYTES);
        }
        rejectInterruptedTemporaryFiles([replayed.paths.pdfs, replayed.paths.receipts]);
    }
    const before = acquisitionStatus({ providerId, outputRoot });
    if (!apply) {
        return {
            command: 'download',
            mode: 'dry-run',
            providerId,
            outputRoot,
            total: downloadable.length,
            downloaded: before.pdfVerified,
            pending: before.missingCount,
            limit,
            concurrency,
            retries
        };
    }

    let created = 0;
    let reused = 0;
    let attempted = 0;
    let cursor = 0;
    let firstError = null;
    const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    async function processPaper(paper) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (hasReceipt && !hasPdf) {
            fail(`${paper.id} 的 receipt 存在，却缺少对应 PDF`);
        }
        if (hasPdf && hasReceipt) {
            replayPdfReceipt(replayed, paper);
            reused += 1;
            return;
        }
        if (limit !== null && attempted >= limit) return;
        attempted += 1;

        if (replayed.provider.parser === 'ieee-local-manifest') {
            if (!hasPdf) {
                fail(`${providerId} 为本地清单模式，请先放置官方 PDF 至 ${pdfPath}`);
            }
            const loadedPdf = readStableFile(pdfPath, `${paper.id} local PDF`, MAX_PDF_BYTES, { requireMode0600: false });
            if (loadedPdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
                fail(`论文 ${paper.id} 的本地 PDF 缺少 %PDF- 文件头`);
            }
            const receipt = buildPdfReceipt(replayed.provider, paper, replayed.metadataSha256, {
                acquisitionMode: 'local-sealed-pdf',
                pdfBytes: loadedPdf.bytes,
                requestedUrl: paper.pdfUrl,
                finalUrl: paper.pdfUrl,
                redirects: [],
                responseStatus: 200,
                observedAt: (dependencies.now || (() => new Date().toISOString()))()
            });
            writeExclusiveOrCompare(receiptPath, prettyBytes(receipt), `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
            replayPdfReceipt(replayed, paper);
            created += 1;
            return;
        }

        let fetched;
        for (let attempt = 0; ; attempt += 1) {
            try {
                fetched = await fetchOfficialExtended({
                    provider: replayed.provider,
                    url: paper.pdfUrl,
                    kind: 'pdf',
                    maxBytes: MAX_PDF_BYTES
                }, dependencies);
                break;
            } catch (error) {
                const transient = /request failed|request timed out|HTTP (?:429|5\d\d)/u.test(String(error?.message || ''));
                if (!transient || attempt >= retries) throw error;
                await sleep(Math.min(8000, 500 * (2 ** attempt)));
            }
        }
        const pdfStatus = writeExclusiveOrCompare(pdfPath, fetched.bytes, `${paper.id} PDF`, MAX_PDF_BYTES);
        const receipt = buildPdfReceipt(replayed.provider, paper, replayed.metadataSha256, {
            acquisitionMode: 'official-http-pdf',
            pdfBytes: fetched.bytes,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            redirects: fetched.redirects,
            responseStatus: fetched.responseStatus,
            observedAt: fetched.observedAt
        });
        writeExclusiveOrCompare(receiptPath, prettyBytes(receipt), `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
        replayPdfReceipt(replayed, paper);
        if (pdfStatus === 'created') created += 1;
        else reused += 1;
    }

    async function worker() {
        while (!firstError && cursor < downloadable.length) {
            const paper = downloadable[cursor];
            cursor += 1;
            try {
                await processPaper(paper);
            } catch (error) {
                firstError ||= error;
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (firstError) throw firstError;
    const after = acquisitionStatus({ providerId, outputRoot });
    return {
        command: 'download',
        mode: 'apply',
        providerId,
        outputRoot,
        downloaded: created,
        reused,
        total: downloadable.length,
        verified: after.pdfVerified,
        missing: after.missingCount,
        complete: after.complete,
        concurrency,
        retries
    };
}

function acquisitionStatus({ providerId, outputRoot }) {
    const provider = providerFor(providerId);
    plannedRoot(outputRoot);
    if (!fs.existsSync(outputRoot)) {
        return {
            command: 'status',
            providerId: provider.conference.id,
            outputRoot,
            catalog: 'missing',
            papers: 0,
            pdfExpected: 0,
            pdfVerified: 0,
            partialCount: 0,
            missingCount: 0,
            complete: false
        };
    }
    const replayed = replayCatalog(providerId, outputRoot);
    const withPdf = replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null);
    let verifiedPdfs = 0;
    let partialCount = 0;
    const missing = [];
    for (const paper of withPdf) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (hasPdf && hasReceipt) {
            replayPdfReceipt(replayed, paper);
            verifiedPdfs += 1;
        } else if (hasPdf || hasReceipt) {
            partialCount += 1;
        } else {
            missing.push(paper.id);
        }
    }
    return {
        command: 'status',
        providerId,
        outputRoot,
        catalog: 'complete',
        papers: replayed.metadata.papers.length,
        pdfExpected: withPdf.length,
        pdfVerified: verifiedPdfs,
        partialCount,
        missingCount: missing.length,
        complete: missing.length === 0 && partialCount === 0
    };
}

function verifyAcquisition({ providerId, outputRoot }) {
    const replayed = replayCatalog(providerId, outputRoot);
    rejectInterruptedTemporaryFiles([
        replayed.paths.root,
        replayed.paths.responses,
        replayed.paths.pdfs,
        replayed.paths.receipts
    ]);
    const expectedResponses = new Set(replayed.receipt.responses.map(e => path.basename(e.file)));
    for (const entry of fs.readdirSync(replayed.paths.responses, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !expectedResponses.has(entry.name)) {
            fail(`发现不允许的响应目录文件或子目录：${path.join(replayed.paths.responses, entry.name)}`);
        }
    }
    const expectedPdfs = new Set();
    const expectedReceipts = new Set();
    let verified = 0;
    const missing = [];
    for (const paper of replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null)) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        expectedPdfs.add(path.basename(pdfPath));
        expectedReceipts.add(path.basename(receiptPath));
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (!hasPdf && !hasReceipt) {
            missing.push(paper.id);
            continue;
        }
        if (!hasPdf || !hasReceipt) {
            fail(`${paper.id} 的 PDF 与 receipt 只存在一半`);
        }
        replayPdfReceipt(replayed, paper);
        verified += 1;
    }
    for (const [dir, expected, label] of [
        [replayed.paths.pdfs, expectedPdfs, 'PDF'],
        [replayed.paths.receipts, expectedReceipts, 'receipt']
    ]) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) {
                fail(`发现不允许的 ${label} 文件或目录：${path.join(dir, entry.name)}`);
            }
        }
    }
    return {
        command: 'verify',
        providerId,
        outputRoot,
        metadataSha256: replayed.metadataSha256,
        catalogReceiptSha256: replayed.receipt.receiptSha256,
        papers: replayed.metadata.papers.length,
        pdfExpected: expectedPdfs.size,
        pdfVerified: verified,
        missing,
        missingCount: missing.length,
        complete: missing.length === 0
    };
}

module.exports = {
    OfficialConferenceAcquisitionExtendedError,
    PAPER_FIELDS,
    EXTENDED_CATALOG_RECEIPT_CONTRACT,
    EXTENDED_PDF_RECEIPT_CONTRACT,
    MAX_INDEX_BYTES,
    MAX_PDF_BYTES,
    EXTENDED_PROVIDERS,
    hasProvider,
    providerFor,
    listProviderIds,
    parseEmnlpCatalogHtml,
    parseZenodoRecordsPages,
    parseNeuripsProceedingsHtml,
    parseIeeeLocalManifest,
    acquireCatalog,
    downloadPapers,
    acquisitionStatus,
    verifyAcquisition,
    replayCatalog,
    replayPdfReceipt,
    sha256,
    stableHash
};
