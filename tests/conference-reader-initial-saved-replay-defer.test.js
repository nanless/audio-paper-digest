'use strict';
// Native gate/scheduler/refresh/continue bodies with synthetic qualification.
// This proves control-flow/CAS only, never a real Reader/source/paid response.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const adapterSource=fs.readFileSync(path.join(root,'scripts/lib/conference-analysis-adapter.js'),'utf8');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const stable=v=>JSON.stringify(v);
const extract=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const gate=extract(source,'function shouldDeferInitialSavedReplayToNormal(','function savedMaintenanceStageItem(');
function fixture(t,changes={}) {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-defer-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const feeFile=path.join(tmp,'synthetic-paid-usage.json');fs.writeFileSync(feeFile,'synthetic retained fee event bytes');const feeSha=sha(fs.readFileSync(feeFile));
 const events=[],progress={members:{},rounds:[],roundIntents:[]},items=['p','blocked'];
 const analysisRoot=path.join(tmp,'analysis'),parentId='parent',childId='child',paper={id:'p',analysis:'protected-main',parsed:{score:7},apiReaderArticle:'saved-response',sourceSha256:'source',analysisManifest:{stages:{apiReaderArticle:{status:'complete'},primaryAnalysis:{status:'complete'},coreSummaryRepair:{status:'complete'},tagSelection:{status:'complete'},taxonomySeal:{status:'complete'}}}};
 const directory=path.join(analysisRoot,childId),parentDirectory=path.join(analysisRoot,parentId),feedback={window:null,reviewFeedbackSha256:'feedback'};
 fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(parentDirectory,{recursive:true});
 const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v)+'\n');
 const readJsonRecord=f=>{const bytes=fs.readFileSync(f);return {value:JSON.parse(bytes),sha256:sha(bytes)}};
 write(path.join(parentDirectory,'analysis.json'),{status:'complete',papers:[paper]});write(path.join(parentDirectory,'run.json'),{status:'complete',paperId:'p',executionId:parentId});write(path.join(parentDirectory,'source.json'),{sourceDetails:{text:'fixture-source'}});
 const loadConferenceAnalysis=({executionId})=>{const directory=path.join(analysisRoot,executionId),a=readJsonRecord(path.join(directory,'analysis.json')),r=readJsonRecord(path.join(directory,'run.json')),s=readJsonRecord(path.join(directory,'source.json'));return {directory,analysis:a.value,run:r.value,source:s.value,analysisFileSha256:a.sha256,runFileSha256:r.sha256,sourceFileSha256:s.sha256}};
 const parent=loadConferenceAnalysis({executionId:parentId});
 write(path.join(directory,'analysis.json'),{status:'partial',generation:1,papers:[paper],readerRevisionProgress:{attempts:1,failures:[{code:'CONTENT'}]}});write(path.join(directory,'run.json'),{status:'source_ready',paperId:'p',executionId:childId});fs.copyFileSync(path.join(parentDirectory,'source.json'),path.join(directory,'source.json'));
 const revision={contract:'ordinary',mode:'reader-only',maxAttempts:3,readerReviewMaintenance:feedback};write(path.join(directory,'reader-revision.json'),revision);
 const loadConferenceReaderRevision=()=>({...loadConferenceAnalysis({executionId:childId}),revision,readerReview:{locator:feedback},parent:loadConferenceAnalysis({executionId:parentId})});
 const member={paperId:'p',executionId:childId,parentExecutionId:parentId,parentCAS:{analysisFileSha256:parent.analysisFileSha256,runFileSha256:parent.runFileSha256,sourceFileSha256:parent.sourceFileSha256}};
 const batch={m:{members:[member],manifestSha256:'manifest'},analysisRoot,p:{state:'state',progress:'progress',adoption:'none'}};
 let upstream=null,reuse=true,sourceError=false,tagError=false;
 const modelFail=()=>{events.push('MODEL');throw Error('models forbidden in pure recovery fixture')};
 const engine={withPaperAnalysisLock:async(id,fn)=>{assert.equal(id.id,'p');events.push('paper-lock');return fn();},getConferenceReaderRefreshUpstreamReason:(_p,{tagRules})=>{assert.equal(tagRules,'original-rules');events.push('upstream');return upstream;},isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>{events.push('whole');return true;}};
 const deep={inspectSavedConferenceReaderCompletion:async()=>{events.push('inspect-paid');return {synthetic:true};},refreshApiReaderArticleFromSource:modelFail,refreshApiScoringAndReaderFromSource:modelFail};
 const verifyPlanAuthority=(p,plan,sourceRoot)=>{events.push('source');assert.equal(p.run.executionId==='parent'||p.run.executionId==='child',true);assert.equal(plan,shared.planHandle);assert.equal(sourceRoot,'fixture-source-root');if(sourceError)throw Error('source rejected');return {syntheticPdf:true}};
 const context={withConferenceAnalysisSource:(value,fn)=>{assert.ok(value.readerPdfSourceHandle);events.push('source-context');return fn()}};
 const stop={withModelRequestsForbidden:fn=>fn(),assertMayStartRequest:()=>{},requestAnalysisStop:()=>{}};
 const maintenance={bindCompletedParent:()=>{events.push('feedback');return {locator:feedback}},inspectSavedMaintenanceReaderCompletion:async()=>null,assertReaderOutput:()=>events.push('feedback-output')};
 const postprocess={readOriginalTagProof:()=>{events.push('tag-rules');if(tagError)throw Error('tag rejected');return {rules:'original-rules'}}};
 const requireFake=id=>{
  if(id==='./analysis-stop-control')return stop;
  if(id==='./conference-postprocess')return postprocess;
  if(id==='./conference-analysis-context')return context;
  if(id==='./model-text-sanitization')return {canReuseModelTextInputs:()=>reuse};
  if(id==='./conference-reader-review-maintenance')return maintenance;
  if(id==='./conference-process-recovery')return {classifyFailure:e=>({retryable:e.retryable!==false,systemic:false,message:e.message})};
  if(id==='./analysis-failure-rounds')return {runFailureRounds:async(input,opts)=>{opts.onRoundStart({inputIds:input.map(m=>m.paperId)});for(const m of input)await opts.runItem(m);opts.onRoundDone({});}};
  if(id==='./analysis-stage-request-guard')return {AUXILIARY_STAGES:[]};
  if(id==='node:path')return path;
  throw Error('unexpected require '+id);
 };
 const g={module:{exports:{}},require:requireFake,fs,path,Map,Set,Object,Math,Date,structuredClone,setImmediate,stable,analysisContext:context,stableHash:stable,sha256:sha,jsonBytes:v=>Buffer.from(JSON.stringify(v)),clone:structuredClone,
  readJsonRecord,loadConferenceAnalysis,loadConferenceReaderRevision,verifyPlanAuthority,
  prepareConferenceAnalysis:()=>events.push('prepare-existing'),readerRevisionExecutionId:()=>childId,conferencePaperLockOptions:()=>({}),
  replaceJson:(file,value,expected)=>{assert.equal(readJsonRecord(file).sha256,expected);events.push('CAS-save');write(file,value)},
  sealCompletedRun:()=>{events.push('seal');const f=path.join(directory,'run.json'),v=readJsonRecord(f).value;write(f,{...v,status:'complete'});},
  effectiveMember:(_b,m)=>m,stageMaintenanceSavedMembers:async()=>new Set(),progressFor:()=>({value:progress,sha256:'progress-sha'}),check:(v,m)=>{if(!v)throw Error(m)},
 };
 vm.runInNewContext(extract(adapterSource,'async function inspectLoadedReaderRevisionCompletion(','async function inspectConferenceReaderRevisionCompletion(')+extract(adapterSource,'async function refreshConferenceReader(','function recoveryWindowError(')+extract(adapterSource,'async function continueConferenceRevision(','module.exports = ')+gate+';module.exports={refreshConferenceReader,shouldDeferInitialSavedReplayToNormal};',g);
 const api=g.module.exports;
 const adapter={READER_REVISION_CONTRACT:'ordinary',loadConferenceAnalysis,verifyPlanAuthority,refreshConferenceReader:args=>api.refreshConferenceReader(args,{engine,deep}),replaySavedConferenceReaderRevision:async()=>{events.push('savedOnly');}};
 const deps={adapter,engine,files:{conferenceAnalysisDir:analysisRoot},now:()=>new Date(0).toISOString()};
 const shared={planHandle:{syntheticPlan:true},sourceCacheRoot:'fixture-source-root'};
 const actual=()=>{const child=loadConferenceReaderRevision();return {status:child.analysis.status,attempts:child.analysis.readerRevisionProgress.attempts,child}};
 Object.assign(g,{effectiveMember:(_b,m)=>m});
 const evaluate=()=>api.shouldDeferInitialSavedReplayToNormal(batch,member,actual(),shared,deps);
 return {feeFile,feeSha,evaluate,events,member,batch,deps,shared,actual,revision,parent,api,g,write,readJsonRecord,directory,progress,
  setUpstream:v=>upstream=v,setReuse:v=>reuse=v,setSourceError:()=>sourceError=true,setTagError:()=>tagError=true,
  deep,stop,failSavedInspection:()=>deep.inspectSavedConferenceReaderCompletion=async()=>null};
}
test('ordinary retryable partial with cap3 and exact source/upstream defers work only',t=>{const f=fixture(t);assert.equal(f.evaluate(),true);assert.equal(f.actual().status,'partial');assert.equal(f.actual().attempts,1);assert(!f.events.includes('MODEL'));});
for(const [name,mutate]of [
 ['window',f=>f.member.window={windowId:'window'}],['revision-window',f=>f.revision.readerReviewMaintenance.window={windowId:'window'}],
 ['missing-window',f=>delete f.revision.readerReviewMaintenance.window],['scoring',f=>f.revision.mode='scoring-and-reader'],['normal-analysis',f=>f.revision.mode='normal-analysis'],
 ['other-contract',f=>f.revision.contract='grant'],['lower-cap',f=>f.revision.maxAttempts=2],['higher-cap',f=>f.revision.maxAttempts=4],
 ['exhausted',f=>{const p=path.join(f.directory,'analysis.json'),v=f.readJsonRecord(p).value;v.readerRevisionProgress.attempts=3;f.write(p,v)}],
 ['nonretryable',f=>f.progress.members.p={executionId:'child',failure:{retryable:false,systemic:false}}],
 ['upstream-rejected',f=>f.setUpstream('needs full analysis')],['unicode-input',f=>f.setReuse(false)],['source-error',f=>f.setSourceError()],['tag-error',f=>f.setTagError()],
 ['parent-CAS',f=>f.member.parentCAS.analysisFileSha256='wrong']
])test('initial original replay preserved for '+name,t=>{const f=fixture(t);mutate(f);assert.equal(f.evaluate(),false);});
test('same original phase eligibility: different execution or systemic failure remains selectable',t=>{const f=fixture(t);f.progress.members.p={executionId:'older',failure:{retryable:false}};assert.equal(f.evaluate(),true);f.progress.members.p={executionId:'child',failure:{retryable:false,systemic:true}};assert.equal(f.evaluate(),true);});
test('unissued/no-child and complete states do not defer initial handling',t=>{const f=fixture(t);for(const actual of [{status:'pending',attempts:0},{status:'absent',attempts:0},{status:'complete',attempts:1,child:f.actual().child}])assert.equal(f.api.shouldDeferInitialSavedReplayToNormal(f.batch,f.member,actual,f.shared,f.deps),false);});
test('actual normal refresh→continue→paid saved inspect→CAS complete uses zero new attempts/models',async t=>{const f=fixture(t),before=structuredClone(f.actual().child.analysis.readerRevisionProgress);assert(f.evaluate());f.events.length=0;const result=await f.api.refreshConferenceReader({analysisRoot:f.batch.analysisRoot,parentExecutionId:'parent',planHandle:f.shared.planHandle,sourceRoot:f.shared.sourceCacheRoot,maxAttempts:3,reviewMaintenanceHandle:{}},{engine:f.deps.engine,deep:{inspectSavedConferenceReaderCompletion:async()=>({synthetic:true})}});assert.equal(result.status,'complete');assert.equal(result.recoveredSavedReader,true);assert.deepEqual(f.actual().child.analysis.readerRevisionProgress,before);assert.equal(f.actual().child.run.status,'complete');assert(f.events.includes('paper-lock'));assert(f.events.includes('source'));assert(f.events.includes('feedback'));assert(f.events.includes('whole'));assert(f.events.includes('CAS-save'));assert(!f.events.includes('MODEL'));assert(!f.events.includes('savedOnly'));assert.equal(sha(fs.readFileSync(f.feeFile)),f.feeSha);});
test('actual normal active-paid recovery saves before increment and never falls through to a model',async t=>{const f=fixture(t);f.failSavedInspection();const before=structuredClone(f.actual().child.analysis.readerRevisionProgress);let active=0;
 const result=await f.api.refreshConferenceReader({analysisRoot:f.batch.analysisRoot,parentExecutionId:'parent',planHandle:f.shared.planHandle,sourceRoot:f.shared.sourceCacheRoot,maxAttempts:3,reviewMaintenanceHandle:{}},{engine:f.deps.engine,deep:f.deep,replayActiveReaderCandidate:async()=>{active++;return {eligible:true,paper:structuredClone(f.actual().child.analysis.papers[0]),proof:{synthetic:true},assertUnchanged:()=>f.events.push('active-proof-CAS')};}});
 assert.equal(result.recoveredActivePaidReader,true);assert.equal(active,1);assert.deepEqual(f.actual().child.analysis.readerRevisionProgress,before);assert(!f.events.includes('MODEL'));assert(f.events.includes('active-proof-CAS'));assert.equal(sha(fs.readFileSync(f.feeFile)),f.feeSha);});
test('failed saved and active reuse retain the original paid-attempt path and prior failures',async t=>{const f=fixture(t);f.failSavedInspection();const before=structuredClone(f.actual().child.analysis.readerRevisionProgress);
 await assert.rejects(f.api.refreshConferenceReader({analysisRoot:f.batch.analysisRoot,parentExecutionId:'parent',planHandle:f.shared.planHandle,sourceRoot:f.shared.sourceCacheRoot,maxAttempts:3,reviewMaintenanceHandle:{}},{engine:f.deps.engine,deep:f.deep,replayActiveReaderCandidate:async()=>({eligible:false})}),/models forbidden/);
 assert.equal(f.actual().attempts,before.attempts+1);assert.equal(f.actual().child.analysis.readerRevisionProgress.failures.length,before.failures.length+1);assert.deepEqual(f.actual().child.analysis.readerRevisionProgress.failures[0],before.failures[0]);assert.equal(f.events.filter(e=>e==='MODEL').length,1);});
test('initial defer→actual normal saved completion→stage/saveMember has no standalone savedOnly for eligible child',async t=>{
 const f=fixture(t),member=f.member,blocked={paperId:'blocked',executionId:'exhausted',parentExecutionId:'other-parent'};f.batch.m.members.push(blocked);
 const state={stateSha256:'state'},opaque=new WeakMap(),savedOnly=[],before=structuredClone(f.actual().child.analysis.readerRevisionProgress);let staged=0;
 const originalReplace=f.g.replaceJson;
 f.deps.adapter.replaceJson=(file,value,expected)=>{if(file==='progress')Object.assign(f.progress,value);else originalReplace(file,value,expected)};
 f.deps.adapter.replaySavedConferenceReaderRevision=async({executionId})=>{savedOnly.push(executionId)};
 Object.assign(f.g,{opaque,openMaintenanceBatch:()=>{const h={};opaque.set(h,f.batch);return h;},registerPendingObligation:()=>{},
  read:()=>({value:state,sha256:'state-physical'}),adapter:()=>f.deps.adapter,
  actualProgress:(_batch,m)=>m.paperId==='p'?f.actual():{status:'partial',attempts:3,child:{analysis:{readerRevisionProgress:{attempts:3,failures:[]}}}},
  observeAndStageSavedMember:(_b,m)=>{const actual=m.paperId==='p'?f.actual():{status:'partial',attempts:3,child:{}};return {actual,proof:null}},
  recoverUnissuedMaintenanceChild:async()=>false,
  stageChild:(_b,m)=>{assert.equal(f.actual().status,'complete');assert.equal(f.actual().child.run.status,'complete');staged++;f.events.push('stage');return {paperId:m.paperId};},
  saveMember:(_b,id,value)=>{f.events.push('saveMember');f.progress.members[id]=value;}
 });
 vm.runInNewContext(extract(source,'async function runReaderReviewMaintenanceBatch(','\nfunction assertNoPendingReaderReviewMaintenance(')+';module.exports=runReaderReviewMaintenanceBatch;',f.g);
 const result=await f.g.module.exports({manifestPath:'manifest',directory:'process',state,shared:f.shared,options:{concurrency:1}},f.deps);
 assert.equal(result.status,'reader_review_maintenance_pending');assert.equal(result.savedComplete,1);assert.deepEqual(savedOnly,['exhausted']);assert.equal(staged,1);assert.equal(f.progress.members.p.status,'complete');assert.deepEqual(f.actual().child.analysis.readerRevisionProgress,before);assert(!f.events.includes('MODEL'));assert(f.events.indexOf('CAS-save')<f.events.indexOf('stage'));assert(f.events.indexOf('stage')<f.events.indexOf('saveMember'));assert.equal(f.events.filter(e=>e==='paper-lock').length,1);assert.equal(sha(fs.readFileSync(f.feeFile)),f.feeSha);
});
