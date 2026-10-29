'use strict';
// Synthetic-only VM IPC tests. No project-config import, real environment or network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
if(process.env.CODEX_SANDBOX)throw new Error('Security regression requires the normal unsandboxed workspace');
const source=fs.readFileSync(path.join(__dirname,'../llm-worker.cjs'),'utf8');
const dummy='SYNTHETIC_DUMMY_ONLY_NOT_A_REAL_KEY',proxyDummy='SYNTHETIC_PROXY_DUMMY_ONLY';
const variants=[dummy,proxyDummy,encodeURIComponent(proxyDummy+':/@'),Buffer.from(proxyDummy).toString('base64')];
async function runWorker({status=200,body,thrown,output='合成正常返回正文',truncate=false,rawInput,config={}}={}){
 const handlers={},writes=[],calls=[];let exitCode;
 const responseBody=body??{model:'reported-synthetic-model',status:'completed',usage:{input_tokens:12,output_tokens:7},output_text:output};
 const api={validateApiEndpointUrl:value=>new URL(value),detectApiType:()=> 'openai_responses',
  buildRequestBody:(_protocol,model,messages,maxTokens)=>({model,messages,maxTokens}),buildApiUrl:(_protocol,endpoint)=>endpoint,
  buildHeaders:(_protocol,key)=>({Authorization:'Bearer '+key}),
  async requestLlmJson(...args){calls.push(args);if(thrown)throw thrown;return {statusCode:status,body:responseBody,raw:JSON.stringify(responseBody)};},
  parseResponseText:()=>output,getResponsesOutputTruncationError:()=>truncate?Object.assign(new Error('untrusted-helper-detail '+variants.join(' ')),{code:'MODEL_OUTPUT_TRUNCATED'}):null};
 const processStub={env:{},stdin:{setEncoding(){},on(name,callback){handlers[name]=callback;}},stdout:{write(value){writes.push(value);}},exit(code){exitCode=code;}};
 const cryptoStub={randomUUID:()=> '00000000-0000-4000-8000-000000000001',createHash:()=>({update(){return this;},digest(){return 'synthetic-public-input-identity';}})};
 const context={URL,Buffer,process:processStub,__dirname:'/synthetic/Resources',require(name){if(name==='node:fs')return {};if(name==='node:path')return path;if(name==='node:crypto')return cryptoStub;if(name.endsWith('/scripts/utils.js'))return api;throw new Error('unexpected worker mock import');}};
 vm.runInNewContext(source,context,{filename:'synthetic-worker-source'});
 const request={config:{endpoint:'https://model.invalid/v1',model:'synthetic-model',protocol:'responses',key:dummy,httpProxy:'http://synthetic-user:'+proxyDummy+'@proxy.invalid:8080',...config},messages:[{role:'user',content:'合成无网络请求'}],usageDirectory:'/synthetic-private-usage',runID:'00000000-0000-4000-8000-000000000002',paperID:'synthetic-paper'};
 handlers.data(rawInput??JSON.stringify(request));await handlers.end();
 assert.ok(writes.length===1&&!exitCode,'one structured terminal response');
 let packet;try{packet=JSON.parse(writes[0]);}catch{throw new Error('worker must emit valid structured JSON');}
 return {packet,calls,env:processStub.env};
}
function assertSafe(error){const text=JSON.stringify(error);assert.ok(variants.every(value=>!text.includes(value)),'public worker diagnostics contain no synthetic raw or encoded echo');}
test('HTTP failure categories remain distinct while arbitrary provider fields are suppressed',async()=>{
 for(const [status,category] of [[401,'authentication'],[403,'authentication'],[429,'rate_limit'],[500,'service'],[400,'request']]){
  const body={model:'reported-synthetic-model',usage:{input_tokens:9,output_tokens:2},error:{code:variants.join('_'),type:variants.join('_'),message:variants.join(' ')}};
  const {packet,calls}=await runWorker({status,body});
  assert.ok(packet.okay===false&&packet.error.code==='HTTP_'+status&&packet.error.category===category,'HTTP status and failure category preserved');
  assert.ok(packet.error.providerCode==='','unknown provider code is not echoed');assertSafe(packet.error);
  assert.ok(packet.usage.input_tokens===9&&packet.model===body.model,'actual reported usage and model remain available');
  assert.ok(calls.length===1&&calls[0][5].recordUsage===true&&calls[0][5].apiKeys[0]===dummy,'normal usage and account request options retained');
 }
});
test('known balance/auth/rate provider enum survives but reflected text does not',async()=>{
 for(const [status,code,category] of [[402,'insufficient_balance','quota'],[401,'invalid_api_key','authentication'],[429,'rate_limit_exceeded','rate_limit']]){
  const {packet}=await runWorker({status,body:{error:{code,message:variants.join(' ')},usage:{input_tokens:1}}});
  assert.ok(packet.okay===false&&packet.error.providerCode===code&&packet.error.category===category,'known semantic provider code retained');assertSafe(packet.error);
 }
});
test('transport/auth/quota/persistence codes keep their own safe classification',async()=>{
 for(const [code,category] of [['ECONNRESET','transport'],['PROXY_CONNECT_REJECTED','transport'],['PROXY_CONNECT_TIMEOUT','transport'],['REQUEST_DEADLINE_EXCEEDED','transport'],['LLM_ACCOUNT_AUTH_ERROR','authentication'],['LLM_ACCOUNT_POOL_EXHAUSTED','quota_exhausted'],['LLM_ACCOUNT_POOL_CONFIG_ERROR','config'],['LLM_USAGE_NOT_PERSISTED','persistence'],['LLM_REQUEST_START_NOT_PERSISTED','persistence'],['LLM_RESPONSE_PARSE_ERROR','response']]){
  const {packet}=await runWorker({thrown:Object.assign(new Error(variants.join(' ')),{code,category:variants.join(' '),providerCode:variants.join(' ')})});
  assert.ok(packet.okay===false&&packet.error.code===code&&packet.error.category===category,'known failure is not rewritten as authentication');assertSafe(packet.error);
 }
});
test('unknown thrown code/category/message never crosses diagnostics boundary',async()=>{
 const {packet}=await runWorker({thrown:Object.assign(new Error(variants.join(' ')),{code:variants.join('_'),category:variants.join('_'),providerCode:variants.join('_')})});
 assert.ok(packet.okay===false&&packet.error.code==='MODEL_REQUEST_FAILED'&&packet.error.category==='unknown','unknown error uses fixed non-auth fallback');assertSafe(packet.error);
});
test('invalid JSON input cannot echo parser excerpts',async()=>{
 const {packet}=await runWorker({rawInput:'{invalid '+variants.join(' ')});
 assert.ok(packet.okay===false&&packet.error.code==='MODEL_REQUEST_FAILED','invalid input remains failure');assertSafe(packet.error);
});
test('normal application validation preserves exact safe UI diagnosis',async()=>{
 const {packet,calls}=await runWorker({config:{responsesStream:'invalid-boolean'}});
 assert.ok(packet.okay===false&&packet.error.category==='config'&&packet.error.message==='Responses 流式设置必须为布尔值'&&calls.length===0,'fixed local validation remains readable and makes no request');
});
test('successful content and raw usage semantics are unchanged',async()=>{
 const body={model:'reported-synthetic-model',status:'completed',usage:{input_tokens:12,output_tokens:7,details:{reasoning_tokens:2}}};
 const {packet,calls,env}=await runWorker({body,output:'合成正常回答保持逐字'});
 assert.ok(packet.okay===true&&packet.text==='合成正常回答保持逐字'&&packet.error===null,'success is not rewritten by diagnostic policy');
 assert.ok(JSON.stringify(packet.usage)===JSON.stringify(body.usage)&&packet.model===body.model&&packet.finishStatus==='completed','actual usage/model/terminal state preserved');
 assert.ok(calls[0][4].Authorization==='Bearer '+dummy&&env.HTTP_PROXY.includes(proxyDummy),'request credential and legal proxy authentication functionality retained');
 assert.ok(calls[0][3].store===false,'normal Responses privacy option retained');
});
test('truncation incomplete and empty output remain paid failures with original returned text and usage',async()=>{
 for(const [options,code,category] of [[{truncate:true},'MODEL_OUTPUT_TRUNCATED','truncation'],[{body:{model:'reported-synthetic-model',status:'failed',usage:{input_tokens:8,output_tokens:3}}},'MODEL_RESPONSE_INCOMPLETE','incomplete'],[{output:''},'MODEL_EMPTY_OUTPUT','empty_output']]){
  const {packet}=await runWorker(options);
  assert.ok(packet.okay===false&&packet.error.code===code&&packet.error.category===category,'failure kind retained, not success or authentication');
  assert.ok(packet.text===(options.output??'合成正常返回正文')&&!!packet.usage,'returned text and usage retained without automatic replay');assertSafe(packet.error);
 }
});
test('native console is categorical while existing native toast remains unchanged',()=>{
 const native=fs.readFileSync(path.join(__dirname,'../Resources/native.js'),'utf8'),start=native.indexOf('function error(e){'),end=native.indexOf('function icons(',start);assert.ok(start>=0&&end>start,'native function boundary exists');
 const toasts=[],logs=[];const invoke=vm.runInNewContext(native.slice(start,end)+';error',{toast:value=>toasts.push(value),console:{error:value=>logs.push(value)}});
 invoke(new Error(variants.join(' ')));
 assert.ok(logs.length===1&&variants.every(value=>!logs[0].includes(value)),'console does not duplicate arbitrary exception text');
 assert.ok(toasts.length===1&&toasts[0]===variants.join(' '),'task leaves normal native toast policy unchanged');
});
