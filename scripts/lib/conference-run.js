'use strict';

// An offline, content-addressed plan for a conference rewrite.  This module is
// deliberately not a scheduler: it neither reads PDFs nor invokes an LLM nor
// writes a blog.  Its only job is to make the member set, sharding, status
// transitions and summary hand-off independently auditable.
const crypto = require('node:crypto');
const paperIdentity = require('./paper-identity.js');

const VERSION = 2;
const CONTRACT = 'conference-run-v2';
const LEDGER_BINDING_CONTRACT = 'conference-run-ledger-binding-v2';
const PAPER_PROJECTION_CONTRACT = 'conference-paper-projection-v2';
const SUMMARY_INPUT_CONTRACT = 'conference-summary-input-v2';
const COMPLETION_PROOF_REQUIRED = 'completed state requires an authenticated conference completion-proof handle';
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,319}$/;
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

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        fail(`${label} must be a plain object`);
    }
}

function assertExactFields(value, fields, label) {
    assertPlainObject(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function assertSafeId(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${label} is malformed`);
    return value;
}

function assertSha(value, label) {
    if (!isSha(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}

function normalizeMembers(members, conferenceId = null) {
    if (!Array.isArray(members) || !members.length) fail('members must be a non-empty array');
    const normalized = members.map(member => {
        assertExactFields(member, ['paperId', 'sourceIdentity'], 'member');
        const paperId = assertSafeId(member.paperId, 'member paperId');
        const sourceIdentity = assertSafeId(member.sourceIdentity, 'member sourceIdentity');
        if (conferenceId !== null) {
            const conferenceMatch = String(conferenceId).match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-(\d{4})$/);
            const sourceMatch = sourceIdentity.match(/^([^:]+):([^:]+)$/);
            if (!conferenceMatch || !sourceMatch) fail('member conference/source identity is malformed');
            const conference = { id: conferenceId, year: Number(conferenceMatch[2]) };
            const identity = { type: sourceMatch[1], value: sourceMatch[2] };
            if (paperId !== paperIdentity.canonicalConferencePaperId(conference, identity)) {
                fail(`${paperId} is not a canonical paper-identity-v1 conference ID`);
            }
        }
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
        assertExactFields(shard, ['shardId', 'paperIds'], 'shard');
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
    assertPlainObject(value, 'usage');
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
    assertExactFields(value, ['contract', 'paperId', 'sourceSha256', 'readerSha256', 'taxonomySha256',
        'scoringSha256', 'publicationSha256', 'summary', 'projectionSha256'], `${paperId} projection`);
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
    if (!projection.summary || typeof projection.summary !== 'object' || Array.isArray(projection.summary)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(projection.summary))) {
        fail(`${paperId} projection summary must be an object`);
    }
    if (projection.projectionSha256 !== projectionDigest(projection)) fail(`${paperId} projection SHA does not bind its content`);
    return canonical(projection);
}

function normalizePaperState(value, paperId) {
    assertPlainObject(value, `${paperId} state`);
    if (!Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, value.status)) fail(`${paperId} has an unknown state`);
    const allowed = value.status === 'completed' ? ['status', 'usage', 'projection']
        : ['failed', 'blocked'].includes(value.status) ? ['status', 'usage', 'reason'] : ['status', 'usage'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${paperId} state has unknown field ${key}`);
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
    return state;
}

function normalizeStates(states, paperIds) {
    assertPlainObject(states, 'paperStates');
    const keys = Object.keys(states).sort();
    if (keys.length !== paperIds.length || keys.some((id, index) => id !== paperIds[index])) fail('paperStates do not cover the exact member set');
    return Object.fromEntries(paperIds.map(id => [id, normalizePaperState(states[id], id)]));
}

function immutableIdentity(run) {
    const identity = {
        version: run.version, contract: run.contract, conferenceId: run.conferenceId,
        ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        taxonomyVersion: run.taxonomyVersion, filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256,
        selectedMemberSetSha256: run.selectedMemberSetSha256,
        members: run.members, shards: run.shards
    };
    if (run.ledgerBinding) identity.ledgerBinding = run.ledgerBinding;
    return identity;
}

function stateIdentity(run) {
    return { identitySha256: run.identitySha256, paperStates: run.paperStates };
}

function normalizeInitialStates(states, paperIds) {
    if (states === undefined) return Object.fromEntries(paperIds.map(id => [id, { status: 'pending', usage: normalizeUsage() }]));
    const normalized = normalizeStates(states, paperIds);
    for (const [paperId, state] of Object.entries(normalized)) {
        if (state.status !== 'pending' || Object.values(state.usage).some(value => value !== null)) {
            fail(`${paperId} initial state must be pending with no reported usage`);
        }
    }
    return normalized;
}

function normalizeLedgerBinding(value, members, ledgerSha256, conferenceId) {
    assertExactFields(value, ['contract', 'ledgerSha256', 'ledgerMemberSetSha256', 'conferenceId', 'members', 'bindingSha256'], 'ledgerBinding');
    if (value.contract !== LEDGER_BINDING_CONTRACT || value.ledgerSha256 !== ledgerSha256 || value.conferenceId !== conferenceId) {
        fail('ledgerBinding identity is malformed');
    }
    assertSha(value.ledgerMemberSetSha256, 'ledgerBinding ledgerMemberSetSha256');
    const bindingMembers = normalizeMembers(value.members, conferenceId);
    if (stableHash(bindingMembers) !== stableHash(members)) fail('ledgerBinding members do not bind run members');
    const { bindingSha256, ...bound } = value;
    if (!isSha(bindingSha256) || bindingSha256 !== stableHash(bound)) fail('ledgerBinding SHA does not bind its content');
    return canonical({ ...bound, bindingSha256 });
}

function createRun(input, { allowInitialStates = false, ledgerBinding = undefined } = {}) {
    assertPlainObject(input, 'input');
    const allowedInput = ['conferenceId', 'ledgerSha256', 'membershipSha256', 'taxonomyVersion',
        'filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256', 'members', 'shards', 'paperStates'];
    for (const key of Object.keys(input)) if (!allowedInput.includes(key)) fail(`input has unknown field ${key}`);
    if (typeof input.conferenceId !== 'string' || !CONFERENCE_RE.test(input.conferenceId)) fail('conferenceId is malformed');
    if (typeof input.taxonomyVersion !== 'string' || !TAXONOMY_RE.test(input.taxonomyVersion)) fail('taxonomyVersion is malformed');
    const members = normalizeMembers(input.members, input.conferenceId);
    const paperIds = members.map(member => member.paperId);
    const membershipSha256 = stableHash(members);
    if (input.membershipSha256 !== undefined && input.membershipSha256 !== membershipSha256) fail('membershipSha256 does not bind members');
    const run = {
        version: VERSION, contract: CONTRACT, conferenceId: input.conferenceId,
        ledgerSha256: assertSha(input.ledgerSha256, 'ledgerSha256'), membershipSha256,
        taxonomyVersion: input.taxonomyVersion,
        filterPolicySha256: assertSha(input.filterPolicySha256, 'filterPolicySha256'),
        selectionReceiptSha256: assertSha(input.selectionReceiptSha256, 'selectionReceiptSha256'),
        selectedMemberSetSha256: assertSha(input.selectedMemberSetSha256, 'selectedMemberSetSha256'),
        members, shards: normalizeShards(input.shards, paperIds),
        paperStates: allowInitialStates ? normalizeStates(input.paperStates, paperIds) : normalizeInitialStates(input.paperStates, paperIds)
    };
    if (ledgerBinding !== undefined) run.ledgerBinding = normalizeLedgerBinding(ledgerBinding, members, run.ledgerSha256, run.conferenceId);
    run.identitySha256 = stableHash(immutableIdentity(run));
    run.stateSha256 = stableHash(stateIdentity(run));
    return run;
}

function createConferenceRun(input) { return createRun(input); }

function ledgerMemberByIdentity(ledger, sourceIdentity) {
    const ledgerApi = require('./conference-source-ledger.js');
    const found = ledger.members.find(member => ledgerApi.identityKey(member.identity) === sourceIdentity);
    if (!found) fail(`sourceIdentity ${sourceIdentity} is not present in the supplied ledger`);
    return found;
}

function ledgerBindingForRun(run, ledger) {
    const ledgerApi = require('./conference-source-ledger.js');
    return {
        contract: LEDGER_BINDING_CONTRACT,
        ledgerSha256: run.ledgerSha256,
        ledgerMemberSetSha256: ledger.memberSetSha256,
        conferenceId: run.conferenceId,
        members: run.members.map(member => ({ ...member })),
        bindingSha256: ''
    };
}

function signLedgerBinding(binding) {
    const { bindingSha256: _ignored, ...bound } = binding;
    return { ...bound, bindingSha256: stableHash(bound) };
}

// This is the only constructor for an executable conference run.  A legacy
// `createConferenceRun` is retained only for offline draft/shape validation;
// it cannot produce aggregate or publish input.  The caller must have loaded
// the ledger bytes and supply their SHA, so a copied member list or a title
// spelling can never become a source identity.
function trustedLedger(handle) {
    const ledgerApi = require('./conference-source-ledger.js');
    try { return ledgerApi.ledgerHandleSnapshot(handle); }
    catch (error) { fail(`requires an authenticated loaded ledger handle: ${error.message}`); }
}

function createConferenceRunFromVerifiedLedger(input) {
    assertExactFields(input, ['ledgerHandle', 'taxonomyVersion', 'filterPolicySha256', 'selectionReceiptSha256',
        'selectedMemberSetSha256', 'members', 'shards'], 'verified ledger run input');
    const loaded = trustedLedger(input.ledgerHandle);
    const ledger = loaded.ledger;
    const ledgerSha256 = loaded.ledgerSha256;
    const members = normalizeMembers(input.members);
    if (input.selectedMemberSetSha256 !== stableHash(members.map(member => member.paperId))) {
        fail('selectedMemberSetSha256 does not bind the canonical selected paper IDs');
    }
    for (const member of members) {
        const source = ledgerMemberByIdentity(ledger, member.sourceIdentity);
        if (source.status.state !== 'verified') fail(`${member.sourceIdentity} is not verified in the supplied ledger`);
        if (member.paperId !== paperIdentity.canonicalConferencePaperId(ledger.conference, source.identity)) {
            fail(`${member.paperId} is not the canonical paper-identity-v1 ID for ${member.sourceIdentity}`);
        }
    }
    const provisional = {
        conferenceId: ledger.conference.id,
        ledgerSha256,
        taxonomyVersion: input.taxonomyVersion,
        filterPolicySha256: input.filterPolicySha256,
        selectionReceiptSha256: input.selectionReceiptSha256,
        selectedMemberSetSha256: input.selectedMemberSetSha256,
        members,
        shards: input.shards
    };
    const unsignedBinding = ledgerBindingForRun({ ...provisional, members }, ledger);
    return createRun(provisional, { ledgerBinding: signLedgerBinding(unsignedBinding) });
}

function assertConferenceRun(run) {
    assertPlainObject(run, 'run');
    if (run.version !== VERSION || run.contract !== CONTRACT) fail('contract/version mismatch');
    const expectedKeys = ['version', 'contract', 'conferenceId', 'ledgerSha256', 'membershipSha256', 'taxonomyVersion',
        'filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256',
        'members', 'shards', 'paperStates', 'identitySha256', 'stateSha256'];
    if (run.ledgerBinding !== undefined) expectedKeys.push('ledgerBinding');
    assertExactFields(run, expectedKeys, 'run');
    const reconstructed = createRun({
        conferenceId: run.conferenceId, ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        taxonomyVersion: run.taxonomyVersion, filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256,
        selectedMemberSetSha256: run.selectedMemberSetSha256,
        members: run.members, shards: run.shards, paperStates: run.paperStates
    }, { allowInitialStates: true, ledgerBinding: run.ledgerBinding });
    if (Object.values(reconstructed.paperStates).some(state => state.status === 'completed')) {
        fail(COMPLETION_PROOF_REQUIRED);
    }
    if (run.identitySha256 !== reconstructed.identitySha256) fail('immutable run identity drifted');
    if (run.stateSha256 !== reconstructed.stateSha256) fail('paper state drifted');
    return clone(reconstructed);
}

function assertConferenceRunFromVerifiedLedger(run, ledgerHandle) {
    const current = assertConferenceRun(run);
    const { ledger, ledgerSha256 } = trustedLedger(ledgerHandle);
    if (current.ledgerSha256 !== ledgerSha256 || current.conferenceId !== ledger.conference.id) {
        fail('run is not bound to the supplied ledger identity');
    }
    if (!current.ledgerBinding) fail('run lacks a verified ledger binding');
    const expected = signLedgerBinding(ledgerBindingForRun(current, ledger));
    if (stableHash(current.ledgerBinding) !== stableHash(expected)) fail('run ledger binding does not rebuild from the supplied ledger');
    for (const member of current.members) {
        const source = ledgerMemberByIdentity(ledger, member.sourceIdentity);
        if (source.status.state !== 'verified') fail(`${member.sourceIdentity} is not verified in the supplied ledger`);
        if (member.paperId !== paperIdentity.canonicalConferencePaperId(ledger.conference, source.identity)) {
            fail(`${member.paperId} is not the canonical paper-identity-v1 ID for ${member.sourceIdentity}`);
        }
    }
    return current;
}

function transitionPaperState(run, paperId, nextState) {
    const current = assertConferenceRun(run);
    assertSafeId(paperId, 'paperId');
    if (!Object.prototype.hasOwnProperty.call(current.paperStates, paperId)) fail('transition references a non-member paperId');
    const oldState = current.paperStates[paperId].status;
    if (nextState?.status === 'completed') fail(COMPLETION_PROOF_REQUIRED);
    const requested = normalizePaperState(nextState, paperId);
    if (!STATUS_TRANSITIONS[oldState].includes(requested.status)) fail(`illegal transition ${oldState} -> ${requested.status} for ${paperId}`);
    for (const key of USAGE_FIELDS) {
        const previous = current.paperStates[paperId].usage[key];
        const next = requested.usage[key];
        if (previous !== null && (next === null || next < previous)) {
            fail(`${paperId} usage.${key} cannot regress or be cleared`);
        }
    }
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
function assertTrustedLedgerContext(context, requireRun = false) {
    const fields = requireRun ? ['run', 'ledgerHandle'] : ['ledgerHandle'];
    assertExactFields(context, fields, 'trusted ledger context');
    if (requireRun) return assertConferenceRunFromVerifiedLedger(context.run, context.ledgerHandle);
    return trustedLedger(context.ledgerHandle);
}

function buildConferenceAggregateInput(run, trustedLedgerContext) {
    const current = assertConferenceRun(run);
    assertTrustedLedgerContext({ ...trustedLedgerContext, run: current }, true);
    const paperIds = current.members.map(member => member.paperId);
    const completedIds = paperIds.filter(id => current.paperStates[id].status === 'completed');
    const excluded = Object.fromEntries(Object.keys(STATUS_TRANSITIONS).map(status => [status,
        paperIds.filter(id => current.paperStates[id].status === status)]));
    const input = {
        version: VERSION, contract: SUMMARY_INPUT_CONTRACT, conferenceId: current.conferenceId,
        runIdentitySha256: current.identitySha256, runStateSha256: current.stateSha256,
        ledgerSha256: current.ledgerSha256, membershipSha256: current.membershipSha256,
        taxonomyVersion: current.taxonomyVersion, filterPolicySha256: current.filterPolicySha256,
        selectionReceiptSha256: current.selectionReceiptSha256,
        selectedMemberSetSha256: current.selectedMemberSetSha256,
        ledgerBinding: current.ledgerBinding,
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
    void input;
    throw new Error('Conference aggregate publishing is disabled until an authenticated completion-proof handle is implemented');
}

module.exports = {
    VERSION, CONTRACT, LEDGER_BINDING_CONTRACT, PAPER_PROJECTION_CONTRACT, SUMMARY_INPUT_CONTRACT,
    COMPLETION_PROOF_REQUIRED, STATUS_TRANSITIONS, USAGE_FIELDS,
    sha256, stableHash, normalizeMembers, normalizeShards, normalizeUsage, normalizeProjection,
    createConferenceRun, createConferenceRunFromVerifiedLedger, assertConferenceRun, assertConferenceRunFromVerifiedLedger,
    transitionPaperState, buildConferenceAggregateInput,
    assertPublishableConferenceInput
};
