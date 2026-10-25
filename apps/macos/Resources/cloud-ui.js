// Device-local controls. Only explicit actions ask native code to use WebDAV or
// credentials; neither mounting nor refreshing probes the Keychain/network.
export function mountCloud(app){
 const host=document.querySelector('[data-setting-pane="cloud"]');
 if(!host)throw new Error('坚果云设置容器不可用');
 if(host.querySelector('[data-cloud-root]:not([data-cloud-disposed])'))throw new Error('坚果云设置已挂载');
 // The shared settings reveal helper refreshes only the outer section. Keep
 // this live child as the stable owner of controls, handlers and draft state.
 const pane=document.createElement('div');pane.dataset.cloudRoot='';host.replaceChildren(pane);
 pane.innerHTML=`<style>
 [data-setting-pane="cloud"]{min-width:0;overflow-wrap:anywhere}
 [data-setting-pane="cloud"] .cloud-card{padding:16px;margin:18px 0;border:1px solid var(--line,#ddd);border-radius:10px;background:var(--surface,#fff)}
 [data-setting-pane="cloud"] .cloud-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
 [data-setting-pane="cloud"] button{max-width:100%;white-space:normal;min-height:32px;padding:6px 10px;border:1px solid var(--line,#d5d8da);border-radius:6px;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer}
 [data-setting-pane="cloud"] button:disabled{color:var(--muted,#888);cursor:default;opacity:.65}
 [data-setting-pane="cloud"] button:not(:disabled):hover{background:var(--accent-soft,#eef3f5)}
 [data-setting-pane="cloud"] input:not([type="checkbox"]){min-width:0;width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--line,#d5d8da);border-radius:6px;background:var(--surface,#fff);color:inherit;font:inherit}
 [data-setting-pane="cloud"] .cloud-inline{display:flex;align-items:center;gap:8px}
 [data-setting-pane="cloud"] .cloud-inline input{width:auto}
 [data-setting-pane="cloud"] .cloud-version{padding:14px 0;border-bottom:1px solid var(--line,#ddd)}
 [data-setting-pane="cloud"] .cloud-error{color:var(--danger,#a83f36);white-space:pre-wrap}
 [data-setting-pane="cloud"] h2{font-size:17px;margin:0 0 10px}
 [data-setting-pane="cloud"] p{font-size:12px;line-height:1.7}
 </style>
 <h1>坚果云资料</h1><p>为全部研究资料保存独立版本：笔记、解析、原始用量、阅读进度、导读、原文与已有归档检查点。已有版本保留，恢复前还会保存当前资料副本。</p>
 <p>上传内容包含私人研究材料；请使用你自己的坚果云账户。API、Zotero 与坚果云应用密码留在本机钥匙串，不随资料备份迁移。</p>
 <section class="cloud-card" aria-label="坚果云连接设置"><h2>独立保存目录</h2>
 <label>坚果云账号<input id="cloud-account" type="text" autocomplete="off" spellcheck="false" placeholder="坚果云登录邮箱"></label>
 <label>独立目录<input id="cloud-folder" type="text" value="PaperDigest" autocomplete="off" spellcheck="false"></label>
 <p>目录使用1–64位英文字母、数字、点、下划线或短横线，以字母或数字开头，不含斜杠。请使用独立目录，不使用 Zotero 的标准附件目录 zotero。每台设备保留独立版本，不覆盖另一台设备的资料。</p>
 <label class="cloud-inline"><input id="cloud-automatic" type="checkbox">应用运行时定期保存</label>
 <label>保存间隔（小时）<input id="cloud-interval" type="number" min="6" max="168" step="1" value="24"></label>
 <p>默认24小时，可设6–168小时。退出应用后不会在后台继续；正在运行的任务须先保存完毕。单次完整资料上限512 MiB，编码备份上限750 MiB，超过限制会明确停止，不会省略文件。</p>
 <div class="cloud-actions"><button id="cloud-save" type="button">保存坚果云设置</button><button id="cloud-discard" type="button" aria-label="撤销坚果云未保存更改">撤销未保存更改</button><button id="cloud-set-password" type="button">设置应用密码…</button><button id="cloud-delete-password" type="button">移除本机应用密码</button><button id="cloud-check" type="button">检查连接</button></div>
 <p>使用坚果云单独生成的第三方应用密码，在原生安全输入窗口填写，不在本页面输入登录密码。</p>
 </section>
 <section class="cloud-card" aria-label="完整资料保存状态"><h2>全部研究资料</h2><p id="cloud-status" role="status"></p><p id="cloud-last"></p><p id="cloud-pending"></p>
 <div class="cloud-actions"><button id="cloud-upload" type="button">立即保存全部资料</button><button id="cloud-cancel" type="button" disabled>取消当前传输</button><button id="cloud-archive-pending" type="button" hidden>保留快照并停止本次续传…</button><button id="cloud-reveal-transfers" type="button">在 Finder 查看保留的快照</button></div><p>明确停止本次续传时，原传输材料和检查点原样保留在本机，云端半成品不会自动删除。经过校验的完整 snapshot.paperdigest 文件可通过“文件→恢复个人资料…”取回当时研究资料；损坏或缺少的材料须手工核对，不能保证可恢复。新连接会另建版本，不冒充原续传。</p></section>
 <section class="cloud-card" aria-label="坚果云资料版本"><h2>查看与恢复版本</h2><p>版本按 UTC 月份归档，时间按本机时区显示。只查看指定月份的版本。恢复会先完整下载并校验，再由原生窗口确认；读取失败不代表云端没有资料。</p><label>备份月份（UTC）<input id="cloud-month" type="month"></label><button id="cloud-list" type="button">查看这个月的备份</button><div id="cloud-versions" aria-live="polite"></div></section>
 <p id="cloud-message" role="status" aria-live="polite"></p><p id="cloud-error" class="cloud-error" role="alert"></p>`;
 const $=id=>pane.querySelector('#'+id),fields=['account','folder','automatic','intervalHours'];
 const nodes={account:$('cloud-account'),folder:$('cloud-folder'),automatic:$('cloud-automatic'),intervalHours:$('cloud-interval')};
 const dirty=new Set(),revisions=new Map(fields.map(k=>[k,0]));
 let state={account:'',folder:'PaperDigest',automatic:false,intervalHours:24,credentialState:'unknown',busy:false},request=0,action=0,listGeneration=0,submitting=false,cancelPending=false,disposed=false,message='',localError='',stateReadError='',checkedTarget=null;
 $('cloud-month').value=new Date().toISOString().slice(0,7);
 const monthValid=value=>/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)&&Number(value.slice(0,4))>=2000;
 const snapshotValid=(s,month)=>s&&s.month===month&&typeof s.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.id)&&Number.isSafeInteger(s.encodedBytes)&&s.encodedBytes>=0&&Number.isSafeInteger(s.chunkCount)&&s.chunkCount>=1&&typeof s.sha256==='string'&&/^[a-f0-9]{64}$/.test(s.sha256);
 function size(bytes){if(!Number.isSafeInteger(bytes)||bytes<0)return '大小未记录';return bytes<1024?bytes+' B':bytes<1024*1024?(bytes/1024).toFixed(1)+' KiB':(bytes/1024/1024).toFixed(1)+' MiB';}
 function time(value){const date=typeof value==='string'?new Date(value):null;return date&&Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'时间未记录';}
 function form(){return {account:nodes.account.value.trim(),folder:nodes.folder.value,automatic:nodes.automatic.checked,intervalHours:Number(nodes.intervalHours.value)};}
 function validate(v){if(v.folder.toLowerCase()==='zotero')throw new Error('请使用独立目录，不能复用 Zotero 标准附件目录 zotero');if(!v.account||v.account.length>320)throw new Error('请填写有效的坚果云账号');if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.folder)||v.folder.includes('..'))throw new Error('独立目录须为1–64位ASCII目录名，不能包含斜杠或目录穿越');if(!Number.isInteger(v.intervalHours)||v.intervalHours<6||v.intervalHours>168)throw new Error('保存间隔须为6–168的整数小时');}
 function invalidateVersions(){listGeneration++;$('cloud-versions').replaceChildren();}
 function paint(){
  if(disposed)return;
  for(const key of fields)if(!dirty.has(key)){if(key==='automatic')nodes[key].checked=state[key]===true;else nodes[key].value=state[key]??(key==='folder'?'PaperDigest':key==='intervalHours'?24:'');}
  const damaged=state.pending?.damaged===true,busy=submitting||state.busy===true,configured=typeof state.account==='string'&&!!state.account.trim()&&typeof state.folder==='string'&&!!state.folder;
  for(const node of Object.values(nodes))node.disabled=busy;
  $('cloud-save').disabled=busy||!dirty.size;$('cloud-discard').disabled=busy||!dirty.size;
  for(const id of ['cloud-set-password','cloud-delete-password','cloud-check','cloud-upload','cloud-list'])$(id).disabled=busy||!!dirty.size||!configured;
  $('cloud-month').disabled=busy;
  $('cloud-archive-pending').textContent=damaged?'原样保留损坏材料并停止本次续传…':'保留快照并停止本次续传…';$('cloud-archive-pending').hidden=!state.pending;$('cloud-archive-pending').disabled=busy||!!dirty.size||!state.pending;$('cloud-reveal-transfers').disabled=submitting;
  $('cloud-cancel').disabled=!(busy&&typeof state.activeJobID==='string'&&state.activeJobID)||cancelPending;
  for(const button of pane.querySelectorAll('[data-cloud-restore]'))button.disabled=busy||!!dirty.size;
  pane.dataset.submitting=submitting?'true':'';
  $('cloud-status').textContent=(state.busy?'传输正在进行。':'')+({confirmed:'本次已确认应用密码状态；连接与完整传输结果仍须另行核验。',missing:'尚未保存应用密码。',unknown:'应用密码状态未检查；只有主动连接或传输才访问钥匙串。'}[state.credentialState]||'应用密码状态未检查。');
  $('cloud-last').textContent=state.lastBackup?'最近已确认完整备份：'+time(state.lastBackup.createdAt)+' · '+size(state.lastBackup.encodedBytes):'尚无已确认的完整备份记录。';
  $('cloud-pending').textContent=damaged?'未完成的本机传输材料已损坏或缺少有效检查点，可原样保留；须手工核对，不能保证完整或可恢复。':state.pending?'待续传的同一快照：'+time(state.pending.createdAt)+' · '+size(state.pending.encodedBytes)+' · '+(Number.isSafeInteger(state.pending.fileCount)&&state.pending.fileCount>=0?state.pending.fileCount:'未记录')+' 个文件；继续时不重新采集变化中的资料。':'';
  $('cloud-upload').textContent=damaged?'请先处理未完成材料':state.pending?'继续保存同一快照':'立即保存全部资料';if(damaged)$('cloud-upload').disabled=true;
  $('cloud-message').textContent=dirty.size?'设置尚未保存，请先保存后再连接或传输。':message;
  $('cloud-error').textContent=localError||stateReadError||(typeof state.lastError==='string'?state.lastError:'');
 }
 async function refresh(){
  const token=++request;
  try{const next=await app.call('cloud.state');if(disposed||token!==request)return;
   if(!next||typeof next!=='object'||Array.isArray(next))throw new Error('坚果云本机状态格式无效');
   if(state.account!==next.account||state.folder!==next.folder)invalidateVersions();if(checkedTarget&&(next.account!==checkedTarget.account||next.folder!==checkedTarget.folder)){checkedTarget=null;if(message.startsWith('本次连接检查通过'))message='连接目标已变化，请重新检查当前连接。';}if(state.busy&&!next.busy&&message.startsWith('已请求取消'))message='当前传输已结束；已完成步骤仍保留。';state=next;stateReadError='';paint();return state;
  }catch(e){if(!disposed&&token===request){stateReadError='未能更新坚果云本机状态：'+(e?.message||String(e));paint();}throw e;}
 }
 async function perform(command,payload={},after){
  if(disposed||submitting||(command!=='cloud.revealTransfers'&&(state.busy||dirty.size)))return;
  const token=++action,checkTarget=command==='cloud.check'?{account:state.account,folder:state.folder}:null;checkedTarget=null;submitting=true;localError='';message='正在处理，请等待实际结果。';paint();
  try{
   const pending=app.call(command,payload);
   // This local read lets a native job expose its cancellation ID. It never
   // probes credentials; further native job events keep it up to date.
   refresh().catch(()=>{});
   const result=await pending;if(disposed||token!==action)return;
   if(after)after(result);
   if(command==='cloud.upload')message='传输操作已结束，完整备份状态以实际回读结果为准。';
   else if(command==='cloud.restore')message='恢复操作已结束，请核对当前资料及原生窗口提示。';
   else if(command==='cloud.list')message='版本读取操作已结束，请查看当前月份的实际结果。';
   else if(command==='cloud.check'){checkedTarget=checkTarget;message='本次连接检查通过：已完成坚果云 WebDAV 认证并读取根目录；尚未验证上传权限或完整备份。';}
   else if(command==='cloud.revealTransfers')message='已请求打开本机保留快照目录；此操作不连接网盘。';
   else if(command==='cloud.setPassword'||command==='cloud.deletePassword')message='应用密码操作已结束；密码仅由原生钥匙串管理。';
   await refresh();
   if(command==='cloud.archivePending')message=state.pending?'原续传仍保留，请核对原生窗口提示。':'本次续传已停止，原传输材料保留在本机；云端半成品不会自动删除。';
  }catch(e){if(!disposed&&token===action){localError=e?.message||String(e);message='';await refresh().catch(()=>{});}}
  finally{if(!disposed&&token===action){submitting=false;paint();}}
 }
 for(const key of fields){const changed=()=>{dirty.add(key);revisions.set(key,revisions.get(key)+1);invalidateVersions();paint();};nodes[key].addEventListener('input',changed);nodes[key].addEventListener('change',changed);}
 $('cloud-month').addEventListener('input',invalidateVersions);$('cloud-month').addEventListener('change',invalidateVersions);
 $('cloud-save').onclick=async()=>{
  if(disposed||submitting||state.busy||!dirty.size)return;
  let captured;try{captured=form();validate(captured);}catch(e){localError=e.message;paint();return;}
  const token=++action,capturedRevisions=new Map(revisions);submitting=true;localError='';paint();
  try{await app.call('cloud.save',captured);if(disposed||token!==action)return;
   for(const key of fields)if(revisions.get(key)===capturedRevisions.get(key))dirty.delete(key);
   invalidateVersions();message='坚果云设置已保存到本机。';await refresh();
  }catch(e){if(!disposed&&token===action){localError=e?.message||String(e);await refresh().catch(()=>{});}}
  finally{if(!disposed&&token===action){submitting=false;paint();}}
 };
 $('cloud-discard').onclick=async()=>{
  if(disposed||submitting||state.busy||!dirty.size)return;
  const token=++action,capturedRevisions=new Map(revisions);submitting=true;localError='';message='正在读取最近保存的坚果云设置。';paint();
  try{const authoritative=await refresh();if(disposed||token!==action)return;
   if(!authoritative)throw new Error('本机状态已在读取期间变化，未丢弃草稿，请重试');
   for(const key of fields)if(revisions.get(key)===capturedRevisions.get(key))dirty.delete(key);
   invalidateVersions();message=dirty.size?'新的编辑已保留，其他字段恢复为最近保存值。':'已恢复最近保存的坚果云设置；原续传快照保留。';
  }catch(e){if(!disposed&&token===action)localError=e?.message||String(e);}
  finally{if(!disposed&&token===action){submitting=false;paint();}}
 };
 for(const [id,command]of [['cloud-set-password','cloud.setPassword'],['cloud-delete-password','cloud.deletePassword'],['cloud-check','cloud.check'],['cloud-upload','cloud.upload']])$(id).onclick=()=>perform(command);
 $('cloud-archive-pending').onclick=()=>{if(state.pending)return perform('cloud.archivePending');};
 $('cloud-reveal-transfers').onclick=()=>perform('cloud.revealTransfers');
 $('cloud-cancel').onclick=async()=>{
  if(disposed||cancelPending||!(submitting||state.busy)||!state.activeJobID)return;
  const id=state.activeJobID;cancelPending=true;localError='';message='已请求取消，等待原生任务确认；已完成步骤保留。';paint();
  try{await app.call('jobs.cancel',{id});await refresh();}catch(e){if(!disposed){localError=e?.message||String(e);await refresh().catch(()=>{});}}
  finally{cancelPending=false;paint();}
 };
 $('cloud-list').onclick=()=>{
  const month=$('cloud-month').value;if(!monthValid(month)){localError='请选择有效的备份月份';paint();return;}
  invalidateVersions();const generation=listGeneration;
  return perform('cloud.list',{month},result=>{
   if(generation!==listGeneration||$('cloud-month').value!==month)return;
   if(!result||!Array.isArray(result.snapshots))throw new Error('云端版本列表格式不符，不能判断是否存在完整备份');
   if(!result.snapshots.length){$('cloud-versions').textContent='这个月没有已完成的备份版本。';return;}
   const seen=new Set();
   for(const entry of result.snapshots){
    if(!snapshotValid(entry,month)||seen.has(entry.id))throw new Error('云端版本身份或校验字段无效，未提供恢复操作');seen.add(entry.id);
   }
   for(const entry of result.snapshots){
    const row=document.createElement('section');row.className='cloud-version';
    const title=document.createElement('strong');title.textContent=time(entry.createdAt);
    const detail=document.createElement('p');detail.textContent=size(entry.encodedBytes)+' · '+entry.chunkCount+' 个已登记分块 · 版本 '+entry.id.slice(0,8);
    const button=document.createElement('button');button.type='button';button.textContent='恢复这个版本…';button.dataset.cloudRestore=entry.id;
    button.onclick=()=>{if(generation!==listGeneration||$('cloud-month').value!==month)return;return perform('cloud.restore',{month,id:entry.id});};
    row.append(title,detail,button);$('cloud-versions').append(row);
   }
  });
 };
 const jobChanged=()=>{if(!disposed)refresh().catch(()=>{});};
 window.addEventListener('jobs.changed',jobChanged);window.addEventListener('cloud.changed',jobChanged);
 paint();refresh().catch(()=>{});
 return {refresh,dispose(){disposed=true;request++;action++;invalidateVersions();window.removeEventListener('jobs.changed',jobChanged);window.removeEventListener('cloud.changed',jobChanged);pane.dataset.cloudDisposed='true';for(const node of pane.querySelectorAll('input,button'))node.disabled=true;}};
}
