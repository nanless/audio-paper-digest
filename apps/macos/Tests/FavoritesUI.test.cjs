const {chromium}=require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
let browser;
const root=path.resolve(__dirname,'../Resources');
const server=http.createServer((req,res)=>{const name=decodeURIComponent(req.url.split('?')[0]);if(name==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end('');}const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
 const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:'Asia/Shanghai'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{
  const papers=Array.from({length:6},(_,i)=>({id:'paper:'+i,title:'论文 '+i,sourceKind:'arxiv',date:'2026-01-0'+(6-i),authors:[]}));
  const date=new Date(),yesterday=new Date(date);yesterday.setDate(date.getDate()-1);const old=new Date(date);old.setMonth(date.getMonth()-2);
  const firstFolder='00000000-0000-4000-8000-000000000001';
  let personal={favorites:['paper:0','paper:1','paper:2','paper:3'],reading:[],favoriteCollections:{version:1,revision:4,folders:[{id:firstFolder,name:'语音',createdAt:old.toISOString()}],items:{'paper:0':{addedAt:old.toISOString(),folderIDs:[]},'paper:1':{addedAt:null,folderIDs:[]},'paper:2':{addedAt:yesterday.toISOString(),folderIDs:[firstFolder]},'paper:3':{addedAt:date.toISOString(),folderIDs:[]},'orphan':{addedAt:date.toISOString(),folderIDs:[firstFolder]}}}};
  window.uiApp={state:{view:'favorites',catalog:papers,summary:{paperCount:papers.length},personal:structuredClone(personal)},events:[],conflict:false,
   async call(command,payload={}){this.events.push({command,payload});if(command==='personal.snapshot')return structuredClone(personal);
    if(command==='library.search'||command==='personal.search')return {ids:[]};
    if(command==='personal.favorite.edit'){
     if(this.holdFavoriteEdit)await new Promise(resolve=>this.releaseFavoriteEdit=resolve);
     if(this.conflict){this.conflict=false;personal.favoriteCollections.revision++;throw Error('收藏分类已在其他视图更新，请重新载入；当前选择仍保留');}
     const m=personal.favoriteCollections;if(payload.expectedRevision!==m.revision)throw Error('收藏分类已在其他视图更新，请重新载入；当前选择仍保留');
     if(payload.action==='folder.create')m.folders.push({id:'00000000-0000-4000-8000-000000000002',name:payload.name.trim(),createdAt:new Date().toISOString()});
     if(payload.action==='folder.rename')m.folders.find(f=>f.id===payload.folderID).name=payload.name.trim();
     if(payload.action==='folder.delete'){m.folders=m.folders.filter(f=>f.id!==payload.folderID);Object.values(m.items).forEach(i=>i.folderIDs=i.folderIDs.filter(id=>id!==payload.folderID));}
     if(payload.action==='items.assign')for(const id of payload.ids){const item=m.items[id]||{addedAt:null,folderIDs:[]};item.folderIDs=payload.mode==='replace'?payload.folderIDs:payload.mode==='remove'?item.folderIDs.filter(f=>!payload.folderIDs.includes(f)):[...new Set([...item.folderIDs,...payload.folderIDs])];m.items[id]=item;}
     m.revision++;return structuredClone(personal);
    }
    if(command==='personal.list.edit'){const set=new Set(personal[payload.key]);payload.ids.forEach(id=>payload.action==='remove'?set.delete(id):set.add(id));personal[payload.key]=[...set];return structuredClone(personal);}
    throw Error('Unknown '+command);
   },toast(t){this.events.push({toast:t});},error(e){throw e;},openPaper(){}
  };
  window.uiPersonal=()=>personal;const{mountLibrary}=await import('/library-ui.js');window.uiLibrary=mountLibrary(uiApp);document.querySelector('#reader-view').hidden=true;document.querySelector('#library-view').hidden=false;await uiLibrary.render();
 });
 const sectionChecks=await page.evaluate(async()=>{const{favoriteSection}=await import('/favorites-ui.js');const now=new Date(2026,2,8,12),tomorrow=new Date(2026,2,9,0);return [favoriteSection(tomorrow,'relative',now),favoriteSection(tomorrow,'month',now),favoriteSection(new Date(2026,2,8,1),'relative',now),favoriteSection(new Date(2026,2,2,23),'relative',now),favoriteSection(new Date(2026,2,1,23),'relative',now)];});assert.deepEqual(sectionChecks,['较晚日期（请检查设备时间）','较晚日期（请检查设备时间）','今天收藏','近 7 天收藏','更早收藏']);
 await page.setViewportSize({width:1000,height:700});
 const firstTitle=await page.locator('[data-library-row] .paper-row-title').first().boundingBox();assert(firstTitle.y<440,'personal tools must leave room for reading rows');
 assert.match(await page.locator('#library-subtitle').innerText(),/^4 篇收藏 · 1 篇收藏时间未知$/);assert.equal(await page.locator('#favorite-time-help').getAttribute('open'),null);
 for(const id of ['favorite-folder-filter','favorite-grouping','favorite-manage-toggle']){assert.equal(await page.locator('#'+id).isVisible(),true);const rect=await page.locator('#'+id).boundingBox();assert(rect.y+rect.height<350);}
 const rows=()=>page.locator('#paper-rows tr[data-library-row]');
 assert.deepEqual(await rows().evaluateAll(els=>els.map(e=>e.dataset.libraryRow)),['paper:3','paper:2','paper:0','paper:1']);
 assert.match(await page.locator('#paper-rows').innerText(),/今天收藏[\s\S]*近 7 天收藏[\s\S]*更早收藏[\s\S]*收藏时间未知/);
 assert.match(await rows().last().innerText(),/收藏时间：未知（旧版未记录）/);
 if(process.env.PD_QA_SCREENSHOT_DIR){fs.mkdirSync(process.env.PD_QA_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PD_QA_SCREENSHOT_DIR,'favorites-time-sections.png'),fullPage:true});}
 await page.locator('#favorite-folder-filter').selectOption('uncategorized');assert.equal(await rows().count(),3);
 await page.locator('#favorite-folder-filter').selectOption('00000000-0000-4000-8000-000000000001');assert.equal(await rows().count(),1);
 assert.equal(await rows().first().getAttribute('data-library-row'),'paper:2');
 await page.locator('#favorite-grouping').selectOption('month');assert.match(await page.locator('.favorite-section').first().innerText(),/年 .* 月/);
 await page.locator('#favorite-manage-toggle').click();await page.locator('#favorite-folder-name').fill('声学');await page.locator('#favorite-folder-create').click();await page.waitForFunction(()=>uiPersonal().favoriteCollections.folders.length===2);
 await page.locator('#favorite-folder-filter').selectOption('');
 await page.locator('[data-library-select="paper:3"]').check();await page.locator('[data-library-select="paper:1"]').check();await page.locator('#library-selection-classify').click();
 await page.locator('#favorite-folder-checks input[value="00000000-0000-4000-8000-000000000002"]').check();
 const draftRevision=await page.evaluate(()=>uiPersonal().favoriteCollections.revision);
 await page.evaluate(async()=>{uiPersonal().favoriteCollections.revision++;uiApp.state.personal=structuredClone(uiPersonal());await uiLibrary.render();});await page.locator('#favorite-assign-save').click();await page.waitForFunction(()=>!document.querySelector('#favorite-error').hidden);
 assert.equal(await page.evaluate(()=>uiApp.events.filter(e=>e.command==='personal.favorite.edit').at(-1).payload.expectedRevision),draftRevision);
 assert.match(await page.locator('#favorite-error').innerText(),/其他视图更新/);assert.equal(await page.locator('#favorite-folder-checks input:checked').count(),1);assert.equal(await page.locator('[data-library-select]:checked').count(),2);
 await page.locator('#favorite-reload').click();assert.equal(await page.locator('#favorite-folder-checks input:checked').count(),1);await page.evaluate(()=>uiApp.holdFavoriteEdit=true);await page.locator('#favorite-assign-save').click();await page.waitForFunction(()=>typeof uiApp.releaseFavoriteEdit==='function');assert.equal(await page.locator('#favorite-folder-checks input').first().isDisabled(),true);assert.equal(await page.locator('#favorite-assign-save').isDisabled(),true);await page.evaluate(()=>{uiApp.holdFavoriteEdit=false;uiApp.releaseFavoriteEdit();});await page.waitForFunction(()=>document.querySelector('#favorite-assign').hidden);
 assert.equal(await page.evaluate(()=>uiPersonal().favoriteCollections.items['paper:1'].addedAt),null);
 assert.deepEqual(await page.evaluate(()=>uiPersonal().favoriteCollections.items['paper:1'].folderIDs),['00000000-0000-4000-8000-000000000002']);
 await page.locator('#favorite-folder-filter').selectOption('00000000-0000-4000-8000-000000000002');assert.equal(await rows().count(),2);
 await page.locator('#favorite-folder-name').fill('声学专题');await page.locator('#favorite-folder-rename').click();await page.waitForFunction(()=>uiPersonal().favoriteCollections.folders.some(f=>f.name==='声学专题'));
 const favoritesBefore=await page.evaluate(()=>[...uiPersonal().favorites]);await page.locator('#favorite-folder-delete').click();await page.waitForFunction(()=>uiPersonal().favoriteCollections.folders.length===1);assert.deepEqual(await page.evaluate(()=>uiPersonal().favorites),favoritesBefore);
 // A successful keyboard save returns to its stable list trigger; late acknowledgements never borrow another focus owner.
 if(await page.locator('#favorite-manager').isVisible())await page.locator('#favorite-manage-toggle').click();
 async function beginFocusedSave(){await page.locator('#library-selection-classify').click();await page.locator('#favorite-folder-checks input').first().check();await page.locator('#favorite-assign-save').focus();await page.evaluate(()=>{uiApp.holdFavoriteEdit=true;uiApp.releaseFavoriteEdit=null;});await page.keyboard.press('Space');await page.waitForFunction(()=>typeof uiApp.releaseFavoriteEdit==='function');}
 async function finishFocusedSave(){await page.evaluate(()=>{uiApp.holdFavoriteEdit=false;uiApp.releaseFavoriteEdit();});await page.waitForFunction(()=>!document.querySelector('#favorite-assign-save').disabled);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 await beginFocusedSave();await finishFocusedSave();assert.equal(await page.locator('#favorite-assign').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'library-selection-classify');
 await beginFocusedSave();await page.locator('#sort').focus();await finishFocusedSave();assert.equal(await page.evaluate(()=>document.activeElement.id),'sort');
 await beginFocusedSave();await page.locator('#sort').focus();await page.locator('#sort').evaluate(el=>el.blur());await finishFocusedSave();assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
 await beginFocusedSave();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await finishFocusedSave();assert.notEqual(await page.evaluate(()=>document.activeElement.id),'library-selection-classify');
 await beginFocusedSave();const reopenedDraftRevision=await page.evaluate(()=>uiPersonal().favoriteCollections.revision);await page.locator('#library-selection-classify').click();await finishFocusedSave();assert.equal(await page.locator('#favorite-assign').isVisible(),true,'late old ACK must not close the newly opened editor');await page.locator('#favorite-assign-save').click();await page.waitForFunction(()=>!document.querySelector('#favorite-error').hidden);assert.equal(await page.evaluate(()=>uiApp.events.filter(e=>e.command==='personal.favorite.edit').at(-1).payload.expectedRevision),reopenedDraftRevision,'late ACK must not silently rebase the new draft');await page.locator('#favorite-assign-cancel').click();
 await page.locator('#library-selection-classify').click();await page.locator('#favorite-folder-checks input').first().check();await page.locator('#sort').focus();await page.evaluate(()=>{uiApp.holdFavoriteEdit=true;uiApp.releaseFavoriteEdit=null;document.querySelector('#favorite-assign-save').click();});await page.waitForFunction(()=>typeof uiApp.releaseFavoriteEdit==='function');await finishFocusedSave();assert.equal(await page.evaluate(()=>document.activeElement.id),'sort','semantic save without focus ownership must not take another control focus');
 await beginFocusedSave();await page.evaluate(async()=>{uiApp.state.view='reading-list';await uiLibrary.render();});await page.locator('[data-view="reading-list"]').focus();await finishFocusedSave();assert.equal(await page.evaluate(()=>document.activeElement.dataset.view),'reading-list');assert.equal(await page.locator('#favorite-assign').isVisible(),false);await page.evaluate(async()=>{uiApp.state.view='favorites';await uiLibrary.render();});
 await beginFocusedSave();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('personal.changed')));await page.locator('#sort').focus();await finishFocusedSave();assert.equal(await page.evaluate(()=>document.activeElement.id),'sort');assert.equal(await page.locator('#favorite-assign').isVisible(),false);
 // Native metadata edits keep the second page and its selected paper; only explicit filter/group changes reset it.
 await page.evaluate(async()=>{const added=Array.from({length:210},(_,i)=>({id:'bulk:'+String(i).padStart(3,'0'),title:'明确合成的多页收藏 '+i,sourceKind:'arxiv',date:'2026-01-01',authors:[]}));uiApp.state.catalog.push(...added);uiPersonal().favorites.push(...added.map(p=>p.id));uiApp.state.personal=structuredClone(uiPersonal());await uiLibrary.render();});
 await page.locator('#library-next').click();await page.locator('[data-library-select]').first().check();const secondPageID=await page.locator('[data-library-select]:checked').first().getAttribute('data-library-select');assert.match(await page.locator('#library-page-label').innerText(),/^2 \/ /);
 await beginFocusedSave();await finishFocusedSave();assert.match(await page.locator('#library-page-label').innerText(),/^2 \/ /);assert.equal(await page.locator('[data-library-select]:checked').first().getAttribute('data-library-select'),secondPageID);assert.equal(await page.evaluate(()=>document.activeElement.id),'library-selection-classify');
 await page.locator('#favorite-grouping').selectOption('relative');assert.match(await page.locator('#library-page-label').innerText(),/^1 \/ /);
 await page.evaluate(async()=>{uiApp.state.personal.favoriteCollections={version:2,opaque:{}};await uiLibrary.render();});assert.equal(await page.locator('#library-selection-favorite').isDisabled(),true);assert.equal(await page.locator('#favorite-manage-toggle').isDisabled(),true);assert.match(await page.locator('#favorite-guidance').innerText(),/升级工作台/);
 assert.equal(await page.evaluate(()=>uiApp.events.some(e=>e.command==='personal.setList')),false);assert.deepEqual(errors,[]);
 await page.setViewportSize({width:1000,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log('PASS Favorites UI: true timestamp order, unknown legacy, local calendar/month sections, category filter, multi-classification, CAS draft preservation/reload, delete preserves membership, future read-only, native delta, compact width, guarded keyboard focus return, no late-view/draft focus theft, second-page classification continuity');
 await browser.close();server.close();
})().catch(async error=>{console.error(error);await browser?.close();server.close();process.exitCode=1;});
