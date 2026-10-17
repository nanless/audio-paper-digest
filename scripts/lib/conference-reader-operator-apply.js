'use strict';
// Local Reader corrections use the normal parser and full qualification. They
// never enter a paid round, clear counters, or modify their original candidates.
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const adapter = require('./conference-analysis-adapter');
const corrections = require('./conference-reader-operator-correction');
function fail(message) {
    throw Object.assign(new Error('会议人工 Reader 保存拒绝：' + message), {
        code: 'CONFERENCE_READER_OPERATOR_APPLY_REJECTED', scope: 'paper', retryable: false });
}
function protectedProjection(paper, { checkpointImages = false } = {}) {
    const stages = structuredClone(paper.analysisManifest?.stages || {});
    delete stages.apiReaderArticle;
    if (checkpointImages) delete stages.imageSupplement;
    const checkpoints = structuredClone(paper.analysisStageCheckpoints || {});
    delete checkpoints.apiReaderArticle;
    return { analysis: paper.analysis, sourceSha256: paper.sourceSha256,
        stages, checkpoints, analysisCheckpoint: paper.analysisCheckpoint,
        scoringAudit: paper.scoringAudit, parsed: paper.parsed };
}
function qualifyAndSeal(loaded, { planHandle, sourceRoot }, engine) {
    const paper = loaded.analysis.papers[0];
    const qualify = () => corrections.withSavedPaper(paper, () => {
        const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
        if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) fail('保存稿冷核未通过完整资格');
    });
    // Reconstruct true source authority independently of the hot edit scope.
    // This can authenticate a real saved receipt after analysis CAS but before
    // the completed-run seal, including recovery from that precise crash gap.
    const readerPdfSourceHandle = adapter.verifyPlanAuthority(loaded, planHandle, sourceRoot);
    require('./conference-analysis-context').withConferenceAnalysisSource({
        executionId: loaded.run.executionId, executionDir: loaded.directory, paperId: loaded.run.paperId,
        sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1, readerPdfSourceHandle }, qualify);
    adapter.sealCompletedRun(loaded);
    // After the seal, also exercise the canonical PDF source reconstruction
    // without a caller-provided source scope. Neither replay can request models.
    qualify();
}
async function applyCorrection({ batchHandle, analysisRoot, executionId, planHandle, sourceRoot }, overrides = {}) {
    const engine = overrides.engine || require('../analysis-engine');
    const deep = overrides.deep || require('../deep-analyzer');
    const initial = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
    const identity = { id: initial.run.paperId };
    return engine.withPaperAnalysisLock(identity, async () => {
        const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
        if (loaded.analysis.status === 'complete') {
            const paper = loaded.analysis.papers[0];
            if (paper.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance?.contract !== corrections.CORRECTION) {
                fail('已有完成稿不是这项真实人工修正');
            }
            corrections.assertSavedBatchMember(batchHandle, paper);
            qualifyAndSeal(loaded, { planHandle, sourceRoot }, engine);
            const sealed = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
            return { executionId, paperId: sealed.run.paperId, status: 'complete',
                ...sealedAdoptionIdentity(sealed), revision: sealed.revision, resumed: true };
        }
        const result = await corrections.withCorrection(batchHandle, { executionId, planHandle, sourceRoot }, async () => {
            const prepared = corrections.prepareReaderInput();
            const before = prepared.paper, paper = structuredClone(before);
            const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
            const upstream = prepared.mainCheckpointRecovery ? null
                : engine.getConferenceReaderRefreshUpstreamReason(paper, { tagRules: rules });
            if (upstream) fail('人工 Reader 无权修正上游：' + upstream);
            const result = await deep.refreshApiReaderArticleFromSource(paper, loaded.source.sourceDetails,
                { preserveReaderUpstream: true, readerAuthors: structuredClone(paper.apiReaderAuthors) });
            corrections.finalizeCheckpointImages(result);
            const protectOptions = { checkpointImages: Boolean(prepared.mainCheckpointRecovery) };
            if (!isDeepStrictEqual(protectedProjection(result, protectOptions), protectedProjection(before, protectOptions))) fail('修正改变 Reader 以外的原正文或阶段');
            if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(result, { tagRules: rules })) fail('正常整篇资格未通过');
            const receipt = corrections.sealCorrection(result);
            receipt.assertUnchanged();
            const current = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
            if (current.analysisFileSha256 !== loaded.analysisFileSha256 || current.runFileSha256 !== loaded.runFileSha256) fail('原稿保存前已变化');
            adapter.replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis,
                papers: [result], status: 'complete', completedAt: new Date().toISOString(),
                generation: loaded.analysis.generation + 1,
                readerOperatorRecovery: { receiptFile: receipt.receiptFile, receiptSha256: receipt.receiptSha256 },
                stats: { ...(loaded.analysis.stats || {}), analysisStatus: 'complete' } }, loaded.analysisFileSha256);
            return { executionId, paperId: loaded.run.paperId, status: 'complete',
                revision: loaded.revision };
        });
        // Leave the hot before-CAS scope. Only the registered receipt and real
        // canonical/source chain may authorize this independent cold replay.
        const completed = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
        qualifyAndSeal(completed, { planHandle, sourceRoot }, engine);
        const sealed = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId });
        return { ...result, ...sealedAdoptionIdentity(sealed) };
    }, { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}
async function applyAndStageBatch({ manifestPath, grantHandle, directory, state, shared }, deps) {
    const processApi = require('./conference-process');
    const batchHandle = corrections.openCorrectionBatch({ manifestPath, processDirectory: directory,
        analysisRoot: deps.files.conferenceAnalysisDir, grantHandle });
    const manifest = adapter.readJsonRecord(manifestPath);
    const staged = [];
    // Finish and stage every local result before adopting any process item. A
    // failure leaves the exact original process state and all accepted children.
    for (const file of manifest.value.correctionFiles) {
        const record = adapter.readJsonRecord(file).value, item = state.items[record.paperId];
        if (!item || item.status === 'complete') fail('人工清单不对应完整当前失败集');
        const retained = shared.retainedSources?.get(item.analysisRunId);
        const planHandle = retained?.planHandle || shared.planHandle;
        const sourceRoot = retained?.sourceRoot || shared.sourceCacheRoot;
        const result = await applyCorrection({ batchHandle, analysisRoot: deps.files.conferenceAnalysisDir,
            executionId: record.executionId, planHandle, sourceRoot }, { engine: deps.engine, deep: deps.deep });
        const page = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
            executionId: result.executionId, tagCatalogPath: deps.files.tagCatalogFile,
            stagingRoot: deps.files.conferencePageStagingDir, planHandle, sourceRoot, apply: true });
        if (page.status !== 'staged') fail('人工结果未通过正常页面后处理');
        assertAdoptionStageBinding(record, result, page.manifest);
        staged.push({ record, result, page, retained, planHandle, sourceRoot });
    }
    const stateFile = path.join(directory, 'state.json');
    const next = await withSortedAdoptionLocks(staged.map(row => row.record.paperId), deps.engine, () => {
        for (const row of staged) {
            const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: row.result.executionId });
            if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
                || loaded.analysisFileSha256 !== row.result.analysisSha256
                || loaded.runFileSha256 !== row.result.runFileSha256
                || loaded.sourceFileSha256 !== row.result.sourceFileSha256) fail('人工整批采纳前真实子稿CAS改变');
            const stage = deps.postprocess.loadStage({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: row.result.executionId, tagCatalogPath: deps.files.tagCatalogFile,
                stagingRoot: deps.files.conferencePageStagingDir,
                planHandle: row.planHandle, sourceRoot: row.sourceRoot });
            assertAdoptionStageBinding(row.record, row.result, stage.manifest);
            if (stage.manifest.manifestSha256 !== row.page.manifest.manifestSha256) fail('人工整批采纳前暂存凭证改变');
        }
        return deps.engine.updateJsonFileLocked(stateFile, current => {
        const checked = processApi.assertState(current);
        if (checked.stateSha256 !== state.stateSha256
            || adapter.readJsonRecord(stateFile).sha256 !== manifest.value.stateFileSha256
            || adapter.readJsonRecord(manifestPath).sha256 !== manifest.sha256) fail('整批采纳前原进程或清单字节已变化');
        const value = structuredClone(checked);
        for (const { record, result, page } of staged) {
            const original = value.items[record.paperId];
            value.items[record.paperId] = { ...original, status: 'complete',
                analysisRunId: result.executionId, readerRevision: result.revision, readerRefreshRequired: false,
                analysisProof: { analysisSha256: result.analysisSha256,
                    completionReceiptSha256: page.manifest.completionReceiptSha256,
                    sourceSnapshotSha256: page.manifest.sourceSnapshotSha256 },
                pageProof: { manifestSha256: page.manifest.manifestSha256,
                    contentSha256: page.manifest.contentSha256, pagePath: page.manifest.pagePath },
                readerOperatorAdoption: { manifestFile: manifestPath, manifestSha256: manifest.sha256,
                    previousStateSha256: checked.stateSha256, previousAttempts: original.attempts,
                    previousFailure: original.lastFailure || null },
                lastError: null, lastFailure: null, reviewRequired: null, retryNotBefore: null, updatedAt: deps.now() };
        }
        value.status = 'running'; value.aggregate = null; value.completionReceiptSha256 = null;
        value.generation++; value.updatedAt = deps.now(); value.stateSha256 = processApi.stateDigest(value);
        return processApi.assertState(value);
        });
    });
    for (const { result, retained, planHandle, sourceRoot } of staged) if (shared.retainedSources) {
        shared.retainedSources.set(result.executionId, { ...retained, planHandle, sourceRoot });
    }
    return next;
}
function sealedAdoptionIdentity(loaded) {
    if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete') fail('采纳须绑定真实完整子运行');
    return { analysisSha256: loaded.analysisFileSha256, runFileSha256: loaded.runFileSha256,
        sourceFileSha256: loaded.sourceFileSha256,
        completionReceiptSha256: loaded.run.completionReceipt.receiptSha256,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256 };
}
function assertAdoptionStageBinding(record, result, manifest) {
    if (manifest.paperId !== record.paperId || manifest.analysisExecutionId !== record.executionId
        || manifest.analysisExecutionId !== result.executionId || manifest.analysisSha256 !== result.analysisSha256
        || manifest.completionReceiptSha256 !== result.completionReceiptSha256
        || manifest.sourceSnapshotSha256 !== result.sourceSnapshotSha256) fail('人工分析与页面证明不是同一真实稿件');
}
function withSortedAdoptionLocks(ids, engine, callback) {
    const ordered = [...new Set(ids)].sort();
    const next = index => index === ordered.length ? callback()
        : engine.withPaperAnalysisLock({ id: ordered[index] }, () => next(index + 1),
            { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
    return next(0);
}
module.exports = { applyCorrection, applyAndStageBatch, protectedProjection };
