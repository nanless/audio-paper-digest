'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto'),Module=require('node:module');
const ROOT=path.resolve(__dirname,'..'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'final-loss-switch-trigger-'));
require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(temp);
require(path.join(ROOT,'scripts/env-loader')).loadProjectEnv=()=>({});
const fixtureBytes=fs.readFileSync(path.join(__dirname,'fixtures/structure-final-replay-32310-latest.real.json.gz')),fixture=JSON.parse(zlib.gunzipSync(fixtureBytes));
const decode=row=>{const bytes=Buffer.from(row.rawBase64,'base64');assert.equal(hash(bytes),row.sha256);return bytes;};
const paper=JSON.parse(decode(fixture.paper)),main=decode(fixture.latestMain).toString('utf8'),source=decode(fixture.sourceFiles.find(row=>row.file.endsWith('/source.txt'))).toString('utf8');
const filename=path.join(ROOT,'scripts/analysis-contract.js');
function compile(raw){const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m._compile(raw+'\nmodule.exports.testOriginalSource=coreSummaryBoundMethodSource;module.exports.testSetSource=fn=>{coreSummaryBoundMethodSource=fn;};',filename);return m;}
const currentImplementation=fs.readFileSync(filename,'utf8');
const previousImplementation=currentImplementation.replace('(?:损失|loss|波形损失归一化|损失归一化|waveform[- ]loss normalization|语谱图辅助损失|auxiliary spectrogram loss)”缺少','(?:损失|loss)”缺少');
assert.notEqual(previousImplementation,currentImplementation,'Source-loader trigger regression anchor differs');
const before=compile(previousImplementation),after=compile(currentImplementation);
require.cache[filename]=after;after.loaded=true;
const api=after.exports,old=before.exports,utils=require(path.join(ROOT,'scripts/utils')),stop=require(path.join(ROOT,'scripts/lib/analysis-stop-control'));
const parsed=utils.parseAnalysis(main),options={paper,enforceExperimentTableContract:true,experimentTableContractVersion:paper.analysisManifest.contracts.experimentTables,enforceMethodDetailContract:true};
const safe=fn=>()=>stop.withModelRequestsForbidden(fn);
const table=api.extractMarkdownTables(api.extractSection(main,'实验结果'))[0];
const render=t=>'| '+t.header.join(' | ')+' |\n| '+t.header.map(()=> '---').join(' | ')+' |\n'+t.rows.map(row=>'| '+row.join(' | ')+' |').join('\n');
function withSource(text,fn){const original=api.testOriginalSource;let calls=0;api.testSetSource(p=>{assert.equal(p,paper);calls++;return text;});
 try{return{result:fn(),calls};}finally{api.testSetSource(original);}}
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));

test('real latest 8334-character scored main and new accepted paid Reader are distinct from old845f ancestor',safe(()=>{
 assert.equal(hash(fixtureBytes),'bdec70a6503d2d37167706dd0955b8626fcc6870610f06570ec7e8c17e331da8');
 assert.equal(main.length,8334);assert.equal(hash(main),'4fe4f89abf1ce37259373e96bd0821a6f910e6de0fae78f500bc1cb6e4897cb7');
 assert.equal(hash(main),paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256);
 assert.equal(hash(decode(fixture.readerArticle)),paper.analysisManifest.stages.apiReaderArticle.articleSha256);
 assert.equal(paper.analysisManifest.stages.apiReaderArticle.status,'complete');assert.equal(paper.analysisManifest.stages.apiReaderArticle.attempts,1);
 const q=JSON.parse(decode(fixture.paidRequest)),r=JSON.parse(decode(fixture.paidResponse));
 assert.equal(q.id,'ef3a6da0-914c-4309-9c84-1cc86d3c00ad');assert.equal(r.requestSha256,fixture.paidRequest.sha256);assert.equal(hash(r.rawResponse),r.outputTextSha256);
 const events=fixture.paidFees.map(row=>JSON.parse(decode(row)));assert.equal(events.find(e=>e.kind==='request').usage.totalTokens,34169);
 assert.equal(paper.analysis,null);assert.equal(paper.analysisCheckpoint,undefined);assert.equal(table.rows.length,8);assert.equal(table.header.length,4);
}));

test('final getInvalid parameters omit sourceText; source-loader invocation regression replays only the existing full matrix family',safe(()=>{
 let oldCalls=0;old.testSetSource(()=>{oldCalls++;return source;});
 assert.match(old.getInvalidAnalysisReason(main,parsed,options),/波形损失归一化.*↑\/↓/u);assert.equal(oldCalls,0);
 const snapshot=JSON.stringify(paper),result=withSource(source,()=>api.getInvalidAnalysisReason(main,parsed,options));
 assert.equal(Object.hasOwn(options,'sourceText'),false);assert.equal(result.calls,1);assert.equal(result.result,null);assert.equal(JSON.stringify(paper),snapshot);
}));

test('synthetic metric aliases and numeric cells retain direction; changed row vectors or missing rows cannot become controls',safe(()=>{
 for(const name of ['准确率','波形损失归一化准确率']){
  const changed=main.replace('波形损失归一化 |',name+' |');assert.notEqual(changed,main);
  const result=withSource(source,()=>api.getInvalidAnalysisReason(changed,utils.parseAnalysis(changed),options));
  assert.match(result.result,/缺少 ↑\/↓ 方向/u);assert.equal(result.calls,0);
 }
 for(const changedTable of [
  {...table,rows:table.rows.map(row=>row.map((cell,index)=>index===2?(cell==='是'?'1':'0'):cell))},
  {...table,rows:[...table.rows].reverse()},
  {...table,rows:table.rows.slice(1)},
  {...table,rows:table.rows.map((row,index)=>index===1?[row[0],row[1],row[2]==='是'?'否':'是',row[3]]:row)}]){
  const changed=main.replace(table.markdown,render(changedTable));assert.notEqual(changed,main);
  assert.match(withSource(source,()=>api.getInvalidAnalysisReason(changed,utils.parseAnalysis(changed),options)).result,/缺少 ↑\/↓ 方向/u);
 }
}));

test('synthetic source mutations preserve wrong-source/conditional/foreign/negated matrix rejection',safe(()=>{
 const claim=/^To isolate the contributions[^\n]+$/mu.exec(source)[0];
 for(const changedSource of ['',source.replace('UC-N\n–\n✓\n–','UC-N\n–\n–\n–'),
  source.replace(claim,'If '+claim),source.replace(claim,'Previous work.\n'+claim),
  source.replace(claim,claim+' We did not actually train or evaluate these variants.'),
  source.replace(claim,claim+' This was only hypothetical.')]){
  assert.match(withSource(changedSource,()=>api.getInvalidAnalysisReason(main,parsed,options)).result,/缺少 ↑\/↓ 方向/u);
 }
}));

test('existing supported loss-normalization alias uses same matrix; supplied-source checks remain strict',safe(()=>{
 const alias=main.replace('波形损失归一化 |','损失归一化 |');assert.notEqual(alias,main);
 assert.equal(withSource(source,()=>api.getInvalidAnalysisReason(alias,utils.parseAnalysis(alias),options)).result,null);
 assert.equal(api.getInvalidAnalysisReason(main,parsed,{...options,sourceText:source}),null);
}));

const actualAvailable=fs.existsSync(path.join(ROOT,'data/runtime/daily-fresh-source-runs/cc02fdfc-2fc5-4eff-afff-b9e149c42137/sources/2610.32310/generation-000001/source.pdf'));
test('local integration: no source option and no fresh ALS invokes unchanged actual sealed daily source replay',{skip:!actualAvailable},safe(()=>{
 assert.equal(require(path.join(ROOT,'scripts/lib/fresh-analysis-context')).getFreshAnalysisContext(),null);
 api.testSetSource(api.testOriginalSource);
 const originalFiles=[...fixture.paidFees,...fixture.sourceFiles,fixture.paidRequest,fixture.paidResponse];
 const before=new Map(originalFiles.map(row=>[row.file,hash(fs.readFileSync(row.file))]));
 assert.equal(api.getInvalidAnalysisReason(main,parsed,options),null);
 for(const[file,digest]of before)assert.equal(hash(fs.readFileSync(file)),digest);
}));
