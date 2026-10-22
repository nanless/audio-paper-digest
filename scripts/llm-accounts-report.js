#!/usr/bin/env node
'use strict';
// 只读展示 OpenCode Go 账号池：账号指纹、状态、冷却、轮转游标。不显示原始 key。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'data', 'runtime', 'llm-account-pool.json');
const nowMs = () => Date.now();

function fingerprint(id) {
    return typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id) ? id.slice(0, 12) : crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

function readState(file) {
    if (!fs.existsSync(file)) return { state: null, error: null };
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { state, error: null };
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

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('llm-accounts-report.js'); } catch (error) { console.error(`[llm-accounts-report] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const help = argv.includes('--help');
    if (help) { console.log('用法: node scripts/llm-accounts-report.js [--json] [--state PATH]'); return 0; }
    const stateIndex = argv.indexOf('--state');
    const file = stateIndex >= 0 && argv[stateIndex + 1] ? path.resolve(argv[stateIndex + 1]) : STATE_FILE;
    const { state, error } = readState(file);
    if (error) { console.error(`[llm-accounts] 状态文件损坏：${error}`); return 1; }
    if (!state) { console.log('账号池状态不存在（尚未发过请求或已被清理）'); return 0; }
    const report = describe(state, nowMs());
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`账号池：${report.accountCount} 个账号，${report.cooling} 个冷却${report.earliest ? `，最早恢复 ${report.earliest}` : ''}`);
        for (const row of report.rows) {
            console.log(`- ${row.account}  ${row.status}${row.blockedUntil ? `（至 ${row.blockedUntil}）` : ''}${row.lastSelectedAt ? ` 最近 ${row.lastSelectedAt}` : ''}${row.groups.length ? ` 活动组 ${row.groups.join(',')}` : ''}`);
        }
    }
    return 0;
}

module.exports = { readState, describe, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[llm-accounts] ${error.message}`); process.exitCode = 1; }
}
