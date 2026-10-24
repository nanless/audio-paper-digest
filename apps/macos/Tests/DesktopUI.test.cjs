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
async function installFixture(page, initial={}) {
  await page.addInitScript(f=>{
    if (window.top!==window) return;
    const copy=x=>structuredClone(x);
    window.__calls=[];window.__unimplemented=[];window.__fixture={...f,personal:copy(f.initialPersonal||{favorites:[],reading:[],notes:{},sessions:[],readingState:{},annotations:{}}),selected:null,pendingReadings:[],pendingAnnotations:[],failSettings:false,failNote:false,holdArticle:false,releaseArticle:null};
    window.webkit={messageHandlers:{desktop:{postMessage:async({command,payload={}})=>{
      const b=window.__fixture;window.__calls.push({command,payload:copy(payload)});
      switch(command) {
        case 'app.bootstrap':return copy({personal:b.personal,settings:b.settings,paper:b.selected,library:{paperCount:b.papers.length,recordCount:b.papers.length}});
        case 'library.status':return {paperCount:b.papers.length,recordCount:b.papers.length};
        case 'library.list':return copy({papers:b.papers});
        case 'library.search':case 'personal.search':return {ids:[]};
        case 'app.setPaper':b.selected=copy(payload);return {};
        case 'library.article':if(b.holdArticle||b.holdArticleFor===payload.paperID)await new Promise(r=>b.releaseArticle=r);return copy(payload.paperID===b.primary.id?b.article:{...b.article,paperID:payload.paperID,revisionSHA256:'fixture-second-revision',markdown:'# Fixture secondary document\n\n## Isolated transition fixture\n\nNo paper analysis is claimed.'});
        case 'personal.annotations':{const owner=b.selected?.id;if(b.holdAnnotationsFor===owner)await new Promise(r=>b.pendingAnnotations.push(r));return {annotations:copy(b.personal.annotations?.[owner]||b.annotations||[])};}
        case 'personal.annotationNote':if(b.failAnnotation)throw Error('Fixture annotation disk failure');{const annotations=b.personal.annotations?.[payload.paperID]||b.annotations||[];const found=annotations.find(a=>a.id===payload.id);if(!found)throw Error('Fixture annotation owner mismatch');found.comment=payload.comment;b.personal.annotations??={};b.personal.annotations[payload.paperID]=annotations;return copy({annotations});}
        case 'pdf.highlight':b.annotations=[{id:'fixture-annotation',page:5,text:'Explicit PDF selection fixture',pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'}];return {};
        case 'pdf.removeAnnotation':b.annotations=[];return {};
        case 'personal.snapshot':return copy(b.personal);
        case 'personal.note':if(b.failNote)throw Error('Fixture note disk failure');b.personal.notes[payload.paperID]={text:payload.text,revision:payload.baseRevision+1};return copy(b.personal.notes[payload.paperID]);
        case 'personal.reading':{const owner=payload.paperID||b.selected.id,snapshot=copy(payload);if(b.holdReadingFor===owner)await new Promise(resolve=>b.pendingReadings.push(resolve));b.personal.readingState[owner]={...snapshot,updatedAt:new Date().toISOString()};return {};}
        case 'personal.setList':b.personal[payload.key]=payload.ids;return copy(b.personal);
        case 'pdf.open':return {page:b.personal.readingState?.[b.selected?.id]?.pdfPage||1,pageCount:13,scale:1,version:'2610.27491v1',sha256:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'};
        case 'pdf.selection':return copy(b.selection||{});
        case 'pdf.locate':if(payload.pdfSHA!=='01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'||payload.page<1||payload.page>13)throw Error('Fixture PDF identity mismatch');return {page:payload.page,pageCount:13,scale:1,version:'2610.27491v1',sha256:payload.pdfSHA};
        case 'pdf.page':return {page:payload.page,pageCount:13,scale:1,version:'2610.27491v1'};
        case 'pdf.outline':return {chapters:[]};
        case 'pdf.close':case 'pdf.frame':case 'app.external':return {};
        case 'settings.save':if(b.failSettings)throw Error('Fixture settings disk failure');Object.assign(b.settings,payload);return copy(b.settings);
        case 'zotero.status':return {running:true,version:'10.0.6',writesSupported:true,authorized:false,remember:false,archives:[]};
        case 'zotero.collections':return [];
        case 'jobs.list':return copy({jobs:b.jobs||[]});
        case 'storage.status':return {totalBytes:800000,files:12,categories:[{label:'网站导读',bytes:50000},{label:'科学图',bytes:260467},{label:'网站原文 PDF',bytes:489533}]};
        case 'storage.packages':return {packages:[{id:'fixture-offline',title:b.primary.titleZh+'｜离线界面夹具',sourceVersion:'2610.27491v1',bytes:800000,createdAt:'2026-10-24T10:00:00Z',hasPDF:true,status:'隔离测试夹具'}]};
        case 'storage.cleanupPlan':return {planID:'fixture-plan',scope:'仅隔离界面测试，不会删除文件',count:0,bytes:0,requiresConfirmation:true};
        case 'storage.prepare':if(b.failStorage)throw Error('Fixture offline preparation failure');return {reused:false,id:'fixture-offline'};
        case 'storage.open':b.selected={...copy(b.primary),offlinePackageID:'fixture-offline',offlineMode:true};return copy({paper:b.selected,article:{...b.article,offlineMode:true,notices:['离线界面测试夹具；不是实际原生归档验收']}});
        case 'archive.materials':return {identity:'arxiv:2610.27491v1',bibliography:{title:b.primary.title,creators:b.primary.authors.map(name=>({name})),abstract:'公开MiCLA书目预览夹具，原生归档未执行',date:'2026-10-21',url:b.primary.sourceURL,tags:[],extra:''},pdfPath:'/fixture-private/paper.pdf',guideHTMLPath:'/fixture-private/guide.html',noteHTML:b.personal.notes?.[b.selected?.id]?.text?'Explicit fixture note preview':undefined};
        case 'model.run':b.personal.sessions.push({id:'fixture-failure',paperID:b.selected.id,kind:'study',question:payload.question,status:'failed',text:'',response:'',error:{message:'Fixture upstream quota failure',code:'quota'},model:'requested-fixture-model',actualModel:null,charge:'amount_unknown',source:{kind:'guide'},startedAt:'2026-10-24T10:00:00Z'});throw Error('Fixture upstream quota failure');
        case 'model.check':throw Error('Fixture connection failure; no complete response');
        default:window.__unimplemented.push(command);throw Error('Unimplemented isolated fixture command '+command);
      }
    }}}};
  },{...fixture,...initial});
}
const artifacts=process.env.PD_DESKTOP_TEST_ARTIFACTS||path.join(repo,'apps/macos/.qa/desktop-ui');fs.mkdirSync(artifacts,{recursive:true});
const failures=[];let passed=0;
async function check(name,fn) {try {await fn();passed++;console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}}
let browser;
module.exports={server,installFixture,primary,fixture,repo,artifacts};
if(require.main===module)(async()=>{
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
  const page=await browser.newPage({viewport:{width:1440,height:960}}), pageErrors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>pageErrors.push(e.message));await installFixture(page);await page.goto(base);
  await page.waitForSelector('[data-library-open="arxiv:2610.27491"]');
  await check('PDF is never opened by bootstrap',async()=>assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.open').length),0));
  await page.locator('[data-library-open="arxiv:2610.27491"]').click();await page.waitForFunction(()=>document.querySelector('#guide-frame')?.contentDocument?.querySelectorAll('table').length===4);
  const guide=()=>page.frameLocator('#guide-frame');
  await check('real seed: one title, four complete formulas, three SHA-checked scientific images, four original tables',async()=>{
    assert.equal(await guide().locator('h1').count(),1);assert.equal(await guide().locator('math').count(),4);
    assert.deepEqual(await guide().locator('annotation[encoding="application/x-tex"]').allTextContents(),sample.formulas.map(f=>f.latex));
    assert.equal(await guide().locator('img').count(),3);assert.equal(await guide().locator('table').count(),4);
    await page.waitForFunction(()=>[...document.querySelector('#guide-frame').contentDocument.images].every(i=>i.complete&&i.naturalWidth>0));
    const tables=await guide().locator('table').allTextContents();assert.match(tables.join(' '),/43\.2/);assert.match(tables.join(' '),/50\.3/);
    assert.equal(await guide().locator('.katex-error').count(),0);
  });
  await check('original eight-dimension rating and author affiliation preserved',async()=>{
    const text=await guide().locator('main').innerText();for(const value of ['创新 1.5/2','技术严谨 1.2/1.5','实验充分 1.3/1.5','可复现 0.5/0.5','Research & Development Center','机构信息未能'])assert.ok(text.includes(value),value);
  });
  await check('reader sandbox has no script permission, no child bridge; native main-frame origin guard exists',async()=>{
    const sandbox=await page.locator('#guide-frame').getAttribute('sandbox');assert.ok(!sandbox.includes('allow-scripts'));
    assert.equal(await guide().locator('script').count(),0);const frame=await page.locator('#guide-frame').elementHandle();assert.equal(await frame.evaluate(el=>!!el.contentWindow.webkit?.messageHandlers?.desktop),false);
    const csp=await guide().locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');assert.ok(csp.includes("script-src 'none'"));
    const swift=fs.readFileSync(path.join(repo,'apps/macos/Sources/Main.swift'),'utf8');assert.match(swift,/guard message\.frameInfo\.isMainFrame/);assert.match(swift,/securityOrigin\.protocol=="paperapp"/);
  });
  await page.locator('#pdf-toggle').click();await page.waitForFunction(()=>__calls.some(c=>c.command==='pdf.open')&&document.querySelector('#pdf-toggle').getAttribute('aria-pressed')==='true');
  await check('explicit source reveal keeps already-open PDF visible',async()=>{
    await page.locator('#tab-analysis').click();await page.evaluate(()=>{__fixture.selection={paperID:__fixture.primary.id,text:'Explicit isolated physical-page selection fixture',pages:[5],page:5,pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c',sourceVersion:'2610.27491v1'};window.dispatchEvent(new CustomEvent('pdf.selection',{detail:structuredClone(__fixture.selection)}));});
    const closes=await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.close').length);await page.locator('#source-page').click();await page.waitForFunction(()=>!document.querySelector('#pdf-toggle').disabled);
    await page.waitForFunction(()=>__calls.some(c=>c.command==='pdf.locate'));assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.locate').at(-1).payload),{pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c',page:5});assert.equal(await page.locator('#pdf-toggle').getAttribute('aria-pressed'),'true');assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.close').length),closes);await page.evaluate(()=>{__fixture.selection={};window.dispatchEvent(new CustomEvent('pdf.selection',{detail:{cleared:true,pages:[]}}));document.querySelector('#source-page').click();});await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.selection').length===2);assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.locate').length),1);await page.locator('#tab-guide').click();
  });
  await check('PDF opens only on explicit click and native PDF hides under modal dialogs',async()=>{
    assert.equal(await page.evaluate(()=>__calls.filter(c=>c.command==='pdf.open').length),1);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('menu.command',{detail:{action:'help'}})));
    await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.frame').at(-1)?.payload.visible===false);
    assert.equal(await page.locator('#detail-dialog').getAttribute('open'),'');assert.equal(await page.locator('#detail-dialog').getAttribute('role'),'dialog');assert.equal(await page.locator('#detail-dialog').getAttribute('aria-modal'),'true');assert.equal(await page.locator('#app-window').evaluate(el=>el.inert),true);await page.screenshot({path:path.join(artifacts,'desktop-ui-modal.png')});await page.locator('#detail-close').click();assert.equal(await page.locator('#app-window').evaluate(el=>el.inert),false);await page.waitForFunction(()=>__calls.filter(c=>c.command==='pdf.frame').at(-1)?.payload.visible===true);
  });
  await check('PDF close preserves guide DOM, scroll and question',async()=>{
    await page.evaluate(()=>{window.__guideBefore=document.querySelector('#guide-frame');__guideBefore.contentWindow.scrollTo(0,1000);document.querySelector('#question').value='保留提问';});
    await page.locator('#pdf-close').click();await page.waitForFunction(()=>__calls.some(c=>c.command==='pdf.close'));
    assert.equal(await page.evaluate(()=>document.querySelector('#guide-frame')===__guideBefore),true);assert.ok(await page.evaluate(()=>__guideBefore.contentWindow.scrollY)>0);assert.equal(await page.locator('#question').inputValue(),'保留提问');
  });
  await page.locator('#tab-note').click();await page.locator('#note-editor').fill('Isolated fixture persisted note; no personal profile touched.');await page.waitForFunction(()=>__fixture.personal.notes['arxiv:2610.27491']?.revision===1);
  await check('note persists only after native success and survives reopening',async()=>{
    assert.equal(await page.locator('#note-status').innerText(),'已保存到本机');await page.locator('#back').click();await page.locator('[data-library-open="arxiv:2610.27491"]').click();await page.waitForSelector('#guide-frame');await page.locator('#tab-note').click();assert.match(await page.locator('#note-editor').inputValue(),/Isolated fixture persisted/);
    await page.locator('[data-view=notes]').click();await page.waitForSelector('#notes-view:not([hidden])');assert.match(await page.locator('#all-notes').innerText(),/Isolated fixture persisted/);await page.locator('[data-note-open]').click();await page.waitForSelector('#note-pane:not([hidden])');
  });
  await check('note persistence failure does not claim saved',async()=>{
    await page.evaluate(()=>__fixture.failNote=true);await page.locator('#note-editor').fill('Unsaved fixture edit');await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture note disk failure'));
    assert.ok(!(await page.locator('#note-status').innerText()).includes('已保存'));assert.ok(!(await page.evaluate(()=>__fixture.personal.notes['arxiv:2610.27491'].text)).includes('Unsaved'));
    await page.evaluate(()=>__fixture.failNote=false);await page.locator('#note-editor').fill('Recovered fixture note');await page.waitForFunction(()=>__fixture.personal.notes['arxiv:2610.27491'].text==='Recovered fixture note');
  });
  await check('annotation controls display source identity and remove only selected annotation',async()=>{
    await page.locator('#highlight-selection').click();await page.waitForSelector('[data-annotation-remove="fixture-annotation"]');assert.match(await page.locator('#annotation-list').innerText(),/物理页 5/);assert.match(await page.locator('#annotation-list').innerText(),/01eea4603740/);await page.locator('[data-annotation-remove]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-annotation-remove]').length===0);
  });
  await page.locator('#tab-analysis').click();await page.locator('#question').fill('Show failure honestly');await page.locator('#analyze').click();await page.waitForFunction(()=>__fixture.personal.sessions.length===1&&!document.querySelector('#analyze').disabled);
  await check('model object-shaped failure shows actual error, actual model, no fabricated result or cost',async()=>{
    const text=await page.locator('#analysis-result').innerText();assert.match(text,/请求 requested-fixture-model/);assert.match(text,/实际模型未知/);assert.match(text,/failed/);assert.match(text,/金额未知/);
    const result=page.frameLocator('#analysis-result iframe').first();assert.match(await result.locator('main').innerText(),/Fixture upstream quota failure/);assert.doesNotMatch(await result.locator('main').innerText(),/\[object Object\]/);
    assert.ok(!(await page.locator('#toast').innerText()).includes('解析已保存'));
  });
  await check('full source export bound to current article identity/revision; absent during pending transition',async()=>{
    const current=await page.evaluate(()=>paperDigestArchiveHTML());assert.equal(current.paperID,primary.id);assert.equal(current.revision,revision);assert.ok(current.html.includes('43.2'));
    await page.locator('#back').click();await page.evaluate(()=>__fixture.holdArticle=true);await page.locator('[data-library-open="'+papers[1].id+'"]').click();await page.waitForFunction(()=>!!__fixture.releaseArticle);
    assert.equal(await page.evaluate(()=>paperDigestArchiveHTML()),null);await page.evaluate(()=>{__fixture.holdArticle=false;__fixture.releaseArticle();});await page.waitForFunction(()=>paperDigestArchiveHTML()?.revision==='fixture-second-revision');const next=await page.evaluate(()=>paperDigestArchiveHTML());assert.equal(next.paperID,papers[1].id);assert.ok(!next.html.includes('43.2'));
  });
  await check('reader has no unexpected JavaScript errors; no Zotero permission or library writes invoked',async()=>{assert.deepEqual(pageErrors,[]);assert.deepEqual(await page.evaluate(()=>__unimplemented),[]);assert.equal(await page.evaluate(()=>__calls.filter(c=>/^zotero\.(authorize|archive|resume)$/.test(c.command)).length),0);});
  async function fresh(initial={}) {const p=await browser.newPage({viewport:{width:1440,height:900}});p.setDefaultTimeout(10000);await installFixture(p,initial);await p.goto(base);await p.waitForSelector('[data-library-open="arxiv:2610.27491"]');return p;}
  async function open(p,id=primary.id){await p.locator('[data-library-open="'+id+'"]').click();await p.waitForFunction(id=>paperDigestArchiveHTML()?.paperID===id,id);}
  await check('older reading save and article await cannot refill another paper draft/body',async()=>{
    const p=await fresh();try{
      await open(p);await p.locator('#tab-analysis').click();await p.locator('#question').fill('Paper A delayed reading draft');await p.evaluate(()=>__fixture.holdReadingFor=__fixture.primary.id);await p.waitForFunction(()=>__fixture.pendingReadings.length===1);
      await p.locator('#back').click();await p.locator('[data-library-open="'+papers[1].id+'"]').click();await p.waitForFunction(()=>__fixture.pendingReadings.length===2);await p.evaluate(()=>__fixture.pendingReadings.pop()());await p.waitForFunction(id=>paperDigestArchiveHTML()?.paperID===id,papers[1].id);
      await p.locator('#tab-analysis').click();await p.locator('#question').fill('Paper B owns this draft');await p.evaluate(()=>__fixture.pendingReadings.shift()());assert.equal(await p.locator('#question').inputValue(),'Paper B owns this draft');assert.equal(await p.evaluate(()=>__fixture.personal.readingState[__fixture.primary.id].question),'Paper A delayed reading draft');assert.ok(!(await p.frameLocator('#guide-frame').locator('main').innerText()).includes('43.2'));
      await p.locator('#back').click();await p.evaluate(()=>{__fixture.holdReadingFor=null;__fixture.holdArticleFor=__fixture.primary.id;});await p.locator('[data-library-open="'+primary.id+'"]').click();await p.waitForFunction(()=>!!__fixture.releaseArticle);await p.locator('#back').click();await open(p,papers[1].id);await p.evaluate(()=>__fixture.releaseArticle());assert.equal((await p.evaluate(()=>paperDigestArchiveHTML())).paperID,papers[1].id);
      assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);
    }finally{await p.close();}
  });
  const mark={id:'fixture-annotation',page:5,text:'Explicit immutable PDF quote fixture',pdfSHA:'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c'};
  await check('continue restores mode/PDF/draft and local source clears previous owner fields',async()=>{
    const initialPersonal={favorites:[],reading:[],notes:{[primary.id]:{text:'Saved note A',revision:1}},sessions:[],annotations:{},readingState:{[primary.id]:{updatedAt:'2026-10-24T12:00:00Z',mode:'note',pdfOpen:true,pdfPage:5,question:'Saved question A',scope:'range',from:4,to:6,split:54}}};
    const p=await fresh({initialPersonal});try{
      await p.locator('[data-view="reader"]').first().click();await p.waitForSelector('#note-pane:not([hidden])');await p.waitForFunction(()=>document.querySelector('#pdf-toggle').getAttribute('aria-pressed')==='true');assert.equal(await p.locator('#note-editor').inputValue(),'Saved note A');assert.equal(await p.locator('#question').inputValue(),'Saved question A');assert.equal(await p.locator('#range-from').inputValue(),'4');assert.equal(await p.locator('#pdf-page').inputValue(),'5');
      await p.evaluate(()=>window.dispatchEvent(new CustomEvent('pdf.selection',{detail:{text:'Previous paper A selected text',pages:[5],page:5}})));
      await p.evaluate(()=>{__fixture.selected={id:'local:fixture',title:'Local PDF isolated fixture',titleZh:'Local PDF isolated fixture',sourceKind:'local',authors:[]};__fixture.personal.notes['local:fixture']={text:'Local owner note',revision:1};window.dispatchEvent(new CustomEvent('local.opened',{detail:{paper:__fixture.selected,pdf:{page:1,pageCount:13,scale:1}}}));});
      await p.waitForFunction(()=>document.querySelector('#sidebar-paper').textContent==='Local PDF isolated fixture');assert.equal(await p.locator('#question').inputValue(),'');assert.equal(await p.locator('#evidence-scope').inputValue(),'page');assert.equal(await p.locator('#range-from').inputValue(),'1');assert.equal(await p.locator('#note-editor').inputValue(),'Local owner note');assert.equal(await p.evaluate(()=>paperDigestArchiveHTML()),null);assert.equal(await p.locator('#analysis-pane').isVisible(),true);assert.equal(await p.locator('.source-excerpt').isVisible(),false,'previous selected excerpt must not survive local source change');assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);
    }finally{await p.close();}
  });
  await check('annotation autosave is bound to original owner, retains quote and failed draft before switching',async()=>{
    const initialPersonal={favorites:[],reading:[],notes:{},sessions:[],readingState:{},annotations:{[primary.id]:[{...mark}],[papers[1].id]:[{...mark,comment:'Paper B original comment'}]}};
    const p=await fresh({initialPersonal});try{
      await open(p);await p.locator('#tab-note').click();const field=p.locator('[data-annotation-comment]');await field.fill('Saved comment A');await p.waitForFunction(()=>__fixture.personal.annotations[__fixture.primary.id][0].comment==='Saved comment A');assert.equal(await p.evaluate(()=>__fixture.personal.annotations[__fixture.primary.id][0].text),'Explicit immutable PDF quote fixture');
      await p.evaluate(()=>__fixture.failAnnotation=true);await field.fill('Unsaved retry comment A');await p.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture annotation disk failure'));assert.equal(await field.inputValue(),'Unsaved retry comment A');assert.equal(await p.evaluate(()=>__fixture.personal.annotations[__fixture.primary.id][0].comment),'Saved comment A');
      await p.evaluate(()=>__fixture.failAnnotation=false);await p.locator('#back').click();await open(p,papers[1].id);assert.equal(await p.evaluate(()=>__fixture.personal.annotations[__fixture.primary.id][0].comment),'Unsaved retry comment A');assert.equal(await p.evaluate(id=>__fixture.personal.annotations[id][0].comment,papers[1].id),'Paper B original comment');
      await p.locator('[data-view="notes"]').click();await p.waitForSelector('#notes-view:not([hidden])');assert.match(await p.locator('#all-notes').innerText(),/原文摘录/);assert.equal(await p.locator('[data-note-open]').count(),2);assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);
    }finally{await p.close();}
  });
  await check('storage modal shows explicit capacity/plan, preparation failure stays failure and offline open keeps real article',async()=>{
    const p=await fresh();try{
      await open(p);await p.evaluate(()=>__fixture.failStorage=true);await p.locator('#save-offline').click();await p.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture offline preparation failure'));assert.equal(await p.locator('#save-offline').isDisabled(),false);
      await p.locator('#storage-button').click();await p.waitForSelector('#storage-plan');assert.match(await p.locator('#detail-content').innerText(),/隔离测试夹具/);await p.locator('#storage-plan').click();await p.waitForFunction(()=>document.querySelector('#cleanup-result').textContent.includes('候选 0'));assert.equal(await p.locator('#storage-clean').count(),0);
      await p.locator('[data-offline]').click();await p.waitForFunction(()=>paperDigestArchiveHTML()?.html.includes('离线界面测试夹具'));assert.equal(await p.frameLocator('#guide-frame').locator('math').count(),4);assert.equal(await p.frameLocator('#guide-frame').locator('img').count(),3);assert.equal(await p.frameLocator('#guide-frame').locator('table').count(),4);assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);
    }finally{await p.close();}
  });
  const settingPage=await browser.newPage({viewport:{width:800,height:700}});settingPage.setDefaultTimeout(10000);await installFixture(settingPage);await settingPage.goto(base+'/settings.html');await settingPage.waitForFunction(()=>document.querySelector('#key-status').textContent.includes('尚未保存'));
  await check('settings really persist via bridge after edit',async()=>{await settingPage.locator('#appearance').selectOption('dark');await settingPage.waitForFunction(()=>__fixture.settings.appearance==='dark');assert.equal(await settingPage.locator('#save-status').innerText(),'设置已保存到本机');assert.equal(await settingPage.evaluate(()=>__calls.filter(c=>c.command==='settings.save').length),1);});
  await check('settings write failure clearly replaces previous saved status',async()=>{await settingPage.evaluate(()=>__fixture.failSettings=true);await settingPage.locator('#appearance').selectOption('light');await settingPage.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture settings disk failure'));assert.equal(await settingPage.evaluate(()=>__fixture.settings.appearance),'dark');assert.ok(!(await settingPage.locator('#save-status').innerText()).includes('已保存'));});
  await check('connection failure never displays success or fabricated usage',async()=>{await settingPage.evaluate(()=>__fixture.failSettings=false);await settingPage.locator('[data-pane="model"]').click();await settingPage.locator('#check-model').click();await settingPage.waitForFunction(()=>document.querySelector('#model-result').textContent.includes('Fixture connection failure'));assert.doesNotMatch(await settingPage.locator('#model-result').innerText(),/响应已保存|token 用量/);assert.deepEqual(await settingPage.evaluate(()=>__unimplemented),[]);});
  if(process.env.PD_DESKTOP_SCREENSHOTS==='1') {
    const manifest={contract:'desktop-ui-isolated-screenshots-v1',notice:'Real published MiCLA guide, figures, tables and formulas. Native PDF area, jobs, personal notes, offline package and Zotero bridge are EXPLICIT test fixtures, not actual PDFKit/archiving/paid model acceptance.',screens:[]};
    const initialPersonal={favorites:[primary.id],reading:[primary.id],notes:{[primary.id]:{text:'已读：MiCLA 的合成混合条件与局限。\n这是隔离界面测试笔记，不新增论文结论。',revision:1}},readingState:{},annotations:{[primary.id]:[{...mark,comment:'界面回归夹具：保留原文引用与物理页身份'}]},sessions:[{id:'fixture-view-failure',kind:'study',paperID:primary.id,status:'failed',model:'fixture-requested-model',actualModel:'fixture-reported-model',question:'混合到成分对齐的适用条件是什么？',text:'',error:{message:'隔离界面测试：模型请求失败示例；未调用真实服务、未生成个人解析。'},source:{kind:'guide'},charge:'amount_unknown',startedAt:'2026-10-24T10:00:00Z'}]};
    for(const theme of ['light','dark'])for(const [width,height]of [[1440,900],[1080,700]]) {
      const p=await fresh({initialPersonal,settings:{...settings,appearance:theme}});await p.setViewportSize({width,height});await p.emulateMedia({colorScheme:theme});
      async function shot(name){await p.evaluate(()=>document.fonts.ready);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'desktop viewport overflow: '+name);const file=`${theme}-${width}x${height}-${name}.png`;await p.screenshot({path:path.join(artifacts,file),animations:'disabled'});const footer=await p.evaluate(()=>{const f=document.querySelector('dialog[open] footer');if(!f)return null;const r=f.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};});if(footer)assert.ok(footer.top>=0&&footer.bottom<=height+1,'modal footer outside viewport: '+name);manifest.screens.push({file,width,height,theme,view:name,footer});}
      try {
        await shot('library');await open(p);await shot('guide');
        await p.locator('#guide-frame').evaluate(el=>el.contentDocument.querySelector('img').scrollIntoView({block:'center'}));await shot('guide-science');await p.locator('#guide-frame').evaluate(el=>el.contentWindow.scrollTo(0,0));
        await p.locator('#pdf-toggle').click();await p.waitForFunction(()=>document.querySelector('#pdf-toggle').getAttribute('aria-pressed')==='true');await p.locator('#pdf-scroll').evaluate(el=>{const label=document.createElement('div');label.id='explicit-pdf-fixture-label';label.textContent='原生 PDF 区域 · 隔离界面测试占位\n本图不代表 PDFKit 渲染验收';label.style.cssText='height:100%;display:grid;place-content:center;white-space:pre-line;text-align:center;color:#6b7280;background:repeating-linear-gradient(135deg,#ddd2,#ddd2 12px,transparent 12px,transparent 24px);font:14px/2 -apple-system';el.replaceChildren(label);});await shot('split-explicit-pdf-fixture');await p.locator('#pdf-close').click();if(await p.locator('#app-window').evaluate(el=>el.classList.contains('sidebar-hidden')))await p.locator('[data-action=sidebar]:visible').first().click();
        await p.locator('#tab-note').click();await p.waitForSelector('[data-annotation-comment]');await shot('note');await p.locator('#tab-analysis').click();await p.waitForSelector('#analysis-result iframe');await shot('analysis-failure-fixture');
        await p.locator('[data-view="notes"]').click();await p.waitForSelector('[data-note-open]');await shot('notes-index');
        await p.evaluate(()=>__fixture.jobs=[{id:'fixture-task',title:'隔离任务夹具：读取公开目录',command:'library.sync',status:'running',startedAt:'2026-10-24T10:00:00Z',message:'仅用于任务布局回归，无真实同步或消费',progress:{completed:7,total:15}}]);await p.locator('[data-view="tasks"]').click();await p.waitForSelector('#task-list progress');await shot('tasks-explicit-fixture');
        await p.locator('#storage-button').click();await p.waitForSelector('[data-offline]');await shot('storage-explicit-fixture');await p.keyboard.press('Escape');await p.locator('[data-view="reader"]').first().click();await p.locator('#archive-open').click();await p.waitForFunction(()=>document.querySelector('#archive-title').textContent.includes('MiCLA')&&document.querySelector('#zotero-result').textContent.includes('核对内容'));await shot('zotero-preview-no-authorization');await p.keyboard.press('Escape');
        assert.deepEqual(await p.evaluate(()=>__unimplemented),[]);assert.equal(await p.evaluate(()=>__calls.filter(c=>/^zotero\.(authorize|archive|resume)$/.test(c.command)).length),0);
      }finally{await p.close();}
      const sp=await browser.newPage({viewport:{width,height}});sp.setDefaultTimeout(10000);await installFixture(sp,{settings:{...settings,appearance:theme}});await sp.goto(base+'/settings.html');await sp.waitForFunction(()=>document.querySelector('#key-status').textContent.includes('尚未保存'));for(const pane of ['reading','model','zotero']){await sp.locator('[data-pane="'+pane+'"]').click();const file=`${theme}-${width}x${height}-settings-${pane}.png`;await sp.screenshot({path:path.join(artifacts,file),animations:'disabled'});manifest.screens.push({file,width,height,theme,view:'settings-'+pane});}await sp.close();
    }
    fs.writeFileSync(path.join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));console.log(`Screenshots: ${manifest.screens.length} in ${artifacts}; explicit native/model/storage fixtures labelled.`);
  }
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
 console.log(`Desktop UI: ${passed} passed; ${failures.length} failed. Real public content; isolated native/model/PDF fixtures, no real authorization or writes.`);
 if(failures.length){for(const f of failures)console.error(f);process.exitCode=1;}
})().catch(e=>{console.error(e);process.exitCode=1;});
