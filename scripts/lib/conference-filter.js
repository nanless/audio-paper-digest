'use strict';

// Purely local conference filtering contract. This module records externally
// produced decisions; it never calls a model, reads data/current, or publishes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const discoveryApi = require('./conference-discovery.js');
const paperIdentity = require('./paper-identity.js');

const VERSION = 2;
const CONTRACT = 'conference-filter-v2';
const SPEC_CONTRACT = 'conference-filter-spec-v2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PAPER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,319}$/;
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'anthropic-messages']);
const DECISION_STATUSES = new Set(['pending', 'included', 'excluded', 'failed']);
const FINAL_STATUSES = new Set(['included', 'excluded']);
const DECISION_CONTRACT = 'conference-filter-decision-v2';
const SELECTION_RECEIPT_CONTRACT = 'conference-filter-selection-receipt-v2';
const SELECTION_HANDLE_CONTRACT = 'conference-filter-selection-v2';
const ACTOR_TYPES = new Set(['llm', 'manual']);
const MAX_DECISION_PAYLOAD_BYTES = 32 * 1024 * 1024;
const DECISION_HANDLES = new WeakSet();
const DECISION_HANDLE_DATA = new WeakMap();
const SELECTION_HANDLES = new WeakSet();
const SELECTION_HANDLE_DATA = new WeakMap();

function fail(message) { throw new Error(`Invalid conference filter: ${message}`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!isPlainObject(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableHash(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return sha256(JSON.stringify(normalize(value)));
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}
function nonempty(value, label, pattern) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
        || /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
        fail(`${label} is malformed`);
    }
    return value;
}
function timestamp(value, label) {
    nonempty(value, label);
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(date.getTime()) || date.toISOString() !== value) fail(`${label} must be canonical UTC ISO time`);
    return value;
}
function nowIso(now) {
    const value = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    if (Number.isNaN(value.getTime())) fail('now is invalid');
    return value.toISOString();
}

function normalizeCatalog(value) {
    exact(value, ['contract', 'conferenceId', 'catalogSha256', 'members'], 'catalog');
    const contract = nonempty(value.contract, 'catalog.contract', /^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/);
    const conferenceId = nonempty(value.conferenceId, 'catalog.conferenceId', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const catalogSha256 = assertSha(value.catalogSha256, 'catalog.catalogSha256');
    if (!Array.isArray(value.members) || !value.members.length) fail('catalog.members must be a nonempty array');
    const members = value.members.map((member, index) => {
        exact(member, ['paperId', 'sourceSha256'], `catalog.members[${index}]`);
        return { paperId: nonempty(member.paperId, `catalog.members[${index}].paperId`, PAPER_ID_RE),
            sourceSha256: assertSha(member.sourceSha256, `catalog.members[${index}].sourceSha256`) };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(members.map(member => member.paperId)).size !== members.length) fail('catalog contains duplicate paperId values');
    return { contract, conferenceId, catalogSha256, members };
}

function adaptDiscoveryCatalog(discoveryDocument, { documentSha256, adapter } = {}) {
    if (typeof adapter !== 'function') fail('a discovery catalog adapter callback is required');
    assertSha(documentSha256, 'discovery document SHA');
    const catalog = normalizeCatalog(adapter(clone(discoveryDocument), { documentSha256 }));
    if (catalog.catalogSha256 !== documentSha256) fail('catalog SHA does not bind the discovery document bytes');
    return catalog;
}

function trustedDiscovery(handle) {
    try { return discoveryApi.discoveryHandleSnapshot(handle); }
    catch (error) { fail(`requires an authenticated discovery handle: ${error.message}`); }
}

function catalogFromDiscoveryHandle(handle) {
    const snapshot = trustedDiscovery(handle);
    const catalog = discoveryDocumentToFilterCatalog(snapshot.candidateManifest, { documentSha256: snapshot.catalogSha256 });
    if (snapshot.report.candidateManifestSha256 !== snapshot.catalogSha256) {
        fail('discovery report does not bind the catalog bytes');
    }
    return catalog;
}

function discoveryDocumentToFilterCatalog(value, { documentSha256 } = {}) {
    exact(value, ['contract', 'version', 'adapter', 'conference', 'metadataSnapshot', 'pdfRoot',
        'pdfCatalogSha256', 'pdfCatalog', 'members', 'memberSetSha256'], 'discovery document');
    if (value.contract !== discoveryApi.CONTRACT || value.version !== discoveryApi.VERSION
        || !['icassp', 'iclr', 'icml'].includes(value.adapter)) fail('discovery document contract/adapter is unsupported');
    exact(value.conference, ['id', 'year'], 'discovery conference');
    const conferenceId = nonempty(value.conference.id, 'discovery conference.id', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    if (!Number.isInteger(value.conference.year) || value.conference.year < 1900 || value.conference.year > 2100
        || conferenceId !== `${value.adapter}-${value.conference.year}`) fail('discovery conference identity is inconsistent');
    exact(value.metadataSnapshot, ['file', 'sha256', 'size'], 'discovery metadataSnapshot');
    if (typeof value.metadataSnapshot.file !== 'string' || !path.isAbsolute(value.metadataSnapshot.file)
        || !Number.isSafeInteger(value.metadataSnapshot.size) || value.metadataSnapshot.size < 1) fail('discovery metadataSnapshot is malformed');
    assertSha(value.metadataSnapshot.sha256, 'discovery metadataSnapshot.sha256');
    if (typeof value.pdfRoot !== 'string' || !path.isAbsolute(value.pdfRoot)) fail('discovery pdfRoot must be absolute');
    if (!Array.isArray(value.pdfCatalog)) fail('discovery pdfCatalog must be an array');
    const pdfPaths = new Set();
    for (const [index, item] of value.pdfCatalog.entries()) {
        exact(item, ['path', 'sha256', 'size'], `discovery pdfCatalog[${index}]`);
        ledgerApi.assertRelativePath(item.path, `discovery pdfCatalog[${index}].path`);
        assertSha(item.sha256, `discovery pdfCatalog[${index}].sha256`);
        if (!Number.isSafeInteger(item.size) || item.size < 5 || pdfPaths.has(item.path)) fail('discovery pdfCatalog is malformed or duplicated');
        pdfPaths.add(item.path);
    }
    if (assertSha(value.pdfCatalogSha256, 'discovery pdfCatalogSha256') !== ledgerApi.stableHash(value.pdfCatalog)) {
        fail('discovery pdfCatalog SHA drifted');
    }
    if (!Array.isArray(value.members) || !value.members.length) fail('discovery members must be nonempty');
    if (assertSha(value.memberSetSha256, 'discovery memberSetSha256') !== ledgerApi.memberSetSha256(value.members)) {
        fail('discovery member set SHA drifted');
    }
    const members = value.members.map((member, index) => {
        exact(member, ['identity', 'metadataIndex', 'title', 'numericAlias', 'match'], `discovery member[${index}]`);
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        if (!Number.isSafeInteger(member.metadataIndex) || member.metadataIndex < 0
            || typeof member.title !== 'string' || !member.title.trim()) fail(`discovery member[${index}] metadata is malformed`);
        if (member.numericAlias !== null && (typeof member.numericAlias !== 'string' || !/^[1-9]\d*$/.test(member.numericAlias))) {
            fail(`discovery member[${index}] numericAlias is malformed`);
        }
        exact(member.match, ['kind', 'candidates'], `discovery member[${index}].match`);
        if (!['exact', 'normalized', 'ambiguous', 'unmatched'].includes(member.match.kind)
            || !Array.isArray(member.match.candidates)) fail(`discovery member[${index}] match is malformed`);
        for (const candidate of member.match.candidates) {
            exact(candidate, ['path', 'sha256', 'size'], `discovery member[${index}] candidate`);
            if (!pdfPaths.has(candidate.path)) fail(`discovery member[${index}] references a PDF outside the catalog`);
            assertSha(candidate.sha256, `discovery member[${index}] candidate SHA`);
        }
        const paperId = paperIdentity.canonicalConferencePaperId(value.conference, member.identity);
        const sourceSha256 = stableHash({ documentSha256, metadataSnapshotSha256: value.metadataSnapshot.sha256,
            pdfCatalogSha256: value.pdfCatalogSha256, identity: member.identity,
            metadataIndex: member.metadataIndex, match: member.match });
        return { paperId, sourceSha256 };
    });
    return normalizeCatalog({ contract: 'conference-discovery-catalog-v2', conferenceId,
        catalogSha256: assertSha(documentSha256, 'discovery document SHA'), members });
}

function normalizeSpec(value) {
    exact(value, ['contract', 'version', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol', 'taxonomyRegistrySha256'], 'filter spec');
    if (value.contract !== SPEC_CONTRACT || value.version !== VERSION) fail('filter spec contract/version mismatch');
    const model = nonempty(value.model, 'filter spec model', /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);
    if (!PROTOCOLS.has(value.endpointProtocol)) fail('filter spec endpointProtocol is unsupported');
    return {
        contract: SPEC_CONTRACT, version: VERSION,
        filterPolicySha256: assertSha(value.filterPolicySha256, 'filter spec filterPolicySha256'),
        promptSha256: assertSha(value.promptSha256, 'filter spec promptSha256'), model,
        endpointProtocol: value.endpointProtocol,
        taxonomyRegistrySha256: assertSha(value.taxonomyRegistrySha256, 'filter spec taxonomyRegistrySha256')
    };
}

function inputBinding(catalog, spec) {
    const normalizedCatalog = normalizeCatalog(catalog); const normalizedSpec = normalizeSpec(spec);
    const candidateSetSha256 = stableHash(normalizedCatalog.members);
    const bound = {
        discoveryContract: normalizedCatalog.contract, conferenceId: normalizedCatalog.conferenceId,
        catalogSha256: normalizedCatalog.catalogSha256, candidateSetSha256,
        filterPolicySha256: normalizedSpec.filterPolicySha256, promptSha256: normalizedSpec.promptSha256,
        model: normalizedSpec.model, endpointProtocol: normalizedSpec.endpointProtocol,
        taxonomyRegistrySha256: normalizedSpec.taxonomyRegistrySha256
    };
    return { ...bound, inputSha256: stableHash(bound) };
}

function normalizeUsage(value = {}) {
    if (!isPlainObject(value)) fail('usage must be a plain object');
    const allowed = ['requests', 'inputTokens', 'outputTokens', 'totalTokens'];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('usage has unknown fields');
    const normalized = {};
    for (const field of allowed) {
        const number = value[field] === undefined ? 0 : value[field];
        if (field !== 'requests' && number === null) { normalized[field] = null; continue; }
        if (!Number.isSafeInteger(number) || number < 0) fail(`usage.${field} must be a nonnegative safe integer${field === 'requests' ? '' : ' or null'}`);
        normalized[field] = number;
    }
    const tokenValues = [normalized.inputTokens, normalized.outputTokens, normalized.totalTokens];
    if (tokenValues.every(Number.isSafeInteger) && normalized.totalTokens !== normalized.inputTokens + normalized.outputTokens) {
        fail('usage.totalTokens must equal inputTokens + outputTokens');
    }
    if (normalized.totalTokens !== null && (normalized.inputTokens === null || normalized.outputTokens === null)) {
        fail('usage.totalTokens must be null when an input/output token count is unavailable');
    }
    return normalized;
}
function usageAtLeast(previous, next) {
    return ['requests', 'inputTokens', 'outputTokens', 'totalTokens'].every(field => {
        if (previous[field] === null) return next[field] === null || Number.isSafeInteger(next[field]);
        return next[field] !== null && next[field] >= previous[field];
    });
}
function normalizeResult(value, { allowPending = false } = {}) {
    exact(value, ['status', 'reason', 'responseSha256', 'usage'], 'decision result');
    if (!DECISION_STATUSES.has(value.status) || (!allowPending && value.status === 'pending')) fail('decision status is unsupported');
    const usage = normalizeUsage(value.usage);
    if (value.status === 'pending') {
        if (value.reason !== null || value.responseSha256 !== null || Object.values(usage).some(Boolean)) {
            fail('pending decision cannot contain reason, response, or usage');
        }
    } else {
        nonempty(value.reason, 'decision reason');
        if (value.reason.length > 4000) fail('decision reason is too long');
        if (FINAL_STATUSES.has(value.status)) assertSha(value.responseSha256, 'decision responseSha256');
        else if (value.responseSha256 !== null) assertSha(value.responseSha256, 'decision responseSha256');
    }
    return { status: value.status, reason: value.reason, responseSha256: value.responseSha256, usage };
}

function normalizeActor(value) {
    exact(value, ['type', 'id'], 'decision actor');
    if (!ACTOR_TYPES.has(value.type)) fail('decision actor.type must be llm or manual');
    return { type: value.type, id: nonempty(value.id, 'decision actor.id', OWNER_RE) };
}

function normalizeByteRecord(value, label, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    exact(value, ['encoding', 'size', 'sha256', 'data'], label);
    if (value.encoding !== 'base64' || typeof value.data !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
        fail(`${label} must contain canonical base64 bytes`);
    }
    const bytes = Buffer.from(value.data, 'base64');
    if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_DECISION_PAYLOAD_BYTES || bytes.length !== value.size
        || bytes.toString('base64') !== value.data) fail(`${label} size/base64 is inconsistent`);
    if (assertSha(value.sha256, `${label}.sha256`) !== sha256(bytes)) fail(`${label} SHA drifted`);
    return { encoding: 'base64', size: bytes.length, sha256: value.sha256, data: value.data };
}

function byteRecord(value, label) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (!bytes.length) fail(`${label} bytes must be nonempty`);
    return { encoding: 'base64', size: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64') };
}

function decisionArtifactDigest(value) {
    const copy = clone(value); delete copy.artifactSha256;
    return stableHash(copy);
}

function normalizeDecisionArtifact(value) {
    exact(value, ['contract', 'version', 'filterId', 'operationId', 'expectedStateSha256', 'paperId',
        'sourceSha256', 'actor', 'model', 'endpointProtocol', 'request', 'response', 'result', 'createdAt',
        'artifactSha256'], 'decision artifact');
    if (value.contract !== DECISION_CONTRACT || value.version !== VERSION) fail('decision artifact contract/version mismatch');
    nonempty(value.filterId, 'decision artifact filterId', UUID_RE);
    nonempty(value.operationId, 'decision artifact operationId', UUID_RE);
    assertSha(value.expectedStateSha256, 'decision artifact expectedStateSha256');
    nonempty(value.paperId, 'decision artifact paperId', PAPER_ID_RE);
    assertSha(value.sourceSha256, 'decision artifact sourceSha256');
    const actor = normalizeActor(value.actor);
    const request = normalizeByteRecord(value.request, 'decision request');
    const response = normalizeByteRecord(value.response, 'decision response', { nullable: true });
    const result = normalizeResult(value.result);
    timestamp(value.createdAt, 'decision artifact createdAt');
    if (actor.type === 'llm') {
        nonempty(value.model, 'decision artifact model', /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);
        if (!PROTOCOLS.has(value.endpointProtocol)) fail('LLM decision endpointProtocol is unsupported');
        if (result.usage.requests < 1) fail('LLM decision must record at least one request');
        if (FINAL_STATUSES.has(result.status)
            && !((result.usage.outputTokens === null && result.usage.totalTokens === null)
                || (result.usage.outputTokens > 0 && result.usage.totalTokens > 0))) {
            fail('final LLM decision must record positive output/total tokens or explicit null when unavailable');
        }
    } else if (value.model !== null || value.endpointProtocol !== 'manual'
        || Object.values(result.usage).some(number => number !== 0)) {
        fail('manual decision must use model=null, protocol=manual, and zero token usage');
    }
    if (FINAL_STATUSES.has(result.status)) {
        if (!response) fail('final decision requires preserved response bytes');
        if (result.responseSha256 !== response.sha256) fail('final decision response SHA does not bind preserved bytes');
    } else if (response && result.responseSha256 !== response.sha256) {
        fail('failed decision response SHA does not bind preserved bytes');
    }
    assertSha(value.artifactSha256, 'decision artifactSha256');
    if (value.artifactSha256 !== decisionArtifactDigest(value)) fail('decision artifact SHA drifted');
    return clone(value);
}

function buildDecisionArtifact({ state, paperId, operationId = crypto.randomUUID(), actor, model = null,
    endpointProtocol = 'manual', requestBytes, responseBytes = null, status, reason, usage = {}, now } = {}) {
    const checked = assertFilterState(state);
    nonempty(paperId, 'decision artifact paperId', PAPER_ID_RE);
    if (!Object.prototype.hasOwnProperty.call(checked.decisions, paperId)) fail('decision artifact references a non-candidate paper');
    const response = responseBytes === null ? null : byteRecord(responseBytes, 'decision response');
    const artifact = { contract: DECISION_CONTRACT, version: VERSION, filterId: checked.filterId, operationId,
        expectedStateSha256: checked.stateSha256, paperId,
        sourceSha256: checked.decisions[paperId].sourceSha256, actor, model, endpointProtocol,
        request: byteRecord(requestBytes, 'decision request'), response,
        result: { status, reason, responseSha256: response?.sha256 || null, usage: normalizeUsage(usage) },
        createdAt: nowIso(now), artifactSha256: '' };
    artifact.artifactSha256 = decisionArtifactDigest(artifact);
    return normalizeDecisionArtifact(artifact);
}
function initialDecision(sourceSha256) {
    return { sourceSha256, status: 'pending', reason: null, responseSha256: null, usage: normalizeUsage() };
}
function normalizeDecision(value, paperId) {
    exact(value, ['sourceSha256', 'status', 'reason', 'responseSha256', 'usage'], `decision ${paperId}`);
    return { sourceSha256: assertSha(value.sourceSha256, `decision ${paperId} sourceSha256`),
        ...normalizeResult({ status: value.status, reason: value.reason, responseSha256: value.responseSha256, usage: value.usage }, { allowPending: true }) };
}

function completionFor(decisions) {
    const counts = { included: 0, excluded: 0, pending: 0, failed: 0 };
    for (const decision of Object.values(decisions)) counts[decision.status] += 1;
    const bound = { total: Object.keys(decisions).length, ...counts,
        status: counts.pending === 0 && counts.failed === 0 ? 'complete' : 'pending' };
    return { ...bound, decisionSetSha256: stableHash(decisions) };
}
function normalizeCompletion(value, decisions) {
    exact(value, ['total', 'included', 'excluded', 'pending', 'failed', 'status', 'decisionSetSha256'], 'completion');
    const expected = completionFor(decisions);
    if (stableHash(value) !== stableHash(expected)) fail('completion does not close over the complete candidate set');
    return expected;
}

function stateDigest(state) {
    return stableHash({ filterId: state.filterId, createdAt: state.createdAt, input: state.input,
        decisions: state.decisions, completion: state.completion,
        attempts: state.attempts.map(({ nextStateSha256: _next, ...attempt }) => attempt) });
}
function normalizePatch(value) {
    exact(value, ['operationId', 'expectedStateSha256', 'paperId', 'result'], 'filter patch');
    nonempty(value.operationId, 'patch operationId', UUID_RE); assertSha(value.expectedStateSha256, 'patch expectedStateSha256');
    const paperId = nonempty(value.paperId, 'patch paperId', PAPER_ID_RE);
    return { operationId: value.operationId, expectedStateSha256: value.expectedStateSha256,
        paperId, result: normalizeResult(value.result) };
}

function assertFilterState(value) {
    exact(value, ['version', 'contract', 'filterId', 'createdAt', 'input', 'decisions', 'completion', 'attempts', 'stateSha256'], 'filter state');
    if (value.version !== VERSION || value.contract !== CONTRACT) fail('contract/version mismatch');
    nonempty(value.filterId, 'filterId', UUID_RE); timestamp(value.createdAt, 'createdAt');
    exact(value.input, ['discoveryContract', 'conferenceId', 'catalogSha256', 'candidateSetSha256', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol', 'taxonomyRegistrySha256', 'inputSha256'], 'input binding');
    const inputWithoutSha = { ...value.input }; delete inputWithoutSha.inputSha256;
    for (const field of ['catalogSha256', 'candidateSetSha256', 'filterPolicySha256', 'promptSha256', 'taxonomyRegistrySha256']) assertSha(value.input[field], `input.${field}`);
    nonempty(value.input.discoveryContract, 'input.discoveryContract'); nonempty(value.input.conferenceId, 'input.conferenceId');
    nonempty(value.input.model, 'input.model'); if (!PROTOCOLS.has(value.input.endpointProtocol)) fail('input endpoint protocol is unsupported');
    assertSha(value.input.inputSha256, 'input.inputSha256');
    if (value.input.inputSha256 !== stableHash(inputWithoutSha)) fail('input binding SHA drifted');
    if (!isPlainObject(value.decisions) || !Object.keys(value.decisions).length) fail('decisions must cover a nonempty candidate set');
    const paperIds = Object.keys(value.decisions);
    if (paperIds.some((paperId, index) => !PAPER_ID_RE.test(paperId) || (index > 0 && paperIds[index - 1].localeCompare(paperId) >= 0))) {
        fail('decision paperIds must be unique and canonically sorted');
    }
    const decisions = Object.fromEntries(paperIds.map(paperId => [paperId, normalizeDecision(value.decisions[paperId], paperId)]));
    if (stableHash(paperIds.map(paperId => ({ paperId, sourceSha256: decisions[paperId].sourceSha256 }))) !== value.input.candidateSetSha256) {
        fail('decisions do not bind the catalog candidate/source set');
    }
    if (!Array.isArray(value.attempts)) fail('attempts must be an array');
    const initial = Object.fromEntries(paperIds.map(paperId => [paperId, initialDecision(decisions[paperId].sourceSha256)]));
    const replayed = clone(initial); const attempts = []; const operations = new Set();
    const base = { version: VERSION, contract: CONTRACT, filterId: value.filterId, createdAt: value.createdAt,
        input: clone(value.input), decisions: clone(initial), completion: completionFor(initial), attempts: [] };
    let previousDigest = stateDigest(base); let previousTime = value.createdAt;
    for (const [index, rawAttempt] of value.attempts.entries()) {
        exact(rawAttempt, ['operationId', 'paperId', 'fromStatus', 'toStatus', 'reason', 'responseSha256', 'usage',
            'recordedAt', 'priorStateSha256', 'nextStateSha256', 'patchSha256', 'patch',
            'decisionArtifactName', 'decisionArtifactSha256', 'decisionArtifactFileSha256'], `attempt[${index}]`);
        const patch = normalizePatch(rawAttempt.patch);
        nonempty(rawAttempt.operationId, `attempt[${index}].operationId`, UUID_RE);
        if (operations.has(rawAttempt.operationId)) fail('attempt operationId is duplicated');
        if (patch.operationId !== rawAttempt.operationId || patch.paperId !== rawAttempt.paperId
            || patch.expectedStateSha256 !== rawAttempt.priorStateSha256) fail('attempt patch does not bind its receipt');
        assertSha(rawAttempt.patchSha256, `attempt[${index}].patchSha256`);
        assertSha(rawAttempt.decisionArtifactSha256, `attempt[${index}].decisionArtifactSha256`);
        assertSha(rawAttempt.decisionArtifactFileSha256, `attempt[${index}].decisionArtifactFileSha256`);
        if (!SAFE_JSON_NAME.test(String(rawAttempt.decisionArtifactName || ''))) fail(`attempt[${index}] decision artifact name is unsafe`);
        if (rawAttempt.patchSha256 !== stableHash(patch)) fail('attempt patch SHA drifted');
        if (!Object.prototype.hasOwnProperty.call(replayed, rawAttempt.paperId)) fail('attempt references a non-candidate paper');
        if (rawAttempt.fromStatus !== replayed[rawAttempt.paperId].status || rawAttempt.toStatus !== patch.result.status) fail('attempt status history is discontinuous');
        if (FINAL_STATUSES.has(rawAttempt.fromStatus)) fail('a final decision cannot be changed');
        if (!usageAtLeast(replayed[rawAttempt.paperId].usage, patch.result.usage)) fail('attempt usage regresses');
        const receiptResult = normalizeResult({ status: rawAttempt.toStatus, reason: rawAttempt.reason,
            responseSha256: rawAttempt.responseSha256, usage: rawAttempt.usage });
        if (stableHash(receiptResult) !== stableHash(patch.result)) fail('attempt receipt does not bind the patch result');
        timestamp(rawAttempt.recordedAt, `attempt[${index}].recordedAt`);
        if (rawAttempt.recordedAt < previousTime) fail('attempt recordedAt moves backwards');
        assertSha(rawAttempt.priorStateSha256, `attempt[${index}].priorStateSha256`);
        assertSha(rawAttempt.nextStateSha256, `attempt[${index}].nextStateSha256`);
        if (rawAttempt.priorStateSha256 !== previousDigest) fail('attempt compare-and-swap history is discontinuous');
        replayed[rawAttempt.paperId] = { sourceSha256: replayed[rawAttempt.paperId].sourceSha256, ...patch.result };
        attempts.push({ ...clone(rawAttempt), patch }); operations.add(rawAttempt.operationId);
        const prefix = { ...base, decisions: clone(replayed), completion: completionFor(replayed), attempts: clone(attempts) };
        const nextDigest = stateDigest(prefix);
        if (rawAttempt.nextStateSha256 !== nextDigest) fail('attempt nextStateSha256 does not bind reconstructed state');
        previousDigest = nextDigest; previousTime = rawAttempt.recordedAt;
    }
    if (stableHash(replayed) !== stableHash(decisions)) fail('decisions do not match append-only attempt history');
    const completion = normalizeCompletion(value.completion, decisions);
    const rebuilt = { version: VERSION, contract: CONTRACT, filterId: value.filterId, createdAt: value.createdAt,
        input: clone(value.input), decisions, completion, attempts };
    const digest = stateDigest(rebuilt); assertSha(value.stateSha256, 'stateSha256');
    if (value.stateSha256 !== digest) fail('state SHA drifted');
    if (attempts.length && attempts.at(-1).nextStateSha256 !== digest) fail('last attempt does not bind current state');
    return { ...rebuilt, stateSha256: digest };
}

function assertBoundInputs(state, { catalog, spec }) {
    const checked = assertFilterState(state); const expected = inputBinding(catalog, spec);
    if (stableHash(checked.input) !== stableHash(expected)) fail('catalog, source, prompt, model, protocol, policy, or taxonomy input drifted');
    return checked;
}

function safeDirectory(root, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('filter root must be absolute');
    const normalized = path.resolve(root); if (create) fs.mkdirSync(normalized, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(normalized) !== normalized) fail('filter root is unsafe');
    return normalized;
}
function filterDirectory(root, filterId, { create = false } = {}) {
    const safeRoot = safeDirectory(root, create); nonempty(filterId, 'filterId', UUID_RE);
    const target = path.resolve(safeRoot, filterId); if (path.dirname(target) !== safeRoot) fail('filter directory escapes root');
    if (create) {
        try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail('filter directory is unsafe');
    return target;
}
function safeDirectJson(directory, name, { mustExist = true } = {}) {
    const root = safeDirectory(directory);
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) fail('unsafe direct JSON filename');
    const target = path.resolve(root, name); if (path.dirname(target) !== root) fail('JSON file escapes controlled directory');
    if (mustExist) {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('controlled JSON file is unsafe');
    }
    return target;
}
function readJson(filename, label) {
    try { return ledgerApi.readRegularJson(filename); } catch (error) { fail(`${label}: ${error.message}`); }
}
function writeExclusive(filename, bytes) {
    let fd; let created = false;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = true;
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } catch (error) {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        if (created) {
            try { fs.unlinkSync(filename); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function replaceRegular(filename, bytes) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('state file is unsafe');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`); let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
function acquireLock(directory, owner, now) {
    nonempty(owner, 'owner', OWNER_RE); const filename = path.join(directory, 'operation.lock'); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify({ owner, acquiredAt: nowIso(now) })}\n`); fs.fsyncSync(fd);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Conference filter is locked by another operation');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return filename;
}
function releaseLock(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('operation lock changed while held');
    fs.unlinkSync(filename);
}

function prepareFilter({ filterRoot, discoveryHandle, spec, filterId = crypto.randomUUID(), now } = {}) {
    const normalizedCatalog = catalogFromDiscoveryHandle(discoveryHandle); const normalizedSpec = normalizeSpec(spec);
    const root = safeDirectory(filterRoot, true); nonempty(filterId, 'filterId', UUID_RE);
    const decisions = Object.fromEntries(normalizedCatalog.members.map(member => [member.paperId, initialDecision(member.sourceSha256)]));
    const state = { version: VERSION, contract: CONTRACT, filterId, createdAt: nowIso(now),
        input: inputBinding(normalizedCatalog, normalizedSpec), decisions, completion: completionFor(decisions), attempts: [] };
    state.stateSha256 = stateDigest(state);
    const directory = path.join(root, filterId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readFilter({ filterRoot: root, filterId });
        return assertBoundInputs(existing, { catalog: normalizedCatalog, spec: normalizedSpec });
    }
    try {
        fs.mkdirSync(path.join(directory, 'decisions'), { mode: 0o700 });
        writeExclusive(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) { throw fail(`could not create filter state: ${error.message}`); }
    return assertFilterState(state);
}
function readFilter({ filterRoot, filterId } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const state = assertFilterState(readJson(safeDirectJson(directory, 'state.json'), 'filter state').value);
    for (const [index, attempt] of state.attempts.entries()) {
        const filename = safeDirectJson(path.join(directory, 'decisions'), attempt.decisionArtifactName);
        const loaded = readJson(filename, `decision artifact for attempt ${index}`);
        const artifact = normalizeDecisionArtifact(loaded.value);
        if (loaded.sha256 !== attempt.decisionArtifactFileSha256
            || artifact.artifactSha256 !== attempt.decisionArtifactSha256
            || artifact.filterId !== filterId || artifact.operationId !== attempt.operationId
            || artifact.expectedStateSha256 !== attempt.priorStateSha256
            || artifact.paperId !== attempt.paperId || artifact.sourceSha256 !== state.decisions[attempt.paperId].sourceSha256
            || stableHash(artifact.result) !== stableHash(attempt.patch.result)
            || (artifact.actor.type === 'llm' && (artifact.model !== state.input.model
                || artifact.endpointProtocol !== state.input.endpointProtocol))) {
            fail(`attempt[${index}] decision artifact replay drifted`);
        }
    }
    return state;
}
function writeDecisionArtifact({ filterRoot, filterId, decisionName, artifact } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const normalized = normalizeDecisionArtifact(artifact);
    if (normalized.filterId !== filterId) fail('decision artifact belongs to another filter');
    const filename = safeDirectJson(path.join(directory, 'decisions'), decisionName, { mustExist: false });
    try { writeExclusive(filename, `${JSON.stringify(normalized, null, 2)}\n`); }
    catch (error) { fail(`could not preserve decision artifact exclusively: ${error.message}`); }
    return filename;
}

function loadDecisionHandle(filename) {
    const loaded = readJson(filename, 'decision artifact');
    const artifact = normalizeDecisionArtifact(loaded.value);
    const handle = Object.freeze(Object.create(null));
    DECISION_HANDLES.add(handle);
    DECISION_HANDLE_DATA.set(handle, Object.freeze({ artifact, fileSha256: loaded.sha256, filename }));
    return handle;
}

function decisionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !DECISION_HANDLES.has(handle)) fail('requires an authenticated decision artifact handle');
    const loaded = DECISION_HANDLE_DATA.get(handle);
    return { artifact: clone(loaded.artifact), fileSha256: loaded.fileSha256, filename: loaded.filename };
}

function selectionReceiptFor(state) {
    const checked = assertFilterState(state);
    if (checked.completion.status !== 'complete') fail('selection receipt requires a complete filter');
    const artifacts = new Map(checked.attempts.map(attempt => [attempt.paperId, attempt.decisionArtifactSha256]));
    const included = Object.entries(checked.decisions).filter(([, decision]) => decision.status === 'included')
        .map(([paperId, decision]) => ({ paperId, sourceSha256: decision.sourceSha256,
            decisionArtifactSha256: artifacts.get(paperId) }));
    const selectedMemberSetSha256 = stableHash(included.map(item => item.paperId));
    const bound = { contract: SELECTION_RECEIPT_CONTRACT, version: VERSION, filterId: checked.filterId,
        inputSha256: checked.input.inputSha256, stateSha256: checked.stateSha256,
        filterPolicySha256: checked.input.filterPolicySha256, selectedMemberSetSha256,
        completionSha256: stableHash(checked.completion), included };
    return { ...bound, selectionReceiptSha256: stableHash(bound) };
}

function normalizeSelectionReceipt(value, state) {
    exact(value, ['contract', 'version', 'filterId', 'inputSha256', 'stateSha256', 'filterPolicySha256',
        'selectedMemberSetSha256', 'completionSha256', 'included', 'selectionReceiptSha256'], 'selection receipt');
    const expected = selectionReceiptFor(state);
    if (stableHash(value) !== stableHash(expected)) fail('selection receipt drifted or includes an excluded identity');
    return expected;
}

function readSelectionReceipt({ filterRoot, filterId } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const state = readFilter({ filterRoot, filterId });
    const loaded = readJson(safeDirectJson(directory, 'selection-receipt.json'), 'selection receipt');
    return normalizeSelectionReceipt(loaded.value, state);
}

function ensureSelectionReceipt(directory, state) {
    const checked = assertFilterState(state);
    if (checked.completion.status !== 'complete') return null;
    const receipt = selectionReceiptFor(checked);
    const receiptFile = path.join(directory, 'selection-receipt.json');
    try { writeExclusive(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        normalizeSelectionReceipt(readJson(receiptFile, 'selection receipt').value, checked);
    }
    return receipt;
}

function loadSelectionHandle(filterRoot, filterId, discoveryHandle) {
    const discovery = trustedDiscovery(discoveryHandle);
    const catalog = catalogFromDiscoveryHandle(discoveryHandle);
    const state = readFilter({ filterRoot, filterId });
    const expectedCandidates = stableHash(catalog.members);
    if (state.input.discoveryContract !== catalog.contract
        || state.input.conferenceId !== catalog.conferenceId
        || state.input.catalogSha256 !== catalog.catalogSha256
        || state.input.candidateSetSha256 !== expectedCandidates) {
        fail('selection state does not bind the authenticated discovery snapshot');
    }
    const receipt = readSelectionReceipt({ filterRoot, filterId });
    if (receipt.stateSha256 !== state.stateSha256) fail('selection state changed while loading its receipt');
    const identities = new Map(discovery.candidateManifest.members.map(member => {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        return [paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, member.identity), sourceIdentity];
    }));
    const included = receipt.included.map(item => {
        const sourceIdentity = identities.get(item.paperId);
        if (!sourceIdentity) fail('selection receipt identity is absent from discovery snapshot');
        return { paperId: item.paperId, sourceIdentity, sourceSha256: item.sourceSha256,
            decisionArtifactSha256: item.decisionArtifactSha256 };
    });
    const snapshot = { contract: SELECTION_HANDLE_CONTRACT, version: VERSION,
        filterId: state.filterId, conferenceId: state.input.conferenceId,
        catalogSha256: state.input.catalogSha256, inputSha256: state.input.inputSha256,
        stateSha256: state.stateSha256, filterPolicySha256: receipt.filterPolicySha256,
        selectedMemberSetSha256: receipt.selectedMemberSetSha256,
        selectionReceiptSha256: receipt.selectionReceiptSha256, included };
    const handle = Object.freeze(Object.create(null));
    SELECTION_HANDLES.add(handle); SELECTION_HANDLE_DATA.set(handle, Object.freeze(clone(snapshot)));
    return handle;
}

function selectionHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !SELECTION_HANDLES.has(handle)) {
        fail('requires an authenticated filter selection handle');
    }
    return clone(SELECTION_HANDLE_DATA.get(handle));
}

function applyDecision({ filterRoot, filterId, decisionHandle, owner, now } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const trusted = decisionHandleSnapshot(decisionHandle);
    const artifact = trusted.artifact;
    const decisionDirectory = path.join(directory, 'decisions');
    if (path.dirname(path.resolve(trusted.filename)) !== decisionDirectory
        || !SAFE_JSON_NAME.test(path.basename(trusted.filename))) fail('decision handle was not loaded from this filter decision directory');
    if (artifact.filterId !== filterId) fail('decision artifact belongs to another filter');
    const normalizedPatch = normalizePatch({ operationId: artifact.operationId,
        expectedStateSha256: artifact.expectedStateSha256, paperId: artifact.paperId, result: artifact.result });
    const patchSha256 = stableHash(normalizedPatch); const lock = acquireLock(directory, owner, now);
    try {
        const replayedArtifact = readJson(safeDirectJson(decisionDirectory, path.basename(trusted.filename)), 'decision artifact');
        if (replayedArtifact.sha256 !== trusted.fileSha256
            || stableHash(normalizeDecisionArtifact(replayedArtifact.value)) !== stableHash(artifact)) {
            fail('decision artifact bytes drifted after handle load');
        }
        const filename = safeDirectJson(directory, 'state.json'); const current = assertFilterState(readJson(filename, 'filter state').value);
        const prior = current.attempts.find(attempt => attempt.operationId === normalizedPatch.operationId);
        if (prior) {
            if (prior.patchSha256 !== patchSha256 || prior.decisionArtifactSha256 !== artifact.artifactSha256
                || prior.decisionArtifactFileSha256 !== trusted.fileSha256
                || prior.decisionArtifactName !== path.basename(trusted.filename)) {
                fail('operationId was already used by different decision evidence');
            }
            // The state is written before its derived selection receipt.  If a
            // crash happened between those writes, an idempotent retry must
            // heal the missing receipt instead of returning a permanently
            // unusable complete filter.
            ensureSelectionReceipt(directory, current);
            return current;
        }
        if (normalizedPatch.expectedStateSha256 !== current.stateSha256) fail('apply compare-and-swap state SHA mismatch');
        if (!Object.prototype.hasOwnProperty.call(current.decisions, normalizedPatch.paperId)) fail('patch references a non-candidate paper');
        const previous = current.decisions[normalizedPatch.paperId];
        if (artifact.sourceSha256 !== previous.sourceSha256) fail('decision artifact source SHA does not bind candidate');
        if (artifact.actor.type === 'llm' && (artifact.model !== current.input.model
            || artifact.endpointProtocol !== current.input.endpointProtocol)) fail('decision artifact model/protocol drifted from filter input');
        if (FINAL_STATUSES.has(previous.status)) fail('a final decision cannot be changed');
        if (!usageAtLeast(previous.usage, normalizedPatch.result.usage)) fail('usage cannot regress');
        const next = clone(current); next.decisions[normalizedPatch.paperId] = { sourceSha256: previous.sourceSha256, ...normalizedPatch.result };
        next.completion = completionFor(next.decisions);
        const recordedAt = nowIso(now);
        if (artifact.createdAt > recordedAt) fail('decision artifact creation time is after apply time');
        const attempt = { operationId: normalizedPatch.operationId, paperId: normalizedPatch.paperId,
            fromStatus: previous.status, toStatus: normalizedPatch.result.status, reason: normalizedPatch.result.reason,
            responseSha256: normalizedPatch.result.responseSha256, usage: clone(normalizedPatch.result.usage), recordedAt,
            priorStateSha256: current.stateSha256, nextStateSha256: '', patchSha256, patch: clone(normalizedPatch),
            decisionArtifactName: path.basename(trusted.filename), decisionArtifactSha256: artifact.artifactSha256,
            decisionArtifactFileSha256: trusted.fileSha256 };
        next.attempts.push(attempt); next.stateSha256 = stateDigest(next); attempt.nextStateSha256 = next.stateSha256;
        const checked = assertFilterState(next); replaceRegular(filename, `${JSON.stringify(checked, null, 2)}\n`);
        ensureSelectionReceipt(directory, checked);
        return checked;
    } finally { releaseLock(lock); }
}
function applyDecisionFile({ filterRoot, filterId, decisionName, owner, now } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const decisionFile = safeDirectJson(path.join(directory, 'decisions'), decisionName);
    return applyDecision({ filterRoot, filterId, decisionHandle: loadDecisionHandle(decisionFile), owner, now });
}

function createTransportAdapter({ requestLlmJson } = {}) {
    if (typeof requestLlmJson !== 'function') fail('requestLlmJson transport must be a function');
    return Object.freeze({ contract: 'conference-filter-transport-v2', enabled: false,
        execute() { fail('LLM transport is disabled in conference-filter-v2 local contract phase'); } });
}

module.exports = {
    VERSION, CONTRACT, SPEC_CONTRACT, DECISION_CONTRACT, SELECTION_RECEIPT_CONTRACT,
    SELECTION_HANDLE_CONTRACT, MAX_DECISION_PAYLOAD_BYTES,
    UUID_RE, SAFE_JSON_NAME, PROTOCOLS, stableHash,
    normalizeCatalog, normalizeSpec, normalizeUsage, inputBinding,
    catalogFromDiscoveryHandle, completionFor, normalizePatch, normalizeDecisionArtifact, buildDecisionArtifact,
    assertFilterState, assertBoundInputs, safeDirectory, filterDirectory, safeDirectJson, prepareFilter, readFilter,
    writeDecisionArtifact, loadDecisionHandle, decisionHandleSnapshot, applyDecision, applyDecisionFile,
    selectionReceiptFor, normalizeSelectionReceipt, readSelectionReceipt, loadSelectionHandle, selectionHandleSnapshot,
    createTransportAdapter
};
