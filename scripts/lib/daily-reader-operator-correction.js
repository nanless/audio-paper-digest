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
async function withCorrections(filename, plan, papers, callback, { factFeedbacks = new Map() } = {}) {
    require('../env-loader').requireExternalRuntime('daily-reader-operator-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    if (!(factFeedbacks instanceof Map)) throw new Error('Operator fact feedback must be a validated batch map');
    for (const [paperId, feedback] of factFeedbacks) {
        const paper = papers.find(p => id(p) === paperId);
        if (!paper || feedback?.paperId !== paperId) throw new Error('Operator fact feedback is outside the actual batch');
        require('./daily-fact-review').validateFeedback(feedback,plan,paper);
    }
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    within(filename,root); const manifest = read(filename), m = manifest.value;
    if (m.contract !== CONTRACT || m.runId !== plan.runId || m.batchDate !== plan.batchDate
        || typeof m.authorization !== 'string' || !m.authorization.trim()
        || !Array.isArray(m.correctionFiles) || !m.correctionFiles.length || m.correctionFiles.length > 10)
        throw new Error('Explicit operator correction manifest is invalid');
    const records = new Map();
    for (const filename of m.correctionFiles) {
        within(filename,root); const file = read(filename), r = file.value, paperId = id(r);
        const paper = papers.find(p=>id(p)===paperId);
        if (!paper || records.has(paperId) || r.runId !== plan.runId || r.batchDate !== plan.batchDate
            || !isCurrentFailedPaper(paper,plan,factFeedbacks))
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
    const failed = papers.filter(p=>isCurrentFailedPaper(p,plan,factFeedbacks)).map(id).sort();
    if (!isDeepStrictEqual([...records.keys()].sort(),failed))
        throw new Error('Operator correction manifest must cover the complete current failed set');
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
    return { payload:{...structuredClone(record.original.payload),draft:structuredClone(record.draft),
        rawDraft:JSON.stringify(record.draft)},proof };
}
function execution(proof) {
    return proof ? {executionKind:'operator',operatorProvenance:proof,newReaderApiRequests:0,
        model:'operator-local',protocol:'local_operator'} : {};
}
module.exports={CONTRACT,withCorrections,current,execution,replay,isCurrentFailedPaper};
