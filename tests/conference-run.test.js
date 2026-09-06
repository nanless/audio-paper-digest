'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const conference = require('../scripts/lib/conference-run.js');

const sha = value => conference.sha256(value);
const members = [
    { paperId: 'icassp-2026:100', sourceIdentity: 'ieee-arnumber:100' },
    { paperId: 'icassp-2026:200', sourceIdentity: 'ieee-arnumber:200' },
    { paperId: 'icassp-2026:300', sourceIdentity: 'ieee-arnumber:300' }
];
const base = () => ({ conferenceId: 'icassp-2026', ledgerSha256: sha('ledger'), taxonomyVersion: 'paper-taxonomy-v2',
    selectionPolicySha256: sha('policy'), members, shards: [
        { shardId: 'shard-b', paperIds: ['icassp-2026:300'] },
        { shardId: 'shard-a', paperIds: ['icassp-2026:200', 'icassp-2026:100'] }
    ] });
function projection(paperId) {
    const value = { contract: conference.PAPER_PROJECTION_CONTRACT, paperId,
        sourceSha256: sha(`source:${paperId}`), readerSha256: sha(`reader:${paperId}`),
        taxonomySha256: sha(`taxonomy:${paperId}`), scoringSha256: sha(`scoring:${paperId}`),
        publicationSha256: sha(`publication:${paperId}`), summary: { title: `Title ${paperId}`, score: 9.2 } };
    return { ...value, projectionSha256: conference.stableHash(value) };
}
function complete(run, paperId, usage = {}) {
    run = conference.transitionPaperState(run, paperId, { status: 'source_ready', usage });
    run = conference.transitionPaperState(run, paperId, { status: 'analyzing', usage });
    return conference.transitionPaperState(run, paperId, { status: 'completed', usage, projection: projection(paperId) });
}

test('conference run freezes ordered member/source identities, member digest and full non-overlapping shards', () => {
    const run = conference.createConferenceRun(base());
    assert.equal(run.contract, 'conference-run-v1');
    assert.deepEqual(run.members.map(member => member.paperId), ['icassp-2026:100', 'icassp-2026:200', 'icassp-2026:300']);
    assert.deepEqual(run.shards.map(shard => shard.shardId), ['shard-a', 'shard-b']);
    assert.equal(run.membershipSha256, conference.stableHash(run.members));
    assert.equal(conference.assertConferenceRun(run).identitySha256, run.identitySha256);
    assert.throws(() => conference.createConferenceRun({ ...base(), members: [members[0], { ...members[1], sourceIdentity: members[0].sourceIdentity }, members[2]] }), /duplicate sourceIdentity/);
    assert.throws(() => conference.createConferenceRun({ ...base(), shards: [{ shardId: 'a', paperIds: ['icassp-2026:100', 'icassp-2026:200'] }, { shardId: 'b', paperIds: ['icassp-2026:200', 'icassp-2026:300'] }] }), /more than one shard/);
    assert.throws(() => conference.createConferenceRun({ ...base(), shards: [{ shardId: 'a', paperIds: ['icassp-2026:100'] }, { shardId: 'b', paperIds: ['icassp-2026:200'] }] }), /cover every member/);
    assert.throws(() => conference.createConferenceRun({ ...base(), membershipSha256: sha('not members') }), /does not bind members/);
});

test('run identity detects immutable source, taxonomy, policy, membership and shard drift', () => {
    const run = conference.createConferenceRun(base());
    for (const altered of [
        { ...run, ledgerSha256: sha('other ledger') },
        { ...run, taxonomyVersion: 'paper-taxonomy-v3' },
        { ...run, selectionPolicySha256: sha('other policy') },
        { ...run, members: [{ ...run.members[0], sourceIdentity: 'ieee-arnumber:999' }, ...run.members.slice(1)] },
        { ...run, shards: [{ ...run.shards[0], paperIds: ['icassp-2026:100'] }, run.shards[1]] }
    ]) assert.throws(() => conference.assertConferenceRun(altered), /drift|bind|cover/);
    const next = conference.transitionPaperState(run, 'icassp-2026:100', { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(next.identitySha256, run.identitySha256);
    assert.notEqual(next.stateSha256, run.stateSha256);
});

test('only legal state transitions can add a completed independent-paper projection', () => {
    let run = conference.createConferenceRun(base());
    assert.throws(() => conference.transitionPaperState(run, 'icassp-2026:100', { status: 'completed', projection: projection('icassp-2026:100') }), /illegal transition/);
    assert.throws(() => conference.transitionPaperState(run, 'icassp-2026:100', { status: 'pending', usage: {}, projection: projection('icassp-2026:100') }), /incomplete state/);
    run = complete(run, 'icassp-2026:100', { requests: 3, totalTokens: 42 });
    assert.equal(run.paperStates['icassp-2026:100'].status, 'completed');
    assert.equal(run.paperStates['icassp-2026:100'].usage.totalTokens, 42);
    assert.throws(() => conference.transitionPaperState(run, 'icassp-2026:100', { status: 'analyzing', usage: {} }), /illegal transition/);
    const tampered = structuredClone(run);
    tampered.paperStates['icassp-2026:100'].projection.summary.score = 1;
    assert.throws(() => conference.assertConferenceRun(tampered), /projection SHA/);
});

test('summary hand-off is deterministic, projection-only, and marks incomplete or blocked members as excluded', () => {
    let run = conference.createConferenceRun(base());
    run = complete(run, 'icassp-2026:100', { requests: 2, totalTokens: 100 });
    run = conference.transitionPaperState(run, 'icassp-2026:200', { status: 'blocked', usage: { requests: 1 }, reason: 'missing local full text' });
    const one = conference.buildConferenceAggregateInput(run);
    const two = conference.buildConferenceAggregateInput(conference.assertConferenceRun(run));
    assert.deepEqual(one, two);
    assert.equal(one.status, 'partial'); assert.equal(one.publicationEligible, false);
    assert.deepEqual(one.papers.map(paper => paper.paperId), ['icassp-2026:100']);
    assert.deepEqual(one.excluded.blocked, ['icassp-2026:200']);
    assert.deepEqual(one.excluded.pending, ['icassp-2026:300']);
    assert.equal(one.usage.allMembers.totalTokens.sum, 100);
    assert.equal(one.usage.allMembers.totalTokens.reportedPapers, 1);
    assert.throws(() => conference.assertPublishableConferenceInput(one), /not publishable/);
    assert.doesNotMatch(JSON.stringify(one.papers), /missing local full text/);
});

test('only a fully completed run yields a signed publishable aggregate input', () => {
    let run = conference.createConferenceRun(base());
    for (const member of run.members) run = complete(run, member.paperId, { requests: 1, totalTokens: 10 });
    const input = conference.buildConferenceAggregateInput(run);
    assert.equal(input.status, 'complete'); assert.equal(input.publicationEligible, true);
    assert.deepEqual(input.papers.map(paper => paper.paperId), run.members.map(member => member.paperId));
    assert.equal(conference.assertPublishableConferenceInput(input).inputSha256, input.inputSha256);
    const tampered = structuredClone(input); tampered.papers[0].projection.summary.title = 'unbound text';
    assert.throws(() => conference.assertPublishableConferenceInput(tampered), /SHA drifted/);
});

test('failed and blocked states need a reason and can only resume through source_ready', () => {
    let run = conference.createConferenceRun(base());
    assert.throws(() => conference.transitionPaperState(run, 'icassp-2026:100', { status: 'blocked', usage: {} }), /requires a reason/);
    run = conference.transitionPaperState(run, 'icassp-2026:100', { status: 'blocked', usage: {}, reason: 'ledger mismatch' });
    assert.throws(() => conference.transitionPaperState(run, 'icassp-2026:100', { status: 'analyzing', usage: {} }), /illegal transition/);
    run = conference.transitionPaperState(run, 'icassp-2026:100', { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(run.paperStates['icassp-2026:100'].status, 'source_ready');
});
