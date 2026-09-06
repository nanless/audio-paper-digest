#!/usr/bin/env node
'use strict';

// Safe operator CLI for an already-created conference execution.  It cannot
// import sources, invoke a model, write `data/current`, or publish anything.

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const runApi = require('./lib/conference-run.js');
const executionApi = require('./lib/conference-execution.js');
const { safeRuntimeFile } = require('./conference-tools.js');

function executionRoot(files = Config.FILES) {
    if (!files || typeof files.conferenceExecutionsDir !== 'string' || !path.isAbsolute(files.conferenceExecutionsDir)) {
        throw new Error('conferenceExecutionsDir must be an absolute configured runtime path');
    }
    return files.conferenceExecutionsDir;
}
function parseArgs(args) {
    const [command, ...rest] = args;
    if (command === 'prepare') {
        const allowed = (rest.length === 4 || rest.length === 6) && rest[0] === '--run' && rest[2] === '--ledger'
            && executionApi.SAFE_JSON_NAME.test(String(rest[1] || '')) && executionApi.SAFE_JSON_NAME.test(String(rest[3] || ''));
        if (!allowed || (rest.length === 6 && (rest[4] !== '--execution' || !executionApi.UUID_RE.test(String(rest[5] || ''))))) {
            throw new Error('Use prepare --run NAME.json --ledger NAME.json [--execution UUID]');
        }
        return { command, runName: rest[1], ledgerName: rest[3], executionId: rest[5] };
    }
    if (command === 'status' && rest.length === 2 && rest[0] === '--execution' && executionApi.UUID_RE.test(String(rest[1] || ''))) {
        return { command, executionId: rest[1] };
    }
    if (command === 'transition' && rest.length === 6 && rest[0] === '--execution' && rest[2] === '--patch' && rest[4] === '--owner'
        && executionApi.UUID_RE.test(String(rest[1] || '')) && executionApi.SAFE_JSON_NAME.test(String(rest[3] || ''))
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(rest[5] || ''))) {
        return { command, executionId: rest[1], patchName: rest[3], owner: rest[5] };
    }
    throw new Error('Use prepare --run NAME.json --ledger NAME.json [--execution UUID], status --execution UUID, or transition --execution UUID --patch NAME.json --owner OWNER');
}
function loadBoundRun(files, options) {
    const runFile = safeRuntimeFile(files.conferenceRunsDir, options.runName);
    const ledgerFile = safeRuntimeFile(files.conferenceSourceLedgerDir, options.ledgerName);
    const { value: run } = ledgerApi.readRegularJson(runFile);
    const ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
    return { run: runApi.assertConferenceRunFromVerifiedLedger(run, ledgerHandle), ledgerHandle };
}
function publicStatus(execution) {
    const statusCounts = Object.values(execution.paperStates).reduce((counts, state) => {
        counts[state.status] = (counts[state.status] || 0) + 1; return counts;
    }, {});
    return { kind: execution.contract, executionId: execution.executionId, conferenceId: execution.source.conferenceId,
        ledgerSha256: execution.source.ledgerSha256, runIdentitySha256: execution.source.runIdentitySha256,
        stateSha256: execution.stateSha256, attempts: execution.attempts.length, paperStates: statusCounts };
}
function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-execution.js');
    const options = parseArgs(argv); const files = dependencies.files || Config.FILES;
    const root = dependencies.executionRoot || executionRoot(files);
    let execution;
    if (options.command === 'prepare') execution = executionApi.prepareExecution({ executionRoot: root, executionId: options.executionId, ...loadBoundRun(files, options) });
    else if (options.command === 'status') execution = executionApi.readExecution({ executionRoot: root, executionId: options.executionId });
    else execution = executionApi.transitionExecutionFromPatchFile({ executionRoot: root, executionId: options.executionId, patchName: options.patchName, owner: options.owner });
    const result = { status: 'valid', ...publicStatus(execution) }; console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[conference-execution] ${error.message}`); process.exitCode = 1; } }
module.exports = { parseArgs, executionRoot, loadBoundRun, publicStatus, main };
