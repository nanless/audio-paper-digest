'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const api = require('../scripts/lib/historical-direct-publication.js');
const apiFile = require.resolve('../scripts/lib/historical-direct-publication.js');
const projectRoot = path.resolve(__dirname, '..');

function fixture(t) {
    const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-blog-lock-'));
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
    const lock = path.join(repo, '.git', '.paper-digest-locks', 'blog-publication.lock');
    return { repo, lock };
}
function runNode(repo, callback, timeoutMs = 2000) {
    return spawnSync(process.execPath, ['-e',
        `require(${JSON.stringify(apiFile)}).withBlogPublicationLock(${JSON.stringify(repo)}, ${callback}, {lockTimeoutMs:${timeoutMs}});`
    ], { cwd: projectRoot, encoding: 'utf8', timeout: 10000 });
}
function runPython(source, args) {
    return spawnSync('bash', ['scripts/python-runtime.sh', '-c', source, ...args], {
        cwd: projectRoot, encoding: 'utf8', timeout: 10000
    });
}
const pythonPrefix = 'import sys, os, subprocess\nsys.path.insert(0, sys.argv[1])\nfrom blog_repository_lock import shared_blog_repository_lock\n';

test('历史发布进程崩溃后，下一进程通过共享协议恢复锁', t => {
    const { repo, lock } = fixture(t);
    const crashed = runNode(repo, '() => process.exit(0)');
    assert.equal(crashed.status, 0, crashed.stderr);
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
    assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');
    const recovered = runNode(repo, '() => process.stdout.write("恢复成功")');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.stdout, '恢复成功');
    assert.equal(fs.existsSync(lock), false);
});

test('Python 发布进程崩溃留下的锁也能由历史入口恢复', t => {
    const { repo, lock } = fixture(t);
    const crashed = runPython(pythonPrefix
        + 'with shared_blog_repository_lock(sys.argv[2]):\n    os._exit(0)\n',
    [path.join(projectRoot, 'scripts'), repo]);
    assert.equal(crashed.status, 0, crashed.stderr);
    assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true);
    const recovered = runNode(repo, '() => {}');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.existsSync(lock), false);
});

test('历史发布的活锁不能被其他历史进程抢占', t => {
    const { repo, lock } = fixture(t);
    api.withBlogPublicationLock(repo, () => {
        const before = fs.readFileSync(path.join(lock, 'owner.json'));
        const contender = runNode(repo, '() => process.stdout.write("不应执行")', 150);
        assert.notEqual(contender.status, 0);
        assert.equal(contender.stdout, '');
        assert.match(contender.stderr, /等待共享博客仓库锁超时/);
        assert.deepEqual(fs.readFileSync(path.join(lock, 'owner.json')), before);
    });
    assert.equal(fs.existsSync(lock), false);
});

test('Python 活锁和回收标记都阻止历史入口进入临界区', t => {
    const { repo, lock } = fixture(t);
    const source = pythonPrefix + 'with shared_blog_repository_lock(sys.argv[2]):\n'
        + '    result = subprocess.run([sys.argv[3], "-e", sys.argv[4]], capture_output=True, text=True)\n'
        + '    assert result.returncode != 0, result.stdout\n'
        + '    assert "等待共享博客仓库锁超时" in result.stderr, result.stderr\n';
    const held = runPython(source, [path.join(projectRoot, 'scripts'), repo, process.execPath,
        `require(${JSON.stringify(apiFile)}).withBlogPublicationLock(${JSON.stringify(repo)}, () => {throw Error('错误进入');}, {lockTimeoutMs:150});`]);
    assert.equal(held.status, 0, held.stderr);
    api.withBlogPublicationLock(repo, () => {
        fs.renameSync(lock, `${lock}.reclaim`);
        try {
            const contender = runNode(repo, '() => process.stdout.write("不应执行")', 150);
            assert.notEqual(contender.status, 0);
            assert.equal(contender.stdout, '');
            assert.match(contender.stderr, /等待共享博客仓库回收锁超时/);
        } finally { fs.renameSync(`${lock}.reclaim`, lock); }
    });
});

test('锁主文件被同字节的新 inode 替换后也拒绝删除', t => {
    const { repo, lock } = fixture(t);
    assert.throws(() => api.withBlogPublicationLock(repo, () => {
        const owner = path.join(lock, 'owner.json');
        const replacement = path.join(lock, 'replacement');
        fs.writeFileSync(replacement, fs.readFileSync(owner), { mode: 0o600 });
        fs.renameSync(replacement, owner);
    }), /文件身份发生变化/);
    assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true);
});

for (const stage of ['open', 'write', 'fsync']) {
    test(`创建锁的 ${stage} 失败只清理本次目录与文件，后续能重新获取`, t => {
        const { repo, lock } = fixture(t);
        const saved = { open: fs.openSync, write: fs.writeFileSync, fsync: fs.fsyncSync };
        let ownerFd;
        const failure = () => Object.assign(new Error(`注入 ${stage} 失败`), { code: 'EIO' });
        fs.openSync = function (filename, ...args) {
            if (filename === path.join(lock, 'owner.json')) {
                if (stage === 'open') throw failure();
                ownerFd = saved.open.call(this, filename, ...args); return ownerFd;
            }
            return saved.open.call(this, filename, ...args);
        };
        fs.writeFileSync = function (filename, ...args) {
            if (stage === 'write' && filename === ownerFd) throw failure();
            return saved.write.call(this, filename, ...args);
        };
        fs.fsyncSync = function (fd, ...args) {
            if (stage === 'fsync' && fd === ownerFd) throw failure();
            return saved.fsync.call(this, fd, ...args);
        };
        try { assert.throws(() => api.withBlogPublicationLock(repo, () => assert.fail('创建失败不得执行回调')), /注入/); }
        finally { fs.openSync = saved.open; fs.writeFileSync = saved.write; fs.fsyncSync = saved.fsync; }
        assert.equal(fs.existsSync(lock), false);
        api.withBlogPublicationLock(repo, () => {});
        assert.equal(fs.existsSync(lock), false);
    });
}

for (const change of ['owner', 'directory', 'extra-file']) {
    test(`创建失败时发现 ${change} 已变化就保留现场`, t => {
        const { repo, lock } = fixture(t); const originalFsync = fs.fsyncSync;
        let injected = false;
        fs.fsyncSync = function (...args) {
            if (!injected && fs.existsSync(path.join(lock, 'owner.json'))) {
                injected = true;
                if (change === 'directory') {
                    fs.renameSync(lock, `${lock}.original`);
                    fs.mkdirSync(lock, { mode: 0o700 });
                    fs.writeFileSync(path.join(lock, 'owner.json'), 'other owner', { mode: 0o600 });
                } else if (change === 'owner') {
                    fs.writeFileSync(path.join(lock, 'replacement'), 'other owner', { mode: 0o600 });
                    fs.renameSync(path.join(lock, 'replacement'), path.join(lock, 'owner.json'));
                } else fs.writeFileSync(path.join(lock, 'unrelated'), 'keep');
                throw Object.assign(new Error('注入持久化失败'), { code: 'ENOSPC' });
            }
            return originalFsync.apply(this, args);
        };
        try { assert.throws(() => api.withBlogPublicationLock(repo, () => {}), /不能安全清理/); }
        finally { fs.fsyncSync = originalFsync; }
        assert.equal(injected, true);
        assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true);
        if (change === 'extra-file') assert.equal(fs.readFileSync(path.join(lock, 'unrelated'), 'utf8'), 'keep');
        else assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), 'other owner');
    });
}
