'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
// Real plan/PDF and adapter records; stage/proof doubles below exercise only
// orchestration. They never certify production payment or paper completion.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const actualEngine = require('../scripts/analysis-engine');
const deep = require('../scripts/deep-analyzer');
const stop = require('../scripts/lib/analysis-stop-control');
const context = require('../scripts/lib/conference-analysis-context');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const { recoveryFixtureIdentity, registerRecoveryFixture } = require('./helpers/conference-recovery-grant-fixture');

async function setup(t) {
    const f = productionPlanFixture(t), identity = recoveryFixtureIdentity(f.paperId);
    const analysisRoot = path.join(f.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId: identity.parentExecutionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: identity.parentExecutionId, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    const analysis = require('./valid-analysis-fixture').validAnalysisText().replace('## 核心摘要\n',
        '## 核心摘要\n原文未提供可核对的关键定量结果。');
    const paper = { ...parent.analysis.papers[0], analysis, apiReaderArticle: 'original Reader',
        analysisManifest: { sourceAcquisition: { sourceSha256: parent.analysis.papers[0].sourceSha256,
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' }, stages: {
            primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
            scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis,
        status: 'complete', completedAt: '2026-10-18T00:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    const post = require('../scripts/lib/conference-postprocess');
    t.mock.method(post, 'readOriginalTagProof', () => ({ rules: {} }));
    const state = { requestCalls: 0, replayCalls: 0, qualify: true, replay: 'ineligible', saved: false };
    const engine = { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: actualEngine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        withPaperAnalysisLock: actualEngine.withPaperAnalysisLock, paperAnalysisLockHeld: actualEngine.paperAnalysisLockHeld,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: value => {
            assert.ok(actualEngine.paperAnalysisLockHeld({ id: f.paperId }));
            assert.equal(context.getConferenceAnalysisSource(value).text, parent.source.sourceDetails.text);
            return state.qualify && value.apiReaderArticle === 'replayed Reader';
        } };
    const operations = { buildApiReaderResourceIdentity: deep.buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async value => state.saved && value.apiReaderArticle === 'replayed Reader'
            ? { verified: true } : null,
        refreshApiReaderArticleFromSource: async () => { state.requestCalls++; throw Error('synthetic prior Reader failure'); } };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine, deep: operations }), /synthetic prior Reader failure/);
    const executionId = adapter.readerRevisionExecutionId(input.parentExecutionId, parent.analysisFileSha256);
    const query = { analysisRoot, executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    const overrides = { engine, deep: operations, replayActiveReaderCandidate: async ({ loaded }) => {
        state.replayCalls++;
        assert.ok(actualEngine.paperAnalysisLockHeld({ id: f.paperId }));
        assert.throws(() => stop.assertMayStartRequest(), error => error.code === stop.MODEL_REQUESTS_FORBIDDEN);
        if (state.replay === 'ineligible') return { eligible: false, reason: 'actual candidate still rejected' };
        const paper = structuredClone(loaded.analysis.papers[0]); paper.apiReaderArticle = 'replayed Reader';
        if (state.replay === 'upstream-drift') paper.analysisManifest.stages.primaryAnalysis.changed = true;
        return { eligible: true, paper, proof: { contract: 'synthetic-active-paid-proof' },
            assertUnchanged: () => { if (state.replay === 'cas-drift') throw Error('original paid bytes changed'); } };
    } };
    return { ...f, input, query, overrides, state, parent, operations, engine };
}
function snapshot(directory) {
    const result = {};
    function visit(folder) { for (const name of fs.readdirSync(folder)) {
        const file = path.join(folder, name);
        if (fs.statSync(file).isDirectory()) { result[path.relative(directory, file) + '/'] = 'directory'; visit(file); }
        else result[path.relative(directory, file)] = fs.readFileSync(file).toString('base64');
    } }
    visit(directory); return result;
}

test('savedOnly不合格候选在耗尽原轮数后仍零写返回，不进入模型/错误保存', async t => {
    const f = await setup(t), loaded = adapter.loadConferenceReaderRevision(f.query);
    adapter.replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis,
        readerRevisionProgress: { ...loaded.analysis.readerRevisionProgress, attempts: 3 } }, loaded.analysisFileSha256);
    const before = snapshot(f.query.analysisRoot);
    const result = await adapter.replaySavedConferenceReaderRevision(f.query, f.overrides);
    assert.equal(result.status, 'partial'); assert.equal(result.recovered, false); assert.equal(result.savedOnly, true);
    assert.match(result.reason, /still rejected/); assert.equal(f.state.requestCalls, 1);
    assert.deepEqual(snapshot(f.query.analysisRoot), before);
});

test('savedOnly完整资格/科学阶段/原候选CAS仍严格，成功保存不新增尝试或费用', async t => {
    const f = await setup(t), loaded = adapter.loadConferenceReaderRevision(f.query);
    const before = snapshot(f.query.analysisRoot), progress = structuredClone(loaded.analysis.readerRevisionProgress);
    f.state.replay = 'valid'; f.state.qualify = false;
    await assert.rejects(adapter.replaySavedConferenceReaderRevision(f.query, f.overrides), /正常整篇资格/);
    assert.deepEqual(snapshot(f.query.analysisRoot), before);
    f.state.qualify = true;
    for (const [mode, message] of [['upstream-drift', /受保护原阶段/], ['cas-drift', /original paid bytes/]]) {
        f.state.replay = mode;
        await assert.rejects(adapter.replaySavedConferenceReaderRevision(f.query, f.overrides), message);
        assert.deepEqual(snapshot(f.query.analysisRoot), before);
    }
    f.state.replay = 'valid';
    const result = await adapter.replaySavedConferenceReaderRevision(f.query, f.overrides);
    assert.equal(result.status, 'complete'); assert.equal(result.recoveredActivePaidReader, true);
    const saved = adapter.loadConferenceReaderRevision(f.query);
    assert.equal(saved.run.status, 'complete'); assert.deepEqual(saved.analysis.readerRevisionProgress, progress);
    assert.equal(saved.parent.analysisFileSha256, f.parent.analysisFileSha256);
    assert.equal(f.state.requestCalls, 1);
    const complete = snapshot(f.query.analysisRoot); f.state.qualify = false;
    await assert.rejects(adapter.replaySavedConferenceReaderRevision(f.query, f.overrides), /完整资格/);
    assert.deepEqual(snapshot(f.query.analysisRoot), complete);
});

test('savedOnly已有签发稿恢复及已持真实论文锁调用均复用原continue，不重入死锁', async t => {
    const f = await setup(t), loaded = adapter.loadConferenceReaderRevision(f.query), paper = structuredClone(loaded.analysis.papers[0]);
    paper.apiReaderArticle = 'replayed Reader';
    adapter.replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis, papers: [paper] }, loaded.analysisFileSha256);
    f.state.saved = true;
    const result = await actualEngine.withPaperAnalysisLock({ id: f.paperId }, () =>
        adapter.replaySavedConferenceReaderRevision(f.query, f.overrides));
    assert.equal(result.status, 'complete'); assert.equal(result.recoveredSavedReader, true);
    assert.equal(f.state.replayCalls, 0); assert.equal(f.state.requestCalls, 1);
});

test('savedOnly不准备缺失子稿，也不扩展未完成normal-analysis的Reader权限', async t => {
    const f = await setup(t), loaded = adapter.loadConferenceReaderRevision(f.query), before = snapshot(f.query.analysisRoot);
    await assert.rejects(adapter.replaySavedConferenceReaderRevision({ ...f.query,
        executionId: '99999999-9999-4999-8999-999999999999' }, f.overrides), /ENOENT|lacks prepare intent/);
    assert.deepEqual(snapshot(f.query.analysisRoot), before);
    const file = path.join(loaded.directory, 'reader-revision.json'), { revisionSha256, ...body } = loaded.revision;
    body.mode = 'normal-analysis';
    adapter.replaceJson(file, { ...body, revisionSha256: adapter.stableHash(body) }, adapter.readJsonRecord(file).sha256);
    const changed = snapshot(f.query.analysisRoot);
    const result = await adapter.replaySavedConferenceReaderRevision(f.query, f.overrides);
    assert.equal(result.status, 'partial'); assert.match(result.reason, /完整分析模式/);
    assert.equal(f.state.replayCalls, 0); assert.equal(f.state.requestCalls, 1);
    assert.deepEqual(snapshot(f.query.analysisRoot), changed);
});

test('savedOnly真实已登记grant重开只读额度，不新建账/窗口，不合格原字节保留', async t => {
    const f = await setup(t), failed = adapter.loadConferenceReaderRevision(f.query);
    const grant = registerRecoveryFixture({ analysisRoot: f.query.analysisRoot,
        parentExecutionId: f.parent.run.executionId, failedExecutionId: f.query.executionId, paperId: f.paperId });
    await assert.rejects(adapter.refreshConferenceGrantedRecovery({ ...f.input,
        failedExecutionId: failed.run.executionId, grantHandle: grant.handle }, { engine: f.engine, deep: f.operations }),
    /synthetic prior Reader failure/);
    const authority = require('../scripts/lib/conference-recovery-grant').readRecoveryGrantMember(grant.handle, f.paperId);
    const query = { ...f.query, executionId: authority.expectedExecutionId }, before = snapshot(f.query.analysisRoot);
    const result = await adapter.replaySavedConferenceReaderRevision(query, f.overrides);
    assert.equal(result.status, 'partial'); assert.equal(result.savedOnly, true);
    assert.deepEqual(snapshot(f.query.analysisRoot), before);
    assert.equal(f.state.requestCalls, 2);
    const stopped = adapter.loadConferenceReaderRevision(query);
    f.state.replay = 'valid';
    const completed = await adapter.replaySavedConferenceReaderRevision(query, f.overrides);
    assert.equal(completed.status, 'complete'); assert.equal(completed.recoveredActivePaidReader, true);
    const saved = adapter.loadConferenceReaderRevision(query);
    assert.deepEqual(saved.analysis.readerRevisionProgress, stopped.analysis.readerRevisionProgress);
    assert.equal(saved.recoveryWindow.authority.grantId, authority.grantId);
    assert.equal(fs.existsSync(path.join(saved.directory, 'reader-grant-budget.json')), false);
    assert.equal(f.state.requestCalls, 2);
});
