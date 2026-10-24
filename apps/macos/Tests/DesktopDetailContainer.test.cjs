// Native detail leaf production content; bridge is a local explicit fixture.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {server,leaf,primary}=require('./NativeDetailsFixture.cjs');
(async()=>{let browser,count=0;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 for(const kind of ['help','export','zotero','storage']){
  const p=await leaf(browser,kind);try{
   assert.equal(await p.locator('dialog,[data-dialog-surface]').count(),0);
   assert.equal(await p.locator('#details-close').innerText(),'完成');
   assert.equal(await p.locator('[data-detail-close]').count(),0);
   assert.equal(await p.locator('#details-refresh').isVisible(),kind==='storage');
   assert.deepEqual(p.leafErrors,[]);count++;console.log('PASS actual ordinary leaf structure and one owner close '+kind);
  }finally{await p.close();}
 }
 const p=await leaf(browser,'export');try{
  assert.ok((await p.locator('#detail-content').innerText()).includes(primary.title));
  for(const format of ['markdown','html','json','guide','pdf','bib','ris','citation']){
   await p.locator('[data-format="'+format+'"]').click();await p.waitForFunction(()=>document.querySelector('[data-detail-status]').textContent.includes('已保存'));
  }
  const calls=await p.evaluate(()=>leafFixture.calls.filter(c=>c.command==='app.export'));
  assert.deepEqual(calls.map(c=>c.payload.format),['markdown','html','json','guide','pdf','bib','ris','citation']);
  assert(calls.every(c=>Object.keys(c.payload).sort().join(',')==='format,presentationID'));
  count++;console.log('PASS all eight actual leaf export controls only request format and native session');
 }finally{await p.close();}
 const h=await leaf(browser,'help');try{
  for(const command of ['app.backup','app.restore','app.diagnostics']){await h.locator('[data-detail-command="'+command+'"]').click();await h.waitForFunction(()=>document.querySelectorAll('[data-detail-command]:disabled').length===0);}
  const commands=await h.evaluate(()=>leafFixture.calls.filter(c=>c.command.startsWith('app.')).map(c=>c.command));assert.deepEqual(commands,['app.backup','app.restore','app.diagnostics']);count++;console.log('PASS help content uses the three explicit native document operations');
 }finally{await h.close();}
 const z=await leaf(browser,'zotero',{archives:[{archiveID:'explicit-original-checkpoint',title:'原归档 A',identity:'arxiv:2601.00001v1',updatedAt:1790000000,status:'complete'}]});try{
  await z.locator('[data-zotero-resume]').waitFor({state:'visible'});
  assert.equal(await z.locator('#zotero-recent').evaluate(e=>!!e.closest('.native-archive-history')&&!e.closest('[hidden]')),true);
  await z.locator('[data-zotero-resume]').click();await z.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('原归档已完成本次回读核验'));
  const calls=await z.evaluate(()=>leafFixture.calls);assert.deepEqual(calls.filter(c=>c.command==='zotero.resume').map(c=>c.payload),[{resumeID:'explicit-original-checkpoint',presentationID:'native-fixture-owner'}]);
  assert.equal(calls.filter(c=>c.command==='zotero.archive'||c.command==='zotero.authorize').length,0);
  assert.equal(await z.locator('#archive-title').innerText(),'原归档 A');
  count++;console.log('PASS visible original checkpoint resumes independently of current preview with no new archive');
 }finally{await z.close();}
 console.log('Native detail content: '+count+' passed; 0 failed');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
