'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const processApi = require('../scripts/lib/conference-process.js');
const { createSourceFixture, storageDependencies } = require('./helpers/conference-process-storage-fixture.js');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return createSourceFixture(root);
}
function expectedFiles(f) {
    const source = processApi.sourceNames(f.paperId, f.context.authority.implementationSha256);
    const shared = processApi.namesFor(f.context);
    const processId = processApi.deterministicUuid(processApi.stableHash(f.context.authority), processApi.CONTRACT);
    return {
        metadata: path.join(f.files.conferenceStagingSourceDir, source.metadata),
        pdf: path.join(f.files.conferenceStagingSourceDir, source.pdf),
        request: path.join(f.files.conferenceStagingSourceDir, source.request),
        seal: path.join(f.files.conferenceStagingSpecsDir, shared.extraction),
        plan: path.join(f.files.conferenceSourceLedgerDir, shared.plan),
        completion: path.join(f.files.conferenceProcessDir, processId, 'completion-receipt.json')
    };
}
function killAfterLink(f, target) {
    const script = `
        const fs = require('node:fs');
        const api = require(${JSON.stringify(require.resolve('../scripts/lib/conference-process.js'))});
        const { storageDependencies } = require(${JSON.stringify(require.resolve('./helpers/conference-process-storage-fixture.js'))});
        const original = fs.linkSync;
        fs.linkSync = function(source, filename) {
            original.call(this, source, filename);
            if (filename === ${JSON.stringify(target)}) process.kill(process.pid, 'SIGKILL');
        };
        api.runConferenceProcess(${JSON.stringify(f.options)}, storageDependencies(${JSON.stringify(f.files)}))
            .catch(error => { console.error(error); process.exitCode=1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.equal(fs.statSync(target).nlink, 2);
}

test('公开会议运行完成凭证短写不留下正式半文件，保留原 EIO 后可继续', async t => {
    const f = fixture(t); const target = expectedFiles(f).completion;
    const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync;
    const failure = Object.assign(new Error('模拟完成凭证短写'), { code: 'EIO' });
    let targetFd = null; let injected = false;
    fs.openSync = function(filename, ...args) {
        const fd = originalOpen.call(this, filename, ...args);
        if (String(filename) === target || String(filename).startsWith(path.join(path.dirname(target), '.completion-receipt.json.'))) targetFd = fd;
        return fd;
    };
    fs.writeFileSync = function(destination, bytes, ...args) {
        if (destination === targetFd && !injected) {
            injected = true; fs.writeSync(destination, Buffer.from(bytes).subarray(0, 8)); throw failure;
        }
        return originalWrite.call(this, destination, bytes, ...args);
    };
    try { await assert.rejects(processApi.runConferenceProcess(f.options, f.deps), error => error === failure); }
    finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
    assert.equal(injected, true); assert.equal(fs.existsSync(target), false);
    const resumed = await processApi.runConferenceProcess(f.options, f.deps);
    assert.equal(resumed.status, 'complete');
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(path.dirname(target), 'state.json'))));
    processApi.validateCompletionReceipt(state, JSON.parse(fs.readFileSync(target)));
});

for (const stage of ['metadata', 'pdf', 'request', 'seal', 'plan', 'completion']) {
    test(`公开会议运行在 ${stage} 链接后真实崩溃，重新核验来源后恢复`, async t => {
        const f = fixture(t); const target = expectedFiles(f)[stage];
        killAfterLink(f, target);
        const bytes = fs.readFileSync(target); const inode = fs.statSync(target).ino;
        const resumed = await processApi.runConferenceProcess(f.options, storageDependencies(f.files));
        assert.equal(resumed.status, 'complete');
        assert.deepEqual(fs.readFileSync(target), bytes);
        assert.equal(fs.statSync(target).ino, inode); assert.equal(fs.statSync(target).nlink, 1);
    });
}

test('已保存 PDF 的双链接必须先通过原官方来源核验，失败时不清理', async t => {
    const f = fixture(t); const target = expectedFiles(f).pdf;
    killAfterLink(f, target);
    const before = fs.readFileSync(target);
    fs.writeFileSync(path.join(f.root, 'pdf', 'papers', 'ando26_odyssey.pdf'), '%PDF-corrupted');
    await assert.rejects(processApi.runConferenceProcess(f.options, storageDependencies(f.files)));
    assert.equal(fs.statSync(target).nlink, 2); assert.deepEqual(fs.readFileSync(target), before);
});

test('会议不可变写保留竞争胜者、旧半文件和权限限制', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-exact-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const payload = Buffer.from('expected complete bytes');
    for (const same of [true, false]) {
        const target = path.join(root, `winner-${same}.json`); const winner = same ? payload : Buffer.from('different winner');
        const original = fs.linkSync; let injected = false;
        fs.linkSync = function(source, destination) {
            if (destination === target && !injected) { injected = true; fs.writeFileSync(target, winner, { mode: 0o600 }); }
            return original.call(this, source, destination);
        };
        try {
            if (same) assert.equal(processApi.exactFile(target, payload), target);
            else assert.throws(() => processApi.exactFile(target, payload));
        } finally { fs.linkSync = original; }
        assert.equal(injected, true); assert.deepEqual(fs.readFileSync(target), winner);
    }
    const partial = path.join(root, 'old-partial.json'); fs.writeFileSync(partial, '{"contract":', { mode: 0o600 });
    assert.throws(() => processApi.exactFile(partial, payload)); assert.equal(fs.readFileSync(partial, 'utf8'), '{"contract":');
    const publicFile = path.join(root, 'public.json'); fs.writeFileSync(publicFile, payload, { mode: 0o644 });
    assert.throws(() => processApi.exactFile(publicFile, payload), /0600/); assert.equal(fs.statSync(publicFile).mode & 0o777, 0o644);
});

for (const ownerKind of ['live', 'foreign', 'unknown']) {
    test(`公开会议运行不得接管 ${ownerKind} 的内部状态锁`, async t => {
        const f = fixture(t);
        const stateFile = path.join(path.dirname(expectedFiles(f).completion), 'state.json');
        fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
        const engine = f.deps.engine;
        const deps = { ...f.deps, engine: { ...engine,
            updateJsonFileLocked: (filename, update, options) => engine.updateJsonFileLocked(filename, update,
                { ...options, timeoutMs: 25 }) } };
        const lockPath = `${stateFile}.lock`; const ownerPath = path.join(lockPath, 'owner.json');
        async function refusesOwner() {
            const before = fs.readFileSync(ownerPath); const inode = fs.statSync(ownerPath).ino;
            await assert.rejects(processApi.runConferenceProcess(f.options, deps), /等待文件锁超时/);
            assert.deepEqual(fs.readFileSync(ownerPath), before);
            assert.equal(fs.statSync(ownerPath).ino, inode);
            assert.equal(fs.existsSync(stateFile), false);
            assert.equal(fs.existsSync(expectedFiles(f).completion), false);
        }
        if (ownerKind === 'live') {
            await engine.withFileLock(stateFile, refusesOwner);
            assert.equal(fs.existsSync(lockPath), false);
        } else {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            const deadChild = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
            assert.equal(deadChild.status, 0);
            const owner = ownerKind === 'unknown' ? {} : { pid: deadChild.pid,
                hostname: 'other-machine.invalid', token: require('node:crypto').randomUUID(),
                acquiredAt: new Date().toISOString() };
            fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
            await refusesOwner();
        }
    });
}

test('直接调用导出的内部运行函数不能凭空取得外层持锁证明', async t => {
    const f = fixture(t);
    const directory = path.dirname(expectedFiles(f).completion);
    const stateFile = path.join(directory, 'state.json'); const lockPath = `${stateFile}.lock`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const deadChild = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
    assert.equal(deadChild.status, 0);
    const ownerPath = path.join(lockPath, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: deadChild.pid, hostname: os.hostname(),
        token: require('node:crypto').randomUUID(), acquiredAt: new Date().toISOString() }), { mode: 0o600 });
    const before = fs.readFileSync(ownerPath); const inode = fs.statSync(ownerPath).ino;
    const engine = f.deps.engine;
    const deps = { ...f.deps, engine: { ...engine,
        updateJsonFileLocked: (filename, update, options) => engine.updateJsonFileLocked(filename, update,
            { ...options, timeoutMs: 25 }) } };
    for (const attemptedProof of [undefined, true, Symbol('conference-process-operation-lock-held')]) {
        await assert.rejects(processApi.runConferenceProcessLocked(f.options, deps, f.context,
            path.basename(directory), directory, attemptedProof), /等待文件锁超时/);
        assert.deepEqual(fs.readFileSync(ownerPath), before);
        assert.equal(fs.statSync(ownerPath).ino, inode);
        assert.equal(fs.existsSync(stateFile), false);
    }
});
