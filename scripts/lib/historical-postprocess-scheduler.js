'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fresh = require('./fresh-rewrite-run.js');
const pageStaging = require('./historical-page-staging.js');
const aggregateApi = require('./historical-daily-aggregate.js');

const CONTRACT = 'historical-postprocess-scheduler-v1';
const ANALYSIS_SCHEDULER_CONTRACT = 'historical-arxiv-analysis-scheduler-v1';
const VERSION = 1;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const stableHash = fresh.stableHash;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fail(message) { const error = new Error(`Historical postprocess rejected: ${message}`);
    error.code = 'HISTORICAL_POSTPROCESS_INTEGRITY'; error.retryable = false; throw error; }
function uuidFrom(value) { const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
function deterministicStagingRunId(crosswalkId, item, registrySha256, rendererImplementationSha256) {
    if (!UUID_RE.test(crosswalkId || '') || !SHA_RE.test(registrySha256 || '')
        || !SHA_RE.test(rendererImplementationSha256 || '')
        || !item || !/^arxiv:\d{4}\.\d{4,5}$/.test(item.paperId || '') || !UUID_RE.test(item.runId || '')) fail('staging identity is invalid');
    if (!SHA_RE.test(item.analysisSchedulerItemSha256 || '')) fail('analysis scheduler item binding SHA is invalid');
    return uuidFrom(`historical-postprocess-staging-v2\0${crosswalkId}\0${item.paperId}\0${item.runId}\0${registrySha256}\0${rendererImplementationSha256}\0${item.analysisSchedulerItemSha256}`);
}
function checkpointPath(root, crosswalkId, registrySha256, rendererImplementationSha256, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !UUID_RE.test(crosswalkId || '')
        || !SHA_RE.test(registrySha256 || '') || !SHA_RE.test(rendererImplementationSha256 || '')) {
        fail('configured checkpoint root, crosswalk UUID, registry SHA, and renderer implementation SHA required');
    }
    const directory = fresh.assertSafeDirectory(root, create);
    return path.join(directory, `${crosswalkId}.${registrySha256}.${rendererImplementationSha256}.json`);
}
function sealCheckpoint(value) { const body = structuredClone(value); delete body.checkpointSha256;
    return { ...body, checkpointSha256: stableHash(body) }; }
function validateCheckpoint(value, crosswalkId, registrySha256, rendererImplementationSha256) {
    if (!value || value.contract !== CONTRACT || value.version !== VERSION || value.crosswalkId !== crosswalkId
        || value.registrySha256 !== registrySha256
        || value.rendererImplementationSha256 !== rendererImplementationSha256
        || !SHA_RE.test(value.rendererImplementationSha256 || '') || !value.items || typeof value.items !== 'object'
        || Array.isArray(value.items) || !value.daily || typeof value.daily !== 'object' || Array.isArray(value.daily)
        || !Number.isSafeInteger(value.generation) || value.generation < 1) fail('checkpoint identity/schema drifted');
    if (Object.values(value.items).some(item => !item || item.rendererImplementationSha256 !== rendererImplementationSha256)) {
        fail('checkpoint item renderer implementation binding drifted');
    }
    const body = structuredClone(value); delete body.checkpointSha256;
    if (!SHA_RE.test(value.checkpointSha256 || '') || value.checkpointSha256 !== stableHash(body)) fail('checkpoint self-SHA drifted');
    return structuredClone(value);
}
function readJsonFile(filename, label) { const loaded = pageStaging.readRegular(filename, 64 * 1024 * 1024, label);
    return { value: pageStaging.strictJson(loaded.bytes, label), fileSha256: loaded.fileSha256 }; }
function readAnalysisScheduler(root, crosswalkId) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('analysis scheduler root must be configured absolute path');
    const directory = fresh.assertSafeDirectory(root); const filename = path.join(directory, `${crosswalkId}.json`);
    const loaded = readJsonFile(filename, 'historical analysis scheduler'); const value = loaded.value;
    if (value.contract !== ANALYSIS_SCHEDULER_CONTRACT || value.version !== 1 || value.crosswalkId !== crosswalkId
        || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) fail('analysis scheduler identity/schema is invalid');
    return { ...loaded, filename };
}
function analysisSchedulerItemBinding(paperId, item) {
    return { paperId, status: item.status, runId: item.runId, analysisDate: item.analysisDate,
        cohortDates: item.cohortDates || [], pageKeys: item.pageKeys || [], groupSha256: item.groupSha256 || null,
        identitySha256: item.identitySha256 || null, identityRecordSha256: item.identityRecordSha256 || null,
        authorityName: item.authorityName || null, authorityFileSha256: item.authorityFileSha256 || null };
}
function completeItems(snapshot) {
    return Object.entries(snapshot.value.items).map(([paperId, item]) => ({ ...structuredClone(item), paperId,
        analysisSchedulerItemSha256: stableHash(analysisSchedulerItemBinding(paperId, item)) }))
        .filter(item => item.status === 'complete').sort((a, b) => a.paperId.localeCompare(b.paperId));
}
function defaultDependencies() {
    const Config = require('../config.js'); const taxonomy = require('./historical-taxonomy-assignment.js');
    const registry = require('./paper-taxonomy.js'); const history = require('./historical-arxiv-analysis.js');
    const engine = require('../analysis-engine.js');
    return { files: Config.FILES, now: () => new Date().toISOString(),
        readCrosswalk: args => require('./page-source-crosswalk.js').readCrosswalk(args),
        recoverRun: args => history.recoverHistoricalArxivRun(args), loadTaxonomy: filename => registry.loadTaxonomy(filename),
        loadAnalysisRun: args => taxonomy.loadCompletedHistoricalAnalysisRun(args), runSnapshot: handle => taxonomy.runSnapshot(handle),
        buildAssignments: args => taxonomy.buildAssignments(args), writeAssignments: args => taxonomy.writeAssignments(args),
        stagePages: args => pageStaging.stageHistoricalPages(args),
        rendererImplementationSha256: () => pageStaging.currentRendererImplementationSha256(),
        loadAggregateInputs: args => aggregateApi.loadAggregateInputs(args), buildAggregates: args => aggregateApi.buildDailyAggregates(args),
        writeAggregates: args => aggregateApi.writeAggregates(args), aggregateRunIdFor: ids => aggregateApi.aggregateRunIdFor(ids),
        updateLocked: engine.updateJsonFileLocked };
}
function updateCheckpoint(filename, crosswalkId, registrySha256, rendererImplementationSha256, deps, mutate) {
    return deps.updateLocked(filename, current => {
        const prior = current ? validateCheckpoint(current, crosswalkId, registrySha256, rendererImplementationSha256)
            : sealCheckpoint({ contract: CONTRACT, version: VERSION, crosswalkId, registrySha256,
                rendererImplementationSha256,
                generation: 1, createdAt: deps.now(), updatedAt: deps.now(), items: {}, daily: {} });
        const next = mutate(structuredClone(prior)); delete next.checkpointSha256;
        const priorSemantic = structuredClone(prior); delete priorSemantic.checkpointSha256;
        delete priorSemantic.updatedAt; delete priorSemantic.generation;
        const nextSemantic = structuredClone(next); delete nextSemantic.updatedAt; delete nextSemantic.generation;
        if (current && stableHash(priorSemantic) === stableHash(nextSemantic)) return undefined;
        next.generation = (current?.generation || 0) + 1;
        next.updatedAt = deps.now(); return sealCheckpoint(next);
    }, { allowMissing: true });
}

async function mapConcurrent(items, concurrency, worker) {
    let cursor = 0; const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) { const index = cursor++; results[index] = await worker(items[index], index); }
    }));
    return results;
}

async function runHistoricalPostprocess(options, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides }; const files = deps.files;
    if (!UUID_RE.test(options.crosswalkId || '') || !Number.isInteger(options.concurrency)
        || options.concurrency < 1 || options.concurrency > 3 || ![null, 'pilot'].includes(options.limit)
            && (!Number.isSafeInteger(options.limit) || options.limit < 1)
        || options.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) fail('invalid options');
    const analysisScheduler = readAnalysisScheduler(files.historicalAnalysisSchedulerDir, options.crosswalkId);
    const taxonomy = deps.loadTaxonomy(files.taxonomyRegistry);
    if (!SHA_RE.test(taxonomy.registrySha256 || '')) fail('current taxonomy registry SHA is invalid');
    const rendererImplementationSha256 = typeof deps.rendererImplementationSha256 === 'function'
        ? deps.rendererImplementationSha256() : deps.rendererImplementationSha256;
    if (!SHA_RE.test(rendererImplementationSha256 || '')) fail('current renderer implementation SHA is invalid');
    const crosswalk = deps.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir, crosswalkId: options.crosswalkId });
    const allComplete = completeItems(analysisScheduler);
    const relevantComplete = options.date ? allComplete.filter(item => (item.cohortDates || []).includes(options.date)) : allComplete;
    const drySealed = options.apply ? relevantComplete : relevantComplete.filter(item => {
        try { const recovered = deps.recoverRun({ runId: item.runId, date: item.analysisDate,
            arxivId: item.paperId.slice(6), rootDir: files.freshRewriteRunsDir,
            now: deps.now() });
            return recovered?.storageSealed === true
                && recovered.currentContractComplete === true; }
        catch { return false; }
    });
    const available = options.apply ? relevantComplete : drySealed; const maximum = options.limit === 'pilot' ? 1
        : options.limit === null ? available.length : options.limit; const selected = available.slice(0, maximum);
    const plan = selected.map(item => ({ paperId: item.paperId, analysisRunId: item.runId,
        rendererImplementationSha256,
        stagingRunId: deterministicStagingRunId(options.crosswalkId, item, taxonomy.registrySha256,
            rendererImplementationSha256),
        cohortDates: item.cohortDates || [] }));
    if (!options.apply) return { status: 'dry-run', crosswalkId: options.crosswalkId,
        registrySha256: taxonomy.registrySha256, analysisSchedulerFileSha256: analysisScheduler.fileSha256,
        rendererImplementationSha256,
        checkpointComplete: allComplete.length, relevantComplete: relevantComplete.length,
        completeAvailable: drySealed.length, unsealed: relevantComplete.length - drySealed.length, selected: plan };
    const filename = checkpointPath(files.historicalPostprocessSchedulerDir, options.crosswalkId,
        taxonomy.registrySha256, rendererImplementationSha256, true);
    updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
        rendererImplementationSha256, deps, value => value);
    const outcomes = await mapConcurrent(selected, options.concurrency, async item => {
        const stagingRunId = deterministicStagingRunId(options.crosswalkId, item, taxonomy.registrySha256,
            rendererImplementationSha256);
        let assignmentProof = null;
        try {
            const recovered = deps.recoverRun({ runId: item.runId, date: item.analysisDate,
                arxivId: item.paperId.slice(6), rootDir: files.freshRewriteRunsDir,
                now: deps.now() });
            if (!(recovered?.storageSealed === true
                && recovered.currentContractComplete === true)) {
                fail(`${item.paperId} analysis run is not current-contract complete`);
            }
            const handle = deps.loadAnalysisRun({ analysisRoot: files.freshRewriteRunsDir, runId: item.runId });
            const assignments = deps.buildAssignments({ runHandle: handle, taxonomy, paperId: item.paperId });
            if (assignments.length !== 1) fail(`${item.paperId} taxonomy assignment result is not singular`);
            const assignmentOutput = deps.writeAssignments({ outputRoot: files.historicalTaxonomyAssignmentDir, assignments })[0];
            assignmentProof = { taxonomyAssignmentSha256: assignments[0].assignmentSha256,
                taxonomyFileSha256: assignmentOutput.fileSha256 };
            if (assignments[0].status !== 'assigned') fail(`${item.paperId} taxonomy assignment is blocked`);
            const staged = await deps.stagePages({ apply: true, crosswalkId: options.crosswalkId,
                analysisRunId: item.runId, stagingRunId, limit: null,
                rendererImplementationSha256,
                crosswalkRoot: files.pageSourceCrosswalkDir, analysisRoot: files.freshRewriteRunsDir,
                taxonomyRoot: files.historicalTaxonomyAssignmentDir, taxonomyRegistry: files.taxonomyRegistry,
                stagingRoot: files.historicalPageStagingDir });
            const record = { status: 'staged', paperId: item.paperId, analysisRunId: item.runId,
                analysisSchedulerItemSha256: item.analysisSchedulerItemSha256,
                registrySha256: taxonomy.registrySha256, rendererImplementationSha256,
                ...assignmentProof, stagingRunId,
                stagingManifestSha256: staged.manifestSha256, cohortDates: item.cohortDates || [], lastError: null };
            updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
                rendererImplementationSha256, deps, value => {
                value.items[item.paperId] = record; return value;
            }); return record;
        } catch (error) {
            const record = { status: 'failed', paperId: item.paperId, analysisRunId: item.runId,
                analysisSchedulerItemSha256: item.analysisSchedulerItemSha256, registrySha256: taxonomy.registrySha256,
                rendererImplementationSha256, ...(assignmentProof || {}), stagingRunId,
                lastError: String(error.message).slice(0, 2000) };
            updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
                rendererImplementationSha256, deps, value => {
                value.items[item.paperId] = record; return value;
            }); return record;
        }
    });
    let checkpoint = validateCheckpoint(readJsonFile(filename, 'historical postprocess checkpoint').value,
        options.crosswalkId, taxonomy.registrySha256, rendererImplementationSha256);
    const pages = new Map(crosswalk.source.papers.map(page => [page.pageKey, page]));
    const pageOwners = new Map();
    for (const group of crosswalk.identityGroups) for (const pageKey of group.pageKeys) pageOwners.set(pageKey, group.paperId);
    const dates = options.date ? [options.date] : [...new Set([...pages.values()]
        .filter(page => page.scope.type === 'daily').map(page => page.cohortDate))].sort();
    const daily = [];
    for (const date of dates) {
        const datePages = [...pages.values()].filter(page => page.scope.type === 'daily' && page.cohortDate === date);
        const paperIds = [...new Set(datePages.map(page => pageOwners.get(page.pageKey)))];
        const ready = datePages.length > 0 && !paperIds.includes(undefined)
            && paperIds.every(paperId => checkpoint.items[paperId]?.status === 'staged'
                && checkpoint.items[paperId].rendererImplementationSha256 === rendererImplementationSha256);
        if (!ready) {
            const record = { date, status: 'blocked', rendererImplementationSha256,
                reason: 'not-all-date-papers-staged' };
            updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
                rendererImplementationSha256, deps, value => {
                value.daily[date] = record; return value;
            }); daily.push(record); continue;
        }
        const stagingRunIds = [...new Set(paperIds.map(paperId => checkpoint.items[paperId].stagingRunId))].sort();
        try {
            const inputs = deps.loadAggregateInputs({ stagingRoot: files.historicalPageStagingDir, stagingRunIds,
                crosswalkRoot: files.pageSourceCrosswalkDir, inventoryRoot: files.historicalPageInventoryDir,
                analysisRoot: files.freshRewriteRunsDir, taxonomyRoot: files.historicalTaxonomyAssignmentDir,
                taxonomyRegistry: files.taxonomyRegistry });
            const aggregates = deps.buildAggregates({ inputs, date });
            const aggregateRunId = deps.aggregateRunIdFor(stagingRunIds);
            const outputs = deps.writeAggregates({ outputRoot: files.historicalDailyAggregateDir, aggregateRunId, aggregates });
            const record = { date, status: 'staged', rendererImplementationSha256,
                aggregateRunId, stagingRunIds,
                manifestSha256: aggregates[0].manifestSha256, fileSha256: outputs[0].fileSha256 };
            updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
                rendererImplementationSha256, deps, value => {
                value.daily[date] = record; return value;
            }); daily.push(record);
        } catch (error) {
            const record = { date, status: 'blocked', rendererImplementationSha256,
                reason: String(error.message).slice(0, 2000) };
            updateCheckpoint(filename, options.crosswalkId, taxonomy.registrySha256,
                rendererImplementationSha256, deps, value => {
                value.daily[date] = record; return value;
            }); daily.push(record);
        }
    }
    checkpoint = validateCheckpoint(readJsonFile(filename, 'historical postprocess checkpoint').value,
        options.crosswalkId, taxonomy.registrySha256, rendererImplementationSha256);
    return { status: outcomes.every(item => item.status === 'staged') && daily.every(item => item.status === 'staged')
        && selected.length === relevantComplete.length ? 'complete' : 'partial', crosswalkId: options.crosswalkId,
        registrySha256: taxonomy.registrySha256, rendererImplementationSha256,
        processed: outcomes, daily, checkpoint: filename,
        checkpointSha256: checkpoint.checkpointSha256 };
}

module.exports = { CONTRACT, VERSION, ANALYSIS_SCHEDULER_CONTRACT, stableHash, deterministicStagingRunId,
    checkpointPath, sealCheckpoint, validateCheckpoint, readAnalysisScheduler, analysisSchedulerItemBinding, completeItems,
    mapConcurrent, runHistoricalPostprocess };
