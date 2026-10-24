/* Actual production settings/main pages with explicit isolated native fixtures.
 * No user profile, GUI, Keychain, live Zotero, model or filesystem archive IO. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {server,repo,installFixture}=require('./DesktopUI.test.cjs');
const {leaf}=require('./NativeDetailsFixture.cjs');
const out=path.join(repo,'apps/macos/.qa/zotero-resume-presentation');fs.mkdirSync(out,{recursive:true});
const ids=['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
const results=[];let browser,base;
async function fresh(){
 const page=await browser.newPage({viewport:{width:780,height:610}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(ids=>{
  const clone=x=>structuredClone(x),settings={appearance:'light',font:18,syncHours:12,endpoint:'https://fixture.invalid/v1',model:'fixture',protocol:'auto',httpProxy:'',maxTokens:8192,dailyRequests:50,reduceMotion:false,hasKey:null,credentialState:'unknown'};
  window.fixture={calls:[],hold:true,holdMaterials:false,fail:false,failMaterials:false,preparations:0,pending:[],pendingMaterials:[],partial:false,archives:ids.map((archiveID,i)=>({archiveID,status:'complete',title:'同名原归档论文夹具',identity:'arxiv:2610.27491v'+(i+1),parentKey:i?'PARENTB2':'PARENTA1',updatedAt:Date.UTC(2026,9,24,2,3,4+i)/1000}))};
  window.webkit={messageHandlers:{desktop:{postMessage:async({command,payload={}})=>{
   fixture.calls.push({command,payload:clone(payload)});
   if(command==='app.bootstrap')return{settings,personal:{},paper:{id:'arxiv:2601.00001',title:'当前另一个论文夹具'}};
   if(command==='zotero.status')return{running:true,version:'10.0.6',writesSupported:true,authorized:fixture.authorized!==false,remember:fixture.authorized!==false,authorizationState:fixture.authorized===false?'unknown':'authorized',archives:clone(fixture.archives)};
   if(command==='zotero.collections')return{collections:[{key:'FOLDER01',name:'界面隔离分类'}]};
   if(command==='zotero.resume'){
    if(fixture.hold)await new Promise(r=>fixture.pending.push(r));
    if(fixture.fail)throw Error('Explicit saved-checkpoint readback failure');
    const record=fixture.archives.find(a=>a.archiveID===payload.resumeID);
    if(!record)throw Error('Unknown saved fixture archive');
    return{archiveID:payload.resumeID,title:record.title,identity:record.identity,status:fixture.partial?'partial':'complete',parentKey:record.parentKey,steps:[{role:'bibliography',verified:true},{role:'pdf',verified:!fixture.partial,error:fixture.partial?'Explicit missing attachment fixture':undefined}]};
   }
   if(command==='archive.materials'){
    fixture.preparations++;if(fixture.holdMaterials)await new Promise(r=>fixture.pendingMaterials.push(r));
    if(fixture.failMaterials)throw Error('Explicit obsolete preparation failure');
    return{identity:'arxiv:2601.00001v3',bibliography:{title:'当前新论文准备夹具'},pdfPath:'/fixture-only/current.pdf',guideHTMLPath:'/fixture-only/current.html',noteHTML:'Explicit saved note fixture',analysisNotice:'没有可归档解析'};
   }
   if(command==='zotero.open')return{};
   throw Error('Unexpected native operation '+command);
  }}}};
 },ids);
 await page.goto(base+'/settings.html');await page.waitForSelector('#zotero-refresh',{state:'attached'});return{page,errors};
}
async function reveal(page){await page.locator('[data-pane=zotero]').click();await page.locator('#zotero-refresh').click();await page.waitForSelector('#zotero-recent button');}
async function saved(page,index=0){await page.locator('#zotero-recent button').nth(index).click();await page.waitForFunction(()=>fixture.calls.some(x=>x.command==='zotero.resume'));}
async function release(page){await page.evaluate(()=>{fixture.hold=false;fixture.pending.shift()();});await page.waitForFunction(()=>!document.querySelector('#zotero-refresh').disabled);}
async function check(name,fn){const{page,errors}=await fresh();try{await fn(page);assert.deepEqual(errors,[]);results.push({name,passed:true});console.log('PASS '+name);}catch(e){results.push({name,passed:false,error:e.message});console.error('FAIL '+name+': '+e.message);await page.screenshot({path:path.join(out,'failure-'+results.length+'.png')});}finally{await page.close();}}
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('same-title saved archives expose true source versions, local saved times and distinct accessible names after real settings reveals',async page=>{
  for(let i=0;i<3;i++){await reveal(page);if(i<2)await page.locator('[data-pane=reading]').click();}
  const labels=await page.locator('#zotero-recent button').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')));assert.notEqual(labels[0],labels[1]);assert(labels[0].includes(ids[0])&&labels[1].includes(ids[1]));
  const rows=await page.locator('#zotero-recent .zotero-pending-row').allTextContents();assert(rows[0].includes('arXiv 2610.27491v1')&&rows[1].includes('arXiv 2610.27491v2'));assert(rows.every(t=>t.includes('2026')&&t.includes('上次保存/核验')));assert(rows.every(t=>!ids.some(id=>t.includes(id))));
  await page.screenshot({path:path.join(out,'settings-saved-archives-780x610.png')});
 });
 await check('saved resume shows only original checkpoint and actions, retaining exact-ID calls and busy guards',async page=>{
  await reveal(page);await saved(page);assert.equal(await page.locator('#archive-dialog h1').innerText(),'核验原归档');assert.equal(await page.locator('#archive-dialog').getAttribute('aria-label'),'核验原归档');assert.match(await page.locator('.dialog-subtitle').innerText(),/原归档保存的论文、材料和目标分类/);
  assert.equal(await page.locator('#archive-title').innerText(),'同名原归档论文夹具');assert.equal(await page.locator('#archive-identity').innerText(),'arxiv:2610.27491v1');assert.match(await page.locator('#zotero-checkpoint').innerText(),/2026/);
  for(const selector of ['.archive-option','.zotero-destination','.archive-connection','#zotero-archive-start','#zotero-dialog-authorize','#zotero-check-saved'])assert.equal(await page.locator(selector).first().isVisible(),false,selector+' must not suggest editable resume scope');
  await page.evaluate(()=>{document.querySelector('#zotero-open-archive').click();document.querySelectorAll('#zotero-recent button')[1].click();});assert.equal(await page.evaluate(()=>fixture.preparations),0);assert.equal(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.resume').length),1);
  await release(page);assert.equal(await page.locator('#zotero-result').innerText(),'原归档已完成本次回读核验。');await page.locator('#zotero-open-item').click();assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.open').map(x=>x.payload)),[{key:'PARENTA1'}]);assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.resume').map(x=>x.payload)),[{resumeID:ids[0]}]);
  assert.equal(await page.locator('#zotero-archive-retry').isVisible(),false);await page.waitForFunction(()=>document.querySelector('#toast').hidden);await page.screenshot({path:path.join(out,'resume-result-780x610.png')});
 });
 await check('resume close then new archive restores original heading, scope controls, target editor and freshly prepared current-paper identity',async page=>{
  await reveal(page);await saved(page);await release(page);await page.keyboard.press('Escape');await page.locator('#zotero-open-archive').click();await page.waitForFunction(()=>fixture.preparations===1&&document.querySelector('#archive-pdf').checked);
  assert.equal(await page.locator('#archive-dialog h1').innerText(),'存入 Zotero');assert.equal(await page.locator('#archive-dialog').getAttribute('aria-label'),'存入 Zotero');assert.match(await page.locator('.dialog-subtitle').innerText(),/保存原文、网站导读与自己的研究/);assert.equal(await page.locator('#archive-title').innerText(),'当前新论文准备夹具');assert.equal(await page.locator('#archive-identity').innerText(),'arxiv:2601.00001v3');
  assert.equal(await page.locator('.archive-option:visible').count(),5);assert.equal(await page.locator('.zotero-destination').isVisible(),true);assert.equal(await page.locator('#zotero-new-collection').isEditable(),true);assert.equal(await page.locator('#archive-pdf').isChecked(),true);assert.equal(await page.locator('#archive-pdf').isEnabled(),true);assert.equal(await page.locator('#archive-analysis').isDisabled(),true);assert.equal(await page.locator('#zotero-checkpoint').isVisible(),false);assert.equal(await page.locator('#zotero-archive-start').isVisible(),true);assert.equal(await page.locator('#zotero-open-item').isVisible(),false);assert.equal(await page.locator('#zotero-archive-retry').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>['zotero.archive','zotero.authorize','zotero.checkAuthorization','model.run','model.check'].includes(x.command))),[]);await page.screenshot({path:path.join(out,'new-after-resume-780x610.png')});
 });
 await check('failure in B offers exact retry without unverified open; real partial B result alone enables opening B',async page=>{
  await reveal(page);await saved(page);await release(page);await page.keyboard.press('Escape');await page.evaluate(()=>{fixture.hold=true;fixture.fail=true;});await page.locator('#zotero-recent button').nth(1).click();await page.waitForFunction(()=>fixture.pending.length===1);assert.equal(await page.locator('#zotero-open-item').isVisible(),false);await release(page);
  assert.match(await page.locator('#zotero-result').innerText(),/saved-checkpoint readback failure/);assert.equal(await page.locator('#zotero-archive-retry').isVisible(),true);assert.equal(await page.locator('#zotero-archive-retry').isEnabled(),true);assert.equal(await page.locator('.zotero-destination').isVisible(),false);assert.equal(await page.locator('#zotero-open-item').isVisible(),false);await page.evaluate(()=>document.querySelector('#zotero-open-item').click());assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.open')),[]);
  await page.evaluate(()=>{fixture.fail=false;fixture.partial=true;});await page.locator('#zotero-archive-retry').click();await page.waitForFunction(()=>fixture.calls.filter(x=>x.command==='zotero.resume').length===3&&!document.querySelector('#zotero-refresh').disabled);assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.resume').map(x=>x.payload)),[{resumeID:ids[0]},{resumeID:ids[1]},{resumeID:ids[1]}]);assert.equal(await page.evaluate(()=>fixture.preparations),0);assert.match(await page.locator('#zotero-steps').innerText(),/尚未完成/);await page.locator('#zotero-open-item').click();assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.open').map(x=>x.payload)),[{key:'PARENTB2'}]);
 });
 await check('closing busy resume cannot reopen it on late completion; subsequent new mode is restored normally',async page=>{
  await reveal(page);await saved(page);await page.keyboard.press('Escape');assert.equal(await page.locator('[data-dialog-surface]').count(),0);await page.locator('#zotero-open-archive').click();assert.equal(await page.evaluate(()=>fixture.preparations),0);await release(page);assert.equal(await page.locator('[data-dialog-surface]').count(),0);await page.locator('#zotero-open-archive').click();await page.waitForFunction(()=>fixture.preparations===1&&document.querySelector('#archive-pdf').checked);assert.equal(await page.locator('#archive-dialog h1').innerText(),'存入 Zotero');
 });
 await check('late failed new preparation cannot overwrite a newer original-archive resume',async page=>{
  await reveal(page);await page.evaluate(()=>{fixture.holdMaterials=true;fixture.failMaterials=true;});await page.locator('#zotero-open-archive').click();await page.waitForFunction(()=>fixture.pendingMaterials.length===1);await page.keyboard.press('Escape');await saved(page);await page.evaluate(()=>fixture.pendingMaterials.shift()());await page.waitForTimeout(50);assert.match(await page.locator('#zotero-result').innerText(),/重读原检查点/);assert.equal(await page.locator('#archive-dialog h1').innerText(),'核验原归档');await release(page);assert.equal(await page.locator('#zotero-result').innerText(),'原归档已完成本次回读核验。');
 });
 await check('failed saved resume can be explicitly retried when passive credential status is still unknown',async page=>{
  await page.evaluate(()=>{fixture.authorized=false;fixture.fail=true;fixture.hold=false;});await reveal(page);await saved(page);await page.waitForFunction(()=>!document.querySelector('#zotero-refresh').disabled&&document.querySelector('#zotero-result').textContent.includes('readback failure'));assert.equal(await page.locator('#zotero-archive-retry').isVisible(),true);assert.equal(await page.locator('#zotero-archive-retry').isEnabled(),true);assert.equal(await page.locator('#zotero-dialog-authorize').isVisible(),false);await page.evaluate(()=>fixture.fail=false);await page.locator('#zotero-archive-retry').click();await page.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('本次回读核验'));assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(x=>x.command==='zotero.resume').map(x=>x.payload)),[{resumeID:ids[0]},{resumeID:ids[0]}]);assert.equal(await page.evaluate(()=>fixture.preparations),0);
 });
 await check('missing timestamp is explicitly unknown, not substituted with current time',async page=>{
  await reveal(page);await page.evaluate(()=>{delete fixture.archives[0].updatedAt;fixture.archives[1].updatedAt='2026-10-24T00:00:00Z';});await page.locator('#zotero-refresh').click();await page.waitForFunction(()=>[...document.querySelectorAll('#zotero-recent small')].every(e=>e.textContent.includes('时间未记录')));assert.equal(await page.locator('#zotero-recent small').count(),2);
 });
 const broken=await leaf(browser,'zotero',{failMaterials:true,archives:[{archiveID:ids[0],status:'complete',title:'原归档独立于坏预览',identity:'arxiv:2601.00001v1',updatedAt:1790000000}]});
 try{
  await broken.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('Explicit current preview materials unavailable'));
  assert.equal(await broken.locator('#zotero-recent [data-zotero-resume]').isVisible(),true);
  assert.equal(await broken.locator('#zotero-archive-start').isDisabled(),true);
  await broken.evaluate(()=>document.querySelector('#zotero-archive-start').click());
  assert.equal(await broken.evaluate(()=>leafFixture.calls.filter(c=>c.command==='zotero.archive').length),0);
  await broken.locator('#zotero-recent [data-zotero-resume]').click();await broken.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('原归档已完成本次回读核验'));
  const calls=await broken.evaluate(()=>leafFixture.calls);
  assert.deepEqual(calls.filter(c=>c.command==='zotero.resume').map(c=>c.payload),[{resumeID:ids[0],presentationID:'native-fixture-owner'}]);
  assert.equal(calls.filter(c=>c.command==='archive.materials').length,1);
  assert.equal(calls.filter(c=>c.command==='zotero.archive'||c.command==='zotero.authorize').length,0);
  assert(calls.findIndex(c=>c.command==='zotero.status')<calls.findIndex(c=>c.command==='archive.materials'));
  results.push({name:'actual native leaf keeps failed preview error and disabled new archive while old checkpoint remains resumable',passed:true});console.log('PASS actual native leaf keeps failed preview error and disabled new archive while old checkpoint remains resumable');
 }catch(e){results.push({name:'actual native leaf keeps failed preview error and disabled new archive while old checkpoint remains resumable',passed:false,error:e.message});console.error(e);}finally{await broken.close();}
 for(const flag of ['failStatus','failCollections']){
  const unavailable=await leaf(browser,'zotero',{[flag]:true});try{
   await unavailable.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('核对内容'));
   assert.equal(await unavailable.locator('#zotero-archive-start').isDisabled(),true);
   await unavailable.evaluate(()=>document.querySelector('#zotero-archive-start').click());
   assert.equal(await unavailable.evaluate(()=>leafFixture.calls.filter(c=>c.command==='zotero.archive'||c.command==='zotero.authorize').length),0);
   results.push({name:'passive '+flag+' cannot grant new archive despite available preview materials',passed:true});console.log('PASS passive '+flag+' cannot grant new archive despite available preview materials');
  }catch(e){results.push({name:'passive '+flag+' cannot grant new archive despite available preview materials',passed:false,error:e.message});console.error(e);}finally{await unavailable.close();}
 }
 const archive={archiveID:ids[0],status:'complete',title:'主窗原归档夹具',identity:'arxiv:2610.27491v1',updatedAt:Date.UTC(2026,9,24)/1000};
 let main=await leaf(browser,'zotero',{archives:[archive]});
 try{
  await main.locator('#zotero-recent [data-zotero-resume]').click();await main.waitForFunction(()=>document.querySelector('#zotero-result').textContent.includes('本次回读核验'));
  assert.equal(await main.locator('.archive-option:visible').count(),0);assert.equal(await main.locator('.zotero-destination').isVisible(),false);
  await main.keyboard.press('Escape');await main.waitForFunction(()=>leafFixture.closed);await main.close();
  main=await leaf(browser,'zotero',{archives:[archive]});await main.waitForFunction(()=>document.querySelector('#archive-pdf').checked);
  assert.equal(await main.locator('#archive-dialog h1').innerText(),'存入 Zotero');assert.equal(await main.locator('.archive-option:visible').count(),5);assert.equal(await main.locator('dialog,[data-dialog-surface]').count(),0);
  results.push({name:'actual native leaf reopens in new mode after original-checkpoint resume',passed:true});console.log('PASS actual native leaf reopens in new mode after original-checkpoint resume');
 }catch(e){results.push({name:'actual native leaf reopens in new mode after original-checkpoint resume',passed:false,error:e.message});console.error(e);}finally{await main.close();}
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));const failed=results.filter(x=>!x.passed).length;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({contract:'actual-settings-main-zotero-resume-presentation-v1',sourceSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'apps/macos/Resources/zotero-ui.js'))).digest('hex'),services:'explicit fixtures only',passed:results.length-failed,failed,results},null,2)+'\n');console.log(`${results.length-failed} passed; ${failed} failed`);if(failed)process.exitCode=1;}})().catch(e=>{console.error(e);process.exitCode=1});
