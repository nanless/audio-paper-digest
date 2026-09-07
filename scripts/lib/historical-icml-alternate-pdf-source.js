'use strict';

// Recover an ICML forum-ID PDF from a small, code-reviewed allowlist when the
// canonical OpenReview endpoint is unavailable. The resulting receipt states
// explicitly that the bytes came from the alternate source, not OpenReview.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { detectHttpConnectProxyUrl, createProxyDispatcher } = require('../utils.js');
const posterApi = require('./historical-icml-poster-authority.js');

const CONTRACT = 'historical-icml-alternate-pdf-source-v1';
const VERSION = 1;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const REQUEST_TIMEOUT_MS = 180000;
const FORUM_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const RECEIPT_NAME_RE = /^alternate-[A-Za-z0-9_-]{6,128}\.json$/;

const PROFILE_DEFINITIONS = Object.freeze({
    jfpkqjhex4: Object.freeze({
        profileId: 'icml-2026-jfpkqjhex4-arxiv-2510.06927v3',
        forumId: 'jfpkqjhex4',
        posterId: '67095',
        title: 'Position: Towards Responsible Evaluation for Text-to-Speech',
        authors: Object.freeze(['Yifan Yang', 'Hui Wang', 'Bing Han', 'Shujie Liu', 'Jinyu Li', 'Yong Qin', 'Xie Chen']),
        sourceKind: 'official-arxiv-versioned-pdf',
        sourceTitle: 'Position: Towards Responsible Evaluation for Text-to-Speech',
        sourceAuthors: Object.freeze(['Yifan Yang', 'Hui Wang', 'Bing Han', 'Shujie Liu', 'Jinyu Li', 'Yong Qin', 'Xie Chen']),
        sourceDoi: null,
        versionRelation: 'same-paper-versioned-official-preprint',
        requestedUrl: 'https://arxiv.org/pdf/2510.06927v3',
        allowedUrls: Object.freeze([
            'https://arxiv.org/pdf/2510.06927v3',
            'https://arxiv.org/pdf/2510.06927v3.pdf'
        ]),
        provenanceStatement: 'PDF bytes were fetched from the versioned official arXiv PDF endpoint; they are not OpenReview response bytes.'
    }),
    n1mAjfRDZ6: Object.freeze({
        profileId: 'icml-2026-n1mAjfRDZ6-techrxiv-177222989-v1-cross-version',
        forumId: 'n1mAjfRDZ6',
        posterId: '67080',
        title: 'Position: *Beyond Text* The Text-Centric Bias in Foundation Models Must Be Revisited for a Speech-First Future',
        authors: Object.freeze(['Deepak Piskala']),
        sourceKind: 'author-prior-preprint-cross-version',
        sourceTitle: 'Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction',
        sourceAuthors: Object.freeze(['Deepak Babu Piskala']),
        sourceDoi: '10.36227/techrxiv.177222989.90971634/v1',
        versionRelation: 'author-prior-preprint-with-different-title',
        requestedUrl: 'https://d197for5662m48.cloudfront.net/documents/publicationstatus/309719/preprint_pdf/558b4fa5fcb7119fe0fb4b6bac999479.pdf',
        allowedUrls: Object.freeze([
            'https://d197for5662m48.cloudfront.net/documents/publicationstatus/309719/preprint_pdf/558b4fa5fcb7119fe0fb4b6bac999479.pdf'
        ]),
        provenanceStatement: 'PDF bytes were fetched from the author prior TechRxiv v1 preprint. Its title differs from the ICML record; it is neither the ICML camera-ready paper nor OpenReview response bytes.'
    })
});

class HistoricalIcmlAlternatePdfSourceError extends Error {
    constructor(message) {
        super(`Historical ICML alternate PDF source rejected: ${message}`);
        this.name = 'HistoricalIcmlAlternatePdfSourceError';
        this.code = 'HISTORICAL_ICML_ALTERNATE_PDF_SOURCE_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalIcmlAlternatePdfSourceError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function safeDirectory(directory, label, create = false) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory);
    if (!fs.existsSync(absolute)) {
        if (!create) fail(`${label} does not exist`);
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function plannedDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory); const missing = []; let cursor = absolute;
    while (!fs.existsSync(cursor)) {
        missing.push(path.basename(cursor)); const parent = path.dirname(cursor);
        if (parent === cursor) fail(`${label} has no existing ancestor`); cursor = parent;
    }
    safeDirectory(cursor, `${label} existing ancestor`);
    if (missing.some(part => !part || part === '.' || part === '..')) fail(`${label} is unsafe`);
    return absolute;
}

function readStableFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be absolute`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`); let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            fail(`${label} is unsafe or too large`);
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail(`${label} changed while read`);
        return { filename: absolute, bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error instanceof HistoricalIcmlAlternatePdfSourceError) throw error;
        fail(`${label} cannot be read: ${error.code || error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(text, label) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token); if (top.keys.has(key)) fail(`${label} has duplicate JSON keys`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function profileForForum(forumId) {
    if (!FORUM_ID_RE.test(String(forumId || ''))) fail('forum ID is invalid');
    const profile = PROFILE_DEFINITIONS[forumId];
    if (!profile) fail(`forum ID ${forumId} has no code-reviewed alternate source profile`);
    return clone(profile);
}

function validateProfileUrl(rawUrl, profile) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { fail('alternate PDF URL is invalid'); }
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.hash
        || !profile.allowedUrls.includes(parsed.toString())) {
        fail('alternate PDF URL left the fixed profile host/path/query allowlist');
    }
    return parsed.toString();
}

function authenticateSourceIdentity({ snapshotFile, forumId } = {}) {
    const profile = profileForForum(forumId);
    const authorityHandle = posterApi.loadPosterAuthority({ snapshotFile });
    const authority = posterApi.authorityHandleSnapshot(authorityHandle);
    const authorityRecord = posterApi.lookupByForum(authorityHandle, forumId);
    if (authorityRecord.forumId !== profile.forumId || authorityRecord.posterId !== profile.posterId) {
        fail('alternate source profile differs from authenticated poster/forum authority');
    }
    const loaded = readStableFile(authority.snapshot.absolutePath, 'ICML raw poster snapshot', MAX_SNAPSHOT_BYTES);
    if (loaded.sha256 !== authority.snapshot.sha256) fail('raw snapshot SHA differs from authenticated poster authority');
    let raw;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text, 'ICML raw poster snapshot'); raw = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalIcmlAlternatePdfSourceError) throw error;
        fail('ICML raw poster snapshot is not strict UTF-8 JSON');
    }
    const rawRecord = raw?.results?.[authorityRecord.recordIndex];
    const authors = Array.isArray(rawRecord?.authors) ? rawRecord.authors.map(author => author?.fullname) : null;
    if (!plain(rawRecord) || String(rawRecord.id) !== profile.posterId
        || rawRecord.paper_url !== `https://openreview.net/forum?id=${profile.forumId}`
        || rawRecord.virtualsite_url !== `/virtual/2026/poster/${profile.posterId}`
        || rawRecord.name !== profile.title || !Array.isArray(authors)
        || authors.some(name => typeof name !== 'string')
        || authors.length !== profile.authors.length
        || authors.some((name, index) => name !== profile.authors[index])) {
        fail('code-reviewed profile title or ordered authors differ from the authenticated raw snapshot record');
    }
    const evidence = { forumId: profile.forumId, posterId: profile.posterId, title: rawRecord.name,
        authors, snapshotSha256: authority.snapshot.sha256, snapshotRecordIndex: authorityRecord.recordIndex,
        authoritySha256: authority.authoritySha256, recordBindingSha256: authorityRecord.recordBindingSha256,
        profileId: profile.profileId, sourceKind: profile.sourceKind, sourceTitle: profile.sourceTitle,
        sourceAuthors: clone(profile.sourceAuthors), sourceDoi: profile.sourceDoi,
        versionRelation: profile.versionRelation, requestedUrl: profile.requestedUrl,
        provenanceStatement: profile.provenanceStatement };
    return { profile, authorityHandle, authority, authorityRecord, evidence,
        sourceIdentityBindingSha256: stableHash(evidence) };
}

function validPdfContentType(value) {
    return /^(?:application\/pdf|application\/octet-stream)(?:\s*;[^\r\n]*)?$/iu.test(String(value || '').trim());
}

async function readResponseBytes(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) fail('alternate PDF exceeds the byte limit');
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) fail('alternate PDF exceeds the byte limit');
        return bytes;
    }
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            const chunk = Buffer.from(value); total += chunk.length;
            if (total > maxBytes) { await reader.cancel(); fail('alternate PDF exceeds the byte limit'); }
            chunks.push(chunk);
        }
    } finally { reader.releaseLock?.(); }
    return Buffer.concat(chunks, total);
}

async function defaultFetchPdf({ profile, maxBytes = MAX_PDF_BYTES, maxRedirects = MAX_REDIRECTS,
    timeoutMs = REQUEST_TIMEOUT_MS } = {}, dependencies = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > MAX_PDF_BYTES
        || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
        fail('downloader options are invalid');
    }
    const normalizedProfile = profileForForum(profile?.forumId);
    if (stableHash(profile) !== stableHash(normalizedProfile)) fail('alternate source profile is not the code-reviewed profile');
    const detectProxy = dependencies.detectProxy || detectHttpConnectProxyUrl;
    const proxyUrl = detectProxy(); if (!proxyUrl) fail('project HTTP CONNECT proxy is required');
    const dispatcher = (dependencies.createDispatcher || createProxyDispatcher)(proxyUrl);
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    const requestedUrl = validateProfileUrl(normalizedProfile.requestedUrl, normalizedProfile);
    const redirects = []; let current = requestedUrl;
    try {
        for (let count = 0; count <= maxRedirects; count += 1) {
            const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', dispatcher,
                signal: controller.signal, headers: { Accept: 'application/pdf',
                    'User-Agent': 'audio-paper-digest-history/1.0' } });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (count >= maxRedirects) fail('alternate PDF exceeded the redirect limit');
                const location = response.headers?.get?.('location');
                if (!location) fail('alternate PDF redirect has no Location');
                const next = validateProfileUrl(new URL(location, current).toString(), normalizedProfile);
                redirects.push({ from: current, to: next, status: response.status }); current = next; continue;
            }
            if (response.status !== 200) fail(`alternate PDF returned HTTP ${response.status}`);
            const contentType = String(response.headers?.get?.('content-type') || '');
            if (!validPdfContentType(contentType)) fail('alternate PDF response has an invalid Content-Type');
            const bytes = await readResponseBytes(response, maxBytes);
            return { bytes, requestedUrl, finalUrl: current, redirects, contentType, responseStatus: response.status };
        }
        fail('alternate PDF exceeded the redirect limit');
    } catch (error) {
        if (error instanceof HistoricalIcmlAlternatePdfSourceError) throw error;
        if (error?.name === 'AbortError') fail('alternate PDF request timed out');
        const reason = String(error?.cause?.code || error?.code || error?.message || 'network error')
            .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 160);
        fail(`alternate PDF network request failed: ${reason}`);
    } finally { clearTimeout(timer); }
}

function pathsFor({ pdfRoot, receiptRoot, forumId, create = false } = {}) {
    const pdfDirectory = create ? safeDirectory(pdfRoot, 'alternate PDF root', true)
        : plannedDirectory(pdfRoot, 'alternate PDF root');
    const receiptDirectory = create ? safeDirectory(receiptRoot, 'alternate receipt root', true)
        : plannedDirectory(receiptRoot, 'alternate receipt root');
    if (!FORUM_ID_RE.test(String(forumId || ''))) fail('forum ID is invalid');
    return { pdfFile: path.join(pdfDirectory, `${forumId}.pdf`),
        receiptFile: path.join(receiptDirectory, `alternate-${forumId}.json`) };
}

function validateRedirects(redirects, profile, requestedUrl, finalUrl) {
    if (!Array.isArray(redirects) || redirects.length > MAX_REDIRECTS
        || redirects.some(item => !plain(item) || ![301, 302, 303, 307, 308].includes(item.status)
            || validateProfileUrl(item.from, profile) !== item.from
            || validateProfileUrl(item.to, profile) !== item.to)) fail('receipt redirect chain is invalid');
    if ((!redirects.length && finalUrl !== requestedUrl)
        || (redirects.length && (redirects[0].from !== requestedUrl || redirects.at(-1).to !== finalUrl
            || redirects.some((item, index) => index > 0 && redirects[index - 1].to !== item.from)))) {
        fail('receipt redirect chain is not continuous');
    }
}

function normalizeReceipt(value) {
    const fields = ['contract', 'version', 'profileId', 'forumId', 'posterId', 'forumUrl', 'title', 'authors',
        'sourceKind', 'sourceTitle', 'sourceAuthors', 'sourceDoi', 'versionRelation', 'provenanceStatement',
        'openreviewResponseBytes', 'requestedUrl', 'finalUrl', 'redirects',
        'responseStatus', 'contentType', 'fetchedAt', 'snapshotSha256', 'authoritySha256', 'recordBindingSha256',
        'sourceIdentityBindingSha256', 'pdf', 'receiptSha256'];
    exact(value, fields, 'alternate PDF receipt');
    const profile = profileForForum(value.forumId);
    if (value.contract !== CONTRACT || value.version !== VERSION || value.profileId !== profile.profileId
        || value.posterId !== profile.posterId || value.forumUrl !== `https://openreview.net/forum?id=${profile.forumId}`
        || value.title !== profile.title || stableHash(value.authors) !== stableHash(profile.authors)
        || value.sourceKind !== profile.sourceKind || value.sourceTitle !== profile.sourceTitle
        || stableHash(value.sourceAuthors) !== stableHash(profile.sourceAuthors) || value.sourceDoi !== profile.sourceDoi
        || value.versionRelation !== profile.versionRelation || value.provenanceStatement !== profile.provenanceStatement
        || value.openreviewResponseBytes !== false || value.responseStatus !== 200
        || !validPdfContentType(value.contentType) || !Number.isFinite(Date.parse(value.fetchedAt))
        || new Date(value.fetchedAt).toISOString() !== value.fetchedAt
        || !SHA_RE.test(String(value.snapshotSha256 || '')) || !SHA_RE.test(String(value.authoritySha256 || ''))
        || !SHA_RE.test(String(value.recordBindingSha256 || ''))
        || !SHA_RE.test(String(value.sourceIdentityBindingSha256 || ''))) fail('alternate PDF receipt envelope is invalid');
    const requestedUrl = validateProfileUrl(value.requestedUrl, profile);
    const finalUrl = validateProfileUrl(value.finalUrl, profile);
    if (requestedUrl !== profile.requestedUrl) fail('receipt did not request the fixed profile URL');
    validateRedirects(value.redirects, profile, requestedUrl, finalUrl);
    exact(value.pdf, ['absolutePath', 'bytes', 'sha256'], 'alternate PDF receipt PDF binding');
    if (!path.isAbsolute(value.pdf.absolutePath) || !Number.isSafeInteger(value.pdf.bytes) || value.pdf.bytes < 5
        || value.pdf.bytes > MAX_PDF_BYTES || !SHA_RE.test(String(value.pdf.sha256 || ''))) {
        fail('alternate PDF receipt PDF binding is invalid');
    }
    const body = clone(value); delete body.receiptSha256;
    if (!SHA_RE.test(String(value.receiptSha256 || '')) || value.receiptSha256 !== stableHash(body)) {
        fail('alternate PDF receipt self-SHA is invalid');
    }
    return clone(value);
}

function readReceipt(receiptFile) {
    const loaded = readStableFile(receiptFile, 'alternate PDF receipt', 1024 * 1024); let value;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text, 'alternate PDF receipt'); value = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalIcmlAlternatePdfSourceError) throw error;
        fail('alternate PDF receipt is not strict UTF-8 JSON');
    }
    const receipt = normalizeReceipt(value);
    if (!loaded.bytes.equals(prettyBytes(receipt))) fail('alternate PDF receipt bytes are not canonical');
    return receipt;
}

function replayReceipt({ receiptFile, pdfFile, identity } = {}) {
    posterApi.authorityHandleSnapshot(identity.authorityHandle);
    const receipt = readReceipt(receiptFile);
    const profile = identity.profile;
    if (receipt.profileId !== profile.profileId || receipt.forumId !== profile.forumId
        || receipt.posterId !== profile.posterId || receipt.snapshotSha256 !== identity.authority.snapshot.sha256
        || receipt.authoritySha256 !== identity.authority.authoritySha256
        || receipt.recordBindingSha256 !== identity.authorityRecord.recordBindingSha256
        || receipt.sourceIdentityBindingSha256 !== identity.sourceIdentityBindingSha256
        || receipt.pdf.absolutePath !== pdfFile) fail('alternate receipt differs from authenticated source identity');
    const pdf = readStableFile(pdfFile, 'sealed alternate PDF', MAX_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.bytes.length !== receipt.pdf.bytes
        || pdf.sha256 !== receipt.pdf.sha256) fail('sealed alternate PDF differs from receipt');
    return receipt;
}

function writeExclusive(filename, bytes) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeOrCompare(filename, bytes, label, maxBytes) {
    try { writeExclusive(filename, bytes); return 'created'; }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readStableFile(filename, label, maxBytes);
        if (!existing.bytes.equals(bytes)) fail(`refuses to overwrite a different ${label}`);
        return 'recovered';
    }
}

async function sealAlternatePdf({ apply = false, snapshotFile, forumId, pdfRoot, receiptRoot,
    maxBytes = MAX_PDF_BYTES, maxRedirects = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS,
    observedAt = null } = {}, dependencies = {}) {
    if (typeof apply !== 'boolean' || !Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > MAX_PDF_BYTES
        || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('sealer options are invalid');
    const identity = authenticateSourceIdentity({ snapshotFile, forumId });
    const paths = pathsFor({ pdfRoot, receiptRoot, forumId, create: apply });
    const plan = { profileId: identity.profile.profileId, forumId: identity.profile.forumId,
        posterId: identity.profile.posterId, title: identity.profile.title, authors: clone(identity.profile.authors),
        forumUrl: identity.authorityRecord.openreviewUrl, sourceKind: identity.profile.sourceKind,
        sourceTitle: identity.profile.sourceTitle, sourceAuthors: clone(identity.profile.sourceAuthors),
        sourceDoi: identity.profile.sourceDoi, versionRelation: identity.profile.versionRelation,
        requestedUrl: identity.profile.requestedUrl, provenanceStatement: identity.profile.provenanceStatement,
        openreviewResponseBytes: false, pdfFile: paths.pdfFile, receiptFile: paths.receiptFile,
        snapshotSha256: identity.authority.snapshot.sha256, authoritySha256: identity.authority.authoritySha256,
        recordBindingSha256: identity.authorityRecord.recordBindingSha256,
        sourceIdentityBindingSha256: identity.sourceIdentityBindingSha256 };
    if (!apply) return { status: 'dry-run', ...plan };
    if (fs.existsSync(paths.receiptFile)) {
        return { status: 'recovered', ...plan, receipt: replayReceipt({ ...paths, identity }) };
    }
    const fetchPdf = dependencies.fetchPdf || (options => defaultFetchPdf(options, dependencies));
    const downloaded = await fetchPdf({ profile: clone(identity.profile), maxBytes, maxRedirects, timeoutMs });
    posterApi.authorityHandleSnapshot(identity.authorityHandle);
    if (!plain(downloaded) || !Buffer.isBuffer(downloaded.bytes) || downloaded.bytes.length < 5
        || downloaded.bytes.length > maxBytes || downloaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('downloaded alternate response is not a bounded PDF');
    }
    if (downloaded.responseStatus !== 200 || !validPdfContentType(downloaded.contentType)) {
        fail('downloaded alternate response metadata is invalid');
    }
    const requestedUrl = validateProfileUrl(downloaded.requestedUrl, identity.profile);
    const finalUrl = validateProfileUrl(downloaded.finalUrl, identity.profile);
    if (requestedUrl !== identity.profile.requestedUrl) fail('download did not request the fixed profile URL');
    validateRedirects(downloaded.redirects || [], identity.profile, requestedUrl, finalUrl);
    const fetchedAt = observedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(fetchedAt)) || new Date(fetchedAt).toISOString() !== fetchedAt) fail('observedAt is invalid');
    const pdfBody = { absolutePath: paths.pdfFile, bytes: downloaded.bytes.length, sha256: sha256(downloaded.bytes) };
    const body = { contract: CONTRACT, version: VERSION, profileId: identity.profile.profileId,
        forumId: identity.profile.forumId, posterId: identity.profile.posterId,
        forumUrl: identity.authorityRecord.openreviewUrl, title: identity.profile.title,
        authors: clone(identity.profile.authors), sourceKind: identity.profile.sourceKind,
        sourceTitle: identity.profile.sourceTitle, sourceAuthors: clone(identity.profile.sourceAuthors),
        sourceDoi: identity.profile.sourceDoi, versionRelation: identity.profile.versionRelation,
        provenanceStatement: identity.profile.provenanceStatement, openreviewResponseBytes: false,
        requestedUrl, finalUrl, redirects: clone(downloaded.redirects || []),
        responseStatus: downloaded.responseStatus, contentType: String(downloaded.contentType || ''), fetchedAt,
        snapshotSha256: identity.authority.snapshot.sha256, authoritySha256: identity.authority.authoritySha256,
        recordBindingSha256: identity.authorityRecord.recordBindingSha256,
        sourceIdentityBindingSha256: identity.sourceIdentityBindingSha256, pdf: pdfBody };
    const receipt = normalizeReceipt({ ...body, receiptSha256: stableHash(body) });
    const pdfStatus = writeOrCompare(paths.pdfFile, downloaded.bytes, 'existing alternate PDF', MAX_PDF_BYTES);
    let receiptStatus = 'created';
    try { writeExclusive(paths.receiptFile, prettyBytes(receipt)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; receiptStatus = 'recovered'; }
    const replayed = replayReceipt({ ...paths, identity });
    return { status: pdfStatus === 'recovered' && receiptStatus === 'recovered' ? 'recovered' : 'created',
        ...plan, receipt: replayed };
}

module.exports = { CONTRACT, VERSION, MAX_PDF_BYTES, MAX_REDIRECTS, REQUEST_TIMEOUT_MS, RECEIPT_NAME_RE,
    HistoricalIcmlAlternatePdfSourceError, stableHash, profileForForum, validateProfileUrl,
    authenticateSourceIdentity, validPdfContentType, normalizeReceipt, readReceipt, replayReceipt,
    defaultFetchPdf, sealAlternatePdf };
