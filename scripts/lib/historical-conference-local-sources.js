'use strict';

// Collect retained conference crawler inputs without touching historical
// pages.  This module deliberately does not import the crosswalk, blog, LLM,
// network, or old-analysis code paths.  It keeps only stable local source
// coordinates: a conference ID, metadata snapshot position, and PDF bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');

const CONTRACT = 'historical-conference-local-sources-v1';
const VERSION = 1;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;

class HistoricalConferenceLocalSourcesError extends Error {
    constructor(message) {
        super(`Historical conference local sources rejected: ${message}`);
        this.name = 'HistoricalConferenceLocalSourcesError';
        this.code = 'HISTORICAL_CONFERENCE_LOCAL_SOURCES_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalConferenceLocalSourcesError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeDirectory(directory, label, { create = false } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be an absolute directory`);
    const resolved = path.resolve(directory);
    if (!fs.existsSync(resolved)) {
        if (!create) fail(`${label} does not exist`);
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`);
    return resolved;
}
function readStableFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be an absolute file`);
    const absolute = path.resolve(filename);
    safeDirectory(path.dirname(absolute), `${label} parent`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolute);
        if (!opened.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino
            || opened.size > maxBytes) fail(`${label} is unsafe or too large`);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail(`${label} changed while read`);
        }
        return { absolute, bytes, sha256: sha256(bytes) };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}
function hashAvailablePdf(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
        return { availability: 'invalid-path', absolutePath: null, bytes: null, sha256: null };
    }
    const absolutePath = path.resolve(filename);
    let fd;
    try {
        fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolutePath);
        if (!opened.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino
            || opened.size > MAX_PDF_BYTES) {
            return { availability: 'invalid-file', absolutePath, bytes: null, sha256: null };
        }
        const initial = Buffer.alloc(5);
        const initialRead = fs.readSync(fd, initial, 0, initial.length, 0);
        if (initialRead !== initial.length || initial.toString('ascii') !== '%PDF-') {
            return { availability: 'invalid-pdf', absolutePath, bytes: opened.size, sha256: null };
        }
        const hash = crypto.createHash('sha256');
        const chunk = Buffer.alloc(1024 * 1024);
        let offset = 0;
        while (offset < opened.size) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
            if (count <= 0) fail('local PDF changed while read');
            hash.update(chunk.subarray(0, count));
            offset += count;
        }
        const after = fs.fstatSync(fd);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail('local PDF changed while read');
        return { availability: 'available', absolutePath, bytes: opened.size, sha256: hash.digest('hex') };
    } catch (error) {
        if (error instanceof HistoricalConferenceLocalSourcesError) throw error;
        if (error.code === 'ENOENT') return { availability: 'missing', absolutePath, bytes: null, sha256: null };
        return { availability: 'unreadable', absolutePath, bytes: null, sha256: null };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}
function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail('metadata JSON has duplicate keys');
            top.keys.add(key); top.expectKey = false;
        }
    }
}
function readMetadataArray(metadataPath, { sourceSet, shape }) {
    const loaded = readStableFile(metadataPath, `${sourceSet} metadata`, MAX_METADATA_BYTES);
    let parsed;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text); parsed = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalConferenceLocalSourcesError) throw error;
        fail(`${sourceSet} metadata is not strict UTF-8 JSON`);
    }
    const records = shape === 'array' ? parsed : parsed?.papers;
    if (!Array.isArray(records)) fail(`${sourceSet} metadata does not contain the expected record array`);
    return { absolutePath: loaded.absolute, sha256: loaded.sha256, records };
}
function validId(scheme, value) {
    return scheme === 'icassp-arnumber' ? /^[1-9]\d*$/.test(value)
        : /^[A-Za-z0-9_-]{6,128}$/.test(value);
}
function externalIdFor(record, spec) {
    if (!plain(record)) return null;
    const values = spec.idFields.filter(field => record[field] !== undefined && record[field] !== null)
        .map(field => String(record[field]));
    if (!values.length || new Set(values).size !== 1 || !values.every(value => validId(spec.scheme, value))) return null;
    return { scheme: spec.scheme, value: values[0] };
}
function localSourceSets({ dataRoot, iclrAcceptedRoot }) {
    const data = safeDirectory(dataRoot, 'dataRoot');
    const accepted = safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot');
    return [
        { sourceSet: 'workspace-icassp-2026', provenance: 'retained-local-crawler', conference: { slug: 'icassp', year: 2026 },
            scheme: 'icassp-arnumber', idFields: ['arnumber', 'paper_id'], metadataPath: path.join(data, 'current', 'icassp_2026_deep_analyzers.json'),
            shape: 'object-papers', pdfPath: record => record.pdfPath },
        { sourceSet: 'workspace-iclr-2026', provenance: 'retained-local-crawler', conference: { slug: 'iclr', year: 2026 },
            scheme: 'openreview-forum-id', idFields: ['forum_id', 'paper_id', 'arnumber'], metadataPath: path.join(data, 'current', 'iclr_2026_deep_analyzers.json'),
            shape: 'object-papers', pdfPath: record => record.pdfPath },
        { sourceSet: 'workspace-icml-2026', provenance: 'retained-local-crawler', conference: { slug: 'icml', year: 2026 },
            scheme: 'openreview-forum-id', idFields: ['id'], metadataPath: path.join(data, 'current', 'icml_2026_deep_analysis.json'),
            shape: 'object-papers', pdfPath: (_record, externalId) => path.join(data, 'pdfs', 'icml2026', `${externalId.value}.pdf`) },
        { sourceSet: 'accepted-local-iclr-2026', provenance: 'retained-local-accepted-crawler', conference: { slug: 'iclr', year: 2026 },
            scheme: 'openreview-forum-id', idFields: ['forum_id'], metadataPath: path.join(accepted, 'data', 'iclr2026_accepted.json'),
            shape: 'array', pdfPath: (_record, externalId) => path.join(accepted, 'data', 'pdfs', `${externalId.value}.pdf`) }
    ];
}
function manifestSourceRecord({ spec, metadata, recordIndex, externalId, pdf }) {
    const paperId = identityApi.canonicalConferenceId(spec.conference, externalId);
    const metadataIdentityBindingSha256 = stableHash({ paperId, sourceSet: spec.sourceSet,
        metadataSnapshotSha256: metadata.sha256, recordIndex, externalId });
    return { paperId, conference: clone(spec.conference), externalId, source: {
        provenance: spec.provenance, sourceSet: spec.sourceSet,
        metadata: { absolutePath: metadata.absolutePath, sha256: metadata.sha256, recordIndex, metadataIdentityBindingSha256 },
        pdf
    } };
}
function assertManifest(value) {
    if (!plain(value) || value.contract !== CONTRACT || value.version !== VERSION || !Array.isArray(value.records)
        || !plain(value.summary) || !SHA_RE.test(String(value.manifestSha256 || ''))) fail('local source manifest has an invalid envelope');
    const body = clone(value); delete body.manifestSha256;
    if (value.manifestSha256 !== stableHash(body)) fail('local source manifest SHA drifted');
    let previous = '';
    for (const record of value.records) {
        if (!plain(record) || typeof record.paperId !== 'string' || (previous && record.paperId.localeCompare(previous) <= 0)
            || !Array.isArray(record.sources) || !record.sources.length) {
            fail('local source manifest records are malformed or unordered');
        }
        previous = record.paperId;
        for (const source of record.sources) {
            if (!plain(source) || !plain(source.metadata) || !plain(source.pdf)
                || !SHA_RE.test(String(source.metadata.sha256 || '')) || !SHA_RE.test(String(source.metadata.metadataIdentityBindingSha256 || ''))
                || typeof source.metadata.absolutePath !== 'string' || !path.isAbsolute(source.metadata.absolutePath)
                || !['available', 'missing', 'invalid-path', 'invalid-file', 'invalid-pdf', 'unreadable'].includes(source.pdf.availability)) {
                fail('local source manifest source is malformed');
            }
            if (source.pdf.availability === 'available' && (!SHA_RE.test(String(source.pdf.sha256 || ''))
                || !Number.isSafeInteger(source.pdf.bytes) || source.pdf.bytes < 5 || typeof source.pdf.absolutePath !== 'string')) {
                fail('available local PDF entry is malformed');
            }
        }
    }
    return value;
}
function buildLocalSourcesManifest({ dataRoot, iclrAcceptedRoot, sourceSets = null } = {}) {
    const specs = sourceSets || localSourceSets({ dataRoot, iclrAcceptedRoot });
    if (!Array.isArray(specs) || !specs.length) fail('source sets are required');
    const hashCache = new Map();
    const grouped = new Map();
    const sourceSummaries = [];
    for (const spec of specs) {
        if (!plain(spec) || typeof spec.sourceSet !== 'string' || !plain(spec.conference) || !Array.isArray(spec.idFields)
            || typeof spec.metadataPath !== 'string' || typeof spec.pdfPath !== 'function') fail('source set is malformed');
        const metadata = readMetadataArray(spec.metadataPath, spec);
        let validMetadata = 0; let invalidIdentity = 0; let availablePdf = 0; let unavailablePdf = 0;
        metadata.records.forEach((record, recordIndex) => {
            const externalId = externalIdFor(record, spec);
            if (!externalId) { invalidIdentity += 1; return; }
            validMetadata += 1;
            const pdfPath = spec.pdfPath(record, externalId);
            const cacheKey = typeof pdfPath === 'string' && path.isAbsolute(pdfPath) ? path.resolve(pdfPath) : `invalid:${String(pdfPath)}`;
            let pdf = hashCache.get(cacheKey);
            if (!pdf) { pdf = hashAvailablePdf(pdfPath); hashCache.set(cacheKey, pdf); }
            if (pdf.availability === 'available') availablePdf += 1; else unavailablePdf += 1;
            const item = manifestSourceRecord({ spec, metadata, recordIndex, externalId, pdf: clone(pdf) });
            const variants = grouped.get(item.paperId) || [];
            variants.push(item.source); grouped.set(item.paperId, variants);
        });
        sourceSummaries.push({ sourceSet: spec.sourceSet, provenance: spec.provenance, conference: clone(spec.conference),
            metadata: { absolutePath: metadata.absolutePath, sha256: metadata.sha256 }, records: {
                total: metadata.records.length, validIdentity: validMetadata, invalidIdentity, availablePdf, unavailablePdf
            } });
    }
    const records = [...grouped.entries()].map(([paperId, sources]) => ({ paperId, sources: sources.sort((left, right) => left.sourceSet.localeCompare(right.sourceSet)) }))
        .sort((left, right) => left.paperId.localeCompare(right.paperId));
    const summary = { sourceSets: sourceSummaries.sort((left, right) => left.sourceSet.localeCompare(right.sourceSet)),
        canonicalPapers: records.length,
        sourceRecords: records.reduce((count, record) => count + record.sources.length, 0),
        directRewriteEligible: records.filter(record => record.sources.some(source => source.pdf.availability === 'available')).length,
        unavailableOnly: records.filter(record => record.sources.every(source => source.pdf.availability !== 'available')).length };
    const body = { contract: CONTRACT, version: VERSION, records, summary };
    return assertManifest({ ...body, manifestSha256: stableHash(body) });
}
function writeManifest({ root, outputName, manifest }) {
    const directory = safeDirectory(root, 'historicalConferenceLocalSourcesDir', { create: true });
    if (!SAFE_JSON_NAME.test(String(outputName || ''))) fail('manifest output name is unsafe');
    const normalized = assertManifest(manifest); const bytes = prettyBytes(normalized); const filename = path.resolve(directory, outputName);
    if (path.dirname(filename) !== directory) fail('manifest output escapes configured directory');
    let fd; let recovered = false;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readStableFile(filename, 'existing local source manifest', MAX_METADATA_BYTES);
        if (!existing.bytes.equals(bytes)) fail('refuses to overwrite a different local source manifest');
        recovered = true;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return { filename, status: recovered ? 'recovered' : 'created', manifestSha256: normalized.manifestSha256, summary: clone(normalized.summary) };
}

module.exports = { CONTRACT, VERSION, SAFE_JSON_NAME, HistoricalConferenceLocalSourcesError, stableHash, prettyBytes,
    externalIdFor, hashAvailablePdf, localSourceSets, buildLocalSourcesManifest, assertManifest, writeManifest };
