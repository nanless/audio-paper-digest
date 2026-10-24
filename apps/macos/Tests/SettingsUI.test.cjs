/* Actual settings.html/settings.js in an isolated browser. Native writes are explicit
 * controllable fixtures; no Keychain, provider, user profile or Zotero IO occurs. */
const {chromium}=require('playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Resources');
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(req.url.split('?')[0]);const file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const initial={appearance:'system',font:18,syncHours:12,endpoint:'https://fixture.invalid/v1',model:'fixture-model',protocol:'auto',httpProxy:'',maxTokens:8192,dailyRequests:50,reduceMotion:false,hasKey:false};
let browser,passed=0;
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
  async function fixture(settings=initial){
    const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(settings=>{
      const clone=x=>structuredClone(x);
      window.fixture={settings:clone(settings),calls:[],pending:[],pendingBootstrap:[],hold:false,holdBootstrap:false,failNext:0,failBootstrap:0};
      window.webkit={messageHandlers:{desktop:{postMessage:async({command,payload={}})=>{
        const f=window.fixture;f.calls.push({command,payload:clone(payload)});
        if(command==='app.bootstrap'){
          const result=clone({settings:f.settings,personal:{},paper:null});
          if(f.holdBootstrap)await new Promise(resolve=>f.pendingBootstrap.push(resolve));
          if(f.failBootstrap){f.failBootstrap--;throw Error('Fixture bootstrap read failure');}
          return result;
        }
        if(command==='settings.save'){
          if(f.hold)await new Promise(resolve=>f.pending.push(resolve));
          if(f.failNext){f.failNext--;throw Error('Fixture settings write failure');}
          Object.assign(f.settings,payload);
          window.dispatchEvent(new CustomEvent('settings.changed'));
          return clone(f.settings);
        }
        if(command==='model.check'){
          if(f.failCheck)throw Error('输出被 max_output_tokens=4096 截断 · 实际模型 reported-reasoning-fixture · openai_responses · 用量 {"input_tokens":155,"output_tokens":4096} · 费用金额未知；不会自动重发');
          return {text:'真实本机夹具确认',actualModel:'reported-fixture',protocol:'openai_responses',usage:{input_tokens:12,output_tokens:7}};
        }
        if(command==='zotero.status')return {running:true,version:'10.0.6',writesSupported:true,authorized:!!f.zoteroChecked,remember:!!f.zoteroChecked,authorizationState:f.zoteroChecked?'authorized':'unknown',archives:[]};
        if(command==='zotero.collections')return {collections:[]};
        if(command==='zotero.checkAuthorization'){f.zoteroChecked=true;return {running:true,version:'10.0.6',writesSupported:true,authorized:true,remember:true,authorizationState:'authorized'};}
        throw Error('Unexpected native fixture command: '+command);
      }}}};
    },settings);
    await page.goto(`http://127.0.0.1:${server.address().port}/settings.html`);
    await page.waitForFunction(()=>!document.querySelector('#key-status').textContent.includes('待载入'));
    return {page,errors};
  }
  const writes=page=>page.evaluate(()=>fixture.calls.filter(c=>c.command==='settings.save'));
  const edit=(page,id,value)=>page.evaluate(({id,value})=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},{id,value});
  const pending=page=>page.waitForFunction(()=>fixture.pending.length>0);
  const release=page=>page.evaluate(()=>fixture.pending.shift()());
  const flush=page=>page.evaluate(()=>{window.flushState='pending';window.paperDigestFlushSettings().then(()=>flushState='saved',e=>{flushState='failed';flushError=e.message;});});
  async function check(name,action,settings){
    const {page,errors}=await fixture(settings);
    try{await action(page);assert.deepEqual(errors,[]);passed++;console.log('PASS '+name);}finally{await page.close();}
  }
  await check('unknown model credential is honest and bootstrap/pane/save never reads secret',async page=>{
    await page.locator('[data-pane=model]').click();assert.match(await page.locator('#key-status').textContent(),/状态未检查/);assert.doesNotMatch(await page.locator('#key-status').textContent(),/尚未保存|已安全保存/);await edit(page,'model','ordinary-settings-change');await page.evaluate(()=>window.paperDigestFlushSettings());assert.match(await page.locator('#key-status').textContent(),/状态未检查/);assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>c.command.startsWith('model.'))),[]);
  },{...initial,credentialState:'unknown',hasKey:null});
  await check('Zotero ordinary refresh stays unknown; explicit saved grant check does not request new authorization',async page=>{
    await page.locator('[data-pane=zotero]').click();await page.locator('#zotero-refresh').click();await page.waitForFunction(()=>document.querySelector('#zotero-auth-status').textContent.includes('尚未检查'));assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.command==='zotero.checkAuthorization').length),0);await page.locator('#zotero-settings-check-saved').click();await page.waitForFunction(()=>document.querySelector('#zotero-auth-status').textContent.includes('已获持续授权'));assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.command==='zotero.checkAuthorization').length),1);assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.command==='zotero.authorize').length),0);
  });
  await check('explicit Responses parameters persist as boolean and enum before check',async page=>{
    await page.locator('[data-pane=model]').click();assert.equal(await page.locator('#responsesStream').isChecked(),false);assert.equal(await page.locator('#reasoningEffort').inputValue(),'default');
    await page.locator('#responsesStream').check();await page.locator('#reasoningEffort').selectOption('low');await page.locator('#check-model').click();await page.waitForFunction(()=>document.querySelector('#model-result').textContent.includes('reported-fixture'));
    assert.equal(await page.evaluate(()=>fixture.settings.responsesStream),true);assert.equal(await page.evaluate(()=>fixture.settings.reasoningEffort),'low');
    const calls=await page.evaluate(()=>fixture.calls);assert(calls.find(c=>c.command==='settings.save'&&c.payload.responsesStream===true));assert.equal(calls.filter(c=>c.command==='model.check').length,1);assert((await page.locator('#model-result').textContent()).includes('12'));
  });
  await check('incomplete connection error shows actual usage and does not retry',async page=>{
    await page.locator('[data-pane=model]').click();await page.evaluate(()=>fixture.failCheck=true);await page.locator('#check-model').click();await page.waitForFunction(()=>document.querySelector('#model-result').textContent.includes('不会自动重发'));
    const result=await page.locator('#model-result').textContent();assert(result.includes('4096')&&result.includes('155')&&result.includes('reported-reasoning-fixture'));await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.command==='model.check').length),1);assert.equal(await page.locator('#check-model').isDisabled(),false);
  });
  await check('unchanged flush issues no write',async page=>{
    assert.deepEqual(await page.evaluate(()=>window.paperDigestFlushSettings()),{saved:true});assert.equal((await writes(page)).length,0);
  });
  await check('A pending + B debounce + flush drains both field writes',async page=>{
    await page.evaluate(()=>fixture.hold=true);await edit(page,'font',20);await pending(page);
    await edit(page,'model','fixture-model-b');await page.waitForTimeout(310);await flush(page);
    assert.equal(await page.evaluate(()=>flushState),'pending');assert.equal((await writes(page)).length,1);
    await release(page);await page.waitForFunction(()=>fixture.calls.filter(c=>c.command==='settings.save').length===2);await pending(page);
    assert.equal(await page.evaluate(()=>flushState),'pending');await release(page);await page.waitForFunction(()=>flushState==='saved');
    assert.deepEqual((await writes(page)).map(c=>c.payload),[{font:20},{model:'fixture-model-b'}]);
    assert.equal(await page.evaluate(()=>fixture.settings.model),'fixture-model-b');
  });
  await check('same field edited during write retains newest draft until committed',async page=>{
    await page.evaluate(()=>fixture.hold=true);await edit(page,'font',20);await pending(page);await edit(page,'font',21);await page.waitForTimeout(310);
    await release(page);await pending(page);assert.equal(await page.locator('#font').inputValue(),'21');
    await flush(page);await release(page);await page.waitForFunction(()=>flushState==='saved');
    assert.deepEqual((await writes(page)).map(c=>c.payload),[{font:20},{font:21}]);assert.equal(await page.evaluate(()=>fixture.settings.font),21);
  });
  await check('write failure preserves all drafts, stops retry loop, explicit retry recovers',async page=>{
    await page.evaluate(()=>{fixture.hold=true;fixture.failNext=1;});await edit(page,'font',20);await pending(page);await edit(page,'model','recover-model');await page.waitForTimeout(310);await flush(page);await release(page);
    await page.waitForFunction(()=>flushState==='failed');assert.match(await page.evaluate(()=>flushError),/Fixture settings write failure/);
    await page.waitForTimeout(600);assert.equal((await writes(page)).length,1);assert.equal(await page.locator('#font').inputValue(),'20');assert.equal(await page.locator('#model').inputValue(),'recover-model');
    await page.evaluate(()=>fixture.hold=false);assert.deepEqual(await page.evaluate(()=>window.paperDigestFlushSettings()),{saved:true});
    assert.deepEqual((await writes(page)).at(-1).payload,{font:20,model:'recover-model'});assert.equal(await page.evaluate(()=>fixture.settings.model),'recover-model');
  });
  await check('discard waits issued A, drops unissued B and concurrent flush waits discard',async page=>{
    await page.evaluate(()=>fixture.hold=true);await edit(page,'font',20);await pending(page);await edit(page,'model','discard-this-draft');
    await page.locator('#discard-settings').click();assert.equal(await page.locator('#model').isDisabled(),true);await flush(page);assert.equal(await page.evaluate(()=>flushState),'pending');
    await release(page);await page.waitForFunction(()=>flushState==='saved');assert.equal((await writes(page)).length,1);
    assert.equal(await page.locator('#font').inputValue(),'20');assert.equal(await page.locator('#model').inputValue(),'fixture-model');assert.equal(await page.locator('#model').isDisabled(),false);
  });
  await check('discard after failed issued write reloads real committed values',async page=>{
    await page.evaluate(()=>{fixture.hold=true;fixture.failNext=1;});await edit(page,'font',20);await pending(page);await edit(page,'model','not-committed');
    await page.locator('#discard-settings').click();await release(page);await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已恢复最近保存的设置');
    assert.equal(await page.locator('#font').inputValue(),'18');assert.equal(await page.locator('#model').inputValue(),'fixture-model');assert.equal((await writes(page)).length,1);
    await page.waitForTimeout(400);assert.equal((await writes(page)).length,1);
  });
  await check('discard restores absent settings to real defaults without writing drafts',async page=>{
    await edit(page,'endpoint','https://draft.invalid/v1');await page.locator('#discard-settings').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已恢复最近保存的设置');
    assert.equal(await page.locator('#endpoint').inputValue(),'');assert.equal(await page.locator('#model').inputValue(),'');assert.equal((await writes(page)).length,0);
  },{appearance:'system',font:18,syncHours:12,hasKey:false});
  await check('cross-window reload preserves local dirty field and writes only that field',async page=>{
    await edit(page,'model','local-draft');await page.evaluate(()=>{fixture.settings.font=24;window.dispatchEvent(new CustomEvent('settings.changed'));});
    await page.waitForFunction(()=>document.querySelector('#font').value==='24');assert.equal(await page.locator('#model').inputValue(),'local-draft');
    await page.evaluate(()=>window.paperDigestFlushSettings());assert.deepEqual((await writes(page)).map(c=>c.payload),[{model:'local-draft'}]);assert.equal(await page.evaluate(()=>fixture.settings.font),24);
  });
  await check('late bootstrap snapshot cannot undo newer committed UI values',async page=>{
    await page.evaluate(()=>{fixture.holdBootstrap=true;window.dispatchEvent(new CustomEvent('settings.changed'));});await page.waitForFunction(()=>fixture.pendingBootstrap.length===1);
    await edit(page,'font',20);await page.evaluate(()=>window.paperDigestFlushSettings());await page.waitForFunction(()=>fixture.pendingBootstrap.length===2);
    await page.evaluate(()=>{fixture.holdBootstrap=false;for(const r of fixture.pendingBootstrap.splice(0).reverse())r();});
    await page.waitForTimeout(80);assert.equal(await page.locator('#font').inputValue(),'20');assert.equal(await page.evaluate(()=>fixture.settings.font),20);
  });
  await check('failed discard read retains draft and never claims successful discard',async page=>{
    await edit(page,'model','preserved-on-read-failure');await page.evaluate(()=>fixture.failBootstrap=1);await page.locator('#discard-settings').click();
    await page.waitForFunction(()=>document.querySelector('#save-status').textContent.startsWith('未能放弃编辑：'));assert.equal(await page.locator('#model').inputValue(),'preserved-on-read-failure');assert.equal(await page.locator('#model').isDisabled(),false);assert.equal((await writes(page)).length,0);
    await page.evaluate(()=>window.paperDigestFlushSettings());assert.equal(await page.evaluate(()=>fixture.settings.model),'preserved-on-read-failure');
  });
  console.log(`Settings UI: ${passed} passed; real bundled UI with explicit local native fixtures; no remote requests or private profile IO`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
