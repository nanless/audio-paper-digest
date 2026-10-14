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
