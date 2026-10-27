'use strict';
/* Production applySettings and CSS in a controlled browser. These checks establish
 * computed scroll behavior, not the duration of a visible/native scroll animation. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mac=process.env.PD_MOTION_MAC||path.resolve(__dirname,'..');
const {chromium}=require(path.join(mac,'node_modules/playwright'));
const {server,installFixture,fixture}=require(path.join(mac,'Tests/DesktopUI.test.cjs'));
const styles=process.env.PD_MOTION_STYLES||path.join(mac,'Resources/styles.css');
fs.mkdirSync(path.join(mac,'.qa'),{recursive:true});
const output=process.env.PD_MOTION_OUTPUT||fs.mkdtempSync(path.join(mac,'.qa/reduced-motion-'));
fs.mkdirSync(output,{recursive:true});assert.equal(fs.existsSync(path.join(output,'result.json')),false);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inputs=Object.fromEntries([__filename,styles,...['Resources/native.js','Resources/index.html','Tests/DesktopUI.test.cjs'].map(f=>path.join(mac,f))].map(f=>[f,sha(f)]));
const css=fs.readFileSync(styles),results=[];let browser;
(async()=>{try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  for(const [setting,system,expected] of [[false,'no-preference','smooth'],[true,'no-preference','auto'],[false,'reduce','auto']]){
    const page=await browser.newPage(),errors=[],external=[];
    const result={setting,system,expected,passed:false};
    try{
      page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
      await page.emulateMedia({reducedMotion:system});
      await page.route('https://**',r=>{external.push(r.request().url());return r.abort();});
      await page.route('**/styles.css',r=>r.fulfill({contentType:'text/css',body:css}));
      await installFixture(page,{nativeStorageWindow:true,settings:{...fixture.settings,reduceMotion:setting}});
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.locator('[data-library-open]').first().click();
      await page.waitForFunction(()=>document.querySelector('#guide-frame')?.contentDocument?.querySelector('main'));
      result.actual=await page.evaluate(()=>{
        const pane=document.querySelector('#guide-pane');
        return {configured:__fixture.settings.reduceMotion,appClass:document.body.classList.contains('reduce-motion'),systemReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,scrollBehavior:getComputedStyle(pane).scrollBehavior,scrollHeight:pane.scrollHeight,clientHeight:pane.clientHeight,calls:__calls.map(c=>c.command),unimplemented:__unimplemented};
      });
      assert.equal(result.actual.configured,setting);assert.equal(result.actual.appClass,setting);
      assert.equal(result.actual.systemReduced,system==='reduce');
      assert.equal(result.actual.scrollBehavior,expected);
      assert.equal(result.actual.calls.some(c=>/^(model\.|zotero\.)/.test(c)),false);
      assert.deepEqual(result.actual.unimplemented,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      result.passed=true;console.log('PASS reduceMotion='+setting+' OS='+system+' => '+expected);
    }catch(e){result.error=e.stack;console.error('FAIL reduceMotion='+setting+' OS='+system+': '+e.message);}
    finally{results.push(result);await page.close();}
  }
}finally{
  await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
  const inputsChanged=Object.keys(inputs).filter(f=>sha(f)!==inputs[f]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({scope:'Production applySettings/CSS computed styles with a controlled browser/native bridge fixture; no native GUI/provider/model/user data. Does not establish visible animation duration or overflow.',inputs,inputsChanged,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2)+'\n');
  if(inputsChanged.length||results.length!==3||results.some(r=>!r.passed))process.exitCode=1;
}})().catch(e=>{console.error(e);process.exitCode=1;});
