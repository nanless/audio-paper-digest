'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const api = require('../scripts/lib/conference-process');
const actualEngine = require('../scripts/analysis-engine');
const migration = require('../scripts/migrate-conference-process');
const stop = require('../scripts/lib/analysis-stop-control');
const grants = require('../scripts/lib/conference-recovery-grant');
const { fixture } = require('./helpers/conference-recovery-continuation-fixture');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deny = () => { throw Error('Offline migration adoption forbids network'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;

// Real source/PDF, opaque grant, execution chain and locks. Only scientific
// success/rendering in positive scheduling cases is an explicit double; a
// separate test below exercises the real scientific gate and must reject it.
async function completed(t, { partial = false } = {}) {
    const f = await fixture(t), member = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    const engine = { ...f.engine, isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => !partial };
    const deep = { ...f.operations, refreshApiReaderArticleFromSource: async paper => {
        if (partial) throw Error('synthetic saved partial child');
        return paper;
    } };
    if (partial) await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep }), /synthetic saved partial/);
    else assert.equal((await adapter.refreshConferenceGrantedRecovery(request, { engine, deep })).status, 'complete');
    const state = structuredClone(f.grant.state), item = state.items[f.paperId];
    item.readerRefreshRequired = true; item.retryBudgetStart = item.attempts; item.attempts += 3;
    item.retryAuthorizedAtAttempt = item.attempts - 1;
    item.retryReleases = [{ attempts: item.retryBudgetStart, recoveryGrantId: member.grantId,
        recoveryGrantSha256: member.grantSha256 }];
    item.lastError = 'saved genuine failure before scheduler adoption';
    item.lastFailure = { category: 'paper', code: 'CONFERENCE_READER_REVISION_POSTPROCESS_FAILED',
        retryable: false, systemic: false, message: item.lastError, at: state.updatedAt };
    state.batchFailure = { category: 'authentication', code: 'LLM_ACCOUNT_AUTH_ERROR', message: 'old stopped run',
        retryable: false, systemic: true, at: state.updatedAt };
    state.generation++; state.stateSha256 = api.stateDigest(state); api.assertState(state);
    const stateFile = path.join(f.grant.processDirectory, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const source = { planHandle: f.planHandle, sourceCacheRoot: f.sourceRoot,
        sealed: [{ paperId: f.paperId, proof: item.sourceProof }] };
    const files = { conferenceAnalysisDir: f.analysisRoot,
        conferenceProcessDir: path.dirname(f.grant.processDirectory),
        conferencePageStagingDir: path.join(f.root, 'new-staging'), tagCatalogFile: path.join(f.root, 'unused-tags.json') };
    const context = { authority: state.authority, members: [{ paperId: f.paperId }], files };
    const deps = { files, engine: actualEngine, adapter, loadAuthority: () => context,
        prepareShared: async () => source, now: () => '2026-10-18T03:00:00.000Z',
        aggregate: () => assert.fail('postprocess-only must not aggregate'),
        processPaper: () => assert.fail('exhausted saved child must not enter paid dispatch') };
    const options = { apply: true, fromProcessId: state.processId, postprocessOnly: true, concurrency: 1 };
    const staged = () => {
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: member.expectedExecutionId });
        adapter.verifyPlanAuthority(loaded, f.planHandle, f.sourceRoot);
        return { status: 'staged', manifest: { paperId: f.paperId, analysisExecutionId: member.expectedExecutionId,
            analysisSha256: loaded.analysisFileSha256, completionReceiptSha256: loaded.run.completionReceipt.receiptSha256,
            sourceSnapshotSha256: loaded.run.sourceSnapshotSha256, manifestSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64), pagePath: 'content/posts/synthetic-test-only.md' } };
    };
    return { ...f, member, state, stateFile, deps, options, staged };
}

test('正常仅后处理在进程三轮耗尽后采纳真实已保存子运行，零请求且完整归档旧失败', async t => {
    const f = await completed(t), beforeBytes = fs.readFileSync(f.stateFile);
    const materials = grants.recoveryWindowMaterials(f.analysisRoot, f.member.expectedExecutionId);
    const originalItem = structuredClone(f.state.items[f.paperId]); let calls = 0;
    const dependencies = { ...f.deps, postprocess: { stagePaper: () => { calls++; return f.staged(); } } };
    const result = await migration.migrateAndRun(f.options, { dependencies });
    assert.equal(result.newApiRequests, 0); assert.equal(result.adoptedSavedChildren.length, 1);
    assert.equal(result.savedChildAdoptionFailures.length, 0); assert.equal(calls, 1);
    const state = api.assertState(JSON.parse(fs.readFileSync(f.stateFile))), item = state.items[f.paperId];
    assert.equal(item.status, 'complete'); assert.equal(item.analysisRunId, f.member.expectedExecutionId);
    assert.equal(item.attempts, originalItem.attempts); assert.equal(item.retryBudgetStart, originalItem.retryBudgetStart);
    assert.deepEqual(item.retryReleases, originalItem.retryReleases); assert.deepEqual(state.batchFailure, f.state.batchFailure);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.grant.processDirectory, item.savedChildAdoptions[0].receiptFile)));
    assert.deepEqual(receipt.previousItem, originalItem); assert.equal(receipt.previousStateSha256, f.state.stateSha256);
    const { receiptSha256, ...body } = receipt; assert.equal(receiptSha256, api.stableHash(body));
    assert.equal(item.savedChildAdoptions[0].receiptSha256, receiptSha256);
    assert.equal(grants.recoveryWindowMaterials(f.analysisRoot, f.member.expectedExecutionId).materialsSha256, materials.materialsSha256);
    assert.notDeepEqual(fs.readFileSync(f.stateFile), beforeBytes);
    const again = await migration.migrateAndRun(f.options, { dependencies });
    assert.equal(again.adoptedSavedChildren.length, 0); assert.equal(calls, 1, 'saved adoption is not repeated');
});

test('最新子稿仍 partial 时只读取，不重开恢复或调用模型', async t => {
    const f = await completed(t, { partial: true }), bytes = fs.readFileSync(f.stateFile);
    const result = await migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: { stagePaper: () => assert.fail('partial child cannot be staged or resumed') } } });
    assert.equal(result.adoptedSavedChildren.length, 0); assert.equal(result.newApiRequests, 0);
    assert.deepEqual(fs.readFileSync(f.stateFile), bytes);
});

test('默认真实科学资格拒绝合成完成稿，保留原失败和次数，不以 complete 标志放行', async t => {
    const f = await completed(t), bytes = fs.readFileSync(f.stateFile);
    const result = await migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: require('../scripts/lib/conference-postprocess') } });
    assert.equal(result.adoptedSavedChildren.length, 0); assert.equal(result.savedChildAdoptionFailures.length, 1);
    assert.equal(result.newApiRequests, 0); assert.deepEqual(fs.readFileSync(f.stateFile), bytes);
});

test('暂存页面与完成稿 SHA 不符时拒绝采纳且不改状态', async t => {
    const f = await completed(t), bytes = fs.readFileSync(f.stateFile);
    await assert.rejects(migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: { stagePaper: () => { const staged = f.staged(); staged.manifest.analysisSha256 = 'c'.repeat(64); return staged; } } } }),
    { code: 'CONFERENCE_SAVED_CHILD_ADOPTION_INTEGRITY' });
    assert.deepEqual(fs.readFileSync(f.stateFile), bytes);
});

test('页面核验期间进程变化时原 CAS 拒绝，不能覆盖并发记录或改写通过', async t => {
    const f = await completed(t);
    await assert.rejects(migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: { stagePaper: () => {
            const staged = f.staged(), state = JSON.parse(fs.readFileSync(f.stateFile));
            state.items[f.paperId].concurrentEvidence = 'must preserve'; state.generation++;
            state.stateSha256 = api.stateDigest(state); fs.writeFileSync(f.stateFile, JSON.stringify(state), { mode: 0o600 });
            return staged;
        } } } }), { code: 'CONFERENCE_SAVED_CHILD_ADOPTION_INTEGRITY' });
    const state = api.assertState(JSON.parse(fs.readFileSync(f.stateFile)));
    assert.equal(state.items[f.paperId].status, 'analysis_partial');
    assert.equal(state.items[f.paperId].concurrentEvidence, 'must preserve');
});
