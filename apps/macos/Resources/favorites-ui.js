import './website-tags/website-tag-core.js';
const tags=globalThis.ResearchTags;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const publishedScore=value=>{if(typeof value!=='number'&&typeof value!=='string')return null;if(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))return null;const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=10?number:null;};
const fold=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase();
export function favoriteDate(personal,id){const metadata=personal.favoriteCollections,value=metadata?.version===1?metadata.items?.[id]?.addedAt:null,date=typeof value==='string'?new Date(value):null;return date&&Number.isFinite(date.getTime())?date:null;}
export function favoriteSection(date,grouping='relative',now=new Date()){
 if(!date)return '收藏时间未知';const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);if(date>=tomorrow)return '较晚日期（请检查设备时间）';if(grouping==='month')return `${date.getFullYear()} 年 ${date.getMonth()+1} 月`;const week=new Date(today);week.setDate(week.getDate()-6);return date>=today?'今天收藏':date>=week?'近 7 天收藏':'更早收藏';
}
const statusLabel=status=>({'withheld':'网站暂缓发布分类','legacy':'网站未提供结构化分类','unknown-version':'网站分类版本暂不可核验','unbound-version':'网站分类未绑定词表版本','invalid-roles':'网站分类角色暂不可核验','needs-sync':'旧目录缺少网页分类，请同步','unavailable':'网页分类词表暂不可核验'}[status]||'网站未提供可核验分类');
/** Official website classification only. Personal legacy folders are never read here. */
export function mountFavoriteTools(app,{before,onChange}){
 const root=document.createElement('section');root.className='favorite-tools';root.hidden=true;
 root.innerHTML='<div class="favorite-toolbar"><label>网页分类分面<select id="website-classification-facet"><option value="">全部分面</option></select></label><label>网页多级分类<select id="website-classification-node"><option value="">全部网页分类</option></select></label><label>收藏时间分区<select id="favorite-grouping"><option value="relative">今天 / 近 7 天 / 更早</option><option value="month">按月份</option></select></label><details id="favorite-time-help"><summary>分类与时间说明</summary><p>分类沿用网页已发布的概念与多级路径；上级仅用于导航，不能自行归类。收藏时间独立记录，旧记录未知。</p></details></div><p id="website-classification-status" role="status"></p>';
 before.before(root);const $=id=>root.querySelector('#'+id);let facet='',selected='',grouping='relative',assetRef,sourceRef,graph=null,groupsByPaper=new Map(),preparedGroups=[],matched=new Set(),eligibleIDs=new Set(),notice='';
 for(const [id,label]of Object.entries(tags.facetLabels))$('website-classification-facet').insertAdjacentHTML('beforeend',`<option value="${esc(id)}">${esc(label)}</option>`);
 function ensure(){
  const assets=app.state.websiteTaxonomy,catalog=app.state.catalog;
  if(assetRef===assets&&sourceRef===catalog)return;assetRef=assets;sourceRef=catalog;graph=null;groupsByPaper=new Map();
  try{if(!assets?.snapshot||!assets?.versions)throw Error('missing display assets');graph=tags.createRegistry(assets.snapshot,assets.versions);}
  catch{notice=app.state.websiteTaxonomyNotice||'网页分类尚未载入；同步网站目录后可查看。';return;}
  notice=app.state.websiteTaxonomyNotice||'';
  for(const paper of catalog||[]){const records=paper.websiteTagRecords;if(!Array.isArray(records))continue;try{groupsByPaper.set(paper.paperID||paper.id,tags.groupPapers(records,graph));}catch{groupsByPaper.set(paper.paperID||paper.id,[]);}}
 }
 const selectedFilters=()=>({scope:'subtree',role:'any',facets:selected&&graph?.byId[selected]?{[graph.byId[selected].facet]:[selected]}:{}});
 function prepare(papers,{query='',filters={},extraIDs=new Set()}={}){
  ensure();preparedGroups=[];matched=new Set();eligibleIDs=new Set();const needle=fold(query);
  const eligibleRow=row=>{if(filters.task&&row.task!==filters.task||filters.method&&row.method!==filters.method||filters.source&&row.sourceKind!==filters.source)return false;if(filters.score&&(publishedScore(row.score)===null||publishedScore(row.score)<Number(filters.score)))return false;if(filters.from&&row.date<filters.from||filters.until&&row.date>filters.until)return false;return !needle||extraIDs.has(row._nativeID)||fold([row.id,row.title,row.titleZh,row.summary,row.arxivId,row.paperId,row.task,row.method,...(row.tags||[]),...(row.authors||row.citation?.authors||[])].join(' ')).includes(needle);};
  for(const paper of papers){const id=paper.paperID||paper.id;
   const records=paper.websiteTagRecords;if((Array.isArray(records)?records:[paper]).some(row=>eligibleRow({...row,_nativeID:id})))eligibleIDs.add(id);
   if(!graph)continue;
   for(const group of groupsByPaper.get(id)||[]){const eligible=[];for(let i=0;i<group.articles.length;i++){
    const row=group.articles[i];if(!eligibleRow({...row,_nativeID:id}))continue;
    eligible.push(group.classifications[i]);
   }
   if(eligible.length)preparedGroups.push({...group,key:id,_paperID:id,classifications:eligible});
   }
  }
  // One native paper can have several unverified page groups; count it once.
  const byID=new Map();for(const g of preparedGroups){const old=byID.get(g._paperID);if(old)old.classifications.push(...g.classifications);else byID.set(g._paperID,{...g,classifications:[...g.classifications]});}preparedGroups=[...byID.values()];
  if(!graph){selected='';return;}
  if(selected&&!graph.byId[selected])selected='';
  for(const group of tags.query(preparedGroups,selectedFilters(),graph))matched.add(group._paperID);
 }
 function render(view){root.hidden=view!=='favorites';if(root.hidden)return;ensure();const select=$('website-classification-node'),count=graph?tags.counts(preparedGroups,graph,{scope:'subtree'}):null,counts=new Map((count?.concepts||[]).map(c=>[c.id,c.subtree]));
  let html='<option value="">全部网页分类</option>';
  if(graph)for(const [kind,label]of Object.entries(tags.facetLabels)){if(facet&&facet!==kind)continue;const nodes=Object.values(graph.byId).filter(n=>n.facet===kind&&tags.isActive(n)&&((counts.get(n.id)||0)>0||n.id===selected)).sort((a,b)=>graph.path(a.id).map(n=>n.zh).join(' › ').localeCompare(graph.path(b.id).map(n=>n.zh).join(' › '),'zh-CN'));if(nodes.length)html+=`<optgroup label="${esc(label)}">`+nodes.map(n=>`<option value="${esc(n.id)}">${esc(graph.path(n.id).map(p=>p.zh).join(' › '))}（${counts.get(n.id)} 篇）</option>`).join('')+'</optgroup>';}
  select.innerHTML=html;select.value=selected;if(select.value!==selected){selected='';select.value='';}select.disabled=!graph||(!selected&&![...counts.values()].some(value=>value>0));
  const metadata=app.state.personal?.favoriteCollections,upgrade=metadata!=null&&metadata.version!==1?'收藏资料来自更新版本，请升级工作台后编辑收藏；网页分类仍可浏览。':'';$('website-classification-status').textContent=[upgrade,notice||'网页官方分类 · 包含子类 · 同篇论文只计一次'].filter(Boolean).join(' ');$('favorite-grouping').value=grouping;
 }
 function paths(paper){ensure();if(!Array.isArray(paper.websiteTagRecords))return {status:'needs-sync',paths:[]};if(!graph)return {status:'unavailable',paths:[]};const all=[];for(const group of groupsByPaper.get(paper.paperID||paper.id)||[])for(const c of group.classifications){if(c.status!=='verified')continue;for(const id of c.conceptIds){const path=graph.path(id);if(path.length&&!all.some(p=>p.id===id))all.push({id,facet:graph.byId[id].facet,label:graph.byId[id].zh,path:path.map(n=>({id:n.id,label:n.zh}))});}}
  const statuses=(groupsByPaper.get(paper.paperID||paper.id)||[]).flatMap(g=>g.classifications.map(c=>c.status));return {status:all.length?'verified':statuses.includes('withheld')?'withheld':statuses[0]||'legacy',paths:all};
 }
 $('website-classification-facet').onchange=()=>{facet=$('website-classification-facet').value;selected='';onChange({resetPage:true});};
 $('website-classification-node').onchange=()=>{selected=$('website-classification-node').value;onChange({resetPage:true});};
 $('favorite-grouping').onchange=()=>{grouping=$('favorite-grouping').value;onChange({resetPage:true});};
 window.addEventListener('personal.changed',()=>{facet='';selected='';});
 return {prepare,render,matches:id=>selected?matched.has(id):eligibleIDs.has(id),get grouping(){return grouping;},get readOnly(){const m=app.state.personal?.favoriteCollections;return m!=null&&m.version!==1;},paths,summary(paper){const value=paths(paper);return value.paths.length?value.paths.map(p=>`${tags.facetLabels[p.facet]}：${p.path.map(n=>n.label).join(' › ')}`).join('；'):statusLabel(value.status);},close(){}};
}
