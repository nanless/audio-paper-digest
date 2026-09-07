'use strict';

// Identity-only authority for retained local conference crawler snapshots.
// It never reads historical blog bodies, performs network I/O, or exposes
// retained analysis/full-text fields to a later writing stage.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityApi = require('./paper-identity.js');

const CONTRACT = 'historical-conference-crawl-identity-authority-v1';
const VERSION = 1;
const EVIDENCE_KIND = 'retained-conference-crawler-metadata-pdf-identity';
const AUTHORITY_PREFIX = 'conference-crawl-';
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_HISTORICAL_PAGE_BYTES = 64 * 1024 * 1024;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();
const DATA_SOURCE = 'workspace-data';
const ICLR_ACCEPTED_SOURCE = 'iclr-accepted-local';
const ICLR_ACCEPTED_RELATIVE_PATH = 'data/iclr2026_accepted.json';

const SNAPSHOTS = Object.freeze({
    'current/icassp_2026_deep_analyzers.json': {
        conference: { slug: 'icassp', year: 2026 }, scheme: 'icassp-arnumber', idFields: ['arnumber', 'paper_id'], pdf: 'record'
    },
    'current/iclr_2026_deep_analyzers.json': {
        conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['forum_id', 'paper_id', 'arnumber'], pdf: 'record'
    },
    'current/icml_2026_deep_analysis.json': {
        conference: { slug: 'icml', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['id'], pdf: 'id-file'
    }
});
const ICLR_ACCEPTED_SPEC = Object.freeze({ conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id',
    idFields: ['forum_id'], pdf: 'iclr-accepted-id-file' });

class HistoricalConferenceCrawlAuthorityError extends Error {
    constructor(message) { super(`Historical conference crawl identity authority rejected: ${message}`); this.name = 'HistoricalConferenceCrawlAuthorityError'; this.code = 'HISTORICAL_CONFERENCE_CRAWL_AUTHORITY_INTEGRITY'; }
}
const fail = message => { throw new HistoricalConferenceCrawlAuthorityError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
function exact(value, fields, label) { if (!plain(value)) fail(`${label} must be a plain object`); const actual = Object.keys(value).sort(); const expected = [...fields].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unknown or missing fields`); }
function sha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a SHA-256`); return value; }
function safeDirectory(directory, label, { create = false } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be an absolute directory`);
    const resolved = path.resolve(directory); if (!fs.existsSync(resolved)) { if (!create) fail(`${label} does not exist`); fs.mkdirSync(resolved, { recursive: true, mode: 0o700 }); }
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); const info = fs.lstatSync(cursor); if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is unsafe`); }
    if (fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`); return resolved;
}
function safeRegularFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be an absolute file`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`); let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) fail(`${label} is unsafe or too large`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} changed while read`);
        return { absolute, bytes, sha256: sha256(bytes), dev: opened.dev, ino: opened.ino };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function titleFingerprint(title, label = 'title') {
    if (typeof title !== 'string' || !title.length || title.length > 16384) fail(`${label} must be a bounded string`);
    const normalized = title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
    if (!normalized) fail(`${label} is empty after normalization`);
    return sha256(Buffer.from(normalized, 'utf8'));
}
function scalarFrontmatterTitle(bytes, label) {
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label} is not strict UTF-8`); }
    const block = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!block) fail(`${label} lacks strict YAML frontmatter`);
    const values = [...block[1].matchAll(/^title:[ \t]*(.*?)\r?$/gmu)];
    if (values.length !== 1) fail(`${label} must contain exactly one scalar title`);
    let value = values[0][1].trim();
    if (!value || /^(?:[|>]|[&*!]|\[|\{|null$|~$)/iu.test(value)) fail(`${label} title is not a supported scalar`);
    if (value.startsWith("'")) {
        if (!value.endsWith("'") || value.length < 2) fail(`${label} title quote is malformed`);
        value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.startsWith('"')) {
        if (!value.endsWith('"') || value.length < 2) fail(`${label} title quote is malformed`);
        try { value = JSON.parse(value); } catch { fail(`${label} title has unsupported YAML escapes`); }
    } else if (/\s+#/u.test(value)) fail(`${label} title comments are unsupported`);
    return titleFingerprint(value, `${label} title`);
}
function pageTitleBinding({ blogRoot, pageKey, pagePath, pageContentSha256 } = {}) {
    if (!PAGE_KEY_RE.test(String(pageKey || '')) || typeof pagePath !== 'string' || !pagePath
        || !SHA_RE.test(String(pageContentSha256 || ''))) fail('historical page title binding is malformed');
    const root = safeDirectory(blogRoot, 'blogRoot'); const filename = path.resolve(root, pagePath);
    if (!filename.startsWith(`${root}${path.sep}`)) fail('historical page title binding escapes blogRoot');
    const loaded = safeRegularFile(filename, 'historical page', MAX_HISTORICAL_PAGE_BYTES);
    if (loaded.sha256 !== pageContentSha256) fail('historical page bytes no longer match the frozen crosswalk page');
    return { pageKey, pagePath, pageContentSha256, titleFingerprintSha256: scalarFrontmatterTitle(loaded.bytes, 'historical page') };
}
function normalizeTitleBindings(value) {
    if (!Array.isArray(value)) fail('title bindings must be an array');
    const bindings = value.map((binding, index) => {
        exact(binding, ['pageKey', 'pagePath', 'pageContentSha256', 'titleFingerprintSha256'], `title binding[${index}]`);
        if (!PAGE_KEY_RE.test(binding.pageKey) || typeof binding.pagePath !== 'string' || !binding.pagePath
            || !SHA_RE.test(binding.pageContentSha256) || !SHA_RE.test(binding.titleFingerprintSha256)) fail('title binding is malformed');
        return clone(binding);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    if (new Set(bindings.map(binding => binding.pageKey)).size !== bindings.length) fail('title bindings duplicate a page');
    return bindings;
}
function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) { const token = match[0]; const top = stack.at(-1); if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true }); else if (token === '[') stack.push({ object: false }); else if (token === '}' || token === ']') stack.pop(); else if (token === ',' && top?.object) top.expectKey = true; else if (token.startsWith('"') && top?.object && top.expectKey) { const key = JSON.parse(token); if (top.keys.has(key)) fail('metadata snapshot has duplicate JSON key'); top.keys.add(key); top.expectKey = false; } }
}
function snapshotSpec(relativePath) { const spec = SNAPSHOTS[relativePath]; if (!spec) fail('metadata snapshot is not an approved retained conference crawler file'); return spec; }
function sourceSpec(sourceKind, relativePath) {
    if (sourceKind === DATA_SOURCE) return snapshotSpec(relativePath);
    if (sourceKind === ICLR_ACCEPTED_SOURCE && relativePath === ICLR_ACCEPTED_RELATIVE_PATH) return ICLR_ACCEPTED_SPEC;
    fail('metadata source is not an approved retained conference crawler file');
}
function snapshotFile(dataRoot, relativePath) { const root = safeDirectory(dataRoot, 'dataRoot'); snapshotSpec(relativePath); const filename = path.resolve(root, relativePath); if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.resolve(root, path.dirname(relativePath))) fail('metadata snapshot escapes dataRoot'); return filename; }
function readSnapshot(dataRoot, relativePath) {
    const loaded = safeRegularFile(snapshotFile(dataRoot, relativePath), 'metadata snapshot', MAX_METADATA_BYTES); let value;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); value = JSON.parse(text); } catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('metadata snapshot is not strict UTF-8 JSON'); }
    if (!plain(value) || !Array.isArray(value.papers)) fail('metadata snapshot lacks a papers array');
    return { relativePath, records: value.papers, fileSha256: loaded.sha256 };
}
function acceptedSnapshotFile(iclrAcceptedRoot) {
    const root = safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot'); const filename = path.resolve(root, ICLR_ACCEPTED_RELATIVE_PATH);
    if (!filename.startsWith(`${root}${path.sep}`) || path.dirname(filename) !== path.join(root, 'data')) fail('ICLR accepted metadata escapes root');
    return filename;
}
function readIclrAcceptedSnapshot(iclrAcceptedRoot) {
    const loaded = safeRegularFile(acceptedSnapshotFile(iclrAcceptedRoot), 'ICLR accepted metadata snapshot', MAX_METADATA_BYTES); let records;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); records = JSON.parse(text); }
    catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('ICLR accepted metadata snapshot is not strict UTF-8 JSON'); }
    if (!Array.isArray(records)) fail('ICLR accepted metadata snapshot lacks an array');
    return { relativePath: ICLR_ACCEPTED_RELATIVE_PATH, records, fileSha256: loaded.sha256 };
}
function validValue(scheme, value) { return scheme === 'icassp-arnumber' ? /^[1-9]\d*$/.test(String(value || '')) : /^[A-Za-z0-9_-]{6,128}$/.test(String(value || '')); }
function recordIdentity(spec, record) {
    if (!plain(record)) return null; const values = spec.idFields.filter(field => record[field] !== undefined && record[field] !== null).map(field => String(record[field]));
    if (!values.length || !values.every(value => validValue(spec.scheme, value)) || new Set(values).size !== 1) return null;
    return { scheme: spec.scheme, value: values[0] };
}
function pdfPathFor(dataRoot, relativePath, spec, record, externalId, { sourceKind = DATA_SOURCE, iclrAcceptedRoot = null } = {}) {
    if (sourceKind === ICLR_ACCEPTED_SOURCE) {
        if (!iclrAcceptedRoot) return null;
        return path.resolve(safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot'), 'data', 'pdfs', `${externalId.value}.pdf`);
    }
    if (spec.pdf === 'record') { if (typeof record.pdfPath !== 'string' || !path.isAbsolute(record.pdfPath)) return null; return path.resolve(record.pdfPath); }
    return path.resolve(safeDirectory(dataRoot, 'dataRoot'), 'pdfs', 'icml2026', `${externalId.value}.pdf`);
}
function recordIdentityDigest(externalId, pdfAbsolutePath) { return stableHash({ externalId, pdfAbsolutePath }); }
function recordPointer(spec, record, externalId, pdfAbsolutePath) { return { conference: spec.conference, externalId, pdfAbsolutePath, recordIdentitySha256: recordIdentityDigest(externalId, pdfAbsolutePath) }; }
function scanRetainedConferenceCrawlers({ dataRoot } = {}) {
    const matches = new Map(); const files = [];
    for (const relativePath of Object.keys(SNAPSHOTS).sort()) {
        const spec = snapshotSpec(relativePath); const filename = snapshotFile(dataRoot, relativePath);
        if (!fs.existsSync(filename)) continue;
        const snapshot = readSnapshot(dataRoot, relativePath); files.push({ relativePath, metadataSnapshotSha256: snapshot.fileSha256 });
        snapshot.records.forEach((record, recordIndex) => { const externalId = recordIdentity(spec, record); if (!externalId || typeof record.title !== 'string') return; const pdfAbsolutePath = pdfPathFor(dataRoot, relativePath, spec, record, externalId); if (!pdfAbsolutePath) return; let pdf; try { pdf = safeRegularFile(pdfAbsolutePath, 'retained conference PDF', MAX_PDF_BYTES); } catch { return; } if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return;
            const pointer = recordPointer(spec, record, externalId, pdf.absolute); const match = { conference: clone(spec.conference), externalId, metadataSourceKind: DATA_SOURCE, metadataRelativePath: relativePath, metadataSnapshotSha256: snapshot.fileSha256, recordIndex, recordIdentitySha256: pointer.recordIdentitySha256, pdfAbsolutePath: pdf.absolute, pdfSha256: pdf.sha256, metadataTitleFingerprintSha256: titleFingerprint(record.title, 'retained metadata title') };
            const key = `${externalId.scheme}:${externalId.value}`; const values = matches.get(key) || []; values.push(match); matches.set(key, values);
        });
    }
    for (const values of matches.values()) values.sort((a, b) => a.metadataRelativePath.localeCompare(b.metadataRelativePath) || a.recordIndex - b.recordIndex);
    return { files, matches };
}
function scanIclrAcceptedMatches({ iclrAcceptedRoot, titleFingerprintSha256s } = {}) {
    if (!(titleFingerprintSha256s instanceof Set) || ![...titleFingerprintSha256s].every(value => SHA_RE.test(String(value)))) fail('ICLR accepted title fingerprint set is malformed');
    const snapshot = readIclrAcceptedSnapshot(iclrAcceptedRoot); const matches = new Map();
    snapshot.records.forEach((record, recordIndex) => {
        const externalId = recordIdentity(ICLR_ACCEPTED_SPEC, record); if (!externalId || typeof record.title !== 'string') return;
        const metadataTitleFingerprintSha256 = titleFingerprint(record.title, 'ICLR accepted metadata title'); if (!titleFingerprintSha256s.has(metadataTitleFingerprintSha256)) return;
        const pdfAbsolutePath = pdfPathFor(null, ICLR_ACCEPTED_RELATIVE_PATH, ICLR_ACCEPTED_SPEC, record, externalId, { sourceKind: ICLR_ACCEPTED_SOURCE, iclrAcceptedRoot }); if (!pdfAbsolutePath) return;
        let pdf; try { pdf = safeRegularFile(pdfAbsolutePath, 'retained ICLR accepted PDF', MAX_PDF_BYTES); } catch { return; } if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return;
        const pointer = recordPointer(ICLR_ACCEPTED_SPEC, record, externalId, pdf.absolute); const match = { conference: clone(ICLR_ACCEPTED_SPEC.conference), externalId, metadataSourceKind: ICLR_ACCEPTED_SOURCE, metadataRelativePath: ICLR_ACCEPTED_RELATIVE_PATH, metadataSnapshotSha256: snapshot.fileSha256, recordIndex, recordIdentitySha256: pointer.recordIdentitySha256, pdfAbsolutePath: pdf.absolute, pdfSha256: pdf.sha256, metadataTitleFingerprintSha256 };
        const key = `${externalId.scheme}:${externalId.value}`; const values = matches.get(key) || []; values.push(match); matches.set(key, values);
    });
    for (const values of matches.values()) values.sort((a, b) => a.recordIndex - b.recordIndex);
    return { files: [{ sourceKind: ICLR_ACCEPTED_SOURCE, relativePath: snapshot.relativePath, metadataSnapshotSha256: snapshot.fileSha256 }], matches };
}
function titleRecoveryGroups({ state, blogRoot, matches } = {}) {
    if (!plain(state) || !plain(state.source) || !Array.isArray(state.source.papers) || !plain(state.assignments)
        || !(matches instanceof Map)) fail('title recovery requires a crosswalk state and retained metadata matches');
    const byFingerprint = new Map();
    for (const values of matches.values()) for (const match of values) {
        const normalized = normalizeMatch(match); const existing = byFingerprint.get(normalized.metadataTitleFingerprintSha256) || [];
        existing.push(normalized); byFingerprint.set(normalized.metadataTitleFingerprintSha256, existing);
    }
    const groups = new Map();
    for (const page of state.source.papers) {
        const assignment = state.assignments[page.pageKey];
        if (!assignment || assignment.status !== 'pending' || !['none', 'conflict'].includes(page.identityHints?.status)) continue;
        const binding = pageTitleBinding({ blogRoot, pageKey: page.pageKey, pagePath: page.pagePath,
            pageContentSha256: page.pageContentSha256 });
        const candidates = byFingerprint.get(binding.titleFingerprintSha256) || [];
        const exactIds = new Map();
        for (const candidate of candidates) {
            const key = `${candidate.externalId.scheme}:${candidate.externalId.value}`;
            const prior = exactIds.get(key); if (!prior || candidate.metadataRelativePath.localeCompare(prior.metadataRelativePath) < 0) exactIds.set(key, candidate);
        }
        if (exactIds.size !== 1) continue;
        const match = [...exactIds.values()][0];
        if (!['icassp', 'iclr'].includes(match.conference.slug)) continue;
        if (page.scope?.type !== 'conference' || page.scope.key !== `${match.conference.slug}-${match.conference.year}`) continue;
        const key = `${match.externalId.scheme}:${match.externalId.value}`; const group = groups.get(key) || { externalId: clone(match.externalId), match, pageKeys: [], titleBindings: [] };
        group.pageKeys.push(page.pageKey); group.titleBindings.push(binding); groups.set(key, group);
    }
    return [...groups.values()].map(group => ({ ...group, pageKeys: group.pageKeys.sort(),
        titleBindings: normalizeTitleBindings(group.titleBindings) })).sort((left, right) => (
        `${left.externalId.scheme}:${left.externalId.value}`).localeCompare(`${right.externalId.scheme}:${right.externalId.value}`));
}
function identityFor(match) {
    const externalId = identityApi.validateExternalId(match.externalId); return identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'conference', canonicalId: identityApi.canonicalConferenceId(match.conference, externalId), arxivId: null, conference: match.conference, externalId, source: { status: 'unavailable', url: null }, citation: null });
}
function authorityNameFor(match, titleBindings = []) { const pointerSha256 = stableHash({ metadataSourceKind: match.metadataSourceKind, metadataRelativePath: match.metadataRelativePath, metadataSnapshotSha256: match.metadataSnapshotSha256, recordIndex: match.recordIndex, recordIdentitySha256: match.recordIdentitySha256, pdfAbsolutePath: match.pdfAbsolutePath, pdfSha256: match.pdfSha256, metadataTitleFingerprintSha256: match.metadataTitleFingerprintSha256, titleBindings: normalizeTitleBindings(titleBindings) }); return `${AUTHORITY_PREFIX}${pointerSha256}.json`; }
function normalizeMatch(match) {
    exact(match, ['conference', 'externalId', 'metadataSourceKind', 'metadataRelativePath', 'metadataSnapshotSha256', 'recordIndex', 'recordIdentitySha256', 'pdfAbsolutePath', 'pdfSha256', 'metadataTitleFingerprintSha256'], 'conference crawler match'); const spec = sourceSpec(match.metadataSourceKind, match.metadataRelativePath); const externalId = identityApi.validateExternalId(match.externalId); if (externalId.scheme !== spec.scheme || stableHash(match.conference) !== stableHash(spec.conference) || !Number.isSafeInteger(match.recordIndex) || match.recordIndex < 0 || !path.isAbsolute(match.pdfAbsolutePath)) fail('conference crawler match has invalid identity pointer');
    for (const field of ['metadataSnapshotSha256', 'recordIdentitySha256', 'pdfSha256', 'metadataTitleFingerprintSha256']) sha(match[field], field); return { conference: clone(spec.conference), externalId, metadataSourceKind: match.metadataSourceKind, metadataRelativePath: match.metadataRelativePath, metadataSnapshotSha256: match.metadataSnapshotSha256, recordIndex: match.recordIndex, recordIdentitySha256: match.recordIdentitySha256, pdfAbsolutePath: path.resolve(match.pdfAbsolutePath), pdfSha256: match.pdfSha256, metadataTitleFingerprintSha256: match.metadataTitleFingerprintSha256 };
}
function verifyMatchAgainstRetained({ dataRoot, iclrAcceptedRoot = null, match } = {}) {
    const normalized = normalizeMatch(match); const spec = sourceSpec(normalized.metadataSourceKind, normalized.metadataRelativePath); const snapshot = normalized.metadataSourceKind === DATA_SOURCE ? readSnapshot(dataRoot, normalized.metadataRelativePath) : readIclrAcceptedSnapshot(iclrAcceptedRoot); const record = snapshot.records[normalized.recordIndex]; const externalId = recordIdentity(spec, record); if (!externalId || typeof record.title !== 'string' || stableHash(externalId) !== stableHash(normalized.externalId) || snapshot.fileSha256 !== normalized.metadataSnapshotSha256 || titleFingerprint(record.title, 'retained metadata title') !== normalized.metadataTitleFingerprintSha256) fail('retained conference metadata no longer matches the selected stable ID'); const pdfPath = pdfPathFor(dataRoot, normalized.metadataRelativePath, spec, record, externalId, { sourceKind: normalized.metadataSourceKind, iclrAcceptedRoot }); if (!pdfPath || path.resolve(pdfPath) !== normalized.pdfAbsolutePath || recordIdentityDigest(externalId, normalized.pdfAbsolutePath) !== normalized.recordIdentitySha256) fail('retained conference metadata PDF pointer no longer matches the stable ID'); const pdf = safeRegularFile(normalized.pdfAbsolutePath, 'retained conference PDF', MAX_PDF_BYTES); if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.sha256 !== normalized.pdfSha256) fail('retained conference PDF bytes no longer match the selected stable ID'); return normalized;
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'paperId', 'identity', 'identitySha256', 'identityRecordSha256', 'evidenceKind', 'conference', 'externalId', 'metadataSourceKind', 'metadataRelativePath', 'metadataSnapshotSha256', 'recordIndex', 'recordIdentitySha256', 'pdfAbsolutePath', 'pdfSha256', 'metadataTitleFingerprintSha256', 'titleBindings', 'titleBindingsSha256', 'authoritySha256'], 'conference crawler identity authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || value.evidenceKind !== EVIDENCE_KIND) fail('conference crawler authority contract is invalid'); const match = normalizeMatch({ conference: value.conference, externalId: value.externalId, metadataSourceKind: value.metadataSourceKind, metadataRelativePath: value.metadataRelativePath, metadataSnapshotSha256: value.metadataSnapshotSha256, recordIndex: value.recordIndex, recordIdentitySha256: value.recordIdentitySha256, pdfAbsolutePath: value.pdfAbsolutePath, pdfSha256: value.pdfSha256, metadataTitleFingerprintSha256: value.metadataTitleFingerprintSha256 }); const titleBindings = normalizeTitleBindings(value.titleBindings); if (sha(value.titleBindingsSha256, 'titleBindingsSha256') !== stableHash(titleBindings)) fail('conference crawler authority title bindings drifted'); if (titleBindings.some(binding => binding.titleFingerprintSha256 !== match.metadataTitleFingerprintSha256)) fail('conference crawler title binding does not exactly match retained metadata title'); const identity = identityFor(match); if (value.paperId !== identity.canonicalId || sha(value.identitySha256, 'identitySha256') !== identityApi.identitySha256(identity) || sha(value.identityRecordSha256, 'identityRecordSha256') !== identityApi.recordSha256(identity)) fail('conference crawler identity binding is invalid'); const body = clone(value); delete body.authoritySha256; body.identity = identity; body.conference = match.conference; body.externalId = match.externalId; body.titleBindings = titleBindings; if (sha(value.authoritySha256, 'authoritySha256') !== stableHash(body)) fail('conference crawler authority self-SHA drifted'); return { ...body, authoritySha256: value.authoritySha256 };
}
function authorityFor(match, titleBindings = []) { const identity = identityFor(match); const normalizedBindings = normalizeTitleBindings(titleBindings); const body = { contract: CONTRACT, version: VERSION, paperId: identity.canonicalId, identity, identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity), evidenceKind: EVIDENCE_KIND, ...match, titleBindings: normalizedBindings, titleBindingsSha256: stableHash(normalizedBindings) }; return { ...body, authoritySha256: stableHash(body) }; }
function writeExact(root, name, bytes) { const directory = safeDirectory(root, 'conferenceIdentityRoot', { create: true }); const filename = path.join(directory, name); let fd; try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); } catch (error) { if (error.code !== 'EEXIST') throw error; if (!fs.readFileSync(filename).equals(bytes)) fail(`refuses to overwrite different immutable conference authority: ${name}`); } finally { if (fd !== undefined) fs.closeSync(fd); } }
function readAuthority(identityRoot, authorityName) { const root = safeDirectory(identityRoot, 'conferenceIdentityRoot'); if (!SAFE_JSON_NAME.test(String(authorityName || ''))) fail('authorityName is unsafe'); const filename = path.resolve(root, authorityName); if (path.dirname(filename) !== root) fail('authorityName escapes conferenceIdentityRoot'); const loaded = safeRegularFile(filename, 'conference identity authority', MAX_METADATA_BYTES); let value; try { const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); rejectDuplicateJsonKeys(text); value = JSON.parse(text); } catch (error) { if (error instanceof HistoricalConferenceCrawlAuthorityError) throw error; fail('conference identity authority is not strict UTF-8 JSON'); } const authority = normalizeAuthority(value); if (!loaded.bytes.equals(prettyBytes(authority))) fail('conference identity authority bytes are not canonical'); return { filename: loaded.absolute, sha256: loaded.sha256, authority, dev: loaded.dev, ino: loaded.ino }; }
function authorityHandleSnapshot(handle) { if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated conference crawler identity handle required'); return clone(HANDLE_DATA.get(handle).public); }
function matchFromAuthority(authority) { return normalizeMatch({ conference: authority.conference, externalId: authority.externalId, metadataSourceKind: authority.metadataSourceKind, metadataRelativePath: authority.metadataRelativePath, metadataSnapshotSha256: authority.metadataSnapshotSha256, recordIndex: authority.recordIndex, recordIdentitySha256: authority.recordIdentitySha256, pdfAbsolutePath: authority.pdfAbsolutePath, pdfSha256: authority.pdfSha256, metadataTitleFingerprintSha256: authority.metadataTitleFingerprintSha256 }); }
function verifyTitleBindings({ blogRoot, titleBindings }) { const normalized = normalizeTitleBindings(titleBindings); if (!normalized.length) return normalized; if (typeof blogRoot !== 'string' || !path.isAbsolute(blogRoot)) fail('blogRoot is required to replay title-bound conference authority'); return normalized.map(binding => { const current = pageTitleBinding({ blogRoot, ...binding }); if (stableHash(current) !== stableHash(binding)) fail('historical page title binding changed'); return current; }); }
function loadConferenceCrawlAuthorityHandle({ identityRoot, dataRoot, blogRoot = null, iclrAcceptedRoot = null, authorityName } = {}) { const loaded = readAuthority(identityRoot, authorityName); const match = matchFromAuthority(loaded.authority); verifyMatchAgainstRetained({ dataRoot, iclrAcceptedRoot, match }); verifyTitleBindings({ blogRoot, titleBindings: loaded.authority.titleBindings }); const handle = Object.freeze(Object.create(null)); HANDLES.add(handle); HANDLE_DATA.set(handle, Object.freeze({ public: Object.freeze({ authority: clone(loaded.authority), authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true }), identityRoot: safeDirectory(identityRoot, 'conferenceIdentityRoot'), dataRoot: safeDirectory(dataRoot, 'dataRoot'), blogRoot: loaded.authority.titleBindings.length ? safeDirectory(blogRoot, 'blogRoot') : null, iclrAcceptedRoot: loaded.authority.metadataSourceKind === ICLR_ACCEPTED_SOURCE ? safeDirectory(iclrAcceptedRoot, 'iclrAcceptedRoot') : null, authorityFileDev: loaded.dev, authorityFileIno: loaded.ino })); return handle; }
function replayAuthorityHandle(handle, { requireProduction = false } = {}) { if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated conference crawler identity handle required'); const original = HANDLE_DATA.get(handle); if (requireProduction && original.public.productionAuthorized !== true) fail('production-authorized conference crawler identity handle required'); const loaded = readAuthority(original.identityRoot, original.public.authorityName); verifyMatchAgainstRetained({ dataRoot: original.dataRoot, iclrAcceptedRoot: original.iclrAcceptedRoot, match: matchFromAuthority(loaded.authority) }); verifyTitleBindings({ blogRoot: original.blogRoot, titleBindings: loaded.authority.titleBindings }); const current = { authority: loaded.authority, authorityName: original.public.authorityName, authorityFile: loaded.filename, authorityFileSha256: loaded.sha256, productionAuthorized: true }; if (loaded.dev !== original.authorityFileDev || loaded.ino !== original.authorityFileIno || stableHash(current) !== stableHash(original.public)) fail('conference crawler authority or retained evidence changed after handle creation'); return handle; }
function prepareConferenceCrawlAuthority({ identityRoot, dataRoot, blogRoot = null, iclrAcceptedRoot = null, match, titleBindings = [], apply = false } = {}) { const normalized = normalizeMatch(match); const bindings = verifyTitleBindings({ blogRoot, titleBindings }); const authorityName = authorityNameFor(normalized, bindings); if (!apply) return { status: 'dry-run', paperId: identityFor(normalized).canonicalId, authorityName }; const retained = verifyMatchAgainstRetained({ dataRoot, iclrAcceptedRoot, match: normalized }); const authority = authorityFor(retained, bindings); const bytes = prettyBytes(authority); const filename = path.join(path.resolve(identityRoot), authorityName); const existed = fs.existsSync(filename); writeExact(identityRoot, authorityName, bytes); const handle = loadConferenceCrawlAuthorityHandle({ identityRoot, dataRoot, blogRoot, iclrAcceptedRoot, authorityName }); return { status: existed ? 'recovered' : 'created', paperId: authority.paperId, authorityName, authorityHandle: handle, retained }; }

module.exports = { CONTRACT, VERSION, EVIDENCE_KIND, AUTHORITY_PREFIX, SAFE_JSON_NAME, DATA_SOURCE, ICLR_ACCEPTED_SOURCE, ICLR_ACCEPTED_RELATIVE_PATH, HistoricalConferenceCrawlAuthorityError, stableHash, prettyBytes, safeDirectory, titleFingerprint, pageTitleBinding, normalizeTitleBindings, readSnapshot, readIclrAcceptedSnapshot, recordIdentity, scanRetainedConferenceCrawlers, scanIclrAcceptedMatches, titleRecoveryGroups, authorityNameFor, normalizeMatch, normalizeAuthority, verifyMatchAgainstRetained, prepareConferenceCrawlAuthority, loadConferenceCrawlAuthorityHandle, authorityHandleSnapshot, replayAuthorityHandle };
