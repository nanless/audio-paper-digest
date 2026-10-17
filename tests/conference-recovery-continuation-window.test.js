'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
// Offline orchestration tests use real plan/PDF/source/registered-grant/ledger
// helpers; model/scientific outcomes are explicit doubles, no production data.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const adapter=require('../scripts/lib/conference-analysis-adapter'),grants=require('../scripts/lib/conference-recovery-grant'),api=require('../scripts/lib/conference-process'),budget=require('../scripts/lib/conference-reader-recovery-window');
const {fixture}=require('./helpers/conference-recovery-continuation-fixture');
const denyNetwork=()=>{throw Error('Offline continuation test forbids network');};require('node:net').Socket.prototype.connect=denyNetwork;require('node:tls').connect=denyNetwork;require('node:http2').connect=denyNetwork;for(const name of ['node:http','node:https']){require(name).request=denyNetwork;require(name).get=denyNetwork;}globalThis.fetch=denyNetwork;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function predecessor(t,options={}){
 const f=await fixture(t,options),member=grants.readRecoveryGrantMember(f.grant.handle,f.paperId),request={analysisRoot:f.analysisRoot,parentExecutionId:f.parentExecutionId,failedExecutionId:f.failedExecutionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot,grantHandle:f.grant.handle};
 let calls=0;
 const reader=async paper=>{calls++;const identity={paperId:f.paperId,sourceSha256:paper.sourceSha256,model:{model:'synthetic-no-network',protocol:'fixture'},promptSha256:'1'.repeat(64),...budget.identityFields(paper)};const lease=budget.reserveReaderResponse(paper,identity,'full',1);if(options.pending)throw Error('synthetic stopped pending request');budget.settleReaderResponse(lease,'content','{"synthetic":"retained response bytes"}');throw Error('synthetic predecessor Reader rejected');};
 const operations={...f.operations,refreshApiReaderArticleFromSource:reader};
 const engine={...f.engine,analyzePaperWithRetry:async paper=>({success:false,result:paper,error:'synthetic predecessor normal stage failed',retryable:false})};
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(request,{engine,deep:operations}),options.invalidCore?/synthetic predecessor normal/:/synthetic predecessor Reader|original scoring|synthetic stopped pending/);
 const prior=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:member.expectedExecutionId});
 const state=structuredClone(f.grant.state),item=state.items[f.paperId];item.attempts+=1;item.retryBudgetStart=f.grant.state.items[f.paperId].attempts;item.retryReleases=[{attempts:item.retryBudgetStart,recoveryGrantId:member.grantId,recoveryGrantSha256:member.grantSha256}];state.generation++;state.stateSha256=api.stateDigest(state);api.assertState(state);fs.writeFileSync(path.join(f.grant.processDirectory,'state.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600});
 return{...f,prior,priorMember:member,state};
}
function continuation(f,{grantId='22222222-2222-4222-8222-222222222222',install=true,mutate=()=>{}}={}){
 const before=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:f.prior.run.executionId}),member=structuredClone(f.grant.member);member.childExecutionId=before.run.executionId;member.recordCAS={};
 for(const run of [f.parentExecutionId,before.run.executionId])for(const name of ['analysis.json','run.json','source.json','reader-revision.json','reader-resource-preflight.json']){const file=path.join(f.analysisRoot,run,name);if(fs.existsSync(file))member.recordCAS[path.relative(f.grant.repositoryRoot,file).split(path.sep).join('/')]=hash(fs.readFileSync(file));}
 const material=grants.recoveryWindowMaterials(f.analysisRoot,before.run.executionId);member.continuation={contract:grants.CONTINUATION,grantId:f.priorMember.grantId,grantSha256:f.priorMember.grantSha256,materialsSha256:material.materialsSha256,ledgerFileSha256:material.ledgerFileSha256};
 const state=adapter.readJsonRecord(path.join(f.grant.processDirectory,'state.json')),body={...structuredClone(f.grant.manifest),version:2,grantId,baselineStateFileSha256:state.sha256,baselineGeneration:state.value.generation,members:[member]};delete body.manifestSha256;mutate(body);body.inventorySha256=api.stableHash(body.members);const manifest={...body,manifestSha256:api.stableHash(body)},manifestPath=path.join(f.grant.repositoryRoot,grantId+'.json');fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});const options={manifestPath,analysisRoot:f.analysisRoot,processDirectory:f.grant.processDirectory};const handle=install?grants.openRecoveryGrant({...options,install:true}):null;
 return{options,manifest,member,handle,request:{analysisRoot:f.analysisRoot,parentExecutionId:f.parentExecutionId,failedExecutionId:before.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot,grantHandle:handle}};
}
test('显式v2从最新已登记窗口续Reader，新账独立且保存旧响应/连续失败和冷加载链',async t=>{
 const f=await predecessor(t),materials=grants.recoveryWindowMaterials(f.analysisRoot,f.prior.run.executionId),pins=materials.files.map(r=>({file:path.join(f.prior.directory,r.path),sha:r.sha256})),next=continuation(f);let calls=0;
 const ops={...f.operations,refreshApiReaderArticleFromSource:async paper=>{calls++;assert.equal(paper.analysis,f.prior.analysis.papers[0].analysis);const window=budget.getCurrentReaderWindow(paper);assert.equal(window.grantId,next.manifest.grantId);const id={paperId:f.paperId,sourceSha256:paper.sourceSha256,...budget.identityFields(paper)},lease=budget.reserveReaderResponse(paper,id,'full',calls);budget.settleReaderResponse(lease,'content','{"synthetic":"new independent bytes"}');throw Error('synthetic continuation Reader failure');}};
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine:f.engine,deep:ops}),/synthetic continuation Reader failure/);
 const id=grants.readRecoveryGrantMember(next.handle,f.paperId).expectedExecutionId,cold=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:id});assert.equal(cold.recoveryWindow.failed.run.executionId,f.prior.run.executionId);assert.equal(cold.parent.run.executionId,f.parentExecutionId);assert.deepEqual(cold.revision.continuation,next.member.continuation);assert.equal(cold.analysis.readerRevisionProgress.attempts,1);assert.equal(JSON.parse(fs.readFileSync(path.join(cold.directory,'reader-grant-budget.json'))).requests.length,1);
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine:f.engine,deep:ops}),/全文预算|内容次数|synthetic continuation/);assert.equal(adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:id}).analysis.readerRevisionProgress.attempts,2);assert.equal(grants.readRecoveryGrantMember(next.handle,f.paperId).expectedExecutionId,id);for(const pin of pins)assert.equal(hash(fs.readFileSync(pin.file)),pin.sha);assert.equal(grants.recoveryWindowMaterials(f.analysisRoot,f.prior.run.executionId).materialsSha256,materials.materialsSha256);
});
test('v2未完成评分不得借父审计；同一新窗口失败后仍不得借外层重授评分',async t=>{
 const f=await predecessor(t,{scoringMode:true,scoringFailed:true}),next=continuation(f);let scores=0;
 const ops={...f.operations,refreshApiScoringAndReaderFromSource:async()=>{scores++;throw Object.assign(Error('synthetic new scoring rejected'),{retryable:false});},refreshApiReaderArticleFromSource:()=>assert.fail('scoring unfinished')};
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine:f.engine,deep:ops}),/synthetic new scoring rejected/);await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine:f.engine,deep:ops}),e=>e.code==='CONFERENCE_READER_REVISION_SCORING_RECOVERY_BLOCKED');assert.equal(scores,1);
});
test('v2正常分析复用最新主文而非root旧稿，新增阶段预算只在新窗口有效',async t=>{
 const f=await predecessor(t,{invalidCore:true}),next=continuation(f),guard=require('../scripts/lib/analysis-stage-request-guard');let calls=0;
 const engine={...f.engine,analyzePaperWithRetry:async paper=>{calls++;assert.equal(paper.analysis,f.prior.analysis.papers[0].analysis);if(calls===1)assert.doesNotThrow(()=>guard.assertStageModelRequestAllowed('tagSelection'));else assert.throws(()=>guard.assertStageModelRequestAllowed('tagSelection'));paper.analysisManifest.stages.tagSelection={status:'contract_rejected'};return{success:false,result:paper,error:'synthetic new normal stage failure',retryable:false};}};
 for(let i=0;i<2;i++)await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine,deep:f.operations}),/synthetic new normal stage failure/);assert.equal(calls,2);
});
test('v2成功评分检查点仅按最新窗口完整绑定复用，评分不重复调用',async t=>{
 const f=await predecessor(t,{scoringMode:true}),next=continuation(f);let readers=0;
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine:f.engine,deep:{...f.operations,refreshApiScoringAndReaderFromSource:()=>assert.fail('already scored'),refreshApiReaderArticleFromSource:async()=>{readers++;throw Error('synthetic scored Reader stop');}}}),/synthetic scored Reader stop/);assert.equal(readers,1);const id=grants.readRecoveryGrantMember(next.handle,f.paperId).expectedExecutionId,newest=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:id});assert.equal(newest.analysis.readerRevisionProgress.inheritedScoringCheckpoint.executionId,f.prior.run.executionId);
});
test('旧v1不能重选最旧失败或借延续字段扩大权限；错前许可/非latest/错材料/不完整集合均拒',async t=>{
 const f=await predecessor(t);for(const mutate of [m=>{m.version=1;},m=>{m.members[0].continuation.grantSha256='f'.repeat(64);},m=>{m.members[0].childExecutionId=f.failedExecutionId;},m=>{m.members[0].continuation.materialsSha256='f'.repeat(64);},m=>{m.members=[];}]){
  const p=continuation(f,{install:false,mutate});assert.throws(()=>grants.openRecoveryGrant({...p.options,install:true}));
 }
 const old=continuation(f,{install:false,mutate:m=>{m.version=1;delete m.members[0].continuation;}});assert.throws(()=>grants.openRecoveryGrant({...old.options,install:true}),/最新失败/);
});
test('同一最新失败不得平行新登记；旧材料增删/请求响应/资产变化和pending拒绝',async t=>{
 const f=await predecessor(t),next=continuation(f);assert.throws(()=>continuation(f,{grantId:'33333333-3333-4333-8333-333333333333'}),/已有独立追加登记/);const member=grants.readRecoveryGrantMember(next.handle,f.paperId),asset=path.join(f.prior.directory,'extra-source-asset.png');fs.writeFileSync(asset,Buffer.from('synthetic tamper'),{mode:0o600});assert.throws(member.assertUnchanged,/资产树变化/);fs.unlinkSync(asset);member.assertUnchanged();const raw=path.join(f.prior.directory,materialsName(f));const bytes=fs.readFileSync(raw);fs.writeFileSync(raw,Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(member.assertUnchanged);fs.writeFileSync(raw,bytes);member.assertUnchanged();
 function materialsName(f){return fs.readdirSync(f.prior.directory).find(n=>/^reader-grant-response-/.test(n));}
});
test('前窗口未闭合Reader请求在新登记之前拒绝，不创建任何后续运行',async t=>{
 const f=await predecessor(t,{pending:true});assert.throws(()=>continuation(f),/在途 Reader/);
});

test('最新null主文与401评分失败原样进入新normal窗口，不借root成功审计或缺失检查点',async t=>{
 const f=await predecessor(t,{invalidCore:true});const raw=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:f.prior.run.executionId}),changed=structuredClone(raw.analysis),paper=changed.papers[0];paper.analysis=null;paper.parsed=null;delete paper.analysisCheckpoint;paper.analysisStageCheckpoints={};paper.analysisManifest.stages.scoringAudit={status:'transient_failure',error:'synthetic ordinary401 stopped predecessor'};paper.latestAnalysisAttemptError='synthetic ordinary401 stopped predecessor';paper.latestAnalysisAttemptErrorCode='LLM_ACCOUNT_AUTH_ERROR';paper.latestAnalysisAttemptErrorScope='run';adapter.replaceJson(path.join(raw.directory,'analysis.json'),changed,raw.analysisFileSha256);const original=fs.readFileSync(path.join(raw.directory,'analysis.json')),next=continuation(f);let normal=0;
 const engine={...f.engine,analyzePaperWithRetry:async current=>{normal++;assert.equal(current.analysis,null);assert.equal(current.parsed,null);assert.equal(current.analysisCheckpoint,undefined);assert.equal(current.analysisManifest.stages.scoringAudit.status,'transient_failure');assert.equal(current.latestAnalysisAttemptErrorCode,'LLM_ACCOUNT_AUTH_ERROR');assert.doesNotThrow(()=>require('../scripts/lib/analysis-stage-request-guard').assertStageModelRequestAllowed('scoringAudit'));return{success:false,result:current,error:'synthetic fresh normal stage reached',retryable:false,scope:'paper'};}};
 await assert.rejects(adapter.refreshConferenceGrantedRecovery(next.request,{engine,deep:{...f.operations,refreshApiScoringAndReaderFromSource:()=>assert.fail('cannot treat null scientific main as scored reader input'),refreshApiReaderArticleFromSource:()=>assert.fail('cannot skip null scientific main')}}),/synthetic fresh normal stage reached/);assert.equal(normal,1);assert.deepEqual(fs.readFileSync(path.join(raw.directory,'analysis.json')),original);
});

test('续窗完成包可冷重开完整前链，但许可不替代真实发布科学资格（合成输出）',async t=>{
 const f=await predecessor(t),next=continuation(f),engine={...f.engine,isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>true};
 // Only this orchestration outcome is a double; the independent publication
 // call below uses its real scientific gate and must reject synthetic content.
 const result=await adapter.refreshConferenceGrantedRecovery(next.request,{engine,deep:{...f.operations,refreshApiReaderArticleFromSource:async paper=>paper}});assert.equal(result.status,'complete');const cold=adapter.loadGrantedConferenceRecovery({analysisRoot:f.analysisRoot,executionId:result.executionId});assert.equal(cold.run.status,'complete');assert.equal(cold.recoveryWindow.failed.run.executionId,f.prior.run.executionId);assert.equal(cold.recoveryWindow.failed.recoveryWindow.failed.run.executionId,f.failedExecutionId);assert.equal(cold.parent.run.executionId,f.parentExecutionId);
 assert.throws(()=>require('../scripts/lib/conference-postprocess').loadCompleted({analysisRoot:f.analysisRoot,executionId:result.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot}),e=>e.code==='CONFERENCE_POSTPROCESS_INTEGRITY');
});
