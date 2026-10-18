'use strict';
// Synthetic lifecycle boundary, not source or scientific qualification.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const code=src.slice(src.indexOf('function scientificParentReplayRequired('),src.indexOf('function readScientificParentReplay('));
function fixture(){
 const loaded={revision:{contract:'ordinary'},run:{executionId:'child'},analysisFileSha256:'initial-analysis',
  parent:{run:{executionId:'parent'},analysis:{papers:[{local:true}]}}};
 const batch={m:{batchId:'batch',manifestSha256:'manifest'}},member={paperId:'paper'},scientificParentReplayHandles=new WeakMap();
 const actual={value:{items:{paper:{analysisRunId:'parent'}}}},controls={stateChecks:0,scopes:0,childIdentityReads:0};
 const api=vm.runInNewContext(code+'\n({scientificParentReplayRequired,withScientificParentReplay})',{
  scientificParentReplayHandles,check:(value,message)=>assert.ok(value,message),adapter:()=>({READER_REVISION_CONTRACT:'ordinary'}),
  assertCurrentBatch:()=>{controls.stateChecks++;return actual},require:()=>({isSourceCorrectionRecord:paper=>paper.local===true,
   withVerifiedMaintenanceScientificParent:(handle,callback)=>{assert.ok(scientificParentReplayHandles.get(handle));controls.scopes++;controls.childIdentityReads++;return callback()}})});
 return{...api,loaded,batch,member,actual,controls};
}
test('pre-adopt普通付费续跑允许原child attempt/checkpoint推进，不新增严格child全analysis锁（合成边界）',()=>{
 const f=fixture();f.loaded.analysisFileSha256='earlier-outer-attempt';let actualAnalysis='advanced-reader-attempt';
 assert.equal(f.withScientificParentReplay(f.loaded,f.batch,f.member,()=>actualAnalysis),actualAnalysis);
 assert.equal(f.controls.scopes,0);assert.equal(f.controls.childIdentityReads,0);assert.equal(f.controls.stateChecks,1);
});
test('只有真实post-adopt current child及原登记批/manifest/parent才能mint私有scope（合成边界）',()=>{
 const f=fixture(),item=f.actual.value.items.paper;item.analysisRunId='child';item.textMaintenanceAdoption={batchId:'batch',manifestSha256:'manifest',previousExecutionId:'parent'};
 assert.equal(f.withScientificParentReplay(f.loaded,f.batch,f.member,()=>true),true);assert.equal(f.controls.scopes,1);
 for(const mutate of [i=>i.analysisRunId='unrelated',i=>delete i.textMaintenanceAdoption,
  i=>i.textMaintenanceAdoption.batchId='wrong',i=>i.textMaintenanceAdoption.manifestSha256='wrong',i=>i.textMaintenanceAdoption.previousExecutionId='wrong']){
  const g=fixture(),i=g.actual.value.items.paper;i.analysisRunId='child';i.textMaintenanceAdoption={batchId:'batch',manifestSha256:'manifest',previousExecutionId:'parent'};mutate(i);
  assert.throws(()=>g.withScientificParentReplay(g.loaded,g.batch,g.member,()=>true));assert.equal(g.controls.scopes,0);
 }
});
test('非来源纠正与原grant路径保持原行为，无新scope或state准入（合成边界）',()=>{
 for(const mutate of [f=>f.loaded.revision.contract='grant',f=>f.loaded.parent.analysis.papers[0].local=false]){
  const f=fixture();mutate(f);assert.equal(f.withScientificParentReplay(f.loaded,f.batch,f.member,()=>42),42);
  assert.equal(f.controls.scopes,0);assert.equal(f.controls.stateChecks,0);
 }
});
