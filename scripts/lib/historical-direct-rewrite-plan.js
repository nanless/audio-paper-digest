'use strict';

// Deterministic routing plan for the user-approved retained local inputs.
// This is intentionally a planner/registry boundary: it neither calls an
// LLM, fetches arXiv, reads a historical blog body, nor mutates a crosswalk.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const conferenceProjections = require('./historical-conference-page-projections.js');

const CONTRACT = 'historical-direct-rewrite-plan-v3';
const VERSION = 3;
const CATALOG_CONTRACT = 'merged-good-historical-local-data-v3';
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const ARXIV_FRESH_FAILURE_HANDOFF_CONTRACT = 'historical-arxiv-fresh-failure-crosswalk-handoff-v1';
const ARXIV_FRESH_FAILURE_HANDOFF_VERSION = 1;
const ARXIV_FRESH_FAILURE_HANDOFF_PREFIX = 'arxiv-fresh-failure-';
const UNPROJECTED_REPORT_CONTRACT = 'historical-direct-rewrite-unprojected-catalog-report-v1';
const UNPROJECTED_REPORT_VERSION = 1;
const UNPROJECTED_REPORT_PREFIX = 'direct-rewrite-unprojected-';

class HistoricalDirectRewritePlanError extends Error {
    constructor(message) {
        super(`Historical direct rewrite plan rejected: ${message}`);
        this.name = 'HistoricalDirectRewritePlanError';
        this.code = 'HISTORICAL_DIRECT_REWRITE_PLAN_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalDirectRewritePlanError(message); };
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
const validSha = value => SHA_RE.test(String(value || ''));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function deterministicRunId(catalogFileSha256, paperId) {
    if (!validSha(catalogFileSha256) || typeof paperId !== 'string' || !paperId) fail('catalog SHA and paper ID are required');
    const bytes = Buffer.from(sha256(`${CONTRACT}\0${catalogFileSha256}\0${paperId}`).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeCurrentCatalog(value) {
    // The producer owns the complete current v3 contract.  Do not maintain a
    // second, weaker validator here: legacy v3 collector files used the same
    // headline version while allowing retained arXiv prose/PDF inputs.
    try {
        return require('./historical-direct-rewrite-input-catalog.js').normalizeCatalog(value);
    } catch (error) {
        fail(`current scoped v3 local source catalog is invalid: ${error.message}`);
    }
}

function normalizeCatalog(value) { return normalizeCurrentCatalog(value).entries; }

function normalizeInventory(value) {
    if (!plain(value) || !Array.isArray(value.pages) || !validSha(value.pageSetSha256)
        || !validSha(value.ledgerSha256)) fail('historical inventory contract is invalid');
    const seen = new Set();
    const pages = value.pages.filter(page => page?.kind === 'paper').map((page, index) => {
        if (!PAGE_KEY_RE.test(String(page.pageId || '')) || typeof page.path !== 'string' || !page.path
            || !validSha(page.contentSha256) || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || typeof page.cohortDate !== 'string'
            || !plain(page.identityHints) || !Array.isArray(page.identityHints.candidates)
            || seen.has(page.pageId)) fail(`inventory paper page ${index} is malformed`);
        seen.add(page.pageId);
        return { pageKey: page.pageId, pagePath: page.path, pageContentSha256: page.contentSha256,
            primaryUrl: typeof page.primaryUrl === 'string' ? page.primaryUrl : null,
            cohortDate: page.cohortDate, scope: clone(page.scope), identityHints: clone(page.identityHints) };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { ledgerSha256: value.ledgerSha256, pageSetSha256: value.pageSetSha256, pages };
}

function arxivPageProjections(inventory, knownPaperIds) {
    const byPaperId = new Map();
    for (const page of inventory.pages) {
        const hints = page.identityHints;
        if (hints.status !== 'single' || !Array.isArray(hints.candidates) || hints.candidates.length !== 1) continue;
        const hint = hints.candidates[0];
        if (hint?.scheme !== 'arxiv' || !ARXIV_ID_RE.test(String(hint.value || ''))) continue;
        const arxivId = String(hint.value || ''); const paperId = `arxiv:${arxivId}`;
        if (!knownPaperIds.has(paperId)) continue;
        if (!Array.isArray(hint.sources) || !hint.sources.length || hint.sources.some(value => typeof value !== 'string' || !value)
            || new Set(hint.sources).size !== hint.sources.length) {
            fail(`${page.pageKey} frozen arXiv identity hint has no exact source mapping`);
        }
        const historicalArxivLink = { arxivId, canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
            hintSources: hint.sources.slice().sort() };
        const values = byPaperId.get(paperId) || [];
        values.push({ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: page.cohortDate, scope: page.scope, pageContentSha256: page.pageContentSha256,
            mapping: 'frozen-single-arxiv-identity-hint', historicalArxivLink });
        byPaperId.set(paperId, values);
    }
    for (const pages of byPaperId.values()) pages.sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return byPaperId;
}

function sourceRoute(entry) {
    if (entry.paperId.startsWith('arxiv:')) {
        const arxivId = entry.paperId.slice(6);
        // No local TXT/PDF/crawler record is copied here.  The runner must
        // freshly fetch the official text and PDF, then keep only temporary
        // figure pixels for that run.
        return { kind: 'arxiv-fresh-fetch', arxivId, writerInputs: [],
            freshFetch: { authority: 'official-arxiv', requiredArtifacts: ['text', 'pdf'],
                persistArtifacts: ['text', 'pdf'], imagePersistence: 'ephemeral-only' },
            failurePolicy: { kind: 'crosswalk-arxiv-fresh-fetch-failure-only',
                crosswalkPrerequisite: false, historicalLinkUse: 'only-after-fresh-fetch-failure' } };
    }
    const sources = entry.sources.filter(source => plain(source) && plain(source.metadata) && plain(source.pdf)
        && source.pdf.availability === 'available' && validSha(source.pdf.sha256)
        && typeof source.pdf.absolutePath === 'string' && path.isAbsolute(source.pdf.absolutePath)
        && typeof source.metadata.absolutePath === 'string' && path.isAbsolute(source.metadata.absolutePath)
        && validSha(source.metadata.sha256) && Number.isSafeInteger(source.metadata.recordIndex)
        && source.metadata.recordIndex >= 0 && validSha(source.metadata.metadataIdentityBindingSha256))
        .map(source => ({ sourceSet: String(source.sourceSet || ''), provenance: String(source.provenance || ''),
            metadata: clone(source.metadata), pdf: clone(source.pdf) }))
        .sort((left, right) => stableHash(left).localeCompare(stableHash(right)));
    if (!sources.length) fail(`${entry.paperId} does not have a usable local conference PDF`);
    return { kind: 'conference-local-pdf', writerInputs: sources,
        failurePolicy: { kind: 'local-conference-source-failure', crosswalkPrerequisite: false,
            historicalLinkUse: 'never' } };
}

function normalizeHistoricalArxivLink(value, expectedArxivId) {
    exact(value, ['arxivId', 'canonicalUrl', 'hintSources'], 'frozen historical arXiv link');
    if (!ARXIV_ID_RE.test(String(value.arxivId || '')) || value.arxivId !== expectedArxivId
        || value.canonicalUrl !== `https://arxiv.org/abs/${expectedArxivId}` || !Array.isArray(value.hintSources)
        || !value.hintSources.length || value.hintSources.some(source => typeof source !== 'string' || !source)
        || new Set(value.hintSources).size !== value.hintSources.length
        || value.hintSources.join('\0') !== value.hintSources.slice().sort().join('\0')) {
        fail('frozen historical arXiv link is malformed');
    }
    return { arxivId: value.arxivId, canonicalUrl: value.canonicalUrl, hintSources: value.hintSources.slice() };
}

function normalizedConferenceProjections(value, { catalogFileSha256, inventory }) {
    const artifact = conferenceProjections.normalizeProjectionArtifact(value);
    if (artifact.catalogFileSha256 !== catalogFileSha256 || artifact.inventory.ledgerSha256 !== inventory.ledgerSha256
        || artifact.inventory.pageSetSha256 !== inventory.pageSetSha256) {
        fail('conference page projection artifact is bound to a different catalog or inventory');
    }
    if (artifact.unmatchedPages.length) {
        fail(`conference page projection artifact leaves ${artifact.unmatchedPages.length} historical conference pages unresolved`);
    }
    return artifact;
}

const IDENTITY_HINT_STATUSES = new Set(['none', 'single', 'conflict', 'multiple']);
function uncoveredPageRecord(page) {
    const identityHintStatus = page.identityHints?.status;
    if (!IDENTITY_HINT_STATUSES.has(identityHintStatus)) {
        fail(`${page.pageKey} frozen paper identity hint status is invalid`);
    }
    return { pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
        cohortDate: page.cohortDate, scope: clone(page.scope), pageContentSha256: page.pageContentSha256,
        identityHintStatus, reason: 'no-direct-source-route' };
}

function countBy(values, keyFor) {
    const counts = new Map();
    for (const value of values) {
        const key = keyFor(value); counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => ({ key, count }));
}

function coverageSummary(projectedPages, uncoveredPages) {
    const all = [...projectedPages.map(page => ({ scope: page.scope, projected: true })),
        ...uncoveredPages.map(page => ({ scope: page.scope, projected: false }))];
    const scopeKeys = [...new Set(all.map(page => `${page.scope.type}\0${page.scope.key}`))].sort();
    const byScope = scopeKeys.map(scopeKey => {
        const [scopeType, scopeKeyValue] = scopeKey.split('\0');
        const selected = all.filter(page => page.scope.type === scopeType && page.scope.key === scopeKeyValue);
        const projected = selected.filter(page => page.projected).length;
        return { scope: { type: scopeType, key: scopeKeyValue }, frozenPaperPages: selected.length,
            projectedPaperPages: projected, uncoveredFrozenPaperPages: selected.length - projected };
    });
    return { frozenPaperPages: all.length, projectedPaperPages: projectedPages.length,
        uncoveredFrozenPaperPages: uncoveredPages.length, coverageComplete: uncoveredPages.length === 0,
        byScope, uncoveredByIdentityHintStatus: countBy(uncoveredPages, page => page.identityHintStatus)
            .map(item => ({ status: item.key, count: item.count })) };
}

function buildDirectRewritePlan({ catalog, catalogFileSha256, inventory, conferencePageProjections } = {}) {
    if (!validSha(catalogFileSha256)) fail('catalog file SHA is required');
    const currentCatalog = normalizeCurrentCatalog(catalog); const entries = currentCatalog.entries;
    const history = normalizeInventory(inventory);
    if (currentCatalog.scopeBinding.inventoryLedgerSha256 !== history.ledgerSha256
        || currentCatalog.scopeBinding.inventoryPageSetSha256 !== history.pageSetSha256) {
        fail('current scoped v3 catalog belongs to a different frozen inventory');
    }
    const conferenceArtifact = normalizedConferenceProjections(conferencePageProjections, {
        catalogFileSha256, inventory: history
    });
    const conferenceByPaperId = new Map(conferenceArtifact.projections.map(item => [item.paperId, item]));
    const knownArxiv = new Set(entries.filter(item => item.paperId.startsWith('arxiv:')).map(item => item.paperId));
    const arxivByPaperId = arxivPageProjections(history, knownArxiv);
    const allPageKeys = new Set(); const queue = []; const unprojectedCatalogEntries = [];
    for (const entry of entries) {
        const route = sourceRoute(entry); const isArxiv = route.kind === 'arxiv-fresh-fetch';
        const projected = isArxiv ? arxivByPaperId.get(entry.paperId) || []
            : conferenceByPaperId.get(entry.paperId)?.pages || [];
        if (!projected.length) {
            // Retained local material with no frozen historical page is an
            // audit item, not a candidate for a fresh source request, a
            // crosswalk mutation, or an LLM run.  It stays outside `queue`.
            unprojectedCatalogEntries.push({ paperId: entry.paperId, route: route.kind,
                reason: 'no-frozen-historical-page-projection' });
            continue;
        }
        const pages = projected.map(page => ({ pageKey: page.pageKey, pagePath: page.pagePath,
            primaryUrl: page.primaryUrl || null, cohortDate: page.cohortDate,
            scope: clone(page.scope), pageContentSha256: page.pageContentSha256,
            mapping: page.mapping || 'retained-local-title-fingerprint',
            historicalArxivLink: page.historicalArxivLink ? clone(page.historicalArxivLink) : null }))
            .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        for (const page of pages) {
            if (allPageKeys.has(page.pageKey)) fail(`${page.pageKey} is projected by multiple canonical papers`);
            allPageKeys.add(page.pageKey);
        }
        queue.push({ paperId: entry.paperId, runId: deterministicRunId(catalogFileSha256, entry.paperId),
            route, pageKeys: pages.map(page => page.pageKey), pages,
            projectionSha256: stableHash(pages) });
    }
    queue.sort((left, right) => left.paperId.localeCompare(right.paperId));
    unprojectedCatalogEntries.sort((left, right) => left.paperId.localeCompare(right.paperId));
    const coveredConferencePages = new Set(conferenceArtifact.projections.flatMap(item => item.pages
        .filter(page => page.scope.type === 'conference').map(page => page.pageKey)));
    const requiredConferencePages = history.pages.filter(page => page.scope.type === 'conference');
    if (coveredConferencePages.size !== requiredConferencePages.length
        || requiredConferencePages.some(page => !coveredConferencePages.has(page.pageKey))) {
        fail('conference page projection artifact does not cover the complete frozen conference page set');
    }
    const projectedPages = queue.flatMap(item => item.pages.map(page => ({ paperId: item.paperId,
        runId: item.runId, route: item.route.kind, ...page }))).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const projectedArxivPages = projectedPages.filter(page => page.route === 'arxiv-fresh-fetch').length;
    if (projectedArxivPages !== currentCatalog.scopeBinding.arxivPageCount) {
        fail('direct arXiv projection count drifted from the current scoped catalog');
    }
    const uncoveredFrozenPaperPages = history.pages.filter(page => !allPageKeys.has(page.pageKey))
        .map(uncoveredPageRecord).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const paperPageCoverage = coverageSummary(projectedPages, uncoveredFrozenPaperPages);
    const body = { contract: CONTRACT, version: VERSION, catalogFileSha256,
        inventory: { ledgerSha256: history.ledgerSha256, pageSetSha256: history.pageSetSha256 },
        conferenceProjectionArtifactSha256: conferenceArtifact.artifactSha256,
        queue, queueSha256: stableHash(queue), projectedPages,
        unprojectedCatalogEntries, unprojectedCatalogEntrySetSha256: stableHash(unprojectedCatalogEntries),
        projectedPageSetSha256: stableHash(projectedPages), uncoveredFrozenPaperPages,
        uncoveredFrozenPaperPageSetSha256: stableHash(uncoveredFrozenPaperPages), paperPageCoverage };
    return { ...body, planSha256: stableHash(body) };
}

function normalizePlan(value) {
    exact(value, ['contract', 'version', 'catalogFileSha256', 'inventory', 'conferenceProjectionArtifactSha256',
        'queue', 'queueSha256', 'projectedPages', 'unprojectedCatalogEntries', 'unprojectedCatalogEntrySetSha256',
        'projectedPageSetSha256', 'uncoveredFrozenPaperPages', 'uncoveredFrozenPaperPageSetSha256',
        'paperPageCoverage', 'planSha256'], 'direct rewrite plan');
    if (value.contract !== CONTRACT || value.version !== VERSION || !validSha(value.catalogFileSha256)
        || !plain(value.inventory) || !validSha(value.inventory.ledgerSha256) || !validSha(value.inventory.pageSetSha256)
        || !validSha(value.conferenceProjectionArtifactSha256) || !Array.isArray(value.queue)
        || !validSha(value.queueSha256) || !Array.isArray(value.projectedPages)
        || !Array.isArray(value.unprojectedCatalogEntries) || !validSha(value.unprojectedCatalogEntrySetSha256)
        || !validSha(value.projectedPageSetSha256) || !Array.isArray(value.uncoveredFrozenPaperPages)
        || !validSha(value.uncoveredFrozenPaperPageSetSha256) || !plain(value.paperPageCoverage)
        || !validSha(value.planSha256)) fail('direct rewrite plan envelope is invalid');
    const paperIds = new Set(); const pageKeys = new Set();
    const queue = value.queue.map((item, index) => {
        exact(item, ['paperId', 'runId', 'route', 'pageKeys', 'pages', 'projectionSha256'], `queue[${index}]`);
        if (typeof item.paperId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.runId || '')
            || !plain(item.route) || !Array.isArray(item.pageKeys) || !item.pageKeys.length || !Array.isArray(item.pages)
            || item.pages.length !== item.pageKeys.length || !validSha(item.projectionSha256) || paperIds.has(item.paperId)) {
            fail('direct rewrite queue item is malformed');
        }
        paperIds.add(item.paperId);
        const route = clone(item.route);
        const expectedRoute = item.paperId.startsWith('arxiv:') ? 'arxiv-fresh-fetch' : 'conference-local-pdf';
        if (route.kind !== expectedRoute || !Array.isArray(route.writerInputs)
            || route.failurePolicy?.crosswalkPrerequisite !== false) fail('direct rewrite route is malformed');
        if (expectedRoute === 'arxiv-fresh-fetch' && (route.writerInputs.length !== 0
            || route.freshFetch?.authority !== 'official-arxiv'
            || route.freshFetch?.imagePersistence !== 'ephemeral-only'
            || route.failurePolicy?.kind !== 'crosswalk-arxiv-fresh-fetch-failure-only')) {
            fail('arXiv direct route must require a fresh source and exclude local writing inputs');
        }
        if (expectedRoute === 'conference-local-pdf' && (!route.writerInputs.length
            || route.failurePolicy?.kind !== 'local-conference-source-failure')) {
            fail('conference direct route requires retained local PDF input');
        }
        const pages = item.pages.map((page, pageIndex) => {
            exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'scope', 'pageContentSha256', 'mapping',
                'historicalArxivLink'],
                `queue[${index}].pages[${pageIndex}]`);
            if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
                || !(page.primaryUrl === null || typeof page.primaryUrl === 'string') || typeof page.cohortDate !== 'string'
                || !plain(page.scope) || typeof page.scope.type !== 'string' || typeof page.scope.key !== 'string'
                || !validSha(page.pageContentSha256) || !['frozen-single-arxiv-identity-hint', 'retained-local-title-fingerprint',
                    conferenceProjections.DAILY_ICML_MAPPING].includes(page.mapping)
                || pageKeys.has(page.pageKey)) fail('direct rewrite projected page is malformed or duplicated');
            const historicalArxivLink = route.kind === 'arxiv-fresh-fetch'
                ? normalizeHistoricalArxivLink(page.historicalArxivLink, route.arxivId)
                : page.historicalArxivLink === null ? null : fail('conference projection cannot carry an arXiv link');
            if ((route.kind === 'arxiv-fresh-fetch') !== (page.mapping === 'frozen-single-arxiv-identity-hint')
                || page.mapping === conferenceProjections.DAILY_ICML_MAPPING
                    && (route.kind !== 'conference-local-pdf' || page.scope.type !== 'daily'
                        || !item.paperId.startsWith('conference:icml:2026:'))
                || page.mapping === 'retained-local-title-fingerprint' && page.scope.type !== 'conference'
                || page.mapping === 'frozen-single-arxiv-identity-hint' && page.scope.type !== 'daily') {
                fail('direct rewrite route/page mapping kind drifted');
            }
            pageKeys.add(page.pageKey); return { ...clone(page), historicalArxivLink };
        }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
        if (item.pageKeys.join('\0') !== pages.map(page => page.pageKey).join('\0')
            || stableHash(pages) !== item.projectionSha256) fail('direct rewrite page projection drifted');
        return { paperId: item.paperId, runId: item.runId, route, pageKeys: item.pageKeys.slice(), pages,
            projectionSha256: item.projectionSha256 };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (queue.some((item, index) => index && queue[index - 1].paperId.localeCompare(item.paperId) >= 0)) {
        fail('direct rewrite queue is unordered');
    }
    const unprojectedPaperIds = new Set(); const unprojectedCatalogEntries = value.unprojectedCatalogEntries.map((entry, index) => {
        exact(entry, ['paperId', 'route', 'reason'], `unprojectedCatalogEntries[${index}]`);
        const expectedRoute = entry.paperId?.startsWith('arxiv:') ? 'arxiv-fresh-fetch'
            : entry.paperId?.startsWith('conference:') ? 'conference-local-pdf' : null;
        if (!expectedRoute || entry.route !== expectedRoute || entry.reason !== 'no-frozen-historical-page-projection'
            || paperIds.has(entry.paperId) || unprojectedPaperIds.has(entry.paperId)) {
            fail('unprojected catalog entry is malformed or overlaps the direct queue');
        }
        unprojectedPaperIds.add(entry.paperId); return clone(entry);
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (value.unprojectedCatalogEntries.some((entry, index) => entry.paperId !== unprojectedCatalogEntries[index].paperId)
        || stableHash(unprojectedCatalogEntries) !== value.unprojectedCatalogEntrySetSha256) {
        fail('unprojected catalog entries drifted');
    }
    const projectedPages = value.projectedPages.map((page, index) => {
        exact(page, ['paperId', 'runId', 'route', 'pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'scope',
            'pageContentSha256', 'mapping', 'historicalArxivLink'], `projectedPages[${index}]`);
        if (!PAGE_KEY_RE.test(page.pageKey) || !['arxiv-fresh-fetch', 'conference-local-pdf'].includes(page.route)
            || (page.route === 'arxiv-fresh-fetch' && !page.paperId.startsWith('arxiv:'))
            || (page.route === 'conference-local-pdf' && !page.paperId.startsWith('conference:'))) {
            fail('direct projected page is malformed');
        }
        const expectedArxivId = page.paperId.startsWith('arxiv:') ? page.paperId.slice(6) : null;
        if (expectedArxivId) normalizeHistoricalArxivLink(page.historicalArxivLink, expectedArxivId);
        else if (page.historicalArxivLink !== null) fail('conference projected page cannot carry an arXiv link');
        return clone(page);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const expectedProjected = queue.flatMap(item => item.pages.map(page => ({ paperId: item.paperId,
        runId: item.runId, route: item.route.kind, ...page }))).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const uncoveredPageKeys = new Set();
    const uncoveredFrozenPaperPages = value.uncoveredFrozenPaperPages.map((page, index) => {
        exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'scope', 'pageContentSha256',
            'identityHintStatus', 'reason'], `uncoveredFrozenPaperPages[${index}]`);
        if (!PAGE_KEY_RE.test(String(page.pageKey || '')) || pageKeys.has(page.pageKey) || uncoveredPageKeys.has(page.pageKey)
            || typeof page.pagePath !== 'string' || !page.pagePath || !(page.primaryUrl === null || typeof page.primaryUrl === 'string')
            || typeof page.cohortDate !== 'string' || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || !validSha(page.pageContentSha256)
            || !IDENTITY_HINT_STATUSES.has(page.identityHintStatus) || page.reason !== 'no-direct-source-route') {
            fail('uncovered frozen paper page is malformed, duplicated, or already projected');
        }
        uncoveredPageKeys.add(page.pageKey); return clone(page);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    if (value.uncoveredFrozenPaperPages.some((page, index) => page.pageKey !== uncoveredFrozenPaperPages[index].pageKey)) {
        fail('uncovered frozen paper pages are unordered');
    }
    const expectedCoverage = coverageSummary(projectedPages, uncoveredFrozenPaperPages);
    if (stableHash(queue) !== value.queueSha256 || stableHash(projectedPages) !== value.projectedPageSetSha256
        || stableHash(projectedPages) !== stableHash(expectedProjected)
        || stableHash(uncoveredFrozenPaperPages) !== value.uncoveredFrozenPaperPageSetSha256
        || stableHash(value.paperPageCoverage) !== stableHash(expectedCoverage)) {
        fail('direct rewrite plan queue/projection/coverage binding drifted');
    }
    const body = { contract: CONTRACT, version: VERSION, catalogFileSha256: value.catalogFileSha256,
        inventory: clone(value.inventory), conferenceProjectionArtifactSha256: value.conferenceProjectionArtifactSha256,
        queue, queueSha256: value.queueSha256, projectedPages, unprojectedCatalogEntries,
        unprojectedCatalogEntrySetSha256: value.unprojectedCatalogEntrySetSha256,
        projectedPageSetSha256: value.projectedPageSetSha256, uncoveredFrozenPaperPages,
        uncoveredFrozenPaperPageSetSha256: value.uncoveredFrozenPaperPageSetSha256,
        paperPageCoverage: clone(expectedCoverage) };
    if (stableHash(body) !== value.planSha256) fail('direct rewrite plan self-SHA drifted');
    return { ...body, planSha256: value.planSha256 };
}

function normalizedGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('arXiv fresh failure generation is invalid');
    return value;
}

function normalizedObservedAt(value) {
    const observedAt = value === undefined ? new Date().toISOString() : value;
    const parsed = new Date(observedAt);
    if (typeof observedAt !== 'string' || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== observedAt) {
        fail('arXiv fresh failure observedAt must be an ISO timestamp');
    }
    return observedAt;
}

function normalizedFailure(error) {
    const errorName = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(error.name)
        ? error.name : 'Error';
    const errorCode = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(error.code)
        ? error.code : null;
    const message = typeof error?.message === 'string' ? error.message : String(error || '');
    return { kind: 'fresh-arxiv-acquisition-failed', errorName, errorCode,
        messageSha256: sha256(Buffer.from(message, 'utf8')) };
}

function handoffPageBindings(item) {
    if (!item || item.route?.kind !== 'arxiv-fresh-fetch') fail('arXiv fresh failure handoff requires an arXiv route');
    return item.pages.map(page => ({ pageKey: page.pageKey, pagePath: page.pagePath,
        pageContentSha256: page.pageContentSha256, primaryUrl: page.primaryUrl,
        cohortDate: page.cohortDate, scope: clone(page.scope), mapping: page.mapping,
        historicalArxivLink: normalizeHistoricalArxivLink(page.historicalArxivLink, item.route.arxivId) }))
        .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function buildArxivFreshFailureHandoff({ plan, paperId, generation, error, observedAt } = {}) {
    const normalized = normalizePlan(plan); const item = normalized.queue.find(entry => entry.paperId === paperId);
    if (!item || item.route.kind !== 'arxiv-fresh-fetch') fail('arXiv fresh failure handoff requires a planned arXiv paper');
    const normalizedGenerationValue = normalizedGeneration(generation); const failure = normalizedFailure(error);
    const pageBindings = handoffPageBindings(item);
    const handoffKey = stableHash({ contract: ARXIV_FRESH_FAILURE_HANDOFF_CONTRACT,
        version: ARXIV_FRESH_FAILURE_HANDOFF_VERSION, planSha256: normalized.planSha256,
        catalogFileSha256: normalized.catalogFileSha256, inventory: normalized.inventory,
        paperId: item.paperId, runId: item.runId, arxivId: item.route.arxivId,
        generation: normalizedGenerationValue, failure, pageBindings, pageBindingSetSha256: stableHash(pageBindings) });
    const body = { contract: ARXIV_FRESH_FAILURE_HANDOFF_CONTRACT, version: ARXIV_FRESH_FAILURE_HANDOFF_VERSION,
        handoffKey, planSha256: normalized.planSha256, catalogFileSha256: normalized.catalogFileSha256,
        inventory: clone(normalized.inventory), paperId: item.paperId, runId: item.runId,
        route: item.route.kind, arxivId: item.route.arxivId, generation: normalizedGenerationValue,
        failure, pageBindings, pageBindingSetSha256: stableHash(pageBindings), observedAt: normalizedObservedAt(observedAt) };
    return { ...body, handoffSha256: stableHash(body) };
}

function normalizeArxivFreshFailureHandoff(value) {
    exact(value, ['contract', 'version', 'handoffKey', 'planSha256', 'catalogFileSha256', 'inventory', 'paperId',
        'runId', 'route', 'arxivId', 'generation', 'failure', 'pageBindings', 'pageBindingSetSha256', 'observedAt',
        'handoffSha256'], 'arXiv fresh failure handoff');
    if (value.contract !== ARXIV_FRESH_FAILURE_HANDOFF_CONTRACT || value.version !== ARXIV_FRESH_FAILURE_HANDOFF_VERSION
        || !validSha(value.handoffKey) || !validSha(value.planSha256) || !validSha(value.catalogFileSha256)
        || !plain(value.inventory) || !validSha(value.inventory.ledgerSha256) || !validSha(value.inventory.pageSetSha256)
        || typeof value.paperId !== 'string' || value.paperId !== `arxiv:${value.arxivId}` || !ARXIV_ID_RE.test(value.arxivId)
        || typeof value.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.runId)
        || value.route !== 'arxiv-fresh-fetch' || !Array.isArray(value.pageBindings) || !value.pageBindings.length
        || !validSha(value.pageBindingSetSha256) || !validSha(value.handoffSha256)) {
        fail('arXiv fresh failure handoff envelope is invalid');
    }
    const generation = normalizedGeneration(value.generation); const observedAt = normalizedObservedAt(value.observedAt);
    exact(value.failure, ['kind', 'errorName', 'errorCode', 'messageSha256'], 'arXiv fresh failure evidence');
    if (value.failure.kind !== 'fresh-arxiv-acquisition-failed'
        || typeof value.failure.errorName !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(value.failure.errorName)
        || !(value.failure.errorCode === null || (typeof value.failure.errorCode === 'string'
            && /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(value.failure.errorCode)))
        || !validSha(value.failure.messageSha256)) fail('arXiv fresh failure evidence is malformed');
    const seenPages = new Set(); const pageBindings = value.pageBindings.map((page, index) => {
        exact(page, ['pageKey', 'pagePath', 'pageContentSha256', 'primaryUrl', 'cohortDate', 'scope', 'mapping',
            'historicalArxivLink'], `arXiv fresh failure pageBindings[${index}]`);
        if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.pagePath !== 'string' || !page.pagePath
            || !validSha(page.pageContentSha256) || !(page.primaryUrl === null || typeof page.primaryUrl === 'string')
            || typeof page.cohortDate !== 'string' || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || page.mapping !== 'frozen-single-arxiv-identity-hint'
            || seenPages.has(page.pageKey)) fail('arXiv fresh failure page binding is malformed or duplicated');
        seenPages.add(page.pageKey);
        return { pageKey: page.pageKey, pagePath: page.pagePath, pageContentSha256: page.pageContentSha256,
            primaryUrl: page.primaryUrl, cohortDate: page.cohortDate, scope: clone(page.scope), mapping: page.mapping,
            historicalArxivLink: normalizeHistoricalArxivLink(page.historicalArxivLink, value.arxivId) };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    if (value.pageBindings.some((page, index) => page.pageKey !== pageBindings[index].pageKey)
        || stableHash(pageBindings) !== value.pageBindingSetSha256) fail('arXiv fresh failure page bindings drifted');
    const deterministic = { contract: value.contract, version: value.version, planSha256: value.planSha256,
        catalogFileSha256: value.catalogFileSha256, inventory: clone(value.inventory), paperId: value.paperId,
        runId: value.runId, arxivId: value.arxivId, generation, failure: clone(value.failure), pageBindings,
        pageBindingSetSha256: value.pageBindingSetSha256 };
    if (stableHash(deterministic) !== value.handoffKey) fail('arXiv fresh failure handoff key drifted');
    const body = { contract: value.contract, version: value.version, handoffKey: value.handoffKey,
        planSha256: value.planSha256, catalogFileSha256: value.catalogFileSha256, inventory: clone(value.inventory),
        paperId: value.paperId, runId: value.runId, route: value.route, arxivId: value.arxivId, generation,
        failure: clone(value.failure), pageBindings, pageBindingSetSha256: value.pageBindingSetSha256, observedAt };
    if (stableHash(body) !== value.handoffSha256) fail('arXiv fresh failure handoff self-SHA drifted');
    return { ...body, handoffSha256: value.handoffSha256 };
}

function arxivFreshFailureHandoffName(handoff) {
    const normalized = normalizeArxivFreshFailureHandoff(handoff);
    const name = `${ARXIV_FRESH_FAILURE_HANDOFF_PREFIX}${normalized.arxivId}-g${String(normalized.generation).padStart(6, '0')}-${normalized.handoffKey.slice(0, 24)}.json`;
    if (!SAFE_NAME_RE.test(name)) fail('arXiv fresh failure handoff filename is unsafe');
    return name;
}

function readArxivFreshFailureHandoff({ root, handoffName } = {}) {
    if (!SAFE_NAME_RE.test(String(handoffName || '')) || !handoffName.startsWith(ARXIV_FRESH_FAILURE_HANDOFF_PREFIX)) {
        fail('arXiv fresh failure handoff name is unsafe');
    }
    const directory = conferenceProjections.safeDirectory(root, 'arXiv fresh failure handoff root');
    const filename = path.resolve(directory, handoffName);
    if (path.dirname(filename) !== directory) fail('arXiv fresh failure handoff escapes its root');
    const loaded = conferenceProjections.readStableJson(filename, 'arXiv fresh failure handoff');
    const handoff = normalizeArxivFreshFailureHandoff(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(handoff))) fail('arXiv fresh failure handoff bytes are not canonical');
    return { filename: fs.realpathSync(filename), fileSha256: loaded.fileSha256, handoff };
}

function writeArxivFreshFailureHandoff({ root, plan, paperId, generation, error, observedAt } = {}) {
    const handoff = buildArxivFreshFailureHandoff({ plan, paperId, generation, error, observedAt });
    const directory = conferenceProjections.safeDirectory(root, 'arXiv fresh failure handoff root', true);
    const handoffName = arxivFreshFailureHandoffName(handoff); const filename = path.join(directory, handoffName);
    const bytes = prettyBytes(handoff); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, handoffName, fileSha256: sha256(bytes), handoff };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readArxivFreshFailureHandoff({ root: directory, handoffName });
        const expected = { ...handoff }; delete expected.observedAt; delete expected.handoffSha256;
        const actual = { ...existing.handoff }; delete actual.observedAt; delete actual.handoffSha256;
        if (stableHash(actual) !== stableHash(expected)) fail('refuses to overwrite a different arXiv fresh failure handoff');
        return { status: 'recovered', filename: existing.filename, handoffName, fileSha256: existing.fileSha256,
            handoff: existing.handoff };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writePlan({ root, outputName, plan } = {}) {
    if (!SAFE_NAME_RE.test(String(outputName || ''))) fail('plan output name is unsafe');
    const normalized = normalizePlan(plan); const directory = conferenceProjections.safeDirectory
        ? conferenceProjections.safeDirectory(root, 'direct rewrite plan root', true)
        : (() => { if (!path.isAbsolute(root)) fail('direct rewrite plan root must be absolute'); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); return root; })();
    const filename = path.join(directory, outputName); const bytes = prettyBytes(normalized); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, plan: normalized };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!conferenceProjections.readStableFile(filename, 'existing direct rewrite plan').bytes.equals(bytes)) {
            fail(`refuses to overwrite different direct rewrite plan: ${outputName}`);
        }
        return { status: 'recovered', filename, plan: normalized };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildUnprojectedCatalogReport({ plan } = {}) {
    const normalized = normalizePlan(plan); const entries = clone(normalized.unprojectedCatalogEntries);
    const body = { contract: UNPROJECTED_REPORT_CONTRACT, version: UNPROJECTED_REPORT_VERSION,
        planSha256: normalized.planSha256, catalogFileSha256: normalized.catalogFileSha256,
        inventory: clone(normalized.inventory), entries, entrySetSha256: stableHash(entries),
        excludedOperations: ['fresh-arxiv-acquisition', 'crosswalk', 'llm-analysis'] };
    return { ...body, reportSha256: stableHash(body) };
}

function normalizeUnprojectedCatalogReport(value) {
    exact(value, ['contract', 'version', 'planSha256', 'catalogFileSha256', 'inventory', 'entries', 'entrySetSha256',
        'excludedOperations', 'reportSha256'], 'unprojected direct rewrite catalog report');
    if (value.contract !== UNPROJECTED_REPORT_CONTRACT || value.version !== UNPROJECTED_REPORT_VERSION
        || !validSha(value.planSha256) || !validSha(value.catalogFileSha256) || !plain(value.inventory)
        || !validSha(value.inventory.ledgerSha256) || !validSha(value.inventory.pageSetSha256)
        || !Array.isArray(value.entries) || !validSha(value.entrySetSha256) || !validSha(value.reportSha256)
        || !Array.isArray(value.excludedOperations)
        || value.excludedOperations.join('\0') !== ['fresh-arxiv-acquisition', 'crosswalk', 'llm-analysis'].join('\0')) {
        fail('unprojected direct rewrite catalog report envelope is invalid');
    }
    const paperIds = new Set(); const entries = value.entries.map((entry, index) => {
        exact(entry, ['paperId', 'route', 'reason'], `unprojected direct rewrite catalog entries[${index}]`);
        const expectedRoute = entry.paperId?.startsWith('arxiv:') ? 'arxiv-fresh-fetch'
            : entry.paperId?.startsWith('conference:') ? 'conference-local-pdf' : null;
        if (!expectedRoute || entry.route !== expectedRoute || entry.reason !== 'no-frozen-historical-page-projection'
            || paperIds.has(entry.paperId)) fail('unprojected direct rewrite catalog report entry is invalid');
        paperIds.add(entry.paperId); return clone(entry);
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (value.entries.some((entry, index) => entry.paperId !== entries[index].paperId)
        || stableHash(entries) !== value.entrySetSha256) fail('unprojected direct rewrite catalog report entries drifted');
    const body = { contract: value.contract, version: value.version, planSha256: value.planSha256,
        catalogFileSha256: value.catalogFileSha256, inventory: clone(value.inventory), entries,
        entrySetSha256: value.entrySetSha256, excludedOperations: value.excludedOperations.slice() };
    if (stableHash(body) !== value.reportSha256) fail('unprojected direct rewrite catalog report self-SHA drifted');
    return { ...body, reportSha256: value.reportSha256 };
}

function unprojectedCatalogReportName(report) {
    const normalized = normalizeUnprojectedCatalogReport(report);
    const name = `${UNPROJECTED_REPORT_PREFIX}${normalized.planSha256.slice(0, 32)}.json`;
    if (!SAFE_NAME_RE.test(name)) fail('unprojected direct rewrite catalog report filename is unsafe');
    return name;
}

function readUnprojectedCatalogReport({ root, reportName } = {}) {
    if (!SAFE_NAME_RE.test(String(reportName || '')) || !reportName.startsWith(UNPROJECTED_REPORT_PREFIX)) {
        fail('unprojected direct rewrite catalog report name is unsafe');
    }
    const directory = conferenceProjections.safeDirectory(root, 'unprojected direct rewrite catalog report root');
    const filename = path.resolve(directory, reportName);
    if (path.dirname(filename) !== directory) fail('unprojected direct rewrite catalog report escapes its root');
    const loaded = conferenceProjections.readStableJson(filename, 'unprojected direct rewrite catalog report');
    const report = normalizeUnprojectedCatalogReport(loaded.value);
    if (!loaded.bytes.equals(prettyBytes(report))) fail('unprojected direct rewrite catalog report bytes are not canonical');
    return { filename: fs.realpathSync(filename), fileSha256: loaded.fileSha256, report };
}

function writeUnprojectedCatalogReport({ root, plan } = {}) {
    const report = buildUnprojectedCatalogReport({ plan });
    const directory = conferenceProjections.safeDirectory(root, 'unprojected direct rewrite catalog report root', true);
    const reportName = unprojectedCatalogReportName(report); const filename = path.join(directory, reportName);
    const bytes = prettyBytes(report); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, reportName, fileSha256: sha256(bytes), report };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readUnprojectedCatalogReport({ root: directory, reportName });
        if (stableHash(existing.report) !== stableHash(report)) {
            fail('refuses to overwrite a different unprojected direct rewrite catalog report');
        }
        return { status: 'recovered', filename: existing.filename, reportName, fileSha256: existing.fileSha256,
            report: existing.report };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function buildFromFiles({ catalogFile, inventoryFile, conferenceProjectionFile } = {}) {
    const catalog = conferenceProjections.readStableJson(catalogFile, 'local source catalog');
    const inventory = conferenceProjections.readStableJson(inventoryFile, 'historical inventory');
    const projection = conferenceProjections.readStableJson(conferenceProjectionFile, 'conference page projection');
    const currentCatalog = normalizeCurrentCatalog(catalog.value);
    if (currentCatalog.scopeBinding.inventoryPath !== inventory.filename
        || currentCatalog.scopeBinding.inventorySha256 !== inventory.fileSha256) {
        fail('current scoped v3 catalog inventory file binding drifted');
    }
    return buildDirectRewritePlan({ catalog: catalog.value, catalogFileSha256: catalog.fileSha256,
        inventory: inventory.value, conferencePageProjections: projection.value });
}

function splitQueues(plan) {
    const normalized = normalizePlan(plan);
    return { arxiv: normalized.queue.filter(item => item.route.kind === 'arxiv-fresh-fetch'),
        conference: normalized.queue.filter(item => item.route.kind === 'conference-local-pdf') };
}

const REGISTRY_CONTRACT = 'historical-direct-rewrite-registry-v2';
const STAGING_ADAPTER_CONTRACT = 'historical-direct-rewrite-staging-adapter-v2';
const DIRECT_SOURCE_RUN_CONTRACT = 'historical-direct-rewrite-source-run-v1';
const FRESH_ARXIV_SOURCE_CONTRACT = 'fresh-arxiv-rewrite-source-v1';

function directSourceRunIdentity(item, sourceBinding) {
    return stableHash({ contract: DIRECT_SOURCE_RUN_CONTRACT, planRunId: item.runId,
        paperId: item.paperId, route: item.route.kind, sourceBinding });
}

function normalizeFreshArxivSourceBinding(item, value) {
    if (!item || item.route?.kind !== 'arxiv-fresh-fetch') fail('fresh arXiv source binding needs an arXiv route');
    exact(value, ['contract', 'arxivId', 'generation', 'paperId', 'pdfSha256', 'sourceManifestSha256', 'textSha256'],
        `${item.paperId} fresh source binding`);
    if (value.contract !== FRESH_ARXIV_SOURCE_CONTRACT || value.paperId !== item.paperId
        || value.arxivId !== item.route.arxivId || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !validSha(value.sourceManifestSha256) || !validSha(value.textSha256) || !validSha(value.pdfSha256)) {
        fail(`${item.paperId} fresh source binding is invalid`);
    }
    return clone(value);
}

function sourceBindingMap(plan, bindings = null) {
    if (bindings === null || bindings === undefined) return new Map();
    const raw = Array.isArray(bindings) ? bindings : bindings?.arxiv;
    if (!Array.isArray(raw)) fail('fresh arXiv source bindings must be an array');
    const normalized = normalizePlan(plan); const items = new Map(normalized.queue.map(item => [item.paperId, item]));
    const byId = new Map();
    for (const record of raw) {
        const value = record?.sourceBinding || record?.result?.sourceBinding || record;
        const paperId = value?.paperId;
        const item = items.get(paperId);
        if (!item || item.route.kind !== 'arxiv-fresh-fetch' || byId.has(paperId)) fail('fresh arXiv source bindings have an unknown or duplicate paper');
        byId.set(paperId, normalizeFreshArxivSourceBinding(item, value));
    }
    return byId;
}

function stageAdapterFor(item) {
    const kind = item?.route?.kind;
    if (kind === 'arxiv-fresh-fetch') return { contract: STAGING_ADAPTER_CONTRACT, version: 1,
        kind: 'arxiv-fresh-analysis-stage', crosswalkPrerequisite: false, postprocessSchedulerPrerequisite: false,
        requiredSource: 'fresh-arxiv-rewrite-source-v1' };
    if (kind === 'conference-local-pdf') return { contract: STAGING_ADAPTER_CONTRACT, version: 1,
        kind: 'conference-local-pdf-analysis-stage', crosswalkPrerequisite: false, postprocessSchedulerPrerequisite: false,
        requiredSource: 'retained-local-conference-pdf' };
    fail('unknown direct staging adapter route');
}

function verifyConferenceWriterInputs(item) {
    if (!item || item.route?.kind !== 'conference-local-pdf' || !Array.isArray(item.route.writerInputs)
        || !item.route.writerInputs.length) fail('conference source verification needs one planned local PDF route');
    const localSources = require('./historical-conference-local-sources.js');
    for (const source of item.route.writerInputs) {
        const metadata = conferenceProjections.readStableFile(source.metadata.absolutePath, 'retained conference metadata', 64 * 1024 * 1024);
        if (metadata.fileSha256 !== source.metadata.sha256) {
            fail(`${item.paperId} retained conference metadata changed after planning`);
        }
        const pdf = localSources.hashAvailablePdf(source.pdf.absolutePath);
        if (pdf.availability !== 'available' || pdf.sha256 !== source.pdf.sha256) {
            fail(`${item.paperId} retained conference PDF changed after planning`);
        }
    }
    return { paperId: item.paperId, sources: item.route.writerInputs.length };
}

function buildRegistry(plan, options = {}) {
    const normalized = normalizePlan(plan);
    const sourceBindings = sourceBindingMap(normalized, options.sourceBindings ?? options.sourcePreparation ?? null);
    const entries = normalized.queue.map(item => ({ paperId: item.paperId, runId: item.runId,
        route: item.route.kind, projectionSha256: item.projectionSha256, pageKeys: item.pageKeys.slice(),
        adapter: stageAdapterFor(item), sourceBinding: item.route.kind === 'arxiv-fresh-fetch'
            ? sourceBindings.get(item.paperId) || null : null,
        sourceRunIdentitySha256: item.route.kind === 'arxiv-fresh-fetch' && sourceBindings.has(item.paperId)
            ? directSourceRunIdentity(item, sourceBindings.get(item.paperId)) : null,
        sourceStatus: 'pending', analysisStatus: 'pending', stagingStatus: 'pending' }))
        .sort((left, right) => left.paperId.localeCompare(right.paperId));
    const body = { contract: REGISTRY_CONTRACT, version: 2, planSha256: normalized.planSha256,
        entries, entrySetSha256: stableHash(entries) };
    return { ...body, registrySha256: stableHash(body) };
}

function normalizeRegistry(value, plan) {
    const normalizedPlan = normalizePlan(plan);
    exact(value, ['contract', 'version', 'planSha256', 'entries', 'entrySetSha256', 'registrySha256'],
        'direct rewrite registry');
    if (value.contract !== REGISTRY_CONTRACT || value.version !== 2 || value.planSha256 !== normalizedPlan.planSha256
        || !Array.isArray(value.entries) || !validSha(value.entrySetSha256) || !validSha(value.registrySha256)) {
        fail('direct rewrite registry envelope is invalid');
    }
    const expected = buildRegistry(normalizedPlan, { sourceBindings: value.entries
        .filter(item => item.route === 'arxiv-fresh-fetch' && item.sourceBinding !== null)
        .map(item => item.sourceBinding) });
    if (stableHash(value.entries) !== value.entrySetSha256 || stableHash({ contract: value.contract, version: value.version,
        planSha256: value.planSha256, entries: value.entries, entrySetSha256: value.entrySetSha256 }) !== value.registrySha256
        || stableHash(value) !== stableHash(expected)) fail('direct rewrite registry drifted from plan');
    return clone(expected);
}

function directStagingBinding({ plan, registry, paperId, analysisArtifact } = {}) {
    const normalized = normalizePlan(plan); const checked = normalizeRegistry(registry, normalized);
    const item = normalized.queue.find(value => value.paperId === paperId);
    const registered = checked.entries.find(value => value.paperId === paperId);
    if (!item || !registered || !plain(analysisArtifact) || analysisArtifact.paperId !== item.paperId
        || analysisArtifact.runId !== item.runId || analysisArtifact.route !== item.route.kind
        || !validSha(analysisArtifact.analysisFileSha256) || !validSha(analysisArtifact.analysisRecordSha256)
        || !validSha(analysisArtifact.sourceSnapshotSha256)) {
        fail('direct staging requires a sealed canonical analysis artifact for its planned route');
    }
    if (item.route.kind === 'arxiv-fresh-fetch') {
        const binding = registered.sourceBinding;
        if (!binding || !validSha(registered.sourceRunIdentitySha256)
            || analysisArtifact.sourceGeneration !== binding.generation
            || analysisArtifact.sourceManifestSha256 !== binding.sourceManifestSha256
            || analysisArtifact.sourceTextSha256 !== binding.textSha256
            || analysisArtifact.sourcePdfSha256 !== binding.pdfSha256
            || analysisArtifact.sourceRunIdentitySha256 !== registered.sourceRunIdentitySha256) {
            fail('direct arXiv staging requires analysis from this sealed source generation and manifest');
        }
    }
    // This packet is the exact page-level input to a direct renderer.  It
    // deliberately has no crosswalk decision or postprocess-scheduler field.
    const pages = item.pages.map(page => ({ ...clone(page), paperId: item.paperId, runId: item.runId,
        route: item.route.kind, analysisFileSha256: analysisArtifact.analysisFileSha256,
        analysisRecordSha256: analysisArtifact.analysisRecordSha256,
        sourceSnapshotSha256: analysisArtifact.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: registered.sourceBinding.generation,
            sourceManifestSha256: registered.sourceBinding.sourceManifestSha256,
            sourceRunIdentitySha256: registered.sourceRunIdentitySha256 } : {}) }))
        .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const body = { contract: 'historical-direct-page-staging-input-v2', version: 2,
        planSha256: normalized.planSha256, registrySha256: checked.registrySha256, paperId: item.paperId,
        runId: item.runId, adapter: registered.adapter, sourceBinding: clone(registered.sourceBinding),
        sourceRunIdentitySha256: registered.sourceRunIdentitySha256, analysisArtifact: clone(analysisArtifact), pages,
        pageSetSha256: stableHash(pages) };
    return { ...body, stagingInputSha256: stableHash(body) };
}

async function bounded(work, concurrency, shouldPause = () => false, onProgress = null) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('queue concurrency is invalid');
    let cursor = 0;
    const worker = async () => {
        const output = [];
        while (cursor < work.length) {
            if (await shouldPause()) break;
            const value = work[cursor++];
            try {
                const result = await value.run();
                const record = { paperId: value.paperId,
                    status: result?.outcome === 'crosswalk-handoff' ? 'handoff' : 'ready', result };
                output.push(record); if (onProgress) await onProgress(record);
            }
            catch (error) { const record = { paperId: value.paperId, status: 'failed', error: String(error.message).slice(0, 2000) };
                output.push(record); if (onProgress) await onProgress(record); }
        }
        return output;
    };
    const groups = await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
    return groups.flat();
}

async function prepareDirectSources({ plan, queue = 'all', arxivGeneration = 1,
    arxivConcurrency = 3, conferenceConcurrency = 5, apply = false, freshArxivSourceRoot,
    freshArxivFailureHandoffRoot, observedAt, paperIds = [], maxPapers = null, completedPaperIds = [],
    shouldPause = () => false, onProgress = null } = {}, overrides = {}) {
    const normalized = normalizePlan(plan);
    if (!['all', 'arxiv', 'conference'].includes(queue) || !Number.isSafeInteger(arxivGeneration)
        || arxivGeneration < 1) fail('direct source queue/generation is invalid');
    const queues = splitQueues(normalized); let selected = [...(queue === 'conference' ? [] : queues.arxiv),
        ...(queue === 'arxiv' ? [] : queues.conference)].sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (!Array.isArray(paperIds) || paperIds.some(id => typeof id !== 'string' || !id)
        || new Set(paperIds).size !== paperIds.length) fail('source paper IDs must be unique');
    const known = new Set(selected.map(item => item.paperId)); const unknown = paperIds.filter(id => !known.has(id));
    if (unknown.length) fail(`source paper IDs are unknown or outside queue=${queue}: ${unknown.join(', ')}`);
    if (paperIds.length) { const requested = new Set(paperIds); selected = selected.filter(item => requested.has(item.paperId)); }
    if (!Array.isArray(completedPaperIds) || completedPaperIds.some(id => !known.has(id))
        || new Set(completedPaperIds).size !== completedPaperIds.length) fail('completed source paper IDs are invalid');
    if (!paperIds.length && completedPaperIds.length) {
        const completed = new Set(completedPaperIds);
        // Conference verification has no separate durable source bundle, so
        // its locked status checkpoint advances bounded batches.  arXiv ready
        // entries remain here until the exact four-file generation is replayed
        // by the existing filter below.
        selected = selected.filter(item => item.route.kind === 'arxiv-fresh-fetch' || !completed.has(item.paperId));
    }
    if (maxPapers !== null) {
        if (!Number.isSafeInteger(maxPapers) || maxPapers < 1) fail('source maxPapers must be positive');
        if (!paperIds.length && typeof freshArxivSourceRoot === 'string' && fs.existsSync(freshArxivSourceRoot)) {
            const fresh = require('./fresh-arxiv-rewrite-source.js');
            selected = selected.filter(item => {
                if (item.route.kind !== 'arxiv-fresh-fetch'
                    || !fresh.generationExists(freshArxivSourceRoot, item.route.arxivId, arxivGeneration)) return true;
                fresh.readFreshArxivRewriteSource({ rootDir: freshArxivSourceRoot,
                    arxivId: item.route.arxivId, generation: arxivGeneration });
                return false;
            });
        }
        selected = selected.slice(0, maxPapers);
    }
    const arxiv = selected.filter(item => item.route.kind === 'arxiv-fresh-fetch');
    const conferences = selected.filter(item => item.route.kind === 'conference-local-pdf');
    if (!apply) return { status: 'dry-run', selectedCount: selected.length, selectedPaperIds: selected.map(item => item.paperId), arxiv: arxiv.map(item => ({ paperId: item.paperId, runId: item.runId,
        arxivId: item.route.arxivId, generation: arxivGeneration, sourceRoot: freshArxivSourceRoot || null })),
    conference: conferences.map(item => ({ paperId: item.paperId, runId: item.runId,
        localPdfSources: item.route.writerInputs.length, projectedPages: item.pageKeys.length })) };
    if (arxiv.length && (typeof freshArxivSourceRoot !== 'string' || !path.isAbsolute(freshArxivSourceRoot)
        || typeof freshArxivFailureHandoffRoot !== 'string' || !path.isAbsolute(freshArxivFailureHandoffRoot))) {
        fail('freshArxivSourceRoot and freshArxivFailureHandoffRoot are required for arXiv direct source preparation');
    }
    const capture = overrides.captureFreshArxivRewriteSource
        || require('./fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource;
    const verifyConference = overrides.verifyConferenceSource || verifyConferenceWriterInputs;
    const writeFailureHandoff = overrides.writeArxivFreshFailureHandoff || writeArxivFreshFailureHandoff;
    if (typeof capture !== 'function' || typeof verifyConference !== 'function' || typeof writeFailureHandoff !== 'function') {
        fail('direct source adapters are required');
    }
    const [arxivResults, conferenceResults] = await Promise.all([
        bounded(arxiv.map(item => ({ paperId: item.paperId, run: async () => {
            try {
                const captured = await capture({ rootDir: freshArxivSourceRoot, arxivId: item.route.arxivId,
                    generation: arxivGeneration });
                if (!captured?.manifest || captured.manifest.paperId !== item.paperId
                    || captured.generation !== arxivGeneration || typeof captured.directory !== 'string'
                    || !validSha(captured.sourceManifestSha256)) {
                    fail(`${item.paperId} fresh source adapter returned a mismatched generation`);
                }
                // The scheduler record proves the sealed source pair without
                // serializing either full text or PDF bytes into its checkpoint.
                const sourceBinding = normalizeFreshArxivSourceBinding(item, { contract: FRESH_ARXIV_SOURCE_CONTRACT,
                    paperId: item.paperId, arxivId: item.route.arxivId, generation: arxivGeneration,
                    sourceManifestSha256: captured.sourceManifestSha256,
                    textSha256: captured.manifest.text.responseSha256, pdfSha256: captured.manifest.pdf.responseSha256 });
                return { status: captured.status, arxivId: item.route.arxivId, generation: arxivGeneration,
                    sourceDirectory: captured.directory, textSha256: captured.manifest.text.responseSha256,
                    pdfSha256: captured.manifest.pdf.responseSha256, sourceManifestSha256: captured.sourceManifestSha256,
                    sourceBinding, sourceRunIdentitySha256: directSourceRunIdentity(item, sourceBinding) };
            } catch (error) {
                // This is an immutable handoff, never a crosswalk mutation.
                // The local conference queue continues in parallel and a later
                // dedicated crosswalk worker can replay this frozen mapping.
                const handoff = await writeFailureHandoff({ root: freshArxivFailureHandoffRoot, plan: normalized,
                    paperId: item.paperId, generation: arxivGeneration, error, observedAt });
                return { outcome: 'crosswalk-handoff', arxivId: item.route.arxivId, generation: arxivGeneration,
                    handoff: { status: handoff.status, handoffName: handoff.handoffName,
                        fileSha256: handoff.fileSha256, handoffSha256: handoff.handoff.handoffSha256 } };
            }
        } })), arxivConcurrency, shouldPause, onProgress),
        bounded(conferences.map(item => ({ paperId: item.paperId, run: async () => {
            await verifyConference(item);
            return { sourceCount: item.route.writerInputs.length,
                sourceSetSha256: stableHash(item.route.writerInputs) };
        } })), conferenceConcurrency, shouldPause, onProgress)
    ]);
    const processedCount = arxivResults.length + conferenceResults.length;
    return { status: processedCount < selected.length && await shouldPause() ? 'paused'
        : arxivResults.some(item => item.status !== 'ready') || conferenceResults.some(item => item.status !== 'ready') ? 'partial' : 'ready',
        selectedCount: selected.length, processedCount, remainingCount: selected.length - processedCount,
        selectedPaperIds: selected.map(item => item.paperId), arxiv: arxivResults.sort((left, right) => left.paperId.localeCompare(right.paperId)),
    conference: conferenceResults.sort((left, right) => left.paperId.localeCompare(right.paperId)) };
}

module.exports = { CONTRACT, VERSION, CATALOG_CONTRACT, SAFE_NAME_RE, HistoricalDirectRewritePlanError,
    stableHash, deterministicRunId, normalizeCatalog, normalizeInventory, arxivPageProjections, sourceRoute,
    normalizeHistoricalArxivLink, buildDirectRewritePlan, normalizePlan, writePlan,
    UNPROJECTED_REPORT_CONTRACT, UNPROJECTED_REPORT_VERSION, UNPROJECTED_REPORT_PREFIX,
    buildUnprojectedCatalogReport, normalizeUnprojectedCatalogReport, unprojectedCatalogReportName,
    readUnprojectedCatalogReport, writeUnprojectedCatalogReport, buildFromFiles, splitQueues,
    ARXIV_FRESH_FAILURE_HANDOFF_CONTRACT, ARXIV_FRESH_FAILURE_HANDOFF_VERSION,
    ARXIV_FRESH_FAILURE_HANDOFF_PREFIX, buildArxivFreshFailureHandoff, normalizeArxivFreshFailureHandoff,
    arxivFreshFailureHandoffName, readArxivFreshFailureHandoff, writeArxivFreshFailureHandoff,
    REGISTRY_CONTRACT, STAGING_ADAPTER_CONTRACT, DIRECT_SOURCE_RUN_CONTRACT, FRESH_ARXIV_SOURCE_CONTRACT,
    stageAdapterFor, normalizeFreshArxivSourceBinding, directSourceRunIdentity, buildRegistry, normalizeRegistry,
    directStagingBinding, verifyConferenceWriterInputs, prepareDirectSources };
