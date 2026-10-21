'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const raw=fs.readFileSync(path.join(__dirname,'fixtures/reader-daily-vector-unit-tables-20261021-real.json.gz'));
assert.equal(sha(raw),'2337fbe91cd6dabbaef83f7cb92e65be51fe9593ce76119cbe6ae170d228d222');
const fixture=JSON.parse(zlib.gunzipSync(raw));
for(const item of [fixture.pdf,fixture.originalCandidate,fixture.firstOperatorRecord])assert.equal(sha(Buffer.from(item.base64,'base64')),item.sha256);
assert.equal(sha(fixture.sourceText),fixture.provenance.sourceSha256);
const candidate=JSON.parse(Buffer.from(fixture.originalCandidate.base64,'base64'));
const beforeRecord=JSON.parse(Buffer.from(fixture.firstOperatorRecord.base64,'base64'));

test('真实EA-SURF付费稿、完整DOM分组和封存PDF共同证明偏好行、列单位与均值差，冷热核验保留原文件',async t=>{
 const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan');
 const fresh=require('../scripts/lib/fresh-analysis-context'),quotes=require('../scripts/lib/reader-sealed-pdf-quote-evidence');
 const units=require('../scripts/lib/reader-source-table-column-units'),deep=require('../scripts/deep-analyzer');
 const parseTables=require('../scripts/analysis-contract').extractMarkdownTables;
 const stop=require('../scripts/lib/analysis-stop-control');
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-real-vector-grid-'));
 const previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(temp,'runs');
 t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(temp,{recursive:true,force:true});});
 await stop.withModelRequestsForbidden(async()=>{
  const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-21',batchId:'real-vector-grid',papers:[{arxivId:fixture.arxivId,title:fixture.title}]});
  await daily.captureDailyFreshSources(plan,{concurrency:1,capture:args=>require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args,{
   fetchText:async id=>({text:fixture.sourceText,structuredArtifacts:fixture.structuredArtifacts,readerAuthors:fixture.readerAuthors,source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-21T00:00:00.000Z',imageInfos:[],warnings:[]}),
   fetchPdf:async id=>({bytes:Buffer.from(fixture.pdf.base64,'base64'),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-21T00:00:01.000Z'})})});
  const paper={arxivId:fixture.arxivId,analysisManifest:{stages:{}}},source=daily.readDailyFreshSource(plan,paper);
  const files=['source.txt','source.pdf','source-runtime.json','source-manifest.json'].map(name=>path.join(plan.sourcesDir,fixture.arxivId,'generation-000001',name));
  const original=files.map(file=>fs.readFileSync(file));let parsed;
  await daily.withDailyFreshAnalysisContext(plan,()=>{
   fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source);
   return fresh.withFreshPaperContext(paper,()=>quotes.withArtifacts(source.structuredArtifacts,fixture.arxivId,()=>{
    const options={arxivId:fixture.arxivId,requiredVersion:3,requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,allowDeterministicUnsupportedClaimPruning:true,structuredArtifacts:source.structuredArtifacts,sourceText:source.text,availableFigureOrdinals:candidate.payload.imageEvidence.map(item=>item.ordinal)};
    assert.throws(()=>deep.parseApiReaderArticleResult(JSON.stringify(beforeRecord.draft),options),/粘连复写/);
    parsed=deep.parseApiReaderArticleResult(JSON.stringify(fixture.proposedDraft),options);
    const tables=parseTables(parsed.article);assert.equal(tables.length,2);
    assert.equal(candidate.payload.attempts,3);assert.equal(candidate.payload.fullAttempts,1);
    for(const [index,table]of tables.entries()){
     const binding=parsed.plan.tableBindings[index],evidence=[...binding.sourceQuotes,...binding.sealedPdfQuoteEvidence];
     assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table,evidence),[]);
     assert(units.coverage(table,evidence).some(value=>value.printedRowPdfQuoteSha256));
     for(const mutate of [v=>v.rows.pop(),v=>v.rows.reverse(),v=>{v.rows[0][1]='99';},v=>{v.header[1]=v.header[1].replace('%','ms');},v=>{[v.header[1],v.header[2]]=[v.header[2],v.header[1]];},v=>{v.rows[0][0]='(0.9, 0.1)';}]){
      const bad=structuredClone(table);mutate(bad);assert(deep.readerTableHeaderUnitEvidenceFailures(bad,evidence).length>0);
     }
     if(index===1){const bad=structuredClone(table);bad.rows.at(-1)[1]='+0.16';assert(deep.readerTableHeaderUnitEvidenceFailures(bad,evidence).length>0);}
     const forged=structuredClone(evidence);forged.find(item=>item.contract==='reader-sealed-pdf-quotes-v1').pdfSha256='0'.repeat(64);
     assert.throws(()=>deep.readerTableHeaderUnitEvidenceFailures(table,forged),/differs/);
    }
    const originalCell=source.structuredArtifacts.tables[0].cells[1].text;
    try{
     source.structuredArtifacts.tables[0].cells[1].text+=' changed';
     const table=tables[0],binding=parsed.plan.tableBindings[0];
     assert.throws(()=>units.coverage(table,[...binding.sourceQuotes,...binding.sealedPdfQuoteEvidence]),/artifacts changed/);
    }finally{source.structuredArtifacts.tables[0].cells[1].text=originalCell;}
   }));
  });
  paper.sourceSha256=source.freshSourceDescriptor.sourceSha256;
  paper.analysisManifest.sourceAcquisition={sourceSha256:paper.sourceSha256,structuredArtifactsSha256:source.freshSourceDescriptor.structuredArtifactsSha256};
  paper.analysisManifest.stages.apiReaderArticle={structuredArtifactsSha256:source.freshSourceDescriptor.structuredArtifactsSha256,sourceBindingsSourceTextSha256:paper.sourceSha256};
  paper.apiReaderArticle=parsed.article;paper.apiReaderPlan=parsed.plan;
  quotes.withSavedPaper(paper,()=>units.withSavedPaper(paper,()=>{
   for(const [index,table]of parseTables(parsed.article).entries()){
    const binding=parsed.plan.tableBindings[index];assert.deepEqual(deep.readerTableHeaderUnitEvidenceFailures(table,[...binding.sourceQuotes,...binding.sealedPdfQuoteEvidence]),[]);
   }
  }));
  const table=parseTables(parsed.article)[0],binding=parsed.plan.tableBindings[0];
  assert(deep.readerTableHeaderUnitEvidenceFailures(table,[...binding.sourceQuotes,...binding.sealedPdfQuoteEvidence]).length>0);
  try{fs.appendFileSync(files[1],'changed');assert.throws(()=>quotes.withSavedPaper(paper,()=>{}),/SHA|sha|hash|changed|来源|哈希/);}finally{fs.writeFileSync(files[1],original[1]);}
  files.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),original[index]));
 });
});

test('偏好向量中的重复分量须有完整来源序列，未知列、整格复写和错序仍拒绝',()=>{
 const find=require('../scripts/lib/reader-tables').findReaderTablePasteDuplication;
 const cell='(0.2, 0.2, 0.6)',context={columnIndex:0,header:['Request p','WER (%) ↓'],row:[cell,'7.38'],sourceTexts:['Request p\n(.2, .2, .6) 7.38 7.49']};
 assert.equal(find(cell,context),null);
 for(const value of [cell+cell,'(0.6, 0.2, 0.2)','(0.2, 0.2, 0.2, 0.4)'])assert(find(value,{...context,row:[value,'7.38']}));
 assert(find(cell,{...context,sourceTexts:[]}));
 assert(find(cell,{...context,header:['ID','WER (%) ↓']}));
 assert(find(cell,{...context,sourceTexts:['(.2,.2,.6)(.2,.2,.6)']}));
});
