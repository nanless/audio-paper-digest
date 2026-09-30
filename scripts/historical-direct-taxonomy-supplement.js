#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const { requireWorkspaceRole } = require('./workspace-role.js');
const USAGE = '--plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID [--limit N]';
function parseArgs(argv) {
    const values = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!['--plan', '--registry', '--blog', '--snapshot', '--run-id', '--limit'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(values, argv[i])) throw new Error(USAGE);
        values[argv[i]] = argv[i + 1];
    }
    for (const flag of ['--plan', '--registry', '--blog', '--snapshot']) if (!path.isAbsolute(values[flag] || '') || values[flag].includes('\0')) throw new Error(USAGE);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--run-id'] || '') || values['--limit'] && !/^[1-9]\d*$/.test(values['--limit'])) throw new Error(USAGE);
    return { planFile: values['--plan'], registryFile: values['--registry'], blogRoot: values['--blog'], registrySnapshot: values['--snapshot'], runId: values['--run-id'], limit: values['--limit'] ? Number(values['--limit']) : null };
}
async function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('historical-direct-taxonomy-supplement'); requireWorkspaceRole('history');
    const options = parseArgs(argv), config = require('./config.js'), api = require('./lib/historical-direct-taxonomy-supplement.js');
    const outputRoot = config.FILES.historicalDirectTaxonomySupplementDir;
    const { supplement, report } = await api.buildSupplement({ ...options, generation: 1,
        stagingRoot: config.FILES.historicalDirectRewriteStagingDir, executionRoot: config.FILES.historicalDirectRewriteExecutionDir,
        freshArxivSourceRoot: config.FILES.freshArxivFetchedSourcesDir, publicationMetadataRoot: config.FILES.historicalArxivPublicationMetadataDir,
        onProgress: progress => console.log(JSON.stringify({ progress })) });
    const directory = path.join(outputRoot, options.runId);
    const outputs = [api.writeImmutable(directory, 'taxonomy-history.json', supplement), api.writeImmutable(directory, 'report.json', report)];
    console.log(JSON.stringify({ attempted: report.attempted, paperCount: report.paperCount, pageCount: report.pageCount, failureCount: report.failures.length, outputs }));
    return { supplement, report, outputs };
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
