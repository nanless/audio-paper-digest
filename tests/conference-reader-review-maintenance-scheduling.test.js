'use strict';
// Exact normal scheduler body, with explicitly synthetic children/source/stage.
// These tests grant no real Reader, source, fee or publication qualification.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stable}=require('../scripts/lib/conference-reader-review-maintenance-evidence');
const rounds=require('../scripts/lib/analysis-failure-rounds');
const source=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const body=source.slice(source.indexOf('async function runReaderReviewMaintenanceBatch('),source.indexOf('\nfunction assertNoPendingReaderReviewMaintenance('));
function setup({count=4,existing=0,alwaysFail=null,stopAt=null,savedComplete=null,badSaved=false,mutateAfterIntent=false,blocked=null,denyRepeatedSuccessReads=false,stopAfterStage=false,stopDuringScheduling=false}={}){
 const members=Array.from({length:count},(_,i)=>({paperId:'paper-'+i,executionId:'child-'+i,parentExecutionId:'parent-'+i}));
 const records=new Map(members.slice(0,existing).map(m=>[m.paperId,{attempts:1,status:'partial'}]));
 const events=[],stageChecks=[],reads=[],progress={members:{},rounds:[],roundIntents:[]};
 let stopped=false,forbiddenDepth=0;
 if(blocked)progress.members[blocked]={executionId:members.find(m=>m.paperId===blocked).executionId,failure:{retryable:false,systemic:false}};
 const state={stateSha256:'state'},batch={m:{members,manifestSha256:'manifest',processId:'process'},p:{state:'state',progress:'progress',adoption:'none'},analysisRoot:'analysis'};
 const opaque=new WeakMap();
 const actualProgress=(_batch,m)=>{reads.push(m.paperId);if(stopDuringScheduling&&reads.length===count+1)setImmediate(()=>{stopped=true;});const r=records.get(m.paperId);if(denyRepeatedSuccessReads&&progress.rounds.length&&r?.status==='complete')throw Error('successful child was cold-read in a later scheduling phase');return r?{...r,child:{analysis:{readerRevisionProgress:{attempts:r.attempts,failures:r.status==='partial'?[{code:'CONTENT'}]:[]}}}}:{attempts:0,status:'absent'};};
 const adapter={replaceJson:(_file,value)=>{
  Object.assign(progress,value);
  if(mutateAfterIntent&&progress.roundIntents.length===1){records.set(members[0].paperId,{attempts:1,status:'partial'});mutateAfterIntent=false;}
 },replaySavedConferenceReaderRevision:async({executionId})=>{
  const m=members.find(m=>m.executionId===executionId);if(m?.paperId===savedComplete)records.set(m.paperId,{attempts:1,status:'complete'});
 },refreshConferenceReader:async({parentExecutionId})=>{
  const m=members.find(m=>m.parentExecutionId===parentExecutionId),r=records.get(m.paperId),attempt=(r?.attempts||0)+1;
  assert.ok(attempt<=3);events.push({id:m.paperId,attempt});
  const failure=m.paperId===alwaysFail||m.paperId===stopAt;
  records.set(m.paperId,{attempts:attempt,status:failure?'partial':'complete'});
  if(failure)throw Object.assign(new Error('synthetic content or transport'),{retryable:true,scope:m.paperId===stopAt?'run':'paper',code:m.paperId===stopAt?'PROXY_CONNECT_TIMEOUT':'CONTENT'});
 }};
 const check=(v,message)=>{if(!v)throw Error(message);};
 const globals={module:{exports:{}},Map,Set,Object,Math,structuredClone,setImmediate,stable,fs:{existsSync:()=>false},opaque,
  openMaintenanceBatch:()=>{const h={};opaque.set(h,batch);return h;},registerPendingObligation:()=>{},
  read:()=>({value:state,sha256:'physical'}),progressFor:()=>({value:structuredClone(progress),sha256:'progress-sha'}),
  effectiveMember:(_batch,m)=>m,actualProgress,adapter:()=>adapter,check,
  // This suite extracts only scheduler control flow; the exact cold transaction
  // and physical member-CAS fences have their own real-temp-file tests.
  observeAndStageSavedMember:(_batch,m,shared,deps)=>{forbiddenDepth++;try {
   const actual=actualProgress(_batch,m);return {actual,proof:actual.status==='complete'?globals.stageChild(_batch,m,shared,deps):null};
  }finally{forbiddenDepth--;}},
  recoverUnissuedMaintenanceChild:async()=>false,
  // Gate selection has dedicated real-body tests; preserve this scheduler-only fixture.
  shouldDeferInitialSavedReplayToNormal:()=>false,
  stageChild:(_batch,m)=>{stageChecks.push(m.paperId);if(stopAfterStage)setImmediate(()=>{stopped=true;});assert.equal(records.get(m.paperId)?.status,'complete');
   if(badSaved&&m.paperId===savedComplete)throw Error('synthetic real stage qualification rejected');return {paperId:m.paperId};},
  saveMember:(_batch,id,v)=>{progress.members[id]=v;},
  require:id=>id==='./analysis-failure-rounds'?rounds:id==='./analysis-stop-control'?{
   withModelRequestsForbidden:async fn=>{forbiddenDepth++;try{return await fn();}finally{forbiddenDepth--;}},
   assertMayStartRequest:()=>{assert.equal(forbiddenDepth,0,'stop checks must stay outside forbidden replay');
    if(stopped)throw Object.assign(new Error('synthetic cooperative stop'),{code:'ANALYSIS_STOP_REQUESTED',scope:'run'});},requestAnalysisStop:()=>{}}:id==='./conference-process-recovery'?{
    classifyFailure:error=>({code:error.code,message:error.message,retryable:error.retryable!==false,systemic:error.scope==='run'})}:(()=>{throw Error('unexpected '+id);})()
 };
 vm.runInNewContext(body+';module.exports=runReaderReviewMaintenanceBatch;',globals);
 const deps={adapter,files:{conferenceAnalysisDir:'analysis'},now:()=>new Date(0).toISOString()};
 const run=()=>globals.module.exports({manifestPath:'manifest',directory:'process',state,shared:{},options:{concurrency:8}},deps);
 return {run,events,progress,records,stageChecks,reads};
}
test('175 absent members finish before 7 existing failures; subsequent snapshots and intents preserve the real three-attempt cap',async()=>{
 const h=setup({count:182,existing:7,alwaysFail:'paper-6',denyRepeatedSuccessReads:true});const r=await h.run();
 assert.equal(r.status,'reader_review_maintenance_pending');
 assert.equal(h.events.length,183);assert.ok(h.events.slice(0,175).every(e=>Number(e.id.slice(6))>=7&&e.attempt===1));
 assert.ok(h.events.slice(175,182).every(e=>Number(e.id.slice(6))<7&&e.attempt===2));
 assert.deepEqual(h.events.at(-1),{id:'paper-6',attempt:3});
 assert.deepEqual(h.progress.roundIntents.map(x=>x.normalRoundOrdinal),[1,2,3]);
 assert.equal(h.progress.roundIntents[0].inputIds.length,175);assert.equal(h.progress.roundIntents[1].inputIds.length,7);
 assert.ok(Object.values(h.progress.roundIntents[1].startingAttempts).every(x=>x===1));
 assert.equal(h.progress.roundIntents[2].startingAttempts['paper-6'],2);
 assert.equal(h.progress.members['paper-6'].attempts,3);assert.equal(r.savedComplete,181);
});
test('real systemic stop result prevents later dispatch, retaining only actual attempted children',async()=>{
 const h=setup({count:20,stopAt:'paper-0'});await assert.rejects(h.run,/synthetic content or transport/);
 // The normal shared round worker checks the run stop before claiming more;
 // already in-flight peers may finish but there is no second wave.
 assert.ok(h.events.length<=8);assert.ok(h.events.every(e=>e.attempt===1));
 assert.ok(h.progress.rounds.at(-1).stopped);
});
test('post-selection actual attempt drift stops before a paid dispatch',async()=>{
 const h=setup({count:4,mutateAfterIntent:true});await assert.rejects(h.run,/progress changed after scheduling/);
 assert.ok(h.events.every(e=>e.id!=='paper-0'&&e.attempt===1));assert.equal(h.progress.members['paper-0'].failure.code,'READER_MAINTENANCE_SCHEDULING_DRIFT');
});
test('saved partial-to-complete recovery still requires normal stage qualification before reuse',async()=>{
 const h=setup({count:2,existing:1,savedComplete:'paper-0',badSaved:true});
 await assert.rejects(h.run,/stage qualification rejected/);assert.deepEqual(h.stageChecks,['paper-0']);assert.equal(h.events.length,0);
});

test('known nonretryable child is read only by unchanged initialization, never by scheduling phases',async()=>{
 const h=setup({count:5,existing:2,blocked:'paper-0',alwaysFail:'paper-1',denyRepeatedSuccessReads:true});
 const r=await h.run();assert.equal(r.status,'reader_review_maintenance_pending');
 assert.equal(h.reads.filter(id=>id==='paper-0').length,2,'initial load plus saved partial replay reread only');
 assert.ok(h.events.every(e=>e.id!=='paper-0'));
 assert.deepEqual(h.progress.roundIntents.map(x=>x.inputIds),[['paper-2','paper-3','paper-4'],['paper-1'],['paper-1']]);
});

test('event-loop stop between initialization members preserves the fully staged and saved child',async()=>{
 const h=setup({count:3,existing:1,savedComplete:'paper-0',stopAfterStage:true});
 await assert.rejects(h.run,error=>error.code==='ANALYSIS_STOP_REQUESTED');
 assert.deepEqual(h.stageChecks,['paper-0']);assert.equal(h.progress.members['paper-0'].status,'complete');
 assert.ok(h.reads.every(id=>id==='paper-0'));assert.equal(h.events.length,0);assert.equal(h.progress.roundIntents.length,0);
});
test('event-loop stop between scheduling snapshots cannot create a round intent or model request',async()=>{
 const h=setup({count:3,stopDuringScheduling:true});
 await assert.rejects(h.run,error=>error.code==='ANALYSIS_STOP_REQUESTED');
 assert.deepEqual(h.reads,['paper-0','paper-1','paper-2','paper-0']);
 assert.equal(h.events.length,0);assert.equal(h.progress.roundIntents.length,0);assert.equal(h.progress.rounds.length,0);
});
