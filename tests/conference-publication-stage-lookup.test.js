'use strict';
// Portable orchestration tests only. The canonical stage loader is an explicit
// double here; real source/stage qualification is covered by separate evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const filename=path.resolve(__dirname,'../scripts/lib/conference-publication-figure-crop.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const order=x=>Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;
function setup(t){
 const directory=fs.mkdtempSync(path.join(__dirname,'.stage-lookup-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const body={status:'complete',paperId:'conference:test:paper',analysisExecutionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',pagePath:'content/a.md',contentSha256:'c'.repeat(64)};
 const manifest={...body,manifestSha256:hash(JSON.stringify(order(body)))},bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'manifest.json'),bytes);
 const context={executionId:body.analysisExecutionId,paperId:body.paperId,pageProof:{manifestSha256:manifest.manifestSha256,contentSha256:body.contentSha256,pagePath:body.pagePath}};
 let calls=0;const canonical={loadPreservedStage(input){calls++;assert.equal(input.stagingRoot,directory);assert.equal(input.repair,false);assert.equal(input.executionId,context.executionId);assert.equal(input.paperId,context.paperId);assert.equal(JSON.stringify(input.pageProof),JSON.stringify(context.pageProof));return{directory,manifestFileSha256:hash(bytes)};}};
 const nativeRequire=createRequire(filename),sandbox={require:n=>n==='./conference-postprocess'?canonical:nativeRequire(n),__filename:filename,__dirname:path.dirname(filename),Buffer,module:{exports:{}},structuredClone};
 vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.lookup=findStageBySha;',sandbox,{filename});
 return{directory,manifest,bytes,context,lookup:sandbox.module.exports.lookup,calls:()=>calls};
}
test('lookup delegates exact execution and complete original pageProof to canonical read-only loader',t=>{const f=setup(t);const r=f.lookup(f.directory,f.manifest.manifestSha256,new Map(),f.context);assert.equal(r.sha256,hash(f.bytes));assert.equal(f.calls(),1);});
test('same-context cache still re-reads physical manifest and does not scan asset trees',t=>{const f=setup(t),cache=new Map();fs.mkdirSync(path.join(f.directory,'unrelated-assets/deep/deeper/too/deep/to/recurse'),{recursive:true});f.lookup(f.directory,f.manifest.manifestSha256,cache,f.context);f.lookup(f.directory,f.manifest.manifestSha256,cache,f.context);assert.equal(f.calls(),1);fs.appendFileSync(path.join(f.directory,'manifest.json'),' ');assert.throws(()=>f.lookup(f.directory,f.manifest.manifestSha256,cache,f.context),/实物改变/);});
test('wrong wanted SHA and free execution path fail before canonical loader',t=>{const f=setup(t);for(const[wanted,ctx]of[['0'.repeat(64),f.context],[f.manifest.manifestSha256,{...f.context,executionId:'../../other'}]])assert.throws(()=>f.lookup(f.directory,wanted,new Map(),ctx),/证明不一致/);assert.equal(f.calls(),0);});
test('cached result cannot substitute a changed owner execution or full pageProof',t=>{const f=setup(t),cache=new Map();f.lookup(f.directory,f.manifest.manifestSha256,cache,f.context);for(const patch of [{paperId:'conference:other:paper'},{executionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{pageProof:{...f.context.pageProof,contentSha256:'e'.repeat(64)}}])assert.throws(()=>f.lookup(f.directory,f.manifest.manifestSha256,cache,{...f.context,...patch}));assert.equal(f.calls(),4);});
