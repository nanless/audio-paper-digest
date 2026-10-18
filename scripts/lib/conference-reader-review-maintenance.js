'use strict';
// Normal Reader maintenance for a complete, source-bound conference batch.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const evidence = require('./conference-reader-review-maintenance-evidence');
const { sha, stable } = evidence;
const opaque = new WeakMap();
const windowHandles = new WeakMap();
const publicationHistoryHandles = new WeakMap();
const evidenceCache = new Map();
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
    const state=read(path.join(batch.p.root,'registered-state.json'));
    const registration=read(path.join(batch.p.root,'registration.json')).value;self(registration,'registrationSha256');
    check(registration.contract==='conference-reader-review-maintenance-registration-v1'
        &&registration.manifestSha256===batch.m.manifestSha256&&registration.manifestFileSha256===batch.manifestFileSha256
        &&registration.baselineStateFileSha256===batch.baseline.sha256&&registration.registeredStateFileSha256===state.sha256,'pending registration CAS');
    const expected=structuredClone(batch.baseline.value);
    expected.readerReviewMaintenanceObligations=[...(expected.readerReviewMaintenanceObligations||[]),obligation(batch)];
    expected.generation++;expected.updatedAt=state.value.updatedAt;expected.stateSha256=api().stateDigest(expected);
    check(same(expected,state.value),'registration changed original complete history');api().assertState(state.value);return state;
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
    const create=()=>require('../deep-analyzer').prepareApiReaderRevisionSeed(paper,parent.source.sourceDetails.text,feedback);
    return require('./analysis-stop-control').withModelRequestsForbidden(()=>
        require('./conference-analysis-context').withConferenceAnalysisSource({executionId:parent.run.executionId,
            executionDir:parent.directory,paperId:parent.run.paperId,sourceDetails:parent.source.sourceDetails,
            readerPdfSourceHandle:pdf},()=>existing.recoveryWindow
            ?require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(existing.recoveryWindow.grantHandle,
                {paperId:parent.run.paperId,executionId:parent.run.executionId,executionDir:parent.directory,readerPdfSourceHandle:pdf},create):create()));
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
        cliSha256:sha(fs.readFileSync(cli)),nativeParserModuleSha256:sha(fs.readFileSync(path.join(scripts,'publish-to-blog.py')))};
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
        for(const name of ['conference_publication_figure_view.py','conference_publication_figure_view_replay.py','publish-to-blog.py','python-runtime.sh'])pin(path.join(scripts,name),false);
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
    const generation=read(path.join(batch.p.root,'generation.json'));
    const review=read(path.join(batch.p.root,'review-batch.json'));
    const g=generation.value;
    check(g.processId===m.processId&&/^[a-z0-9][a-z0-9-]*$/u.test(g.conferenceId||''),'canonical publication identity');
    const directory=path.join(roots.publication,g.conferenceId,m.processId);
    const candidates=[path.join(directory,'generation.json'),path.join(directory,
        'generation.superseded-'+generation.sha256.slice(0,12)+'.json')];
    const exactGeneration=candidates.filter(filename=>fs.existsSync(filename)&&read(filename).sha256===generation.sha256);
    check(exactGeneration.length===1&&generation.sha256===m.generationFileSha256,
        'canonical generation original missing, ambiguous or different bytes');
    const canonicalReview=read(path.join(roots.publication,'page-review-batch-failures',review.value.batchSha256+'.json'));
    check(canonicalReview.sha256===review.sha256&&review.sha256===m.reviewBatchFileSha256,
        'canonical finished review batch differs from archive');
    for(const row of review.value.pages)if(row.passed===true) {
        const key=stable({path:row.path,sha256:row.sha256}),original=read(path.join(roots.publication,'page-review-passes',key+'.json'));
        self(original.value,'resultSha256');check(original.value.contract==='conference-page-content-review-v1'
            &&SHA.test(original.value.protocol||'')&&same(original.value,row),'canonical page pass differs from finished batch');
    }
    for(const row of review.value.pages)if(row.passed===false) {
        check(SHA.test(row.failureSha256||''),'canonical failure identity');
        const archived=read(path.join(batch.p.root,'failures',row.failureSha256+'.json'));
        const original=read(path.join(roots.publication,'page-review-failures',row.failureSha256+'.json'));
        check(original.sha256===archived.sha256,'canonical failure bytes differ from archive');
    }
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
    let current=adapter().loadConferenceAnalysis({analysisRoot:batch.analysisRoot,executionId:item.analysisRunId});
    check(current.analysisFileSha256===item.analysisProof.analysisSha256,'current pointer analysis CAS');
    for(let depth=0;depth<16;depth++) {
        if(current.run.executionId===adopted.executionId)return current.analysisFileSha256===adopted.analysisFileSha256
            &&current.runFileSha256===adopted.runFileSha256&&current.sourceFileSha256===adopted.sourceFileSha256;
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
    check(read(batch.p.manifest).sha256===batch.manifestFileSha256
        &&read(path.join(batch.p.root,'baseline-state.json')).sha256===batch.baseline.sha256
        &&read(path.join(batch.p.root,'generation.json')).sha256===batch.m.generationFileSha256
        &&read(path.join(batch.p.root,'review-batch.json')).sha256===batch.m.reviewBatchFileSha256,'immutable batch bytes changed');
    for(const member of batch.m.members)check(read(path.join(batch.p.root,'failures',member.failureSha256+'.json')).sha256===member.failureFileSha256,'immutable failure bytes changed');
    for(const classified of [...(batch.m.imageClassifications||[]),...(batch.m.markdownClassifications||[]),...(batch.m.aggregateClassifications||[]),...(batch.m.nativeReviewClassifications||[])])check(read(path.join(batch.p.root,'classifications',classified.classificationSha256+'.json')).sha256===classified.classificationFileSha256
        &&read(path.join(batch.p.root,'failures',classified.failureSha256+'.json')).sha256===classified.failureFileSha256,'immutable classification/failure bytes changed');
    const current=read(batch.p.state);api().assertState(current.value);
    if(current.sha256===batch.baseline.sha256)return current;
    if(fs.existsSync(path.join(batch.p.root,'registration.json'))&&current.sha256===registeredState(batch).sha256)return current;
    check(fs.existsSync(batch.p.adoption),'baseline changed without real adoption');
    const receipt=read(batch.p.adoption);self(receipt.value,'receiptSha256');
    const r=receipt.value,after=read(batch.p.after);api().assertState(after.value);
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
        &&same(seed.value,verifiedParentSeed(loaded.parent,member.reviewFeedback.trim())),'original-scope signed parent Reader seed changed');
    return {locator:loc,modelFeedback:member.reviewFeedback.trim(),member,revisionSeed:seed.value};
}
function assertReaderOutput(loaded,paper,parent) {
    const bound=loaded.readerReview||replayRevisionFeedback(loaded),stage=paper.analysisManifest?.stages?.apiReaderArticle;
    check(stage?.status==='complete'&&stage.reviewFeedbackSha256===bound.locator.reviewFeedbackSha256,'actual new Reader feedback identity');
    check(same(protectedScience(paper),protectedScience(parent)),'protected scientific upstream changed');
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
    const outcomes=new Map();
    // Complete children are always independently staged; progress flags never qualify them.
    for(const member of batch.m.members) {
        let actual=actualProgress(batch,member);
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
        const retryable=pending.filter(member=>!outcomes.has(member.paperId)
            &&(previous[member.paperId]?.executionId!==effectiveMember(batch,member).executionId
            ||previous[member.paperId]?.failure?.retryable!==false||previous[member.paperId]?.failure?.systemic===true)
            &&actualProgress(batch,member).attempts<3);
        if(!retryable.length)break;
        // Real persisted child attempts, not this invocation's loop counter,
        // finish all unstarted members of an interrupted round before retrying
        // members already attempted in that round.
        const minimumAttempt=Math.min(...retryable.map(member=>actualProgress(batch,member).attempts));
        const input=retryable.filter(member=>actualProgress(batch,member).attempts===minimumAttempt);
        await roundApi.runFailureRounds(input,{
            concurrency:options.concurrency||3,maxRounds:1,getItemId:member=>member.paperId,
            getProgressKey:member=>stable(actualProgress(batch,member).child?.analysis.readerRevisionProgress||{}),
            shouldStop:()=>{stop.assertMayStartRequest();return false;},
            onRoundStart:round=>{const current=progressFor(batch);adapter().replaceJson(batch.p.progress,
                {...current.value,roundIntents:[...(current.value.roundIntents||[]),{
                    inputIds:round.inputIds,normalRoundOrdinal:minimumAttempt+1,
                    startingAttempts:Object.fromEntries(input.map(member=>[member.paperId,actualProgress(batch,member).attempts])),
                    windowByPaper:Object.fromEntries(input.map(member=>[member.paperId,effectiveMember(batch,member).window?.windowId||null]))}]},current.sha256);},
            onRoundDone:round=>{const current=progressFor(batch);adapter().replaceJson(batch.p.progress,
                {...current.value,rounds:[...current.value.rounds,{...round,normalRoundOrdinal:minimumAttempt+1}]},current.sha256);},
            runItem:async member=>{
                const original=shared.retainedSources?.get(member.parentExecutionId);
                try {
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
                    if(actual.status==='complete'||actual.attempts===minimumAttempt&&!failure.systemic)failure.retryable=false;
                    saveMember(batch,member.paperId,{status:'failed',executionId:effectiveMember(batch,member).executionId,
                        failure,attempts:actualProgress(batch,member).attempts});
                    if(failure.systemic)stop.requestAnalysisStop(failure.code||'maintenance_failure');
                    return {success:false,error,retryable:failure.retryable&&!failure.systemic,
                        scope:failure.systemic?'run':'paper',budgetExhausted:actualProgress(batch,member).attempts>=3};
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
module.exports={bindCompletedParent,replayRevisionFeedback,assertReaderOutput,
    runReaderReviewMaintenanceBatch,assertNoPendingReaderReviewMaintenance,
    resolveRegisteredMaintenanceWindow,readMaintenanceRecoveryGrantMember,prepareParentRevisionSeed,readMaintenancePublicationHistory};
