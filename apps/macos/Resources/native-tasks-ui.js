// UI-only coordination. No row data, service commands, paths or credentials cross this module.
export function createNativeTasksUI({call,getView,getOwner,onOpenSaved,onError,document=globalThis.document,randomID=()=>crypto.randomUUID(),randomFocusID=()=>crypto.randomUUID()}){
 let enabled=false,clientID='',nonce=null,sequence=0,revision=0,ownerKey='',bootstrapPending=null,ack=0,focusPending=false,focusOwner='',focusIntent='',focusInFlight=false;
 const key=()=>JSON.stringify(getOwner());
 function cancelFocusIntent(){focusInFlight=false;focusPending=false;focusOwner='';focusIntent='';document.documentElement.setAttribute('data-native-tasks-focus-intent','');}
 function revokeFocusIntent(){const refresh=focusInFlight&&focusPending&&focusIntent&&enabled&&getView()==='tasks'&&focusOwner===key()&&ownerKey===key()&&nonce;cancelFocusIntent();if(refresh)update().catch(onError);}
 document.defaultView?.addEventListener('blur',event=>{if(event.target===document.defaultView)cancelFocusIntent();},true);
 for(const event of ['pointerdown','focusin'])document.defaultView?.addEventListener(event,revokeFocusIntent,true);
 document.defaultView?.addEventListener('keydown',event=>{if(event.key==='Tab')revokeFocusIntent();},true);
 const current=c=>c.revision===revision&&c.owner===key()&&c.view===getView();
 const pane=()=>document.getElementById('tasks-view');
 function clearWeb(){if(!enabled)return;const p=pane();if(!p)return;p.replaceChildren();p.inert=true;p.setAttribute('aria-hidden','true');}
 function failed(){const p=pane();if(!p)return;p.replaceChildren();const text=document.createElement('p');text.textContent='任务视图尚未就绪，请重新选择后台任务。原记录保留。';text.setAttribute('role','status');p.append(text);p.inert=false;p.removeAttribute('aria-hidden');}
 function enable(value){enabled=value===true;if(enabled&&!clientID){clientID=randomID().toLowerCase();document.documentElement.setAttribute('data-native-tasks-document',clientID);}return enabled;}
 async function bootstrap(c){
  if(nonce&&ownerKey===c.owner)return nonce;
  const paperID=getOwner().id||'';
  if(!bootstrapPending||bootstrapPending.owner!==c.owner){const promise=call('nativeTasks.bootstrap',{clientID,paperID});bootstrapPending={owner:c.owner,promise};}
  const pending=bootstrapPending,result=await pending.promise;
  if(!current(c))return null;
  if(!result||typeof result.nonce!=='string'||!Number.isSafeInteger(result.highestSequence)||result.highestSequence<0)throw new Error('任务视图的文档绑定未确认');
  nonce=result.nonce;sequence=Math.max(sequence,result.highestSequence);ownerKey=c.owner;if(bootstrapPending===pending)bootstrapPending=null;return nonce;
 }
 async function update({focus=false}={}){
  const c={revision:++revision,owner:key(),view:getView()};if(!enabled)return false;
  if(c.owner!==focusOwner||c.view!=='tasks'){cancelFocusIntent();focusOwner=c.owner;}
  if(focus===true&&c.view==='tasks'){focusPending=true;if(!focusIntent)focusIntent=randomFocusID().toLowerCase();document.documentElement.setAttribute('data-native-tasks-focus-intent',focusIntent);}
  if(c.view==='tasks')clearWeb();
  if(c.view!=='tasks'&&!nonce)return true;
  try{
   const bound=await bootstrap(c);if(!bound||!current(c))return false;
   const request=++sequence,focusRequest=focusPending&&c.view==='tasks',intent=focusRequest?focusIntent:'',payload={nonce:bound,clientID,sequence:request,tasks:c.view==='tasks',paperID:getOwner().id||'',focus:focusRequest};
   if(focusRequest){payload.focusIntent=intent;focusInFlight=true;}
   const result=await call('nativeTasks.present',payload);
   if(!current(c))return false;
   if(result?.accepted!==true)throw new Error('任务视图未接受当前布局');ack=c.view==='tasks'?request:0;if(focusRequest&&focusIntent===intent)cancelFocusIntent();return true;
  }catch(e){if(current(c)){nonce=null;ownerKey='';bootstrapPending=null;ack=0;cancelFocusIntent();if(c.view==='tasks'){failed();onError(new Error('任务视图已变化，请重新选择后台任务'));}}return false;}
 }
 function invalidate(){nonce=null;ownerKey='';bootstrapPending=null;ack=0;cancelFocusIntent();revision++;}
 async function changeLayout(change){
  if(!enabled||getView()!=='tasks'){change();return true;}
  const c={revision:++revision,owner:key(),view:getView()};ack=0;cancelFocusIntent();
  try{
   const bound=await bootstrap(c);if(!bound||!current(c))return false;
   const request=++sequence,result=await call('nativeTasks.present',{nonce:bound,clientID,sequence:request,tasks:false,paperID:getOwner().id||'',focus:false});
   if(!current(c)||result?.accepted!==true)return false;
   change();await update();return true;
  }catch(e){if(current(c)){invalidate();failed();onError(new Error('任务视图布局未确认，请重新选择后台任务'));}return false;}
 }
 async function openSaved(expectedNonce,expectedSequence,paperID){
  if(!enabled||getView()!=='tasks'||ownerKey!==key()||nonce!==expectedNonce||ack!==expectedSequence||sequence!==expectedSequence||typeof paperID!=='string'||!paperID)return false;
  return (await onOpenSaved(paperID))===true;
 }
 return {enable,update,invalidate,clearWeb,changeLayout,openSaved,get enabled(){return enabled;}};
}
