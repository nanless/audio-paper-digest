#!/usr/bin/env node
'use strict';

// This command is intentionally separate from history:direct-scheduler.
// The latter can prepare source bundles without invoking a model; this one is
// the explicit analysis/Reader/staging phase and is never used implicitly.

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const planApi = require('./lib/historical-direct-rewrite-plan.js');
const runner = require('./lib/historical-direct-rewrite-runner.js');
const projections = require('./lib/historical-conference-page-projections.js');

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json [--queue all|arxiv|conference] [--generation N] [--concurrency 1-8] [--paper-ids ID[,ID...]] [--max-papers N|--limit N] [--pause-file ABSOLUTE]';
function parsePaperIds(value) {
    if (value === undefined) return [];
    const paperIds = value.split(',').map(item => item.trim());
    if (!paperIds.length || paperIds.some(item => !item)
        || paperIds.some(item => !/^(?:arxiv:\d{4}\.\d{4,5}|conference:[a-z0-9]+(?:-[a-z0-9]+)*:\d{4}:(?:icassp-arnumber|openreview-forum-id):[^:]+)$/.test(item))
        || new Set(paperIds).size !== paperIds.length) throw new Error(`Use ${USAGE}`);
    return paperIds;
}
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 2 || rest.length > 14 || rest.length % 2) throw new Error(`Use ${USAGE}`);
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--queue', '--generation', '--concurrency', '--paper-ids', '--max-papers', '--limit', '--pause-file'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (values['--max-papers'] !== undefined && values['--limit'] !== undefined) throw new Error(`Use ${USAGE}`);
    const maximum = values['--max-papers'] ?? values['--limit'];
    if (!path.isAbsolute(values['--plan'] || '') || (values['--queue'] !== undefined && !['all', 'arxiv', 'conference'].includes(values['--queue']))
        || (values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation']))
        || (values['--concurrency'] !== undefined && !/^[1-8]$/.test(values['--concurrency']))
        || (maximum !== undefined && !/^[1-9]\d{0,8}$/.test(maximum))
        || (values['--pause-file'] !== undefined && !path.isAbsolute(values['--pause-file']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']), queue: values['--queue'] || 'all',
        arxivGeneration: Number(values['--generation'] || 1), concurrency: Number(values['--concurrency'] || 3),
        paperIds: parsePaperIds(values['--paper-ids']), maxPapers: maximum === undefined ? null : Number(maximum),
        pauseFile: values['--pause-file'] === undefined ? null : path.resolve(values['--pause-file']) };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-run.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.historicalArxivFreshFailureHandoffDir !== 'string'
        || !path.isAbsolute(files.historicalArxivFreshFailureHandoffDir)) {
        throw new Error('historicalArxivFreshFailureHandoffDir must be a configured absolute path');
    }
    const loaded = projections.readStableJson(options.planFile, 'direct rewrite plan'); const plan = planApi.normalizePlan(loaded.value);
    let stopSignal = null;
    const onSignal = signal => {
        if (stopSignal === null) console.error(`[historical-direct-rewrite-run] received ${signal}; finishing active papers before pausing`);
        stopSignal = signal;
    };
    const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => onSignal(signal)]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    try {
        const result = await (runtime.run || runner.runDirectRewrite)({ ...options, plan,
            registryRoot: files.historicalDirectRewriteRegistryDir,
            executionRoot: files.historicalDirectRewriteExecutionDir,
            stagingRoot: files.historicalDirectRewriteStagingDir,
            freshArxivSourceRoot: files.freshArxivFetchedSourcesDir,
            freshArxivFailureHandoffRoot: files.historicalArxivFreshFailureHandoffDir }, {
            ...(runtime.dependencies || {}),
            shouldPause: async () => stopSignal !== null || Boolean(await runtime.dependencies?.shouldPause?.()),
            onProgress: runtime.dependencies?.onProgress || (event => console.error(JSON.stringify(event)))
        });
        console.log(JSON.stringify(result)); return result;
    } finally {
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-rewrite-run] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parsePaperIds, parseArgs, main };
