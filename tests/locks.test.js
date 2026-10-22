'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const locks = require('../scripts/locks');
const { buildChildProcessEnv, requireExternalRuntime } = require('../scripts/env-loader');
requireExternalRuntime('locks.test.js');

function makeRoot(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
    for (const [relative, content] of entries) {
        const target = path.join(root, 'data/runtime', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(content));
    }
    return root;
}

test('识别目录锁 owner.json 与普通锁文件，跳过 .hugo_build.lock', () => {
    const root = makeRoot([
        ['run.lock/owner.json', { pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }],
        ['old.lock/owner.json', { pid: 999999, hostname: os.hostname(), acquiredAt: '2026-01-01T00:00:00Z' }],
        ['plain.lock', { pid: process.pid, hostname: os.hostname() }],
        ['.hugo_build.lock', { pid: 1 }]
    ]);
    try {
        const rows = locks.scanLocks(['data/runtime'], Date.now(), { root });
        const files = rows.map(row => row.file);
        assert.ok(files.includes(path.join('data/runtime', 'run.lock')));
        assert.ok(files.includes(path.join('data/runtime', 'plain.lock')));
        assert.ok(!files.some(file => file.includes('.hugo_build.lock')));
        const dead = rows.find(row => row.file.includes('old.lock'));
        assert.strictEqual(dead.alive, false);
        assert.strictEqual(dead.stale, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('扫描 conference-processes 嵌套 .operation.lock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-nested-'));
    const nested = path.join(root, 'data/runtime/conference-processes/p1/.operation.lock');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'owner.json'), JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAt: '2026-01-01T00:00:00Z' }));
    try {
        const rows = locks.scanLocks(['data/runtime'], Date.now(), { root });
        assert.strictEqual(rows.length, 1);
        assert.ok(rows[0].file.includes('.operation.lock'));
        assert.strictEqual(rows[0].stale, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('远端 hostname 不按本地 PID 判死', () => {
    const root = makeRoot([['remote.lock/owner.json', { pid: 999999, hostname: 'other-host', acquiredAt: new Date().toISOString() }]]);
    try {
        const rows = locks.scanLocks(['data/runtime'], Date.now(), { root });
        assert.strictEqual(rows[0].alive, null);
        assert.strictEqual(rows[0].stale, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function cliFixture(t, { worktree = false, withLock = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locks-cli-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['scripts/locks.js', 'scripts/env-loader.js', 'scripts/lib/env-schema.js']) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, '..', name), path.join(root, name));
    }
    fs.mkdirSync(path.join(root, 'data/runtime'), { recursive: true });
    const env = { ...buildChildProcessEnv(), HOME: root };
    if (process.env.CODEX_SANDBOX) env.CODEX_SANDBOX = process.env.CODEX_SANDBOX;
    const git = args => {
        const result = spawnSync('git', args, { env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    const repo = path.join(root, 'blog');
    git(['init', '-q', repo]);
    const common = git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const lock = path.join(common, '.paper-digest-locks/blog-publication.lock');
    const timestamp = '2026-01-01T00:00:00.000Z';
    if (withLock) {
        fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
            pid: 999999, hostname: os.hostname(), startedAt: timestamp, heartbeatAt: timestamp,
            token: 'owner-token-must-not-print'
        }), { mode: 0o600 });
    }
    let target = repo;
    if (worktree) {
        git(['-C', repo, '-c', 'user.name=Lock fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
        target = path.join(root, 'linked');
        git(['-C', repo, 'worktree', 'add', '-q', '-b', 'fixture-linked', target]);
        assert.equal(fs.lstatSync(path.join(target, '.git')).isFile(), true);
    }
    const configure = value => fs.writeFileSync(path.join(root, '.env'),
        `PAPER_DIGEST_BLOG_REPO=${value}\nPAPER_ANALYZER_API_KEY=env-secret-must-not-print\n`, { mode: 0o640 });
    configure(target);
    const run = (args = ['--json'], extraEnv = {}) => spawnSync(process.execPath,
        [path.join(root, 'scripts/locks.js'), ...args],
        { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 5000 });
    return { root, repo, target, common, lock, timestamp, configure, run };
}

function snapshot(root) {
    const result = [];
    const walk = directory => {
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name); const info = fs.lstatSync(file);
            result.push({ file: path.relative(root, file), mode: info.mode, mtimeMs: info.mtimeMs,
                bytes: info.isFile() ? fs.readFileSync(file).toString('base64') : null });
            if (info.isDirectory()) walk(file);
        }
    };
    walk(root); return result;
}

function jsonResult(result, status) {
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, status, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope, 'bounded-lock-observation');
    assert.doesNotMatch(result.stdout + result.stderr, /owner-token-must-not-print|env-secret-must-not-print|injected-secret/);
    return report;
}

test('真实CLI从普通checkout与linked worktree读取同一common-dir，startedAt与零写入', t => {
    const f = cliFixture(t, { worktree: true });
    const before = snapshot(f.root);
    const linked = jsonResult(f.run(), 0);
    assert.equal(linked.scanComplete, true);
    assert.equal(linked.locks.length, 1);
    const row = linked.locks[0];
    assert.equal(row.startedAt, f.timestamp);
    assert.equal(row.alive, null); assert.equal(row.stale, false); assert.equal(row.needsReview, true);
    assert.equal(path.resolve(f.root, row.file), f.lock);
    assert.deepEqual(snapshot(f.root), before);
    f.configure(f.repo);
    const mainBefore = snapshot(f.root);
    const main = jsonResult(f.run(), 0);
    assert.equal(main.locks[0].file, row.file);
    assert.deepEqual(snapshot(f.root), mainBefore);
});

test('真实CLI支持~/及相对路径，Git重定位/配置/credential污染不改变目标或泄密', t => {
    const f = cliFixture(t);
    const pollution = { GIT_DIR: '/missing/injected-secret', GIT_WORK_TREE: '/missing/injected-secret',
        GIT_COMMON_DIR: '/missing/injected-secret', GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!echo injected-secret',
        PAPER_ANALYZER_API_KEY: 'injected-secret', GIT_ASKPASS: '/missing/injected-secret',
        GH_TOKEN: 'injected-secret' };
    for (const configured of ['~/blog', 'blog']) {
        f.configure(configured); const before = snapshot(f.root);
        const report = jsonResult(f.run(['--json'], pollution), 0);
        assert.equal(report.scanComplete, true);
        assert.equal(path.resolve(f.root, report.locks[0].file), f.lock);
        assert.deepEqual(snapshot(f.root), before);
    }
});

test('JSON+recover只输出一个对象，shared锁永不进入回收预览', t => {
    const f = cliFixture(t);
    const local = path.join(f.root, 'data/runtime/old.lock');
    fs.writeFileSync(local, JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAt: f.timestamp }));
    const before = snapshot(f.root);
    const report = jsonResult(f.run(['--json', '--recover']), 0);
    assert.equal(report.recoveryPreview.requested, true);
    assert.equal(report.recoveryPreview.deleted, false);
    assert.deepEqual(report.recoveryPreview.candidates, ['data/runtime/old.lock']);
    assert.equal(report.locks.find(row => row.kind === 'shared-blog').stale, false);
    assert.deepEqual(snapshot(f.root), before);
});

test('已定位Git但锁根未创建可完整报告，不创建目录；空预览也是纯JSON', t => {
    const f = cliFixture(t, { withLock: false });
    const before = snapshot(f.root);
    const report = jsonResult(f.run(['--json', '--recover']), 0);
    assert.equal(report.scanComplete, true);
    assert.deepEqual(report.locks, []);
    assert.deepEqual(report.recoveryPreview.candidates, []);
    assert.equal(report.scopes.find(item => item.scope === 'shared-blog').status, 'not_present');
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(fs.existsSync(path.join(f.common, '.paper-digest-locks')), false);
});

test('配置缺失/坏目标使scanComplete false、partial退出1，不能假称无锁', t => {
    const f = cliFixture(t);
    for (const mode of ['missing-env', 'missing-key', 'not-git']) {
        if (mode === 'missing-env') fs.unlinkSync(path.join(f.root, '.env'));
        else if (mode === 'missing-key') fs.writeFileSync(path.join(f.root, '.env'), 'PAPER_ANALYZER_API_KEY=env-secret-must-not-print');
        else f.configure(f.root);
        const before = snapshot(f.root);
        const report = jsonResult(f.run(), 1);
        assert.equal(report.scanComplete, false);
        assert.ok(report.problems.some(item => item.scope === 'shared-blog'));
        assert.deepEqual(snapshot(f.root), before);
        const plain = f.run([]);
        assert.equal(plain.status, 1);
        assert.match(plain.stdout, /不完整/);
        assert.doesNotMatch(plain.stdout, /未发现运行锁/);
        if (mode === 'missing-env') f.configure(f.repo);
    }
});

test('owner坏JSON/非对象/缺失与本地非目录均结构化partial并保留未知锁', t => {
    const f = cliFixture(t);
    for (const bytes of ['{secret-invalid', 'null', '[]']) {
        fs.writeFileSync(path.join(f.lock, 'owner.json'), bytes);
        const report = jsonResult(f.run(), 1);
        assert.equal(report.scanComplete, false); assert.equal(report.locks.length, 1);
        assert.equal(report.locks[0].alive, null); assert.equal(report.locks[0].stale, false);
        assert.ok(report.problems.some(item => item.operation === 'read-owner'));
        assert.doesNotMatch(JSON.stringify(report), /secret-invalid/);
    }
    fs.unlinkSync(path.join(f.lock, 'owner.json'));
    const missing = jsonResult(f.run(), 1);
    assert.equal(missing.locks.length, 1);
    fs.rmSync(path.join(f.root, 'data/runtime'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'data/runtime'), 'not-directory');
    const shape = jsonResult(f.run(), 1);
    assert.ok(shape.problems.some(item => item.scope === 'runtime'));
});

test('声明扫描范围内的嵌套目录symlink不能静默略过，坏时间保持unknown', t => {
    const f = cliFixture(t);
    const external = path.join(f.root, 'elsewhere'); fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(f.root, 'data/runtime/conference-processes'));
    const report = jsonResult(f.run(), 1);
    assert.ok(report.problems.some(item => item.scope === 'runtime' && item.code === 'UNSAFE_DIRECTORY'));
    fs.unlinkSync(path.join(f.root, 'data/runtime/conference-processes'));
    fs.writeFileSync(path.join(f.lock, 'owner.json'), JSON.stringify({ pid: process.pid,
        hostname: os.hostname(), startedAt: 'invalid', heartbeatAt: 'invalid' }));
    const badTime = jsonResult(f.run(), 1);
    assert.equal(badTime.locks[0].startedAt, null); assert.equal(badTime.locks[0].heartbeatAt, null);
    assert.equal(badTime.locks[0].alive, null); assert.equal(badTime.locks[0].stale, false);
});

test('owner symlink/超大文件/FIFO不跟随或阻塞，报告partial且不泄秘密', t => {
    const f = cliFixture(t);
    const owner = path.join(f.lock, 'owner.json');
    const outside = path.join(f.root, 'secret.json');
    fs.writeFileSync(outside, '{"token":"owner-token-must-not-print"}');
    fs.unlinkSync(owner); fs.symlinkSync(outside, owner);
    assert.equal(jsonResult(f.run(), 1).scanComplete, false);
    fs.unlinkSync(owner); fs.writeFileSync(owner, 'x'.repeat(256 * 1024));
    assert.equal(jsonResult(f.run(), 1).scanComplete, false);
    fs.unlinkSync(owner);
    const fifo = spawnSync('mkfifo', [owner], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    const before = snapshot(f.root);
    const report = jsonResult(f.run(), 1);
    assert.equal(report.scanComplete, false);
    assert.deepEqual(snapshot(f.root), before);
});

test('打开前owner被换成symlink/FIFO/另一普通文件时拒绝，不阻塞或泄露', t => {
    const f = cliFixture(t);
    const script = String.raw`
        const fs = require('node:fs'); const path = require('node:path');
        const {spawnSync} = require('node:child_process');
        const root = process.argv[1]; const mode = process.argv[2];
        const api = require(path.join(root, 'scripts/locks.js'));
        const owner = path.join(root, 'blog/.git/.paper-digest-locks/blog-publication.lock/owner.json');
        const source = path.join(root, 'replacement.json');
        fs.writeFileSync(source, JSON.stringify({token:'owner-token-must-not-print'}));
        const original = fs.openSync; let changed = false;
        fs.openSync = function(file, flags, ...args) {
            if (path.resolve(file) === owner && !changed) {
                changed = true; fs.unlinkSync(owner);
                if (mode === 'symlink') fs.symlinkSync(source, owner);
                else if (mode === 'fifo') {
                    const result = spawnSync('mkfifo', [owner]); if (result.status !== 0) throw Error('fixture');
                } else fs.copyFileSync(source, owner);
            }
            return original(file, flags, ...args);
        };
        try { console.log(JSON.stringify(api.collectLockView({root}))); }
        finally { fs.openSync = original; }
    `;
    for (const mode of ['symlink', 'fifo', 'regular']) {
        const owner = path.join(f.lock, 'owner.json');
        fs.rmSync(owner, { force: true });
        fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: f.timestamp }));
        const result = spawnSync(process.execPath, ['-e', script, f.root, mode], {
            encoding: 'utf8', timeout: 3000, env: { ...buildChildProcessEnv(), HOME: f.root }
        });
        const report = jsonResult(result, 0);
        assert.equal(report.scanComplete, false, mode);
        assert.equal(report.locks[0].pid, null, mode);
        assert.ok(report.problems.some(item => item.operation === 'read-owner'), mode);
    }
});

test('help+json与参数错误也是单JSON，退出分别0/2', t => {
    const f = cliFixture(t);
    const help = jsonResult(f.run(['--help', '--json']), 0);
    assert.equal(help.status, 'help');
    const bad = jsonResult(f.run(['--json', '--force']), 2);
    assert.equal(bad.status, 'invalid_arguments');
    assert.equal(bad.scanComplete, false);
});

test('沙箱守卫真实CLI拒绝保留明确说明，JSON单对象且不回显标记秘密', t => {
    const f = cliFixture(t);
    const before = snapshot(f.root);
    const plain = f.run([], { CODEX_SANDBOX: 'injected-secret' });
    assert.equal(plain.status, 1);
    assert.match(plain.stdout + plain.stderr, /必须在沙箱外运行/);
    assert.doesNotMatch(plain.stdout + plain.stderr, /injected-secret/);
    for (const args of [['--json'], ['--help', '--json', '--recover']]) {
        const result = f.run(args, { CODEX_SANDBOX: 'injected-secret' });
        const report = jsonResult(result, 1);
        assert.equal(report.status, 'runtime_blocked');
        assert.equal(report.scanComplete, false);
        assert.equal(report.problems[0].reason, 'sandbox_required');
        assert.match(report.problems[0].message, /必须在沙箱外运行/);
        assert.match(result.stderr, /必须在沙箱外运行/);
    }
    assert.deepEqual(snapshot(f.root), before);
});

test('其他守卫异常只给固定说明，不把任意error文本伪装成可信诊断', t => {
    const f = cliFixture(t);
    const script = String.raw`
        const path = require('node:path'); const root = process.argv[1];
        require(path.join(root, 'scripts/env-loader.js')).requireExternalRuntime = () => { throw Error('injected-secret'); };
        process.exitCode = require(path.join(root, 'scripts/locks.js')).main(['--json']);
    `;
    const before = snapshot(f.root);
    const result = spawnSync(process.execPath, ['-e', script, f.root], {
        encoding: 'utf8', timeout: 3000, env: { ...buildChildProcessEnv(), HOME: f.root }
    });
    const report = jsonResult(result, 1);
    assert.equal(report.problems[0].reason, 'runtime_guard_rejected');
    assert.match(report.problems[0].message, /运行环境检查未通过/);
    assert.doesNotMatch(result.stdout + result.stderr, /必须在沙箱外运行/);
    assert.deepEqual(snapshot(f.root), before);
});

test('详细收集显式记录IO/查询超时而旧数组API保留，Git子环境不含注入配置', t => {
    const f = cliFixture(t);
    assert.ok(Array.isArray(locks.scanLocks(['data/runtime'], Date.now(), { root: f.root })));
    assert.ok(Array.isArray(locks.sharedBlogLocks(f.root)));
    assert.deepEqual(locks.scanLocks(undefined, Date.now(), { root: path.join(f.root, 'not-created') }), []);
    assert.deepEqual(locks.sharedBlogLocks(path.join(f.root, 'not-created')), []);
    for (const result of [{ status: 1, stdout: '', stderr: 'injected-secret' },
        { status: null, error: Object.assign(new Error('injected-secret'), { code: 'ETIMEDOUT' }) },
        { status: 0, stdout: '' }]) {
        const report = locks.collectLockView({ root: f.root, spawnSync: () => result });
        assert.equal(report.scanComplete, false);
        assert.doesNotMatch(JSON.stringify(report), /injected-secret/);
    }
    const originalRead = fs.readdirSync;
    try {
        fs.readdirSync = function(file, ...args) {
            if (path.resolve(file) === path.join(f.root, 'data/runtime')) throw Object.assign(new Error('injected-secret'), { code: 'EACCES' });
            return originalRead(file, ...args);
        };
        const report = locks.collectLockView({ root: f.root });
        assert.equal(report.scanComplete, false);
        assert.ok(report.problems.some(item => item.scope === 'runtime' && item.code === 'EACCES'));
    } finally { fs.readdirSync = originalRead; }
    const pollution = { GIT_DIR: 'injected-secret', GIT_WORK_TREE: 'injected-secret', GIT_COMMON_DIR: 'injected-secret',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'injected-secret',
        GIT_ASKPASS: 'injected-secret', GH_TOKEN: 'injected-secret', PAPER_ANALYZER_API_KEY: 'injected-secret' };
    const saved = Object.fromEntries(Object.keys(pollution).map(key => [key, process.env[key]]));
    Object.assign(process.env, pollution);
    try {
        let called = false;
        const report = locks.collectLockView({ root: f.root, spawnSync(command, args, options) {
            called = true;
            assert.equal(command, 'git'); assert.ok(options.timeout > 0 && options.timeout <= 5000);
            assert.equal(options.shell, false);
            for (const key of Object.keys(pollution)) assert.equal(options.env[key], undefined, key);
            return spawnSync(command, args, options);
        } });
        assert.equal(called, true); assert.equal(report.scanComplete, true);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});
