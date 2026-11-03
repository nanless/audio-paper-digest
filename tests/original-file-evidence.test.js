'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const original = require('../scripts/lib/original-file-evidence');
const prompts = require('../scripts/lib/prompt-evidence');
const registered = require('../config/original-file-evidence.json');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('every registered Manual reference/schema blob is exact original data in Node and Python', () => {
    const expected = [];
    for (const [digest, row] of Object.entries(registered.blobs)) {
        const bytes = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', 'cat-file', 'blob', row.blobOid], { cwd: root });
        assert.equal(sha(bytes), digest);
        for (const relative of row.paths) {
            assert.equal(original.isOriginalFilePath(relative), true);
            assert.deepEqual(original.readOriginalFileBytes(relative, { expectedSha256: digest }), bytes);
            assert.throws(() => prompts.readPromptEvidenceBytes(relative), /namespace/);
            assert.equal(prompts.historicalPromptEvidenceBytesForSha256(digest), null);
            expected.push([relative, digest]);
        }
    }
    const script = "import json,sys,hashlib;sys.path.insert(0,'scripts');from original_file_evidence import read_original_file_bytes;rows=json.loads(sys.stdin.read());print(json.dumps([[p,hashlib.sha256(read_original_file_bytes(p,s)).hexdigest()] for p,s in rows]))";
    const result = execFileSync('bash', ['scripts/python-runtime.sh', '-c', script],
        { cwd: root, input: JSON.stringify(expected), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), expected);
});

test('original static aliases ignore changed current code, reject foreign paths/SHA and reread original Git objects', t => {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'original-file-proof-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder);
    fs.mkdirSync(path.join(folder, 'config'));
    const index = path.join(folder, 'config/original-file-evidence.json');
    fs.copyFileSync(path.join(root, 'config/original-file-evidence.json'), index);
    const relative = 'manual/scripts/manual-tutorial-quality-contract.js';
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'throw new Error("This code must never run or supply the original SHA");');
    const previous = original.readOriginalFileBytes(relative);
    assert.deepEqual(original.readOriginalFileBytes(relative, { root: folder }), previous);
    fs.unlinkSync(file);
    assert.deepEqual(original.readOriginalFileBytes(relative, { root: folder }), previous);
    for (const [candidate, digest] of [['../outside.js', sha(previous)], ['manual/scripts/unknown.js', sha(previous)],
        [relative, 'f'.repeat(64)], [relative, 42], [relative, true], [relative, {}],
        [relative, registered.files['manual/docs/editorial-reference-contract.md'].defaultSha256]]) {
        assert.throws(() => original.readOriginalFileBytes(candidate, { root: folder, expectedSha256: digest }));
    }
    const changed = structuredClone(registered);
    changed.blobs[sha(previous)].blobOid = 'f'.repeat(40);
    fs.writeFileSync(index, JSON.stringify(changed));
    assert.throws(() => original.readOriginalFileBytes(relative, { root: folder }), /unavailable/);
    fs.writeFileSync(index, JSON.stringify(registered));
    assert.deepEqual(original.readOriginalFileBytes(relative, { root: folder }), previous);
    fs.unlinkSync(index); fs.symlinkSync(path.join(root, 'config/original-file-evidence.json'), index);
    assert.throws(() => original.readOriginalFileBytes(relative, { root: folder }), /symlink/);
});
