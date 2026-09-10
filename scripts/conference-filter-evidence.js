#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const discovery = require('./lib/conference-discovery.js');
const evidence = require('./lib/conference-filter-evidence.js');

const USAGE = 'Use plan|apply|status|verify --catalog NAME.json --report NAME.json --run UUID [--limit 1..500 | --all --expected-total N]';

function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (!['plan', 'apply', 'status', 'verify'].includes(command)) throw new Error(USAGE);
    const values = {};
    for (let index = 0; index < rest.length;) {
        const flag = rest[index];
        if (flag === '--all') {
            if (Object.hasOwn(values, flag)) throw new Error(USAGE);
            values[flag] = true; index += 1; continue;
        }
        const value = rest[index + 1];
        if (!['--catalog', '--report', '--run', '--limit', '--expected-total'].includes(flag)
            || value === undefined || Object.hasOwn(values, flag)) throw new Error(USAGE);
        values[flag] = value; index += 2;
    }
    for (const flag of ['--catalog', '--report', '--run']) if (!values[flag]) throw new Error(`Missing ${flag}`);
    for (const flag of ['--catalog', '--report']) {
        if (!discovery.SAFE_JSON_NAME.test(values[flag])) throw new Error(`${flag} must be a safe JSON filename`);
    }
    if (!evidence.UUID_RE.test(values['--run'])) throw new Error('--run must be a canonical UUID v4');
    const all = values['--all'] === true;
    if (all && (command !== 'apply' || values['--limit'] !== undefined || values['--expected-total'] === undefined)) {
        throw new Error('--all requires apply and --expected-total, and cannot be combined with --limit');
    }
    if (!all && values['--expected-total'] !== undefined) throw new Error('--expected-total requires --all');
    const limit = values['--limit'] === undefined ? 1 : Number(values['--limit']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit must be 1..500');
    const expectedTotal = all ? Number(values['--expected-total']) : null;
    if (all && (!Number.isSafeInteger(expectedTotal) || expectedTotal < 1)) {
        throw new Error('--expected-total must be a positive integer');
    }
    if (command === 'status' && values['--limit'] !== undefined) throw new Error('status does not accept --limit');
    return { command, catalog: values['--catalog'], report: values['--report'], runId: values['--run'],
        limit, all, expectedTotal };
}
function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFilterEvidenceRunsDir']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) throw new Error(`${field} must be absolute`);
    }
    return files;
}
function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-filter-evidence.js');
    const options = parseArgs(argv); const files = requireFiles(dependencies.files || Config.FILES);
    const handle = discovery.loadDiscoveryHandle(
        path.join(files.conferenceDiscoveryCatalogDir, options.catalog),
        path.join(files.conferenceDiscoveryReportDir, options.report)
    );
    let result;
    if (options.command === 'plan') result = evidence.prepareEvidence({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
        runId: options.runId, discoveryHandle: handle, apply: false, limit: options.limit });
    else if (options.command === 'apply') result = evidence.prepareEvidence({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
        runId: options.runId, discoveryHandle: handle, apply: true, limit: options.limit,
        all: options.all, expectedTotal: options.expectedTotal });
    else result = evidence.inspectEvidence({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
        runId: options.runId, discoveryHandle: handle, deep: options.command === 'verify',
        limit: options.command === 'verify' ? options.limit : null });
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-filter-evidence] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseArgs, requireFiles, main };
