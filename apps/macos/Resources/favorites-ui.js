const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function favoriteDate(personal, id) {
  const metadata=personal.favoriteCollections;
  const value=metadata?.version===1 ? metadata.items?.[id]?.addedAt : null;
  const time=typeof value==='string' ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time : null;
}
export function favoriteSection(date, grouping='relative', now=new Date()) {
  if(!date)return '收藏时间未知';
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
  if(date>=tomorrow)return '较晚日期（请检查设备时间）';
  if(grouping==='month')return `${date.getFullYear()} 年 ${date.getMonth()+1} 月`;
  const week=new Date(today);week.setDate(week.getDate()-6);
  return date>=today ? '今天收藏' : date>=week ? '近 7 天收藏' : '更早收藏';
}
/** Native owns timestamps, revisions and membership. This module keeps drafts only. */
export function mountFavoriteTools(app,{before,onChange,selection}) {
  const root=document.createElement('section');root.className='favorite-tools';root.hidden=true;
  root.innerHTML=`<div class="favorite-toolbar"><label>收藏分类<select id="favorite-folder-filter"><option value="">所有收藏</option><option value="uncategorized">未分类</option></select></label><label>时间分区<select id="favorite-grouping"><option value="relative">今天 / 近 7 天 / 更早</option><option value="month">按月份</option></select></label><button id="favorite-manage-toggle" type="button" aria-expanded="false">管理分类</button><details id="favorite-time-help"><summary>收藏时间说明</summary><p id="favorite-guidance">按实际收藏时间从新到旧排列；旧版收藏的时间保留为未知。网站发布日期另列显示。</p></details></div><div id="favorite-manager" hidden><div class="favorite-folder-edit"><label>分类名称<input id="favorite-folder-name" maxlength="128" placeholder="例如：语音增强" autocomplete="off"></label><button id="favorite-folder-create" type="button">新建分类</button><button id="favorite-folder-rename" type="button">重命名当前分类</button><button id="favorite-folder-delete" type="button">删除当前分类</button></div><p class="favorite-help">删除分类只移除分类标签，论文仍保留在收藏中。一篇论文可以属于多个分类。</p></div><div id="favorite-assign" hidden><p id="favorite-assign-title"></p><div id="favorite-folder-checks"></div><label>归类方式<select id="favorite-assign-mode"><option value="add">添加到选中分类</option><option value="remove">从选中分类移除</option><option value="replace">替换为选中分类（不选则未分类）</option></select></label><button id="favorite-assign-save" type="button">保存归类</button><button id="favorite-assign-cancel" type="button">取消</button></div><p id="favorite-error" role="status" hidden></p><button id="favorite-reload" type="button" hidden>重新载入分类（保留当前选择）</button>`;
  before.before(root);
  const $=id=>root.querySelector('#'+id);
  let filter='',grouping='relative',busy=false,assignIDs=null,addMissing=false,revision=0,managerRevision=null,assignRevision=null,managerNameDraft=false,managerFolderID=null;
  const metadata=()=>app.state.personal?.favoriteCollections;
  const folders=()=>metadata()?.version===1 ? metadata().folders||[] : [];
  const readOnly=()=>metadata()!=null && metadata().version!==1;
  const showError=error=>{$('favorite-error').hidden=false;$('favorite-error').textContent=error?.message||String(error);$('favorite-reload').hidden=false;};
  const clearError=()=>{$('favorite-error').hidden=true;$('favorite-reload').hidden=true;};
  async function mutate(payload) {
    if(busy||readOnly())return false;
    const expectedRevision=payload.action.startsWith('folder.')?(payload.action!=='folder.delete'&&managerNameDraft?(managerRevision??revision):revision):(assignRevision??revision);
    busy=true;render();
    try {
      const result=await app.call('personal.favorite.edit',{...payload,expectedRevision});
      app.state.personal=result.personal||result;const nextRevision=metadata()?.revision??0;if(payload.action.startsWith('folder.'))managerRevision=nextRevision;else assignRevision=nextRevision;clearError();await onChange();return true;
    } catch(error){showError(error);return false;}
    finally{busy=false;render();}
  }
  function render() {
    const current=folders(),active=current.some(f=>f.id===filter);
    if(filter && filter!=='uncategorized'&&!active)filter='';
    const select=$('favorite-folder-filter');
    select.innerHTML='<option value="">所有收藏</option><option value="uncategorized">未分类</option>'+ (current.length?'<optgroup label="自建分类">'+current.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')+'</optgroup>':'');select.value=filter;
    revision=metadata()?.version===1 ? metadata().revision : 0;
    if(readOnly())$('favorite-time-help').open=true;
    $('favorite-guidance').textContent=readOnly()?'收藏分类由更新版本创建。当前可以阅读收藏；请升级工作台后编辑收藏。':'按实际收藏时间从新到旧排列；旧版收藏的时间保留为未知。网站发布日期另列显示。';
    for(const id of ['favorite-folder-create','favorite-folder-rename','favorite-folder-delete','favorite-assign-save','favorite-manage-toggle'])$(id).disabled=busy||readOnly()||(['favorite-folder-rename','favorite-folder-delete'].includes(id)&&!active);
    const renameFolder=current.find(f=>f.id===(managerNameDraft?managerFolderID:filter));$('favorite-folder-rename').textContent=renameFolder?'重命名“'+renameFolder.name+'”':'重命名当前分类';$('favorite-folder-rename').disabled=busy||readOnly()||!renameFolder;
    if(assignIDs){
      const checked=new Set([...$('favorite-folder-checks').querySelectorAll('input:checked')].map(el=>el.value));
      $('favorite-folder-checks').innerHTML=current.length?current.map(f=>`<label><input type="checkbox" value="${esc(f.id)}" ${checked.has(f.id)?'checked':''}>${esc(f.name)}</label>`).join(''):'<p>还没有自定义分类。可先在“管理分类”中新建。</p>';
      $('favorite-assign-title').textContent=`${addMissing?'收藏并归类':'归类'} ${assignIDs.length} 篇论文`;
    }
    for(const input of root.querySelectorAll('input,select'))input.disabled=busy;
  }
  $('favorite-folder-filter').onchange=()=>{filter=$('favorite-folder-filter').value;onChange();render();};
  $('favorite-grouping').onchange=()=>{grouping=$('favorite-grouping').value;onChange();};
  $('favorite-manage-toggle').onclick=()=>{const open=$('favorite-manager').hidden;$('favorite-manager').hidden=!open;$('favorite-manage-toggle').setAttribute('aria-expanded',String(open));if(open){if(managerRevision===null)managerRevision=revision;$('favorite-folder-name').focus();}};
  $('favorite-folder-name').oninput=()=>{if(!managerNameDraft){managerRevision=revision;managerFolderID=filter;}managerNameDraft=$('favorite-folder-name').value.length>0;render();};
  $('favorite-folder-create').onclick=async()=>{if(await mutate({action:'folder.create',name:$('favorite-folder-name').value})){$('favorite-folder-name').value='';managerNameDraft=false;app.toast('已创建收藏分类');}};
  $('favorite-folder-rename').onclick=async()=>{if(await mutate({action:'folder.rename',folderID:managerNameDraft?managerFolderID:filter,name:$('favorite-folder-name').value})){$('favorite-folder-name').value='';managerNameDraft=false;app.toast('已重命名收藏分类');}};
  $('favorite-folder-delete').onclick=async()=>{if(await mutate({action:'folder.delete',folderID:filter})){filter='';app.toast('已删除分类，收藏论文仍保留');await onChange();}};
  $('favorite-assign-cancel').onclick=()=>{assignIDs=null;assignRevision=null;$('favorite-assign').hidden=true;clearError();};
  $('favorite-assign-save').onclick=async()=>{
    if(!assignIDs)return;
    const payload={action:'items.assign',ids:[...assignIDs],folderIDs:[...$('favorite-folder-checks').querySelectorAll('input:checked')].map(el=>el.value),mode:$('favorite-assign-mode').value,addMissing};
    if(await mutate(payload)){assignIDs=null;$('favorite-assign').hidden=true;app.toast('已保存收藏分类');}
  };
  $('favorite-reload').onclick=async()=>{if(busy)return;busy=true;try{const value=await app.call('personal.snapshot',{});app.state.personal=value.personal||value;managerRevision=metadata()?.revision??0;assignRevision=managerRevision;clearError();await onChange();}catch(error){showError(error);}finally{busy=false;render();}};
  window.addEventListener('personal.changed',()=>{assignIDs=null;assignRevision=null;managerRevision=null;filter='';$('favorite-assign').hidden=true;$('favorite-manager').hidden=true;$('favorite-manage-toggle').setAttribute('aria-expanded','false');$('favorite-folder-name').value='';managerNameDraft=false;managerFolderID=null;clearError();});
  return {
    render(view){root.hidden=view!=='favorites'&&!assignIDs;render();},
    matches(id){if(!filter)return true;const ids=metadata()?.version===1 ? metadata().items?.[id]?.folderIDs||[] : [];return filter==='uncategorized'?!ids.length:ids.includes(filter);},
    get grouping(){return grouping;},get readOnly(){return readOnly();},
    labels(id){const ids=metadata()?.version===1 ? metadata().items?.[id]?.folderIDs||[] : [];return folders().filter(f=>ids.includes(f.id)).map(f=>f.name);},
    assign(ids,{favoriteAndAssign=false}={}){if(readOnly()){app.toast('请升级工作台后编辑收藏分类');return;}assignIDs=[...ids];assignRevision=revision;addMissing=favoriteAndAssign;root.hidden=false;$('favorite-assign').hidden=false;$('favorite-folder-checks').replaceChildren();clearError();render();$('favorite-assign-mode').focus();},
    close(){assignIDs=null;assignRevision=null;$('favorite-assign').hidden=true;}
  };
}
