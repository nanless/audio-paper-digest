'use strict';
// Actual Android UI document head and published table bytes in a controlled browser.
// This is not Android WebView/Compose, accessibility, native fontScale, or provider evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.env.PD_DOCUMENT_TABLE_REPO||path.resolve(__dirname,'../../..');
const mac=path.join(root,'apps/macos');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const source=process.env.PD_DOCUMENT_TABLE_SOURCE||path.join(root,'apps/android/app/src/main/java/com/nanless/paperdigest/data/ExportService.kt');
const fixture=path.join(mac,'Tests/Fixtures/aggregate-daily24-links-original.html');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inputs=Object.fromEntries([__filename,source,fixture].map(p=>[p,digest(fs.readFileSync(p))]));
assert.equal(inputs[fixture],'c51f3797c5e9036ddb5afef60fab0463c6a2ab48991980639f557d915fe9ab1a');
const kotlin=fs.readFileSync(source,'utf8'),raw=fs.readFileSync(fixture,'utf8');
// Decode the production Kotlin string literal rather than maintaining a CSS copy.
const literal=kotlin.split('\n').find(line=>line.includes('return "<!doctype html>'))?.trim().slice(7);
const paletteLiteral=kotlin.split('\n').find(line=>line.includes('val paletteCSS = if (background == null)'))?.split(' else ')[1];
assert.ok(literal&&paletteLiteral,'Expected production document head and native palette branch');
function head(scheme){
 const colors=scheme==='dark'?{background:'#171c1c',foreground:'#e3e8e6',link:'#9dcac0'}:{background:'#faf8f4',foreground:'#20272c',link:'#29645a'};
 const palette=JSON.parse(paletteLiteral.replaceAll('${css(background)}',colors.background).replaceAll('${css(foreground!!)}',colors.foreground).replaceAll('${css(link!!)}',colors.link).replaceAll('${css(link)}',colors.link));
 return JSON.parse(literal.replace('${escape(title)}','Published table layout').replace('${paletteCSS}',palette));
}
fs.mkdirSync(path.join(mac,'.qa'),{recursive:true});
const output=process.env.PD_DOCUMENT_TABLE_OUTPUT||fs.mkdtempSync(path.join(mac,'.qa/document-tables-'));
fs.mkdirSync(output,{recursive:true});assert.equal(fs.existsSync(path.join(output,'result.json')),false);
const results=[];let browser;
(async()=>{try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 for(const width of [360,840])for(const font of [18,36])for(const scheme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:800},colorScheme:scheme}),result={width,font,scheme,passed:false},requests=[];
  try{
   await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
   await page.setContent(head(scheme)+'</body></html>');
   const tables=await page.evaluate(raw=>[...new DOMParser().parseFromString(raw,'text/html').querySelectorAll('#article-body table')].map(t=>t.outerHTML),raw);
   assert.equal(tables.length,2);
   // No website scripts/styles are loaded. The two original table fragments are unchanged.
   await page.setContent(head(scheme)+tables.join('')+'</body></html>');
   if(font!==18)await page.addStyleTag({content:'body{font-size:'+font+'px}'});
   result.actual=await page.evaluate(()=>{
    const all=[...document.querySelectorAll('table')],wide=all[1],title=wide.rows[1].cells[1].querySelector('a');
    const metric=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {width:r.width,height:r.height,font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight)}};
    return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,tableFragments:all.map(t=>t.outerHTML),headings:[...wide.rows[0].cells].map(metric),title:metric(title),wide:{client:wide.clientWidth,scroll:wide.scrollWidth},narrow:{client:all[0].clientWidth,scroll:all[0].scrollWidth},color:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor,csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,bodyText:document.body.textContent};
   });
   const a=result.actual;
   assert.deepEqual(a.tableFragments,tables,'Original tables, all columns, titles and link bytes must remain intact');
   assert.equal(a.headings.length,6);assert.ok(a.bodyText.includes('最上级任务')&&a.bodyText.includes('Direct cueing of word identity through word duration'));
   assert.ok(a.pageWidth<=a.viewport+1,'Only the table may overflow horizontally');
   for(const cell of a.headings)assert.ok(cell.height<=cell.line+18,'Header must stay on one readable line');
   assert.ok(a.title.width>=Math.min(12*font,width-80),'Long title must have readable line width');
   assert.ok(a.title.width<=Math.min(24*font,width-64)+1,'A title link must fit within one viewport');
   assert.ok(a.title.height<=4*a.title.line,'Real long title must not become a vertical word stack');
   if(width===360)assert.ok(a.wide.scroll>a.wide.client,'Wide six-column table must scroll locally');
   if(font===18)assert.ok(a.narrow.scroll<=a.narrow.client+1,'Existing narrow three-column table keeps natural layout');
   await page.screenshot({path:path.join(output,`${width}-${font}-${scheme}.png`),fullPage:true});
   result.reachable=await page.evaluate(()=>{
    const table=document.querySelectorAll('table')[1],anchor=table.rows[1].cells[1].querySelector('a');
    const visible=element=>{const r=element.getBoundingClientRect(),t=table.getBoundingClientRect();return r.left>=t.left-1&&r.right<=t.right+1&&r.left>=-1&&r.right<=innerWidth+1};
    const t=table.getBoundingClientRect(),r=anchor.getBoundingClientRect();table.scrollLeft+=r.left-t.left;
    const titleFullyVisible=visible(anchor);table.scrollLeft=table.scrollWidth;
    return {titleFullyVisible,lastColumnFullyVisible:visible(table.rows[0].cells[5]),scrolled:table.scrollLeft};
   });
   assert.ok(result.reachable.titleFullyVisible&&result.reachable.lastColumnFullyVisible,'Title and final column must each be fully reachable by local horizontal scroll');
   assert.equal(a.csp,"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
   assert.equal(a.color,scheme==='dark'?'rgb(227, 232, 230)':'rgb(32, 39, 44)');
   assert.equal(a.background,scheme==='dark'?'rgb(23, 28, 28)':'rgb(250, 248, 244)');
   assert.deepEqual(requests,[]);result.passed=true;console.log('PASS Android document tables',width,font,scheme);
  }catch(error){result.error=error.stack;console.error('FAIL Android document tables',width,font,scheme,error.message);}
  finally{results.push(result);await page.close();}
 }
}finally{
 await browser?.close();const inputsChanged=Object.keys(inputs).filter(p=>digest(fs.readFileSync(p))!==inputs[p]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'Actual production Android UI head/CSP + two byte-preserved published daily24 tables in controlled Chromium; CSS font-size36 is a browser stress control, not Android fontScale2 or WebView/Compose/AX/provider evidence.',inputs,inputsChanged,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2)+'\n');
 if(inputsChanged.length||results.length!==8||results.some(r=>!r.passed))process.exitCode=1;
}})().catch(error=>{console.error(error);process.exitCode=1});
