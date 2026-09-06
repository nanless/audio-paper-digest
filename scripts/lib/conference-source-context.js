'use strict';

// Build an immutable, source-only analysis context from an authenticated plan
// handle and the local artifacts named by its ledger.  A separately named
// low-level builder exists only for isolated ledger/run tests.  This module has
// no arXiv, network, generated-blog, or LLM fallback.

const crypto = require('node:crypto');
const fs = require('node:fs');
const ledgerApi = require('./conference-source-ledger.js');
const pdfApi = require('./conference-pdf-source.js');
const runApi = require('./conference-run.js');
const executionApi = require('./conference-execution.js');
const planApi = require('./conference-plan.js');

const CONTRACT = 'conference-source-context-v2';
const VERSION = 2;
const ARTIFACT_CONTRACT = 'conference-structured-artifacts-v2';
const ARTIFACT_VERSION = 2;
const REPLAYABLE_PROFILE = 'replayable-pdf-layout-v1';
const WEAK_PROFILE = 'weak-pdf-layout-v1';
const UNAVAILABLE_PROFILE = 'unavailable-pdf-layout-v1';
const OFFSET_UNIT = 'utf8-byte';
const SOURCE_SNAPSHOT_BINDING_CONTRACT = 'conference-source-snapshot-binding-v2';
const OBSERVATION_BINDING_CONTRACT = 'conference-source-observation-binding-v2';
const PLAN_AUTHORITY_BINDING_CONTRACT = 'conference-source-plan-authority-binding-v2';
// Reserved for a future adapter that can replay a PDF extractor receipt.  A
// ledger provenance string or a self-declared structured-artifact profile is
// deliberately not such a receipt.
const PDF_EXTRACTION_RECEIPT_CONTRACT = 'conference-pdf-extraction-receipt-v2';
const NO_REPLAYABLE_RECEIPT = 'replayable-pdf-extraction-receipt-unavailable';
const MIN_TEXT_CHARS = 1000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;

class ConferenceSourceContextError extends Error {
    constructor(message, { code = 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY', reasonCode = 'integrity_failure' } = {}) {
        super(message);
        this.name = 'ConferenceSourceContextError';
        this.code = code;
        this.reasonCode = reasonCode;
        this.retryable = false;
    }
}

function integrity(message, reasonCode = 'integrity_failure') {
    throw new ConferenceSourceContextError(`Conference source context rejected: ${message}`, { reasonCode });
}

function blocked(message, reasonCode) {
    throw new ConferenceSourceContextError(`Conference source context blocked: ${message}`, {
        code: 'CONFERENCE_SOURCE_CONTEXT_BLOCKED', reasonCode
    });
}

function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, fields, label) {
    if (!plain(value)) integrity(`${label} must be a plain object`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        integrity(`${label} has unknown or missing fields`);
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    integrity('source snapshot contains a non-JSON value');
}

function stableHash(value) { return sha256(JSON.stringify(canonical(value))); }

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key;
            try { key = JSON.parse(token); }
            catch { integrity(`${label} contains invalid JSON string syntax`, 'invalid_json'); }
            if (top.keys.has(key)) integrity(`${label} contains duplicate JSON key: ${key}`, 'duplicate_json_key');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readBoundBytes(sourceRoot, relativePath, expectedSha256, limit, label) {
    let filename;
    try { filename = ledgerApi.safeArtifactPath(sourceRoot, relativePath); }
    catch (error) { integrity(`${label} path is unsafe: ${error.message}`, 'unsafe_source_path'); }
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > limit) {
            integrity(`${label} must be a regular single-link file within its size limit`, 'unsafe_source_file');
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) integrity(`${label} changed while being read`, 'source_changed_during_read');
        if (!SHA_RE.test(String(expectedSha256 || '')) || sha256(bytes) !== expectedSha256) {
            integrity(`${label} SHA-256 differs from the authenticated ledger`, 'source_sha_drift');
        }
        return bytes;
    } catch (error) {
        if (error instanceof ConferenceSourceContextError) throw error;
        integrity(`${label} cannot be read safely: ${error.message}`, 'source_read_failed');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function strictUtf8(bytes, label) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { integrity(`${label} is not strict UTF-8`, 'invalid_utf8'); }
}

function strictJson(bytes, label) {
    const source = strictUtf8(bytes, label);
    rejectDuplicateJsonKeys(source, label);
    try { return JSON.parse(source); }
    catch { integrity(`${label} is not valid JSON`, 'invalid_json'); }
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) integrity(`${label} must be a positive safe integer`, 'invalid_artifact_schema');
}

function string(value, label, { empty = false } = {}) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || /\u0000/u.test(value)) {
        integrity(`${label} must be ${empty ? 'a' : 'a non-empty'} string`, 'invalid_artifact_schema');
    }
}

function validatePage(item, index, previousEnd, textBytes) {
    exact(item, ['page', 'textStart', 'textEnd'], `structuredArtifacts.pages[${index}]`);
    positiveInteger(item.page, `structuredArtifacts.pages[${index}].page`);
    if (item.page !== index + 1 || !Number.isSafeInteger(item.textStart) || !Number.isSafeInteger(item.textEnd)
        || item.textStart !== previousEnd || item.textEnd <= item.textStart || item.textEnd > textBytes.length) {
        integrity('structuredArtifacts pages must be consecutive and exactly partition the source text', 'invalid_artifact_schema');
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(textBytes.subarray(item.textStart, item.textEnd));
    } catch {
        integrity('structuredArtifacts page offsets must fall on UTF-8 code-point boundaries', 'invalid_artifact_schema');
    }
    return item.textEnd;
}

function validateLocatedRecord(item, index, kind) {
    const fields = kind === 'table'
        ? ['ordinal', 'page', 'caption', 'cells', 'sourceRef', 'recoveryStatus']
        : kind === 'formula'
            ? ['ordinal', 'page', 'tex', 'sourceRef', 'recoveryStatus']
            : ['ordinal', 'page', 'caption', 'sourceRef', 'recoveryStatus'];
    exact(item, fields, `structuredArtifacts.${kind}s[${index}]`);
    positiveInteger(item.ordinal, `structuredArtifacts.${kind}s[${index}].ordinal`);
    positiveInteger(item.page, `structuredArtifacts.${kind}s[${index}].page`);
    if (item.ordinal !== index + 1 || item.recoveryStatus !== 'complete') {
        integrity(`structuredArtifacts ${kind} records must be ordered and completely recovered`, 'invalid_artifact_schema');
    }
    string(item.sourceRef, `structuredArtifacts.${kind}s[${index}].sourceRef`);
    if (kind === 'formula') string(item.tex, `structuredArtifacts.formulas[${index}].tex`);
    else string(item.caption, `structuredArtifacts.${kind}s[${index}].caption`, { empty: true });
    if (kind === 'table') {
        if (!Array.isArray(item.cells) || !item.cells.length || item.cells.some(row => (
            !Array.isArray(row) || !row.length || row.some(cell => typeof cell !== 'string')
        ))) integrity('structuredArtifacts table cells must be a non-empty string matrix', 'invalid_artifact_schema');
        const width = item.cells[0].length;
        if (item.cells.some(row => row.length !== width)) {
            integrity('structuredArtifacts table cells must form a rectangular matrix', 'invalid_artifact_schema');
        }
    }
}

function validateStructuredArtifacts(value, sourceText) {
    exact(value, ['contract', 'version', 'profile', 'offsetUnit', 'flattenedTextSha256', 'pages', 'tables', 'formulas', 'figures', 'payloadSha256'], 'structuredArtifacts');
    if (value.contract !== ARTIFACT_CONTRACT || value.version !== ARTIFACT_VERSION
        || ![REPLAYABLE_PROFILE, WEAK_PROFILE, UNAVAILABLE_PROFILE].includes(value.profile)) {
        integrity('structuredArtifacts contract/version/profile is unsupported', 'unsupported_artifact_profile');
    }
    if (value.offsetUnit !== OFFSET_UNIT) {
        integrity(`structuredArtifacts.offsetUnit must be ${OFFSET_UNIT}`, 'invalid_artifact_schema');
    }
    if (!SHA_RE.test(String(value.flattenedTextSha256 || '')) || value.flattenedTextSha256 !== sha256(sourceText)) {
        integrity('structuredArtifacts.flattenedTextSha256 does not bind source text', 'flattened_text_sha_drift');
    }
    const { payloadSha256, ...body } = value;
    if (!SHA_RE.test(String(payloadSha256 || '')) || payloadSha256 !== sha256(JSON.stringify(body))) {
        integrity('structuredArtifacts.payloadSha256 does not bind its payload', 'artifact_payload_sha_drift');
    }
    for (const field of ['pages', 'tables', 'formulas', 'figures']) {
        if (!Array.isArray(value[field])) integrity(`structuredArtifacts.${field} must be an array`, 'invalid_artifact_schema');
    }
    if (value.profile === UNAVAILABLE_PROFILE) {
        if ([value.pages, value.tables, value.formulas, value.figures].some(items => items.length)) {
            integrity('unavailable structured-artifact profile cannot carry recovered records', 'invalid_artifact_schema');
        }
        return value;
    }
    if (value.profile === REPLAYABLE_PROFILE && !value.pages.length) {
        integrity('replayable structured artifacts contain no page map', 'invalid_artifact_schema');
    }
    if (!value.pages.length) {
        if ([value.tables, value.formulas, value.figures].some(items => items.length)) {
            integrity('structuredArtifacts records require a page map', 'invalid_artifact_schema');
        }
        return value;
    }
    const sourceBytes = Buffer.from(sourceText, 'utf8');
    let end = 0;
    value.pages.forEach((page, index) => { end = validatePage(page, index, end, sourceBytes); });
    if (end !== sourceBytes.length) {
        integrity('structuredArtifacts page map does not cover the complete source text', 'invalid_artifact_schema');
    }
    for (const kind of ['table', 'formula', 'figure']) {
        const values = value[`${kind}s`];
        values.forEach((item, index) => validateLocatedRecord(item, index, kind));
        if (new Set(values.map(item => item.sourceRef)).size !== values.length) {
            integrity(`structuredArtifacts ${kind} sourceRef values must be unique`, 'invalid_artifact_schema');
        }
        if (values.some(item => item.page > value.pages.length)) {
            integrity(`structuredArtifacts ${kind} page is outside the page map`, 'invalid_artifact_schema');
        }
    }
    return value;
}

function unavailableCapability(reason) {
    return { available: false, reliability: 'unavailable', reason };
}

function structuredCapabilityReason(profile) {
    if (profile === WEAK_PROFILE) return 'structured-artifacts-profile-weak';
    if (profile === UNAVAILABLE_PROFILE) return 'structured-artifacts-profile-unavailable';
    return NO_REPLAYABLE_RECEIPT;
}

function resolveRun(input) {
    if ((input.run === undefined) === (input.execution === undefined)) {
        integrity('exactly one of run or execution must be supplied', 'ambiguous_run_source');
    }
    if (input.run !== undefined) {
        let run;
        try { run = runApi.assertConferenceRunFromVerifiedLedger(input.run, input.ledgerHandle); }
        catch (error) { integrity(`run is not strongly bound to the ledger: ${error.message}`, 'run_binding_invalid'); }
        return { run, binding: { kind: 'run', runIdentitySha256: run.identitySha256, runStateSha256: run.stateSha256 } };
    }
    let execution;
    try { execution = executionApi.assertConferenceExecution(input.execution); }
    catch (error) { integrity(`execution snapshot is invalid: ${error.message}`, 'execution_binding_invalid'); }
    const run = { ...execution.runTemplate, paperStates: execution.paperStates };
    run.stateSha256 = runApi.stableHash({ identitySha256: run.identitySha256, paperStates: run.paperStates });
    let verified;
    try { verified = runApi.assertConferenceRunFromVerifiedLedger(run, input.ledgerHandle); }
    catch (error) { integrity(`execution run is not strongly bound to the ledger: ${error.message}`, 'execution_binding_invalid'); }
    if (execution.source.runIdentitySha256 !== verified.identitySha256
        || execution.source.ledgerSha256 !== verified.ledgerSha256) {
        integrity('execution source does not bind the reconstructed run', 'execution_binding_invalid');
    }
    return { run: verified, binding: { kind: 'execution', executionId: execution.executionId,
        executionStateSha256: execution.stateSha256, runIdentitySha256: verified.identitySha256,
        runStateSha256: verified.stateSha256 } };
}

function buildConferenceSourceContextFromLedger(input = {}, productionBinding = null) {
    if (productionBinding === null) integrity('authenticated plan authority is required', 'plan_handle_invalid');
    if (!plain(input)) integrity('conference source context input must be a plain object');
    const hasRun = Object.prototype.hasOwnProperty.call(input, 'run');
    const hasExecution = Object.prototype.hasOwnProperty.call(input, 'execution');
    if (hasRun === hasExecution) integrity('exactly one of run or execution must be supplied', 'ambiguous_run_source');
    exact(input, ['ledgerHandle', hasExecution ? 'execution' : 'run', 'paperId', 'sourceRoot'], 'conference source context input');
    if (typeof input.paperId !== 'string' || !input.paperId) integrity('paperId must be non-empty', 'paper_not_found');
    const resolved = resolveRun(input);
    const matches = resolved.run.members.filter(member => member.paperId === input.paperId);
    if (matches.length !== 1) integrity('paperId must identify exactly one run member', 'paper_not_found');
    const runMember = matches[0];
    let loaded;
    try { loaded = ledgerApi.ledgerHandleSnapshot(input.ledgerHandle); }
    catch (error) { integrity(`ledgerHandle is not authenticated: ${error.message}`, 'ledger_handle_invalid'); }
    const ledgerMatches = loaded.ledger.members.filter(member => ledgerApi.identityKey(member.identity) === runMember.sourceIdentity);
    if (ledgerMatches.length !== 1 || ledgerMatches[0].status.state !== 'verified') {
        integrity('run source identity does not identify one verified ledger member', 'source_identity_invalid');
    }
    const member = ledgerMatches[0];
    let pdfSource;
    try {
        pdfSource = pdfApi.buildConferencePdfSourceFromLedger({ sourceRoot: input.sourceRoot,
            ledgerHandle: input.ledgerHandle, identityKey: runMember.sourceIdentity });
    } catch (error) {
        integrity(`ledger-aware PDF replay failed: ${error.message}`, 'pdf_source_invalid');
    }
    const metadataBytes = readBoundBytes(input.sourceRoot, member.metadataFile, member.metadataSha256, MAX_METADATA_BYTES, 'metadata artifact');
    const textBytes = readBoundBytes(input.sourceRoot, member.textFile, member.textSha256, MAX_TEXT_BYTES, 'text artifact');
    const artifactBytes = readBoundBytes(input.sourceRoot, member.artifactsFile, member.artifactsSha256, MAX_ARTIFACT_BYTES, 'structured-artifacts file');
    const metadata = strictJson(metadataBytes, 'metadata artifact');
    if (!plain(metadata) || !Object.keys(metadata).length) integrity('metadata artifact must contain a non-empty JSON object', 'invalid_metadata');
    const text = strictUtf8(textBytes, 'text artifact');
    let nonWhitespaceCharacters = 0;
    for (const character of text) if (!/\s/u.test(character)) nonWhitespaceCharacters += 1;
    if (nonWhitespaceCharacters < MIN_TEXT_CHARS) {
        blocked(`source text is shorter than ${MIN_TEXT_CHARS} non-whitespace characters`, 'text_too_short');
    }
    const structuredArtifacts = validateStructuredArtifacts(strictJson(artifactBytes, 'structured-artifacts file'), text);
    // No current source artifact carries an independently replayable extractor
    // receipt.  Consequently even a syntactically valid `y=x` record from a
    // tiny PDF is untrusted for publication.  Text remains usable for analysis.
    const structuredReason = structuredCapabilityReason(structuredArtifacts.profile);
    const formulaAvailability = unavailableCapability(structuredReason);
    const tableAvailability = unavailableCapability(structuredReason);
    const figureAvailability = unavailableCapability(structuredReason);
    const sourceBinding = {
        ledgerSha256: loaded.ledgerSha256,
        metadataSha256: member.metadataSha256, pdfSha256: member.pdfSha256,
        textSha256: member.textSha256, artifactsFileSha256: member.artifactsSha256,
        artifactsPayloadSha256: structuredArtifacts.payloadSha256,
        pdfDescriptorSha256: pdfSource.descriptor.descriptorSha256,
        textExtractor: { ...member.provenance.text }, artifactsExtractor: { ...member.provenance.artifacts }
    };
    const conference = { id: loaded.ledger.conference.id, year: loaded.ledger.conference.year };
    const identity = { ...member.identity, key: runMember.sourceIdentity };
    const sourceSnapshotBinding = {
        contract: SOURCE_SNAPSHOT_BINDING_CONTRACT, version: VERSION, paperId: input.paperId,
        conference, identity, runIdentitySha256: resolved.binding.runIdentitySha256,
        sourceBinding, pdfDescriptor: pdfSource.descriptor
    };
    sourceSnapshotBinding.planAuthority = productionBinding;
    const sourceSnapshotSha256 = stableHash(sourceSnapshotBinding);
    const observationBinding = {
        contract: OBSERVATION_BINDING_CONTRACT, version: VERSION,
        sourceSnapshotSha256, runBinding: resolved.binding
    };
    const body = {
        contract: CONTRACT, version: VERSION, paperId: input.paperId,
        conference, identity,
        runBinding: resolved.binding,
        sourceBinding, sourceSnapshotBinding, sourceSnapshotSha256,
        observationBinding, observationBindingSha256: stableHash(observationBinding),
        pdfDescriptor: pdfSource.descriptor,
        metadata, text, structuredArtifacts,
        analysisReady: true, textOffsetUnit: OFFSET_UNIT,
        extractionReceipt: { contract: PDF_EXTRACTION_RECEIPT_CONTRACT, available: false, reason: NO_REPLAYABLE_RECEIPT },
        formulaAvailability, tableAvailability, figureAvailability,
        figurePolicy: 'no_external_fetch', sourceOnly: true,
        productionAuthorization: { authorized: true, binding: productionBinding }
    };
    return deepFreeze(body);
}

function buildConferenceSourceContext(input = {}) {
    if (!plain(input)) integrity('production conference source context input must be a plain object');
    exact(input, ['planHandle', 'paperId', 'sourceRoot'], 'production conference source context input');
    let authority;
    try { authority = planApi.planHandleAuthority(input.planHandle); }
    catch (error) { integrity(`planHandle is not authenticated: ${error.message}`, 'plan_handle_invalid'); }
    const snapshot = authority.snapshot;
    const receipt = snapshot.receipt;
    const bindingBody = {
        contract: PLAN_AUTHORITY_BINDING_CONTRACT,
        version: VERSION,
        planReceiptSha256: receipt.receiptSha256,
        planReceiptFileSha256: snapshot.receiptFileSha256,
        runFileSha256: snapshot.runFileSha256,
        importReceiptSha256: receipt.import.receiptSha256,
        filterPolicySha256: receipt.filter.filterPolicySha256,
        selectionReceiptSha256: receipt.filter.selectionReceiptSha256,
        selectedMemberSetSha256: receipt.filter.selectedMemberSetSha256
    };
    const productionBinding = { ...bindingBody, bindingSha256: stableHash(bindingBody) };
    return buildConferenceSourceContextFromLedger({ ledgerHandle: authority.ledgerHandle,
        run: snapshot.run, paperId: input.paperId, sourceRoot: input.sourceRoot }, productionBinding);
}

module.exports = {
    CONTRACT, VERSION, ARTIFACT_CONTRACT, ARTIFACT_VERSION, REPLAYABLE_PROFILE, WEAK_PROFILE,
    UNAVAILABLE_PROFILE, OFFSET_UNIT, SOURCE_SNAPSHOT_BINDING_CONTRACT, OBSERVATION_BINDING_CONTRACT,
    PLAN_AUTHORITY_BINDING_CONTRACT, PDF_EXTRACTION_RECEIPT_CONTRACT, MIN_TEXT_CHARS,
    ConferenceSourceContextError, buildConferenceSourceContext,
    stableHash
};
