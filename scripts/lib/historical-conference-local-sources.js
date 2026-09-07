'use strict';

// Collect retained conference crawler inputs without touching historical
// pages.  This module deliberately does not import the crosswalk, blog, LLM,
// network, or old-analysis code paths.  It keeps only stable local source
// coordinates: a conference ID, metadata snapshot position, and PDF bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');
const icmlPosterApi = require('./historical-icml-poster-authority.js');
const openreviewPdfApi = require('./historical-openreview-pdf-source.js');
const alternatePdfApi = require('./historical-icml-alternate-pdf-source.js');

const CONTRACT = 'historical-conference-local-sources-v2';
const VERSION = 2;
const ICML_POSTER_SOURCE_SET = 'workspace-icml-official-poster-2026';
const ICML_POSTER_PROVENANCE = 'retained-local-icml-miniconf-snapshot';
const RETAINED_LOCAL_SOURCE_KIND = 'retained-local-no-network-receipt';
const OPENREVIEW_SOURCE_KIND = 'authenticated-openreview-forum-pdf';
const OPENREVIEW_VERSION_RELATION = 'openreview-forum-record-pdf';
const OPENREVIEW_PROVENANCE_STATEMENT = 'PDF bytes were fetched from the authenticated OpenReview forum PDF endpoint.';
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
function plannedDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be an absolute directory`);
    const absolute = path.resolve(directory); let cursor = absolute;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail(`${label} has no existing ancestor`);
        cursor = parent;
    }
    safeDirectory(cursor, `${label} existing ancestor`);
    return absolute;
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
function retainedAcquisition(pdf) {
    if (pdf.availability !== 'available') return null;
    return { receipt: null, sourceKind: RETAINED_LOCAL_SOURCE_KIND, versionRelation: null,
        sourceTitle: null, sourceAuthors: null, sourceDoi: null,
        provenanceStatement: 'PDF bytes predate the network receipt system and are retained local crawler input.',
        openreviewResponseBytes: null };
}
function receiptProof(receiptFile, receiptSha256) {
    const loaded = readStableFile(receiptFile, 'PDF acquisition receipt', 1024 * 1024);
    return { absolutePath: loaded.absolute, fileSha256: loaded.sha256, selfSha256: receiptSha256 };
}
function posterReceiptAcquisition({ record, authority, pdf, openreviewReceiptRoot, alternateReceiptRoot }) {
    const openRoot = plannedDirectory(openreviewReceiptRoot, 'OpenReview receipt root');
    const alternateRoot = plannedDirectory(alternateReceiptRoot, 'alternate receipt root');
    const openFile = path.join(openRoot, `openreview-${record.forumId}.json`);
    const alternateFile = path.join(alternateRoot, `alternate-${record.forumId}.json`);
    const hasOpen = fs.existsSync(openFile); const hasAlternate = fs.existsSync(alternateFile);
    if (hasOpen && hasAlternate) fail(`${record.forumId} has both OpenReview and alternate PDF receipts`);
    if (!hasOpen && !hasAlternate) return retainedAcquisition(pdf);
    if (pdf.availability !== 'available') fail(`${record.forumId} has a receipt without an available fresh PDF`);
    if (hasOpen) {
        const receipt = openreviewPdfApi.replayReceipt({ receiptFile: openFile, pdfFile: pdf.absolutePath,
            record, authoritySha256: authority.authoritySha256 });
        if (receipt.forumId !== record.forumId || receipt.posterId !== record.posterId
            || receipt.authoritySha256 !== authority.authoritySha256
            || receipt.recordBindingSha256 !== record.recordBindingSha256
            || receipt.pdf.absolutePath !== pdf.absolutePath || receipt.pdf.bytes !== pdf.bytes
            || receipt.pdf.sha256 !== pdf.sha256) fail('OpenReview receipt differs from selected fresh PDF authority');
        return { receipt: receiptProof(openFile, receipt.receiptSha256), sourceKind: OPENREVIEW_SOURCE_KIND,
            versionRelation: OPENREVIEW_VERSION_RELATION, sourceTitle: null, sourceAuthors: null, sourceDoi: null,
            provenanceStatement: OPENREVIEW_PROVENANCE_STATEMENT, openreviewResponseBytes: true };
    }
    const identity = alternatePdfApi.authenticateSourceIdentity({ snapshotFile: authority.snapshot.absolutePath,
        forumId: record.forumId });
    const receipt = alternatePdfApi.replayReceipt({ receiptFile: alternateFile, pdfFile: pdf.absolutePath, identity });
    if (receipt.forumId !== record.forumId || receipt.posterId !== record.posterId
        || receipt.snapshotSha256 !== authority.snapshot.sha256
        || receipt.authoritySha256 !== authority.authoritySha256
        || receipt.recordBindingSha256 !== record.recordBindingSha256
        || receipt.pdf.absolutePath !== pdf.absolutePath || receipt.pdf.bytes !== pdf.bytes
        || receipt.pdf.sha256 !== pdf.sha256) fail('alternate receipt differs from selected fresh PDF authority');
    return { receipt: receiptProof(alternateFile, receipt.receiptSha256), sourceKind: receipt.sourceKind,
        versionRelation: receipt.versionRelation, sourceTitle: receipt.sourceTitle,
        sourceAuthors: clone(receipt.sourceAuthors), sourceDoi: receipt.sourceDoi,
        provenanceStatement: receipt.provenanceStatement, openreviewResponseBytes: receipt.openreviewResponseBytes };
}
function selectPosterPdf({ record, retainedRoot, freshRoot, authority, openreviewReceiptRoot,
    alternateReceiptRoot }) {
    const retained = hashAvailablePdf(path.join(retainedRoot, `${record.forumId}.pdf`));
    const fresh = hashAvailablePdf(path.join(freshRoot, `${record.forumId}.pdf`));
    const hasOpenReceipt = fs.existsSync(path.join(openreviewReceiptRoot, `openreview-${record.forumId}.json`));
    const hasAlternateReceipt = fs.existsSync(path.join(alternateReceiptRoot, `alternate-${record.forumId}.json`));
    if (hasOpenReceipt && hasAlternateReceipt) fail(`${record.forumId} has both OpenReview and alternate PDF receipts`);
    if (fresh.availability === 'missing' && (hasOpenReceipt || hasAlternateReceipt)) {
        fail(`${record.forumId} receipt must bind a PDF in the fresh runtime root`);
    }
    if (fresh.availability !== 'missing' && !hasOpenReceipt && !hasAlternateReceipt) {
        fail(`${record.forumId} fresh runtime PDF has no acquisition receipt`);
    }
    if (fresh.availability === 'available' && retained.availability === 'available'
        && (fresh.bytes !== retained.bytes || fresh.sha256 !== retained.sha256)) {
        fail(`${record.forumId} has conflicting retained and fresh PDF bytes`);
    }
    const selected = fresh.availability === 'missing' ? retained : fresh;
    const acquisition = selected === fresh
        ? posterReceiptAcquisition({ record, authority, pdf: selected, openreviewReceiptRoot, alternateReceiptRoot })
        : retainedAcquisition(selected);
    return { ...selected, acquisition };
}
function bindSource({ paperId, provenance, sourceSet, metadataPath, metadataSha256, recordIndex,
    posterBinding = null, pdf, acquisition = undefined }) {
    const metadataBindingBody = { paperId, sourceSet, metadataSnapshotSha256: metadataSha256,
        recordIndex, posterBinding };
    const metadataIdentityBindingSha256 = stableHash(metadataBindingBody);
    const normalizedAcquisition = acquisition === undefined ? retainedAcquisition(pdf) : acquisition;
    const pdfBindingBody = { paperId, sourceSet, availability: pdf.availability,
        absolutePath: pdf.absolutePath, bytes: pdf.bytes, sha256: pdf.sha256,
        acquisition: clone(normalizedAcquisition), metadataIdentityBindingSha256 };
    const boundPdf = { ...clone(pdf), acquisition: clone(normalizedAcquisition),
        pdfIdentityBindingSha256: stableHash(pdfBindingBody) };
    const sourceBindingBody = { paperId, provenance, sourceSet, metadataIdentityBindingSha256,
        pdfIdentityBindingSha256: boundPdf.pdfIdentityBindingSha256 };
    return { provenance, sourceSet,
        metadata: { absolutePath: metadataPath, sha256: metadataSha256, recordIndex,
            metadataIdentityBindingSha256, posterBinding: posterBinding ? clone(posterBinding) : null },
        pdf: boundPdf, sourceBindingSha256: stableHash(sourceBindingBody) };
}
function manifestSourceRecord({ spec, metadata, recordIndex, externalId, pdf }) {
    const paperId = identityApi.canonicalConferenceId(spec.conference, externalId);
    return { paperId, conference: clone(spec.conference), externalId,
        source: bindSource({ paperId, provenance: spec.provenance, sourceSet: spec.sourceSet,
            metadataPath: metadata.absolutePath, metadataSha256: metadata.sha256, recordIndex, pdf }) };
}
function posterManifestSources({ authorityHandle, pdfRoot, freshPdfRoot, openreviewReceiptRoot,
    alternateReceiptRoot } = {}) {
    const authority = icmlPosterApi.authorityHandleSnapshot(authorityHandle);
    const root = safeDirectory(pdfRoot, 'ICML retained poster PDF root');
    const freshRoot = plannedDirectory(freshPdfRoot, 'ICML fresh poster PDF root');
    const openRoot = plannedDirectory(openreviewReceiptRoot, 'OpenReview receipt root');
    const alternateRoot = plannedDirectory(alternateReceiptRoot, 'alternate receipt root');
    let availablePdf = 0; let unavailablePdf = 0;
    const items = authority.records.map(record => {
        const externalId = { scheme: 'openreview-forum-id', value: record.forumId };
        const paperId = identityApi.canonicalConferenceId({ slug: 'icml', year: 2026 }, externalId);
        const pdf = selectPosterPdf({ record, retainedRoot: root, freshRoot, authority,
            openreviewReceiptRoot: openRoot, alternateReceiptRoot: alternateRoot });
        if (pdf.availability === 'available') availablePdf += 1; else unavailablePdf += 1;
        const posterBinding = { authorityContract: authority.contract, authoritySha256: authority.authoritySha256,
            recordBindingSha256: record.recordBindingSha256, posterId: record.posterId,
            officialUrl: record.officialUrl, openreviewUrl: record.openreviewUrl };
        return { paperId, source: bindSource({ paperId, provenance: ICML_POSTER_PROVENANCE,
            sourceSet: ICML_POSTER_SOURCE_SET, metadataPath: authority.snapshot.absolutePath,
            metadataSha256: authority.snapshot.sha256, recordIndex: record.recordIndex, posterBinding,
            pdf, acquisition: pdf.acquisition }) };
    });
    return { items, summary: { sourceSet: ICML_POSTER_SOURCE_SET, provenance: ICML_POSTER_PROVENANCE,
        conference: { slug: 'icml', year: 2026 }, metadata: { absolutePath: authority.snapshot.absolutePath,
            sha256: authority.snapshot.sha256 }, records: { total: authority.records.length,
            validIdentity: authority.records.length, invalidIdentity: 0, availablePdf, unavailablePdf } } };
}
function validatePosterBinding(value, paperId) {
    if (value === null) return null;
    if (!plain(value) || Object.keys(value).sort().join('\0') !== [
        'authorityContract', 'authoritySha256', 'recordBindingSha256', 'posterId', 'officialUrl', 'openreviewUrl'
    ].sort().join('\0') || value.authorityContract !== icmlPosterApi.CONTRACT
        || !SHA_RE.test(String(value.authoritySha256 || '')) || !SHA_RE.test(String(value.recordBindingSha256 || ''))
        || !/^[1-9]\d*$/.test(String(value.posterId || ''))
        || value.officialUrl !== `https://icml.cc/virtual/2026/poster/${value.posterId}`) {
        fail('local source manifest poster binding is malformed');
    }
    const forumId = String(value.openreviewUrl || '').match(/^https:\/\/openreview\.net\/forum\?id=([A-Za-z0-9_-]{6,128})$/)?.[1];
    if (!forumId || paperId !== `conference:icml:2026:openreview-forum-id:${forumId}`) {
        fail('local source manifest poster binding differs from its canonical paper ID');
    }
    return clone(value);
}
function validateAcquisition(value, paperId, pdf, posterBinding = null) {
    if (pdf.availability !== 'available') {
        if (value !== null) fail('unavailable local PDF must not declare acquisition provenance');
        return null;
    }
    const fields = ['receipt', 'sourceKind', 'versionRelation', 'sourceTitle', 'sourceAuthors', 'sourceDoi',
        'provenanceStatement', 'openreviewResponseBytes'];
    if (!plain(value) || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')) {
        fail('local PDF acquisition descriptor is malformed');
    }
    if (value.receipt !== null) {
        if (!plain(value.receipt) || Object.keys(value.receipt).sort().join('\0') !== [
            'absolutePath', 'fileSha256', 'selfSha256'
        ].sort().join('\0') || !path.isAbsolute(value.receipt.absolutePath)
            || !SHA_RE.test(String(value.receipt.fileSha256 || ''))
            || !SHA_RE.test(String(value.receipt.selfSha256 || ''))) {
            fail('local PDF acquisition receipt descriptor is malformed');
        }
        const loaded = readStableFile(value.receipt.absolutePath, 'manifest PDF acquisition receipt', 1024 * 1024);
        if (loaded.sha256 !== value.receipt.fileSha256) fail('manifest PDF acquisition receipt file SHA drifted');
    }
    if (value.sourceKind === RETAINED_LOCAL_SOURCE_KIND) {
        if (value.receipt !== null || value.versionRelation !== null || value.sourceTitle !== null
            || value.sourceAuthors !== null || value.sourceDoi !== null
            || value.provenanceStatement !== 'PDF bytes predate the network receipt system and are retained local crawler input.'
            || value.openreviewResponseBytes !== null) fail('retained local PDF acquisition descriptor drifted');
        return clone(value);
    }
    if (value.sourceKind === OPENREVIEW_SOURCE_KIND) {
        if (!plain(value.receipt) || value.versionRelation !== OPENREVIEW_VERSION_RELATION
            || value.sourceTitle !== null || value.sourceAuthors !== null || value.sourceDoi !== null
            || value.provenanceStatement !== OPENREVIEW_PROVENANCE_STATEMENT
            || value.openreviewResponseBytes !== true) fail('OpenReview PDF acquisition descriptor drifted');
        const receipt = openreviewPdfApi.readReceipt(value.receipt.absolutePath);
        const forumId = String(paperId).match(/^conference:icml:2026:openreview-forum-id:([A-Za-z0-9_-]{6,128})$/)?.[1];
        if (!forumId || path.basename(value.receipt.absolutePath) !== `openreview-${forumId}.json`
            || receipt.receiptSha256 !== value.receipt.selfSha256 || receipt.forumId !== forumId
            || receipt.posterId !== posterBinding?.posterId || receipt.authoritySha256 !== posterBinding?.authoritySha256
            || receipt.recordBindingSha256 !== posterBinding?.recordBindingSha256
            || receipt.pdf.absolutePath !== pdf.absolutePath || receipt.pdf.bytes !== pdf.bytes
            || receipt.pdf.sha256 !== pdf.sha256) fail('OpenReview acquisition receipt differs from manifest binding');
        return clone(value);
    }
    const forumId = String(paperId).match(/^conference:icml:2026:openreview-forum-id:([A-Za-z0-9_-]{6,128})$/)?.[1];
    let profile;
    try { profile = forumId ? alternatePdfApi.profileForForum(forumId) : null; } catch { profile = null; }
    if (!profile || !plain(value.receipt) || value.sourceKind !== profile.sourceKind
        || value.versionRelation !== profile.versionRelation || value.sourceTitle !== profile.sourceTitle
        || stableHash(value.sourceAuthors) !== stableHash(profile.sourceAuthors) || value.sourceDoi !== profile.sourceDoi
        || value.provenanceStatement !== profile.provenanceStatement || value.openreviewResponseBytes !== false) {
        fail('alternate PDF acquisition descriptor drifted');
    }
    const receipt = alternatePdfApi.readReceipt(value.receipt.absolutePath);
    if (path.basename(value.receipt.absolutePath) !== `alternate-${forumId}.json`
        || receipt.receiptSha256 !== value.receipt.selfSha256 || receipt.forumId !== forumId
        || receipt.posterId !== posterBinding?.posterId || receipt.authoritySha256 !== posterBinding?.authoritySha256
        || receipt.recordBindingSha256 !== posterBinding?.recordBindingSha256
        || receipt.pdf.absolutePath !== pdf.absolutePath || receipt.pdf.bytes !== pdf.bytes
        || receipt.pdf.sha256 !== pdf.sha256 || receipt.sourceKind !== value.sourceKind
        || receipt.versionRelation !== value.versionRelation || receipt.sourceTitle !== value.sourceTitle
        || stableHash(receipt.sourceAuthors) !== stableHash(value.sourceAuthors) || receipt.sourceDoi !== value.sourceDoi
        || receipt.provenanceStatement !== value.provenanceStatement
        || receipt.openreviewResponseBytes !== value.openreviewResponseBytes) {
        fail('alternate acquisition receipt differs from manifest binding');
    }
    return clone(value);
}
function validateSource(source, paperId) {
    if (!plain(source) || Object.keys(source).sort().join('\0') !== [
        'provenance', 'sourceSet', 'metadata', 'pdf', 'sourceBindingSha256'
    ].sort().join('\0') || typeof source.provenance !== 'string' || !source.provenance
        || typeof source.sourceSet !== 'string' || !source.sourceSet || !plain(source.metadata) || !plain(source.pdf)) {
        fail('local source manifest source is malformed');
    }
    if (Object.keys(source.metadata).sort().join('\0') !== [
        'absolutePath', 'sha256', 'recordIndex', 'metadataIdentityBindingSha256', 'posterBinding'
    ].sort().join('\0') || typeof source.metadata.absolutePath !== 'string' || !path.isAbsolute(source.metadata.absolutePath)
        || !SHA_RE.test(String(source.metadata.sha256 || '')) || !Number.isSafeInteger(source.metadata.recordIndex)
        || source.metadata.recordIndex < 0 || !SHA_RE.test(String(source.metadata.metadataIdentityBindingSha256 || ''))) {
        fail('local source manifest metadata binding is malformed');
    }
    const posterBinding = validatePosterBinding(source.metadata.posterBinding, paperId);
    if ((source.sourceSet === ICML_POSTER_SOURCE_SET) !== Boolean(posterBinding)
        || (posterBinding && source.provenance !== ICML_POSTER_PROVENANCE)) {
        fail('local source manifest poster authority is attached to the wrong source set');
    }
    const metadataBindingBody = { paperId, sourceSet: source.sourceSet,
        metadataSnapshotSha256: source.metadata.sha256, recordIndex: source.metadata.recordIndex, posterBinding };
    if (stableHash(metadataBindingBody) !== source.metadata.metadataIdentityBindingSha256) {
        fail('local source manifest metadata identity binding drifted');
    }
    if (Object.keys(source.pdf).sort().join('\0') !== [
        'availability', 'absolutePath', 'bytes', 'sha256', 'acquisition', 'pdfIdentityBindingSha256'
    ].sort().join('\0') || !['available', 'missing', 'invalid-path', 'invalid-file', 'invalid-pdf', 'unreadable']
        .includes(source.pdf.availability) || !SHA_RE.test(String(source.pdf.pdfIdentityBindingSha256 || ''))) {
        fail('local source manifest PDF binding is malformed');
    }
    if (source.pdf.availability === 'available') {
        if (!SHA_RE.test(String(source.pdf.sha256 || '')) || !Number.isSafeInteger(source.pdf.bytes)
            || source.pdf.bytes < 5 || typeof source.pdf.absolutePath !== 'string' || !path.isAbsolute(source.pdf.absolutePath)) {
            fail('available local PDF entry is malformed');
        }
    } else if (source.pdf.sha256 !== null || source.pdf.bytes !== null
        || (source.pdf.absolutePath !== null && (typeof source.pdf.absolutePath !== 'string'
            || !path.isAbsolute(source.pdf.absolutePath)))) {
        fail('unavailable local PDF entry is malformed');
    }
    const acquisition = validateAcquisition(source.pdf.acquisition, paperId, source.pdf, posterBinding);
    const pdfBindingBody = { paperId, sourceSet: source.sourceSet, availability: source.pdf.availability,
        absolutePath: source.pdf.absolutePath, bytes: source.pdf.bytes, sha256: source.pdf.sha256,
        acquisition,
        metadataIdentityBindingSha256: source.metadata.metadataIdentityBindingSha256 };
    if (stableHash(pdfBindingBody) !== source.pdf.pdfIdentityBindingSha256) {
        fail('local source manifest PDF identity binding drifted');
    }
    const sourceBindingBody = { paperId, provenance: source.provenance, sourceSet: source.sourceSet,
        metadataIdentityBindingSha256: source.metadata.metadataIdentityBindingSha256,
        pdfIdentityBindingSha256: source.pdf.pdfIdentityBindingSha256 };
    if (!SHA_RE.test(String(source.sourceBindingSha256 || ''))
        || stableHash(sourceBindingBody) !== source.sourceBindingSha256) fail('local source manifest source binding drifted');
    return clone(source);
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
        const sourceSets = new Set();
        for (const source of record.sources) {
            validateSource(source, record.paperId);
            if (sourceSets.has(source.sourceSet)) fail('local source manifest duplicates a source set for one paper');
            sourceSets.add(source.sourceSet);
        }
        if (record.sources.some((source, index) => index > 0
            && source.sourceSet.localeCompare(record.sources[index - 1].sourceSet) <= 0)) {
            fail('local source manifest sources are unordered');
        }
    }
    return value;
}
function addGroupedSource(grouped, paperId, source) {
    const variants = grouped.get(paperId) || [];
    if (variants.some(item => item.sourceSet === source.sourceSet)) {
        fail(`${paperId} duplicates source set ${source.sourceSet}`);
    }
    variants.push(source); grouped.set(paperId, variants);
}
function buildLocalSourcesManifest({ dataRoot, iclrAcceptedRoot, icmlPosterSnapshotFile,
    icmlPdfRoot, icmlFreshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot, sourceSets = null } = {}) {
    const includePosterSource = [icmlPosterSnapshotFile, icmlPdfRoot, icmlFreshPdfRoot,
        openreviewReceiptRoot, alternateReceiptRoot].some(value => value !== undefined);
    if ((sourceSets === null || includePosterSource)
        && (typeof icmlPosterSnapshotFile !== 'string' || !path.isAbsolute(icmlPosterSnapshotFile)
            || typeof icmlPdfRoot !== 'string' || !path.isAbsolute(icmlPdfRoot)
            || typeof icmlFreshPdfRoot !== 'string' || !path.isAbsolute(icmlFreshPdfRoot)
            || typeof openreviewReceiptRoot !== 'string' || !path.isAbsolute(openreviewReceiptRoot)
            || typeof alternateReceiptRoot !== 'string' || !path.isAbsolute(alternateReceiptRoot))) {
        fail('explicit absolute ICML poster snapshot, retained/fresh PDF roots, and receipt roots are required');
    }
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
            addGroupedSource(grouped, item.paperId, item.source);
        });
        sourceSummaries.push({ sourceSet: spec.sourceSet, provenance: spec.provenance, conference: clone(spec.conference),
            metadata: { absolutePath: metadata.absolutePath, sha256: metadata.sha256 }, records: {
                total: metadata.records.length, validIdentity: validMetadata, invalidIdentity, availablePdf, unavailablePdf
            } });
    }
    if (includePosterSource) {
        const posterHandle = icmlPosterApi.loadPosterAuthority({ snapshotFile: icmlPosterSnapshotFile });
        const poster = posterManifestSources({ authorityHandle: posterHandle, pdfRoot: icmlPdfRoot,
            freshPdfRoot: icmlFreshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot });
        for (const item of poster.items) addGroupedSource(grouped, item.paperId, item.source);
        sourceSummaries.push(poster.summary);
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

module.exports = { CONTRACT, VERSION, ICML_POSTER_SOURCE_SET, ICML_POSTER_PROVENANCE, SAFE_JSON_NAME,
    HistoricalConferenceLocalSourcesError, stableHash, prettyBytes, externalIdFor, hashAvailablePdf,
    localSourceSets, posterManifestSources, validateAcquisition, validateSource,
    buildLocalSourcesManifest, assertManifest, writeManifest };
