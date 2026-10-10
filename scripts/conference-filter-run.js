#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const filter = require('./lib/conference-filter.js');
const discovery = require('./lib/conference-discovery.js');
const evidenceApi = require('./lib/conference-filter-evidence.js');
const ledger = require('./lib/conference-source-ledger.js');
const filterCli = require('./conference-filter.js');
const utils = require('./utils.js');
const { resolvePrimaryApiKeyPool } = require('./llm-account-pool.js');

const USAGE = '--apply --catalog NAME.json --report NAME.json --evidence-run UUID --spec NAME.json --filter UUID --owner OWNER [--limit N] [--retry-failed]';

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
        if (!['--catalog', '--report', '--evidence-run', '--spec', '--filter', '--owner', '--limit'].includes(flag)
            || value === undefined || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value; index += 1;
    }
    for (const flag of ['--catalog', '--report', '--evidence-run', '--spec', '--filter', '--owner']) {
        if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    }
    for (const flag of ['--catalog', '--report', '--spec']) {
        if (!filter.SAFE_JSON_NAME.test(values[flag])) throw new Error(`${flag} 必须是安全的直接 JSON 文件名`);
    }
    if (!filter.UUID_RE.test(values['--filter'])) throw new Error('--filter 必须是规范的 UUID v4');
    if (!evidenceApi.UUID_RE.test(values['--evidence-run'])) throw new Error('--evidence-run 必须是规范的 UUID v4');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(values['--owner'])) throw new Error('--owner 格式不对：只能用字母、数字和 . _ : -，并且要字母或数字开头');
    const limit = values['--limit'] === undefined ? 10000 : Number(values['--limit']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error(`--limit 必须是 1 到 10000 的整数：当前是 ${values['--limit']}`);
    return { catalogName: values['--catalog'], reportName: values['--report'], evidenceRunId: values['--evidence-run'],
        specName: values['--spec'],
        filterId: values['--filter'], owner: values['--owner'], limit, retryFailed: values['--retry-failed'] === true };
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFilterSpecsDir',
        'conferenceFilterEvidenceRunsDir', 'conferenceFiltersDir', 'tagCatalogFile', 'llmAccountPoolState']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) {
            throw new Error(`配置项 ${field} 必须是绝对路径`);
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
        throw new Error('会议筛选器要求 PAPER_ANALYZER_ENDPOINT、PAPER_ANALYZER_API_KEY、PAPER_ANALYZER_MODEL 三项都配好');
    }
    const apiType = utils.detectApiType(endpoint, model); const apiUrl = utils.buildApiUrl(apiType, endpoint);
    return { endpoint, model, apiUrl, apiType, apiKeys,
        headers: utils.buildHeaders(apiType, primaryKey, ''), accountPoolStateFile: files.llmAccountPoolState,
        timeoutMs: Config.FILTER_CONFIG.timeoutMs,
        maxTokens: Config.FILTER_CONFIG.maxTokens,
        maxResponseBytes: Config.FILTER_CONFIG.conferenceMaxResponseBytes,
        temperature: Config.FILTER_CONFIG.temperature };
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
    const evidenceHandle = evidenceApi.loadEvidenceHandle({ evidenceRunsRoot: files.conferenceFilterEvidenceRunsDir,
        runId: options.evidenceRunId, discoveryHandle });
    const spec = filter.normalizeSpec(ledger.readRegularJson(
        filter.safeDirectJson(files.conferenceFilterSpecsDir, options.specName)).value);
    filterCli.verifyTagCatalogFileBinding(files, spec);
    // 先整体核验已保存的来源、证据和状态，再在同一把锁下处理本次数量限制内的论文。
    // 每篇仍分别保存请求准备记录、传输凭证与筛选决定，核对原状态后更新，
    // 并用 fsync 确保文件写入完成。
    const advanced = await filter.advanceProductionLlmDecisions({ filterRoot: files.conferenceFiltersDir,
        filterId: options.filterId, discoveryHandle, evidenceHandle, spec, owner: options.owner,
        llm: () => productionLlmConfig(runtime.env || process.env, files), limit: options.limit,
        retryFailed: options.retryFailed, maxAttempts: Config.FILTER_CONFIG.maxRetries,
        retryBackoffMs: Config.FILTER_CONFIG.conferenceRetryBackoffMs });
    const { state, processed } = advanced;
    const result = { status: state.completion.status, filterId: state.filterId, processed,
        remaining: state.completion.pending + state.completion.failed, stateSha256: state.stateSha256 };
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) {
    main().catch(error => { console.error(`[conference-filter-run] ${error.message}`); process.exitCode = 1; });
}

module.exports = { USAGE, parseArgs, requireFiles, main };
