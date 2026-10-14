'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const evidence = require('../scripts/lib/prompt-evidence');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-prompt-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const bytes = Buffer.from('```text\nOriginal bounded repair instruction.\n```\nOriginal tail.\n');
    const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: bytes }).toString().trim();
    const relative = 'prompts/retired-test.md';
    const index = { contract: 'git-prompt-evidence-v1', version: 1, provenanceCommit: 'a'.repeat(40),
        retiredPaths: { [relative]: sha(bytes) }, blobs: { [sha(bytes)]: { blobOid: oid, paths: [relative] } } };
    const filename = path.join(root, 'scripts/lib/git-prompt-evidence-index.json');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const save = () => fs.writeFileSync(filename, JSON.stringify(index), { mode: 0o600 });
    save(); return { root, bytes, oid, relative, index, filename, save };
}
test('旧Prompt无物理文件，真实Git字节和原SHA可回放且返回独立Buffer', t => {
    const f = fixture(t);
    assert.equal(fs.existsSync(path.join(f.root, f.relative)), false);
    const get = () => evidence.readPromptEvidenceBytes(f.relative, { root: f.root, expectedSha256: sha(f.bytes) });
    assert.deepEqual(get(), f.bytes);
    get().fill(0); assert.deepEqual(get(), f.bytes);
    assert.equal(fs.existsSync(path.join(f.root, 'prompts')), false);
});
test('未知路径、越界、伪造SHA和错误Git blob都拒绝，不补写旧文件', t => {
    const f = fixture(t);
    assert.throws(() => evidence.readPromptEvidenceBytes('../outside.md', { root: f.root }), /namespace/);
    assert.throws(() => evidence.readPromptEvidenceBytes('prompts/unknown.md', { root: f.root }), /Unregistered/);
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root, expectedSha256: 'f'.repeat(64) }), /SHA256/);
    assert.equal(evidence.historicalPromptEvidenceBytesForSha256('f'.repeat(64), { root: f.root }), null);
    f.index.blobs[sha(f.bytes)].blobOid = 'f'.repeat(40); f.save();
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), /unavailable/);
});
test('索引缓存不能遮盖重复键、文件替换、Git内容哈希错配或缺失', t => {
    const f = fixture(t);
    assert.deepEqual(evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), f.bytes);
    const other = execFileSync('git', ['-C', f.root, 'hash-object', '-w', '--stdin'], { input: Buffer.from('wrong bytes') }).toString().trim();
    f.index.blobs[sha(f.bytes)].blobOid = other; f.save();
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), /original SHA256/);
    fs.writeFileSync(f.filename, '{"version":1,"version":1}');
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), /重复|Duplicate|duplicate/);
    fs.unlinkSync(f.filename);
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), /ENOENT/);
});
test('当前模板始终读取工作树，缺失或symlink/FIFO不能用历史blob补齐', t => {
    const f = fixture(t); const current = 'prompts/filter-v5.md';
    f.index.retiredPaths[current] = sha(f.bytes); f.index.blobs[sha(f.bytes)].paths.push(current); f.save();
    assert.throws(() => evidence.readPromptEvidenceBytes(current, { root: f.root }), /ENOENT/);
    fs.mkdirSync(path.join(f.root, 'prompts'));
    const target = path.join(f.root, current); fs.symlinkSync(f.filename, target);
    assert.throws(() => evidence.readPromptEvidenceBytes(current, { root: f.root }), /symlink/);
    fs.unlinkSync(target); execFileSync('mkfifo', [target]);
    assert.throws(() => evidence.readPromptEvidenceBytes(current, { root: f.root }), /regular/);
});
test('Git证据读取忽略外部Git替换目录配置，实际只读本repo对象', t => {
    const f = fixture(t); const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(f.root, 'nonexistent-foreign-repo');
    try { assert.deepEqual(evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), f.bytes); }
    finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});
