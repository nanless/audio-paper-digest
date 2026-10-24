// Main routes to actual native presentations; Settings keeps its existing shared
// HTML modal contract. Browser fixture does not claim real AppKit/AX acceptance.
const assert=require('node:assert/strict'),{chromium}=require('playwright');const {server,installFixture,primary}=require('./DesktopUI.test.cjs');
(async()=>{let browser,count=0;try{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const p=await browser.newPage({viewport:{width:1440,height:900}});try{
  await installFixture(p,{nativeStorageWindow:true,papers:[primary]});await p.goto('http://127.0.0.1:'+server.address().port);await p.locator('[data-library-open]').click();await p.waitForSelector('#guide-frame');
  for(const kind of ['help','export'])await p.evaluate(action=>dispatchEvent(new CustomEvent('menu.command',{detail:{action}})),kind);
  await p.locator('#archive-open').click();
  await p.waitForFunction(()=>__calls.filter(c=>c.command==='details.show').length===3);
  assert.deepEqual(await p.evaluate(()=>__calls.filter(c=>c.command==='details.show').map(c=>c.payload.kind)),['help','export','zotero']);
  assert.equal(await p.locator('[data-dialog-surface],dialog[open]').count(),0);assert.equal(await p.locator('#app-window').evaluate(e=>e.inert),false);
  assert.equal(await p.evaluate(()=>__calls.filter(c=>['archive.materials','zotero.authorize','app.export'].includes(c.command)).length),0);
  assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);count++;console.log('PASS unchanged main routes all three presentations without an inline hidden modal or service operation');
 }finally{await p.close();}
 const s=await browser.newPage({viewport:{width:780,height:642}});try{
  await installFixture(s);await s.goto('http://127.0.0.1:'+server.address().port+'/settings.html');await s.locator('[data-pane=zotero]').click();await s.locator('#zotero-open-archive').click();await s.waitForSelector('[data-dialog-surface][open]');
  assert.equal(await s.locator('.settings-body').evaluate(e=>e.inert),true);assert.equal(await s.locator('[data-dialog-surface]').getAttribute('aria-modal'),'true');assert.equal(await s.locator('[data-dialog-surface]').getAttribute('role'),'dialog');
  await s.keyboard.press('Escape');await s.waitForFunction(()=>!document.querySelector('[data-dialog-surface]'));assert.equal(await s.locator('.settings-body').evaluate(e=>e.inert),false);assert.deepEqual(await s.evaluate(()=>__unimplemented),[]);count++;console.log('PASS existing Settings modal retains background isolation and complete close behavior');
 }finally{await s.close();}
 console.log('Native routing and Settings modal: '+count+' passed; 0 failed');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
