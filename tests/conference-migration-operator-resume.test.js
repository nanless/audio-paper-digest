'use strict';
// Scheduling boundary only: real local source/grant/state and locks; the
// successful local edit and scientific page gates below are explicit doubles.
// Real saved-receipt/whole-batch authentication is tested by the operator suite.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./helpers/conference-reader-operator-fixture');
const processApi = require('../scripts/lib/conference-process');
const engine = require('../scripts/analysis-engine');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const corrections = require('../scripts/lib/conference-reader-operator-correction');
const grants = require('../scripts/lib/conference-recovery-grant');
const apply = require('../scripts/lib/conference-reader-operator-apply');
const migration = require('../scripts/migrate-conference-process');
const stop = require('../scripts/lib/analysis-stop-control');
const deny = () => { throw Error('offline operator migration test forbids network'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http','node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;

async function setup(t, { changed = true } = {}) {
    const f = await fixture(t, { historical: true });
    const directory = f.registered.processDirectory, stateFile = path.join(directory, 'state.json');
    const before = fs.readFileSync(stateFile), manifestBefore = fs.readFileSync(f.manifestPath);
    const materialsBefore = grants.recoveryWindowMaterials(f.options.analysisRoot, f.loaded.run.executionId);
    const context = { authority: { ...f.state.authority,
        implementationSha256: changed ? 'c'.repeat(64) : f.state.authority.implementationSha256 },
        members: [{ paperId: f.paperId }] };
    const files = { conferenceAnalysisDir: f.options.analysisRoot,
        conferenceProcessDir: path.dirname(directory), conferencePageStagingDir: path.join(f.root, 'staging'),
        tagCatalogFile: path.join(f.root, 'synthetic-tags.json') };
    const events = [];
    const deps = { files, engine, adapter, loadAuthority: () => context,
        implementationSha256: () => context.authority.implementationSha256,
        prepareShared: async () => ({ planHandle: f.planHandle, sourceCacheRoot: f.sourceRoot,
            sealed: [{ paperId: f.paperId, proof: f.state.items[f.paperId].sourceProof }] }),
        now: () => '2026-10-18T07:00:00.000Z',
        aggregate: () => assert.fail('postprocess-only cannot aggregate'),
        processPaper: () => assert.fail('local continuation cannot enter paid dispatch'),
        postprocess: { stagePaper: () => {
            events.push('normal-current-implementation-stage');
            assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
            const actual = JSON.parse(fs.readFileSync(stateFile));
            assert.equal(actual.authority.implementationSha256, f.state.authority.implementationSha256,
                'normal stage precedes implementation authority CAS');
            assert.equal(actual.items[f.paperId].status, 'complete');
            return { status: 'staged', manifest: { manifestSha256: 'd'.repeat(64),
                contentSha256: 'e'.repeat(64), pagePath: 'content/posts/synthetic-orchestration-only.md' } };
        } } };
    const options = { apply: true, fromProcessId: f.state.processId, concurrency: 1,
        postprocessOnly: true, retryFailed: true,
        recoveryManifest: f.registered.manifestPath, readerCorrections: f.manifestPath };
    const installApplyDouble = () => t.mock.method(apply, 'applyAndStageBatch', async input => {
        events.push('resume-same-batch');
        assert.deepEqual(fs.readFileSync(stateFile), before, 'original failed-state CAS is not migrated first');
        assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore, 'installed batch is immutable');
        assert.equal(input.manifestPath, f.manifestPath);
        const next = structuredClone(input.state), item = next.items[f.paperId];
        // Synthetic adoption is only an orchestration double. No normal Reader
        // or publication qualification is being asserted by this test record.
        Object.assign(item, { status: 'complete', readerRefreshRequired: false,
            analysisProof: { ...item.analysisProof, completionReceiptSha256: 'f'.repeat(64) },
            pageProof: { manifestSha256: '1'.repeat(64), contentSha256: '2'.repeat(64),
                pagePath: 'content/posts/synthetic-orchestration-only.md' } });
        next.status = 'running'; next.generation++; next.stateSha256 = processApi.stateDigest(next);
        processApi.assertState(next);
        fs.writeFileSync(stateFile, JSON.stringify(next, null, 2)+'\n', { mode: 0o600 });
        return next;
    });
    return { ...f, analysisRoot: f.options.analysisRoot, directory, stateFile, before, manifestBefore,
        materialsBefore, context, events, deps, options, installApplyDouble };
}

test('实现改变但无真实已保存中断成员的新人工批次拒绝，原state/manifest与付费材料不变', async t => {
    const f = await setup(t);
    t.mock.method(apply, 'applyAndStageBatch', () => assert.fail('fresh partial batch cannot be applied before migration'));
    await assert.rejects(migration.migrateAndRun(f.options, { dependencies: f.deps }),
        { code: 'CONFERENCE_READER_OPERATOR_INTEGRITY' });
    assert.deepEqual(fs.readFileSync(f.stateFile), f.before);
    assert.deepEqual(fs.readFileSync(f.manifestPath), f.manifestBefore);
    assert.deepEqual(grants.recoveryWindowMaterials(f.analysisRoot, f.loaded.run.executionId), f.materialsBefore);
    assert.deepEqual(f.events, []);
});

test('真实断点断言通过才续原清单，随后仍执行全部当前实现后处理及authority CAS', async t => {
    const f = await setup(t);
    // Authentication itself is an explicit double here; its real receipt,
    // source/state corruption negatives belong to the operator receipt suite.
    t.mock.method(corrections, 'assertResumableCorrectionBatch', options => {
        f.events.push('authenticate-saved-interruption');
        assert.deepEqual(options, { manifestPath: f.manifestPath, processDirectory: f.directory,
            analysisRoot: f.analysisRoot, grantHandle: options.grantHandle });
        assert.ok(options.grantHandle);
        assert.deepEqual(fs.readFileSync(f.stateFile), f.before);
        return true;
    });
    f.installApplyDouble();
    const result = await migration.migrateAndRun(f.options, { dependencies: f.deps });
    assert.deepEqual(f.events, ['authenticate-saved-interruption','resume-same-batch','normal-current-implementation-stage']);
    assert.equal(result.status, 'postprocessed_only'); assert.equal(result.checkedComplete, 1);
    assert.equal(result.stagedComplete, 1); assert.equal(result.stageFailed, 0); assert.equal(result.newApiRequests, 0);
    const after = processApi.assertState(JSON.parse(fs.readFileSync(f.stateFile)));
    assert.equal(after.authority.implementationSha256, f.context.authority.implementationSha256);
    assert.equal(after.items[f.paperId].pageProof.manifestSha256, 'd'.repeat(64));
    assert.deepEqual(fs.readFileSync(f.manifestPath), f.manifestBefore);
    assert.deepEqual(grants.recoveryWindowMaterials(f.analysisRoot, f.loaded.run.executionId), f.materialsBefore);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, 'implementation-migration.json')));
    assert.equal(receipt.toImplementationSha256, f.context.authority.implementationSha256);
});

for (const boundary of ['source','state','receipt']) test(`断点${boundary}认证拒绝不能被迁移入口忽略或提前改state`, async t => {
    const f = await setup(t);
    t.mock.method(corrections, 'assertResumableCorrectionBatch', () => { throw Error('synthetic '+boundary+' integrity failure'); });
    t.mock.method(apply, 'applyAndStageBatch', () => assert.fail('failed authentication cannot enter edit'));
    await assert.rejects(migration.migrateAndRun(f.options, { dependencies: f.deps }), new RegExp(boundary+' integrity'));
    assert.deepEqual(fs.readFileSync(f.stateFile), f.before); assert.deepEqual(f.events, []);
});

test('实现未改变时仍沿原批次通路，不增加断点要求或重跑全会后处理', async t => {
    const f = await setup(t, { changed: false });
    t.mock.method(corrections, 'assertResumableCorrectionBatch', () => assert.fail('unchanged implementation needs no interrupted-batch exception'));
    f.installApplyDouble();
    const result = await migration.migrateAndRun(f.options, { dependencies: f.deps });
    assert.deepEqual(f.events, ['resume-same-batch']); assert.equal(result.checkedComplete, 0);
    assert.equal(result.newApiRequests, 0); assert.deepEqual(fs.readFileSync(f.manifestPath), f.manifestBefore);
});

test('缺少原恢复许可时不能以中断断言绕过原准入', async t => {
    const f = await setup(t);
    t.mock.method(corrections, 'assertResumableCorrectionBatch', () => assert.fail('grant is mandatory before resume authentication'));
    t.mock.method(apply, 'applyAndStageBatch', () => assert.fail('no grant cannot enter edit'));
    await assert.rejects(migration.migrateAndRun({ ...f.options, recoveryManifest: undefined }, { dependencies: f.deps }), /同一原许可/);
    assert.deepEqual(fs.readFileSync(f.stateFile), f.before);
});

test('续完原批次后全会当前实现复验失败不能提前迁移authority或签成功', async t => {
    const f = await setup(t);
    t.mock.method(corrections, 'assertResumableCorrectionBatch', () => true);
    f.installApplyDouble();
    const failure = Object.assign(Error('synthetic real-gate rejection after local continuation'), { scope: 'paper', retryable: false });
    const deps = { ...f.deps, postprocess: { stagePaper: () => { throw failure; } } };
    const result = await migration.migrateAndRun({ ...f.options, retryFailed: false }, { dependencies: deps });
    assert.equal(result.status, 'partial'); assert.equal(result.failed, 1);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(f.stateFile)));
    assert.equal(state.authority.implementationSha256, f.state.authority.implementationSha256);
    assert.equal(fs.existsSync(path.join(f.directory, 'implementation-migration.json')), false);
    assert.deepEqual(fs.readFileSync(f.manifestPath), f.manifestBefore);
});
