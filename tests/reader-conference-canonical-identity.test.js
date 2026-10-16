'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const context = require('../scripts/lib/conference-analysis-context');
const direct = require('../scripts/lib/direct-rewrite-analysis-context');
const source = require('../scripts/lib/model-text-sanitization');
const repair = require('../scripts/lib/reader-repair');
const recovery = require('../scripts/lib/reader-recovery-revision');
const order = require('../scripts/lib/reader-draft-order');
const id = 'conference:interspeech:2026:isca-archive-id:test26';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function scoped(details, callback) {
    return context.withConferenceAnalysisSource({ paperId: id, executionDir: os.tmpdir(),
        sourceDetails: { source: 'conference_pdf_text', sourceId: id, text: '真实封存全文', ...details } }, callback);
}

test('Reader 恢复规范编号桥只接受当前会议同一真实 sourceId，保留 arXiv 别名拒绝', () => {
    assert.throws(() => source.currentModelInputSourceForPaperId(id), /authenticated conference source scope/);
    assert.equal(source.currentModelInputSourceForPaperId('2610.12345'), null);
    scoped({}, () => {
        assert.equal(source.currentModelInputSourceForPaperId(id).text, '真实封存全文');
        for (const other of ['2610.12345', id + 'x', undefined]) {
            assert.throws(() => source.currentModelInputSourceForPaperId(other), /canonical paperId differs/);
        }
        assert.throws(() => source.currentModelInputSource({ arxivId: id }), /refuses arXiv aliases/);
    });
    for (const sourceId of [undefined, id + 'x']) scoped({ sourceId }, () => {
        assert.throws(() => source.currentModelInputSourceForPaperId(id), /canonical paperId differs/);
    });
});

test('历史会议和 arXiv 的规范编号桥保留真实路线、运行凭证和跨论文保护', () => {
    for (const paperId of [id, 'arxiv:2610.12345']) {
        const conference = paperId === id, text = '历史真实封存正文';
        const artifacts = { payloadSha256: 'a'.repeat(64) };
        const identity = { paperId, route: conference ? 'conference-local-pdf' : 'arxiv-fresh-fetch',
            sourceDetails: { source: conference ? 'conference_pdf_text' : 'arxiv_html', sourceId: paperId,
                text, structuredArtifacts: artifacts }, readerAttemptsDir: path.join(os.tmpdir(), 'historical-reader-attempts'),
            runId: crypto.randomUUID(), sourceSha256: sha(text), structuredArtifactsSha256: artifacts.payloadSha256,
            sourceSnapshotSha256: 'b'.repeat(64),
            ...(!conference ? { sourceGeneration: 1, sourceManifestSha256: 'c'.repeat(64) } : {}) };
        direct.withDirectRewriteAnalysisSource(identity, () => {
            assert.equal(source.currentModelInputSourceForPaperId(paperId).text, text);
            if (!conference) for (const alias of ['2610.12345', '2610.12345v2']) {
                assert.equal(source.currentModelInputSourceForPaperId(alias).text, text);
            }
            for (const other of [id + 'x', '2610.99999', 'arxiv:' + id]) {
                assert.throws(() => source.currentModelInputSourceForPaperId(other), /canonical paperId|论文身份不合法/);
            }
        });
        const { runId, ...withoutRun } = identity;
        direct.withDirectRewriteAnalysisSource(withoutRun, () => {
            assert.equal(source.currentModelInputSourceForPaperId(paperId), null);
        });
        direct.withDirectRewriteAnalysisSource({ ...identity,
            route: conference ? 'arxiv-fresh-fetch' : 'conference-local-pdf',
            sourceGeneration: 1, sourceManifestSha256: 'c'.repeat(64) }, () => {
            assert.throws(() => source.currentModelInputSourceForPaperId(paperId), /route differs/);
        });
    }
});

test('日更与历史或会议来源意外嵌套时拒绝歧义，不能切换读取另一流程', t => {
    const Config = require('../scripts/config'), fresh = require('../scripts/lib/fresh-analysis-context');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mixed-reader-source-'));
    const previous = Config.FILES.freshRewriteRunsDir; Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), paperId = '2610.12345';
    const sourceExpectations = { [paperId]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1',
        runId, paperIds: [paperId], sourceExpectations }));
    fresh.withFreshAnalysisContext({ runId, runDir, sourceExpectations }, () => {
        direct.withDirectRewriteAnalysisSource({ paperId: 'arxiv:' + paperId, route: 'arxiv-fresh-fetch',
            readerAttemptsDir: path.join(root, 'attempts'), sourceDetails: {
                source: 'arxiv_html', sourceId: paperId, text: '不能替换日更封存来源', structuredArtifacts: {} }
        }, () => assert.throws(() => source.currentModelInputSourceForPaperId(paperId), /ambiguous mixed active source/));
        scoped({}, () => assert.throws(() => source.currentModelInputSourceForPaperId(id), /ambiguous mixed active source/));
    });
});

test('会议真实候选实现迁移用规范来源编号并保留原已付费预算和失败历史', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-canonical-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executionId = crypto.randomUUID(), executionDir = path.join(root, executionId);
    fs.mkdirSync(executionDir);
    const directory = path.join(executionDir, 'reader-attempts'), text = '真实封存全文';
    const oldIdentity = { paperId: id, sourceSha256: sha(text), inputFingerprint: 'same input',
        model: { model: 'test-model', maxTokens: 48000 }, promptSha256: 'p', repairPromptSha256: 'q',
        maxAttempts: 6, repairMaxTokens: 8000, repairImplementationSha256: 'c'.repeat(64) };
    const identity = { ...oldIdentity, repairImplementationSha256: 'd'.repeat(64) };
    const draft = { version: 3, readerTitle: '真实来源恢复', oneSentenceThesis: '保留原费用。',
        sections: order.READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: null, message: 'old diagnostic' }], attempts: 3, fullAttempts: 1,
        transportFailures: 2, noProgress: 1, failureSignature: 'old failure',
        validationFailureStreak: 2, validationFailureSignature: 'old normalized failure', imageEvidence: [] };
    const file = repair.saveFailedCandidate(directory, oldIdentity, payload), bytes = fs.readFileSync(file);
    const invoke = sourceDetails => context.withConferenceAnalysisSource({ executionId, executionDir,
        paperId: id, sourceDetails }, () => recovery.loadReaderRecoveryRevision(directory, identity, {
        allowNewImplementationAllowance: false,
        normalizeReplayDraft: value => order.normalizeReaderDraftOrder(value)
    }));
    assert.throws(() => invoke({ source: 'conference_pdf_text', sourceId: id, text: text + '篡改' }), /当前正文与候选身份不同|exact conference execution\/source scope/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const result = invoke({ source: 'conference_pdf_text', sourceId: id, text });
    assert.equal(result.status, 'failed');
    for (const field of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress',
        'failureSignature', 'validationFailureStreak', 'validationFailureSignature']) {
        assert.equal(result[field], payload[field], field);
    }
    assert.deepEqual(result.issues, payload.issues);
    assert.equal(result.implementationRepairAllowanceProof, null);
    assert.equal(result.readerRecoveryRevisions[0].scope, 'conference-process');
    const archive = path.join(directory, result.readerRecoveryRevisions[0].archivedName);
    assert.deepEqual(fs.readFileSync(archive), bytes);
});
