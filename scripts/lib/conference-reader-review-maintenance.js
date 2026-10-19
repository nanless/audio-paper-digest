'use strict';
// Normal Reader maintenance for a complete, source-bound conference batch.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const evidence = require('./conference-reader-review-maintenance-evidence');
const { sha, stable } = evidence;
const opaque = new WeakMap();
const windowHandles = new WeakMap();
const savedCompletionHandles = new WeakMap();
const publicationHistoryHandles = new WeakMap();
const parentReaderSeedHandles = new WeakMap();
const scientificParentReplayHandles = new WeakMap();
const legacyParentReferenceScope = new (require('node:async_hooks').AsyncLocalStorage)();
const evidenceCache = new Map();
const verifiedAdoptedChildIdentities = new WeakMap();
const validatedMetadata = new WeakMap();
const sourceLineageBatches = new Map();
const MAX_SOURCE_LINEAGE_BATCHES = 8;
const verifiedCanonicalReviewEvidence = new WeakMap();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const adapter = () => require('./conference-analysis-adapter');
const api = () => require('./conference-process');
function fail(message) { throw Object.assign(new Error('Text maintenance: '+message), {
    code:'CONFERENCE_READER_REVIEW_MAINTENANCE_INTEGRITY',scope:'run',retryable:false }); }
function check(value,message) { if(!value) fail(message); }
function privateFile(filename,requirePrivateMode=true) {
    const absolute=path.resolve(filename);let cursor=path.parse(absolute).root;
    for(const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor=path.join(cursor,part);const st=fs.lstatSync(cursor);
        check(!st.isSymbolicLink(),'symlink component');
        if(cursor!==absolute)check(st.isDirectory(),'non-directory component');
        else check(st.isFile()&&st.nlink===1&&(!requirePrivateMode||(st.mode&0o777)===0o600),'private single-link file required');
    }
    return absolute;
}
function read(filename) { privateFile(filename);return adapter().readJsonRecord(filename); }
function privateFileSha256(filename,requirePrivateMode=true) {
    privateFile(filename,requirePrivateMode);
    const allowedMode=mode=>requirePrivateMode?mode===0o600:[0o600,0o644].includes(mode);
    const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
        const stat=fs.fstatSync(fd);
        check(stat.isFile()&&stat.nlink===1&&allowedMode(stat.mode&0o777)&&stat.size<=64*1024*1024,'private bounded file required');
        const bytes=fs.readFileSync(fd),named=fs.lstatSync(filename);
        check(bytes.length===stat.size&&named.isFile()&&!named.isSymbolicLink()&&named.nlink===1
            &&allowedMode(named.mode&0o777)&&(named.mode&0o777)===(stat.mode&0o777)&&named.dev===stat.dev&&named.ino===stat.ino&&named.size===stat.size,
            'private file changed while reading');
        return sha(bytes);
    } finally {fs.closeSync(fd);}
}
// Only fixed metadata slots are retained per private batch, never old versions.
function freezeMetadata(value) {
    if(value&&typeof value==='object'&&!Object.isFrozen(value)) {
        for(const child of Object.values(value))freezeMetadata(child);Object.freeze(value);
    }
    return value;
}
function metadataCache(batch) {
    let cached=validatedMetadata.get(batch);
    const matches=cached&&cached.manifest===batch.m&&cached.baseline===batch.baseline.value
        &&cached.manifestFileSha256===batch.manifestFileSha256&&cached.baselineSha256===batch.baseline.sha256;
    if(!matches) {
        freezeMetadata(batch.m);freezeMetadata(batch.baseline.value);
        cached={manifest:batch.m,baseline:batch.baseline.value,manifestFileSha256:batch.manifestFileSha256,
            baselineSha256:batch.baseline.sha256,records:new Map(),registration:null};
        validatedMetadata.set(batch,cached);
    }
    return cached;
}
function validatedMetadataRecord(batch,slot,filename,validate) {
    check(['state','after','adoption'].includes(slot),'fixed metadata cache slot');
    const actual=privateFileSha256(filename),cache=metadataCache(batch),previous=cache.records.get(slot);
    if(previous?.filename===filename&&previous.record.sha256===actual)return previous.record;
    const record=read(filename);check(record.sha256===actual,'metadata changed during validation');validate(record.value);
    const immutable=Object.freeze({value:freezeMetadata(record.value),sha256:record.sha256});
    cache.records.set(slot,{filename,record:immutable});return immutable;
}
function exact(filename,value) { adapter().writeBytesAtomic(filename,Buffer.from(JSON.stringify(value,null,2)+'\n')); }
function self(value,key) {const copy=structuredClone(value);delete copy[key];check(stable(copy)===value[key],key+' mismatch');}
function paths(processDirectory,batchId) {
    check(UUID.test(path.basename(processDirectory))&&UUID.test(batchId),'process/batch identity');
    const root=path.join(processDirectory,'review-reader-maintenance',batchId);
    return {root,manifest:path.join(root,'manifest.json'),progress:path.join(root,'progress.json'),
        adoption:path.join(root,'adoption.json'),after:path.join(root,'adoption-after-state.json'),
        state:path.join(processDirectory,'state.json')};
}
function obligation(batch) {return {batchId:batch.m.batchId,manifestSha256:batch.m.manifestSha256,
    manifestFileSha256:batch.manifestFileSha256};}
function registeredState(batch) {
    const stateFile=path.join(batch.p.root,'registered-state.json'),registrationFile=path.join(batch.p.root,'registration.json');
    const stateSha256=privateFileSha256(stateFile),registrationSha256=privateFileSha256(registrationFile),cache=metadataCache(batch);
    if(cache.registration?.stateSha256===stateSha256&&cache.registration.registrationSha256===registrationSha256)
        return cache.registration.record;
    const state=read(stateFile);check(state.sha256===stateSha256,'registered state changed during validation');
    const registrationRecord=read(registrationFile);check(registrationRecord.sha256===registrationSha256,'registration changed during validation');
    const registration=registrationRecord.value;self(registration,'registrationSha256');
    check(registration.contract==='conference-reader-review-maintenance-registration-v1'
        &&registration.manifestSha256===batch.m.manifestSha256&&registration.manifestFileSha256===batch.manifestFileSha256
        &&registration.baselineStateFileSha256===batch.baseline.sha256&&registration.registeredStateFileSha256===state.sha256,'pending registration CAS');
    const expected=structuredClone(batch.baseline.value);
    expected.readerReviewMaintenanceObligations=[...(expected.readerReviewMaintenanceObligations||[]),obligation(batch)];
    expected.generation++;expected.updatedAt=state.value.updatedAt;expected.stateSha256=api().stateDigest(expected);
    check(same(expected,state.value),'registration changed original complete history');api().assertState(state.value);
    const record=Object.freeze({value:freezeMetadata(state.value),sha256:state.sha256});
    cache.registration={stateSha256,registrationSha256,record};return record;
}
function registerPendingObligation(batch,now) {
    const current=read(batch.p.state);
    if(fs.existsSync(path.join(batch.p.root,'registration.json'))) {
        const registered=registeredState(batch);
        if(current.sha256===batch.baseline.sha256)adapter().replaceJson(batch.p.state,registered.value,current.sha256);
        assertCurrentBatch(batch);return;
    }
    check(current.sha256===batch.baseline.sha256,'new maintenance must bind actual original complete state');
    const value=structuredClone(current.value);
    for(const prior of value.readerReviewMaintenanceObligations||[]) {
        check(UUID.test(prior.batchId)&&SHA.test(prior.manifestSha256)&&SHA.test(prior.manifestFileSha256),'prior obligation identity');
        const p=paths(batch.processDirectory,prior.batchId),previous=loadBatch({manifestPath:p.manifest,
            processDirectory:batch.processDirectory,analysisRoot:batch.analysisRoot});
        check(fs.existsSync(p.adoption)&&read(p.state).sha256!==registeredState(previous).sha256,
            'another maintenance batch is still pending');
        assertCurrentBatch(previous);
    }
    check(!(value.readerReviewMaintenanceObligations||[]).some(row=>row.batchId===batch.m.batchId),'duplicate pending batch');
    value.readerReviewMaintenanceObligations=[...(value.readerReviewMaintenanceObligations||[]),obligation(batch)];
    value.generation++;value.updatedAt=fs.existsSync(path.join(batch.p.root,'registered-state.json'))
        ?read(path.join(batch.p.root,'registered-state.json')).value.updatedAt:now();
    value.stateSha256=api().stateDigest(value);api().assertState(value);
    exact(path.join(batch.p.root,'registered-state.json'),value);
    const body={contract:'conference-reader-review-maintenance-registration-v1',manifestSha256:batch.m.manifestSha256,
        manifestFileSha256:batch.manifestFileSha256,baselineStateFileSha256:batch.baseline.sha256,
        registeredStateFileSha256:read(path.join(batch.p.root,'registered-state.json')).sha256};
    exact(path.join(batch.p.root,'registration.json'),{...body,registrationSha256:stable(body)});
    adapter().replaceJson(batch.p.state,value,current.sha256);
}
function protectedScience(paper) {
    const stages=structuredClone(paper.analysisManifest?.stages||{});
    const checkpoints=structuredClone(paper.analysisStageCheckpoints||{});
    delete stages.apiReaderArticle;delete stages.imageSupplement;delete stages.openSourceScan;delete checkpoints.apiReaderArticle;
    return {analysis:paper.analysis,analysisCheckpoint:paper.analysisCheckpoint,parsed:paper.parsed,
        scoringAudit:paper.scoringAudit,sourceSha256:paper.sourceSha256,stages,checkpoints};
}
// A private read-only view of the one neutral resource projection. This does
// not complete/save a Reader or authenticate model output; the caller must still
// bind real paid issuance and pass all normal source/Reader/whole-paper gates.
function neutralReaderUpstreamView(parent,paper,resources) {
    if(same(protectedScience(paper),protectedScience(parent)))return {paper:structuredClone(paper),projection:null};
    check(same(resources,parent.apiReaderResources)&&same(resources,paper.apiReaderResources),'saved neutral resource identity changed');
    check(same(parent.analysisStageCheckpoints,paper.analysisStageCheckpoints)
        &&parent.analysisCheckpoint===paper.analysisCheckpoint,'saved neutral projection changed checkpoints');
    const before=sha(parent.analysis),expected=structuredClone(parent);
    const score=expected.analysisManifest?.stages?.scoringAudit;
    check(score?.status==='complete'&&score.outputAnalysisSha256===before,'saved neutral projection requires exact direct scoring output');
    expected.analysis=require('../deep-analyzer').applyApiReaderResourceAvailability(parent.analysis,resources);
    const after=sha(expected.analysis);
    check(before!==after,'saved upstream difference is not a resource projection');
    expected.parsed=require('../utils').parseAnalysis(expected.analysis);
    score.outputAnalysisSha256=after;
    score.resourceAvailabilitySynchronizations=[...(score.resourceAvailabilitySynchronizations||[]),{
        contract:'reader-resource-availability-sync-v1',executionKind:'deterministic_resource_projection',
        sourceSha256:parent.sourceSha256,resourceIdentitySha256:resources.identitySha256,
        beforeAnalysisSha256:before,afterAnalysisSha256:after,originalScoringOutputAnalysisSha256:before,
        checkpointChanges:[],newApiRequests:0}];
    check(same(protectedScience(expected),protectedScience(paper)),'saved upstream is not exact neutral resource projection');
    const restored=structuredClone(paper);
    restored.analysis=parent.analysis;restored.parsed=structuredClone(parent.parsed);
    restored.analysisManifest.stages.scoringAudit=structuredClone(parent.analysisManifest.stages.scoringAudit);
    check(same(protectedScience(restored),protectedScience(parent)),'saved neutral private view failed exact parent protection');
    return {paper:restored,projection:{contract:'conference-reader-neutral-resource-upstream-view-v1',
        beforeAnalysisSha256:after,afterAnalysisSha256:before,
        savedProtectedScienceSha256:stable(protectedScience(paper)),
        parentProtectedScienceSha256:stable(protectedScience(parent)),resourceIdentitySha256:resources.identitySha256}};
}
function replaySavedNeutralReaderUpstream(loaded) {
    const source=require('./conference-analysis-context').getConferenceAnalysisContext();
    check(source?.executionId===loaded.run.executionId&&source.paperId===loaded.run.paperId
        &&source.executionDir===loaded.directory&&source.readerPdfSourceHandle
        &&sha(source.sourceDetails.text)===loaded.analysis.papers[0].sourceSha256,'saved Reader requires actual current PDF source scope');
    check(loaded.analysis.status==='partial'&&loaded.revision.mode==='reader-only'
        &&loaded.revision.readerReviewMaintenance,'saved Reader requires actual partial maintenance revision');
    const current=read(path.join(loaded.directory,'analysis.json'));
    check(current.sha256===loaded.analysisFileSha256&&same(current.value,loaded.analysis),'saved Reader raw partial CAS changed');
    const bound=replayRevisionFeedback(loaded),paper=loaded.analysis.papers[0],stage=paper.analysisManifest?.stages?.apiReaderArticle;
    check(stage?.status==='complete'&&stage.contentMode==='reader-source-signed-revision-v1'
        &&stage.reviewFeedbackSha256===bound.locator.reviewFeedbackSha256,'saved signed Reader feedback stage changed');
    const result=neutralReaderUpstreamView(loaded.parent.analysis.papers[0],paper,loaded.resourcePreflight);
    if(result.projection) {
        const last=loaded.analysis.readerRevisionProgress?.failures?.at(-1);
        check(last?.code==='CONFERENCE_READER_REVIEW_MAINTENANCE_INTEGRITY'
            &&last.message==='Text maintenance: protected scientific upstream changed','saved neutral view requires the actual protected-upstream failure');
        result.projection={...result.projection,executionId:loaded.run.executionId,
            originalPartialAnalysisFileSha256:loaded.analysisFileSha256,parentAnalysisFileSha256:loaded.parent.analysisFileSha256,
            sourceFileSha256:loaded.sourceFileSha256,resourcePreflightFileSha256:loaded.revision.resourcePreflightFileSha256,
            savedReaderStageSha256:stable(stage),newApiRequests:0};
    }
    return result;
}

function firstInheritedOneImageReaderSuccess(loaded,stage) {
    const progress=loaded.analysis.readerRevisionProgress,failures=progress?.failures,first=failures?.[0];
    if(first?.message!=='保留 Reader 上游需要原评分与当前 Reader 的完整绑定仍然有效。')return false;
    check(Number.isSafeInteger(progress.attempts)&&progress.attempts>=1&&progress.attempts<=3
        &&Array.isArray(failures)&&failures.length===progress.attempts
        &&failures.every((failure,index)=>failure.systemic!==true&&failure.category==='paper'
            &&Number.isFinite(Date.parse(failure.at))&&Date.parse(failure.at)>=Date.parse(index?failures[index-1].at:stage.refreshedAt)),
        'saved inherited Reader needs exact unchanged normal outer failure history');
    const parent=loaded.parent.analysis.papers[0];
    check(parent.conferenceSourceCorrection?.contract==='conference-source-core-correction-v1'
        &&parent.conferenceSourceCorrection.executionId===loaded.parent.run.executionId
        &&stage.figureCount===1&&stage.imageEvidenceCount===1
        &&SHA.test(stage.imageEvidenceSha256)&&SHA.test(stage.modelImagePreflightEvidenceSha256)
        &&stage.providerImageExclusionCount===0
        &&same(stage.providerImageExclusions,[])&&loaded.analysis.papers[0].apiReaderFigures?.length===1,
        'saved inherited Reader only supports one actual nonexcluded source figure');
    return true;
}
function usageHistoryRows(loaded,until) {
    const root=require('../config').FILES.llmUsageDir,since=Date.parse(loaded.run.createdAt),events=[];
    check(Number.isFinite(since)&&Number.isFinite(Date.parse(until)),'saved usage history interval');
    for(const name of fs.readdirSync(root)) {
        if(!/^[a-f0-9-]{36}\.json$/u.test(name))continue;
        let value;try{value=JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{continue;}
        if(value.paperId!==loaded.run.paperId||value.stage!=='apiReaderArticle')continue;
        check(Number.isFinite(Date.parse(value.at)),'saved usage history has malformed timestamp');
        if(Date.parse(value.at)<since||Date.parse(value.at)>Date.parse(until))continue;
        const row=read(path.join(root,name));check(same(row.value,value),'saved usage history changed during read');
        events.push({name,...row});
    }
    return events.sort((a,b)=>a.name.localeCompare(b.name));
}
function assertSavedSingleSourceImage(loaded,paper,native) {
    const stage=paper.analysisManifest?.stages?.apiReaderArticle,figures=paper.apiReaderFigures;
    check(figures?.length===1&&stage?.figureCount===1&&stage.imageEvidenceCount===1
        &&native.imageEvidenceCount===stage.imageEvidenceCount
        &&native.imageEvidenceSha256===stage.imageEvidenceSha256
        &&native.modelImagePreflightEvidenceSha256===stage.modelImagePreflightEvidenceSha256,
        'saved one-image native evidence/preflight differs from actual paid stage');
    const f=figures[0],expected={ordinal:f.ordinal,url:f.url,cachePath:f.cachePath,assetSha256:f.assetSha256,
        assetBytes:f.assetBytes,originalSourceAssetSha256:f.asset?.sha256,sourceDomSha256:f.sourceDomSha256};
    check(Array.isArray(native.sourcePixelProofs)&&native.sourcePixelProofs.length===1
        &&same(native.sourcePixelProofs[0],expected)
        &&SHA.test(f.assetSha256)&&SHA.test(f.asset?.sha256)&&SHA.test(f.sourceDomSha256)
        &&Number.isSafeInteger(f.assetBytes)&&f.assetBytes>0
        &&f.cachePath===path.join(loaded.directory,'reader-assets',`figure-${f.ordinal}-${f.assetSha256.slice(0,16)}.png`),
        'saved one-image source/raw/rendered pixel proof changed');
    privateFile(f.cachePath);const bytes=fs.readFileSync(f.cachePath);
    check(bytes.length===f.assetBytes&&sha(bytes)===f.assetSha256,'saved one-image actual sealed PNG changed');
}
function savedReaderUsageProof(loaded,native,stage,wholeHistory=false) {
    const root=require('../config').FILES.llmUsageDir,events=[];
    const since=Date.parse(loaded.run.createdAt),until=Date.parse(stage.refreshedAt);
    check(Number.isFinite(since)&&Number.isFinite(until)&&until>=since,'saved Reader issue interval');
    for(const name of fs.readdirSync(root)) {
        if(!/^[a-f0-9-]{36}\.json$/u.test(name))continue;
        let value;try{value=JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{continue;}
        if(value.paperId!==loaded.run.paperId||value.stage!=='apiReaderArticle'
            ||Date.parse(value.at)<since||Date.parse(value.at)>until)continue;
        const record=read(path.join(root,name));check(same(record.value,value),'usage changed during read');
        events.push({name,...record});
    }
    const requests=events.filter(({value:v})=>v.kind==='request'&&v.inputSha256===native.inputSha256);
    check(requests.length===1,'saved Reader needs unique actual request for native input');
    const request=requests[0],r=request.value;
    check(r.version==='llm-usage-v1'&&r.outcome==='completed'&&r.transportStarted===true&&r.statusCode===200
        &&r.errorCode===null&&r.runId===null&&r.unitId===null&&r.contentAttempt===1&&r.transportAttempt===1
        &&r.model===stage.model&&r.protocol===stage.protocol&&SHA.test(r.outputTextSha256),'saved Reader request completion/consumption binding');
    const starts=events.filter(({value:v})=>v.kind==='request_started'&&v.eventId===r.eventId);
    check(starts.length===1&&starts[0].value.inputSha256===r.inputSha256
        &&starts[0].value.model===r.model&&starts[0].value.protocol===r.protocol
        &&starts[0].value.contentAttempt===1&&starts[0].value.transportAttempt===1
        &&starts[0].value.runId===null&&starts[0].value.unitId===null
        &&Date.parse(starts[0].value.at)<=Date.parse(r.at),'saved Reader original request-start binding');
    const dispositions=events.filter(({value:v})=>v.kind==='disposition'&&v.outputTextSha256===r.outputTextSha256);
    check(dispositions.length===1&&dispositions[0].value.disposition==='accepted'
        &&dispositions[0].value.contentAttempt===1&&dispositions[0].value.runId===null
        &&dispositions[0].value.unitId===null&&Date.parse(dispositions[0].value.at)>=Date.parse(r.at),
        'saved Reader unique accepted disposition');
    const result={inputSha256:r.inputSha256,outputTextSha256:r.outputTextSha256,contentResponses:1,fullResponses:1,
        records:[starts[0],request,dispositions[0]].map(x=>({name:x.name,sha256:x.sha256,kind:x.value.kind,eventId:x.value.eventId}))};
    if(wholeHistory) {
        const observedAt=new Date().toISOString(),history=usageHistoryRows(loaded,observedAt);
        check(history.length===3&&history.every(row=>result.records.some(record=>record.name===row.name&&record.sha256===row.sha256)),
            'saved inherited Reader has another request/response or pending transport in original outer history');
        result.historyObservedAt=observedAt;result.historyFiles=history.map(row=>({name:row.name,sha256:row.sha256}));
        result.historySha256=stable(result.historyFiles);
    }
    return result;
}
async function inspectSavedMaintenanceReaderCompletion(loaded) {
    const last=loaded.analysis.readerRevisionProgress?.failures?.at(-1),stage=loaded.analysis.papers[0].analysisManifest?.stages?.apiReaderArticle;
    if(!loaded.readerReview||stage?.status!=='complete'||stage.contentMode!=='reader-source-signed-revision-v1')return null;
    const neutral=last?.code==='CONFERENCE_READER_REVIEW_MAINTENANCE_INTEGRITY'
        &&last.message==='Text maintenance: protected scientific upstream changed';
    const oneImage=neutral?false:firstInheritedOneImageReaderSuccess(loaded,stage);
    if(!neutral&&!oneImage)return null;
    return require('./analysis-stop-control').withModelRequestsForbidden(async()=>{
        const view=replaySavedNeutralReaderUpstream(loaded),bound=loaded.readerReview;
        check(stage.attempts===1&&stage.fullAttempts===1&&(stage.transportFailures||0)===0
            &&(oneImage?view.projection===null:view.projection&&loaded.analysis.readerRevisionProgress.attempts===1),
            'saved first successful signed Reader only');
        if(oneImage)readVerifiedReaderScientificParent(view.paper);
        check(stable(stage)!==stable(loaded.parent.analysis.papers[0].analysisManifest?.stages?.apiReaderArticle),
            'saved Reader must be this new feedback result');
        for(const [key,value] of Object.entries(bound.revisionSeed.metadata))check(same(stage[key],value),'saved Reader original seed metadata '+key);
        const input=structuredClone(loaded.parent.analysis.papers[0]);input.apiReaderResources=structuredClone(loaded.resourcePreflight);
        const native=await require('../deep-analyzer').prepareConferenceReaderSavedRequestInput(input,loaded.source.sourceDetails,{
            reviewFeedback:bound.modelFeedback,revisionSeed:bound.revisionSeed,readerReviewParentSeedHandle:bound.parentSeedHandle});
        check(native.contract==='conference-saved-signed-reader-request-input-v1'&&native.images===(oneImage?1:0)&&native.modelRequests===0
            &&native.evidenceSha256===stage.evidenceSha256
            &&native.model===stage.model&&native.protocol===stage.protocol&&native.maxTokens===stage.maxTokens
            &&native.temperature===stage.temperature,'saved Reader actual native request/stage identity');
        const identity=native.identity;
        check(identity.paperId===loaded.run.paperId&&identity.sourceSha256===view.paper.sourceSha256
            &&identity.contentMode===stage.contentMode&&identity.promptSha256===stage.promptTemplateSha256
            &&identity.repairPromptSha256===stage.repairPromptTemplateSha256
            &&identity.signedRevisionDisplayContract===stage.signedRevisionDisplayContract
            &&identity.signedRevisionDisplaySha256===stage.signedRevisionDisplaySha256,'saved Reader source/prompt/display binding');
        const usage=savedReaderUsageProof(loaded,native,stage,oneImage),engine=require('../analysis-engine');
        if(oneImage)assertSavedSingleSourceImage(loaded,view.paper,native);
        assertReaderOutput(loaded,view.paper,loaded.parent.analysis.papers[0]);
        const rules=require('./conference-postprocess').readOriginalTagProof(view.paper).rules;
        check(engine.hasValidApiReaderV3Records(view.paper)
            &&engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(view.paper,{tagRules:rules}),
            'saved Reader requires full normal Reader and whole-paper qualification');
        const beforeNames=['analysis.json','run.json','source.json','reader-revision.json','reader-resource-preflight.json','review-reader-seed.json'];
        const beforeFiles=beforeNames.map(name=>({name,...read(path.join(loaded.directory,name))}));
        check(beforeFiles[0].sha256===loaded.analysisFileSha256,'saved Reader final original partial CAS');
        const proof={contract:'conference-saved-maintenance-reader-completion-v1',executionId:loaded.run.executionId,
            paperId:loaded.run.paperId,originalPartialAnalysisFileSha256:loaded.analysisFileSha256,
            parentAnalysisFileSha256:loaded.parent.analysisFileSha256,parentRunFileSha256:loaded.parent.runFileSha256,
            sourceFileSha256:loaded.sourceFileSha256,preflightFileSha256:loaded.revision.resourcePreflightFileSha256,
            projection:view.projection,readerStageSha256:stable(stage),restoredPaperSha256:stable(view.paper),
            ...(oneImage?{savedReaderRecoveryKind:'inherited-source-core-one-image-first-success-v1'}:{}),
            nativeRequest:{inputSha256:native.inputSha256,stageFingerprint:stage.fingerprint,
                currentInputPreparationFingerprint:native.currentInputPreparationFingerprint,
                preparerImplementationSha256:native.preparerImplementationSha256,
                ...(oneImage?{imageEvidenceCount:native.imageEvidenceCount,imageEvidenceSha256:native.imageEvidenceSha256,
                    modelImagePreflightEvidenceSha256:native.modelImagePreflightEvidenceSha256,sourcePixelProofs:native.sourcePixelProofs}:{}),
                evidenceSha256:native.evidenceSha256,promptSha256:identity.promptSha256,repairPromptSha256:identity.repairPromptSha256},
            usage,beforeFiles:beforeFiles.map(x=>({name:x.name,sha256:x.sha256})),newApiRequests:0};
        const handle=Object.freeze({});savedCompletionHandles.set(handle,{proof,paper:structuredClone(view.paper),beforeFiles,loaded});
        return {paper:view.paper,proof,handle};
    });
}
function archiveSavedMaintenanceReaderCompletion(loaded,handle) {
    const saved=savedCompletionHandles.get(handle);check(saved&&saved.loaded.directory===loaded.directory
        &&saved.proof.originalPartialAnalysisFileSha256===loaded.analysisFileSha256,'opaque saved completion handle required');
    for(const file of saved.beforeFiles)check(read(path.join(loaded.directory,file.name)).sha256===file.sha256,'saved completion original CAS changed');
    for(const row of saved.proof.usage.records)check(read(path.join(require('../config').FILES.llmUsageDir,row.name)).sha256===row.sha256,'saved completion usage changed');
    const directory=path.join(loaded.directory,'saved-reader-stage-recovery',loaded.analysisFileSha256);
    const immutable=(file,bytes)=>{if(fs.existsSync(file))check(same(read(file).bytes,bytes),'immutable saved completion archive differs');else adapter().writeBytesAtomic(file,bytes);};
    for(const record of saved.beforeFiles)immutable(path.join(directory,record.name),record.bytes);
    const receipt={...saved.proof,receiptSha256:stable(saved.proof)};
    immutable(path.join(directory,'receipt.json'),Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
    return receipt;
}
function assertSavedMaintenanceReaderRecovery(loaded,paper) {
    const receipt=loaded.analysis.readerSavedStageRecovery;if(!receipt)return;
    self(receipt,'receiptSha256');check(receipt.contract==='conference-saved-maintenance-reader-completion-v1'
        &&receipt.executionId===loaded.run.executionId&&receipt.paperId===loaded.run.paperId
        &&receipt.parentAnalysisFileSha256===loaded.parent.analysisFileSha256
        &&receipt.parentRunFileSha256===loaded.parent.runFileSha256&&receipt.sourceFileSha256===loaded.sourceFileSha256
        &&receipt.preflightFileSha256===loaded.revision.resourcePreflightFileSha256&&receipt.newApiRequests===0
        &&SHA.test(receipt.originalPartialAnalysisFileSha256),'saved completion receipt source/CAS');
    const directory=path.join(loaded.directory,'saved-reader-stage-recovery',receipt.originalPartialAnalysisFileSha256);
    check(same(read(path.join(directory,'receipt.json')).value,receipt),'saved completion actual immutable receipt');
    check(same(receipt.beforeFiles.map(x=>x.name),['analysis.json','run.json','source.json','reader-revision.json','reader-resource-preflight.json','review-reader-seed.json']),
        'saved completion exact before package');
    const records=Object.fromEntries(receipt.beforeFiles.map(row=>{const file=read(path.join(directory,row.name));check(file.sha256===row.sha256,'saved completion before package SHA');return [row.name,file];}));
    check(records['analysis.json'].sha256===receipt.originalPartialAnalysisFileSha256
        &&records['source.json'].sha256===loaded.sourceFileSha256
        &&same(records['reader-revision.json'].value,loaded.revision),'saved completion original source/revision');
    const before=records['analysis.json'].value,view=neutralReaderUpstreamView(loaded.parent.analysis.papers[0],before.papers[0],loaded.resourcePreflight);
    check(before.status==='partial'&&same(view.paper,paper)&&stable(paper)===receipt.restoredPaperSha256
        &&stable(paper.analysisManifest.stages.apiReaderArticle)===receipt.readerStageSha256
        &&paper.analysisManifest.stages.apiReaderArticle.fingerprint===receipt.nativeRequest.stageFingerprint
        &&same(before.readerRevisionProgress,loaded.analysis.readerRevisionProgress),'saved completion exact restored Reader and unchanged consumption');
    if(receipt.savedReaderRecoveryKind!==undefined) {
        check(receipt.savedReaderRecoveryKind==='inherited-source-core-one-image-first-success-v1'
            &&view.projection===null&&firstInheritedOneImageReaderSuccess({...loaded,analysis:before},paper.analysisManifest.stages.apiReaderArticle),
            'saved one-image original first-success scope changed');
        const history=usageHistoryRows(loaded,receipt.usage.historyObservedAt).map(row=>({name:row.name,sha256:row.sha256}));
        check(history.length===3&&same(history,receipt.usage.historyFiles)
            &&stable(history)===receipt.usage.historySha256,'saved one-image complete original usage history changed');
        assertSavedSingleSourceImage(loaded,paper,receipt.nativeRequest);
    }
    const feeRows=receipt.usage.records.map(row=>{const record=read(path.join(require('../config').FILES.llmUsageDir,row.name));check(record.sha256===row.sha256,'saved completion live usage SHA');return record.value;});
    check(feeRows.length===3&&feeRows[0].kind==='request_started'&&feeRows[1].kind==='request'&&feeRows[2].kind==='disposition'
        &&feeRows.every(v=>v.paperId===loaded.run.paperId&&v.stage==='apiReaderArticle'&&v.contentAttempt===1&&v.runId===null&&v.unitId===null)
        &&feeRows[0].eventId===feeRows[1].eventId&&feeRows[0].inputSha256===receipt.nativeRequest.inputSha256
        &&feeRows[1].inputSha256===receipt.nativeRequest.inputSha256&&feeRows[1].outcome==='completed'
        &&feeRows[2].disposition==='accepted'&&feeRows[2].outputTextSha256===feeRows[1].outputTextSha256
        &&feeRows[1].outputTextSha256===receipt.usage.outputTextSha256,'saved completion actual paid issuance chain');
}
function sourceIdentity(parent) {
    return {contract:'conference-reader-pdf-source-v1',paperId:parent.run.paperId,
        sourceSnapshotSha256:parent.run.sourceSnapshotSha256,
        rawStructuredArtifactsSha256:parent.source.sourceSnapshotBinding.sourceBinding.artifactsPayloadSha256,
        effectiveStructuredArtifactsSha256:parent.source.sourceDetails.structuredArtifacts.payloadSha256,
        sourceSnapshotBinding:parent.source.sourceSnapshotBinding,
        planAuthorityBinding:parent.source.planAuthorityBinding,executionId:parent.run.executionId};
}
function replayParentSource(parent) {
    // Existing cold source adapter independently replays official metadata,
    // extraction, source plan and actual PDF. Constructing this expected shape
    // alone confers no permission: the existing reader-source verifier checks it.
    return require('./conference-reader-publication-evidence')
        .replayCanonicalReaderPdfSource(parent.analysis.papers[0],sourceIdentity(parent));
}
function readerSurface(parent,member={}) {
    if(member.parentReaderSurfaceContract==='conference-reader-final-parent-surface-v1') {
        const paper=parent.analysis.papers[0],stage=paper.analysisManifest?.stages?.apiReaderArticle;
        check(typeof paper.apiReaderArticle==='string'&&paper.apiReaderPlan&&Array.isArray(paper.apiReaderFigures)
            &&sha(paper.apiReaderArticle)===paper.apiReaderArticleSha256
            &&stable(paper.apiReaderPlan)===paper.apiReaderPlanSha256
            &&stable(paper.apiReaderFigures)===stage?.figuresSha256,'signed final Reader surface bytes differ');
        return {contract:member.parentReaderSurfaceContract,article:paper.apiReaderArticle,
            plan:structuredClone(paper.apiReaderPlan),figures:structuredClone(paper.apiReaderFigures)};
    }
    check(member.parentReaderSurfaceContract===undefined,'unknown signed final Reader surface');
    return require('./reader-signed-draft-surface').reconstructReaderDraftSurface({
        paper:parent.analysis.papers[0],paperId:parent.run.paperId}).draft;
}
function verifiedParentSeed(parent,feedback) {
    const paper=parent.analysis.papers[0],pdf=replayParentSource(parent);
    const existing=fs.existsSync(path.join(parent.directory,'reader-revision.json'))
        ?adapter().loadConferenceReaderRevision({analysisRoot:path.dirname(parent.directory),executionId:parent.run.executionId}):parent;
    const create=()=>{
        const engine=require('../analysis-engine'),deep=require('../deep-analyzer');
        const normal=()=>deep.prepareApiReaderRevisionSeed(paper,parent.source.sourceDetails.text,feedback);
        if(engine.hasValidApiReaderV3Records(paper))return normal();
        const rules=require('./conference-postprocess').readOriginalTagProof(paper).rules;
        if(!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper,{tagRules:rules}))return normal();
        // This private scope only makes the original, fully authenticated
        // publication Reader a reference. It cannot qualify the new Reader.
        const pins={analysisFileSha256:parent.analysisFileSha256,runFileSha256:parent.runFileSha256,
            sourceFileSha256:parent.sourceFileSha256};
        const bound={paperSha256:stable(paper),sourceSha256:sha(parent.source.sourceDetails.text),
            feedback:String(feedback||'').trim(),executionId:parent.run.executionId,executionDir:parent.directory,
            pdf,assertUnchanged:()=>{
                const current=adapter().loadConferenceAnalysis({analysisRoot:path.dirname(parent.directory),executionId:parent.run.executionId});
                check(Object.entries(pins).every(([key,value])=>current[key]===value),
                    'legacy parent reference canonical CAS changed');
            }};
        bound.assertUnchanged();
        return legacyParentReferenceScope.run(bound,()=>{const seed=normal();bound.assertUnchanged();return seed;});
    };
    return require('./analysis-stop-control').withModelRequestsForbidden(()=>
        require('./conference-analysis-context').withConferenceAnalysisSource({executionId:parent.run.executionId,
            executionDir:parent.directory,paperId:parent.run.paperId,sourceDetails:parent.source.sourceDetails,
            readerPdfSourceHandle:pdf},()=>existing.recoveryWindow
            ?require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(existing.recoveryWindow.grantHandle,
                {paperId:parent.run.paperId,executionId:parent.run.executionId,executionDir:parent.directory,readerPdfSourceHandle:pdf},create):create()));
}
function readLegacyPublicationParentReference(paper,sourceText,feedback) {
    const bound=legacyParentReferenceScope.getStore();if(!bound)return false;
    const active=require('./conference-analysis-context').getConferenceAnalysisContext();
    check(active?.executionId===bound.executionId&&active.executionDir===bound.executionDir
        &&active.readerPdfSourceHandle===bound.pdf&&active.paperId===paper?.id
        &&stable(paper)===bound.paperSha256&&sha(String(sourceText||''))===bound.sourceSha256
        &&String(feedback||'').trim()===bound.feedback,'legacy parent reference left its signed source/feedback scope');
    bound.assertUnchanged();return true;
}
function prepareParentRevisionSeed(handle,parent) {
    const bound=bindCompletedParent(handle,parent);
    const seed=verifiedParentSeed(parent,bound.modelFeedback);check(seed,'actual completed parent signed seed required');return seed;
}
function readMaintenancePublicationHistory(handle) {
    const scope=publicationHistoryHandles.get(handle);check(scope,'opaque maintenance history token required');
    scope.assertUnchanged();
    return {purpose:'reader-maintenance-historical-publication-evidence',processId:scope.batch.m.processId,
        conferenceId:scope.generation.conferenceId,analysisRoot:scope.batch.analysisRoot,
        processDirectory:scope.batch.processDirectory,baselineState:structuredClone(scope.batch.baseline.value),
        baselineStateFileSha256:scope.batch.baseline.sha256,generation:structuredClone(scope.generation),
        generationFileSha256:scope.generationFileSha256,parents:structuredClone(scope.batch.parents),
        assertUnchanged:scope.assertUnchanged};
}
function purePublicationPageTransform(raw,record,outcome) {
    const files=require('../config').FILES,root=path.resolve(path.dirname(files.conferenceProcessDir),'../..');
    const scripts=path.join(root,'scripts'),cli=path.join(scripts,'conference_publication_figure_view_replay.py');
    const expectedImplementation={viewModuleSha256:sha(fs.readFileSync(path.join(scripts,'conference_publication_figure_view.py'))),
        cliSha256:sha(fs.readFileSync(cli)),nativeParserModuleSha256:sha(fs.readFileSync(path.join(scripts,'publish_common.py')))};
    const input={contract:'conference-publication-figure-view-transform-input-v1',rawPageBase64:raw.toString('base64'),
        rawPageSha256:sha(raw),kind:record.kind,paperId:record.kind==='paper'?record.paperId:null,nodeDerivation:outcome};
    const temporary=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'reader-publication-view-'));
    let fd;
    try {
        const filename=path.join(temporary,'input.json');fs.writeFileSync(filename,Buffer.from(JSON.stringify(input)),{flag:'wx',mode:0o600});
        fd=fs.openSync(filename,'r');
        const result=require('node:child_process').spawnSync('bash',[path.join(scripts,'python-runtime.sh'),cli,'3'],
            {stdio:['ignore','pipe','pipe',fd],encoding:'utf8',timeout:60000,maxBuffer:80*1024*1024});
        check(result.status===0&&!result.error,'fixed pure publication transform failed: '+String(result.stderr||result.error||'').slice(0,200));
        const value=JSON.parse(result.stdout);
        check(value.contract==='conference-publication-figure-view-transform-output-v1'
            &&value.purpose==='pure-byte-transform-only'&&value.doesNotGrantSourceOrReviewOrPublication===true
            &&value.rawPageSha256===sha(raw)&&same(value.implementation,expectedImplementation),'pure publication transform identity');
        const projected=Buffer.from(value.projectedPageBase64,'base64');
        check(projected.toString('base64')===value.projectedPageBase64&&sha(projected)===value.projectedPageSha256
            &&projected.length===value.size,'pure publication transform exact bytes');return projected;
    } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{recursive:true,force:true});}
}
function replayMaintenancePublicationView(batch,generation) {
    const view=generation.figurePublicationView;self(view,'viewSha256');
    check(view.contract==='conference-publication-figure-view-v1'&&view.version===1
        &&view.processId===batch.m.processId&&view.conferenceId===generation.conferenceId
        &&Array.isArray(view.rawFiles)&&Array.isArray(view.rawImageFiles),'canonical publication view raw records required');
    const initialState=read(batch.p.state).sha256,materialPins=[];
    const pin=(filename,requirePrivateMode=true)=>{privateFile(filename,requirePrivateMode);const bytes=fs.readFileSync(filename),digest=sha(bytes);
        materialPins.push({filename,sha256:digest,requirePrivateMode});return bytes;};
    const assertBase=()=>{
        check(read(batch.p.state).sha256===initialState,'history issuer actual state changed during replay');
        assertCanonicalReviewEvidence(batch);assertCurrentBatch(batch);
        for(const member of batch.m.members) {
            const parent=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:member.parentExecutionId});
            check(parent.analysisFileSha256===member.parentCAS.analysisFileSha256&&parent.runFileSha256===member.parentCAS.runFileSha256
                &&parent.sourceFileSha256===member.parentCAS.sourceFileSha256,'history original parent CAS changed');
        }
    };
    assertBase();const historyHandle={};
    publicationHistoryHandles.set(historyHandle,{batch,generation:structuredClone(generation),
        generationFileSha256:batch.m.generationFileSha256,assertUnchanged:assertBase});
    try {
        const history=require('./conference-publication-figure-crop').replayPublicationFigureCropsForMaintenance({
            runtimeRoot:path.dirname(batch.analysisRoot),processId:batch.m.processId,conferenceId:generation.conferenceId,
            manifestPath:view.manifestPath,expectedGenerationSha256:view.baseGenerationSha256,
            expectedDerivation:view.nodeDerivation},historyHandle);
        check(history&&typeof history.assertUnchanged==='function'&&same(history.outcome,view.nodeDerivation),
            'actual source-replayed historical crop capability required');history.assertUnchanged();
        const outcome=history.outcome,files=require('../config').FILES;
        const rawFiles=view.rawFiles,rawImages=view.rawImageFiles;
        const scripts=path.resolve(path.dirname(batch.analysisRoot),'../../scripts');
        for(const name of ['conference_publication_figure_view.py','conference_publication_figure_view_replay.py','publish-to-blog.py','publish_common.py','python-runtime.sh'])pin(path.join(scripts,name),false);
        check(generation.completionReceiptSha256===batch.baseline.value.completionReceiptSha256
            &&rawFiles.every(record=>['paper','aggregate','sidecar'].includes(record.kind))
            &&rawImages.every(record=>record.kind==='asset'),'raw view lifecycle or record kinds differ');
        const ordered=rows=>rows.slice().sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
        check(new Set(rawFiles.map(x=>x.path)).size===rawFiles.length&&new Set(rawImages.map(x=>x.path)).size===rawImages.length,
            'unique raw publication records required');
        check(view.rawBundleSha256===stable({completionReceiptSha256:batch.baseline.value.completionReceiptSha256,
            files:ordered(rawFiles),imageFiles:ordered(rawImages)}),'historical raw bundle completion/records differ');
        const paperRecords=rawFiles.filter(record=>record.kind==='paper');
        check(same(paperRecords.map(x=>x.paperId).sort(),Object.keys(batch.baseline.value.items).sort())
            &&new Set(paperRecords.map(x=>x.paperId)).size===paperRecords.length,'raw publication must contain every baseline paper exactly once');
        check(rawFiles.filter(record=>record.kind==='aggregate').length===1,'one actual raw aggregate required');
        const rawBytes=new Map(),stageByPaper=new Map();
        for(const record of [...rawFiles,...rawImages]) {
            const allowed=[files.conferencePageStagingDir,files.conferenceAggregateDir].some(root=>
                path.resolve(record.sourcePath).startsWith(path.resolve(root)+path.sep));
            check(allowed,'historical raw publication source outside authenticated staging');
            const bytes=pin(record.sourcePath);check(sha(bytes)===record.sourceSha256&&bytes.length===record.size,'raw publication bytes changed');
            if(['paper','aggregate'].includes(record.kind))rawBytes.set(record.path,bytes);
            if(record.kind==='paper') {
                const item=batch.baseline.value.items[record.paperId];check(item,'raw publication paper outside baseline');
                const stageFile=path.join(path.dirname(record.sourcePath),'manifest.json'),stage=JSON.parse(pin(stageFile));self(stage,'manifestSha256');
                check(stage.manifestSha256===record.manifestSha256&&item.pageProof.manifestSha256===record.manifestSha256
                    &&stage.paperId===record.paperId&&stage.analysisExecutionId===item.analysisRunId
                    &&stage.analysisSha256===item.analysisProof.analysisSha256
                    &&stage.sourceSnapshotSha256===item.analysisProof.sourceSnapshotSha256
                    &&stage.completionReceiptSha256===item.analysisProof.completionReceiptSha256&&stage.contentSha256===record.sourceSha256
                    &&item.pageProof.contentSha256===record.sourceSha256&&item.pageProof.pagePath===record.path,
                    'historical raw stage does not bind actual baseline parent/page');
                stageByPaper.set(record.paperId,{stage,directory:path.dirname(record.sourcePath)});
            }
            if(record.kind==='aggregate') {
                const proof=batch.baseline.value.aggregate;
                const stage=JSON.parse(pin(path.join(path.dirname(record.sourcePath),'manifest.json')));self(stage,'manifestSha256');
                check(proof&&proof.manifestSha256===record.manifestSha256&&stage.manifestSha256===record.manifestSha256
                    &&stage.aggregateId===proof.aggregateId&&stage.conferenceId===generation.conferenceId
                    &&stage.pagePath===record.path&&proof.pagePath===record.path
                    &&stage.markdownSha256===record.sourceSha256&&proof.markdownSha256===record.sourceSha256,
                    'historical raw aggregate does not bind actual baseline aggregate');
            }
        }
        const representedAssets=new Map();
        for(const record of [...rawFiles.filter(row=>row.kind==='sidecar'),...rawImages]) {
            const owner=stageByPaper.get(record.paperId);check(owner,'raw asset lacks exact original paper stage');
            const assetPath=record.kind==='asset'?'static/images/conference/'+record.path:record.path;
            const matches=owner.stage.assets.filter(asset=>asset.path===assetPath);
            check(matches.length===1&&record.manifestSha256===owner.stage.manifestSha256
                &&matches[0].sha256===record.sourceSha256&&matches[0].size===record.size
                &&record.sourcePath===path.join(owner.directory,'assets',assetPath),
                'historical raw asset ownership/path/manifest differs from original stage');
            const represented=representedAssets.get(record.paperId)||[];represented.push(assetPath);representedAssets.set(record.paperId,represented);
        }
        for(const [paperId,owner]of stageByPaper)check(same((representedAssets.get(paperId)||[]).sort(),owner.stage.assets.map(x=>x.path).sort()),
            'historical complete stage asset set differs from raw bundle');
        const expectedImages=rawImages.map(x=>structuredClone(x));
        for(const item of outcome.derivations)expectedImages.push({kind:'asset',paperId:item.paperId,path:item.newImagePath,
            sourcePath:item.derivedSourcePath,manifestSha256:item.proofSha256,sourceSha256:item.sha256,size:item.size});
        check(same(ordered(expectedImages),ordered(generation.imageFiles)),'historical view image list differs from real replay');
        const actualByPath=new Map(generation.files.map(x=>[x.path,x])),changed=[],expectedFiles=[];
        check(actualByPath.size===generation.files.length&&generation.files.length===rawFiles.length,'historical full view file universe');
        for(const record of ordered(rawFiles)) {
            const actual=actualByPath.get(record.path);check(actual,'historical view missing raw record');
            const hasPaperAction=record.kind==='paper'&&outcome.derivations.some(x=>x.paperId===record.paperId);
            const declaresChanged=actual.sourcePath!==record.sourcePath||actual.sourceSha256!==record.sourceSha256||actual.size!==record.size;
            if(!declaresChanged){check(!hasPaperAction&&same(record,actual),'real figure actions were not projected');expectedFiles.push(record);continue;}
            check(['paper','aggregate'].includes(record.kind),'sidecar cannot become publication view');
            const projected=purePublicationPageTransform(rawBytes.get(record.path),record,outcome);
            check(sha(projected)!==record.sourceSha256,'changed view must change actual publication bytes');
            const expectedPath=path.join(files.conferencePublicationDir,generation.conferenceId,batch.m.processId,
                'figure-publication-views',outcome.derivationSha256,sha(projected)+'.md');
            const expected={...record,sourcePath:expectedPath,sourceSha256:sha(projected),size:projected.length};
            check(same(expected,actual)&&same(pin(actual.sourcePath),projected),'canonical historical view differs from shared exact transform');
            expectedFiles.push(expected);changed.push({path:record.path,paperId:record.paperId??null,
                rawPageSha256:record.sourceSha256,publicationViewSha256:sha(projected)});
        }
        check(same(ordered(expectedFiles),ordered(generation.files))&&same(changed,view.changedPages),'historical full view page mapping differs');
        const assertUnchanged=()=>{assertBase();history.assertUnchanged();
            for(const material of materialPins){privateFile(material.filename,material.requirePrivateMode);check(sha(fs.readFileSync(material.filename))===material.sha256,'historical view material changed');}};
        assertUnchanged();return {rawFiles:structuredClone(rawFiles),assertUnchanged};
    } catch(error) {publicationHistoryHandles.delete(historyHandle);throw error;}
}
function canonicalRoots(processDirectory,analysisRoot) {
    const files=require('../config').FILES;
    check(path.resolve(processDirectory)===path.join(path.resolve(files.conferenceProcessDir),path.basename(processDirectory))
        &&path.resolve(analysisRoot)===path.resolve(files.conferenceAnalysisDir),'canonical process/analysis roots required');
    // privateFile traverses every component and rejects symlinked directories.
    read(path.join(processDirectory,'state.json'));
    return {publication:path.resolve(files.conferencePublicationDir)};
}
function assertCanonicalReviewEvidence(batch) {
    const roots=canonicalRoots(batch.processDirectory,batch.analysisRoot),m=batch.m;
    const cached=verifiedCanonicalReviewEvidence.get(batch);
    if(cached){cached(roots);return;}
    const pins=[];
    const pinnedRead=filename=>{const record=read(filename);pins.push({filename,sha256:record.sha256});return record;};
    const generation=pinnedRead(path.join(batch.p.root,'generation.json'));
    const review=pinnedRead(path.join(batch.p.root,'review-batch.json'));
    const g=generation.value;
    check(g.processId===m.processId&&/^[a-z0-9][a-z0-9-]*$/u.test(g.conferenceId||''),'canonical publication identity');
    const directory=path.join(roots.publication,g.conferenceId,m.processId);
    const candidates=[path.join(directory,'generation.json'),path.join(directory,
        'generation.superseded-'+generation.sha256.slice(0,12)+'.json')];
    const exactGeneration=candidates.filter(filename=>{
        if(!fs.existsSync(filename))return false;
        // Only these two fixed publisher originals may use publisher mode 0644.
        // Registry snapshots and all other private evidence still use read().
        privateFile(filename,false);
        check([0o600,0o644].includes(fs.lstatSync(filename).mode&0o777),'canonical generation file mode');
        return privateFileSha256(filename,false)===generation.sha256;
    });
    check(exactGeneration.length===1&&generation.sha256===m.generationFileSha256,
        'canonical generation original missing, ambiguous or different bytes');
    const canonicalReview=pinnedRead(path.join(roots.publication,'page-review-batch-failures',review.value.batchSha256+'.json'));
    check(canonicalReview.sha256===review.sha256&&review.sha256===m.reviewBatchFileSha256,
        'canonical finished review batch differs from archive');
    for(const row of review.value.pages)if(row.passed===true) {
        const key=stable({path:row.path,sha256:row.sha256}),original=pinnedRead(path.join(roots.publication,'page-review-passes',key+'.json'));
        self(original.value,'resultSha256');check(original.value.contract==='conference-page-content-review-v1'
            &&SHA.test(original.value.protocol||'')&&same(original.value,row),'canonical page pass differs from finished batch');
    }
    for(const row of review.value.pages)if(row.passed===false) {
        check(SHA.test(row.failureSha256||''),'canonical failure identity');
        const archived=pinnedRead(path.join(batch.p.root,'failures',row.failureSha256+'.json'));
        const original=pinnedRead(path.join(roots.publication,'page-review-failures',row.failureSha256+'.json'));
        check(original.sha256===archived.sha256,'canonical failure bytes differ from archive');
    }
    const expected={processId:m.processId,generationFileSha256:m.generationFileSha256,reviewBatchFileSha256:m.reviewBatchFileSha256};
    const assertBytes=currentRoots=>{
        check(currentRoots.publication===roots.publication&&same(expected,{processId:batch.m.processId,
            generationFileSha256:batch.m.generationFileSha256,reviewBatchFileSha256:batch.m.reviewBatchFileSha256}),
            'canonical review identity changed');
        for(const pin of pins)check(privateFileSha256(pin.filename)===pin.sha256,'canonical review evidence bytes changed');
        const exact=candidates.filter(filename=>fs.existsSync(filename)&&privateFileSha256(filename,false)===generation.sha256);
        check(exact.length===1&&exact[0]===exactGeneration[0],'canonical generation original missing, ambiguous or different bytes');
    };
    // The first call still performs every normal protocol/self/row validation.
    // Later calls reread every original byte with safe FD/path/mode checks.
    assertBytes(roots);verifiedCanonicalReviewEvidence.set(batch,assertBytes);
}
function loadBatch({manifestPath,processDirectory,analysisRoot}) {
    canonicalRoots(processDirectory,analysisRoot);
    const initial=read(manifestPath),m=initial.value,p=paths(processDirectory,m.batchId);
    check(path.resolve(manifestPath)===p.manifest&&m.processId===path.basename(processDirectory),'private manifest location');
    const cacheKey=p.manifest+':'+initial.sha256+':'+read(p.state).sha256;
    const cached=evidenceCache.get(cacheKey);
    if(cached){assertCanonicalReviewEvidence(cached);assertCurrentBatch(cached);cached.publicationViewEvidence?.assertUnchanged();return cached;}
    check(m.window?.maxAttempts===3&&m.window?.maxRounds===3,'fixed initial normal window required');
    const baseline=read(path.join(p.root,'baseline-state.json'));
    const generation=read(path.join(p.root,'generation.json'));
    const review=read(path.join(p.root,'review-batch.json'));
    const parents={},surfaces={},failures={},imageClassifications={},markdownClassifications={},aggregateClassifications={},nativeReviewClassifications={},passCaches={};
    const publicationRoot=require('../config').FILES.conferencePublicationDir;
    for(const row of review.value.pages)if(row.passed===true) {
        const key=stable({path:row.path,sha256:row.sha256}),file=read(path.join(publicationRoot,'page-review-passes',key+'.json'));
        passCaches[key]={value:file.value,fileSha256:file.sha256};
    }
    for(const row of review.value.pages) if(row.passed===false) {
        check(SHA.test(row.failureSha256||''),'failure content address');
        const f=read(path.join(p.root,'failures',row.failureSha256+'.json'));
        failures[row.failureSha256]={value:f.value,fileSha256:f.sha256};
    }
    for(const classified of [...(m.imageClassifications||[]),...(m.markdownClassifications||[]),...(m.aggregateClassifications||[]),...(m.nativeReviewClassifications||[])]) {
        check(SHA.test(classified.classificationSha256),'image classification content address');
        const file=read(path.join(p.root,'classifications',classified.classificationSha256+'.json'));
        (file.value.contract==='conference-reader-markdown-review-classification-v1'?markdownClassifications:file.value.contract==='conference-reader-aggregate-review-classification-v1'?aggregateClassifications:file.value.contract==='conference-reader-native-review-classification-v1'?nativeReviewClassifications:imageClassifications)[classified.classificationSha256]={value:file.value,fileSha256:file.sha256};
        if(file.value.contract==='conference-reader-review-classification-v1'&&!['asset-only','deferred-review'].includes(file.value.kind))for(const image of file.value.imageEvidence||[]) {
            const asset=generation.value.imageFiles.find(row=>row.path===image.path&&row.sourceSha256===image.sha256);
            check(asset,'real image generation member');
            const expectedRoot=path.join(path.dirname(analysisRoot),'conference-page-staging')+path.sep;
            check(path.resolve(asset.sourcePath).startsWith(expectedRoot)||generation.value.figurePublicationView,
                'semantic image source outside current staging and no canonical view');
            const info=fs.lstatSync(asset.sourcePath);check(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1,'semantic image regular bytes');
            check(sha(fs.readFileSync(asset.sourcePath))===image.sha256,'semantic image pixels changed');
        }
    }
    for(const member of m.members) {
        check(UUID.test(member.parentExecutionId)&&UUID.test(member.executionId),'execution identity');
        const parent=adapter().loadConferenceAnalysis({analysisRoot,executionId:member.parentExecutionId});
        replayParentSource(parent);
        check(member.executionId===adapter().readerRevisionExecutionId(member.parentExecutionId,parent.analysisFileSha256),'only exact ordinary child');
        parents[member.parentExecutionId]={fileShas:{analysis:parent.analysisFileSha256,run:parent.runFileSha256,
            source:parent.sourceFileSha256},run:parent.run,analysis:parent.analysis,sourceText:parent.source.sourceDetails.text,
            pdfSha256:parent.source.sourceSnapshotBinding.sourceBinding.pdfSha256};
        surfaces[member.parentExecutionId]=readerSurface(parent,member);
        if(member.feedbackMode==='corrective-assertion-v1')check(member.sourceQuotes.every(quote=>member.reviewFeedback.includes(quote)),
            'actual model feedback must include exact source quotes');
    }
    let aggregateMarkdown=null,aggregateMappingRecord=null;
    if((m.aggregatePaperFeedback||[]).length) {
        const aggregate=generation.value.files.find(record=>record.kind==='aggregate');
        const root=require('../config').FILES.conferenceAggregateDir;
        check(aggregate&&path.resolve(aggregate.sourcePath).startsWith(path.resolve(root)+path.sep),'canonical aggregate source required');
        aggregateMappingRecord={filename:aggregate.sourcePath,sha256:aggregate.sourceSha256};
        check(fs.statSync(privateFile(aggregate.sourcePath,false)).size===aggregate.size&&aggregate.size<=128*1024*1024,'actual aggregate source byte budget');
        aggregateMarkdown=fs.readFileSync(aggregate.sourcePath,'utf8');
        check(sha(aggregateMarkdown)===aggregate.sourceSha256,'actual aggregate source bytes changed');
        for(const mapping of m.aggregatePaperFeedback) {
            const member=m.members.find(member=>member.paperId===mapping.paperId);
            const parent=adapter().loadConferenceAnalysis({analysisRoot,executionId:member?.parentExecutionId});
            const parsed=require('./reader-author-parser').parseConferencePdfAuthorsV2(parent.source.sourceDetails.text);
            const before=parent.analysis.papers[0].apiReaderAuthors?.authors.find(author=>author.name===mapping.authorName);
            const after=parsed?.authors.find(author=>author.name===mapping.authorName);
            check(parsed&&mapping.sourceQuote===parsed.sourceEvidence&&before&&after
                &&!same(before.affiliations,after.affiliations),'aggregate author feedback must bind a real current parser-source correction');
        }
    }
    const documents={manifest:m,generation:generation.value,reviewBatch:review.value,state:baseline.value,
        actualPhysicalShas:{generation:generation.sha256,state:baseline.sha256,reviewBatch:review.sha256},
        failures,parents,surfaces,imageClassifications,markdownClassifications,aggregateClassifications,nativeReviewClassifications,aggregateMarkdown,passCaches};
    evidence.validateReviewIdentity(documents);
    const batch={m,p,analysisRoot,processDirectory,manifestFileSha256:initial.sha256,baseline,parents,aggregateMappingRecord};
    assertCanonicalReviewEvidence(batch);
    assertCurrentBatch(batch);
    if(generation.value.figurePublicationView) {
        batch.publicationViewEvidence=replayMaintenancePublicationView(batch,generation.value);
        documents.publicationRawRecords=batch.publicationViewEvidence.rawFiles;
    }
    evidence.validateDocuments(documents);
    if(evidenceCache.size>=16)evidenceCache.delete(evidenceCache.keys().next().value);
    evidenceCache.set(cacheKey,batch);
    return batch;
}
function loadChild(batch,member) {
    member=effectiveMember(batch,member);
    return adapter().loadConferenceReaderRevision({analysisRoot:batch.analysisRoot,executionId:member.executionId});
}
function registeredWindows(batch) {
    const root=path.join(batch.p.root,'windows');if(!fs.existsSync(root))return [];
    const result=[];
    for(const id of fs.readdirSync(root)) {
        check(UUID.test(id),'unexpected continuation directory');const dir=path.join(root,id);
        if(!fs.existsSync(path.join(dir,'registration.json')))continue;
        const registered=read(path.join(dir,'registration.json')).value,w=read(path.join(dir,'manifest.json'));
        assertWindowDeclaration(batch,w.value);
        check(w.value.contract==='conference-reader-review-maintenance-window-v1'&&w.value.version===1
            &&w.value.windowId===id&&w.value.processId===batch.m.processId&&w.value.batchId===batch.m.batchId
            &&w.value.baseManifestSha256===batch.m.manifestSha256
            &&registered.manifestFileSha256===w.sha256&&registered.manifestSha256===w.value.manifestSha256
            &&read(path.join(dir,'baseline-progress.json')).sha256===w.value.baselineProgressFileSha256
            &&same(w.value.limits,{maxRounds:3,readerContentResponses:6,readerFullResponses:2,readerTransportAttempts:2}),'continuation registration identity');
        for(const member of w.value.members) {
            const tree=require('./conference-recovery-grant').recoveryWindowMaterials(batch.analysisRoot,member.failedExecutionId);
            check(tree.materialsSha256===member.materialsSha256&&tree.ledgerFileSha256===member.ledgerFileSha256,'previous complete request/material/fee tree changed');
        }
        result.push({value:w.value,fileSha256:w.sha256,directory:dir});
    }
    const chain=[];let previous=null;
    while(chain.length<result.length) {
        const next=result.filter(row=>row.value.previousWindowId===previous);
        check(next.length===1,'parallel/disconnected continuation windows');
        const row=next[0];check(row.value.previousWindowSha256===(chain.at(-1)?.value.manifestSha256||null),'continuation prior SHA');
        chain.push(row);previous=row.value.windowId;
    }
    check(chain.length<=16,'continuation depth');return chain;
}
function assertWindowDeclaration(batch,w) {
    self(w,'manifestSha256');
    check(w.contract==='conference-reader-review-maintenance-window-v1'&&w.version===1&&UUID.test(w.windowId)
        &&w.processId===batch.m.processId&&w.batchId===batch.m.batchId&&w.baseManifestSha256===batch.m.manifestSha256
        &&SHA.test(w.baselineProgressFileSha256)
        &&same(w.limits,{maxRounds:3,readerContentResponses:6,readerFullResponses:2,readerTransportAttempts:2})
        &&Array.isArray(w.members)&&w.members.length>0&&w.members.length<=batch.m.members.length
        &&new Set(w.members.map(row=>row.paperId)).size===w.members.length,'continuation declaration scope/limits');
    for(const row of w.members)check(batch.m.members.some(base=>base.paperId===row.paperId)
        &&UUID.test(row.failedExecutionId)&&UUID.test(row.expectedExecutionId)
        &&['failedAnalysisFileSha256','failedRunFileSha256','failedSourceFileSha256','failedRevisionFileSha256','materialsSha256'].every(key=>SHA.test(row[key]))
        &&(row.ledgerFileSha256===null||SHA.test(row.ledgerFileSha256)),'continuation original CAS fields');
}
function effectiveMember(batch,member,selectedWindow=undefined) {
    const windows=registeredWindows(batch);
    const found=selectedWindow===null?null:selectedWindow===undefined
        ? windows.findLast(row=>row.value.members.some(m=>m.paperId===member.paperId))
        : windows.find(row=>row.value.windowId===selectedWindow);
    if(!found)return {...member,window:null};
    const win=found.value.members.find(m=>m.paperId===member.paperId);check(win,'paper absent from selected continuation');
    return {...member,executionId:win.expectedExecutionId,window:{windowId:found.value.windowId,
        manifestSha256:found.value.manifestSha256,manifestFileSha256:found.fileSha256},windowMember:win};
}
function registerContinuationWindow(batch,filename) {
    check(read(batch.p.state).sha256===registeredState(batch).sha256,'continuation cannot overwrite adopted process history');
    const supplied=read(filename),w=supplied.value;check(UUID.test(w.windowId),'continuation UUID');
    const dir=path.join(batch.p.root,'windows',w.windowId);check(path.resolve(filename)===path.join(dir,'manifest.json'),'private continuation path');
    if(fs.existsSync(path.join(dir,'registration.json'))) {
        const existing=registeredWindows(batch).find(row=>row.value.windowId===w.windowId);
        check(existing?.fileSha256===supplied.sha256,'idempotent continuation manifest mismatch');
        return read(path.join(dir,'registration.json')).value;
    }
    assertWindowDeclaration(batch,w);const previous=registeredWindows(batch).at(-1);
    check(w.previousWindowId===(previous?.value.windowId||null)&&w.previousWindowSha256===(previous?.value.manifestSha256||null),'unique latest normal maintenance window');
    const failed=[];
    for(const original of batch.m.members) {
        const member=effectiveMember(batch,original),loaded=adapter().loadConferenceReaderRevision({analysisRoot:batch.analysisRoot,executionId:member.executionId});
        if(loaded.analysis.status==='complete')continue;
        check(loaded.analysis.status==='partial'&&loaded.run.status!=='running'
            &&loaded.analysis.readerRevisionProgress?.attempts>0
            &&loaded.analysis.readerRevisionProgress.failures?.length,'actual stopped normal failure required');
        failed.push({member,loaded});
    }
    check(same(failed.map(row=>row.member.paperId).sort(),w.members.map(row=>row.paperId).sort())&&failed.length>0,'continuation exact independent-maintenance failed set');
    for(const {member,loaded} of failed) {
        const row=w.members.find(m=>m.paperId===member.paperId),tree=require('./conference-recovery-grant').recoveryWindowMaterials(batch.analysisRoot,loaded.run.executionId);
        check(row.failedExecutionId===loaded.run.executionId&&row.failedAnalysisFileSha256===loaded.analysisFileSha256
            &&row.failedRunFileSha256===loaded.runFileSha256&&row.failedSourceFileSha256===loaded.sourceFileSha256
            &&row.failedRevisionFileSha256===read(path.join(loaded.directory,'reader-revision.json')).sha256
            &&row.materialsSha256===tree.materialsSha256&&row.ledgerFileSha256===tree.ledgerFileSha256
            &&row.expectedExecutionId===require('./conference-recovery-grant').grantedRecoveryExecutionId(w.windowId,loaded.run.executionId,loaded.analysisFileSha256),'continuation failed child/CAS/materials');
    }
    check(read(path.join(dir,'baseline-progress.json')).sha256===w.baselineProgressFileSha256
        &&w.baselineProgressFileSha256===progressFor(batch).sha256,'actual stopped independent progress snapshot');
    const registration={contract:'conference-reader-review-maintenance-window-registration-v1',processId:batch.m.processId,
        batchId:batch.m.batchId,windowId:w.windowId,manifestSha256:w.manifestSha256,manifestFileSha256:supplied.sha256};
    exact(path.join(dir,'registration.json'),registration);
    exact(path.join(path.dirname(batch.analysisRoot),'conference-recovery-grants',w.windowId,'registration.json'),registration);
    registeredWindows(batch);return registration;
}
function resolveRegisteredMaintenanceWindow(grantId,grantSha256,{analysisRoot}) {
    check(UUID.test(grantId)&&SHA.test(grantSha256),'maintenance continuation identity');
    const file=path.join(path.dirname(analysisRoot),'conference-recovery-grants',grantId,'registration.json');
    if(!fs.existsSync(file))return null;const registered=read(file).value;
    if(registered.contract!=='conference-reader-review-maintenance-window-registration-v1')return null;
    check(UUID.test(grantId)&&registered.windowId===grantId&&registered.manifestSha256===grantSha256,'maintenance continuation requested identity');
    const processDirectory=path.join(path.dirname(analysisRoot),'conference-processes',registered.processId);
    const p=paths(processDirectory,registered.batchId),batch=loadBatch({manifestPath:p.manifest,processDirectory,analysisRoot});
    const window=registeredWindows(batch).find(row=>row.value.windowId===grantId);
    check(window&&window.fileSha256===registered.manifestFileSha256,'registered maintenance continuation bytes');
    const handle=Object.freeze({});windowHandles.set(handle,{batch,window});return handle;
}
function readMaintenanceRecoveryGrantMember(handle,paperId) {
    const stored=windowHandles.get(handle);if(!stored)return null;const {batch,window}=stored;
    const row=window.value.members.find(row=>row.paperId===paperId),base=batch.m.members.find(row=>row.paperId===paperId);
    check(row&&base,'paper absent from registered continuation');
    const failed=adapter().loadConferenceReaderRevision({analysisRoot:batch.analysisRoot,executionId:row.failedExecutionId});
    const files=[];for(const loaded of [failed.parent,failed])for(const name of ['analysis.json','run.json','source.json',...(loaded===failed?['reader-revision.json']:[])]) {
        const file=path.join(loaded.directory,name);files.push({path:file,sha256:read(file).sha256});
    }
    const assertUnchanged=()=>{assertCurrentBatch(batch);const checked=registeredWindows(batch).find(x=>x.value.windowId===window.value.windowId);
        check(checked?.fileSha256===window.fileSha256,'continuation declaration changed');
        for(const pinned of files)check(read(pinned.path).sha256===pinned.sha256,'continuation parent/child CAS changed');};
    assertUnchanged();return Object.freeze({grantId:window.value.windowId,grantSha256:window.value.manifestSha256,
        processId:batch.m.processId,analysisRoot:batch.analysisRoot,limits:window.value.limits,
        member:{paperId,parentExecutionId:base.parentExecutionId,childExecutionId:row.failedExecutionId,
            sourceSnapshotSha256:base.sourceSnapshotSha256,sourceTextSha256:base.sourceSha256},
        parentExecutionId:base.parentExecutionId,parentAnalysisFileSha256:base.parentCAS.analysisFileSha256,
        parentRunFileSha256:base.parentCAS.runFileSha256,failedExecutionId:row.failedExecutionId,
        failedAnalysisFileSha256:row.failedAnalysisFileSha256,failedRunFileSha256:row.failedRunFileSha256,
        failedSourceFileSha256:row.failedSourceFileSha256,failedRevisionFileSha256:row.failedRevisionFileSha256,
        sourceSha256:base.sourceSha256,sourceSnapshotSha256:base.sourceSnapshotSha256,expectedExecutionId:row.expectedExecutionId,
        ...(failed.recoveryWindow?{continuation:{grantId:failed.revision.grantId,grantSha256:failed.revision.grantSha256,
            materialsSha256:row.materialsSha256,ledgerFileSha256:row.ledgerFileSha256}}:{}),files,assertUnchanged});
}
function isCurrentOrVerifiedDescendant(batch,item,adopted) {
    const direct=item?.analysisRunId===adopted.executionId;
    const identity=stable({executionId:adopted.executionId,analysis:adopted.analysisFileSha256,
        run:adopted.runFileSha256,source:adopted.sourceFileSha256});
    const verified=verifiedAdoptedChildIdentities.get(batch);
    if(direct&&verified?.has(identity)) {
        check(UUID.test(adopted.executionId)&&item.analysisProof?.analysisSha256===adopted.analysisFileSha256,
            'current pointer analysis CAS');
        const directory=path.join(batch.analysisRoot,adopted.executionId);
        return privateFileSha256(path.join(directory,'analysis.json'))===adopted.analysisFileSha256
            &&privateFileSha256(path.join(directory,'run.json'))===adopted.runFileSha256
            &&privateFileSha256(path.join(directory,'source.json'))===adopted.sourceFileSha256;
    }
    let current=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:item.analysisRunId});
    check(current.analysisFileSha256===item.analysisProof.analysisSha256,'current pointer analysis CAS');
    for(let depth=0;depth<16;depth++) {
        if(current.run.executionId===adopted.executionId) {
            const matches=current.analysisFileSha256===adopted.analysisFileSha256
                &&current.runFileSha256===adopted.runFileSha256&&current.sourceFileSha256===adopted.sourceFileSha256;
            if(direct&&matches) {
                const identities=verified||new Set();identities.add(identity);
                verifiedAdoptedChildIdentities.set(batch,identities);
            }
            return matches;
        }
        const file=path.join(current.directory,'reader-revision.json');if(!fs.existsSync(file))return false;
        // Raw immutable ordinary-chain verification avoids a recursive call
        // through a later maintenance batch's own cold admission gate.
        const revision=read(file).value;self(revision,'revisionSha256');
        check(revision.contract===adapter().READER_REVISION_CONTRACT
            &&revision.executionId===current.run.executionId&&revision.paperId===item.paperId
            &&revision.sourceSnapshotSha256===current.run.sourceSnapshotSha256,'ordinary descendant revision');
        const parent=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:revision.parentExecutionId});
        check(parent.run.status==='complete'&&parent.analysis.status==='complete'
            &&parent.analysisFileSha256===revision.parentAnalysisFileSha256&&parent.runFileSha256===revision.parentRunFileSha256
            &&parent.sourceFileSha256===current.sourceFileSha256
            &&adapter().readerRevisionExecutionId(parent.run.executionId,parent.analysisFileSha256)===current.run.executionId,'real descendant parent CAS');
        current=parent;
    }
    fail('maintenance descendant chain too deep');
}
function assertCurrentBatch(batch) {
    if(batch.aggregateMappingRecord)check(sha(fs.readFileSync(privateFile(batch.aggregateMappingRecord.filename,false)))===batch.aggregateMappingRecord.sha256,
        'original aggregate feedback source changed');
    check(privateFileSha256(batch.p.manifest)===batch.manifestFileSha256
        &&privateFileSha256(path.join(batch.p.root,'baseline-state.json'))===batch.baseline.sha256
        &&privateFileSha256(path.join(batch.p.root,'generation.json'))===batch.m.generationFileSha256
        &&privateFileSha256(path.join(batch.p.root,'review-batch.json'))===batch.m.reviewBatchFileSha256,'immutable batch bytes changed');
    for(const member of batch.m.members)check(privateFileSha256(path.join(batch.p.root,'failures',member.failureSha256+'.json'))===member.failureFileSha256,'immutable failure bytes changed');
    for(const classified of [...(batch.m.imageClassifications||[]),...(batch.m.markdownClassifications||[]),...(batch.m.aggregateClassifications||[]),...(batch.m.nativeReviewClassifications||[])])check(privateFileSha256(path.join(batch.p.root,'classifications',classified.classificationSha256+'.json'))===classified.classificationFileSha256
        &&privateFileSha256(path.join(batch.p.root,'failures',classified.failureSha256+'.json'))===classified.failureFileSha256,'immutable classification/failure bytes changed');
    const current=validatedMetadataRecord(batch,'state',batch.p.state,value=>api().assertState(value));
    if(current.sha256===batch.baseline.sha256)return current;
    if(fs.existsSync(path.join(batch.p.root,'registration.json'))&&current.sha256===registeredState(batch).sha256)return current;
    check(fs.existsSync(batch.p.adoption),'baseline changed without real adoption');
    const receipt=validatedMetadataRecord(batch,'adoption',batch.p.adoption,value=>self(value,'receiptSha256'));
    const r=receipt.value,after=validatedMetadataRecord(batch,'after',batch.p.after,value=>api().assertState(value));
    check(r.contract==='conference-reader-review-maintenance-adoption-v1'
        &&r.manifestSha256===batch.m.manifestSha256&&r.manifestFileSha256===batch.manifestFileSha256
        &&r.beforeStateFileSha256===batch.baseline.sha256&&r.afterStateFileSha256===after.sha256
        &&r.registeredStateFileSha256===registeredState(batch).sha256
        &&r.afterStateSha256===after.value.stateSha256,'adoption baseline/after CAS');
    check(same(r.children.map(x=>x.paperId).sort(),batch.m.members.map(x=>x.paperId).sort()),'adoption exact member set');
    for(const child of r.children) {
        const member=batch.m.members.find(x=>x.paperId===child.paperId);
        check(child.executionId===effectiveMember(batch,member).executionId,'adoption cannot select another child');
        const afterItem=after.value.items[child.paperId];
        check(afterItem.analysisRunId===child.executionId&&afterItem.analysisProof.analysisSha256===child.analysisFileSha256
            &&afterItem.pageProof.manifestSha256===child.pageManifestSha256,'adoption exact state item');
        check(isCurrentOrVerifiedDescendant(batch,current.value.items[child.paperId],child),'current state is not real adopted child/descendant');
    }
    return current;
}
function locator(batch,member) {
    return {contract:'conference-reader-review-maintenance-member-v1',processId:batch.m.processId,batchId:batch.m.batchId,
        manifestSha256:batch.m.manifestSha256,manifestFileSha256:batch.manifestFileSha256,
        memberSha256:stable(batch.m.members.find(row=>row.paperId===member.paperId)),reviewFeedbackSha256:member.reviewFeedbackSha256,
        window:member.window||null};
}
function bindCompletedParent(handle,parent) {
    const batch=opaque.get(handle);check(batch,'opaque maintenance handle required');assertCurrentBatch(batch);
    const member=batch.m.members.find(x=>x.paperId===parent.run.paperId);
    check(member&&parent.run.executionId===member.parentExecutionId
        &&parent.analysisFileSha256===member.parentCAS.analysisFileSha256
        &&parent.runFileSha256===member.parentCAS.runFileSha256
        &&parent.sourceFileSha256===member.parentCAS.sourceFileSha256,'actual parent CAS');
    return {locator:locator(batch,effectiveMember(batch,member)),modelFeedback:member.reviewFeedback.trim()};
}
function replayRevisionFeedback(loaded) {
    const loc=loaded.revision.readerReviewMaintenance;
    check(loc?.contract==='conference-reader-review-maintenance-member-v1'&&loaded.revision.mode==='reader-only','text revision scope');
    const analysisRoot=path.dirname(loaded.directory),processDirectory=path.join(path.dirname(analysisRoot),'conference-processes',loc.processId);
    const p=paths(processDirectory,loc.batchId),batch=loadBatch({manifestPath:p.manifest,processDirectory,analysisRoot});
    const original=batch.m.members.find(x=>x.paperId===loaded.run.paperId);
    const member=original&&effectiveMember(batch,original,loc.window?.windowId||null);
    check(member&&same(locator(batch,member),loc)&&member.executionId===loaded.run.executionId
        &&loaded.parent.run.executionId===member.parentExecutionId
        &&loaded.sourceFileSha256===loaded.parent.sourceFileSha256,'cold child source/locator binding');
    check(loaded.parent.analysisFileSha256===member.parentCAS.analysisFileSha256
        &&loaded.parent.runFileSha256===member.parentCAS.runFileSha256
        &&loaded.parent.sourceFileSha256===member.parentCAS.sourceFileSha256,'cold original parent bytes changed');
    replayParentSource(loaded.parent);
    check(SHA.test(loaded.revision.readerReviewSeedFileSha256),'immutable parent Reader seed SHA');
    const seed=read(path.join(loaded.directory,'review-reader-seed.json'));
    check(seed.sha256===loaded.revision.readerReviewSeedFileSha256
        &&withScientificParentReplay(loaded,batch,member,()=>same(seed.value,verifiedParentSeed(loaded.parent,member.reviewFeedback.trim()))),'original-scope signed parent Reader seed changed');
    const parentSeedHandle=Object.freeze({});
    parentReaderSeedHandles.set(parentSeedHandle,{parent:structuredClone(loaded.parent),
        executionId:loaded.run.executionId,executionDir:loaded.directory,
        revisionFileSha256:read(path.join(loaded.directory,'reader-revision.json')).sha256,
        sourceFileSha256:loaded.sourceFileSha256,
        seedPath:path.join(loaded.directory,'review-reader-seed.json'),seedFileSha256:seed.sha256,
        sourceTextSha256:sha(loaded.source.sourceDetails.text),feedback:member.reviewFeedback.trim(),
        seed:structuredClone(seed.value),scientificReplay:{loaded,batch,member}});
    const scientificReplayHandle=scientificParentReplayRequired(loaded,batch,member)?Object.freeze({}):null;
    if(scientificReplayHandle)scientificParentReplayHandles.set(scientificReplayHandle,{loaded,batch,member});
    return {locator:loc,modelFeedback:member.reviewFeedback.trim(),member,revisionSeed:seed.value,parentSeedHandle,scientificReplayHandle};
}
function readVerifiedParentReaderSeed(handle,{paper,sourceText,reviewFeedback,revisionSeed}={}) {
    const bound=parentReaderSeedHandles.get(handle);check(bound,'opaque original parent Reader seed required');
    const active=require('./conference-analysis-context').getConferenceAnalysisContext();
    check(active?.executionId===bound.executionId&&active.executionDir===bound.executionDir
        &&active.paperId===paper?.id&&sha(active.sourceDetails?.text||'')===bound.sourceTextSha256
        &&read(path.join(bound.executionDir,'reader-revision.json')).sha256===bound.revisionFileSha256
        &&read(path.join(bound.executionDir,'source.json')).sha256===bound.sourceFileSha256,
        'original parent Reader seed left its actual child/source/revision scope');
    const original=adapter().loadConferenceAnalysis({analysisRoot:path.dirname(bound.parent.directory),
        executionId:bound.parent.run.executionId});
    check(original.analysisFileSha256===bound.parent.analysisFileSha256
        &&original.runFileSha256===bound.parent.runFileSha256
        &&original.sourceFileSha256===bound.parent.sourceFileSha256,'original parent Reader seed CAS changed');
    const parent=original.analysis.papers[0],saved=read(bound.seedPath);
    check(saved.sha256===bound.seedFileSha256&&same(saved.value,bound.seed)
        &&same(revisionSeed,bound.seed)&&String(reviewFeedback||'').trim()===bound.feedback
        &&sha(String(sourceText||''))===bound.sourceTextSha256
        &&paper?.id===parent.id&&paper.sourceSha256===parent.sourceSha256
        &&same(protectedScience(paper),protectedScience(parent))
        &&['apiReaderArticle','apiReaderArticleSha256','apiReaderPlan','apiReaderPlanSha256','apiReaderFigures']
            .every(key=>same(paper[key],parent[key])),'original parent Reader seed input or protected surface changed');
    check(withScientificParentReplay(bound.scientificReplay.loaded,bound.scientificReplay.batch,bound.scientificReplay.member,()=>same(bound.seed,verifiedParentSeed(original,bound.feedback))),'original parent Reader seed no longer qualifies');
    return structuredClone(bound.seed);
}
// Only compose an inherited, independently sealed scientific parent with this
// actual maintenance child's newly generated Reader. The return value neither
// authenticates model output nor grants a save/request budget.
// Source identity only: no feedback, seed, resource or Reader qualification.
// Read the real canonical revision and private registered/adopted material; this
// deliberately does not call loadBatch/replayParentSource and cannot recurse
// through the source plan it is reconstructing.
function readReaderMaintenanceSourceLineage({executionId}) {
    const analysisRoot=require('../config').FILES.conferenceAnalysisDir;
    const loaded=adapter().loadConferenceReaderRevisionIdentity({analysisRoot,executionId});
    const loc=loaded.revision.readerReviewMaintenance;
    check(loc?.contract==='conference-reader-review-maintenance-member-v1'&&loc.window===null
        &&loaded.revision.mode==='reader-only','ordinary initial Reader-only source lineage required');
    const processDirectory=path.join(require('../config').FILES.conferenceProcessDir,loc.processId);
    canonicalRoots(processDirectory,analysisRoot);
    const p=paths(processDirectory,loc.batchId),cacheKey=analysisRoot+'\0'+processDirectory+'\0'+p.root;
    try {
    const manifestSha256=privateFileSha256(p.manifest),baselineSha256=privateFileSha256(path.join(p.root,'baseline-state.json'));
    let batch=sourceLineageBatches.get(cacheKey);
    if(batch&&(batch.analysisRoot!==analysisRoot||batch.processDirectory!==processDirectory
        ||batch.p.root!==p.root||batch.p.manifest!==p.manifest||batch.manifestFileSha256!==manifestSha256
        ||batch.baseline.sha256!==baselineSha256)) {sourceLineageBatches.delete(cacheKey);batch=null;}
    if(!batch) {
        const manifest=read(p.manifest),m=manifest.value;check(manifest.sha256===manifestSha256,'source-only manifest changed during validation');
        self(m,'manifestSha256');
        check(m.contract==='conference-reader-review-maintenance-batch-v1'&&m.version===1
            &&m.processId===loc.processId&&m.batchId===loc.batchId&&Array.isArray(m.members)
            &&m.members.length>0&&new Set(m.members.map(row=>row.paperId)).size===m.members.length,'source-only registered manifest identity');
        const baseline=read(path.join(p.root,'baseline-state.json'));
        check(baseline.sha256===baselineSha256&&baseline.sha256===m.stateFileSha256&&baseline.value.stateSha256===m.baselineStateSha256,
            'source-only baseline immutable manifest CAS');
        batch={m,p,analysisRoot,processDirectory,manifestFileSha256:manifest.sha256,baseline};
    }
    const {m,baseline}=batch;
    const member=m.members.find(row=>row.paperId===loaded.run.paperId);
    check(member&&same(locator(batch,{...member,window:null}),loc)
        &&member.executionId===loaded.run.executionId&&member.parentExecutionId===loaded.parent.run.executionId
        &&member.parentCAS.analysisFileSha256===loaded.parent.analysisFileSha256
        &&member.parentCAS.runFileSha256===loaded.parent.runFileSha256
        &&member.parentCAS.sourceFileSha256===loaded.parent.sourceFileSha256
        &&member.sourceSnapshotSha256===loaded.run.sourceSnapshotSha256
        &&member.sourceSha256===sha(loaded.source.sourceDetails.text),'source-only actual member/parent/source CAS');
    const before=baseline.value.items[member.paperId];
    check(before.analysisRunId===member.parentExecutionId&&before.analysisProof.analysisSha256===member.parentCAS.analysisFileSha256,
        'source-only baseline parent item');
    registeredState(batch);assertCurrentBatch(batch);
    const pins=[...['analysis.json','run.json','source.json','reader-revision.json'].map(name=>path.join(loaded.directory,name)),
        ...['analysis.json','run.json','source.json'].map(name=>path.join(loaded.parent.directory,name))]
        .map(file=>({file,sha256:read(file).sha256}));
    const assertUnchanged=()=>{for(const pin of pins)check(read(pin.file).sha256===pin.sha256,'source-only canonical revision changed');assertCurrentBatch(batch);};
    assertUnchanged();
    // Admit only a completely checked source-only batch. Reuse its private
    // metadata identities, never a Reader/source capability or a child record.
    sourceLineageBatches.delete(cacheKey);sourceLineageBatches.set(cacheKey,batch);
    while(sourceLineageBatches.size>MAX_SOURCE_LINEAGE_BATCHES)sourceLineageBatches.delete(sourceLineageBatches.keys().next().value);
    return {loaded,member,locator:loc,assertUnchanged};
    } catch(error) {sourceLineageBatches.delete(cacheKey);throw error;}
}
// The original pre-adoption seed path permits its own legitimate child
// attempt/checkpoint progress. Only an actual adopted current child requires
// the extra full-canonical science-parent replay capability.
function scientificParentReplayRequired(loaded,batch,member) {
    const parent=loaded.parent.analysis.papers[0];
    const sourceParent=require('./conference-source-resource-correction').isSourceCorrectionRecord(parent);
    const operatorParent=parent.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance?.contract
        ===require('./conference-reader-operator-correction').CORRECTION;
    if(loaded.revision.contract!==adapter().READER_REVISION_CONTRACT||(!sourceParent&&!operatorParent))return false;
    const state=assertCurrentBatch(batch).value,item=state.items[member.paperId];
    if(item?.analysisRunId===loaded.parent.run.executionId)return false;
    const adoption=item?.textMaintenanceAdoption;
    check(item?.analysisRunId===loaded.run.executionId&&adoption?.batchId===batch.m.batchId
        &&adoption.manifestSha256===batch.m.manifestSha256
        &&adoption.previousExecutionId===loaded.parent.run.executionId,'scientific parent replay requires actual current adopted child');
    return true;
}
function withScientificParentReplay(loaded,batch,member,callback) {
    if(!scientificParentReplayRequired(loaded,batch,member))return callback();
    const handle=Object.freeze({});
    scientificParentReplayHandles.set(handle,{loaded,batch,member});
    const operator=require('./conference-reader-operator-correction');
    return loaded.parent.analysis.papers[0].analysisManifest?.stages?.apiReaderArticle?.operatorProvenance?.contract===operator.CORRECTION
        ?operator.withVerifiedMaintenanceReaderParent(handle,callback)
        :require('./conference-source-resource-correction').withVerifiedMaintenanceScientificParent(handle,callback);
}
function readScientificParentReplay(handle) {
    const bound=scientificParentReplayHandles.get(handle);check(bound,'private verified maintenance parent replay required');
    const {loaded,batch,member}=bound;
    const current=adapter().loadConferenceReaderRevisionIdentity({analysisRoot:batch.analysisRoot,executionId:loaded.run.executionId});
    check(current.analysisFileSha256===loaded.analysisFileSha256&&current.runFileSha256===loaded.runFileSha256
        &&current.sourceFileSha256===loaded.sourceFileSha256&&same(current.revision,loaded.revision)
        &&current.parent.analysisFileSha256===member.parentCAS.analysisFileSha256
        &&current.parent.runFileSha256===member.parentCAS.runFileSha256
        &&current.parent.sourceFileSha256===member.parentCAS.sourceFileSha256,'private scientific replay actual canonical CAS');
    assertCurrentBatch(batch);
    return {child:structuredClone(loaded.analysis.papers[0]),parent:structuredClone(loaded.parent.analysis.papers[0]),executionId:loaded.run.executionId,
        processId:batch.m.processId,baselineItem:structuredClone(batch.baseline.value.items[member.paperId]),
        assertUnchanged:()=>{const now=adapter().loadConferenceReaderRevisionIdentity({analysisRoot:batch.analysisRoot,executionId:loaded.run.executionId});
            check(now.analysisFileSha256===loaded.analysisFileSha256&&now.runFileSha256===loaded.runFileSha256
                &&now.sourceFileSha256===loaded.sourceFileSha256&&same(now.revision,loaded.revision)
                &&now.parent.analysisFileSha256===member.parentCAS.analysisFileSha256
                &&now.parent.runFileSha256===member.parentCAS.runFileSha256
                &&now.parent.sourceFileSha256===member.parentCAS.sourceFileSha256,'private scientific replay parent/child changed');assertCurrentBatch(batch);}};
}
function readVerifiedReaderScientificParent(paper) {
    const active=require('./conference-analysis-context').getConferenceAnalysisContext();
    const origin=paper?.conferenceSourceCorrection;
    if(!active||!origin||active.executionId===origin.executionId)return null;
    const stage=paper.analysisManifest?.stages?.apiReaderArticle;
    if(stage?.contentMode!=='reader-source-signed-revision-v1')return null;
    check(active.paperId===paper.id&&active.readerPdfSourceHandle
        &&SHA.test(paper.sourceSha256)&&sha(active.sourceDetails?.text||'')===paper.sourceSha256,
        'inherited scientific parent needs actual child/PDF source scope');
    require('./conference-source-context').readerPdfSourceForContext(active.readerPdfSourceHandle);
    const loaded=adapter().loadConferenceReaderRevision({analysisRoot:path.dirname(active.executionDir),executionId:active.executionId});
    check(loaded.directory===active.executionDir&&loaded.sourceFileSha256===loaded.parent.sourceFileSha256
        &&loaded.revision.mode==='reader-only'&&loaded.readerReview,'inherited science requires actual Reader-only maintenance');
    const parent=loaded.parent.analysis.papers[0],bound=loaded.readerReview;
    check(origin.executionId===loaded.parent.run.executionId
        &&same(origin,parent.conferenceSourceCorrection)
        &&same(paper.conferenceSourceCorrectionObligation,parent.conferenceSourceCorrectionObligation)
        &&same(protectedScience(paper),protectedScience(parent))
        &&same(paper.apiReaderResources,loaded.resourcePreflight)
        &&same(paper.apiReaderResources,parent.apiReaderResources),
        'inherited scientific source/core/scoring/locator or resources changed');
    check(stage.status==='complete'&&stage.reviewFeedbackSha256===bound.locator.reviewFeedbackSha256
        &&stage.revisionMode==='api-reader-signed-revision-v1'
        &&Object.entries(bound.revisionSeed.metadata).every(([key,value])=>same(stage[key],value)),
        'inherited science requires this child actual new signed Reader seed/feedback');
    const pins=[{file:path.join(loaded.directory,'analysis.json'),sha256:loaded.analysisFileSha256},
        {file:path.join(loaded.directory,'run.json'),sha256:loaded.runFileSha256},
        {file:path.join(loaded.directory,'reader-revision.json'),sha256:read(path.join(loaded.directory,'reader-revision.json')).sha256},
        {file:path.join(loaded.directory,'source.json'),sha256:loaded.sourceFileSha256},
        {file:path.join(loaded.directory,'review-reader-seed.json'),sha256:loaded.revision.readerReviewSeedFileSha256},
        ...['analysis.json','run.json','source.json'].map(name=>({file:path.join(loaded.parent.directory,name),
            sha256:read(path.join(loaded.parent.directory,name)).sha256}))];
    const protectedSha=stable(protectedScience(paper)),locatorSha=stable([origin,paper.conferenceSourceCorrectionObligation]);
    const assertUnchanged=()=>{
        for(const pin of pins)check(read(pin.file).sha256===pin.sha256,'inherited scientific parent/child CAS changed');
        check(stable(protectedScience(paper))===protectedSha
            &&stable([paper.conferenceSourceCorrection,paper.conferenceSourceCorrectionObligation])===locatorSha,
            'inherited scientific protected bytes changed during validation');
    };
    assertUnchanged();return {parent,assertUnchanged,scientificReplayHandle:bound.scientificReplayHandle};
}
function assertReaderOutput(loaded,paper,parent) {
    const bound=loaded.readerReview||replayRevisionFeedback(loaded),stage=paper.analysisManifest?.stages?.apiReaderArticle;
    check(stage?.status==='complete'&&stage.reviewFeedbackSha256===bound.locator.reviewFeedbackSha256,'actual new Reader feedback identity');
    check(same(protectedScience(paper),protectedScience(parent)),'protected scientific upstream changed');
    assertSavedMaintenanceReaderRecovery(loaded,paper);
    if(bound.member?.feedbackMode==='corrective-assertion-v1')for(const claim of bound.member.rejectedClaims)
        check(!paper.apiReaderArticle.includes(claim.quote),'rejected original claim survived');
    // Issuance, source, model bytes, normal semantic and full-paper qualification
    // remain mandatory in the adapter; feedback SHA alone is never completion.
}
function qualifyPublicationChild(loaded) {
    const paper=loaded.analysis.papers[0],pdf=replayParentSource(loaded);
    const execute=()=>{
        const rules=require('./conference-postprocess').readOriginalTagProof(paper).rules;
        check(require('../analysis-engine').isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper,{tagRules:rules}),
            'publication child did not pass full current qualification');
    };
    return require('./analysis-stop-control').withModelRequestsForbidden(()=>
        require('./conference-analysis-context').withConferenceAnalysisSource({executionId:loaded.run.executionId,
            executionDir:loaded.directory,paperId:loaded.run.paperId,sourceDetails:loaded.source.sourceDetails,
            readerPdfSourceHandle:pdf},()=>loaded.recoveryWindow
            ?require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(loaded.recoveryWindow.grantHandle,
                {paperId:loaded.run.paperId,executionId:loaded.run.executionId,executionDir:loaded.directory,readerPdfSourceHandle:pdf},execute)
            :execute()));
}
function openMaintenanceBatch(options) {
    const batch=loadBatch(options);const handle=Object.freeze({});opaque.set(handle,batch);return handle;
}
function progressFor(batch) {
    if(!fs.existsSync(batch.p.progress))exact(batch.p.progress,{contract:'conference-reader-review-maintenance-progress-v1',
        manifestSha256:batch.m.manifestSha256,members:{},rounds:[]});
    const saved=read(batch.p.progress);check(saved.value.manifestSha256===batch.m.manifestSha256,'progress manifest');return saved;
}
function saveMember(batch,id,value) {
    const current=progressFor(batch),next=structuredClone(current.value);next.members[id]=value;
    adapter().replaceJson(batch.p.progress,next,current.sha256);
}
function actualProgress(batch,member) {
    member=effectiveMember(batch,member);
    const file=path.join(batch.analysisRoot,member.executionId,'analysis.json');
    if(!fs.existsSync(file))return {attempts:0,status:'absent'};
    if(!fs.existsSync(path.join(path.dirname(file),'reader-revision.json'))) {
        const pending=read(file).value;check(pending.status==='pending','unbound partial child');
        return {attempts:0,status:'pending'};
    }
    const child=loadChild(batch,member);
    return {attempts:child.analysis.readerRevisionProgress?.attempts||0,status:child.analysis.status,child};
}
function stageChild(batch,member,shared,deps,readOnly=false) {
    member=effectiveMember(batch,member);
    const child=loadChild(batch,member);check(child.analysis.status==='complete'&&child.run.status==='complete','actual saved child incomplete');
    assertReaderOutput(child,child.analysis.papers[0],child.parent.analysis.papers[0]);
    const original=shared.retainedSources?.get(member.parentExecutionId);
    const planHandle=original?.planHandle||shared.planHandle,sourceRoot=original?.sourceRoot||shared.sourceCacheRoot;
    const staged=deps.postprocess[readOnly?'loadStage':'stagePaper']({analysisRoot:batch.analysisRoot,executionId:member.executionId,
        tagCatalogPath:deps.files.tagCatalogFile,stagingRoot:deps.files.conferencePageStagingDir,planHandle,sourceRoot,apply:true});
    check((readOnly||staged.status==='staged')&&staged.manifest.paperId===member.paperId
        &&staged.manifest.analysisExecutionId===member.executionId
        &&staged.manifest.analysisSha256===child.analysisFileSha256
        &&staged.manifest.completionReceiptSha256===child.run.completionReceipt.receiptSha256
        &&staged.manifest.sourceSnapshotSha256===member.sourceSnapshotSha256,'normal stage child binding');
    return {paperId:member.paperId,executionId:member.executionId,analysisFileSha256:child.analysisFileSha256,
        runFileSha256:child.runFileSha256,sourceFileSha256:child.sourceFileSha256,
        completionReceiptSha256:child.run.completionReceipt.receiptSha256,
        pageManifestSha256:staged.manifest.manifestSha256,pagePath:staged.manifest.pagePath,
        contentSha256:staged.manifest.contentSha256,revision:child.revision};
}
function readUnissuedMaintenanceChild(batch,member) {
    const directory=path.join(batch.analysisRoot,member.executionId);
    const names=['analysis.json','intent.json','reader-resource-preflight.json','run.json','source.json'];
    check(same(fs.readdirSync(directory).sort(),names),'unissued recovery requires exact original five files and no revision/seed/request/candidate');
    const loaded=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:member.executionId});
    const intent=read(path.join(directory,'intent.json'));
    check(loaded.run.status==='source_ready'&&loaded.analysis.status==='pending'&&loaded.analysis.generation===0
        &&loaded.analysisFileSha256===intent.value.initialAnalysisFileSha256
        &&loaded.run.prepareIntentFileSha256===intent.sha256
        &&loaded.sourceFileSha256===member.parentCAS.sourceFileSha256
        &&loaded.run.sourceSnapshotSha256===member.sourceSnapshotSha256
        &&!Object.hasOwn(loaded.analysis,'readerRevisionProgress'),'unissued recovery actual intent/source/zero-attempt CAS');
    const records=Object.fromEntries(names.map(name=>[name,read(path.join(directory,name))]));
    return {loaded,records};
}
function unissuedResourceMode(paper,identity) {
    const parse=require('../utils').parseAnalysis,deep=require('../deep-analyzer');
    const before=parse(paper.analysis),after=parse(deep.applyApiReaderResourceAvailability(paper.analysis,identity));
    return ['hasCode','hasModel','hasDataset'].some(key=>before[key]!==after[key])?'scoring-and-reader':'reader-only';
}
async function recoverUnissuedMaintenanceChild(batch,member,handle,deps,shared) {
    const selected=effectiveMember(batch,member),saved=progressFor(batch).value.members[member.paperId];
    const messages=['Text maintenance cannot change resources or scoring',
        '定向修订需要完整的读者文章，且正文、写作计划和分析阶段的 SHA 记录须一致。'];
    if(selected.window||!saved||saved.status!=='failed'||saved.executionId!==selected.executionId
        ||saved.attempts!==0||saved.failure?.retryable!==false||saved.failure?.systemic
        ||!messages.includes(saved.failure?.message))return false;
    return deps.engine.withPaperAnalysisLock({id:member.paperId},()=>require('./analysis-stop-control').withModelRequestsForbidden(async()=>{
        assertCurrentBatch(batch);const parent=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:member.parentExecutionId});bindCompletedParent(handle,parent);
        const initial=readUnissuedMaintenanceChild(batch,selected),paper=parent.analysis.papers[0];
        // The new private parent-reference bridge must really qualify before an
        // earlier pre-request failure is eligible for normal dispatch again.
        check(verifiedParentSeed(parent,member.reviewFeedback.trim()),'unissued parent reference seed did not qualify');
        const directory=path.join(batch.p.root,'unissued-preflight-recoveries',selected.executionId);
        const receiptFile=path.join(directory,'receipt.json'),newFile=path.join(directory,'new-preflight.json');
        const beforeNames=Object.keys(initial.records),beforeDir=path.join(directory,'before');
        let receipt;
        if(fs.existsSync(receiptFile)) {
            const row=read(receiptFile);self(row.value,'receiptSha256');receipt=row.value;
            check(receipt.contract==='conference-reader-unissued-preflight-recovery-v1'
                &&receipt.manifestSha256===batch.m.manifestSha256&&receipt.manifestFileSha256===batch.manifestFileSha256
                &&receipt.executionId===selected.executionId&&receipt.paperId===member.paperId
                &&same(receipt.parentCAS,member.parentCAS),'unissued recovery receipt belongs to another parent/obligation');
            const restored=read(newFile);check(restored.sha256===receipt.newPreflightFileSha256,'unissued new preflight snapshot changed');
            const original=shared.retainedSources?.get(member.parentExecutionId),planHandle=original?.planHandle||shared.planHandle,sourceRoot=original?.sourceRoot||shared.sourceCacheRoot;
            const pdf=adapter().verifyPlanAuthority(initial.loaded,planHandle,sourceRoot);
            require('./conference-analysis-context').withConferenceAnalysisSource({executionId:selected.executionId,executionDir:initial.loaded.directory,
                paperId:member.paperId,sourceDetails:initial.loaded.source.sourceDetails,readerPdfSourceHandle:pdf},()=>
                require('../deep-analyzer').replayVerifiedReaderResourceIdentity(restored.value,initial.loaded.source.sourceDetails.text));
            check(receipt.status!=='reader-only-ready'||unissuedResourceMode(paper,restored.value)==='reader-only',
                'unissued receipt cannot grant a changed scoring mode');
            for(const name of beforeNames)check(read(path.join(beforeDir,name)).sha256===receipt.before[name],
                'unissued original before archive changed');
            check(read(path.join(beforeDir,'member-progress.json')).sha256===receipt.oldMemberProgressFileSha256,
                'unissued original failure archive changed');
            for(const name of beforeNames)check(name==='reader-resource-preflight.json'
                ?[receipt.before[name],...(receipt.status==='reader-only-ready'?[receipt.newPreflightFileSha256]:[])].includes(initial.records[name].sha256)
                :initial.records[name].sha256===receipt.before[name],'unissued child changed after preflight restoration');
            if(receipt.status==='reader-only-ready'&&initial.records['reader-resource-preflight.json'].sha256!==restored.sha256)
                adapter().replaceJson(path.join(initial.loaded.directory,'reader-resource-preflight.json'),restored.value,initial.records['reader-resource-preflight.json'].sha256);
            return receipt.status==='reader-only-ready';
        }
        for(const [name,row] of Object.entries(initial.records))adapter().writeBytesAtomic(path.join(beforeDir,name),row.bytes);
        exact(path.join(beforeDir,'member-progress.json'),saved);
        const old=initial.records['reader-resource-preflight.json'].value;
        let identity=old,probeInvocations=0;
        const original=shared.retainedSources?.get(member.parentExecutionId);
        const planHandle=original?.planHandle||shared.planHandle,sourceRoot=original?.sourceRoot||shared.sourceCacheRoot;
        const source=initial.loaded.source.sourceDetails,pdf=adapter().verifyPlanAuthority(initial.loaded,planHandle,sourceRoot),deep=require('../deep-analyzer');
        const sourceOperation=async()=>{
            deep.replayVerifiedReaderResourceIdentity(old,source.text);
            if(unissuedResourceMode(paper,old)!=='reader-only') {
                check(old.resources.some(resource=>resource.availability==='temporarily_unreachable'&&resource.retryable===true),
                    'unissued scoring input changed without a temporary resource failure');
                identity=await deep.buildApiReaderResourceIdentity(paper.analysis,source.text,paper.analysisManifest?.stages?.demoLinkScan,
                    {paper,structuredArtifacts:source.structuredArtifacts});probeInvocations=1;
            }
            deep.replayVerifiedReaderResourceIdentity(identity,source.text);
        };
        await require('./conference-analysis-context').withConferenceAnalysisSource({executionId:selected.executionId,
            executionDir:initial.loaded.directory,paperId:member.paperId,sourceDetails:source,readerPdfSourceHandle:pdf},sourceOperation);
        adapter().verifyPlanAuthority(initial.loaded,planHandle,sourceRoot);
        const current=readUnissuedMaintenanceChild(batch,selected);
        for(const name of beforeNames)check(current.records[name].sha256===initial.records[name].sha256,
            'unissued child changed during normal resource recheck');
        const lockedParent=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:member.parentExecutionId});check(lockedParent.analysisFileSha256===parent.analysisFileSha256
            &&lockedParent.runFileSha256===parent.runFileSha256&&lockedParent.sourceFileSha256===parent.sourceFileSha256,
            'unissued parent changed during normal resource recheck');assertCurrentBatch(batch);
        exact(newFile,identity);const replacement=read(newFile);
        const body={contract:'conference-reader-unissued-preflight-recovery-v1',manifestSha256:batch.m.manifestSha256,
            manifestFileSha256:batch.manifestFileSha256,paperId:member.paperId,executionId:selected.executionId,
            parentCAS:member.parentCAS,before:Object.fromEntries(Object.entries(initial.records).map(([name,row])=>[name,row.sha256])),
            oldMemberProgressFileSha256:read(path.join(beforeDir,'member-progress.json')).sha256,
            newPreflightFileSha256:replacement.sha256,oldIdentitySha256:old.identitySha256,newIdentitySha256:identity.identitySha256,
            normalProbeInvocations:probeInvocations,status:unissuedResourceMode(paper,identity)==='reader-only'?'reader-only-ready':'still-requires-scoring'};
        exact(receiptFile,{...body,receiptSha256:stable(body)});
        if(body.status!=='reader-only-ready')return false;
        if(replacement.sha256!==initial.records['reader-resource-preflight.json'].sha256)
            adapter().replaceJson(path.join(initial.loaded.directory,'reader-resource-preflight.json'),identity,
                initial.records['reader-resource-preflight.json'].sha256);
        return true;
    }),{recoveryPolicy:deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY});
}
async function runReaderReviewMaintenanceBatch({manifestPath,directory,state,shared,options},deps) {
    check(!options.postprocessOnly&&!options.recoveryManifest&&!options.readerCorrections&&!options.sourceCorrections,'exclusive normal maintenance mode');
    const handle=openMaintenanceBatch({manifestPath,processDirectory:directory,analysisRoot:deps.files.conferenceAnalysisDir});
    const batch=opaque.get(handle);check(state.stateSha256===read(batch.p.state).value.stateSha256,'locked current state drift');
    registerPendingObligation(batch,deps.now);state=read(batch.p.state).value;
    if(options.readerReviewWindow)registerContinuationWindow(batch,options.readerReviewWindow);
    if(fs.existsSync(batch.p.adoption)&&read(batch.p.state).sha256!==registeredState(batch).sha256) {
        assertCurrentBatch(batch);return {status:'adopted',state:read(batch.p.state).value};
    }
    const stop=require('./analysis-stop-control'),roundApi=require('./analysis-failure-rounds'),recovery=require('./conference-process-recovery');
    const outcomes=new Map(),unissuedReadmissions=new Set();
    // Complete children are always independently staged; progress flags never qualify them.
    for(const member of batch.m.members) {
        let actual=actualProgress(batch,member);
        if(actual.status==='pending'&&await recoverUnissuedMaintenanceChild(batch,member,handle,deps,shared))unissuedReadmissions.add(member.paperId);
        if(actual.status==='partial'&&typeof deps.adapter.replaySavedConferenceReaderRevision==='function') {
            const original=shared.retainedSources?.get(member.parentExecutionId),selected=effectiveMember(batch,member);
            await stop.withModelRequestsForbidden(()=>deps.adapter.replaySavedConferenceReaderRevision({analysisRoot:batch.analysisRoot,
                executionId:selected.executionId,planHandle:original?.planHandle||shared.planHandle,
                sourceRoot:original?.sourceRoot||shared.sourceCacheRoot}));
            actual=actualProgress(batch,member);
        }
        if(actual.status==='complete') {
            const proof=await stop.withModelRequestsForbidden(()=>stageChild(batch,member,shared,deps));
            saveMember(batch,member.paperId,{status:'complete',proof});outcomes.set(member.paperId,proof);
        }
    }
    let pending=batch.m.members.filter(member=>!outcomes.has(member.paperId));
    while(true) {
        const previous=progressFor(batch).value.members;
        // Keep the original cheap eligibility short-circuits before any cold
        // child read: pending also contains successes from previous phases.
        const phaseCandidates=pending.filter(member=>!outcomes.has(member.paperId)
            &&(unissuedReadmissions.has(member.paperId)||previous[member.paperId]?.executionId!==effectiveMember(batch,member).executionId
            ||previous[member.paperId]?.failure?.retryable!==false||previous[member.paperId]?.failure?.systemic===true));
        // One full observation per eligible child for this synchronous phase.
        // These values select work only; they never certify a Reader. The next
        // while iteration rebuilds the map from actual saved children.
        const scheduling=new Map(phaseCandidates.map(member=>{
            const actual=actualProgress(batch,member);
            return [member.paperId,Object.freeze({executionId:effectiveMember(batch,member).executionId,
                status:actual.status,attempts:actual.attempts,
                progressKey:stable(actual.child?.analysis.readerRevisionProgress||{})})];
        }));
        const settledProgress=new Map();
        const retryable=phaseCandidates.filter(member=>scheduling.get(member.paperId).attempts<3);
        if(!retryable.length)break;
        // Real persisted child attempts, not this invocation's loop counter,
        // finish all unstarted members of an interrupted round before retrying
        // members already attempted in that round.
        const minimumAttempt=Math.min(...retryable.map(member=>scheduling.get(member.paperId).attempts));
        const input=retryable.filter(member=>scheduling.get(member.paperId).attempts===minimumAttempt);
        await roundApi.runFailureRounds(input,{
            concurrency:options.concurrency||3,maxRounds:1,getItemId:member=>member.paperId,
            getProgressKey:(member,outcome)=>outcome===null?scheduling.get(member.paperId).progressKey
                :settledProgress.get(member.paperId),
            shouldStop:()=>{stop.assertMayStartRequest();return false;},
            onRoundStart:round=>{const current=progressFor(batch);adapter().replaceJson(batch.p.progress,
                {...current.value,roundIntents:[...(current.value.roundIntents||[]),{
                    inputIds:round.inputIds,normalRoundOrdinal:minimumAttempt+1,
                    startingAttempts:Object.fromEntries(input.map(member=>[member.paperId,scheduling.get(member.paperId).attempts])),
                    windowByPaper:Object.fromEntries(input.map(member=>[member.paperId,effectiveMember(batch,member).window?.windowId||null]))}]},current.sha256);},
            onRoundDone:round=>{const current=progressFor(batch);adapter().replaceJson(batch.p.progress,
                {...current.value,rounds:[...current.value.rounds,{...round,normalRoundOrdinal:minimumAttempt+1}]},current.sha256);},
            runItem:async member=>{
                unissuedReadmissions.delete(member.paperId);
                const original=shared.retainedSources?.get(member.parentExecutionId);
                try {
                    // Dispatch observes the real child again. A changed attempt,
                    // selected window, or saved state stops before any request;
                    // the ordinary adapter still rereads under the paper lock.
                    const expected=scheduling.get(member.paperId),actual=actualProgress(batch,member);
                    if(effectiveMember(batch,member).executionId!==expected.executionId
                        ||actual.attempts!==expected.attempts||actual.status!==expected.status
                        ||stable(actual.child?.analysis.readerRevisionProgress||{})!==expected.progressKey)
                        throw Object.assign(new Error('Reader maintenance progress changed after scheduling'),
                            {code:'READER_MAINTENANCE_SCHEDULING_DRIFT',scope:'run',retryable:false});
                    const selected=effectiveMember(batch,member),source={planHandle:original?.planHandle||shared.planHandle,
                        sourceRoot:original?.sourceRoot||shared.sourceCacheRoot};
                    if(selected.window) {
                        const grantHandle=resolveRegisteredMaintenanceWindow(selected.window.windowId,selected.window.manifestSha256,{analysisRoot:batch.analysisRoot});
                        await deps.adapter.refreshConferenceGrantedRecovery({analysisRoot:batch.analysisRoot,parentExecutionId:member.parentExecutionId,
                            failedExecutionId:selected.windowMember.failedExecutionId,...source,grantHandle,reviewMaintenanceHandle:handle});
                    } else await deps.adapter.refreshConferenceReader({analysisRoot:batch.analysisRoot,parentExecutionId:member.parentExecutionId,
                        ...source,maxAttempts:3,reviewMaintenanceHandle:handle});
                    const proof=await stop.withModelRequestsForbidden(()=>stageChild(batch,member,shared,deps));
                    saveMember(batch,member.paperId,{status:'complete',proof});outcomes.set(member.paperId,proof);return {success:true};
                } catch(error) {
                    const failure=recovery.classifyFailure(error,deps.now());
                    const actual=actualProgress(batch,member);
                    settledProgress.set(member.paperId,stable(actual.child?.analysis.readerRevisionProgress||{}));
                    if(actual.status==='complete'||actual.attempts===minimumAttempt&&!failure.systemic)failure.retryable=false;
                    saveMember(batch,member.paperId,{status:'failed',executionId:effectiveMember(batch,member).executionId,
                        failure,attempts:actual.attempts});
                    if(failure.systemic)stop.requestAnalysisStop(failure.code||'maintenance_failure');
                    return {success:false,error,retryable:failure.retryable&&!failure.systemic,
                        scope:failure.systemic?'run':'paper',budgetExhausted:actual.attempts>=3};
                }
            }
        });
    }
    pending=batch.m.members.filter(member=>!outcomes.has(member.paperId));
    if(pending.length)return {status:'reader_review_maintenance_pending',processId:batch.m.processId,
        manifestSha256:batch.m.manifestSha256,savedComplete:outcomes.size,failed:pending.map(x=>x.paperId),
        originalCompleteHistoryPreserved:true};
    const ordered=batch.m.members.map(x=>x.paperId).sort();
    const lock=index=>index===ordered.length?adopt():deps.engine.withPaperAnalysisLock({id:ordered[index]},()=>lock(index+1),
        {recoveryPolicy:deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY});
    const adopt=()=>{
        check(read(batch.p.state).sha256===registeredState(batch).sha256,'registered complete state CAS before adoption');
        const children=batch.m.members.map(member=>stageChild(batch,member,shared,deps,true));
        const next=structuredClone(state);
        for(const child of children) {
            const member=batch.m.members.find(x=>x.paperId===child.paperId),item=next.items[child.paperId];
            check(item.analysisRunId===member.parentExecutionId&&item.analysisProof.analysisSha256===member.parentCAS.analysisFileSha256,'original item CAS');
            next.items[child.paperId]={...item,analysisRunId:child.executionId,readerRevision:child.revision,
                analysisProof:{analysisSha256:child.analysisFileSha256,completionReceiptSha256:child.completionReceiptSha256,
                    sourceSnapshotSha256:member.sourceSnapshotSha256},
                pageProof:{manifestSha256:child.pageManifestSha256,contentSha256:child.contentSha256,pagePath:child.pagePath},
                textMaintenanceAdoption:{batchId:batch.m.batchId,manifestSha256:batch.m.manifestSha256,previousExecutionId:item.analysisRunId}};
        }
        next.status='running';next.aggregate=null;next.completionReceiptSha256=null;next.generation++;
        next.updatedAt=fs.existsSync(batch.p.after)?read(batch.p.after).value.updatedAt:deps.now();
        next.stateSha256=api().stateDigest(next);api().assertState(next);
        exact(batch.p.after,next);const after=read(batch.p.after);
        const body={contract:'conference-reader-review-maintenance-adoption-v1',manifestSha256:batch.m.manifestSha256,
            manifestFileSha256:batch.manifestFileSha256,beforeStateFileSha256:batch.baseline.sha256,
            registeredStateFileSha256:registeredState(batch).sha256,
            afterStateFileSha256:after.sha256,afterStateSha256:next.stateSha256,children};
        exact(batch.p.adoption,{...body,receiptSha256:stable(body)});
        adapter().replaceJson(batch.p.state,next,registeredState(batch).sha256);
        for(const child of children)if(shared.retainedSources) {
            const member=batch.m.members.find(x=>x.paperId===child.paperId),original=shared.retainedSources.get(member.parentExecutionId);
            shared.retainedSources.set(child.executionId,original);
        }
        return {status:'adopted',state:next};
    };
    return lock(0);
}
function assertNoPendingReaderReviewMaintenance({processDirectory,analysisRoot,state}) {
    canonicalRoots(processDirectory,analysisRoot);
    check(read(path.join(processDirectory,'state.json')).value.stateSha256===state.stateSha256,'publication FD state is stale');
    const parent=path.join(processDirectory,'review-reader-maintenance'),declared=state.readerReviewMaintenanceObligations||[];
    check(Array.isArray(declared)&&declared.every(row=>UUID.test(row.batchId)&&SHA.test(row.manifestSha256)&&SHA.test(row.manifestFileSha256))
        &&new Set(declared.map(row=>row.batchId)).size===declared.length,'state maintenance obligation locators');
    if(!fs.existsSync(parent)){check(declared.length===0,'state pending obligation directory missing');return true;}
    check(fs.lstatSync(parent).isDirectory()&&!fs.lstatSync(parent).isSymbolicLink(),'maintenance registry directory');
    const names=fs.readdirSync(parent);check(same(names.slice().sort(),declared.map(row=>row.batchId).sort()),'state/registry obligation set mismatch');
    for(const batchId of names) {
        check(UUID.test(batchId),'unexpected maintenance registry entry');
        const p=paths(processDirectory,batchId),batch=loadBatch({manifestPath:p.manifest,processDirectory,analysisRoot});
        check(same(obligation(batch),declared.find(row=>row.batchId===batchId)),'state/manifest obligation bytes mismatch');
        check(fs.existsSync(p.adoption),'publication has pending real Reader maintenance');
        check(read(p.state).sha256!==registeredState(batch).sha256,'adoption receipt exists but original complete process has not adopted');
        assertCurrentBatch(batch);check(state.status==='complete'&&read(p.state).value.stateSha256===state.stateSha256,'new complete process required');
        const receipt=read(p.adoption).value;
        for(const child of receipt.children) {
            const loaded=loadChild(batch,batch.m.members.find(x=>x.paperId===child.paperId));
            assertReaderOutput(loaded,loaded.analysis.papers[0],loaded.parent.analysis.papers[0]);
            check(loaded.analysis.status==='complete'&&loaded.run.status==='complete','saved adopted Reader no longer complete');
            qualifyPublicationChild(loaded);
        }
    }
    return true;
}
module.exports={bindCompletedParent,replayRevisionFeedback,assertReaderOutput,replaySavedNeutralReaderUpstream,inspectSavedMaintenanceReaderCompletion,archiveSavedMaintenanceReaderCompletion,
    runReaderReviewMaintenanceBatch,assertNoPendingReaderReviewMaintenance,readReaderMaintenanceSourceLineage,readScientificParentReplay,
    resolveRegisteredMaintenanceWindow,readMaintenanceRecoveryGrantMember,prepareParentRevisionSeed,readMaintenancePublicationHistory,readVerifiedParentReaderSeed,readVerifiedReaderScientificParent,readLegacyPublicationParentReference};
