'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const kind of ['owner', 'marker']) {
    test(`公共${kind === 'owner' ? '锁检查' : '锁回收'}拒绝检查后换入的真实FIFO`, t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-lock-fifo-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const result = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const path = require('node:path');
            const crypto = require('node:crypto');
            const assert = require('node:assert/strict');
            const { spawnSync } = require('node:child_process');
            const engine = require('./scripts/analysis-engine.js');
            const file = path.join(process.argv[1], 'state.json');
            const kind = process.argv[2];
            const lock = file + '.lock';
            const owner = path.join(lock, 'owner.json');
            const marker = path.join(lock, '.reclaiming.json');
            const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const body = {
                pid: 1,
                hostname: 'test-remote.invalid',
                token: crypto.randomUUID(),
                acquiredAt: old.toISOString()
            };
            fs.mkdirSync(lock, { mode: 0o700 });
            fs.writeFileSync(owner, JSON.stringify(body), { mode: 0o600 });
            fs.utimesSync(owner, old, old);
            if (kind === 'marker') {
                fs.writeFileSync(marker, JSON.stringify(body), { mode: 0o600 });
                fs.utimesSync(marker, old, old);
            }
            const originalOwner = fs.readFileSync(owner);
            const target = kind === 'owner' ? owner : marker;
            const lstat = fs.lstatSync;
            let swapped = false;
            fs.lstatSync = function (filename, ...args) {
                const stat = lstat(filename, ...args);
                if (filename === target && !swapped) {
                    swapped = true;
                    fs.unlinkSync(target);
                    assert.equal(spawnSync('mkfifo', [target]).status, 0);
                }
                return stat;
            };
            const readFile = fs.readFileSync;
            let fifoRead = false;
            fs.readFileSync = function (filename, ...args) {
                if (typeof filename === 'number' && fs.fstatSync(filename).isFIFO()) {
                    fifoRead = true;
                    throw new Error('不应读取FIFO描述符');
                }
                return readFile(filename, ...args);
            };
            if (kind === 'owner') {
                const state = engine.inspectFileLockState(file, { staleMs: 1000 });
                assert.equal(state.active, true);
                assert.equal(state.reclaimable, false);
            } else {
                assert.throws(() => engine.acquireFileLockSync(file, {
                    staleMs: 1000, timeoutMs: 0
                }), /等待文件锁超时/);
                assert.deepEqual(fs.readFileSync(owner), originalOwner);
            }
            assert.equal(swapped, true);
            assert.equal(fifoRead, false);
            assert.equal(lstat(target).isFIFO(), true);
            console.log(JSON.stringify({ swapped, fifoRead, preserved: lstat(target).isFIFO() }));
        `, directory, kind], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 2500
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { swapped: true, fifoRead: false, preserved: true });
        const node = path.join(directory, 'state.json.lock', kind === 'owner' ? 'owner.json' : '.reclaiming.json');
        assert.equal(fs.lstatSync(node).isFIFO(), true);
    });
}
