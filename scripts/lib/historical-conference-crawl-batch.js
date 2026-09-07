'use strict';

// Retained conference metadata/PDF belongs to the direct local-source route.
// This legacy crosswalk writer is intentionally closed; title recovery may be
// used only by the direct projection contract, never to mutate a crosswalk.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const conferenceApi = require('./historical-conference-crawl-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');

const RECORD_CONTRACT = 'historical-conference-crawl-batch-record-v1';
const VERSION = 1;
const keyFor = hint => `${hint.scheme}:${hint.value}`;
function explicitHintGroups(state, matches) {
    const groups = new Map();
    for (const paper of state.source.papers) {
        if (state.assignments[paper.pageKey]?.status !== 'pending' || paper.identityHints?.status !== 'single' || paper.identityHints.candidates?.length !== 1) continue;
        const hint = paper.identityHints.candidates[0];
        if (!['icassp-arnumber', 'openreview-forum-id'].includes(hint.scheme) || !Array.isArray(hint.sources) || !hint.sources.length || hint.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) continue;
        const options = matches.get(keyFor(hint)) || [];
        if (options.length !== 1) continue;
        const item = groups.get(keyFor(hint)) || { externalId: { scheme: hint.scheme, value: hint.value }, match: options[0], pageKeys: [] };
        item.pageKeys.push(paper.pageKey); groups.set(keyFor(hint), item);
    }
    return [...groups.values()].map(item => ({ ...item, pageKeys: item.pageKeys.sort(), titleBindings: [] }));
}
function eligibleGroups(state, matches, { blogRoot = null } = {}) {
    const groups = explicitHintGroups(state, matches);
    if (blogRoot !== null) groups.push(...conferenceApi.titleRecoveryGroups({ state, blogRoot, matches }));
    return groups.sort((a, b) => keyFor(a.externalId).localeCompare(keyFor(b.externalId))
        || a.pageKeys.join(',').localeCompare(b.pageKeys.join(',')));
}
function mergeMatches(...indexes) {
    const merged = new Map();
    for (const index of indexes) for (const [key, values] of index.entries()) merged.set(key, [...(merged.get(key) || []), ...values]);
    for (const values of merged.values()) values.sort((a, b) => a.metadataSourceKind.localeCompare(b.metadataSourceKind)
        || a.metadataRelativePath.localeCompare(b.metadataRelativePath) || a.recordIndex - b.recordIndex);
    return merged;
}
function missingIclrTitleFingerprints(state, blogRoot, regularMatches) {
    const covered = new Set(eligibleGroups(state, regularMatches, { blogRoot }).flatMap(group => group.pageKeys)); const fingerprints = new Set();
    for (const page of state.source.papers) {
        if (page.scope?.key !== 'iclr-2026' || state.assignments[page.pageKey]?.status !== 'pending' || covered.has(page.pageKey)
            || !['none', 'conflict'].includes(page.identityHints?.status)) continue;
        fingerprints.add(conferenceApi.pageTitleBinding({ blogRoot, pageKey: page.pageKey, pagePath: page.pagePath,
            pageContentSha256: page.pageContentSha256 }).titleFingerprintSha256);
    }
    return fingerprints;
}
function attemptDirectory(root, crosswalkId) { const safeRoot = crosswalkApi.safeDirectory(root, { create: true }); const directory = path.join(safeRoot, crosswalkId); try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } const info = fs.lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Historical conference crawl batch directory is unsafe'); return directory; }
function writeAttemptRecord(root, record) { const body = { contract: RECORD_CONTRACT, version: VERSION, ...record }; const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) }; const name = `conference-${record.externalId.value}-${record.attemptId}.json`; const filename = path.join(attemptDirectory(root, record.crosswalkId), name); let fd; try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, crosswalkApi.prettyBytes(sealed)); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); } finally { if (fd !== undefined) fs.closeSync(fd); } return { filename, record: sealed }; }
function dependencies() { return { readCrosswalk: crosswalkApi.readCrosswalk, scan: conferenceApi.scanRetainedConferenceCrawlers, scanAccepted: conferenceApi.scanIclrAcceptedMatches, prepareAuthority: conferenceApi.prepareConferenceCrawlAuthority, buildDecision: crosswalkApi.buildVerifiedDecisionArtifact, writeDecision: crosswalkApi.writeDecisionArtifact, loadDecision: crosswalkApi.loadDecisionHandle, applyDecision: crosswalkApi.applyDecision, writeAttemptRecord, uuid: () => crypto.randomUUID(), now: () => new Date().toISOString() }; }
async function runConferenceCrawlBatch({ crosswalkRoot, identityRoot, dataRoot, batchRoot, blogRoot = null, iclrAcceptedRoot = null, crosswalkId, owner, limit = null, apply = true, concurrency = 3, recoveryPolicy = null } = {}, overrides = {}) {
    void crosswalkRoot; void identityRoot; void dataRoot; void batchRoot; void blogRoot; void iclrAcceptedRoot;
    void crosswalkId; void owner; void limit; void apply; void concurrency; void recoveryPolicy; void overrides;
    throw new Error('Historical conference crawl batch is retired; use history:conference-local-sources, history:conference-projections, and history:direct-plan');
    /* c8 ignore next -- retained below as a forensic reference for existing runtime records. */
    const deps = { ...dependencies(), ...overrides }; if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error('Conference crawl batch concurrency must be an integer from 1 to 5');
    const initial = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const index = deps.scan({ dataRoot }); const external = iclrAcceptedRoot === null ? { files: [], matches: new Map() } : deps.scanAccepted({ iclrAcceptedRoot, titleFingerprintSha256s: missingIclrTitleFingerprints(initial, blogRoot, index.matches) }); const matches = mergeMatches(index.matches, external.matches); const all = eligibleGroups(initial, matches, { blogRoot }); const maximum = limit === null ? all.length : limit; if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Conference crawl batch limit must be null or a non-negative integer'); const selected = all.slice(0, maximum);
    if (!apply) return { status: 'dry-run', crosswalkId, retainedFiles: index.files.length + external.files.length, retainedIdentities: matches.size, eligibleIdentities: all.length, eligiblePages: all.reduce((n, item) => n + item.pageKeys.length, 0), selectedIdentities: selected.length, selectedPages: selected.reduce((n, item) => n + item.pageKeys.length, 0), concurrency, identities: selected.map(item => ({ externalId: item.externalId, conference: item.match.conference, pageCount: item.pageKeys.length })) };
    const results = new Array(selected.length); let cursor = 0; let tail = Promise.resolve(); const serialize = work => { const next = tail.then(work, work); tail = next.catch(() => {}); return next; };
    const processGroup = async (group, position) => { const attemptId = deps.uuid(); const startedAt = deps.now(); let authorityName = null; const completedPageKeys = []; try {
        const current = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const currentGroup = eligibleGroups(current, matches, { blogRoot }).find(item => keyFor(item.externalId) === keyFor(group.externalId) && item.pageKeys.join(',') === group.pageKeys.join(',')); const pending = currentGroup?.pageKeys || [];
        if (pending.length) { const prepared = await deps.prepareAuthority({ identityRoot, dataRoot, blogRoot, iclrAcceptedRoot, match: group.match, titleBindings: currentGroup.titleBindings, apply: true }); authorityName = prepared.authorityName; const reason = currentGroup.titleBindings.length ? 'The frozen page frontmatter title and retained local conference metadata have one exact normalized fingerprint; the metadata stable ID and SHA-verified PDF replayed.' : 'Retained local conference crawler metadata and the SHA-verified PDF exactly match the frozen non-title stable identity hint.'; for (const pageKey of pending) { const applied = await serialize(() => { const fresh = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); if (fresh.assignments[pageKey]?.status !== 'pending') return false; const artifact = deps.buildDecision({ state: fresh, pageKey, authorityHandle: prepared.authorityHandle, operationId: deps.uuid(), actorId: owner, reason }); const decisionName = `conference-crawl-${group.externalId.value}-${attemptId}-${pageKey.slice(5)}.json`; const decisionFile = deps.writeDecision({ crosswalkRoot, crosswalkId, decisionName, artifact }); const handle = deps.loadDecision(decisionFile, { authorityHandle: prepared.authorityHandle }); deps.applyDecision({ crosswalkRoot, crosswalkId, decisionHandle: handle, owner, recoveryPolicy }); return true; }); if (applied) completedPageKeys.push(pageKey); } }
        const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const remainingPageKeys = group.pageKeys.filter(pageKey => final.assignments[pageKey]?.status === 'pending'); const record = { crosswalkId, attemptId, externalId: group.externalId, authorityName, status: remainingPageKeys.length ? 'partial' : 'complete', startedAt, finishedAt: deps.now(), requestedPageKeys: group.pageKeys, completedPageKeys, remainingPageKeys, error: null }; deps.writeAttemptRecord(batchRoot, record); results[position] = record;
    } catch (error) { const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const remainingPageKeys = group.pageKeys.filter(pageKey => final.assignments[pageKey]?.status === 'pending'); const record = { crosswalkId, attemptId, externalId: group.externalId, authorityName, status: 'failed', startedAt, finishedAt: deps.now(), requestedPageKeys: group.pageKeys, completedPageKeys, remainingPageKeys, error: String(error.message).slice(0, 2000) }; deps.writeAttemptRecord(batchRoot, record); results[position] = record; } };
    const worker = async () => { while (cursor < selected.length) { const position = cursor++; await processGroup(selected[position], position); } }; await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker)); const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const complete = results.filter(Boolean); const failures = complete.filter(item => item.status !== 'complete'); return { status: failures.length ? 'partial' : 'complete', crosswalkId, retainedFiles: index.files.length + external.files.length, retainedIdentities: matches.size, eligibleIdentities: all.length, processedIdentities: complete.length, processedPages: complete.reduce((n, item) => n + item.completedPageKeys.length, 0), failures: failures.map(item => ({ externalId: item.externalId, error: item.error, remainingPages: item.remainingPageKeys.length })), crosswalkVerified: final.completion.verified, crosswalkTotal: final.completion.total, concurrency, exitCode: failures.length ? 1 : 0 };
}
module.exports = { RECORD_CONTRACT, VERSION, keyFor, explicitHintGroups, eligibleGroups, mergeMatches, missingIclrTitleFingerprints, attemptDirectory, writeAttemptRecord, runConferenceCrawlBatch };
