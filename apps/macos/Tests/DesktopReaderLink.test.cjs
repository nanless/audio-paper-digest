/* Reader link author regression. Real production frames with explicit native
 * fixtures. The native reader.link event is deliberately injected as a fixture;
 * native WKNavigationDelegate execution is covered by DesktopReaderLinkTests. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {server,installFixture,primary,repo}=require('./DesktopUI.test.cjs');
const output=process.env.PD_READER_LINK_ARTIFACTS||path.join(repo,'apps/macos/.qa/reader-link');fs.mkdirSync(output,{recursive:true});
const hash='01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c';
const source={kind:'selection',paperID:primary.id,pdfSHA:hash,sourceVersion:'2610.27491v1',pages:[5]};
let browser;const results=[];
async function one(name,action,sourceChanges={},text='实际材料的解释 [p.5]'){
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const personal={favorites:[],reading:[],notes:{},annotations:{},readingState:{},sessions:[{id:'explicit-reader-link-fixture',paperID:primary.id,status:'complete',kind:'study',question:'受控引用夹具',text,source:{...source,...sourceChanges},model:'fixture-requested',actualModel:'fixture-reported',charge:'amount_unknown'}]};
 try{
  await installFixture(page,{initialPersonal:personal});await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-library-open="arxiv:2610.27491"]').click();await page.waitForFunction(()=>document.querySelector('#guide-frame')?.contentDocument?.querySelector('main'));await page.locator('#tab-analysis').click();await page.waitForSelector('.session-card iframe');await page.waitForFunction(()=>document.querySelector('.session-card iframe')?.contentDocument?.querySelector('a'));
  await action(page);assert.deepEqual(errors,[]);results.push({name,passed:true});console.log('PASS '+name);
 }catch(e){results.push({name,passed:false,error:e.message});console.error('FAIL '+name+': '+e.message);}finally{await page.close();}
}
async function receipt(page){return page.evaluate(()=>{const href=document.querySelector('.session-card iframe').contentDocument.querySelector('a').getAttribute('href'),url=new URL(href);return {href,token:url.pathname.split('/')[2],linkID:url.pathname.split('/')[3]};});}
async function deliver(page,value){await page.evaluate(detail=>window.dispatchEvent(new CustomEvent('reader.link',{detail})),value);}
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await one('native event fixture resolves exact visible frame, source page and PDF SHA without navigating iframe',async page=>{
  const link=await receipt(page);assert.match(link.href,/^paperapp:\/\/app\/reader-link\/[0-9a-f-]+\/\d+$/);assert.equal(await page.locator('.session-card iframe').getAttribute('sandbox'),'allow-same-origin');
  await deliver(page,link);await page.waitForFunction(()=>__calls.some(c=>c.command==='pdf.locate'));assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.locate').at(-1).payload),{pdfSHA:hash,page:5});assert.equal((await page.locator('.session-card iframe').elementHandle()).asElement()!=null,true);assert.equal(await page.evaluate(()=>document.querySelector('.session-card iframe').contentWindow.location.href),'about:srcdoc');assert.equal(await page.locator('.session-card iframe').evaluate(f=>!!f.contentDocument.querySelector('#app-window')),false);
 });
 await one('unknown frame token and forged link index have zero native actions',async page=>{
  const link=await receipt(page);const before=await page.evaluate(()=>__calls.length);await deliver(page,{token:'00000000-0000-4000-8000-000000000000',linkID:link.linkID});await deliver(page,{token:link.token,linkID:'999999'});assert.equal(await page.evaluate(()=>__calls.length),before);
 });
 await one('citation outside actual supplied pages is refused before PDF open',async page=>{
  await deliver(page,await receipt(page));await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('不在这次实际研究材料'));assert.equal(await page.evaluate(()=>__calls.filter(c=>['pdf.open','pdf.locate'].includes(c.command)).length),0);
 },{},'材料只包含第5页，错误引用 [p.6]');
 await one('wrong source paper is refused before PDF open',async page=>{
  await deliver(page,await receipt(page));await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('所属论文不同'));assert.equal(await page.evaluate(()=>__calls.filter(c=>['pdf.open','pdf.locate'].includes(c.command)).length),0);
 },{paperID:'arxiv:other'});
 for(const [label,change]of [['SHA',{pdfSHA:'a'.repeat(64)}],['version',{sourceVersion:'2610.27491v2'}]])await one('different '+label+' cannot locate current PDF',async page=>{
  await deliver(page,await receipt(page));await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('不同原文版本'));assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.locate').length),0);
 },change);
 await one('hidden and stale frame receipts cannot activate links',async page=>{
  const link=await receipt(page);await page.locator('#tab-guide').click();const before=await page.evaluate(()=>__calls.filter(c=>['pdf.open','pdf.locate','app.external'].includes(c.command)).length);await deliver(page,link);assert.equal(await page.evaluate(()=>__calls.filter(c=>['pdf.open','pdf.locate','app.external'].includes(c.command)).length),before);
  await page.locator('#back').click();await page.locator('[data-library-open]').first().click();await deliver(page,link);assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.locate').length),0);
 });
 await one('archive/export HTML restores original public/internal hrefs and has no ephemeral capabilities',async page=>{
  await page.locator('#tab-guide').click();const exported=await page.evaluate(()=>window.paperDigestArchiveHTML());assert.ok(exported.html.includes('https://arxiv.org/abs/2610.27491v1'));assert.ok(!exported.html.includes('paperapp://app/reader-link/'));
  assert.equal(await page.locator('#guide-frame').evaluate(f=>!!f.contentDocument.querySelector('a[href^="paperapp://app/reader-link/"]')),true);
 });
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));const failed=results.filter(r=>!r.passed).length;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'author real renderer + explicit native event fixture; no user GUI/Keychain/service',sources:Object.fromEntries(['native.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'apps/macos/Resources',name))).digest('hex')])),results,passed:results.length-failed,failed},null,2)+'\n');console.log(`Reader links: ${results.length-failed} passed; ${failed} failed`);if(failed)process.exitCode=1;}})().catch(e=>{console.error(e);process.exitCode=1});
