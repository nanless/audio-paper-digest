'use strict';

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-paper-source-identity.js');
}

const crypto = require('crypto');
const path = require('path');

const MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT = 'manual-paper-source-identity-v1';
const SHA256_RE = /^[a-f0-9]{64}$/;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function assertSha(value, label) {
    const normalized = String(value || '');
    if (!SHA256_RE.test(normalized)) throw new Error(`${label} 必须是 SHA-256`);
    return normalized;
}

function assertNonNegativeInteger(value, label) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
    return value;
}

function normalizedPaperId(value) {
    return String(value || '').trim().replace(/^arXiv:/i, '').replace(/v\d+$/i, '');
}

/**
 * Builds the immutable identity of one paper's evidence inputs. Batch-level
 * manifest bytes are deliberately excluded: they are collection indexes, so
 * another paper's checkpoint must not invalidate this paper. The caller still
 * validates batch completeness and the real paths independently.
 */
function buildManualPaperSourceIdentity(options = {}) {
    const date = String(options.date || '');
    const paperId = normalizedPaperId(options.paperId);
    const fullTextEntry = options.fullTextEntry;
    const artifactEntry = options.artifactEntry;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('paper source identity.date 非法');
    if (!paperId) throw new Error('paper source identity.paperId 缺失');
    if (!fullTextEntry || typeof fullTextEntry !== 'object' || Array.isArray(fullTextEntry)) {
        throw new Error(`${paperId} fullTextEntry 缺失`);
    }
    if (!artifactEntry || typeof artifactEntry !== 'object' || Array.isArray(artifactEntry)) {
        throw new Error(`${paperId} artifactEntry 缺失`);
    }
    if (fullTextEntry.status !== 'complete') throw new Error(`${paperId} fullTextEntry 不是 complete`);
    if (artifactEntry.status !== 'complete' || artifactEntry.inventoryStatus !== 'complete') {
        throw new Error(`${paperId} ArtifactIndex entry 不是 complete`);
    }
    if (normalizedPaperId(artifactEntry.paperId) !== paperId) {
        throw new Error(`${paperId} ArtifactIndex entry.paperId 不一致`);
    }
    const sourceSha256 = assertSha(fullTextEntry.sourceSha256, `${paperId}.sourceSha256`);
    const sourceIdentitySha256 = assertSha(
        fullTextEntry.sourceIdentitySha256, `${paperId}.sourceIdentitySha256`
    );
    const paperInputSha256 = assertSha(fullTextEntry.paperInputSha256, `${paperId}.paperInputSha256`);
    if (artifactEntry.sourceSha256 !== sourceSha256
        || artifactEntry.sourceIdentitySha256 !== sourceIdentitySha256
        || artifactEntry.paperInputSha256 !== paperInputSha256) {
        throw new Error(`${paperId} ArtifactIndex entry 未与全文单篇身份闭环`);
    }
    const structuredSnapshot = fullTextEntry.structuredArtifactsSnapshot;
    const structuredArtifactsSha256 = assertSha(
        artifactEntry.structuredArtifactsSha256, `${paperId}.structuredArtifactsSha256`
    );
    if (!structuredSnapshot || structuredSnapshot.healthStatus !== 'complete'
        || structuredSnapshot.payloadSha256 !== structuredArtifactsSha256) {
        throw new Error(`${paperId} structuredArtifactsSnapshot 未与 ArtifactIndex 闭环`);
    }
    const identity = {
        contract: MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
        date,
        paperId,
        fullText: {
            requestedArxivId: normalizedPaperId(fullTextEntry.requestedArxivId),
            sourceSha256,
            sourceIdentitySha256,
            paperMetadataSha256: assertSha(
                fullTextEntry.paperMetadataSha256, `${paperId}.paperMetadataSha256`
            ),
            paperInputSha256,
            bytes: assertNonNegativeInteger(fullTextEntry.bytes, `${paperId}.fullText.bytes`),
            imageInfosSha256: stableSha256(fullTextEntry.imageInfos || []),
            fileName: path.basename(String(fullTextEntry.path || ''))
        },
        artifactIndex: {
            parserVersion: String(artifactEntry.parserVersion || ''),
            structuredArtifactsSha256,
            artifactIndexSha256: assertSha(
                artifactEntry.artifactIndexSha256, `${paperId}.artifactIndexSha256`
            ),
            fileSha256: assertSha(artifactEntry.outputSha256, `${paperId}.artifactIndexFileSha256`),
            bytes: assertNonNegativeInteger(artifactEntry.bytes, `${paperId}.artifactIndex.bytes`),
            fileName: path.basename(String(artifactEntry.path || ''))
        }
    };
    if (!identity.fullText.requestedArxivId || !identity.fullText.fileName
        || !identity.artifactIndex.parserVersion || !identity.artifactIndex.fileName) {
        throw new Error(`${paperId} 单篇来源身份缺少 requested ID、parser 或文件名`);
    }
    return Object.freeze({
        contract: MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
        value: identity,
        sha256: stableSha256(identity)
    });
}

function validateManualPaperSourceIdentity(declared, options = {}) {
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        throw new Error('paperSourceIdentity 缺失');
    }
    const expected = buildManualPaperSourceIdentity(options);
    if (declared.contract !== MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT
        || declared.sha256 !== expected.sha256
        || stableSha256(declared.value) !== expected.sha256) {
        throw new Error(`${normalizedPaperId(options.paperId)} paperSourceIdentity 与当前单篇全文/ArtifactIndex 不一致`);
    }
    return expected;
}

module.exports = {
    MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
    buildManualPaperSourceIdentity,
    validateManualPaperSourceIdentity,
    stableSha256
};
