'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const usage = require('../scripts/lib/llm-usage');
const pending = require('../scripts/lib/llm-pending-request');
const utils = require('../scripts/utils');
const input = { messages: [{ role:'user', content:'SECRET_PROMPT' }], model:'test' };
const context = { paperId:'2610.06949v1', stage:'apiReaderRepair', contentAttempt:1, transportAttempt:1 };
const endpoint = 'https://example.invalid/v1';
function temp(t) { const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pending-request-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
function records(dir) { return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n)))); }
function request(dir, transport, extra={}) { return utils.requestLlmJson(endpoint+'/chat/completions',endpoint,'test',input,{Authorization:'Bearer SECRET_KEY'},{usageDirectory:dir,usageContext:context,transportRequestFn:transport,...extra}); }
test('公共入口在真实传输调用前先持久保存，不泄漏正文与凭据', async t=>{
 const dir=temp(t);await request(dir,async()=>{const rows=records(dir);assert.equal(rows.length,1);assert.equal(rows[0].kind,'request_started');assert.equal(rows[0].chargeState,'unknown');assert.ok(!JSON.stringify(rows).includes('SECRET'));return {statusCode:200,body:{choices:[{message:{content:'ok'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}};});
 const rows=records(dir);assert.equal(rows.length,2);assert.equal(rows[0].eventId,rows[1].eventId);assert.equal(usage.summarizeLlmUsage(rows).groups[0].requests,1);assert.equal(usage.summarizeLlmUsage(rows).pendingUnknownRequests.length,0);
});
test('子进程传输入口硬终止后留下结果与费用未知的原始记录',t=>{
 const dir=temp(t),modulePath=path.resolve(__dirname,'../scripts/utils');
 const code=`process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';require(${JSON.stringify(modulePath)}).requestLlmJson(${JSON.stringify(endpoint+'/chat/completions')},${JSON.stringify(endpoint)},'test',{messages:[]},{},{usageDirectory:${JSON.stringify(dir)},usageContext:${JSON.stringify(context)},transportRequestFn:()=>{process.kill(process.pid,'SIGKILL');}})`;
 const child=spawnSync(process.execPath,['-e',code],{encoding:'utf8'});assert.equal(child.signal,'SIGKILL');const rows=records(dir);assert.equal(rows.length,1);const report=usage.summarizeLlmUsage(rows);assert.equal(report.pendingUnknownRequests.length,1);assert.equal(report.pendingUnknownRequests[0].chargeState,'unknown');assert.equal(report.groups.length,0);
});
test('网络错误有同ID终态，未知记录不虚增内容次数',async t=>{
 const dir=temp(t);await assert.rejects(request(dir,async()=>{throw Object.assign(new Error('reset'),{code:'ECONNRESET'});}),/reset/);const rows=records(dir),report=usage.summarizeLlmUsage(rows);assert.equal(rows.length,2);assert.equal(rows[0].eventId,rows[1].eventId);assert.equal(report.pendingUnknownRequests.length,0);assert.equal(report.groups[0].transportErrors,1);assert.ok(rows.every(r=>r.contentAttempt===1));
});
test('同内容尝试的两次物理传输各有独立ID，不伪造两个内容尝试',async t=>{
 const dir=temp(t);for(let i=0;i<2;i++)await request(dir,async()=>({statusCode:200,body:{choices:[{message:{content:'ok'}}]}}));const rows=records(dir),starts=rows.filter(r=>r.kind==='request_started');assert.equal(new Set(starts.map(r=>r.eventId)).size,2);assert.ok(rows.every(r=>r.contentAttempt===1));assert.equal(usage.summarizeLlmUsage(rows).groups[0].requests,2);
});
test('模型路由拒绝前不产生发送记录或调用传输',async t=>{
 const dir=temp(t);let calls=0;await assert.rejects(utils.requestLlmJson('https://wrong.invalid/v1/chat/completions',endpoint,'test',input,{}, {usageDirectory:dir,transportRequestFn:()=>calls++}));assert.equal(calls,0);assert.equal(records(dir).length,0);
});
test('持久记录失败必须在网络前非重试停止',async t=>{
 const dir=temp(t);const broken=path.join(dir,'file');fs.writeFileSync(broken,'x');let calls=0;await assert.rejects(request(broken,()=>calls++),e=>e.code==='LLM_REQUEST_START_NOT_PERSISTED'&&e.modelRequestClassified&&e.retryable===false&&e.category==='config'&&e.scope==='run');assert.equal(calls,0);
});
test('旧终态汇总不变；不相关终态不隐藏未知记录且报告只保白名单',()=>{
 const old=usage.buildLlmUsageEvent({protocol:'openai',model:'test',request:input,statusCode:200,context});const before=usage.summarizeLlmUsage([old]);assert.equal(before.groups[0].requests,1);assert.equal(before.pendingUnknownRequests.length,0);
 const start=pending.beginPendingLlmRequest({protocol:'openai',model:'test',request:input,context},{enabled:false}).event;const forged={...start,kind:'request',inputSha256:'0'.repeat(64)};const rows=pending.orphanedPendingLlmRequests([{...start,headers:{Authorization:'SECRET_KEY'},prompt:'SECRET_PROMPT'},forged]);assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('SECRET'));assert.equal(rows[0].inputSha256,start.inputSha256);
});
test('公开报告接受新事件，跨日期终态配对不误报结果未知',t=>{
 const dir=temp(t);const start=pending.beginPendingLlmRequest({protocol:'openai',model:'test',request:input,context},{enabled:false}).event;
 const a={...start,at:'2026-10-11T15:59:59.000Z'},b=usage.buildLlmUsageEvent({protocol:'openai',model:'test',request:input,context,eventId:start.eventId,at:'2026-10-11T16:00:01.000Z',statusCode:200});
 usage.writeLlmUsageEvent(a,{directory:dir});usage.writeLlmUsageEvent(b,{directory:dir});const main=require('../scripts/llm-usage-report').main,log=console.log;console.log=()=>{};
 try{const report=main(['--dir',dir,'--date','2026-10-11']);assert.equal(report.pendingUnknownRequestCount,0);assert.equal(report.groups.length,0);}finally{console.log=log;}
});
test('实际会议usageSink只收到一条终态，起始与终态在同目录正确配对',async t=>{
 const dir=temp(t),Config=require('../scripts/config'),old=Config.FILES.llmUsageDir;Config.FILES.llmUsageDir=dir;
 const source=fs.readFileSync(path.resolve(__dirname,'../scripts/lib/conference-filter.js'),'utf8'),marker='usageSink: event => {';
 const begin=source.indexOf(marker),bodyStart=begin+marker.length;assert.ok(begin>=0);let level=1,end=bodyStart;while(level&&end<source.length){if(source[end]==='{')level++;if(source[end]==='}')level--;end++;}
 const usageEvents=[],sink=new Function('require','usageEvents','return event => {'+source.slice(bodyStart,end-1)+'};')(name=>{assert.equal(name,'./llm-usage.js');return {...usage,writeLlmUsageEvent:event=>usage.writeLlmUsageEvent(event,{directory:dir})};},usageEvents);
 try{await request(dir,async()=>({statusCode:200,body:{choices:[{message:{content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}}}),{usageSink:sink});const rows=records(dir);assert.equal(rows.length,2);assert.equal(usageEvents.length,1);assert.equal(usageEvents[0].event.kind,'request');assert.equal(usageEvents[0].persisted,true);assert.equal(usage.summarizeLlmUsage(rows).pendingUnknownRequestCount,0);assert.equal(rows[0].eventId,rows[1].eventId);}finally{Config.FILES.llmUsageDir=old;}
});
test('会议真实实现哈希仍包含utils，不伪装旧实现身份',()=>{
 const api=require('../scripts/lib/conference-process');assert.ok(api.currentImplementationFiles().includes('scripts/utils.js'));const read=filename=>filename.endsWith(path.sep+'utils.js')?'old request logging':fs.readFileSync(filename);const before=api.implementationSha256({readFileSync:read});const after=api.implementationSha256({readFileSync:filename=>filename.endsWith(path.sep+'utils.js')?'new request logging':fs.readFileSync(filename)});assert.notEqual(before,after);
});
