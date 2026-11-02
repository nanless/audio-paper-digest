'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const repair = require('../scripts/lib/reader-repair');
const normalization = require('../scripts/lib/reader-candidate-normalization');
const deep = require('../scripts/deep-analyzer');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-normalization-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = require('./reader-signed-draft-fixture').fixture({ noFigures: true }).draft;
    draft.sections[0].body += '\n第一类是三段级联。';
    const identity = { paperId: '2610.00001' }, payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        attempts: 2, fullAttempts: 2, noProgress: 1, transportFailures: 1, failureSignature: 'original failure',
        validationFailureSignature: 'original gate', validationFailureStreak: 1,
        readerRecoveryRevisions: [{ original: true }], ordinalPatchCompilations: [],
        oldBudgetAndUsage: { charged: 2, ids: ['old-paid-1','old-paid-2'] },
        issues: [{ path: null, message: '读者文章文风校验失败: quantitative_chinese_numeral:三段' }] };
    repair.saveFailedCandidate(directory, identity, payload);
    const filename = path.join(directory, repair.hashDraft(identity) + '.json'), before = fs.readFileSync(filename);
    const state = deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(draft), payload.issues, { pixelFigureOrdinals: [] });
    assert.notEqual(repair.hashDraft(state.draft), repair.hashDraft(draft));
    return { directory, identity, filename, before, payload, snapshot: { expectedEnvelopeSha256: sha(before),
        draft: state.draft, draftOrderMappings: state.draftOrderMappings, issues: payload.issues } };
}
test('首次ordinal前归一化CAS归档，原费用、失败、原响应及全部历史逐项保留', t => {
    const f = fixture(t), writer = normalization.createWriter({ ...f, isActive: () => false }); writer.queue(f.snapshot);
    const after = repair.readFailedCandidateEnvelope(f.directory, f.identity).envelope.payload;
    for (const [k, value] of Object.entries(f.payload)) if (!['draft','draftOrderMappings','issues'].includes(k)) assert.deepEqual(after[k], value, k);
    assert.deepEqual(after.draft, f.snapshot.draft);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'normalizations', sha(f.before) + '.parent.json')), f.before);
    assert.equal(fs.readdirSync(path.join(f.directory, 'normalizations')).filter(x => x.endsWith('.applied.json')).length, 1);
});
test('活跃ordinal能力期间不写父稿，封签后才flush且保留同一父CAS', t => {
    const f = fixture(t); let active = true;
    const writer = normalization.createWriter({ ...f, isActive: () => active }); writer.queue(f.snapshot);
    assert.deepEqual(fs.readFileSync(f.filename), f.before); assert.equal(fs.existsSync(path.join(f.directory, 'normalizations')), false);
    assert.throws(() => writer.flush(), /Active ordinal capability/);
    active = false; writer.flush(); assert.deepEqual(repair.loadFailedCandidate(f.directory, f.identity).draft, f.snapshot.draft);
});
test('活跃挂起稿的父身份冲突不携带写回资格且原包不变', t => {
    const f = fixture(t), writer = normalization.createWriter({ ...f, isActive: () => true });
    writer.queue(f.snapshot);
    assert.throws(() => writer.queue({ ...f.snapshot, expectedEnvelopeSha256: '0'.repeat(64) }),
        error => error.code === 'READER_NORMALIZATION_NOT_PERSISTED'
            && error.normalizationExpectedEnvelopeSha256 === undefined);
    assert.deepEqual(fs.readFileSync(f.filename), f.before);
});
test('归档后rename前CAS变化拒绝，不覆盖外部新字节', t => {
    const f = fixture(t), write = fs.writeFileSync; let raced = false;
    fs.writeFileSync = function(filename, ...args) {
        const result = write.call(this, filename, ...args);
        if (!raced && typeof filename === 'number' && typeof args[0] === 'string' && args[0].includes('payloadSha256')) {
            raced = true; fs.appendFileSync(f.filename, ' ');
        }
        return result;
    };
    try { assert.throws(() => normalization.createWriter({ ...f, isActive: () => false }).queue(f.snapshot),
        error => error.code === 'READER_NORMALIZATION_CAS_CHANGED' && error.scope === 'run'
            && error.normalizationExpectedEnvelopeSha256 === undefined); }
    finally { fs.writeFileSync = write; }
    assert.equal(raced, true); assert.deepEqual(fs.readFileSync(f.filename), Buffer.concat([f.before, Buffer.from(' ')]));
    assert.deepEqual(repair.loadFailedCandidate(f.directory, f.identity).draft, f.payload.draft);
});
test('存储故障停止派发，原候选不变，归档原件可读且不产生应用记录', t => {
    const f = fixture(t), rename = fs.renameSync;
    fs.renameSync = function(from, to) { if (to === f.filename) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' }); return rename.call(this, from, to); };
    try { assert.throws(() => normalization.createWriter({ ...f, isActive: () => false }).queue(f.snapshot),
        error => error.code === 'READER_NORMALIZATION_NOT_PERSISTED' && error.scope === 'run' && error.retryable === false
            && error.normalizationExpectedEnvelopeSha256 === sha(f.before)); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(f.filename), f.before);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'normalizations', sha(f.before) + '.parent.json')), f.before);
    assert.equal(fs.readdirSync(path.join(f.directory, 'normalizations')).some(x => x.endsWith('.applied.json')), false);
});
test('归一化故障的付费失败保存仍须原父CAS，不得覆盖随后变化的父稿', t => {
    const f = fixture(t), rename = fs.renameSync; let failure;
    fs.renameSync = function(from, to) { if (to === f.filename) throw new Error('injected disk failure'); return rename.call(this, from, to); };
    try { normalization.createWriter({ ...f, isActive: () => false }).queue(f.snapshot); }
    catch (error) { failure = error; }
    finally { fs.renameSync = rename; }
    assert.equal(failure.code, 'READER_NORMALIZATION_NOT_PERSISTED');
    fs.appendFileSync(f.filename, ' ');
    assert.throws(() => repair.saveFailedCandidate(f.directory, f.identity, { ...f.payload, attempts: 3 },
        { expectedEnvelopeSha256: failure.normalizationExpectedEnvelopeSha256 }),
        error => error.code === 'READER_NORMALIZATION_CAS_CHANGED');
    assert.deepEqual(fs.readFileSync(f.filename), Buffer.concat([f.before, Buffer.from(' ')]));
    assert.equal(repair.loadFailedCandidate(f.directory, f.identity).attempts, 2);
});
test('真实Apriel与VoxLock原字节固定证据：仅显式输入、禁止当前数据依赖与模型', {
    skip: !process.env.READER_FIX_REAL_EVIDENCE && 'Explicit SHA-bound local diagnostic evidence is not provided'
}, t => {
    const file = process.env.READER_FIX_REAL_EVIDENCE, bytes = fs.readFileSync(file);
    assert.match(process.env.READER_FIX_REAL_EVIDENCE_SHA256 || '', /^[a-f0-9]{64}$/);
    assert.equal(sha(bytes), process.env.READER_FIX_REAL_EVIDENCE_SHA256);
    const evidence = JSON.parse(bytes), entries = evidence.entries;
    for (const entry of Object.values(entries)) {
        assert.equal(sha(Buffer.from(entry.candidateBase64, 'base64')), entry.candidateSha256);
        assert.equal(sha(Buffer.from(entry.sourceBase64, 'base64')), entry.sourceSha256);
        assert.equal(sha(Buffer.from(entry.runtimeBase64, 'base64')), entry.runtimeSha256);
    }
    assert.equal(entries.apriel.candidateSha256, '156b2758d8b75578b4cb08ffa090855697591dcea800cac152f2ee69fa84d4fe');
    assert.equal(entries.voxlock.candidateSha256, 'a7caa9bf22999193a6d2c8d33f36ba7c6d9c14f3f712519ecf41c7ca14c088ea');
    const a = entries.apriel, original = Buffer.from(a.candidateBase64, 'base64'), envelope = JSON.parse(original), sourceText = Buffer.from(a.sourceBase64, 'base64').toString();
    const runtime = JSON.parse(Buffer.from(a.runtimeBase64, 'base64'));
    const state = deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(envelope.payload.draft), envelope.payload.issues,
        { sourceText, structuredArtifacts: runtime.structuredArtifacts, paperId: envelope.identity.paperId,
            pixelFigureOrdinals: envelope.payload.imageEvidence.map(x => x.ordinal), draftOrderMappings: [] });
    assert.equal(repair.hashDraft(envelope.payload.draft), '9afbf78afdcabbd13e5d7cc095b2ac8849eb22825cc46a286f8112c39bf67225');
    assert.equal(repair.hashDraft(state.draft), '7a6b7e63dee265123b66b9433a0eb332095433c4e5c9d8b0539a7b7c00bbb58a');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-real-normalization-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, repair.hashDraft(envelope.identity) + '.json'); fs.writeFileSync(filename, original, { mode: 0o600 });
    normalization.createWriter({ directory, identity: envelope.identity, isActive: () => false }).queue({ expectedEnvelopeSha256: sha(original),
        draft: state.draft, draftOrderMappings: state.draftOrderMappings, issues: envelope.payload.issues });
    const after = repair.loadFailedCandidate(directory, envelope.identity);
    for (const [k, value] of Object.entries(envelope.payload)) if (!['draft','draftOrderMappings','issues'].includes(k)) assert.deepEqual(after[k], value, k);
    const v = entries.voxlock, vox = JSON.parse(Buffer.from(v.candidateBase64, 'base64'));
    assert.deepEqual(deep.readerResourceClaimIssues(vox.payload.draft, v.resourceIdentity, Buffer.from(v.sourceBase64, 'base64').toString()), []);
});
