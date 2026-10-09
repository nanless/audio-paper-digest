"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJsonSafe } = require('../scripts/utils.js');

for (const entry of ['readJsonSafe', 'validatePapersDatabase']) {
    test(`${entry} 拒绝真实 FIFO 并保留管道节点`, t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-fifo-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const filename = path.join(directory, 'papers.json');
        assert.equal(spawnSync('mkfifo', [filename]).status, 0);
        const inode = fs.lstatSync(filename).ino;
        const result = spawnSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const filename = process.argv[1];
            if (process.argv[2] === 'readJsonSafe') {
                const fallback = { failed: true };
                assert.strictEqual(require('./scripts/utils.js').readJsonSafe(filename, fallback), fallback);
            } else {
                const issues = require('./scripts/validate-data-files.js').validatePapersDatabase(filename);
                assert.ok(issues.length > 0);
            }
            assert.equal(fs.lstatSync(filename).isFIFO(), true);
        `, filename, entry], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 2500 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /不是普通文件/);
        assert.equal(fs.lstatSync(filename).isFIFO(), true);
        assert.equal(fs.lstatSync(filename).ino, inode);
    });
}

test('JSON 普通文件及既有软链接兼容保持，损坏或缺失仍返回原默认值', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-regular-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'valid.json');
    const bytes = Buffer.from('{"papers":{},"generation":2}');
    fs.writeFileSync(filename, bytes);
    const alias = path.join(directory, 'alias.json');
    fs.symlinkSync(filename, alias);
    assert.deepEqual(readJsonSafe(filename), { papers: {}, generation: 2 });
    assert.deepEqual(readJsonSafe(alias), { papers: {}, generation: 2 });
    assert.deepEqual(fs.readFileSync(filename), bytes);
    const fallback = { failed: true };
    assert.strictEqual(readJsonSafe(path.join(directory, 'missing.json'), fallback), fallback);
    fs.writeFileSync(filename, '{');
    assert.strictEqual(readJsonSafe(filename, fallback), fallback);
});
