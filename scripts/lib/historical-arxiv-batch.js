'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const arxivApi = require('./arxiv-source-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');

const RECORD_CONTRACT = 'historical-arxiv-single-batch-record-v1';
const VERSION = 1;

function eligibleGroups(state) {
    const groups = new Map();
    for (const paper of state.source.papers) {
        const assignment = state.assignments[paper.pageKey];
        const hints = paper.identityHints;
        if (assignment?.status !== 'pending' || hints?.status !== 'single'
            || hints.candidates?.length !== 1) continue;
        const candidate = hints.candidates[0];
        if (candidate.scheme !== 'arxiv' || !/^\d{4}\.\d{4,5}$/.test(candidate.value)
            || !Array.isArray(candidate.sources) || !candidate.sources.length
            || candidate.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) continue;
        const item = groups.get(candidate.value) || { arxivId: candidate.value, pageKeys: [] };
        item.pageKeys.push(paper.pageKey); groups.set(candidate.value, item);
    }
    return [...groups.values()].map(item => ({ ...item, pageKeys: item.pageKeys.sort() }))
        .sort((left, right) => left.arxivId.localeCompare(right.arxivId));
}

function reusableAuthorityName(state, arxivId) {
    const names = new Set();
    for (const assignment of Object.values(state.assignments)) {
        if (assignment.status === 'verified' && assignment.sourceAuthority?.paperId === `arxiv:${arxivId}`) {
            names.add(assignment.sourceAuthority.authorityName);
        }
    }
    if (names.size > 1) throw new Error(`${arxivId} has conflicting verified authority names`);
    return names.size ? [...names][0] : `arxiv-${arxivId}-history.json`;
}

function attemptDirectory(root, crosswalkId) {
    const safeRoot = crosswalkApi.safeDirectory(root, { create: true });
    const directory = path.join(safeRoot, crosswalkId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        throw new Error('Historical arXiv batch record directory is unsafe');
    }
    return directory;
}

function writeAttemptRecord(root, record) {
    const body = { contract: RECORD_CONTRACT, version: VERSION, ...record };
    const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) };
    const directory = attemptDirectory(root, record.crosswalkId);
    const name = `arxiv-${record.arxivId.replace('.', '-')}-${record.attemptId}.json`;
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
        prepareAuthority: arxivApi.prepareArxivSourceAuthority,
        buildDecision: crosswalkApi.buildVerifiedDecisionArtifact,
        writeDecision: crosswalkApi.writeDecisionArtifact,
        loadDecision: crosswalkApi.loadDecisionHandle,
        applyDecision: crosswalkApi.applyDecision,
        uuid: () => crypto.randomUUID(), now: () => new Date().toISOString(), writeAttemptRecord };
}

async function runSingleHintBatch({ crosswalkRoot, authorityRoot, batchRoot, crosswalkId, owner,
    limit = null, apply = true } = {}, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides };
    const initial = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
    const allGroups = eligibleGroups(initial);
    const maximum = limit === 'pilot' ? 1 : limit === null ? allGroups.length : limit;
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Batch limit must be pilot, null, or a non-negative integer');
    const selected = allGroups.slice(0, maximum);
    if (!apply) return { status: 'dry-run', crosswalkId, eligibleIdentities: allGroups.length,
        eligiblePages: allGroups.reduce((count, item) => count + item.pageKeys.length, 0),
        selectedIdentities: selected.length, selectedPages: selected.reduce((count, item) => count + item.pageKeys.length, 0),
        identities: selected.map(item => ({ arxivId: item.arxivId, pageCount: item.pageKeys.length })) };

    const results = [];
    for (const group of selected) {
        const attemptId = deps.uuid(); const startedAt = deps.now(); let authorityName = null;
        const completedPageKeys = [];
        try {
            let current = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
            const pending = eligibleGroups(current).find(item => item.arxivId === group.arxivId)?.pageKeys || [];
            if (!pending.length) continue;
            authorityName = reusableAuthorityName(current, group.arxivId);
            const prepared = await deps.prepareAuthority({ authorityRoot, arxivId: group.arxivId,
                authorityName, apply: true, requireLiveAuthorization: true });
            for (const pageKey of pending) {
                current = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
                if (current.assignments[pageKey]?.status !== 'pending') continue;
                const operationId = deps.uuid();
                const artifact = deps.buildDecision({ state: current, pageKey,
                    authorityHandle: prepared.authorityHandle, operationId, actorId: owner });
                const decisionName = `batch-${group.arxivId.replace('.', '-')}-${attemptId}-${pageKey.slice(5)}.json`;
                const decisionFile = deps.writeDecision({ crosswalkRoot, crosswalkId, decisionName, artifact });
                const handle = deps.loadDecision(decisionFile, { authorityHandle: prepared.authorityHandle });
                deps.applyDecision({ crosswalkRoot, crosswalkId, decisionHandle: handle, owner });
                completedPageKeys.push(pageKey);
            }
            const after = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
            const remainingPageKeys = pending.filter(pageKey => after.assignments[pageKey]?.status === 'pending');
            const record = { crosswalkId, attemptId, arxivId: group.arxivId, authorityName,
                status: remainingPageKeys.length ? 'partial' : 'complete', startedAt, finishedAt: deps.now(),
                requestedPageKeys: pending, completedPageKeys, remainingPageKeys, error: null };
            deps.writeAttemptRecord(batchRoot, record); results.push(record);
        } catch (error) {
            const current = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
            const remainingPageKeys = group.pageKeys.filter(pageKey => current.assignments[pageKey]?.status === 'pending');
            const record = { crosswalkId, attemptId, arxivId: group.arxivId, authorityName,
                status: 'failed', startedAt, finishedAt: deps.now(), requestedPageKeys: group.pageKeys,
                completedPageKeys, remainingPageKeys, error: String(error.message).slice(0, 2000) };
            deps.writeAttemptRecord(batchRoot, record); results.push(record);
        }
    }
    const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
    const failures = results.filter(item => item.status !== 'complete');
    return { status: failures.length ? 'partial' : 'complete', crosswalkId,
        processedIdentities: results.length, processedPages: results.reduce((count, item) => count + item.completedPageKeys.length, 0),
        failures: failures.map(item => ({ arxivId: item.arxivId, error: item.error, remainingPages: item.remainingPageKeys.length })),
        remainingEligibleIdentities: eligibleGroups(final).length, crosswalkVerified: final.completion.verified,
        crosswalkTotal: final.completion.total, exitCode: failures.length ? 1 : 0 };
}

module.exports = { RECORD_CONTRACT, VERSION, eligibleGroups, reusableAuthorityName,
    attemptDirectory, writeAttemptRecord, runSingleHintBatch };
