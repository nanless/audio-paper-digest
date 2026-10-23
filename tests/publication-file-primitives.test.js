'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const api = require('../scripts/lib/publication-file-primitives.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('共享FD读取在追加缓冲前执行原大小和总限额，最多消费一个增长哨兵', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publication-bounded-fd-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'bytes'); fs.writeFileSync(filename, 'original');
    function read(expected, maximum) {
        const fd = fs.openSync(filename, 'r');
        try { return api.readBoundedFd(fd, expected, maximum); }
        finally { fs.closeSync(fd); }
    }
    assert.deepEqual(read(8, 8), Buffer.from('original'));
    const actualRead = fs.readSync; let consumed = 0;
    const patched = t.mock.method(fs, 'readSync', (...args) => {
        const count = actualRead(...args); consumed += count; return count;
    });
    assert.throws(() => read(2, 8), { code: 'BOUNDED_FILE_READ_EXCEEDED' });
    assert.equal(consumed, 3);
    consumed = 0;
    assert.throws(() => read(8, 2), { code: 'BOUNDED_FILE_READ_EXCEEDED' });
    assert.equal(consumed, 0, '已知原大小超过最大值时不得读取');
    for (const [expected, maximum] of [[true, 8], [8, false], [-1, 8], [8, Infinity]]) {
        assert.throws(() => read(expected, maximum), TypeError);
    }
    assert.equal(consumed, 0);
    patched.mock.restore();
    fs.writeFileSync(filename, ''); assert.deepEqual(read(0, 0), Buffer.alloc(0));
    fs.writeFileSync(filename, 'o'); assert.deepEqual(read(8, 8), Buffer.from('o'));
});

test('共享读取保留旧父目录替换防护，严格 JSON 拒绝重复键及非法 UTF-8', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publication-read-cas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const parent = path.join(root, 'parent'); const moved = path.join(root, 'moved');
    fs.mkdirSync(parent); const target = path.join(parent, 'record'); fs.writeFileSync(target, 'original');
    assert.throws(() => api.readRegular(target, 1024, { afterOpen: () => {
        fs.renameSync(parent, moved); fs.symlinkSync(moved, parent);
    } }), /Unsafe fresh rewrite directory|读取时文件的身份/);
    assert.equal(fs.readFileSync(path.join(moved, 'record'), 'utf8'), 'original');
    assert.throws(() => api.strictJson(Buffer.from('{"a":1,"a":2}'), '来源记录'), /重复字段/);
    assert.throws(() => api.strictJson(Buffer.from([0xc0, 0xaf]), '来源记录'), /UTF-8/);
});

test('共享不可变写拒绝末端及父级符号链接，保留原文件', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publication-write-path-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = path.join(root, 'original'); fs.writeFileSync(outside, 'original');
    const safe = path.join(root, 'safe'); fs.mkdirSync(safe);
    const leaf = path.join(safe, 'leaf'); fs.symlinkSync(outside, leaf);
    assert.throws(() => api.writeExact(leaf, Buffer.from('new')), /普通单链接文件/);
    const parent = path.join(root, 'alias'); fs.symlinkSync(safe, parent);
    assert.throws(() => api.writeExact(path.join(parent, 'child'), Buffer.from('new')), /Unsafe fresh rewrite directory/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(safe, 'child')), false);
});


test('原子不可变写入会清掉失败的临时文件，绝不占用目标路径', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'artifact.json'); let writes = 0;
    const originalWrite = fs.writeSync;
    const writeMock = t.mock.method(fs, 'writeSync', (...args) => {
        writes += 1;
        if (writes === 1) return originalWrite(args[0], args[1], args[2], Math.min(3, args[3]), args[4]);
        const error = new Error('injected EIO');
        error.code = 'EIO';
        throw error;
    });
    assert.throws(() => api.writeExact(target, Buffer.from('complete immutable payload')), /injected EIO/);
    writeMock.mock.restore();
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(root), []);
    api.writeExact(target, Buffer.from('complete immutable payload'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'complete immutable payload');
    assert.throws(() => api.writeExact(target, Buffer.from('different')), /拒绝覆盖/);
});

test('git blob 查询区分路径不存在和 Git 出错', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'hugo.yaml'), 'baseURL: https://example.test/\n');
    execFileSync('git', ['-C', root, 'add', 'hugo.yaml']); execFileSync('git', ['-C', root, 'commit', '-m', 'fixture']);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(api.defaultGitBlob(root, head, 'content/posts/missing.md'), null);
    assert.throws(() => api.defaultGitBlob(root, 'f'.repeat(40), 'content/posts/missing.md'), /Git 命令 ls-tree 执行失败/);
    assert.throws(() => api.defaultGitBlob(path.join(root, 'absent'), head, 'content/posts/missing.md'), /Git 命令 ls-tree 执行失败/);
});

test('真实博客快照绑定干净的 main、tree、Hugo 配置、远端身份和远端 OID', t => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-remote-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, 'blog'); const remote = path.join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', remote]); execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'hugo.yaml'), 'baseURL: https://example.test/\n');
    fs.mkdirSync(path.join(repo, 'content', 'posts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'content', 'posts', 'fixture.md'), 'fixture\n');
    execFileSync('git', ['-C', repo, 'add', 'hugo.yaml', 'content/posts/fixture.md']); execFileSync('git', ['-C', repo, 'commit', '-m', 'fixture']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]); execFileSync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
    const state = api.defaultBlogState(repo);
    assert.equal(state.clean, true); assert.equal(state.branch, 'main'); assert.equal(state.remoteOid, state.head);
    assert.equal(state.treeOid, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
    assert.equal(state.contentTreeOid, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD:content/posts'], { encoding: 'utf8' }).trim());
    assert.equal(state.hugoConfig.sha256, sha(fs.readFileSync(path.join(repo, 'hugo.yaml'))));
});
