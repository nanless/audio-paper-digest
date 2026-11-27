'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

function walkJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkJsFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function buildScriptsDependencyGraph() {
    const files = walkJsFiles(SCRIPTS_DIR)
        .map(file => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
        .sort();
    const fileSet = new Set(files);

    function resolveLocalSpec(fromRel, spec) {
        const base = path.resolve(REPO_ROOT, path.dirname(fromRel), spec);
        for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
            const rel = path.relative(REPO_ROOT, candidate).split(path.sep).join('/');
            if (fileSet.has(rel)) return rel;
        }
        return null;
    }

    const adj = new Map();
    for (const rel of files) {
        const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        const edges = new Set();
        const re = /(?:require|useModule)\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
        let match;
        while ((match = re.exec(source)) !== null) {
            const target = resolveLocalSpec(rel, match[1]);
            if (target) edges.add(target);
        }
        adj.set(rel, [...edges].sort());
    }
    return { files, adj };
}

function computeTarjanSccs(files, adj) {
    let nextIndex = 0;
    const indices = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];

    function strongconnect(node) {
        indices.set(node, nextIndex);
        lowlink.set(node, nextIndex);
        nextIndex += 1;
        stack.push(node);
        onStack.add(node);

        for (const neighbor of adj.get(node) || []) {
            if (!indices.has(neighbor)) {
                strongconnect(neighbor);
                lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(neighbor)));
            } else if (onStack.has(neighbor)) {
                lowlink.set(node, Math.min(lowlink.get(node), indices.get(neighbor)));
            }
        }

        if (lowlink.get(node) === indices.get(node)) {
            const component = [];
            while (true) {
                const member = stack.pop();
                onStack.delete(member);
                component.push(member);
                if (member === node) break;
            }
            sccs.push(component.sort());
        }
    }

    for (const file of files) {
        if (!indices.has(file)) strongconnect(file);
    }
    return sccs;
}

test('Tarjan SCC: scripts/utils.js is decoupled from digest-status, explicit-reader-retry-round, and deep-analyzer', () => {
    const { files, adj } = buildScriptsDependencyGraph();
    const sccs = computeTarjanSccs(files, adj);
    const utilsScc = sccs.find(component => component.includes('scripts/utils.js'));

    assert.ok(utilsScc, 'scripts/utils.js must exist in dependency graph');
    assert.equal(utilsScc.length, 1, `scripts/utils.js should form a singleton SCC, got: ${utilsScc.join(', ')}`);
    assert.equal(utilsScc.includes('scripts/digest-status.js'), false);
    assert.equal(utilsScc.includes('scripts/lib/explicit-reader-retry-round.js'), false);
    assert.equal(utilsScc.includes('scripts/deep-analyzer.js'), false);

    const utilsEdges = adj.get('scripts/utils.js') || [];
    assert.equal(utilsEdges.includes('scripts/digest-status.js'), false);
    assert.equal(utilsEdges.includes('scripts/lib/explicit-reader-retry-round.js'), false);
    assert.equal(utilsEdges.includes('scripts/lib/physical-request-hook.js'), true);
    assert.equal(utilsEdges.includes('scripts/lib/papers-backup.js'), true);
});

test('Leaf invariants: file-lock, physical-request-hook, and reader-draft-hash are 0-dep leaves; papers-backup depends only on file-lock', () => {
    const { files, adj } = buildScriptsDependencyGraph();
    for (const leaf of [
        'scripts/lib/file-lock.js',
        'scripts/lib/physical-request-hook.js',
        'scripts/lib/reader-draft-hash.js'
    ]) {
        assert.ok(adj.has(leaf), `${leaf} must exist`);
        assert.deepEqual(adj.get(leaf), [], `${leaf} must be a strict leaf with 0 local project require() edges`);
    }
    assert.ok(adj.has('scripts/lib/papers-backup.js'), 'scripts/lib/papers-backup.js must exist');
    assert.deepEqual(
        adj.get('scripts/lib/papers-backup.js'),
        ['scripts/lib/file-lock.js'],
        'scripts/lib/papers-backup.js must depend only on zero-dep leaf scripts/lib/file-lock.js'
    );

    const sccs = computeTarjanSccs(files, adj);
    for (const singleton of [
        'scripts/lib/file-lock.js',
        'scripts/lib/papers-backup.js',
        'scripts/utils.js'
    ]) {
        const scc = sccs.find(component => component.includes(singleton));
        assert.deepEqual(scc, [singleton], `${singleton} must remain a singleton SCC (outside any cycle)`);
    }
});

test('file-lock.js parity with analysis-engine.js, stale-lock reclaim, .reclaiming.json safety, O_NOFOLLOW, and papers-backup.js integration', async t => {
    const fileLock = require('../scripts/lib/file-lock.js');
    const engine = require('../scripts/analysis-engine.js');
    const papersBackup = require('../scripts/lib/papers-backup.js');

    for (const symbol of [
        'LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY',
        'OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY',
        'HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY',
        'HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS',
        'acquireFileLockSync',
        'acquireFileLock',
        'canReclaimFileLock',
        'inspectFileLockState',
        'inspectHistoricalDirectLegacyLockIntent',
        'withFileLockSync',
        'withFileLock'
    ]) {
        assert.equal(
            engine[symbol],
            fileLock[symbol],
            `analysis-engine.js must re-export exact ${symbol} from scripts/lib/file-lock.js`
        );
    }

    const deadChild = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    assert.equal(deadChild.status, 0);
    const deadPid = Number(deadChild.stdout);
    assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');

    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'arch-file-lock-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const makeStaleLock = (targetPath, ownerOverrides = {}) => {
        const lockPath = `${targetPath}.lock`;
        fs.mkdirSync(lockPath, { mode: 0o700 });
        fs.chmodSync(lockPath, 0o700);
        const ownerPath = path.join(lockPath, 'owner.json');
        const owner = {
            pid: deadPid,
            hostname: os.hostname(),
            token: crypto.randomUUID(),
            acquiredAt: new Date(Date.now() - 60_000).toISOString(),
            ...ownerOverrides
        };
        fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
        fs.chmodSync(ownerPath, 0o600);
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(ownerPath, old, old);
        return { lockPath, ownerPath, owner };
    };

    // 1) papers-backup.js shares full stale-lock reclaim & holder diagnostics via file-lock.js
    const sourcePath = path.join(tmpDir, 'papers.json');
    const archiveDir = path.join(tmpDir, 'archive');
    fs.writeFileSync(sourcePath, JSON.stringify({
        generation: 1,
        papers: { '2611.99999': { arxivId: '2611.99999v1', title: 'Stale Lock Reclaim Backup Test' } }
    }), 'utf8');
    const staleBackupLock = makeStaleLock(sourcePath);
    const backedUp = await papersBackup.backupPapersJson(sourcePath, archiveDir, {
        date: '2026-11-27',
        lockOptions: { timeoutMs: 1000, staleMs: 1000 }
    });
    assert.equal(backedUp.backedUp, true);
    assert.equal(fs.existsSync(staleBackupLock.lockPath), false, 'stale papers.json.lock must be reclaimed and released');

    // Live lock held by analysis-engine blocks backupPapersJson with full holder diagnostics
    const releaseLive = engine.acquireFileLockSync(sourcePath);
    try {
        await assert.rejects(
            papersBackup.backupPapersJson(sourcePath, archiveDir, {
                date: '2026-11-28',
                lockOptions: { timeoutMs: 40, staleMs: 60_000 }
            }),
            error => {
                assert.match(error.message, /等待文件锁超时/);
                assert.match(error.message, new RegExp(`持有人 pid=${process.pid}\\b`));
                assert.match(error.message, /host=.*token=[a-f0-9]{8} acquiredAt=/);
                return true;
            }
        );
    } finally {
        assert.equal(releaseLive(), true);
    }

    // 2) Concurrent .reclaiming.json guard prevents clobbering an active reclaim
    const guardedTarget = path.join(tmpDir, 'guarded.json');
    const guarded = makeStaleLock(guardedTarget);
    const markerPath = path.join(guarded.lockPath, '.reclaiming.json');
    fs.writeFileSync(markerPath, JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        token: crypto.randomUUID(),
        acquiredAt: new Date().toISOString()
    }), { mode: 0o600 });
    fs.chmodSync(markerPath, 0o600);
    assert.equal(fileLock.reclaimFileLockIfSame(guarded.lockPath, 1000), false);
    assert.throws(
        () => fileLock.acquireFileLockSync(guardedTarget, { timeoutMs: 40, staleMs: 1000 }),
        /等待文件锁超时/
    );
    assert.equal(fs.existsSync(guarded.ownerPath), true, 'active .reclaiming.json must protect owner.json');
    assert.equal(fs.existsSync(markerPath), true, 'active .reclaiming.json must not be deleted');

    // A stale dead-owner .reclaiming.json marker is safely reclaimed and replaced by a hardened 0700/0600 lock
    fs.writeFileSync(markerPath, JSON.stringify({
        pid: deadPid,
        hostname: os.hostname(),
        token: crypto.randomUUID(),
        acquiredAt: new Date(Date.now() - 60_000).toISOString()
    }), { mode: 0o600 });
    fs.chmodSync(markerPath, 0o600);
    const oldMarkerTime = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, oldMarkerTime, oldMarkerTime);
    const releaseGuarded = fileLock.acquireFileLockSync(guardedTarget, { timeoutMs: 500, staleMs: 1000 });
    assert.equal(fs.statSync(guarded.lockPath).mode & 0o777, 0o700);
    assert.equal(fs.statSync(guarded.ownerPath).mode & 0o777, 0o600);
    assert.equal(releaseGuarded(), true);
    assert.equal(fs.existsSync(guarded.lockPath), false);

    // 3) Concurrent waiters contending for a single stale lock serialize cleanly
    const raceTarget = path.join(tmpDir, 'race.json');
    const raceLock = makeStaleLock(raceTarget);
    let active = 0;
    let maxConcurrent = 0;
    await Promise.all([1, 2, 3].map(() => fileLock.withFileLock(raceTarget, async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
    }, { timeoutMs: 1500, staleMs: 1000 })));
    assert.equal(maxConcurrent, 1);
    assert.equal(fs.existsSync(raceLock.lockPath), false);

    // 4) O_NOFOLLOW / symlink rejection: symlinked lock dir or owner.json is never reclaimed or deleted
    const realTargetDir = path.join(tmpDir, 'real-dir');
    fs.mkdirSync(realTargetDir, { mode: 0o700 });
    const symlinkLockTarget = path.join(tmpDir, 'symlink-lock.json');
    fs.symlinkSync(realTargetDir, `${symlinkLockTarget}.lock`);
    const symlinkLockSnap = fileLock.readFileLockSnapshot(`${symlinkLockTarget}.lock`);
    assert.equal(symlinkLockSnap.consistent, false);
    assert.equal(symlinkLockSnap.reason, 'unsafe_lock_path');
    assert.equal(fileLock.reclaimFileLockIfSame(`${symlinkLockTarget}.lock`, 1), false);
    assert.equal(fs.existsSync(realTargetDir), true);

    const symlinkOwnerTarget = path.join(tmpDir, 'symlink-owner.json');
    const symlinkOwnerLock = `${symlinkOwnerTarget}.lock`;
    fs.mkdirSync(symlinkOwnerLock, { mode: 0o700 });
    const decoyOwner = path.join(tmpDir, 'decoy-owner.json');
    fs.writeFileSync(decoyOwner, JSON.stringify({
        pid: deadPid, hostname: os.hostname(), token: crypto.randomUUID(), acquiredAt: new Date(Date.now() - 60_000).toISOString()
    }), { mode: 0o600 });
    fs.symlinkSync(decoyOwner, path.join(symlinkOwnerLock, 'owner.json'));
    const symlinkOwnerSnap = fileLock.readFileLockSnapshot(symlinkOwnerLock);
    assert.equal(symlinkOwnerSnap.consistent, false);
    assert.equal(symlinkOwnerSnap.reason, 'unsafe_owner');
    assert.equal(fileLock.reclaimFileLockIfSame(symlinkOwnerLock, 1), false);
    assert.equal(fs.existsSync(decoyOwner), true);
});

test('Reader recovery modules no longer define or call useModule() circular shims', () => {
    for (const rel of [
        'scripts/lib/reader-parent-recovery.js',
        'scripts/lib/explicit-reader-retry-round.js'
    ]) {
        const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        assert.equal(/\buseModule\s*\(/.test(source), false, `${rel} must not use useModule() shims`);
    }
});

test('physical-request-hook roundtrip: no-op when unregistered, forwards calls/errors, and integrates with explicit-reader-retry-round', () => {
    const hook = require('../scripts/lib/physical-request-hook.js');
    const previous = hook.getPhysicalRequestConsumer();
    try {
        hook.registerPhysicalRequestConsumer(null);
        assert.equal(hook.getPhysicalRequestConsumer(), null);
        assert.equal(hook.consumePhysicalRequest({ max_tokens: 10 }, { usageContext: { stage: 'test' } }), undefined);
        assert.throws(() => hook.registerPhysicalRequestConsumer('invalid'), TypeError);

        const observed = [];
        const returned = hook.registerPhysicalRequestConsumer((body, options) => {
            observed.push({ body, options });
            return 'consumed';
        });
        assert.equal(returned, null);
        assert.equal(
            hook.consumePhysicalRequest({ max_tokens: 123 }, { usageContext: { stage: 'apiReaderRepair' } }),
            'consumed'
        );
        assert.deepEqual(observed, [{
            body: { max_tokens: 123 },
            options: { usageContext: { stage: 'apiReaderRepair' } }
        }]);

        hook.registerPhysicalRequestConsumer(() => {
            throw new Error('budget-blocked');
        });
        assert.throws(() => hook.consumePhysicalRequest({}, {}), /budget-blocked/);
    } finally {
        hook.registerPhysicalRequestConsumer(previous);
    }

    // Loading explicit-reader-retry-round registers its consumer and honors module.exports monkey-patching.
    const retry = require('../scripts/lib/explicit-reader-retry-round.js');
    assert.equal(typeof hook.getPhysicalRequestConsumer(), 'function');
    const origConsume = retry.consumePhysicalRequest;
    const intercepted = [];
    retry.consumePhysicalRequest = (body, options) => {
        intercepted.push({ body, options });
        return origConsume(body, options);
    };
    try {
        hook.consumePhysicalRequest({ max_tokens: 50 }, { usageContext: { stage: 'apiReaderArticle' } });
        assert.equal(intercepted.length, 1);
        assert.equal(intercepted[0].body.max_tokens, 50);
    } finally {
        retry.consumePhysicalRequest = origConsume;
    }
});

test('backupPapersJson parity across utils.js, digest-status.js, and papers-backup.js', async () => {
    const utils = require('../scripts/utils.js');
    const digestStatus = require('../scripts/digest-status.js');
    const papersBackup = require('../scripts/lib/papers-backup.js');

    assert.equal(digestStatus.backupPapersJson, papersBackup.backupPapersJson);
    assert.equal(digestStatus.verifyPapersBackup, papersBackup.verifyPapersBackup);
    assert.equal(digestStatus.listValidManagedBackupGroups, papersBackup.listValidManagedBackupGroups);
    assert.equal(digestStatus.pruneManagedBackupGroups, papersBackup.pruneManagedBackupGroups);
    assert.equal(digestStatus.PAPERS_BACKUP_CONTRACT, papersBackup.PAPERS_BACKUP_CONTRACT);
    assert.equal(digestStatus.PAPERS_BACKUP_MAX_RAW_BYTES, papersBackup.PAPERS_BACKUP_MAX_RAW_BYTES);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-papers-backup-'));
    try {
        const sourcePath = path.join(tmpDir, 'papers.json');
        const archiveViaUtils = path.join(tmpDir, 'archive-utils');
        const archiveViaDigest = path.join(tmpDir, 'archive-digest');
        const payload = {
            generation: 2,
            papers: {
                '2611.00001': { arxivId: '2611.00001v1', title: 'Leaf Backup Parity Test' }
            }
        };
        fs.writeFileSync(sourcePath, JSON.stringify(payload), 'utf8');

        const viaUtils = await utils.backupPapersJson(sourcePath, archiveViaUtils, {
            date: '2026-11-27',
            createdAt: '2026-11-27T10:00:00+08:00'
        });
        const viaDigest = await digestStatus.backupPapersJson(sourcePath, archiveViaDigest, {
            date: '2026-11-27',
            createdAt: '2026-11-27T10:00:00+08:00'
        });

        assert.equal(viaUtils.backedUp, true);
        assert.equal(viaDigest.backedUp, true);
        assert.equal(viaUtils.sourceSha256, viaDigest.sourceSha256);

        const verifiedUtils = await papersBackup.verifyPapersBackup(viaUtils.backupPath);
        const verifiedDigest = await digestStatus.verifyPapersBackup(viaDigest.backupPath);
        assert.deepEqual(verifiedUtils.data, payload);
        assert.deepEqual(verifiedDigest.data, payload);

        // Deduplication on subsequent day via utils.backupPapersJson matches digest-status behavior.
        const dupUtils = await utils.backupPapersJson(sourcePath, archiveViaUtils, { date: '2026-11-28' });
        assert.equal(dupUtils.backedUp, false);
        assert.equal(dupUtils.duplicateOf, viaUtils.backupPath);

        // Missing file returns consistent no-op object.
        const missing = await utils.backupPapersJson(path.join(tmpDir, 'missing.json'), archiveViaUtils);
        assert.equal(missing.backedUp, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('hashDraft / shaText parity between reader-draft-hash.js and reader-repair.js and fingerprint tracking', () => {
    const draftHash = require('../scripts/lib/reader-draft-hash.js');
    const readerRepair = require('../scripts/lib/reader-repair.js');
    const fingerprint = require('../scripts/lib/reader-implementation-fingerprint.js');

    assert.equal(readerRepair.hashDraft, draftHash.hashDraft);
    assert.equal(readerRepair.shaText, draftHash.shaText);

    const sample = { version: 3, readerTitle: '测试标题', sections: [{ kind: 'background', heading: '背景', body: '正文' }] };
    const expectedDraftSha = crypto.createHash('sha256').update(JSON.stringify(sample)).digest('hex');
    const expectedTextSha = crypto.createHash('sha256').update('hello-audio-workbench').digest('hex');

    assert.equal(draftHash.hashDraft(sample), expectedDraftSha);
    assert.equal(readerRepair.hashDraft(sample), expectedDraftSha);
    assert.equal(draftHash.shaText('hello-audio-workbench'), expectedTextSha);
    assert.equal(readerRepair.shaText('hello-audio-workbench'), expectedTextSha);
    assert.equal(draftHash.shaBytes(Buffer.from('hello-audio-workbench')), expectedTextSha);
    assert.equal(draftHash.sameDraftHash(sample, structuredClone(sample)), true);
    assert.equal(draftHash.sameDraftHash(sample, { ...sample, version: 4 }), false);

    // Ensure new Reader core leaves are tracked by reader-implementation-fingerprint.js
    assert.ok(fingerprint.PARSER_CORE_FILES.includes('lib/physical-request-hook.js'));
    assert.ok(fingerprint.PARSER_CORE_FILES.includes('lib/reader-draft-hash.js'));
});
