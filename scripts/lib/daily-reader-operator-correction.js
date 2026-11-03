'use strict';
// Explicit local corrections are not model responses or new request allowances.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage();
const codec = require('./protocol-codec');
const CONTRACT = 'daily-reader-operator-correction-batch';
const PROOF = 'daily-reader-operator-correction';
const EDIT = 'reader-human-source-edit';
const PAID_FINGERPRINT_EDIT = 'reader-human-paid-draft-fingerprint-edit';
const PAID_FINGERPRINT_COMPLETION = 'reader-paid-draft-fingerprint-completion';
const hasOperatorProof = value => codec.hasValidHeader(value, PROOF);
const operatorProofTags = new Set(codec.registeredHeaders(PROOF).map(header => header.contract));
const hasOperatorProofMarker = value => operatorProofTags.has(value?.contract);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const id = paper => require('../utils').normalizedId({arxivId:paper?.arxivId||paper?.paper_id||paper?.paperId});
function read(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 20*1024*1024)
            throw new Error('Operator correction requires a bounded private regular file');
        const bytes = fs.readFileSync(fd); return { file:path.resolve(file), sha256:sha(bytes), value:JSON.parse(bytes) };
    } finally { fs.closeSync(fd); }
}
function within(file, root) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operator file outside controlled runtime');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(path.resolve(file)));
}
function unchanged(snapshot) {
    if (read(snapshot.file).sha256 !== snapshot.sha256) throw new Error('Operator correction source bytes changed');
}
function nearFingerprint(before, expected) {
    if (typeof before !== 'string' || !/^[a-f0-9]{56,63}$/.test(before)) return false;
    if (before.slice(0, 16) !== expected.slice(0, 16) || before.slice(-16) !== expected.slice(-16)) return false;
    let previous = Array.from({ length: expected.length + 1 }, (_, index) => index);
    for (let row = 1; row <= before.length; row++) {
        const current = [row];
        for (let column = 1; column <= expected.length; column++)
            current.push(Math.min(previous[column] + 1, current[column - 1] + 1,
                previous[column - 1] + Number(before[row - 1] !== expected[column - 1])));
        previous = current;
    }
    return previous[expected.length] <= 8;
}
function replayPaidFingerprint(record, candidate) {
    const repair = require('./reader-repair');
    const payload = candidate.payload, raw = payload.rawDraft;
    const fields = ['contract','schemaFingerprint','notLlmResponse','paperId','runId','batchDate',
        'baselineCandidateFile','baselineCandidateEnvelopeSha256','baselineDraftSha256','sourceDescriptor',
        'rawDraftSha256','correctedRawSha256','wholeSha256','currentInputIdentity','feeFiles'];
    if (Object.keys(record).sort().join(',') !== fields.sort().join(',')
        || record.notLlmResponse !== true || payload.status !== 'failed' || payload.draft !== null
        || !Number.isSafeInteger(payload.attempts) || !Number.isSafeInteger(payload.fullAttempts)
        || payload.attempts < payload.fullAttempts || payload.fullAttempts < 1
        || payload.explicitReaderRetryRound || payload.ordinalPatchCompilations?.length
        || typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024 * 1024
        || sha(raw) !== record.rawDraftSha256
        || record.baselineDraftSha256 !== repair.hashDraft(null)
        || !/^[a-f0-9]{64}$/.test(record.wholeSha256 || '')
        || !payload.issues?.some(issue => issue.path === null
            && issue.message === '读者文章格式头未登记或字段混用')
        || repair.hashDraft(candidate.identity) !== path.basename(record.baselineCandidateFile,'.json'))
        throw new Error('Operator paid fingerprint original or scope differs');
    const strictJson = require('./publication-file-primitives').strictJson;
    const parsed = strictJson(Buffer.from(raw), 'original paid Reader JSON');
    const expected = codec.recordHeader('reader-draft', 'reader-draft');
    const member = repair.readTopLevelMembers(raw).find(item => item.name === 'schemaFingerprint');
    if (!member || parsed.contract !== expected.contract || !nearFingerprint(parsed.schemaFingerprint, expected.schemaFingerprint)
        || raw.slice(member.valueStart, member.valueEnd) !== JSON.stringify(parsed.schemaFingerprint))
        throw new Error('Operator paid fingerprint is not a bounded malformed current header');
    const corrected = raw.slice(0, member.valueStart) + JSON.stringify(expected.schemaFingerprint) + raw.slice(member.valueEnd);
    const draft = strictJson(Buffer.from(corrected), 'corrected paid Reader JSON');
    if (sha(corrected) !== record.correctedRawSha256 || !repair.parseRepairableDraft(draft)
        || !isDeepStrictEqual(draft, { ...parsed, ...expected }))
        throw new Error('Operator paid fingerprint replacement changes content or shape');
    require('./reader-request-diagnostics').validatePaidDraftFingerprintFees(record.feeFiles, candidate, record.rawDraftSha256);
    return draft;
}
function isPaidFingerprintRecord(record) { return codec.hasValidHeader(record, PAID_FINGERPRINT_EDIT); }
function assertPaidFingerprintContext(record, candidate, paper, whole, currentIdentity = record.currentInputIdentity) {
    if (!isPaidFingerprintRecord(record)) return;
    // This adapter is part of the two implementation hashes. The original
    // paid logical input and all other format/prompt/source fields are fixed.
    const implementationFields = new Set(['parserImplementationSha256', 'repairImplementationSha256']);
    const unchangedInput = identity => Object.fromEntries(Object.entries(identity).filter(([key]) => !implementationFields.has(key)));
    if (!currentIdentity || !isDeepStrictEqual(currentIdentity, record.currentInputIdentity)
        || [...implementationFields].some(key =>
            !/^[a-f0-9]{64}$/.test(currentIdentity[key] || ''))
        || typeof whole !== 'string' || record.wholeSha256 !== sha(whole)
        || !isDeepStrictEqual(unchangedInput(currentIdentity), unchangedInput(candidate.identity))
        || paper.analysisManifest?.stages?.apiReaderArticle?.ordinalCompletionProof
        || paper.readerRevisionHistory?.completionProof)
        throw new Error('Operator paid fingerprint original whole, input, or retained ordinal history differs');
}
function replay(record, candidate) {
    if (isPaidFingerprintRecord(record)) return replayPaidFingerprint(record, candidate);

    const repair = require('./reader-repair');
    if (!codec.hasValidHeader(record, EDIT) || record.notLlmResponse !== true
        || repair.hashDraft(candidate.identity) !== path.basename(record.baselineCandidateFile,'.json')
        || record.baselineDraftSha256 !== repair.hashDraft(candidate.payload.draft)
        || !repair.parseRepairableDraft(record.draft) || !Array.isArray(record.patch?.replacements)
        || record.patch.replacements.length < 1 || record.patch.replacements.length > 8)
        throw new Error('Operator correction original draft or bounded patch differs');
    const paths = record.patch.replacements.map(r=>r.path);
    if (paths.some(p=>!/^\/(?:readerTitle|oneSentenceThesis)$|^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/(?:body|explanation))?$/.test(p)))
        throw new Error('Operator correction changes an unauthorized node');
    const result = repair.applyReaderPatch(candidate.payload.draft,record.patch,paths);
    if (!isDeepStrictEqual(result,record.draft) || repair.hashDraft(result) === repair.hashDraft(candidate.payload.draft))
        throw new Error('Operator correction patch does not reproduce the supplied draft');
    return result;
}
function isCurrentFailedPaper(paper, plan, factFeedbacks = new Map()) {
    const feedback = factFeedbacks.get(id(paper));
    if (feedback) {
        require('./daily-fact-review').validateFeedback(feedback, plan, paper);
        // A retained, previously successful Reader is not the result of a
        // later failed correction. Use the same bound-feedback completion
        // check as normal batch recovery, and require the actual failure.
        if (String(paper.latestAnalysisAttemptError || '').trim()
            && !String(feedback.primaryFeedback || '').trim()
            && !String(feedback.coreFeedback || '').trim()
            && !String(feedback.tagFeedback || '').trim()
            && !String(feedback.scoringFeedback || '').trim()
            && String(feedback.readerFeedback || '').trim()
            && !require('./completed-bound-fact-feedback').hasCompletedBoundFactFeedback(paper, feedback, plan)) return true;
    }
    return !require('../analysis-engine').isSuccessfulAnalysisRecord(paper)
        || !require('./daily-fresh-source-plan').isPaperReusableForAnalysis(paper,plan);
}
// The extension beyond ten is only for a small tail of a complete large batch.
// Read the original sealed manifest; a caller-selected subset cannot set N.
function largeBatchCorrectionLimit(plan, papers) {
    const daily = require('./daily-fresh-source-plan');
    const original = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference(plan));
    const expected = original.paperIds;
    const actual = Array.isArray(papers) ? papers.map(id) : [];
    if (!expected.length || new Set(expected).size !== expected.length
        || actual.length !== expected.length || new Set(actual).size !== actual.length
        || !isDeepStrictEqual(actual.slice().sort(), expected.slice().sort()))
        throw new Error('Large operator correction requires the complete original sealed batch');
    return Math.min(15, Math.max(10, Math.floor(expected.length / 10)));
}
// The normal entry must already have checked the complete actual plan/papers.
// This shared observation does not authenticate a caller-supplied JSON plan
// or grant source, Reader, request, or adoption capability.
function inspectDailyOperatorTail(plan, papers, factFeedbacks = new Map()) {
    if (!Array.isArray(papers) || papers.some(p => !p || typeof p !== 'object' || Array.isArray(p)))
        throw new Error('Operator correction requires the actual batch papers');
    const memberIds = papers.map(id);
    if (memberIds.some(value => !value) || new Set(memberIds).size !== memberIds.length)
        throw new Error('Operator correction batch contains missing or duplicate paper IDs');
    if (!(factFeedbacks instanceof Map)) throw new Error('Operator fact feedback must be a validated batch map');
    for (const [paperId, feedback] of factFeedbacks) {
        const paper = papers.find(p => id(p) === paperId);
        if (!paper || feedback?.paperId !== paperId) throw new Error('Operator fact feedback is outside the actual batch');
        require('./daily-fact-review').validateFeedback(feedback,plan,paper);
    }
    const failedIds = papers.filter(p => isCurrentFailedPaper(p, plan, factFeedbacks)).map(id).sort();
    const limit = failedIds.length > 10 ? largeBatchCorrectionLimit(plan, papers) : 10;
    if (failedIds.length > limit) throw new Error(`Operator correction exceeds the bounded final failed-set limit：失败集 ${failedIds.length} 篇超过本批人工修正上限 ${limit} 篇`);
    return { memberIds: memberIds.slice().sort(), failedIds, limit, feedbackCount: factFeedbacks.size };
}
function assertCompleteOperatorTail(tail, suppliedIds) {
    if (!Array.isArray(suppliedIds) || new Set(suppliedIds).size !== suppliedIds.length)
        throw new Error('修正清单包含重复论文（duplicate paper IDs）');
    if (!isDeepStrictEqual(suppliedIds.slice().sort(), tail.failedIds)) {
        const missing = tail.failedIds.filter(paperId => !suppliedIds.includes(paperId));
        const extra = suppliedIds.filter(paperId => !tail.failedIds.includes(paperId));
        throw new Error(`修正清单必须覆盖当前完整失败集（缺少 ${missing.join(', ') || '无'}；多余 ${extra.join(', ') || '无'}）`);
    }
}
async function withCorrections(filename, plan, papers, callback, { factFeedbacks = new Map() } = {}) {
    require('../env-loader').requireExternalRuntime('daily-reader-operator-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    const tail = inspectDailyOperatorTail(plan, papers, factFeedbacks);
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    within(filename,root); const manifest = read(filename), m = manifest.value;
    if (!codec.hasValidHeader(m, CONTRACT) || m.runId !== plan.runId || m.batchDate !== plan.batchDate
        || typeof m.authorization !== 'string' || !m.authorization.trim()
        || !Array.isArray(m.correctionFiles) || !m.correctionFiles.length)
        throw new Error('Explicit operator correction manifest is invalid');
    if (m.correctionFiles.length > tail.limit)
        throw new Error('Operator correction exceeds the bounded final failed-set limit');
    const records = new Map();
    for (const filename of m.correctionFiles) {
        within(filename,root); const file = read(filename), r = file.value, paperId = id(r);
        const paper = papers.find(p=>id(p)===paperId);
        if (!paper || records.has(paperId) || r.runId !== plan.runId || r.batchDate !== plan.batchDate
            || !tail.failedIds.includes(paperId))
            throw new Error('Operator correction must target a distinct failed paper in the actual batch');
        within(r.baselineCandidateFile,plan.readerAttemptsDir);
        if (path.dirname(path.resolve(r.baselineCandidateFile)) !== path.resolve(plan.readerAttemptsDir)
            || !/^[a-f0-9]{64}\.json$/.test(path.basename(r.baselineCandidateFile)))
            throw new Error('Operator baseline must be an active candidate in this daily run');
        const baseline = read(r.baselineCandidateFile), env = require('./reader-repair')
            .readFailedCandidateEnvelope(plan.readerAttemptsDir,null,r.baselineCandidateFile);
        if (!env || baseline.sha256 !== r.baselineCandidateEnvelopeSha256
            || id(env.envelope.identity)!==paperId || env.envelope.identity.freshAnalysis?.runId!==plan.runId
            || env.envelope.identity.freshAnalysis?.sourceOnly!==true)
            throw new Error('Operator correction baseline identity or original bytes differ');
        const source = require('./daily-fresh-source-plan').readDailyFreshSource(plan,paper);
        if (!isDeepStrictEqual(r.sourceDescriptor,source.freshSourceDescriptor)
            || env.envelope.identity.sourceSha256 !== source.freshSourceDescriptor.sourceSha256)
            throw new Error('Operator correction does not match all four official sealed sources');
        assertPaidFingerprintContext(r, env.envelope, paper, paper.analysisCheckpoint || paper.analysis);
        const draft = replay(r,env.envelope);
        records.set(paperId,{file,baseline,record:r,sourceDescriptor:source.freshSourceDescriptor,
            original:env.envelope,draft});
    }
    // Keep the original final fresh failed-set check after reading all files.
    assertCompleteOperatorTail(inspectDailyOperatorTail(plan, papers, factFeedbacks), [...records.keys()]);
    return scope.run({manifest,records},callback);
}
function hasActiveSourceOnlyCorrection(paper) {
    const active = scope.getStore(), selected = active?.records.get(id(paper));
    if (!selected || !require('../analysis-engine').paperAnalysisLockHeld(paper)) return false;
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!fresh.isDailyFreshSourceScope() || context?.runId !== selected.record.runId
        || !require('./reader-content-mode').is(selected.original.identity, 'source-only')) return false;
    unchanged(active.manifest); unchanged(selected.file); unchanged(selected.baseline);
    return true;
}
function current(paper, identity, readerInputAnalysis) {
    const active = scope.getStore(), record = active?.records.get(id(paper));
    if (!record) return null;
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope() || context.runId !== record.record.runId)
        throw new Error('Operator correction requires the actual daily source scope');
    unchanged(active.manifest); unchanged(record.file); unchanged(record.baseline);
    const source = fresh.readFreshSource(context.runDir,paper,context);
    if (!isDeepStrictEqual(source.freshSourceDescriptor,record.sourceDescriptor)
        || id(identity)!==id(paper) || identity.sourceSha256 !== source.freshSourceDescriptor.sourceSha256
        || ['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256',
            'sourceGeneration','sourceManifestSha256'].some(k=>identity.freshAnalysis?.[k]!==record.sourceDescriptor[k]))
        throw new Error('Operator correction current source or input changed');
    assertPaidFingerprintContext(record.record, record.original, paper, readerInputAnalysis, identity);
    const fingerprintRecovery = isPaidFingerprintRecord(record.record);
    if (fingerprintRecovery) {
        if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('Paid fingerprint replay requires the paper lock');
        replay(record.record, record.original);
    }
    const proof = { ...codec.recordHeader(PROOF, PROOF), executionKind:'operator',
        newReaderApiRequests:0,runId:context.runId,paperId:id(paper),batchDate:active.manifest.value.batchDate,
        authorization:active.manifest.value.authorization,manifestFile:active.manifest.file,
        manifestSha256:active.manifest.sha256,correctionFile:record.file.file,correctionSha256:record.file.sha256,
        originalCandidateFile:record.baseline.file,originalCandidateEnvelopeSha256:record.baseline.sha256,
        originalIdentitySha256:require('./reader-repair').hashDraft(record.original.identity),
        currentInputIdentitySha256:require('./reader-repair').hashDraft(identity),
        beforeDraftSha256:record.record.baselineDraftSha256,
        afterDraftSha256:require('./reader-repair').hashDraft(record.draft),
        sourceDescriptor:record.sourceDescriptor,retainedAttempts:record.original.payload.attempts,
        retainedFullAttempts:record.original.payload.fullAttempts,
        retainedNoProgress:record.original.payload.noProgress,appliedAt:new Date().toISOString() };
    // 原稿同时保留给 ordinal 来源衔接：活动候选仍是原稿，修正稿只作为本次解析输入。
    return { payload:{...structuredClone(record.original.payload),draft:structuredClone(record.draft),
        rawDraft:JSON.stringify(record.draft)},baselineDraft:structuredClone(record.original.payload.draft),proof };
}
function execution(proof) {
    return proof ? {executionKind:'operator',operatorProvenance:proof,newReaderApiRequests:0,
        model:'operator-local',protocol:'local_operator'} : {};
}
// A retained paid candidate is an on-disk hint even if a caller strips all
// operator JSON fields. It never grants completion or another request.
function hasRetainedOrdinalCandidate(paper, directory) {
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).some(name => {
        const checked = require('./reader-repair').readFailedCandidateEnvelope(directory, null, path.join(directory, name));
        const original = checked?.envelope;
        return id(original?.identity) === id(paper) && original.identity.sourceSha256 === paper.sourceSha256
            && original.identity.freshAnalysis?.runId === paper.freshRewriteProvenance?.runId
            && original.identity.freshAnalysis?.sourceOnly === true
            && original.payload.ordinalPatchCompilations?.length > 0;
    });
}
function fingerprintCompletionFile(paper, attempts) {
    const paperId = id(paper);
    if (!/^\d{4}\.\d{4,5}$/.test(paperId)) throw new Error('Invalid paid fingerprint completion paper ID');
    return path.join(attempts, 'paid-draft-fingerprint-completions', paperId + '.json');
}
function hasPaidFingerprintCompletion(paper, attempts) {
    try { fs.lstatSync(fingerprintCompletionFile(paper, attempts)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function fingerprintCompletion(paper, proof) {
    return { ...codec.recordHeader(PAID_FINGERPRINT_COMPLETION, PAID_FINGERPRINT_COMPLETION),
        paperId: id(paper), runId: proof.runId, sourceSha256: paper.sourceSha256,
        correctionSha256: proof.correctionSha256, candidateSha256: proof.originalCandidateEnvelopeSha256,
        inputIdentitySha256: proof.currentInputIdentitySha256,
        wholeSha256: sha(paper.analysisStageCheckpoints.apiReaderArticle),
        articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256 };
}
function sealPaidFingerprintCompletion(paper, readerInputAnalysis) {
    const active = scope.getStore()?.records.get(id(paper));
    if (!active || !isPaidFingerprintRecord(active.record)) return;
    const proof = paper.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance;
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper) || proof?.correctionSha256 !== active.file.sha256)
        throw new Error('Paid fingerprint completion requires the exact operator scope and lock');
    assertPaidFingerprintContext(active.record, active.original, paper, readerInputAnalysis);
    const checkpoints = paper.analysisStageCheckpoints || {};
    if (Object.hasOwn(checkpoints, 'apiReaderArticle') && checkpoints.apiReaderArticle !== readerInputAnalysis)
        throw new Error('Paid fingerprint completion cannot replace a different saved Reader input');
    paper.analysisStageCheckpoints = { ...checkpoints, apiReaderArticle: readerInputAnalysis };
    validateSavedCompletionUnchecked(paper, true);
    const file = fingerprintCompletionFile(paper, path.dirname(active.baseline.file));
    require('./publication-file-primitives').writeExact(file, JSON.stringify(fingerprintCompletion(paper, proof)) + '\n');
    validateSavedCompletion(paper);
}
function retainedPaidFingerprintInput(paper) {
    const proof = paper.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance;
    if (!hasOperatorProof(proof)) return null;
    if (!/^[a-f0-9-]{36}$/.test(proof.runId || '')) throw new Error('Invalid operator source run');
    const attempts = path.join(require('../config').FILES.dailyFreshSourceRunsDir, proof.runId, 'reader-attempts');
    if (!hasPaidFingerprintCompletion(paper, attempts)) return null;
    validateSavedCompletion(paper);
    return paper.analysisStageCheckpoints.apiReaderArticle;
}
// The paid ordinal compiler can leave complete-table declarations which
// ordinary source normalization expands before the active candidate is saved.
function matchesPaidOrdinalEndpoint(last, payload, record, paper, source) {
    const repair = require('./reader-repair');
    if (!last?.after || repair.hashDraft(payload.draft) !== record.baselineDraftSha256) return false;
    if (isDeepStrictEqual(last.after, payload.draft)) return true;
    const [mapping] = Array.isArray(payload.draftOrderMappings) ? payload.draftOrderMappings : [];
    if (payload.draftOrderMappings?.length !== 1 || !codec.hasValidHeader(mapping, 'reader-draft-order')
        || mapping.changed !== true || mapping.inputSha256 !== repair.hashDraft(last.after)
        || mapping.outputSha256 !== record.baselineDraftSha256
        || !Array.isArray(payload.imageEvidence)
        || sha(source.text) !== source.freshSourceDescriptor.sourceSha256
        || source.structuredArtifacts?.payloadSha256 !== source.freshSourceDescriptor.structuredArtifactsSha256)
        return false;
    const deep = require('../deep-analyzer');
    deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources, source.text);
    const ready = payload.imageEvidence.filter(image => image?.kind === 'figure' && image.status === 'ready');
    if (ready.some(image => !Number.isSafeInteger(image.ordinal) || image.ordinal < 1
        || !/^[a-f0-9]{64}$/.test(image.sha256 || '') || image.sourceSha256 !== image.sha256)
        || new Set(ready.map(image => image.ordinal)).size !== ready.length) return false;
    const state = {}, draftOrderMappings = [];
    try {
        deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(last.after), [], {
            paperId: paper.arxivId, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            pixelFigureOrdinals: ready.map(image => image.ordinal), draftOrderMappings
        }, state);
    } catch {
        return false;
    }
    return isDeepStrictEqual(state.draft, payload.draft)
        && isDeepStrictEqual(draftOrderMappings, payload.draftOrderMappings);
}
function validateSavedCompletion(paper) { return validateSavedCompletionUnchecked(paper, false); }
function validateSavedCompletionUnchecked(paper, sealingFingerprint) {
    const paperSha256 = require('./daily-fresh-source-plan').stableHash(paper);
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle, proof = stage?.operatorProvenance;
    const fail = message => { throw new Error(`Daily operator completion refused: ${message}`); };
    if (stage?.status !== 'complete' || stage.executionKind !== 'operator' || stage.model !== 'operator-local'
        || stage.protocol !== 'local_operator' || stage.newReaderApiRequests !== 0
        || !hasOperatorProof(proof) || proof.executionKind !== 'operator'
        || proof.newReaderApiRequests !== 0 || proof.paperId !== id(paper)
        || !/^[a-f0-9]{64}$/.test(proof.currentInputIdentitySha256 || '')) fail('actual local execution/provenance missing');
    const daily = require('./daily-fresh-source-plan'), fresh = require('./fresh-analysis-context');
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, proof.runId || '');
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(proof.runId || '')) fail('daily run differs');
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    const snapshots = [];
    const take = (file, digest) => { within(file, root); const snapshot = read(file);
        if (snapshot.sha256 !== digest) fail('original file SHA differs'); snapshots.push(snapshot); return snapshot.value; };
    const run = read(path.join(runDir, 'run.json'));
    snapshots.push(run);
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run.value, runDir }));
    if (proof.runId !== plan.runId || proof.batchDate !== plan.batchDate || !daily.isPaperBoundToPlan(paper, plan)) fail('actual daily plan differs');
    const manifest = take(proof.manifestFile, proof.manifestSha256);
    const record = take(proof.correctionFile, proof.correctionSha256);
    if (!codec.hasValidHeader(manifest, CONTRACT) || manifest.runId !== plan.runId || manifest.batchDate !== plan.batchDate
        || typeof manifest.authorization !== 'string' || !manifest.authorization.trim() || manifest.authorization !== proof.authorization
        || !Array.isArray(manifest.correctionFiles) || !manifest.correctionFiles.length || manifest.correctionFiles.length > 15
        || new Set(manifest.correctionFiles.map(file => path.resolve(file))).size !== manifest.correctionFiles.length
        || !manifest.correctionFiles.some(file => path.resolve(file) === path.resolve(proof.correctionFile))
        || record.runId !== plan.runId || record.batchDate !== plan.batchDate || id(record) !== id(paper)
        || record.baselineCandidateFile !== proof.originalCandidateFile
        || record.baselineCandidateEnvelopeSha256 !== proof.originalCandidateEnvelopeSha256
        || record.baselineDraftSha256 !== proof.beforeDraftSha256) fail('original manifest/member/patch binding differs');
    within(record.baselineCandidateFile, plan.readerAttemptsDir);
    if (path.dirname(path.resolve(record.baselineCandidateFile)) !== path.resolve(plan.readerAttemptsDir)
        || !/^[a-f0-9]{64}\.json$/.test(path.basename(record.baselineCandidateFile))) fail('original active candidate path differs');
    const original = take(record.baselineCandidateFile, record.baselineCandidateEnvelopeSha256);
    const checked = require('./reader-repair').readFailedCandidateEnvelope(plan.readerAttemptsDir, null, record.baselineCandidateFile);
    if (!checked || !isDeepStrictEqual(checked.envelope, original)
        || require('./reader-repair').hashDraft(original.identity) !== proof.originalIdentitySha256
        || id(original.identity) !== id(paper) || original.identity.freshAnalysis?.sourceOnly !== true) fail('paid candidate identity differs');
    const source = daily.readDailyFreshSource(plan, paper), descriptor = source.freshSourceDescriptor;
    if (!isDeepStrictEqual(record.sourceDescriptor, descriptor) || !isDeepStrictEqual(proof.sourceDescriptor, descriptor)
        || original.identity.sourceSha256 !== descriptor.sourceSha256
        || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
            .some(key => original.identity.freshAnalysis?.[key] !== descriptor[key])) fail('four sealed sources differ');
    const payload = original.payload, repair = require('./reader-repair');
    for (const [key, field] of [['attempts', 'retainedAttempts'], ['fullAttempts', 'retainedFullAttempts'], ['noProgress', 'retainedNoProgress']]) {
        if (!Number.isSafeInteger(payload[key]) || payload[key] < 0 || payload[key] !== proof[field]) fail('retained counters differ');
    }
    if (stage.attempts !== payload.attempts || (stage.fullAttempts !== undefined && stage.fullAttempts !== payload.fullAttempts)
        || (stage.transportFailures || 0) !== (payload.transportFailures || 0)
        || stage.imageEvidenceSha256 !== daily.stableHash(payload.imageEvidence)
        || stage.modelImagePreflightEvidenceSha256 !== repair.hashDraft(payload.ephemeralImageEvidence)) fail('paid request/image ledger differs');
    const records = payload.ordinalPatchCompilations || [], history = stage.ordinalPatchHistory;
    if (records.length && (!require('./protocol-codec').hasValidHeader(history, 'reader-ordinal-history')
        || history.reason !== 'operator-correction-supersedes-ordinal-completion'
        || !isDeepStrictEqual(history.compilations, records))) fail('original ordinal compilation history differs');
    if (isPaidFingerprintRecord(record)) {
        assertPaidFingerprintContext(record, original, paper, paper.analysisStageCheckpoints?.apiReaderArticle);
        if (!sealingFingerprint) {
            const file = fingerprintCompletionFile(paper, plan.readerAttemptsDir);
            within(file, plan.readerAttemptsDir);
            const completion = read(file);
            if (!codec.hasValidHeader(completion.value, PAID_FINGERPRINT_COMPLETION)
                || !isDeepStrictEqual(completion.value, fingerprintCompletion(paper, proof))) fail('durable fingerprint completion differs');
            snapshots.push(completion);
        }
        if (repair.hashDraft(record.currentInputIdentity) !== proof.currentInputIdentitySha256) fail('paid header input identity differs');
    }
    const draft = replay(record, original);
    if (repair.hashDraft(draft) !== proof.afterDraftSha256) fail('bounded patch endpoint differs');
    require('./analysis-stop-control').withModelRequestsForbidden(() => daily.withDailyFreshAnalysisContext(plan,
        () => fresh.withFreshPaperContext(paper, () => {
            let lastPaid;
            for (const entry of records) lastPaid = require('./reader-target-ordinal-patch').replay({ paper, identity: entry.identity,
                directory: plan.readerAttemptsDir, requestId: entry.requestId, pins: entry.pins });
            const deep = require('../deep-analyzer');
            if (records.length && !matchesPaidOrdinalEndpoint(lastPaid, payload, record, paper, source))
                fail('last paid compilation differs from the original candidate');
            const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
                arxivId: paper.arxivId, ...require('./reader-record-format').compilationOptionsForSavedPlan(paper.apiReaderPlan),
                requireIntegratedTables: true, minimumIntegratedTables: 2,
                requireSourceBindings: true, allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
                enforceResourceAvailabilityClaims: true, verifiedResourceIdentity: paper.apiReaderResources,
                sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                availableFigureOrdinals: payload.imageEvidence.filter(image => image.kind === 'figure' && image.status === 'ready').map(image => image.ordinal)
            });
            for (const figure of paper.apiReaderFigures || []) {
                const image = payload.imageEvidence.find(item => item.kind === 'figure' && item.status === 'ready' && item.ordinal === figure.ordinal);
                if (!image || image.url !== figure.url || image.sha256 !== figure.assetSha256 || image.sourceSha256 !== image.sha256) fail('paid figure/source bytes differ');
            }
            const final = deep.replayApiReaderFinalDisplay(parsed, source, paper.apiReaderFigures, paper.arxivId);
            if (final.article !== paper.apiReaderArticle || !isDeepStrictEqual(final.plan, paper.apiReaderPlan)
                || !isDeepStrictEqual(final.figures, paper.apiReaderFigures)
                || sha(final.article) !== paper.apiReaderArticleSha256 || daily.stableHash(final.plan) !== paper.apiReaderPlanSha256
                || stage.articleSha256 !== paper.apiReaderArticleSha256 || stage.planSha256 !== paper.apiReaderPlanSha256
                || stage.figuresSha256 !== daily.stableHash(paper.apiReaderFigures)) fail('normal parser/final article/plan/figures differ');
        })));
    for (const snapshot of snapshots) unchanged(snapshot);
    if (!isDeepStrictEqual(source, daily.readDailyFreshSource(plan, paper))) fail('sealed source changed during replay');
    if (daily.stableHash(paper) !== paperSha256) fail('paper/stage changed during read-only replay');
    return true;
}
module.exports={CONTRACT,hasOperatorProof,hasOperatorProofMarker,withCorrections,hasActiveSourceOnlyCorrection,current,execution,replay,hasRetainedOrdinalCandidate,hasPaidFingerprintCompletion,sealPaidFingerprintCompletion,retainedPaidFingerprintInput,validateSavedCompletion,isCurrentFailedPaper,largeBatchCorrectionLimit,
    inspectDailyOperatorTail,assertCompleteOperatorTail};
