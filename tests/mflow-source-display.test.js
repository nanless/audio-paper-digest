'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const display=require('../scripts/lib/reader-source-display').normalizeReaderSourceDisplayArtifacts;
const cases=require('./fixtures/mflow-source-display-cases.json');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('MFlow exact paired arrows and explicit mean/uncertainty operator preserve directions, numeric bytes and literal units',()=>{
 for(const [raw,expected]of cases.positive){assert.equal(display(raw),expected,raw);assert.equal(display(expected),expected);}
 for(const raw of cases.unchanged)assert.equal(display(raw),raw,raw);
});
const actualFile=process.env.MFLOW_DISPLAY_CURRENT_FILE;
test('paired DOM route selection preserves non-daily components and fake daily identity cannot enter the production source scope',()=>{
 const runId='00000000-0000-4000-8000-000000000000';
 const provenance={contract:'fresh-source-analysis-v1',runId};
 const ordinary={freshRewriteProvenance:provenance,analysisManifest:{freshRewriteProvenance:structuredClone(provenance)},apiReaderArticle:'ordinary',apiReaderPlan:{tableBindings:[{sourceType:'artifact_table',tableIndex:1,sourceTableOrdinal:1,cellBindings:[]}]}};
 // Only proves route preservation; this callback grants no source/publication qualification.
 assert.equal(require('../scripts/lib/reader-table-pdf-evidence').withSavedPaper(ordinary,()=> 'legacy route'),'legacy route');
 if(actualFile){
  const dataBytes=fs.readFileSync(actualFile);assert.equal(sha(dataBytes),process.env.MFLOW_DISPLAY_CURRENT_SHA256);
  const data=JSON.parse(dataBytes),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context');
  const plan=daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun),paper=structuredClone(data.papers.find(p=>p.arxivId==='2610.41852v1'));
  paper.freshRewriteProvenance.runId=runId;paper.analysisManifest.freshRewriteProvenance.runId=runId;
  assert.throws(()=>daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(paper,()=>assert.fail('unbound daily paper entered production source scope'))));
  assert.throws(()=>daily.readDailyFreshSourcePlan({...data.dailyFreshSourceRun,runId}));
 }
});
test('actual new paid draft retains all five complete original DOM grids during normal source-bound parsing', {skip:!actualFile},()=>{
 const bytes=fs.readFileSync(actualFile);assert.equal(sha(bytes),process.env.MFLOW_DISPLAY_CURRENT_SHA256);
 const candidateFile=process.env.MFLOW_DISPLAY_CANDIDATE_FILE,candidateBytes=fs.readFileSync(candidateFile);
 assert.equal(sha(candidateBytes),process.env.MFLOW_DISPLAY_CANDIDATE_SHA256);
 assert.equal(sha(candidateBytes),'831643acc4f9d43227ebbd6f10f88dde4f33eea8c5bc099dcb90ed6d393c9500');
 const candidate=JSON.parse(candidateBytes),data=JSON.parse(bytes),paper=data.papers.find(p=>p.arxivId==='2610.41852v1');
 const daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context'),deep=require('../scripts/deep-analyzer'),tables=require('../scripts/lib/reader-tables');
 const plan=daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun),source=daily.readDailyFreshSource(plan,paper);
 const before=JSON.stringify(source),sourceSha=source.freshSourceDescriptor.sourceManifestSha256;
 const parsed=require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(()=>daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(paper,()=>{
  for(const ordinal of [1,2,6,7,9])assert.equal(tables.assessReaderCompleteTableEligibility(source.structuredArtifacts.tables.find(t=>t.ordinal===ordinal)).eligible,true,'TABLE_'+ordinal);
  return deep.parseApiReaderArticleResult(JSON.stringify(candidate.payload.draft),{arxivId:paper.arxivId,requiredVersion:3,requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,allowDeterministicUnsupportedClaimPruning:true,enforceResourceAvailabilityClaims:true,verifiedResourceIdentity:deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources,source.text),availableFigureOrdinals:candidate.payload.imageEvidence.filter(i=>i.kind==='figure'&&i.status==='ready').map(i=>i.ordinal),structuredArtifacts:source.structuredArtifacts,sourceText:source.text});
 })));
 assert.deepEqual(parsed.plan.tableBindings.map(b=>b.sourceTableOrdinal),[1,2,6,7,9]);
 const rendered=require('../scripts/analysis-contract').extractMarkdownTables(parsed.article);
 for(const [index,binding]of parsed.plan.tableBindings.entries()){
  const original=source.structuredArtifacts.tables.find(t=>t.ordinal===binding.sourceTableOrdinal),matrix=[rendered[index].header,...rendered[index].rows];
  assert.equal(binding.sourceTableDomSha256,original.sourceDomSha256);assert.equal(binding.sourceType,'artifact_table');
  assert.equal(matrix.length,original.matrix.length);assert(matrix.every(row=>row.length===original.matrix[0].length));
  assert.equal(binding.cellBindings.length,original.matrix.reduce((n,row)=>n+row.length,0));
  for(const cell of binding.cellBindings){
   const owned=original.cells.filter(c=>cell.sourceRow>=c.row&&cell.sourceRow<c.row+c.rowspan&&cell.sourceColumn>=c.column&&cell.sourceColumn<c.column+c.colspan);
   assert.equal(owned.length,1);assert.equal(cell.sourceDomSha256,owned[0].sourceDomSha256);assert.equal(cell.sourceText,owned[0].text);
   assert.equal(matrix[cell.renderedRow][cell.renderedColumn],display(owned[0].text));
  }
 }
 assert.deepEqual(rendered[0].header.slice(3),['FD↓','KL↓','IS↑','FADv↓','CLAP↑','FADopenl3↓']);
 assert.equal(rendered[1].rows[0][1],'22.23 ± 3.1 s');assert.equal(rendered[1].rows[0][2],'5.23 ± 13 ms');
 const saved={...structuredClone(paper),apiReaderArticle:parsed.article,apiReaderPlan:structuredClone(parsed.plan)};
 const cold=require('../scripts/lib/reader-table-pdf-evidence');
 assert.equal(cold.withSavedPaper(saved,()=>true),true);
 const stable=value=>{const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return sha(JSON.stringify(sort(value)));};
 const mutations=[
  ['forged cell DOM',p=>p.apiReaderPlan.tableBindings[0].cellBindings[3].sourceDomSha256='0'.repeat(64)],
  ['neighbor coordinates',p=>p.apiReaderPlan.tableBindings[0].cellBindings[3].sourceColumn=4],
  ['downgraded raw markers',p=>{for(const b of p.apiReaderPlan.tableBindings)for(const c of b.cellBindings){c.sourceText=c.renderedText;c.sourceDomSha256='0'.repeat(64);}}],
  ['missing serialized payload',p=>delete p.apiReaderPlan.structuredSourcePayload],
  ['forged serialized payload',p=>p.apiReaderPlan.structuredSourcePayload='forged'],
  ['table DOM substitution',p=>p.apiReaderPlan.tableBindings[4].sourceTableDomSha256='0'.repeat(64)],
  ['source table ordinal replacement',p=>{for(const b of p.apiReaderPlan.tableBindings)b.sourceTableOrdinal=9;}],
  ['incomplete table',p=>p.apiReaderPlan.tableBindings[0].cellBindings.pop()],
  ...[['wrong arrow','FD↓','FD↑'],['changed precision','22.23 ± 3.1 s','22.230 ± 3.1 s'],['changed unit','5.23 ± 13 ms','5.23 ± 13 s'],['extra number','22.23 ± 3.1 s','22.23 ± 3.1 2 s'],['extra unit','22.23 ± 3.1 s','22.23 ± 3.1 s ms']].map(([label,from,to])=>[label,p=>{
   p.apiReaderArticle=p.apiReaderArticle.replace(from,to);
   for(const b of p.apiReaderPlan.tableBindings)for(const c of b.cellBindings)if(c.renderedText===from)c.renderedText=to;
  }])
 ];
 for(const [label,mutate]of mutations){const bad=structuredClone(saved);mutate(bad);bad.apiReaderPlan.sourceBindingsSha256=stable({tableBindings:bad.apiReaderPlan.tableBindings,formulaBindings:bad.apiReaderPlan.formulaBindings});
  assert.throws(()=>cold.withSavedPaper(bad,()=>true),/Paired DOM display/,label);
 }
 assert.equal(JSON.stringify(source),before);assert.equal(daily.readDailyFreshSource(plan,paper).freshSourceDescriptor.sourceManifestSha256,sourceSha);
 assert.equal(sha(fs.readFileSync(actualFile)),sha(bytes));assert.equal(sha(fs.readFileSync(candidateFile)),sha(candidateBytes));
});
