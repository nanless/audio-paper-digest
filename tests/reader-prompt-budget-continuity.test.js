'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repair = require('../scripts/lib/reader-repair');
const { loadReaderRecoveryRevision: load } = require('../scripts/lib/reader-recovery-revision');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-prompt-budget-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const old = { paperId: '2609.99991', sourceSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
        freshAnalysis: { runId: 'original-run', paperId: '2609.99991', sourceSha256: 'a'.repeat(64) },
        model: { model: 'original-model', maxTokens: 48000 }, maxAttempts: 6, repairMaxTokens: 16000,
        contentMode: 'reader-source-first-v1', readerRecoveryEpochSha256: 'c'.repeat(64),
        promptSha256: 'd'.repeat(64), repairPromptSha256: 'e'.repeat(64), parserImplementationSha256: 'f'.repeat(64) };
    const current = { ...structuredClone(old), promptSha256: '1'.repeat(64), repairPromptSha256: '2'.repeat(64),
        parserImplementationSha256: '3'.repeat(64) };
    const payload = { status: 'failed', draft: null, rawDraft: 'original invalid response', issues: [],
        attempts: 3, fullAttempts: 1, transportFailures: 1, noProgress: 2, failureSignature: 'original',
        validationFailureStreak: 2, validationFailureSignature: 'original-validation' };
    return { directory, old, current, payload };
}
const blocked = error => error.code === 'READER_PROMPT_CHANGE_REQUIRES_CONTROLLED_RECOVERY'
    && error.retryable === false && error.scope === 'paper';
const bytes = directory => Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name)).toString('base64')]));

test('原选择返回null时，Prompt变化不得把同输入的真实保存次数归零；重复进入零写入', t => {
    const f = fixture(t);
    repair.saveFailedCandidate(f.directory, f.old, f.payload);
    const before = bytes(f.directory);
    for (let i = 0; i < 2; i++) assert.throws(() => load(f.directory, f.current), blocked);
    assert.deepEqual(bytes(f.directory), before);
    assert.equal(fs.existsSync(path.join(f.directory, repair.hashDraft(f.current) + '.json')), false);
});

test('未发生请求的新任务保持正常；旧全文或传输失败历史不能被内容计数0掩盖', t => {
    const f = fixture(t);
    assert.equal(load(f.directory, f.current), null);
    assert.equal(load(path.join(f.directory, 'not-created'), f.current), null);
    for (const counts of [{ attempts: 0, fullAttempts: 1, transportFailures: 0 },
        { attempts: 0, fullAttempts: 0, transportFailures: 1 }]) {
        repair.saveFailedCandidate(f.directory, f.old, { ...f.payload, ...counts });
        const before = bytes(f.directory);
        assert.throws(() => load(f.directory, f.current), blocked);
        assert.deepEqual(bytes(f.directory), before);
    }
    repair.saveFailedCandidate(f.directory, f.old, { ...f.payload, attempts: 0, fullAttempts: 0, transportFailures: 0 });
    assert.equal(load(f.directory, f.current), null);
});

test('来源、反馈输入、scope、epoch、模式、模型或预算不同不能被误判为Prompt-only', t => {
    const f = fixture(t);
    repair.saveFailedCandidate(f.directory, f.old, f.payload);
    const variants = [{ sourceSha256: '4'.repeat(64) }, { inputFingerprint: 'new-fact-feedback-or-selected-reanalysis' },
        { freshAnalysis: { ...f.current.freshAnalysis, runId: 'another-run' } },
        { readerRecoveryEpochSha256: '5'.repeat(64) }, { contentMode: 'reader-source-signed-revision-v1' },
        { model: { ...f.current.model, model: 'different-model' } }, { maxAttempts: 5 }, { repairMaxTokens: 8000 },
        { resourceLocalRevisionContract: 'signed-reader-resource-local-repair-v1', contentMode: 'reader-source-signed-revision-v1' },
        { readerFactLocalRevisionContract: 'signed-reader-fact-local-repair-v1', contentMode: 'reader-source-signed-revision-v1' }];
    const before = bytes(f.directory);
    for (const changed of variants) assert.equal(load(f.directory, { ...f.current, ...changed }), null);
    assert.deepEqual(bytes(f.directory), before);
});

test('已有当前Prompt的非零候选也不能掩盖同输入旧Prompt的活动请求历史', t => {
    const f = fixture(t);
    repair.saveFailedCandidate(f.directory, f.old, f.payload);
    repair.saveFailedCandidate(f.directory, f.current, { ...f.payload, attempts: 1 });
    const before = bytes(f.directory);
    assert.throws(() => load(f.directory, f.current), blocked);
    assert.deepEqual(bytes(f.directory), before);
});

test('exact命中每次只做一轮guard读取，不跨调用缓存其他候选资格', t => {
    const f = fixture(t);
    repair.saveFailedCandidate(f.directory, f.current, f.payload);
    const others = Array.from({ length: 3 }, (_, i) => repair.saveFailedCandidate(f.directory,
        { ...f.old, paperId: `2609.9998${i}` }, f.payload));
    const originalOpen = fs.openSync, counts = new Map();
    fs.openSync = function (filename, ...args) {
        if (typeof filename === 'string' && others.includes(filename)) counts.set(filename, (counts.get(filename) || 0) + 1);
        return originalOpen.call(this, filename, ...args);
    };
    try {
        assert.equal(load(f.directory, f.current).attempts, f.payload.attempts);
        assert.deepEqual(others.map(file => counts.get(file)), [1, 1, 1]);
        assert.equal(load(f.directory, f.current).attempts, f.payload.attempts);
        assert.deepEqual(others.map(file => counts.get(file)), [2, 2, 2]);
    } finally { fs.openSync = originalOpen; }
});

test('坏候选、错误文件身份、权限或软链接必须报错，不能当无候选吞掉', t => {
    const f = fixture(t);
    const file = repair.saveFailedCandidate(f.directory, f.old, f.payload), original = fs.readFileSync(file);
    fs.writeFileSync(file, '{bad');
    assert.throws(() => load(f.directory, f.current), /candidate refused/i);
    fs.writeFileSync(file, original); fs.chmodSync(file, 0o644);
    assert.throws(() => load(f.directory, f.current), /candidate refused/i);
    fs.chmodSync(file, 0o600);
    const moved = path.join(f.directory, '9'.repeat(64) + '.json'); fs.renameSync(file, moved);
    assert.throws(() => load(f.directory, f.current), /candidate refused/i);
    fs.renameSync(moved, file); fs.unlinkSync(file);
    const target = path.join(f.directory, 'target'); fs.writeFileSync(target, original, { mode: 0o600 });
    fs.symlinkSync(target, file);
    assert.throws(() => load(f.directory, f.current), /candidate refused/i);
    assert.deepEqual(fs.readFileSync(target), original);
});

test('真实生成入口的合成付费响应候选升级Prompt后零模型、零新候选、原失败字节保留', async t => {
    const f = fixture(t), { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer');
    const options = { sourceText: 'sealed fixture source', readerAttemptsDir: f.directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    // The callback is local; no real HTTP/model request or payment occurs.
    await assert.rejects(generateApiReaderArticleDetailed({ arxivId: f.old.paperId, title: 'Synthetic continuity fixture' },
        '', '', { ...options, readerCallModel: async () => 'invalid JSON' }));
    const file = fs.readdirSync(f.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(f.directory, file)));
    assert.ok(envelope.payload.attempts > 0);
    const oldIdentity = { ...envelope.identity, promptSha256: f.old.promptSha256,
        repairPromptSha256: f.old.repairPromptSha256, parserImplementationSha256: f.old.parserImplementationSha256 };
    repair.saveFailedCandidate(f.directory, oldIdentity, envelope.payload);
    fs.unlinkSync(path.join(f.directory, file));
    const before = bytes(f.directory); let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed({ arxivId: f.old.paperId, title: 'Synthetic continuity fixture' },
        '', '', { ...options, readerCallModel: async () => { calls++; throw new Error('must not call'); } }), blocked);
    assert.equal(calls, 0);
    assert.deepEqual(bytes(f.directory), before);
});
