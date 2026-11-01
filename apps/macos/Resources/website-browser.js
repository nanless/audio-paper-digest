import './website-tags/website-tag-core.js';
const tags = globalThis.ResearchTags;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fold = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const idOf = paper => paper.paperID || paper.id;
const statusLabel = status => ({withheld:'网站暂缓发布分类',legacy:'网站未提供结构化分类','unknown-version':'网站分类版本暂不可核验','unbound-version':'网站分类未绑定词表版本','invalid-roles':'网站分类角色暂不可核验','needs-sync':'旧目录缺少网页分类，请同步',unavailable:'网页分类词表暂不可核验'}[status] || '网站未提供可核验分类');
function websiteDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))return false;const time=Date.parse(value+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function score(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 10 ? number : null;
}

/** Display index only. The website resolver keeps each issued guide independent. */
export function createWebsiteIndex(app) {
  let assetRef, sourceRef, graph = null, groupsByPaper = new Map(), notice = '', revision=0;
  let groups = [], preparedByID=new Map(), eligibleIDs = new Set(), lastSelection={facets:{},scope:'subtree',role:'any'};
  function ensure() {
    const assets = app.state.websiteTaxonomy, papers = app.state.catalog;
    if (assetRef === assets && sourceRef === papers) return;
    assetRef = assets; sourceRef = papers; revision++; graph = null; groupsByPaper = new Map();
    try {
      if (!assets?.snapshot || !assets?.versions) throw Error('missing display assets');
      graph = tags.createRegistry(assets.snapshot, assets.versions);
    } catch { notice = app.state.websiteTaxonomyNotice || '网页分类尚未载入；同步网站目录后可查看。'; return; }
    notice = app.state.websiteTaxonomyNotice || '';
    for (const paper of papers || []) {
      if (!Array.isArray(paper.websiteTagRecords)) continue;
      try { groupsByPaper.set(idOf(paper), tags.groupPapers(paper.websiteTagRecords, graph)); }
      catch { groupsByPaper.set(idOf(paper), []); }
    }
  }
  function prepare(papers, {query = '', filters = {}, extraIDs = new Set()} = {}) {
    ensure(); const needle = fold(query); eligibleIDs = new Set(); const byID = new Map();
    const eligible = (row, id) => {
      if (filters.task && row.task !== filters.task || filters.method && row.method !== filters.method || filters.source && row.sourceKind !== filters.source) return false;
      const value = score(row.score);
      if (filters.score && (value === null || value < Number(filters.score))) return false;
      if ((filters.from||filters.until)&&!websiteDate(row.date))return false;
      if (filters.from && row.date < filters.from || filters.until && row.date > filters.until) return false;
      return !needle || extraIDs.has(id) || fold([id,row.id,row.title,row.titleZh,row.originalTitle,row.summary,row.arxivId,row.paperId,row.task,row.method,...(row.tags || []),...(row.authors || row.citation?.authors || [])].join(' ')).includes(needle);
    };
    for (const paper of papers) {
      const id = idOf(paper), records = paper.websiteTagRecords;
      if ((Array.isArray(records) ? records : [paper]).some(row => eligible(row, id))) eligibleIDs.add(id);
      if (!graph) continue;
      for (const group of groupsByPaper.get(id) || []) {
        const indices=group.articles.map((row,i)=>eligible(row,id)?i:-1).filter(i=>i>=0),classifications=indices.map(i=>group.classifications[i]),articles=indices.map(i=>group.articles[i]);
        if (!classifications.length) continue;
        const previous = byID.get(id);
        if (previous){previous.classifications.push(...classifications);previous.articles.push(...articles);}
        else byID.set(id, {...group, key:id, _paperID:id, classifications, articles});
      }
    }
    groups = [...byID.values()];preparedByID=byID;
  }
  function selectionValid(selection) {
    return graph && Object.entries(selection.facets || {}).every(([facet, ids]) => ids.every(id => graph.byId[id]?.facet === facet && tags.isActive(graph.byId[id])));
  }
  function matching(selection) {
    lastSelection=selection;
    if(graph){if(!selectionValid(selection))return new Set();tags.query([],selection,graph);}
    const selected = Object.values(selection.facets || {}).some(ids => ids.length) || (selection.researchType||'all')!=='all' || (selection.domainScope||'all')!=='all';
    if (!selected) return new Set(eligibleIDs);
    if (!selectionValid(selection)) return new Set();
    return new Set(tags.query(groups, selection, graph).map(group => group._paperID));
  }
  function counts(selection) {
    if (!graph) return new Map();
    // Counts describe the ordinary search/range, not only the selected branch.
    const result = tags.counts(groups, graph, {scope:selection.scope, role:selection.role, researchType:selection.researchType, domainScope:selection.domainScope});
    return new Map(result.concepts.map(node => [node.id, selection.scope === 'direct' ? node.direct : node.subtree]));
  }
  function paths(paper) {
    ensure();
    if (!Array.isArray(paper.websiteTagRecords)) return {status:'needs-sync', paths:[]};
    if (!graph) return {status:'unavailable', paths:[]};
    const values = [], classifications = (groupsByPaper.get(idOf(paper)) || []).flatMap(group => group.classifications);
    for (const classification of classifications) if (classification.status === 'verified') for (const id of classification.conceptIds) {
      if (values.some(value => value.id === id)) continue;
      const path = graph.path(id); if (path.length) values.push({id, facet:graph.byId[id].facet, path:path.map(node => ({id:node.id,label:node.zh}))});
    }
    return {status:values.length ? 'verified' : classifications.some(value => value.status === 'withheld') ? 'withheld' : classifications[0]?.status || 'legacy', paths:values};
  }
  function guides(paper){
    ensure();const id=idOf(paper),prepared=preparedByID.get(id),hasSelection=Object.values(lastSelection.facets||{}).some(ids=>ids.length)||(lastSelection.researchType||'all')!=='all'||(lastSelection.domainScope||'all')!=='all',valid=selectionValid(lastSelection);
    return (groupsByPaper.get(id)||[]).flatMap(group=>group.articles.map((row,i)=>{const classification=group.classifications[i],eligible=prepared?.articles.some(value=>value.permalink===row.permalink),matched=!!eligible&&(!hasSelection||(valid&&tags.query([{...group,classifications:[classification]}],lastSelection,graph).length>0)),paths=classification.status==='verified'?classification.conceptIds.map(id=>graph.path(id).map(node=>node.zh).join(' › ')):[];
      return {row,matched,paths,status:classification.status};}));
  }
  return {ensure, prepare, matching, counts, paths, guides, get graph(){ensure();return graph;},get notice(){ensure();return notice;},get revision(){ensure();return revision;},summary(paper){const result=paths(paper),matched=new Set(guides(paper).filter(guide=>guide.matched).flatMap(guide=>guide.paths)),ordered=[...result.paths].sort((a,b)=>Number(matched.has(b.path.map(node=>node.label).join(' › ')))-Number(matched.has(a.path.map(node=>node.label).join(' › '))));if(!ordered.length)return statusLabel(result.status);const byFacet=new Map();for(const value of ordered.slice(0,2)){const values=byFacet.get(value.facet)||[];values.push(value.path.map(node=>node.label).join(' › '));byFacet.set(value.facet,values);}return [...byFacet].map(([facet,values])=>`${tags.facetLabels[facet]}：${values.join('、')}`).join('；')+(ordered.length>2?' · 另 '+(ordered.length-2)+' 个官网分类':'');}};
}

/** Complete read-only website directory, with separate expansion and selection. */
export function mountWebsiteBrowser(app, {panelHost, contextHost, onChange}) {
  const index = createWebsiteIndex(app);
  const panel = document.createElement('aside'); panel.className = 'classification-panel'; panel.setAttribute('aria-label','网站研究方向目录');
  panel.innerHTML = `<header class="classification-panel-heading"><div><strong>研究方向</strong><span id="classification-total"></span></div><button type="button" id="classification-close" aria-label="收起研究方向目录">×</button></header><label class="classification-search"><span>查找方向</span><input id="classification-search" type="search" placeholder="名称、别名或编号" autocomplete="off"></label><div class="classification-tree-actions"><button type="button" id="classification-expand">展开全部</button><button type="button" id="classification-collapse">收起全部</button></div><div id="classification-tree" class="classification-tree"></div><footer class="classification-rules"><details id="classification-advanced"><summary>高级分类筛选</summary><label>匹配范围<select id="classification-scope"><option value="subtree">包括子类</option><option value="direct">仅直接标签</option></select></label><label>标签角色<select id="classification-role"><option value="any">全部角色</option><option value="primary">主要角色</option></select></label><label>研究类型<select id="classification-researchType"><option value="all">全部类型</option></select></label><label>研究范围<select id="classification-domainScope"><option value="all">全部范围</option></select></label><p>同一分面可选多个方向；不同分面同时满足。条件须由同一篇导读满足。</p></details><p>目录包含全部层级与零篇方向。</p></footer>`;
  panelHost.prepend(panel);
  const context = document.createElement('section'); context.className = 'classification-context';
  context.innerHTML = `<div class="classification-context-heading"><button type="button" id="library-browse-classifications" aria-expanded="false">研究方向</button><nav id="classification-breadcrumb" aria-label="研究方向路径"></nav><button type="button" id="classification-reset-rules" hidden>恢复默认</button><label id="favorite-time-control">收藏时间<select id="favorite-grouping"><option value="relative">今天 / 近 7 天 / 更早</option><option value="month">按月份</option></select></label></div><div id="classification-chips" class="classification-chips"></div><details id="classification-description" hidden><summary></summary><div></div></details><p id="website-classification-status" role="status"></p>`;
  contextHost.after(context);
  const $ = id => panel.querySelector('#'+id) || context.querySelector('#'+id);
  let view = null, selection = {facets:{},scope:'subtree',role:'any',researchType:'all',domainScope:'all'}, expanded = new Set(), directoryQuery = '', currentNode = '', open = false, grouping = 'relative', matched = new Set(), counts = new Map(), treeSignature = '';
  for(const [key,labels]of [['researchType',tags.researchTypeLabels],['domainScope',tags.domainLabels]])for(const [value,label]of Object.entries(labels))$('classification-'+key).insertAdjacentHTML('beforeend',`<option value="${esc(value)}">${esc(label)}</option>`);
  for(const key of ['researchType','domainScope'])$('classification-'+key).insertAdjacentHTML('beforeend','<option value="unclassified">未标明</option>');
  function changed(resetPage=true) { treeSignature=''; return onChange({resetPage}); }
  function choose(id) {
    const node=index.graph?.byId[id]; if(!node || !tags.isActive(node))return;
    selection.facets = {[node.facet]:[id]}; currentNode=id;
    for(const ancestor of node.ancestorIds)expanded.add(ancestor);
    changed();
  }
  function toggle(id, checked) {
    const node=index.graph?.byId[id];if(!node || !tags.isActive(node))return;
    const ids=new Set(selection.facets[node.facet]||[]);checked?ids.add(id):ids.delete(id);
    selection.facets={...selection.facets,[node.facet]:[...ids]};if(checked)currentNode=id;else if(currentNode===id)currentNode=Object.values(selection.facets).flat().at(-1)||'';changed();
  }
  function renderTree() {
    const graph=index.graph, tree=$('classification-tree');
    if(!graph){tree.replaceChildren();$('classification-total').textContent='尚未载入';return;}
    const focused=document.activeElement,focusedRow=tree.contains(focused)?focused.closest('[data-directory-node]'):null,focusID=focusedRow?.dataset.directoryNode,focusKind=focused?.matches('input')?'input':focused?.matches('[data-classification-expand]')?'expand':'name';
    const nodes=Object.values(graph.byId),needle=fold(directoryQuery),visible=new Set();
    if(needle)for(const node of nodes)if(fold([node.id,node.zh,node.en,...(node.aliases||[]),node.definition,node.scopeNote].join(' ')).includes(needle)){visible.add(node.id);node.ancestorIds.forEach(id=>visible.add(id));}
    const children=new Map();for(const node of nodes){const parent=node.ancestorIds.at(-1)||node.facet;const list=children.get(parent)||[];list.push(node);children.set(parent,list);}
    const row=(node,depth)=>{
      if(needle&&!visible.has(node.id))return '';
      const descendants=children.get(node.id)||[],isExpanded=needle?true:expanded.has(node.id),selected=(selection.facets[node.facet]||[]).includes(node.id),active=tags.isActive(node);
      return `<div class="classification-branch"><div class="classification-node ${currentNode===node.id?'is-current':''}" style="--level:${depth}" data-directory-node="${esc(node.id)}">${descendants.length?`<button type="button" class="classification-disclosure" data-classification-expand="${esc(node.id)}" aria-expanded="${isExpanded}" aria-label="${isExpanded?'收起':'展开'}${esc(node.zh)}">${isExpanded?'⌄':'›'}</button>`:'<span class="classification-disclosure-placeholder"></span>'}<button type="button" class="classification-name" data-classification-choose="${esc(node.id)}" ${active?'':'disabled'} title="${esc(graph.path(node.id).map(value=>value.zh).join(' › '))}">${esc(node.zh)}</button><span class="classification-count">${counts.get(node.id)||0}</span><input type="checkbox" data-classification-check="${esc(node.id)}" aria-label="筛选${esc(node.zh)}" ${selected?'checked':''} ${active?'':'disabled'}></div>${isExpanded?descendants.map(child=>row(child,depth+1)).join(''):''}</div>`;
    };
    tree.innerHTML=Object.entries(tags.facetLabels).map(([facet,label])=>{const roots=children.get(facet)||[],body=roots.map(node=>row(node,0)).join('');return body?`<section class="classification-facet" aria-label="${esc(label)}"><h3>${esc(label)}</h3>${body}</section>`:'';}).join('')||'<p class="classification-no-match">没有匹配的方向，请换一个名称。</p>';
    if(focusID&&document.hasFocus()){const row=[...tree.querySelectorAll('[data-directory-node]')].find(node=>node.dataset.directoryNode===focusID),target=row?.querySelector(focusKind==='input'?'input':focusKind==='expand'?'[data-classification-expand]':'.classification-name');if(target&&!target.disabled)target.focus({preventScroll:true});}
    $('classification-total').textContent=`${nodes.length} 个方向 · ${new Set(nodes.map(node=>node.facet)).size} 个分面`;
  }
  function render(nextView) {
    view=nextView;const supported=['library','directions','favorites','reading-list','today','conference'].includes(view);
    context.hidden=!supported;panel.hidden=!supported||!open;
    panelHost.classList.toggle('has-classification-panel',!panel.hidden);
    $('library-browse-classifications').setAttribute('aria-expanded',String(!panel.hidden));
    $('favorite-time-control').hidden=view!=='favorites';$('favorite-grouping').value=grouping;
    const contextFocus=document.activeElement,contextOwner=context.contains(contextFocus)?{all:contextFocus.hasAttribute('data-classification-all'),id:contextFocus.id,choose:contextFocus.dataset.classificationChoose,remove:contextFocus.dataset.classificationRemove}:null;
    const graph=index.graph, selected=Object.values(selection.facets).flat();
    $('classification-breadcrumb').innerHTML=`<button type="button" data-classification-all>${{favorites:'全部收藏','reading-list':'全部待读',today:'当期论文',conference:'会议论文'}[view]||'全部论文'}</button>`+(currentNode&&graph?.byId[currentNode]?graph.path(currentNode).map(node=>`<span aria-hidden="true">›</span><button type="button" data-classification-choose="${esc(node.id)}" ${node.id===currentNode?'aria-current="location"':''}>${esc(node.zh)}</button>`).join(''):'');
    $('classification-chips').innerHTML=(selected.length>1?selected:[]).map(id=>`<button type="button" data-classification-remove="${esc(id)}" aria-label="移除${esc(graph?.byId[id]?.zh||id)}筛选">${esc(graph?.byId[id]?.zh||id)} <span aria-hidden="true">×</span></button>`).join('')+((selected.length>1||selection.researchType!=='all'||selection.domainScope!=='all')?'<button type="button" class="classification-clear" data-classification-all>清除分类筛选</button>':'');
    const description=$('classification-description'),node=graph?.byId[currentNode];description.hidden=!node;if(node){description.querySelector('summary').textContent=node.zh+' · 定义与范围';description.querySelector('div').innerHTML=`<p>${esc(node.en||'')} · ${esc(node.id)}</p><p>${esc(node.definition||'网站未提供定义。')}</p>${tags.readerScopeNote(node.scopeNote)?`<p>${esc(tags.readerScopeNote(node.scopeNote))}</p>`:''}`;}
    const metadata=app.state.personal?.favoriteCollections,upgrade=metadata!=null&&metadata.version!==1?'收藏资料来自更新版本，请升级工作台后编辑收藏；':'';
    const advancedActive=selection.scope!=='subtree'||selection.role!=='any'||selection.researchType!=='all'||selection.domainScope!=='all',rules=[selection.scope==='subtree'?'包括子类':'仅直接标签',selection.role==='primary'?'主要角色':'全部角色'];
    if(selection.researchType!=='all')rules.push(tags.researchTypeLabels[selection.researchType]||'研究类型未标明');if(selection.domainScope!=='all')rules.push(tags.domainLabels[selection.domainScope]||'研究范围未标明');
    $('website-classification-status').textContent=upgrade+(index.notice||`${selected.length?selected.length+' 个方向 · ':''}${rules.join(' · ')}`);
    $('website-classification-status').hidden=!upgrade&&!index.notice&&!advancedActive;$('classification-reset-rules').hidden=!advancedActive;
    for(const key of ['scope','role','researchType','domainScope'])$('classification-'+key).value=selection[key];
    if(contextOwner&&document.hasFocus()&&!contextFocus.isConnected){const target=contextOwner.all?context.querySelector('[data-classification-all]'):contextOwner.choose?[...context.querySelectorAll('[data-classification-choose]')].find(node=>node.dataset.classificationChoose===contextOwner.choose):contextOwner.remove?context.querySelector('[data-classification-all]'):null;target?.focus({preventScroll:true});}
    const signature=JSON.stringify([index.revision,directoryQuery,[...expanded],selection,[...counts]]);
    if(!panel.hidden&&signature!==treeSignature){const previousScroll=$('classification-tree').scrollTop;renderTree();$('classification-tree').scrollTop=previousScroll;treeSignature=signature;}
  }
  function prepare(papers, options) {index.prepare(papers,options);matched=index.matching(selection);counts=index.counts(selection);}
  for(const host of [panel,context])host.addEventListener('click',event=>{
    const expand=event.target.closest('[data-classification-expand]');if(expand){const id=expand.dataset.classificationExpand;expanded.has(id)?expanded.delete(id):expanded.add(id);treeSignature='';render(view);return;}
    const node=event.target.closest('[data-classification-choose]');if(node){choose(node.dataset.classificationChoose);return;}
    const remove=event.target.closest('[data-classification-remove]');if(remove){toggle(remove.dataset.classificationRemove,false);return;}
    if(event.target.closest('[data-classification-all]')){selection={facets:{},scope:'subtree',role:'any',researchType:'all',domainScope:'all'};currentNode='';changed();}
  });
  $('classification-tree').addEventListener('keydown',event=>{
    const row=event.target.closest('[data-directory-node]');if(!row||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const rows=[...$('classification-tree').querySelectorAll('[data-directory-node]')],position=rows.indexOf(row),id=row.dataset.directoryNode,node=index.graph?.byId[id];let destination=id;
    if(event.key==='ArrowUp')destination=rows[Math.max(0,position-1)]?.dataset.directoryNode;
    if(event.key==='ArrowDown')destination=rows[Math.min(rows.length-1,position+1)]?.dataset.directoryNode;
    if(event.key==='Home')destination=rows[0]?.dataset.directoryNode;
    if(event.key==='End')destination=rows.at(-1)?.dataset.directoryNode;
    if(event.key==='ArrowRight'){if(row.querySelector('[data-classification-expand]')&&!expanded.has(id)){expanded.add(id);treeSignature='';render(view);}else if(rows[position+1]&&index.graph?.byId[rows[position+1].dataset.directoryNode]?.ancestorIds.includes(id))destination=rows[position+1].dataset.directoryNode;}
    if(event.key==='ArrowLeft'){if(expanded.has(id)){expanded.delete(id);treeSignature='';render(view);}else destination=node?.ancestorIds.at(-1)||id;}
    event.preventDefault();const target=[...$('classification-tree').querySelectorAll('[data-directory-node]')].find(value=>value.dataset.directoryNode===destination)?.querySelector('.classification-name');target?.focus();
  });
  panel.addEventListener('change',event=>{const check=event.target.closest('[data-classification-check]');if(check)toggle(check.dataset.classificationCheck,check.checked);});
  $('classification-reset-rules').onclick=()=>{selection={facets:{},scope:'subtree',role:'any',researchType:'all',domainScope:'all'};currentNode='';changed();};
  $('classification-search').oninput=()=>{directoryQuery=$('classification-search').value;treeSignature='';render(view);};
  $('classification-expand').onclick=()=>{expanded=new Set(Object.keys(index.graph?.byId||{}));treeSignature='';render(view);};
  $('classification-collapse').onclick=()=>{expanded.clear();treeSignature='';render(view);};
  $('classification-close').onclick=()=>{open=false;render(view);$('library-browse-classifications').focus();};
  $('library-browse-classifications').onclick=()=>{open=!open;render(view);if(open)$('classification-search').focus();};
  for(const field of ['scope','role','researchType','domainScope'])$('classification-'+field).onchange=event=>{selection[field]=event.target.value;changed();};
  $('favorite-grouping').onchange=()=>{grouping=$('favorite-grouping').value;changed();};
  function snapshot(){return {selection:structuredClone(selection),expanded:[...expanded],directoryQuery,currentNode,open,grouping,directoryScroll:$('classification-tree').scrollTop,advancedOpen:$('classification-advanced').open,descriptionOpen:$('classification-description').open};}
  function restore(saved,nextView){selection=saved?.selection?structuredClone(saved.selection):{facets:{},scope:'subtree',role:'any',researchType:'all',domainScope:'all'};expanded=new Set(saved?.expanded||[]);directoryQuery=saved?.directoryQuery||'';currentNode=saved?.currentNode||'';open=saved?.open??nextView==='directions';grouping=saved?.grouping||'relative';$('classification-search').value=directoryQuery;$('classification-advanced').open=saved?.advancedOpen||false;$('classification-description').open=saved?.descriptionOpen||false;treeSignature='';render(nextView);$('classification-tree').scrollTop=saved?.directoryScroll||0;}
  return {prepare,render,matches:id=>matched.has(id),snapshot,restore,get grouping(){return grouping;},get readOnly(){const metadata=app.state.personal?.favoriteCollections;return metadata!=null&&metadata.version!==1;},summary:index.summary,paths:index.paths,guides:index.guides};
}
