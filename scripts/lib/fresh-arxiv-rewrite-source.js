'use strict';

// 保存日更和历史重写所需的 arXiv 官方来源。
// 它和 data/current、旧的新来源缓存都没有关系：
// 每个新 generation 都重新请求一份官方正文和一份原始 PDF。
// 长期保存的只有 source.txt、source.pdf、source-runtime.json、
// source-manifest.json 这四个文件供后续读取原始内容。图片字节只在一次回调里有效，
// 放在系统临时目录下，不管成功失败都会删掉。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTRACT = 'fresh-arxiv-rewrite-source-v1';
const VERSION = 2;
const EXTRACTOR_CONTRACT = 'deep-analyzer-official-arxiv-fulltext-v1';
const DEFAULT_EXTRACTOR_VERSION = 'arxiv-html-or-pdf-text-v1';
const MANIFEST_NAME = 'source-manifest.json';
const TEXT_NAME = 'source.txt';
const PDF_NAME = 'source.pdf';
const RUNTIME_METADATA_NAME = 'source-runtime.json';
const RUNTIME_METADATA_CONTRACT = 'fresh-arxiv-rewrite-runtime-metadata-v1';
const SOURCE_FILES = Object.freeze([MANIFEST_NAME, PDF_NAME, RUNTIME_METADATA_NAME, TEXT_NAME]);
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const ARXIV_SOURCE_ID_RE = /^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/;
const HISTORICAL_VERSION_CONTRACT = 'arxiv-historical-version-source-v1';
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;

class FreshArxivRewriteSourceError extends Error {
    constructor(message) {
        super(`arXiv 来源检查未通过：${message}`);
        this.name = 'FreshArxivRewriteSourceError';
        this.code = 'FRESH_ARXIV_REWRITE_SOURCE_INTEGRITY';
        this.retryable = false;
    }
}

const fail = message => { throw new FreshArxivRewriteSourceError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
function canonicalJson(value) { return `${JSON.stringify(canonical(value), null, 2)}\n`; }

function normalizedArxivId(value) {
    const id = String(value || '').trim().replace(/v\d+$/i, '');
    if (!ARXIV_ID_RE.test(id)) fail('arxivId 去掉版本号后必须是点号前四位、点号后四位或五位数字的 arXiv ID');
    return id;
}

function normalizedSourceId(value, arxivId, label = 'arXiv 来源 ID') {
    const sourceId = String(value || '').trim(); const canonicalId = normalizedArxivId(arxivId);
    if (!ARXIV_SOURCE_ID_RE.test(sourceId) || sourceId.replace(/v\d+$/i, '') !== canonicalId) {
        fail(`${label} 格式无效或指向另一篇论文`);
    }
    return sourceId;
}

function normalizedGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) {
        fail('generation 必须是 1 至 999999999 之间的安全整数');
    }
    return value;
}

function generationName(generation) {
    return `generation-${String(normalizedGeneration(generation)).padStart(6, '0')}`;
}

function asIso(value, label) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(`${label} 必须是与 Date.toISOString() 输出完全相同的时间字符串`);
    return value;
}

function nowIso(now) {
    const value = typeof now === 'function' ? now() : now === undefined ? new Date().toISOString() : now;
    return asIso(value, '来源抓取时间');
}

function safeDirectory(directory, create = false, label = '目录') {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对路径`);
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 不安全：路径中的某一项不是目录或是符号链接：${cursor}`);
    }
    return absolute;
}

function sourceDirectory(rootDir, arxivId, generation) {
    const root = path.resolve(rootDir);
    const id = normalizedArxivId(arxivId);
    return path.join(root, id, generationName(generation));
}

function readPrivateFile(filename, maxBytes, label) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > maxBytes) {
            fail(`${label} 不安全：必须是只有一个硬链接且大小不超过允许上限的普通文件`);
        }
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fail(`${label} 的文件权限必须是 0600`);
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writePrivateFile(directory, filename, bytes) {
    const target = path.join(directory, filename);
    const payload = Buffer.from(bytes);
    let fd;
    try {
        fd = fs.openSync(target,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
    let fd;
    try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
    catch (error) {
        // 少数平台不支持目录 fsync。
        // 单个文件 fsync 加上同目录改名，原子性仍然成立；
        // 别把别处真正的文件系统错误吞掉。
        if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function officialUrl(url, kind, arxivId, sourceId = null) {
    const id = normalizedArxivId(arxivId);
    const boundSourceId = sourceId ? normalizedSourceId(sourceId, id) : id;
    const requested = String(url || '').trim();
    const fallback = kind === 'pdf'
        ? `https://arxiv.org/pdf/${boundSourceId}.pdf`
        : `https://arxiv.org/html/${boundSourceId}`;
    const parsed = new URL(requested || fallback);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org' || parsed.port || parsed.username || parsed.password) {
        fail(`${kind} URL 必须使用官方 arxiv.org 的 HTTPS 地址，且不得带端口、用户名或密码`);
    }
    const pathname = decodeURIComponent(parsed.pathname);
    if (kind === 'pdf') {
        // arXiv 上两种官方写法都能访问，带版本的 `/pdf/<id>vN.pdf`
        // 请求可能被重定向到 `/pdf/<id>vN`。
        const match = pathname.match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)(?:\.pdf)?$/);
        if (!match || match[1].replace(/v\d+$/i, '') !== id || match[1] !== boundSourceId) {
            fail('PDF URL 的路径必须对应本次请求的 arXiv ID 和版本');
        }
    } else {
        const match = pathname.match(/^\/html\/(\d{4}\.\d{4,5})(v\d+)?\/?$/);
        if (!match || match[1] !== id) fail('正文 URL 的路径必须对应本次请求的 arXiv ID');
        // 无版本地址可能跳转到明确版本；只有双方都声明版本时才要求完全一致。
        if (match[2] && boundSourceId !== id && `${match[1]}${match[2]}` !== boundSourceId) {
            fail('HTML 来源地址的版本与来源 ID 不一致');
        }
    }
    if (parsed.search || parsed.hash) fail(`${kind} URL 不得包含查询参数或片段标识`);
    return parsed.toString();
}

function validateTextResponse(value, arxivId, capturedAt, extractorVersion) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('official text fetch returned no object');
    const source = value.source;
    if (!['html', 'pdf'].includes(source)) fail('official text fetch did not return HTML/PDF text');
    const text = String(value.text || '');
    const bytes = Buffer.from(text, 'utf8');
    if (!text || bytes.length > MAX_TEXT_BYTES) fail('official text response is empty or oversized');
    const sourceId = String(value.sourceId || arxivId);
    if (normalizedArxivId(sourceId) !== arxivId) fail('official text sourceId belongs to another paper');
    const url = officialUrl(value.url || (source === 'html'
        ? `https://arxiv.org/html/${sourceId}` : `https://arxiv.org/pdf/${arxivId}.pdf`), source === 'html' ? 'text' : 'pdf', arxivId, sourceId);
    const fetchedAt = value.fetchedAt === undefined ? capturedAt : asIso(value.fetchedAt, 'text fetchedAt');
    const responseSha256 = sha256(bytes);
    return { bytes, source, sourceId, url, fetchedAt, responseSha256,
        extractor: { contract: EXTRACTOR_CONTRACT, version: extractorVersion } };
}

function validatePdfResponse(value, arxivId, capturedAt) {
    const candidate = Buffer.isBuffer(value) || value instanceof Uint8Array ? { bytes: value } : value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('official PDF fetch returned no object');
    const bytes = Buffer.from(candidate.bytes || candidate.pdf || []);
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('official PDF response is missing a valid PDF header or exceeds the size limit');
    }
    let sourceId = String(candidate.sourceId || '').trim();
    if (!sourceId && candidate.url) {
        try { sourceId = decodeURIComponent(new URL(String(candidate.url)).pathname)
            .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)(?:\.pdf)?$/)?.[1] || ''; }
        catch { /* 真正的拒绝由下面的 officialUrl 发出 */ }
    }
    sourceId = normalizedSourceId(sourceId || arxivId, arxivId, 'official PDF source ID');
    const url = officialUrl(candidate.url, 'pdf', arxivId, sourceId);
    const versioned = sourceId !== arxivId;
    if (versioned && (candidate.currentPdfUnavailable !== true || candidate.currentPdfStatus !== 404)) {
        fail('versioned PDF requires a sealed current unversioned PDF HTTP 404 observation');
    }
    if (!versioned && (candidate.currentPdfUnavailable === true || candidate.currentPdfStatus !== undefined
        && candidate.currentPdfStatus !== null)) fail('current PDF cannot claim historical-version fallback');
    const fetchedAt = candidate.fetchedAt === undefined ? capturedAt : asIso(candidate.fetchedAt, 'PDF fetchedAt');
    return { bytes, url, sourceId, fetchedAt, responseSha256: sha256(bytes),
        currentPdfUnavailable: versioned, currentPdfStatus: versioned ? 404 : null };
}

function historicalVersionWarning(identity) {
    return `arXiv 当前无版本 PDF ${identity.attemptedCurrentPdfUrl} 返回 HTTP 404，当前稿不可用；本次只封存并分析官方历史版本 ${identity.selectedSourceId}（${identity.selectedPdfUrl}），不得暗示当前稿仍有效。`;
}
function historicalVersionIdentity({ arxivId, textSourceId, pdf, warnings = [] } = {}) {
    const id = normalizedArxivId(arxivId); const selectedSourceId = normalizedSourceId(pdf?.sourceId || id, id);
    if (selectedSourceId === id) return null;
    if (pdf.currentPdfUnavailable !== true || pdf.currentPdfStatus !== 404
        || normalizedSourceId(textSourceId, id, 'versioned text source ID') !== selectedSourceId) {
        fail('historical-version text/PDF/current-unavailable identity is incomplete or mixed');
    }
    const body = { contract: HISTORICAL_VERSION_CONTRACT, version: 1, canonicalArxivId: id,
        selectedSourceId, textSourceId: selectedSourceId, selectedPdfUrl: officialUrl(pdf.url, 'pdf', id, selectedSourceId),
        currentPdfAvailable: false, attemptedCurrentPdfStatus: 404,
        attemptedCurrentPdfUrl: officialUrl('', 'pdf', id, id) };
    const warning = historicalVersionWarning(body);
    if (warnings.length && !warnings.includes(warning)) fail('historical-version current-unavailable warning is missing');
    const sealed = { ...body, warning };
    return { ...sealed, identitySha256: sha256(JSON.stringify(canonical(sealed))) };
}
function normalizeHistoricalVersionIdentity(value, arxivId) {
    const fields = ['contract', 'version', 'canonicalArxivId', 'selectedSourceId', 'textSourceId', 'selectedPdfUrl',
        'currentPdfAvailable', 'attemptedCurrentPdfStatus', 'attemptedCurrentPdfUrl', 'warning', 'identitySha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')) fail('historical-version identity schema is invalid');
    const id = normalizedArxivId(arxivId); const selected = normalizedSourceId(value.selectedSourceId, id);
    const body = { contract: HISTORICAL_VERSION_CONTRACT, version: 1, canonicalArxivId: id,
        selectedSourceId: selected, textSourceId: normalizedSourceId(value.textSourceId, id),
        selectedPdfUrl: officialUrl(value.selectedPdfUrl, 'pdf', id, selected), currentPdfAvailable: false,
        attemptedCurrentPdfStatus: 404, attemptedCurrentPdfUrl: officialUrl(value.attemptedCurrentPdfUrl, 'pdf', id, id) };
    const warning = historicalVersionWarning(body); const sealed = { ...body, warning };
    if (selected === id || value.contract !== HISTORICAL_VERSION_CONTRACT || value.version !== 1
        || value.canonicalArxivId !== id || value.textSourceId !== selected || value.currentPdfAvailable !== false
        || value.attemptedCurrentPdfStatus !== 404 || value.warning !== warning
        || value.identitySha256 !== sha256(JSON.stringify(canonical(sealed)))) {
        fail('historical-version identity evidence/SHA drifted');
    }
    return { ...sealed, identitySha256: value.identitySha256 };
}

// 结构化来源证据只以 JSON 元数据的形式长期保存。
// 它可以带表格/公式的 DOM 绑定和图片链接，
// 但不能带图片像素、缓存路径、base64 或临时文件名。
// 每次直接分析/Reader 都重新把像素取到系统临时目录的回调里。
function fallbackArtifacts(text) {
    const body = { version: 1, source: 'fresh_arxiv_text_without_layout',
        tables: [], formulas: [], figures: [], flattenedTextSha256: text.responseSha256 };
    return { ...body, payloadSha256: sha256(JSON.stringify(body)) };
}
function sourceTitle(value, fallbackText = '') {
    const candidate = String(value || '').replace(/\r\n?/g, '\n').split('\n')
        .map(item => item.replace(/\s+/g, ' ').trim()).find(Boolean)
        || String(fallbackText || '').replace(/\r\n?/g, '\n').split('\n')
            .map(item => item.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    // 这是来源元数据，不是模型标题也不是旧页面标题。
    // 保存前截断长度，防止走形的 HTML 首行把每个运行时来源包撑大。
    // 标题缺失就明确写无，不猜。
    return candidate.slice(0, 2000);
}
function assertNoPersistentImageBytes(value, label = 'runtime metadata') {
    const forbidden = new Set(['cachePath', 'tempPath', 'rawBytes', 'assetBytes', 'base64', 'buffer',
        'assetFilename', 'assetMediaType', 'assetWidth', 'assetHeight', 'dataUri']);
    const inspect = (entry, pathLabel) => {
        if (Array.isArray(entry)) return entry.forEach((item, index) => inspect(item, `${pathLabel}[${index}]`));
        if (!entry || typeof entry !== 'object') return;
        for (const [key, item] of Object.entries(entry)) {
            if (forbidden.has(key)) fail(`${label} contains persistent image field ${pathLabel}.${key}`);
            inspect(item, `${pathLabel}.${key}`);
        }
    };
    inspect(value, label);
    return value;
}
function runtimeDetailsFromFreshCapture(rawText, text, arxivId) {
    return {
        paperId: `arxiv:${arxivId}`,
        title: sourceTitle(rawText?.title, text.bytes.toString('utf8')),
        source: text.source,
        sourceId: text.sourceId,
        text: text.bytes.toString('utf8'),
        imageInfos: Array.isArray(rawText?.imageInfos) ? structuredClone(rawText.imageInfos) : [],
        structuredArtifacts: rawText?.structuredArtifacts && typeof rawText.structuredArtifacts === 'object'
            ? structuredClone(rawText.structuredArtifacts) : fallbackArtifacts(text),
        readerAuthors: rawText?.readerAuthors && typeof rawText.readerAuthors === 'object'
            ? structuredClone(rawText.readerAuthors) : null,
        htmlAvailability: rawText?.htmlAvailability || (text.source === 'html' ? 'available' : 'not_applicable'),
        htmlAttempts: Number.isSafeInteger(rawText?.htmlAttempts) ? rawText.htmlAttempts : 0,
        warnings: Array.isArray(rawText?.warnings) ? rawText.warnings.map(String) : [],
        ...(rawText?.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(rawText.sourceVersion, arxivId) } : {})
    };
}
function runtimeMetadataFromDetails(details, text, arxivId) {
    const metadata = { contract: RUNTIME_METADATA_CONTRACT, version: 1, paperId: `arxiv:${arxivId}`,
        title: sourceTitle(details.title), textSha256: text.responseSha256, structuredArtifacts: clone(details.structuredArtifacts),
        imageInfos: clone(details.imageInfos), readerAuthors: details.readerAuthors === null ? null : clone(details.readerAuthors),
        htmlAvailability: String(details.htmlAvailability || ''), htmlAttempts: details.htmlAttempts,
        warnings: Array.isArray(details.warnings) ? details.warnings.map(String) : [],
        ...(details.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(details.sourceVersion, arxivId) } : {}) };
    // 可重放原 HTML 是本地作者证据。总运行元数据预算不够时不封存它，
    // 后续只能明确说明机构不可得，不能用旧解析数组替代原文。
    if (metadata.readerAuthors?.sourceHtml
        && (!require('./reader-author-parser.js').canRetainAuthorSourceHtml(metadata.readerAuthors.sourceHtml)
            || Buffer.byteLength(canonicalJson(metadata), 'utf8') > MAX_TEXT_BYTES)) {
        delete metadata.readerAuthors.sourceHtml;
    }
    if (Buffer.byteLength(canonicalJson(metadata), 'utf8') > MAX_TEXT_BYTES) fail('runtime metadata exceeds 64 MiB');
    return assertNoPersistentImageBytes(metadata);
}
function validateRuntimeMetadata(metadata, text, arxivId) {
    const keys = ['contract', 'htmlAttempts', 'htmlAvailability', 'imageInfos', 'paperId', 'readerAuthors',
        'structuredArtifacts', 'textSha256', 'title', 'version', 'warnings',
        ...(Object.hasOwn(metadata || {}, 'sourceVersion') ? ['sourceVersion'] : [])];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).sort().join('\0') !== keys.sort().join('\0')
        || metadata.contract !== RUNTIME_METADATA_CONTRACT || metadata.version !== 1
        || metadata.paperId !== `arxiv:${arxivId}` || metadata.textSha256 !== text.responseSha256
        || typeof metadata.title !== 'string' || metadata.title !== sourceTitle(metadata.title)
        || !metadata.structuredArtifacts || typeof metadata.structuredArtifacts !== 'object' || Array.isArray(metadata.structuredArtifacts)
        || !Array.isArray(metadata.imageInfos) || !Array.isArray(metadata.warnings)
        || !Number.isSafeInteger(metadata.htmlAttempts) || metadata.htmlAttempts < 0
        || typeof metadata.htmlAvailability !== 'string'
        || (metadata.readerAuthors !== null && (!metadata.readerAuthors || typeof metadata.readerAuthors !== 'object' || Array.isArray(metadata.readerAuthors)))) {
        fail('runtime metadata is invalid');
    }
    assertNoPersistentImageBytes(metadata);
    if (metadata.sourceVersion) {
        const identity = normalizeHistoricalVersionIdentity(metadata.sourceVersion, arxivId);
        if (!metadata.warnings.includes(identity.warning)) fail('runtime historical-version warning is not bound to its evidence');
    }
    return metadata;
}
function runtimeDetailsFromMetadata(metadata, text, arxivId) {
    const verified = validateRuntimeMetadata(metadata, text, arxivId);
    return { paperId: `arxiv:${arxivId}`, title: verified.title, source: text.source, sourceId: text.sourceId,
        text: text.bytes.toString('utf8'), imageInfos: clone(verified.imageInfos),
        structuredArtifacts: clone(verified.structuredArtifacts), readerAuthors: verified.readerAuthors === null ? null : clone(verified.readerAuthors),
        htmlAvailability: verified.htmlAvailability, htmlAttempts: verified.htmlAttempts, warnings: verified.warnings.map(String),
        ...(verified.sourceVersion ? { sourceVersion: normalizeHistoricalVersionIdentity(verified.sourceVersion, arxivId) } : {}) };
}

function manifestFor({ arxivId, generation, capturedAt, text, pdf, runtimeMetadataBytes }) {
    return {
        contract: CONTRACT,
        version: VERSION,
        arxivId,
        paperId: `arxiv:${arxivId}`,
        generation,
        capturedAt,
        text: {
            filename: TEXT_NAME,
            source: text.source,
            sourceId: text.sourceId,
            url: text.url,
            fetchedAt: text.fetchedAt,
            extractor: text.extractor,
            responseSha256: text.responseSha256,
            responseBytes: text.bytes.length
        },
        runtimeMetadata: { filename: RUNTIME_METADATA_NAME, responseSha256: sha256(runtimeMetadataBytes),
            responseBytes: runtimeMetadataBytes.length },
        pdf: {
            filename: PDF_NAME,
            url: pdf.url,
            fetchedAt: pdf.fetchedAt,
            responseSha256: pdf.responseSha256,
            responseBytes: pdf.bytes.length
        }
    };
}

function validateManifest(manifest, arxivId, generation) {
    const keys = ['arxivId', 'capturedAt', 'contract', 'generation', 'paperId', 'pdf', 'runtimeMetadata', 'text', 'version'];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || Object.keys(manifest).sort().join('\0') !== keys.join('\0')
        || manifest.contract !== CONTRACT || manifest.version !== VERSION
        || manifest.arxivId !== arxivId || manifest.paperId !== `arxiv:${arxivId}`
        || manifest.generation !== generation) fail('source manifest identity is invalid');
    asIso(manifest.capturedAt, 'manifest capture time');
    const text = manifest.text; const pdf = manifest.pdf; const runtimeMetadata = manifest.runtimeMetadata;
    const textKeys = ['extractor', 'fetchedAt', 'filename', 'responseBytes', 'responseSha256', 'source', 'sourceId', 'url'];
    const pdfKeys = ['fetchedAt', 'filename', 'responseBytes', 'responseSha256', 'url'];
    if (!text || typeof text !== 'object' || Array.isArray(text)
        || Object.keys(text).sort().join('\0') !== textKeys.join('\0')
        || !['html', 'pdf'].includes(text.source) || text.filename !== TEXT_NAME
        || normalizedArxivId(text.sourceId) !== arxivId || !Number.isSafeInteger(text.responseBytes)
        || text.responseBytes < 1 || text.responseBytes > MAX_TEXT_BYTES || !SHA_RE.test(text.responseSha256)
        || !text.extractor || typeof text.extractor !== 'object' || Array.isArray(text.extractor)
        || Object.keys(text.extractor).sort().join('\0') !== ['contract', 'version'].join('\0')
        || text.extractor.contract !== EXTRACTOR_CONTRACT || typeof text.extractor.version !== 'string' || !text.extractor.version) {
        fail('text manifest is invalid');
    }
    officialUrl(text.url, text.source === 'html' ? 'text' : 'pdf', arxivId, text.sourceId);
    asIso(text.fetchedAt, 'text fetchedAt');
    if (!pdf || typeof pdf !== 'object' || Array.isArray(pdf)
        || Object.keys(pdf).sort().join('\0') !== pdfKeys.join('\0') || pdf.filename !== PDF_NAME
        || !Number.isSafeInteger(pdf.responseBytes) || pdf.responseBytes < 5 || pdf.responseBytes > MAX_PDF_BYTES
        || !SHA_RE.test(pdf.responseSha256)) fail('PDF manifest is invalid');
    let pdfSourceId;
    try { pdfSourceId = decodeURIComponent(new URL(pdf.url).pathname)
        .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)(?:\.pdf)?$/)?.[1]; }
    catch { /* 真正的拒绝由 officialUrl 发出 */ }
    officialUrl(pdf.url, 'pdf', arxivId, pdfSourceId || arxivId); asIso(pdf.fetchedAt, 'PDF fetchedAt');
    if (!runtimeMetadata || typeof runtimeMetadata !== 'object' || Array.isArray(runtimeMetadata)
        || Object.keys(runtimeMetadata).sort().join('\0') !== ['filename', 'responseBytes', 'responseSha256'].join('\0')
        || runtimeMetadata.filename !== RUNTIME_METADATA_NAME || !Number.isSafeInteger(runtimeMetadata.responseBytes)
        || runtimeMetadata.responseBytes < 2 || runtimeMetadata.responseBytes > MAX_TEXT_BYTES
        || !SHA_RE.test(runtimeMetadata.responseSha256)) fail('runtime metadata manifest is invalid');
    return manifest;
}

function readFreshArxivRewriteSource({ rootDir, arxivId, generation } = {}) {
    const root = safeDirectory(rootDir, false, '来源根目录');
    const id = normalizedArxivId(arxivId); const normalized = normalizedGeneration(generation);
    const directory = sourceDirectory(root, id, normalized);
    safeDirectory(path.join(root, id), false, '论文来源目录');
    safeDirectory(directory, false, '本次来源获取序号对应的目录');
    const entries = fs.readdirSync(directory).sort();
    if (entries.join('\0') !== SOURCE_FILES.slice().sort().join('\0')) fail('generation source directory contains unexpected files');
    const manifestBytes = readPrivateFile(path.join(directory, MANIFEST_NAME), 1024 * 1024, 'source manifest');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch (error) { fail(`source manifest is invalid JSON: ${error.message}`); }
    if (!manifestBytes.equals(Buffer.from(canonicalJson(manifest), 'utf8'))) fail('source manifest must be canonical JSON');
    validateManifest(manifest, id, normalized);
    const text = readPrivateFile(path.join(directory, TEXT_NAME), MAX_TEXT_BYTES, 'source text');
    const pdf = readPrivateFile(path.join(directory, PDF_NAME), MAX_PDF_BYTES, 'source PDF');
    const runtimeMetadataBytes = readPrivateFile(path.join(directory, RUNTIME_METADATA_NAME), MAX_TEXT_BYTES, 'runtime metadata');
    if (text.length !== manifest.text.responseBytes || sha256(text) !== manifest.text.responseSha256) fail('source text drifted from manifest');
    if (pdf.length !== manifest.pdf.responseBytes || sha256(pdf) !== manifest.pdf.responseSha256
        || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') fail('source PDF drifted from manifest');
    if (runtimeMetadataBytes.length !== manifest.runtimeMetadata.responseBytes
        || sha256(runtimeMetadataBytes) !== manifest.runtimeMetadata.responseSha256) fail('runtime metadata drifted from manifest');
    let runtimeMetadata;
    try { runtimeMetadata = JSON.parse(runtimeMetadataBytes.toString('utf8')); }
    catch (error) { fail(`runtime metadata is invalid JSON: ${error.message}`); }
    if (!runtimeMetadataBytes.equals(Buffer.from(canonicalJson(runtimeMetadata), 'utf8'))) fail('runtime metadata must be canonical JSON');
    const pdfSourceId = decodeURIComponent(new URL(manifest.pdf.url).pathname)
        .match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)(?:\.pdf)?$/)?.[1] || '';
    if (pdfSourceId !== id) {
        const identity = normalizeHistoricalVersionIdentity(runtimeMetadata.sourceVersion, id);
        if (identity.selectedSourceId !== pdfSourceId || manifest.text.source !== 'pdf'
            || manifest.text.sourceId !== pdfSourceId) fail('versioned PDF source is mixed with another text version');
    } else if (runtimeMetadata.sourceVersion !== undefined) {
        fail('current PDF bundle cannot carry historical-version evidence');
    }
    const textInfo = { source: manifest.text.source, sourceId: manifest.text.sourceId, bytes: text,
        responseSha256: manifest.text.responseSha256 };
    const runtimeDetails = runtimeDetailsFromMetadata(runtimeMetadata, textInfo, id);
    return { rootDir: root, directory, arxivId: id, generation: normalized,
        sourceManifestSha256: sha256(manifestBytes), manifest: clone(manifest), runtimeDetails,
        text: text.toString('utf8'), textBytes: text, pdf: Buffer.from(pdf) };
}

function generationExists(rootDir, arxivId, generation) {
    return fs.existsSync(sourceDirectory(rootDir, arxivId, generation));
}

function defaultFetchText(arxivId) {
    // 别让正文适配器自己去下备用 PDF。
    // 抓取只发一次原始 PDF 请求，把拿到的字节原样存好；
    // HTML 不可用时，把这份字节交给提取器。
    return require('../deep-analyzer.js').fetchArxivHtmlTextDetailedUncached(arxivId);
}
function defaultFetchPdf(arxivId) {
    return require('../deep-analyzer.js').fetchArxivPdfUncached(arxivId);
}
function defaultFetchFigure(url) {
    return require('../deep-analyzer.js').fetchArxivFigureBytesUncached(url);
}
const EPHEMERAL_FIGURE_FETCH_MAX_ATTEMPTS = 3;
const EPHEMERAL_FIGURE_TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
    'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT'
]);
function isTransientEphemeralFigureFetchError(error) {
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    const message = `${String(error?.message || error || '')} ${String(error?.cause?.message || '')}`;
    const status = Number.parseInt(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] || '', 10);
    return error?.retryable === true || EPHEMERAL_FIGURE_TRANSIENT_CODES.has(code)
        || [408, 425, 429].includes(status) || status >= 500
        || /(?:fetch failed|socket hang up|network|timed?\s*out|timeout|dns|connection reset)/i.test(message);
}
async function fetchEphemeralFigureWithRetry(fetchFigure, url, options = {}) {
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 1; attempt <= EPHEMERAL_FIGURE_FETCH_MAX_ATTEMPTS; attempt++) {
        try { return await fetchFigure(url); }
        catch (error) {
            if (!isTransientEphemeralFigureFetchError(error)) throw error;
            if (attempt < EPHEMERAL_FIGURE_FETCH_MAX_ATTEMPTS) {
                await sleep(attempt * 1000);
                continue;
            }
            const failure = error instanceof Error ? error : new Error(String(error || 'ephemeral Figure fetch failed'));
            failure.retryable = true;
            failure.ephemeralFigureFetch = true;
            failure.attempts = attempt;
            if (!failure.code) failure.code = 'EPHEMERAL_FIGURE_FETCH_TRANSIENT';
            throw failure;
        }
    }
    throw new Error('ephemeral Figure fetch retry loop ended unexpectedly');
}
function defaultExtractPdfText(arxivId, bytes, options) {
    return require('../deep-analyzer.js').extractArxivPdfTextDetailedFromBytes(arxivId, bytes, options);
}

function temporaryGenerationDirectory(parent, name) {
    const temporary = path.join(parent, `.${name}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    return temporary;
}

function removeOwnedTemporaryDirectory(directory) {
    if (!directory || !path.basename(directory).startsWith('.generation-') || !path.basename(directory).endsWith('.tmp')) {
        fail('refuses to remove a non-owned temporary source directory');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
}

async function captureFreshArxivRewriteSource(options = {}, overrides = {}) {
    const root = safeDirectory(options.rootDir || require('../config.js').FILES.freshArxivFetchedSourcesDir, true, '来源根目录');
    const id = normalizedArxivId(options.arxivId); const generation = normalizedGeneration(options.generation);
    const target = sourceDirectory(root, id, generation);
    if (fs.existsSync(target)) {
        const stored = readFreshArxivRewriteSource({ rootDir: root, arxivId: id, generation });
        return { ...stored, status: 'recovered', fetched: false };
    }
    const paperDirectory = path.join(root, id); safeDirectory(paperDirectory, true, '论文来源目录');
    const capturedAt = nowIso(options.now);
    const fetchText = overrides.fetchText || defaultFetchText;
    const fetchPdf = overrides.fetchPdf || defaultFetchPdf;
    const extractPdfText = overrides.extractPdfText || defaultExtractPdfText;
    if (typeof fetchText !== 'function' || typeof fetchPdf !== 'function' || typeof extractPdfText !== 'function') {
        fail('official HTML text, PDF, and PDF-text extractors are required');
    }
    const extractorVersion = String(options.extractorVersion || DEFAULT_EXTRACTOR_VERSION).trim();
    if (!extractorVersion || extractorVersion.length > 200) fail('extractorVersion is invalid');
    let temporary = null;
    try {
        // 先解析 HTML，这样 PDF 回退时能优先用选定的官方版本。
        // 无版本当前稿 PDF 仍先探一次，
        // 版本回退才有可重放的 HTTP 404 记录。
        const rawText = await fetchText(id);
        const preferredSourceId = rawText?.source === 'html' ? rawText.sourceId : null;
        const rawPdf = await fetchPdf(id, { preferredSourceId });
        const pdf = validatePdfResponse(rawPdf, id, capturedAt);
        const sourceVersion = historicalVersionIdentity({ arxivId: id,
            textSourceId: pdf.sourceId, pdf });
        let text; let runtimeSource = rawText;
        if (rawText?.source === 'html' && !sourceVersion) {
            text = validateTextResponse(rawText, id, capturedAt, extractorVersion);
        } else {
            // fetchText 如果返回 PDF 文本，
            // 说明适配器丢掉了 PDF 字节，或自己另下了一份。
            // 只有一种回退是允许的：从 `pdf.bytes` 提取，
            // 也就是下面存起来的那一份响应。
            if (rawText?.source === 'pdf') fail('HTML text adapter must not fetch an independent PDF fallback');
            const extracted = await extractPdfText(id, pdf.bytes, {
                htmlAvailability: rawText?.htmlAvailability || 'unavailable',
                htmlAttempts: rawText?.htmlAttempts || 0,
                warnings: Array.isArray(rawText?.warnings) ? rawText.warnings.slice() : [],
                url: pdf.url,
                fetchedAt: pdf.fetchedAt,
                sourceId: pdf.sourceId
            });
            const versionNotice = sourceVersion ? `【来源版本警告】${sourceVersion.warning}\n\n` : '';
            text = validateTextResponse({ ...extracted, text: `${versionNotice}${String(extracted?.text || '')}`,
                source: 'pdf', sourceId: pdf.sourceId,
                url: pdf.url, fetchedAt: pdf.fetchedAt }, id, capturedAt, extractorVersion);
            // 有匹配的历史版本 HTML 就用它的标题，
            // 不然从去掉警告前缀的 PDF 文本里取。
            // 强制加的警告前缀绝不能变成标题。
            const versionTitle = rawText?.sourceId === pdf.sourceId && rawText?.title
                ? rawText.title : (extracted?.title || sourceTitle('', extracted?.text));
            runtimeSource = { title: versionTitle, source: 'pdf', sourceId: pdf.sourceId,
                imageInfos: [], structuredArtifacts: null, readerAuthors: null,
                htmlAvailability: rawText?.htmlAvailability || 'unavailable',
                htmlAttempts: Number.isSafeInteger(rawText?.htmlAttempts) ? rawText.htmlAttempts : 0,
                warnings: [...(Array.isArray(rawText?.warnings) ? rawText.warnings.map(String) : []),
                    ...(sourceVersion ? [sourceVersion.warning] : [])],
                ...(sourceVersion ? { sourceVersion } : {}) };
        }
        const runtimeDetails = runtimeDetailsFromFreshCapture(runtimeSource, text, id);
        const runtimeMetadataBytes = Buffer.from(canonicalJson(runtimeMetadataFromDetails(runtimeDetails, text, id)), 'utf8');
        const manifest = manifestFor({ arxivId: id, generation, capturedAt, text, pdf, runtimeMetadataBytes });
        temporary = temporaryGenerationDirectory(paperDirectory, generationName(generation));
        writePrivateFile(temporary, TEXT_NAME, text.bytes);
        writePrivateFile(temporary, PDF_NAME, pdf.bytes);
        writePrivateFile(temporary, RUNTIME_METADATA_NAME, runtimeMetadataBytes);
        writePrivateFile(temporary, MANIFEST_NAME, Buffer.from(canonicalJson(manifest), 'utf8'));
        fsyncDirectory(temporary);
        if (typeof overrides.beforeCommit === 'function') await overrides.beforeCommit({ temporary, target, manifest: clone(manifest) });
        try { fs.renameSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        }
        if (fs.existsSync(temporary)) removeOwnedTemporaryDirectory(temporary);
        temporary = null;
        fsyncDirectory(paperDirectory);
        const stored = readFreshArxivRewriteSource({ rootDir: root, arxivId: id, generation });
        return { ...stored, status: 'captured', fetched: true };
    } catch (error) {
        if (temporary && fs.existsSync(temporary)) removeOwnedTemporaryDirectory(temporary);
        throw error;
    }
}

function pathInside(root, candidate) {
    const base = path.resolve(root); const target = path.resolve(candidate);
    return target === base || target.startsWith(`${base}${path.sep}`);
}

function canonicalExistingAncestor(candidate) {
    let cursor = path.resolve(candidate); const suffix = [];
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('path has no existing filesystem ancestor');
        suffix.unshift(path.basename(cursor)); cursor = parent;
    }
    return path.join(fs.realpathSync(cursor), ...suffix);
}

function officialFigureUrl(value, arxivId) {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org' || parsed.port || parsed.username || parsed.password
        || parsed.search || parsed.hash || !parsed.pathname.startsWith('/html/')) {
        fail('figure URL must be a direct official arXiv HTML HTTPS URL');
    }
    const match = decodeURIComponent(parsed.pathname).match(/^\/html\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\/|$)/);
    if (!match || match[1] !== normalizedArxivId(arxivId)) fail('figure URL belongs to another paper');
    return parsed.toString();
}

function normalizeFigureResponse(value) {
    const candidate = Buffer.isBuffer(value) || value instanceof Uint8Array ? { bytes: value } : value;
    const bytes = Buffer.from(candidate?.bytes || []);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) fail('ephemeral figure bytes are empty or oversized');
    const mediaType = String(candidate?.mediaType || 'application/octet-stream').toLowerCase();
    if (!/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(mediaType)) fail('ephemeral figure media type is unsupported');
    return { bytes, mediaType };
}

async function withEphemeralArxivFigures(options = {}, callback, overrides = {}) {
    if (typeof callback !== 'function') fail('ephemeral figure callback is required');
    const id = normalizedArxivId(options.arxivId);
    const figures = Array.isArray(options.figures) ? options.figures : fail('figures must be an array');
    const ordinalSet = new Set();
    const normalizedFigures = figures.map((figure, index) => {
        if (!figure || typeof figure !== 'object' || Array.isArray(figure)
            || !Number.isSafeInteger(figure.ordinal) || figure.ordinal < 1 || ordinalSet.has(figure.ordinal)) {
            fail(`figure ${index + 1} has an invalid or duplicate ordinal`);
        }
        ordinalSet.add(figure.ordinal);
        return { ordinal: figure.ordinal, url: officialFigureUrl(figure.url, id) };
    });
    const osTemporaryRoot = fs.realpathSync(os.tmpdir());
    const temporaryRoot = canonicalExistingAncestor(options.temporaryRoot || osTemporaryRoot);
    const configuredDataRoot = canonicalExistingAncestor(require('../config.js').DATA_DIR);
    if (!pathInside(osTemporaryRoot, temporaryRoot) || pathInside(configuredDataRoot, temporaryRoot)
        || pathInside(temporaryRoot, configuredDataRoot)) {
        fail('ephemeral figures must use an OS-temporary directory outside Config.DATA_DIR');
    }
    const persistentRoots = [options.sourceRoot, ...(options.persistentRoots || [])]
        .filter(Boolean).map(item => path.resolve(item));
    if (persistentRoots.some(root => pathInside(root, temporaryRoot))) {
        fail('ephemeral figures cannot use a persistent runtime directory');
    }
    const fetchFigure = overrides.fetchFigure || defaultFetchFigure;
    if (typeof fetchFigure !== 'function') fail('official figure fetcher is required');
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'fresh-arxiv-figures-'));
    fs.chmodSync(directory, 0o700);
    try {
        const materialized = [];
        for (const figure of normalizedFigures) {
            const response = normalizeFigureResponse(await fetchEphemeralFigureWithRetry(
                fetchFigure, figure.url, { sleep: overrides.figureRetrySleep }
            ));
            const filename = `figure-${String(figure.ordinal).padStart(3, '0')}.bin`;
            writePrivateFile(directory, filename, response.bytes);
            materialized.push(Object.freeze({ ordinal: figure.ordinal, mediaType: response.mediaType,
                sha256: sha256(response.bytes), bytes: response.bytes.length, tempPath: path.join(directory, filename) }));
        }
        // 链接只留在这个调用栈里用来取图。
        // 回调拿到的是按序号绑定的字节/路径，
        // 不会顺着来源层的结果把链接写出去。
        return await callback(Object.freeze({ arxivId: id, temporaryDirectory: directory,
            figures: Object.freeze(materialized) }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
    }
}

module.exports = {
    CONTRACT, VERSION, EXTRACTOR_CONTRACT, DEFAULT_EXTRACTOR_VERSION, HISTORICAL_VERSION_CONTRACT,
    MANIFEST_NAME, TEXT_NAME, PDF_NAME, RUNTIME_METADATA_NAME, SOURCE_FILES, FreshArxivRewriteSourceError,
    sha256, normalizedArxivId, normalizedGeneration, generationName, sourceDirectory,
    EPHEMERAL_FIGURE_FETCH_MAX_ATTEMPTS, isTransientEphemeralFigureFetchError,
    fetchEphemeralFigureWithRetry,
    readFreshArxivRewriteSource, captureFreshArxivRewriteSource, officialUrl,
    withEphemeralArxivFigures, officialFigureUrl, generationExists, runtimeDetailsFromFreshCapture,
    runtimeMetadataFromDetails, runtimeDetailsFromMetadata, historicalVersionIdentity,
    normalizeHistoricalVersionIdentity, historicalVersionWarning, assertNoPersistentImageBytes
};
