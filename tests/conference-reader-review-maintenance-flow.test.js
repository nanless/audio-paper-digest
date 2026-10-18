'use strict';
// Control-flow draft with explicitly synthetic source/Reader/stage dependencies.
// Passing these tests never certifies a real paper, source or model response.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),vm=require('node:vm');
const {fixture,seal}=require('./helpers/conference-reader-review-maintenance-fixture');
const evidence=require('../scripts/lib/conference-reader-review-maintenance-evidence');const {sha,stable}=evidence;
const root=path.resolve(__dirname,'..');
const uid=seed=>{const s=sha(seed);return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;};
function setup(t,{failFirst=[],failTerminal=[]}={}) {
    const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'text-maintenance-draft-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
    const processId=uid('process'),batchId=uid('batch'),runtimeRoot=path.join(temp,'data/runtime'),analysisRoot=path.join(runtimeRoot,'conference-analysis-executions');
    const processDirectory=path.join(runtimeRoot,'conference-processes',processId),batchRoot=path.join(processDirectory,'review-reader-maintenance',batchId);
    const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});};
    const read=p=>{const b=fs.readFileSync(p);return {value:JSON.parse(b),sha256:sha(b)};};
    const input=fixture(),loadedParents=new Map(),surfaces=new Map(),events=[],stageCache=new Map();
    input.state.processId=input.generation.processId=input.manifest.processId=processId;input.manifest.batchId=batchId;
    input.generation.conferenceId='synthetic-conference';
    input.manifest.window={maxRounds:3,maxAttempts:3};
    for(const m of input.manifest.members) {
        const oldId=m.parentExecutionId,parentId=uid(oldId),parent=input.parents[oldId];
        m.parentExecutionId=parentId;m.executionId=uid(parentId+'child');
        input.state.items[m.paperId].analysisRunId=parentId;
        const surface=input.surfaces[oldId];surfaces.set(parentId,surface);
        const paper={id:m.paperId,analysis:'protected scientific body',parsed:{score:8},apiReaderArticle:'rejected phrase '+m.paperId.slice(-1),
            sourceSha256:m.sourceSha256,analysisManifest:{stages:{apiReaderArticle:{status:'complete'},scoringAudit:{status:'complete',score:8}}}};
        const analysis={status:'complete',papers:[paper]},run={...parent.run,executionId:parentId};
        const source={sourceDetails:{text:parent.sourceText,structuredArtifacts:{payloadSha256:sha('artifacts')}},
            sourceSnapshotBinding:{sourceBinding:{pdfSha256:m.pdfSha256,artifactsPayloadSha256:sha('artifacts')}},planAuthorityBinding:{synthetic:true}};
        const directory=path.join(analysisRoot,parentId);
        for(const [name,value] of Object.entries({analysis,run,source}))write(path.join(directory,name+'.json'),value);
        m.parentCAS={analysisFileSha256:read(path.join(directory,'analysis.json')).sha256,
            runFileSha256:read(path.join(directory,'run.json')).sha256,sourceFileSha256:read(path.join(directory,'source.json')).sha256};
        input.state.items[m.paperId].analysisProof.analysisSha256=m.parentCAS.analysisFileSha256;
        m.reviewFeedback+='\n'+m.sourceQuotes.join('\n');m.reviewFeedbackSha256=sha(m.reviewFeedback);
    }
    seal(input.state,'stateSha256');input.manifest.baselineStateSha256=input.state.stateSha256;
    seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;
    write(path.join(processDirectory,'state.json'),input.state);write(path.join(batchRoot,'baseline-state.json'),input.state);
    write(path.join(batchRoot,'generation.json'),input.generation);write(path.join(batchRoot,'review-batch.json'),input.reviewBatch);
    Object.assign(input.manifest,{stateFileSha256:read(path.join(batchRoot,'baseline-state.json')).sha256,
        generationFileSha256:read(path.join(batchRoot,'generation.json')).sha256,reviewBatchFileSha256:read(path.join(batchRoot,'review-batch.json')).sha256});
    for(const m of input.manifest.members) {
        write(path.join(batchRoot,'failures',m.failureSha256+'.json'),input.failures[m.failureSha256].value);
        m.failureFileSha256=read(path.join(batchRoot,'failures',m.failureSha256+'.json')).sha256;
    }
    for(const [id,saved] of Object.entries(input.failures))if(!fs.existsSync(path.join(batchRoot,'failures',id+'.json')))
        write(path.join(batchRoot,'failures',id+'.json'),saved.value);
    for(const classified of input.manifest.imageClassifications) {
        classified.failureFileSha256=read(path.join(batchRoot,'failures',classified.failureSha256+'.json')).sha256;
        write(path.join(batchRoot,'classifications',classified.classificationSha256+'.json'),input.imageClassifications[classified.classificationSha256].value);
        classified.classificationFileSha256=read(path.join(batchRoot,'classifications',classified.classificationSha256+'.json')).sha256;
    }
    seal(input.manifest,'manifestSha256');const manifestPath=path.join(batchRoot,'manifest.json');write(manifestPath,input.manifest);
    const publicationRoot=path.join(runtimeRoot,'conference-publications');
    const generationPath=path.join(publicationRoot,input.generation.conferenceId,processId,'generation.json');
    write(generationPath,input.generation);
    const reviewPath=path.join(publicationRoot,'page-review-batch-failures',input.reviewBatch.batchSha256+'.json');write(reviewPath,input.reviewBatch);
    for(const [id,saved] of Object.entries(input.failures))write(path.join(publicationRoot,'page-review-failures',id+'.json'),saved.value);
    for(const [id,saved] of Object.entries(input.passCaches))write(path.join(publicationRoot,'page-review-passes',id+'.json'),saved.value);
    let module;const bridgeState={sourceChecks:0};
    const adapter={READER_REVISION_CONTRACT:'conference-reader-source-revision-v1',readJsonRecord:read,
        readerRevisionExecutionId:parentId=>uid(parentId+'child'),
        writeBytesAtomic:(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});if(fs.existsSync(p))assert.deepEqual(fs.readFileSync(p),b);else fs.writeFileSync(p,b,{mode:0o600});},
        replaceJson:(p,v,expected)=>{assert.equal(read(p).sha256,expected);write(p,v);},
        loadConferenceAnalysis:({executionId})=>{
            const directory=path.join(analysisRoot,executionId),a=read(path.join(directory,'analysis.json')),
                run=read(path.join(directory,'run.json')),source=read(path.join(directory,'source.json'));
            return {directory,analysis:a.value,analysisFileSha256:a.sha256,run:run.value,runFileSha256:run.sha256,
                source:source.value,sourceFileSha256:source.sha256};
        },
        loadConferenceReaderRevision:({executionId})=>{
            const loaded=adapter.loadConferenceAnalysis({executionId}),revision=read(path.join(loaded.directory,'reader-revision.json')).value;
            loaded.revision=revision;loaded.parent=adapter.loadConferenceAnalysis({executionId:revision.parentExecutionId});
            loaded.readerReview=module.replayRevisionFeedback(loaded);return loaded;
        },
        refreshConferenceReader:async({parentExecutionId,reviewMaintenanceHandle,_testExecutionId,_testWindow})=>{
            const parent=adapter.loadConferenceAnalysis({executionId:parentExecutionId}),bound=module.bindCompletedParent(reviewMaintenanceHandle,parent);
            const base=input.manifest.members.find(m=>m.parentExecutionId===parentExecutionId),m={...base,executionId:_testExecutionId||base.executionId},directory=path.join(analysisRoot,m.executionId);
            const previous=fs.existsSync(path.join(directory,'analysis.json'))?read(path.join(directory,'analysis.json')).value:null;
            if(previous?.status==='complete')return {executionId:m.executionId};
            const attempts=(previous?.readerRevisionProgress?.attempts||0)+1;assert.ok(attempts<=3);
            events.push(m.paperId+':'+attempts);
            const failure=!_testWindow&&(failTerminal.includes(m.paperId)||failFirst.includes(m.paperId)&&attempts===1);
            const paper=structuredClone(parent.analysis.papers[0]);paper.apiReaderArticle='corrected normal Reader';
            paper.analysisManifest.stages.apiReaderArticle={status:'complete',reviewFeedbackSha256:bound.locator.reviewFeedbackSha256};
            const analysis={status:failure?'partial':'complete',papers:[paper],readerRevisionProgress:{attempts,failures:failure?[{code:'SYNTHETIC_CONTENT',retryable:!failTerminal.includes(m.paperId)}]:[]}};
            write(path.join(directory,'source.json'),parent.source);write(path.join(directory,'analysis.json'),analysis);
            write(path.join(directory,'run.json'),{...parent.run,executionId:m.executionId,status:failure?'source_ready':'complete'});
            write(path.join(directory,'review-reader-seed.json'),module.prepareParentRevisionSeed(reviewMaintenanceHandle,parent));
            const revision=seal({contract:_testWindow?'conference-reader-recovery-window-v1':adapter.READER_REVISION_CONTRACT,executionId:m.executionId,parentExecutionId,
                parentAnalysisFileSha256:parent.analysisFileSha256,parentRunFileSha256:parent.runFileSha256,
                paperId:m.paperId,sourceSnapshotSha256:m.sourceSnapshotSha256,mode:'reader-only',maxAttempts:3,readerReviewMaintenance:bound.locator,
                readerReviewSeedFileSha256:read(path.join(directory,'review-reader-seed.json')).sha256,
                ...(_testWindow?{grantId:_testWindow.windowId,grantSha256:_testWindow.manifestSha256}:{})},'revisionSha256');
            write(path.join(directory,'reader-revision.json'),revision);
            if(failure)throw Object.assign(new Error('synthetic content rejection'),{code:'SYNTHETIC_CONTENT',retryable:!failTerminal.includes(m.paperId),scope:'paper'});
            return {executionId:m.executionId};
        }};
    adapter.refreshConferenceGrantedRecovery=async args=>{
        const authority=module.readMaintenanceRecoveryGrantMember(args.grantHandle,input.manifest.members.find(m=>m.parentExecutionId===args.parentExecutionId).paperId);
        return adapter.refreshConferenceReader({...args,_testExecutionId:authority.expectedExecutionId,_testWindow:{windowId:authority.grantId,manifestSha256:authority.grantSha256}});
    };
    const recoveryMock={grantedRecoveryExecutionId:(grant,failed,hash)=>uid(grant+failed+hash),
        recoveryWindowMaterials:(_root,executionId)=>{
            const dir=path.join(analysisRoot,executionId),files=[];
            for(const name of fs.readdirSync(dir).sort())if(fs.statSync(path.join(dir,name)).isFile())files.push({path:name,sha256:sha(fs.readFileSync(path.join(dir,name)))});
            return {files,materialsSha256:stable(files),ledgerFileSha256:null};
        }};
    const processApi={assertState:value=>{const body=structuredClone(value);delete body.stateSha256;assert.equal(stable(body),value.stateSha256);return value;},
        stateDigest:value=>{const body=structuredClone(value);delete body.stateSha256;return stable(body);}};
    const stop={withModelRequestsForbidden:fn=>fn(),assertMayStartRequest:()=>{},requestAnalysisStop:()=>{}};
    const deps={adapter,engine:{withPaperAnalysisLock:async(_id,fn)=>fn()},files:{conferenceAnalysisDir:analysisRoot,
        conferencePageStagingDir:path.join(runtimeRoot,'conference-page-staging'),tagCatalogFile:'synthetic'},now:()=>new Date(0).toISOString(),postprocess:{
        stagePaper:({executionId})=>{
            const child=adapter.loadConferenceReaderRevision({executionId}),m=input.manifest.members.find(x=>x.paperId===child.run.paperId);
            const result={status:'staged',manifest:{paperId:m.paperId,analysisExecutionId:executionId,analysisSha256:child.analysisFileSha256,
                completionReceiptSha256:child.run.completionReceipt.receiptSha256,sourceSnapshotSha256:m.sourceSnapshotSha256,
                manifestSha256:sha('stage-'+executionId),pagePath:m.pagePath,contentSha256:sha('new-page-'+executionId)}};
            stageCache.set(executionId,result);return result;
        },loadStage:({executionId})=>stageCache.get(executionId)}};
    const sources=new Map(input.manifest.members.map(m=>[m.parentExecutionId,{planHandle:{synthetic:true},sourceRoot:'synthetic'}]));
    const requireFake=id=>{
        if(id==='node:fs')return fs;if(id==='node:path')return path;if(id==='node:os')return os;
        if(id==='node:async_hooks')return require('node:async_hooks');
        if(id==='node:child_process')return {spawnSync:(_binary,argv,options)=>{
            assert.equal(argv[argv.length-1],'3');const bytes=fs.readFileSync(options.stdio[3]),input=JSON.parse(bytes);
            const projected=Buffer.from(bridgeState.projected),scripts=path.join(temp,'scripts');
            return {status:0,stdout:JSON.stringify({contract:'conference-publication-figure-view-transform-output-v1',purpose:'pure-byte-transform-only',doesNotGrantSourceOrReviewOrPublication:true,
                rawPageSha256:input.rawPageSha256,projectedPageSha256:sha(projected),projectedPageBase64:projected.toString('base64'),size:projected.length,
                implementation:{viewModuleSha256:sha(fs.readFileSync(path.join(scripts,'conference_publication_figure_view.py'))),cliSha256:sha(fs.readFileSync(path.join(scripts,'conference_publication_figure_view_replay.py'))),nativeParserModuleSha256:sha(fs.readFileSync(path.join(scripts,'publish-to-blog.py')))}})};}};
        if(id==='./conference-publication-figure-crop')return {replayPublicationFigureCropsForMaintenance:(input,handle)=>{
            bridgeState.handle=handle;const scope=module.readMaintenancePublicationHistory(handle);assert.equal(scope.purpose,'reader-maintenance-historical-publication-evidence');
            assert.equal(scope.baselineState.status,'complete');scope.baselineState.status='tampered external clone';
            assert.equal(module.readMaintenancePublicationHistory(handle).baselineState.status,'complete');
            return {outcome:input.expectedDerivation,assertUnchanged:()=>{bridgeState.sourceChecks++;if(bridgeState.sourceChanged)throw Error('synthetic original PDF changed');}};
        }};
        // VM literals and host JSON have different prototypes; compare their
        // JSON structure only in this isolated dependency-injected draft test.
        if(id==='node:util')return {isDeepStrictEqual:(a,b)=>stable(a)===stable(b)};
        if(id==='../config')return {FILES:{conferenceAnalysisDir:analysisRoot,conferenceProcessDir:path.dirname(processDirectory),conferencePublicationDir:publicationRoot,conferencePageStagingDir:deps.files.conferencePageStagingDir,conferenceAggregateDir:path.join(runtimeRoot,'conference-aggregates')}};
        if(id==='./conference-reader-review-maintenance-evidence')return evidence;
        if(id==='./conference-analysis-adapter')return adapter;if(id==='./conference-process')return processApi;
        if(id==='./conference-recovery-grant')return recoveryMock;
        if(id==='./conference-reader-publication-evidence')return {replayCanonicalReaderPdfSource:()=>({syntheticSourceOnly:true})};
        if(id==='./conference-postprocess')return {readOriginalTagProof:()=>({rules:{syntheticOnly:true}})};
        if(id==='../analysis-engine')return {hasValidApiReaderV3Records:()=>true,isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>true};
        if(id==='../deep-analyzer')return {prepareApiReaderRevisionSeed:(paper,source,feedback)=>({syntheticOnly:true,
            initialDraft:JSON.stringify({originalSignedArticle:paper.apiReaderArticle}),metadata:{sourceSha256:sha(source),feedbackSha256:sha(feedback)}})};
        if(id==='./conference-analysis-context')return {withConferenceAnalysisSource:(_args,fn)=>fn()};
        if(id==='./reader-signed-draft-surface')return {reconstructReaderDraftSurface:({paper})=>({draft:surfaces.get(input.manifest.members.find(m=>m.paperId===paper.id).parentExecutionId)})};
        if(id==='./analysis-stop-control')return stop;
        if(id==='./conference-process-recovery')return {classifyFailure:error=>({code:error.code||'error',message:error.message,retryable:error.retryable!==false,systemic:error.scope==='run'})};
        if(id==='./analysis-failure-rounds')return require(path.join(root,'scripts/lib/analysis-failure-rounds.js'));
        throw new Error('unexpected dependency '+id);
    };
    const sandbox={require:requireFake,module:{exports:{}},Buffer,console,structuredClone};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8')+'\nmodule.exports.__testReplay=replayMaintenancePublicationView;module.exports.__testLoadBatch=loadBatch;',sandbox);
    module=sandbox.module.exports;
    return {module,adapter,deps,input,manifestPath,processDirectory,analysisRoot,batchRoot,read,write,events,
        recoveryMock,publicationRoot,generationPath,reviewPath,runtimeRoot,temp,bridgeState,shared:{retainedSources:sources},state:()=>read(path.join(processDirectory,'state.json')).value};
}
test('synthetic orchestration preserves parents, settles whole round, retries only failure, adopts actual children',async t=>{
    const h=setup(t,{failFirst:['synthetic-paper-0']});const parentHashes=h.input.manifest.members.map(m=>m.parentCAS.analysisFileSha256);
    const result=await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps);
    assert.equal(result.status,'adopted');assert.deepEqual(h.events,['synthetic-paper-0:1','synthetic-paper-1:1','synthetic-paper-0:2']);
    assert.equal(h.state().status,'running');assert.ok(Object.values(h.state().items).every(x=>x.status==='complete'));
    assert.deepEqual(h.input.manifest.members.map(m=>h.adapter.loadConferenceAnalysis({executionId:m.parentExecutionId}).analysisFileSha256),parentHashes);
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:h.state()}),/new complete process/);
});
test('unadopted complete baseline stays publication-blocked without model dispatch',t=>{
    const h=setup(t);assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:h.state()}),/obligation set mismatch/);
    assert.deepEqual(h.events,[]);
});
test('synthetic terminal child keeps original complete baseline and saved sibling; resume does not dispatch terminal again',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']}),before=structuredClone(h.state().items);
    const options={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    let result=await h.module.runReaderReviewMaintenanceBatch(options,h.deps);
    assert.equal(result.status,'reader_review_maintenance_pending');assert.equal(result.savedComplete,1);
    assert.deepEqual(h.state().items,before);assert.equal(h.state().status,'complete');
    assert.ok(fs.existsSync(path.join(h.analysisRoot,h.input.manifest.members[1].executionId,'analysis.json')));
    const calls=[...h.events];result=await h.module.runReaderReviewMaintenanceBatch({...options,state:h.state()},h.deps);
    assert.equal(result.status,'reader_review_maintenance_pending');assert.deepEqual(h.events,calls);
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:h.state()}),/pending real Reader maintenance/);
});
test('synthetic adoption receipt before CAS remains blocked, resumes saved children without new writing',async t=>{
    const h=setup(t),replace=h.adapter.replaceJson;let injected=false;
    h.adapter.replaceJson=(p,v,expected)=>{
        if(p===path.join(h.processDirectory,'state.json')&&v.status==='running'&&!injected){injected=true;throw new Error('synthetic crash before adoption CAS');}
        return replace(p,v,expected);
    };
    const args={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch(args,h.deps),/crash before adoption CAS/);
    assert.ok(fs.existsSync(path.join(h.batchRoot,'adoption.json')));assert.equal(h.state().status,'complete');
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:h.state()}),/has not adopted/);
    const calls=[...h.events];const result=await h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps);
    assert.equal(result.status,'adopted');assert.deepEqual(h.events,calls);
    const cold=await h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps);
    assert.equal(cold.status,'adopted');assert.deepEqual(h.events,calls);
});
test('synthetic real-adoption shape then new complete aggregate passes gate; changed after-state receipt refuses',async t=>{
    const h=setup(t);await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps);
    const state=h.state();state.status='complete';state.aggregate={syntheticOnly:true};state.completionReceiptSha256=sha('new synthetic completion');seal(state,'stateSha256');
    h.write(path.join(h.processDirectory,'state.json'),state);
    assert.equal(h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state}),true);
    const after=h.read(path.join(h.batchRoot,'adoption-after-state.json')).value;after.generation++;seal(after,'stateSha256');h.write(path.join(h.batchRoot,'adoption-after-state.json'),after);
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state}),/adoption baseline\/after CAS/);
});
test('synthetic independent continuation registers exact real partial-child set without changing complete process to partial',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']});
    const args={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    const first=await h.module.runReaderReviewMaintenanceBatch(args,h.deps);assert.equal(first.status,'reader_review_maintenance_pending');
    const before=h.read(path.join(h.processDirectory,'state.json')).sha256;
    const member=h.input.manifest.members[0],failed=h.adapter.loadConferenceReaderRevision({executionId:member.executionId});
    const oldPaidFailure=failed.analysisFileSha256,windowId=uid('new explicit independent window');
    const dir=path.join(h.batchRoot,'windows',windowId);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const progress=h.read(path.join(h.batchRoot,'progress.json'));h.write(path.join(dir,'baseline-progress.json'),progress.value);
    const material=h.recoveryMock.recoveryWindowMaterials(h.analysisRoot,member.executionId);
    const window=seal({contract:'conference-reader-review-maintenance-window-v1',version:1,processId:h.input.manifest.processId,
        batchId:h.input.manifest.batchId,windowId,baseManifestSha256:h.input.manifest.manifestSha256,previousWindowId:null,previousWindowSha256:null,
        baselineProgressFileSha256:h.read(path.join(dir,'baseline-progress.json')).sha256,
        limits:{maxRounds:3,readerContentResponses:6,readerFullResponses:2,readerTransportAttempts:2},
        members:[{paperId:member.paperId,failedExecutionId:member.executionId,failedAnalysisFileSha256:failed.analysisFileSha256,
            failedRunFileSha256:failed.runFileSha256,failedSourceFileSha256:failed.sourceFileSha256,
            failedRevisionFileSha256:h.read(path.join(failed.directory,'reader-revision.json')).sha256,
            materialsSha256:material.materialsSha256,ledgerFileSha256:null,
            expectedExecutionId:h.recoveryMock.grantedRecoveryExecutionId(windowId,member.executionId,failed.analysisFileSha256)}]},'manifestSha256');
    const filename=path.join(dir,'manifest.json');h.write(filename,window);
    const callsBefore=[...h.events],stateBeforeWindow=h.read(path.join(h.processDirectory,'state.json')).sha256;
    const badLimits=structuredClone(window);badLimits.limits.readerContentResponses=7;seal(badLimits,'manifestSha256');h.write(filename,badLimits);
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state(),options:{concurrency:1,readerReviewWindow:filename}},h.deps),/scope\/limits/);
    assert.equal(fs.existsSync(path.join(dir,'registration.json')),false);assert.deepEqual(h.events,callsBefore);
    const wrongSet=structuredClone(window);wrongSet.members.push({...wrongSet.members[0],paperId:'synthetic-paper-1'});seal(wrongSet,'manifestSha256');h.write(filename,wrongSet);
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state(),options:{concurrency:1,readerReviewWindow:filename}},h.deps),/exact independent-maintenance failed set/);
    h.write(filename,window);const pollution=path.join(failed.directory,'synthetic-new-fee-record.json');h.write(pollution,{syntheticOnly:true,noRealCharge:true});
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state(),options:{concurrency:1,readerReviewWindow:filename}},h.deps),/child\/CAS\/materials/);
    fs.unlinkSync(pollution);assert.equal(h.read(path.join(h.processDirectory,'state.json')).sha256,stateBeforeWindow);assert.deepEqual(h.events,callsBefore);
    // Registration is a separate normal-maintenance window, not an edit of old
    // state.status or the old process recovery grant's partial-only baseline.
    const result=await h.module.runReaderReviewMaintenanceBatch({...args,state:h.state(),options:{concurrency:1,readerReviewWindow:filename}},h.deps);
    assert.equal(result.status,'adopted',JSON.stringify(h.read(path.join(h.batchRoot,'progress.json')).value));assert.equal(h.state().status,'running');
    assert.equal(h.adapter.loadConferenceAnalysis({executionId:member.executionId}).analysisFileSha256,oldPaidFailure);
    assert.notEqual(h.state().items[member.paperId].analysisRunId,member.executionId);
    assert.ok(fs.existsSync(path.join(dir,'registration.json')));
    assert.notEqual(h.read(path.join(h.processDirectory,'state.json')).sha256,before);
});
test('registered obligation cannot disappear merely by removing its private registry directory',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']});
    await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps);
    const registry=path.dirname(h.batchRoot),outside=registry+'-temporarily-moved';fs.renameSync(registry,outside);
    try {assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:h.state()}),/obligation directory missing/);}
    finally {fs.renameSync(outside,registry);}
});

test('canonical publication original is mandatory even when private full-review archive is self-consistent',async t=>{
    for(const target of ['review','failure','generation']) {
        const h=setup(t),filename=target==='review'?h.reviewPath:target==='generation'?h.generationPath:
            path.join(h.publicationRoot,'page-review-failures',h.input.manifest.members[0].failureSha256+'.json');
        const before=h.read(path.join(h.processDirectory,'state.json')).sha256;fs.unlinkSync(filename);
        await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps));
        assert.equal(h.read(path.join(h.processDirectory,'state.json')).sha256,before);assert.deepEqual(h.events,[]);
    }
});
test('canonical superseded generation is accepted only by full exact SHA and unique original',async t=>{
    const h=setup(t),old=fs.readFileSync(h.generationPath),archived=path.join(path.dirname(h.generationPath),'generation.superseded-'+sha(old).slice(0,12)+'.json');
    fs.renameSync(h.generationPath,archived);h.write(h.generationPath,{differentActualGeneration:true});
    const args={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    assert.equal((await h.module.runReaderReviewMaintenanceBatch(args,h.deps)).status,'adopted');
    fs.writeFileSync(h.generationPath,old,{mode:0o600});
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps),/ambiguous/);
    fs.unlinkSync(h.generationPath);fs.writeFileSync(archived,Buffer.concat([old,Buffer.from(' ')]));
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps),/generation original/);
});
test('canonical review bytes are rechecked after cached admission and arbitrary UUID roots are refused',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']}),args={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    await h.module.runReaderReviewMaintenanceBatch(args,h.deps);
    fs.appendFileSync(h.reviewPath,' ');const calls=[...h.events];
    await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps),/canonical finished review/);assert.deepEqual(h.events,calls);
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot+'-other',state:h.state()}),/canonical process\/analysis roots/);
    assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:path.join(path.dirname(h.processDirectory)+'-other',path.basename(h.processDirectory)),analysisRoot:h.analysisRoot,state:h.state()}),/canonical process\/analysis roots/);
});

test('stale pre-registration FD state cannot hide a removed actual obligation registry',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']}),oldState=h.state();
    await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:oldState,shared:h.shared,options:{concurrency:1}},h.deps);
    const registry=path.dirname(h.batchRoot),moved=registry+'-moved';fs.renameSync(registry,moved);
    try {assert.throws(()=>h.module.assertNoPendingReaderReviewMaintenance({processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,state:oldState}),/FD state is stale/);}
    finally {fs.renameSync(moved,registry);}
});

// Synthetic second-phase wire fixture only. Its PDF/crop result and pure helper
// are explicitly mocked; this is NOT actual crop/source/Reader qualification.
function syntheticPublicationHistory(h) {
    const state=h.state(),g=structuredClone(h.input.generation),rawFiles=[],stages=new Map();
    for(const record of g.files.filter(x=>['paper','aggregate'].includes(x.kind))) {
        const raw=Buffer.from(record.kind==='aggregate'?'aggregate':record.paperId==='synthetic-image-only'?'image-page':'page-'+record.paperId.slice(-1));
        const directory=path.join(h.runtimeRoot,record.kind==='aggregate'?'conference-aggregates':'conference-page-staging',sha(record.path).slice(0,12));
        fs.mkdirSync(directory,{recursive:true,mode:0o700});const sourcePath=path.join(directory,record.kind==='aggregate'?'aggregate.md':'page.md');fs.writeFileSync(sourcePath,raw,{mode:0o600});
        let stage;
        if(record.kind==='paper') {
            if(!state.items[record.paperId])state.items[record.paperId]={status:'complete',analysisRunId:uid('unselected original'),analysisProof:{analysisSha256:sha('unselected analysis'),completionReceiptSha256:sha('unselected receipt'),sourceSnapshotSha256:sha('unselected source')}};
            const item=state.items[record.paperId];stage=seal({paperId:record.paperId,analysisExecutionId:item.analysisRunId,analysisSha256:item.analysisProof.analysisSha256,
                completionReceiptSha256:item.analysisProof.completionReceiptSha256,sourceSnapshotSha256:item.analysisProof.sourceSnapshotSha256,contentSha256:sha(raw),assets:[]},'manifestSha256');
            item.pageProof={pagePath:record.path,contentSha256:sha(raw),manifestSha256:stage.manifestSha256};
        } else {
            stage=seal({aggregateId:uid('synthetic aggregate'),conferenceId:g.conferenceId,pagePath:record.path,markdownSha256:sha(raw)},'manifestSha256');
            state.aggregate={aggregateId:stage.aggregateId,manifestSha256:stage.manifestSha256,pagePath:record.path,markdownSha256:sha(raw)};
        }
        h.write(path.join(directory,'manifest.json'),stage);stages.set(record.paperId,{stage,directory});
        rawFiles.push({...record,sourcePath,sourceSha256:sha(raw),size:raw.length,manifestSha256:stage.manifestSha256});
    }
    state.completionReceiptSha256=sha('real-shaped but synthetic completion');seal(state,'stateSha256');h.write(path.join(h.processDirectory,'state.json'),state);h.write(path.join(h.batchRoot,'baseline-state.json'),state);
    const sorted=rows=>rows.slice().sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),first=rawFiles.find(x=>x.paperId==='synthetic-paper-0');
    const derived=Buffer.from('explicit synthetic PNG bytes'),derivedPath=path.join(h.publicationRoot,g.conferenceId,state.processId,'figure-crop-derivations','synthetic.png');fs.mkdirSync(path.dirname(derivedPath),{recursive:true});fs.writeFileSync(derivedPath,derived,{mode:0o600});
    const node=seal({contract:'conference-publication-figure-crops-v1',purpose:'publication-display-only',conferenceId:g.conferenceId,processId:state.processId,baseGenerationSha256:sha('synthetic base'),baseGenerationFileSha256:sha('synthetic base file'),manifestFileSha256:sha('synthetic manifest'),
        status:'complete',publicationPassed:false,derivations:[{paperId:first.paperId,newImagePath:'synthetic/new.png',derivedSourcePath:derivedPath,sha256:sha(derived),size:derived.length,proofSha256:sha('synthetic proof')}],blocked:[],deferredRoutes:[],unresolvedRoutes:[]},'derivationSha256');
    const projected=Buffer.from('synthetic exact projected view bytes');h.bridgeState.projected=projected;
    const projectedPath=path.join(h.publicationRoot,g.conferenceId,state.processId,'figure-publication-views',node.derivationSha256,sha(projected)+'.md');fs.mkdirSync(path.dirname(projectedPath),{recursive:true});fs.writeFileSync(projectedPath,projected,{mode:0o600});
    g.files=sorted(rawFiles.map(x=>x.path===first.path?{...x,sourcePath:projectedPath,sourceSha256:sha(projected),size:projected.length}:x));
    g.imageFiles=[{kind:'asset',paperId:first.paperId,path:node.derivations[0].newImagePath,sourcePath:derivedPath,manifestSha256:node.derivations[0].proofSha256,sourceSha256:sha(derived),size:derived.length}];g.completionReceiptSha256=state.completionReceiptSha256;
    g.figurePublicationView=seal({contract:'conference-publication-figure-view-v1',version:1,conferenceId:g.conferenceId,processId:state.processId,manifestPath:path.join(h.publicationRoot,'synthetic-manifest.json'),baseGenerationSha256:node.baseGenerationSha256,baseGenerationFileSha256:node.baseGenerationFileSha256,
        rawFiles:sorted(rawFiles),rawImageFiles:[],rawBundleSha256:stable({completionReceiptSha256:state.completionReceiptSha256,files:sorted(rawFiles),imageFiles:[]}),nodeDerivation:node,
        changedPages:[{path:first.path,paperId:first.paperId,rawPageSha256:first.sourceSha256,publicationViewSha256:sha(projected)}]},'viewSha256');
    seal(g,'generationSha256');h.write(h.generationPath,g);h.write(path.join(h.batchRoot,'generation.json'),g);
    const m=h.input.manifest;m.generationSha256=g.generationSha256;m.generationFileSha256=h.read(h.generationPath).sha256;m.baselineStateSha256=state.stateSha256;m.stateFileSha256=h.read(path.join(h.batchRoot,'baseline-state.json')).sha256;seal(m,'manifestSha256');h.write(h.manifestPath,m);
    for(const name of ['conference_publication_figure_view.py','conference_publication_figure_view_replay.py','publish-to-blog.py','python-runtime.sh']){const filename=path.join(h.temp,'scripts',name);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,'explicit synthetic implementation '+name,{mode:0o644});}
    const batch={m,p:{root:h.batchRoot,state:path.join(h.processDirectory,'state.json'),manifest:h.manifestPath},processDirectory:h.processDirectory,analysisRoot:h.analysisRoot,manifestFileSha256:h.read(h.manifestPath).sha256,baseline:h.read(path.join(h.batchRoot,'baseline-state.json')),parents:{}};
    return {batch,g,stages,projectedPath};
}
test('history-only opaque token rejects JSON callers and actual cached-source assertion remains mandatory',t=>{
    const h=setup(t);assert.throws(()=>h.module.readMaintenancePublicationHistory({}),/opaque maintenance history token/);
    const f=syntheticPublicationHistory(h),proof=h.module.__testReplay(f.batch,f.g);
    assert.equal(proof.rawFiles.length,4);proof.assertUnchanged();const old=h.bridgeState.sourceChecks;
    h.bridgeState.sourceChanged=true;assert.throws(()=>proof.assertUnchanged(),/original PDF changed/);assert.ok(h.bridgeState.sourceChecks>old);
});
test('history view protects actual state, projected bytes, implementation and original aggregate pins',t=>{
    for(const change of ['state','projected','implementation','aggregate']) {
        const h=setup(t),f=syntheticPublicationHistory(h),proof=h.module.__testReplay(f.batch,f.g);
        if(change==='state'){const state=h.state();state.generation++;seal(state,'stateSha256');h.write(path.join(h.processDirectory,'state.json'),state);}
        if(change==='projected')fs.appendFileSync(f.projectedPath,'wrong bytes');
        if(change==='implementation')fs.appendFileSync(path.join(h.temp,'scripts/conference_publication_figure_view.py'),' changed');
        if(change==='aggregate')fs.appendFileSync(path.join(f.stages.get(undefined).directory,'aggregate.md'),' changed');
        assert.throws(()=>proof.assertUnchanged(),/actual state changed|material changed/);
    }
});
test('self-consistent view missing a baseline paper or mismatching true aggregate is not authenticated by JSON hashes',t=>{
    for(const change of ['paper','aggregate']) {
        const h=setup(t),f=syntheticPublicationHistory(h);
        if(change==='paper')f.g.figurePublicationView.rawFiles=f.g.figurePublicationView.rawFiles.filter(x=>x.paperId!=='synthetic-image-only');
        else f.batch.baseline.value.aggregate.manifestSha256=sha('not the actual aggregate');
        seal(f.g.figurePublicationView,'viewSha256');
        assert.throws(()=>h.module.__testReplay(f.batch,f.g),/every baseline paper|raw bundle completion|aggregate does not bind/);
    }
});
test('history raw image cannot borrow another paper stage even if every declared SHA and raw-bundle hash is rebuilt',t=>{
    const h=setup(t),f=syntheticPublicationHistory(h),owner=f.stages.get('synthetic-paper-0');
    const data=Buffer.from('explicit synthetic original asset'),assetPath='static/images/conference/old.png',filename=path.join(owner.directory,'assets',assetPath);
    fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,data,{mode:0o600});
    owner.stage.assets=[{path:assetPath,sha256:sha(data),size:data.length}];seal(owner.stage,'manifestSha256');h.write(path.join(owner.directory,'manifest.json'),owner.stage);
    const state=h.state();state.items['synthetic-paper-0'].pageProof.manifestSha256=owner.stage.manifestSha256;seal(state,'stateSha256');h.write(path.join(h.processDirectory,'state.json'),state);h.write(path.join(h.batchRoot,'baseline-state.json'),state);f.batch.baseline=h.read(path.join(h.batchRoot,'baseline-state.json'));
    const view=f.g.figurePublicationView;view.rawFiles.find(x=>x.paperId==='synthetic-paper-0').manifestSha256=owner.stage.manifestSha256;
    f.g.files.find(x=>x.paperId==='synthetic-paper-0').manifestSha256=owner.stage.manifestSha256;
    const wrong={kind:'asset',paperId:'synthetic-paper-1',path:'old.png',sourcePath:filename,manifestSha256:owner.stage.manifestSha256,sourceSha256:sha(data),size:data.length};
    view.rawImageFiles=[wrong];f.g.imageFiles.unshift(wrong);view.rawBundleSha256=stable({completionReceiptSha256:state.completionReceiptSha256,files:view.rawFiles,imageFiles:view.rawImageFiles});seal(view,'viewSha256');seal(f.g,'generationSha256');
    h.write(h.generationPath,f.g);h.write(path.join(h.batchRoot,'generation.json'),f.g);
    Object.assign(f.batch.m,{stateFileSha256:f.batch.baseline.sha256,baselineStateSha256:state.stateSha256,generationSha256:f.g.generationSha256,generationFileSha256:h.read(h.generationPath).sha256});seal(f.batch.m,'manifestSha256');h.write(h.manifestPath,f.batch.m);f.batch.manifestFileSha256=h.read(h.manifestPath).sha256;
    assert.throws(()=>h.module.__testReplay(f.batch,f.g),/raw asset ownership\/path\/manifest differs/);
});
test('synthetic full loader replays archived view again after true maintenance adoption without treating old parent as current',async t=>{
    const h=setup(t),f=syntheticPublicationHistory(h),member=h.input.manifest.members[0];
    const newPage=f.g.files.find(x=>x.paperId===member.paperId),oldFailure=h.read(path.join(h.batchRoot,'failures',member.failureSha256+'.json')).value;
    oldFailure.sha256=newPage.sourceSha256;seal(oldFailure,'failureSha256');
    const failureFile=path.join(h.batchRoot,'failures',oldFailure.failureSha256+'.json');h.write(failureFile,oldFailure);
    h.write(path.join(h.publicationRoot,'page-review-failures',oldFailure.failureSha256+'.json'),oldFailure);
    const review=h.read(path.join(h.batchRoot,'review-batch.json')).value;
    review.pages[0]={...oldFailure,message:'synthetic full normal review'};seal(review,'batchSha256');
    h.write(path.join(h.batchRoot,'review-batch.json'),review);h.write(path.join(h.publicationRoot,'page-review-batch-failures',review.batchSha256+'.json'),review);
    Object.assign(member,{pageSha256:newPage.sourceSha256,failureSha256:oldFailure.failureSha256,failureFileSha256:h.read(failureFile).sha256});
    Object.assign(h.input.manifest,{reviewBatchSha256:review.batchSha256,reviewBatchFileSha256:h.read(path.join(h.batchRoot,'review-batch.json')).sha256});seal(h.input.manifest,'manifestSha256');h.write(h.manifestPath,h.input.manifest);
    const args={manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}};
    const result=await h.module.runReaderReviewMaintenanceBatch(args,h.deps);assert.equal(result.status,'adopted');
    assert.notEqual(h.state().items[member.paperId].analysisRunId,member.parentExecutionId);assert.equal(h.state().status,'running');
    const calls=[...h.events],checks=h.bridgeState.sourceChecks;
    const resumed=await h.module.runReaderReviewMaintenanceBatch({...args,state:h.state()},h.deps);
    assert.equal(resumed.status,'adopted');assert.deepEqual(h.events,calls);assert.ok(h.bridgeState.sourceChecks>checks);
});
test('canonical pass cache removal or altered bytes cannot enter paid maintenance',async t=>{
    for(const mutate of ['remove','alter']) {
        const h=setup(t),row=h.input.reviewBatch.pages.find(x=>x.passed===true),file=path.join(h.publicationRoot,'page-review-passes',stable({path:row.path,sha256:row.sha256})+'.json');
        if(mutate==='remove')fs.unlinkSync(file);else{const value=h.read(file).value;value.protocol=sha('unissued protocol');h.write(file,value);}
        const before=h.read(path.join(h.processDirectory,'state.json')).sha256;
        await assert.rejects(()=>h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps));
        assert.deepEqual(h.events,[]);assert.equal(h.read(path.join(h.processDirectory,'state.json')).sha256,before);
    }
});
function migrationAdmissionHarness(h) {
    const events=[],processApi={defaultDependencies:()=>({}),assertState:v=>v,safeProcessDirectory:()=>h.processDirectory,authorityWithoutTagCatalog:()=>({}),
        stableHash:()=>{events.push('after-pending-guard');throw Error('after read-only admission marker');}};
    const requireFake=id=>{
        if(id==='node:fs')return fs;if(id==='node:path')return path;
        if(id==='./env-loader.js')return {requireExternalRuntime:()=>{}};
        if(id==='./lib/conference-process.js')return processApi;
        if(id==='./conference-process.js')return {readSafeJson:p=>h.read(p).value};
        if(id==='./lib/conference-process-recovery.js'||id==='./lib/conference-retained-source-replay.js')return {};
        if(id==='./lib/analysis-stop-control')return {withAnalysisStopControl:fn=>fn()};
        if(id==='./lib/conference-reader-review-maintenance')return h.module;
        if(id==='./lib/conference-recovery-grant')return {openRecoveryGrant:()=>{events.push('grant-install');throw Error('unexpected grant install');}};
        throw Error('unexpected migration dependency '+id);
    };
    const sandbox={require:requireFake,module:{exports:{}},Buffer,process,console};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/migrate-conference-process.js'),'utf8'),sandbox);
    const deps={files:{conferenceProcessDir:path.dirname(h.processDirectory),conferenceAnalysisDir:h.analysisRoot},loadAuthority:()=>({members:[],authority:{}}),
        engine:{withOperationLock:(_name,fn)=>fn(),withFileLock:(_name,fn)=>fn()}};
    return {events,run:options=>sandbox.module.exports.migrateAndRun({fromProcessId:h.input.manifest.processId,...options},{dependencies:deps})};
}
test('ordinary migration cannot move pending baseline or install a grant; same explicit maintenance flag may resume',async t=>{
    const h=setup(t,{failTerminal:['synthetic-paper-0']});
    await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps);
    const before=h.read(path.join(h.processDirectory,'state.json')).sha256,migration=migrationAdmissionHarness(h);
    await assert.rejects(()=>migration.run({recoveryManifest:'/explicit-test-marker'}),/pending real Reader maintenance/);
    assert.deepEqual(migration.events,[]);assert.equal(h.read(path.join(h.processDirectory,'state.json')).sha256,before);
    await assert.rejects(()=>migration.run({readerReviewFeedback:h.manifestPath}),/after read-only admission marker/);
    assert.deepEqual(migration.events,['after-pending-guard']);assert.equal(h.read(path.join(h.processDirectory,'state.json')).sha256,before);
});
test('historical fully adopted maintenance plus new complete aggregate does not block ordinary migration',async t=>{
    const h=setup(t);await h.module.runReaderReviewMaintenanceBatch({manifestPath:h.manifestPath,directory:h.processDirectory,state:h.state(),shared:h.shared,options:{concurrency:1}},h.deps);
    const state=h.state();state.status='complete';state.aggregate={syntheticOnly:true};state.completionReceiptSha256=sha('new complete aggregate');seal(state,'stateSha256');h.write(path.join(h.processDirectory,'state.json'),state);
    const migration=migrationAdmissionHarness(h);await assert.rejects(()=>migration.run({}),/after read-only admission marker/);assert.deepEqual(migration.events,['after-pending-guard']);
});

test('direct exported migration options cannot install a grant before exclusive maintenance admission',t=>{
    const h=setup(t),migration=migrationAdmissionHarness(h);
    for(const conflict of ['postprocessOnly','preserveFailedReaders','retryFailed','recoveryManifest','readerCorrections','sourceCorrections'])
        assert.throws(()=>migration.run({readerReviewFeedback:h.manifestPath,[conflict]:conflict.endsWith('Manifest')?'/explicit-test-marker':true}),/exclusive normal feedback mode/);
    assert.throws(()=>migration.run({readerReviewWindow:'/explicit-window-only'}),/exclusive normal feedback mode/);assert.deepEqual(migration.events,[]);
});


// Synthetic file-admission tests only; the fixture source APIs remain mocked.
function loadSyntheticBatch(h) {
    return h.module.__testLoadBatch({manifestPath:h.manifestPath,processDirectory:h.processDirectory,analysisRoot:h.analysisRoot});
}
test('publisher generation permission: fixed current original accepts only 0600 or 0644',t=>{
    for(const mode of [0o600,0o644]) {
        const h=setup(t);fs.chmodSync(h.generationPath,mode);
        assert.equal(loadSyntheticBatch(h).m.batchId,h.input.manifest.batchId);
        assert.deepEqual(h.events,[]);
    }
});
test('publisher generation permission: unique exact superseded 0644 original preserves full SHA',t=>{
    const h=setup(t),bytes=fs.readFileSync(h.generationPath),archived=path.join(path.dirname(h.generationPath),'generation.superseded-'+sha(bytes).slice(0,12)+'.json');
    fs.renameSync(h.generationPath,archived);fs.chmodSync(archived,0o644);h.write(h.generationPath,{changed:true});fs.chmodSync(h.generationPath,0o644);
    assert.equal(loadSyntheticBatch(h).m.batchId,h.input.manifest.batchId);
    fs.writeFileSync(h.generationPath,bytes);assert.throws(()=>loadSyntheticBatch(h),/ambiguous/);
    fs.unlinkSync(h.generationPath);fs.appendFileSync(archived,' ');assert.throws(()=>loadSyntheticBatch(h),/generation original/);
});
test('publisher generation permission: private 0644 evidence remains rejected',t=>{
    for(const name of ['manifest.json','generation.json','review-batch.json','baseline-state.json']) {
        const h=setup(t);fs.chmodSync(path.join(h.batchRoot,name),0o644);
        assert.throws(()=>loadSyntheticBatch(h),/private single-link/);
    }
});
test('publisher generation permission: other original modes remain rejected',t=>{
    for(const mode of [0o640,0o664,0o444,0o700]) {
        const h=setup(t);fs.chmodSync(h.generationPath,mode);
        assert.throws(()=>loadSyntheticBatch(h),/canonical generation file mode/);
    }
});
test('publisher generation permission: symlink and hardlink originals remain rejected',t=>{
    for(const kind of ['symlink','hardlink']) {
        const h=setup(t),real=h.generationPath+'.real';fs.renameSync(h.generationPath,real);
        fs[kind==='symlink'?'symlinkSync':'linkSync'](real,h.generationPath);
        assert.throws(()=>loadSyntheticBatch(h),/symlink|single-link/);
    }
});
