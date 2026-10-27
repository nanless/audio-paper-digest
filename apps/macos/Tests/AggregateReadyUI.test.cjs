'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mac=process.env.PD_AGG_READY_MAC||path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const runtime=process.env.PD_AGG_READY_NATIVE||path.join(mac,'Resources/native.js');
const moduleFile=process.env.PD_AGG_READY_MODULE||path.join(mac,'Resources/aggregate-ui.js');
const fixture=path.join(mac,'Tests/Fixtures/aggregate-math-daily24.json');
fs.mkdirSync(path.join(mac,'.qa'),{recursive:true});const output=process.env.PD_AGG_READY_OUTPUT||fs.mkdtempSync(path.join(mac,'.qa/aggregate-ready-ui-'));fs.mkdirSync(output,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const source=fs.readFileSync(runtime,'utf8'),moduleSource=fs.readFileSync(moduleFile,'utf8'),saved=JSON.parse(fs.readFileSync(fixture));
const value={...saved,displayHTML:saved.bodyHTML,validatedAt:null,isStale:true,readNotice:'Fixed published material, UI focus ordering only',completeOffline:false,documentReadyNonce:'11111111-2222-4333-8444-555555555555',displayBodySHA256:'a'.repeat(64)};
assert.equal(source.split('start().catch(error);').length,2,'Only bind the original startup Promise; no duplicate start');
const inputFiles=[__filename,runtime,moduleFile,fixture,path.join(mac,'Tests/DesktopUI.test.cjs')];
const inputs=Object.fromEntries(inputFiles.map(p=>[p,hash(fs.readFileSync(p))]));
let browser;const results=[];
async function setup(){
 const p=await browser.newPage({viewport:{width:1470,height:813}}),external=[];
 await p.route('**/native.js',r=>r.fulfill({contentType:'text/javascript',body:source.replace('start().catch(error);','window.__afStarted=start().catch(error);')+'\nwindow.__af={state,openAggregate,setView,aggregates};'}));
 await p.route('**/aggregate-ui.js',r=>r.fulfill({contentType:'text/javascript',body:moduleSource}));
 await p.route('https://**',r=>{external.push(r.request().url());return r.abort();});
 await installFixture(p);
 await p.addInitScript(value=>{
  const original=webkit.messageHandlers.desktop.postMessage;
  window.__afCalls=[];window.__afDocGates=[];window.__afLoadQueue=[];window.__afRAFQueue=[];
  let session=null;
  webkit.messageHandlers.desktop.postMessage=async input=>{
   const{command,payload={}}=input;__afCalls.push(structuredClone(input));
   if(command==='app.bootstrap')return{...await original(input),nativeNotes:true,nativeTasks:true};
   if(command.startsWith('nativeNotes.')||command.startsWith('nativeTasks.'))return command.endsWith('.bootstrap')?{nonce:command+'nonce',highestSequence:0}:{accepted:true};
   if(command==='aggregates.list')return{records:[value.descriptor]};
   if(command==='aggregates.open'){
    if(Object.keys(payload).join(',')!=='id'||payload.id!==value.descriptor.id)throw Error('Fixed ID-only open required');
    session={id:payload.id,sessionID:crypto.randomUUID(),contextGeneration:1};__fixture.selected=null;return session;
   }
   if(command==='aggregates.document'){
    if(payload.id!==session?.id||payload.sessionID!==session?.sessionID)throw Error('Current fixture session required');
    const result={...structuredClone(value),...session};
    if(window.__afNoTicket){delete result.documentReadyNonce;delete result.displayBodySHA256;result.displayHTML='<h2 id="section">UI-only legacy outline</h2><a data-aggregate-link="0">Bound link</a>';}
    if(window.__afHoldDocument)await new Promise(resolve=>__afDocGates.push(resolve));
    if(window.__afFailDocument)throw Error('Controlled document failure');
    return result;
   }
   if(command==='aggregates.viewReady')return{accepted:true};
   if(command==='aggregates.link')return{kind:'anchor',anchor:'section'};
   if(command==='aggregates.leave'){session=null;return{left:true};}
   return original(input);
  };
  // Retain actual browser rAF deliveries and actual iframe load events. Only their
  // production callback invocation is controllable; no success/event is fabricated.
  const raf=window.requestAnimationFrame.bind(window);
  window.__afFrameFence=()=>new Promise(resolve=>raf(()=>raf(resolve)));
  window.requestAnimationFrame=callback=>{
   if(!window.__afHoldRAF||!String(new Error().stack).includes('/aggregate-ui.js'))return raf(callback);
   const pane=document.getElementById('aggregate-view'),heading=pane?.querySelector('h1');
   return raf(time=>__afRAFQueue.push({pane,heading,run:()=>callback(time)}));
  };
  const add=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type,callback,options){
   if(type==='load'&&this instanceof HTMLIFrameElement&&this.classList.contains('aggregate-frame')){
    return add.call(this,type,function(event){
     if(!window.__afHoldLoad)return callback.call(this,event);
     const frame=this;__afLoadQueue.push({frame,event,run:()=>callback.call(frame,event),released:false});
    },options);
   }
   return add.call(this,type,callback,options);
  };
  window.__afDrainRAF=()=>{const pending=__afRAFQueue.splice(0);for(const item of pending)item.run();return pending.length;};
  window.__afReleaseLoad=index=>{const item=__afLoadQueue[index];if(!item||item.released)throw Error('Missing actual load event');item.released=true;item.run();};
 },value);
 await p.goto('http://127.0.0.1:'+server.address().port);await p.evaluate(()=>window.__afStarted);await p.waitForSelector('[data-library-open]');
 await p.evaluate(()=>{__afHoldRAF=true;__afHoldLoad=true;});
 return{p,external};
}
async function check(name,fn){const{p,external}=await setup();try{
 await fn(p);
 assert.deepEqual(external,[]);
 assert.equal(await p.evaluate(()=>__afCalls.some(x=>/^(model\.|zotero\.)/.test(x.command))),false);
 results.push({name,passed:true});console.log('PASS',name);
 }catch(error){const debug=await p.evaluate(()=>({view:window.__af?.state.view,calls:window.__afCalls?.map(x=>x.command),gateCount:window.__afDocGates?.length,RAF:window.__afRAFQueue?.map(x=>({heading:x.heading?.textContent,connected:x.pane?.isConnected})),heading:document.querySelector('#aggregate-view h1')?.textContent,toast:document.getElementById('toast')?.textContent})).catch(()=>null);results.push({name,passed:false,error:error.stack,debug});console.error('FAIL',name,error.stack,JSON.stringify(debug));}finally{await p.close();}}
async function pending(p){
 await p.evaluate(id=>{window.__afFixtureID=id;__afHoldDocument=true;window.__afOpenPromise=__af.openAggregate(id);},value.descriptor.id);
 await p.waitForFunction(()=>__afDocGates.length===1&&__afRAFQueue.some(x=>x.heading?.textContent==='正在读取汇总页面'));
}
async function complete(p,count=1){
 await p.evaluate(async()=>{__afHoldDocument=false;__afDocGates.shift()();await __afOpenPromise;});
 await p.waitForFunction(n=>__afLoadQueue.length===n&&__afLoadQueue[n-1].frame.contentDocument?.querySelector('main')&&__afLoadQueue[n-1].frame.contentDocument.readyState==='complete',count);
 await p.evaluate(()=>__afFrameFence());
}
async function release(p,index=0){await p.evaluate(i=>__afReleaseLoad(i),index);}
async function drain(p){await p.evaluate(()=>__afDrainRAF());}
const headingFocused=p=>p.evaluate(()=>document.activeElement===document.querySelector('#aggregate-view h1'));
async function finalFocus(p,index=0){await release(p,index);await p.evaluate(()=>__afFrameFence());await drain(p);}

const readyCalls=p=>p.evaluate(()=>__afCalls.filter(x=>x.command==='aggregates.viewReady'));
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('loading and document Promise alone never send ready',async p=>{
  await pending(p);assert.deepEqual(await readyCalls(p),[]);await complete(p);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('actual current complete srcdoc load sends exact native ticket once',async p=>{
  await pending(p);await complete(p);await release(p);const calls=await readyCalls(p);assert.equal(calls.length,1);assert.deepEqual(calls[0].payload,{id:value.descriptor.id,sessionID:await p.evaluate(()=>__afLoadQueue[0].frame.contentDocument.querySelector('main')&&__afCalls.find(x=>x.command==='aggregates.document').payload.sessionID),documentReadyNonce:value.documentReadyNonce,displayBodySHA256:value.displayBodySHA256});
  await p.evaluate(()=>__afLoadQueue[0].run());assert.equal((await readyCalls(p)).length,1);
 });
 await check('leave before actual load rejects stale frame callback',async p=>{
  await pending(p);await complete(p);await p.evaluate(()=>__af.setView('library'));await release(p);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('same-ID newer opening cannot borrow old frame ticket or callbacks',async p=>{
  await pending(p);await complete(p);await p.evaluate(id=>{window.__afOpenPromise=__af.openAggregate(id);},value.descriptor.id);
  await p.evaluate(()=>__afOpenPromise);await p.waitForFunction(()=>__afLoadQueue.length===2&&__afLoadQueue[1].frame.contentDocument?.querySelector('main'));
  await release(p,0);assert.deepEqual(await readyCalls(p),[]);await release(p,1);const calls=await readyCalls(p);assert.equal(calls.length,1);assert.notEqual(calls[0].payload.sessionID,await p.evaluate(()=>__afCalls.filter(x=>x.command==='aggregates.document')[0].payload.sessionID));
 });
 await check('wrong document stamp does not acknowledge a complete frame',async p=>{
  await pending(p);await complete(p);await p.evaluate(()=>__afLoadQueue[0].frame.contentDocument.querySelector('main').setAttribute('data-document-ready-nonce','wrong'));await release(p);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('actual blank document load cannot acknowledge previous body',async p=>{
  await pending(p);await complete(p);await p.evaluate(()=>{const f=__afLoadQueue[0].frame;f.removeAttribute('srcdoc');f.src='about:blank';});await p.waitForFunction(()=>__afLoadQueue.length>=2&&__afLoadQueue[0].frame.contentDocument?.URL==='about:blank');await release(p,0);await release(p,1);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('hidden or inert parent refuses actual load ready',async p=>{
  await pending(p);await complete(p);await p.evaluate(()=>document.getElementById('aggregate-view').setAttribute('inert',''));await release(p);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('document failure has no ready receipt',async p=>{
  await p.evaluate(()=>{__afFailDocument=true;});await pending(p);await p.evaluate(async()=>{__afHoldDocument=false;__afDocGates.shift()();await __afOpenPromise;});assert.deepEqual(await readyCalls(p),[]);assert.equal(await p.locator('#aggregate-view h1').innerText(),'汇总页面暂不可读');
 });
 await check('legacy receipt without nonce retains outline bound link and final focus',async p=>{
  await p.evaluate(()=>{__afNoTicket=true;});await pending(p);await drain(p);await complete(p);await finalFocus(p);assert.equal(await headingFocused(p),true);
  assert.equal(await p.locator('.aggregate-outline nav button').textContent(),'UI-only legacy outline');await p.frameLocator('#aggregate-view iframe').getByText('Bound link',{exact:true}).click();const call=await p.evaluate(()=>__afCalls.find(x=>x.command==='aggregates.link'));assert.deepEqual(Object.keys(call.payload).sort(),['id','index','sessionID']);assert.equal(call.payload.index,0);assert.deepEqual(await readyCalls(p),[]);
 });
 await check('ordinary user interaction never triggers ready before load or changes ticket',async p=>{
  await pending(p);await complete(p);await p.locator('.aggregate-source summary').click();assert.deepEqual(await readyCalls(p),[]);await release(p);const calls=await readyCalls(p);assert.equal(calls.length,1);assert.equal(calls[0].payload.documentReadyNonce,value.documentReadyNonce);
 });
 }finally{
 if(browser)await browser.close();server.close();const changed=Object.entries(inputs).filter(([p,sha])=>hash(fs.readFileSync(p))!==sha).map(([p])=>p);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:results.length===10&&results.every(x=>x.passed)&&changed.length===0,results,inputs,inputsChanged:changed},null,2));if(results.length!==10||results.some(x=>!x.passed)||changed.length)process.exitCode=1;
 }})().catch(error=>{console.error(error);process.exitCode=1;});
