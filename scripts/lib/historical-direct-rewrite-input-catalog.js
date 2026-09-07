'use strict';

// Builds the scoped v5 catalog for direct historical rewriting. It consumes
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
const icmlPosterApi = require('./historical-icml-poster-authority.js');
const alternatePdfApi = require('./historical-icml-alternate-pdf-source.js');

const CONTRACT = 'merged-good-historical-local-data-v5';
const VERSION = 5;
const SCOPE = 'historical-corresponding-local-sources-only';
const SHA_RE = /^[a-f0-9]{64}$/;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const BLOCKED_CROSS_VERSION_RELATION = 'author-prior-preprint-with-different-title';
const AUTHORIZED_PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const PRIOR_PREPRINT_DISCLOSURE_CONTRACT = 'historical-author-prior-preprint-disclosure-v1';

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
function authorizedPriorPreprintProfile(source, paperId) {
    if (paperId !== AUTHORIZED_PRIOR_PREPRINT_PAPER_ID
        || source?.sourceSet !== 'workspace-icml-official-poster-2026'
        || source?.pdf?.availability !== 'available') return null;
    let profile;
    try { profile = alternatePdfApi.profileForForum('n1mAjfRDZ6'); } catch { return null; }
    const acquisition = source.pdf.acquisition; const poster = source.metadata?.posterBinding;
    if (!plain(acquisition) || !plain(acquisition.receipt)
        || !path.isAbsolute(String(acquisition.receipt.absolutePath || ''))
        || !validSha(acquisition.receipt.fileSha256) || !validSha(acquisition.receipt.selfSha256)
        || acquisition.sourceKind !== profile.sourceKind
        || acquisition.versionRelation !== BLOCKED_CROSS_VERSION_RELATION
        || acquisition.sourceTitle !== profile.sourceTitle
        || stableHash(acquisition.sourceAuthors) !== stableHash(profile.sourceAuthors)
        || acquisition.sourceDoi !== profile.sourceDoi
        || acquisition.provenanceStatement !== profile.provenanceStatement
        || acquisition.openreviewResponseBytes !== false
        || poster?.posterId !== profile.posterId
        || poster?.openreviewUrl !== `https://openreview.net/forum?id=${profile.forumId}`
        || !validSha(source.sourceBindingSha256)) return null;
    return profile;
}

const directEligibleConferenceSource = (source, paperId = null) => source?.pdf?.availability === 'available'
    && (source.pdf.acquisition?.versionRelation !== BLOCKED_CROSS_VERSION_RELATION
        || authorizedPriorPreprintProfile(source, paperId) !== null);

function priorPreprintSourceDisclosure(source, paperId) {
    if (source?.pdf?.acquisition?.versionRelation !== BLOCKED_CROSS_VERSION_RELATION) return null;
    const profile = authorizedPriorPreprintProfile(source, paperId);
    if (!profile) fail('cross-version prior preprint is not the code-reviewed exception');
    const body = { contract: PRIOR_PREPRINT_DISCLOSURE_CONTRACT, version: 1, paperId,
        icmlTitle: profile.title, preprintTitle: profile.sourceTitle, doi: profile.sourceDoi,
        versionRelation: profile.versionRelation, sourceKind: profile.sourceKind,
        receiptSelfSha256: source.pdf.acquisition.receipt.selfSha256,
        sourceBindingSha256: source.sourceBindingSha256, cameraReady: false,
        openreviewResponseBytes: false,
        statement: 'This input is an author prior preprint with a different title; it is neither the ICML camera-ready paper nor OpenReview response bytes.' };
    return { ...body, disclosureSha256: stableHash(body) };
}

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
        metadata: clone(source.metadata), pdf: clone(source.pdf), sourceBindingSha256: source.sourceBindingSha256 };
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
        // Poster-snapshot records prove daily-page identity, but their `name`
        // field is not the retained title authority for the 1,302 conference
        // pages.  Keep that evidence path exclusively on the earlier deep
        // crawler/accepted snapshots.
        const titleSources = record.sources.filter(source => source.sourceSet !== 'workspace-icml-official-poster-2026');
        try { sources = projectionApi.selectConferenceSources({ paperId: record.paperId, sources: clone(titleSources) }, sourceCache); }
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

function dailyIcmlPosterEntries({ conferenceManifest, inventory, blogRoot } = {}) {
    const posterSources = new Map(); let snapshotFile = null; let authoritySha256 = null;
    for (const record of conferenceManifest.records) for (const source of record.sources) {
        const poster = source.metadata?.posterBinding;
        if (!poster) continue;
        if (source.sourceSet !== 'workspace-icml-official-poster-2026') fail('ICML poster binding uses an unexpected source set');
        if (snapshotFile !== null && snapshotFile !== source.metadata.absolutePath) fail('ICML poster sources use multiple authority snapshots');
        if (authoritySha256 !== null && authoritySha256 !== poster.authoritySha256) fail('ICML poster sources use multiple authority SHAs');
        snapshotFile = source.metadata.absolutePath; authoritySha256 = poster.authoritySha256;
        if (posterSources.has(record.paperId)) fail(`duplicate ICML poster source for ${record.paperId}`);
        posterSources.set(record.paperId, clone(source));
    }
    if (snapshotFile === null) return { entries: [], bindings: [], routableBindings: [], authoritySha256: null };
    const handle = icmlPosterApi.loadPosterAuthority({ snapshotFile });
    const authority = icmlPosterApi.authorityHandleSnapshot(handle);
    if (authority.authoritySha256 !== authoritySha256) fail('ICML poster source authority SHA does not replay');
    const history = projectionApi.normalizeInventory(inventory);
    const summaries = new Map(inventory.pages.filter(page => page?.kind === 'daily-summary')
        .map(page => [page.scope?.key, page]));
    const bindings = [];
    for (const page of history.pages) {
        if (page.scope.type !== 'daily' || page.identityHints?.status !== 'none') continue;
        let binding;
        try { binding = icmlPosterApi.bindDailyPage({ authorityHandle: handle, blogRoot, page,
            summaryPage: summaries.get(page.scope.key) || null }); }
        catch (error) {
            if (error?.code === 'HISTORICAL_ICML_POSTER_AUTHORITY_INTEGRITY') continue;
            throw error;
        }
        bindings.push(icmlPosterApi.normalizeDailyPageBinding(binding));
    }
    bindings.sort((left, right) => left.page.pageKey.localeCompare(right.page.pageKey));
    const entriesByPaperId = new Map();
    for (const binding of bindings) {
        const paperId = `conference:icml:2026:openreview-forum-id:${binding.poster.forumId}`;
        const source = posterSources.get(paperId);
        if (directEligibleConferenceSource(source, paperId)) {
            entriesByPaperId.set(paperId, { paperId, sources: [clone(source)] });
        }
    }
    const routableBindings = bindings.filter(binding => entriesByPaperId.has(
        `conference:icml:2026:openreview-forum-id:${binding.poster.forumId}`));
    return { entries: [...entriesByPaperId.values()].sort((a, b) => a.paperId.localeCompare(b.paperId)),
        bindings, routableBindings, authoritySha256 };
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
    const dailyIcml = dailyIcmlPosterEntries({ conferenceManifest: conference.value, inventory: inventory.value, blogRoot });
    const conferenceById = new Map(scopedConference.entries.map(entry => [entry.paperId, entry]));
    // Keep the title-bound retained source for canonicals that already own a
    // frozen conference page.  The independently sealed poster binding proves
    // the daily projection; replacing the writer source with miniconf metadata
    // would make the 1,302 conference-title projections depend on record.name.
    for (const entry of dailyIcml.entries) if (!conferenceById.has(entry.paperId)) conferenceById.set(entry.paperId, entry);
    const conferenceEntries = [...conferenceById.values()].sort((a, b) => a.paperId.localeCompare(b.paperId));
    const entries = [...arxiv.entries, ...conferenceEntries].sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(entries.map(entry => entry.paperId)).size !== entries.length) fail('scoped local inputs duplicate a canonical paper ID');
    const sourceSets = {};
    for (const entry of conferenceEntries) for (const source of entry.sources) {
        sourceSets[source.sourceSet] = (sourceSets[source.sourceSet] || 0) + 1;
    }
    const summary = { arxivPapers: arxiv.entries.length, arxivPages: arxiv.pageCount,
        singleArxivPages: arxiv.singlePageCount, dailyPrimaryArxivBindings: arxiv.bindingPageCount,
        dailyIcmlPosterBindings: dailyIcml.bindings.length,
        dailyIcmlPosterRoutableBindings: dailyIcml.routableBindings.length,
        conferencePapers: conferenceEntries.length, canonicalRecords: entries.length,
        sourceRecords: conferenceEntries.length,
        conferenceSourceSets: Object.fromEntries(Object.entries(sourceSets).sort(([left], [right]) => left.localeCompare(right))) };
    return { contract: CONTRACT, version: VERSION, scope: SCOPE,
        scopeBinding: { inventoryPath: inventory.filename, inventorySha256: inventory.fileSha256,
            inventoryLedgerSha256: normalizedInventory.ledgerSha256, inventoryPageSetSha256: normalizedInventory.pageSetSha256,
            arxivPageCount: arxiv.pageCount, singleArxivPageCount: arxiv.singlePageCount,
            dailyPrimaryArxivBindingCount: arxiv.bindingPageCount,
            dailyIcmlPosterBindingCount: dailyIcml.bindings.length,
            dailyIcmlPosterRoutableBindingCount: dailyIcml.routableBindings.length,
            conferencePageCount: scopedConference.conferencePageCount },
        inputs: [inputDescriptor(conference, conferenceEntries.length)], summary,
        dailyPrimaryArxivBindings, dailyPrimaryArxivBindingSetSha256: stableHash(dailyPrimaryArxivBindings),
        dailyIcmlPosterBindings: dailyIcml.bindings,
        dailyIcmlPosterBindingSetSha256: stableHash(dailyIcml.bindings),
        dailyIcmlPosterRoutableBindings: dailyIcml.routableBindings,
        dailyIcmlPosterRoutableBindingSetSha256: stableHash(dailyIcml.routableBindings),
        icmlPosterAuthoritySha256: dailyIcml.authoritySha256, entries };
}

function normalizeCatalog(value) {
    if (!plain(value) || value.contract !== CONTRACT || value.version !== VERSION || value.scope !== SCOPE
        || !plain(value.scopeBinding) || !Array.isArray(value.inputs) || !plain(value.summary) || !Array.isArray(value.entries)) {
        fail('scoped v5 direct rewrite catalog contract is invalid');
    }
    exact(value, ['contract', 'version', 'scope', 'scopeBinding', 'inputs', 'summary', 'dailyPrimaryArxivBindings',
        'dailyPrimaryArxivBindingSetSha256', 'dailyIcmlPosterBindings', 'dailyIcmlPosterBindingSetSha256',
        'dailyIcmlPosterRoutableBindings', 'dailyIcmlPosterRoutableBindingSetSha256',
        'icmlPosterAuthoritySha256', 'entries'], 'scoped v5 direct rewrite catalog');
    exact(value.scopeBinding, ['inventoryPath', 'inventorySha256', 'inventoryLedgerSha256', 'inventoryPageSetSha256',
        'arxivPageCount', 'singleArxivPageCount', 'dailyPrimaryArxivBindingCount', 'dailyIcmlPosterBindingCount',
        'dailyIcmlPosterRoutableBindingCount', 'conferencePageCount'], 'catalog scope binding');
    if (typeof value.scopeBinding.inventoryPath !== 'string' || !path.isAbsolute(value.scopeBinding.inventoryPath)
        || !validSha(value.scopeBinding.inventorySha256) || !validSha(value.scopeBinding.inventoryLedgerSha256)
        || !validSha(value.scopeBinding.inventoryPageSetSha256) || !Number.isSafeInteger(value.scopeBinding.arxivPageCount)
        || value.scopeBinding.arxivPageCount < 0 || !Number.isSafeInteger(value.scopeBinding.singleArxivPageCount)
        || value.scopeBinding.singleArxivPageCount < 0 || !Number.isSafeInteger(value.scopeBinding.dailyPrimaryArxivBindingCount)
        || value.scopeBinding.dailyPrimaryArxivBindingCount < 0 || !Number.isSafeInteger(value.scopeBinding.dailyIcmlPosterBindingCount)
        || value.scopeBinding.dailyIcmlPosterBindingCount < 0 || !Number.isSafeInteger(value.scopeBinding.dailyIcmlPosterRoutableBindingCount)
        || value.scopeBinding.dailyIcmlPosterRoutableBindingCount < 0 || !Number.isSafeInteger(value.scopeBinding.conferencePageCount)
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
    if (!Array.isArray(value.dailyIcmlPosterBindings) || !validSha(value.dailyIcmlPosterBindingSetSha256)
        || !(value.icmlPosterAuthoritySha256 === null || validSha(value.icmlPosterAuthoritySha256))) {
        fail('daily ICML poster binding set is malformed');
    }
    const icmlPageKeys = new Set(); const dailyIcmlPosterBindings = value.dailyIcmlPosterBindings.map((binding, index) => {
        let normalized;
        try { normalized = icmlPosterApi.normalizeDailyPageBinding(binding); }
        catch (error) { fail(`daily ICML poster binding ${index} is invalid: ${error.message}`); }
        if (icmlPageKeys.has(normalized.page.pageKey) || normalized.poster.authoritySha256 !== value.icmlPosterAuthoritySha256) {
            fail('daily ICML poster bindings duplicate a page or authority');
        }
        icmlPageKeys.add(normalized.page.pageKey); return normalized;
    }).sort((left, right) => left.page.pageKey.localeCompare(right.page.pageKey));
    if (value.dailyIcmlPosterBindings.some((binding, index) => binding.page.pageKey !== dailyIcmlPosterBindings[index].page.pageKey)
        || stableHash(dailyIcmlPosterBindings) !== value.dailyIcmlPosterBindingSetSha256
        || (dailyIcmlPosterBindings.length > 0 && value.icmlPosterAuthoritySha256 === null)) {
        fail('daily ICML poster binding set drifted');
    }
    if (!Array.isArray(value.dailyIcmlPosterRoutableBindings)
        || !validSha(value.dailyIcmlPosterRoutableBindingSetSha256)) {
        fail('daily ICML routable poster binding set is malformed');
    }
    const allIcmlBindingsByPage = new Map(dailyIcmlPosterBindings.map(binding => [binding.page.pageKey, binding]));
    const routablePageKeys = new Set();
    const dailyIcmlPosterRoutableBindings = value.dailyIcmlPosterRoutableBindings.map((binding, index) => {
        let normalized;
        try { normalized = icmlPosterApi.normalizeDailyPageBinding(binding); }
        catch (error) { fail(`daily ICML routable poster binding ${index} is invalid: ${error.message}`); }
        const sealed = allIcmlBindingsByPage.get(normalized.page.pageKey);
        if (!sealed || stableHash(sealed) !== stableHash(normalized) || routablePageKeys.has(normalized.page.pageKey)) {
            fail('daily ICML routable poster bindings are not a unique subset of sealed bindings');
        }
        routablePageKeys.add(normalized.page.pageKey); return normalized;
    }).sort((left, right) => left.page.pageKey.localeCompare(right.page.pageKey));
    if (value.dailyIcmlPosterRoutableBindings.some((binding, index) =>
        binding.page.pageKey !== dailyIcmlPosterRoutableBindings[index].page.pageKey)
        || stableHash(dailyIcmlPosterRoutableBindings) !== value.dailyIcmlPosterRoutableBindingSetSha256) {
        fail('daily ICML routable poster binding set drifted');
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
        let source;
        try { source = conferenceManifestApi.validateSource(entry.sources[0], entry.paperId); }
        catch (error) { fail(`catalog conference source binding is invalid: ${error.message}`); }
        if (!directEligibleConferenceSource(source, entry.paperId)) {
            fail('cross-version prior preprint is not an authorized direct writer route');
        }
        sourceSets[source.sourceSet] = (sourceSets[source.sourceSet] || 0) + 1;
        return { paperId: entry.paperId, sources: [{ sourceSet: source.sourceSet, provenance: source.provenance,
            metadata: clone(source.metadata), pdf: clone(source.pdf), sourceBindingSha256: source.sourceBindingSha256 }] };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (value.entries.some((entry, index) => entry.paperId !== entries[index].paperId)) fail('catalog entries are unordered');
    arxivPages = value.scopeBinding.arxivPageCount;
    const expectedSummary = { arxivPapers, arxivPages, singleArxivPages: value.scopeBinding.singleArxivPageCount,
        dailyPrimaryArxivBindings: dailyPrimaryArxivBindings.length,
        dailyIcmlPosterBindings: dailyIcmlPosterBindings.length,
        dailyIcmlPosterRoutableBindings: value.scopeBinding.dailyIcmlPosterRoutableBindingCount,
        conferencePapers, canonicalRecords: entries.length,
        sourceRecords: conferencePapers,
        conferenceSourceSets: Object.fromEntries(Object.entries(sourceSets).sort(([left], [right]) => left.localeCompare(right))) };
    if (JSON.stringify(canonical(value.summary)) !== JSON.stringify(canonical(expectedSummary))) fail('catalog summary drifted');
    const arxivPaperIds = new Set(entries.filter(entry => entry.paperId.startsWith('arxiv:')).map(entry => entry.paperId));
    const conferencePaperIds = new Set(entries.filter(entry => entry.paperId.startsWith('conference:')).map(entry => entry.paperId));
    const expectedIcmlRoutableBindings = dailyIcmlPosterRoutableBindings.filter(binding => conferencePaperIds.has(
        `conference:icml:2026:openreview-forum-id:${binding.poster.forumId}`)).length;
    if (dailyPrimaryArxivBindings.some(binding => !arxivPaperIds.has(`arxiv:${binding.arxivId}`))
        || value.inputs[0].selectedPapers !== conferencePapers || value.scopeBinding.conferencePageCount < conferencePapers
        || value.scopeBinding.arxivPageCount < arxivPapers
        || value.scopeBinding.dailyPrimaryArxivBindingCount !== dailyPrimaryArxivBindings.length
        || value.scopeBinding.dailyIcmlPosterBindingCount !== dailyIcmlPosterBindings.length
        || value.scopeBinding.dailyIcmlPosterRoutableBindingCount !== expectedIcmlRoutableBindings
        || value.scopeBinding.arxivPageCount !== value.scopeBinding.singleArxivPageCount + dailyPrimaryArxivBindings.length) {
        fail('catalog scope counts drifted');
    }
    return { contract: CONTRACT, version: VERSION, scope: SCOPE, scopeBinding: clone(value.scopeBinding),
        inputs: [clone(value.inputs[0])], summary: expectedSummary, dailyPrimaryArxivBindings,
        dailyPrimaryArxivBindingSetSha256: value.dailyPrimaryArxivBindingSetSha256,
        dailyIcmlPosterBindings, dailyIcmlPosterBindingSetSha256: value.dailyIcmlPosterBindingSetSha256,
        dailyIcmlPosterRoutableBindings,
        dailyIcmlPosterRoutableBindingSetSha256: value.dailyIcmlPosterRoutableBindingSetSha256,
        icmlPosterAuthoritySha256: value.icmlPosterAuthoritySha256, entries };
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
        const existing = projectionApi.readStableFile(filename, 'existing direct v5 catalog');
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
        dailyPrimaryArxivBindingCount: catalog.scopeBinding.dailyPrimaryArxivBindingCount,
        dailyIcmlPosterBindingCount: catalog.scopeBinding.dailyIcmlPosterBindingCount, catalog };
    if (!options.apply) return result;
    const written = writeCatalog({ catalogRoot: files.historicalDirectRewriteInputCatalogDir, name: options.name, catalog });
    return { ...result, status: written.status, filename: written.filename };
}

module.exports = { CONTRACT, VERSION, SCOPE, SAFE_NAME_RE, BLOCKED_CROSS_VERSION_RELATION,
    AUTHORIZED_PRIOR_PREPRINT_PAPER_ID, PRIOR_PREPRINT_DISCLOSURE_CONTRACT,
    HistoricalDirectRewriteInputCatalogError, stableHash, prettyBytes, directEligibleConferenceSource,
    priorPreprintSourceDisclosure,
    dailyPrimaryArxivBindingsFromFrozenInventory, dailyIcmlPosterEntries, arxivEntriesFromFrozenInventory, scopeConferenceEntries,
    buildScopedCatalog, normalizeCatalog, writeCatalog, buildAndWrite };
