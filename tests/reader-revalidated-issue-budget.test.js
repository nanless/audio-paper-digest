'use strict';process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),repair=require('../scripts/lib/reader-repair.js');
const old=[{path:'/sections/2/body',code:'reader_workflow_leakage',message:'写作指令泄漏，当前 2 处'}];
const next=[{path:'/tableBindings/0',code:'reader_invalid_source_quotes',message:'原表逐字引文未覆盖全部数字与单位'}];
function input(issues=old){return {candidateRevalidated:true,identity:{maxAttempts:3},maxAttempts:3,attemptLimit:3,currentIssues:next,recovered:{draft:{sections:[]},attempts:2,fullAttempts:1,noProgress:1,validationFailureStreak:2,issues,validationFailureSignature:repair.validationFailureSignature(issues),failureSignature:repair.hashRecoveryIssues(issues)}};}
const allow=x=>repair.canContinueRevalidatedIssuesWithinBudget(x);
test('different complete validation result uses only original remaining response and mutates no counters',()=>{const i=input(),before=structuredClone(i);assert.equal(allow(i),true);assert.deepEqual(i,before);assert.equal(i.attemptLimit-i.recovered.attempts,1);});
test('same gate, retained old gate plus new gate, another cell of same gate and numeric threshold changes do not reopen',()=>{
 for(const currentIssues of [old,[...old,...next],[{...old[0],path:'/sections/12/body'}],[{...old[0],message:'写作指令泄漏，当前 1 处'}]])assert.equal(allow({...input(),currentIssues}),false);
 const legacy=[{path:null,message:'中文字数必须为 5000–18000，当前 4800'}];assert.equal(allow({...input(legacy),currentIssues:[{path:null,message:'中文字数必须为 5200–18000，当前 4950'}]}),false);
});
test('missing, malformed, stale or self-inconsistent saved signatures cannot reopen',()=>{
 for(const edit of [i=>delete i.recovered.failureSignature,i=>delete i.recovered.validationFailureSignature,i=>i.recovered.validationFailureSignature='reader-validation-v2:{}',i=>i.recovered.validationFailureSignature='reader-validation-v2:'+JSON.stringify({gateSha256:'0'.repeat(64),deficits:[]}),i=>i.recovered.failureSignature='0'.repeat(64),i=>i.recovered.issues=[],i=>i.currentIssues=[],i=>i.currentIssues=[{path:null,message:'bad'}]]){const i=input();edit(i);assert.equal(allow(i),false);}
});
test('original max, completed full responses, transport/content interruption and explicit/extra allowance retain original stop',()=>{
 for(const edit of [i=>i.recovered.attempts=3,i=>i.recovered.fullAttempts=2,i=>i.recovered.lastTransportError='503',i=>i.recovered.lastContentError={code:'MODEL_OUTPUT_TRUNCATED'},i=>i.attemptLimit=4,i=>i.maxAttempts=4,i=>i.identity.maxAttempts=6,i=>i.explicitRound={maxResponses:3},i=>i.candidateRevalidated=false]){const i=input();edit(i);assert.equal(allow(i),false);}
});
test('diagnostic-only changes cannot erase old blocking rules',()=>{
 const i=input();i.currentIssues=[...old,{...next[0],diagnosticOnly:true}];assert.equal(allow(i),false);
});
test('normal shared generator spends at most the existing final response and transport interruption preserves all old counts',async t=>{
 const os=require('node:os'),deep=require('../scripts/deep-analyzer');
 const sample=require(path.join(root,'tests/reader-signed-draft-fixture')).fixture({noFigures:true});
 sample.draft.sections[0].body+='\n\n表后解释：';
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-remaining-original-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let calls=0;const paper={arxivId:'2610.99012',title:'原额内真实恢复边界测试'},options={sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaxAttempts:3,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},readerCallModel:async()=>{calls++;throw Object.assign(new Error('TEST-ONLY-ORIGINAL-REQUEST-BOUNDARY'),{scope:'run',retryable:false});}};
 const {identity}=await deep.generateApiReaderArticleDetailed(paper,'','',{...options,readerIdentityOnly:true});
 const payload=input().recovered;payload.draft=sample.draft;payload.rawDraft=JSON.stringify(sample.draft);payload.status='failed';payload.issues=[{path:'/sections/14/body',code:'reader_resource_availability_claim',message:'本文资源声明没有对应的已验证可达状态'}];payload.validationFailureSignature=repair.validationFailureSignature(payload.issues);payload.failureSignature=repair.hashRecoveryIssues(payload.issues);
 repair.saveFailedCandidate(directory,identity,payload);
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/TEST-ONLY-ORIGINAL-REQUEST-BOUNDARY/);
 assert.equal(calls,1);const saved=repair.loadFailedCandidate(directory,identity);
 for(const key of ['attempts','fullAttempts','noProgress','validationFailureStreak','failureSignature','validationFailureSignature'])assert.deepEqual(saved[key],payload[key],key);
 assert.equal(saved.transportFailures,1);assert.equal(saved.implementationRepairAllowanceProof,null);
 payload.attempts=3;repair.saveFailedCandidate(directory,identity,payload);calls=0;
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/修复次数已用完/);assert.equal(calls,0);
});
test('normalization failure before the complete parser never releases a historical stop',async t=>{
 const os=require('node:os'),deep=require('../scripts/deep-analyzer');
 const sample=require(path.join(root,'tests/reader-signed-draft-fixture')).fixture({noFigures:true});
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-normalization-original-stop-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let calls=0;const paper={arxivId:'2610.99013',title:'完整解析前归一化不能释放旧停止'},options={sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaxAttempts:3,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},readerCallModel:async()=>{calls++;throw Error('MUST-NOT-REACH-MODEL-BOUNDARY');}};
 const {identity}=await deep.generateApiReaderArticleDetailed(paper,'','',{...options,readerIdentityOnly:true});
 const payload=input().recovered;Object.assign(payload,{draft:sample.draft,rawDraft:JSON.stringify(sample.draft),status:'failed'});
 repair.saveFailedCandidate(directory,identity,payload);const file=path.join(directory,repair.hashDraft(identity)+'.json'),bytes=fs.readFileSync(file);
 const original=repair.normalizeUnavailableReaderFigures;repair.normalizeUnavailableReaderFigures=()=>{throw Error('当前新的归一化错误，尚未执行完整文章解析器');};t.after(()=>repair.normalizeUnavailableReaderFigures=original);
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/修复次数已用完/);
 assert.equal(calls,0);assert(fs.readFileSync(file).equals(bytes),'original candidate/counts must remain unchanged');
});
