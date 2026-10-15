'use strict';
const ROOT=require('node:path').resolve(__dirname,'..');
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Config=require(ROOT+'/scripts/config'),daily=require(ROOT+'/scripts/lib/daily-fresh-source-plan'),fresh=require(ROOT+'/scripts/lib/fresh-analysis-context'),deep=require(ROOT+'/scripts/deep-analyzer'),engine=require(ROOT+'/scripts/analysis-engine');
const span=require(ROOT+'/scripts/lib/reader-dom-span-projection'),order=require(ROOT+'/scripts/lib/reader-draft-order'),repair=require(ROOT+'/scripts/lib/reader-repair');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-html-span-')),previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(root,{recursive:true,force:true});});
 const base=structuredClone(require('./fixtures/reader-merged-caption-unit-cases.json').base);
 base.table={header:['Method','Speech Spearman','Speech Pair Acc (%)','Ambient Spearman','Ambient Pair Acc (%)'],rows:[['Alpha','1.0','51.8','2.0','55.9'],['Beta','3.0','85.1','4.0','85.9']]};
 const table=structuredClone(base.tables[0]), caption=base.quotes[0], text=caption+'\n'+table.matrix.map(row=>row.join('\n')).join('\n')+'\n'+('The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100).trim()),s=require(ROOT+'/tests/reader-signed-draft-fixture').fixture({noFigures:true,sourceText:text});
 const {payloadSha256,...body}=s.sourceDetails.structuredArtifacts;const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;const artifactBody=sort({...body,tables:[table],formulas:[]}),artifacts={...artifactBody,payloadSha256:repair.shaText(JSON.stringify(artifactBody))};
 const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-11',batchId:'generic-span',papers:[{arxivId:s.paper.arxivId,title:'Generic merged HTML row'}]});
 await daily.captureDailyFreshSources(plan,{concurrency:1,capture:args=>require(ROOT+'/scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args,{fetchText:async id=>({text,structuredArtifacts:artifacts,source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-11T00:00:00.000Z',imageInfos:[],warnings:[]}),fetchPdf:async id=>({bytes:Buffer.from('%PDF-1.7\n%%EOF\n'),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-11T00:00:01.000Z'})})});
 const source=daily.readDailyFreshSource(plan,s.paper);const draft=s.draft;draft.formulaBindings=[];draft.sections[4].body=draft.sections[4].body.replace(/\s*\[\[FORMULA_1\]\]/g,'');draft.sections[7].body=draft.sections[7].body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/,'[[TABLE_2]]');draft.sections[7].body=draft.sections[7].body.replace('[[TABLE_2]]',[base.table.header,base.table.header.map(()=> '---'),...base.table.rows].map(row=>'| '+row.join(' | ')+' |').join('\n'));draft.tableBindings[1]={tableIndex:2,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:[text.slice(0,text.indexOf('The source reports')).trim()]};
 daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(s.paper,s.paper.analysisManifest,source));
 const prepared=order.normalizeReaderDraftOrder(draft,{structuredArtifacts:artifacts}).draft;let parsed;
 await daily.withDailyFreshAnalysisContext(plan,()=>daily.withDailyFreshPaperSource(plan,s.paper,()=>fresh.withFreshPaperContext(s.paper,()=>require(ROOT+'/scripts/lib/reader-sealed-pdf-quote-evidence').withArtifacts(artifacts,s.paper.arxivId,()=>{parsed=deep.parseApiReaderArticleResult(JSON.stringify(prepared),{requiredVersion:3,requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,sourceText:text,structuredArtifacts:artifacts,availableFigureOrdinals:[]});}))));
 const paper=s.paper;Object.assign(paper,{apiReaderArticle:parsed.article,apiReaderPlan:parsed.plan});daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source));
 paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256=artifacts.payloadSha256;const stage=paper.analysisManifest.stages.apiReaderArticle;Object.assign(stage,{formulaBindingCount:0,structuredArtifactsSha256:artifacts.payloadSha256,qualityMetrics:parsed.qualityMetrics,sourceBindingsSha256:parsed.plan.sourceBindingsSha256,articleSha256:repair.shaText(parsed.article),planSha256:daily.stableHash(parsed.plan)});paper.apiReaderArticleSha256=stage.articleSha256;paper.apiReaderPlanSha256=stage.planSha256;
 return{paper,source,plan,table,artifacts,root,prepared};
}
test('merged literal DOM units survive cold qualification and actual Python source replay',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.paper),api=require(ROOT+'/scripts/lib/reader-source-table-column-units');
 assert.equal(engine.hasValidApiReaderV3Records(f.paper),true);assert.equal(JSON.stringify(f.paper),before);
 const rendered=require(ROOT+'/scripts/analysis-contract').extractMarkdownTables(f.paper.apiReaderArticle)[1],binding=f.paper.apiReaderPlan.tableBindings[1];
 assert.equal(deep.readerTableHeaderUnitEvidenceFailures(rendered,binding.sourceQuotes).length,4);
 api.withSavedPaper(f.paper,()=>assert.equal(deep.readerTableHeaderUnitEvidenceFailures(rendered,binding.sourceQuotes).length,0));
 const script=`import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\ns=importlib.util.spec_from_file_location('merged_publish','scripts/publish-to-blog.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)\nd=json.load(sys.stdin);p.DAILY_FRESH_SOURCE_RUNS_DIR=Path(d['root'])\nprint(json.dumps(sorted(p._reader_dom_column_unit_coverage(d['paper'],d['rendered'],d['binding']))))`;
 const replay=(paper,selected=rendered,bound=binding)=>JSON.parse(require('node:child_process').execFileSync('bash',[ROOT+'/scripts/python-runtime.sh','-B','-c',script],{cwd:ROOT,input:JSON.stringify({root:Config.FILES.dailyFreshSourceRunsDir,paper,rendered:selected,binding:bound}),encoding:'utf8'}));
 assert.equal(replay(f.paper).length,4);
 const bad=structuredClone(binding);bad.sourceQuotes[0].quote='Table 1: Invented caption and Pair Acc., %';bad.sourceQuotes[0].sourceQuoteSha256=repair.shaText(bad.sourceQuotes[0].quote);assert.deepEqual(replay(f.paper,rendered,bad),[]);
 const changed=structuredClone(rendered);changed.rows[0][2]='55.9';assert.equal(replay(f.paper,changed).length,3);
 const sourceFile=path.join(f.plan.sourcesDir,f.paper.arxivId,'generation-000001/source-runtime.json'),bytes=fs.readFileSync(sourceFile);fs.appendFileSync(sourceFile,' ');
 assert.equal(engine.hasValidApiReaderV3Records(f.paper),false);assert.throws(()=>replay(f.paper),/SHA|匹配|来源|规范化 JSON/);
 fs.writeFileSync(sourceFile,bytes);assert.equal(engine.hasValidApiReaderV3Records(f.paper),true);
});
