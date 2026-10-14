'use strict';
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-failed-bundle-resource-replay-v1';
const handles = new WeakMap();
function upstreamIdentity(paper) {
    const daily = require('./daily-fresh-source-plan');
    const stages = Object.fromEntries(Object.entries(paper.analysisManifest?.stages || {})
        .filter(([stage]) => !/^apiReader/.test(stage) && !['imageSupplement', 'imageDownload'].includes(stage)));
    return daily.stableHash({ arxivId: paper.arxivId, sourceSha256: paper.sourceSha256,
        freshRewriteProvenance: paper.freshRewriteProvenance, stages,
        analysisSha256: require('./reader-repair').shaText(paper.analysis || '') });
}
function assertSource(paper, source) {
    const fresh = require('./fresh-analysis-context'), repair = require('./reader-repair');
    if (!fresh.isDailyFreshSourceScope() || !require('../analysis-engine').paperAnalysisLockHeld(paper)
        || !source?.text || repair.shaText(source.text) !== paper.sourceSha256
        || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256) return false;
    fresh.assertFreshPaper(paper);
    const actual = require('./model-text-sanitization').currentModelInputSource(paper);
    if (!actual || !isDeepStrictEqual(actual.freshSourceDescriptor, source.freshSourceDescriptor)
        || repair.shaText(actual.text) !== paper.sourceSha256) return false;
    return require('./completed-reader-upstream').completedReaderUpstream(paper, actual);
}
function prepareRecoveryReaderResources(paper, source, options = {}) {
    const deep = require('../deep-analyzer'), daily = require('./daily-fresh-source-plan');
    if (!assertSource(paper, source) || require('../analysis-engine').hasValidApiReaderV3Records(paper)) return null;
    const review = String(options.reviewFeedback || '').trim();
    if (review) {
        try { if (deep.prepareApiReaderRevisionSeed(paper, source.text, review)) return null; }
        catch (error) {
            if (error.message !== '定向修订需要完整的读者文章，且正文、写作计划和分析阶段的 SHA 记录须一致。') throw error;
        }
    }
    const stage = paper.analysisManifest?.stages?.openSourceScan;
    if (stage?.status !== 'complete' || stage.resourceEvidenceContract !== 'api-reader-resource-identity-v1'
        || !/^[a-f0-9]{64}$/.test(stage.resourceEvidenceSha256 || '') || !stage.fingerprint) return null;
    const matches = (paper.apiReaderFailedBundleHistory || []).filter(packet => {
        const resources = packet?.fields?.apiReaderResources;
        return packet.sourceSha256 === paper.sourceSha256 && resources?.sourceTextSha256 === paper.sourceSha256
            && resources.identitySha256 === stage.resourceEvidenceSha256;
    });
    if (!matches.length) return null;
    const unique = new Map(matches.map(packet => [daily.stableHash(packet.fields.apiReaderResources), packet]));
    if (unique.size !== 1) throw new Error('Reader 失败资源束存在相同来源证明下的歧义');
    const packet = [...unique.values()][0], resources = packet.fields.apiReaderResources;
    // Full production validator replays URL attribution, source quotes, redirects and observed status.
    deep.replayVerifiedReaderResourceIdentity(resources, source.text);
    const quoteBinding = require('./reader-resource-binding');
    for (const item of resources.resources) {
        if (!quoteBinding.resourceClassificationIsCurrent(item, source.text)
            || (item.origin === 'paper_source' && !source.text.includes(item.sourceQuote))) {
            throw new Error('Reader 失败资源束与完整封存来源的逐字引文或资源分类不一致');
        }
        if (item.origin === 'validated_demo') {
            const links = paper.analysisManifest?.stages?.demoLinkScan?.discoveredLinks;
            if (!Array.isArray(links) || !links.includes(item.originalUrl))
                throw new Error('Reader 失败资源束缺少当前已验证 Demo 链接');
        }
    }
    const currentUpstreamSha256 = upstreamIdentity(paper);
    const proof = { contract: CONTRACT, paperId: require('../utils').normalizedId(paper),
        sourceSha256: paper.sourceSha256, sourceDescriptorSha256: daily.stableHash(source.freshSourceDescriptor),
        upstreamSha256: currentUpstreamSha256, resourceEvidenceSha256: stage.resourceEvidenceSha256,
        packetSha256: daily.stableHash(packet), openSourceScanFingerprint: stage.fingerprint };
    const handle = { resources: structuredClone(resources), proof: Object.freeze(proof) };
    handles.set(handle, { paperId: proof.paperId, resourceSha256: daily.stableHash(handle.resources), proofSha256: daily.stableHash(proof) });
    return handle;
}
function readRecoveryReaderResources(handle, paper, source) {
    const accepted = handles.get(handle), daily = require('./daily-fresh-source-plan');
    if (!accepted || accepted.paperId !== require('../utils').normalizedId(paper)
        || daily.stableHash(handle.resources) !== accepted.resourceSha256 || daily.stableHash(handle.proof) !== accepted.proofSha256
        || upstreamIdentity(paper) !== handle.proof.upstreamSha256 || !assertSource(paper, source)
        || daily.stableHash(source.freshSourceDescriptor) !== handle.proof.sourceDescriptorSha256
        || !paper.apiReaderFailedBundleHistory?.some(packet => daily.stableHash(packet) === handle.proof.packetSha256)) {
        throw new Error('Reader 失败资源恢复须保有未改变的完整来源、实际上游及原失败束');
    }
    return structuredClone(handle.resources);
}
module.exports = { CONTRACT, upstreamIdentity, prepareRecoveryReaderResources, readRecoveryReaderResources };
