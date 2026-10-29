import {mountStorage} from './storage-ui.js';
import {mountHelp,mountExport} from './detail-content.js';
import {mountZotero} from './zotero-ui.js';
const $=id=>document.getElementById(id);
let presentationID=null,active=true,busy=false,operationBusy=0,closing=false,storage,content,zotero,kind='storage';
const nativeCall=(command,payload={})=>window.webkit.messageHandlers.desktop.postMessage({command,payload});
function toast(text){if(!active)return;$('toast').textContent=String(text);$('toast').hidden=false;}
function error(e){toast(e?.message||String(e));}
async function call(command,payload={}){
 if(!active||!presentationID)throw new Error('详情窗口已关闭或尚未准备完成');
 const owner=presentationID;
 const operation=!['storage.status','storage.packages','storage.cleanupPlan','zotero.status','zotero.collections','zotero.open'].includes(command);
 if(operation){operationBusy++;controls();}
 try{
  const result=await nativeCall(command,{...payload,presentationID:owner});
  if(!active||presentationID!==owner)throw new Error('详情窗口已关闭或更新');
  return result;
 }finally{if(operation){operationBusy--;controls();}}
}
async function close(){
 if(!active||closing||operationBusy>0)return;closing=true;controls();
 try{if(!presentationID){const initial=await nativeCall('details.bootstrap');presentationID=initial.presentationID;}const r=await nativeCall('details.close',{presentationID});if(r.closed){active=false;content?.dispose();}}
 catch(e){error(e);}finally{closing=false;controls();}
}
async function openOffline(id){
 if(!active||busy)return;
 try{await call('storage.open',{id});active=false;}
 catch(e){error(e);}finally{controls();}
}
function controls(){$('details-close').disabled=!active||operationBusy>0||closing;$('details-refresh').disabled=!active||busy||operationBusy>0||closing||!presentationID;}
async function refresh(){if(!active||busy||!storage)return;busy=true;controls();try{await storage.show();}catch(e){error(e);}finally{busy=false;controls();}}
$('details-close').onclick=close;$('details-refresh').onclick=refresh;
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
window.addEventListener('details.closed',()=>{active=false;content?.dispose();controls();});
window.addEventListener('job.progress',event=>{if(active&&event.detail.progress?.role)zotero?.handleProgress(event.detail.progress);});
window.paperDigestFlushDetails=async()=>({saved:true});
function mountArchive(paper){
 const container=$('detail-content');
 // The native window is the modal. This ordinary visible section contains the
 // shared archive controls; no nested HTML dialog or hidden facade is created.
 container.innerHTML='<section id="archive-dialog" class="archive-dialog native-archive-content"><form><h1>存入 Zotero</h1><p class="dialog-subtitle">保存原文、网站导读与自己的研究。</p><div class="archive-paper"><div><h2 id="archive-title">当前论文</h2><p id="archive-identity"></p></div></div><label class="archive-option"><input type="checkbox" checked disabled><span>书目与原始元数据<small>保留用户条目字段，另存完整来源记录</small></span></label><label class="archive-option"><input id="archive-pdf" type="checkbox"><span>原始 PDF<small id="archive-pdf-detail"></small></span></label><label class="archive-option"><input id="archive-guide" type="checkbox"><span>图文导读<small id="archive-guide-detail"></small></span></label><label class="archive-option"><input id="archive-note" type="checkbox"><span>个人研究笔记<small id="archive-note-detail"></small></span></label><div class="archive-destination"></div><div class="archive-connection"></div><footer><button id="archive-connect" type="button"></button></footer></form></section><section data-setting-pane="zotero" hidden></section>';
 const archive=$('archive-dialog');Object.defineProperty(archive,'open',{get:()=>active});archive.showModal=()=>{};archive.close=close;
 archive.querySelector('form').onsubmit=event=>event.preventDefault();
 zotero=mountZotero({call,toast,error,state:{paper},exportArchiveMaterials:()=>call('archive.materials')});
 const history=document.createElement('section');history.className='native-archive-history';history.setAttribute('aria-label','原归档记录');
 const explanation=document.createElement('p');explanation.className='settings-help';explanation.textContent='已有归档沿原论文、材料和目标分类续传或回读核验；不会按当前预览另建书目。';
 history.append(explanation,$('zotero-pending'),$('zotero-recent'));archive.append(history);
 return zotero.openArchive();
}
function mountSourceNotices(context,snapshot){
 if(snapshot?.contract!=='reader-source-notice-snapshot-v1'||snapshot.paperID!==context?.paperID||snapshot.revisionSHA256!==context?.revision||!Array.isArray(snapshot.notices)||!snapshot.notices.length||snapshot.notices.some(x=>typeof x!=='string'||!x.trim()))throw new Error('来源说明与本窗口导读身份不符');
 const container=$('detail-content'),section=document.createElement('section');section.className='native-source-notices';
 const heading=document.createElement('h1');heading.textContent='导读来源说明';
 const identity=document.createElement('p');identity.className='dialog-subtitle';identity.textContent=context.title||context.paperID;
 section.append(heading,identity);
 for(const text of snapshot.notices){const paragraph=document.createElement('p');paragraph.className='native-source-notice-text';paragraph.textContent=text;section.append(paragraph);}
 container.replaceChildren(section);
}
async function start(){
 const result=await nativeCall('details.bootstrap');if(!active)return;
 presentationID=result.presentationID;if(typeof presentationID!=='string'||!presentationID)throw new Error('详情窗口身份不可用');
 kind=result.kind||'storage';if(!['storage','help','export','zotero','source-notices'].includes(kind))throw new Error('未知详情内容');
 document.title=result.title+' · 论文速递工作台';$('details-title').textContent='论文速递工作台 · '+result.title;$('detail-dialog').setAttribute('aria-label',result.title);
 $('details-refresh').hidden=kind!=='storage';
 document.documentElement.style.colorScheme=result.appearance==='system'?'light dark':result.appearance||'light dark';
 const surface=$('detail-dialog');Object.defineProperty(surface,'open',{get:()=>active});surface.showModal=()=>{};surface.close=close;
 if(kind==='storage'){storage=mountStorage({call,toast,error},{isCurrent:()=>active,openOffline});await refresh();}
 else if(kind==='help')content=mountHelp($('detail-content'),{call,close,showClose:false});
 else if(kind==='export')content=mountExport($('detail-content'),{call,close,context:result.context,showClose:false});
 else if(kind==='source-notices')mountSourceNotices(result.context,result.sourceNotices);
 else await mountArchive(result.paper);
 if(active){const heading=$('detail-content').querySelector('h1,h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
 controls();
}
start().catch(e=>{if(!active)return;error(e);$('detail-content').textContent='未能打开详情：'+(e.message||String(e));$('details-close').disabled=false;});
