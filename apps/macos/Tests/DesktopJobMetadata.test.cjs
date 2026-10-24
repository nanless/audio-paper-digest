/* Production DOM with explicit isolated records. No Mac UI, user profile,
 * credentials, model request, Zotero write or persisted-record migration. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {installFixture,primary,repo}=require('./DesktopUI.test.cjs');
const resources=path.join(repo,'apps/macos/Resources'),output=path.join(repo,'apps/macos/.qa/job-metadata');fs.mkdirSync(output,{recursive:true});
const snapshot=new Map(fs.readdirSync(resources).filter(name=>/\.(html|css|js)$/.test(name)).map(name=>[name,fs.readFileSync(path.join(resources,name))]));
const server=http.createServer((request,response)=>{
 let name;try{name=decodeURIComponent(request.url.split('?')[0]);}catch{response.writeHead(400);return response.end();}
 let bytes,relative=name==='/'?'index.html':name.slice(1);
 if(relative.startsWith('vendor/')){
  const katex=relative.startsWith('vendor/katex/'),base=katex?path.join(repo,'apps/macos/node_modules/katex/dist'):path.join(repo,'prototypes/macos-research/vendor');
  relative=relative.slice(katex?'vendor/katex/'.length:'vendor/'.length);const file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)){response.writeHead(403);return response.end();}
  try{bytes=fs.readFileSync(file);}catch{response.writeHead(404);return response.end();}
 }else bytes=snapshot.get(relative);
 if(!bytes){response.writeHead(404);return response.end();}
 response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'text/html');response.end(bytes);
});
const owner=primary.id,stamp='2026-10-24T17:00:00Z',job={id:'exact-job',paperID:owner,title:'隔离原研究任务',command:'model.run',status:'complete',startedAt:stamp,message:'既有原记录'};
const session={id:job.id,paperID:owner,kind:'study',status:'complete',source:{kind:'pdf-selection',pages:[5],sourceVersion:'recorded-v1',pdfSHA:'a'.repeat(64)},usage:{input_tokens:397,output_tokens:1048,total_tokens:1445}};
let browser,page,context;const results=[];
async function one(name,action){try{await action();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});console.error('FAIL '+name+': '+error.message);await page.screenshot({path:path.join(output,'failure-'+results.length+'.png')});}}
async function show(jobs=[job],sessions=[session]){
 await page.evaluate(({jobs,sessions})=>{__fixture.jobs=jobs;__fixture.personal.sessions=sessions;window.__metadataReadFailure=false;}, {jobs,sessions});
 await page.locator('[data-task-filter=all]').click();
 await page.waitForFunction(()=>__metadataPending===0);return page.locator('#task-list').innerText();
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 context=await browser.newContext({viewport:{width:1080,height:700}});page=await context.newPage();page.setDefaultTimeout(10000);
 await installFixture(page,{nativeStorageWindow:true,jobs:[job],initialPersonal:{favorites:[],reading:[],sessions:[session],readingState:{},annotations:{},notes:{}}});
 await page.addInitScript(()=>{const original=webkit.messageHandlers.desktop.postMessage;window.__metadataPending=0;window.__metadataHeld=[];window.__metadataReadFailure=false;window.__metadataHold=false;webkit.messageHandlers.desktop.postMessage=async m=>{if(['jobs.list','personal.snapshot'].includes(m.command)){__metadataPending++;try{if(m.command==='personal.snapshot'&&__metadataReadFailure)throw Error('Explicit isolated snapshot read failure');if(m.command==='personal.snapshot'&&__metadataHold){__metadataHold=false;const captured=structuredClone(__fixture.personal);return await new Promise(resolve=>__metadataHeld.push(()=>resolve(captured)));}return await original(m);}finally{__metadataPending--;}}return original(m);};});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-library-open]');await page.locator('[data-view=tasks]').click();await page.waitForFunction(()=>document.querySelectorAll('#task-list .task-row').length===1);
 await one('exact original job/session ownership exposes original physical evidence and measured tokens',async()=>{const text=await show();assert.match(text,/对象身份：arxiv:/);assert.match(text,/材料依据：选区 · 物理页 5 · 版本 recorded-v1/);assert(text.includes('PDF SHA-256 '+'a'.repeat(64)));assert.match(text,/输入397 · 输出1048 · 合计1445 tokens · 实际费用金额未知/);});
 await one('catalog current version cannot replace absent historical version',async()=>{const text=await show([job],[{...session,source:{kind:'published-reader',revision:'original-revision'}}]);assert.match(text,/网站导读 · 导读修订 original-revision/);assert.doesNotMatch(text,/recorded-v1|PDF SHA-256/);});
 await one('matching id with different paper is rejected',async()=>{const text=await show([job],[{...session,paperID:'arxiv:different'}]);assert.match(text,/没有唯一匹配的原研究记录/);assert.doesNotMatch(text,/输入397|recorded-v1/);});
 await one('ambiguous duplicate id cannot grant a provenance or usage claim',async()=>{const text=await show([job],[session,{...session,usage:{total_tokens:999}}]);assert.match(text,/没有唯一匹配/);assert.doesNotMatch(text,/1445|999/);});
 await one('wrong session purpose is rejected',async()=>{const text=await show([job],[{...session,kind:'connection-check'}]);assert.match(text,/没有唯一匹配/);assert.doesNotMatch(text,/输入397/);});
 await one('reused job has no invented link to old session or duplicated token total',async()=>{const text=await show([{...job,id:'reuse-job',result:{reused:true}}],[session]);assert.match(text,/已复用既有结果，本任务未新增模型请求/);assert.match(text,/原用量未在本任务绑定/);assert.doesNotMatch(text,/1445|recorded-v1/);});
 for(const status of ['failed','cancelled','interrupted'])await one(status+' without a saved session stays unknown rather than zero cost',async()=>{const text=await show([{...job,status}],[]);assert.match(text,/用量与实际金额未知，不视作零费用/);assert.doesNotMatch(text,/输入0|合计0|无需本地模型请求/);});
 await one('measured zero remains measured zero while malformed usage is unknown',async()=>{const text=await show([job],[{...session,usage:{input_tokens:0,output_tokens:-1,total_tokens:1.5}}]);assert.match(text,/输入0 · 输出未知 · 合计未知 tokens/);});
 await one('recorded missing-version truncation and textless pages are explicit',async()=>{const text=await show([job],[{...session,source:{kind:'pdf-range',pages:[2,3],truncated:true,missingTextPages:[3]}}]);assert.match(text,/原版本未记录/);assert.match(text,/输入已截断/);assert.match(text,/无文字页 3 未分析图像/);});
 await one('connection check binds only its own session and still shows real unknown amount',async()=>{const text=await show([{...job,command:'model.check'}],[{...session,kind:'connection-check',source:{kind:'connection-check'}}]);assert.match(text,/材料依据：连接测试/);assert.match(text,/合计1445 tokens · 实际费用金额未知/);});
 await one('connection check may legitimately bind matching empty paper ownership from library',async()=>{const text=await show([{...job,command:'model.check',paperID:''}],[{...session,paperID:'',kind:'connection-check',source:{kind:'connection-check'}}]);assert.match(text,/对象身份：未记录/);assert.match(text,/材料依据：连接测试/);assert.match(text,/合计1445 tokens/);});
 await one('study never binds empty ownership or missing job identity',async()=>{let text=await show([{...job,paperID:''}],[{...session,paperID:''}]);assert.match(text,/没有唯一匹配/);assert.doesNotMatch(text,/1445/);text=await show([{...job,id:''}],[{...session,id:''}]);assert.match(text,/没有唯一匹配/);assert.doesNotMatch(text,/1445/);});
 await one('non-model task uses recorded identity without assuming a local model request',async()=>{const text=await show([{...job,command:'zotero.resume',identity:'conference:original-forum',paperID:''}],[]);assert.match(text,/对象身份：conference:original-forum/);assert.match(text,/本任务未单独记录版本或范围/);assert.match(text,/本任务无需本地模型请求/);assert.doesNotMatch(text,/1445/);});
 await one('missing identity and session are visibly unrecorded, not current paper guessed',async()=>{const text=await show([{...job,paperID:''}],[]);assert.match(text,/对象身份：未记录/);assert.doesNotMatch(text,/对象身份：arxiv:/);});
 await one('snapshot read failure preserves jobs with an honest metadata warning',async()=>{await show();await page.evaluate(()=>__metadataReadFailure=true);await page.locator('[data-task-filter=all]').click();await page.waitForFunction(()=>__metadataPending===0);const text=await page.locator('#task-list').innerText();assert.match(text,/研究记录读取失败/);assert.match(text,/隔离原研究任务/);assert.doesNotMatch(text,/1445/);});
 await one('untrusted recorded fields are escaped and long hashes do not overflow',async()=>{const text=await show([{...job,identity:'<img src=x onerror=alert(1)>'}],[{...session,source:{kind:'pdf-page',pdfSHA:'b'.repeat(300)}}]);assert(text.includes('<img src=x onerror=alert(1)>'));assert.equal(await page.locator('#task-list img').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);});
 await one('late older personal response cannot replace latest task evidence',async()=>{
  await show();await page.evaluate(()=>__metadataHold=true);await page.locator('[data-task-filter=all]').click();await page.waitForFunction(()=>__metadataHeld.length===1);
  await page.evaluate(()=>{__fixture.jobs=[{id:'latest-job',paperID:'arxiv:latest',title:'最新任务',command:'model.run',status:'failed'}];__fixture.personal.sessions=[];});await page.locator('[data-task-filter=all]').click();await page.waitForFunction(()=>document.querySelector('#task-list').textContent.includes('最新任务'));await page.evaluate(()=>__metadataHeld.shift()());await page.waitForFunction(()=>__metadataPending===0);const text=await page.locator('#task-list').innerText();assert.match(text,/最新任务/);assert.doesNotMatch(text,/1445|recorded-v1/);
 });
 await one('rendering only reads native records and never rewrites sessions or starts model jobs',async()=>{const before=await page.evaluate(()=>JSON.stringify(__fixture.personal));await show([job],[]);const stable=await page.evaluate(()=>JSON.stringify(__fixture.personal));await page.locator('[data-task-filter=all]').click();await page.waitForFunction(()=>__metadataPending===0);assert.equal(await page.evaluate(()=>JSON.stringify(__fixture.personal)),stable);assert.equal(await page.evaluate(()=>__calls.filter(c=>/^(model\.|zotero\.|personal\.set)/.test(c.command)).length),0);assert.deepEqual(await page.evaluate(()=>__unimplemented),[]);assert(before);});
}finally{
 if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));const failed=results.filter(r=>!r.passed).length;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'isolated production DOM; no real Mac AX/model/user data',sourceSHA256:Object.fromEntries([...snapshot].map(([name,bytes])=>[name,crypto.createHash('sha256').update(bytes).digest('hex')])),passed:results.length-failed,failed,results},null,2)+'\n');console.log('Job metadata: '+(results.length-failed)+' passed; '+failed+' failed');if(failed)process.exitCode=1;
}})().catch(error=>{console.error(error);process.exitCode=1;});
