'use strict';

// 这个模块有意不认识会议 ledger、LLM 和网络。调用方传入一条已经匹配并核验过的
// ledger 记录，它把本地不可变的 PDF 和可选的本地抽取结果，整理成一个可以在分析前
// 再核对一次的小描述对象。

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
                throw fail(`Descriptor data has a non-JSON value at ${key}`);
            }
            return [key, canonicalize(value[key])];
        }));
    }
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw fail('Descriptor data must be JSON-safe');
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
    if (typeof directory !== 'string' || !directory) throw fail('cacheRoot must be a non-empty path');
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT') throw fail(`PDF cache root does not exist: ${absolute}`);
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`Unsafe PDF cache directory: ${cursor}`);
    }
    return absolute;
}

function requireRelativePdfPath(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')
        || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
        throw fail('PDF path must be a non-empty relative path');
    }
    // ledger 里的路径统一用 POSIX 分隔符保存。两种点分量都拒绝，ledger 才能在 Windows
    // 和 POSIX 主机之间通用。
    if (relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
        throw fail('PDF path cannot contain traversal or ambiguous components');
    }
    return relativePath;
}

function requireRecord(record) {
    if (!isPlainObject(record)) throw fail('Verified conference record must be an object');
    if (!isPlainObject(record.identity) || !Object.keys(record.identity).length) {
        throw fail('Verified conference record requires a non-empty identity object');
    }
    const identity = clone(record.identity);
    const relativePath = requireRelativePdfPath(record.pdfRelativePath);
    if (!isSha256(record.pdfSha256)) throw fail('Verified conference record requires a lowercase PDF SHA-256');
    return { identity, relativePath, pdfSha256: record.pdfSha256 };
}

function requireExactKeys(value, keys, name) {
    if (!isPlainObject(value)) throw fail(`${name} must be a plain object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw fail(`${name} has unexpected or missing fields`);
    }
}

function requireDescriptorHash(value, name) {
    if (value !== null && !isSha256(value)) throw fail(`${name} must be a lowercase SHA-256 or null`);
}

function requireLedgerBinding(value) {
    requireExactKeys(value, ['ledgerSha256', 'identityKey', 'metadataSha256', 'textSha256', 'artifactsSha256'], 'Conference PDF ledger binding');
    if (!isSha256(value.ledgerSha256)) throw fail('Conference PDF ledger binding requires a lowercase ledger SHA-256');
    if (typeof value.identityKey !== 'string' || !value.identityKey.trim()) {
        throw fail('Conference PDF ledger binding requires a non-empty identity key');
    }
    for (const field of ['metadataSha256', 'textSha256', 'artifactsSha256']) {
        if (!isSha256(value[field])) throw fail(`Conference PDF ledger binding requires ${field}`);
    }
    return clone(value);
}

function ledgerBindingForMember(member, ledgerSha256) {
    if (!isSha256(ledgerSha256)) throw fail('ledgerSha256 must be a lowercase SHA-256');
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
        throw fail(`maxBytes must be an integer from 1 to ${ABSOLUTE_MAX_PDF_BYTES}`);
    }
    return maxBytes;
}

function safePdfFilename(cacheRoot, relativePath) {
    const target = path.resolve(cacheRoot, relativePath);
    const relative = path.relative(cacheRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('PDF path escapes cache root');
    let cursor = cacheRoot;
    for (const part of relative.split(path.sep).slice(0, -1)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code === 'ENOENT') throw fail(`PDF cache directory is missing: ${cursor}`);
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`Unsafe PDF cache directory: ${cursor}`);
    }
    return target;
}

function readVerifiedPdf(cacheRoot, relativePath, maxBytes) {
    const filename = safePdfFilename(cacheRoot, relativePath);
    let beforeOpen;
    try { beforeOpen = fs.lstatSync(filename); }
    catch (error) { throw error; }
    if (beforeOpen.isSymbolicLink()) throw fail('PDF must be a regular, non-linked cache file');
    let fd;
    try {
        try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
        catch (error) {
            // lstat 与 open 这一对有意重复：lstat 给出确定可复现的错误，O_NOFOLLOW 则
            // 堵住两者之间被换文件的窗口。
            if (error.code === 'ELOOP') throw fail('PDF must be a regular, non-linked cache file');
            throw error;
        }
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino) {
            throw fail('PDF must be a regular, non-linked cache file');
        }
        if (opened.size < 5 || opened.size > maxBytes) throw fail('PDF is empty or exceeds the configured size limit');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
            throw fail('Local source is not a standard PDF');
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
        try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
        catch (error) {
            if (error.code === 'ELOOP') throw fail(`${label} must be a regular, non-linked cache file`);
            throw error;
        }
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino) {
            throw fail(`${label} must be a regular, non-linked cache file`);
        }
        const bytes = fs.readFileSync(fd);
        if (sha256(bytes) !== expectedSha256) throw fail(`${label} SHA-256 differs from the verified conference ledger`);
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
    if (!isPlainObject(value)) throw fail('Local PDF extractor result must be an object');
    const extractorVersion = typeof value.extractorVersion === 'string' && value.extractorVersion.trim()
        ? value.extractorVersion.trim() : null;
    if (!extractorVersion) throw fail('Local PDF extractor requires a version');
    const text = value.text === undefined || value.text === null ? null : value.text;
    if (text !== null && typeof text !== 'string') throw fail('Extracted PDF text must be a string or null');
    const structuredArtifacts = value.structuredArtifacts === undefined || value.structuredArtifacts === null
        ? null : value.structuredArtifacts;
    if (structuredArtifacts !== null && !isPlainObject(structuredArtifacts)) {
        throw fail('Structured PDF artifacts must be an object or null');
    }
    const formulaTeX = value.formulaTeX === undefined || value.formulaTeX === null
        ? { available: false, reason: 'no-reliable-structured-tex' } : value.formulaTeX;
    if (!isPlainObject(formulaTeX) || typeof formulaTeX.available !== 'boolean') {
        throw fail('formulaTeX must explicitly declare availability');
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
        throw fail('PDF formula TeX cannot be available without reliable structured TeX artifacts');
    }
    const formulas = formulaTeX.formulas.map((formula, index) => {
        if (!isPlainObject(formula) || typeof formula.tex !== 'string' || !formula.tex.trim()
            || typeof formula.sourceRef !== 'string' || !formula.sourceRef.trim()) {
            throw fail(`Reliable formula TeX entry ${index} lacks tex or sourceRef`);
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
 * 同步的本地抽取器；它拿到字节的副本，可以返回文本或结构化产物。不传抽取器也是
 * 合法的，此时相关字段明确写成不可得，而不是编造一份全文。
 */
function buildSource({ cacheRoot, record, maxBytes, extractPdf, ledgerBinding = null } = {}) {
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    const bytes = readVerifiedPdf(root, checked.relativePath, requireMaxBytes(maxBytes));
    const actualPdfSha256 = sha256(bytes);
    if (actualPdfSha256 !== checked.pdfSha256) throw fail('Local PDF SHA-256 differs from the verified conference record');
    if (extractPdf !== undefined && typeof extractPdf !== 'function') throw fail('extractPdf must be a function when supplied');
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
    catch (error) { throw fail(`Conference PDF source requires an authenticated loaded ledger handle: ${error.message}`); }
    const { ledger, ledgerSha256 } = loaded;
    if (typeof identityKey !== 'string' || !identityKey.trim()) throw fail('identityKey must be a non-empty canonical ledger identity');
    const member = ledger.members.find(item => ledgerApi.identityKey(item.identity) === identityKey);
    if (!member) throw fail('identityKey does not identify a member in the loaded conference ledger');
    if (member.status.state !== 'verified') throw fail('Conference PDF source requires a verified ledger member');
    const root = requireSafeDirectory(sourceRoot);
    const binding = ledgerBindingForMember(member, ledgerSha256);
    // 在准入和重新核对时都检查 ledger 绑定的四份产物。下面的 build/replay 还会再读一次
    // PDF；这处有意重复，堵住 ledger 与适配器描述对象之间被替换的可能。
    readVerifiedArtifact(root, member.metadataFile, member.metadataSha256, 'Conference metadata artifact');
    readVerifiedArtifact(root, member.textFile, member.textSha256, 'Conference text artifact');
    readVerifiedArtifact(root, member.artifactsFile, member.artifactsSha256, 'Conference structured-artifacts file');
    return { root, member: clone(member), binding };
}

/**
 * 只走 ledger 的准入桥。它从不接受调用方自己给的 PDF 记录：PDF 位置、身份和所有
 * 来源哈希都来自传入的、已加载的 ledger 成员。
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

/** 重新读取不可变的 PDF，确认之前保存的描述对象和产物仍然能对上。 */
function validateDescriptorBody(body, expectedLedgerBinding) {
    const baseFields = [
        'contract', 'version', 'kind', 'identity', 'pdfRelativePath', 'pdfSha256', 'pdfBytes',
        'textSha256', 'structuredArtifactsSha256', 'formulaTeXSha256', 'extractor', 'availability'
    ];
    const fields = expectedLedgerBinding === null ? baseFields : [...baseFields, 'ledgerBinding'];
    requireExactKeys(body, fields, 'Conference PDF descriptor');
    if (body.contract !== CONTRACT || body.version !== VERSION || body.kind !== KIND) {
        throw fail('Conference PDF descriptor has an unsupported contract');
    }
    const checked = requireRecord({ identity: body.identity, pdfRelativePath: body.pdfRelativePath, pdfSha256: body.pdfSha256 });
    if (!Number.isSafeInteger(body.pdfBytes) || body.pdfBytes < 5) throw fail('Conference PDF descriptor has invalid PDF byte length');
    for (const field of ['textSha256', 'structuredArtifactsSha256', 'formulaTeXSha256']) requireDescriptorHash(body[field], `Conference PDF descriptor ${field}`);
    requireExactKeys(body.extractor, ['version', 'textAvailable', 'structuredArtifactsAvailable', 'formulaTeXAvailable'], 'Conference PDF descriptor extractor');
    if (typeof body.extractor.version !== 'string' || !body.extractor.version.trim()) throw fail('Conference PDF descriptor extractor version is invalid');
    requireExactKeys(body.availability, ['text', 'structuredArtifacts', 'formulaTeX'], 'Conference PDF descriptor availability');
    for (const field of ['text', 'structuredArtifacts', 'formulaTeX']) {
        if (typeof body.availability[field] !== 'boolean' || typeof body.extractor[`${field}Available`] !== 'boolean') {
            throw fail('Conference PDF descriptor availability must be explicit booleans');
        }
        const hashField = field === 'text' ? 'textSha256' : field === 'structuredArtifacts' ? 'structuredArtifactsSha256' : 'formulaTeXSha256';
        const present = body[hashField] !== null;
        if (body.availability[field] !== present || body.extractor[`${field}Available`] !== present) {
            throw fail('Conference PDF descriptor availability, hash, and extractor fields are internally inconsistent');
        }
    }
    if (body.availability.formulaTeX && !body.availability.structuredArtifacts) {
        throw fail('Conference PDF formula availability requires structured artifacts');
    }
    if (expectedLedgerBinding !== null && stableJson(requireLedgerBinding(body.ledgerBinding)) !== stableJson(expectedLedgerBinding)) {
        throw fail('Conference PDF descriptor does not belong to this loaded ledger member');
    }
    return checked;
}

function replaySource({ cacheRoot, record, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes, expectedLedgerBinding = null } = {}) {
    if (!isPlainObject(descriptor) || descriptor.contract !== CONTRACT || descriptor.version !== VERSION || descriptor.kind !== KIND) {
        throw fail('Conference PDF descriptor has an unsupported contract');
    }
    const { descriptorSha256, ...body } = descriptor;
    if (!isSha256(descriptorSha256) || stableSha256(body) !== descriptorSha256) throw fail('Conference PDF descriptor checksum changed');
    const bodyRecord = validateDescriptorBody(body, expectedLedgerBinding);
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    if (stableJson(checked.identity) !== stableJson(bodyRecord.identity) || checked.relativePath !== bodyRecord.relativePath
        || checked.pdfSha256 !== body.pdfSha256) throw fail('Conference PDF descriptor does not belong to this verified record');
    const bytes = readVerifiedPdf(root, checked.relativePath, requireMaxBytes(maxBytes));
    if (bytes.length !== body.pdfBytes || sha256(bytes) !== body.pdfSha256) throw fail('Conference PDF bytes no longer replay the descriptor');
    if ((body.textSha256 === null) !== (text === null) || (text !== null && (typeof text !== 'string' || sha256(text) !== body.textSha256))) {
        throw fail('Conference PDF text artifact does not replay the descriptor');
    }
    if ((body.structuredArtifactsSha256 === null) !== (structuredArtifacts === null)
        || (structuredArtifacts !== null && (!isPlainObject(structuredArtifacts)
            || stableSha256(structuredArtifacts) !== body.structuredArtifactsSha256))) {
        throw fail('Conference PDF structured artifacts do not replay the descriptor');
    }
    if ((body.formulaTeXSha256 === null) !== (formulaTeX === null)
        || (formulaTeX !== null && (!isPlainObject(formulaTeX)
            || stableSha256(formulaTeX) !== body.formulaTeXSha256))) {
        throw fail('Conference PDF formula TeX artifact does not replay the descriptor');
    }
    return Object.freeze(clone(descriptor));
}

function replayConferencePdfSource({ cacheRoot, record, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes } = {}) {
    return replaySource({ cacheRoot, record, descriptor, text, structuredArtifacts, formulaTeX, maxBytes });
}

/**
 * 只按准入时用过的同一份 ledger SHA 和规范身份重新核对。绑定 ledger 的描述对象
 * 有意不允许走上面那个只认记录对象的 API。
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
    // 供 ledger 适配器在不读 PDF 的情况下预检记录。
    requireRecord,
};
