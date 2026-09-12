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
function readSafeJson(filename) {
    const named = fs.lstatSync(filename);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || (named.mode & 0o777) !== 0o600) {
        throw new Error(`unsafe conference process state file: ${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd); const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd); const finalNamed = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size
            || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
            || finalNamed.nlink !== 1 || finalNamed.size !== opened.size) {
            throw new Error(`conference process state changed while reading: ${filename}`);
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}
function lockStatus(engine, filename) {
    if (typeof engine?.inspectFileLockState !== 'function') return null;
    const snapshot = engine.inspectFileLockState(filename);
    if (!snapshot?.exists) return null;
    let ownerAlive = null;
    if (Number.isInteger(snapshot.owner?.pid) && snapshot.owner.pid > 0) {
        try { process.kill(snapshot.owner.pid, 0); ownerAlive = true; }
        catch (error) { ownerAlive = error.code === 'ESRCH' ? false : null; }
    }
    return { consistent: snapshot.consistent === true, ownerAlive,
        ownerPid: snapshot.owner?.pid || null, ownerHost: snapshot.owner?.hostname || null };
}
function processStatus(options, runtime = {}) {
    const deps = { ...api.defaultDependencies?.(), ...(runtime.dependencies || {}) };
    const context = (deps.loadAuthority || api.loadAuthority)(options, deps);
    const processId = api.deterministicUuid(api.stableHash(context.authority), 'conference-process-v1');
    const directory = (api.safeProcessDirectory || ((root, id) => path.join(root, id)))
        (deps.files.conferenceProcessDir, processId, false);
    const filename = path.join(directory, 'state.json');
    const state = api.assertState(readSafeJson(filename), {
        authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() });
    if (state.status === 'complete') api.validateCompletionReceipt(state,
        readSafeJson(path.join(directory, 'completion-receipt.json')));
    const counts = Object.values(state.items).reduce((result, item) => {
        result[item.status] = (result[item.status] || 0) + 1; return result;
    }, {});
    const result = { status: state.status, processId, conferenceId: state.authority.conferenceId,
        stateSha256: state.stateSha256, papers: counts, completionReceiptSha256: state.completionReceiptSha256 };
    const operationLock = lockStatus(deps.engine, path.join(directory, '.operation'));
    if (operationLock) result.operationLock = operationLock;
    return result;
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-process.js'); const options = parseArgs(argv);
    const result = options.statusOnly ? processStatus(options, runtime)
        : await (runtime.run || api.runConferenceProcess)(options, runtime.dependencies || {});
    console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[conference-process] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, readSafeJson, processStatus, main };
