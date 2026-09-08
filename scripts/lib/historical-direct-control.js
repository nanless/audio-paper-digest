'use strict';

// Read-only progress reporting plus explicit pause/resume markers for the
// long-running direct historical rewrite.  The runner observes the marker
// only between papers, so an active paper can finish its atomic registry and
// staging transition before the queue stops accepting more work.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const planApi = require('./historical-direct-rewrite-plan.js');
const runner = require('./historical-direct-rewrite-runner.js');
const aggregateApi = require('./historical-direct-aggregate.js');
const directPages = require('./historical-direct-page-staging.js');
const projectionIo = require('./historical-conference-page-projections.js');

const PAUSE_CONTRACT = 'historical-direct-rewrite-pause-request-v1';
const STATUS_CONTRACT = 'historical-direct-rewrite-status-v1';
const SOURCE_STATUS_CONTRACT = 'historical-direct-source-status-v1';
const SHA_RE = /^[a-f0-9]{64}$/;

class HistoricalDirectControlError extends Error {
    constructor(message) {
        super(`Historical direct rewrite control rejected: ${message}`);
        this.name = 'HistoricalDirectControlError';
        this.code = 'HISTORICAL_DIRECT_REWRITE_CONTROL_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalDirectControlError(message); };
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');

function generationNumber(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('generation must be a positive safe integer');
    return value;
}
function configuredRoot(value, label, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    const absolute = path.resolve(value);
    if (!fs.existsSync(absolute)) {
        if (!create) return absolute;
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}
function controlPaths({ registryRoot, plan, generation = 1 } = {}) {
    const normalized = planApi.normalizePlan(plan); const checked = generationNumber(generation);
    const root = configuredRoot(registryRoot, 'registry root');
    const registryFile = path.join(root, runner.registryName(normalized, checked));
    const pauseFile = `${registryFile}.pause`;
    const operationLockTarget = `${registryFile}.direct-run-operation`;
    return { registryFile, pauseFile, operationLockTarget, operationLockDirectory: `${operationLockTarget}.lock` };
}
function sourceControlPaths({ sourceRoot, plan, generation = 1 } = {}) {
    const normalized = planApi.normalizePlan(plan); const checked = generationNumber(generation);
    const root = configuredRoot(sourceRoot, 'fresh arXiv source root');
    const suffix = String(checked).padStart(6, '0');
    const base = path.join(root, `.${normalized.planSha256}.generation-${suffix}.source`);
    const operationLockTarget = `${base}.scheduler-operation`;
    return { pauseFile: `${base}.pause`, statusFile: `${base}.status.json`, operationLockTarget,
        operationLockDirectory: `${operationLockTarget}.lock` };
}

function sourceStatusRecord(plan, generation, createdAt) {
    const normalized = planApi.normalizePlan(plan); generationNumber(generation);
    const entries = normalized.queue.map(item => ({ paperId: item.paperId, route: item.route.kind,
        status: 'pending', attempts: 0, updatedAt: null, outcomeSha256: null, error: null }));
    const body = { contract: SOURCE_STATUS_CONTRACT, version: 1, planSha256: normalized.planSha256,
        generation, createdAt, entries, entrySetSha256: stableHash(entries) };
    return { ...body, statusSha256: stableHash(body) };
}
function normalizeSourceStatus(value, plan, generation) {
    const normalized = planApi.normalizePlan(plan);
    const fields = ['contract', 'version', 'planSha256', 'generation', 'createdAt', 'entries',
        'entrySetSha256', 'statusSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')
        || value.contract !== SOURCE_STATUS_CONTRACT || value.version !== 1
        || value.planSha256 !== normalized.planSha256 || value.generation !== generation
        || Number.isNaN(Date.parse(value.createdAt || '')) || new Date(value.createdAt).toISOString() !== value.createdAt
        || !Array.isArray(value.entries) || !SHA_RE.test(value.entrySetSha256 || '') || !SHA_RE.test(value.statusSha256 || '')) {
        fail('source status envelope is invalid');
    }
    const expected = new Map(normalized.queue.map(item => [item.paperId, item.route.kind])); const seen = new Set();
    const entries = value.entries.map(entry => {
        const entryFields = ['paperId', 'route', 'status', 'attempts', 'updatedAt', 'outcomeSha256', 'error'];
        if (!entry || Object.keys(entry).sort().join('\0') !== entryFields.sort().join('\0')
            || expected.get(entry.paperId) !== entry.route || seen.has(entry.paperId)
            || !['pending', 'ready', 'handoff', 'failed'].includes(entry.status)
            || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0
            || entry.updatedAt !== null && (Number.isNaN(Date.parse(entry.updatedAt)) || new Date(entry.updatedAt).toISOString() !== entry.updatedAt)
            || entry.outcomeSha256 !== null && !SHA_RE.test(entry.outcomeSha256)
            || entry.error !== null && typeof entry.error !== 'string') fail('source status entry is invalid');
        seen.add(entry.paperId); return structuredClone(entry);
    });
    if (seen.size !== expected.size || entries.some((entry, index) => entry.paperId !== normalized.queue[index].paperId)
        || stableHash(entries) !== value.entrySetSha256) fail('source status does not exactly cover the plan queue');
    const body = { contract: value.contract, version: value.version, planSha256: value.planSha256,
        generation: value.generation, createdAt: value.createdAt, entries, entrySetSha256: value.entrySetSha256 };
    if (stableHash(body) !== value.statusSha256) fail('source status SHA drifted');
    return { ...body, statusSha256: value.statusSha256 };
}
function readSourceStatus({ sourceRoot, plan, generation = 1 } = {}) {
    const paths = sourceControlPaths({ sourceRoot, plan, generation });
    if (!fs.existsSync(paths.statusFile)) return null;
    const loaded = projectionIo.readStableJson(paths.statusFile, 'direct source status');
    return { filename: paths.statusFile, fileSha256: loaded.fileSha256,
        status: normalizeSourceStatus(loaded.value, plan, generation) };
}
function writeAtomicStatus(filename, value) {
    const root = configuredRoot(path.dirname(filename), 'source status root');
    const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) fail('source status target is unsafe');
    const temporary = path.join(root, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, prettyBytes(value)); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
function loadOrCreateSourceStatus({ sourceRoot, plan, generation = 1, now = new Date().toISOString(), apply = false } = {}) {
    const existing = readSourceStatus({ sourceRoot, plan, generation });
    if (existing || !apply) return existing;
    configuredRoot(sourceRoot, 'fresh arXiv source root', true);
    const paths = sourceControlPaths({ sourceRoot, plan, generation }); const status = sourceStatusRecord(plan, generation, now);
    writeAtomicStatus(paths.statusFile, status);
    return readSourceStatus({ sourceRoot, plan, generation });
}
function updateSourceStatus({ sourceRoot, plan, generation = 1, event, now = new Date().toISOString() } = {}) {
    const loaded = readSourceStatus({ sourceRoot, plan, generation });
    if (!loaded) fail('source status must be created under the scheduler operation lock');
    const current = loaded.status; const index = current.entries.findIndex(item => item.paperId === event?.paperId);
    if (index < 0 || !['ready', 'handoff', 'failed'].includes(event?.status)) fail('source progress event is invalid');
    const entries = current.entries.slice(); const before = entries[index];
    entries[index] = { ...before, status: event.status, attempts: before.attempts + 1, updatedAt: now,
        outcomeSha256: stableHash(event), error: event.status === 'failed' ? String(event.error || 'source failed').slice(0, 2000) : null };
    const body = { contract: SOURCE_STATUS_CONTRACT, version: 1, planSha256: current.planSha256,
        generation: current.generation, createdAt: current.createdAt, entries, entrySetSha256: stableHash(entries) };
    const status = { ...body, statusSha256: stableHash(body) }; writeAtomicStatus(loaded.filename, status);
    return { filename: loaded.filename, status };
}
function sourceStatusCounts(status, plan = null) {
    const counts = { pending: 0, ready: 0, handoff: 0, failed: 0 };
    if (status) for (const entry of status.entries) counts[entry.status] += 1;
    else if (plan) counts.pending = plan.queue.length;
    return counts;
}
function sourceStatusCountsByRoute(status, plan) {
    const empty = () => ({ pending: 0, ready: 0, handoff: 0, failed: 0 });
    const byRoute = { arxiv: empty(), conference: empty() };
    const entries = status?.entries || plan.queue.map(item => ({ route: item.route.kind, status: 'pending' }));
    for (const entry of entries) {
        const bucket = entry.route === 'arxiv-fresh-fetch' ? byRoute.arxiv
            : entry.route === 'conference-local-pdf' ? byRoute.conference : null;
        if (!bucket || !Object.hasOwn(bucket, entry.status)) fail('source status route is invalid');
        bucket[entry.status] += 1;
    }
    return byRoute;
}
function phasePaths({ phase = 'analysis', registryRoot, sourceRoot, plan, generation = 1 } = {}) {
    if (phase === 'analysis') return controlPaths({ registryRoot, plan, generation });
    if (phase === 'source') return sourceControlPaths({ sourceRoot, plan, generation });
    fail('control phase must be source or analysis');
}

function pauseRecord(plan, generation, requestedAt) {
    const normalized = planApi.normalizePlan(plan); const checked = generationNumber(generation);
    if (Number.isNaN(Date.parse(requestedAt || '')) || new Date(requestedAt).toISOString() !== requestedAt) {
        fail('pause request time must be canonical ISO-8601');
    }
    const body = { contract: PAUSE_CONTRACT, version: 1, planSha256: normalized.planSha256,
        generation: checked, requestedAt };
    return { ...body, requestSha256: stableHash(body) };
}
function normalizePauseRecord(value, plan, generation) {
    const expectedKeys = ['contract', 'version', 'planSha256', 'generation', 'requestedAt', 'requestSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')) fail('pause request schema is invalid');
    const expected = pauseRecord(plan, generation, value.requestedAt);
    if (value.requestSha256 !== expected.requestSha256 || !SHA_RE.test(value.requestSha256)) fail('pause request SHA drifted');
    return expected;
}
function readPauseFile(filename, plan, generation) {
    if (!fs.existsSync(filename)) return null;
    const loaded = projectionIo.readStableJson(filename, 'direct rewrite pause request');
    return { record: normalizePauseRecord(loaded.value, plan, generation), fileSha256: loaded.fileSha256 };
}
function writePauseRequest({ phase = 'analysis', registryRoot, sourceRoot, plan, generation = 1,
    requestedAt = new Date().toISOString() } = {}) {
    configuredRoot(phase === 'analysis' ? registryRoot : sourceRoot,
        phase === 'analysis' ? 'registry root' : 'fresh arXiv source root', true);
    const paths = phasePaths({ phase, registryRoot, sourceRoot, plan, generation });
    const record = pauseRecord(plan, generation, requestedAt);
    const bytes = prettyBytes(record); let fd;
    try {
        fd = fs.openSync(paths.pauseFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return { status: 'pause-requested', phase, ...paths, record };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readPauseFile(paths.pauseFile, plan, generation);
        return { status: 'already-pause-requested', phase, ...paths, record: existing.record };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function lockPresent(lockDirectory) {
    const stat = fs.lstatSync(lockDirectory, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('direct-run operation lock is unsafe');
    return true;
}
function resumeRewrite({ phase = 'analysis', registryRoot, sourceRoot, plan, generation = 1 } = {}) {
    const paths = phasePaths({ phase, registryRoot, sourceRoot, plan, generation });
    if (lockPresent(paths.operationLockDirectory)) {
        fail('direct-run still holds its operation lock; wait for active papers to finish before resume');
    }
    const existing = readPauseFile(paths.pauseFile, plan, generation);
    if (!existing) return { status: 'already-running', phase, ...paths };
    const before = fs.lstatSync(paths.pauseFile);
    const replay = readPauseFile(paths.pauseFile, plan, generation);
    const current = fs.lstatSync(paths.pauseFile);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size
        || replay.fileSha256 !== existing.fileSha256) fail('pause request changed before resume');
    fs.unlinkSync(paths.pauseFile);
    return { status: 'resumed', phase, ...paths, removedRequestSha256: existing.record.requestSha256 };
}

function registrySnapshot({ registryFile, plan, currentRendererImplementationSha256 = null } = {}) {
    if (!SHA_RE.test(String(currentRendererImplementationSha256 || ''))) {
        fail('current direct renderer implementation SHA is invalid');
    }
    if (!fs.existsSync(registryFile)) {
        const counts = Object.fromEntries([...runner.STATES || []].sort().map(status => [status, 0]));
        if (!Object.keys(counts).length) for (const status of ['pending', 'sourcing', 'source_ready', 'analyzing', 'analysis_partial', 'analysis_complete', 'staged', 'failed']) counts[status] = 0;
        counts.pending = plan.queue.length;
        return { present: false, registrySha256: null, counts,
            currentRendererImplementationSha256, currentStagedCount: 0,
            staleStagedCount: 0, staleStagedPaperIds: [], lastUpdatedAt: null, recentFailures: [] };
    }
    const loaded = projectionIo.readStableJson(registryFile, 'direct rewrite registry');
    const registry = runner.normalizeRegistry(loaded.value, plan); const counts = runner.registryCounts(registry);
    const updates = registry.entries.map(item => item.updatedAt).filter(Boolean).sort();
    const recentFailures = registry.entries.filter(item => item.status === 'failed')
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .slice(0, 20).map(item => ({ paperId: item.paperId, route: item.route,
            updatedAt: item.updatedAt || null, error: item.latestError || null }));
    const staleStaged = registry.entries.filter(item => item.status === 'staged'
        && item.staging?.pageStaging?.rendererImplementationSha256 !== currentRendererImplementationSha256);
    return { present: true, fileSha256: loaded.fileSha256, registrySha256: registry.registrySha256,
        counts, currentRendererImplementationSha256,
        currentStagedCount: (counts.staged || 0) - staleStaged.length,
        staleStagedCount: staleStaged.length,
        staleStagedPaperIds: staleStaged.map(item => item.paperId).slice(0, 20),
        lastUpdatedAt: updates.at(-1) || null, recentFailures };
}

function expectedCohorts(plan) {
    const daily = [...new Set(plan.projectedPages.filter(page => page.scope.type === 'daily').map(page => page.scope.key))].sort();
    const conference = [...new Set(plan.projectedPages.filter(page => page.scope.type === 'conference').map(page => page.scope.key))].sort();
    return { daily, conference };
}
function safeChildren(root) {
    if (!fs.existsSync(root)) return [];
    configuredRoot(root, 'status scan root');
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink());
}
function aggregateSnapshot({ aggregateRoot, plan, expectedTaskKeys = [] } = {}) {
    const expected = expectedCohorts(plan); const found = new Map(); const errors = [];
    for (const directory of safeChildren(aggregateRoot).filter(entry => entry.isDirectory())) {
        const runRoot = path.join(aggregateRoot, directory.name);
        for (const entry of safeChildren(runRoot).filter(item => item.isFile() && /^(?:daily|conference|conference-task)-[a-z0-9-]+\.json$/.test(item.name))) {
            const filename = path.join(runRoot, entry.name);
            try {
                const loaded = projectionIo.readStableJson(filename, 'direct aggregate status input'); const value = loaded.value;
                if (value?.contract !== aggregateApi.CONTRACT || value?.version !== aggregateApi.VERSION
                    || value?.status !== 'complete' || value?.source?.planSha256 !== plan.planSha256) continue;
                const body = structuredClone(value); const manifestSha256 = body.manifestSha256; delete body.manifestSha256;
                if (!SHA_RE.test(manifestSha256 || '') || aggregateApi.stableHash(body) !== manifestSha256) {
                    fail('direct aggregate manifest SHA drifted');
                }
                const stagedPath = value.outputPage?.stagedPath;
                if (typeof stagedPath !== 'string' || !stagedPath.startsWith('pages/content/posts/')
                    || !SHA_RE.test(value.outputPage?.contentSha256 || '')) fail('direct aggregate output page binding is invalid');
                const pageFile = path.resolve(runRoot, ...stagedPath.split('/'));
                if (!pageFile.startsWith(`${path.resolve(runRoot, 'pages')}${path.sep}`)
                    || projectionIo.readStableFile(pageFile, 'direct aggregate status page').fileSha256 !== value.outputPage.contentSha256) {
                    fail('direct aggregate output page bytes drifted');
                }
                const key = `${value.scope}:${value.key}`; const prior = found.get(key);
                if (prior && prior.manifestSha256 !== manifestSha256) fail(`multiple direct aggregates disagree for ${key}`);
                found.set(key, { scope: value.scope, key: value.key, manifestSha256, filename });
            } catch (error) { errors.push({ filename, error: String(error.message).slice(0, 500) }); }
        }
    }
    const completeDaily = expected.daily.filter(key => found.has(`daily:${key}`));
    const completeConference = expected.conference.filter(key => found.has(`conference:${key}`));
    const expectedTaskSet = new Set(expectedTaskKeys.map(key => `conference-task:${key}`));
    const observedTaskKeys = [...found.keys()].filter(key => key.startsWith('conference-task:'));
    const unexpectedTaskKeys = observedTaskKeys.filter(key => !expectedTaskSet.has(key));
    if (unexpectedTaskKeys.length) errors.push({ filename: null,
        error: `unexpected conference-task aggregates: ${unexpectedTaskKeys.slice(0, 20).join(', ')}` });
    const completeTasks = [...expectedTaskSet].filter(key => found.has(key)).length;
    return { expected: { daily: expected.daily.length, conference: expected.conference.length,
        conferenceTask: expectedTaskSet.size, aggregate: expected.daily.length + expected.conference.length,
        total: expected.daily.length + expected.conference.length + expectedTaskSet.size },
        complete: { daily: completeDaily.length, conference: completeConference.length, conferenceTask: completeTasks,
            aggregate: completeDaily.length + completeConference.length,
            total: completeDaily.length + completeConference.length + completeTasks },
        missing: { daily: expected.daily.filter(key => !found.has(`daily:${key}`)),
            conference: expected.conference.filter(key => !found.has(`conference:${key}`)),
            conferenceTask: [...expectedTaskSet].filter(key => !found.has(key)).map(key => key.slice('conference-task:'.length)) },
        unexpectedTaskKeys, errors };
}

function taskSnapshot({ aggregateProjectionRoot, plan } = {}) {
    const matches = [];
    for (const entry of safeChildren(aggregateProjectionRoot).filter(item => item.isFile() && item.name.endsWith('.json'))) {
        const filename = path.join(aggregateProjectionRoot, entry.name);
        try {
            const loaded = projectionIo.readStableJson(filename, 'direct aggregate projection status input'); const value = loaded.value;
            if (value?.contract !== aggregateApi.PROJECTION_CONTRACT || value?.version !== aggregateApi.PROJECTION_VERSION
                || value?.planSha256 !== plan.planSha256) continue;
            const normalized = aggregateApi.normalizeAggregateProjection(value, plan);
            matches.push({ filename, coverage: normalized.conferenceTaskCoverage || null,
                pageCoverage: normalized.pageCoverage || null,
                expectedTaskKeys: normalized.conferenceTaskPages.map(page => `${page.conferenceKey}-${page.legacyTaskKey}`).sort(),
                projectionSha256: normalized.projectionSha256 });
        } catch { /* unrelated or incomplete diagnostic file */ }
    }
    if (!matches.length) return { projectionPresent: false, total: null, pending: null, publicationReady: false };
    const identities = new Set(matches.map(item => item.projectionSha256));
    if (identities.size !== 1) fail('multiple aggregate projections disagree for the same direct plan');
    const coverage = matches[0].coverage; const pageCoverage = matches[0].pageCoverage;
    return { projectionPresent: true, total: coverage?.total ?? 0, pending: coverage?.pending ?? 0,
        publicationReady: coverage?.publicationReady === true, reason: coverage?.reason ?? null,
        expectedTaskKeys: matches[0].expectedTaskKeys, pageCoverage,
        projectionFile: matches[0].filename };
}

function inspectConferenceSource(item, verifySha = false) {
    const paths = item.route.writerInputs.flatMap(source => [source?.metadata?.absolutePath, source?.pdf?.absolutePath]);
    if (!paths.length || paths.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename))) {
        return { status: 'failed', error: 'conference source paths are incomplete' };
    }
    for (const filename of paths) {
        let stat;
        try { stat = fs.lstatSync(filename); }
        catch (error) {
            if (error.code === 'ENOENT') return { status: 'missing', error: `missing source: ${filename}` };
            return { status: 'failed', error: String(error.message).slice(0, 500) };
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
            return { status: 'failed', error: `unsafe source: ${filename}` };
        }
    }
    if (item.route.writerInputs.some(source => fs.statSync(source.pdf.absolutePath).size !== source.pdf.bytes)) {
        return { status: 'failed', error: 'conference PDF size drifted' };
    }
    if (verifySha) {
        try { planApi.verifyConferenceWriterInputs(item); }
        catch (error) { return { status: 'failed', error: String(error.message).slice(0, 500) }; }
    }
    return { status: 'ready', error: null };
}

function sourceSnapshot({ sourceRoot, plan, generation = 1, verifySources = false } = {}) {
    const checked = generationNumber(generation); const fresh = require('./fresh-arxiv-rewrite-source.js');
    const arxiv = plan.queue.filter(item => item.route.kind === 'arxiv-fresh-fetch'); let observedSealedBundles = 0;
    const conferenceItems = plan.queue.filter(item => item.route.kind === 'conference-local-pdf');
    const incompleteBundlePaperIds = [];
    const progress = fs.existsSync(sourceRoot) ? readSourceStatus({ sourceRoot, plan, generation }) : null;
    const counts = progress ? sourceStatusCounts(progress.status)
        : { pending: plan.queue.length, ready: 0, handoff: 0, failed: 0 };
    const byRoute = sourceStatusCountsByRoute(progress?.status || null, plan);
    if (fs.existsSync(sourceRoot)) {
        configuredRoot(sourceRoot, 'fresh arXiv source root');
        for (const item of arxiv) {
            const directory = fresh.sourceDirectory(sourceRoot, item.route.arxivId, checked);
            const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
            if (!entry) continue;
            if (!entry.isDirectory() || entry.isSymbolicLink()) { incompleteBundlePaperIds.push(item.paperId); continue; }
            const names = fs.readdirSync(directory).sort();
            if (names.join('\0') !== fresh.SOURCE_FILES.slice().sort().join('\0')) {
                incompleteBundlePaperIds.push(item.paperId); continue;
            }
            const safe = names.every(name => { const stat = fs.lstatSync(path.join(directory, name));
                return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; });
            if (!safe) { incompleteBundlePaperIds.push(item.paperId); continue; }
            if (verifySources) {
                try { fresh.readFreshArxivRewriteSource({ rootDir: sourceRoot,
                    arxivId: item.route.arxivId, generation: checked }); observedSealedBundles += 1; }
                catch { incompleteBundlePaperIds.push(item.paperId); }
            } else observedSealedBundles += 1;
        }
    }
    const conferenceResults = conferenceItems.map(item => ({ paperId: item.paperId,
        ...inspectConferenceSource(item, verifySources) }));
    const conferenceCounts = { ready: 0, failed: 0, missing: 0 };
    for (const result of conferenceResults) conferenceCounts[result.status] += 1;
    return { checkpoint: { present: Boolean(progress), filename: progress?.filename || null,
        statusSha256: progress?.status.statusSha256 || null, counts }, arxiv: { total: arxiv.length, observedSealedBundles,
        remaining: arxiv.length - observedSealedBundles, incompleteBundlePaperIds: incompleteBundlePaperIds.slice(0, 20),
        observationOnly: !verifySources, deepShaVerified: verifySources }, conference: { total: conferenceItems.length, ...conferenceCounts,
            missingPaperIds: conferenceResults.filter(item => item.status === 'missing').map(item => item.paperId).slice(0, 20),
            failedPaperIds: conferenceResults.filter(item => item.status === 'failed').map(item => item.paperId).slice(0, 20),
            deepShaVerified: verifySources, durableSchedulerProgressAvailable: Boolean(progress) }, progressByRoute: byRoute };
}

function buildStatus({ planFile, generation = 1, registryRoot, aggregateRoot, aggregateProjectionRoot,
    sourceRoot, publicationRoot, publicationId = null, blogRepo = null, remoteName = 'origin', liveRemote = null,
    verifySources = false, observedAt = new Date().toISOString() } = {}, dependencies = {}) {
    const loaded = projectionIo.readStableJson(planFile, 'direct rewrite status plan');
    const plan = planApi.normalizePlan(loaded.value); const paths = controlPaths({ registryRoot, plan, generation });
    const pause = readPauseFile(paths.pauseFile, plan, generation); const sourcePaths = sourceControlPaths({ sourceRoot, plan, generation });
    const sourcePause = readPauseFile(sourcePaths.pauseFile, plan, generation);
    const currentRendererImplementationSha256 = directPages.currentRendererImplementationSha256({
        rendererImplementationSha256: dependencies.currentRendererImplementationSha256
    });
    const execution = registrySnapshot({ registryFile: paths.registryFile, plan,
        currentRendererImplementationSha256 });
    const running = lockPresent(paths.operationLockDirectory); const sourceRunning = lockPresent(sourcePaths.operationLockDirectory);
    const sources = sourceSnapshot({ sourceRoot, plan, generation,
        verifySources: verifySources || publicationId !== null });
    const tasks = taskSnapshot({ aggregateProjectionRoot, plan });
    const aggregates = aggregateSnapshot({ aggregateRoot, plan, expectedTaskKeys: tasks.expectedTaskKeys || [] });
    const total = plan.queue.length; const staged = execution.currentStagedCount || 0;
    const coverage = plan.paperPageCoverage || { frozenPaperPages: null, projectedPaperPages: plan.projectedPages.length,
        uncoveredFrozenPaperPages: null, coverageComplete: false };
    const blockers = [];
    if (coverage.coverageComplete !== true) blockers.push({ code: 'uncovered-paper-pages', count: coverage.uncoveredFrozenPaperPages });
    if (total && !sources.checkpoint.present) blockers.push({ code: 'source-checkpoint-missing', count: total });
    for (const status of ['pending', 'handoff', 'failed']) {
        const count = sources.checkpoint.counts[status] || 0;
        if (count) blockers.push({ code: `source-${status}`, count });
    }
    if ((sources.checkpoint.counts.ready || 0) !== total) blockers.push({ code: 'sources-not-ready',
        count: total - (sources.checkpoint.counts.ready || 0) });
    if (sources.arxiv.remaining) blockers.push({ code: 'arxiv-source-bundles-missing', count: sources.arxiv.remaining });
    if (sources.conference.missing) blockers.push({ code: 'conference-sources-missing', count: sources.conference.missing });
    if (sources.conference.failed) blockers.push({ code: 'conference-sources-failed', count: sources.conference.failed });
    if (!execution.present) blockers.push({ code: 'execution-not-started', count: total });
    else {
        if ((execution.counts.failed || 0) > 0) blockers.push({ code: 'failed-papers', count: execution.counts.failed });
        if (execution.staleStagedCount > 0) blockers.push({ code: 'stale-staged-renderer', count: execution.staleStagedCount });
        if (staged !== total) blockers.push({ code: 'papers-not-staged', count: total - staged });
    }
    if (!tasks.projectionPresent) blockers.push({ code: 'aggregate-projection-missing' });
    else if (tasks.pageCoverage?.publicationReady !== true || tasks.pageCoverage?.uncoveredPageKeys?.length !== 0
        || tasks.pageCoverage?.coveredPageCount !== tasks.pageCoverage?.inventoryPageCount) {
        blockers.push({ code: 'aggregate-page-coverage-incomplete',
            count: tasks.pageCoverage?.inventoryPageCount - tasks.pageCoverage?.coveredPageCount || null });
    }
    else if (!tasks.publicationReady) blockers.push({ code: 'conference-task-pages-pending', count: tasks.pending });
    else if (aggregates.missing.conferenceTask.length) {
        blockers.push({ code: 'conference-task-aggregates-missing', count: aggregates.missing.conferenceTask.length });
    }
    const missingAggregates = aggregates.missing.daily.length + aggregates.missing.conference.length;
    if (missingAggregates) blockers.push({ code: 'aggregates-missing', count: missingAggregates });
    if (aggregates.errors.length) blockers.push({ code: 'aggregate-artifact-errors', count: aggregates.errors.length });
    let publication;
    if (publicationId === null) {
        publication = { supported: true, selected: false, complete: false,
            outputRoot: publicationRoot || null, publicationId: null, liveRemoteRequested: false };
        blockers.push({ code: 'historical-publication-not-selected' });
    } else {
        const effectiveLiveRemote = liveRemote !== false;
        const publicationStatus = dependencies.publicationStatus || require('./historical-direct-publication.js').status;
        publication = publicationStatus({ outputRoot: publicationRoot,
            publicationId, liveRemote: effectiveLiveRemote, blogRepo, remoteName }, dependencies.publicationDependencies || {});
        publication = { supported: true, selected: true, outputRoot: publicationRoot,
            liveRemoteRequested: effectiveLiveRemote, ...publication };
        if (publication.planSha256 && publication.planSha256 !== plan.planSha256) {
            publication = { ...publication, complete: false, planMatchesHistory: false };
            blockers.push({ code: 'historical-publication-plan-mismatch' });
        } else {
            publication.planMatchesHistory = publication.planSha256 === plan.planSha256;
            if (!publication.complete) blockers.push({ code: 'historical-publication-incomplete', phase: publication.phase });
        }
    }
    const pauseRequested = Boolean(pause || sourcePause); const operationRunning = running || sourceRunning;
    const phase = pauseRequested && operationRunning ? 'pausing' : pauseRequested ? 'paused' : operationRunning ? 'running'
        : !execution.present ? 'not-started'
        : staged < total ? 'idle-incomplete' : missingAggregates || aggregates.missing.conferenceTask.length ? 'awaiting-aggregates'
            : blockers.length ? 'awaiting-closeout' : 'complete';
    const complete = blockers.length === 0;
    return { contract: STATUS_CONTRACT, version: 1, observedAt, plan: { filename: planFile,
        fileSha256: loaded.fileSha256, planSha256: plan.planSha256, canonicalPapers: total,
        projectedPages: plan.projectedPages.length, coverage }, execution: { generation: generationNumber(generation),
        registryFile: paths.registryFile, pauseFile: paths.pauseFile, operationLockDirectory: paths.operationLockDirectory,
        running, pauseRequested: Boolean(pause), progressPercent: total ? Number((staged * 100 / total).toFixed(2)) : 100,
        ...execution }, sources: { ...sources, pauseFile: sourcePaths.pauseFile,
            operationLockDirectory: sourcePaths.operationLockDirectory, running: sourceRunning,
            pauseRequested: Boolean(sourcePause) }, aggregates, conferenceTasks: tasks,
    publication, completion: { phase: complete ? 'complete' : phase, complete, blockers } };
}

module.exports = { PAUSE_CONTRACT, STATUS_CONTRACT, SOURCE_STATUS_CONTRACT, HistoricalDirectControlError, stableHash, generationNumber,
    controlPaths, sourceControlPaths, phasePaths, pauseRecord, normalizePauseRecord, readPauseFile,
    sourceStatusRecord, normalizeSourceStatus, readSourceStatus, loadOrCreateSourceStatus, updateSourceStatus, sourceStatusCounts,
    sourceStatusCountsByRoute,
    writePauseRequest, resumeRewrite, registrySnapshot, sourceSnapshot, aggregateSnapshot, taskSnapshot, buildStatus };
