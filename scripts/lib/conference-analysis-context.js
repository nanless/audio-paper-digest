'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const path = require('node:path');

const scope = new AsyncLocalStorage();
const WEAK_READER_CAPABILITY_POLICY_CONTRACT = 'conference-reader-weak-unavailable-structure-v1';
const WEAK_CONFERENCE_CAPABILITIES = Object.freeze({
    fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable'
});
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const WEAK_READER_CAPABILITY_POLICY_BODY = Object.freeze({
    contract: WEAK_READER_CAPABILITY_POLICY_CONTRACT,
    version: 1,
    capabilities: WEAK_CONFERENCE_CAPABILITIES,
    requiredEmptyBindings: Object.freeze(['figurePlacements', 'formulaBindings', 'tableBindings']),
    forbiddenArticleStructures: Object.freeze(['figure-markers', 'formula-markers', 'display-formulas', 'markdown-tables', 'table-markers']),
    minimumIntegratedTables: 0
});
const WEAK_READER_CAPABILITY_POLICY = Object.freeze({
    ...WEAK_READER_CAPABILITY_POLICY_BODY,
    policySha256: stableHash(WEAK_READER_CAPABILITY_POLICY_BODY)
});

function paperId(paper) { return typeof paper === 'string' ? paper : paper?.id || paper?.conferencePaperId || ''; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function withConferenceAnalysisSource(identity, callback) {
    if (!identity || typeof identity !== 'object' || !/^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(identity.paperId)
        || !identity.sourceDetails || identity.sourceDetails.source !== 'conference_pdf_text'
        || typeof identity.sourceDetails.text !== 'string' || typeof identity.executionDir !== 'string'
        || !path.isAbsolute(identity.executionDir)) {
        throw new Error('Authenticated conference analysis source identity is required');
    }
    if (identity.readerRetryEpoch !== undefined
        && (!Number.isSafeInteger(identity.readerRetryEpoch) || identity.readerRetryEpoch < 1)) {
        throw new Error('Conference Reader retry epoch must be a positive safe integer');
    }
    const parent = scope.getStore();
    const inherited = parent?.readerPdfSourceHandle && parent.executionId === identity.executionId
        && parent.paperId === identity.paperId
        && stableHash(parent.sourceDetails) === stableHash(identity.sourceDetails)
        ? parent.readerPdfSourceHandle : null;
    const readerPdfSourceHandle = identity.readerPdfSourceHandle || inherited;
    if (Object.hasOwn(identity, 'readerPdfSourceHandle') && !identity.readerPdfSourceHandle) {
        throw new Error('Conference Reader PDF authority cannot be a boolean or empty descriptor');
    }
    if (readerPdfSourceHandle) {
        const provider = require('./conference-source-context').readerPdfSourceForContext(readerPdfSourceHandle);
        if (!provider || provider.paperId !== identity.paperId || provider.sourceText !== identity.sourceDetails.text
            || provider.structuredArtifactsSha256 !== identity.sourceDetails.structuredArtifacts?.payloadSha256) {
            throw new Error('Conference Reader PDF authority differs from the authenticated source');
        }
    }
    const tableEvidence = require('./reader-authenticated-pdf-table-evidence');
    return scope.run(Object.freeze({ executionId: identity.executionId, executionDir: path.resolve(identity.executionDir), paperId: identity.paperId,
        ...(readerPdfSourceHandle ? { readerPdfSourceHandle } : {}),
        sourceDetails: Object.freeze(clone(identity.sourceDetails)),
        // 传递原受控子运行绑定的 Reader 身份；恢复时须继续同一 epoch。
        // --retry-failed 本身不授予新次数，不能改 epoch 绕过耗尽的候选。
        ...(identity.readerRetryEpoch !== undefined
            ? { readerRetryEpoch: identity.readerRetryEpoch } : {}) }), () => readerPdfSourceHandle
        ? tableEvidence.withVerifiedSource(readerPdfSourceHandle, callback)
        : tableEvidence.withoutVerifiedSource(callback));
}
function getConferenceAnalysisContext() { return scope.getStore() || null; }
function getConferenceAnalysisSource(paper) {
    const active = scope.getStore();
    if (!active) return null;
    if (paper?.arxivId || paper?.paper_id || paperId(paper) !== active.paperId) {
        throw new Error('Conference analysis refuses arXiv aliases or a different canonical paperId');
    }
    return clone(active.sourceDetails);
}
function conferenceCoreSummaryRepairContext(paper, sourceText) {
    const active = scope.getStore();
    if (!active) return null;
    const source = getConferenceAnalysisSource(paper);
    const canonicalId = paperId(paper);
    const sourceSha256 = crypto.createHash('sha256').update(String(sourceText)).digest('hex');
    if (!/^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(canonicalId)
        || paper?.id !== canonicalId
        || (paper.conferencePaperId && paper.conferencePaperId !== canonicalId)
        || (paper.sourceId && paper.sourceId !== canonicalId)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(active.executionId || '')
        || path.basename(active.executionDir) !== active.executionId
        || source.sourceId !== canonicalId || source.text !== sourceText
        || (paper?.sourceSha256 && paper.sourceSha256 !== sourceSha256)
        || (paper?.analysisManifest?.sourceAcquisition?.sourceSha256
            && paper.analysisManifest.sourceAcquisition.sourceSha256 !== sourceSha256)) {
        throw new Error('会议摘要修复记录需要当前认证执行、规范会议身份及相同封存全文');
    }
    return { paperId: canonicalId,
        directory: path.join(active.executionDir, 'analysis-repair-attempts',
            'conference-' + crypto.createHash('sha256').update(canonicalId).digest('hex')),
        sourceIdentity: { contract: 'conference-analysis-source-identity-v1', executionId: active.executionId,
            paperId: canonicalId, source: 'conference_pdf_text', sourceSha256,
            structuredArtifactsSha256: source.structuredArtifacts?.payloadSha256 || null } };
}
function conferenceWeakReaderCapabilityPolicy(paper, structuredArtifacts) {
    const details = getConferenceAnalysisSource(paper);
    if (!details) return null;
    const artifacts = details.structuredArtifacts;
    const provided = structuredArtifacts === undefined ? artifacts : structuredArtifacts;
    // 可以重新读取并核验的 PDF 来源使用常规 Reader 规则。这个函数继续
    // 检查旧版资料有限的证据能力，但不要给已核验且包含 PDF 插图像素的来源
    // 附加弱策略提示词。PDF 文本永远不是经过核验的原始 TeX。
    if (details.conferenceCapabilities?.fullText === 'full'
        && details.conferenceCapabilities?.tables === 'unavailable'
        && details.conferenceCapabilities?.formulas === 'unavailable'
        && details.conferenceCapabilities?.figures === 'available') {
        if (!artifacts || artifacts.parserVersion !== 'conference-pdf-structure-v2-visual-only-math-tables'
            || !Array.isArray(artifacts.tables) || artifacts.tables.length
            || !Array.isArray(artifacts.formulas) || artifacts.formulas.length
            || stableHash(provided) !== stableHash(artifacts)) {
            throw new Error('Authenticated conference structured Reader artifact differs from source details');
        }
        return null;
    }
    const artifactKeys = ['capabilityProfile', 'figures', 'flattenedTextSha256', 'formulas',
        'payloadSha256', 'source', 'tables', 'version'];
    const artifactBody = artifacts && clone(artifacts);
    if (artifactBody) delete artifactBody.payloadSha256;
    const textSha256 = crypto.createHash('sha256').update(String(details.text || '')).digest('hex');
    if (!details.conferenceCapabilities || typeof details.conferenceCapabilities !== 'object'
        || Array.isArray(details.conferenceCapabilities)
        || stableHash(details.conferenceCapabilities) !== stableHash(WEAK_CONFERENCE_CAPABILITIES)
        || !artifacts || Object.keys(artifacts).sort().join('\0') !== artifactKeys.sort().join('\0')
        || artifacts.version !== 1 || artifacts.source !== 'conference_pdf_weak_text'
        || artifacts.capabilityProfile !== 'weak-text-only-v1'
        || artifacts.flattenedTextSha256 !== textSha256
        || !Array.isArray(artifacts.tables) || artifacts.tables.length
        || !Array.isArray(artifacts.formulas) || artifacts.formulas.length
        || !Array.isArray(artifacts.figures) || artifacts.figures.length
        || !/^[a-f0-9]{64}$/.test(String(artifacts.payloadSha256 || ''))
        || artifacts.payloadSha256 !== crypto.createHash('sha256')
            .update(JSON.stringify(artifactBody)).digest('hex')
        || stableHash(provided) !== stableHash(artifacts)) {
        throw new Error('Authenticated conference weak Reader capability policy cannot be derived');
    }
    return clone(WEAK_READER_CAPABILITY_POLICY);
}
function conferenceReaderAttemptsDirectory(requestedDirectory = null) {
    const active = scope.getStore();
    if (!active) return requestedDirectory;
    const expected = path.join(active.executionDir, 'reader-attempts');
    if (requestedDirectory && path.resolve(requestedDirectory) !== expected) {
        throw new Error('Conference Reader attempts must stay inside its analysis execution');
    }
    return expected;
}

module.exports = { WEAK_READER_CAPABILITY_POLICY_CONTRACT, WEAK_CONFERENCE_CAPABILITIES,
    WEAK_READER_CAPABILITY_POLICY, withConferenceAnalysisSource, getConferenceAnalysisContext,
    getConferenceAnalysisSource, conferenceCoreSummaryRepairContext,
    conferenceWeakReaderCapabilityPolicy, conferenceReaderAttemptsDirectory };
