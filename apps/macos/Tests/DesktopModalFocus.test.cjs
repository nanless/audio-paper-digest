// Focus in the actual ordinary native leaf document, not the retired main modal.
const assert=require('node:assert/strict'),{chromium}=require('playwright');const {server,leaf}=require('./NativeDetailsFixture.cjs');
(async()=>{let browser,count=0;try{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 for(const kind of ['help','export','storage']){
  const p=await leaf(browser,kind);try{
   await p.waitForFunction(()=>document.activeElement===document.querySelector('#detail-content h1,#detail-content h2'));
   assert.equal(await p.locator('#detail-content h1,#detail-content h2').first().getAttribute('tabindex'),'-1');
   await p.keyboard.press('Tab');assert.notEqual(await p.evaluate(()=>document.activeElement.tagName),'BODY');
   assert.deepEqual(p.leafErrors,[]);count++;console.log('PASS visible real '+kind+' heading focus and reachable keyboard action');
  }finally{await p.close();}
 }
 const p=await leaf(browser,'export',{hold:'app.export'});try{
  await p.locator('[data-format=markdown]').click();await p.waitForFunction(()=>leafFixture.pending.length===1);
  assert.equal(await p.locator('#details-close').isDisabled(),true);
  await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>leafFixture.closed),false);
  await p.evaluate(()=>leafFixture.pending[0].resolve());await p.waitForFunction(()=>!document.querySelector('#details-close').disabled);
  await p.keyboard.press('Escape');await p.waitForFunction(()=>leafFixture.closed);
  count++;console.log('PASS native operation locks completion and Escape until actual response settles');
 }finally{await p.close();}
 console.log('Native detail focus: '+count+' passed; 0 failed');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
