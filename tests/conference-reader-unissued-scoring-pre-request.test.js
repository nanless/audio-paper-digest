'use strict';
// Pure VM and synthetic private tempFS metadata. PDF/source and model calls are mocked.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),test=require('node:test'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(ROOT,'scripts/lib/conference-reader-review-maintenance.js'),'utf8'),adapterSource=fs.readFileSync(path.join(ROOT,'scripts/lib/conference-analysis-adapter.js'),'utf8');
const PAPER_ID='conference:interspeech:2026:conference-paper-id:synthetic_interspeech';
const {normalizeUsagePaperId}=require('../scripts/lib/llm-usage.js');
const UUID=vm.runInNewContext(source.match(/^const UUID = .*;$/mu)[0]+'UUID;');
const strictContext={TextDecoder};
vm.runInNewContext(adapterSource.slice(adapterSource.indexOf('function strictJson('),adapterSource.indexOf('function exactKeys('))+';this.parse=strictJson;',strictContext);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),stable=x=>sha(JSON.stringify(x)),same=(a,b)=>require('node:util').isDeepStrictEqual(structuredClone(a),structuredClone(b));
function fixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pre-score-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const usage=path.join(directory,'usage');fs.mkdirSync(usage);const childDir=path.join(directory,'child');fs.mkdirSync(childDir);
 const write=(name,value)=>{const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(childDir,name),bytes,{mode:0o600});return {value,bytes,sha256:sha(bytes)}};
 const preflight=write('reader-resource-preflight.json',{identitySha256:'fixed',resources:[]}),intent=write('intent.json',{intentSha256:'intent'});
 const first={category:'run',code:'CONFERENCE_READER_REVIEW_MAINTENANCE_INTEGRITY',message:'Text maintenance: unissued scoring admission differs from actual source/parent/feedback receipt',systemic:true,retryable:false,at:'2026-10-19T19:56:21.863Z'};
 const loaded={directory:childDir,run:{executionId:'child',paperId:PAPER_ID,status:'source_ready',createdAt:'2026-10-19T11:39:04.499Z',prepareIntentFileSha256:intent.sha256,prepareIntentSha256:'intent'},analysis:{status:'partial',generation:3,papers:[{id:PAPER_ID,science:'fixed',apiReaderResources:preflight.value}],readerRevisionProgress:{attempts:1,failures:[first]}},revision:{mode:'scoring-and-reader',maxAttempts:3,readerReviewMaintenance:{window:null}},analysisFileSha256:'analysis',runFileSha256:'run',sourceFileSha256:'source',source:{sourceDetails:{text:'source'}},parent:{run:{executionId:'parent'},analysis:{papers:[{id:PAPER_ID,science:'fixed'}]},analysisFileSha256:'pa',runFileSha256:'pr',sourceFileSha256:'ps'},resourcePreflight:preflight.value,readerReview:{parentSeedHandle:{},unissuedScoringRecovery:{admissionFileSha256:'admission'}}};
 const originalAnalysis=write('analysis.json',loaded.analysis);loaded.analysisFileSha256=originalAnalysis.sha256;
 const sourceRecord=write('source.json',loaded.source),revisionRecord=write('reader-revision.json',loaded.revision),seedRecord=write('review-reader-seed.json',{metadata:{},synthetic:true});loaded.sourceFileSha256=sourceRecord.sha256;loaded.readerReview.revisionSeed=seedRecord.value;
 const originalRun=write('run.json',loaded.run);loaded.runFileSha256=originalRun.sha256;
 const canonical=structuredClone(loaded),raw={...loaded};delete raw.readerReview;delete raw.resourcePreflight;
 const batch={analysisRoot:directory},member={paperId:PAPER_ID,parentExecutionId:'parent',executionId:'child'},parentReaderSeedHandles=new WeakMap();parentReaderSeedHandles.set(loaded.readerReview.parentSeedHandle,{unissuedScoringRecovery:loaded.readerReview.unissuedScoringRecovery,revisionFileSha256:revisionRecord.sha256,sourceFileSha256:sourceRecord.sha256,seedFileSha256:seedRecord.sha256,seed:seedRecord.value,scientificReplay:{loaded:raw,batch,member}});
 const calls=[];let active={executionId:'child',executionDir:childDir,paperId:PAPER_ID,readerPdfSourceHandle:{private:true},sourceDetails:loaded.source.sourceDetails},insideLock=false,mode='scoring-and-reader',admissionBad=false;
 const read=file=>{const st=fs.lstatSync(file);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o777)===0o600);const bytes=fs.readFileSync(file);return {bytes,sha256:sha(bytes),value:structuredClone(strictContext.parse(bytes,path.basename(file)))}};
 const modules={'./llm-usage':{normalizeUsagePaperId},'../config':{FILES:{llmUsageDir:usage}},'./conference-analysis-context':{getConferenceAnalysisContext:()=>active,withConferenceAnalysisSource:(scope,fn)=>{const previous=active;active=scope;calls.push('child-source');try{return fn()}finally{active=previous}}},'./conference-source-context':{readerPdfSourceForContext:handle=>assert(handle)},'../deep-analyzer':{replayVerifiedReaderResourceIdentity:(identity,text)=>{calls.push('fixed-source');assert.equal(text,'source');return identity}},'./analysis-stop-control':{withModelRequestsForbidden:fn=>{calls.push('no-model');return fn()}}};
 const c={Buffer,Date,path,fs,UUID,sha,structuredClone,stable,same,parentReaderSeedHandles,scientificParentReplayHandles:new WeakMap(),check:(v,m)=>assert(v,m),read,assertCurrentBatch:()=>calls.push('current'),adapter:()=>({loadConferenceReaderRevisionIdentity:()=>structuredClone(canonical)}),readScoringAdmission:()=>{calls.push('original-admission');if(admissionBad)throw Error('admission changed');return {binding:loaded.readerReview.unissuedScoringRecovery,receipt:{before:{'intent.json':intent,'run.json':originalRun},preflight}}},protectedScience:p=>p.science,unissuedResourceMode:()=>mode,effectiveMember:()=>({...member,window:null}),require:name=>{assert(modules[name],'unexpected '+name);return modules[name]}};
 vm.runInNewContext(source.slice(source.indexOf('function privateFile('),source.indexOf('function read(filename)')),c);
 const a=source.indexOf('function savedResourceReaderContext('),b=source.indexOf('function savedResourceReaderKind(',a);vm.runInNewContext(source.slice(a,b),c);
 const start=source.indexOf('function unissuedScoringPreRequestCandidate('),end=source.indexOf('function readVerifiedUnissuedScoringResources(',start);vm.runInNewContext(source.slice(start,end)+';this.inspect=inspectUnissuedScoringPreRequestRecovery;this.readmit=readmitUnissuedScoringPreRequestChild;',c);
 const deps={engine:{withPaperAnalysisLock:async(p,fn)=>{assert.equal(p.id,PAPER_ID);calls.push('lock');insideLock=true;try{return fn()}finally{insideLock=false;calls.push('unlock')}}},adapter:{verifyPlanAuthority:l=>{assert(insideLock);assert.equal(l,loaded);calls.push('plan-child');return {private:true}}}};
 const fee=(value,name='11111111-1111-4111-8111-111111111111.json')=>{const f=path.join(usage,name);fs.writeFileSync(f,JSON.stringify({version:'llm-usage-v1',paperId:PAPER_ID,stage:'scoringAudit',kind:'request_started',at:'2026-10-19T20:00:00.000Z',...value}),{mode:0o600});return f;};
 return {loaded,raw,canonical,c,usage,calls,deps,batch,member,first,read,fee,setActive:v=>active=v,setMode:v=>mode=v,badAdmission:()=>admissionBad=true};
}
test('real plain seed shape plus full caller restores only original remaining outer work; no writes/models',async t=>{const f=fixture(t),before=JSON.stringify(f.loaded);assert.equal(Object.hasOwn(f.raw,'readerReview'),false);assert.equal(Object.hasOwn(f.raw,'resourcePreflight'),false);assert(f.c.inspect(f.loaded));f.setActive(null);assert.equal(await f.c.readmit(f.batch,f.member,{status:'partial',child:f.loaded},{},f.deps),true);assert.deepEqual(f.calls.slice(-8).filter(x=>['lock','plan-child','child-source','unlock'].includes(x)),['lock','plan-child','child-source','unlock']);assert.equal(f.loaded.analysis.readerRevisionProgress.attempts,1);assert.equal(JSON.stringify(f.loaded),before);});
for(const [name,change]of [['outer reset',f=>f.loaded.analysis.readerRevisionProgress.attempts=0],['outer2',f=>f.loaded.analysis.readerRevisionProgress.attempts=2],['checkpoint',f=>f.loaded.analysis.readerRevisionProgress.scoringCheckpoint={}],['window',f=>f.loaded.revision.readerReviewMaintenance.window={}],['reader mode',f=>f.loaded.revision.mode='reader-only'],['oldcap',f=>f.loaded.revision.maxAttempts=2],['different failure',f=>f.first.message='other'],['retryable failure',f=>f.first.retryable=true],['paper failure',f=>f.first.category=PAPER_ID],['no capability',f=>f.loaded.readerReview.parentSeedHandle={}]] )test('no readmission for '+name,t=>{const f=fixture(t);change(f);assert.equal(f.c.inspect(f.loaded),null);});
for(const [name,change] of [['current bytes',f=>f.canonical.analysisFileSha256='changed'],['current parent',f=>f.canonical.parent.runFileSha256='changed'],['science',f=>f.loaded.analysis.papers[0].science='changed'],['original intent',f=>f.loaded.run.prepareIntentSha256='changed'],['actual preflight',f=>f.loaded.resourcePreflight={}],['wrong source',f=>f.setActive(null)],['fixed mode',f=>f.setMode('reader-only')],['admission',f=>f.badAdmission()],['unknown progress',f=>f.loaded.analysis.readerRevisionProgress.other=true]])test('readmission rejects '+name,t=>{const f=fixture(t);change(f);assert.throws(()=>f.c.inspect(f.loaded));});
for(const kind of ['request_started','request','disposition'])test('any real scoring '+kind+' keeps original block',t=>{const f=fixture(t);f.fee({kind});assert.throws(()=>f.c.inspect(f.loaded),/actual scoring request/);assert.equal(f.loaded.analysis.readerRevisionProgress.attempts,1);});
test('unknown scoring attribution and malformed pending metadata block',t=>{const f=fixture(t);const file=f.fee({paperId:null});assert.throws(()=>f.c.inspect(f.loaded),/unknown time\/paper/);fs.unlinkSync(file);fs.writeFileSync(path.join(f.usage,'.22222222-2222-4222-8222-222222222222.tmp'),'pending',{mode:0o600});assert.throws(()=>f.c.inspect(f.loaded),/unfinished|JSON/);});
test('old actual scoring before child creation is retained but cannot supply new checkpoint',t=>{const f=fixture(t);f.fee({at:'2026-10-18T01:00:00.000Z'});assert(f.c.inspect(f.loaded));assert.equal(f.loaded.analysis.readerRevisionProgress.scoringCheckpoint,undefined);});
test('actual adapter blocker wraps recheck in own-source/no-model scope before original attempt increment',()=>{const a=adapterSource.indexOf("if (loaded.revision.mode === 'scoring-and-reader' && !savedScoring\n            && progress.failures.length > 0"),b=adapterSource.indexOf('const stageRequests =',a);const code=adapterSource.slice(a,b);for(const permit of [false,true]){const calls=[],loaded={revision:{mode:'scoring-and-reader'},readerReview:{unissuedScoringRecovery:{}}};const c={loaded,progress:{failures:[{}]},savedScoring:null,executionId:'child',withVerifiedSource:fn=>{calls.push('source');return fn()},require:n=>n==='./analysis-stop-control'?{withModelRequestsForbidden:fn=>{calls.push('forbid');return fn()}}:{inspectUnissuedScoringPreRequestRecovery:l=>{assert.equal(l,loaded);calls.push('fresh-zero-fees');return permit?{}:null}}};if(permit)assert.doesNotThrow(()=>vm.runInNewContext(code,c));else assert.throws(()=>vm.runInNewContext(code,c),e=>e.code==='CONFERENCE_READER_REVISION_SCORING_RECOVERY_BLOCKED');assert.deepEqual(calls,['forbid','source','fresh-zero-fees']);}assert(adapterSource.indexOf('attempts: progress.attempts + 1',a)>b);});

for(const late of [false,true])test(`original nonretryable scheduler resumes only ephemeral zero-request admission; late fee=${late}`,async t=>{
 const f=fixture(t),member=f.member,previous={[PAPER_ID]:{executionId:'child',failure:{retryable:false,systemic:false}}},outcomes=new Map(),unissuedReadmissions=new Set(),pending=[member];
 const a=source.indexOf('const phaseCandidates=pending.filter('),b=source.indexOf('// One full observation',a),predicate=source.slice(a,b)+';this.selected=phaseCandidates;';
 const schedule=()=>{const c={pending,outcomes,unissuedReadmissions,previous,batch:f.batch,effectiveMember:()=>({...member,window:null})};vm.runInNewContext(predicate,c);return c.selected;};
 assert.equal(schedule().length,0);f.setActive(null);
 if(await f.c.readmit(f.batch,member,{status:'partial',child:f.loaded},{},f.deps))unissuedReadmissions.add(member.paperId);
 assert.equal(schedule().length,1);assert.equal(f.loaded.analysis.readerRevisionProgress.attempts,1);
 if(late)f.fee({kind:'request_started'});
 let lock=false,forbidden=false;
 const guardStart=adapterSource.indexOf("if (loaded.revision.mode === 'scoring-and-reader' && !savedScoring\n            && progress.failures.length > 0"),guardEnd=adapterSource.indexOf('const stageRequests =',guardStart);
 const guard=adapterSource.slice(guardStart,guardEnd),progress=f.loaded.analysis.readerRevisionProgress;
 const c={loaded:f.loaded,progress,savedScoring:null,executionId:'child',require:n=>n==='./analysis-stop-control'?{withModelRequestsForbidden:fn=>{forbidden=true;try{return fn()}finally{forbidden=false}}}:{inspectUnissuedScoringPreRequestRecovery:l=>{assert(lock&&forbidden);return f.c.inspect(l)}},withVerifiedSource:fn=>{assert(lock);f.setActive({executionId:'child',executionDir:f.loaded.directory,paperId:PAPER_ID,sourceDetails:f.loaded.source.sourceDetails,readerPdfSourceHandle:{fixture:true}});try{return fn()}finally{f.setActive(null)}}};
 lock=true;
 if(late){assert.throws(()=>vm.runInNewContext(guard,c),/actual scoring request/);assert.equal(f.read(path.join(f.loaded.directory,'analysis.json')).value.readerRevisionProgress.attempts,1);return;}
 vm.runInNewContext(guard,c);
 const start=adapterSource.indexOf('let current = { ...loaded.analysis',guardEnd),end=adapterSource.indexOf('        try {',start);
 Object.assign(c,{path,failedStages:[],replaceJson:(file,value,expected)=>{assert(lock);assert.equal(f.read(file).sha256,expected);fs.writeFileSync(file,JSON.stringify(value),{mode:0o600})}});
 vm.runInNewContext(adapterSource.slice(start,end),c);
 const saved=f.read(path.join(f.loaded.directory,'analysis.json')).value;
 assert.equal(saved.readerRevisionProgress.attempts,2);assert.deepEqual(saved.readerRevisionProgress.failures,progress.failures);
 assert.equal(f.loaded.revision.maxAttempts,3);assert.equal(fs.readdirSync(f.usage).length,0);
});
for(const value of [{kind:'request',outcome:'blocked_before_transport',transportStarted:false},{kind:'disposition',paperId:null,runId:'child'},{stage:'unknown'},{kind:'alien'}])test('ambiguous or any scoring metadata never opens this gate '+JSON.stringify(value),t=>{const f=fixture(t);f.fee(value);assert.throws(()=>f.c.inspect(f.loaded));});
test('malformed actual usage JSON is not silently ignored',t=>{const f=fixture(t),file=f.fee({});fs.writeFileSync(file,'{',{mode:0o600});assert.throws(()=>f.c.inspect(f.loaded));});

test('a scoring record added during final canonical CAS recheck is not missed',t=>{const f=fixture(t),original=f.c.adapter;let reads=0;f.c.adapter=()=>({...original(),loadConferenceReaderRevisionIdentity:()=>{if(++reads===2)f.fee({kind:'request_started'});return structuredClone(f.canonical)}});assert.throws(()=>f.c.inspect(f.loaded),/actual scoring request/);});

for(const name of ['reader-revision.json','source.json','review-reader-seed.json'])test('actual fixed '+name+' drift is not hidden by a formerly issued cap',t=>{const f=fixture(t);fs.appendFileSync(path.join(f.loaded.directory,name),' ');assert.throws(()=>f.c.inspect(f.loaded),/original source\/revision\/seed/);});

for(const paperId of ['garbage','arxiv:2601.12345'])test('noncanonical scoring paper identity cannot be ignored as unrelated: '+paperId,t=>{const f=fixture(t);f.fee({paperId,kind:'request'});assert.throws(()=>f.c.inspect(f.loaded),/unknown time\/paper attribution/);});
test('a real canonical other-paper scoring event is not attributed to this child',t=>{const f=fixture(t);const paperId='conference:interspeech:2026:conference-paper-id:other_interspeech';assert.equal(normalizeUsagePaperId(paperId),paperId);f.fee({paperId});assert(f.c.inspect(f.loaded));});
test('36-character non-UUID JSON filename cannot hide a scoring record',t=>{const f=fixture(t);f.fee({paperId:'garbage'},'a'.repeat(36)+'.json');assert.throws(()=>f.c.inspect(f.loaded),/unknown record name/);});

test('jointly rewritten current/canonical run time and matching SHA cannot narrow original scoring usage interval',t=>{const f=fixture(t);const later={...f.loaded.run,createdAt:'2026-10-19T19:00:00.000Z'};const bytes=Buffer.from(JSON.stringify(later));fs.writeFileSync(path.join(f.loaded.directory,'run.json'),bytes,{mode:0o600});f.loaded.run=later;f.loaded.runFileSha256=sha(bytes);f.canonical.run=structuredClone(later);f.canonical.runFileSha256=sha(bytes);f.raw.run=structuredClone(later);f.raw.runFileSha256=sha(bytes);assert.throws(()=>f.c.inspect(f.loaded),/original prepared run\/time/);});

// Native birth/ctime cannot be backdated on a newly created fixture file. These
// explicit stat-only simulations model old Mac/Linux metadata; production
// reads native stats, and no simulated record is treated as a real fee.
function historicalTemporary(f,{event={},times={}}={}) {
 const file=path.join(f.usage,'.22222222-2222-4222-8222-222222222222.tmp');
 const value={version:'llm-usage-v1',eventId:'33333333-3333-4333-8333-333333333333',
   kind:'request',outcome:'completed',stage:'unknown',paperId:null,at:'2026-10-05T01:45:21.697Z',...event};
 fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
 const old=BigInt(Date.parse('2026-10-05T01:45:21.697Z'))*1000000n;
 const metadata={mtimeNs:old,ctimeNs:old,birthtimeNs:old,...times};
 const apply=stat=>{if(typeof stat.mtimeNs!=='bigint')return stat;return Object.assign(Object.create(stat),metadata);};
 f.c.fs={...fs,lstatSync:(name,options)=>{
   const stat=fs.lstatSync(name,options);return String(name).endsWith('.tmp')?apply(stat):stat;
 },fstatSync:(fd,options)=>apply(fs.fstatSync(fd,options))};
 return {file,value,metadata};
}
test('stable old terminal tmp is excluded with JSON-safe path/SHA/time/identity evidence; attempt unchanged',t=>{
 const f=fixture(t),h=historicalTemporary(f),before=fs.readFileSync(h.file),proof=f.c.inspect(f.loaded);
 const serialized=JSON.stringify(proof);assert.equal(typeof serialized,'string');
 assert.equal(proof.historicalTemporaryUsageRecords.length,1);
 const row=proof.historicalTemporaryUsageRecords[0];assert.equal(row.file,h.file);assert.equal(row.sha256,sha(before));
 assert.equal(row.eventAt,h.value.at);assert.equal(row.fileIdentity.birthtimeNs,h.metadata.birthtimeNs.toString());
 assert(Object.values(row.fileIdentity).every(value=>typeof value==='string'));
 assert.equal(f.loaded.analysis.readerRevisionProgress.attempts,1);assert.equal(proof.scoringRequestsObserved,0);
 assert.deepEqual(fs.readFileSync(h.file),before);
});
test('old completed disposition with unavailable historic paper identity remains original immutable history',t=>{
 const f=fixture(t);historicalTemporary(f,{event:{kind:'disposition',disposition:'accepted',outcome:undefined,outputTextSha256:'a'.repeat(64)}});
 assert.equal(f.c.inspect(f.loaded).historicalTemporaryUsageRecords[0].kind,'disposition');
});
for(const [name,options]of [
 ['event at trusted run boundary',{event:{at:'2026-10-19T11:39:04.499Z'}}],
 ['recent event despite old stats',{event:{at:'2026-10-19T20:00:00.000Z'}}],
 ['unknown event time',{event:{at:'unknown'}}],['missing event time',{event:{at:undefined}}],
 ['request still in flight',{event:{kind:'request_started'}}],['incomplete request',{event:{outcome:'incomplete'}}],
 ['unknown event contract',{event:{version:'unknown'}}],['unknown event id',{event:{eventId:'unknown'}}],
 ['incomplete disposition',{event:{kind:'disposition',disposition:'accepted',outputTextSha256:null}}],
 ['recent mtime',{times:{mtimeNs:BigInt(Date.parse('2026-10-19T12:00:00Z'))*1000000n}}],
 ['recent ctime despite old mtime',{times:{ctimeNs:BigInt(Date.parse('2026-10-19T12:00:00Z'))*1000000n}}],
 ['recent birth despite old mtime',{times:{birthtimeNs:BigInt(Date.parse('2026-10-19T12:00:00Z'))*1000000n}}],
 ['unknown Linux birth time',{times:{birthtimeNs:0n}}],['unsupported birth stat',{times:{birthtimeNs:undefined}}],
])test('historical tmp cannot hide '+name,t=>{const f=fixture(t);historicalTemporary(f,options);assert.throws(()=>f.c.inspect(f.loaded));});
test('native fresh temporary is blocked even with an old event timestamp',t=>{
 const f=fixture(t),file=path.join(f.usage,'.22222222-2222-4222-8222-222222222222.tmp');
 fs.writeFileSync(file,JSON.stringify({version:'llm-usage-v1',eventId:'33333333-3333-4333-8333-333333333333',kind:'request',outcome:'completed',at:'2026-10-05T01:45:21.697Z'}),{mode:0o600});
 assert.throws(()=>f.c.inspect(f.loaded),/recent or unknown-time/);
});
for(const kind of ['unknown-name','malformed','duplicate-key','symlink','hardlink','public-mode'])test('unsafe temporary '+kind+' blocks',t=>{
 const f=fixture(t),h=historicalTemporary(f);
 if(kind==='unknown-name')fs.renameSync(h.file,path.join(f.usage,'.not-uuid.tmp'));
 if(kind==='malformed')fs.writeFileSync(h.file,'{');
 if(kind==='duplicate-key')fs.writeFileSync(h.file,JSON.stringify(h.value).replace(/}$/,',"at":"2026-10-05T01:45:21.697Z"}'));
 if(kind==='symlink'){fs.renameSync(h.file,h.file+'.backup');fs.symlinkSync(h.file+'.backup',h.file);}
 if(kind==='hardlink')fs.linkSync(h.file,h.file+'.backup');
 if(kind==='public-mode')fs.chmodSync(h.file,0o644);
 assert.throws(()=>f.c.inspect(f.loaded));
});
for(const kind of ['added','removed','renamed','bytes-changed','identity-changed'])test('temporary '+kind+' at final canonical fence blocks',t=>{
 const f=fixture(t),h=historicalTemporary(f),original=f.c.adapter;let calls=0;
 f.c.adapter=()=>({...original(),loadConferenceReaderRevisionIdentity:()=>{
   if(++calls===2){
     if(kind==='added')fs.writeFileSync(path.join(f.usage,'.44444444-4444-4444-8444-444444444444.tmp'),JSON.stringify(h.value),{mode:0o600});
     if(kind==='removed')fs.unlinkSync(h.file);
     if(kind==='renamed')fs.renameSync(h.file,h.file+'.backup');
     if(kind==='bytes-changed')fs.writeFileSync(h.file,JSON.stringify({...h.value,extra:true}));
     if(kind==='identity-changed')h.metadata.ctimeNs+=1n;
   }return structuredClone(f.canonical);
 }});assert.throws(()=>f.c.inspect(f.loaded));
});
test('named file replacement after the opened FD read is not accepted as the same historical temp',t=>{
 const f=fixture(t),h=historicalTemporary(f),actual=f.c.fs.readFileSync;let swapped=false;
 f.c.fs.readFileSync=(file,...args)=>{const bytes=actual(file,...args);if(typeof file==='number'&&!swapped){swapped=true;
   fs.renameSync(h.file,h.file+'.backup');fs.writeFileSync(h.file,bytes,{mode:0o600});}return bytes;};
 assert.throws(()=>f.c.inspect(f.loaded),/changed while reading/);assert.equal(swapped,true);
});
test('last batch guard cannot hide a historical temporary mutation before proof return',t=>{
 const f=fixture(t),h=historicalTemporary(f);let guards=0;
 f.c.assertCurrentBatch=()=>{if(++guards===2)h.metadata.ctimeNs+=1n;};
 assert.throws(()=>f.c.inspect(f.loaded),/historical temporary changed/);
});
test('historical tmp allowance never permits a current scoring request',t=>{
 const f=fixture(t);historicalTemporary(f);f.fee({kind:'request'});assert.throws(()=>f.c.inspect(f.loaded),/actual scoring request/);
});
