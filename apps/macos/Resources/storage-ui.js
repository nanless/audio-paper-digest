import {refreshDetailContainer} from './dialogs.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n/1024/1024)+' MB';
export function mountStorage(app){
 const {call,toast,error}=app,$=id=>document.getElementById(id);
 let generation=0;
 async function show(){
  const token=++generation,dialog=$('detail-dialog'),content=refreshDetailContainer(),view=document.createElement('section');
  view.dataset.storageView='';content.replaceChildren(view);
  const current=()=>token===generation&&dialog.open&&view.isConnected&&view.parentNode===content;
  view.innerHTML='<h2>本机资料</h2><p class="settings-help">正在检查已保存的真实文件…</p>';dialog.showModal();
  try{
   const [capacity,result]=await Promise.all([call('storage.status'),call('storage.packages')]);
   if(!current())return;
   view.innerHTML=`<div class="storage-heading"><div class="eyebrow">你的研究，留在本机</div><h2>本机资料</h2><p class="settings-help">共 ${bytes(capacity.totalBytes)} · ${capacity.files} 个文件。容量按文件字节统计，废纸篓清空前不会释放磁盘空间。</p></div><div class="storage-metrics">${capacity.categories.filter(c=>c.bytes).map(c=>`<div><span>${esc(c.label)}</span><strong>${bytes(c.bytes)}</strong></div>`).join('')}</div><div class="native-tools"><button id="storage-plan">检查可整理的缓存</button><button id="storage-reveal">在 Finder 查看</button></div><div id="cleanup-result" role="status"></div><h3>离线快照</h3><p class="settings-help">保留当时的导读、原图和 PDF；打开时逐文件核验。这里的版本不会自动替换为网站新版本。</p><div>${result.packages.length?result.packages.map(p=>`<section class="offline-row"><div><strong>${esc(p.title)}</strong><p>${esc(p.sourceVersion||'来源未提供版本')} · ${bytes(p.bytes)} · ${esc((p.createdAt||'').slice(0,10))}</p><small>${p.hasPDF?'含原始 PDF':'只含图文导读'} · ${esc(p.status)}</small></div><button data-offline="${esc(p.id)}">打开快照</button></section>`).join(''):'<p class="settings-help">尚无离线快照。打开论文后，点击工具栏的“保存离线”，即可保存完整资料。</p>'}</div>`;
   view.querySelectorAll('[data-offline]').forEach(b=>b.onclick=async()=>{if(!current())return;dialog.close();await app.openOffline(b.dataset.offline);});
   view.querySelector('#storage-reveal').onclick=()=>{if(current())call('app.revealData').catch(error);};
   const planButton=view.querySelector('#storage-plan'),planResult=view.querySelector('#cleanup-result');
   let planGeneration=0;
   planButton.onclick=async()=>{if(!current()||planButton.disabled)return;const planToken=++planGeneration;planButton.disabled=true;try{
    const plan=await call('storage.cleanupPlan');
    if(!current()||planToken!==planGeneration)return;
    planResult.innerHTML=`<p>${esc(plan.scope)}。候选 ${plan.count} 个文件，${bytes(plan.bytes)}。</p>${plan.count?'<button id="storage-clean">查看原生确认并移到废纸篓…</button>':''}`;
    const cleanButton=planResult.querySelector('#storage-clean');
    if(cleanButton)cleanButton.onclick=async()=>{if(!current()||cleanButton.disabled)return;cleanButton.disabled=true;try{const r=await call('storage.cleanup',{planID:plan.planID});if(!current())return;toast(`已移到废纸篓：${r.movedToTrash} 个文件`);await show();}catch(e){if(current())error(e);}finally{if(current())cleanButton.disabled=false;}};
   }catch(e){if(current()&&planToken===planGeneration)planResult.textContent=e.message;}finally{if(current()&&planToken===planGeneration)planButton.disabled=false;}};
  }catch(e){if(current()){view.innerHTML=`<h2>资料检查未完成</h2><p>${esc(e.message)}</p>`;dialog.showModal();}}
 }
 $('storage-button').onclick=()=>show().catch(error);
 $('save-offline').onclick=async()=>{const b=$('save-offline');try{b.disabled=true;const r=await call('storage.prepare');toast(r.reused?'完整离线快照已存在，校验通过':'图文导读、科学图和原始 PDF 已保存为离线快照');}catch(e){error(e);}finally{b.disabled=false;}};
 return {show};
}
