'use strict';

// Offline, immutable evidence preparation for conference filtering.  This
// module deliberately does not classify papers or call an LLM.  It binds a
// deterministic PDF text extraction and an exact abstract slice to an
// authenticated discovery pair so a later filter contract can consume it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const discoveryApi = require('./conference-discovery.js');
const ledgerApi = require('./conference-source-ledger.js');
const paperIdentity = require('./paper-identity.js');
const extractionApi = require('./conference-extraction-receipt.js');

const VERSION = 1;
const RUN_CONTRACT = 'conference-filter-evidence-run-v1';
const PROJECTION_CONTRACT = 'conference-filter-evidence-projection-v1';
const RECEIPT_CONTRACT = 'conference-filter-evidence-receipt-v1';
const CATALOG_CONTRACT = 'conference-filter-evidence-catalog-v1';
const REPORT_CONTRACT = 'conference-filter-evidence-report-v1';
const LOCATOR_CONTRACT = 'abstract-locator-v1';
const BLOCKED_VERIFICATION_CONTRACT = 'conference-pdf-extraction-blocked-verification-v1';
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVIDENCE_STATUSES = new Set(['ready', 'missing', 'ambiguous', 'too-short', 'extraction-blocked']);
const ABSTRACT_MIN_CHARS = 80;
const ABSTRACT_MAX_CHARS = 12000;
const DEFAULT_LOCATOR_PROFILE = 'default-v1';
const AAAI_LOCATOR_PROFILE = 'aaai-2026-bare-introduction-v1';
const LOCATOR_RULES = Object.freeze({
    pages: 2,
    start: '^\\s*(?:abstract|摘要)\\s*(?:[:—–-]\\s*)?',
    end: '^\\s*(?:keywords?|index terms?|ccs concepts?|(?:1|i)[.]?\\s+introduction)\\s*(?:[:—–-]\\s*)?',
    minimumCharacters: ABSTRACT_MIN_CHARS,
    maximumCharacters: ABSTRACT_MAX_CHARS,
    normalization: 'exact-utf8-slice-trim-v1'
});
const AAAI_LOCATOR_RULES = Object.freeze({
    ...LOCATOR_RULES,
    end: '(?:^\\s*(?:keywords?|index terms?|ccs concepts?)\\s*(?:[:—–-]\\s*)?)|(?:^\\s*(?:(?:1|i)[.]?\\s+)?introduction\\s*$)',
    bareIntroduction: '^\\s*introduction\\s*$',
    bareIntroductionMaximumMatches: 1
});
const EVIDENCE_HANDLES = new WeakSet();
const EVIDENCE_HANDLE_DATA = new WeakMap();

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const stableHash = value => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));
const LOCATOR_IMPLEMENTATION_SHA256 = stableHash(LOCATOR_RULES);
const LOCATOR_PROFILES = Object.freeze({
    [DEFAULT_LOCATOR_PROFILE]: Object.freeze({ rules: LOCATOR_RULES,
        implementationSha256: LOCATOR_IMPLEMENTATION_SHA256 }),
    [AAAI_LOCATOR_PROFILE]: Object.freeze({ rules: AAAI_LOCATOR_RULES,
        implementationSha256: stableHash(AAAI_LOCATOR_RULES) })
});
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message) {
    const error = new Error(`Conference filter evidence rejected: ${message}`);
    error.code = 'CONFERENCE_FILTER_EVIDENCE_INTEGRITY';
    throw error;
}
function exact(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}
function text(value, label, { nullable = false, maximum = 20000, allowExtractorControls = false } = {}) {
    if (nullable && value === null) return null;
    const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
        || (!allowExtractorControls && forbiddenControls.test(value))) fail(`${label} is invalid`);
    return value;
}
function safeDirectory(root, { create = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('evidence root must be absolute');
    const absolute = path.resolve(root); const parent = path.dirname(absolute);
    if (create && !fs.existsSync(absolute)) {
        const parentInfo = fs.lstatSync(parent);
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('evidence root parent is unsafe');
        fs.mkdirSync(absolute, { mode: 0o700 });
    }
    const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail('evidence root is unsafe');
    return absolute;
}
function direct(root, name) {
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) fail('unsafe direct filename');
    const filename = path.join(root, name);
    if (path.dirname(filename) !== root) fail('direct filename escaped its root');
    return filename;
}
function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
            fail(`${label} must be a bounded regular single-link file`);
        }
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink()
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
            fail(`${label} changed while opening`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) fail(`${label} changed while reading`);
        return { bytes, sha256: sha256(bytes), size: bytes.length };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readJson(filename, label, maximum = 64 * 1024 * 1024) {
    const loaded = readRegular(filename, maximum, label);
    let value;
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        const stack = [];
        for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
            const token = match[0]; const top = stack.at(-1);
            if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
            else if (token === '[') stack.push({ object: false });
            else if (token === '}' || token === ']') stack.pop();
            else if (token === ',' && top?.object) top.expectKey = true;
            else if (token.startsWith('"') && top?.object && top.expectKey) {
                const key = JSON.parse(token);
                if (top.keys.has(key)) fail(`${label} contains duplicate JSON key`);
                top.keys.add(key); top.expectKey = false;
            }
        }
        value = JSON.parse(source);
    }
    catch { fail(`${label} must be strict UTF-8 JSON`); }
    return { ...loaded, value };
}
function writeExclusive(filename, bytes) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function atomicState(filename, value) {
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    writeExclusive(temporary, jsonBytes(value));
    try {
        fs.renameSync(temporary, filename);
        const directoryFd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY);
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function timestamp(now = new Date()) { return new Date(now).toISOString(); }

function pageArtifact(value, textBytes) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.pages) || !value.pages.length) {
        fail('structured extraction artifact lacks page ranges');
    }
    let cursor = 0;
    const pages = value.pages.map((page, index) => {
        exact(page, ['page', 'textStart', 'textEnd'], `page[${index}]`);
        if (page.page !== index + 1 || page.textStart !== cursor || !Number.isSafeInteger(page.textEnd)
            || page.textEnd <= page.textStart || page.textEnd > textBytes.length) fail('page ranges are not a byte partition');
        cursor = page.textEnd; return clone(page);
    });
    if (cursor !== textBytes.length) fail('page ranges do not cover extracted text');
    return pages;
}
function unavailable(status, reason) {
    return { status, reason, text: null, page: null, textStart: null, textEnd: null, sha256: null };
}
function locatorProfileForConference(conference) {
    return conference?.id === 'aaai-2026' ? AAAI_LOCATOR_PROFILE : DEFAULT_LOCATOR_PROFILE;
}
function locatorBindingForConference(conference) {
    const profile = locatorProfileForConference(conference); const selected = LOCATOR_PROFILES[profile];
    return profile === DEFAULT_LOCATOR_PROFILE
        ? { contract: LOCATOR_CONTRACT, implementationSha256: selected.implementationSha256 }
        : { contract: LOCATOR_CONTRACT, profile, implementationSha256: selected.implementationSha256 };
}
function validateLocatorBinding(value, conference, label) {
    const expected = locatorBindingForConference(conference);
    exact(value, Object.keys(expected), label);
    if (stableHash(value) !== stableHash(expected)) fail(`${label} implementation/profile drifted`);
    return locatorProfileForConference(conference);
}
function locateAbstract(textBytes, artifact, profile = DEFAULT_LOCATOR_PROFILE) {
    if (!Buffer.isBuffer(textBytes)) fail('extracted text must be a Buffer');
    const selectedProfile = LOCATOR_PROFILES[profile];
    if (!selectedProfile) fail('abstract locator profile is unsupported');
    const rules = selectedProfile.rules;
    const pages = pageArtifact(artifact, textBytes); const selected = pages.slice(0, rules.pages);
    const byteEnd = selected.at(-1).textEnd; const prefixBytes = textBytes.subarray(0, byteEnd);
    let prefix;
    try { prefix = new TextDecoder('utf-8', { fatal: true }).decode(prefixBytes); }
    catch { return unavailable('extraction-blocked', 'first pages are not strict UTF-8'); }
    const starts = [...prefix.matchAll(new RegExp(rules.start, 'gimu'))];
    if (!starts.length) return unavailable('missing', 'no exact abstract heading in the first two pages');
    if (starts.length !== 1) return unavailable('ambiguous', 'multiple abstract headings in the first two pages');
    const contentStart = starts[0].index + starts[0][0].length;
    const suffix = prefix.slice(contentStart);
    if (profile === AAAI_LOCATOR_PROFILE) {
        const bareIntroductions = [...suffix.matchAll(new RegExp(rules.bareIntroduction, 'gimu'))];
        if (bareIntroductions.length > rules.bareIntroductionMaximumMatches) {
            return unavailable('ambiguous', 'multiple bare Introduction headings in the first two pages');
        }
    }
    const ends = [...suffix.matchAll(new RegExp(rules.end, 'gimu'))];
    if (!ends.length) return unavailable('missing', 'abstract end heading is not bounded');
    const rawEnd = contentStart + ends[0].index;
    const raw = prefix.slice(contentStart, rawEnd);
    const leading = raw.match(/^\s*/u)[0].length; const trailing = raw.match(/\s*$/u)[0].length;
    const startChar = contentStart + leading; const endChar = rawEnd - trailing;
    const evidenceText = prefix.slice(startChar, endChar);
    const characterCount = [...evidenceText].length;
    if (characterCount < ABSTRACT_MIN_CHARS) return unavailable('too-short', 'located abstract is below 80 characters');
    if (characterCount > ABSTRACT_MAX_CHARS) return unavailable('ambiguous', 'located abstract exceeds the bounded evidence limit');
    const textStart = Buffer.byteLength(prefix.slice(0, startChar), 'utf8');
    const textEnd = Buffer.byteLength(prefix.slice(0, endChar), 'utf8');
    const exactBytes = textBytes.subarray(textStart, textEnd);
    if (exactBytes.toString('utf8') !== evidenceText) fail('abstract UTF-8 offsets do not replay');
    const page = pages.find(item => textStart >= item.textStart && textStart < item.textEnd)?.page;
    if (!page) fail('abstract offset is outside page ranges');
    return { status: 'ready', reason: 'unique bounded abstract heading span', text: evidenceText,
        page, textStart, textEnd, sha256: sha256(exactBytes) };
}

function discoverySnapshot(handle) {
    try { return discoveryApi.discoveryHandleSnapshot(handle); }
    catch (error) { fail(`authenticated discovery handle required: ${error.message}`); }
}
function runBinding(snapshot, runId) {
    if (!UUID_RE.test(String(runId || ''))) fail('runId must be a canonical UUID v4');
    return { runId, conference: clone(snapshot.candidateManifest.conference), catalogSha256: snapshot.catalogSha256,
        reportSha256: snapshot.reportSha256, metadataSnapshotSha256: snapshot.candidateManifest.metadataSnapshot.sha256,
        pdfCatalogSha256: snapshot.candidateManifest.pdfCatalogSha256,
        memberSetSha256: snapshot.candidateManifest.memberSetSha256 };
}
function initialState(snapshot, runId, now) {
    const members = snapshot.candidateManifest.members.map(member => {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        return { paperId: paperIdentity.canonicalConferencePaperId(snapshot.candidateManifest.conference, member.identity),
            sourceIdentity, status: 'pending', itemName: sha256(Buffer.from(sourceIdentity, 'utf8')),
            receiptFileSha256: null, receiptSha256: null, evidenceSha256: null };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const body = { contract: RUN_CONTRACT, version: VERSION, binding: runBinding(snapshot, runId),
        locator: locatorBindingForConference(snapshot.candidateManifest.conference),
        createdAt: timestamp(now), updatedAt: timestamp(now), members };
    return { ...body, stateSha256: stableHash(body) };
}
function normalizeState(value, snapshot, runId) {
    exact(value, ['contract', 'version', 'binding', 'locator', 'createdAt', 'updatedAt', 'members', 'stateSha256'], 'run state');
    if (value.contract !== RUN_CONTRACT || value.version !== VERSION) fail('run state contract/version mismatch');
    if (stableHash(value.binding) !== stableHash(runBinding(snapshot, runId))) fail('run state discovery binding drifted');
    validateLocatorBinding(value.locator, snapshot.candidateManifest.conference, 'run locator');
    if (!Array.isArray(value.members) || value.members.length !== snapshot.candidateManifest.members.length) fail('run member set drifted');
    const body = clone(value); delete body.stateSha256;
    if (assertSha(value.stateSha256, 'stateSha256') !== stableHash(body)) fail('run state self-SHA drifted');
    const expectedMembers = initialState(snapshot, runId, value.createdAt).members;
    for (const [index, member] of value.members.entries()) {
        exact(member, ['paperId', 'sourceIdentity', 'status', 'itemName', 'receiptFileSha256', 'receiptSha256', 'evidenceSha256'], 'run member');
        if (!['pending', ...EVIDENCE_STATUSES].includes(member.status) || !/^[a-f0-9]{64}$/.test(member.itemName)) fail('run member status/name invalid');
        const expected = expectedMembers[index];
        if (!expected || member.paperId !== expected.paperId || member.sourceIdentity !== expected.sourceIdentity
            || member.itemName !== expected.itemName) fail('run member identity/order drifted');
        if (member.status === 'pending') {
            if (member.receiptFileSha256 !== null || member.receiptSha256 !== null || member.evidenceSha256 !== null) fail('pending member has evidence');
        } else {
            assertSha(member.receiptFileSha256, 'member receipt file SHA'); assertSha(member.receiptSha256, 'member receipt SHA');
            if (member.status === 'ready') assertSha(member.evidenceSha256, 'member evidence SHA');
            else if (member.evidenceSha256 !== null) fail('unavailable member has an evidence SHA');
        }
    }
    return clone(value);
}
function updateState(state, now) {
    const body = clone(state); delete body.stateSha256; body.updatedAt = timestamp(now);
    return { ...body, stateSha256: stableHash(body) };
}

function projectionFor(replay, snapshot) {
    return { contract: PROJECTION_CONTRACT, version: VERSION, conference: clone(replay.conference), identity: clone(replay.identity),
        metadataRecord: clone(replay.metadataRecord), discovery: { catalogSha256: snapshot.catalogSha256,
            reportSha256: snapshot.reportSha256, metadataSnapshotSha256: replay.metadataSnapshotSha256,
            metadataIndex: replay.metadataIndex, metadataRecordSha256: replay.metadataRecordSha256 } };
}
function extractionRequestFor({ paperId, replay, snapshot, projectionSha256, pdfSha256, copiedAt }) {
    const locator = replay.metadataRecord.pdfUrl || replay.metadataRecord.recordUrl;
    return { contract: extractionApi.REQUEST_CONTRACT, version: extractionApi.VERSION, paperId,
        sourceIdentity: replay.sourceIdentity, source: {
            metadata: { file: 'metadata.json', sha256: projectionSha256, identityEvidence: {
                conferenceIdPointer: '/conference/id', conferenceYearPointer: '/conference/year',
                identityTypePointer: '/identity/type', identityValuePointer: '/identity/value' },
            discoveryBinding: { catalogSha256: snapshot.catalogSha256, metadataSnapshotSha256: replay.metadataSnapshotSha256,
                metadataIndex: replay.metadataIndex, metadataRecordSha256: replay.metadataRecordSha256 },
            provenance: { kind: 'local-confirmed-copy', locator: `conference-discovery:${snapshot.catalogSha256}:${replay.metadataIndex}`, retrievedAt: copiedAt } },
            pdf: { file: 'paper.pdf', sha256: pdfSha256,
                provenance: { kind: 'local-confirmed-copy', locator, retrievedAt: copiedAt } } },
        outputs: { textFile: 'text.txt', artifactsFile: 'artifacts.json', receiptFile: 'extraction-receipt.json' },
        options: clone(extractionApi.OPTIONS) };
}
function copyPdf(source, target, expectedSha) {
    const before = fs.lstatSync(source);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) fail('source PDF is unsafe');
    const flags = fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0);
    fs.copyFileSync(source, target, flags); fs.chmodSync(target, 0o600);
    const copied = readRegular(target, 256 * 1024 * 1024, 'staged PDF');
    const after = fs.lstatSync(source);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || copied.sha256 !== expectedSha) {
        fail('source PDF drifted or staged PDF SHA differs from discovery');
    }
    return copied;
}
function normalizeBlockedVerification(value) {
    exact(value, ['contract', 'version', 'status', 'paperId', 'sourceIdentity', 'blockedReason',
        'requestSha256', 'metadataSha256', 'pdfSha256', 'textSha256', 'artifactsSha256',
        'receiptFileSha256', 'receiptSha256', 'verificationSha256'], 'blocked extraction verification');
    if (value.contract !== BLOCKED_VERIFICATION_CONTRACT || value.version !== 1
        || value.status !== 'verified-blocked') fail('blocked extraction verification contract/status is invalid');
    exact(value.blockedReason, ['code', 'message'], 'blocked extraction reason');
    if (!['TEXT_TOO_SHORT', 'PDF_EXTRACTION_FAILED'].includes(value.blockedReason.code)) {
        fail('blocked extraction reason is unsupported');
    }
    text(value.blockedReason.message, 'blocked extraction reason message', { maximum: 2000 });
    for (const field of ['requestSha256', 'metadataSha256', 'pdfSha256', 'receiptFileSha256',
        'receiptSha256', 'verificationSha256']) assertSha(value[field], `blocked verification ${field}`);
    for (const field of ['textSha256', 'artifactsSha256']) {
        if (value[field] !== null) assertSha(value[field], `blocked verification ${field}`);
    }
    if ((value.textSha256 === null) !== (value.artifactsSha256 === null)) fail('blocked derived outputs must be paired');
    const body = clone(value); delete body.verificationSha256;
    if (value.verificationSha256 !== stableHash(body)) fail('blocked extraction verification self-SHA drifted');
    return clone(value);
}
function runExtractorHelper(itemRoot, mode) {
    const runtime = path.resolve(__dirname, '..', 'python-runtime.sh');
    const script = path.resolve(__dirname, '..', 'conference-filter-evidence-extract.py');
    const child = spawnSync('bash', [runtime, script, `--${mode}`, '--manifest', 'request.json', '--source-root', itemRoot], {
        cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 5 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (child.status !== 0) fail(`pinned extractor failed: ${String(child.stderr || child.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
    try { return JSON.parse(String(child.stdout).trim()); }
    catch { fail('pinned extractor did not return one JSON result'); }
}
function blockedSnapshot(itemRoot, verificationValue) {
    const verification = normalizeBlockedVerification(verificationValue);
    return { status: 'blocked', paperId: verification.paperId, sourceIdentity: verification.sourceIdentity,
        pdf: { sha256: verification.pdfSha256 }, text: null, artifacts: null,
        receipt: { file: 'extraction-receipt.json', fileSha256: verification.receiptFileSha256,
            receiptSha256: verification.receiptSha256 }, verification,
        blockedReason: clone(verification.blockedReason) };
}
function defaultExtract(itemRoot) {
    const result = runExtractorHelper(itemRoot, 'apply');
    if (result.status === 'verified-blocked') return blockedSnapshot(itemRoot, result);
    const handle = extractionApi.loadExtractionHandle(itemRoot, 'extraction-receipt.json');
    return { status: 'ready', ...extractionApi.extractionHandleSnapshot(handle) };
}
function loadExistingExtraction(itemRoot) {
    try {
        const handle = extractionApi.loadExtractionHandle(itemRoot, 'extraction-receipt.json');
        return { status: 'ready', ...extractionApi.extractionHandleSnapshot(handle) };
    } catch (readyError) {
        try { return blockedSnapshot(itemRoot, runExtractorHelper(itemRoot, 'verify')); }
        catch (blockedError) { fail(`existing extraction bundle is neither authenticated ready nor blocked: ${blockedError.message}`); }
    }
}
function evidenceReceipt({ state, replay, snapshot, extraction, evidence }) {
    const body = { contract: RECEIPT_CONTRACT, version: VERSION, runId: state.binding.runId,
        paperId: extraction.paperId, sourceIdentity: extraction.sourceIdentity,
        discovery: { catalogSha256: snapshot.catalogSha256, reportSha256: snapshot.reportSha256,
            metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
            metadataRecordSha256: replay.metadataRecordSha256, pdfSha256: extraction.pdf.sha256 },
        extraction: { receiptFile: extraction.receipt.file, receiptFileSha256: extraction.receipt.fileSha256,
            receiptSha256: extraction.receipt.receiptSha256, verificationSha256: extraction.verification.verificationSha256,
            textFile: extraction.text?.file || null, textSha256: extraction.text?.sha256 || null,
            artifactsFile: extraction.artifacts?.file || null, artifactsSha256: extraction.artifacts?.sha256 || null },
        locator: clone(state.locator), evidence };
    return { ...body, receiptSha256: stableHash(body) };
}
function validateEvidenceReceipt(value, expected) {
    exact(value, ['contract', 'version', 'runId', 'paperId', 'sourceIdentity', 'discovery', 'extraction', 'locator', 'evidence', 'receiptSha256'], 'evidence receipt');
    if (value.contract !== RECEIPT_CONTRACT || value.version !== VERSION || value.runId !== expected.runId
        || value.paperId !== expected.paperId || value.sourceIdentity !== expected.sourceIdentity) fail('evidence receipt identity mismatch');
    exact(value.discovery, ['catalogSha256', 'reportSha256', 'metadataSnapshotSha256', 'metadataIndex', 'metadataRecordSha256', 'pdfSha256'], 'receipt discovery');
    exact(value.extraction, ['receiptFile', 'receiptFileSha256', 'receiptSha256', 'verificationSha256',
        'textFile', 'textSha256', 'artifactsFile', 'artifactsSha256'], 'receipt extraction');
    if (!expected.locator) fail('receipt validation requires the run locator binding');
    exact(value.locator, Object.keys(expected.locator), 'receipt locator');
    exact(value.evidence, ['status', 'reason', 'text', 'page', 'textStart', 'textEnd', 'sha256'], 'receipt evidence');
    for (const field of ['catalogSha256', 'reportSha256', 'metadataSnapshotSha256', 'metadataRecordSha256', 'pdfSha256']) {
        assertSha(value.discovery[field], `receipt discovery.${field}`);
    }
    if (!Number.isSafeInteger(value.discovery.metadataIndex) || value.discovery.metadataIndex < 0) fail('receipt metadata index invalid');
    for (const field of ['receiptFileSha256', 'receiptSha256', 'verificationSha256']) {
        assertSha(value.extraction[field], `receipt extraction.${field}`);
    }
    if (value.extraction.receiptFile !== 'extraction-receipt.json') {
        fail('receipt extraction filenames drifted from the pinned projection');
    }
    if (stableHash(value.locator) !== stableHash(expected.locator)) fail('receipt locator drifted');
    if (!EVIDENCE_STATUSES.has(value.evidence?.status)) fail('evidence receipt status invalid');
    text(value.evidence.reason, 'evidence reason');
    if (value.evidence.status === 'extraction-blocked') {
        if (value.extraction.textFile !== null || value.extraction.textSha256 !== null
            || value.extraction.artifactsFile !== null || value.extraction.artifactsSha256 !== null) {
            fail('blocked extraction receipt cannot expose staging-ready derived artifacts');
        }
    } else {
        if (value.extraction.textFile !== 'text.txt' || value.extraction.artifactsFile !== 'artifacts.json') {
            fail('ready extraction filenames drifted from the pinned projection');
        }
        assertSha(value.extraction.textSha256, 'receipt extraction.textSha256');
        assertSha(value.extraction.artifactsSha256, 'receipt extraction.artifactsSha256');
    }
    if (value.evidence.status === 'ready') {
        // pypdf can preserve embedded C0 glyph codes. They remain exact hashed
        // source bytes and JSON escapes them; only trusted extractor evidence,
        // never reasons/identities, may carry them.
        text(value.evidence.text, 'evidence text', { maximum: ABSTRACT_MAX_CHARS, allowExtractorControls: true });
        assertSha(value.evidence.sha256, 'evidence SHA');
        if (![value.evidence.page, value.evidence.textStart, value.evidence.textEnd].every(Number.isSafeInteger)
            || value.evidence.page < 1 || value.evidence.textStart < 0 || value.evidence.textEnd <= value.evidence.textStart) fail('evidence offsets invalid');
    } else if (value.evidence.text !== null || value.evidence.page !== null || value.evidence.textStart !== null
        || value.evidence.textEnd !== null || value.evidence.sha256 !== null) fail('unavailable evidence contains a slice');
    const body = clone(value); delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'evidence receipt SHA') !== stableHash(body)) fail('evidence receipt self-SHA drifted');
    return clone(value);
}
function itemRootFor(runRoot, itemName, create = false) {
    const items = path.join(runRoot, 'items');
    if (create && !fs.existsSync(items)) fs.mkdirSync(items, { mode: 0o700 });
    const root = path.join(items, itemName);
    if (create && !fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    return safeDirectory(root);
}
function validateStagedInputs({ itemRoot, member, snapshot, replay }) {
    const candidate = replay.match.candidates[0];
    const requestLoaded = readJson(direct(itemRoot, 'request.json'), 'staged extraction request');
    const projectionLoaded = readJson(direct(itemRoot, 'metadata.json'), 'staged metadata projection');
    const pdfLoaded = readRegular(direct(itemRoot, 'paper.pdf'), 256 * 1024 * 1024, 'staged PDF');
    const request = requestLoaded.value;
    if (request?.paperId !== member.paperId || request?.sourceIdentity !== member.sourceIdentity
        || request?.source?.metadata?.file !== 'metadata.json' || request?.source?.pdf?.file !== 'paper.pdf'
        || request?.outputs?.textFile !== 'text.txt' || request?.outputs?.artifactsFile !== 'artifacts.json'
        || request?.outputs?.receiptFile !== 'extraction-receipt.json'
        || projectionLoaded.sha256 !== request?.source?.metadata?.sha256
        || pdfLoaded.sha256 !== request?.source?.pdf?.sha256
        || stableHash(request?.source?.metadata?.discoveryBinding) !== stableHash({
            catalogSha256: snapshot.catalogSha256, metadataSnapshotSha256: replay.metadataSnapshotSha256,
            metadataIndex: replay.metadataIndex, metadataRecordSha256: replay.metadataRecordSha256 })
        || stableHash(request?.options) !== stableHash(extractionApi.OPTIONS)
        || stableHash(projectionLoaded.value) !== stableHash(projectionFor(replay, snapshot))
        || pdfLoaded.sha256 !== candidate.sha256) {
        fail('staged extraction request/projection does not bind the discovery member');
    }
    return { requestLoaded, projectionLoaded, pdfLoaded };
}
function processMember({ runRoot, state, member, snapshot, discoveryHandle, extract = defaultExtract, now }) {
    const replay = discoveryApi.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
    if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) fail(`member PDF is not one exact discovery match: ${member.paperId}`);
    const itemRoot = itemRootFor(runRoot, member.itemName, true);
    if (fs.readdirSync(itemRoot).length) {
        const receiptFile = direct(itemRoot, 'evidence-receipt.json');
        if (fs.existsSync(receiptFile)) {
            const loaded = readJson(receiptFile, 'recoverable evidence receipt');
            const receipt = validateEvidenceReceipt(loaded.value, { runId: state.binding.runId,
                paperId: member.paperId, sourceIdentity: member.sourceIdentity, locator: state.locator });
            const recovered = { ...member, status: receipt.evidence.status, receiptFileSha256: loaded.sha256,
                receiptSha256: receipt.receiptSha256, evidenceSha256: receipt.evidence.sha256 };
            verifyCompletedMember({ runRoot, state, member: recovered, snapshot, discoveryHandle });
            return { status: recovered.status, receiptFileSha256: recovered.receiptFileSha256,
                receiptSha256: recovered.receiptSha256, evidenceSha256: recovered.evidenceSha256 };
        }
        const names = fs.readdirSync(itemRoot).sort();
        const prefix = ['metadata.json', 'paper.pdf', 'request.json'];
        const blocked = ['extraction-receipt.json', ...prefix].sort();
        const ready = ['artifacts.json', 'extraction-receipt.json', ...prefix, 'text.txt'].sort();
        if (stableHash(names) === stableHash(prefix)) {
            const staged = validateStagedInputs({ itemRoot, member, snapshot, replay });
            const extraction = extract(itemRoot, { request: staged.requestLoaded.value, replay, snapshot });
            return finishMember({ itemRoot, state, member, snapshot, replay, extraction });
        }
        if (stableHash(names) !== stableHash(blocked) && stableHash(names) !== stableHash(ready)) {
            fail(`partial item requires operator review: ${member.paperId}`);
        }
        const extraction = loadExistingExtraction(itemRoot);
        return finishMember({ itemRoot, state, member, snapshot, replay, extraction });
    }
    const projection = projectionFor(replay, snapshot); const projectionBytes = jsonBytes(projection);
    writeExclusive(direct(itemRoot, 'metadata.json'), projectionBytes);
    const candidate = replay.match.candidates[0];
    const pdfRoot = path.resolve(snapshot.candidateManifest.pdfRoot);
    const sourcePdf = path.resolve(pdfRoot, ...candidate.path.split('/'));
    if (!sourcePdf.startsWith(`${pdfRoot}${path.sep}`)) fail('discovery PDF path escaped its root');
    const copied = copyPdf(sourcePdf, direct(itemRoot, 'paper.pdf'), candidate.sha256);
    const copiedAt = timestamp(now);
    const request = extractionRequestFor({ paperId: member.paperId, replay, snapshot,
        projectionSha256: sha256(projectionBytes), pdfSha256: copied.sha256, copiedAt });
    writeExclusive(direct(itemRoot, 'request.json'), jsonBytes(request));
    const extraction = extract(itemRoot, { request, replay, snapshot });
    return finishMember({ itemRoot, state, member, snapshot, replay, extraction });
}
function finishMember({ itemRoot, state, member, snapshot, replay, extraction }) {
    const candidate = replay.match.candidates[0];
    const { requestLoaded, projectionLoaded, pdfLoaded } = validateStagedInputs({
        itemRoot, member, snapshot, replay });
    if (extraction.paperId !== member.paperId || extraction.sourceIdentity !== member.sourceIdentity
        || extraction.pdf.sha256 !== candidate.sha256 || pdfLoaded.sha256 !== candidate.sha256) {
        fail('extraction snapshot does not bind staged discovery member');
    }
    if (extraction.status === 'blocked'
        && (extraction.verification.requestSha256 !== requestLoaded.sha256
            || extraction.verification.metadataSha256 !== projectionLoaded.sha256)) {
        fail('blocked extraction verification does not bind staged request/metadata');
    }
    let evidence;
    if (extraction.status === 'blocked') {
        evidence = unavailable('extraction-blocked', `pinned extractor blocked: ${extraction.blockedReason.code}`);
    } else {
        const textLoaded = readRegular(direct(itemRoot, extraction.text.file), 64 * 1024 * 1024, 'extracted text');
        const artifactLoaded = readJson(direct(itemRoot, extraction.artifacts.file), 'extraction artifact');
        if (textLoaded.sha256 !== extraction.text.sha256 || artifactLoaded.sha256 !== extraction.artifacts.sha256) {
            fail('extracted bytes drifted from extraction snapshot');
        }
        evidence = locateAbstract(textLoaded.bytes, artifactLoaded.value,
            state.locator.profile || DEFAULT_LOCATOR_PROFILE);
    }
    const receipt = evidenceReceipt({ state, replay, snapshot, extraction, evidence });
    validateEvidenceReceipt(receipt, { runId: state.binding.runId,
        paperId: member.paperId, sourceIdentity: member.sourceIdentity, locator: state.locator });
    const receiptBytes = jsonBytes(receipt);
    writeExclusive(direct(itemRoot, 'evidence-receipt.json'), receiptBytes);
    return { status: evidence.status, receiptFileSha256: sha256(receiptBytes),
        receiptSha256: receipt.receiptSha256, evidenceSha256: evidence.sha256 };
}
function verifyCompletedMember({ runRoot, state, member, snapshot, discoveryHandle, replay: suppliedReplay = null,
    deep = false, extractLoader }) {
    const itemRoot = itemRootFor(runRoot, member.itemName); const loaded = readJson(direct(itemRoot, 'evidence-receipt.json'), 'evidence receipt');
    const receipt = validateEvidenceReceipt(loaded.value, { runId: state.binding.runId,
        paperId: member.paperId, sourceIdentity: member.sourceIdentity, locator: state.locator });
    if (loaded.sha256 !== member.receiptFileSha256 || receipt.receiptSha256 !== member.receiptSha256
        || receipt.evidence.sha256 !== member.evidenceSha256 || receipt.evidence.status !== member.status) fail('checkpoint differs from evidence receipt');
    const extractionReceiptLoaded = readRegular(direct(itemRoot, receipt.extraction.receiptFile), 64 * 1024 * 1024, 'checkpoint extraction receipt');
    const replay = suppliedReplay || discoveryApi.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
    if (replay.sourceIdentity !== member.sourceIdentity) fail('supplied discovery replay belongs to another evidence member');
    const requestLoaded = readJson(direct(itemRoot, 'request.json'), 'checkpoint extraction request');
    const projectionLoaded = readJson(direct(itemRoot, 'metadata.json'), 'checkpoint metadata projection');
    const pdfLoaded = readRegular(direct(itemRoot, 'paper.pdf'), 256 * 1024 * 1024, 'checkpoint PDF');
    if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) fail('checkpoint lost its exact PDF match');
    if (extractionReceiptLoaded.sha256 !== receipt.extraction.receiptFileSha256
        || projectionLoaded.sha256 !== requestLoaded.value?.source?.metadata?.sha256
        || pdfLoaded.sha256 !== requestLoaded.value?.source?.pdf?.sha256
        || pdfLoaded.sha256 !== receipt.discovery.pdfSha256
        || pdfLoaded.sha256 !== replay.match.candidates[0].sha256
        || stableHash(projectionLoaded.value) !== stableHash(projectionFor(replay, snapshot))
        || replay.metadataSnapshotSha256 !== receipt.discovery.metadataSnapshotSha256
        || replay.metadataIndex !== receipt.discovery.metadataIndex
        || replay.metadataRecordSha256 !== receipt.discovery.metadataRecordSha256
        || snapshot.catalogSha256 !== receipt.discovery.catalogSha256
        || snapshot.reportSha256 !== receipt.discovery.reportSha256) fail('checkpoint source/discovery binding drifted');
    if (receipt.evidence.status === 'extraction-blocked') {
        const blocked = blockedSnapshot(itemRoot, runExtractorHelper(itemRoot, 'verify'));
        if (blocked.paperId !== member.paperId || blocked.sourceIdentity !== member.sourceIdentity
            || blocked.pdf.sha256 !== pdfLoaded.sha256
            || blocked.receipt.fileSha256 !== receipt.extraction.receiptFileSha256
            || blocked.receipt.receiptSha256 !== receipt.extraction.receiptSha256
            || blocked.verification.verificationSha256 !== receipt.extraction.verificationSha256
            || stableHash(unavailable('extraction-blocked', `pinned extractor blocked: ${blocked.blockedReason.code}`))
                !== stableHash(receipt.evidence)) fail('blocked extraction checkpoint does not replay');
        return receipt;
    }
    const textLoaded = readRegular(direct(itemRoot, receipt.extraction.textFile), 64 * 1024 * 1024, 'checkpoint text');
    const artifactLoaded = readJson(direct(itemRoot, receipt.extraction.artifactsFile), 'checkpoint artifact');
    if (textLoaded.sha256 !== receipt.extraction.textSha256 || artifactLoaded.sha256 !== receipt.extraction.artifactsSha256) {
        fail('checkpoint extraction bytes were tampered');
    }
    if (stableHash(locateAbstract(textLoaded.bytes, artifactLoaded.value,
        state.locator.profile || DEFAULT_LOCATOR_PROFILE)) !== stableHash(receipt.evidence)) {
        fail('checkpoint abstract locator result does not replay');
    }
    if (receipt.evidence.status === 'ready') {
        const exactBytes = textLoaded.bytes.subarray(receipt.evidence.textStart, receipt.evidence.textEnd);
        if (sha256(exactBytes) !== receipt.evidence.sha256 || exactBytes.toString('utf8') !== receipt.evidence.text) fail('checkpoint abstract slice does not replay');
    }
    if (deep) (extractLoader || (root => extractionApi.extractionHandleSnapshot(extractionApi.loadExtractionHandle(root, 'extraction-receipt.json'))))(itemRoot);
    return receipt;
}
function summary(state) {
    const counts = { total: state.members.length, pending: 0, ready: 0, missing: 0, ambiguous: 0, 'too-short': 0, 'extraction-blocked': 0 };
    for (const member of state.members) counts[member.status] += 1;
    return { runId: state.binding.runId, conference: clone(state.binding.conference), counts, stateSha256: state.stateSha256 };
}
function finalizedFor(state) {
    if (state.members.some(member => member.status === 'pending')) return null;
    const members = state.members.map(member => ({ paperId: member.paperId, sourceIdentity: member.sourceIdentity,
        status: member.status, receiptPath: `items/${member.itemName}/evidence-receipt.json`,
        receiptFileSha256: member.receiptFileSha256, receiptSha256: member.receiptSha256,
        evidenceSha256: member.evidenceSha256 }));
    const body = { contract: CATALOG_CONTRACT, version: VERSION, binding: clone(state.binding),
        locator: clone(state.locator), stateSha256: state.stateSha256, members,
        memberSetSha256: stableHash(members.map(member => member.paperId)) };
    const catalog = { ...body, catalogSha256: stableHash(body) };
    const counts = summary(state).counts;
    const reportBody = { contract: REPORT_CONTRACT, version: VERSION, runId: state.binding.runId,
        conference: clone(state.binding.conference), catalogSha256: catalog.catalogSha256, counts };
    const report = { ...reportBody, reportSha256: stableHash(reportBody) };
    return { catalog, report };
}
function finalize(runRoot, state, { write = true } = {}) {
    const finalized = finalizedFor(state);
    if (!finalized) return null;
    const { catalog, report } = finalized;
    for (const [name, value] of [['evidence-catalog.json', catalog], ['evidence-report.json', report]]) {
        const filename = direct(runRoot, name); const bytes = jsonBytes(value);
        if (fs.existsSync(filename)) {
            if (readRegular(filename, 64 * 1024 * 1024, name).sha256 !== sha256(bytes)) fail(`${name} drifted after completion`);
        } else if (write) writeExclusive(filename, bytes);
        else fail(`${name} is missing from the completed run`);
    }
    return { catalog, report };
}
function prepareEvidence({ evidenceRunsRoot, runId, discoveryHandle, apply = false, limit = 1,
    all = false, expectedTotal = null, now, extract } = {}) {
    if (all) {
        if (!apply) fail('all mode requires apply');
        if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 1) fail('all mode requires a positive expectedTotal');
    } else {
        if (expectedTotal !== null) fail('expectedTotal is only valid in all mode');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('limit must be an integer from 1 to 500');
    }
    const snapshot = discoverySnapshot(discoveryHandle); let state;
    if (all && expectedTotal !== snapshot.candidateManifest.members.length) {
        fail(`expectedTotal ${expectedTotal} does not equal authenticated discovery total ${snapshot.candidateManifest.members.length}`);
    }
    if (!apply) {
        state = initialState(snapshot, runId, now); return { status: 'dry-run', ...summary(state), processed: 0 };
    }
    const root = safeDirectory(evidenceRunsRoot, { create: true });
    const runRoot = path.join(root, runId);
    if (!fs.existsSync(runRoot)) fs.mkdirSync(runRoot, { mode: 0o700 });
    safeDirectory(runRoot); const stateFile = direct(runRoot, 'state.json');
    if (fs.existsSync(stateFile)) state = normalizeState(readJson(stateFile, 'run state').value, snapshot, runId);
    else { state = initialState(snapshot, runId, now); writeExclusive(stateFile, jsonBytes(state)); }
    for (const member of state.members.filter(item => item.status !== 'pending')) {
        verifyCompletedMember({ runRoot, state, member, snapshot, discoveryHandle });
    }
    let processed = 0;
    const processLimit = all ? expectedTotal : limit;
    while (processed < processLimit) {
        const member = state.members.find(item => item.status === 'pending');
        if (!member) break;
        const result = processMember({ runRoot, state, member, snapshot, discoveryHandle, extract, now });
        Object.assign(member, result); state = updateState(state, now); atomicState(stateFile, state); processed += 1;
    }
    const completed = finalize(runRoot, state);
    return { status: completed ? 'complete' : 'pending', ...summary(state), processed };
}
function inspectEvidence({ evidenceRunsRoot, runId, discoveryHandle, deep = false, limit = null, extractLoader } = {}) {
    const snapshot = discoverySnapshot(discoveryHandle); const root = safeDirectory(evidenceRunsRoot);
    const runRoot = safeDirectory(path.join(root, runId));
    const state = normalizeState(readJson(direct(runRoot, 'state.json'), 'run state').value, snapshot, runId);
    const discoveryReplays = new Map(discoveryApi.replayDiscoveryMembers(discoveryHandle)
        .map(replay => [replay.sourceIdentity, replay]));
    let verified = 0;
    for (const member of state.members.filter(item => item.status !== 'pending')) {
        if (limit !== null && verified >= limit) break;
        const replay = discoveryReplays.get(member.sourceIdentity);
        if (!replay) fail(`completed evidence member is absent from authenticated discovery: ${member.paperId}`);
        verifyCompletedMember({ runRoot, state, member, snapshot, discoveryHandle, replay, deep, extractLoader }); verified += 1;
    }
    if (!state.members.some(member => member.status === 'pending')) finalize(runRoot, state, { write: false });
    return { status: state.members.some(member => member.status === 'pending') ? 'pending' : 'complete',
        ...summary(state), verified };
}

function loadEvidenceHandle({ evidenceRunsRoot, runId, discoveryHandle, deep = false, extractLoader } = {}) {
    const inspected = inspectEvidence({ evidenceRunsRoot, runId, discoveryHandle, deep, extractLoader });
    if (inspected.status !== 'complete') fail('only a complete evidence run can be authenticated');
    const snapshot = discoverySnapshot(discoveryHandle);
    const root = safeDirectory(evidenceRunsRoot); const runRoot = safeDirectory(path.join(root, runId));
    const state = normalizeState(readJson(direct(runRoot, 'state.json'), 'run state').value, snapshot, runId);
    const finalized = finalize(runRoot, state, { write: false });
    const handle = Object.freeze(Object.create(null));
    EVIDENCE_HANDLES.add(handle);
    EVIDENCE_HANDLE_DATA.set(handle, { root, runRoot, runId, discoveryHandle, discoverySnapshot: snapshot,
        stateSha256: state.stateSha256, catalogSha256: finalized.catalog.catalogSha256,
        reportSha256: finalized.report.reportSha256 });
    return handle;
}
function evidenceHandleSnapshot(handle, paperId = null) {
    if (!EVIDENCE_HANDLES.has(handle)) fail('authenticated evidence handle required');
    const data = EVIDENCE_HANDLE_DATA.get(handle);
    const currentDiscovery = discoverySnapshot(data.discoveryHandle);
    if (stableHash(currentDiscovery) !== stableHash(data.discoverySnapshot)) fail('authenticated discovery changed after evidence handle creation');
    const state = normalizeState(readJson(direct(data.runRoot, 'state.json'), 'run state').value,
        currentDiscovery, data.runId);
    if (state.stateSha256 !== data.stateSha256) fail('evidence state changed after handle creation');
    const finalized = finalize(data.runRoot, state, { write: false });
    if (finalized.catalog.catalogSha256 !== data.catalogSha256
        || finalized.report.reportSha256 !== data.reportSha256) fail('final evidence artifacts changed after handle creation');
    if (paperId === null) return clone(finalized);
    const member = state.members.find(item => item.paperId === paperId);
    if (!member) fail(`paper is not an evidence member: ${paperId}`);
    const receipt = verifyCompletedMember({ runRoot: data.runRoot, state, member, snapshot: currentDiscovery,
        discoveryHandle: data.discoveryHandle });
    return clone({ catalogSha256: finalized.catalog.catalogSha256,
        reportSha256: finalized.report.reportSha256, member, receipt });
}

// Authenticate the complete evidence run once for a bulk filter pass.  Each
// receipt and its sealed source bytes are still replayed; only repeated
// state/catalog/metadata parsing is removed.
function evidenceHandleMemberSnapshots(handle) {
    if (!EVIDENCE_HANDLES.has(handle)) fail('authenticated evidence handle required');
    const data = EVIDENCE_HANDLE_DATA.get(handle);
    const currentDiscovery = discoverySnapshot(data.discoveryHandle);
    if (stableHash(currentDiscovery) !== stableHash(data.discoverySnapshot)) fail('authenticated discovery changed after evidence handle creation');
    const state = normalizeState(readJson(direct(data.runRoot, 'state.json'), 'run state').value,
        currentDiscovery, data.runId);
    if (state.stateSha256 !== data.stateSha256) fail('evidence state changed after handle creation');
    const finalized = finalize(data.runRoot, state, { write: false });
    if (finalized.catalog.catalogSha256 !== data.catalogSha256
        || finalized.report.reportSha256 !== data.reportSha256) fail('final evidence artifacts changed after handle creation');
    const discoveryReplays = new Map(discoveryApi.replayDiscoveryMembers(data.discoveryHandle)
        .map(replay => [replay.sourceIdentity, replay]));
    return state.members.map(member => {
        const replay = discoveryReplays.get(member.sourceIdentity);
        if (!replay) fail(`evidence member is absent from authenticated discovery: ${member.paperId}`);
        const receipt = verifyCompletedMember({ runRoot: data.runRoot, state, member,
            snapshot: currentDiscovery, discoveryHandle: data.discoveryHandle, replay });
        return clone({ catalogSha256: finalized.catalog.catalogSha256,
            reportSha256: finalized.report.reportSha256, member, receipt });
    });
}

module.exports = { VERSION, RUN_CONTRACT, PROJECTION_CONTRACT, RECEIPT_CONTRACT, CATALOG_CONTRACT,
    REPORT_CONTRACT, LOCATOR_CONTRACT, DEFAULT_LOCATOR_PROFILE, AAAI_LOCATOR_PROFILE, LOCATOR_RULES,
    AAAI_LOCATOR_RULES, LOCATOR_PROFILES, LOCATOR_IMPLEMENTATION_SHA256, ABSTRACT_MIN_CHARS,
    ABSTRACT_MAX_CHARS, UUID_RE, stableHash, locateAbstract, initialState, normalizeState, projectionFor,
    locatorProfileForConference, locatorBindingForConference,
    extractionRequestFor, prepareEvidence, inspectEvidence, loadEvidenceHandle, evidenceHandleSnapshot,
    evidenceHandleMemberSnapshots,
    summary, validateEvidenceReceipt };
