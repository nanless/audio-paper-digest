/** Native Zotero UI. All library operations go through the Foundation service. */
export function mountZotero(app) {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let dialog = $('archive-dialog');
  const settingsPane = document.querySelector('[data-setting-pane="zotero"]');
  let status = null, collections = [], materials = null, lastResult = null, busy = false, generation = 0;
  const paperIdentity = () => app.state?.paper?.identity || app.state?.paper?.id || '';
  const notice = text => app.toast?.(text);
  const failure = error => { const message = error?.message || String(error); if ($('zotero-result')) $('zotero-result').textContent = message; app.error?.(error); };
  if (!settingsPane) throw new Error('Zotero 设置容器未就绪');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'archive-dialog'; dialog.className = 'archive-dialog';
    dialog.innerHTML = `<form method="dialog"><header><span class="zotero-z">Z</span><button value="cancel" class="icon-button" aria-label="关闭归档">×</button></header><h1>存入 Zotero</h1><p class="dialog-subtitle">保存原文、网站导读与自己的研究。</p><div class="archive-paper"><div><h2 id="archive-title">当前论文</h2><p id="archive-identity"></p></div></div><label class="archive-option"><input type="checkbox" checked disabled><span>书目与原始元数据<small>保留用户条目字段，另存完整来源记录</small></span></label><label class="archive-option"><input id="archive-pdf" type="checkbox"><span>原始 PDF<small id="archive-pdf-detail"></small></span></label><label class="archive-option"><input id="archive-guide" type="checkbox"><span>图文导读<small id="archive-guide-detail"></small></span></label><label class="archive-option"><input id="archive-note" type="checkbox"><span>个人研究笔记<small id="archive-note-detail"></small></span></label><div class="archive-destination"></div><div class="archive-connection"></div><footer><button value="cancel" class="secondary-button">关闭</button><button id="archive-connect" type="button"></button></footer></form>`;
    document.body.append(dialog);
  }
  settingsPane.innerHTML = `<h1>Zotero</h1><p>保存论文、真实附件与自己的研究记录。</p><div class="settings-group"><div><span>本机客户端</span><span id="zotero-version-status">尚未检查</span></div><div><span>写入权限</span><span id="zotero-auth-status">尚未授权</span></div></div><p class="settings-help">读取分类不需要写入许可。连接时，Zotero 会显示原生授权窗口。持续允许授予此应用对全部可编辑文库的写入权限；每次归档仍只处理你选择的论文和分类。</p><div class="zotero-buttons"><button id="zotero-refresh" class="secondary-button">检查本机连接</button><button id="zotero-authorize" class="primary-button">请求写入授权…</button><button id="zotero-open-archive" class="secondary-button">归档当前论文</button></div><p id="zotero-settings-result" role="status"></p><div id="zotero-pending"></div><div id="zotero-recent"></div>`;
  if (!$('zotero-ui-style')) {
    const style = document.createElement('style'); style.id = 'zotero-ui-style';
    style.textContent = '.zotero-buttons{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.zotero-destination{display:grid;gap:8px;margin:16px 0;font-size:12px}.zotero-destination select,.zotero-destination input{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}.zotero-destination label{display:grid;gap:5px}.zotero-step-list{list-style:none;padding:0;margin:12px 0;font-size:12px}.zotero-step-list li{padding:6px 0;border-bottom:1px solid var(--line)}.zotero-step-list small{display:block;color:var(--muted);margin-top:3px}.zotero-step-list .failed{color:var(--red)}.zotero-pending-row{padding:10px 0;border-top:1px solid var(--line);font-size:12px}.zotero-pending-row p{margin-bottom:6px}.zotero-status-text{font-size:12px;line-height:1.7;margin:12px 0}';
    document.head.append(style);
  }
  const destination = dialog.querySelector('.archive-destination');
  destination.className = 'zotero-destination';
  destination.innerHTML = `<label>目标分类<select id="zotero-collection"><option value="">检查连接后选择分类</option></select></label><label>或新建分类<input id="zotero-new-collection" placeholder="填写名称才会创建，不会自动创建分类" autocomplete="off"></label>`;
  const noteOption = $('archive-note').closest('label');
  const analysisOption = document.createElement('label'); analysisOption.className = 'archive-option';
  analysisOption.innerHTML = '<input id="archive-analysis" type="checkbox"><span>个人解析<small id="archive-analysis-detail">仅归档真实已保存的个人解析</small></span>';
  noteOption.before(analysisOption);
  const connection = dialog.querySelector('.archive-connection');
  connection.innerHTML = '<span id="zotero-connection-message">尚未检查本机连接</span>';
  const result = document.createElement('section'); result.innerHTML = '<p id="zotero-result" class="zotero-status-text" role="status"></p><ul id="zotero-steps" class="zotero-step-list"></ul>';
  connection.after(result);
  const footer = dialog.querySelector('footer');
  $('archive-connect').remove();
  const grantButton = document.createElement('button'); grantButton.id = 'zotero-dialog-authorize'; grantButton.type = 'button'; grantButton.className = 'secondary-button'; grantButton.textContent = '请求授权…';
  const checkButton = document.createElement('button'); checkButton.id = 'zotero-check-saved'; checkButton.type = 'button'; checkButton.className = 'secondary-button'; checkButton.textContent = '检查已保存许可…';
  const settingsCheck = checkButton.cloneNode(true); settingsCheck.id = 'zotero-settings-check-saved'; $('zotero-authorize').before(settingsCheck);
  const start = document.createElement('button'); start.id = 'zotero-archive-start'; start.type = 'button'; start.className = 'primary-button'; start.textContent = '存入所选分类';
  const retry = document.createElement('button'); retry.id = 'zotero-archive-retry'; retry.type = 'button'; retry.className = 'secondary-button'; retry.textContent = '重试未完成部分'; retry.hidden = true;
  const open = document.createElement('button'); open.id = 'zotero-open-item'; open.type = 'button'; open.className = 'secondary-button'; open.textContent = '在 Zotero 中查看'; open.hidden = true;
  footer.append(checkButton, grantButton, retry, open, start);
  const roleNames = {bibliography:'书目与目标分类','source-metadata':'完整来源元数据',pdf:'原始 PDF 附件',guide:'自包含图文导读',analysis:'个人解析',note:'研究笔记'};

  function updateControls() {
    const writable = !!status?.authorized && !!status?.remember && !!status?.writesSupported;
    const unchecked = !status?.authorizationState || status.authorizationState === 'unknown';
    $('zotero-version-status').textContent = status?.running ? `Zotero ${status.version || '版本未知'}` : '尚未连接';
    $('zotero-auth-status').textContent = status?.denied ? '已拒绝，未写入' : status?.authorizationState==='unavailable' ? '已保存许可未能读取' : !status?.authorized && unchecked ? '已保存许可尚未检查' : !status?.authorized ? '尚未授权' : status.remember ? '已获持续授权' : '仅单次授权，不能开始多步归档';
    $('zotero-connection-message').textContent = writable ? '已获本机写入许可。将逐项保存并回读验证，失败项目可以续传。' : !status?.authorized && unchecked ? '连接与分类查询不读取密钥。可主动检查已保存许可；系统可能请你确认钥匙串访问。' : status?.authorized ? '单次许可不足以完成多步附件归档。请在 Zotero 的原生窗口中自行决定是否持续允许。' : '可检查已保存许可，或在 Zotero 原生窗口中明确请求新的写入授权。';
    $('zotero-authorize').disabled = busy; grantButton.disabled = busy;
    $('zotero-refresh').disabled = busy;
    document.querySelectorAll('#zotero-pending [data-zotero-resume],#zotero-recent [data-zotero-resume]').forEach(button => { button.disabled = busy; });
    checkButton.disabled = busy || !status?.writesSupported; settingsCheck.disabled = checkButton.disabled;
    checkButton.hidden = writable; settingsCheck.hidden = writable;
    start.disabled = busy || !writable || !materials || (!collectionKey() && !collectionName());
    retry.disabled = busy || !writable;
    grantButton.hidden = writable;
  }
  function collectionKey() { return $('zotero-new-collection').value.trim() ? '' : $('zotero-collection').value; }
  function collectionName() { return $('zotero-new-collection').value.trim(); }
  function renderCollections() {
    const previous = $('zotero-collection').value;
    const names = new Map(collections.map(c => [c.key,c]));
    function label(c) { const parts = [c.name], seen = new Set([c.key]); let parent = names.get(c.parentKey); while (parent && !seen.has(parent.key)) { seen.add(parent.key); parts.unshift(parent.name); parent = names.get(parent.parentKey); } return parts.join(' / '); }
    $('zotero-collection').innerHTML = '<option value="">请选择分类</option>' + collections.map(c => `<option value="${escape(c.key)}">${escape(label(c))}</option>`).join('');
    if (collections.some(c => c.key === previous)) $('zotero-collection').value = previous;
  }
  function renderPending() {
    const pending = (status?.archives || []).filter(a => a.status === 'partial');
    $('zotero-pending').innerHTML = pending.length ? '<h2>未完成归档</h2>' + pending.map(a => `<div class="zotero-pending-row"><p>${escape(a.title)}</p><button class="secondary-button" data-zotero-resume="${escape(a.archiveID)}">从已保存步骤继续</button></div>`).join('') : '';
    const recent = (status?.archives || []).filter(a => a.status === 'complete').slice(0,8);
    $('zotero-recent').innerHTML = recent.length ? '<h2>最近归档</h2>' + recent.map(a => `<div class="zotero-pending-row"><p>${escape(a.title)}</p><button type="button" class="secondary-button" data-zotero-resume="${escape(a.archiveID)}">重新回读核验</button></div>`).join('') : '';
    document.querySelectorAll('#zotero-pending [data-zotero-resume],#zotero-recent [data-zotero-resume]').forEach(button => { button.onclick = () => resume(button.dataset.zoteroResume); });
  }
  async function refresh() {
    try {
      status = await app.call('zotero.status', {});
      const value = await app.call('zotero.collections', {}); collections = value.collections || [];
      renderCollections(); renderPending();
      $('zotero-settings-result').textContent = `${collections.length} 个本机分类可供选择；尚未为此操作修改文库。`;
    } catch (error) { status = null; collections = []; $('zotero-settings-result').textContent = error?.message || String(error); }
    updateControls();
    return status;
  }
  async function authorize() {
    if (busy) return;
    busy = true; updateControls();
    $('zotero-settings-result').textContent = '等待你在 Zotero 原生授权窗口中选择。应用不会代为确认。';
    try {
      status = await app.call('zotero.authorize', {});
      notice(status.denied ? '已拒绝写入授权，没有开始归档' : status.remember ? 'Zotero 持续授权已就绪' : '获得一次写入许可；完整附件归档需要持续许可');
      await refresh();
    } catch (error) { failure(error); }
    finally { busy = false; updateControls(); }
  }
  async function checkSavedAuthorization() {
    if (busy) return;
    busy = true; updateControls();
    $('zotero-settings-result').textContent = '正在读取此文库的已保存许可；如系统询问，请自行决定是否允许。不会请求新的 Zotero 许可。';
    try { status = await app.call('zotero.checkAuthorization', {}); await refresh(); }
    catch (error) { failure(error); await refresh(); }
    finally { busy = false; updateControls(); }
  }
  function showResult(value) {
    lastResult = value;
    $('zotero-result').textContent = value.status === 'complete' ? '所选内容均已保存，并完成回读核验。' : '部分内容未完成。已保存的结果保留，只重试缺失或未通过核验的部分。';
    $('zotero-steps').innerHTML = (value.steps || []).map(step => `<li class="${step.verified ? '' : 'failed'}">${escape(roleNames[step.role] || step.role)} · ${step.verified ? '已保存并核验' : '尚未完成'}${step.error ? `<small>${escape(step.error)}</small>` : ''}</li>`).join('');
    retry.hidden = value.status === 'complete'; open.hidden = !value.parentKey;
    app.emit?.('zotero.archive.result',value);
  }
  async function openArchive() {
    if (busy) { notice('归档正在执行，完成状态会保留在此窗口'); return; }
    const token = ++generation, identity = paperIdentity(); materials = null; lastResult = null;
    $('zotero-result').textContent = '正在准备当前论文的真实归档材料…'; $('zotero-steps').replaceChildren(); retry.hidden = true; open.hidden = true;
    if (!dialog.open) dialog.showModal();
    updateControls();
    try {
      const prepared = await app.exportArchiveMaterials();
      if (token !== generation || identity !== paperIdentity()) return;
      materials = prepared;
      $('archive-title').textContent = prepared.bibliography?.title || app.state?.paper?.title || '当前论文';
      $('archive-identity').textContent = prepared.identity;
      for (const [id,field] of [['archive-pdf','pdfPath'],['archive-guide','guideHTMLPath'],['archive-analysis','analysisHTML'],['archive-note','noteHTML']]) {
        const present = !!prepared[field]; $(id).disabled = !present; $(id).checked = present;
      }
      $('archive-pdf-detail').textContent = prepared.pdfPath ? '指定原文版本，归档后核对真实存储文件' : '没有可核对的本地 PDF，不会归档空附件';
      $('archive-guide-detail').textContent = prepared.guideHTMLPath ? '完整 HTML，图片内嵌并保留表格与公式' : '自包含导读尚未准备好';
      $('archive-analysis-detail').textContent = prepared.analysisHTML ? '已保存的个人解析与实际研究材料' : prepared.analysisNotice || '当前没有已保存个人解析';
      $('archive-note-detail').textContent = prepared.noteHTML ? '当前已保存研究笔记' : '当前没有研究笔记';
      $('zotero-result').textContent = '核对内容和目标分类后开始。书目成功不代表附件已经完成。';
      await refresh();
    } catch (error) { failure(error); }
    finally { updateControls(); }
  }
  async function archive() {
    if (start.disabled || busy || !materials) return;
    const request = {...materials,collectionKey:collectionKey() || undefined,collectionName:collectionName() || undefined};
    for (const [id,field] of [['archive-pdf','pdfPath'],['archive-guide','guideHTMLPath'],['archive-analysis','analysisHTML'],['archive-note','noteHTML']]) if (!$(id).checked) delete request[field];
    busy = true; updateControls(); $('zotero-result').textContent = '正在保存并逐项回读，请保留 Zotero 运行。';
    try { showResult(await app.call('zotero.archive',request)); await refresh(); }
    catch (error) { failure(error); }
    finally { busy = false; updateControls(); }
  }
  async function resume(id = lastResult?.archiveID) {
    if (busy || !id) return;
    const context = (status?.archives || []).find(item => item.archiveID === id);
    materials = null; lastResult = null;
    $('zotero-steps').replaceChildren(); retry.hidden = true; open.hidden = true;
    if (context) { $('archive-title').textContent = context.title; $('archive-identity').textContent = context.identity; }
    for (const option of ['archive-pdf','archive-guide','archive-analysis','archive-note']) { $(option).disabled = true; $(option).checked = false; }
    busy = true; updateControls();
    if (!dialog.open) dialog.showModal();
    $('zotero-result').textContent = '正在重读原检查点和真实存储结果，只续未完成内容…';
    try { showResult(await app.call('zotero.resume',{resumeID:id})); await refresh(); }
    catch (error) { failure(error); }
    finally { busy = false; updateControls(); }
  }
  function handleProgress(progress) {
    if (!busy) return;
    $('zotero-result').textContent = `${roleNames[progress.role] || progress.role || '归档'} · ${progress.state === 'verified' ? '已完成回读核验' : progress.state === 'failed' ? '此项失败，保留已完成内容' : '正在处理'}`;
  }
  if ($('archive-open')) $('archive-open').onclick = openArchive;
  $('zotero-open-archive').onclick = openArchive;
  $('zotero-refresh').onclick = refresh;
  $('zotero-authorize').onclick = authorize; grantButton.onclick = authorize;
  checkButton.onclick = checkSavedAuthorization; settingsCheck.onclick = checkSavedAuthorization;
  $('zotero-collection').onchange = updateControls; $('zotero-new-collection').oninput = updateControls;
  start.onclick = archive; retry.onclick = () => resume();
  open.onclick = () => { if (lastResult?.parentKey) app.call('zotero.open',{key:lastResult.parentKey}).catch(failure); };
  updateControls();
  return {openArchive,refresh,handleProgress};
}
