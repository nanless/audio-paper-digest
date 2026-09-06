'use strict';

// Offline, manifest-bound ingestion for local conference source material.  A
// manifest declares the authoritative conference identity and every allowed
// source filename.  Metadata contents (including titles) are never used as an
// identity, matching, or cache-key input.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const paperIdentity = require('./paper-identity.js');

const CONTRACT = 'conference-import-manifest-v2';
const VERSION = 2;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_DERIVED_BYTES = 64 * 1024 * 1024;
const SOURCE_KINDS = new Set(['official-metadata', 'official-pdf', 'conference-proceedings', 'openreview', 'local-confirmed-copy']);
const EVIDENCE_KINDS = ['metadata', 'pdf', 'text', 'artifacts'];
const SHA_RE = /^[a-f0-9]{64}$/;
const IMPORT_RECEIPT_CONTRACT = 'conference-import-receipt-v2';
const IMPORT_HANDLES = new WeakSet();
const IMPORT_HANDLE_DATA = new WeakMap();

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
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

function metadataDiscoveryBinding(value) {
    exact(value, ['catalogSha256', 'metadataSnapshotSha256', 'metadataIndex', 'metadataRecordSha256'],
        'metadata.discoveryBinding');
    if (!Number.isSafeInteger(value.metadataIndex) || value.metadataIndex < 0) {
        throw fail('metadata.discoveryBinding.metadataIndex must be a nonnegative safe integer');
    }
    return { catalogSha256: expectedSha256(value.catalogSha256, 'metadata.discoveryBinding.catalogSha256'),
        metadataSnapshotSha256: expectedSha256(value.metadataSnapshotSha256, 'metadata.discoveryBinding.metadataSnapshotSha256'),
        metadataIndex: value.metadataIndex,
        metadataRecordSha256: expectedSha256(value.metadataRecordSha256, 'metadata.discoveryBinding.metadataRecordSha256') };
}

function sourceEntry(value, kind) {
    if (value === null) return null;
    exact(value, kind === 'metadata'
        ? ['file', 'identityEvidence', 'discoveryBinding', 'provenance', 'sha256']
        : ['file', 'provenance', 'sha256'], kind);
    const entry = { file: relativeFile(value.file, `${kind}.file`), sha256: expectedSha256(value.sha256, `${kind}.sha256`),
        provenance: kind === 'metadata' || kind === 'pdf'
            ? sourceProvenance(value.provenance, kind) : derivedProvenance(value.provenance, kind) };
    if (kind === 'metadata') {
        entry.identityEvidence = metadataIdentityEvidence(value.identityEvidence);
        entry.discoveryBinding = metadataDiscoveryBinding(value.discoveryBinding);
    }
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

function safeDirectory(root, name, { allowMissing = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail(`${name} must be an absolute path`);
    const absolute = path.resolve(root);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (allowMissing && error.code === 'ENOENT' && cursor === absolute) return absolute;
            throw error;
        }
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
    const temporary = path.join(parent, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        // Publish only after the complete bytes have reached a same-directory
        // temporary inode.  A short write must never reserve the immutable
        // destination name with corrupt bytes and poison every later retry.
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
        fs.linkSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
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
    const safeCacheRoot = safeDirectory(cacheRoot, 'cacheRoot', { allowMissing: !apply });
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

function importConferenceSourcesFromStaging({ stagingHandle, sourceRoot, cacheRoot, updatedAt, apply = false } = {}) {
    // Lazy loading avoids a module-init cycle: conference-staging deliberately
    // reuses this module's import-manifest validator.
    const stagingApi = require('./conference-staging.js');
    let staged;
    try { staged = stagingApi.stagingHandleSnapshot(stagingHandle); }
    catch (error) { throw fail(`requires an authenticated staging handle: ${error.message}`); }
    const result = importConferenceSources({ manifest: staged.importManifest, sourceRoot, cacheRoot, updatedAt, apply });
    return { ...result, stagingBinding: {
        filterPolicySha256: staged.receipt.selection.filterPolicySha256,
        selectedMemberSetSha256: staged.receipt.selection.selectedMemberSetSha256,
        selectionReceiptSha256: staged.receipt.selection.selectionReceiptSha256,
        stagingReceiptSha256: staged.receipt.receiptSha256,
        stagingReceiptFileSha256: staged.receiptFileSha256,
        importManifestFileSha256: staged.importManifestFileSha256
    } };
}

function createImportReceipt({ result, ledgerName } = {}) {
    if (!plain(result) || !plain(result.ledger) || !plain(result.stagingBinding)) throw fail('import receipt requires a staging-bound import result');
    if (typeof ledgerName !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(ledgerName)) {
        throw fail('import receipt ledgerName must be a safe direct JSON filename');
    }
    validateLedgerForReceipt(result.ledger);
    for (const [field, value] of Object.entries(result.stagingBinding)) expectedSha256(value, `stagingBinding.${field}`);
    const ledgerBytes = Buffer.from(`${JSON.stringify(result.ledger, null, 2)}\n`, 'utf8');
    const body = {
        contract: IMPORT_RECEIPT_CONTRACT, version: VERSION,
        filterPolicySha256: result.stagingBinding.filterPolicySha256,
        selectedMemberSetSha256: result.stagingBinding.selectedMemberSetSha256,
        selectionReceiptSha256: result.stagingBinding.selectionReceiptSha256,
        stagingReceiptSha256: result.stagingBinding.stagingReceiptSha256,
        stagingReceiptFileSha256: result.stagingBinding.stagingReceiptFileSha256,
        importManifestFileSha256: result.stagingBinding.importManifestFileSha256,
        importManifestSha256: result.manifestSha256,
        ledger: { name: ledgerName, sha256: sha256(ledgerBytes), memberSetSha256: result.ledger.memberSetSha256 },
        counts: { imported: result.imported, verified: result.verified, blocked: result.blocked }
    };
    return { ledgerBytes, receipt: { ...body, receiptSha256: ledgerApi.stableHash(body) } };
}

function normalizeImportReceipt(value) {
    exact(value, ['contract', 'version', 'filterPolicySha256', 'selectedMemberSetSha256',
        'selectionReceiptSha256', 'stagingReceiptSha256', 'stagingReceiptFileSha256',
        'importManifestFileSha256', 'importManifestSha256', 'ledger', 'counts', 'receiptSha256'], 'import receipt');
    if (value.contract !== IMPORT_RECEIPT_CONTRACT || value.version !== VERSION) throw fail('import receipt contract/version is unsupported');
    for (const field of ['filterPolicySha256', 'selectedMemberSetSha256', 'selectionReceiptSha256',
        'stagingReceiptSha256', 'stagingReceiptFileSha256',
        'importManifestFileSha256', 'importManifestSha256']) expectedSha256(value[field], `import receipt ${field}`);
    exact(value.ledger, ['name', 'sha256', 'memberSetSha256'], 'import receipt ledger');
    if (typeof value.ledger.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(value.ledger.name)) {
        throw fail('import receipt ledger.name is unsafe');
    }
    expectedSha256(value.ledger.sha256, 'import receipt ledger.sha256');
    expectedSha256(value.ledger.memberSetSha256, 'import receipt ledger.memberSetSha256');
    exact(value.counts, ['imported', 'verified', 'blocked'], 'import receipt counts');
    for (const [field, amount] of Object.entries(value.counts)) {
        if (!Number.isSafeInteger(amount) || amount < 0) throw fail(`import receipt counts.${field} must be nonnegative`);
    }
    const body = clone(value); delete body.receiptSha256;
    if (expectedSha256(value.receiptSha256, 'import receipt receiptSha256') !== ledgerApi.stableHash(body)) {
        throw fail('import receipt SHA does not bind its content');
    }
    return { ...body, receiptSha256: value.receiptSha256 };
}

function loadImportHandle(ledgerFile, importReceiptFile, stagingHandle) {
    const stagingApi = require('./conference-staging.js');
    let staged;
    try { staged = stagingApi.stagingHandleSnapshot(stagingHandle); }
    catch (error) { throw fail(`requires an authenticated staging handle: ${error.message}`); }
    let loadedLedger; let loadedReceipt; let ledgerHandle;
    try {
        ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
        const ledgerSnapshot = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
        loadedLedger = { ledger: ledgerSnapshot.ledger, ledgerSha256: ledgerSnapshot.ledgerSha256,
            filename: ledgerSnapshot.filename };
        loadedReceipt = ledgerApi.readRegularJson(importReceiptFile);
    } catch (error) { throw fail(`import bundle cannot be read safely: ${error.message}`); }
    const receipt = normalizeImportReceipt(loadedReceipt.value);
    const expectedStaging = {
        filterPolicySha256: staged.receipt.selection.filterPolicySha256,
        selectedMemberSetSha256: staged.receipt.selection.selectedMemberSetSha256,
        selectionReceiptSha256: staged.receipt.selection.selectionReceiptSha256,
        stagingReceiptSha256: staged.receipt.receiptSha256,
        stagingReceiptFileSha256: staged.receiptFileSha256,
        importManifestFileSha256: staged.importManifestFileSha256,
        importManifestSha256: ledgerApi.stableHash(staged.importManifest)
    };
    for (const [field, expected] of Object.entries(expectedStaging)) {
        if (receipt[field] !== expected) throw fail(`import receipt ${field} does not bind staging`);
    }
    if (receipt.ledger.name !== path.basename(ledgerFile) || receipt.ledger.sha256 !== loadedLedger.ledgerSha256
        || receipt.ledger.memberSetSha256 !== loadedLedger.ledger.memberSetSha256) {
        throw fail('import receipt does not bind the exact ledger file');
    }
    const counts = { imported: loadedLedger.ledger.members.length,
        verified: loadedLedger.ledger.members.filter(member => member.status.state === 'verified').length,
        blocked: loadedLedger.ledger.members.filter(member => member.status.state === 'blocked').length };
    if (ledgerApi.stableHash(receipt.counts) !== ledgerApi.stableHash(counts)) throw fail('import receipt counts drifted from ledger');
    const stagedIdentities = staged.importManifest.members.map(member => ledgerApi.identityKey(member.identity)).sort();
    const ledgerIdentities = loadedLedger.ledger.members.map(member => ledgerApi.identityKey(member.identity)).sort();
    if (ledgerApi.stableHash(stagedIdentities) !== ledgerApi.stableHash(ledgerIdentities)) {
        throw fail('ledger identity set differs from staged included selection');
    }
    const verifiedMembers = loadedLedger.ledger.members.filter(member => member.status.state === 'verified').map(member => {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        return { paperId: paperIdentity.canonicalConferencePaperId(
            loadedLedger.ledger.conference, member.identity), sourceIdentity };
    });
    const handle = Object.freeze(Object.create(null)); IMPORT_HANDLES.add(handle);
    IMPORT_HANDLE_DATA.set(handle, Object.freeze({ ledger: clone(loadedLedger.ledger), ledgerSha256: loadedLedger.ledgerSha256,
        ledgerFile: loadedLedger.filename, ledgerHandle, receipt: clone(receipt),
        receiptFile: fs.realpathSync(importReceiptFile), receiptFileSha256: loadedReceipt.sha256,
        staging: staged, verifiedMembers }));
    return handle;
}

function importHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !IMPORT_HANDLES.has(handle)) throw fail('requires an authenticated import handle');
    const value = IMPORT_HANDLE_DATA.get(handle);
    return { ledger: clone(value.ledger), ledgerSha256: value.ledgerSha256, ledgerFile: value.ledgerFile,
        receipt: clone(value.receipt), receiptFile: value.receiptFile, receiptFileSha256: value.receiptFileSha256,
        staging: clone(value.staging), verifiedMembers: clone(value.verifiedMembers) };
}

function importHandleAuthority(handle) {
    if (!handle || typeof handle !== 'object' || !IMPORT_HANDLES.has(handle)) throw fail('requires an authenticated import handle');
    const value = IMPORT_HANDLE_DATA.get(handle);
    return { snapshot: importHandleSnapshot(handle), ledgerHandle: value.ledgerHandle };
}

function validateLedgerForReceipt(value) {
    try { return ledgerApi.validateLedger(value); }
    catch (error) { throw fail(`import receipt ledger is invalid: ${error.message}`); }
}

module.exports = {
    CONTRACT, VERSION, IMPORT_RECEIPT_CONTRACT, MAX_METADATA_BYTES, MAX_PDF_BYTES, MAX_DERIVED_BYTES,
    validateManifest, importConferenceSources, importConferenceSourcesFromStaging, createImportReceipt,
    normalizeImportReceipt, loadImportHandle, importHandleSnapshot, importHandleAuthority,
    safeDirectory, readSource, cacheStem
};
