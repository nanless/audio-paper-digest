'use strict';

// Independent publication-only metadata sidecars for every historical arXiv
// source. These files never alter a source generation and never enter the
// analysis/model input. The raw official Atom response is replayed on every
// read and is bound to the exact four-file source generation it supplements.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const freshSource = require('./fresh-arxiv-rewrite-source.js');
const freshRun = require('./fresh-rewrite-run.js');
const metadataApi = require('./arxiv-metadata-source.js');

const CONTRACT = 'historical-arxiv-publication-metadata-v1';
const VERSION = 1;
const MANIFEST_NAME = 'metadata-manifest.json';
const METADATA_NAME = 'metadata.json';
const ATOM_NAME = 'metadata.atom.xml';
const FILES = Object.freeze([ATOM_NAME, MANIFEST_NAME, METADATA_NAME]);
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^\d{4}\.\d{4,5}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_ATOM_BYTES = metadataApi.MAX_BYTES;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

class HistoricalArxivPublicationMetadataError extends Error {
    constructor(message) {
        super(`Historical arXiv publication metadata rejected: ${message}`);
        this.name = 'HistoricalArxivPublicationMetadataError';
        this.code = 'HISTORICAL_ARXIV_PUBLICATION_METADATA_INTEGRITY';
        this.retryable = false;
    }
}
const fail = message => { throw new HistoricalArxivPublicationMetadataError(message); };

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const canonicalJson = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail(`${label} schema is invalid`);
};
function arxivId(value) {
    const id = String(value || '').trim().replace(/v\d+$/i, '');
    if (!ID_RE.test(id)) fail('versionless arXiv ID is required');
    return id;
}
function generationName(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('generation must be a positive safe integer');
    return `generation-${String(value).padStart(6, '0')}`;
}
function safeDirectory(directory, create = false, label = 'directory') {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe ${label}: ${cursor}`);
    }
    return absolute;
}
function readPrivateFile(filename, maximum, label) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) fail(`unsafe ${label}`);
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writePrivateFile(directory, name, bytes) {
    const target = path.join(directory, name); let fd;
    try {
        fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function fsyncDirectory(directory) {
    let fd;
    try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sidecarDirectory(rootDir, id, generation) {
    return path.join(path.resolve(rootDir), arxivId(id), generationName(generation));
}
function sourceSnapshotSha(details) {
    return freshRun.stableHash({ paperId: details.paperId, source: details.source, sourceId: details.sourceId,
        textSha256: sha256(Buffer.from(details.text, 'utf8')), structuredArtifacts: details.structuredArtifacts,
        ...(details.sourceVersion ? { sourceVersion: details.sourceVersion } : {}) });
}
function normalizedOfficialResult(id, result) {
    if (!result || typeof result !== 'object' || !Buffer.isBuffer(result.rawBytes)
        && !(result.rawBytes instanceof Uint8Array)) fail('official Atom result and raw bytes are required');
    const rawBytes = Buffer.from(result.rawBytes);
    if (rawBytes.length < 1 || rawBytes.length > MAX_ATOM_BYTES) fail('official Atom response is empty or oversized');
    const proof = result.proof;
    const querySourceId = proof?.querySourceId;
    const replayed = metadataApi.parseOfficialArxivMetadataResponse(id, rawBytes.toString('utf8'), { querySourceId });
    const observedAt = proof?.observedAt;
    if (!proof || proof.contract !== metadataApi.CONTRACT || proof.paperId !== `arxiv:${id}`
        || proof.sourceName !== replayed.proof.sourceName || proof.querySourceId !== replayed.proof.querySourceId
        || proof.fileSha256 !== sha256(rawBytes)
        || proof.recordSha256 !== freshRun.stableHash(replayed.metadata)
        || proof.entryVersion !== replayed.proof.entryVersion
        || proof.entryUpdatedAt !== replayed.proof.entryUpdatedAt
        || proof.publishedAt !== replayed.proof.publishedAt
        || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
        || new Date(observedAt).toISOString() !== observedAt
        || freshRun.stableHash(result.metadata) !== freshRun.stableHash(replayed.metadata)) {
        fail('official Atom result/proof cannot be replayed');
    }
    return { ...replayed, proof: { ...replayed.proof, observedAt } };
}
function sourceBinding(sourceRoot, id, generation) {
    const source = freshSource.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: id, generation });
    const timestamps = [source.manifest.capturedAt, source.manifest.text.fetchedAt, source.manifest.pdf.fetchedAt];
    const milliseconds = timestamps.map(value => new Date(value).getTime());
    if (milliseconds.some(value => !Number.isFinite(value))) fail('sealed source capture timestamps are invalid');
    const sourceVersionIdentitySha256 = source.runtimeDetails.sourceVersion?.identitySha256 || null;
    return { source,
        value: { contract: source.manifest.contract, version: source.manifest.version,
            generation, sourceManifestSha256: source.sourceManifestSha256,
            sourceSnapshotSha256: sourceSnapshotSha(source.runtimeDetails),
            sourceTextSha256: source.manifest.text.responseSha256, sourceId: source.manifest.text.sourceId,
            sourceCapturedAt: source.manifest.capturedAt, textFetchedAt: source.manifest.text.fetchedAt,
            pdfFetchedAt: source.manifest.pdf.fetchedAt,
            sourceEarliestCapturedAt: new Date(Math.min(...milliseconds)).toISOString(),
            sourceLatestCapturedAt: new Date(Math.max(...milliseconds)).toISOString(),
            ...(sourceVersionIdentitySha256 ? { sourceVersionIdentitySha256 } : {}) } };
}
function validateOfficialCompatibility({ sourceRoot, arxivId: value, generation, officialResult } = {}) {
    const id = arxivId(value);
    const source = sourceBinding(sourceRoot, id, generation).value;
    const official = normalizedOfficialResult(id, officialResult);
    if (Date.parse(official.proof.publishedAt) > Date.parse(official.proof.entryUpdatedAt)) {
        fail('official Atom publication time is newer than its update time');
    }
    if (Date.parse(official.proof.entryUpdatedAt) > Date.parse(official.proof.observedAt)) {
        fail('official Atom update time is newer than its observation time');
    }
    if (Date.parse(official.proof.entryUpdatedAt) > Date.parse(source.sourceEarliestCapturedAt)) {
        fail('official Atom entry is newer than the sealed source generation; capture a new source generation');
    }
    const sourceVersion = source.sourceId.match(/v([1-9]\d*)$/i);
    if (sourceVersion && Number(sourceVersion[1]) !== official.proof.entryVersion) {
        fail('official Atom entry version differs from the exact versioned sealed source');
    }
    if (!sourceVersion && Date.parse(official.proof.observedAt) < Date.parse(source.sourceLatestCapturedAt)) {
        fail('official Atom response predates the versionless sealed source; refetch official metadata');
    }
    if (official.proof.querySourceId !== source.sourceId) {
        fail('official Atom query is not bound to the exact sealed source ID');
    }
    return { source, official };
}
function querySourceIdForSource({ sourceRoot, arxivId: value, generation } = {}) {
    const id = arxivId(value);
    return sourceBinding(sourceRoot, id, generation).value.sourceId;
}
function manifestFor({ id, generation, capturedAt, source, official, metadataBytes }) {
    const abstract = official.metadata.abstract;
    return { contract: CONTRACT, version: VERSION, paperId: `arxiv:${id}`, arxivId: id, generation,
        capturedAt: new Date(capturedAt).toISOString(), source,
        atom: { contract: metadataApi.CONTRACT, filename: ATOM_NAME, sourceName: official.proof.sourceName,
            querySourceId: official.proof.querySourceId,
            responseBytes: official.rawBytes.length, responseSha256: official.proof.fileSha256,
            entryVersion: official.proof.entryVersion, entryUpdatedAt: official.proof.entryUpdatedAt,
            publishedAt: official.proof.publishedAt, observedAt: official.proof.observedAt },
        metadata: { filename: METADATA_NAME, responseBytes: metadataBytes.length,
            responseSha256: sha256(metadataBytes), recordSha256: official.proof.recordSha256,
            abstractSha256: sha256(Buffer.from(abstract, 'utf8')) } };
}

function readPublicationMetadata({ rootDir, sourceRoot, arxivId: value, generation } = {}) {
    const id = arxivId(value); const directory = sidecarDirectory(safeDirectory(rootDir), id, generation);
    safeDirectory(path.join(path.resolve(rootDir), id), false, 'publication metadata paper directory');
    safeDirectory(directory, false, 'publication metadata generation directory');
    if (fs.readdirSync(directory).sort().join('\0') !== FILES.slice().sort().join('\0')) {
        fail('publication metadata generation contains unexpected files');
    }
    const manifestBytes = readPrivateFile(path.join(directory, MANIFEST_NAME), MAX_JSON_BYTES, 'publication metadata manifest');
    const metadataBytes = readPrivateFile(path.join(directory, METADATA_NAME), MAX_JSON_BYTES, 'publication metadata record');
    const atomBytes = readPrivateFile(path.join(directory, ATOM_NAME), MAX_ATOM_BYTES, 'publication metadata Atom response');
    let manifest; let metadata;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); metadata = JSON.parse(metadataBytes.toString('utf8')); }
    catch (error) { fail(`publication metadata JSON is invalid: ${error.message}`); }
    if (!manifestBytes.equals(Buffer.from(canonicalJson(manifest)))
        || !metadataBytes.equals(Buffer.from(canonicalJson(metadata)))) fail('publication metadata JSON must be canonical');
    exactKeys(manifest, ['contract', 'version', 'paperId', 'arxivId', 'generation', 'capturedAt', 'source', 'atom', 'metadata'], 'manifest');
    const hasSourceVersion = Object.hasOwn(manifest.source || {}, 'sourceVersionIdentitySha256');
    exactKeys(manifest.source, ['contract', 'version', 'generation', 'sourceManifestSha256', 'sourceSnapshotSha256',
        'sourceTextSha256', 'sourceId', 'sourceCapturedAt', 'textFetchedAt', 'pdfFetchedAt',
        'sourceEarliestCapturedAt', 'sourceLatestCapturedAt',
        ...(hasSourceVersion ? ['sourceVersionIdentitySha256'] : [])], 'source binding');
    exactKeys(manifest.atom, ['contract', 'filename', 'sourceName', 'querySourceId', 'responseBytes', 'responseSha256',
        'entryVersion', 'entryUpdatedAt', 'publishedAt', 'observedAt'], 'Atom binding');
    exactKeys(manifest.metadata, ['filename', 'responseBytes', 'responseSha256', 'recordSha256', 'abstractSha256'], 'metadata binding');
    if (manifest.contract !== CONTRACT || manifest.version !== VERSION || manifest.paperId !== `arxiv:${id}`
        || manifest.arxivId !== id || manifest.generation !== generation
        || !Number.isFinite(Date.parse(manifest.capturedAt)) || new Date(manifest.capturedAt).toISOString() !== manifest.capturedAt
        || manifest.atom.contract !== metadataApi.CONTRACT || manifest.atom.filename !== ATOM_NAME
        || !Number.isSafeInteger(manifest.atom.entryVersion) || manifest.atom.entryVersion < 1
        || ![manifest.atom.entryUpdatedAt, manifest.atom.publishedAt, manifest.atom.observedAt,
            manifest.source.sourceCapturedAt, manifest.source.textFetchedAt, manifest.source.pdfFetchedAt,
            manifest.source.sourceEarliestCapturedAt, manifest.source.sourceLatestCapturedAt]
            .every(item => typeof item === 'string' && Number.isFinite(Date.parse(item))
                && new Date(item).toISOString() === item)
        || manifest.metadata.filename !== METADATA_NAME
        || ![manifest.source.sourceManifestSha256, manifest.source.sourceSnapshotSha256,
            manifest.source.sourceTextSha256, manifest.atom.responseSha256, manifest.metadata.responseSha256,
            manifest.metadata.recordSha256, manifest.metadata.abstractSha256].every(item => SHA_RE.test(String(item || '')))
        || manifest.atom.responseBytes !== atomBytes.length || manifest.atom.responseSha256 !== sha256(atomBytes)
        || manifest.metadata.responseBytes !== metadataBytes.length || manifest.metadata.responseSha256 !== sha256(metadataBytes)) {
        fail('publication metadata manifest bytes or identity drifted');
    }
    if (Date.parse(manifest.capturedAt) < Date.parse(manifest.atom.observedAt)) {
        fail('publication metadata seal predates the official Atom observation');
    }
    const official = metadataApi.parseOfficialArxivMetadataResponse(id, atomBytes.toString('utf8'), {
        querySourceId: manifest.atom.querySourceId
    });
    if (official.proof.sourceName !== manifest.atom.sourceName
        || official.proof.querySourceId !== manifest.atom.querySourceId
        || official.proof.fileSha256 !== manifest.atom.responseSha256
        || official.proof.recordSha256 !== manifest.metadata.recordSha256
        || official.proof.entryVersion !== manifest.atom.entryVersion
        || official.proof.entryUpdatedAt !== manifest.atom.entryUpdatedAt
        || official.proof.publishedAt !== manifest.atom.publishedAt
        || freshRun.stableHash(metadata) !== freshRun.stableHash(official.metadata)
        || sha256(Buffer.from(metadata.abstract, 'utf8')) !== manifest.metadata.abstractSha256) {
        fail('publication metadata record does not replay the raw official Atom response');
    }
    const bound = sourceBinding(sourceRoot, id, generation).value;
    if (freshRun.stableHash(bound) !== freshRun.stableHash(manifest.source)) {
        fail('publication metadata no longer binds the sealed source generation');
    }
    if (Date.parse(manifest.atom.entryUpdatedAt) > Date.parse(bound.sourceEarliestCapturedAt)) {
        fail('official Atom entry is newer than the sealed source generation; capture a new source generation');
    }
    if (Date.parse(manifest.atom.publishedAt) > Date.parse(manifest.atom.entryUpdatedAt)) {
        fail('official Atom publication time is newer than its update time');
    }
    if (Date.parse(manifest.atom.entryUpdatedAt) > Date.parse(manifest.atom.observedAt)) {
        fail('official Atom update time is newer than its observation time');
    }
    const sourceVersion = bound.sourceId.match(/v([1-9]\d*)$/i);
    if (sourceVersion && Number(sourceVersion[1]) !== manifest.atom.entryVersion) {
        fail('official Atom entry version differs from the exact versioned sealed source');
    }
    if (!sourceVersion && Date.parse(manifest.atom.observedAt) < Date.parse(bound.sourceLatestCapturedAt)) {
        fail('official Atom response predates the versionless sealed source; refetch official metadata');
    }
    if (manifest.atom.querySourceId !== bound.sourceId) {
        fail('official Atom query is not bound to the exact sealed source ID');
    }
    if (!Array.isArray(metadata.authors) || metadata.authors.length === 0
        || metadata.authors.some(author => typeof author !== 'string' || !author.trim()
            || author !== author.trim())) {
        fail('publication metadata authors are empty or invalid');
    }
    return { directory, sourceManifestSha256: manifest.source.sourceManifestSha256,
        sourceSnapshotSha256: manifest.source.sourceSnapshotSha256,
        sourceTextSha256: manifest.source.sourceTextSha256, abstract: metadata.abstract,
        authors: metadata.authors.slice(),
        proof: { contract: CONTRACT, paperId: `arxiv:${id}`, manifestSha256: sha256(manifestBytes),
            atomResponseSha256: manifest.atom.responseSha256,
            metadataRecordSha256: manifest.metadata.recordSha256, abstractSha256: manifest.metadata.abstractSha256,
            entryVersion: manifest.atom.entryVersion, entryUpdatedAt: manifest.atom.entryUpdatedAt,
            publishedAt: manifest.atom.publishedAt, observedAt: manifest.atom.observedAt,
            sourceName: manifest.atom.sourceName, querySourceId: manifest.atom.querySourceId,
            sourceManifestSha256: manifest.source.sourceManifestSha256,
            sourceSnapshotSha256: manifest.source.sourceSnapshotSha256,
            sourceTextSha256: manifest.source.sourceTextSha256, sourceId: manifest.source.sourceId,
            sourceCapturedAt: manifest.source.sourceCapturedAt,
            sourceEarliestCapturedAt: manifest.source.sourceEarliestCapturedAt,
            sourceLatestCapturedAt: manifest.source.sourceLatestCapturedAt,
            generation }, manifest, metadata };
}

function sealPublicationMetadata({ rootDir, sourceRoot, arxivId: value, generation,
    officialResult, now = new Date().toISOString() } = {}) {
    const id = arxivId(value); const root = safeDirectory(rootDir, true, 'publication metadata root');
    const target = sidecarDirectory(root, id, generation);
    if (fs.existsSync(target)) return { ...readPublicationMetadata({ rootDir: root, sourceRoot, arxivId: id, generation }),
        status: 'recovered', fetched: false };
    const { source, official } = validateOfficialCompatibility({ sourceRoot, arxivId: id, generation, officialResult });
    const capturedAt = new Date(now).toISOString();
    if (capturedAt !== now || Date.parse(capturedAt) < Date.parse(official.proof.observedAt)) {
        fail('publication metadata seal time is invalid or predates the official Atom observation');
    }
    const paperDirectory = safeDirectory(path.join(root, id), true, 'publication metadata paper directory');
    const temporary = path.join(paperDirectory, `.${generationName(generation)}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    try {
        const metadataBytes = Buffer.from(canonicalJson(official.metadata));
        const manifest = manifestFor({ id, generation, capturedAt, source, official, metadataBytes });
        writePrivateFile(temporary, ATOM_NAME, official.rawBytes);
        writePrivateFile(temporary, METADATA_NAME, metadataBytes);
        writePrivateFile(temporary, MANIFEST_NAME, Buffer.from(canonicalJson(manifest)));
        fsyncDirectory(temporary);
        try { fs.renameSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        }
        fsyncDirectory(paperDirectory);
    } finally {
        if (fs.existsSync(temporary) && path.dirname(temporary) === paperDirectory
            && path.basename(temporary).startsWith(`.${generationName(generation)}.`)
            && path.basename(temporary).endsWith('.tmp')) fs.rmSync(temporary, { recursive: true, force: true });
    }
    return { ...readPublicationMetadata({ rootDir: root, sourceRoot, arxivId: id, generation }),
        status: 'sealed', fetched: true };
}

function reusableOfficialAtomIndex({ freshRewriteRoot, paperIds } = {}) {
    if (!Array.isArray(paperIds) || !paperIds.length || new Set(paperIds).size !== paperIds.length) {
        fail('reusable Atom paper set must be non-empty and duplicate-free');
    }
    const selected = new Set(paperIds.map(arxivId));
    const root = safeDirectory(freshRewriteRoot, false, 'fresh rewrite root');
    const candidates = new Map([...selected].map(id => [id, []]));
    for (const name of fs.readdirSync(root).filter(item => UUID_RE.test(item)).sort()) {
        const directory = path.join(root, name); const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const atomNames = fs.readdirSync(directory).filter(file => /^metadata-\d{4}\.\d{4,5}\.atom\.xml$/.test(file));
        for (const atomName of atomNames) {
            const id = atomName.slice('metadata-'.length, -'.atom.xml'.length);
            if (!selected.has(id)) continue;
            const atomFile = path.join(directory, atomName);
            try {
                const run = freshRun.readRegularJson(path.join(directory, 'run.json')).value;
                const inputs = freshRun.readRegularJson(path.join(directory, 'inputs.json')).value;
                const atom = readPrivateFile(atomFile, MAX_ATOM_BYTES, 'reusable official Atom response');
                const proof = run?.metadataSources?.historicalRawMetadata;
                const queryMatch = String(proof?.sourceName || '').match(/[?&]id_list=([^&]+)&max_results=1$/);
                if (!queryMatch) continue;
                const querySourceId = decodeURIComponent(queryMatch[1]);
                const parsed = metadataApi.parseOfficialArxivMetadataResponse(id, atom.toString('utf8'), { querySourceId });
                const paper = inputs?.papers?.find(item => String(item?.arxivId || item?.paper_id || '').replace(/v\d+$/i, '') === id);
                if (!proof || proof.contract !== metadataApi.CONTRACT || proof.paperId !== `arxiv:${id}`
                    || proof.sourceName !== parsed.proof.sourceName || proof.fileSha256 !== parsed.proof.fileSha256
                    || proof.recordSha256 !== parsed.proof.recordSha256
                    || freshRun.stableHash(paper) !== freshRun.stableHash(parsed.metadata)) continue;
                // Legacy run.createdAt is not part of the fresh-run identity.
                // It may only date an exact immutable vN query; a versionless
                // candidate needs its own proof-bound observation timestamp.
                const exactVersionQuery = /v[1-9]\d*$/i.test(querySourceId);
                const observedValue = proof.observedAt || (exactVersionQuery ? run?.createdAt : null);
                const observed = new Date(observedValue);
                if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== observedValue) continue;
                const official = { ...parsed, proof: { ...parsed.proof, observedAt: observedValue } };
                candidates.get(id).push({ runId: name, official });
            } catch { /* invalid retained runs are never reuse candidates */ }
        }
    }
    const result = new Map();
    for (const [id, values] of candidates) {
        if (!values.length) continue;
        const identities = new Set(values.map(item => `${item.official.proof.recordSha256}\0${sha256(Buffer.from(item.official.metadata.abstract, 'utf8'))}`));
        if (identities.size !== 1) fail(`${id} has conflicting reusable official Atom metadata`);
        result.set(id, { ...values[0].official, reusedFromRunId: values[0].runId });
    }
    return result;
}
function findReusableOfficialAtom({ freshRewriteRoot, arxivId: value } = {}) {
    const id = arxivId(value);
    return reusableOfficialAtomIndex({ freshRewriteRoot, paperIds: [id] }).get(id) || null;
}

module.exports = { CONTRACT, VERSION, MANIFEST_NAME, METADATA_NAME, ATOM_NAME,
    HistoricalArxivPublicationMetadataError, sidecarDirectory, sourceSnapshotSha,
    readPublicationMetadata, sealPublicationMetadata, validateOfficialCompatibility, querySourceIdForSource,
    reusableOfficialAtomIndex,
    findReusableOfficialAtom };
