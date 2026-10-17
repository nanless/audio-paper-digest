'use strict';

const crypto = require('node:crypto');
const { hasValidApiReaderV3Records } = require('../analysis-engine.js');
const { stableFingerprint } = require('../deep-analyzer.js');
const { stableHash } = require('./fresh-rewrite-run.js');
const CONTRACT = 'reader-signed-draft-roundtrip-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const fail = message => {
    const error = new Error(`Signed Reader inverse refused: ${message}`);
    error.code = 'READER_SIGNED_DRAFT_NOT_REVERSIBLE';
    throw error;
};

// 纯同步的逆运算，外加生产往返验证。它不抓取资源、不碰候选、不为新正文背书，
// 也恢复不了解析器丢弃的原始 API 空白/选择语法。
// 只能返回已有签名输出的某种合法精确输入表示。
function reconstructReaderDraftFromVerifiedArticle({ paper, sourceDetails, runId }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId || '')
        || paper?.latestAnalysisAttemptError || !hasValidApiReaderV3Records(paper)) fail('invalid signed parent or run');
    const id = paper.arxivId || paper.paper_id;
    const { freshSourceDescriptor: descriptor, ...sourceSnapshot } = sourceDetails || {};
    const artifacts = sourceDetails?.structuredArtifacts;
    const { payloadSha256, ...artifactBody } = artifacts || {};
    const analysisSourceRecord = paper.freshRewriteProvenance;
    if (!descriptor || descriptor.version !== 1 || descriptor.contract !== 'fresh-source-cache-v1'
        || descriptor.runId !== runId || descriptor.paperId !== id
        || !validSha(descriptor.sourceSnapshotSha256)
        || sha(JSON.stringify(sourceSnapshot)) !== descriptor.sourceSnapshotSha256
        || sha(String(sourceDetails.text || '')) !== descriptor.sourceSha256
        || (stableFingerprint(artifactBody) !== payloadSha256
            && sha(JSON.stringify(artifactBody)) !== payloadSha256)
        || payloadSha256 !== descriptor.structuredArtifactsSha256
        || artifacts.flattenedTextSha256 !== descriptor.sourceSha256
        || analysisSourceRecord?.contract !== 'fresh-source-analysis-v1' || analysisSourceRecord.runId !== runId
        || analysisSourceRecord.sourceOnly !== true || analysisSourceRecord.oldGeneratedTextIncluded !== false
        || analysisSourceRecord.sourceSha256 !== descriptor.sourceSha256
        || analysisSourceRecord.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || analysisSourceRecord.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || stableHash(analysisSourceRecord) !== stableHash(paper.analysisManifest.freshRewriteProvenance)
        || paper.sourceSha256 !== descriptor.sourceSha256
        || paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== payloadSha256) {
        fail('sealed source snapshot or fresh provenance mismatch');
    }
    const surface = require('./reader-signed-draft-surface').replayReaderDraftSurface({ paper, sourceDetails, paperId: id });
    if (surface.replayArticleSha256 !== paper.apiReaderArticleSha256) fail('production round-trip article bytes differ');
    if (surface.replayPlanSha256 !== paper.apiReaderPlanSha256) fail('production round-trip plan SHA differs');
    if (!surface.figureCoreMatches) fail('production round-trip figure bindings differ');
    if (surface.replayFiguresSha256 !== paper.analysisManifest.stages.apiReaderArticle.figuresSha256) fail('materialized figures SHA differs');
    return { draft: surface.draft, proof: { contract: CONTRACT, runId, paperId: id,
        sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        articleSha256: surface.replayArticleSha256, planSha256: surface.replayPlanSha256, figuresSha256: surface.replayFiguresSha256,
        draftSha256: surface.draftSha256, operatorRecovered: true, apiGenerated: false } };
}

module.exports = { CONTRACT, reconstructReaderDraftFromVerifiedArticle };
