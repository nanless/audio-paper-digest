'use strict';
const formats = require('./protocol-codec');
const FAMILY = 'post-publish-visual-waiver';
const SHA = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function validPublicationPolicy(policy) {
    if (!formats.hasValidHeader(policy, 'daily-publication-policy')) return false;
    const schema = formats.declaredSchema(policy.contract, 'daily-publication-policy', policy.schemaFingerprint);
    return policy.generatedImages === false && policy.sourceFigures === 'retained-and-source-verified'
        && Object.keys(policy).sort().join(',') === 'contract,generatedImages,schemaFingerprint,sourceFigures'
        && schema.generatedImages === false && schema.sourceFigures === 'retained-and-source-verified'
        && schema.authority === 'standing-user-no-generation-instruction';
}

// 纯格式和引用校验。调用者必须先核验正式出版凭证，再提供实际文件的摘要。
function validNoGenerationRecord(value, { date, manifestSha, receiptCommit,
    remoteVerifiedOid = receiptCommit, receiptSha, visualSha, coverSha, publicationPolicy, postPublishVisuals } = {}) {
    if (!value || !formats.hasValidHeader(value, FAMILY,
        Object.hasOwn(value, 'contract') ? 'contract' : 'version')) return false;
    if (value.batchDate !== date || value.status !== 'waived' || value.requestedBy !== 'user'
        || typeof value.reason !== 'string' || value.reason.trim().length < 10
        || !SHA.test(String(manifestSha || '')) || value.generationManifestSha256 !== manifestSha
        || !OID.test(String(receiptCommit || '')) || value.publicationCommit !== receiptCommit
        || remoteVerifiedOid !== receiptCommit || value.remoteVerifiedOid !== receiptCommit) return false;
    if (formats.format(value[Object.hasOwn(value, 'contract') ? 'contract' : 'version'], FAMILY, value.schemaFingerprint) === 'publication-receipt-bound') {
        return validPublicationPolicy(publicationPolicy) && postPublishVisuals === 'not_requested'
            && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(value.waivedAt || '')
            && Object.keys(value).sort().join(',') === [
            'contract', 'schemaFingerprint', 'batchDate', 'status', 'requestedBy', 'reason', 'waivedAt',
            'publicationCommit', 'remoteVerifiedOid', 'generationManifestSha256', 'reviewReceiptSha256',
            'generatedImages', 'sourceFigures'
        ].sort().join(',') && value.generatedImages === false
            && value.sourceFigures === 'retained-and-source-verified'
            && SHA.test(String(receiptSha || '')) && value.reviewReceiptSha256 === receiptSha;
    }
    // 历史记录只按原实际清单核对，不能给它补写新的来源或发布时间。
    return SHA.test(String(visualSha || '')) && SHA.test(String(coverSha || ''))
        && value.visualManifestSha256 === visualSha && value.coverManifestSha256 === coverSha;
}
module.exports = { validNoGenerationRecord, validPublicationPolicy };
