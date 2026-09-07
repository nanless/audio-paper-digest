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

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json [--queue all|arxiv|conference] [--generation N] [--concurrency 1-8]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 2 || rest.length > 8 || rest.length % 2) throw new Error(`Use ${USAGE}`);
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--queue', '--generation', '--concurrency'].includes(flag) || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--plan'] || '') || (values['--queue'] !== undefined && !['all', 'arxiv', 'conference'].includes(values['--queue']))
        || (values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation']))
        || (values['--concurrency'] !== undefined && !/^[1-8]$/.test(values['--concurrency']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']), queue: values['--queue'] || 'all',
        arxivGeneration: Number(values['--generation'] || 1), concurrency: Number(values['--concurrency'] || 3) };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-run.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.historicalArxivFreshFailureHandoffDir !== 'string'
        || !path.isAbsolute(files.historicalArxivFreshFailureHandoffDir)) {
        throw new Error('historicalArxivFreshFailureHandoffDir must be a configured absolute path');
    }
    const loaded = projections.readStableJson(options.planFile, 'direct rewrite plan'); const plan = planApi.normalizePlan(loaded.value);
    const result = await (runtime.run || runner.runDirectRewrite)({ ...options, plan,
        registryRoot: files.historicalDirectRewriteRegistryDir,
        executionRoot: files.historicalDirectRewriteExecutionDir,
        stagingRoot: files.historicalDirectRewriteStagingDir,
        freshArxivSourceRoot: files.freshArxivFetchedSourcesDir,
        freshArxivFailureHandoffRoot: files.historicalArxivFreshFailureHandoffDir }, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-rewrite-run] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
