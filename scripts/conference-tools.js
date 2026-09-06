#!/usr/bin/env node
'use strict';

// Read-only maintenance commands for private conference source state. They
// intentionally accept only a direct JSON filename below configured runtime
// roots; importing a PDF or starting analysis is a separate explicit action.

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const runApi = require('./lib/conference-run.js');

const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;

function parseArgs(args) {
    const [command, ...rest] = args;
    if (!['validate-ledger', 'verify-ledger', 'validate-run'].includes(command)) {
        throw new Error('Use validate-ledger|verify-ledger --ledger NAME.json, or validate-run --run NAME.json --ledger NAME.json');
    }
    if (command !== 'validate-run') {
        if (rest.length !== 2 || rest[0] !== '--ledger' || !SAFE_JSON_NAME.test(String(rest[1] || ''))) {
            throw new Error('Use validate-ledger|verify-ledger --ledger NAME.json');
        }
        return { command, ledgerName: rest[1] };
    }
    if (rest.length !== 4 || rest[0] !== '--run' || rest[2] !== '--ledger'
        || !SAFE_JSON_NAME.test(String(rest[1] || '')) || !SAFE_JSON_NAME.test(String(rest[3] || ''))) {
        throw new Error('Use validate-run --run NAME.json --ledger NAME.json');
    }
    return { command, runName: rest[1], ledgerName: rest[3] };
}

function safeRuntimeFile(root, name) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !SAFE_JSON_NAME.test(String(name || ''))) {
        throw new Error('Conference runtime file selection is invalid');
    }
    const safeRoot = path.resolve(root);
    const stat = fs.lstatSync(safeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(safeRoot) !== safeRoot) {
        throw new Error(`Unsafe conference runtime directory: ${safeRoot}`);
    }
    const target = path.resolve(safeRoot, name);
    if (path.dirname(target) !== safeRoot) throw new Error('Conference runtime file escapes its configured directory');
    return target;
}

function validateLedgerFile({ ledgerDirectory, sourceRoot, ledgerName, verifyFiles = false }) {
    const filename = safeRuntimeFile(ledgerDirectory, ledgerName);
    const ledgerHandle = ledgerApi.loadLedgerHandle(filename);
    const { ledger, ledgerSha256 } = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
    if (verifyFiles) ledgerApi.verifyMemberFiles(ledger, sourceRoot);
    return {
        kind: 'conference-source-ledger', conference: ledger.conference.id, year: ledger.conference.year,
        members: ledger.members.length, ledgerSha256, filesVerified: verifyFiles
    };
}

function validateRunFile({ runsDirectory, runName, ledgerDirectory, ledgerName }) {
    const filename = safeRuntimeFile(runsDirectory, runName);
    const { value, sha256 } = ledgerApi.readRegularJson(filename);
    const ledgerFile = safeRuntimeFile(ledgerDirectory, ledgerName);
    const ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
    const { ledgerSha256 } = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
    const run = runApi.assertConferenceRunFromVerifiedLedger(value, ledgerHandle);
    return {
        kind: 'conference-run', conference: run.conferenceId, members: run.members.length,
        ledgerSha256, membershipSha256: run.membershipSha256,
        identitySha256: run.identitySha256, stateSha256: run.stateSha256, fileSha256: sha256
    };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-tools.js');
    const options = parseArgs(argv);
    const files = dependencies.files || Config.FILES;
    const result = options.command === 'validate-run'
        ? validateRunFile({ runsDirectory: files.conferenceRunsDir, runName: options.runName,
            ledgerDirectory: files.conferenceSourceLedgerDir, ledgerName: options.ledgerName })
        : validateLedgerFile({ ledgerDirectory: files.conferenceSourceLedgerDir,
            sourceRoot: files.conferenceSourceCacheDir, ledgerName: options.ledgerName,
            verifyFiles: options.command === 'verify-ledger' });
    console.log(JSON.stringify({ status: 'valid', ...result }));
    return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference] ${error.message}`); process.exitCode = 1; }
}

module.exports = { SAFE_JSON_NAME, parseArgs, safeRuntimeFile, validateLedgerFile, validateRunFile, main };
