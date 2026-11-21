'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), crypto = require('node:crypto');
const realFile = process.env.PD_NORMAL_READER_ORDINAL_REAL_FILE;
const realSha256 = process.env.PD_NORMAL_READER_ORDINAL_REAL_SHA256;
const saved = require('../scripts/lib/saved-fact-feedback');
const engine = require('../scripts/analysis-engine');
const fresh = require('../scripts/lib/fresh-analysis-context');
const facts = require('../scripts/lib/daily-fact-review');
const ordinal = require('../scripts/lib/reader-target-ordinal-patch');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sample = () => ({ arxivId: '2611.25808v1', analysis: 'protected upstream',
    analysisManifest: { stages: { apiReaderArticle: { ordinalCompletionProof: { path: '/original', sha256: 'a'.repeat(64) } } } } });

test('ordinary rejected Reader authenticates and retains its original ordinal history without Reader feedback', t => {
    t.mock.method(engine, 'paperAnalysisLockHeld', () => true);
    t.mock.method(fresh, 'isDailyFreshSourceScope', () => true);
    t.mock.method(facts, 'current', () => null);
    const paper = sample(), calls = [];
    t.mock.method(ordinal, 'hasActiveCompletion', p => { assert.equal(p, paper); calls.push('authenticated'); return true; });
    t.mock.method(ordinal, 'supersedeOrdinalCompletionBeforeReset', p => { assert.equal(p, paper); calls.push('history'); return true; });
    t.mock.method(ordinal, 'validateCompletion', () => { throw Error('current rejected content must reach normal recovery'); });
    assert.equal(saved.prepareNormalReaderOrdinalSupersession(paper), true);
    assert.deepEqual(calls, ['authenticated', 'history']);
    assert.equal(paper.analysis, 'protected upstream');
});

test('normal ordinal recovery refuses missing lock, foreign scope, Reader feedback and damaged origin', t => {
    let locked = true, daily = true, feedback = null, completion = true, writes = 0;
    t.mock.method(engine, 'paperAnalysisLockHeld', () => locked);
    t.mock.method(fresh, 'isDailyFreshSourceScope', () => daily);
    t.mock.method(facts, 'current', () => feedback);
    t.mock.method(ordinal, 'hasActiveCompletion', () => { if (completion instanceof Error) throw completion; return completion; });
    t.mock.method(ordinal, 'supersedeOrdinalCompletionBeforeReset', () => { writes++; return true; });
    for (const mutate of [() => { locked = false; }, () => { daily = false; }, () => { feedback = { readerOnly: true }; }]) {
        locked = true; daily = true; feedback = null; mutate();
        assert.throws(() => saved.prepareNormalReaderOrdinalSupersession(sample()), /locked actual daily source/);
    }
    locked = true; daily = true; feedback = null; completion = false;
    assert.throws(() => saved.prepareNormalReaderOrdinalSupersession(sample()), /authenticated original completion/);
    completion = Error('normal final completion/source/stage differs');
    assert.throws(() => saved.prepareNormalReaderOrdinalSupersession(sample()), /completion\/source\/stage differs/);
    assert.equal(writes, 0);
    assert.equal(saved.prepareNormalReaderOrdinalSupersession({}), false);
});

test('completed-source recovery requires explicit diagnostics and an unforgeable preparation handle', t => {
    const recovery = require('../scripts/lib/reader-completed-source-recovery');
    const paper = sample(), text = 'actual bound source';
    paper.sourceSha256 = sha(text); paper.freshRewriteProvenance = { runId: 'same-run' };
    t.mock.method(engine, 'paperAnalysisLockHeld', () => true);
    t.mock.method(fresh, 'isDailyFreshSourceScope', () => true);
    t.mock.method(fresh, 'getFreshAnalysisContext', () => ({ refreshReaderDiagnostics: false }));
    t.mock.method(facts, 'current', () => null);
    t.mock.method(require('../scripts/lib/model-text-sanitization'), 'currentModelInputSource', () =>
        ({ text, freshSourceDescriptor: { runId: 'same-run' } }));
    t.mock.method(ordinal, 'hasActiveCompletion', () => { throw Error('archive replay must not start without explicit diagnostics'); });
    assert.throws(() => recovery.prepare(paper), /batch -- --refresh-reader-diagnostics/);
    assert.throws(() => recovery.plan({}, paper, {}, ''), /私有恢复句柄/);
    assert.throws(() => recovery.validateSavedPayload('/unused', {}, { completedSourceReaderRecovery: {} }), /原账派生证明损坏/);
});

// Opt-in read-only replay of SHA-bound real saved bytes. Only the held-lock
// predicate is simulated: no production lock, usage, candidate or source writes.
test('actual rejected Reader retains exact source-bound paid ordinal completion and counters',
    { skip: !realFile }, async t => {
        const file = realFile;
        const bytes = fs.readFileSync(file);
        assert.equal(sha(bytes), realSha256);
        const formal = JSON.parse(bytes), parent = formal.papers.find(p => p.arxivId === '2611.25808v1');
        assert.ok(parent);
        const paper = structuredClone(parent), original = structuredClone(parent);
        const stage = original.analysisManifest.stages.apiReaderArticle;
        const proofBytes = fs.readFileSync(stage.ordinalCompletionProof.path);
        assert.equal(sha(proofBytes), stage.ordinalCompletionProof.sha256);
        const deny = () => { throw Error('NORMAL_ORDINAL_REPLAY_NETWORK_FORBIDDEN'); };
        t.mock.method(require('node:net').Socket.prototype, 'connect', deny);
        t.mock.method(require('node:tls'), 'connect', deny);
        for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) t.mock.method(require(name), method, deny);
        t.mock.method(globalThis, 'fetch', deny);
        t.mock.method(engine, 'paperAnalysisLockHeld', () => true);
        const daily = require('../scripts/lib/daily-fresh-source-plan');
        const plan = daily.readDailyFreshSourcePlan(formal.dailyFreshSourceRun);
        await daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, async () => {
            assert.equal(facts.current('2611.25808'), null);
            assert.equal(ordinal.hasActiveCompletion(paper), true);
            assert.equal(saved.prepareNormalReaderOrdinalSupersession(paper), true);
            assert.deepEqual(paper.readerRevisionHistory.completionProof, stage.ordinalCompletionProof);
            assert.deepEqual(paper.readerRevisionHistory.previousOrdinalPatchCompilations, stage.ordinalPatchCompilations);
            assert.equal(paper.readerRevisionHistory.previousArticleSha256, stage.articleSha256);
            assert.equal(paper.readerRevisionHistory.previousPlanSha256, stage.planSha256);
            delete paper.readerRevisionHistory;
            assert.deepEqual(paper, original);
            const damaged = structuredClone(original);
            damaged.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof.sha256 = '0'.repeat(64);
            assert.throws(() => saved.prepareNormalReaderOrdinalSupersession(damaged));
            assert.equal(damaged.readerRevisionHistory, undefined);
            const recovery = require('../scripts/lib/reader-completed-source-recovery');
            const handle = recovery.prepare(paper), source = require('../scripts/lib/model-text-sanitization').currentModelInputSource(paper);
            const deep = require('../scripts/deep-analyzer');
            const evidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts, paper.arxivId,
                null, paper.apiReaderResources, false);
            const { identity } = await deep.prepareApiReaderRetryIdentity(paper, paper.analysis, evidence, {
                sourceText: source.text, structuredArtifacts: source.structuredArtifacts, readerResources: paper.apiReaderResources });
            const planned = recovery.plan(handle, paper, identity, stage.modelImagePreflightEvidenceSha256);
            assert.equal(planned.payload.attempts, 3);
            assert.equal(planned.payload.fullAttempts, 2);
            assert.equal(planned.proof.targets.length, 1);
            assert.equal(planned.proof.targets[0].path, '/tableBindings/1');
            assert.throws(() => recovery.plan(handle, paper, { ...identity, sourceSha256: '0'.repeat(64) },
                stage.modelImagePreflightEvidenceSha256), /改变原输入/);
            const changedParent = structuredClone(paper); changedParent.analysis += 'changed';
            assert.throws(() => recovery.plan(handle, changedParent, identity, stage.modelImagePreflightEvidenceSha256), /父稿改变/);
            assert.throws(() => recovery.plan(handle, paper, identity, '0'.repeat(64)), /模型原图输入改变/);
            // Exercise install and a later normal resume without writing the
            // production directory. Origin/source/paid-file reads stay real;
            // only child-candidate persistence is replaced by an in-memory disk.
            const repair = require('../scripts/lib/reader-repair'), path = require('node:path');
            const originalList = fs.readdirSync, originalRead = repair.readFailedCandidateEnvelope;
            const activeName = repair.hashDraft(identity) + '.json';
            let child = null, saves = 0, laterCompletion = null;
            t.mock.method(fs, 'readdirSync', (directory, ...args) => {
                const names = originalList(directory, ...args);
                if (laterCompletion && path.resolve(directory) === path.join(planned.directory, 'ordinal-completions'))
                    return [...names, laterCompletion];
                return path.resolve(directory) === path.resolve(planned.directory) && child
                    ? [...names, activeName] : names;
            });
            t.mock.method(repair, 'readFailedCandidateEnvelope', (directory, requested, filename, ...args) =>
                child && filename && path.resolve(filename) === path.join(planned.directory, activeName)
                    ? { envelope: child, envelopeSha256: repair.hashDraft(child) }
                    : originalRead(directory, requested, filename, ...args));
            t.mock.method(repair, 'saveFailedCandidate', (directory, savedIdentity, payload) => {
                assert.equal(directory, planned.directory); assert.deepEqual(savedIdentity, identity);
                recovery.validateSavedPayload(directory, savedIdentity, payload);
                child = { identity: structuredClone(savedIdentity), payload: structuredClone(payload), payloadSha256: repair.hashDraft(payload) };
                saves++;
            });
            recovery.install(handle, paper, identity, stage.modelImagePreflightEvidenceSha256);
            assert.equal(saves, 1);
            assert.equal(child.payload.attempts, 3); assert.equal(child.payload.fullAttempts, 2);
            const firstProof = structuredClone(child.payload.completedSourceReaderRecovery);
            const resumed = structuredClone(paper);
            resumed.latestAnalysisAttemptError = 'later persisted ordinary recovery failure';
            saved.prepareNormalReaderOrdinalSupersession(resumed);
            const next = recovery.prepare(resumed);
            const nextPlan = recovery.plan(next, resumed, identity, stage.modelImagePreflightEvidenceSha256);
            assert.deepEqual(nextPlan.proof, firstProof);
            recovery.install(next, resumed, identity, stage.modelImagePreflightEvidenceSha256);
            assert.equal(saves, 1, 'resume must retain the existing child rather than install a fresh ledger');
            const decreased = structuredClone(child.payload); decreased.attempts = 2;
            assert.throws(() => recovery.validateSavedPayload(planned.directory, identity, decreased), /减少次数/);
            const extraFull = structuredClone(child.payload); extraFull.fullAttempts = 3;
            assert.throws(() => recovery.validateSavedPayload(planned.directory, identity, extraFull), /减少次数/);
            const planner = require('../scripts/lib/reader-next-request-plan');
            const repairContext = { targets: planned.proof.targets };
            const request = planner.withReaderLocalRequestsOnly(() => planner.buildReaderNextRequestPlan({
                attempts: 3, fullAttempts: 2, transportFailures: 0, noProgress: 0, validationFailureStreak: 0,
                attemptLimit: 6, maxFullResponses: 2, nextContentAttempt: 4, repairContext, issues: planned.payload.issues }));
            assert.equal(request.nextKind, 'patch'); assert.equal(request.remainingResponses, 3);
            assert.equal(request.permittedFullResponses, 0); assert.equal(request.localOnly, true);
            // A later ordinary seal appends the index. Its existence must not
            // erase the earlier origin, or grant that earlier parent current
            // completion. This is a synthetic index observation, not new paid
            // content or a fabricated second completion record.
            laterCompletion = '2611.25808-00000002.json';
            assert.throws(() => ordinal.hasActiveCompletion(original), /latest completion not selected/);
            assert.equal(ordinal.authenticateHistoricalCompletion(original), true);
            recovery.validateSavedPayload(planned.directory, identity, child.payload);
            assert.throws(() => recovery.prepare(original), /latest completion not selected/);
            laterCompletion = '2611.25808-00000003.json';
            assert.throws(() => ordinal.authenticateHistoricalCompletion(original), /history has gaps/);
            laterCompletion = null;
        }), { refreshReaderDiagnostics: true });
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.deepEqual(fs.readFileSync(stage.ordinalCompletionProof.path), proofBytes);
    });
