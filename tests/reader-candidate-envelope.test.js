'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const repair = require('../scripts/lib/reader-repair');
const sample = { identity: { paperId: '2610.03352v1' }, payload: { status: 'failed', attempts: 0, fullAttempts: 0, noProgress: 0, failureSignature: '', issues: [], draft: null } };
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-single-read-'));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const identity = sample.identity;
    const payload = { ...sample.payload, explicitReaderRetryRound: undefined,
        readerRecoveryRevisions: [], implementationRepairAllowanceProof: null };
    repair.saveFailedCandidate(directory, identity, payload);
    return { directory, identity, filename: path.join(directory, repair.hashDraft(identity) + '.json') };
}
test('共享读取返回原 envelope 字节 SHA 与原 payload，拒绝坏正文和错文件名', t => {
    const f = fixture(t);
    const checked = repair.readFailedCandidateEnvelope(f.directory, null, f.filename);
    assert.deepEqual(repair.loadFailedCandidate(path.relative(process.cwd(), f.directory), f.identity), checked.envelope.payload);
    assert.deepEqual(checked.envelope.payload, repair.loadFailedCandidate(f.directory, f.identity));
    assert.equal(checked.envelopeSha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(f.filename)).digest('hex'));
    const bad = JSON.parse(fs.readFileSync(f.filename));
    bad.payload.attempts++;
    fs.writeFileSync(f.filename, JSON.stringify(bad));
    assert.throws(() => repair.readFailedCandidateEnvelope(f.directory, null, f.filename), /Corrupt/);
    const wrong = path.join(f.directory, 'b'.repeat(64) + '.json');
    fs.writeFileSync(wrong, JSON.stringify(checked.envelope), { mode: 0o600 });
    assert.throws(() => repair.readFailedCandidateEnvelope(f.directory, null, wrong), /Corrupt/);
});
test('读取中改写或替换候选拒绝；锁外目录与不安全权限拒绝', t => {
    const f = fixture(t);
    const original = fs.readFileSync;
    let changed = false;
    fs.readFileSync = function(filename, ...args) {
        const result = original.call(this, filename, ...args);
        if (typeof filename === 'number' && !changed) {
            changed = true;
            const replacement = f.filename + '.replacement';
            fs.writeFileSync(replacement, result, { mode: 0o600 });
            fs.renameSync(replacement, f.filename);
        }
        return result;
    };
    try {
        assert.throws(() => repair.readFailedCandidateEnvelope(f.directory, null, f.filename), /发生变化/);
    } finally { fs.readFileSync = original; }
    fs.chmodSync(f.filename, 0o644);
    assert.throws(() => repair.readFailedCandidateEnvelope(f.directory, null, f.filename), /permissions/);
    assert.throws(() => repair.readFailedCandidateEnvelope(f.directory, null, path.join(f.directory, '..', 'outside.json')), /当前私有目录/);
});
