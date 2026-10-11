'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),cp=require('node:child_process');
const deep=require('../scripts/deep-analyzer.js'),config=require('../scripts/config.js'),utils=require('../scripts/utils.js');
test('实际辅助HTTP请求、usage与预算一致，Demo和其他阶段模型不变',async t=>{
 const bodies=[],events=[];const server=http.createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>{bodies.push(JSON.parse(text));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'本机成功'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base={model:'mimo-v2.6-flash',endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'synthetic',usageSink:e=>events.push(e)};
 for(const stage of ['openSourceScan','revision','scoringAudit','tagSelection']){await deep.callModelWithConfig([{role:'user',content:'本机请求'}],16000,1,{...base,usageContext:{stage}});assert.deepEqual(bodies.at(-1).thinking,{type:'disabled'});assert.equal(bodies.at(-1).max_tokens,16000);assert.deepEqual(events.at(-1).auxiliaryRequestPolicy,deep.resolveAuxiliaryRequestPolicy(stage,base));}
 for(const [stage,model] of [['demoLinkScan','mimo-v2.6-flash'],['methodRepair','mimo-v2.6-flash'],['primaryAnalysis','mimo-v2.6-flash'],['revision','other-model']]){await deep.callModelWithConfig([{role:'user',content:'本机请求'}],128,1,{...base,model,usageContext:{stage}});assert.equal(bodies.at(-1).thinking,undefined);assert.equal(events.at(-1).auxiliaryRequestPolicy,undefined);}
 config.ANALYSIS_CONFIG.auxiliaryThinkingMode='enabled';t.after(()=>{config.ANALYSIS_CONFIG.auxiliaryThinkingMode='disabled';});await deep.callModelWithConfig([{role:'user',content:'本机请求'}],128,1,{...base,usageContext:{stage:'revision'}});assert.deepEqual(bodies.at(-1).thinking,{type:'enabled'});assert.equal(events.at(-1).auxiliaryRequestPolicy.thinkingMode,'enabled');
});
function legacyControls(){
 for(const stage of ['openSourceScan','revision','tagSelection']){
 const text='旧保存完整正文。'.repeat(100),source='官方正文 evidence';const paper={arxivId:'2610.90091',analysisCheckpoint:text,analysisStageCheckpoints:{primaryAnalysis:text,[stage]:text}};const evidence=deep.buildStageEvidenceContext(stage,text,source),old=deep.buildTextStageFingerprint(stage,text,evidence);const manifest={stages:{[stage]:{status:'complete',fingerprint:old}}};paper.analysisManifest=manifest;const before=JSON.stringify(paper);
 const result=deep.prepareTextRecoveryStage(paper,manifest,stage,text,source);assert.equal(result.fingerprint,old);assert.equal(result.invalidated,false);assert.equal(JSON.stringify(paper),before);assert.equal(manifest.stages[stage].auxiliaryRequestPolicy,undefined);assert.notEqual(deep.buildTextStageFingerprint(stage,text,evidence,undefined,{}),old);
 const absent=structuredClone(paper);delete absent.analysisStageCheckpoints[stage];assert.equal(deep.prepareTextRecoveryStage(absent,absent.analysisManifest,stage,text,source).invalidated,true);
 const forged=structuredClone(paper);forged.analysisManifest.stages[stage].auxiliaryRequestPolicy=deep.resolveAuxiliaryRequestPolicy(stage);assert.equal(deep.prepareTextRecoveryStage(forged,forged.analysisManifest,stage,text,source).invalidated,true);
 }
 for(const stage of ['scoringAudit','openSourceScan','revision','tagSelection']){assert.deepEqual(deep.auxiliaryRequestPolicyFields(stage,{status:'complete'}),{});assert.equal(deep.auxiliaryRequestPolicyFields(stage,{status:'pending'}).auxiliaryRequestPolicy.thinkingMode,'disabled');const policy=deep.resolveAuxiliaryRequestPolicy(stage);assert.ok(deep.auxiliaryRequestPolicyFields(stage,{status:'complete',auxiliaryRequestPolicy:{...policy,thinkingMode:'enabled'}}).auxiliaryRequestPolicyMismatch);for(const bad of [null,{...policy,thinkingMode:'bad'},{...policy,extra:true}])assert.throws(()=>deep.auxiliaryRequestPolicyFields(stage,{status:'complete',auxiliaryRequestPolicy:bad}),/设置无效/);}
}
test('旧完整检查点原配方不补签，缺保存和伪新声明不能复用',t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const folder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aux-thinking-legacy-'));
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const dir of ['scripts','manual','prompts','config'])fs.cpSync(path.resolve(__dirname,'..',dir),path.join(folder,dir),{recursive:true});
 fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(folder,'node_modules'),'dir');
 fs.writeFileSync(path.join(folder,'.env'),'PAPER_ANALYZER_API_KEY=synthetic\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n',{mode:0o600});
 const program="const assert=require('node:assert/strict');const deep=require('./scripts/deep-analyzer.js');\n"+legacyControls.toString()+"\nlegacyControls();";
 const result=cp.spawnSync(process.execPath,['-e',program],{cwd:folder,env:{...process.env},encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
test('非法配置请求前拒绝，协议及冲突负控',t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const folder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aux-thinking-config-'));
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 fs.mkdirSync(path.join(folder,'scripts'));
 for(const file of ['config.js','env-loader.js','workspace-role.js'])fs.copyFileSync(path.resolve(__dirname,'../scripts',file),path.join(folder,'scripts',file));
 for(const mode of ['bad','DISABLED','', 'true']){
  fs.writeFileSync(path.join(folder,'.env'),'PAPER_ANALYZER_API_KEY=synthetic\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\nPD_ANALYSIS_AUXILIARY_THINKING_MODE='+mode+'\n',{mode:0o600});
  const r=cp.spawnSync(process.execPath,['-e',"require('./scripts/config.js')"],{cwd:folder,env:{...process.env},encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/只能为 enabled 或 disabled/);
 }
 const opts={usageContext:{stage:'revision'},auxiliaryThinkingMode:'disabled'};for(const protocol of ['anthropic','openai_responses','unknown'])assert.equal(utils.buildRequestBody(protocol,'mimo-v2.6-flash',[],128,0.7,opts).thinking,undefined);assert.throws(()=>utils.buildRequestBody('openai','mimo-v2.6-flash',[],128,0.7,{...opts,readerThinkingMode:'enabled'}),/冲突/);assert.throws(()=>utils.buildRequestBody('openai','mimo-v2.6-flash',[],128,0.7,{...opts,auxiliaryThinkingMode:'bad'}),/推理模式/);
});
