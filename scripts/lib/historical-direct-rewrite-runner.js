'use strict';

// Execution half of the historical direct-rewrite plan.  Planning deliberately
// stops at source pointers; this module is the only path that turns one of
// those pointers into a source-only analysis/Reader execution.  It never
// reads a historical post, data/current, a crosswalk, or a legacy analysis.

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const conferenceLocalSources = require('./historical-conference-local-sources.js');
const planApi = require('./historical-direct-rewrite-plan.js');
const freshArxiv = require('./fresh-arxiv-rewrite-source.js');
const directContext = require('./direct-rewrite-analysis-context.js');
const directPages = require('./historical-direct-page-staging.js');
const execFileAsync = promisify(execFile);

const CONTRACT = 'historical-direct-rewrite-execution-v1';
const REGISTRY_CONTRACT = 'historical-direct-rewrite-execution-registry-v1';
const STAGING_CONTRACT = 'historical-direct-rewrite-staging-v1';
const ANALYSIS_RECOVERY_CONTRACT = 'historical-direct-analysis-recovery-v1';
const LEGACY_PAPER_LOCK_RECLAIM_INTENT_CONTRACT = 'historical-direct-legacy-paper-lock-reclaim-intent-v1';
const LEGACY_PAPER_LOCK_RECLAIM_COMPLETION_CONTRACT = 'historical-direct-legacy-paper-lock-reclaim-completion-v1';
const PRIOR_PREPRINT_VERSION_RELATION = 'author-prior-preprint-with-different-title';
const PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const SHA = /^[a-f0-9]{64}$/;
const STATES = new Set(['pending', 'sourcing', 'source_ready', 'analyzing', 'analysis_partial', 'analysis_complete', 'staged', 'failed']);
const TRANSITIONS = new Map([
    ['pending', new Set(['sourcing', 'failed'])],
    ['sourcing', new Set(['source_ready', 'failed'])],
    ['source_ready', new Set(['analyzing', 'failed'])],
    ['analyzing', new Set(['analysis_partial', 'analysis_complete', 'failed'])],
    ['analysis_partial', new Set(['sourcing', 'analyzing', 'failed'])],
    ['analysis_complete', new Set(['staged', 'analyzing', 'failed'])],
    // A staged packet is immutable, but it is not safe to accept as
    // recovered after its retained source has drifted.  Preserve the packet
    // for diagnosis and make the latest execution state failed so a later
    // retry cannot silently treat it as current.
    ['staged', new Set(['failed'])],
    ['failed', new Set(['sourcing', 'analyzing'])]
]);

class HistoricalDirectRewriteRunnerError extends Error {
    constructor(message) { super(`Historical direct rewrite execution rejected: ${message}`); this.code = 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY'; }
}
const fail = message => { throw new HistoricalDirectRewriteRunnerError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function safeDirectory(value, create = false, label = 'directory') {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) { if (error.code !== 'ENOENT' || !create) throw error; fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe ${label}: ${cursor}`);
    }
    return absolute;
}

function readRegular(filename, maximum = 64 * 1024 * 1024) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maximum) fail(`unsafe file: ${filename}`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail(`file changed while read: ${filename}`);
        }
        return { bytes, sha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeAtomic(filename, value) {
    const directory = safeDirectory(path.dirname(filename), true, 'output directory');
    const bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return sha256(bytes);
}

function writeExclusiveAtomic(filename, value) {
    const directory = safeDirectory(path.dirname(filename), true, 'output directory');
    const bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.linkSync(temporary, filename);
        const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return sha256(bytes);
}

function analysisRecoveryPath(executionDirectory) {
    if (typeof executionDirectory !== 'string' || !path.isAbsolute(executionDirectory)) {
        fail('analysis recovery directory must be absolute');
    }
    return path.join(path.resolve(executionDirectory), 'analysis-recovery.json');
}

function analysisRecoveryRecord({ item, sourceDescriptor, record, updatedAt }) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.directPaperId !== item.paperId
        || !SHA.test(String(sourceDescriptor?.sourceSnapshotSha256 || ''))
        || Number.isNaN(Date.parse(updatedAt || '')) || new Date(updatedAt).toISOString() !== updatedAt) {
        fail(`${item.paperId} analysis recovery state is invalid`);
    }
    directContext.assertNoPersistentFigureFields(record);
    const retained = clone(record);
    const body = { contract: ANALYSIS_RECOVERY_CONTRACT, version: 1, paperId: item.paperId,
        runId: item.runId, sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        updatedAt, record: retained, recordSha256: stableHash(retained) };
    return { ...body, recoverySha256: stableHash(body) };
}

function normalizeAnalysisRecovery(value, { item, sourceDescriptor }) {
    const fields = ['contract', 'version', 'paperId', 'runId', 'sourceSnapshotSha256', 'updatedAt',
        'record', 'recordSha256', 'recoverySha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')
        || value.contract !== ANALYSIS_RECOVERY_CONTRACT || value.version !== 1
        || value.paperId !== item.paperId || value.runId !== item.runId
        || value.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256
        || Number.isNaN(Date.parse(value.updatedAt || '')) || new Date(value.updatedAt).toISOString() !== value.updatedAt
        || !value.record || typeof value.record !== 'object' || Array.isArray(value.record)
        || value.record.directPaperId !== item.paperId || value.recordSha256 !== stableHash(value.record)
        || !SHA.test(String(value.recordSha256 || '')) || !SHA.test(String(value.recoverySha256 || ''))) {
        fail(`${item.paperId} analysis recovery envelope is invalid or belongs to another source`);
    }
    const body = { ...value }; delete body.recoverySha256;
    if (value.recoverySha256 !== stableHash(body)) fail(`${item.paperId} analysis recovery SHA drifted`);
    directContext.assertNoPersistentFigureFields(value.record);
    return clone(value);
}

function writeAnalysisRecovery({ executionDirectory, item, sourceDescriptor, record, updatedAt }) {
    const filename = analysisRecoveryPath(executionDirectory);
    const recovery = analysisRecoveryRecord({ item, sourceDescriptor, record, updatedAt });
    const fileSha256 = writeAtomic(filename, recovery);
    return { filename, fileSha256, recoverySha256: recovery.recoverySha256,
        recordSha256: recovery.recordSha256, updatedAt: recovery.updatedAt };
}

function readAnalysisRecovery({ executionDirectory, item, sourceDescriptor, allowMissing = false }) {
    const filename = analysisRecoveryPath(executionDirectory);
    if (!fs.existsSync(filename)) {
        if (allowMissing) return null;
        fail(`${item.paperId} analysis recovery file is missing`);
    }
    const loaded = readRegular(filename);
    let value;
    try { value = JSON.parse(loaded.bytes.toString('utf8')); }
    catch { fail(`${item.paperId} analysis recovery file is invalid JSON`); }
    const recovery = normalizeAnalysisRecovery(value, { item, sourceDescriptor });
    return { filename, fileSha256: loaded.sha256, recoverySha256: recovery.recoverySha256,
        recordSha256: recovery.recordSha256, updatedAt: recovery.updatedAt, record: recovery.record };
}

function normalizeLegacyPaperLockReclaimIntent(intent, item) {
    const expectedAuditKeys = ['contract', 'leaseAgeMs', 'lockIdentity', 'observedAt', 'owner',
        'recoveryHost', 'staleThresholdMs', 'version'];
    const expectedOwnerKeys = ['acquiredAt', 'hostname', 'ownerSha256', 'pid'];
    const expectedIdentityKeys = ['directoryDev', 'directoryIno', 'ownerDev', 'ownerIno'];
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)
        || Object.keys(intent).sort().join('\0') !== expectedAuditKeys.sort().join('\0')
        || intent.contract !== 'historical-direct-remote-legacy-paper-lock-reclaim-intent-v1'
        || intent.version !== 1
        || !intent.owner || typeof intent.owner !== 'object' || Array.isArray(intent.owner)
        || Object.keys(intent.owner).sort().join('\0') !== expectedOwnerKeys.sort().join('\0')
        || !intent.lockIdentity || typeof intent.lockIdentity !== 'object' || Array.isArray(intent.lockIdentity)
        || Object.keys(intent.lockIdentity).sort().join('\0') !== expectedIdentityKeys.sort().join('\0')
        || Object.values(intent.lockIdentity).some(value => !/^[1-9]\d*$/.test(String(value || '')))
        || intent.owner.hostname === intent.recoveryHost
        || !Number.isInteger(intent.owner.pid) || intent.owner.pid <= 0
        || !SHA.test(String(intent.owner.ownerSha256 || ''))
        || !Number.isSafeInteger(intent.leaseAgeMs) || intent.leaseAgeMs <= 0
        || !Number.isSafeInteger(intent.staleThresholdMs) || intent.staleThresholdMs <= 0
        || intent.leaseAgeMs <= intent.staleThresholdMs
        || Number.isNaN(Date.parse(intent.observedAt || ''))
        || new Date(intent.observedAt).toISOString() !== intent.observedAt
        || Number.isNaN(Date.parse(intent.owner.acquiredAt || ''))
        || new Date(intent.owner.acquiredAt).toISOString() !== intent.owner.acquiredAt) {
        fail(`${item.paperId} historical legacy paper-lock recovery audit is invalid`);
    }
    return clone(intent);
}

function legacyPaperLockReclaimEventId(intent) {
    return stableHash({ lockIdentity: intent.lockIdentity, ownerSha256: intent.owner.ownerSha256 });
}

function legacyPaperLockReclaimPaths(executionDirectory, eventId) {
    const directory = safeDirectory(executionDirectory, true, 'paper execution directory');
    return {
        intent: path.join(directory, `legacy-paper-lock-reclaim-${eventId}.intent.json`),
        completion: path.join(directory, `legacy-paper-lock-reclaim-${eventId}.completion.json`)
    };
}

function readSealedAudit(filename, expectedContract, item, sourceDescriptor) {
    const loaded = readRegular(filename); let value;
    try { value = JSON.parse(loaded.bytes.toString('utf8')); }
    catch { fail(`${item.paperId} historical legacy paper-lock audit is invalid JSON`); }
    const expectedKeys = expectedContract === LEGACY_PAPER_LOCK_RECLAIM_INTENT_CONTRACT
        ? ['auditSha256', 'contract', 'eventId', 'intent', 'paperId', 'runId', 'sourceSnapshotSha256', 'version']
        : ['auditSha256', 'completion', 'contract', 'eventId', 'intentAuditSha256', 'paperId', 'runId',
            'sourceSnapshotSha256', 'version'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
        || value.contract !== expectedContract || value.version !== 1
        || value.paperId !== item.paperId || value.runId !== item.runId
        || value.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256
        || !SHA.test(String(value.eventId || '')) || !SHA.test(String(value.auditSha256 || ''))) {
        fail(`${item.paperId} historical legacy paper-lock audit binding is invalid`);
    }
    const body = { ...value }; delete body.auditSha256;
    if (value.auditSha256 !== stableHash(body)) fail(`${item.paperId} historical legacy paper-lock audit SHA drifted`);
    return { value, fileSha256: loaded.sha256 };
}

function normalizeLegacyPaperLockReclaimCompletion(completion, item) {
    const keys = ['contract', 'outcome', 'recoveredAt', 'version'];
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)
        || Object.keys(completion).sort().join('\0') !== keys.sort().join('\0')
        || completion.contract !== 'historical-direct-remote-legacy-paper-lock-reclaim-completion-v1'
        || completion.version !== 1
        || !['reclaimed-by-current-operation', 'owner-absent-on-replay'].includes(completion.outcome)
        || Number.isNaN(Date.parse(completion.recoveredAt || ''))
        || new Date(completion.recoveredAt).toISOString() !== completion.recoveredAt) {
        fail(`${item.paperId} historical legacy paper-lock completion is invalid`);
    }
    return clone(completion);
}

function writeLegacyPaperLockReclaimCompletion({ paths, eventId, intentAuditSha256,
    item, sourceDescriptor, completion }) {
    const normalizedCompletion = normalizeLegacyPaperLockReclaimCompletion(completion, item);
    if (fs.existsSync(paths.completion)) {
        const existing = readSealedAudit(paths.completion,
            LEGACY_PAPER_LOCK_RECLAIM_COMPLETION_CONTRACT, item, sourceDescriptor);
        if (existing.value.eventId !== eventId || existing.value.intentAuditSha256 !== intentAuditSha256) {
            fail(`${item.paperId} historical legacy paper-lock completion belongs to another intent`);
        }
        normalizeLegacyPaperLockReclaimCompletion(existing.value.completion, item);
        return existing;
    }
    const body = { contract: LEGACY_PAPER_LOCK_RECLAIM_COMPLETION_CONTRACT, version: 1,
        paperId: item.paperId, runId: item.runId, sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        eventId, intentAuditSha256, completion: normalizedCompletion };
    const sealed = { ...body, auditSha256: stableHash(body) };
    return { value: sealed, fileSha256: writeExclusiveAtomic(paths.completion, sealed) };
}

function prepareLegacyPaperLockReclaimAudit({ executionDirectory, item, sourceDescriptor, intent }) {
    const normalized = normalizeLegacyPaperLockReclaimIntent(intent, item);
    const eventId = legacyPaperLockReclaimEventId(normalized);
    const paths = legacyPaperLockReclaimPaths(executionDirectory, eventId);
    const body = { contract: LEGACY_PAPER_LOCK_RECLAIM_INTENT_CONTRACT, version: 1,
        paperId: item.paperId, runId: item.runId,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        eventId, intent: normalized };
    const sealed = { ...body, auditSha256: stableHash(body) };
    if (fs.existsSync(paths.intent)) {
        const existing = readSealedAudit(paths.intent,
            LEGACY_PAPER_LOCK_RECLAIM_INTENT_CONTRACT, item, sourceDescriptor);
        if (existing.value.auditSha256 !== sealed.auditSha256) {
            fail(`${item.paperId} historical legacy paper-lock intent event collision`);
        }
    } else {
        writeExclusiveAtomic(paths.intent, sealed);
    }
    return completion => writeLegacyPaperLockReclaimCompletion({ paths, eventId,
        intentAuditSha256: sealed.auditSha256, item, sourceDescriptor, completion });
}

function reconcileLegacyPaperLockReclaimAudits({ executionDirectory, item, sourceDescriptor, engine, paper }) {
    if (typeof engine?.inspectHistoricalDirectLegacyLockIntent !== 'function') return [];
    const directory = safeDirectory(executionDirectory, true, 'paper execution directory');
    const names = fs.readdirSync(directory).filter(name => /^legacy-paper-lock-reclaim-[a-f0-9]{64}\.intent\.json$/.test(name));
    const reconciled = [];
    for (const name of names) {
        const intentFile = path.join(directory, name);
        const loaded = readSealedAudit(intentFile, LEGACY_PAPER_LOCK_RECLAIM_INTENT_CONTRACT,
            item, sourceDescriptor);
        const intent = normalizeLegacyPaperLockReclaimIntent(loaded.value.intent, item);
        const eventId = legacyPaperLockReclaimEventId(intent);
        if (loaded.value.eventId !== eventId) fail(`${item.paperId} historical legacy lock event ID drifted`);
        const paths = legacyPaperLockReclaimPaths(directory, eventId);
        if (fs.existsSync(paths.completion)) {
            const completed = readSealedAudit(paths.completion, LEGACY_PAPER_LOCK_RECLAIM_COMPLETION_CONTRACT,
                item, sourceDescriptor);
            if (completed.value.eventId !== eventId
                || completed.value.intentAuditSha256 !== loaded.value.auditSha256) {
                fail(`${item.paperId} historical legacy lock completion binding drifted`);
            }
            normalizeLegacyPaperLockReclaimCompletion(completed.value.completion, item);
            continue;
        }
        const target = engine.getPaperAnalysisLockPath(paper);
        if (engine.inspectHistoricalDirectLegacyLockIntent(target, intent) !== 'owner_absent') continue;
        const completion = { contract: 'historical-direct-remote-legacy-paper-lock-reclaim-completion-v1',
            version: 1, recoveredAt: new Date().toISOString(), outcome: 'owner-absent-on-replay' };
        writeLegacyPaperLockReclaimCompletion({ paths, eventId,
            intentAuditSha256: loaded.value.auditSha256, item, sourceDescriptor, completion });
        reconciled.push(eventId);
    }
    return reconciled;
}

function hasRecoverableAnalysisState(recovery) {
    const record = recovery?.record;
    return Boolean(record && (record.analysisManifest || typeof record.analysisCheckpoint === 'string'
        || record.analysisStageCheckpoints || record.analysisRecoveryImageManifest
        || record.analysisStaleSnapshots));
}

function sourcePrerequisiteSnapshot({ sourceRoot, plan, generation, selected, required = true }) {
    const control = require('./historical-direct-control.js');
    const loaded = control.readSourceStatus({ sourceRoot, plan, generation });
    if (!loaded) {
        if (required && selected.length) {
            fail('source scheduler checkpoint is missing; run history:direct-scheduler --apply for this plan/generation first');
        }
        return { status: selected.length ? 'missing' : 'not-required', statusFile: control.sourceControlPaths({
            sourceRoot, plan, generation }).statusFile, statusSha256: null, selectedReady: 0,
        selectedCount: selected.length, notReadyPaperIds: selected.map(item => item.paperId) };
    }
    const byId = new Map(loaded.status.entries.map(entry => [entry.paperId, entry]));
    const notReadyPaperIds = selected.filter(item => byId.get(item.paperId)?.status !== 'ready').map(item => item.paperId);
    if (required && notReadyPaperIds.length) {
        fail(`source scheduler has not marked every selected paper ready: ${notReadyPaperIds.join(', ')}`);
    }
    return { status: notReadyPaperIds.length ? 'not-ready' : 'ready', statusFile: loaded.filename,
        statusFileSha256: loaded.fileSha256, statusSha256: loaded.status.statusSha256,
        selectedReady: selected.length - notReadyPaperIds.length, selectedCount: selected.length,
        notReadyPaperIds, selectedPaperSetSha256: stableHash(selected.map(item => item.paperId)) };
}

function checkedArxivGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('arXiv source generation is invalid');
    return value;
}
function registryName(plan, arxivGeneration = 1) {
    return `${plan.planSha256}.arxiv-generation-${String(checkedArxivGeneration(arxivGeneration)).padStart(6, '0')}.json`;
}
function registryPath(registryRoot, plan, arxivGeneration = 1) {
    if (typeof registryRoot !== 'string' || !path.isAbsolute(registryRoot)) fail('registry root must be an absolute path');
    return path.join(path.resolve(registryRoot), registryName(plan, arxivGeneration));
}
function defaultPauseFilePath(registryRoot, plan, arxivGeneration = 1) {
    return `${registryPath(registryRoot, plan, arxivGeneration)}.pause`;
}
function operationLockTarget(registryRoot, plan, arxivGeneration = 1) {
    return `${registryPath(registryRoot, plan, arxivGeneration)}.direct-run-operation`;
}
function pauseFileRequested(filename, plan, generation) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('pause file must be an absolute path');
    const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!entry) return false;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail('pause file must be a single-link regular file');
    const loaded = require('./historical-conference-page-projections.js').readStableJson(filename, 'direct rewrite pause request');
    const value = loaded.value; const expectedKeys = ['contract', 'version', 'planSha256', 'generation', 'requestedAt', 'requestSha256'];
    if (!value || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
        || value.contract !== 'historical-direct-rewrite-pause-request-v1' || value.version !== 1
        || value.planSha256 !== plan.planSha256 || value.generation !== generation
        || new Date(value.requestedAt).toISOString() !== value.requestedAt) fail('pause request is not bound to this plan/generation');
    const body = { ...value }; delete body.requestSha256;
    if (value.requestSha256 !== stableHash(body)) fail('pause request SHA drifted');
    return true;
}
function selectDirectItems(plan, options = {}, registry = null) {
    const normalized = planApi.normalizePlan(plan); const queue = options.queue || 'all';
    if (!['all', 'arxiv', 'conference'].includes(queue)) fail('queue is invalid');
    const requestedPaperIds = options.paperIds ?? [];
    if (!Array.isArray(requestedPaperIds) || requestedPaperIds.some(id => typeof id !== 'string' || !id)
        || new Set(requestedPaperIds).size !== requestedPaperIds.length) fail('paperIds must be a unique non-empty string array');
    if (options.maxPapers !== undefined && options.maxPapers !== null
        && options.limit !== undefined && options.limit !== null) fail('maxPapers and limit cannot both be supplied');
    const maxPapers = options.maxPapers ?? options.limit ?? null;
    if (maxPapers !== null && (!Number.isSafeInteger(maxPapers) || maxPapers < 1 || maxPapers > 999999999)) {
        fail('maxPapers must be a positive safe integer');
    }
    const available = normalized.queue.filter(item => queue === 'all'
        || (queue === 'arxiv' ? item.route.kind === 'arxiv-fresh-fetch' : item.route.kind === 'conference-local-pdf'));
    const availableIds = new Set(available.map(item => item.paperId));
    const unknownPaperIds = requestedPaperIds.filter(id => !availableIds.has(id));
    if (unknownPaperIds.length) fail(`paper IDs are unknown or outside queue=${queue}: ${unknownPaperIds.join(', ')}`);
    const requested = new Set(requestedPaperIds);
    const scoped = requested.size ? available.filter(item => requested.has(item.paperId)) : available;
    const completed = registry === null ? new Set() : new Set(normalizeRegistry(registry, normalized).entries
        .filter(entry => entry.status === 'staged').map(entry => entry.paperId));
    // A bounded implicit batch must advance on resume instead of repeatedly
    // selecting the same already-staged prefix. Explicit IDs remain replayable
    // so an operator can deliberately re-verify their sealed artifacts.
    const candidates = maxPapers !== null && requested.size === 0
        ? scoped.filter(item => !completed.has(item.paperId)) : scoped;
    const items = maxPapers === null ? candidates : candidates.slice(0, maxPapers);
    return { items, selection: { queue, requestedPaperIds: requestedPaperIds.slice().sort(), maxPapers,
        availableCount: available.length, scopedCount: scoped.length,
        skippedCompletedCount: scoped.length - candidates.length, selectedCount: items.length,
        selectedPaperIds: items.map(item => item.paperId) } };
}
function initialRegistry(plan, now) {
    const entries = plan.queue.map(item => ({ paperId: item.paperId, runId: item.runId, route: item.route.kind,
        projectionSha256: item.projectionSha256, status: 'pending', source: null, analysis: null, staging: null,
        attempts: 0, latestError: null, updatedAt: now })).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const body = { contract: REGISTRY_CONTRACT, version: 1, planSha256: plan.planSha256, createdAt: now, entries };
    return { ...body, registrySha256: stableHash(body) };
}
function normalizeRegistry(value, plan) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.contract !== REGISTRY_CONTRACT || value.version !== 1
        || value.planSha256 !== plan.planSha256 || !Array.isArray(value.entries) || !SHA.test(String(value.registrySha256 || ''))) {
        fail('registry envelope is invalid');
    }
    const body = { ...value }; delete body.registrySha256;
    if (stableHash(body) !== value.registrySha256) fail('registry SHA drifted');
    const expected = new Map(plan.queue.map(item => [item.paperId, item]));
    if (value.entries.length !== expected.size) fail('registry does not cover the full plan');
    const ids = new Set();
    const entries = value.entries.map(entry => {
        const item = expected.get(entry?.paperId);
        if (!item || ids.has(entry.paperId) || entry.runId !== item.runId || entry.route !== item.route.kind
            || entry.projectionSha256 !== item.projectionSha256 || !STATES.has(entry.status)
            || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0) fail('registry entry drifted from plan');
        ids.add(entry.paperId); return clone(entry);
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    return { ...clone(value), entries };
}
function loadOrCreateRegistry({ registryRoot, plan, now, arxivGeneration = 1 }) {
    const filename = path.join(safeDirectory(registryRoot, true, 'registry root'), registryName(plan, arxivGeneration));
    if (!fs.existsSync(filename)) {
        const registry = initialRegistry(plan, now); writeAtomic(filename, registry); return { filename, registry, created: true };
    }
    const loaded = JSON.parse(readRegular(filename).bytes.toString('utf8'));
    return { filename, registry: normalizeRegistry(loaded, plan), created: false };
}
function transition(registry, plan, paperId, status, changes, now) {
    const current = normalizeRegistry(registry, plan); const index = current.entries.findIndex(item => item.paperId === paperId);
    if (index < 0 || !STATES.has(status)) fail('unknown registry transition');
    const before = current.entries[index];
    if (before.status !== status && !TRANSITIONS.get(before.status)?.has(status)) {
        fail(`${paperId} cannot transition ${before.status} -> ${status}`);
    }
    const updates = clone(changes || {}); const next = { ...before, ...updates, status, updatedAt: now };
    // An explicit undefined is a controlled field deletion. This is used when
    // a durable partial-recovery receipt has been consumed by a new attempt so
    // the terminal staged registry returns to its canonical schema.
    for (const [key, value] of Object.entries(updates)) if (value === undefined) delete next[key];
    const entries = current.entries.slice(); entries[index] = next;
    const body = { contract: REGISTRY_CONTRACT, version: 1, planSha256: current.planSha256, createdAt: current.createdAt, entries };
    return { ...body, registrySha256: stableHash(body) };
}

function structuredArtifactsSha(details) {
    const value = details?.structuredArtifacts?.payloadSha256;
    if (!SHA.test(String(value || ''))) fail('source structured-artifact SHA is missing');
    return value;
}
function compactSourceDescriptor(route, source, item = null) {
    if (route === 'arxiv-fresh-fetch') {
        const details = source.runtimeDetails || fallbackArxivDetails(source);
        const sourceManifestSha256 = source.sourceManifestSha256 || sha256(Buffer.from(JSON.stringify(source.manifest)));
        const sourceBinding = planApi.normalizeFreshArxivSourceBinding(item, { contract: planApi.FRESH_ARXIV_SOURCE_CONTRACT,
            paperId: source.paperId, arxivId: source.arxivId, generation: source.generation,
            textSha256: source.manifest.text.responseSha256, pdfSha256: source.manifest.pdf.responseSha256, sourceManifestSha256 });
        return { kind: route, paperId: source.paperId, generation: source.generation,
            sourceId: details.sourceId, textSha256: source.manifest.text.responseSha256,
            structuredArtifactsSha256: structuredArtifactsSha(details), pdfSha256: source.manifest.pdf.responseSha256, sourceManifestSha256,
            sourceBinding, sourceRunIdentitySha256: planApi.directSourceRunIdentity(item, sourceBinding),
            sourceSnapshotSha256: sourceSnapshotSha(details),
            ...(details.sourceVersion ? { sourceVersion: freshArxiv.normalizeHistoricalVersionIdentity(
                details.sourceVersion, source.arxivId) } : {}) };
    }
    return { kind: route, paperId: source.paperId, sourceId: source.sourceDetails.sourceId, pdfSha256: source.pdfSha256,
        textSha256: sha256(Buffer.from(source.sourceDetails.text, 'utf8')),
        structuredArtifactsSha256: structuredArtifactsSha(source.sourceDetails),
        sourceSnapshotSha256: sourceSnapshotSha(source.sourceDetails) };
}
function sourceSnapshotSha(details) { return stableHash({ paperId: details.paperId, source: details.source, sourceId: details.sourceId,
    textSha256: sha256(Buffer.from(details.text, 'utf8')), structuredArtifacts: details.structuredArtifacts,
    ...(details.sourceVersion ? { sourceVersion: details.sourceVersion } : {}) }); }
function fallbackArxivDetails(source) {
    const text = source.text; const body = { version: 1, source: 'fresh_arxiv_text_without_layout', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha256(Buffer.from(text, 'utf8')) };
    return { paperId: `arxiv:${source.arxivId}`, source: source.manifest.text.source, sourceId: source.manifest.text.sourceId,
        text, imageInfos: [], structuredArtifacts: { ...body, payloadSha256: sha256(JSON.stringify(body)) },
        htmlAvailability: 'not_replayed', htmlAttempts: 0, warnings: ['恢复 generation 时没有保留图像索引；本次 Reader 不接收 Figure 像素。'] };
}
function directPaper(item, sourceDetails = {}) {
    // Do not carry catalog source pointers, page titles, historical prose, old
    // analysis, metadata, or prior Reader fields across this boundary.
    const title = typeof sourceDetails.title === 'string' ? sourceDetails.title.replace(/\s+/g, ' ').trim() : '';
    if (item.route.kind === 'arxiv-fresh-fetch') return { directPaperId: item.paperId, arxivId: item.route.arxivId, ...(title ? { title } : {}) };
    return { directPaperId: item.paperId, id: item.paperId, ...(title ? { title } : {}) };
}

function titleFromConferenceMetadata(source, item) {
    const metadata = readRegular(source.metadata.absolutePath, 64 * 1024 * 1024);
    if (metadata.sha256 !== source.metadata.sha256) fail(`${item.paperId} conference metadata changed after planning`);
    let value;
    try { value = JSON.parse(metadata.bytes.toString('utf8')); }
    catch { fail(`${item.paperId} conference metadata is invalid JSON`); }
    const posterBinding = source.metadata.posterBinding;
    const isIcmlPoster = source.sourceSet === 'workspace-icml-official-poster-2026' && posterBinding;
    const records = Array.isArray(value) ? value : Array.isArray(value?.papers) ? value.papers
        : Array.isArray(value?.items) ? value.items : isIcmlPoster && Array.isArray(value?.results) ? value.results : null;
    const record = records?.[source.metadata.recordIndex];
    if (isIcmlPoster && (String(record?.id) !== posterBinding.posterId
        || record?.paper_url !== posterBinding.openreviewUrl
        || record?.virtualsite_url !== `/virtual/2026/poster/${posterBinding.posterId}`)) {
        fail(`${item.paperId} ICML poster metadata identity drifted`);
    }
    const rawTitle = isIcmlPoster ? record?.name : record?.title;
    const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 2000) fail(`${item.paperId} retained conference metadata title is unavailable`);
    return title;
}

function priorPreprintAnalysisDisclosure(source, item) {
    const acquisition = source?.pdf?.acquisition;
    if (acquisition?.versionRelation !== PRIOR_PREPRINT_VERSION_RELATION) return null;
    if (item?.paperId !== PRIOR_PREPRINT_PAPER_ID) {
        fail(`${item?.paperId || 'unknown paper'} cross-version prior preprint is not the reviewed exception`);
    }
    const sourceTitle = typeof acquisition.sourceTitle === 'string'
        ? acquisition.sourceTitle.replace(/\s+/g, ' ').trim() : '';
    const sourceDoi = typeof acquisition.sourceDoi === 'string'
        ? acquisition.sourceDoi.replace(/\s+/g, ' ').trim() : '';
    if (!sourceTitle || !sourceDoi) {
        fail(`${item.paperId} cross-version prior preprint lacks its source title or DOI`);
    }
    const warning = '本次分析使用可访问的作者早期预印本，不是会议 camera-ready 定稿；标题、内容、实验结果和结论可能与会议最终版本不同。';
    return {
        versionRelation: PRIOR_PREPRINT_VERSION_RELATION,
        sourceTitle,
        sourceDoi,
        warning,
        analysisInputNotice: [
            '【来源版本警告】',
            warning,
            `实际分析来源标题：${sourceTitle}`,
            `实际分析来源 DOI：${sourceDoi}`,
            '以下正文来自该早期预印本，只能据此分析，不得声称已核对会议 camera-ready 版本。'
        ].join('\n')
    };
}

async function extractConferenceSource(item, dependencies = {}) {
    let source = item.route.writerInputs[0];
    if (!source) fail(`${item.paperId} has no local conference PDF`);
    try { source = conferenceLocalSources.validateSource(source, item.paperId); }
    catch (error) { fail(`${item.paperId} local conference source binding is invalid: ${error.message}`); }
    const priorPreprint = priorPreprintAnalysisDisclosure(source, item);
    const pdf = readRegular(source.pdf.absolutePath, 512 * 1024 * 1024);
    if (pdf.sha256 !== source.pdf.sha256 || pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail(`${item.paperId} PDF changed after planning`);
    const extractPdfText = dependencies.extractPdfText || (async bytes => {
        const parser = new PDFParse({ data: bytes });
        try { const result = await parser.getText(); return String(result?.text || ''); }
        finally { await parser.destroy().catch(() => {}); }
    });
    const extractedText = String(await extractPdfText(pdf.bytes) || '').replace(/\r\n?/g, '\n').trim();
    if (extractedText.length < 100) fail(`${item.paperId} local PDF text is unusably short`);
    // Put the identity warning in the actual text consumed by every primary,
    // repair, scoring, and Reader request. Merely retaining it as manifest
    // metadata would not prevent a model from mistaking these bytes for the
    // differently titled conference camera-ready paper.
    const text = priorPreprint ? `${priorPreprint.analysisInputNotice}\n\n${extractedText}` : extractedText;
    const artifactsBody = { version: 1, source: 'direct_conference_pdf_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha256(Buffer.from(text, 'utf8')) };
    return { paperId: item.paperId, pdfSha256: pdf.sha256, sourceTitle: titleFromConferenceMetadata(source, item), sourceDetails: { paperId: item.paperId,
        source: 'conference_pdf_text', sourceId: item.paperId, text, imageInfos: [],
        structuredArtifacts: { ...artifactsBody, payloadSha256: sha256(JSON.stringify(artifactsBody)) },
        htmlAvailability: 'not_applicable', htmlAttempts: 0,
        ...(priorPreprint ? { sourceTitle: priorPreprint.sourceTitle, sourceDoi: priorPreprint.sourceDoi,
            versionRelation: priorPreprint.versionRelation, sourceVersionWarning: priorPreprint.warning } : {}),
        warnings: [
            ...(priorPreprint ? [priorPreprint.warning] : []),
            '会议本地 PDF 的图像只在本次 Reader 临时物化，不写入 runtime。'
        ] } };
}

async function ephemeralArxivMaterializer(arxivId, figures, dependencies = {}) {
    return freshArxiv.withEphemeralArxivFigures({ arxivId, figures, sourceRoot: dependencies.freshArxivSourceRoot,
        temporaryRoot: dependencies.temporaryRoot, persistentRoots: dependencies.persistentRoots || [] }, async temporary => temporary.figures.map(item => {
        const bytes = readRegular(item.tempPath, 32 * 1024 * 1024).bytes;
        return { ...figures.find(figure => figure.ordinal === item.ordinal), rawBytes: bytes,
            assetSha256: sha256(bytes), assetMediaType: item.mediaType };
    }), { fetchFigure: dependencies.fetchFigure });
}

// The legacy image downloader reads and writes data/current/image-cache. Direct
// runs instead use this callback for dual-model image input. It returns only
// in-memory base64 and is backed by the same OS-temporary lifecycle as Reader
// figures, so no primary-analysis request can touch the legacy cache.
async function ephemeralArxivPrimaryImageDownloader(arxivId, imageUrl, dependencies = {}) {
    return freshArxiv.withEphemeralArxivFigures({ arxivId, figures: [{ ordinal: 1, url: imageUrl }],
        sourceRoot: dependencies.freshArxivSourceRoot, temporaryRoot: dependencies.temporaryRoot,
        persistentRoots: dependencies.persistentRoots || [] }, async temporary => {
        const item = temporary.figures[0];
        const bytes = readRegular(item.tempPath, 32 * 1024 * 1024).bytes;
        return { base64: bytes.toString('base64'), mime: item.mediaType, sha256: sha256(bytes), cacheHit: false };
    }, { fetchFigure: dependencies.fetchFigure });
}

// PDFs can be rendered by a caller-provided extractor.  The default returns no
// layout figures because a PDF text extraction alone does not make an image
// URL safe to publish.  If an extractor is supplied, it receives an OS-temp
// directory and its bytes must be consumed before this function returns.
async function withEphemeralConferenceFigures(source, callback, dependencies = {}) {
    const root = path.resolve(dependencies.temporaryRoot || os.tmpdir());
    const persistentRoots = (dependencies.persistentRoots || []).filter(Boolean).map(value => path.resolve(value));
    if (persistentRoots.some(base => root === base || root.startsWith(`${base}${path.sep}`))) {
        fail('conference temporary figures cannot use a persistent runtime directory');
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(root, 'historical-conference-figures-'));
    try {
        const materialize = dependencies.materializeConferenceFigures || renderConferencePdfPages;
        const figures = await materialize({ pdfPath: source.pdfPath, directory });
        return await callback(Array.isArray(figures) ? figures : fail('conference figure extractor must return an array'));
    } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 }); }
}

async function renderConferencePdfPages({ pdfPath, directory }) {
    if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath) || !path.resolve(pdfPath).endsWith('.pdf')) {
        fail('conference PDF renderer needs an absolute PDF path');
    }
    const prefix = path.join(directory, 'page');
    try {
        await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', '4', '-r', '144', pdfPath, prefix], {
            cwd: directory, timeout: 120000, maxBuffer: 1024 * 1024
        });
    } catch (error) {
        fail(`conference PDF temporary figure rendering failed: ${String(error?.message || error).slice(0, 500)}`);
    }
    const names = fs.readdirSync(directory).filter(name => /^page-\d+\.png$/.test(name)).sort();
    if (!names.length) fail('conference PDF renderer produced no temporary pages');
    return names.map((name, index) => {
        const rawBytes = readRegular(path.join(directory, name), 32 * 1024 * 1024).bytes;
        return { ordinal: index + 1, caption: `PDF 第 ${index + 1} 页`, rawBytes,
            assetSha256: sha256(rawBytes), mediaType: 'image/png' };
    });
}

function analysisAttemptDirectory(dependencies = {}) {
    const root = path.resolve(dependencies.temporaryRoot || os.tmpdir());
    const persistentRoots = (dependencies.persistentRoots || []).filter(Boolean).map(value => path.resolve(value));
    if (persistentRoots.some(base => root === base || root.startsWith(`${base}${path.sep}`))) {
        fail('analysis checkpoints cannot use a persistent runtime directory');
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(root, 'historical-direct-analysis-'));
}

async function defaultAnalyze({ item, sourceDetails, sourceDescriptor, executionDirectory, dependencies }) {
    const engine = dependencies.engine || require('../analysis-engine.js');
    const sourcePaper = item.route.kind === 'conference-local-pdf'
        ? { ...sourceDetails, title: titleFromConferenceMetadata(item.route.writerInputs[0], item) } : sourceDetails;
    const freshPaper = directPaper(item, sourcePaper);
    const recovered = readAnalysisRecovery({ executionDirectory, item, sourceDescriptor, allowMissing: true });
    // Recovery is accepted only after its envelope has replayed the same
    // paper/run/source snapshot. The current direct identity wins over all
    // retained fields, while analysis/Reader checkpoints remain available to
    // deep-analyzer for fingerprint-based stage reuse.
    const paper = recovered ? { ...recovered.record, ...freshPaper } : freshPaper;
    const readerAttemptsDir = path.join(executionDirectory, 'reader-attempts');
    let result = paper;
    const persistRecovery = record => writeAnalysisRecovery({ executionDirectory, item, sourceDescriptor,
        record, updatedAt: (dependencies.now || (() => new Date().toISOString()))() });
    // The global analysis engine tolerates long-lived interactive contention,
    // but a bounded historical worker must not occupy one of its queue slots
    // for four hours when an old canonical paper lock cannot be reclaimed.
    // Fail closed and let the durable registry/recovery state drive a retry.
    const paperLockTimeoutMs = dependencies.paperLockTimeoutMs ?? 5 * 60 * 1000;
    if (!Number.isInteger(paperLockTimeoutMs) || paperLockTimeoutMs <= 0) {
        fail('paperLockTimeoutMs must be a positive integer');
    }
    const runEngine = async () => {
        const activeLockScope = directContext.getDirectRewriteAnalysisContext();
        const paperLockOptions = { timeoutMs: paperLockTimeoutMs };
        if (activeLockScope?.runId === item.runId
            && activeLockScope.paperId === item.paperId
            && activeLockScope.sourceSnapshotSha256 === sourceDescriptor.sourceSnapshotSha256
            && typeof engine.HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY === 'symbol') {
            reconcileLegacyPaperLockReclaimAudits({ executionDirectory, item, sourceDescriptor,
                engine, paper });
            paperLockOptions.recoveryPolicy = engine.HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY;
            paperLockOptions.prepareHistoricalDirectLegacyLockReclaim = intent => {
                return prepareLegacyPaperLockReclaimAudit({ executionDirectory, item, sourceDescriptor, intent });
            };
        }
        return engine.analyzeBatch([paper], {
            concurrency: 1, maxRetries: dependencies.maxRetries ?? 2, saveInterval: 0,
            paperLockOptions,
            preparePaperLocked: () => ({ paper, skip: false }),
            onPaperCheckpointLocked: checkpoint => { persistRecovery(checkpoint); },
            onPaperResultLocked: async (_paper, event) => {
                result = event.result || { ...paper, error: event.error || 'analysis failed' };
                persistRecovery(result);
            }
        });
    };
    const active = directContext.getDirectRewriteAnalysisContext();
    if (active) {
        // runDirectRewrite owns the outer scope so conference PDF page pixels
        // remain available all the way through Reader generation. Re-entering
        // AsyncLocalStorage here used to shadow them with an empty context.
        if (active.paperId !== item.paperId || active.readerAttemptsDir !== readerAttemptsDir
            || active.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256) {
            fail('default analysis was called under another direct source scope');
        }
        await runEngine();
    } else {
        const materializeReaderFigures = async (figures, id) => item.route.kind === 'arxiv-fresh-fetch'
            ? ephemeralArxivMaterializer(id, figures, dependencies)
            : [];
        const downloadPrimaryImage = item.route.kind === 'arxiv-fresh-fetch'
            ? (url => ephemeralArxivPrimaryImageDownloader(item.route.arxivId, url, dependencies)) : undefined;
        await directContext.withDirectRewriteAnalysisSource({ paperId: item.paperId, route: item.route.kind,
            sourceDetails, sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256, readerAttemptsDir,
            materializeReaderFigures, downloadPrimaryImage }, runEngine);
    }
    directContext.assertNoPersistentFigureFields(result);
    return result;
}

async function bounded(items, concurrency, callback, shouldPause = () => false) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('concurrency must be between 1 and 8');
    let cursor = 0; let paused = false;
    const worker = async () => {
        const values = [];
        while (cursor < items.length) {
            if (await shouldPause()) { paused = true; break; }
            // Another worker may have advanced the shared cursor while this
            // worker awaited the pause check. Re-check before claiming work so
            // a short final batch never dispatches an undefined item.
            if (cursor >= items.length) break;
            const item = items[cursor++];
            values.push(await callback(item));
        }
        return values;
    };
    const groups = await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return { values: groups.flat(), paused };
}

function executionDirectory(root, item, sourceDescriptor) {
    return path.join(safeDirectory(root, true, 'execution root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? sourceDescriptor.sourceRunIdentitySha256 : 'conference-local');
}
function directProvenanceFor(item, sourceDescriptor) {
    if (!sourceDescriptor || sourceDescriptor.paperId !== item.paperId
        || !SHA.test(String(sourceDescriptor.textSha256 || ''))
        || !SHA.test(String(sourceDescriptor.structuredArtifactsSha256 || ''))
        || !SHA.test(String(sourceDescriptor.sourceSnapshotSha256 || ''))) {
        fail(`${item.paperId} source descriptor is incomplete for final review`);
    }
    return { contract: directContext.PROVENANCE_CONTRACT, runId: item.runId,
        sourceSha256: sourceDescriptor.textSha256,
        structuredArtifactsSha256: sourceDescriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: sourceDescriptor.generation,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
            ...(sourceDescriptor.sourceVersion ? {
                sourceVersionIdentitySha256: sourceDescriptor.sourceVersion.identitySha256
            } : {}) } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
}

function validateInterruptedSourceDescriptor(item, sourceDescriptor, generation) {
    directProvenanceFor(item, sourceDescriptor);
    const sourceFields = item.route.kind === 'arxiv-fresh-fetch'
        ? ['kind', 'paperId', 'generation', 'sourceId', 'textSha256', 'structuredArtifactsSha256',
            'pdfSha256', 'sourceManifestSha256', 'sourceBinding', 'sourceRunIdentitySha256',
            'sourceSnapshotSha256', ...(Object.hasOwn(sourceDescriptor || {}, 'sourceVersion') ? ['sourceVersion'] : [])]
        : ['kind', 'paperId', 'sourceId', 'pdfSha256', 'textSha256',
            'structuredArtifactsSha256', 'sourceSnapshotSha256'];
    exactObjectKeys(sourceDescriptor, sourceFields, `${item.paperId} interrupted source descriptor`);
    if (sourceDescriptor.kind !== item.route.kind || sourceDescriptor.paperId !== item.paperId
        || typeof sourceDescriptor.sourceId !== 'string' || !sourceDescriptor.sourceId
        || !SHA.test(String(sourceDescriptor.pdfSha256 || ''))) {
        fail(`${item.paperId} interrupted source descriptor is invalid`);
    }
    if (item.route.kind !== 'arxiv-fresh-fetch') return clone(sourceDescriptor);
    if (sourceDescriptor.generation !== generation
        || !SHA.test(String(sourceDescriptor.sourceManifestSha256 || ''))
        || !SHA.test(String(sourceDescriptor.sourceRunIdentitySha256 || ''))) {
        fail(`${item.paperId} interrupted arXiv source belongs to another generation`);
    }
    const binding = planApi.normalizeFreshArxivSourceBinding(item, sourceDescriptor.sourceBinding);
    if (binding.generation !== generation || binding.textSha256 !== sourceDescriptor.textSha256
        || binding.pdfSha256 !== sourceDescriptor.pdfSha256
        || binding.sourceManifestSha256 !== sourceDescriptor.sourceManifestSha256
        || planApi.directSourceRunIdentity(item, binding) !== sourceDescriptor.sourceRunIdentitySha256) {
        fail(`${item.paperId} interrupted arXiv source binding drifted`);
    }
    const hasVersion = Object.hasOwn(sourceDescriptor, 'sourceVersion');
    if (/v[1-9]\d*$/i.test(sourceDescriptor.sourceId) !== hasVersion) {
        fail(`${item.paperId} interrupted arXiv version disclosure drifted`);
    }
    if (hasVersion && freshArxiv.normalizeHistoricalVersionIdentity(
        sourceDescriptor.sourceVersion, item.route.arxivId
    ).selectedSourceId !== sourceDescriptor.sourceId) {
        fail(`${item.paperId} interrupted arXiv version differs from its source ID`);
    }
    return clone(sourceDescriptor);
}

function exactObjectKeys(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.slice().sort().join('\0')) {
        fail(`${label} fields are invalid`);
    }
}

function analysisRecoveryReceipt(recovery) {
    return { filename: recovery.filename, fileSha256: recovery.fileSha256,
        recoverySha256: recovery.recoverySha256, recordSha256: recovery.recordSha256,
        updatedAt: recovery.updatedAt };
}

function recoverInterruptedRegistryEntry({ registry, plan, item, generation, executionRoot, now }) {
    const active = registry.entries.find(entry => entry.paperId === item.paperId);
    if (!['sourcing', 'source_ready', 'analyzing'].includes(active?.status)) {
        return null;
    }
    const fromStatus = active.status;
    let recovery = null;
    let recoveryStatus = 'not-applicable';
    let detail = `${fromStatus} was left by an interrupted direct process`;
    if (fromStatus === 'analyzing') {
        recoveryStatus = 'missing';
        try {
            const sourceDescriptor = validateInterruptedSourceDescriptor(item, active.source, generation);
            const directory = executionDirectory(executionRoot, item, sourceDescriptor);
            const loaded = readAnalysisRecovery({ executionDirectory: directory, item,
                sourceDescriptor, allowMissing: true });
            if (loaded && hasRecoverableAnalysisState(loaded)) {
                const receipt = analysisRecoveryReceipt(loaded);
                if (active.analysisRecovery
                    && stableHash(active.analysisRecovery) !== stableHash(receipt)) {
                    fail(`${item.paperId} interrupted registry recovery receipt drifted from its file`);
                }
                recovery = receipt;
                recoveryStatus = 'valid';
                detail = 'analyzing was interrupted; a same-source recovery envelope was replayed';
            } else if (loaded) {
                recoveryStatus = 'empty';
                detail = 'analyzing was interrupted; its recovery envelope has no recoverable stage state';
            } else {
                detail = 'analyzing was interrupted before a recovery envelope was persisted';
            }
        } catch (error) {
            recoveryStatus = 'invalid';
            detail = `analyzing was interrupted; recovery rejected: ${String(error.message || error).slice(0, 1200)}`;
        }
    }
    const normalizedStatus = recovery ? 'analysis_partial' : 'failed';
    const audit = { contract: 'historical-direct-crash-recovery-v1', version: 1,
        paperId: item.paperId, runId: item.runId, generation, fromStatus, normalizedStatus,
        recoveryStatus, sourceSnapshotSha256: SHA.test(String(active.source?.sourceSnapshotSha256 || ''))
            ? active.source.sourceSnapshotSha256 : null,
        recoverySha256: recovery?.recoverySha256 || null, recoveredAt: now, detail };
    const next = transition(registry, plan, item.paperId, normalizedStatus, {
        latestError: `[crash-recovery] ${detail}`,
        ...(recovery ? { analysisRecovery: recovery }
            : fromStatus === 'analyzing' && active.analysisRecovery ? { analysisRecovery: undefined } : {})
    }, now);
    return { registry: next, audit };
}

async function replayCompletedAnalysisForStaging({ item, active, generation, executionRoot,
    freshArxivSourceRoot, readFreshArxivSource }) {
    const sourceDescriptor = validateInterruptedSourceDescriptor(item, active.source, generation);
    if (item.route.kind === 'arxiv-fresh-fetch') {
        const stored = await readFreshArxivSource({ rootDir: freshArxivSourceRoot,
            arxivId: item.route.arxivId, generation });
        if (!stored || stored.arxivId !== item.route.arxivId || stored.generation !== generation) {
            fail(`${item.paperId} completed analysis source generation cannot be replayed`);
        }
        stored.paperId = item.paperId;
        const replayedDescriptor = compactSourceDescriptor(item.route.kind, stored, item);
        if (stableHash(replayedDescriptor) !== stableHash(sourceDescriptor)) {
            fail(`${item.paperId} completed analysis source descriptor drifted from sealed bytes`);
        }
    } else {
        planApi.verifyConferenceWriterInputs(item);
    }
    const analysisFields = ['directory', 'analysisFileSha256', 'analysisRecordSha256',
        'sourceSnapshotSha256', ...(Object.hasOwn(active.analysis || {}, 'recovery') ? ['recovery'] : [])];
    exactObjectKeys(active.analysis, analysisFields, `${item.paperId} completed analysis receipt`);
    if (!SHA.test(String(active.analysis.analysisFileSha256 || ''))
        || !SHA.test(String(active.analysis.analysisRecordSha256 || ''))
        || active.analysis.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256) {
        fail(`${item.paperId} completed analysis receipt is not bound to its source`);
    }
    const expectedDirectory = executionDirectory(executionRoot, item, sourceDescriptor);
    if (typeof active.analysis.directory !== 'string' || !path.isAbsolute(active.analysis.directory)
        || path.resolve(active.analysis.directory) !== expectedDirectory) {
        fail(`${item.paperId} completed analysis directory drifted`);
    }
    const loaded = readRegular(path.join(expectedDirectory, 'analysis.json'));
    let analysis;
    try { analysis = JSON.parse(loaded.bytes.toString('utf8')); }
    catch { fail(`${item.paperId} completed analysis file is invalid JSON`); }
    if (loaded.sha256 !== active.analysis.analysisFileSha256
        || stableHash(analysis) !== active.analysis.analysisRecordSha256) {
        fail(`${item.paperId} completed analysis bytes drifted from its receipt`);
    }
    if (active.analysis.recovery) {
        exactObjectKeys(active.analysis.recovery,
            ['filename', 'fileSha256', 'recoverySha256', 'recordSha256', 'updatedAt'],
            `${item.paperId} completed analysis recovery receipt`);
        const recovery = readAnalysisRecovery({ executionDirectory: expectedDirectory, item,
            sourceDescriptor, allowMissing: false });
        if (stableHash(analysisRecoveryReceipt(recovery)) !== stableHash(active.analysis.recovery)) {
            fail(`${item.paperId} completed analysis recovery receipt drifted`);
        }
    }
    assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis });
    return { sourceDescriptor, analysis };
}

function assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis }) {
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)
        || analysis.directPaperId !== item.paperId) {
        fail(`${item.paperId} analysis is not bound to the direct execution identity`);
    }
    directContext.assertNoPersistentFigureFields(analysis);
    const engine = require('../analysis-engine.js');
    if (!engine.isSuccessfulAnalysisRecord(analysis)) {
        fail(`${item.paperId} analysis is incomplete or failed; refusing staging`);
    }
    if (!engine.apiReaderV3BindsCanonical(analysis)) {
        fail(`${item.paperId} API Reader/provenance is incomplete; refusing staging`);
    }
    const expected = directProvenanceFor(item, sourceDescriptor);
    if (!analysis.freshRewriteProvenance || !analysis.analysisManifest?.freshRewriteProvenance
        || stableHash(analysis.freshRewriteProvenance) !== stableHash(expected)
        || stableHash(analysis.analysisManifest.freshRewriteProvenance) !== stableHash(expected)
        || analysis.sourceSha256 !== expected.sourceSha256
        || analysis.analysisManifest?.sourceAcquisition?.sourceSha256 !== expected.sourceSha256
        || analysis.analysisManifest?.sourceAcquisition?.structuredArtifactsSha256 !== expected.structuredArtifactsSha256
        || analysis.analysisManifest?.sourceAcquisition?.fullTextAvailable !== true) {
        fail(`${item.paperId} analysis provenance is not sealed to this direct source`);
    }
    return expected;
}

function stageDirectExecution({ plan, registry, item, sourceDescriptor, analysis, stagingRoot, dependencies = {} }) {
    assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis });
    const analysisRecordSha256 = stableHash(analysis);
    const analysisBytes = Buffer.from(`${JSON.stringify(canonical(analysis), null, 2)}\n`, 'utf8');
    const artifact = { paperId: item.paperId, runId: item.runId, route: item.route.kind,
        analysisFileSha256: sha256(analysisBytes), analysisRecordSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: sourceDescriptor.generation,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256, sourceTextSha256: sourceDescriptor.textSha256,
            sourcePdfSha256: sourceDescriptor.pdfSha256, sourceRunIdentitySha256: sourceDescriptor.sourceRunIdentitySha256 } : {}) };
    const stageRegistry = planApi.buildRegistry(plan, item.route.kind === 'arxiv-fresh-fetch'
        ? { sourceBindings: [sourceDescriptor.sourceBinding] } : {});
    const binding = planApi.directStagingBinding({ plan, registry: stageRegistry, paperId: item.paperId, analysisArtifact: artifact });
    directContext.assertNoPersistentFigureFields(binding);
    const directory = path.join(safeDirectory(stagingRoot, true, 'staging root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? sourceDescriptor.sourceRunIdentitySha256 : 'conference-local');
    safeDirectory(directory, true, 'direct staging directory');
    const body = { contract: STAGING_CONTRACT, version: 1, paperId: item.paperId, runId: item.runId,
        analysisArtifact: artifact, stagingBinding: binding, stagingBindingSha256: stableHash(binding) };
    const stagingInputSha256 = writeAtomic(path.join(directory, 'staging-input.json'), body);
    const pageManifest = directPages.stageDirectPages({ item, sourceDescriptor, artifact, analysis, directory,
        stagingInputSha256, stagingBindingSha256: body.stagingBindingSha256,
        dependencies: { ...dependencies, assertCompleteAnalysis: candidate =>
            assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis: candidate }) } });
    return { directory, stagingBindingSha256: body.stagingBindingSha256, analysisArtifact: artifact,
        pageStaging: directPages.receipt(pageManifest) };
}

function replayDirectPageStaging({ item, active, stagingRoot, executionRoot }) {
    const staging = active?.staging;
    if (!staging?.pageStaging || !staging.analysisArtifact || !active?.source || !active?.analysis) {
        fail(`${item.paperId} staged execution lacks a direct page staging receipt`);
    }
    const directory = path.join(safeDirectory(stagingRoot, false, 'staging root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? active.source.sourceRunIdentitySha256 : 'conference-local');
    safeDirectory(directory, false, 'direct staging directory');
    if (path.resolve(staging.directory) !== directory) fail(`${item.paperId} staged page directory drifted`);
    const stagingInput = readRegular(path.join(directory, 'staging-input.json'));
    const body = JSON.parse(stagingInput.bytes.toString('utf8'));
    if (body?.stagingBindingSha256 !== staging.stagingBindingSha256
        || stableHash(body?.analysisArtifact) !== stableHash(staging.analysisArtifact)) {
        fail(`${item.paperId} staged page input drifted from the registry`);
    }
    const executionDirectory = path.join(safeDirectory(executionRoot, false, 'execution root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? active.source.sourceRunIdentitySha256 : 'conference-local');
    if (path.resolve(active.analysis.directory) !== executionDirectory) fail(`${item.paperId} staged analysis directory drifted`);
    const storedAnalysis = readRegular(path.join(executionDirectory, 'analysis.json'));
    const analysis = JSON.parse(storedAnalysis.bytes.toString('utf8'));
    if (storedAnalysis.sha256 !== active.analysis.analysisFileSha256
        || stableHash(analysis) !== active.analysis.analysisRecordSha256
        || staging.analysisArtifact.analysisFileSha256 !== active.analysis.analysisFileSha256
        || staging.analysisArtifact.analysisRecordSha256 !== active.analysis.analysisRecordSha256) {
        fail(`${item.paperId} staged analysis bytes drifted`);
    }
    const manifest = directPages.validateManifest({
        value: JSON.parse(readRegular(path.join(directory, 'page-staging-manifest.json')).bytes.toString('utf8')),
        item, sourceDescriptor: active.source, artifact: staging.analysisArtifact, analysis,
        stagingInputSha256: stagingInput.sha256, stagingBindingSha256: body.stagingBindingSha256, directory,
        rendererImplementationSha256: staging.pageStaging.rendererImplementationSha256,
        assertCompleteAnalysis: candidate => assertDirectAnalysisReadyForStaging({ item, sourceDescriptor: active.source, analysis: candidate })
    });
    if (stableHash(directPages.receipt(manifest)) !== stableHash(staging.pageStaging)) {
        fail(`${item.paperId} staged page receipt drifted`);
    }
    return manifest;
}

async function sealedFailureHandoff({ root, plan, item, generation, error, observedAt, writeFailureHandoff }) {
    const written = await writeFailureHandoff({ root, plan, paperId: item.paperId, generation, error, observedAt });
    if (!written || typeof written !== 'object' || !['created', 'recovered'].includes(written.status)
        || typeof written.handoffName !== 'string' || !SHA.test(String(written.fileSha256 || ''))
        || !written.handoff) {
        fail(`${item.paperId} arXiv failure handoff writer returned an invalid receipt`);
    }
    const handoff = planApi.normalizeArxivFreshFailureHandoff(written.handoff);
    const expectedName = planApi.arxivFreshFailureHandoffName(handoff);
    if (written.handoffName !== expectedName || handoff.paperId !== item.paperId
        || handoff.arxivId !== item.route.arxivId || handoff.generation !== generation) {
        fail(`${item.paperId} arXiv failure handoff is not bound to the failed fresh source`);
    }
    const stored = planApi.readArxivFreshFailureHandoff({ root, handoffName: written.handoffName });
    if (stored.fileSha256 !== written.fileSha256 || stored.handoff.handoffSha256 !== handoff.handoffSha256) {
        fail(`${item.paperId} arXiv failure handoff bytes drifted before the failure was recorded`);
    }
    return { status: written.status, handoffName: written.handoffName, fileSha256: stored.fileSha256,
        handoffSha256: stored.handoff.handoffSha256 };
}

async function runDirectRewriteLocked({ options, plan, registryFile, pauseFile,
    lockTarget }, dependencies = {}) {
    const arxivGeneration = checkedArxivGeneration(options.arxivGeneration || 1);
    const now = (dependencies.now || (() => new Date().toISOString()))();
    let { filename, registry } = loadOrCreateRegistry({ registryRoot: options.registryRoot, plan, now, arxivGeneration });
    if (filename !== registryFile) fail('registry path changed after the direct-run operation lock was acquired');
    const { items: selected, selection } = selectDirectItems(plan, options, registry);
    const persist = () => { writeAtomic(registryFile, registry); };
    // Production direct-run is replay-only. The scheduler owns every network
    // acquisition and failure handoff; this phase may only read the exact
    // generation it marked ready. The legacy dependency name remains as a
    // fixture injection point for tests, but the production default cannot
    // fetch or repair a missing bundle.
    const readFreshArxivSource = dependencies.captureFreshArxivRewriteSource
        || freshArxiv.readFreshArxivRewriteSource;
    const analyze = dependencies.analyze || defaultAnalyze;
    const runOne = async item => {
        let active = registry.entries.find(entry => entry.paperId === item.paperId);
        let executionDir = null; let descriptor = null;
        if (active.status === 'analysis_complete') {
            try {
                const completed = await replayCompletedAnalysisForStaging({ item, active,
                    generation: arxivGeneration, executionRoot: options.executionRoot,
                    freshArxivSourceRoot: options.freshArxivSourceRoot, readFreshArxivSource });
                const staging = stageDirectExecution({ plan, registry, item,
                    sourceDescriptor: completed.sourceDescriptor, analysis: completed.analysis,
                    stagingRoot: options.stagingRoot, dependencies });
                registry = transition(registry, plan, item.paperId, 'staged', {
                    staging, latestError: null
                }, now);
                persist();
                const audit = { contract: 'historical-direct-crash-recovery-v1', version: 1,
                    paperId: item.paperId, runId: item.runId, generation: arxivGeneration,
                    fromStatus: 'analysis_complete', normalizedStatus: 'staged',
                    recoveryStatus: 'completed-analysis-replayed',
                    sourceSnapshotSha256: completed.sourceDescriptor.sourceSnapshotSha256,
                    recoverySha256: active.analysis?.recovery?.recoverySha256 || null,
                    recoveredAt: now, detail: 'analysis_complete bytes and source were replayed; LLM analysis was not repeated' };
                console.warn(`[historical-direct-rewrite] ${JSON.stringify(audit)}`);
                if (typeof dependencies.onCrashRecoveryAudit === 'function') {
                    dependencies.onCrashRecoveryAudit(clone(audit));
                }
                return { paperId: item.paperId, status: 'staged' };
            } catch (error) {
                const detail = `analysis_complete replay rejected: ${String(error.message || error).slice(0, 1200)}`;
                registry = transition(registry, plan, item.paperId, 'failed', {
                    latestError: `[crash-recovery] ${detail}`
                }, now);
                persist();
                const audit = { contract: 'historical-direct-crash-recovery-v1', version: 1,
                    paperId: item.paperId, runId: item.runId, generation: arxivGeneration,
                    fromStatus: 'analysis_complete', normalizedStatus: 'failed',
                    recoveryStatus: 'completed-analysis-invalid',
                    sourceSnapshotSha256: SHA.test(String(active.source?.sourceSnapshotSha256 || ''))
                        ? active.source.sourceSnapshotSha256 : null,
                    recoverySha256: active.analysis?.recovery?.recoverySha256 || null,
                    recoveredAt: now, detail };
                console.warn(`[historical-direct-rewrite] ${JSON.stringify(audit)}`);
                if (typeof dependencies.onCrashRecoveryAudit === 'function') {
                    dependencies.onCrashRecoveryAudit(clone(audit));
                }
                active = registry.entries.find(entry => entry.paperId === item.paperId);
            }
        }
        const interrupted = recoverInterruptedRegistryEntry({ registry, plan, item,
            generation: arxivGeneration, executionRoot: options.executionRoot, now });
        if (interrupted) {
            registry = interrupted.registry;
            persist();
            console.warn(`[historical-direct-rewrite] ${JSON.stringify(interrupted.audit)}`);
            if (typeof dependencies.onCrashRecoveryAudit === 'function') {
                dependencies.onCrashRecoveryAudit(clone(interrupted.audit));
            }
            active = registry.entries.find(entry => entry.paperId === item.paperId);
        }
        if (active.status === 'staged') {
            try {
                if (item.route.kind === 'arxiv-fresh-fetch') {
                    // A staged record is recoverable only from the same sealed
                    // generation.  The per-generation registry name prevents a
                    // new generation from selecting it; this replay check also
                    // catches a deleted or substituted source bundle.
                    const stored = freshArxiv.readFreshArxivRewriteSource({ rootDir: options.freshArxivSourceRoot,
                        arxivId: item.route.arxivId, generation: arxivGeneration });
                    if (active.source?.generation !== arxivGeneration
                        || active.source?.sourceManifestSha256 !== stored.sourceManifestSha256
                        || active.source?.textSha256 !== stored.manifest.text.responseSha256
                        || active.source?.pdfSha256 !== stored.manifest.pdf.responseSha256) {
                        fail(`${item.paperId} staged output belongs to a different sealed arXiv source generation`);
                    }
                }
                else {
                    // Replay both planned local bytes before treating the
                    // staged analysis as recoverable.  This rehashes metadata
                    // and every local PDF against the immutable plan values.
                    planApi.verifyConferenceWriterInputs(item);
                }
                replayDirectPageStaging({ item, active, stagingRoot: options.stagingRoot, executionRoot: options.executionRoot });
            } catch (error) {
                registry = transition(registry, plan, item.paperId, 'failed', {
                    latestError: String(error.message).slice(0, 2000)
                }, now); persist();
                return { paperId: item.paperId, status: 'failed', error: String(error.message) };
            }
            return { paperId: item.paperId, status: 'recovered' };
        }
        try {
            registry = transition(registry, plan, item.paperId, 'sourcing', {
                attempts: active.attempts + 1, latestError: null
            }, now); persist();
            let source, sourceDetails;
            if (item.route.kind === 'arxiv-fresh-fetch') {
                source = await readFreshArxivSource({ rootDir: options.freshArxivSourceRoot,
                    arxivId: item.route.arxivId, generation: arxivGeneration });
                if (!source || source.arxivId !== item.route.arxivId || !source.manifest
                    || source.generation !== arxivGeneration || !SHA.test(String(source.sourceManifestSha256 || ''))
                    || !SHA.test(String(source.manifest.text?.responseSha256 || ''))
                    || !SHA.test(String(source.manifest.pdf?.responseSha256 || ''))
                    || (!source.runtimeDetails && typeof source.text !== 'string')) {
                    fail(`${item.paperId} sealed arXiv source replay mismatched the plan`);
                }
                source.paperId = item.paperId; sourceDetails = source.runtimeDetails || fallbackArxivDetails(source);
            } else { source = await extractConferenceSource(item, dependencies); sourceDetails = source.sourceDetails; }
            descriptor = compactSourceDescriptor(item.route.kind, source, item);
            registry = transition(registry, plan, item.paperId, 'source_ready', { source: descriptor }, now); persist();
            registry = transition(registry, plan, item.paperId, 'analyzing', {}, now); persist();
            executionDir = executionDirectory(options.executionRoot, item, descriptor); safeDirectory(executionDir, true, 'paper execution directory');
            const executionDependencies = { ...dependencies, freshArxivSourceRoot: options.freshArxivSourceRoot,
                persistentRoots: [options.registryRoot, options.executionRoot, options.stagingRoot] };
            const readerAttemptsDir = path.join(executionDir, 'reader-attempts');
            const materializeReaderFigures = async (figures, id) => item.route.kind === 'arxiv-fresh-fetch'
                ? ephemeralArxivMaterializer(id, figures, executionDependencies)
                : [];
            const downloadPrimaryImage = item.route.kind === 'arxiv-fresh-fetch'
                ? (url => ephemeralArxivPrimaryImageDownloader(item.route.arxivId, url, executionDependencies)) : undefined;
            // Keep the source scope around injected test workers as well as the
            // production engine. That makes request-capture tests exercise the
            // same no-old-input boundary as a real model call. Conference PDF
            // page bytes are injected here and stay visible through all nested
            // analysis/Reader calls until the OS-temporary renderer cleans up.
            const invokeAnalysis = supplementaryReaderImages => directContext.withDirectRewriteAnalysisSource({ paperId: item.paperId,
                runId: item.runId, route: item.route.kind, sourceDetails: clone(sourceDetails),
                sourceSha256: descriptor.textSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
                sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
                ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: descriptor.generation,
                    sourceManifestSha256: descriptor.sourceManifestSha256,
                    ...(descriptor.sourceVersion ? {
                        sourceVersionIdentitySha256: descriptor.sourceVersion.identitySha256
                    } : {}) } : {}),
                readerAttemptsDir, materializeReaderFigures, downloadPrimaryImage, supplementaryReaderImages }, () => analyze({ item,
                sourceDetails: clone(sourceDetails), sourceDescriptor: descriptor, executionDirectory: executionDir,
                dependencies: executionDependencies }));
            const analysis = item.route.kind === 'conference-local-pdf'
                ? await withEphemeralConferenceFigures({ pdfPath: item.route.writerInputs[0]?.pdf.absolutePath },
                    invokeAnalysis, executionDependencies)
                : await invokeAnalysis([]);
            // The final contract is checked before the durable analysis file
            // as well as inside stageDirectExecution. Failed/partial engine
            // results remain in the registry error only; no execution record
            // or staging input is allowed to outlive this attempt.
            assertDirectAnalysisReadyForStaging({ item, sourceDescriptor: descriptor, analysis });
            const analysisFile = path.join(executionDir, 'analysis.json');
            const analysisFileSha256 = writeAtomic(analysisFile, analysis);
            const analysisRecovery = readAnalysisRecovery({ executionDirectory: executionDir, item,
                sourceDescriptor: descriptor, allowMissing: true });
            registry = transition(registry, plan, item.paperId, 'analysis_complete', { analysis: { directory: executionDir,
                analysisFileSha256, analysisRecordSha256: stableHash(analysis), sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
                ...(analysisRecovery ? { recovery: { filename: analysisRecovery.filename,
                    fileSha256: analysisRecovery.fileSha256, recoverySha256: analysisRecovery.recoverySha256,
                    recordSha256: analysisRecovery.recordSha256, updatedAt: analysisRecovery.updatedAt } } : {}) },
                analysisRecovery: undefined }, now); persist();
            const staging = stageDirectExecution({ plan, registry, item, sourceDescriptor: descriptor, analysis,
                stagingRoot: options.stagingRoot, dependencies: executionDependencies });
            registry = transition(registry, plan, item.paperId, 'staged', { staging }, now); persist();
            return { paperId: item.paperId, status: 'staged' };
        } catch (error) {
            active = registry.entries.find(entry => entry.paperId === item.paperId);
            if (active && active.status !== 'staged' && TRANSITIONS.get(active.status)?.has('failed')) {
                let recovery = null;
                if (executionDir && descriptor) {
                    recovery = readAnalysisRecovery({ executionDirectory: executionDir, item,
                        sourceDescriptor: descriptor, allowMissing: true });
                }
                const recoveryReceipt = recovery && hasRecoverableAnalysisState(recovery) ? {
                    filename: recovery.filename, fileSha256: recovery.fileSha256,
                    recoverySha256: recovery.recoverySha256, recordSha256: recovery.recordSha256,
                    updatedAt: recovery.updatedAt
                } : null;
                const recoverablePartial = active.status === 'analyzing' && recoveryReceipt
                    && TRANSITIONS.get(active.status)?.has('analysis_partial');
                registry = transition(registry, plan, item.paperId,
                    recoverablePartial ? 'analysis_partial' : 'failed', {
                        latestError: String(error.message).slice(0, 2000),
                        ...(recoveryReceipt ? { analysisRecovery: recoveryReceipt } : {})
                    }, now); persist();
                return { paperId: item.paperId, status: recoverablePartial ? 'analysis_partial' : 'failed',
                    error: String(error.message) };
            }
            return { paperId: item.paperId, status: 'failed', error: String(error.message) };
        }
    };
    let completedThisRun = 0;
    const pauseRequested = async () => Boolean(await dependencies.shouldPause?.()) || pauseFileRequested(pauseFile, plan, arxivGeneration);
    const boundedResult = await bounded(selected, options.concurrency || 3, async item => {
        const result = await runOne(item); completedThisRun += 1;
        const current = normalizeRegistry(registry, plan); const counts = registryCounts(current);
        const event = { contract: 'historical-direct-rewrite-progress-v1', version: 1,
            planSha256: plan.planSha256, arxivGeneration, queue: selection.queue,
            selectedCount: selected.length, completedThisRun, remainingSelected: selected.length - completedThisRun,
            paperId: item.paperId, outcome: result.status, registrySha256: current.registrySha256,
            registryCounts: counts, pauseRequested: await pauseRequested() };
        if (dependencies.onProgress) await dependencies.onProgress(event);
        // A progress consumer may create the persistent pause marker.  Refresh
        // the same event object after the callback so in-process monitors and
        // tests observe the committed control state, while the CLI emission
        // still truthfully describes the state at emission time.
        event.pauseRequested = await pauseRequested();
        return result;
    }, pauseRequested);
    const results = boundedResult.values;
    const final = normalizeRegistry(registry, plan);
    const paused = boundedResult.paused || results.length < selected.length && await pauseRequested();
    const counts = registryCounts(final);
    return { status: paused ? 'paused' : results.some(item => ['failed', 'handoff', 'analysis_partial'].includes(item.status)) ? 'partial' : 'complete',
        planSha256: plan.planSha256, arxivGeneration, selection, progress: { selected: selected.length, processed: results.length,
            remaining: selected.length - results.length }, pauseFile, operationLockTarget: lockTarget,
        operationLockPath: `${lockTarget}.lock`, registryFile,
        registrySha256: final.registrySha256, staged: final.entries.filter(item => item.status === 'staged').length,
        failed: final.entries.filter(item => item.status === 'failed').length,
        analysisPartial: final.entries.filter(item => item.status === 'analysis_partial').length, registryCounts: counts,
        results: results.sort((a, b) => a.paperId.localeCompare(b.paperId)) };
}

function registryCounts(registry) {
    const counts = Object.fromEntries([...STATES].sort().map(status => [status, 0]));
    for (const entry of registry.entries) counts[entry.status] += 1;
    return counts;
}

async function runDirectRewrite(options = {}, dependencies = {}) {
    const plan = planApi.normalizePlan(options.plan);
    const arxivGeneration = checkedArxivGeneration(options.arxivGeneration || 1);
    const hasRegistryRoot = typeof options.registryRoot === 'string' && path.isAbsolute(options.registryRoot);
    const registryFile = hasRegistryRoot ? registryPath(options.registryRoot, plan, arxivGeneration) : null;
    let existingRegistry = null;
    if (options.apply !== true && registryFile && fs.existsSync(registryFile)) {
        existingRegistry = normalizeRegistry(JSON.parse(readRegular(registryFile).bytes.toString('utf8')), plan);
    }
    const { items: selected, selection } = selectDirectItems(plan, options, existingRegistry);
    if (options.pauseFile !== undefined && options.pauseFile !== null
        && (typeof options.pauseFile !== 'string' || !path.isAbsolute(options.pauseFile))) fail('pauseFile must be absolute');
    const pauseFile = options.pauseFile || (hasRegistryRoot
        ? defaultPauseFilePath(options.registryRoot, plan, arxivGeneration) : null);
    const lockTarget = hasRegistryRoot ? operationLockTarget(options.registryRoot, plan, arxivGeneration) : null;
    const hasSourceRoot = typeof options.freshArxivSourceRoot === 'string'
        && path.isAbsolute(options.freshArxivSourceRoot);
    const sourcePrerequisite = hasSourceRoot ? sourcePrerequisiteSnapshot({ sourceRoot: options.freshArxivSourceRoot,
        plan, generation: arxivGeneration, selected, required: options.apply === true }) : null;
    if (options.apply !== true) return { status: 'dry-run', planSha256: plan.planSha256, arxivGeneration,
        paperCount: selected.length, paperIds: selected.map(item => item.paperId), selection, pauseFile, operationLockTarget: lockTarget,
        operationLockPath: lockTarget === null ? null : `${lockTarget}.lock`, sourcePrerequisite };
    for (const key of ['registryRoot', 'executionRoot', 'stagingRoot', 'freshArxivSourceRoot']) {
        if (typeof options[key] !== 'string' || !path.isAbsolute(options[key])) fail(`${key} is required`);
    }
    safeDirectory(options.registryRoot, true, 'registry root');
    if (typeof pauseFile !== 'string' || !path.isAbsolute(pauseFile)) fail('pauseFile is required');
    const engine = require('../analysis-engine.js');
    const withOperationLock = dependencies.withOperationLock
        || ((target, callback, lockOptions) => engine.withFileLock(target, callback, lockOptions));
    const operationLockOptions = {
        ...(dependencies.lockOptions || {}),
        recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
    };
    const result = await withOperationLock(lockTarget, () => runDirectRewriteLocked({ options, plan,
        registryFile, pauseFile, lockTarget }, dependencies), operationLockOptions);
    return { ...result, sourcePrerequisite };
}

module.exports = { CONTRACT, REGISTRY_CONTRACT, STAGING_CONTRACT, ANALYSIS_RECOVERY_CONTRACT,
    HistoricalDirectRewriteRunnerError, stableHash,
    STATES, registryName, registryPath, defaultPauseFilePath, operationLockTarget, pauseFileRequested, selectDirectItems,
    initialRegistry, normalizeRegistry, loadOrCreateRegistry, transition, registryCounts, directPaper, fallbackArxivDetails,
    analysisRecoveryPath, analysisRecoveryRecord, normalizeAnalysisRecovery, writeAnalysisRecovery,
    readAnalysisRecovery, normalizeLegacyPaperLockReclaimIntent, normalizeLegacyPaperLockReclaimCompletion,
    legacyPaperLockReclaimEventId,
    legacyPaperLockReclaimPaths, prepareLegacyPaperLockReclaimAudit,
    reconcileLegacyPaperLockReclaimAudits, hasRecoverableAnalysisState, sourcePrerequisiteSnapshot,
    priorPreprintAnalysisDisclosure, extractConferenceSource, ephemeralArxivMaterializer, ephemeralArxivPrimaryImageDownloader,
    withEphemeralConferenceFigures, renderConferencePdfPages,
    directProvenanceFor, assertDirectAnalysisReadyForStaging, replayDirectPageStaging,
    validateInterruptedSourceDescriptor, recoverInterruptedRegistryEntry,
    replayCompletedAnalysisForStaging,
    stageDirectExecution, defaultAnalyze, sealedFailureHandoff, runDirectRewrite };
