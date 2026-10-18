'use strict';
// Synthetic immutable-file/budget preservation checks, not source qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),test=require('node:test'),assert=require('node:assert/strict');
const ROOT=process.cwd(),file=path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js');
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.__usage=savedReaderUsageProof;module.exports.__one=firstInheritedOneImageReaderSuccess;module.exports.__image=assertSavedSingleSourceImage;',file);
const digest=x=>require('node:crypto').createHash('sha256').update(x).digest('hex');
function paidFixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'saved-reader-stage-')),usageRoot=path.join(directory,'usage'),childDir=path.join(directory,'child');
 fs.mkdirSync(usageRoot,{mode:0o700});fs.mkdirSync(childDir,{mode:0o700});t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const names=['11111111-1111-4111-8111-111111111111.json','22222222-2222-4222-8222-222222222222.json','33333333-3333-4333-8333-333333333333.json'];
 const paperId='conference:synthetic:2026:conference-paper-id:saved',eventId='44444444-4444-4444-8444-444444444444';
 const base={version:'llm-usage-v1',paperId,stage:'apiReaderArticle',runId:null,unitId:null,contentAttempt:1,transportAttempt:1,eventId};
 const events=[{...base,kind:'request_started',at:'2026-10-18T01:00:01.000Z',inputSha256:'a'.repeat(64),model:'synthetic-model',protocol:'synthetic-protocol'},
 {...base,kind:'request',at:'2026-10-18T01:00:02.000Z',inputSha256:'a'.repeat(64),outputTextSha256:'b'.repeat(64),model:'synthetic-model',protocol:'synthetic-protocol',outcome:'completed',transportStarted:true,statusCode:200,errorCode:null},
 {...base,kind:'disposition',at:'2026-10-18T01:00:03.000Z',outputTextSha256:'b'.repeat(64),disposition:'accepted'}];
 function write(index,value){fs.writeFileSync(path.join(usageRoot,names[index]),JSON.stringify(value)+'\n',{mode:0o600});}
 events.forEach((v,i)=>write(i,v));
 const actualRequire=m.require.bind(m);m.require=name=>name==='../config'?{FILES:{...require(path.join(ROOT,'scripts/config')).FILES,llmUsageDir:usageRoot}}:actualRequire(name);
 const loaded={directory:childDir,run:{paperId,executionId:'55555555-5555-4555-8555-555555555555',createdAt:'2026-10-18T01:00:00.000Z'}};
 const native={inputSha256:'a'.repeat(64)},stage={refreshedAt:'2026-10-18T01:00:04.000Z',model:'synthetic-model',protocol:'synthetic-protocol'};
 return {directory,usageRoot,childDir,names,events,write,loaded,native,stage};
}

test('single-image saved first-success allows preserved outer failures without granting more content responses',t=>{
 const first={category:'paper',systemic:false,at:'2026-10-18T01:00:05.000Z',message:'保留 Reader 上游需要原评分与当前 Reader 的完整绑定仍然有效。'};
 const stage={refreshedAt:'2026-10-18T01:00:04.000Z',figureCount:1,imageEvidenceCount:1,imageEvidenceSha256:'a'.repeat(64),modelImagePreflightEvidenceSha256:'b'.repeat(64),providerImageExclusionCount:0,providerImageExclusions:[]};
 const loaded={analysis:{papers:[{apiReaderFigures:[{}]}],readerRevisionProgress:{attempts:3,failures:[first,{...first,at:'2026-10-18T01:00:06.000Z',message:'later seed rejected before request'},{...first,at:'2026-10-18T01:00:07.000Z',message:'later seed rejected before request'}]}},parent:{run:{executionId:'parent'},analysis:{papers:[{conferenceSourceCorrection:{contract:'conference-source-core-correction-v1',executionId:'parent'}}]}}};
 const before=JSON.stringify(loaded);assert.equal(m.exports.__one(loaded,stage),true);assert.equal(JSON.stringify(loaded),before);
 for(const change of [x=>x.analysis.readerRevisionProgress.attempts=2,x=>x.analysis.readerRevisionProgress.failures[2].systemic=true,x=>x.parent.analysis.papers[0].conferenceSourceCorrection.executionId='other',x=>x.analysis.papers[0].apiReaderFigures.push({})]){const x=structuredClone(loaded);change(x);assert.throws(()=>m.exports.__one(x,stage));}
 const x=structuredClone(loaded);x.analysis.readerRevisionProgress.failures[0].message='unrelated';assert.equal(m.exports.__one(x,stage),false);
});
test('entire saved outer fee history must be exactly original start/request/accepted, including after original stage',t=>{
 const f=paidFixture(t),proof=m.exports.__usage(f.loaded,f.native,f.stage,true);assert.equal(proof.historyFiles.length,3);assert.equal(proof.contentResponses,1);assert.equal(proof.fullResponses,1);
 const extra=path.join(f.usageRoot,'66666666-6666-4666-8666-666666666666.json');
 for(const record of [{...f.events[0],at:'2026-10-18T01:00:05.000Z',contentAttempt:2},{...f.events[1],at:'2026-10-18T01:00:05.000Z',contentAttempt:2},{...f.events[2],at:'2026-10-18T01:00:05.000Z',contentAttempt:2}]){fs.writeFileSync(extra,JSON.stringify(record),{mode:0o600});assert.throws(()=>m.exports.__usage(f.loaded,f.native,f.stage,true),/another request\/response or pending/);fs.unlinkSync(extra);}
});
test('one-image proof binds distinct original raw pixels and actual rendered PNG, plus stage image/preflight hashes',t=>{
 const f=paidFixture(t),bytes=Buffer.from('synthetic sealed PNG bytes; byte-binding test only'),assetSha=digest(bytes),cachePath=path.join(f.childDir,'reader-assets',`figure-1-${assetSha.slice(0,16)}.png`);fs.mkdirSync(path.dirname(cachePath));fs.writeFileSync(cachePath,bytes,{mode:0o600});
 const figure={ordinal:1,url:'conference-pdf-figure://synthetic/1',cachePath,assetSha256:assetSha,assetBytes:bytes.length,asset:{sha256:'d'.repeat(64)},sourceDomSha256:'e'.repeat(64)},stage={figureCount:1,imageEvidenceCount:1,imageEvidenceSha256:'a'.repeat(64),modelImagePreflightEvidenceSha256:'b'.repeat(64)},paper={apiReaderFigures:[figure],analysisManifest:{stages:{apiReaderArticle:stage}}};
 const native={imageEvidenceCount:1,imageEvidenceSha256:stage.imageEvidenceSha256,modelImagePreflightEvidenceSha256:stage.modelImagePreflightEvidenceSha256,sourcePixelProofs:[{ordinal:figure.ordinal,url:figure.url,cachePath,assetSha256:assetSha,assetBytes:bytes.length,originalSourceAssetSha256:figure.asset.sha256,sourceDomSha256:figure.sourceDomSha256}]};
 assert.doesNotThrow(()=>m.exports.__image(f.loaded,paper,native));
 for(const change of [x=>x.imageEvidenceSha256='f'.repeat(64),x=>x.modelImagePreflightEvidenceSha256='f'.repeat(64),x=>x.sourcePixelProofs[0].originalSourceAssetSha256=assetSha,x=>x.sourcePixelProofs[0].cachePath='/tmp/unrelated.png']){const x=structuredClone(native);change(x);assert.throws(()=>m.exports.__image(f.loaded,paper,x));}
 fs.appendFileSync(cachePath,'changed');assert.throws(()=>m.exports.__image(f.loaded,paper,native),/actual sealed PNG changed/);
});
