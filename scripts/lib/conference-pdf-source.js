'use strict';

// 从已核验的本地 PDF 及可选提取结果整理来源记录，也支持已加载并核验的会议来源清单。
// 分析前可再次核验 PDF、提取结果及来源记录；此模块不调用模型或网络。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');

const CONTRACT = 'conference-pdf-source-v1';
const VERSION = 1;
const KIND = 'local_pdf';
const DEFAULT_MAX_PDF_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAX_PDF_BYTES = 256 * 1024 * 1024;

function fail(message) {
    const error = new Error(message);
    error.code = 'CONFERENCE_PDF_SOURCE_INTEGRITY';
    error.retryable = false;
    return error;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isSha256(value) {
    return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.keys(value).sort().map(key => {
            if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') {
                throw fail(`PDF 描述数据中的字段无法按 JSON 保存： ${key}`);
            }
            return [key, canonicalize(value[key])];
        }));
    }
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw fail('PDF 描述数据须能按 JSON 保存');
}

function stableJson(value) {
    return JSON.stringify(canonicalize(value));
}

function stableSha256(value) {
    return sha256(stableJson(value));
}

function clone(value) {
    return JSON.parse(stableJson(value));
}

function requireSafeDirectory(directory) {
    if (typeof directory !== 'string' || !directory) throw fail('cacheRoot 须为非空路径');
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT') throw fail(`PDF 本地来源根目录不存在： ${absolute}`);
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`PDF 本地来源目录不安全：不是实际目录，或使用了符号链接： ${cursor}`);
    }
    return absolute;
}

function requireRelativePdfPath(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')
        || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
        throw fail('PDF 路径须为非空相对路径，且不能含空字符');
    }
    // 来源清单的路径统一使用正斜杠；拒绝当前目录和上级目录段，
    // 保持 Windows 与 POSIX 系统读取相同路径。
    if (relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
        throw fail('PDF 路径不能含反斜杠、空目录段、当前目录段或上级目录段');
    }
    return relativePath;
}

function requireRecord(record) {
    if (!isPlainObject(record)) throw fail('已核验的会议记录须为普通对象');
    if (!isPlainObject(record.identity) || !Object.keys(record.identity).length) {
        throw fail('已核验的会议记录须包含非空身份对象');
    }
    const identity = clone(record.identity);
    const relativePath = requireRelativePdfPath(record.pdfRelativePath);
    if (!isSha256(record.pdfSha256)) throw fail('已核验的会议记录须包含小写 PDF SHA-256');
    return { identity, relativePath, pdfSha256: record.pdfSha256 };
}

function requireExactKeys(value, keys, name) {
    if (!isPlainObject(value)) throw fail(`${name} 须为普通对象`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw fail(`${name} 包含未允许的字段，或缺少必填字段`);
    }
}

function requireDescriptorHash(value, name) {
    if (value !== null && !isSha256(value)) throw fail(`${name} 须为小写 SHA-256 或 null`);
}

function requireLedgerBinding(value) {
    requireExactKeys(value, ['ledgerSha256', 'identityKey', 'metadataSha256', 'textSha256', 'artifactsSha256'], '会议 PDF 来源清单绑定');
    if (!isSha256(value.ledgerSha256)) throw fail('会议 PDF 来源清单绑定须包含小写 ledger SHA-256');
    if (typeof value.identityKey !== 'string' || !value.identityKey.trim()) {
        throw fail('会议 PDF 来源清单绑定须包含非空身份标识');
    }
    for (const field of ['metadataSha256', 'textSha256', 'artifactsSha256']) {
        if (!isSha256(value[field])) throw fail(`会议 PDF 来源清单绑定须包含有效的 ${field} SHA-256`);
    }
    return clone(value);
}

function ledgerBindingForMember(member, ledgerSha256) {
    if (!isSha256(ledgerSha256)) throw fail('ledgerSha256 须为小写 SHA-256');
    return requireLedgerBinding({
        ledgerSha256,
        identityKey: ledgerApi.identityKey(member.identity),
        metadataSha256: member.metadataSha256,
        textSha256: member.textSha256,
        artifactsSha256: member.artifactsSha256,
    });
}

function requireMaxBytes(value) {
    const maxBytes = value === undefined ? DEFAULT_MAX_PDF_BYTES : value;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ABSOLUTE_MAX_PDF_BYTES) {
        throw fail(`PDF 读取大小上限 maxBytes 必须是 1 到 ${ABSOLUTE_MAX_PDF_BYTES} 之间的整数`);
    }
    return maxBytes;
}

function safePdfFilename(cacheRoot, relativePath) {
    const target = path.resolve(cacheRoot, relativePath);
    const relative = path.relative(cacheRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('PDF 路径超出本地来源根目录');
    let cursor = cacheRoot;
    for (const part of relative.split(path.sep).slice(0, -1)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT') throw fail(`PDF 本地来源目录缺失： ${cursor}`);
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`PDF 本地来源目录不安全：不是实际目录，或使用了符号链接： ${cursor}`);
    }
    return target;
}

function readVerifiedPdf(cacheRoot, relativePath, maxBytes) {
    const filename = safePdfFilename(cacheRoot, relativePath);
    let beforeOpen;
    try { beforeOpen = fs.lstatSync(filename); }
    catch (error) { throw error; }
    if (beforeOpen.isSymbolicLink()) throw fail('PDF 须为只有一个硬链接的普通文件，不能使用符号链接，打开的文件须与路径检查的文件相同');
    let fd;
    try {
        try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
        catch (error) {
            // lstat 与 open 这一对有意重复：lstat 给出确定可复现的错误，O_NOFOLLOW 则
            // 堵住两者之间被换文件的窗口。
            if (error.code === 'ELOOP') throw fail('PDF 须为只有一个硬链接的普通文件，不能使用符号链接，打开的文件须与路径检查的文件相同');
            throw error;
        }
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino) {
            throw fail('PDF 须为只有一个硬链接的普通文件，不能使用符号链接，打开的文件须与路径检查的文件相同');
        }
        if (opened.size < 5 || opened.size > maxBytes) throw fail('PDF 少于 5 字节，或超过配置的大小限制');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
            throw fail('本地文件字节数改变，或文件头不是标准 PDF 标识');
        }
        return bytes;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function readVerifiedArtifact(cacheRoot, relativePath, expectedSha256, label) {
    const filename = safePdfFilename(cacheRoot, relativePath);
    let fd;
    try {
        try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
        catch (error) {
            if (error.code === 'ELOOP') throw fail(`${label} 须为只有一个硬链接的普通文件，不能使用符号链接，打开的文件须与路径检查的文件相同`);
            throw error;
        }
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino) {
            throw fail(`${label} 须为只有一个硬链接的普通文件，不能使用符号链接，打开的文件须与路径检查的文件相同`);
        }
        const bytes = fs.readFileSync(fd);
        if (sha256(bytes) !== expectedSha256) throw fail(`${label} SHA-256 与已核验的会议来源清单记录不符`);
        return bytes;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function unavailableExtraction() {
    return {
        extractorVersion: 'none',
        text: null,
        structuredArtifacts: null,
        formulaTeX: { available: false, reason: 'no-reliable-structured-tex' },
    };
}

function normalizeExtraction(value) {
    if (value === undefined || value === null) return unavailableExtraction();
    if (!isPlainObject(value)) throw fail('本地 PDF 提取结果须为普通对象');
    const extractorVersion = typeof value.extractorVersion === 'string' && value.extractorVersion.trim()
        ? value.extractorVersion.trim() : null;
    if (!extractorVersion) throw fail('本地 PDF 提取结果须明确提取器版本');
    const text = value.text === undefined || value.text === null ? null : value.text;
    if (text !== null && typeof text !== 'string') throw fail('PDF 提取文本须为字符串或 null');
    const structuredArtifacts = value.structuredArtifacts === undefined || value.structuredArtifacts === null
        ? null : value.structuredArtifacts;
    if (structuredArtifacts !== null && !isPlainObject(structuredArtifacts)) {
        throw fail('PDF 结构化提取结果须为普通对象或 null');
    }
    const formulaTeX = value.formulaTeX === undefined || value.formulaTeX === null
        ? { available: false, reason: 'no-reliable-structured-tex' } : value.formulaTeX;
    if (!isPlainObject(formulaTeX) || typeof formulaTeX.available !== 'boolean') {
        throw fail('formulaTeX 须为普通对象，并明确填写布尔可用状态');
    }
    if (!formulaTeX.available) {
        return { extractorVersion, text, structuredArtifacts,
            formulaTeX: { available: false, reason: typeof formulaTeX.reason === 'string'
                ? formulaTeX.reason : 'no-reliable-structured-tex' } };
    }
    // PDF 文本不是 TeX。只有当抽取器给出了可重新核对、且明确可靠的 TeX 结构时，
    // 后续 Reader 才可以渲染公式。
    if (formulaTeX.reliability !== 'reliable' || !Array.isArray(formulaTeX.formulas)
        || !formulaTeX.formulas.length || structuredArtifacts === null) {
        throw fail('声明 PDF 公式可用时，须提供可靠的结构化 TeX 提取结果和非空公式列表');
    }
    const formulas = formulaTeX.formulas.map((formula, index) => {
        if (!isPlainObject(formula) || typeof formula.tex !== 'string' || !formula.tex.trim()
            || typeof formula.sourceRef !== 'string' || !formula.sourceRef.trim()) {
            throw fail(`第 ${index} 个可靠 TeX 公式缺少非空 tex 或 sourceRef`);
        }
        return clone(formula);
    });
    return { extractorVersion, text, structuredArtifacts: clone(structuredArtifacts),
        formulaTeX: { available: true, reliability: 'reliable', formulas } };
}

function descriptorBody({ identity, relativePath, pdfSha256, pdfBytes, extraction, ledgerBinding = null }) {
    const textSha256 = extraction.text === null ? null : sha256(extraction.text);
    const structuredArtifactsSha256 = extraction.structuredArtifacts === null ? null : stableSha256(extraction.structuredArtifacts);
    const formulaTeXSha256 = extraction.formulaTeX.available ? stableSha256(extraction.formulaTeX) : null;
    const body = {
        contract: CONTRACT,
        version: VERSION,
        kind: KIND,
        identity: clone(identity),
        pdfRelativePath: relativePath,
        pdfSha256,
        pdfBytes,
        textSha256,
        structuredArtifactsSha256,
        formulaTeXSha256,
        extractor: {
            version: extraction.extractorVersion,
            textAvailable: textSha256 !== null,
            structuredArtifactsAvailable: structuredArtifactsSha256 !== null,
            formulaTeXAvailable: extraction.formulaTeX.available,
        },
        availability: {
            text: textSha256 !== null,
            structuredArtifacts: structuredArtifactsSha256 !== null,
            formulaTeX: extraction.formulaTeX.available,
        },
    };
    if (ledgerBinding !== null) body.ledgerBinding = requireLedgerBinding(ledgerBinding);
    return body;
}

function signedDescriptor(body) {
    return Object.freeze({ ...body, descriptorSha256: stableSha256(body) });
}

/**
 * 只查看一条已核验的本地 PDF 记录，不写任何东西。`extractPdf` 如果传入，应当是
 * 同步的本地抽取器；它拿到 PDF 字节的副本，可以返回文本或结构化提取结果。不传抽取器也是
 * 合法的，此时相关字段明确写成不可得，而不是编造一份全文。
 */
function buildSource({ cacheRoot, record, maxBytes, extractPdf, ledgerBinding = null } = {}) {
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    const bytes = readVerifiedPdf(root, checked.relativePath, requireMaxBytes(maxBytes));
    const actualPdfSha256 = sha256(bytes);
    if (actualPdfSha256 !== checked.pdfSha256) throw fail('本地 PDF SHA-256 与已核验的会议记录不符');
    if (extractPdf !== undefined && typeof extractPdf !== 'function') throw fail('传入 extractPdf 时，它须为函数');
    const extraction = normalizeExtraction(extractPdf && extractPdf({
        pdfBytes: Buffer.from(bytes), pdfSha256: actualPdfSha256, identity: clone(checked.identity), record: clone(record),
    }));
    const descriptor = signedDescriptor(descriptorBody({ ...checked, pdfBytes: bytes.length, extraction, ledgerBinding }));
    return Object.freeze({
        descriptor,
        text: extraction.text,
        structuredArtifacts: extraction.structuredArtifacts === null ? null : clone(extraction.structuredArtifacts),
        formulaTeX: clone(extraction.formulaTeX),
    });
}

function buildConferencePdfSource({ cacheRoot, record, maxBytes, extractPdf } = {}) {
    return buildSource({ cacheRoot, record, maxBytes, extractPdf });
}

function resolveVerifiedLedgerMember({ sourceRoot, ledgerHandle, identityKey }) {
    let loaded;
    try { loaded = ledgerApi.ledgerHandleSnapshot(ledgerHandle); }
    catch (error) { throw fail(`会议 PDF 来源须使用已经加载、核验并登记的来源清单对象： ${error.message}`); }
    const { ledger, ledgerSha256 } = loaded;
    if (typeof identityKey !== 'string' || !identityKey.trim()) throw fail('identityKey 须为非空的规范来源身份标识');
    const member = ledger.members.find(item => ledgerApi.identityKey(item.identity) === identityKey);
    if (!member) throw fail('identityKey 未对应已加载会议来源清单中的论文');
    if (member.status.state !== 'verified') throw fail('会议 PDF 来源须对应核验状态为 verified 的清单成员');
    const root = requireSafeDirectory(sourceRoot);
    const binding = ledgerBindingForMember(member, ledgerSha256);
    // 首次读取和再次核验时，先检查来源清单绑定的元数据、文本与结构化提取文件。
    // 下方的构建或重新核验函数另行读取 PDF，避免直接信任先前保存的描述对象。
    readVerifiedArtifact(root, member.metadataFile, member.metadataSha256, '会议元数据文件');
    readVerifiedArtifact(root, member.textFile, member.textSha256, '会议全文文件');
    readVerifiedArtifact(root, member.artifactsFile, member.artifactsSha256, '会议结构化提取文件');
    return { root, member: clone(member), binding };
}

/**
 * 只从已加载并核验的来源清单读取 PDF 位置、身份与来源哈希；
 * 不接受调用方另行提供的 PDF 记录。
 */
function buildConferencePdfSourceFromLedger({ sourceRoot, ledgerHandle, identityKey, maxBytes, extractPdf } = {}) {
    const checked = resolveVerifiedLedgerMember({ sourceRoot, ledgerHandle, identityKey });
    return buildSource({
        cacheRoot: checked.root,
        record: { identity: checked.member.identity, pdfRelativePath: checked.member.pdfFile, pdfSha256: checked.member.pdfSha256 },
        maxBytes,
        extractPdf,
        ledgerBinding: checked.binding,
    });
}

/** 核对 PDF 描述对象的字段、哈希格式、可用状态，以及预期的来源清单绑定。 */
function validateDescriptorBody(body, expectedLedgerBinding) {
    const baseFields = [
        'contract', 'version', 'kind', 'identity', 'pdfRelativePath', 'pdfSha256', 'pdfBytes',
        'textSha256', 'structuredArtifactsSha256', 'formulaTeXSha256', 'extractor', 'availability'
    ];
    const fields = expectedLedgerBinding === null ? baseFields : [...baseFields, 'ledgerBinding'];
    requireExactKeys(body, fields, 'PDF 描述对象');
    if (body.contract !== CONTRACT || body.version !== VERSION || body.kind !== KIND) {
        throw fail('PDF 描述对象的 contract、version 或 kind 不属于支持的组合');
    }
    const checked = requireRecord({ identity: body.identity, pdfRelativePath: body.pdfRelativePath, pdfSha256: body.pdfSha256 });
    if (!Number.isSafeInteger(body.pdfBytes) || body.pdfBytes < 5) throw fail('PDF 描述对象的 pdfBytes 必须是至少 5 的整数，且不超过 JavaScript 能精确表示的整数上限');
    for (const field of ['textSha256', 'structuredArtifactsSha256', 'formulaTeXSha256']) requireDescriptorHash(body[field], `PDF 描述对象 ${field}`);
    requireExactKeys(body.extractor, ['version', 'textAvailable', 'structuredArtifactsAvailable', 'formulaTeXAvailable'], 'PDF 描述对象 extractor');
    if (typeof body.extractor.version !== 'string' || !body.extractor.version.trim()) throw fail('PDF 描述对象的提取器版本须为非空字符串');
    requireExactKeys(body.availability, ['text', 'structuredArtifacts', 'formulaTeX'], 'PDF 描述对象 availability');
    for (const field of ['text', 'structuredArtifacts', 'formulaTeX']) {
        if (typeof body.availability[field] !== 'boolean' || typeof body.extractor[`${field}Available`] !== 'boolean') {
            throw fail('PDF 描述对象的可用状态和提取器可用状态均须为布尔值');
        }
        const hashField = field === 'text' ? 'textSha256' : field === 'structuredArtifacts' ? 'structuredArtifactsSha256' : 'formulaTeXSha256';
        const present = body[hashField] !== null;
        if (body.availability[field] !== present || body.extractor[`${field}Available`] !== present) {
            throw fail('PDF 描述对象的可用状态、哈希是否存在及提取器状态彼此冲突');
        }
    }
    if (body.availability.formulaTeX && !body.availability.structuredArtifacts) {
        throw fail('声明 PDF 公式可用时，还须声明结构化提取结果可用');
    }
    if (expectedLedgerBinding !== null && stableJson(requireLedgerBinding(body.ledgerBinding)) !== stableJson(expectedLedgerBinding)) {
        throw fail('PDF 描述对象未绑定本次已加载的来源清单成员');
    }
    return checked;
}

function replaySource({ cacheRoot, record, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes, expectedLedgerBinding = null } = {}) {
    if (!isPlainObject(descriptor) || descriptor.contract !== CONTRACT || descriptor.version !== VERSION || descriptor.kind !== KIND) {
        throw fail('PDF 描述对象的 contract、version 或 kind 不属于支持的组合');
    }
    const { descriptorSha256, ...body } = descriptor;
    if (!isSha256(descriptorSha256) || stableSha256(body) !== descriptorSha256) throw fail('PDF 描述对象的校验信息无效，或与其内容不符');
    const bodyRecord = validateDescriptorBody(body, expectedLedgerBinding);
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    if (stableJson(checked.identity) !== stableJson(bodyRecord.identity) || checked.relativePath !== bodyRecord.relativePath
        || checked.pdfSha256 !== body.pdfSha256) throw fail('PDF 描述对象的身份、路径或 PDF SHA 未对应本次已核验记录');
    const bytes = readVerifiedPdf(root, checked.relativePath, requireMaxBytes(maxBytes));
    if (bytes.length !== body.pdfBytes || sha256(bytes) !== body.pdfSha256) throw fail('PDF 当前字节数或 SHA 与描述对象记录不符');
    if ((body.textSha256 === null) !== (text === null) || (text !== null && (typeof text !== 'string' || sha256(text) !== body.textSha256))) {
        throw fail('PDF 文本的有无、类型或 SHA 与描述对象记录不符');
    }
    if ((body.structuredArtifactsSha256 === null) !== (structuredArtifacts === null)
        || (structuredArtifacts !== null && (!isPlainObject(structuredArtifacts)
            || stableSha256(structuredArtifacts) !== body.structuredArtifactsSha256))) {
        throw fail('PDF 结构化提取结果是否存在、类型或 SHA 未对应描述对象记录');
    }
    if ((body.formulaTeXSha256 === null) !== (formulaTeX === null)
        || (formulaTeX !== null && (!isPlainObject(formulaTeX)
            || stableSha256(formulaTeX) !== body.formulaTeXSha256))) {
        throw fail('PDF 公式 TeX 是否存在、类型或 SHA 未对应描述对象记录');
    }
    return Object.freeze(clone(descriptor));
}

function replayConferencePdfSource({ cacheRoot, record, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes } = {}) {
    return replaySource({ cacheRoot, record, descriptor, text, structuredArtifacts, formulaTeX, maxBytes });
}

/**
 * 按首次核验时使用的同一份来源清单 SHA 和论文身份重新核验。
 * 已绑定来源清单的描述对象不能通过上方只接收记录对象的接口读取。
 */
function replayConferencePdfSourceFromLedger({ sourceRoot, ledgerHandle, identityKey, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes } = {}) {
    const checked = resolveVerifiedLedgerMember({ sourceRoot, ledgerHandle, identityKey });
    return replaySource({
        cacheRoot: checked.root,
        record: { identity: checked.member.identity, pdfRelativePath: checked.member.pdfFile, pdfSha256: checked.member.pdfSha256 },
        descriptor,
        text,
        structuredArtifacts,
        formulaTeX,
        maxBytes,
        expectedLedgerBinding: checked.binding,
    });
}

module.exports = {
    CONTRACT,
    VERSION,
    KIND,
    DEFAULT_MAX_PDF_BYTES,
    buildConferencePdfSource,
    replayConferencePdfSource,
    buildConferencePdfSourceFromLedger,
    replayConferencePdfSourceFromLedger,
    // 供来源清单处理入口在不读取 PDF 时预先检查记录字段。
    requireRecord,
};
