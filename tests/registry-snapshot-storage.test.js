'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { archiveRegistrySnapshot } = require('../scripts/tag-record-update.js');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'registry-snapshot-storage-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceFile = path.join(directory, 'catalog.json');
    const bytes = fs.readFileSync(path.join(__dirname, '../config/tag-catalog.json'));
    fs.writeFileSync(sourceFile, bytes, { mode: 0o600 });
    const historyDir = path.join(directory, 'history');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const target = path.join(historyDir, `${sha}.json`);
    return { sourceFile, historyDir, bytes, target };
}

function childArchive(fixture, injection = '') {
    return spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        const sourceFile = process.argv[1];
        const historyDir = process.argv[2];
        ${injection}
        require('./scripts/tag-record-update.js').archiveRegistrySnapshot({ sourceFile, historyDir });
    `, fixture.sourceFile, fixture.historyDir], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 2500
    });
}

test('词表归档真实短写EIO不留下半截正式快照，随后原样重试成功', t => {
    const f = fixture(t);
    const open = fs.openSync;
    const write = fs.writeSync;
    let outputFd;
    let injected = false;
    const cause = Object.assign(new Error('受控归档写入失败'), { code: 'EIO' });
    const openHook = t.mock.method(fs, 'openSync', (filename, ...options) => {
        const fd = open(filename, ...options);
        if (typeof filename === 'string' && path.dirname(filename) === f.historyDir) outputFd = fd;
        return fd;
    });
    const writeHook = t.mock.method(fs, 'writeSync', (fd, buffer, ...options) => {
        if (fd === outputFd && !injected) {
            injected = true;
            write(fd, buffer, 0, 7, 0);
            throw cause;
        }
        return write(fd, buffer, ...options);
    });
    assert.throws(() => archiveRegistrySnapshot(f), error => error === cause);
    writeHook.mock.restore();
    openHook.mock.restore();
    assert.equal(injected, true);
    assert.equal(fs.existsSync(f.target), false);
    assert.deepEqual(fs.readdirSync(f.historyDir), []);
    const created = archiveRegistrySnapshot(f);
    assert.equal(created.status, 'archived');
    assert.deepEqual(fs.readFileSync(f.target), f.bytes);
    assert.equal(archiveRegistrySnapshot(f).status, 'already-archived');
});

test('写入中真实SIGKILL不留下正式残片，重试保留未知临时文件', t => {
    const f = fixture(t);
    const killed = childArchive(f, `
        const open = fs.openSync;
        const write = fs.writeSync;
        let outputFd;
        fs.openSync = (filename, ...options) => {
            const fd = open(filename, ...options);
            if (typeof filename === 'string' && path.dirname(filename) === historyDir) outputFd = fd;
            return fd;
        };
        fs.writeSync = (fd, buffer, ...options) => {
            if (fd === outputFd) {
                write(fd, buffer, 0, 7, 0);
                process.kill(process.pid, 'SIGKILL');
            }
            return write(fd, buffer, ...options);
        };
    `);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(fs.existsSync(f.target), false);
    const remnants = fs.readdirSync(f.historyDir);
    assert.equal(remnants.length, 1);
    const remnant = path.join(f.historyDir, remnants[0]);
    const before = fs.statSync(remnant);
    assert.equal(archiveRegistrySnapshot(f).status, 'archived');
    assert.equal(fs.statSync(remnant).ino, before.ino);
    assert.equal(fs.statSync(remnant).size, 7);
    assert.deepEqual(fs.readFileSync(f.target), f.bytes);
});

test('链接发布后真实SIGKILL只按原词表字节回收已退出写者链接', t => {
    const f = fixture(t);
    const killed = childArchive(f, `
        const link = fs.linkSync;
        fs.linkSync = (...args) => {
            const result = link(...args);
            process.kill(process.pid, 'SIGKILL');
            return result;
        };
    `);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const linked = fs.statSync(f.target);
    assert.equal(linked.nlink, 2);
    const recovered = archiveRegistrySnapshot(f);
    assert.equal(recovered.status, 'already-archived');
    assert.equal(recovered.written, false);
    assert.equal(fs.statSync(f.target).ino, linked.ino);
    assert.equal(fs.statSync(f.target).nlink, 1);
    assert.deepEqual(fs.readdirSync(f.historyDir), [path.basename(f.target)]);
    assert.deepEqual(fs.readFileSync(f.target), f.bytes);
});

test('已有目标FIFO立即拒绝，未知链接和旧半截快照均保留', t => {
    const f = fixture(t);
    fs.mkdirSync(f.historyDir);
    assert.equal(spawnSync('mkfifo', [f.target]).status, 0);
    const before = fs.lstatSync(f.target);
    const result = childArchive(f);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(fs.lstatSync(f.target).ino, before.ino);
    fs.unlinkSync(f.target);
    fs.writeFileSync(f.target, f.bytes.subarray(0, 7));
    assert.throws(() => archiveRegistrySnapshot(f), /拒绝覆盖/);
    assert.equal(fs.readFileSync(f.target).length, 7);
    fs.unlinkSync(f.target);
    fs.writeFileSync(f.target, f.bytes);
    const external = path.join(f.historyDir, 'unknown-link');
    fs.linkSync(f.target, external);
    assert.throws(() => archiveRegistrySnapshot(f), /拒绝覆盖/);
    assert.equal(fs.statSync(f.target).nlink, 2);
    assert.deepEqual(fs.readFileSync(external), f.bytes);
});

test('既有父目录别名仍可归档，返回路径和原始字节保持不变', t => {
    const f = fixture(t);
    const alias = path.join(path.dirname(f.sourceFile), 'directory-alias');
    fs.symlinkSync(path.dirname(f.sourceFile), alias, 'dir');
    const historyDir = path.join(alias, 'history');
    const result = archiveRegistrySnapshot({ sourceFile: f.sourceFile, historyDir });
    assert.equal(result.status, 'archived');
    assert.equal(result.historyDir, historyDir);
    assert.equal(result.target, path.join(historyDir, path.basename(f.target)));
    assert.deepEqual(fs.readFileSync(f.target), f.bytes);
    assert.equal(archiveRegistrySnapshot({ sourceFile: f.sourceFile, historyDir }).status, 'already-archived');
    assert.deepEqual(fs.readdirSync(f.historyDir), [path.basename(f.target)]);
});
