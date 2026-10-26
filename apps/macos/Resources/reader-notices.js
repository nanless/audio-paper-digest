// This view only repeats notices from the actual loaded article. It never reads
// a newer catalog record, writes research data, or grants source completeness.
export function mountReaderNotices({document,container,getCurrent,onError=()=>{}}){
 const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 const banner=make('section','reader-source-notice');banner.hidden=true;banner.setAttribute('aria-label','导读来源说明');banner.setAttribute('role','note');
 const icon=make('span','reader-source-notice-icon','i');icon.setAttribute('aria-hidden','true');
 const content=make('div','reader-source-notice-copy'),title=make('strong','','导读来源说明'),preview=make('p','reader-source-notice-preview');content.append(title,preview);
 const show=make('button','reader-source-notice-open','查看说明');show.type='button';banner.append(icon,content,show);container.prepend(banner);
 const dialog=make('dialog','archive-dialog reader-source-notice-dialog'),heading=make('h2','','导读来源说明'),identity=make('p','dialog-subtitle'),body=make('div','reader-source-notice-full'),close=make('button','secondary-button','关闭');close.type='button';
 dialog.id='reader-source-notice-dialog';close.onclick=()=>dialog.close('cancel');dialog.append(heading,identity,body,close);document.body.append(dialog);
 let binding=null;
 const current=()=>{const value=getCurrent();return value&&value.view==='reader'&&value.mode==='guide'&&value.paper?.id&&value.article?.paperID===value.paper.id&&Number.isSafeInteger(value.generation)&&value.generation>=0?value:null;};
 const same=(value)=>!!binding&&value?.paper?.id===binding.paperID&&value.article===binding.article&&value.generation===binding.generation&&String(value.article.revisionSHA256??'')===binding.revision;
 function clear(){if(dialog.open)dialog.close('cancel');binding=null;banner.hidden=true;preview.textContent='';body.replaceChildren();container.classList.remove('has-reader-source-notice');}
 function update(){
  const value=current();
  if(!value){clear();return;}
  const original=value.article.notices;
  if(!Array.isArray(original)||original.some(item=>typeof item!=='string')){clear();return;}
  const notices=[...new Set(original.filter(item=>item.trim().length))];
  if(!notices.length){clear();return;}
  if(dialog.open&&(!same(value)||JSON.stringify(notices)!==JSON.stringify(binding.notices)))dialog.close('cancel');
  binding={paperID:value.paper.id,article:value.article,generation:value.generation,revision:String(value.article.revisionSHA256??''),notices};
  preview.textContent=notices[0];show.textContent=notices.length>1?`查看 ${notices.length} 条说明`:'查看完整说明';show.setAttribute('aria-label',`查看完整导读来源说明，共 ${notices.length} 条`);
  banner.hidden=false;container.classList.add('has-reader-source-notice');
 }
 show.onclick=()=>{
  const value=current();if(!same(value)){clear();onError(new Error('阅读来源已经变化，请重新打开当前导读的来源说明'));return;}
  // Capture the current notice list again: do not open a stale list that changed
  // without replacing its article object. No HTML from notices is interpreted.
  const actual=value.article.notices;
  if(!Array.isArray(actual)||actual.some(item=>typeof item!=='string')||JSON.stringify([...new Set(actual.filter(item=>item.trim().length))])!==JSON.stringify(binding.notices)){clear();onError(new Error('来源说明已经变化，请重新读取当前导读'));return;}
  identity.textContent=value.paper.titleZh||value.paper.title||value.paper.id;
  body.replaceChildren(...binding.notices.map(text=>make('p','',text)));
  try{dialog.showModal();}catch{onError(new Error('来源说明窗口暂不可用，请重新打开导读后再试'));}
 };
 return {update,clear,destroy(){clear();banner.remove();dialog.remove();}};
}
