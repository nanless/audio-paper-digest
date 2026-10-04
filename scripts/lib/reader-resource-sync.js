'use strict';

const crypto = require('node:crypto');
const { parseAnalysis } = require('../utils.js');
const { stableHash } = require('./fresh-rewrite-run.js');
const { scoringAuditBindsFinalAnalysis, apiReaderV3BindsCanonical } = require('../analysis-engine.js');
const { paperSourceQuoteBindsOriginalUrl } = require('./reader-resource-binding.js');
const CONTRACT = 'reader-resource-availability-sync-v1';
const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const identityBody = identity => { const { identitySha256, ...body } = identity || {}; return body; };
const protectedReaderKeys = ['apiReaderArticle','apiReaderPlan','apiReaderFigures','apiReaderAuthors','apiReaderResources',
    'apiReaderArticleSha256','apiReaderPlanSha256'];

function readerResourceIdentityRebind(paper, manifest, resources) {
    const stage = manifest.stages.apiReaderArticle;
    if (stage?.status !== 'complete' || apiReaderV3BindsCanonical(paper)) return null;
    if (stage.resourceCount !== resources.resources.length) {
        throw new Error('读者文章与正式分析的绑定无效，不能仅靠同步资源状态修复。');
    }
    const reboundStages = structuredClone(manifest.stages);
    reboundStages.apiReaderArticle.resourceIdentitySha256 = resources.identitySha256;
    const rebound = {
        ...paper,
        analysisManifest: { ...manifest, stages: reboundStages }
    };
    if (!apiReaderV3BindsCanonical(rebound)) {
        throw new Error('读者文章与正式分析的绑定无效，不能仅靠同步资源状态修复。');
    }
    return {
        contract: 'reader-resource-identity-rebind-v1',
        previousIdentitySha256: stage.resourceIdentitySha256,
        currentIdentitySha256: resources.identitySha256,
        resourceCount: resources.resources.length
    };
}

// 根据已保存并通过核验的资源记录更新正文中的可达状态，不联网、不调用模型，也不改变评分。
// 本函数只修改传入的论文对象，锁和文件保存由调用方负责。资源状态若影响评分依据，
// 必须重新审查评分，不能只改绑定记录来继续发布。
function synchronizeReaderResourceAvailability(paper, sourceDetails) {
    const deep = require('../deep-analyzer.js');
    const sourceText = String(sourceDetails?.text || '');
    const resources = paper?.apiReaderResources;
    const manifest = paper?.analysisManifest;
    if (!paper || typeof paper.analysis !== 'string' || manifest?.stages?.scoringAudit?.status !== 'complete'
        || manifest.stages.scoringAudit.auditSha256
            !== stableHash(manifest.stages.scoringAudit.audit)
        || !scoringAuditBindsFinalAnalysis(paper)
        || !sourceText || sha(sourceText) !== paper.sourceSha256
        || sha(sourceText) !== manifest.sourceAcquisition?.sourceSha256
        || resources?.contract !== 'api-reader-resource-identity-v1'
        || resources.sourceTextSha256 !== paper.sourceSha256
        || resources.identitySha256 !== stableHash(identityBody(resources))
        || !Array.isArray(resources.resources) || resources.resources.some(resource => (
            resource.sourceQuoteSha256 !== sha(resource.sourceQuote)
            || (resource.origin === 'paper_source'
                ? !sourceText.includes(resource.sourceQuote) || !paperSourceQuoteBindsOriginalUrl(resource)
                : resource.origin !== 'validated_demo'
                    || !manifest.stages.demoLinkScan?.discoveredLinks?.includes(resource.originalUrl))
        ))
        || manifest.stages.openSourceScan?.resourceEvidenceSha256 !== resources.identitySha256) {
        throw new Error('评分审查、全文或资源核验记录未通过同步前检查。');
    }
    const originalParsed = parseAnalysis(paper.analysis);
    const scoreFields = ['score','documentType','innovationScore','technicalRigorScore','experimentalSufficiencyScore',
        'clarityScore','impactScore','openSourceScore','reproducibilityScore','engineeringScore','scoringReason'];
    if (paper.parsed && scoreFields.some(field => stableHash(paper.parsed[field] ?? null)
        !== stableHash(originalParsed?.[field] ?? null))) {
        throw new Error('已保存的解析评分、文档类型或评分理由与重新解析正文的结果不同；请先重新审查评分。');
    }
    const updatedAnalysis = deep.applyApiReaderResourceAvailability(paper.analysis, resources);
    // 如果同步后的正文与原文相同，就返回原对象，不尝试修复读者文章的绑定。
    // 最终是否可以继续使用这份记录，仍由调用方的正式分析校验决定。
    if (updatedAnalysis === paper.analysis) return paper;
    const readerIdentityRebind = readerResourceIdentityRebind(paper, manifest, resources);
    const updatedParsed = parseAnalysis(updatedAnalysis);
    for (const field of ['hasCode','hasModel','hasDataset']) {
        if (originalParsed?.[field] !== updatedParsed?.[field]) {
            throw new Error(`资源状态更新会改变 ${field}；必须重新审查评分。`);
        }
    }
    const withoutOpenSource = parsed => { const { opensource, ...rest } = parsed || {}; return rest; };
    if (stableHash(withoutOpenSource(originalParsed)) !== stableHash(withoutOpenSource(updatedParsed))) {
        throw new Error('资源状态更新会改变开源详情以外的解析结果，不能仅靠同步资源状态继续。');
    }
    const beforeReader = stableHash(Object.fromEntries(protectedReaderKeys.map(key => [key, paper[key]])));
    const audit = manifest.stages.scoringAudit.audit;
    const auditSha = stableHash(audit);
    const checkpointChanges = [];
    const checkpoints = { ...(paper.analysisStageCheckpoints || {}) };
    const syncCheckpoint = (value, name) => {
        const updated = deep.applyApiReaderResourceAvailability(value, resources);
        const oldParsed = parseAnalysis(value), nextParsed = parseAnalysis(updated);
        if (stableHash(withoutOpenSource(oldParsed)) !== stableHash(withoutOpenSource(nextParsed))) {
            throw new Error(`资源状态更新会改变检查点 ${name} 中开源详情以外的解析结果。`);
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
        if (!terminal.has(paper.analysisCheckpoint)) throw new Error('当前活动检查点不是正式正文或允许更新的最终阶段正文，不能同步资源状态。');
        checkpoint = syncCheckpoint(paper.analysisCheckpoint, 'analysisCheckpoint');
    }
    const stages = structuredClone(manifest.stages);
    if (readerIdentityRebind) {
        stages.apiReaderArticle.resourceIdentitySha256 = resources.identitySha256;
    }
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
    } else throw new Error('评分审查与最终正文之间的哈希对应关系不符合要求，不能同步资源状态。');
    const provenance = { contract: CONTRACT, executionKind: 'deterministic_resource_projection',
        sourceSha256: paper.sourceSha256, resourceIdentitySha256: resources.identitySha256,
        beforeAnalysisSha256: beforeSha256, afterAnalysisSha256: afterSha256,
        originalScoringOutputAnalysisSha256: scoringBefore, checkpointChanges, newApiRequests: 0,
        ...(readerIdentityRebind ? { readerResourceIdentityRebind: readerIdentityRebind } : {}) };
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
        throw new Error('同步资源状态后，评分审查内容、读者文章内容或阶段绑定未能保持要求。');
    }
    Object.assign(paper, next);
    return paper;
}

module.exports = { CONTRACT, synchronizeReaderResourceAvailability };
