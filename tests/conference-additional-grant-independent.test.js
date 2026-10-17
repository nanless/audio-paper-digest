'use strict';
// Independent plumbing checks: real grant/plan/PDF/CAS and cold postprocess;
// semantic Reader completion below is an explicit unit double, not a paper proof.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const engine = require('../scripts/analysis-engine');
const deep = require('../scripts/deep-analyzer');
const postprocess = require('../scripts/lib/conference-postprocess');
const grants = require('../scripts/lib/conference-recovery-grant');
const window = require('../scripts/lib/conference-reader-recovery-window');
const context = require('../scripts/lib/conference-analysis-context');
const stop = require('../scripts/lib/analysis-stop-control');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const { recoveryFixtureIdentity, registerRecoveryFixture } = require('./helpers/conference-recovery-grant-fixture');
const { validAnalysisPaper, validAnalysisText } = require('./valid-analysis-fixture');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
    const source = productionPlanFixture(t, { authors: ['Fixture Author'] });
    const { parentExecutionId } = recoveryFixtureIdentity(source.paperId);
    const analysisRoot = path.join(source.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId, planHandle: source.planHandle, sourceRoot: source.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: parentExecutionId, paperId: source.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    const analysis = validAnalysisText().replace('## 核心摘要\n', '## 核心摘要\n原文未提供可核对的关键定量结果。\n');
    const paper = { ...validAnalysisPaper('2609.12345', {}, analysis), ...parent.analysis.papers[0], analysis };
    delete paper.arxivId;
    const signed = validAnalysisPaper('2609.12345', {}, analysis);
    paper.analysisManifest = signed.analysisManifest;
    paper.analysisManifest.sourceAcquisition = { ...signed.analysisManifest.sourceAcquisition,
        analysisSource: 'conference_pdf_text', fullTextAvailable: true,
        sourceSha256: sha(parent.source.sourceDetails.text), modelTextSanitizationContract: 'model-text-unicode-scalars-v1' };
    paper.sourceSha256 = sha(parent.source.sourceDetails.text);
    paper.apiReaderPlan = { contract: 'beginner-researcher-v3', sections: [{ kind: 'reproduction', heading: '研究内容' }],
        tableBindings: [], formulaBindings: [], sourceBindingsContract: 'api-reader-source-bindings-v4' };
    paper.apiReaderArticle = '### 研究内容\n\n这是离线接线夹具的原始读者正文。';
    paper.apiReaderResources = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: paper.sourceSha256,
        resources: [] };
    paper.apiReaderResources.identitySha256 = adapter.stableHash(paper.apiReaderResources);
    paper.apiReaderAuthors = require('../scripts/lib/reader-author-parser').resolveVerifiedReaderAuthors(paper, parent.source.sourceDetails);
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = parent.source.sourceDetails.structuredArtifacts.payloadSha256;
    paper.analysisManifest.stages.apiReaderArticle = {
        status: 'complete',
        structuredArtifactsSha256: parent.source.sourceDetails.structuredArtifacts.payloadSha256,
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        readerAuthorsSha256: adapter.stableHash(paper.apiReaderAuthors)
    };
    paper.conferencePublication = { contract: 'conference-official-publication-v1',
        recordUrl: 'https://ieeexplore.ieee.org/document/100', pdfUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=100' };
    Object.assign(paper.analysisManifest.contracts, { apiReaderArticle: 'beginner-researcher-v3',
        apiReaderSourceBindings: 'api-reader-source-bindings-v4' });
    Object.assign(paper.analysisManifest.stages.scoringAudit, { scoringContract: 'api-scoring-audit-v2',
        outputAnalysisSha256: sha(analysis), stabilityWarning: false });
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis,
        papers: [paper], status: 'complete', completedAt: '2026-10-17T12:00:00.000Z' }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    t.mock.method(postprocess, 'readOriginalTagProof', () => ({ rules: {} }));
    const stageEngine = { ...engine, getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false };
    const operations = { buildApiReaderResourceIdentity: deep.buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async () => null,
        refreshApiReaderArticleFromSource: async () => { throw Error('original fixture interruption'); } };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine: stageEngine, deep: operations }), /fixture interruption/);
    const failedExecutionId = adapter.readerRevisionExecutionId(parentExecutionId, parent.analysisFileSha256);
    const registration = registerRecoveryFixture({ analysisRoot, parentExecutionId, failedExecutionId, paperId: source.paperId });
    return { ...source, ...input, failedExecutionId, registration, stageEngine, operations };
}

test('独立冷后处理从真实注册新窗口重建只读source/PDF能力，原请求及费用身份不改', async t => {
    const f = await fixture(t);
    const member = grants.readRecoveryGrantMember(f.registration.handle, f.paperId);
    const originalFiles = Object.fromEntries(member.files.map(record => [record.path, fs.readFileSync(record.path)]));
    let writes = 0;
    const stageEngine = { ...f.stageEngine, isSuccessfulAnalysisRecordForReadOnlyConferencePublication: paper => {
        assert.equal(window.getCurrentReaderWindow(paper).grantId, f.registration.manifest.grantId);
        return paper.apiReaderArticle.includes('新窗口');
    } };
    const operations = { ...f.operations, refreshApiReaderArticleFromSource: async paper => {
        writes++;
        const identity = { paperId: f.paperId, sourceSha256: paper.sourceSha256, maxAttempts: 6,
            promptSha256: '4'.repeat(64), ...window.identityFields(paper) };
        const lease = window.reserveReaderResponse(paper, identity, 'full', 1);
        window.settleReaderResponse(lease, 'content', '{"offlineReaderFixture":"new-window"}');
        paper.apiReaderArticle = '### 研究内容\n\n这是离线接线夹具的新窗口读者正文。';
        return paper;
    } };
    const recovered = await adapter.refreshConferenceGrantedRecovery({ ...f,
        grantHandle: f.registration.handle }, { engine: stageEngine, deep: operations });
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: recovered.executionId });
    const processApi = require('../scripts/lib/conference-process');
    const state = structuredClone(f.registration.state);
    state.items[f.paperId].analysisRunId = recovered.executionId;
    state.items[f.paperId].readerRevision = loaded.revision;
    state.stateSha256 = processApi.stateDigest(state);
    assert.doesNotThrow(() => processApi.assertState(state));
    const wrongExecution = structuredClone(state);
    wrongExecution.items[f.paperId].analysisRunId = '99999999-9999-4999-8999-999999999999';
    const badRevision = wrongExecution.items[f.paperId].readerRevision;
    badRevision.executionId = wrongExecution.items[f.paperId].analysisRunId;
    delete badRevision.revisionSha256;
    badRevision.revisionSha256 = adapter.stableHash(badRevision);
    wrongExecution.stateSha256 = processApi.stateDigest(wrongExecution);
    assert.throws(() => processApi.assertState(wrongExecution));
    const ledgerFile = path.join(loaded.directory, 'reader-grant-budget.json');
    const ledgerBytes = fs.readFileSync(ledgerFile);
    const analysisBytes = fs.readFileSync(path.join(loaded.directory, 'analysis.json'));
    // Only the semantic Reader checker is a double. Source/registration/normal
    // completion receipts/core/scoring checks below retain production behavior.
    let readerChecks = 0;
    t.mock.method(engine, 'hasValidApiReaderV3Records', paper => {
        readerChecks++;
        assert.equal(window.getCurrentReaderWindow(paper).executionId, recovered.executionId);
        const active = context.getConferenceAnalysisContext();
        const provider = require('../scripts/lib/conference-source-context').readerPdfSourceForContext(active.readerPdfSourceHandle);
        assert.equal(provider.paperId, f.paperId);
        assert.equal(sha(provider.sourceText), member.sourceSha256);
        assert.ok(Buffer.isBuffer(provider.pdf));
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        return true;
    });
    const load = () => postprocess.loadCompleted({ analysisRoot: f.analysisRoot, executionId: recovered.executionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { isSuccessful: paper => {
        assert.equal(window.getCurrentReaderWindow(paper).executionId, recovered.executionId);
        return true;
    } });
    assert.equal(load().run.executionId, recovered.executionId);
    assert.equal(load().run.executionId, recovered.executionId, '第二次冷加载不创建新窗口或新请求');
    assert.equal(writes, 1);
    assert.equal(readerChecks, 2);
    assert.deepEqual(fs.readFileSync(ledgerFile), ledgerBytes);
    assert.deepEqual(fs.readFileSync(path.join(loaded.directory, 'analysis.json')), analysisBytes);
    for (const [filename, original] of Object.entries(originalFiles)) assert.deepEqual(fs.readFileSync(filename), original);
    const revisionFile = path.join(loaded.directory, 'reader-revision.json');
    const revisionBytes = fs.readFileSync(revisionFile);
    fs.unlinkSync(revisionFile);
    assert.throws(load, error => error.code === 'ENOENT' || /revision|窗口|许可/.test(error.message));
    assert.equal(readerChecks, 2, '缺少新窗口凭证不得退回普通已完成稿资格');
    const stripped = JSON.parse(analysisBytes);
    delete stripped.readerRevisionProgress;
    fs.writeFileSync(path.join(loaded.directory, 'analysis.json'), JSON.stringify(stripped), { mode: 0o600 });
    assert.throws(load, /完成状态|完成凭证|evidence drifted|completion|complete run does not bind canonical analysis bytes/i);
    assert.equal(readerChecks, 2, '同时删除状态标记仍由原完成回执的字节绑定拒绝，不重签原run');
    fs.writeFileSync(path.join(loaded.directory, 'analysis.json'), analysisBytes);
    fs.writeFileSync(revisionFile, revisionBytes, { mode: 0o600 });
    const changedGrant = JSON.parse(revisionBytes);
    changedGrant.grantSha256 = 'f'.repeat(64);
    delete changedGrant.revisionSha256;
    changedGrant.revisionSha256 = adapter.stableHash(changedGrant);
    fs.writeFileSync(revisionFile, JSON.stringify(changedGrant), { mode: 0o600 });
    assert.throws(load, /许可SHA|许可身份|授权|窗口/);
    assert.equal(readerChecks, 2, '自行重算revision自哈希不能替代真实WM登记');
    fs.writeFileSync(revisionFile, revisionBytes, { mode: 0o600 });
    const ledger = JSON.parse(ledgerBytes);
    const responseFile = path.join(loaded.directory, ledger.requests[0].responseFile);
    const responseBytes = fs.readFileSync(responseFile);
    fs.appendFileSync(responseFile, ' ');
    assert.throws(load, /原材料无法冷核|原响应/);
    assert.equal(readerChecks, 2, '坏raw响应必须在内容资格前被拒');
    fs.writeFileSync(responseFile, responseBytes);
    assert.equal(load().run.executionId, recovered.executionId);
    assert.equal(writes, 1);
});
