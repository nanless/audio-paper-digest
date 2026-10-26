// UI-only coordination. No row data, service commands, paths or credentials cross this module.
export function createNativeNotesUI({call,getView,getOwner,onOpenNote,onClose,onError,document=globalThis.document,randomID=()=>crypto.randomUUID()}){
 let enabled=false,clientID='',nonce=null,sequence=0,revision=0,ownerKey='',bootstrapPending=null,ack=0;
 const key=()=>JSON.stringify(getOwner());
 const current=c=>c.revision===revision&&c.owner===key()&&c.view===getView();
 const pane=()=>document.getElementById('notes-view');
 function clearWeb(){if(!enabled)return;const p=pane();if(!p)return;p.replaceChildren();p.inert=true;p.setAttribute('aria-hidden','true');}
 function failed(){const p=pane();if(!p)return;p.replaceChildren();const text=document.createElement('p');text.textContent='笔记视图尚未就绪，请重新打开“我的笔记”。原记录保留。';text.setAttribute('role','status');p.append(text);p.inert=false;p.removeAttribute('aria-hidden');}
 function enable(value){enabled=value===true;if(enabled&&!clientID){clientID=randomID().toLowerCase();document.documentElement.setAttribute('data-native-notes-document',clientID);}return enabled;}
 async function bootstrap(c){
  if(nonce&&ownerKey===c.owner)return nonce;
  const paperID=getOwner().id||'';
  if(!bootstrapPending||bootstrapPending.owner!==c.owner){const promise=call('nativeNotes.bootstrap',{clientID,paperID});bootstrapPending={owner:c.owner,promise};}
  const pending=bootstrapPending,result=await pending.promise;
  if(!current(c))return null;
  if(!result||typeof result.nonce!=='string'||!Number.isSafeInteger(result.highestSequence)||result.highestSequence<0)throw new Error('笔记视图的文档绑定未确认');
  nonce=result.nonce;sequence=Math.max(sequence,result.highestSequence);ownerKey=c.owner;if(bootstrapPending===pending)bootstrapPending=null;return nonce;
 }
 async function update({focus=false}={}){
  const c={revision:++revision,owner:key(),view:getView()};if(!enabled)return false;
  if(c.view==='notes')clearWeb();
  if(c.view!=='notes'&&!nonce)return true;
  try{
   const bound=await bootstrap(c);if(!bound||!current(c))return false;
   const request=++sequence,result=await call('nativeNotes.present',{nonce:bound,clientID,sequence:request,notes:c.view==='notes',paperID:getOwner().id||'',focus:focus===true&&c.view==='notes'});
   if(!current(c))return false;
   if(result?.accepted!==true)throw new Error('笔记视图未接受当前布局');ack=c.view==='notes'?request:0;return true;
  }catch(e){if(current(c)){nonce=null;ownerKey='';bootstrapPending=null;ack=0;if(c.view==='notes'){failed();onError(new Error('笔记视图已变化，请重新打开“我的笔记”'));}}return false;}
 }
 function invalidate(){nonce=null;ownerKey='';bootstrapPending=null;ack=0;revision++;}
 async function changeLayout(change){
  if(!enabled||getView()!=='notes'){change();return true;}
  const c={revision:++revision,owner:key(),view:getView()};ack=0;
  try{
   const bound=await bootstrap(c);if(!bound||!current(c))return false;
   const request=++sequence,result=await call('nativeNotes.present',{nonce:bound,clientID,sequence:request,notes:false,paperID:getOwner().id||'',focus:false});
   if(!current(c)||result?.accepted!==true)return false;
   change();await update();return true;
  }catch(e){if(current(c)){invalidate();failed();onError(new Error('笔记视图布局未确认，请重新打开“我的笔记”'));}return false;}
 }
 async function openNote(expectedNonce,expectedSequence,paperID){
  if(!enabled||getView()!=='notes'||ownerKey!==key()||nonce!==expectedNonce||ack!==expectedSequence||sequence!==expectedSequence||typeof paperID!=='string'||!paperID)return false;
  return (await onOpenNote(paperID))===true;
 }
 async function close(expectedNonce,expectedSequence){
  if(!enabled||getView()!=='notes'||ownerKey!==key()||nonce!==expectedNonce||ack!==expectedSequence||sequence!==expectedSequence)return false;
  return (await onClose())===true;
 }
 return {enable,update,invalidate,clearWeb,changeLayout,openNote,close,get enabled(){return enabled;}};
}
