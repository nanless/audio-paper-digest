'use strict';
// Pure VM and actual temporary byte files only; source/Reader qualification is explicitly mocked.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js'),'utf8'),deep=fs.readFileSync(path.join(ROOT,'scripts/deep-analyzer.js'),'utf8'),sha=x=>crypto.createHash('sha256').update(x).digest('hex'),stable=x=>sha(JSON.stringify(x)),same=(a,b)=>require('node:util').isDeepStrictEqual(structuredClone(a),structuredClone(b)),check=(v,m)=>assert(v,m);
function fixture(t,count=4){const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'four-image-saved-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const parentDir=path.join(directory,'parent'),childDir=path.join(directory,'child');fs.mkdirSync(parentDir);fs.mkdirSync(childDir);fs.mkdirSync(path.join(childDir,'reader-assets'));
 const parentResources={identitySha256:'parent',resources:[{availability:'available',originalUrl:'https://example.invalid/repo',proof:{owner:'parent'}}]},childResources={identitySha256:'child',resources:[{availability:'available',originalUrl:'https://example.invalid/repo',proof:{owner:'child'}}]},first={category:'paper',systemic:false,message:'保留 Reader 上游需要原评分与当前 Reader 的完整绑定仍然有效。',at:'2026-10-18T01:00:05.000Z'};
 const stage={status:'complete',contentMode:'reader-source-signed-revision-v1',attempts:1,fullAttempts:1,transportFailures:0,figureCount:count,imageEvidenceCount:count,imageEvidenceSha256:'a'.repeat(64),modelImagePreflightEvidenceSha256:'b'.repeat(64),providerImageExclusionCount:0,providerImageExclusions:[],refreshedAt:'2026-10-18T01:00:04.000Z'};
 const prior={id:'paper',science:'fixed',apiReaderResources:parentResources,conferenceSourceCorrection:{contract:'conference-source-resource-correction-v1',executionId:'parent'}},paper={id:'paper',science:'fixed',sourceSha256:sha('same source'),apiReaderResources:childResources,apiReaderFigures:[],analysisManifest:{stages:{apiReaderArticle:stage}}};
 const loaded={directory:childDir,run:{executionId:'child',paperId:'paper'},analysis:{status:'partial',papers:[paper],readerRevisionProgress:{attempts:1,failures:[first]}},analysisFileSha256:'ca',runFileSha256:'cr',sourceFileSha256:'s',revision:{mode:'reader-only',readerReviewMaintenance:{window:null}},readerReview:{},resourcePreflight:structuredClone(childResources),parent:{directory:parentDir,run:{executionId:'parent',paperId:'paper'},analysis:{papers:[prior]},analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'s',source:{sourceDetails:{text:'same source'}}}};
 for(let ordinal=1;ordinal<=count;ordinal++){const bytes=Buffer.from('synthetic sealed pixel '+ordinal),assetSha256=sha(bytes),cachePath=path.join(childDir,'reader-assets',`figure-${ordinal}-${assetSha256.slice(0,16)}.png`);fs.writeFileSync(cachePath,bytes,{mode:0o600});paper.apiReaderFigures.push({ordinal,url:'conference-pdf-figure://synthetic/'+ordinal,cachePath,assetSha256,assetBytes:bytes.length,asset:{sha256:sha('raw '+ordinal)},sourceDomSha256:sha('dom '+ordinal)});}
 const native={imageEvidenceCount:count,imageEvidenceSha256:stage.imageEvidenceSha256,modelImagePreflightEvidenceSha256:stage.modelImagePreflightEvidenceSha256,sourcePixelProofs:paper.apiReaderFigures.map(f=>({ordinal:f.ordinal,url:f.url,cachePath:f.cachePath,assetSha256:f.assetSha256,assetBytes:f.assetBytes,originalSourceAssetSha256:f.asset.sha256,sourceDomSha256:f.sourceDomSha256}))};
 loaded.source={sourceDetails:{text:'same source'}};
 if(count===3){loaded.analysis.readerRevisionProgress={attempts:2,failures:[{category:'run',systemic:true,retryable:false,code:'ANALYSIS_STOP_REQUESTED',message:'已请求停止分析；保留已返回内容，不再发送新的模型请求。',at:'2026-10-18T01:00:01.000Z'},{category:'paper',systemic:false,retryable:true,code:null,message:'读者文章与正式分析的绑定无效，不能仅靠同步资源状态修复。',at:'2026-10-18T01:00:05.000Z'}]};}
 const preflightBytes=Buffer.from(JSON.stringify(loaded.resourcePreflight)+'\n');fs.writeFileSync(path.join(childDir,'reader-resource-preflight.json'),preflightBytes,{mode:0o600});loaded.revision.resourcePreflightFileSha256=sha(preflightBytes);fs.writeFileSync(path.join(childDir,'reader-revision.json'),JSON.stringify(loaded.revision)+'\n',{mode:0o600});
 const canonicalParent=structuredClone(loaded.parent),authenticatedChildIdentity=structuredClone(childResources);
 const calls=[],active={executionId:'child',executionDir:childDir,paperId:'paper',readerPdfSourceHandle:{fixture:true},sourceDetails:{text:'same source'}},parentReaderSeedHandles=new WeakMap();let current=active,changed=false;
 const context={Buffer,path,fs,sha,stable,same,check,SHA:/^[a-f0-9]{64}$/,parentReaderSeedHandles,scientificParentReplayHandles:new WeakMap(),structuredClone,
  unissuedResourceMode:()=>'reader-only',
  protectedScience:p=>p.science,privateFile:f=>{const s=fs.lstatSync(f);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);},
  adapter:()=>({loadConferenceAnalysis:()=>{calls.push('parent-canonical');return canonicalParent},loadConferenceReaderRevisionIdentity:()=>{calls.push('final-child-cas');return changed?{...loaded,runFileSha256:'changed'}:loaded}}),
  replayParentSource:p=>{assert(same(p,canonicalParent));calls.push('parent-pdf');return {parent:true}},
  assertSavedMaintenanceReaderRecovery:()=>{calls.push('full-immutable-recovery-assert')},read:filename=>{const bytes=fs.readFileSync(filename);return {bytes,sha256:sha(bytes),value:JSON.parse(bytes)}},
  require:name=>{if(name==='./conference-source-context')return {readerPdfSourceForContext:handle=>{assert(handle);return {fixture:true}}};if(name==='./conference-analysis-context')return {getConferenceAnalysisContext:()=>current,withConferenceAnalysisSource:(scope,fn)=>{calls.push('scope:'+scope.executionId);const old=current;current=scope;try{return fn()}finally{current=old}}};if(name==='../deep-analyzer')return {replayVerifiedReaderResourceIdentity:(identity,text)=>{calls.push('replay:'+current.executionId);assert.equal(text,'same source');assert.equal(identity.resources[0].proof.owner,current.executionId);return identity}};if(name==='./reader-authenticated-pdf-footnote-evidence')return {deriveCorrectedIdentity:(identity,text)=>{calls.push('derive:'+current.executionId);assert.equal(current.executionId,'child');assert(same(identity,count===4?parentResources:childResources));assert.equal(text,'same source');return {identity:structuredClone(authenticatedChildIdentity)}}};throw Error('unexpected require '+name)}};
 const a=source.indexOf('function firstInheritedResourceFourImageReaderSuccess('),b=source.indexOf('function usageHistoryRows(',a);vm.runInNewContext(source.slice(a,b)+';this.api={firstInheritedResourceFourImageReaderSuccess,firstReadmittedResourceThreeImageReaderSuccess,assertSavedBoundSourceImages,assertSavedFourSourceImages,assertSavedResourceOwnerProjection,assertSavedResourceReadmissionProjection,savedResourceReaderKind,readVerifiedSavedReaderImageLimit};',context);
 if(count===3){context.readSavedResourceReadmission=(l,p,b,m)=>{assert.equal(l.directory,childDir);assert(b&&m);calls.push('readmission-receipt');return {identity:childResources,proof:{contract:'synthetic-readmission'},assertUnchanged:()=>calls.push('readmission-cas')};};}
 return {directory,loaded,paper,stage,native,calls,api:context.api,context,parentReaderSeedHandles,active,makeDrift:()=>{changed=true}};
}
test('four-image exact positive and real temp pixel proof are read-only',t=>{const f=fixture(t),before=JSON.stringify(f.loaded);assert(f.api.firstInheritedResourceFourImageReaderSuccess(f.loaded,f.stage));assert.doesNotThrow(()=>f.api.assertSavedFourSourceImages(f.loaded,f.paper,f.native));assert.equal(JSON.stringify(f.loaded),before);});
for(const [label,change]of [['missing',f=>f.native.sourcePixelProofs.pop()],['swapped',f=>f.native.sourcePixelProofs.reverse()],['extra',f=>f.native.sourcePixelProofs.push(f.native.sourcePixelProofs[0])],['raw SHA',f=>f.native.sourcePixelProofs[1].originalSourceAssetSha256='f'.repeat(64)],['URL',f=>f.native.sourcePixelProofs[1].url+='wrong'],['DOM',f=>f.native.sourcePixelProofs[1].sourceDomSha256='f'.repeat(64)],['cache',f=>f.native.sourcePixelProofs[1].cachePath='/tmp/unowned'],['model preflight',f=>f.native.modelImagePreflightEvidenceSha256='f'.repeat(64)],['evidence',f=>f.native.imageEvidenceSha256='f'.repeat(64)],['duplicate ordinal',f=>f.paper.apiReaderFigures[1].ordinal=1],['byte drift',f=>fs.appendFileSync(f.paper.apiReaderFigures[1].cachePath,'reencoded')]])test('four image rejects '+label,t=>{const f=fixture(t);change(f);assert.throws(()=>f.api.assertSavedFourSourceImages(f.loaded,f.paper,f.native));});
test('owner bridge replays canonical parent scope then actual child and normal derives exact bound identity',t=>{const f=fixture(t),before=JSON.stringify(f.loaded);assert.equal(f.api.assertSavedResourceOwnerProjection(f.loaded,f.paper),true);assert.deepEqual(f.calls,['parent-canonical','parent-pdf','scope:parent','replay:parent','replay:child','derive:child','final-child-cas']);assert.equal(JSON.stringify(f.loaded),before);});
for(const [label,change]of [['parent bytes',f=>f.loaded.parent.analysisFileSha256='wrong'],['source scope',f=>f.active.executionId='other'],['source text',f=>f.active.sourceDetails.text='other'],['science',f=>f.paper.science='changed'],['preflight',f=>f.loaded.resourcePreflight.resources[0].availability='unavailable'],['status',f=>f.paper.apiReaderResources.resources[0].availability='unavailable'],['source file',f=>f.loaded.sourceFileSha256='other'],['late CAS',f=>f.makeDrift()]])test('owner bridge rejects '+label,t=>{const f=fixture(t);change(f);assert.throws(()=>f.api.assertSavedResourceOwnerProjection(f.loaded,f.paper));});
test('opaque native four limit cannot be supplied by JSON or requested for two/three images',t=>{const f=fixture(t),handle={};f.parentReaderSeedHandles.set(handle,{scientificReplay:{loaded:f.loaded}});assert.equal(f.api.readVerifiedSavedReaderImageLimit(handle,4),4);assert.throws(()=>f.api.readVerifiedSavedReaderImageLimit({},4));assert.throws(()=>f.api.readVerifiedSavedReaderImageLimit(handle,2));assert.throws(()=>f.api.readVerifiedSavedReaderImageLimit(handle,3));});

test('self-consistent changed availability cannot borrow normal owner translation',t=>{const f=fixture(t);f.paper.apiReaderResources.resources[0].availability='unavailable';f.loaded.resourcePreflight=structuredClone(f.paper.apiReaderResources);assert.throws(()=>f.api.assertSavedResourceOwnerProjection(f.loaded,f.paper),/actual PDF owner rederivation/);});
test('cold owner bridge first validates original immutable recovery and then reads exact partial before',t=>{const f=fixture(t),before=Buffer.from(JSON.stringify(f.loaded.analysis)),hash=sha(before),dir=path.join(f.loaded.directory,'saved-reader-stage-recovery',hash);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'analysis.json'),before,{mode:0o600});f.loaded.analysis={...f.loaded.analysis,status:'complete',readerSavedStageRecovery:{savedReaderRecoveryKind:'inherited-source-resource-four-image-first-success-v1',originalPartialAnalysisFileSha256:hash}};assert.equal(f.api.assertSavedResourceOwnerProjection(f.loaded,f.paper),true);assert.equal(f.calls[0],'full-immutable-recovery-assert');fs.appendFileSync(path.join(dir,'analysis.json'),' ');assert.throws(()=>f.api.assertSavedResourceOwnerProjection(f.loaded,f.paper),/original partial CAS/);});

function fourArchiveFixture(t,count=4) {
 const f=fixture(t,count),context=f.context,usageRoot=path.join(f.directory,'usage');fs.mkdirSync(usageRoot);
 f.loaded.run.createdAt='2026-10-18T01:00:00.000Z';f.stage.model='synthetic-model';f.stage.protocol='synthetic-protocol';f.stage.fingerprint='c'.repeat(64);
 const base={version:'llm-usage-v1',paperId:'paper',stage:'apiReaderArticle',runId:null,unitId:null,contentAttempt:1,transportAttempt:1,eventId:'44444444-4444-4444-8444-444444444444'},names=['11111111-1111-4111-8111-111111111111.json','22222222-2222-4222-8222-222222222222.json','33333333-3333-4333-8333-333333333333.json'];
 const events=[{...base,kind:'request_started',at:'2026-10-18T01:00:01.000Z',inputSha256:'a'.repeat(64),model:f.stage.model,protocol:f.stage.protocol},{...base,kind:'request',at:'2026-10-18T01:00:02.000Z',inputSha256:'a'.repeat(64),outputTextSha256:'b'.repeat(64),model:f.stage.model,protocol:f.stage.protocol,outcome:'completed',transportStarted:true,statusCode:200,errorCode:null},{...base,kind:'disposition',at:'2026-10-18T01:00:03.000Z',outputTextSha256:'b'.repeat(64),disposition:'accepted'}];events.forEach((v,i)=>fs.writeFileSync(path.join(usageRoot,names[i]),JSON.stringify(v)+'\n',{mode:0o600}));
 const nativeRequire=context.require;context.require=name=>name==='../config'?{FILES:{llmUsageDir:usageRoot}}:nativeRequire(name);
 const normalAdapter=context.adapter;context.adapter=()=>({...normalAdapter(),writeBytesAtomic:(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o600});}});
 context.savedCompletionHandles=new WeakMap();context.self=(v,key)=>{const body=structuredClone(v);delete body[key];check(stable(body)===v[key],key+' mismatch')};context.neutralReaderUpstreamView=(parent,paper)=>({paper:structuredClone(paper),projection:null});
 const a=source.indexOf('function usageHistoryRows('),b=source.indexOf('async function inspectSavedMaintenanceReaderCompletion(',a);vm.runInNewContext(source.slice(a,b),context);
 const c=source.indexOf('function archiveSavedMaintenanceReaderCompletion('),d=source.indexOf('function sourceIdentity(',c);vm.runInNewContext(source.slice(c,d)+';this.archive=archiveSavedMaintenanceReaderCompletion;this.cold=assertSavedMaintenanceReaderRecovery;',context);
 f.native.inputSha256='a'.repeat(64);f.loaded.revision.resourcePreflightFileSha256=sha(Buffer.from(JSON.stringify(f.loaded.resourcePreflight)+'\n'));const values={'analysis.json':f.loaded.analysis,'run.json':f.loaded.run,'source.json':{fixture:true},'reader-revision.json':f.loaded.revision,'reader-resource-preflight.json':f.loaded.resourcePreflight,'review-reader-seed.json':{fixtureSeed:true}};
 const beforeFiles=Object.entries(values).map(([name,value])=>{const bytes=Buffer.from(JSON.stringify(value)+'\n');fs.writeFileSync(path.join(f.loaded.directory,name),bytes,{mode:0o600});return {name,bytes,sha256:sha(bytes)};});
 f.loaded.analysisFileSha256=beforeFiles[0].sha256;f.loaded.sourceFileSha256=beforeFiles[2].sha256;
 const usage=context.savedReaderUsageProof(f.loaded,f.native,f.stage,true),proof={contract:'conference-saved-maintenance-reader-completion-v1',executionId:f.loaded.run.executionId,paperId:'paper',originalPartialAnalysisFileSha256:f.loaded.analysisFileSha256,parentAnalysisFileSha256:f.loaded.parent.analysisFileSha256,parentRunFileSha256:f.loaded.parent.runFileSha256,sourceFileSha256:f.loaded.sourceFileSha256,preflightFileSha256:f.loaded.revision.resourcePreflightFileSha256,newApiRequests:0,restoredPaperSha256:stable(f.paper),readerStageSha256:stable(f.stage),savedReaderRecoveryKind:count===4?'inherited-source-resource-four-image-first-success-v1':'readmitted-source-resource-three-image-first-success-v1',...(count===3?{resourceReadmission:{contract:'synthetic-readmission'}}:{}),nativeRequest:{...f.native,stageFingerprint:f.stage.fingerprint},usage,beforeFiles:beforeFiles.map(({name,sha256})=>({name,sha256}))};
 const handle={};context.savedCompletionHandles.set(handle,{proof,paper:f.paper,beforeFiles,loaded:f.loaded});const receipt=context.archive(f.loaded,handle),complete={...f.loaded,analysis:{...f.loaded.analysis,status:'complete',readerSavedStageRecovery:receipt}};
 if(count===3){const h={};complete.readerReview={parentSeedHandle:h};context.parentReaderSeedHandles.set(h,{scientificReplay:{loaded:complete,batch:{fixture:true},member:{fixture:true}}});}
 return {...f,usageRoot,names,events,receipt,complete};
}
test('four-image actual archive/cold functions preserve partial before6 and original fee records',t=>{const f=fourArchiveFixture(t),before=fs.readFileSync(path.join(f.loaded.directory,'analysis.json'));assert.doesNotThrow(()=>f.context.cold(f.complete,f.paper));assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory,'analysis.json')),before);assert.equal(f.complete.analysis.readerRevisionProgress.attempts,1);assert.equal(f.receipt.usage.records.length,3);});
for(const [label,change] of [['before seed',f=>fs.appendFileSync(path.join(f.loaded.directory,'saved-reader-stage-recovery',f.loaded.analysisFileSha256,'review-reader-seed.json'),' ')],['actual fees',f=>fs.appendFileSync(path.join(f.usageRoot,f.names[1]),' ')],['extra later request',f=>fs.writeFileSync(path.join(f.usageRoot,'66666666-6666-4666-8666-666666666666.json'),JSON.stringify({...f.events[0],at:'2026-10-18T01:00:06.000Z',contentAttempt:2}),{mode:0o600})],['changed current stage',f=>f.paper.analysisManifest.stages.apiReaderArticle.fingerprint='f'.repeat(64)],['lost PNG',f=>fs.unlinkSync(f.paper.apiReaderFigures[2].cachePath)]])test('four-image real cold receipt rejects '+label,t=>{const f=fourArchiveFixture(t);change(f);assert.throws(()=>f.context.cold(f.complete,f.paper));});

for(const [label,change,result]of [['window',f=>f.loaded.revision.readerReviewMaintenance.window={windowId:'other'}],['scoring mode',f=>f.loaded.revision.mode='scoring-and-reader'],['reset attempts',f=>f.loaded.analysis.readerRevisionProgress.attempts=0],['failure count',f=>f.loaded.analysis.readerRevisionProgress.failures.push(f.loaded.analysis.readerRevisionProgress.failures[0])],['later full',f=>f.stage.fullAttempts=2],['later content',f=>f.stage.attempts=2],['transport',f=>f.stage.transportFailures=1],['exclusion',f=>f.stage.providerImageExclusions=[1]],['unknown parent',f=>f.loaded.parent.analysis.papers[0].conferenceSourceCorrection.contract='unknown',false],['core parent',f=>f.loaded.parent.analysis.papers[0].conferenceSourceCorrection.contract='conference-source-core-correction-v1',false],['wrong owner',f=>f.loaded.parent.analysis.papers[0].conferenceSourceCorrection.executionId='other'],['unrelated failure',f=>f.loaded.analysis.readerRevisionProgress.failures[0].message='other',false]])test('exact first-success classifier keeps '+label+' outside this branch',t=>{const f=fixture(t);change(f);if(result===false)assert.equal(f.api.firstInheritedResourceFourImageReaderSuccess(f.loaded,f.stage),false);else assert.throws(()=>f.api.firstInheritedResourceFourImageReaderSuccess(f.loaded,f.stage));});

function seedCapability(f,{plain=true}={}) {
 const raw={...f.loaded};if(plain){delete raw.readerReview;delete raw.resourcePreflight;}
 const handle={};f.parentReaderSeedHandles.set(handle,{scientificReplay:{loaded:raw,batch:{fixture:true},member:{fixture:true}}});
 return handle;
}
test('native real seed-loader shape lacks readerReview/preflight and privately replays canonical actual preflight',t=>{
 const f=fixture(t),handle=seedCapability(f),before=JSON.stringify(f.parentReaderSeedHandles.get(handle).scientificReplay.loaded);
 assert.equal(f.api.readVerifiedSavedReaderImageLimit(handle,4),4);
 assert.equal(JSON.stringify(f.parentReaderSeedHandles.get(handle).scientificReplay.loaded),before);
 assert.equal(Object.hasOwn(f.parentReaderSeedHandles.get(handle).scientificReplay.loaded,'resourcePreflight'),false);
});
for(const [label,change] of [
 ['actual preflight bytes',f=>fs.appendFileSync(path.join(f.loaded.directory,'reader-resource-preflight.json'),' ')],
 ['actual revision bytes',f=>fs.writeFileSync(path.join(f.loaded.directory,'reader-revision.json'),JSON.stringify({...f.loaded.revision,mode:'normal-analysis'}))],
 ['actual wrong PDF scope',f=>f.active.executionId='other'],
 ['resource mode changes scoring',f=>f.context.unissuedResourceMode=()=> 'scoring-and-reader'],
 ['late preflight mutation',f=>{const original=f.context.unissuedResourceMode;f.context.unissuedResourceMode=(...args)=>{fs.appendFileSync(path.join(f.loaded.directory,'reader-resource-preflight.json'),' ');return original(...args);};}]
])test('native seed-loader rejects '+label,t=>{const f=fixture(t),h=seedCapability(f);change(f);assert.throws(()=>f.api.readVerifiedSavedReaderImageLimit(h,4));});
test('three-image readmission branch uses same private native/source pipeline with exact original stop/binding history',t=>{
 const f=fixture(t,3),h=seedCapability(f),before=JSON.stringify(f.loaded);
 assert(f.api.firstReadmittedResourceThreeImageReaderSuccess(f.loaded,f.stage));
 assert.equal(f.api.readVerifiedSavedReaderImageLimit(h,3),3);
 f.api.assertSavedBoundSourceImages(f.loaded,f.paper,f.native,3);
 assert(f.calls.includes('readmission-receipt')&&f.calls.includes('readmission-cas')&&f.calls.includes('derive:child'));
 assert.equal(JSON.stringify(f.loaded),before);assert.throws(()=>f.api.readVerifiedSavedReaderImageLimit(h,4));
});
for(const [label,change,result] of [
 ['unrelated first failure',f=>f.loaded.analysis.readerRevisionProgress.failures[0].code='OTHER',false],
 ['first stop retryable',f=>f.loaded.analysis.readerRevisionProgress.failures[0].retryable=true],
 ['first stop nonsystemic',f=>f.loaded.analysis.readerRevisionProgress.failures[0].systemic=false],
 ['wrong latest binding failure',f=>f.loaded.analysis.readerRevisionProgress.failures[1].message='another'],
 ['content twice',f=>f.stage.attempts=2],['transport',f=>f.stage.transportFailures=1],
 ['window',f=>f.loaded.revision.readerReviewMaintenance.window={windowId:'other'}],
 ['scoring mode',f=>f.loaded.revision.mode='scoring-and-reader'],
 ['missing original stop',f=>f.loaded.analysis.readerRevisionProgress.failures.shift(),false],
 ['core parent',f=>f.loaded.parent.analysis.papers[0].conferenceSourceCorrection.contract='conference-source-core-correction-v1',false],
 ['extra image',f=>f.paper.apiReaderFigures.push(f.paper.apiReaderFigures[0])]
])test('three-image first-success rejects '+label,t=>{const f=fixture(t,3);change(f);if(result===false)assert.equal(f.api.firstReadmittedResourceThreeImageReaderSuccess(f.loaded,f.stage),false);else assert.throws(()=>f.api.firstReadmittedResourceThreeImageReaderSuccess(f.loaded,f.stage));});
test('three-image actual cold archive replays exact readmission proof and all original three fees/pixels',t=>{
 const f=fourArchiveFixture(t,3);assert.doesNotThrow(()=>f.context.cold(f.complete,f.paper));
 assert.equal(f.complete.analysis.readerRevisionProgress.attempts,2);assert.equal(f.receipt.usage.records.length,3);
 const previous=f.context.readSavedResourceReadmission;f.context.readSavedResourceReadmission=(...args)=>({...previous(...args),proof:{contract:'changed'}});
 assert.throws(()=>f.context.cold(f.complete,f.paper),/readmission proof changed/);
});
for(const [label,change] of [['missing PNG',f=>fs.unlinkSync(f.paper.apiReaderFigures[0].cachePath)],['swapped proof',f=>f.paper.apiReaderFigures.reverse()],['fee append',f=>fs.appendFileSync(path.join(f.usageRoot,f.names[1]),' ')],['before intent package',f=>fs.appendFileSync(path.join(f.loaded.directory,'saved-reader-stage-recovery',f.loaded.analysisFileSha256,'run.json'),' ')]])test('three-image cold receipt rejects '+label,t=>{const f=fourArchiveFixture(t,3);change(f);assert.throws(()=>f.context.cold(f.complete,f.paper));});
for(const count of [3,4])test(`${count}-image real saved issuer preserves before6/fees and issues only after original full gates`,async t=>{
 const f=fourArchiveFixture(t,count),c=f.context;
 // This issuer fixture starts before any recovery receipt exists.
 fs.rmSync(path.join(f.loaded.directory,'saved-reader-stage-recovery'),{recursive:true});
 f.loaded.parent.analysis.papers[0].analysisManifest={stages:{apiReaderArticle:{status:'complete',fingerprint:'parent'}}};
 f.loaded.readerReview={locator:{reviewFeedbackSha256:'feedback'},revisionSeed:{metadata:{}},modelFeedback:'original feedback',parentSeedHandle:seedCapability(f)};
 f.native={...f.native,contract:'conference-saved-signed-reader-request-input-v1',images:count,modelRequests:0,
  evidenceSha256:f.stage.evidenceSha256,model:f.stage.model,protocol:f.stage.protocol,maxTokens:f.stage.maxTokens,temperature:f.stage.temperature,
  currentInputPreparationFingerprint:'d'.repeat(64),preparerImplementationSha256:'e'.repeat(64),
  identity:{paperId:f.loaded.run.paperId,sourceSha256:f.paper.sourceSha256,contentMode:f.stage.contentMode,
   promptSha256:f.stage.promptTemplateSha256,repairPromptSha256:f.stage.repairPromptTemplateSha256,
   signedRevisionDisplayContract:f.stage.signedRevisionDisplayContract,signedRevisionDisplaySha256:f.stage.signedRevisionDisplaySha256}};
 const originalRequire=c.require,events=[];
 c.require=name=>name==='./analysis-stop-control'?{withModelRequestsForbidden:async fn=>{events.push('forbid-model');return fn()}}:
  name==='../deep-analyzer'?{...originalRequire(name),prepareConferenceReaderSavedRequestInput:async()=>{events.push('native-original-body-proof');return f.native}}:
  name==='../analysis-engine'?{hasValidApiReaderV3Records:()=>{events.push('full-Reader');return true},isSuccessfulAnalysisRecordForReadOnlyConferencePublication:()=>{events.push('full-whole');return true}}:
  name==='./conference-postprocess'?{readOriginalTagProof:()=>({rules:{fixture:true}})}:originalRequire(name);
 c.replaySavedNeutralReaderUpstream=()=>({paper:structuredClone(f.paper),projection:null});
 c.readVerifiedReaderScientificParent=paper=>{events.push('scientific-parent');return true};c.assertReaderOutput=()=>events.push('actual-output-protection');
 c.savedCompletionHandles=new WeakMap();
 const a=source.indexOf('async function inspectSavedMaintenanceReaderCompletion('),b=source.indexOf('function archiveSavedMaintenanceReaderCompletion(',a);
 vm.runInNewContext(source.slice(a,b)+';this.inspect=inspectSavedMaintenanceReaderCompletion;',c);
 const initial=JSON.stringify(f.loaded),feeBytes=f.names.map(name=>fs.readFileSync(path.join(f.usageRoot,name)));
 const result=await c.inspect(f.loaded);
 assert.equal(result.proof.savedReaderRecoveryKind,count===4?'inherited-source-resource-four-image-first-success-v1':'readmitted-source-resource-three-image-first-success-v1');
 assert.equal(result.proof.newApiRequests,0);assert.equal(result.proof.usage.records.length,3);
 assert.deepEqual(events,['forbid-model','scientific-parent','native-original-body-proof','actual-output-protection','full-Reader','full-whole']);
 assert.equal(JSON.stringify(f.loaded),initial);f.names.forEach((name,index)=>assert.deepEqual(fs.readFileSync(path.join(f.usageRoot,name)),feeBytes[index]));
 const saved=c.archive(f.loaded,result.handle);assert.equal(saved.originalPartialAnalysisFileSha256,f.loaded.analysisFileSha256);
});
