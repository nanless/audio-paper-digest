'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '..');

const replacementReader = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [projectRoot, target, filename, directory] = process.argv.slice(1);
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
let replaced = false;
let closed = false;
let openedDescriptor;
fs.openSync = function (name, ...args) {
    if (name === filename && !replaced) {
        replaced = true;
        fs.renameSync(filename, filename + '.original');
        execFileSync('mkfifo', [filename]);
    }
    const descriptor = originalOpen.call(fs, name, ...args);
    if (name === filename) openedDescriptor = descriptor;
    return descriptor;
};
fs.closeSync = function (descriptor) {
    if (descriptor === openedDescriptor) closed = true;
    return originalClose.call(fs, descriptor);
};
let error;
try {
    if (target === 'publication') {
        require(path.join(projectRoot, 'scripts/lib/historical-publication')).readRegular(filename);
    } else if (target === 'page') {
        require(path.join(projectRoot, 'scripts/lib/historical-page-staging')).readRegular(filename, 1024, '测试文件');
    } else if (target === 'daily') {
        require(path.join(projectRoot, 'scripts/lib/historical-daily-aggregate')).loadCompletedPageStaging({
            stagingRoot: directory,
            stagingRunId: '11111111-1111-4111-8111-111111111111'
        });
    } else {
        require(path.join(projectRoot, 'scripts/lib/historical-direct-page-staging')).stageDirectPages({
            directory,
            item: { paperId: 'synthetic' },
            stagingInputSha256: 'a'.repeat(64),
            stagingBindingSha256: 'b'.repeat(64),
            dependencies: { readImplementationFile: () => Buffer.from('synthetic-public-reader-probe') }
        });
    }
} catch (failure) {
    error = failure;
} finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
}
console.log(JSON.stringify({
    replaced,
    closed,
    error: error && { message: error.message, code: error.code || null }
}));
`;

test('历史读取入口拒绝检查后被替换的无写入方 FIFO，保留原文件并关闭描述符', async t => {
    if (process.platform === 'win32') return t.skip('本用例需要 POSIX FIFO');
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-read-fifo-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const readers = [
        ['publication', '历史发布来源文件读取'],
        ['page', '历史页面生成文件读取'],
        ['daily', '历史每日汇总的已完成清单读取'],
        ['direct', '直接来源历史页面的已保存清单读取']
    ];
    for (const [target, title] of readers) {
        await t.test(title, () => {
            const directory = path.join(temporary, target);
            fs.mkdirSync(directory);
            const runDirectory = target === 'daily'
                ? path.join(directory, '11111111-1111-4111-8111-111111111111') : directory;
            if (runDirectory !== directory) fs.mkdirSync(runDirectory);
            const basename = target === 'daily' ? 'manifest.json'
                : target === 'direct' ? 'page-staging-manifest.json' : 'record.json';
            const filename = path.join(runDirectory, basename);
            const original = Buffer.from('{}');
            fs.writeFileSync(filename, original, { mode: 0o644 });
            const output = spawnSync(process.execPath, ['-e', replacementReader,
                projectRoot, target, filename, directory], { encoding: 'utf8', timeout: 2000 });
            assert.equal(output.error, undefined, output.error?.message);
            assert.equal(output.status, 0, output.stderr);
            const result = JSON.parse(output.stdout.trim().split('\n').at(-1));
            assert.equal(result.replaced, true);
            assert.equal(result.closed, true);
            assert.ok(result.error && /不安全|不对应/.test(result.error.message), JSON.stringify(result));
            assert.deepEqual(fs.readFileSync(filename + '.original'), original);
            assert.ok(fs.lstatSync(filename).isFIFO());
        });
    }
});

test('历史普通文件保留 0644 权限与原字节，只有显式许可才接受两个硬链接', t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-read-regular-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'record.json');
    const bytes = Buffer.from('{"value":"未改"}');
    fs.writeFileSync(filename, bytes, { mode: 0o644 });
    const publication = require('../scripts/lib/historical-publication');
    const page = require('../scripts/lib/historical-page-staging');
    assert.deepEqual(publication.readRegular(filename).bytes, bytes);
    assert.deepEqual(page.readRegular(filename, 1024, '测试文件').bytes, bytes);
    fs.linkSync(filename, path.join(directory, 'record-link.json'));
    assert.throws(() => publication.readRegular(filename), /不安全/);
    assert.throws(() => page.readRegular(filename, 1024, '测试文件'), /不安全/);
    assert.deepEqual(publication.readRegular(filename, 1024, { allowPendingLink: true }).bytes, bytes);
    const pending = page.readRegular(filename, 1024, '测试文件', true);
    assert.deepEqual(pending.bytes, bytes);
    assert.equal(pending.pendingLink, true);
    assert.equal(fs.lstatSync(filename).mode & 0o777, 0o644);
    assert.deepEqual(fs.readFileSync(filename), bytes);
});
