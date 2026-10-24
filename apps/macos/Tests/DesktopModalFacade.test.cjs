/* Author regression for the native-AX remediation contract. Real bundled UI and
 * Chromium DOM/AX, explicit native fixtures; no real WebKit AX/services/profile. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {server,installFixture,repo}=require('./DesktopUI.test.cjs');
const output=process.env.PD_MODAL_TEST_ARTIFACTS||path.join(repo,'apps/macos/.qa/modal-facade');fs.mkdirSync(output,{recursive:true});
const results=[];let browser;
async function check(name,action){await action();results.push({name,passed:true});console.log('PASS '+name);}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await installFixture(page);await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-library-open="arxiv:2610.27491"]').click();await page.waitForFunction(()=>document.querySelector('#guide-frame')?.contentDocument?.querySelector('main'));
 await page.evaluate(()=>window.originalDetail=document.querySelector('#detail-dialog'));
 await check('native HTMLDialog facade remains closed and has no modal semantics; visible surface alone is dialog',async()=>{
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));await page.waitForSelector('[data-dialog-surface] #detail-close');
  const state=await page.evaluate(()=>({jsOpen:originalDetail.open,domOpen:originalDetail.hasAttribute('open'),role:originalDetail.getAttribute('role'),modal:originalDetail.getAttribute('aria-modal'),surface:document.querySelector('#detail-dialog').tagName,openNative:document.querySelectorAll('dialog[open]').length}));
  assert.deepEqual(state,{jsOpen:true,domOpen:false,role:null,modal:null,surface:'SECTION',openNative:0});
  assert.equal(await page.locator('#detail-dialog').getAttribute('role'),'dialog');assert.equal(await page.locator('#detail-dialog').getAttribute('aria-modal'),'true');
  const cdp=await page.context().newCDPSession(page),tree=await cdp.send('Accessibility.getFullAXTree');assert.equal(tree.nodes.filter(n=>!n.ignored&&n.role?.value==='dialog').length,1);await cdp.detach();
  await page.locator('#detail-close').click();assert.equal(await page.evaluate(()=>originalDetail.open),false);
 });
 await check('PDF hides and restores from visible modal event although no native dialog open attribute is set',async()=>{
  await page.locator('#pdf-toggle').click();await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.frame').at(-1)?.payload.visible===true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.frame').at(-1)?.payload.visible===false);assert.equal(await page.locator('dialog[open]').count(),0);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.frame').at(-1)?.payload.visible===true);
 });
 await check('visible modal blocks background paid shortcut with no HTMLDialog open attribute',async()=>{
  await page.locator('#tab-analysis').click();await page.locator('#question').fill('Explicit background fixture; do not dispatch.');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));await page.waitForSelector('[data-dialog-surface]');
  await page.keyboard.press('Meta+Enter');assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='model.run').length),0);await page.keyboard.press('Escape');
 });
 await check('archive async controls still use original facade; nested Escape closes only top surface',async()=>{
  await page.evaluate(()=>window.originalArchive=document.querySelector('#archive-dialog'));await page.locator('#archive-open').click();await page.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('核对内容'));
  assert.equal(await page.evaluate(()=>originalArchive.open&&!originalArchive.hasAttribute('open')&&originalArchive.querySelector('#archive-guide')===document.querySelector('#archive-guide')),true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));assert.equal(await page.locator('[data-dialog-surface]').count(),2);
  await page.keyboard.press('Escape');assert.equal(await page.locator('[data-dialog-surface]').count(),1);assert.equal(await page.locator('#app-window').evaluate(el=>el.inert),true);assert.equal(await page.evaluate(()=>originalArchive.open),true);
  await page.locator('#archive-dialog button[value=cancel]').first().click();assert.equal(await page.locator('[data-dialog-surface]').count(),0);assert.equal(await page.evaluate(()=>originalArchive.open),false);
 });
 await check('personal restore event closes nested surfaces, restores shell and clears stale dialog controls',async()=>{
  await page.locator('#archive-open').click();await page.waitForSelector('[data-dialog-surface]');await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));assert.equal(await page.locator('[data-dialog-surface]').count(),2);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('personal.changed')));await page.waitForFunction(()=>document.querySelectorAll('[data-dialog-surface]').length===0&&!document.querySelector('#app-window').inert);assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.evaluate(()=>originalArchive.open||originalDetail.open),false);
 });
 await check('main source uses only visible modal selector and page reported no uncaught errors',async()=>{
  const native=fs.readFileSync(path.join(repo,'apps/macos/Resources/native.js'),'utf8'),settings=fs.readFileSync(path.join(repo,'apps/macos/Resources/settings.js'),'utf8');assert.ok(!native.includes("'dialog[open]'"));assert.ok(!settings.includes("'dialog[open]'"));assert.match(native,/modal\.changed/);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>__unimplemented),[]);
 });
 await page.close();
})().catch(e=>{console.error(e);results.push({passed:false,error:e.message});process.exitCode=1}).finally(async()=>{if(browser)await browser.close();await new Promise(r=>server.close(r));const sources=Object.fromEntries(['dialogs.js','native.js','settings.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'apps/macos/Resources',name))).digest('hex')]));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'author isolated DOM/ChromiumAX; not native WebKit AX acceptance',sources,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length},null,2)+'\n');console.log('Modal facade: '+results.filter(r=>r.passed).length+' passed');});
