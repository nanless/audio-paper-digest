/* Ordinary document content for the native detail host. Native owns presentation,
 * source binding, save panels and all file operations; this module requests only
 * the existing commands. Mounting or closing does not start an operation. */
const mounted=new WeakMap();
const formats=[
 ['markdown','Markdown','笔记、解析与实际研究材料'],
 ['html','HTML','可在浏览器阅读的个人研究'],
 ['json','完整研究 JSON','研究记录、摘录与来源身份'],
 ['guide','自包含图文导读','含已保存科学图的网站导读'],
 ['pdf','原始 PDF','已打开并核验的当前原文'],
 ['bib','原站 BibTeX','网站提供的原始书目信息'],
 ['ris','原站 RIS','网站提供的原始引用文件'],
 ['citation','原站引用 JSON','网站提供的原始引用数据']
];
const helpText=[
 '资料库读取已发布的网站数据；首次使用可同步完整目录。打开论文后先显示图文导读，点击原文 PDF 进入双栏。',
 '在系统设置窗口配置自己的模型 API。PDF 可选择实际文字，按当前页、选区或全文提问。扫描图片 PDF 暂无 OCR，界面会明确报告。',
 '研究笔记自动保存在本机。Zotero 存档会逐项回读书目、附件、导读与选中的研究内容；需要你在 Zotero 原生对话框授权。',
 '⌘ O 打开本地 PDF · ⌘ ⇧ D 切换双栏 · ⌘ , 设置 · ⌘ E 导出 · ⌘ F 查找'
];
function mount(container,{call,close,showClose=true},kind){
 if(!container||typeof container.replaceChildren!=='function'||typeof call!=='function'||typeof close!=='function')throw new TypeError('详情内容需要有效容器与原生操作接口');
 mounted.get(container)?.dispose();
 container.classList.add('detail-actions-content');
 const doc=container.ownerDocument,view=doc.createElement('section'),abort=new AbortController();
 view.dataset.detailContent=kind;
 let active=true,busy=false,closing=false,pending=Promise.resolve();
 const current=()=>active&&mounted.get(container)===controller&&view.isConnected&&view.parentNode===container;
 const node=(tag,text,className)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
 const heading=node('h1',kind==='help'?'论文速递 · 研究工作台':'导出当前研究');view.append(heading);
 const status=node('p','','settings-help');status.dataset.detailStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
 const footer=node('footer',undefined,'detail-actions'),done=node('button','完成','secondary-button');done.type='button';done.dataset.detailClose='';footer.append(done);
 const controls=()=>{view.setAttribute('aria-busy',String(busy||closing));view.querySelectorAll('button').forEach(button=>button.disabled=busy||closing||!active);};
 const say=(message,failed=false)=>{if(!current())return;status.textContent=message;status.dataset.state=failed?'error':'status';status.classList.toggle('error-banner',failed);};
 const cancelled=(error)=>error?.code==='cancelled'||error?.code==='CANCELLED'||/^已取消(?:导出|备份|恢复)[。！.!]?$/.test(error?.message||'');
 function action(parent,{label,description,command,payload={},success,confirmation='saved',waiting,cancellation}){
  const button=node('button');button.type='button';button.dataset.detailCommand=command;if(payload.format)button.dataset.format=payload.format;
  const text=node('span');text.append(node('strong',label),node('br'),node('small',description));button.append(text);parent.append(button);
  button.addEventListener('click',()=>{
   if(!current()||busy||closing)return;
   busy=true;controls();say(waiting);
   pending=(async()=>{try{
    const result=await call(command,payload);
    if(!current())return;
    if(result?.cancelled===true){say(cancellation);return;}
    if(result?.[confirmation]!==true)throw new Error('原生操作未确认完成；请核对实际文件或结果后再重试。');
    say(success);
   }catch(error){if(current())say(cancelled(error)?cancellation:(error?.message||'操作未完成，请核对后重试。'),!cancelled(error));}
   finally{busy=false;if(current())controls();}})();
  },{signal:abort.signal});return button;
 }
 done.addEventListener('click',()=>{
  if(!current()||busy||closing)return;closing=true;controls();
  pending=(async()=>{try{await close();}catch(error){say(error?.message||'未能关闭窗口，请重试。',true);}finally{closing=false;if(current())controls();}})();
 },{signal:abort.signal});
 const controller={dispose(){active=false;abort.abort();if(mounted.get(container)===controller){mounted.delete(container);container.classList.remove('detail-actions-content');}},get busy(){return busy||closing;},whenIdle(){return pending;}};
 mounted.set(container,controller);container.replaceChildren(view);
 return {view,node,action,status,footer,controller,finish(){view.append(status);if(showClose)view.append(footer);controls();}};
}
export function mountHelp(container,{call,close,showClose=true}){
 const ui=mount(container,{call,close,showClose},'help');
 for(const text of helpText)ui.view.append(ui.node('p',text,'settings-help'));
 const actions=ui.node('div',undefined,'native-tools');actions.setAttribute('aria-label','个人资料操作');ui.view.append(actions);
 ui.action(actions,{label:'备份个人资料',description:'将本机研究保存为备份文件',command:'app.backup',waiting:'正在准备备份，请在系统窗口选择保存位置…',success:'备份已保存。',cancellation:'已取消备份；本次没有生成备份文件。'});
 ui.action(actions,{label:'恢复备份',description:'选择文件，再由原生窗口确认',command:'app.restore',confirmation:'restored',waiting:'正在读取备份，请在系统窗口核对并确认…',success:'备份已恢复；资料已重新载入。',cancellation:'已取消恢复；当前资料保持不变。'});
 ui.action(actions,{label:'导出诊断',description:'保存不含凭据与正文的诊断',command:'app.diagnostics',waiting:'正在准备诊断，请在系统窗口选择保存位置…',success:'诊断文件已保存。',cancellation:'已取消诊断导出；本次没有生成文件。'});
 ui.view.append(ui.node('p','备份包含本机研究资料，但不包含 API 密钥或 Zotero 钥匙串授权。恢复前会核验备份，并保留恢复前资料副本。','settings-help'));
 ui.finish();return ui.controller;
}
export function mountExport(container,{call,close,context={},showClose=true}){
 const ui=mount(container,{call,close,showClose},'export');
 ui.view.append(ui.node('p','保存个人笔记、解析和来源身份。','settings-help'));
 if(typeof context?.title==='string'&&context.title.trim())ui.view.append(ui.node('p',context.title,'settings-help'));
 if(typeof context?.paperID==='string'&&context.paperID){
  const source=ui.node('details'),summary=ui.node('summary','来源身份');source.append(summary,ui.node('p',context.paperID,'settings-help'));
  if(typeof context.revision==='string'&&/^[a-f0-9]{64}$/.test(context.revision))source.append(ui.node('p','导读修订 '+context.revision.slice(0,12),'settings-help'));
  ui.view.append(source);
 }
 const actions=ui.node('div',undefined,'native-tools');actions.setAttribute('aria-label','导出格式');ui.view.append(actions);
 for(const [format,label,description] of formats)ui.action(actions,{label,description,command:'app.export',payload:{format},waiting:'正在准备'+label+'，请在系统窗口选择保存位置…',success:label+' 已保存。',cancellation:'已取消导出；本次没有生成文件。'});
 ui.view.append(ui.node('p','图文导读需完整缓存；原始 PDF 需先打开当前原文。原站引用文件按网站实际提供内容导出，缺失或校验失败会明确提示。','settings-help'));
 ui.finish();return ui.controller;
}
