import {favoriteDate, favoriteSection} from './favorites-ui.js';
import {mountWebsiteBrowser} from './website-browser.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fold = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const paperID = paper => paper.paperID || paper.id;
const sourceLabel = kind => kind === 'arxiv' ? 'arXiv' : kind === 'conference' ? '正式会议' : kind === 'local' ? '本地 PDF' : '待核验来源';
function paperDetails(paper, expanded, classificationGuides=[]) {
  const method = typeof paper.method === 'string' && paper.method.trim() ? paper.method : '未提供方法';
  const authors = Array.isArray(paper.authors) ? paper.authors.filter(name => typeof name === 'string' && name.trim()) : [];
  const tags = Array.isArray(paper.tags) ? [...new Set(paper.tags.filter(tag => typeof tag === 'string' && tag.trim()))] : [];
  const fields = [['论文编号',paperID(paper)],['来源',sourceLabel(paper.sourceKind)],['作者',authors.join('、') || '未提供作者'],['方法',method],['标签',tags.join(' · ') || '未提供标签']];
  const guideRows=Array.isArray(paper.websiteTagRecords)?paper.websiteTagRecords:[],guides=[...new Set(paper.appearances||[])].filter(url=>{try{const value=new URL(url),base=new URL(paper.blogURL);return value.protocol==='https:'&&!value.username&&!value.password&&value.origin===base.origin;}catch{return false;}});
  const guideLinks=guides.length?`<div class="library-published-guides"><strong>网站已发布导读 · ${guides.length} 篇</strong>${guides.map((url,i)=>{const info=classificationGuides.find(value=>{try{return new URL(value.row.permalink,paper.blogURL).href===url;}catch{return false;}}),row=info?.row||guideRows.find(row=>{try{return new URL(row.permalink,paper.blogURL).href===url;}catch{return false;}}),publishedScore=row?.score==null||String(row.score).trim()===''?'未提供':String(row.score);return `<div class="library-guide-entry"><span>${url===paper.blogURL?'默认阅读导读 · ':''}${info?.matched?'匹配当前筛选 · ':''}${escape(row?.date||'日期未标明')} · 网站评分 ${escape(publishedScore)}</span><button type="button" data-library-guide="${escape(url)}">${escape(row?.titleZh||row?.title||'网站导读 '+(i+1))}<span>在原站打开 ↗</span></button>${info?.paths.length?`<p>${escape(info.paths.join('；'))}</p>`:''}</div>`;}).join('')}</div>`:'';
  return `<details class="library-paper-details" ${expanded ? 'open' : ''}><summary>${escape(sourceLabel(paper.sourceKind))} · ${escape(method)}<span class="library-details-hint">${tags.length ? tags.length+' 个标签' : '文献信息'}</span></summary><dl>${fields.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${guideLinks}</details>`;
}

/** Published catalog view. All durable personal writes go through the native store. */
export function mountLibrary(app, {onVisibilityChange}={}) {
  const $ = id => document.getElementById(id);
  const views = new Set(['library', 'directions', 'today', 'conference', 'favorites', 'reading-list']);
  const selected = new Set();
  const expandedMetadata = new Set();
  const viewStates=new Map();let matchingIDs=new Set();
  const filters = {task: '', method: '', source: '', score: '', from: '', until: ''};
  let page = 0, loaded = false, loading = null, renderSequence = 0, searchTimer, refreshGeneration=0;
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
    style.textContent = `.library-filters{display:flex;gap:10px;flex-wrap:wrap;padding:0 40px 18px;align-items:center}.library-filters label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)}.library-filters select,.library-filters input{max-width:165px;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:4px 7px;font:inherit}.library-filters input[type=date]{width:125px}.library-selection-bar{display:flex;align-items:center;gap:8px;margin:0 40px 13px;min-height:32px;font-size:12px}.library-selection-bar>span{color:var(--muted);margin-right:auto}.library-selection-bar button,.library-pagination button{border:1px solid var(--line);padding:5px 9px;font-size:12px}.library-table.lib-multi th:first-child{width:35px}.library-table.lib-multi th:nth-child(2){width:48%}.library-table.lib-multi th:nth-child(3){width:14%}.library-table.lib-multi th:nth-child(4){width:10%}.library-table.lib-multi th:nth-child(5){width:10%}.library-table.lib-multi th:nth-child(6){width:12%}.library-table.lib-multi td:first-child,.library-table.lib-multi th:first-child{padding-left:10px;padding-right:6px}.library-table.lib-multi tr.is-selected td{background:var(--accent-soft)}.library-pagination{display:flex;gap:9px;align-items:center;font-size:12px}.library-context{position:fixed;z-index:120;min-width:180px;max-width:280px;padding:5px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px #0003}.library-context button{display:flex;justify-content:flex-start;width:100%;padding:7px 10px;font-size:12px}.library-context hr{border:0;border-top:1px solid var(--line);margin:4px}.library-query-scope{font-size:11px;color:var(--muted);margin:0 40px 12px}.library-check{width:14px;height:14px;accent-color:var(--accent)}.library-paper-details{margin-top:6px;color:var(--muted);font-size:11px;font-weight:400;white-space:normal}.library-paper-details summary{cursor:pointer;width:fit-content;max-width:100%;overflow-wrap:anywhere;line-height:1.7}.library-paper-details summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:3px}.library-details-hint{margin-left:9px;opacity:.8}.library-paper-details[open]{border-left:2px solid var(--line);padding-left:10px}.library-paper-details dl{margin:9px 0 2px;max-width:100%;line-height:1.7}.library-paper-details dl>div{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;margin:5px 0}.library-paper-details dt{font-weight:500}.library-paper-details dd{margin:0;overflow-wrap:anywhere;color:var(--ink)}@media(max-width:1250px){.library-filters{padding-left:30px;padding-right:30px;gap:8px}.library-selection-bar,.library-query-scope{margin-left:30px;margin-right:30px}}`;
    style.textContent += '.library-filter-toggle{margin:0 40px 12px;padding:5px 8px;border:1px solid var(--line);font-size:12px}.favorite-section th{padding:12px 10px!important;background:var(--accent-soft);text-align:left;font-size:12px}.favorite-row-meta{display:block;color:var(--muted);font-size:11px;margin-top:5px;white-space:normal}';
    style.textContent += '.library-view.personal-list .page-heading{padding-top:12px;padding-bottom:10px;gap:12px}.library-view.personal-list .page-heading .eyebrow{display:none}.library-view.personal-list .page-heading h1{font-size:24px;line-height:1.25}.library-view.personal-list .page-heading p{font-size:12px;line-height:1.5;margin-top:4px}.library-view.personal-list .library-controls{padding-bottom:10px;gap:12px}.library-view.personal-list .library-selection-bar{min-height:28px;margin-bottom:6px}.library-view.personal-list .library-filter-toggle{margin-bottom:6px}';
    document.head.append(style);
  }
  const filterBar = document.createElement('div'); filterBar.className = 'library-filters';
  filterBar.innerHTML = `<label>来源<select id="library-source"><option value="">全部来源</option><option value="arxiv">arXiv</option><option value="conference">正式会议</option><option value="unknown">待核验来源</option></select></label><label>评分<select id="library-min-score"><option value="">不限</option>${[5,6,7,8,9].map(n=>`<option value="${n}">≥ ${n}</option>`).join('')}</select></label><label>网站日期<input id="library-date-from" type="date" aria-label="网站发布日期起点"></label><label>至<input id="library-date-until" type="date" aria-label="网站发布日期终点"></label><button id="library-clear-filters" type="button">清除筛选</button>`;
  $('library-view').querySelector('.library-controls').after(filterBar);
  const filterToggle=document.createElement('button');filterToggle.type='button';filterToggle.id='library-filter-toggle';filterToggle.className='library-filter-toggle';filterToggle.hidden=true;filterToggle.setAttribute('aria-expanded','false');filterToggle.onclick=()=>{filterBar.hidden=!filterBar.hidden;filterToggle.setAttribute('aria-expanded',String(!filterBar.hidden));};filterBar.before(filterToggle);
  const scope = document.createElement('p'); scope.className = 'library-query-scope'; scope.textContent = '搜索标题、作者、编号与标签；同时匹配已缓存导读和自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
  filterBar.after(scope);
  const filterMessage=document.createElement('p');filterMessage.id='library-filter-message';filterMessage.className='library-filter-message';filterMessage.hidden=true;filterMessage.setAttribute('role','alert');filterMessage.innerHTML='<span>起始日期晚于结束日期，请调整范围。</span><button type="button" id="library-fix-dates">调整日期</button>';filterBar.after(filterMessage);
  $('library-fix-dates').onclick=()=>{filterBar.hidden=false;filterToggle.setAttribute('aria-expanded','true');$('library-date-from').focus();};
  for(const id of ['library-date-from','library-date-until'])$(id).setAttribute('aria-describedby','library-filter-message');
  const catalogNotice=document.createElement('p');catalogNotice.id='library-catalog-status';catalogNotice.className='library-query-scope';catalogNotice.hidden=true;catalogNotice.setAttribute('role','status');const catalogMessage=document.createElement('span'),catalogRetry=document.createElement('button');catalogRetry.type='button';catalogRetry.textContent='重新读取本机目录';catalogRetry.hidden=true;catalogRetry.onclick=()=>refresh();catalogNotice.append(catalogMessage,catalogRetry);scope.after(catalogNotice);
  const bar = document.createElement('div'); bar.className = 'library-selection-bar';
  bar.innerHTML = '<span id="library-selection-count">可多选论文，或右键打开操作菜单</span><button id="library-selection-favorite" type="button" disabled>收藏选中</button><button id="library-selection-remove-favorite" type="button" disabled hidden>取消收藏选中</button><button id="library-selection-reading" type="button" disabled>加入待读</button><button id="library-selection-clear" type="button" disabled>取消选择</button>';
  scope.after(bar);
  const browser=document.createElement('div');browser.className='library-browser';
  const results=document.createElement('div');results.className='library-results';browser.append(results);
  $('library-view').querySelector('.page-heading').after(browser);
  for(const node of [$('library-view').querySelector('.library-controls'),filterToggle,filterBar,filterMessage,scope,catalogNotice,bar,$('library-view').querySelector('.library-table-wrap'),$('library-view').querySelector('.library-footer')])results.append(node);
  results.querySelector('.library-controls').append(filterToggle);
  const favoriteTools=mountWebsiteBrowser(app,{panelHost:browser,onVisibilityChange,contextHost:results.querySelector('.library-controls'),onChange:({resetPage=false}={})=>{if(resetPage)page=0;return render();}});
  const favoriteSort=document.createElement('option');favoriteSort.value='favorite-date';favoriteSort.textContent='收藏时间（最近优先）';favoriteSort.hidden=true;$('sort').prepend(favoriteSort);
  const table = $('paper-rows').closest('table'); table.classList.add('lib-multi');
  const th = document.createElement('th'); th.innerHTML = '<input class="library-check" id="library-select-page" type="checkbox" aria-label="选择当前页全部论文">';
  table.querySelector('thead tr').prepend(th);
  const pager = document.createElement('div'); pager.className = 'library-pagination';
  pager.innerHTML = '<button id="library-previous" type="button">上一页</button><span id="library-page-label"></span><button id="library-next" type="button">下一页</button>';
  const footer = $('library-view').querySelector('.library-footer'); footer.lastElementChild?.remove(); footer.append(pager);
  $('search-input').placeholder = '搜索论文、缓存导读或我的笔记';
  function updateSelection() {
    bar.classList.toggle('has-selection',selected.size>0);
    const hiddenSelected=[...selected].filter(id=>!matchingIDs.has(id)).length;
    $('library-selection-count').textContent = selected.size ? `已选 ${selected.size} 篇论文${hiddenSelected?'（'+hiddenSelected+' 篇不在当前筛选结果中）':''}` : '可多选论文，或右键打开操作菜单';
    for (const id of ['library-selection-favorite','library-selection-remove-favorite','library-selection-reading','library-selection-clear']) $(id).disabled = persistBusy || !selected.size || (favoriteTools.readOnly&&['library-selection-favorite','library-selection-remove-favorite'].includes(id));
  }
  async function persistedList(key, ids, remove = false) {
    if (persistBusy || !ids.length) return;
    if(key==='favorites'&&favoriteTools.readOnly){app.toast('请升级工作台后编辑收藏');return;}
    persistBusy = true; updateSelection(); closePopup();
    try {
      const result = await app.call('personal.list.edit', {key, action:remove?'remove':'add', ids:[...ids]});
      app.state.personal = result.personal || result;
      app.toast(remove ? '已更新本机清单' : key === 'favorites' ? `已收藏 ${ids.length} 篇论文` : `已将 ${ids.length} 篇加入待读`);
      counts(); await render();
    } catch (error) { fail(error); }
    finally { persistBusy = false; updateSelection(); }
  }
  async function refresh() {
    if (loading){try{return await loading;}catch{return;}}
    const generation=refreshGeneration,personalAtStart=app.state.personal;
    const flight=(async()=>{
      catalogNotice.hidden=false;catalogRetry.hidden=true;catalogMessage.textContent='正在读取本机目录…';
      const [summary, first, snapshot] = await Promise.all([app.call('library.status', {}), app.call('library.list', {limit:10000,offset:0}),app.call('personal.snapshot',{})]);
      if(generation!==refreshGeneration)return;
      const rows=[...(first.papers||[])],total=first.total??rows.length,stamp=first.snapshotID;
      if(stamp!==undefined&&summary.snapshotID!==undefined&&stamp!==summary.snapshotID)throw new Error('目录摘要与列表发生变化，请重新读取；上一份列表仍保留');
      if(!Number.isSafeInteger(total)||total<rows.length||total>1000000)throw new Error('本机目录分页总数无效，上一份列表仍保留');
      while(rows.length<total){
        catalogMessage.textContent=`正在读取本机目录：${rows.length.toLocaleString()} / ${total.toLocaleString()} 篇…`;
        const next=await app.call('library.list',{limit:10000,offset:rows.length});
        if(generation!==refreshGeneration)return;
        if(next.total!==total || (stamp!==undefined&&next.snapshotID!==stamp))throw new Error('读取期间目录发生变化，请重新读取；上一份列表仍保留');
        if(!Array.isArray(next.papers)||!next.papers.length||rows.length+next.papers.length>total)throw new Error('本机目录分页不完整，上一份列表仍保留');
        rows.push(...next.papers);
      }
      if(new Set(rows.map(paperID)).size!==rows.length)throw new Error('本机目录分页身份重复，请重新读取；上一份列表仍保留');
      if(generation!==refreshGeneration)return;
      if(app.state.personal===personalAtStart)app.state.personal=snapshot;app.state.summary=summary;app.state.catalog=rows;app.state.websiteTaxonomy=first.websiteTaxonomy||null;app.state.websiteTaxonomyNotice=first.websiteTaxonomyNotice||'';
      loaded = true;catalogNotice.hidden=true;
      const ids = new Set(catalog().map(paperID)); for (const id of selected) if (!ids.has(id)) selected.delete(id);
      for (const id of expandedMetadata) if (!ids.has(id)) expandedMetadata.delete(id);
      counts(); await render();
    })();
    loading=flight;
    try { return await flight; } catch (error) {if(generation===refreshGeneration){catalogNotice.hidden=false;catalogMessage.textContent=error.message||String(error);catalogRetry.hidden=false;fail(error);} } finally { if(loading===flight)loading = null; }
  }
  async function render() {
    counts();
    if (!views.has(app.state.view || 'library')) return;
    if (!loaded && !catalog().length) { if (!loading) await refresh(); return; }
    loaded = true;
    const sequence = ++renderSequence, view = app.state.view || 'library';
    $('library-view').classList.toggle('personal-list',view==='favorites'||view==='reading-list');$('library-view').classList.toggle('direction-list',view==='directions');
    let restoredScroll=null;
    if (lastView !== view) {
      const wrap=$('library-view').querySelector('.library-table-wrap');
      if(lastView)viewStates.set(lastView,{page,query:$('search-input').value,sort:$('sort').value,filters:{...filters},selected:[...selected],scroll:wrap.scrollTop,filterOpen:!filterBar.hidden,taxonomy:favoriteTools.snapshot()});
      const saved=viewStates.get(view);page=saved?.page??0;selected.clear();for(const id of saved?.selected||[])selected.add(id);
      for(const key of Object.keys(filters))filters[key]=saved?.filters[key]||'';
      for(const [id,key] of [['library-source','source'],['library-min-score','score'],['library-date-from','from'],['library-date-until','until']])$(id).value=filters[key];
      $('search-input').value=saved?.query||'';$('sort').value=saved?.sort||(view==='favorites'?'favorite-date':'date');
      favoriteTools.restore(saved?.taxonomy,view);lastView=view;filterBar.hidden=!(saved?.filterOpen??false);filterToggle.setAttribute('aria-expanded',String(!filterBar.hidden));restoredScroll=saved?.scroll??0;
    }
    filterToggle.hidden=false;filterToggle.textContent='筛选'+(Object.values(filters).filter(Boolean).length?' · '+Object.values(filters).filter(Boolean).length:'');filterToggle.title='来源、评分与网站日期';scope.hidden=view==='favorites';
    favoriteSort.hidden=view!=='favorites';
    $('library-selection-remove-favorite').hidden=view!=='favorites';
    const invalidDates=!!(filters.from&&filters.until&&filters.from>filters.until);filterMessage.hidden=!invalidDates;for(const id of ['library-date-from','library-date-until'])$(id).setAttribute('aria-invalid',String(invalidDates));
    const query = $('search-input').value.trim(), needle = fold(query), favorites = membership('favorites'), reading = membership('reading');
    let extraIDs = new Set();
    if (query) {
      const settled = await Promise.allSettled([app.call('library.search',{query}),app.call('personal.search',{query})]);
      if(sequence!==renderSequence||(app.state.view||'library')!==view)return;
      for (const [index,item] of settled.entries()) if (item.status === 'fulfilled') {
        const result=item.value,ids=index===0?(result?.cachedTextIDs||[]):(Array.isArray(result)?result:result?.ids||result?.paperIDs||[]);
        for(const id of ids)extraIDs.add(id);
      }
      const partial=settled.some(item=>item.status==='rejected');scope.classList.toggle('has-search-error',partial);
      if (partial) scope.textContent = '部分本机全文或笔记索引暂不可读，当前仍搜索论文元数据；PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
      else scope.textContent = '已同时搜索论文元数据、本机缓存导读与自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';
      if(partial){scope.hidden=false;scope.setAttribute('role','status');const retry=document.createElement('button');retry.id='library-query-retry';retry.type='button';retry.textContent='重试本机检索';retry.onclick=()=>render().catch(fail);scope.append(retry);}else scope.removeAttribute('role');
    } else {scope.classList.remove('has-search-error');scope.removeAttribute('role');scope.textContent = '搜索标题、作者、编号与标签；同时匹配已缓存导读和自己的笔记。PDF 原文请在阅读器中查找，不在此处的全文检索范围内。';}
    if (sequence !== renderSequence) return;
    const today = published().filter(p=>!p.localRetained&&p.sourceKind!=='conference').map(p=>p.date||'').sort().at(-1)||new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
    const scoped=catalog().filter(p=>{
      const id=paperID(p);
      if(view==='favorites')return favorites.has(id);
      if(view==='reading-list')return reading.has(id);
      if(view==='today')return !p.localRetained&&p.date===today&&p.sourceKind!=='conference';
      if(view==='conference')return p.sourceKind==='conference';
      return true;
    });
    favoriteTools.prepare(scoped,{query,filters,extraIDs});favoriteTools.render(view);
    const papers=scoped.filter(p=>favoriteTools.matches(paperID(p)));
    matchingIDs=new Set(papers.map(paperID));
    const sort = $('sort').value;
    papers.sort((a,b)=>sort==='favorite-date'?(favoriteDate(personal(),paperID(b))?.getTime()??-Infinity)-(favoriteDate(personal(),paperID(a))?.getTime()??-Infinity)||paperID(a).localeCompare(paperID(b)):sort==='score'?(b.score??-Infinity)-(a.score??-Infinity)||a.id.localeCompare(b.id):sort==='title'?(a.titleZh||a.title).localeCompare(b.titleZh||b.title,'zh-CN')||a.id.localeCompare(b.id):(b.date||'').localeCompare(a.date||'')||a.id.localeCompare(b.id));
    const pageCount = Math.max(1,Math.ceil(papers.length/pageSize)); page = Math.min(page,pageCount-1);
    const visible = papers.slice(page*pageSize,(page+1)*pageSize);
    $('library-title').textContent = {library:'全部论文',directions:'研究方向',today:'日更速递',conference:'会议论文集',favorites:'已收藏','reading-list':'待读'}[view];
    const personalTotal=view==='favorites'?favorites.size:view==='reading-list'?reading.size:null;
    const personalNoun=view==='favorites'?'篇收藏':'篇待读';
    $('library-subtitle').textContent = view==='directions'?`${(app.state.summary?.paperCount??catalog().length).toLocaleString()} 篇论文 · 按网站研究方向浏览`:personalTotal!==null?`${personalTotal.toLocaleString()} ${personalNoun}${papers.length!==personalTotal?' · 当前筛选 '+papers.length.toLocaleString()+' 篇':''}${view==='favorites'&&!favoriteTools.readOnly?' · '+[...favorites].filter(id=>!favoriteDate(personal(),id)).length.toLocaleString()+' 篇收藏时间未知':''}`:`${(app.state.summary?.paperCount??catalog().length).toLocaleString()} 篇当前网站目录${catalog().some(p=>p.localRetained)?' · '+catalog().filter(p=>p.localRetained).length.toLocaleString()+' 篇本机保留':''} · ${app.state.summary?.recordCount?.toLocaleString() || '—'} 条网站页面记录`;
    let previousSection=null;
    const tableFocus=document.activeElement,focusedPaper=$('paper-rows').contains(tableFocus)&&tableFocus.matches('[data-library-select]')?tableFocus.dataset.librarySelect:null;
    $('paper-rows').innerHTML = visible.map(p=>{
      const id=paperID(p), author=(p.authors||[]).slice(0,2).join('、'), score=Number.isFinite(p.score)?p.score.toFixed(1):'—';
      const state = [p.localRetained?(p.sourceKind==='local'?'本地 PDF':app.state.summary?.syncedAt?'本机保留 · 未在最新目录':'本机保留'):'',favorites.has(id)?'已收藏':'',reading.has(id)?'待读':'',app.state.paper && paperID(app.state.paper)===id?'正在阅读':''].filter(Boolean).join(' · ') || '未标记';
      const savedAt=view==='favorites'?favoriteDate(personal(),id):null;
      const section=view==='favorites'&&sort==='favorite-date'?favoriteSection(savedAt,favoriteTools.grouping):null;
      const sectionHTML=section&&section!==previousSection?`<tr class="favorite-section"><th colspan="6">${escape(section)}</th></tr>`:'';previousSection=section;
      const guideInfo=favoriteTools.guides(p),otherGuideMatch=!!p.blogURL&&guideInfo.some(info=>info.matched)&&!guideInfo.some(info=>{try{return info.matched&&new URL(info.row.permalink,p.blogURL).href===p.blogURL;}catch{return false;}});
      const directionMeta=view==='directions'?`<div class="website-row-classification">${escape(favoriteTools.summary(p))}</div>`:'';
      const favoriteMeta=view==='favorites'?`<span class="favorite-row-meta">收藏时间：${savedAt?escape(savedAt.toLocaleString()):'未知（旧版未记录）'} · ${escape(favoriteTools.summary(p))}</span>`:'';
      return sectionHTML+`<tr data-library-row="${escape(id)}" class="${selected.has(id)?'is-selected':''}"><td><input class="library-check" type="checkbox" data-library-select="${escape(id)}" aria-label="选择 ${escape(p.titleZh||p.title)}" ${selected.has(id)?'checked':''}></td><td><button class="paper-title-button" data-library-open="${escape(id)}"><span class="paper-row-title">${escape(p.titleZh||p.title)}</span><span class="paper-row-meta">${escape(id.replace(/^arxiv:/,''))} · ${escape(author)}${(p.authors||[]).length>2?' 等':''}</span></button>${otherGuideMatch?'<span class="library-guide-match">筛选命中其他导读 · 主行显示默认导读</span>':''}${query&&extraIDs.has(id)?'<span class="library-local-match">本机正文或笔记匹配</span>':''}${favoriteMeta}${directionMeta}${paperDetails(p, expandedMetadata.has(id),guideInfo)}</td><td>${escape(p.task||'未分类')}</td><td class="library-published-date">${escape(p.date||'未知')}</td><td class="numeric">${score}</td><td>${escape(state)}</td></tr>`;
    }).join('');
    if(focusedPaper&&document.hasFocus()){const target=[...$('paper-rows').querySelectorAll('[data-library-select]')].find(node=>node.dataset.librarySelect===focusedPaper);if(target&&!target.disabled)target.focus({preventScroll:true});}
    $('library-empty').hidden = papers.length>0;
    $('result-count').textContent = `${papers.length.toLocaleString()} 篇匹配 / ${(personalTotal??catalog().length).toLocaleString()} ${personalTotal!==null?personalNoun:'篇论文'}${papers.length?' · '+(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,papers.length):''}`;
    $('library-page-label').textContent = `${page+1} / ${pageCount}`;
    $('library-previous').disabled = page===0; $('library-next').disabled = page>=pageCount-1;
    $('library-select-page').checked = visible.length>0 && visible.every(p=>selected.has(paperID(p)));
    $('library-select-page').indeterminate = visible.some(p=>selected.has(paperID(p))) && !$('library-select-page').checked;
    $('library-select-page').onchange = event => { visible.forEach(p=>event.target.checked?selected.add(paperID(p)):selected.delete(paperID(p))); render().catch(fail); };
    updateSelection();if(restoredScroll!==null)$('library-view').querySelector('.library-table-wrap').scrollTop=restoredScroll;
  }
  function closePopup() { popup?.remove(); popup=null; }
  function openContext(event, paper) {
    event.preventDefault(); closePopup();
    const id=paperID(paper); if(!selected.has(id)){selected.clear();selected.add(id);render().catch(fail);}
    popup=document.createElement('div');popup.className='library-context';popup.setAttribute('role','menu');
    const favorite=membership('favorites').has(id),reading=membership('reading').has(id);
    const actions=[['打开导读',()=>app.openPaper(paper,{resume:true})], [favorite?'取消收藏':'收藏论文',()=>persistedList('favorites',[id],favorite)], [reading?'移出待读':'加入待读',()=>persistedList('reading',[id],reading)], ...(paper.blogURL?[['在浏览器打开网站',()=>app.call('app.external',{url:paper.blogURL})]]:[])];
    for(const [label,action] of actions){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{closePopup();Promise.resolve().then(action).catch(fail);};popup.append(button);}
    document.body.append(popup);popup.style.left=`${Math.max(8,Math.min(event.clientX,innerWidth-popup.offsetWidth-8))}px`;popup.style.top=`${Math.max(8,Math.min(event.clientY,innerHeight-popup.offsetHeight-8))}px`;popup.querySelector('button').focus();
  }
  $('paper-rows').addEventListener('toggle',event=>{const detail=event.target;if(!detail.isConnected||!detail.matches('details.library-paper-details'))return;const id=detail.closest('[data-library-row]')?.dataset.libraryRow;if(id)detail.open?expandedMetadata.add(id):expandedMetadata.delete(id);},true);
  $('paper-rows').onclick=event=>{const guide=event.target.closest('[data-library-guide]');if(guide){app.call('app.external',{url:guide.dataset.libraryGuide}).catch(fail);return;}const check=event.target.closest('[data-library-select]');if(check){check.checked?selected.add(check.dataset.librarySelect):selected.delete(check.dataset.librarySelect);render().catch(fail);return;}const button=event.target.closest('[data-library-open]');if(button){const paper=catalog().find(p=>paperID(p)===button.dataset.libraryOpen);if(paper)Promise.resolve(app.openPaper(paper,{resume:true})).catch(fail);}};
  $('paper-rows').addEventListener('contextmenu',event=>{const row=event.target.closest('[data-library-row]');if(!row)return;const paper=catalog().find(p=>paperID(p)===row.dataset.libraryRow);if(paper)openContext(event,paper);});
  $('search-input').oninput=()=>{page=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>render().catch(fail),220);};
  $('sort').onchange=()=>{page=0;render().catch(fail);};
  for(const [id,key] of [['library-source','source'],['library-min-score','score'],['library-date-from','from'],['library-date-until','until']]) $(id).onchange=event=>{filters[key]=event.target.value;page=0;render().catch(fail);};
  $('library-clear-filters').onclick=()=>{for(const key of Object.keys(filters))filters[key]='';for(const el of filterBar.querySelectorAll('select,input'))el.value='';$('search-input').value='';page=0;render().catch(fail);};
  $('reset-search').onclick=()=>{$('search-input').value='';page=0;render().catch(fail);};
  $('library-previous').onclick=()=>{page=Math.max(0,page-1);render().catch(fail);$('library-view').querySelector('.library-table-wrap').scrollTop=0;};
  $('library-next').onclick=()=>{page++;render().catch(fail);$('library-view').querySelector('.library-table-wrap').scrollTop=0;};
  $('library-selection-favorite').onclick=()=>persistedList('favorites',[...selected]);
  $('library-selection-remove-favorite').onclick=()=>persistedList('favorites',[...selected],true);
  $('library-selection-reading').onclick=()=>persistedList('reading',[...selected]);
  $('library-selection-clear').onclick=()=>{selected.clear();render().catch(fail);};
  document.addEventListener('pointerdown',event=>{if(popup&&!popup.contains(event.target))closePopup();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closePopup();if(popup&&['ArrowDown','ArrowUp'].includes(event.key)){const buttons=[...popup.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}});
  window.addEventListener('blur',closePopup);
  function invalidate(){refreshGeneration++;loading=null;renderSequence++;catalogNotice.hidden=true;}
  window.addEventListener('library.willChange',invalidate);
  window.addEventListener('personal.changed',()=>{invalidate();viewStates.clear();selected.clear();page=0;lastView=null;});
  if(catalog().length){loaded=true;}
  return {render,refresh,invalidate};
}
