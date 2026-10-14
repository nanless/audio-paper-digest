'use strict';
const { isDeepStrictEqual } = require('node:util');
const accepted = new WeakMap();
const CONTRACT = 'reader-parent-upstream-preflight-v1';
const TEXT_STAGES = Object.freeze(['openSourceScan', 'revision', 'tableRepair', 'methodRepair',
    'structureRepair', 'tagSelection', 'coreSummaryRepair']);
function parentIdentity(paper) {
    const withoutReader = object => Object.fromEntries(Object.entries(object || {}).filter(([key]) =>
        !/^apiReader/.test(key) && !['imageSupplement', 'imageDownload', 'imageNarrative'].includes(key)));
    return require('./reader-repair').hashDraft({ paperId: paper.arxivId,
        sourceSha256: paper.sourceSha256, sourceAcquisition: paper.analysisManifest?.sourceAcquisition,
        freshRewriteProvenance: paper.freshRewriteProvenance, analysis: paper.analysis, parsed: paper.parsed,
        retainedAccounting: Object.fromEntries(Object.entries(paper).filter(([key]) =>
            !/^apiReader/.test(key) && /(?:usage|paid|cost|fee|budget)/i.test(key))),
        analysisCheckpoint: paper.analysisCheckpoint,
        checkpoints: withoutReader(paper.analysisStageCheckpoints),
        stages: withoutReader(paper.analysisManifest?.stages),
        contracts: withoutReader(paper.analysisManifest?.contracts),
        fullStageReanalysis: paper.fullStageReanalysis });
}
function assertSavedReaderParentUpstream(handle, paper, source) {
    const record = accepted.get(handle), repair = require('./reader-repair'), facts = require('./daily-fact-review');
    const fresh = require('./fresh-analysis-context'), active = facts.current(paper.arxivId);
    const hasUpstreamFacts = Object.entries(paper.analysisManifest?.stages || {}).some(([stage, value]) =>
        !/^apiReader/.test(stage) && !['imageSupplement', 'imageDownload'].includes(stage)
        && (value?.factReview || value?.scoringFactReview));
    const actualScopeProof = active?.readerOnly && !hasUpstreamFacts ? null : active?.proof || null;
    if (!record || !fresh.isDailyFreshSourceScope() || !require('../analysis-engine').paperAnalysisLockHeld(paper)
        || repair.hashDraft(handle) !== record.reportSha256 || parentIdentity(paper) !== record.parentSha256
        || repair.hashDraft(actualScopeProof) !== record.scopeSha256) {
        throw new Error('Reader父阶段预检凭证缺失、变动或不属于当前真实上游作用域');
    }
    const actual = require('./model-text-sanitization').currentModelInputSource(paper);
    if (!actual || repair.hashDraft(actual.freshSourceDescriptor) !== record.sourceDescriptorSha256
        || !isDeepStrictEqual(source, actual)) throw new Error('Reader父阶段预检凭证的封存来源不同');
    fresh.assertFreshPaper(paper);
    return handle.proof;
}
function inspectSavedReaderParentUpstream(paper, source) {
    const fresh = require('./fresh-analysis-context'), repair = require('./reader-repair');
    const facts = require('./daily-fact-review'), engine = require('../analysis-engine');
    if (!fresh.isDailyFreshSourceScope() || !engine.paperAnalysisLockHeld(paper)
        || facts.current(paper?.arxivId)?.readerOnly || !source?.text) {
        throw new Error('Reader父阶段预检须在当前日更论文锁与真实上游反馈作用域中执行');
    }
    const actual = require('./model-text-sanitization').currentModelInputSource(paper);
    if (!actual || !isDeepStrictEqual(actual.freshSourceDescriptor, source.freshSourceDescriptor)
        || repair.shaText(actual.text) !== paper.sourceSha256 || actual.text !== source.text
        || !isDeepStrictEqual(actual.structuredArtifacts, source.structuredArtifacts)) {
        throw new Error('Reader父阶段预检的封存来源或论文身份不同');
    }
    fresh.assertFreshPaper(paper);
    const deep = require('../deep-analyzer'), clone = structuredClone(paper);
    const manifest = clone.analysisManifest;
    const before = require('./daily-fresh-source-plan').stableHash(paper);
    const proof = { contract: CONTRACT, paperId: paper.arxivId, paperSha256: before,
        sourceDescriptorSha256: repair.hashDraft(actual.freshSourceDescriptor),
        upstreamFactReviewSha256: repair.hashDraft(facts.current(paper.arxivId)?.proof || null) };
    if (!require('./completed-reader-upstream').completedReaderUpstream(paper, actual)) {
        return { current: false, invalidatedStages: [], prerequisiteCurrent: false, proof };
    }
    const primaryEvidence = deep.buildTaskEvidenceContext(actual.text,
        require('../config').ANALYSIS_CONFIG.fullTextMaxChars, undefined, 'PRIMARY');
    const fingerprints = deep.buildRecoveryFingerprints(clone, primaryEvidence, paper.arxivId, manifest);
    const primaryFactReview = Boolean(facts.current(paper.arxivId)?.feedback.primaryFeedback?.trim()
        || manifest.stages.primaryAnalysis?.factReview);
    const savedCoreSummaryRepairActive = !require('./selected-full-stage-reanalysis').current(paper) && !primaryFactReview
        && deep.canReuseStageForCoreSummaryRecovery(clone, manifest, actual.text, 'primaryAnalysis');
    const invalidatedStages = [];
    if (!savedCoreSummaryRepairActive && deep.invalidateRecoveryStageIfChanged(clone, manifest,
        'primaryAnalysis', fingerprints.primaryAnalysis)) invalidatedStages.push('primaryAnalysis');
    if (!savedCoreSummaryRepairActive && deep.invalidateRecoveryStageIfChanged(clone, manifest,
        'demoLinkScan', fingerprints.demoLinkScan)) invalidatedStages.push('demoLinkScan');
    const inspectedStages = [];
    for (const stage of TEXT_STAGES) {
        if (!deep.isRecoveryStageComplete(manifest, stage)) continue;
        const prepared = deep.prepareTextRecoveryStage(clone, manifest, stage,
            clone.analysisCheckpoint || '', actual.text);
        inspectedStages.push({ stage, fingerprint: prepared.fingerprint,
            compatibilityReused: prepared.compatibilityReused, invalidated: prepared.invalidated });
        if (prepared.invalidated) invalidatedStages.push(stage);
    }
    const result = { current: invalidatedStages.length === 0, prerequisiteCurrent: true,
        invalidatedStages, proof: { ...proof, inspectedStages,
            primaryFingerprint: fingerprints.primaryAnalysis, demoFingerprint: fingerprints.demoLinkScan } };
    if (result.current) accepted.set(result, { reportSha256: repair.hashDraft(result),
        parentSha256: parentIdentity(paper), sourceDescriptorSha256: proof.sourceDescriptorSha256,
        scopeSha256: proof.upstreamFactReviewSha256 });
    return result;
}
module.exports = { CONTRACT, TEXT_STAGES, inspectSavedReaderParentUpstream, assertSavedReaderParentUpstream };
