#!/usr/bin/env node
'use strict';
// 只读查看运行锁：持有者、时间、心跳；--recover 只打印疑似可回收项，不删除。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIRS = ['data/runtime', 'data/current'];

function scanLocks(dirs, nowMs = Date.now()) {
    const rows = [];
    for (const dir of dirs || DEFAULT_DIRS) {
        const absolute = path.resolve(ROOT, dir);
        if (!fs.existsSync(absolute)) continue;
        const stack = [absolute];
        while (stack.length) {
            const current = stack.pop();
            let entries;
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
            for (const entry of entries) {
                const target = path.join(current, entry.name);
                if (entry.isDirectory()) { stack.push(target); continue; }
                if (!/\.lock(?:\.json)?$/.test(entry.name)) continue;
                let record = null;
                try { record = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { record = null; }
                const pid = record && (record.pid || record.ownerPid);
                const started = record && (record.startedAt || record.createdAt || record.acquiredAt);
                const heartbeat = record && (record.heartbeatAt || record.updatedAt || started);
                const ageSeconds = heartbeat ? Math.max(0, Math.round((nowMs - Date.parse(heartbeat)) / 1000)) : null;
                rows.push({
                    file: path.relative(ROOT, target), pid: pid || null, startedAt: started || null,
                    heartbeatAt: heartbeat || null, ageSeconds,
                    alive: Number.isInteger(pid) ? isAlive(pid) : null,
                    stale: Number.isInteger(pid) ? !isAlive(pid) && (ageSeconds === null || ageSeconds > 120) : null
                });
            }
        }
    }
    return rows.sort((left, right) => left.file.localeCompare(right.file));
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const recover = argv.includes('--recover');
    if (argv.includes('--help')) { console.log('用法: node scripts/locks.js [--json] [--recover]'); return 0; }
    const rows = scanLocks(DEFAULT_DIRS);
    if (json) console.log(JSON.stringify({ locks: rows }, null, 2));
    else if (!rows.length) console.log('未发现运行锁文件。');
    else {
        for (const row of rows) {
            console.log(`- ${row.file}  pid=${row.pid || '?'}  ${row.alive === null ? '' : row.alive ? '存活' : '已退出'}  心跳=${row.heartbeatAt || '?'}${row.stale ? '  ⚠ 疑似陈旧' : ''}`);
        }
    }
    if (recover) {
        const stale = rows.filter(row => row.stale);
        console.log(stale.length ? `\n疑似可回收 ${stale.length} 个（仅预览，未删除）：\n${stale.map(row => `  ${row.file}`).join('\n')}` : '\n没有疑似陈旧锁。');
    }
    return 0;
}

module.exports = { scanLocks, isAlive, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[locks] ${error.message}`); process.exitCode = 2; }
}
