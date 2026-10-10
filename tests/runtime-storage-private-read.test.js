'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const child = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [code, root, target, mode] = process.argv.slice(1);
const originalOpen = fs.openSync, originalRead = fs.readSync;
let replaced = false, targetFd, changedDuringRead = false, replacementIdentity;
fs.openSync = function (name, ...args) {
    if (name === target && !replaced && mode !== 'normal' && mode !== 'pdf-grown') {
        replaced = true;
        fs.renameSync(target, target + '.original');
        if (mode.endsWith('fifo')) execFileSync('mkfifo', [target]);
        else fs.writeFileSync(target, '%PDF-replacement-longer', { mode: 0o644 });
        const stat = fs.lstatSync(target);
        replacementIdentity = { dev: stat.dev, ino: stat.ino };
    }
    const fd = originalOpen.call(fs, name, ...args);
    if (name === target) targetFd = fd;
    return fd;
};
fs.readSync = function (fd, ...args) {
    const count = originalRead.call(fs, fd, ...args);
    if (fd === targetFd && mode === 'pdf-grown' && count > 0 && !changedDuringRead) {
        changedDuringRead = true;
        fs.appendFileSync(target, '-added-during-read');
    }
    return count;
};
let report;
try { report = require(path.join(code, 'scripts/runtime-storage')).getPdfDuplicateReport({
    projectRoot: root, hashBytes: mode !== 'receipt-fifo', nowMs: 0
}); }
finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
const finalStat = fs.lstatSync(target);
console.log(JSON.stringify({ report, replaced, changedDuringRead,
    replacementUnchanged: !replacementIdentity || (replacementIdentity.dev === finalStat.dev && replacementIdentity.ino === finalStat.ino),
    fifoRemains: finalStat.isFIFO() }));
`;

const descriptions = {
    normal: '0644 普通文件保持原哈希与已核验状态',
    'receipt-fifo': '官方获取记录在打开前换成 FIFO 时及时报告文件身份变化',
    'pdf-fifo': 'PDF 在打开前换成 FIFO 时及时报告无法核验',
    'pdf-replacement': 'PDF 在目录扫描后换成另一普通文件时不核验旧记录',
    'pdf-grown': 'PDF 在读取期间增长时不标记为已核验'
};
for (const mode of Object.keys(descriptions)) {
    test(`重复 PDF 报告读取：${descriptions[mode]}`, { skip: mode.endsWith('fifo') && process.platform === 'win32' }, t => {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'runtime-pdf-read-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const directory = path.join(root, 'data/runtime/official-conference-acquisitions/demo-2026');
        fs.mkdirSync(path.join(directory, 'pdfs'), { recursive: true });
        fs.mkdirSync(path.join(directory, 'receipts'));
        const pdf = path.join(directory, 'pdfs/1.pdf'), receipt = path.join(directory, 'receipts/1.json');
        const pdfBytes = Buffer.from('%PDF-runtime-read-control');
        const expectedHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
        fs.writeFileSync(pdf, pdfBytes, { mode: 0o644 });
        fs.writeFileSync(receipt, JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: expectedHash } }), { mode: 0o644 });
        const target = mode === 'receipt-fifo' ? receipt : pdf;
        const original = fs.readFileSync(target);
        const result = spawnSync(process.execPath, ['-e', child, path.resolve(__dirname, '..'), root, target, mode], {
            encoding: 'utf8', timeout: 2000
        });
        assert.equal(result.error, undefined, '读取被替换的文件应及时结束，不应等待 FIFO 写入者');
        assert.equal(result.status, 0, result.stderr);
        const observation = JSON.parse(result.stdout.trim()), report = observation.report;
        assert.equal(observation.replacementUnchanged, true);
        assert.equal(Object.hasOwn(report.pdfFiles[0], 'scannedStat'), false, '内部扫描记录不进入报告');
        if (mode === 'normal') {
            assert.deepEqual(report.blockers, []);
            assert.equal(report.pdfFiles[0].hash, expectedHash);
            assert.equal(report.pdfFiles[0].byteVerified, true);
            assert.equal(fs.statSync(pdf).mode & 0o777, 0o644);
            assert.deepEqual(fs.readFileSync(pdf), original);
        } else if (mode === 'receipt-fifo') {
            assert.equal(observation.fifoRemains, true);
            assert.equal(report.blockers.length, 1);
            assert.equal(report.blockers[0].type, 'changed_receipt');
            assert.match(report.blockers[0].message, /来源记录在读取期间的文件身份已变化/);
            assert.deepEqual(fs.readFileSync(target + '.original'), original);
            assert.equal(report.pdfFiles[0].byteVerified, false);
        } else {
            assert.equal(report.blockers.length, 1);
            assert.equal(report.blockers[0].type, 'io');
            assert.match(report.blockers[0].message, /PDF 文件在目录扫描后已变化|PDF 文件在读取期间已变化/);
            assert.equal(report.pdfFiles[0].hash, null);
            assert.equal(report.pdfFiles[0].byteVerified, false);
            assert.equal(report.pdfFiles[0].bytes, pdfBytes.length);
            if (mode === 'pdf-grown') assert.equal(observation.changedDuringRead, true);
            else {
                assert.equal(observation.replaced, true);
                assert.deepEqual(fs.readFileSync(target + '.original'), original);
                if (mode === 'pdf-fifo') assert.equal(observation.fifoRemains, true);
            }
        }
    });
}
