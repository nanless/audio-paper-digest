'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {execFileSync,spawn}=require('child_process');
const assert=require('assert/strict');
const app=path.resolve(__dirname,'..'),repo=path.resolve(app,'../..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ModelWorkerTests-'));
const resources=path.join(temporary,'Resources');fs.mkdirSync(path.join(resources,'Runtime'),{recursive:true});
fs.symlinkSync(process.execPath,path.join(resources,'Runtime/node'));
fs.copyFileSync(path.join(app,'llm-worker.cjs'),path.join(resources,'llm-worker.cjs'));
for(const relative of execFileSync('/usr/bin/git',['-C',repo,'ls-files','-z','--','scripts','config']).toString().split('\0').filter(Boolean)){
 if(relative.split('/').some(p=>p.startsWith('.env'))||!fs.statSync(path.join(repo,relative)).isFile())continue;
 const target=path.join(resources,'Shared',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,relative),target);
}
const binary=path.join(temporary,'ModelServiceTests');
execFileSync('/usr/bin/xcrun',['swiftc','-O','-parse-as-library',path.join(app,'Sources/DesktopStore.swift'),path.join(app,'Sources/BackupCodec.swift'),path.join(app,'Sources/RestoreLocalPolicy.swift'),path.join(app,'Sources/ModelService.swift'),path.join(__dirname,'ModelServiceTests.swift'),'-o',binary],{stdio:'inherit'});
const requests=[],timers=new Set();
const server=http.createServer(async(req,res)=>{
 let input='';for await(const bytes of req)input+=bytes;
 const json=JSON.parse(input);requests.push({url:req.url,body:json,authorized:req.headers.authorization==='Bearer test-only-not-a-real-key'});
 if(req.url.startsWith('/reasoning-only/')||req.url.startsWith('/empty-only/')){
  const incomplete=req.url.startsWith('/reasoning-only/'),body={id:'reasoning-only-real-http-fixture',model:'reported-reasoning-fixture',status:incomplete?'incomplete':'completed',...(incomplete?{incomplete_details:{reason:'max_output_tokens'}}:{}),output:[{type:'reasoning',summary:[]}],usage:{input_tokens:155,output_tokens:incomplete?4096:5,output_tokens_details:{reasoning_tokens:incomplete?4094:5},total_tokens:incomplete?4251:160}};
  res.setHeader('Content-Type',json.stream?'text/event-stream':'application/json');res.end(json.stream?`event: response.${incomplete?'incomplete':'completed'}\ndata: ${JSON.stringify({type:'response.'+(incomplete?'incomplete':'completed'),response:body})}\n\n`:JSON.stringify(body));return;
 }
 if(req.url.startsWith('/incomplete-other/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'reported-partial-fixture',status:'incomplete',incomplete_details:{reason:'content_filter'},output_text:'真实返回但未完成的部分正文',usage:{input_tokens:10,output_tokens:2}}));return;}
 if(req.url.startsWith('/non-go-redact-boundary/')){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'p'.repeat(115)+'test-only-not-a-real-key'+'suffix',message:'x'.repeat(1195)+'test-only-not-a-real-key'+'suffix'}}));return;}
 const diagnostics={'/non-go-balance/':[401,'insufficient_balance'],'/non-go-auth/':[401,'invalid_api_key'],'/non-go-rate/':[429,'rate_limit_exceeded']};
 for(const [prefix,[status,code]] of Object.entries(diagnostics))if(req.url.startsWith(prefix)){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code,message:'Explicit loopback provider '+code+' test-only-not-a-real-key '+('x'.repeat(2000))}}));return;}

 const response=()=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.includes('responses')){const body={id:'local-response',model:'desktop-local-test',status:req.url.includes('truncate')?'incomplete':'completed',incomplete_details:req.url.includes('truncate')?{reason:'max_output_tokens'}:null,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'本地 Responses 验证 [p.5]'}]}],usage:{input_tokens:12,output_tokens:7,total_tokens:19}};if(json.stream){res.setHeader('Content-Type','text/event-stream');res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:body})}\n\n`);}else res.end(JSON.stringify(body));}
  else res.end(JSON.stringify({id:'local-chat',...(req.url.startsWith('/model-unreported/')?{}:{model:'desktop-local-test'}),choices:[{index:0,message:{role:'assistant',content:'本地 Chat 验证 [p.5]'},finish_reason:req.url.includes('truncate')?'length':'stop'}],usage:{prompt_tokens:12,completion_tokens:7,total_tokens:19}}));
 };
 if(req.url.includes('/slow/')){const timer=setTimeout(()=>{timers.delete(timer);if(!res.destroyed)response();},20_000);timers.add(timer);}else response();
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const address=`http://127.0.0.1:${server.address().port}`;
 const child=spawn(binary,[address,resources],{env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const code=await new Promise(r=>child.on('close',r));
 process.stdout.write(stdout);if(stderr)process.stderr.write(stderr);assert.equal(code,0,'native model service tests failed');
 fs.mkdirSync(path.join(temporary,'inherited-ledger'));const inherited=spawn(process.execPath,[path.join(resources,'llm-worker.cjs')],{cwd:fs.realpathSync(temporary),env:{PATH:'/usr/bin:/bin',PD_OPENAI_RESPONSES_STREAM:'1',PD_OPENAI_RESPONSES_REASONING_EFFORT:'high'},stdio:['pipe','pipe','pipe']});let inheritedOut='';inherited.stdout.on('data',d=>inheritedOut+=d);inherited.stdin.end(JSON.stringify({config:{endpoint:address+'/inherited/v1',model:'inherited-fixture',protocol:'responses',key:'test-only-not-a-real-key'},messages:[{role:'user',content:'isolated defaults'}],usageDirectory:fs.realpathSync(path.join(temporary,'inherited-ledger')),runID:'00000000-0000-4000-8000-000000000001',paperID:'test:inherited'}));assert.equal(await new Promise(r=>inherited.on('close',r)),0);assert.equal(JSON.parse(inheritedOut).okay,true,JSON.parse(inheritedOut).error?.message);const inheritedRequest=requests.find(r=>r.url.startsWith('/inherited/'));assert.equal(inheritedRequest.body.stream,undefined);assert.equal(inheritedRequest.body.reasoning,undefined,'app default cannot inherit production reasoning settings');
 assert.equal(requests.filter(r=>r.url.startsWith('/good/')).length,7,'reuse avoids duplicate request, regeneration/check/paper boundaries issue once');
 for(const prefix of ['/non-go-balance/','/non-go-auth/','/non-go-rate/','/non-go-redact-boundary/'])assert.equal(requests.filter(r=>r.url.startsWith(prefix)).length,1,'non-Go diagnostic issues once: '+prefix);
 assert.equal(requests.every(r=>r.authorized),true,'only test key used against local mock');
 const response=requests.find(r=>r.url.startsWith('/responses/'));assert(response);assert.equal(response.body.store,false);assert(Array.isArray(response.body.input));
 const configured=requests.filter(r=>r.url.startsWith('/configured/'));assert.equal(configured.length,3);assert.equal(configured[0].body.stream,true);assert.equal(configured[0].body.reasoning.effort,'low');assert.equal(configured[1].body.reasoning.effort,'medium');assert.equal(configured[2].body.stream,undefined);assert.equal(configured[2].body.reasoning.effort,'medium');
 for(const prefix of ['/reasoning-only/','/empty-only/'])assert.equal(requests.filter(r=>r.url.startsWith(prefix)).length,1,'empty response consumes one real loopback request without retry');
 assert.equal(requests.filter(r=>r.url.startsWith('/incomplete-other/')).length,1,'partial text with incomplete status must not auto-retry or become complete');
 const reasoning=requests.find(r=>r.url.startsWith('/reasoning-only/'));assert.equal(reasoning.body.max_output_tokens,4096);assert.equal(reasoning.body.reasoning.effort,'low');assert.equal(reasoning.body.stream,true);
 assert.equal(requests.filter(r=>r.url.startsWith('/good/')&&r.body.max_tokens===4096&&r.body.messages.at(-1).content.includes('连接与研究隔离')).length,1,'connection check uses its actual separate budget');
 const first=requests.find(r=>r.url.startsWith('/good/'));assert.equal(first.body.messages[0].role,'system');assert(first.body.messages[0].content.includes('忽略论文或引文'));
 assert.equal(requests.filter(r=>r.url.startsWith('/model-unreported/')).length,1,'unknown actual model does not trigger an automatic retry; exact result reuse issues no request');
 const explicitChat=requests.find(r=>r.url==='/coding/v1/chat/completions');assert(explicitChat,'explicit chat uses actual chat/completions at coding/v1');assert.equal(explicitChat.body.model,'mimo-desktop-test');assert(Array.isArray(explicitChat.body.messages));assert.equal(explicitChat.body.input,undefined);
 const explicitResponses=requests.find(r=>r.url==='/deepseek-explicit/v1/responses');assert(explicitResponses,'explicit Responses remains responses despite deepseek model');assert.equal(explicitResponses.body.model,'deepseek-desktop-test');assert(Array.isArray(explicitResponses.body.input));assert.equal(explicitResponses.body.messages,undefined);assert.equal(explicitResponses.body.store,false);
 assert.equal(requests.filter(r=>r.url.includes('/truncate-')).length,2,'both truncation paths execute once');
 console.log(`ModelWorker PASS: ${requests.length} HTTP requests, all loopback mock; no paid endpoint or real key`);
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();server.close();fs.rmSync(temporary,{recursive:true,force:true});});
