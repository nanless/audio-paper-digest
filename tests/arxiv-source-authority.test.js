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

test('预演只校验直连身份和名称，不联网也不写文件', async t => {
    const parent = fixture(t); const root = path.join(parent, 'missing-authority-root'); let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    const result = await api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001.json' });
    assert.equal(result.status, 'dry-run'); assert.equal(calls, 0); assert.equal(fs.existsSync(root), false);
    assert.throws(() => api.namesFor('../escape.json', '2601.00001'), /safe direct/);
    assert.throws(() => api.identityFor('2601.00001v2'), /versionless/);
});

test('实际执行保留请求、来源、快照、凭证和授权，恢复时不重新抓取', async t => {
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

test('请求落盘之后才能续跑，来源证据不完整或变了就拒绝', async t => {
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

test('来源配对不完整时直接失败，生成的字段和来源别名一律拒绝', async t => {
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

test('命令行只接受显式模式、归一化 ID 和直连授权名称', async t => {
    const root = fixture(t);
    assert.throws(() => cli.parseArgs(['--apply', '--id', '2601.00001v2', '--authority', 'arxiv-2601.00001.json']), /versionless/);
    const output = await cli.main(['--dry-run', '--id', '2601.00001', '--authority', 'arxiv-2601.00001.json'],
        { files: { paperSourceAuthorityDir: root } });
    assert.equal(output.status, 'dry-run'); assert.equal(output.productionAuthorized, false);
});

test('来源锁用不透明的精确持有者释放，拒绝 ABA 式替换', t => {
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

test('过期的空锁、无效锁和远端锁可以精确恢复，但新鲜的或多余的证据一律失败', t => {
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

test('过期的本地存活或 EPERM 持有者绝不回收，只有 ESRCH 才允许接管', t => {
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

test('回收 CAS 与最终删除之间有心跳时，保留续期后的锁', t => {
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

test('持有者写入不完整时只删掉自己那份半成品，不留下被占用的锁', t => {
    const root = fixture(t); let calls = 0;
    const io = { ...fs, writeSync(fd, buffer, offset, length, position) {
        calls += 1;
        if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(8, length), position);
        const error = new Error('injected lock EIO'); error.code = 'EIO'; throw error;
    } };
    assert.throws(() => api.acquireLock(root, '2601.00001', { io }), /injected lock EIO/);
    assert.equal(fs.existsSync(lockPath(root)), false);
});

test('两个过期回收者串行执行；默认 SIGTERM 只释放胜出的那把锁', async t => {
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

test('来源锁的信号清理会保留调用方自己装的 SIGTERM 处理器', async t => {
    const root = fixture(t); const marker = path.join(root, 'caller-signal-handler');
    const holder = spawnLockHolder(root, '2601.00001', marker);
    t.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
    await holder.ready; holder.child.kill('SIGTERM'); const [code, signal] = await once(holder.child, 'exit');
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'handled');
    assert.equal(fs.existsSync(lockPath(root)), false);
});

test('调用方装了处理器时，SIGTERM 会保留进行中的抓取锁，并禁止信号之后再写入', async t => {
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


test('来源名称必须绑定完整 arXiv ID，错误名称在预演和创建目录前拒绝', async t => {
    const parent = fixture(t); let calls = 0;
    mockOfficialFetcher(t, async id => { calls++; return source(id); });
    for (const apply of [false, true]) {
        for (const arxivId of ['2601.1234', '2601', '2601.12345v2']) {
            const root = path.join(parent, `missing-${apply}-${arxivId}`);
            await assert.rejects(api.prepareArxivSourceAuthority({
                authorityRoot: root, arxivId, authorityName: 'arxiv-2601.12345.json', apply
            }), /safe direct/);
            assert.equal(fs.existsSync(root), false);
        }
    }
    assert.equal(calls, 0);
    for (const arxivId of ['2601.1234', '2601.12345']) {
        for (const suffix of ['', '-revision-2']) {
            const result = await api.prepareArxivSourceAuthority({
                authorityRoot: path.join(parent, 'still-missing'), arxivId,
                authorityName: `arxiv-${arxivId}${suffix}.json`
            });
            assert.equal(result.status, 'dry-run');
            assert.equal(result.paperId, `arxiv:${arxivId}`);
        }
    }
});

test('来源各不可变文件短写不留下正式半截文件，配对记录允许无网络补齐', async t => {
    const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const pairName = '.arxiv-2601.00001.source-pair.json';
    for (const targetName of [...Object.values(names), pairName]) {
        const root = fixture(t); let calls = 0;
        const originalFetcher = deep.fetchArxivTextDetailedUncached;
        deep.fetchArxivTextDetailedUncached = async id => { calls++; return source(id); };
        const originalOpen = fs.openSync;
        const originalWrite = fs.writeFileSync;
        const descriptors = new Map(); let injected = false;
        const opened = t.mock.method(fs, 'openSync', (filename, ...args) => {
            const fd = originalOpen(filename, ...args);
            descriptors.set(fd, String(filename)); return fd;
        });
        const written = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...args) => {
            const filename = descriptors.get(fd);
            if (!injected && typeof fd === 'number' && filename
                && (path.basename(filename) === targetName || path.basename(filename).startsWith(`.${targetName}.`))) {
                injected = true;
                fs.writeSync(fd, Buffer.from(bytes), 0, 3, 0);
                throw Object.assign(new Error('测试来源文件短写'), { code: 'EIO' });
            }
            return originalWrite(fd, bytes, ...args);
        });
        const options = { authorityRoot: root, arxivId: '2601.00001', authorityName: names.authorityName,
            apply: true, now: stamp, operationId };
        try {
            await assert.rejects(api.prepareArxivSourceAuthority(options), /测试来源文件短写/);
        } finally { opened.mock.restore(); written.mock.restore(); }
        assert.equal(injected, true, targetName);
        assert.equal(fs.existsSync(path.join(root, targetName)), false, targetName);
        const beforeRetry = calls;
        if (fs.existsSync(path.join(root, pairName))) {
            deep.fetchArxivTextDetailedUncached = async () => { throw new Error('封存配对后不应重新抓取'); };
        }
        try {
            const result = await api.prepareArxivSourceAuthority(options);
            assert.equal(result.status, 'created');
            assert.equal(authorityApi.authorityHandleSnapshot(result.authorityHandle).fulltextSha256,
                crypto.createHash('sha256').update(source().text).digest('hex'));
            if (beforeRetry === 1 && targetName !== pairName) assert.equal(calls, 1);
        } finally { deep.fetchArxivTextDetailedUncached = originalFetcher; }
    }
});

test('来源配对写入后被终止，公开入口恢复全部已知双链接并补齐原文件', async t => {
    const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const pairName = '.arxiv-2601.00001.source-pair.json';
    for (const targetName of [names.requestName, pairName, names.observationName, names.fulltextName,
        names.snapshotName, names.receiptName, names.authorityName]) {
        const root = fixture(t);
        const options = { authorityRoot: root, arxivId: '2601.00001', authorityName: names.authorityName,
            apply: true, now: stamp, operationId };
        const script = `
            const fs = require('node:fs');
            const api = require(process.argv[1]);
            const deep = require(process.argv[2]);
            deep.fetchArxivTextDetailedUncached = async () => (${JSON.stringify(source())});
            const original = fs.linkSync;
            fs.linkSync = (from, to) => {
                original(from, to);
                if (to === process.argv[3]) process.kill(process.pid, 'SIGKILL');
            };
            api.prepareArxivSourceAuthority(${JSON.stringify(options)}).catch(error => {
                console.error(error); process.exitCode = 2;
            });
        `;
        const child = spawn(process.execPath, ['-e', script, require.resolve('../scripts/lib/arxiv-source-authority.js'),
            require.resolve('../scripts/deep-analyzer.js'), path.join(root, targetName)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', value => { stderr += value; });
        const [code, signal] = await once(child, 'exit');
        assert.equal(code, null, stderr);
        assert.equal(signal, 'SIGKILL', stderr);
        assert.equal(fs.statSync(path.join(root, targetName)).nlink, 2);
        // 仅模拟原锁租约自然到期，不改持有人身份；已退出子进程仍由生产锁自行核验。
        const old = new Date(Date.now() - api.LOCK_STALE_MS - 5000);
        fs.utimesSync(path.join(lockPath(root), 'owner.json'), old, old);
        fs.utimesSync(lockPath(root), old, old);
        const originalFetcher = deep.fetchArxivTextDetailedUncached; let calls = 0;
        deep.fetchArxivTextDetailedUncached = async () => {
            calls++;
            if (targetName !== names.requestName) throw new Error('已有来源配对不可再次抓取');
            return source();
        };
        try {
            const result = await api.prepareArxivSourceAuthority(options);
            assert.ok(['created', 'recovered'].includes(result.status));
            assert.equal(calls, targetName === names.requestName ? 1 : 0);
            assert.equal(fs.statSync(path.join(root, targetName)).nlink, 1);
            assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
            assert.equal(authorityApi.authorityHandleSnapshot(result.authorityHandle).authority.paperId, 'arxiv:2601.00001');
        } finally { deep.fetchArxivTextDetailedUncached = originalFetcher; }
    }
});

test('来源配对记录必须绑定原请求，损坏记录和竞争正式文件均保持原字节', async t => {
    const root = fixture(t); const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const options = { authorityRoot: root, arxivId: '2601.00001', authorityName: names.authorityName,
        apply: true, now: stamp, operationId };
    let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    const originalLink = fs.linkSync;
    const blocked = t.mock.method(fs, 'linkSync', (from, to) => {
        if (to === path.join(root, names.observationName)) throw Object.assign(new Error('测试配对后的中断'), { code: 'EIO' });
        return originalLink(from, to);
    });
    try { await assert.rejects(api.prepareArxivSourceAuthority(options), /测试配对后的中断/); }
    finally { blocked.mock.restore(); }
    const pairFile = path.join(root, '.arxiv-2601.00001.source-pair.json');
    const pairBytes = fs.readFileSync(pairFile);
    const pair = JSON.parse(pairBytes);
    pair.requestSha256 = '0'.repeat(64);
    delete pair.pairSha256; pair.pairSha256 = authorityApi.stableHash(pair);
    const changed = authorityApi.prettyBytes(pair);
    fs.writeFileSync(pairFile, changed);
    await assert.rejects(api.prepareArxivSourceAuthority(options), /不属于当前请求/);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(pairFile), changed);
    assert.equal(fs.existsSync(path.join(root, names.observationName)), false);
    fs.writeFileSync(pairFile, pairBytes);
    const winner = Buffer.from('其他写入者保留的完整字节');
    const competitor = t.mock.method(fs, 'linkSync', (from, to) => {
        if (to === path.join(root, names.observationName)) fs.writeFileSync(to, winner, { flag: 'wx', mode: 0o600 });
        return originalLink(from, to);
    });
    try { await assert.rejects(api.prepareArxivSourceAuthority(options), /不可变文件/); }
    finally { competitor.mock.restore(); }
    assert.deepEqual(fs.readFileSync(path.join(root, names.observationName)), winner);
    assert.deepEqual(fs.readFileSync(pairFile), pairBytes);
    assert.equal(calls, 1);
});
