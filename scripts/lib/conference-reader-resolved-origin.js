'use strict';
// Read-only provenance, never a completion/patch/budget capability. Human edit
// authority remains in the existing complete-final-failure-set transaction.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const origins = new WeakMap();
const CONTRACT = 'conference-latest-resolved-paid-reader-origin-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const impl = new Set(require('./reader-recovery-revision').ALLOWED_FIELDS.filter(key =>
    key.endsWith('ImplementationSha256') || ['tableCompilerSha256','draftOrderContract','mechanicalContractSha256'].includes(key)));
function fail(message) {
    throw Object.assign(new Error('Resolved paid Reader origin refused: ' + message), {
        code: 'CONFERENCE_READER_RESOLVED_ORIGIN_INTEGRITY', scope: 'run', retryable: false });
}
function sameStat(a, b) { return ['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'].every(key => a[key] === b[key]); }
function read(file, json = true) {
    const name = path.resolve(file), named = fs.lstatSync(name, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || (named.mode & 0o777n) !== 0o600n
        || named.size > 32n * 1024n * 1024n) fail('unsafe original file');
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const opened = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd);
        if (!sameStat(named, opened) || !sameStat(opened, fs.fstatSync(fd, { bigint: true }))
            || !sameStat(opened, fs.lstatSync(name, { bigint: true })) || BigInt(bytes.length) !== opened.size) fail('file changed during read');
        return { file: name, sha256: sha(bytes), bytes, ...(json ? { value: JSON.parse(bytes) } : {}) };
    } finally { fs.closeSync(fd); }
}
function tree(directory) {
    const rows = []; let total = 0;
    function visit(folder, prefix = '') {
        const s = fs.lstatSync(folder); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) fail('unsafe original directory');
        for (const name of fs.readdirSync(folder).sort()) {
            if (!/^[A-Za-z0-9._-]{1,220}$/u.test(name) || ['.','..'].includes(name)) fail('unsafe material name');
            const file = path.join(folder, name), stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) fail('linked original material');
            if (stat.isDirectory()) { visit(file, prefix + name + '/'); continue; }
            const value = read(file, false); total += value.bytes.length;
            if (rows.length >= 4096 || total > 256 * 1024 * 1024) fail('original materials exceed bounds');
            rows.push({ path: prefix + name, sha256: value.sha256 });
        }
    }
    visit(directory); return rows;
}
function logical(identity) { return Object.fromEntries(Object.entries(identity).filter(([key]) => !impl.has(key))); }
function checkedEnvelope(directory, file, expectedSha) {
    if (path.dirname(path.resolve(file)) !== path.resolve(directory)) fail('archive outside original directory');
    if (file.endsWith('.resolved.json')) {
        const checked = require('./reader-recovery-revision').readFullResolvedReaderForReadOnlyInspection(directory, file, expectedSha);
        if (!checked || read(file).sha256 !== expectedSha) fail('original envelope CAS differs');
        return checked.envelope;
    }
    const record = read(file), envelope = record.value;
    const safe = value => {
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('nonplain archive');
        for (const key of Object.keys(value)) {
            if (['__proto__','constructor','prototype'].includes(key)) fail('unsafe archive key');
            safe(value[key]);
        }
    };
    safe(envelope);
    if (record.sha256 !== expectedSha || envelope.version !== require('./reader-repair').REPAIR_VERSION
        || envelope.payloadSha256 !== hash(envelope.payload) || envelope.payload.status !== 'failed'
        || !new RegExp('^' + hash(envelope.identity) + '\\.migrated-[a-f0-9-]{36}\\.json$').test(path.basename(file))
        || !require('./reader-repair').parseRecoveryDraft(envelope.payload.draft)) fail('migration archive CAS or format differs');
    return envelope;
}
function migrationChain(directory, selected) {
    const latest = selected.identity, audits = selected.payload.readerRecoveryRevisions || [], files = [];
    let identity = latest, draft = hash(selected.payload.draft);
    for (let i = audits.length - 1; i >= 0; i--) {
        const audit = audits[i];
        if (audit.contract !== 'reader-recovery-diagnostics-revision-v1' || audit.scope !== 'conference-process'
            || audit.paperId !== latest.paperId || audit.runId !== latest.conferenceReaderGrant.executionId
            || audit.toIdentitySha256 !== hash(identity) || audit.clearedNoProgress !== false
            || audit.outputDraftSha256 !== draft || audit.inputDraftSha256 !== draft
            || !Array.isArray(audit.changedFields) || audit.changedFields.some(key => !impl.has(key))
            || !new RegExp('^' + audit.fromIdentitySha256 + '\\.migrated-[a-f0-9-]{36}\\.json$').test(audit.archivedName || '')) fail('unsupported or changed migration');
        const file = path.join(directory, audit.archivedName), record = read(file), previous = checkedEnvelope(directory, file, audit.oldEnvelopeSha256);
        if (record.sha256 !== audit.oldEnvelopeSha256 || hash(previous.payload) !== audit.oldPayloadSha256
            || hash(previous.identity) !== audit.fromIdentitySha256 || !equal(logical(previous.identity), logical(identity))
            || hash(previous.payload.draft) !== draft || previous.payload.attempts !== selected.payload.attempts
            || previous.payload.fullAttempts !== selected.payload.fullAttempts || previous.payload.noProgress !== selected.payload.noProgress
            || previous.payload.validationFailureStreak !== selected.payload.validationFailureStreak) fail('migration changes paid input or history');
        for (const key of ['transportFailures','noProgress','failureSignature','validationFailureStreak','validationFailureSignature','issues','implementationRepairAllowanceProof']) {
            if (!equal(previous.payload[key] ?? null, selected.payload[key] ?? null)) fail('migration changes original failed history');
        }
        files.push({ path: audit.archivedName, sha256: record.sha256 }); identity = previous.identity;
    }
    return { originalIdentity: identity, files };
}
function originalPrompts(identity) {
    const versions = require('./prompt-text-versions'), history = require('./prompt-history'), evidence = require('./prompt-evidence');
    return [['apiReaderArticle','promptSha256'],['apiReaderRepair','repairPromptSha256']].map(([stage,key]) => {
        // Narrow first implementation: the actually paid v9/v13 bytes are still
        // the current normal bytes. No caller selects an archived declaration.
        const contract = versions.currentPromptTextContract(stage), file = versions.promptFilePathForContract(stage, contract), bytes = evidence.readPromptEvidenceBytes(file);
        if (history.promptTemplateSha256(bytes.toString('utf8')) !== identity[key]) fail('original Prompt needs an unsupported archived-declaration route');
        return { stage, contract, file, fileSha256: sha(bytes), templateSha256: identity[key] };
    });
}
function uniqueUsage(identity, request, response, grantId, pins) {
    const directory = path.resolve(require('../config').FILES.llmUsageDir), result = [];
    require('./fresh-rewrite-run').assertSafeDirectory(directory);
    // Initial proof really checks uniqueness, not a caller-supplied fee list.
    // Only the matched immutable event is retained; no persistent fee index.
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
        const file = path.join(directory, name), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let bytes; try { const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 1024 * 1024) fail('unsafe fee event'); bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
        if (!bytes.includes(response.outputTextSha256)) continue;
        const row = read(file), event = row.value;
        if (event.kind !== 'request' || event.paperId !== identity.paperId || event.stage !== 'apiReaderRepair'
            || event.runId !== grantId || event.unitId !== sha(identity.conferenceReaderGrant.executionId) || event.contentAttempt !== request.contentAttempt
            || event.outputTextSha256 !== response.outputTextSha256 || event.model !== identity.model.model || event.protocol !== identity.model.protocol) continue;
        const at = Date.parse(event.at), from = Date.parse(request.at), to = Date.parse(response.at);
        if (event.version !== 'llm-usage-v1' || !/^[a-f0-9-]{36}$/u.test(event.eventId || '') || event.outcome !== 'completed' || event.statusCode !== 200
            || !Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(to) || from > at || from > to || Math.abs(to-at) > 30000) fail('fee outcome/time differs');
        result.push({ file: row.file, sha256: row.sha256, eventId: event.eventId });
    }
    if (result.length !== 1) fail('latest paid response lacks unique completed usage');
    pins.push(result[0]); return result[0];
}
function normalReplay(source, paper, selected, request, response) {
    const deep = require('../deep-analyzer'), context = require('./conference-analysis-context');
    const policy = context.conferenceWeakReaderCapabilityPolicy(paper, source.structuredArtifacts);
    const grantFields = { conferenceReaderGrant: require('./conference-reader-recovery-window').getCurrentReaderWindow(paper) };
    const evidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts, paper.id, policy, paper.apiReaderResources, false);
    const input = deep.apiReaderSourceOnlyInputFingerprint(paper, evidence, {
        readerGrantFields: grantFields, readerCapabilityPolicy: policy, structuredArtifacts: source.structuredArtifacts,
        naturalResourceProse: false, previousDraft: '无', directSupplementaryPreflightEvidence: [] });
    if (input !== selected.identity.inputFingerprint) fail('current real main/source/resource input differs from paid origin');
    const images = selected.payload.imageEvidence || [], seen = new Set();
    for (const image of images) {
        const sourceFigures = (source.structuredArtifacts.figures || []).filter(row => row.ordinal === image.ordinal);
        if (image.status !== 'ready' || image.kind !== 'figure' || seen.has(image.ordinal) || sourceFigures.length !== 1
            || image.inputId !== `figure:${image.ordinal}:${image.sourceSha256}` || image.sha256 !== image.sourceSha256
            || !/^[a-f0-9]{64}$/u.test(image.modelPayloadSha256 || '')
            || !(sourceFigures[0].images || []).some(item => item.url === image.url)) fail('original seen image source differs');
        seen.add(image.ordinal);
    }
    return require('./reader-compatible-candidate-replay').replayRepair(request, response, selected.payload, source,
        (draft, issues, imageEvidence) => deep.normalizeApiReaderRecoveryDraftForSource(draft, issues, {
            paperId: paper.id, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerCapabilityPolicy: policy, pixelFigureOrdinals: imageEvidence.filter(row => row.status === 'ready' && row.kind === 'figure').map(row => row.ordinal)
        }).draft, true);
}
function inspectLatestResolvedPaidReader({ analysisRoot, executionId, planHandle, sourceRoot }) {
    const adapter = require('./conference-analysis-adapter'), root = path.resolve(require('../config').FILES.conferenceAnalysisDir);
    if (path.resolve(analysisRoot) !== root) fail('noncanonical analysis root');
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: root, executionId }), paper = loaded.analysis.papers[0];
    const directory = path.join(loaded.directory, 'reader-attempts');
    if (!fs.existsSync(directory)) return null;
    const names = fs.readdirSync(directory);
    if (names.some(name => /^[a-f0-9]{64}\.json$/u.test(name))) return null;
    const resolved = names.filter(name => /^[a-f0-9]{64}\.[a-f0-9-]{36}\.resolved\.json$/u.test(name));
    if (!resolved.length || !fs.existsSync(path.join(loaded.directory, 'reader-grant-budget.json'))) return null;
    if (resolved.length !== 1) fail('multiple retired origins cannot be selected by passing content');
    const current = require('./conference-analysis-context').getConferenceAnalysisContext();
    const pdf = planHandle ? adapter.verifyPlanAuthority(loaded, planHandle, sourceRoot)
        : current?.executionId === executionId && current.paperId === paper.id
            && current.executionDir === loaded.directory && equal(current.sourceDetails, loaded.source.sourceDetails)
            ? current.readerPdfSourceHandle : null;
    const provider = require('./conference-source-context').readerPdfSourceForContext(pdf);
    if (!provider || provider.paperId !== paper.id || provider.sourceText !== loaded.source.sourceDetails.text
        || provider.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256) fail('missing authentic exact canonical source capability');
    const options = { paperId: paper.id, executionId, executionDir: loaded.directory, readerPdfSourceHandle: pdf };
    return require('./conference-analysis-context').withConferenceAnalysisSource({ ...options, sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1 }, () =>
        require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(loaded.recoveryWindow.grantHandle, options, () => {
            const entries = tree(directory), retained = fs.readdirSync(loaded.directory).filter(name => /^reader-grant-(request|response)-[a-f0-9-]{36}\.json$/u.test(name)).sort().map(name => ({ path: name, sha256: read(path.join(loaded.directory,name)).sha256 }));
            const selectedFile = read(path.join(directory, resolved[0])), selected = checkedEnvelope(directory, selectedFile.file, selectedFile.sha256), payload = selected.payload;
            const grant = require('./conference-reader-recovery-window').getCurrentReaderWindow(paper);
            if (selected.identity.paperId !== paper.id || selected.identity.sourceSha256 !== paper.sourceSha256
                || !equal(selected.identity.conferenceReaderGrant, grant) || selected.identity.freshAnalysis !== undefined
                || selected.identity.contentMode !== 'reader-source-only-v1' || payload.status !== 'failed'
                || !Number.isSafeInteger(payload.attempts) || payload.attempts < 1 || payload.attempts > 6
                || !Number.isSafeInteger(payload.fullAttempts) || payload.fullAttempts < 1 || payload.fullAttempts > 2
                || payload.explicitReaderRetryRound || payload.implementationRepairAllowanceProof) fail('retired origin identity/budget differs');
            const chain = migrationChain(directory, selected), ledger = read(path.join(loaded.directory, 'reader-grant-budget.json'));
            const allowed = require('./reader-recovery-revision').ALLOWED_FIELDS;
            const budgetLogical = Object.fromEntries(Object.entries(chain.originalIdentity).filter(([key]) => !allowed.includes(key)
                || ['promptSha256','repairPromptSha256','readerJsonRequestPolicy','readerRecoveryEpochSha256'].includes(key)));
            if (hash(budgetLogical) !== ledger.value.logicalIdentitySha256) fail('ledger logical input differs from the actual paid request');
            if (ledger.value.requests.some(row => row.status === 'pending')) fail('pending response cannot be bypassed');
            const content = ledger.value.requests.filter(row => row.status !== 'no_content'), latest = content.at(-1);
            if (!latest || latest.kind !== 'patch' || latest.status !== 'content' || latest.contentAttempt !== payload.attempts
                || content.length !== payload.attempts || content.filter(row=>row.kind==='full').length !== payload.fullAttempts
                || latest.identitySha256 !== hash(chain.originalIdentity)) fail('retired origin is not the exact latest paid response');
            const raw = read(path.join(loaded.directory, `reader-grant-response-${latest.id}.json`));
            const diagnostics = entries.filter(row => /^request-diagnostics\/[a-f0-9-]{36}\.request\.json$/u.test(row.path));
            const matching = diagnostics.map(row => read(path.join(directory, row.path))).filter(row => row.value.contentAttempt === payload.attempts && equal(row.value.identity, chain.originalIdentity));
            if (matching.length !== 1) fail('latest diagnostic request is not unique');
            const request = matching[0], response = read(request.file.replace('.request.json','.response.json'));
            if (request.value.contract !== 'reader-repair-request-diagnostics-v1' || request.value.promptSha256 !== sha(request.value.prompt)
                || request.value.draftSha256 !== hash(request.value.draft) || response.value.contract !== request.value.contract
                || response.value.id !== request.value.id || response.value.requestSha256 !== request.sha256
                || response.value.outputTextSha256 !== sha(response.value.rawResponse)
                || response.value.rawResponse !== raw.value.rawResponse || raw.value.outputTextSha256 !== latest.outputTextSha256) fail('original request/response differs from grant ledger');
            const assetDirectory = path.join(loaded.directory, 'reader-assets'), assets = tree(assetDirectory);
            for (const image of payload.imageEvidence || []) {
                const matches = assets.filter(row => row.sha256 === image.sourceSha256);
                if (matches.length !== 1 || read(path.join(assetDirectory,matches[0].path),false).bytes.length !== image.sourceBytes)
                    fail('original paid image bytes are missing or ambiguous');
            }
            const prompts = originalPrompts(chain.originalIdentity), replay = normalReplay(loaded.source.sourceDetails, paper, selected, request.value, response.value);
            if (!replay || !/^applied-response-/.test(replay.kind || '') || replay.draftSha256 !== hash(payload.draft)) fail('normal paid-to-retired replay is not exact');
            const pins = [read(path.join(loaded.directory,'analysis.json')), read(path.join(loaded.directory,'run.json')), selectedFile, request, response, ledger, read(path.join(loaded.directory,'source.json')), read(path.join(loaded.directory,'reader-revision.json'))];
            const usage = uniqueUsage(chain.originalIdentity, request.value, response.value, grant.grantId, pins);
            const proof = { contract: CONTRACT, originKind: 'latest_resolved_paid_reader', paperId: paper.id, executionId,
                sourceSha256: paper.sourceSha256, sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
                grant, resolved: { basename: resolved[0], sha256: selectedFile.sha256 }, migrations: chain.files,
                latestPaid: { requestId: latest.id, requestSha256: request.sha256, responseSha256: response.sha256,
                    outputTextSha256: response.value.outputTextSha256, replay, usage }, prompts,
                ledgerSha256: ledger.sha256, draftSha256: hash(payload.draft), originalIdentitySha256: hash(selected.identity),
                attempts: payload.attempts, fullAttempts: payload.fullAttempts, transportFailures: payload.transportFailures || 0, noProgress: payload.noProgress,
                failureSignature: payload.failureSignature, validationFailureStreak: payload.validationFailureStreak,
                validationFailureSignature: payload.validationFailureSignature, issuesSha256: hash(payload.issues),
                canonicalMainSha256: sha(paper.analysis), originalAttemptFiles: entries, originalGrantFiles: retained, originalAssetFiles: assets };
            const handle = Object.freeze({}); origins.set(handle, { proof, selected, loaded, pdf, pins, directory, entries, retained, assetDirectory, assets, planHandle, sourceRoot }); return handle;
        }));
}
function assertUnchanged(handle) {
    const value = origins.get(handle); if (!value) fail('unbranded origin');
    for (const row of value.pins) if (read(row.file, false).sha256 !== row.sha256) fail('origin file changed');
    if (!equal(tree(value.assetDirectory), value.assets)) fail('original asset files changed');
    if (!equal(tree(value.directory), value.entries)) fail('retired folder changed or became active');
    const actual = fs.readdirSync(value.loaded.directory).filter(name => /^reader-grant-(request|response)-[a-f0-9-]{36}\.json$/u.test(name)).sort().map(name => ({ path: name, sha256: read(path.join(value.loaded.directory,name)).sha256 }));
    if (!equal(actual, value.retained)) fail('grant requests/responses changed');
    require('./conference-source-context').readerPdfSourceForContext(value.pdf).assertUnchanged(); return value;
}
function readVerifiedOrigin(handle) {
    const value = assertUnchanged(handle);
    return { candidate: structuredClone(value.selected), originalPaidOrigin: structuredClone(value.proof) };
}
function assertOriginalPaidOrigin(handle, expected) {
    if (!equal(assertUnchanged(handle).proof, expected)) fail('cold origin receipt does not match actual paid materials');
}
function replayLocalPatch(handle, record) {
    const value = assertUnchanged(handle);
    if (record.originKind !== 'latest_resolved_paid_reader' || record.notLlmResponse !== true
        || (record.version !== undefined && record.version !== 1) || record.correctionKind !== undefined
        || path.resolve(record.baselineCandidateFile) !== path.join(value.directory, value.proof.resolved.basename)
        || record.baselineCandidateEnvelopeSha256 !== value.proof.resolved.sha256
        || record.baselineDraftSha256 !== value.proof.draftSha256) fail('local patch does not bind this exact retired origin');
    assertOriginalPaidOrigin(handle, record.originalPaidOrigin);
    // Data-only adapter for the existing pure verifier's identity basename.
    // This path is never opened, created, renamed or installed as an active file.
    return require('./daily-reader-operator-correction').replay({ ...record,
        contract: 'reader-human-source-edit-v1',
        baselineCandidateFile: path.join(value.directory, hash(value.selected.identity) + '.json')
    }, structuredClone(value.selected));
}
function assertDeferredLocalCorrection(handle) {
    const value = assertUnchanged(handle), loaded = value.loaded;
    if (loaded.analysis.status !== 'partial') fail('only an actual partial may be deferred');
    throw Object.assign(new Error('Latest paid Reader was retired before whole completion; use its authenticated local correction origin.'), {
        code: 'CONFERENCE_READER_RESOLVED_PAID_REQUIRES_LOCAL_CORRECTION', category: 'content', scope: 'paper', retryable: false,
        executionId: loaded.run.executionId, sourceSha256: value.proof.sourceSha256, originalPaidOrigin: structuredClone(value.proof) });
}
module.exports = { CONTRACT, inspectLatestResolvedPaidReader, readVerifiedOrigin, assertOriginalPaidOrigin,
    assertDeferredLocalCorrection, assertUnchanged, replayLocalPatch };
