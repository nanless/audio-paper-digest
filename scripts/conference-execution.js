#!/usr/bin/env node
'use strict';

// Safe operator CLI for a conference execution. Every command replays the
// complete upstream plan authority; it cannot import sources, invoke a model,
// write `data/current`, or publish anything.

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const runApi = require('./lib/conference-run.js');
const executionApi = require('./lib/conference-execution.js');
const planApi = require('./lib/conference-plan.js');
const planCli = require('./conference-plan.js');
const { safeRuntimeFile } = require('./conference-tools.js');

function executionRoot(files = Config.FILES) {
    if (!files || typeof files.conferenceExecutionsDir !== 'string' || !path.isAbsolute(files.conferenceExecutionsDir)) {
        throw new Error('conferenceExecutionsDir must be an absolute configured runtime path');
    }
    return files.conferenceExecutionsDir;
}
const AUTHORITY_FLAGS = ['--run', '--plan-receipt', '--plan', '--ledger', '--import-receipt', '--import',
    '--staging-receipt', '--filter', '--catalog', '--report'];
function parsePairs(rest, allowed) {
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!allowed.includes(flag) || value === undefined || Object.hasOwn(values, flag)) {
            throw new Error('Every conference execution command requires the complete plan/import/staging/filter/discovery authority chain');
        }
        values[flag] = value;
    }
    return values;
}
function validatedAuthorityOptions(values) {
    if (AUTHORITY_FLAGS.some(flag => !values[flag])) {
        throw new Error('Every conference execution command requires the complete plan/import/staging/filter/discovery authority chain');
    }
    for (const flag of AUTHORITY_FLAGS.filter(flag => flag !== '--filter')) {
        if (!executionApi.SAFE_JSON_NAME.test(String(values[flag] || ''))) throw new Error(`${flag} must be a safe direct JSON filename`);
    }
    if (!executionApi.UUID_RE.test(String(values['--filter'] || ''))) throw new Error('--filter must be a canonical UUID v4');
    return { runName: values['--run'], planReceiptName: values['--plan-receipt'], planName: values['--plan'],
        ledgerName: values['--ledger'], importReceiptName: values['--import-receipt'], importName: values['--import'],
        stagingReceiptName: values['--staging-receipt'], filterId: values['--filter'],
        catalogName: values['--catalog'], reportName: values['--report'] };
}
function parseArgs(args) {
    const [command, ...rest] = args;
    if (command === 'prepare') {
        const values = parsePairs(rest, [...AUTHORITY_FLAGS, '--execution']);
        if (values['--execution'] && !executionApi.UUID_RE.test(values['--execution'])) throw new Error('--execution must be a canonical UUID v4');
        return { command, ...validatedAuthorityOptions(values), executionId: values['--execution'] };
    }
    if (command === 'status') {
        const values = parsePairs(rest, [...AUTHORITY_FLAGS, '--execution']);
        if (!executionApi.UUID_RE.test(String(values['--execution'] || ''))) throw new Error('--execution must be a canonical UUID v4');
        return { command, ...validatedAuthorityOptions(values), executionId: values['--execution'] };
    }
    if (command === 'transition') {
        const values = parsePairs(rest, [...AUTHORITY_FLAGS, '--execution', '--patch', '--owner']);
        if (!executionApi.UUID_RE.test(String(values['--execution'] || ''))
            || !executionApi.SAFE_JSON_NAME.test(String(values['--patch'] || ''))
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(values['--owner'] || ''))) {
            throw new Error('transition requires canonical execution UUID, direct patch JSON, and owner');
        }
        return { command, ...validatedAuthorityOptions(values), executionId: values['--execution'],
            patchName: values['--patch'], owner: values['--owner'] };
    }
    throw new Error('Use prepare, status, or transition with the complete authority chain');
}
function loadBoundPlan(files, options) {
    const importHandle = planCli.loadImportHandle(files, options);
    const runFile = safeRuntimeFile(files.conferenceRunsDir, options.runName);
    const receiptFile = safeRuntimeFile(files.conferenceRunsDir, options.planReceiptName);
    const planFile = safeRuntimeFile(files.conferenceSourceLedgerDir, options.planName);
    return planApi.loadPlanHandle(runFile, receiptFile, planFile, importHandle, files.taxonomyRegistry);
}
function publicStatus(execution) {
    const statusCounts = Object.values(execution.paperStates).reduce((counts, state) => {
        counts[state.status] = (counts[state.status] || 0) + 1; return counts;
    }, {});
    return { kind: execution.contract, executionId: execution.executionId, conferenceId: execution.source.conferenceId,
        ledgerSha256: execution.source.ledgerSha256, runIdentitySha256: execution.source.runIdentitySha256,
        planReceiptSha256: execution.source.planReceiptSha256,
        importReceiptSha256: execution.source.importReceiptSha256,
        filterPolicySha256: execution.source.filterPolicySha256,
        selectionReceiptSha256: execution.source.selectionReceiptSha256,
        selectedMemberSetSha256: execution.source.selectedMemberSetSha256,
        stateSha256: execution.stateSha256, attempts: execution.attempts.length, paperStates: statusCounts };
}
function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-execution.js');
    const options = parseArgs(argv); const files = dependencies.files || Config.FILES;
    const root = dependencies.executionRoot || executionRoot(files);
    let execution;
    const planHandle = loadBoundPlan(files, options);
    if (options.command === 'prepare') execution = executionApi.prepareExecutionFromPlan({ executionRoot: root,
        executionId: options.executionId, planHandle });
    else if (options.command === 'status') execution = executionApi.readExecution({ executionRoot: root,
        executionId: options.executionId, planHandle });
    else execution = executionApi.transitionExecutionFromPatchFile({ executionRoot: root,
        executionId: options.executionId, patchName: options.patchName, owner: options.owner, planHandle });
    const result = { status: 'valid', ...publicStatus(execution) }; console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[conference-execution] ${error.message}`); process.exitCode = 1; } }
module.exports = { AUTHORITY_FLAGS, parseArgs, executionRoot, loadBoundPlan, publicStatus, main };
