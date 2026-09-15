#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const queue = require('./lib/conference-queue.js');

const USAGE = '--dry-run|--status|--apply --plan ABSOLUTE.json [--retry-failed]';

function parseArgs(argv) {
    const mode = argv[0];
    if (!['--dry-run', '--status', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 1; index < argv.length;) {
        const flag = argv[index];
        if (flag === '--retry-failed') {
            if (mode !== '--apply' || values.retryFailed) throw new Error(`Use ${USAGE}`);
            values.retryFailed = true; index += 1; continue;
        }
        if (flag !== '--plan' || !argv[index + 1] || values.planFile) throw new Error(`Use ${USAGE}`);
        values.planFile = argv[index + 1]; index += 2;
    }
    if (!path.isAbsolute(values.planFile || '')) throw new Error(`Use ${USAGE}`);
    return { mode: mode.slice(2), apply: mode === '--apply', statusOnly: mode === '--status',
        planFile: path.resolve(values.planFile), retryFailed: Boolean(values.retryFailed) };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-queue.js');
    const options = parseArgs(argv);
    const result = await queue.runConferenceQueue(options, runtime.dependencies || runtime);
    console.log(JSON.stringify(result));
    if (result.status === 'paused' && require.main === module) process.exitCode = 1;
    return result;
}

if (require.main === module) main().catch(error => {
    console.error(`[conference-queue] ${error.message}`); process.exitCode = 1;
});

module.exports = { USAGE, parseArgs, main };
