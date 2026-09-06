'use strict';

// Offline bridge between a completed conference filter and the existing
// manifest-bound importer.  It does not copy source files or invoke a model.
// The only identities it can stage are those admitted by an authenticated
// filter selection handle for the same authenticated discovery snapshot.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const discoveryApi = require('./conference-discovery.js');
const filterApi = require('./conference-filter.js');
const importerApi = require('./conference-importer.js');
const ledgerApi = require('./conference-source-ledger.js');
const extractionReceiptApi = require('./conference-extraction-receipt.js');
const paperIdentity = require('./paper-identity.js');

const EXTRACTION_CONTRACT = 'conference-reviewed-extraction-v2';
const RECEIPT_CONTRACT = 'conference-staging-receipt-v2';
const VERSION = 2;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const STAGING_HANDLES = new WeakSet();
const STAGING_HANDLE_DATA = new WeakMap();

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

function fail(message) {
    const error = new Error(`Conference staging rejected: ${message}`);
    error.code = 'CONFERENCE_STAGING_INTEGRITY';
    throw error;
}
function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function safeName(value, label) {
    if (typeof value !== 'string' || !SAFE_JSON_NAME.test(value)) fail(`${label} must be a safe direct JSON filename`);
    return value;
}
function timestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
        fail(`${label} must be canonical UTC ISO time`);
    }
    return value;
}
function assertSha(value, label) {
    if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
    return value;
}

function authenticatedSelection(handle) {
    try { return filterApi.selectionHandleSnapshot(handle); }
    catch (error) { fail(`selectionHandle is not authenticated: ${error.message}`); }
}
function authenticatedDiscovery(handle) {
    try { return discoveryApi.discoveryHandleSnapshot(handle); }
    catch (error) { fail(`discoveryHandle is not authenticated: ${error.message}`); }
}

function normalizeExtractionManifest(value) {
    exact(value, ['contract', 'version', 'conference', 'review', 'members', 'membersSha256'], 'reviewed extraction manifest');
    if (value.contract !== EXTRACTION_CONTRACT || value.version !== VERSION) fail('reviewed extraction contract/version is unsupported');
    exact(value.conference, ['id', 'year'], 'reviewed extraction conference');
    if (typeof value.conference.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(value.conference.id)
        || !Number.isSafeInteger(value.conference.year) || value.conference.year < 1900 || value.conference.year > 2100) {
        fail('reviewed extraction conference is malformed');
    }
    exact(value.review, ['actor', 'reviewedAt'], 'reviewed extraction review');
    if (typeof value.review.actor !== 'string' || !ACTOR_RE.test(value.review.actor)) fail('review actor is malformed');
    const review = { actor: value.review.actor, reviewedAt: timestamp(value.review.reviewedAt, 'review.reviewedAt') };
    if (!Array.isArray(value.members) || !value.members.length) fail('reviewed extraction members must be non-empty');
    const members = value.members.map((member, index) => {
        exact(member, ['paperId', 'sourceIdentity', 'receiptName'], `reviewed extraction member[${index}]`);
        if (typeof member.paperId !== 'string' || !member.paperId || typeof member.sourceIdentity !== 'string' || !member.sourceIdentity) {
            fail(`reviewed extraction member[${index}] identity is malformed`);
        }
        return { paperId: member.paperId, sourceIdentity: member.sourceIdentity,
            receiptName: safeName(member.receiptName, `reviewed extraction member[${index}].receiptName`) };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    if (new Set(members.map(member => member.paperId)).size !== members.length
        || new Set(members.map(member => member.sourceIdentity)).size !== members.length) {
        fail('reviewed extraction contains duplicate paperId or sourceIdentity values');
    }
    if (assertSha(value.membersSha256, 'reviewed extraction membersSha256') !== stableHash(members)) {
        fail('reviewed extraction membersSha256 does not bind its members');
    }
    return { contract: EXTRACTION_CONTRACT, version: VERSION,
        conference: clone(value.conference), review, members, membersSha256: value.membersSha256 };
}

function discoveryIdentityMap(discovery) {
    return new Map(discovery.candidateManifest.members.map(member => {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        return [paperIdentity.canonicalConferencePaperId(discovery.candidateManifest.conference, member.identity),
            { sourceIdentity, identity: clone(member.identity),
            member: clone(member) }];
    }));
}

function assertExactDiscoveryExtraction({ discoveryHandle, discovery, extraction, member, admitted, extractionSnapshot }) {
    if (extractionSnapshot.paperId !== member.paperId || extractionSnapshot.sourceIdentity !== member.sourceIdentity
        || extractionSnapshot.conference.id !== extraction.conference.id
        || extractionSnapshot.conference.year !== extraction.conference.year
        || ledgerApi.identityKey(extractionSnapshot.identity) !== member.sourceIdentity) {
        fail(`extraction receipt identity differs from reviewed selection: ${member.paperId}`);
    }
    const discovered = admitted.member;
    if (discovered.match.kind !== 'exact' || discovered.match.candidates.length !== 1) {
        fail(`included discovery member requires an independent resolution receipt before staging: ${member.paperId}`);
    }
    let replay;
    try { replay = discoveryApi.replayDiscoveryMember(discoveryHandle, member.sourceIdentity); }
    catch (error) { fail(`discovery metadata record cannot be replayed for ${member.paperId}: ${error.message}`); }
    const expectedBinding = { catalogSha256: discovery.catalogSha256,
        metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
        metadataRecordSha256: replay.metadataRecordSha256 };
    if (stableHash(extractionSnapshot.metadata.discoveryBinding) !== stableHash(expectedBinding)) {
        fail(`extraction metadata does not bind the exact discovery metadata record: ${member.paperId}`);
    }
    if (extractionSnapshot.pdf.sha256 !== discovered.match.candidates[0].sha256
        || extractionSnapshot.pdf.sha256 !== replay.match.candidates[0].sha256) {
        fail(`extraction PDF does not equal the unique exact discovery candidate: ${member.paperId}`);
    }
    return replay;
}

function bindInputs({ selectionHandle, discoveryHandle, extractionManifest, extractionFileSha256,
    extractionSourceRoot, importManifestName } = {}) {
    safeName(importManifestName, 'importManifestName');
    const selection = authenticatedSelection(selectionHandle);
    const discovery = authenticatedDiscovery(discoveryHandle);
    const extraction = normalizeExtractionManifest(extractionManifest);
    assertSha(extractionFileSha256, 'extractionFileSha256');
    const catalog = filterApi.catalogFromDiscoveryHandle(discoveryHandle);
    if (selection.contract !== filterApi.SELECTION_HANDLE_CONTRACT || selection.version !== filterApi.VERSION
        || selection.conferenceId !== discovery.candidateManifest.conference.id
        || selection.catalogSha256 !== discovery.catalogSha256
        || catalog.catalogSha256 !== discovery.catalogSha256) {
        fail('selection does not bind the supplied discovery snapshot');
    }
    if (extraction.conference.id !== selection.conferenceId
        || extraction.conference.year !== discovery.candidateManifest.conference.year) {
        fail('reviewed extraction conference does not match selection/discovery');
    }
    if (!selection.included.length) fail('a selection with no included papers cannot produce an import manifest');
    const identities = discoveryIdentityMap(discovery);
    const selected = new Map();
    for (const item of selection.included) {
        const discovered = identities.get(item.paperId);
        if (!discovered || discovered.sourceIdentity !== item.sourceIdentity
            || item.paperId !== paperIdentity.canonicalConferencePaperId(
                discovery.candidateManifest.conference, discovered.identity)) {
            fail(`included paperId is not the canonical discovery identity: ${item.paperId}`);
        }
        const catalogMember = catalog.members.find(member => member.paperId === item.paperId);
        if (!catalogMember || catalogMember.sourceSha256 !== item.sourceSha256) {
            fail(`included source SHA does not match discovery catalog: ${item.paperId}`);
        }
        if (discovered.member.match.kind !== 'exact' || discovered.member.match.candidates.length !== 1) {
            fail(`included discovery member is not a unique exact PDF match: ${item.paperId}`);
        }
        selected.set(item.paperId, { ...clone(item), identity: discovered.identity, member: discovered.member });
    }
    if (extraction.members.length !== selected.size) fail('reviewed extraction must exactly cover the included selection');
    const importMembers = [];
    const memberBindings = [];
    for (const member of extraction.members) {
        const admitted = selected.get(member.paperId);
        if (!admitted) fail(`reviewed extraction contains an excluded or extra paper: ${member.paperId}`);
        if (member.sourceIdentity !== admitted.sourceIdentity
            || member.paperId !== paperIdentity.canonicalConferencePaperId(
                discovery.candidateManifest.conference, admitted.identity)) {
            fail(`reviewed extraction identity is not canonical or differs from selection: ${member.paperId}`);
        }
        let extractionSnapshot;
        try {
            const extractionHandle = extractionReceiptApi.loadExtractionHandle(extractionSourceRoot, member.receiptName);
            extractionSnapshot = extractionReceiptApi.extractionHandleSnapshot(extractionHandle);
        } catch (error) { fail(`extraction receipt cannot be authenticated for ${member.paperId}: ${error.message}`); }
        assertExactDiscoveryExtraction({ discoveryHandle, discovery, extraction, member, admitted, extractionSnapshot });
        const candidate = { identity: admitted.identity, metadata: extractionSnapshot.metadata,
            pdf: extractionSnapshot.pdf, text: extractionSnapshot.text, artifacts: extractionSnapshot.artifacts };
        importMembers.push(candidate);
        memberBindings.push({ paperId: member.paperId, sourceIdentity: member.sourceIdentity,
            sourceSha256: admitted.sourceSha256, decisionArtifactSha256: admitted.decisionArtifactSha256,
            extractionReceiptName: extractionSnapshot.receipt.file,
            extractionReceiptFileSha256: extractionSnapshot.receipt.fileSha256,
            extractionReceiptSha256: extractionSnapshot.receipt.receiptSha256,
            extractionVerificationSha256: extractionSnapshot.verification.verificationSha256,
            metadataSha256: candidate.metadata.sha256, pdfSha256: candidate.pdf.sha256,
            textSha256: candidate.text.sha256, artifactsSha256: candidate.artifacts.sha256 });
        selected.delete(member.paperId);
    }
    if (selected.size) fail(`reviewed extraction is missing included papers: ${[...selected.keys()].join(', ')}`);
    const importManifestDraft = { contract: importerApi.CONTRACT, version: importerApi.VERSION,
        conference: clone(extraction.conference), members: importMembers,
        memberSetSha256: ledgerApi.memberSetSha256(importMembers.map(member => ({ identity: member.identity }))) };
    let importManifest;
    try { importManifest = importerApi.validateManifest(importManifestDraft); }
    catch (error) { fail(`generated import manifest is invalid: ${error.message}`); }
    const importBytes = canonicalBytes(importManifest);
    const receiptBody = {
        contract: RECEIPT_CONTRACT, version: VERSION,
        selection: { contract: selection.contract, filterId: selection.filterId, conferenceId: selection.conferenceId,
            catalogSha256: selection.catalogSha256, inputSha256: selection.inputSha256,
            stateSha256: selection.stateSha256, filterPolicySha256: selection.filterPolicySha256,
            selectedMemberSetSha256: selection.selectedMemberSetSha256,
            selectionReceiptSha256: selection.selectionReceiptSha256 },
        discovery: { contract: discovery.candidateManifest.contract, catalogSha256: discovery.catalogSha256,
            reportSha256: discovery.reportSha256,
            metadataSnapshotSha256: discovery.candidateManifest.metadataSnapshot.sha256,
            pdfCatalogSha256: discovery.candidateManifest.pdfCatalogSha256,
            discoveryMemberSetSha256: discovery.candidateManifest.memberSetSha256 },
        extraction: { contract: extraction.contract, extractionFileSha256,
            extractionManifestSha256: stableHash(extraction), membersSha256: extraction.membersSha256,
            review: clone(extraction.review) },
        importManifest: { name: importManifestName, contract: importManifest.contract,
            sha256: sha256(importBytes), memberSetSha256: importManifest.memberSetSha256 },
        members: memberBindings
    };
    const receipt = { ...receiptBody, receiptSha256: stableHash(receiptBody) };
    return { selection, discovery, extraction, importManifest, receipt,
        importBytes, receiptBytes: canonicalBytes(receipt) };
}

function normalizeReceipt(value) {
    exact(value, ['contract', 'version', 'selection', 'discovery', 'extraction', 'importManifest', 'members',
        'receiptSha256'], 'staging receipt');
    if (value.contract !== RECEIPT_CONTRACT || value.version !== VERSION) fail('staging receipt contract/version is unsupported');
    exact(value.selection, ['contract', 'filterId', 'conferenceId', 'catalogSha256', 'inputSha256',
        'stateSha256', 'filterPolicySha256', 'selectedMemberSetSha256', 'selectionReceiptSha256'],
    'staging receipt selection');
    exact(value.discovery, ['contract', 'catalogSha256', 'reportSha256', 'metadataSnapshotSha256',
        'pdfCatalogSha256', 'discoveryMemberSetSha256'], 'staging receipt discovery');
    exact(value.extraction, ['contract', 'extractionFileSha256', 'extractionManifestSha256', 'membersSha256', 'review'],
        'staging receipt extraction');
    exact(value.extraction.review, ['actor', 'reviewedAt'], 'staging receipt extraction review');
    exact(value.importManifest, ['name', 'contract', 'sha256', 'memberSetSha256'], 'staging receipt import manifest');
    safeName(value.importManifest.name, 'staging receipt import manifest name');
    for (const [section, fields] of [[value.selection, ['catalogSha256', 'inputSha256', 'stateSha256',
        'filterPolicySha256', 'selectedMemberSetSha256', 'selectionReceiptSha256']],
        [value.discovery, ['catalogSha256', 'reportSha256', 'metadataSnapshotSha256', 'pdfCatalogSha256', 'discoveryMemberSetSha256']],
        [value.extraction, ['extractionFileSha256', 'extractionManifestSha256', 'membersSha256']],
        [value.importManifest, ['sha256', 'memberSetSha256']]]) {
        for (const field of fields) assertSha(section[field], `staging receipt ${field}`);
    }
    if (value.selection.contract !== filterApi.SELECTION_HANDLE_CONTRACT
        || value.discovery.contract !== discoveryApi.CONTRACT
        || value.extraction.contract !== EXTRACTION_CONTRACT
        || value.importManifest.contract !== importerApi.CONTRACT) fail('staging receipt nested contracts are unsupported');
    if (!filterApi.UUID_RE.test(String(value.selection.filterId || ''))
        || typeof value.selection.conferenceId !== 'string' || !value.selection.conferenceId) fail('staging receipt selection identity is malformed');
    if (typeof value.extraction.review.actor !== 'string' || !ACTOR_RE.test(value.extraction.review.actor)) fail('staging receipt reviewer is malformed');
    timestamp(value.extraction.review.reviewedAt, 'staging receipt reviewedAt');
    if (!Array.isArray(value.members) || !value.members.length) fail('staging receipt members must be non-empty');
    const members = value.members.map((member, index) => {
        exact(member, ['paperId', 'sourceIdentity', 'sourceSha256', 'decisionArtifactSha256',
            'extractionReceiptName', 'extractionReceiptFileSha256', 'extractionReceiptSha256',
            'extractionVerificationSha256', 'metadataSha256',
            'pdfSha256', 'textSha256', 'artifactsSha256'], `staging receipt member[${index}]`);
        if (typeof member.paperId !== 'string' || !member.paperId || typeof member.sourceIdentity !== 'string' || !member.sourceIdentity) {
            fail(`staging receipt member[${index}] identity is malformed`);
        }
        safeName(member.extractionReceiptName, `staging receipt member[${index}].extractionReceiptName`);
        for (const field of ['sourceSha256', 'decisionArtifactSha256', 'extractionReceiptFileSha256',
            'extractionReceiptSha256', 'extractionVerificationSha256',
            'metadataSha256', 'pdfSha256', 'textSha256', 'artifactsSha256']) {
            assertSha(member[field], `staging receipt member[${index}].${field}`);
        }
        assertSha(member.sourceSha256, `staging receipt member[${index}].sourceSha256`);
        assertSha(member.decisionArtifactSha256, `staging receipt member[${index}].decisionArtifactSha256`);
        return clone(member);
    });
    const body = { ...clone(value) }; delete body.receiptSha256;
    if (assertSha(value.receiptSha256, 'staging receipt receiptSha256') !== stableHash(body)) {
        fail('staging receipt SHA does not bind its content');
    }
    return { ...body, members, receiptSha256: value.receiptSha256 };
}

function replayStagingSources({ importManifest, receipt, selection, discovery, discoveryHandle,
    extractionSourceRoot } = {}) {
    const identities = discoveryIdentityMap(discovery);
    const selected = new Map(selection.included.map(item => {
        const found = identities.get(item.paperId);
        if (!found || found.sourceIdentity !== item.sourceIdentity) {
            fail(`selection member is absent from discovery during extraction replay: ${item.paperId}`);
        }
        return [item.sourceIdentity, { ...clone(item), ...found }];
    }));
    const bindings = new Map(receipt.members.map(item => [item.sourceIdentity, item]));
    const extraction = { conference: { id: selection.conferenceId,
        year: discovery.candidateManifest.conference.year } };
    for (const member of importManifest.members) {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        const admitted = selected.get(sourceIdentity); const bound = bindings.get(sourceIdentity);
        if (!admitted || !bound) fail(`staging source replay is missing ${sourceIdentity}`);
        let extractionSnapshot;
        try {
            extractionSnapshot = extractionReceiptApi.extractionHandleSnapshot(
                extractionReceiptApi.loadExtractionHandle(extractionSourceRoot, bound.extractionReceiptName)
            );
        } catch (error) { fail(`extraction replay failed for ${bound.paperId}: ${error.message}`); }
        assertExactDiscoveryExtraction({ discoveryHandle, discovery, extraction,
            member: { paperId: bound.paperId, sourceIdentity }, admitted, extractionSnapshot });
        const expected = {
            extractionReceiptFileSha256: extractionSnapshot.receipt.fileSha256,
            extractionReceiptSha256: extractionSnapshot.receipt.receiptSha256,
            extractionVerificationSha256: extractionSnapshot.verification.verificationSha256,
            metadataSha256: extractionSnapshot.metadata.sha256, pdfSha256: extractionSnapshot.pdf.sha256,
            textSha256: extractionSnapshot.text.sha256, artifactsSha256: extractionSnapshot.artifacts.sha256
        };
        for (const [field, value] of Object.entries(expected)) {
            if (bound[field] !== value) fail(`staging receipt ${field} drifted from extraction replay for ${bound.paperId}`);
        }
        if (stableHash(member.metadata) !== stableHash(extractionSnapshot.metadata)
            || stableHash(member.pdf) !== stableHash(extractionSnapshot.pdf)
            || stableHash(member.text) !== stableHash(extractionSnapshot.text)
            || stableHash(member.artifacts) !== stableHash(extractionSnapshot.artifacts)) {
            fail(`staged import member differs from extraction replay for ${bound.paperId}`);
        }
    }
    return true;
}

function loadStagingHandle(importManifestFile, receiptFile, selectionHandle, discoveryHandle, extractionSourceRoot) {
    let importLoaded; let receiptLoaded;
    try {
        importLoaded = ledgerApi.readRegularJson(importManifestFile);
        receiptLoaded = ledgerApi.readRegularJson(receiptFile);
    } catch (error) { fail(`staging files cannot be read safely: ${error.message}`); }
    let importManifest;
    try { importManifest = importerApi.validateManifest(importLoaded.value); }
    catch (error) { fail(`staged import manifest is invalid: ${error.message}`); }
    const receipt = normalizeReceipt(receiptLoaded.value);
    const selection = authenticatedSelection(selectionHandle);
    const discovery = authenticatedDiscovery(discoveryHandle);
    const catalog = filterApi.catalogFromDiscoveryHandle(discoveryHandle);
    const expectedSelection = { contract: selection.contract, filterId: selection.filterId,
        conferenceId: selection.conferenceId, catalogSha256: selection.catalogSha256,
        inputSha256: selection.inputSha256, stateSha256: selection.stateSha256,
        filterPolicySha256: selection.filterPolicySha256,
        selectedMemberSetSha256: selection.selectedMemberSetSha256,
        selectionReceiptSha256: selection.selectionReceiptSha256 };
    if (stableHash(receipt.selection) !== stableHash(expectedSelection)) fail('staging receipt does not bind the authenticated selection');
    const expectedDiscovery = { contract: discovery.candidateManifest.contract,
        catalogSha256: discovery.catalogSha256, reportSha256: discovery.reportSha256,
        metadataSnapshotSha256: discovery.candidateManifest.metadataSnapshot.sha256,
        pdfCatalogSha256: discovery.candidateManifest.pdfCatalogSha256,
        discoveryMemberSetSha256: discovery.candidateManifest.memberSetSha256 };
    if (stableHash(receipt.discovery) !== stableHash(expectedDiscovery)
        || selection.catalogSha256 !== catalog.catalogSha256) fail('staging receipt does not bind the authenticated discovery');
    if (receipt.importManifest.name !== path.basename(importManifestFile)
        || receipt.importManifest.sha256 !== importLoaded.sha256
        || receipt.importManifest.memberSetSha256 !== importManifest.memberSetSha256) {
        fail('staging receipt does not bind the exact import manifest file');
    }
    const identities = discoveryIdentityMap(discovery);
    const selected = new Map(selection.included.map(item => [item.sourceIdentity, item]));
    if (selected.size !== importManifest.members.length || receipt.members.length !== importManifest.members.length) {
        fail('staged import manifest must exactly cover the included selection');
    }
    const receiptMembers = new Map(receipt.members.map(member => [member.sourceIdentity, member]));
    if (receiptMembers.size !== receipt.members.length) fail('staging receipt contains duplicate source identities');
    for (const member of importManifest.members) {
        const sourceIdentity = ledgerApi.identityKey(member.identity);
        const admitted = selected.get(sourceIdentity); const bound = receiptMembers.get(sourceIdentity);
        if (!admitted || !bound) fail(`staged import manifest contains an excluded or unbound identity: ${sourceIdentity}`);
        const discovered = identities.get(paperIdentity.canonicalConferencePaperId(
            discovery.candidateManifest.conference, member.identity));
        if (!discovered || discovered.sourceIdentity !== sourceIdentity) {
            fail(`staged import identity is absent from discovery: ${sourceIdentity}`);
        }
        const paperId = paperIdentity.canonicalConferencePaperId(
            discovery.candidateManifest.conference, member.identity);
        const expected = { paperId, sourceIdentity, sourceSha256: admitted.sourceSha256,
            decisionArtifactSha256: admitted.decisionArtifactSha256,
            extractionReceiptName: bound.extractionReceiptName,
            extractionReceiptFileSha256: bound.extractionReceiptFileSha256,
            extractionReceiptSha256: bound.extractionReceiptSha256,
            extractionVerificationSha256: bound.extractionVerificationSha256,
            metadataSha256: member.metadata?.sha256 || null, pdfSha256: member.pdf?.sha256 || null,
            textSha256: member.text?.sha256 || null, artifactsSha256: member.artifacts?.sha256 || null };
        if (admitted.paperId !== paperId || stableHash(bound) !== stableHash(expected)) {
            fail(`staging member binding drifted from selection/import manifest: ${sourceIdentity}`);
        }
        selected.delete(sourceIdentity); receiptMembers.delete(sourceIdentity);
    }
    if (selected.size || receiptMembers.size) fail('staging bundle contains missing or extra selection members');
    replayStagingSources({ importManifest, receipt, selection, discovery, discoveryHandle, extractionSourceRoot });
    const handle = Object.freeze(Object.create(null));
    STAGING_HANDLES.add(handle);
    STAGING_HANDLE_DATA.set(handle, Object.freeze({ importManifest: clone(importManifest), receipt: clone(receipt),
        importManifestFile: fs.realpathSync(importManifestFile), receiptFile: fs.realpathSync(receiptFile),
        importManifestFileSha256: importLoaded.sha256, receiptFileSha256: receiptLoaded.sha256,
        extractionSourceRoot: path.resolve(extractionSourceRoot), selectionHandle, discoveryHandle }));
    return handle;
}

function stagingHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !STAGING_HANDLES.has(handle)) fail('requires an authenticated staging handle');
    const data = STAGING_HANDLE_DATA.get(handle);
    const selection = authenticatedSelection(data.selectionHandle);
    const discovery = authenticatedDiscovery(data.discoveryHandle);
    replayStagingSources({ importManifest: data.importManifest, receipt: data.receipt,
        selection, discovery, discoveryHandle: data.discoveryHandle, extractionSourceRoot: data.extractionSourceRoot });
    return { importManifest: clone(data.importManifest), receipt: clone(data.receipt),
        importManifestFile: data.importManifestFile, receiptFile: data.receiptFile,
        importManifestFileSha256: data.importManifestFileSha256, receiptFileSha256: data.receiptFileSha256 };
}

function safeDirectory(root, label, { create = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail(`${label} must be an absolute configured directory`);
    const absolute = path.resolve(root);
    if (create) {
        const parent = path.dirname(absolute);
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} parent is unsafe`);
        try { fs.mkdirSync(absolute, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}
function safeDirectJson(root, name, { output = false } = {}) {
    const directory = safeDirectory(root, 'staging directory', { create: output });
    safeName(name, 'staging filename');
    const filename = path.resolve(directory, name);
    if (path.dirname(filename) !== directory) fail('staging filename escapes its configured directory');
    if (!output) {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('staging input is unsafe');
    }
    return filename;
}

function writeStagingBundle({ stagingRoot, importManifestName, receiptName, staged } = {}) {
    const importFile = safeDirectJson(stagingRoot, importManifestName, { output: true });
    const receiptFile = safeDirectJson(stagingRoot, receiptName, { output: true });
    if (importFile === receiptFile) fail('import manifest and staging receipt filenames must differ');
    const specs = [[importFile, staged.importBytes], [receiptFile, staged.receiptBytes]];
    const opened = [];
    try {
        for (const [filename] of specs) {
            const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            opened.push({ filename, fd });
        }
        for (let index = 0; index < specs.length; index += 1) {
            fs.writeFileSync(opened[index].fd, specs[index][1]); fs.fsyncSync(opened[index].fd);
        }
    } catch (error) {
        for (const item of opened) {
            try { fs.closeSync(item.fd); } catch {}
            try { fs.unlinkSync(item.filename); } catch {}
        }
        fail(`could not write immutable staging bundle: ${error.message}`);
    }
    for (const item of opened) fs.closeSync(item.fd);
    return { importFile, receiptFile };
}

module.exports = {
    EXTRACTION_CONTRACT, RECEIPT_CONTRACT, VERSION, SAFE_JSON_NAME,
    stableHash, canonicalBytes, normalizeExtractionManifest, bindInputs, normalizeReceipt,
    loadStagingHandle, stagingHandleSnapshot, replayStagingSources,
    safeDirectory, safeDirectJson, writeStagingBundle
};
