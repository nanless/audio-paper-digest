'use strict';
// Explicit local corrections are not model responses or new request allowances.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage();
const CONTRACT = 'daily-reader-operator-correction-batch-v1';
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
function replay(record, candidate) {
    const repair = require('./reader-repair');
    if (record.contract !== 'reader-human-source-edit-v1' || record.notLlmResponse !== true
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
    if (m.contract !== CONTRACT || m.runId !== plan.runId || m.batchDate !== plan.batchDate
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
        const draft = replay(r,env.envelope);
        records.set(paperId,{file,baseline,record:r,sourceDescriptor:source.freshSourceDescriptor,
            original:env.envelope,draft});
    }
    // Keep the original final fresh failed-set check after reading all files.
    assertCompleteOperatorTail(inspectDailyOperatorTail(plan, papers, factFeedbacks), [...records.keys()]);
    return scope.run({manifest,records},callback);
}
function current(paper, identity) {
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
    const proof = { contract:'daily-reader-operator-correction-v1',executionKind:'operator',
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
function validateSavedCompletion(paper) {
    const paperSha256 = require('./daily-fresh-source-plan').stableHash(paper);
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle, proof = stage?.operatorProvenance;
    const fail = message => { throw new Error(`Daily operator completion refused: ${message}`); };
    if (stage?.status !== 'complete' || stage.executionKind !== 'operator' || stage.model !== 'operator-local'
        || stage.protocol !== 'local_operator' || stage.newReaderApiRequests !== 0
        || proof?.contract !== 'daily-reader-operator-correction-v1' || proof.executionKind !== 'operator'
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
    if (manifest.contract !== CONTRACT || manifest.runId !== plan.runId || manifest.batchDate !== plan.batchDate
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
    const draft = replay(record, original);
    if (repair.hashDraft(draft) !== proof.afterDraftSha256) fail('bounded patch endpoint differs');
    require('./analysis-stop-control').withModelRequestsForbidden(() => daily.withDailyFreshAnalysisContext(plan,
        () => fresh.withFreshPaperContext(paper, () => {
            let lastPaid;
            for (const entry of records) lastPaid = require('./reader-target-ordinal-patch').replay({ paper, identity: entry.identity,
                directory: plan.readerAttemptsDir, requestId: entry.requestId, pins: entry.pins });
            const deep = require('../deep-analyzer');
            if (records.length && (!lastPaid || !isDeepStrictEqual(lastPaid.after, payload.draft)
                || repair.hashDraft(lastPaid.after) !== record.baselineDraftSha256)) fail('last paid compilation differs from the original candidate');
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
module.exports={CONTRACT,withCorrections,current,execution,replay,hasRetainedOrdinalCandidate,validateSavedCompletion,isCurrentFailedPaper,largeBatchCorrectionLimit,
    inspectDailyOperatorTail,assertCompleteOperatorTail};
