'use strict';

/**
 * arXiv 官方 HTML / PDF / 原文抓取、内容限流与响应清理辅助模块（非 Reader 解析路径）。
 *
 * 从 scripts/deep-analyzer.js 内聚拆出，保持强制 HTTP CONNECT 代理守卫、
 * 源站并发闸门与 100% 原函数行为一致。
 */

const cheerio = require('cheerio');
const { ANALYSIS_CONFIG, ARXIV_CONFIG } = require('../config.js');
const { detectHttpConnectProxyUrl, createProxyDispatcher } = require('../utils.js');
const pdfLayout = require('./pdf-layout.js');
const {
    getArxivHtmlIds,
    isStableArxivHtmlMiss,
    assessArxivHtmlFullText,
    parseArxivStructuredArtifactsFromHtml,
    buildPdfStructuredArtifactsFromBytes,
    bindStructuredArtifactsToText,
    prepareArxivHtmlBodyDom,
    extractArxivHtmlContentFromPreparedDom,
    parseArxivImageInfosFromHtml
} = require('./arxiv-html-structured-artifacts.js');
const {
    parseArxivReaderAuthors,
    retainAuthorSourceHeaderHtml
} = require('./reader-author-parser.js');

const {
    arxivFetchTimeoutMs: ARXIV_FETCH_TIMEOUT_MS,
    arxivPdfFetchTimeoutMs: ARXIV_PDF_FETCH_TIMEOUT_MS = 180000,
    arxivPdfMaxBytes: ARXIV_PDF_MAX_BYTES = 50 * 1024 * 1024,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;

function getArxivFetchDispatcher() {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const proxyUrl = detectHttpConnectProxyUrl();
    if (!proxyUrl) {
        const error = new Error('arXiv 全文、PDF 与图片抓取必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 代理，拒绝直连或仅使用 SOCKS ALL_PROXY');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    try {
        return createProxyDispatcher(proxyUrl);
    } catch (error) {
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
}


function classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure) {
    return htmlAvailability === 'transient_failure' || pdfHadTransientFailure
        ? 'transient'
        : 'permanent';
}


function safeImageLabel(url) {
    const value = String(url || '');
    if (!value) return '<empty>';
    if (value.startsWith('data:')) {
        const mime = value.match(/^data:([^;,]+)/)?.[1] || 'data-uri';
        return `${mime};base64,<omitted>`;
    }
    try {
        const parsed = new URL(value);
        const name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return name.length > 120 ? `${name.slice(0, 117)}...` : name;
    } catch {
        return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
}

function parseContentLength(value) {
    if (!value) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeImageMime(contentType) {
    if (!contentType) return '';
    return String(contentType).split(';')[0].trim().toLowerCase();
}

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return '';
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return '';
}

function isAllowedImageMime(mime) {
    return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

async function readResponseBufferWithLimit(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (maxBytes > 0 && buffer.byteLength > maxBytes) {
            const error = new Error(`response body ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
            error.code = 'RESPONSE_TOO_LARGE';
            throw error;
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (maxBytes > 0 && total > maxBytes) {
                try {
                    await reader.cancel();
                } catch (e) {
                    // 忽略取消导致的错误
                }
                const error = new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                error.code = 'RESPONSE_TOO_LARGE';
                throw error;
            }
            chunks.push(chunk);
        }
    } finally {
        if (reader.releaseLock) {
            reader.releaseLock();
        }
    }
    return Buffer.concat(chunks, total);
}


/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivTextDetailed(arxivId) {
    return require('./fresh-analysis-context.js').fetchFreshSource(arxivId, fetchArxivTextDetailedOriginal);
}

// 建立来源权威时，即使在 fresh-analysis 的 AsyncLocalStorage 作用域里被调用，也必须
// 证明真的现场抓过官方来源。普通分析仍用上面那个会看缓存的函数。
async function fetchArxivTextDetailedUncached(arxivId) {
    return fetchArxivTextDetailedOriginal(arxivId);
}

async function fetchArxivTextDetailedOriginal(arxivId, options = {}) {
    const { sharedArxivOriginGate } = require('./arxiv-origin-gate.js');
    const maxRetries = 6;
    const warnings = [];
    let htmlAvailability = 'transient_failure';
    let htmlAttempts = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        htmlAttempts = attempt;
        let shouldRetryHtml = false;
        const attemptStatuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await sharedArxivOriginGate.run(() => fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher: getArxivFetchDispatcher()
                }));

                if (response.status === 429) {
                    shouldRetryHtml = true;
                    attemptStatuses.push(`${htmlId}:429`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const gateWait = sharedArxivOriginGate.recordRateLimitResponse(response.headers, baseWait);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = Math.max(baseWait, gateWait) + jitter;
                    console.log(`    [deep] fetchArxivText ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (response.ok) {
                    const html = await response.text();
                    const imageInfos = parseArxivImageInfosFromHtml(html, htmlId, arxivId);
                    const structuredArtifacts = parseArxivStructuredArtifactsFromHtml(html, htmlId, arxivId);
                    const $ = cheerio.load(html);
                    const readerAuthors = retainAuthorSourceHeaderHtml(parseArxivReaderAuthors($), html);
                    prepareArxivHtmlBodyDom($);
                    const content = extractArxivHtmlContentFromPreparedDom($);
                    const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, content);

                    const assessment = assessArxivHtmlFullText($, content, FULL_TEXT_MIN_CHARS_FOR_FULL);
                    if (!assessment.valid) {
                        warnings.push(
                            `HTML ${htmlId}: ${assessment.reason} `
                            + `(chars=${assessment.chars}, paragraphs=${assessment.paragraphCount}, `
                            + `sections=${assessment.sectionCount}, markers=${assessment.markerCount})`
                        );
                        console.log(
                            `    [deep] fetchArxivText ${htmlId} 正文健康检查失败 `
                            + `| reason=${assessment.reason} | chars=${assessment.chars} `
                            + `| paragraphs=${assessment.paragraphCount} | sections=${assessment.sectionCount} `
                            + `| markers=${assessment.markerCount}，继续 fallback`
                        );
                        continue;
                    }
                    return {
                        text: content,
                        title: String($('meta[name="citation_title"]').first().attr('content')
                            || $('.ltx_title').first().text() || '').replace(/\s+/g, ' ').trim(),
                        source: 'html',
                        sourceId: htmlId,
                        imageInfos,
                        structuredArtifacts: boundStructuredArtifacts,
                        readerAuthors,
                        htmlAvailability: 'available',
                        htmlAttempts,
                        warnings
                    };
                }
                if (response.status === 403) {
                    sharedArxivOriginGate.recordRateLimitResponse(response.headers, Math.min(attempt * 8000, 60000));
                }
                console.log(`    [deep] fetchArxivText ${htmlId} HTTP ${response.status}`);
                attemptStatuses.push(`${htmlId}:${response.status}`);
                if (!isStableArxivHtmlMiss(response.status)) {
                    shouldRetryHtml = true;
                }
            } catch (e) {
                if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
                shouldRetryHtml = true;
                attemptStatuses.push(`${htmlId}:${e.name || 'error'}`);
                console.log(`    [deep] fetchArxivText ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (attemptStatuses.length > 0) warnings.push(`HTML attempt ${attempt}: ${attemptStatuses.join(', ')}`);
        if (!shouldRetryHtml) {
            htmlAvailability = 'permanent_miss';
            console.log(`    [deep] fetchArxivText ${arxivId} HTML 永久不可用 | attempts=${htmlAttempts} | ${attemptStatuses.join(', ')}`);
            break;
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivText ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    if (options.allowPdfFallback === false) {
        // 重新抓取来源的流程自行下载 PDF；此处仅返回 HTML 获取情况。
        // 文本提取使用该流程待核验和保存的那份 PDF，避免重复下载。
        return {
            text: '', source: 'unavailable', sourceId: '', imageInfos: [], structuredArtifacts: null,
            htmlAvailability, htmlAttempts, warnings,
            failureClass: classifyArxivSourceFailure(htmlAvailability, false), failureError: ''
        };
    }
    console.log(`    [deep] fetchArxivText ${arxivId} 转入 PDF fallback | html_status=${htmlAvailability} | attempts=${htmlAttempts}`);

    // HTML 不可用时，下载 PDF 并提取文本。
    let pdfHadTransientFailure = false;
    let lastTransientFailure = '';
    for (const pdfId of getArxivHtmlIds(arxivId)) {
        const pdfUrl = `https://arxiv.org/pdf/${pdfId}.pdf`;
        try {
            const pdfResponse = await sharedArxivOriginGate.run(() => fetch(pdfUrl, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS),
                dispatcher: getArxivFetchDispatcher()
            }));
            if (!pdfResponse.ok) {
                if (pdfResponse.status === 429 || pdfResponse.status === 403) {
                    sharedArxivOriginGate.recordRateLimitResponse(pdfResponse.headers, 8000);
                }
                console.log(`    [deep] PDF ${pdfUrl} HTTP ${pdfResponse.status}`);
                warnings.push(`PDF ${pdfId}: HTTP ${pdfResponse.status}`);
                if (isRetryableImageStatus(pdfResponse.status)) {
                    pdfHadTransientFailure = true;
                    lastTransientFailure = `PDF ${pdfId}: HTTP ${pdfResponse.status}`;
                }
                continue;
            }
            const contentType = String(pdfResponse.headers.get('content-type') || '').toLowerCase();
            if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
                warnings.push(`PDF ${pdfId}: Content-Type ${contentType}`);
                continue;
            }
            const buffer = await readResponseBufferWithLimit(pdfResponse, ARXIV_PDF_MAX_BYTES);
            if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
                warnings.push(`PDF ${pdfId}: 文件头无效`);
                continue;
            }
            const layout = await pdfLayout.extractPdfLayoutFromBytes(buffer);
            if (layout?.text) {
                const rawPdfText = String(layout.text);
                const structuredArtifacts = buildPdfStructuredArtifactsFromBytes(
                    rawPdfText, buffer, pdfId, layout.visualAudit
                );
                const text = rawPdfText
                    .replace(/\n\s*\n/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
                const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, text);
                if (text.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
                    warnings.push(`PDF ${pdfId}: 提取正文过短 (${text.length} chars)`);
                    continue;
                }
                warnings.push(`PDF ${pdfId}: PyMuPDF 视觉审计 ${layout.visualAudit.pages.length} 页、${layout.visualAudit.tableCandidates.length} 个表格候选、${layout.visualAudit.formulaCandidates.length} 个公式候选、${layout.visualAudit.figureCandidates.length} 个 Figure 标题候选；公式无原始 TeX，表格未自动转为可发布结构。`);
                console.log(`    [deep] PDF fallback success for ${arxivId}, extracted ${text.length} chars with PyMuPDF visual audit`);
                return {
                    text,
                    source: 'pdf',
                    sourceId: pdfId,
                    imageInfos: [],
                    structuredArtifacts: boundStructuredArtifacts,
                    htmlAvailability,
                    htmlAttempts,
                    warnings
                };
            }
        } catch (e) {
            if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
            pdfHadTransientFailure = true;
            lastTransientFailure = `PDF ${pdfId}: ${e.message}`;
            console.log(`    [deep] PDF fallback ${pdfUrl} error: ${e.message}`);
            warnings.push(`PDF ${pdfId}: ${e.message}`);
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} PDF fallback also failed`);
    const failureClass = classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure);
    return {
        text: '',
        source: 'unavailable',
        sourceId: '',
        imageInfos: [],
        structuredArtifacts: null,
        htmlAvailability,
        htmlAttempts,
        warnings,
        failureClass,
        failureError: failureClass === 'transient'
            ? (lastTransientFailure || `arXiv ${arxivId} 全文抓取瞬时失败`)
            : ''
    };
}

// 来源保存流程传入已保存的官方 PDF 字节；此函数不联网下载其他文件。
async function extractArxivPdfTextDetailedFromBytes(arxivId, rawBytes, options = {}) {
    const normalized = String(arxivId || '').trim().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(normalized)) throw new Error('arXiv PDF extraction requires a normalized modern arXiv ID');
    const bytes = Buffer.from(rawBytes || []);
    if (bytes.length < 5 || bytes.length > ARXIV_PDF_MAX_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error(`arXiv PDF ${normalized} bytes are invalid for fallback extraction`);
    }
    const layout = await pdfLayout.extractPdfLayoutFromBytes(bytes);
    const rawPdfText = String(layout?.text || '');
    const structuredArtifacts = buildPdfStructuredArtifactsFromBytes(
        rawPdfText, bytes, normalized, layout.visualAudit
    );
    const text = rawPdfText.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (text.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
        throw new Error(`arXiv PDF ${normalized} fallback text is too short (${text.length} chars)`);
    }
    return {
        text, source: 'pdf', sourceId: normalized, imageInfos: [],
        structuredArtifacts: bindStructuredArtifactsToText(structuredArtifacts, text),
        htmlAvailability: options.htmlAvailability || 'unavailable',
        htmlAttempts: Number.isSafeInteger(options.htmlAttempts) ? options.htmlAttempts : 0,
        warnings: [
            ...(Array.isArray(options.warnings) ? options.warnings.slice() : []),
            `PDF ${normalized}: PyMuPDF 视觉审计 ${layout.visualAudit.pages.length} 页、${layout.visualAudit.tableCandidates.length} 个表格候选、${layout.visualAudit.formulaCandidates.length} 个公式候选、${layout.visualAudit.figureCandidates.length} 个 Figure 标题候选；公式无原始 TeX，表格未自动转为可发布结构。`
        ]
    };
}

async function fetchArxivHtmlTextDetailedUncached(arxivId) {
    return fetchArxivTextDetailedOriginal(arxivId, { allowPdfFallback: false });
}

async function fetchArxivText(arxivId) {
    return (await fetchArxivTextDetailed(arxivId)).text;
}

const ARXIV_PDF_TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT'
]);

function arxivPdfTransportFailure(error, candidate, phase) {
    const details = [error, error?.cause, error?.cause?.cause];
    const transient = details.find(item => item?.name === 'TimeoutError' || ARXIV_PDF_TRANSIENT_CODES.has(item?.code));
    const reason = transient?.name === 'TimeoutError' ? 'TIMEOUT' : transient?.code;
    const code = reason || details.find(item => typeof item?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code))?.code
        || 'ARXIV_PDF_FETCH_FAILED';
    const failure = new Error(`arXiv PDF ${candidate} ${phase} failed [${code}]`, { cause: error });
    failure.code = code;
    return { failure, transient: Boolean(transient) };
}

// 历史全新重写的来源采集总会留下原始官方 PDF，HTML 路径正常时也一样。这里刻意绕过
// 普通的全新来源缓存，用和上面全文抓取器相同的、强制走 arXiv CONNECT 的 dispatcher。
async function fetchArxivPdfUncached(arxivId, options = {}) {
    const normalized = String(arxivId || '').trim().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(normalized)) {
        throw new Error('arXiv PDF fetch requires a normalized modern arXiv ID');
    }
    const preferred = String(options.preferredSourceId || '').trim();
    if (preferred && (!/^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(preferred)
        || preferred.replace(/v\d+$/i, '') !== normalized)) {
        throw new Error('arXiv PDF preferred source ID belongs to another paper or is malformed');
    }
    const candidates = [...new Set([normalized, preferred, ...getArxivHtmlIds(normalized)].filter(Boolean))];
    const fetchImpl = options.fetchImpl || fetch;
    const pause = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const { sharedArxivOriginGate } = require('./arxiv-origin-gate.js');
    const useGate = !options.fetchImpl;
    let currentPdfStatus = null;
    let retryAvailable = true;
    for (const candidate of candidates) {
        const requestedUrl = `https://arxiv.org/pdf/${candidate}.pdf`;
        const dispatcher = options.dispatcher || getArxivFetchDispatcher();
        let httpRetriesLeft = 4;
        while (true) {
            let phase = 'request';
            let response, bytes;
            try {
                const doFetch = () => fetchImpl(requestedUrl, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS),
                    dispatcher
                });
                response = useGate ? await sharedArxivOriginGate.run(doFetch, pause) : await doFetch();
                phase = 'response';
                if (response.ok) {
                    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                    if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
                        try { await response.body?.cancel(); } catch (_) {}
                        throw new Error(`arXiv PDF ${candidate} returned unexpected Content-Type ${contentType}`);
                    }
                    phase = 'body';
                    bytes = await readResponseBufferWithLimit(response, ARXIV_PDF_MAX_BYTES);
                } else {
                    try { await response.body?.cancel(); } catch (_) {}
                }
            } catch (error) {
                if (phase === 'response' || error?.code === 'RESPONSE_TOO_LARGE') throw error;
                const { failure, transient } = arxivPdfTransportFailure(error, candidate, phase);
                if (!retryAvailable || !transient) throw failure;
                retryAvailable = false;
                console.log(`    [deep] ${failure.message}，同一官方 PDF 地址重试一次`);
                await pause(750);
                continue;
            }
            if (!response.ok) {
                if (candidate === normalized) currentPdfStatus = response.status;
                if (response.status === 404) break;
                if ((useGate || options.retryHttpStatus === true)
                    && (response.status === 429 || response.status === 403 || response.status >= 500)
                    && httpRetriesLeft > 0) {
                    httpRetriesLeft -= 1;
                    const fallbackWait = Math.min(60000, (5 - httpRetriesLeft) * 6000);
                    const waitMs = useGate
                        ? sharedArxivOriginGate.recordRateLimitResponse(response.headers, fallbackWait)
                        : fallbackWait;
                    console.log(`    [deep] arXiv PDF ${candidate} 返回 HTTP ${response.status}，冷却 ${(waitMs / 1000).toFixed(1)}s 后重试`);
                    await pause(waitMs);
                    continue;
                }
                throw new Error(`arXiv PDF ${candidate} download failed: HTTP ${response.status}`);
            }
            if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
                throw new Error(`arXiv PDF ${candidate} returned an invalid PDF header`);
            }
            const actualUrl = String(response.url || requestedUrl);
            return { bytes, url: actualUrl, sourceId: candidate, fetchedAt: new Date().toISOString(),
                currentPdfUnavailable: candidate !== normalized, currentPdfStatus };
        }
    }
    const error = new Error(`arXiv PDF ${normalized} download failed: HTTP ${currentPdfStatus || 404}`);
    error.code = 'ARXIV_PDF_NOT_FOUND';
    error.status = 404;
    error.arxivId = normalized;
    throw error;
}


/**
 * 从 arxiv HTML 获取图片信息列表（含 URL 和 caption）
 * 使用 cheerio 解析 <figure> 元素，提取图片 URL 和 figcaption 文本
 * 带重试机制，避免因并发限流偶发失败
 */

async function fetchArxivImageUrls(arxivId, options = {}) {
    if (options.htmlAvailability === 'permanent_miss') {
        console.log(`    [deep] fetchArxivImageUrls ${arxivId} 跳过 | reason=html_permanent_miss`);
        return [];
    }
    const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
        ? options.maxRetries
        : 6;
    const fetchImpl = options.fetchImpl || fetch;
    const dispatcher = Object.prototype.hasOwnProperty.call(options, 'dispatcher')
        ? options.dispatcher
        : getArxivFetchDispatcher();
    const { sharedArxivOriginGate } = require('./arxiv-origin-gate.js');
    const useGate = !options.fetchImpl;
    let lastFailure = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let shouldRetry = false;
        let alreadyWaitedRateLimit = false;
        const statuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const doFetch = () => fetchImpl(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher
                });
                const response = useGate ? await sharedArxivOriginGate.run(doFetch) : await doFetch();

                if (response.status === 429 || response.status === 403) {
                    try { await response.body?.cancel(); } catch (_) {}
                    shouldRetry = true;
                    alreadyWaitedRateLimit = true;
                    statuses.push(`${htmlId}:${response.status}`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = useGate
                        ? sharedArxivOriginGate.recordRateLimitResponse(response.headers, baseWait + jitter)
                        : (baseWait + jitter);
                    console.log(`    [deep] fetchArxivImageUrls ${arxivId} 被限流 (${response.status})，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (!response.ok) {
                    try { await response.body?.cancel(); } catch (_) {}
                    statuses.push(`${htmlId}:${response.status}`);
                    if (!isStableArxivHtmlMiss(response.status)) shouldRetry = true;
                    continue;
                }

                const html = await response.text();
                return parseArxivImageInfosFromHtml(html, htmlId, arxivId);
            } catch (e) {
                if (e.code === 'PROXY_CONFIG_ERROR') throw e;
                shouldRetry = true;
                statuses.push(`${htmlId}:${e.name || 'error'}`);
                lastFailure = e.message;
                console.log(`    [deep] fetchArxivImageUrls ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (!shouldRetry) {
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} 永久不可用 | attempts=${attempt} | ${statuses.join(', ')}`);
            return [];
        }
        if (attempt < maxRetries && !alreadyWaitedRateLimit) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivImageUrls ${arxivId} failed after ${maxRetries} retries`);
    const error = new Error(`arXiv 图片发现在 ${maxRetries} 次尝试后仍失败${lastFailure ? `: ${lastFailure}` : ''}`);
    error.code = 'ARXIV_IMAGE_DISCOVERY_TRANSIENT_FAILURE';
    throw error;
}


function isRetryableImageStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}


module.exports = {
    ARXIV_PDF_TRANSIENT_CODES,
    getArxivFetchDispatcher,
    classifyArxivSourceFailure,
    safeImageLabel,
    parseContentLength,
    normalizeImageMime,
    sniffImageMime,
    isAllowedImageMime,
    readResponseBufferWithLimit,
    isRetryableImageStatus,
    fetchArxivTextDetailed,
    fetchArxivTextDetailedUncached,
    fetchArxivTextDetailedOriginal,
    extractArxivPdfTextDetailedFromBytes,
    fetchArxivHtmlTextDetailedUncached,
    fetchArxivText,
    arxivPdfTransportFailure,
    fetchArxivPdfUncached,
    fetchArxivImageUrls
};
