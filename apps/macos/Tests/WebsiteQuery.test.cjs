'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const fixture=require('../../../tests/fixtures/workbench-website-query-golden.json');
globalThis.ResearchTags=require('../Resources/website-tags/website-tag-core.js');
// Explicit Node-only dependency URL adapter; browser integration loads unchanged modules.
const source=require('node:fs').readFileSync(path.join(__dirname,'../Resources/website-browser.js'),'utf8').replace("'./website-tags/website-tag-core.js'",JSON.stringify(require('node:url').pathToFileURL(path.join(__dirname,'../Resources/website-tags/website-tag-core.js')).href));
const moduleReady=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function filters(value){return {facets:{},scope:'subtree',role:'any',researchType:'all',domainScope:'all',...value};}
for(const item of fixture.cases)test('Mac website display index: '+item.name,async()=>{
 const {createWebsiteIndex}=await moduleReady,tags=globalThis.ResearchTags,graph=tags.createRegistry(fixture.display.snapshot,fixture.display.versions),raw=item.recordKeys.map(key=>fixture.records[key]),groups=tags.groupPapers(raw,graph);
 const papers=groups.map(group=>({id:group.key,websiteTagRecords:group.articles})),app={state:{catalog:papers,websiteTaxonomy:fixture.display}},index=createWebsiteIndex(app);index.prepare(papers);
 if(item.expected.error){assert.throws(()=>tags.query(groups,item.filters,graph));let result;try{result=index.matching(item.filters);}catch(error){assert.ok(error instanceof Error);return;}assert.equal(result.size,0,'invalid query cannot produce a matching paper');return;}
 assert.deepEqual([...index.matching(item.filters)],item.expected.groupKeys);
 const counts=index.counts(item.filters);for(const node of item.expected.browseCounts.concepts)assert.equal(counts.get(node.id),item.filters.scope==='direct'?node.direct:node.subtree,node.id);
});
test('Mac date range cannot borrow an undated guide classification or a representative date',async()=>{
 const {createWebsiteIndex}=await moduleReady,raw=fixture.records.music,taskOnly={...raw,permalink:'/qa-undated/',date:null,tagConcepts:raw.tagConcepts.filter(n=>n.facet==='task'),primaryMethodId:''},methodOnly={...raw,permalink:'/qa-dated/',date:'2026-10-30',tagConcepts:raw.tagConcepts.filter(n=>n.facet==='method'),primaryTaskId:''},paper={id:'arxiv:'+raw.arxivId,date:'2026-10-30',websiteTagRecords:[taskOnly,methodOnly]},index=createWebsiteIndex({state:{catalog:[paper],websiteTaxonomy:fixture.display}}),selection=filters({facets:{task:['task.music-mixing']}});
 index.prepare([paper]);assert.equal(index.matching(selection).size,1);
 index.prepare([paper],{filters:{from:'2026-10-01',until:'2026-10-31'}});assert.equal(index.matching(selection).size,0);
 for(const date of [undefined,'','2026-02-30','0000-01-01']){paper.websiteTagRecords=[{...taskOnly,date}];const next=createWebsiteIndex({state:{catalog:[paper],websiteTaxonomy:fixture.display}});next.prepare([paper],{filters:{from:'2026-01-01'}});assert.equal(next.matching(selection).size,0,String(date));}
});
test('Mac taxonomy graph rebuilds only when catalog or paired asset identity changes',async()=>{
 const {createWebsiteIndex}=await moduleReady,paper={id:'qa:music',websiteTagRecords:[fixture.records.music]},app={state:{catalog:[paper],websiteTaxonomy:fixture.display}},index=createWebsiteIndex(app);index.prepare([paper]);const graph=index.graph,revision=index.revision;
 for(let i=0;i<4;i++){index.prepare([paper],{query:i?'music':''});index.counts(filters({}));assert.equal(index.graph,graph);assert.equal(index.revision,revision);}
 app.state.catalog=[paper];index.prepare([paper]);assert.notEqual(index.graph,graph);assert.equal(index.revision,revision+1);
});

test('Mac canonical identity and original guide title remain searchable without borrowing metadata',async()=>{
 const {createWebsiteIndex}=await moduleReady,raw={...fixture.records.music,originalTitle:'OriginalOnlyNeedle'},id='arxiv:'+raw.arxivId,paper={id,websiteTagRecords:[raw]},index=createWebsiteIndex({state:{catalog:[paper],websiteTaxonomy:fixture.display}});
 for(const query of [raw.arxivId,id,'OriginalOnlyNeedle']){index.prepare([paper],{query});assert.equal(index.matching(filters({facets:{task:['task.music-mixing']}})).size,1,query);}
});

for(const item of fixture.appIntegrationCases)test('Mac provider extension: '+item.name,async()=>{
 const {createWebsiteIndex}=await moduleReady,tags=globalThis.ResearchTags,graph=tags.createRegistry(fixture.display.snapshot,fixture.display.versions),groups=tags.groupPapers(item.recordKeys.map(key=>fixture.records[key]),graph),papers=groups.map(group=>({id:group.key,websiteTagRecords:group.articles})),index=createWebsiteIndex({state:{catalog:papers,websiteTaxonomy:fixture.display}}),extraIDs=new Set([...(item.nativeResults.library.cachedTextIDs||[]),...(item.nativeResults.personal.ids||[])]);
 index.prepare(papers,{query:item.query,filters:item.ordinaryFilters,extraIDs});assert.deepEqual([...index.matching(item.filters)],item.expected.groupKeys);
 const guides=papers.flatMap(paper=>{const matching=index.guides(paper).filter(guide=>guide.matched).map(guide=>guide.row.permalink);return matching.length?[{groupKey:paper.id,permalinks:matching}]:[];});assert.deepEqual(guides,item.expected.matchingGuides);
});
