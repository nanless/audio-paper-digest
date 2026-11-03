'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = process.cwd(), adapter=require(path.join(root,'scripts/lib/conference-analysis-adapter.js'));
const { productionPlanFixture } = require(path.join(root, 'tests/helpers/conference-production-plan-fixture.js'));
const parentId = '77777777-7777-4777-8777-777777777777';
const codec = require('../scripts/lib/protocol-codec');
function setup(t, { header = codec.recordHeader('conference-reader-source-revision', 'conference-reader-source-revision'), mode = 'reader-only' } = {}) {
    const f = productionPlanFixture(t), analysisRoot = path.join(f.root, 'identity-only');
    const options = { analysisRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, paperId: f.paperId };
    adapter.prepareConferenceAnalysis({ ...options, executionId: parentId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId });
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-19T00:00:00.000Z' }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId });
    const executionId = adapter.readerRevisionExecutionId(parentId, parent.analysisFileSha256, header);
    adapter.prepareConferenceAnalysis({ ...options, executionId });
    const query = { analysisRoot, executionId }, child = adapter.loadConferenceAnalysis(query);
    const body = { ...header, mode, maxAttempts: 3,
        executionId, paperId: f.paperId, parentExecutionId: parentId,
        parentAnalysisFileSha256: parent.analysisFileSha256, parentRunFileSha256: parent.runFileSha256,
        sourceSnapshotSha256: child.run.sourceSnapshotSha256, resourcePreflightFileSha256: 'a'.repeat(64) };
    const filename = path.join(child.directory, 'reader-revision.json');
    const save = (value, seal = true) => fs.writeFileSync(filename, JSON.stringify(seal
        ? { ...value, revisionSha256: adapter.stableHash(value) } : value), { mode: 0o600 });
    save(body); return { query, child, parent, body, filename, save, options };
}
test('纯身份只核真实封存parent/child与revision，不授资源或反馈资格；full仍拒缺失预检', t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    const loaded = adapter.loadConferenceReaderRevisionIdentity(f.query);
    assert.equal(loaded.parent.analysisFileSha256, f.parent.analysisFileSha256);
    assert.equal(loaded.revisionFileSha256, adapter.readJsonRecord(f.filename).sha256);
    assert.equal(loaded.resourcePreflight, undefined); assert.equal(loaded.readerReview, undefined);
    assert.throws(() => adapter.loadConferenceReaderRevision(f.query), /ENOENT|preflight|资源/);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});
test('旧普通revision的mode、预算、selfSHA、父CAS和同源错误全部严格拒绝', t => {
    const f = setup(t);
    for (const changes of [{ mode: 'skip' }, { maxAttempts: 0 }, { maxAttempts: 4 },
        { parentAnalysisFileSha256: 'a'.repeat(64) }, { parentRunFileSha256: 'a'.repeat(64) },
        { sourceSnapshotSha256: 'a'.repeat(64) }, { paperId: 'wrong' }]) {
        f.save({ ...f.body, ...changes });
        assert.throws(() => adapter.loadConferenceReaderRevisionIdentity(f.query), /身份|来源|原凭证/);
    }
    f.save({ ...f.body, revisionSha256: 'b'.repeat(64) }, false);
    assert.throws(() => adapter.loadConferenceReaderRevisionIdentity(f.query), /身份/);
    f.save(f.body);
    const sourceFile = path.join(f.parent.directory, 'source.json'), bytes = fs.readFileSync(sourceFile);
    const value = JSON.parse(bytes); value.sourceDetails.text += 'tampered';
    fs.writeFileSync(sourceFile, JSON.stringify(value));
    assert.throws(() => adapter.loadConferenceReaderRevisionIdentity(f.query), /drifted/);
    fs.writeFileSync(sourceFile, bytes);
});
test('纯身份明确拒绝新增grant权限，full仍保留原grant认证分支', t => {
    const f = setup(t); f.save({ ...f.body, ...codec.recordHeader('conference-reader-recovery-window', 'conference-reader-recovery-window') });
    assert.throws(() => adapter.loadConferenceReaderRevisionIdentity(f.query), /complete conference revision loader/);
    assert.throws(() => adapter.loadConferenceReaderRevision(f.query), /新增会议恢复窗口身份/);
});

test('登记格式子运行的选择只重放真实文件，保留旧域且拒坏材料、未签旧准备态和双重身份', t => {
    const f = setup(t, { header: codec.historicalHeader('conference-reader-source-revision', 'authenticated-reader-child'), mode: 'normal-analysis' });
    const select = () => adapter.resolveReaderRevisionExecutionId({ ...f.options, parentExecutionId: parentId,
        parentAnalysisFileSha256: f.parent.analysisFileSha256 });
    const original = fs.readFileSync(f.filename);
    assert.equal(select(), f.query.executionId);
    assert.deepEqual(fs.readFileSync(f.filename), original);
    assert.notEqual(f.query.executionId, adapter.readerRevisionExecutionId(parentId, f.parent.analysisFileSha256));
    f.save({ ...f.body, parentRunFileSha256: 'f'.repeat(64) });
    assert.throws(select, /原完成稿|原凭证/);
    fs.writeFileSync(f.filename, original);
    fs.unlinkSync(f.filename);
    assert.throws(select, /缺少原不可变修订记录/);
    fs.writeFileSync(f.filename, original);
    const currentId = adapter.readerRevisionExecutionId(parentId, f.parent.analysisFileSha256);
    adapter.prepareConferenceAnalysis({ ...f.options, executionId: currentId });
    const { contract: ignoredContract, version: ignoredVersion, ...fields } = f.body;
    const body = { ...fields, ...codec.recordHeader('conference-reader-source-revision', 'conference-reader-source-revision'), executionId: currentId };
    fs.writeFileSync(path.join(f.options.analysisRoot, currentId, 'reader-revision.json'),
        JSON.stringify({ ...body, revisionSha256: adapter.stableHash(body) }), { mode: 0o600 });
    assert.throws(select, /多个登记格式/);
});

test('完整loader仍逐次进入原反馈准入，纯身份不会冒充反馈通过', t => {
    const f = setup(t); f.save({ ...f.body, readerReviewMaintenance: { contract: 'synthetic-feedback-marker' } });
    const maintenance = require(path.join(root, 'scripts/lib/conference-reader-review-maintenance.js'));
    let calls = 0; const rejected = new Error('strict feedback replay required');
    const original = maintenance.replayRevisionFeedback;
    maintenance.replayRevisionFeedback = () => { calls++; throw rejected; };
    t.after(() => { maintenance.replayRevisionFeedback = original; });
    adapter.loadConferenceReaderRevisionIdentity(f.query); assert.equal(calls, 0);
    assert.throws(() => adapter.loadConferenceReaderRevision(f.query), error => error === rejected);
    assert.equal(calls, 1);
});
