#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const executionCli = require('./conference-execution.js');
const executionApi = require('./lib/conference-execution.js');
const adapter = require('./lib/conference-analysis-adapter.js');

const PREPARE_FLAGS = [...executionCli.AUTHORITY_FLAGS, '--paper-id', '--analysis-run'];
const REPLAY_FLAGS = [...executionCli.AUTHORITY_FLAGS, '--analysis-run', '--concurrency'];
function pairs(rest, allowed) {
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
        if (!allowed.includes(rest[index]) || rest[index + 1] === undefined || Object.hasOwn(values, rest[index])) {
            throw new Error('Invalid conference analysis arguments');
        }
        values[rest[index]] = rest[index + 1];
    }
    return values;
}
function parseArgs(argv) {
    const [action, ...rest] = argv;
    if (action === 'prepare') {
        const values = pairs(rest, PREPARE_FLAGS);
        if (PREPARE_FLAGS.some(flag => !values[flag]) || !executionApi.UUID_RE.test(values['--analysis-run'])
            || !/^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(values['--paper-id'])) {
            throw new Error('prepare requires complete conference plan authority, canonical paperId, and analysis UUID');
        }
        const authority = executionCli.parseArgs(['status', ...executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag, values[flag]]),
            '--execution', values['--analysis-run']]);
        return { action, ...authority, paperId: values['--paper-id'], analysisRunId: values['--analysis-run'] };
    }
    if (['analyze', 'status'].includes(action)) {
        const values = pairs(rest, REPLAY_FLAGS);
        if (executionCli.AUTHORITY_FLAGS.some(flag => !values[flag])
            || !executionApi.UUID_RE.test(String(values['--analysis-run'] || ''))
            || (action === 'status' && values['--concurrency'])
            || (values['--concurrency'] && !/^[1-3]$/.test(values['--concurrency']))) {
            throw new Error(`${action} requires complete live plan authority and --analysis-run UUID`);
        }
        const authority = executionCli.parseArgs(['status', ...executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag, values[flag]]),
            '--execution', values['--analysis-run']]);
        return { action, ...authority, analysisRunId: values['--analysis-run'], concurrency: Number(values['--concurrency'] || 1) };
    }
    throw new Error('Use conference:analyze prepare|analyze|status');
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-analyze.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    for (const key of ['conferenceAnalysisDir', 'conferenceSourceCacheDir']) {
        if (typeof files[key] !== 'string' || !path.isAbsolute(files[key])) throw new Error(`${key} must be configured absolute path`);
    }
    const api = runtime.adapter || adapter; let result;
    if (options.action === 'prepare') {
        const planHandle = (runtime.loadBoundPlan || executionCli.loadBoundPlan)(files, options);
        result = api.prepareConferenceAnalysis({ planHandle, paperId: options.paperId,
            sourceRoot: files.conferenceSourceCacheDir, analysisRoot: files.conferenceAnalysisDir,
            executionId: options.analysisRunId });
    } else if (options.action === 'analyze') {
        const planHandle = (runtime.loadBoundPlan || executionCli.loadBoundPlan)(files, options);
        result = await api.analyzeConference({ analysisRoot: files.conferenceAnalysisDir,
            executionId: options.analysisRunId, concurrency: options.concurrency,
            planHandle, sourceRoot: files.conferenceSourceCacheDir });
    } else {
        const planHandle = (runtime.loadBoundPlan || executionCli.loadBoundPlan)(files, options);
        const loaded = api.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir,
            executionId: options.analysisRunId });
        api.verifyPlanAuthority(loaded, planHandle, files.conferenceSourceCacheDir);
        result = { executionId: loaded.run.executionId, paperId: loaded.run.paperId,
            status: loaded.run.status, capabilities: loaded.run.capabilities,
            productionAuthorized: true, completionPending: loaded.completionPending };
    }
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[conference-analyze] ${error.message}`); process.exitCode = 1; });
module.exports = { PREPARE_FLAGS, REPLAY_FLAGS, parseArgs, main };
