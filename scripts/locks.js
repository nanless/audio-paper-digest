#!/usr/bin/env node
'use strict';
// 只读查看运行锁：支持 <target>.lock/owner.json 目录锁与普通 *.lock 文件。
// --recover 只打印疑似可回收项，绝不删除。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIRS = ['data/runtime', 'data/current'];

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readOwnerRecord(target, entry) {
    if (entry.isDirectory()) {
        const ownerFile = path.join(target, 'owner.json');
        try { return JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch (_) { return null; }
    }
    try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { return null; }
}

function scanLocks(dirs = DEFAULT_DIRS, nowMs = Date.now(), options = {}) {
    const root = options.root || ROOT;
    const rows = [];
    const visit = (directory, depth) => {
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (entry.name === '.hugo_build.lock' || entry.name === 'node_modules' || entry.name === '.git') continue;
            const target = path.join(directory, entry.name);
            if (!entry.name.endsWith('.lock')) {
                if (entry.isDirectory() && depth < 3) {
                    const base = path.basename(directory);
                    const descend = depth === 0 && ['.analysis-runs', 'locks', 'conference-processes', 'conference-queues', 'conference-filter-evidence-runs', 'page-source-crosswalks', 'conference-analysis-executions', 'conference-filters', 'fresh-rewrites', 'conference-page-staging'].includes(entry.name)
                        || (base === 'conference-processes' || base === 'conference-queues' || base === 'conference-filter-evidence-runs' || base === 'page-source-crosswalks' || base === 'conference-analysis-executions' || base === 'conference-filters' || base === 'fresh-rewrites' || base === 'conference-page-staging') && depth === 1
                        || String(entry.name).includes('stage-locks') && depth < 2;
                    if (descend) visit(target, depth + 1);
                }
                continue;
            }
            const record = readOwnerRecord(target, entry);
            const rawPid = record && (record.pid ?? record.ownerPid);
            const pid = Number.isInteger(Number(rawPid)) && Number(rawPid) > 0 ? Number(rawPid) : null;
            const hostname = record && (record.hostname || record.host) || null;
            const started = record && (record.acquiredAt || record.startedAt || record.createdAt) || null;
            const heartbeat = record && (record.heartbeatAt || record.updatedAt || started) || null;
            const ageSeconds = heartbeat && !Number.isNaN(Date.parse(heartbeat))
                ? Math.max(0, Math.round((nowMs - Date.parse(heartbeat)) / 1000)) : null;
            const local = hostname === os.hostname();
            const alive = local && pid !== null ? isAlive(pid) : null;
            const needsReview = pid === null && ageSeconds !== null && ageSeconds > 86400;
            rows.push({
                file: path.relative(root, target), kind: entry.isDirectory() ? 'directory' : 'file',
                pid, hostname, startedAt: started, heartbeatAt: heartbeat, ageSeconds,
                alive, needsReview, stale: local && pid !== null ? (!alive && (ageSeconds === null || ageSeconds > 120)) : needsReview
            });
        }
    };
    for (const dir of dirs || []) visit(path.resolve(root, dir), 0);
    return rows.sort((left, right) => left.file.localeCompare(right.file));
}

function sharedBlogLocks(root = ROOT) {
    const envFile = path.join(root, '.env');
    if (!fs.existsSync(envFile)) return [];
    let env = {};
    try { env = require('./lib/env-schema').parseEnvText(fs.readFileSync(envFile, 'utf8')); } catch (_) { return []; }
    const repo = env.PAPER_DIGEST_BLOG_REPO;
    if (!repo) return [];
    const dir = path.join(repo, '.git', '.paper-digest-locks');
    if (!fs.existsSync(dir)) return [];
    const rows = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith('.lock') && !entry.isDirectory()) continue;
        const target = path.join(dir, entry.name);
        let record = null;
        try {
            record = entry.isDirectory() ? JSON.parse(fs.readFileSync(path.join(target, 'owner.json'), 'utf8')) : JSON.parse(fs.readFileSync(target, 'utf8'));
        } catch (_) { record = null; }
        rows.push({ file: path.relative(root, target), kind: 'shared-blog', pid: record && Number(record.pid) || null,
            hostname: record && record.hostname || null, startedAt: record && record.acquiredAt || null,
            heartbeatAt: record && (record.heartbeatAt || record.acquiredAt) || null, ageSeconds: null, alive: null, stale: false, needsReview: true });
    }
    return rows;
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('locks.js'); } catch (error) { console.error(`[locks] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const recover = argv.includes('--recover');
    if (argv.includes('--help')) { console.log('用法: node scripts/locks.js [--json] [--recover]'); return 0; }
    const rows = [...scanLocks(), ...sharedBlogLocks()];
    if (json) console.log(JSON.stringify({ locks: rows }, null, 2));
    else if (!rows.length) console.log('未发现运行锁。');
    else for (const row of rows) console.log(`- ${row.file}  pid=${row.pid || '?'}  ${row.alive === null ? '远端/未知' : row.alive ? '存活' : '已退出'}  心跳=${row.heartbeatAt || '?'}${row.stale ? '  ⚠ 疑似陈旧/需复核' : ''}`);
    if (recover) {
        const stale = rows.filter(row => row.stale);
        console.log(stale.length ? `\n疑似可回收 ${stale.length} 个（仅预览，未删除）：\n${stale.map(row => `  ${row.file}`).join('\n')}` : '\n没有疑似陈旧锁。');
    }
    return 0;
}

module.exports = { scanLocks, sharedBlogLocks, isAlive, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[locks] ${error.message}`); process.exitCode = 2; }
}
