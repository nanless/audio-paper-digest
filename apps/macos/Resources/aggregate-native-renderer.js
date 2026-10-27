(()=>{'use strict';
function sanitized(input){const doc=new DOMParser().parseFromString(input,'text/html');for(const el of doc.querySelectorAll('script,iframe,object,embed,form,input,button,meta,link,base,style'))el.remove();for(const el of doc.querySelectorAll('*'))for(const a of [...el.attributes]){if(a.name.startsWith('on')||['srcdoc','formaction','action','style'].includes(a.name))el.removeAttribute(a.name);if(['href','src','xlink:href'].includes(a.name)){if(a.value.startsWith('data:image/svg+xml')&&(el.tagName.toLowerCase()!=='img'||a.name!=='src')){el.removeAttribute(a.name);continue;}const link=el.tagName.toLowerCase()==='a'&&a.name==='href';const allowed=link?/^(?:https:\/\/|#)/i.test(a.value):/^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,|#)/i.test(a.value);if(!allowed)el.removeAttribute(a.name);}}for(const el of doc.querySelectorAll('img')){if(!el.getAttribute('src')){el.replaceWith(doc.createTextNode('[图片未缓存]'));}else el.setAttribute('loading','lazy');}return doc.body;}
function escapedAt(text,index){let slashes=0;for(let i=index-1;i>=0&&text[i]==='\\';i--)slashes++;return slashes%2===1;}
function scientificMathAt(text,start){
 if(escapedAt(text,start))return null;
 let open,close,display=false;
 if(text.startsWith('\\[',start)){open='\\[';close='\\]';display=true;}
 else if(text.startsWith('\\(',start)){open='\\(';close='\\)';}
 else if(text.startsWith('$$',start)){open=close='$$';display=true;}
 else if(text[start]==='$'){open=close='$';}
 else return null;
 for(let end=start+open.length;end<text.length;end++){
  if(!display&&text[end]==='\n')return null;
  if(text.startsWith(close,end)&&!escapedAt(text,end)&&end>start+open.length){
   return {start,end:end+close.length,text:text.slice(start+open.length,end),display,raw:text.slice(start,end+close.length)};
  }
 }
 return null;
}
function nextScientificMath(text){for(let i=0;i<text.length;i++){const match=scientificMathAt(text,i);if(match)return match;}return null;}
function renderScientificMath(text,element,display){window.katex.render(text,element,{displayMode:display,throwOnError:false,output:'mathml',trust:false,strict:'warn'});}
function renderMath(body){
 // Rebuild legacy HTML+MathML wrappers directly from their original annotation,
 // without serializing TeX through delimiters a second time.
 for(const el of body.querySelectorAll('.katex,.MathJax')){
  if(!body.contains(el)||el.closest('pre,code'))continue;
  const annotation=el.querySelector('annotation[encoding="application/x-tex"]');
  if(!annotation)continue;
  const display=el.querySelector('math')?.getAttribute('display')==='block'||!!el.closest('.katex-display,.MathJax_Display,mjx-container[display="true"]');
  const replacement=document.createElement('span');renderScientificMath(annotation.textContent,replacement,display);
  el.replaceWith(replacement.querySelector('.katex')||replacement);
 }
 const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),nodes=[];
 while(walker.nextNode()){const node=walker.currentNode;if(!node.parentElement.closest('pre,code,math,annotation'))nodes.push(node);}
 for(const node of nodes){
  const text=node.textContent,fragment=document.createDocumentFragment();let start=0,match;
  while((match=nextScientificMath(text.slice(start)))){
   const offset=start+match.start;fragment.append(text.slice(start,offset));
   const span=document.createElement('span');renderScientificMath(match.text,span,match.display);fragment.append(span);start+=match.end;
  }
  if(start){fragment.append(text.slice(start));node.replaceWith(fragment);}
 }
}

const nonce=window.__nativeAggregateNonce,main=document.querySelector('body > main');
if(!main||typeof nonce!=='string')return;
let prepared=false,failed=false,styleVersion=-1,headings=[],eventNonce=nonce;
window.__nativeAggregateSetAppearance=(token,scheme,font,version)=>{
 if(token!==nonce||!['light','dark','system'].includes(scheme)||!Number.isFinite(font)||font<16||font>24||!Number.isSafeInteger(version)||version<styleVersion)return false;
 styleVersion=version;document.documentElement.style.colorScheme=scheme==='system'?'light dark':scheme;document.documentElement.style.setProperty('--font',font+'px');return true;
};
window.__nativeAggregateScrollHeading=(token,index)=>{if(token!==nonce||!prepared||!Number.isSafeInteger(index)||index<0||index>=headings.length)return false;headings[index].scrollIntoView();return true;};
window.__nativeAggregateReportReady=token=>{if(token!==nonce||!main.isConnected)return false;if(failed){window.webkit.messageHandlers.aggregateReader.postMessage({nonce:eventNonce,kind:'failed'}).catch(()=>{});return false;}if(!prepared||document.readyState!=='complete')return false;window.webkit.messageHandlers.aggregateReader.postMessage({nonce:eventNonce,kind:'ready'}).catch(()=>{});return true;};
window.__nativeAggregateResume=(token,lease)=>{if(token!==nonce||typeof lease!=='string'||!/^[0-9a-f-]{36}$/.test(lease))return false;eventNonce=lease;return window.__nativeAggregateReportReady(nonce);};
try{
 const body=sanitized(main.innerHTML);renderMath(body);main.replaceChildren(...body.childNodes);
 headings=[...main.querySelectorAll('h2,h3')];for(const [index,heading]of headings.entries()){if(!heading.id)heading.id='aggregate-heading-'+index;}
 document.addEventListener('click',event=>{const anchor=event.target.closest('a');if(!anchor)return;event.preventDefault();const index=anchor.getAttribute('data-aggregate-link');if(!index||!/^(?:0|[1-9][0-9]*)$/.test(index))return;window.webkit.messageHandlers.aggregateReader.postMessage({nonce:eventNonce,kind:'link',index:Number(index)}).then(result=>{if(result?.kind==='anchor'&&typeof result.anchor==='string')document.getElementById(result.anchor)?.scrollIntoView();}).catch(()=>{});});
 prepared=true;const appearance=window.__nativeAggregateInitialAppearance;if(appearance)window.__nativeAggregateSetAppearance(nonce,appearance.scheme,appearance.font,0);
 if(document.readyState==='complete')window.__nativeAggregateReportReady(nonce);else window.addEventListener('load',()=>window.__nativeAggregateReportReady(nonce),{once:true});
}catch(_){failed=true;window.__nativeAggregateReportReady(nonce);}
})();
