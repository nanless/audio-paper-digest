'use strict';

// This module deliberately knows nothing about a conference ledger, an LLM, or
// a network.  A caller gives it a ledger record that has already been matched
// and verified; it turns the local, immutable PDF and optional local extraction
// output into a small descriptor that can be checked again before analysis.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    // Paths are stored in ledgers using POSIX separators. Refusing both kinds of
    // dot component also makes a ledger portable across Windows and POSIX hosts.
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
            // The lstat/open pair is intentionally redundant: lstat gives a
            // useful deterministic error, while O_NOFOLLOW closes the swap
            // race between it and open.
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
    // PDF text is not TeX. A later reader may only render formulae when an
    // extractor supplied a replayable, explicitly reliable TeX structure.
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

function descriptorBody({ identity, relativePath, pdfSha256, pdfBytes, extraction }) {
    const textSha256 = extraction.text === null ? null : sha256(extraction.text);
    const structuredArtifactsSha256 = extraction.structuredArtifacts === null ? null : stableSha256(extraction.structuredArtifacts);
    const formulaTeXSha256 = extraction.formulaTeX.available ? stableSha256(extraction.formulaTeX) : null;
    return {
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
}

function signedDescriptor(body) {
    return Object.freeze({ ...body, descriptorSha256: stableSha256(body) });
}

/**
 * Inspect a verified local-PDF record without writing anything. `extractPdf`,
 * if supplied, is a synchronous local extractor. It receives a copy of bytes
 * and may return text/structured artifacts; absent extractors are valid and
 * result in explicit unavailable fields rather than an invented full text.
 */
function buildConferencePdfSource({ cacheRoot, record, maxBytes, extractPdf } = {}) {
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    const bytes = readVerifiedPdf(root, checked.relativePath, requireMaxBytes(maxBytes));
    const actualPdfSha256 = sha256(bytes);
    if (actualPdfSha256 !== checked.pdfSha256) throw fail('Local PDF SHA-256 differs from the verified conference record');
    if (extractPdf !== undefined && typeof extractPdf !== 'function') throw fail('extractPdf must be a function when supplied');
    const extraction = normalizeExtraction(extractPdf && extractPdf({
        pdfBytes: Buffer.from(bytes), pdfSha256: actualPdfSha256, identity: clone(checked.identity), record: clone(record),
    }));
    const descriptor = signedDescriptor(descriptorBody({ ...checked, pdfBytes: bytes.length, extraction }));
    return Object.freeze({
        descriptor,
        text: extraction.text,
        structuredArtifacts: extraction.structuredArtifacts === null ? null : clone(extraction.structuredArtifacts),
        formulaTeX: clone(extraction.formulaTeX),
    });
}

/** Re-read the immutable PDF and prove a previously persisted descriptor/artifacts still replay it. */
function replayConferencePdfSource({ cacheRoot, record, descriptor, text = null, structuredArtifacts = null, formulaTeX = null, maxBytes } = {}) {
    if (!isPlainObject(descriptor) || descriptor.contract !== CONTRACT || descriptor.version !== VERSION || descriptor.kind !== KIND) {
        throw fail('Conference PDF descriptor has an unsupported contract');
    }
    const { descriptorSha256, ...body } = descriptor;
    if (!isSha256(descriptorSha256) || stableSha256(body) !== descriptorSha256) throw fail('Conference PDF descriptor checksum changed');
    const root = requireSafeDirectory(cacheRoot);
    const checked = requireRecord(record);
    if (stableJson(checked.identity) !== stableJson(body.identity) || checked.relativePath !== body.pdfRelativePath
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
    if (body.availability?.formulaTeX === true && body.extractor?.formulaTeXAvailable !== true) {
        throw fail('Conference PDF formula availability is internally inconsistent');
    }
    return Object.freeze(clone(descriptor));
}

module.exports = {
    CONTRACT,
    VERSION,
    KIND,
    DEFAULT_MAX_PDF_BYTES,
    buildConferencePdfSource,
    replayConferencePdfSource,
    // Exported for ledger adapters to preflight records without reading a PDF.
    requireRecord,
};
