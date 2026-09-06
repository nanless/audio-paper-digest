#!/usr/bin/env node
'use strict';

// Creates a run only through the complete discovery/filter/staging/import
// receipt chain. All CLI file arguments are direct names in configured roots.

const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const discoveryApi = require('./lib/conference-discovery.js');
const filterApi = require('./lib/conference-filter.js');
const stagingApi = require('./lib/conference-staging.js');
const importerApi = require('./lib/conference-importer.js');
const planApi = require('./lib/conference-plan.js');

const FLAGS = ['--catalog', '--report', '--filter', '--import', '--staging-receipt', '--ledger', '--import-receipt', '--plan', '--run'];
const USAGE = '--dry-run|--apply --catalog NAME --report NAME --filter UUID --import NAME --staging-receipt NAME --ledger NAME --import-receipt NAME --plan NAME --run NAME';

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`First argument must be --dry-run or --apply. ${USAGE}`);
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!FLAGS.includes(flag) || value === undefined || Object.hasOwn(options, flag)) throw new Error(USAGE);
        options[flag] = value;
    }
    for (const flag of FLAGS) if (!options[flag]) throw new Error(`Missing required argument: ${flag}`);
    for (const flag of FLAGS.filter(flag => flag !== '--filter')) {
        if (!planApi.SAFE_JSON_NAME.test(options[flag])) throw new Error(`${flag} must be a safe direct JSON filename`);
    }
    if (!filterApi.UUID_RE.test(options['--filter'])) throw new Error('--filter must be a canonical UUID v4');
    return { apply: mode === '--apply', catalogName: options['--catalog'], reportName: options['--report'],
        filterId: options['--filter'], importName: options['--import'], stagingReceiptName: options['--staging-receipt'],
        ledgerName: options['--ledger'], importReceiptName: options['--import-receipt'],
        planName: options['--plan'], runName: options['--run'] };
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFiltersDir',
        'conferenceStagingDir', 'conferenceStagingSourceDir', 'conferenceSourceLedgerDir',
        'conferenceRunsDir', 'taxonomyRegistry']) {
        if (typeof files?.[field] !== 'string') throw new Error(`Configured ${field} is required`);
    }
    return files;
}

function loadImportHandle(files, options) {
    const catalogFile = stagingApi.safeDirectJson(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = stagingApi.safeDirectJson(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = discoveryApi.loadDiscoveryHandle(catalogFile, reportFile);
    const selectionHandle = filterApi.loadSelectionHandle(files.conferenceFiltersDir, options.filterId, discoveryHandle);
    const stagedImportFile = stagingApi.safeDirectJson(files.conferenceStagingDir, options.importName);
    const stagingReceiptFile = stagingApi.safeDirectJson(files.conferenceStagingDir, options.stagingReceiptName);
    const stagingHandle = stagingApi.loadStagingHandle(stagedImportFile, stagingReceiptFile, selectionHandle,
        discoveryHandle, files.conferenceStagingSourceDir);
    const ledgerFile = planApi.safeRuntimeFile(files.conferenceSourceLedgerDir, options.ledgerName);
    const importReceiptFile = planApi.safeRuntimeFile(files.conferenceSourceLedgerDir, options.importReceiptName);
    return importerApi.loadImportHandle(ledgerFile, importReceiptFile, stagingHandle);
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-plan.js');
    const options = parseArgs(argv); const files = requireFiles(dependencies.files || Config.FILES);
    const importHandle = loadImportHandle(files, options);
    const result = planApi.createRunFromImportPlan({ files, importHandle, planName: options.planName, runName: options.runName });
    if (options.apply) planApi.applyRunPlan(result, dependencies.io);
    const output = { status: options.apply ? 'created' : 'dry-run', kind: 'conference-import-bound-run',
        conference: result.run.conferenceId, members: result.run.members.length, shards: result.run.shards.length,
        filterPolicySha256: result.receipt.filter.filterPolicySha256,
        selectionReceiptSha256: result.receipt.filter.selectionReceiptSha256,
        selectedMemberSetSha256: result.receipt.filter.selectedMemberSetSha256,
        importReceiptSha256: result.receipt.import.receiptSha256,
        runName: options.runName, runSha256: result.runSha256,
        planReceiptName: result.receiptName, planReceiptSha256: result.receipt.receiptSha256,
        runIdentitySha256: result.run.identitySha256 };
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-plan] ${error.message}`); process.exitCode = 1; }
}

module.exports = { FLAGS, USAGE, parseArgs, requireFiles, loadImportHandle, main };
