'use strict';
// Offline admission/patch tests: real registered grant and real plan/source/PDF
// handles, synthetic failed stages/responses. These do not assert publication.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const api = require('../../scripts/lib/conference-reader-operator-correction');
const adapter = require('../../scripts/lib/conference-analysis-adapter');
const engine = require('../../scripts/analysis-engine'), deep = require('../../scripts/deep-analyzer');
const repair = require('../../scripts/lib/reader-repair'), context = require('../../scripts/lib/conference-analysis-context');
const grants = require('../../scripts/lib/conference-recovery-grant'), budget = require('../../scripts/lib/conference-reader-recovery-window');
const processApi = require('../../scripts/lib/conference-process');
const stop = require('../../scripts/lib/analysis-stop-control');
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

async function fixture(t, { historical = false, rawSchema = false, tableRestoration = false, priorContent = true } = {}) {
    const f = require('./conference-production-plan-fixture').productionPlanFixture(t);
    const helper = require('./conference-recovery-grant-fixture'), ids = helper.recoveryFixtureIdentity(f.paperId);
    const analysisRoot = path.join(f.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId: ids.parentExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: ids.parentExecutionId, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    const paper = { ...parent.analysis.papers[0], sourceSha256: repair.shaText(parent.source.sourceDetails.text),
        analysis: require('../valid-analysis-fixture').validAnalysisText(), apiReaderArticle: 'Synthetic inherited Reader',
        analysisManifest: { sourceAcquisition: { sourceSha256: repair.shaText(parent.source.sourceDetails.text),
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' }, stages: {
            primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
            scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    // The ordinary orchestration fixture starts with an aligned resource scan;
    // it does not exercise recovery of a stale parent's scan attachment. Build
    // the actual empty identity from this real sealed source before parent CAS.
    // Its synthetic Reader/scientific stages still grant no qualification.
    paper.apiReaderResources = await deep.buildApiReaderResourceIdentity(paper.analysis,
        parent.source.sourceDetails.text, {}, { paper, structuredArtifacts: parent.source.sourceDetails.structuredArtifacts });
    assert.deepEqual(paper.apiReaderResources.resources, []);
    paper.analysisManifest.stages.openSourceScan = { status: 'complete',
        resourceEvidenceContract: paper.apiReaderResources.contract,
        resourceEvidenceSha256: paper.apiReaderResources.identitySha256 };
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-17T12:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: ids.parentExecutionId });
    t.mock.method(require('../../scripts/lib/conference-postprocess'), 'readOriginalTagProof', () => ({ rules: {} }));
    const offlineFailure = () => Object.assign(Error('synthetic offline Reader failure'), historical
        ? { code: 'READER_REPAIR_NO_PROGRESS', retryable: false, scope: 'paper' } : {});
    const operations = { buildApiReaderResourceIdentity: deep.buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async () => null,
        refreshApiReaderArticleFromSource: async () => { throw offlineFailure(); } };
    const orchestration = { withPaperAnalysisLock: engine.withPaperAnalysisLock,
        LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false,
        analyzePaperWithRetry: async () => { throw offlineFailure(); } };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine: orchestration, deep: operations }), /synthetic offline/);
    const failedExecutionId = adapter.readerRevisionExecutionId(ids.parentExecutionId, parent.analysisFileSha256);
    if (historical && priorContent) {
        const directory = path.join(analysisRoot, failedExecutionId, 'reader-attempts');
        const diagnostics = require('../../scripts/lib/reader-request-diagnostics');
        const original = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
        const identity = { paperId: f.paperId, sourceSha256: repair.shaText(original.source.sourceDetails.text),
            contentMode: 'reader-source-only-v1', conferenceReaderRetryEpoch: 1 };
        const draft = { fixture: 'synthetic offline retained response; not scientific qualification' };
        const request = diagnostics.beginReaderRepairDiagnostic(directory, { identity, draft,
            draftSha256: repair.hashDraft(draft), prompt: 'synthetic offline request only', repairTargets: [] });
        diagnostics.saveReaderRepairResponse(request, JSON.stringify({ fixture: 'synthetic returned content' }));
    }
    const registered = helper.registerRecoveryFixture({ analysisRoot, parentExecutionId: ids.parentExecutionId, failedExecutionId, paperId: f.paperId });
    await assert.rejects(adapter.refreshConferenceGrantedRecovery({ ...input, failedExecutionId, grantHandle: registered.handle },
        { engine: orchestration, deep: operations }), /synthetic offline/);
    const member = grants.readRecoveryGrantMember(registered.handle, f.paperId);
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId: member.expectedExecutionId });
    const pdf = adapter.verifyPlanAuthority(loaded, f.planHandle, f.sourceRoot);
    const opts = { paperId: f.paperId, executionId: loaded.run.executionId, executionDir: loaded.directory, readerPdfSourceHandle: pdf };
    const sourceScope = callback => context.withConferenceAnalysisSource({ ...opts, sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1 }, callback);
    const kinds = ['background','related_work','problem','method_overview','component','training',
        'experiment_setup','result','ablation','limitation','reproduction','synthesis'];
    const draft = { version: 3, readerTitle: '根据真实来源核对输入与输出', oneSentenceThesis: '原文给出了可核对的实验条件。',
        sections: kinds.map((kind, i) => ({ kind, heading: '阶段' + i, body: '原始说明。'.repeat(30) })),
        conceptBridges: Array.from({ length: 4 }, () => ({ terms: ['输入','输出'], explanation: '原始组合解释' })),
        figurePlacements: [], tableBindings: [], formulaBindings: [] };
    if (tableRestoration) {
        draft.tableBindings = [1,2].map(tableIndex => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['Synthetic table fixture, not a scientific publication assertion.'] }));
        draft.sections[0].body += '\n\n[[TABLE_1]]\n\n[[TABLE_2]]';
    }
    let identity;
    await engine.withPaperAnalysisLock(paper, () => sourceScope(() => budget.withConferenceReaderGrant(registered.handle, opts, () => {
        const versions = require('../../scripts/lib/prompt-text-versions'), evidence = require('../../scripts/lib/prompt-evidence'), history = require('../../scripts/lib/prompt-history');
        identity = { paperId: f.paperId, sourceSha256: member.sourceSha256, contentMode: 'reader-source-only-v1',
            conferenceReaderRetryEpoch: 1,
            promptSha256: history.promptTemplateSha256(evidence.readPromptEvidenceBytes(versions.currentTextStagePromptPath('apiReaderArticle')).toString('utf8')),
            repairPromptSha256: history.promptTemplateSha256(evidence.readPromptEvidenceBytes(versions.currentTextStagePromptPath('apiReaderRepair')).toString('utf8')),
            model: { model: 'offline-synthetic-only' }, maxAttempts: 6, parserImplementationSha256: 'a'.repeat(64),
            ...budget.identityFields(paper) };
        if (rawSchema) draft.version = 4;
        budget.settleReaderResponse(budget.reserveReaderResponse(paper, identity, 'full', 1), 'content', JSON.stringify(draft));
        if (historical) budget.settleReaderResponse(budget.reserveReaderResponse(paper, identity, rawSchema ? 'full' : 'patch', 2), 'content', JSON.stringify(draft));
    })));
    const payload = { status: 'failed', draft: rawSchema ? null : draft, rawDraft: JSON.stringify(draft), attempts: historical ? 2 : 1, fullAttempts: rawSchema ? 2 : 1,
        transportFailures: 0, noProgress: 2, failureSignature: 'preserve-original', validationFailureStreak: 2,
        issues: [{ path: '/sections/0/body', message: 'synthetic content failure' }], imageEvidence: [] };
    const candidateFile = repair.saveFailedCandidate(path.join(loaded.directory, 'reader-attempts'), identity, payload);
    // Preserve a bad latest patch in the original material tree: the operator
    // branch never promotes that patch to an API response or retires it.
    fs.writeFileSync(path.join(loaded.directory, 'reader-attempts', 'latest-bad.raw'), 'not valid JSON: original failed patch', { mode: 0o600 });
    const projected = { ...structuredClone(draft), version: 3 };
    const restored = structuredClone(projected);
    const syntheticTables = [1,2].map(i => `| Method | Value |\n| --- | --- |\n| fixture-${i} | ${i} |`);
    if (tableRestoration) syntheticTables.forEach((table,index) => { restored.sections[0].body = restored.sections[0].body.replace(`[[TABLE_${index+1}]]`,table); });
    const patched = structuredClone(restored); patched.sections[0].body = '人工局部更正原始说明。'.repeat(30) + (tableRestoration ? '\n\n'+restored.sections[0].body : '');
    const recordRoot = path.join(registered.processDirectory, 'reader-operator-corrections'); fs.mkdirSync(recordRoot, { mode: 0o700 });
    const correctionFile = path.join(recordRoot, 'correction.json'), manifestPath = path.join(recordRoot, 'manifest.json');
    const record = { contract: api.CORRECTION, notLlmResponse: true, paperId: f.paperId, executionId: loaded.run.executionId,
        sourceSha256: member.sourceSha256, sourceSnapshotSha256: member.sourceSnapshotSha256,
        analysisFileSha256: loaded.analysisFileSha256, runFileSha256: loaded.runFileSha256, sourceFileSha256: loaded.sourceFileSha256,
        appliedAt: '2026-10-17T12:00:00.000Z', baselineCandidateFile: candidateFile,
        baselineCandidateEnvelopeSha256: repair.shaText(fs.readFileSync(candidateFile)), baselineDraftSha256: repair.hashDraft(rawSchema ? null : draft),
        patch: { version: 1, draftSha256: repair.hashDraft(restored), replacements: [
            { path: '/sections/0/body', oldSha256: repair.hashDraft(restored.sections[0].body), value: patched.sections[0].body }] }, draft: patched };
    write(correctionFile, record);
    if (rawSchema) {
        const last = JSON.parse(fs.readFileSync(path.join(loaded.directory, 'reader-grant-budget.json'))).requests.at(-1);
        Object.assign(record, { version: 1, correctionKind: api.PAID_RAW_JSON_SCHEMA,
            rawJsonSchemaCorrection: { originalRawSha256: repair.shaText(payload.rawDraft), originalVersion: 4,
                projectedDraftSha256: repair.hashDraft(projected), requestId: last.id, responseFileSha256: last.responseFileSha256 } });
        write(correctionFile, record);
    }
    if (tableRestoration) {
        const source = require('../../scripts/lib/conference-source-context').readerPdfSourceForContext(pdf);
        record.declaredTablePlaceholderRestoration = { contract: api.DECLARED_TABLE_RESTORATION,
            sourceTextSha256: member.sourceSha256, pdfSha256: source.pdfSha256,
            originalBindingsSha256: repair.hashDraft(projected.tableBindings), restoredDraftSha256: repair.hashDraft(restored),
            tables: syntheticTables.map((markdown,index) => ({ tableIndex: index+1, marker: `[[TABLE_${index+1}]]`,
                bodyPath: '/sections/0/body', originalBindingSha256: repair.hashDraft(projected.tableBindings[index]), markdown })) };
        write(correctionFile, record);
    }
    const state = structuredClone(registered.state), item = state.items[f.paperId];
    Object.assign(item, { attempts: 6, retryBudgetStart: 3, retryReleases: [{ at: '2026-10-17T12:00:00.000Z', attempts: 3,
        recoveryGrantId: member.grantId, recoveryGrantSha256: member.grantSha256 }] });
    if (historical) Object.assign(item, { attempts: 4,
        lastFailure: structuredClone(loaded.analysis.readerRevisionProgress.failures.at(-1)) });
    const saveState = () => { state.stateSha256 = processApi.stateDigest(state); processApi.assertState(state); write(path.join(registered.processDirectory, 'state.json'), state); };
    saveState();
    const manifest = { contract: api.CONTRACT, version: 1, processId: member.processId, grantId: member.grantId,
        grantSha256: member.grantSha256, authorization: 'Synthetic explicit human fixture only; no production permission',
        stateFileSha256: repair.shaText(fs.readFileSync(path.join(registered.processDirectory, 'state.json'))), correctionFiles: [correctionFile] };
    if (historical) manifest.normalHistoryAdmission = { contract: api.HISTORICAL_NORMAL_TERMINAL, members: [{
        paperId: f.paperId, executionId: loaded.run.executionId, priorExecutionId: failedExecutionId,
        currentMaterialsSha256: grants.recoveryWindowMaterials(analysisRoot, loaded.run.executionId).materialsSha256,
        priorMaterialsSha256: grants.recoveryWindowMaterials(analysisRoot, failedExecutionId).materialsSha256 }] };
    write(manifestPath, manifest);
    const options = { manifestPath, processDirectory: registered.processDirectory, analysisRoot, grantHandle: registered.handle };
    const refreshManifest = () => { manifest.stateFileSha256 = repair.shaText(fs.readFileSync(path.join(registered.processDirectory, 'state.json'))); write(manifestPath, manifest); };
    return { ...f, loaded, registered, opts, identity, payload, record, candidateFile, correctionFile, manifestPath,
        options, state, saveState, manifest, refreshManifest, patched, sourceScope };
}
module.exports = { fixture };
