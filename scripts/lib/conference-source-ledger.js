'use strict';

// Local-only, immutable source ledger for conference papers.  This is kept
// deliberately separate from the arXiv fresh-rewrite protocol: a title is
// useful metadata, but is never an identity or a merge key here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONTRACT = 'conference-source-ledger-v1';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;
const IDENTITY_TYPES = new Set(['icassp-arnumber', 'openreview-forum-id', 'conference-paper-id']);
const EVIDENCE_KINDS = new Set(['metadata', 'pdf', 'text', 'artifacts']);
const STATUS_STATES = new Set(['verified', 'needs-review', 'blocked']);
const AVAILABILITY_STATES = new Set(['present', 'absent']);
const SOURCE_KINDS = new Set(['official-metadata', 'official-pdf', 'conference-proceedings', 'openreview', 'local-confirmed-copy', 'legacy-unrecorded']);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const compareIdentityKeys = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function stableHash(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return sha256(JSON.stringify(normalize(value)));
}

function plainObject(value, fields, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error(`${name} must be a plain object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${name} has unexpected or missing fields`);
    }
}

function nonemptyString(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error(`${name} must be a nonempty trimmed string without controls`);
    }
}

function assertSha(value, name) {
    if (!SHA_RE.test(String(value || ''))) throw new Error(`${name} must be a lowercase SHA-256`);
}

function assertRelativePath(value, name) {
    nonemptyString(value, name);
    // Accept one portable ledger spelling only.  Backslashes are rejected so
    // Windows paths cannot become absolute after a platform change.
    if (value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value)
        || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`${name} must be a normalized relative path`);
    }
    if (path.posix.normalize(value) !== value) throw new Error(`${name} must be a normalized relative path`);
    return value;
}

function assertTimestamp(value, name) {
    nonemptyString(value, name);
    const parsed = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`${name} must be a canonical UTC ISO timestamp`);
    }
}

function validateIdentity(identity) {
    plainObject(identity, ['type', 'value'], 'member.identity');
    if (!IDENTITY_TYPES.has(identity.type)) throw new Error('member.identity.type is unsupported');
    nonemptyString(identity.value, 'member.identity.value');
    const valid = (identity.type === 'icassp-arnumber' || identity.type === 'conference-paper-id')
        ? /^[1-9]\d*$/.test(identity.value)
        : /^[A-Za-z0-9_-]{6,128}$/.test(identity.value);
    if (!valid) throw new Error(`member.identity.value is invalid for ${identity.type}`);
    return { type: identity.type, value: identity.value };
}

function identityKey(identity) {
    const normalized = validateIdentity(identity);
    return `${normalized.type}:${normalized.value}`;
}

function validateAvailability(availability) {
    plainObject(availability, ['metadata', 'pdf', 'text', 'artifacts'], 'member.availability');
    for (const kind of EVIDENCE_KINDS) {
        if (!AVAILABILITY_STATES.has(availability[kind])) {
            throw new Error(`member.availability.${kind} must be present or absent`);
        }
    }
    if (availability.metadata !== 'present') {
        throw new Error('member.availability.metadata must be present for a verified conference identity');
    }
    return availability;
}

function validateSourceRecord(value, name) {
    plainObject(value, ['kind', 'locator', 'retrievedAt'], name);
    if (!SOURCE_KINDS.has(value.kind)) throw new Error(`${name}.kind is unsupported`);
    nonemptyString(value.locator, `${name}.locator`);
    assertTimestamp(value.retrievedAt, `${name}.retrievedAt`);
}

function validateDerivedRecord(value, name, expectedPdfSha256) {
    plainObject(value, ['extractor', 'version', 'inputSha256'], name);
    nonemptyString(value.extractor, `${name}.extractor`);
    nonemptyString(value.version, `${name}.version`);
    assertSha(value.inputSha256, `${name}.inputSha256`);
    if (value.inputSha256 !== expectedPdfSha256) {
        throw new Error(`${name}.inputSha256 must bind the member PDF SHA-256`);
    }
}

function validateProvenance(provenance, availability, member) {
    plainObject(provenance, ['metadata', 'pdf', 'text', 'artifacts'], 'member.provenance');
    for (const kind of EVIDENCE_KINDS) {
        const value = provenance[kind];
        if (availability[kind] === 'absent') {
            if (value !== null) throw new Error(`member.provenance.${kind} must be null when its artifact is absent`);
            continue;
        }
        if (kind === 'metadata' || kind === 'pdf') validateSourceRecord(value, `member.provenance.${kind}`);
        else validateDerivedRecord(value, `member.provenance.${kind}`, member.pdfSha256);
    }
}

function validateEvidence(evidence, member) {
    const presentKinds = [...EVIDENCE_KINDS].filter(kind => member.availability[kind] === 'present');
    if (!Array.isArray(evidence) || evidence.length !== presentKinds.length) {
        throw new Error('member.status.evidence must bind exactly the present source artifacts');
    }
    const expected = new Map([
        ['metadata', member.metadataSha256], ['pdf', member.pdfSha256],
        ['text', member.textSha256], ['artifacts', member.artifactsSha256]
    ]);
    const found = new Set();
    for (const item of evidence) {
        plainObject(item, ['kind', 'sha256'], 'member.status.evidence entry');
        if (!EVIDENCE_KINDS.has(item.kind) || found.has(item.kind)) {
            throw new Error('member.status.evidence has duplicate or unsupported kind');
        }
        assertSha(item.sha256, `member.status.evidence.${item.kind}.sha256`);
        if (item.sha256 !== expected.get(item.kind)) {
            throw new Error(`member.status.evidence.${item.kind} is not bound to the member source SHA`);
        }
        found.add(item.kind);
    }
    if (presentKinds.some(kind => !found.has(kind))) {
        throw new Error('member.status.evidence must bind exactly the present source artifacts');
    }
}

function validateStatus(status, member) {
    plainObject(status, ['state', 'updatedAt', 'reason', 'evidence'], 'member.status');
    if (!STATUS_STATES.has(status.state)) throw new Error('member.status.state is unsupported');
    assertTimestamp(status.updatedAt, 'member.status.updatedAt');
    nonemptyString(status.reason, 'member.status.reason');
    const complete = [...EVIDENCE_KINDS].every(kind => member.availability[kind] === 'present');
    if ((status.state === 'verified') !== complete) {
        throw new Error('only verified members may have all four replayable source artifacts');
    }
    validateEvidence(status.evidence, member);
}

function validateMember(member) {
    const fields = [
        'identity', 'metadataFile', 'metadataSha256', 'pdfFile', 'pdfSha256',
        'textFile', 'textSha256', 'artifactsFile', 'artifactsSha256',
        'availability', 'provenance', 'status'
    ];
    plainObject(member, fields, 'member');
    const normalized = {
        identity: validateIdentity(member.identity),
        metadataFile: member.metadataFile,
        metadataSha256: member.metadataSha256,
        pdfFile: member.pdfFile,
        pdfSha256: member.pdfSha256,
        textFile: member.textFile,
        textSha256: member.textSha256,
        artifactsFile: member.artifactsFile,
        artifactsSha256: member.artifactsSha256,
        availability: member.availability,
        provenance: member.provenance,
        status: member.status
    };
    validateAvailability(normalized.availability);
    for (const kind of EVIDENCE_KINDS) {
        const fileField = `${kind}File`;
        const shaField = `${kind}Sha256`;
        if (normalized.availability[kind] === 'present') {
            normalized[fileField] = assertRelativePath(normalized[fileField], `member.${fileField}`);
            assertSha(normalized[shaField], `member.${shaField}`);
        } else if (normalized[fileField] !== null || normalized[shaField] !== null) {
            throw new Error(`member.${fileField} and member.${shaField} must be null when ${kind} is absent`);
        }
    }
    if ((normalized.availability.text === 'present' || normalized.availability.artifacts === 'present')
        && normalized.availability.pdf !== 'present') {
        throw new Error('derived text or artifacts require a present PDF source artifact');
    }
    const files = [...EVIDENCE_KINDS]
        .filter(kind => normalized.availability[kind] === 'present')
        .map(kind => normalized[`${kind}File`]);
    if (new Set(files).size !== files.length) throw new Error('member source files must not alias each other');
    validateProvenance(normalized.provenance, normalized.availability, normalized);
    validateStatus(normalized.status, normalized);
    return normalized;
}

function memberSetSha256(members) {
    if (!Array.isArray(members)) throw new Error('members must be an array');
    return stableHash(members.map(member => validateIdentity(member.identity)).sort((a, b) => compareIdentityKeys(identityKey(a), identityKey(b))));
}

function validateLedger(ledger) {
    plainObject(ledger, ['version', 'conference', 'members', 'memberSetSha256'], 'conference source ledger');
    if (ledger.version !== CONTRACT) throw new Error(`Unsupported conference source ledger version: ${ledger.version}`);
    plainObject(ledger.conference, ['id', 'year'], 'conference');
    if (typeof ledger.conference.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ledger.conference.id)) {
        throw new Error('conference.id must be a normalized slug');
    }
    if (!Number.isInteger(ledger.conference.year) || ledger.conference.year < 1900 || ledger.conference.year > 2100) {
        throw new Error('conference.year must be a four-digit supported year');
    }
    if (!Array.isArray(ledger.members) || !ledger.members.length) throw new Error('conference source ledger requires nonempty members');
    const members = ledger.members.map(validateMember);
    const keys = members.map(member => identityKey(member.identity));
    if (new Set(keys).size !== keys.length) throw new Error('conference source ledger contains duplicate identities');
    const sorted = [...keys].sort(compareIdentityKeys);
    if (keys.some((key, index) => key !== sorted[index])) throw new Error('conference source ledger members must be sorted by canonical identity');
    assertSha(ledger.memberSetSha256, 'memberSetSha256');
    if (ledger.memberSetSha256 !== memberSetSha256(members)) throw new Error('conference source ledger memberSetSha256 mismatch');
    return ledger;
}

// JSON.parse silently accepts duplicate object keys.  Reject them before
// schema validation so a signed-looking ledger cannot hide a replacement key.
function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function readRegularJson(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Ledger JSON filename must be absolute');
    const directory = path.dirname(filename);
    if (fs.realpathSync(directory) !== directory) throw new Error(`Unsafe ledger JSON directory: ${directory}`);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_JSON_BYTES) throw new Error(`Unsafe ledger JSON file: ${filename}`);
        const bytes = fs.readFileSync(fd);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        rejectDuplicateJsonKeys(text);
        return { value: JSON.parse(text), sha256: sha256(bytes) };
    } finally { fs.closeSync(fd); }
}

function readRegularBytes(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe ledger artifact file: ${filename}`);
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function assertSafeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Ledger source root must be absolute');
    const normalized = path.resolve(root);
    const stat = fs.lstatSync(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(normalized) !== normalized) {
        throw new Error(`Unsafe ledger source root: ${root}`);
    }
    return normalized;
}

function safeArtifactPath(root, relativePath) {
    const safeRoot = assertSafeRoot(root);
    assertRelativePath(relativePath, 'ledger artifact path');
    const target = path.resolve(safeRoot, ...relativePath.split('/'));
    if (!target.startsWith(`${safeRoot}${path.sep}`)) throw new Error('Ledger artifact escapes source root');
    let cursor = safeRoot;
    for (const part of relativePath.split('/')) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== target)) {
            throw new Error(`Unsafe ledger artifact path: ${relativePath}`);
        }
    }
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
        throw new Error(`Unsafe ledger artifact file: ${relativePath}`);
    }
    return target;
}

function verifyMemberFiles(ledger, root) {
    validateLedger(ledger);
    const safeRoot = assertSafeRoot(root);
    const notReady = [];
    for (const member of ledger.members) {
        for (const kind of EVIDENCE_KINDS) {
            if (member.availability[kind] !== 'present') continue;
            const fileField = `${kind}File`;
            const shaField = `${kind}Sha256`;
            const target = safeArtifactPath(safeRoot, member[fileField]);
            const bytes = readRegularBytes(target);
            if (sha256(bytes) !== member[shaField]) {
                throw new Error(`${identityKey(member.identity)} ${fileField} SHA-256 mismatch`);
            }
        }
        if (member.status.state !== 'verified') notReady.push(identityKey(member.identity));
    }
    if (notReady.length) {
        throw new Error(`Conference ledger contains non-verified members and is not ready for replay: ${notReady.join(', ')}`);
    }
    return true;
}

// v1 had no runtime ledger when this contract was tightened.  Keep this
// narrow authoring compatibility only for callers which create an in-memory
// all-present fixture, then emit the canonical schema rather than accepting
// an un-auditable legacy object in validateLedger/loadLedger.
function upgradeLegacyCreateMember(member) {
    const legacyFields = [
        'identity', 'metadataFile', 'metadataSha256', 'pdfFile', 'pdfSha256',
        'textFile', 'textSha256', 'artifactsFile', 'artifactsSha256', 'status'
    ];
    const actual = member && typeof member === 'object' && !Array.isArray(member) ? Object.keys(member).sort() : [];
    if (actual.length !== legacyFields.length || actual.some((key, index) => key !== [...legacyFields].sort()[index])) return member;
    const identity = validateIdentity(member.identity);
    const updatedAt = member.status?.updatedAt;
    assertTimestamp(updatedAt, 'member.status.updatedAt');
    const baseLocator = `legacy-unrecorded:${identityKey(identity)}`;
    return {
        ...member,
        availability: { metadata: 'present', pdf: 'present', text: 'present', artifacts: 'present' },
        provenance: {
            metadata: { kind: 'legacy-unrecorded', locator: `${baseLocator}:metadata`, retrievedAt: updatedAt },
            pdf: { kind: 'legacy-unrecorded', locator: `${baseLocator}:pdf`, retrievedAt: updatedAt },
            text: { extractor: 'legacy-unrecorded', version: 'v1', inputSha256: member.pdfSha256 },
            artifacts: { extractor: 'legacy-unrecorded', version: 'v1', inputSha256: member.pdfSha256 }
        }
    };
}

function createLedger(conference, members) {
    plainObject(conference, ['id', 'year'], 'conference');
    if (!Array.isArray(members) || !members.length) throw new Error('conference source ledger requires nonempty members');
    const ordered = members.map(upgradeLegacyCreateMember).map(validateMember)
        .sort((left, right) => compareIdentityKeys(identityKey(left.identity), identityKey(right.identity)));
    const keys = ordered.map(member => identityKey(member.identity));
    if (new Set(keys).size !== keys.length) throw new Error('conference source ledger contains duplicate identities');
    const result = { version: CONTRACT, conference: { ...conference }, members: ordered, memberSetSha256: memberSetSha256(ordered) };
    validateLedger(result);
    return result;
}

function writeLedger(filename, ledger) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Ledger JSON filename must be absolute');
    validateLedger(ledger);
    const directory = path.dirname(filename);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        throw new Error(`Unsafe ledger output directory: ${directory}`);
    }
    const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return sha256(bytes);
}

function loadLedger(filename) {
    const loaded = readRegularJson(filename);
    validateLedger(loaded.value);
    return { ledger: loaded.value, ledgerSha256: loaded.sha256 };
}

module.exports = {
    CONTRACT, sha256, stableHash, identityKey, memberSetSha256, createLedger,
    validateIdentity, validateMember, validateLedger, readRegularJson,
    assertRelativePath, safeArtifactPath, verifyMemberFiles, writeLedger, loadLedger
};
