'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const grants = require('../scripts/lib/conference-recovery-grant');
const deep = require('../scripts/deep-analyzer');
const processApi = require('../scripts/lib/conference-process');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const { recoveryFixtureIdentity, registerRecoveryFixture } = require('./helpers/conference-recovery-grant-fixture');

async function originalFailure(t) {
    const fixture = productionPlanFixture(t);
    const analysisRoot = path.join(fixture.root, 'data/runtime/conference-analysis-executions');
    const { parentExecutionId } = recoveryFixtureIdentity(fixture.paperId);
    const input = { analysisRoot, parentExecutionId, planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot };
    adapter.prepareConferenceAnalysis({ ...input, executionId: parentExecutionId, paperId: fixture.paperId });
    const initial = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    const paper = { ...initial.analysis.papers[0], analysis: 'synthetic unchanged parent core', apiReaderArticle: 'old Reader',
        analysisManifest: { sourceAcquisition: { modelTextSanitizationContract: 'model-text-unicode-scalars-v1' },
            stages: { primaryAnalysis: { status: 'complete' }, coreSummaryRepair: { status: 'complete' },
                scoringAudit: { status: 'complete' }, apiReaderArticle: { status: 'complete' } } } };
    adapter.replaceJson(path.join(initial.directory, 'analysis.json'), { ...initial.analysis, status: 'complete',
        completedAt: '2026-10-17T00:00:00.000Z', papers: [paper] }, initial.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId }));
    const parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    const post = require('../scripts/lib/conference-postprocess'), prior = post.readOriginalTagProof;
    post.readOriginalTagProof = () => ({ rules: {} }); t.after(() => { post.readOriginalTagProof = prior; });
    await assert.rejects(adapter.refreshConferenceReader(input, {
        engine: { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: Symbol('fixture'),
            withPaperAnalysisLock: async (_p, callback) => callback(),
            getConferenceReaderRefreshUpstreamReason: () => null,
            isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => false },
        deep: { buildApiReaderResourceIdentity: deep.buildApiReaderResourceIdentity,
            refreshApiReaderArticleFromSource: async () => { throw Error('synthetic original failure'); } }
    }), /synthetic original failure/);
    const failedExecutionId = adapter.readerRevisionExecutionId(parentExecutionId, parent.analysisFileSha256);
    const registered = registerRecoveryFixture({ analysisRoot, parentExecutionId, failedExecutionId,
        paperId: fixture.paperId, install: false });
    return { ...fixture, ...registered, analysisRoot, parentExecutionId, failedExecutionId };
}

test('追加许可只由完整原失败集显式登记，真实品牌冷恢复与旧记录CAS连续', async t => {
    const f = await originalFailure(t);
    assert.throws(() => grants.readRecoveryGrantMember(f.manifest, f.paperId), /真实已登记/);
    assert.throws(() => grants.openRecoveryGrant(f.options));
    const handle = grants.openRecoveryGrant({ ...f.options, install: true });
    const member = grants.readRecoveryGrantMember(handle, f.paperId);
    assert.equal(member.expectedExecutionId, grants.grantedRecoveryExecutionId(f.manifest.grantId,
        f.failedExecutionId, f.failed.analysisFileSha256));
    assert.equal(member.sourceSha256, f.member.sourceTextSha256);
    assert.equal(member.parentAnalysisFileSha256, f.parent.analysisFileSha256);
    assert.equal(member.failedAnalysisFileSha256, f.failed.analysisFileSha256);
    assert.throws(() => grants.readRecoveryGrantMember(handle, f.paperId + '-other'), /不在/);
    const record = { contract: 'conference-reader-recovery-window-v1', version: 1,
        grantId: member.grantId, grantSha256: member.grantSha256, paperId: f.paperId,
        originalMemberPaperId: f.paperId, executionId: member.expectedExecutionId,
        failedExecutionId: f.failedExecutionId, failedAnalysisFileSha256: member.failedAnalysisFileSha256,
        sourceSnapshotSha256: member.sourceSnapshotSha256 };
    const cold = grants.reopenRecoveryGrantForWindow({ analysisRoot: f.analysisRoot, windowRecord: record });
    assert.equal(grants.readRecoveryGrantMember(cold, f.paperId).expectedExecutionId, member.expectedExecutionId);
    for (const key of ['failedAnalysisFileSha256', 'sourceSnapshotSha256', 'grantSha256']) {
        assert.throws(() => grants.reopenRecoveryGrantForWindow({ analysisRoot: f.analysisRoot,
            windowRecord: { ...record, [key]: 'f'.repeat(64) } }));
    }
    const filename = path.join(f.analysisRoot, f.failedExecutionId, 'analysis.json');
    const original = fs.readFileSync(filename);
    const value = JSON.parse(original); value.fixtureTamper = true;
    fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
    assert.throws(member.assertUnchanged, /已变化/);
    fs.writeFileSync(filename, original, { mode: 0o600 });
    member.assertUnchanged();
    assert.equal(grants.openRecoveryGrant({ ...f.options, install: true }) !== null, true);
    assert.deepEqual(fs.readFileSync(filename), original);
});

test('清单改成员、增额度、缺明确授权或越界CAS在登记前即拒绝', async t => {
    const f = await originalFailure(t);
    const original = structuredClone(f.manifest);
    const change = mutate => {
        const value = structuredClone(original); mutate(value);
        delete value.manifestSha256; value.manifestSha256 = processApi.stableHash(value);
        fs.writeFileSync(f.manifestPath, JSON.stringify(value), { mode: 0o600 });
        assert.throws(() => grants.openRecoveryGrant({ ...f.options, install: true }));
    };
    change(x => { x.members = []; });
    change(x => { x.members.push(structuredClone(x.members[0])); });
    change(x => { x.limits.readerContentResponses = 18; });
    change(x => { x.limits.readerFullResponses = 6; });
    change(x => { x.approval = { kind: 'caller-json' }; });
    change(x => { x.members[0].sourceTextSha256 = 'f'.repeat(64); });
    change(x => { x.members[0].recordCAS['../../.env'] = 'f'.repeat(64); });
    const grantDirectory = path.join(path.dirname(f.analysisRoot), 'conference-recovery-grants', original.grantId);
    assert.equal(fs.existsSync(path.join(grantDirectory, 'registration.json')), false);
});

test('已登记许可原位改写并恢复mtime后缓存仍拒绝', async t => {
    const f = await originalFailure(t);
    const handle = grants.openRecoveryGrant({ ...f.options, install: true });
    const member = grants.readRecoveryGrantMember(handle, f.paperId);
    const registration = path.join(path.dirname(f.analysisRoot), 'conference-recovery-grants', f.manifest.grantId, 'registration.json');
    const bytes = fs.readFileSync(registration);
    const savedStat = fs.statSync(registration);
    fs.writeFileSync(registration, bytes); fs.utimesSync(registration, savedStat.atime, savedStat.mtime);
    assert.throws(member.assertUnchanged, /已变化/);
    assert.throws(() => grants.resolveRegisteredRecoveryGrant(member.grantId, member.grantSha256,
        { analysisRoot: f.analysisRoot }), /已变化/);
});
