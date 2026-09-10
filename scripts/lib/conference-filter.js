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
const evidenceApi = require('./conference-filter-evidence.js');
const paperIdentity = require('./paper-identity.js');
const keywordPrefilter = require('./keyword-prefilter.js');
const Config = require('../config.js');
const utilsApi = require('../utils.js');
const fixedRequestLlmJson = utilsApi.requestLlmJson;

const VERSION = 5;
const CONTRACT = 'conference-filter-v5';
const SPEC_VERSION = 5;
const SPEC_CONTRACT = 'conference-filter-spec-v5';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PAPER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,319}$/;
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'anthropic-messages']);
const DECISION_STATUSES = new Set(['pending', 'included', 'excluded', 'failed']);
const FINAL_STATUSES = new Set(['included', 'excluded']);
const EVIDENCE_STATUSES = new Set(['ready', 'missing', 'ambiguous', 'too-short', 'extraction-blocked']);
const DECISION_CONTRACT = 'conference-filter-decision-v5';
const SELECTION_RECEIPT_CONTRACT = 'conference-filter-selection-receipt-v5';
const SELECTION_HANDLE_CONTRACT = 'conference-filter-selection-v5';
const ACTOR_TYPES = new Set(['llm', 'manual', 'keyword']);
const MAX_DECISION_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_LLM_REQUEST_BYTES = 512 * 1024;
const DECISION_HANDLES = new WeakSet();
const DECISION_HANDLE_DATA = new WeakMap();
const SELECTION_HANDLES = new WeakSet();
const SELECTION_HANDLE_DATA = new WeakMap();
const LLM_ARTIFACT_AUTHORITY = Symbol('conference-filter-llm-runner');
const KEYWORD_ARTIFACT_AUTHORITY = Symbol('conference-filter-keyword-prefilter');
const LLM_REQUEST_CONTRACT = 'conference-filter-llm-request-v2';
const LLM_INTENT_CONTRACT = 'conference-filter-llm-intent-v2';
const LLM_TRANSPORT_RECEIPT_CONTRACT = 'conference-filter-llm-transport-receipt-v1';
const LOCK_OWNER_CONTRACT = 'conference-filter-lock-owner-v1';
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const KEYWORD_PREFILTER_CHECKPOINT_INTERVAL = 128;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;
const LOCK_HANDLES = new WeakSet();
const LOCK_HANDLE_DATA = new WeakMap();
// The conference path intentionally uses the exact first fenced block consumed
// by the daily digest. Keeping the placeholders here makes its SHA independent
// of a particular paper while every durable request preserves the rendered text.
const LLM_FILTER_PROMPT = utilsApi.loadPrompt('prompts/filter.md', {
    title: '{title}', abstract: '{abstract}', categories: '{categories}'
});
const DAILY_DECISION_PARSER_VERSION = 'filter-decision-contract-v3';
const CORE_CONFERENCE_FALLBACK_VERSION = 'core-audio-conferences-2026-v1';
const CORE_AUDIO_CONFERENCE_LABELS = Object.freeze({
    'dafx-2026': 'Digital Audio Effects',
    'iwslt-2026': 'Spoken Language Translation',
    'nime-2026': 'New Interfaces for Musical Expression',
    'odyssey-2026': 'Speaker and Language Recognition'
});
const CORE_AUDIO_CONFERENCE_IDS = Object.freeze(Object.keys(CORE_AUDIO_CONFERENCE_LABELS).sort());
const FILTER_CONFIG_BINDING = Object.freeze({
    decisionContractVersion: Config.FILTER_CONFIG.decisionContractVersion,
    keywordPrefilterVersion: keywordPrefilter.KEYWORD_PREFILTER_VERSION,
    coreConferenceFallbackVersion: CORE_CONFERENCE_FALLBACK_VERSION,
    coreAudioConferenceLabels: CORE_AUDIO_CONFERENCE_LABELS,
    keywordPrefilterEnabled: Config.FILTER_CONFIG.keywordPrefilterEnabled,
    batchSize: Math.min(5, Config.FILTER_CONFIG.batchSize),
    timeoutMs: Config.FILTER_CONFIG.timeoutMs,
    maxRetries: Config.FILTER_CONFIG.maxRetries,
    delayBetweenBatchesMs: Config.FILTER_CONFIG.delayBetweenBatchesMs,
    temperature: Config.FILTER_CONFIG.temperature,
    maxTokens: Config.FILTER_CONFIG.maxTokens,
    evidenceCatalogContract: evidenceApi.CATALOG_CONTRACT,
    evidenceLocatorContract: evidenceApi.LOCATOR_CONTRACT
});
const LLM_FILTER_POLICY = JSON.stringify({
    prompt: 'prompts/filter.md:first-fenced-block',
    parser: DAILY_DECISION_PARSER_VERSION,
    ...FILTER_CONFIG_BINDING
});

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
const FILTER_CONFIG_SHA256 = stableHash(FILTER_CONFIG_BINDING);
function stableJson(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return JSON.stringify(normalize(value));
}
function stableHash(value) { return sha256(stableJson(value)); }
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
        || !discoveryApi.ADAPTERS.has(value.adapter)) fail('discovery document contract/adapter is unsupported');
    exact(value.conference, ['id', 'year'], 'discovery conference');
    const conferenceId = nonempty(value.conference.id, 'discovery conference.id', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    if (!Number.isInteger(value.conference.year) || value.conference.year < 1900 || value.conference.year > 2100) {
        fail('discovery conference identity is inconsistent');
    }
    if (value.adapter === 'official-proceedings') {
        try { paperIdentity.conferenceCoordinates(value.conference); }
        catch (error) { fail(`discovery conference identity is inconsistent: ${error.message}`); }
    } else if (conferenceId !== `${value.adapter}-${value.conference.year}`) {
        fail('discovery conference identity is inconsistent');
    }
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
        const memberSchema = value.adapter === 'official-proceedings'
            ? ['identity', 'metadataIndex', 'title', 'numericAlias', 'pdfFile', 'match']
            : ['identity', 'metadataIndex', 'title', 'numericAlias', 'match'];
        exact(member, memberSchema, `discovery member[${index}]`);
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        if (!Number.isSafeInteger(member.metadataIndex) || member.metadataIndex < 0
            || typeof member.title !== 'string' || !member.title.trim()) fail(`discovery member[${index}] metadata is malformed`);
        if (member.numericAlias !== null && (typeof member.numericAlias !== 'string' || !/^[1-9]\d*$/.test(member.numericAlias))) {
            fail(`discovery member[${index}] numericAlias is malformed`);
        }
        const expectedIdentityType = value.adapter === 'icassp' ? 'icassp-arnumber'
            : value.adapter === 'official-proceedings' ? 'conference-paper-id' : 'openreview-forum-id';
        if (member.identity.type !== expectedIdentityType
            || (value.adapter !== 'icml' && member.numericAlias !== null)) {
            fail(`discovery member[${index}] identity/alias is inconsistent with adapter`);
        }
        exact(member.match, ['kind', 'candidates'], `discovery member[${index}].match`);
        if (!['exact', 'normalized', 'ambiguous', 'unmatched'].includes(member.match.kind)
            || !Array.isArray(member.match.candidates)) fail(`discovery member[${index}] match is malformed`);
        for (const candidate of member.match.candidates) {
            exact(candidate, ['path', 'sha256', 'size'], `discovery member[${index}] candidate`);
            if (!pdfPaths.has(candidate.path)) fail(`discovery member[${index}] references a PDF outside the catalog`);
            assertSha(candidate.sha256, `discovery member[${index}] candidate SHA`);
        }
        if (value.adapter === 'official-proceedings') {
            try {
                if (member.pdfFile !== null) ledgerApi.assertRelativePath(member.pdfFile, `discovery member[${index}].pdfFile`);
            } catch (error) { fail(error.message); }
            const actualPaths = member.match.candidates.map(candidate => candidate.path);
            if (!['exact', 'ambiguous', 'unmatched'].includes(member.match.kind)
                || (member.match.kind === 'unmatched' ? actualPaths.length !== 0
                    : member.pdfFile === null || actualPaths.length !== 1 || actualPaths[0] !== member.pdfFile)) {
                fail(`discovery member[${index}] official PDF match is not the exact metadata.pdfFile`);
            }
        }
        const paperId = paperIdentity.canonicalConferencePaperId(value.conference, member.identity);
        const sourceSha256 = stableHash({ documentSha256, metadataSnapshotSha256: value.metadataSnapshot.sha256,
            pdfCatalogSha256: value.pdfCatalogSha256, identity: member.identity,
            metadataIndex: member.metadataIndex,
            ...(value.adapter === 'official-proceedings' ? { pdfFile: member.pdfFile } : {}), match: member.match });
        return { paperId, sourceSha256 };
    });
    return normalizeCatalog({ contract: 'conference-discovery-catalog-v2', conferenceId,
        catalogSha256: assertSha(documentSha256, 'discovery document SHA'), members });
}

function normalizeSpec(value) {
    exact(value, ['contract', 'version', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol',
        'endpointIdentitySha256', 'taxonomyRegistrySha256', 'evidenceCatalogContract', 'discovery',
        'evidence'], 'filter spec');
    if (value.contract !== SPEC_CONTRACT || value.version !== SPEC_VERSION) fail('filter spec contract/version mismatch');
    const model = nonempty(value.model, 'filter spec model', /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);
    if (!PROTOCOLS.has(value.endpointProtocol)) fail('filter spec endpointProtocol is unsupported');
    exact(value.discovery, ['contract', 'conferenceId', 'catalogSha256', 'reportSha256',
        'candidateSetSha256'], 'filter spec discovery');
    const discovery = {
        contract: nonempty(value.discovery.contract, 'filter spec discovery.contract'),
        conferenceId: nonempty(value.discovery.conferenceId, 'filter spec discovery.conferenceId',
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        catalogSha256: assertSha(value.discovery.catalogSha256, 'filter spec discovery.catalogSha256'),
        reportSha256: assertSha(value.discovery.reportSha256, 'filter spec discovery.reportSha256'),
        candidateSetSha256: assertSha(value.discovery.candidateSetSha256,
            'filter spec discovery.candidateSetSha256')
    };
    const evidence = normalizeEvidenceBinding(value.evidence);
    const expectedLocator = evidenceApi.locatorBindingForConference({ id: discovery.conferenceId });
    if (stableHash(evidence.locator) !== stableHash(expectedLocator)) {
        fail('filter spec evidence locator is not a registered binding for its conference');
    }
    return {
        contract: SPEC_CONTRACT, version: SPEC_VERSION,
        filterPolicySha256: assertSha(value.filterPolicySha256, 'filter spec filterPolicySha256'),
        promptSha256: assertSha(value.promptSha256, 'filter spec promptSha256'), model,
        endpointProtocol: value.endpointProtocol,
        endpointIdentitySha256: assertSha(value.endpointIdentitySha256, 'filter spec endpointIdentitySha256'),
        taxonomyRegistrySha256: assertSha(value.taxonomyRegistrySha256, 'filter spec taxonomyRegistrySha256'),
        evidenceCatalogContract: nonempty(value.evidenceCatalogContract, 'filter spec evidenceCatalogContract'),
        discovery, evidence
    };
}

function normalizeLocatorBinding(value, label = 'filter evidence locator') {
    const fields = value && Object.hasOwn(value, 'profile')
        ? ['contract', 'profile', 'implementationSha256'] : ['contract', 'implementationSha256'];
    exact(value, fields, label);
    const normalized = { contract: nonempty(value.contract, `${label}.contract`) };
    if (fields.includes('profile')) normalized.profile = nonempty(value.profile, `${label}.profile`);
    normalized.implementationSha256 = assertSha(value.implementationSha256,
        `${label}.implementationSha256`);
    return normalized;
}

function normalizeEvidenceBinding(value, catalog) {
    exact(value, ['runId', 'catalogSha256', 'reportSha256', 'stateSha256', 'memberSetSha256',
        'locator'], 'filter evidence binding');
    nonempty(value.runId, 'filter evidence runId', UUID_RE);
    for (const field of ['catalogSha256', 'reportSha256', 'stateSha256', 'memberSetSha256']) {
        assertSha(value[field], `filter evidence ${field}`);
    }
    const locator = normalizeLocatorBinding(value.locator);
    if (catalog && value.memberSetSha256 !== stableHash(normalizeCatalog(catalog).members.map(member => member.paperId))) {
        fail('filter evidence member set differs from discovery candidates');
    }
    return { ...clone(value), locator };
}

function evidenceBindingFromHandle(evidenceHandle, catalog) {
    let snapshot;
    try { snapshot = evidenceApi.evidenceHandleSnapshot(evidenceHandle); }
    catch (error) { fail(`requires a complete authenticated evidence handle: ${error.message}`); }
    const normalizedCatalog = normalizeCatalog(catalog);
    const { catalog: evidenceCatalog, report } = snapshot;
    if (evidenceCatalog.contract !== evidenceApi.CATALOG_CONTRACT
        || evidenceCatalog.binding.conference.id !== normalizedCatalog.conferenceId
        || evidenceCatalog.binding.catalogSha256 !== normalizedCatalog.catalogSha256
        || report.catalogSha256 !== evidenceCatalog.catalogSha256) {
        fail('evidence catalog/report does not bind the same discovery catalog');
    }
    const paperIds = evidenceCatalog.members.map(member => member.paperId);
    if (paperIds.length !== normalizedCatalog.members.length
        || paperIds.some((paperId, index) => paperId !== normalizedCatalog.members[index].paperId)) {
        fail('evidence catalog does not cover the exact discovery candidate set');
    }
    return normalizeEvidenceBinding({ runId: evidenceCatalog.binding.runId,
        catalogSha256: evidenceCatalog.catalogSha256, reportSha256: report.reportSha256,
        stateSha256: evidenceCatalog.stateSha256, memberSetSha256: evidenceCatalog.memberSetSha256,
        locator: clone(evidenceCatalog.locator) }, normalizedCatalog);
}

function inputBinding(catalog, spec, evidenceBinding) {
    const normalizedCatalog = normalizeCatalog(catalog); const normalizedSpec = normalizeSpec(spec);
    const normalizedEvidence = normalizeEvidenceBinding(evidenceBinding, normalizedCatalog);
    const candidateSetSha256 = stableHash(normalizedCatalog.members);
    const bound = {
        discoveryContract: normalizedCatalog.contract, conferenceId: normalizedCatalog.conferenceId,
        catalogSha256: normalizedCatalog.catalogSha256, candidateSetSha256,
        filterPolicySha256: normalizedSpec.filterPolicySha256, promptSha256: normalizedSpec.promptSha256,
        model: normalizedSpec.model, endpointProtocol: normalizedSpec.endpointProtocol,
        endpointIdentitySha256: normalizedSpec.endpointIdentitySha256,
        taxonomyRegistrySha256: normalizedSpec.taxonomyRegistrySha256,
        evidenceCatalogContract: normalizedSpec.evidenceCatalogContract,
        specSha256: stableHash(normalizedSpec),
        evidence: normalizedEvidence
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
    if (!ACTOR_TYPES.has(value.type)) fail('decision actor.type must be llm, manual, or keyword');
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
        const parsedRequest = parseLlmRequestBody(Buffer.from(request.data, 'base64'), value.endpointProtocol);
        if (parsedRequest.body.model !== value.model) fail('LLM decision request model drifted');
    } else if (value.model !== null || value.endpointProtocol !== (actor.type === 'keyword' ? 'keyword-prefilter' : 'manual')
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
    return buildDecisionArtifactFromCheckedState({ state: checked, paperId, operationId, actor, model,
        endpointProtocol, endpointIdentitySha256, requestEnvelopeSha256, transportReceiptSha256,
        requestBytes, responseBytes, status, reason, usage, now, productionAuthority });
}

function buildDecisionArtifactFromCheckedState({ state: checked, paperId, operationId = crypto.randomUUID(), actor,
    model = null, endpointProtocol = 'manual', endpointIdentitySha256 = null,
    requestEnvelopeSha256 = null, transportReceiptSha256 = null, requestBytes,
    responseBytes = null, status, reason, usage = {}, now, productionAuthority } = {}) {
    if (actor?.type === 'llm' && productionAuthority !== LLM_ARTIFACT_AUTHORITY) {
        fail('LLM decision artifacts may only be produced by the authenticated conference filter runner');
    }
    if (actor?.type === 'keyword' && productionAuthority !== KEYWORD_ARTIFACT_AUTHORITY) {
        fail('keyword decisions may only be produced by the authenticated deterministic prefilter');
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

// Produces byte-for-byte the same canonical JSON that stateDigest() hashes,
// while retaining the append-only attempt SHA prefix.  This avoids rebuilding
// and recursively sorting the complete attempt history at every CAS step.
class StateDigestChain {
    constructor(state) {
        this.filterIdJson = stableJson(state.filterId);
        this.createdAtJson = stableJson(state.createdAt);
        this.inputJson = stableJson(state.input);
        // stableJson() uses the ECMAScript default UTF-16 key ordering.  The
        // persisted decision object is intentionally localeCompare-sorted for
        // human iteration, which is not equivalent for mixed case/punctuation
        // IDs (for example CVPR's DRiffusion vs Demo2Tutorial).  Digest entries
        // must therefore be independently canonical-sorted here.
        this.paperIds = Object.keys(state.decisions).sort();
        this.decisionIndex = new Map(this.paperIds.map((paperId, index) => [paperId, index]));
        this.decisionEntries = this.paperIds.map(paperId => this.decisionEntry(paperId, state.decisions[paperId]));
        this.counts = { included: 0, excluded: 0, pending: 0, failed: 0 };
        for (const decision of Object.values(state.decisions)) this.counts[decision.status] += 1;
        this.attemptPrefix = crypto.createHash('sha256');
        this.attemptPrefix.update('{"attempts":[', 'utf8');
        this.attemptCount = 0;
        for (const attempt of state.attempts) this.appendAttempt(attempt);
    }

    decisionEntry(paperId, decision) { return `${stableJson(paperId)}:${stableJson(decision)}`; }

    appendAttempt(attempt) {
        const { nextStateSha256: _next, ...withoutNext } = attempt;
        if (this.attemptCount) this.attemptPrefix.update(',', 'utf8');
        this.attemptPrefix.update(stableJson(withoutNext), 'utf8');
        this.attemptCount += 1;
    }

    updateDecision(paperId, previousStatus, decision) {
        const index = this.decisionIndex.get(paperId);
        if (index === undefined) fail('state digest chain references a non-candidate paper');
        if (this.counts[previousStatus] < 1) fail('state digest chain status count underflow');
        this.counts[previousStatus] -= 1; this.counts[decision.status] += 1;
        this.decisionEntries[index] = this.decisionEntry(paperId, decision);
    }

    materialize() {
        const decisionsJson = `{${this.decisionEntries.join(',')}}`;
        const status = this.counts.pending === 0 && this.counts.failed === 0 ? 'complete' : 'pending';
        const completion = { total: this.paperIds.length, ...this.counts, status,
            decisionSetSha256: sha256(decisionsJson) };
        const completionJson = stableJson(completion);
        const hash = this.attemptPrefix.copy();
        hash.update(`],"completion":${completionJson},"createdAt":${this.createdAtJson},"decisions":${decisionsJson},"filterId":${this.filterIdJson},"input":${this.inputJson}}`, 'utf8');
        return { completion, stateSha256: hash.digest('hex') };
    }
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
        'evidenceCatalogContract', 'specSha256', 'evidence', 'inputSha256'], 'input binding');
    const inputWithoutSha = { ...value.input }; delete inputWithoutSha.inputSha256;
    for (const field of ['catalogSha256', 'candidateSetSha256', 'filterPolicySha256', 'promptSha256',
        'endpointIdentitySha256', 'taxonomyRegistrySha256', 'specSha256']) {
        assertSha(value.input[field], `input.${field}`);
    }
    nonempty(value.input.discoveryContract, 'input.discoveryContract'); nonempty(value.input.conferenceId, 'input.conferenceId');
    nonempty(value.input.model, 'input.model'); if (!PROTOCOLS.has(value.input.endpointProtocol)) fail('input endpoint protocol is unsupported');
    nonempty(value.input.evidenceCatalogContract, 'input.evidenceCatalogContract');
    normalizeEvidenceBinding(value.input.evidence);
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
    const digestChain = new StateDigestChain(base);
    let previousDigest = digestChain.materialize().stateSha256; let previousTime = value.createdAt;
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
        const previousStatus = replayed[rawAttempt.paperId].status;
        replayed[rawAttempt.paperId] = { sourceSha256: replayed[rawAttempt.paperId].sourceSha256, ...patch.result };
        attempts.push({ ...clone(rawAttempt), patch }); operations.add(rawAttempt.operationId);
        digestChain.updateDecision(rawAttempt.paperId, previousStatus, replayed[rawAttempt.paperId]);
        digestChain.appendAttempt(rawAttempt);
        const nextDigest = digestChain.materialize().stateSha256;
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

function assertBoundInputsFromCheckedState(checked, { catalog, spec, evidenceBinding }) {
    const expected = inputBinding(catalog, spec, evidenceBinding);
    if (stableHash(checked.input) !== stableHash(expected)) fail('catalog, source, prompt, model, protocol, policy, or taxonomy input drifted');
    return checked;
}

function assertBoundInputs(state, bindings) {
    return assertBoundInputsFromCheckedState(assertFilterState(state), bindings);
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

function prepareFilter({ filterRoot, discoveryHandle, evidenceHandle, spec, filterId = crypto.randomUUID(), now } = {}) {
    const normalizedCatalog = catalogFromDiscoveryHandle(discoveryHandle); const normalizedSpec = normalizeSpec(spec);
    const evidenceBinding = evidenceBindingFromHandle(evidenceHandle, normalizedCatalog);
    const discovery = trustedDiscovery(discoveryHandle);
    const expectedDiscovery = { contract: normalizedCatalog.contract, conferenceId: normalizedCatalog.conferenceId,
        catalogSha256: normalizedCatalog.catalogSha256, reportSha256: discovery.reportSha256,
        candidateSetSha256: stableHash(normalizedCatalog.members) };
    if (normalizedSpec.evidenceCatalogContract !== evidenceApi.CATALOG_CONTRACT
        || stableHash(normalizedSpec.discovery) !== stableHash(expectedDiscovery)
        || stableHash(normalizedSpec.evidence) !== stableHash(evidenceBinding)) {
        fail('filter spec does not bind this authenticated discovery and evidence run');
    }
    const root = safeDirectory(filterRoot, true); nonempty(filterId, 'filterId', UUID_RE);
    const decisions = Object.fromEntries(normalizedCatalog.members.map(member => [member.paperId, initialDecision(member.sourceSha256)]));
    const state = { version: VERSION, contract: CONTRACT, filterId, createdAt: nowIso(now),
        input: inputBinding(normalizedCatalog, normalizedSpec, evidenceBinding), decisions,
        completion: completionFor(decisions), attempts: [] };
    state.stateSha256 = stateDigest(state);
    const directory = path.join(root, filterId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readFilter({ filterRoot: root, filterId });
        return applyKeywordPrefilter({ filterRoot: root, filterId, discoveryHandle,
            evidenceHandle, state: assertBoundInputs(existing,
                { catalog: normalizedCatalog, spec: normalizedSpec, evidenceBinding }), now });
    }
    try {
        fs.mkdirSync(path.join(directory, 'decisions'), { mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'llm-intents'), { mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'llm-responses'), { mode: 0o700 });
        writeExclusive(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) { throw fail(`could not create filter state: ${error.message}`); }
    return applyKeywordPrefilter({ filterRoot: root, filterId, discoveryHandle, evidenceHandle,
        state: assertFilterState(state), now });
}

function applyKeywordPrefilter({ filterRoot, filterId, discoveryHandle, evidenceHandle, state, now } = {}) {
    if (!FILTER_CONFIG_BINDING.keywordPrefilterEnabled) return assertFilterState(state);
    const directory = filterDirectory(filterRoot, filterId);
    const lock = acquireLock(directory, 'keyword-prefilter', now);
    try {
        let current = assertFilterState(state);
        const discovery = trustedDiscovery(discoveryHandle);
        let replays; let evidenceSnapshots;
        try {
            replays = discoveryApi.replayDiscoveryMembers(discoveryHandle);
            evidenceSnapshots = evidenceApi.evidenceHandleMemberSnapshots(evidenceHandle);
        } catch (error) { fail(`bulk keyword evidence replay failed: ${error.message}`); }
        const replayByPaperId = new Map();
        for (const replay of replays) {
            const paperId = paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, replay.identity);
            if (replayByPaperId.has(paperId)) fail('bulk discovery replay contains duplicate paperId values');
            replayByPaperId.set(paperId, replay);
        }
        const evidenceByPaperId = new Map();
        for (const snapshot of evidenceSnapshots) {
            if (evidenceByPaperId.has(snapshot.member.paperId)) fail('bulk evidence replay contains duplicate paperId values');
            evidenceByPaperId.set(snapshot.member.paperId, snapshot);
        }
        const paperIds = Object.keys(current.decisions);
        if (replayByPaperId.size !== paperIds.length || evidenceByPaperId.size !== paperIds.length
            || paperIds.some(paperId => !replayByPaperId.has(paperId) || !evidenceByPaperId.has(paperId))) {
            fail('bulk keyword evidence replay does not close over the filter candidate set');
        }
        const stateFile = safeDirectJson(directory, 'state.json');
        const operationIds = new Set(current.attempts.map(attempt => attempt.operationId));
        const digestChain = new StateDigestChain(current);
        let uncheckpointed = 0;
        for (const paperId of Object.keys(current.decisions)) {
            if (current.decisions[paperId].status !== 'pending') continue;
            const envelope = requestEnvelopeFromReplay({ state: current, paperId, discovery,
                replay: replayByPaperId.get(paperId), evidenceSnapshot: evidenceByPaperId.get(paperId) });
            const evaluation = evaluateConferenceKeywordPrefilter(envelope.metadataRecord,
                envelope.discovery.conference.id, envelope.evidence.status);
            if (evaluation.pass) continue;
            const operationId = crypto.randomUUID();
            if (operationIds.has(operationId)) fail('keyword operationId collided with existing attempt history');
            operationIds.add(operationId);
            const evidence = { contract: 'conference-keyword-prefilter-evidence-v2', version: 2,
                paperId, sourceSha256: current.decisions[paperId].sourceSha256,
                metadataRecordSha256: envelope.discovery.metadataRecordSha256,
                requestEnvelopeSha256: envelope.requestSha256, evidence: clone(envelope.evidence), evaluation };
            const artifact = buildDecisionArtifactFromCheckedState({ state: current, paperId, operationId,
                actor: { type: 'keyword', id: keywordPrefilter.KEYWORD_PREFILTER_VERSION },
                model: null, endpointProtocol: 'keyword-prefilter', requestBytes: JSON.stringify(evidence),
                responseBytes: JSON.stringify(evaluation), status: 'excluded', reason: evaluation.reason,
                usage: {}, now, productionAuthority: KEYWORD_ARTIFACT_AUTHORITY });
            const filename = writeDecisionArtifact({ filterRoot, filterId,
                decisionName: `keyword-${operationId}.json`, artifact });
            const handle = loadDecisionHandleInternal(filename); const trusted = decisionHandleSnapshot(handle);
            if (trusted.artifact.artifactSha256 !== artifact.artifactSha256
                || trusted.artifact.expectedStateSha256 !== current.stateSha256
                || trusted.artifact.paperId !== paperId
                || trusted.artifact.sourceSha256 !== current.decisions[paperId].sourceSha256
                || trusted.artifact.actor.type !== 'keyword') {
                fail('preserved keyword artifact drifted before batched apply');
            }
            const previous = current.decisions[paperId];
            const patch = normalizePatch({ operationId, expectedStateSha256: artifact.expectedStateSha256,
                paperId, result: artifact.result });
            const patchSha256 = stableHash(patch); const recordedAt = nowIso(now);
            if (artifact.createdAt > recordedAt) fail('keyword artifact creation time is after apply time');
            current.decisions[paperId] = { sourceSha256: previous.sourceSha256, ...patch.result };
            const attempt = { operationId, paperId, fromStatus: previous.status, toStatus: patch.result.status,
                reason: patch.result.reason, responseSha256: patch.result.responseSha256,
                usage: clone(patch.result.usage), recordedAt, priorStateSha256: artifact.expectedStateSha256,
                nextStateSha256: '', patchSha256, patch: clone(patch),
                decisionArtifactName: path.basename(trusted.filename),
                decisionArtifactSha256: artifact.artifactSha256,
                decisionArtifactFileSha256: trusted.fileSha256 };
            current.attempts.push(attempt);
            digestChain.updateDecision(paperId, previous.status, current.decisions[paperId]);
            digestChain.appendAttempt(attempt);
            const digest = digestChain.materialize(); current.completion = digest.completion;
            current.stateSha256 = digest.stateSha256;
            attempt.nextStateSha256 = current.stateSha256; uncheckpointed += 1;
            if (uncheckpointed >= KEYWORD_PREFILTER_CHECKPOINT_INTERVAL) {
                replaceRegular(stateFile, `${JSON.stringify(current, null, 2)}\n`); uncheckpointed = 0;
            }
        }
        const checked = assertFilterState(current);
        if (uncheckpointed) replaceRegular(stateFile, `${JSON.stringify(checked, null, 2)}\n`);
        ensureSelectionReceipt(directory, checked);
        return checked;
    } finally { releaseLock(lock); }
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

function selectionReceiptFromCheckedState(checked) {
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

function selectionReceiptFor(state) {
    return selectionReceiptFromCheckedState(assertFilterState(state));
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
    const receipt = selectionReceiptFromCheckedState(checked);
    const receiptFile = path.join(directory, 'selection-receipt.json');
    try { writeExclusive(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        normalizeSelectionReceipt(readJson(receiptFile, 'selection receipt').value, checked);
    }
    return receipt;
}


// Used only while the production runner holds the authenticated operation lock
// and advances a state that was fully replayed at session start.  Keeping this
// separate from the public helper prevents a second O(history * candidates)
// validation at the final item without changing the receipt bytes.
function ensureSelectionReceiptFromCheckedState(directory, checked) {
    if (checked.completion.status !== 'complete') return null;
    const receipt = selectionReceiptFromCheckedState(checked);
    const receiptFile = path.join(directory, 'selection-receipt.json');
    try { writeExclusive(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const loaded = normalizeSelectionReceipt(readJson(receiptFile, 'selection receipt').value, checked);
        if (stableHash(loaded) !== stableHash(receipt)) fail('selection receipt changed during locked runner completion');
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
    if (typeof source !== 'string' || !source.trim()) fail('LLM response text must contain a decision');
    source = source.trim();
    if (Buffer.byteLength(source, 'utf8') > 64 * 1024) fail('LLM response text exceeds the decision limit');
    // Preserve the old conference JSON vocabulary for already-paid responses,
    // then use the daily digest parser for all current responses.
    try {
        rejectDuplicateJsonKeys(source, 'LLM response');
        const value = JSON.parse(source);
        if (isPlainObject(value) && FINAL_STATUSES.has(value.decision)) {
            exact(value, ['decision', 'reason'], 'LLM response');
            const reason = nonempty(value.reason, 'LLM response reason');
            if (reason.length > 4000) fail('LLM response reason is too long');
            return { status: value.decision, reason, parseSource: 'legacy_conference_json' };
        }
    } catch (error) {
        if (String(error.message || error).startsWith('Invalid conference filter:')) throw error;
    }
    const parsed = require('../fetch-papers.js').parseFilterDecisionDetails(source);
    if (parsed.related === null || parsed.retryable) fail('LLM response is not strict JSON and has no structured daily-filter decision');
    const reason = nonempty(parsed.reason || `日更筛选解析：${parsed.parseSource}`, 'LLM response reason');
    if (reason.length > 4000) fail('LLM response reason is too long');
    return { status: parsed.related ? 'included' : 'excluded', reason, parseSource: parsed.parseSource };
}

function conferencePromptCategories(record, conferenceId) {
    const values = [conferenceId, CORE_AUDIO_CONFERENCE_LABELS[conferenceId], record.track,
        ...(Array.isArray(record.categories) ? record.categories : [record.categories || record.category])]
        .filter(Boolean).map(String);
    return [...new Set(values)];
}

function promptFields(envelope) {
    const record = envelope.metadataRecord || {};
    const conferenceId = envelope.discovery.conference.id;
    return { title: String(record.title || ''), abstract: String(record.abstract || record.summary || ''),
        categories: conferencePromptCategories(record, conferenceId).join(', ') };
}

function renderDailyFilterPrompt(envelope) {
    return utilsApi.loadPrompt('prompts/filter.md', promptFields(envelope));
}

function evaluateConferenceKeywordPrefilter(record, conferenceId, evidenceStatus = 'ready') {
    const base = keywordPrefilter.evaluateKeywordPrefilter(record);
    const conferenceCategoryFallback = CORE_AUDIO_CONFERENCE_IDS.includes(conferenceId);
    const evidenceFailOpen = evidenceStatus !== 'ready';
    return {
        ...base,
        pass: base.pass || conferenceCategoryFallback || evidenceFailOpen,
        reason: evidenceFailOpen && !base.pass && !conferenceCategoryFallback
            ? `全文摘要证据状态为 ${evidenceStatus}，证据不足，安全放行给 LLM`
            : conferenceCategoryFallback && !base.pass
            ? `核心音频会议兜底：${conferenceId}`
            : base.reason,
        conferenceId,
        conferenceCategoryLabel: CORE_AUDIO_CONFERENCE_LABELS[conferenceId] || null,
        conferenceCategories: conferencePromptCategories(record, conferenceId),
        conferenceCategoryFallback,
        evidenceStatus,
        evidenceFailOpen,
        conferenceFallbackVersion: CORE_CONFERENCE_FALLBACK_VERSION
    };
}

function evidenceFromSnapshot({ state, paperId, snapshot, officialRecord }) {
    const binding = state.input.evidence;
    if (snapshot.catalogSha256 !== binding.catalogSha256 || snapshot.reportSha256 !== binding.reportSha256
        || snapshot.member.paperId !== paperId || snapshot.member.receiptSha256 !== snapshot.receipt.receiptSha256
        || stableHash(snapshot.receipt.locator) !== stableHash(binding.locator)) {
        fail('paper evidence does not bind the filter evidence catalog/locator');
    }
    const metadataRecord = clone(officialRecord);
    if (snapshot.receipt.evidence.status === 'ready') metadataRecord.abstract = snapshot.receipt.evidence.text;
    const evidence = { runId: binding.runId, catalogSha256: binding.catalogSha256,
        reportSha256: binding.reportSha256, stateSha256: binding.stateSha256,
        memberSetSha256: binding.memberSetSha256, receiptFileSha256: snapshot.member.receiptFileSha256,
        receiptSha256: snapshot.member.receiptSha256, status: snapshot.receipt.evidence.status,
        evidenceSha256: snapshot.receipt.evidence.sha256,
        locator: clone(binding.locator),
        effectiveMetadataRecordSha256: stableHash(metadataRecord) };
    return { metadataRecord, evidence };
}

function requestEnvelopeFromReplay({ state, paperId, discovery, replay, evidenceSnapshot }) {
    const sourceIdentity = ledgerApi.identityKey(replay.identity);
    if (replay.sourceIdentity !== sourceIdentity) fail('discovery replay identity drifted');
    const decision = state.decisions[paperId];
    if (!decision) fail('runner paperId is absent from filter state');
    const projected = evidenceSnapshot
        ? evidenceFromSnapshot({ state, paperId, snapshot: evidenceSnapshot, officialRecord: replay.metadataRecord })
        : null;
    if (!projected) fail('authenticated evidence snapshot is required');
    const body = { contract: LLM_REQUEST_CONTRACT, version: 2, filterId: state.filterId,
        expectedStateSha256: state.stateSha256, paperId, sourceSha256: decision.sourceSha256,
        discovery: { contract: discovery.candidateManifest.contract, catalogSha256: discovery.catalogSha256,
            conference: replay.conference, adapter: replay.adapter, sourceIdentity, identity: replay.identity,
            metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
            metadataRecordSha256: replay.metadataRecordSha256 },
        evidence: projected.evidence,
        filter: { inputSha256: state.input.inputSha256, filterPolicySha256: state.input.filterPolicySha256,
            promptSha256: state.input.promptSha256, model: state.input.model,
            endpointProtocol: state.input.endpointProtocol,
            endpointIdentitySha256: state.input.endpointIdentitySha256,
            taxonomyRegistrySha256: state.input.taxonomyRegistrySha256,
            evidenceCatalogContract: state.input.evidenceCatalogContract,
            specSha256: state.input.specSha256,
            evidenceLocator: clone(state.input.evidence.locator),
            coreConferenceFallbackVersion: CORE_CONFERENCE_FALLBACK_VERSION,
            conferenceCategoryLabel: CORE_AUDIO_CONFERENCE_LABELS[replay.conference.id] || null },
        metadataRecord: projected.metadataRecord };
    return { ...body, requestSha256: stableHash(body) };
}

function requestEnvelope({ state, paperId, discoveryHandle, evidenceHandle }) {
    const discovery = trustedDiscovery(discoveryHandle);
    const matches = discovery.candidateManifest.members.filter(member => (
        paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, member.identity) === paperId
    ));
    if (matches.length !== 1) fail('runner paperId is absent or duplicated in authenticated discovery');
    const member = matches[0]; const sourceIdentity = ledgerApi.identityKey(member.identity);
    const replay = discoveryApi.replayDiscoveryMember(discoveryHandle, sourceIdentity);
    const evidenceSnapshot = evidenceApi.evidenceHandleSnapshot(evidenceHandle, paperId);
    return requestEnvelopeFromReplay({ state, paperId, discovery, replay, evidenceSnapshot });
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

function buildProductionSpec({ endpoint, model, taxonomyRegistrySha256, discoveryHandle, evidenceHandle } = {}) {
    endpoint = nonempty(String(endpoint || '').trim(), 'production spec endpoint');
    model = nonempty(String(model || '').trim(), 'production spec model');
    const apiType = utilsApi.detectApiType(endpoint, model);
    const endpointProtocol = apiType === 'openai_responses' ? 'openai-responses'
        : apiType === 'anthropic' ? 'anthropic-messages' : 'openai-chat';
    const catalog = catalogFromDiscoveryHandle(discoveryHandle);
    const discovery = trustedDiscovery(discoveryHandle);
    const evidence = evidenceBindingFromHandle(evidenceHandle, catalog);
    return normalizeSpec({ contract: SPEC_CONTRACT, version: SPEC_VERSION,
        filterPolicySha256: LLM_FILTER_POLICY_SHA256, promptSha256: LLM_FILTER_PROMPT_SHA256,
        model, endpointProtocol, endpointIdentitySha256: endpointIdentitySha256(endpoint, model),
        taxonomyRegistrySha256, evidenceCatalogContract: evidenceApi.CATALOG_CONTRACT,
        discovery: { contract: catalog.contract, conferenceId: catalog.conferenceId,
            catalogSha256: catalog.catalogSha256, reportSha256: discovery.reportSha256,
            candidateSetSha256: stableHash(catalog.members) }, evidence });
}

function writeFilterSpec({ specRoot, specName, spec } = {}) {
    const root = safeDirectory(specRoot, true);
    const filename = safeDirectJson(root, specName, { mustExist: false });
    const normalized = normalizeSpec(spec);
    writeExclusive(filename, `${JSON.stringify(normalized, null, 2)}\n`);
    return filename;
}

function normalizeRequestEnvelope(value) {
    exact(value, ['contract', 'version', 'filterId', 'expectedStateSha256', 'paperId', 'sourceSha256',
        'discovery', 'evidence', 'filter', 'metadataRecord', 'requestSha256'], 'LLM request envelope');
    if (value.contract !== LLM_REQUEST_CONTRACT || value.version !== 2) fail('LLM request contract/version mismatch');
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
    if (!discoveryApi.ADAPTERS.has(value.discovery.adapter)) fail('LLM request adapter is unsupported');
    const sourceIdentity = ledgerApi.identityKey(value.discovery.identity);
    if (value.discovery.sourceIdentity !== sourceIdentity) fail('LLM request source identity drifted');
    assertSha(value.discovery.metadataSnapshotSha256, 'LLM request metadata snapshot SHA');
    if (!Number.isSafeInteger(value.discovery.metadataIndex) || value.discovery.metadataIndex < 0) {
        fail('LLM request metadata index is malformed');
    }
    assertSha(value.discovery.metadataRecordSha256, 'LLM request official metadata record SHA');
    exact(value.evidence, ['runId', 'catalogSha256', 'reportSha256', 'stateSha256', 'memberSetSha256',
        'receiptFileSha256', 'receiptSha256', 'status', 'evidenceSha256', 'locator',
        'effectiveMetadataRecordSha256'], 'LLM request evidence');
    nonempty(value.evidence.runId, 'LLM request evidence runId', UUID_RE);
    for (const field of ['catalogSha256', 'reportSha256', 'stateSha256', 'memberSetSha256',
        'receiptFileSha256', 'receiptSha256', 'effectiveMetadataRecordSha256']) {
        assertSha(value.evidence[field], `LLM request evidence.${field}`);
    }
    if (!EVIDENCE_STATUSES.has(value.evidence.status)) {
        fail('LLM request evidence status is unsupported');
    }
    if (value.evidence.status === 'ready') assertSha(value.evidence.evidenceSha256, 'LLM request evidence SHA');
    else if (value.evidence.evidenceSha256 !== null) fail('non-ready LLM request evidence cannot have evidence SHA');
    normalizeLocatorBinding(value.evidence.locator, 'LLM request evidence locator');
    if (value.evidence.effectiveMetadataRecordSha256 !== stableHash(value.metadataRecord)) {
        fail('LLM request effective metadata record SHA drifted');
    }
    exact(value.filter, ['inputSha256', 'filterPolicySha256', 'promptSha256', 'model', 'endpointProtocol',
        'endpointIdentitySha256', 'taxonomyRegistrySha256', 'evidenceCatalogContract',
        'specSha256', 'evidenceLocator', 'coreConferenceFallbackVersion',
        'conferenceCategoryLabel'], 'LLM request filter binding');
    for (const field of ['inputSha256', 'filterPolicySha256', 'promptSha256', 'endpointIdentitySha256',
        'taxonomyRegistrySha256', 'specSha256']) {
        assertSha(value.filter[field], `LLM request filter.${field}`);
    }
    nonempty(value.filter.model, 'LLM request model');
    if (!PROTOCOLS.has(value.filter.endpointProtocol)) fail('LLM request endpoint protocol is unsupported');
    nonempty(value.filter.evidenceCatalogContract, 'LLM request filter evidenceCatalogContract');
    normalizeLocatorBinding(value.filter.evidenceLocator, 'LLM request filter evidence locator');
    if (stableHash(value.filter.evidenceLocator) !== stableHash(value.evidence.locator)) {
        fail('LLM request filter/evidence locator binding drifted');
    }
    if (value.filter.coreConferenceFallbackVersion !== CORE_CONFERENCE_FALLBACK_VERSION
        || value.filter.conferenceCategoryLabel !== (CORE_AUDIO_CONFERENCE_LABELS[value.discovery.conference.id] || null)) {
        fail('LLM request conference category fallback mapping drifted');
    }
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

function parseLlmRequestBody(bytes, protocol) {
    const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    const body = parseStrictJson(source, 'preserved LLM request');
    let user;
    if (protocol === 'openai-responses') {
        const allowed = new Set(['model', 'input', 'max_output_tokens', 'temperature', 'reasoning', 'stream']);
        if (!isPlainObject(body) || Object.keys(body).some(key => !allowed.has(key)) || !Array.isArray(body.input)
            || body.input.length !== 1) fail('OpenAI Responses request must contain exactly one user message');
        const read = (message, role) => {
            exact(message, ['role', 'content'], `LLM ${role} message`);
            if (message.role !== role || !Array.isArray(message.content) || message.content.length !== 1) fail(`LLM ${role} message shape drifted`);
            exact(message.content[0], ['type', 'text'], `LLM ${role} message content`);
            if (message.content[0].type !== 'input_text' || typeof message.content[0].text !== 'string') fail(`LLM ${role} message content drifted`);
            return message.content[0].text;
        };
        user = read(body.input[0], 'user');
        if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1
            || !Number.isFinite(body.temperature)) fail('OpenAI Responses request limits are malformed');
        if (body.reasoning !== undefined
            && (!isPlainObject(body.reasoning) || !['low', 'medium', 'high'].includes(body.reasoning.effort)
                || Object.keys(body.reasoning).length !== 1)) fail('OpenAI Responses reasoning option is malformed');
        if (body.stream !== undefined && body.stream !== true) fail('OpenAI Responses stream option is malformed');
    } else if (protocol === 'anthropic-messages') {
        const allowed = new Set(['model', 'max_tokens', 'messages', 'temperature']);
        if (!isPlainObject(body) || Object.keys(body).some(key => !allowed.has(key)) || !Array.isArray(body.messages)
            || body.messages.length !== 1 || body.messages[0]?.role !== 'user'
            || typeof body.messages[0]?.content !== 'string') {
            fail('Anthropic request must contain exactly one user message and no system prompt');
        }
        user = body.messages[0].content;
        if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
            || !Number.isFinite(body.temperature)) fail('Anthropic request limits are malformed');
    } else {
        exact(body, ['model', 'messages', 'max_tokens', 'temperature'], 'OpenAI chat request');
        if (!Array.isArray(body.messages) || body.messages.length !== 1
            || body.messages[0]?.role !== 'user' || typeof body.messages[0]?.content !== 'string') {
            fail('OpenAI chat request must contain exactly one user message');
        }
        user = body.messages[0].content;
        if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
            || !Number.isFinite(body.temperature)) fail('OpenAI chat request limits are malformed');
    }
    if (body.model === undefined || typeof body.model !== 'string' || !user) fail('LLM request model or user prompt drifted');
    return { body, prompt: user };
}

function assertRequestBinding(request, { state, paperId, discoveryHandle, evidenceHandle, envelope,
    expectedEnvelope = null }) {
    const parsed = parseLlmRequestBody(Buffer.from(request.data, 'base64'), state.input.endpointProtocol);
    if (parsed.body.model !== state.input.model) fail('preserved LLM request model drifted');
    const expected = expectedEnvelope === null
        ? requestEnvelope({ state, paperId, discoveryHandle, evidenceHandle })
        : normalizeRequestEnvelope(expectedEnvelope);
    const preservedEnvelope = normalizeRequestEnvelope(envelope);
    if (stableHash(preservedEnvelope) !== stableHash(expected)
        || parsed.prompt !== renderDailyFilterPrompt(preservedEnvelope)) {
        fail('preserved LLM request does not bind current source metadata, filter input, and rendered daily prompt');
    }
    return parsed;
}

function intentDigest(value) { const copy = clone(value); delete copy.intentSha256; return stableHash(copy); }
function envelopeFromRecord(record) {
    const checked = normalizeByteRecord(record, 'LLM intent source envelope');
    return normalizeRequestEnvelope(parseStrictJson(Buffer.from(checked.data, 'base64').toString('utf8'),
        'LLM intent source envelope'));
}
function normalizeLlmIntent(value) {
    exact(value, ['contract', 'version', 'filterId', 'operationId', 'expectedStateSha256', 'paperId',
        'sourceSha256', 'actorId', 'endpointIdentitySha256', 'inputSha256', 'requestEnvelopeSha256',
        'envelope', 'usageContextSha256', 'attemptNumber', 'request', 'createdAt', 'intentSha256'], 'LLM intent');
    if (value.contract !== LLM_INTENT_CONTRACT || value.version !== 2) fail('LLM intent contract/version mismatch');
    nonempty(value.filterId, 'LLM intent filterId', UUID_RE); nonempty(value.operationId, 'LLM intent operationId', UUID_RE);
    assertSha(value.expectedStateSha256, 'LLM intent expected state SHA'); nonempty(value.paperId, 'LLM intent paperId', PAPER_ID_RE);
    assertSha(value.sourceSha256, 'LLM intent source SHA'); nonempty(value.actorId, 'LLM intent actor', OWNER_RE);
    for (const field of ['endpointIdentitySha256', 'inputSha256', 'requestEnvelopeSha256', 'usageContextSha256']) {
        assertSha(value[field], `LLM intent ${field}`);
    }
    if (!Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1) fail('LLM intent attemptNumber is malformed');
    const envelope = envelopeFromRecord(value.envelope);
    if (envelope.requestSha256 !== value.requestEnvelopeSha256 || envelope.filterId !== value.filterId
        || envelope.expectedStateSha256 !== value.expectedStateSha256 || envelope.paperId !== value.paperId
        || envelope.sourceSha256 !== value.sourceSha256 || envelope.filter.inputSha256 !== value.inputSha256
        || envelope.filter.endpointIdentitySha256 !== value.endpointIdentitySha256) {
        fail('LLM intent envelope does not bind the intent source/filter identity');
    }
    const request = normalizeByteRecord(value.request, 'LLM intent request');
    const parsedRequest = parseLlmRequestBody(Buffer.from(request.data, 'base64'), envelope.filter.endpointProtocol);
    if (parsedRequest.body.model !== envelope.filter.model || parsedRequest.prompt !== renderDailyFilterPrompt(envelope)) {
        fail('LLM intent request is not the single-user daily filter prompt bound by its envelope');
    }
    timestamp(value.createdAt, 'LLM intent createdAt');
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

function decisionFromTransport({ state, intent, receipt, discoveryHandle, evidenceHandle,
    expectedEnvelope = null, now }) {
    const checkedIntent = normalizeLlmIntent(intent); const checkedReceipt = normalizeTransportReceipt(receipt);
    if (checkedReceipt.filterId !== checkedIntent.filterId || checkedReceipt.operationId !== checkedIntent.operationId
        || checkedReceipt.intentSha256 !== checkedIntent.intentSha256
        || checkedReceipt.endpointIdentitySha256 !== checkedIntent.endpointIdentitySha256
        || checkedReceipt.usageContextSha256 !== checkedIntent.usageContextSha256) fail('LLM transport receipt does not bind its intent');
    if (state.stateSha256 !== checkedIntent.expectedStateSha256 || state.filterId !== checkedIntent.filterId
        || state.decisions[checkedIntent.paperId]?.sourceSha256 !== checkedIntent.sourceSha256
        || state.input.inputSha256 !== checkedIntent.inputSha256
        || state.input.endpointIdentitySha256 !== checkedIntent.endpointIdentitySha256) fail('LLM intent no longer binds filter state');
    const parsedRequest = assertRequestBinding(checkedIntent.request, { state, paperId: checkedIntent.paperId,
        discoveryHandle, evidenceHandle, envelope: envelopeFromRecord(checkedIntent.envelope), expectedEnvelope });
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

function createIntent({ directory, state, paperId, owner, discoveryHandle, evidenceHandle,
    expectedEnvelope = null, llm, now }) {
    const envelope = expectedEnvelope === null
        ? requestEnvelope({ state, paperId, discoveryHandle, evidenceHandle })
        : normalizeRequestEnvelope(expectedEnvelope);
    const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (envelopeBytes.length > MAX_LLM_REQUEST_BYTES) fail('source envelope exceeds the durable evidence limit');
    const messages = [{ role: 'user', content: renderDailyFilterPrompt(envelope) }];
    const attemptNumber = state.attempts.filter(item => item.paperId === paperId).length + 1;
    const attemptMaxTokens = utilsApi.getFilterAttemptMaxTokens(llm.apiType, llm.maxTokens, attemptNumber);
    const requestBody = utilsApi.buildRequestBody(llm.apiType, llm.model, messages, attemptMaxTokens, llm.temperature);
    const requestBytes = Buffer.from(JSON.stringify(requestBody), 'utf8');
    if (!requestBytes.length || requestBytes.length > MAX_LLM_REQUEST_BYTES) fail('LLM request exceeds the durable evidence limit before transport');
    const operationId = crypto.randomUUID(); const usageContext = {
        stage: 'conference-filter', unitId: stableHash({ filterId: state.filterId, paperId,
            sourceSha256: state.decisions[paperId].sourceSha256, operationId }) };
    const body = { contract: LLM_INTENT_CONTRACT, version: 2, filterId: state.filterId, operationId,
        expectedStateSha256: state.stateSha256, paperId, sourceSha256: state.decisions[paperId].sourceSha256,
        actorId: owner, endpointIdentitySha256: state.input.endpointIdentitySha256,
        inputSha256: state.input.inputSha256, requestEnvelopeSha256: envelope.requestSha256,
        envelope: byteRecord(envelopeBytes, 'LLM intent source envelope'), usageContextSha256: stableHash(usageContext),
        attemptNumber,
        request: byteRecord(requestBytes, 'LLM intent request'), createdAt: nowIso(now) };
    const intent = normalizeLlmIntent({ ...body, intentSha256: stableHash(body) });
    assertRequestBinding(intent.request, { state, paperId, discoveryHandle, evidenceHandle,
        envelope, expectedEnvelope: envelope });
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

function assertProductionRunnerBinding(state, normalizedSpec, config) {
    if (normalizedSpec.filterPolicySha256 !== LLM_FILTER_POLICY_SHA256
        || normalizedSpec.promptSha256 !== LLM_FILTER_PROMPT_SHA256) {
        fail('filter spec does not bind built-in production policy and prompt');
    }
    const protocol = config.apiType === 'openai_responses' ? 'openai-responses'
        : config.apiType === 'anthropic' ? 'anthropic-messages' : 'openai-chat';
    const endpointSha = endpointIdentitySha256(config.endpoint, config.model);
    if (config.model !== state.input.model || protocol !== state.input.endpointProtocol
        || endpointSha !== state.input.endpointIdentitySha256) {
        fail('runner model/protocol/endpoint differs from filter state');
    }
}

function productionReplayContext(state, discoveryHandle, evidenceHandle) {
    const discovery = trustedDiscovery(discoveryHandle);
    let replays; let evidenceSnapshots;
    try {
        replays = discoveryApi.replayDiscoveryMembers(discoveryHandle);
        evidenceSnapshots = evidenceApi.evidenceHandleMemberSnapshots(evidenceHandle);
    } catch (error) { fail(`bulk production evidence replay failed: ${error.message}`); }
    const replayByPaperId = new Map();
    for (const replay of replays) {
        const paperId = paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, replay.identity);
        if (replayByPaperId.has(paperId)) fail('bulk production discovery replay contains duplicate paperId values');
        replayByPaperId.set(paperId, replay);
    }
    const evidenceByPaperId = new Map();
    for (const snapshot of evidenceSnapshots) {
        if (evidenceByPaperId.has(snapshot.member.paperId)) fail('bulk production evidence replay contains duplicate paperId values');
        evidenceByPaperId.set(snapshot.member.paperId, snapshot);
    }
    const paperIds = Object.keys(state.decisions);
    if (replayByPaperId.size !== paperIds.length || evidenceByPaperId.size !== paperIds.length
        || paperIds.some(paperId => !replayByPaperId.has(paperId) || !evidenceByPaperId.has(paperId))) {
        fail('bulk production evidence replay does not close over the filter candidate set');
    }
    return { discovery, replayByPaperId, evidenceByPaperId };
}

function envelopeFromProductionReplay(state, paperId, replayContext) {
    return requestEnvelopeFromReplay({ state, paperId, discovery: replayContext.discovery,
        replay: replayContext.replayByPaperId.get(paperId),
        evidenceSnapshot: replayContext.evidenceByPaperId.get(paperId) });
}

function selectNextCandidateFromCheckedState(checked, { retryFailed = false, maxAttempts = 3,
    retryBackoffMs = 60000, nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
        || !Number.isSafeInteger(retryBackoffMs) || retryBackoffMs < 0
        || !Number.isFinite(nowMs)) fail('runner retry policy is malformed');
    for (const paperId of Object.keys(checked.decisions)) {
        if (checked.decisions[paperId].status === 'pending') return paperId;
    }
    if (!retryFailed) return null;
    const attemptsByPaper = new Map();
    for (const attempt of checked.attempts) {
        if (!attemptsByPaper.has(attempt.paperId)) attemptsByPaper.set(attempt.paperId, []);
        attemptsByPaper.get(attempt.paperId).push(attempt);
    }
    for (const paperId of Object.keys(checked.decisions)) {
        if (checked.decisions[paperId].status !== 'failed') continue;
        const attempts = attemptsByPaper.get(paperId) || [];
        if (attempts.length >= maxAttempts) continue;
        const last = attempts.at(-1); const elapsed = nowMs - new Date(last.recordedAt).getTime();
        if (elapsed >= retryBackoffMs) return paperId;
    }
    return null;
}

function applyProductionDecisionToCheckedState({ directory, state, digestChain, operationIds,
    decisionFile, artifact, now } = {}) {
    const handle = loadDecisionHandleInternal(decisionFile, { allowLlm: true });
    const trusted = decisionHandleSnapshot(handle);
    const decisionDirectory = path.join(directory, 'decisions');
    if (path.dirname(path.resolve(trusted.filename)) !== decisionDirectory
        || !SAFE_JSON_NAME.test(path.basename(trusted.filename))) {
        fail('decision handle was not loaded from this filter decision directory');
    }
    if (stableHash(trusted.artifact) !== stableHash(artifact)
        || trusted.artifact.artifactSha256 !== artifact.artifactSha256) {
        fail('preserved production decision drifted before locked apply');
    }
    const replayedArtifact = readJson(safeDirectJson(decisionDirectory,
        path.basename(trusted.filename)), 'decision artifact');
    if (replayedArtifact.sha256 !== trusted.fileSha256
        || stableHash(normalizeDecisionArtifact(replayedArtifact.value)) !== stableHash(artifact)) {
        fail('decision artifact bytes drifted after handle load');
    }
    const patch = normalizePatch({ operationId: artifact.operationId,
        expectedStateSha256: artifact.expectedStateSha256, paperId: artifact.paperId, result: artifact.result });
    if (operationIds.has(patch.operationId)) fail('production operationId was already applied');
    if (patch.expectedStateSha256 !== state.stateSha256) fail('apply compare-and-swap state SHA mismatch');
    if (!Object.hasOwn(state.decisions, patch.paperId)) fail('patch references a non-candidate paper');
    const previous = state.decisions[patch.paperId];
    if (artifact.filterId !== state.filterId || artifact.sourceSha256 !== previous.sourceSha256) {
        fail('decision artifact source SHA does not bind candidate');
    }
    if (artifact.actor.type !== 'llm' || artifact.model !== state.input.model
        || artifact.endpointProtocol !== state.input.endpointProtocol
        || artifact.endpointIdentitySha256 !== state.input.endpointIdentitySha256) {
        fail('decision artifact model/protocol/endpoint drifted from filter input');
    }
    if (FINAL_STATUSES.has(previous.status)) fail('a final decision cannot be changed');
    if (!usageAtLeast(previous.usage, patch.result.usage)) fail('usage cannot regress');
    const recordedAt = nowIso(now);
    if (artifact.createdAt > recordedAt) fail('decision artifact creation time is after apply time');
    state.decisions[patch.paperId] = { sourceSha256: previous.sourceSha256, ...patch.result };
    const attempt = { operationId: patch.operationId, paperId: patch.paperId,
        fromStatus: previous.status, toStatus: patch.result.status, reason: patch.result.reason,
        responseSha256: patch.result.responseSha256, usage: clone(patch.result.usage), recordedAt,
        priorStateSha256: state.stateSha256, nextStateSha256: '', patchSha256: stableHash(patch), patch: clone(patch),
        decisionArtifactName: path.basename(trusted.filename), decisionArtifactSha256: artifact.artifactSha256,
        decisionArtifactFileSha256: trusted.fileSha256 };
    state.attempts.push(attempt); operationIds.add(attempt.operationId);
    digestChain.updateDecision(patch.paperId, previous.status, state.decisions[patch.paperId]);
    digestChain.appendAttempt(attempt);
    const digest = digestChain.materialize(); state.completion = digest.completion; state.stateSha256 = digest.stateSha256;
    attempt.nextStateSha256 = state.stateSha256;
    replaceRegular(safeDirectJson(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    return state;
}

async function advanceProductionLlmDecisions({ filterRoot, filterId, discoveryHandle, evidenceHandle,
    spec, owner, llm, limit = 1, retryFailed = false, maxAttempts = 3, retryBackoffMs = 60000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('runner limit is malformed');
    const catalog = catalogFromDiscoveryHandle(discoveryHandle);
    const normalizedSpec = normalizeSpec(spec); const directory = filterDirectory(filterRoot, filterId);
    const evidenceBinding = evidenceBindingFromHandle(evidenceHandle, catalog);
    const lock = acquireLock(directory, owner);
    try {
        ensureRunnerDirectories(directory);
        let state = assertBoundInputsFromCheckedState(readFilter({ filterRoot, filterId }),
            { catalog, spec: normalizedSpec, evidenceBinding });
        const firstPaperId = selectNextCandidateFromCheckedState(state,
            { retryFailed, maxAttempts, retryBackoffMs });
        let recoveredIntent = incompleteIntent(directory, state);
        if (!firstPaperId && !recoveredIntent) return { state, processed: [] };
        const config = normalizeProductionLlmConfig(typeof llm === 'function' ? llm() : llm);
        assertProductionRunnerBinding(state, normalizedSpec, config);
        const replayContext = productionReplayContext(state, discoveryHandle, evidenceHandle);
        const digestChain = new StateDigestChain(state);
        const operationIds = new Set(state.attempts.map(attempt => attempt.operationId));
        const processed = [];
        while (processed.length < limit) {
            let paperId = recoveredIntent?.paperId || selectNextCandidateFromCheckedState(state,
                { retryFailed, maxAttempts, retryBackoffMs });
            if (!paperId) break;
            let intent = recoveredIntent; recoveredIntent = null;
            let requestBody; let usageContext; const recovered = Boolean(intent);
            const expectedEnvelope = envelopeFromProductionReplay(state, paperId, replayContext);
            if (!intent) {
                ({ intent, requestBody, usageContext } = createIntent({ directory, state, paperId, owner,
                    discoveryHandle, evidenceHandle, expectedEnvelope, llm: config }));
            } else {
                if (intent.expectedStateSha256 !== state.stateSha256) {
                    fail('incomplete LLM intent state changed before recovery');
                }
                assertRequestBinding(intent.request, { state, paperId, discoveryHandle, evidenceHandle,
                    envelope: envelopeFromRecord(intent.envelope), expectedEnvelope });
            }
            let artifact = readOptional(decisionFilename(directory, intent.operationId),
                'LLM decision artifact', normalizeDecisionArtifact);
            if (artifact) {
                const existingReceipt = readOptional(responseFilename(directory, intent.operationId),
                    'LLM transport receipt', normalizeTransportReceipt);
                if (!existingReceipt) fail('preserved LLM decision is missing its transport receipt');
                const expectedDecision = decisionFromTransport({ state, intent, receipt: existingReceipt,
                    discoveryHandle, evidenceHandle, expectedEnvelope, now: artifact.createdAt });
                if (stableHash(expectedDecision) !== stableHash(artifact)) {
                    fail('preserved LLM decision does not replay from its intent and transport receipt');
                }
            } else {
                let receipt = readOptional(responseFilename(directory, intent.operationId),
                    'LLM transport receipt', normalizeTransportReceipt);
                if (!receipt && recovered) {
                    receipt = buildTransportReceipt({ intent,
                        error: Object.assign(new Error(), { code: 'INTERRUPTED_OUTCOME_UNAVAILABLE' }),
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
                    receipt = buildTransportReceipt({ intent, response, error,
                        apiType: config.apiType, usageEvents });
                    writeExclusive(responseFilename(directory, intent.operationId), `${JSON.stringify(receipt, null, 2)}\n`);
                }
                artifact = decisionFromTransport({ state, intent, receipt, discoveryHandle, evidenceHandle,
                    expectedEnvelope });
                writeDecisionArtifact({ filterRoot, filterId,
                    decisionName: `llm-${intent.operationId}.json`, artifact });
            }
            const decisionFile = decisionFilename(directory, intent.operationId);
            state = applyProductionDecisionToCheckedState({ directory, state, digestChain, operationIds,
                decisionFile, artifact });
            processed.push({ paperId, status: state.decisions[paperId].status, recovered });
        }
        ensureSelectionReceiptFromCheckedState(directory, state);
        return { state, processed };
    } finally { releaseLock(lock); }
}

async function advanceProductionLlmDecision({ filterRoot, filterId, discoveryHandle, evidenceHandle,
    spec, paperId, owner, llm } = {}) {
    const config = normalizeProductionLlmConfig(llm); const catalog = catalogFromDiscoveryHandle(discoveryHandle);
    const normalizedSpec = normalizeSpec(spec); const directory = filterDirectory(filterRoot, filterId);
    const evidenceBinding = evidenceBindingFromHandle(evidenceHandle, catalog);
    const lock = acquireLock(directory, owner);
    try {
        ensureRunnerDirectories(directory);
        let state = assertBoundInputs(readFilter({ filterRoot, filterId }),
            { catalog, spec: normalizedSpec, evidenceBinding });
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
            ({ intent, requestBody, usageContext } = createIntent({ directory, state, paperId, owner,
                discoveryHandle, evidenceHandle, llm: config }));
        } else {
            paperId = intent.paperId;
            if (intent.expectedStateSha256 !== state.stateSha256) fail('incomplete LLM intent state changed before recovery');
            assertRequestBinding(intent.request, { state, paperId, discoveryHandle, evidenceHandle,
                envelope: envelopeFromRecord(intent.envelope) });
        }
        const existingDecision = readOptional(decisionFilename(directory, intent.operationId), 'LLM decision artifact', normalizeDecisionArtifact);
        if (existingDecision) {
            const existingReceipt = readOptional(responseFilename(directory, intent.operationId),
                'LLM transport receipt', normalizeTransportReceipt);
            if (!existingReceipt) fail('preserved LLM decision is missing its transport receipt');
            const expectedDecision = decisionFromTransport({ state, intent, receipt: existingReceipt,
                discoveryHandle, evidenceHandle, now: existingDecision.createdAt });
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
        const artifact = decisionFromTransport({ state, intent, receipt, discoveryHandle, evidenceHandle });
        const filename = writeDecisionArtifact({ filterRoot, filterId, decisionName: `llm-${intent.operationId}.json`, artifact });
        state = applyDecisionLocked({ filterRoot, filterId,
            decisionHandle: loadDecisionHandleInternal(filename, { allowLlm: true }), lockHandle: lock });
        return { state, paperId, recovered };
    } finally { releaseLock(lock); }
}

function selectNextCandidate(state, { retryFailed = false, maxAttempts = 3, retryBackoffMs = 60000,
    nowMs = Date.now() } = {}) {
    const checked = assertFilterState(state);
    return selectNextCandidateFromCheckedState(checked,
        { retryFailed, maxAttempts, retryBackoffMs, nowMs });
}

module.exports = {
    VERSION, CONTRACT, SPEC_VERSION, SPEC_CONTRACT, DECISION_CONTRACT, SELECTION_RECEIPT_CONTRACT,
    SELECTION_HANDLE_CONTRACT, LLM_REQUEST_CONTRACT, LLM_INTENT_CONTRACT,
    LLM_TRANSPORT_RECEIPT_CONTRACT, LOCK_OWNER_CONTRACT, LOCK_STALE_MS,
    LLM_FILTER_POLICY, LLM_FILTER_PROMPT,
    LLM_FILTER_POLICY_SHA256, LLM_FILTER_PROMPT_SHA256, FILTER_CONFIG_BINDING, FILTER_CONFIG_SHA256,
    DAILY_DECISION_PARSER_VERSION, CORE_CONFERENCE_FALLBACK_VERSION, CORE_AUDIO_CONFERENCE_IDS,
    CORE_AUDIO_CONFERENCE_LABELS,
    MAX_DECISION_PAYLOAD_BYTES, MAX_LLM_REQUEST_BYTES,
    UUID_RE, SAFE_JSON_NAME, PROTOCOLS, stableHash,
    normalizeCatalog, normalizeSpec, normalizeLocatorBinding, normalizeEvidenceBinding,
    evidenceBindingFromHandle, normalizeUsage, inputBinding,
    catalogFromDiscoveryHandle, completionFor, normalizePatch, normalizeDecisionArtifact, buildDecisionArtifact,
    assertFilterState, assertBoundInputs, safeDirectory, filterDirectory, safeDirectJson, prepareFilter, readFilter,
    writeDecisionArtifact, loadDecisionHandle, decisionHandleSnapshot, applyDecision, applyDecisionFile,
    selectionReceiptFor, normalizeSelectionReceipt, readSelectionReceipt, loadSelectionHandle, selectionHandleSnapshot,
    parseLlmDecisionText, renderDailyFilterPrompt, conferencePromptCategories, evaluateConferenceKeywordPrefilter,
    requestEnvelope, cumulativeUsage, endpointIdentitySha256,
    buildProductionSpec, writeFilterSpec,
    normalizeLlmIntent, normalizeTransportReceipt, advanceProductionLlmDecision,
    advanceProductionLlmDecisions, selectNextCandidate
};
