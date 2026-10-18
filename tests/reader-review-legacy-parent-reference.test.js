'use strict';
// Synthetic scope/admission tests; the real li26h source and legacy/current
// qualification distinction are archived separately. These mocks grant no paper pass.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Module}=require('node:module');
function setup(){
 const f=require('./reader-signed-draft-fixture').fixture({noFigures:true});delete f.paper.arxivId;f.paper.id='synthetic-conference-reference';
 const parent={directory:'/synthetic-not-real-parent',analysisFileSha256:'analysis-original',runFileSha256:'run-original',sourceFileSha256:'source-original',
  run:{executionId:'parent-original',paperId:f.paper.id},analysis:{status:'complete',papers:[f.paper]},source:{sourceDetails:f.sourceDetails,
  sourceSnapshotBinding:{sourceBinding:{artifactsPayloadSha256:'synthetic-raw'}},planAuthorityBinding:{synthetic:true}}};
 let active=null,canonical=structuredClone(parent),normalValid=false,publicationValid=true,publicationCalls=0,tamper=null,deep,maintenance;
 const cap=Object.freeze({synthetic:true});
 const context={getConferenceAnalysisContext:()=>active,withConferenceAnalysisSource:(input,fn)=>{const saved=active;active=input;try{return fn()}finally{active=saved}}};
 const engine={hasValidApiReaderV3Records:()=>normalValid,isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>{publicationCalls++;return publicationValid}};
 const wrap={prepareApiReaderRevisionSeed:(paper,source,feedback)=>{
   if(tamper==='resource'){paper=structuredClone(paper);paper.apiReaderResources.resources.push({url:'forged'})}
   if(tamper==='reader'){paper=structuredClone(paper);paper.apiReaderArticle+='forged'}
   if(tamper==='source')source+='forged';if(tamper==='feedback')feedback+='forged';
   if(tamper==='CAS')canonical.analysisFileSha256='changed';if(tamper==='execution')active={...active,executionId:'other'};
   return deep.prepareApiReaderRevisionSeed(paper,source,feedback);
 }};
 function load(relative){const filename=path.resolve(__dirname,'..',relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const native=m.require.bind(m);m.require=id=>{
   if(['../analysis-engine','./analysis-engine.js'].includes(id))return engine;
   if(['./conference-analysis-context','./lib/conference-analysis-context'].includes(id))return context;
   if(id==='./conference-analysis-adapter')return {loadConferenceAnalysis:()=>canonical};
   if(id==='./conference-reader-publication-evidence')return {replayCanonicalReaderPdfSource:()=>cap};
   if(id==='./conference-postprocess')return {readOriginalTagProof:()=>({rules:{synthetic:true}})};
   if(id==='../deep-analyzer')return wrap;
   if(id==='./lib/conference-reader-review-maintenance')return maintenance;
   return native(id);
  };m._compile(fs.readFileSync(filename,'utf8')+(relative.endsWith('conference-reader-review-maintenance.js')?'\nmodule.exports.privateSeedForTest=verifiedParentSeed;':''),filename);return m.exports;}
 maintenance=load('scripts/lib/conference-reader-review-maintenance.js');deep=load('scripts/deep-analyzer.js');
 return {parent,f,deep,maintenance,setNormal:v=>normalValid=v,setPublication:v=>publicationValid=v,setTamper:v=>tamper=v,calls:()=>publicationCalls};
}
test('仅私有完整旧出版准入允许原父参考，正常无scope与plain布尔仍拒',()=>{
 const x=setup(),feedback='Actual synthetic immutable review feedback';
 assert.throws(()=>x.deep.prepareApiReaderRevisionSeed(x.f.paper,x.f.sourceDetails.text,feedback,{legacyPublicationParentReference:true}),/定向修订需要完整/);
 assert.equal(x.maintenance.readLegacyPublicationParentReference(x.f.paper,x.f.sourceDetails.text,feedback),false);
 const seed=x.maintenance.privateSeedForTest(x.parent,feedback);
 assert.equal(seed.metadata.revisionSeedStageRecovery,'read-only-publication-parent-reader-reference-v1');
 assert.ok(seed.initialDraft);assert.equal(x.calls(),1);
 assert.equal(x.maintenance.readLegacyPublicationParentReference(x.f.paper,x.f.sourceDetails.text,feedback),false);
});
test('旧资源或来源、父Reader、反馈、CAS与实际执行变化均拒，完整出版资格缺失也拒',()=>{
 for(const kind of ['resource','reader','source','feedback','CAS','execution']){
  const x=setup();x.setTamper(kind);assert.throws(()=>x.maintenance.privateSeedForTest(x.parent,'feedback'),/legacy parent reference/);
 }
 const x=setup();x.setPublication(false);assert.throws(()=>x.maintenance.privateSeedForTest(x.parent,'feedback'),/定向修订需要完整/);
});
test('当前普通有效Reader仍原seed路径，不进入旧出版参考准入',()=>{
 const x=setup();x.setNormal(true);const seed=x.maintenance.privateSeedForTest(x.parent,'feedback');
 assert.equal(seed.metadata.revisionSeedStageRecovery,'current-signed-reader-stage-v1');assert.equal(x.calls(),0);
});
