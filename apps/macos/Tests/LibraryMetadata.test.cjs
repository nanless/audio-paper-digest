const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../Resources');
const candidate=process.env.PD_LIBRARY_CANDIDATE;
const server=http.createServer((req,res)=>{
 const url=decodeURIComponent(req.url.split('?')[0]);
 if(url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end('');}
 const file=url==='/library-ui.js'&&candidate?path.resolve(candidate):path.resolve(root,'.'+(url==='/'?'/index.html':url));
 if(!(file.startsWith(root+path.sep)||candidate&&file===path.resolve(candidate))){res.writeHead(403);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1080,height:700}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async()=>{
   const rows=[{id:'arxiv:2610.27491',title:'MiCLA',titleZh:'真实长标题：用混合到成分的残差对齐学习复调音频表示',authors:['Kohei Yamamoto','Kosuke Okusa','第三作者'],task:'音频分类',method:'对比学习',tags:['自监督学习','<img src=x onerror=window.evil=1>'],sourceKind:'arxiv',date:'2026-10-21',score:7.5},{id:'conference:unknown',title:'未知资料',authors:[],tags:[],sourceKind:'constructor',score:null},{id:'local:own',title:'本地原件',authors:['研究者'],sourceKind:'local',method:'<script>window.evil=2</script>',tags:['同名','同名',''],score:0}];
   window.subject={state:{view:'library',catalog:rows,summary:{paperCount:3,recordCount:3},personal:{favorites:[],reading:[]}},events:[],call:async function(command,payload){this.events.push({command,payload});if(command==='personal.snapshot')return structuredClone(this.state.personal);if(command==='personal.setList'){this.state.personal[payload.key]=payload.ids;return structuredClone(this.state.personal);}throw new Error('Unexpected '+command);},openPaper(p){this.events.push({open:p.id});},toast(){},error(e){throw e;}};
   const {mountLibrary}=await import('/library-ui.js');window.lib=mountLibrary(subject);document.querySelector('#reader-view').hidden=true;document.querySelector('#library-view').hidden=false;await lib.render();
  });
  const row=page.locator('[data-library-row="arxiv:2610.27491"]'),detail=row.locator('details.library-paper-details');
  assert.equal(await detail.count(),1,'library must expose original source, method and tags within the actual list');
  assert.equal(await detail.getAttribute('open'),null);
  assert.match(await detail.locator('summary').innerText(),/arXiv/);assert.match(await detail.locator('summary').innerText(),/对比学习/);
  await detail.locator('summary').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-library-row="arxiv:2610.27491"] details').open);
  assert.match(await detail.innerText(),/第三作者/);assert.match(await detail.innerText(),/自监督学习/);assert.match(await detail.innerText(),/arxiv:2610\.27491/);
  assert.match(await detail.innerText(),/<img src=x onerror=window.evil=1>/);assert.equal(await detail.locator('img,script').count(),0);assert.equal(await page.evaluate(()=>window.evil),undefined);
  assert.equal(await page.evaluate(()=>subject.events.length),0,'metadata does not open a paper, fetch, persist or request a model');
  await row.locator('[data-library-select]').check();await page.waitForFunction(()=>document.querySelector('#library-selection-count').textContent.includes('1'));
  const afterSelect=row.locator('details');assert.equal(await afterSelect.getAttribute('open'),'','selection preserves the expanded original row metadata');await afterSelect.locator('summary').click();assert.equal(await row.locator('[data-library-select]').isChecked(),true);
  assert.equal(await page.evaluate(()=>subject.events.length),0);
  const unknown=page.locator('[data-library-row="conference:unknown"] details');await unknown.locator('summary').click();assert.match(await unknown.innerText(),/待核验来源/);assert.match(await unknown.innerText(),/未提供方法/);assert.match(await unknown.innerText(),/未提供标签/);assert.match(await unknown.innerText(),/未提供作者/);
  const local=page.locator('[data-library-row="local:own"] details');await local.locator('summary').click();assert.match(await local.innerText(),/本地 PDF/);assert.equal(await local.locator('script').count(),0);assert.equal(await page.evaluate(()=>window.evil),undefined);
  assert.match(await page.locator('[data-library-row="local:own"] .numeric').innerText(),/^0\.0$/,'zero published score is retained');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'minimum Mac width has no page overflow');
  for(const appearance of ['light','dark']){await page.emulateMedia({colorScheme:appearance});if(process.env.PD_QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PD_QA_SCREENSHOT_DIR,`minimum-${appearance}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);console.log('PASS original list metadata, keyboard disclosure, escaping, unknowns, original zero score, no side effects, selection ownership, minimum width, light/dark');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
