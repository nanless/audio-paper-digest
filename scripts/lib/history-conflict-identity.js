'use strict';

// Explicit operator resolution for historical pages whose frozen identity
// hints are conflict/multiple.  This module never reads page prose or titles.

const crypto = require('node:crypto');
const authorityApi = require('./paper-source-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');

class HistoryConflictIdentityError extends Error {
    constructor(message) {
        super(`Historical identity resolution rejected: ${message}`);
        this.name = 'HistoryConflictIdentityError';
        this.code = 'HISTORY_CONFLICT_IDENTITY_INTEGRITY';
    }
}

function fail(message) { throw new HistoryConflictIdentityError(message); }
function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function authorityHint(identity) {
    if (identity.kind === 'arxiv') return { scheme: 'arxiv', value: identity.arxivId };
    if (identity.kind === 'conference' && plain(identity.externalId)) {
        return { scheme: identity.externalId.scheme, value: identity.externalId.value };
    }
    fail('production authority has no supported exact identity');
}
function authorityReference(snapshot) {
    const authority = snapshot.authority;
    return { paperId: authority.paperId, identity: clone(authority.identity),
        identitySha256: authority.identitySha256, identityRecordSha256: authority.identityRecordSha256,
        authorityContract: authority.contract, authorityName: snapshot.authorityName,
        authorityFileSha256: snapshot.authorityFileSha256, authoritySha256: authority.authoritySha256,
        evidenceKind: authority.evidenceKind, fulltextSha256: snapshot.fulltextSha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256 };
}

function assertConflictSelection({ state, pageKey, selectedHint } = {}) {
    const checked = crosswalkApi.assertCrosswalkState(state);
    exact(selectedHint, ['scheme', 'value'], 'selectedHint');
    const paper = checked.source.papers.find(item => item.pageKey === pageKey);
    if (!paper) fail('pageKey is absent from the crosswalk');
    if (!['conflict', 'multiple'].includes(paper.identityHints.status)) {
        fail('explicit resolution is only allowed for conflict/multiple identity hints');
    }
    const matches = paper.identityHints.candidates.filter(candidate => candidate.scheme === selectedHint.scheme
        && candidate.value === selectedHint.value);
    if (matches.length !== 1) fail('selected identity is not exactly one existing page hint');
    if (!matches[0].sources.length
        || matches[0].sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) {
        fail('selected identity must be supported only by explicit non-title hints');
    }
    if (checked.assignments[pageKey].status !== 'pending') fail('only a pending page may be resolved');
    return { state: checked, paper: clone(paper), selectedHint: clone(selectedHint), candidate: clone(matches[0]) };
}

function buildConflictVerifiedDecisionArtifact({ state, pageKey, selectedHint, authorityHandle,
    operationId = crypto.randomUUID(), actorId, now } = {}) {
    const selected = assertConflictSelection({ state, pageKey, selectedHint });
    let snapshot;
    try { snapshot = authorityApi.authorityHandleSnapshot(authorityHandle); }
    catch (error) { fail(`authenticated production authority is required: ${error.message}`); }
    if (snapshot.productionAuthorized !== true) fail('production-authorized source authority is required');
    const exactAuthorityHint = authorityHint(snapshot.authority.identity);
    if (exactAuthorityHint.scheme !== selected.selectedHint.scheme
        || exactAuthorityHint.value !== selected.selectedHint.value) {
        fail('production authority does not exactly match the operator-selected page hint');
    }
    const assignment = selected.state.assignments[pageKey];
    const reason = `Operator selected existing non-title hint ${selectedHint.scheme}:${selectedHint.value}; production authority matched exactly.`;
    const body = { contract: crosswalkApi.DECISION_CONTRACT, version: crosswalkApi.VERSION,
        crosswalkId: selected.state.crosswalkId, operationId,
        expectedStateSha256: selected.state.stateSha256, pageKey,
        pagePath: assignment.pagePath, pageContentSha256: assignment.pageContentSha256,
        actorId, result: { status: 'verified', reason }, sourceAuthority: authorityReference(snapshot),
        createdAt: (now === undefined ? new Date() : new Date(now)).toISOString() };
    return crosswalkApi.normalizeDecisionArtifact({ ...body, artifactSha256: crosswalkApi.stableHash(body) });
}

function resolveConflictIdentity({ crosswalkRoot, crosswalkId, pageKey, selectedHint, authorityHandle,
    decisionName, owner, operationId, now } = {}) {
    const state = crosswalkApi.readCrosswalk({ crosswalkRoot, crosswalkId });
    const artifact = buildConflictVerifiedDecisionArtifact({ state, pageKey, selectedHint, authorityHandle,
        operationId, actorId: owner, now });
    const decisionFile = crosswalkApi.writeDecisionArtifact({ crosswalkRoot, crosswalkId, decisionName, artifact });
    const decisionHandle = crosswalkApi.loadDecisionHandle(decisionFile, { authorityHandle });
    return crosswalkApi.applyDecision({ crosswalkRoot, crosswalkId, decisionHandle, owner, now });
}

module.exports = { HistoryConflictIdentityError, authorityHint, assertConflictSelection,
    buildConflictVerifiedDecisionArtifact, resolveConflictIdentity };
