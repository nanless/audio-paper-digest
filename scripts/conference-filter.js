#!/usr/bin/env node
'use strict';

// Controlled local CLI for preparing, inspecting, and applying already-made
// conference filter decisions. No command invokes a model or network service.

const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const filterApi = require('./lib/conference-filter.js');
const ledgerApi = require('./lib/conference-source-ledger.js');
const discoveryApi = require('./lib/conference-discovery.js');
const evidenceApi = require('./lib/conference-filter-evidence.js');

function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (command === 'spec') {
        const valid = rest.length === 8 && rest[0] === '--catalog' && rest[2] === '--report'
            && rest[4] === '--evidence-run' && rest[6] === '--output'
            && [rest[1], rest[3], rest[7]].every(value => filterApi.SAFE_JSON_NAME.test(String(value || '')))
            && evidenceApi.UUID_RE.test(String(rest[5] || ''));
        if (!valid) throw new Error('Use spec --catalog NAME.json --report NAME.json --evidence-run UUID --output NAME.json');
        return { command, catalogName: rest[1], reportName: rest[3], evidenceRunId: rest[5], specName: rest[7] };
    }
    if (command === 'prepare') {
        const valid = (rest.length === 8 || rest.length === 10) && rest[0] === '--catalog' && rest[2] === '--report'
            && rest[4] === '--evidence-run' && rest[6] === '--spec'
            && [rest[1], rest[3], rest[7]].every(value => filterApi.SAFE_JSON_NAME.test(String(value || '')))
            && evidenceApi.UUID_RE.test(String(rest[5] || ''))
            && (rest.length === 8 || (rest[8] === '--filter' && filterApi.UUID_RE.test(String(rest[9] || ''))));
        if (!valid) throw new Error('Use prepare --catalog NAME.json --report NAME.json --evidence-run UUID --spec NAME.json [--filter UUID]');
        return { command, catalogName: rest[1], reportName: rest[3], evidenceRunId: rest[5],
            specName: rest[7], filterId: rest[9] };
    }
    if (command === 'status' && rest.length === 2 && rest[0] === '--filter' && filterApi.UUID_RE.test(String(rest[1] || ''))) {
        return { command, filterId: rest[1] };
    }
    if (command === 'apply' && rest.length === 6 && rest[0] === '--filter' && rest[2] === '--decision' && rest[4] === '--owner'
        && filterApi.UUID_RE.test(String(rest[1] || '')) && filterApi.SAFE_JSON_NAME.test(String(rest[3] || ''))
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(rest[5] || ''))) {
        return { command, filterId: rest[1], decisionName: rest[3], owner: rest[5] };
    }
    throw new Error('Use spec|prepare|status|apply with controlled direct filenames');
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFilterEvidenceRunsDir',
        'conferenceFilterSpecsDir', 'conferenceFiltersDir']) {
        if (typeof files?.[field] !== 'string') throw new Error(`Configured ${field} is required`);
    }
    return files;
}
function readConfiguredJson(directory, name) {
    return ledgerApi.readRegularJson(filterApi.safeDirectJson(directory, name));
}
function verifyTaxonomy(files, spec) {
    if (typeof files.taxonomyRegistry !== 'string') throw new Error('Configured taxonomyRegistry is required');
    const loaded = ledgerApi.readRegularJson(files.taxonomyRegistry);
    if (loaded.sha256 !== spec.taxonomyRegistrySha256) throw new Error('Configured taxonomy registry SHA drifted from filter spec');
}

function summary(state) {
    return { kind: CONTRACT_NAME, filterId: state.filterId, conferenceId: state.input.conferenceId,
        state: state.completion.status, total: state.completion.total, included: state.completion.included,
        excluded: state.completion.excluded, pending: state.completion.pending, failed: state.completion.failed,
        attempts: state.attempts.length, inputSha256: state.input.inputSha256, stateSha256: state.stateSha256 };
}
const CONTRACT_NAME = 'conference-filter';

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-filter.js');
    const options = parseArgs(argv); const files = requireFiles(dependencies.files || Config.FILES);
    let state;
    if (options.command === 'spec') {
        const taxonomy = ledgerApi.readRegularJson(files.taxonomyRegistry);
        const discoveryHandle = discoveryApi.loadDiscoveryHandle({
            catalogDir: files.conferenceDiscoveryCatalogDir, catalogName: options.catalogName,
            reportDir: files.conferenceDiscoveryReportDir, reportName: options.reportName
        });
        const evidenceHandle = evidenceApi.loadEvidenceHandle({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
            runId: options.evidenceRunId, discoveryHandle });
        const spec = filterApi.buildProductionSpec({ endpoint: (dependencies.env || process.env).PAPER_ANALYZER_ENDPOINT,
            model: (dependencies.env || process.env).PAPER_ANALYZER_MODEL,
            taxonomyRegistrySha256: taxonomy.sha256, discoveryHandle, evidenceHandle });
        filterApi.writeFilterSpec({ specRoot: files.conferenceFilterSpecsDir, specName: options.specName, spec });
        const output = { kind: 'conference-filter-spec', specName: options.specName,
            conferenceId: spec.discovery.conferenceId, evidenceRunId: spec.evidence.runId,
            filterPolicySha256: spec.filterPolicySha256, promptSha256: spec.promptSha256,
            model: spec.model, endpointProtocol: spec.endpointProtocol };
        console.log(JSON.stringify(output)); return output;
    } else if (options.command === 'prepare') {
        const discoveryHandle = discoveryApi.loadDiscoveryHandle({
            catalogDir: files.conferenceDiscoveryCatalogDir, catalogName: options.catalogName,
            reportDir: files.conferenceDiscoveryReportDir, reportName: options.reportName
        });
        const loadedSpec = readConfiguredJson(files.conferenceFilterSpecsDir, options.specName);
        const spec = filterApi.normalizeSpec(loadedSpec.value); verifyTaxonomy(files, spec);
        const evidenceHandle = evidenceApi.loadEvidenceHandle({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
            runId: options.evidenceRunId, discoveryHandle });
        state = filterApi.prepareFilter({ filterRoot: files.conferenceFiltersDir, discoveryHandle, evidenceHandle,
            spec, filterId: options.filterId, now: dependencies.now });
    } else if (options.command === 'status') {
        state = filterApi.readFilter({ filterRoot: files.conferenceFiltersDir, filterId: options.filterId });
    } else {
        state = filterApi.applyDecisionFile({ filterRoot: files.conferenceFiltersDir, filterId: options.filterId,
            decisionName: options.decisionName, owner: options.owner, now: dependencies.now });
    }
    const output = summary(state); console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-filter] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, requireFiles, readConfiguredJson, verifyTaxonomy, summary, main };
