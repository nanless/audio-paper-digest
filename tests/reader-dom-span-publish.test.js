'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context'),deep=require('../scripts/deep-analyzer'),engine=require('../scripts/analysis-engine');
const span=require('../scripts/lib/reader-dom-span-projection'),order=require('../scripts/lib/reader-draft-order'),repair=require('../scripts/lib/reader-repair');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-html-span-')),previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(root,{recursive:true,force:true});});
 const text='The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100).trim(),s=require('./reader-signed-draft-fixture').fixture({noFigures:true,sourceText:text});
 const matrix=[['Method','A','B','C','D','E'],Array(6).fill('Proprietary Models'),['Baseline','1.0','1.0','1.0','1.0','1.0']],table={ordinal:1,recoveryStatus:'complete',sourceDomSha256:'a'.repeat(64),headerRows:[0],bodyRows:[1,2],matrix,cells:[]};
 for(const [r,row]of matrix.entries())if(r===1)table.cells.push({row:r,column:0,text:row[0],rowspan:1,colspan:6,header:false,sourceDomSha256:'b'.repeat(64)});else for(const [c,value]of row.entries())table.cells.push({row:r,column:c,text:value,rowspan:1,colspan:1,header:r===0,sourceDomSha256:repair.shaText(`cell${r}:${c}`)});
 const {payloadSha256,...body}=s.sourceDetails.structuredArtifacts;const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;const artifactBody=sort({...body,tables:[table],formulas:[]}),artifacts={...artifactBody,payloadSha256:repair.shaText(JSON.stringify(artifactBody))};
 const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-11',batchId:'generic-span',papers:[{arxivId:s.paper.arxivId,title:'Generic merged HTML row'}]});
 await daily.captureDailyFreshSources(plan,{concurrency:1,capture:args=>require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args,{fetchText:async id=>({text,structuredArtifacts:artifacts,source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-11T00:00:00.000Z',imageInfos:[],warnings:[]}),fetchPdf:async id=>({bytes:Buffer.from('%PDF-1.7\n%%EOF\n'),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-11T00:00:01.000Z'})})});
 const source=daily.readDailyFreshSource(plan,s.paper);const draft=s.draft;draft.formulaBindings=[];draft.sections[4].body=draft.sections[4].body.replace(/\s*\[\[FORMULA_1\]\]/g,'');draft.sections[7].body=draft.sections[7].body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/,'[[TABLE_2]]');draft.tableBindings[1]={tableIndex:2,completeTable:{sourceTableOrdinal:1}};
 const prepared=order.normalizeReaderDraftOrder(draft,{structuredArtifacts:artifacts}).draft;const parsed=deep.parseApiReaderArticleResult(JSON.stringify(prepared),{requiredVersion:3,requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,sourceText:text,structuredArtifacts:artifacts,availableFigureOrdinals:[]});
 const paper=s.paper;Object.assign(paper,{apiReaderArticle:parsed.article,apiReaderPlan:parsed.plan});daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source));
 paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256=artifacts.payloadSha256;const stage=paper.analysisManifest.stages.apiReaderArticle;Object.assign(stage,{formulaBindingCount:0,structuredArtifactsSha256:artifacts.payloadSha256,qualityMetrics:parsed.qualityMetrics,sourceBindingsSha256:parsed.plan.sourceBindingsSha256,articleSha256:repair.shaText(parsed.article),planSha256:daily.stableHash(parsed.plan)});paper.apiReaderArticleSha256=stage.articleSha256;paper.apiReaderPlanSha256=stage.planSha256;
 return{paper,source,plan,table,artifacts,root,prepared};
}
const { execFileSync } = require('node:child_process');
function pythonPublisher(f, paper = f.paper) {
    const project = path.resolve(__dirname, '..');
    const code = `import sys,json
from pathlib import Path
sys.path.insert(0,'tests/python')
from test_publish_to_blog import publish_to_blog as publish
request=json.load(sys.stdin)
publish.DAILY_FRESH_SOURCE_RUNS_DIR=Path(request['runs'])
span_calls=[0]
original=publish._run_bounded_subprocess
def observe(args,*a,**kw):
 if any('reader-dom-span-replay-cli.js' in str(x) for x in args): span_calls[0]+=1
 return original(args,*a,**kw)
publish._run_bounded_subprocess=observe
try:
 publish._validate_api_reader_source_bindings(request['paper'])
 print(json.dumps({'verified':True,'spanCalls':span_calls[0]}))
except Exception as e:
 print(json.dumps({'verified':False,'error':str(e)}))
`;
    return JSON.parse(execFileSync('bash', [path.join(project,'scripts/python-runtime.sh'), '-c', code],
        { cwd: project, input: JSON.stringify({ paper, runs: path.dirname(f.plan.runDir) }), encoding: 'utf8',
            env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS:'1' } }).trim());
}
test('正常Node parser的HTML全幅分类空白投影通过Python同一来源资格且原字节不变', async t => {
 const f=await fixture(t), before=JSON.stringify(f.paper);
 assert.equal(engine.hasValidApiReaderV3Records(f.paper),true);
 const result=pythonPublisher(f);
 assert.equal(result.verified,true,result.error);
 assert.equal(result.spanCalls,1,'同一篇所有空白格只能一次批量Node重放');
 assert.equal(JSON.stringify(f.paper),before);
});

function reseal(paper) {
 const plan=paper.apiReaderPlan,stage=paper.analysisManifest.stages.apiReaderArticle;
 const tables=require('../scripts/analysis-contract').extractMarkdownTables(paper.apiReaderArticle);
 plan.tableBindings.forEach((binding,index)=>binding.renderedTableSha256=repair.shaText(tables[index].markdown));
 plan.sourceBindingsSha256=daily.stableHash({tableBindings:plan.tableBindings,formulaBindings:plan.formulaBindings});
 stage.sourceBindingsSha256=plan.sourceBindingsSha256;
}
test('Python同封存来源拒错DOM SHA、分类行错坐标、缺原格以及删实测数字，不接受自重签plan', async t=>{
 const f=await fixture(t);
 for(const change of [p=>{p.apiReaderPlan.tableBindings[1].cellBindings.find(c=>c.sourceRow===1&&c.sourceColumn===1).sourceDomSha256='c'.repeat(64);},
 p=>{p.apiReaderPlan.tableBindings[1].cellBindings.find(c=>c.sourceRow===1&&c.sourceColumn===1).sourceRow=2;},
 p=>{p.apiReaderPlan.tableBindings[1].cellBindings=p.apiReaderPlan.tableBindings[1].cellBindings.filter(c=>!(c.sourceRow===1&&c.sourceColumn===4));},
 p=>{p.apiReaderArticle=p.apiReaderArticle.replace('| Baseline | 1.0 |','| Baseline |  |');p.apiReaderPlan.tableBindings[1].cellBindings.find(c=>c.sourceRow===2&&c.sourceColumn===1).renderedText='';}]){
  const paper=structuredClone(f.paper);change(paper);reseal(paper);assert.equal(pythonPublisher(f,paper).verified,false);
 }
});
test('Python批量桥拒四文件字节变动或错误来源代次，合法span仍原样保存',async t=>{
 const f=await fixture(t),file=path.join(f.plan.sourcesDir,f.paper.arxivId,'generation-000001','source-runtime.json');
 const bytes=fs.readFileSync(file);const changed=JSON.parse(bytes);changed.structuredArtifacts.tables[0].cells.find(c=>c.row===1).colspan=5;
 fs.writeFileSync(file,JSON.stringify(changed));assert.equal(pythonPublisher(f).verified,false);fs.writeFileSync(file,bytes);
 assert.equal(pythonPublisher(f).verified,true);
 const wrong=structuredClone(f.paper);wrong.freshRewriteProvenance.sourceGeneration=2;wrong.analysisManifest.freshRewriteProvenance=structuredClone(wrong.freshRewriteProvenance);
 assert.equal(pythonPublisher(f,wrong).verified,false);
});
