'use strict';

// Builds the scoped v4 catalog for direct historical rewriting. It consumes
// one approved local content manifest (conference PDF/metadata) and the frozen
// inventory. arXiv entries come from frozen single hints plus sealed primary
// score-row bindings for otherwise conflict/multiple daily pages;
// they deliberately have no retained local writer input because every run must
// fetch and seal fresh official text/PDF before analysis.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const conferenceAuthority = require('./historical-conference-crawl-authority.js');
const conferenceManifestApi = require('./historical-conference-local-sources.js');
const projectionApi = require('./historical-conference-page-projections.js');
const dailyPrimaryArxiv = require('./historical-daily-primary-arxiv-binding.js');

const CONTRACT = 'merged-good-historical-local-data-v4';
const VERSION = 4;
const SCOPE = 'historical-corresponding-local-sources-only';
const SHA_RE = /^[a-f0-9]{64}$/;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;

class HistoricalDirectRewriteInputCatalogError extends Error {
    constructor(message) {
        super(`Historical direct rewrite input catalog rejected: ${message}`);
        this.name = 'HistoricalDirectRewriteInputCatalogError';
        this.code = 'HISTORICAL_DIRECT_REWRITE_INPUT_CATALOG_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalDirectRewriteInputCatalogError(message); };
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

function readStableJson(filename, label) {
    try { return projectionApi.readStableJson(filename, label, MAX_MANIFEST_BYTES); }
    catch (error) { fail(`${label} is unreadable: ${error.message}`); }
}

function conferenceScopeFor(paperId) {
    const match = String(paperId).match(/^conference:([a-z0-9]+(?:-[a-z0-9]+)*):(\d{4}):/);
    if (!match) fail(`conference manifest paper ID is invalid: ${paperId}`);
    return { type: 'conference', key: `${match[1]}-${match[2]}` };
}

function sourcePriority(sourceSet) {
    // The workspace crawler is preferred. An accepted ICLR record is allowed
    // only if its exact title binds a frozen page and no workspace record for
    // the same identity wins this priority rule.
    if (/^workspace-[a-z0-9-]+-\d{4}$/.test(sourceSet)) return 0;
    if (/^accepted-local-iclr-\d{4}$/.test(sourceSet)) return 1;
    return 2;
}

function selectedConferenceSource(sources, pageFingerprints, paperId) {
    const candidates = sources.filter(source => source.titleProjectionFingerprintSha256s
        .some(fingerprint => pageFingerprints.has(fingerprint)));
    if (!candidates.length) fail(`${paperId} has no title-bound retained local conference source`);
    candidates.sort((left, right) => sourcePriority(left.sourceSet) - sourcePriority(right.sourceSet)
        || stableHash(left).localeCompare(stableHash(right)));
    const source = candidates[0];
    return { sourceSet: source.sourceSet, provenance: source.provenance,
        metadata: clone(source.metadata), pdf: clone(source.pdf) };
}

function scopeConferenceEntries({ conferenceManifest, inventory, blogRoot } = {}) {
    try { conferenceManifestApi.assertManifest(conferenceManifest); }
    catch (error) { fail(`approved conference local-source manifest is invalid: ${error.message}`); }
    const history = projectionApi.normalizeInventory(inventory);
    if (typeof blogRoot !== 'string' || !path.isAbsolute(blogRoot)) fail('blogRoot must be an absolute path');
    const sourceCache = new Map(); const candidatesByScopeAndTitle = new Map(); const entriesByPaperId = new Map();
    for (const record of conferenceManifest.records) {
        if (!plain(record) || typeof record.paperId !== 'string' || !Array.isArray(record.sources)) {
            fail('approved conference local-source record is malformed');
        }
        let sources;
        try { sources = projectionApi.selectConferenceSources({ paperId: record.paperId, sources: clone(record.sources) }, sourceCache); }
        catch { continue; } // No available retained PDF is not a direct local input.
        const scope = conferenceScopeFor(record.paperId);
        entriesByPaperId.set(record.paperId, { paperId: record.paperId, sources });
        for (const source of sources) for (const fingerprint of source.titleProjectionFingerprintSha256s) {
            const key = `${scope.key}\0${fingerprint}`;
            const paperIds = candidatesByScopeAndTitle.get(key) || new Set();
            paperIds.add(record.paperId); candidatesByScopeAndTitle.set(key, paperIds);
        }
    }
    const pageFingerprintsByPaperId = new Map(); const unresolved = [];
    for (const page of history.pages.filter(item => item.scope.type === 'conference')) {
        let binding;
        try {
            binding = conferenceAuthority.pageTitleBinding({ blogRoot, pageKey: page.pageKey,
                pagePath: page.pagePath, pageContentSha256: page.pageContentSha256 });
        } catch (error) { fail(`frozen conference title binding is invalid: ${error.message}`); }
        const candidates = candidatesByScopeAndTitle.get(`${page.scope.key}\0${binding.titleFingerprintSha256}`) || new Set();
        if (candidates.size === 0) {
            unresolved.push({ pageKey: page.pageKey, pagePath: page.pagePath, scope: clone(page.scope),
                reason: 'no-retained-local-title-match' });
            continue;
        }
        if (candidates.size !== 1) fail(`${page.pageKey} frontmatter title maps to multiple retained conference identities`);
        const paperId = [...candidates][0]; const values = pageFingerprintsByPaperId.get(paperId) || new Set();
        values.add(binding.titleFingerprintSha256); pageFingerprintsByPaperId.set(paperId, values);
    }
    if (unresolved.length) fail(`approved local conference sources leave ${unresolved.length} frozen conference pages unresolved`);
    const entries = [...pageFingerprintsByPaperId.entries()].map(([paperId, fingerprints]) => {
        const item = entriesByPaperId.get(paperId);
        if (!item) fail(`${paperId} selection has no retained source record`);
        return { paperId, sources: [selectedConferenceSource(item.sources, fingerprints, paperId)] };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    return { entries, conferencePageCount: history.pages.filter(item => item.scope.type === 'conference').length };
}

function dailyPrimaryArxivBindingsFromFrozenInventory(value, blogRoot) {
    const history = projectionApi.normalizeInventory(value); const bindings = [];
    for (const page of history.pages) {
        if (page.scope.type !== 'daily' || !['conflict', 'multiple'].includes(page.identityHints?.status)) continue;
        try { bindings.push(dailyPrimaryArxiv.build({ blogRoot, page, identityHints: page.identityHints })); }
        catch (error) {
            if (error?.code !== 'HISTORICAL_DAILY_PRIMARY_ARXIV_BINDING_INTEGRITY') throw error;
        }
    }
    return bindings.map(dailyPrimaryArxiv.normalize).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function arxivEntriesFromFrozenInventory(value, dailyPrimaryArxivBindings = []) {
    const history = projectionApi.normalizeInventory(value);
    const rawPages = new Map(value.pages.filter(page => page?.kind === 'paper').map(page => [page.pageId, page]));
    const paperIds = new Set(); let singlePageCount = 0;
    for (const page of history.pages) {
        // Conference pages already have their exact retained conference-PDF
        // route. Routing them through fresh arXiv too would duplicate a page.
        if (page.scope.type === 'conference') continue;
        const hints = rawPages.get(page.pageKey)?.identityHints;
        if (hints?.status !== 'single' || !Array.isArray(hints.candidates) || hints.candidates.length !== 1) continue;
        const hint = hints.candidates[0];
        if (hint?.scheme !== 'arxiv' || !ARXIV_ID_RE.test(String(hint.value || ''))) continue;
        if (!Array.isArray(hint.sources) || !hint.sources.length || hint.sources.some(source => typeof source !== 'string' || !source)
            || new Set(hint.sources).size !== hint.sources.length) {
            fail(`${page.pageKey} frozen arXiv identity hint has no exact source mapping`);
        }
        paperIds.add(`arxiv:${hint.value}`); singlePageCount += 1;
    }
    const bindings = dailyPrimaryArxivBindings.map(dailyPrimaryArxiv.normalize);
    for (const binding of bindings) paperIds.add(`arxiv:${binding.arxivId}`);
    return { entries: [...paperIds].sort().map(paperId => ({ paperId, sources: [] })),
        pageCount: singlePageCount + bindings.length, singlePageCount, bindingPageCount: bindings.length };
}

function inputDescriptor(loaded, selectedPapers) {
    return { path: loaded.filename, sha256: loaded.fileSha256, selectedPapers };
}

function buildScopedCatalog({ conferenceManifest, inventoryFile, blogRoot } = {}) {
    const conference = typeof conferenceManifest?.filename === 'string' ? conferenceManifest : readStableJson(conferenceManifest, 'approved conference local-source manifest');
    const inventory = typeof inventoryFile?.filename === 'string' ? inventoryFile : readStableJson(inventoryFile, 'frozen historical inventory');
    const normalizedInventory = projectionApi.normalizeInventory(inventory.value);
    const dailyPrimaryArxivBindings = dailyPrimaryArxivBindingsFromFrozenInventory(inventory.value, blogRoot);
    const arxiv = arxivEntriesFromFrozenInventory(inventory.value, dailyPrimaryArxivBindings);
    const scopedConference = scopeConferenceEntries({ conferenceManifest: conference.value, inventory: inventory.value, blogRoot });
    const entries = [...arxiv.entries, ...scopedConference.entries].sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(entries.map(entry => entry.paperId)).size !== entries.length) fail('scoped local inputs duplicate a canonical paper ID');
    const sourceSets = {};
    for (const entry of scopedConference.entries) for (const source of entry.sources) {
        sourceSets[source.sourceSet] = (sourceSets[source.sourceSet] || 0) + 1;
    }
    const summary = { arxivPapers: arxiv.entries.length, arxivPages: arxiv.pageCount,
        singleArxivPages: arxiv.singlePageCount, dailyPrimaryArxivBindings: arxiv.bindingPageCount,
        conferencePapers: scopedConference.entries.length, canonicalRecords: entries.length,
        sourceRecords: scopedConference.entries.length,
        conferenceSourceSets: Object.fromEntries(Object.entries(sourceSets).sort(([left], [right]) => left.localeCompare(right))) };
    return { contract: CONTRACT, version: VERSION, scope: SCOPE,
        scopeBinding: { inventoryPath: inventory.filename, inventorySha256: inventory.fileSha256,
            inventoryLedgerSha256: normalizedInventory.ledgerSha256, inventoryPageSetSha256: normalizedInventory.pageSetSha256,
            arxivPageCount: arxiv.pageCount, singleArxivPageCount: arxiv.singlePageCount,
            dailyPrimaryArxivBindingCount: arxiv.bindingPageCount,
            conferencePageCount: scopedConference.conferencePageCount },
        inputs: [inputDescriptor(conference, scopedConference.entries.length)], summary,
        dailyPrimaryArxivBindings, dailyPrimaryArxivBindingSetSha256: stableHash(dailyPrimaryArxivBindings), entries };
}

function normalizeCatalog(value) {
    if (!plain(value) || value.contract !== CONTRACT || value.version !== VERSION || value.scope !== SCOPE
        || !plain(value.scopeBinding) || !Array.isArray(value.inputs) || !plain(value.summary) || !Array.isArray(value.entries)) {
        fail('scoped v4 direct rewrite catalog contract is invalid');
    }
    exact(value, ['contract', 'version', 'scope', 'scopeBinding', 'inputs', 'summary', 'dailyPrimaryArxivBindings',
        'dailyPrimaryArxivBindingSetSha256', 'entries'], 'scoped v4 direct rewrite catalog');
    exact(value.scopeBinding, ['inventoryPath', 'inventorySha256', 'inventoryLedgerSha256', 'inventoryPageSetSha256',
        'arxivPageCount', 'singleArxivPageCount', 'dailyPrimaryArxivBindingCount', 'conferencePageCount'], 'catalog scope binding');
    if (typeof value.scopeBinding.inventoryPath !== 'string' || !path.isAbsolute(value.scopeBinding.inventoryPath)
        || !validSha(value.scopeBinding.inventorySha256) || !validSha(value.scopeBinding.inventoryLedgerSha256)
        || !validSha(value.scopeBinding.inventoryPageSetSha256) || !Number.isSafeInteger(value.scopeBinding.arxivPageCount)
        || value.scopeBinding.arxivPageCount < 0 || !Number.isSafeInteger(value.scopeBinding.singleArxivPageCount)
        || value.scopeBinding.singleArxivPageCount < 0 || !Number.isSafeInteger(value.scopeBinding.dailyPrimaryArxivBindingCount)
        || value.scopeBinding.dailyPrimaryArxivBindingCount < 0 || !Number.isSafeInteger(value.scopeBinding.conferencePageCount)
        || value.scopeBinding.conferencePageCount < 0) fail('catalog scope binding is malformed');
    if (!Array.isArray(value.dailyPrimaryArxivBindings) || !validSha(value.dailyPrimaryArxivBindingSetSha256)) {
        fail('daily primary arXiv binding set is malformed');
    }
    const bindingPageKeys = new Set(); const dailyPrimaryArxivBindings = value.dailyPrimaryArxivBindings.map((binding, index) => {
        let normalized;
        try { normalized = dailyPrimaryArxiv.normalize(binding); }
        catch (error) { fail(`daily primary arXiv binding ${index} is invalid: ${error.message}`); }
        if (bindingPageKeys.has(normalized.pageKey)) fail('daily primary arXiv bindings duplicate a frozen page');
        bindingPageKeys.add(normalized.pageKey); return normalized;
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    if (value.dailyPrimaryArxivBindings.some((binding, index) => binding.pageKey !== dailyPrimaryArxivBindings[index].pageKey)
        || stableHash(dailyPrimaryArxivBindings) !== value.dailyPrimaryArxivBindingSetSha256) {
        fail('daily primary arXiv binding set drifted');
    }
    if (value.inputs.length !== 1 || !plain(value.inputs[0]) || typeof value.inputs[0].path !== 'string'
        || !path.isAbsolute(value.inputs[0].path) || !validSha(value.inputs[0].sha256)
        || !Number.isSafeInteger(value.inputs[0].selectedPapers) || value.inputs[0].selectedPapers < 0) {
        fail('catalog approved conference input descriptor is malformed');
    }
    const paperIds = new Set(); let arxivPapers = 0; let conferencePapers = 0; let arxivPages = 0; const sourceSets = {};
    const entries = value.entries.map((entry, index) => {
        exact(entry, ['paperId', 'sources'], `catalog.entries[${index}]`);
        if (typeof entry.paperId !== 'string' || !Array.isArray(entry.sources) || paperIds.has(entry.paperId)) {
            fail('catalog entry is malformed or duplicated');
        }
        paperIds.add(entry.paperId);
        if (entry.paperId.startsWith('arxiv:')) {
            if (!ARXIV_ID_RE.test(entry.paperId.slice(6)) || entry.sources.length !== 0) {
                fail('catalog arXiv entry must have an ID and no retained local source');
            }
            arxivPapers += 1; return { paperId: entry.paperId, sources: [] };
        }
        if (!entry.paperId.startsWith('conference:') || entry.sources.length !== 1) fail('catalog conference entry is malformed');
        conferencePapers += 1;
        const source = entry.sources[0];
        if (!plain(source) || typeof source.sourceSet !== 'string' || !source.sourceSet || typeof source.provenance !== 'string'
            || !source.provenance || !plain(source.metadata) || !plain(source.pdf) || source.pdf.availability !== 'available'
            || typeof source.pdf.absolutePath !== 'string' || !path.isAbsolute(source.pdf.absolutePath) || !validSha(source.pdf.sha256)
            || typeof source.metadata.absolutePath !== 'string' || !path.isAbsolute(source.metadata.absolutePath)
            || !validSha(source.metadata.sha256) || !Number.isSafeInteger(source.metadata.recordIndex)
            || source.metadata.recordIndex < 0 || !validSha(source.metadata.metadataIdentityBindingSha256)) {
            fail('catalog conference source is malformed');
        }
        sourceSets[source.sourceSet] = (sourceSets[source.sourceSet] || 0) + 1;
        return { paperId: entry.paperId, sources: [{ sourceSet: source.sourceSet, provenance: source.provenance,
            metadata: clone(source.metadata), pdf: clone(source.pdf) }] };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (value.entries.some((entry, index) => entry.paperId !== entries[index].paperId)) fail('catalog entries are unordered');
    arxivPages = value.scopeBinding.arxivPageCount;
    const expectedSummary = { arxivPapers, arxivPages, singleArxivPages: value.scopeBinding.singleArxivPageCount,
        dailyPrimaryArxivBindings: dailyPrimaryArxivBindings.length,
        conferencePapers, canonicalRecords: entries.length,
        sourceRecords: conferencePapers,
        conferenceSourceSets: Object.fromEntries(Object.entries(sourceSets).sort(([left], [right]) => left.localeCompare(right))) };
    if (JSON.stringify(canonical(value.summary)) !== JSON.stringify(canonical(expectedSummary))) fail('catalog summary drifted');
    const arxivPaperIds = new Set(entries.filter(entry => entry.paperId.startsWith('arxiv:')).map(entry => entry.paperId));
    if (dailyPrimaryArxivBindings.some(binding => !arxivPaperIds.has(`arxiv:${binding.arxivId}`))
        || value.inputs[0].selectedPapers !== conferencePapers || value.scopeBinding.conferencePageCount < conferencePapers
        || value.scopeBinding.arxivPageCount < arxivPapers
        || value.scopeBinding.dailyPrimaryArxivBindingCount !== dailyPrimaryArxivBindings.length
        || value.scopeBinding.arxivPageCount !== value.scopeBinding.singleArxivPageCount + dailyPrimaryArxivBindings.length) {
        fail('catalog scope counts drifted');
    }
    return { contract: CONTRACT, version: VERSION, scope: SCOPE, scopeBinding: clone(value.scopeBinding),
        inputs: [clone(value.inputs[0])], summary: expectedSummary, dailyPrimaryArxivBindings,
        dailyPrimaryArxivBindingSetSha256: value.dailyPrimaryArxivBindingSetSha256, entries };
}

function safeDirectory(directory, label, create = false) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory);
    if (!fs.existsSync(absolute)) {
        if (!create) fail(`${label} does not exist`);
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function writeCatalog({ catalogRoot, name, catalog } = {}) {
    if (!SAFE_NAME_RE.test(String(name || ''))) fail('catalog name is unsafe');
    const root = safeDirectory(catalogRoot, 'catalogRoot', true); const normalized = normalizeCatalog(catalog);
    const filename = path.join(root, name); const bytes = prettyBytes(normalized); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, catalog: normalized };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = projectionApi.readStableFile(filename, 'existing direct v4 catalog');
        if (!existing.bytes.equals(bytes)) fail(`refuses to overwrite a different scoped local input catalog: ${name}`);
        return { status: 'recovered', filename, catalog: normalized };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildAndWrite(options, overrides = {}) {
    if (!options || typeof options.conferenceManifest !== 'string' || typeof options.inventoryFile !== 'string'
        || typeof options.blogRoot !== 'string') {
        fail('approved conference manifest, frozen inventory, and blog root are required');
    }
    const files = overrides.files || require('../config.js').FILES;
    const catalog = buildScopedCatalog(options);
    const result = { status: options.apply ? null : 'dry-run', paperCount: catalog.summary.canonicalRecords,
        arxivPaperCount: catalog.summary.arxivPapers, arxivPageCount: catalog.summary.arxivPages,
        conferencePaperCount: catalog.summary.conferencePapers, localInputCount: catalog.summary.sourceRecords,
        conferencePageCount: catalog.scopeBinding.conferencePageCount,
        dailyPrimaryArxivBindingCount: catalog.scopeBinding.dailyPrimaryArxivBindingCount, catalog };
    if (!options.apply) return result;
    const written = writeCatalog({ catalogRoot: files.historicalDirectRewriteInputCatalogDir, name: options.name, catalog });
    return { ...result, status: written.status, filename: written.filename };
}

module.exports = { CONTRACT, VERSION, SCOPE, SAFE_NAME_RE, HistoricalDirectRewriteInputCatalogError, stableHash, prettyBytes,
    dailyPrimaryArxivBindingsFromFrozenInventory, arxivEntriesFromFrozenInventory, scopeConferenceEntries,
    buildScopedCatalog, normalizeCatalog, writeCatalog, buildAndWrite };
