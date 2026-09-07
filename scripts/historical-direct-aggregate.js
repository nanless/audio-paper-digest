#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = 'projection --dry-run|--apply --plan-file ABS --inventory-file ABS --output-name NAME | aggregate --dry-run|--apply --plan-file ABS --registry-file ABS --projection-file ABS (--daily YYYY-MM-DD|--conference KEY)';
function parsePairs(argv, fields) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]; const value = argv[index + 1];
        if (!fields.includes(flag) || value === undefined || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    return values;
}
function absolute(value) { return typeof value === 'string' && value.startsWith('/') && !value.includes('\0'); }
function parseArgs(argv) {
    const command = argv[0]; const mode = argv[1];
    if (!['projection', 'aggregate'].includes(command) || !['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    if (command === 'projection') {
        const values = parsePairs(argv.slice(2), ['--plan-file', '--inventory-file', '--output-name']);
        if (!absolute(values['--plan-file']) || !absolute(values['--inventory-file']) || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--output-name'] || '')) throw new Error(`Use ${USAGE}`);
        return { command, apply: mode === '--apply', planFile: values['--plan-file'], inventoryFile: values['--inventory-file'], outputName: values['--output-name'] };
    }
    const values = parsePairs(argv.slice(2), ['--plan-file', '--registry-file', '--projection-file', '--daily', '--conference']);
    if (!absolute(values['--plan-file']) || !absolute(values['--registry-file']) || !absolute(values['--projection-file'])
        || (values['--daily'] === undefined) === (values['--conference'] === undefined)
        || values['--daily'] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values['--daily'])
        || values['--conference'] !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values['--conference'])) throw new Error(`Use ${USAGE}`);
    return { command, apply: mode === '--apply', planFile: values['--plan-file'], registryFile: values['--registry-file'],
        projectionFile: values['--projection-file'], daily: values['--daily'] || null, conference: values['--conference'] || null };
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-aggregate.js');
    const options = parseArgs(argv); const api = runtime.api || require('./lib/historical-direct-aggregate.js');
    const Config = runtime.config || require('./config.js');
    const read = filename => require('./lib/historical-conference-page-projections.js').readStableJson(filename, 'direct aggregate CLI input').value;
    if (options.command === 'projection') {
        const plan = read(options.planFile); const inventory = read(options.inventoryFile);
        const projection = api.buildAggregateProjection({ plan, inventory });
        const output = { status: options.apply ? 'written' : 'dry-run',
            conferenceTaskCoverage: projection.conferenceTaskCoverage, projection };
        if (options.apply) output.output = api.writeAggregateProjection({ root: Config.FILES.historicalDirectAggregateProjectionDir,
            outputName: options.outputName, projection, plan });
        console.log(JSON.stringify(output)); return output;
    }
    const inputs = api.loadDirectAggregateInputs({ planFile: options.planFile, registryFile: options.registryFile,
        projectionFile: options.projectionFile, stagingRoot: Config.FILES.historicalDirectRewriteStagingDir,
        executionRoot: Config.FILES.historicalDirectRewriteExecutionDir });
    const aggregates = api.buildDirectAggregates({ inputs, daily: options.daily, conference: options.conference });
    const aggregateRunId = api.aggregateRunIdFor(aggregates);
    const output = { status: options.apply ? 'written' : 'dry-run', aggregateRunId,
        conferenceTaskCoverage: inputs.projection.conferenceTaskCoverage, aggregates };
    if (options.apply) output.outputs = api.writeDirectAggregates({ outputRoot: Config.FILES.historicalDirectAggregateDir,
        aggregateRunId, aggregates });
    console.log(JSON.stringify(output)); return output;
}
if (require.main === module) {
    try { main(); } catch (error) { console.error(`[historical-direct-aggregate] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
