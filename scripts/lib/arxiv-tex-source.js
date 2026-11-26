'use strict';

/**
 * arXiv /e-print/<id> TeX Source Channel Fetcher & Sidecar Manager.
 *
 * Contract: arxiv-tex-ast
 *
 * - Strictly enforces project HTTP CONNECT proxy via HTTPS_PROXY/HTTP_PROXY
 *   using scripts/utils.js (never silently degrades to direct connection).
 * - Gracefully handles non-200 / 404 / PDF-only / HTML-only papers by returning
 *   { status: 'unavailable', reason } without breaking the main pipeline.
 * - Bridges to scripts/arxiv_tex_extract.py via scripts/python-runtime.sh.
 * - Deterministically validates sidecar contract, archiveSha256, extractorSha256,
 *   arxivId, sidecarSha256, and full JSON schema integrity (fail-closed on drift).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
    detectHttpConnectProxyUrl,
    createProxyAgent,
    writeFileAtomic,
} = require('../utils.js');

const execFileAsync = promisify(execFile);

const ARXIV_TEX_AST_CONTRACT = 'arxiv-tex-ast';
const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_CHARS = 2 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 60000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_ALLOWED_REDIRECTS = 10;
const SEALED_BUNDLE_PATH_RE = /(?:^|\/)(?:daily-fresh-source-runs|fetched-arxiv-sources)\/(?:.+\/)?generation-[^/]+(?:\/|$)/i;

const SCRIPTS_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SCRIPTS_ROOT, '..');
const PYTHON_RUNTIME_SCRIPT = path.join(SCRIPTS_ROOT, 'python-runtime.sh');
const PYTHON_EXTRACTOR_SCRIPT = path.join(SCRIPTS_ROOT, 'arxiv_tex_extract.py');

const ALLOWED_ARXIV_HOSTS = new Set(['arxiv.org', 'export.arxiv.org']);
const ARXIV_ID_INPUT_RE = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/i;
const NORMALIZED_ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DRIVE_LETTER_RE = /^[A-Za-z]:/;

const ALLOWED_ARCHIVE_FORMATS = new Set(['tar.gz', 'tar', 'tex.gz', 'tex']);
const ALLOWED_BINDING_STATUSES = new Set(['bound', 'ambiguous', 'unmapped']);
const ALLOWED_OVERALL_AFFIL_STATUSES = new Set([
    'bound',
    'single_affiliation',
    'unmapped',
    'ambiguous',
    'none',
]);
const REQUIRED_TOP_KEYS = Object.freeze([
    'contract',
    'arxivId',
    'title',
    'abstract',
    'authors',
    'affiliations',
    'authorAffiliationStatus',
    'thanks',
    'sections',
    'tables',
    'figures',
    'equations',
    'bibliography',
    'provenance',
]);
const OPTIONAL_TOP_KEYS = new Set(['sidecarSha256']);
const REQUIRED_PROVENANCE_KEYS = Object.freeze([
    'contract',
    'archiveSha256',
    'archiveFormat',
    'archiveBytes',
    'rootTexFile',
    'includedFiles',
    'totalExpandedChars',
    'extractorSha256',
    'strippedCommentsCount',
]);
const REQUIRED_AUTHOR_KEYS = Object.freeze([
    'name',
    'markers',
    'affiliations',
    'thanks',
    'bindingStatus',
]);
const REQUIRED_AFFILIATION_KEYS = Object.freeze(['marker', 'text']);
const REQUIRED_SECTION_KEYS = Object.freeze(['level', 'title', 'text', 'charOffset']);
const REQUIRED_TABLE_KEYS = Object.freeze(['caption', 'label', 'headers', 'rows']);
const REQUIRED_FIGURE_KEYS = Object.freeze(['caption', 'label', 'graphicsPaths']);
const REQUIRED_EQUATION_KEYS = Object.freeze(['environment', 'label', 'labels', 'latex', 'numbered']);
const REQUIRED_BIBLIOGRAPHY_KEYS = Object.freeze([
    'bibitemCount',
    'bibliographyFiles',
    'bibEntryCount',
    'referenceCount',
]);

class ArxivTexSourceError extends Error {
    constructor(message, code = 'ARXIV_TEX_SOURCE_ERROR', details = {}) {
        super(message);
        this.name = 'ArxivTexSourceError';
        this.code = code;
        this.retryable = false;
        Object.assign(this, details);
    }
}

class ArxivTexProxyError extends ArxivTexSourceError {
    constructor(message, details = {}) {
        super(message, 'ARXIV_TEX_PROXY_REQUIRED', details);
        this.name = 'ArxivTexProxyError';
    }
}

class ArxivTexSidecarError extends ArxivTexSourceError {
    constructor(message, details = {}) {
        super(`arXiv TeX sidecar 校验失败：${message}`, 'ARXIV_TEX_SIDECAR_INTEGRITY', details);
        this.name = 'ArxivTexSidecarError';
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
        );
    }
    return value;
}

function stableHash(value) {
    return sha256(JSON.stringify(canonicalize(value)));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(canonicalize(value)));
}

function normalizeArxivId(rawId) {
    const trimmed = String(rawId || '').trim();
    const match = ARXIV_ID_INPUT_RE.exec(trimmed);
    if (!match) {
        throw new ArxivTexSourceError(
            `非法 arXiv ID：${String(rawId)}`,
            'INVALID_ARXIV_ID'
        );
    }
    const arxivId = match[1];
    const version = match[2] ? Number(match[2]) : null;
    const queryId = version !== null ? `${arxivId}v${version}` : arxivId;
    return { arxivId, version, queryId };
}

function getExtractorSha256(scriptPath = PYTHON_EXTRACTOR_SCRIPT) {
    const resolved = path.resolve(scriptPath);
    let fd;
    try {
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
            throw new ArxivTexSourceError(`提取器路径不是普通文件：${resolved}`, 'EXTRACTOR_UNAVAILABLE');
        }
        return sha256(fs.readFileSync(fd));
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

const LONE_SURROGATE_RE = /[\ud800-\udfff]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI_OVERRIDE_RE = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;
const DARWIN_SYSTEM_SYMLINKS = new Set(['/tmp', '/var', '/etc']);

function isSafeRelativePosixPath(value) {
    if (typeof value !== 'string' || !value) {
        return false;
    }
    const variants = [value, value.normalize('NFKC')];
    for (const variant of variants) {
        if (
            LONE_SURROGATE_RE.test(variant)
            || CONTROL_CHAR_RE.test(variant)
            || BIDI_OVERRIDE_RE.test(variant)
            || variant.includes('\\')
            || variant.startsWith('/')
            || DRIVE_LETTER_RE.test(variant)
        ) {
            return false;
        }
        const parts = variant.split('/');
        if (!parts.every(part => Boolean(part) && part !== '.' && part !== '..')) {
            return false;
        }
        if (DRIVE_LETTER_RE.test(parts[0]) || parts[0].includes(':')) {
            return false;
        }
    }
    return true;
}

function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack.at(-1);
        if (token === '{') {
            stack.push({ object: true, keys: new Set(), expectKey: true });
        } else if (token === '[') {
            stack.push({ object: false });
        } else if (token === '}' || token === ']') {
            stack.pop();
        } else if (token === ',' && top?.object) {
            top.expectKey = true;
        } else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) {
                throw new ArxivTexSidecarError(`JSON 包含重复键：${key}`);
            }
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function parseStrictJsonBytes(bytes, label = 'sidecar JSON') {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        throw new ArxivTexSidecarError(`${label} 不是有效的 UTF-8：${error.message}`);
    }
    try {
        rejectDuplicateJsonKeys(text);
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof ArxivTexSidecarError) throw error;
        throw new ArxivTexSidecarError(`${label} JSON 解析失败：${error.message}`);
    }
}

function readRegularFileBounded(filePath, maxBytes, label = '文件') {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new ArxivTexSidecarError(`${label}路径必须是绝对路径`);
    }
    const resolved = path.resolve(filePath);
    let fd;
    try {
        fd = fs.openSync(
            resolved,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(resolved);
        if (
            !opened.isFile()
            || opened.nlink !== 1
            || named.isSymbolicLink()
            || named.dev !== opened.dev
            || named.ino !== opened.ino
        ) {
            throw new ArxivTexSidecarError(`${label}必须是单硬链接普通文件且不能是符号链接`);
        }
        if (opened.size > maxBytes) {
            throw new ArxivTexSidecarError(`${label}超过 ${maxBytes} 字节上限`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) {
            throw new ArxivTexSidecarError(`${label}在读取过程中发生变化`);
        }
        return bytes;
    } catch (error) {
        if (error instanceof ArxivTexSidecarError) throw error;
        throw new ArxivTexSidecarError(`无法读取${label}：${error.code || error.message}`);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Safe arXiv /e-print/<id> HTTP CONNECT Proxy Fetcher
// ═══════════════════════════════════════════════════════════════════════════

function validateArxivEprintUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (
        parsed.protocol !== 'https:'
        || !ALLOWED_ARXIV_HOSTS.has(parsed.hostname.toLowerCase())
        || parsed.port
        || parsed.username
        || parsed.password
        || parsed.hash
    ) {
        return null;
    }
    return parsed.toString();
}

function classifyUnavailablePayload(bytes, contentType) {
    const ct = String(contentType || '').toLowerCase();
    if (!bytes || bytes.length === 0) {
        return 'empty_response';
    }
    if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
        return 'pdf_only';
    }
    if (ct.includes('application/pdf')) {
        return 'pdf_only';
    }
    if (bytes.length >= 10 && bytes.subarray(0, 10).toString('ascii') === '%!PS-Adobe') {
        return 'postscript_only';
    }
    const head = bytes.subarray(0, Math.min(bytes.length, 512)).toString('utf8').trimStart().toLowerCase();
    if (ct.includes('text/html') || head.startsWith('<!doctype html') || head.startsWith('<html')) {
        return 'html_not_tex';
    }
    return null;
}

function httpsBinaryRequestWithProxy(
    url,
    headers,
    proxyUrl,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_ARCHIVE_BYTES,
    dependencies = {}
) {
    if (!proxyUrl) {
        return Promise.reject(
            new ArxivTexProxyError(
                'arXiv /e-print 抓取必须通过 HTTPS_PROXY 或 HTTP_PROXY 配置 HTTP CONNECT 代理，禁止静默直连'
            )
        );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new ArxivTexSourceError(`timeoutMs 必须是正整数：${timeoutMs}`, 'INVALID_ARGUMENT'));
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        return Promise.reject(
            new ArxivTexSourceError(`maxResponseBytes 必须是正整数：${maxResponseBytes}`, 'INVALID_ARGUMENT')
        );
    }

    return new Promise((resolve, reject) => {
        const httpsMod = dependencies.httpsModule || require('node:https');
        const proxyAgentFactory = dependencies.proxyAgentFactory || createProxyAgent;
        const urlObj = new URL(url);
        let agent;
        try {
            agent = proxyAgentFactory(proxyUrl, urlObj.hostname, 443, urlObj.hostname);
        } catch (error) {
            if (error instanceof ArxivTexProxyError) {
                reject(error);
            } else {
                reject(
                    new ArxivTexProxyError(
                        `代理连接对象初始化失败：${error?.message || error}`,
                        { cause: error }
                    )
                );
            }
            return;
        }

        let settled = false;
        let deadlineTimer = null;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            try { agent?.destroy?.(); } catch (_) {}
            handler(value);
        };

        try {
            const req = httpsMod.request(
                {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers,
                    timeout: timeoutMs,
                    agent,
                },
                (res) => {
                    // MUST register error listener first so destroying res never crashes with unhandled 'error'
                    res.on('error', (error) => finish(reject, error));

                    const statusCode = Number.isInteger(res.statusCode) ? res.statusCode : null;
                    const declaredLen = Number(getHeaderCaseInsensitive(res.headers, 'content-length'));
                    if (Number.isFinite(declaredLen) && declaredLen > maxResponseBytes) {
                        const error = new ArxivTexSourceError(
                            `arXiv /e-print 响应超过 ${maxResponseBytes} 字节上限`,
                            'ARCHIVE_TOO_LARGE',
                            { httpStatus: statusCode }
                        );
                        finish(reject, error);
                        try { res.destroy?.(); } catch (_) {}
                        try { req.destroy?.(); } catch (_) {}
                        return;
                    }
                    const chunks = [];
                    let total = 0;
                    res.on('data', (chunk) => {
                        if (settled) return;
                        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        total += buf.length;
                        if (total > maxResponseBytes) {
                            const error = new ArxivTexSourceError(
                                `arXiv /e-print 响应超过 ${maxResponseBytes} 字节上限`,
                                'ARCHIVE_TOO_LARGE',
                                { httpStatus: statusCode }
                            );
                            finish(reject, error);
                            try { res.destroy?.(); } catch (_) {}
                            try { req.destroy?.(); } catch (_) {}
                            return;
                        }
                        chunks.push(buf);
                    });
                    res.on('end', () => {
                        finish(resolve, {
                            status: res.statusCode,
                            headers: res.headers || {},
                            bytes: Buffer.concat(chunks, total),
                        });
                    });
                    res.on('close', () => {
                        if (!res.complete) {
                            const error = new ArxivTexSourceError('arXiv /e-print 响应流提前关闭', 'NETWORK_CLOSED');
                            finish(reject, error);
                        }
                    });
                }
            );

            deadlineTimer = setTimeout(() => {
                const error = new ArxivTexSourceError(
                    `arXiv /e-print 请求超过 ${timeoutMs}ms 上限`,
                    'REQUEST_DEADLINE_EXCEEDED'
                );
                finish(reject, error);
                try { req.destroy?.(); } catch (_) {}
            }, timeoutMs);
            deadlineTimer.unref?.();

            req.on('error', (error) => finish(reject, error));
            req.on('timeout', () => {
                const error = new ArxivTexSourceError(
                    `arXiv /e-print 连接在 ${timeoutMs}ms 后超时`,
                    'REQUEST_SOCKET_TIMEOUT'
                );
                finish(reject, error);
                try { req.destroy?.(); } catch (_) {}
            });
            req.end();
        } catch (error) {
            finish(reject, error);
        }
    });
}

function getHeaderCaseInsensitive(headers, name) {
    if (!headers || typeof headers !== 'object') return '';
    if (typeof headers.get === 'function') {
        return String(headers.get(name) || '');
    }
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) {
            return Array.isArray(value) ? String(value[0] || '') : String(value || '');
        }
    }
    return '';
}

async function fetchArxivTexArchive(rawArxivId, options = {}, dependencies = {}) {
    const { arxivId, queryId } = normalizeArxivId(rawArxivId);
    const host = String(options.host || 'arxiv.org').toLowerCase();
    if (!ALLOWED_ARXIV_HOSTS.has(host)) {
        throw new ArxivTexSourceError(`不允许的 arXiv 主机：${host}`, 'INVALID_HOST');
    }

    const detectProxy = dependencies.detectProxy || detectHttpConnectProxyUrl;
    const proxyUrl = detectProxy();
    if (!proxyUrl) {
        throw new ArxivTexProxyError(
            'arXiv /e-print 抓取必须在项目 .env 中配置 HTTPS_PROXY 或 HTTP_PROXY（HTTP CONNECT 代理），禁止静默直连'
        );
    }

    const maxBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_ARCHIVE_BYTES) {
        throw new ArxivTexSourceError(
            `maxArchiveBytes 必须是 1..${DEFAULT_MAX_ARCHIVE_BYTES} 之间的整数`,
            'INVALID_ARGUMENT'
        );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new ArxivTexSourceError(`timeoutMs 必须是正整数：${timeoutMs}`, 'INVALID_ARGUMENT');
    }
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_ALLOWED_REDIRECTS) {
        throw new ArxivTexSourceError(
            `maxRedirects 必须是 0..${MAX_ALLOWED_REDIRECTS} 之间的整数`,
            'INVALID_ARGUMENT'
        );
    }
    const sourceUrl = `https://${host}/e-print/${encodeURIComponent(queryId)}`;
    const requestFn = dependencies.requestFn || httpsBinaryRequestWithProxy;
    const headers = {
        'User-Agent': options.userAgent || 'audio-paper-digest arxiv-tex-source/1.0',
        Accept: 'application/x-eprint-tar, application/x-gzip, application/x-tar, text/x-tex, */*;q=0.8',
    };

    let currentUrl = sourceUrl;
    let response = null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        try {
            response = await requestFn(
                currentUrl,
                headers,
                proxyUrl,
                timeoutMs,
                maxBytes,
                dependencies
            );
        } catch (error) {
            if (error instanceof ArxivTexProxyError) throw error;
            if (error?.code === 'ARCHIVE_TOO_LARGE') {
                return {
                    status: 'unavailable',
                    reason: 'archive_too_large',
                    arxivId,
                    queryId,
                    sourceUrl,
                    finalUrl: currentUrl,
                    httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
                };
            }
            if (options.throwOnNetworkError === true) throw error;
            return {
                status: 'unavailable',
                reason: 'network_error',
                arxivId,
                queryId,
                sourceUrl,
                finalUrl: currentUrl,
                errorCode: String(error?.code || 'NETWORK_ERROR'),
                detail: String(error?.message || error).slice(0, 300),
            };
        }

        const status = Number(response?.status);
        if ([301, 302, 303, 307, 308].includes(status)) {
            if (hop >= maxRedirects) {
                return {
                    status: 'unavailable',
                    reason: 'too_many_redirects',
                    arxivId,
                    queryId,
                    sourceUrl,
                    finalUrl: currentUrl,
                    httpStatus: status,
                };
            }
            const location = getHeaderCaseInsensitive(response.headers, 'location').trim();
            if (!location) {
                return {
                    status: 'unavailable',
                    reason: 'redirect_missing_location',
                    arxivId,
                    queryId,
                    sourceUrl,
                    finalUrl: currentUrl,
                    httpStatus: status,
                };
            }
            let nextUrl;
            try {
                nextUrl = validateArxivEprintUrl(new URL(location, currentUrl).toString());
            } catch {
                nextUrl = null;
            }
            if (!nextUrl) {
                return {
                    status: 'unavailable',
                    reason: 'unsafe_redirect',
                    arxivId,
                    queryId,
                    sourceUrl,
                    finalUrl: currentUrl,
                    httpStatus: status,
                };
            }
            currentUrl = nextUrl;
            continue;
        }
        break;
    }

    const httpStatus = Number(response?.status);
    if (httpStatus !== 200) {
        return {
            status: 'unavailable',
            reason: Number.isInteger(httpStatus) && httpStatus > 0 ? `http_${httpStatus}` : 'http_unknown',
            arxivId,
            queryId,
            sourceUrl,
            finalUrl: currentUrl,
            httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
        };
    }

    const rawBytes = Buffer.isBuffer(response.bytes)
        ? response.bytes
        : Buffer.isBuffer(response.data)
            ? response.data
            : typeof response.data === 'string'
                ? Buffer.from(response.data, 'utf8')
                : Buffer.alloc(0);

    if (rawBytes.length > maxBytes) {
        return {
            status: 'unavailable',
            reason: 'archive_too_large',
            arxivId,
            queryId,
            sourceUrl,
            finalUrl: currentUrl,
            httpStatus: 200,
        };
    }

    const contentType = getHeaderCaseInsensitive(response.headers, 'content-type');
    const unavailableReason = classifyUnavailablePayload(rawBytes, contentType);
    if (unavailableReason) {
        return {
            status: 'unavailable',
            reason: unavailableReason,
            arxivId,
            queryId,
            sourceUrl,
            finalUrl: currentUrl,
            httpStatus: 200,
            contentType,
            ...(rawBytes.length > 0 ? { archiveSha256: sha256(rawBytes) } : {}),
        };
    }

    const fetchedAt = (dependencies.now || (() => new Date().toISOString()))();
    return {
        status: 'ok',
        arxivId,
        queryId,
        sourceUrl,
        finalUrl: currentUrl,
        httpStatus: 200,
        contentType,
        bytes: rawBytes,
        archiveBytes: rawBytes.length,
        archiveSha256: sha256(rawBytes),
        fetchedAt,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Deterministic Sidecar Schema & Integrity Verification (Fail-Closed)
// ═══════════════════════════════════════════════════════════════════════════

function checkExactKeys(obj, requiredKeys, label, errors, optionalKeys = new Set()) {
    if (!isPlainObject(obj)) {
        errors.push(`${label} 必须是普通对象`);
        return false;
    }
    const keys = Object.keys(obj);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    for (const req of requiredKeys) {
        if (!Object.hasOwn(obj, req)) {
            errors.push(`${label} 缺少必填字段 ${req}`);
        }
    }
    for (const key of keys) {
        if (!allowed.has(key)) {
            errors.push(`${label} 包含未允许的字段 ${key}`);
        }
    }
    return errors.length === 0;
}

function validateArxivTexSidecar(sidecarOrPath, expected = {}) {
    const errors = [];
    let sidecar;

    if (typeof sidecarOrPath === 'string') {
        try {
            const bytes = readRegularFileBounded(
                sidecarOrPath,
                expected.maxSidecarBytes ?? DEFAULT_MAX_SIDECAR_BYTES,
                'TeX sidecar 文件'
            );
            sidecar = parseStrictJsonBytes(bytes, path.basename(sidecarOrPath));
        } catch (error) {
            return {
                valid: false,
                errors: [error.message],
                reason: error.message,
                sidecar: null,
            };
        }
    } else {
        sidecar = sidecarOrPath;
    }

    if (!isPlainObject(sidecar)) {
        errors.push('sidecar 必须是普通 JSON 对象');
        return { valid: false, errors, reason: errors[0], sidecar: null };
    }

    checkExactKeys(sidecar, REQUIRED_TOP_KEYS, 'sidecar', errors, OPTIONAL_TOP_KEYS);

    // Contract check
    if (sidecar.contract !== ARXIV_TEX_AST_CONTRACT) {
        errors.push(
            `contract 不匹配：期望 ${ARXIV_TEX_AST_CONTRACT}，实际 ${String(sidecar.contract)}`
        );
    }

    // arxivId check
    if (sidecar.arxivId !== null) {
        if (typeof sidecar.arxivId !== 'string' || !NORMALIZED_ARXIV_ID_RE.test(sidecar.arxivId)) {
            errors.push(`arxivId 格式非法：${String(sidecar.arxivId)}`);
        }
    }
    if (expected.arxivId !== undefined && expected.arxivId !== null) {
        let expectedNorm;
        try {
            expectedNorm = normalizeArxivId(expected.arxivId).arxivId;
        } catch (error) {
            errors.push(`期望 arxivId 非法：${error.message}`);
            expectedNorm = null;
        }
        if (expectedNorm !== null && sidecar.arxivId !== expectedNorm) {
            errors.push(`arxivId 漂移：期望 ${expectedNorm}，实际 ${String(sidecar.arxivId)}`);
        }
    }

    // Core scalar fields
    if (typeof sidecar.title !== 'string') errors.push('title 必须是字符串');
    if (typeof sidecar.abstract !== 'string') errors.push('abstract 必须是字符串');
    if (!ALLOWED_OVERALL_AFFIL_STATUSES.has(sidecar.authorAffiliationStatus)) {
        errors.push(`authorAffiliationStatus 非法：${String(sidecar.authorAffiliationStatus)}`);
    }
    if (!Array.isArray(sidecar.thanks) || sidecar.thanks.some(t => typeof t !== 'string')) {
        errors.push('thanks 必须是字符串数组');
    }

    // Authors
    if (!Array.isArray(sidecar.authors)) {
        errors.push('authors 必须是数组');
    } else {
        sidecar.authors.forEach((author, idx) => {
            const prefix = `authors[${idx}]`;
            checkExactKeys(author, REQUIRED_AUTHOR_KEYS, prefix, errors);
            if (!isPlainObject(author)) return;
            if (typeof author.name !== 'string' || !author.name.trim()) {
                errors.push(`${prefix}.name 必须是非空字符串`);
            }
            if (!Array.isArray(author.markers) || author.markers.some(m => typeof m !== 'string')) {
                errors.push(`${prefix}.markers 必须是字符串数组`);
            }
            if (!Array.isArray(author.affiliations) || author.affiliations.some(a => typeof a !== 'string')) {
                errors.push(`${prefix}.affiliations 必须是字符串数组`);
            }
            if (!Array.isArray(author.thanks) || author.thanks.some(t => typeof t !== 'string')) {
                errors.push(`${prefix}.thanks 必须是字符串数组`);
            }
            if (!ALLOWED_BINDING_STATUSES.has(author.bindingStatus)) {
                errors.push(`${prefix}.bindingStatus 非法：${String(author.bindingStatus)}`);
            } else if (Array.isArray(author.affiliations)) {
                // Cross-field author binding invariants (fail-closed)
                if (author.bindingStatus === 'ambiguous' && author.affiliations.length !== 0) {
                    errors.push(`${prefix} 为 ambiguous 状态时 affiliations 必须为空`);
                }
                if (author.bindingStatus === 'unmapped' && author.affiliations.length !== 0) {
                    errors.push(`${prefix} 为 unmapped 状态时 affiliations 必须为空`);
                }
                if (author.bindingStatus === 'bound' && author.affiliations.length === 0) {
                    errors.push(`${prefix} 为 bound 状态时 affiliations 不能为空`);
                }
            }
        });
    }

    // Affiliations
    if (!Array.isArray(sidecar.affiliations)) {
        errors.push('affiliations 必须是数组');
    } else {
        sidecar.affiliations.forEach((aff, idx) => {
            const prefix = `affiliations[${idx}]`;
            checkExactKeys(aff, REQUIRED_AFFILIATION_KEYS, prefix, errors);
            if (!isPlainObject(aff)) return;
            if (aff.marker !== null && typeof aff.marker !== 'string') {
                errors.push(`${prefix}.marker 必须是字符串或 null`);
            }
            if (typeof aff.text !== 'string' || !aff.text.trim()) {
                errors.push(`${prefix}.text 必须是非空字符串`);
            }
        });
    }

    // Cross-field overall authorAffiliationStatus invariants
    if (
        Array.isArray(sidecar.authors)
        && Array.isArray(sidecar.affiliations)
        && ALLOWED_OVERALL_AFFIL_STATUSES.has(sidecar.authorAffiliationStatus)
    ) {
        const statuses = sidecar.authors.map(a => (isPlainObject(a) ? a.bindingStatus : null));
        if (sidecar.authorAffiliationStatus === 'none' && sidecar.authors.length !== 0) {
            errors.push('authorAffiliationStatus 为 none 时 authors 必须为空');
        }
        if (sidecar.authorAffiliationStatus === 'bound') {
            if (sidecar.authors.length === 0 || statuses.some(s => s !== 'bound')) {
                errors.push('authorAffiliationStatus 为 bound 时所有作者都必须为 bound 状态');
            }
        }
        if (sidecar.authorAffiliationStatus === 'single_affiliation') {
            if (
                sidecar.authors.length === 0
                || sidecar.affiliations.length !== 1
                || statuses.some(s => s !== 'bound')
            ) {
                errors.push('authorAffiliationStatus 为 single_affiliation 时必须仅有 1 条机构且所有作者均已绑定');
            }
        }
        if (sidecar.authorAffiliationStatus === 'unmapped') {
            if (sidecar.authors.length === 0 || statuses.some(s => s !== 'unmapped')) {
                errors.push('authorAffiliationStatus 为 unmapped 时所有作者必须均为 unmapped 状态');
            }
        }
        if (sidecar.authorAffiliationStatus === 'ambiguous') {
            if (sidecar.authors.length === 0 || statuses.every(s => s === 'bound')) {
                errors.push('authorAffiliationStatus 为 ambiguous 时至少应有一位作者未确定绑定');
            }
        }
    }

    // Sections
    if (!Array.isArray(sidecar.sections)) {
        errors.push('sections 必须是数组');
    } else {
        let prevOffset = -1;
        sidecar.sections.forEach((sec, idx) => {
            const prefix = `sections[${idx}]`;
            checkExactKeys(sec, REQUIRED_SECTION_KEYS, prefix, errors);
            if (!isPlainObject(sec)) return;
            if (![1, 2, 3].includes(sec.level)) {
                errors.push(`${prefix}.level 必须为 1、2 或 3`);
            }
            if (typeof sec.title !== 'string') errors.push(`${prefix}.title 必须是字符串`);
            if (typeof sec.text !== 'string') errors.push(`${prefix}.text 必须是字符串`);
            if (!Number.isSafeInteger(sec.charOffset) || sec.charOffset < 0) {
                errors.push(`${prefix}.charOffset 必须是非负整数`);
            } else if (sec.charOffset < prevOffset) {
                errors.push(`${prefix}.charOffset 未单调递增`);
            } else {
                prevOffset = sec.charOffset;
            }
        });
    }

    // Tables
    if (!Array.isArray(sidecar.tables)) {
        errors.push('tables 必须是数组');
    } else {
        sidecar.tables.forEach((tbl, idx) => {
            const prefix = `tables[${idx}]`;
            checkExactKeys(tbl, REQUIRED_TABLE_KEYS, prefix, errors);
            if (!isPlainObject(tbl)) return;
            if (typeof tbl.caption !== 'string') errors.push(`${prefix}.caption 必须是字符串`);
            if (tbl.label !== null && typeof tbl.label !== 'string') {
                errors.push(`${prefix}.label 必须是字符串或 null`);
            }
            if (!Array.isArray(tbl.headers) || tbl.headers.some(h => typeof h !== 'string')) {
                errors.push(`${prefix}.headers 必须是字符串数组`);
            }
            if (
                !Array.isArray(tbl.rows)
                || tbl.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))
            ) {
                errors.push(`${prefix}.rows 必须是二维字符串数组`);
            }
        });
    }

    // Figures
    if (!Array.isArray(sidecar.figures)) {
        errors.push('figures 必须是数组');
    } else {
        sidecar.figures.forEach((fig, idx) => {
            const prefix = `figures[${idx}]`;
            checkExactKeys(fig, REQUIRED_FIGURE_KEYS, prefix, errors);
            if (!isPlainObject(fig)) return;
            if (typeof fig.caption !== 'string') errors.push(`${prefix}.caption 必须是字符串`);
            if (fig.label !== null && typeof fig.label !== 'string') {
                errors.push(`${prefix}.label 必须是字符串或 null`);
            }
            if (
                !Array.isArray(fig.graphicsPaths)
                || fig.graphicsPaths.some(p => typeof p !== 'string' || !p.trim())
            ) {
                errors.push(`${prefix}.graphicsPaths 必须是非空字符串数组`);
            }
        });
    }

    // Equations
    if (!Array.isArray(sidecar.equations)) {
        errors.push('equations 必须是数组');
    } else {
        sidecar.equations.forEach((eq, idx) => {
            const prefix = `equations[${idx}]`;
            checkExactKeys(eq, REQUIRED_EQUATION_KEYS, prefix, errors);
            if (!isPlainObject(eq)) return;
            if (typeof eq.environment !== 'string' || !eq.environment.trim()) {
                errors.push(`${prefix}.environment 必须是非空字符串`);
            }
            if (eq.label !== null && typeof eq.label !== 'string') {
                errors.push(`${prefix}.label 必须是字符串或 null`);
            }
            if (!Array.isArray(eq.labels) || eq.labels.some(l => typeof l !== 'string')) {
                errors.push(`${prefix}.labels 必须是字符串数组`);
            } else {
                const expectedPrimary = eq.labels[0] ?? null;
                if (eq.label !== expectedPrimary) {
                    errors.push(`${prefix}.label 必须与 labels[0] ?? null 一致`);
                }
            }
            if (typeof eq.latex !== 'string') errors.push(`${prefix}.latex 必须是字符串`);
            if (typeof eq.numbered !== 'boolean') errors.push(`${prefix}.numbered 必须是布尔值`);
        });
    }

    // Bibliography
    checkExactKeys(sidecar.bibliography, REQUIRED_BIBLIOGRAPHY_KEYS, 'bibliography', errors);
    if (isPlainObject(sidecar.bibliography)) {
        const bib = sidecar.bibliography;
        for (const intKey of ['bibitemCount', 'bibEntryCount', 'referenceCount']) {
            if (!Number.isSafeInteger(bib[intKey]) || bib[intKey] < 0) {
                errors.push(`bibliography.${intKey} 必须是非负整数`);
            }
        }
        if (
            !Array.isArray(bib.bibliographyFiles)
            || bib.bibliographyFiles.some(f => typeof f !== 'string' || !f.trim())
        ) {
            errors.push('bibliography.bibliographyFiles 必须是非空字符串数组');
        }
    }

    // Provenance & cryptographic bindings
    const prov = sidecar.provenance;
    checkExactKeys(prov, REQUIRED_PROVENANCE_KEYS, 'provenance', errors);
    if (isPlainObject(prov)) {
        if (prov.contract !== ARXIV_TEX_AST_CONTRACT) {
            errors.push(
                `provenance.contract 不匹配：期望 ${ARXIV_TEX_AST_CONTRACT}，实际 ${String(prov.contract)}`
            );
        }

        // Strict expected.archiveSha256 validation (never skip invalid/empty expected value!)
        if (Object.hasOwn(expected, 'archiveSha256') && expected.archiveSha256 !== undefined) {
            if (typeof expected.archiveSha256 !== 'string' || !SHA256_RE.test(expected.archiveSha256)) {
                errors.push(`期望 archiveSha256 格式非法：${String(expected.archiveSha256)}`);
            }
        }
        if (typeof prov.archiveSha256 !== 'string' || !SHA256_RE.test(prov.archiveSha256)) {
            errors.push('provenance.archiveSha256 必须是 64 位小写十六进制 SHA-256');
        } else if (
            Object.hasOwn(expected, 'archiveSha256')
            && expected.archiveSha256 !== undefined
            && SHA256_RE.test(String(expected.archiveSha256))
            && prov.archiveSha256 !== expected.archiveSha256
        ) {
            errors.push(
                `archiveSha256 漂移：期望 ${expected.archiveSha256}，实际 ${prov.archiveSha256}`
            );
        }

        // Strict expected.extractorSha256 validation + try/catch around getExtractorSha256
        let expectedExtractorSha = null;
        if (Object.hasOwn(expected, 'extractorSha256') && expected.extractorSha256 !== undefined) {
            if (typeof expected.extractorSha256 !== 'string' || !SHA256_RE.test(expected.extractorSha256)) {
                errors.push(`期望 extractorSha256 格式非法：${String(expected.extractorSha256)}`);
            } else {
                expectedExtractorSha = expected.extractorSha256;
            }
        } else {
            try {
                expectedExtractorSha = getExtractorSha256(expected.extractorScriptPath || PYTHON_EXTRACTOR_SCRIPT);
            } catch (error) {
                errors.push(`无法读取提取器以计算 extractorSha256：${error.message}`);
            }
        }

        if (typeof prov.extractorSha256 !== 'string' || !SHA256_RE.test(prov.extractorSha256)) {
            errors.push('provenance.extractorSha256 必须是 64 位小写十六进制 SHA-256');
        } else if (expectedExtractorSha && prov.extractorSha256 !== expectedExtractorSha) {
            errors.push(
                `extractorSha256 漂移：期望 ${expectedExtractorSha}，实际 ${prov.extractorSha256}`
            );
        }

        if (!ALLOWED_ARCHIVE_FORMATS.has(prov.archiveFormat)) {
            errors.push(`provenance.archiveFormat 非法：${String(prov.archiveFormat)}`);
        }
        if (
            !Number.isSafeInteger(prov.archiveBytes)
            || prov.archiveBytes < 1
            || prov.archiveBytes > DEFAULT_MAX_ARCHIVE_BYTES
        ) {
            errors.push(`provenance.archiveBytes 非法：${String(prov.archiveBytes)}`);
        }
        if (!isSafeRelativePosixPath(prov.rootTexFile)) {
            errors.push(`provenance.rootTexFile 路径非法：${String(prov.rootTexFile)}`);
        }
        if (
            !Array.isArray(prov.includedFiles)
            || prov.includedFiles.some(item => !isSafeRelativePosixPath(item))
        ) {
            errors.push('provenance.includedFiles 必须全部是安全相对 POSIX 路径');
        }
        if (
            !Number.isSafeInteger(prov.totalExpandedChars)
            || prov.totalExpandedChars < 0
            || prov.totalExpandedChars > DEFAULT_MAX_EXPANDED_CHARS
        ) {
            errors.push(`provenance.totalExpandedChars 必须是 0..${DEFAULT_MAX_EXPANDED_CHARS} 之间的整数`);
        }
        if (!Number.isSafeInteger(prov.strippedCommentsCount) || prov.strippedCommentsCount < 0) {
            errors.push('provenance.strippedCommentsCount 必须是非负整数');
        }
    }

    // Strict self-seal sidecarSha256 check (mandatory for disk files, requireSidecarSha256, or expected.sidecarSha256)
    const hasExpectedSidecarSha = Object.hasOwn(expected, 'sidecarSha256') && expected.sidecarSha256 !== undefined;
    if (hasExpectedSidecarSha && (typeof expected.sidecarSha256 !== 'string' || !SHA256_RE.test(expected.sidecarSha256))) {
        errors.push(`期望 sidecarSha256 格式非法：${String(expected.sidecarSha256)}`);
    }
    const requireSidecarSha = typeof sidecarOrPath === 'string'
        || expected.requireSidecarSha256 === true
        || hasExpectedSidecarSha;
    if (requireSidecarSha && !Object.hasOwn(sidecar, 'sidecarSha256')) {
        errors.push('sidecar 缺少必填自校验字段 sidecarSha256');
    }
    if (Object.hasOwn(sidecar, 'sidecarSha256')) {
        if (typeof sidecar.sidecarSha256 !== 'string' || !SHA256_RE.test(sidecar.sidecarSha256)) {
            errors.push('sidecarSha256 必须是 64 位小写十六进制 SHA-256');
        } else {
            const body = { ...sidecar };
            delete body.sidecarSha256;
            const recomputed = stableHash(body);
            if (sidecar.sidecarSha256 !== recomputed) {
                errors.push(
                    `sidecarSha256 校验不匹配（内容已篡改或漂移）：期望 ${recomputed}，实际 ${sidecar.sidecarSha256}`
                );
            } else if (
                hasExpectedSidecarSha
                && SHA256_RE.test(String(expected.sidecarSha256))
                && sidecar.sidecarSha256 !== expected.sidecarSha256
            ) {
                errors.push(
                    `sidecarSha256 漂移：期望 ${expected.sidecarSha256}，实际 ${sidecar.sidecarSha256}`
                );
            }
        }
    }

    if (errors.length > 0) {
        return {
            valid: false,
            errors,
            reason: errors[0],
            sidecar: null,
        };
    }

    const bodyForHash = { ...sidecar };
    delete bodyForHash.sidecarSha256;
    const computedSidecarSha256 = Object.hasOwn(sidecar, 'sidecarSha256')
        ? sidecar.sidecarSha256
        : stableHash(bodyForHash);

    return {
        valid: true,
        errors: [],
        reason: null,
        sidecar: cloneJson(sidecar),
        arxivId: sidecar.arxivId,
        archiveSha256: sidecar.provenance.archiveSha256,
        extractorSha256: sidecar.provenance.extractorSha256,
        sidecarSha256: computedSidecarSha256,
    };
}

function verifyArxivTexSidecar(sidecarOrPath, expected = {}) {
    const result = validateArxivTexSidecar(sidecarOrPath, expected);
    if (!result.valid) {
        if (expected.throwOnError === false) {
            return result;
        }
        throw new ArxivTexSidecarError(result.errors.join('；'), {
            errors: result.errors,
            reason: result.reason,
        });
    }
    return result;
}

function lstatOrNull(filePath) {
    try {
        return fs.lstatSync(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new ArxivTexSidecarError(`无法检查路径状态 ${filePath}：${error.code || error.message}`);
    }
}

function assertNoSealedManifestInAncestors(startDir) {
    let dir = startDir;
    while (true) {
        if (lstatOrNull(path.join(dir, 'source-manifest.json')) !== null) {
            throw new ArxivTexSidecarError(
                `禁止向包含 source-manifest.json 的封存目录或其子目录写入 TeX sidecar：${dir}`
            );
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
}

function assertSafeSidecarWriteTarget(sidecarPath) {
    if (typeof sidecarPath !== 'string' || !path.isAbsolute(sidecarPath) || sidecarPath.includes('\0')) {
        throw new ArxivTexSidecarError('sidecarPath 必须是安全绝对路径');
    }
    const resolved = path.resolve(sidecarPath);
    const parentDir = path.dirname(resolved);
    const posixResolved = resolved.split(path.sep).join('/');

    // Option A guard: never write sidecars into sealed 4-file source bundle directories
    if (SEALED_BUNDLE_PATH_RE.test(posixResolved)) {
        throw new ArxivTexSidecarError(
            `禁止向 4 文件封存来源目录写入 TeX sidecar（违反 Option A）：${resolved}`
        );
    }

    // Walk EVERY existing directory component from root down to parentDir (catches dangling symlinks too!)
    const rootDir = path.parse(parentDir).root;
    const relSegments = parentDir.slice(rootDir.length).split(path.sep).filter(Boolean);
    let current = rootDir;
    let lastExisting = rootDir;
    for (const seg of relSegments) {
        current = path.join(current, seg);
        const st = lstatOrNull(current);
        if (st === null) {
            break;
        }
        if (st.isSymbolicLink()) {
            const isDarwinSysLink = process.platform === 'darwin' && DARWIN_SYSTEM_SYMLINKS.has(current);
            if (!isDarwinSysLink) {
                throw new ArxivTexSidecarError(`sidecar 父路径包含符号链接（含悬空符号链接）：${current}`);
            }
        } else if (!st.isDirectory()) {
            throw new ArxivTexSidecarError(`sidecar 父路径包含非目录组件：${current}`);
        }
        lastExisting = current;
    }

    // Check realpath-resolved target against sealed bundle pattern AND check ALL ancestors for source-manifest.json
    let realExisting;
    try {
        realExisting = fs.realpathSync(lastExisting);
    } catch (error) {
        throw new ArxivTexSidecarError(`无法解析 sidecar 父目录真实路径：${error.code || error.message}`);
    }
    const realCombined = path.join(realExisting, path.relative(lastExisting, resolved)).split(path.sep).join('/');
    if (SEALED_BUNDLE_PATH_RE.test(realCombined)) {
        throw new ArxivTexSidecarError(
            `禁止经由目录路径向 4 文件封存来源目录写入 TeX sidecar：${resolved}`
        );
    }
    assertNoSealedManifestInAncestors(lastExisting);
    if (realExisting !== lastExisting) {
        assertNoSealedManifestInAncestors(realExisting);
    }

    // If target already exists (including dangling symlink!), require single-hardlink regular non-symlink file
    const targetStat = lstatOrNull(resolved);
    if (targetStat !== null) {
        if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink !== 1) {
            throw new ArxivTexSidecarError(
                `sidecar 目标已存在但不是单硬链接普通文件（拒绝覆盖符号链接/硬链接/目录）：${resolved}`
            );
        }
    }

    return resolved;
}

function writeArxivTexSidecar(sidecarPath, astOrSidecar, expected = {}) {
    const resolvedPath = assertSafeSidecarWriteTarget(sidecarPath);
    const verified = verifyArxivTexSidecar(astOrSidecar, expected);
    const body = { ...verified.sidecar };
    delete body.sidecarSha256;
    const sealed = {
        ...canonicalize(body),
        sidecarSha256: stableHash(body),
    };
    const rendered = `${JSON.stringify(canonicalize(sealed), null, 2)}\n`;
    writeFileAtomic(resolvedPath, rendered, { mode: 0o600 });
    return {
        sidecarPath: resolvedPath,
        sidecar: sealed,
        sidecarSha256: sealed.sidecarSha256,
        archiveSha256: sealed.provenance.archiveSha256,
        extractorSha256: sealed.provenance.extractorSha256,
    };
}

function readAndVerifyArxivTexSidecar(sidecarPath, expected = {}) {
    return verifyArxivTexSidecar(sidecarPath, { ...expected, requireSidecarSha256: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Node -> Python AST Extractor Bridge
// ═══════════════════════════════════════════════════════════════════════════

function parsePythonErrorJson(stderrText) {
    const trimmed = String(stderrText || '').trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed) && typeof parsed.error === 'string') {
            return { code: parsed.error, message: String(parsed.message || parsed.error) };
        }
    } catch {
        // Fallback: check last non-empty line in case stderr had warnings
        const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
        for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
            try {
                const parsed = JSON.parse(lines[idx]);
                if (isPlainObject(parsed) && typeof parsed.error === 'string') {
                    return { code: parsed.error, message: String(parsed.message || parsed.error) };
                }
            } catch {
                // ignore
            }
        }
    }
    return null;
}

async function extractArxivTexAst(input, options = {}, dependencies = {}) {
    const rawArxivId = options.arxivId ?? (isPlainObject(input) ? input.arxivId : null);
    const arxivId = rawArxivId ? normalizeArxivId(rawArxivId).arxivId : null;
    const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > DEFAULT_MAX_ARCHIVE_BYTES) {
        throw new ArxivTexSourceError(
            `maxArchiveBytes 必须是 1..${DEFAULT_MAX_ARCHIVE_BYTES} 之间的整数`,
            'INVALID_ARGUMENT'
        );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new ArxivTexSourceError(`timeoutMs 必须是正整数：${timeoutMs}`, 'INVALID_ARGUMENT');
    }
    const gracefulUnavailable = options.gracefulUnavailable !== false;

    // Pass through an already-unavailable fetch result gracefully
    if (isPlainObject(input) && input.status === 'unavailable') {
        return {
            status: 'unavailable',
            reason: String(input.reason || 'unavailable'),
            arxivId,
            ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
            ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        };
    }

    let bytes;
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        bytes = Buffer.from(input);
    } else if (isPlainObject(input) && (Buffer.isBuffer(input.bytes) || input.bytes instanceof Uint8Array)) {
        bytes = Buffer.from(input.bytes);
    } else if (isPlainObject(input) && typeof input.archivePath === 'string') {
        bytes = readRegularFileBounded(input.archivePath, maxArchiveBytes, 'arXiv TeX 归档');
    } else {
        throw new ArxivTexSourceError(
            'extractArxivTexAst 需要 Buffer/Uint8Array、{ bytes } 或 { archivePath }',
            'INVALID_INPUT'
        );
    }

    // Validate payload size up front BEFORE touching /tmp
    if (bytes.length > maxArchiveBytes) {
        throw new ArxivTexSourceError(
            `arXiv TeX 归档字节数 (${bytes.length}) 超过上限 (${maxArchiveBytes})`,
            'ARCHIVE_TOO_LARGE',
            { arxivId }
        );
    }

    const archiveSha256 = sha256(bytes);

    // Fast graceful PDF-only / HTML-only / empty detection before spawning Python
    const earlyUnavailable = classifyUnavailablePayload(bytes, isPlainObject(input) ? input.contentType : '');
    if (earlyUnavailable && gracefulUnavailable) {
        return {
            status: 'unavailable',
            reason: earlyUnavailable,
            arxivId,
            archiveSha256,
        };
    }
    if (bytes.length === 0) {
        throw new ArxivTexSourceError('arXiv TeX 归档为空', 'INVALID_ARCHIVE', { arxivId });
    }

    const extractorScript = dependencies.extractorScriptPath || PYTHON_EXTRACTOR_SCRIPT;
    const runtimeScript = dependencies.pythonRuntimeScript || PYTHON_RUNTIME_SCRIPT;
    const runExecFile = dependencies.execFileAsync || execFileAsync;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-tex-ast-'));
    const inputPath = path.join(tmpDir, 'payload.bin');
    const outputPath = path.join(tmpDir, 'ast.json');

    try {
        const fd = fs.openSync(
            inputPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600
        );
        try {
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }

        const cliArgs = [
            runtimeScript,
            extractorScript,
            '--input',
            inputPath,
            '--output',
            outputPath,
            '--max-archive-bytes',
            String(maxArchiveBytes),
        ];
        if (arxivId) {
            cliArgs.push('--arxiv-id', arxivId);
        }

        try {
            await runExecFile('bash', cliArgs, {
                cwd: PROJECT_ROOT,
                timeout: timeoutMs,
                maxBuffer: 16 * 1024 * 1024,
            });
        } catch (error) {
            const structured = parsePythonErrorJson(error?.stderr);
            if (structured) {
                if (structured.code === 'PDF_ONLY_PAYLOAD' && gracefulUnavailable) {
                    return {
                        status: 'unavailable',
                        reason: 'pdf_only',
                        arxivId,
                        archiveSha256,
                        detail: structured.message,
                    };
                }
                if (
                    (structured.code === 'UNSUPPORTED_PAYLOAD' || structured.code === 'NO_ROOT_TEX')
                    && gracefulUnavailable
                ) {
                    return {
                        status: 'unavailable',
                        reason: structured.code.toLowerCase(),
                        arxivId,
                        archiveSha256,
                        detail: structured.message,
                    };
                }
                throw new ArxivTexSourceError(structured.message, structured.code, {
                    arxivId,
                    archiveSha256,
                });
            }
            const detail = String(error?.stderr || error?.message || error).trim().slice(0, 1200);
            throw new ArxivTexSourceError(
                `arxiv_tex_extract.py 执行失败：${detail}`,
                'TEX_EXTRACTOR_EXEC_FAILED',
                { arxivId, archiveSha256 }
            );
        }

        const outBytes = readRegularFileBounded(outputPath, DEFAULT_MAX_SIDECAR_BYTES, 'AST 输出 JSON');
        const ast = parseStrictJsonBytes(outBytes, 'ast.json');
        const expectedExtractorSha = getExtractorSha256(extractorScript);

        // Seal sidecar deterministically and verify full contract + provenance + schema
        const sealedSidecar = {
            ...canonicalize(ast),
            sidecarSha256: stableHash(ast),
        };
        const verified = verifyArxivTexSidecar(sealedSidecar, {
            arxivId,
            archiveSha256,
            extractorSha256: expectedExtractorSha,
            extractorScriptPath: extractorScript,
        });

        return {
            status: 'ok',
            arxivId: verified.arxivId,
            archiveSha256: verified.archiveSha256,
            extractorSha256: verified.extractorSha256,
            sidecarSha256: verified.sidecarSha256,
            ast: canonicalize(ast),
            sidecar: verified.sidecar,
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 2 });
    }
}

async function fetchAndExtractArxivTexSidecar(rawArxivId, options = {}, dependencies = {}) {
    const fetched = await fetchArxivTexArchive(rawArxivId, options, dependencies);
    if (fetched.status !== 'ok') {
        return fetched;
    }
    const extracted = await extractArxivTexAst(fetched, options, dependencies);
    if (extracted.status !== 'ok') {
        return {
            ...extracted,
            sourceUrl: fetched.sourceUrl,
            finalUrl: fetched.finalUrl,
            httpStatus: fetched.httpStatus,
        };
    }
    let saved = null;
    if (options.sidecarPath) {
        saved = writeArxivTexSidecar(options.sidecarPath, extracted.sidecar, {
            arxivId: extracted.arxivId,
            archiveSha256: extracted.archiveSha256,
            extractorSha256: extracted.extractorSha256,
        });
    }
    return {
        ...extracted,
        sourceUrl: fetched.sourceUrl,
        finalUrl: fetched.finalUrl,
        fetchedAt: fetched.fetchedAt,
        ...(saved ? { sidecarPath: saved.sidecarPath } : {}),
    };
}

module.exports = {
    ARXIV_TEX_AST_CONTRACT,
    DEFAULT_MAX_ARCHIVE_BYTES,
    DEFAULT_MAX_SIDECAR_BYTES,
    DEFAULT_MAX_EXPANDED_CHARS,
    DEFAULT_FETCH_TIMEOUT_MS,
    DEFAULT_EXTRACT_TIMEOUT_MS,
    DEFAULT_MAX_REDIRECTS,
    MAX_ALLOWED_REDIRECTS,
    PYTHON_EXTRACTOR_SCRIPT,
    ArxivTexSourceError,
    ArxivTexProxyError,
    ArxivTexSidecarError,
    normalizeArxivId,
    getExtractorSha256,
    stableHash,
    fetchArxivTexArchive,
    extractArxivTexAst,
    validateArxivTexSidecar,
    verifyArxivTexSidecar,
    writeArxivTexSidecar,
    readAndVerifyArxivTexSidecar,
    fetchAndExtractArxivTexSidecar,
};
