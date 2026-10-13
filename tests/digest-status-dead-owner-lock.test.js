'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const engine = require('../scripts/analysis-engine');

function loadWithShortLockWait() {
    const filename = path.resolve(__dirname, '../scripts/digest-status.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const normalRequire = Module.createRequire(filename);
    loaded.require = name => name === './analysis-engine.js'
        ? { ...engine, withFileLockSync: (file, callback, options) =>
            engine.withFileLockSync(file, callback, { ...options, timeoutMs: 40 }) }
        : normalRequire(name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    return loaded.exports;
}

function sample(owner) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-dead-owner-'));
    const file = path.join(directory, 'papers.json');
    const bytes = JSON.stringify({ papers: {}, lastUpdated: null });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    fs.mkdirSync(file + '.lock', { mode: 0o700 });
    fs.writeFileSync(path.join(file + '.lock', 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    return { directory, file, bytes };
}

const deadProcess = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'],
    { encoding: 'utf8' });
assert.equal(deadProcess.status, 0);
const deadPid = Number(deadProcess.stdout);
assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');
const owner = overrides => ({ pid: deadPid, hostname: os.hostname(),
    token: crypto.randomUUID(), acquiredAt: new Date().toISOString(), ...overrides });
const digest = loadWithShortLockWait();

test('索引同步立即回收同机已死进程的完整私有锁，不改数据', () => {
    const current = sample(owner());
    try {
        const result = digest.updateAnalysisDigestStatuses([], { filePath: current.file });
        assert.equal(result.updated, 0);
        assert.equal(fs.readFileSync(current.file, 'utf8'), current.bytes);
        assert.equal(fs.existsSync(current.file + '.lock'), false);
    } finally { fs.rmSync(current.directory, { recursive: true, force: true }); }
});

for (const [name, overrides] of [
    ['当前活进程', { pid: process.pid }],
    ['其他机器', { hostname: 'another-machine.invalid' }],
    ['损坏的持有人令牌', { token: 'invalid' }]
]) {
    test(`索引同步不回收${name}的锁`, () => {
        const current = sample(owner(overrides));
        const ownerFile = path.join(current.file + '.lock', 'owner.json');
        const originalOwner = fs.readFileSync(ownerFile, 'utf8');
        try {
            assert.throws(() => digest.updateAnalysisDigestStatuses([], { filePath: current.file }),
                /等待文件锁超时/);
            assert.equal(fs.readFileSync(current.file, 'utf8'), current.bytes);
            assert.equal(fs.readFileSync(ownerFile, 'utf8'), originalOwner);
        } finally { fs.rmSync(current.directory, { recursive: true, force: true }); }
    });
}
