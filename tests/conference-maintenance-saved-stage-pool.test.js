'use strict';
// Real function bodies with explicitly synthetic source/Reader dependencies.
// These tests exercise job/CAS handoff only and certify no real paper.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {sha,stable}=require('../scripts/lib/conference-reader-review-maintenance-evidence');
const source=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const sessionBody=source.slice(source.indexOf('function savedMaintenanceStageItem('),source.indexOf('async function stageMaintenanceSavedMembers('));
const runnerBody=source.slice(source.indexOf('async function stageMaintenanceSavedMembers('),source.indexOf('async function runReaderReviewMaintenanceBatch('));
const compare=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
function sessionFixture() {
 const member={paperId:'p',executionId:'child',parentExecutionId:'parent',parentCAS:{analysisFileSha256:'parent-analysis'},sourceSnapshotSha256:'snapshot'};
 const batch={analysisRoot:'/synthetic/analysis',m:{members:[member]}};
 const state={items:{p:{paperId:'p',status:'complete',analysisRunId:'parent',analysisProof:{analysisSha256:'parent-analysis'}}}};
 const loaded={analysis:{status:'complete'},run:{status:'complete',paperId:'p',sourceSnapshotSha256:'snapshot',completionReceipt:{receiptSha256:'receipt'}},analysisFileSha256:'child-analysis'};
 const item={paperId:'p',status:'complete',analysisRunId:'child',analysisProof:{analysisSha256:'child-analysis',completionReceiptSha256:'receipt',sourceSnapshotSha256:'snapshot'}};
 const task={paperId:'p',executionId:'child',itemSha256:stable(item)},retained=Object.freeze({actualTestOpaque:true}),events=[];
 const deps={postprocess:{stagePaper:input=>{assert.equal(input.retained,retained);events.push('normal source+Reader+render+stage');return {status:'staged',manifest:{synthetic:true}};}}};
 const context={module:{exports:{}},Map,Object,fs:{existsSync:()=>true},path,stable,adapter:()=>({loadConferenceAnalysis:()=>loaded}),
  check:(value,message)=>{if(!value)throw Error(message)},effectiveMember:(_batch,m)=>m,loadBatch:()=>batch,
  assertCurrentBatch:()=>({value:state}),observeAndStageSavedMember:(b,m,shared,local)=>{
   assert.equal(b,batch);assert.equal(m,member);assert.equal(shared.retainedSources.get('parent'),retained);
   const staged=local.postprocess.stagePaper({retained});return {actual:{status:'complete'},proof:{synthetic:true},staged};
  }};
 vm.runInNewContext(sessionBody+';module.exports=openSavedMaintenanceStageSession;',context);
 return {session:context.module.exports({},deps),member,state,loaded,task,item,retained,events,deps};
}
test('maintenance worker derives task from its own real-batch path and uses actual parent source for normal staging',()=>{
 const h=sessionFixture();compare(h.session.readTask(h.task),h.item);
 assert.equal(h.session.parentItem(h.task),h.state.items.p);
 assert.equal(h.session.stage(h.task,h.retained).status,'staged');assert.equal(h.events.length,1);
});
for(const mutation of ['paper','execution','metadata','status','source','parent'])test('maintenance worker rejects job/state/parent drift before stage: '+mutation,()=>{
 const h=sessionFixture();
 if(mutation==='paper')h.task.paperId='other';
 if(mutation==='execution')h.task.executionId='other';
 if(mutation==='metadata')h.task.itemSha256='forged';
 if(mutation==='status')h.loaded.run.status='source_ready';
 if(mutation==='source')h.loaded.run.sourceSnapshotSha256='other';
 if(mutation==='parent')h.state.items.p.analysisProof.analysisSha256='other';
 assert.throws(()=>{h.session.parentItem(h.task);h.session.stage(h.task,h.retained)});assert.equal(h.events.length,0);
});
function runnerFixture({errorAt=null,runFault=false,drift=false}={}) {
 const members=[0,1,2].map(n=>({paperId:'p'+n,executionId:'child'+n})),items=members.map(m=>({paperId:m.paperId,status:'complete',analysisRunId:m.executionId,
  analysisProof:{analysisSha256:'a'+m.paperId,completionReceiptSha256:'receipt',sourceSnapshotSha256:'source'}}));
 const batch={m:{members},p:{state:'state',manifest:'manifest'},analysisRoot:'analysis',processDirectory:'process'},outcomes=new Map(),saved=[],events=[],seen=[];
 const revision={contract:'synthetic-revision'},revisionSha=sha(JSON.stringify(revision));let init;
 const loaded=item=>({directory:'analysis/'+item.analysisRunId,analysisFileSha256:item.analysisProof.analysisSha256,
  runFileSha256:'r'+item.paperId,sourceFileSha256:'s'+item.paperId,run:{completionReceipt:{receiptSha256:'receipt'}},analysis:{readerRevisionProgress:{attempts:2}}});
 const pool={operationLockStamp:()=>({syntheticOwner:true}),readVerifiedStageResult:(result,item)=>{events.push('verify actual manifest/assets:'+item.paperId);return {manifest:result.manifest,loaded:loaded(item)};},
  assertStageCanonical:(_result,item)=>{events.push('verify canonical:'+item.paperId);return loaded(item)},
  runStagePool:async (selected,options)=>{
   init=options;for(const item of selected) {
    seen.push(item.paperId);options.shouldStop();
    if(item.paperId===errorAt)await options.onResult(item,undefined,Object.assign(Error('synthetic local failure'),{code:runFault?'EIO':'CONTENT',scope:runFault?'run':'paper'}));
    else await options.onResult(item,{manifest:{manifestSha256:'manifest-'+item.paperId,pagePath:item.paperId+'.md',contentSha256:'page-'+item.paperId},
     pins:{extra:{'reader-revision.json':drift?'forged':revisionSha}}});
   }
  }};
 const deps={files:{conferencePageStagingDir:'staging'},adapter:{},postprocess:{implementationFingerprint:()=>({implementationSha256:'projection'})},now:()=>new Date(0).toISOString()};
 const globals={module:{exports:{}},Map,Set,Object,setImmediate,process:{stderr:{write:()=>{}}},stable,
  savedMaintenanceStageItem:(_batch,member)=>items.find(item=>item.paperId===member.paperId),
  adapter:()=>({loadConferenceAnalysis:({executionId})=>loaded(items.find(item=>item.analysisRunId===executionId))}),
  read:file=>file==='state'?{sha256:'state-physical',value:{stateSha256:'state-semantic'}}:{sha256:revisionSha,value:revision},
  api:()=>({loadAuthority:()=>({authority:{tagCatalogSha256:'registry'}})}),path,
  check:(v,m)=>{if(!v)throw Error(m)},effectiveMember:(_b,m)=>m,
  saveMember:(_b,id,value)=>saved.push({id,value}),assertCurrentBatch:()=>events.push('final actual batch'),
  require:id=>id==='./analysis-stop-control'?{assertMayStartRequest:()=>{}}:id==='./conference-complete-stage-pool'?pool:
   id==='./conference-process-recovery'?require('../scripts/lib/conference-process-recovery'):(()=>{throw Error(id)})()};
 vm.runInNewContext(runnerBody+';module.exports=stageMaintenanceSavedMembers;',globals);
 const run=()=>globals.module.exports({batch,shared:{},options:{postprocessConcurrency:5,concurrency:1},outcomes},deps);
 return {run,saved,outcomes,seen,events,get init(){return init}};
}
test('master consumes independent postprocess concurrency, verifies returned real bytes before saving each success',async()=>{
 const h=runnerFixture(),handled=await h.run();assert.equal(handled.size,3);assert.equal(h.init.concurrency,5);
 assert.equal(h.init.init.operation,'maintenance-saved-stage');assert.equal(h.init.init.maintenanceManifestPath,'manifest');
 assert.equal(h.outcomes.size,3);assert.equal(h.saved.length,3);
 assert.ok(h.events.includes('verify actual manifest/assets:p0'));assert.ok(h.events.includes('final actual batch'));
});
test('ordinary local stage failure is preserved and remaining complete children still finish, without new analysis',async()=>{
 const h=runnerFixture({errorAt:'p0'}),handled=await h.run();assert.equal(handled.size,3);assert.deepEqual(h.seen,['p0','p1','p2']);
 assert.equal(h.outcomes.size,2);assert.equal(h.saved[0].value.status,'failed');assert.equal(h.saved[0].value.attempts,2);
 assert.equal(h.saved[0].value.failure.retryable,false);assert.equal(h.saved[2].value.status,'complete');
});
test('real run-level/storage failure stops new master jobs; copied revision proof cannot be accepted',async()=>{
 const h=runnerFixture({errorAt:'p0',runFault:true});await assert.rejects(h.run,/synthetic local failure/);assert.deepEqual(h.seen,['p0']);assert.equal(h.saved.length,0);
 const other=runnerFixture({drift:true});await assert.rejects(other.run,/handoff revision changed/);assert.equal(other.saved.length,0);
});
test('fixed production worker rebuilds maintenance from actual authority and source under its own paper lock',()=>{
 const pool=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-complete-stage-pool.js'),'utf8');
 for(const text of ['openSavedMaintenanceStageSession','maintenance.parentItem(task)','maintenance.stage(task,original)',
  'deps.engine.withPaperAnalysisLock','canonicalPins(item)','verifyStageResult','assertOperationLock(directory, init.operationLock)'])assert.ok(pool.includes(text));
});
