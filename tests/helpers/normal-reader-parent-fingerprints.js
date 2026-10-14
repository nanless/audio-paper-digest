'use strict';
// Test-only seeding of actual public normal-stage fingerprints. No capability
// is mocked, and source/feedback/lock qualification remains in the tested code.
function installCurrentParentFingerprints(paper, source) {
    const deep = require('../../scripts/deep-analyzer'), Config = require('../../scripts/config');
    const textStages = require('../../scripts/lib/reader-parent-upstream-preflight').TEXT_STAGES;
    const evidence = deep.buildTaskEvidenceContext(source.text, Config.ANALYSIS_CONFIG.fullTextMaxChars, undefined, 'PRIMARY');
    const fingerprints = deep.buildRecoveryFingerprints(paper, evidence, paper.arxivId, paper.analysisManifest);
    paper.analysisManifest.stages.primaryAnalysis.fingerprint = fingerprints.primaryAnalysis;
    paper.analysisManifest.stages.demoLinkScan.fingerprint = fingerprints.demoLinkScan;
    paper.analysisCheckpoint = paper.analysis;
    paper.analysisStageCheckpoints ||= {};
    paper.analysisStageCheckpoints.primaryAnalysis = paper.analysis;
    for (const stage of textStages) {
        const physical = stage === 'tagSelection'
            ? require('../../scripts/lib/tag-stage-record').readTagStageRecord(paper.analysisManifest, paper.analysisStageCheckpoints).stageKey : stage;
        const saved = paper.analysisManifest.stages[physical];
        if (!saved || !deep.isRecoveryStageComplete(paper.analysisManifest, stage)) continue;
        paper.analysisStageCheckpoints[physical] = paper.analysis;
        const clone = structuredClone(paper);
        delete clone.analysisManifest.stages[physical].fingerprint;
        const prepared = deep.prepareTextRecoveryStage(clone, clone.analysisManifest, stage,
            clone.analysisCheckpoint, source.text);
        saved.promptTextContract = prepared.promptTextContract;
        Object.assign(saved, prepared.factReviewFields);
        // Invalidating a scratch stage resets its declared proof fields. The
        // tested stage retains its real saved ancestor proof, so hash that
        // exact declaration through the public normal fingerprint builder.
        saved.fingerprint = deep.buildTextStageFingerprint(stage, prepared.inputAnalysis,
            prepared.evidenceContext, prepared.promptTextContract, saved);
    }
    return paper;
}
module.exports = { installCurrentParentFingerprints };
