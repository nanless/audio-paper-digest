'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),Module=require('node:module');
const filename=path.resolve(__dirname,'../scripts/analysis-contract.js'),compiled=new Module(filename,module);
compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.observedAdverse={listening:sourceBoundListeningScoreRegression,duration:sourceBoundRenderedDurationShortfall};',filename);
const q=compiled.exports,fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'fixtures/experiment-observed-adverse-20261102.json.gz'))));
const mutations=require('./fixtures/experiment-observed-adverse-mutations.json');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function wrap(value,mode){return mode==='code'?'```\n'+value+'\n```':mode==='quote'?'“\n'+value+'\n”':'<blockquote>'+value+'</blockquote>';}
for(const [index,group] of ['listening','duration'].entries()){
 const f=fixture.items[index],results=q.extractSection(f.analysis,'实验结果'),run=(r=results,s=f.sourceText,t=q.extractMarkdownTables(r))=>q.observedAdverse[group](r,t,s);
 test(`${group}: 真实来源绑定上游稿有负面结果，不能冒称未保存结构末稿`,()=>{
  assert.equal(f.notStructureRepairRawResponse,true);assert.equal(f.checkpointName,'analysisCheckpoint');
  assert.equal(sha(f.analysis),f.analysisSha256);assert.equal(sha(f.sourceText),f.sourceFiles['source.txt']);
  assert.equal(f.analysisSha256,index===0?'e44660460d3c259f915fb7168bfa47a709e5615d2db4ac6ab61b512efbacfa49':'a7ec0be00a4c7aa94468173bee3184741b49f5bd0c5a4bf65679eb3db144819c');
  assert.match(f.stageFailure,/没有保留负面证据/);const before=JSON.stringify(f);assert.equal(run(),true);assert.equal(JSON.stringify(f),before);
  const issue=q.validateExperimentTableEvidenceDepth(f.analysis,{sourceText:f.sourceText});
  // The full official TAPE source independently triggers the existing ablation
  // gate. Recognizing this adverse outcome never grants whole-paper completion.
  if(index===0)assert.match(issue,/没有保留关键消融/);else assert.equal(issue,null);
 });
 for(const mutation of mutations[group])test(`${group}: ${mutation.name}不提供负面证据`,()=>{
  let r=results,s=f.sourceText,t;
  if(['source','results'].includes(mutation.target)){
   const value=mutation.target==='source'?s:r;assert.ok(value.includes(mutation.old),mutation.name);
   if(mutation.target==='source')s=value.replaceAll(mutation.old,mutation.new);else r=value.replaceAll(mutation.old,mutation.new);
  }else if(mutation.target==='emptySource')s='';
  else if(mutation.target==='noTables')t=[];
  else if(mutation.target==='resultPrefix'){assert.ok(r.includes(mutation.marker));r=r.replace(mutation.marker,mutation.new+mutation.marker);}
  else if(mutation.target==='sourcePrefix'){assert.ok(s.includes(mutation.marker));s=s.replace(mutation.marker,mutation.new+mutation.marker);}
  else if(mutation.target==='resultWrap')r=wrap(r,mutation.new);
  else if(mutation.target==='sourceWrap')s=wrap(s,mutation.new);
  assert.equal(run(r,s,t??q.extractMarkdownTables(r)),false);
 });
}
