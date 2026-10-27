'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mac=process.env.PD_SEARCH_MAC||path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture,primary}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const sourceFile=process.env.PD_SEARCH_SOURCE||path.join(mac,'Resources/native.js');
fs.mkdirSync(path.join(mac,'.qa'),{recursive:true});
const output=process.env.PD_SEARCH_OUTPUT||fs.mkdtempSync(path.join(mac,'.qa/search-navigation-'));
fs.mkdirSync(output,{recursive:true});assert.ok(!fs.existsSync(path.join(output,'result.json')),'Preserve earlier results');
const source=fs.readFileSync(sourceFile,'utf8'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(source.split('start().catch(error);').length,2,'Bind only the original startup Promise');
const inputs=Object.fromEntries([__filename,sourceFile,path.join(mac,'Tests/DesktopUI.test.cjs')].map(p=>[p,sha(p)]));
let browser;const results=[];
async function fence(p){await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function setup(){
 const p=await browser.newPage({viewport:{width:1440,height:900}}),external=[],errors=[];
 await p.route('**/native.js',r=>r.fulfill({contentType:'text/javascript',body:source.replace('start().catch(error);','window.__searchStarted=start().catch(error);')}));
 await p.route('https://**',r=>{external.push(r.request().url());return r.abort();});
 p.on('pageerror',e=>errors.push(e.message));
 await installFixture(p,{nativeStorageWindow:true,papers:[primary]});
 await p.goto('http://127.0.0.1:'+server.address().port);await p.evaluate(()=>window.__searchStarted);await fence(p);
 await p.evaluate(()=>{const original=webkit.messageHandlers.desktop.postMessage;window.__searchGate={hold:false,entered:0,waiters:[]};webkit.messageHandlers.desktop.postMessage=async input=>{if(input.command==='library.search'&&__searchGate.hold){__searchGate.entered++;await new Promise(r=>__searchGate.waiters.push(r));}return original(input);};});
 return {p,external,errors};
}
async function origin(p,name){await p.locator('[data-view="'+name+'"]').click();await p.waitForFunction(n=>!document.getElementById(n+'-view').hidden,name);await fence(p);}
async function menuSearch(p){await p.evaluate(()=>dispatchEvent(new CustomEvent('menu.command',{detail:{action:'search'}})));}
async function libraryVisible(p){await p.waitForFunction(()=>!document.getElementById('library-view').hidden);await fence(p);}
async function heldSearch(p){
 await p.locator('#search-input').fill('MiCLA');await p.waitForFunction(()=>__calls.some(x=>x.command==='library.search'&&x.payload.query==='MiCLA'));
 await origin(p,'tasks');await p.evaluate(()=>{__searchGate.hold=true;});await menuSearch(p);await p.waitForFunction(()=>__searchGate.entered===1);
}
async function release(p){await p.evaluate(()=>{__searchGate.hold=false;for(const r of __searchGate.waiters.splice(0))r();});await fence(p);}
async function check(name,fn){const {p,external,errors}=await setup();try{await fn(p);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);assert.equal(await p.evaluate(()=>__calls.some(x=>/^(model\.|zotero\.)/.test(x.command))),false);results.push({name,passed:true});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:e.stack,focus:await p.evaluate(()=>({active:document.activeElement?.id,search:document.getElementById('search-input').value,libraryHidden:document.getElementById('library-view').hidden})).catch(()=>null)});console.error('FAIL',name,e.message);}finally{await release(p).catch(()=>{});await p.close();}}
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('menu search from Tasks focuses the revealed field and accepts real typing',async p=>{await origin(p,'tasks');await menuSearch(p);await libraryVisible(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('search-input')),true);await p.keyboard.type('MiCLA');assert.equal(await p.locator('#search-input').inputValue(),'MiCLA');});
 await check('toolbar search from Notes focuses the revealed field and accepts real typing',async p=>{await origin(p,'notes');await p.locator('#global-search').click();await libraryVisible(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('search-input')),true);await p.keyboard.type('MiCLA');assert.equal(await p.locator('#search-input').inputValue(),'MiCLA');});
 await check('later navigation owns focus when an earlier search finishes',async p=>{await heldSearch(p);await p.locator('[data-view="today"]').click();await p.waitForFunction(()=>__searchGate.entered>=2);await release(p);await p.waitForFunction(()=>document.querySelector('[data-view="today"]').classList.contains('is-active'));await fence(p);assert.equal(await p.evaluate(()=>document.activeElement===document.querySelector('[data-view="today"]')),true);});
 await check('explicit focus transfer to sorting survives delayed search completion',async p=>{await heldSearch(p);await p.locator('#sort').focus();await release(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('sort')),true);});
 await check('actual pointer filter action survives delayed search completion',async p=>{await heldSearch(p);await p.locator('#library-clear-filters').click();await release(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('library-clear-filters')),true);assert.equal(await p.locator('#search-input').inputValue(),'');});
 await check('synthetic window blur cancels the pending focus intent',async p=>{await heldSearch(p);await p.evaluate(()=>window.dispatchEvent(new Event('blur')));await release(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('search-input')),false);});
 await check('focus transfer then blur to body does not revive an in-flight search focus intent',async p=>{await heldSearch(p);await p.locator('#sort').focus();await p.locator('#sort').evaluate(n=>n.blur());assert.equal(await p.evaluate(()=>document.activeElement===document.body),true);await release(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('search-input')),false);});
 await check('same-view library search keeps ordinary immediate-search behavior',async p=>{await menuSearch(p);await libraryVisible(p);assert.equal(await p.evaluate(()=>document.activeElement===document.getElementById('search-input')),true);await p.keyboard.type('MiCLA');assert.equal(await p.locator('#search-input').inputValue(),'MiCLA');});
 }finally{await browser?.close();if(server.listening)await new Promise(r=>server.close(r));const changed=Object.keys(inputs).filter(p=>sha(p)!==inputs[p]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'Actual unchanged production page/module, bridge-only data fixtures, actual menu-command event and toolbar/Tab/pointer/browser focus. Synthetic window blur is not OS focus proof. No native GUI, credentials, network service or model calls.',inputs,inputsChanged:changed,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results},null,2)+'\n');if(changed.length||results.length!==8||results.some(x=>!x.passed))process.exitCode=1;}
})().catch(e=>{console.error(e);process.exitCode=1;});
