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
const directContext = require('../scripts/lib/direct-rewrite-analysis-context.js');
const conferenceContext = require('../scripts/lib/conference-analysis-context.js');

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

test('diagnostic migration removes only a proven paragraph-final dangling connector', t => {
    const f = fixture(t);
    const dangling = '模型在 2 个数据集上有一定鲁棒性，但';
    const complete = '模型虽然下降，但回落更平缓，但未测试关系型提示。';
    f.payload.draft.sections[0].body = `${f.payload.draft.sections[0].body}\n\n${dangling}`;
    f.payload.draft.sections[1].body = `${f.payload.draft.sections[1].body}\n\n${complete}`;
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.ok(migrated.draft.sections[0].body.endsWith('模型在 2 个数据集上有一定鲁棒性。'));
    assert.ok(migrated.draft.sections[1].body.endsWith(complete));
    assert.equal(migrated.draft.sections[0].body.includes(dangling), false);
    assert.equal(migrated.readerRecoveryRevisions.at(-1).inputDraftSha256,
        hashDraft(f.payload.draft));
    assert.equal(migrated.readerRecoveryRevisions.at(-1).outputDraftSha256,
        hashDraft(migrated.draft));
});

test('diagnostic migration normalizes only an issue-bound stage count in ordinary prose', t => {
    const f = fixture(t);
    const protectedText = '`三阶段`、“三阶段”、$三阶段$、[[CONCEPT_BRIDGE_3]]';
    f.payload.draft.sections[0].body = `训练采用三阶段课程。\n\n${protectedText}`;
    f.payload.draft.sections[1].body = '未命中 issue 的两阶段流程保持原样。';
    f.payload.draft.conceptBridges[0] = { explanation: '课程学习连接三阶段数据。' };
    f.payload.issues = [{ path: null,
        message: '读者文章文风校验失败: quantitative_chinese_numeral:三阶段' }];
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(migrated.draft.sections[0].body,
        `训练采用 3 个阶段课程。\n\n${protectedText}`);
    assert.equal(migrated.draft.sections[1].body, '未命中 issue 的两阶段流程保持原样。');
    assert.equal(migrated.draft.conceptBridges[0].explanation,
        '课程学习连接 3 个阶段数据。');
    assert.notEqual(migrated.readerRecoveryRevisions.at(-1).inputDraftSha256,
        migrated.readerRecoveryRevisions.at(-1).outputDraftSha256);
});

test('ordinary calls and an unenabled fresh scope never scan or migrate an old candidate', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    assert.equal(loadReaderRecoveryRevision(f.directory, f.identity), null);
    assert.equal(withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: false }, () =>
        loadReaderRecoveryRevision(f.directory, f.identity)), null);
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('unenabled fresh scope wins over a nested direct source context used by daily analysis', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const sourceDetails = { paperId: `arxiv:${f.identity.paperId}`, source: 'html',
        sourceId: f.identity.paperId, text: 'sealed daily source',
        structuredArtifacts: { payloadSha256: f.context.sourceExpectations[f.identity.paperId].structuredArtifactsSha256 } };
    const loaded = withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: false }, () =>
        directContext.withDirectRewriteAnalysisSource({ paperId: `arxiv:${f.identity.paperId}`,
            runId: f.context.runId, route: 'arxiv-fresh-fetch', sourceDetails,
            sourceSha256: crypto.createHash('sha256').update(sourceDetails.text).digest('hex'),
            structuredArtifactsSha256: sourceDetails.structuredArtifacts.payloadSha256,
            sourceSnapshotSha256: 'c'.repeat(64), sourceGeneration: 1,
            sourceManifestSha256: 'd'.repeat(64), readerAttemptsDir: f.directory },
        () => loadReaderRecoveryRevision(f.directory, f.identity)));
    assert.equal(loaded, null);
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

test('a newly authenticated Reader capability policy cannot reuse a legacy failed candidate', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const policyIdentity = {
        ...f.oldIdentity,
        readerCapabilityPolicyContract: conferenceContext.WEAK_READER_CAPABILITY_POLICY_CONTRACT,
        readerCapabilityPolicySha256: conferenceContext.WEAK_READER_CAPABILITY_POLICY.policySha256
    };
    assert.equal(loadFailedCandidate(f.directory, policyIdentity), null);
    assert.equal(f.enabled(() => loadReaderRecoveryRevision(f.directory, policyIdentity)), null);
    assert.deepEqual(fs.readdirSync(f.directory), [`${hashDraft(f.oldIdentity)}.json`]);
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

test('historical direct scope migrates the same source-bound failed candidate after table compiler repair', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-direct-revision-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'reader-attempts'); const runId = crypto.randomUUID();
    const paperId = '2609.99970'; const text = 'sealed historical direct source';
    const sourceSha256 = crypto.createHash('sha256').update(text).digest('hex');
    const oldIdentity = { paperId, sourceSha256, inputFingerprint: 'same direct input',
        model: { model: 'test-model', maxTokens: 48000 }, promptSha256: 'p', repairPromptSha256: 'q',
        maxAttempts: 6, repairMaxTokens: 8000, tableCompilerSha256: '1'.repeat(64),
        repairImplementationSha256: '2'.repeat(64) };
    const identity = { ...oldIdentity, tableCompilerSha256: '3'.repeat(64),
        repairImplementationSha256: '4'.repeat(64) };
    const base = fixture(t); saveFailedCandidate(directory, oldIdentity, base.payload);
    const sourceDetails = { paperId: `arxiv:${paperId}`, source: 'pdf', sourceId: paperId, text,
        structuredArtifacts: { payloadSha256: 'b'.repeat(64) } };
    const enabled = (callback, overrides = {}) => {
        const scopedDetails = overrides.sourceDetails || sourceDetails;
        return directContext.withDirectRewriteAnalysisSource({ paperId: overrides.paperId || `arxiv:${paperId}`,
            runId: overrides.runId || runId, route: 'arxiv-fresh-fetch', sourceDetails: scopedDetails,
            sourceSha256: overrides.sourceSha256 || sourceSha256,
            structuredArtifactsSha256: scopedDetails.structuredArtifacts.payloadSha256,
            sourceSnapshotSha256: 'c'.repeat(64), sourceGeneration: 1,
            sourceManifestSha256: 'd'.repeat(64), readerAttemptsDir: overrides.readerAttemptsDir || directory }, callback);
    };
    const migrated = enabled(() => loadReaderRecoveryRevision(directory, identity));
    assert.equal(migrated.attempts, base.payload.attempts);
    assert.equal(migrated.validationFailureStreak, 0);
    assert.equal(migrated.readerRecoveryRevisions.at(-1).scope, 'historical-direct');
    assert.equal(migrated.readerRecoveryRevisions.at(-1).runId, runId);
    assert.match(migrated.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(enabled(() => loadReaderRecoveryRevision(directory, identity)), migrated);
    const wrong = { ...identity, sourceSha256: '0'.repeat(64) };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, wrong)), /historical direct run\/source scope/);
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), { runId: crypto.randomUUID() }),
        /implementation repair allowance|historical direct/i);
    const otherPaper = '2609.99969'; const otherDetails = { ...sourceDetails, paperId: `arxiv:${otherPaper}` };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), {
        paperId: `arxiv:${otherPaper}`, sourceDetails: otherDetails }), /implementation repair allowance|historical direct/i);
    const differentText = 'different sealed historical source';
    const differentDetails = { ...sourceDetails, text: differentText };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), {
        sourceDetails: differentDetails,
        sourceSha256: crypto.createHash('sha256').update(differentText).digest('hex')
    }), /implementation repair allowance|historical direct/i);
    const moved = path.join(root, 'moved-reader-attempts'); fs.cpSync(directory, moved, { recursive: true });
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(moved, identity)),
        /implementation repair allowance|historical direct/i);
    assert.throws(() => loadReaderRecoveryRevision(directory, identity),
        /implementation repair allowance|historical direct/i);
});

test('an exhausted paid budget retains its counters but receives exactly one implementation repair slot', t => {
    const f = fixture(t); const pointer = '/sections/8/body';
    const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2,
        issues: [{ path: null, message: `Reader patch rejected: Reader patch has stale node SHA: ${pointer}` }] };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.fullAttempts, 2);
    assert.equal(loaded.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    assert.match(loaded.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    const repair = require('../scripts/lib/reader-repair.js');
    const targets = repair.buildRepairTargets(loaded.draft, loaded.issues);
    assert.deepEqual(targets.map(target => target.path), [pointer]);
    assert.equal(targets[0].oldSha256, repair.hashDraft(loaded.draft.sections[8].body));
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

test('later implementation changes cannot stack new attempts after the lineage allowance was consumed', t => {
    const f = fixture(t); const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2 };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const first = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.match(first.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    saveFailedCandidate(f.directory, f.identity, { ...first, attempts: 7,
        implementationRepairAllowanceProof: null });
    const afterCall = loadFailedCandidate(f.directory, f.identity);
    assert.equal(afterCall.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    assert.ok(afterCall.consumedImplementationAllowanceSha256.includes(
        first.implementationRepairAllowanceProof.allowanceSha256));

    const nextIdentity = { ...f.identity, repairImplementationSha256: '9'.repeat(64) };
    const next = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity));
    assert.equal(next.attempts, 7);
    assert.equal(next.fullAttempts, 2);
    assert.equal(next.implementationRepairAllowanceProof, null);
    assert.equal(next.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    const repair = require('../scripts/lib/reader-repair.js');
    assert.equal(repair.readerAttemptLimit(6, next.attempts, next.draft, 0), 7);
});

test('an unused lineage allowance transfers across identity change without creating a second slot', t => {
    const f = fixture(t); const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2 };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const first = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const firstProof = first.implementationRepairAllowanceProof;
    const nextIdentity = { ...f.identity, repairImplementationSha256: '8'.repeat(64) };
    const transferred = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity));
    assert.match(transferred.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(transferred.implementationRepairAllowanceProof.allowanceSha256,
        firstProof.allowanceSha256);
    assert.ok(transferred.consumedImplementationAllowanceSha256.includes(firstProof.allowanceSha256));
    assert.equal(transferred.attempts, 6);
    const repair = require('../scripts/lib/reader-repair.js');
    assert.equal(repair.readerAttemptLimit(6, transferred.attempts, transferred.draft, 1), 7);
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

test('ephemeral direct/daily pixel bindings use their own payload field and reject drift', t => {
    const f = fixture(t);
    const oldIdentity = { ...f.identity, parserImplementationSha256: '4'.repeat(64) };
    const ephemeralImageEvidence = {
        imageEvidence: [{ ordinal: 1, sha256: '6'.repeat(64), url: 'https://example.invalid/figure.png' }],
        directSupplementaryEvidence: [{ ordinal: 2, sha256: '7'.repeat(64), mediaType: 'image/png', caption: null }]
    };
    const oldPayload = { ...f.payload, ephemeralImageEvidence };
    saveFailedCandidate(f.directory, oldIdentity, oldPayload);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, {
        ephemeralImageEvidenceSha256: hashDraft({ ...ephemeralImageEvidence,
            directSupplementaryEvidence: [{ ...ephemeralImageEvidence.directSupplementaryEvidence[0], sha256: '8'.repeat(64) }] })
    })), /ephemeral image evidence drifted/);
    assert.deepEqual(loadFailedCandidate(f.directory, oldIdentity), oldPayload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, {
        ephemeralImageEvidenceSha256: hashDraft(ephemeralImageEvidence)
    }));
    assert.deepEqual(migrated.ephemeralImageEvidence, ephemeralImageEvidence);
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
