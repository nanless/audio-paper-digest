'use strict';
// Protocol-only fixtures: no canonical source, model, network or runtime writes.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const filename=path.resolve(__dirname,'../scripts/lib/reader-resource-claims-replay-cli.js');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function replay(extra={},coreIssue=null) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'publication-cli-protocol-'));
 const sourceText='The complete fixture source mentions no released resources.';
 const paper={sourceSha256:hash(sourceText),apiReaderPlan:{tableBindings:[]},apiReaderResources:{resources:[]},apiReaderArticle:'Fixture article'};
 const input={paper,sourceText,resourcePresentation:true,publicationReplay:true,...extra};
 const raw=Buffer.from(JSON.stringify(input));const inputFile=path.join(directory,'input.json');
 fs.writeFileSync(inputFile,raw,{mode:0o600});const fd=fs.openSync(inputFile,'r');
 const calls=[];let output='';
 const fakeProcess={env:{},argv:['node',filename,String(fd)],stdout:{write(){}},stderr:{write(){}},exitCode:0};
 const realFs={...fs,writeSync(target,value){assert.equal(target,1);output+=value;return Buffer.byteLength(value);}};
 const modules={
  'node:fs':realFs,'node:crypto':crypto,'node:util':require('node:util'),
  'node:net':{Socket:function(){}},'node:tls':{},'node:http':{},'node:https':{},'node:http2':{},
  '../env-loader':{requireExternalRuntime(){calls.push('runtime');}},
  './conference-source-resource-correction':{isSourceCorrectionRecord(){return false;},
   async withSavedPublicationPaper(value,callback){calls.push('actual-source-scope-fixture');return callback(value);}},
  '../deep-analyzer':{readerResourceClaimDraftFromArticle(){return {};},assertReaderResultTableSemantics(){calls.push('table-semantics');},
   enforceReaderResourceClaims(){calls.push('resource-claims');},readerResourcePublicationResources(){calls.push('resources');return [];}},
  '../analysis-contract':{validateCoreSummaryStageBinding(value,options){assert.equal(JSON.stringify(value),JSON.stringify(paper));assert.equal(options.sourceText,sourceText);calls.push('normal-core-stage');return coreIssue;}}
 };
 try {
  await vm.runInNewContext(fs.readFileSync(filename,'utf8'),{process:fakeProcess,require(name){
   if(!Object.hasOwn(modules,name))throw new Error('Unexpected fixture dependency '+name);return modules[name];},Buffer,console},{filename});
  return {response:JSON.parse(output),calls,exitCode:fakeProcess.exitCode,inputSha256:hash(raw)};
 } finally {fs.closeSync(fd);fs.rmSync(directory,{recursive:true,force:true});}
}
test('严格同次出版模式沿原正常表语义、资源与核心函数一次返回绑定真实输入的结果',async()=>{
 const result=await replay();assert.equal(result.exitCode,0,JSON.stringify(result.response));assert.equal(result.response.verified,true);
 assert.equal(result.response.coreSummaryIssue,null);assert.deepEqual(result.response.resources,[]);
 assert.deepEqual(result.response.publicationReplay,{contract:'publication-one-invocation-source-replay-v1',inputSha256:result.inputSha256});
 assert.deepEqual(result.calls,['runtime','actual-source-scope-fixture','table-semantics','resource-claims','resources','normal-core-stage']);
});
test('真实正常核心失败仍拒绝，不从已完成声明或自报JSON产生出版证明',async()=>{
 const result=await replay({},'fixture core failure');assert.equal(result.exitCode,1);assert.equal(result.response.verified,false);
 assert.equal(result.response.publicationReplay,undefined);assert.equal(result.calls.filter(x=>x==='normal-core-stage').length,1);
});
test('错型、额外资格字段与假结果不能进入新模式；旧只读模式不增加核心调用',async()=>{
 for(const extra of [{publicationReplay:false},{publicationReplay:'true'},{verified:true},{proof:{verified:true}},{resourcePresentation:false}]) {
  const result=await replay(extra);assert.equal(result.exitCode,1);assert.equal(result.response.verified,false);
  assert.deepEqual(result.calls,['runtime']);
 }
 const result=await replay({publicationReplay:undefined});assert.equal(result.exitCode,0);
 assert.equal(result.response.publicationReplay,undefined);assert.equal(result.calls.includes('normal-core-stage'),false);
});
