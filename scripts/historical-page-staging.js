#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = '--dry-run|--apply --crosswalk UUID --analysis-run UUID [--run-id UUID] [--limit pilot|N]';
function parseArgs(argv) {
    const mode = argv[0]; if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let i = 1; i < argv.length; i += 2) {
        if (!['--crosswalk', '--run-id', '--analysis-run', '--limit'].includes(argv[i]) || argv[i + 1] === undefined
            || Object.hasOwn(values, argv[i])) throw new Error(`Use ${USAGE}`);
        values[argv[i]] = argv[i + 1];
    }
    const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value || '');
    if (!uuid(values['--crosswalk']) || mode === '--apply' && !uuid(values['--run-id'])
        || mode === '--dry-run' && values['--run-id'] !== undefined
        || !uuid(values['--analysis-run'])
        || values['--limit'] !== undefined && values['--limit'] !== 'pilot' && !/^[1-9]\d{0,5}$/.test(values['--limit'])) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', crosswalkId: values['--crosswalk'], stagingRunId: values['--run-id'] || null,
        analysisRunId: values['--analysis-run'] || null,
        limit: values['--limit'] === undefined ? null : values['--limit'] === 'pilot' ? 'pilot' : Number(values['--limit']) };
}

function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-page-staging.js'); const Config = runtime.config || require('./config.js');
    const options = parseArgs(argv); const result = (runtime.stage || require('./lib/historical-page-staging.js').stageHistoricalPages)({
        ...options, crosswalkRoot: Config.FILES.pageSourceCrosswalkDir,
        analysisRoot: Config.FILES.freshRewriteRunsDir,
        taxonomyRoot: Config.FILES.historicalTaxonomyAssignmentDir,
        taxonomyRegistry: Config.FILES.taxonomyRegistry,
        stagingRoot: Config.FILES.historicalPageStagingDir }, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) { try { main(); } catch (error) { console.error(`[historical-page-staging] ${error.message}`); process.exitCode = 1; } }
module.exports = { USAGE, parseArgs, main };
