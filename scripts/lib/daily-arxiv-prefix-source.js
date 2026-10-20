'use strict';

// Daily-only recovery for a rate-limited date query. Both routes consume the
// official Atom API; a category prefix is eligible only after full-page lower
// boundary coverage, continuity and an independent first-page replay.
const crypto = require('node:crypto');
const CONTRACT = 'daily-arxiv-atom-prefix-coverage-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const prefixUrl = (category, start, size) => `https://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${size}`;
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Optional route evidence extends v7 coverage without changing its time window
// or candidate identity. Both production reuse and the read-only validator use
// this same check; legacy date-window providers retain their existing rules.
function hasVerifiedCategoryPrefix(health, boundary, expectedCategoryId = health?.categoryId || health?.id, requireTrigger = true, expectedPapers, expectedExistingIds) {
    const provider = health?.provider, prefix = provider?.categoryPrefix;
    if (provider?.oai || provider?.window?.coverageContract === 'daily-arxiv-oai-coverage-v1') {
        return require('./daily-arxiv-oai-source').hasVerifiedOaiCoverage(health, boundary, expectedCategoryId, expectedPapers, expectedExistingIds);
    }
    if (!prefix && provider?.window?.coverageContract === undefined) return true;
    try {
        const category = expectedCategoryId;
        const since = Date.parse(boundary.since);
        if (provider.window.coverageContract !== CONTRACT || prefix?.contract !== CONTRACT
            || prefix.categoryId !== category || prefix.boundaryIdentity !== boundary.identitySha256
            || !Number.isFinite(since) || !Number.isSafeInteger(prefix.pageSize)
            || prefix.pageSize < 1 || prefix.pageSize > 2000 || !Array.isArray(prefix.pages)
            || prefix.pages.length === 0 || prefix.firstPageReplayed !== true) return false;
        let offset = 0, total = null, previous = Infinity;
        const pageValid = (page, expectedOffset) => {
            if (page.url !== prefixUrl(category, expectedOffset, prefix.pageSize)
                || page.start !== expectedOffset || !Number.isSafeInteger(page.totalResults)
                || page.totalResults < 0 || (total !== null && page.totalResults !== total)
                || page.count !== Math.min(prefix.pageSize, Math.max(0, page.totalResults - expectedOffset))
                || !SHA256.test(page.responseSha256) || !SHA256.test(page.entriesSha256)) return false;
            if (page.count === 0) return page.first === null && page.last === null;
            return /^[0-9]{4}\.[0-9]{4,5}$/.test(page.first?.arxivId)
                && /^[0-9]{4}\.[0-9]{4,5}$/.test(page.last?.arxivId)
                && Number.isFinite(Date.parse(page.first.published))
                && Number.isFinite(Date.parse(page.last.published))
                && Date.parse(page.first.published) >= Date.parse(page.last.published);
        };
        for (const page of prefix.pages) {
            if (offset >= 30000 || (total !== null && offset >= total) || !pageValid(page, offset)
                || (page.count > 0 && Date.parse(page.first.published) > previous)) return false;
            total = page.totalResults;
            offset += page.count;
            if (page.count > 0) previous = Date.parse(page.last.published);
        }
        const first = prefix.pages[0], replay = prefix.replay;
        if (offset > 30000 || prefix.observedEntries !== offset || !pageValid(replay, 0)
            || replay.count !== first.count || replay.entriesSha256 !== first.entriesSha256
            || JSON.stringify(replay.first) !== JSON.stringify(first.first)
            || JSON.stringify(replay.last) !== JSON.stringify(first.last)) return false;
        if (prefix.completionReason === 'category-exhausted' ? offset !== total
            : prefix.completionReason !== 'strict-lower-bound-crossed' || offset >= total || previous >= since) return false;
        if (requireTrigger && !prefix.dateQueryFailure) return false;
        if (prefix.dateQueryFailure && (!prefix.dateQueryFailure.health?.failures?.some(item => item.error === 'HTTP 429')
            || prefix.dateQueryFailure.health?.provider?.boundaryIdentity !== boundary.identitySha256)) return false;
        return true;
    } catch { return false; }
}

async function fetchCategoryPrefix(categoryId, boundary, existingIds, options = {}) {
    const api = require('../fetch-papers');
    const { ARXIV_CONFIG } = require('../config');
    const { normalizedId, detectHttpConnectProxyUrl } = require('../utils');
    const since = Date.parse(boundary?.since), until = Date.parse(boundary?.until);
    const pageSize = options.pageSize ?? 100;
    if (!/^[a-z]+\.[A-Z]{2}$/.test(categoryId) || !Number.isFinite(since)
        || !Number.isFinite(until) || since >= until
        || !/^[a-f0-9]{64}$/.test(boundary?.identitySha256 || '')
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 2000) {
        throw new Error('Category prefix requires a valid category, exact boundary and page size');
    }
    const witness = boundary.continuity?.required
        ? boundary.continuity.witnesses?.arxiv?.find(item => item.categoryId === categoryId) : null;
    if (boundary.continuity?.required && !witness) throw new Error('Category prefix lacks its continuity witness');
    const proxy = detectHttpConnectProxyUrl();
    if (!options.requestFn && !proxy) throw new Error('Official Atom prefix requires project HTTP CONNECT');
    const scheduler = options.requestScheduler || require('./fetch-scheduler').createHostTaskScheduler();
    const request = options.requestFn || api.httpsRequestWithProxy;
    const old = new Set(Array.from(existingIds || [], normalizedId));
    const seen = new Set(), papers = [];
    const health = { categoryId, source: 'arxiv-api-category-prefix', contract: CONTRACT,
        boundary: structuredClone(boundary), attempts: 0, successfulRequests: 0,
        failures: [], coverageComplete: false, ok: false, allFailed: false,
        provider: { boundaryIdentity: boundary.identitySha256,
            window: { since: boundary.since, until: boundary.until, covered: false, coverageContract: CONTRACT },
            categoryPrefix: { contract: CONTRACT, categoryId, boundaryIdentity: boundary.identitySha256,
                pageSize, pages: [], firstPageReplayed: false } } };
    const prefix = health.provider.categoryPrefix;
    if (witness) {
        health.continuity = { required: true, encounters: [] };
        health.provider.continuity = { required: true,
            status: witness.status === 'expected' ? 'pending' : 'not-applicable',
            ...(witness.status === 'expected' ? { expectedId: witness.arxivId,
                witnessPublished: witness.published } : { reason: witness.reason }),
            matchedIds: [], encounterVerified: false };
    }
    let total = null, previous = Infinity, start = 0, firstIdentity, completed = false;
    const stableEntries = page => page.entries.map(({ arxivId, title, abstract, authors, published, categories }) =>
        ({ arxivId, title, abstract, authors, published, categories }));
    const identity = page => sha({ total: page.totalResults, entries: stableEntries(page) });
    const fetchPage = async offset => {
        // Keep the canonical category URL stable; date predicates are deliberately
        // absent. The exact time interval is checked against every returned entry.
        const url = prefixUrl(categoryId, offset, pageSize);
        health.attempts++;
        const response = await scheduler.run('export.arxiv.org', () => request(url,
            { 'User-Agent': 'audio-paper-digest/1.0', Accept: 'application/atom+xml' },
            proxy, ARXIV_CONFIG.fetchTimeoutMs, ARXIV_CONFIG.fetchMaxResponseBytes), { minimumCooldownMs: 3000 });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const page = api.parseArxivXML(response.data, categoryId, null,
            { stopAtConsecutiveExisting: false, feedPage: true });
        if (page.startIndex !== offset || !Number.isSafeInteger(page.totalResults) || page.totalResults < 0
            || (total !== null && total !== page.totalResults)
            || ![pageSize, page.entries.length].includes(page.itemsPerPage)
            || page.entries.length !== Math.min(pageSize, Math.max(0, page.totalResults - offset))) {
            throw new Error('Official category Atom pagination is incomplete or changed');
        }
        health.successfulRequests++;
        return { page, proof: { url, start: offset, count: page.entries.length,
            totalResults: page.totalResults, responseSha256: crypto.createHash('sha256').update(response.data).digest('hex'),
            entriesSha256: sha(stableEntries(page)),
            first: page.entries.length ? { arxivId: normalizedId(page.entries[0]), published: page.entries[0].published } : null,
            last: page.entries.length ? { arxivId: normalizedId(page.entries.at(-1)), published: page.entries.at(-1).published } : null } };
    };
    try {
        while (start < 30000) {
            const { page, proof } = await fetchPage(start);
            total = page.totalResults;
            if (start === 0) firstIdentity = identity(page);
            for (const paper of page.entries) {
                const id = normalizedId(paper), published = Date.parse(paper.published);
                if (!id || !Number.isFinite(published) || published > previous
                    || !paper.categories?.includes(categoryId) || seen.has(id)) {
                    throw new Error('Official category Atom entry identity, order, category or timestamp is invalid');
                }
                previous = published; seen.add(id);
                if (witness?.status === 'expected' && id === witness.arxivId) {
                    if (published !== Date.parse(witness.published)) throw new Error('Continuity witness publication time changed');
                    health.continuity.encounters.push({ arxivId: id, published: paper.published });
                    Object.assign(health.provider.continuity, { status: 'verified', matchedIds: [id], encounterVerified: true });
                }
                if (published >= since && published <= until && !old.has(id)) papers.push(paper);
            }
            prefix.pages.push(proof); start += page.entries.length;
            // Read the whole page, including all timestamp ties. A known ID alone
            // cannot stop pagination, and equality with the lower bound cannot.
            if (start === total || (page.entries.length && previous < since)) {
                prefix.completionReason = start === total ? 'category-exhausted' : 'strict-lower-bound-crossed';
                completed = true; break;
            }
        }
        if (!completed) throw new Error('Category prefix reached the official API offset limit before complete boundary coverage');
        if (witness?.status === 'expected' && !health.provider.continuity.encounterVerified) {
            throw new Error(`Complete category prefix did not encounter witness ${witness.arxivId}`);
        }
        const replay = await fetchPage(0);
        if (identity(replay.page) !== firstIdentity) throw new Error('Official category Atom first page changed during pagination');
        prefix.firstPageReplayed = true;
        prefix.replay = replay.proof;
        prefix.observedEntries = seen.size;
        health.fetched = papers.length;
        if (!hasVerifiedCategoryPrefix(health, boundary, categoryId, false)) throw new Error('Official category prefix proof failed its cold coverage replay');
        health.coverageComplete = health.ok = health.provider.window.covered = true;
        health.completionReason = 'official-category-prefix-boundary-and-witness-verified';
        Object.defineProperty(papers, '_sourceHealth', { value: health, enumerable: false });
        return papers;
    } catch (cause) {
        health.failures.push({ error: cause.message });
        health.allFailed = health.successfulRequests === 0;
        throw Object.assign(new Error(`arXiv ${categoryId} category prefix incomplete: ${cause.message}`, { cause }),
            { code: 'SOURCE_FETCH_FAILED', sourceHealth: health });
    }
}

function hasEligibleOaiTrigger(health, boundary, categoryId) {
    if (!boundary || !SHA256.test(boundary.identitySha256 || '')
        || !Number.isFinite(Date.parse(boundary.since)) || !Number.isFinite(Date.parse(boundary.until))) return false;
    const provider = health?.provider, prefix = provider?.categoryPrefix;
    const original = prefix?.dateQueryFailure?.health;
    const limited = h => Array.isArray(h?.failures) && h.failures.length > 0
        && h.failures.every(item => item?.error === 'HTTP 429');
    const sameBoundary = h => h?.categoryId === categoryId && (h.id === undefined || h.id === categoryId)
        && h.provider?.boundaryIdentity === boundary?.identitySha256
        && h.provider.window?.since === boundary.since && h.provider.window?.until === boundary.until
        && h.provider.window.covered === false;
    return health?.ok === false && sameBoundary(health) && limited(health)
        && provider.window.coverageContract === CONTRACT && prefix?.contract === CONTRACT
        && prefix.categoryId === categoryId && prefix.boundaryIdentity === boundary.identitySha256
        && sameBoundary(original) && limited(original);
}

async function fetchDailyArxivCategory(categoryId, boundary, existingIds, options = {}) {
    const recover = async triggerFailure => {
        const evidenceDir = options.createOaiEvidenceDir?.();
        return require('./daily-arxiv-oai-source').fetchDailyOaiCategory(categoryId, boundary, existingIds,
            { evidenceDir, requestScheduler: options.requestScheduler, triggerFailure });
    };
    if (options.officialOaiRecovery === true && hasEligibleOaiTrigger(options.triggerFailure, boundary, categoryId)) {
        return recover(options.triggerFailure);
    }
    try { return await fetchDailyAtomCategory(categoryId, boundary, existingIds, options); }
    catch (error) {
        if (options.officialOaiRecovery !== true || !hasEligibleOaiTrigger(error.sourceHealth, boundary, categoryId)) throw error;
        return recover(error.sourceHealth);
    }
}

async function fetchDailyAtomCategory(categoryId, boundary, existingIds, options = {}) {
    const state = options.strategyState || {};
    const windowFetch = options.windowFetch || require('../fetch-papers').fetchCategoryPapersSince;
    let failure = state.categoryPrefixFailure;
    if (!state.categoryPrefix) {
        try { return await windowFetch(categoryId, boundary, existingIds, options); }
        catch (error) {
            if (!error.sourceHealth?.failures?.some(item => item.error === 'HTTP 429')) throw error;
            failure = { message: error.message, health: error.sourceHealth };
        }
    }
    try {
        const result = await fetchCategoryPrefix(categoryId, boundary, existingIds, options);
        if (failure) result._sourceHealth.provider.categoryPrefix.dateQueryFailure = failure;
        if (!hasVerifiedCategoryPrefix(result._sourceHealth, boundary, categoryId)) {
            const health = result._sourceHealth;
            health.coverageComplete = health.ok = health.provider.window.covered = false;
            health.failures.push({ error: 'Daily category prefix lacks its verified HTTP429 trigger' });
            throw Object.assign(new Error('Daily category prefix lacks its verified HTTP429 trigger'),
                { code: 'SOURCE_FETCH_FAILED', sourceHealth: health });
        }
        state.categoryPrefix = true;
        state.categoryPrefixFailure = failure;
        return result;
    } catch (error) {
        if (failure && error.sourceHealth) error.sourceHealth.provider.categoryPrefix.dateQueryFailure = failure;
        throw error;
    }
}

module.exports = { CONTRACT, fetchCategoryPrefix, fetchDailyArxivCategory, hasVerifiedCategoryPrefix, hasEligibleOaiTrigger };
