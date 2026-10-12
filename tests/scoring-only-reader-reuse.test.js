'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// 直接运行生产代码的复用与修订分支，不发送模型或资源请求。
const source=fs.readFileSync(path.resolve(__dirname,'../scripts/deep-analyzer.js'),'utf8');
const begin=source.indexOf('async function refreshApiScoringAndReaderInternal');
const reuseStart=source.indexOf('    const rawRequestedReviewFeedback =',begin)>=0?source.indexOf('    const rawRequestedReviewFeedback =',begin):source.indexOf('    const requestedReviewFeedback =',begin);
const reuseEnd=source.indexOf('    if (!analysis ||',reuseStart);
const seedStart=source.indexOf('    const scoringOnly =',reuseEnd)>=0&&source.indexOf('    const scoringOnly =',reuseEnd)<source.indexOf('    analysis = applyApiReaderResourceAvailability',reuseEnd)?source.indexOf('    const scoringOnly =',reuseEnd):source.indexOf('    const readerRevisionSeed =',reuseEnd);
const seedEnd=source.indexOf('    analysis = applyApiReaderResourceAvailability',seedStart);
assert.ok(begin>=0&&reuseStart>begin&&reuseEnd>reuseStart&&seedStart>reuseEnd&&seedEnd>seedStart);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('require','crypto','paper','sourceDetails','options','scoringFactReview','getPaperArxivId','prepareApiReaderRevisionSeed','buildApiReaderResourceIdentity','manifest','analysis','sourceText',source.slice(reuseStart,reuseEnd)+source.slice(seedStart,seedEnd)+'return {existingReaderReusable,readerRevisionSeed};');
async function createSample({scoringOnly=true,readerValid=true,authorsValid=true,feedback='verified feedback\n',signedFeedback=feedback,resourceChanged=false,seedInvalid=false}={}){
 let seeds=0,resources=0;const paper={arxivId:'2601.00001',analysisManifest:{stages:{apiReaderArticle:{reviewFeedbackSha256:crypto.createHash('sha256').update(signedFeedback).digest('hex')}}},apiReaderResources:{identitySha256:'a'.repeat(64)}};
 const requireStub=name=>name.includes('analysis-engine')?{hasValidApiReaderV3Records:()=>readerValid}:{canReuseReaderAuthorInputs:()=>authorsValid};
 const result=()=>run(requireStub,crypto,paper,{}, {reviewFeedback:feedback},{current:()=>({scoringOnly})},p=>p.arxivId,()=>{seeds++;if(seedInvalid)throw new Error('invalid signed revision');return {signed:true};},async()=>{resources++;return {identitySha256:(resourceChanged?'b':'a').repeat(64)};},paper.analysisManifest,'analysis','source');
 return {result,counts:()=>({seeds,resources})};
}
test('独立评分复用真实已签Reader，原始末尾换行不触发Reader重写种子',async()=>{const f=await createSample({seedInvalid:true});const r=await f.result();assert.equal(r.existingReaderReusable,true);assert.equal(r.readerRevisionSeed,null);assert.deepEqual(f.counts(),{seeds:0,resources:1});});
test('trim签名仍复用同一反馈',async()=>{const f=await createSample({signedFeedback:'verified feedback',seedInvalid:true});await f.result();assert.deepEqual(f.counts(),{seeds:0,resources:1});});
for(const [name,changes] of [['Reader字节无效',{readerValid:false}],['作者来源无效',{authorsValid:false}],['反馈内容变化',{feedback:'changed feedback',signedFeedback:'verified feedback\n'}]])test(name+'在资源和评分前拒绝',async()=>{const f=await createSample(changes);await assert.rejects(f.result,/独立评分范围/);assert.deepEqual(f.counts(),{seeds:0,resources:0});});
test('资源身份变化在评分前拒绝',async()=>{const f=await createSample({resourceChanged:true});await assert.rejects(f.result,/独立评分范围/);assert.deepEqual(f.counts(),{seeds:0,resources:1});});
test('普通Reader定向修订仍核验签名种子并先于资源请求拒绝无效种子',async()=>{const f=await createSample({scoringOnly:false,seedInvalid:true});await assert.rejects(f.result,/invalid signed revision/);assert.deepEqual(f.counts(),{seeds:1,resources:0});});
test('普通合法Reader定向修订仍保留种子',async()=>{const f=await createSample({scoringOnly:false});const r=await f.result();assert.deepEqual(r.readerRevisionSeed,{signed:true});assert.deepEqual(f.counts(),{seeds:1,resources:1});});

test('公开评分刷新入口保留已签Reader并到达评分调用，零网络请求',async t=>{
 const Module=require('node:module');
 const helperFile=path.resolve(__dirname,'reader-completed-primary-revision-seed.test.js');
 const helper=new Module(helperFile,module);helper.filename=helperFile;helper.paths=Module._nodeModulePaths(path.dirname(helperFile));
 const helperSource=fs.readFileSync(helperFile,'utf8').split("test('同一已核验反馈")[0];
 helper._compile(helperSource+'\nmodule.exports={createReviewedReaderSample};',helperFile);
 const signedFile=path.resolve(__dirname,'reader-signed-draft-fixture.js');
 const savedSigned=require.cache[signedFile];
 const extendedSigned=new Module(signedFile,module);extendedSigned.filename=signedFile;extendedSigned.paths=Module._nodeModulePaths(path.dirname(signedFile));
 extendedSigned._compile(fs.readFileSync(signedFile,'utf8').replace("const text='The source reports a controlled measurement of 1.0 under the same protocol.';","const text='The source reports a controlled measurement of 1.0 under the same protocol.'.repeat(100);"),signedFile);
 require.cache[signedFile]=extendedSigned;
 let sample;try{sample=await helper.exports.createReviewedReaderSample(t);}finally{if(savedSigned)require.cache[signedFile]=savedSigned;else delete require.cache[signedFile];}
 const deepFile=path.resolve(__dirname,'../scripts/deep-analyzer.js');
 const runtime=new Module(deepFile,module);runtime.filename=deepFile;runtime.paths=Module._nodeModulePaths(path.dirname(deepFile));
 runtime._compile(fs.readFileSync(deepFile,'utf8')+`\nmodule.exports.setOfflineScoringBoundary=function(identity){buildApiReaderResourceIdentity=async()=>identity;auditTypeAwareScoringDetailed=async()=>{throw Object.assign(new Error('OFFLINE_SCORING_BOUNDARY'),{code:'OFFLINE_SCORING_BOUNDARY'});};};`,deepFile);
 const facts=require('../scripts/lib/daily-fact-review'),daily=require('../scripts/lib/daily-fresh-source-plan');
 const scoring={...sample.feedback,primaryFeedback:'',coreFeedback:'',readerFeedback:'',rejectedPrimaryClaims:[],rejectedReaderClaims:[],scoringFeedback:'同一配置缺失仅归可复现性，不重复归清晰度；保留其他真实证据评分。',rejectedScoringClaims:['已否定的旧评分原句']};
 const sb=facts.validateFeedback(scoring,sample.plan,sample.paper);
 const assembled=facts.withFactReview(sample.bound,()=>facts.reviewFeedback('apiReaderArticle',sample.id));
 sample.paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256=facts.sha(assembled);
 runtime.exports.setOfflineScoringBoundary(sample.paper.apiReaderResources);
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan,()=>daily.withDailyFreshPaperSource(sample.plan,sample.paper,source=>facts.withScoringFactReviews(sb,sample.bound,sample.paper,()=>runtime.exports.refreshApiScoringAndReaderFromSource(sample.paper,source,{reviewFeedback:assembled})))),error=>error.code==='OFFLINE_SCORING_BOUNDARY');
});
