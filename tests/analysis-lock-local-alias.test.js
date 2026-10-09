'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const engine = require('../scripts/analysis-engine.js');

const alias = Object.values(os.networkInterfaces()).flat()
    .find(address => address.internal && address.family === 'IPv4').address;
const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);

function fixture(t, { legacy = false, pid = process.pid, hostname = alias } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-lock-alias-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'result.json');
    const lock = `${file}.lock`;
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock);
    fs.chmodSync(lock, legacy ? 0o755 : 0o700);
    fs.writeFileSync(ownerFile, JSON.stringify({
        pid, hostname, token: crypto.randomUUID(), acquiredAt: oldTime.toISOString()
    }));
    fs.chmodSync(ownerFile, legacy ? 0o644 : 0o600);
    fs.utimesSync(ownerFile, oldTime, oldTime);
    return { file, lock, ownerFile, bytes: fs.readFileSync(ownerFile), inode: fs.statSync(ownerFile).ino };
}

for (const legacy of [false, true]) {
    test(`本机地址别名的${legacy ? '旧' : '当前'}活锁即使过期也不回收`, t => {
        const f = fixture(t, { legacy });
        assert.equal(engine.canReclaimFileLock(f.lock, 1000), false);
        const state = engine.inspectFileLockState(f.file, { staleMs: 1000 });
        assert.equal(state.active, true);
        assert.equal(state.reclaimable, false);
        assert.equal(state.reason, 'live_local_owner');
        const options = { staleMs: 1000, timeoutMs: 0,
            recoveryPolicy: engine.HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY,
            prepareHistoricalDirectLegacyLockReclaim: () => {
                assert.fail('本机活锁不能进入历史远端锁回收审查');
            } };
        assert.throws(() => engine.acquireFileLockSync(f.file, options), /等待文件锁超时/);
        assert.deepEqual(fs.readFileSync(f.ownerFile), f.bytes);
        assert.equal(fs.statSync(f.ownerFile).ino, f.inode);
    });
}

test('本机地址别名的已退出进程仍可按旧租约恢复', t => {
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(child.status, 0);
    const f = fixture(t, { legacy: true, pid: child.pid });
    assert.equal(engine.canReclaimFileLock(f.lock, 1000), true);
    const release = engine.acquireFileLockSync(f.file, { staleMs: 1000, timeoutMs: 0 });
    assert.equal(release(), true);
    assert.equal(fs.existsSync(f.lock), false);
});

test('未知远端当前锁仍按原租约处理，不把本机同号PID当远端存活证明', t => {
    const f = fixture(t, { hostname: 'test-remote.invalid' });
    assert.equal(engine.canReclaimFileLock(f.lock, 1000), true);
    const release = engine.acquireFileLockSync(f.file, { staleMs: 1000, timeoutMs: 0 });
    assert.equal(release(), true);
});

test('本机地址别名的活回收标记不能被另一个回收者删除', t => {
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(child.status, 0);
    const f = fixture(t, { pid: child.pid });
    const marker = path.join(f.lock, '.reclaiming.json');
    fs.writeFileSync(marker, JSON.stringify({
        pid: process.pid, hostname: alias, token: crypto.randomUUID(),
        acquiredAt: oldTime.toISOString()
    }), { mode: 0o600 });
    fs.utimesSync(marker, oldTime, oldTime);
    const bytes = fs.readFileSync(marker);
    assert.throws(() => engine.acquireFileLockSync(f.file, { staleMs: 1000, timeoutMs: 0 }), /等待文件锁超时/);
    assert.deepEqual(fs.readFileSync(marker), bytes);
    assert.deepEqual(fs.readFileSync(f.ownerFile), f.bytes);
});
