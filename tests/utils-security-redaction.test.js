'use strict';
// Pure VM transport mocks. Never import project config or open a socket/env/private file.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
if(process.env.CODEX_SANDBOX)throw new Error('Security regression requires the normal unsandboxed workspace');
// Root tests/*.test.js discovery also exercises the platform-independent worker VM cases.
require('../apps/macos/Tests/WorkerErrorPrivacy.test.cjs');
const source=fs.readFileSync(path.join(__dirname,'../scripts/utils.js'),'utf8');
const timer=()=>({unref(){}});
function fragment(name,next){const start=source.indexOf('function '+name+'('),end=source.indexOf(next,start);assert.ok(start>=0&&end>start,'production function boundary exists');return source.slice(start,end);}
const dummy='SYNTHETIC_DUMMY_ONLY_NOT_A_REAL_CREDENTIAL';
function proxyHarness(statusLine){
 class Socket extends EventEmitter{write(value){this.sent=value;}destroy(){this.destroyed=true;}}
 class Agent{destroy(){this.destroyed=true;}}
 const socket=new Socket();let tlsCalls=0;
 const context={URL,Buffer,Set,decodeURIComponent,setTimeout:timer,clearTimeout(){},setImmediate:timer,clearImmediate(){},
  createActiveTimeBudget:()=>({stop(){},elapsedMs:()=>0}),
  require(name){if(name==='https')return {Agent};if(name==='net')return {connect:()=>socket};if(name==='tls')return {connect(_options,connected){tlsCalls++;const tunnel=new Socket();queueMicrotask(()=>connected?.());return tunnel;}};throw new Error('unexpected mock import');}};
 const make=vm.runInNewContext(fragment('buildProxyAuthorizationHeader','function normalizeTlsServername')+fragment('normalizeTlsServername','/**')+fragment('createProxyAgent','/**')+';createProxyAgent',context);
 const username='synthetic-only-user',password=dummy+'@:/';
 const agent=make('http://'+encodeURIComponent(username)+':'+encodeURIComponent(password)+'@proxy.invalid:8080','model.invalid',443);
 const result=new Promise(resolve=>agent.createConnection({},(error,tunnel)=>resolve({error,tunnel})));
 socket.emit('connect');socket.emit('data',Buffer.from(statusLine+'\r\n\r\n'));
 return {result,socket,agent,tlsCalls:()=>tlsCalls,authorization:'Basic '+Buffer.from(username+':'+password).toString('base64')};
}
function requestHarness(raw,statusCode=502){
 const transport={request(_options,onResponse){const request=new EventEmitter();request.write=()=>{};request.destroy=()=>{};request.end=()=>{const response=new EventEmitter();response.statusCode=statusCode;response.headers={};response.destroy=()=>{};onResponse(response);response.emit('data',Buffer.from(raw));response.emit('end');};return request;}};
 const context={URL,Buffer,Number,JSON,Promise,Error,http:transport,https:transport,setTimeout:timer,clearTimeout(){},validateApiEndpointUrl:value=>new URL(value),parseResponseText:(_protocol,response)=>response.output_text||null};
 const run=vm.runInNewContext(fragment('parseSseResponse','function requestJson')+fragment('requestJson','function requiresLlmProxy')+';requestJson',context);
 return ()=>run('https://model.invalid/v1',{},{});
}
async function failure(operation){try{await operation();}catch(error){return error;}throw new Error('expected categorical failure');}
test('CONNECT rejects reflected reason safely, preserves private original and valid proxy auth',async()=>{
 const line='HTTP/1.1 407 '+dummy+' '+Buffer.from(dummy).toString('base64');
 const h=proxyHarness(line);const {error}=await h.result;
 assert.ok(error?.code==='PROXY_CONNECT_REJECTED'&&error.statusCode===407,'numeric proxy failure classification preserved');
 assert.ok(!error.message.includes(dummy)&&!error.message.includes(Buffer.from(dummy).toString('base64')),'public proxy message must not echo inputs');
 assert.ok(error.message.includes('407'),'safe numeric status retained');
 assert.ok(error.proxyStatusLine===line,'private original proxy evidence retained');
 assert.ok(Object.getOwnPropertyDescriptor(error,'proxyStatusLine').enumerable===false,'private evidence is nonenumerable');
 assert.ok(!JSON.stringify(error).includes(dummy),'serialized public error excludes original');
 assert.ok(h.socket.sent.includes('Proxy-Authorization: '+h.authorization+'\r\n'),'legal encoded userinfo still supplies CONNECT auth');
 assert.ok(h.tlsCalls()===0,'rejection never starts target TLS');h.agent.destroy();
});
test('malformed proxy status never contributes unbounded or pseudo-numeric text',async()=>{
 for(const line of ['BROKEN '+dummy,'HTTP/1.1 999 '+dummy,'HTTP/1.1 407'+dummy]){
  const h=proxyHarness(line),{error}=await h.result;
  assert.ok(error?.code==='PROXY_CONNECT_REJECTED'&&!error.message.includes(dummy),'malformed status has fixed safe failure');
  assert.ok(error.statusCode===undefined,'invalid status is not promoted to numeric diagnostic');h.agent.destroy();
 }
});
test('successful CONNECT keeps authenticated tunnel behavior',async()=>{
 const h=proxyHarness('HTTP/1.1 200 Connection established'),result=await h.result;
 assert.ok(!result.error&&!!result.tunnel&&h.tlsCalls()===1,'success still starts exactly one TLS tunnel');
 assert.ok(h.socket.sent.includes('Proxy-Authorization: '+h.authorization+'\r\n'),'success preserves valid proxy authorization');h.agent.destroy();
});
test('nonJSON failure omits body/parser excerpts but preserves complete nonenumerable raw response',async()=>{
 const raw='<html>'+dummy+' '+encodeURIComponent(dummy)+' '+Buffer.from(dummy).toString('base64')+'</html>';
 const error=await failure(requestHarness(raw));
 assert.ok(error.code==='LLM_RESPONSE_PARSE_ERROR'&&error.message.includes('502'),'parse failure code and safe status retained');
 assert.ok(!error.message.includes(dummy)&&!error.message.includes(Buffer.from(dummy).toString('base64')),'diagnostic excludes raw and encoded provider echoes');
 assert.ok(error.llmResponse?.statusCode===502&&error.llmResponse.raw===raw&&error.llmResponse.body===null,'original body/status available to normal recovery and usage logic');
 assert.ok(Object.getOwnPropertyDescriptor(error,'llmResponse').enumerable===false,'original remains nonenumerable');
 assert.ok(!JSON.stringify(error).includes(dummy),'public error serialization excludes private evidence');
});
test('401 plaintext remains a real auth response, not a fabricated parse failure',async()=>{
 const raw='synthetic authorization response '+dummy,response=await requestHarness(raw,401)();
 assert.ok(response.statusCode===401&&response.body===raw&&response.raw===raw,'original 401 classification and raw evidence retained');
});
test('success JSON and completed/incomplete SSE retain response text usage and raw bytes',async()=>{
 for(const status of ['completed','incomplete']){
  const body={status,model:'synthetic-model',output_text:'合成正常回答',usage:{input_tokens:12,output_tokens:7},...(status==='incomplete'?{incomplete_details:{reason:'max_output_tokens'}}:{})};
  const json=JSON.stringify(body),plain=await requestHarness(json,200)();
  assert.ok(JSON.stringify(plain.body)===json&&plain.raw===json,'JSON body usage and source bytes unchanged');
  const raw='event: response.'+status+'\ndata: '+json.replace(/^\{/, '{"type":"response.'+status+'","response":{').replace(/\}$/,'}}')+'\n\n';
  const sse=await requestHarness(raw,200)();
  assert.ok(sse.body.output_text===body.output_text&&sse.body.usage.output_tokens===7&&sse.body.status===status&&sse.raw===raw,'SSE status content usage and original retained');
 }
});
test('missing SSE terminal event retains existing failure and private raw evidence',async()=>{
 const raw='event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"合成部分内容"}\n\n';
 const error=await failure(requestHarness(raw,200));
 assert.ok(error.code==='SSE_TERMINAL_EVENT_MISSING'&&error.llmResponse.raw===raw,'missing terminal event is not converted to success');
});
test('model endpoint still rejects URL credentials without echoing the URL',()=>{
 const validate=vm.runInNewContext(fragment('validateApiEndpointUrl','/**')+';validateApiEndpointUrl',{URL,Error,isLoopbackHostname:()=>false});let rejected=false;
 try{validate('https://synthetic-user:'+dummy+'@model.invalid/v1');}catch(error){rejected=true;assert.ok(!error.message.includes(dummy)&&!error.message.includes('model.invalid'),'model URL guard remains categorical');}
 assert.ok(rejected,'credentialed model endpoint rejected, not confused with legal proxy authentication');
});
