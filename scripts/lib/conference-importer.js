'use strict';

// Offline, manifest-bound ingestion for local conference source material.  A
// manifest declares the authoritative conference identity and every allowed
// source filename.  Metadata contents (including titles) are never used as an
// identity, matching, or cache-key input.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');

const CONTRACT = 'conference-import-manifest-v1';
const VERSION = 1;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_DERIVED_BYTES = 64 * 1024 * 1024;
const SOURCE_KINDS = new Set(['official-metadata', 'official-pdf', 'conference-proceedings', 'openreview', 'local-confirmed-copy']);
const EVIDENCE_KINDS = ['metadata', 'pdf', 'text', 'artifacts'];
const SHA_RE = /^[a-f0-9]{64}$/;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(message) {
    const error = new Error(`Conference import rejected: ${message}`);
    error.code = 'CONFERENCE_IMPORT_INTEGRITY';
    return error;
}

function exact(value, fields, name) {
    if (!plain(value)) throw fail(`${name} must be a plain object`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw fail(`${name} has unknown or missing fields`);
    }
}

function text(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail(`${name} must be a non-empty trimmed string without controls`);
    }
    return value;
}

function timestamp(value, name) {
    text(value, name);
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(date.getTime()) || date.toISOString() !== value) {
        throw fail(`${name} must be a canonical UTC ISO timestamp`);
    }
    return value;
}

function relativeFile(value, name) {
    try { ledgerApi.assertRelativePath(value, name); }
    catch (error) { throw fail(error.message); }
    return value;
}

function sourceProvenance(value, kind) {
    exact(value, ['kind', 'locator', 'retrievedAt'], `${kind}.provenance`);
    if (!SOURCE_KINDS.has(value.kind)) throw fail(`${kind}.provenance.kind is unsupported for local import`);
    return { kind: value.kind, locator: text(value.locator, `${kind}.provenance.locator`),
        retrievedAt: timestamp(value.retrievedAt, `${kind}.provenance.retrievedAt`) };
}

function derivedProvenance(value, kind) {
    exact(value, ['extractor', 'version'], `${kind}.provenance`);
    return { extractor: text(value.extractor, `${kind}.provenance.extractor`),
        version: text(value.version, `${kind}.provenance.version`) };
}

function expectedSha256(value, name) {
    if (!SHA_RE.test(String(value || ''))) throw fail(`${name} must be a lowercase SHA-256`);
    return value;
}

function jsonPointer(value, name) {
    text(value, name);
    if (!value.startsWith('/') || /~(?:[^01]|$)/u.test(value)) throw fail(`${name} must be a strict JSON Pointer`);
    return value;
}

function metadataIdentityEvidence(value) {
    exact(value, ['conferenceIdPointer', 'conferenceYearPointer', 'identityTypePointer', 'identityValuePointer'], 'metadata.identityEvidence');
    return {
        conferenceIdPointer: jsonPointer(value.conferenceIdPointer, 'metadata.identityEvidence.conferenceIdPointer'),
        conferenceYearPointer: jsonPointer(value.conferenceYearPointer, 'metadata.identityEvidence.conferenceYearPointer'),
        identityTypePointer: jsonPointer(value.identityTypePointer, 'metadata.identityEvidence.identityTypePointer'),
        identityValuePointer: jsonPointer(value.identityValuePointer, 'metadata.identityEvidence.identityValuePointer')
    };
}

function sourceEntry(value, kind) {
    if (value === null) return null;
    exact(value, kind === 'metadata' ? ['file', 'identityEvidence', 'provenance', 'sha256'] : ['file', 'provenance', 'sha256'], kind);
    const entry = { file: relativeFile(value.file, `${kind}.file`), sha256: expectedSha256(value.sha256, `${kind}.sha256`),
        provenance: kind === 'metadata' || kind === 'pdf'
            ? sourceProvenance(value.provenance, kind) : derivedProvenance(value.provenance, kind) };
    if (kind === 'metadata') entry.identityEvidence = metadataIdentityEvidence(value.identityEvidence);
    return entry;
}

function normalizeMember(value) {
    exact(value, ['identity', 'metadata', 'pdf', 'text', 'artifacts'], 'manifest member');
    let identity;
    try { identity = ledgerApi.validateIdentity(value.identity); }
    catch (error) { throw fail(error.message); }
    const member = { identity, metadata: sourceEntry(value.metadata, 'metadata'), pdf: sourceEntry(value.pdf, 'pdf'),
        text: sourceEntry(value.text, 'text'), artifacts: sourceEntry(value.artifacts, 'artifacts') };
    if (!member.metadata) throw fail('manifest member requires metadata');
    if ((member.text || member.artifacts) && !member.pdf) throw fail('derived text or artifacts require a manifest PDF');
    const seen = EVIDENCE_KINDS.filter(kind => member[kind]).map(kind => member[kind].file);
    if (new Set(seen).size !== seen.length) throw fail('manifest source filenames must not alias each other');
    return member;
}

function manifestMemberSetSha256(members) {
    return ledgerApi.memberSetSha256(members.map(member => ({ identity: member.identity })));
}

function validateManifest(manifest) {
    exact(manifest, ['contract', 'version', 'conference', 'members', 'memberSetSha256'], 'conference import manifest');
    if (manifest.contract !== CONTRACT || manifest.version !== VERSION) throw fail('unsupported conference import manifest contract');
    exact(manifest.conference, ['id', 'year'], 'manifest conference');
    // Reuse ledger validation for conference spelling without accepting any
    // authoring fields beyond this importer contract.
    const conference = { id: manifest.conference.id, year: manifest.conference.year };
    try { ledgerApi.createLedger(conference, [placeholderMember()]); }
    catch (error) {
        // placeholder validity is fixed; only reframe the conference failure.
        if (!/conference/.test(error.message)) throw error;
        throw fail(error.message);
    }
    if (!Array.isArray(manifest.members) || !manifest.members.length) throw fail('manifest requires non-empty members');
    const members = manifest.members.map(normalizeMember);
    const keys = members.map(member => ledgerApi.identityKey(member.identity));
    if (new Set(keys).size !== keys.length) throw fail('manifest contains duplicate identities');
    const ordered = [...keys].sort();
    if (keys.some((key, index) => key !== ordered[index])) throw fail('manifest members must be sorted by canonical identity');
    if (!/^[a-f0-9]{64}$/.test(String(manifest.memberSetSha256 || ''))
        || manifest.memberSetSha256 !== manifestMemberSetSha256(members)) throw fail('manifest memberSetSha256 mismatch');
    return { contract: CONTRACT, version: VERSION, conference, members, memberSetSha256: manifest.memberSetSha256 };
}

// A fixed valid record lets the ledger contract validate only conference input
// without weakening the importer to title-based or ad-hoc conference names.
function placeholderMember() {
    const hash = 'a'.repeat(64);
    return {
        identity: { type: 'conference-paper-id', value: '1' }, metadataFile: 'm.json', metadataSha256: hash,
        pdfFile: 'p.pdf', pdfSha256: hash, textFile: 't.txt', textSha256: hash, artifactsFile: 'a.json', artifactsSha256: hash,
        availability: { metadata: 'present', pdf: 'present', text: 'present', artifacts: 'present' },
        provenance: {
            metadata: { kind: 'official-metadata', locator: 'fixture:metadata', retrievedAt: '2026-01-01T00:00:00.000Z' },
            pdf: { kind: 'official-pdf', locator: 'fixture:pdf', retrievedAt: '2026-01-01T00:00:00.000Z' },
            text: { extractor: 'fixture', version: '1', inputSha256: hash }, artifacts: { extractor: 'fixture', version: '1', inputSha256: hash }
        },
        status: { state: 'verified', updatedAt: '2026-01-01T00:00:00.000Z', reason: 'fixture', evidence: EVIDENCE_KINDS.map(kind => ({ kind, sha256: hash })) }
    };
}

function safeDirectory(root, name) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail(`${name} must be an absolute path`);
    const absolute = path.resolve(root);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`${name} contains an unsafe directory: ${cursor}`);
    }
    if (fs.realpathSync(absolute) !== absolute) throw fail(`${name} must not resolve through a symbolic link`);
    return absolute;
}

function safePath(root, relative, label) {
    relativeFile(relative, label);
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) throw fail(`${label} escapes its root`);
    let cursor = root;
    for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== target)) throw fail(`${label} traverses an unsafe path`);
    }
    return target;
}

function readSource(root, relative, maxBytes, label) {
    const filename = safePath(root, relative, label);
    let fd;
    try {
        // lstat before open prevents opening a FIFO/device (which can block),
        // while O_NONBLOCK and the post-open inode check close the TOCTOU gap.
        const namedBefore = fs.lstatSync(filename);
        if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1 || namedBefore.size > maxBytes) {
            throw fail(`${label} must be a regular single-link file within its size limit`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            throw fail(`${label} must be a regular single-link file within its size limit`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) throw fail(`${label} changed while being read`);
        return bytes;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw fail(`${label} must not contain duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function parseStrictJson(bytes, label) {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        return JSON.parse(source);
    }
    catch { throw fail(`${label} must contain valid UTF-8 JSON`); }
}

function parseStrictUtf8(bytes, label) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw fail(`${label} must contain strict UTF-8 text`); }
}

function resolveJsonPointer(document, pointer, label) {
    let current = document;
    for (const encoded of pointer.slice(1).split('/')) {
        const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) throw fail(`${label} does not resolve in metadata JSON`);
            current = current[Number(key)];
        } else if (plain(current) && Object.prototype.hasOwnProperty.call(current, key)) current = current[key];
        else throw fail(`${label} does not resolve in metadata JSON`);
    }
    return current;
}

function assertMetadataIdentity(metadata, evidence, conference, identity) {
    const expected = [
        ['conferenceIdPointer', conference.id], ['conferenceYearPointer', conference.year],
        ['identityTypePointer', identity.type], ['identityValuePointer', identity.value]
    ];
    for (const [field, value] of expected) {
        if (resolveJsonPointer(metadata, evidence[field], `metadata.identityEvidence.${field}`) !== value) {
            throw fail(`metadata.identityEvidence.${field} must exactly bind the manifest conference and identity`);
        }
    }
}

function cacheStem(conference, identity) {
    const key = ledgerApi.identityKey(identity);
    return `${conference.id}-${conference.year}/${key.replace(':', '--')}`;
}

function writeAtomicallyOnce(filename, bytes) {
    const parent = path.dirname(filename);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    // Re-check each newly-created directory before accepting it as a cache path.
    safeDirectory(parent, 'cache destination directory');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function cacheArtifact(cacheRoot, destinationRelative, bytes) {
    const filename = path.resolve(cacheRoot, ...destinationRelative.split('/'));
    if (!filename.startsWith(`${cacheRoot}${path.sep}`)) throw fail('computed cache destination escapes cache root');
    try { writeAtomicallyOnce(filename, bytes); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readSource(cacheRoot, destinationRelative, Math.max(bytes.length, 1), 'existing cache artifact');
        if (!crypto.timingSafeEqual(Buffer.from(sha256(existing), 'hex'), Buffer.from(sha256(bytes), 'hex'))) {
            throw fail(`cache destination already exists with different bytes: ${destinationRelative}`);
        }
    }
    return { file: destinationRelative, sha256: sha256(bytes) };
}

function importMember(member, conference, sourceRoot, cacheRoot, updatedAt, apply) {
    const stem = cacheStem(conference, member.identity);
    const artifacts = {};
    for (const kind of EVIDENCE_KINDS) {
        const entry = member[kind];
        if (!entry) { artifacts[kind] = null; continue; }
        const limit = kind === 'metadata' ? MAX_METADATA_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : MAX_DERIVED_BYTES;
        const bytes = readSource(sourceRoot, entry.file, limit, `manifest ${kind} source`);
        const actualSha256 = sha256(bytes);
        if (actualSha256 !== entry.sha256) throw fail(`manifest ${kind} source SHA-256 does not match its declared expected SHA-256`);
        if (kind === 'metadata') {
            const metadata = parseStrictJson(bytes, 'manifest metadata source');
            assertMetadataIdentity(metadata, entry.identityEvidence, conference, member.identity);
        } else if (kind === 'artifacts') parseStrictJson(bytes, 'manifest artifacts source');
        else if (kind === 'text') parseStrictUtf8(bytes, 'manifest text source');
        if (kind === 'pdf' && (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')) throw fail('manifest PDF source is not a standard PDF');
        const extension = kind === 'metadata' || kind === 'artifacts' ? '.json' : kind === 'pdf' ? '.pdf' : '.txt';
        const destination = `${stem}/${kind}${extension}`;
        artifacts[kind] = apply ? cacheArtifact(cacheRoot, destination, bytes) : { file: destination, sha256: actualSha256 };
    }
    const availability = Object.fromEntries(EVIDENCE_KINDS.map(kind => [kind, artifacts[kind] ? 'present' : 'absent']));
    const hasAll = EVIDENCE_KINDS.every(kind => artifacts[kind]);
    const state = hasAll ? 'verified' : 'blocked';
    const missing = EVIDENCE_KINDS.filter(kind => !artifacts[kind]);
    const result = {
        identity: member.identity,
        metadataFile: artifacts.metadata?.file || null, metadataSha256: artifacts.metadata?.sha256 || null,
        pdfFile: artifacts.pdf?.file || null, pdfSha256: artifacts.pdf?.sha256 || null,
        textFile: artifacts.text?.file || null, textSha256: artifacts.text?.sha256 || null,
        artifactsFile: artifacts.artifacts?.file || null, artifactsSha256: artifacts.artifacts?.sha256 || null,
        availability,
        provenance: {
            metadata: member.metadata ? member.metadata.provenance : null,
            pdf: member.pdf ? member.pdf.provenance : null,
            text: member.text ? { ...member.text.provenance, inputSha256: artifacts.pdf.sha256 } : null,
            artifacts: member.artifacts ? { ...member.artifacts.provenance, inputSha256: artifacts.pdf.sha256 } : null
        },
        status: { state, updatedAt, reason: state === 'verified'
            ? 'Manifest-bound local metadata, PDF, extracted text, and structured artifacts were copied and SHA-256 verified.'
            : `Manifest-bound identity is retained but replay artifacts are unavailable: ${missing.join(', ')}.`,
            evidence: EVIDENCE_KINDS.filter(kind => artifacts[kind]).map(kind => ({ kind, sha256: artifacts[kind].sha256 })) }
    };
    try { return ledgerApi.validateMember(result); }
    catch (error) { throw fail(error.message); }
}

function importConferenceSources({ manifest, sourceRoot, cacheRoot, updatedAt, apply = false } = {}) {
    if (typeof apply !== 'boolean') throw fail('apply must be boolean');
    const normalized = validateManifest(manifest);
    timestamp(updatedAt, 'updatedAt');
    const safeSourceRoot = safeDirectory(sourceRoot, 'sourceRoot');
    const safeCacheRoot = safeDirectory(cacheRoot, 'cacheRoot');
    if (safeSourceRoot === safeCacheRoot || safeSourceRoot.startsWith(`${safeCacheRoot}${path.sep}`)
        || safeCacheRoot.startsWith(`${safeSourceRoot}${path.sep}`)) {
        throw fail('sourceRoot and cacheRoot must not overlap');
    }
    const members = normalized.members.map(member => importMember(member, normalized.conference, safeSourceRoot, safeCacheRoot, updatedAt, apply));
    const ledger = ledgerApi.createLedger(normalized.conference, members);
    return { manifestSha256: ledgerApi.stableHash(normalized), ledger, imported: members.length,
        verified: members.filter(member => member.status.state === 'verified').length,
        blocked: members.filter(member => member.status.state === 'blocked').length,
        mode: apply ? 'apply' : 'dry-run' };
}

module.exports = {
    CONTRACT, VERSION, MAX_METADATA_BYTES, MAX_PDF_BYTES, MAX_DERIVED_BYTES,
    validateManifest, importConferenceSources, safeDirectory, readSource, cacheStem
};
