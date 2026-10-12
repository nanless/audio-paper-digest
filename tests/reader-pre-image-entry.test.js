'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const deep=require('../scripts/deep-analyzer'),repair=require('../scripts/lib/reader-repair');
async function createSample(t,{badDraft=true,attempts=3,noProgress=2}={}){
 const sample=require('./reader-signed-draft-fixture').fixture({noFigures:true});
 sample.draft.sections.reverse();
 if(badDraft)sample.draft.tableBindings[0]={tableIndex:1,selection:{sourceTableOrdinal:1,sourceRows:[0,1],sourceColumns:[0,1]}};
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-before-images-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let downloads=0,models=0;
 const paper={arxivId:'2609.99113',title:'像素前判断受控样例'};
 const evidence='FIGURE_1: Source figure caption\nFIGURE_1_URL: https://arxiv.org/html/2609.99113v1/f1.png';
 const options={sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaxAttempts:3,readerMaterializeFigures:async()=>{downloads++;return [];},readerRecordDisposition:()=>{},readerCallModel:async()=>{models++;throw new Error('OFFLINE_MODEL_BOUNDARY');}};
 const {identity}=await deep.generateApiReaderArticleDetailed(paper,'',evidence,{...options,readerIdentityOnly:true});
 repair.saveFailedCandidate(directory,identity,{status:'failed',draft:sample.draft,rawDraft:JSON.stringify(sample.draft),issues:[],attempts,fullAttempts:1,noProgress,failureSignature:'old failure',validationFailureStreak:noProgress});
 return {directory,identity,run:()=>deep.generateApiReaderArticleDetailed(paper,'',evidence,options),counts:()=>({downloads,models})};
}
test('公开入口的耗尽纯DOM错误在图片请求前停止',async t=>{const s=await createSample(t);await assert.rejects(s.run,/纯文本\/封存表格检查仍失败/);assert.deepEqual(s.counts(),{downloads:0,models:0});});
test('预算有余的公开入口继续原图片及修复请求',async t=>{const s=await createSample(t,{attempts:1,noProgress:0});await assert.rejects(s.run,/OFFLINE_MODEL_BOUNDARY/);assert.equal(s.counts().downloads,1);assert.equal(s.counts().models,1);});
test('旧失败稿被当前归一化接受不会被永久拦住',async t=>{const s=await createSample(t,{badDraft:false});const result=await s.run();assert.equal(s.counts().downloads,1);assert.equal(s.counts().models,0);assert.equal(result.resumedCandidate,true);});
test('损坏候选证明不能冒认旧图或接受正文',async t=>{const s=await createSample(t);const file=path.join(s.directory,repair.hashDraft(s.identity)+'.json');const payload=JSON.parse(fs.readFileSync(file));payload.payload.draft.sections[0].body+='tamper';fs.writeFileSync(file,JSON.stringify(payload));await assert.rejects(s.run,/Corrupt or drifted Reader candidate/);assert.deepEqual(s.counts(),{downloads:0,models:0});});
test('预备新轮保留原下载并由原入口继续核验授权，不被提前失败覆盖',async t=>{const s=await createSample(t);const dir=path.join(s.directory,'explicit-retry-rounds');fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'11111111-2222-4333-8444-555555555555.json'),JSON.stringify({status:'prepared',grant:{identitySha256:repair.hashDraft(s.identity)}}),{mode:0o600});await assert.rejects(s.run);assert.equal(s.counts().downloads,1);assert.equal(s.counts().models,0);});

test('无关损坏receipt不让早筛阻断本论文，交回原下载路径',async t=>{const s=await createSample(t);const dir=path.join(s.directory,'explicit-retry-rounds');fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'),'{broken unrelated receipt',{mode:0o600});await assert.rejects(s.run);assert.equal(s.counts().downloads,1);assert.equal(s.counts().models,0);});
test('可继续的完整候选不读取无关坏receipt并正常接受',async t=>{const s=await createSample(t,{badDraft:false});const dir=path.join(s.directory,'explicit-retry-rounds');fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'),'{broken unrelated receipt',{mode:0o600});const result=await s.run();assert.equal(result.resumedCandidate,true);assert.deepEqual(s.counts(),{downloads:1,models:0});});
