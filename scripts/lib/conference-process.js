'use strict';

// Unified production control plane for newly acquired official proceedings.
// It deliberately replaces the disconnected conference execution/analyze
// commands: a paper is complete only when the authenticated analysis receipt
// and deterministic page manifest are both recorded in this checkpoint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CONTRACT = 'conference-process-v1';
const COMPLETION_CONTRACT = 'conference-process-completion-receipt-v1';
const DEEP_EXECUTION_CONFIG_CONTRACT = 'conference-deep-execution-config-v1';
const VERSION = 1;
const DEEP_EXECUTION_CONFIG_VERSION = 1;
const MAX_CONCURRENCY = 3;
const DEEP_EXECUTION_LIMIT_FIELDS = Object.freeze([
    'apiOverallTimeoutMs',
    'apiReaderOverallTimeoutMs',
    'apiMaxRetries',
    'apiRetryBaseDelayMs',
    'apiMaxTokens',
    'apiMaxResponseBytes',
    'repairMaxTokens',
    'apiReaderMaxTokens',
    'apiReaderRepairMaxTokens',
    'apiTemperature',
    'scoringAuditTemperature',
    'imagePlanTemperature',
    'imageDownloadTimeoutMs',
    'imageMaxBytes',
    'imageMaxBase64Chars',
    'imageTotalBase64Chars',
    'imageMaxCount',
    'imageCandidateMax',
    'imageInsertionMax',
    'fullTextMaxChars',
    'openSourceEvidenceMaxChars',
    'revisionEvidenceMaxChars',
    'apiReaderEvidenceMaxChars',
    'apiReaderContextMaxChars',
    'scoringEvidenceMaxChars',
    'repairEvidenceMaxChars',
    'structureEvidenceMaxChars',
    'fullTextMinCharsForFull'
]);
const DEEP_EXECUTION_TEMPERATURE_FIELDS = new Set([
    'apiTemperature', 'scoringAuditTemperature', 'imagePlanTemperature'
]);
const IMPLEMENTATION_FILES = Object.freeze([
    'prompts/api-reader-article.md',
    'prompts/api-reader-repair.md',
    'prompts/core-summary-repair.md',
    'prompts/deep-analysis.md',
    'prompts/gap-fill.md',
    'prompts/image-supplement.md',
    'prompts/method-fill.md',
    'prompts/opensource-scan.md',
    'prompts/scoring-audit.md',
    'prompts/structure-repair.md',
    'prompts/table-fill.md',
    'prompts/taxonomy-tag-repair.md',
    'scripts/analysis-contract.js',
    'scripts/analysis-engine.js',
    'scripts/conference-page-render.py',
    'scripts/conference_extractor.py',
    'scripts/config.js',
    'scripts/deep-analyzer.js',
    'scripts/editorial-quality.js',
    'scripts/env-loader.js',
    'scripts/lib/conference-analysis-adapter.js',
    'scripts/lib/conference-analysis-context.js',
    'scripts/lib/conference-postprocess.js',
    'scripts/lib/conference-process.js',
    'scripts/lib/conference-staging.js',
    'scripts/lib/paper-identity.js',
    'scripts/lib/reader-contract.js',
    'scripts/lib/reader-draft-order.js',
    'scripts/lib/reader-recovery-revision.js',
    'scripts/lib/reader-repair.js',
    'scripts/lib/reader-resource-binding.js',
    'scripts/lib/reader-resource-sync.js',
    'scripts/lib/reader-source-diagnostics.js',
    'scripts/lib/reader-tables.js',
    'scripts/llm-account-pool.js',
    'scripts/paper_identity.py',
    'scripts/utils.js'
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const canonicalBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);

function exactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
        throw new Error(`${label} has unknown or missing fields`);
    }
    return value;
}
function normalizedModel(value, label) {
    const raw = String(value || ''); const model = raw.trim();
    if (!model || raw !== model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
        throw new Error(`${label} must be a non-empty bounded model name`);
    }
    return model;
}
function endpointAudit(endpoint, model, utilsApi) {
    const rawEndpoint = String(endpoint || ''); const normalizedEndpoint = rawEndpoint.trim();
    if (!normalizedEndpoint || rawEndpoint !== normalizedEndpoint) {
        throw new Error('deep execution endpoint must be a non-empty canonical URL string');
    }
    const protocol = utilsApi.detectApiType(normalizedEndpoint, model);
    const apiUrl = new URL(utilsApi.buildApiUrl(protocol, normalizedEndpoint)).href;
    return { model, protocol, endpointIdentitySha256: sha256(Buffer.from(apiUrl, 'utf8')) };
}
function assertDeepExecutionLimit(field, value) {
    const valid = DEEP_EXECUTION_TEMPERATURE_FIELDS.has(field)
        ? Number.isFinite(value) && value >= 0 && value <= 1
        : Number.isSafeInteger(value) && value > 0;
    if (!valid) throw new Error(`deep execution config ${field} is invalid`);
    return value;
}
function deepExecutionConfigIdentity(options = {}) {
    const env = options.env || process.env;
    const analysisConfig = options.analysisConfig;
    const secondaryModelConfig = options.secondaryModelConfig || {};
    const utilsApi = options.utilsApi || require('../utils.js');
    if (!analysisConfig || typeof analysisConfig !== 'object' || Array.isArray(analysisConfig)) {
        throw new Error('deep execution config requires ANALYSIS_CONFIG');
    }
    const primaryModel = normalizedModel(env.PAPER_ANALYZER_MODEL, 'primary model');
    const primaryEndpoint = String(env.PAPER_ANALYZER_ENDPOINT || '');
    const primary = endpointAudit(primaryEndpoint, primaryModel, utilsApi);
    const secondaryModelRaw = String(secondaryModelConfig.model || '');
    const secondary = secondaryModelRaw
        ? endpointAudit(String(secondaryModelConfig.endpoint || primaryEndpoint),
            normalizedModel(secondaryModelRaw, 'secondary model'), utilsApi)
        : null;
    const reasoning = String(env.PD_OPENAI_RESPONSES_REASONING_EFFORT || '').trim().toLowerCase();
    const responses = {
        reasoningEffort: ['low', 'medium', 'high'].includes(reasoning) ? reasoning : null,
        stream: ['1', 'true', 'yes', 'on'].includes(
            String(env.PD_OPENAI_RESPONSES_STREAM || '').trim().toLowerCase()
        )
    };
    const limits = {};
    for (const field of DEEP_EXECUTION_LIMIT_FIELDS) {
        limits[field] = assertDeepExecutionLimit(field, analysisConfig[field]);
    }
    const audit = { primary, secondary, responses, limits };
    const body = { contract: DEEP_EXECUTION_CONFIG_CONTRACT,
        version: DEEP_EXECUTION_CONFIG_VERSION, audit };
    return { ...body, identitySha256: stableHash(body) };
}
function assertDeepExecutionConfigIdentity(value) {
    exactKeys(value, ['contract', 'version', 'audit', 'identitySha256'], 'deep execution config identity');
    if (value.contract !== DEEP_EXECUTION_CONFIG_CONTRACT || value.version !== DEEP_EXECUTION_CONFIG_VERSION) {
        throw new Error('deep execution config identity contract is unsupported');
    }
    exactKeys(value.audit, ['primary', 'secondary', 'responses', 'limits'], 'deep execution config audit');
    for (const [label, route] of [['primary', value.audit.primary], ['secondary', value.audit.secondary]]) {
        if (route === null && label === 'secondary') continue;
        exactKeys(route, ['model', 'protocol', 'endpointIdentitySha256'], `deep execution ${label} route`);
        normalizedModel(route.model, `${label} model`);
        if (!['openai', 'openai_responses', 'anthropic'].includes(route.protocol)
            || !/^[a-f0-9]{64}$/.test(route.endpointIdentitySha256 || '')) {
            throw new Error(`deep execution ${label} route is invalid`);
        }
    }
    exactKeys(value.audit.responses, ['reasoningEffort', 'stream'], 'deep execution Responses config');
    if (![null, 'low', 'medium', 'high'].includes(value.audit.responses.reasoningEffort)
        || typeof value.audit.responses.stream !== 'boolean') {
        throw new Error('deep execution Responses config is invalid');
    }
    exactKeys(value.audit.limits, DEEP_EXECUTION_LIMIT_FIELDS, 'deep execution limits');
    for (const field of DEEP_EXECUTION_LIMIT_FIELDS) {
        assertDeepExecutionLimit(field, value.audit.limits[field]);
    }
    const body = clone(value); delete body.identitySha256;
    if (value.identitySha256 !== stableHash(body)) throw new Error('deep execution config identity SHA mismatch');
    return value;
}
function currentDeepExecutionConfigIdentity(deps) {
    const builder = deps.deepExecutionConfigIdentity || deepExecutionConfigIdentity;
    return assertDeepExecutionConfigIdentity(builder({ env: deps.env || process.env,
        analysisConfig: deps.analysisConfig, secondaryModelConfig: deps.secondaryModelConfig,
        utilsApi: deps.utilsApi }));
}
function assertRuntimeAuthorityUnchanged(context, deps, phase) {
    const currentImplementation = (deps.implementationSha256 || implementationSha256)();
    if (currentImplementation !== context.authority.implementationSha256) {
        throw new Error(`Conference process implementation drifted ${phase}`);
    }
    const currentConfig = currentDeepExecutionConfigIdentity(deps);
    const expectedConfig = assertDeepExecutionConfigIdentity(context.authority.deepExecutionConfig);
    if (stableHash(currentConfig) !== stableHash(expectedConfig)) {
        throw new Error(`Conference process deep execution config drifted ${phase}`);
    }
    return true;
}

function deterministicUuid(...parts) {
    const bytes = Buffer.from(sha256(parts.join('\0')).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function stateDigest(value) { const body = clone(value); delete body.stateSha256; return stableHash(body); }
function exactFile(filename, bytes) {
    const payload = Buffer.from(bytes); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
        const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || (stat.mode & 0o777) !== 0o600 || !fs.readFileSync(filename).equals(payload)) {
            throw new Error(`Conference process refuses to overwrite different bytes: ${filename}`);
        }
    }
    return filename;
}
function safeProcessDirectory(root, processId, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !/^[a-f0-9-]{36}$/.test(processId)) {
        throw new Error('conferenceProcessDir and processId are invalid');
    }
    if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const absolute = path.resolve(root);
    for (const directory of [absolute]) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
            throw new Error(`conference process root is not a private directory: ${directory}`);
        }
    }
    const target = path.resolve(absolute, processId);
    if (path.dirname(target) !== absolute) throw new Error('conference process directory escapes configured root');
    if (create) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
        || fs.realpathSync(target) !== target) {
        throw new Error(`conference process directory is unsafe: ${target}`);
    }
    return target;
}
function initialState(authority, members, processId, now) {
    const items = Object.fromEntries(members.map(member => [member.paperId, {
        paperId: member.paperId, sourceIdentity: member.sourceIdentity,
        analysisRunId: deterministicUuid(processId, member.paperId, 'analysis'), status: 'pending',
        sourceProof: null, analysisProof: null, pageProof: null, attempts: 0, lastError: null, updatedAt: now
    }]));
    const value = { contract: CONTRACT, version: VERSION, generation: 1, processId, createdAt: now, updatedAt: now,
        authority, status: 'pending', items, aggregate: null, completionReceiptSha256: null };
    value.stateSha256 = stateDigest(value); return value;
}
function assertState(value, expected = null) {
    if (!value || value.contract !== CONTRACT || value.version !== VERSION
        || !/^[a-f0-9-]{36}$/.test(value.processId || '') || value.stateSha256 !== stateDigest(value)
        || !value.authority || !value.items || typeof value.items !== 'object'
        || !/^[a-f0-9]{64}$/.test(value.authority.implementationSha256 || '')
        || !['pending', 'running', 'partial', 'complete'].includes(value.status)) {
        throw new Error('Conference process checkpoint integrity failed');
    }
    try { assertDeepExecutionConfigIdentity(value.authority.deepExecutionConfig); }
    catch (error) { throw new Error(`Conference process checkpoint deep execution config integrity failed: ${error.message}`); }
    if (expected && (stableHash(value.authority) !== stableHash(expected.authority)
        || stableHash(Object.keys(value.items).sort()) !== stableHash(expected.paperIds))) {
        throw new Error('Conference process authority/member set drifted');
    }
    for (const [paperId, item] of Object.entries(value.items)) {
        if (item.paperId !== paperId || item.analysisRunId !== deterministicUuid(value.processId, paperId, 'analysis')
            || !['pending', 'source_sealed', 'analyzing', 'analysis_partial', 'complete'].includes(item.status)) {
            throw new Error(`Conference process item integrity failed: ${paperId}`);
        }
        if (item.status === 'complete' && (!item.sourceProof || !item.analysisProof || !item.pageProof)) {
            throw new Error(`Conference process complete item lacks causal proofs: ${paperId}`);
        }
    }
    const incomplete = Object.values(value.items).filter(item => item.status !== 'complete');
    if (value.status === 'complete') {
        if (incomplete.length || !value.aggregate
            || !/^[a-f0-9]{64}$/.test(value.completionReceiptSha256 || '')) {
            throw new Error('Conference process complete checkpoint lacks closed items/aggregate/receipt proof');
        }
    } else {
        if (value.aggregate !== null || value.completionReceiptSha256 !== null) {
            throw new Error('Conference process incomplete checkpoint carries aggregate/receipt proof');
        }
        if (value.status === 'partial' && !incomplete.length) {
            throw new Error('Conference process partial checkpoint has no incomplete item');
        }
    }
    return value;
}
function completionBodyFor(state, planReceiptSha256, aggregate) {
    return { contract: COMPLETION_CONTRACT, version: VERSION, processId: state.processId,
        authority: clone(state.authority), planReceiptSha256,
        items: Object.values(state.items).sort((a, b) => a.paperId.localeCompare(b.paperId)).map(item => ({
            paperId: item.paperId, analysisRunId: item.analysisRunId, sourceProof: item.sourceProof,
            analysisProof: item.analysisProof, pageProof: item.pageProof })), aggregate };
}
function validateCompletionReceipt(state, receipt, planReceiptSha256 = null) {
    const checked = assertState(state);
    if (checked.status !== 'complete') {
        throw new Error('Conference process completion receipt requires a complete checkpoint');
    }
    if (!receipt || receipt.contract !== COMPLETION_CONTRACT || receipt.version !== VERSION
        || receipt.processId !== checked.processId) throw new Error('Conference process completion receipt identity failed');
    const body = clone(receipt); delete body.receiptSha256;
    if (receipt.receiptSha256 !== stableHash(body)
        || checked.completionReceiptSha256 !== receipt.receiptSha256
        || stableHash(body.authority) !== stableHash(checked.authority)
        || stableHash(body.items) !== stableHash(completionBodyFor(checked,
            body.planReceiptSha256, body.aggregate).items)
        || stableHash(body.aggregate) !== stableHash(checked.aggregate)
        || (planReceiptSha256 && body.planReceiptSha256 !== planReceiptSha256)) {
        throw new Error('Conference process completion receipt does not bind the current lifecycle');
    }
    return receipt;
}

function defaultDependencies() {
    const Config = require('../config.js'); const discovery = require('./conference-discovery.js');
    const filter = require('./conference-filter.js'); const engine = require('../analysis-engine.js');
    return { files: Config.FILES, analysisConfig: Config.ANALYSIS_CONFIG,
        secondaryModelConfig: Config.SECONDARY_MODEL_CONFIG, env: process.env, utilsApi: require('../utils.js'),
        discovery, filter, engine, staging: require('./conference-staging.js'),
        importer: require('./conference-importer.js'), importCli: require('../conference-import.js'),
        plan: require('./conference-plan.js'), adapter: require('./conference-analysis-adapter.js'),
        postprocess: require('./conference-postprocess.js'), ledger: require('./conference-source-ledger.js'),
        now: () => new Date().toISOString(), execFileSync };
}
function implementationSha256(options = {}) {
    const root = options.root || path.join(__dirname, '..', '..');
    const readFileSync = options.readFileSync || fs.readFileSync;
    return sha256(IMPLEMENTATION_FILES.map(name => (
        `${name}\0${sha256(readFileSync(path.join(root, name)))}\0`
    )).join(''));
}
function loadAuthority(options, deps) {
    const files = deps.files; const catalogFile = path.join(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = path.join(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = deps.discovery.loadDiscoveryHandle(catalogFile, reportFile);
    const selectionHandle = deps.filter.loadSelectionHandle(files.conferenceFiltersDir, options.filterId, discoveryHandle);
    const discovery = deps.discovery.discoveryHandleSnapshot(discoveryHandle);
    const selection = deps.filter.selectionHandleSnapshot(selectionHandle);
    if (discovery.candidateManifest.adapter !== 'official-proceedings') {
        throw new Error('conference:new:process only accepts official-proceedings exact-PDF discovery');
    }
    let acquisitionReceipt = discovery.candidateManifest.acquisitionReceipt || null;
    if (process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE === '1' && !acquisitionReceipt) {
        const configuredRoot = files.officialConferenceAcquisitionDir;
        const expectedRoot = configuredRoot && path.resolve(configuredRoot, discovery.candidateManifest.conference.id);
        if (typeof deps.discovery.officialAcquisitionBindingFromRoot !== 'function'
            || !expectedRoot || path.resolve(discovery.candidateManifest.pdfRoot) !== expectedRoot
            || discovery.candidateManifest.metadataSnapshot.file !== path.join(expectedRoot, 'metadata.json')) {
            throw new Error('new-conference process requires discovery bound to official acquisition receipt');
        }
        acquisitionReceipt = deps.discovery.officialAcquisitionBindingFromRoot(
            discovery.candidateManifest.conference,
            discovery.candidateManifest.metadataSnapshot,
            expectedRoot
        );
    }
    if (!selection.included.length) throw new Error('conference:new:process requires a non-empty complete selection');
    for (const member of selection.included) {
        const replay = deps.discovery.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
        if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) {
            throw new Error(`selected source is not a unique official exact PDF: ${member.paperId}`);
        }
    }
    const taxonomy = deps.ledger.readRegularJson(files.taxonomyRegistry);
    const taxonomyVersion = String(taxonomy.value.version || taxonomy.value.registryVersion || '');
    if (!taxonomyVersion) throw new Error('current taxonomy registry version is missing');
    const authority = { conferenceId: selection.conferenceId, catalogName: options.catalogName,
        reportName: options.reportName, filterId: options.filterId, catalogSha256: discovery.catalogSha256,
        reportSha256: discovery.reportSha256, filterPolicySha256: selection.filterPolicySha256,
        selectionReceiptSha256: selection.selectionReceiptSha256,
        selectedMemberSetSha256: selection.selectedMemberSetSha256,
        acquisitionReceiptSha256: acquisitionReceipt?.catalogReceiptSha256 || null,
        acquisitionPdfReceiptSetSha256: acquisitionReceipt?.pdfReceiptSetSha256 || null,
        taxonomyVersion, taxonomyRegistrySha256: taxonomy.sha256,
        implementationSha256: (deps.implementationSha256 || implementationSha256)(),
        deepExecutionConfig: currentDeepExecutionConfigIdentity(deps) };
    return { files, discoveryHandle, selectionHandle, discovery, selection, authority,
        members: selection.included.map(({ paperId, sourceIdentity }) => ({ paperId, sourceIdentity })) };
}
function namesFor(context) {
    const stem = `${context.authority.conferenceId}-${context.authority.selectionReceiptSha256.slice(0, 16)}-${context.authority.implementationSha256.slice(0, 12)}`;
    return { extraction: `${stem}-source-seal.json`, import: `${stem}-import.json`,
        stagingReceipt: `${stem}-staging-receipt.json`, ledger: `${stem}-ledger.json`,
        importReceipt: `${stem}-ledger.import-receipt.json`, plan: `${stem}-plan.json`, run: `${stem}-run.json` };
}
function sourceNames(paperId, implementationSha256 = '') {
    const suffix = implementationSha256 ? `-${implementationSha256.slice(0, 12)}` : '';
    const stem = `paper-${sha256(paperId).slice(0, 24)}${suffix}`;
    return { metadata: `${stem}-metadata.json`, pdf: `${stem}.pdf`, request: `${stem}-extract.json`,
        text: `${stem}.txt`, artifacts: `${stem}-artifacts.json`, receipt: `${stem}-extraction-receipt.json` };
}
function sourceCacheRoot(context) {
    const base = context?.files?.conferenceSourceCacheDir;
    const implementation = context?.authority?.implementationSha256;
    if (typeof base !== 'string' || !path.isAbsolute(base) || !/^[a-f0-9]{64}$/.test(implementation || '')) {
        throw new Error('conference source cache root requires the authenticated implementation identity');
    }
    return path.join(base, `generation-${implementation}`);
}
function sealOneSource(context, member, deps, createdAt, { replayExisting = true } = {}) {
    const { discovery, discoveryHandle, files } = context; const replay = deps.discovery.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
    const names = sourceNames(member.paperId, context.authority.implementationSha256); const root = files.conferenceStagingSourceDir; fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const record = { ...replay.metadataRecord, conferenceId: replay.conference.id, year: replay.conference.year,
        identity: clone(replay.identity) };
    const metadataBytes = canonicalBytes(record); const candidate = replay.match.candidates[0];
    const pdfLoaded = deps.discovery.safeAbsoluteFile(path.join(discovery.candidateManifest.pdfRoot, candidate.path),
        `official PDF for ${member.paperId}`, deps.discovery.MAX_PDF_BYTES);
    if (sha256(pdfLoaded.bytes) !== candidate.sha256) throw new Error(`official PDF SHA drifted: ${member.paperId}`);
    exactFile(path.join(root, names.metadata), metadataBytes); exactFile(path.join(root, names.pdf), pdfLoaded.bytes);
    const request = { contract: 'conference-pdf-extraction-request-v2', version: 2, paperId: member.paperId,
        sourceIdentity: member.sourceIdentity, source: {
            metadata: { file: names.metadata, sha256: sha256(metadataBytes), identityEvidence: {
                conferenceIdPointer: '/conferenceId', conferenceYearPointer: '/year', identityTypePointer: '/identity/type',
                identityValuePointer: '/identity/value' }, discoveryBinding: { catalogSha256: replay.catalogSha256,
                metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
                metadataRecordSha256: replay.metadataRecordSha256 }, provenance: { kind: 'official-metadata',
                locator: String(replay.metadataRecord.recordUrl), retrievedAt: createdAt } },
            pdf: { file: names.pdf, sha256: candidate.sha256, provenance: { kind: 'official-pdf',
                locator: String(replay.metadataRecord.pdfUrl), retrievedAt: createdAt } } },
        outputs: { textFile: names.text, artifactsFile: names.artifacts, receiptFile: names.receipt },
        options: { minimumTextCharacters: 5000, normalization: 'unicode-nfc-lf-rstrip-v1', pageSeparator: '\n\f\n' } };
    exactFile(path.join(root, names.request), canonicalBytes(request));
    const hadReceipt = fs.existsSync(path.join(root, names.receipt));
    if (!hadReceipt) {
        deps.execFileSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'), path.join(__dirname, '..', 'conference-extract.py'),
            '--apply', '--manifest', names.request], { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
    }
    const extraction = require('./conference-extraction-receipt.js');
    const snapshot = extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(root, names.receipt,
        { replay: !hadReceipt || replayExisting }));
    return { paperId: member.paperId, sourceIdentity: member.sourceIdentity, receiptName: names.receipt,
        proof: { requestSha256: snapshot.verification.requestSha256, receiptSha256: snapshot.receipt.receiptSha256,
            verificationSha256: snapshot.verification.verificationSha256, textSha256: snapshot.text.sha256,
            artifactsSha256: snapshot.artifacts.sha256, pdfSha256: snapshot.pdf.sha256 } };
}
function prepareShared(context, deps, createdAt) {
    const files = context.files; const names = namesFor(context); const cacheRoot = sourceCacheRoot(context);
    for (const root of [files.conferenceStagingSpecsDir, files.conferenceStagingSourceDir,
        files.conferenceStagingDir, files.conferenceSourceCacheDir, cacheRoot, files.conferenceSourceLedgerDir,
        files.conferenceRunsDir, files.conferenceAnalysisDir, files.conferencePageStagingDir,
        files.conferenceAggregateDir]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const sealed = context.members.map(member => sealOneSource(context, member, deps, createdAt,
        { replayExisting: false }));
    const seal = { contract: deps.staging.AUTOMATED_EXTRACTION_CONTRACT, version: deps.staging.VERSION,
        conference: clone(context.discovery.candidateManifest.conference), acceptance: {
            method: 'official-proceedings-exact-pdf-v1', catalogSha256: context.discovery.catalogSha256,
            selectionReceiptSha256: context.selection.selectionReceiptSha256 },
        members: sealed.map(({ paperId, sourceIdentity, receiptName }) => ({ paperId, sourceIdentity, receiptName })) };
    seal.members.sort((a, b) => a.paperId.localeCompare(b.paperId)); seal.membersSha256 = deps.staging.stableHash(seal.members);
    fs.mkdirSync(files.conferenceStagingSpecsDir, { recursive: true, mode: 0o700 });
    const sealFile = exactFile(path.join(files.conferenceStagingSpecsDir, names.extraction), canonicalBytes(seal));
    const staged = deps.staging.bindInputs({ selectionHandle: context.selectionHandle, discoveryHandle: context.discoveryHandle,
        extractionManifest: seal, extractionFileSha256: sha256(fs.readFileSync(sealFile)),
        extractionSourceRoot: files.conferenceStagingSourceDir, importManifestName: names.import, replay: false });
    const importFile = path.join(files.conferenceStagingDir, names.import);
    const stagingReceiptFile = path.join(files.conferenceStagingDir, names.stagingReceipt);
    if (!fs.existsSync(importFile) && !fs.existsSync(stagingReceiptFile)) deps.staging.writeStagingBundle({
        stagingRoot: files.conferenceStagingDir, importManifestName: names.import, receiptName: names.stagingReceipt, staged });
    if (fs.existsSync(importFile) !== fs.existsSync(stagingReceiptFile)) throw new Error('partial conference staging bundle cannot be recovered');
    const stagingHandle = deps.staging.loadStagingHandle(importFile, stagingReceiptFile, context.selectionHandle,
        context.discoveryHandle, files.conferenceStagingSourceDir, { replay: false });
    const result = deps.importer.importConferenceSourcesFromStaging({ stagingHandle,
        sourceRoot: files.conferenceStagingSourceDir, cacheRoot,
        updatedAt: createdAt, apply: true, replay: false });
    const bundle = deps.importer.createImportReceipt({ result, ledgerName: names.ledger });
    const ledgerFile = path.join(files.conferenceSourceLedgerDir, names.ledger);
    const importReceiptFile = path.join(files.conferenceSourceLedgerDir, names.importReceipt);
    if (!fs.existsSync(ledgerFile) && !fs.existsSync(importReceiptFile)) deps.importCli.reserveOutputPair(
        files.conferenceSourceLedgerDir, names.ledger, bundle.ledgerBytes, bundle.receipt, names.importReceipt);
    if (fs.existsSync(ledgerFile) !== fs.existsSync(importReceiptFile)) throw new Error('partial conference import bundle cannot be recovered');
    const importHandle = deps.importer.loadImportHandle(ledgerFile, importReceiptFile, stagingHandle);
    const imported = deps.importer.importHandleSnapshot(importHandle); const taxonomy = deps.ledger.readRegularJson(files.taxonomyRegistry);
    const taxonomyVersion = String(taxonomy.value.version || taxonomy.value.registryVersion || '');
    if (!taxonomyVersion) throw new Error('taxonomy registry version is missing');
    const identities = imported.verifiedMembers; const shards = [];
    for (let index = 0; index < identities.length; index += 50) shards.push({ shardId: `part-${String(index / 50 + 1).padStart(4, '0')}`,
        paperIds: identities.slice(index, index + 50).map(item => item.paperId) });
    const planDoc = { contract: deps.plan.PLAN_CONTRACT, version: deps.plan.VERSION, ledgerName: names.ledger,
        taxonomy: { version: taxonomyVersion, sha256: taxonomy.sha256 }, selectionPolicy: {
            contract: deps.plan.SELECTION_CONTRACT, identities,
            selectedMemberSetSha256: deps.plan.stableHash(identities.map(item => item.paperId)) }, shards };
    exactFile(path.join(files.conferenceSourceLedgerDir, names.plan), canonicalBytes(planDoc));
    const planned = deps.plan.createRunFromImportPlan({ files, importHandle, planName: names.plan, runName: names.run });
    const runFile = path.join(files.conferenceRunsDir, names.run); const planReceiptFile = path.join(files.conferenceRunsDir, planned.receiptName);
    if (!fs.existsSync(runFile) && !fs.existsSync(planReceiptFile)) deps.plan.applyRunPlan(planned);
    if (fs.existsSync(runFile) !== fs.existsSync(planReceiptFile)) throw new Error('partial conference plan bundle cannot be recovered');
    const planHandle = deps.plan.loadPlanHandle(runFile, planReceiptFile,
        path.join(files.conferenceSourceLedgerDir, names.plan), importHandle, files.taxonomyRegistry);
    return { planHandle, names, sealed, sourceCacheRoot: cacheRoot,
        planReceiptSha256: deps.plan.planHandleSnapshot(planHandle).receipt.receiptSha256 };
}

async function processOne(context, shared, item, deps) {
    const files = context.files; deps.adapter.prepareConferenceAnalysis({ planHandle: shared.planHandle,
        paperId: item.paperId, sourceRoot: shared.sourceCacheRoot,
        analysisRoot: files.conferenceAnalysisDir, executionId: item.analysisRunId });
    const analyzed = await deps.adapter.analyzeConference({ analysisRoot: files.conferenceAnalysisDir,
        executionId: item.analysisRunId, concurrency: 1, planHandle: shared.planHandle,
        sourceRoot: shared.sourceCacheRoot });
    if (analyzed.status !== 'complete') throw new Error(`analysis remained ${analyzed.status}`);
    const staged = deps.postprocess.stagePaper({ analysisRoot: files.conferenceAnalysisDir,
        executionId: item.analysisRunId, taxonomyFile: files.taxonomyRegistry,
        stagingRoot: files.conferencePageStagingDir, planHandle: shared.planHandle,
        sourceRoot: shared.sourceCacheRoot, apply: true });
    if (staged.status !== 'staged') throw new Error(`paper postprocess remained ${staged.status}`);
    return { analysisProof: { analysisSha256: analyzed.analysisSha256,
        completionReceiptSha256: staged.manifest.completionReceiptSha256,
        sourceSnapshotSha256: staged.manifest.sourceSnapshotSha256 },
    pageProof: { manifestSha256: staged.manifest.manifestSha256, contentSha256: staged.manifest.contentSha256,
        pagePath: staged.manifest.pagePath } };
}
async function runWorkers(items, concurrency, worker) {
    let cursor = 0; const results = [];
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); }
    });
    await Promise.all(runners); return results;
}

async function runConferenceProcessLocked(options, deps, context, processId, directory) {
    assertRuntimeAuthorityUnchanged(context, deps, 'before shared preparation');
    const stateFile = path.join(directory, 'state.json');
    const expected = { authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() };
    let state = deps.engine.updateJsonFileLocked(stateFile, current => {
        if (current) { assertState(current, expected); return undefined; }
        return initialState(context.authority, context.members, processId, deps.now());
    }, { allowMissing: true });
    state = assertState(state || JSON.parse(fs.readFileSync(stateFile)), expected);
    if (state.status === 'complete') {
        validateCompletionReceipt(state, JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json'))));
    }
    const shared = await (deps.prepareShared || prepareShared)(context, deps, state.createdAt);
    const sourceByPaper = new Map(shared.sealed.map(item => [item.paperId, item.proof]));
    const updateItem = (paperId, expectedStatuses, updater) => deps.engine.updateJsonFileLocked(stateFile, current => {
        const checked = assertState(current, expected); const currentItem = checked.items[paperId];
        if (!currentItem || !Array.isArray(expectedStatuses) || expectedStatuses.length === 0) {
            throw new Error(`Conference process item CAS is invalid: ${paperId}`);
        }
        if (!expectedStatuses.includes(currentItem.status)) {
            if (currentItem.status === 'complete') return undefined;
            throw new Error(`Conference process item CAS failed: ${paperId} is ${currentItem.status}`);
        }
        const nextItem = updater(clone(currentItem));
        if (!nextItem || typeof nextItem !== 'object' || Array.isArray(nextItem)
            || (currentItem.status === 'complete' && nextItem.status !== 'complete')) {
            throw new Error(`Conference process refuses invalid item transition: ${paperId}`);
        }
        const next = clone(checked); next.items[paperId] = nextItem;
        next.updatedAt = deps.now(); next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
        next.generation = checked.generation + 1;
        next.stateSha256 = stateDigest(next); return assertState(next, expected);
    });
    for (const member of context.members) {
        const current = assertState(JSON.parse(fs.readFileSync(stateFile)), expected).items[member.paperId];
        if (current.status === 'complete') continue;
        updateItem(member.paperId, [current.status], item => ({ ...item,
            status: item.status === 'pending' ? 'source_sealed' : item.status,
            sourceProof: sourceByPaper.get(member.paperId), updatedAt: deps.now() }));
    }
    const pending = context.members.map(member => assertState(JSON.parse(fs.readFileSync(stateFile)), expected).items[member.paperId])
        .filter(item => item.status !== 'complete');
    await runWorkers(pending, options.concurrency, async item => {
        const claimed = updateItem(item.paperId, [item.status], current => ({ ...current,
            status: 'analyzing', attempts: current.attempts + 1,
            lastError: null, updatedAt: deps.now() }));
        if (claimed.items[item.paperId].status === 'complete') return;
        try {
            const proof = await (deps.processPaper || processOne)(context, shared, item, deps);
            updateItem(item.paperId, ['analyzing'], current => ({ ...current, ...proof,
                status: 'complete', lastError: null, updatedAt: deps.now() }));
        } catch (error) {
            updateItem(item.paperId, ['analyzing'], current => ({ ...current,
                status: 'analysis_partial', lastError: String(error.message || error).slice(0, 2000), updatedAt: deps.now() }));
        }
    });
    state = assertState(JSON.parse(fs.readFileSync(stateFile)), expected);
    let incomplete = Object.values(state.items).filter(item => item.status !== 'complete');
    if (incomplete.length) {
        state = deps.engine.updateJsonFileLocked(stateFile, current => {
            const checked = assertState(current, expected);
            if (Object.values(checked.items).every(item => item.status === 'complete')) return undefined;
            const next = clone(checked); next.status = 'partial'; next.aggregate = null;
            next.completionReceiptSha256 = null; next.updatedAt = deps.now();
            next.generation = checked.generation + 1; next.stateSha256 = stateDigest(next); return next;
        });
        state = assertState(state || JSON.parse(fs.readFileSync(stateFile)), expected);
        incomplete = Object.values(state.items).filter(item => item.status !== 'complete');
        if (incomplete.length) return { status: 'partial', processId, conferenceId: context.authority.conferenceId,
            complete: context.members.length - incomplete.length, failed: incomplete.length };
    }
    assertRuntimeAuthorityUnchanged(context, deps, 'before aggregate');
    const executionIds = context.members.map(member => state.items[member.paperId].analysisRunId);
    const aggregate = await (deps.aggregate || (async () => deps.postprocess.aggregateConference({
        analysisRoot: deps.files.conferenceAnalysisDir, executionIds, taxonomyFile: deps.files.taxonomyRegistry,
        stagingRoot: deps.files.conferencePageStagingDir, aggregateRoot: deps.files.conferenceAggregateDir,
        planHandle: shared.planHandle, sourceRoot: shared.sourceCacheRoot, apply: true })))(context, shared, executionIds, deps);
    const aggregateProof = { manifestSha256: aggregate.manifest.manifestSha256,
        markdownSha256: aggregate.manifest.markdownSha256, aggregateId: aggregate.manifest.aggregateId,
        pagePath: aggregate.manifest.pagePath };
    const receiptBody = completionBodyFor(state, shared.planReceiptSha256, aggregateProof);
    const receipt = { ...receiptBody, receiptSha256: stableHash(receiptBody) };
    state = deps.engine.updateJsonFileLocked(stateFile, current => {
        assertRuntimeAuthorityUnchanged(context, deps, 'during final completion transaction');
        const checked = assertState(current, expected);
        if (Object.values(checked.items).some(item => item.status !== 'complete')) {
            throw new Error('Conference process completion transaction found incomplete items');
        }
        if (stableHash(completionBodyFor(checked, shared.planReceiptSha256, aggregateProof))
            !== stableHash(receiptBody)) {
            throw new Error('Conference process completion transaction drifted from its receipt');
        }
        exactFile(path.join(directory, 'completion-receipt.json'), canonicalBytes(receipt));
        const next = clone(checked);
        next.status = 'complete'; next.aggregate = aggregateProof; next.completionReceiptSha256 = receipt.receiptSha256;
        next.updatedAt = deps.now(); next.generation = current.generation + 1;
        next.stateSha256 = stateDigest(next); return assertState(next, expected); });
    validateCompletionReceipt(assertState(state, expected), receipt, shared.planReceiptSha256);
    return { status: 'complete', processId, conferenceId: context.authority.conferenceId,
        papers: context.members.length, completionReceiptSha256: receipt.receiptSha256, aggregate: aggregateProof };
}

async function runConferenceProcess(options, overrides = {}) {
    if (!options || typeof options.apply !== 'boolean' || !Number.isInteger(options.concurrency)
        || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) {
        throw new Error('conference process requires explicit mode and concurrency 1-3');
    }
    const deps = { ...defaultDependencies(), ...overrides };
    const context = (deps.loadAuthority || loadAuthority)(options, deps);
    const processId = deterministicUuid(stableHash(context.authority), 'conference-process-v1');
    if (!options.apply) return { status: 'dry-run', processId, conferenceId: context.authority.conferenceId,
        papers: context.members.length, concurrency: options.concurrency };
    const directory = safeProcessDirectory(deps.files.conferenceProcessDir, processId, true);
    const withProcessLock = deps.withProcessLock
        || ((target, callback, lockOptions) => deps.engine.withFileLock(target, callback, lockOptions));
    return withProcessLock(path.join(directory, '.operation'), () => (
        runConferenceProcessLocked(options, deps, context, processId, directory)
    ), { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

module.exports = { CONTRACT, COMPLETION_CONTRACT, VERSION, MAX_CONCURRENCY, stableHash, deterministicUuid,
    DEEP_EXECUTION_CONFIG_CONTRACT, DEEP_EXECUTION_CONFIG_VERSION, DEEP_EXECUTION_LIMIT_FIELDS,
    deepExecutionConfigIdentity, assertDeepExecutionConfigIdentity, currentDeepExecutionConfigIdentity,
    assertRuntimeAuthorityUnchanged,
    stateDigest, assertState, completionBodyFor, validateCompletionReceipt, defaultDependencies, loadAuthority,
    namesFor, sourceNames, sealOneSource, prepareShared,
    IMPLEMENTATION_FILES, implementationSha256, processOne, runWorkers,
    runConferenceProcessLocked, runConferenceProcess, safeProcessDirectory, exactFile };
