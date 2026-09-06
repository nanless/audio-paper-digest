#!/usr/bin/env node
'use strict';

// Creates an isolated executable conference run only from a reviewed runtime
// plan and a verified runtime ledger.  The CLI accepts filenames, never paths.

const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const planApi = require('./lib/conference-plan.js');

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error('First argument must be --dry-run or --apply');
    if (rest.length !== 6 || rest[0] !== '--ledger' || rest[2] !== '--plan' || rest[4] !== '--run') {
        throw new Error('Use --dry-run|--apply --ledger NAME.json --plan NAME.json --run NAME.json');
    }
    const [, ledgerName, , planName, , runName] = rest;
    for (const [label, value] of [['ledger', ledgerName], ['plan', planName], ['run', runName]]) {
        if (!planApi.SAFE_JSON_NAME.test(String(value || ''))) throw new Error(`${label} must be a safe direct JSON filename`);
    }
    return { apply: mode === '--apply', ledgerName, planName, runName };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-plan.js');
    const options = parseArgs(argv);
    const result = planApi.createRunFromPlan({ files: dependencies.files || Config.FILES, ...options });
    if (options.apply) planApi.applyRunPlan(result);
    const output = planApi.report(result, { applied: options.apply });
    console.log(JSON.stringify(output));
    return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-plan] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, main };
