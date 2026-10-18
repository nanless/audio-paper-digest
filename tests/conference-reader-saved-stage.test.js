'use strict';
// Read-only pure-view checks; these do not authenticate paid issuance or sources.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),test=require('node:test'),assert=require('node:assert/strict');
const ROOT=process.cwd(),file=path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js');
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.__pureView=neutralReaderUpstreamView;module.exports.__usage=savedReaderUsageProof;module.exports.__receipt=assertSavedMaintenanceReaderRecovery;module.exports.__mint=(saved)=>{const h=Object.freeze({});savedCompletionHandles.set(h,saved);return h;};',file);
const deep=require(path.join(ROOT,'scripts/deep-analyzer')),sync=require(path.join(ROOT,'scripts/lib/reader-resource-sync'));
const {parseAnalysis}=require(path.join(ROOT,'scripts/utils')),hash=require(path.join(ROOT,'scripts/lib/fresh-rewrite-run')).stableHash,sha=require('node:crypto').createHash;
const digest=x=>sha('sha256').update(x).digest('hex');
function fixture(){
 const text='We use third-party software https://example.org/tool for confidence intervals.';
 const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:digest(text),resources:[{type:'third_party',origin:'paper_source',sourceQuote:text,sourceQuoteSha256:digest(text),originalUrl:'https://example.org/tool',finalUrl:'https://example.org/tool',redirects:[],availability:'available',status:200,retryable:false}]};
 const resources={...body,identitySha256:hash(body)},empty={contract:body.contract,sourceTextSha256:digest(text),resources:[]};empty.identitySha256=hash(empty);
 const analysis=deep.applyApiReaderResourceAvailability(require(path.join(ROOT,'tests/valid-analysis-fixture')).validAnalysisText(),empty),audit={dimensions:{openSource:{score:0,reason:'unchanged'}},total:6.9};
 const parent={sourceSha256:digest(text),analysis,parsed:parseAnalysis(analysis),apiReaderResources:resources,
  apiReaderArticle:'signed output not used by this pure test',apiReaderPlan:{},apiReaderFigures:[],apiReaderAuthors:{},
  analysisManifest:{sourceAcquisition:{sourceSha256:digest(text)},stages:{openSourceScan:{resourceEvidenceSha256:resources.identitySha256},scoringAudit:{status:'complete',outputAnalysisSha256:digest(analysis),audit,auditSha256:hash(audit)}}}};
 const child=structuredClone(parent);sync.synchronizeReaderResourceAvailability(child,{text});
 assert.notEqual(child.analysis,parent.analysis,'real shared synchronizer must produce the neutral delta');
 return {parent,child,resources};
}
test('pure neutral private view exactly reverses real normal shared resource sync',()=>{
 const {parent,child,resources}=fixture(),before=structuredClone(child),result=m.exports.__pureView(parent,child,resources);
 assert.equal(result.paper.analysis,parent.analysis);assert.deepEqual(result.paper.parsed,parent.parsed);
 assert.deepEqual(result.paper.analysisManifest.stages.scoringAudit,parent.analysisManifest.stages.scoringAudit);
 assert.equal(result.projection.newApiRequests,undefined);assert.deepEqual(child,before);
});
test('pure neutral private view rejects scientific body score tags stage receipt checkpoint and resource drift',()=>{
 for(const mutate of [x=>x.child.analysis+='invented result',x=>x.child.parsed.score='9.9',x=>x.child.parsed.tagValidation={forged:true},
  x=>x.child.analysisManifest.stages.scoringAudit.audit.total=9.9,
  x=>x.child.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0].newApiRequests=1,
  x=>x.child.analysisStageCheckpoints={scoringAudit:'invented'},x=>x.resources={...x.resources,identitySha256:'a'.repeat(64)}]){
  const x=fixture();mutate(x);assert.throws(()=>m.exports.__pureView(x.parent,x.child,x.resources),/saved neutral|saved upstream/);
 }
});

const os=require('node:os');
function paidFixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'saved-reader-stage-')),usageRoot=path.join(directory,'usage'),childDir=path.join(directory,'child');
 fs.mkdirSync(usageRoot,{mode:0o700});fs.mkdirSync(childDir,{mode:0o700});t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const names=['11111111-1111-4111-8111-111111111111.json','22222222-2222-4222-8222-222222222222.json','33333333-3333-4333-8333-333333333333.json'];
 const paperId='conference:synthetic:2026:conference-paper-id:saved',eventId='44444444-4444-4444-8444-444444444444';
 const base={version:'llm-usage-v1',paperId,stage:'apiReaderArticle',runId:null,unitId:null,contentAttempt:1,transportAttempt:1,eventId};
 const events=[{...base,kind:'request_started',at:'2026-10-18T01:00:01.000Z',inputSha256:'a'.repeat(64),model:'synthetic-model',protocol:'synthetic-protocol'},
 {...base,kind:'request',at:'2026-10-18T01:00:02.000Z',inputSha256:'a'.repeat(64),outputTextSha256:'b'.repeat(64),model:'synthetic-model',protocol:'synthetic-protocol',outcome:'completed',transportStarted:true,statusCode:200,errorCode:null},
 {...base,kind:'disposition',at:'2026-10-18T01:00:03.000Z',outputTextSha256:'b'.repeat(64),disposition:'accepted'}];
 function write(index,value){fs.writeFileSync(path.join(usageRoot,names[index]),JSON.stringify(value)+'\n',{mode:0o600});}
 events.forEach((v,i)=>write(i,v));
 const actualRequire=m.require.bind(m);m.require=name=>name==='../config'?{FILES:{...require(path.join(ROOT,'scripts/config')).FILES,llmUsageDir:usageRoot}}:actualRequire(name);
 const loaded={directory:childDir,run:{paperId,executionId:'55555555-5555-4555-8555-555555555555',createdAt:'2026-10-18T01:00:00.000Z'}};
 const native={inputSha256:'a'.repeat(64)},stage={refreshedAt:'2026-10-18T01:00:04.000Z',model:'synthetic-model',protocol:'synthetic-protocol'};
 return {directory,usageRoot,childDir,names,events,write,loaded,native,stage};
}
test('saved-stage real file issuance gate requires unique exact native input start request acceptance',t=>{
 const f=paidFixture(t),originalEvents=structuredClone(f.events),proof=m.exports.__usage(f.loaded,f.native,f.stage);
 assert.equal(proof.contentResponses,1);assert.equal(proof.fullResponses,1);assert.equal(proof.records.length,3);
 for(const mutate of [()=>f.native.inputSha256='c'.repeat(64),()=>{f.events[1].outcome='incomplete';f.write(1,f.events[1]);},
  ()=>{f.events[0].inputSha256='c'.repeat(64);f.write(0,f.events[0]);},()=>{f.events[2].disposition='rejected';f.write(2,f.events[2]);},
  ()=>{f.events[2].outputTextSha256='d'.repeat(64);f.write(2,f.events[2]);},()=>fs.copyFileSync(path.join(f.usageRoot,f.names[1]),path.join(f.usageRoot,'66666666-6666-4666-8666-666666666666.json'))]){
  f.native.inputSha256='a'.repeat(64);f.events=structuredClone(originalEvents);f.events.forEach((v,i)=>f.write(i,v));
  mutate();assert.throws(()=>m.exports.__usage(f.loaded,f.native,f.stage),/saved Reader/);
  const extra=path.join(f.usageRoot,'66666666-6666-4666-8666-666666666666.json');if(fs.existsSync(extra))fs.unlinkSync(extra);
 }
});
function archiveFixture(t){
 const f=paidFixture(t),x=fixture(),stage={status:'complete',fingerprint:'c'.repeat(64),model:f.stage.model,protocol:f.stage.protocol,refreshedAt:f.stage.refreshedAt};
 x.child.analysisManifest.stages.apiReaderArticle=stage;
 const revision={resourcePreflightFileSha256:'placeholder'},analysis={status:'partial',papers:[x.child],readerRevisionProgress:{attempts:1,failures:[{code:'original-run-failure'}]}};
 const values={'analysis.json':analysis,'run.json':f.loaded.run,'source.json':{realTestSourceBytes:true},'reader-revision.json':revision,'reader-resource-preflight.json':x.resources,'review-reader-seed.json':{initialDraft:'synthetic seed'}};
 for(const [name,value]of Object.entries(values))fs.writeFileSync(path.join(f.childDir,name),JSON.stringify(value)+'\n',{mode:0o600});
 const record=name=>{const bytes=fs.readFileSync(path.join(f.childDir,name));return {name,bytes,value:JSON.parse(bytes),sha256:digest(bytes)};};
 const beforeFiles=Object.keys(values).map(record),loaded={...f.loaded,analysis,analysisFileSha256:beforeFiles[0].sha256,sourceFileSha256:record('source.json').sha256,revision,parent:{analysis:{papers:[x.parent]},analysisFileSha256:'d'.repeat(64),runFileSha256:'e'.repeat(64)},resourcePreflight:x.resources};
 const view=m.exports.__pureView(x.parent,x.child,x.resources),usage=m.exports.__usage(loaded,f.native,f.stage);
 const proof={contract:'conference-saved-maintenance-reader-completion-v1',executionId:loaded.run.executionId,paperId:loaded.run.paperId,originalPartialAnalysisFileSha256:loaded.analysisFileSha256,parentAnalysisFileSha256:loaded.parent.analysisFileSha256,parentRunFileSha256:loaded.parent.runFileSha256,sourceFileSha256:loaded.sourceFileSha256,preflightFileSha256:revision.resourcePreflightFileSha256,projection:view.projection,readerStageSha256:hash(stage),restoredPaperSha256:hash(view.paper),nativeRequest:{inputSha256:f.native.inputSha256,stageFingerprint:stage.fingerprint},usage,beforeFiles:beforeFiles.map(({name,sha256})=>({name,sha256})),newApiRequests:0};
 const saved={loaded,paper:view.paper,proof,beforeFiles};return {...f,...x,loaded,saved,view};
}
test('saved-stage opaque save archives original six files and cold-replays actual receipt without altering partial',t=>{
 const f=archiveFixture(t),before=fs.readFileSync(path.join(f.childDir,'analysis.json'));
 assert.throws(()=>m.exports.archiveSavedMaintenanceReaderCompletion(f.loaded,{}),/opaque/);
 const handle=m.exports.__mint(f.saved),receipt=m.exports.archiveSavedMaintenanceReaderCompletion(f.loaded,handle);
 assert.deepEqual(fs.readFileSync(path.join(f.childDir,'analysis.json')),before);
 const complete={...f.loaded,analysis:{...f.loaded.analysis,status:'complete',papers:[f.view.paper],readerSavedStageRecovery:receipt}};
 assert.doesNotThrow(()=>m.exports.__receipt(complete,f.view.paper));
 const changed=structuredClone(f.view.paper);changed.analysis+='changed';assert.throws(()=>m.exports.__receipt(complete,changed),/restored Reader/);
 const saved=path.join(f.childDir,'saved-reader-stage-recovery',f.loaded.analysisFileSha256,'review-reader-seed.json');
 fs.appendFileSync(saved,' ');assert.throws(()=>m.exports.__receipt(complete,f.view.paper),/before package SHA/);
});
test('saved-stage archive refuses changed actual partial preflight seed or fee before saving',t=>{
 for(const target of ['analysis.json','reader-resource-preflight.json','review-reader-seed.json','fee']){
  const f=archiveFixture(t),handle=m.exports.__mint(f.saved),filename=target==='fee'?path.join(f.usageRoot,f.names[1]):path.join(f.childDir,target);
  fs.appendFileSync(filename,' ');assert.throws(()=>m.exports.archiveSavedMaintenanceReaderCompletion(f.loaded,handle),/CAS changed|usage changed/);
  assert.equal(fs.existsSync(path.join(f.childDir,'saved-reader-stage-recovery')),false);
 }
});
