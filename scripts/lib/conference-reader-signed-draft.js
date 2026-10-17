'use strict';
// Read-only inspection of an actual sealed conference Reader. Representation
// recovery is not API authorship, operator approval or publication qualification.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const adapter = require('./conference-analysis-adapter');
const surface = require('./reader-signed-draft-surface');
const repair = require('./reader-repair');
const {stableHash} = require('./fresh-rewrite-run');
const fail = message => { throw Object.assign(new Error('会议旧签Reader逆算拒绝：' + message), {
    code:'CONFERENCE_SIGNED_READER_INTEGRITY', category:'integrity', scope:'run', retryable:false }); };
function surfaceDifferences(before, after, location = '') {
    if (isDeepStrictEqual(before,after)) return [];
    if (typeof before === 'string' && typeof after === 'string') return [{path:location,before,after,
        beforeSha256:repair.shaText(before),afterSha256:repair.shaText(after)}];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
        || Array.isArray(before) !== Array.isArray(after)
        || !isDeepStrictEqual(Object.keys(before).sort(),Object.keys(after).sort()))
        return [{path:location,structural:true,beforeSha256:repair.hashDraft(before ?? null),afterSha256:repair.hashDraft(after ?? null)}];
    return Object.keys(before).flatMap(key => surfaceDifferences(before[key],after[key],location+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1')));
}
function classifySurfaceReplay(paper, replayed) {
    const differences = surfaceDifferences({article:paper.apiReaderArticle,plan:paper.apiReaderPlan,figures:paper.apiReaderFigures},replayed.roundtrip);
    if (!differences.length) return {status:'exact',differences};
    const normalize = require('../deep-analyzer').normalizeReaderProseFormatting;
    const formattingOnly = differences.every(delta => !delta.structural
        && /^\/(?:article$|plan\/(?:readerTitle$|oneSentenceThesis$|sections\/\d+\/heading$|conceptBridges\/\d+\/(?:explanation$|terms\/\d+$)))/u.test(delta.path)
        && normalize(delta.before) === delta.after);
    return {status:formattingOnly ? 'normalization-only' : 'blocked',differences,
        ...(formattingOnly ? {} : {reason:'正常往返存在非纯格式的正文、结构或来源绑定差异'})};
}
function inspectConferenceSignedReader({analysisRoot,executionId,planHandle,sourceRoot}) {
    let loaded = adapter.loadConferenceAnalysis({analysisRoot,executionId});
    const revisionFile = path.join(loaded.directory,'reader-revision.json');
    if (fs.existsSync(revisionFile)) {
        const revision = adapter.readJsonRecord(revisionFile).value;
        loaded = revision.contract === 'conference-reader-recovery-window-v1'
            ? adapter.loadGrantedConferenceRecovery({analysisRoot,executionId})
            : adapter.loadConferenceReaderRevision({analysisRoot,executionId});
    }
    if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete') fail('只可读取真实原完整包');
    const paper = loaded.analysis.papers[0], stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (!paper || paper.id !== loaded.run.paperId || paper.arxivId || paper.paper_id
        || paper.sourceSha256 !== repair.shaText(loaded.source.sourceDetails.text)
        || stage?.status !== 'complete' || stage.executionKind === 'operator' || stage.model === 'operator-local'
        || !Array.isArray(paper.apiReaderFigures)
        || repair.shaText(paper.apiReaderArticle) !== paper.apiReaderArticleSha256
        || stage.articleSha256 !== paper.apiReaderArticleSha256
        || stableHash(paper.apiReaderPlan) !== paper.apiReaderPlanSha256
        || stage.planSha256 !== paper.apiReaderPlanSha256
        || stage.figuresSha256 !== stableHash(paper.apiReaderFigures)) fail('原签Reader输出或会议来源SHA不完整');
    const pdf = adapter.verifyPlanAuthority(loaded,planHandle,sourceRoot), provider = require('./conference-source-context').readerPdfSourceForContext(pdf);
    const original = {analysisFileSha256:loaded.analysisFileSha256,runFileSha256:loaded.runFileSha256,sourceFileSha256:loaded.sourceFileSha256};
    const assertUnchanged = () => {
        const current = adapter.loadConferenceAnalysis({analysisRoot,executionId});
        for (const [key,value] of Object.entries(original)) if (current[key] !== value) fail('原完整包/来源字节已变化');
        provider.assertUnchanged();
    };
    const options = {paperId:paper.id,executionId,executionDir:loaded.directory,readerPdfSourceHandle:pdf};
    const inspect = () => require('./analysis-stop-control').withModelRequestsForbidden(() => {
        assertUnchanged();
        let draft, result;
        try {
            const recovered = surface.reconstructReaderDraftSurface({paper,paperId:paper.id}); draft = recovered.draft;
            const policy = require('./conference-analysis-context').conferenceWeakReaderCapabilityPolicy(paper,loaded.source.sourceDetails.structuredArtifacts);
            const replayed = surface.replayReaderDraftSurface({paper,paperId:paper.id,sourceDetails:loaded.source.sourceDetails,
                parserOptions:{readerCapabilityPolicy:policy,verifiedResourceIdentity:paper.apiReaderResources,
                    enforceResourceAvailabilityClaims:true}});
            const classification = classifySurfaceReplay(paper,replayed);
            const afterDraft = surface.reconstructReaderDraftSurface({paper:{...paper,
                apiReaderArticle:replayed.roundtrip.article,apiReaderPlan:replayed.roundtrip.plan,
                apiReaderFigures:replayed.roundtrip.figures},paperId:paper.id}).draft;
            result = {...classification,nodeDifferences:surfaceDifferences(recovered.draft,afterDraft),surface:{articleSha256:recovered.articleSha256,
                planSha256:recovered.planSha256,figuresSha256:recovered.figuresSha256,draftSha256:recovered.draftSha256},
                replaySurface:{articleSha256:replayed.replayArticleSha256,planSha256:replayed.replayPlanSha256,figuresSha256:replayed.replayFiguresSha256}};
        } catch (error) { result = {status:'blocked',reason:String(error.message),code:error.code || null}; }
        assertUnchanged();
        return {...result,draft,paperId:paper.id,executionId,...original,sourceSha256:paper.sourceSha256,
            sourceSnapshotSha256:loaded.run.sourceSnapshotSha256,
            sourceIdentity:structuredClone(require('./conference-source-context').readerPdfSourceForContext(pdf).sourceIdentity),
            apiGenerated:false,newModelRequests:0,newNetworkRequests:0,assertUnchanged};
    });
    return require('./conference-analysis-context').withConferenceAnalysisSource({...options,
        sourceDetails:loaded.source.sourceDetails,readerRetryEpoch:1},() => loaded.recoveryWindow
        ? require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(loaded.recoveryWindow.grantHandle,options,inspect)
        : inspect());
}
module.exports = {inspectConferenceSignedReader,classifySurfaceReplay,surfaceDifferences};
