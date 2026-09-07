'use strict';

// Build the page side of the retained-local conference route.  This module
// deliberately consumes only frozen inventory metadata, a local collector
// record's title, and a frontmatter title fingerprint.  It never exposes a
// historical page body or a retained generated analysis as a rewrite input.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const conference = require('./historical-conference-crawl-authority.js');

const CONTRACT = 'historical-conference-page-projections-v1';
const VERSION = 2;
const CATALOG_CONTRACT = 'merged-good-historical-local-data-v3';
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;

class HistoricalConferencePageProjectionError extends Error {
    constructor(message) {
        super(`Historical conference page projection rejected: ${message}`);
        this.name = 'HistoricalConferencePageProjectionError';
        this.code = 'HISTORICAL_CONFERENCE_PAGE_PROJECTION_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalConferencePageProjectionError(message); };
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
const validSha = value => SHA_RE.test(String(value || ''));

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
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function readStableFile(filename, label, maxBytes = MAX_JSON_BYTES) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be an absolute file`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`);
    let fd;
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
        return { filename: absolute, bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
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
            if (top.keys.has(key)) fail('JSON has duplicate keys');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readStableJson(filename, label, maxBytes = MAX_JSON_BYTES) {
    const loaded = readStableFile(filename, label, maxBytes); let value;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text); value = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalConferencePageProjectionError) throw error;
        fail(`${label} is not strict UTF-8 JSON`);
    }
    if (!plain(value) && !Array.isArray(value)) fail(`${label} root is invalid`);
    return { ...loaded, value };
}

function normalizeCatalog(value) {
    if (!plain(value) || value.contract !== CATALOG_CONTRACT || value.version !== 3
        || !Array.isArray(value.entries)) fail('v3 local source catalog contract is invalid');
    const seen = new Set();
    const entries = value.entries.map((entry, index) => {
        exact(entry, ['paperId', 'sources'], `catalog.entries[${index}]`);
        const isConference = typeof entry.paperId === 'string' && entry.paperId.startsWith('conference:');
        const isArxiv = typeof entry.paperId === 'string' && entry.paperId.startsWith('arxiv:');
        if ((!isConference && !isArxiv) || !Array.isArray(entry.sources)
            || (isConference && !entry.sources.length) || seen.has(entry.paperId)) {
            fail('catalog entries must have a unique supported identity and source list');
        }
        seen.add(entry.paperId);
        return clone(entry);
    }).filter(entry => entry.paperId.startsWith('conference:'))
        .sort((left, right) => left.paperId.localeCompare(right.paperId));
    return entries;
}

function normalizeInventory(value) {
    if (!plain(value) || !plain(value.counts) || !Array.isArray(value.pages)
        || !validSha(value.pageSetSha256) || !validSha(value.ledgerSha256)) {
        fail('historical inventory contract is invalid');
    }
    const pageKeys = new Set();
    const pages = value.pages.filter(page => page?.kind === 'paper').map((page, index) => {
        if (!PAGE_KEY_RE.test(String(page.pageId || '')) || typeof page.path !== 'string' || !page.path
            || !validSha(page.contentSha256) || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || pageKeys.has(page.pageId)) {
            fail(`inventory paper page ${index} is malformed`);
        }
        pageKeys.add(page.pageId);
        return { pageKey: page.pageId, pagePath: page.path, primaryUrl: typeof page.primaryUrl === 'string' ? page.primaryUrl : null,
            pageContentSha256: page.contentSha256, scope: clone(page.scope), cohortDate: String(page.cohortDate || '') };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { pageSetSha256: value.pageSetSha256, ledgerSha256: value.ledgerSha256, pages };
}

// Hugo frontmatter has historically omitted a small amount of inline TeX from
// a rendered title (for example `$\\tau$-Voice` became `-Voice`).  This is a
// deterministic presentation transform, not a title-similarity fallback.  A
// source record contributes its exact fingerprint and, only when different,
// the fingerprint after removing complete inline TeX spans.  A collision
// between either representation remains an error at the caller.
function titleProjectionFingerprintSha256s(title, label = 'conference metadata title') {
    const exactFingerprint = conference.titleFingerprint(title, label);
    const omittedInlineTex = title.replace(/\$(?:\\[\s\S]|[^$\\])*\$/gu, '');
    if (!omittedInlineTex.trim()) return [exactFingerprint];
    const displayFingerprint = conference.titleFingerprint(omittedInlineTex, `${label} without inline TeX`);
    return [...new Set([exactFingerprint, displayFingerprint])].sort();
}

function metadataTitle(source, paperId, cache) {
    if (!plain(source) || !plain(source.metadata) || !plain(source.pdf)
        || source.pdf.availability !== 'available' || !validSha(source.pdf.sha256)
        || typeof source.pdf.absolutePath !== 'string' || !path.isAbsolute(source.pdf.absolutePath)) return null;
    const metadata = source.metadata;
    if (typeof metadata.absolutePath !== 'string' || !path.isAbsolute(metadata.absolutePath)
        || !validSha(metadata.sha256) || !Number.isSafeInteger(metadata.recordIndex) || metadata.recordIndex < 0
        || !validSha(metadata.metadataIdentityBindingSha256)) return null;
    let snapshot = cache.get(metadata.absolutePath);
    if (!snapshot) {
        snapshot = readStableJson(metadata.absolutePath, 'conference metadata snapshot', 64 * 1024 * 1024);
        cache.set(metadata.absolutePath, snapshot);
    }
    if (snapshot.fileSha256 !== metadata.sha256) fail(`${paperId} conference metadata snapshot SHA drifted`);
    const records = Array.isArray(snapshot.value) ? snapshot.value : snapshot.value?.papers;
    if (!Array.isArray(records) || !plain(records[metadata.recordIndex])
        || typeof records[metadata.recordIndex].title !== 'string') {
        fail(`${paperId} conference metadata record has no source title`);
    }
    return titleProjectionFingerprintSha256s(records[metadata.recordIndex].title, 'conference metadata title');
}

function selectConferenceSources(entry, cache) {
    const selected = [];
    for (const source of entry.sources) {
        const fingerprints = metadataTitle(source, entry.paperId, cache);
        if (!fingerprints) continue;
        selected.push({ sourceSet: String(source.sourceSet || ''), provenance: String(source.provenance || ''),
            metadata: clone(source.metadata), pdf: clone(source.pdf), titleProjectionFingerprintSha256s: fingerprints });
    }
    if (!selected.length) fail(`${entry.paperId} has no usable retained local conference PDF source`);
    return selected.sort((left, right) => stableHash(left).localeCompare(stableHash(right)));
}

function conferenceScopeFor(paperId) {
    const match = String(paperId).match(/^conference:([a-z0-9]+(?:-[a-z0-9]+)*):(\d{4}):/);
    if (!match) fail(`conference paperId is invalid: ${paperId}`);
    return { type: 'conference', key: `${match[1]}-${match[2]}` };
}

function buildConferencePageProjections({ catalog, catalogFileSha256, inventory, blogRoot } = {}) {
    if (!validSha(catalogFileSha256)) fail('catalog file SHA is required');
    const entries = normalizeCatalog(catalog); const history = normalizeInventory(inventory);
    const cache = new Map(); const candidatesByScopeAndTitle = new Map();
    const sourceByPaperId = new Map();
    for (const entry of entries) {
        const sources = selectConferenceSources(entry, cache); sourceByPaperId.set(entry.paperId, sources);
        const scope = conferenceScopeFor(entry.paperId);
        for (const source of sources) {
            for (const fingerprint of source.titleProjectionFingerprintSha256s) {
                const key = `${scope.key}\0${fingerprint}`;
                const candidates = candidatesByScopeAndTitle.get(key) || new Set();
                candidates.add(entry.paperId); candidatesByScopeAndTitle.set(key, candidates);
            }
        }
    }
    const pagesByPaperId = new Map(); const unmatchedPages = [];
    for (const page of history.pages.filter(item => item.scope.type === 'conference')) {
        const binding = conference.pageTitleBinding({ blogRoot, pageKey: page.pageKey,
            pagePath: page.pagePath, pageContentSha256: page.pageContentSha256 });
        const candidates = candidatesByScopeAndTitle.get(`${page.scope.key}\0${binding.titleFingerprintSha256}`)
            || new Set();
        if (candidates.size === 0) { unmatchedPages.push({ pageKey: page.pageKey, pagePath: page.pagePath,
            scope: page.scope, reason: 'no-retained-local-title-match' }); continue; }
        if (candidates.size !== 1) fail(`${page.pageKey} frontmatter title maps to multiple retained conference identities`);
        const paperId = [...candidates][0]; const values = pagesByPaperId.get(paperId) || [];
        values.push({ ...page, titleFingerprintSha256: binding.titleFingerprintSha256 }); pagesByPaperId.set(paperId, values);
    }
    const projections = entries.map(entry => {
        const pages = (pagesByPaperId.get(entry.paperId) || []).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        if (!pages.length) fail(`${entry.paperId} has no frozen historical conference page projection`);
        return { paperId: entry.paperId, sourceSetSha256: stableHash(sourceByPaperId.get(entry.paperId)),
            pageKeys: pages.map(page => page.pageKey), pages: pages.map(page => ({ pageKey: page.pageKey,
                pagePath: page.pagePath, primaryUrl: page.primaryUrl, pageContentSha256: page.pageContentSha256,
                cohortDate: page.cohortDate, scope: page.scope, titleFingerprintSha256: page.titleFingerprintSha256 })) };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const body = { contract: CONTRACT, version: VERSION, catalogFileSha256,
        inventory: { ledgerSha256: history.ledgerSha256, pageSetSha256: history.pageSetSha256 },
        projections, projectionSetSha256: stableHash(projections),
        unmatchedPages: unmatchedPages.sort((left, right) => left.pageKey.localeCompare(right.pageKey)) };
    return { ...body, artifactSha256: stableHash(body) };
}

function normalizeProjectionArtifact(value) {
    exact(value, ['contract', 'version', 'catalogFileSha256', 'inventory', 'projections',
        'projectionSetSha256', 'unmatchedPages', 'artifactSha256'], 'conference page projection artifact');
    if (value.contract !== CONTRACT || value.version !== VERSION || !validSha(value.catalogFileSha256)
        || !plain(value.inventory) || !validSha(value.inventory.ledgerSha256)
        || !validSha(value.inventory.pageSetSha256) || !Array.isArray(value.projections)
        || !Array.isArray(value.unmatchedPages) || !validSha(value.projectionSetSha256)
        || !validSha(value.artifactSha256)) fail('conference page projection artifact is malformed');
    const seenPages = new Set(); const projections = value.projections.map((item, index) => {
        exact(item, ['paperId', 'sourceSetSha256', 'pageKeys', 'pages'], `projections[${index}]`);
        if (typeof item.paperId !== 'string' || !item.paperId.startsWith('conference:')
            || !validSha(item.sourceSetSha256) || !Array.isArray(item.pageKeys) || !item.pageKeys.length
            || !Array.isArray(item.pages) || item.pageKeys.length !== item.pages.length) fail('conference projection is malformed');
        const pages = item.pages.map((page, pageIndex) => {
            exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'pageContentSha256', 'cohortDate', 'scope', 'titleFingerprintSha256'],
                `projections[${index}].pages[${pageIndex}]`);
            if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
                || !(page.primaryUrl === null || typeof page.primaryUrl === 'string') || !validSha(page.pageContentSha256) || typeof page.cohortDate !== 'string' || !plain(page.scope)
                || typeof page.scope.type !== 'string' || typeof page.scope.key !== 'string'
                || !validSha(page.titleFingerprintSha256) || seenPages.has(page.pageKey)) fail('conference projected page is malformed or duplicated');
            seenPages.add(page.pageKey); return clone(page);
        }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        if (item.pageKeys.join('\0') !== pages.map(page => page.pageKey).join('\0')) fail('conference projection pageKeys drifted');
        return { paperId: item.paperId, sourceSetSha256: item.sourceSetSha256,
            pageKeys: item.pageKeys.slice(), pages };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(projections.map(item => item.paperId)).size !== projections.length
        || projections.some((item, index) => index && projections[index - 1].paperId.localeCompare(item.paperId) >= 0)) {
        fail('conference projections duplicate or are unordered');
    }
    const unmatchedPages = value.unmatchedPages.map((page, index) => {
        exact(page, ['pageKey', 'pagePath', 'scope', 'reason'], `unmatchedPages[${index}]`);
        if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
            || !plain(page.scope) || page.reason !== 'no-retained-local-title-match' || seenPages.has(page.pageKey)) {
            fail('unmatched conference page is malformed or duplicated');
        }
        seenPages.add(page.pageKey); return clone(page);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const body = { contract: CONTRACT, version: VERSION, catalogFileSha256: value.catalogFileSha256,
        inventory: clone(value.inventory), projections, projectionSetSha256: value.projectionSetSha256, unmatchedPages };
    if (stableHash(projections) !== value.projectionSetSha256 || stableHash(body) !== value.artifactSha256) {
        fail('conference page projection hash binding drifted');
    }
    return { ...body, artifactSha256: value.artifactSha256 };
}

function writeProjectionArtifact({ root, outputName, artifact } = {}) {
    if (!SAFE_NAME_RE.test(String(outputName || ''))) fail('projection output name is unsafe');
    const directory = safeDirectory(root, 'conference projection root', true);
    const normalized = normalizeProjectionArtifact(artifact); const filename = path.join(directory, outputName);
    const bytes = prettyBytes(normalized); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, artifact: normalized };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readStableFile(filename, 'existing conference projection').bytes.equals(bytes)) {
            fail(`refuses to overwrite different conference projection: ${outputName}`);
        }
        return { status: 'recovered', filename, artifact: normalized };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildFromFiles({ catalogFile, inventoryFile, blogRoot } = {}) {
    const catalog = readStableJson(catalogFile, 'local source catalog');
    const inventory = readStableJson(inventoryFile, 'historical inventory');
    return buildConferencePageProjections({ catalog: catalog.value, catalogFileSha256: catalog.fileSha256,
        inventory: inventory.value, blogRoot });
}

module.exports = { CONTRACT, VERSION, CATALOG_CONTRACT, SAFE_NAME_RE, HistoricalConferencePageProjectionError,
    stableHash, prettyBytes, safeDirectory, readStableFile, readStableJson, normalizeCatalog, normalizeInventory,
    titleProjectionFingerprintSha256s, selectConferenceSources, buildConferencePageProjections, normalizeProjectionArtifact,
    writeProjectionArtifact, buildFromFiles };
