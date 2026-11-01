const {chromium}=require('playwright'),assert=require('assert/strict'),fs=require('fs');
const {server,installFixture}=require('./DesktopUI.test.cjs');let browser;
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const papers=Array.from({length:10005},(_,i)=>({id:'synthetic:'+String(i).padStart(5,'0'),title:'Synthetic catalog '+i,titleZh:'明确合成目录 '+i,sourceKind:'arxiv',date:i===10004?'2099-01-01':'2026-10-31',authors:[],localRetained:i===10004}));
 await installFixture(page,{papers,initialPersonal:{favorites:[papers.at(-1).id],reading:[],notes:{},readingState:{},annotations:{},sessions:[]}});
 await page.addInitScript(()=>{if(window.top!==window)return;const original=window.webkit.messageHandlers.desktop.postMessage;window.holdTail=true;window.catalogReadMode='good';window.webkit.messageHandlers.desktop.postMessage=async message=>{
  if(message.command==='personal.note'){const p=message.payload||{},revision=window.__fixture.personal.notes?.[p.paperID]?.revision||0;if(p.baseRevision!==revision)throw Error('Synthetic native note revision conflict');}
  if(message.command==='library.status')return{paperCount:10004,recordCount:10004,snapshotID:window.summaryMismatch?'synthetic-other-summary':'synthetic-original',syncedAt:'2026-11-01T00:00:00Z'};
  if(message.command==='library.list'){
   const payload=message.payload||{},offset=payload.offset||0;window.__calls.push({command:message.command,payload:structuredClone(payload)});
   if(offset&&window.holdTail)await new Promise(resolve=>window.releaseTail=resolve);
   const all=window.__fixture.papers;return {papers:structuredClone(all.slice(offset,offset+(payload.limit||200))),total:all.length,offset,snapshotID:offset&&window.catalogReadMode==='changed'?'synthetic-changed':'synthetic-original'};
  }
  return original(message);
 };});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>typeof releaseTail==='function');
 assert.match(await page.locator('[role=status]').filter({hasText:'10,000 / 10,005'}).innerText(),/正在读取本机目录/);assert.equal(await page.locator('[data-library-row]').count(),0);
 await page.evaluate(()=>{holdTail=false;releaseTail();});await page.waitForSelector('[data-library-row]');
 assert.match(await page.locator('#result-count').innerText(),/10,005/);assert.match(await page.locator('#library-subtitle').innerText(),/10,004 篇当前网站目录 · 1 篇本机保留/);assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.command==='library.list').map(c=>c.payload.offset)),[0,10000]);
 await page.locator('[data-view=favorites]').click();await page.waitForSelector('[data-library-row="synthetic:10004"]');assert.match(await page.locator('[data-library-row="synthetic:10004"]').innerText(),/本机保留/);assert.match(await page.locator('#library-subtitle').innerText(),/^1 篇收藏/);
 await page.locator('[data-view=today]').click();await page.locator('[data-aggregate-mode=papers]').click();await page.waitForSelector('[data-library-row]');assert.equal(await page.locator('[data-library-row="synthetic:10004"]').count(),0);assert.match(await page.locator('#result-count').innerText(),/10,004 篇匹配/);
 // A sync changing the source between pages cannot partially replace the accepted catalog.
 await page.locator('[data-view=library]').click();await page.evaluate(()=>{catalogReadMode='changed';window.dispatchEvent(new CustomEvent('library.changed'));});await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('目录发生变化'));
 assert.equal(await page.locator('[data-library-row]').count(),100);assert.match(await page.locator('#result-count').innerText(),/10,005/);const retry=page.getByRole('button',{name:'重新读取本机目录'});assert.equal(await retry.isVisible(),true);
 await page.evaluate(()=>catalogReadMode='good');await retry.click();await page.waitForFunction(()=>document.querySelector('button').ownerDocument.querySelectorAll('[data-library-row]').length===100&&!document.querySelector('p[role=status]').textContent.includes('目录发生变化'));
 // Saving in the reader while a catalog tail waits must retire the old personal mirror.
 await page.locator('[data-library-open="synthetic:00000"]').click();await page.waitForFunction(()=>paperDigestArchiveHTML()?.paperID==='synthetic:00000');
 await page.evaluate(()=>{holdTail=true;releaseTail=undefined;window.dispatchEvent(new CustomEvent('library.changed'));});await page.waitForFunction(()=>typeof releaseTail==='function');
 await page.locator('#tab-note').click();await page.locator('#note-editor').fill('Saved note while catalog tail held');await page.waitForFunction(()=>__fixture.personal.notes['synthetic:00000']?.text==='Saved note while catalog tail held'&&document.querySelector('#note-status').textContent==='已保存到本机');
 await page.locator('#tab-analysis').click();await page.locator('#question').fill('Saved reading draft while catalog tail held');await page.waitForFunction(()=>__fixture.personal.readingState['synthetic:00000']?.question==='Saved reading draft while catalog tail held');
 await page.evaluate(()=>{holdTail=false;releaseTail();});await page.waitForFunction(()=>document.querySelector('#library-catalog-status').hidden);
 await page.locator('#tab-note').click();await page.locator('#note-editor').fill('Saved note revision two after late catalog');await page.waitForFunction(()=>__fixture.personal.notes['synthetic:00000']?.revision===2);assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='personal.note').at(-1).payload.baseRevision),1);
 await page.locator('[data-view=library]').click();await page.locator('[data-library-open="synthetic:00000"]').click();await page.waitForSelector('#note-pane:not([hidden])');assert.equal(await page.locator('#note-editor').inputValue(),'Saved note revision two after late catalog');await page.locator('#tab-analysis').click();assert.equal(await page.locator('#question').inputValue(),'Saved reading draft while catalog tail held');await page.locator('[data-view=library]').click();
 // Summary and page must describe the same native source, even if the first native calls straddle sync.
 await page.evaluate(()=>{summaryMismatch=true;window.dispatchEvent(new CustomEvent('library.changed'));});await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('目录摘要与列表发生变化'));assert.match(await page.locator('#result-count').innerText(),/10,005/);
 await page.evaluate(()=>{summaryMismatch=false;holdTail=true;releaseTail=undefined;window.dispatchEvent(new CustomEvent('library.changed'));});await page.waitForFunction(()=>typeof releaseTail==='function');
 // Restore replaces the personal workspace while the old source has the SAME public stamp.
 await page.evaluate(()=>{window.oldTailRelease=releaseTail;releaseTail=undefined;__fixture.personal={favorites:['synthetic:00002'],reading:[],notes:{'synthetic:00002':{text:'Explicit isolated restored note',revision:1}},readingState:{},annotations:{},sessions:[]};window.dispatchEvent(new CustomEvent('personal.changed'));});
 await page.waitForFunction(()=>typeof releaseTail==='function');
 await page.evaluate(()=>{catalogReadMode='changed';oldTailRelease();});await page.waitForTimeout(60);assert.match(await page.locator('[role=status]').filter({hasText:'10,000 / 10,005'}).innerText(),/正在读取本机目录/);assert.doesNotMatch(await page.locator('#toast').innerText(),/目录发生变化，请重新读取/);
 await page.evaluate(()=>{catalogReadMode='good';holdTail=false;releaseTail();});await page.waitForFunction(()=>document.querySelector('#toast').textContent==='已重新载入个人资料');
 await page.locator('[data-view=favorites]').click();await page.waitForSelector('[data-library-row="synthetic:00002"]');assert.equal(await page.locator('[data-library-row="synthetic:10004"]').count(),0);assert.equal(await page.locator('[data-library-row]').count(),1);
 await page.locator('[data-view=notes]').click();await page.waitForSelector('#notes-view:not([hidden])');assert.match(await page.locator('#all-notes').innerText(),/Explicit isolated restored note/);
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>__calls.some(c=>/^(model\.(run|check)$|zotero\.(authorize|checkAuthorization|archive|resume)$)/.test(c.command))),false);
 console.log('PASS catalog consumer: 10005 rows across bounded pages, held progress, retained unopened favorite, current-only daily, stamp/summary refusal keeps prior catalog, explicit retry, saved note CAS/reading draft survive late snapshot, same-stamp restore retires old private flight and keeps new flight/notes/favorites; no paid model/accounts');await browser.close();server.close();
})().catch(async error=>{console.error(error);await browser?.close();server.close();process.exitCode=1;});
