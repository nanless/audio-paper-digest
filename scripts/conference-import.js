#!/usr/bin/env node
'use strict';

// Explicit offline importer.  It never discovers files, makes network calls,
// invokes an LLM, or uses metadata titles as identities.

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const importer = require('./lib/conference-importer.js');

function parseArgs(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index]; const value = args[index + 1];
        if (!['--manifest', '--source-root', '--cache-root', '--updated-at', '--ledger-output'].includes(flag) || value === undefined) {
            throw new Error('Use --dry-run|--apply --manifest ABS.json --source-root ABS --cache-root ABS --updated-at UTC [--ledger-output ABS.json]');
        }
        if (Object.hasOwn(options, flag)) throw new Error(`Duplicate argument: ${flag}`);
        options[flag] = value;
    }
    return options;
}

function parseCommand(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error('First argument must be --dry-run or --apply');
    const options = parseArgs(rest);
    for (const field of ['--manifest', '--source-root', '--cache-root', '--updated-at']) {
        if (!options[field]) throw new Error(`Missing required argument: ${field}`);
    }
    if (mode === '--dry-run' && options['--ledger-output']) throw new Error('--dry-run must not write --ledger-output');
    if (mode === '--apply' && !options['--ledger-output']) throw new Error('--apply requires --ledger-output ABS.json');
    return { apply: mode === '--apply', manifest: options['--manifest'], sourceRoot: options['--source-root'],
        cacheRoot: options['--cache-root'], updatedAt: options['--updated-at'], ledgerOutput: options['--ledger-output'] };
}

function readManifest(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('manifest must be an absolute JSON filename');
    return ledgerApi.readRegularJson(filename).value;
}

function safeLedgerOutput(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename) !== '.json') {
        throw new Error('ledger output must be an absolute .json filename');
    }
    const directory = path.dirname(path.resolve(filename));
    importer.safeDirectory(directory, 'ledger output directory');
    return path.resolve(filename);
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('conference-import.js');
    const args = parseCommand(argv);
    const result = importer.importConferenceSources({ manifest: readManifest(args.manifest), sourceRoot: args.sourceRoot,
        cacheRoot: args.cacheRoot, updatedAt: args.updatedAt, apply: args.apply });
    let ledgerSha256 = null;
    if (args.apply) ledgerSha256 = ledgerApi.writeLedger(safeLedgerOutput(args.ledgerOutput), result.ledger);
    const output = { status: args.apply ? 'imported' : 'dry-run', mode: result.mode, conference: result.ledger.conference,
        members: result.imported, verified: result.verified, blocked: result.blocked, manifestSha256: result.manifestSha256, ledgerSha256 };
    console.log(JSON.stringify(output));
    return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-import] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, parseCommand, readManifest, safeLedgerOutput, main };
