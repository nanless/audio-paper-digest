'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const recovery = require('../scripts/recover-conference-process-locks.js');
const engine = require('../scripts/analysis-engine.js');

const PROCESS_A = '11111111-1111-4111-8111-111111111111';
const PROCESS_B = '22222222-2222-4222-8222-222222222222';
const PROCESS_C = '33333333-3333-4333-8333-333333333333';
const PROCESS_D = '44444444-4444-4444-8444-444444444444';

function makePrivateRoot(t) {
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'recover-conf-locks-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'conference-processes');
    fs.mkdirSync(root, { mode: 0o700 });
    return { parent, root };
}

test('pidIsDead 拒绝非正整数，不误触发 process.kill(0/-1)', () => {
    for (const invalid of [0, -1, -42, 1.5, NaN, null, undefined, '123', {}]) {
        assert.equal(recovery.pidIsDead(invalid), false);
    }
    assert.equal(recovery.pidIsDead(process.pid), false);
    assert.equal(recovery.pidIsDead(2147483647), true);
});

test('processDirectories 校验私有根目录并只返回 UUID 子目录', t => {
    const { parent, root } = makePrivateRoot(t);
    assert.throws(() => recovery.processDirectories('relative/path'), /绝对路径/);
    assert.throws(() => recovery.processDirectories(path.parse(root).root), /根目录/);
    assert.deepEqual(recovery.processDirectories(path.join(parent, 'missing')), []);

    const wide = path.join(parent, 'wide');
    fs.mkdirSync(wide, { mode: 0o755 });
    assert.throws(() => recovery.processDirectories(wide), /0700/);

    const link = path.join(parent, 'link');
    fs.symlinkSync(root, link);
    assert.throws(() => recovery.processDirectories(link), /符号链接|0700/);

    fs.mkdirSync(path.join(root, PROCESS_A), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'not-a-uuid'), { mode: 0o700 });
    fs.symlinkSync(path.join(root, PROCESS_A), path.join(root, PROCESS_B));
    assert.deepEqual(recovery.processDirectories(root), [path.join(root, PROCESS_A)]);
});

test('recoverLocks 向 inspectFileLockState 透传恢复策略、使用 snapshot.owner 并核对主机名', t => {
    const { root } = makePrivateRoot(t);
    for (const id of [PROCESS_A, PROCESS_B, PROCESS_C, PROCESS_D]) {
        fs.mkdirSync(path.join(root, id), { mode: 0o700 });
    }
    const POLICY = 'operator-confirmed-dead-operation-lock-recovery-v1';
    const inspectedCalls = [];
    const lockedCalls = [];
    const fakeEngine = {
        OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY: POLICY,
        inspectFileLockState(lockPath, options) {
            inspectedCalls.push({ lockPath, options });
            const id = path.basename(path.dirname(lockPath));
            if (id === PROCESS_A) {
                return { exists: true, active: false, reclaimable: true,
                    owner: { pid: 999991, hostname: 'host-local', acquiredAt: '2026-01-01T00:00:00.000Z' } };
            }
            if (id === PROCESS_B) {
                return { exists: true, active: false, reclaimable: true,
                    owner: { pid: 999992, hostname: 'host-remote', acquiredAt: '2026-01-01T00:00:00.000Z' } };
            }
            if (id === PROCESS_C) {
                return { exists: true, active: true, reclaimable: false,
                    owner: { pid: 999993, hostname: 'host-local', acquiredAt: '2026-01-01T00:00:00.000Z' } };
            }
            return { exists: true, active: false, reclaimable: true, owner: null };
        },
        withFileLockSync(lockPath, fn, options) {
            lockedCalls.push({ lockPath, options });
            return fn();
        }
    };

    const result = recovery.recoverLocks(root, {
        engine: fakeEngine,
        hostname: 'host-local',
        pidIsDead: pid => pid === 999991 || pid === 999992
    });

    assert.equal(inspectedCalls.length, 4);
    for (const call of inspectedCalls) {
        assert.deepEqual(call.options, { recoveryPolicy: POLICY });
    }
    assert.equal(lockedCalls.length, 1);
    assert.equal(path.basename(path.dirname(lockedCalls[0].lockPath)), PROCESS_A);
    assert.deepEqual(lockedCalls[0].options, { recoveryPolicy: POLICY });
    assert.deepEqual(result.recovered, [{ processId: PROCESS_A, pid: 999991, host: 'host-local' }]);
    assert.deepEqual(result.skipped.map(item => item.processId).sort(), [PROCESS_B, PROCESS_C, PROCESS_D]);
});

test('recoverLocks 与真实 analysis-engine 联调：回收本机已死锁、保留异机锁', t => {
    const { root } = makePrivateRoot(t);
    const localDir = path.join(root, PROCESS_A);
    const remoteDir = path.join(root, PROCESS_B);
    fs.mkdirSync(localDir, { mode: 0o700 });
    fs.mkdirSync(remoteDir, { mode: 0o700 });

    const writeOwnerLock = (dir, { pid, hostname }) => {
        const lockDir = path.join(dir, '.operation.lock');
        fs.mkdirSync(lockDir, { mode: 0o700 });
        const owner = {
            pid,
            hostname,
            token: crypto.randomUUID(),
            acquiredAt: new Date(Date.now() - 60_000).toISOString()
        };
        fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
        return lockDir;
    };

    const localLock = writeOwnerLock(localDir, { pid: 2147483647, hostname: os.hostname() });
    const remoteLock = writeOwnerLock(remoteDir, { pid: 2147483647, hostname: `${os.hostname()}-other` });

    const result = recovery.recoverLocks(root);
    assert.deepEqual(result.recovered, [{ processId: PROCESS_A, pid: 2147483647, host: os.hostname() }]);
    assert.equal(fs.existsSync(localLock), false);
    assert.deepEqual(result.skipped.map(item => item.processId), [PROCESS_B]);
    assert.equal(fs.existsSync(remoteLock), true);
    assert.equal(engine.inspectFileLockState(path.join(localDir, '.operation')).exists, false);
});
