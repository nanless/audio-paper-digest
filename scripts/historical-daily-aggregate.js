#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = '--dry-run|--apply --staging-runs UUID[,UUID...] [--date YYYY-MM-DD]';
function parseArgs(argv) {
    if (!['--dry-run', '--apply'].includes(argv[0])) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index]; const value = argv[index + 1];
        if (!['--staging-runs', '--date'].includes(flag) || value === undefined || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    const api = require('./lib/historical-daily-aggregate.js');
    const stagingRunIds = String(values['--staging-runs'] || '').split(',');
    if (!stagingRunIds.length || new Set(stagingRunIds).size !== stagingRunIds.length
        || stagingRunIds.some(value => !api.UUID_RE.test(value))
        || values['--date'] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values['--date'])) throw new Error(`Use ${USAGE}`);
    return { apply: argv[0] === '--apply', stagingRunIds, date: values['--date'] || null };
}

function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-daily-aggregate.js');
    const options = parseArgs(argv); const Config = runtime.config || require('./config.js');
    const api = runtime.api || require('./lib/historical-daily-aggregate.js');
    const inputs = api.loadAggregateInputs({ ...options,
        stagingRoot: Config.FILES.historicalPageStagingDir,
        crosswalkRoot: Config.FILES.pageSourceCrosswalkDir,
        inventoryRoot: Config.FILES.historicalPageInventoryDir,
        analysisRoot: Config.FILES.freshRewriteRunsDir,
        taxonomyRoot: Config.FILES.historicalTaxonomyAssignmentDir,
        taxonomyRegistry: Config.FILES.taxonomyRegistry }, runtime.dependencies || {});
    const aggregates = api.buildDailyAggregates({ inputs, date: options.date });
    const aggregateRunId = api.aggregateRunIdFor(options.stagingRunIds);
    const output = { status: options.apply ? 'written' : 'dry-run', aggregateRunId,
        stagingRunIds: options.stagingRunIds,
        dates: aggregates.map(item => item.date), aggregates };
    if (options.apply) output.outputs = api.writeAggregates({ outputRoot: Config.FILES.historicalDailyAggregateDir,
        aggregateRunId, aggregates });
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[historical-daily-aggregate] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
