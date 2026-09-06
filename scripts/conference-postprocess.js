#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const executionCli = require('./conference-execution.js');
const executionApi = require('./lib/conference-execution.js');
const api = require('./lib/conference-postprocess.js');

const RUN_FLAGS = [...executionCli.AUTHORITY_FLAGS, '--analysis-run'];
const BATCH_FLAGS = [...executionCli.AUTHORITY_FLAGS, '--analysis-runs'];
const USAGE = 'paper|aggregate --dry-run|--apply <complete conference plan authority flags> --analysis-run UUID | --analysis-runs UUID[,UUID...]';
function pairs(argv, allowed) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        if (!allowed.includes(argv[index]) || argv[index + 1] === undefined || Object.hasOwn(values, argv[index])) throw new Error(`Use ${USAGE}`);
        values[argv[index]] = argv[index + 1];
    }
    return values;
}
function parseArgs(argv) {
    const [action, mode, ...rest] = argv;
    if (!['paper', 'aggregate'].includes(action) || !['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = pairs(rest, action === 'paper' ? RUN_FLAGS : BATCH_FLAGS);
    if (executionCli.AUTHORITY_FLAGS.some(flag => !values[flag])) throw new Error(`Use ${USAGE}`);
    const authority = executionCli.parseArgs(['status', ...executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag, values[flag]]),
        '--execution', action === 'paper' ? values['--analysis-run'] : String(values['--analysis-runs'] || '').split(',')[0]]);
    if (action === 'paper') {
        if (!executionApi.UUID_RE.test(values['--analysis-run'] || '')) throw new Error(`Use ${USAGE}`);
        return { action, apply: mode === '--apply', ...authority, executionId: values['--analysis-run'] };
    }
    const executionIds = String(values['--analysis-runs'] || '').split(',');
    if (!executionIds.length || new Set(executionIds).size !== executionIds.length
        || executionIds.some(id => !executionApi.UUID_RE.test(id))) throw new Error(`Use ${USAGE}`);
    return { action, apply: mode === '--apply', ...authority, executionIds };
}
function configured(files) {
    const result = { analysisRoot: files.conferenceAnalysisDir, sourceRoot: files.conferenceSourceCacheDir,
        taxonomyFile: files.taxonomyRegistry, stagingRoot: files.conferencePageStagingDir,
        aggregateRoot: files.conferenceAggregateDir };
    for (const [key, value] of Object.entries(result)) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} must be a configured absolute path`);
    return result;
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-postprocess.js'); const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    const planHandle = (runtime.loadBoundPlan || executionCli.loadBoundPlan)(files, options); const roots = configured(files);
    const result = options.action === 'paper'
        ? (runtime.stagePaper || api.stagePaper)({ ...roots, executionId: options.executionId, planHandle, apply: options.apply }, runtime.dependencies || {})
        : (runtime.aggregateConference || api.aggregateConference)({ ...roots, executionIds: options.executionIds, planHandle, apply: options.apply }, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[conference-postprocess] ${error.message}`); process.exitCode = 1; } }
module.exports = { RUN_FLAGS, BATCH_FLAGS, USAGE, parseArgs, configured, main };
