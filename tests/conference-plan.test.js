'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../scripts/lib/conference-plan.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const fs = require('node:fs');
const path = require('node:path');
const { productionPlanFixture, loadOriginalConferenceApis, sha256 } = require('./helpers/conference-production-plan-fixture.js');

const paperId = paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value: '1001' });
const identities = [{ paperId, sourceIdentity: 'icassp-arnumber:1001' }];
const selectedMemberSetSha256 = plan.stableHash([paperId]);
const valid = () => ({
    contract: plan.PLAN_CONTRACT,
    version: plan.VERSION,
    ledgerName: 'icassp-2026.json',
    tagMetadata: { version: 'paper-tag-catalog-v2', sha256: 'a'.repeat(64) },
    selectionPolicy: { contract: plan.SELECTION_CONTRACT, identities, selectedMemberSetSha256 },
    shards: [{ shardId: 'all', paperIds: [paperId] }]
});

test('新版计划逐项核验入选论文，并要求分片完整覆盖', () => {
    assert.deepEqual(plan.normalizePlan(valid()), valid());
    assert.equal(valid().version, 3);
    assert.equal(Object.hasOwn(valid(), 'taxonomy'), false);
    const drift = valid(); drift.selectionPolicy.selectedMemberSetSha256 = 'b'.repeat(64);
    assert.throws(() => plan.normalizePlan(drift), /selectedMemberSetSha256/);
    const incomplete = valid(); incomplete.shards[0].paperIds = [];
    assert.throws(() => plan.normalizePlan(incomplete), /contain paperIds/);
});

test('计划拒绝混用标签字段，并核对格式与版本', () => {
    for (const legacyValue of [valid().tagMetadata, null]) {
        assert.throws(() => plan.normalizePlan({ ...valid(), taxonomy: legacyValue }), /不能混用新旧标签字段/);
    }
    for (const [contract, version] of [[plan.PLAN_CONTRACT, 2], ['conference-run-plan-v9', 3]]) {
        assert.throws(() => plan.normalizePlan({ ...valid(), contract, version }), /不属于支持的组合/);
    }
    assert.throws(() => plan.normalizePlan({ ...valid(), contract: 'conference-run-plan-v2', version: 2 }), /标签字段与格式版本不一致/);
});

test('旧计划和凭证可按原字节读取，但不能创建另一份运行记录', t => {
    const original = loadOriginalConferenceApis();
    const f = productionPlanFixture(t, { planApi: original.plan });
    const runFile = path.join(f.roots.runs, 'run.json');
    const receiptFile = path.join(f.roots.runs, 'run.plan-receipt.json');
    const planFile = path.join(f.roots.ledgers, 'plan.json');
    const before = [planFile, runFile, receiptFile].map(filename => fs.readFileSync(filename));
    const handle = plan.loadPlanHandle(runFile, receiptFile, planFile, f.importHandle, f.tagCatalogPath);
    const snapshot = plan.planHandleSnapshot(handle);
    assert.equal(snapshot.run.version, 2);
    assert.equal(snapshot.receipt.version, 2);
    assert.deepEqual(snapshot.run, f.planned.run);
    assert.deepEqual(snapshot.receipt, f.planned.receipt);
    assert.equal(snapshot.runFileSha256, sha256(before[1]));
    assert.equal(snapshot.receiptFileSha256, sha256(before[2]));
    assert.deepEqual(plan.tagMetadataForPlan(f.planned.plan), f.planned.plan.taxonomy);
    assert.deepEqual(plan.tagMetadataForReceipt(snapshot.receipt), snapshot.receipt.taxonomy);
    const recovered = plan.createRunFromImportPlan({ files: f.files, importHandle: f.importHandle,
        planName: 'plan.json', runName: 'run.json' });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.receipt, f.planned.receipt);
    assert.throws(() => plan.applyRunPlan(recovered), /旧计划只能读取或恢复/);
    assert.throws(() => plan.createRunFromImportPlan({ files: f.files, importHandle: f.importHandle,
        planName: 'plan.json', runName: 'new-run.json' }), /ENOENT|runtime/);
    assert.equal(fs.existsSync(path.join(f.roots.runs, 'new-run.json')), false);
    assert.equal(fs.existsSync(path.join(f.roots.runs, 'new-run.plan-receipt.json')), false);
    [planFile, runFile, receiptFile].forEach((filename, index) => assert.deepEqual(fs.readFileSync(filename), before[index]));

    // 原凭证绑定的是实际 plan 文件字节，不接受只改排版而保留原凭证。
    fs.writeFileSync(planFile, Buffer.concat([before[0], Buffer.from('\n')]));
    assert.throws(() => plan.loadPlanHandle(runFile, receiptFile, planFile, f.importHandle, f.tagCatalogPath), /plan receipt does not bind exact reviewed plan file/);
    fs.writeFileSync(planFile, before[0]);
    for (const currentValue of [snapshot.receipt.taxonomy, null]) {
        const mixedReceipt = { ...snapshot.receipt, tagMetadata: currentValue };
        assert.throws(() => plan.normalizeSecureReceipt(mixedReceipt), /secure plan receipt SHA/);
        const { receiptSha256: _oldSha, ...mixedBody } = mixedReceipt;
        mixedReceipt.receiptSha256 = plan.stableHash(mixedBody);
        assert.throws(() => plan.normalizeSecureReceipt(mixedReceipt), /不能混用新旧标签字段/);
    }
});

test('legacy ledger-only plan constructors are not exposed', () => {
    assert.equal(plan.createRunFromPlan, undefined);
    assert.equal(plan.createPlanReceipt, undefined);
});

test('plan filenames remain direct JSON names', () => {
    assert.throws(() => plan.receiptNameFor('../run.json'), /safe direct JSON/);
    assert.equal(plan.receiptNameFor('run.json'), 'run.plan-receipt.json');
});
