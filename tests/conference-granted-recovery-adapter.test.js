'use strict';
// Adapter orchestration tests use real registered grants and real plan/PDF
// fixtures. Stage outputs below are test doubles, never production completion.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const actualEngine = require('../scripts/analysis-engine');
const actualDeep = require('../scripts/deep-analyzer');
const context = require('../scripts/lib/conference-analysis-context');
const grants = require('../scripts/lib/conference-recovery-grant');
const budget = require('../scripts/lib/conference-reader-recovery-window');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const { recoveryFixtureIdentity, registerRecoveryFixture } = require('./helpers/conference-recovery-grant-fixture');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture');

async function fixture(t, { invalidCore = false, scoringMode = false, scoringFailed = false, coreRejected = false, tagProofCase = null } = {}) {
    const f = productionPlanFixture(t), identity = recoveryFixtureIdentity(f.paperId);
    const analysisRoot = path.join(f.root, 'data/runtime/conference-analysis-executions');
    const input = { analysisRoot, parentExecutionId: identity.parentExecutionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: identity.parentExecutionId, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    let analysis = invalidCore ? 'original invalid core' : validAnalysisText().replace('## 核心摘要\n',
        '## 核心摘要\n原文未提供可核对的关键定量结果。');
    if (scoringMode) analysis = analysis.replace('has_code: 否', 'has_code: 是');
    const sourceSha256 = require('crypto').createHash('sha256').update(parent.source.sourceDetails.text).digest('hex');
    const paper = { ...parent.analysis.papers[0], sourceSha256, analysis, apiReaderArticle: 'original parent Reader',
        analysisManifest: { sourceAcquisition: { sourceSha256: parent.source.sourceDetails.text &&
            require('crypto').createHash('sha256').update(parent.source.sourceDetails.text).digest('hex'),
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' },
            stages: { primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
                scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    if (tagProofCase) {
        const tagged = validAnalysisPaper(undefined, {}, analysis);
        paper.analysisManifest.contracts = tagged.analysisManifest.contracts;
        paper.analysisManifest.stages.taxonomySeal = tagged.analysisManifest.stages.taxonomySeal;
        paper.analysisManifest.stages.structureRepair = tagged.analysisManifest.stages.structureRepair;
        paper.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256 =
            tagged.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256;
        paper.analysisStageCheckpoints = tagged.analysisStageCheckpoints;
        if (tagProofCase.parent === 'missing') {
            delete paper.analysisManifest.stages.taxonomySeal;
            delete paper.analysisStageCheckpoints.taxonomySeal;
        } else if (tagProofCase.parent === 'mismatch') {
            paper.analysis = paper.analysis.replace(/#语音识别/g, '#语音合成');
        }
    }
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-17T12:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: identity.parentExecutionId });
    const post = require('../scripts/lib/conference-postprocess'), oldRead = post.readOriginalTagProof;
    post.readOriginalTagProof = () => ({ rules: {} }); t.after(() => { post.readOriginalTagProof = oldRead; });
    const engine = { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: actualEngine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        withPaperAnalysisLock: actualEngine.withPaperAnalysisLock,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false };
    const operations = { buildApiReaderResourceIdentity: actualDeep.buildApiReaderResourceIdentity,
        inspectSavedConferenceReaderCompletion: async () => null,
        refreshApiReaderArticleFromSource: async () => { throw Error('original paid fixture failure'); } };
    operations.refreshApiScoringAndReaderFromSource = async (current, _source, options) => {
        if (scoringFailed) throw Object.assign(Error('original scoring content exhausted'), { retryable: false });
        current.analysis = actualDeep.applyApiReaderResourceAvailability(current.analysis, current.apiReaderResources);
        const audit = { fixture: 'signed-score-content' };
        current.analysisManifest.stages.scoringAudit = { status: 'complete', audit,
            auditSha256: adapter.stableHash(audit), fixtureScoringToken: 'preserve-original-paid-score' };
        await options.onScoringComplete(current);
        throw Error('original paid fixture failure');
    };
    await assert.rejects(adapter.refreshConferenceReader(input, { engine, deep: operations }),
        scoringFailed ? /original scoring content exhausted/ : /original paid fixture failure/);
    const failedExecutionId = adapter.readerRevisionExecutionId(identity.parentExecutionId, parent.analysisFileSha256);
    let failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    adapter.replaceJson(path.join(failed.directory, 'analysis.json'), { ...failed.analysis,
        readerRevisionProgress: { ...failed.analysis.readerRevisionProgress, attempts: 3 } }, failed.analysisFileSha256);
    failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    if (coreRejected) {
        const changed = structuredClone(failed.analysis);
        changed.papers[0].analysisCheckpoint = changed.papers[0].analysis;
        changed.papers[0].analysisManifest.stages.coreSummaryRepair.status = 'contract_rejected';
        adapter.replaceJson(path.join(failed.directory, 'analysis.json'), changed, failed.analysisFileSha256);
        failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    }
    if (tagProofCase) {
        const changed = structuredClone(failed.analysis), current = changed.papers[0];
        if (tagProofCase.forceNormal !== false) current.analysisManifest.stages.primaryAnalysis.status = 'contract_rejected';
        if (tagProofCase.failed === 'missing') {
            delete current.analysisManifest.stages.taxonomySeal;
            delete current.analysisStageCheckpoints.taxonomySeal;
        } else if (tagProofCase.failed === 'mismatch') {
            current.analysis = current.analysis.replace(/#语音识别/g, '#语音合成');
        }
        adapter.replaceJson(path.join(failed.directory, 'analysis.json'), changed, failed.analysisFileSha256);
        failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    }
    const grant = registerRecoveryFixture({ analysisRoot, parentExecutionId: identity.parentExecutionId, failedExecutionId, paperId: f.paperId });
    // The new regressions below use the real tag proof reader for every grant
    // entry and final gate. Only the pre-existing synthetic bootstrap uses the
    // orchestration double, before the tested recovery operation starts.
    if (tagProofCase) post.readOriginalTagProof = oldRead;
    return { ...f, ...input, failedExecutionId, failed, grant, engine, operations };
}

test('正常分析从真实父词表恢复未完成标签，但新稿仍须通过自己的完整标签证明', async t => {
    for (const failed of ['missing', 'mismatch']) await t.test(failed, async t => {
        const f = await fixture(t, { tagProofCase: { failed } });
        const post = require('../scripts/lib/conference-postprocess');
        assert.ok(post.readOriginalTagProof(f.failed.parent.analysis.papers[0]).rules.registrySha256);
        assert.throws(() => post.readOriginalTagProof(f.failed.analysis.papers[0]), /标签阶段/);
        const originals = ['analysis.json', 'run.json', 'source.json', 'reader-revision.json']
            .map(name => ({ name, bytes: fs.readFileSync(path.join(f.failed.directory, name)) }));
        const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
            failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
        let calls = 0;
        const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
            calls++; assert.ok(context.getConferenceAnalysisSource(paper)); assert.ok(budget.getCurrentReaderWindow(paper));
            if (calls === 1) return { success: false, result: paper, error: 'normal tag recovery reached', retryable: false };
            return { success: true, result: paper };
        }, isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => assert.fail('invalid final tags must fail first') };
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: f.operations }), /normal tag recovery reached/);
        const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
        const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
        assert.equal(loaded.revision.mode, 'normal-analysis');
        assert.equal(loaded.analysis.readerRevisionProgress.attempts, 1);
        // A normal engine result alone cannot authorize publication while its
        // own current classification is still absent or mismatched.
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: f.operations }), /标签阶段/);
        const after = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
        assert.equal(after.analysis.status, 'partial'); assert.equal(after.analysis.readerRevisionProgress.attempts, 2);
        for (const { name, bytes } of originals) assert.deepEqual(fs.readFileSync(path.join(f.failed.directory, name)), bytes);
        assert.equal(f.failed.analysis.readerRevisionProgress.attempts, 3);
    });
});

test('正常窗口跨轮保留已失败阶段请求禁令，纯复验成功也不能重新授予调用', async t => {
    const f = await fixture(t, { invalidCore: true });
    const guard = require('../scripts/lib/analysis-stage-request-guard');
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    let calls = 0;
    const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
        calls++;
        // A newly authorized window may execute a previously failed seed stage.
        if (calls === 1) {
            assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('tagSelection'));
            paper.analysisManifest.stages.tagSelection = { status: 'contract_rejected' };
        } else {
            assert.throws(() => guard.assertStageModelRequestAllowed('tagSelection'),
                error => error.code === guard.CODE && error.retryable === false);
            // A distinct downstream stage which has not failed keeps its own
            // original eligibility; no transport or provider is used here.
            assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('imageSupplement'));
            // Pure validation can succeed, but must not erase the saved ban.
            paper.analysisManifest.stages.tagSelection = { status: 'complete' };
        }
        return { success: false, result: paper, error: 'fixture stops before model', retryable: false };
    } };
    const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    for (let round = 1; round <= 3; round++) {
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: f.operations }),
            /fixture stops before model/);
        const saved = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot,
            executionId: member.expectedExecutionId });
        assert.equal(saved.analysis.readerRevisionProgress.attempts, round);
        assert.deepEqual(saved.analysis.readerRevisionProgress.blockedAuxiliaryModelStages,
            round === 1 ? [] : ['tagSelection']);
    }
    assert.equal(calls, 3);
});

test('保存的阶段禁令字段异常在推进轮次或调用前停止', async t => {
    const f = await fixture(t, { invalidCore: true });
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    let calls = 0;
    const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
        calls++; return { success: false, result: paper, error: 'fixture initial stop', retryable: false };
    } };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: f.operations }), /fixture initial stop/);
    const id = grants.readRecoveryGrantMember(f.grant.handle, f.paperId).expectedExecutionId;
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: id });
    for (const value of [null, 0, ['unknownStage'], ['tagSelection', 'tagSelection']]) {
        const changed = structuredClone(loaded.analysis);
        changed.readerRevisionProgress.blockedAuxiliaryModelStages = value;
        const file = path.join(loaded.directory, 'analysis.json');
        adapter.replaceJson(file, changed, adapter.readJsonRecord(file).sha256);
        const bytes = fs.readFileSync(file);
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: f.operations }), /请求禁令记录无效/);
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(calls, 1);
    }
});

test('新评分失败不能借父complete审计重开，内容后传输失败也不重授次数', async t => {
    for (const retryable of [false, true]) await t.test(String(retryable), async t => {
        const f = await fixture(t, { scoringMode: true, scoringFailed: true });
        const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
            failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot,
            grantHandle: f.grant.handle };
        const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
        let scoringCalls = 0, physicalCalls = 0, contentResponses = 0;
        const operations = { ...f.operations, refreshApiScoringAndReaderFromSource: async (paper, source) => {
            scoringCalls++;
            return actualDeep.auditTypeAwareScoringDetailed(paper.analysis, source.text, {
                callModelFn: async (_messages, _tokens, options) => {
                    physicalCalls++;
                    assert.equal(options.usageContext.contentAttempt, physicalCalls);
                    if (retryable && physicalCalls === 3) {
                        throw Object.assign(Error('synthetic scoring transport failure after two content responses'), { retryable: true });
                    }
                    contentResponses++;
                    return '{}'; // Explicitly synthetic rejected output, no provider request.
                }
            });
        }, refreshApiReaderArticleFromSource: () => assert.fail('scoring never completed') };
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }),
            retryable ? /synthetic scoring transport/ : /评分/);
        const before = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot,
            executionId: member.expectedExecutionId });
        assert.equal(before.revision.mode, 'scoring-and-reader');
        assert.equal(before.analysis.readerRevisionProgress.attempts, 1);
        assert.equal(before.analysis.readerRevisionProgress.scoringCheckpoint, undefined);
        assert.equal(before.analysis.papers[0].analysisManifest.stages.scoringAudit.status, 'complete');
        const bytes = fs.readFileSync(path.join(before.directory, 'analysis.json'));
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }),
            error => error.code === 'CONFERENCE_READER_REVISION_SCORING_RECOVERY_BLOCKED');
        const after = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot,
            executionId: member.expectedExecutionId });
        assert.equal(scoringCalls, 1);
        assert.equal(physicalCalls, 3);
        assert.equal(contentResponses, retryable ? 2 : 3);
        assert.equal(after.analysis.readerRevisionProgress.attempts, 1);
        assert.deepEqual(fs.readFileSync(path.join(before.directory, 'analysis.json')), bytes);
        assert.equal(fs.existsSync(path.join(before.directory, 'reader-grant-budget.json')), false);
        member.assertUnchanged();
    });
});

test('正常分析不能借无效父标签，固定Reader模式也不能借父词表绕过坏子标签', async t => {
    for (const tagProofCase of [{ parent: 'missing' }, { parent: 'mismatch' }, { failed: 'missing', forceNormal: false }]) {
        await t.test(JSON.stringify(tagProofCase), async t => {
            const f = await fixture(t, { tagProofCase });
            const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
            let calls = 0;
            const engine = { ...f.engine, analyzePaperWithRetry: async () => { calls++; assert.fail('invalid proof reached normal analysis'); } };
            await assert.rejects(adapter.refreshConferenceGrantedRecovery({ analysisRoot: f.analysisRoot,
                parentExecutionId: f.parentExecutionId, failedExecutionId: f.failedExecutionId, planHandle: f.planHandle,
                sourceRoot: f.sourceRoot, grantHandle: f.grant.handle }, { engine, deep: f.operations }), /标签阶段/);
            assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.analysisRoot, member.expectedExecutionId)), false);
            assert.equal(adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot,
                executionId: f.failedExecutionId }).analysis.readerRevisionProgress.attempts, 3);
        });
    }
});

test('真实注册许可新建隔离窗口，原3/3与原稿字节不变，新窗口三轮封顶', async t => {
    const f = await fixture(t), originalBytes = fs.readFileSync(path.join(f.failed.directory, 'analysis.json'));
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    let calls = 0;
    const operations = { ...f.operations, refreshApiReaderArticleFromSource: async (paper, source) => {
        calls++;
        assert.equal(context.getConferenceAnalysisSource(paper).text, source.text);
        const window = budget.getCurrentReaderWindow(paper, source.text);
        assert.equal(window.grantId, f.grant.manifest.grantId);
        assert.notEqual(window.executionId, f.failedExecutionId);
        throw Error('new window fixture content failure');
    } };
    for (let round = 0; round < 3; round++) await assert.rejects(
        adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }), /new window fixture content failure/);
    const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
    assert.equal(loaded.revision.mode, 'reader-only');
    assert.equal(loaded.analysis.readerRevisionProgress.attempts, 3);
    assert.equal(loaded.analysis.readerRevisionProgress.failures.length, 3);
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }),
        error => error.code === 'CONFERENCE_READER_REVISION_BUDGET_EXHAUSTED');
    assert.equal(calls, 3);
    const revisionFile = path.join(loaded.directory, 'reader-revision.json');
    const originalRevision = adapter.readJsonRecord(revisionFile);
    const { revisionSha256: _previous, ...changedMode } = originalRevision.value;
    changedMode.mode = 'normal-analysis';
    adapter.replaceJson(revisionFile, { ...changedMode, revisionSha256: adapter.stableHash(changedMode) }, originalRevision.sha256);
    assert.throws(() => adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot,
        executionId: member.expectedExecutionId }), /模式与原失败上游范围不一致/);
    adapter.replaceJson(revisionFile, originalRevision.value, adapter.readJsonRecord(revisionFile).sha256);
    assert.deepEqual(fs.readFileSync(path.join(f.failed.directory, 'analysis.json')), originalBytes);
    assert.equal(adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId }).analysis.readerRevisionProgress.attempts, 3);
});

test('伪许可与旧稿CAS漂移在新窗口写入/模型调用前拒绝', async t => {
    const f = await fixture(t), request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: {} };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: f.operations }), /追加许可能力/);
    const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId), dir = path.join(f.analysisRoot, member.expectedExecutionId);
    assert.equal(fs.existsSync(dir), false);
    fs.appendFileSync(path.join(f.failed.directory, 'analysis.json'), ' ');
    await assert.rejects(adapter.refreshConferenceGrantedRecovery({ ...request, grantHandle: f.grant.handle },
        { engine: f.engine, deep: f.operations }), /原父稿|CAS|已变化/);
    assert.equal(fs.existsSync(dir), false);
});

test('原Reader-only遇真实不合法核心，只在独立获准窗口升级正常上游', async t => {
    const f = await fixture(t, { invalidCore: true }), before = fs.readFileSync(path.join(f.failed.directory, 'reader-revision.json'));
    let normalCalls = 0;
    const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
        normalCalls++; assert.ok(context.getConferenceAnalysisSource(paper));
        assert.ok(budget.getCurrentReaderWindow(paper));
        return { success: false, result: paper, error: 'normal upstream fixture failure', retryable: false };
    } };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery({ analysisRoot: f.analysisRoot,
        parentExecutionId: f.parentExecutionId, failedExecutionId: f.failedExecutionId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, grantHandle: f.grant.handle }, { engine, deep: f.operations }), /normal upstream fixture failure/);
    const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
    assert.equal(loaded.revision.mode, 'normal-analysis'); assert.equal(normalCalls, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.failed.directory, 'reader-revision.json')), before);
});


test('原已签评分检查点逐字核验后继承到新窗口，不重复评分', async t => {
    const f = await fixture(t, { scoringMode: true });
    assert.equal(f.failed.revision.mode, 'scoring-and-reader');
    const oldCheckpoint = structuredClone(f.failed.analysis.readerRevisionProgress.scoringCheckpoint);
    const originalAnalysis = fs.readFileSync(path.join(f.failed.directory, 'analysis.json'));
    assert.ok(oldCheckpoint);
    let scoringCalls = 0, readerCalls = 0;
    const operations = { ...f.operations,
        refreshApiScoringAndReaderFromSource: async () => { scoringCalls++; throw Error('must not score again'); },
        refreshApiReaderArticleFromSource: async () => { readerCalls++;
            throw Object.assign(Error('Reader fixture still incomplete'), { retryable: false }); } };
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }), /Reader fixture still incomplete/);
    const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    let loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
    assert.equal(scoringCalls, 0); assert.equal(readerCalls, 1);
    assert.deepEqual(loaded.analysis.readerRevisionProgress.inheritedScoringCheckpoint.checkpoint, oldCheckpoint);
    assert.equal(loaded.analysis.readerRevisionProgress.inheritedScoringCheckpoint.executionId, f.failedExecutionId);
    assert.notEqual(loaded.analysis.readerRevisionProgress.scoringCheckpoint.revisionSha256, oldCheckpoint.revisionSha256);
    assert.equal(loaded.analysis.readerRevisionProgress.scoringCheckpoint.scoringStageSha256, oldCheckpoint.scoringStageSha256);
    assert.equal(loaded.analysis.readerRevisionProgress.failures[0].retryable, false);
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }),
        /Reader fixture still incomplete/);
    loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
    assert.equal(scoringCalls, 0); assert.equal(readerCalls, 2);
    assert.equal(loaded.analysis.readerRevisionProgress.attempts, 2);
    const analysisFile = path.join(loaded.directory, 'analysis.json');
    const changed = structuredClone(loaded.analysis);
    changed.papers[0].analysisManifest.stages.scoringAudit.fixtureScoringToken = 'tampered-new-score';
    adapter.replaceJson(analysisFile, changed, loaded.analysisFileSha256);
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }), /评分检查点/);
    assert.equal(scoringCalls, 0); assert.equal(readerCalls, 2);
    assert.equal(adapter.readJsonRecord(analysisFile).value.readerRevisionProgress.attempts, 2);
    assert.deepEqual(fs.readFileSync(path.join(f.failed.directory, 'analysis.json')), originalAnalysis);
});


test('新窗口完成与重入沿正常资格接口，旧阶段及原失败计数不动', async t => {
    const f = await fixture(t), oldBytes = fs.readFileSync(path.join(f.failed.directory, 'analysis.json'));
    let readers = 0;
    const engine = { ...f.engine, isSuccessfulAnalysisRecordForReadOnlyConferencePublication: paper => {
        assert.ok(context.getConferenceAnalysisSource(paper));
        assert.ok(budget.getCurrentReaderWindow(paper));
        return paper.apiReaderArticle === 'new isolated fixture Reader';
    } };
    const operations = { ...f.operations, refreshApiReaderArticleFromSource: async paper => {
        readers++; paper.apiReaderArticle = 'new isolated fixture Reader'; return paper;
    } };
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    const result = await adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations });
    assert.equal(result.status, 'complete');
    const first = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: result.executionId });
    const completeBytes = fs.readFileSync(path.join(first.directory, 'analysis.json'));
    assert.equal(first.run.status, 'complete');
    for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit']) assert.deepEqual(
        first.analysis.papers[0].analysisManifest.stages[name], f.failed.analysis.papers[0].analysisManifest.stages[name]);
    assert.equal(first.analysis.readerRevisionProgress.attempts, 1);
    assert.deepEqual(first.analysis.readerRevisionProgress.failures, []);
    await adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations });
    assert.equal(readers, 1);
    assert.deepEqual(fs.readFileSync(path.join(first.directory, 'analysis.json')), completeBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.failed.directory, 'analysis.json')), oldBytes);
});


test('旧核心零请求复验仅一次且封存确定性，仍不合格才交新正常窗口', async t => {
    const f = await fixture(t, { coreRejected: true });
    let oldCoreReads = 0, newCalls = 0;
    const operations = { ...f.operations, analyzePaperDeep: async paper => {
        oldCoreReads++;
        assert.equal(context.getConferenceAnalysisContext().executionId, f.failedExecutionId);
        assert.ok(context.getConferenceAnalysisContext().readerPdfSourceHandle);
        assert.throws(() => require('../scripts/lib/analysis-stop-control').assertMayStartRequest(),
            error => error.code === 'MODEL_REQUESTS_FORBIDDEN_FOR_REPLAY');
        throw Object.assign(Error('原付费摘要仍未通过当前检查：fixture'), { code: 'CONTRACT_REJECTED' });
    }, refreshApiReaderArticleFromSource: async () => { newCalls++; throw Error('new permitted fixture Reader failure'); } };
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
        newCalls++; return { success: false, result: paper, error: 'new permitted fixture Reader failure', retryable: false };
    } };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }), /new permitted fixture Reader failure/);
    const id = grants.readRecoveryGrantMember(f.grant.handle, f.paperId).expectedExecutionId;
    const seedFile = path.join(f.analysisRoot, id, 'recovery-seed.json'), before = fs.readFileSync(seedFile);
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }), /new permitted fixture Reader failure/);
    assert.equal(oldCoreReads, 1); assert.equal(newCalls, 2);
    assert.deepEqual(fs.readFileSync(seedFile), before);
    assert.match(JSON.parse(before).coreReplayFailure.message, /原付费摘要仍未通过/);
});

test('旧核心复验的十二节/上游保护和真实存储异常不能降为可付费fallback', async t => {
    const f = await fixture(t, { coreRejected: true });
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    let nextCalls = 0;
    const operations = { ...f.operations, refreshApiReaderArticleFromSource: async () => { nextCalls++; } };
    operations.analyzePaperDeep = async paper => {
        paper.analysisCheckpoint += '\nchanged exterior';
        paper.analysisManifest.stages.coreSummaryRepair = { status: 'complete', paidDiagnosticReplay: { id: '11111111-1111-4111-8111-111111111111' } };
        paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](paper);
    };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }),
        error => error.code === 'CONFERENCE_RECOVERY_GRANT_INTEGRITY' && /十二节/.test(error.message));
    operations.analyzePaperDeep = async () => { throw Object.assign(Error('fixture disk read failed'), { code: 'EIO' }); };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine: f.engine, deep: operations }), /fixture disk read failed/);
    assert.equal(nextCalls, 0);
    const id = grants.readRecoveryGrantMember(f.grant.handle, f.paperId).expectedExecutionId;
    assert.equal(fs.existsSync(path.join(f.analysisRoot, id, 'recovery-seed.json')), false);
});


test('真实核心诊断三文件经生产原核心阶段签发，捕获后可冷重入且旧文件不改', async t => {
    const f = await fixture(t, { coreRejected: true });
    const filename = require.resolve('../scripts/deep-analyzer'), raw = fs.readFileSync(filename, 'utf8');
    const begin = raw.indexOf('    let coreSummaryRepairStage = prepareTextRecoveryStage(');
    const end = raw.indexOf('    // 评分前，先核对资源链接', begin);
    assert.ok(begin > 0 && end > begin);
    const Module = require('node:module'), compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    // Invoke the unchanged production core phase only; do not handwrite a stage
    // or repeat the engine's binding/signature implementation in this fixture.
    compiled._compile(raw + '\nmodule.exports.testCoreTokens=TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair.maxTokens;\n'
        + 'module.exports.testNormalCorePhase=async(paper,options)=>{let analysis=paper.analysisCheckpoint;'
        + 'const analysisManifest=paper.analysisManifest,rawTextForAnalysis=options.sourceText,arxivId=paper.id,imageManifest=null;'
        + raw.slice(begin,end) + '\nreturn paper;};', filename);
    const old = f.failed.analysis.papers[0], sourceText = f.failed.source.sourceDetails.text;
    const handle = adapter.verifyPlanAuthority(f.failed, f.planHandle, f.sourceRoot);
    const withOld = callback => context.withConferenceAnalysisSource({ executionId: f.failedExecutionId,
        executionDir: f.failed.directory, paperId: f.paperId, sourceDetails: f.failed.source.sourceDetails,
        readerPdfSourceHandle: handle }, callback);
    const prepared = withOld(() => actualDeep.prepareTextRecoveryStage(structuredClone(old),
        structuredClone(old.analysisManifest), 'coreSummaryRepair', old.analysisCheckpoint, sourceText));
    const diagnosticSource = withOld(() => context.conferenceCoreSummaryRepairContext(old, sourceText));
    const hash = value => require('crypto').createHash('sha256').update(value).digest('hex');
    const identity = { paperId: f.paperId, sourceIdentity: diagnosticSource.sourceIdentity,
        sourceTextSha256: hash(sourceText), inputAnalysisSha256: hash(prepared.inputAnalysis),
        evidenceSha256: hash(prepared.evidenceContext), stageFingerprint: prepared.fingerprint,
        maxTokens: compiled.exports.testCoreTokens, repairRequestPolicy: actualDeep.resolveRepairRequestPolicy('coreSummaryRepair') || null,
        promptTextContract: prepared.promptTextContract };
    const diagnostics = require('../scripts/lib/reader-request-diagnostics');
    const record = diagnostics.beginCoreSummaryDiagnostic(diagnosticSource.directory,
        { identity, inputAnalysis: prepared.inputAnalysis, sourceText, evidenceText: prepared.evidenceContext,
            prompt: 'Explicitly synthetic offline core replay fixture; no provider request is claimed.' });
    const response = '## 核心摘要\n' + actualDeep.extractSectionByTitle(prepared.inputAnalysis, '核心摘要');
    diagnostics.saveCoreSummaryResponse(record, response);
    diagnostics.saveCoreSummaryDisposition(record, { status: 'rejected', outputTextSha256: hash(response) });
    const originalFiles = Object.fromEntries(['analysis.json','run.json','source.json','reader-revision.json']
        .map(name => [name, fs.readFileSync(path.join(f.failed.directory,name))]));
    let replayCalls = 0, downstreamCalls = 0;
    const operations = { ...f.operations, analyzePaperDeep: async (paper, options) => {
        replayCalls++; assert.equal(options.replayLatestCoreSummaryDiagnostic, true);
        assert.equal(context.getConferenceAnalysisContext().executionId, f.failedExecutionId);
        return compiled.exports.testNormalCorePhase(paper, { ...options, sourceText });
    } };
    const engine = { ...f.engine, analyzePaperWithRetry: async paper => {
        downstreamCalls++;
        assert.equal(paper.analysisManifest.stages.coreSummaryRepair.paidDiagnosticReplay.id, record.id);
        assert.ok(['complete','not_needed'].includes(paper.analysisManifest.stages.coreSummaryRepair.status));
        return { success: false, result: paper, error: 'new downstream fixture incomplete', retryable: false };
    } };
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }), /new downstream fixture incomplete/);
    const id = grants.readRecoveryGrantMember(f.grant.handle, f.paperId).expectedExecutionId;
    const seedFile = path.join(f.analysisRoot,id,'recovery-seed.json'), seedBytes = fs.readFileSync(seedFile);
    assert.equal(JSON.parse(seedBytes).paidCoreReplay, record.id);
    adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: id });
    await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }), /new downstream fixture incomplete/);
    assert.equal(replayCalls, 1); assert.equal(downstreamCalls, 2);
    assert.deepEqual(fs.readFileSync(seedFile), seedBytes);
    for (const [name,bytes] of Object.entries(originalFiles)) assert.deepEqual(fs.readFileSync(path.join(f.failed.directory,name)),bytes);
});

test('追加窗口重入把显式核心复验交给当前子稿真实来源与正常阶段，不借原失败稿或补付请求', async t => {
    const filename = require.resolve('../scripts/deep-analyzer'), raw = fs.readFileSync(filename, 'utf8');
    const begin = raw.indexOf('    let coreSummaryRepairStage = prepareTextRecoveryStage(');
    const end = raw.indexOf('    // 评分前，先核对资源链接', begin);
    assert.ok(begin > 0 && end > begin);
    const Module = require('node:module'), compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(raw + '\nmodule.exports.testCoreTokens=TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair.maxTokens;\n'
        + 'module.exports.testNormalCorePhase=async(paper,options)=>{let analysis=paper.analysisCheckpoint;'
        + 'const analysisManifest=paper.analysisManifest,rawTextForAnalysis=options.sourceText,arxivId=paper.id,imageManifest=null;'
        + raw.slice(begin,end) + '\nreturn paper;};', filename);
    for (const variant of ['enabled', 'disabled', 'invalid-latest']) await t.test(variant, async t => {
        const f = await fixture(t, { coreRejected: true });
        const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
            failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot,
            grantHandle: f.grant.handle, reusePaidCoreDiagnostics: variant !== 'disabled' };
        const member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
        let calls = 0, currentCoreReads = 0;
        const operations = { ...f.operations, analyzePaperDeep: async (paper, options) => {
            const currentContext = context.getConferenceAnalysisContext();
            assert.equal(options.replayLatestCoreSummaryDiagnostic, true);
            if (currentContext.executionId === f.failedExecutionId) {
                throw Object.assign(Error('synthetic original core remains rejected'), { code: 'CONTRACT_REJECTED' });
            }
            currentCoreReads++;
            assert.equal(currentContext.executionId, member.expectedExecutionId);
            assert.ok(currentContext.readerPdfSourceHandle);
            assert.ok(budget.getCurrentReaderWindow(paper));
            // This exercises the unchanged production core phase using three
            // explicitly synthetic offline diagnostic files, never a model.
            return require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(() =>
                compiled.exports.testNormalCorePhase(paper, {
                    ...options, sourceText: currentContext.sourceDetails.text
                }));
        } };
        const engine = { ...f.engine, analyzePaperWithRetry: async (paper, options) => {
            calls++;
            if (calls === 1) {
                assert.equal(options.analyzeFn, undefined);
            } else if (variant === 'disabled') {
                assert.equal(options.analyzeFn, undefined);
            } else {
                assert.equal(typeof options.analyzeFn, 'function');
                paper = await options.analyzeFn(paper);
            }
            return { success: false, result: paper, error: 'synthetic downstream remains incomplete', retryable: false };
        } };
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }),
            /synthetic downstream remains incomplete/);
        const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
        assert.equal(loaded.analysis.readerRevisionProgress.attempts, 1);
        const sourceText = loaded.source.sourceDetails.text;
        const handle = adapter.verifyPlanAuthority(loaded, f.planHandle, f.sourceRoot);
        const withCurrent = callback => context.withConferenceAnalysisSource({ executionId: loaded.run.executionId,
            executionDir: loaded.directory, paperId: f.paperId, sourceDetails: loaded.source.sourceDetails,
            readerPdfSourceHandle: handle }, callback);
        const prepared = withCurrent(() => actualDeep.prepareTextRecoveryStage(structuredClone(loaded.analysis.papers[0]),
            structuredClone(loaded.analysis.papers[0].analysisManifest), 'coreSummaryRepair',
            loaded.analysis.papers[0].analysisCheckpoint, sourceText));
        const diagnosticSource = withCurrent(() => context.conferenceCoreSummaryRepairContext(loaded.analysis.papers[0], sourceText));
        const hash = value => require('crypto').createHash('sha256').update(value).digest('hex');
        const identity = { paperId: f.paperId, sourceIdentity: diagnosticSource.sourceIdentity,
            sourceTextSha256: hash(sourceText), inputAnalysisSha256: hash(prepared.inputAnalysis),
            evidenceSha256: hash(prepared.evidenceContext), stageFingerprint: prepared.fingerprint,
            maxTokens: compiled.exports.testCoreTokens, repairRequestPolicy: actualDeep.resolveRepairRequestPolicy('coreSummaryRepair') || null,
            promptTextContract: prepared.promptTextContract };
        const diagnostics = require('../scripts/lib/reader-request-diagnostics');
        const record = diagnostics.beginCoreSummaryDiagnostic(diagnosticSource.directory, {
            identity, inputAnalysis: prepared.inputAnalysis, sourceText, evidenceText: prepared.evidenceContext,
            prompt: 'Explicitly synthetic current-grant core replay fixture; no provider request is claimed.'
        });
        const response = '## 核心摘要\n' + (variant === 'invalid-latest' ? '这个摘要过短。'
            : actualDeep.extractSectionByTitle(prepared.inputAnalysis, '核心摘要'));
        diagnostics.saveCoreSummaryResponse(record, response);
        diagnostics.saveCoreSummaryDisposition(record, { status: 'rejected', outputTextSha256: hash(response) });
        const pinned = ['request', 'response', 'disposition'].map(kind => {
            const file = path.join(record.directory, record.id + '.' + kind + '.json');
            return { file, bytes: fs.readFileSync(file) };
        });
        await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep: operations }),
            variant === 'invalid-latest' ? /原付费摘要仍未通过/ : /synthetic downstream remains incomplete/);
        const after = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
        assert.equal(after.analysis.readerRevisionProgress.attempts, 2);
        assert.equal(currentCoreReads, variant === 'disabled' ? 0 : 1);
        assert.equal(after.analysis.status, 'partial');
        if (variant === 'enabled') {
            assert.equal(after.analysis.papers[0].analysisManifest.stages.coreSummaryRepair.paidDiagnosticReplay.id, record.id);
            assert.ok(['complete', 'not_needed'].includes(after.analysis.papers[0].analysisManifest.stages.coreSummaryRepair.status));
        }
        for (const { file, bytes } of pinned) assert.deepEqual(fs.readFileSync(file), bytes);
        member.assertUnchanged();
        assert.equal(fs.existsSync(path.join(loaded.directory, 'reader-grant-budget.json')), false);
    });
});
