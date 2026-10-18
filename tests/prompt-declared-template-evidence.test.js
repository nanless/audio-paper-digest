'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const evidence = require('../scripts/lib/prompt-evidence'), history = require('../scripts/lib/prompt-history');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'declared-prompt-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const relative = 'prompts/api-reader-article-v9.md', old = Buffer.from('~~~text\nOriginal paid instruction.\n~~~\nOriginal tail.\n');
    const current = Buffer.from('~~~text\nCurrent writing instruction.\n~~~\nCurrent tail.\n');
    const filename = path.join(root, relative), indexFile = path.join(root, 'scripts/lib/git-prompt-evidence-index.json');
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(filename, current);
    const index = { contract: 'git-prompt-evidence-v1', version: 1, provenanceCommit: 'a'.repeat(40), retiredPaths: {}, blobs: {} };
    const save = () => fs.writeFileSync(indexFile, JSON.stringify(index));
    const add = (bytes, registeredPath = relative) => {
        const blobOid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: bytes }).toString().trim();
        index.blobs[sha(bytes)] = { blobOid, paths: [registeredPath] }; save();
    };
    add(old);
    return { root, relative, old, current, filename, index, save, add, template: history.promptTemplateSha256(old.toString()) };
}

test('显式原模板身份只读恢复同路径真实Git字节，新请求仍读取当前工作树', t => {
    const f = fixture(t), declared = evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root });
    assert.equal(declared.contract, 'analysis-prompt-text-v9');
    assert.equal(declared.path, f.relative); assert.equal(declared.fileSha256, sha(f.old));
    assert.deepEqual(declared.bytes, f.old);
    assert.deepEqual(evidence.readPromptEvidenceBytes(f.relative, { root: f.root }), f.current);
    assert.throws(() => evidence.readPromptEvidenceBytes(f.relative, { root: f.root, expectedSha256: sha(f.old) }), /declared SHA256/);
    declared.bytes.fill(0);
    assert.deepEqual(evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }).bytes, f.old);
});

test('错模板SHA、错阶段或无登记原路径不给历史声明', t => {
    const f = fixture(t);
    assert.equal(evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', 'f'.repeat(64), { root: f.root }), null);
    assert.equal(evidence.declaredStagePromptTemplateEvidence('unknownStage', f.template, { root: f.root }), null);
    assert.equal(evidence.declaredPromptTemplateEvidence('prompts/unregistered.md', f.template, { root: f.root }), null);
    assert.throws(() => evidence.declaredPromptTemplateEvidence(f.relative, 'bad', { root: f.root }), /SHA256/);
    assert.throws(() => evidence.declaredPromptTemplateEvidence('../outside.md', f.template, { root: f.root }), /namespace/);
});

test('同模板不同整文件的原证据歧义必须拒绝，不能随便挑一个旧文件', t => {
    const f = fixture(t), changedTail = Buffer.from(f.old.toString().replace('Original tail.', 'Different original tail.'));
    f.add(changedTail, 'prompts/another-stage.md');
    assert.equal(evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }).fileSha256, sha(f.old));
    f.index.blobs[sha(changedTail)].paths = [f.relative]; f.save();
    assert.throws(() => evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }), /ambiguous/);
});

test('历史索引的错误整SHA或当前缺失/链接都不能被旧模板回退掩盖', t => {
    const f = fixture(t);
    f.index.blobs[sha(f.old)].blobOid = execFileSync('git', ['-C', f.root, 'hash-object', '-w', '--stdin'], { input: Buffer.from('wrong') }).toString().trim();
    f.save();
    assert.throws(() => evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }), /original SHA256/);
    f.add(f.old); fs.unlinkSync(f.filename);
    assert.throws(() => evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }), /ENOENT/);
    fs.symlinkSync(path.join(f.root, 'scripts/lib/git-prompt-evidence-index.json'), f.filename);
    assert.throws(() => evidence.declaredStagePromptTemplateEvidence('apiReaderArticle', f.template, { root: f.root }), /symlink/);
});

test('本次原付费v9/v13模板按原路径和原整SHA恢复，不能将读取证据当成声明能力', () => {
    for (const [stage, relative, wholeSha] of [
        ['apiReaderArticle', 'prompts/api-reader-article-v9.md', 'e294f105592995d6dbe494e47b111e588fc61d96c87e3a905a8d32686b87cc83'],
        ['apiReaderRepair', 'prompts/api-reader-repair-v13.md', '55aa1eb2d663b69bcaff0df77ec371fdc9764173449279b0139c85be0cba68f5']
    ]) {
        const original = evidence.historicalPromptEvidenceBytesForSha256(wholeSha, { relativePath: relative });
        const template = history.promptTemplateSha256(original.toString()), found = evidence.declaredStagePromptTemplateEvidence(stage, template);
        assert.equal(found.path, relative); assert.equal(found.fileSha256, wholeSha);
        assert.deepEqual(found.bytes, original);
        assert.notEqual(sha(evidence.readPromptEvidenceBytes(relative)), wholeSha);
        assert.equal(require('../scripts/lib/conference-reader-active-candidate-replay').isVerifiedConferenceReaderPromptDeclaration(found), false);
        assert.equal(require('../scripts/lib/conference-reader-operator-correction').isVerifiedConferenceReaderPromptDeclaration(found), false);
    }
});
