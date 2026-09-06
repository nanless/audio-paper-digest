const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const { withFreshAnalysisContext } = require('../scripts/lib/fresh-analysis-context.js');
const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision.js');
const { saveFailedCandidate, loadFailedCandidate, hashDraft } = require('../scripts/lib/reader-repair.js');
const { READER_SECTION_KINDS, normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-revision-'));
    const previous = Config.FILES.freshRewriteRunsDir; Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), paperId = '2609.99971';
    fs.mkdirSync(runDir, { mode: 0o700 });
    const sourceExpectations = { [paperId]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1',
        runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const context = { runId, runDir, sourceExpectations, refreshReaderDiagnostics: true };
    const directory = path.join(runDir, 'reader-attempts');
    const oldIdentity = { paperId, freshAnalysis: { runId, paperId, ...sourceExpectations[paperId] },
        sourceSha256: 'a'.repeat(64), inputFingerprint: 'same input', model: { model: 'test-model', maxTokens: 48000 },
        promptSha256: 'p', repairPromptSha256: 'q', maxAttempts: 6, repairMaxTokens: 8000,
        repairImplementationSha256: 'c'.repeat(64) };
    const identity = { ...oldIdentity, repairImplementationSha256: 'd'.repeat(64),
        draftOrderContract: 'reader-draft-order-v1', draftOrderImplementationSha256: 'e'.repeat(64),
        sourceDiagnosticsImplementationSha256: 'f'.repeat(64),
        parserImplementationSha256: '1'.repeat(64), editorialImplementationSha256: '2'.repeat(64),
        mechanicalContractSha256: '3'.repeat(64) };
    const draft = { version: 3, readerTitle: '只读恢复测试正文', oneSentenceThesis: '保持所有来源和调用预算不变。',
        sections: READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    [draft.sections[6], draft.sections[7]] = [draft.sections[7], draft.sections[6]];
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: null, message: 'old diagnostic' }], attempts: 4, fullAttempts: 1,
        transportFailures: 2, noProgress: 2, failureSignature: 'old failure',
        validationFailureStreak: 2, validationFailureSignature: 'old normalized failure', imageEvidence: [] };
    return { root, context, directory, oldIdentity, identity, payload,
        enabled: fn => withFreshAnalysisContext(context, fn) };
}

test('explicit same-run revision preserves paid budgets, records mappings, archives evidence and is idempotent', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(migrated[key], f.payload[key]);
    assert.equal(migrated.noProgress, 0); assert.equal(migrated.failureSignature, '');
    assert.equal(migrated.validationFailureStreak, 0); assert.equal(migrated.validationFailureSignature, '');
    assert.match(migrated.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(migrated.draft, normalizeReaderDraftOrder(f.payload.draft).draft);
    assert.equal(migrated.draftOrderMappings.length, 1);
    assert.equal(migrated.readerRecoveryRevisions[0].oldNoProgress, 2);
    assert.equal(migrated.status, 'failed');
    const names = fs.readdirSync(f.directory);
    assert.equal(names.length, 2);
    const archive = names.find(name => name.includes('.migrated-'));
    assert.ok(archive);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, archive))).payload, f.payload);
    assert.equal(fs.statSync(path.join(f.directory, archive)).mode & 0o777, 0o600);
    assert.equal(loadFailedCandidate(f.directory, f.oldIdentity), null);
    assert.deepEqual(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), migrated);
    assert.deepEqual(fs.readdirSync(f.directory), names);
});

test('ordinary calls and an unenabled fresh scope never scan or migrate an old candidate', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    assert.equal(loadReaderRecoveryRevision(f.directory, f.identity), null);
    assert.equal(withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: false }, () =>
        loadReaderRecoveryRevision(f.directory, f.identity)), null);
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('source, model, prompt, run and budget drift cannot reuse a candidate', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    for (const mutate of [id => { id.model.maxTokens = 24000; }, id => { id.maxAttempts = 5; },
        id => { id.repairMaxTokens = 16000; }, id => { id.promptSha256 = 'new prompt'; },
        id => { id.repairPromptSha256 = 'new repair prompt'; }, id => { id.inputFingerprint = 'new input'; }]) {
        const identity = structuredClone(f.identity); mutate(identity);
        assert.equal(f.enabled(() => loadReaderRecoveryRevision(f.directory, identity)), null);
    }
    for (const mutate of [id => { id.sourceSha256 = '0'.repeat(64); }, id => { id.freshAnalysis.runId = crypto.randomUUID(); }]) {
        const identity = structuredClone(f.identity); mutate(identity);
        assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, identity)), /scope/);
    }
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('multiple compatible candidates refuse migration instead of guessing the latest budget', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    saveFailedCandidate(f.directory, { ...f.oldIdentity, repairImplementationSha256: '9'.repeat(64) }, { ...f.payload, attempts: 5 });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /Ambiguous/);
    assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('an exact new candidate wins without touching older candidates or its no-progress flag', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    saveFailedCandidate(f.directory, f.identity, { ...f.payload, attempts: 6 });
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.noProgress, 2);
    assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('only a changed implementation permits resetting no-progress, never the contract label alone', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, { ...f.oldIdentity, draftOrderContract: 'label only' }));
    assert.equal(loaded.noProgress, 2); assert.equal(loaded.failureSignature, 'old failure');
    assert.equal(loaded.readerRecoveryRevisions[0].clearedNoProgress, false);
});

test('a table-compiler implementation change migrates the draft for full revalidation without restoring budgets', t => {
    const f = fixture(t);
    const oldIdentity = { ...f.oldIdentity, repairImplementationSha256: f.identity.repairImplementationSha256,
        tableCompilerSha256: '1'.repeat(64) };
    const currentIdentity = { ...f.identity, tableCompilerSha256: '2'.repeat(64) };
    saveFailedCandidate(f.directory, oldIdentity, f.payload);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, currentIdentity));
    assert.equal(loaded.attempts, f.payload.attempts); assert.equal(loaded.fullAttempts, f.payload.fullAttempts);
    assert.equal(loaded.noProgress, 0); assert.equal(loaded.validationFailureStreak, 0);
    assert.match(loaded.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.ok(loaded.readerRecoveryRevisions[0].changedFields.includes('tableCompilerSha256'));
});

test('an exhausted paid budget retains its counters but receives exactly one implementation repair slot', t => {
    const f = fixture(t); const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2 };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.fullAttempts, 2);
    assert.match(loaded.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    const repair = require('../scripts/lib/reader-repair.js');
    assert.equal(repair.readerAttemptLimit(6, loaded.attempts, loaded.draft,
        loaded.implementationRepairAllowanceProof ? 1 : 0), 7);
    assert.equal(repair.readerAttemptLimit(6, 7, loaded.draft, 0), 7);
});

test('implementation allowance proof is consumed once and cannot be restored', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const proof = migrated.implementationRepairAllowanceProof;
    saveFailedCandidate(f.directory, f.identity, { ...migrated, implementationRepairAllowanceProof: null });
    const consumed = loadFailedCandidate(f.directory, f.identity);
    assert.ok(consumed.consumedImplementationAllowanceSha256.includes(proof.allowanceSha256));
    assert.throws(() => saveFailedCandidate(f.directory, f.identity,
        { ...consumed, implementationRepairAllowanceProof: proof }), /already consumed/);
});

test('parser, editorial and mechanical gate implementation changes each permit one diagnostic migration', async t => {
    for (const field of ['parserImplementationSha256', 'editorialImplementationSha256',
        'mechanicalContractSha256']) {
        await t.test(field, tt => {
            const f = fixture(tt); const baseline = structuredClone(f.identity);
            const oldIdentity = { ...baseline, [field]: '4'.repeat(64) };
            const currentIdentity = { ...baseline, [field]: '5'.repeat(64) };
            saveFailedCandidate(f.directory, oldIdentity, f.payload);
            const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, currentIdentity));
            assert.equal(loaded.attempts, f.payload.attempts);
            assert.equal(loaded.fullAttempts, f.payload.fullAttempts);
            assert.equal(loaded.validationFailureStreak, 0);
            assert.deepEqual(loaded.readerRecoveryRevisions.at(-1).changedFields, [field]);
        });
    }
});

test('pixel drift cannot migrate a candidate while an exact legacy pixel payload can be bound', t => {
    const f = fixture(t); const oldPixels = [{ ordinal: 1, sha256: '6'.repeat(64) }];
    const oldIdentity = { ...f.identity, parserImplementationSha256: '4'.repeat(64) };
    const oldPayload = { ...f.payload, imageEvidence: oldPixels };
    saveFailedCandidate(f.directory, oldIdentity, oldPayload);
    const changedPixels = hashDraft([{ ordinal: 1, sha256: '7'.repeat(64) }]);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity,
        { pixelEvidenceSha256: changedPixels })), /image evidence drifted/);
    assert.deepEqual(loadFailedCandidate(f.directory, oldIdentity), oldPayload);
});

test('corrupt and symlink candidate files fail closed before a new candidate is installed', t => {
    const f = fixture(t); const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    fs.writeFileSync(filename, '{invalid JSON', { mode: 0o600 });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /JSON/);
    fs.unlinkSync(filename); const target = path.join(f.root, 'outside.json');
    fs.writeFileSync(target, '{}', { mode: 0o600 }); fs.symlinkSync(target, filename);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ELOOP|symlink/i);
    assert.equal(fs.existsSync(path.join(f.directory, `${hashDraft(f.identity)}.json`)), false);
});

function interruptArchival(f) {
    const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from === filename && to.includes('.migrated-')) {
            const error = new Error('injected archive EIO'); error.code = 'EIO'; throw error;
        }
        return rename(from, to);
    };
    try { assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /archive EIO/); }
    finally { fs.renameSync = rename; }
    assert.ok(loadFailedCandidate(f.directory, f.identity));
    assert.ok(loadFailedCandidate(f.directory, f.oldIdentity));
    return filename;
}

test('archive EIO after installing new candidate is completed on exact-candidate reentry without resetting budgets', t => {
    const f = fixture(t); interruptArchival(f);
    const before = loadFailedCandidate(f.directory, f.identity);
    assert.match(before.readerRecoveryRevisions[0].oldEnvelopeSha256, /^[a-f0-9]{64}$/);
    assert.equal(before.readerRecoveryRevisions[0].oldPayloadSha256, hashDraft(f.payload));
    const resumed = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.deepEqual(resumed, before);
    assert.equal(resumed.attempts, 4); assert.equal(resumed.fullAttempts, 1); assert.equal(resumed.transportFailures, 2);
    assert.equal(loadFailedCandidate(f.directory, f.oldIdentity), null);
    assert.ok(fs.existsSync(path.join(f.directory, resumed.readerRecoveryRevisions[0].archivedName)));
    assert.deepEqual(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), resumed);
});

test('EIO reentry refuses complete old-payload drift even when draft and all counters are unchanged', t => {
    const f = fixture(t); interruptArchival(f);
    saveFailedCandidate(f.directory, f.oldIdentity, { ...f.payload,
        issues: [{ path: null, message: 'changed old diagnostics' }], imageEvidence: [{ changed: true }] });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /drifted/);
    assert.ok(loadFailedCandidate(f.directory, f.oldIdentity));
});

test('missing archive and old evidence refuse reentry, and archived bytes remain verified on later loads', t => {
    const f = fixture(t); const filename = interruptArchival(f);
    fs.unlinkSync(filename);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ENOENT|changed during audit/);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const resumed = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const archived = path.join(f.directory, resumed.readerRecoveryRevisions[0].archivedName);
    fs.appendFileSync(archived, '\n');
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /drifted/);
});

test('archive traversal and archive symlinks are refused on exact-candidate reentry', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const archive = path.join(f.directory, migrated.readerRecoveryRevisions[0].archivedName);
    const outside = path.join(f.root, 'archive-copy.json'); fs.renameSync(archive, outside); fs.symlinkSync(outside, archive);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ELOOP|symlink/i);
    const tampered = structuredClone(migrated); tampered.readerRecoveryRevisions[0].archivedName = '../outside.json';
    assert.throws(() => saveFailedCandidate(f.directory, f.identity, tampered), /allowance lacks a valid recovery-revision proof|ELOOP|symbolic/i);
});
