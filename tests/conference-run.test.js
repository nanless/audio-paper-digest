'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const conference = require('../scripts/lib/conference-run.js');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const { loadOriginalConferenceApis } = require('./helpers/conference-production-plan-fixture.js');

const sha = value => conference.sha256(value);
const pid = value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });
const members = [
    { paperId: pid('100'), sourceIdentity: 'icassp-arnumber:100' },
    { paperId: pid('200'), sourceIdentity: 'icassp-arnumber:200' },
    { paperId: pid('300'), sourceIdentity: 'icassp-arnumber:300' }
];
const selectionProof = () => ({ filterPolicySha256: sha('policy'), selectionReceiptSha256: sha('selection receipt'),
    selectedMemberSetSha256: conference.stableHash(members.map(member => member.paperId)) });
const base = () => ({ conferenceId: 'icassp-2026', ledgerSha256: sha('ledger'), tagCatalogVersion: 'paper-tag-catalog-v2',
    ...selectionProof(), members, shards: [
        { shardId: 'shard-b', paperIds: [pid('300')] },
        { shardId: 'shard-a', paperIds: [pid('200'), pid('100')] }
    ] });
function verifiedLedger(states = {}) {
    return ledgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, members.map(member => {
        const sourceIdentity = member.sourceIdentity.split(':');
        const record = {
            identity: { type: sourceIdentity[0], value: sourceIdentity[1] },
            metadataFile: `metadata/${sourceIdentity[1]}.json`, metadataSha256: sha(`metadata:${sourceIdentity[1]}`),
            pdfFile: `pdf/${sourceIdentity[1]}.pdf`, pdfSha256: sha(`pdf:${sourceIdentity[1]}`),
            textFile: `text/${sourceIdentity[1]}.txt`, textSha256: sha(`text:${sourceIdentity[1]}`),
            artifactsFile: `artifacts/${sourceIdentity[1]}.json`, artifactsSha256: sha(`artifacts:${sourceIdentity[1]}`)
        };
        record.status = { state: states[member.sourceIdentity] || 'verified', updatedAt: '2026-09-06T00:00:00.000Z', reason: 'fixture source proof',
            evidence: ['metadata', 'pdf', 'text', 'artifacts'].map(kind => ({ kind, sha256: record[`${kind}Sha256`] })) };
        return record;
    }));
}
function boundRun(states) {
    const ledger = verifiedLedger(states); const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-ledger-handle-'));
    const filename = path.join(directory, 'ledger.json'); ledgerApi.writeLedger(filename, ledger);
    const ledgerHandle = ledgerApi.loadLedgerHandle(filename); const { ledgerSha256 } = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
    fs.rmSync(directory, { recursive: true, force: true });
    const run = conference.createConferenceRunFromVerifiedLedger({ ledgerHandle, tagCatalogVersion: 'paper-tag-catalog-v2',
        ...selectionProof(), members, shards: base().shards });
    return { run, ledger, ledgerSha256, ledgerHandle };
}
function projection(paperId) {
    const value = { contract: conference.PAPER_PROJECTION_CONTRACT, paperId,
        sourceSha256: sha(`source:${paperId}`), readerSha256: sha(`reader:${paperId}`),
        tagMetadataSha256: sha(`tag metadata:${paperId}`), scoringSha256: sha(`scoring:${paperId}`),
        publicationSha256: sha(`publication:${paperId}`), summary: { title: `Title ${paperId}`, score: 9.2 } };
    return { ...value, projectionSha256: conference.stableHash(value) };
}
test('conference run freezes ordered member/source identities, member digest and full non-overlapping shards', () => {
    const run = conference.createConferenceRun(base());
    assert.equal(run.contract, conference.CONTRACT);
    assert.equal(run.version, 3);
    assert.equal(run.tagCatalogVersion, base().tagCatalogVersion);
    assert.equal(Object.hasOwn(run, 'taxonomyVersion'), false);
    assert.deepEqual(run.members.map(member => member.paperId), [pid('100'), pid('200'), pid('300')]);
    assert.deepEqual(run.shards.map(shard => shard.shardId), ['shard-a', 'shard-b']);
    assert.equal(run.membershipSha256, conference.stableHash(run.members));
    assert.equal(conference.assertConferenceRun(run).identitySha256, run.identitySha256);
    assert.throws(() => conference.createConferenceRun({ ...base(), members: [members[0], { ...members[1], sourceIdentity: members[0].sourceIdentity }, members[2]] }), /canonical|duplicate sourceIdentity/);
    assert.throws(() => conference.createConferenceRun({ ...base(), shards: [{ shardId: 'a', paperIds: [pid('100'), pid('200')] }, { shardId: 'b', paperIds: [pid('200'), pid('300')] }] }), /more than one shard/);
    assert.throws(() => conference.createConferenceRun({ ...base(), shards: [{ shardId: 'a', paperIds: [pid('100')] }, { shardId: 'b', paperIds: [pid('200')] }] }), /cover every member/);
    assert.throws(() => conference.createConferenceRun({ ...base(), membershipSha256: sha('not members') }), /does not bind members/);
});

test('运行和论文记录拒绝混用不同版本的标签字段', () => {
    for (const oldValue of [base().tagCatalogVersion, null]) {
        assert.throws(() => conference.createConferenceRun({ ...base(), taxonomyVersion: oldValue }), /不能混用新旧词表版本字段/);
    }
    const run = conference.createConferenceRun(base());
    for (const [contract, version] of [[conference.CONTRACT, 2], ['conference-run-v9', 3]]) {
        assert.throws(() => conference.assertConferenceRun({ ...run, contract, version }), /不属于支持的组合/);
    }
    const record = projection(pid('100'));
    assert.deepEqual(conference.normalizeConferencePaperRecord(record, pid('100')), record);
    assert.equal(Object.hasOwn(record, 'taxonomySha256'), false);
    for (const oldValue of [record.tagMetadataSha256, null]) {
        const mixed = { ...record, taxonomySha256: oldValue };
        assert.throws(() => conference.normalizeConferencePaperRecord(mixed, pid('100')), /projection SHA/);
        const { projectionSha256: _oldSha, ...body } = mixed;
        mixed.projectionSha256 = conference.stableHash(body);
        assert.throws(() => conference.normalizeConferencePaperRecord(mixed, pid('100')), /不能混用新旧标签摘要字段/);
    }
});

test('读取旧运行和论文样本时保留原记录及摘要', () => {
    const original = loadOriginalConferenceApis().run;
    const oldRun = original.createConferenceRun({ conferenceId: 'icassp-2026', ledgerSha256: sha('ledger'),
        taxonomyVersion: 'paper-taxonomy-v2', ...selectionProof(), members, shards: base().shards });
    const before = structuredClone(oldRun);
    assert.deepEqual(conference.assertConferenceRun(oldRun), oldRun);
    assert.equal(conference.tagCatalogVersionForRun(oldRun), 'paper-taxonomy-v2');
    const continued = conference.transitionPaperState(oldRun, pid('100'), { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(continued.version, 2);
    assert.equal(continued.contract, 'conference-run-v2');
    assert.equal(continued.identitySha256, oldRun.identitySha256);
    assert.equal(Object.hasOwn(continued, 'tagCatalogVersion'), false);
    assert.deepEqual(oldRun, before);
    // 这是原校验器生成的合成摘要样本，不是已完成论文的发布证明。
    const body = { contract: original.PAPER_PROJECTION_CONTRACT, paperId: pid('100'),
        sourceSha256: sha('source'), readerSha256: sha('reader'), taxonomySha256: sha('tag metadata'),
        scoringSha256: sha('scoring'), publicationSha256: sha('publication'), summary: { title: 'Original', score: 9 } };
    const oldRecord = original.normalizeConferencePaperRecord({ ...body, projectionSha256: original.stableHash(body) }, pid('100'));
    assert.deepEqual(conference.normalizeConferencePaperRecord(oldRecord, pid('100')), oldRecord);
    assert.throws(() => conference.transitionPaperState(continued, pid('100'), { status: 'completed', usage: { requests: 1 },
        projection: oldRecord }), /completion-proof handle/);
});

test('运行记录核对来源、词表、选择规则、成员和分片是否变化', () => {
    const run = conference.createConferenceRun(base());
    for (const altered of [
        { ...run, ledgerSha256: sha('other ledger') },
        { ...run, tagCatalogVersion: 'paper-tag-catalog-v3' },
        { ...run, filterPolicySha256: sha('other policy') },
        { ...run, selectionReceiptSha256: sha('other receipt') },
        { ...run, selectedMemberSetSha256: sha('other members') },
        { ...run, members: [{ ...run.members[0], sourceIdentity: 'ieee-arnumber:999' }, ...run.members.slice(1)] },
        { ...run, shards: [{ ...run.shards[0], paperIds: [pid('100')] }, run.shards[1]] }
    ]) assert.throws(() => conference.assertConferenceRun(altered), /drift|bind|cover|unsupported|canonical/);
    const next = conference.transitionPaperState(run, pid('100'), { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(next.identitySha256, run.identitySha256);
    assert.notEqual(next.stateSha256, run.stateSha256);
});

test('completed state is unavailable until an authenticated completion-proof handle exists', () => {
    let run = conference.createConferenceRun(base());
    assert.throws(() => conference.transitionPaperState(run, pid('100'), { status: 'completed', usage: {},
        projection: projection(pid('100')) }), /completion-proof handle/);
    assert.throws(() => conference.transitionPaperState(run, pid('100'), { status: 'pending', usage: {}, projection: projection(pid('100')) }), /unknown field/);
    run = conference.transitionPaperState(run, pid('100'), { status: 'source_ready', usage: { requests: 1 } });
    run = conference.transitionPaperState(run, pid('100'), { status: 'analyzing', usage: { requests: 2 } });
    assert.throws(() => conference.transitionPaperState(run, pid('100'), { status: 'completed', usage: { requests: 2 },
        projection: projection(pid('100')) }), /completion-proof handle/);
    const forged = structuredClone(run);
    forged.paperStates[pid('100')] = { status: 'completed', usage: conference.normalizeUsage({ requests: 2 }),
        projection: projection(pid('100')) };
    forged.stateSha256 = conference.stableHash({ identitySha256: forged.identitySha256, paperStates: forged.paperStates });
    assert.throws(() => conference.assertConferenceRun(forged), /completion-proof handle/);
});

test('only a verified ledger can create an executable run, with exact canonical source identities', () => {
    const { run, ledger, ledgerSha256, ledgerHandle } = boundRun();
    assert.equal(conference.assertConferenceRunFromVerifiedLedger(run, ledgerHandle).identitySha256, run.identitySha256);
    assert.throws(() => conference.createConferenceRunFromVerifiedLedger({ ledgerHandle, tagCatalogVersion: 'paper-tag-catalog-v2', ...selectionProof(),
        members: [{ ...members[0], sourceIdentity: 'ieee-arnumber:100' }, ...members.slice(1)], shards: base().shards }), /not present/);
    const blockedLedger = verifiedLedger(); const blocked = blockedLedger.members.find(member => member.identity.value === '200');
    blocked.availability.artifacts = 'absent'; blocked.artifactsFile = null; blocked.artifactsSha256 = null;
    blocked.provenance.artifacts = null; blocked.status.state = 'blocked'; blocked.status.evidence = blocked.status.evidence.filter(item => item.kind !== 'artifacts');
    assert.equal(ledgerApi.validateLedger(blockedLedger), blockedLedger);
    assert.throws(() => conference.createConferenceRunFromVerifiedLedger({ ledgerHandle: structuredClone(ledgerHandle), tagCatalogVersion: 'paper-tag-catalog-v2', ...selectionProof(), members, shards: base().shards }), /authenticated loaded ledger handle/);
    const forged = conference.createConferenceRun({ ...base(), ledgerSha256 });
    assert.throws(() => conference.assertConferenceRunFromVerifiedLedger(forged, ledgerHandle), /lacks a verified ledger binding/);
});

test('creation cannot inject completed states, unknown fields, or a fabricated binding', () => {
    const pending = Object.fromEntries(members.map(member => [member.paperId, { status: 'pending', usage: {} }]));
    assert.doesNotThrow(() => conference.createConferenceRun({ ...base(), paperStates: pending }));
    const completed = structuredClone(pending); completed[members[0].paperId] = { status: 'completed', usage: {}, projection: projection(members[0].paperId) };
    assert.throws(() => conference.createConferenceRun({ ...base(), paperStates: completed }), /initial state/);
    assert.throws(() => conference.createConferenceRun({ ...base(), arbitrary: true }), /unknown field/);
    assert.throws(() => conference.createConferenceRun({ ...base(), ledgerBinding: {} }), /unknown field/);
});

test('usage is monotonic across every transition and cannot be cleared after reporting', () => {
    let run = conference.createConferenceRun(base());
    run = conference.transitionPaperState(run, members[0].paperId, { status: 'source_ready', usage: { requests: 2, totalTokens: 20 } });
    assert.throws(() => conference.transitionPaperState(run, members[0].paperId, { status: 'analyzing', usage: { requests: 1, totalTokens: 20 } }), /cannot regress/);
    assert.throws(() => conference.transitionPaperState(run, members[0].paperId, { status: 'analyzing', usage: { requests: 2 } }), /cannot regress or be cleared/);
    run = conference.transitionPaperState(run, members[0].paperId, { status: 'analyzing', usage: { requests: 2, totalTokens: 21 } });
    assert.equal(run.paperStates[members[0].paperId].usage.totalTokens, 21);
});

test('summary hand-off remains draft-only and marks every incomplete member as excluded', () => {
    const trusted = boundRun(); let run = trusted.run;
    run = conference.transitionPaperState(run, pid('100'), { status: 'source_ready', usage: { requests: 1, totalTokens: 50 } });
    run = conference.transitionPaperState(run, pid('100'), { status: 'analyzing', usage: { requests: 2, totalTokens: 100 } });
    run = conference.transitionPaperState(run, pid('200'), { status: 'blocked', usage: { requests: 1 }, reason: 'missing local full text' });
    const context = { ledgerHandle: trusted.ledgerHandle };
    const one = conference.buildConferenceAggregateInput(run, context);
    const two = conference.buildConferenceAggregateInput(conference.assertConferenceRun(run), context);
    assert.deepEqual(one, two);
    assert.equal(one.version, 3);
    assert.equal(one.tagCatalogVersion, run.tagCatalogVersion);
    assert.equal(Object.hasOwn(one, 'taxonomyVersion'), false);
    assert.equal(one.status, 'partial'); assert.equal(one.publicationEligible, false);
    assert.deepEqual(one.papers, []);
    assert.deepEqual(one.excluded.analyzing, [pid('100')]);
    assert.deepEqual(one.excluded.blocked, [pid('200')]);
    assert.deepEqual(one.excluded.pending, [pid('300')]);
    assert.equal(one.usage.allMembers.totalTokens.sum, 100);
    assert.equal(one.usage.allMembers.totalTokens.reportedPapers, 1);
    assert.throws(() => conference.assertPublishableConferenceInput(one, { ...context, run }), /publishing is disabled/);
    assert.doesNotMatch(JSON.stringify(one.papers), /missing local full text/);
});

test('legacy run API cannot create or validate a publishable conference aggregate', () => {
    const trusted = boundRun(); let run = trusted.run;
    const context = { ledgerHandle: trusted.ledgerHandle };
    const input = conference.buildConferenceAggregateInput(run, context);
    assert.equal(input.status, 'partial'); assert.equal(input.publicationEligible, false);
    assert.throws(() => conference.assertPublishableConferenceInput(input, { ...context, run }), /publishing is disabled/);
    let analyzing = conference.transitionPaperState(run, members[0].paperId, { status: 'source_ready', usage: {} });
    analyzing = conference.transitionPaperState(analyzing, members[0].paperId, { status: 'analyzing', usage: {} });
    assert.throws(() => conference.transitionPaperState(analyzing, members[0].paperId, {
        status: 'completed', usage: {}, projection: projection(members[0].paperId)
    }), /completion-proof handle/);
});

test('failed and blocked states need a reason and can only resume through source_ready', () => {
    let run = conference.createConferenceRun(base());
    assert.throws(() => conference.transitionPaperState(run, pid('100'), { status: 'blocked', usage: {} }), /requires a reason/);
    run = conference.transitionPaperState(run, pid('100'), { status: 'blocked', usage: {}, reason: 'ledger mismatch' });
    assert.throws(() => conference.transitionPaperState(run, pid('100'), { status: 'analyzing', usage: {} }), /illegal transition/);
    run = conference.transitionPaperState(run, pid('100'), { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(run.paperStates[pid('100')].status, 'source_ready');
});
