'use strict';

// Conference filtering state and authenticated production runner.  It never
// reads data/current or publishes; model traffic uses the captured common LLM
// boundary only after a durable intent has been written under the filter lock.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const discoveryApi = require('./conference-discovery.js');
const paperIdentity = require('./paper-identity.js');
const utilsApi = require('../utils.js');
const fixedRequestLlmJson = utilsApi.requestLlmJson;

const VERSION = 3;
const CONTRACT = 'conference-filter-v3';
const SPEC_CONTRACT = 'conference-filter-spec-v3';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PAPER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,319}$/;
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'anthropic-messages']);
const DECISION_STATUSES = new Set(['pending', 'included', 'excluded', 'failed']);
const FINAL_STATUSES = new Set(['included', 'excluded']);
const DECISION_CONTRACT = 'conference-filter-decision-v3';
const SELECTION_RECEIPT_CONTRACT = 'conference-filter-selection-receipt-v3';
const SELECTION_HANDLE_CONTRACT = 'conference-filter-selection-v3';
const ACTOR_TYPES = new Set(['llm', 'manual']);
const MAX_DECISION_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_LLM_REQUEST_BYTES = 512 * 1024;
const DECISION_HANDLES = new WeakSet();
const DECISION_HANDLE_DATA = new WeakMap();
const SELECTION_HANDLES = new WeakSet();
const SELECTION_HANDLE_DATA = new WeakMap();
const LLM_ARTIFACT_AUTHORITY = Symbol('conference-filter-llm-runner');
const LLM_REQUEST_CONTRACT = 'conference-filter-llm-request-v1';
const LLM_INTENT_CONTRACT = 'conference-filter-llm-intent-v1';
const LLM_TRANSPORT_RECEIPT_CONTRACT = 'conference-filter-llm-transport-receipt-v1';
const LOCK_OWNER_CONTRACT = 'conference-filter-lock-owner-v1';
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;
const LOCK_HANDLES = new WeakSet();
const LOCK_HANDLE_DATA = new WeakMap();
const LLM_FILTER_POLICY = [
    'Include only papers whose primary technical contribution directly concerns speech, audio, music, acoustics, hearing, or sound.',
    'Exclude papers that merely mention audio as incidental data, analogy, evaluation, or future work.',
    'Decide only from the supplied official conference metadata record. Do not invent missing facts.'
].join('\n');
const LLM_FILTER_PROMPT = [
    'You are a strict conference-paper relevance classifier.',
    LLM_FILTER_POLICY,
    'Return exactly one JSON object with exactly two keys:',
    '{"decision":"included|excluded","reason":"concise evidence-based reason"}',
    'No Markdown, no extra keys, and no surrounding text.'
].join('\n');

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
const LLM_FILTER_POLICY_SHA256 = sha256(Buffer.from(LLM_FILTER_POLICY, 'utf8'));
const LLM_FILTER_PROMPT_SHA256 = sha256(Buffer.from(LLM_FILTER_PROMPT, 'utf8'));
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
    exact(value, ['contract', 'version', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol',
        'endpointIdentitySha256', 'taxonomyRegistrySha256'], 'filter spec');
    if (value.contract !== SPEC_CONTRACT || value.version !== VERSION) fail('filter spec contract/version mismatch');
    const model = nonempty(value.model, 'filter spec model', /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);
    if (!PROTOCOLS.has(value.endpointProtocol)) fail('filter spec endpointProtocol is unsupported');
    return {
        contract: SPEC_CONTRACT, version: VERSION,
        filterPolicySha256: assertSha(value.filterPolicySha256, 'filter spec filterPolicySha256'),
        promptSha256: assertSha(value.promptSha256, 'filter spec promptSha256'), model,
        endpointProtocol: value.endpointProtocol,
        endpointIdentitySha256: assertSha(value.endpointIdentitySha256, 'filter spec endpointIdentitySha256'),
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
        endpointIdentitySha256: normalizedSpec.endpointIdentitySha256,
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
        if (field !== 'requests' && next[field] === null) return true;
        if (previous[field] === null) return next[field] === null || Number.isSafeInteger(next[field]);
        return next[field] >= previous[field];
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
        'sourceSha256', 'actor', 'model', 'endpointProtocol', 'endpointIdentitySha256',
        'requestEnvelopeSha256', 'transportReceiptSha256', 'request', 'response', 'result', 'createdAt',
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
        assertSha(value.endpointIdentitySha256, 'decision artifact endpointIdentitySha256');
        assertSha(value.requestEnvelopeSha256, 'decision artifact requestEnvelopeSha256');
        assertSha(value.transportReceiptSha256, 'decision artifact transportReceiptSha256');
        if (result.usage.requests < 1) fail('LLM decision must record at least one request');
        const parsedRequest = requestEnvelopeFromBytes(Buffer.from(request.data, 'base64'), value.endpointProtocol);
        if (parsedRequest.envelope.requestSha256 !== value.requestEnvelopeSha256
            || parsedRequest.envelope.filterId !== value.filterId
            || parsedRequest.envelope.expectedStateSha256 !== value.expectedStateSha256
            || parsedRequest.envelope.paperId !== value.paperId
            || parsedRequest.envelope.sourceSha256 !== value.sourceSha256
            || parsedRequest.envelope.filter.model !== value.model
            || parsedRequest.envelope.filter.endpointProtocol !== value.endpointProtocol
            || parsedRequest.envelope.filter.endpointIdentitySha256 !== value.endpointIdentitySha256) {
            fail('LLM decision request bytes drifted from artifact source/filter binding');
        }
    } else if (value.model !== null || value.endpointProtocol !== 'manual'
        || value.endpointIdentitySha256 !== null || value.requestEnvelopeSha256 !== null
        || value.transportReceiptSha256 !== null
        || Object.values(result.usage).some(number => number !== 0)) {
        fail('manual decision must use no LLM transport identity and zero token usage');
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
    endpointProtocol = 'manual', endpointIdentitySha256 = null, requestEnvelopeSha256 = null,
    transportReceiptSha256 = null, requestBytes, responseBytes = null, status, reason, usage = {}, now,
    productionAuthority } = {}) {
    const checked = assertFilterState(state);
    if (actor?.type === 'llm' && productionAuthority !== LLM_ARTIFACT_AUTHORITY) {
        fail('LLM decision artifacts may only be produced by the authenticated conference filter runner');
    }
    nonempty(paperId, 'decision artifact paperId', PAPER_ID_RE);
    if (!Object.prototype.hasOwnProperty.call(checked.decisions, paperId)) fail('decision artifact references a non-candidate paper');
    const response = responseBytes === null ? null : byteRecord(responseBytes, 'decision response');
    const artifact = { contract: DECISION_CONTRACT, version: VERSION, filterId: checked.filterId, operationId,
        expectedStateSha256: checked.stateSha256, paperId,
        sourceSha256: checked.decisions[paperId].sourceSha256, actor, model, endpointProtocol,
        endpointIdentitySha256, requestEnvelopeSha256, transportReceiptSha256,
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
    exact(value.input, ['discoveryContract', 'conferenceId', 'catalogSha256', 'candidateSetSha256', 'filterPolicySha256',
        'promptSha256', 'model', 'endpointProtocol', 'endpointIdentitySha256', 'taxonomyRegistrySha256',
        'inputSha256'], 'input binding');
    const inputWithoutSha = { ...value.input }; delete inputWithoutSha.inputSha256;
    for (const field of ['catalogSha256', 'candidateSetSha256', 'filterPolicySha256', 'promptSha256',
        'endpointIdentitySha256', 'taxonomyRegistrySha256']) assertSha(value.input[field], `input.${field}`);
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
    let fd; let createdIdentity = null;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        const opened = fs.fstatSync(fd); createdIdentity = { dev: opened.dev, ino: opened.ino };
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
        const current = fs.lstatSync(filename);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) {
            fail('exclusive-write target changed before commit');
        }
    } catch (error) {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        if (createdIdentity) {
            try {
                const current = fs.lstatSync(filename);
                if (current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) {
                    fail('exclusive-write target changed before cleanup');
                }
                fs.unlinkSync(filename);
            } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
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
function lockOwnerRecord(owner, now, token = crypto.randomUUID()) {
    nonempty(owner, 'owner', OWNER_RE); nonempty(token, 'lock owner token', UUID_RE);
    const startedAt = nowIso(now);
    const body = { contract: LOCK_OWNER_CONTRACT, version: VERSION, owner, pid: process.pid,
        hostname: os.hostname(), token, startedAt, heartbeatAt: startedAt, leaseMs: LOCK_STALE_MS };
    return { ...body, ownerSha256: stableHash(body) };
}
function validateLockOwner(value) {
    exact(value, ['contract', 'version', 'owner', 'pid', 'hostname', 'token', 'startedAt', 'heartbeatAt',
        'leaseMs', 'ownerSha256'], 'filter lock owner');
    if (value.contract !== LOCK_OWNER_CONTRACT || value.version !== VERSION) fail('filter lock owner contract/version mismatch');
    nonempty(value.owner, 'filter lock owner', OWNER_RE);
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) fail('filter lock PID is malformed');
    nonempty(value.hostname, 'filter lock hostname');
    if (value.hostname.length > 255) fail('filter lock hostname is too long');
    nonempty(value.token, 'filter lock token', UUID_RE);
    timestamp(value.startedAt, 'filter lock startedAt'); timestamp(value.heartbeatAt, 'filter lock heartbeatAt');
    if (value.heartbeatAt < value.startedAt || value.leaseMs !== LOCK_STALE_MS) fail('filter lock lease is malformed');
    const body = clone(value); delete body.ownerSha256;
    if (assertSha(value.ownerSha256, 'filter lock ownerSha256') !== stableHash(body)) fail('filter lock owner SHA drifted');
    return clone(value);
}
function readLockDirectory(lockPath, label = 'filter operation lock') {
    const info = fs.lstatSync(lockPath);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(lockPath) !== lockPath) fail(`${label} is unsafe`);
    const entries = fs.readdirSync(lockPath).sort();
    if (entries.length !== 1 || entries[0] !== 'owner.json') fail(`${label} contains unknown or missing evidence`);
    const ownerPath = path.join(lockPath, 'owner.json'); const ownerInfo = fs.lstatSync(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1
        || ownerInfo.size < 1 || ownerInfo.size > MAX_LOCK_OWNER_BYTES) fail(`${label} owner is unsafe`);
    const loaded = readJson(ownerPath, `${label} owner`); const record = validateLockOwner(loaded.value);
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    if (loaded.sha256 !== sha256(expectedBytes)) fail(`${label} owner bytes are not canonical`);
    return { lockPath, directoryDev: info.dev, directoryIno: info.ino, directoryMtimeMs: info.mtimeMs,
        ownerDev: ownerInfo.dev, ownerIno: ownerInfo.ino, ownerMtimeMs: ownerInfo.mtimeMs,
        ownerFileSha256: loaded.sha256, record };
}
function processLiveness(record) {
    if (record.hostname !== os.hostname()) return 'remote';
    try { process.kill(record.pid, 0); return 'alive'; }
    catch (error) {
        if (error.code === 'ESRCH') return 'dead';
        if (error.code === 'EPERM') return 'alive';
        throw error;
    }
}
function reclaimableLock(snapshot, currentTime = Date.now()) {
    if (processLiveness(snapshot.record) !== 'dead') return false;
    const heartbeat = new Date(snapshot.record.heartbeatAt).getTime();
    const filesystemAge = currentTime - Math.max(snapshot.directoryMtimeMs, snapshot.ownerMtimeMs);
    return currentTime - heartbeat >= LOCK_STALE_MS && filesystemAge >= LOCK_STALE_MS;
}
function sameLockSnapshot(left, right) {
    return left.directoryDev === right.directoryDev && left.directoryIno === right.directoryIno
        && left.ownerDev === right.ownerDev && left.ownerIno === right.ownerIno
        && left.ownerFileSha256 === right.ownerFileSha256
        && left.record.ownerSha256 === right.record.ownerSha256;
}
function removeVerifiedLockDirectory(snapshot, label) {
    const current = readLockDirectory(snapshot.lockPath, label);
    if (!sameLockSnapshot(snapshot, current)) fail(`${label} changed before removal`);
    fs.unlinkSync(path.join(snapshot.lockPath, 'owner.json')); fs.rmdirSync(snapshot.lockPath);
}
function createLockDirectory(lockPath, owner, now) {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const record = lockOwnerRecord(owner, now); const ownerPath = path.join(lockPath, 'owner.json');
    try { writeExclusive(ownerPath, `${JSON.stringify(record, null, 2)}\n`); }
    catch (error) {
        try { fs.rmdirSync(lockPath); }
        catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError.code)) throw cleanupError; }
        throw error;
    }
    return readLockDirectory(lockPath);
}
function clearOrRejectReclaimMarker(reclaimPath) {
    let snapshot;
    try { snapshot = readLockDirectory(reclaimPath, 'filter lock reclaim marker'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const liveness = processLiveness(snapshot.record);
    if (liveness === 'alive') fail('filter lock reclaim is owned by a live process');
    if (liveness === 'remote') fail('filter lock reclaim belongs to another host');
    if (!reclaimableLock(snapshot)) fail('filter lock reclaim marker is not stale');
    removeVerifiedLockDirectory(snapshot, 'filter lock reclaim marker');
}
function acquireLock(directory, owner, now) {
    nonempty(owner, 'owner', OWNER_RE);
    const lockPath = path.join(directory, 'operation.lock'); const reclaimPath = path.join(directory, 'operation.lock.reclaim');
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try { fs.lstatSync(reclaimPath); clearOrRejectReclaimMarker(reclaimPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
            const snapshot = createLockDirectory(lockPath, owner, now);
            const handle = Object.freeze(Object.create(null)); LOCK_HANDLES.add(handle);
            LOCK_HANDLE_DATA.set(handle, Object.freeze({ lockPath, token: snapshot.record.token,
                ownerSha256: snapshot.record.ownerSha256 }));
            return handle;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stale = readLockDirectory(lockPath); const liveness = processLiveness(stale.record);
        if (liveness === 'alive') fail('conference filter is locked by a live process');
        if (liveness === 'remote') fail('conference filter lock belongs to another host');
        if (!reclaimableLock(stale)) fail('conference filter lock belongs to a dead process but is not stale');
        let reclaim;
        try { reclaim = createLockDirectory(reclaimPath, owner, now); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try {
            let current;
            try { current = readLockDirectory(lockPath); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!sameLockSnapshot(stale, current) || !reclaimableLock(current)) fail('filter lock changed during stale reclaim');
            removeVerifiedLockDirectory(current, 'filter operation lock');
        } finally { removeVerifiedLockDirectory(reclaim, 'filter lock reclaim marker'); }
    }
    fail('filter lock acquisition exceeded bounded stale-reclaim attempts');
}
function releaseLock(handle) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) fail('authenticated filter lock handle required');
    const expected = LOCK_HANDLE_DATA.get(handle); const snapshot = readLockDirectory(expected.lockPath);
    if (snapshot.record.token !== expected.token || snapshot.record.ownerSha256 !== expected.ownerSha256) {
        fail('filter operation lock changed while held');
    }
    removeVerifiedLockDirectory(snapshot, 'filter operation lock');
    LOCK_HANDLES.delete(handle); LOCK_HANDLE_DATA.delete(handle);
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
        fs.mkdirSync(path.join(directory, 'llm-intents'), { mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'llm-responses'), { mode: 0o700 });
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
                || artifact.endpointProtocol !== state.input.endpointProtocol
                || artifact.endpointIdentitySha256 !== state.input.endpointIdentitySha256))) {
            fail(`attempt[${index}] decision artifact replay drifted`);
        }
        if (artifact.actor.type === 'llm') {
            const intentFile = safeDirectJson(path.join(directory, 'llm-intents'), `llm-${artifact.operationId}.json`);
            const intent = normalizeLlmIntent(readJson(intentFile, `LLM intent for attempt ${index}`).value);
            const receiptFile = safeDirectJson(path.join(directory, 'llm-responses'), `llm-${artifact.operationId}.json`);
            const receipt = normalizeTransportReceipt(readJson(receiptFile, `transport receipt for attempt ${index}`).value);
            if (intent.intentSha256 !== receipt.intentSha256 || intent.operationId !== artifact.operationId
                || intent.request.sha256 !== artifact.request.sha256
                || intent.requestEnvelopeSha256 !== artifact.requestEnvelopeSha256
                || receipt.transportReceiptSha256 !== artifact.transportReceiptSha256
                || receipt.operationId !== artifact.operationId || receipt.filterId !== filterId
                || receipt.response?.sha256 !== artifact.response?.sha256) {
                fail(`attempt[${index}] transport receipt replay drifted`);
            }
            if (FINAL_STATUSES.has(artifact.result.status)
                && (receipt.outcome !== 'received' || receipt.statusCode < 200 || receipt.statusCode >= 300
                    || receipt.usage.inputTokens === null || receipt.usage.outputTokens < 1
                    || receipt.usage.totalTokens < 1)) {
                fail(`attempt[${index}] final decision lacks complete terminal provider usage`);
            }
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

function loadDecisionHandleInternal(filename, { allowLlm = false } = {}) {
    const loaded = readJson(filename, 'decision artifact');
    const artifact = normalizeDecisionArtifact(loaded.value);
    if (artifact.actor.type === 'llm' && !allowLlm) {
        fail('LLM decision artifacts may only be loaded by the authenticated conference filter runner');
    }
    const handle = Object.freeze(Object.create(null));
    DECISION_HANDLES.add(handle);
    DECISION_HANDLE_DATA.set(handle, Object.freeze({ artifact, fileSha256: loaded.sha256, filename }));
    return handle;
}
function loadDecisionHandle(filename) { return loadDecisionHandleInternal(filename); }

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

function assertHeldLock(handle, directory) {
    if (!handle || typeof handle !== 'object' || !LOCK_HANDLES.has(handle)) fail('authenticated filter lock handle required');
    const expected = LOCK_HANDLE_DATA.get(handle);
    if (expected.lockPath !== path.join(directory, 'operation.lock')) fail('filter lock belongs to another filter');
}
function applyDecisionLocked({ filterRoot, filterId, decisionHandle, now, lockHandle } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    assertHeldLock(lockHandle, directory);
    const trusted = decisionHandleSnapshot(decisionHandle);
    const artifact = trusted.artifact;
    const decisionDirectory = path.join(directory, 'decisions');
    if (path.dirname(path.resolve(trusted.filename)) !== decisionDirectory
        || !SAFE_JSON_NAME.test(path.basename(trusted.filename))) fail('decision handle was not loaded from this filter decision directory');
    if (artifact.filterId !== filterId) fail('decision artifact belongs to another filter');
    const normalizedPatch = normalizePatch({ operationId: artifact.operationId,
        expectedStateSha256: artifact.expectedStateSha256, paperId: artifact.paperId, result: artifact.result });
    const patchSha256 = stableHash(normalizedPatch);
    const replayedArtifact = readJson(safeDirectJson(decisionDirectory, path.basename(trusted.filename)), 'decision artifact');
    if (replayedArtifact.sha256 !== trusted.fileSha256
        || stableHash(normalizeDecisionArtifact(replayedArtifact.value)) !== stableHash(artifact)) {
        fail('decision artifact bytes drifted after handle load');
    }
    const filename = safeDirectJson(directory, 'state.json');
    const current = assertFilterState(readJson(filename, 'filter state').value);
    const prior = current.attempts.find(attempt => attempt.operationId === normalizedPatch.operationId);
    if (prior) {
        if (prior.patchSha256 !== patchSha256 || prior.decisionArtifactSha256 !== artifact.artifactSha256
            || prior.decisionArtifactFileSha256 !== trusted.fileSha256
            || prior.decisionArtifactName !== path.basename(trusted.filename)) {
            fail('operationId was already used by different decision evidence');
        }
        ensureSelectionReceipt(directory, current);
        return current;
    }
    if (normalizedPatch.expectedStateSha256 !== current.stateSha256) fail('apply compare-and-swap state SHA mismatch');
    if (!Object.prototype.hasOwnProperty.call(current.decisions, normalizedPatch.paperId)) fail('patch references a non-candidate paper');
    const previous = current.decisions[normalizedPatch.paperId];
    if (artifact.sourceSha256 !== previous.sourceSha256) fail('decision artifact source SHA does not bind candidate');
    if (artifact.actor.type === 'llm' && (artifact.model !== current.input.model
        || artifact.endpointProtocol !== current.input.endpointProtocol
        || artifact.endpointIdentitySha256 !== current.input.endpointIdentitySha256)) {
        fail('decision artifact model/protocol/endpoint drifted from filter input');
    }
    if (FINAL_STATUSES.has(previous.status)) fail('a final decision cannot be changed');
    if (!usageAtLeast(previous.usage, normalizedPatch.result.usage)) fail('usage cannot regress');
    const next = clone(current);
    next.decisions[normalizedPatch.paperId] = { sourceSha256: previous.sourceSha256, ...normalizedPatch.result };
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
}
function applyDecision({ filterRoot, filterId, decisionHandle, owner, now } = {}) {
    const directory = filterDirectory(filterRoot, filterId); const lock = acquireLock(directory, owner, now);
    try { return applyDecisionLocked({ filterRoot, filterId, decisionHandle, now, lockHandle: lock }); }
    finally { releaseLock(lock); }
}
function applyDecisionFile({ filterRoot, filterId, decisionName, owner, now } = {}) {
    const directory = filterDirectory(filterRoot, filterId);
    const decisionFile = safeDirectJson(path.join(directory, 'decisions'), decisionName);
    return applyDecision({ filterRoot, filterId, decisionHandle: loadDecisionHandle(decisionFile), owner, now });
}

function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of String(source).matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function parseLlmDecisionText(source) {
    if (typeof source !== 'string' || !source.trim()) fail('LLM response text must contain JSON');
    source = source.trim();
    if (Buffer.byteLength(source, 'utf8') > 64 * 1024) fail('LLM response text exceeds the decision limit');
    let value;
    try { rejectDuplicateJsonKeys(source, 'LLM response'); value = JSON.parse(source); }
    catch (error) {
        if (String(error.message || error).startsWith('Invalid conference filter:')) throw error;
        fail(`LLM response is not strict JSON: ${error.message}`);
    }
    exact(value, ['decision', 'reason'], 'LLM response');
    if (!FINAL_STATUSES.has(value.decision)) fail('LLM response decision must be included or excluded');
    const reason = nonempty(value.reason, 'LLM response reason');
    if (reason.length > 4000) fail('LLM response reason is too long');
    return { status: value.decision, reason };
}

function requestEnvelope({ state, paperId, discoveryHandle }) {
    const discovery = trustedDiscovery(discoveryHandle);
    const matches = discovery.candidateManifest.members.filter(member => (
        paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, member.identity) === paperId
    ));
    if (matches.length !== 1) fail('runner paperId is absent or duplicated in authenticated discovery');
    const member = matches[0]; const sourceIdentity = ledgerApi.identityKey(member.identity);
    const replay = discoveryApi.replayDiscoveryMember(discoveryHandle, sourceIdentity);
    const decision = state.decisions[paperId];
    const body = { contract: LLM_REQUEST_CONTRACT, version: 1, filterId: state.filterId,
        expectedStateSha256: state.stateSha256, paperId, sourceSha256: decision.sourceSha256,
        discovery: { contract: discovery.candidateManifest.contract, catalogSha256: discovery.catalogSha256,
            conference: replay.conference, adapter: replay.adapter, sourceIdentity, identity: replay.identity,
            metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
            metadataRecordSha256: replay.metadataRecordSha256 },
        filter: { inputSha256: state.input.inputSha256, filterPolicySha256: state.input.filterPolicySha256,
            promptSha256: state.input.promptSha256, model: state.input.model,
            endpointProtocol: state.input.endpointProtocol,
            endpointIdentitySha256: state.input.endpointIdentitySha256,
            taxonomyRegistrySha256: state.input.taxonomyRegistrySha256 },
        metadataRecord: replay.metadataRecord };
    return { ...body, requestSha256: stableHash(body) };
}

function cumulativeUsage(previous, current) {
    const prior = normalizeUsage(previous); const next = normalizeUsage(current);
    const result = { requests: prior.requests + next.requests };
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
        result[field] = prior[field] === null || next[field] === null ? null : prior[field] + next[field];
    }
    return normalizeUsage(result);
}

function endpointIdentitySha256(endpoint, model) {
    const apiType = utilsApi.detectApiType(endpoint, model);
    return sha256(Buffer.from(new URL(utilsApi.buildApiUrl(apiType, endpoint)).href, 'utf8'));
}

function normalizeRequestEnvelope(value) {
    exact(value, ['contract', 'version', 'filterId', 'expectedStateSha256', 'paperId', 'sourceSha256',
        'discovery', 'filter', 'metadataRecord', 'requestSha256'], 'LLM request envelope');
    if (value.contract !== LLM_REQUEST_CONTRACT || value.version !== 1) fail('LLM request contract/version mismatch');
    nonempty(value.filterId, 'LLM request filterId', UUID_RE);
    assertSha(value.expectedStateSha256, 'LLM request expectedStateSha256');
    nonempty(value.paperId, 'LLM request paperId', PAPER_ID_RE); assertSha(value.sourceSha256, 'LLM request sourceSha256');
    exact(value.discovery, ['contract', 'catalogSha256', 'conference', 'adapter', 'sourceIdentity', 'identity',
        'metadataSnapshotSha256', 'metadataIndex', 'metadataRecordSha256'], 'LLM request discovery');
    nonempty(value.discovery.contract, 'LLM request discovery contract');
    assertSha(value.discovery.catalogSha256, 'LLM request discovery catalogSha256');
    exact(value.discovery.conference, ['id', 'year'], 'LLM request conference');
    nonempty(value.discovery.conference.id, 'LLM request conference id');
    if (!Number.isInteger(value.discovery.conference.year)) fail('LLM request conference year is malformed');
    if (!['icassp', 'iclr', 'icml'].includes(value.discovery.adapter)) fail('LLM request adapter is unsupported');
    const sourceIdentity = ledgerApi.identityKey(value.discovery.identity);
    if (value.discovery.sourceIdentity !== sourceIdentity) fail('LLM request source identity drifted');
    assertSha(value.discovery.metadataSnapshotSha256, 'LLM request metadata snapshot SHA');
    if (!Number.isSafeInteger(value.discovery.metadataIndex) || value.discovery.metadataIndex < 0) {
        fail('LLM request metadata index is malformed');
    }
    if (assertSha(value.discovery.metadataRecordSha256, 'LLM request metadata record SHA')
        !== stableHash(value.metadataRecord)) fail('LLM request metadata record SHA drifted');
    exact(value.filter, ['inputSha256', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol',
        'endpointIdentitySha256', 'taxonomyRegistrySha256'], 'LLM request filter binding');
    for (const field of ['inputSha256', 'filterPolicySha256', 'promptSha256', 'endpointIdentitySha256',
        'taxonomyRegistrySha256']) assertSha(value.filter[field], `LLM request filter.${field}`);
    nonempty(value.filter.model, 'LLM request model');
    if (!PROTOCOLS.has(value.filter.endpointProtocol)) fail('LLM request endpoint protocol is unsupported');
    const body = clone(value); delete body.requestSha256;
    if (assertSha(value.requestSha256, 'LLM request requestSha256') !== stableHash(body)) fail('LLM request self-SHA drifted');
    return clone(value);
}

function parseStrictJson(source, label) {
    try { rejectDuplicateJsonKeys(source, label); return JSON.parse(source); }
    catch (error) {
        if (String(error.message || error).startsWith('Invalid conference filter:')) throw error;
        fail(`${label} is not strict JSON`);
    }
}

function requestEnvelopeFromBytes(bytes, protocol) {
    const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    const body = parseStrictJson(source, 'preserved LLM request');
    let system; let user;
    if (protocol === 'openai-responses') {
        const allowed = new Set(['model', 'input', 'max_output_tokens', 'temperature', 'reasoning', 'stream']);
        if (!isPlainObject(body) || Object.keys(body).some(key => !allowed.has(key)) || !Array.isArray(body.input)
            || body.input.length !== 2) fail('OpenAI Responses request shape drifted');
        const read = (message, role) => {
            exact(message, ['role', 'content'], `LLM ${role} message`);
            if (message.role !== role || !Array.isArray(message.content) || message.content.length !== 1) fail(`LLM ${role} message shape drifted`);
            exact(message.content[0], ['type', 'text'], `LLM ${role} message content`);
            if (message.content[0].type !== 'input_text' || typeof message.content[0].text !== 'string') fail(`LLM ${role} message content drifted`);
            return message.content[0].text;
        };
        system = read(body.input[0], 'system'); user = read(body.input[1], 'user');
        if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1
            || !Number.isFinite(body.temperature)) fail('OpenAI Responses request limits are malformed');
        if (body.reasoning !== undefined
            && (!isPlainObject(body.reasoning) || !['low', 'medium', 'high'].includes(body.reasoning.effort)
                || Object.keys(body.reasoning).length !== 1)) fail('OpenAI Responses reasoning option is malformed');
        if (body.stream !== undefined && body.stream !== true) fail('OpenAI Responses stream option is malformed');
    } else if (protocol === 'anthropic-messages') {
        const allowed = new Set(['model', 'max_tokens', 'messages', 'system', 'temperature']);
        if (!isPlainObject(body) || Object.keys(body).some(key => !allowed.has(key)) || !Array.isArray(body.messages)
            || body.messages.length !== 1 || body.messages[0]?.role !== 'user'
            || typeof body.messages[0]?.content !== 'string' || typeof body.system !== 'string') {
            fail('Anthropic request shape drifted');
        }
        system = body.system; user = body.messages[0].content;
        if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
            || !Number.isFinite(body.temperature)) fail('Anthropic request limits are malformed');
    } else {
        exact(body, ['model', 'messages', 'max_tokens', 'temperature'], 'OpenAI chat request');
        if (!Array.isArray(body.messages) || body.messages.length !== 2
            || body.messages[0]?.role !== 'system' || typeof body.messages[0]?.content !== 'string'
            || body.messages[1]?.role !== 'user' || typeof body.messages[1]?.content !== 'string') {
            fail('OpenAI chat request shape drifted');
        }
        system = body.messages[0].content; user = body.messages[1].content;
        if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
            || !Number.isFinite(body.temperature)) fail('OpenAI chat request limits are malformed');
    }
    if (body.model === undefined || typeof body.model !== 'string' || system !== LLM_FILTER_PROMPT) {
        fail('LLM request model or system prompt drifted');
    }
    return { body, envelope: normalizeRequestEnvelope(parseStrictJson(user, 'LLM request user envelope')) };
}

function assertRequestBinding(request, { state, paperId, discoveryHandle }) {
    const parsed = requestEnvelopeFromBytes(Buffer.from(request.data, 'base64'), state.input.endpointProtocol);
    if (parsed.body.model !== state.input.model) fail('preserved LLM request model drifted');
    const expected = requestEnvelope({ state, paperId, discoveryHandle });
    if (stableHash(parsed.envelope) !== stableHash(expected)) fail('preserved LLM request does not bind current source metadata and filter input');
    return parsed;
}

function intentDigest(value) { const copy = clone(value); delete copy.intentSha256; return stableHash(copy); }
function normalizeLlmIntent(value) {
    exact(value, ['contract', 'version', 'filterId', 'operationId', 'expectedStateSha256', 'paperId',
        'sourceSha256', 'actorId', 'endpointIdentitySha256', 'inputSha256', 'requestEnvelopeSha256',
        'usageContextSha256', 'attemptNumber', 'request', 'createdAt', 'intentSha256'], 'LLM intent');
    if (value.contract !== LLM_INTENT_CONTRACT || value.version !== 1) fail('LLM intent contract/version mismatch');
    nonempty(value.filterId, 'LLM intent filterId', UUID_RE); nonempty(value.operationId, 'LLM intent operationId', UUID_RE);
    assertSha(value.expectedStateSha256, 'LLM intent expected state SHA'); nonempty(value.paperId, 'LLM intent paperId', PAPER_ID_RE);
    assertSha(value.sourceSha256, 'LLM intent source SHA'); nonempty(value.actorId, 'LLM intent actor', OWNER_RE);
    for (const field of ['endpointIdentitySha256', 'inputSha256', 'requestEnvelopeSha256', 'usageContextSha256']) {
        assertSha(value[field], `LLM intent ${field}`);
    }
    if (!Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1) fail('LLM intent attemptNumber is malformed');
    normalizeByteRecord(value.request, 'LLM intent request'); timestamp(value.createdAt, 'LLM intent createdAt');
    if (assertSha(value.intentSha256, 'LLM intent self-SHA') !== intentDigest(value)) fail('LLM intent self-SHA drifted');
    return clone(value);
}

function transportReceiptDigest(value) { const copy = clone(value); delete copy.transportReceiptSha256; return stableHash(copy); }
function normalizeTransportReceipt(value) {
    exact(value, ['contract', 'version', 'filterId', 'operationId', 'intentSha256', 'endpointIdentitySha256',
        'usageContextSha256', 'usageLedgerBindings', 'outcome', 'statusCode', 'response', 'usage', 'errorCode', 'createdAt',
        'transportReceiptSha256'], 'LLM transport receipt');
    if (value.contract !== LLM_TRANSPORT_RECEIPT_CONTRACT || value.version !== 1) fail('LLM transport receipt contract/version mismatch');
    nonempty(value.filterId, 'LLM transport filterId', UUID_RE); nonempty(value.operationId, 'LLM transport operationId', UUID_RE);
    for (const field of ['intentSha256', 'endpointIdentitySha256', 'usageContextSha256']) assertSha(value[field], `LLM transport ${field}`);
    if (!Array.isArray(value.usageLedgerBindings)) fail('LLM transport usage ledger bindings must be an array');
    const usageLedgerBindings = value.usageLedgerBindings.map((binding, index) => {
        exact(binding, ['eventId', 'eventSha256', 'contextSha256', 'persistence'], `LLM usage ledger binding[${index}]`);
        nonempty(binding.eventId, `LLM usage ledger binding[${index}].eventId`, UUID_RE);
        const normalized = { eventId: binding.eventId, eventSha256: assertSha(binding.eventSha256,
            `LLM usage ledger binding[${index}].eventSha256`), contextSha256: assertSha(binding.contextSha256,
            `LLM usage ledger binding[${index}].contextSha256`), persistence: binding.persistence };
        if (!['written', 'unavailable'].includes(normalized.persistence)) fail('LLM usage ledger persistence is malformed');
        if (normalized.contextSha256 !== value.usageContextSha256) fail('LLM usage ledger event context differs from intent');
        return normalized;
    });
    if (new Set(usageLedgerBindings.map(binding => binding.eventId)).size !== usageLedgerBindings.length) {
        fail('LLM transport usage ledger bindings contain duplicate events');
    }
    if (!['received', 'unavailable'].includes(value.outcome)) fail('LLM transport outcome is unsupported');
    const response = normalizeByteRecord(value.response, 'LLM transport response', { nullable: true });
    const usage = normalizeUsage(value.usage); timestamp(value.createdAt, 'LLM transport createdAt');
    if (usage.requests !== Math.max(1, usageLedgerBindings.length)) {
        fail('LLM transport usage count does not bind physical request events');
    }
    if (value.outcome === 'received') {
        if (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599 || !response
            || value.errorCode !== null) fail('received LLM transport evidence is incomplete');
    } else {
        if (value.statusCode !== null || response !== null
            || typeof value.errorCode !== 'string' || !/^[A-Z0-9_:-]{1,120}$/.test(value.errorCode)) {
            fail('unavailable LLM transport evidence is malformed');
        }
    }
    if (assertSha(value.transportReceiptSha256, 'LLM transport receipt self-SHA') !== transportReceiptDigest(value)) {
        fail('LLM transport receipt self-SHA drifted');
    }
    return { ...clone(value), usageLedgerBindings, response, usage };
}

function strictTransportBody(raw) {
    const source = String(raw);
    try { return parseStrictJson(source, 'LLM transport raw response'); }
    catch (jsonError) {
        for (const block of source.split(/\r?\n\r?\n/)) {
            const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n');
            if (data.trimStart().startsWith('{')) rejectDuplicateJsonKeys(data, 'LLM SSE event');
        }
        const body = utilsApi.parseSseResponse(source);
        if (!body) fail('LLM transport response is neither strict JSON nor complete SSE');
        return body;
    }
}

function safeTransportErrorCode(error) {
    const code = String(error?.code || 'LLM_TRANSPORT_UNAVAILABLE').toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120);
    return code || 'LLM_TRANSPORT_UNAVAILABLE';
}

function usageFromEvents(events, fallback) {
    if (!events.length) return normalizeUsage(fallback);
    const result = { requests: events.length };
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
        const values = events.map(entry => entry.event?.usage?.[field]);
        result[field] = values.every(Number.isSafeInteger) ? values.reduce((sum, value) => sum + value, 0) : null;
    }
    return normalizeUsage(result);
}

function buildTransportReceipt({ intent, response = null, error = null, apiType, usageEvents = [], now } = {}) {
    const checked = normalizeLlmIntent(intent); let outcome; let statusCode = null; let responseRecord = null;
    let usage; let errorCode = null;
    const usageLedgerBindings = usageEvents.map(entry => ({ eventId: entry.event.eventId,
        eventSha256: stableHash(entry.event), contextSha256: stableHash({ stage: entry.event.stage,
            unitId: entry.event.unitId }), persistence: entry.persisted ? 'written' : 'unavailable' }));
    if (response && Number.isInteger(response.statusCode) && typeof response.raw === 'string' && response.raw.length) {
        const body = strictTransportBody(response.raw);
        if (stableHash(body) !== stableHash(response.body)) fail('LLM transport raw bytes do not replay parsed body');
        const provider = require('./llm-usage.js').normalizeLlmUsage(apiType, body);
        usage = normalizeUsage({ requests: Math.max(1, usageEvents.length), inputTokens: provider.inputTokens,
            outputTokens: provider.outputTokens, totalTokens: provider.totalTokens });
        if (usageEvents.length) {
            const last = usageEvents.at(-1)?.event?.usage || {};
            if (last.inputTokens !== provider.inputTokens || last.outputTokens !== provider.outputTokens
                || last.totalTokens !== provider.totalTokens) fail('terminal usage ledger event differs from raw response usage');
        }
        outcome = 'received'; statusCode = response.statusCode; responseRecord = byteRecord(Buffer.from(response.raw, 'utf8'), 'LLM transport response');
    } else {
        outcome = 'unavailable'; errorCode = safeTransportErrorCode(error);
        usage = usageFromEvents(usageEvents,
            { requests: 1, inputTokens: null, outputTokens: null, totalTokens: null });
    }
    const body = { contract: LLM_TRANSPORT_RECEIPT_CONTRACT, version: 1, filterId: checked.filterId,
        operationId: checked.operationId, intentSha256: checked.intentSha256,
        endpointIdentitySha256: checked.endpointIdentitySha256, usageContextSha256: checked.usageContextSha256,
        usageLedgerBindings,
        outcome, statusCode, response: responseRecord, usage, errorCode, createdAt: nowIso(now) };
    return normalizeTransportReceipt({ ...body, transportReceiptSha256: stableHash(body) });
}

function responseBodyFromReceipt(receipt) {
    const checked = normalizeTransportReceipt(receipt);
    return checked.response ? strictTransportBody(Buffer.from(checked.response.data, 'base64').toString('utf8')) : null;
}

function decisionFromTransport({ state, intent, receipt, discoveryHandle, now }) {
    const checkedIntent = normalizeLlmIntent(intent); const checkedReceipt = normalizeTransportReceipt(receipt);
    if (checkedReceipt.filterId !== checkedIntent.filterId || checkedReceipt.operationId !== checkedIntent.operationId
        || checkedReceipt.intentSha256 !== checkedIntent.intentSha256
        || checkedReceipt.endpointIdentitySha256 !== checkedIntent.endpointIdentitySha256
        || checkedReceipt.usageContextSha256 !== checkedIntent.usageContextSha256) fail('LLM transport receipt does not bind its intent');
    if (state.stateSha256 !== checkedIntent.expectedStateSha256 || state.filterId !== checkedIntent.filterId
        || state.decisions[checkedIntent.paperId]?.sourceSha256 !== checkedIntent.sourceSha256
        || state.input.inputSha256 !== checkedIntent.inputSha256
        || state.input.endpointIdentitySha256 !== checkedIntent.endpointIdentitySha256) fail('LLM intent no longer binds filter state');
    const parsedRequest = assertRequestBinding(checkedIntent.request, { state, paperId: checkedIntent.paperId, discoveryHandle });
    if (parsedRequest.envelope.requestSha256 !== checkedIntent.requestEnvelopeSha256) fail('LLM intent request envelope SHA drifted');
    let status = 'failed'; let reason; const responseBody = responseBodyFromReceipt(checkedReceipt);
    if (checkedReceipt.outcome === 'unavailable') reason = `LLM_TRANSPORT_UNAVAILABLE:${checkedReceipt.errorCode}`;
    else if (checkedReceipt.statusCode < 200 || checkedReceipt.statusCode >= 300) reason = `LLM_HTTP_STATUS:${checkedReceipt.statusCode}`;
    else {
        const truncated = utilsApi.getResponsesOutputTruncationError(responseBody, parsedRequest.body.max_output_tokens);
        if (truncated || responseBody?.stop_reason === 'max_tokens'
            || responseBody?.choices?.some(choice => choice?.finish_reason === 'length')) reason = 'LLM_OUTPUT_TRUNCATED';
        else if (checkedReceipt.usage.inputTokens === null || checkedReceipt.usage.outputTokens === null
            || checkedReceipt.usage.totalTokens === null) reason = 'LLM_USAGE_PARTIAL_OR_UNAVAILABLE';
        else if (checkedReceipt.usage.outputTokens < 1 || checkedReceipt.usage.totalTokens < 1) reason = 'LLM_USAGE_ZERO_OUTPUT';
        else {
            try {
                const apiType = state.input.endpointProtocol === 'openai-responses' ? 'openai_responses'
                    : state.input.endpointProtocol === 'anthropic-messages' ? 'anthropic' : 'openai';
                const parsed = parseLlmDecisionText(utilsApi.parseResponseText(apiType, responseBody));
                status = parsed.status; reason = parsed.reason;
            } catch (_) { reason = 'LLM_RESPONSE_INVALID'; }
        }
    }
    const usage = cumulativeUsage(state.decisions[checkedIntent.paperId].usage, checkedReceipt.usage);
    return buildDecisionArtifact({ state, paperId: checkedIntent.paperId, operationId: checkedIntent.operationId,
        actor: { type: 'llm', id: checkedIntent.actorId }, model: state.input.model,
        endpointProtocol: state.input.endpointProtocol, endpointIdentitySha256: checkedIntent.endpointIdentitySha256,
        requestEnvelopeSha256: checkedIntent.requestEnvelopeSha256,
        transportReceiptSha256: checkedReceipt.transportReceiptSha256,
        requestBytes: Buffer.from(checkedIntent.request.data, 'base64'),
        responseBytes: checkedReceipt.response ? Buffer.from(checkedReceipt.response.data, 'base64') : null,
        status, reason, usage, now, productionAuthority: LLM_ARTIFACT_AUTHORITY });
}

function ensureRunnerDirectories(directory) {
    for (const name of ['llm-intents', 'llm-responses']) {
        const target = path.join(directory, name);
        try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        safeDirectory(target);
    }
}
function intentFilename(directory, operationId) { return safeDirectJson(path.join(directory, 'llm-intents'), `llm-${operationId}.json`, { mustExist: false }); }
function responseFilename(directory, operationId) { return safeDirectJson(path.join(directory, 'llm-responses'), `llm-${operationId}.json`, { mustExist: false }); }
function decisionFilename(directory, operationId) { return safeDirectJson(path.join(directory, 'decisions'), `llm-${operationId}.json`, { mustExist: false }); }
function readOptional(filename, label, normalize) {
    try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return normalize(readJson(filename, label).value);
}
function incompleteIntent(directory, state) {
    const intents = safeDirectory(path.join(directory, 'llm-intents'));
    const incomplete = [];
    for (const name of fs.readdirSync(intents).sort()) {
        if (!SAFE_JSON_NAME.test(name)) fail('LLM intent directory contains an unsafe entry');
        const intent = normalizeLlmIntent(readJson(safeDirectJson(intents, name), 'LLM intent').value);
        if (name !== `llm-${intent.operationId}.json`) fail('LLM intent filename does not bind operationId');
        if (intent.filterId !== state.filterId) fail('LLM intent belongs to another filter');
        if (!state.attempts.some(attempt => attempt.operationId === intent.operationId)) incomplete.push(intent);
    }
    if (incomplete.length > 1) fail('multiple incomplete LLM intents require operator review');
    return incomplete[0] || null;
}

function createIntent({ directory, state, paperId, owner, discoveryHandle, llm, now }) {
    const envelope = requestEnvelope({ state, paperId, discoveryHandle });
    const messages = [{ role: 'system', content: LLM_FILTER_PROMPT }, { role: 'user', content: JSON.stringify(envelope) }];
    const requestBody = utilsApi.buildRequestBody(llm.apiType, llm.model, messages, llm.maxTokens, llm.temperature);
    const requestBytes = Buffer.from(JSON.stringify(requestBody), 'utf8');
    if (!requestBytes.length || requestBytes.length > MAX_LLM_REQUEST_BYTES) fail('LLM request exceeds the durable evidence limit before transport');
    const operationId = crypto.randomUUID(); const usageContext = {
        stage: 'conference-filter', unitId: stableHash({ filterId: state.filterId, paperId,
            sourceSha256: state.decisions[paperId].sourceSha256, operationId }) };
    const body = { contract: LLM_INTENT_CONTRACT, version: 1, filterId: state.filterId, operationId,
        expectedStateSha256: state.stateSha256, paperId, sourceSha256: state.decisions[paperId].sourceSha256,
        actorId: owner, endpointIdentitySha256: state.input.endpointIdentitySha256,
        inputSha256: state.input.inputSha256, requestEnvelopeSha256: envelope.requestSha256,
        usageContextSha256: stableHash(usageContext), attemptNumber: state.attempts.filter(item => item.paperId === paperId).length + 1,
        request: byteRecord(requestBytes, 'LLM intent request'), createdAt: nowIso(now) };
    const intent = normalizeLlmIntent({ ...body, intentSha256: stableHash(body) });
    assertRequestBinding(intent.request, { state, paperId, discoveryHandle });
    writeExclusive(intentFilename(directory, operationId), `${JSON.stringify(intent, null, 2)}\n`);
    return { intent, requestBody, usageContext };
}

function normalizeProductionLlmConfig(value) {
    exact(value, ['endpoint', 'model', 'apiUrl', 'apiType', 'apiKeys', 'headers', 'accountPoolStateFile',
        'timeoutMs', 'maxTokens', 'maxResponseBytes', 'temperature'], 'production LLM config');
    const endpoint = nonempty(value.endpoint, 'production LLM endpoint');
    const model = nonempty(value.model, 'production LLM model'); const apiType = utilsApi.detectApiType(endpoint, model);
    const apiUrl = new URL(utilsApi.buildApiUrl(apiType, endpoint)).href;
    if (value.apiType !== apiType || new URL(value.apiUrl).href !== apiUrl) fail('production LLM route identity drifted');
    if (!Array.isArray(value.apiKeys) || !value.apiKeys.length || value.apiKeys.some(key => typeof key !== 'string' || !key.trim())) {
        fail('production LLM API key pool is malformed');
    }
    if (!isPlainObject(value.headers)) fail('production LLM headers are malformed');
    const expectedHeaders = utilsApi.buildHeaders(apiType, value.apiKeys[0], '');
    if (stableHash(value.headers) !== stableHash(expectedHeaders)) fail('production LLM headers differ from the canonical credential boundary');
    if (typeof value.accountPoolStateFile !== 'string' || !path.isAbsolute(value.accountPoolStateFile)) fail('production account pool path is malformed');
    for (const field of ['timeoutMs', 'maxTokens', 'maxResponseBytes']) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 1) fail(`production LLM ${field} is malformed`);
    }
    if (!Number.isFinite(value.temperature)) fail('production LLM temperature is malformed');
    return { ...value, endpoint, model, apiType, apiUrl };
}

async function advanceProductionLlmDecision({ filterRoot, filterId, discoveryHandle, spec, paperId, owner, llm } = {}) {
    const config = normalizeProductionLlmConfig(llm); const catalog = catalogFromDiscoveryHandle(discoveryHandle);
    const normalizedSpec = normalizeSpec(spec); const directory = filterDirectory(filterRoot, filterId);
    const lock = acquireLock(directory, owner);
    try {
        ensureRunnerDirectories(directory);
        let state = assertBoundInputs(readFilter({ filterRoot, filterId }), { catalog, spec: normalizedSpec });
        if (normalizedSpec.filterPolicySha256 !== LLM_FILTER_POLICY_SHA256
            || normalizedSpec.promptSha256 !== LLM_FILTER_PROMPT_SHA256) fail('filter spec does not bind built-in production policy and prompt');
        const protocol = config.apiType === 'openai_responses' ? 'openai-responses'
            : config.apiType === 'anthropic' ? 'anthropic-messages' : 'openai-chat';
        const endpointSha = endpointIdentitySha256(config.endpoint, config.model);
        if (config.model !== state.input.model || protocol !== state.input.endpointProtocol
            || endpointSha !== state.input.endpointIdentitySha256) fail('runner model/protocol/endpoint differs from filter state');
        let intent = incompleteIntent(directory, state); let requestBody; let usageContext; let recovered = Boolean(intent);
        if (!intent) {
            if (!Object.hasOwn(state.decisions, paperId)) fail('runner paperId is not a filter candidate');
            if (FINAL_STATUSES.has(state.decisions[paperId].status)) return { state, paperId, recovered: false };
            ({ intent, requestBody, usageContext } = createIntent({ directory, state, paperId, owner, discoveryHandle, llm: config }));
        } else {
            paperId = intent.paperId;
            if (intent.expectedStateSha256 !== state.stateSha256) fail('incomplete LLM intent state changed before recovery');
            assertRequestBinding(intent.request, { state, paperId, discoveryHandle });
        }
        const existingDecision = readOptional(decisionFilename(directory, intent.operationId), 'LLM decision artifact', normalizeDecisionArtifact);
        if (existingDecision) {
            const existingReceipt = readOptional(responseFilename(directory, intent.operationId),
                'LLM transport receipt', normalizeTransportReceipt);
            if (!existingReceipt) fail('preserved LLM decision is missing its transport receipt');
            const expectedDecision = decisionFromTransport({ state, intent, receipt: existingReceipt,
                discoveryHandle, now: existingDecision.createdAt });
            if (stableHash(expectedDecision) !== stableHash(existingDecision)) {
                fail('preserved LLM decision does not replay from its intent and transport receipt');
            }
            const handle = loadDecisionHandleInternal(decisionFilename(directory, intent.operationId), { allowLlm: true });
            state = applyDecisionLocked({ filterRoot, filterId, decisionHandle: handle, lockHandle: lock });
            return { state, paperId, recovered: true };
        }
        let receipt = readOptional(responseFilename(directory, intent.operationId), 'LLM transport receipt', normalizeTransportReceipt);
        if (!receipt && recovered) {
            receipt = buildTransportReceipt({ intent, error: Object.assign(new Error(), { code: 'INTERRUPTED_OUTCOME_UNAVAILABLE' }),
                apiType: config.apiType });
            writeExclusive(responseFilename(directory, intent.operationId), `${JSON.stringify(receipt, null, 2)}\n`);
        } else if (!receipt) {
            let response = null; let error = null; const usageEvents = [];
            try {
                response = await fixedRequestLlmJson(config.apiUrl, config.endpoint, config.model, requestBody,
                    config.headers, { timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes,
                        apiKeys: config.apiKeys, accountPoolStateFile: config.accountPoolStateFile, usageContext,
                        usageSink: event => {
                            let persisted = false;
                            try { persisted = require('./llm-usage.js').writeLlmUsageEvent(event); } catch (_) { /* typed below */ }
                            usageEvents.push({ event, persisted });
                        } });
            } catch (caught) { error = caught; }
            receipt = buildTransportReceipt({ intent, response, error, apiType: config.apiType, usageEvents });
            writeExclusive(responseFilename(directory, intent.operationId), `${JSON.stringify(receipt, null, 2)}\n`);
        }
        const artifact = decisionFromTransport({ state, intent, receipt, discoveryHandle });
        const filename = writeDecisionArtifact({ filterRoot, filterId, decisionName: `llm-${intent.operationId}.json`, artifact });
        state = applyDecisionLocked({ filterRoot, filterId,
            decisionHandle: loadDecisionHandleInternal(filename, { allowLlm: true }), lockHandle: lock });
        return { state, paperId, recovered };
    } finally { releaseLock(lock); }
}

function selectNextCandidate(state, { retryFailed = false, maxAttempts = 3, retryBackoffMs = 60000,
    nowMs = Date.now() } = {}) {
    const checked = assertFilterState(state);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
        || !Number.isSafeInteger(retryBackoffMs) || retryBackoffMs < 0
        || !Number.isFinite(nowMs)) fail('runner retry policy is malformed');
    const pending = Object.keys(checked.decisions).filter(paperId => checked.decisions[paperId].status === 'pending');
    if (pending.length) return pending[0];
    if (!retryFailed) return null;
    for (const paperId of Object.keys(checked.decisions)) {
        if (checked.decisions[paperId].status !== 'failed') continue;
        const attempts = checked.attempts.filter(item => item.paperId === paperId);
        if (attempts.length >= maxAttempts) continue;
        const last = attempts.at(-1); const elapsed = nowMs - new Date(last.recordedAt).getTime();
        if (elapsed >= retryBackoffMs) return paperId;
    }
    return null;
}

module.exports = {
    VERSION, CONTRACT, SPEC_CONTRACT, DECISION_CONTRACT, SELECTION_RECEIPT_CONTRACT,
    SELECTION_HANDLE_CONTRACT, LLM_REQUEST_CONTRACT, LLM_INTENT_CONTRACT,
    LLM_TRANSPORT_RECEIPT_CONTRACT, LOCK_OWNER_CONTRACT, LOCK_STALE_MS,
    LLM_FILTER_POLICY, LLM_FILTER_PROMPT,
    LLM_FILTER_POLICY_SHA256, LLM_FILTER_PROMPT_SHA256, MAX_DECISION_PAYLOAD_BYTES, MAX_LLM_REQUEST_BYTES,
    UUID_RE, SAFE_JSON_NAME, PROTOCOLS, stableHash,
    normalizeCatalog, normalizeSpec, normalizeUsage, inputBinding,
    catalogFromDiscoveryHandle, completionFor, normalizePatch, normalizeDecisionArtifact, buildDecisionArtifact,
    assertFilterState, assertBoundInputs, safeDirectory, filterDirectory, safeDirectJson, prepareFilter, readFilter,
    writeDecisionArtifact, loadDecisionHandle, decisionHandleSnapshot, applyDecision, applyDecisionFile,
    selectionReceiptFor, normalizeSelectionReceipt, readSelectionReceipt, loadSelectionHandle, selectionHandleSnapshot,
    parseLlmDecisionText, requestEnvelope, cumulativeUsage, endpointIdentitySha256,
    normalizeLlmIntent, normalizeTransportReceipt, advanceProductionLlmDecision, selectNextCandidate
};
