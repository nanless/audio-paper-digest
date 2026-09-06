'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../scripts/lib/conference-plan.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');

const paperId = paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value: '1001' });
const identities = [{ paperId, sourceIdentity: 'icassp-arnumber:1001' }];
const selectedMemberSetSha256 = plan.stableHash([paperId]);
const valid = () => ({
    contract: plan.PLAN_CONTRACT,
    version: plan.VERSION,
    ledgerName: 'icassp-2026.json',
    taxonomy: { version: 'paper-taxonomy-v1', sha256: 'a'.repeat(64) },
    selectionPolicy: { contract: plan.SELECTION_CONTRACT, identities, selectedMemberSetSha256 },
    shards: [{ shardId: 'all', paperIds: [paperId] }]
});

test('v2 plan binds the explicit canonical selected member set and complete shards', () => {
    assert.deepEqual(plan.normalizePlan(valid()), valid());
    const drift = valid(); drift.selectionPolicy.selectedMemberSetSha256 = 'b'.repeat(64);
    assert.throws(() => plan.normalizePlan(drift), /selectedMemberSetSha256/);
    const incomplete = valid(); incomplete.shards[0].paperIds = [];
    assert.throws(() => plan.normalizePlan(incomplete), /contain paperIds/);
});

test('legacy ledger-only plan constructors are not exposed', () => {
    assert.equal(plan.createRunFromPlan, undefined);
    assert.equal(plan.createPlanReceipt, undefined);
});

test('plan filenames remain direct JSON names', () => {
    assert.throws(() => plan.receiptNameFor('../run.json'), /safe direct JSON/);
    assert.equal(plan.receiptNameFor('run.json'), 'run.plan-receipt.json');
});
