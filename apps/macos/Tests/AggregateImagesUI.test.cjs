'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mac=path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const iconPath=path.join(mac,'Assets/AppIcon.png'),icon=fs.readFileSync(iconPath),iconSHA=hash(icon);
assert.equal(icon.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
assert.equal(icon.readUInt32BE(16),1024);assert.equal(icon.readUInt32BE(20),1024);
const runtimePath=process.env.PD_AGGREGATE_IMAGES_RUNTIME||path.join(mac,'Resources/native.js');
const modulePath=process.env.PD_AGGREGATE_IMAGES_MODULE||path.join(mac,'Resources/aggregate-ui.js');
const runtime=fs.readFileSync(runtimePath,'utf8'),moduleSource=fs.readFileSync(modulePath,'utf8');
const output=process.env.PD_AGGREGATE_IMAGES_RESULT||path.join(mac,'.qa/aggregate-images-ui');fs.mkdirSync(output,{recursive:true});
const inputPaths=[__filename,iconPath,runtimePath,modulePath,path.join(mac,'Resources/aggregate.css'),path.join(mac,'Tests/DesktopUI.test.cjs')];
const inputs=Object.fromEntries(inputPaths.map(p=>[p,hash(fs.readFileSync(p))]));
// Deliberately synthetic UI-only DTO. This tracked application icon is not paper imagery or source authentication.
const descriptor={id:'page:/ui-only-local-image-fixture/',kind:'page',title:'UI-only local image fixture',displayDate:null,sourceURL:'https://example.invalid/ui-only-local-image-fixture/',tags:[],source:{manifestSHA256:hash('ui-only-manifest'),shardSHA256:hash('ui-only-shard')}};
const displayHTML='<h2 id="fixture-section">UI-only local image fixture</h2><figure><img id="ui-local-image" src="data:image/png;base64,'+icon.toString('base64')+'" alt="Tracked application icon, not a paper image"/><figcaption>UI-only local image fixture · 不代表论文或来源认证</figcaption></figure><p>[图片未缓存：missing UI-only slot]</p><p>Missing-slot caption retained.</p>';
const doc={contract:'published-aggregate-document-v1',descriptor,displayHTML,rawHTMLSHA256:hash('ui-only-raw'),sanitizedBodySHA256:hash('ui-only-original-body'),resources:[],notices:[],fetchedAt:'2026-01-01T00:00:00Z',validatedAt:null,isStale:true,readNotice:'UI-only local image fixture；受控DTO，不代表论文或认证',completeOffline:false,imageNotice:'UI-only local image fixture，仅界面回归',resourceManifestSHA256:hash('ui-only-resource-manifest'),resourceContract:'published-aggregate-image-render-v1',resourceObservedAt:'2026-01-01T00:00:00Z',resourceBodySHA256:hash(displayHTML),resourceImages:[{position:0,sourceURL:'https://example.invalid/ui-only-icon.png',alternative:'Tracked application icon',caption:'UI-only local image fixture',sha256:iconSHA,mime:'image/png',bytes:icon.length,missingReason:null},{position:1,sourceURL:null,alternative:'missing UI-only slot',caption:'Missing-slot caption retained.',sha256:null,mime:null,bytes:null,missingReason:'Controlled missing image'}]};
const results=[];let browser;
async function check(label,width,height,hostile=false){
 const page=await browser.newPage({viewport:{width,height}}),remoteRequests=[],remoteResponses=[],remoteTransport=[],failedRemote=[];
 try{
  await page.route('**/native.js',r=>r.fulfill({contentType:'text/javascript',body:runtime+'\nwindow.__imagesCI={state,openAggregate};'}));
  await page.route('**/aggregate-ui.js',r=>r.fulfill({contentType:'text/javascript',body:moduleSource}));
  // Even if the tested CSP regresses, this test must never contact the hostile remote source.
  await page.route('https://**',r=>{remoteTransport.push(r.request().url());return r.abort('blockedbyclient');});
  page.on('request',r=>{if(r.url().startsWith('https://'))remoteRequests.push({url:r.url(),type:r.resourceType()});});
  page.on('response',r=>{if(r.url().startsWith('https://'))remoteResponses.push(r.url());});
  page.on('requestfailed',r=>{if(r.url().startsWith('https://'))failedRemote.push({url:r.url(),reason:r.failure()?.errorText});});
  await installFixture(page);
  await page.addInitScript(({doc,hostile})=>{
   const original=webkit.messageHandlers.desktop.postMessage;let session=null;window.__imageCalls=[];
   webkit.messageHandlers.desktop.postMessage=async input=>{
    const {command,payload={}}=input;__imageCalls.push(structuredClone(input));
    if(command==='app.bootstrap')return {...await original(input),nativeNotes:true,nativeTasks:true};
    if(command.startsWith('nativeNotes.')||command.startsWith('nativeTasks.'))return command.endsWith('.bootstrap')?{nonce:command.split('.')[0]+'-ci-nonce',highestSequence:0}:{accepted:true};
    if(command==='aggregates.list')return {records:[doc.descriptor]};
    if(command==='aggregates.open'){if(Object.keys(payload).join(',')!=='id'||payload.id!==doc.descriptor.id)throw Error('Only UI fixture ID permitted');session={id:payload.id,sessionID:crypto.randomUUID(),contextGeneration:1};__fixture.selected=null;return session;}
    if(command==='aggregates.document'){if(payload.id!==session?.id||payload.sessionID!==session?.sessionID)throw Error('Retired UI fixture session');return {...structuredClone(doc),...session,displayHTML:doc.displayHTML+(hostile?'<img id="blocked-ui-remote" src="https://unapproved.invalid/ui-must-not-fetch.png"/><script>parent.__untrustedImageFrameRan=true</script>':'')};}
    if(command==='aggregates.leave'){session=null;return {left:true};}
    return original(input);
   };
  },{doc,hostile});
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('[data-library-open]');
  await page.evaluate(id=>__imagesCI.openAggregate(id),descriptor.id);await page.waitForSelector('#aggregate-view iframe');
  const frame=page.frames().find(f=>f.parentFrame());assert.ok(frame);
  await frame.waitForFunction(()=>{const i=document.getElementById('ui-local-image');return i?.complete&&i.naturalWidth===1024&&i.naturalHeight===1024;});
  const image=frame.locator('#ui-local-image');await image.scrollIntoViewIfNeeded();
  const geometry=await image.evaluate(i=>{const r=i.getBoundingClientRect();return {naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,width:r.width,height:r.height,left:r.left,right:r.right,viewportWidth:innerWidth,viewportHeight:innerHeight,documentWidth:document.documentElement.scrollWidth,mainWidth:document.querySelector('main').getBoundingClientRect().width};});
  assert.equal(geometry.naturalWidth,1024);assert.equal(geometry.naturalHeight,1024);
  assert.ok(geometry.width>0&&geometry.width<=geometry.viewportWidth&&geometry.left>=-1&&geometry.right<=geometry.viewportWidth+1);
  assert.ok(geometry.mainWidth<=840&&geometry.documentWidth<=geometry.viewportWidth+1);
  const actual=await image.evaluate(i=>Array.from(Uint8Array.from(atob(i.src.split(',')[1]),c=>c.charCodeAt(0))));assert.equal(hash(Buffer.from(actual)),iconSHA);
  await image.evaluate(i=>i.scrollIntoView({block:'start'}));assert.ok(await image.evaluate(i=>i.getBoundingClientRect().top>=-1));
  await image.evaluate(i=>i.scrollIntoView({block:'end'}));assert.ok(await image.evaluate(i=>i.getBoundingClientRect().bottom<=innerHeight+1));
  assert.equal(await frame.locator('img[src^="data:image/png;base64,"]').count(),1);
  assert.match(await frame.locator('main').innerText(),/\[图片未缓存：missing UI-only slot\]/);assert.match(await frame.locator('main').innerText(),/Missing-slot caption retained/);
  assert.match(await page.locator('.aggregate-status').innerText(),/图片 1\/2 已保存/);assert.match(await page.locator('.aggregate-status').innerText(),/UI-only local image fixture/);assert.equal(await page.locator('.aggregate-status.is-stale').count(),1);
  await page.locator('.aggregate-source summary').click();const sourceText=await page.locator('.aggregate-source').innerText();assert.ok(sourceText.includes(iconSHA)&&sourceText.includes(doc.resourceManifestSHA256));assert.match(sourceText,/不是完整离线包/);assert.match(sourceText,/Controlled missing image/);await page.locator('.aggregate-source summary').click();
  if(hostile){
   // The production math display now sanitizes before mounting the frame. Preserve
   // the independent CSP negative by attempting the same resource after that boundary.
   assert.equal(await frame.locator('#blocked-ui-remote,script').count(),0);
   assert.deepEqual(remoteRequests,[],'Hostile receipt resource must be removed before frame load');
   await frame.evaluate(()=>{const image=document.createElement('img');image.id='blocked-ui-remote';image.src='https://unapproved.invalid/ui-must-not-fetch.png';document.querySelector('main').append(image);});
   await frame.waitForFunction(()=>{const image=document.getElementById('blocked-ui-remote');return image?.complete&&image.naturalWidth===0;});
  }
  const policy=await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');assert.match(policy,/default-src 'none'/);assert.match(policy,/img-src data:/);assert.match(policy,/script-src 'none'/);assert.equal(await page.locator('#aggregate-view iframe').getAttribute('sandbox'),'allow-same-origin');
  assert.deepEqual(remoteTransport,[]);assert.deepEqual(remoteResponses,[]);assert.equal(await page.evaluate(()=>window.__untrustedImageFrameRan===true),false);
  if(hostile){assert.equal(remoteRequests.filter(x=>x.type==='image').length,1);assert.equal(failedRemote.filter(x=>x.reason==='csp').length,1);assert.equal(await frame.locator('#blocked-ui-remote').evaluate(i=>i.complete&&i.naturalWidth===0),true);}else assert.deepEqual(remoteRequests,[]);
  const calls=await page.evaluate(()=>__imageCalls);assert.equal(calls.some(c=>/^(model\.|zotero\.)/.test(c.command)),false);assert.equal(calls.filter(c=>c.command==='aggregates.open').length,1);assert.equal(calls.filter(c=>c.command==='aggregates.open').every(c=>Object.keys(c.payload).join(',')==='id'),true);
  results.push({label,passed:true,geometry,fixturePNGsha256:iconSHA,failedRemote,remoteTransport});console.log('PASS '+label);
 }catch(error){results.push({label,passed:false,error:error.stack,remoteRequests,remoteTransport});console.error('FAIL '+label+': '+error.stack);}finally{await page.close();}
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await check('UI-only-local-icon-small-and-partial',1080,660);await check('UI-only-local-icon-large-and-partial',1440,900);await check('data-only-image-policy-rejects-remote-and-script',1080,800,true);
}finally{
 await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));const inputsChanged=inputPaths.filter(p=>hash(fs.readFileSync(p))!==inputs[p]);const passed=results.length===3&&results.every(r=>r.passed)&&inputsChanged.length===0;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'Portable normal CI; tracked application icon and controlled UI-only DTO, not scientific/source authentication, installed AppKit/AX or network acceptance',inputs,inputsChanged,passed,results},null,2));if(!passed)process.exitCode=1;
}})().catch(error=>{console.error(error);process.exitCode=1;});
