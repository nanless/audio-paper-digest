#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = 'assign --dry-run|--apply --analysis-run UUID [--paper-id arxiv:YYMM.NNNNN]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseArgs(argv) {
    if (argv[0] !== 'assign' || !['--dry-run', '--apply'].includes(argv[1])) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 2; index < argv.length; index += 2) {
        const flag = argv[index]; const value = argv[index + 1];
        if (!['--analysis-run', '--paper-id'].includes(flag) || value === undefined || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!UUID_RE.test(String(values['--analysis-run'] || ''))
        || values['--paper-id'] !== undefined && !/^arxiv:\d{4}\.\d{4,5}$/.test(values['--paper-id'])) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: argv[1] === '--apply', analysisRunId: values['--analysis-run'],
        paperId: values['--paper-id'] || null };
}

function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-taxonomy-assignment.js');
    const options = parseArgs(argv); const Config = runtime.config || require('./config.js');
    const api = runtime.api || require('./lib/historical-taxonomy-assignment.js');
    const taxonomyApi = runtime.taxonomyApi || require('./lib/paper-taxonomy.js');
    const runHandle = api.loadCompletedHistoricalAnalysisRun({ analysisRoot: Config.FILES.freshRewriteRunsDir,
        runId: options.analysisRunId }, runtime.dependencies);
    const taxonomy = taxonomyApi.loadTaxonomy(Config.FILES.taxonomyRegistry);
    const assignments = api.buildAssignments({ runHandle, taxonomy, paperId: options.paperId });
    const counts = assignments.reduce((value, item) => ({ ...value, [item.status]: (value[item.status] || 0) + 1 }), {});
    const output = { status: options.apply ? 'written' : 'dry-run', analysisRunId: options.analysisRunId,
        mode: options.paperId ? 'single' : 'batch', total: assignments.length,
        assigned: counts.assigned || 0, blocked: counts.blocked || 0,
        registrySha256: taxonomy.registrySha256, assignments };
    if (options.apply) output.outputs = api.writeAssignments({ outputRoot: Config.FILES.historicalTaxonomyAssignmentDir,
        assignments });
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[historical-taxonomy-assignment] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseArgs, main };
