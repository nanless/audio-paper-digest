'use strict';

// This is a fallback worker, not an inventory resolver. Its only selection
// inputs are named, immutable fresh-acquisition failure handoffs written by
// the direct arXiv source phase. It must never enumerate pending crosswalk
// hints: local/conference records use the direct route and fresh arXiv routes
// are retried there before a handoff can exist.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const arxivApi = require('./arxiv-source-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');
const planApi = require('./historical-direct-rewrite-plan.js');

const RECORD_CONTRACT = 'historical-arxiv-failure-handoff-batch-record-v2';
const VERSION = 2;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) { throw new Error(`Historical arXiv failure-handoff batch rejected: ${message}`); }
function same(value, expected) { return crosswalkApi.stableHash(value) === crosswalkApi.stableHash(expected); }

function assertHandoffMatchesCrosswalk(state, handoff) {
    if (!state || typeof state !== 'object' || !state.source || !state.assignments) fail('crosswalk state is invalid');
    if (state.source.ledgerSha256 !== handoff.inventory.ledgerSha256
        || state.source.pageSetSha256 !== handoff.inventory.pageSetSha256) {
        fail(`${handoff.arxivId} handoff is bound to another frozen inventory`);
    }
    const papers = new Map(state.source.papers.map(paper => [paper.pageKey, paper]));
    const seen = new Set();
    for (const binding of handoff.pageBindings) {
        const paper = papers.get(binding.pageKey);
        if (!paper || seen.has(binding.pageKey) || !hasOwn(state.assignments, binding.pageKey)) {
            fail(`${handoff.arxivId} handoff page is absent from the crosswalk`);
        }
        seen.add(binding.pageKey);
        if (paper.pagePath !== binding.pagePath || paper.pageContentSha256 !== binding.pageContentSha256
            || paper.primaryUrl !== binding.primaryUrl || paper.cohortDate !== binding.cohortDate
            || !same(paper.scope, binding.scope)) {
            fail(`${handoff.arxivId} frozen page binding drifted`);
        }
        const hints = paper.identityHints;
        const candidate = hints?.status === 'single' && hints.candidates?.length === 1 ? hints.candidates[0] : null;
        if (!candidate || candidate.scheme !== 'arxiv' || candidate.value !== handoff.arxivId
            || !Array.isArray(candidate.sources) || candidate.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))
            || !same(candidate.sources.slice().sort(), binding.historicalArxivLink.hintSources)) {
            fail(`${handoff.arxivId} no longer has the exact frozen non-title arXiv link`);
        }
    }
    return handoff.pageBindings.map(binding => binding.pageKey).sort();
}

function selectedGroups(state, handoffs) {
    if (!Array.isArray(handoffs) || !handoffs.length) fail('at least one named fresh-failure handoff is required');
    const arxivIds = new Set(); const pageKeys = new Set();
    return handoffs.map(({ handoffName, fileSha256, handoff }) => {
        if (!SAFE_NAME_RE.test(String(handoffName || '')) || !/^[a-f0-9]{64}$/.test(String(fileSha256 || ''))
            || !handoff || typeof handoff !== 'object' || !ARXIV_ID_RE.test(String(handoff.arxivId || ''))) {
            fail('fresh-failure handoff receipt is invalid');
        }
        if (arxivIds.has(handoff.arxivId)) fail(`duplicate arXiv failure handoff: ${handoff.arxivId}`);
        arxivIds.add(handoff.arxivId);
        const bindings = assertHandoffMatchesCrosswalk(state, handoff);
        for (const pageKey of bindings) {
            if (pageKeys.has(pageKey)) fail(`fresh-failure handoffs overlap at ${pageKey}`);
            pageKeys.add(pageKey);
        }
        return { arxivId: handoff.arxivId, pageKeys: bindings, handoffName, handoffFileSha256: fileSha256,
            handoffSha256: handoff.handoffSha256, generation: handoff.generation, handoff };
    }).sort((left, right) => left.arxivId.localeCompare(right.arxivId));
}

function reusableAuthorityName(state, arxivId) {
    const names = new Set();
    for (const assignment of Object.values(state.assignments)) {
        if (assignment.status === 'verified' && assignment.sourceAuthority?.paperId === `arxiv:${arxivId}`) {
            names.add(assignment.sourceAuthority.authorityName);
        }
    }
    if (names.size > 1) fail(`${arxivId} has conflicting verified authority names`);
    return names.size ? [...names][0] : `arxiv-${arxivId}-history.json`;
}

function attemptDirectory(root, crosswalkId) {
    const safeRoot = crosswalkApi.safeDirectory(root, { create: true });
    const directory = path.join(safeRoot, crosswalkId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        fail('attempt-record directory is unsafe');
    }
    return directory;
}

function writeAttemptRecord(root, record) {
    const body = { contract: RECORD_CONTRACT, version: VERSION, ...record };
    const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) };
    const directory = attemptDirectory(root, record.crosswalkId);
    const name = `arxiv-failure-handoff-${record.arxivId.replace('.', '-')}-${record.attemptId}.json`;
    const filename = path.join(directory, name); const bytes = crosswalkApi.prettyBytes(sealed);
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return { filename, record: sealed };
}

function defaultDependencies() {
    return { readCrosswalk: crosswalkApi.readCrosswalk,
        readFailureHandoff: planApi.readArxivFreshFailureHandoff,
        prepareAuthority: arxivApi.prepareArxivSourceAuthority,
        buildDecision: crosswalkApi.buildVerifiedDecisionArtifact,
        writeDecision: crosswalkApi.writeDecisionArtifact,
        loadDecision: crosswalkApi.loadDecisionHandle,
        applyDecision: crosswalkApi.applyDecision,
        uuid: () => crypto.randomUUID(), now: () => new Date().toISOString(), writeAttemptRecord };
}

function loadSelectedHandoffs({ handoffRoot, handoffNames }, deps) {
    if (typeof handoffRoot !== 'string' || !path.isAbsolute(handoffRoot)) fail('fresh-failure handoff root must be absolute');
    if (!Array.isArray(handoffNames) || !handoffNames.length || new Set(handoffNames).size !== handoffNames.length) {
        fail('one or more unique named fresh-failure handoffs are required');
    }
    return handoffNames.map(handoffName => {
        if (!SAFE_NAME_RE.test(String(handoffName || ''))) fail('fresh-failure handoff name is unsafe');
        const loaded = deps.readFailureHandoff({ root: handoffRoot, handoffName });
        return { handoffName, fileSha256: loaded.fileSha256, handoff: loaded.handoff };
    });
}

async function runSingleHintBatch({ crosswalkRoot, authorityRoot, handoffRoot, handoffNames, batchRoot, crosswalkId, owner,
    apply = true, concurrency = 2 } = {}, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides };
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) fail('concurrency must be an integer from 1 to 3');
    const initial = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
    const selected = selectedGroups(initial, loadSelectedHandoffs({ handoffRoot, handoffNames }, deps));
    if (!apply) return { status: 'dry-run', crosswalkId, handoffCount: selected.length,
        selectedIdentities: selected.length, selectedPages: selected.reduce((count, item) => count + item.pageKeys.length, 0),
        concurrency, identities: selected.map(item => ({ arxivId: item.arxivId, pageCount: item.pageKeys.length,
            handoffName: item.handoffName, generation: item.generation })) };

    const results = new Array(selected.length); let cursor = 0; let decisionTail = Promise.resolve();
    const serializeDecision = callback => {
        const pending = decisionTail.then(callback, callback); decisionTail = pending.catch(() => {}); return pending;
    };
    const currentPending = (state, group) => {
        // Do not expand to another page merely because it now has the same
        // arXiv hint. The immutable handoff is the complete eligibility list.
        assertHandoffMatchesCrosswalk(state, group.handoff);
        return group.pageKeys.filter(pageKey => state.assignments[pageKey]?.status === 'pending');
    };
    const processGroup = async (group, resultIndex) => {
        const attemptId = deps.uuid(); const startedAt = deps.now(); let authorityName = null;
        const completedPageKeys = [];
        const recordBase = { crosswalkId, attemptId, arxivId: group.arxivId, handoffName: group.handoffName,
            handoffFileSha256: group.handoffFileSha256, handoffSha256: group.handoffSha256,
            handoffGeneration: group.generation };
        try {
            let current = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const pending = currentPending(current, group);
            if (!pending.length) {
                const record = { ...recordBase, authorityName: null, status: 'complete', startedAt, finishedAt: deps.now(),
                    requestedPageKeys: group.pageKeys, completedPageKeys: [], remainingPageKeys: [], error: null };
                deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record; return;
            }
            authorityName = reusableAuthorityName(current, group.arxivId);
            const prepared = await deps.prepareAuthority({ authorityRoot, arxivId: group.arxivId,
                authorityName, apply: true, requireLiveAuthorization: true });
            for (const pageKey of pending) {
                const applied = await serializeDecision(() => {
                    current = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); currentPending(current, group);
                    if (current.assignments[pageKey]?.status !== 'pending') return false;
                    const artifact = deps.buildDecision({ state: current, pageKey, authorityHandle: prepared.authorityHandle,
                        operationId: deps.uuid(), actorId: owner,
                        reason: `Fallback after sealed fresh-arXiv acquisition failure handoff ${group.handoffSha256}.` });
                    const decisionName = `fresh-failure-${group.arxivId.replace('.', '-')}-${attemptId}-${pageKey.slice(5)}.json`;
                    const decisionFile = deps.writeDecision({ crosswalkRoot, crosswalkId, decisionName, artifact });
                    const handle = deps.loadDecision(decisionFile, { authorityHandle: prepared.authorityHandle });
                    deps.applyDecision({ crosswalkRoot, crosswalkId, decisionHandle: handle, owner }); return true;
                });
                if (applied) completedPageKeys.push(pageKey);
            }
            const after = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const remainingPageKeys = currentPending(after, group);
            const record = { ...recordBase, authorityName, status: remainingPageKeys.length ? 'partial' : 'complete',
                startedAt, finishedAt: deps.now(), requestedPageKeys: pending, completedPageKeys, remainingPageKeys, error: null };
            deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record;
        } catch (error) {
            const current = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
            const remainingPageKeys = group.pageKeys.filter(pageKey => current.assignments[pageKey]?.status === 'pending');
            const record = { ...recordBase, authorityName, status: 'failed', startedAt, finishedAt: deps.now(),
                requestedPageKeys: group.pageKeys, completedPageKeys, remainingPageKeys, error: String(error.message).slice(0, 2000) };
            deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record;
        }
    };
    const worker = async () => { while (cursor < selected.length) { const index = cursor++; await processGroup(selected[index], index); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
    const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const complete = results.filter(Boolean);
    const failures = complete.filter(item => item.status !== 'complete');
    return { status: failures.length ? 'partial' : 'complete', crosswalkId, handoffCount: selected.length, concurrency,
        processedIdentities: complete.length, processedPages: complete.reduce((count, item) => count + item.completedPageKeys.length, 0),
        failures: failures.map(item => ({ arxivId: item.arxivId, handoffName: item.handoffName,
            error: item.error, remainingPages: item.remainingPageKeys.length })),
        crosswalkVerified: final.completion.verified, crosswalkTotal: final.completion.total, exitCode: failures.length ? 1 : 0 };
}

module.exports = { RECORD_CONTRACT, VERSION, assertHandoffMatchesCrosswalk, selectedGroups, reusableAuthorityName,
    attemptDirectory, writeAttemptRecord, loadSelectedHandoffs, runSingleHintBatch };
