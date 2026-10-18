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
    item.analysisProof.completionReceiptSha256 = f.grant.parent.run.completionReceipt.receiptSha256;
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
    const deps = { files, engine: actualEngine,
        // Synthetic scientific records do not exercise the real saved-only
        // qualification helper; its scheduling boundary is doubled below.
        adapter: { ...adapter, replaySavedConferenceReaderRevision: undefined }, loadAuthority: () => context,
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

async function ordinaryCompleted(t, { partial = false } = {}) {
    const f = await completed(t, { partial: true });
    let child = adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId });
    if (!partial) {
        adapter.replaceJson(path.join(child.directory, 'analysis.json'), { ...child.analysis, status: 'complete',
            completedAt: '2026-10-18T04:00:00.000Z' }, child.analysisFileSha256);
        adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId }));
        child = adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId });
    }
    const state = structuredClone(f.state), item = state.items[f.paperId];
    delete item.retryReleases; state.stateSha256 = api.stateDigest(state);
    fs.writeFileSync(f.stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const staged = () => {
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        const current = adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId });
        adapter.verifyPlanAuthority(current, f.planHandle, f.sourceRoot);
        return { status: 'staged', manifest: { paperId: f.paperId, analysisExecutionId: current.run.executionId,
            analysisSha256: current.analysisFileSha256, completionReceiptSha256: current.run.completionReceipt.receiptSha256,
            sourceSnapshotSha256: current.run.sourceSnapshotSha256, manifestSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64), pagePath: 'content/posts/synthetic-ordinary-test-only.md' } };
    };
    return { ...f, state, child, staged };
}

test('普通真实已保存complete子稿在outer耗尽后沿同一正常stage/锁/CAS零请求采纳，完整保留旧失败与次数', async t => {
    const f = await ordinaryCompleted(t), original = structuredClone(f.state.items[f.paperId]); let calls = 0;
    const before = sha(fs.readFileSync(path.join(f.child.directory, 'analysis.json')));
    const result = await migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: { stagePaper: () => { calls++; return f.staged(); } } } });
    assert.equal(calls, 1); assert.equal(result.adoptedSavedChildren.length, 1); assert.equal(result.newApiRequests, 0);
    const current = api.assertState(JSON.parse(fs.readFileSync(f.stateFile))), item = current.items[f.paperId];
    assert.equal(item.status, 'complete'); assert.equal(item.analysisRunId, f.failedExecutionId);
    assert.equal(item.attempts, original.attempts); assert.equal(item.retryBudgetStart, original.retryBudgetStart);
    assert.deepEqual(item.retryReleases, original.retryReleases);
    assert.equal(sha(fs.readFileSync(path.join(f.child.directory, 'analysis.json'))), before);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.grant.processDirectory, item.savedChildAdoptions[0].receiptFile)));
    assert.deepEqual(receipt.previousItem, original); assert.equal(receipt.proof.analysisRunId, f.failedExecutionId);
});

test('普通partial子稿不得采纳；真实科学资格仍拒合成complete，不用继承父稿证明通过', async t => {
    for (const partial of [true, false]) {
        const f = await ordinaryCompleted(t, { partial }), bytes = fs.readFileSync(f.stateFile);
        const result = await migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
            postprocess: partial ? { stagePaper: () => assert.fail('partial must not stage') }
                : require('../scripts/lib/conference-postprocess') } });
        assert.equal(result.adoptedSavedChildren.length, 0);
        assert.equal(result.savedChildAdoptionFailures.length, partial ? 0 : 1);
        assert.deepEqual(fs.readFileSync(f.stateFile), bytes);
    }
});

test('唯一实际partial子稿先走saved-only helper自身论文锁，只有真实保存complete后才正常stage采纳', async t => {
    for (const eligible of [false, true]) {
        const f = await ordinaryCompleted(t, { partial: true }), before = fs.readFileSync(f.stateFile);
        let replayed = 0, staged = 0;
        const progress = structuredClone(f.child.analysis.readerRevisionProgress);
        const deps = { ...f.deps, adapter: { ...f.deps.adapter,
            replaySavedConferenceReaderRevision: async input => {
                replayed++; assert.equal(input.executionId, f.failedExecutionId);
                assert.equal(input.planHandle, f.planHandle); assert.equal(input.sourceRoot, f.sourceRoot);
                return actualEngine.withPaperAnalysisLock({ id: f.paperId }, () => {
                    assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
                    if (!eligible) return { status: 'partial' };
                    const current = adapter.loadConferenceReaderRevision(input);
                    adapter.replaceJson(path.join(current.directory, 'analysis.json'), { ...current.analysis, status: 'complete',
                        completedAt: '2026-10-18T04:00:00.000Z' }, current.analysisFileSha256);
                    adapter.sealCompletedRun(adapter.loadConferenceAnalysis(input));
                    return { status: 'complete' };
                });
            } }, postprocess: { stagePaper: () => { staged++; return f.staged(); } } };
        const result = await migration.migrateAndRun(f.options, { dependencies: deps });
        assert.equal(replayed, 1); assert.equal(staged, eligible ? 1 : 0);
        assert.equal(result.adoptedSavedChildren.length, eligible ? 1 : 0);
        if (!eligible) assert.deepEqual(fs.readFileSync(f.stateFile), before);
        const current = adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: f.failedExecutionId });
        assert.deepEqual(current.analysis.readerRevisionProgress, progress);
    }
});

test('普通complete子稿错parent/CAS、正常stage后物理变化均拒绝采纳，不覆盖原process', async t => {
    for (const mode of ['parent', 'parentCAS', 'afterStage']) {
        const f = await ordinaryCompleted(t), stateBytes = fs.readFileSync(f.stateFile);
        if (mode !== 'afterStage') {
            const file = path.join(f.child.directory, 'reader-revision.json'), value = JSON.parse(fs.readFileSync(file));
            value[mode === 'parent' ? 'parentExecutionId' : 'parentAnalysisFileSha256'] = mode === 'parent'
                ? '11111111-1111-4111-8111-111111111111' : 'c'.repeat(64);
            delete value.revisionSha256; value.revisionSha256 = api.stableHash(value);
            fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        }
        await assert.rejects(migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
            postprocess: { stagePaper: () => {
                const staged = f.staged();
                if (mode === 'afterStage') fs.appendFileSync(path.join(f.child.directory, 'analysis.json'), ' ');
                return staged;
            } } } }));
        assert.deepEqual(fs.readFileSync(f.stateFile), stateBytes);
    }
});

test('worker页面交接重读实际文件，错成员/词表/页面/assets/canonical SHA均拒绝', async t => {
    // Transport/CAS fixture only; these synthetic bytes never claim scientific
    // qualification (the separate real gate rejection test above remains).
    const f = await ordinaryCompleted(t), pool = require('../scripts/lib/conference-complete-stage-pool');
    const parent = f.child.parent, item = f.state.items[f.paperId];
    const root = path.join(f.root, 'handoff-staging'), registry = '1'.repeat(64), projection = '2'.repeat(64);
    const directory = path.join(root, item.analysisRunId, registry, projection); fs.mkdirSync(directory, { recursive: true });
    const page = Buffer.from('explicit synthetic transport page\n'), assignment = Buffer.from('{}\n');
    const asset = Buffer.from('synthetic asset'), assetPath = 'static/data/test.json';
    const body = { contract: 'conference-paper-page-staging-v2', version: 2, status: 'complete',
        paperId: item.paperId, analysisExecutionId: item.analysisRunId,
        analysisSha256: parent.analysisFileSha256, completionReceiptSha256: parent.run.completionReceipt.receiptSha256,
        sourceSnapshotSha256: parent.run.sourceSnapshotSha256, tagMetadata: { registrySha256: registry },
        implementation: { implementationSha256: projection }, contentSha256: sha(page), tagAssignmentFileSha256: sha(assignment),
        assets: [{ path: assetPath, sha256: sha(asset), size: asset.length }] };
    const manifest = { ...body, manifestSha256: api.stableHash(body) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    assert.notDeepEqual(manifestBytes, api.canonicalBytes(manifest), 'transport fixture must preserve real stage key order');
    for (const [file, bytes] of [['manifest.json', manifestBytes], ['page.md', page],
        ['assignment.json', assignment], ['assets/' + assetPath, asset]]) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), bytes, { mode: 0o600 });
    }
    const result = { status: 'staged', manifest, pins: { analysis: parent.analysisFileSha256,
        run: parent.runFileSha256, source: parent.sourceFileSha256, extra: {} } };
    const init = { stagingRoot: root, registrySha256: registry, projectionSha256: projection };
    assert.equal(pool.verifyStageResult(result, item, init, f.deps.files), manifest);
    for (const field of ['paperId', 'analysisSha256', 'sourceSnapshotSha256', 'completionReceiptSha256']) {
        const changed = structuredClone(result); changed.manifest[field] = 'wrong';
        assert.throws(() => pool.verifyStageResult(changed, item, init, f.deps.files), { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
    }
    assert.throws(() => pool.verifyStageResult(result, item, { ...init, registrySha256: '3'.repeat(64) }, f.deps.files), /清单/);
    for (const name of ['page.md', 'assets/' + assetPath]) {
        const file = path.join(directory, name), original = fs.readFileSync(file); fs.appendFileSync(file, 'changed');
        assert.throws(() => pool.verifyStageResult(result, item, init, f.deps.files), { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
        fs.writeFileSync(file, original);
    }
    const bad = structuredClone(result); bad.pins.source = '4'.repeat(64);
    assert.throws(() => pool.verifyStageResult(bad, item, init, f.deps.files), /完整包/);
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

test('已采纳真实完成grant子稿后来页面失败时作为当前维护父稿，不能回退祖父或再次采纳', async t => {
    const f = await completed(t);
    await migration.migrateAndRun(f.options, { dependencies: { ...f.deps, postprocess: { stagePaper: f.staged } } });
    const state = JSON.parse(fs.readFileSync(f.stateFile)), item = state.items[f.paperId];
    item.status = 'analysis_partial'; item.readerRefreshRequired = true;
    item.lastFailure = { code: 'CONFERENCE_POSTPROCESS_INTEGRITY', retryable: false };
    item.lastError = 'new page quality check rejected current completed child';
    state.status = 'partial'; state.generation++; state.stateSha256 = api.stateDigest(state);
    fs.writeFileSync(f.stateFile, JSON.stringify(state), { mode: 0o600 });
    const before = fs.readFileSync(f.stateFile);
    const result = await migration.migrateAndRun(f.options, { dependencies: { ...f.deps,
        postprocess: { stagePaper: () => assert.fail('new page failure cannot re-adopt its old complete parent') } } });
    assert.equal(result.adoptedSavedChildren.length, 0); assert.deepEqual(fs.readFileSync(f.stateFile), before);
    for (const field of ['analysisSha256', 'completionReceiptSha256', 'sourceSnapshotSha256']) {
        const bad = structuredClone(state); bad.items[f.paperId].analysisProof[field] = 'f'.repeat(64);
        bad.stateSha256 = api.stateDigest(bad); fs.writeFileSync(f.stateFile, JSON.stringify(bad), { mode: 0o600 });
        await assert.rejects(migration.migrateAndRun(f.options, { dependencies: f.deps }),
            { code: 'CONFERENCE_SAVED_CHILD_ADOPTION_INTEGRITY' });
    }
});

test('混合失败集合按真实最后grant续原窗口，新普通维护走当前父稿，旧次数不重置', async t => {
    const f = await completed(t, { partial: true }), hash = api.stableHash;
    const state = structuredClone(f.state), old = state.items[f.paperId];
    old.attempts = old.retryBudgetStart + 1; old.retryAuthorizedAtAttempt = old.attempts;
    const newId = 'conference:odyssey:2026:conference-paper-id:new.quality';
    const parentId = api.deterministicUuid(state.processId, newId, 'analysis');
    const fresh = { paperId: newId, sourceIdentity: {}, analysisRunId: parentId, status: 'analysis_partial',
        readerRefreshRequired: true, attempts: 5, updatedAt: state.updatedAt,
        sourceProof: { textSha256: hash('new text') },
        analysisProof: { analysisSha256: hash('new complete parent'), sourceSnapshotSha256: hash('new source snapshot') },
        pageProof: null, lastError: 'new page quality failure', lastFailure: { retryable: false } };
    state.items[newId] = fresh; state.stateSha256 = api.stateDigest(state); api.assertState(state);
    fs.writeFileSync(f.stateFile, JSON.stringify(state), { mode: 0o600 });
    const originalRelease = structuredClone(old.retryReleases), calls = [];
    const context = { authority: state.authority, members: Object.keys(state.items).map(paperId => ({ paperId })), files: f.deps.files };
    const childId = adapter.readerRevisionExecutionId(parentId, fresh.analysisProof.analysisSha256);
    // Only the advisory legacy-path lookup is doubled as absent. The real
    // registered source chain remains intact and must still be authenticated.
    const originalLegacyId = adapter.readerRevisionExecutionId;
    adapter.readerRevisionExecutionId = (executionId, analysisSha256) => executionId === f.parentExecutionId
        ? api.deterministicUuid('absent advisory legacy path', executionId, analysisSha256)
        : originalLegacyId(executionId, analysisSha256);
    t.after(() => { adapter.readerRevisionExecutionId = originalLegacyId; });
    const revisionBody = { contract: adapter.READER_REVISION_CONTRACT, version: 1, executionId: childId,
        parentExecutionId: parentId, parentAnalysisFileSha256: fresh.analysisProof.analysisSha256,
        parentRunFileSha256: hash('new parent run'), paperId: newId, sourceSnapshotSha256: fresh.analysisProof.sourceSnapshotSha256,
        seededAnalysisSha256: hash('new seed'), mode: 'reader-only', maxAttempts: 3 };
    const revision = { ...revisionBody, revisionSha256: hash(revisionBody) };
    const dependencies = { ...f.deps, maxRounds: 1, loadAuthority: () => context,
        implementationSha256: () => state.authority.implementationSha256,
        deepExecutionConfigIdentity: () => state.authority.deepExecutionConfig,
        prepareShared: async () => ({ planHandle: f.planHandle, sourceCacheRoot: f.sourceRoot,
            sealed: Object.values(state.items).map(item => ({ paperId: item.paperId, proof: item.sourceProof })) }),
        adapter: { ...adapter,
            loadConferenceAnalysis: input => input.executionId === parentId
                ? { analysisFileSha256: fresh.analysisProof.analysisSha256 }
                : adapter.loadConferenceAnalysis(input),
            verifyPlanAuthority: () => {},
            refreshConferenceGrantedRecovery: async input => {
                assert.equal(input.parentExecutionId, f.parentExecutionId);
                assert.equal(input.failedExecutionId, f.failedExecutionId);
                assert.equal(grants.readRecoveryGrantMember(input.grantHandle, f.paperId).expectedExecutionId, f.member.expectedExecutionId);
                calls.push('original registered grant');
                throw Object.assign(Error('original child window still fails'),
                    { code: 'CONFERENCE_READER_REVISION_BUDGET_EXHAUSTED', retryable: false });
            },
            refreshConferenceReader: async input => {
                assert.equal(input.parentExecutionId, parentId, 'never route the registered failed member to oldest legacy child');
                calls.push('new ordinary current parent');
                return { executionId: childId, revision, analysisSha256: hash('newly revised content') };
            } },
        postprocess: { stagePaper: input => {
            if (input.executionId === parentId) throw Object.assign(Error('current parent page needs a new Reader'),
                { code: 'CONFERENCE_POSTPROCESS_INTEGRITY', retryable: false });
            assert.equal(input.executionId, childId);
            return { status: 'staged', manifest: { manifestSha256: hash('new page manifest'),
                contentSha256: hash('new page content'), pagePath: 'content/posts/new-quality.md',
                completionReceiptSha256: hash('new completion'), sourceSnapshotSha256: fresh.analysisProof.sourceSnapshotSha256 } };
        } } };
    const result = await migration.migrateAndRun({ ...f.options, postprocessOnly: false, retryFailed: true }, { dependencies });
    assert.equal(result.status, 'partial');
    assert.deepEqual(calls, ['original registered grant', 'new ordinary current parent']);
    const after = api.assertState(JSON.parse(fs.readFileSync(f.stateFile)));
    assert.deepEqual(after.items[f.paperId].retryReleases, originalRelease);
    assert.equal(after.items[f.paperId].retryBudgetStart, old.retryBudgetStart);
    assert.equal(after.items[f.paperId].attempts, old.attempts + 1);
    assert.equal(after.items[newId].status, 'complete'); assert.equal(after.items[newId].analysisRunId, childId);
});

test('调度器不接受裸JSON伪造已登记窗口来保留或更改费用权限', async t => {
    const f = await completed(t, { partial: true }), bytes = fs.readFileSync(f.stateFile);
    await assert.rejects(api.runConferenceProcess({ apply: true, concurrency: 1, retryFailed: true }, {
        ...f.deps, implementationSha256: () => f.state.authority.implementationSha256,
        deepExecutionConfigIdentity: () => f.state.authority.deepExecutionConfig,
        resolveExistingRecoveryGrant: () => ({ grantId: f.member.grantId, grantSha256: f.member.grantSha256 })
    }), /真实已登记的追加许可能力/);
    assert.deepEqual(fs.readFileSync(f.stateFile), bytes);
});
