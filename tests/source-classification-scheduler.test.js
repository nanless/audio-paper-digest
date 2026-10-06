'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{runBounded}=require('../scripts/lib/source-classification-scheduler.js');
const failure=e=>e.code==='LLM_ACCOUNT_POOL_EXHAUSTED'?'account-pool-exhausted':null;
test('有界工作线程即使完成顺序错乱，也保持选中结果的位置',async()=>{
 let active=0,peak=0;const releases=[];
 const run=runBounded([0,1,2,3,4].map(i=>({paperId:String(i)})),{concurrency:3,isRunFailure:failure,processItem:async(item,index,control)=>{
  await control.request(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>releases[index]=resolve);active--;});return {paperId:item.paperId};
 }});
 await Promise.resolve();assert.equal(peak,3);releases[2]();await new Promise(resolve=>setImmediate(resolve));releases[0]();releases[1]();await new Promise(resolve=>setImmediate(resolve));releases[4]();releases[3]();
 const result=await run;assert.equal(result.stopped,null);assert.deepEqual(result.results.map(r=>r.paperId),['0','1','2','3','4']);assert.equal(peak,3);
});
test('带类型的配额会停止派发，并在已有响应在途后阻止复审与重选',async()=>{
 let releaseSecond,requests=0;const quota=Object.assign(new Error('quota'),{code:'LLM_ACCOUNT_POOL_EXHAUSTED'});
 const run=runBounded([{paperId:'first'},{paperId:'second'},{paperId:'never'}],{concurrency:2,isRunFailure:failure,processItem:async(item,index,control)=>{
  if(index===0) {await control.request(async()=>{requests++;throw quota;});}
  else {await control.request(async()=>{requests++;await new Promise(resolve=>releaseSecond=resolve);});await control.request(async()=>{requests++;});}
  return {paperId:item.paperId};
 }});
 await new Promise(resolve=>setImmediate(resolve));releaseSecond();const result=await run;
 assert.equal(requests,2);assert.equal(result.stopped.status,'account-pool-exhausted');assert.equal(result.results.filter(Boolean).length,0);
});
test('运维停止会保留已接受的完成响应，未派发的工作仍保持待办',async()=>{
 const controller=new AbortController();let calls=0;
 const result=await runBounded([{paperId:'one'},{paperId:'two'}],{concurrency:1,isRunFailure:failure,signal:controller.signal,processItem:async(item,index,control)=>{
  await control.request(async()=>{calls++;});controller.abort();return {paperId:item.paperId};
 }});
 assert.equal(calls,1);assert.equal(result.results[0].paperId,'one');assert.equal(result.results[1],undefined);assert.equal(result.stopped.status,'operator-stopped');
 await assert.rejects(()=>runBounded([],{concurrency:4,processItem:async()=>{},isRunFailure:failure}),/1–3/);
});
