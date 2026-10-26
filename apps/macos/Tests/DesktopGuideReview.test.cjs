/* Independent rendering regressions model published HTML structures.
 * Real browser and production renderer; native bridge is explicit isolated fixture.
 * No user GUI, Keychain, model provider, Zotero or private app directory access. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {server,installFixture,primary,repo}=require('./DesktopUI.test.cjs');
const artifacts=process.env.PD_GUIDE_REVIEW_ARTIFACTS||path.join(repo,'apps/macos/.qa/guide-review');
fs.mkdirSync(artifacts,{recursive:true});
const results=[];let browser;
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
async function one(name,html,verify,changes={}){
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const paper={...primary,title:'Explicit original title',titleZh:'明确译题',score:null,...changes};
 await installFixture(page,{papers:[paper],primary:paper,article:{paperID:paper.id,html,markdown:null,revisionSHA256:digest(html),notices:[],sourceVersion:paper.sourceVersion}});
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-library-open]').first().click();
  await page.waitForFunction(()=>document.querySelector('#guide-frame')?.contentDocument?.querySelector('main'));
  const frame=page.frameLocator('#guide-frame');
  await verify(frame,page);assert.deepEqual(errors,[]);
  results.push({name,passed:true});console.log('PASS '+name);
 }catch(e){results.push({name,passed:false,error:e.message});console.error('FAIL '+name+': '+e.message);await page.screenshot({path:path.join(artifacts,'review-'+results.length+'-failure.png')});}
 finally{await page.close();}
}
(async()=>{
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  await one('published exact H2 title + hash anchor removed; first science section retained','<h2 id="title">明确译题<a href="#title">#</a></h2><p>评分：7.5/10，创新 1.5/2，技术严谨 1.2/1.5。</p><h2 id="methods">方法<a href="#methods">#</a></h2><p>科学正文保留。</p>',async f=>{assert.equal(await f.locator('h1').count(),1);assert.deepEqual(await f.locator('h2').allTextContents(),['方法']);assert.equal(await f.locator('h2 a').count(),0);assert.match(await f.locator('main').innerText(),/科学正文保留/);assert.match(await f.locator('main').innerText(),/创新 1.5\/2/);assert.equal((await f.locator('main').innerText()).match(/评分：7.5\/10/g)?.length,1);});
  await one('published exact H3 original title removed','<h3>Explicit original title<a href="#original">#</a></h3><h2>结果</h2><table><tr><td>43.2</td></tr></table>',async f=>{assert.equal(await f.locator('h3').count(),0);assert.equal(await f.locator('table').count(),1);assert.match(await f.locator('table').innerText(),/43.2/);});
  await one('nonexact science heading beginning with paper title is preserved','<h2>明确译题的方法与限制<a href="#limits">#</a></h2><p>不能因包含题名而删节。</p>',async f=>assert.deepEqual(await f.locator('h2').allTextContents(),['明确译题的方法与限制']));
  await one('later exact title section is content and not removed','<p>首段科学内容。</p><h2>明确译题</h2><p>后续内容。</p>',async f=>{assert.deepEqual(await f.locator('h2').allTextContents(),['明确译题']);assert.match(await f.locator('main').innerText(),/首段科学内容/);} );
  await one('only heading local hash permalinks removed; real hash links and C# text retained','<h2>C# 方法<a href="#csharp">#</a><a href="https://example.org/hash">#</a></h2><p><a href="#csharp">#</a> 真实段内跳转。</p>',async f=>{assert.equal(await f.locator('h2 a').count(),1);assert.equal(await f.locator('p a').count(),1);assert.match(await f.locator('h2').innerText(),/C# 方法/);} );
  await one('missing catalog score shown as body reference; actual body score kept','<h2>问题背景</h2><p>评分：8.25/10，创新 1.5/2。</p><h2>评分明细</h2><table><tr><td>8.25</td></tr></table>',async f=>{const text=await f.locator('main').innerText();assert.match(text,/网站评分见正文/);assert.doesNotMatch(text,/条目评分 (?:null|undefined|0)/);assert.match(text,/8.25\/10/);} );
  await one('actual numeric zero remains declared entry zero','<h2>科学内容</h2><p>真实零分并非缺失。</p>',async f=>assert.match(await f.locator('.meta').innerText(),/条目评分 0/),{score:0});
  await one('title H1 cleanup must preserve introductory science and assets before first H2','<h1>明确译题<a href="#title">#</a></h1><p>Introductory scientific finding 73.6%</p><table><tr><td>Intro table 19.2</td></tr></table><h2>方法</h2><p>后续内容。</p>',async f=>{assert.equal(await f.locator('h1').count(),1);assert.match(await f.locator('main').innerText(),/Introductory scientific finding 73.6%/);assert.match(await f.locator('table').innerText(),/19.2/);});
 }finally{
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  const failed=results.filter(r=>!r.passed).length;
  fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({contract:'isolated-render-guide-review-v1',nativeAndServices:'explicit fixtures; no real GUI or providers',sourceSHA256:digest(fs.readFileSync(path.join(repo,'apps/macos/Resources/native.js'))),results,passed:results.length-failed,failed},null,2)+'\n');
  console.log(`Independent guide review: ${results.length-failed} passed; ${failed} failed`);if(failed)process.exitCode=1;
 }
})().catch(e=>{console.error(e);process.exitCode=1});
