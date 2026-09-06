'use strict';

const crypto = require('node:crypto');
const { parseAnalysis } = require('../utils.js');
const { stableHash } = require('./fresh-rewrite-run.js');
const { scoringAuditBindsFinalAnalysis, apiReaderV3BindsCanonical } = require('../analysis-engine.js');
const CONTRACT = 'reader-resource-availability-sync-v1';
const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const identityBody = identity => { const { identitySha256, ...body } = identity || {}; return body; };
const protectedReaderKeys = ['apiReaderArticle','apiReaderPlan','apiReaderFigures','apiReaderAuthors','apiReaderResources',
    'apiReaderArticleSha256','apiReaderPlanSha256'];

// Deterministic projection of an already sealed resource identity. No network,
// no model, no score change, and no write/checkpoint callback. Caller owns locks
// and persistence. It refuses changed scoring evidence instead of re-signing an
// outdated assessment merely to satisfy the publication projection.
function synchronizeReaderResourceAvailability(paper, sourceDetails) {
    const deep = require('../deep-analyzer.js');
    const sourceText = String(sourceDetails?.text || '');
    const resources = paper?.apiReaderResources;
    const manifest = paper?.analysisManifest;
    if (!paper || typeof paper.analysis !== 'string' || manifest?.stages?.scoringAudit?.status !== 'complete'
        || !scoringAuditBindsFinalAnalysis(paper)
        || !sourceText || sha(sourceText) !== paper.sourceSha256
        || sha(sourceText) !== manifest.sourceAcquisition?.sourceSha256
        || resources?.contract !== 'api-reader-resource-identity-v1'
        || resources.sourceTextSha256 !== paper.sourceSha256
        || resources.identitySha256 !== stableHash(identityBody(resources))
        || !Array.isArray(resources.resources) || resources.resources.some(resource => (
            resource.sourceQuoteSha256 !== sha(resource.sourceQuote)
            || (resource.origin === 'paper_source'
                ? !sourceText.includes(resource.sourceQuote) || !resource.sourceQuote.includes(resource.originalUrl)
                : resource.origin !== 'validated_demo'
                    || !manifest.stages.demoLinkScan?.discoveredLinks?.includes(resource.originalUrl))
        ))
        || manifest.stages.openSourceScan?.resourceEvidenceSha256 !== resources.identitySha256) {
        throw new Error('Resource synchronization requires sealed scoring/source/resource identity');
    }
    if (manifest.stages.apiReaderArticle?.status === 'complete' && !apiReaderV3BindsCanonical(paper)) {
        throw new Error('Resource synchronization cannot repair an invalid Reader signature');
    }
    const originalParsed = parseAnalysis(paper.analysis);
    const scoreFields = ['score','documentType','innovationScore','technicalRigorScore','experimentalSufficiencyScore',
        'clarityScore','impactScore','openSourceScore','reproducibilityScore','engineeringScore','scoringReason'];
    if (paper.parsed && scoreFields.some(field => stableHash(paper.parsed[field] ?? null)
        !== stableHash(originalParsed?.[field] ?? null))) {
        throw new Error('Stored parsed scores/type/audit prose differ from canonical; refusing an implicit score repair');
    }
    const updatedAnalysis = deep.applyApiReaderResourceAvailability(paper.analysis, resources);
    const updatedParsed = parseAnalysis(updatedAnalysis);
    for (const field of ['hasCode','hasModel','hasDataset']) {
        if (originalParsed?.[field] !== updatedParsed?.[field]) {
            throw new Error(`Resource availability changes ${field}; normal scoring audit is required`);
        }
    }
    const withoutOpenSource = parsed => { const { opensource, ...rest } = parsed || {}; return rest; };
    if (stableHash(withoutOpenSource(originalParsed)) !== stableHash(withoutOpenSource(updatedParsed))) {
        throw new Error('Resource synchronization would alter scores/type/audit prose outside the availability projection');
    }
    if (updatedAnalysis === paper.analysis) return paper;
    const beforeReader = stableHash(Object.fromEntries(protectedReaderKeys.map(key => [key, paper[key]])));
    const audit = manifest.stages.scoringAudit.audit;
    const auditSha = stableHash(audit);
    const checkpointChanges = [];
    const checkpoints = { ...(paper.analysisStageCheckpoints || {}) };
    const syncCheckpoint = (value, name) => {
        const updated = deep.applyApiReaderResourceAvailability(value, resources);
        const oldParsed = parseAnalysis(value), nextParsed = parseAnalysis(updated);
        if (stableHash(withoutOpenSource(oldParsed)) !== stableHash(withoutOpenSource(nextParsed))) {
            throw new Error(`Resource synchronization would change scoring evidence in checkpoint ${name}`);
        }
        if (updated !== value) checkpointChanges.push({ path: name, beforeSha256: sha(value), afterSha256: sha(updated) });
        return updated;
    };
    for (const stage of ['scoringAudit','apiReaderArticle','imageSupplement']) {
        if (typeof checkpoints[stage] === 'string') checkpoints[stage] = syncCheckpoint(checkpoints[stage], `analysisStageCheckpoints.${stage}`);
    }
    let checkpoint;
    if (typeof paper.analysisCheckpoint === 'string') {
        const terminal = new Set([paper.analysis, ...['scoringAudit','apiReaderArticle','imageSupplement']
            .map(stage => paper.analysisStageCheckpoints?.[stage]).filter(value => typeof value === 'string')]);
        if (!terminal.has(paper.analysisCheckpoint)) throw new Error('Resource synchronization found a non-terminal active checkpoint');
        checkpoint = syncCheckpoint(paper.analysisCheckpoint, 'analysisCheckpoint');
    }
    const stages = structuredClone(manifest.stages);
    const beforeSha256 = sha(paper.analysis), afterSha256 = sha(updatedAnalysis);
    const scoringBefore = stages.scoringAudit.outputAnalysisSha256;
    if (scoringBefore === beforeSha256) stages.scoringAudit.outputAnalysisSha256 = afterSha256;
    else if (stages.imageSupplement?.status === 'complete' && stages.imageSupplement.outputAnalysisSha256 === beforeSha256) {
        stages.imageSupplement.outputAnalysisSha256 = afterSha256;
        const scoringCheckpoint = paper.analysisStageCheckpoints?.scoringAudit;
        if (typeof scoringCheckpoint === 'string' && sha(scoringCheckpoint) === scoringBefore) {
            stages.scoringAudit.outputAnalysisSha256 = sha(checkpoints.scoringAudit);
            stages.imageSupplement.inputAnalysisSha256 = stages.scoringAudit.outputAnalysisSha256;
        }
    } else throw new Error('Resource synchronization cannot replay the scoring-to-final analysis chain');
    const provenance = { contract: CONTRACT, executionKind: 'deterministic_resource_projection',
        sourceSha256: paper.sourceSha256, resourceIdentitySha256: resources.identitySha256,
        beforeAnalysisSha256: beforeSha256, afterAnalysisSha256: afterSha256,
        originalScoringOutputAnalysisSha256: scoringBefore, checkpointChanges, newApiRequests: 0 };
    stages.scoringAudit.resourceAvailabilitySynchronizations = [
        ...(stages.scoringAudit.resourceAvailabilitySynchronizations || []), provenance
    ];
    const next = { ...paper, analysis: updatedAnalysis, parsed: updatedParsed,
        analysisManifest: { ...manifest, stages },
        ...(paper.analysisStageCheckpoints ? { analysisStageCheckpoints: checkpoints } : {}),
        ...(checkpoint !== undefined ? { analysisCheckpoint: checkpoint } : {}) };
    if (stableHash(stages.scoringAudit.audit) !== auditSha
        || stableHash(Object.fromEntries(protectedReaderKeys.map(key => [key, next[key]]))) !== beforeReader
        || !scoringAuditBindsFinalAnalysis(next)
        || (stages.apiReaderArticle?.status === 'complete' && !apiReaderV3BindsCanonical(next))) {
        throw new Error('Resource synchronization violated audit or Reader byte invariants');
    }
    Object.assign(paper, next);
    return paper;
}

module.exports = { CONTRACT, synchronizeReaderResourceAvailability };
