'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const mac=process.env.PD_STARTUP_MAC||path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture,fixture,primary}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const sourcePath=process.env.PD_STARTUP_RUNTIME||path.join(mac,'Resources/native.js');
const runtime=fs.readFileSync(sourcePath,'utf8'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const secondary=fixture.papers.find(p=>p.id!==primary.id);assert.ok(secondary&&secondary.titleZh);
const inputs=[__filename,sourcePath,path.join(mac,'Tests/DesktopUI.test.cjs')];
const before=Object.fromEntries(inputs.map(p=>[p,sha(fs.readFileSync(p))]));
const result=[];let browser;
const personal=readingState=>({favorites:[],reading:[],notes:{},sessions:[],readingState,annotations:{},personalPapers:{}});
const history=id=>({[id]:{mode:'guide',pdfOpen:false,updatedAt:'2026-10-24T12:00:00Z'}});
async function check(name,initial,expected){
 const p=await browser.newPage({viewport:{width:1280,height:800}});
 try{
  await p.route('**/native.js',r=>r.fulfill({contentType:'text/javascript',body:runtime}));
  await installFixture(p,initial);await p.goto(`http://127.0.0.1:${server.address().port}`);
  await p.waitForSelector('[data-library-open]');
  // These are public metadata plus a controlled startup history. This is not native/PDF/source authentication.
  assert.equal(await p.locator('#sidebar-paper').innerText(),expected?.titleZh||expected?.title||'选择论文开始阅读');
  assert.equal(await p.evaluate(()=>__calls.filter(c=>['app.setPaper','library.article','pdf.open'].includes(c.command)).length),0);
  await p.locator('[data-view="reader"]').first().click();
  if(expected){
   await p.waitForFunction(id=>__fixture.selected?.id===id,expected.id);
   await p.waitForSelector('#reader-view:not([hidden])');
   assert.equal(await p.evaluate(()=>__fixture.selected.id),expected.id);
   assert.equal(await p.locator('#sidebar-paper').innerText(),expected.titleZh||expected.title);
  }else{
   await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await p.evaluate(()=>__fixture.selected),null);
   assert.equal(await p.evaluate(()=>__calls.filter(c=>['app.setPaper','library.article','pdf.open'].includes(c.command)).length),0);
   assert.equal(await p.locator('#library-view').isVisible(),true);
  }
  assert.equal(await p.evaluate(()=>__calls.some(c=>['model.run','model.check','zotero.archive','zotero.resume','zotero.authorize'].includes(c.command))),false);
  result.push({name,passed:true});console.log('PASS '+name);
 }catch(e){result.push({name,passed:false,error:e.message});console.error('FAIL '+name+': '+e.message);}finally{await p.close();}
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('empty history never invents a current paper or opens a demonstration default',{initialPersonal:personal({})},null);
 const two=personal({...history(primary.id),...history(secondary.id)});two.readingState[primary.id].updatedAt='2026-01-01T00:00:00Z';
 await check('newest actual history supplies both sidebar label and Continue Reading target',{initialPersonal:two},secondary);
 const retained=personal(history(secondary.id));retained.personalPapers[secondary.id]=secondary;
 await check('retained personal metadata restores recent paper absent from current website catalog',{initialPersonal:retained,papers:fixture.papers.filter(p=>p.id!==secondary.id)},secondary);
 await check('missing recent metadata never falls back to an unrelated demonstration paper',{initialPersonal:personal(history('arxiv:2510.12345'))},null);
 await check('the previous demonstration paper remains valid when it is the actual recent paper',{initialPersonal:personal(history(primary.id))},primary);
 }finally{
 await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
 const inputsChanged=inputs.filter(p=>sha(fs.readFileSync(p))!==before[p]);const passed=result.length===5&&result.every(r=>r.passed)&&!inputsChanged.length;
 if(process.env.PD_STARTUP_RESULT)fs.writeFileSync(process.env.PD_STARTUP_RESULT,JSON.stringify({scope:'Controlled browser startup-history regression; real public paper metadata, explicit native/PDF fixtures, no private profile/credentials/network/provider',inputs:before,inputsChanged,result,passed},null,2));
 console.log(`Startup resume: ${result.filter(x=>x.passed).length}/5 passed`);if(!passed)process.exitCode=1;
 }})().catch(e=>{console.error(e);process.exitCode=1;});
