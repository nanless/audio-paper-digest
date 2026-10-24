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
  window.__workspacePending=[];window.__workspacePersonalPending=[];window.__workspaceCancelled=[];window.__workspaceSettingsWrites=[];
  window.webkit.messageHandlers.desktop.postMessage=async message=>{
   if(message.command==='settings.save'&&window.__workspaceHoldSettingsSave){window.__workspaceHoldSettingsSave=false;return await new Promise(resolve=>__workspaceSettingsWrites.push(async()=>resolve(await original(message))));}
   if(message.command==='settings.open'){window.__calls.push(structuredClone(message));return {presented:true};}
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
 await one('cancelled export remains cancelled in task labels and existing all/attention filters, never active',async page=>{
  await page.evaluate(()=>__fixture.jobs=[{id:'cancelled-export',paperID:__fixture.primary.id,title:'取消导出隔离夹具',command:'app.export',status:'cancelled',startedAt:'2026-10-24T15:24:00Z',endedAt:'2026-10-24T15:25:00Z',message:'已取消导出'}]);
  await show(page,'tasks');let text=await page.locator('#task-list').innerText();assert.match(text,/导出研究 · 已取消/);assert.doesNotMatch(text,/已完成|导出研究 · 失败/);assert.equal(await page.locator('#task-list [data-cancel]').count(),0);
  await page.locator('[data-task-filter=active]').click();await page.waitForFunction(()=>document.querySelectorAll('#task-list .task-row').length===0);
  await page.locator('[data-task-filter=attention]').click();await page.waitForFunction(()=>document.querySelectorAll('#task-list .task-row').length===1);assert.match(await page.locator('#task-list').innerText(),/导出研究 · 已取消/);
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

 // These are explicit pagination fixtures, never actual user task/usage records.
 const history=n=>Array.from({length:n},(_,i)=>({id:'pagination-job-'+String(i).padStart(4,'0'),paperID:primary.id,title:'分页隔离夹具 '+String(i).padStart(4,'0'),command:'library.article',status:i%3===0?'running':i%3===1?'failed':'complete',startedAt:stamp,message:'Explicit pagination fixture; no native task executed'}));
 async function showTasks(page){await page.locator('[data-view=tasks]').click();await page.waitForSelector('#tasks-view:not([hidden])');await page.waitForFunction(()=>document.querySelector('#task-page-summary').textContent.includes('条任务'));}
 async function pageTitles(page){return page.locator('#task-list .task-row strong').allTextContents();}
 async function expectPage(page,n,index){const count=Math.max(1,Math.ceil(n/20)),start=index*20,end=Math.min(start+20,n),summary=n?`${n} 条任务 · ${start+1}–${end} · 第 ${index+1} / ${count} 页`:'0 条任务';await page.waitForFunction(summary=>document.querySelector('#task-page-summary').textContent===summary,summary);assert.equal(await page.locator('#task-list .task-row').count(),end-start);assert.equal(await page.locator('#task-prev').isDisabled(),index===0);assert.equal(await page.locator('#task-next').isDisabled(),index+1>=count);}
 for(const n of [0,1,20,21,148,1000])await one('bounded task pages retain all '+n+' original fixture records with no gaps or writes',async page=>{
  const expected=history(n);await page.evaluate(jobs=>__fixture.jobs=jobs,expected);const before=await page.evaluate(()=>JSON.stringify(__fixture.jobs));await showTasks(page);const seen=[];
  for(let index=0;index<Math.max(1,Math.ceil(n/20));index++){await expectPage(page,n,index);seen.push(...await pageTitles(page));assert.ok(await page.locator('#task-list .task-row').count()<=20);if(index+1<Math.ceil(n/20))await page.locator('#task-next').click();}
  assert.deepEqual(seen,expected.map(j=>j.title));assert.equal(new Set(seen).size,n);assert.equal(await page.evaluate(()=>JSON.stringify(__fixture.jobs)),before);
  if(n>20){await page.locator('#task-prev').click();await expectPage(page,n,Math.ceil(n/20)-2);}
  assert.equal(await page.evaluate(()=>__calls.filter(c=>['model.run','zotero.archive','zotero.resume','jobs.cancel','storage.prepare'].includes(c.command)).length),0);
 });
 await one('task filters reset to first matching page while retaining every filtered record',async page=>{
  await page.evaluate(jobs=>__fixture.jobs=jobs,history(61));await showTasks(page);await page.locator('#task-next').click();await expectPage(page,61,1);await page.locator('#task-next').click();await expectPage(page,61,2);
  await page.locator('[data-task-filter=attention]').click();await expectPage(page,20,0);assert.deepEqual(await pageTitles(page),history(61).filter(j=>j.status==='failed').map(j=>j.title));
  await page.locator('[data-task-filter=active]').click();await expectPage(page,21,0);await page.locator('#task-next').click();await expectPage(page,21,1);
  await page.locator('[data-task-filter=all]').click();await expectPage(page,61,0);
 });
 await one('jobs hot updates preserve current page and clamp only when history shrinks',async page=>{
  await page.evaluate(jobs=>__fixture.jobs=jobs,history(81));await showTasks(page);for(let i=0;i<2;i++){await page.locator('#task-next').click();await expectPage(page,81,i+1);}
  await page.evaluate(jobs=>{__fixture.jobs=jobs;dispatchEvent(new Event('jobs.changed'));},history(87));await expectPage(page,87,2);assert.deepEqual(await pageTitles(page),history(87).slice(40,60).map(j=>j.title));
  await page.evaluate(jobs=>{__fixture.jobs=jobs;dispatchEvent(new Event('jobs.changed'));},history(21));await expectPage(page,21,1);assert.deepEqual(await pageTitles(page),[history(21)[20].title]);
  await page.evaluate(()=>{__fixture.jobs=[];dispatchEvent(new Event('jobs.changed'));});await expectPage(page,0,0);assert.match(await page.locator('#task-list').innerText(),/没有此类任务/);
 });
 await one('held older page response cannot overwrite newer filtered history or page state',async page=>{
  await page.evaluate(jobs=>__fixture.jobs=jobs,history(61));await showTasks(page);await page.evaluate(()=>__workspaceHold=true);await page.locator('#task-next').click();await page.waitForFunction(()=>__workspacePending.length===1);
  const latest=history(5).map((j,i)=>({...j,status:'failed',title:'最新分页终态 '+i}));await page.evaluate(jobs=>__fixture.jobs=jobs,latest);await page.locator('[data-task-filter=attention]').click();await expectPage(page,5,0);await page.evaluate(()=>__workspacePending.shift()());await page.waitForTimeout(70);await expectPage(page,5,0);assert.deepEqual(await pageTitles(page),latest.map(j=>j.title));
 });
 await one('current page cancel and open controls call only their exact IDs once',async page=>{
  const jobs=history(45).map((j,i)=>({...j,status:i===20?'running':'complete',paperID:i===21?other.id:primary.id}));await page.evaluate(jobs=>__fixture.jobs=jobs,jobs);await showTasks(page);await page.locator('#task-next').click();await expectPage(page,45,1);
  await page.locator('[data-cancel="pagination-job-0020"]').click();assert.deepEqual(await page.evaluate(()=>__workspaceCancelled),['pagination-job-0020']);
  const before=await page.evaluate(()=>__calls.filter(c=>c.command==='app.setPaper').length);await page.locator('#task-list .task-row').nth(1).locator('[data-job-paper]').click();await page.waitForFunction(id=>__fixture.selected?.id===id,other.id);assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='app.setPaper').length),before+1);assert.equal(await page.evaluate(()=>__calls.filter(c=>['model.run','zotero.archive','zotero.resume'].includes(c.command)).length),0);
 });
 await one('1080 task pagination shares 30px gutter and its buttons do not overflow',async page=>{
  await page.evaluate(jobs=>__fixture.jobs=jobs,history(21));await showTasks(page);const g=await page.evaluate(()=>{const h=document.querySelector('#tasks-view .page-heading'),n=document.querySelector('.task-pagination'),b=n.getBoundingClientRect();return {heading:h.getBoundingClientRect().left+parseFloat(getComputedStyle(h).paddingLeft),left:b.left,right:b.right,width:innerWidth,buttons:[...n.querySelectorAll('button')].map(b=>({left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right})),overflow:document.documentElement.scrollWidth>innerWidth};});assert.ok(Math.abs(g.heading-g.left)<1,JSON.stringify(g));assert.equal(g.overflow,false);assert.ok(g.right<=g.width&&g.buttons.every(b=>b.left>=g.left&&b.right<=g.right),JSON.stringify(g));
 },{width:1080});

 await one('terminal cloud task opens only the exact cloud settings pane while running retains cancel',async page=>{
  const terminal=['complete','partial','failed','cancelled','interrupted'];await page.evaluate(statuses=>__fixture.jobs=[...statuses.map(status=>({id:'cloud-'+status,title:'隔离云任务 '+status,command:'cloud.upload',status,paperID:''})),{id:'cloud-running',title:'隔离运行云任务',command:'cloud.upload',status:'running',paperID:''}],terminal);await show(page,'tasks');
  assert.equal(await page.locator('[data-job-cloud]').count(),terminal.length);assert.equal(await page.locator('[data-cancel="cloud-running"]').count(),1);
  for(const status of terminal){await page.locator('#task-list .task-row').filter({hasText:'隔离云任务 '+status}).getByRole('button',{name:'查看坚果云资料',exact:true}).click();}
  assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.command==='settings.open')),terminal.map(()=>({command:'settings.open',payload:{pane:'cloud'}})));await page.locator('[data-cancel="cloud-running"]').click();assert.deepEqual(await page.evaluate(()=>__workspaceCancelled),['cloud-running']);assert.equal(await page.evaluate(()=>__calls.filter(c=>/^(cloud\.|model\.)/.test(c.command)).length),0);
 });
 await one('settings exact native pane deep link preserves model draft input and subsequent save',async page=>{
  await page.goto('http://127.0.0.1:'+server.address().port+'/settings.html');await page.waitForFunction(()=>document.querySelector('#key-status').textContent.length>0&&document.querySelector('#cloud-account'));
  assert.equal(await page.evaluate(()=>typeof window.paperDigestShowSettingsPane),'function');
  const result=await page.evaluate(()=>{window.originalModelInput=document.querySelector('#model');const input=originalModelInput;input.value='isolated-unsaved-model';input.dispatchEvent(new Event('input',{bubbles:true}));return {opened:paperDigestShowSettingsPane('cloud'),same:document.querySelector('#model')===input,value:input.value,visible:!document.querySelector('[data-setting-pane=cloud]').hidden,selected:document.querySelector('[data-pane=cloud]').getAttribute('aria-current')};});assert.deepEqual(result,{opened:true,same:true,value:'isolated-unsaved-model',visible:true,selected:'page'});
  assert.deepEqual(await page.evaluate(()=>[undefined,null,17,'unknown','Cloud','cloud]','cloud,model'].map(p=>paperDigestShowSettingsPane(p))),Array(7).fill(false));assert.equal(await page.locator('[data-pane=cloud]').getAttribute('aria-current'),'page');assert.equal(await page.evaluate(()=>paperDigestShowSettingsPane('model')),true);assert.equal(await page.evaluate(()=>document.querySelector('#model')===originalModelInput),true);assert.equal(await page.locator('#model').inputValue(),'isolated-unsaved-model');
  await page.evaluate(()=>paperDigestFlushSettings());assert.equal(await page.evaluate(()=>__fixture.settings.model),'isolated-unsaved-model');assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='settings.save').length),1);assert.equal(await page.evaluate(()=>__calls.filter(c=>/^(cloud\.(?!state)|model\.)/.test(c.command)).length),0);
 });

 await one('real Cloud settings hides only global discard while preserving both draft owners and original controls',async page=>{
  await page.goto('http://127.0.0.1:'+server.address().port+'/settings.html');await page.waitForFunction(()=>document.querySelector('#cloud-account'));
  await page.evaluate(()=>{window.originalScopeControls={model:document.querySelector('#model'),global:document.querySelector('#discard-settings'),cloud:document.querySelector('#cloud-account')};__workspaceHoldSettingsSave=true;paperDigestShowSettingsPane('model');const model=originalScopeControls.model;model.value='isolated-pending-model';model.dispatchEvent(new Event('input',{bubbles:true}));paperDigestShowSettingsPane('cloud');});
  assert.equal(await page.locator('#discard-settings').isHidden(),true,'Cloud must not offer the global model-settings discard');assert.equal(await page.locator('#cloud-discard').isVisible(),true);
  await page.locator('#cloud-account').fill('isolated-cloud-draft@example.test');await page.waitForFunction(()=>__workspaceSettingsWrites.length===1);await page.locator('#cloud-discard').click();await page.waitForFunction(()=>document.querySelector('#cloud-account').value==='');
  assert.equal(await page.locator('#model').inputValue(),'isolated-pending-model');assert.equal(await page.evaluate(()=>document.querySelector('#model')===originalScopeControls.model&&document.querySelector('#cloud-account')===originalScopeControls.cloud&&document.querySelector('#discard-settings')===originalScopeControls.global),true);
  for(const pane of ['reading','model','zotero','storage','cloud']){assert.equal(await page.evaluate(p=>paperDigestShowSettingsPane(p),pane),true);assert.equal(await page.locator('#discard-settings').isHidden(),pane==='cloud');}
  await page.evaluate(()=>__workspaceSettingsWrites.shift()());await page.evaluate(()=>paperDigestFlushSettings());assert.equal(await page.evaluate(()=>__fixture.settings.model),'isolated-pending-model');assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='settings.save').length),1);
  await page.evaluate(()=>{paperDigestShowSettingsPane('model');__fixture.failSettings=true;const model=document.querySelector('#model');model.value='isolated-unsaved-discard';model.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForFunction(()=>document.querySelector('#save-status').textContent.startsWith('未保存：'));await page.locator('#discard-settings').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已恢复最近保存的设置');assert.equal(await page.locator('#model').inputValue(),'isolated-pending-model');assert.equal(await page.evaluate(()=>document.querySelector('#model')===originalScopeControls.model),true);assert.equal(await page.evaluate(()=>__calls.filter(c=>/^(cloud\.(?!state)|model\.)/.test(c.command)).length),0);
 });

}finally{
 if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));const failed=results.filter(r=>!r.passed).length;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({contract:'workspace-view-production-dom-v1',scope:'frozen production DOM plus explicit headless/native fixtures; not real Mac AX acceptance',macAXValidated:false,knownRealMacFailures:['tasks-offline-complete-4f994c87.ax.txt','notes-4f994c87.ax.txt'],sourceSHA256:Object.fromEntries([...snapshot].map(([name,bytes])=>[name,hash(bytes)])),results,passed:results.length-failed,failed},null,2)+'\n');console.log('Workspace views: '+(results.length-failed)+' passed; '+failed+' failed; real Mac AX pending');if(failed)process.exitCode=1;
}})().catch(error=>{console.error(error);process.exitCode=1;});
