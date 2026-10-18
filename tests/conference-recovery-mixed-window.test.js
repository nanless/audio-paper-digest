'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
// Actual temporary plan/PDF/source/registered-window chains; scientific and
// model outcomes below are explicit offline orchestration doubles only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const grants = require('../scripts/lib/conference-recovery-grant');
const api = require('../scripts/lib/conference-process');
const budget = require('../scripts/lib/conference-reader-recovery-window');
const { fixture } = require('./helpers/conference-recovery-continuation-fixture');
const deny = () => { throw Error('Mixed-window fixture forbids network'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
require('node:http2').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function saveState(f, state) {
    state.stateSha256 = api.stateDigest(state); api.assertState(state);
    write(path.join(f.grant.processDirectory, 'state.json'), state);
}
function member(f, parentId, childId) {
    const child = adapter.loadConferenceReaderRevision({ analysisRoot: f.analysisRoot, executionId: childId });
    const recordCAS = {};
    for (const id of [parentId, childId]) {
        const folder = path.join(f.analysisRoot, id);
        for (const name of ['analysis.json', 'run.json', 'source.json', 'reader-revision.json', 'reader-resource-preflight.json']) {
            const file = path.join(folder, name);
            if (fs.existsSync(file)) recordCAS[path.relative(f.grant.repositoryRoot, file).split(path.sep).join('/')] = sha(fs.readFileSync(file));
        }
        const attempts = path.join(folder, 'reader-attempts');
        if (fs.existsSync(attempts)) for (const name of fs.readdirSync(attempts).filter(n => /^[a-f0-9]{64}\.json$/u.test(n))) {
            const file = path.join(attempts, name);
            recordCAS[path.relative(f.grant.repositoryRoot, file).split(path.sep).join('/')] = sha(fs.readFileSync(file));
        }
    }
    return { paperId: child.run.paperId, parentExecutionId: parentId, childExecutionId: childId,
        sourceTextSha256: sha(child.source.sourceDetails.text), sourceSnapshotSha256: child.run.sourceSnapshotSha256, recordCAS };
}
function initial(f, parentId, childId) {
    return { ...member(f, parentId, childId), continuation: null,
        initialMaterialsSha256: grants.recoveryWindowMaterials(f.analysisRoot, childId).materialsSha256 };
}
function manifest(f, members, mutate = () => {}, grantId = crypto.randomUUID()) {
    const state = adapter.readJsonRecord(path.join(f.grant.processDirectory, 'state.json'));
    const body = { ...clone(f.grant.manifest), version: 3, grantId,
        baselineStateFileSha256: state.sha256, baselineGeneration: state.value.generation, members: clone(members) };
    delete body.manifestSha256; mutate(body); body.inventorySha256 = api.stableHash(body.members);
    const value = { ...body, manifestSha256: api.stableHash(body) };
    const manifestPath = path.join(f.grant.repositoryRoot, grantId + '.json'); write(manifestPath, value);
    return { value, options: { manifestPath, analysisRoot: f.analysisRoot, processDirectory: f.grant.processDirectory } };
}
function reader(paper) {
    const identity = { paperId: paper.arxivId, sourceSha256: paper.sourceSha256, ...budget.identityFields(paper) };
    const lease = budget.reserveReaderResponse(paper, identity, 'full', 1);
    budget.settleReaderResponse(lease, 'content', '{"fixture":"retained paid response"}');
    throw Error('mixed fixture retained Reader failure');
}
async function granted(f, { complete = false } = {}) {
    const authority = grants.readRecoveryGrantMember(f.grant.handle, f.paperId);
    const request = { analysisRoot: f.analysisRoot, parentExecutionId: f.parentExecutionId,
        failedExecutionId: f.failedExecutionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot, grantHandle: f.grant.handle };
    const engine = complete ? { ...f.engine, isSuccessfulAnalysisRecordForReadOnlyConferencePublication: () => true } : f.engine;
    const deep = { ...f.operations, refreshApiReaderArticleFromSource: complete ? async paper => paper : reader };
    if (complete) await adapter.refreshConferenceGrantedRecovery(request, { engine, deep });
    else await assert.rejects(adapter.refreshConferenceGrantedRecovery(request, { engine, deep }), /mixed fixture retained/);
    return { authority, child: adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: authority.expectedExecutionId }) };
}
function release(item, authority) {
    item.retryBudgetStart = item.attempts; item.attempts++;
    item.retryReleases = [{ attempts: item.retryBudgetStart, recoveryGrantId: authority.grantId, recoveryGrantSha256: authority.grantSha256 }];
}
async function mixed(t) {
    const post = require('../scripts/lib/conference-postprocess'), originalProofReader = post.readOriginalTagProof;
    const f = await fixture(t), prior = await granted(f);
    const ordinary = await fixture(t, { value: '101', grantInstall: false });
    assert.equal(f.grant.state.processId, ordinary.grant.state.processId);
    for (const id of [ordinary.parentExecutionId, ordinary.failedExecutionId]) {
        fs.cpSync(path.join(ordinary.analysisRoot, id), path.join(f.analysisRoot, id), { recursive: true });
    }
    const state = clone(f.grant.state); release(state.items[f.paperId], prior.authority);
    state.items[ordinary.paperId] = clone(ordinary.grant.state.items[ordinary.paperId]); state.generation++; saveState(f, state);
    const material = grants.recoveryWindowMaterials(f.analysisRoot, prior.child.run.executionId);
    const continued = { ...member(f, f.parentExecutionId, prior.child.run.executionId), continuation: {
        contract: grants.CONTINUATION, grantId: prior.authority.grantId, grantSha256: prior.authority.grantSha256,
        materialsSha256: material.materialsSha256, ledgerFileSha256: material.ledgerFileSha256 } };
    t.after(() => { post.readOriginalTagProof = originalProofReader; });
    return { f, prior, ordinary, state, members: [continued, initial(f, ordinary.parentExecutionId, ordinary.failedExecutionId)] };
}
test('v3真实混合成员共用opaque恢复入口，新账独立且旧材料逐字保留', async t => {
    const { f, prior, ordinary, members } = await mixed(t), m = manifest(f, members);
    const old = grants.recoveryWindowMaterials(f.analysisRoot, prior.child.run.executionId);
    const handle = grants.openRecoveryGrant({ ...m.options, install: true });
    for (const [source, entry] of [[f, members[0]], [ordinary, members[1]]]) {
        const authority = grants.readRecoveryGrantMember(handle, source.paperId);
        assert.deepEqual(authority.limits, { maxRounds: 3, readerContentResponses: 6, readerFullResponses: 2, readerTransportAttempts: 2 });
        await assert.rejects(adapter.refreshConferenceGrantedRecovery({ analysisRoot: f.analysisRoot,
            parentExecutionId: entry.parentExecutionId, failedExecutionId: entry.childExecutionId,
            planHandle: source.planHandle, sourceRoot: source.sourceRoot, grantHandle: handle },
        { engine: source.engine, deep: { ...source.operations, refreshApiReaderArticleFromSource: reader } }), /mixed fixture retained/);
        const cold = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.analysisRoot, executionId: authority.expectedExecutionId });
        assert.equal(cold.analysis.readerRevisionProgress.attempts, 1);
        assert.equal(JSON.parse(fs.readFileSync(path.join(cold.directory, 'reader-grant-budget.json'))).requests.length, 1);
        assert.deepEqual(cold.revision.continuation || null, entry.continuation);
    }
    assert.equal(grants.recoveryWindowMaterials(f.analysisRoot, prior.child.run.executionId).materialsSha256, old.materialsSha256);
    grants.openRecoveryGrant(m.options);
    const parallel = manifest(f, members);
    assert.throws(() => grants.openRecoveryGrant({ ...parallel.options, install: true }), /已有独立追加登记/);
});
test('v3完整失败集合、初次与延续声明、旧合同及材料承诺严格拒绝冒用', async t => {
    const { f, prior, members } = await mixed(t);
    const mutations = [
        m => { m.members.pop(); }, m => { m.members.push(clone(m.members[0])); },
        m => { delete m.members[1].continuation; }, m => { delete m.members[1].initialMaterialsSha256; },
        m => { m.members[1].initialMaterialsSha256 = 'f'.repeat(64); },
        m => { m.members[0].initialMaterialsSha256 = 'f'.repeat(64); },
        m => { m.members[0].continuation = null; m.members[0].initialMaterialsSha256 = grants.recoveryWindowMaterials(f.analysisRoot, prior.child.run.executionId).materialsSha256; },
        m => { m.members[1].continuation = clone(m.members[0].continuation); delete m.members[1].initialMaterialsSha256; },
        m => { m.members[0].continuation.grantSha256 = 'f'.repeat(64); },
        m => { m.members[0].childExecutionId = f.failedExecutionId; },
        m => { m.members[1].sourceTextSha256 = 'f'.repeat(64); },
        m => { m.version = 1; }, m => { m.version = 2; },
        m => { m.limits.readerContentResponses = 7; },
        m => { m.baselineStateFileSha256 = 'f'.repeat(64); }
    ];
    for (const mutate of mutations) {
        const m = manifest(f, members, mutate);
        assert.throws(() => grants.openRecoveryGrant({ ...m.options, install: true }));
    }
    const m = manifest(f, members), child = path.join(f.analysisRoot, members[1].childExecutionId);
    const asset = path.join(child, 'preserved-response-extra.txt'); fs.writeFileSync(asset, 'real saved bytes changed after commitment', { mode: 0o600 });
    assert.throws(() => grants.openRecoveryGrant({ ...m.options, install: true }), /完整候选、请求响应或资产树变化/);
    fs.unlinkSync(asset);
    const pending = path.join(child, 'reader-grant-budget.json'); write(pending, { requests: [{ status: 'pending' }] });
    assert.throws(() => grants.openRecoveryGrant({ ...m.options, install: true }), /在途 Reader/);
    fs.unlinkSync(pending);
    const active = clone(adapter.readJsonRecord(path.join(f.grant.processDirectory, 'state.json')).value);
    active.items[f.paperId].status = 'analyzing'; saveState(f, active);
    const running = manifest(f, members);
    assert.throws(() => grants.openRecoveryGrant({ ...running.options, install: true }), /完整失败集合/);
});
test('v3初次窗口必须有真实已保存失败，不能用准备态、缺失败记录或错来源获得新额度', async t => {
    const f = await fixture(t, { grantInstall: false });
    const file = path.join(f.analysisRoot, f.failedExecutionId, 'analysis.json');
    const original = fs.readFileSync(file), saved = JSON.parse(original);
    for (const mutate of [
        p => { p.readerRevisionProgress.attempts = 0; },
        p => { p.readerRevisionProgress.attempts = 4; },
        p => { p.readerRevisionProgress.failures = []; }
    ]) {
        const changed = clone(saved); mutate(changed); write(file, changed);
        const m = manifest(f, [initial(f, f.parentExecutionId, f.failedExecutionId)]);
        assert.throws(() => grants.openRecoveryGrant({ ...m.options, install: true }), /实际失败的普通修订/);
    }
    fs.writeFileSync(file, original);
    const m = manifest(f, [initial(f, f.parentExecutionId, f.failedExecutionId)], body => {
        const pins = body.members[0].recordCAS;
        pins[Object.keys(pins).find(name => name.endsWith(f.failedExecutionId + '/source.json'))] = 'f'.repeat(64);
    });
    assert.throws(() => grants.openRecoveryGrant({ ...m.options, install: true }));
});
test('v3已采纳真实完成grant子稿可作新普通失败父稿，错误完成证明和祖父回退拒绝', async t => {
    const f = await fixture(t), prior = await granted(f, { complete: true });
    await assert.rejects(adapter.refreshConferenceReader({ analysisRoot: f.analysisRoot,
        parentExecutionId: prior.child.run.executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot },
    { engine: f.engine, deep: f.operations }), /original paid fixture failure/);
    const childId = adapter.readerRevisionExecutionId(prior.child.run.executionId, prior.child.analysisFileSha256);
    const state = clone(f.grant.state), item = state.items[f.paperId]; release(item, prior.authority);
    item.analysisRunId = prior.child.run.executionId;
    item.analysisProof = { analysisSha256: prior.child.analysisFileSha256,
        completionReceiptSha256: prior.child.run.completionReceipt.receiptSha256,
        sourceSnapshotSha256: prior.child.run.sourceSnapshotSha256 };
    item.readerRevision = clone(prior.child.revision); state.generation++; saveState(f, state);
    const members = [initial(f, prior.child.run.executionId, childId)];
    for (const mutate of [
        s => { s.items[f.paperId].analysisProof.completionReceiptSha256 = 'f'.repeat(64); },
        s => { const r = s.items[f.paperId].readerRevision; r.mode = 'normal-analysis';
            const { revisionSha256, ...body } = r; r.revisionSha256 = api.stableHash(body); },
        s => { s.items[f.paperId].sourceProof.textSha256 = 'f'.repeat(64); },
        s => { s.items[f.paperId].analysisRunId = f.parentExecutionId; },
        s => { s.items[f.paperId].retryReleases[0].recoveryGrantSha256 = 'f'.repeat(64); }
    ]) {
        const changed = clone(state); mutate(changed);
        assert.throws(() => { saveState(f, changed); const m = manifest(f, members);
            grants.openRecoveryGrant({ ...m.options, install: true }); });
    }
    saveState(f, state);
    const m = manifest(f, members), handle = grants.openRecoveryGrant({ ...m.options, install: true });
    assert.equal(grants.readRecoveryGrantMember(handle, f.paperId).parentExecutionId, prior.child.run.executionId);
    assert.equal(grants.readRecoveryGrantMember(handle, f.paperId).failedExecutionId, childId);
});
