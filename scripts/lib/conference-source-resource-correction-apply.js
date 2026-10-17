'use strict';
// The existing adapter owns canonical preparation/sealing and CAS; the source
// module alone owns admission, exact bounded edits and hot/cold authentication.
const path = require('node:path');
const adapter = require('./conference-analysis-adapter');
const source = require('./conference-source-resource-correction');
const processApi = require('./conference-process');
function fail(message) {
    throw Object.assign(new Error('会议来源纠正保存拒绝：' + message), {
        code: 'CONFERENCE_SOURCE_CORRECTION_APPLY_REJECTED', scope: 'run', retryable: false });
}
function qualifyAndSeal(loaded, { planHandle, sourceRoot }, engine) {
    const paper = loaded.analysis.papers[0];
    const qualify = () => source.withSavedPaper(paper, () => {
        const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
        if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) {
            fail('保存的来源纠正稿未通过正常整篇资格');
        }
    });
    const pdf = adapter.verifyPlanAuthority(loaded, planHandle, sourceRoot);
    require('./conference-analysis-context').withConferenceAnalysisSource({
        paperId: paper.id, executionId: loaded.run.executionId, executionDir: loaded.directory,
        sourceDetails: loaded.source.sourceDetails, readerPdfSourceHandle: pdf }, qualify);
    if (loaded.run.status !== 'complete') adapter.sealCompletedRun(loaded);
    qualify(); // Real canonical/source reconstruction after leaving hot context.
}
async function applyCorrection({ batchHandle, record, manifestSha256, analysisRoot, planHandle, sourceRoot }, deps) {
    const deep = deps.deep || require('../deep-analyzer');
    return deps.engine.withPaperAnalysisLock({ id: record.paperId }, async () => {
        // Preparation may recover the exact same pending/complete fixed UUID.
        // It never installs a new Reader grant or copies an old preflight.
        const result = await source.withCorrection(batchHandle, {
            executionId: record.childExecutionId, planHandle, sourceRoot
        }, async () => {
            const initial = adapter.loadConferenceAnalysis({ analysisRoot, executionId: record.childExecutionId });
            if (initial.analysis.status === 'complete') {
                const paper = initial.analysis.papers[0];
                if (paper.conferenceSourceCorrection?.manifestSha256 !== manifestSha256
                    || paper.conferenceSourceCorrection.executionId !== record.childExecutionId) {
                    fail('已有完成子稿不属于当前实际清单');
                }
                // Do not cold-verify inside a before-CAS edit scope. Return
                // first; the independent saved receipt path below replays it.
                return { resumed: true, paperId: record.paperId, executionId: record.childExecutionId };
            }
            const selected = adapter.loadConferenceAnalysis({ analysisRoot,
                executionId: record.selectedMainExecutionId });
            const paper = structuredClone(selected.analysis.papers[0]);
            // The private source module verifies selected upstream and separate
            // Reader parent, then the shared normal parser/finalizer handles it.
            const finalized = await deep.finalizeConferenceLocalSourceCorrection(
                paper, initial.source.sourceDetails);
            const rules = require('./conference-postprocess').readOriginalTagProof(finalized).rules;
            if (!deps.engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(finalized, { tagRules: rules })) {
                fail('来源纠正尚未通过正常整篇资格');
            }
            const receipt = source.sealCorrection(finalized);
            const current = adapter.loadConferenceAnalysis({ analysisRoot, executionId: record.childExecutionId });
            if (current.analysisFileSha256 !== receipt.expectedChildAnalysisFileSha256
                || current.runFileSha256 !== receipt.expectedChildRunFileSha256) fail('保存前真实子运行CAS改变');
            adapter.replaceJson(path.join(current.directory, 'analysis.json'), {
                ...current.analysis, papers: [finalized], status: 'complete', completedAt: record.appliedAt,
                generation: current.analysis.generation + 1,
                sourceResourceCorrection: { receiptFile: receipt.receiptFile, receiptSha256: receipt.receiptSha256,
                    selectedMainExecutionId: record.selectedMainExecutionId,
                    readerParentExecutionId: record.readerParentExecutionId,
                    newApiRequests: 0 },
                stats: { ...(current.analysis.stats || {}), analysisStatus: 'complete' }
            }, current.analysisFileSha256);
            return { resumed: false, paperId: record.paperId, executionId: record.childExecutionId };
        });
        const completed = adapter.loadConferenceAnalysis({ analysisRoot, executionId: record.childExecutionId });
        qualifyAndSeal(completed, { planHandle, sourceRoot }, deps.engine);
        const sealed = adapter.loadConferenceAnalysis({ analysisRoot, executionId: record.childExecutionId });
        return { ...result, analysisSha256: sealed.analysisFileSha256,
            runFileSha256: sealed.runFileSha256, sourceFileSha256: sealed.sourceFileSha256,
            completionReceiptSha256: sealed.run.completionReceipt.receiptSha256,
            sourceSnapshotSha256: sealed.run.sourceSnapshotSha256 };
    }, { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}
async function applyAndStageBatch({ manifestPath, directory, state, shared }, deps) {
    const batchHandle = source.openBatch({ processId: state.processId, manifestPath });
    const manifest = adapter.readJsonRecord(manifestPath), completed = [];
    for (const entry of manifest.value.records) {
        const record = adapter.readJsonRecord(entry.file).value;
        const original = state.items[record.paperId];
        if (!original) fail('来源清单不属于原进程');
        const retained = shared.retainedSources?.get(original.analysisRunId);
        const planHandle = retained?.planHandle || shared.planHandle;
        const sourceRoot = retained?.sourceRoot || shared.sourceCacheRoot;
        const result = await applyCorrection({ batchHandle, record, manifestSha256: manifest.sha256,
            analysisRoot: deps.files.conferenceAnalysisDir, planHandle, sourceRoot }, deps);
        const page = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
            executionId: result.executionId, tagCatalogPath: deps.files.tagCatalogFile,
            stagingRoot: deps.files.conferencePageStagingDir, planHandle, sourceRoot, apply: true });
        if (page.status !== 'staged') fail('来源纠正稿未通过正常页面后处理');
        assertStageBinding(record, result, page.manifest);
        completed.push({ record, result, page, retained, planHandle, sourceRoot });
    }
    const stateFile = path.join(directory, 'state.json');
    const next = await withSortedPaperLocks(completed.map(row => row.record.paperId), deps.engine, () => {
        // Reacquire all source members in canonical order. No child writer can
        // replace a qualified analysis between this final check and adoption.
        for (const row of completed) {
            const loaded = adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: row.result.executionId });
            if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
                || loaded.analysisFileSha256 !== row.result.analysisSha256
                || loaded.runFileSha256 !== row.result.runFileSha256
                || loaded.sourceFileSha256 !== row.result.sourceFileSha256) fail('最终采纳前子稿CAS改变');
            const stage = deps.postprocess.loadStage({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: row.result.executionId, tagCatalogPath: deps.files.tagCatalogFile,
                stagingRoot: deps.files.conferencePageStagingDir,
                planHandle: row.planHandle, sourceRoot: row.sourceRoot });
            assertStageBinding(row.record, row.result, stage.manifest);
            if (stage.manifest.manifestSha256 !== row.page.manifest.manifestSha256) fail('最终暂存凭证变化');
        }
        return deps.engine.updateJsonFileLocked(stateFile, current => {
        const checked = processApi.assertState(current);
        if (checked.stateSha256 !== state.stateSha256
            || adapter.readJsonRecord(stateFile).sha256 !== manifest.value.stateFileSha256
            || adapter.readJsonRecord(manifestPath).sha256 !== manifest.sha256) fail('原子采纳前状态或清单改变');
        const value = structuredClone(checked);
        for (const { record, result, page } of completed) {
            const previous = value.items[record.paperId];
            if (processApi.stableHash(previous) !== record.observedItemSha256) fail('原成员字节投影改变');
            const item = { ...previous, status: 'complete', analysisRunId: result.executionId,
                readerRefreshRequired: false,
                analysisProof: { analysisSha256: result.analysisSha256,
                    completionReceiptSha256: page.manifest.completionReceiptSha256,
                    sourceSnapshotSha256: page.manifest.sourceSnapshotSha256 },
                pageProof: { manifestSha256: page.manifest.manifestSha256,
                    contentSha256: page.manifest.contentSha256, pagePath: page.manifest.pagePath },
                sourceResourceCorrectionAdoption: { manifestFile: manifestPath, manifestSha256: manifest.sha256,
                    previousStateSha256: checked.stateSha256, previousItemSha256: record.observedItemSha256,
                    previousAttempts: previous.attempts, previousFailure: previous.lastFailure || null,
                    selectedMainExecutionId: record.selectedMainExecutionId,
                    readerParentExecutionId: record.readerParentExecutionId, newApiRequests: 0 },
                lastError: null, lastFailure: null, retryNotBefore: null, reviewRequired: null, updatedAt: deps.now() };
            // This is a separate source-fact child, never an invented Reader
            // revision. The true old revision stays in archived original state.
            delete item.readerRevision;
            value.items[record.paperId] = item;
        }
        value.status = 'running'; value.aggregate = null; value.completionReceiptSha256 = null;
        value.generation++; value.updatedAt = deps.now(); value.stateSha256 = processApi.stateDigest(value);
        return processApi.assertState(value);
        });
    });
    for (const { result, retained, planHandle, sourceRoot } of completed) if (shared.retainedSources) {
        shared.retainedSources.set(result.executionId, { ...retained, planHandle, sourceRoot });
    }
    return next;
}
function assertStageBinding(record, result, manifest) {
    if (manifest.paperId !== record.paperId || manifest.analysisExecutionId !== result.executionId
        || manifest.analysisSha256 !== result.analysisSha256
        || manifest.completionReceiptSha256 !== result.completionReceiptSha256
        || manifest.sourceSnapshotSha256 !== result.sourceSnapshotSha256
        || manifest.sourceSnapshotSha256 !== record.sourceSnapshotSha256) fail('分析与页面证明来自不同稿件');
}
function withSortedPaperLocks(ids, engine, callback) {
    const ordered = [...new Set(ids)].sort();
    const next = index => index === ordered.length ? callback()
        : engine.withPaperAnalysisLock({ id: ordered[index] }, () => next(index + 1),
            { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
    return next(0);
}
module.exports = { applyCorrection, applyAndStageBatch, assertStageBinding };
