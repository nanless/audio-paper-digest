const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fold = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const paperID = paper => paper.paperID || paper.id;

/** Published catalog view. All durable personal writes go through the native store. */
export function mountLibrary(app) {
  const $ = id => document.getElementById(id);
  const views = new Set(['library', 'today', 'conference', 'favorites', 'reading-list']);
  const selected = new Set();
  const filters = {task: '', method: '', source: '', score: '', from: '', until: ''};
  let page = 0, loaded = false, loading = null, renderSequence = 0, searchTimer;
  let lastView, persistBusy = false, popup = null;
  const pageSize = 100;
  const fail = error => { if (typeof app.error === 'function') app.error(error); else app.toast(error?.message || String(error)); };
  const personal = () => app.state.personal || {};
  const published = () => Array.isArray(app.state.catalog) ? app.state.catalog : [];
  const catalog = () => {
    const map=new Map(published().map(p=>[paperID(p),p]));
    for(const [id,p]of Object.entries(personal().personalPapers||{}))if(!map.has(id))map.set(id,{...p,id,paperID:id,localRetained:true});
    return [...map.values()];
  };
  const membership = key => new Set(Array.isArray(personal()[key]) ? personal()[key] : []);
  function counts() {
    if ($('library-count')) $('library-count').textContent = app.state.summary?.paperCount ?? catalog().length;
    if ($('favorite-count')) $('favorite-count').textContent = membership('favorites').size || '';
    if ($('reading-count')) $('reading-count').textContent = membership('reading').size || '';
  }
  if (!document.getElementById('library-native-style')) {
    const style = document.createElement('style'); style.id = 'library-native-style';
    style.textContent = `.library-filters{display:flex;gap:10px;flex-wrap:wrap;padding:0 40px 18px;align-items:center}.library-filters label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)}.library-filters select,.library-filters input{max-width:165px;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:4px 7px;font:inherit}.library-filters input[type=date]{width:125px}.library-selection-bar{display:flex;align-items:center;gap:8px;margin:0 40px 13px;min-height:32px;font-size:12px}.library-selection-bar>span{color:var(--muted);margin-right:auto}.library-selection-bar button,.library-pagination button{border:1px solid var(--line);padding:5px 9px;font-size:12px}.library-table.lib-multi th:first-child{width:35px}.library-table.lib-multi th:nth-child(2){width:48%}.library-table.lib-multi th:nth-child(3){width:14%}.library-table.lib-multi th:nth-child(4){width:10%}.library-table.lib-multi th:nth-child(5){width:10%}.library-table.lib-multi th:nth-child(6){width:12%}.library-table.lib-multi td:first-child,.library-table.lib-multi th:first-child{padding-left:10px;padding-right:6px}.library-table.lib-multi tr.is-selected td{background:var(--accent-soft)}.library-pagination{display:flex;gap:9px;align-items:center;font-size:12px}.library-context{position:fixed;z-index:120;min-width:180px;max-width:280px;padding:5px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px #0003}.library-context button{display:flex;justify-content:flex-start;width:100%;padding:7px 10px;font-size:12px}.library-context hr{border:0;border-top:1px solid var(--line);margin:4px}.library-query-scope{font-size:11px;color:var(--muted);margin:0 40px 12px}.library-check{width:14px;height:14px;accent-color:var(--accent)}@media(max-width:1250px){.library-filters{padding-left:30px;padding-right:30px;gap:8px}.library-selection-bar,.library-query-scope{margin-left:30px;margin-right:30px}}`;
    document.head.append(style);
  }
  const filterBar = document.createElement('div'); filterBar.className = 'library-filters';
  filterBar.innerHTML = `<label>任务<select id="library-task"><option value="">全部任务</option></select></label><label>方法<select id="library-method"><option value="">全部方法</option></select></label><label>来源<select id="library-source"><option value="">全部来源</option><option value="arxiv">arXiv</option><option value="conference">正式会议</option><option value="unknown">待核验来源</option></select></label><label>评分<select id="library-min-score"><option value="">不限</option>${[5,6,7,8,9].map(n=>`<option value="${n}">≥ ${n}</option>`).join('')}</select></label><label>网站日期<input id="library-date-from" type="date" aria-label="网站发布日期起点"></label><label>至<input id="library-date-until" type="date" aria-label="网站发布日期终点"></label><button id="library-clear-filters" type="button">清除筛选</button>`;
  $('library-view').querySelector('.library-controls').after(filterBar);
  const scope = document.createElement('p'); scope.className = 'library-query-scope'; scope.textContent = '搜索标题、作者、编号与标签；同时匹配已缓存导读和自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
  filterBar.after(scope);
  const bar = document.createElement('div'); bar.className = 'library-selection-bar';
  bar.innerHTML = '<span id="library-selection-count">可多选论文，或右键打开操作菜单</span><button id="library-selection-favorite" type="button" disabled>收藏选中</button><button id="library-selection-reading" type="button" disabled>加入待读</button><button id="library-selection-clear" type="button" disabled>取消选择</button>';
  scope.after(bar);
  const table = $('paper-rows').closest('table'); table.classList.add('lib-multi');
  const th = document.createElement('th'); th.innerHTML = '<input class="library-check" id="library-select-page" type="checkbox" aria-label="选择当前页全部论文">';
  table.querySelector('thead tr').prepend(th);
  const pager = document.createElement('div'); pager.className = 'library-pagination';
  pager.innerHTML = '<button id="library-previous" type="button">上一页</button><span id="library-page-label"></span><button id="library-next" type="button">下一页</button>';
  const footer = $('library-view').querySelector('.library-footer'); footer.lastElementChild?.remove(); footer.append(pager);
  $('search-input').placeholder = '搜索论文、缓存导读或我的笔记';
  function updateSelection() {
    $('library-selection-count').textContent = selected.size ? `已选 ${selected.size} 篇论文` : '可多选论文，或右键打开操作菜单';
    for (const id of ['library-selection-favorite','library-selection-reading','library-selection-clear']) $(id).disabled = persistBusy || !selected.size;
  }
  function fillOptions() {
    for (const key of ['task','method']) {
      const select = $('library-' + key), previous = filters[key];
      const values = [...new Set(catalog().map(p => p[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
      select.innerHTML = `<option value="">全部${key==='task'?'任务':'方法'}</option>` + values.map(v=>`<option value="${escape(v)}">${escape(v)}</option>`).join('');
      select.value = values.includes(previous) ? previous : ''; filters[key] = select.value;
    }
  }
  async function persistedList(key, ids, remove = false) {
    if (persistBusy || !ids.length) return;
    persistBusy = true; updateSelection(); closePopup();
    try {
      const latest = await app.call('personal.snapshot', {});
      const next = new Set(latest[key] || []);
      ids.forEach(id => remove ? next.delete(id) : next.add(id));
      const result = await app.call('personal.setList', {key, ids: [...next]});
      app.state.personal = result.personal || result;
      app.toast(remove ? '已更新本机清单' : key === 'favorites' ? `已收藏 ${ids.length} 篇论文` : `已将 ${ids.length} 篇加入待读`);
      counts(); await render();
    } catch (error) { fail(error); }
    finally { persistBusy = false; updateSelection(); }
  }
  async function refresh() {
    if (loading) return loading;
    loading = (async()=>{
      const [summary, result, snapshot] = await Promise.all([app.call('library.status', {}), app.call('library.list', {limit:10000}),app.call('personal.snapshot',{})]);app.state.personal=snapshot;
      app.state.summary = summary; app.state.catalog = result.papers || [];
      loaded = true; page = 0; fillOptions();
      const ids = new Set(catalog().map(paperID)); for (const id of selected) if (!ids.has(id)) selected.delete(id);
      counts(); await render();
    })();
    try { return await loading; } catch (error) { fail(error); } finally { loading = null; }
  }
  async function render() {
    counts();
    if (!views.has(app.state.view || 'library')) return;
    if (!loaded && !catalog().length) { if (!loading) await refresh(); return; }
    loaded = true;
    const sequence = ++renderSequence, view = app.state.view || 'library';
    if (lastView !== view) { page = 0; selected.clear(); lastView = view; }
    const query = $('search-input').value.trim(), needle = fold(query), favorites = membership('favorites'), reading = membership('reading');
    let extraIDs = new Set();
    if (query) {
      const settled = await Promise.allSettled([app.call('library.search',{query}),app.call('personal.search',{query})]);
      for (const item of settled) if (item.status === 'fulfilled') {
        const result = item.value; for (const id of Array.isArray(result) ? result : result.ids || result.paperIDs || []) extraIDs.add(id);
      }
      if (settled.some(item=>item.status==='rejected')) scope.textContent = '部分本机全文或笔记索引暂不可读，当前仍搜索论文元数据；PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
      else scope.textContent = '已同时搜索论文元数据、本机缓存导读与自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
    } else scope.textContent = '搜索标题、作者、编号与标签；同时匹配已缓存导读和自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
    if (sequence !== renderSequence) return;
    const today = new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
    const papers = catalog().filter(p => {
      const id = paperID(p);
      if (view==='favorites' && !favorites.has(id)) return false;
      if (view==='reading-list' && !reading.has(id)) return false;
      if (view==='today' && p.date!==today) return false;
      if (view==='conference' && p.sourceKind!=='conference') return false;
      if (filters.task && p.task!==filters.task || filters.method && p.method!==filters.method || filters.source && p.sourceKind!==filters.source) return false;
      if (filters.score && (p.score===null || p.score===undefined || Number(p.score)<Number(filters.score))) return false;
      if (filters.from && p.date<filters.from || filters.until && p.date>filters.until) return false;
      return !needle || extraIDs.has(id) || fold([p.id,p.title,p.titleZh,p.task,p.method,...(p.authors||[]),...(p.tags||[])].join(' ')).includes(needle);
    });
    const sort = $('sort').value;
    papers.sort((a,b)=>sort==='score'?(b.score??-Infinity)-(a.score??-Infinity)||a.id.localeCompare(b.id):sort==='title'?(a.titleZh||a.title).localeCompare(b.titleZh||b.title,'zh-CN')||a.id.localeCompare(b.id):(b.date||'').localeCompare(a.date||'')||a.id.localeCompare(b.id));
    const pageCount = Math.max(1,Math.ceil(papers.length/pageSize)); page = Math.min(page,pageCount-1);
    const visible = papers.slice(page*pageSize,(page+1)*pageSize);
    $('library-title').textContent = {library:'全部论文',today:'今日更新',conference:'会议整理',favorites:'已收藏','reading-list':'待读'}[view];
    $('library-subtitle').textContent = `${catalog().length.toLocaleString()} 篇本地目录论文 · ${app.state.summary?.recordCount?.toLocaleString() || '—'} 条网站页面记录 · 原有评分与分类`;
    $('paper-rows').innerHTML = visible.map(p=>{
      const id=paperID(p), author=(p.authors||[]).slice(0,2).join('、'), score=Number.isFinite(p.score)?p.score.toFixed(1):'—';
      const state = [p.localRetained?(p.sourceKind==='local'?'本地 PDF':app.state.summary?.syncedAt?'本机保留 · 未在最新目录':'本机保留'):'',favorites.has(id)?'已收藏':'',reading.has(id)?'待读':'',app.state.paper && paperID(app.state.paper)===id?'正在阅读':''].filter(Boolean).join(' · ') || '未标记';
      return `<tr data-library-row="${escape(id)}" class="${selected.has(id)?'is-selected':''}"><td><input class="library-check" type="checkbox" data-library-select="${escape(id)}" aria-label="选择 ${escape(p.titleZh||p.title)}" ${selected.has(id)?'checked':''}></td><td><button class="paper-title-button" data-library-open="${escape(id)}"><span class="paper-row-title">${escape(p.titleZh||p.title)}</span><span class="paper-row-meta">${escape(id.replace(/^arxiv:/,''))} · ${escape(author)}${(p.authors||[]).length>2?' 等':''}</span></button></td><td>${escape(p.task||'未分类')}</td><td>${escape(p.date||'未知')}</td><td class="numeric">${score}</td><td>${escape(state)}</td></tr>`;
    }).join('');
    $('library-empty').hidden = papers.length>0;
    $('result-count').textContent = `${papers.length.toLocaleString()} 篇匹配 / ${catalog().length.toLocaleString()} 篇论文${papers.length?' · '+(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,papers.length):''}`;
    $('library-page-label').textContent = `${page+1} / ${pageCount}`;
    $('library-previous').disabled = page===0; $('library-next').disabled = page>=pageCount-1;
    $('library-select-page').checked = visible.length>0 && visible.every(p=>selected.has(paperID(p)));
    $('library-select-page').indeterminate = visible.some(p=>selected.has(paperID(p))) && !$('library-select-page').checked;
    $('library-select-page').onchange = event => { visible.forEach(p=>event.target.checked?selected.add(paperID(p)):selected.delete(paperID(p))); render().catch(fail); };
    updateSelection();
  }
  function closePopup() { popup?.remove(); popup=null; }
  function openContext(event, paper) {
    event.preventDefault(); closePopup();
    const id=paperID(paper); if(!selected.has(id)){selected.clear();selected.add(id);render().catch(fail);}
    popup=document.createElement('div');popup.className='library-context';popup.setAttribute('role','menu');
    const favorite=membership('favorites').has(id),reading=membership('reading').has(id);
    const actions=[['打开导读',()=>app.openPaper(paper)], [favorite?'取消收藏':'收藏论文',()=>persistedList('favorites',[id],favorite)], [reading?'移出待读':'加入待读',()=>persistedList('reading',[id],reading)], ...(paper.blogURL?[['在浏览器打开网站',()=>app.call('app.external',{url:paper.blogURL})]]:[])];
    for(const [label,action] of actions){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{closePopup();Promise.resolve().then(action).catch(fail);};popup.append(button);}
    document.body.append(popup);popup.style.left=`${Math.max(8,Math.min(event.clientX,innerWidth-popup.offsetWidth-8))}px`;popup.style.top=`${Math.max(8,Math.min(event.clientY,innerHeight-popup.offsetHeight-8))}px`;popup.querySelector('button').focus();
  }
  $('paper-rows').onclick=event=>{const check=event.target.closest('[data-library-select]');if(check){check.checked?selected.add(check.dataset.librarySelect):selected.delete(check.dataset.librarySelect);render().catch(fail);return;}const button=event.target.closest('[data-library-open]');if(button){const paper=catalog().find(p=>paperID(p)===button.dataset.libraryOpen);if(paper)Promise.resolve(app.openPaper(paper)).catch(fail);}};
  $('paper-rows').addEventListener('contextmenu',event=>{const row=event.target.closest('[data-library-row]');if(!row)return;const paper=catalog().find(p=>paperID(p)===row.dataset.libraryRow);if(paper)openContext(event,paper);});
  $('search-input').oninput=()=>{page=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>render().catch(fail),220);};
  $('sort').onchange=()=>{page=0;render().catch(fail);};
  for(const [id,key] of [['library-task','task'],['library-method','method'],['library-source','source'],['library-min-score','score'],['library-date-from','from'],['library-date-until','until']]) $(id).onchange=event=>{filters[key]=event.target.value;page=0;render().catch(fail);};
  $('library-clear-filters').onclick=()=>{for(const key of Object.keys(filters))filters[key]='';for(const el of filterBar.querySelectorAll('select,input'))el.value='';$('search-input').value='';page=0;render().catch(fail);};
  $('reset-search').onclick=()=>{$('search-input').value='';page=0;render().catch(fail);};
  $('library-previous').onclick=()=>{page=Math.max(0,page-1);render().catch(fail);$('library-view').querySelector('.library-table-wrap').scrollTop=0;};
  $('library-next').onclick=()=>{page++;render().catch(fail);$('library-view').querySelector('.library-table-wrap').scrollTop=0;};
  $('library-selection-favorite').onclick=()=>persistedList('favorites',[...selected]);
  $('library-selection-reading').onclick=()=>persistedList('reading',[...selected]);
  $('library-selection-clear').onclick=()=>{selected.clear();render().catch(fail);};
  document.addEventListener('pointerdown',event=>{if(popup&&!popup.contains(event.target))closePopup();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closePopup();if(popup&&['ArrowDown','ArrowUp'].includes(event.key)){const buttons=[...popup.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}});
  window.addEventListener('blur',closePopup);
  if(catalog().length){loaded=true;fillOptions();}
  return {render,refresh};
}
