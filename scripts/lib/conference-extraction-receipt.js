'use strict';

// 在进入会议暂存之前，核对 Python PDF 抽取产物的确定性结果。抽取器可能带上从官方
// PDF 复算出来的结构，但原始 PDF 才是权威。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paperIdentity = require('./paper-identity.js');

const REQUEST_CONTRACT = 'conference-pdf-extraction-request-v2';
const ARTIFACT_CONTRACT = 'conference-structured-artifacts-v2';
const RECEIPT_CONTRACT = 'conference-pdf-extraction-receipt-v2';
const VERIFICATION_CONTRACT = 'conference-pdf-extraction-verification-v2';
const VERSION = 2;
const PROFILE = 'replayable-pdf-layout-v1';
const WEAK_PROFILE = 'weak-pdf-layout-v1';
const REPLAYABLE_PROFILE = 'replayable-pdf-layout-v1';
const OFFSET_UNIT = 'utf8-byte';
const EXTRACTOR_NAME = 'audio-paper-digest-conference-structured';
const EXTRACTOR_VERSION = '2.3.1';
const BACKEND_NAME = 'pymupdf';
const BACKEND_VERSION = '1.27.2.3';
const OPTIONS = Object.freeze({ minimumTextCharacters: 5000,
    normalization: 'unicode-nfc-lf-rstrip-v1', pageSeparator: '\n\f\n' });
const SHORT_PROCEEDINGS_OPTIONS = Object.freeze({ minimumTextCharacters: 3000,
    normalization: OPTIONS.normalization, pageSeparator: OPTIONS.pageSeparator });
const SHORT_PROCEEDINGS_CONFERENCES = new Set(['jep-2026', 'icmc-2026']);
const SUPPORTED_OPTIONS = Object.freeze([OPTIONS, SHORT_PROCEEDINGS_OPTIONS]);
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SAFE_PDF_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.pdf$/;
const SAFE_TEXT_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.txt$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['official-metadata', 'official-pdf', 'conference-proceedings', 'openreview', 'local-confirmed-copy']);
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
// Python 抽取器在 base64 编码前把单个内嵌图片限制在 2 MiB。receipt 校验器要与这个
// 上限保持一致，同时整个 JSON 产物的上限仍是 64 MiB。
const MAX_FIGURE_ASSET_BASE64_CHARS = 4 * Math.ceil((2 * 1024 * 1024) / 3) + 4;
const EXTRACTION_HANDLES = new WeakSet();
const EXTRACTION_HANDLE_DATA = new WeakMap();
// Python 的 str.isspace() 是 Unicode White_Space 加上四个 C0 信息分隔符。ECMAScript
// 的 \s 不含 U+001C..U+001F 却包含 U+FEFF，所以没法逐字符复现抽取器给出的 receipt
// 计数。
const PYTHON_WHITESPACE_RE = /[\p{White_Space}\u001c-\u001f]/u;

class ConferenceExtractionReceiptError extends Error {
    constructor(message) {
        super(message); this.name = 'ConferenceExtractionReceiptError';
        this.code = 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY';
        this.retryable = false;
    }
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function fail(message) {
    throw new ConferenceExtractionReceiptError(`会议抽取凭证拒绝使用：${message}`);
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是普通对象，不能是数组或自定义对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} 缺少必需字段，或含有额外字段`);
    }
}
function safeName(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} 必须是允许格式的文件名，不能包含目录`);
    return value;
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} 必须是由 64 个小写十六进制字符组成的 SHA-256`);
    return value;
}
function text(value, label, { maximum = 2000 } = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
        || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} 必须是非空文本，首尾不能有空白字符，不能含控制字符，长度不能超过上限`);
    return value;
}
function timestamp(value, label) {
    text(value, label);
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(date.getTime()) || date.toISOString() !== value) fail(`${label} 必须使用 UTC 时间格式 YYYY-MM-DDTHH:mm:ss.sssZ，并表示有效时间`);
    return value;
}
function strictPointer(value, label) {
    text(value, label);
    if (!value.startsWith('/') || /~(?:[^01]|$)/u.test(value)) fail(`${label} 必须是以 / 开头的 JSON 字段路径，~ 转义只能使用 ~0 或 ~1`);
    return value;
}
function identityEvidence(value) {
    const fields = ['conferenceIdPointer', 'conferenceYearPointer', 'identityTypePointer', 'identityValuePointer'];
    exact(value, fields, 'metadata identityEvidence');
    return Object.fromEntries(fields.map(field => [field, strictPointer(value[field], `metadata identityEvidence.${field}`)]));
}
function discoveryBinding(value) {
    exact(value, ['catalogSha256', 'metadataSnapshotSha256', 'metadataIndex', 'metadataRecordSha256'],
        'metadata discoveryBinding');
    if (!Number.isSafeInteger(value.metadataIndex) || value.metadataIndex < 0) {
        fail('metadata discoveryBinding.metadataIndex 必须是大于等于 0 且可精确表示的整数');
    }
    return { catalogSha256: assertSha(value.catalogSha256, 'metadata discoveryBinding.catalogSha256'),
        metadataSnapshotSha256: assertSha(value.metadataSnapshotSha256, 'metadata discoveryBinding.metadataSnapshotSha256'),
        metadataIndex: value.metadataIndex,
        metadataRecordSha256: assertSha(value.metadataRecordSha256, 'metadata discoveryBinding.metadataRecordSha256') };
}
function provenance(value, label) {
    exact(value, ['kind', 'locator', 'retrievedAt'], `${label}.provenance`);
    if (!SOURCE_KINDS.has(value.kind)) fail(`${label}.provenance.kind 不是允许的来源类型`);
    return { kind: value.kind, locator: text(value.locator, `${label}.provenance.locator`),
        retrievedAt: timestamp(value.retrievedAt, `${label}.provenance.retrievedAt`) };
}
function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key;
            try { key = JSON.parse(token); } catch { fail(`${label} 的 JSON 字符串语法无效`); }
            if (top.keys.has(key)) fail(`${label} 含有重复的 JSON 字段名：${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}
function strictJson(bytes, label) {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        return JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY') throw error;
        fail(`${label} 必须是 UTF-8 编码且语法有效的 JSON`);
    }
}
function strictUtf8(bytes, label) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label} 必须是有效的 UTF-8 文本`); }
}
function pythonNonWhitespaceCharacters(value) {
    if (typeof value !== 'string') fail('统计文本字符数时，输入必须是字符串');
    let count = 0;
    for (const character of value) if (!PYTHON_WHITESPACE_RE.test(character)) count += 1;
    return count;
}
function safeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('sourceRoot 必须是配置的绝对目录路径');
    const absolute = path.resolve(root); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); const info = fs.lstatSync(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) fail('sourceRoot 含有不安全的目录：路径组成部分不是目录或是符号链接');
    }
    if (fs.realpathSync(absolute) !== absolute) fail('sourceRoot 不能经过符号链接指向其他目录');
    return absolute;
}
function readDirect(root, name, pattern, limit, label) {
    safeName(name, pattern, label); const filename = path.join(root, name); let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
            fail(`${label} 必须是普通文件，硬链接数须为 1，文件大小不能超过上限`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size || opened.size > limit) {
            fail(`${label} 在打开时发生变化或变得不安全`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} 在读取时发生变化`);
        return { filename, bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error?.code === 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY') throw error;
        fail(`${label} 无法按要求读取：${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function normalizeSourceEntry(value, kind) {
    const fields = kind === 'metadata' ? ['file', 'sha256', 'identityEvidence', 'discoveryBinding', 'provenance']
        : ['file', 'sha256', 'provenance'];
    exact(value, fields, `source.${kind}`);
    const result = { file: safeName(value.file, kind === 'metadata' ? SAFE_JSON_NAME : SAFE_PDF_NAME, `source.${kind}.file`),
        sha256: assertSha(value.sha256, `source.${kind}.sha256`) };
    if (kind === 'metadata') {
        result.identityEvidence = identityEvidence(value.identityEvidence);
        result.discoveryBinding = discoveryBinding(value.discoveryBinding);
    }
    result.provenance = provenance(value.provenance, `source.${kind}`);
    return result;
}
function normalizeOptions(value) {
    exact(value, Object.keys(OPTIONS), 'extraction options');
    if (!SUPPORTED_OPTIONS.some(profile => stableHash(value) === stableHash(profile))) {
        fail('抽取参数与本会议允许的配置不同');
    }
    return clone(value);
}

function optionsForConference(conferenceId) {
    return clone(SHORT_PROCEEDINGS_CONFERENCES.has(String(conferenceId || '').trim())
        ? SHORT_PROCEEDINGS_OPTIONS : OPTIONS);
}
function normalizeRequest(value, requestName) {
    exact(value, ['contract', 'version', 'paperId', 'sourceIdentity', 'source', 'outputs', 'options'], 'extraction request');
    if (value.contract !== REQUEST_CONTRACT || value.version !== VERSION) fail('抽取请求的格式标识或版本不受支持');
    exact(value.source, ['metadata', 'pdf'], 'extraction request source');
    exact(value.outputs, ['textFile', 'artifactsFile', 'receiptFile'], 'extraction request outputs');
    const result = { contract: REQUEST_CONTRACT, version: VERSION,
        paperId: text(value.paperId, 'request.paperId'), sourceIdentity: text(value.sourceIdentity, 'request.sourceIdentity'),
        source: { metadata: normalizeSourceEntry(value.source.metadata, 'metadata'),
            pdf: normalizeSourceEntry(value.source.pdf, 'pdf') },
        outputs: { textFile: safeName(value.outputs.textFile, SAFE_TEXT_NAME, 'outputs.textFile'),
            artifactsFile: safeName(value.outputs.artifactsFile, SAFE_JSON_NAME, 'outputs.artifactsFile'),
            receiptFile: safeName(value.outputs.receiptFile, SAFE_JSON_NAME, 'outputs.receiptFile') },
        options: normalizeOptions(value.options) };
    const names = [requestName, result.source.metadata.file, result.source.pdf.file, ...Object.values(result.outputs)];
    if (new Set(names).size !== names.length) fail('请求文件、来源文件和输出文件必须使用互不相同的文件名');
    return result;
}

function validateVisualAudit(value) {
    if (!plain(value)) fail('visualAudit 必须是普通对象，不能是数组或自定义对象');
    exact(value, ['contract', 'version', 'backend', 'renderDpi', 'pages', 'embeddedImages',
        'tableCandidates', 'formulaCandidates', 'figureCandidates', 'visualBytes', 'limitations', 'auditSha256'], 'visualAudit');
    if (value.contract !== 'conference-pdf-visual-audit-v1' || value.version !== 1
        || !plain(value.backend) || value.backend.name !== BACKEND_NAME
        || value.backend.version !== BACKEND_VERSION || value.renderDpi !== 72
        || !Array.isArray(value.pages) || !Array.isArray(value.embeddedImages)
        || !Array.isArray(value.tableCandidates) || !Array.isArray(value.formulaCandidates)
        || !Array.isArray(value.figureCandidates) || !Array.isArray(value.limitations)
        || !Number.isSafeInteger(value.visualBytes) || value.visualBytes < 1
        || value.visualBytes > 48 * 1024 * 1024 || !value.limitations.every(item => typeof item === 'string' && item.trim())) {
        fail('visualAudit 的格式标识、版本、渲染配置、记录类型或大小限制不符合要求');
    }
    let total = 0;
    for (const [index, page] of value.pages.entries()) {
        exact(page, ['page', 'mediaType', 'dpi', 'width', 'height', 'sha256', 'bytes', 'pngBase64'], `visualAudit.pages[${index}]`);
        if (page.page !== index + 1 || page.mediaType !== 'image/png' || page.dpi !== 72
            || !Number.isSafeInteger(page.width) || page.width < 1 || !Number.isSafeInteger(page.height) || page.height < 1
            || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || typeof page.pngBase64 !== 'string'
            || assertSha(page.sha256, `visualAudit.pages[${index}].sha256`) !== sha256(Buffer.from(page.pngBase64, 'base64'))
            || Buffer.from(page.pngBase64, 'base64').length !== page.bytes) {
            fail(`visualAudit.pages[${index}] 的页码、PNG 渲染配置、图片字节或 SHA 未通过核验`);
        }
        total += page.bytes;
    }
    if (total !== value.visualBytes || assertSha(value.auditSha256, 'visualAudit.auditSha256') !== stableHash({ ...value, auditSha256: undefined })) {
        const body = clone(value); delete body.auditSha256;
        if (total !== value.visualBytes || assertSha(value.auditSha256, 'visualAudit.auditSha256') !== stableHash(body)) {
            fail('visualAudit 的图片字节总数或记录自身的 SHA 与实际计算值不同');
        }
    }
    return clone(value);
}
function resolvePointer(document, pointer, label) {
    let current = document;
    for (const encoded of pointer.slice(1).split('/')) {
        const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) fail(`在来源元数据中找不到 ${label} 指定的字段`);
            current = current[Number(key)];
        } else if (plain(current) && Object.hasOwn(current, key)) current = current[key];
        else fail(`在来源元数据中找不到 ${label} 指定的字段`);
    }
    return current;
}
function validateMetadataIdentity(metadata, request) {
    const evidence = request.source.metadata.identityEvidence;
    const conferenceId = resolvePointer(metadata, evidence.conferenceIdPointer, 'conferenceIdPointer');
    const conferenceYear = resolvePointer(metadata, evidence.conferenceYearPointer, 'conferenceYearPointer');
    const identityType = resolvePointer(metadata, evidence.identityTypePointer, 'identityTypePointer');
    const identityValue = resolvePointer(metadata, evidence.identityValuePointer, 'identityValuePointer');
    if (typeof conferenceId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(conferenceId)
        || !Number.isSafeInteger(conferenceYear) || conferenceYear < 1900 || conferenceYear > 2100
        || typeof identityType !== 'string' || typeof identityValue !== 'string'
        || request.sourceIdentity !== `${identityType}:${identityValue}`) {
        fail('来源元数据中的会议、年份或论文身份不满足请求 paperId/sourceIdentity 的要求');
    }
    const conference = { id: conferenceId, year: conferenceYear };
    const identity = { type: identityType, value: identityValue };
    try { paperIdentity.assertCanonicalConferencePaperId(request.paperId, conference, identity); }
    catch (error) { fail(`来源元数据中的身份无法对应规范 paperId：${error.message}`); }
    return { conference, identity };
}
// PDF 版面属于来源证据，不是作者写的 TeX。source-context 也使用这项检查，避免
// 重新读取元数据时，把尚未通过核验的公式候选误标为可用。
function validatePdfFormulaRecord(formula, index, audit, pageCount) {
    exact(formula, ['ordinal', 'page', 'tex', 'sourceRef', 'recoveryStatus', 'sourceExpression'], `formulas[${index}]`);
    if (formula.ordinal !== index + 1 || !Number.isSafeInteger(formula.page)
        || formula.page < 1 || formula.page > pageCount || formula.tex !== ''
        || formula.recoveryStatus !== 'layout-preserved') fail('PDF 公式必须保留原排版，不能提供可发布的 TeX；公式序号、页码或状态也须满足要求');
    text(formula.sourceRef, 'formula.sourceRef');
    const expression = formula.sourceExpression;
    exact(expression, ['contract', 'kind', 'originalTexAvailable', 'layoutSha256', 'renderSha256', 'recoveredTex', 'crop'], 'formula.sourceExpression');
    if (expression.contract !== 'pdf-formula-source-expression-v1'
        || expression.kind !== 'recovered-from-pdf-layout' || expression.originalTexAvailable !== false
        || !(expression.recoveredTex === null || typeof expression.recoveredTex === 'string' && expression.recoveredTex.length <= 4000)) {
        fail('PDF 公式的来源表达格式无效，或将推导的表达冒充原始 TeX');
    }
    const page = audit?.pages?.find(item => item.page === formula.page);
    if (!page || assertSha(expression.renderSha256, 'formula.renderSha256') !== page.sha256) {
        fail('PDF 公式缺少对应原始页面的图片像素，或渲染 SHA 与页面记录不同');
    }
    const matches = (audit.formulaCandidates || []).filter(item => item.page === formula.page
        && item.layoutSha256 === expression.layoutSha256 && item.renderSha256 === page.sha256);
    if (matches.length !== 1) fail('PDF 公式必须恰好对应一条排版候选记录');
    const candidate = matches[0];
    const layout = candidate.layout;
    exact(layout, ['contract', 'bbox', 'glyphs'], 'formula glyph layout');
    const coordinates = (value, length) => Array.isArray(value) && value.length === length
        && value.every(number => typeof number === 'number' && Number.isFinite(number));
    const crop = expression.crop;
    exact(crop, ['bbox', 'dpi', 'mediaType', 'sha256', 'base64'], 'formula crop');
    if (!coordinates(crop.bbox, 4) || stableHash(crop.bbox) !== stableHash(candidate.cropBBox)
        || candidate.regionStatus !== 'bounded-formula-region'
        || crop.bbox[2] <= crop.bbox[0] || crop.bbox[2] - crop.bbox[0] > 420
        || crop.bbox[3] <= crop.bbox[1] || crop.bbox[3] - crop.bbox[1] > 96
        || crop.dpi !== 144 || crop.mediaType !== 'image/png'
        || typeof crop.base64 !== 'string' || crop.base64.length > 4 * Math.ceil(512 * 1024 / 3)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(crop.base64)) fail('PDF 公式的裁剪区域、分辨率、图片类型或 base64 内容不符合要求');
    const cropBytes = Buffer.from(crop.base64, 'base64');
    if (cropBytes.length < 24 || cropBytes.length > 512 * 1024
        || !cropBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || cropBytes.readUInt32BE(16) < 1 || cropBytes.readUInt32BE(16) > 842
        || cropBytes.readUInt32BE(20) < 1 || cropBytes.readUInt32BE(20) > 194
        || sha256(cropBytes) !== assertSha(crop.sha256, 'formula crop SHA')) fail('PDF 公式裁剪图片的文件头、尺寸、大小或 SHA 与要求不同');
    if (layout.contract !== 'pdf-formula-glyph-layout-v1' || !coordinates(layout.bbox, 4)
        || !Array.isArray(layout.glyphs) || !layout.glyphs.length
        || candidate.status !== 'visual-only-no-tex'
        || candidate.derivedTex !== expression.recoveredTex
        || stableHash(layout) !== assertSha(expression.layoutSha256, 'formula.layoutSha256')) {
        fail('PDF 公式的排版格式、字符记录、恢复状态、推导 TeX 或排版 SHA 与来源记录不同');
    }
    for (const glyph of layout.glyphs) {
        exact(glyph, ['text', 'bbox', 'origin', 'size', 'font', 'direction'], 'formula glyph');
        if (typeof glyph.text !== 'string' || [...glyph.text].length !== 1
            || typeof glyph.font !== 'string' || !coordinates(glyph.bbox, 4)
            || !coordinates(glyph.origin, 2) || !coordinates(glyph.direction, 2)
            || !Number.isFinite(glyph.size) || glyph.size <= 0
            || glyph.bbox[0] < layout.bbox[0] || glyph.bbox[1] < layout.bbox[1]
            || glyph.bbox[2] > layout.bbox[2] || glyph.bbox[3] > layout.bbox[3]) {
            fail('PDF 公式中的字符、字体、字号或位置坐标不符合要求');
        }
    }
    return formula;
}

function validateArtifact(value, textBytes) {
    const allowed = ['contract', 'version', 'profile', 'offsetUnit', 'flattenedTextSha256', 'pages',
        'tables', 'formulas', 'figures', 'payloadSha256'];
    if (Object.keys(value).sort().join('\0') !== [...allowed, ...(Object.hasOwn(value, 'visualAudit') ? ['visualAudit'] : [])].sort().join('\0')) {
        fail('结构化抽取结果缺少必需字段，或含有额外字段');
    }
    if (value.contract !== ARTIFACT_CONTRACT || value.version !== VERSION || ![WEAK_PROFILE, REPLAYABLE_PROFILE].includes(value.profile)
        || value.offsetUnit !== OFFSET_UNIT) fail('结构化抽取结果的格式标识、版本、证据能力配置或偏移单位不受支持');
    if (assertSha(value.flattenedTextSha256, 'flattenedTextSha256') !== sha256(textBytes)) {
        fail('结构化抽取结果的 flattenedTextSha256 与实际全文字节的 SHA 不同');
    }
    const { payloadSha256, ...body } = value;
    if (assertSha(payloadSha256, 'payloadSha256') !== sha256(JSON.stringify(body))) fail('结构化抽取结果的 payloadSha256 与实际记录内容的 SHA 不同');
    if (Object.hasOwn(value, 'visualAudit')) validateVisualAudit(value.visualAudit);
    if (!Array.isArray(value.pages) || !value.pages.length
        || !Array.isArray(value.tables) || !Array.isArray(value.formulas)
        || !Array.isArray(value.figures)) fail('结构化抽取结果必须包含非空页面对应记录，以及表格、公式和图片数组');
    if (value.profile === WEAK_PROFILE
        && (value.tables.length || value.formulas.length || value.figures.length)) {
        fail('证据能力有限的抽取结果不能包含恢复出的表格、公式或图片结构');
    }
    let previousEnd = 0;
    value.pages.forEach((page, index) => {
        exact(page, ['page', 'textStart', 'textEnd'], `pages[${index}]`);
        if (page.page !== index + 1 || !Number.isSafeInteger(page.textStart) || !Number.isSafeInteger(page.textEnd)
            || page.textStart !== previousEnd || page.textEnd <= page.textStart || page.textEnd > textBytes.length) {
            fail('页面对应记录的页码与文本范围必须按顺序连续划分 UTF-8 全文字节，不能重叠、缺段或越界');
        }
        try { new TextDecoder('utf-8', { fatal: true }).decode(textBytes.subarray(page.textStart, page.textEnd)); }
        catch { fail('页面文本范围不能截断 UTF-8 字符的编码字节'); }
        previousEnd = page.textEnd;
    });
    if (previousEnd !== textBytes.length) fail('页面对应记录必须覆盖全部 UTF-8 全文字节');
    if (value.profile === REPLAYABLE_PROFILE) {
        const checkText = (item, label, empty = false, maximum = 4000) => {
            if (typeof item !== 'string' || (!empty && !item.trim()) || item.length > maximum
                || /[\u0000-\u001f\u007f]/u.test(item)) fail(`${label} 必须是允许长度范围内的文本，不能含控制字符；要求非空时不能只有空白字符`);
        };
        for (const [index, table] of value.tables.entries()) {
            exact(table, ['ordinal', 'page', 'caption', 'cells', 'sourceRef', 'recoveryStatus'], `tables[${index}]`);
            if (!Number.isSafeInteger(table.ordinal) || table.ordinal !== index + 1
                || !Number.isSafeInteger(table.page) || table.page < 1 || table.page > value.pages.length
                || table.recoveryStatus !== 'complete') fail('表格记录必须按序编号，页码须有效，恢复状态须为 complete');
            checkText(table.caption, `tables[${index}].caption`, true); checkText(table.sourceRef, `tables[${index}].sourceRef`);
            if (!Array.isArray(table.cells) || !table.cells.length || table.cells.some(row => (
                !Array.isArray(row) || !row.length || row.some(cell => typeof cell !== 'string' || cell.length > 500)
            )) || table.cells.some(row => row.length !== table.cells[0].length)) fail('表格必须至少有一行一列，各行列数须相同，单元格须为不超过 500 个字符的字符串');
        }
        for (const [index, formula] of value.formulas.entries()) {
            validatePdfFormulaRecord(formula, index, value.visualAudit, value.pages.length);
        }
        if (value.formulas.length > 32 || value.formulas.reduce((sum, formula) => (
            sum + Buffer.from(formula.sourceExpression.crop.base64, 'base64').length
        ), 0) > 8 * 1024 * 1024) fail('PDF 公式图片超过允许的数量或总字节上限');
        for (const [index, figure] of value.figures.entries()) {
            exact(figure, ['ordinal', 'page', 'caption', 'sourceRef', 'recoveryStatus', 'asset'], `figures[${index}]`);
            if (!Number.isSafeInteger(figure.ordinal) || figure.ordinal !== index + 1
                || !Number.isSafeInteger(figure.page) || figure.page < 1 || figure.page > value.pages.length
                || figure.recoveryStatus !== 'complete') fail('图片记录必须按序编号，页码须有效，恢复状态须为 complete');
            checkText(figure.caption, `figures[${index}].caption`, true); checkText(figure.sourceRef, `figures[${index}].sourceRef`);
            if (figure.asset !== null) {
                exact(figure.asset, ['base64', 'mediaType', 'sha256'], `figures[${index}].asset`);
                checkText(figure.asset.mediaType, `figures[${index}].asset.mediaType`);
                checkText(figure.asset.base64, `figures[${index}].asset.base64`, false,
                    MAX_FIGURE_ASSET_BASE64_CHARS);
                if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(figure.asset.mediaType)
                    || !/^[A-Za-z0-9+/]+={0,2}$/.test(figure.asset.base64)
                    || !SHA_RE.test(figure.asset.sha256)
                    || !Buffer.from(figure.asset.base64, 'base64').length
                    || sha256(Buffer.from(figure.asset.base64, 'base64')) !== figure.asset.sha256) {
                    fail('图片内容、类型或 base64 格式无效，或 SHA 与实际图片字节不同');
                }
            }
        }
    }
    return clone(value);
}
function normalizeReceipt(value) {
    exact(value, ['contract', 'version', 'status', 'textReplayable', 'structuredReplayable', 'paperId',
        'sourceIdentity', 'request', 'source', 'extractor', 'options', 'pageCount', 'text', 'artifacts',
        'blockedReason', 'receiptSha256'], 'extraction receipt');
    if (value.contract !== RECEIPT_CONTRACT || value.version !== VERSION || value.status !== 'ready'
        || value.textReplayable !== true || typeof value.structuredReplayable !== 'boolean' || value.blockedReason !== null) {
        fail('只有状态为 ready、文本可重新核验且未被阻断的会议抽取凭证才能用于暂存');
    }
    exact(value.request, ['file', 'sha256'], 'receipt.request');
    exact(value.source, ['metadata', 'pdf'], 'receipt.source');
    exact(value.extractor, ['name', 'version', 'backend'], 'receipt.extractor');
    exact(value.extractor.backend, ['name', 'version'], 'receipt.extractor.backend');
    exact(value.text, ['file', 'sha256', 'utf8Bytes', 'nonWhitespaceCharacters'], 'receipt.text');
    exact(value.artifacts, ['file', 'sha256'], 'receipt.artifacts');
    if (value.extractor.name !== EXTRACTOR_NAME || value.extractor.version !== EXTRACTOR_VERSION
        || value.extractor.backend.name !== BACKEND_NAME || value.extractor.backend.version !== BACKEND_VERSION) {
        fail('抽取器或其底层程序的名称、版本与指定实现不同');
    }
    if (!Number.isSafeInteger(value.pageCount) || value.pageCount < 1
        || !Number.isSafeInteger(value.text.utf8Bytes) || value.text.utf8Bytes < 1
        || !Number.isSafeInteger(value.text.nonWhitespaceCharacters)
        || value.text.nonWhitespaceCharacters < value.options.minimumTextCharacters) fail('凭证的页数、UTF-8 字节数或非空白字符数无效，或正文字符数不足');
    const result = clone(value); result.request.file = safeName(value.request.file, SAFE_JSON_NAME, 'receipt.request.file');
    assertSha(value.request.sha256, 'receipt.request.sha256');
    result.source = { metadata: normalizeSourceEntry(value.source.metadata, 'metadata'),
        pdf: normalizeSourceEntry(value.source.pdf, 'pdf') };
    result.text.file = safeName(value.text.file, SAFE_TEXT_NAME, 'receipt.text.file');
    result.artifacts.file = safeName(value.artifacts.file, SAFE_JSON_NAME, 'receipt.artifacts.file');
    assertSha(value.text.sha256, 'receipt.text.sha256'); assertSha(value.artifacts.sha256, 'receipt.artifacts.sha256');
    result.options = normalizeOptions(value.options);
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'receipt.receiptSha256') !== stableHash(body)) fail('凭证自身的 SHA 与实际记录内容的 SHA 不同');
    return result;
}

function normalizeVerification(value) {
    exact(value, ['contract', 'version', 'status', 'paperId', 'sourceIdentity', 'requestSha256',
        'metadataSha256', 'pdfSha256', 'textSha256', 'artifactsSha256', 'receiptFileSha256',
        'receiptSha256', 'verificationSha256'], 'Python extraction verification');
    if (value.contract !== VERIFICATION_CONTRACT || value.version !== VERSION || value.status !== 'verified') {
        fail('Python 抽取核验结果的格式标识、版本或状态不符合要求');
    }
    text(value.paperId, 'Python verification paperId');
    text(value.sourceIdentity, 'Python verification sourceIdentity');
    for (const field of ['requestSha256', 'metadataSha256', 'pdfSha256', 'textSha256',
        'artifactsSha256', 'receiptFileSha256', 'receiptSha256']) assertSha(value[field], `Python verification ${field}`);
    const body = clone(value); delete body.verificationSha256;
    if (assertSha(value.verificationSha256, 'Python verification verificationSha256') !== stableHash(body)) {
        fail('Python 抽取核验结果自身的 SHA 与实际记录内容的 SHA 不同');
    }
    return clone(value);
}

function verifyWithPinnedPython(sourceRoot, requestName) {
    const runtime = path.resolve(__dirname, '..', 'python-runtime.sh');
    const script = path.resolve(__dirname, '..', 'conference-extract.py');
    let stdout;
    try {
        stdout = execFileSync('bash', [runtime, script, '--verify', '--manifest', requestName, '--source-root', sourceRoot], {
            cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
            timeout: 2 * 60 * 1000, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error) {
        const stderr = String(error?.stderr || '').trim().split(/\r?\n/).at(-1) || error.message;
        fail(`使用指定 Python 程序重新核验抽取结果失败：${stderr}`);
    }
    let parsed;
    try { parsed = JSON.parse(String(stdout).trim()); }
    catch { fail('指定 Python 程序没有返回一个有效的 JSON 核验结果'); }
    return normalizeVerification(parsed);
}

function boundVerification({ request, requestLoaded, metadataLoaded, pdfLoaded, textLoaded,
    artifactLoaded, receiptLoaded, receipt }) {
    // 调用方已经逐字节核对过每个来源和输出与 receipt 是否一致。重试时如果按设计
    // 跳过 Python 的确定性复算，就在这里重建同一套校验绑定。
    const body = {
        contract: VERIFICATION_CONTRACT, version: VERSION, status: 'verified',
        paperId: request.paperId, sourceIdentity: request.sourceIdentity,
        requestSha256: requestLoaded.sha256, metadataSha256: metadataLoaded.sha256,
        pdfSha256: pdfLoaded.sha256, textSha256: textLoaded.sha256,
        artifactsSha256: artifactLoaded.sha256, receiptFileSha256: receiptLoaded.sha256,
        receiptSha256: receipt.receiptSha256
    };
    return normalizeVerification({ ...body, verificationSha256: stableHash(body) });
}

function loadExtractionHandle(sourceRoot, receiptName, { replay = true } = {}) {
    const root = safeRoot(sourceRoot); safeName(receiptName, SAFE_JSON_NAME, 'receiptName');
    const receiptLoaded = readDirect(root, receiptName, SAFE_JSON_NAME, MAX_JSON_BYTES, 'extraction receipt');
    const receipt = normalizeReceipt(strictJson(receiptLoaded.bytes, 'extraction receipt'));
    if (receipt.artifacts.file === receiptName || receipt.text.file === receiptName || receipt.request.file === receiptName) {
        fail('凭证文件名与请求、全文或结构化抽取结果的文件名重复');
    }
    const requestLoaded = readDirect(root, receipt.request.file, SAFE_JSON_NAME, MAX_JSON_BYTES, 'extraction request');
    if (requestLoaded.sha256 !== receipt.request.sha256) fail('抽取请求文件的 SHA 与凭证中记录的值不同');
    const request = normalizeRequest(strictJson(requestLoaded.bytes, 'extraction request'), receipt.request.file);
    if (request.paperId !== receipt.paperId || request.sourceIdentity !== receipt.sourceIdentity
        || stableHash(request.source) !== stableHash(receipt.source)
        || stableHash(request.options) !== stableHash(receipt.options)
        || request.outputs.receiptFile !== receiptName
        || request.outputs.textFile !== receipt.text.file || request.outputs.artifactsFile !== receipt.artifacts.file) {
        fail('凭证中的论文身份、来源、参数或输出文件名与抽取请求不同');
    }
    const metadataLoaded = readDirect(root, request.source.metadata.file, SAFE_JSON_NAME, MAX_METADATA_BYTES, 'metadata');
    const pdfLoaded = readDirect(root, request.source.pdf.file, SAFE_PDF_NAME, MAX_PDF_BYTES, 'PDF');
    const textLoaded = readDirect(root, request.outputs.textFile, SAFE_TEXT_NAME, MAX_TEXT_BYTES, 'text');
    const artifactLoaded = readDirect(root, request.outputs.artifactsFile, SAFE_JSON_NAME, MAX_JSON_BYTES, 'structured artifact');
    if (metadataLoaded.sha256 !== request.source.metadata.sha256 || pdfLoaded.sha256 !== request.source.pdf.sha256
        || textLoaded.sha256 !== receipt.text.sha256 || artifactLoaded.sha256 !== receipt.artifacts.sha256) {
        fail('来源元数据、PDF、全文或结构化抽取结果的 SHA 与请求或凭证中的记录不同');
    }
    if (pdfLoaded.bytes.length < 5 || pdfLoaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('PDF 文件缺少标准的 %PDF- 文件头');
    }
    const metadata = strictJson(metadataLoaded.bytes, 'metadata');
    if (!plain(metadata)) fail('来源元数据必须是 JSON 对象');
    const identity = validateMetadataIdentity(metadata, request);
    const sourceText = strictUtf8(textLoaded.bytes, 'text');
    const nonWhitespaceCharacters = pythonNonWhitespaceCharacters(sourceText);
    if (textLoaded.bytes.length !== receipt.text.utf8Bytes
        || nonWhitespaceCharacters !== receipt.text.nonWhitespaceCharacters) fail('凭证记录的全文字节数或非空白字符数与实际全文不同');
    const artifact = validateArtifact(strictJson(artifactLoaded.bytes, 'structured artifact'), textLoaded.bytes);
    if (artifact.pages.length !== receipt.pageCount) fail('凭证页数与结构化抽取结果的页面数量不同');
    const verification = replay
        ? verifyWithPinnedPython(root, receipt.request.file)
        : boundVerification({ request, requestLoaded, metadataLoaded, pdfLoaded, textLoaded,
            artifactLoaded, receiptLoaded, receipt });
    if (verification.paperId !== request.paperId || verification.sourceIdentity !== request.sourceIdentity
        || verification.requestSha256 !== requestLoaded.sha256 || verification.metadataSha256 !== metadataLoaded.sha256
        || verification.pdfSha256 !== pdfLoaded.sha256 || verification.textSha256 !== textLoaded.sha256
        || verification.artifactsSha256 !== artifactLoaded.sha256 || verification.receiptFileSha256 !== receiptLoaded.sha256
        || verification.receiptSha256 !== receipt.receiptSha256) {
        fail('指定 Python 程序返回的论文身份或文件 SHA 与本次读取的抽取资料不同');
    }
    const snapshot = {
        contract: RECEIPT_CONTRACT, version: VERSION, paperId: request.paperId,
        sourceIdentity: request.sourceIdentity, conference: identity.conference, identity: identity.identity,
        metadata: clone(request.source.metadata), pdf: clone(request.source.pdf),
        text: { file: request.outputs.textFile, sha256: textLoaded.sha256,
            provenance: { extractor: EXTRACTOR_NAME, version: `${EXTRACTOR_VERSION}+${BACKEND_NAME}-${BACKEND_VERSION}` } },
        artifacts: { file: request.outputs.artifactsFile, sha256: artifactLoaded.sha256,
            provenance: { extractor: EXTRACTOR_NAME, version: `${EXTRACTOR_VERSION}+${BACKEND_NAME}-${BACKEND_VERSION}` } },
        receipt: { file: receiptName, fileSha256: receiptLoaded.sha256, receiptSha256: receipt.receiptSha256 },
        verification,
        pageCount: receipt.pageCount, profile: receipt.structuredReplayable ? REPLAYABLE_PROFILE : WEAK_PROFILE,
        structuredCapabilitiesAvailable: receipt.structuredReplayable
    };
    const handle = Object.freeze(Object.create(null)); EXTRACTION_HANDLES.add(handle);
    EXTRACTION_HANDLE_DATA.set(handle, Object.freeze(clone(snapshot))); return handle;
}
function extractionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !EXTRACTION_HANDLES.has(handle)) fail('必须提供由抽取凭证校验器实际核验并生成的结果对象');
    return clone(EXTRACTION_HANDLE_DATA.get(handle));
}

module.exports = { REQUEST_CONTRACT, ARTIFACT_CONTRACT, RECEIPT_CONTRACT, VERIFICATION_CONTRACT,
    VERSION, PROFILE, WEAK_PROFILE, REPLAYABLE_PROFILE, OFFSET_UNIT,
    EXTRACTOR_NAME, EXTRACTOR_VERSION, BACKEND_NAME, BACKEND_VERSION, OPTIONS, SHORT_PROCEEDINGS_OPTIONS,
    isShortProceedingsConference: conferenceId => SHORT_PROCEEDINGS_CONFERENCES.has(String(conferenceId || '').trim()),
    optionsForConference, SAFE_JSON_NAME,
    ConferenceExtractionReceiptError, loadExtractionHandle, extractionHandleSnapshot, stableHash,
    pythonNonWhitespaceCharacters, validatePdfFormulaRecord };
