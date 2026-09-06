#!/usr/bin/env node
'use strict';

// Creates an immutable, filter-bound import manifest from a reviewed local
// extraction specification.  It does not import/copy files, use the network,
// or invoke an LLM.

const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const discoveryApi = require('./lib/conference-discovery.js');
const filterApi = require('./lib/conference-filter.js');
const stagingApi = require('./lib/conference-staging.js');

const USAGE = '--dry-run|--apply --catalog NAME.json --report NAME.json --filter UUID --extraction NAME.json --import-output NAME.json --receipt-output NAME.json';

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`First argument must be --dry-run or --apply. ${USAGE}`);
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--catalog', '--report', '--filter', '--extraction', '--import-output', '--receipt-output'].includes(flag)
            || value === undefined || Object.hasOwn(options, flag)) throw new Error(USAGE);
        options[flag] = value;
    }
    for (const flag of ['--catalog', '--report', '--filter', '--extraction', '--import-output', '--receipt-output']) {
        if (!options[flag]) throw new Error(`Missing required argument: ${flag}`);
    }
    for (const flag of ['--catalog', '--report', '--extraction', '--import-output', '--receipt-output']) {
        if (!stagingApi.SAFE_JSON_NAME.test(options[flag])) throw new Error(`${flag} must be a safe direct JSON filename`);
    }
    if (!filterApi.UUID_RE.test(options['--filter'])) throw new Error('--filter must be a canonical UUID v4');
    if (options['--import-output'] === options['--receipt-output']) throw new Error('output filenames must differ');
    return { apply: mode === '--apply', catalogName: options['--catalog'], reportName: options['--report'],
        filterId: options['--filter'], extractionName: options['--extraction'],
        importManifestName: options['--import-output'], receiptName: options['--receipt-output'] };
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFiltersDir',
        'conferenceStagingSpecsDir', 'conferenceStagingSourceDir', 'conferenceStagingDir']) {
        if (typeof files?.[field] !== 'string') throw new Error(`Configured ${field} is required`);
    }
    return files;
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-staging.js');
    const options = parseArgs(argv); const files = requireFiles(dependencies.files || Config.FILES);
    const catalogFile = stagingApi.safeDirectJson(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = stagingApi.safeDirectJson(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = discoveryApi.loadDiscoveryHandle(catalogFile, reportFile);
    const selectionHandle = filterApi.loadSelectionHandle(files.conferenceFiltersDir, options.filterId, discoveryHandle);
    const extractionFile = stagingApi.safeDirectJson(files.conferenceStagingSpecsDir, options.extractionName);
    const extractionLoaded = ledgerApi.readRegularJson(extractionFile);
    const staged = stagingApi.bindInputs({ selectionHandle, discoveryHandle,
        extractionManifest: extractionLoaded.value, extractionFileSha256: extractionLoaded.sha256,
        extractionSourceRoot: files.conferenceStagingSourceDir,
        importManifestName: options.importManifestName });
    let outputs = { importFile: null, receiptFile: null };
    if (options.apply) outputs = stagingApi.writeStagingBundle({ stagingRoot: files.conferenceStagingDir,
        importManifestName: options.importManifestName, receiptName: options.receiptName, staged });
    const result = { status: options.apply ? 'written' : 'dry-run', conferenceId: staged.selection.conferenceId,
        filterId: staged.selection.filterId, filterPolicySha256: staged.selection.filterPolicySha256,
        selectedMemberSetSha256: staged.selection.selectedMemberSetSha256,
        selectionReceiptSha256: staged.selection.selectionReceiptSha256,
        members: staged.importManifest.members.length, importManifestSha256: staged.receipt.importManifest.sha256,
        receiptSha256: staged.receipt.receiptSha256, ...outputs };
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-staging] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseArgs, requireFiles, main };
