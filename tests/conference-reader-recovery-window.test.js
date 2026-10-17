'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const api = require('../scripts/lib/conference-reader-recovery-window');
const grant = require('../scripts/lib/conference-recovery-grant');
const context = require('../scripts/lib/conference-analysis-context');
const sourceApi = require('../scripts/lib/conference-source-context');
const engine = require('../scripts/analysis-engine');
const stop = require('../scripts/lib/analysis-stop-control');
const repair = require('../scripts/lib/reader-repair');
function fixture(t) {
    const f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t);
    const sourceHandle = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    const pdf = sourceApi.readerPdfSourceForContext(sourceHandle), sourceDetails = require('../scripts/lib/conference-analysis-adapter').sourceDetails(sourceHandle);
    const executionId = '11111111-1111-4111-8111-111111111111', analysisRoot = path.join(f.root, 'grant-analysis');
    const executionDir = path.join(analysisRoot, executionId); fs.mkdirSync(executionDir, { recursive: true, mode: 0o700 });
    const opaque = Object.freeze({}), registered = Object.freeze({ grantId: '22222222-2222-4222-8222-222222222222',
        grantSha256: '1'.repeat(64), processId: '33333333-3333-4333-8333-333333333333',
        analysisRoot, expectedExecutionId: executionId, sourceSha256: repair.shaText(sourceDetails.text),
        sourceSnapshotSha256: pdf.sourceSnapshotSha256, parentAnalysisFileSha256: '2'.repeat(64), failedAnalysisFileSha256: '3'.repeat(64),
        limits: { maxRounds: 3, readerContentResponses: 6, readerFullResponses: 2, readerTransportAttempts: 2 },
        assertUnchanged() { pdf.assertUnchanged(); } });
    // Root's separate registration tests own the 64-member permit. These tests
    // substitute only that upstream opaque admission, retaining real PDF/source
    // producer authority and the real canonical paper lock for budget behavior.
    t.mock.method(grant, 'readRecoveryGrantMember', (handle, paperId) => {
        assert.equal(handle, opaque); assert.equal(paperId, f.paperId); return registered;
    });
    const options = { paperId: f.paperId, executionId, executionDir, readerPdfSourceHandle: sourceHandle };
    const paper = { id: f.paperId, source: 'conference', sourceSha256: registered.sourceSha256 };
    const sourceScope = (callback, overrides = {}) => context.withConferenceAnalysisSource({ ...options, sourceDetails, ...overrides }, callback);
    const run = callback => engine.withPaperAnalysisLock(paper, () => sourceScope(() => api.withConferenceReaderGrant(opaque, options, callback)));
    const identity = () => ({ paperId: f.paperId, sourceSha256: registered.sourceSha256, maxAttempts: 6,
        promptSha256: '4'.repeat(64), repairPromptSha256: '5'.repeat(64), model: { model: 'test-no-network', protocol: 'fixture' },
        ...api.identityFields(paper, sourceDetails.text, path.join(executionDir, 'reader-attempts')) });
    return { ...f, opaque, options, paper, sourceDetails, sourceHandle, run, identity, sourceScope,
        ledgerFile: path.join(executionDir, 'reader-grant-budget.json') };
}

test('independent six/two response ledger is shared across three invocations, without modifying old history', async t => {
    const f = fixture(t), old = path.join(f.root, 'original-candidate.json');
    const original = Buffer.from('{"attempts":6,"fullAttempts":2,"noProgress":2,"validationFailureStreak":2}\n'); fs.writeFileSync(old, original);
    for (let round = 0; round < 3; round++) await f.run(() => {
        for (let offset = 1; offset <= 2; offset++) {
            const attempt = round * 2 + offset, kind = attempt <= 2 ? 'full' : 'patch';
            const lease = api.reserveReaderResponse(f.paper, f.identity(), kind, attempt);
            api.settleReaderResponse(lease, 'content', JSON.stringify({ syntheticTestResponse: attempt }));
        }
    });
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'patch', 6),
        { code: 'CONFERENCE_READER_GRANT_BUDGET_EXHAUSTED' }));
    const ledger = JSON.parse(fs.readFileSync(f.ledgerFile));
    assert.equal(ledger.requests.length, 6); assert.equal(ledger.requests.filter(row => row.kind === 'full').length, 2);
    for (const row of ledger.requests) assert.equal(repair.shaText(JSON.parse(fs.readFileSync(path.join(f.options.executionDir, row.responseFile))).rawResponse), row.outputTextSha256);
    assert.deepEqual(fs.readFileSync(old), original);
});

test('full cap, new candidate identity and unfinished requests cannot reopen the same window', async t => {
    const f = fixture(t);
    await f.run(() => {
        for (let attempt = 1; attempt <= 2; attempt++) api.settleReaderResponse(
            api.reserveReaderResponse(f.paper, f.identity(), 'full', attempt), 'truncated');
        assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'full', 3),
            { code: 'CONFERENCE_READER_GRANT_BUDGET_EXHAUSTED' });
        const identity = f.identity(); identity.promptSha256 = '0'.repeat(64);
        assert.throws(() => api.reserveReaderResponse(f.paper, identity, 'patch', 3), /逻辑输入/);
        api.reserveReaderResponse(f.paper, f.identity(), 'patch', 3);
    });
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'patch', 3), /尚未闭合/));
    assert.equal(JSON.parse(fs.readFileSync(f.ledgerFile)).requests.length, 3);
});

test('transport failures keep their original response allowance but have a durable independent cap', async t => {
    const f = fixture(t);
    for (let round = 0; round < 2; round++) await f.run(() => api.settleReaderResponse(
        api.reserveReaderResponse(f.paper, f.identity(), 'full', 1), 'no_content'));
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'full', 1),
        { code: 'CONFERENCE_READER_GRANT_BUDGET_EXHAUSTED' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.ledgerFile)).requests.map(row => row.status), ['no_content', 'no_content']);
});

test('source, paper lock, canonical execution and forbidden model scopes are mandatory', async t => {
    const f = fixture(t);
    assert.equal(api.getCurrentReaderWindow(f.paper), null);
    assert.deepEqual(api.identityFields(f.paper), {});
    assert.throws(() => f.sourceScope(() => api.withConferenceReaderGrant(f.opaque, f.options, () => true)), /论文锁/);
    await f.run(() => {
        assert.throws(() => api.getCurrentReaderWindow({ ...f.paper, arxivId: '2601.00001' }), /范围/);
        assert.throws(() => api.getCurrentReaderWindow(f.paper, f.sourceDetails.text + 'mutation'), /输入全文/);
        assert.throws(() => api.getCurrentReaderWindow(f.paper, undefined, path.join(f.root, 'unapproved-candidate')), /候选目录/);
        stop.withModelRequestsForbidden(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'full', 1),
            { code: stop.MODEL_REQUESTS_FORBIDDEN }));
        f.sourceScope(() => assert.throws(() => api.getCurrentReaderWindow(f.paper), /许可|来源|范围/),
            { executionDir: path.join(f.root, 'fake-temporary-clone') });
        const lease = api.reserveReaderResponse(f.paper, f.identity(), 'full', 1);
        stop.withModelRequestsForbidden(() => assert.throws(() => api.settleReaderResponse(lease, 'content', '{}'),
            { code: stop.MODEL_REQUESTS_FORBIDDEN }));
        api.settleReaderResponse(lease, 'no_content');
    });
});

test('reentry cold-verifies original response bytes and cannot recreate a deleted or trimmed ledger', async t => {
    const f = fixture(t);
    await f.run(() => api.settleReaderResponse(api.reserveReaderResponse(f.paper, f.identity(), 'full', 1), 'content', '{"original":true}'));
    const ledgerBytes = fs.readFileSync(f.ledgerFile), ledger = JSON.parse(ledgerBytes);
    const responseFile = path.join(f.options.executionDir, ledger.requests[0].responseFile);
    const responseBytes = fs.readFileSync(responseFile);
    fs.appendFileSync(responseFile, ' ');
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'patch', 2), /原材料无法冷核/));
    fs.writeFileSync(responseFile, responseBytes);
    fs.unlinkSync(f.ledgerFile);
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'full', 1), /账本缺失/));
    fs.writeFileSync(f.ledgerFile, JSON.stringify({ ...ledger, requests: [] }));
    await f.run(() => assert.throws(() => api.reserveReaderResponse(f.paper, f.identity(), 'full', 1), /裁剪/));
    fs.writeFileSync(f.ledgerFile, ledgerBytes);
    await f.run(() => api.settleReaderResponse(api.reserveReaderResponse(f.paper, f.identity(), 'patch', 2), 'no_content'));
    assert.equal(JSON.parse(fs.readFileSync(f.ledgerFile)).requests.length, 2);
});

test('real registered grant capability, deterministic new execution and immutable original CAS feed the same budget', async t => {
    const f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t);
    const adapter = require('../scripts/lib/conference-analysis-adapter');
    const helpers = require('./helpers/conference-recovery-grant-fixture');
    const ids = helpers.recoveryFixtureIdentity(f.paperId);
    const analysisRoot = path.join(f.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId: ids.parentExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: ids.parentExecutionId, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    const sourceSha256 = repair.shaText(parent.source.sourceDetails.text);
    // Synthetic stage records establish only this offline registration fixture;
    // neither the grant nor the budget proves publication or model success.
    const paper = { ...parent.analysis.papers[0], sourceSha256,
        analysis: require('./valid-analysis-fixture').validAnalysisText(),
        analysisManifest: { sourceAcquisition: { sourceSha256, modelTextSanitizationContract: 'model-text-unicode-scalars-v1' },
            stages: { primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
                scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-17T12:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    t.mock.method(require('../scripts/lib/conference-postprocess'), 'readOriginalTagProof', () => ({ rules: {} }));
    await assert.rejects(adapter.refreshConferenceReader(input, {
        engine: { withPaperAnalysisLock: engine.withPaperAnalysisLock,
            LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
            getConferenceReaderRefreshUpstreamReason: () => null,
            isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false },
        deep: { buildApiReaderResourceIdentity: require('../scripts/deep-analyzer').buildApiReaderResourceIdentity,
            inspectSavedConferenceReaderCompletion: async () => null,
            refreshApiReaderArticleFromSource: async () => { throw Error('offline fixture original failure'); } }
    }), /offline fixture original failure/);
    const failedExecutionId = adapter.readerRevisionExecutionId(ids.parentExecutionId, parent.analysisFileSha256);
    const registered = helpers.registerRecoveryFixture({ analysisRoot, parentExecutionId: ids.parentExecutionId, failedExecutionId, paperId: f.paperId });
    const member = grant.readRecoveryGrantMember(registered.handle, f.paperId);
    const executionDir = path.join(analysisRoot, member.expectedExecutionId);
    fs.mkdirSync(executionDir, { mode: 0o700 });
    const sourceHandle = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    const options = { paperId: f.paperId, executionId: member.expectedExecutionId, executionDir, readerPdfSourceHandle: sourceHandle };
    const sourceDetails = adapter.sourceDetails(sourceHandle);
    const run = callback => engine.withPaperAnalysisLock(paper, () => context.withConferenceAnalysisSource({ ...options, sourceDetails },
        () => api.withConferenceReaderGrant(registered.handle, options, callback)));
    const usage = require('../scripts/lib/llm-usage');
    await usage.withLlmUsageContext({ runId: '99999999-9999-4999-8999-999999999999', unitId: 'f'.repeat(64), stage: 'outerFixture' }, async () => {
        const outer = usage.usageContext();
        await run(async () => {
            const identity = { paperId: f.paperId, promptSha256: '4'.repeat(64), ...api.identityFields(paper, sourceDetails.text) };
            api.settleReaderResponse(api.reserveReaderResponse(paper, identity, 'full', 1), 'content', '{"offlineFixture":1}');
            for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit', 'apiReaderArticle']) {
                const event = await usage.withLlmUsageContext({ stage }, async () => {
                    await Promise.resolve();
                    return usage.buildLlmUsageEvent({ request: {}, context: { contentAttempt: 1 } });
                });
                assert.equal(event.runId, registered.manifest.grantId);
                assert.equal(event.unitId, repair.shaText(member.expectedExecutionId));
                assert.equal(event.paperId, f.paperId); assert.equal(event.stage, stage);
                assert.equal(event.contentAttempt, 1);
            }
        });
        assert.deepEqual(usage.usageContext(), outer);
    });
    const original = fs.readFileSync(path.join(registered.failed.directory, 'analysis.json'));
    fs.appendFileSync(path.join(registered.failed.directory, 'analysis.json'), ' ');
    await assert.rejects(run(() => true), /原父稿|CAS|已变化/);
    fs.writeFileSync(path.join(registered.failed.directory, 'analysis.json'), original);
    await run(() => assert.equal(api.getCurrentReaderWindow(paper).grantId, registered.manifest.grantId));
});

test('normal shared Reader generator resumes one candidate and never issues a third full response in later rounds', async t => {
    const f = fixture(t), deep = require('../scripts/deep-analyzer');
    let calls = 0;
    const options = { sourceText: f.sourceDetails.text, structuredArtifacts: f.sourceDetails.structuredArtifacts,
        readerMaxAttempts: 6, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => {
            calls++;
            throw Object.assign(Error('offline content truncation fixture'), { code: 'MODEL_OUTPUT_TRUNCATED' });
        } };
    await f.run(async () => { f.paper.apiReaderResources = await deep.buildApiReaderResourceIdentity(f.paper, f.sourceDetails.text); });
    for (let round = 0; round < 2; round++) await f.run(() => assert.rejects(
        deep.generateApiReaderArticleDetailed(f.paper, '', '', options), { code: 'MODEL_OUTPUT_TRUNCATED' }));
    await f.run(() => assert.rejects(deep.generateApiReaderArticleDetailed(f.paper, '', '', options), /次数已用完|全文|预算/));
    assert.equal(calls, 2);
    const ledger = JSON.parse(fs.readFileSync(f.ledgerFile));
    assert.deepEqual(ledger.requests.map(row => [row.kind, row.status]), [['full', 'truncated'], ['full', 'truncated']]);
    const attempts = path.join(f.options.executionDir, 'reader-attempts');
    const files = fs.readdirSync(attempts).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    assert.equal(files.length, 1);
    const identity = JSON.parse(fs.readFileSync(path.join(attempts, files[0]))).identity;
    const { envelope } = repair.readFailedCandidateEnvelope(attempts, identity, path.join(attempts, files[0]));
    assert.equal(envelope.payload.attempts, 2); assert.equal(envelope.payload.fullAttempts, 2);
    assert.equal(envelope.identity.conferenceReaderGrant.grantId, apiGrantId(f));
});

function apiGrantId(f) { return JSON.parse(fs.readFileSync(f.ledgerFile)).binding.grantId; }

test('cold read-only scope binds identical identities across await, needs no write lock and cannot reserve or settle', async t => {
    const f = fixture(t); let originalIdentity, liveLease;
    await f.run(() => {
        originalIdentity = f.identity();
        api.settleReaderResponse(api.reserveReaderResponse(f.paper, originalIdentity, 'full', 1), 'content', '{"paidFixture":true}');
        liveLease = api.reserveReaderResponse(f.paper, originalIdentity, 'patch', 2);
    });
    const before = fs.readFileSync(f.ledgerFile);
    await f.sourceScope(() => api.withConferenceReaderGrantReadOnly(f.opaque, f.options, async () => {
        await Promise.resolve();
        assert.deepEqual(f.identity(), originalIdentity);
        assert.throws(() => api.reserveReaderResponse(f.paper, originalIdentity, 'patch', 2), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        assert.throws(() => api.settleReaderResponse(liveLease, 'content', '{}'), /作用域/);
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
    }));
    assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
    const ledger = JSON.parse(before), filename = path.join(f.options.executionDir, ledger.requests[0].responseFile);
    fs.appendFileSync(filename, ' ');
    assert.throws(() => f.sourceScope(() => api.withConferenceReaderGrantReadOnly(f.opaque, f.options, () => true)), /原材料无法冷核/);
});
