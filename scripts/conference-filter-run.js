#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const filter = require('./lib/conference-filter.js');
const discovery = require('./lib/conference-discovery.js');
const ledger = require('./lib/conference-source-ledger.js');
const filterCli = require('./conference-filter.js');
const utils = require('./utils.js');
const { resolvePrimaryApiKeyPool } = require('./llm-account-pool.js');

const USAGE = '--apply --catalog NAME.json --report NAME.json --spec NAME.json --filter UUID --owner OWNER [--limit N] [--retry-failed]';

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (mode !== '--apply') throw new Error(`First argument must be --apply. Use ${USAGE}`);
    const values = {};
    for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index];
        if (flag === '--retry-failed') {
            if (Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
            values[flag] = true; continue;
        }
        const value = rest[index + 1];
        if (!['--catalog', '--report', '--spec', '--filter', '--owner', '--limit'].includes(flag)
            || value === undefined || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value; index += 1;
    }
    for (const flag of ['--catalog', '--report', '--spec', '--filter', '--owner']) {
        if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    }
    for (const flag of ['--catalog', '--report', '--spec']) {
        if (!filter.SAFE_JSON_NAME.test(values[flag])) throw new Error(`${flag} must be a safe direct JSON filename`);
    }
    if (!filter.UUID_RE.test(values['--filter'])) throw new Error('--filter must be a canonical UUID v4');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(values['--owner'])) throw new Error('--owner is malformed');
    const limit = values['--limit'] === undefined ? 10000 : Number(values['--limit']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('--limit must be an integer from 1 to 10000');
    return { catalogName: values['--catalog'], reportName: values['--report'], specName: values['--spec'],
        filterId: values['--filter'], owner: values['--owner'], limit, retryFailed: values['--retry-failed'] === true };
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFilterSpecsDir',
        'conferenceFiltersDir', 'taxonomyRegistry', 'llmAccountPoolState']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) {
            throw new Error(`Configured ${field} must be an absolute path`);
        }
    }
    return files;
}

function productionLlmConfig(env, files) {
    const endpoint = String(env.PAPER_ANALYZER_ENDPOINT || '').trim();
    const model = String(env.PAPER_ANALYZER_MODEL || '').trim();
    const primaryKey = String(env.PAPER_ANALYZER_API_KEY || '').trim();
    const apiKeys = resolvePrimaryApiKeyPool(primaryKey,
        env.PAPER_ANALYZER_FALLBACK_API_KEYS || '', env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || '');
    if (!endpoint || !model || !primaryKey || !apiKeys.length) {
        throw new Error('PAPER_ANALYZER_ENDPOINT/API_KEY/MODEL are required for conference filter runner');
    }
    const apiType = utils.detectApiType(endpoint, model); const apiUrl = utils.buildApiUrl(apiType, endpoint);
    return { endpoint, model, apiUrl, apiType, apiKeys,
        headers: utils.buildHeaders(apiType, primaryKey, ''), accountPoolStateFile: files.llmAccountPoolState,
        timeoutMs: Config.FILTER_CONFIG.conferenceTimeoutMs,
        maxTokens: Config.FILTER_CONFIG.conferenceMaxTokens,
        maxResponseBytes: Config.FILTER_CONFIG.conferenceMaxResponseBytes,
        temperature: Config.FILTER_CONFIG.conferenceTemperature };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-filter-run.js');
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
        || Object.keys(runtime).some(key => !['files', 'env'].includes(key))) {
        throw new Error('conference filter runtime only accepts files/env; transport injection is forbidden');
    }
    const options = parseArgs(argv); const files = requireFiles(runtime.files || Config.FILES);
    const catalogFile = filter.safeDirectJson(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = filter.safeDirectJson(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);
    const spec = filter.normalizeSpec(ledger.readRegularJson(
        filter.safeDirectJson(files.conferenceFilterSpecsDir, options.specName)).value);
    filterCli.verifyTaxonomy(files, spec);
    let state = filter.assertBoundInputs(filter.readFilter({ filterRoot: files.conferenceFiltersDir,
        filterId: options.filterId }), { catalog: filter.catalogFromDiscoveryHandle(discoveryHandle), spec });
    const processed = []; let llm = null;
    while (processed.length < options.limit) {
        const paperId = filter.selectNextCandidate(state, { retryFailed: options.retryFailed,
            maxAttempts: Config.FILTER_CONFIG.conferenceMaxAttempts,
            retryBackoffMs: Config.FILTER_CONFIG.conferenceRetryBackoffMs });
        if (!paperId) break;
        llm ||= productionLlmConfig(runtime.env || process.env, files);
        const result = await filter.advanceProductionLlmDecision({ filterRoot: files.conferenceFiltersDir,
            filterId: options.filterId, discoveryHandle, spec, paperId, owner: options.owner, llm });
        state = result.state;
        processed.push({ paperId: result.paperId, status: state.decisions[result.paperId].status,
            recovered: result.recovered });
    }
    const result = { status: state.completion.status, filterId: state.filterId, processed,
        remaining: state.completion.pending + state.completion.failed, stateSha256: state.stateSha256 };
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) {
    main().catch(error => { console.error(`[conference-filter-run] ${error.message}`); process.exitCode = 1; });
}

module.exports = { USAGE, parseArgs, requireFiles, main };
