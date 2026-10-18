'use strict';
// Isolated byte/CAS orchestration tests, never scientific/source eligibility.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const root=process.cwd(),formal=path.join(root,'scripts/lib/conference-reader-review-maintenance.js');
function harness(t,size=1024){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'maintenance-byte-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const id='77777777-7777-4777-8777-777777777777',child=path.join(directory,id);fs.mkdirSync(child);
 const writes=(name,value)=>{const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(name,bytes,{mode:0o600});return sha(bytes);};
 const loaded={directory:child,run:{executionId:id,status:'complete'},analysis:{status:'complete'}};
 loaded.analysisFileSha256=writes(path.join(child,'analysis.json'),{body:'a'.repeat(size)});
 loaded.runFileSha256=writes(path.join(child,'run.json'),loaded.run);
 loaded.sourceFileSha256=writes(path.join(child,'source.json'),{body:'source'});
 const adopted={executionId:id,analysisFileSha256:loaded.analysisFileSha256,runFileSha256:loaded.runFileSha256,sourceFileSha256:loaded.sourceFileSha256};
 const item={analysisRunId:id,analysisProof:{analysisSha256:loaded.analysisFileSha256}};
 let loads=0,parses=0,validations=0;
 const fakeAdapter={readJsonRecord(filename){parses++;const bytes=fs.readFileSync(filename);return{value:JSON.parse(bytes),bytes,sha256:sha(bytes)};},
 loadConferenceAnalysis({executionId}){loads++;assert.equal(executionId,id);for(const name of ['analysis','run','source'])this.readJsonRecord(path.join(child,name+'.json'));return structuredClone(loaded);}};
 const m=new Module(formal,module);m.filename=formal;m.paths=Module._nodeModulePaths(path.dirname(formal));const native=m.require.bind(m);
 m.require=name=>name==='./conference-analysis-adapter'?fakeAdapter:name==='./conference-process'?{assertState(){validations++},stateDigest:require(path.join(root,'scripts/lib/conference-process.js')).stateDigest}:native(name);
 m._compile(fs.readFileSync(formal,'utf8')+'\nmodule.exports.__test={isCurrentOrVerifiedDescendant,assertCurrentBatch,privateFileSha256,registeredState,validatedMetadataRecord,metadataCache};',formal);
 return {directory,child,id,loaded,adopted,item,batch:{analysisRoot:directory},api:m.exports.__test,writes,get loads(){return loads},get parses(){return parses},get validations(){return validations}};
}
test('首次完整加载，后续仍逐字节SHA核三文件与state proof；改变同size内容仍拒',t=>{
 const h=harness(t);assert.equal(h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted),true);assert.equal(h.loads,1);
 for(let i=0;i<3;i++)assert.equal(h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted),true);
 assert.equal(h.loads,1);assert.throws(()=>h.api.isCurrentOrVerifiedDescendant(h.batch,{...h.item,analysisProof:{analysisSha256:'0'.repeat(64)}},h.adopted),/current pointer/);
 for(const name of ['analysis','run','source']){const file=path.join(h.child,name+'.json'),before=fs.readFileSync(file),st=fs.statSync(file);const changed=Buffer.from(before);changed[changed.length-2]^=1;fs.writeFileSync(file,changed);fs.utimesSync(file,st.atime,st.mtime);
 assert.equal(h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted),false);fs.writeFileSync(file,before);}
 assert.equal(h.loads,1);
 const other={...h.adopted,executionId:'88888888-8888-4888-8888-888888888888'};
 assert.equal(h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,other),false);assert.equal(h.loads,2);
 // A new immutable batch has not inherited another batch's full-parse pin.
 assert.equal(h.api.isCurrentOrVerifiedDescendant({...h.batch},h.item,h.adopted),true);assert.equal(h.loads,3);
});
test('快速字节路径保留私有mode/单链接/无symlink/64MiB及读取中pathname CAS',t=>{
 const h=harness(t),file=path.join(h.child,'source.json');h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted);
 fs.chmodSync(file,0o644);assert.throws(()=>h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted),/private/);fs.chmodSync(file,0o600);
 const linked=path.join(h.directory,'link');fs.linkSync(file,linked);assert.throws(()=>h.api.privateFileSha256(file),/single-link/);fs.unlinkSync(linked);
 fs.renameSync(file,linked);fs.symlinkSync(linked,file);assert.throws(()=>h.api.privateFileSha256(file),/symlink/);fs.unlinkSync(file);fs.renameSync(linked,file);
 const large=path.join(h.directory,'oversize');fs.writeFileSync(large,'',{mode:0o600});fs.truncateSync(large,64*1024*1024+1);assert.throws(()=>h.api.privateFileSha256(large),/bounded/);
 const original=fs.readFileSync;let replace=true;fs.readFileSync=function(name,...args){const bytes=original.call(this,name,...args);if(typeof name==='number'&&replace){replace=false;fs.renameSync(file,linked);fs.writeFileSync(file,bytes,{mode:0o600});}return bytes;};
 try{assert.throws(()=>h.api.privateFileSha256(file),/changed while reading/);}finally{fs.readFileSync=original;}
});
test('immutable文件仅hash重读、state仍parse；内容改变/权限漂移均拒',t=>{
 const h=harness(t),batchRoot=path.join(h.directory,'batch');fs.mkdirSync(batchRoot);fs.mkdirSync(path.join(batchRoot,'failures'));fs.mkdirSync(path.join(batchRoot,'classifications'));
 const stateFile=path.join(h.directory,'state.json'),stateSHA=h.writes(stateFile,{status:'synthetic-only'}),f='a'.repeat(64),c='b'.repeat(64);
 const failureSHA=h.writes(path.join(batchRoot,'failures',f+'.json'),{failure:'synthetic'}),classificationSHA=h.writes(path.join(batchRoot,'classifications',c+'.json'),{kind:'synthetic'});
 const b={p:{root:batchRoot,manifest:path.join(batchRoot,'manifest.json'),state:stateFile},manifestFileSha256:h.writes(path.join(batchRoot,'manifest.json'),{manifest:1}),
 baseline:{sha256:stateSHA},m:{members:[{failureSha256:f,failureFileSha256:failureSHA}],imageClassifications:[{classificationSha256:c,classificationFileSha256:classificationSHA,failureSha256:f,failureFileSha256:failureSHA}]}};
 h.writes(path.join(batchRoot,'baseline-state.json'),{status:'synthetic-only'});b.m.generationFileSha256=h.writes(path.join(batchRoot,'generation.json'),{generation:1});b.m.reviewBatchFileSha256=h.writes(path.join(batchRoot,'review-batch.json'),{review:1});
 const before=h.parses;h.api.assertCurrentBatch(b);assert.equal(h.parses-before,1);
 for(const file of [b.p.manifest,path.join(batchRoot,'baseline-state.json'),path.join(batchRoot,'generation.json'),path.join(batchRoot,'review-batch.json'),path.join(batchRoot,'failures',f+'.json'),path.join(batchRoot,'classifications',c+'.json')]){
 const bytes=fs.readFileSync(file);fs.appendFileSync(file,' ');assert.throws(()=>h.api.assertCurrentBatch(b),/immutable/);fs.writeFileSync(file,bytes);
 fs.chmodSync(file,0o644);assert.throws(()=>h.api.assertCurrentBatch(b),/private/);fs.chmodSync(file,0o600);
 }
});
test('小fixture性能：重复核验减少parse，不删任何字节读取或hash',t=>{
 const h=harness(t,2*1024*1024),rounds=20;
 let start=performance.now();for(let i=0;i<rounds;i++)h.api.isCurrentOrVerifiedDescendant({...h.batch},h.item,h.adopted);const cold=performance.now()-start,coldLoads=h.loads;
 start=performance.now();for(let i=0;i<rounds;i++)h.api.isCurrentOrVerifiedDescendant(h.batch,h.item,h.adopted);const warm=performance.now()-start;
 assert.equal(coldLoads,rounds);assert.equal(h.loads-coldLoads,1);
 console.log(JSON.stringify({fixtureOnly:true,bytes:2*1024*1024,rounds,fullParseMs:cold,repeatedByteHashMs:warm,fullLoads:coldLoads,repeatedLoads:h.loads-coldLoads}));
});
test('metadata每次全bytes核SHA，同字节跳解析，变字节重验且失败不缓存；返回不可污染',t=>{
 const h=harness(t),file=path.join(h.directory,'metadata.json'),b={m:{batchId:'synthetic'},baseline:{value:{generation:1},sha256:'a'.repeat(64)},manifestFileSha256:'b'.repeat(64)};
 h.writes(file,{generation:1});let validations=0;const validate=v=>{validations++;assert.equal(v.generation,1)};
 const first=h.api.validatedMetadataRecord(b,'state',file,validate);assert.equal(validations,1);assert.equal(h.api.validatedMetadataRecord(b,'state',file,validate),first);assert.equal(validations,1);
 assert.throws(()=>{first.value.generation=2},TypeError);assert.throws(()=>{b.m.batchId='changed'},TypeError);assert.throws(()=>{b.baseline.value.generation=2},TypeError);
 const before=fs.readFileSync(file),st=fs.statSync(file);h.writes(file,{generation:2});fs.utimesSync(file,st.atime,st.mtime);
 assert.throws(()=>h.api.validatedMetadataRecord(b,'state',file,validate));assert.equal(validations,2);
 assert.throws(()=>h.api.validatedMetadataRecord(b,'state',file,validate));assert.equal(validations,3);fs.writeFileSync(file,before);
 assert.equal(h.api.validatedMetadataRecord(b,'state',file,validate),first);
 b.m={batchId:'synthetic'};h.api.validatedMetadataRecord(b,'state',file,validate);assert.equal(validations,4);
 b.baseline.sha256='c'.repeat(64);h.api.validatedMetadataRecord(b,'state',file,validate);assert.equal(validations,5);
 const independent={...b};h.api.validatedMetadataRecord(independent,'state',file,validate);assert.equal(validations,6);
 for(const slot of ['state','after','adoption'])h.api.validatedMetadataRecord(b,slot,file,()=>{});
 assert.equal(h.api.metadataCache(b).records.size,3);assert.throws(()=>h.api.validatedMetadataRecord(b,'arbitrary',file,()=>{}),/fixed/);
});
test('registeredState完整关系首次校验，重复免clone/digest；各物理记录漂移仍拒',t=>{
 const h=harness(t),batchRoot=path.join(h.directory,'registered');fs.mkdirSync(batchRoot);
 const api=require(path.join(root,'scripts/lib/conference-process.js'));
 const baseline={generation:1,updatedAt:'2026-10-19T00:00:00.000Z',items:{paper:{analysis:'synthetic'}}};baseline.stateSha256=api.stateDigest(baseline);
 const batch={p:{root:batchRoot},m:{batchId:h.id,manifestSha256:'a'.repeat(64)},manifestFileSha256:'b'.repeat(64),baseline:{value:baseline,sha256:'c'.repeat(64)}};
 const value=structuredClone(baseline);value.readerReviewMaintenanceObligations=[{batchId:h.id,manifestSha256:batch.m.manifestSha256,manifestFileSha256:batch.manifestFileSha256}];value.generation++;value.stateSha256=api.stateDigest(value);
 const sf=path.join(batchRoot,'registered-state.json'),rf=path.join(batchRoot,'registration.json'),ss=h.writes(sf,value);
 const registration={contract:'conference-reader-review-maintenance-registration-v1',manifestSha256:batch.m.manifestSha256,manifestFileSha256:batch.manifestFileSha256,baselineStateFileSha256:batch.baseline.sha256,registeredStateFileSha256:ss};registration.registrationSha256=api.stableHash(registration);h.writes(rf,registration);
 const first=h.api.registeredState(batch),parses=h.parses,checks=h.validations;h.api.registeredState(batch);assert.equal(h.parses,parses);assert.equal(h.validations,checks);assert.throws(()=>{first.value.items.paper.analysis='bad'},TypeError);
 for(const file of [sf,rf]){const bytes=fs.readFileSync(file);fs.appendFileSync(file,' ');if(file===sf)assert.throws(()=>h.api.registeredState(batch),/CAS|SHA|history/);else{const count=h.parses;h.api.registeredState(batch);assert.ok(h.parses>count);}fs.writeFileSync(file,bytes);fs.chmodSync(file,0o644);assert.throws(()=>h.api.registeredState(batch),/private/);fs.chmodSync(file,0o600);}
 assert.throws(()=>h.api.registeredState({...batch,baseline:{...batch.baseline,sha256:'d'.repeat(64)}}),/CAS/);
 fs.unlinkSync(rf);assert.throws(()=>h.api.registeredState(batch),/ENOENT/);
});
