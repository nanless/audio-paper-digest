'use strict';

const codec = require('./protocol-codec');
const { recordHeaderFor } = require('./workflow-record-format');
const CONTRACT = codec.contract('conference-reader-pdf-source');

function headerForArtifacts(artifacts) {
    const pdfField = Object.hasOwn(artifacts, 'contract') ? 'contract' : 'parserVersion';
    const weakField = Object.hasOwn(artifacts, 'contract') ? 'contract' : 'version';
    const family = codec.hasValidHeader(artifacts, 'conference-reader-pdf-artifacts', pdfField)
        ? 'conference-reader-pdf-artifacts' : 'conference-reader-weak-artifacts';
    const field = family === 'conference-reader-pdf-artifacts' ? pdfField : weakField;
    if (!codec.hasValidHeader(artifacts, family, field)) throw new Error('会议来源结构格式与原记录不符');
    const header = recordHeaderFor(artifacts, family, field);
    if (!header.schemaFingerprint) return codec.historicalHeader(CONTRACT, 'actual-execution-pdf-source');
    const identityFormat = codec.declaredSchema(header.contract, family, header.schemaFingerprint).sourceIdentityFormat;
    if (!codec.hasValidHeader(identityFormat, CONTRACT)) throw new Error('会议来源未声明准确的 PDF 身份格式');
    const verified = recordHeaderFor(identityFormat, CONTRACT);
    if (Object.keys(identityFormat).length !== Object.keys(verified).length) throw new Error('会议 PDF 身份格式声明含多余字段');
    return verified;
}

// This projection never opens the PDF or establishes publication authority.
// Only the real source context or full cold publication replay can do that.
function projectSavedExecution(loaded) {
    const artifacts = loaded.source.sourceDetails.structuredArtifacts;
    return {
        ...headerForArtifacts(artifacts), paperId: loaded.run.paperId,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        rawStructuredArtifactsSha256: loaded.source.sourceSnapshotBinding.sourceBinding.artifactsPayloadSha256,
        effectiveStructuredArtifactsSha256: artifacts.payloadSha256,
        sourceSnapshotBinding: structuredClone(loaded.source.sourceSnapshotBinding),
        planAuthorityBinding: structuredClone(loaded.source.planAuthorityBinding),
        executionId: loaded.run.executionId
    };
}
module.exports = { CONTRACT, headerForArtifacts, projectSavedExecution };
