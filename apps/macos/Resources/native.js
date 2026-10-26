import {Marked} from './vendor/marked.esm.js';
import {mountLibrary} from './library-ui.js';
import {mountZotero} from './zotero-ui.js';
import {installDialogs,revealAccessiblePane,refreshDetailContainer} from './dialogs.js';
import {mountStorage} from './storage-ui.js';
import {createNativeTasksUI} from './native-tasks-ui.js';
installDialogs();
const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={paper:null,article:null,personal:{},settings:{},summary:{},catalog:[],view:'library',mode:'guide',pdf:false,pdfStatus:{},noteDirty:false};
let library,zotero,storageUI,noteTimer,readingTimer,opening=0,guideFrame,noteSaving,annotationSaving;
const annotationDrafts=new Map();let annotationTimer,pdfRequest=0,pdfPending=null,settingsReload=0,settingsEvents=0,previewRequest=0;
const readingWrites=new Map();
let fontTarget=null,fontSaving=null,fontRevision=0;
// Keep each native WebKit accessibility subtree bounded without discarding history.
const taskPageSize=20;let taskPage=0;
function viewIdentity(){return {id:state.paper?.id,generation:opening};}
function isCurrent(v){return v.id===state.paper?.id&&v.generation===opening;}
async function pdfAction(command,payload={}){const context=viewIdentity();try{const r=await call(command,payload);if(!isCurrent(context))return false;if(r.paperID&&r.paperID!==context.id)return false;state.pdfStatus=r;updatePDF();return r;}catch(e){if(isCurrent(context))error(e);return false;}}
async function call(command,payload={}){return await window.webkit.messageHandlers.desktop.postMessage({command,payload});}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5000);}
function error(e){toast(e?.message||String(e));console.error(e?.message||String(e));}
function icons(){window.lucide?.createIcons();}
function emit(name,detail){window.dispatchEvent(new CustomEvent(name,{detail}));}
const app={call,state,toast,error,emit,openPaper,setView,exportArchiveMaterials,openOffline};
let nativeTasksUI=null;
function installNativeTasksUI(){if(nativeTasksUI)return;nativeTasksUI=createNativeTasksUI({call,getView:()=>state.view,getOwner:viewIdentity,onError:error,onOpenSaved:async paperID=>{const p=state.catalog.find(p=>p.id===paperID)||state.personal.personalPapers?.[paperID];if(!p){toast('原论文已不在当前目录，已保存的请求与费用仍完整保留在备份中');return false;}const pending=openPaper(p,{resume:true}),token=opening;await pending;return token===opening&&state.paper?.id===paperID&&state.view==='reader';}});nativeTasksUI.enable(true);}
window.paperDigestNativeTasksOpenSaved=(nonce,sequence,paperID)=>nativeTasksUI?.openSaved(nonce,sequence,paperID)??false;
window.addEventListener('nativeTasks.layout',()=>{if(nativeTasksUI){nativeTasksUI.invalidate();nativeTasksUI.update().catch(error);}});

function applySettings(){const s=state.settings;document.documentElement.style.colorScheme=s.appearance==='system'?'light dark':s.appearance||'light dark';document.documentElement.style.setProperty('--article-font',(s.font||18)+'px');document.body.classList.toggle('reduce-motion',!!s.reduceMotion);}
function applyReaderFrameSettings(frame){
 if(!frame?.isConnected)return;
 const root=frame.contentDocument?.documentElement;if(!root)return;
 root.style.colorScheme=state.settings.appearance==='system'?'light dark':state.settings.appearance||'light dark';
 root.style.setProperty('--font',(Number(state.settings.font)||18)+'px');
}
function installSettings(next){
 const previous=state.settings,reflow=previous.font!==next.font||previous.appearance!==next.appearance;
 if(reflow)captureGuideScroll();
 state.settings=next;applySettings();
 if(reflow){
  for(const entry of readerFrames.values())if(entry.owner.id===state.paper?.id)applyReaderFrameSettings(entry.frame);
  if(validGuideAnchor())guideAnchor.suspended=true;
  queueGuideReflow();
 }
}
function changeFont(delta){
 if(!Number.isFinite(delta))return;
 fontTarget=Math.max(16,Math.min(24,(fontTarget??state.settings.font??18)+delta));fontRevision++;
 if(fontSaving)return fontSaving;
 fontSaving=(async()=>{try{while(fontTarget!==null){const target=fontTarget,revision=fontRevision;await saveReading();const committed=await call('settings.save',{font:target});++settingsReload;installSettings(committed);if(revision===fontRevision)fontTarget=null;}}catch(e){fontTarget=null;error(e);}finally{fontSaving=null;}})();
 return fontSaving;
}
function sanitized(input){const doc=new DOMParser().parseFromString(input,'text/html');for(const el of doc.querySelectorAll('script,iframe,object,embed,form,input,button,meta,link,base,style'))el.remove();for(const el of doc.querySelectorAll('*'))for(const a of [...el.attributes]){if(a.name.startsWith('on')||['srcdoc','formaction','action','style'].includes(a.name))el.removeAttribute(a.name);if(['href','src','xlink:href'].includes(a.name)){if(a.value.startsWith('data:image/svg+xml')&&(el.tagName.toLowerCase()!=='img'||a.name!=='src')){el.removeAttribute(a.name);continue;}const link=el.tagName.toLowerCase()==='a'&&a.name==='href';const allowed=link?/^(?:https:\/\/|#)/i.test(a.value):/^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,|#)/i.test(a.value);if(!allowed)el.removeAttribute(a.name);}}for(const el of doc.querySelectorAll('img')){if(!el.getAttribute('src')){el.replaceWith(doc.createTextNode('[图片未缓存]'));}else el.setAttribute('loading','lazy');}return doc.body;}
// Both Markdown and published HTML use the same escape-aware TeX delimiters.
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
function markdownHTML(text){
 // Let Markdown own code, links and escaping. The extension runs only at actual
 // inline-token boundaries, so code examples never become placeholder markup.
 const parser=new Marked({extensions:[{name:'scientificMath',level:'inline',
  start(source){return nextScientificMath(source)?.start;},
  tokenizer(source){const match=scientificMathAt(source,0);if(match)return {type:'scientificMath',...match};},
  renderer(token){const span=document.createElement('span');renderScientificMath(token.text,span,token.display);return span.outerHTML;}
 }]});
 return sanitized(parser.parse(String(text))).innerHTML;
}
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
const readerCSS=`:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:light-dark(#fdfdfc,#222326);color:light-dark(#24272b,#ebebe7);font:var(--font,18px)/1.95 -apple-system,'PingFang SC',sans-serif;overflow-wrap:break-word}main{max-width:810px;margin:0 auto;padding:54px 52px 90px}h1{font-size:31px;line-height:1.42;letter-spacing:-.6px;margin:10px 0 18px}h2{font-size:24px;margin:40px 0 16px;line-height:1.5}h3{font-size:20px;margin:26px 0 12px}p{margin:16px 0}small,.meta{color:light-dark(#656b72,#b1b4b9);font-size:13px}.original{font-size:16px;line-height:1.65;color:light-dark(#656b72,#b1b4b9)}.eyebrow{font-size:11px;letter-spacing:1.4px;color:light-dark(#3468cf,#98b8ff)}.meta{padding:18px 0;border-block:1px solid light-dark(#dedfdb,#414348);margin:24px 0 30px}img{max-width:100%;height:auto;display:block;margin:24px auto;background:#fff;border-radius:5px}figure{margin:25px 0}figcaption{font-size:13px;color:light-dark(#656b72,#b1b4b9);line-height:1.7}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;font-size:14px;line-height:1.7;margin:22px 0}th,td{padding:10px 12px;border:1px solid light-dark(#d5d8da,#515459);white-space:normal;min-width:75px}th{background:light-dark(#f1f3f2,#333638)}pre{overflow:auto;white-space:pre-wrap;background:light-dark(#f0f1ee,#313337);padding:18px;font-size:14px;line-height:1.6;border-radius:6px}code{font-size:.88em}blockquote{border-left:3px solid #8b9fa9;margin:24px 0;padding:2px 20px;color:light-dark(#58616a,#bec5ca)}a{color:light-dark(#3468cf,#98b8ff)}math[display=block]{display:block;overflow:auto;margin:24px 0;padding:8px}.notice{font-size:13px;background:light-dark(#f0f1ee,#313337);padding:12px 16px;border-radius:6px}@media(max-width:650px){main{padding:35px 28px 75px}h1{font-size:25px}h2{font-size:21px}}`;
function frameDocument(body,title='论文导读'){const appearance=state.settings.appearance==='system'?'light dark':state.settings.appearance||'light dark';return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${esc(title)}</title><style>${readerCSS}:root{color-scheme:${appearance};--font:${Number(state.settings.font)||18}px}</style></head><body><main>${body}</main></body></html>`;}
// Child frames keep script execution disabled. Native navigation policy turns
// their opaque link capabilities into one narrowly scoped event on this parent.
const readerFrames=new Map();
async function activateReaderLink(token,linkID){
 const entry=readerFrames.get(token),record=entry?.links.get(String(linkID));
 if(!entry||!record||!entry.frame.isConnected||!isCurrent(entry.owner)||state.view!=='reader'||entry.frame.closest('[hidden],[inert]'))return;
 if(record.href.startsWith('#pdf-page-')){
  const page=Number(record.href.slice(10)),source=entry.source;
  if(!source?.pdfSHA||!Number.isSafeInteger(page)||page<1||!Array.isArray(source.pages)||!source.pages.includes(page))throw new Error('引用页不在这次实际研究材料中，未进行定位');
  if(source.paperID&&source.paperID!==entry.owner.id)throw new Error('引用所属论文不同，未进行定位');
  if(!await togglePDF(true)||!isCurrent(entry.owner)||!entry.frame.isConnected)return;
  if(state.pdfStatus.sha256!==source.pdfSHA||(source.sourceVersion&&state.pdfStatus.version!==source.sourceVersion))throw new Error('引用来自不同原文版本，未进行错误定位');
  await pdfAction('pdf.locate',{pdfSHA:source.pdfSHA,page});
 }else if(record.href.startsWith('#')){
  const target=entry.frame.contentDocument?.getElementById(record.href.slice(1));if(target){if(entry.frame===guideFrame)navigateGuideTo(target);else target.scrollIntoView();}
 }else if(/^https:\/\//i.test(record.href))await call('app.external',{url:new URL(record.href).href});
}
window.addEventListener('reader.link',event=>activateReaderLink(event.detail?.token,event.detail?.linkID).catch(error));
function mountFrame(container,html,title,source=null){
 const frame=document.createElement('iframe'),token=crypto.randomUUID().toLowerCase(),body=new DOMParser().parseFromString(html,'text/html').body,links=new Map();
 for(const anchor of body.querySelectorAll('a[href]')){
  const href=anchor.getAttribute('href');anchor.removeAttribute('target');
  if(!href?.startsWith('#')&&!/^https:\/\//i.test(href||'')){anchor.removeAttribute('href');continue;}
  const linkID=String(links.size);links.set(linkID,{href});anchor.setAttribute('href',`paperapp://app/reader-link/${token}/${linkID}`);
 }
 frame.className='article-frame';frame.title=title;frame.setAttribute('sandbox','allow-same-origin');frame.style.cssText='width:100%;height:100%;border:0;display:block';
 for(const [oldToken,entry]of readerFrames)if(!entry.frame.isConnected)readerFrames.delete(oldToken);
 readerFrames.set(token,{token,frame,links,owner:viewIdentity(),source:source?structuredClone(source):null});
 // Bind before insertion: cached srcdoc loads can otherwise outrun listener setup.
 frame.addEventListener('load',()=>{
  applyReaderFrameSettings(frame);
  const doc=frame.contentDocument;if(!doc)return;
  doc.addEventListener('click',event=>{const anchor=event.target.closest('a');if(!anchor)return;event.preventDefault();const href=anchor.getAttribute('href'),prefix=`paperapp://app/reader-link/${token}/`;if(href?.startsWith(prefix))activateReaderLink(token,href.slice(prefix.length)).catch(error);});
 });
 frame.srcdoc=frameDocument(body.innerHTML,title);container.replaceChildren(frame);return frame;
}
function originalFrameHTML(frame){
 const original=frame?.contentDocument?.querySelector('main');if(!original)return '';
 const entry=[...readerFrames.values()].find(value=>value.frame===frame),copy=original.cloneNode(true);
 if(entry)for(const anchor of copy.querySelectorAll('a[href]')){const href=anchor.getAttribute('href'),prefix=`paperapp://app/reader-link/${entry.token}/`;if(href?.startsWith(prefix)){const record=entry.links.get(href.slice(prefix.length));if(record)anchor.setAttribute('href',record.href);}}
 return copy.innerHTML;
}
window.paperDigestFlushPendingNote=async()=>{if(fontSaving)await fontSaving;await saveNote();await saveAnnotations();if(state.paper)await saveReading();return {saved:true};};
window.paperDigestArchiveHTML=()=>{if(!state.paper||!state.article||guideFrame?.dataset.paperID!==state.paper.id||guideFrame?.dataset.revision!==state.article.revisionSHA256)return null;return {paperID:state.paper.id,revision:state.article.revisionSHA256,html:originalFrameHTML(guideFrame)};};
// Restore the first saved guide position only after its requested PDF layout settles.
let initialGuideRestore=null;
function initialGuideRestoreFor(frame=guideFrame){const p=initialGuideRestore;return p&&isCurrent(p.owner)&&p.frame===frame&&(!frame||(frame.dataset.paperID===p.owner.id&&frame.dataset.revision===p.revision&&String(state.article?.revisionSHA256)===p.revision))?p:null;}
function initialGuideSnapshot(){const p=initialGuideRestore;return p&&p.owner.id===state.paper?.id&&p.frame===guideFrame&&(!guideFrame||(guideFrame.dataset.paperID===p.owner.id&&guideFrame.dataset.revision===p.revision&&String(state.article?.revisionSHA256)===p.revision))?p:null;}
function finishInitialGuideLayout(context){const p=initialGuideRestore;if(!p||!isCurrent(context)||p.owner.id!==context.id||p.owner.generation!==context.generation)return;p.waiting=false;layoutPDF();requestAnimationFrame(()=>{if(initialGuideRestore===p&&isCurrent(p.owner))restoreGuidePosition();});}
function cancelInitialGuideRestore(frame){const p=initialGuideRestoreFor(frame);if(!p)return;p.positionCancelled=true;frame.dataset.scrollReady='true';frame.dataset.scrollTarget=String(frame.contentWindow?.scrollY||0);}
function guideScroll(){if(!guideFrame)return initialGuideSnapshot()?.target||0;return guideFrame.dataset.scrollReady==='false'||guideFrame.closest('[hidden]')?Number(guideFrame.dataset.scrollTarget)||0:guideFrame.contentWindow?.scrollY||0;}
let guideAnchor=null,guideReflow=0,guideResize=null;
function visibleGuide(frame=guideFrame){return frame?.isConnected&&!frame.closest('[hidden]')&&frame.clientWidth>0&&frame.clientHeight>0&&frame.dataset.paperID===state.paper?.id&&frame.dataset.revision===String(state.article?.revisionSHA256);}
function validGuideAnchor(anchor=guideAnchor){return anchor&&anchor.frame===guideFrame&&anchor.document===guideFrame?.contentDocument&&anchor.generation===opening&&anchor.paperID===state.paper?.id&&anchor.revision===String(state.article?.revisionSHA256)&&anchor.node.isConnected;}
function guideAnchorRect(anchor){if(anchor.offset!==undefined){const range=anchor.document.createRange();range.setStart(anchor.node,Math.min(anchor.offset,anchor.node.length));range.setEnd(anchor.node,Math.min(anchor.offset+1,anchor.node.length));return range.getBoundingClientRect();}return anchor.node.getBoundingClientRect();}
function rememberGuideAnchor(){
 const frame=guideFrame;if(!visibleGuide(frame)||frame.dataset.scrollReady!=='true'||guideReflow)return;
 // Resize/hidden restoration must use the last geometry from before reflow.
 if(validGuideAnchor()&&(guideAnchor.suspended||guideAnchor.width!==frame.clientWidth||Math.abs(guideAnchor.scrollY-frame.contentWindow.scrollY)<.5))return;
 const doc=frame.contentDocument,main=doc?.querySelector('main');if(!main)return;
 const box=main.getBoundingClientRect(),padding=parseFloat(doc.defaultView.getComputedStyle(main).paddingLeft)||0;
 const x=Math.max(1,Math.min(frame.clientWidth-2,box.left+padding+2));let node,offset,rect,fraction=0;
 // Constant-size hit testing, not a walk through the complete scientific DOM.
 for(const y of [12,28,48,72]){
  const caret=doc.caretRangeFromPoint?.(x,y),position=!caret&&doc.caretPositionFromPoint?.(x,y);
  const text=caret?.startContainer||position?.offsetNode,at=caret?.startOffset??position?.offset;
  if(text?.nodeType!==3||!text.textContent.trim()||!main.contains(text)||text.parentElement.closest('math,.katex,annotation'))continue;
  const candidate={document:doc,node:text,offset:Math.min(at,text.length-1)},r=guideAnchorRect(candidate);
  if(r.height&&r.bottom>0&&r.top<80){node=text;offset=candidate.offset;rect=r;break;}
 }
 if(!node){
  const hit=doc.elementFromPoint(Math.max(1,Math.min(frame.clientWidth-2,box.left+box.width/2)),12);
  node=hit?.closest('img,figure,table,pre,blockquote,h1,h2,h3,h4,p,li')||main;rect=node.getBoundingClientRect();
  if(node.matches('img,figure')&&rect.height)fraction=Math.max(0,Math.min(1,(12-rect.top)/rect.height));
 }
 guideAnchor={frame,document:doc,node,offset,fraction,top:rect.top+rect.height*fraction,width:frame.clientWidth,scrollY:frame.contentWindow.scrollY,generation:opening,paperID:state.paper.id,revision:frame.dataset.revision,suspended:false};
}
function queueGuideReflow(){
 if(!visibleGuide()){if(validGuideAnchor())guideAnchor.suspended=true;return;}
 if(!validGuideAnchor()){guideAnchor=null;rememberGuideAnchor();}
 if(!validGuideAnchor()||guideReflow)return;
 const anchor=guideAnchor;
 if(!anchor.suspended&&anchor.width===anchor.frame.clientWidth)return;
 guideReflow=requestAnimationFrame(()=>{
  if(!validGuideAnchor(anchor)||!visibleGuide(anchor.frame)){guideReflow=0;return;}
  const rect=guideAnchorRect(anchor),delta=rect.top+rect.height*anchor.fraction-anchor.top;
  if(Number.isFinite(delta)&&Math.abs(delta)>.5)anchor.frame.contentWindow.scrollBy(0,delta);
  anchor.width=anchor.frame.clientWidth;anchor.scrollY=anchor.frame.contentWindow.scrollY;anchor.suspended=false;
  anchor.frame.dataset.scrollTarget=String(anchor.frame.contentWindow.scrollY||0);
  // Own scroll events/observer callbacks must not replace the original Range.
  guideReflow=requestAnimationFrame(()=>{guideReflow=0;if(validGuideAnchor(anchor)&&visibleGuide(anchor.frame)&&(anchor.suspended||anchor.frame.clientWidth!==anchor.width))queueGuideReflow();});
 });
}
function cancelGuideReflow(){if(guideReflow)cancelAnimationFrame(guideReflow);guideReflow=0;guideAnchor=null;}
function resetGuideAnchor(){cancelGuideReflow();guideResize?.disconnect();guideResize=null;}
function navigateGuideTo(node,block='start'){cancelInitialGuideRestore(guideFrame);cancelGuideReflow();node.scrollIntoView({behavior:'auto',block});captureGuideScroll();}
function captureGuideScroll(){if(visibleGuide()&&guideFrame.dataset.scrollReady==='true'){guideFrame.dataset.scrollTarget=String(guideFrame.contentWindow?.scrollY||0);rememberGuideAnchor();}}
function restoreGuidePosition(){const pending=initialGuideRestoreFor();if(pending?.waiting&&!pending.positionCancelled)return;if(guideFrame?.dataset.scrollReady==='false'&&visibleGuide()&&guideFrame.contentDocument?.querySelector('main')){guideFrame.contentWindow.scrollTo({top:Number(guideFrame.dataset.scrollTarget)||0,behavior:'instant'});guideFrame.dataset.scrollReady='true';rememberGuideAnchor();}if(pending&&!pending.waiting&&guideFrame?.dataset.scrollReady==='true')initialGuideRestore=null;queueGuideReflow();}
function hasPreambleEnglishTitle(body,title){
 const expected=String(title||'').replace(/\s+/gu,' ').trim();if(!expected)return false;
 for(const node of body.children){
  if(/^H[1-6]$/.test(node.tagName))break;
  if(!['P','BLOCKQUOTE'].includes(node.tagName))continue;
  const text=node.textContent.replace(/\s+/gu,' ').trim(),match=/^英文题目[：:]\s*(.+)$/u.exec(text);
  if(match&&match[1]===expected)return true;
 }
 return false;
}
function updateOutlineVisibility(){$('sidebar-outline').hidden=state.view!=='reader'||state.mode!=='guide'||!state.article;}
function renderGuide(){const p=state.paper,a=state.article;if(!p||!a)return;const previous=guideFrame?.dataset.paperID===p.id?guideFrame:null;const scroll=previous?guideScroll():state.personal.readingState?.[p.id]?.guideScroll||0;const body=sanitized(a.markdown?markdownHTML(a.markdown):a.html||'');if(!a.markdown)renderMath(body);for(const anchor of body.querySelectorAll('h1 a,h2 a,h3 a,h4 a'))if(anchor.getAttribute('href')?.startsWith('#')&&anchor.textContent.trim()==='#')anchor.remove();const firstHeading=body.firstElementChild;if(firstHeading&&/^H[1-3]$/.test(firstHeading.tagName)&&[p.title,p.titleZh].filter(Boolean).includes(firstHeading.textContent.trim().replace(/^📄\s+/u,'')))firstHeading.remove();const sourceVersion=a.sourceVersion||p.sourceVersion,original=p.title&&!hasPreambleEnglishTitle(body,p.title)?`<div class="original">${esc(p.title)}</div>`:'';const heading=`<div class="eyebrow">${esc(p.task||'已发布论文')} · 网站导读</div><h1>${esc(p.titleZh||p.title)}</h1>${original}<p class="meta">${esc((p.authors||[]).join(' · '))}<br>网站发布 ${esc(p.date||'未知')} · ${Number.isFinite(p.score)?'原评分 '+esc(p.score):'网站评分见正文'}${sourceVersion?' · '+esc(sourceVersion):''}</p>`;resetGuideAnchor();guideFrame=mountFrame($('article'),heading+body.innerHTML+(a.notices||[]).map(n=>`<p class="notice">${esc(n)}</p>`).join(''),p.titleZh||p.title);guideFrame.id='guide-frame';guideFrame.dataset.paperID=p.id;guideFrame.dataset.revision=a.revisionSHA256;const renderedFrame=guideFrame;if(initialGuideRestore&&isCurrent(initialGuideRestore.owner)){initialGuideRestore={...initialGuideRestore,frame:renderedFrame,revision:String(a.revisionSHA256)};}renderedFrame.dataset.scrollTarget=String(scroll);renderedFrame.dataset.scrollReady='false';let initialized=false;const initialize=()=>{if(renderedFrame!==guideFrame||state.paper?.id!==p.id)return;const doc=renderedFrame.contentDocument;if(initialized||!doc?.querySelector('main'))return;initialized=true;const outline=$('outline');outline.replaceChildren();for(const [i,h]of [...doc.querySelectorAll('h2,h3')].entries()){if(!h.id)h.id='section-'+i;const button=document.createElement('button');button.textContent=h.textContent;button.onclick=()=>navigateGuideTo(h);outline.append(button);}updateOutlineVisibility();restoreGuidePosition();guideResize=new ResizeObserver(()=>{if(renderedFrame===guideFrame)queueGuideReflow();});guideResize.observe(renderedFrame);for(const name of ['wheel','touchstart','pointerdown'])doc.addEventListener(name,()=>{if(renderedFrame===guideFrame){cancelInitialGuideRestore(renderedFrame);cancelGuideReflow();}},{passive:true,capture:true});doc.addEventListener('keydown',e=>{if(renderedFrame===guideFrame&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)){cancelInitialGuideRestore(renderedFrame);cancelGuideReflow();}},{capture:true});doc.defaultView.addEventListener('scroll',()=>{if(renderedFrame===guideFrame)captureGuideScroll();clearTimeout(readingTimer);const owner=p.id;readingTimer=setTimeout(()=>{if(renderedFrame===guideFrame&&state.paper?.id===owner)saveReading({guideScroll:guideScroll(),pdfPage:state.pdfStatus.page||1}).catch(error);},600);});};renderedFrame.addEventListener('load',initialize);initialize();}
function setReadingSplit(value){const ratio=Number.isFinite(value)?Math.max(38,Math.min(62,value)):46;$('reading-area').style.setProperty('--split',ratio+'%');$('splitter').setAttribute('aria-valuenow',String(Math.round(ratio)));}
function readingSnapshot(extra={}){return {paperID:state.paper?.id,question:$('question').value,scope:$('evidence-scope').value,from:Number($('range-from').value),to:Number($('range-to').value),chapter:Number($('pdf-chapter').value),split:parseFloat(getComputedStyle($('reading-area')).getPropertyValue('--split'))||46,mode:state.mode,pdfPage:state.pdfStatus.page||1,pdfOpen:initialGuideSnapshot()?.waiting?true:state.pdf,guideScroll:guideScroll(),...extra};}
async function saveReading(extra={}){if(!state.paper)return;const snapshot=readingSnapshot(extra),revision=(readingWrites.get(snapshot.paperID)||0)+1;readingWrites.set(snapshot.paperID,revision);await call('personal.reading',snapshot);if(readingWrites.get(snapshot.paperID)!==revision)return;state.personal.readingState??={};state.personal.readingState[snapshot.paperID]={...snapshot,updatedAt:new Date().toISOString()};}
async function saveNote(){
 if(noteSaving)return await noteSaving;
 noteSaving=(async()=>{while(state.paper&&state.noteDirty){clearTimeout(noteTimer);const id=state.paper.id,text=$('note-editor').value,previous=state.personal.notes?.[id]||{};const saved=await call('personal.note',{paperID:id,text,baseRevision:previous.revision||0});state.personal.notes??={};state.personal.notes[id]=saved;if(state.paper?.id===id&&$('note-editor').value===text){state.noteDirty=false;$('note-status').textContent='已保存到本机';}else if(state.paper?.id!==id)break;}})();
 try{return await noteSaving;}finally{noteSaving=null;}
}
function restoreDraft(p){
 document.querySelector('.source-excerpt').style.display='none';$('source-abstract').textContent='';$('source-page').textContent='原文选区';$('context-label').textContent='选择当前材料范围';$('pdf-chapter').innerHTML='<option value="-1">打开原文后读取真实目录</option>';
 const saved=state.personal.readingState?.[p.id]||{};
 $('question').value=saved.question||'';$('evidence-scope').value=saved.scope|| (p.sourceKind==='local'?'page':'guide');
 $('range-from').value=saved.from||1;$('range-to').value=saved.to||3;
 document.querySelector('.page-range').hidden=$('evidence-scope').value!=='range';$('pdf-chapter').hidden=$('evidence-scope').value!=='chapter';
 setReadingSplit(saved.split);state.pdfStatus.page=saved.pdfPage||1;
 $('note-editor').value=state.personal.notes?.[p.id]?.text||'';state.noteDirty=false;
 $('sidebar-paper').textContent=p.titleZh||p.title;$('note-context').textContent=p.titleZh||p.title;
 $('favorite').setAttribute('aria-pressed',String((state.personal.favorites||[]).includes(p.id)));updateNote();return saved;
}
async function installReading(p,a,{resume=false}={}){
 resetGuideAnchor();$('outline').replaceChildren();state.paper=p;state.article=a;guideFrame=null;state.pdfStatus={};state.pdf=false;pdfRequest++;pdfPending=null;$('pdf-toggle').disabled=false;
 const saved=restoreDraft(p);initialGuideRestore=resume&&saved.pdfOpen&&p.sourceKind!=='local'?{owner:viewIdentity(),waiting:true,frame:null,target:Number(saved.guideScroll)||0,pdfPage:saved.pdfPage||1}:null;await setView('reader');setMode(resume&&['guide','analysis','note'].includes(saved.mode)?saved.mode:p.sourceKind==='local'?'analysis':'guide');
 if(a)renderGuide();renderSessions();icons();
 if(p.sourceKind==='local'||a&&resume&&saved.pdfOpen){const context=viewIdentity();await togglePDF(true);if(!isCurrent(context))return;finishInitialGuideLayout(context);if(saved.chapter!==undefined)$('pdf-chapter').value=String(saved.chapter);}
}
// Native owns the source and keeps its document sheet until this transaction
// confirms the actual receipt. These references are UI bookkeeping, never source
// authority; no app.setPaper or provider request is issued here.
let nativeOfflineTransaction=null;
window.paperDigestPauseForDetails=paperID=>{
 if((state.paper?.id||'')!==paperID)throw new Error('阅读视图仍在切换，请稍后打开本机资料');
 // The native sheet guards source-changing operations. Keeping this UI generation
 // lets already accepted same-source work settle and preserves current link owners.
 // The actual offline handoff below retires the generation when materials change.
 captureGuideScroll();return {paused:true};
};
window.paperDigestCancelOfflineReceipt=async(presentationID,current)=>{
 const t=nativeOfflineTransaction;
 if(!t||t.id!==presentationID)return {restored:false};
 nativeOfflineTransaction=null;
 if(t.token!==opening)return {restored:false,newerReader:true};
 ++opening;const p=current?.paper||t.previous.paper,a=current?.article||t.previous.article;
 if(!p?.id){state.paper=null;state.article=null;state.pdf=false;state.noteDirty=false;resetGuideAnchor();guideFrame=null;$('outline').replaceChildren();$('article').replaceChildren();await setView('library');return {restored:true};}
 await installReading(p,Object.keys(a||{}).length?a:null);
 if(p.id===t.previous.paper?.id){state.pdf=t.previous.pdf;state.pdfStatus=t.previous.pdfStatus;setMode(t.previous.mode);if(t.previous.view!=='reader')await setView(t.previous.view);layoutPDF();}
 return {restored:true};
};
window.paperDigestInstallOfflineReceipt=async(receipt,presentationID,previousPaperID)=>{
 if(nativeOfflineTransaction)throw new Error('上一份离线快照尚未完成交接');
 if(!receipt?.paper?.id||!receipt.paper.offlinePackageID||(state.paper?.id||'')!==previousPaperID)throw new Error('阅读资料已变化，未接收其他论文的离线快照');
 const token=++opening,previous={paper:state.paper,article:state.article,pdf:state.pdf,pdfStatus:{...state.pdfStatus},mode:state.mode,view:state.view};
 const current=()=>token===opening&&state.paper===previous.paper;
 await saveNote();if(!current())throw new Error('保存期间阅读资料已变化');
 await saveAnnotations();if(!current())throw new Error('保存期间阅读资料已变化');
 if(state.paper)await saveReading();if(!current())throw new Error('保存期间阅读资料已变化');
 const personal=await call('personal.snapshot');if(!current())throw new Error('阅读资料已变化，未安装过期快照');
 state.personal=personal;nativeOfflineTransaction={id:presentationID,token,previous};
 try{await installReading(receipt.paper,receipt.article);if(token!==opening||state.paper!==receipt.paper)throw new Error('阅读资料已变化，未确认过期快照');return {installed:true,paperID:receipt.paper.id,offlinePackageID:receipt.paper.offlinePackageID};}
 catch(e){await window.paperDigestCancelOfflineReceipt(presentationID,{paper:previous.paper,article:previous.article});throw e;}
};
window.paperDigestFinishOfflineReceipt=presentationID=>{
 const t=nativeOfflineTransaction;if(!t||t.id!==presentationID)return;
 nativeOfflineTransaction=null;if(t.token===opening)toast('正在阅读已核验离线快照，未联网判断网站后续更新');
};
async function openPaper(p,options={}){
 if(p.offlinePackageID)return openOffline(p.offlinePackageID,options);
 const token=++opening;
 try{
  await saveNote();await saveAnnotations();await saveReading();if(token!==opening)return;
  state.pdf=false;layoutPDF();await call('app.setPaper',p);if(token!==opening)return;
  await installReading(p,null,options);$('article').innerHTML='<div class="loading-state">读取完整图文导读…</div>';
  if(p.sourceKind==='local'){$('article').innerHTML='<div class="empty-state">本地 PDF 已打开，可基于原文解析。</div>';return;}
  const a=await call('library.article',{paperID:p.id});if(token!==opening)return;state.article=a;renderGuide();const saved=state.personal.readingState?.[p.id]||{};if(options.resume&&saved.pdfOpen){await togglePDF(true);if(token!==opening)return;finishInitialGuideLayout(viewIdentity());if(saved.chapter!==undefined)$('pdf-chapter').value=String(saved.chapter);}
 }catch(e){if(token!==opening)return;error(e);if(!state.article)$('article').innerHTML=`<div class="empty-state"><h2>导读暂未载入</h2><p>${esc(e.message)}</p><button id="retry-article">重新载入</button></div>`;$('retry-article')?.addEventListener('click',()=>openPaper(p,options));}
}
async function openOffline(id,options={}){
 const token=++opening;
 try{await saveNote();await saveAnnotations();await saveReading();if(token!==opening)return;
 const result=await call('storage.open',{id});if(token!==opening)return;await installReading(result.paper,result.article,options);toast('正在阅读已核验离线快照，未联网判断网站后续更新');}
 catch(e){if(token===opening)error(e);}
}
function scheduleReading(){clearTimeout(readingTimer);const owner=state.paper?.id;readingTimer=setTimeout(()=>{if(owner&&state.paper?.id===owner)saveReading().catch(error);},500);}
async function saveAnnotations(){
 if(annotationSaving)return annotationSaving;
 clearTimeout(annotationTimer);
 annotationSaving=(async()=>{while(annotationDrafts.size){const [key,draft]=annotationDrafts.entries().next().value;const snapshot={...draft};await call('personal.annotationNote',snapshot);if(annotationDrafts.get(key)?.comment===snapshot.comment)annotationDrafts.delete(key);}})();
 try{return await annotationSaving;}finally{annotationSaving=null;}
}
async function setView(view){try{const request=setView.sequence=(setView.sequence||0)+1;captureGuideScroll();if(state.noteDirty)await saveNote();await saveAnnotations();if(request!==setView.sequence)return;state.view=view;if(view!=='tasks'&&nativeTasksUI?.enabled)nativeTasksUI.update().catch(error);updateOutlineVisibility();const isReader=view==='reader';$('reader-view').hidden=!isReader;$('library-view').hidden=!['library','today','conference','favorites','reading-list'].includes(view);for(const name of ['tasks','notes']){const pane=$(name+'-view');if(view===name){if(name==='tasks'&&nativeTasksUI?.enabled){pane.hidden=false;nativeTasksUI.clearWeb();}else revealAccessiblePane(pane);}else pane.hidden=true;}$('reader-tabs').hidden=!isReader;document.querySelectorAll('.document-action').forEach(el=>el.hidden=!isReader||!state.paper);$('toolbar-context').textContent=isReader?'研究阅读':view==='tasks'?'后台任务':view==='notes'?'我的笔记':'资料库';document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('is-active',el.dataset.view===view));if(view==='notes'){const personal=await call('personal.snapshot');if(request!==setView.sequence||state.view!==view)return;state.personal=personal;renderNotes();}else if(view==='tasks'){if(nativeTasksUI?.enabled)await nativeTasksUI.update({focus:true});else await renderJobs();}else if(!isReader)await library?.render();if(request!==setView.sequence||state.view!==view)return;restoreGuidePosition();layoutPDF();}catch(e){error(e);}}
function setMode(mode){captureGuideScroll();state.mode=mode;updateOutlineVisibility();for(const name of ['guide','analysis','note']){const pane=$(name+'-pane');if(name===mode&&name!=='guide')revealAccessiblePane(pane);else pane.hidden=name!==mode;$('tab-'+name).setAttribute('aria-selected',String(name===mode));}restoreGuidePosition();layoutPDF();if(mode==='analysis')renderSessions();if(mode==='note')renderAnnotations().catch(error);}
async function renderAnnotations(){if(!state.paper)return;const owner=state.paper.id;const r=await call('personal.annotations');if(state.paper?.id!==owner)return;$('annotation-list').innerHTML=(r.annotations||[]).map(a=>`<section class="annotation-card"><button data-annotation-page="${esc(a.id)}" data-page="${Number(a.page)}" data-sha="${esc(a.pdfSHA)}">原文物理页 ${esc(a.page)} ↗</button><p>${esc(a.text)}</p><small>PDF ${esc((a.pdfSHA||'').slice(0,12))}</small><label>我的批注<textarea data-annotation-comment="${esc(a.id)}" rows="2" aria-label="原文摘录的个人批注">${esc(annotationDrafts.get(owner+'|'+a.id)?.comment??a.comment??'')}</textarea></label><button data-annotation-save="${esc(a.id)}">保存批注</button><button data-annotation-remove="${esc(a.id)}">移除标注</button></section>`).join('');$('annotation-list').querySelectorAll('[data-annotation-comment]').forEach(field=>field.oninput=()=>{annotationDrafts.set(owner+'|'+field.dataset.annotationComment,{paperID:owner,id:field.dataset.annotationComment,comment:field.value});clearTimeout(annotationTimer);annotationTimer=setTimeout(()=>saveAnnotations().catch(error),500);});$('annotation-list').querySelectorAll('[data-annotation-remove]').forEach(b=>b.onclick=async()=>{try{await saveAnnotations();if(state.paper?.id!==owner)return;await call('pdf.removeAnnotation',{id:b.dataset.annotationRemove});await renderAnnotations();}catch(e){error(e);}});$('annotation-list').querySelectorAll('[data-annotation-save]').forEach(b=>b.onclick=async()=>{try{const field=[...$('annotation-list').querySelectorAll('[data-annotation-comment]')].find(x=>x.dataset.annotationComment===b.dataset.annotationSave);annotationDrafts.set(owner+'|'+b.dataset.annotationSave,{paperID:owner,id:b.dataset.annotationSave,comment:field.value});await saveAnnotations();toast('批注已保存，原始引句保留');}catch(e){error(e);}});$('annotation-list').querySelectorAll('[data-annotation-page]').forEach(b=>b.onclick=async()=>{try{if(!await togglePDF(true))return;await pdfAction('pdf.locate',{page:Number(b.dataset.page),pdfSHA:b.dataset.sha});}catch(e){error(e);}});}
function updateNote(){$('note-count').textContent=$('note-editor').value.length+' 字';}
function sessionUsage(usage){const count=(...keys)=>{for(const key of keys){const value=usage?.[key];if(Number.isSafeInteger(value)&&value>=0)return String(value);}return '未知';};return `输入${count('input_tokens','prompt_tokens')} · 输出${count('output_tokens','completion_tokens')} · 合计${count('total_tokens')} tokens`;}
function sessionStatus(status){return ({complete:'已完成',failed:'失败',cancelled:'已取消',running:'进行中',pending:'等待中',queued:'排队中',interrupted:'已中断',partial:'未完成'})[status]||'状态未知';}
function sessionSource(kind){return ({selection:'选区','pdf-selection':'选区',page:'当前页','pdf-page':'当前页',range:'页范围','pdf-range':'页范围',full:'全文','pdf-full':'全文',guide:'网站导读','published-reader':'网站导读',chapter:'章节','pdf-chapter':'章节'})[kind]||'来源未知';}
function sessionTime(value){const date=typeof value==='string'&&value.trim()?new Date(value):null;return date&&Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'时间未知';}
function renderSessions(){const entries=(state.personal.sessions||[]).filter(s=>s.paperID===state.paper?.id&&s.kind!=='connection-check');$('analysis-result').replaceChildren();if(!entries.length){$('analysis-result').innerHTML='<p class="settings-help">选择材料范围，提出你的问题。结果只保存在本机，网站原稿保持原样。</p>';return;}for(const s of entries){const card=document.createElement('section');card.className='session-card';const pages=s.source?.pages||[];card.innerHTML=`<header><span>${esc(s.actualModel||("请求 "+(s.model||"未指定")+" · 实际模型未知"))} · ${esc(sessionStatus(s.status))}${s.reused?' · 已复用':''}</span><span>${esc(sessionTime(s.startedAt))}</span></header><h3>${esc(s.question)}</h3><p class="settings-help">材料：${esc(sessionSource(s.source?.kind))} ${pages.length?'物理页 '+pages[0]+'–'+pages.at(-1):''}${s.source?.truncated?' · 输入已截断，不能视作全文':''}${s.source?.missingTextPages?.length?' · 无文字页 '+esc(s.source.missingTextPages.join('、'))+' 未分析图像':''} · 实际费用金额未知 · ${esc(sessionUsage(s.usage))}</p><div class="session-body"></div>`;const body=sanitized(markdownHTML(s.text||s.response||(typeof s.error==='object'?s.error?.message:s.error)||'请求未完成'));if(s.source?.pdfSHA){const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),texts=[];while(walker.nextNode()){if(!walker.currentNode.parentElement.closest('a,code,pre,math,annotation'))texts.push(walker.currentNode);}for(const node of texts){const text=node.textContent,re=/\[p\.(\d+)\]/g;let m,last=0,found=false,fragment=document.createDocumentFragment();while((m=re.exec(text))){found=true;fragment.append(text.slice(last,m.index));const a=document.createElement('a');a.href='#pdf-page-'+m[1];a.textContent=m[0];a.setAttribute('aria-label','打开原文物理第 '+m[1]+' 页');fragment.append(a);last=re.lastIndex;}if(found){fragment.append(text.slice(last));node.replaceWith(fragment);}}}const frame=mountFrame(card.querySelector('.session-body'),body.innerHTML,'个人解析',s.source);frame.style.height='420px';$('analysis-result').append(card);}}
async function analyze(){if(!state.paper){toast('请先选择论文');return;}const question=$('question').value.trim();if(!question){$('question').focus();return;}const scope=$('evidence-scope').value;$('analyze').disabled=true;try{const response=await call('model.run',{question,scope,paperID:state.paper.id,force:$('force-request').checked,from:Number($('range-from').value),to:Number($('range-to').value),chapter:Number($('pdf-chapter').value)});state.personal=await call('personal.snapshot');renderSessions();toast(response.reused?'已复用相同材料与配置的既有解析，未新增请求':'解析已保存；原始用量已记录');}catch(e){state.personal=await call('personal.snapshot');renderSessions();error(e);}finally{$('analyze').disabled=false;}}
async function togglePDF(force){
 const next=typeof force==='boolean'?force:!state.pdf,context=viewIdentity();
 if(!state.paper){toast('请先选取论文');return false;}
 if(next&&pdfPending?.id===context.id&&pdfPending.generation===context.generation)return pdfPending.promise;
 if(!next){pdfRequest++;pdfPending=null;state.pdf=false;$('pdf-toggle').disabled=false;await call('pdf.close');if(isCurrent(context)){if(initialGuideRestoreFor())finishInitialGuideLayout(context);else layoutPDF();scheduleReading();}return true;}
 if(state.pdf){layoutPDF();return true;}
 const request=++pdfRequest;$('pdf-toggle').disabled=true;
 const promise=(async()=>{try{
  const status=await call('pdf.open');if(!isCurrent(context)||request!==pdfRequest)return false;
  const outline=await call('pdf.outline');if(!isCurrent(context)||request!==pdfRequest)return false;
  state.pdfStatus=status;state.pdf=true;
  $('pdf-chapter').innerHTML=outline.chapters?.length?outline.chapters.map((c,i)=>`<option value="${i}">${esc(c.title)} · ${c.page}–${c.endPage}</option>`).join(''):'<option value="-1">原文没有可核对目录，使用页范围</option>';
  captureGuideScroll();if(innerWidth<1300)$('app-window').classList.add('sidebar-hidden');updatePDF();layoutPDF();scheduleReading();return true;
 }catch(e){if(isCurrent(context)&&request===pdfRequest)error(e);return false;}finally{if(isCurrent(context)&&request===pdfRequest){$('pdf-toggle').disabled=false;pdfPending=null;}}})();
 pdfPending={...context,promise};return promise;
}
function updatePDF(){const s=state.pdfStatus;$('pdf-page').value=s.page||1;$('pdf-page').max=s.pageCount||1;$('pdf-total').textContent='/ '+(s.pageCount||'—');$('pdf-name').textContent=state.paper?.title||'原文 PDF';$('pdf-zoom').textContent=Math.round((s.scale||1)*100)+'%';$('pdf-version').textContent=(s.version||'原始 PDF')+(s.isStale?' · 旧缓存，当前性未通过':'');$('pdf-version').title=(s.notices||[]).join('\n');}
function layoutPDF(){captureGuideScroll();const visible=state.pdf&&state.view==='reader'&&!document.querySelector('[data-dialog-surface][open]');$('reading-area').classList.toggle('is-split',visible);$('pdf-pane').hidden=!visible;$('splitter').hidden=!visible;$('pdf-toggle').setAttribute('aria-pressed',String(visible));queueGuideReflow();requestAnimationFrame(()=>{if(nativeTasksUI?.enabled)nativeTasksUI.update().catch(error);const r=$('pdf-scroll').getBoundingClientRect();call('pdf.frame',{visible,x:r.x,y:r.y,width:r.width,height:r.height}).catch(error);});}
function renderNotes(){
 const noteMap=state.personal.notes||{},marks=state.personal.annotations||{};
 const ids=[...new Set([...Object.keys(noteMap),...Object.keys(marks)])].filter(id=>noteMap[id]?.text?.trim()||marks[id]?.length);
 $('all-notes').innerHTML=ids.length?ids.sort((a,b)=>(noteMap[b]?.updatedAt||marks[b]?.at(-1)?.updatedAt||'').localeCompare(noteMap[a]?.updatedAt||marks[a]?.at(-1)?.updatedAt||'')).map(id=>{
  const p=state.catalog.find(p=>p.id===id)||state.personal.personalPapers?.[id],n=noteMap[id]||{},annotations=marks[id]||[];
  return `<section class="task-row"><div><strong>${esc(p?.titleZh||p?.title||id)}</strong><p>${esc(sessionTime(n.updatedAt||annotations.at(-1)?.updatedAt))} · ${annotations.length} 处原文摘录</p><p>${esc((n.text||annotations[0]?.comment||annotations[0]?.text||'').slice(0,180))}</p></div><button data-note-open="${esc(id)}">打开笔记</button></section>`;
 }).join(''):'<div class="empty-state"><h2>留住你的思考</h2><p>研究笔记、原文摘录和个人批注会按论文汇集在这里。</p></div>';
 $('all-notes').querySelectorAll('[data-note-open]').forEach(b=>b.onclick=async()=>{const p=state.catalog.find(p=>p.id===b.dataset.noteOpen)||state.personal.personalPapers?.[b.dataset.noteOpen];if(!p){toast('原论文元数据不可用，研究 JSON 与备份仍保留原文摘录和批注');return;}await openPaper(p);setMode('note');});
}
function jobMetadata(job,sessions,sessionReadFailed=false){
 const recorded=typeof job.identity==='string'&&job.identity.trim()?job.identity:typeof job.paperID==='string'&&job.paperID.trim()?job.paperID:'未记录';
 const lines=['对象身份：'+recorded];
 if(!['model.run','model.check'].includes(job.command)){
  const cloud=typeof job.command==='string'&&job.command.startsWith('cloud.'),material=job.material;
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const snapshot=cloud&&material?.kind==='workspace-snapshot'&&typeof material.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(material.createdAt)&&Number.isFinite(new Date(material.createdAt).getTime())&&Number.isSafeInteger(material.fileCount)&&material.fileCount>0&&material.fileCount<=100000&&sha(material.sha256);
  lines.push(snapshot?'材料依据：完整研究空间快照 · 采集时间 '+sessionTime(material.createdAt)+' · 实际文件数 '+material.fileCount+' · 原编码 SHA-256 '+material.sha256:'材料依据：本任务未单独记录版本或范围');
  if(job.command==='cloud.restore'&&sha(job.result?.sha256))lines.push('原恢复材料 SHA-256 '+job.result.sha256);
  lines.push('模型费用：本任务无需本地模型请求');return lines;
 }
 const matches=Array.isArray(sessions)?sessions.filter(s=>s&&s.id===job.id):[];
 const session=typeof job.id==='string'&&job.id.length&&matches.length===1&&typeof job.paperID==='string'&&(job.command==='model.check'||job.paperID.length>0)&&matches[0].paperID===job.paperID&&matches[0].kind===(job.command==='model.check'?'connection-check':'study')?matches[0]:null;
 if(!session){lines.push('材料依据：'+(sessionReadFailed?'研究记录读取失败，原依据未能核对':'没有唯一匹配的原研究记录，版本与范围未知'));lines.push(job.result?.reused===true?'模型费用：已复用既有结果，本任务未新增模型请求；原用量未在本任务绑定':'模型费用：用量与实际金额未知，不视作零费用');return lines;}
 const source=session.source&&typeof session.source==='object'?session.source:{};
 const pages=Array.isArray(source.pages)?source.pages.filter(p=>Number.isSafeInteger(p)&&p>0):[];
 const basis=[job.command==='model.check'?'连接测试':sessionSource(source.kind)];
 if(pages.length)basis.push('物理页 '+pages.join('、'));
 if(typeof source.sourceVersion==='string'&&source.sourceVersion)basis.push('版本 '+source.sourceVersion);
 if(typeof source.revision==='string'&&source.revision)basis.push('导读修订 '+source.revision);
 if(typeof source.pdfSHA==='string'&&source.pdfSHA)basis.push('PDF SHA-256 '+source.pdfSHA);
 if(job.command!=='model.check'&&!source.sourceVersion&&!source.revision&&!source.pdfSHA)basis.push('原版本未记录');
 if(source.truncated===true)basis.push('输入已截断，不能视作全文');
 if(Array.isArray(source.missingTextPages)&&source.missingTextPages.length)basis.push('无文字页 '+source.missingTextPages.filter(p=>Number.isSafeInteger(p)&&p>0).join('、')+' 未分析图像');
 lines.push('材料依据：'+basis.join(' · '),'模型费用：'+sessionUsage(session.usage)+' · 实际费用金额未知');
 return lines;
}
async function renderJobs(){
 const request=renderJobs.sequence=(renderJobs.sequence||0)+1;
 const [{jobs=[]},research]=await Promise.all([call('jobs.list'),call('personal.snapshot').then(personal=>({sessions:personal.sessions})).catch(()=>({failed:true}))]);
 if(request!==renderJobs.sequence||state.view!=='tasks')return;
 const filter=document.querySelector('[data-task-filter][aria-pressed=true]')?.dataset.taskFilter||'all';
 const visible=jobs.filter(j=>filter==='all'||filter==='active'&&['running','queued'].includes(j.status)||filter==='attention'&&['failed','partial','interrupted','cancelled'].includes(j.status));
 const pageCount=Math.max(1,Math.ceil(visible.length/taskPageSize));taskPage=Math.max(0,Math.min(taskPage,pageCount-1));
 const start=taskPage*taskPageSize,pageJobs=visible.slice(start,start+taskPageSize);
 $('task-page-summary').textContent=visible.length?`${visible.length} 条任务 · ${start+1}–${Math.min(start+taskPageSize,visible.length)} · 第 ${taskPage+1} / ${pageCount} 页`:'0 条任务';
 $('task-prev').disabled=taskPage===0;$('task-next').disabled=taskPage+1>=pageCount;
 const names={'cloud.check':'检查坚果云连接','cloud.upload':'云端完整备份','cloud.list':'读取云端备份版本','cloud.restore':'恢复云端研究空间','library.sync':'同步网站目录','library.article':'读取图文导读','library.downloadPDF':'下载原文','pdf.open':'打开原文','model.run':'个人解析','model.check':'模型连接测试','archive.materials':'准备归档材料','zotero.archive':'存入 Zotero','zotero.resume':'继续 Zotero 归档','storage.prepare':'保存离线快照','app.export':'导出研究'};
 const statuses={running:'进行中',queued:'等待中',complete:'已完成',partial:'部分完成',failed:'失败',interrupted:'上次运行中断',cancelled:'已取消'};
 $('task-list').innerHTML=visible.length?pageJobs.map(j=>`<section class="task-row"><div><strong>${esc(j.title)}</strong><p>${esc(names[j.command]||j.command)} · ${esc(statuses[j.status]||j.status)} · ${esc(sessionTime(j.startedAt))}</p><p>${esc(j.message)}</p>${jobMetadata(j,research.sessions,research.failed).map(line=>`<p class="settings-help" style="overflow-wrap:anywhere">${esc(line)}</p>`).join('')}${j.status==='running'?`<progress ${j.progress?.total>0?`value="${Number(j.progress?.completed)||0}" max="${Number(j.progress?.total)}"`:''} aria-label="实际任务进度"></progress>${j.progress?.total>0?`<small>${Number(j.progress?.completed)||0} / ${Number(j.progress?.total)}</small>`:''}`:''}</div>${j.status==='running'?`<button data-cancel="${esc(j.id)}">取消</button>`:typeof j.command==='string'&&j.command.startsWith('cloud.')&&['complete','partial','failed','interrupted','cancelled'].includes(j.status)?'<button data-job-cloud>查看坚果云资料</button>':j.command==='library.sync'?'<button data-resync>重新同步</button>':j.paperID?`<button data-job-paper="${esc(j.paperID)}">查看论文与保存结果</button>`:''}</section>`).join(''):'<div class="empty-state"><h2>没有此类任务</h2><p>同步、原文下载、个人解析与存档的实际记录会出现在这里。</p></div>';
 $('task-list').querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>call('jobs.cancel',{id:b.dataset.cancel}).catch(error));
 $('task-list').querySelectorAll('[data-resync]').forEach(b=>b.onclick=sync);
 $('task-list').querySelectorAll('[data-job-cloud]').forEach(b=>b.onclick=()=>call('settings.open',{pane:'cloud'}).catch(error));
 $('task-list').querySelectorAll('[data-job-paper]').forEach(b=>b.onclick=()=>{const p=state.catalog.find(p=>p.id===b.dataset.jobPaper)||state.personal.personalPapers?.[b.dataset.jobPaper];if(p)openPaper(p,{resume:true});else toast('原论文已不在当前目录，已保存的请求与费用仍完整保留在备份中');});
}
async function sync(){$('sync').disabled=true;try{await call('library.sync');await library.refresh();toast('已核验并更新全部已发布论文目录');}catch(e){error(e);}finally{$('sync').disabled=false;}}
async function exportArchiveMaterials(){await saveNote();const html=originalFrameHTML(guideFrame);return await call('archive.materials',{guideHTML:html});}
function exportDialog(){return call('details.show',{kind:'export'}).catch(error);}
function help(){return call('details.show',{kind:'help'}).catch(error);}
function command(action,detail={}){if(action==='storage')storageUI.show().catch(error);if(action==='sidebar'){const change=()=>{captureGuideScroll();$('app-window').classList.toggle('sidebar-hidden');layoutPDF();};if(nativeTasksUI?.enabled&&state.view==='tasks')nativeTasksUI.changeLayout(change).catch(error);else change();}if(action==='pdf')togglePDF();if(action==='settings')call('settings.open').catch(error);if(action==='search'){setView('library');$('search-input').focus();}if(action==='font')changeFont(detail.delta);if(action==='export')exportDialog();if(action==='help')help();if(action==='find'){
 const pdf=detail.pdfFocused===true;
 call('app.findQuery',{target:pdf?'原文 PDF':state.mode==='note'?'研究笔记':state.mode==='analysis'?'个人解析':'网站导读'}).then(async result=>{
  if(result.cancelled||!result.query)return;const q=result.query;
  if(pdf){const r=await call('pdf.find',{query:q});toast(r.count+' 处匹配');return;}
  if(state.mode==='note'){const editor=$('note-editor'),start=editor.value.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());if(start<0){toast('当前笔记未找到该文字');return;}editor.focus();editor.setSelectionRange(start,start+q.length);return;}
  const frame=state.mode==='analysis'?$('analysis-result').querySelector('iframe'):guideFrame;const doc=frame?.contentDocument;if(!doc)return;
  const walker=doc.createTreeWalker(doc.querySelector('main'),NodeFilter.SHOW_TEXT),nodes=[];let text='';while(walker.nextNode()){const n=walker.currentNode;nodes.push({node:n,start:text.length,end:text.length+n.textContent.length});text+=n.textContent;}
  const start=text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());if(start<0){toast('当前内容未找到该文字');return;}const from=nodes.find(n=>n.end>start),to=nodes.find(n=>n.end>=start+q.length);if(!from||!to)return;const range=doc.createRange();range.setStart(from.node,start-from.start);range.setEnd(to.node,start+q.length-to.start);const selection=doc.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);if(frame===guideFrame)navigateGuideTo(from.node.parentElement,'center');else from.node.parentElement.scrollIntoView({block:'center'});toast('已定位当前内容中的匹配文字');
 }).catch(error);
}}

async function start(){const initial=await call('app.bootstrap');state.personal=initial.personal;state.settings=initial.settings;state.summary=initial.library;if(initial.nativeTasks===true)installNativeTasksUI();applySettings();library=mountLibrary(app);zotero=mountZotero(app);if($('archive-open'))$('archive-open').onclick=()=>call('details.show',{kind:'zotero'}).catch(error);storageUI=mountStorage(app,{nativeWindow:true});await library.refresh();await setView('library');icons();const sample=state.catalog.find(p=>p.id==='arxiv:2610.27491');const recent=Object.entries(state.personal.readingState||{}).sort((a,b)=>(b[1].updatedAt||'').localeCompare(a[1].updatedAt||''))[0];const resume=recent&&(state.catalog.find(p=>p.id===recent[0])||state.personal.personalPapers?.[recent[0]]);if(resume)state.resume=resume;if(sample){$('sidebar-paper').textContent=sample.titleZh||sample.title;state.resume=state.resume||sample;}else $('sidebar-paper').textContent='选择论文开始阅读';}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(b.dataset.view==='reader'&&!state.paper){if(state.resume)openPaper(state.resume,{resume:true});else toast('请先从资料库选择论文');}else setView(b.dataset.view);});document.querySelectorAll('[data-action=sidebar]').forEach(b=>b.onclick=()=>command('sidebar'));document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));$('settings-button').onclick=()=>call('settings.open');$('model-settings').onclick=()=>call('settings.open');$('sync').onclick=sync;$('back').onclick=()=>setView('library');$('global-search').onclick=()=>command('search');$('pdf-toggle').onclick=()=>togglePDF();$('pdf-close').onclick=()=>togglePDF(false);$('pdf-fit').onclick=()=>pdfAction('pdf.fit');$('pdf-plus').onclick=()=>pdfAction('pdf.zoom',{factor:(state.pdfStatus.scale||1)*1.15});$('pdf-minus').onclick=()=>pdfAction('pdf.zoom',{factor:(state.pdfStatus.scale||1)/1.15});$('pdf-page').onchange=()=>pdfAction('pdf.page',{page:Number($('pdf-page').value)});for(const [id,delta]of [['pdf-prev',-1],['pdf-next',1]])$(id).onclick=()=>pdfAction('pdf.page',{page:(state.pdfStatus.page||1)+delta});$('pdf-original').onclick=e=>{e.preventDefault();call('pdf.openExternal').catch(error);};$('source-page').onclick=async()=>{try{const context=viewIdentity();if(!await togglePDF(true)||!isCurrent(context))return;const selected=await call('pdf.selection');if(!isCurrent(context))return;if(selected.page)await pdfAction('pdf.locate',{pdfSHA:selected.pdfSHA,page:selected.page});}catch(e){error(e);}};$('analyze').onclick=analyze;$('evidence-scope').onchange=()=>{const context=viewIdentity(),request=++previewRequest;document.querySelector('.page-range').hidden=$('evidence-scope').value!=='range';$('pdf-chapter').hidden=$('evidence-scope').value!=='chapter';call('model.preview',{scope:$('evidence-scope').value,from:Number($('range-from').value),to:Number($('range-to').value),chapter:Number($('pdf-chapter').value)}).then(r=>{if(!isCurrent(context)||request!==previewRequest)return;$('context-label').textContent=(r.pages?.length?'物理页 '+r.pages[0]+'–'+r.pages.at(-1):'网站导读')+' · '+r.characters+' 字符'+(r.missingTextPages?.length?' · 第 '+r.missingTextPages.join('、')+' 页无可提取文字，未含图像内容':'');}).catch(e=>{if(isCurrent(context)&&request===previewRequest)$('context-label').textContent=e.message;});};document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>{$('question').value=b.dataset.question;$('question').focus();scheduleReading();});$('note-editor').oninput=()=>{state.noteDirty=true;updateNote();$('note-status').textContent='正在保存…';clearTimeout(noteTimer);noteTimer=setTimeout(()=>saveNote().catch(error),700);};$('highlight-selection').onclick=()=>call('pdf.highlight').then(()=>{toast('原文选区已标注并保存在本机');renderAnnotations();}).catch(error);$('insert-citation').onclick=()=>{const box=$('note-editor'),p=state.paper;if(!p)return;const text=`[${p.title}](${p.sourceURL||p.blogURL||''})`;box.setRangeText(text,box.selectionStart,box.selectionEnd,'end');box.dispatchEvent(new Event('input'));};$('refresh-reader').onclick=async()=>{if(!state.paper)return;const context=viewIdentity();try{await saveNote();if(!isCurrent(context))return;const a=await call('library.article',{paperID:context.id,refresh:true});if(!isCurrent(context)||a.paperID!==context.id)return;state.article=a;renderGuide();toast(a.isStale?'网站暂不可读，已明确保留旧修订':'已读取并核对网站当前修订');}catch(e){if(isCurrent(context))error(e);}};$('favorite').onclick=async()=>{if(!state.paper)return;const context=viewIdentity(),p=await call('personal.snapshot');if(!isCurrent(context))return;const set=new Set(p.favorites||[]);set.has(context.id)?set.delete(context.id):set.add(context.id);state.personal=await call('personal.setList',{key:'favorites',ids:[...set]});if(isCurrent(context))$('favorite').setAttribute('aria-pressed',String(set.has(context.id)));};document.querySelectorAll('[data-task-filter]').forEach(b=>b.onclick=()=>{taskPage=0;document.querySelectorAll('[data-task-filter]').forEach(a=>a.setAttribute('aria-pressed',String(a===b)));renderJobs().catch(error);});for(const [id,delta]of [['task-prev',-1],['task-next',1]])$(id).onclick=()=>{taskPage=Math.max(0,taskPage+delta);$('tasks-view').scrollTop=0;renderJobs().catch(error);};$('detail-close').onclick=()=>$('detail-dialog').close();document.querySelectorAll('dialog form').forEach(f=>f.addEventListener('submit',e=>{if(e.submitter?.value==='cancel')f.closest('[data-dialog-surface],dialog')?.close();}));window.addEventListener('resize',layoutPDF);window.addEventListener('modal.changed',layoutPDF);new ResizeObserver(layoutPDF).observe($('pdf-scroll'));new MutationObserver(layoutPDF).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});let dragging=false;$('splitter').onpointerdown=e=>{dragging=true;$('splitter').setPointerCapture(e.pointerId);};$('splitter').onpointermove=e=>{if(!dragging)return;captureGuideScroll();const rect=$('reading-area').getBoundingClientRect();setReadingSplit((e.clientX-rect.x)/rect.width*100);layoutPDF();};$('splitter').onpointerup=()=>dragging=false;$('splitter').onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();captureGuideScroll();const current=parseFloat(getComputedStyle($('reading-area')).getPropertyValue('--split'))||46;setReadingSplit(current+(e.key==='ArrowRight'?2:-2));layoutPDF();}};window.addEventListener('menu.command',e=>command(e.detail.action,e.detail));window.addEventListener('pdf.changed',e=>{if(e.detail.paperID&&e.detail.paperID!==state.paper?.id)return;state.pdfStatus=e.detail;updatePDF();});window.addEventListener('pdf.selection',e=>{if(e.detail.paperID&&e.detail.paperID!==state.paper?.id)return;if(e.detail.cleared){$('context-label').textContent='未选择原文文字';document.querySelector('.source-excerpt').style.display='none';return;}document.querySelector('.source-excerpt').style.display='block';$('source-abstract').textContent=(e.detail.text||'').slice(0,350);$('source-page').textContent='原文物理页 '+e.detail.pages.join('、');$('context-label').textContent='已选原文 · 物理页 '+e.detail.pages.join('、');$('evidence-scope').value='selection';});window.addEventListener('library.changed',()=>library.refresh());window.addEventListener('jobs.changed',()=>{if(state.view==='tasks'&&!nativeTasksUI?.enabled)renderJobs().catch(error);});window.addEventListener('job.progress',e=>{if(e.detail.progress?.role)zotero.handleProgress(e.detail.progress);});window.addEventListener('app.error',e=>error(e.detail.message));window.addEventListener('personal.changed',async()=>{const token=++opening;pdfRequest++;pdfPending=null;const result=await call('app.bootstrap');if(token!==opening)return;state.personal=result.personal;state.settings=result.settings;state.paper=null;state.article=null;state.pdf=false;state.noteDirty=false;guideFrame=null;$('note-editor').value='';$('outline').replaceChildren();$('article').replaceChildren();applySettings();await library.refresh();await setView('library');toast('已重新载入个人资料');});window.addEventListener('settings.changed',async()=>{const event=++settingsEvents;let token=++settingsReload;try{if(fontSaving)await fontSaving;if(event!==settingsEvents)return;token=++settingsReload;const result=await call('app.bootstrap');if(token!==settingsReload||event!==settingsEvents)return;installSettings(result.settings);}catch(e){if(token===settingsReload&&event===settingsEvents)error(e);}});window.addEventListener('local.opened',async e=>{const token=++opening;state.personal=await call('personal.snapshot');if(token!==opening)return;state.noteDirty=false;guideFrame=null;state.paper=e.detail.paper;state.article=null;state.pdfStatus=e.detail.pdf;state.pdf=true;restoreDraft(state.paper);$('article').innerHTML='<div class="empty-state">本地 PDF 已打开，可基于原文解析。</div>';await setView('reader');setMode('analysis');updatePDF();layoutPDF();});document.addEventListener('keydown',e=>{if(!e.isComposing&&e.metaKey&&e.key==='Enter'&&state.mode==='analysis'&&!document.querySelector('[data-dialog-surface][open]')){e.preventDefault();analyze();}if(e.key==='Escape'){for(const d of document.querySelectorAll('[data-dialog-surface][open]'))d.close();}});start().catch(error);

for(const id of ['question','evidence-scope','range-from','range-to','pdf-chapter'])for(const event of ['input','change'])$(id).addEventListener(event,scheduleReading);
$('splitter').addEventListener('pointerup',scheduleReading);$('splitter').addEventListener('keyup',scheduleReading);
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',scheduleReading));
