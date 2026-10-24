import {mountCloud} from './cloud-ui.js';
import {mountZotero} from './zotero-ui.js';
import {installDialogs,revealAccessiblePane} from './dialogs.js';
installDialogs();
const $=id=>document.getElementById(id);
const state={settings:{},paper:null,personal:{}};
let cloudUI,zoteroUI;
let reloadAttempt=0;
const dirty=new Set(); let saveTimer, savePromise=null, discardPromise=null, discarding=false, reloadGeneration=0;
const textKeys=['appearance','endpoint','model','protocol','httpProxy','reasoningEffort'];
const booleanKeys=['reduceMotion','responsesStream'];
const numericKeys=['font','maxTokens','dailyRequests','syncHours'];
const defaults={appearance:'system',endpoint:'',model:'',protocol:'auto',reasoningEffort:'default',httpProxy:'',font:18,maxTokens:8192,dailyRequests:50,syncHours:12};
const call=(command,payload={})=>window.webkit.messageHandlers.desktop.postMessage({command,payload});
const toast=text=>{$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5000);};
const error=e=>toast(e.message||String(e));
const app={call,state,toast,error,emit:(name,detail)=>window.dispatchEvent(new CustomEvent(name,{detail})),exportArchiveMaterials:()=>call('archive.materials')};
const reloadSettings=document.createElement('button');reloadSettings.id='reload-settings';reloadSettings.type='button';reloadSettings.textContent='重新载入设置';reloadSettings.hidden=true;document.querySelector('.settings-content').prepend(reloadSettings);
reloadSettings.onclick=()=>{if(!reloadSettings.disabled&&!discarding)reload().catch(error);};
function ensureMounted(){
 cloudUI??=mountCloud(app);
 if(!zoteroUI){zoteroUI=mountZotero(app);window.addEventListener('job.progress',e=>zoteroUI.handleProgress(e.detail?.progress||{}));}
}

function appearance(){document.documentElement.style.colorScheme=state.settings.appearance==='system'?'light dark':state.settings.appearance||'light dark';}
function value(id){if(booleanKeys.includes(id))return $(id).checked;return numericKeys.includes(id)?Number($(id).value):$(id).value;}
function fill(){for(const id of [...textKeys,...numericKeys])if(!dirty.has(id))$(id).value=state.settings[id]??defaults[id];for(const id of booleanKeys)if(!dirty.has(id))$(id).checked=!!state.settings[id];$('font-label').value=$('font').value;$('key-status').textContent=state.settings.credentialState==='unavailable'?'未能读取钥匙串；可再次主动发送请求并在系统窗口决定是否允许':state.settings.credentialState==='unknown'||state.settings.hasKey==null?'密钥状态未检查；仅在发送新模型请求时访问钥匙串':state.settings.hasKey?'本次已确认密钥存在于 macOS 钥匙串；发送时仍遵循系统访问许可':'尚未保存 API 密钥';appearance();}
function save(){
 if(discarding)return discardPromise.then(()=>save());
 if(savePromise)return savePromise;
 clearTimeout(saveTimer);
 // All callers await the same drain. Newly edited fields join the next write,
 // including fields whose debounce fired while a previous write was pending.
 savePromise=Promise.resolve().then(async()=>{
  try{
   while(dirty.size&&!discarding){
    clearTimeout(saveTimer);
    const keys=[...dirty],changes=Object.fromEntries(keys.map(id=>[id,value(id)]));
    const committed=await call('settings.save',changes);
    reloadGeneration++;state.settings=committed;
    for(const id of keys)if(value(id)===changes[id])dirty.delete(id);
    fill();
   }
   if(!discarding)$('save-status').textContent='设置已保存到本机';
  }catch(e){
   // Keep the draft and stop queued retries. A later edit or explicit flush may
   // retry; an unchanged invalid value must not create a background retry loop.
   clearTimeout(saveTimer);$('save-status').textContent='未保存：'+e.message;throw e;
  }
 }).finally(()=>{savePromise=null;});
 return savePromise;
}
for(const el of document.querySelectorAll('input,select')){
 const changed=()=>{if(discarding)return;dirty.add(el.id);$('save-status').textContent='正在保存…';clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(error),250);};el.addEventListener('input',changed);el.addEventListener('change',changed);
}
$('font').addEventListener('input',()=>$('font-label').value=$('font').value);
document.querySelectorAll('[data-pane]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-pane]').forEach(b=>b.setAttribute('aria-current',b===button?'page':'false'));document.querySelectorAll('[data-setting-pane]').forEach(p=>{if(p.dataset.settingPane===button.dataset.pane)revealAccessiblePane(p);else p.hidden=true;});$('discard-settings').hidden=button.dataset.pane==='cloud';if(button.dataset.pane==='cloud')cloudUI?.refresh().catch(error);});
window.paperDigestShowSettingsPane=pane=>{if(typeof pane!=='string')return false;const button=[...document.querySelectorAll('[data-pane]')].find(button=>button.dataset.pane===pane);if(!button)return false;button.click();return true;};
$('set-key').onclick=async()=>{try{state.settings=await call('model.setKey');fill();}catch(e){error(e);}};
$('delete-key').onclick=async()=>{try{state.settings=await call('model.deleteKey');fill();}catch(e){error(e);}};
$('check-model').onclick=async()=>{try{await save();if(dirty.size)throw new Error('请先完成并保存模型配置');$('check-model').disabled=true;$('model-result').textContent='真实请求执行中…';const r=await call('model.check');$('model-result').textContent=(r.text||r.response||'响应已保存')+' · 实际模型 '+(r.actualModel||'未知')+' · '+(r.protocol||'协议未知')+' · token 用量 '+JSON.stringify(r.usage||null)+' · 金额未知';}catch(e){$('model-result').textContent=e.message;}finally{$('check-model').disabled=false;}};
for(const [id,command]of [['sync-all','library.sync'],['backup','app.backup'],['restore','app.restore'],['reveal','app.revealData'],['diagnostics','app.diagnostics']])$(id).onclick=async()=>{try{$(id).disabled=true;await save();await call(command);$('storage-result').textContent='操作已完成';}catch(e){$('storage-result').textContent=e.message;}finally{$(id).disabled=false;}};
$('discard-settings').onclick=()=>{
 if(discardPromise)return discardPromise;
 clearTimeout(saveTimer);discarding=true;
 let discardAttempt=0,obsoleteReadFailure=false;
 const controls=[...textKeys,...numericKeys,...booleanKeys,'discard-settings'].map(id=>[$(id),$(id).disabled]);
 controls.forEach(([el])=>el.disabled=true);
 // An issued native write cannot be recalled. Let it settle, then discard only
 // the remaining draft against an authoritative read of what really committed.
 discardPromise=(async()=>{
  if(savePromise){try{await savePromise;}catch{}}
  const generation=++reloadGeneration;discardAttempt=++reloadAttempt;reloadSettings.disabled=true;
  let result;
  try{result=await call('app.bootstrap');}
  catch(e){if(generation!==reloadGeneration)obsoleteReadFailure=true;else reloadSettings.hidden=false;throw e;}
  if(generation!==reloadGeneration)throw new Error('设置已在其他视图变化，请重新载入后再放弃编辑');
  state.settings=result.settings;state.personal=result.personal;state.paper=result.paper;
  dirty.clear();fill();ensureMounted();reloadSettings.hidden=true;$('save-status').textContent='已恢复最近保存的设置';
 })().finally(()=>{
  controls.forEach(([el,disabled])=>el.disabled=disabled);if(discardAttempt===reloadAttempt)reloadSettings.disabled=false;discarding=false;discardPromise=null;
 });
 discardPromise.catch(e=>{if(obsoleteReadFailure)return;$('save-status').textContent='未能放弃编辑：'+e.message;error(e);});
 return discardPromise;
};
async function reload(){
 const generation=++reloadGeneration,attempt=++reloadAttempt;reloadSettings.disabled=true;
 try{
  const result=await call('app.bootstrap');if(generation!==reloadGeneration)return;
  state.settings=result.settings;state.personal=result.personal;state.paper=result.paper;fill();ensureMounted();reloadSettings.hidden=true;
 }catch(e){if(generation!==reloadGeneration)return;reloadSettings.hidden=false;throw e;}
 finally{if(attempt===reloadAttempt)reloadSettings.disabled=false;}
}
window.paperDigestFlushSettings=async()=>{clearTimeout(saveTimer);await save();if(dirty.size)throw new Error('设置尚未保存，请先修正后再关闭');return {saved:true};};
window.addEventListener('settings.changed',()=>reload().catch(error));
for(const event of ['paper.changed','local.opened'])window.addEventListener(event,()=>reload().catch(error));
window.addEventListener('personal.changed',()=>{[...document.querySelectorAll('[data-dialog-surface][open]')].reverse().forEach(d=>d.close());reload().catch(error);});
reload().catch(error);
