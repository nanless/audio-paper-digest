#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-arxiv-batch.js');
const crosswalkApi = require('./lib/page-source-crosswalk.js');

const USAGE = '--dry-run|--apply --crosswalk UUID --owner OWNER [--limit pilot|N]';
function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--crosswalk', '--owner', '--limit'].includes(flag) || value === undefined || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!crosswalkApi.UUID_RE.test(String(values['--crosswalk'] || ''))
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(values['--owner'] || ''))
        || (values['--limit'] !== undefined && values['--limit'] !== 'pilot'
            && !/^[1-9]\d{0,4}$/.test(values['--limit']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', crosswalkId: values['--crosswalk'], owner: values['--owner'],
        limit: values['--limit'] === undefined ? null : values['--limit'] === 'pilot' ? 'pilot' : Number(values['--limit']) };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-arxiv-batch.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    for (const key of ['pageSourceCrosswalkDir', 'paperSourceAuthorityDir', 'historicalArxivBatchDir']) {
        if (typeof files[key] !== 'string' || !path.isAbsolute(files[key])) throw new Error(`${key} must be a configured absolute path`);
    }
    const result = await (runtime.runBatch || api.runSingleHintBatch)({ ...options,
        crosswalkRoot: files.pageSourceCrosswalkDir, authorityRoot: files.paperSourceAuthorityDir,
        batchRoot: files.historicalArxivBatchDir });
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) main().then(result => { if (result.exitCode) process.exitCode = result.exitCode; })
    .catch(error => { console.error(`[historical-arxiv-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
