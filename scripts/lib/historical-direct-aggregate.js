'use strict';

// Deterministic daily/conference aggregate staging for the source-only direct
// rewrite pipeline.  This module intentionally has no crosswalk, legacy
// scheduler, old-page-body, crawler-current, network, or LLM dependency.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const planApi = require('./historical-direct-rewrite-plan.js');
const runnerApi = require('./historical-direct-rewrite-runner.js');
const directPages = require('./historical-direct-page-staging.js');
const projectionIo = require('./historical-conference-page-projections.js');
const { parseAnalysis } = require('../utils.js');
const taxonomyRuntime = require('./taxonomy-runtime.js').getDefaultTaxonomyRuntime();

const CONTRACT = 'historical-direct-aggregate-v2';
const VERSION = 2;
const PROJECTION_CONTRACT = 'historical-direct-aggregate-projection-v3';
const PROJECTION_VERSION = 3;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONFERENCE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONFERENCE_TASK_KEY_RE = /^task-[a-z0-9._-]+$/;
const TASK_RENDERER = 'historical-conference-task-reader-facing-v1';
const RETAIN_UNCHANGED_REASON = 'frozen-summary-has-no-direct-paper-members';

class HistoricalDirectAggregateError extends Error {
    constructor(message) {
        super(`Historical direct aggregate rejected: ${message}`);
        this.name = 'HistoricalDirectAggregateError';
        this.code = 'HISTORICAL_DIRECT_AGGREGATE_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalDirectAggregateError(message); };
const validSha = value => SHA_RE.test(String(value || ''));
const clone = value => structuredClone(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function text(value, label, maximum = 50000) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${label} must be bounded trimmed text`);
    return value;
}
function safeRoot(value, label, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute directory`);
    return projectionIo.safeDirectory(value, label, create);
}
function inside(root, target, label) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) fail(`${label} must be an absolute path`);
    const resolved = path.resolve(target); const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail(`${label} escapes configured root`);
    return resolved;
}
function readJson(filename, label, maximum = 128 * 1024 * 1024) {
    try { return projectionIo.readStableJson(filename, label, maximum); }
    catch (error) {
        if (error instanceof HistoricalDirectAggregateError) throw error;
        fail(`${label} is unreadable: ${error.message}`);
    }
}
function validUrl(value, label) {
    if (value === null) return null;
    let url;
    try { url = new URL(value); } catch { fail(`${label} is invalid`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`${label} is unsafe`);
    return url.href;
}
function internalUrl(value, label) {
    const href = validUrl(value, label);
    if (!href) fail(`${label} is required`);
    const url = new URL(href); return `${url.pathname}${url.pathname.endsWith('/') ? '' : '/'}`;
}
function uuidFromHash(value) {
    const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function projectionOutputPage(page, label) {
    exact(page, ['pageKey', 'path', 'primaryUrl', 'previousContentSha256'], label);
    if (!PAGE_KEY_RE.test(page.pageKey) || typeof page.path !== 'string' || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.path)
        || !validSha(page.previousContentSha256)) fail(`${label} is invalid`);
    return { pageKey: page.pageKey, path: page.path, primaryUrl: validUrl(page.primaryUrl, `${label}.primaryUrl`),
        previousContentSha256: page.previousContentSha256 };
}
function projectionConferenceTaskPage(page, label) {
    exact(page, ['pageKey', 'path', 'primaryUrl', 'previousContentSha256', 'conferenceKey', 'legacyTaskKey',
        'displayLabel', 'requiredPaperIds', 'requiredPageKeys', 'membershipEvidence', 'status',
        'rendererSupport', 'publicationDisposition', 'reason'], label);
    const output = projectionOutputPage({ pageKey: page.pageKey, path: page.path, primaryUrl: page.primaryUrl,
        previousContentSha256: page.previousContentSha256 }, label);
    if (output.primaryUrl === null || path.posix.normalize(output.path) !== output.path || output.path.split('/').includes('..')
        || !CONFERENCE_KEY_RE.test(String(page.conferenceKey || ''))
        || !CONFERENCE_TASK_KEY_RE.test(String(page.legacyTaskKey || ''))
        || text(page.displayLabel, `${label}.displayLabel`, 200) === ''
        || !Array.isArray(page.requiredPaperIds) || !page.requiredPaperIds.length
        || new Set(page.requiredPaperIds).size !== page.requiredPaperIds.length
        || page.requiredPaperIds.some(value => typeof value !== 'string' || !value)
        || !Array.isArray(page.requiredPageKeys) || !page.requiredPageKeys.length
        || new Set(page.requiredPageKeys).size !== page.requiredPageKeys.length
        || page.requiredPageKeys.some(value => !PAGE_KEY_RE.test(String(value || '')))
        || !plain(page.membershipEvidence)
        || Object.keys(page.membershipEvidence).sort().join('\0') !== ['contract', 'inventoryPageSha256', 'links', 'linkSetSha256'].sort().join('\0')
        || !validSha(page.membershipEvidence.inventoryPageSha256)
        || !validSha(page.membershipEvidence.linkSetSha256)
        || page.status !== 'planned' || page.rendererSupport !== TASK_RENDERER
        || page.publicationDisposition !== 'rewrite' || page.reason !== null) {
        fail(`${label} support state is invalid`);
    }
    if (!Array.isArray(page.membershipEvidence.links) || page.membershipEvidence.links.some(link => !plain(link)
        || Object.keys(link).sort().join('\0') !== ['ordinal', 'targetPageKey', 'targetRawSha256', 'targetRecordSha256'].sort().join('\0'))) {
        fail(`${label} membership evidence is invalid`);
    }
    return { ...output, conferenceKey: page.conferenceKey, legacyTaskKey: page.legacyTaskKey,
        displayLabel: page.displayLabel, requiredPaperIds: page.requiredPaperIds.slice().sort(),
        requiredPageKeys: page.requiredPageKeys.slice().sort(), membershipEvidence: clone(page.membershipEvidence),
        status: 'planned', rendererSupport: TASK_RENDERER, publicationDisposition: 'rewrite', reason: null };
}
function conferenceTaskCoverageFor(taskPages, inventoryPageSetSha256) {
    if (!Array.isArray(taskPages) || !validSha(inventoryPageSetSha256)) fail('conference task coverage inputs are invalid');
    const conferences = [...new Set(taskPages.map(page => page.conferenceKey))].sort().map(conferenceKey => {
        const pages = taskPages.filter(page => page.conferenceKey === conferenceKey);
        return { conferenceKey, total: pages.length, planned: pages.length, supported: pages.length,
            taskPageSetSha256: stableHash(pages) };
    });
    return {
        status: 'complete',
        rendererSupport: taskPages.length ? TASK_RENDERER : 'not-required',
        publicationReady: true,
        reason: null,
        total: taskPages.length,
        pending: 0,
        unsupported: 0,
        planned: taskPages.length,
        supported: taskPages.length,
        inventoryPageSetSha256,
        taskPageSetSha256: stableHash(taskPages),
        conferences,
        conferenceSetSha256: stableHash(conferences)
    };
}
function projectionRetainedPage(page, label) {
    exact(page, ['pageKey', 'path', 'primaryUrl', 'previousContentSha256', 'kind', 'scope',
        'publicationDisposition', 'reason'], label);
    const output = projectionOutputPage({ pageKey: page.pageKey, path: page.path, primaryUrl: page.primaryUrl,
        previousContentSha256: page.previousContentSha256 }, label);
    if (page.kind !== 'daily-summary' || !plain(page.scope) || page.scope.type !== 'daily'
        || !DATE_RE.test(String(page.scope.key || '')) || page.publicationDisposition !== 'retain-unchanged'
        || page.reason !== RETAIN_UNCHANGED_REASON) fail(`${label} retain-unchanged disposition is invalid`);
    return { ...output, kind: page.kind, scope: clone(page.scope), publicationDisposition: 'retain-unchanged',
        reason: RETAIN_UNCHANGED_REASON };
}
function normalizeInventoryForAggregateProjection(value, plan) {
    if (!plain(value) || !validSha(value.ledgerSha256) || !validSha(value.pageSetSha256) || !Array.isArray(value.pages)
        || stableHash(value.pages) !== value.pageSetSha256) {
        fail('aggregate projection inventory is invalid or page-set hash drifted');
    }
    if (value.ledgerSha256 !== plan.inventory.ledgerSha256 || value.pageSetSha256 !== plan.inventory.pageSetSha256) {
        fail('aggregate projection inventory differs from direct plan');
    }
    const seen = new Set();
    return value.pages.map((page, index) => {
        if (!plain(page) || !PAGE_KEY_RE.test(String(page.pageId || '')) || seen.has(page.pageId)
            || typeof page.path !== 'string' || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.path)
            || !validSha(page.contentSha256) || !plain(page.scope) || typeof page.scope.type !== 'string'
            || typeof page.scope.key !== 'string' || typeof page.cohortDate !== 'string'
            || !['paper', 'daily-summary', 'conference-summary', 'conference-task'].includes(page.kind)) {
            fail(`aggregate projection inventory page ${index} is invalid`);
        }
        if (page.kind === 'conference-task' && (page.scope.type !== 'conference'
            || !CONFERENCE_KEY_RE.test(page.scope.key) || !CONFERENCE_TASK_KEY_RE.test(String(page.legacyTaskKey || '')))) {
            fail(`aggregate projection inventory conference task page ${index} is invalid`);
        }
        seen.add(page.pageId);
        const taskTags = page.kind === 'conference-task' ? page.legacy?.tags : null;
        const taskLinks = page.kind === 'conference-task' ? page.outboundPostLinks : null;
        if (page.kind === 'conference-task' && (!Array.isArray(taskTags) || taskTags.length !== 1
            || !Array.isArray(taskLinks))) fail(`aggregate projection inventory conference task identity ${index} is invalid`);
        return { pageKey: page.pageId, path: page.path, primaryUrl: validUrl(page.primaryUrl, `inventory page ${page.pageId} URL`),
            previousContentSha256: page.contentSha256, kind: page.kind, scope: { type: page.scope.type, key: page.scope.key },
            cohortDate: page.cohortDate, ...(page.kind === 'conference-task' ? {
                legacyTaskKey: page.legacyTaskKey, displayLabel: text(taskTags[0], `conference task ${index} label`, 200),
                outboundPostLinks: clone(taskLinks)
            } : {}) };
    });
}
function cohortEntries(plan, scope, key) {
    const papers = plan.queue.filter(item => item.pages.some(page => page.scope.type === scope && page.scope.key === key));
    if (!papers.length) fail(`${scope}:${key} has no projected direct papers`);
    const pageKeys = papers.flatMap(item => item.pages.filter(page => page.scope.type === scope && page.scope.key === key)
        .map(page => page.pageKey)).sort();
    if (!pageKeys.length || new Set(pageKeys).size !== pageKeys.length) fail(`${scope}:${key} projected pages are invalid`);
    return { requiredPaperIds: papers.map(item => item.paperId).sort(), requiredPageKeys: pageKeys };
}

// This reads no post bytes. It reduces the frozen inventory to retained output
// route/SHA metadata and binds it to the direct plan before execution begins.
function buildAggregateProjection({ plan, inventory } = {}) {
    const normalizedPlan = planApi.normalizePlan(plan);
    const pages = normalizeInventoryForAggregateProjection(inventory, normalizedPlan);
    const dailyKeys = [...new Set(normalizedPlan.projectedPages.filter(page => page.scope.type === 'daily').map(page => page.scope.key))].sort();
    const conferenceKeys = [...new Set(normalizedPlan.projectedPages.filter(page => page.scope.type === 'conference').map(page => page.scope.key))].sort();
    const build = (scope, key, kind) => {
        const target = pages.filter(page => page.kind === kind && page.scope.type === scope && page.scope.key === key);
        if (target.length !== 1) fail(`${scope}:${key} must have exactly one retained aggregate output page`);
        if (scope === 'daily' && (!DATE_RE.test(key) || target[0].cohortDate !== key)) fail(`daily:${key} output projection date drifted`);
        const members = cohortEntries(normalizedPlan, scope, key);
        return { scope, key, outputPage: projectionOutputPage({ pageKey: target[0].pageKey, path: target[0].path, primaryUrl: target[0].primaryUrl, previousContentSha256: target[0].previousContentSha256 }, `${scope}:${key} output page`), ...members };
    };
    const daily = dailyKeys.map(key => build('daily', key, 'daily-summary'));
    const conference = conferenceKeys.map(key => build('conference', key, 'conference-summary'));
    const paperByPageKey = new Map(normalizedPlan.queue.flatMap(item => item.pages.map(page => [page.pageKey, item])));
    const conferenceTaskPages = pages.filter(page => page.kind === 'conference-task').map(page => {
        const links = page.outboundPostLinks.filter(link => plain(link) && link.status === 'resolved'
            && PAGE_KEY_RE.test(String(link.targetPageId || '')) && paperByPageKey.has(link.targetPageId)
            && paperByPageKey.get(link.targetPageId).pages.some(projected => projected.pageKey === link.targetPageId
                && projected.scope.type === 'conference' && projected.scope.key === page.scope.key))
            .map(link => ({ ordinal: link.ordinal, targetPageKey: link.targetPageId,
                targetRecordSha256: link.targetRecordSha256, targetRawSha256: link.targetRawSha256 }))
            .sort((left, right) => left.ordinal - right.ordinal);
        const requiredPageKeys = [...new Set(links.map(link => link.targetPageKey))].sort();
        const requiredPaperIds = [...new Set(requiredPageKeys.map(pageKey => paperByPageKey.get(pageKey).paperId))].sort();
        if (!requiredPageKeys.length || links.some(link => !Number.isSafeInteger(link.ordinal) || link.ordinal < 1
            || !validSha(link.targetRecordSha256) || !validSha(link.targetRawSha256))) {
            fail(`conference task ${page.pageKey} has no complete frozen link-topology membership`);
        }
        return projectionConferenceTaskPage({ pageKey: page.pageKey, path: page.path, primaryUrl: page.primaryUrl,
            previousContentSha256: page.previousContentSha256, conferenceKey: page.scope.key,
            legacyTaskKey: page.legacyTaskKey, displayLabel: page.displayLabel, requiredPaperIds, requiredPageKeys,
            membershipEvidence: { contract: 'frozen-conference-task-link-topology-v1',
                inventoryPageSha256: page.previousContentSha256, links,
                linkSetSha256: stableHash(links) }, status: 'planned', rendererSupport: TASK_RENDERER,
            publicationDisposition: 'rewrite', reason: null }, `conference task ${page.pageKey}`);
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const conferenceTaskCoverage = conferenceTaskCoverageFor(conferenceTaskPages, normalizedPlan.inventory.pageSetSha256);
    const selectedAggregatePageKeys = new Set([...daily, ...conference].map(item => item.outputPage.pageKey));
    const retainedPages = pages.filter(page => ['daily-summary', 'conference-summary'].includes(page.kind)
        && !selectedAggregatePageKeys.has(page.pageKey)).map(page => projectionRetainedPage({
        pageKey: page.pageKey, path: page.path, primaryUrl: page.primaryUrl,
        previousContentSha256: page.previousContentSha256, kind: page.kind, scope: page.scope,
        publicationDisposition: 'retain-unchanged', reason: RETAIN_UNCHANGED_REASON
    }, `retained page ${page.pageKey}`)).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    const coveredPageKeys = [...new Set([...normalizedPlan.projectedPages.map(page => page.pageKey),
        ...daily.map(item => item.outputPage.pageKey), ...conference.map(item => item.outputPage.pageKey),
        ...conferenceTaskPages.map(page => page.pageKey), ...retainedPages.map(page => page.pageKey)])].sort();
    const inventoryPageKeys = pages.map(page => page.pageKey).sort();
    const pageCoverage = { inventoryPageCount: inventoryPageKeys.length, coveredPageCount: coveredPageKeys.length,
        paperPageCount: normalizedPlan.projectedPages.length, aggregatePageCount: daily.length + conference.length,
        conferenceTaskPageCount: conferenceTaskPages.length, retainedUnchangedPageCount: retainedPages.length,
        uncoveredPageKeys: inventoryPageKeys.filter(pageKey => !coveredPageKeys.includes(pageKey)),
        coveredPageSetSha256: stableHash(coveredPageKeys), publicationReady: false };
    pageCoverage.publicationReady = pageCoverage.uncoveredPageKeys.length === 0
        && pageCoverage.coveredPageCount === pageCoverage.inventoryPageCount;
    const body = { contract: PROJECTION_CONTRACT, version: PROJECTION_VERSION, planSha256: normalizedPlan.planSha256,
        inventory: clone(normalizedPlan.inventory), daily, dailySetSha256: stableHash(daily),
        conference, conferenceSetSha256: stableHash(conference), conferenceTaskPages,
        conferenceTaskPageSetSha256: stableHash(conferenceTaskPages), conferenceTaskCoverage,
        conferenceTaskCoverageSha256: stableHash(conferenceTaskCoverage), retainedPages,
        retainedPageSetSha256: stableHash(retainedPages), pageCoverage,
        pageCoverageSha256: stableHash(pageCoverage) };
    return { ...body, projectionSha256: stableHash(body) };
}
function normalizeAggregateProjection(value, plan) {
    const normalizedPlan = planApi.normalizePlan(plan);
    exact(value, ['contract', 'version', 'planSha256', 'inventory', 'daily', 'dailySetSha256',
        'conference', 'conferenceSetSha256', 'conferenceTaskPages', 'conferenceTaskPageSetSha256',
        'conferenceTaskCoverage', 'conferenceTaskCoverageSha256', 'retainedPages', 'retainedPageSetSha256',
        'pageCoverage', 'pageCoverageSha256', 'projectionSha256'], 'direct aggregate projection');
    if (value.contract !== PROJECTION_CONTRACT || value.version !== PROJECTION_VERSION || value.planSha256 !== normalizedPlan.planSha256
        || !plain(value.inventory) || Object.keys(value.inventory).sort().join('\0') !== ['ledgerSha256', 'pageSetSha256'].join('\0')
        || value.inventory.ledgerSha256 !== normalizedPlan.inventory.ledgerSha256
        || value.inventory.pageSetSha256 !== normalizedPlan.inventory.pageSetSha256 || !Array.isArray(value.daily)
        || !Array.isArray(value.conference) || !Array.isArray(value.conferenceTaskPages) || !Array.isArray(value.retainedPages)
        || !validSha(value.dailySetSha256) || !validSha(value.conferenceSetSha256)
        || !validSha(value.conferenceTaskPageSetSha256) || !validSha(value.conferenceTaskCoverageSha256)
        || !validSha(value.retainedPageSetSha256) || !validSha(value.pageCoverageSha256)
        || !validSha(value.projectionSha256)) fail('direct aggregate projection envelope is invalid');
    const seenPages = new Set();
    const normalizeCohort = (item, index, scope) => {
        exact(item, ['scope', 'key', 'outputPage', 'requiredPaperIds', 'requiredPageKeys'], `${scope}[${index}]`);
        if (item.scope !== scope || typeof item.key !== 'string' || (scope === 'daily' && !DATE_RE.test(item.key))
            || !Array.isArray(item.requiredPaperIds) || !item.requiredPaperIds.length || !Array.isArray(item.requiredPageKeys)
            || !item.requiredPageKeys.length) fail(`${scope}[${index}] is invalid`);
        const outputPage = projectionOutputPage(item.outputPage, `${scope}[${index}].outputPage`);
        if (seenPages.has(outputPage.pageKey)) fail('aggregate output page is duplicated');
        seenPages.add(outputPage.pageKey);
        const expected = cohortEntries(normalizedPlan, scope, item.key);
        const paperIds = item.requiredPaperIds.slice().sort(); const pageKeys = item.requiredPageKeys.slice().sort();
        if (new Set(paperIds).size !== paperIds.length || new Set(pageKeys).size !== pageKeys.length
            || paperIds.join('\0') !== expected.requiredPaperIds.join('\0') || pageKeys.join('\0') !== expected.requiredPageKeys.join('\0')) {
            fail(`${scope}:${item.key} membership differs from direct plan`);
        }
        return { scope, key: item.key, outputPage, requiredPaperIds: paperIds, requiredPageKeys: pageKeys };
    };
    const daily = value.daily.map((item, index) => normalizeCohort(item, index, 'daily')).sort((a, b) => a.key.localeCompare(b.key));
    const conference = value.conference.map((item, index) => normalizeCohort(item, index, 'conference')).sort((a, b) => a.key.localeCompare(b.key));
    const conferenceTaskPages = value.conferenceTaskPages.map((item, index) =>
        projectionConferenceTaskPage(item, `conferenceTaskPages[${index}]`));
    if (new Set(conferenceTaskPages.map(item => item.pageKey)).size !== conferenceTaskPages.length
        || new Set(conferenceTaskPages.map(item => item.path)).size !== conferenceTaskPages.length
        || conferenceTaskPages.some((item, index) => index && conferenceTaskPages[index - 1].pageKey.localeCompare(item.pageKey) >= 0)
        || stableHash(conferenceTaskPages) !== value.conferenceTaskPageSetSha256) {
        fail('conference task page coverage is duplicate, unsorted, or hash-drifted');
    }
    const expectedTaskCoverage = conferenceTaskCoverageFor(conferenceTaskPages, normalizedPlan.inventory.pageSetSha256);
    if (!plain(value.conferenceTaskCoverage)
        || stableHash(value.conferenceTaskCoverage) !== value.conferenceTaskCoverageSha256
        || stableHash(value.conferenceTaskCoverage) !== stableHash(expectedTaskCoverage)) {
        fail('conference task coverage report drifted');
    }
    for (const task of conferenceTaskPages) {
        const expectedPageKeys = [...new Set(normalizedPlan.queue.filter(item => task.requiredPaperIds.includes(item.paperId))
            .flatMap(item => item.pages.filter(page => page.scope.type === 'conference' && page.scope.key === task.conferenceKey)
                .map(page => page.pageKey)).filter(pageKey => task.requiredPageKeys.includes(pageKey)))].sort();
        const expectedPaperIds = [...new Set(task.requiredPageKeys.map(pageKey => normalizedPlan.queue.find(item =>
            item.pages.some(page => page.pageKey === pageKey && page.scope.type === 'conference'
                && page.scope.key === task.conferenceKey))?.paperId))].sort();
        if (expectedPageKeys.join('\0') !== task.requiredPageKeys.join('\0')
            || expectedPaperIds.some(value => !value) || expectedPaperIds.join('\0') !== task.requiredPaperIds.join('\0')
            || task.membershipEvidence.contract !== 'frozen-conference-task-link-topology-v1'
            || !Array.isArray(task.membershipEvidence.links)
            || stableHash(task.membershipEvidence.links) !== task.membershipEvidence.linkSetSha256
            || task.membershipEvidence.inventoryPageSha256 !== task.previousContentSha256) {
            fail(`conference task ${task.pageKey} membership differs from direct plan or frozen topology`);
        }
    }
    const retainedPages = value.retainedPages.map((item, index) => projectionRetainedPage(item, `retainedPages[${index}]`));
    if (new Set(retainedPages.map(item => item.pageKey)).size !== retainedPages.length
        || retainedPages.some((item, index) => index && retainedPages[index - 1].pageKey.localeCompare(item.pageKey) >= 0)
        || stableHash(retainedPages) !== value.retainedPageSetSha256) fail('retained page dispositions are duplicate, unsorted, or hash-drifted');
    const expectedDailyKeys = [...new Set(normalizedPlan.projectedPages.filter(page => page.scope.type === 'daily')
        .map(page => page.scope.key))].sort();
    const expectedConferenceKeys = [...new Set(normalizedPlan.projectedPages.filter(page => page.scope.type === 'conference')
        .map(page => page.scope.key))].sort();
    if (daily.some((item, index) => index && daily[index - 1].key >= item.key)
        || conference.some((item, index) => index && conference[index - 1].key >= item.key)
        || daily.map(item => item.key).join('\0') !== expectedDailyKeys.join('\0')
        || conference.map(item => item.key).join('\0') !== expectedConferenceKeys.join('\0')
        || stableHash(daily) !== value.dailySetSha256 || stableHash(conference) !== value.conferenceSetSha256) {
        fail('direct aggregate projection cohort coverage, ordering, or hash drifted');
    }
    const coveredPageKeys = [...new Set([...normalizedPlan.projectedPages.map(page => page.pageKey),
        ...daily.map(item => item.outputPage.pageKey), ...conference.map(item => item.outputPage.pageKey),
        ...conferenceTaskPages.map(page => page.pageKey), ...retainedPages.map(page => page.pageKey)])].sort();
    const expectedCoverage = { inventoryPageCount: value.pageCoverage?.inventoryPageCount,
        coveredPageCount: coveredPageKeys.length, paperPageCount: normalizedPlan.projectedPages.length,
        aggregatePageCount: daily.length + conference.length, conferenceTaskPageCount: conferenceTaskPages.length,
        retainedUnchangedPageCount: retainedPages.length, uncoveredPageKeys: [],
        coveredPageSetSha256: stableHash(coveredPageKeys), publicationReady: true };
    if (!plain(value.pageCoverage) || value.pageCoverage.inventoryPageCount !== coveredPageKeys.length
        || stableHash(value.pageCoverage) !== value.pageCoverageSha256
        || stableHash(value.pageCoverage) !== stableHash(expectedCoverage)) fail('aggregate projection full-page coverage drifted');
    const body = { contract: value.contract, version: value.version, planSha256: value.planSha256,
        inventory: clone(value.inventory), daily, dailySetSha256: value.dailySetSha256,
        conference, conferenceSetSha256: value.conferenceSetSha256, conferenceTaskPages,
        conferenceTaskPageSetSha256: value.conferenceTaskPageSetSha256,
        conferenceTaskCoverage: clone(value.conferenceTaskCoverage),
        conferenceTaskCoverageSha256: value.conferenceTaskCoverageSha256,
        retainedPages, retainedPageSetSha256: value.retainedPageSetSha256,
        pageCoverage: clone(value.pageCoverage), pageCoverageSha256: value.pageCoverageSha256 };
    if (stableHash(body) !== value.projectionSha256) fail('direct aggregate projection self-SHA drifted');
    return { ...body, projectionSha256: value.projectionSha256 };
}
function writeAggregateProjection({ root, outputName, projection, plan } = {}) {
    if (!planApi.SAFE_NAME_RE.test(String(outputName || ''))) fail('direct aggregate projection output name is unsafe');
    const normalizedPlan = planApi.normalizePlan(plan);
    const normalized = normalizeAggregateProjection(projection, normalizedPlan);
    const directory = safeRoot(root, 'direct aggregate projection root', true);
    const filename = path.join(directory, outputName); const bytes = prettyBytes(normalized); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'created', filename, fileSha256: sha256(bytes), projection: normalized };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = projectionIo.readStableFile(filename, 'existing direct aggregate projection');
        if (!existing.bytes.equals(bytes)) fail(`refuses to overwrite different direct aggregate projection: ${outputName}`);
        return { status: 'recovered', filename, fileSha256: existing.fileSha256, projection: normalized };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function exactRegistryEntry(entry, item) {
    exact(entry, ['paperId', 'runId', 'route', 'projectionSha256', 'status', 'source', 'analysis', 'staging',
        'attempts', 'latestError', 'updatedAt'], `direct execution registry ${item.paperId}`);
    if (entry.paperId !== item.paperId || entry.runId !== item.runId || entry.route !== item.route.kind
        || entry.projectionSha256 !== item.projectionSha256 || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0
        || typeof entry.updatedAt !== 'string' || Number.isNaN(Date.parse(entry.updatedAt))) fail(`${item.paperId} execution registry entry drifted`);
    return clone(entry);
}
function expectedSource(entry, item) {
    if (item.route.kind === 'arxiv-fresh-fetch') {
        exact(entry.source, ['kind', 'paperId', 'generation', 'sourceId', 'textSha256', 'structuredArtifactsSha256', 'pdfSha256', 'sourceManifestSha256',
            'sourceBinding', 'sourceRunIdentitySha256', 'sourceSnapshotSha256'], `${item.paperId} arXiv source`);
        if (entry.source.kind !== item.route.kind || entry.source.paperId !== item.paperId || !Number.isSafeInteger(entry.source.generation)
            || entry.source.generation < 1 || !validSha(entry.source.textSha256) || !validSha(entry.source.pdfSha256)
            || !validSha(entry.source.structuredArtifactsSha256) || typeof entry.source.sourceId !== 'string' || !entry.source.sourceId
            || !validSha(entry.source.sourceManifestSha256) || !validSha(entry.source.sourceRunIdentitySha256)
            || !validSha(entry.source.sourceSnapshotSha256)) fail(`${item.paperId} arXiv source descriptor is invalid`);
        const sourceBinding = planApi.normalizeFreshArxivSourceBinding(item, entry.source.sourceBinding);
        if (sourceBinding.generation !== entry.source.generation || sourceBinding.textSha256 !== entry.source.textSha256
            || sourceBinding.pdfSha256 !== entry.source.pdfSha256 || sourceBinding.sourceManifestSha256 !== entry.source.sourceManifestSha256
            || planApi.directSourceRunIdentity(item, sourceBinding) !== entry.source.sourceRunIdentitySha256) {
            fail(`${item.paperId} arXiv source descriptor drifted`);
        }
        return clone(entry.source);
    }
    exact(entry.source, ['kind', 'paperId', 'sourceId', 'pdfSha256', 'textSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256'], `${item.paperId} conference source`);
    if (entry.source.kind !== item.route.kind || entry.source.paperId !== item.paperId || !validSha(entry.source.pdfSha256)
        || !validSha(entry.source.textSha256) || !validSha(entry.source.structuredArtifactsSha256)
        || typeof entry.source.sourceId !== 'string' || !entry.source.sourceId || !validSha(entry.source.sourceSnapshotSha256)) fail(`${item.paperId} conference source descriptor is invalid`);
    return clone(entry.source);
}
function expectedArtifact(entry, item, source) {
    const analysisFields = ['directory', 'analysisFileSha256', 'analysisRecordSha256', 'sourceSnapshotSha256'];
    if (Object.hasOwn(entry.analysis || {}, 'recovery')) analysisFields.push('recovery');
    exact(entry.analysis, analysisFields, `${item.paperId} analysis record`);
    exact(entry.staging, ['directory', 'stagingBindingSha256', 'analysisArtifact', 'pageStaging'], `${item.paperId} staging record`);
    if (typeof entry.analysis.directory !== 'string' || !validSha(entry.analysis.analysisFileSha256)
        || !validSha(entry.analysis.analysisRecordSha256) || entry.analysis.sourceSnapshotSha256 !== source.sourceSnapshotSha256
        || typeof entry.staging.directory !== 'string' || !validSha(entry.staging.stagingBindingSha256)
        || !plain(entry.staging.analysisArtifact)) fail(`${item.paperId} execution/staging record is invalid`);
    if (entry.analysis.recovery) {
        exact(entry.analysis.recovery, ['filename', 'fileSha256', 'recoverySha256', 'recordSha256', 'updatedAt'],
            `${item.paperId} analysis recovery receipt`);
        if (typeof entry.analysis.recovery.filename !== 'string' || !path.isAbsolute(entry.analysis.recovery.filename)
            || !validSha(entry.analysis.recovery.fileSha256) || !validSha(entry.analysis.recovery.recoverySha256)
            || !validSha(entry.analysis.recovery.recordSha256)
            || Number.isNaN(Date.parse(entry.analysis.recovery.updatedAt || ''))
            || new Date(entry.analysis.recovery.updatedAt).toISOString() !== entry.analysis.recovery.updatedAt) {
            fail(`${item.paperId} analysis recovery receipt is invalid`);
        }
    }
    const required = ['paperId', 'runId', 'route', 'analysisFileSha256', 'analysisRecordSha256', 'sourceSnapshotSha256'];
    if (item.route.kind === 'arxiv-fresh-fetch') required.push('sourceGeneration', 'sourceManifestSha256',
        'sourceTextSha256', 'sourcePdfSha256', 'sourceRunIdentitySha256');
    exact(entry.staging.analysisArtifact, required, `${item.paperId} staging analysis artifact`);
    const artifact = clone(entry.staging.analysisArtifact);
    if (artifact.paperId !== item.paperId || artifact.runId !== item.runId || artifact.route !== item.route.kind
        || artifact.analysisFileSha256 !== entry.analysis.analysisFileSha256 || artifact.analysisRecordSha256 !== entry.analysis.analysisRecordSha256
        || artifact.sourceSnapshotSha256 !== source.sourceSnapshotSha256) fail(`${item.paperId} staging analysis artifact drifted`);
    if (item.route.kind === 'arxiv-fresh-fetch' && (artifact.sourceGeneration !== source.generation
        || artifact.sourceManifestSha256 !== source.sourceManifestSha256 || artifact.sourceTextSha256 !== source.textSha256
        || artifact.sourcePdfSha256 !== source.pdfSha256 || artifact.sourceRunIdentitySha256 !== source.sourceRunIdentitySha256)) {
        fail(`${item.paperId} staging source generation drifted`);
    }
    exact(entry.staging.pageStaging, ['manifestSha256', 'rendererImplementationSha256', 'pageSetSha256', 'assetSetSha256'], `${item.paperId} page staging receipt`);
    if (!validSha(entry.staging.pageStaging.manifestSha256) || !validSha(entry.staging.pageStaging.rendererImplementationSha256)
        || !validSha(entry.staging.pageStaging.pageSetSha256) || !validSha(entry.staging.pageStaging.assetSetSha256)) {
        fail(`${item.paperId} page staging receipt is invalid`);
    }
    return artifact;
}
function readAnalysis(entry, item, artifact, executionRoot, source) {
    const directory = inside(executionRoot, entry.analysis.directory, `${item.paperId} analysis directory`);
    const sourceSegment = item.route.kind === 'arxiv-fresh-fetch' ? artifact.sourceRunIdentitySha256 : 'conference-local';
    if (directory !== path.join(executionRoot, item.runId, sourceSegment)) fail(`${item.paperId} analysis directory differs from direct route`);
    const loaded = readJson(path.join(directory, 'analysis.json'), `${item.paperId} direct analysis`);
    if (loaded.fileSha256 !== artifact.analysisFileSha256 || stableHash(loaded.value) !== artifact.analysisRecordSha256) {
        fail(`${item.paperId} direct analysis bytes drifted from staging artifact`);
    }
    if (entry.analysis.recovery) {
        const recovery = runnerApi.readAnalysisRecovery({ executionDirectory: directory, item, sourceDescriptor: source });
        const expected = entry.analysis.recovery;
        if (recovery.filename !== expected.filename || recovery.fileSha256 !== expected.fileSha256
            || recovery.recoverySha256 !== expected.recoverySha256 || recovery.recordSha256 !== expected.recordSha256
            || recovery.updatedAt !== expected.updatedAt) fail(`${item.paperId} analysis recovery receipt drifted`);
    }
    const analysis = loaded.value;
    if (!plain(analysis) || text(analysis.title, `${item.paperId} analysis title`, 2000) === ''
        || typeof analysis.analysis !== 'string' || !analysis.analysis.trim()
        || typeof analysis.apiReaderArticle !== 'string' || !analysis.apiReaderArticle.trim()
        || !validSha(analysis.apiReaderArticleSha256)
        || analysis.apiReaderArticleSha256 !== sha256(Buffer.from(analysis.apiReaderArticle, 'utf8'))) {
        fail(`${item.paperId} direct analysis/Reader proof is incomplete`);
    }
    const parsed = parseAnalysis(analysis.analysis);
    const score = Number(parsed?.score); const labels = Array.isArray(parsed?.tags) ? parsed.tags.slice() : [];
    if (!Number.isFinite(score) || score < 0 || score > 10 || !text(String(parsed?.summary || '').trim(), `${item.paperId} core summary`, 20000)
        || !parsed?.taxonomyValidation?.valid || !parsed.primaryTaskTag || !parsed.primaryMethodTag || labels.length < 3) {
        fail(`${item.paperId} direct canonical analysis cannot supply aggregate fields`);
    }
    const taxonomyValidation = parsed.taxonomyValidation;
    if (taxonomyValidation.registryVersion !== taxonomyRuntime.registryVersion
        || taxonomyValidation.registrySha256 !== taxonomyRuntime.registrySha256) {
        fail(`${item.paperId} direct canonical taxonomy differs from current registry`);
    }
    const articleHeading = analysis.apiReaderArticle.match(/^#{1,6}\s+([^\n]+)$/m)?.[1]?.trim();
    const readerTitle = text(String(analysis.apiReaderPlan?.readerTitle || articleHeading || analysis.title).trim(),
        `${item.paperId} Reader title`, 500);
    const documentType = text(String(parsed.documentType || '').trim(), `${item.paperId} document type`, 100);
    const rankBucket = text(String(parsed.rankBucket || '').trim(), `${item.paperId} rank bucket`, 100);
    const authors = analysis.apiReaderAuthors?.authors;
    if (!Array.isArray(authors) || !authors.length || authors.some(author => !plain(author)
        || typeof author.name !== 'string' || !author.name.trim() || !Array.isArray(author.affiliations)
        || !author.affiliations.length || author.affiliations.some(value => typeof value !== 'string' || !value.trim()))) {
        fail(`${item.paperId} Reader author/affiliation projection is invalid`);
    }
    const resources = analysis.apiReaderResources?.resources;
    if (!Array.isArray(resources) || resources.some(resource => !plain(resource)
        || typeof resource.type !== 'string'
        || !(resource.status === null || typeof resource.status === 'string'
            || Number.isSafeInteger(resource.status))
        || typeof resource.availability !== 'string' || typeof (resource.finalUrl || resource.originalUrl) !== 'string')) {
        fail(`${item.paperId} Reader resource projection is invalid`);
    }
    const scoreDimensions = [['创新性', parsed.innovationScore], ['技术严谨性', parsed.technicalRigorScore],
        ['实验充分性', parsed.experimentalSufficiencyScore], ['清晰度', parsed.clarityScore],
        ['影响力', parsed.impactScore], ['开源', parsed.openSourceScore], ['可复现性', parsed.reproducibilityScore],
        ['工程/实践价值', parsed.engineeringScore]].map(([label, value]) => ({ label, value: Number(value) }));
    if (scoreDimensions.some(dimension => !Number.isFinite(dimension.value))) fail(`${item.paperId} eight-dimensional score is incomplete`);
    return { analysis, analysisFileSha256: loaded.fileSha256, analysisRecordSha256: stableHash(analysis),
        readerArticleSha256: analysis.apiReaderArticleSha256, title: analysis.title.trim(), readerTitle,
        summary: parsed.summary.trim(), score, documentType, rankBucket, scoreDimensions,
        labels: labels.map(label => label.replace(/^#/, '')).sort(), primaryTaskLabel: parsed.primaryTaskTag.replace(/^#/, ''),
        primaryMethodLabel: parsed.primaryMethodTag.replace(/^#/, ''),
        authors: authors.map(author => ({ name: author.name.trim(), affiliations: author.affiliations.map(value => value.trim()) })),
        resources: resources.map(resource => ({ type: resource.type,
            status: resource.status === null ? '未取得 HTTP 状态' : String(resource.status),
            availability: resource.availability, url: resource.finalUrl || resource.originalUrl })),
        taxonomy: { selectionContract: taxonomyRuntime.selectionContract,
            registryVersion: taxonomyRuntime.registryVersion, registrySha256: taxonomyRuntime.registrySha256 } };
}
function loadStagedMember({ plan, registryEntry, item, stagingRoot, executionRoot }) {
    const entry = exactRegistryEntry(registryEntry, item);
    if (entry.status !== 'staged') fail(`${item.paperId} is not staged; aggregate requires complete cohort staging`);
    const source = expectedSource(entry, item); const artifact = expectedArtifact(entry, item, source);
    const directory = inside(stagingRoot, entry.staging.directory, `${item.paperId} staging directory`);
    const segment = item.route.kind === 'arxiv-fresh-fetch' ? source.sourceRunIdentitySha256 : 'conference-local';
    if (directory !== path.join(stagingRoot, item.runId, segment)) fail(`${item.paperId} staging directory differs from direct route`);
    const loaded = readJson(path.join(directory, 'staging-input.json'), `${item.paperId} staging input`);
    const stage = loaded.value;
    exact(stage, ['contract', 'version', 'paperId', 'runId', 'analysisArtifact', 'stagingBinding', 'stagingBindingSha256'], `${item.paperId} staging input`);
    if (stage.contract !== runnerApi.STAGING_CONTRACT || stage.version !== 1 || stage.paperId !== item.paperId || stage.runId !== item.runId
        || stableHash(stage.analysisArtifact) !== stableHash(artifact) || !validSha(stage.stagingBindingSha256)
        || stage.stagingBindingSha256 !== stableHash(stage.stagingBinding) || entry.staging.stagingBindingSha256 !== stage.stagingBindingSha256) {
        fail(`${item.paperId} staging input drifted from execution registry`);
    }
    const stageRegistry = planApi.buildRegistry(plan, item.route.kind === 'arxiv-fresh-fetch' ? { sourceBindings: [source.sourceBinding] } : {});
    const expectedBinding = planApi.directStagingBinding({ plan, registry: stageRegistry, paperId: item.paperId, analysisArtifact: artifact });
    if (stableHash(stage.stagingBinding) !== stableHash(expectedBinding)) fail(`${item.paperId} staging binding cannot replay direct source contract`);
    const canonical = readAnalysis(entry, item, artifact, executionRoot, source);
    const pageManifestFile = path.join(directory, 'page-staging-manifest.json');
    const pageManifest = directPages.validateManifest({
        value: readJson(pageManifestFile, `${item.paperId} direct page manifest`).value,
        item, sourceDescriptor: source, artifact, analysis: canonical.analysis,
        stagingInputSha256: loaded.fileSha256, stagingBindingSha256: stage.stagingBindingSha256,
        directory, rendererImplementationSha256: entry.staging.pageStaging.rendererImplementationSha256
    });
    if (stableHash(directPages.receipt(pageManifest)) !== stableHash(entry.staging.pageStaging)) {
        fail(`${item.paperId} direct page staging receipt drifted from execution registry`);
    }
    return { item, source, artifact, stageFileSha256: loaded.fileSha256, stagingBindingSha256: stage.stagingBindingSha256,
        pageStaging: pageManifest, canonical };
}
function loadDirectAggregateInputs({ planFile, registryFile, projectionFile, stagingRoot, executionRoot } = {}) {
    if (typeof planFile !== 'string' || typeof registryFile !== 'string' || typeof projectionFile !== 'string') {
        fail('plan, registry, and aggregate projection files are required');
    }
    const planLoaded = readJson(planFile, 'direct aggregate plan'); const plan = planApi.normalizePlan(planLoaded.value);
    const registryLoaded = readJson(registryFile, 'direct execution registry'); const registry = runnerApi.normalizeRegistry(registryLoaded.value, plan);
    const projectionLoaded = readJson(projectionFile, 'direct aggregate projection');
    const projection = normalizeAggregateProjection(projectionLoaded.value, plan);
    const staging = safeRoot(stagingRoot, 'direct staging root'); const executions = safeRoot(executionRoot, 'direct execution root');
    const byId = new Map(registry.entries.map(entry => [entry.paperId, entry]));
    if (byId.size !== registry.entries.length) fail('direct execution registry has duplicate paper IDs');
    const members = new Map();
    for (const item of plan.queue) {
        const entry = byId.get(item.paperId); if (!entry) fail(`${item.paperId} is missing from direct execution registry`);
        // Loading every staged member is intentionally deferred to the selected
        // cohort so unrelated in-progress work cannot block a finished cohort.
        members.set(item.paperId, { item, entry });
    }
    return { plan, planFileSha256: planLoaded.fileSha256, registry, registryFileSha256: registryLoaded.fileSha256,
        projection, projectionFileSha256: projectionLoaded.fileSha256, stagingRoot: staging, executionRoot: executions, members };
}

function md(value) { return String(value).replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\s+/g, ' ').trim(); }
function publicHttps(value, label) {
    let url;
    try { url = new URL(value); } catch { fail(`${label} is invalid`); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail(`${label} is not public HTTPS`);
    return url.href;
}
function renderAggregate(scope, key, members, options = {}) {
    const display = scope === 'daily' ? `语音/音乐/音频论文速递 ${key}`
        : scope === 'conference-task' ? `${options.conferenceKey.toUpperCase()} · ${options.displayLabel}`
            : `${key.toUpperCase()} 论文汇总`;
    const tags = [...new Set(members.flatMap(item => item.canonical.labels))].sort();
    const directionCounts = [...members.reduce((counts, item) => counts.set(item.canonical.primaryTaskLabel,
        (counts.get(item.canonical.primaryTaskLabel) || 0) + 1), new Map()).entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
    const taxonomy = members[0]?.canonical.taxonomy;
    if (!taxonomy || members.some(item => stableHash(item.canonical.taxonomy) !== stableHash(taxonomy))) {
        fail(`${scope}:${key} aggregate taxonomy metadata is missing or mixed`);
    }
    let output = `---\ntitle: "${display}"\ndraft: false\n`;
    output += `tags: ${JSON.stringify(tags)}\ncategories: ["论文速递"]\npaper_digest_pipeline_owned: true\npaper_digest_page_type: index\n`;
    output += 'paper_digest_reader_quality: "reader-facing-v3"\n';
    output += `paper_digest_taxonomy_contract: "${taxonomyRuntime.flatCompatContract}"\n`;
    output += `paper_digest_taxonomy_selection_contract: "${taxonomy.selectionContract}"\n`;
    output += `paper_digest_taxonomy_registry_version: "${taxonomy.registryVersion}"\n`;
    output += `paper_digest_taxonomy_registry_sha256: "${taxonomy.registrySha256}"\n`;
    output += 'paper_digest_taxonomy_scope: "aggregate-primary-task-counts"\n---\n\n';
    output += `# ${display}\n\n`;
    output += `本期共收录 **${members.length}** 篇完成 source-only 重写的论文。\n\n`;
    output += '🏷️ 标签说明：本期使用新版受控 taxonomy；站点标签页暂时兼容展示历史标签与新标签。\n\n';
    output += '## ⚡ 今日概览\n\n';
    output += '### 🏷️ 热门方向\n\n| 方向（仅主任务） | 数量 |\n|---|---:|\n';
    for (const [label, count] of directionCounts) output += `| #${md(label)} | ${count} 篇 |\n`;
    output += '\n### 📊 论文评分排行榜\n\n';
    output += '| 排名 | 论文 | 评分 | 主任务 | 主方法 |\n|---:|---|---:|---|---|\n';
    for (const member of members) output += `| ${member.rank} | [${md(member.canonical.readerTitle)}](${internalUrl(member.renderedPages[0].primaryUrl, `${member.item.paperId} page URL`)}) | ${member.canonical.score.toFixed(1)} | ${md(member.canonical.primaryTaskLabel)} | ${md(member.canonical.primaryMethodLabel)} |\n`;
    output += '\n---\n\n## 📋 论文列表\n';
    for (const member of members) {
        const blogUrl = internalUrl(member.renderedPages[0].primaryUrl, `${member.item.paperId} page URL`);
        output += `\n### ${member.rank}. [${md(member.canonical.readerTitle)}](${blogUrl})\n\n`;
        output += `> 英文题目：*[${md(member.canonical.title)}](${blogUrl})*\n\n`;
        output += `标签：${member.canonical.labels.map(label => `#${md(label)}`).join(' ')}\n\n`;
        output += `评分：${member.canonical.score.toFixed(1)}/10（${member.canonical.scoreDimensions.map(item => `${item.label} ${item.value}`).join('；')}）\n\n`;
        const source = member.item.route.kind === 'arxiv-fresh-fetch'
            ? ` | [arXiv 原文](https://arxiv.org/abs/${member.item.route.arxivId})` : '';
        output += `排名：${md(member.canonical.rankBucket)} | 文档类型：${md(member.canonical.documentType)}${source}\n\n`;
        output += '👥 **作者与机构**\n\n';
        for (const author of member.canonical.authors) output += `- ${md(author.name)}：${author.affiliations.map(md).join('；')}\n`;
        output += `\n📌 **核心摘要**\n\n${member.canonical.summary}\n\n`;
        output += '🔗 **开源资源**\n\n';
        if (!member.canonical.resources.length) output += '未发现已由来源证据绑定的公开资源。\n';
        for (const resource of member.canonical.resources) {
            output += `- ${md(resource.type)} · ${md(resource.status)} · ${md(resource.availability)}：<${publicHttps(resource.url, `${member.item.paperId} resource URL`)}>\n`;
        }
        output += '\n---\n';
    }
    return output;
}
function sourceGenerationFor(scope, key, staged) {
    const arxiv = staged.filter(member => member.item.route.kind === 'arxiv-fresh-fetch');
    const conference = staged.filter(member => member.item.route.kind === 'conference-local-pdf');
    if (arxiv.length + conference.length !== staged.length) fail(`${scope}:${key} has an unsupported source route`);
    if (['conference', 'conference-task'].includes(scope) && (arxiv.length || !conference.length)) {
        fail(`${scope}:${key} must use retained local conference PDFs`);
    }
    if (scope === 'daily' && !arxiv.length && !conference.length) fail(`${scope}:${key} has no source-bound members`);
    const generations = new Set(arxiv.map(member => member.source.generation));
    if (generations.size > 1) fail(`${scope}:${key} has mixed arXiv source generations`);
    const arxivBinding = arxiv.length ? {
        contract: 'fresh-arxiv-generation-v1', generation: [...generations][0],
        sourceManifestSetSha256: stableHash(arxiv.map(member => member.source.sourceManifestSha256).sort())
    } : null;
    const conferenceBinding = conference.length ? {
        contract: 'retained-local-conference-pdf-v1', generation: null,
        sourcePdfSetSha256: stableHash(conference.map(member => member.source.pdfSha256).sort())
    } : null;
    if (!arxivBinding) return conferenceBinding;
    if (!conferenceBinding) return arxivBinding;
    const arxivSources = arxiv.map(member => ({ paperId: member.item.paperId,
        sourceManifestSha256: member.source.sourceManifestSha256 })).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const conferenceSources = conference.map(member => ({ paperId: member.item.paperId,
        pdfSha256: member.source.pdfSha256 })).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const body = { contract: 'historical-direct-mixed-source-v1', version: 1,
        arxiv: { ...arxivBinding, sources: arxivSources, sourceSetSha256: stableHash(arxivSources) },
        conference: { ...conferenceBinding, sources: conferenceSources, sourceSetSha256: stableHash(conferenceSources) } };
    return { ...body, bindingSha256: stableHash(body) };
}
function buildCohort(inputs, cohort) {
    const selected = cohort.requiredPaperIds.map(paperId => inputs.members.get(paperId));
    if (selected.some(item => !item)) fail(`${cohort.scope}:${cohort.key} is missing a direct plan member`);
    const staged = selected.map(({ item, entry }) => loadStagedMember({ plan: inputs.plan, registryEntry: entry, item,
        stagingRoot: inputs.stagingRoot, executionRoot: inputs.executionRoot }));
    const memberScope = cohort.scope === 'conference-task' ? 'conference' : cohort.scope;
    const memberKey = cohort.scope === 'conference-task' ? cohort.conferenceKey : cohort.key;
    const pages = staged.flatMap(member => member.item.pages.filter(page => page.scope.type === memberScope
        && page.scope.key === memberKey && cohort.requiredPageKeys.includes(page.pageKey)));
    const actualKeys = pages.map(page => page.pageKey).sort();
    if (actualKeys.join('\0') !== cohort.requiredPageKeys.join('\0')) fail(`${cohort.scope}:${cohort.key} staging does not exactly cover the complete cohort`);
    const sourceGeneration = sourceGenerationFor(cohort.scope, cohort.key, staged);
    const members = staged.map(member => {
        const pages = member.item.pages.filter(page => page.scope.type === memberScope && page.scope.key === memberKey
            && cohort.requiredPageKeys.includes(page.pageKey));
        const rendered = new Map(member.pageStaging.pages.map(page => [page.pageKey, page]));
        const renderedPages = pages.map(page => rendered.get(page.pageKey));
        if (renderedPages.some(page => !page)) fail(`${member.item.paperId} aggregate member has an unrendered projected page`);
        return { ...member, pages, renderedPages };
    })
        .sort((left, right) => right.canonical.score - left.canonical.score || left.item.paperId.localeCompare(right.item.paperId))
        .map((member, index) => ({ rank: index + 1, ...member }));
    const markdown = renderAggregate(cohort.scope, cohort.key, members, cohort);
    const memberRecords = members.map(member => ({ rank: member.rank, paperId: member.item.paperId, runId: member.item.runId, route: member.item.route.kind,
        pageKeys: member.pages.map(page => page.pageKey).sort(), pagePaths: member.pages.map(page => page.pagePath).sort(),
        renderedPages: member.renderedPages.map(page => ({ pageKey: page.pageKey, stagedPath: page.stagedPath,
            contentSha256: page.contentSha256, primaryUrl: page.primaryUrl })).sort((left, right) => left.pageKey.localeCompare(right.pageKey)),
        sourceSnapshotSha256: member.artifact.sourceSnapshotSha256, sourceGeneration: member.item.route.kind === 'arxiv-fresh-fetch'
            ? member.source.generation : null, sourceManifestSha256: member.item.route.kind === 'arxiv-fresh-fetch'
            ? member.source.sourceManifestSha256 : null, analysisFileSha256: member.canonical.analysisFileSha256,
        analysisRecordSha256: member.canonical.analysisRecordSha256, readerArticleSha256: member.canonical.readerArticleSha256,
        stagingBindingSha256: member.stagingBindingSha256, score: member.canonical.score, title: member.canonical.title, summary: member.canonical.summary,
        labels: member.canonical.labels, primaryTaskLabel: member.canonical.primaryTaskLabel,
        primaryMethodLabel: member.canonical.primaryMethodLabel, readerTitle: member.canonical.readerTitle,
        documentType: member.canonical.documentType, rankBucket: member.canonical.rankBucket,
        scoreDimensions: member.canonical.scoreDimensions, authors: member.canonical.authors,
        resources: member.canonical.resources }));
    const outputPage = { ...cohort.outputPage, stagedPath: path.posix.join('pages', cohort.outputPage.path),
        contentSha256: sha256(Buffer.from(markdown, 'utf8')) };
    const body = { contract: CONTRACT, version: VERSION, status: 'complete', scope: cohort.scope, key: cohort.key,
        ...(cohort.scope === 'conference-task' ? { conferenceKey: cohort.conferenceKey,
            legacyTaskKey: cohort.legacyTaskKey, displayLabel: cohort.displayLabel,
            membershipEvidence: clone(cohort.membershipEvidence) } : {}),
        outputPage, source: { planSha256: inputs.plan.planSha256, planFileSha256: inputs.planFileSha256,
            registrySha256: inputs.registry.registrySha256, registryFileSha256: inputs.registryFileSha256,
            aggregateProjectionSha256: inputs.projection.projectionSha256, aggregateProjectionFileSha256: inputs.projectionFileSha256,
            conferenceTaskCoverageSha256: inputs.projection.conferenceTaskCoverageSha256,
            conferenceTaskPublicationReady: inputs.projection.conferenceTaskCoverage.publicationReady,
            sourceGeneration }, members: memberRecords, memberSetSha256: stableHash(memberRecords), markdown,
        markdownSha256: sha256(Buffer.from(markdown, 'utf8')) };
    return { ...body, manifestSha256: stableHash(body) };
}
function buildDirectAggregates({ inputs, daily = null, conference = null } = {}) {
    if (!inputs || !inputs.plan || !inputs.projection) fail('loaded direct aggregate inputs are required');
    const pick = (entries, key, label) => {
        if (key === null) return entries;
        if (typeof key !== 'string' || !key) fail(`${label} key is invalid`);
        const value = entries.filter(item => item.key === key); if (value.length !== 1) fail(`${label}:${key} is absent from aggregate projection`);
        return value;
    };
    if (daily !== null && conference !== null) fail('select either one daily or one conference cohort per aggregate run');
    const dailyCohorts = conference !== null ? [] : pick(inputs.projection.daily, daily, 'daily');
    const conferenceCohorts = daily !== null ? [] : pick(inputs.projection.conference, conference, 'conference');
    const taskCohorts = daily !== null ? [] : inputs.projection.conferenceTaskPages
        .filter(task => conference === null || task.conferenceKey === conference)
        .map(task => ({ ...task, scope: 'conference-task', key: `${task.conferenceKey}-${task.legacyTaskKey}`,
            outputPage: projectionOutputPage({ pageKey: task.pageKey, path: task.path, primaryUrl: task.primaryUrl,
                previousContentSha256: task.previousContentSha256 }, `conference task ${task.pageKey} output page`) }));
    if (!dailyCohorts.length && !conferenceCohorts.length) fail('direct aggregate projection has no selected cohort');
    // Task pages are written before their conference summary.  The summary is
    // therefore the completion marker for an atomic, restartable conference run.
    return [...dailyCohorts, ...taskCohorts, ...conferenceCohorts].map(cohort => buildCohort(inputs, cohort));
}
function aggregateRunIdFor(aggregates) {
    if (!Array.isArray(aggregates) || !aggregates.length || aggregates.some(item => !validSha(item?.manifestSha256))) fail('complete aggregate manifests are required');
    return uuidFromHash(aggregates.map(item => item.manifestSha256).sort().join('\0'));
}
function writeExactAggregateFile(filename, bytes, label) {
    const directory = safeRoot(path.dirname(filename), `${label} directory`, true); const payload = Buffer.from(bytes); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = projectionIo.readStableFile(filename, `existing ${label}`);
        if (!current.bytes.equals(payload)) fail(`refuses to overwrite different ${label}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const stored = projectionIo.readStableFile(filename, label);
    if (!stored.bytes.equals(payload)) fail(`${label} write verification failed`);
    return stored.fileSha256;
}
function writeDirectAggregates({ outputRoot, aggregateRunId, aggregates } = {}) {
    if (!UUID_RE.test(String(aggregateRunId || '')) || !Array.isArray(aggregates) || !aggregates.length) fail('aggregate run ID and manifests are required');
    const root = safeRoot(outputRoot, 'direct aggregate output root', true); const runRoot = safeRoot(path.join(root, aggregateRunId), 'direct aggregate run root', true);
    const outputs = [];
    for (const aggregate of aggregates) {
        const expected = { ...aggregate }; const manifestSha256 = expected.manifestSha256; delete expected.manifestSha256;
        if (aggregate.contract !== CONTRACT || aggregate.version !== VERSION || aggregate.status !== 'complete'
            || !['daily', 'conference', 'conference-task'].includes(aggregate.scope) || !validSha(manifestSha256) || stableHash(expected) !== manifestSha256) {
            fail('refuses to write an invalid direct aggregate manifest');
        }
        const name = `${aggregate.scope}-${aggregate.key}.json`;
        if (!/^(?:daily|conference|conference-task)-[a-z0-9-]{1,160}\.json$/.test(name)) fail('direct aggregate output name is unsafe');
        if (typeof aggregate.outputPage?.stagedPath !== 'string' || !aggregate.outputPage.stagedPath.startsWith('pages/content/posts/')
            || !validSha(aggregate.outputPage.contentSha256) || aggregate.outputPage.contentSha256 !== aggregate.markdownSha256) {
            fail(`direct aggregate ${aggregate.scope}:${aggregate.key} output-page staging binding is invalid`);
        }
        const pageFilename = path.resolve(runRoot, ...aggregate.outputPage.stagedPath.split('/'));
        if (!pageFilename.startsWith(`${path.join(runRoot, 'pages')}${path.sep}`)) fail('direct aggregate output page escapes run');
        const pageBytes = Buffer.from(aggregate.markdown, 'utf8');
        if (writeExactAggregateFile(pageFilename, pageBytes, `direct aggregate page ${aggregate.scope}:${aggregate.key}`) !== aggregate.outputPage.contentSha256) {
            fail(`direct aggregate ${aggregate.scope}:${aggregate.key} output-page SHA drifted`);
        }
        const filename = path.join(runRoot, name); const bytes = prettyBytes(aggregate);
        const fileSha256 = writeExactAggregateFile(filename, bytes, `direct aggregate ${aggregate.scope}:${aggregate.key}`);
        outputs.push({ scope: aggregate.scope, key: aggregate.key, filename, fileSha256, pageFilename,
            pageSha256: aggregate.outputPage.contentSha256 });
    }
    return outputs;
}

module.exports = { CONTRACT, VERSION, PROJECTION_CONTRACT, PROJECTION_VERSION, HistoricalDirectAggregateError,
    stableHash, buildAggregateProjection, normalizeAggregateProjection, writeAggregateProjection, loadDirectAggregateInputs,
    buildDirectAggregates, aggregateRunIdFor, writeDirectAggregates, renderAggregate };
