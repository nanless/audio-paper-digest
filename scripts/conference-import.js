#!/usr/bin/env node
'use strict';

// Production conference import accepts only a staged manifest plus its
// authenticated receipt and replays the filter/discovery proof. Low-level
// manifest import remains a library helper for isolated tests, not a CLI route.

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const discoveryApi = require('./lib/conference-discovery.js');
const filterApi = require('./lib/conference-filter.js');
const importerApi = require('./lib/conference-importer.js');
const stagingApi = require('./lib/conference-staging.js');

const USAGE = '--dry-run|--apply --import NAME.json --receipt NAME.json --filter UUID --catalog NAME.json --report NAME.json --updated-at UTC --ledger-output NAME.json';

function parseCommand(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`First argument must be --dry-run or --apply. ${USAGE}`);
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--import', '--receipt', '--filter', '--catalog', '--report', '--updated-at', '--ledger-output'].includes(flag)
            || value === undefined || Object.hasOwn(options, flag)) throw new Error(USAGE);
        options[flag] = value;
    }
    for (const flag of ['--import', '--receipt', '--filter', '--catalog', '--report', '--updated-at', '--ledger-output']) {
        if (!options[flag]) throw new Error(`Missing required argument: ${flag}`);
    }
    for (const flag of ['--import', '--receipt', '--catalog', '--report', '--ledger-output']) {
        if (!stagingApi.SAFE_JSON_NAME.test(options[flag])) throw new Error(`${flag} must be a safe direct JSON filename`);
    }
    if (!filterApi.UUID_RE.test(options['--filter'])) throw new Error('--filter must be a canonical UUID v4');
    const date = new Date(options['--updated-at']);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(options['--updated-at'])
        || Number.isNaN(date.getTime()) || date.toISOString() !== options['--updated-at']) {
        throw new Error('--updated-at must be canonical UTC ISO time');
    }
    return { apply: mode === '--apply', importName: options['--import'], receiptName: options['--receipt'],
        filterId: options['--filter'], catalogName: options['--catalog'], reportName: options['--report'],
        updatedAt: options['--updated-at'], ledgerName: options['--ledger-output'] };
}

function requireFiles(files) {
    for (const field of ['conferenceStagingDir', 'conferenceStagingSourceDir', 'conferenceDiscoveryCatalogDir',
        'conferenceDiscoveryReportDir', 'conferenceFiltersDir', 'conferenceSourceCacheDir', 'conferenceSourceLedgerDir']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) {
            throw new Error(`Configured ${field} must be an absolute directory`);
        }
    }
    return files;
}

function importReceiptNameFor(ledgerName) {
    if (!stagingApi.SAFE_JSON_NAME.test(String(ledgerName || ''))) throw new Error('ledgerName must be a safe direct JSON filename');
    return ledgerName.replace(/\.json$/, '.import-receipt.json');
}

function reserveOutputPair(ledgerDir, ledgerName, ledgerBytes, receipt, receiptName) {
    const ledgerFile = stagingApi.safeDirectJson(ledgerDir, ledgerName, { output: true });
    const receiptFile = stagingApi.safeDirectJson(ledgerDir, receiptName, { output: true });
    if (ledgerFile === receiptFile) throw new Error('ledger and import receipt outputs must differ');
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const specs = [[ledgerFile, ledgerBytes], [receiptFile, receiptBytes]]; const opened = [];
    try {
        for (const [filename] of specs) {
            const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            opened.push({ filename, fd });
        }
        for (let index = 0; index < specs.length; index += 1) {
            fs.writeFileSync(opened[index].fd, specs[index][1]); fs.fsyncSync(opened[index].fd);
        }
    } catch (error) {
        for (const item of opened) {
            try { fs.closeSync(item.fd); } catch {}
            try { fs.unlinkSync(item.filename); } catch {}
        }
        throw new Error(`Could not write immutable conference import bundle: ${error.message}`);
    }
    for (const item of opened) fs.closeSync(item.fd);
    return { ledgerFile, receiptFile };
}

function loadProductionStaging(files, options) {
    const catalogFile = stagingApi.safeDirectJson(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = stagingApi.safeDirectJson(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = discoveryApi.loadDiscoveryHandle(catalogFile, reportFile);
    const selectionHandle = filterApi.loadSelectionHandle(files.conferenceFiltersDir, options.filterId, discoveryHandle);
    const importFile = stagingApi.safeDirectJson(files.conferenceStagingDir, options.importName);
    const receiptFile = stagingApi.safeDirectJson(files.conferenceStagingDir, options.receiptName);
    return stagingApi.loadStagingHandle(importFile, receiptFile, selectionHandle, discoveryHandle,
        files.conferenceStagingSourceDir);
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-import.js');
    const options = parseCommand(argv); const files = requireFiles(dependencies.files || Config.FILES);
    stagingApi.safeDirectory(files.conferenceStagingSourceDir, 'conference staging source directory');
    if (options.apply) {
        stagingApi.safeDirectory(files.conferenceSourceCacheDir, 'conference source cache directory', { create: true });
        stagingApi.safeDirectory(files.conferenceSourceLedgerDir, 'conference ledger directory', { create: true });
    } else {
        importerApi.safeDirectory(files.conferenceSourceCacheDir, 'conference source cache directory', { allowMissing: true });
        importerApi.safeDirectory(files.conferenceSourceLedgerDir, 'conference ledger directory', { allowMissing: true });
    }
    const stagingHandle = loadProductionStaging(files, options);
    const result = importerApi.importConferenceSourcesFromStaging({ stagingHandle,
        sourceRoot: files.conferenceStagingSourceDir, cacheRoot: files.conferenceSourceCacheDir,
        updatedAt: options.updatedAt, apply: options.apply });
    const receiptName = importReceiptNameFor(options.ledgerName);
    const bundle = importerApi.createImportReceipt({ result, ledgerName: options.ledgerName });
    let outputs = { ledgerFile: null, importReceiptFile: null };
    if (options.apply) {
        const written = reserveOutputPair(files.conferenceSourceLedgerDir, options.ledgerName,
            bundle.ledgerBytes, bundle.receipt, receiptName);
        outputs = { ledgerFile: written.ledgerFile, importReceiptFile: written.receiptFile };
    }
    const output = { status: options.apply ? 'imported' : 'dry-run', conference: result.ledger.conference,
        members: result.imported, verified: result.verified, blocked: result.blocked,
        filterPolicySha256: result.stagingBinding.filterPolicySha256,
        selectedMemberSetSha256: result.stagingBinding.selectedMemberSetSha256,
        selectionReceiptSha256: result.stagingBinding.selectionReceiptSha256,
        stagingReceiptSha256: result.stagingBinding.stagingReceiptSha256,
        ledgerSha256: bundle.receipt.ledger.sha256, importReceiptSha256: bundle.receipt.receiptSha256,
        ledgerName: options.ledgerName, importReceiptName: receiptName, ...outputs };
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-import] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseCommand, requireFiles, importReceiptNameFor, reserveOutputPair, loadProductionStaging, main };
