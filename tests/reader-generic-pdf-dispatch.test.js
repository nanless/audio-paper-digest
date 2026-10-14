'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const actualRoot=process.env.PD_GENERIC_PDF_DISPATCH_REAL_SOURCE_ROOT;
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const deep=require('../scripts/deep-analyzer'),dispatch=require('../scripts/lib/reader-table-pdf-evidence'),tables=require('../scripts/lib/reader-tables');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('新PDF来源说明不改变旧表，也不能替代缺失的结果解释',()=>{
 const article='说明比较条件和实际对象。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n解释不足。';
 assert.equal(dispatch.appendSourceOriginNotes(article,[{tableIndex:1,pdfCellConfirmation:{}}]),article);
 assert.equal(dispatch.appendSourceOriginNotes(article,[{tableIndex:1,sealedPdfTableEvidence:{}}]),article);
 const valid=article.replace('解释不足。','这张表只支持当前数据集和固定条件下的比较，其他环境与部署成本仍需要另外验证。');
 const noted=dispatch.appendSourceOriginNotes(valid,[{tableIndex:1,sealedPdfTableEvidence:{}}]);
 assert.ok(noted.endsWith('本表数值与单位依据论文 PDF。'));assert.equal(dispatch.appendSourceOriginNotes(noted,[{tableIndex:1,sealedPdfTableEvidence:{}}]),noted);
});
test('真实四封存的四表通过正常回放/来源编译和冷态逐格guard，生成证据字节不变', {skip:!actualRoot},async t=>{
 const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context');
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-generic-grid-context-')),oldRoot=Config.FILES.dailyFreshSourceRunsDir;
 Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=oldRoot;fs.rmSync(root,{recursive:true,force:true});});
 const originalRun=path.dirname(path.resolve(actualRoot)),runId=path.basename(originalRun),runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,runId);
 fs.mkdirSync(runDir,{recursive:true,mode:0o700});fs.copyFileSync(path.join(originalRun,'run.json'),path.join(runDir,'run.json'));
 const ids=['2610.09334','2610.09655'],fileNames=['source.txt','source.pdf','source-runtime.json','source-manifest.json'];
 const before={};for(const id of ids){const dir=path.join(runDir,'sources',id,'generation-000001');fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const name of fileNames){const original=path.join(actualRoot,id,'generation-000001',name);before[original]=sha(fs.readFileSync(original));fs.copyFileSync(original,path.join(dir,name));}}
 const rules=['scripts/lib/reader-pdf-cell-evidence.js','scripts/reader_pdf_cell_evidence.py'].map(file=>[file,sha(fs.readFileSync(file))]);
 const run=JSON.parse(fs.readFileSync(path.join(runDir,'run.json'))),plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir}));
 for(const id of ids){const paper={arxivId:id+'v1',title:'Actual sealed source tables',analysisManifest:{stages:{}}},source=daily.readDailyFreshSource(plan,paper),artifacts=source.structuredArtifacts;
 let parsed,draft;
 await daily.withDailyFreshAnalysisContext(plan,()=>{fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source);return fresh.withFreshPaperContext(paper,async()=>{
  paper.sourceSha256=source.freshSourceDescriptor.sourceSha256;
  paper.analysisManifest.sourceAcquisition={sourceSha256:paper.sourceSha256,structuredArtifactsSha256:artifacts.payloadSha256};
  const originalEvidence=deep.buildApiReaderEvidenceContext('',source.text,artifacts,paper.arxivId,null,null,false);
  let eligible;dispatch.withArtifacts(artifacts,id,()=>{eligible=artifacts.tables.filter(table=>dispatch.sealedEvidence(table));});assert.equal(eligible.length,2);
  draft={version:3,readerTitle:'完整原表的实际来源与测量条件',oneSentenceThesis:'保留完整比较条件并说明来源。',sections:eligible.map((table,i)=>({kind:i?'ablation':'result',heading:'结果与条件',body:'本表比较同一论文在规定数据和评价条件下的方法，先明确各列含义再判断测量结果。\n\n[[TABLE_'+(i+1)+']]\n\n这些结果只支持论文报告的数据和固定条件下的比较，其他环境与部署成本仍需要独立验证，不能从一张表推断普遍结论。'})),conceptBridges:[],figurePlacements:[],formulaBindings:[],tableBindings:eligible.map((table,i)=>({tableIndex:i+1,completeTable:{sourceTableOrdinal:table.ordinal}}))};
  const prepared=await deep.prepareApiReaderRetryIdentity(paper,'',originalEvidence,{readerReplayPreparationOnly:true,sourceText:source.text,structuredArtifacts:artifacts});
  const normalized=prepared.normalizeReplayDraft(draft,[],[]);assert.equal(normalized.tableBindings?.length,2);
  dispatch.withArtifacts(artifacts,id,()=>{
   for(const table of eligible){assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible,true);assert.ok(dispatch.sealedEvidence(table));}
   parsed=deep.bindApiReaderSourceEvidence(normalized.sections.map(section=>'### '+section.heading+'\n\n'+section.body).join('\n\n'),normalized.tableBindings,[],{structuredArtifacts:artifacts,sourceText:source.text,sections:normalized.sections});
   assert.equal(parsed.tableBindings.length,2);assert.ok(parsed.tableBindings.every(binding=>binding.sealedPdfTableEvidence && !binding.pdfCellConfirmation));
   assert.equal((parsed.article.match(/本表数值与单位依据论文 PDF。/g)||[]).length,2);
  });
  assert.equal(deep.buildApiReaderEvidenceContext('',source.text,artifacts,paper.arxivId,null,null,false),originalEvidence);
 });});
 Object.assign(paper,{apiReaderPlan:{tableBindings:parsed.tableBindings,structuredSourcePayload:parsed.structuredSourcePayload},apiReaderArticle:parsed.article});
 const rendered=require('../scripts/analysis-contract').extractMarkdownTables(parsed.article);
 dispatch.withSavedPaper(paper,()=>{for(const binding of parsed.tableBindings)for(const cell of binding.cellBindings){const table=rendered[binding.tableIndex-1];assert.equal(dispatch.savedCellMatches(binding,cell,[table.header,...table.rows][cell.renderedRow][cell.renderedColumn]),true);}});
 for(const mutate of [p=>p.apiReaderPlan.tableBindings[0].sealedPdfTableEvidence.displayMatrix[1][1]='fake',p=>p.apiReaderPlan.tableBindings[0].cellBindings[1]=structuredClone(p.apiReaderPlan.tableBindings[0].cellBindings[0]),p=>p.apiReaderPlan.tableBindings[0].cellBindings[1].sourceText+='fake',p=>p.apiReaderPlan.tableBindings[0].pdfCellConfirmation={}]){const bad=structuredClone(paper);mutate(bad);assert.throws(()=>dispatch.withSavedPaper(bad,()=>{}),/exact complete table/);}
 }
 for(const [file,value] of Object.entries(before))assert.equal(sha(fs.readFileSync(file)),value);
 for(const [file,value] of rules)assert.equal(sha(fs.readFileSync(file)),value);
});
