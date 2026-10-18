'use strict';
// Synthetic lifecycle/CAS boundaries only. The real before/after source replay
// is archived separately; none of these mocks grants scientific qualification.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
const ROOT=process.cwd(),CORRECTION='conference-reader-operator-correction-v1';
function operatorFixture(){
 const paper={id:'synthetic-paper',analysisManifest:{stages:{apiReaderArticle:{operatorProvenance:{contract:CORRECTION,processId:'process',executionId:'parent'}}}}};
 const original={paperId:paper.id,analysisRunId:'parent',analysisProof:{analysisSha256:'analysis',completionReceiptSha256:'receipt',sourceSnapshotSha256:'snapshot'},readerOperatorAdoption:{original:'retained'}};
 const loaded={analysis:{papers:[paper]},analysisFileSha256:'analysis',run:{executionId:'parent',completionReceipt:{receiptSha256:'receipt'},sourceSnapshotSha256:'snapshot'}};
 let valid=true,checks=0;const handle=Object.freeze({}),bound={parent:paper,child:{id:paper.id,newReader:true},executionId:'child',processId:'process',baselineItem:original,assertUnchanged(){checks++;if(!valid)throw Error('actual child/source/adoption CAS changed');}};
 const formal=path.join(ROOT,'scripts/lib/conference-reader-operator-correction.js'),m=new Module(formal,module);m.filename=formal;m.paths=Module._nodeModulePaths(path.dirname(formal));const native=m.require.bind(m);
 m.require=name=>name==='./conference-reader-review-maintenance'?{readScientificParentReplay:token=>{assert.equal(token,handle,'private handle required');return bound;}}:native(name);
 m._compile(fs.readFileSync(formal,'utf8')+'\nmodule.exports.__test={maintenanceParentItem};',formal);
 return{api:m.exports,paper,loaded,original,current:{paperId:paper.id,analysisRunId:'child',newReader:true},handle,bound,setValid:x=>valid=x,get checks(){return checks}};
}
test('only opaque maintained-parent scope projects immutable baseline; no scope/plain flag leaves real current child intact',()=>{
 const f=operatorFixture();assert.equal(f.api.__test.maintenanceParentItem(f.paper,f.loaded,f.current,'process'),f.current);
 assert.throws(()=>f.api.withVerifiedMaintenanceReaderParent({},()=>true),/private handle/);
 const result=f.api.withVerifiedMaintenanceReaderParent(f.handle,()=>f.api.__test.maintenanceParentItem(f.paper,f.loaded,f.current,'process'));
 assert.deepEqual(result,f.original);assert.notEqual(result,f.original);assert(f.checks>=3);
 assert.equal(f.api.__test.maintenanceParentItem(f.paper,f.loaded,f.current,'process'),f.current);
});
test('wrong current child/process, changed old parent CAS/baseline, altered canonical parent reject inside private scope',()=>{
 for(const change of [f=>f.current.analysisRunId='unrelated',f=>f.bound.processId='other',f=>f.loaded.analysisFileSha256='changed',f=>f.loaded.run.completionReceipt.receiptSha256='changed',f=>f.loaded.run.sourceSnapshotSha256='changed',f=>f.bound.baselineItem.analysisRunId='other',f=>f.loaded.analysis.papers=[{...f.paper,changed:true}]]){
  const f=operatorFixture();change(f);assert.throws(()=>f.api.withVerifiedMaintenanceReaderParent(f.handle,()=>f.api.__test.maintenanceParentItem(f.paper,f.loaded,f.current,'process')),/baseline|真实child|parent CAS/);
 }
 const f=operatorFixture();f.setValid(false);assert.throws(()=>f.api.withVerifiedMaintenanceReaderParent(f.handle,()=>true),/CAS changed/);
 const g=operatorFixture();assert.throws(()=>g.api.withVerifiedMaintenanceReaderParent(g.handle,()=>{g.setValid(false);return true;}),/CAS changed/);
});
function lifecycle(){
 const src=fs.readFileSync(path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js'),'utf8'),code=src.slice(src.indexOf('function scientificParentReplayRequired('),src.indexOf('function readScientificParentReplay('));
 const loaded={revision:{contract:'ordinary'},run:{executionId:'child'},parent:{run:{executionId:'parent'},analysis:{papers:[{analysisManifest:{stages:{apiReaderArticle:{operatorProvenance:{contract:CORRECTION}}}}}]}}},batch={m:{batchId:'batch',manifestSha256:'manifest'}},member={paperId:'paper'},handles=new WeakMap(),state={value:{items:{paper:{analysisRunId:'parent'}}}},counts={operator:0,source:0};
 const api=vm.runInNewContext(code+'\n({withScientificParentReplay})',{scientificParentReplayHandles:handles,check:(x,m)=>assert.ok(x,m),adapter:()=>({READER_REVISION_CONTRACT:'ordinary'}),assertCurrentBatch:()=>state,require:name=>name==='./conference-reader-operator-correction'?{CORRECTION,withVerifiedMaintenanceReaderParent:(handle,callback)=>{assert(handles.get(handle));counts.operator++;return callback();}}:{isSourceCorrectionRecord:()=>false,withVerifiedMaintenanceScientificParent:()=>{counts.source++;throw Error('wrong source branch');}}});
 return{api,loaded,batch,member,state,counts};
}
test('pre-adopt operator parent retains normal attempt path; only actual adopted ordinary child mints operator scope, grants do not',()=>{
 const f=lifecycle();assert.equal(f.api.withScientificParentReplay(f.loaded,f.batch,f.member,()=>42),42);assert.equal(f.counts.operator,0);
 const i=f.state.value.items.paper;i.analysisRunId='child';i.textMaintenanceAdoption={batchId:'batch',manifestSha256:'manifest',previousExecutionId:'parent'};
 assert.equal(f.api.withScientificParentReplay(f.loaded,f.batch,f.member,()=>43),43);assert.equal(f.counts.operator,1);assert.equal(f.counts.source,0);
 i.textMaintenanceAdoption.previousExecutionId='wrong';assert.throws(()=>f.api.withScientificParentReplay(f.loaded,f.batch,f.member,()=>true));
 const g=lifecycle();g.loaded.revision.contract='grant';assert.equal(g.api.withScientificParentReplay(g.loaded,g.batch,g.member,()=>true),true);assert.equal(g.counts.operator,0);
});
