/* Real bundled first-use and settings UI with an explicit local bridge fixture.
 * No Keychain, Zotero, WebDAV, model, user profile or remote website is accessed. */
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('playwright');
const {server,installFixture}=require('./DesktopUI.test.cjs');
const rows=[
 {id:'page:/daily/',kind:'daily',title:'往日日更',titleZh:'往日日更',displayDate:'2026-10-24',sourceURL:'https://nanless.github.io/audio-paper-digest-blog/daily/'},
 {id:'page:/conference-task/',kind:'conference',title:'会议专题',sourceURL:'https://nanless.github.io/audio-paper-digest-blog/posts/conference-icml-2026-task-a/'},
 {id:'page:/conference/',kind:'conference',title:'会议总览',sourceURL:'https://nanless.github.io/audio-paper-digest-blog/posts/conference-icml-2026/'},
 {id:'page:/conferences/',kind:'page',title:'会议目录',sourceURL:'https://nanless.github.io/audio-paper-digest-blog/conferences/'}
];
(async()=>{let browser,page;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});page=await browser.newPage({viewport:{width:1080,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await installFixture(page);
 await page.addInitScript(rows=>{const original=webkit.messageHandlers.desktop.postMessage;webkit.messageHandlers.desktop.postMessage=async input=>{
  if(input.command==='app.bootstrap')return {...await original(input),initialView:'today'};
  if(input.command==='aggregates.list'){__calls.push(input);return {records:structuredClone(rows)};}
  if(input.command==='settings.open'){__calls.push(input);return {};}
  return original(input);
 };},rows);
 const url=`http://127.0.0.1:${server.address().port}`;await page.goto(url);await page.waitForSelector('#aggregate-index [data-aggregate-open]');assert.equal(await page.locator('#library-title').innerText(),'日更速递');assert.equal(await page.locator('[data-aggregate-mode=aggregates]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('#aggregate-index').innerText(),/往日日更/);
 assert.deepEqual(await page.locator('[aria-label="网站成果"] [data-view]').evaluateAll(nodes=>nodes.map(n=>n.dataset.view)),['today','library','directions','conference','pages']);
 await page.locator('[data-view=conference]').first().click();assert.deepEqual(await page.locator('[data-aggregate-open]').allTextContents(),['会议目录','会议总览','会议专题']);
 assert.equal(await page.locator('.connection-introduction').isVisible(),true);await page.locator('[data-connect=cloud]').click();await page.locator('[data-connect=zotero]').click();assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.command==='settings.open').map(c=>c.payload)),[{pane:'cloud'},{pane:'zotero'}]);assert.equal(await page.evaluate(()=>__calls.some(c=>/^(model\.|zotero\.|cloud\.)/.test(c.command))),false);
 await page.locator('[data-dismiss-setup]').click();await page.reload();await page.waitForSelector('#aggregate-index [data-aggregate-open]');assert.equal(await page.locator('.connection-introduction').isVisible(),false);console.log('PASS first use: website order, historical daily, conference hierarchy, passive reminder and local dismissal');
 await page.goto(url+'/settings.html');await page.waitForSelector('[data-open-pane=cloud]');await page.locator('[data-open-pane=cloud]').click();assert.match(await page.locator('[data-setting-pane=cloud] h1').innerText(),/WebDAV/);assert.deepEqual(await page.locator('.cloud-connection h2').allTextContents(),['1. 填写账号并保存','2. 安全输入应用密码','3. 检查连接']);assert.equal(await page.locator('.cloud-connection a').getAttribute('href'),'https://www.jianguoyun.com/#/settings/security');assert.equal(await page.locator('[data-setting-pane=cloud] input[type=password]').count(),0);await page.locator('[data-pane=reading]').click();await page.locator('[data-open-pane=zotero]').click();assert.match(await page.locator('.zotero-setup-steps').innerText(),/Mac 无需填写服务器地址或 Web API 密钥/);assert.equal(await page.evaluate(()=>__calls.some(c=>/^(model\.|zotero\.|cloud\.(?!state))/.test(c.command))),false);assert.deepEqual(errors,[]);console.log('PASS setup shortcuts explain independent WebDAV backup and local Zotero with no credential/network probe');
 }finally{await page?.close();await browser?.close();if(server.listening)await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
