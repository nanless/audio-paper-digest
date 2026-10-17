'use strict';
// Actual plan/PDF/CAS/opaque-scope tests. Synthetic original content below is
// explicitly fixture material; admission is not a claim of paper qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../scripts/config');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const api = require('../scripts/lib/conference-source-resource-correction');
const engine = require('../scripts/analysis-engine');
const processApi = require('../scripts/lib/conference-process');
const context = require('../scripts/lib/conference-analysis-context');
const stop = require('../scripts/lib/analysis-stop-control');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const { recoveryFixtureIdentity } = require('./helpers/conference-recovery-grant-fixture');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = adapter.stableHash;
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function admissionFixture(t) {
    const f = productionPlanFixture(t);
    const oldFiles = { ...config.FILES };
    Object.assign(config.FILES, f.files, {
        conferenceAnalysisDir: path.join(f.root, 'data/runtime/conference-analysis-executions'),
        conferenceProcessDir: path.join(f.root, 'data/runtime/conference-processes'),
        llmUsageDir: path.join(f.root, 'data/runtime/llm-usage')
    });
    t.after(() => Object.assign(config.FILES, oldFiles));
    const ids = recoveryFixtureIdentity(f.paperId);
    const analysisRoot = config.FILES.conferenceAnalysisDir;
    adapter.prepareConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId,
        paperId: f.paperId, planHandle: f.planHandle, sourceRoot: f.sourceRoot });
    let loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    const resources = { contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha(loaded.source.sourceDetails.text), resources: [] };
    resources.identitySha256 = hash(resources);
    const paper = { ...loaded.analysis.papers[0], sourceSha256: resources.sourceTextSha256,
        apiReaderArticle: 'Synthetic admission fixture, not a qualified Reader.', apiReaderPlan: {},
        apiReaderFigures: [], apiReaderResources: resources,
        analysis: require('./valid-analysis-fixture').validAnalysisText(),
        analysisManifest: { sourceAcquisition: { sourceSha256: resources.sourceTextSha256 },
            stages: { primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
                scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete',
                    model: 'synthetic-offline-fixture', protocol: 'fixture-not-paid', contentMode: 'reader-source-only-v1' } } } };
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = hash(paper.apiReaderPlan);
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
        figuresSha256: hash(paper.apiReaderFigures) });
    adapter.replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis,
        status: 'complete', completedAt: '2026-10-17T12:00:00.000Z', papers: [paper] }, loaded.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId }));
    loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    const processDirectory = path.join(config.FILES.conferenceProcessDir, ids.processId);
    const recordRoot = path.join(processDirectory, 'source-resource-corrections');
    fs.mkdirSync(recordRoot, { recursive: true, mode: 0o700 });
    const state = { contract: processApi.CONTRACT, version: processApi.PROCESS_VERSION, generation: 1,
        processId: ids.processId, authority: ids.authority, status: 'running', aggregate: null,
        completionReceiptSha256: null, createdAt: '2026-10-17T12:00:00.000Z', updatedAt: '2026-10-17T12:00:00.000Z',
        items: { [f.paperId]: { paperId: f.paperId, sourceIdentity: {}, analysisRunId: ids.parentExecutionId,
            status: 'complete', attempts: 3, sourceProof: { textSha256: paper.sourceSha256 },
            analysisProof: { analysisSha256: loaded.analysisFileSha256,
                sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
                completionReceiptSha256: loaded.run.completionReceipt.receiptSha256 },
            pageProof: { manifestSha256: '1'.repeat(64), contentSha256: '2'.repeat(64), pagePath: 'fixture-only.md' },
            updatedAt: '2026-10-17T12:00:00.000Z' } } };
    state.stateSha256 = processApi.stateDigest(state); processApi.assertState(state);
    const stateFile = path.join(processDirectory, 'state.json'); write(stateFile, state);
    const CAS = { analysisFileSha256: loaded.analysisFileSha256,
        runFileSha256: loaded.runFileSha256, sourceFileSha256: loaded.sourceFileSha256 };
    const record = { contract: api.CONTRACT, notLlmResponse: true, newApiRequests: 0,
        paperId: f.paperId, childExecutionId: crypto.randomUUID(), readerParentExecutionId: ids.parentExecutionId,
        observedStateExecutionId: ids.parentExecutionId, selectedMainExecutionId: ids.parentExecutionId,
        latestFailedExecutionId: null, readerParentCAS: CAS, observedStateCAS: CAS, selectedMainCAS: CAS,
        observedItemSha256: hash(state.items[f.paperId]), sourceSha256: paper.sourceSha256,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        originalResourceIdentitySha256: resources.identitySha256, feePins: [],
        appliedAt: '2026-10-17T12:00:00.000Z', reader: { noEdit: true } };
    const correctionFile = path.join(recordRoot, 'correction.json');
    const manifestPath = path.join(recordRoot, 'manifest.json');
    const manifest = { contract: api.BATCH, version: 1, processId: ids.processId, batchId: crypto.randomUUID(),
        stateFileSha256: sha(fs.readFileSync(stateFile)), stateSha256: state.stateSha256,
        authorization: { kind: 'source_resource_correction', newApiRequests: 0,
            instruction: 'Synthetic zero-request fixture, no publication authorization.', paperIds: [f.paperId] },
        sourceCohortPaperIds: [f.paperId], records: [] };
    const save = () => {
        write(correctionFile, record);
        manifest.records = [{ paperId: f.paperId, file: correctionFile, sha256: sha(fs.readFileSync(correctionFile)) }];
        write(manifestPath, manifest);
    };
    save();
    return { ...f, ...ids, loaded, paper, analysisRoot, state, stateFile, record, manifest, save,
        correctionFile, manifestPath, options: { processId: ids.processId, manifestPath } };
}

test('真实plan/PDF上的完整source清单可创建零请求scope，克隆JSON不能授能力', async t => {
    const f = admissionFixture(t), original = fs.readFileSync(path.join(f.loaded.directory, 'analysis.json'));
    const handle = api.openBatch(f.options);
    await engine.withPaperAnalysisLock({ id: f.paperId }, () => api.withCorrection(handle, {
        executionId: f.record.childExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot
    }, async () => {
        const actual = context.getConferenceAnalysisContext();
        assert.equal(actual.paperId, f.paperId);
        assert.equal(actual.executionId, f.record.childExecutionId);
        assert.ok(require('../scripts/lib/conference-source-context').readerPdfSourceForContext(actual.readerPdfSourceHandle));
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        await Promise.resolve(); assert.throws(() => api.assertMayAccessNetwork(), /禁止任何网络/);
        assert.throws(() => api.assertFinalizerInput({}, f.paper), /原 finalizer/);
        assert.throws(() => api.sealCorrection(f.paper));
    }));
    assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory, 'analysis.json')), original);
    assert.throws(() => api.withCorrection({}, { executionId: f.record.childExecutionId }, () => {}), /opaque/);
});

test('来源scope互不提升：资源11不能登记core编辑，core合同不能借资源根或普通JSON', t => {
    const f = admissionFixture(t);
    f.record.coreCorrection = {}; f.save();
    assert.throws(() => api.openBatch(f.options), /资源scope不能新增核心/);
    delete f.record.coreCorrection;
    f.manifest.contract = api.CORE_BATCH;
    f.manifest.authorization.kind = 'source_core_correction'; f.save();
    assert.throws(() => api.openBatch(f.options), /完整有界/);
    assert.equal(engine.scoringStabilityIsResolved({ executionKind: 'deterministic_source_core_audit' }), false);
    const fake = { ...f.paper, conferenceSourceCorrection: { contract: api.CORE_CONTRACT } };
    assert.equal(engine.hasValidApiReaderV3Records(fake), false);
});

test('原CAS/完整集合/当前状态变化先阻断，不能覆盖另一个paid partial', async t => {
    const f = admissionFixture(t), handle = api.openBatch(f.options);
    const parentFile = path.join(f.loaded.directory, 'analysis.json'), before = fs.readFileSync(parentFile);
    fs.appendFileSync(parentFile, ' ');
    await assert.rejects(engine.withPaperAnalysisLock({ id: f.paperId }, () => api.withCorrection(handle, {
        executionId: f.record.childExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot
    }, () => assert.fail('source CAS drift must reject'))));
    fs.writeFileSync(parentFile, before);
    adapter.prepareConferenceAnalysis({ analysisRoot: f.analysisRoot, executionId: f.record.childExecutionId,
        paperId: f.paperId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, now: f.record.appliedAt });
    const child = adapter.loadConferenceAnalysis({ analysisRoot: f.analysisRoot, executionId: f.record.childExecutionId });
    adapter.replaceJson(path.join(child.directory, 'analysis.json'), { ...child.analysis,
        status: 'partial', generation: 1 }, child.analysisFileSha256);
    const paidBytes = fs.readFileSync(path.join(child.directory, 'analysis.json'));
    await assert.rejects(engine.withPaperAnalysisLock({ id: f.paperId }, () => api.withCorrection(handle, {
        executionId: f.record.childExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot
    }, () => assert.fail('existing partial must never be overwritten'))), /付费partial/);
    assert.deepEqual(fs.readFileSync(path.join(child.directory, 'analysis.json')), paidBytes);
    f.manifest.authorization.paperIds = []; f.save();
    assert.throws(() => api.openBatch(f.options), /集合不一致/);
});

module.exports = { admissionFixture };


async function grantedSourceFixture(t) {
    const f = admissionFixture(t);
    const post = require('../scripts/lib/conference-postprocess');
    // Only stage operations are doubles, with no model or publication claim.
    // Grant registration, original failed/parent loaders, source and all CAS
    // checks are the unmodified production implementation under test.
    t.mock.method(post, 'readOriginalTagProof', () => ({ rules: {} }));
    const orchestration = {
        withPaperAnalysisLock: engine.withPaperAnalysisLock,
        LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false,
        analyzePaperWithRetry: async paper => ({ success: false, result: paper,
            error: 'synthetic fixture stops before any request', retryable: false })
    };
    const operations = { buildApiReaderResourceIdentity: require('../scripts/deep-analyzer').buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async () => null,
        refreshApiReaderArticleFromSource: async () => { throw Error('synthetic fixture stops before any request'); } };
    const input = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine: orchestration, deep: operations }), /synthetic fixture/);
    const failedExecutionId = adapter.readerRevisionExecutionId(f.parentExecutionId, f.loaded.analysisFileSha256);
    const registered = require('./helpers/conference-recovery-grant-fixture').registerRecoveryFixture({
        analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId, paperId: f.paperId });
    await assert.rejects(adapter.refreshConferenceGrantedRecovery({ ...input, failedExecutionId,
        grantHandle: registered.handle }, { engine: orchestration, deep: operations }), /synthetic fixture/);
    const authority = require('../scripts/lib/conference-recovery-grant').readRecoveryGrantMember(registered.handle, f.paperId);
    const latest = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot,
        executionId: authority.expectedExecutionId });
    const failed = latest.recoveryWindow.failed;
    const CAS = loaded => ({ analysisFileSha256: loaded.analysisFileSha256,
        runFileSha256: loaded.runFileSha256, sourceFileSha256: loaded.sourceFileSha256 });
    Object.assign(f.record, {
        selectedMainExecutionId: latest.run.executionId, selectedMainCAS: CAS(latest),
        latestFailedExecutionId: latest.run.executionId, latestFailedCAS: CAS(latest),
        originalFailedExecutionId: failed.run.executionId, originalFailedCAS: CAS(failed),
        originalResourceIdentitySha256: latest.analysis.papers[0].apiReaderResources.identitySha256
    });
    const state = JSON.parse(fs.readFileSync(f.stateFile));
    const sync = () => {
        state.stateSha256 = processApi.stateDigest(state); processApi.assertState(state); write(f.stateFile, state);
        f.record.observedStateExecutionId = state.items[f.paperId].analysisRunId;
        f.record.observedStateCAS = state.items[f.paperId].analysisRunId === f.parentExecutionId ? CAS(f.loaded) : CAS(failed);
        f.record.observedItemSha256 = hash(state.items[f.paperId]);
        f.manifest.stateFileSha256 = sha(fs.readFileSync(f.stateFile));
        f.manifest.stateSha256 = state.stateSha256; f.save();
    };
    sync();
    return { ...f, state, latest, failed, registered, sync };
}

test('真实grant原失败与完整父稿分离，process保留父指针或原失败指针均精确闭链', async t => {
    const f = await grantedSourceFixture(t);
    assert.notEqual(f.parentExecutionId, f.failed.run.executionId);
    assert.equal(f.latest.recoveryWindow.failed.run.executionId, f.record.originalFailedExecutionId);
    assert.equal(f.record.observedStateExecutionId, f.parentExecutionId);
    const handle = api.openBatch(f.options);
    const bound = api.batchDescription(handle).records[0];
    assert.equal(bound.originalFailedCAS.analysisFileSha256, f.failed.analysisFileSha256);
    assert.equal(bound.selectedMainExecutionId, f.latest.run.executionId);
    // The existing public Reader revision remains the exact state locator when
    // it is the actually observed pointer, rather than manufacturing a new one.
    f.state.items[f.paperId].analysisRunId = f.failed.run.executionId;
    f.state.items[f.paperId].readerRevision = structuredClone(f.failed.revision);
    f.sync();
    assert.ok(api.openBatch(f.options));
    const original = structuredClone(f.record);
    for (const alter of [
        record => { delete record.originalFailedExecutionId; delete record.originalFailedCAS; },
        record => { record.originalFailedExecutionId = f.parentExecutionId; },
        record => { record.originalFailedCAS.analysisFileSha256 = '0'.repeat(64); },
        record => { record.selectedMainExecutionId = f.parentExecutionId; record.selectedMainCAS = record.readerParentCAS; }
    ]) {
        Object.assign(f.record, structuredClone(original)); alter(f.record); f.save();
        assert.throws(() => api.openBatch(f.options), /追加链|原实际失败|最新失败/);
    }
});
