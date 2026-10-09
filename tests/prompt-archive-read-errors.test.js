const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const archive = require('../scripts/build-prompt-history-archive');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-archive-errors-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'data'));
    // 复制生产入口的完整原字节，只隔离它扫描的数据根，不改任何待测函数。
    fs.copyFileSync(require.resolve('../scripts/build-prompt-history-archive'), path.join(root, 'scripts/archive.js'));
    fs.symlinkSync(require.resolve('../scripts/env-loader'), path.join(root, 'scripts/env-loader.js'));
    return root;
}
function collect(root, behavior, expected) {
    const script = `const assert=require('node:assert/strict'),cp=require('node:child_process');
const error=Object.assign(new Error('读取候选失败'),{status:${behavior === 'empty' ? 1 : 2},code:'EIO',stdout:Buffer.alloc(0)});
cp.execFileSync=function(command){if(command==='rg'){${behavior === 'json' ? "return Buffer.from('data/bad.json\\n');" : 'throw error;'}}return Buffer.alloc(0);};
const archive=require(${JSON.stringify(path.join(root, 'scripts/archive.js'))});
${expected === 'same-error' ? 'assert.throws(()=>archive.collectArchiveEntries(), e=>e===error);' : expected === 'syntax-error' ? 'assert.throws(()=>archive.collectArchiveEntries(), SyntaxError);' : 'assert.equal(archive.collectArchiveEntries().entries.size,0);'}`;
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
}
test('候选检索失败不当作零命中，原错误保留', t => {
    const child = collect(fixture(t), 'io', 'same-error');
    assert.equal(child.status, 0, child.stderr);
});
test('含来源SHA的损坏JSON不能被静默跳过后报告归档完整', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'data/bad.json'), '{"sourceSha256":"' + 'a'.repeat(64) + '"');
    const child = collect(root, 'json', 'syntax-error');
    assert.equal(child.status, 0, child.stderr);
});
test('真正没有匹配项时仍接受空集合', t => {
    const child = collect(fixture(t), 'empty', 'empty');
    assert.equal(child.status, 0, child.stderr);
});
test('已有归档读取EIO不触发替换，保留原文件', t => {
    const root = fixture(t);
    const bytes = Buffer.from('expected prompt bytes');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(root, sha256 + '.md');
    fs.writeFileSync(file, '原有待检查字节');
    const original = fs.readFileSync;
    const error = Object.assign(new Error('读取已有归档失败'), { code: 'EIO' });
    fs.readFileSync = function (filename, ...args) {
        if (filename === file) throw error;
        return original.call(this, filename, ...args);
    };
    try {
        assert.throws(() => archive.writeArchive([{ sha256, bytes }], root), failure => failure === error);
    } finally {
        fs.readFileSync = original;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '原有待检查字节');
});
