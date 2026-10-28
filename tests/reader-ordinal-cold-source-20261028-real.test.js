'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const ROOT=path.resolve(__dirname,'..'),sha=x=>crypto.createHash('sha256').update(x).digest('hex'),clone=x=>structuredClone(x);
const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'fixtures/reader-ordinal-cold-source-20261028-real.r3.json.gz'))));
assert.equal(fixture.contract,'ordinal-cold-saved-source-real-fixture-v1');
const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ordinal-cold-portable-')));
const python=require('node:child_process').execFileSync('bash',[path.join(ROOT,'scripts/python-runtime.sh'),'-c','import sys; print(sys.executable)'],{cwd:ROOT,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim();
for(const dir of ['scripts','prompts','config','manual/scripts'])fs.cpSync(path.join(ROOT,dir),path.join(workspace,dir),{recursive:true,filter:p=>!p.includes('__pycache__')});
fs.mkdirSync(path.join(workspace,'.venv/bin'),{recursive:true});fs.writeFileSync(path.join(workspace,'.venv/bin/python'),'#!/bin/sh\nexec '+"'"+python.replaceAll("'","'\"'\"'")+"'"+' "$@"\n',{mode:0o700});
process.env.NODE_PATH=process.env.TEST_ORDINAL_NODE_MODULES||path.join(ROOT,'node_modules');require('node:module').Module._initPaths();
const originalRefs=fixture.cases.flatMap(c=>[c.completion,...Object.values(c.sourceFiles),...c.files]).filter(r=>fs.existsSync(r.originalPath)).map(r=>({file:r.originalPath,sha256:r.sha256}));
for(const r of originalRefs)assert.equal(sha(fs.readFileSync(r.file)),r.sha256);
const py=['reader_sealed_pdf_table_evidence.py','reader_sealed_pdf_quote_evidence.py','reader_sealed_pdf_column_units.py','reader_authenticated_pdf_hierarchical_table.py','reader_authenticated_pdf_footnote_evidence.py'];
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(workspace,{readOnlyPythonScripts:py.map(n=>path.join(workspace,'scripts',n))});
Object.assign(process.env,{TMPDIR:workspace,TMP:workspace,TEMP:workspace,PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(workspace,'pycache')});
const env=require(path.join(workspace,'scripts/env-loader')),model=fixture.cases[0].paper.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations[0].identity.model;
test.mock.method(env,'loadProjectEnv',()=>{const v={PAPER_ANALYZER_MODEL:model.model,PAPER_ANALYZER_ENDPOINT:model.endpoint,PAPER_ANALYZER_API_KEY:'unused-test-no-network',PAPER_ANALYZER_SECONDARY_MODEL:model.model,PAPER_ANALYZER_SECONDARY_ENDPOINT:model.endpoint,PAPER_ANALYZER_SECONDARY_API_KEY:'unused-test-no-network',PAPER_ANALYZER_FALLBACK_API_KEYS:'',PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS:'',HTTPS_PROXY:'http://127.0.0.1:9',HTTP_PROXY:'http://127.0.0.1:9',PD_API_READER_REPAIR_MAX_TOKENS:'16000'};Object.assign(process.env,v);return v;});
const noNetwork=()=>{throw Error('PORTABLE_COLD_NETWORK_FORBIDDEN');};
for(const[n,methods]of [['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]])for(const k of methods)test.mock.method(require('node:'+n),k,noNetwork);global.fetch=noNetwork;
require(path.join(workspace,'scripts/workspace-role')).writeWorkspaceRole('daily',{root:workspace});
const Config=require(path.join(workspace,'scripts/config')),daily=require(path.join(workspace,'scripts/lib/daily-fresh-source-plan')),fresh=require(path.join(workspace,'scripts/lib/fresh-analysis-context')),stop=require(path.join(workspace,'scripts/lib/analysis-stop-control')),ordinal=require(path.join(workspace,'scripts/lib/reader-target-ordinal-patch')),engine=require(path.join(workspace,'scripts/analysis-engine')),deep=require(path.join(workspace,'scripts/deep-analyzer'));
const runtime=path.join(workspace,'data/runtime'),run=JSON.parse(Buffer.from(fixture.runManifest.rawBase64,'base64')),runDir=path.join(runtime,'daily-fresh-source-runs',run.runId);
Config.FILES.dailyFreshSourceRunsDir=path.dirname(runDir);Config.FILES.llmUsageDir=path.join(runtime,'llm-usage');
const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});};
const originalRoot=fixture.runManifest.originalPath.slice(0,fixture.runManifest.originalPath.indexOf('/data/runtime/'));
const relocate=s=>s.startsWith(originalRoot+'/data/runtime/')?path.join(runtime,s.slice((originalRoot+'/data/runtime/').length)):s;
const bytesOf=r=>{const b=Buffer.from(r.rawBase64,'base64');assert.equal(sha(b),r.sha256);return b;};
write(path.join(runDir,'run.json'),bytesOf(fixture.runManifest));
const cases=[];
for(const c of fixture.cases){
 const paper=clone(c.paper);for(const[name,r]of Object.entries(c.sourceFiles))write(path.join(runDir,'sources',c.paperId,'generation-000001',name),bytesOf(r));
 for(const r of c.files)write(relocate(r.originalPath),bytesOf(r));
 // Only filesystem locators in seal/completion test copies are relocated.
 // Original paid requests, ACKs, compilations, witnesses, sources and usage
 // records remain their exact original bytes; no paid content is re-signed.
 for(const record of paper.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations){
  const sealFile=path.join(runDir,'reader-attempts/request-diagnostics',record.requestId+'.ordinal-seal.json'),seal=JSON.parse(fs.readFileSync(sealFile));
  seal.requestDirectory=relocate(seal.requestDirectory);for(const r of seal.usageRecords)r.file=relocate(r.file);for(const r of seal.witnesses)r.path=relocate(r.path);
  write(sealFile,JSON.stringify(seal)+'\n');record.pins.sealSha256=sha(fs.readFileSync(sealFile));
 }
 const completion=JSON.parse(bytesOf(c.completion));completion.records=clone(paper.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations);completion.stage.ordinalPatchCompilations=clone(completion.records);
 const completionFile=relocate(c.completion.originalPath);write(completionFile,JSON.stringify(completion)+'\n');paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof={path:completionFile,sha256:sha(fs.readFileSync(completionFile))};
 assert.equal(paper.apiReaderArticle,c.paper.apiReaderArticle);assert.deepEqual(paper.apiReaderPlan,c.paper.apiReaderPlan);
 cases.push({c,paper,completionFile,sourceDir:path.join(runDir,'sources',c.paperId,'generation-000001')});
}
const plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir}));
test.after(()=>{for(const r of originalRefs)assert.equal(sha(fs.readFileSync(r.file)),r.sha256);fs.rmSync(workspace,{recursive:true,force:true});});
test('real fixture has no credential/auth/account fingerprint fields or model image pixels',()=>{
 const findings=[];function walk(v,p){if(Array.isArray(v))return v.forEach((x,i)=>walk(x,p+'/'+i));if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){if(/^(?:api[_-]?key(?:sha256|fingerprint)?|authorization|proxy-authorization|credential(?:hash|sha256|fingerprint|id)?|keyFingerprint|account(?:id|hash|sha256|fingerprint|identity|poolid)|password|secret|accessToken|refreshToken)$/i.test(k))findings.push(p+'/'+k);walk(x,p+'/'+k);}else if(typeof v==='string'&&(/\bBearer\s+[A-Za-z0-9._-]{16,}/.test(v)||/\bsk-[A-Za-z0-9_-]{20,}/.test(v)||/data:image\/[^;]+;base64,/.test(v)))findings.push(p);}
 for(const c of fixture.cases){walk(c.paper,c.paperId);for(const r of[c.completion,...Object.values(c.sourceFiles),...c.files])if(r.originalPath.endsWith('.json'))walk(JSON.parse(bytesOf(r)),r.originalPath);}
 assert.deepEqual(findings,[]);
});
for(const f of cases)test('actual paid '+f.c.paperId+' completion and engine Reader diagnostics work without fresh ALS',()=>stop.withModelRequestsForbidden(()=>{
 assert.equal(fresh.getFreshAnalysisContext(),null);const before=JSON.stringify(f.paper);assert.equal(ordinal.validateCompletion(f.paper),true);assert.deepEqual(engine.getApiReaderV3RecordDiagnostics(f.paper),[]);assert.equal(fresh.getFreshAnalysisContext(),null);assert.equal(JSON.stringify(f.paper),before);
}));
test('actual 35497 inside/outside fresh ALS retains identical article, plan and complete-analysis qualification',()=>stop.withModelRequestsForbidden(async()=>{
 const p=cases[0].paper,before=JSON.stringify(p);
 // The portable bundle contains three real papers, not the entire current
 // production batch. Supply the normal authenticated scientific source bridge
 // instead of fabricating an 80-paper current file. Fresh ALS remains absent;
 // ordinal completion still has to establish its own verified daily scope.
 await daily.withDailyFreshPaperSource(plan,p,()=>{
 assert.equal(fresh.getFreshAnalysisContext(),null);
 {
  const filename=path.join(workspace,'scripts/lib/reader-target-ordinal-patch.js'),Module=require('node:module'),old=new Module(filename,module);old.filename=filename;old.paths=Module._nodeModulePaths(path.dirname(filename));
  const bytes=Buffer.from(fixture.previousPublicImplementation.rawBase64,'base64');assert.equal(sha(bytes),fixture.previousPublicImplementation.sha256);assert.equal(sha(bytes),'3b5d4ee3228a146e1634c712f340c39e0fdaf94c5b1d69e98371c696a3691d66');old._compile(bytes.toString('utf8'),filename);
  assert.throws(()=>old.exports.validateCompletion(p),/cold compiler\/parser\/final display differs/);
 }
 const reason=engine.getIncompleteAnalysisContentReason(p);assert.equal(reason,null,reason);assert.equal(engine.isSuccessfulAnalysisRecord(p),true);
 daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(p,()=>{assert.equal(ordinal.validateCompletion(p),true);assert.deepEqual(engine.getApiReaderV3RecordDiagnostics(p),[]);}));
 assert.equal(JSON.stringify(p),before);assert.equal(fresh.getFreshAnalysisContext(),null);
 });
}));
test('actual publication FD3 CLI cold path passes and stripped completion markers remain rejected',async()=>{
 const f=cases[0],p=f.paper,sourceText=fs.readFileSync(path.join(f.sourceDir,'source.txt'),'utf8'),helper=require(path.join(ROOT,'tests/helpers/run-publication-cli-in-process.cjs')),cli=path.join(workspace,'scripts/lib/reader-resource-claims-replay-cli.js');
 const call=paper=>stop.withModelRequestsForbidden(()=>helper.runPublicationCliInProcess({sourceFile:cli,canonicalFilename:cli,input:{paper,sourceText},temporaryDirectory:workspace}));
 const result=await call(p);assert.equal(result.actualCliSourceExecuted,true);assert.equal(result.noChildProcess,true);assert.equal(result.exitCode,0,result.raw);assert.deepEqual(result.result,{verified:true});
 const stripped=clone(p);delete stripped.analysisManifest.contracts.readerTargetOrdinalPatch;for(const k of ['ordinalPatchContract','ordinalPatchCompilations','ordinalCompletionProof'])delete stripped.analysisManifest.stages.apiReaderArticle[k];
 const rejected=await call(stripped);assert.equal(rejected.exitCode,1);assert.equal(rejected.result.verified,false);assert.match(rejected.result.message,/marker removed/);
});
test('real source TXT/PDF/runtime/manifest mutations cannot acquire cold scope',()=>{
 const f=cases[0];for(const name of ['source.txt','source.pdf','source-runtime.json','source-manifest.json']){const file=path.join(f.sourceDir,name),original=fs.readFileSync(file);try{fs.appendFileSync(file,'\n');assert.throws(()=>ordinal.validateCompletion(f.paper));}finally{fs.writeFileSync(file,original);}}
});
test('saved cells, DOM, PDF evidence and fake copied table objects retain strict ownership',()=>stop.withModelRequestsForbidden(()=>{
 const f=cases[0];for(const mutate of [p=>p.apiReaderPlan.tableBindings[1].cellBindings[0].sourceText+=' wrong',p=>p.apiReaderPlan.tableBindings[1].sourceTableDomSha256='0'.repeat(64),p=>p.apiReaderPlan.tableBindings[1].sealedPdfTableEvidence.pdfSha256='0'.repeat(64),p=>p.apiReaderPlan.tableBindings[1].sealedPdfTableEvidence.displayMatrix[1][1]='123']){const changed=clone(f.paper);mutate(changed);assert.throws(()=>ordinal.validateCompletion(changed));}
 daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(f.paper,()=>{const source=daily.readDailyFreshSource(plan,f.paper),tables=require(path.join(workspace,'scripts/lib/reader-table-pdf-evidence'));tables.withArtifacts(source.structuredArtifacts,f.paper.arxivId,()=>{const table=source.structuredArtifacts.tables.find(t=>t.ordinal===3);assert.ok(tables.sealedEvidence(table));assert.equal(tables.sealedEvidence(clone(table)),null);assert.deepEqual(tables.bindingEvidence(clone(table)),{});});}));
}));
test('removed stable index, changed marker, wrong ACK and changed immutable proof remain rejected',()=>{
 const f=cases[0],p=f.paper,completion=fs.readFileSync(f.completionFile);try{fs.unlinkSync(f.completionFile);assert.throws(()=>ordinal.validateCompletion(p));}finally{fs.writeFileSync(f.completionFile,completion,{mode:0o600});}
 const marker=clone(p);marker.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof.sha256='0'.repeat(64);assert.throws(()=>ordinal.validateCompletion(marker));
 const rec=p.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations[0],file=path.join(runDir,'reader-attempts/request-diagnostics',rec.requestId+'.response.json'),original=fs.readFileSync(file);try{const r=JSON.parse(original),ack=JSON.parse(r.rawResponse);ack.requestToken='0'.repeat(16);r.rawResponse=JSON.stringify(ack);fs.writeFileSync(file,JSON.stringify(r));assert.throws(()=>ordinal.validateCompletion(p));}finally{fs.writeFileSync(file,original);}
});
test('exit guard detects mutation of real source or paper during otherwise successful cold replay',()=>stop.withModelRequestsForbidden(()=>{
 const f=cases[0],original=deep.replayApiReaderFinalDisplay;
 for(const kind of ['paper','source']){const p=clone(f.paper),file=path.join(f.sourceDir,'source.txt'),source=fs.readFileSync(file);test.mock.method(deep,'replayApiReaderFinalDisplay',(...args)=>{const value=original(...args);if(kind==='paper')p.title+=' changed during replay';else fs.appendFileSync(file,'\n');return value;});try{assert.throws(()=>ordinal.validateCompletion(p));}finally{test.mock.restoreAll();fs.writeFileSync(file,source);}}
}));
