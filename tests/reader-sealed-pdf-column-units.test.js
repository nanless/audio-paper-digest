'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const actualRoot=process.env.PD_PDF_COLUMN_REAL_SOURCE_ROOT, actualDraft=process.env.PD_PDF_COLUMN_REAL_DRAFT;
const columns=require('../scripts/lib/reader-sealed-pdf-column-units'),quotes=require('../scripts/lib/reader-sealed-pdf-quote-evidence');
test('列单位不接受模型对象或作用域外伪证明',()=>{
 assert.deepEqual(columns.coverage({header:['Rate (%)'],rows:[['0.50']]},[{contract:quotes.CONTRACT,quote:'invented rate 0.50'}]),[]);
 assert.throws(()=>columns.deriveBundle({rootDir:'/tmp/untrusted/sources'},[],[]),/actual daily sealed source root/);
});
test('真实四源完整35格PDF独立列证明贯穿Reader单位guard并拒绝变异', {skip:!actualRoot||!actualDraft},async t=>{
 const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context'),deep=require('../scripts/deep-analyzer');
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-column-units-test-')),previous=Config.FILES.dailyFreshSourceRunsDir;
 Config.FILES.dailyFreshSourceRunsDir=path.join(temp,'runs');t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(temp,{recursive:true,force:true});});
 const runId=path.basename(path.dirname(actualRoot)),runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,runId);
 fs.mkdirSync(runDir,{recursive:true,mode:0o700});fs.copyFileSync(path.join(path.dirname(actualRoot),'run.json'),path.join(runDir,'run.json'));
 const id='2610.11787',target=path.join(runDir,'sources',id,'generation-000001');fs.mkdirSync(target,{recursive:true,mode:0o700});
 const originals=new Map();for(const name of ['source.txt','source.pdf','source-runtime.json','source-manifest.json']){
  const file=path.join(actualRoot,id,'generation-000001',name);originals.set(file,fs.readFileSync(file));fs.copyFileSync(file,path.join(target,name));
 }
 const run=JSON.parse(fs.readFileSync(path.join(runDir,'run.json'))),plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir}));
 const paper={arxivId:id+'v1',analysisManifest:{stages:{}}},source=daily.readDailyFreshSource(plan,paper);
 const record=JSON.parse(fs.readFileSync(actualDraft)),rawQuotes=record.draft.tableBindings[3].pdfSourceQuotes;
 const tables=require('../scripts/analysis-contract').extractMarkdownTables(record.draft.sections.map(s=>s.body).join('\n\n')),table=tables[3];
 let proof;
 await daily.withDailyFreshAnalysisContext(plan,()=>{fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source);return fresh.withFreshPaperContext(paper,()=>quotes.withArtifacts(source.structuredArtifacts,id,()=>{
  proof=quotes.evidenceForQuotes(rawQuotes);
  const ctx=quotes.verifiedSourceContext(),derived=columns.deriveBundle(ctx.expectation,[table.header,...table.rows],rawQuotes);
  assert.equal(derived.cells.length,35);assert.equal(derived.wordBoxCount,99);assert.equal(derived.valueOrigin,'sealed_pdf');assert.equal(derived.projectedEquivalent,true);
  assert.notEqual(derived.viewSha256,derived.displayMatrixSha256);assert.equal(derived.units[0].column,3);
  assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table,proof),[]);
  for(const mutate of [v=>v.header[3]='ΔF1 (ms)',v=>v.rows[0][3]='0.11',v=>v.rows[0][3]='-0.110',v=>v.rows.reverse(),v=>v.rows.pop(),v=>v.rows[0][0]='Fast speech (c1)',v=>v.rows[0][3]='－0.11']){
   const bad=structuredClone(table);mutate(bad);assert(deep.readerTableHeaderUnitEvidenceFailures(bad,proof).length>0);
  }
  const bad=structuredClone(proof);bad[0].pdfSha256='0'.repeat(64);assert.throws(()=>deep.readerTableHeaderUnitEvidenceFailures(table,bad),/differs/);
 }));});
 assert.equal(deep.readerTableHeaderUnitEvidenceFailures(table,proof).length,6);
 for(const [file,bytes] of originals)assert.deepEqual(fs.readFileSync(file),bytes);
});
test('真实临时四源均值与标准差列在Node guard经同一Python几何核验且拒绝变异',async t=>{
 const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context'),deep=require('../scripts/deep-analyzer'),repair=require('../scripts/lib/reader-repair');
 const root=path.resolve(__dirname,'..'),child=require('node:child_process');
 const fixture=JSON.parse(child.execFileSync('bash',[path.join(root,'scripts/python-runtime.sh'),'-B','-c',`import sys,json,base64\nsys.path.insert(0,'tests/python')\nfrom test_reader_sealed_pdf_column_units import fixture\nraw,table,view,quotes=fixture(True)\nprint(json.dumps({'pdf':base64.b64encode(raw).decode(),'table':table,'view':view,'quotes':quotes}))`],{cwd:root,encoding:'utf8'}));
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-mean-sd-units-')),previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(temp,'runs');
 t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(temp,{recursive:true,force:true});});
 const text=fixture.quotes.join('\n')+'\n'+('The same literal measurement protocol controls all values. '.repeat(50)),s=require('./reader-signed-draft-fixture').fixture({noFigures:true,sourceText:text});
 const {payloadSha256,...base}=s.sourceDetails.structuredArtifacts,sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
 const body=sort({...base,tables:[{...fixture.table,recoveryStatus:'complete'}],formulas:[]}),artifacts={...body,payloadSha256:repair.hashDraft(body)},paper=s.paper;
 const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-11',batchId:'literal-uncertainty',papers:[{arxivId:paper.arxivId,title:'Literal uncertainty measurements'}]});
 await daily.captureDailyFreshSources(plan,{concurrency:1,capture:args=>require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args,{fetchText:async id=>({text,structuredArtifacts:artifacts,source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-11T00:00:00.000Z',imageInfos:[],warnings:[]}),fetchPdf:async id=>({bytes:Buffer.from(fixture.pdf,'base64'),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-11T00:00:01.000Z'})})});
 const source=daily.readDailyFreshSource(plan,paper),table={header:fixture.view[0],rows:fixture.view.slice(1)};
 const files=['source.txt','source.pdf','source-runtime.json','source-manifest.json'].map(name=>path.join(plan.sourcesDir,paper.arxivId,'generation-000001',name)),before=files.map(file=>fs.readFileSync(file));let proofs;
 await daily.withDailyFreshAnalysisContext(plan,()=>{fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source);return fresh.withFreshPaperContext(paper,()=>quotes.withArtifacts(source.structuredArtifacts,paper.arxivId,()=>{
  proofs=quotes.evidenceForQuotes(fixture.quotes);assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table,proofs),[]);
  const compact=structuredClone(table);compact.rows.forEach(row=>{row[1]=row[1].replace(/\s*±\s*/g,'±');});assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(compact,proofs),[]);
  for(const change of [v=>v.rows[0][1]='0.50 ± 0.1',v=>v.rows[0][1]='0.50 ± -0.10',v=>v.rows[0][1]='0.50',v=>v.header[1]='Value (ms)',v=>v.rows.reverse()]){
   const value=structuredClone(table);change(value);assert(deep.readerTableHeaderUnitEvidenceFailures(value,proofs).length>0);
  }
  const forged=structuredClone(proofs);forged[0].pdfSha256='0'.repeat(64);assert.throws(()=>deep.readerTableHeaderUnitEvidenceFailures(table,forged),/differs/);
 }));});
 assert(deep.readerTableHeaderUnitEvidenceFailures(table,proofs).length>0);files.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
});
