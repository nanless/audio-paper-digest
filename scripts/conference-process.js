#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/conference-process.js');

const USAGE = '--dry-run|--apply|--status --catalog NAME.json --report NAME.json --filter UUID [--concurrency 1|2|3]';
function parseArgs(argv) {
    if (argv[0] === '--legacy-disabled') throw new Error('New-conference execution/analyze/postprocess must use conference:new:process');
    const mode = argv[0]; if (!['--dry-run', '--apply', '--status'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index], value = argv[index + 1];
        if (!['--catalog', '--report', '--filter', '--concurrency'].includes(flag) || !value || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--catalog'] || '')
        || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--report'] || '')
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--filter'] || '')
        || (values['--concurrency'] && !/^[1-3]$/.test(values['--concurrency']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', statusOnly: mode === '--status', catalogName: values['--catalog'],
        reportName: values['--report'], filterId: values['--filter'], concurrency: Number(values['--concurrency'] || 1) };
}
function processStatus(options, runtime = {}) {
    const deps = { ...api.defaultDependencies?.(), ...(runtime.dependencies || {}) };
    const context = (deps.loadAuthority || api.loadAuthority)(options, deps);
    const processId = api.deterministicUuid(api.stableHash(context.authority), 'conference-process-v1');
    const filename = path.join(deps.files.conferenceProcessDir, processId, 'state.json');
    const state = api.assertState(JSON.parse(fs.readFileSync(filename)), {
        authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() });
    if (state.status === 'complete') api.validateCompletionReceipt(state,
        JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'completion-receipt.json'))));
    const counts = Object.values(state.items).reduce((result, item) => {
        result[item.status] = (result[item.status] || 0) + 1; return result;
    }, {});
    return { status: state.status, processId, conferenceId: state.authority.conferenceId,
        stateSha256: state.stateSha256, papers: counts, completionReceiptSha256: state.completionReceiptSha256 };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-process.js'); const options = parseArgs(argv);
    const result = options.statusOnly ? processStatus(options, runtime)
        : await (runtime.run || api.runConferenceProcess)(options, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[conference-process] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, processStatus, main };
