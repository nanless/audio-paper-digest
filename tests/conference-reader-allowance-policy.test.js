'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const context = require('../scripts/lib/conference-analysis-context');
const repair = require('../scripts/lib/reader-repair');
const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision');

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-reader-allowance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executionId = '11111111-1111-4111-8111-111111111111';
    const executionDir = path.join(root, executionId); fs.mkdirSync(executionDir);
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const draft = sample.draft;
    draft.formulaBindings = [];
    draft.sections[4].body = draft.sections[4].body.replace('\n\n[[FORMULA_1]]', '');
    // Keep a real repairable Reader shape, but require an ordinary correction.
    draft.sections[0].body = '本段尚未写完。';
    const text = sample.sourceDetails.text;
    const artifactBody = { version: 1, sourceKind: 'conference_pdf',
        parserVersion: 'conference-pdf-structure-v2-visual-only-math-tables',
        tables: [], formulas: [], figures: [], flattenedTextSha256: repair.shaText(text) };
    const artifacts = { ...artifactBody, payloadSha256: deep.stableFingerprint(artifactBody) };
    const id = 'conference:interspeech:2026:conference-paper-id:allowance_fixture';
    const source = { source: 'conference_pdf_text', sourceId: id, text, structuredArtifacts: artifacts,
        conferenceCapabilities: { fullText: 'full', tables: 'unavailable', formulas: 'unavailable', figures: 'available' } };
    const scope = { executionId, executionDir, paperId: id, sourceDetails: source, readerRetryEpoch: 1 };
    const run = callback => context.withConferenceAnalysisSource(scope, callback);
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: repair.shaText(text), resources: [] };
    const resources = { ...resourceBody, identitySha256: deep.stableFingerprint(resourceBody) };
    const paper = { id, source: 'conference', sourceSha256: repair.shaText(text), analysis: 'paid main',
        title: 'Reader allowance fixture', apiReaderResources: resources };
    const evidence = deep.buildApiReaderEvidenceContext(paper.analysis, text, artifacts, id, null, resources);
    const options = { sourceText: text, structuredArtifacts: artifacts, readerResources: resources,
        readerMaterializeFigures: async () => [], readerRecordDisposition() {} };
    const { identity } = await run(() => deep.prepareApiReaderRetryIdentity(paper, paper.analysis, evidence, options));
    const oldIdentity = { ...identity, parserImplementationSha256: '0'.repeat(64) };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: '/sections/0/body', message: '原正文尚未完成' }], attempts: 6,
        fullAttempts: 1, noProgress: 2, failureSignature: 'original failed', transportFailures: 2,
        validationFailureStreak: 2, validationFailureSignature: 'original validation', imageEvidence: [] };
    return { run, identity, oldIdentity, payload, paper, evidence, options,
        directory: path.join(executionDir, 'reader-attempts') };
}

test('禁止新实现额度时保留全部计数与无进展，恢复版本再变也不授权', async t => {
    const f = await fixture(t);
    const oldFile = repair.saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const originalBytes = fs.readFileSync(oldFile);
    const migrated = f.run(() => loadReaderRecoveryRevision(f.directory, f.identity,
        { allowNewImplementationAllowance: false }));
    assert.equal(migrated.implementationRepairAllowanceProof, null);
    assert.equal(migrated.implementationRepairAllowanceLineage, undefined);
    const counters = ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature',
        'validationFailureStreak', 'validationFailureSignature'];
    for (const key of counters) assert.equal(migrated[key], f.payload[key], key);
    assert.equal(migrated.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, migrated.readerRecoveryRevisions.at(-1).archivedName)), originalBytes);
    const nextIdentity = { ...f.identity, readerRecoveryEpochSha256: '9'.repeat(64) };
    const next = f.run(() => loadReaderRecoveryRevision(f.directory, nextIdentity,
        { allowNewImplementationAllowance: false }));
    assert.equal(next.implementationRepairAllowanceProof, null);
    for (const key of counters) assert.equal(next[key], f.payload[key], key);
    assert.equal(repair.readerAttemptLimit(6, next.attempts, next.draft,
        repair.hasUnusedImplementationAllowance(next) ? 1 : 0), 6);
});

test('禁止新额度仍转交原已核验未消费许可，消费后不能再次授予', async t => {
    const f = await fixture(t);
    repair.saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    // The default compatibility policy remains unchanged for other callers.
    const first = f.run(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.ok(first.implementationRepairAllowanceProof);
    const existing = { ...first, noProgress: 1, failureSignature: 'retained failure',
        validationFailureStreak: 1, validationFailureSignature: 'retained validation' };
    f.run(() => repair.saveFailedCandidate(f.directory, f.identity, existing));
    const nextIdentity = { ...f.identity, parserImplementationSha256: '8'.repeat(64) };
    const transferred = f.run(() => loadReaderRecoveryRevision(f.directory, nextIdentity,
        { allowNewImplementationAllowance: false }));
    assert.ok(repair.hasUnusedImplementationAllowance(transferred));
    assert.notEqual(transferred.implementationRepairAllowanceProof.allowanceSha256,
        first.implementationRepairAllowanceProof.allowanceSha256);
    assert.ok(transferred.consumedImplementationAllowanceSha256.includes(first.implementationRepairAllowanceProof.allowanceSha256));
    for (const key of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature',
        'validationFailureStreak', 'validationFailureSignature']) assert.equal(transferred[key], existing[key], key);
    assert.equal(transferred.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
    f.run(() => repair.saveFailedCandidate(f.directory, nextIdentity, { ...transferred, attempts: 7,
        implementationRepairAllowanceProof: null }));
    const finalIdentity = { ...nextIdentity, readerRecoveryEpochSha256: '7'.repeat(64) };
    const final = f.run(() => loadReaderRecoveryRevision(f.directory, finalIdentity,
        { allowNewImplementationAllowance: false }));
    assert.equal(final.implementationRepairAllowanceProof, null);
    assert.equal(final.attempts, 7);
    assert.equal(final.noProgress, 1);
});

test('正常会议生成器在原第六次耗尽时不发第七次请求，原余额仍可正常续用', async t => {
    const f = await fixture(t);
    repair.saveFailedCandidate(f.directory, f.oldIdentity, { ...f.payload, noProgress: 0,
        failureSignature: '', validationFailureStreak: 0, validationFailureSignature: '' });
    let calls = 0;
    await assert.rejects(f.run(() => deep.generateApiReaderArticleDetailed(f.paper, f.paper.analysis, f.evidence,
        { ...f.options, allowNewImplementationAllowance: true, readerCallModel: async () => { calls++; throw new Error('unexpected model request'); } })),
    error => error.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED');
    assert.equal(calls, 0);
    const loaded = f.run(() => repair.loadFailedCandidate(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.implementationRepairAllowanceProof, null);
    // A separate untouched child with five original content attempts can still
    // enter its normal sixth attempt; a no-content failure preserves that count.
    const g = await fixture(t);
    repair.saveFailedCandidate(g.directory, g.oldIdentity, { ...g.payload, attempts: 5, noProgress: 0,
        failureSignature: '', validationFailureStreak: 0, validationFailureSignature: '' });
    await assert.rejects(g.run(() => deep.generateApiReaderArticleDetailed(g.paper, g.paper.analysis, g.evidence,
        { ...g.options, readerCallModel: async () => { calls++; throw new Error('test transport failure'); } })), /test transport failure/);
    assert.equal(calls, 1);
    const remaining = g.run(() => repair.loadFailedCandidate(g.directory, g.identity));
    assert.equal(remaining.attempts, 5); assert.equal(remaining.fullAttempts, 1);
    assert.equal(remaining.transportFailures, 3); assert.equal(remaining.implementationRepairAllowanceProof, null);
});

test('额度策略非法类型在读取候选或写入记录前拒绝', () => {
    for (const value of [null, 0, 'false', {}]) assert.throws(() =>
        loadReaderRecoveryRevision('/does-not-exist', {}, { allowNewImplementationAllowance: value }), /policy must be boolean/);
});
