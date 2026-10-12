'use strict';

const crypto = require('node:crypto');
const CONTRACT = 'scoring-third-party-resource-replay-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
};
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const STATE_FIELDS = new Set(['availability', 'status', 'retryable', 'failureCode']);

function sourceAndAuthorResources(identity) {
    const result = structuredClone(identity);
    delete result.identitySha256;
    result.resources = result.resources.map(resource => resource.type === 'third_party'
        ? Object.fromEntries(Object.entries(resource).filter(([key]) => !STATE_FIELDS.has(key)))
        : resource);
    return result;
}

function prepareReplay(paper, previousIdentity, latestIdentity, structuralAnalysis, sourceText, helpers) {
    const stage = paper.analysisManifest?.stages?.scoringAudit;
    if (stage?.status !== 'complete') return null;
    const retained = paper.analysisManifest.scoringResourceInputReplay;
    const original = retained?.contract === CONTRACT ? retained.originalResourceIdentity : previousIdentity;
    if (!original || !latestIdentity || equal(original, latestIdentity)) return null;
    // 公共回放会核对完整来源身份和每条资源声明。只比较状态差异，
    // 不能替代网址、归属、逐字引文、说明文档和作者自身资源的检查。
    try {
        helpers.verify(original, sourceText);
        helpers.verify(latestIdentity, sourceText);
    } catch (_) {
        return null;
    }
    if (!equal(sourceAndAuthorResources(original), sourceAndAuthorResources(latestIdentity))) return null;
    const analysis = helpers.apply(structuralAnalysis, original);
    if (sha(analysis) !== stage.scoringInputSha256
        || sha(helpers.evidence(analysis, sourceText)) !== stage.evidenceSha256) return null;
    const output = paper.analysisStageCheckpoints?.scoringAudit;
    if (typeof output !== 'string' || sha(output) !== stage.outputAnalysisSha256) return null;
    return { analysis, output, metadata: {
        contract: CONTRACT,
        originalResourceIdentity: structuredClone(original),
        scoringInputSha256: stage.scoringInputSha256,
        scoringOutputSha256: stage.outputAnalysisSha256,
        latestResourceIdentitySha256: latestIdentity.identitySha256,
        auditedAt: stage.updatedAt,
        reason: '仅第三方依赖可达状态变化；原正文中的状态保留为原评分审计时记录，最新状态由资源身份和Reader展示'
    } };
}

module.exports = { CONTRACT, prepareReplay };
