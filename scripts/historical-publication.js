#!/usr/bin/env node
'use strict';
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/historical-publication.js');

const USAGE = 'plan --dry-run|--apply --plan-id UUID --page-staging-runs UUID[,UUID...] --daily-aggregates UUID@DATE[,UUID@DATE...] [--conference-refs VALUE] | generate --dry-run|--apply --plan-id UUID --batch-id daily-YYYY-MM-DD';
function pairs(argv, start, allowed) {
    const values = {};
    for (let i = start; i < argv.length; i += 2) {
        if (!allowed.includes(argv[i]) || argv[i + 1] === undefined || Object.hasOwn(values, argv[i])) throw new Error(`Use ${USAGE}`);
        values[argv[i]] = argv[i + 1];
    }
    return values;
}
function parseArgs(argv) {
    const [action, mode] = argv;
    if (!['plan', 'generate'].includes(action) || !['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = pairs(argv, 2, action === 'plan'
        ? ['--plan-id', '--page-staging-runs', '--daily-aggregates', '--conference-refs']
        : ['--plan-id', '--batch-id']);
    if (!api.UUID_RE.test(values['--plan-id'] || '')) throw new Error(`Use ${USAGE}`);
    if (action === 'generate') {
        if (!/^daily-\d{4}-\d{2}-\d{2}$/.test(values['--batch-id'] || '')) throw new Error(`Use ${USAGE}`);
        return { action, apply: mode === '--apply', planId: values['--plan-id'], batchId: values['--batch-id'] };
    }
    const pageStagingRunIds = String(values['--page-staging-runs'] || '').split(',');
    const dailyAggregates = String(values['--daily-aggregates'] || '').split(',').map(item => {
        const match = item.match(/^([a-f0-9-]{36})@(\d{4}-\d{2}-\d{2})$/i); return match ? { aggregateRunId: match[1], date: match[2] } : null;
    });
    if (!pageStagingRunIds.length || pageStagingRunIds.some(id => !api.UUID_RE.test(id))
        || dailyAggregates.some(item => !item)) throw new Error(`Use ${USAGE}`);
    return { action, apply: mode === '--apply', planId: values['--plan-id'], pageStagingRunIds,
        dailyAggregates, conferenceRefs: values['--conference-refs'] ? [values['--conference-refs']] : [] };
}

function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-publication.js'); const Config = runtime.config || require('./config.js');
    const options = parseArgs(argv); const roots = {
        blogRepo: Config.PUBLISH_CONFIG.blogRepo,
        stagingRoot: Config.FILES.historicalPageStagingDir,
        aggregateRoot: Config.FILES.historicalDailyAggregateDir,
        crosswalkRoot: Config.FILES.pageSourceCrosswalkDir,
        inventoryRoot: Config.FILES.historicalPageInventoryDir,
        analysisRoot: Config.FILES.freshRewriteRunsDir,
        taxonomyRoot: Config.FILES.historicalTaxonomyAssignmentDir,
        taxonomyRegistry: Config.FILES.taxonomyRegistry };
    const publicationRoot = Config.FILES.historicalPublicationDir;
    if (options.action === 'plan') {
        let plan = (runtime.buildPlan || api.buildPlan)({ ...options, ...roots }, runtime.dependencies || {});
        if (options.apply) {
            const written = (runtime.writePlan || api.writePlan)({ outputRoot: publicationRoot, plan });
            if (written?.plan) plan = written.plan;
        }
        const result = { status: options.apply ? 'planned' : 'dry-run', planId: plan.planId,
            planSha256: plan.planSha256, batches: plan.batches, artifactCount: plan.artifacts.length };
        console.log(JSON.stringify(result)); return result;
    }
    const result = (runtime.generateBundle || api.generateBundle)({ outputRoot: publicationRoot,
        planId: options.planId, batchId: options.batchId, ...roots, apply: options.apply }, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[historical-publication] ${error.message}`); process.exitCode = 1; } }
module.exports = { USAGE, parseArgs, main };
