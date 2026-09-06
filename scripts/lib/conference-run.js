'use strict';

// An offline, content-addressed plan for a conference rewrite.  This module is
// deliberately not a scheduler: it neither reads PDFs nor invokes an LLM nor
// writes a blog.  Its only job is to make the member set, sharding, status
// transitions and summary hand-off independently auditable.
const crypto = require('node:crypto');

const VERSION = 1;
const CONTRACT = 'conference-run-v1';
const PAPER_PROJECTION_CONTRACT = 'conference-paper-projection-v1';
const SUMMARY_INPUT_CONTRACT = 'conference-summary-input-v1';
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const CONFERENCE_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const TAXONOMY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const USAGE_FIELDS = Object.freeze([
    'requests', 'unsuccessfulRequests', 'inputTokens', 'outputTokens', 'totalTokens',
    'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens',
    'estimatedInputTextTokens', 'durationMs'
]);
const STATUS_TRANSITIONS = Object.freeze({
    pending: Object.freeze(['source_ready', 'blocked']),
    source_ready: Object.freeze(['analyzing', 'blocked']),
    analyzing: Object.freeze(['completed', 'failed', 'blocked']),
    failed: Object.freeze(['analyzing', 'blocked']),
    // A source/identity correction must be explicitly recorded before retrying.
    blocked: Object.freeze(['source_ready']),
    completed: Object.freeze([])
});

function sha256(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
        ? value : JSON.stringify(value)).digest('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function stableHash(value) { return sha256(JSON.stringify(canonical(value))); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isSha(value) { return SHA_RE.test(String(value || '')); }
function fail(message) { throw new Error(`Invalid conference run: ${message}`); }

function assertSafeId(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${label} is malformed`);
    return value;
}

function assertSha(value, label) {
    if (!isSha(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}

function normalizeMembers(members) {
    if (!Array.isArray(members) || !members.length) fail('members must be a non-empty array');
    const normalized = members.map(member => {
        if (!member || typeof member !== 'object' || Array.isArray(member)) fail('member is malformed');
        const paperId = assertSafeId(member.paperId, 'member paperId');
        const sourceIdentity = assertSafeId(member.sourceIdentity, 'member sourceIdentity');
        return { paperId, sourceIdentity };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(normalized.map(member => member.paperId)).size !== normalized.length) fail('members contain duplicate paperId values');
    if (new Set(normalized.map(member => member.sourceIdentity)).size !== normalized.length) {
        fail('members contain duplicate sourceIdentity values');
    }
    return normalized;
}

function normalizeShards(shards, paperIds) {
    if (!Array.isArray(shards) || !shards.length) fail('shards must be a non-empty array');
    const expected = new Set(paperIds);
    const seen = new Set();
    const normalized = shards.map(shard => {
        if (!shard || typeof shard !== 'object' || Array.isArray(shard)) fail('shard is malformed');
        const shardId = assertSafeId(shard.shardId, 'shardId');
        if (!Array.isArray(shard.paperIds) || !shard.paperIds.length) fail(`${shardId} must contain paperIds`);
        const ids = shard.paperIds.map(id => assertSafeId(id, `${shardId} paperId`)).sort();
        if (new Set(ids).size !== ids.length) fail(`${shardId} contains duplicate paperIds`);
        for (const id of ids) {
            if (!expected.has(id)) fail(`${shardId} references a non-member paperId`);
            if (seen.has(id)) fail(`paperId ${id} appears in more than one shard`);
            seen.add(id);
        }
        return { shardId, paperIds: ids };
    }).sort((left, right) => left.shardId.localeCompare(right.shardId));
    if (new Set(normalized.map(shard => shard.shardId)).size !== normalized.length) fail('shards contain duplicate shardId values');
    if (seen.size !== expected.size) fail('shards do not cover every member exactly once');
    return normalized;
}

function normalizeUsage(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('usage must be an object');
    const usage = {};
    for (const key of USAGE_FIELDS) {
        const amount = value[key];
        if (amount === undefined || amount === null) usage[key] = null;
        else if (Number.isSafeInteger(amount) && amount >= 0) usage[key] = amount;
        else fail(`usage.${key} must be a non-negative safe integer or null`);
    }
    for (const key of Object.keys(value)) if (!USAGE_FIELDS.includes(key)) fail(`usage has unknown field ${key}`);
    return usage;
}

function projectionDigest(projection) {
    const { projectionSha256, ...bound } = projection;
    return stableHash(bound);
}

function normalizeProjection(value, paperId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${paperId} completed state requires a projection`);
    const projection = {
        contract: value.contract,
        paperId: value.paperId,
        sourceSha256: value.sourceSha256,
        readerSha256: value.readerSha256,
        taxonomySha256: value.taxonomySha256,
        scoringSha256: value.scoringSha256,
        publicationSha256: value.publicationSha256,
        summary: value.summary,
        projectionSha256: value.projectionSha256
    };
    if (projection.contract !== PAPER_PROJECTION_CONTRACT || projection.paperId !== paperId) {
        fail(`${paperId} projection identity is malformed`);
    }
    for (const key of ['sourceSha256', 'readerSha256', 'taxonomySha256', 'scoringSha256', 'publicationSha256', 'projectionSha256']) {
        assertSha(projection[key], `${paperId} projection ${key}`);
    }
    if (!projection.summary || typeof projection.summary !== 'object' || Array.isArray(projection.summary)) {
        fail(`${paperId} projection summary must be an object`);
    }
    if (projection.projectionSha256 !== projectionDigest(projection)) fail(`${paperId} projection SHA does not bind its content`);
    return canonical(projection);
}

function normalizePaperState(value, paperId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${paperId} state is malformed`);
    if (!Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, value.status)) fail(`${paperId} has an unknown state`);
    const state = { status: value.status, usage: normalizeUsage(value.usage) };
    if (state.status === 'completed') {
        state.projection = normalizeProjection(value.projection, paperId);
        if (value.reason !== undefined) fail(`${paperId} completed state cannot have a reason`);
    } else {
        if (value.projection !== undefined && value.projection !== null) fail(`${paperId} incomplete state cannot carry a projection`);
        if (['failed', 'blocked'].includes(state.status)) {
            if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) fail(`${paperId} ${state.status} state requires a reason`);
            state.reason = value.reason;
        } else if (value.reason !== undefined) fail(`${paperId} ${state.status} state cannot have a reason`);
    }
    for (const key of Object.keys(value)) if (!['status', 'usage', 'projection', 'reason'].includes(key)) fail(`${paperId} state has unknown field ${key}`);
    return state;
}

function normalizeStates(states, paperIds) {
    if (!states || typeof states !== 'object' || Array.isArray(states)) fail('paperStates must be an object');
    const keys = Object.keys(states).sort();
    if (keys.length !== paperIds.length || keys.some((id, index) => id !== paperIds[index])) fail('paperStates do not cover the exact member set');
    return Object.fromEntries(paperIds.map(id => [id, normalizePaperState(states[id], id)]));
}

function immutableIdentity(run) {
    return {
        version: run.version, contract: run.contract, conferenceId: run.conferenceId,
        ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        taxonomyVersion: run.taxonomyVersion, selectionPolicySha256: run.selectionPolicySha256,
        members: run.members, shards: run.shards
    };
}

function stateIdentity(run) {
    return { identitySha256: run.identitySha256, paperStates: run.paperStates };
}

function createConferenceRun(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('input is malformed');
    if (typeof input.conferenceId !== 'string' || !CONFERENCE_RE.test(input.conferenceId)) fail('conferenceId is malformed');
    if (typeof input.taxonomyVersion !== 'string' || !TAXONOMY_RE.test(input.taxonomyVersion)) fail('taxonomyVersion is malformed');
    const members = normalizeMembers(input.members);
    const paperIds = members.map(member => member.paperId);
    const membershipSha256 = stableHash(members);
    if (input.membershipSha256 !== undefined && input.membershipSha256 !== membershipSha256) fail('membershipSha256 does not bind members');
    const run = {
        version: VERSION, contract: CONTRACT, conferenceId: input.conferenceId,
        ledgerSha256: assertSha(input.ledgerSha256, 'ledgerSha256'), membershipSha256,
        taxonomyVersion: input.taxonomyVersion,
        selectionPolicySha256: assertSha(input.selectionPolicySha256, 'selectionPolicySha256'),
        members, shards: normalizeShards(input.shards, paperIds),
        paperStates: Object.fromEntries(paperIds.map(id => [id, { status: 'pending', usage: normalizeUsage() }]))
    };
    if (input.paperStates !== undefined) run.paperStates = normalizeStates(input.paperStates, paperIds);
    run.identitySha256 = stableHash(immutableIdentity(run));
    run.stateSha256 = stableHash(stateIdentity(run));
    return run;
}

function assertConferenceRun(run) {
    if (!run || typeof run !== 'object' || Array.isArray(run) || run.version !== VERSION || run.contract !== CONTRACT) fail('contract/version mismatch');
    const reconstructed = createConferenceRun({
        conferenceId: run.conferenceId, ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        taxonomyVersion: run.taxonomyVersion, selectionPolicySha256: run.selectionPolicySha256,
        members: run.members, shards: run.shards, paperStates: run.paperStates
    });
    if (run.identitySha256 !== reconstructed.identitySha256) fail('immutable run identity drifted');
    if (run.stateSha256 !== reconstructed.stateSha256) fail('paper state drifted');
    const expectedKeys = new Set(['version', 'contract', 'conferenceId', 'ledgerSha256', 'membershipSha256', 'taxonomyVersion',
        'selectionPolicySha256', 'members', 'shards', 'paperStates', 'identitySha256', 'stateSha256']);
    for (const key of Object.keys(run)) if (!expectedKeys.has(key)) fail(`run has unknown field ${key}`);
    return clone(reconstructed);
}

function transitionPaperState(run, paperId, nextState) {
    const current = assertConferenceRun(run);
    assertSafeId(paperId, 'paperId');
    if (!Object.prototype.hasOwnProperty.call(current.paperStates, paperId)) fail('transition references a non-member paperId');
    const oldState = current.paperStates[paperId].status;
    const requested = normalizePaperState(nextState, paperId);
    if (!STATUS_TRANSITIONS[oldState].includes(requested.status)) fail(`illegal transition ${oldState} -> ${requested.status} for ${paperId}`);
    current.paperStates[paperId] = requested;
    current.stateSha256 = stableHash(stateIdentity(current));
    return current;
}

function usageTotals(states) {
    const totals = {};
    for (const key of USAGE_FIELDS) {
        const reported = Object.values(states).map(state => state.usage[key]).filter(value => value !== null);
        totals[key] = { sum: reported.reduce((sum, value) => sum + value, 0), reportedPapers: reported.length, totalPapers: Object.keys(states).length };
    }
    return totals;
}

// This is an intentionally projection-only handoff.  It has no incomplete
// record in `papers`; callers that need a publishable conference page must use
// `assertPublishableConferenceInput`, which rejects a partial/blocked run.
function buildConferenceAggregateInput(run) {
    const current = assertConferenceRun(run);
    const paperIds = current.members.map(member => member.paperId);
    const completedIds = paperIds.filter(id => current.paperStates[id].status === 'completed');
    const excluded = Object.fromEntries(Object.keys(STATUS_TRANSITIONS).map(status => [status,
        paperIds.filter(id => current.paperStates[id].status === status)]));
    const input = {
        version: VERSION, contract: SUMMARY_INPUT_CONTRACT, conferenceId: current.conferenceId,
        runIdentitySha256: current.identitySha256, runStateSha256: current.stateSha256,
        ledgerSha256: current.ledgerSha256, membershipSha256: current.membershipSha256,
        taxonomyVersion: current.taxonomyVersion, selectionPolicySha256: current.selectionPolicySha256,
        status: completedIds.length === paperIds.length ? 'complete' : 'partial',
        publicationEligible: completedIds.length === paperIds.length,
        papers: completedIds.map(id => ({ paperId: id, projection: current.paperStates[id].projection,
            usage: current.paperStates[id].usage })),
        excluded, usage: { allMembers: usageTotals(current.paperStates), completedMembers: usageTotals(
            Object.fromEntries(completedIds.map(id => [id, current.paperStates[id]]))) }
    };
    input.inputSha256 = stableHash({ ...input });
    return input;
}

function assertPublishableConferenceInput(input) {
    if (!input || input.version !== VERSION || input.contract !== SUMMARY_INPUT_CONTRACT || input.status !== 'complete'
        || input.publicationEligible !== true || !Array.isArray(input.papers)) {
        throw new Error('Conference aggregate input is not publishable');
    }
    if (Object.entries(input.excluded || {}).some(([status, ids]) => status !== 'completed' && Array.isArray(ids) && ids.length)) {
        throw new Error('Conference aggregate input contains excluded incomplete or blocked papers');
    }
    const { inputSha256, ...bound } = input;
    if (!isSha(inputSha256) || inputSha256 !== stableHash(bound)) throw new Error('Conference aggregate input SHA drifted');
    return clone(input);
}

module.exports = {
    VERSION, CONTRACT, PAPER_PROJECTION_CONTRACT, SUMMARY_INPUT_CONTRACT, STATUS_TRANSITIONS, USAGE_FIELDS,
    sha256, stableHash, normalizeMembers, normalizeShards, normalizeUsage, normalizeProjection,
    createConferenceRun, assertConferenceRun, transitionPaperState, buildConferenceAggregateInput,
    assertPublishableConferenceInput
};
