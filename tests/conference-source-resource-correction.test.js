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
