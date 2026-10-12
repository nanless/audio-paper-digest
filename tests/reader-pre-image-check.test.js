'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {checkReaderBeforeImages}=require('../scripts/lib/reader-pre-image-check');
function createSample(changes={}){return {recovered:{draft:{sections:[]},attempts:6,noProgress:2,issues:[]},maxAttempts:6,hasPendingGrant:false,hasUnusedAllowance:false,canEscalate:false,normalizeCandidate:()=>{throw Object.assign(new Error('纯DOM表格身份不能对应'),{code:'TABLE_ORDER'});},isIndependentFailure:e=>e.code==='TABLE_ORDER',readerAttemptLimit:()=>6,...changes};}
test('纯DOM仍失败且预算耗尽提前停止，候选不变',()=>{const s=createSample(),before=JSON.stringify(s.recovered);assert.equal(checkReaderBeforeImages(s).action,'stop');assert.equal(JSON.stringify(s.recovered),before);});
for(const [name,change] of [['预算有余',{recovered:{draft:{},attempts:1,noProgress:0,validationFailureStreak:0}}],['显式新授权',{hasPendingGrant:true}],['实现许可',{hasUnusedAllowance:true}],['截断升级许可',{canEscalate:true}]])test(name+'保留原下载',()=>{let calls=0;const s=createSample({...change,normalizeCandidate:()=>{calls++;throw Object.assign(new Error('纯DOM'),{code:'TABLE_ORDER'});}});assert.equal(checkReaderBeforeImages(s).action,'download');assert.equal(calls,name==='显式新授权'?1:0);});
test('新校验器接受旧失败稿继续下载后完整验收',()=>{assert.equal(checkReaderBeforeImages(createSample({normalizeCandidate:()=>({accepted:true})})).action,'download');});
test('像素或其他未知失败不冒认像素证明，继续下载',()=>{assert.equal(checkReaderBeforeImages(createSample({normalizeCandidate:()=>{throw new Error('像素证明不足')}})).action,'download');});
test('缺候选或无效计数不提前判失败',()=>{assert.equal(checkReaderBeforeImages(createSample({recovered:null})).action,'download');assert.equal(checkReaderBeforeImages(createSample({recovered:{draft:{},attempts:-1,noProgress:2}})).action,'download');});

test('当前归一化通过或预算有余均不扫描receipt',()=>{for(const change of [{normalizeCandidate:()=>{}},{recovered:{draft:{},attempts:1,noProgress:0}}]){let scans=0;assert.equal(checkReaderBeforeImages(createSample({...change,hasPendingGrant:()=>{scans++;throw new Error('不应扫描');}})).action,'download');assert.equal(scans,0);}});
