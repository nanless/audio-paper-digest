'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { runGitProcess } = require('../scripts/lib/publication-git-process.js');
const primitives = require('../scripts/lib/publication-file-primitives.js');
const publication = require('../scripts/lib/historical-direct-publication.js');
const oid = 'a'.repeat(40);
const normal = (stdout = '', status = 0) => ({ stdout, stderr: '', status, signal: null });

test('Git 内核保留完整普通非零退出；拒绝 error/status0、信号、无状态和超限前缀', t => {
    const mocked = t.mock.method(child, 'spawnSync', () => normal(' complete\n', 1));
    const result = runGitProcess('/unused', ['status'], { env: { LANG: 'C' } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ' complete\n');
    for (const failure of [
        { ...normal(oid), error: Object.assign(new Error('secret remote'), { code: 'ETIMEDOUT' }) },
        { ...normal(oid), error: Object.assign(new Error('secret remote'), { code: 'ENOBUFS' }) },
        { ...normal(oid), error: Object.assign(new Error('secret remote'), { code: 'ENOENT' }) },
        { ...normal(oid), signal: 'SIGTERM' }, { ...normal(oid), status: null },
        { ...normal(oid), status: -1 }, normal('x'.repeat(65))
    ]) {
        mocked.mock.mockImplementation(() => failure);
        assert.throws(() => runGitProcess('/unused', ['push'], { maxBuffer: 64 }), error =>
            /未完整正常退出/.test(error.message) && !error.message.includes('secret'));
    }
    mocked.mock.mockImplementation(() => { throw new Error('secret startup'); });
    assert.throws(() => runGitProcess('/unused', ['status']), /无法启动/);
});

test('Git 内核真实短超时和输出超限都不能返回可用前缀', t => {
    if (process.platform === 'win32') return t.skip('该构造 Git 可执行文件使用 POSIX shebang');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bounded-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = path.join(root, 'git');
    fs.writeFileSync(git, `#!${process.execPath}\nif (process.argv.includes('slow')) setTimeout(() => process.stdout.write('late'), 10000); else process.stdout.write('a'.repeat(1024 * 1024));\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: root };
    const started = Date.now();
    assert.throws(() => runGitProcess(root, ['slow'], { env, timeoutMs: 80 }), /未完整正常退出/);
    assert.ok(Date.now() - started < 5000);
    assert.throws(() => runGitProcess(root, ['large'], { env, maxBuffer: 64, timeoutMs: 2000 }), /未完整正常退出/);
});

test('两个原适配器保留 binary 字节、trim、环境差异及 local/network 时间配置', t => {
    const bytes = Buffer.from([0x89, 0x50, 0, 0x0d, 0x0a, 0xff]);
    const calls = [];
    const mocked = t.mock.method(child, 'spawnSync', (program, args, options) => {
        calls.push({ program, args, options });
        if (args[2] === 'ls-tree') return normal(Buffer.from(`100644 blob ${oid}\tfile.png\0`));
        if (args[2] === 'cat-file') return normal(bytes);
        if (args[2] === 'remote') return normal(' https://example.invalid/repo.git\r\n');
        if (args[2] === 'ls-remote') return normal(` ${oid}\trefs/heads/main\n`);
        if (args[2] === 'branch') return normal(' main\n');
        return normal(` ${oid}\n`);
    });
    assert.deepEqual(primitives.defaultGitBlob('/unused', oid, 'file.png'), bytes);
    assert.ok(calls.slice(0, 2).every(call => call.options.encoding === null
        && call.options.env.GIT_OPTIONAL_LOCKS === '0' && call.options.timeout === 30000));
    const remote = publication.defaultPrePublishRemote('/unused', 'origin');
    assert.equal(remote.remoteOid, oid); assert.equal(remote.localHead, oid); assert.equal(remote.branch, 'main');
    for (const call of calls.slice(2)) {
        assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, process.env.GIT_OPTIONAL_LOCKS);
        assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(call.options.timeout, call.args[2] === 'ls-remote' ? 180000 : 30000);
        assert.equal(call.options.maxBuffer, 128 * 1024 * 1024);
        assert.equal(call.options.killSignal, 'SIGKILL');
    }
    mocked.mock.mockImplementation(() => normal('prefix', 1));
    assert.throws(() => primitives.defaultGitBlob('/unused', oid, 'file.png'), /Git 命令 ls-tree 执行失败/);
    assert.throws(() => publication.defaultPrePublishRemote('/unused', 'origin'), /Git remote 操作失败/);
});

test('历史 push 原路只发一次；完整远端 OID 核验保留，超时不会重推', t => {
    const calls = [];
    const mocked = t.mock.method(child, 'spawnSync', (_program, args) => {
        calls.push(args[2]);
        if (args[2] === 'remote') return normal('https://example.invalid/repo.git\n');
        if (args[2] === 'ls-remote') return normal(`${oid}\trefs/heads/main\n`);
        return normal();
    });
    assert.equal(publication.defaultPushAndVerify({ blogRepo: '/unused', remoteName: 'origin', commit: oid }).remoteVerifiedOid, oid);
    assert.equal(calls.filter(name => name === 'push').length, 1);
    calls.length = 0;
    mocked.mock.mockImplementation((_program, args) => {
        calls.push(args[2]);
        return args[2] === 'push' ? { ...normal(), error: new Error('ETIMEDOUT') } : normal('https://example.invalid/repo.git');
    });
    assert.throws(() => publication.defaultPushAndVerify({ blogRepo: '/unused', remoteName: 'origin', commit: oid }), /Git push 操作失败/);
    assert.deepEqual(calls, ['remote', 'push']);
});

test('历史私有 allowFailure 只接纳普通完整非零，不短接任何执行异常', t => {
    // 原私有选项目前没有公共调用者；直接执行源中的原函数，不新增生产测试导出。
    const filename = require.resolve('../scripts/lib/historical-direct-publication.js');
    const source = fs.readFileSync(filename, 'utf8');
    const body = source.slice(source.indexOf('function runGit('), source.indexOf('function defaultPublishGit('));
    const runGit = vm.runInNewContext(`${body}\nrunGit`, {
        require: createRequire(filename), process, Buffer,
        fail: message => { throw Object.assign(new Error(message), { code: 'HISTORICAL_DIRECT_PUBLICATION_INTEGRITY' }); }
    });
    const mocked = t.mock.method(child, 'spawnSync', () => ({ ...normal(' out\r\n', 1), stderr: ' err\n' }));
    const result = runGit('/unused', ['status'], { allowFailure: true });
    assert.equal(result.status, 1); assert.equal(result.stdout, 'out'); assert.equal(result.stderr, 'err');
    for (const bad of [
        { ...normal(), error: Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }) },
        { ...normal(), error: Object.assign(new Error('secret'), { code: 'ENOBUFS' }) },
        { ...normal(), error: Object.assign(new Error('secret'), { code: 'ENOENT' }) },
        { ...normal(), signal: 'SIGKILL' }, { ...normal(), status: null }
    ]) {
        mocked.mock.mockImplementation(() => bad);
        assert.throws(() => runGit('/unused', ['status'], { allowFailure: true }),
            error => error.code === 'HISTORICAL_DIRECT_PUBLICATION_INTEGRITY' && !error.message.includes('secret'));
        assert.throws(() => primitives.defaultGitBlob('/unused', oid, 'file'),
            error => error.code === 'PUBLICATION_FILE_INTEGRITY' && !error.message.includes('secret'));
    }
});
