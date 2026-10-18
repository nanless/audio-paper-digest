'use strict';
// Synthetic source-identity orchestration only; no source/Reader eligibility.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),crypto=require('node:crypto');
const root=process.cwd(),formal=path.join(root,'scripts/lib/conference-reader-review-maintenance.js');
const realAdapter=require(path.join(root,'scripts/lib/conference-analysis-adapter.js')),api=require(path.join(root,'scripts/lib/conference-process.js'));
const {sha,stable}=require(path.join(root,'scripts/lib/conference-reader-review-maintenance-evidence.js'));
function setup(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lineage-batch-cache-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const uid=()=>crypto.randomUUID(),processId=uid(),childId=uid(),parentId=uid(),paperId='synthetic-paper';
 const files={conferenceAnalysisDir:path.join(directory,'analysis'),conferenceProcessDir:path.join(directory,'processes'),conferencePublicationDir:path.join(directory,'publications')};
 const processDirectory=path.join(files.conferenceProcessDir,processId),source='synthetic sealed source';
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return sha(fs.readFileSync(file));};
 const parent={directory:path.join(files.conferenceAnalysisDir,parentId),run:{executionId:parentId},analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'ps'};
 const loaded={directory:path.join(files.conferenceAnalysisDir,childId),run:{executionId:childId,paperId,sourceSnapshotSha256:'ss'},parent,source:{sourceDetails:{text:source}},revision:{mode:'reader-only'}};
 for(const owner of [parent,loaded])for(const name of ['analysis','run','source'])write(path.join(owner.directory,name+'.json'),{synthetic:name});
 let identities=0,schemas=0;const reads=new Map(),adapter={loadConferenceReaderRevisionIdentity(){identities++;return structuredClone(loaded);},readJsonRecord(file){reads.set(file,(reads.get(file)||0)+1);return realAdapter.readJsonRecord(file);}};
 const mod=new Module(formal,module);mod.filename=formal;mod.paths=Module._nodeModulePaths(path.dirname(formal));const native=mod.require.bind(mod);
 mod.require=name=>name==='./conference-analysis-adapter'?adapter:name==='../config'?{FILES:files}:name==='./conference-process'?{assertState(){schemas++},stateDigest:api.stateDigest}:native(name);
 mod._compile(fs.readFileSync(formal,'utf8')+'\nmodule.exports.__cache=sourceLineageBatches;',formal);
 const baseline={generation:1,updatedAt:'2026-10-19T00:00:00.000Z',items:{[paperId]:{analysisRunId:parentId,analysisProof:{analysisSha256:'pa'}}}};baseline.stateSha256=api.stateDigest(baseline);write(path.join(processDirectory,'state.json'),baseline);
 function batch(){
  const batchId=uid(),batchRoot=path.join(processDirectory,'review-reader-maintenance',batchId),f='a'.repeat(64);
  const member={paperId,parentExecutionId:parentId,executionId:childId,parentCAS:{analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'ps'},sourceSnapshotSha256:'ss',sourceSha256:sha(source),failureSha256:f,failureFileSha256:write(path.join(batchRoot,'failures',f+'.json'),{synthetic:'failure'}),reviewFeedbackSha256:'f'.repeat(64)};
  const m={contract:'conference-reader-review-maintenance-batch-v1',version:1,processId,batchId,members:[member],stateFileSha256:write(path.join(batchRoot,'baseline-state.json'),baseline),baselineStateSha256:baseline.stateSha256,generationFileSha256:write(path.join(batchRoot,'generation.json'),{synthetic:'generation'}),reviewBatchFileSha256:write(path.join(batchRoot,'review-batch.json'),{synthetic:'review'})};m.manifestSha256=stable(m);
  const manifestFile=path.join(batchRoot,'manifest.json'),manifestFileSha256=write(manifestFile,m);
  const registered=structuredClone(baseline);registered.readerReviewMaintenanceObligations=[{batchId,manifestSha256:m.manifestSha256,manifestFileSha256}];registered.generation++;registered.stateSha256=api.stateDigest(registered);
  const registration={contract:'conference-reader-review-maintenance-registration-v1',manifestSha256:m.manifestSha256,manifestFileSha256,baselineStateFileSha256:m.stateFileSha256,registeredStateFileSha256:write(path.join(batchRoot,'registered-state.json'),registered)};registration.registrationSha256=stable(registration);write(path.join(batchRoot,'registration.json'),registration);
  const locator={contract:'conference-reader-review-maintenance-member-v1',processId,batchId,manifestSha256:m.manifestSha256,manifestFileSha256,memberSha256:stable(member),reviewFeedbackSha256:member.reviewFeedbackSha256,window:null};
  return{root:batchRoot,manifestFile,manifestFileSha256,member,locator,m,activate(){loaded.revision.readerReviewMaintenance=structuredClone(locator);write(path.join(loaded.directory,'reader-revision.json'),loaded.revision);}};
 }
 const first=batch();first.activate();return{module:mod.exports,directory,loaded,parent,processDirectory,files,first,batch,reads,write,get identities(){return identities},get schemas(){return schemas},call(){return mod.exports.readReaderMaintenanceSourceLineage({executionId:childId})}};
}
test('同原文件重复复用batch，identity/current/原parent-child pins逐次核，成员冻结不可污染',t=>{
 const f=setup(t),first=f.call(),cache=f.module.__cache,stored=[...cache.values()][0],manifestReads=f.reads.get(f.first.manifestFile),schemas=f.schemas,identity=f.identities;
 const second=f.call();assert.equal([...cache.values()][0],stored);assert.equal(f.identities,identity+1);assert.equal(f.reads.get(f.first.manifestFile),manifestReads);assert.equal(f.schemas,schemas);
 assert.throws(()=>{second.member.parentCAS.analysisFileSha256='bad'},TypeError);assert.deepEqual(first.member,second.member);
 const pin=path.join(f.parent.directory,'analysis.json');fs.appendFileSync(pin,' ');assert.throws(()=>first.assertUnchanged(),/source-only canonical/);
 assert.equal(cache.size,1); // Next admission never borrows a prior closure as source authority.
});
test('manifest/baseline同size恢复mtime改字节使旧cache失效；恢复原字节须首次全核',t=>{
 for(const kind of ['manifest','baseline']){
  const f=setup(t);f.call();const file=kind==='manifest'?f.first.manifestFile:path.join(f.first.root,'baseline-state.json'),before=fs.readFileSync(file),stat=fs.statSync(file),count=f.reads.get(f.first.manifestFile);
  const changed=Buffer.from(before);changed[changed.indexOf(Buffer.from(kind==='manifest'?'batchId':'generation'))]^=1;fs.writeFileSync(file,changed);fs.utimesSync(file,stat.atime,stat.mtime);
  assert.throws(()=>f.call());assert.equal(f.module.__cache.size,0);fs.writeFileSync(file,before);f.call();assert.ok(f.reads.get(f.first.manifestFile)>count);
 }
});
test('命中仍拒各scope/parent/source变动，不缓存失败或 grant/预算',t=>{
 const alterations=[f=>f.loaded.revision.mode='scoring-and-reader',f=>f.loaded.revision.readerReviewMaintenance.window={windowId:'grant'},f=>f.loaded.revision.readerReviewMaintenance.manifestSha256='0'.repeat(64),f=>f.loaded.parent.analysisFileSha256='wrong',f=>f.loaded.source.sourceDetails.text='other source',f=>f.loaded.run.paperId='other'];
 for(const alter of alterations){const f=setup(t);f.call();alter(f);assert.throws(()=>f.call());}
 const f=setup(t);f.call();fs.unlinkSync(path.join(f.first.root,'registration.json'));assert.throws(()=>f.call(),/ENOENT/);assert.equal(f.module.__cache.size,0);
});
test('命中前仍真安全读文件，错误mode/hardlink/symlink拒，缺采纳不被cache放行',t=>{
 const f=setup(t);f.call();const file=f.first.manifestFile,backup=file+'.backup';
 fs.chmodSync(file,0o644);assert.throws(()=>f.call(),/private/);fs.chmodSync(file,0o600);f.call();
 fs.linkSync(file,backup);assert.throws(()=>f.call(),/single-link/);fs.unlinkSync(backup);f.call();
 fs.renameSync(file,backup);fs.symlinkSync(backup,file);assert.throws(()=>f.call(),/symlink/);fs.unlinkSync(file);fs.renameSync(backup,file);f.call();
 const state=path.join(f.processDirectory,'state.json'),value=JSON.parse(fs.readFileSync(state));value.generation++;f.write(state,value);assert.throws(()=>f.call(),/without real adoption/);assert.equal(f.module.__cache.size,0);
});
test('最多8批，异batch不共享；淘汰后回到原批需完整初核',t=>{
 const f=setup(t);f.call();const original=[...f.module.__cache.values()][0],reads=f.reads.get(f.first.manifestFile);
 for(let i=0;i<8;i++){const next=f.batch();next.activate();f.call();assert.ok(f.module.__cache.size<=8);}
 assert.equal(f.module.__cache.size,8);assert.equal([...f.module.__cache.values()].includes(original),false);
 f.first.activate();f.call();assert.ok(f.reads.get(f.first.manifestFile)>reads);assert.notEqual([...f.module.__cache.values()].at(-1),original);
});
