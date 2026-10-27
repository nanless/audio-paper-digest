'use strict';
// Source/PDF and the final failed draft are real saved bytes. This test never
// grants completion, submits a model request, or writes a production receipt.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib'),Module=require('node:module');
const ROOT=process.env.PD_TEST_GLYPH_PROJECT_ROOT||path.resolve(__dirname,'..');
const privateRoot=process.env.PD_TEST_GLYPH_PRIVATE_ROOT;
const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-glyph-real-test-')));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fixtureBytes=fs.readFileSync(path.join(__dirname,'fixtures/reader-scientific-glyph-35042-real.json.gz'));
assert.equal(sha(fixtureBytes),'dfd94d0b1b125f80242c1b48ec80e461f55cbd60cba0b461339519207a7f5ce7');
const fixture=JSON.parse(zlib.gunzipSync(fixtureBytes));
let privatePy,privateWrapper;
if(privateRoot){
 privatePy=path.join(temp,'reader_sealed_pdf_quote_evidence.py');privateWrapper=path.join(temp,'python-runtime.sh');
 fs.copyFileSync(path.join(privateRoot,'scripts/reader_sealed_pdf_quote_evidence.py'),privatePy);
 fs.writeFileSync(privateWrapper,`#!/bin/bash\nexport PYTHONPATH=${JSON.stringify(path.join(ROOT,'scripts'))}\nexec bash ${JSON.stringify(path.join(ROOT,'scripts/python-runtime.sh'))} "$@"\n`,{mode:0o600});
}
const scripts=['reader_sealed_pdf_quote_evidence.py','reader_sealed_pdf_table_evidence.py','reader_sealed_pdf_column_units.py','reader_authenticated_pdf_hierarchical_table.py','reader_authenticated_pdf_footnote_evidence.py'].map(p=>path.join(ROOT,'scripts',p));
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(temp,{readOnlyPythonScripts:[...scripts,...(privatePy?[privatePy]:[])]});
process.env.TMPDIR=temp;process.env.TMP=temp;process.env.TEMP=temp;
for(const[name,methods]of [['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]])
 for(const method of methods)require('node:'+name)[method]=()=>{throw Error('Scientific source tests forbid network');};
global.fetch=()=>{throw Error('Scientific source tests forbid network');};
// Private-preflight I/O adapter only. CI uses the actual production paths.
if(privateRoot){
 const extraction=require(path.join(ROOT,'scripts/lib/reader-pdf-extraction-scope')),child=require('node:child_process'),run=extraction.runPdfExtractor;
 extraction.runPdfExtractor=(program,fd,...args)=>program===privatePy
  ?child.execFileSync('bash',[privateWrapper,privatePy,'3'],{cwd:ROOT,timeout:60000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe',fd],env:{PATH:process.env.PATH,HOME:process.env.HOME}}):run(program,fd,...args);
 for(const relative of ['scripts/lib/reader-sealed-pdf-quote-evidence.js','scripts/lib/reader-scientific-quote-coverage.js','scripts/deep-analyzer.js']){
  const filename=path.join(ROOT,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=m;
  let code=fs.readFileSync(path.join(privateRoot,relative),'utf8');
  if(relative.endsWith('reader-sealed-pdf-quote-evidence.js'))code=code.replace("const program = path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py');",`const program = ${JSON.stringify(privatePy)};`);
  m._compile(code,filename);m.loaded=true;
 }
}
const Config=require(path.join(ROOT,'scripts/config')),daily=require(path.join(ROOT,'scripts/lib/daily-fresh-source-plan'));
const fresh=require(path.join(ROOT,'scripts/lib/fresh-analysis-context')),pdf=require(path.join(ROOT,'scripts/lib/reader-sealed-pdf-quote-evidence'));
const deep=require(path.join(ROOT,'scripts/deep-analyzer')),{extractMarkdownTables}=require(path.join(ROOT,'scripts/analysis-contract'));
const {projectScientificQuoteCoverage:project}=require(path.join(ROOT,'scripts/lib/reader-scientific-quote-coverage'));

test('伪JSON或普通字符串不产生PDF科学量能力',()=>{
 assert.throws(()=>pdf.scientificCoverageForQuotes([{valueOrigin:'sealed_pdf',quote:fixture.binding.pdfSourceQuotes[0]}]),/actual source scope/);
 const table=fixture.table,values=fixture.binding.pdfSourceQuotes;
 assert.equal(project(table,values,deep.readerNumericTokens).failures.length,3);
 assert.throws(()=>project(table,values,deep.readerNumericTokens,{pdfCapability:{}}),/token/);
});

test('真实四源/PDF/付费A3经正常能力完整解析；相邻错值、角色、伪能力全部拒',async t=>{
 const originalRun=Buffer.from(fixture.sourceRun.base64,'base64');assert.equal(sha(originalRun),fixture.sourceRun.sha256);
 const run=JSON.parse(originalRun),oldRuns=Config.FILES.dailyFreshSourceRunsDir;
 Config.FILES.dailyFreshSourceRunsDir=path.join(temp,'runs');
 t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=oldRuns;});
 const runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,run.runId),sourceDir=path.join(runDir,'sources','2610.35042','generation-000001');
 fs.mkdirSync(sourceDir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(runDir,'run.json'),originalRun,{mode:0o600});
 for(const[name,entry]of Object.entries(fixture.sourceFiles)){const data=Buffer.from(entry.base64,'base64');assert.equal(sha(data),entry.sha256);fs.writeFileSync(path.join(sourceDir,name),data,{mode:0o600});}
 const plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir})),paper=structuredClone(fixture.paper);
 const source=daily.readDailyFreshSource(plan,paper),artifacts=source.structuredArtifacts;
 fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source);
 const table=extractMarkdownTables(fixture.draft.sections[8].body)[0];let token,values,parsed;
 await daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(paper,()=>pdf.withArtifacts(artifacts,paper.arxivId,()=>{
  const proofs=pdf.evidenceForQuotes(fixture.binding.pdfSourceQuotes);values=proofs.map(p=>p.quote);token=pdf.scientificCoverageForQuotes(proofs);
  const base=project(table,values,deep.readerNumericTokens,{pdfCapability:token});assert.deepEqual(base.failures,[]);assert.equal(base.proofs.length,3);assert.ok(base.tokens.includes('0.7'));
  for(const fake of [{},structuredClone(token),{scientificQuantities:base.proofs}])assert.throws(()=>project(table,values,deep.readerNumericTokens,{pdfCapability:fake}),/token/);
  const foreign=structuredClone(proofs);foreign[0].pdfSha256='0'.repeat(64);assert.throws(()=>pdf.scientificCoverageForQuotes(foreign),/differs/);
  for(const value of ['1×10−9','7×10−4','1.0×10−4','1×10−4 ms','1×10−4 kg','1×10−4/s','1×10−4 3','１×10−4','1×１０−4','1×10₋₄','1×10−4†','1\\times10^{-9}']){
   const changed=structuredClone(table);changed.rows[0][1]=value;changed.markdown=table.markdown.replace('1×10−4',value);
   assert.ok(project(changed,values,deep.readerNumericTokens,{pdfCapability:token}).failures.length,value);
  }
  for(const mutate of [x=>x.rows.reverse(),x=>{[x.rows[0][1],x.rows[1][1]]=[x.rows[1][1],x.rows[0][1]];},x=>x.rows.pop(),x=>x.rows.push([...x.rows[0]]),x=>x.header[1]='准确率',x=>x.rows[0][0]='Other SFT']){
   const changed=structuredClone(table);mutate(changed);changed.markdown='| '+changed.header.join(' | ')+' |\n| --- | --- | --- | --- |\n'+changed.rows.map(r=>'| '+r.join(' | ')+' |').join('\n');
   assert.ok(project(changed,values,deep.readerNumericTokens,{pdfCapability:token}).failures.length);
  }
  const split=pdf.evidenceForQuotes(['We use AdamW with learning rates of 1×10−4,','2×10−6, and 5×10−6 for SFT, RL-Stage I, and RL-Stage II, respectively.']);
  assert.equal(project(table,split.map(p=>p.quote),deep.readerNumericTokens,{pdfCapability:pdf.scientificCoverageForQuotes(split)}).failures.length,3);
  assert.throws(()=>project(table,[values[0]+' changed',...values.slice(1)],deep.readerNumericTokens,{pdfCapability:token}),/token/);
  parsed=deep.parseApiReaderArticleResult(JSON.stringify(fixture.draft),{arxivId:paper.arxivId,availableFigureOrdinals:[1,2,3],requireIntegratedTables:true,minimumIntegratedTables:2,
   requiredVersion:3,requireSourceBindings:true,allowDeterministicQuoteRepair:true,allowDeterministicUnsupportedClaimPruning:true,
   verifiedResourceIdentity:paper.apiReaderResources,enforceResourceAvailabilityClaims:true,structuredArtifacts:artifacts,sourceText:source.text});
 })),{refreshReaderDiagnostics:true});
 assert.throws(()=>project(table,values,deep.readerNumericTokens,{pdfCapability:token}),/token/);
 assert.equal(parsed.plan.tableBindings.length,4);assert.equal(sha(parsed.article),'103de6151da40d8aa6d2c8329ca617caddf964a7cd16672e7679a0f15960c44f');
 assert.equal(sha(JSON.stringify(parsed.plan)),'5aeed8697b02185fc94cb2d16f721e656b93711e6846a175515a64ac802d0325');
 assert.equal(paper.analysisManifest.stages.apiReaderArticle.status,fixture.paper.analysisManifest.stages.apiReaderArticle.status,'the saved failed stage is not upgraded');
});
