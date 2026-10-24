// Give newly revealed content a fresh visible accessibility container. Preserve
// the actual input nodes and handlers; never recreate the guide/PDF iframe.
export function revealAccessiblePane(pane,{focus=true}={}){
 if(!pane)return null;
 let visible=pane;
 if(pane.hidden){
  visible=pane.cloneNode(false);visible.hidden=false;
  visible.append(...pane.childNodes);pane.replaceWith(visible);
 }
 if(focus)requestAnimationFrame(()=>{
  if(!visible.isConnected||visible.hidden||visible.closest('[hidden],[inert]'))return;
  const heading=visible.querySelector('h1,h2,h3');
  if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  else visible.querySelector('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')?.focus({preventScroll:true});
 });
 return visible;
}

// The shared detail panel starts inside a closed native dialog. WebKit can keep
// that original wrapper ignored even after its children enter a visible surface.
// Refresh only this wrapper, preserving live child nodes and their handlers.
// Zotero owns a different dialog and retains all of its original control nodes.
export function refreshDetailContainer(){
 const previous=document.getElementById('detail-content');
 if(!previous)throw new Error('研究详情容器不可用');
 const content=previous.cloneNode(false);
 content.append(...previous.childNodes);previous.replaceWith(content);
 return content;
}

// A closed HTMLDialogElement can retain an ignored WebKit AX subtree after it is
// shown. Keep it as the stable API facade, but mount the actual, original controls
// in a fresh generic modal region outside the inert app shell on every opening.
export function installDialogs(){
 const bound=new WeakSet(),opened=[];
 const shell=()=>document.getElementById('app-window')||document.querySelector('.settings-body');
 const reconcile=()=>{const open=opened.length>0;document.body.classList.toggle('has-dialog',open);const root=shell();if(root)root.inert=open;for(const entry of opened)entry.surface.inert=entry!==opened.at(-1);window.dispatchEvent(new CustomEvent('modal.changed',{detail:{open}}));};
 const focusable=surface=>[...surface.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>!el.closest('[hidden],[inert]')&&el.getClientRects().length);
 const focusModal=entry=>requestAnimationFrame(()=>setTimeout(()=>{
  if(opened.at(-1)!==entry||!entry.surface.isConnected||entry.surface.closest('[hidden],[inert]'))return;
  // Do not take focus back after the user has already entered a modal control.
  if(entry.surface.contains(document.activeElement))return;
  const heading=entry.surface.querySelector('h1,h2');
  // Focus the visible title rather than an old control moved out of the initially
  // closed native dialog. A separate task after rendering lets WebKit publish
  // the new AX subtree before delivering its focused-element notification.
  if(heading&&!heading.closest('[hidden],[inert]')&&heading.getClientRects().length){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  else focusable(entry.surface)[0]?.focus({preventScroll:true});
 },0));
 function bind(dialog){
  if(bound.has(dialog))return;bound.add(dialog);
  const id=dialog.id,classes=dialog.className,originalQuery=dialog.querySelector.bind(dialog),originalQueryAll=dialog.querySelectorAll.bind(dialog);
  let entry=null;
  // The facade must never participate in WebKit's native modal AX selection.
  // Only the visible generic surface owns dialog semantics.
  dialog.removeAttribute('open');dialog.removeAttribute('role');dialog.removeAttribute('aria-modal');
  Object.defineProperty(dialog,'open',{configurable:true,get:()=>!!entry});
  dialog.querySelector=selector=>entry?entry.surface.querySelector(selector):originalQuery(selector);
  dialog.querySelectorAll=selector=>entry?entry.surface.querySelectorAll(selector):originalQueryAll(selector);
  dialog.showModal=()=>{
   if(entry){const heading=entry.surface.querySelector('h1,h2');if(heading)entry.surface.setAttribute('aria-label',heading.textContent);focusModal(entry);return;}
   const previousFocus=document.activeElement,surface=document.createElement('section');
   surface.id=id;surface.className=classes;surface.dataset.dialogSurface='';surface.setAttribute('role','dialog');surface.setAttribute('open','');
   // Experimental WK compatibility: omit aria-modal while retaining role, inert
   // background, top-surface focus and Tab/Escape isolation. The real app's
   // correctly focused/visible modal still had an empty native AX tree; this
   // single-variable candidate requires actual Mac verification, not DOM proof.
   const heading=originalQuery('h1,h2');surface.setAttribute('aria-label',heading?.textContent||(id==='archive-dialog'?'存入 Zotero':'研究详情'));
   surface.style.cssText='display:block;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;z-index:200;overflow:auto;max-height:calc(100vh - 48px)';
   // Keep the existing facade reference valid for Zotero/storage async callbacks,
   // while global ID lookups and CSS resolve to the actual visible region.
   dialog.id=id+'-facade';dialog.className='';dialog.setAttribute('aria-hidden','true');dialog.style.display='none';
   surface.append(...dialog.childNodes);document.body.append(surface);
   entry={dialog,surface,previousFocus};opened.push(entry);
   surface.showModal=dialog.showModal;surface.close=value=>dialog.close(value);
   Object.defineProperty(surface,'open',{get:()=>!!entry});
   surface.addEventListener('submit',event=>{
    if(event.target.getAttribute('method')==='dialog'){
     event.preventDefault();event.stopImmediatePropagation();
     if(event.submitter?.value==='cancel')dialog.close('cancel');
    }
   },true);
   reconcile();focusModal(entry);
  };
  dialog.close=(value='')=>{
   if(!entry)return;
   const closing=entry;entry=null;opened.splice(opened.indexOf(closing),1);
   dialog.returnValue=value;dialog.append(...closing.surface.childNodes);closing.surface.remove();dialog.removeAttribute('aria-hidden');dialog.style.removeProperty('display');dialog.id=id;dialog.className=classes;
   reconcile();dialog.dispatchEvent(new Event('close'));
   const remaining=opened.at(-1);
   if(remaining&&!remaining.surface.contains(closing.previousFocus))focusModal(remaining);
   else if(closing.previousFocus?.isConnected&&!closing.previousFocus.closest('[inert],[hidden]'))closing.previousFocus.focus({preventScroll:true});
   else if(remaining)focusModal(remaining);
  };
 }
 const scan=()=>{document.querySelectorAll('dialog').forEach(bind);};
 new MutationObserver(scan).observe(document.body,{childList:true,subtree:true});
 document.addEventListener('keydown',event=>{
  const top=opened.at(-1);if(!top)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();top.dialog.close('cancel');}
  if(event.key==='Tab'){
   const fields=focusable(top.surface);if(!fields.length){event.preventDefault();return;}
   const index=fields.indexOf(document.activeElement);
   if(event.shiftKey&&(index<=0)){event.preventDefault();fields.at(-1).focus();}
   else if(!event.shiftKey&&(index<0||index===fields.length-1)){event.preventDefault();fields[0].focus();}
  }
 });
 window.addEventListener('personal.changed',()=>{for(const entry of [...opened].reverse())entry.dialog.close('cancel');});
 scan();
}
