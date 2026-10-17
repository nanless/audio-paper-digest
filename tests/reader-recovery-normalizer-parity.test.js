'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const versions = require('../scripts/lib/prompt-text-versions');
const history = require('../scripts/lib/prompt-history');
const evidence = require('../scripts/lib/prompt-evidence');
const rendering = require('../scripts/lib/prompt-rendering-contract');

// Frozen pre-extraction expression, including every conditional field. This is
// a fingerprint parity test, not a source, model or selected-analysis capability.
function originalExpression(paper, sourceEvidence, options) {
    const contract = options.readerFactLocalRevision === true
        ? repair.FACT_LOCAL_PROMPT_CONTRACT : versions.currentPromptTextContract('apiReaderRepair');
    const file = versions.promptFilePathForContract('apiReaderRepair', contract);
    return deep.stableFingerprint({
        ...options.readerGrantFields,
        ...require('../scripts/lib/selected-full-stage-reanalysis').fingerprintFields(paper),
        ...rendering.promptRenderingFingerprintFields(paper.title, sourceEvidence, options.reviewFeedback, options.previousDraft),
        contentMode: 'reader-source-only-v1', sourceEvidence,
        ...(options.readerFactLocalRevision === true ? {
            readerFactLocalPromptContract: contract,
            readerFactLocalPromptSha256: history.promptTemplateSha256(evidence.readPromptEvidenceBytes(file).toString('utf8'))
        } : {}),
        ...require('../scripts/lib/reader-resource-prose').fields(options.naturalResourceProse),
        ...options.signedRevisionDisplayFields,
        reviewFeedback: options.reviewFeedback || '', initialDraft: options.previousDraft,
        structuredArtifacts: options.structuredArtifacts?.payloadSha256 || '',
        directSupplementaryEvidence: options.directSupplementaryPreflightEvidence,
        ...(options.readerCapabilityPolicy ? {
            readerCapabilityPolicyContract: options.readerCapabilityPolicy.contract,
            readerCapabilityPolicySha256: options.readerCapabilityPolicy.policySha256
        } : {})
    });
}

test('source-only fingerprint extraction preserves all original conditional fields', () => {
    const paper = { id: '2610.00001', title: 'literal {{previousDraft}}' };
    const originalPaper = { id: paper.id, title: 'original' };
    const record = {
        contract: 'selected-muse-full-stage-reanalysis-v1', model: 'muse-spark-1.3-contributor',
        runId: 'synthetic-pure-hash-test',
        originalPaperSha256: crypto.createHash('sha256').update(JSON.stringify(originalPaper)).digest('hex')
    };
    const selected = { ...paper, fullStageReanalysis: record,
        fullStageReanalysisHistory: [{ ...record, originalPaper }] };
    const variants = [
        {}, { readerFactLocalRevision: true }, { resourceLocalRevision: true },
        { signedRevisionDisplayFields: { signedRevisionDisplayContract: 'pure-test' } },
        { readerCapabilityPolicy: { contract: 'pure-test', policySha256: '2'.repeat(64) } },
        { directSupplementaryPreflightEvidence: [{ kind: 'supplementary', ordinal: 1 }] },
        { naturalResourceProse: true }, { reviewFeedback: 'literal feedback' },
        { readerFactLocalRevision: true, resourceLocalRevision: true, naturalResourceProse: true,
            signedRevisionDisplayFields: { signedRevisionDisplaySha256: '1'.repeat(64) },
            readerCapabilityPolicy: { contract: 'pure-test', policySha256: '2'.repeat(64) },
            directSupplementaryPreflightEvidence: [{ kind: 'supplementary', ordinal: 1 }],
            reviewFeedback: 'literal {{sourceEvidence}}' }
    ];
    for (const input of [paper, selected]) {
        for (const variant of variants) {
            for (const previousDraft of ['无', 'literal reference', '']) {
                const options = { previousDraft, directSupplementaryPreflightEvidence: [],
                    readerGrantFields: { conferenceReaderGrant: { grantId: 'pure-hash-test' } },
                    structuredArtifacts: { payloadSha256: '4'.repeat(64) }, ...variant };
                assert.equal(deep.apiReaderSourceOnlyInputFingerprint(input, 'source evidence', options),
                    originalExpression(input, 'source evidence', options));
            }
        }
    }
});

test('normal replay preparation uses the same synchronous deterministic transform', async () => {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const paper = { arxivId: '2610.99012', title: 'pure replay wiring test' };
    const options = { sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts, readerReplayPreparationOnly: true };
    const prepared = await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(() =>
        deep.prepareApiReaderRetryIdentity(paper, '', '', options));
    const actual = prepared.normalizeReplayDraft(structuredClone(sample.draft), [], []);
    const direct = deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(sample.draft), [], {
        ...options, paperId: paper.arxivId, readerCapabilityPolicy: null, pixelFigureOrdinals: []
    });
    assert.deepEqual(actual, direct.draft);
    assert.equal(direct.mechanicalNoFigureCleanupChanged, false);
});
