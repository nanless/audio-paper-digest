#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-direct-rewrite-plan.js');

const USAGE = '--dry-run|--apply --catalog ABSOLUTE.json --inventory ABSOLUTE.json --conference-projections ABSOLUTE.json [--output NAME.json]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 6 || rest.length > 8 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--catalog', '--inventory', '--conference-projections', '--output'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (['--catalog', '--inventory', '--conference-projections'].some(flag => !path.isAbsolute(values[flag] || ''))
        || (values['--output'] !== undefined && !api.SAFE_NAME_RE.test(values['--output']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', catalogFile: path.resolve(values['--catalog']),
        inventoryFile: path.resolve(values['--inventory']),
        conferenceProjectionFile: path.resolve(values['--conference-projections']),
        outputName: values['--output'] || 'direct-rewrite-plan-v4.json' };
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-plan.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.historicalDirectRewritePlanDir !== 'string' || !path.isAbsolute(files.historicalDirectRewritePlanDir)
        || typeof files.historicalDirectRewriteUnprojectedReportDir !== 'string'
        || !path.isAbsolute(files.historicalDirectRewriteUnprojectedReportDir)) {
        throw new Error('historicalDirectRewritePlanDir and historicalDirectRewriteUnprojectedReportDir must be configured absolute paths');
    }
    const plan = api.buildFromFiles(options); const queues = api.splitQueues(plan);
    const result = { status: options.apply ? null : 'dry-run', arxivFreshFetch: queues.arxiv.length,
        conferenceLocalPdf: queues.conference.length, canonicalPapers: plan.queue.length,
        projectedPages: plan.projectedPages.length, unprojectedCatalogEntries: plan.unprojectedCatalogEntries.length,
        frozenPaperPages: plan.paperPageCoverage.frozenPaperPages,
        uncoveredFrozenPaperPages: plan.paperPageCoverage.uncoveredFrozenPaperPages,
        paperPageCoverageComplete: plan.paperPageCoverage.coverageComplete,
        uncoveredByIdentityHintStatus: plan.paperPageCoverage.uncoveredByIdentityHintStatus,
        planSha256: plan.planSha256 };
    if (!options.apply) return result;
    const report = api.writeUnprojectedCatalogReport({ root: files.historicalDirectRewriteUnprojectedReportDir, plan });
    const written = api.writePlan({ root: files.historicalDirectRewritePlanDir, outputName: options.outputName, plan });
    return { ...result, status: written.status, filename: written.filename,
        unprojectedReport: { status: report.status, filename: report.filename, reportSha256: report.report.reportSha256 } };
}
if (require.main === module) {
    try { console.log(JSON.stringify(main())); }
    catch (error) { console.error(`[historical-direct-rewrite-plan] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
