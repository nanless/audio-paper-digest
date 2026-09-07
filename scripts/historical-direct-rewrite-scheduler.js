#!/usr/bin/env node
'use strict';

// This entrypoint only prepares source queues.  It never invokes analysis,
// Reader, rendering, crosswalk mutation, blog generation, or publication.
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const planApi = require('./lib/historical-direct-rewrite-plan.js');
const projectionApi = require('./lib/historical-conference-page-projections.js');

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json [--queue all|arxiv|conference] [--generation N] [--arxiv-concurrency 1-8] [--conference-concurrency 1-8]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 2 || rest.length > 10 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--queue', '--generation', '--arxiv-concurrency', '--conference-concurrency'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--plan'] || '') || (values['--queue'] !== undefined && !['all', 'arxiv', 'conference'].includes(values['--queue']))
        || (values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation']))
        || ['--arxiv-concurrency', '--conference-concurrency'].some(flag => values[flag] !== undefined && !/^[1-8]$/.test(values[flag]))) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']), queue: values['--queue'] || 'all',
        arxivGeneration: Number(values['--generation'] || 1), arxivConcurrency: Number(values['--arxiv-concurrency'] || 3),
        conferenceConcurrency: Number(values['--conference-concurrency'] || 5) };
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
    const result = await (runtime.prepare || planApi.prepareDirectSources)({ ...options, plan,
        freshArxivSourceRoot: files.freshArxivFetchedSourcesDir,
        freshArxivFailureHandoffRoot: files.historicalArxivFreshFailureHandoffDir }, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-rewrite-scheduler] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
