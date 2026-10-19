'use strict';
// Metadata/ordering tests only: mocked source calls never confer scientific qualification.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const test=require('node:test'),assert=require('node:assert/strict'),{isDeepStrictEqual:same}=require('node:util');
const ROOT=process.cwd();require(path.join(ROOT,'scripts/env-loader')).requireExternalRuntime();
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const sorted=x=>Array.isArray(x)?x.map(sorted):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
const stable=x=>sha(JSON.stringify(sorted(x))),SHA=/^[a-f0-9]{64}$/u;
const check=(v,m)=>{if(!v)throw Error(m);};
const self=(x,k)=>{const {[k]:signature,...body}=x;check(signature===stable(body),'self hash '+k);};
const source=fs.readFileSync(path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const start=source.indexOf('function readSavedResourceReadmission('),end=source.indexOf('function savedResourceReaderContext(',start);
assert.ok(start>=0&&end>start,'private readmission functions must be present in actual implementation');
const code=source.slice(start,end);
function protectedScience(p){const stages=structuredClone(p.analysisManifest?.stages||{}),checkpoints=structuredClone(p.analysisStageCheckpoints||{});for(const k of ['apiReaderArticle','imageSupplement','openSourceScan'])delete stages[k];delete checkpoints.apiReaderArticle;return {analysis:p.analysis,analysisCheckpoint:p.analysisCheckpoint,parsed:p.parsed,scoringAudit:p.scoringAudit,sourceSha256:p.sourceSha256,stages,checkpoints};}
function read(filename){const s=fs.lstatSync(filename);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o777)===0o600,'private file');const bytes=fs.readFileSync(filename);return {value:JSON.parse(bytes),sha256:sha(bytes),bytes};}
function locator(batch,member){return {contract:'conference-reader-review-maintenance-member-v1',processId:batch.m.processId,batchId:batch.m.batchId,manifestSha256:batch.m.manifestSha256,manifestFileSha256:batch.manifestFileSha256,memberSha256:stable(batch.m.members.find(x=>x.paperId===member.paperId)),reviewFeedbackSha256:member.reviewFeedbackSha256,window:member.window||null};}
const temporaryRoots=[];
require('node:test').after(()=>{for(const root of temporaryRoots)fs.rmSync(root,{recursive:true,force:true});});
function loadFixture(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'saved-readmission-test-'));temporaryRoots.push(root);
 const analysisRoot=path.join(root,'analysis'),registry=path.join(root,'registry');
 const id='11111111-1111-4111-8111-111111111111',parentId='22222222-2222-4222-8222-222222222222';
 const paperId='conference:synthetic:2026:conference-paper-id:readmission',text='synthetic sealed source text';
 const sourceValue={sourceDetails:{text}},sourceSnapshotSha256=sha('source snapshot');
 const write=(filename,value)=>{fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});fs.writeFileSync(filename,JSON.stringify(value)+'\n',{mode:0o600});return read(filename);};
 const signed=(body,key)=>({...body,[key]:stable(body)});
 const sourceRecord=write(path.join(analysisRoot,parentId,'source.json'),sourceValue);
 const identity=resources=>{const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(text),resources};return {...body,identitySha256:stable(body)};};
 const third={type:'third_party',origin:'paper_source',originalUrl:'https://example.org/dataset',finalUrl:'https://example.org/dataset',redirects:[],sourceQuote:'synthetic dataset',sourceQuoteSha256:sha('synthetic dataset'),availability:'available',status:200,retryable:false};
 const repository=type=>({type,origin:'paper_source',originalUrl:'https://example.org/repo',finalUrl:'https://example.org/repo',redirects:[],sourceQuote:'synthetic repository',sourceQuoteSha256:sha('synthetic repository'),availability:'available',status:200,retryable:false});
 const parentIdentity=identity([third,repository('code'),repository('dataset')]);
 const currentIdentity=identity([{...third,availability:'temporarily_unreachable',status:null,retryable:true,failureCode:'ECONNRESET'},repository('code'),repository('dataset')]);
 const oldIdentity=identity([third,{...repository('code'),availability:'temporarily_unreachable',status:null,retryable:true},repository('dataset')]);
 const original={id:paperId,analysis:'synthetic protected science',analysisCheckpoint:'synthetic checkpoint',parsed:{hasCode:true,hasDataset:true},sourceSha256:sha(text),
  analysisManifest:{stages:{scoringAudit:{status:'complete',outputAnalysisSha256:sha('synthetic protected science')},primaryAnalysis:{status:'complete'},apiReaderArticle:{status:'complete'},openSourceScan:{status:'complete'}}},
  analysisStageCheckpoints:{primaryAnalysis:'synthetic checkpoint'},apiReaderResources:parentIdentity,
  conferenceSourceCorrection:{contract:'conference-source-resource-correction-v1',executionId:parentId}};
 const parentAnalysis=write(path.join(analysisRoot,parentId,'analysis.json'),{status:'complete',generation:1,papers:[original]});
 const parentRun=write(path.join(analysisRoot,parentId,'run.json'),{status:'complete',executionId:parentId,paperId,sourceSnapshotSha256});
 const parent={directory:path.join(analysisRoot,parentId),analysis:parentAnalysis.value,analysisFileSha256:parentAnalysis.sha256,run:parentRun.value,runFileSha256:parentRun.sha256,source:sourceValue,sourceFileSha256:sourceRecord.sha256};
 const parentCAS={analysisFileSha256:parent.analysisFileSha256,runFileSha256:parent.runFileSha256,sourceFileSha256:parent.sourceFileSha256};
 const member={paperId,executionId:id,parentExecutionId:parentId,parentCAS,sourceSnapshotSha256,reviewFeedbackSha256:sha('synthetic feedback')};
 const batch={p:{root:registry},m:{processId:'33333333-3333-4333-8333-333333333333',batchId:'44444444-4444-4444-8444-444444444444',manifestSha256:sha('synthetic manifest'),members:[member]},manifestFileSha256:sha('synthetic physical manifest')};
 const directory=path.join(analysisRoot,id),recovery=path.join(registry,'unissued-preflight-recoveries',id),before=path.join(recovery,'before');
 const initial=write(path.join(before,'analysis.json'),{status:'pending',generation:0,papers:[{id:paperId}]});
 const intentValue=signed({executionId:id,paperId,sourceSnapshotSha256,sourceFileSha256:sourceRecord.sha256,initialAnalysisFileSha256:initial.sha256,observationBindingSha256:sha('observation')},'intentSha256');
 const intent=write(path.join(before,'intent.json'),intentValue);
 const old=write(path.join(before,'reader-resource-preflight.json'),oldIdentity);
 const initialRun=signed({status:'source_ready',executionId:id,paperId,sourceSnapshotSha256,prepareIntentFileSha256:intent.sha256,prepareIntentSha256:intent.value.intentSha256},'runSha256');
 const run=write(path.join(before,'run.json'),initialRun),src=write(path.join(before,'source.json'),sourceValue);
 const failure=write(path.join(before,'member-progress.json'),{status:'failed',executionId:id,attempts:0,failure:{retryable:false,systemic:false,message:'Text maintenance cannot change resources or scoring'}});
 const fixed=write(path.join(recovery,'new-preflight.json'),currentIdentity);
 const receiptBody={contract:'conference-reader-unissued-preflight-recovery-v1',manifestSha256:batch.m.manifestSha256,manifestFileSha256:batch.manifestFileSha256,paperId,executionId:id,parentCAS,
  before:{'analysis.json':initial.sha256,'intent.json':intent.sha256,'reader-resource-preflight.json':old.sha256,'run.json':run.sha256,'source.json':src.sha256},
  oldMemberProgressFileSha256:failure.sha256,newPreflightFileSha256:fixed.sha256,oldIdentitySha256:oldIdentity.identitySha256,newIdentitySha256:currentIdentity.identitySha256,
  normalProbeInvocations:1,resumedSavedPreflightFileSha256:fixed.sha256,normalProbeInvocationsThisResume:0,status:'reader-only-ready'};
 write(path.join(recovery,'receipt.json'),signed(receiptBody,'receiptSha256'));
 const paper={...structuredClone(original),apiReaderResources:currentIdentity};
 const childAnalysis=write(path.join(directory,'analysis.json'),{status:'partial',generation:2,papers:[paper]});
 const childRun=write(path.join(directory,'run.json'),{...initialRun,status:'partial'});
 write(path.join(directory,'source.json'),sourceValue);write(path.join(directory,'intent.json'),intentValue);write(path.join(directory,'reader-resource-preflight.json'),currentIdentity);
 const revision=signed({contract:'conference-reader-source-revision-v1',mode:'reader-only',maxAttempts:3,readerReviewMaintenance:locator(batch,{...member,window:null}),resourcePreflightFileSha256:fixed.sha256,parentExecutionId:parentId,parentAnalysisFileSha256:parentAnalysis.sha256,parentRunFileSha256:parentRun.sha256,sourceSnapshotSha256},'revisionSha256');
 write(path.join(directory,'reader-revision.json'),revision);
 const loaded={directory,analysis:childAnalysis.value,analysisFileSha256:childAnalysis.sha256,run:childRun.value,runFileSha256:childRun.sha256,source:sourceValue,sourceFileSha256:sourceRecord.sha256,parent,revision,resourcePreflight:currentIdentity};
 return {batch,member,loaded,paper:structuredClone(paper)};
}
function harness(f,opts={}){
 const calls=[];const active={executionId:f.loaded.run.executionId,executionDir:f.loaded.directory,paperId:f.paper.id,readerPdfSourceHandle:{},sourceDetails:f.loaded.source.sourceDetails};
 const modules={'./conference-analysis-context':{getConferenceAnalysisContext:()=>opts.noScope?null:active,withConferenceAnalysisSource:(scope,fn)=>{calls.push('parent-scope');return fn();}},'./conference-source-context':{readerPdfSourceForContext:()=>{calls.push('actual-pdf');}},'../deep-analyzer':{replayVerifiedReaderResourceIdentity:(i)=>{calls.push(i===f.loaded.parent.analysis.papers[0].apiReaderResources?'parent-replay':'child-replay');if(opts.badReplay)throw Error('actual source rejected');return i;}},'./reader-authenticated-pdf-footnote-evidence':{deriveCorrectedIdentity:i=>{calls.push('derive-child');return {identity:opts.badDerive?{...i,identitySha256:'f'.repeat(64)}:structuredClone(i)};}}};
 const adapter=()=>({READER_REVISION_CONTRACT:'conference-reader-source-revision-v1',loadConferenceAnalysis:()=>f.loaded.parent,loadConferenceReaderRevisionIdentity:()=>f.loaded});
 const vars={assertCurrentBatch:()=>{calls.push('current');if(opts.badBatch)throw Error('actual batch rejected');},check,same,path,fs,read:filename=>opts.overlay?.get(filename)||read(filename),self,adapter,locator,protectedScience,SHA,sha,stable,replayParentSource:()=>{calls.push('parent-source');return {};},unissuedResourceMode:()=>opts.mode||'reader-only',require:n=>{if(!modules[n])throw Error('unexpected module '+n);return modules[n];}};
 return {...new Function(...Object.keys(vars),code+'\nreturn {readSavedResourceReadmission,assertSavedResourceReadmissionProjection};')(...Object.values(vars)),calls};
}
test('synthetic immutable readmission closes; this is not PDF/Reader qualification',()=>{const f=loadFixture(),h=harness(f);const result=h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,{...f.member,window:null});assert.equal(result.identity.identitySha256,f.loaded.resourcePreflight.identitySha256);result.assertUnchanged();assert.equal(result.identity.resources.find(x=>x.type==='third_party').availability,'temporarily_unreachable');});
for(const [name,change]of [
 ['non-null window',f=>f.member={...f.member,window:{windowId:'foreign'}}],
 ['extra member field',f=>f.member={...f.member,unknown:true}],
 ['parent CAS',f=>f.loaded.parent.analysisFileSha256='a'.repeat(64)],
 ['source CAS',f=>f.loaded.sourceFileSha256='a'.repeat(64)],
 ['feedback',f=>f.loaded.revision.readerReviewMaintenance.reviewFeedbackSha256='a'.repeat(64)],
 ['scoring mode',f=>f.loaded.revision.mode='scoring-and-reader'],
 ['parent main',f=>f.paper.analysis+=' changed'],
 ['parent scoring',f=>f.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256='a'.repeat(64)],
 ['parent tags',f=>f.paper.analysisManifest.stages.methodRepair={status:'complete'}],
 ['current resource status',f=>f.paper.apiReaderResources.resources[0].availability='available'],
 ['fixed preflight',f=>f.loaded.resourcePreflight.identitySha256='a'.repeat(64)],
 ['revision fixed SHA',f=>f.loaded.revision.resourcePreflightFileSha256='a'.repeat(64)]])test('reject changed '+name,()=>{const f=loadFixture();change(f);const h=harness(f);assert.throws(()=>h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member));});
test('mock source sequencing uses actual fixed status, parent scope then child, with final guard',()=>{const f=loadFixture(),h=harness(f);assert.equal(h.assertSavedResourceReadmissionProjection(f.loaded,f.paper,f.batch,f.member),true);const trace=h.calls.filter(x=>!['current'].includes(x));assert.deepEqual(trace,['actual-pdf','parent-source','parent-scope','parent-replay','child-replay','derive-child']);assert.equal(f.paper.apiReaderResources.resources[0].status,null);});
for(const [name,opts]of [['missing PDF scope',{noScope:true}],['normal source rejected',{badReplay:true}],['scoring mode changed',{mode:'scoring-and-reader'}],['PDF derivation changed',{badDerive:true}],['current batch changed',{badBatch:true}]])test('mock source bridge rejects '+name,()=>{const f=loadFixture(),h=harness(f,opts);assert.throws(()=>h.assertSavedResourceReadmissionProjection(f.loaded,f.paper,f.batch,f.member));});

function overlayRecord(overlay,file,change,selfKey){const record=read(file),v=structuredClone(record.value);change(v);if(selfKey){delete v[selfKey];v[selfKey]=stable(v);}const bytes=Buffer.from(JSON.stringify(v));overlay.set(file,{value:v,bytes,sha256:sha(bytes)});return overlay.get(file);}
for(const [name,target,change,key] of [
 ['receipt scoring status','receipt.json',v=>v.status='still-requires-scoring','receiptSha256'],
 ['receipt unknown authority','receipt.json',v=>v.extraAuthority=true,'receiptSha256'],
 ['receipt extra probe','receipt.json',v=>v.normalProbeInvocations=2,'receiptSha256'],
 ['receipt extra resume probe','receipt.json',v=>v.normalProbeInvocationsThisResume=1,'receiptSha256'],
 ['receipt parent','receipt.json',v=>v.parentCAS.analysisFileSha256='f'.repeat(64),'receiptSha256'],
 ['receipt feedback/manifest','receipt.json',v=>v.manifestSha256='f'.repeat(64),'receiptSha256'],
 ['archived original analysis','before/analysis.json',v=>v.generation=1,null],
 ['archived request-bearing failure','before/member-progress.json',v=>v.attempts=1,null],
 ['archived initial run','before/run.json',v=>v.status='complete','runSha256'],
 ['fixed canonical status','CURRENT',v=>v.resources[0].availability='available','identitySha256']
])test('reject synthetic-record overlay '+name,()=>{const f=loadFixture(),overlay=new Map(),dir=path.join(f.batch.p.root,'unissued-preflight-recoveries',f.member.executionId);overlayRecord(overlay,target==='CURRENT'?path.join(f.loaded.directory,'reader-resource-preflight.json'):path.join(dir,target),change,key);const h=harness(f,{overlay});assert.throws(()=>h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member));});
test('successful read admission proof excludes mutable completion metadata and final fence detects archive change',()=>{const f=loadFixture(),overlay=new Map(),h=harness(f,{overlay}),a=h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member);f.loaded.analysisFileSha256='f'.repeat(64);f.loaded.runFileSha256='e'.repeat(64);const b=h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member);assert.deepEqual(a.proof,b.proof);const filename=path.join(f.batch.p.root,'unissued-preflight-recoveries',f.member.executionId,'receipt.json');overlayRecord(overlay,filename,v=>v.normalProbeInvocations=2,'receiptSha256');assert.throws(()=>a.assertUnchanged(),/material changed/);});

test('reject jointly replaced current intent and internally matching current run',()=>{const f=loadFixture(),overlay=new Map(),record=overlayRecord(overlay,path.join(f.loaded.directory,'intent.json'),v=>v.observationBindingSha256='f'.repeat(64),'intentSha256');f.loaded.run.prepareIntentFileSha256=record.sha256;f.loaded.run.prepareIntentSha256=record.value.intentSha256;const h=harness(f,{overlay});assert.throws(()=>h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member),/current original intent/);});
test('reject current run losing original prepared intent SHA',()=>{const f=loadFixture();f.loaded.run.prepareIntentSha256='f'.repeat(64);const h=harness(f);assert.throws(()=>h.readSavedResourceReadmission(f.loaded,f.paper,f.batch,f.member),/current original intent/);});
