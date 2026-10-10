'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { readPrivateJson } = require('../scripts/lib/conference-process-recovery');

function privateDirectory(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-recovery-read-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

const replacementReader = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.argv[1], filename = process.argv[2], replacement = process.argv[3];
const originalOpen = fs.openSync, originalClose = fs.closeSync;
let openedFd, closeCount = 0, replaced = false;
fs.openSync = function (name, ...args) {
    if (name === filename && !replaced) {
        replaced = true;
        fs.renameSync(filename, filename + '.original');
        if (replacement === 'fifo') execFileSync('mkfifo', [filename]);
        else if (replacement === 'symlink') fs.symlinkSync(filename + '.original', filename);
        else fs.writeFileSync(filename, '{}', { mode: 0o600 });
        if (replacement !== 'symlink') fs.chmodSync(filename, 0o600);
        openedFd = undefined;
        closeCount = 0;
    }
    const fd = originalOpen.call(fs, name, ...args);
    if (name === filename) openedFd = fd;
    return fd;
};
fs.closeSync = function (fd) {
    if (fd === openedFd) closeCount++;
    return originalClose.call(fs, fd);
};
let error;
try { require(path.join(root, 'scripts/lib/conference-process-recovery')).readPrivateJson(filename); }
catch (failure) { error = failure; }
finally { fs.openSync = originalOpen; fs.closeSync = originalClose; }
console.log(JSON.stringify({ rejected: Boolean(error), message: error?.message, code: error?.code || null,
    closeCount, opened: openedFd !== undefined, originalBytes: fs.readFileSync(filename + '.original', 'utf8') }));
`;

test('会议恢复读取拒绝打开前被替换的 FIFO、文件或符号链接，并关闭已打开的文件', async t => {
    for (const replacement of ['fifo', 'regular', 'symlink']) {
        await t.test(replacement, subtest => {
            const directory = privateDirectory(subtest), filename = path.join(directory, 'state.json');
            fs.writeFileSync(filename, '{"kept":true}', { mode: 0o600 });
            const result = spawnSync(process.execPath, ['-e', replacementReader,
                path.resolve(__dirname, '..'), filename, replacement], { encoding: 'utf8', timeout: 2000 });
            assert.equal(result.error, undefined, '替换后的文件必须及时拒绝，不得在打开 FIFO 时等待');
            assert.equal(result.status, 0, result.stderr);
            const observation = JSON.parse(result.stdout.trim());
            assert.equal(observation.rejected, true);
            assert.equal(observation.originalBytes, '{"kept":true}');
            if (replacement === 'symlink') assert.equal(observation.code, 'ELOOP');
            else {
                assert.match(observation.message, /会议恢复文件不安全/);
                assert.equal(observation.opened, true);
                assert.equal(observation.closeCount, 1, '拒绝文件后关闭已打开的文件描述符');
            }
        });
    }
});

test('会议恢复读取保留普通私有文件，并拒绝符号链接、多个硬链接和不安全权限', t => {
    const directory = privateDirectory(t), filename = path.join(directory, 'state.json');
    fs.writeFileSync(filename, '{"kept":true}', { mode: 0o600 });
    const original = fs.readFileSync(filename);
    assert.deepEqual(readPrivateJson(filename), { kept: true });
    const symlink = path.join(directory, 'symlink.json');
    fs.symlinkSync(filename, symlink);
    assert.throws(() => readPrivateJson(symlink), /会议恢复文件不安全/);
    const hardlink = path.join(directory, 'hardlink.json');
    fs.linkSync(filename, hardlink);
    assert.throws(() => readPrivateJson(filename), /会议恢复文件不安全/);
    fs.unlinkSync(hardlink);
    fs.chmodSync(filename, 0o644);
    assert.throws(() => readPrivateJson(filename), /会议恢复文件不安全/);
    fs.chmodSync(filename, 0o600);
    assert.deepEqual(readPrivateJson(filename), { kept: true });
    assert.deepEqual(fs.readFileSync(filename), original);
});
