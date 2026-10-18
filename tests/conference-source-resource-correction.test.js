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

// Exercise the exact private asset routine and strict byte reader/immutable
// writer with a small scope harness. Admission/source authority itself is
// covered above; this harness makes no scientific qualification claim.
function assetRoutine(t) {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const moduleFile = require.resolve('../scripts/lib/conference-source-resource-correction');
    const source = fs.readFileSync(moduleFile, 'utf8');
    const functionBody = (name, next) => source.slice(source.indexOf(`function ${name}(`),
        source.indexOf(`function ${next}(`));
    const root = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'source-correction-assets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    fs.mkdirSync(path.join(parent, 'reader-assets'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(child, { mode: 0o700 });
    const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const filename = `figure-1-${sha(pixels).slice(0, 16)}.png`;
    const original = { ordinal: 1, url: 'https://example.org/original.png',
        caption: 'Original scientific caption', assetFilename: filename,
        cachePath: path.join(parent, 'reader-assets', filename), assetMediaType: 'image/png',
        assetSha256: sha(pixels), assetBytes: pixels.length, assetWidth: 1, assetHeight: 1 };
    fs.writeFileSync(original.cachePath, pixels, { mode: 0o600 });
    const input = { readerParent: { apiReaderFigures: [original] } };
    const active = { finalizerInput: input, cold: false, loaded: { directory: child },
        batch: { analysisRoot: root }, row: { record: { paperId: 'conference:icassp:2026:icassp-arnumber:100',
            sourceSha256: '1'.repeat(64), readerParentExecutionId: 'parent' } } };
    const localRequire = createRequire(moduleFile);
    let immutableCalls = 0;
    const fail = message => { throw Error(message); };
    const environment = {
        fs, path, sha, Buffer, SHA: /^[a-f0-9]{64}$/u,
        require: localRequire, current: () => active,
        assertContext: () => {}, equal: (a, b, message) => assert.deepEqual(a, b, message), fail,
        immutable(file, bytes) {
            immutableCalls++;
            assert.equal(active.cold, false, 'cold path must never call any writer');
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            localRequire('./fresh-rewrite-run').assertSafeDirectory(path.dirname(file));
            localRequire('./immutable-file').writeImmutableFile(file, bytes, fail);
        }
    };
    const routine = vm.runInNewContext(functionBody('sameStat', 'inside') + '\n'
        + functionBody('verifiedSignedFigureAssets', 'withCorrection')
        + '\n({routine: readVerifiedSignedFigures, verifyOnly: (input, figures) => verifiedSignedFigureAssets(input, figures, false)})', environment);
    const noAssets = ({ cachePath, assetFilename, assetMediaType, assetSha256,
        assetBytes, assetWidth, assetHeight, ...rest }) => rest;
    const injected = [noAssets(original)];
    const target = path.join(child, 'reader-assets', filename);
    return { active, input, ...routine, original, injected, target, pixels,
        immutableCalls: () => immutableCalls, normalize: value => JSON.parse(JSON.stringify(value)) };
}

test('本地来源热图复制到当前child路径，像素及其余元数据exact且正常页面资产检查接受', async t => {
    const f = assetRoutine(t), before = fs.readFileSync(f.original.cachePath);
    assert.throws(() => f.routine(f.input, f.injected), /同一论文锁/);
    await engine.withPaperAnalysisLock({ id: f.active.row.record.paperId }, async () => {
        const first = f.routine(f.input, f.injected);
        assert.deepEqual(f.normalize(first), [{ ...f.original, cachePath: f.target }]);
        assert.deepEqual(fs.readFileSync(f.target), f.pixels);
        const calls = f.immutableCalls();
        assert.deepEqual(f.normalize(f.verifyOnly(f.input, first)), f.normalize(first));
        assert.equal(f.immutableCalls(), calls, 'assertOutput helper must never write even when hot');
        assert.deepEqual(f.normalize(f.routine(f.input, f.injected)), f.normalize(first));
        const postFile = require.resolve('../scripts/lib/conference-postprocess');
        const source = fs.readFileSync(postFile, 'utf8');
        const raw = source.slice(source.indexOf('function conferenceFigureAssets('),
            source.indexOf('function buildFormulaEvidenceRecord('));
        const readRegular = require('../scripts/lib/publication-file-primitives').readRegular;
        const assets = require('node:vm').runInNewContext('(' + raw + ')', {
            path, fail: message => { throw Error(message); },
            pageApi: { readRegular(file, maximum) {
                const result = readRegular(file, maximum); return { ...result, fileSha256: result.sha256 };
            } }
        })({ directory: f.active.loaded.directory, analysis: { papers: [{ apiReaderFigures: first }] } });
        assert.equal(assets[0].assetSha256, f.original.assetSha256);
        assert.equal(assets[0].base64, f.pixels.toString('base64'));
    });
    assert.deepEqual(fs.readFileSync(f.original.cachePath), before);
});

test('冷图重放只读核父子两份真字节，缺图或任一端篡改不得补写', async t => {
    const f = assetRoutine(t);
    await engine.withPaperAnalysisLock({ id: f.active.row.record.paperId }, () => f.routine(f.input, f.injected));
    const calls = f.immutableCalls();
    f.active.cold = true;
    const before = fs.statSync(f.target, { bigint: true });
    assert.equal(f.verifyOnly(f.input, f.injected)[0].cachePath, f.target);
    assert.equal(fs.statSync(f.target, { bigint: true }).mtimeNs, before.mtimeNs);
    fs.writeFileSync(f.target, 'different child bytes');
    assert.throws(() => f.routine(f.input, f.injected), /子稿原图/);
    fs.unlinkSync(f.target);
    assert.throws(() => f.routine(f.input, f.injected), { code: 'ENOENT' });
    assert.equal(fs.existsSync(f.target), false);
    fs.writeFileSync(f.target, f.pixels, { mode: 0o600 });
    fs.writeFileSync(f.original.cachePath, 'different original bytes');
    assert.throws(() => f.routine(f.input, f.injected), /原签图像素/);
    assert.equal(f.immutableCalls(), calls);
});

test('已有child冲突像素、错原路径或科学说明拒绝，不覆盖父子文件', async t => {
    const f = assetRoutine(t);
    fs.mkdirSync(path.dirname(f.target), { mode: 0o700 });
    fs.writeFileSync(f.target, 'existing unrelated bytes', { mode: 0o600 });
    await engine.withPaperAnalysisLock({ id: f.active.row.record.paperId }, () => {
        assert.throws(() => f.routine(f.input, f.injected), /不可变|不同/);
        assert.deepEqual(fs.readFileSync(f.target), Buffer.from('existing unrelated bytes'));
        f.original.cachePath = f.target;
        assert.throws(() => f.routine(f.input, f.injected), /原签会议图路径/);
    });
    f.injected[0].caption = 'changed scientific caption';
    assert.throws(() => f.routine(f.input, f.injected), /科学说明/);
});

// Execute the production private calculations without exporting a capability.
// These are narrow projection/validation tests, not a full Reader qualification.
function privateCalculations() {
    const sourceFile = require.resolve('../scripts/lib/conference-source-resource-correction');
    const source = fs.readFileSync(sourceFile, 'utf8');
    const body = (name, next) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
    const fields = source.match(/const FAILURE_FIELDS = Object\.freeze\((\[[\s\S]*?\])\);/u)[1];
    const state = { cold: false };
    const output = require('node:vm').runInNewContext(
        `const FAILURE_FIELDS = ${fields};\n`
        + body('projectSelectedMain', 'prepareFinalizerInput')
        + body('assertPairedCoreAudits', 'deriveCoreAudit')
        + body('assertRecoveredImageSupplement', 'assertOutput')
        + '\n({projectSelectedMain, assertPairedCoreAudits, assertRecoveredImageSupplement, FAILURE_FIELDS})', {
            require: require('node:module').createRequire(sourceFile), sha, stable: hash,
            clone: structuredClone, CONTRACT: api.CONTRACT, current: () => state,
            fail: message => { throw Error(message); },
            equal: (actual, expected, message) => assert.deepStrictEqual(
                structuredClone(actual), structuredClone(expected), message)
        });
    return { ...output, state };
}

test('仅原null主文可恢复三SHA相同评分检查点，原失败/次数/原包不变', () => {
    const h = privateCalculations();
    const checkpoint = require('./valid-analysis-fixture').validAnalysisText();
    const raw = { analysis: null, parsed: null, analysisCheckpoint: checkpoint,
        analysisStageCheckpoints: { scoringAudit: checkpoint },
        imageManifest: { totalFound: 0, candidates: [], downloaded: [], selected: [], downloadOutcomes: [] },
        latestAnalysisAttemptError: 'Original Reader failure', latestAnalysisAttemptErrorCode: 'READER_REPAIR_NO_PROGRESS',
        latestAnalysisAttemptErrorCategory: 'reader_recovery', latestAnalysisAttemptRetryable: false,
        analysisManifest: { stages: {
            scoringAudit: { status: 'complete', outputAnalysisSha256: sha(checkpoint), attempts: 1 },
            apiReaderArticle: { status: 'invalid_output', attempts: 6, fullAttempts: 2 },
            imageDownload: { status: 'no_candidates', attempted: 0, downloaded: 0, outcomes: [] }
        } } };
    const loaded = { analysis: { papers: [raw], readerRevisionProgress: { attempts: 3, failures: ['original'] } } };
    const record = { contract: api.CONTRACT, selectedMainExecutionId: 'latest', latestFailedExecutionId: 'latest',
        mainCheckpointRecovery: { contract: 'conference-source-main-checkpoint-recovery-v1', rawAnalysisValue: null,
            rawPaperSha256: hash(raw), analysisCheckpointSha256: sha(checkpoint), scoringCheckpointSha256: sha(checkpoint),
            scoringOutputAnalysisSha256: sha(checkpoint), scoringStageSha256: hash(raw.analysisManifest.stages.scoringAudit),
            readerStageSha256: hash(raw.analysisManifest.stages.apiReaderArticle),
            originalFailureFieldsSha256: hash(Object.fromEntries(h.FAILURE_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]))),
            readerRevisionProgressSha256: hash(loaded.analysis.readerRevisionProgress), missingImageSupplement: true } };
    const before = structuredClone(loaded);
    const projected = h.projectSelectedMain(loaded, record);
    assert.equal(projected.parent.analysis, checkpoint);
    assert.deepEqual(projected.parent.parsed, require('../scripts/utils').parseAnalysis(checkpoint));
    const restored = structuredClone(projected.parent); restored.analysis = null; restored.parsed = null;
    assert.deepEqual(restored, raw);
    assert.deepEqual(loaded, before);
    const changes = [
        x => { x.analysisCheckpoint += 'changed'; },
        x => { x.analysisStageCheckpoints.scoringAudit += 'changed'; },
        x => { x.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
        x => { x.analysisManifest.stages.scoringAudit.status = 'invalid_output'; },
        x => { x.latestAnalysisAttemptErrorCode = 'CORE_SUMMARY_INVALID'; },
        x => { x.analysisManifest.stages.apiReaderArticle.status = 'complete'; },
        x => { x.analysisManifest.stages.imageSupplement = { status: 'skipped' }; },
        x => { x.imageManifest.candidates.push({}); },
        x => { x.analysisManifest.stages.imageDownload.attempted = 1; }
    ];
    for (const change of changes) {
        const bad = structuredClone(loaded); change(bad.analysis.papers[0]);
        assert.throws(() => h.projectSelectedMain(bad, record));
    }
    const badRecord = structuredClone(record); badRecord.mainCheckpointRecovery.rawPaperSha256 = '0'.repeat(64);
    assert.throws(() => h.projectSelectedMain(loaded, badRecord), /恢复声明不同/);
    const advanced = structuredClone(loaded); advanced.analysis.readerRevisionProgress.attempts++;
    assert.throws(() => h.projectSelectedMain(advanced, record), /恢复声明不同/);
    const ordinary = structuredClone(loaded); ordinary.analysis.papers[0].analysis = checkpoint;
    assert.throws(() => h.projectSelectedMain(ordinary, record), /非空主文/);
    assert.equal(h.projectSelectedMain(ordinary, {}).parent, ordinary.analysis.papers[0]);
});

test('核心paired validation只保留已严格通过原audit，canonical仅理由措辞且前后exact', () => {
    const h = privateCalculations();
    const original = { dimensions: { openSource: { score: 0, reason: 'Original source-bound reason' },
        innovation: { score: 1.2, reason: 'Unchanged' } }, total: 7, capsApplied: [], confidence: '中' };
    const canonical = structuredClone(original);
    canonical.dimensions.openSource.reason = 'Current canonical validation wording';
    const before = structuredClone({ original, canonical });
    const proof = h.assertPairedCoreAudits(original, structuredClone(original), canonical, structuredClone(canonical));
    assert.equal(proof.originalAuditStrictSha256, hash(original));
    assert.equal(proof.validationCanonicalSha256, hash(canonical));
    assert.notEqual(proof.originalAuditStrictSha256, proof.validationCanonicalSha256);
    assert.deepEqual({ original, canonical }, before);
    for (const change of [
        value => { value.dimensions.innovation.reason = 'different'; },
        value => { value.dimensions.openSource.score = 1; },
        value => { value.total = 8; },
        value => { value.capsApplied.push('new cap'); },
        value => { value.confidence = '高'; }
    ]) {
        const bad = structuredClone(canonical); change(bad);
        assert.throws(() => h.assertPairedCoreAudits(original, structuredClone(original), bad, structuredClone(bad)));
    }
    const changedAfter = structuredClone(canonical); changedAfter.dimensions.openSource.reason += ' changed';
    assert.throws(() => h.assertPairedCoreAudits(original, original, canonical, changedAfter), /归一不同/);
    const strictDifferent = structuredClone(original); strictDifferent.dimensions.innovation.score = 1;
    assert.throws(() => h.assertPairedCoreAudits(original, strictDifferent, canonical, canonical), /严格重验/);
});

test('检查点恢复的官方图阶段热中间态不可冷保存，必须按正常函数exact重放', () => {
    const h = privateCalculations(), deep = require('../scripts/deep-analyzer');
    const { paper, sourceDetails } = require('./reader-signed-draft-fixture').fixture();
    paper.id = 'conference:interspeech:2026:conference-paper-id:fixture26_interspeech'; paper.source = 'conference';
    const source = { ...sourceDetails, source: 'conference_pdf_text', sourceId: paper.id, imageInfos: [] };
    const appliedAt = '2026-10-18T10:00:00.000+08:00';
    paper.analysis = paper.analysisCheckpoint = 'Synthetic stage-only scoring checkpoint';
    paper.analysisStageCheckpoints = { scoringAudit: paper.analysis };
    paper.imageManifest = { totalFound: 0, candidates: [], downloaded: [], selected: [], downloadOutcomes: [] };
    Object.assign(paper.analysisManifest.stages, {
        imageDownload: { status: 'no_candidates', attempted: 0, downloaded: 0, outcomes: [] },
        scoringAudit: { status: 'complete', scoringContract: 'api-scoring-audit-v2', outputAnalysisSha256: sha(paper.analysis) }
    });
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, { executionKind: 'operator', model: 'operator-local',
        protocol: 'local_operator', newReaderApiRequests: 0, operatorProvenance: { appliedAt } });
    const input = { mainCheckpointRecovery: { missingImageSupplement: true }, sourceDetails: source, provenance: { appliedAt } };
    h.assertRecoveredImageSupplement(input, paper);
    assert.throws(() => h.assertRecoveredImageSupplement(input, paper, true), /尚未完成/);
    h.state.cold = true;
    assert.throws(() => h.assertRecoveredImageSupplement(input, paper), /尚未完成/);
    const expected = deep.deriveConferenceLocalOfficialImageSupplement(paper, source, { appliedAt });
    paper.analysisManifest.stages.imageSupplement = expected;
    const before = structuredClone(paper);
    h.assertRecoveredImageSupplement(input, paper);
    assert.deepEqual(paper, before);
    paper.analysisManifest.stages.imageSupplement.officialFigureCount++;
    assert.throws(() => h.assertRecoveredImageSupplement(input, paper));
    paper.analysisManifest.stages.imageSupplement = expected;
    paper.analysisManifest.stages.imageDownload.attempted = 1;
    assert.throws(() => h.assertRecoveredImageSupplement(input, paper));
});

test('迁移默认依赖未注入deep仍进入真实local finalizer；原科学门禁拒绝且不采纳state', async t => {
    const f = admissionFixture(t);
    const deps = processApi.defaultDependencies();
    assert.equal(Object.hasOwn(deps, 'deep'), false, 'exercise the actual migrate default dependency shape');
    const stateBefore = fs.readFileSync(f.stateFile);
    const parentFile = path.join(f.loaded.directory, 'analysis.json');
    const parentBefore = fs.readFileSync(parentFile);
    const shared = { planHandle: f.planHandle, sourceCacheRoot: f.sourceRoot };
    // The fixture deliberately lacks a genuine scientific tag/core chain.
    // Invoke the real batch/writer, source/PDF scope, shared normal finalizer
    // and scientific gate; no qualification/parser/receipt is replaced with a pass.
    await assert.rejects(require('../scripts/lib/conference-source-resource-correction-apply').applyAndStageBatch({
        manifestPath: f.manifestPath, directory: path.dirname(f.stateFile), state: f.state, shared
    }, deps), error => {
        assert.notEqual(error instanceof TypeError, true, error.stack);
        assert.match(error.stack, /finalizeConferenceLocalSourceCorrection/u);
        assert.match(error.message, /标签|tag/iu);
        return true;
    });
    assert.deepEqual(fs.readFileSync(f.stateFile), stateBefore);
    assert.deepEqual(fs.readFileSync(parentFile), parentBefore);
    const child = adapter.loadConferenceAnalysis({ analysisRoot: f.analysisRoot, executionId: f.record.childExecutionId });
    assert.notEqual(child.analysis.status, 'complete');
    assert.equal(fs.existsSync(path.join(child.directory, 'source-correction-receipt.json')), false);
});

// Synthetic contract/projection checks only: these do not claim scientific
// qualification or grant any source-correction capability.
function privateReaderContractCalculations() {
    const sourceFile = require.resolve('../scripts/lib/conference-source-resource-correction');
    const source = fs.readFileSync(sourceFile, 'utf8');
    const fields = source.match(/const FAILURE_FIELDS = Object\.freeze\((\[[\s\S]*?\])\);/u)[1];
    const start = source.indexOf('const READER_CONTRACT_KEYS = Object.freeze(');
    const end = source.indexOf('function assertRecoveredImageSupplement(');
    assert(start >= 0 && end > start);
    return require('node:vm').runInNewContext(`const FAILURE_FIELDS = ${fields};\n`
        + source.slice(start, end) + '\n({protectedPaper, assertNormalReaderContracts})', {
        clone: structuredClone, scope: { getStore: () => undefined },
        equal: (actual, expected, message) => assert.deepStrictEqual(
            structuredClone(actual), structuredClone(expected), message)
    });
}

test('来源纠正仅允许正常finalizer当前五合同；缺失伪造及原持久化声明变化均拒绝（合成）', () => {
    const h = privateReaderContractCalculations(), deep = require('../scripts/deep-analyzer');
    const before = { analysisManifest: { contracts: { coreSummary: 'protected-original' }, stages: {} } };
    const after = structuredClone(before);
    const normal = {
        apiReaderArticle: deep.API_READER_ARTICLE_CONTRACT,
        apiReaderSourceBindings: deep.API_READER_SOURCE_BINDING_CONTRACT,
        apiReaderAuthorIdentity: deep.API_READER_AUTHOR_IDENTITY_CONTRACT,
        apiReaderResourceIdentity: deep.API_READER_RESOURCE_IDENTITY_CONTRACT,
        readerResourceClaims: deep.API_READER_RESOURCE_CLAIMS_CONTRACT
    };
    Object.assign(after.analysisManifest.contracts, normal);
    h.assertNormalReaderContracts(after, before, deep);
    for (const key of Object.keys(normal)) {
        const missing = structuredClone(after); delete missing.analysisManifest.contracts[key];
        assert.throws(() => h.assertNormalReaderContracts(missing, before, deep), /当前精确声明/u);
        const forged = structuredClone(after); forged.analysisManifest.contracts[key] = 'forged';
        assert.throws(() => h.assertNormalReaderContracts(forged, before, deep), /当前精确声明/u);
    }
    const minted = structuredClone(after); minted.analysisManifest.contracts.apiReaderFigurePersistence = 'daily-forged';
    assert.throws(() => h.assertNormalReaderContracts(minted, before, deep), /当前精确声明/u);
    before.analysisManifest.contracts.apiReaderFigurePersistence = 'original-archived-declaration';
    after.analysisManifest.contracts.apiReaderFigurePersistence = 'original-archived-declaration';
    h.assertNormalReaderContracts(after, before, deep);
    const missing = structuredClone(after); delete missing.analysisManifest.contracts.apiReaderFigurePersistence;
    assert.throws(() => h.assertNormalReaderContracts(missing, before, deep), /当前精确声明/u);
    after.analysisManifest.contracts.apiReaderFigurePersistence = 'changed';
    assert.throws(() => h.assertNormalReaderContracts(after, before, deep), /当前精确声明/u);
});

test('来源纠正六Reader合同外的原科学合同与非Reader阶段仍逐字保护（合成）', () => {
    const h = privateReaderContractCalculations();
    const before = { analysisManifest: { contracts: { coreSummary: 'original', taxonomy: 'original' },
        stages: { primaryAnalysis: { status: 'complete', fingerprint: 'original' } } } };
    const after = structuredClone(before);
    for (const key of ['apiReaderArticle', 'apiReaderSourceBindings', 'apiReaderAuthorIdentity',
        'apiReaderResourceIdentity', 'apiReaderFigurePersistence', 'readerResourceClaims']) {
        after.analysisManifest.contracts[key] = 'Reader-only projected here; separately exact-validated';
    }
    assert.deepEqual(structuredClone(h.protectedPaper(after)), structuredClone(h.protectedPaper(before)));
    for (const key of Object.keys(before.analysisManifest.contracts)) {
        const changed = structuredClone(after); changed.analysisManifest.contracts[key] = 'changed';
        assert.notDeepEqual(structuredClone(h.protectedPaper(changed)), structuredClone(h.protectedPaper(before)));
    }
    after.analysisManifest.stages.primaryAnalysis.fingerprint = 'changed';
    assert.notDeepEqual(structuredClone(h.protectedPaper(after)), structuredClone(h.protectedPaper(before)));
});

// Projection orchestration only: the opaque transaction and adopted-page
// readers are explicit doubles here; their real admission is tested above.
// Current canonical/state/proof/history checks below execute production code.
function previousProjectionHarness() {
    const source = fs.readFileSync(require.resolve('../scripts/lib/conference-source-resource-correction'), 'utf8');
    const id = 'conference:icassp:2026:icassp-arnumber:100';
    const previous = { paperId: id, analysisRunId: 'original', attempts: 3,
        retryBudgetStart: 1, retryReleases: [{ attempts: 1 }], sourceProof: { textSha256: 'source' } };
    const record = { batch: { processDirectory: '/synthetic-process', manifest: { file: '/manifest', sha256: 'manifest' },
        state: { value: { stateSha256: 'old-state', items: { [id]: previous } } } },
        row: { record: { selectedMainExecutionId: 'main', readerParentExecutionId: 'reader' } } };
    const paper = { id, conferenceSourceCorrection: { executionId: 'current' } }, loaded = { analysisFileSha256: 'analysis',
        analysis: { status: 'complete', papers: [paper] }, run: { status: 'complete',
            executionId: 'current', paperId: id, sourceSnapshotSha256: 'snapshot', completionReceipt: { receiptSha256: 'completion' } } };
    const item = { ...structuredClone(previous), status: 'complete', analysisRunId: 'current',
        analysisProof: { analysisSha256: 'analysis', sourceSnapshotSha256: 'snapshot', completionReceiptSha256: 'completion' },
        sourceResourceCorrectionAdoption: { previousItemSha256: hash(previous), previousStateSha256: 'old-state',
            manifestFile: '/manifest', manifestSha256: 'manifest', selectedMainExecutionId: 'main', readerParentExecutionId: 'reader' } };
    const actual = { processId: 'process', items: { [id]: structuredClone(item) } };
    const controls = { registered: true, page: true, publicationCalls: 0, childExists: false, publicationPass: false, wholePass: true };
    record.receipt={provenance:{sourceIdentity:{contract:'conference-reader-pdf-source-v1',executionId:'current'}}};
    const equal = (a, b, message) => assert.deepStrictEqual(structuredClone(a), structuredClone(b), message);
    const environment = { path, stable: hash, clone: structuredClone,
        isDeepStrictEqual: require('node:util').isDeepStrictEqual, PROJECTION_ONLY: {},
        isSourceCorrectionRecord: value => !!value.conferenceSourceCorrection,
        publicationProjection: new (require('node:async_hooks').AsyncLocalStorage)(),
        fail: message => { throw Error(message); }, equal,
        read: () => ({ value: structuredClone(actual) }),
        readRegisteredTransaction: () => { assert.equal(controls.registered, true, 'missing actual registered transaction'); return record; },
        assertAdoptedPage: () => assert.equal(controls.page, true, 'adopted page physical CAS mismatch'),
        withSavedPaper: (presented,callback) => { controls.publicationCalls++;controls.publicationPaper=presented;if(!controls.publicationPass)throw Object.assign(Error('actual Reader placeholder rejected'), { code: 'reader_placeholder_result_table' });return callback(); },
        require: name => {
            if (name === '../config') return { FILES: { conferenceAnalysisDir: '/synthetic-analysis' } };
            if (name === './conference-analysis-adapter') return { loadConferenceAnalysis: () => loaded,
                readerRevisionExecutionId: () => 'next-child', loadConferenceReaderRevision: () => controls.child };
            if (name === 'node:fs') return { existsSync: filename => controls.childExists
                && (filename.endsWith('analysis.json') || controls.childRevision !== false) };
            if (name === './conference-process-recovery') return { MAX_ATTEMPTS: 3 };
            if (name === './conference-process') return { assertState: () => {} };
            if (name === './analysis-stop-control') return stop;
            if (name === './conference-reader-publication-evidence') return {replayCanonicalReaderPdfSource:(presented,identity)=>{controls.pdfPaper=presented;controls.pdfIdentity=identity;return {};}};
            if (name === './conference-analysis-context') return {withConferenceAnalysisSource:(identity,callback)=>{controls.actualSourceScope=identity;return callback();}};
            if (name === './conference-postprocess') return {readOriginalTagProof:()=>({rules:{}})};
            if (name === '../analysis-engine') return {isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>controls.wholePass};
            throw Error(`Unexpected projection dependency ${name}`);
        } };
    const methods = require('node:vm').runInNewContext(source.slice(source.indexOf('function sourceProjectionCanonical('),
        source.indexOf('function readRegisteredTransaction(')) + source.slice(source.indexOf('function readPreviousItemProjection('),
        source.indexOf('module.exports = ')) + '\n({readPreviousSourceIdentityItem, readPreviousPublicationItem, assertSourceMaintenanceHistory})', environment);
    return { ...methods, item, previous, actual, loaded, controls, record };
}

test('仅来源回投不授Reader出版资格；完整出版仍真实进入旧Reader门禁（合成调度）', () => {
    const f = previousProjectionHarness();
    const previous = f.readPreviousSourceIdentityItem(f.item);
    assert.deepEqual(previous, f.previous); assert.notEqual(previous, f.previous);
    assert.equal(f.controls.publicationCalls, 0);
    assert.throws(() => f.readPreviousPublicationItem(f.item), { code: 'reader_placeholder_result_table' });
    assert.equal(f.controls.publicationCalls, 1);
    f.controls.registered = false;
    assert.throws(() => f.readPreviousSourceIdentityItem(f.item), /missing actual registered transaction/);
});

test('仅来源维护按真实子稿失败记录接受第二三轮在途，拒超预算、裸数字与counter回退（合成调度）', () => {
    const f = previousProjectionHarness(), item = f.item;
    item.status = 'analyzing'; item.readerRefreshRequired = true;
    item.retryBudgetStart = item.retryAuthorizedAtAttempt = f.previous.attempts;
    item.retryReleases.push({ at: '2026-10-18T00:00:00.000Z', attempts: f.previous.attempts,
        previousFailure: { message: 'actual parent page failure', systemic: false } });
    f.controls.childExists = true;
    const child = f.controls.child = { analysis: { status: 'partial',
        readerRevisionProgress: { attempts: 1, failures: [{ message: 'real saved child failure', at: '2026-10-18T00:01:00.000Z' }] } },
        run: { status: 'source_ready' }, revision: { maxAttempts: 3 } };
    const projection = { descendants: [] };
    item.attempts = f.previous.attempts + 2;
    f.assertSourceMaintenanceHistory(item, f.previous, projection);
    child.analysis.readerRevisionProgress.attempts++;
    child.analysis.readerRevisionProgress.failures.push({ message: 'second saved failure', at: '2026-10-18T00:02:00.000Z' });
    item.attempts++;
    f.assertSourceMaintenanceHistory(item, f.previous, projection);
    item.attempts++;
    assert.throws(() => f.assertSourceMaintenanceHistory(item, f.previous, projection), /实际子运行闭合/);
    item.attempts = f.previous.attempts;
    item.retryReleases = structuredClone(f.previous.retryReleases);
    item.retryBudgetStart = f.previous.retryBudgetStart;
    assert.throws(() => f.assertSourceMaintenanceHistory(item, f.previous, projection), /实际子运行闭合/);
    f.controls.childExists = false;
    assert.throws(() => f.assertSourceMaintenanceHistory(item, f.previous, { descendants: [child] }), /实际子运行闭合/);
});

test('仅来源身份沿真实新Reader父CAS回纠正祖先，不把旧adoption当新稿声明（合成调度）', () => {
    const f = previousProjectionHarness(), ancestor = structuredClone(f.loaded);
    ancestor.sourceFileSha256 = 'same-source';
    f.loaded.run.executionId = 'normal-child'; f.loaded.runFileSha256 = 'new-run';
    f.loaded.sourceFileSha256 = 'same-source';
    f.loaded.analysis.papers[0] = { id: f.item.paperId };
    f.loaded.analysis.readerRevisionProgress = { attempts: 1, failures: [] };
    const revision = { parentExecutionId: 'current', maxAttempts: 3 };
    f.controls.child = { ...f.loaded, parent: ancestor, revision };
    f.item.analysisRunId = 'normal-child'; f.item.readerRevision = revision;
    f.item.attempts = f.previous.attempts + 1;
    f.item.retryBudgetStart = f.previous.attempts;
    f.item.retryReleases.push({ at: '2026-10-18T00:00:00.000Z', attempts: f.previous.attempts,
        previousFailure: { message: 'real parent page failure', systemic: false } });
    f.actual.items[f.item.paperId] = structuredClone(f.item);
    assert.deepEqual(f.readPreviousSourceIdentityItem(f.item), f.previous);
    assert.equal(f.controls.publicationCalls, 0);
    assert.throws(() => f.readPreviousPublicationItem(f.item), /不能借用祖先纠正声明/);
    ancestor.sourceFileSha256 = 'different source';
    assert.throws(() => f.readPreviousSourceIdentityItem(f.item), /父稿CAS或来源不符/);
});

test('同一来源准备中断的pending或零轮seed只作未派发准备，不冒充已付轮次（合成调度）', () => {
    const f = previousProjectionHarness(); f.controls.childExists = true; f.controls.childRevision = false;
    f.loaded.analysis.status = 'pending'; f.loaded.run.status = 'source_ready'; f.loaded.sourceFileSha256 = 'source';
    const projection = { current: { sourceFileSha256: 'source' }, descendants: [] };
    f.assertSourceMaintenanceHistory(f.item, f.previous, projection);
    f.loaded.sourceFileSha256 = 'wrong';
    assert.throws(() => f.assertSourceMaintenanceHistory(f.item, f.previous, projection), /同一真实待分析准备态/);
    f.controls.childRevision = true;
    f.controls.child = { analysis: { status: 'partial', readerRevisionProgress: { attempts: 0, failures: [] } },
        run: { status: 'source_ready' }, revision: { maxAttempts: 3 } };
    f.assertSourceMaintenanceHistory(f.item, f.previous, projection);
    f.controls.child.analysis.readerRevisionProgress.attempts = 1;
    assert.throws(() => f.assertSourceMaintenanceHistory(f.item, f.previous, projection));
});

test('仅来源回投仍拒canonical凭证、原次数、来源、adoption、当前成员及页CAS漂移（合成调度）', () => {
    for (const alter of [
        f => { f.loaded.analysis.status = 'partial'; },
        f => { f.item.analysisProof.analysisSha256 = 'changed'; },
        f => { f.item.analysisProof.completionReceiptSha256 = 'changed'; },
        f => { f.item.analysisProof.sourceSnapshotSha256 = 'changed'; },
        f => { f.item.sourceProof.textSha256 = 'changed'; },
        f => { f.item.attempts = 0; },
        f => { f.item.retryReleases = []; },
        f => { f.item.sourceResourceCorrectionAdoption.selectedMainExecutionId = 'wrong'; },
        f => { f.actual.items[f.item.paperId].unrelatedEvidence = 'changed'; },
        f => { f.controls.page = false; }
    ]) {
        const f = previousProjectionHarness(); alter(f);
        assert.throws(() => f.readPreviousSourceIdentityItem(f.item));
        assert.equal(f.controls.publicationCalls, 0);
    }
});


function registeredIndependentMaintenanceFixture(f) {
    const parent=structuredClone(f.loaded);parent.analysisFileSha256='a'.repeat(64);parent.runFileSha256='b'.repeat(64);parent.sourceFileSha256='c'.repeat(64);
    f.loaded.sourceFileSha256=parent.sourceFileSha256;
    const locator={contract:'conference-reader-review-maintenance-member-v1',batchId:'real-batch',manifestSha256:'registered-manifest'};
    const child={analysisFileSha256:'new-analysis',runFileSha256:'new-run',sourceFileSha256:parent.sourceFileSha256,
        analysis:{status:'complete',papers:[{id:f.item.paperId,apiReaderArticle:'new actual Reader',conferenceSourceCorrection:{executionId:'current'}}],
            readerRevisionProgress:{attempts:3,failures:[1,2,3].map(i=>({message:'retained failure '+i,at:`2026-10-18T00:0${i}:00.000Z`}))}},
        run:{status:'complete',executionId:'independent-child',paperId:f.item.paperId,sourceSnapshotSha256:'snapshot',completionReceipt:{receiptSha256:'new-completion'}},
        directory:'/synthetic-analysis/independent-child',source:{sourceDetails:{text:'real source fixture'}},parent,
        revision:{mode:'reader-only',maxAttempts:3,readerReviewMaintenance:locator}};
    child.readerReview={locator:structuredClone(locator),parentSeedHandle:Object.freeze({}),member:{paperId:f.item.paperId,executionId:child.run.executionId,
        parentExecutionId:parent.run.executionId,parentCAS:{analysisFileSha256:parent.analysisFileSha256,runFileSha256:parent.runFileSha256,sourceFileSha256:parent.sourceFileSha256}}};
    return child;
}
test('已登记独立Reader窗口三轮不加进原process次数，pending及采纳后父链均保留原账（合成编排）',()=>{
    const f=previousProjectionHarness(),child=registeredIndependentMaintenanceFixture(f);
    f.controls.childExists=true;f.controls.child=child;
    assert.doesNotThrow(()=>f.assertSourceMaintenanceHistory(f.item,f.previous,{current:f.loaded,descendants:[]}));
    f.controls.childExists=false;
    assert.doesNotThrow(()=>f.assertSourceMaintenanceHistory(f.item,f.previous,{current:child,descendants:[child]}));
    const changed=structuredClone(f.item);changed.attempts++;
    assert.throws(()=>f.assertSourceMaintenanceHistory(changed,f.previous,{current:child,descendants:[child]}),/实际子运行闭合/);
});
test('独立维护必须有adapter核过的登记反馈与完整原父CAS，裸locator及被改轮次仍拒（合成编排）',()=>{
    for(const mutate of [c=>delete c.readerReview,c=>c.readerReview.locator.manifestSha256='other',c=>c.readerReview.member.parentCAS.sourceFileSha256='other',
        c=>c.analysis.readerRevisionProgress.attempts=4,c=>c.analysis.readerRevisionProgress.failures.splice(0,2)]){
        const f=previousProjectionHarness(),child=registeredIndependentMaintenanceFixture(f);mutate(child);f.controls.childExists=true;f.controls.child=child;
        assert.throws(()=>f.assertSourceMaintenanceHistory(f.item,f.previous,{current:f.loaded,descendants:[]}));
    }
});
function adoptedIndependentPublicationFixture(){
    const f=previousProjectionHarness(),child=registeredIndependentMaintenanceFixture(f);
    Object.assign(f.loaded,child);f.controls.child=child;f.controls.childExists=false;
    Object.assign(f.item,{analysisRunId:child.run.executionId,readerRevision:child.revision,
        analysisProof:{analysisSha256:child.analysisFileSha256,sourceSnapshotSha256:'snapshot',completionReceiptSha256:'new-completion'},
        textMaintenanceAdoption:{batchId:child.revision.readerReviewMaintenance.batchId,manifestSha256:child.revision.readerReviewMaintenance.manifestSha256,previousExecutionId:child.parent.run.executionId}});
    f.actual.items[f.item.paperId]=structuredClone(f.item);return f;
}
test('采纳后完整出版核当前Reader自己的PDF和整篇，不能拿旧祖先Reader为新正文放行（合成编排）',()=>{
    const f=adoptedIndependentPublicationFixture();f.controls.publicationPass=true;
    assert.deepEqual(f.readPreviousPublicationItem(f.item),f.previous);
    assert.equal(f.controls.publicationPaper.apiReaderArticle,'new actual Reader');assert.equal(f.controls.pdfPaper.apiReaderArticle,'new actual Reader');
    assert.equal(f.controls.pdfIdentity.executionId,f.item.analysisRunId);assert.equal(f.controls.actualSourceScope.executionId,f.item.analysisRunId);
    f.controls.wholePass=false;assert.throws(()=>f.readPreviousPublicationItem(f.item),/完整冷核未通过/);
});
test('采纳后缺真实维护采纳、换批或绕当前Reader门仍拒；普通祖先借用旧限制不变（合成编排）',()=>{
    for(const mutate of [f=>delete f.item.textMaintenanceAdoption,f=>f.item.textMaintenanceAdoption.batchId='wrong',
        f=>f.item.textMaintenanceAdoption.previousExecutionId='wrong']){
        const f=adoptedIndependentPublicationFixture();f.controls.publicationPass=true;mutate(f);f.actual.items[f.item.paperId]=structuredClone(f.item);
        assert.throws(()=>f.readPreviousPublicationItem(f.item),/维护采纳绑定/);
    }
    const f=adoptedIndependentPublicationFixture();assert.throws(()=>f.readPreviousPublicationItem(f.item),{code:'reader_placeholder_result_table'});
});

// Private-FD publication orchestration, not source or scientific qualification:
// real adapter/registered-child admission is deliberately represented by doubles.
function publicationBridgeHarness() {
    const source=fs.readFileSync(require.resolve('../scripts/lib/conference-source-resource-correction'),'utf8');
    const AsyncLocalStorage=require('node:async_hooks').AsyncLocalStorage;
    const inheritedReaderScience=new AsyncLocalStorage(),contextScope=new AsyncLocalStorage();
    const parentId='11111111-1111-4111-a111-111111111111',childId='22222222-2222-4222-a222-222222222222';
    const parent={id:'paper',sourceSha256:sha('source'),conferenceSourceCorrection:{contract:'conference-source-core-correction-v1',executionId:parentId},
        analysisManifest:{stages:{scoringAudit:{executionKind:'deterministic_source_core_audit'},apiReaderArticle:{article:'parent'}}}};
    const child=structuredClone(parent);child.analysisManifest.stages.apiReaderArticle={article:'new Reader'};
    const mk=(id,paper)=>({analysis:{status:'complete',papers:[paper]},run:{status:'complete',executionId:id,paperId:'paper'},
        analysisFileSha256:id,runFileSha256:id+'run',sourceFileSha256:'same-source',directory:'/analysis/'+id,source:{sourceDetails:{text:'source'}}});
    const original=mk(parentId,parent),loaded=mk(childId,child);loaded.parent=original;
    const active={cold:true,receipt:{provenance:{sourceIdentity:{executionId:parentId}},real:'original receipt'},
        batch:{policy:{kind:'source_core_correction',contract:parent.conferenceSourceCorrection.contract}},row:{record:{childExecutionId:parentId}}};
    const controls={registered:true,whole:true,pins:true,canonical:true},pdf={actualChild:childId};
    const presented=()=>({...structuredClone(child),paper_id:child.id});
    const env={clone:structuredClone,sha,stable:hash,isDeepStrictEqual:require('node:util').isDeepStrictEqual,
        inheritedReaderScience,CONTRACT:'conference-source-resource-correction-v1',CORE_CONTRACT:'conference-source-core-correction-v1',UUID:/^[a-f0-9-]{36}$/,
        fail:message=>{throw Error(message);},current:()=>active,isSourceCorrectionRecord:paper=>!!paper.conferenceSourceCorrection,
        independentReaderMaintenanceChild:()=>controls.registered,
        assertOutput:paper=>assert.equal(paper,parent,'old receipt cannot authenticate the new child'),
        withSavedPaper:(paper,callback)=>paper===child?inheritedReaderScience.run({paper,parent,assertUnchanged:()=>assert.equal(controls.pins,true)},callback):callback(),
        require:name=>{
            if(name==='node:fs')return{existsSync:()=>true};if(name==='node:path')return path;
            if(name==='../config')return{FILES:{conferenceAnalysisDir:'/analysis'}};
            if(name==='./conference-analysis-adapter')return{readerRevisionExecutionId:()=>childId,
                loadConferenceReaderRevision:()=>loaded,loadConferenceAnalysis:({executionId})=>executionId===parentId?original:
                    controls.canonical?loaded:{...loaded,analysisFileSha256:'tampered'}};
            if(name==='./conference-reader-publication-evidence')return{replayCanonicalReaderPdfSource:(paper,identity)=>{
                assert.equal(paper,child);assert.equal(identity.executionId,childId);return pdf;}};
            if(name==='./conference-analysis-context')return{withConferenceAnalysisSource:(scope,callback)=>contextScope.run(scope,callback),getConferenceAnalysisContext:()=>contextScope.getStore()};
            if(name==='./conference-source-context')return{readerPdfSourceForContext:handle=>{assert.equal(handle,pdf);return{paperId:'paper',sourceText:'source',assertUnchanged:()=>assert.equal(controls.pins,true)};}};
            if(name==='./conference-postprocess')return{readOriginalTagProof:()=>({rules:{}})};
            if(name==='../analysis-engine')return{isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>controls.whole};
            throw Error('unexpected '+name);
        }};
    const api=require('node:vm').runInNewContext(source.slice(source.indexOf('function publicationPaperMatches('),source.indexOf('// Read physical identity only.'))+
        '\n({withSavedPublicationPaper,readVerifiedPublicationPdfSource,exportPublicationVerification})',env);
    return{...api,controls,parent,child,original,loaded,pdf,parentId,childId,presented};
}
test('出版私有FD仅精确当前子稿使用自己的PDF，旧receipt只证明原科学评分（合成编排）',()=>{
    const f=publicationBridgeHarness(),presented=f.presented();
    f.withSavedPublicationPaper(presented,canonical=>{
        assert.equal(canonical,f.child);assert.equal(f.readVerifiedPublicationPdfSource(canonical),f.pdf);
        const proof=f.exportPublicationVerification(presented,canonical);
        assert.equal(proof.executionId,f.parentId);assert.equal(proof.readerExecutionId,f.childId);
        assert.equal(proof.canonicalPaperSha256,hash(f.child));assert.equal(proof.presentedPaperSha256,hash(presented));
        assert.equal(proof.scoringStageSha256,hash(f.parent.analysisManifest.stages.scoringAudit));
    });
    assert.equal(f.withSavedPublicationPaper(f.parent,canonical=>canonical),f.parent);
});
test('出版子稿拒裸登记、父CAS/来源/未完成及普通额外字段，不以旧父Reader通过替代新稿（合成编排）',()=>{
    for(const alter of [f=>f.controls.registered=false,f=>f.loaded.parent={...f.original,sourceFileSha256:'wrong'},
        f=>f.loaded.parent={...f.original,runFileSha256:'wrong'},f=>f.loaded.run.status='source_ready',f=>f.controls.whole=false]){
        const f=publicationBridgeHarness();alter(f);assert.throws(()=>f.withSavedPublicationPaper(f.presented(),()=>true));
    }
    const f=publicationBridgeHarness(),presented=f.presented();presented.extra='not fixed identity adaptation';
    assert.throws(()=>f.withSavedPublicationPaper(presented,()=>true));
});
test('出版async私有FD回调完成后仍核实际canonical CAS与完整呈现字节（合成编排）',async()=>{
    const f=publicationBridgeHarness();
    assert.equal(await f.withSavedPublicationPaper(f.presented(),async()=>42),42);
    await assert.rejects(f.withSavedPublicationPaper(f.presented(),async()=>{f.controls.canonical=false;return true;}),/实际稿或呈现字节改变/);
});

test('出版回调不能共同改写canonical与呈现Reader后以相等洗过（合成编排）',()=>{
    const f=publicationBridgeHarness(),presented=f.presented();
    assert.throws(()=>f.withSavedPublicationPaper(presented,canonical=>{
        canonical.analysisManifest.stages.apiReaderArticle.article='tampered';
        presented.analysisManifest.stages.apiReaderArticle.article='tampered';
    }),/实际稿或呈现字节改变/);
});
