#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const projectionIo = require('./lib/historical-conference-page-projections.js');
const planApi = require('./lib/historical-direct-rewrite-plan.js');
const control = require('./lib/historical-direct-control.js');

const USAGE = 'status --plan ABSOLUTE.json [--generation N] [--watch-seconds N] | pause|resume --plan ABSOLUTE.json --phase source|analysis [--generation N]';
function parseArgs(argv) {
    const [action, ...rest] = argv; const values = {};
    if (!['status', 'pause', 'resume'].includes(action) || rest.length < 2 || rest.length > 6 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--generation', '--watch-seconds', '--phase'].includes(flag) || !value || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--plan'] || '') || values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation'])
        || values['--watch-seconds'] !== undefined && !/^[1-9]\d{0,5}$/.test(values['--watch-seconds'])
        || action !== 'status' && values['--watch-seconds'] !== undefined
        || action === 'status' && values['--phase'] !== undefined
        || action !== 'status' && !['source', 'analysis'].includes(values['--phase'])) throw new Error(`Use ${USAGE}`);
    return { action, planFile: path.resolve(values['--plan']), generation: Number(values['--generation'] || 1),
        watchSeconds: values['--watch-seconds'] === undefined ? null : Number(values['--watch-seconds']),
        phase: values['--phase'] || null };
}
function loadPlan(filename) {
    return planApi.normalizePlan(projectionIo.readStableJson(filename, 'direct rewrite control plan').value);
}
function roots(runtime = {}) {
    const files = runtime.files || Config.FILES;
    return { registryRoot: files.historicalDirectRewriteRegistryDir,
        sourceRoot: files.freshArxivFetchedSourcesDir,
        aggregateRoot: files.historicalDirectAggregateDir,
        aggregateProjectionRoot: files.historicalDirectAggregateProjectionDir };
}
function snapshot(options, runtime = {}) {
    return (runtime.buildStatus || control.buildStatus)({ planFile: options.planFile, generation: options.generation,
        ...roots(runtime), observedAt: (runtime.now || (() => new Date().toISOString()))() });
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-control.js'); const options = parseArgs(argv); const configured = roots(runtime);
    if (options.action === 'pause') {
        const result = (runtime.pause || control.writePauseRequest)({ ...configured, plan: loadPlan(options.planFile),
            phase: options.phase, generation: options.generation, requestedAt: (runtime.now || (() => new Date().toISOString()))() });
        console.log(JSON.stringify(result)); return result;
    }
    if (options.action === 'resume') {
        const result = (runtime.resume || control.resumeRewrite)({ ...configured, plan: loadPlan(options.planFile),
            phase: options.phase, generation: options.generation });
        console.log(JSON.stringify(result)); return result;
    }
    if (options.watchSeconds === null) {
        const result = snapshot(options, runtime); console.log(JSON.stringify(result)); return result;
    }
    let stopped = false; const stop = () => { stopped = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        let last;
        while (!stopped) {
            last = snapshot(options, runtime); console.log(JSON.stringify(last));
            if (last.completion.complete) break;
            await delay(options.watchSeconds * 1000);
        }
        return last;
    } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-control] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, roots, snapshot, main };
