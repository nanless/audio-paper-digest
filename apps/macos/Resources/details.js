import {mountStorage} from './storage-ui.js';
const $=id=>document.getElementById(id);
let presentationID=null,active=true,busy=false,closing=false,storage;
const nativeCall=(command,payload={})=>window.webkit.messageHandlers.desktop.postMessage({command,payload});
function toast(text){if(!active)return;$('toast').textContent=String(text);$('toast').hidden=false;}
function error(e){toast(e?.message||String(e));}
async function call(command,payload={}){
 if(!active||!presentationID)throw new Error('本机资料窗口已关闭或尚未准备完成');
 const owner=presentationID;
 const result=await nativeCall(command,{...payload,presentationID:owner});
 if(!active||presentationID!==owner)throw new Error('本机资料窗口已关闭或更新');
 return result;
}
async function close(){
 if(!active||closing)return;closing=true;controls();
 try{if(!presentationID){const initial=await nativeCall('details.bootstrap');presentationID=initial.presentationID;}const r=await nativeCall('details.close',{presentationID});if(r.closed)active=false;}
 catch(e){error(e);}finally{closing=false;controls();}
}
async function openOffline(id){
 if(!active||busy)return;busy=true;controls();
 try{await call('storage.open',{id});active=false;}
 catch(e){error(e);}finally{busy=false;controls();}
}
function controls(){$('details-close').disabled=!active||closing;$('details-refresh').disabled=!active||busy||closing||!presentationID;}
async function refresh(){if(!active||busy||!storage)return;busy=true;controls();try{await storage.show();}catch(e){error(e);}finally{busy=false;controls();}}
$('details-close').onclick=close;$('details-refresh').onclick=refresh;
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
window.addEventListener('details.closed',()=>{active=false;controls();});
window.paperDigestFlushDetails=async()=>({saved:true});
async function start(){
 const result=await nativeCall('details.bootstrap');if(!active)return;
 presentationID=result.presentationID;if(typeof presentationID!=='string'||!presentationID)throw new Error('本机资料窗口身份不可用');
 document.documentElement.style.colorScheme=result.appearance==='system'?'light dark':result.appearance||'light dark';
 const surface=$('detail-dialog');Object.defineProperty(surface,'open',{get:()=>active});
 surface.showModal=()=>{};surface.close=close;
 storage=mountStorage({call,toast,error},{isCurrent:()=>active,openOffline});
 await refresh();
 if(active){const heading=$('detail-content').querySelector('h1,h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
}
start().catch(e=>{if(!active)return;error(e);$('detail-content').textContent='未能读取本机资料：'+(e.message||String(e));$('details-close').disabled=false;});
