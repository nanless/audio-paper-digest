#!/usr/bin/env node
'use strict';
// 只读区分当前配置与历史观察；不发请求、不刷新额度、不改状态。
const fs = require('node:fs');
const path = require('node:path');
const pool = require('./llm-account-pool');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'data', 'runtime', 'llm-account-pool.json');
const nowMs = () => Date.now();

function readState(file) {
    if (!fs.existsSync(file)) return { state: null, error: null };
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { state, error: null, present: true };
    } catch (error) {
        return { state: null, error: error.message };
    }
}

function describe(state, atMs) {
    const services = state && state.services && typeof state.services === 'object' ? state.services : {};
    const rows = [];
    for (const service of Object.values(services)) {
        const accounts = service && service.accounts ? service.accounts : {};
        const groups = service && service.groups ? service.groups : {};
        const activeByGroup = new Map(Object.entries(groups).map(([id, group]) => [id, group]));
        for (const [accountId, record] of Object.entries(accounts)) {
            const blockedUntil = Number(record && record.blockedUntilMs);
            const blocked = Number.isFinite(blockedUntil) && blockedUntil > atMs;
            const matchingGroups = [...activeByGroup.entries()].filter(([, group]) => group && group.activeAccountId === accountId);
            const groupSelected = matchingGroups
                .map(([, group]) => Number(group.lastSelectedAtMs))
                .filter(value => Number.isFinite(value) && value > 0);
            const lastSelected = groupSelected.length ? Math.max(...groupSelected) : null;
            rows.push({
                account: `账号 ${rows.length + 1}`,
                status: blocked ? 'quota_blocked' : (record && record.status === 'quota_blocked' ? 'eligible_after_cooldown' : (record && record.status) || 'eligible'),
                blockedUntil: blocked ? new Date(blockedUntil).toISOString() : null,
                lastSelectedAt: lastSelected ? new Date(lastSelected).toISOString() : null,
                groups: matchingGroups.map(([, group], index) => `组 ${index + 1}`)
            });
        }
    }
    const earliest = rows.map(row => row.blockedUntil).filter(Boolean).sort()[0] || null;
    return rows.sort((left, right) => left.account.localeCompare(right.account)), { rows, earliest, accountCount: rows.length, cooling: rows.filter(row => row.status === 'quota_blocked').length };
}

function historyRecords(state, atMs) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(state) || state.schemaVersion !== 1 || state.policyVersion !== pool.POLICY_VERSION
        || !object(state.services)) return null;
    const records = [];
    const timestamp = value => typeof value === 'number' && Number.isFinite(value)
        && value >= 0 && value <= 8_640_000_000_000_000;
    for (const [serviceId, service] of Object.entries(state.services)) {
        if (!object(service) || !object(service.accounts) || !object(service.groups)) return null;
        for (const [accountId, record] of Object.entries(service.accounts)) {
            if (!object(record) || (record.blockedUntilMs !== undefined && !timestamp(record.blockedUntilMs))) return null;
            const blocked = record.blockedUntilMs > atMs;
            const selected = Object.values(service.groups).filter(object)
                .filter(group => group.activeAccountId === accountId && timestamp(group.lastSelectedAtMs))
                .map(group => group.lastSelectedAtMs);
            records.push({ serviceId, accountId, row: {
                account: `账号 ${records.length + 1}`,
                status: blocked ? 'quota_blocked' : 'previously_observed',
                blockedUntil: blocked ? new Date(record.blockedUntilMs).toISOString() : null,
                lastSelectedAt: selected.length ? new Date(Math.max(...selected)).toISOString() : null
            } });
        }
    }
    return records;
}

function describeConfigured(env, state, atMs, options = {}) {
    const records = state === null ? [] : historyRecords(state, atMs);
    const stateStatus = options.stateStatus || (state === null ? 'missing' : records === null ? 'invalid' : 'present');
    const rows = (records || []).map(record => record.row);
    const unavailable = !['present', 'missing'].includes(stateStatus);
    const observedHistory = { state: stateStatus,
        accountCount: unavailable ? null : rows.length,
        cooling: unavailable ? null : rows.filter(row => row.status === 'quota_blocked').length,
        earliest: rows.map(row => row.blockedUntil).filter(Boolean).sort()[0] || null, rows };
    let configured;
    try {
        const primaryEndpoint = String(env.PAPER_ANALYZER_ENDPOINT || '');
        const primaryKey = String(env.PAPER_ANALYZER_API_KEY || '').trim();
        const primaryKeys = pool.resolvePrimaryApiKeyPool(primaryKey, env.PAPER_ANALYZER_FALLBACK_API_KEYS || '',
            env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || '');
        const secondaryModel = String(env.PAPER_ANALYZER_SECONDARY_MODEL || '').trim();
        const secondaryEndpoint = String(env.PAPER_ANALYZER_SECONDARY_ENDPOINT || primaryEndpoint);
        const secondaryKeys = secondaryModel ? pool.resolveSecondaryApiKeys({
            primaryEndpoint, primaryKey, primaryApiKeys: primaryKeys,
            secondaryEndpoint, secondaryKey: env.PAPER_ANALYZER_SECONDARY_API_KEY,
            secondaryModel, secondaryFallbackApiKeys: env.PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS
        }) : [];
        const routeInputs = [
            { role: 'primary', endpoint: primaryEndpoint, keys: primaryKeys, model: env.PAPER_ANALYZER_MODEL },
            { role: 'secondary', endpoint: secondaryEndpoint, keys: secondaryKeys, model: secondaryModel }
        ];
        const credentials = new Map();
        const routes = routeInputs.map(route => {
            const active = route.role === 'primary' || Boolean(secondaryModel);
            const service = pool.normalizeOpenCodeGoService(route.endpoint);
            if (active && route.endpoint) {
                require('./utils').validateApiEndpointUrl(route.endpoint);
                if (route.keys.length > 1 && !service) throw new Error('invalid route');
            }
            for (const key of route.keys) {
                const accountId = pool.getAccountId(key);
                const item = credentials.get(accountId) || { roles: [], observations: [] };
                item.roles.push(route.role);
                if (service && records) {
                    const identity = pool.getPoolIdentity([key], route.endpoint);
                    const found = records.find(record => record.serviceId === identity.serviceId && record.accountId === accountId);
                    if (found) item.observations.push(found.row);
                }
                credentials.set(accountId, item);
            }
            return { role: route.role, enabled: active && Boolean(route.endpoint && route.model && route.keys.length
                    && (route.role !== 'primary' || primaryKey)),
                accountCount: route.keys.length };
        });
        const currentRows = [...credentials.values()].map((item, index) => {
            const blocked = item.observations.map(row => row.blockedUntil).filter(Boolean).sort();
            const selected = item.observations.map(row => row.lastSelectedAt).filter(Boolean).sort();
            return { account: `账号 ${index + 1}`, routes: item.roles,
                status: blocked.length ? 'quota_blocked' : item.observations.length ? 'previously_observed' : 'unobserved',
                blockedUntil: blocked.at(-1) || null, lastSelectedAt: selected.at(-1) || null };
        });
        configured = { status: routes[0].enabled && (!secondaryModel || routes[1].enabled) ? 'configured' : 'incomplete',
            countBasis: 'distinct_configured_credentials', accountCount: currentRows.length, routes,
            observedCount: currentRows.filter(row => row.status !== 'unobserved').length,
            unobservedCount: currentRows.filter(row => row.status === 'unobserved').length,
            cooling: currentRows.filter(row => row.status === 'quota_blocked').length,
            earliest: currentRows.map(row => row.blockedUntil).filter(Boolean).sort()[0] || null, rows: currentRows };
    } catch (_) {
        // Config errors can include private routes; this reporting boundary emits fixed text only.
        configured = { status: 'invalid', countBasis: 'distinct_configured_credentials', accountCount: null,
            routes: [], observedCount: null, unobservedCount: null, cooling: null, earliest: null, rows: [] };
    }
    return { version: 2, configured, observedHistory, quotaObservation: 'stored_cooldown_only' };
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('llm-accounts-report.js'); } catch (error) { console.error(`[llm-accounts-report] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const help = argv.includes('--help');
    if (help) { console.log('用法: node scripts/llm-accounts-report.js [--json] [--state PATH]'); return 0; }
    const stateIndex = argv.indexOf('--state');
    const file = stateIndex >= 0 && argv[stateIndex + 1] ? path.resolve(argv[stateIndex + 1]) : STATE_FILE;
    const env = require('./env-loader').loadProjectEnv();
    const { state, error, present } = readState(file);
    const stateOptions = error ? { stateStatus: 'unreadable' }
        : present && state === null ? { stateStatus: 'invalid' } : {};
    const report = describeConfigured(env, state, nowMs(), stateOptions);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`当前配置：${report.configured.accountCount ?? '未知'} 个不同凭据（${report.configured.status}）；历史观察：${report.observedHistory.accountCount ?? '未知'} 条（${report.observedHistory.state}）。`);
        console.log(`当前配置的已存冷却：${report.configured.cooling ?? '未知'}；未观察：${report.configured.unobservedCount ?? '未知'}。未探测实时余额或可用性。`);
        for (const route of report.configured.routes) console.log(`- ${route.role}：${route.accountCount} 个配置凭据，${route.enabled ? '已配置' : '未启用或不完整'}`);
        for (const row of report.configured.rows) {
            console.log(`- ${row.account}  ${row.status}${row.blockedUntil ? `（至 ${row.blockedUntil}）` : ''}${row.lastSelectedAt ? ` 最近 ${row.lastSelectedAt}` : ''}`);
        }
    }
    return error || ['invalid', 'unreadable'].includes(report.observedHistory.state)
        || report.configured.status !== 'configured' ? 1 : 0;
}

module.exports = { readState, describe, describeConfigured, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[llm-accounts] ${error.message}`); process.exitCode = 1; }
}
