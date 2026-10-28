/* Isolated browser integration: real public seed + real UI; native/PDFKit/network are explicit fixtures.
 * Does not access personal data, Keychain, Zotero, model endpoints, or user browser windows. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const {chromium} = require('playwright');
const repo = path.resolve(__dirname, '../../..'), resources = path.join(repo,'apps/macos/Resources');
const sample = JSON.parse(fs.readFileSync(path.join(repo,'prototypes/macos-research/sample.json'),'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
let markdown = sample.articleMarkdown;
for (const figure of sample.figures) {
  const bytes = fs.readFileSync(path.join(repo,'prototypes/macos-research/assets',figure.src));
  assert.equal(digest(bytes),figure.sha256, 'Real scientific image SHA');
  markdown = markdown.replaceAll('('+figure.src+')','(data:image/png;base64,'+bytes.toString('base64')+')');
}
const papers = sample.librarySample.map(p=>({...p,id:'arxiv:'+p.id,authors:p.authors.map(a=>a.name),sourceKind:'arxiv',sourceVersion:p.absUrl.split('/').at(-1),blogURL:p.blogUrl,sourceURL:p.absUrl}));
const primary = papers.find(p=>p.id==='arxiv:2610.27491');
const revision = digest(markdown);
const article = {paperID:primary.id,markdown,html:'',revisionSHA256:revision,completeOffline:true,resources:[],notices:[]};
const settings = {appearance:'light',font:18,endpoint:'https://fixture.invalid/v1',model:'fixture-model',protocol:'auto',maxTokens:8192,dailyRequests:50,syncHours:12,httpProxy:'',reduceMotion:false,hasKey:false};
const fixture = {papers,primary,article,settings};
const server = http.createServer((req,res)=>{
  let name; try {name=decodeURIComponent(req.url.split('?')[0]);} catch {res.writeHead(400);return res.end();}
  let base = resources, relative = name==='/'?'index.html':name.slice(1);
  if (name.startsWith('/vendor/katex/')) {base=path.join(repo,'apps/macos/node_modules/katex/dist');relative=name.slice('/vendor/katex/'.length);}
  else if (name.startsWith('/vendor/')) {base=path.join(repo,'prototypes/macos-research/vendor');relative=name.slice('/vendor/'.length);}
  const file = path.resolve(base,relative);
  if (!file.startsWith(base+path.sep)) {res.writeHead(403);return res.end();}
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(fs.readFileSync(file));}
  catch {res.writeHead(404);res.end();}
});
async function installFixture(page) {
  await page.addInitScript(f=>{
    if (window.top!==window) return;
    const copy=x=>structuredClone(x);
    window.__calls=[];window.__unimplemented=[];window.__fixture={...f,personal:{favorites:[],reading:[],notes:{},sessions:[],readingState:{}},selected:null,failSettings:false,failNote:false,holdArticle:false,releaseArticle:null};
    window.webkit={messageHandlers:{desktop:{postMessage:async({command,payload={}})=>{
      const b=window.__fixture;window.__calls.push({command,payload:copy(payload)});
      switch(command) {
        case 'app.bootstrap':return copy({personal:b.personal,settings:b.settings,paper:b.selected,library:{paperCount:b.papers.length,recordCount:b.papers.length}});
        case 'library.status':return {paperCount:b.papers.length,recordCount:b.papers.length};
        case 'library.list':return copy({papers:b.papers});
        case 'library.search':case 'personal.search':return {ids:[]};
        case 'app.setPaper':b.selected=copy(payload);return {};
        case 'library.article':if(b.holdArticle)await new Promise(r=>b.releaseArticle=r);return copy(payload.paperID===b.primary.id?b.article:{...b.article,paperID:payload.paperID,revisionSHA256:'fixture-second-revision',markdown:'# Fixture secondary document\n\n## Isolated transition fixture\n\nNo paper analysis is claimed.'});
        case 'personal.annotations':return {annotations:b.annotations||[]};
        case 'pdf.highlight':b.annotations=[{id:'fixture-annotation',page:5,text:'Explicit PDF selection fixture',pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'}];return {};
        case 'pdf.removeAnnotation':b.annotations=[];return {};
        case 'personal.snapshot':return copy(b.personal);
        case 'personal.note':if(b.failNote)throw Error('Fixture note disk failure');b.personal.notes[payload.paperID]={text:payload.text,revision:payload.baseRevision+1};return copy(b.personal.notes[payload.paperID]);
        case 'personal.reading':b.personal.readingState[payload.paperID]=copy(payload);return {};
        case 'personal.setList':b.personal[payload.key]=payload.ids;return copy(b.personal);
        case 'pdf.open':return {page:1,pageCount:13,scale:1,version:'2610.27491v1',sha256:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'};
        case 'pdf.selection':return copy(b.selection||{});
        case 'pdf.locate':if(payload.pdfSHA!=='01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'||payload.page<1||payload.page>13)throw Error('Fixture PDF identity mismatch');return {page:payload.page,pageCount:13,scale:1,version:'2610.27491v1',sha256:payload.pdfSHA};
        case 'pdf.page':return {page:payload.page,pageCount:13,scale:1,version:'2610.27491v1'};
        case 'pdf.outline':return {chapters:[]};
        case 'pdf.close':case 'pdf.frame':case 'app.external':return {};
        case 'settings.save':if(b.failSettings)throw Error('Fixture settings disk failure');Object.assign(b.settings,payload);return copy(b.settings);
        case 'zotero.status':return {running:true,version:'10.0.6',writesSupported:true,authorized:false,remember:false,archives:[]};
        case 'zotero.collections':return [];
        case 'jobs.list':return {jobs:[]};
        case 'model.run':b.personal.sessions.push({id:'fixture-failure',paperID:b.selected.id,kind:'study',question:payload.question,status:'failed',text:'',response:'',error:{message:'Fixture upstream quota failure',code:'quota'},model:'requested-fixture-model',actualModel:'actual-fixture-model',charge:'amount_unknown',source:{kind:'guide'},startedAt:'2026-10-24T10:00:00Z'});throw Error('Fixture upstream quota failure');
        case 'model.check':throw Error('Fixture connection failure; no complete response');
        default:window.__unimplemented.push(command);throw Error('Unimplemented isolated fixture command '+command);
      }
    }}}};
  },fixture);
}
const artifacts=process.env.PD_DESKTOP_TEST_ARTIFACTS||path.join(require('node:os').tmpdir(),'paper-digest-desktop-ui-review');fs.mkdirSync(artifacts,{recursive:true});
const failures=[];let passed=0;
async function check(name,fn) {try {await fn();passed++;console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}}
let browser;
(async()=>{
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(10000);await installFixture(page);await page.goto(base);
  await page.waitForSelector('[data-library-open="arxiv:2610.27491"]');
  const open=async id=>{await page.locator('#back').click();await page.locator(`[data-library-open="${id}"]`).click();await page.waitForFunction(id=>paperDigestArchiveHTML()?.paperID===id,id);};
  await page.locator('[data-library-open="arxiv:2610.27491"]').click();await page.waitForFunction(()=>paperDigestArchiveHTML()?.paperID==='arxiv:2610.27491');
  await check('PDF footer uses current-page native text status and rejects a different paper update',async()=>{
   for(const [status,label]of [['available','本页可提取文字'],['empty','本页未提取到文字 · 无 OCR，可继续阅读原件'],['unknown','当前页文字状态未检查']]){
    await page.evaluate(({paperID,status})=>window.dispatchEvent(new CustomEvent('pdf.changed',{detail:{paperID,page:2,pageCount:3,scale:1,pageTextStatus:status}})),{paperID:primary.id,status});
    assert.equal(await page.locator('#pdf-text-status').innerText(),label);
   }
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pdf.changed',{detail:{paperID:'different-owner',page:1,pageCount:1,pageTextStatus:'available'}})));
   assert.equal(await page.locator('#pdf-text-status').innerText(),'当前页文字状态未检查');
  });
  const nativeScale={paperID:primary.id,sha256:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c',contextGeneration:41,page:5,pageCount:13,scale:1,pageTextStatus:'available'};
  await page.locator('#pdf-toggle').click();
  await page.evaluate(d=>window.dispatchEvent(new CustomEvent('pdf.changed',{detail:d})),nativeScale);
  const scaleEvent=async d=>page.evaluate(d=>window.dispatchEvent(new CustomEvent('pdf.scaleChanged',{detail:d})),d);
  await check('owned PDF scale updates only scale, retaining current page and source status',async()=>{
   await scaleEvent({...nativeScale,scale:1.27,page:1,pageTextStatus:'empty'});
   assert.equal(await page.locator('#pdf-zoom').innerText(),'127%');assert.equal(await page.locator('#pdf-page').inputValue(),'5');assert.equal(await page.locator('#pdf-text-status').innerText(),'本页可提取文字');
  });
  await check('foreign SHA, paper, old or future native generation and invalid scale cannot change toolbar',async()=>{
   for(const patch of [{paperID:'different-owner'},{sha256:'different-pdf'},{contextGeneration:40},{contextGeneration:42},{scale:0},{scale:-1},{scale:NaN},{scale:Infinity}])await scaleEvent({...nativeScale,scale:0.3,...patch});
   assert.equal(await page.locator('#pdf-zoom').innerText(),'127%');
  });
  await page.locator('#pdf-toggle').click();
  await check('closed PDF rejects a late scale event',async()=>{await scaleEvent({...nativeScale,scale:0.4});assert.equal(await page.locator('#pdf-zoom').innerText(),'127%');});
  await open(papers[1].id);await open(primary.id);await page.locator('#pdf-toggle').click();
  await page.evaluate(d=>window.dispatchEvent(new CustomEvent('pdf.changed',{detail:{...d,contextGeneration:43,scale:0.91}})),nativeScale);
  await check('same-paper leave and reopen rejects earlier native generation but accepts fresh scale',async()=>{
   await scaleEvent({...nativeScale,scale:0.2});assert.equal(await page.locator('#pdf-zoom').innerText(),'91%');
   await scaleEvent({...nativeScale,contextGeneration:43,scale:0.77});assert.equal(await page.locator('#pdf-zoom').innerText(),'77%');
  });
  await page.locator('#pdf-toggle').click();
  // Native reply has already completed for A; intentionally delay transport delivery to the JS caller.
  await page.evaluate(()=>{const handler=webkit.messageHandlers.desktop,original=handler.postMessage.bind(handler);handler.postMessage=async message=>{const result=await original(message);if(message.command==='library.article'&&message.payload.refresh){window.__refreshReady=true;await new Promise(r=>window.__releaseRefresh=r);}return result;};});
  await page.locator('#refresh-reader').click();await page.waitForFunction(()=>window.__refreshReady);
  await open(papers[1].id);await page.evaluate(()=>window.__releaseRefresh());await page.waitForTimeout(150);
  await page.screenshot({path:path.join(artifacts,'context-late-refresh.png')});
  await check('late A explicit refresh reply cannot overwrite current B guide/revision',async()=>{
   const result=await page.evaluate(()=>paperDigestArchiveHTML());assert.equal(result.paperID,papers[1].id);assert.equal(result.revision,'fixture-second-revision');assert.ok(!result.html.includes('43.2'));
  });
  // Start again in A, receive A PDF response only after B has become current.
  await open(primary.id);
  await page.evaluate(()=>{const handler=webkit.messageHandlers.desktop,original=handler.postMessage.bind(handler);handler.postMessage=async message=>{const result=await original(message);if(message.command==='pdf.open'){window.__pdfReady=true;await new Promise(r=>window.__releasePDF=r);}return result;};});
  await page.locator('#pdf-toggle').click();await page.waitForFunction(()=>window.__pdfReady);
  await open(papers[1].id);await page.evaluate(()=>window.__releasePDF());await page.waitForTimeout(150);
  await page.screenshot({path:path.join(artifacts,'context-late-pdf.png')});
  await check('late A PDF reply cannot install A status and split view into current B',async()=>{
   assert.equal(await page.locator('#pdf-toggle').getAttribute('aria-pressed'),'false');assert.notEqual(await page.locator('#pdf-version').innerText(),'2610.27491v1');
  });
  await open(primary.id);await page.locator('#tab-analysis').click();
  await page.evaluate(()=>{const handler=webkit.messageHandlers.desktop,original=handler.postMessage.bind(handler);handler.postMessage=async message=>{if(message.command==='model.preview'){window.__previewReady=true;await new Promise(r=>window.__releasePreview=r);return {pages:[5],characters:777};}return original(message);};});
  await page.locator('#evidence-scope').selectOption('range');await page.waitForFunction(()=>window.__previewReady);
  await open(papers[1].id);await page.evaluate(()=>window.__releasePreview());await page.waitForTimeout(100);
  await check('late A evidence preview cannot overwrite current B material label',async()=>assert.doesNotMatch(await page.locator('#context-label').innerText(),/777/));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
 console.log(`Independent UI context review: ${passed} passed; ${failures.length} failed; delayed reply fixture, no native/model/Zotero writes.`);
 if(failures.length){for(const f of failures)console.error(f);process.exitCode=1;}
})().catch(e=>{console.error(e);process.exitCode=1;});
