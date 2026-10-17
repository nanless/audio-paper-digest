'use strict';
// Real plan/PDF/grant bookkeeping; all scientific/model outcomes are explicit
// synthetic orchestration doubles, never claims of paper qualification.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const adapter = require('../../scripts/lib/conference-analysis-adapter');
const actualEngine = require('../../scripts/analysis-engine');
const actualDeep = require('../../scripts/deep-analyzer');
const context = require('../../scripts/lib/conference-analysis-context');
const grants = require('../../scripts/lib/conference-recovery-grant');
const budget = require('../../scripts/lib/conference-reader-recovery-window');
const { productionPlanFixture } = require('./conference-production-plan-fixture');
const { recoveryFixtureIdentity, registerRecoveryFixture } = require('./conference-recovery-grant-fixture');
const { validAnalysisText, validAnalysisPaper } = require('../valid-analysis-fixture');

async function fixture(t, { invalidCore = false, scoringMode = false, scoringFailed = false, coreRejected = false, tagProofCase = null } = {}) {
    const f = productionPlanFixture(t), identity = recoveryFixtureIdentity(f.paperId);
    const analysisRoot = path.join(f.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId: identity.parentExecutionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: identity.parentExecutionId, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    let analysis = invalidCore ? 'original invalid core' : validAnalysisText().replace('## 核心摘要\n',
        '## 核心摘要\n原文未提供可核对的关键定量结果。');
    if (scoringMode) analysis = analysis.replace('has_code: 否', 'has_code: 是');
    const sourceSha256 = require('crypto').createHash('sha256').update(parent.source.sourceDetails.text).digest('hex');
    const paper = { ...parent.analysis.papers[0], sourceSha256, analysis, apiReaderArticle: 'original parent Reader',
        analysisManifest: { sourceAcquisition: { sourceSha256: parent.source.sourceDetails.text &&
            require('crypto').createHash('sha256').update(parent.source.sourceDetails.text).digest('hex'),
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' },
            stages: { primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
                scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    if (tagProofCase) {
        const tagged = validAnalysisPaper(undefined, {}, analysis);
        paper.analysisManifest.contracts = tagged.analysisManifest.contracts;
        paper.analysisManifest.stages.taxonomySeal = tagged.analysisManifest.stages.taxonomySeal;
        paper.analysisManifest.stages.structureRepair = tagged.analysisManifest.stages.structureRepair;
        paper.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256 =
            tagged.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256;
        paper.analysisStageCheckpoints = tagged.analysisStageCheckpoints;
        if (tagProofCase.parent === 'missing') {
            delete paper.analysisManifest.stages.taxonomySeal;
            delete paper.analysisStageCheckpoints.taxonomySeal;
        } else if (tagProofCase.parent === 'mismatch') {
            paper.analysis = paper.analysis.replace(/#语音识别/g, '#语音合成');
        }
    }
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-17T12:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    const post = require('../../scripts/lib/conference-postprocess'), oldRead = post.readOriginalTagProof;
    post.readOriginalTagProof = () => ({ rules: {} }); t.after(() => { post.readOriginalTagProof = oldRead; });
    const engine = { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: actualEngine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        withPaperAnalysisLock: actualEngine.withPaperAnalysisLock,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false };
    const operations = { buildApiReaderResourceIdentity: actualDeep.buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async () => null,
        refreshApiReaderArticleFromSource: async () => { throw Error('original paid fixture failure'); } };
    operations.refreshApiScoringAndReaderFromSource = async (current, _source, options) => {
        if (scoringFailed) throw Object.assign(Error('original scoring content exhausted'), { retryable: false });
        current.analysis = actualDeep.applyApiReaderResourceAvailability(current.analysis, current.apiReaderResources);
        const audit = { fixture: 'signed-score-content' };
        current.analysisManifest.stages.scoringAudit = { status: 'complete', audit,
            auditSha256: adapter.stableHash(audit), fixtureScoringToken: 'preserve-original-paid-score' };
        await options.onScoringComplete(current);
        throw Error('original paid fixture failure');
    };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine, deep: operations }),
        scoringFailed ? /original scoring content exhausted/ : /original paid fixture failure/);
    const failedExecutionId = adapter.readerRevisionExecutionId(identity.parentExecutionId, parent.analysisFileSha256);
    let failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    adapter.replaceJson(path.join(failed.directory, 'analysis.json'), { ...failed.analysis,
        readerRevisionProgress: { ...failed.analysis.readerRevisionProgress, attempts: 3 } }, failed.analysisFileSha256);
    failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    if (coreRejected) {
        const changed = structuredClone(failed.analysis);
        changed.papers[0].analysisCheckpoint = changed.papers[0].analysis;
        changed.papers[0].analysisManifest.stages.coreSummaryRepair.status = 'contract_rejected';
        adapter.replaceJson(path.join(failed.directory, 'analysis.json'), changed, failed.analysisFileSha256);
        failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    }
    if (tagProofCase) {
        const changed = structuredClone(failed.analysis), current = changed.papers[0];
        if (tagProofCase.forceNormal !== false) current.analysisManifest.stages.primaryAnalysis.status = 'contract_rejected';
        if (tagProofCase.failed === 'missing') {
            delete current.analysisManifest.stages.taxonomySeal;
            delete current.analysisStageCheckpoints.taxonomySeal;
        } else if (tagProofCase.failed === 'mismatch') {
            current.analysis = current.analysis.replace(/#语音识别/g, '#语音合成');
        }
        adapter.replaceJson(path.join(failed.directory, 'analysis.json'), changed, failed.analysisFileSha256);
        failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    }
    const grant = registerRecoveryFixture({ analysisRoot, parentExecutionId: identity.parentExecutionId, failedExecutionId, paperId: f.paperId });
    // The new regressions below use the real tag proof reader for every grant
    // entry and final gate. Only the pre-existing synthetic bootstrap uses the
    // orchestration double, before the tested recovery operation starts.
    if (tagProofCase) post.readOriginalTagProof = oldRead;
    return { ...f, ...input, failedExecutionId, failed, grant, engine, operations };
}


module.exports = { fixture };
