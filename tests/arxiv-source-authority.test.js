'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const api = require('../scripts/lib/arxiv-source-authority.js');
const authorityApi = require('../scripts/lib/paper-source-authority.js');
const cli = require('../scripts/arxiv-source-authority.js');
const deep = require('../scripts/deep-analyzer.js');

const stamp = '2026-09-07T00:00:00.000Z';
const operationId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'arxiv-source-adapter-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function source(id = '2601.00001') {
    const text = `${'Official paper body with methods, experiments, evidence, and references. '.repeat(200)}\n`;
    const flattenedTextSha256 = crypto.createHash('sha256').update(text).digest('hex');
    const artifactBody = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    return { text, source: 'html', sourceId: id, imageInfos: [], readerAuthors: [], htmlAvailability: 'available',
        htmlAttempts: 1, warnings: [], structuredArtifacts: { ...artifactBody,
            payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') } };
}
function mockOfficialFetcher(t, implementation) {
    const original = deep.fetchArxivTextDetailedUncached;
    deep.fetchArxivTextDetailedUncached = implementation;
    t.after(() => { deep.fetchArxivTextDetailedUncached = original; });
}
function lockPath(root, id = '2601.00001') { return path.join(root, `.arxiv-${id}.lock`); }
function writeLock(root, id = '2601.00001', options = {}) {
    const target = lockPath(root, id); fs.mkdirSync(target, { mode: 0o700 });
    if (options.empty !== true) {
        if (options.invalid === true) fs.writeFileSync(path.join(target, 'owner.json'), '{"partial":', { mode: 0o600 });
        else {
            const body = { contract: api.LOCK_OWNER_CONTRACT, version: 1, arxivId: id,
                pid: options.pid || 2147483647, hostname: options.hostname || os.hostname(),
                token: operationId, startedAt: '2020-01-01T00:00:00.000Z', leaseMs: api.LOCK_STALE_MS };
            fs.writeFileSync(path.join(target, 'owner.json'), authorityApi.prettyBytes({ ...body,
                ownerSha256: authorityApi.stableHash(body) }), { mode: 0o600 });
        }
    }
    if (options.extra === true) fs.writeFileSync(path.join(target, 'extra'), 'do not delete', { mode: 0o600 });
    const when = new Date(options.stale === false ? Date.now() : Date.now() - api.LOCK_STALE_MS - 5000);
    if (fs.existsSync(path.join(target, 'owner.json'))) fs.utimesSync(path.join(target, 'owner.json'), when, when);
    fs.utimesSync(target, when, when); return target;
}
function spawnLockHolder(root, id, existingHandlerMarker = null) {
    const statements = [
        'const fs=require("node:fs"); const api=require(process.argv[1]);',
        existingHandlerMarker ? 'process.once("SIGTERM",()=>{fs.writeFileSync(process.argv[4],"handled");setTimeout(()=>process.exit(0),50);});' : '',
        'try { api.acquireLock(process.argv[2],process.argv[3]); process.stdout.write("READY\\n"); setInterval(()=>{},1000); }',
        'catch(error){process.stderr.write(error.message+"\\n");process.exit(7);}'
    ].join('');
    const child = spawn(process.execPath, ['-e', statements,
        path.join(__dirname, '..', 'scripts', 'lib', 'arxiv-source-authority.js'), root, id,
        existingHandlerMarker || ''], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY\n')) resolve(); });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('exit', (code, signal) => {
            if (!stdout.includes('READY\n')) reject(Object.assign(new Error(stderr || `exit ${code}/${signal}`), { code, signal }));
        });
    });
    return { child, ready, stderr: () => stderr };
}

test('dry-run validates direct identity/name but performs no network or writes', async t => {
    const parent = fixture(t); const root = path.join(parent, 'missing-authority-root'); let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    const result = await api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001.json' });
    assert.equal(result.status, 'dry-run'); assert.equal(calls, 0); assert.equal(fs.existsSync(root), false);
    assert.throws(() => api.namesFor('../escape.json', '2601.00001'), /safe direct/);
    assert.throws(() => api.identityFor('2601.00001v2'), /versionless/);
});

test('apply preserves request/source/snapshot/receipt/authority and recovers without refetching', async t => {
    const root = fixture(t); let calls = 0;
    mockOfficialFetcher(t, async id => { calls++; return source(id); });
    const options = { authorityRoot: root, arxivId: '2601.00001', authorityName: 'arxiv-2601.00001.json',
        apply: true, now: stamp, operationId };
    const created = await api.prepareArxivSourceAuthority(options);
    assert.equal(created.status, 'created'); assert.equal(calls, 1);
    assert.equal(authorityApi.authorityHandleSnapshot(created.authorityHandle).productionAuthorized, true);
    const liveDetails = api.readLiveProductionSourceDetails(created.authorityHandle);
    assert.equal(liveDetails.text, source().text);
    assert.deepEqual(liveDetails.imageInfos, []);
    assert.equal(liveDetails.structuredArtifacts.flattenedTextSha256,
        authorityApi.authorityHandleSnapshot(created.authorityHandle).fulltextSha256);
    for (const name of Object.values(created.artifacts)) {
        const file = path.join(root, name); assert.equal(fs.existsSync(file), true);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    const recovered = await api.prepareArxivSourceAuthority(options);
    assert.equal(recovered.status, 'recovered'); assert.equal(calls, 1);
    assert.equal(authorityApi.authorityHandleSnapshot(recovered.authorityHandle).productionAuthorized, false);
    assert.throws(() => authorityApi.replayAuthorityHandle(recovered.authorityHandle, { requireProduction: true }), /production-authorized/);
    const durableOnly = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName: options.authorityName });
    assert.equal(authorityApi.authorityHandleSnapshot(durableOnly).productionAuthorized, false);
    assert.throws(() => api.readLiveProductionSourceDetails(durableOnly), /authenticated paper source authority handle|required/);
    const live = await api.prepareArxivSourceAuthority({ ...options, requireLiveAuthorization: true });
    assert.equal(live.status, 'live-verified'); assert.equal(calls, 2);
    assert.equal(authorityApi.authorityHandleSnapshot(
        authorityApi.replayAuthorityHandle(live.authorityHandle, { requireProduction: true })).productionAuthorized, true);
});

test('recovery resumes after durable request and refuses partial or changed source evidence', async t => {
    const root = fixture(t); const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const request = api.requestFor({ arxivId: '2601.00001', authorityName: names.authorityName, operationId, now: stamp });
    fs.writeFileSync(path.join(root, names.requestName), authorityApi.prettyBytes(request), { mode: 0o600 });
    let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    await api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: names.authorityName, apply: true, now: stamp, operationId });
    assert.equal(calls, 1);
    fs.appendFileSync(path.join(root, names.fulltextName), 'tamper');
    assert.throws(() => authorityApi.loadAuthorityHandle({ authorityRoot: root,
        authorityName: names.authorityName }), /chain drifted|proof file\/SHA drifted/);
});

test('partial source pair is fail-closed and generated fields/source aliases are rejected', async t => {
    const root = fixture(t); const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const request = api.requestFor({ arxivId: '2601.00001', authorityName: names.authorityName, operationId, now: stamp });
    fs.writeFileSync(path.join(root, names.requestName), authorityApi.prettyBytes(request), { mode: 0o600 });
    fs.writeFileSync(path.join(root, names.fulltextName), 'partial', { mode: 0o600 });
    mockOfficialFetcher(t, async () => source());
    await assert.rejects(api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: names.authorityName, apply: true }), /partial source evidence/);
    assert.throws(() => api.normalizeFetchedSource({ ...source(), analysis: 'old prose' }, '2601.00001', stamp), /generated/);
    assert.throws(() => api.normalizeFetchedSource(source('2601.99999'), '2601.00001', stamp), /another paper/);
});

test('CLI accepts only explicit mode, normalized ID and direct authority name', async t => {
    const root = fixture(t);
    assert.throws(() => cli.parseArgs(['--apply', '--id', '2601.00001v2', '--authority', 'arxiv-2601.00001.json']), /versionless/);
    const output = await cli.main(['--dry-run', '--id', '2601.00001', '--authority', 'arxiv-2601.00001.json'],
        { files: { paperSourceAuthorityDir: root } });
    assert.equal(output.status, 'dry-run'); assert.equal(output.productionAuthorized, false);
});

test('source lock uses opaque exact-owner release and refuses ABA replacement', t => {
    const root = fixture(t); const target = lockPath(root);
    const first = api.acquireLock(root, '2601.00001');
    assert.throws(() => api.releaseLock(target), /authenticated source lock handle/);
    const displaced = `${target}.displaced`; fs.renameSync(target, displaced);
    const second = api.acquireLock(root, '2601.00001');
    const replacement = fs.readFileSync(path.join(target, 'owner.json'));
    assert.throws(() => api.releaseLock(first), /changed while held/);
    assert.deepEqual(fs.readFileSync(path.join(target, 'owner.json')), replacement);
    api.releaseLock(second); assert.equal(fs.existsSync(target), false);
    fs.renameSync(displaced, target); api.releaseLock(first);
});

test('stale empty/invalid/remote locks recover exactly while fresh or extra evidence fails closed', t => {
    const root = fixture(t); const id = '2601.00001';
    writeLock(root, id, { empty: true }); let handle = api.acquireLock(root, id); api.releaseLock(handle);
    writeLock(root, id, { invalid: true }); handle = api.acquireLock(root, id); api.releaseLock(handle);
    writeLock(root, id, { hostname: 'another-host.example', stale: false });
    assert.throws(() => api.acquireLock(root, id), /source operation is locked/);
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));
    writeLock(root, id, { hostname: 'another-host.example' }); handle = api.acquireLock(root, id); api.releaseLock(handle);

    writeLock(root, id, { invalid: true, stale: false });
    assert.throws(() => api.acquireLock(root, id), /source operation is locked/);
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));
    writeLock(root, id); fs.chmodSync(path.join(lockPath(root, id), 'owner.json'), 0o644);
    assert.throws(() => api.acquireLock(root, id), /permissions must be 0600/);
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));
    const linkedOwner = path.join(root, 'linked-owner.json'); fs.writeFileSync(linkedOwner, '{}', { mode: 0o600 });
    fs.mkdirSync(lockPath(root, id), { mode: 0o700 }); fs.linkSync(linkedOwner, path.join(lockPath(root, id), 'owner.json'));
    assert.throws(() => api.acquireLock(root, id), /private regular file/);
    assert.equal(fs.readFileSync(linkedOwner, 'utf8'), '{}');
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));
    fs.symlinkSync(root, lockPath(root, id), 'dir');
    assert.throws(() => api.acquireLock(root, id), /not a canonical directory/);
    fs.unlinkSync(lockPath(root, id));
    const protectedLock = writeLock(root, id, { extra: true });
    assert.throws(() => api.acquireLock(root, id), /unexpected entries/);
    assert.equal(fs.readFileSync(path.join(protectedLock, 'extra'), 'utf8'), 'do not delete');
});

test('stale local live/EPERM owners are never reclaimed and only ESRCH permits takeover', t => {
    const root = fixture(t); const id = '2601.00001';
    writeLock(root, id, { pid: process.pid });
    assert.throws(() => api.acquireLock(root, id), /source operation is locked/);
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));

    writeLock(root, id);
    const denied = new Error('not permitted'); denied.code = 'EPERM';
    assert.throws(() => api.acquireLock(root, id, {
        processKill() { throw denied; }
    }), /source operation is locked/);
    assert.equal(fs.existsSync(path.join(lockPath(root, id), 'owner.json')), true);
    fs.unlinkSync(path.join(lockPath(root, id), 'owner.json')); fs.rmdirSync(lockPath(root, id));

    writeLock(root, id);
    const gone = new Error('no such process'); gone.code = 'ESRCH';
    const handle = api.acquireLock(root, id, { processKill() { throw gone; } });
    api.releaseLock(handle);
});

test('heartbeat between reclaim CAS and final removal preserves the renewed lock', t => {
    const root = fixture(t); const id = '2601.00001'; const target = writeLock(root, id);
    let injected = 0;
    assert.throws(() => api.acquireLock(root, id, {
        beforeReclaimRemoval(_snapshot, label) {
            if (label !== 'source operation lock') return;
            injected += 1;
            const now = new Date(); fs.utimesSync(path.join(target, 'owner.json'), now, now);
        }
    }), /changed before removal|renewed/);
    assert.equal(injected, 1);
    assert.equal(fs.existsSync(path.join(target, 'owner.json')), true);
    assert.equal(fs.existsSync(`${target}.reclaim`), false);
});

test('short owner write removes only its own half-product and leaves no occupied lock', t => {
    const root = fixture(t); let calls = 0;
    const io = { ...fs, writeSync(fd, buffer, offset, length, position) {
        calls += 1;
        if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(8, length), position);
        const error = new Error('injected lock EIO'); error.code = 'EIO'; throw error;
    } };
    assert.throws(() => api.acquireLock(root, '2601.00001', { io }), /injected lock EIO/);
    assert.equal(fs.existsSync(lockPath(root)), false);
});

test('two stale reclaimers serialize; default SIGTERM releases only the winning lock', async t => {
    const root = fixture(t); const id = '2601.00001'; writeLock(root, id);
    const left = spawnLockHolder(root, id); const right = spawnLockHolder(root, id);
    t.after(() => { for (const item of [left, right]) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); });
    const settled = await Promise.allSettled([left.ready, right.ready]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
    const winner = settled[0].status === 'fulfilled' ? left : right;
    const loser = winner === left ? right : left;
    assert.match(loser.stderr(), /locked|reclaim/);
    winner.child.kill('SIGTERM'); const [code, signal] = await once(winner.child, 'exit');
    assert.equal(code, null); assert.equal(signal, 'SIGTERM');
    assert.equal(fs.existsSync(lockPath(root, id)), false);
});

test('source lock signal cleanup preserves a caller-installed SIGTERM handler', async t => {
    const root = fixture(t); const marker = path.join(root, 'caller-signal-handler');
    const holder = spawnLockHolder(root, '2601.00001', marker);
    t.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
    await holder.ready; holder.child.kill('SIGTERM'); const [code, signal] = await once(holder.child, 'exit');
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'handled');
    assert.equal(fs.existsSync(lockPath(root)), false);
});

test('SIGTERM with caller handler retains an in-flight fetch lock and forbids post-signal writes', async t => {
    const root = fixture(t); const id = '2601.00001'; const marker = path.join(root, 'signal-state');
    const modulePath = path.join(__dirname, '..', 'scripts', 'lib', 'arxiv-source-authority.js');
    const deepPath = path.join(__dirname, '..', 'scripts', 'deep-analyzer.js');
    const statements = [
        'const fs=require("node:fs"),crypto=require("node:crypto");',
        'const api=require(process.argv[1]),deep=require(process.argv[2]);',
        'const root=process.argv[3],id=process.argv[4],marker=process.argv[5];',
        'const lock=root+"/.arxiv-"+id+".lock";',
        'process.once("SIGTERM",()=>fs.writeFileSync(marker,fs.existsSync(lock)?"held":"released"));',
        'deep.fetchArxivTextDetailedUncached=async()=>{process.stdout.write("READY\\n");await new Promise(r=>setTimeout(r,150));',
        'const text="Official methods experiments evidence references. ".repeat(300);',
        'const flat=crypto.createHash("sha256").update(text).digest("hex");',
        'const body={version:1,source:"arxiv_html",tables:[],formulas:[],flattenedTextSha256:flat};',
        'return {text,source:"html",sourceId:id,imageInfos:[],readerAuthors:[],htmlAvailability:"available",',
        'htmlAttempts:1,warnings:[],structuredArtifacts:{...body,payloadSha256:crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}}};',
        'api.prepareArxivSourceAuthority({authorityRoot:root,arxivId:id,authorityName:"arxiv-"+id+".json",apply:true})',
        '.then(()=>process.exit(8)).catch(error=>{fs.appendFileSync(marker,"|"+error.message+"|"+(fs.existsSync(lock)?"locked":"unlocked"));process.exit(0);});'
    ].join('');
    const child = spawn(process.execPath, ['-e', statements, modulePath, deepPath, root, id, marker],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 2000);
        child.stdout.on('data', () => { if (stdout.includes('READY\n')) { clearTimeout(timeout); resolve(); } });
        child.once('exit', code => { if (!stdout.includes('READY\n')) { clearTimeout(timeout); reject(new Error(`early exit ${code}: ${stderr}`)); } });
    });
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
    const state = fs.readFileSync(marker, 'utf8');
    assert.match(state, /^held\|.*stopping after process signal\|unlocked$/);
    assert.equal(fs.existsSync(lockPath(root, id)), false);
    assert.equal(fs.existsSync(path.join(root, `arxiv-${id}-observation.json`)), false);
    assert.equal(fs.existsSync(path.join(root, `arxiv-${id}-fulltext.txt`)), false);
});
