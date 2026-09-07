#!/usr/bin/env node
'use strict';

// This entrypoint only prepares source queues.  It never invokes analysis,
// Reader, rendering, crosswalk mutation, blog generation, or publication.
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const planApi = require('./lib/historical-direct-rewrite-plan.js');
const projectionApi = require('./lib/historical-conference-page-projections.js');
const control = require('./lib/historical-direct-control.js');

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json [--queue all|arxiv|conference] [--generation N] [--arxiv-concurrency 1-8] [--conference-concurrency 1-8] [--paper-ids ID[,ID...]] [--max-papers N|--limit N] [--pause-file ABSOLUTE]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 2 || rest.length > 16 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--queue', '--generation', '--arxiv-concurrency', '--conference-concurrency', '--paper-ids', '--max-papers', '--limit', '--pause-file'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (values['--max-papers'] !== undefined && values['--limit'] !== undefined) throw new Error(`Use ${USAGE}`);
    const maximum = values['--max-papers'] ?? values['--limit'];
    const paperIds = values['--paper-ids'] === undefined ? [] : values['--paper-ids'].split(',').map(id => id.trim());
    if (!path.isAbsolute(values['--plan'] || '') || (values['--queue'] !== undefined && !['all', 'arxiv', 'conference'].includes(values['--queue']))
        || (values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation']))
        || ['--arxiv-concurrency', '--conference-concurrency'].some(flag => values[flag] !== undefined && !/^[1-8]$/.test(values[flag]))
        || (maximum !== undefined && !/^[1-9]\d{0,8}$/.test(maximum)) || paperIds.some(id => !id)
        || new Set(paperIds).size !== paperIds.length
        || (values['--pause-file'] !== undefined && !path.isAbsolute(values['--pause-file']))) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']), queue: values['--queue'] || 'all',
        arxivGeneration: Number(values['--generation'] || 1), arxivConcurrency: Number(values['--arxiv-concurrency'] || 3),
        conferenceConcurrency: Number(values['--conference-concurrency'] || 5), paperIds,
        maxPapers: maximum === undefined ? null : Number(maximum), pauseFile: values['--pause-file'] || null };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-scheduler.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.freshArxivFetchedSourcesDir !== 'string' || !path.isAbsolute(files.freshArxivFetchedSourcesDir)
        || typeof files.historicalArxivFreshFailureHandoffDir !== 'string'
        || !path.isAbsolute(files.historicalArxivFreshFailureHandoffDir)) {
        throw new Error('freshArxivFetchedSourcesDir and historicalArxivFreshFailureHandoffDir must be configured absolute paths');
    }
    const loaded = projectionApi.readStableJson(options.planFile, 'direct rewrite plan');
    const plan = planApi.normalizePlan(loaded.value);
    const generation = String(options.arxivGeneration).padStart(6, '0');
    const base = path.join(files.freshArxivFetchedSourcesDir, `.${plan.planSha256}.generation-${generation}.source`);
    const pauseFile = options.pauseFile || `${base}.pause`; const lockTarget = `${base}.scheduler-operation`;
    let stopped = false; const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { stopped = true;
        console.error(`[historical-direct-rewrite-scheduler] received ${signal}; finishing active sources before pausing`); }]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const pauseRequested = () => { const entry = require('node:fs').lstatSync(pauseFile, { throwIfNoEntry: false });
        if (!entry) return stopped; if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('source pause file is unsafe');
        return true; };
    let completedThisRun = 0; let sourceStatus = null;
    const invoke = async () => {
        sourceStatus = control.loadOrCreateSourceStatus({ sourceRoot: files.freshArxivFetchedSourcesDir,
            plan, generation: options.arxivGeneration, apply: options.apply });
        const completedPaperIds = sourceStatus?.status.entries.filter(item => item.status === 'ready').map(item => item.paperId) || [];
        return (runtime.prepare || planApi.prepareDirectSources)({ ...options, plan, pauseFile, completedPaperIds,
        freshArxivSourceRoot: files.freshArxivFetchedSourcesDir,
        freshArxivFailureHandoffRoot: files.historicalArxivFreshFailureHandoffDir,
        shouldPause: pauseRequested, onProgress: event => { sourceStatus = control.updateSourceStatus({
            sourceRoot: files.freshArxivFetchedSourcesDir, plan, generation: options.arxivGeneration, event });
            console.error(JSON.stringify({
            contract: 'historical-direct-source-progress-v1', version: 1, planSha256: plan.planSha256,
            arxivGeneration: options.arxivGeneration, completedThisRun: ++completedThisRun,
            paperId: event.paperId, outcome: event.status,
            sourceStatusCounts: control.sourceStatusCounts(sourceStatus.status), pauseRequested: pauseRequested() }));
        } }, runtime.dependencies || {});
    };
    let result;
    try { result = options.apply
        ? await require('./analysis-engine.js').withFileLock(lockTarget, invoke, runtime.lockOptions || {}) : await invoke(); }
    finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
    result = { ...result, pauseFile, operationLockTarget: lockTarget, operationLockPath: `${lockTarget}.lock`,
        sourceStatusFile: sourceStatus?.filename || null,
        sourceStatusSha256: sourceStatus?.status.statusSha256 || null,
        sourceStatusCounts: control.sourceStatusCounts(sourceStatus?.status || null) };
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-rewrite-scheduler] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
