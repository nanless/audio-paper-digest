'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/source-classification-failures.js'),scheduler=require('../scripts/lib/source-classification-scheduler.js');
const typed=(code,category,extra={})=>Object.assign(new Error('Typed engine failure'),{code,category,modelRequestClassified:true,...extra});
test('按引擎标记和明确的超时错误码判定运行级失败，不按错误文字猜测',()=>{
 for(const status of [429,500,502,503])assert.equal(api.classifyRunFailure(typed('MODEL_HTTP_TRANSIENT','http_transient',{status})),'model-service-http-unavailable');
 assert.equal(api.classifyRunFailure(typed('ECONNRESET','network')),'model-service-network-unavailable');
 assert.equal(api.classifyRunFailure(Object.assign(new Error(),{code:'MODEL_OVERALL_TIMEOUT'})),'model-service-timeout');
 assert.equal(api.classifyRunFailure(typed('SSE_TERMINAL_EVENT_MISSING','stream_terminal')),'model-service-response-unavailable');
 assert.equal(api.classifyRunFailure(typed('MODEL_ENDPOINT_CONFIG_ERROR','endpoint_config')),'model-service-configuration-unavailable');
 assert.equal(api.classifyRunFailure(new Error('HTTP 429 ECONNRESET in paper quote')) ,null);
 assert.equal(api.classifyRunFailure(Object.assign(new Error(),{category:'network',code:'ECONNRESET'})),null);
 const inherited=Object.create({modelRequestClassified:true});inherited.category='network';assert.equal(api.classifyRunFailure(inherited),null);
 assert.equal(api.classifyRunFailure(typed('MODEL_HTTP_TRANSIENT','http_transient',{status:200})),null);
});
test('带类型的输出上限和不完整输出只算单篇问题；本地引文和语义错误绝不暂停批次',()=>{
 for(const code of ['MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_INCOMPLETE','MODEL_RESPONSE_TOO_LARGE','RESPONSE_TOO_LARGE']) {
  const error=typed(code,'output_incomplete');assert.equal(api.isPaperOutputFailure(error),true);assert.equal(api.classifyRunFailure(error),null);
 }
 for(const text of ['source quote mismatch','independent review rejected','missing PDF evidence','unknown taxonomy role'])assert.equal(api.classifyRunFailure(new Error(text)),null);
});
test('检查包装错误的原因时能识别网络错误，并跳过循环引用和无关错误文字',()=>{
 const wrapped=new Error('Wrapper');wrapped.cause=typed('REQUEST_SOCKET_TIMEOUT','network');wrapped.cause.cause=wrapped;
 assert.equal(api.classifyRunFailure(wrapped),'model-service-network-unavailable');
 const cyclic={category:'network',text:'MODEL_HTTP_TRANSIENT'};cyclic.cause=cyclic;assert.equal(api.classifyRunFailure(cyclic),null);
});
test('判定函数识别引擎生成的 HTTP、网络和输出错误类型，且不发模型请求',()=>{
 const engine=require('../scripts/deep-analyzer.js'),config={key:'test-only',apiKeys:[],maxResponseBytes:1048576};
 for(const status of [429,500,503]) {
  const error=engine.makeModelHttpError(status,'Test transient',config);
  assert.equal(error.code,'MODEL_HTTP_TRANSIENT');assert.equal(api.classifyRunFailure(error),'model-service-http-unavailable');
 }
 const network=engine.classifyModelRequestError(Object.assign(new Error('Unit test'),{code:'ECONNRESET'}),config);
 assert.equal(network.modelRequestClassified,true);assert.equal(api.classifyRunFailure(network),'model-service-network-unavailable');
 const output=engine.classifyModelRequestError(Object.assign(new Error('Unit output limit'),{code:'RESPONSE_TOO_LARGE'}),config);
 assert.equal(output.code,'MODEL_RESPONSE_TOO_LARGE');assert.equal(api.isPaperOutputFailure(output),true);assert.equal(api.classifyRunFailure(output),null);
 for(const code of ['MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_INCOMPLETE'])assert.equal(api.classifyRunFailure(engine.classifyModelRequestError(Object.assign(new Error('Unit incomplete'),{code}),config)),null);
});
test('普通 HTTP 429 会让调度器暂停，不派发第二次审查、不切换账号、也不把待处理论文标记完成',async()=>{
 let requests=0,release;const inFlight=new Promise(resolve=>release=resolve);
 const run=scheduler.runBounded(['a','b','c'],{concurrency:2,isRunFailure:api.classifyRunFailure,
  processItem:async(item,index,control)=>{await control.request(async()=>{requests++;if(item==='a')throw typed('MODEL_HTTP_TRANSIENT','http_transient',{status:429});await inFlight;return 'saved-response';});await control.request(async()=>{requests++;});return {accepted:item};}});
 await new Promise(resolve=>setImmediate(resolve));release();const result=await run;
 assert.equal(requests,2);assert.equal(result.stopped.status,'model-service-http-unavailable');assert.equal(result.results.filter(Boolean).length,0);
});

test('明确的存储错误含包装或组合错误会停止运行，论文中同名文字不触发', () => {
 for(const code of ['EIO','ENOSPC','EDQUOT','EROFS','EMFILE','ENFILE','EACCES','EPERM']) {
  const error=Object.assign(new Error('写入失败'),{code});
  assert.equal(api.classifyRunFailure(error),'local-storage-unavailable');
  assert.equal(api.classifyRunFailure(new Error('包装',{cause:error})),'local-storage-unavailable');
  assert.equal(api.classifyRunFailure(new AggregateError([new Error('其它'),error])),'local-storage-unavailable');
 }
 assert.equal(api.classifyRunFailure(new Error('论文原文提到ENOSPC和EIO')),null);
});

test('存储失败后等待已开始的任务结束并保留其结果，不派发后续论文或额外审查', async () => {
 let release,requests=0;
 const blocked=new Promise(resolve=>release=resolve);
 const run=scheduler.runBounded(['first','in-flight','never'],{concurrency:2,isRunFailure:api.classifyRunFailure,
  processItem:async(item,index,control)=>{
   await control.request(async()=>{requests++;if(item==='in-flight')await blocked;});
   if(item==='first')throw Object.assign(new Error('磁盘已满'),{code:'ENOSPC'});
   return {paperId:item};
  }});
 await new Promise(resolve=>setImmediate(resolve));release();
 const result=await run;
 assert.equal(result.stopped.status,'local-storage-unavailable');assert.equal(requests,2);
 assert.equal(result.results[1].paperId,'in-flight');assert.equal(result.results[2],undefined);
});
