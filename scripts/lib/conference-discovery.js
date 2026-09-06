'use strict';

// Offline discovery for immutable conference metadata snapshots and local PDF
// catalogs. Discovery only proposes source candidates: even an exact filename
// match is not a verified identity-to-PDF binding and cannot enter execution.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');

const CONTRACT = 'conference-discovery-v2';
const REPORT_CONTRACT = 'conference-discovery-report-v2';
const VERSION = 2;
const ADAPTERS = new Set(['icassp', 'iclr', 'icml']);
const MATCH_KINDS = ['exact', 'normalized', 'ambiguous', 'unmatched'];
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
// A validated discovery pair is an authority boundary for filtering.  Keep
// the admitted bytes and documents in module-private state so callers cannot
// forge a catalog/report pair by attaching a plausible digest to an object.
const DISCOVERY_HANDLES = new WeakSet();
const DISCOVERY_HANDLE_DATA = new WeakMap();

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(message) {
    const error = new Error(`Conference discovery rejected: ${message}`);
    error.code = 'CONFERENCE_DISCOVERY_INTEGRITY';
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

function assertSha(value, name) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) throw fail(`${name} must be a lowercase SHA-256`);
    return value;
}

function safeAbsoluteDirectory(directory, name) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail(`${name} must be an absolute directory`);
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`${name} contains an unsafe directory: ${cursor}`);
    }
    if (fs.realpathSync(absolute) !== absolute) throw fail(`${name} must not resolve through a symbolic link`);
    return absolute;
}

function safeAbsoluteFile(filename, name, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail(`${name} must be an absolute filename`);
    const absolute = path.resolve(filename);
    safeAbsoluteDirectory(path.dirname(absolute), `${name} parent`);
    let descriptor;
    let fd;
    try {
        const before = fs.lstatSync(absolute);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
            throw fail(`${name} must be a regular single-link file within its size limit`);
        }
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            throw fail(`${name} changed or became unsafe while opening`);
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) throw fail(`${name} changed while being read`);
        descriptor = { absolute, bytes };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return descriptor;
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
            if (top.keys.has(key)) throw fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function readMetadataSnapshot(filename) {
    const loaded = safeAbsoluteFile(filename, 'metadata snapshot', MAX_METADATA_BYTES);
    let source;
    let value;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(source, 'metadata snapshot');
        value = JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_DISCOVERY_INTEGRITY') throw error;
        throw fail('metadata snapshot must contain valid strict UTF-8 JSON');
    }
    return {
        value,
        descriptor: { file: loaded.absolute, sha256: sha256(loaded.bytes), size: loaded.bytes.length }
    };
}

function safeRelativePath(root, filename) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    try { return ledgerApi.assertRelativePath(relative, 'PDF catalog path'); }
    catch (error) { throw fail(error.message); }
}

function readPdf(filename, relative) {
    const loaded = safeAbsoluteFile(filename, `PDF ${relative}`, MAX_PDF_BYTES);
    if (loaded.bytes.length < 5 || loaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw fail(`PDF ${relative} does not have a standard PDF header`);
    }
    return { path: relative, sha256: sha256(loaded.bytes), size: loaded.bytes.length };
}

function catalogPdfs(pdfRoot) {
    const root = safeAbsoluteDirectory(pdfRoot, 'pdfRoot');
    const catalog = [];
    function visit(directory) {
        const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
        for (const entry of entries) {
            const filename = path.join(directory, entry.name);
            const stat = fs.lstatSync(filename);
            if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw fail(`pdfRoot contains symbolic link: ${filename}`);
            if (entry.isDirectory()) {
                if (fs.realpathSync(filename) !== filename) throw fail(`pdfRoot contains unsafe directory: ${filename}`);
                visit(filename);
                continue;
            }
            if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1) {
                throw fail(`pdfRoot contains non-regular or hard-linked entry: ${filename}`);
            }
            const relative = safeRelativePath(root, filename);
            if (path.posix.extname(relative).toLowerCase() === '.pdf') catalog.push(readPdf(filename, relative));
        }
    }
    visit(root);
    catalog.sort((a, b) => compare(a.path, b.path));
    return { root, catalog, catalogSha256: ledgerApi.stableHash(catalog) };
}

function text(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail(`${name} must be a non-empty trimmed string without controls`);
    }
    return value;
}

function positiveIntegerString(value, name) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 1) throw fail(`${name} must be a positive safe integer`);
        value = String(value);
    }
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw fail(`${name} must be a canonical positive integer string`);
    return value;
}

function forumId(value, name) {
    text(value, name);
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) throw fail(`${name} must be a canonical OpenReview forum ID`);
    return value;
}

function extractRecords(adapter, snapshot) {
    if (adapter === 'icassp' || adapter === 'iclr') {
        if (!Array.isArray(snapshot)) throw fail(`${adapter} metadata snapshot must be an array`);
        return snapshot;
    }
    if (!plain(snapshot) || !Array.isArray(snapshot.papers)) throw fail('icml metadata snapshot must be an object with a papers array');
    return snapshot.papers;
}

function optionalNumericAlias(record, index, includeId = false) {
    const fields = ['numeric_alias', 'numericAlias', 'paper_number', 'paperNumber', 'paper_id', 'number'];
    if (includeId) fields.push('id');
    const values = fields.filter(field => record[field] !== undefined && record[field] !== null)
        .map(field => positiveIntegerString(record[field], `metadata[${index}].${field}`));
    if (!values.length) return null;
    if (new Set(values).size !== 1) throw fail(`metadata[${index}] has conflicting numeric aliases`);
    return values[0];
}

function normalizeMetadataMember(adapter, record, index) {
    if (!plain(record)) throw fail(`metadata[${index}] must be a plain object`);
    const title = text(record.title, `metadata[${index}].title`);
    if (adapter === 'icassp') {
        return { identity: { type: 'icassp-arnumber', value: positiveIntegerString(record.arnumber, `metadata[${index}].arnumber`) },
            metadataIndex: index, title, numericAlias: null };
    }
    const explicitForumFields = adapter === 'iclr' ? ['forum_id'] : ['forum_id', 'forumId'];
    let fields = explicitForumFields.filter(field => record[field] !== undefined && record[field] !== null);
    const explicitForum = fields.length > 0;
    if (adapter === 'icml' && !explicitForum) fields = ['id'];
    const candidates = fields
        .map(field => forumId(record[field], `metadata[${index}].${field}`));
    if (!candidates.length) throw fail(`metadata[${index}] is missing its OpenReview forum ID`);
    if (new Set(candidates).size !== 1) throw fail(`metadata[${index}] has conflicting OpenReview forum IDs`);
    if (adapter === 'icml' && explicitForum && record.id !== undefined && record.id !== null
        && !(typeof record.id === 'number' || /^\d+$/.test(String(record.id)))) {
        const redundantId = forumId(record.id, `metadata[${index}].id`);
        if (redundantId !== candidates[0]) throw fail(`metadata[${index}] has conflicting OpenReview forum IDs`);
    }
    return { identity: { type: 'openreview-forum-id', value: candidates[0] }, metadataIndex: index, title,
        numericAlias: adapter === 'icml' ? optionalNumericAlias(record, index, explicitForum
            && (typeof record.id === 'number' || /^\d+$/.test(String(record.id)))) : null };
}

function normalizedTitle(value) {
    return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\p{Z}\s_]+/gu, '');
}

function descriptorMap(catalog) {
    return new Map(catalog.map(item => [item.path, item]));
}

function icasspMatch(member, catalog) {
    const exact = catalog.filter(item => path.posix.basename(item.path, path.posix.extname(item.path)) === member.title);
    if (exact.length === 1) return { kind: 'exact', candidates: exact };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
    const target = normalizedTitle(member.title);
    const normalized = catalog.filter(item => normalizedTitle(path.posix.basename(item.path, path.posix.extname(item.path))) === target);
    if (normalized.length === 1) return { kind: 'normalized', candidates: normalized };
    if (normalized.length > 1) return { kind: 'ambiguous', candidates: normalized };
    return { kind: 'unmatched', candidates: [] };
}

function openReviewMatch(member, catalogByPath) {
    const expected = `${member.identity.value}.pdf`;
    const candidate = catalogByPath.get(expected);
    return candidate ? { kind: 'exact', candidates: [candidate] } : { kind: 'unmatched', candidates: [] };
}

function markSharedIcasspCandidatesAmbiguous(members) {
    const owners = new Map();
    for (const member of members) {
        if (!['exact', 'normalized'].includes(member.match.kind)) continue;
        for (const candidate of member.match.candidates) {
            const set = owners.get(candidate.path) || new Set();
            set.add(`${member.identity.type}:${member.identity.value}`);
            owners.set(candidate.path, set);
        }
    }
    for (const member of members) {
        if (member.match.candidates.some(candidate => owners.get(candidate.path)?.size > 1)) member.match.kind = 'ambiguous';
    }
}

function buildReport(manifest) {
    const counts = Object.fromEntries(MATCH_KINDS.map(kind => [kind, manifest.members.filter(member => member.match.kind === kind).length]));
    const matchedPaths = new Set(manifest.members.flatMap(member => member.match.candidates.map(candidate => candidate.path)));
    const report = {
        contract: REPORT_CONTRACT,
        version: VERSION,
        adapter: manifest.adapter,
        conference: manifest.conference,
        candidateManifestSha256: sha256(canonicalBytes(manifest)),
        metadataSnapshotSha256: manifest.metadataSnapshot.sha256,
        pdfCatalogSha256: manifest.pdfCatalogSha256,
        counts: { metadataRecords: manifest.members.length, pdfFiles: manifest.pdfCatalog.length, ...counts,
            orphanPdfFiles: manifest.pdfCatalog.filter(item => !matchedPaths.has(item.path)).length }
    };
    return report;
}

function validateDescriptor(value, name) {
    exact(value, ['path', 'sha256', 'size'], name);
    let relative;
    try { relative = ledgerApi.assertRelativePath(value.path, `${name}.path`); }
    catch (error) { throw fail(error.message); }
    assertSha(value.sha256, `${name}.sha256`);
    if (!Number.isSafeInteger(value.size) || value.size < 5 || value.size > MAX_PDF_BYTES) {
        throw fail(`${name}.size is invalid`);
    }
    return { path: relative, sha256: value.sha256, size: value.size };
}

function sameDescriptor(left, right) {
    return left.path === right.path && left.sha256 === right.sha256 && left.size === right.size;
}

function validateDiscoveryBundle(candidateManifest, report, { catalogRawBytes, reportRawBytes } = {}) {
    exact(candidateManifest, ['contract', 'version', 'adapter', 'conference', 'metadataSnapshot', 'pdfRoot',
        'pdfCatalogSha256', 'pdfCatalog', 'members', 'memberSetSha256'], 'candidate manifest');
    if (candidateManifest.contract !== CONTRACT || candidateManifest.version !== VERSION || !ADAPTERS.has(candidateManifest.adapter)) {
        throw fail('candidate manifest contract/version/adapter is unsupported');
    }
    exact(candidateManifest.conference, ['id', 'year'], 'candidate manifest conference');
    if (!Number.isInteger(candidateManifest.conference.year) || candidateManifest.conference.year < 1900
        || candidateManifest.conference.year > 2100
        || candidateManifest.conference.id !== `${candidateManifest.adapter}-${candidateManifest.conference.year}`) {
        throw fail('candidate manifest conference identity is inconsistent');
    }
    exact(candidateManifest.metadataSnapshot, ['file', 'sha256', 'size'], 'candidate manifest metadataSnapshot');
    if (typeof candidateManifest.metadataSnapshot.file !== 'string' || !path.isAbsolute(candidateManifest.metadataSnapshot.file)
        || !Number.isSafeInteger(candidateManifest.metadataSnapshot.size) || candidateManifest.metadataSnapshot.size < 1
        || candidateManifest.metadataSnapshot.size > MAX_METADATA_BYTES) {
        throw fail('candidate manifest metadataSnapshot is malformed');
    }
    assertSha(candidateManifest.metadataSnapshot.sha256, 'candidate manifest metadataSnapshot.sha256');
    if (typeof candidateManifest.pdfRoot !== 'string' || !path.isAbsolute(candidateManifest.pdfRoot)) {
        throw fail('candidate manifest pdfRoot must be absolute');
    }
    if (!Array.isArray(candidateManifest.pdfCatalog)) throw fail('candidate manifest pdfCatalog must be an array');
    const pdfCatalog = candidateManifest.pdfCatalog.map((item, index) => validateDescriptor(item, `pdfCatalog[${index}]`));
    const pdfPaths = pdfCatalog.map(item => item.path);
    if (new Set(pdfPaths).size !== pdfPaths.length) throw fail('candidate manifest pdfCatalog contains duplicate paths');
    const sortedPdfPaths = [...pdfPaths].sort(compare);
    if (pdfPaths.some((value, index) => value !== sortedPdfPaths[index])) throw fail('candidate manifest pdfCatalog must be sorted by path');
    if (assertSha(candidateManifest.pdfCatalogSha256, 'candidate manifest pdfCatalogSha256')
        !== ledgerApi.stableHash(pdfCatalog)) throw fail('candidate manifest pdfCatalog SHA drifted');
    const byPath = new Map(pdfCatalog.map(item => [item.path, item]));

    if (!Array.isArray(candidateManifest.members) || !candidateManifest.members.length) {
        throw fail('candidate manifest members must be nonempty');
    }
    const identities = [];
    const metadataIndexes = new Set();
    const singleCandidateOwners = new Map();
    for (const [index, member] of candidateManifest.members.entries()) {
        exact(member, ['identity', 'metadataIndex', 'title', 'numericAlias', 'match'], `member[${index}]`);
        let identity;
        try { identity = ledgerApi.identityKey(member.identity); }
        catch (error) { throw fail(`member[${index}] identity is invalid: ${error.message}`); }
        const expectedIdentityType = candidateManifest.adapter === 'icassp' ? 'icassp-arnumber' : 'openreview-forum-id';
        if (member.identity.type !== expectedIdentityType) {
            throw fail(`member[${index}] identity type is inconsistent with adapter ${candidateManifest.adapter}`);
        }
        identities.push(identity);
        if (!Number.isSafeInteger(member.metadataIndex) || member.metadataIndex < 0 || metadataIndexes.has(member.metadataIndex)) {
            throw fail(`member[${index}] metadataIndex is invalid or duplicated`);
        }
        metadataIndexes.add(member.metadataIndex);
        text(member.title, `member[${index}].title`);
        if (member.numericAlias !== null && (typeof member.numericAlias !== 'string' || !/^[1-9]\d*$/.test(member.numericAlias))) {
            throw fail(`member[${index}].numericAlias is malformed`);
        }
        if (candidateManifest.adapter !== 'icml' && member.numericAlias !== null) {
            throw fail(`member[${index}].numericAlias is only supported by the icml adapter`);
        }
        exact(member.match, ['kind', 'candidates'], `member[${index}].match`);
        if (!MATCH_KINDS.includes(member.match.kind) || !Array.isArray(member.match.candidates)) {
            throw fail(`member[${index}].match is malformed`);
        }
        const required = member.match.kind === 'unmatched' ? 0 : member.match.kind === 'ambiguous' ? null : 1;
        if ((required !== null && member.match.candidates.length !== required)
            || (member.match.kind === 'ambiguous' && member.match.candidates.length < 1)) {
            throw fail(`member[${index}] match cardinality is inconsistent with ${member.match.kind}`);
        }
        const seenCandidates = new Set();
        const candidatePaths = [];
        for (const [candidateIndex, value] of member.match.candidates.entries()) {
            const candidate = validateDescriptor(value, `member[${index}].match.candidates[${candidateIndex}]`);
            const catalogCandidate = byPath.get(candidate.path);
            if (!catalogCandidate || !sameDescriptor(candidate, catalogCandidate)) {
                throw fail(`member[${index}] candidate does not exactly match its PDF catalog descriptor`);
            }
            if (seenCandidates.has(candidate.path)) throw fail(`member[${index}] contains duplicate candidates`);
            seenCandidates.add(candidate.path);
            candidatePaths.push(candidate.path);
            if (['exact', 'normalized'].includes(member.match.kind)) {
                const owners = singleCandidateOwners.get(candidate.path) || [];
                owners.push(identity); singleCandidateOwners.set(candidate.path, owners);
            }
        }
        const sortedCandidatePaths = [...candidatePaths].sort(compare);
        if (candidatePaths.some((value, candidateIndex) => value !== sortedCandidatePaths[candidateIndex])) {
            throw fail(`member[${index}] candidates must be sorted by path`);
        }
    }
    if (new Set(identities).size !== identities.length) throw fail('candidate manifest contains duplicate primary identities');
    const sortedIdentities = [...identities].sort(compare);
    if (identities.some((value, index) => value !== sortedIdentities[index])) {
        throw fail('candidate manifest members must be sorted by canonical identity');
    }
    if ([...singleCandidateOwners.values()].some(owners => owners.length > 1)) {
        throw fail('a single PDF candidate shared by members must be marked ambiguous');
    }
    if (candidateManifest.members.some((_member, index) => !metadataIndexes.has(index))) {
        throw fail('candidate manifest metadata indexes must cover every source record exactly once');
    }
    const replayMembers = candidateManifest.members.map(member => ({ identity: member.identity, title: member.title,
        match: candidateManifest.adapter === 'icassp' ? icasspMatch(member, pdfCatalog) : openReviewMatch(member, byPath) }));
    if (candidateManifest.adapter === 'icassp') markSharedIcasspCandidatesAmbiguous(replayMembers);
    for (const [index, member] of candidateManifest.members.entries()) {
        const replay = replayMembers[index].match;
        if (member.match.kind !== replay.kind || member.match.candidates.length !== replay.candidates.length
            || member.match.candidates.some((candidate, candidateIndex) => !sameDescriptor(candidate, replay.candidates[candidateIndex]))) {
            throw fail(`member[${index}] match cannot be replayed from its adapter and PDF catalog`);
        }
    }
    if (assertSha(candidateManifest.memberSetSha256, 'candidate manifest memberSetSha256')
        !== ledgerApi.memberSetSha256(candidateManifest.members)) throw fail('candidate manifest member set SHA drifted');

    exact(report, ['contract', 'version', 'adapter', 'conference', 'candidateManifestSha256',
        'metadataSnapshotSha256', 'pdfCatalogSha256', 'counts'], 'discovery report');
    if (report.contract !== REPORT_CONTRACT || report.version !== VERSION || report.adapter !== candidateManifest.adapter) {
        throw fail('discovery report contract/version/adapter does not bind the candidate manifest');
    }
    exact(report.conference, ['id', 'year'], 'discovery report conference');
    if (report.conference.id !== candidateManifest.conference.id || report.conference.year !== candidateManifest.conference.year) {
        throw fail('discovery report conference does not bind the candidate manifest');
    }
    const canonicalCatalogBytes = canonicalBytes(candidateManifest);
    const canonicalCatalogSha256 = sha256(canonicalCatalogBytes);
    if (assertSha(report.candidateManifestSha256, 'report candidateManifestSha256') !== canonicalCatalogSha256) {
        throw fail('report candidateManifestSha256 does not bind canonical candidate manifest bytes');
    }
    if (catalogRawBytes !== undefined) {
        const raw = Buffer.isBuffer(catalogRawBytes) ? catalogRawBytes : Buffer.from(catalogRawBytes);
        if (!raw.equals(canonicalCatalogBytes) || sha256(raw) !== report.candidateManifestSha256) {
            throw fail('candidate manifest file is not the exact canonical bytes bound by its report');
        }
    }
    if (report.metadataSnapshotSha256 !== candidateManifest.metadataSnapshot.sha256
        || report.pdfCatalogSha256 !== candidateManifest.pdfCatalogSha256) {
        throw fail('discovery report source SHA bindings drifted');
    }
    assertSha(report.metadataSnapshotSha256, 'report metadataSnapshotSha256');
    assertSha(report.pdfCatalogSha256, 'report pdfCatalogSha256');
    exact(report.counts, ['metadataRecords', 'pdfFiles', ...MATCH_KINDS, 'orphanPdfFiles'], 'discovery report counts');
    const expectedReport = buildReport(candidateManifest);
    if (Object.keys(expectedReport.counts).some(field => report.counts[field] !== expectedReport.counts[field])) {
        throw fail('discovery report counts drifted');
    }
    const canonicalReportBytes = canonicalBytes(report);
    if (reportRawBytes !== undefined) {
        const raw = Buffer.isBuffer(reportRawBytes) ? reportRawBytes : Buffer.from(reportRawBytes);
        if (!raw.equals(canonicalReportBytes)) throw fail('discovery report file is not canonical JSON bytes');
    }
    return { candidateManifest, report, catalogSha256: canonicalCatalogSha256, reportSha256: sha256(canonicalReportBytes) };
}

function parseStrictJsonBytes(bytes, label) {
    let source;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(source, label);
        return JSON.parse(source);
    } catch (error) {
        if (error?.code === 'CONFERENCE_DISCOVERY_INTEGRITY') throw error;
        throw fail(`${label} must contain valid strict UTF-8 JSON`);
    }
}

function directJsonFile(directory, name, label) {
    const root = safeAbsoluteDirectory(directory, `${label} directory`);
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) throw fail(`${label} must be a safe direct JSON filename`);
    const filename = path.resolve(root, name);
    if (path.dirname(filename) !== root) throw fail(`${label} must be directly inside its configured directory`);
    return filename;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function loadDiscoveryHandle(input, reportFilename) {
    let catalogFilename;
    if (typeof input === 'string') {
        catalogFilename = input;
        if (typeof reportFilename !== 'string') throw fail('report filename is required');
    } else {
        exact(input, ['catalogDir', 'catalogName', 'reportDir', 'reportName'], 'discovery handle input');
        catalogFilename = directJsonFile(input.catalogDir, input.catalogName, 'catalog');
        reportFilename = directJsonFile(input.reportDir, input.reportName, 'report');
    }
    const catalogLoaded = safeAbsoluteFile(catalogFilename, 'candidate manifest file', MAX_BUNDLE_BYTES);
    const reportLoaded = safeAbsoluteFile(reportFilename, 'discovery report file', MAX_BUNDLE_BYTES);
    const catalog = parseStrictJsonBytes(catalogLoaded.bytes, 'candidate manifest file');
    const report = parseStrictJsonBytes(reportLoaded.bytes, 'discovery report file');
    const validated = validateDiscoveryBundle(catalog, report,
        { catalogRawBytes: catalogLoaded.bytes, reportRawBytes: reportLoaded.bytes });
    const handle = Object.freeze(Object.create(null));
    DISCOVERY_HANDLES.add(handle);
    DISCOVERY_HANDLE_DATA.set(handle, Object.freeze({
        catalogFilename: fs.realpathSync(catalogLoaded.absolute),
        reportFilename: fs.realpathSync(reportLoaded.absolute),
        candidateManifest: deepFreeze(validated.candidateManifest),
        report: deepFreeze(validated.report),
        catalogSha256: validated.catalogSha256,
        reportSha256: validated.reportSha256
    }));
    return handle;
}

function discoveryHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !DISCOVERY_HANDLES.has(handle)) {
        throw fail('an authenticated loaded discovery handle is required');
    }
    const data = DISCOVERY_HANDLE_DATA.get(handle);
    return { catalogFilename: data.catalogFilename, reportFilename: data.reportFilename,
        candidateManifest: JSON.parse(JSON.stringify(data.candidateManifest)),
        report: JSON.parse(JSON.stringify(data.report)), catalogSha256: data.catalogSha256, reportSha256: data.reportSha256 };
}

function replayDiscoveryMember(handle, sourceIdentity) {
    if (!handle || typeof handle !== 'object' || !DISCOVERY_HANDLES.has(handle)) {
        throw fail('an authenticated loaded discovery handle is required');
    }
    if (typeof sourceIdentity !== 'string' || !sourceIdentity) throw fail('sourceIdentity is required');
    const data = DISCOVERY_HANDLE_DATA.get(handle);
    const manifest = data.candidateManifest;
    const member = manifest.members.find(item => ledgerApi.identityKey(item.identity) === sourceIdentity);
    if (!member) throw fail(`source identity is absent from discovery: ${sourceIdentity}`);
    const loaded = readMetadataSnapshot(manifest.metadataSnapshot.file);
    if (loaded.descriptor.file !== manifest.metadataSnapshot.file
        || loaded.descriptor.sha256 !== manifest.metadataSnapshot.sha256
        || loaded.descriptor.size !== manifest.metadataSnapshot.size) {
        throw fail('metadata snapshot bytes drifted after discovery');
    }
    const records = extractRecords(manifest.adapter, loaded.value);
    if (records.length !== manifest.members.length || member.metadataIndex >= records.length) {
        throw fail('metadata snapshot record set no longer matches discovery');
    }
    const record = records[member.metadataIndex];
    const normalized = normalizeMetadataMember(manifest.adapter, record, member.metadataIndex);
    if (ledgerApi.identityKey(normalized.identity) !== sourceIdentity || normalized.title !== member.title
        || normalized.numericAlias !== member.numericAlias) {
        throw fail('metadata record no longer binds the discovered member identity');
    }
    return {
        conference: JSON.parse(JSON.stringify(manifest.conference)), adapter: manifest.adapter,
        sourceIdentity, identity: JSON.parse(JSON.stringify(member.identity)), metadataIndex: member.metadataIndex,
        metadataSnapshotSha256: manifest.metadataSnapshot.sha256,
        metadataRecordSha256: ledgerApi.stableHash(record),
        metadataRecord: JSON.parse(JSON.stringify(record)),
        match: JSON.parse(JSON.stringify(member.match)), catalogSha256: data.catalogSha256
    };
}

function discoverConference({ adapter, year, metadataFile, pdfRoot } = {}) {
    if (!ADAPTERS.has(adapter)) throw fail('adapter must be one of: icassp, iclr, icml');
    if (!Number.isInteger(year) || year < 1900 || year > 2100) throw fail('year must be a supported four-digit integer');
    const metadata = readMetadataSnapshot(metadataFile);
    const pdfs = catalogPdfs(pdfRoot);
    const records = extractRecords(adapter, metadata.value);
    if (!records.length) throw fail('metadata snapshot must contain at least one paper');
    const members = records.map((record, index) => normalizeMetadataMember(adapter, record, index));
    const identityKeys = members.map(member => ledgerApi.identityKey(member.identity));
    if (new Set(identityKeys).size !== identityKeys.length) throw fail('metadata snapshot contains duplicate primary identities');
    const byPath = descriptorMap(pdfs.catalog);
    for (const member of members) member.match = adapter === 'icassp' ? icasspMatch(member, pdfs.catalog) : openReviewMatch(member, byPath);
    if (adapter === 'icassp') markSharedIcasspCandidatesAmbiguous(members);
    members.sort((left, right) => compare(ledgerApi.identityKey(left.identity), ledgerApi.identityKey(right.identity)));
    const manifest = {
        contract: CONTRACT,
        version: VERSION,
        adapter,
        conference: { id: `${adapter}-${year}`, year },
        metadataSnapshot: metadata.descriptor,
        pdfRoot: pdfs.root,
        pdfCatalogSha256: pdfs.catalogSha256,
        pdfCatalog: pdfs.catalog,
        members,
        memberSetSha256: ledgerApi.memberSetSha256(members)
    };
    return { manifest, report: buildReport(manifest) };
}

module.exports = {
    CONTRACT, REPORT_CONTRACT, VERSION, ADAPTERS, MATCH_KINDS, MAX_METADATA_BYTES, MAX_PDF_BYTES,
    canonicalBytes, readMetadataSnapshot, catalogPdfs, normalizedTitle, discoverConference, buildReport,
    validateDiscoveryBundle, loadDiscoveryHandle, discoveryHandleSnapshot, replayDiscoveryMember, SAFE_JSON_NAME,
    safeAbsoluteDirectory, safeAbsoluteFile
};
