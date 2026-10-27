'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mac=process.env.PD_AGG_FOCUS_MAC||path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const runtime=process.env.PD_AGG_FOCUS_NATIVE||path.join(mac,'Resources/native.js');
const moduleFile=process.env.PD_AGG_FOCUS_MODULE||path.join(mac,'Resources/aggregate-ui.js');
const fixture=path.join(mac,'Tests/Fixtures/aggregate-math-daily24.json');
fs.mkdirSync(path.join(mac,'.qa'),{recursive:true});const output=process.env.PD_AGG_FOCUS_OUTPUT||fs.mkdtempSync(path.join(mac,'.qa/aggregate-focus-ui-'));fs.mkdirSync(output,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const source=fs.readFileSync(runtime,'utf8'),moduleSource=fs.readFileSync(moduleFile,'utf8'),saved=JSON.parse(fs.readFileSync(fixture));
const value={...saved,displayHTML:saved.bodyHTML,validatedAt:null,isStale:true,readNotice:'Fixed published material, UI focus ordering only',completeOffline:false};
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
    if(window.__afHoldDocument)await new Promise(resolve=>__afDocGates.push(resolve));
    if(window.__afFailDocument)throw Error('Controlled document failure');
    return result;
   }
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
async function check(name,fn){if(process.env.PD_AGG_FOCUS_ONLY&&!name.includes(process.env.PD_AGG_FOCUS_ONLY))return;const{p,external}=await setup();try{
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
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('loading heading retains normal next-rAF keyboard focus',async p=>{await pending(p);await drain(p);assert.equal(await headingFocused(p),true);assert.equal(await p.locator('#aggregate-view h1').innerText(),'正在读取汇总页面');});
 await check('failure heading retains normal next-rAF keyboard focus',async p=>{await p.evaluate(()=>{__afFailDocument=true;});await pending(p);await p.evaluate(async()=>{__afHoldDocument=false;__afDocGates.shift()();await __afOpenPromise;});await p.waitForFunction(()=>document.querySelector('#aggregate-view h1')?.textContent==='汇总页面暂不可读');await p.waitForFunction(()=>__afRAFQueue.length>=2);await drain(p);assert.equal(await headingFocused(p),true);});
 await check('final heading waits for actual current frame-load callback before taking focus',async p=>{await pending(p);await drain(p);await complete(p);await drain(p);assert.equal(await headingFocused(p),false,'Final heading must not focus before actual load callback');await finalFocus(p);assert.equal(await headingFocused(p),true);});
 await check('late loading rAF never borrows the replaced final pane and heading',async p=>{await pending(p);await p.evaluate(()=>{window.__afOldPane=document.getElementById('aggregate-view');window.__afOldHeading=__afOldPane.querySelector('h1');});await complete(p);const before=await p.locator('#aggregate-view .aggregate-actions button').first();await before.focus();await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;const old=__afRAFQueue.filter(x=>x.pane===__afOldPane);if(old.length!==1)throw Error('Expected real loading rAF');__afRAFQueue=__afRAFQueue.filter(x=>x.pane!==__afOldPane);old[0].run();});assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);assert.equal(await p.evaluate(()=>__afOldHeading.isConnected),false);});
 await check('actual Tab into another current control cancels late final focus',async p=>{await pending(p);await drain(p);await complete(p);await p.locator('#aggregate-view .aggregate-actions button').first().focus();await p.keyboard.press('Tab');await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;});await finalFocus(p);assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);});
 await check('actual pointer source-summary action cancels late final focus',async p=>{await pending(p);await drain(p);await complete(p);await p.locator('.aggregate-source summary').click();await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;});assert.equal(await p.locator('.aggregate-source').getAttribute('open'),'');await finalFocus(p);assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);});
 await check('synthetic DOM semantic click expands source without focus and cancels late final focus',async p=>{await pending(p);await drain(p);await complete(p);await p.evaluate(()=>{const summary=document.querySelector('.aggregate-source summary');if(document.activeElement!==document.body)throw Error('Expected actual body focus before synthetic semantic click');summary.click();if(document.activeElement!==document.body||!summary.parentElement.open)throw Error('Synthetic click must expand details without assigning focus');});await finalFocus(p);assert.equal(await headingFocused(p),false,'Semantic click interaction must not lose focus to late heading callback');});
 await check('focus transfer without Tab or pointer cancels late final focus',async p=>{await pending(p);await drain(p);await complete(p);await p.locator('#aggregate-view .aggregate-actions button').first().focus();await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;});await finalFocus(p);assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);});
 await check('interaction during document wait prevents final completion from reclaiming focus',async p=>{await pending(p);await drain(p);await p.locator('#aggregate-view .aggregate-actions button').first().focus();await complete(p);await finalFocus(p);assert.equal(await headingFocused(p),false);});
 await check('same-window blur cancels pending final completion focus',async p=>{await pending(p);await drain(p);await complete(p);await p.evaluate(()=>window.dispatchEvent(new Event('blur')));await finalFocus(p);assert.equal(await headingFocused(p),false);});
 await check('late actual frame load after leave cannot change library focus',async p=>{await pending(p);await drain(p);await complete(p);await p.evaluate(()=>__af.setView('library'));await p.locator('#search-input').focus();await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;});await release(p);await drain(p);assert.equal(await p.evaluate(()=>__af.state.view),'library');assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);});
 await check('old frame callback cannot borrow a newer aggregate pane',async p=>{await pending(p);await drain(p);await complete(p);await p.evaluate(()=>{window.__afFirstPane=document.getElementById('aggregate-view');});await pending(p);await complete(p,2);await p.locator('#aggregate-view .aggregate-actions button').first().focus();await p.evaluate(()=>{window.__afExpectedFocus=document.activeElement;});await release(p,0);await p.evaluate(()=>{const old=__afRAFQueue.filter(x=>x.pane===__afFirstPane);__afRAFQueue=__afRAFQueue.filter(x=>x.pane!==__afFirstPane);for(const item of old)item.run();});assert.equal(await p.evaluate(()=>document.activeElement===__afExpectedFocus),true);assert.equal(await p.evaluate(()=>__afLoadQueue[0].frame.isConnected),false);});
 }finally{
 await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
 const inputsChanged=inputFiles.filter(p=>hash(fs.readFileSync(p))!==inputs[p]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'Actual production native/module JS and real DOM/browser focus with controlled real rAF deliveries/actual srcdoc load callbacks. Existing published fixed body; not AppKit/WebKit/systemAX/provider or source-authentication proof. Window blur case is explicit synthetic DOM event only; Tab/pointer/focus cases use real browser actions.',inputs,inputsChanged,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results},null,2));
 if(inputsChanged.length||(!process.env.PD_AGG_FOCUS_ONLY&&results.length!==12)||results.some(x=>!x.passed))process.exitCode=1;
 }} )().catch(error=>{console.error(error);process.exitCode=1;});
