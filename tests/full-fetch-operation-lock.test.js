'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { fullFetch } = require('../scripts/full-fetch.js');

const descriptions = { dead: '回收本机已退出进程的锁', alive: '保留活进程的锁',
    foreign: '保留其他机器的锁', 'unsafe-directory': '拒绝目录权限不安全的锁',
    'unsafe-owner': '拒绝持有者文件权限不安全的锁', 'invalid-token': '拒绝无效身份的锁',
    'explicit-disabled': '保留显式关闭恢复的选项' };
for (const [scenario, description] of Object.entries(descriptions)) {
    test(`日更操作锁：${description}`, async t => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-operation-lock-'));
        t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
        const exited = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
        assert.equal(exited.status, 0);
        const deadPid = Number(exited.stdout.toString());
        assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
        const target = path.join(folder, 'operation');
        const lock = `${target}.lock`;
        fs.mkdirSync(lock, { mode: 0o700 });
        const ownerPath = path.join(lock, 'owner.json');
        const owner = {
            pid: scenario === 'alive' ? process.pid : deadPid,
            hostname: scenario === 'foreign' ? `${os.hostname()}-other` : os.hostname(),
            token: scenario === 'invalid-token' ? 'invalid' : crypto.randomUUID(),
            acquiredAt: new Date().toISOString()
        };
        const original = Buffer.from(JSON.stringify(owner));
        fs.writeFileSync(ownerPath, original, { mode: 0o600 });
        if (scenario === 'unsafe-directory') fs.chmodSync(lock, 0o755);
        if (scenario === 'unsafe-owner') fs.chmodSync(ownerPath, 0o644);
        const lockOptions = { timeoutMs: 40, retryMs: 5, staleMs: 7200000 };
        if (scenario === 'explicit-disabled') lockOptions.recoveryPolicy = null;
        // 已取得锁后，真实日期守卫在任何归档、来源或模型请求前终止。
        const pending = fullFetch({ date: '2000-01-01', lockTarget: target, lockOptions });
        if (scenario === 'dead') {
            await assert.rejects(pending, /抓取启动日期已变化：请求 2000-01-01/);
            assert.equal(fs.existsSync(lock), false);
        } else {
            await assert.rejects(pending, /等待文件锁超时/);
            assert.deepEqual(fs.readFileSync(ownerPath), original);
        }
    });
}
