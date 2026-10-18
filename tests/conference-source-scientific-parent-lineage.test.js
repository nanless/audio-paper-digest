'use strict';
// Synthetic orchestration only. No normal Reader/source qualification is mocked
// into a publication pass: these tests exercise exact source lineage and the
// opaque scientific-parent boundary; no model/network/canonical writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks');
const same=require('node:util').isDeepStrictEqual;
const src=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-source-resource-correction.js'),'utf8');
const sourceFns=src.slice(src.indexOf('function sourceProjectionCanonical('),src.indexOf('function assertMaintenanceChildProgress('));
const scopeFns=src.slice(src.indexOf('function withVerifiedMaintenanceScientificParent('),src.indexOf('function readRegisteredTransaction('));
function fixture(){
 const parent={id:'paper',source:'conference',conferenceSourceCorrection:{executionId:'parent'},analysis:'sealed science'},
 child={...structuredClone(parent),apiReaderArticle:'actual new Reader'};
 const original={run:{status:'complete',paperId:'paper',executionId:'parent'},analysis:{status:'complete',papers:[parent]},analysisFileSha256:'a',runFileSha256:'b',sourceFileSha256:'same'};
 const loaded={directory:'/analysis/child',run:{status:'complete',paperId:'paper',executionId:'child',sourceSnapshotSha256:'snapshot',completionReceipt:{receiptSha256:'completion'}},
  analysis:{status:'complete',papers:[child]},analysisFileSha256:'new-analysis',runFileSha256:'new-run',sourceFileSha256:'same',parent:original,
  revision:{mode:'reader-only',readerReviewMaintenance:{batchId:'batch',manifestSha256:'manifest'}}};
 const item={paperId:'paper',analysisRunId:'child',analysisProof:{analysisSha256:'new-analysis',sourceSnapshotSha256:'snapshot',completionReceiptSha256:'completion'},readerRevision:loaded.revision,
  textMaintenanceAdoption:{batchId:'batch',manifestSha256:'manifest',previousExecutionId:'parent'}};
 const controls={pins:true,registered:true,pure:0,full:0,modelForbidden:0},scientificParentReplay=new AsyncLocalStorage(),sourceLineageRecords=new WeakMap(),tokens=new WeakMap();
 const handle=Object.freeze({});tokens.set(handle,{child,parent,executionId:'child',assertUnchanged:()=>assert.equal(controls.pins,true)});
 const adapter={loadConferenceAnalysis:()=>loaded,readJsonRecord:()=>({value:{readerReviewMaintenance:{contract:'conference-reader-review-maintenance-member-v1',window:null}}}),
  loadConferenceReaderRevision:()=>{controls.full++;throw Error('source identity must not enter feedback/seed');}};
 const env={path,scientificParentReplay,sourceLineageRecords,isDeepStrictEqual:same,clone:structuredClone,
  fail:message=>{throw Error(message)},isSourceCorrectionRecord:paper=>!!paper.conferenceSourceCorrection,
  require:name=>{
   if(name==='../config')return{FILES:{conferenceAnalysisDir:'/analysis'}};
   if(name==='./conference-analysis-adapter')return adapter;
   if(name==='./analysis-stop-control')return{withModelRequestsForbidden:callback=>{controls.modelForbidden++;return callback()}};
   if(name==='./conference-reader-review-maintenance')return{
    readReaderMaintenanceSourceLineage:({executionId})=>{controls.pure++;assert.equal(executionId,'child');assert.equal(controls.registered,true);return{loaded,assertUnchanged:()=>assert.equal(controls.pins,true)}},
    readScientificParentReplay:token=>{const bound=tokens.get(token);assert.ok(bound,'actual private WeakMap token required');return bound;}};
   throw Error('unexpected '+name);
  }};
 const api=vm.runInNewContext(sourceFns+scopeFns+'\n({sourceProjectionCanonical,independentReaderMaintenanceChild,withVerifiedMaintenanceScientificParent,inheritedScientificParentProjection})',env);
 return{...api,parent,child,original,loaded,item,handle,controls,scientificParentReplay};
}
test('sourceIdentity只走真实源身份阶段，不进入完整feedback/seed递归（合成编排）',()=>{
 const f=fixture(),p=f.sourceProjectionCanonical(f.item);assert.equal(p.current,f.loaded);assert.equal(p.loaded,f.original);
 assert.equal(f.controls.pure,1);assert.equal(f.controls.full,0);assert.equal(f.independentReaderMaintenanceChild(p.descendants[0]),true);
});
test('未持私有cap的默认旧parent调用不借维护child，裸JSONtoken拒（合成编排）',()=>{
 const f=fixture();assert.equal(f.inheritedScientificParentProjection(f.parent,f.item),null);
 assert.throws(()=>f.withVerifiedMaintenanceScientificParent({},()=>true),/private WeakMap/);
 assert.equal(f.controls.pure,0);
});
test('stage/loadCompleted和privateFD父评分只在真实同child/parent/adoption scope回放（合成编排）',()=>{
 for(const root of ['stage/loadCompleted','publication/privateFD']){
  const f=fixture();f.withVerifiedMaintenanceScientificParent(f.handle,()=>{
   const p=f.inheritedScientificParentProjection(structuredClone(f.parent),f.item);
   assert.equal(p.current,f.loaded,root);assert.equal(f.controls.full,0);
  });assert.equal(f.scientificParentReplay.getStore(),undefined);assert.equal(f.controls.modelForbidden,1);
 }
});
test('parent scope拒错child正文/ID、原父、缺adoption或另一批/manifest/parent（合成编排）',()=>{
 for(const alter of [f=>f.loaded.analysis.papers[0]={...f.child,apiReaderArticle:'changed'},f=>f.loaded.run.executionId='other',
  f=>f.original.analysis.papers[0]={...f.parent,analysis:'changed science'},f=>delete f.item.textMaintenanceAdoption,
  f=>f.item.textMaintenanceAdoption.batchId='other',f=>f.item.textMaintenanceAdoption.manifestSha256='other',
  f=>f.item.textMaintenanceAdoption.previousExecutionId='other',f=>f.controls.registered=false,f=>f.controls.pins=false]){
  const f=fixture();alter(f);assert.throws(()=>f.withVerifiedMaintenanceScientificParent(f.handle,()=>f.inheritedScientificParentProjection(f.parent,f.item)));
 }
});
test('私有科学scope失败及async完成均清除，回调后真实pins变化拒（合成编排）',async()=>{
 const f=fixture();assert.throws(()=>f.withVerifiedMaintenanceScientificParent(f.handle,()=>{throw Error('failed full seed');}),/failed full seed/);
 assert.equal(f.scientificParentReplay.getStore(),undefined);
 assert.equal(await f.withVerifiedMaintenanceScientificParent(f.handle,async()=>true),true);
 await assert.rejects(f.withVerifiedMaintenanceScientificParent(f.handle,async()=>{f.controls.pins=false;return true;}));
 assert.equal(f.scientificParentReplay.getStore(),undefined);
});
const maintenance=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8');
test('maintenance真正WeakMap cap逐次重读原父/子/修订CAS，非JSON许可（合成边界）',()=>{
 const fn=maintenance.slice(maintenance.indexOf('function readScientificParentReplay('),maintenance.indexOf('function readVerifiedReaderScientificParent('));
 const loaded={run:{executionId:'child'},analysis:{papers:[{id:'paper',apiReaderArticle:'actual child'}]},revision:{real:'actual revision'},
  analysisFileSha256:'a',runFileSha256:'r',sourceFileSha256:'s',parent:{analysis:{papers:[{id:'paper',analysis:'sealed parent'}]},analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'ps'}};
 const member={parentCAS:{analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'ps'}},batch={analysisRoot:'/canonical'},token=Object.freeze({}),scientificParentReplayHandles=new WeakMap();
 scientificParentReplayHandles.set(token,{loaded,batch,member});let actual=structuredClone(loaded),stateValid=true;
 const read=vm.runInNewContext(fn+'\nreadScientificParentReplay',{scientificParentReplayHandles,same,structuredClone,
  check:(condition,message)=>assert.ok(condition,message),adapter:()=>({loadConferenceReaderRevisionIdentity:()=>actual}),assertCurrentBatch:()=>assert.equal(stateValid,true)});
 assert.throws(()=>read({}),/private verified maintenance/);
 const bound=read(token);assert.deepEqual(bound.child,loaded.analysis.papers[0]);assert.deepEqual(bound.parent,loaded.parent.analysis.papers[0]);
 for(const alter of [x=>x.analysisFileSha256='other',x=>x.runFileSha256='other',x=>x.sourceFileSha256='other',x=>x.revision.real='other',
  x=>x.parent.analysisFileSha256='other',x=>x.parent.runFileSha256='other',x=>x.parent.sourceFileSha256='other']){
  actual=structuredClone(loaded);alter(actual);assert.throws(()=>read(token));assert.throws(()=>bound.assertUnchanged());
 }
 actual=structuredClone(loaded);stateValid=false;assert.throws(()=>read(token));assert.throws(()=>bound.assertUnchanged());
});
test('尚未采纳时当前process仍是原父稿，不启用post-adopt投影或重授Reader（合成编排）',()=>{
 const f=fixture();f.item.analysisRunId='parent';
 f.withVerifiedMaintenanceScientificParent(f.handle,()=>assert.equal(f.inheritedScientificParentProjection(f.parent,f.item),null));
 assert.equal(f.controls.pure,0);assert.equal(f.controls.full,0);
});
test('科学父cap只为ordinary来源纠正父生效，非纠正与原grant路径不改（合成边界）',()=>{
 const fn=maintenance.slice(maintenance.indexOf('function withScientificParentReplay('),maintenance.indexOf('function readScientificParentReplay('));
 const scientificParentReplayHandles=new WeakMap();let scopes=0;
 const run=vm.runInNewContext(fn+'\nwithScientificParentReplay',{scientificParentReplayHandles,
  scientificParentReplayRequired:loaded=>loaded.revision.contract==='ordinary'&&loaded.parent.analysis.papers[0].local===true,
  adapter:()=>({READER_REVISION_CONTRACT:'ordinary'}),require:()=>({isSourceCorrectionRecord:paper=>!!paper.local,
   withVerifiedMaintenanceScientificParent:(token,callback)=>{assert.ok(scientificParentReplayHandles.get(token));scopes++;return callback()}})});
 const mk=(contract,local)=>({revision:{contract},parent:{analysis:{papers:[{local}]}}});
 assert.equal(run(mk('grant',true),{}, {},()=>1),1);assert.equal(run(mk('ordinary',false),{},{},()=>2),2);assert.equal(scopes,0);
 assert.equal(run(mk('ordinary',true),{},{},()=>3),3);assert.equal(scopes,1);
});
