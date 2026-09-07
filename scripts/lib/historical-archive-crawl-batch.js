'use strict';

// Retained crawler records remain useful for read-only audit/recovery tools,
// but must not create crosswalk assignments. Direct rewrites either freshly
// acquire arXiv or replay the dedicated conference local-source catalog.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const localCrawlApi = require('./historical-local-crawl-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');

const RECORD_CONTRACT = 'historical-local-crawl-batch-record-v1';
const VERSION = 1;

function eligiblePages(state) {
    return state.source.papers.flatMap(paper => {
        const assignment = state.assignments[paper.pageKey]; const hints = paper.identityHints;
        if (assignment?.status !== 'pending' || hints?.status !== 'single' || hints.candidates?.length !== 1) return [];
        const hint = hints.candidates[0];
        if (hint.scheme !== 'arxiv' || !/^\d{4}\.\d{4,5}$/.test(hint.value)
            || !Array.isArray(hint.sources) || !hint.sources.length
            || hint.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) return [];
        return [{ arxivId: hint.value, pageKey: paper.pageKey, cohortDate: paper.cohortDate }];
    }).sort((left, right) => left.arxivId.localeCompare(right.arxivId) || left.pageKey.localeCompare(right.pageKey));
}
function selectMatch(matches, cohortDate) {
    const preferred = matches.filter(match => match.sourceRelativePath === `archive/${cohortDate}/filtered-papers.json`);
    const current = matches.filter(match => match.sourceKind === 'current');
    const archived = matches.filter(match => match.sourceKind === 'archive');
    // The order is deliberate: same-cohort archive, then the preserved current
    // crawler library, then a different archive. No title/body input exists.
    return preferred[0] || current[0] || archived[0] || null;
}
function attemptDirectory(root, crosswalkId) {
    const safeRoot = crosswalkApi.safeDirectory(root, { create: true }); const directory = path.join(safeRoot, crosswalkId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('local crawl batch directory is unsafe');
    return directory;
}
function fail(message) { throw new Error(`Historical archive crawl batch rejected: ${message}`); }
function writeAttemptRecord(root, record) {
    const body = { contract: RECORD_CONTRACT, version: VERSION, ...record };
    const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) };
    const directory = attemptDirectory(root, record.crosswalkId);
    const name = `local-crawl-${record.arxivId.replace('.', '-')}-${record.pageKey.slice(5)}-${record.attemptId}.json`;
    const filename = path.join(directory, name); const bytes = crosswalkApi.prettyBytes(sealed); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return { filename, record: sealed };
}
function dependencies() {
    return { readCrosswalk: crosswalkApi.readCrosswalk, scan: localCrawlApi.scanLocalCrawlPapers,
        prepareAuthority: localCrawlApi.prepareLocalCrawlAuthority, buildDecision: crosswalkApi.buildVerifiedDecisionArtifact,
        writeDecision: crosswalkApi.writeDecisionArtifact, loadDecision: crosswalkApi.loadDecisionHandle,
        applyDecision: crosswalkApi.applyDecision, writeAttemptRecord, uuid: () => crypto.randomUUID(), now: () => new Date().toISOString() };
}
async function runLocalCrawlBatch({ crosswalkRoot, identityRoot, snapshotRoot, dataRoot, batchRoot, crosswalkId, owner,
    limit = null, apply = true, concurrency = 3, recoveryPolicy = null } = {}, overrides = {}) {
    void crosswalkRoot; void identityRoot; void snapshotRoot; void dataRoot; void batchRoot; void crosswalkId; void owner;
    void limit; void apply; void concurrency; void recoveryPolicy; void overrides;
    fail('local crawler crosswalk mutation is retired; use history:direct-inputs and history:direct-plan');
    /* c8 ignore next -- retained below as a forensic reference for existing runtime records. */
    const deps = { ...dependencies(), ...overrides };
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency must be an integer from 1 to 5');
    const initial = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const index = deps.scan({ dataRoot });
    const matches = index.matches;
    const all = eligiblePages(initial).map(page => ({ ...page, match: selectMatch(matches.get(page.arxivId) || [], page.cohortDate) }));
    const matched = all.filter(item => item.match); const maximum = limit === null ? matched.length : limit;
    if (!Number.isSafeInteger(maximum) || maximum < 0) fail('limit must be null or a non-negative integer');
    const selected = matched.slice(0, maximum);
    if (!apply) return { status: 'dry-run', crosswalkId, localCrawlFiles: index.files.length,
        eligiblePages: all.length, matchedPages: matched.length, unmatchedPages: all.length - matched.length,
        selectedPages: selected.length, concurrency };

    const results = new Array(selected.length); let cursor = 0; let decisionTail = Promise.resolve();
    const serializeDecision = callback => {
        const pending = decisionTail.then(callback, callback); decisionTail = pending.catch(() => {}); return pending;
    };
    const processPage = async (item, resultIndex) => {
        const attemptId = deps.uuid(); const startedAt = deps.now(); let authorityName = null;
        try {
            const current = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
            if (current.assignments[item.pageKey]?.status !== 'pending') {
                const record = { crosswalkId, attemptId, arxivId: item.arxivId, pageKey: item.pageKey, cohortDate: item.cohortDate,
                    authorityName: null, status: 'complete', startedAt, finishedAt: deps.now(), sourceKind: item.match.sourceKind,
                    sourceRelativePath: item.match.sourceRelativePath,
                    recordSha256: item.match.recordSha256, error: null };
                deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record; return;
            }
            const prepared = await deps.prepareAuthority({ identityRoot, snapshotRoot, dataRoot, arxivId: item.arxivId, match: item.match, apply: true });
            authorityName = prepared.authorityName;
            const applied = await serializeDecision(() => {
                const fresh = deps.readCrosswalk({ crosswalkRoot, crosswalkId });
                if (fresh.assignments[item.pageKey]?.status !== 'pending') return false;
                const artifact = deps.buildDecision({ state: fresh, pageKey: item.pageKey, authorityHandle: prepared.authorityHandle,
                    operationId: deps.uuid(), actorId: owner,
                    reason: 'Retained local crawler filtered-papers record exactly matches the frozen non-title arXiv identity hint.' });
                const decisionName = `local-crawl-${item.arxivId.replace('.', '-')}-${attemptId}-${item.pageKey.slice(5)}.json`;
                const decisionFile = deps.writeDecision({ crosswalkRoot, crosswalkId, decisionName, artifact });
                const handle = deps.loadDecision(decisionFile, { authorityHandle: prepared.authorityHandle });
                deps.applyDecision({ crosswalkRoot, crosswalkId, decisionHandle: handle, owner, recoveryPolicy });
                return true;
            });
            const record = { crosswalkId, attemptId, arxivId: item.arxivId, pageKey: item.pageKey, cohortDate: item.cohortDate,
                authorityName, status: 'complete', startedAt, finishedAt: deps.now(), sourceKind: item.match.sourceKind,
                sourceRelativePath: item.match.sourceRelativePath,
                recordSha256: item.match.recordSha256, error: applied ? null : 'page was already completed by a concurrent worker' };
            deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record;
        } catch (error) {
            const record = { crosswalkId, attemptId, arxivId: item.arxivId, pageKey: item.pageKey, cohortDate: item.cohortDate,
                authorityName, status: 'failed', startedAt, finishedAt: deps.now(), sourceKind: item.match.sourceKind,
                sourceRelativePath: item.match.sourceRelativePath,
                recordSha256: item.match.recordSha256, error: String(error.message).slice(0, 2000) };
            deps.writeAttemptRecord(batchRoot, record); results[resultIndex] = record;
        }
    };
    const worker = async () => { while (cursor < selected.length) { const index = cursor++; await processPage(selected[index], index); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
    const final = deps.readCrosswalk({ crosswalkRoot, crosswalkId }); const complete = results.filter(Boolean);
    const failures = complete.filter(item => item.status !== 'complete');
    return { status: failures.length ? 'partial' : 'complete', crosswalkId, localCrawlFiles: index.files.length,
        eligiblePages: all.length, matchedPages: matched.length, unmatchedPages: all.length - matched.length,
        processedPages: complete.length, completedPages: complete.filter(item => item.status === 'complete').length,
        failures: failures.map(item => ({ pageKey: item.pageKey, arxivId: item.arxivId, error: item.error })),
        crosswalkVerified: final.completion.verified, crosswalkTotal: final.completion.total, concurrency,
        exitCode: failures.length ? 1 : 0 };
}

module.exports = { RECORD_CONTRACT, VERSION, eligiblePages, selectMatch, attemptDirectory, writeAttemptRecord,
    runLocalCrawlBatch, runArchiveCrawlBatch: runLocalCrawlBatch };
