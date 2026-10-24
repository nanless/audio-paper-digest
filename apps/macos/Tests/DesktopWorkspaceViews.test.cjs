/* Dedicated production-DOM regression for initially hidden task/note workspaces.
 * Real HTML/CSS/JS, isolated explicit native bridge. This is NOT Mac AX acceptance.
 * Does not read user profiles or invoke GUI/Keychain/model/Zotero/real native jobs. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {installFixture,primary,fixture,repo}=require('./DesktopUI.test.cjs');
const resources=path.join(repo,'apps/macos/Resources'),output=path.join(repo,'apps/macos/.qa/workspace-views');fs.mkdirSync(output,{recursive:true});
const snapshot=new Map(fs.readdirSync(resources).filter(name=>/\.(html|css|js)$/.test(name)).map(name=>[name,fs.readFileSync(path.join(resources,name))]));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const server=http.createServer((request,response)=>{
 let name;try{name=decodeURIComponent(request.url.split('?')[0]);}catch{response.writeHead(400);return response.end();}
 let bytes,relative=name==='/'?'index.html':name.slice(1),file;
 if(relative.startsWith('vendor/')){
  const katex=relative.startsWith('vendor/katex/'),base=katex?path.join(repo,'apps/macos/node_modules/katex/dist'):path.join(repo,'prototypes/macos-research/vendor');
  relative=relative.slice(katex?'vendor/katex/'.length:'vendor/'.length);file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)){response.writeHead(403);return response.end();}
  try{bytes=fs.readFileSync(file);}catch{response.writeHead(404);return response.end();}
 }else bytes=snapshot.get(relative);
 if(!bytes){response.writeHead(404);return response.end();}
 response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'text/html');response.setHeader('Cache-Control','no-store');response.end(bytes);
});
const other=fixture.papers.find(p=>p.id!==primary.id),note='隔离界面夹具：笔记正文保持原样。',stamp='2026-10-24T15:24:00Z';
const initialPersonal={favorites:[],reading:[],sessions:[],readingState:{},annotations:{[primary.id]:[{id:'fixture-mark',page:5,pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c',text:'Explicit isolated selection fixture',comment:'隔离批注',updatedAt:stamp}]},notes:{[primary.id]:{text:note,revision:3,updatedAt:stamp},[other.id]:{text:'第二条隔离笔记',revision:1,updatedAt:'2026-10-24T23:30:00Z'}}};
const jobs=[{id:'fixture-running',paperID:primary.id,title:'隔离任务：运行中',command:'library.article',status:'running',startedAt:stamp,message:'Explicit fixture, no actual network job',progress:{completed:1,total:3}},{id:'fixture-complete',paperID:primary.id,title:'隔离任务：已完成',command:'storage.prepare',status:'complete',startedAt:'2026-10-24T23:30:00Z',message:'Explicit fixture, no actual offline write'},{id:'fixture-failed',paperID:other.id,title:'隔离任务：失败',command:'model.run',status:'failed',startedAt:stamp,message:'Explicit fixture, no actual model request'}];
let browser;const results=[];
async function pageFor({width=1440,zone='Asia/Shanghai',changes={}}={}){
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:zone});const page=await context.newPage();page.setDefaultTimeout(10000);
 await installFixture(page,{nativeStorageWindow:true,initialPersonal,jobs,...changes});
 await page.addInitScript(()=>{
  const original=window.webkit.messageHandlers.desktop.postMessage;
  window.__workspacePending=[];window.__workspacePersonalPending=[];window.__workspaceCancelled=[];
  window.webkit.messageHandlers.desktop.postMessage=async message=>{
   if(message.command==='jobs.cancel'){window.__calls.push(structuredClone(message));window.__workspaceCancelled.push(message.payload.id);return {};}
   if(message.command==='jobs.list'&&window.__workspaceHold){window.__workspaceHold=false;const captured=structuredClone(__fixture.jobs);return await new Promise(resolve=>__workspacePending.push(()=>resolve({jobs:captured})));}
   if(message.command==='personal.snapshot'&&window.__workspaceHoldPersonal){window.__workspaceHoldPersonal=false;const captured=structuredClone(__fixture.personal);return await new Promise(resolve=>__workspacePersonalPending.push(()=>resolve(captured)));}
   return await original(message);
  };
 });
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-library-open]');return {page,context};
}
async function one(name,action,options){const {page,context}=await pageFor(options);try{await action(page);assert.deepEqual(await page.evaluate(()=>__unimplemented),[]);results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.message});console.error('FAIL '+name+': '+error.message);await page.screenshot({path:path.join(output,'failure-'+results.length+'.png')});}finally{await context.close();}}
async function show(page,view){await page.locator('[data-view="'+view+'"]').click();await page.waitForSelector('#'+view+'-view:not([hidden])');await page.waitForFunction(view=>view==='tasks'?document.querySelectorAll('#task-list .task-row').length>0:document.querySelectorAll('#all-notes .task-row').length>0,view);}
async function visibleAX(page){const session=await page.context().newCDPSession(page);try{return (await session.send('Accessibility.getFullAXTree')).nodes.filter(node=>!node.ignored);}finally{await session.detach();}}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 for(const view of ['tasks','notes'])await one(view+' candidate reveal refreshes only hidden outer pane and retains controls',async page=>{
  await page.evaluate(view=>{window.originalWorkspace=document.getElementById(view+'-view');window.originalWorkspaceList=document.getElementById(view==='tasks'?'task-list':'all-notes');window.originalWorkspaceControl=view==='tasks'?document.querySelector('[data-task-filter=active]'):document.querySelector('#notes-view h1');},view);
  await show(page,view);
  assert.equal(await page.evaluate(view=>document.getElementById(view+'-view')!==originalWorkspace,view),true,'candidate must provide a fresh visible container; actual Mac result still requires native acceptance');
  assert.equal(await page.evaluate(view=>document.getElementById(view==='tasks'?'task-list':'all-notes')===originalWorkspaceList,view),true,'preserve original list node and handlers');
  assert.equal(await page.evaluate(view=>view==='tasks'?document.querySelector('[data-task-filter=active]')===originalWorkspaceControl:document.querySelector('#notes-view h1')===originalWorkspaceControl,view),true,'do not deep-clone live controls');
  const shown=await page.evaluate(view=>({visible:!document.getElementById(view+'-view').hidden,duplicates:document.querySelectorAll('#'+view+'-view').length}),view);assert.deepEqual(shown,{visible:true,duplicates:1});
 });
 await one('tasks retained filters and cancel use actual fixture IDs across repeated transitions',async page=>{
  await show(page,'tasks');assert.equal(await page.locator('#task-list .task-row').count(),3);await page.locator('[data-task-filter=active]').click();await page.waitForFunction(()=>document.querySelectorAll('#task-list .task-row').length===1);await page.locator('[data-cancel]').click();assert.deepEqual(await page.evaluate(()=>__workspaceCancelled),['fixture-running']);
  await page.locator('[data-view=library]').first().click();await show(page,'tasks');assert.equal(await page.locator('[data-task-filter=active]').getAttribute('aria-pressed'),'true');await page.locator('[data-task-filter=attention]').click();await page.waitForFunction(()=>document.querySelector('#task-list').textContent.includes('隔离任务：失败'));assert.equal(await page.locator('#task-list .task-row').count(),1);assert.equal(await page.evaluate(()=>__calls.filter(row=>['model.run','zotero.archive','storage.prepare'].includes(row.command)).length),0);
 });
 await one('notes list retains stored text revision annotations and exact opening owner',async page=>{
  const original=await page.evaluate(()=>JSON.stringify(__fixture.personal));await show(page,'notes');assert.equal(await page.locator('#all-notes .task-row').count(),2);assert((await page.locator('#all-notes').innerText()).includes(note));await page.locator('[data-note-open="'+primary.id+'"]').click();await page.waitForSelector('#note-pane:not([hidden])');assert.equal(await page.locator('#note-editor').inputValue(),note);assert.equal(await page.evaluate(()=>__fixture.selected.id),primary.id);assert.equal(await page.evaluate(()=>__fixture.personal.notes[__fixture.primary.id].revision),3);assert.deepEqual(JSON.parse(await page.evaluate(()=>JSON.stringify(__fixture.personal))).notes,JSON.parse(original).notes);
 });
 await one('Chromium exposes both workspace headings while real 4f Mac evidence remains failing',async page=>{
  await show(page,'tasks');let ax=await visibleAX(page);assert(ax.some(n=>n.role?.value==='heading'&&n.name?.value==='后台任务'));assert(!ax.some(n=>n.role?.value==='heading'&&n.name?.value==='我的笔记'));await show(page,'notes');ax=await visibleAX(page);assert(ax.some(n=>n.role?.value==='heading'&&n.name?.value==='我的笔记'));assert(!ax.some(n=>n.role?.value==='heading'&&n.name?.value==='后台任务'));
 });
 await one('notes toolbar identifies the current workspace',async page=>{await show(page,'notes');assert.equal((await page.locator('#toolbar-context').textContent()).trim(),'我的笔记');});
 for(const zone of ['Asia/Shanghai','America/New_York'])for(const view of ['tasks','notes'])await one(view+' timestamps display local dates in '+zone,async page=>{
  await show(page,view);const actual=await page.locator(view==='tasks'?'#task-list':'#all-notes').innerText();
  for(const iso of [stamp,'2026-10-24T23:30:00Z']){
   const expected=await page.evaluate(iso=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso)).map(x=>[x.type,x.value]));return [parts.year,parts.month,parts.day,parts.hour,parts.minute];},iso);
   assert.match(actual,new RegExp(expected[0]+'[/-]'+expected[1]+'[/-]'+expected[2]+'.*'+expected[3]+':'+expected[4]),'actual UI must apply local date and daylight-saving offset, including next-day rollover');assert(!actual.includes(iso),'do not display raw UTC ISO');
  }
 },{zone});
 for(const view of ['tasks','notes'])await one(view+' malformed timestamp is explicitly unknown',async page=>{
  await page.evaluate(view=>{if(view==='tasks')__fixture.jobs=[{id:'bad-time',command:'library.article',status:'complete',title:'隔离时间负例',startedAt:'invalid-raw-time'}];else __fixture.personal.notes[__fixture.primary.id].updatedAt='invalid-raw-time';},view);await show(page,view);const text=await page.locator(view==='tasks'?'#task-list':'#all-notes').innerText();assert(text.includes('时间未知'));assert(!text.includes('invalid-raw-time'));
 });
 for(const width of [1440,1080])for(const view of ['tasks','notes'])await one(view+' list aligns with heading gutter at '+width,async page=>{
  await show(page,view);const geometry=await page.evaluate(view=>{const pane=document.getElementById(view+'-view'),heading=pane.querySelector('.page-heading'),style=getComputedStyle(heading),list=document.getElementById(view==='tasks'?'task-list':'all-notes'),first=list.querySelector('.task-row');return {heading:heading.getBoundingClientRect().x+parseFloat(style.paddingLeft),row:first.getBoundingClientRect().x,list:list.getBoundingClientRect().x,filter:pane.querySelector('.task-tabs')?.getBoundingClientRect().x,disclaimer:pane.querySelector('.task-disclaimer')?.getBoundingClientRect().x,overflow:document.documentElement.scrollWidth>innerWidth};},view);
  if(view==='tasks'){assert(Math.abs(geometry.heading-geometry.filter)<1);assert(Math.abs(geometry.heading-geometry.disclaimer)<1);}
  assert(Math.abs(geometry.heading-geometry.row)<1,'heading and first card should share the same responsive 40/30px gutter');assert.equal(geometry.overflow,false);await page.screenshot({path:path.join(output,view+'-'+width+'.png')});
 },{width});
 await one('late older jobs reply cannot replace current task terminal state',async page=>{
  await page.evaluate(()=>window.__workspaceHold=true);await page.locator('[data-view=tasks]').click();await page.waitForFunction(()=>__workspacePending.length===1);await page.locator('[data-view=library]').first().click();await page.evaluate(()=>__fixture.jobs=[{id:'latest',command:'library.article',status:'complete',title:'最新已完成任务',startedAt:'2026-10-24T15:24:00Z'}]);await show(page,'tasks');await page.waitForFunction(()=>document.querySelector('#task-list').textContent.includes('最新已完成任务'));await page.evaluate(()=>__workspacePending.shift()());await page.waitForTimeout(80);assert((await page.locator('#task-list').innerText()).includes('最新已完成任务'),'old running snapshot must not erase newer actual terminal state');
 });
 await one('late hidden workspace completion cannot steal current note focus',async page=>{
  await page.evaluate(()=>window.__workspaceHold=true);await page.locator('[data-view=tasks]').click();await page.waitForFunction(()=>__workspacePending.length===1);await show(page,'notes');await page.locator('[data-note-open="'+primary.id+'"]').click();await page.waitForSelector('#note-editor');await page.locator('#note-editor').focus();await page.evaluate(()=>__workspacePending.shift()());await page.waitForTimeout(80);assert.equal(await page.locator('#note-editor').evaluate(el=>document.activeElement===el),true);assert.equal(await page.locator('#tasks-view').evaluate(el=>el.hidden),true);
 });
 await one('late older personal snapshot cannot replace newly opened notes state',async page=>{
  await page.evaluate(()=>window.__workspaceHoldPersonal=true);await page.locator('[data-view=notes]').click();await page.waitForFunction(()=>__workspacePersonalPending.length===1);await show(page,'tasks');await page.evaluate(()=>{__fixture.personal.notes[__fixture.primary.id]={text:'最新笔记可见，旧快照不可覆盖',revision:4,updatedAt:'2026-10-24T23:40:00Z'};});await show(page,'notes');await page.waitForFunction(()=>document.querySelector('#all-notes').textContent.includes('最新笔记可见'));await page.evaluate(()=>__workspacePersonalPending.shift()());await page.waitForTimeout(80);assert((await page.locator('#all-notes').innerText()).includes('最新笔记可见'));await page.locator('[data-note-open="'+primary.id+'"]').click();await page.waitForSelector('#note-pane:not([hidden])');assert.equal(await page.locator('#note-editor').inputValue(),'最新笔记可见，旧快照不可覆盖');
 });
}finally{
 if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));const failed=results.filter(r=>!r.passed).length;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({contract:'workspace-view-production-dom-v1',scope:'frozen production DOM plus explicit headless/native fixtures; not real Mac AX acceptance',macAXValidated:false,knownRealMacFailures:['tasks-offline-complete-4f994c87.ax.txt','notes-4f994c87.ax.txt'],sourceSHA256:Object.fromEntries([...snapshot].map(([name,bytes])=>[name,hash(bytes)])),results,passed:results.length-failed,failed},null,2)+'\n');console.log('Workspace views: '+(results.length-failed)+' passed; '+failed+' failed; real Mac AX pending');if(failed)process.exitCode=1;
}})().catch(error=>{console.error(error);process.exitCode=1;});
